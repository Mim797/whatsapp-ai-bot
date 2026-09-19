require('dotenv').config();
const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');

process.on('unhandledRejection', (r) => console.log('Handled rejection:', r));
process.on('uncaughtException', (e) => console.log('Handled exception:', e));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const knowledgeBase = fs.readFileSync('knowledge.txt', 'utf-8');

const SYSTEM_INSTRUCTION = `
You are an expert human sales representative for BHB STORE on WhatsApp.
Your goal is to guide customers naturally and close sales, strictly using the STORE INFORMATION and PRODUCTS below.

HUMAN CONVERSATION RULES:
1. ADDRESS ALL QUESTIONS: If the customer sends multiple questions or points, address all of them in a clear, single reply.
2. LONG MEMORY: Remember previous messages carefully. If customer asks "shhal hada?" or "what colors?", answer regarding the specific product you were just discussing.
3. NO REPEATED GREETINGS: Only greet the customer (e.g. "مرحبا بك في BHB STORE" or "وعليكم السلام") in your very first message. In follow-up messages, get straight to the point.
4. STRICT CATALOG: Use ONLY products and prices from the catalog below. Never guess or invent details.
5. LANGUAGE & TONE: Reply in the same language the customer uses (Algerian Darja, Arabic, French, English). Keep answers natural, friendly, and structured.

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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-accelerated-2d-canvas',
      '--js-flags=--max-old-space-size=256',
    ],
  },
});

let currentQrImage = null;
client.on('qr', async (qr) => { 
  console.log('⚡ New QR code ready!');
  currentQrImage = await QRCode.toDataURL(qr); 
});
client.on('authenticated', () => console.log('🔑 Authenticated!'));
client.on('ready', () => { 
  currentQrImage = null; 
  console.log('✅ BOT IS ONLINE!'); 
});

const userConversations = new Map();
const userBuffers = new Map();

function getCleanHistory(rawHistory) {
  const clean = [];
  for (const item of rawHistory) {
    if (clean.length > 0 && clean[clean.length - 1].role === item.role) {
      clean[clean.length - 1].parts[0].text += '\n' + item.parts[0].text;
    } else {
      clean.push({ role: item.role, parts: [{ text: item.parts[0].text }] });
    }
  }
  while (clean.length > 0 && clean[0].role === 'model') {
    clean.shift();
  }
  return clean;
}

// --- GEMINI 3 PRIORITY HIERARCHY ---
const PRIORITY_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',       // Older fallback
  'gemini-2.0-flash'        // Emergency fallback
];

async function askGemini(history) {
  const cleanHistory = getCleanHistory(history);

  for (const modelName of PRIORITY_MODELS) {
    try {
      console.log(`🤖 Trying ${modelName}...`);
      const res = await ai.models.generateContent({
        model: modelName,
        contents: cleanHistory,
        config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2, maxOutputTokens: 450 },
      });

      const text = res.text?.trim();
      if (text) {
        return text; // Success!
      }
    } catch (err) {
      console.log(`⚠️ ${modelName} busy/unavailable (${err.status || err.message}). Stepping down to next model...`);
      await sleep(500); // Quick half-second transition
    }
  }
  return null;
}

async function processCustomerBatch(sender, lastMsg) {
  const buffer = userBuffers.get(sender);
  if (!buffer || buffer.texts.length === 0) return;

  const combinedMessage = buffer.texts.join('\n');
  buffer.texts = [];

  console.log(`📦 Bundled message from [${sender}]:\n"${combinedMessage}"`);

  try {
    const chat = await lastMsg.getChat();
    await chat.sendStateTyping();
  } catch (e) {}

  if (!userConversations.has(sender)) userConversations.set(sender, []);
  const history = userConversations.get(sender);

  history.push({ role: 'user', parts: [{ text: combinedMessage }] });

  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }

  const reply = await askGemini(history);

  if (reply) {
    console.log(`📤 Replying to ${sender}: "${reply}"`);
    history.push({ role: 'model', parts: [{ text: reply }] });
    await client.sendMessage(sender, reply);
  }
}

client.on('message', async (msg) => {
  try {
    if (msg.isStatus || msg.from.includes('@g.us') || msg.broadcast) return;
    const sender = msg.from;
    const text = msg.body?.trim();
    if (!text) return;

    console.log(`📩 [${sender}]: "${text}"`);

    if (!userBuffers.has(sender)) {
      userBuffers.set(sender, { texts: [], timer: null });
    }

    const buffer = userBuffers.get(sender);
    buffer.texts.push(text);

    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    // Wait 3 seconds for customer to finish typing multiple messages
    buffer.timer = setTimeout(() => {
      processCustomerBatch(sender, msg);
    }, 3000);

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
