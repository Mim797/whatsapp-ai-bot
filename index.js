require('dotenv').config();
const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');

process.on('unhandledRejection', (r) => console.log('Handled:', r));
process.on('uncaughtException', (e) => console.log('Handled:', e));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const knowledgeBase = fs.readFileSync('knowledge.txt', 'utf-8');

const SYSTEM_INSTRUCTION = `
You are a human sales representative for BHB STORE on WhatsApp.
RULES:
1. LONG MEMORY: Remember previous messages. If customer asks "shhal hada?" or "how much?", answer about the product discussed.
2. NO REPEATED GREETINGS: Greet the customer ONLY in the first message.
3. STRICT CATALOG: Use ONLY products and prices from the catalog below. Never guess.
4. LANGUAGE: Match the customer's language (Algerian Darja, Arabic, French, English). Keep replies concise.

CATALOG:
${knowledgeBase}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({
  authStrategy: new LocalAuth(),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018944888-alpha.html',
  },
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

let currentQrImage = null;
client.on('qr', async (qr) => { currentQrImage = await QRCode.toDataURL(qr); });
client.on('authenticated', () => console.log('🔑 Authenticated!'));
client.on('ready', () => { currentQrImage = null; console.log('✅ BOT IS ONLINE!'); });

const userConversations = new Map();

async function askGemini(history) {
  let tries = 1;
  while (true) {
    try {
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: history,
        config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2, maxOutputTokens: 400 },
      });
      const text = res.text?.trim();
      if (text) return text;
    } catch (err) {
      console.log(`⚠️ Gemini busy (try ${tries}), retrying silently in 2s...`);
      await sleep(2000);
      tries++;
    }
  }
}

client.on('message', async (msg) => {
  try {
    if (msg.isStatus || msg.from.includes('@g.us') || msg.broadcast) return;
    const sender = msg.from;
    const text = msg.body?.trim();
    if (!text) return;

    console.log(`📩 [${sender}]: "${text}"`);
    try { const chat = await msg.getChat(); await chat.sendStateTyping(); } catch (e) {}
    await sleep(2000);

    if (!userConversations.has(sender)) userConversations.set(sender, []);
    const history = userConversations.get(sender);
    history.push({ role: 'user', parts: [{ text }] });

    if (history.length > 50) {
      history.splice(0, history.length - 50);
      if (history.length > 0 && history[0].role === 'model') history.shift();
    }

    const reply = await askGemini(history);
    console.log(`📤 Replying to ${sender}: "${reply}"`);
    history.push({ role: 'model', parts: [{ text: reply }] });
    await client.sendMessage(sender, reply);
  } catch (err) {
    console.error('Error:', err);
  }
});

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (currentQrImage) {
    res.end(`<div style="text-align:center;padding-top:40px;"><h2>Scan with WhatsApp</h2><img src="${currentQrImage}" style="width:280px;"/></div>`);
  } else {
    res.end('<h2 style="text-align:center;padding-top:40px;color:green;">✅ Bot is Online!</h2>');
  }
}).listen(process.env.PORT || 3000);

client.initialize();
