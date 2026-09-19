require('dotenv').config();
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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

// Prints the QR code into your Cloud Logs so you can scan it
client.on('qr', (qr) => {
  console.log('--- SCAN THIS QR CODE WITH WHATSAPP ---');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ BOT IS ONLINE AND CONNECTED TO WHATSAPP!');
});

const userConversations = new Map();

client.on('message', async (msg) => {
  if (msg.isStatus) return;

  const chat = await msg.getChat();
  if (chat.isGroup) return; // Ignore group chats

  const senderId = msg.from;
  const userText = msg.body?.trim();
  if (!userText) return;

  try {
    // 3 to 5 second human pause
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

// A tiny fake web server so Render knows the cloud app is alive
const http = require('http');
http.createServer((req, res) => res.end('Bot is running 24/7!')).listen(process.env.PORT || 3000);

client.initialize();
