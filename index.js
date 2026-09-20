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

// --- عقلية التاجر الذكي المحنك (Consultative Salesman) ---
const SYSTEM_INSTRUCTION = `
أنت تاجر وبائع بشري ذكي جداً ومحنك في متجر BHB STORE على الواتساب.
تتحدث بالدارجة الجزائرية الطبيعية 100%. أسلوبك مثل خيرة التجار في الجزائر: مهذب، لبق، وذكي.

قواعد التاجر الذكي (ممنوع خرقها):
1. ممنوع تفريغ الكتالوج دفعة واحدة: إذا قال الزبون "واش عندكم؟"، لا تعطيه قائمة الأسعار كاملة وجريدة طويلة. قل له باختصار شديد: (حنا نبيعو أكسسوارات إلكترونية ذكية أصلية كيما ليزيكوتور والساعات الذكية. واش راك تحوس بالتحديد خويا العزيز؟).
2. الردود قصيرة جداً (Bite-sized): ردودك يجب أن تكون سطرين أو ثلاثة فقط كأي إنسان يكتب بالهاتف. لا تكتب فقرات طويلة أبداً.
3. التدرج في البيع (خطوة بخطوة):
   - افهم حاجة الزبون أولاً.
   - اقترح منتجاً واحداً يناسب طلبه مع ميزة واحدة مهمة وسعره.
   - اختم كلامك دائماً بسؤال واحد بسيط يوجهه للشراء (مثلاً: واش رايك؟ تحب اللون الأسود ولا الأبيض؟).
4. الرد على قدر السؤال: إذا سألك على سعر حاجة، أعطه سعرها مباشرة بدون أن تفرض عليه باقي السلع، ثم اسأله إن كان يريد حجزها.
5. الالتزام الصارم بملف المتجر: كل الأسعار والمواصفات تكون 100% من الكتالوج أدناه. ممنوع الكذب أو اختراع قصص.
6. لا تكرر الترحيب: رحب في أول رسالة فقط.

--- كتالوج المتجر ---
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
      '--no-first-run',
      '--no-zygote',
      '--mute-audio',
      '--disable-accelerated-2d-canvas',
      '--js-flags=--max-old-space-size=200',
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
  console.log('✅ BOT IS ONLINE AND STABLE!'); 
});

// --- إدارة الذاكرة التلقائية لـ 50+ محادثة متزامنة (Auto RAM Cleanup) ---
// Structure: Map<senderId, { history: [], lastActive: timestamp }>
const activeChats = new Map();
const userBuffers = new Map();

// تنظيف الذاكرة تلقائياً كل 10 دقائق (حذف المحادثات القديمة التي مضى عليها أكثر من ساعتين لتوفير الرام)
setInterval(() => {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [sender, data] of activeChats.entries()) {
    if (now - data.lastActive > TWO_HOURS) {
      activeChats.delete(sender);
      console.log(`🧹 Cleared inactive chat from RAM: ${sender}`);
    }
  }
  // إذا زاد عدد المحادثات عن 100 في نفس الوقت، يتم حذف الأقدم فوراً
  if (activeChats.size > 100) {
    const oldestKey = activeChats.keys().next().value;
    activeChats.delete(oldestKey);
  }
}, 10 * 60 * 1000);

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
      const res = await ai.models.generateContent({
        model: modelName,
        contents: cleanHistory,
        config: { 
          systemInstruction: SYSTEM_INSTRUCTION, 
          temperature: 0.3, // توازن مثالي بين الذكاء البشري والالتزام بالكتالوج
          maxOutputTokens: 300 // ردود قصيرة وسريعة كأي إنسان عادي
        },
      });

      const text = res.text?.trim();
      if (text) return text;
    } catch (err) {
      console.log(`⚠️ ${modelName} busy. Switching to next...`);
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

  console.log(`📦 [${sender}]: "${combinedMessage}"`);

  try {
    const chat = await lastMsg.getChat();
    await chat.sendStateTyping();
  } catch (e) {}

  if (!activeChats.has(sender)) {
    activeChats.set(sender, { history: [], lastActive: Date.now() });
  }

  const userSession = activeChats.get(sender);
  userSession.lastActive = Date.now(); // تحديث توقيت التفاعل
  const history = userSession.history;

  history.push({ role: 'user', parts: [{ text: combinedMessage }] });

  // حفظ آخر 20 رسالة فقط لكل زبون لتبقى الرام خفيفة جداً
  if (history.length > 20) {
    history.splice(0, history.length - 20);
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

    // الانتظار 3 ثوانٍ قبل المعالجة
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
