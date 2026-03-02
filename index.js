const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// --- Google OAuth2 設定 ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const client = new line.Client(config);

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const userState = {};
const app = express();

// 設定靜態檔案路徑，讓 Vercel 可以讀取專案內的圖片
app.use(express.static('public'));

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  const userId = event.source.userId;

  // 1. 處理圖文選單按鈕 (Postback 類型)
  if (event.type === 'postback') {
    if (event.postback.data === 'action=verify') {
      return startVerificationFlow(userId, event.replyToken);
    }
  }

  // 2. 處理文字訊息 (包括圖文選單的「文字」按鈕)
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // --- 新增：點擊「優惠資訊」按鈕回傳圖片 ---
    if (text === '優惠資訊') {
      // 使用你在 Vercel 的正式網域
      const imageUrl = 'https://my-line-bot-chi.vercel.app/promo.jpg';
      return client.replyMessage(event.replyToken, {
        type: 'image',
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl
      });
    }

    // 會員驗證啟動關鍵字
    if (text === '驗證' || text === '認證') {
      return startVerificationFlow(userId, event.replyToken);
    }

    // 處理會員資料填寫流程
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

  // 3. 處理圖片上傳 (驗證截圖)
  if (event.type === 'message' && event.message.type === 'image') {
    const state = userState[userId];
    if (state?.step === 'ASK_IMAGE') {
      try {
        await client.replyMessage(event.replyToken, { type: 'text', text: '正在上傳截圖至雲端，請稍候...' });
        const imageStream = await client.getMessageContent(event.message.id);
        const driveLink = await uploadToDrive(imageStream, userId);
        await saveToSheets(userId, state.phone, state.lineId, driveLink);
        delete userState[userId];
        return client.pushMessage(userId, { type: 'text', text: '✅ 驗證成功！資料已提交審核。' });
      } catch (error) {
        console.error('❌ 處理失敗:', error);
        return client.pushMessage(userId, { type: 'text', text: '❌ 發生錯誤，請聯絡管理員檢查。' });
      }
    }
  }
}

// --- 輔助函數 ---
async function startVerificationFlow(userId, replyToken) {
  const isMember = await checkUserExists(userId);
  if (isMember) {
    return client.replyMessage(replyToken, { type: 'text', text: '您已是會員，無須重複驗證。' });
  }
  userState[userId] = { step: 'ASK_PHONE' };
  return client.replyMessage(replyToken, { type: 'text', text: '開始會員驗證，請輸入您的手機號碼：' });
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
  const fileMetadata = { name: `verify_${userId}_${Date.now()}.jpg`, parents: [folderId] };
  const media = { mimeType: 'image/jpeg', body: bufferStream };
  const file = await drive.files.create({ requestBody: fileMetadata, media: media, fields: 'id, webViewLink' });
  await drive.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  return file.data.webViewLink;
}

async function saveToSheets(userId, phone, lineId, imgUrl) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[userId, phone, lineId, imgUrl, '待審核']] },
  });
}

// Vercel 專用匯出
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = 3000;
    app.listen(PORT, () => console.log(`🚀 本機測試： http://localhost:${PORT}`));
}