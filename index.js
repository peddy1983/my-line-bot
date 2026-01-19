const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');
const stream = require('stream');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// --- 改用 OAuth2 驗證 (這是解決問題的關鍵) ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

// 使用 OAuth2 客戶端來建立服務
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const client = new line.Client(config);

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const userState = {};
const app = express();

// 健康檢查 (防止 Render 休眠用)
app.get('/ping', (req, res) => res.status(200).send('Bot is awake!'));

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message') return null;
  const userId = event.source.userId;

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    
    // 關鍵字觸發
    if (text === '驗證' || text === '認證') {
        const isMember = await checkUserExists(userId);
        if (isMember) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '您已是會員，無須重複驗證。' });
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

  // 圖片處理邏輯
  if (event.message.type === 'image') {
    const state = userState[userId];
    if (state?.step === 'ASK_IMAGE') {
      try {
        await client.pushMessage(userId, { type: 'text', text: '正在以上傳原圖至雲端(使用您的個人空間)，請稍候...' });
        
        // 1. 取得圖片內容流
        const imageStream = await client.getMessageContent(event.message.id);
        
        // 2. 上傳到 Drive (這次是使用你本人的身分，所以不會報錯)
        const driveLink = await uploadToDrive(imageStream, userId);
        
        // 3. 寫入試算表
        await saveToSheets(userId, state.phone, state.lineId, driveLink);
        
        delete userState[userId];
        return client.pushMessage(userId, { type: 'text', text: '✅ 驗證成功！圖片已成功上傳。' });
      } catch (error) {
        console.error('❌ 處理失敗:', error);
        return client.pushMessage(userId, { type: 'text', text: '❌ 發生錯誤，請聯絡管理員檢查 Log。' });
      }
    }
  }
}

async function checkUserExists(userId) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:A' });
    return res.data.values ? res.data.values.flat().includes(userId) : false;
  } catch (e) { return false; }
}

async function uploadToDrive(contentStream, userId) {
  const bufferStream = new stream.PassThrough();
  contentStream.pipe(bufferStream);

  const fileMetadata = {
    name: `verify_${userId}_${Date.now()}.jpg`,
    parents: [folderId], // 上傳到你指定的資料夾
  };
  
  const media = {
    mimeType: 'image/jpeg',
    body: bufferStream,
  };

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink',
  });

  // 開放權限讓連結在試算表中可被點擊 (設為公開讀取)
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
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