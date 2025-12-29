const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');
const stream = require('stream');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
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
    if (text === '驗證') {
      const isMember = await checkUserExists(userId);
      if (isMember) return client.replyMessage(event.replyToken, { type: 'text', text: '您已是會員，若要修改請洽客服。' });
      userState[userId] = { step: 'ASK_PHONE' };
      return client.replyMessage(event.replyToken, { type: 'text', text: '開始會員驗證，請輸入您的手機號碼：' });
    }
    const state = userState[userId];
    if (state?.step === 'ASK_PHONE') {
      state.phone = text; state.step = 'ASK_LINE_ID';
      return client.replyMessage(event.replyToken, { type: 'text', text: '收到！接著請輸入您的 LINE ID：' });
    }
    if (state?.step === 'ASK_LINE_ID') {
      state.lineId = text; state.step = 'ASK_IMAGE';
      return client.replyMessage(event.replyToken, { type: 'text', text: '最後一步，請上傳您的個人檔案截圖：' });
    }
  }

  if (event.message.type === 'image') {
    const state = userState[userId];
    if (state?.step === 'ASK_IMAGE') {
      try {
        await client.pushMessage(userId, { type: 'text', text: '正在處理圖片，請稍候...' });
        const imageStream = await client.getMessageContent(event.message.id);
        const driveLink = await uploadToDrive(imageStream, userId);
        await saveToSheets(userId, state.phone, state.lineId, driveLink);
        delete userState[userId];
        return client.pushMessage(userId, { type: 'text', text: '✅ 驗證成功！資料已同步至系統。' });
      } catch (error) {
        console.error('Final Error:', error.message);
        return client.pushMessage(userId, { type: 'text', text: '❌ 圖片上傳失敗。原因：' + error.message });
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
  const fileMetadata = { name: `verify_${userId}_${Date.now()}.jpg`, parents: [folderId] };
  const media = { mimeType: 'image/jpeg', body: bufferStream };
  
  // 核心修復：強制啟用 supportsAllDrives 並使用正確的 metadata 指向
  const file = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bot is running on port ${PORT}`));
