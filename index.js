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

// --- تعليمات البائع الجزائري المحترف ---
const SYSTEM_INSTRUCTION = `
أنت بائع بشري محترف في متجر BHB STORE على الواتساب.
تتحدث بالدارجة الجزائرية فقط (أسلوب محترم، لبق، وطبيعي 100% مثلما يتحدث الباعة في الجزائر).

قواعد أساسية لضمان ردود بشرية كاملة:
1. الالتزام بملف المتجر: اعتمد 100% على السلع والأسعار والعروض المكتوبة في "معلومات المتجر والمنتجات" أدناه. إذا سأل الزبون على سلعة غير موجودة في هذا الملف، قل له باحترام أنها غير متوفرة حالياً.
2. جمل كاملة ومنتهية دائماً: ممنوع تماماً أن تتوقف في نصف الكلمة أو نصف الجملة. أكمل رسالتك دائماً حتى آخر نقطة.
3. دارجة جزائرية فقط: ممنوع منعاً باتاً كتابة أي جملة بالإنجليزية، وممنوع إخراج نصوص برمجية أو رموز غريبة مثل (** أو ### أو ):**).
4. أسلوب الواتساب: نسق إجابتك بأسطر قصيرة ونقاط واضحة ومقروءة على شاشة الهاتف.
5. لا تكرر الترحيب: رحب بالزبون في أول رسالة فقط. في باقي الرسائل، أجب عن سؤاله مباشرة دون إعادة الترحيب من البداية.

--- معلومات المتجر والمنتجات ---
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

const PRIORITY_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];

async function askGemini(history) {
  const cleanHistory = getCleanHistory(history);

  for (const modelName of PRIORITY_MODELS) {
    try {
      console.log(`🤖 Trying ${modelName}...`);
      const res = await ai.models.generateContent({
        model: modelName,
        contents: cleanHistory,
        config: { 
          systemInstruction: SYSTEM_INSTRUCTION, 
          temperature: 0.2,
          maxOutputTokens: 2000 // مساحة كافية جداً لإنهاء كل جملة بدون انقطاع
        },
      });

      const text = res.text?.trim();
      if (text) {
        return text;
      }
    } catch (err) {
      console.log(`⚠️ ${modelName} unavailable (${err.status || err.message}). Switching...`);
      await sleep(500);
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

    // انتظر 3 ثوانٍ ليفرغ الزبون من كتابة رسائله المتتالية
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
