const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');
const stream = require('stream');

// 1. 設定與環境變數檢查
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 解析 Google 憑證
let credentials;
try {
  credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('❌ 錯誤：GOOGLE_SERVICE_ACCOUNT_JSON 解析失敗');
}

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
);

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });
const client = new line.Client(config);

const userState = {};
const app = express();

// 健康檢查節點 (用於 Cron-job 防止休眠)
app.get('/ping', (req, res) => {
  res.status(200).send('Bot is awake!');
});

// 2. Webhook 路由
app.use('/webhook', (req, res, next) => {
  console.log('--- [收到 Webhook 請求] ---');
  next();
});

app.post('/webhook', line.middleware(config), (req, res) => {
  console.log('✅ 簽章驗證通過，處理事件個數:', req.body.events.length);
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('❌ Webhook 內部處理錯誤:', err);
      res.status(500).end();
    });
});

// 3. 事件處理邏輯
async function handleEvent(event) {
  if (event.type !== 'message') return null;
  const userId = event.source.userId;

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log(`[${userId}] 傳送文字: ${text}`);

    // 支援「驗證」與「認證」兩種關鍵字
    if (text === '驗證' || text === '認證') {
      const isMember = await checkUserExists(userId);
      if (isMember) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '您已是會員，若要修改請洽客服。' });
      }
      userState[userId] = { step: 'ASK_PHONE' };
      return client.replyMessage(event.replyToken, { type: 'text', text: '開始會員驗證，請輸入您的手機號碼：' });
    }

    const state = userState[userId];
    if (state?.step === 'ASK_PHONE') {
      state.phone = text;
      state.step = 'ASK_LINE_ID';
      return client.replyMessage(event.replyToken, { type: 'text', text: '收到！接著請輸入您的 LINE ID：' });
    }

    if (state?.step === 'ASK_LINE_ID') {
      state.lineId = text;
      state.step = 'ASK_IMAGE';
      return client.replyMessage(event.replyToken, { type: 'text', text: '最後一步，請上傳您的個人檔案截圖：' });
    }
  }

  if (event.message.type === 'image') {
    console.log(`[${userId}] 傳送了圖片`);
    const state = userState[userId];
    if (state?.step === 'ASK_IMAGE') {
      try {
        await client.pushMessage(userId, { type: 'text', text: '正在處理圖片並上傳雲端，請稍候...' });
        
        const imageStream = await client.getMessageContent(event.message.id);
        const driveLink = await uploadToDrive(imageStream, userId);
        
        await saveToSheets(userId, state.phone, state.lineId, driveLink);
        
        delete userState[userId];
        return client.pushMessage(userId, { type: 'text', text: '✅ 驗證成功！資料已寫入系統，請等待管理員審核。' });
      } catch (error) {
        console.error('❌ 圖片處理或上傳失敗:', error);
        // 如果錯誤訊息包含 quota，給予更具體的提示
        const errorMsg = error.message?.includes('quota') ? '（儲存空間配額錯誤）' : '';
        return client.pushMessage(userId, { type: 'text', text: `❌ 發生錯誤${errorMsg}，請聯絡管理員。` });
      }
    }
  }
}

// 4. 輔助功能
async function checkUserExists(userId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A:A',
    });
    return res.data.values ? res.data.values.flat().includes(userId) : false;
  } catch (e) { return false; }
}

async function uploadToDrive(contentStream, userId) {
  const bufferStream = new stream.PassThrough();
  contentStream.pipe(bufferStream);

  const fileMetadata = {
    name: `verify_${userId}_${Date.now()}.jpg`,
    parents: [folderId],
  };

  const media = {
    mimeType: 'image/jpeg',
    body: bufferStream,
  };

  // 修正：增加 supportsAllDrives 以解決 Service Account 空間限制問題
  const file = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink',
    supportsAllDrives: true, 
  });

  // 設定檔案為公開可見，以便在試算表中點擊查看
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });

  return file.data.webViewLink;
}

async function saveToSheets(userId, phone, lineId, imgUrl) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[userId, phone, lineId, imgUrl, '待審核']],
    },
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bot running on ${PORT}`));