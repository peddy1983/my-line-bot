const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');

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

const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });
const client = new line.Client(config);

const userState = {};
const app = express();

// 健康檢查節點
app.get('/ping', (req, res) => {
  res.status(200).send('Bot is awake!');
});

// 2. Webhook 路由
app.use('/webhook', (req, res, next) => {
  console.log('--- [收到 Webhook 請求] ---');
  next();
});

app.post('/webhook', line.middleware(config), (req, res) => {
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
    console.log(`[${userId}] 處理圖片轉 Base64...`);
    const state = userState[userId];
    if (state?.step === 'ASK_IMAGE') {
      try {
        await client.pushMessage(userId, { type: 'text', text: '正在處理資料並寫入試算表，請稍候...' });
        
        // 獲取圖片內容並轉為 Base64
        const imageStream = await client.getMessageContent(event.message.id);
        const base64Data = await streamToBase64(imageStream);
        
        // 方案三：直接存入試算表（在 E 欄存入資料，F 欄備註狀態）
        await saveToSheets(userId, state.phone, state.lineId, base64Data);
        
        console.log(`[${userId}] 資料寫入成功 (Base64 長度: ${base64Data.length})`);
        
        delete userState[userId];
        return client.pushMessage(userId, { type: 'text', text: '✅ 驗證成功！資料已寫入系統，請等待管理員審核。' });
      } catch (error) {
        console.error('❌ 處理失敗:', error);
        return client.pushMessage(userId, { type: 'text', text: '❌ 寫入資料時發生錯誤，請聯絡管理員。' });
      }
    }
  }
}

// 4. 輔助功能
async function checkUserExists(userId) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:A' });
    return res.data.values ? res.data.values.flat().includes(userId) : false;
  } catch (e) { return false; }
}

// 圖片流轉 Base64 函數
function streamToBase64(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(`data:image/jpeg;base64,${buffer.toString('base64')}`);
    });
    stream.on('error', reject);
  });
}

async function saveToSheets(userId, phone, lineId, imgBase64) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      // 依序寫入：UserID, 手機, LINE ID, 圖片編碼(這會很長), 待審核
      values: [[userId, phone, lineId, imgBase64, '待審核']],
    },
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bot running on ${PORT} (Base64 Mode)`));