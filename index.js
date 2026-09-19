require('dotenv').config();
const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const knowledgeBase = fs.readFileSync('knowledge.txt', 'utf-8');

const SYSTEM_INSTRUCTION = `
You are a sales assistant on WhatsApp.
Answer customer questions STRICTLY using the STORE INFORMATION and PRODUCTS below.

STRICT RULES:
1. ONLY use details from the KNOWLEDGE BASE.
2. If the answer is not in the knowledge base, say: "I'm sorry, I don't have information on that. A team member will assist you shortly."
3. DO NOT invent prices or details.
4. Keep answers short and WhatsApp-friendly.
5. Always reply in the same language the customer uses.

--- KNOWLEDGE BASE ---
${knowledgeBase}
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

let currentQrImage = null;

// Convert QR code to an image URL
client.on('qr', async (qr) => {
  console.log('New QR code received, converting to image...');
  currentQrImage = await QRCode.toDataURL(qr);
});

client.on('ready', () => {
  currentQrImage = null;
  console.log('✅ BOT IS ONLINE AND CONNECTED TO WHATSAPP!');
});

const userConversations = new Map();

client.on('message', async (msg) => {
  if (msg.isStatus) return;

  const chat = await msg.getChat();
  if (chat.isGroup) return;

  const senderId = msg.from;
  const userText = msg.body?.trim();
  if (!userText) return;

  try {
    await sleep(Math.floor(Math.random() * 2000) + 3000);
    await chat.sendStateTyping();

    if (!userConversations.has(senderId)) {
      userConversations.set(senderId, []);
    }

    const history = userConversations.get(senderId);
    history.push({ role: 'user', parts: [{ text: userText }] });

    if (history.length > 6) {
      history.splice(0, history.length - 6);
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
        maxOutputTokens: 300,
      },
    });

    const botReply = response.text?.trim();
    if (botReply) {
      history.push({ role: 'model', parts: [{ text: botReply }] });
      await msg.reply(botReply);
    }
  } catch (err) {
    console.error('Error handling message:', err);
  }
});

// A website that shows the clean QR code image in your browser
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (currentQrImage) {
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="refresh" content="20">
          <title>Scan WhatsApp QR</title>
        </head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;background-color:#f0f2f5;">
          <div style="background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);text-align:center;">
            <h2 style="color:#128c7e;margin-top:0;">Scan With WhatsApp</h2>
            <p style="color:#555;">Settings &gt; Linked Devices &gt; Link a Device</p>
            <img src="${currentQrImage}" style="width:280px;height:280px;display:block;margin:15px auto;" alt="QR Code" />
            <small style="color:#888;">This page auto-refreshes every 20 seconds for new codes.</small>
          </div>
        </body>
      </html>
    `);
  } else {
    res.end(`
      <!DOCTYPE html>
      <html>
        <body style="display:flex;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;background-color:#f0f2f5;">
          <div style="background:white;padding:30px;border-radius:12px;text-align:center;">
            <h2 style="color:#25d366;">✅ Bot is Online and Connected!</h2>
            <p>Your WhatsApp is linked and running.</p>
          </div>
        </body>
      </html>
    `);
  }
}).listen(process.env.PORT || 3000);

client.initialize();
