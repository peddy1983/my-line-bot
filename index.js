const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');
const stream = require('stream');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 讀取 OAuth 環境變數
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

// 設定 OAuth2 驗證 (這是關鍵！代表您本人)
const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  "https://developers.google.com/oauthplayground"
);
oauth2Client.setCredentials({ refresh_token: refreshToken });

// 使用 OAuth2 Client 初始化 Drive 和 Sheets
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

const client = new line.Client(config);
const userState = {};
const app = express();

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

  // 1. 文字訊息處理
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    if (text === '驗證') {
      const isMember = await checkUserExists(userId);
      if (isMember) return client.replyMessage(event.replyToken, { type: 'text', text: '您已是會員。' });
      userState[userId] = { step: 'ASK_PHONE' };
      return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入手機號碼：' });
    }

    const state = userState[userId];
    if (state?.step === 'ASK_PHONE') {
      state.phone = text; state.step = 'ASK_LINE_ID';
      return client.replyMessage(event.replyToken, { type: 'text', text: '接著請輸入 LINE ID：' });
    }
    if (state?.step === 'ASK_LINE_ID') {
      state.lineId = text; state.step = 'ASK_IMAGE';
      return client.replyMessage(event.replyToken, { type: 'text', text: '最後請上傳截圖：' });
    }
  }

  // 2. 圖片處理 (上傳至 Google Drive)
  if (event.message.type === 'image') {
    const state = userState[userId];
    if (state?.step === 'ASK_IMAGE') {
      try {
        await client.pushMessage(userId, { type: 'text', text: '正在上傳至 Google Drive (使用 OAuth)...' });
        
        const imageStream = await client.getMessageContent(event.message.id);
        const driveLink = await uploadToDrive(imageStream, userId);
        
        await saveToSheets(userId, state.phone, state.lineId, driveLink);
        
        delete userState[userId];
        return client.pushMessage(userId, { type: 'text', text: '✅ 驗證成功！圖片已存入您的個人雲端硬碟。' });
      } catch (error) {
        console.error('OAuth Drive Error:', error);
        return client.pushMessage(userId, { type: 'text', text: '❌ 上傳失敗：' + (error.message || JSON.stringify(error)) });
      }
    }
  }
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

  // 因為是 OAuth (您本人)，直接上傳即可，不需要 supportsAllDrives
  const file = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink',
  });

  // 設定權限公開 (讓 Sheet 能連結)
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
    requestBody: { values: [[userId, phone, lineId, imgUrl, '待審核']] },
  });
}

async function checkUserExists(userId) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:A' });
    return res.data.values ? res.data.values.flat().includes(userId) : false;
  } catch (e) { return false; }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bot running on ${PORT}`));
