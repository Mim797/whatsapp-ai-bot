require('dotenv').config();
const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');

// --- PREVENT ANY UNEXPECTED CRASHES ---
process.on('unhandledRejection', (reason) => console.log('Handled rejection:', reason));
process.on('uncaughtException', (err) => console.log('Handled exception:', err));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const knowledgeBase = fs.readFileSync('knowledge.txt', 'utf-8');

// --- HUMAN SALES AGENT INSTRUCTIONS ---
const SYSTEM_INSTRUCTION = `
You are a human sales representative for BHB STORE on WhatsApp.
Your goal is to guide customers naturally and help them place orders, strictly using the STORE INFORMATION and PRODUCTS below.

CRITICAL RULES:
1. DEEP CONTEXT & MEMORY: Remember previous messages carefully. If the customer asks "how much is it?", "shhal hada?", "what colors?", answer about the specific product you were just talking about.
2. NO REPETITIVE GREETINGS: Only greet the customer (e.g. "مرحبا بك في BHB STORE" or "وعليكم السلام") in your very first message. Never repeat greetings in follow-up messages.
3. STRICT CATALOG: ONLY mention products, prices, and options present in the KNOWLEDGE BASE. If something is not listed, say it is currently out of stock or unavailable. Never guess.
4. HUMAN TONE: Sound like a polite, professional human shop assistant on WhatsApp (using Algerian Darija, Arabic, French, or English depending on what the customer uses). Keep messages clean and concise.

--- KNOWLEDGE BASE ---
${knowledgeBase}
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
});

let currentQrImage = null;

client.on('qr', async (qr) => {
  currentQrImage = await QRCode.toDataURL(qr);
});

client.on('authenticated', () => console.log('🔑 Authentication successful!'));
client.on('ready', () => {
  currentQrImage = null;
  console.log('✅ BOT IS ONLINE AND CONNECTED TO WHATSAPP!');
});

// Conversation memory: Map<senderId, Array>
const userConversations = new Map();

// --- ENDLESS RETRY ENGINE (Silently retries until Google answers) ---
async function generateAnswerWithRetry(history) {
  let attempt = 1;

  while (true) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: history,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.2,
          maxOutputTokens: 400,
        },
      });

      const replyText = response.text?.trim();
      if (replyText) {
        return replyText;
      }
    } catch (err) {
      console.log(`⚠️ Google API busy (attempt ${attempt}). Retrying silently in 2 seconds...`);
      await sleep(2000);
      attempt++;
    }
  }
}

// --- MESSAGE LISTENER ---
client.on('message', async (msg) => {
  try {
    if (msg.isStatus || msg.from.includes('@g.us') || msg.broadcast) return;

    const senderId = msg.from;
    const userText = msg.body?.trim();
    if (!userText) return;

    console.log(`📩 [${senderId}]: "${userText}"`);

    try {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
    } catch (e) {}

    await sleep(2000);

    if (!userConversations.has(senderId)
