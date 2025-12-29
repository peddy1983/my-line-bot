const line = require('@line/bot-sdk');
const express = require('express');
const { google } = require('googleapis');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
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

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 觸發驗證流程
  if (text === '驗證') {
    const isMember = await checkUserExists(userId);
    if (isMember) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '您已是會員，若要修改請洽客服。' });
    }
    userState[userId] = { step: 'ASK_PHONE' };
    return client.replyMessage(event.replyToken, { type: 'text', text: '開始會員驗證，請輸入您的手機號碼：' });
  }

  const state = userState[userId];
  if (!state) return null;

  // 步驟 1: 儲存手機號碼
  if (state.step === 'ASK_PHONE') {
    state.phone = text;
    state.step = 'ASK_LINE_ID';
    return client.replyMessage(event.replyToken, { type: 'text', text: '收到！接著請輸入您的 LINE ID：' });
  }

  // 步驟 2: 儲存 LINE ID 並寫入試算表
  if (state.step === 'ASK_LINE_ID') {
    state.lineId = text;
    try {
      await saveToSheets(userId, state.phone, state.lineId);
      delete userState[userId]; // 清除狀態
      return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 驗證成功！資料已同步至試算表。' });
    } catch (error) {
      console.error('Sheets Error:', error.message);
      return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 寫入失敗，請確認試算表共用設定。' });
    }
  }
}

async function checkUserExists(userId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A:A',
    });
    return res.data.values ? res.data.values.flat().includes(userId) : false;
  } catch (e) { return false; }
}

async function saveToSheets(userId, phone, lineId) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1!A:C',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[userId, phone, lineId]],
    },
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bot is running on port ${PORT}`));
