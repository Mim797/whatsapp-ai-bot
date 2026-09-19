require('dotenv').config();
const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');

// --- PREVENT ANY UNEXPECTED CRASHES ---
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

let currentQrImage = null;
client.on('qr', async (qr) => { currentQrImage = await QRCode.toDataURL(qr); });
client.on('authenticated', () => console.log('🔑 Authenticated!'));
client.on('ready', () => { currentQrImage = null; console.log('✅ BOT IS ONLINE!'); });

// In-memory chat storage
const userConversations = new Map();

// Message buffers for handling rapid-fire messages: Map<senderId, { texts: [], timer: Timeout }>
const userBuffers = new Map();

// --- CLEAN HISTORY HELPER ---
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

// --- SILENT RETRY ENGINE ---
async function askGemini(history) {
  const cleanHistory = getCleanHistory(history);

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: cleanHistory,
        config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2, maxOutputTokens: 450 },
      });
      const text = res.text?.trim();
      if (text) return text;
    } catch (err) {
      console.log(`⚠️ Gemini busy (attempt ${attempt}/4). Retrying silently...`);
      await sleep(2000);
    }
  }
  return null;
}

// --- PROCESS BUNDLED MESSAGES (Called after customer finishes typing) ---
async function processCustomerBatch(sender, lastMsg) {
  const buffer = userBuffers.get(sender);
  if (!buffer || buffer.texts.length === 0) return;

  // Combine all separate messages into one clean text
  const combinedMessage = buffer.texts.join('\n');
  buffer.texts = []; // Clear buffer

  console.log(`📦 Bundled message from [${sender}]:\n"${combinedMessage}"`);

  try {
    const chat = await lastMsg.getChat();
    await chat.sendStateTyping();
  } catch (e) {}

  if (!userConversations.has(sender)) userConversations.set(sender, []);
  const history = userConversations.get(sender);

  // Add the combined user input
  history.push({ role: 'user', parts: [{ text: combinedMessage }] });

  // Keep last 50 messages of conversation
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

// --- MESSAGE LISTENER ---
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

    // Reset the 3.5-second timer on every incoming message
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    // Wait 3.5 seconds for the customer to stop sending messages
    buffer.timer = setTimeout(() => {
      processCustomerBatch(sender, msg);
    }, 3500);

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
