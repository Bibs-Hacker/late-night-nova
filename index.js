import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import PDFDocument from 'pdfkit';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { writeFile, readFile, mkdir, rm, readdir, access } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OWNER_NUMBER = '254753714625';
const BOT_NAME = 'Nancy Nova AI';
const OWNER_NAME = 'Dev Brian ✨';
const TEAM_NAME = 'Team NASA';
const OWNER_BIO = 'Founder and Developer of Nancy Nova AI 💎 | Team NASA 🌟';
const WEBSITE_URL = 'dev-brian-wrld.vercel.app';
const TEAM_MEMBERS = ['Dev Brian ✨', 'Dev Nancy 💎'];
const BOT_VERSION = '3.0.0';
const FOOTER_TEXT = `${TEAM_NAME} • v${BOT_VERSION} • 🌐 ${WEBSITE_URL}`;
const PROFILE_IMAGE_URL = 'https://files.catbox.moe/3g176r.jpeg';

// ── Bot profile song ──
// Played alongside the identity commands (!menu, !about, !ping, !team, !credits,
// !status) so the bot introduces itself the same way every time. The file is
// downloaded once, cached on disk, and reused; a failed download never blocks
// the command itself.
const BOT_PROFILE_SONG_URL = process.env.BOT_PROFILE_SONG_URL || 'https://files.catbox.moe/w2lqkq.mp3';
const BOT_PROFILE_SONG_TITLE = process.env.BOT_PROFILE_SONG_TITLE || 'Loreen - Tattoo';
const BOT_PROFILE_SONG_ENABLED = String(process.env.BOT_PROFILE_SONG || 'on').toLowerCase() !== 'off';
let profileSongCache = null;

async function getProfileSong() {
  if (profileSongCache && profileSongCache.buffer?.length) return profileSongCache.buffer;
  const cacheFile = path.join(TEMP_DIR, 'nancy-profile-song.mp3');
  try {
    const existing = await readFile(cacheFile);
    if (existing?.length > 50000) { profileSongCache = { buffer: existing }; return existing; }
  } catch {}
  const response = await fetch(BOT_PROFILE_SONG_URL, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`song download failed (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 50000) throw new Error('song file looks incomplete');
  try { await mkdir(TEMP_DIR, { recursive: true }); await writeFile(cacheFile, buffer); } catch {}
  profileSongCache = { buffer };
  return buffer;
}

async function sendProfileSong(sock, jid, quoted = null) {
  if (!BOT_PROFILE_SONG_ENABLED) return false;
  try {
    const audio = await getProfileSong();
    const payload = { audio, mimetype: 'audio/mpeg', ptt: false, fileName: `${BOT_PROFILE_SONG_TITLE}.mp3` };
    try { await sock.sendMessage(jid, payload, quoted ? { quoted } : undefined); }
    catch { await sock.sendMessage(jid, payload); }
    return true;
  } catch (error) {
    console.warn('[ProfileSong] unavailable:', error.message);
    return false;
  }
}


// ONE shared welcome / goodbye message used across EVERY group by default.
// Admins can still override per-group with `!welcome text ...` / `!goodbye text ...`,
// but unless they do, all groups show exactly this same styled message.
const DEFAULT_WELCOME = '╭━━━〔 🌟 WELCOME TO THE FAMILY 🌟 〕━━━╮\nHey @user! 👋💖\nA big warm welcome to @group! 🫂✨\nWe are soooo happy to have you here. Make yourself comfy, say hi to everyone, respect the group rules and enjoy your stay! 💫💎\n📌 Type !rules to read the group rules.\n💎 Powered by Nancy Nova AI 🌟 | Team NASA ✨\n💌 You are member #@number. Let us make lovely memories together! 👑\n╰━━━ ⋆｡°✩°｡⋆ ━━━╯';
const DEFAULT_GOODBYE = '╭━━━〔 💎 UNTIL WE MEET AGAIN 💎 〕━━━╮\nGoodbye @user! 👋🥹\nThank you for being part of @group.\n Wherever life takes you, keep smiling, growing and shining. 🌟\nYou will always be welcome back. Take care of yourself until we meet again! 💖🫂\n💎 Nancy Nova AI 🌟 | Team NASA ✨\n╰━━━ ⋆｡°✩°｡⋆ ━━━╯';

// Load .env automatically so `node index.js` works without requiring dotenv or
// a special Node startup flag. Existing Windows environment variables win.
function loadDotEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!existsSync(envPath)) return;
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    console.warn('Could not load .env:', error.message);
  }
}
loadDotEnv();

// Model IDs that providers have already shut down (they now return 404/400).
// If one of these is still sitting in .env, we quietly swap it for a live default
// instead of failing, so the bot never dies just because a provider retired a model.
const RETIRED_MODEL_IDS = [
  'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama3-70b-8192', 'llama3-8b-8192',
  'gemma2-9b-it', 'qwen/qwen3-32b', 'qwen/qwen3.6-27b', 'mistral-saba-24b',
  'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct',
  'deepseek-r1-distill-llama-70b', 'groq/compound', 'groq/compound-mini',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash',
  'meta-llama/llama-3.3-70b-instruct:free', 'meta-llama/llama-3.1-8b-instruct:free',
  'deepseek/deepseek-r1:free', 'deepseek/deepseek-chat:free', 'google/gemma-2-9b-it:free',
  'microsoft/phi-3-mini-128k-instruct:free', 'qwen/qwen-2.5-72b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free', 'google/gemini-2.0-flash-exp:free'
];
function resolveModelId(provider, configuredModel) {
  const current = String(configuredModel || '').trim();
  if (current && !RETIRED_MODEL_IDS.includes(current.toLowerCase())) return current;
  return provider?.fallbackModel || current;
}

// ── Multi-provider AI keys (GroqCloud, Google Gemini, OpenRouter) ───────────
const trimEnv = (value) => String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
const GROQ_API_KEY = trimEnv(process.env.GROQ_API_KEY);
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_OPENROUTER_MODEL = 'inclusionai/ling-3.2-flash:free';
const GROQ_MODEL = trimEnv(process.env.GROQ_MODEL) || DEFAULT_GROQ_MODEL;
const GROQ_BASE_URL = (trimEnv(process.env.GROQ_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const GEMINI_API_KEY = trimEnv(process.env.GEMINI_API_KEY) || trimEnv(process.env.GOOGLE_GEMINI_API_KEY);
const GEMINI_MODEL = trimEnv(process.env.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
const GEMINI_BASE_URL = (trimEnv(process.env.GEMINI_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const OPENROUTER_API_KEY = trimEnv(process.env.OPENROUTER_API_KEY);
const OPENROUTER_MODEL = trimEnv(process.env.OPENROUTER_MODEL) || DEFAULT_OPENROUTER_MODEL;
const OPENROUTER_BASE_URL = (trimEnv(process.env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const OPENROUTER_SITE_URL = trimEnv(process.env.OPENROUTER_SITE_URL) || 'https://nancy-nova-ai.local';
const AI_PROVIDER_TIMEOUT_MS = Math.max(8000, Math.min(120000, Number.parseInt(process.env.AI_PROVIDER_TIMEOUT_MS || '60000', 10) || 60000));
const AI_CONTEXT_TURNS = Math.max(0, Math.min(20, Number.parseInt(process.env.AI_CONTEXT_TURNS || '6', 10) || 6));
const AI_CONTEXT_TTL_MS = Math.max(60000, Number.parseInt(process.env.AI_CONTEXT_TTL_MS || String(30 * 60 * 1000), 10) || 30 * 60 * 1000);
const AI_DEFAULT_PROVIDER = (trimEnv(process.env.AI_DEFAULT_PROVIDER) || 'groq').toLowerCase();
const AI_MAX_HISTORY_CHARS = 12000;
// PhotoLab is free-first and keyless. Paid image fallback was part of the removed
// OpenAI dependency, so this flag is kept only for .env backward compatibility.
const PHOTO_LAB_PAID_FALLBACK = false;
const PHOTO_LAB_IMAGE_COUNT = Math.max(1, Math.min(2, Number.parseInt(process.env.PHOTO_LAB_IMAGE_COUNT || '2', 10) || 2));
const PHOTO_LAB_COOLDOWN_MS = Math.max(5000, Math.min(60000, Number.parseInt(process.env.PHOTO_LAB_COOLDOWN_MS || '12000', 10) || 12000));
console.log(`[AI] GroqCloud: ${GROQ_API_KEY ? 'LOADED (' + GROQ_MODEL + ')' : 'MISSING'} | Gemini: ${GEMINI_API_KEY ? 'LOADED (' + GEMINI_MODEL + ')' : 'MISSING'} | OpenRouter: ${OPENROUTER_API_KEY ? 'LOADED (' + OPENROUTER_MODEL + ')' : 'MISSING'}`);
// Warn early when a model that has since been retired is still in .env.
[['GROQ_MODEL', GROQ_MODEL, DEFAULT_GROQ_MODEL], ['GEMINI_MODEL', GEMINI_MODEL, DEFAULT_GEMINI_MODEL], ['OPENROUTER_MODEL', OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL]]
  .forEach(([name, value, replacement]) => {
    if (RETIRED_MODEL_IDS.includes(String(value).trim().toLowerCase())) {
      console.log(`[AI] NOTE: ${name}=${value} was retired by the provider. Auto-switching to ${replacement} — update .env to silence this.`);
    }
  });
if (!GROQ_API_KEY && !GEMINI_API_KEY && !OPENROUTER_API_KEY) console.log('[AI] No AI provider configured. Add GROQ_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY to .env, then restart.');
console.log('[PhotoLab] Free keyless image engine active | local image editing always available.');
const AI_MAX_TEXT_LENGTH = 4000;
const AI_COOLDOWN_MS = 2500;
const photoLabCooldowns = new Map();
const photoLabActiveChats = new Set();
const TEMP_DIR = path.join(os.tmpdir(), 'dev-brian-ai');
const WHISPER_CPP_PATH = String(process.env.WHISPER_CPP_PATH || '').trim();
const WHISPER_MODEL_PATH = String(process.env.WHISPER_MODEL_PATH || '').trim();
const PIPER_PATH = String(process.env.PIPER_PATH || '').trim();
const PIPER_MODEL_PATH = String(process.env.PIPER_MODEL_PATH || '').trim();

let maintenanceMode = false;
let startedAt = Date.now();
let activeSocket = null;
let reconnectTimer = null;
let reconnecting = false;
const groupRules = new Map();
const groupData = new Map();
const floodCache = new Map();
const GROUP_DATA_FILE = path.join(process.cwd(), 'group_data.json');
const BOT_SETTINGS_FILE = path.join(process.cwd(), 'bot_settings.json');
const TASK_DATA_FILE = path.join(process.cwd(), 'task_data.json');
let taskData = { notes: {}, todos: {}, reminders: [] };
let taskSaveQueue = Promise.resolve();
let reminderPoller = null;
const stats = { messages: 0, commands: 0, mediaSearches: 0, recoveredDeletes: 0 };
let botSettings = { mode: 'public', antiDeletePrivate: false, autoTyping: false, autoRecording: false, autoReact: false, autoViewStatus: false, autoLikeStatus: false, aiEnabled: false, additionalOwners: [], sessionPrefixes: {} };
const presenceTimers = new Map();
const presenceCache = new Map();
const aiCooldowns = new Map();
const execFileAsync = promisify(execFile);
const messageCache = new Map();
const MAX_CACHED_MESSAGES_PER_CHAT = 250;
const YTDLP_TIMEOUT = 180000;
// Local fallback pools. These are ONLY used when every live API is
// unreachable; normally !joke/!quote/!fact pull fresh content from the web so
// users get hundreds of different results instead of a fixed handful.
const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs!',
  'A programmer’s favourite place is the Foo Bar.',
  'Why did the computer go to the doctor? It caught a virus!',
  'Why was the math book sad? It had too many problems.',
  'I told my wife she was drawing her eyebrows too high. She looked surprised.',
  'Why don’t scientists trust atoms? Because they make up everything!',
  'What do you call fake spaghetti? An impasta!',
  'Why did the scarecrow win an award? He was outstanding in his field.',
  'I would tell you a UDP joke, but you might not get it.',
  'How do you comfort a JavaScript bug? You console it.',
  'Why did the bicycle fall over? Because it was two-tired.',
  'What do you call cheese that isn’t yours? Nacho cheese!',
  'Why can’t your nose be 12 inches long? Because then it would be a foot.',
  'I’m reading a book about anti-gravity. It’s impossible to put down.',
  'Why did the coffee file a police report? It got mugged.',
  'Parallel lines have so much in common. It’s a shame they’ll never meet.',
  'What did the ocean say to the beach? Nothing, it just waved.',
  'Why don’t skeletons fight each other? They don’t have the guts.',
  'What’s orange and sounds like a parrot? A carrot.',
  'I used to play piano by ear, but now I use my hands.'
];
const quotes = [
  'Great things are done by a series of small things brought together.',
  'Success is the sum of small efforts repeated day after day.',
  'Dream big. Start small. Keep moving.',
  'The secret of getting ahead is getting started.',
  'Believe you can and you’re halfway there.',
  'The only way to do great work is to love what you do.',
  'Hardships often prepare ordinary people for an extraordinary destiny.',
  'Don’t watch the clock; do what it does. Keep going.',
  'The future belongs to those who believe in the beauty of their dreams.',
  'It always seems impossible until it’s done.',
  'Your limitation—it’s only your imagination.',
  'Push yourself, because no one else is going to do it for you.',
  'Great things never came from comfort zones.',
  'Success doesn’t just find you. You have to go out and get it.',
  'Dream it. Wish it. Do it.',
  'Little things make big days.',
  'Don’t stop when you’re tired. Stop when you’re done.',
  'Wake up with determination. Go to bed with satisfaction.',
  'Do something today that your future self will thank you for.',
  'The harder you work for something, the greater you’ll feel when you achieve it.'
];
const facts = [
  'A day on Venus is longer than its year.',
  'Octopuses have three hearts.',
  'The first computer bug was an actual insect found in a computer.',
  'Honey never spoils; edible honey has been found in ancient Egyptian tombs.',
  'Bananas are berries, but strawberries are not.',
  'A group of flamingos is called a “flamboyance.”',
  'The Eiffel Tower can grow more than 15 cm taller during summer.',
  'Sharks existed before trees.',
  'Wombat poop is cube-shaped.',
  'There are more stars in the universe than grains of sand on Earth.',
  'Your body has enough iron in it to make a nail about 3 inches long.',
  'A bolt of lightning is five times hotter than the surface of the sun.',
  'Humans share about 60% of their DNA with bananas.',
  'Cows have best friends and get stressed when separated.',
  'The shortest war in history lasted about 38 minutes.',
  'Hot water can freeze faster than cold water under certain conditions.',
  'A single cloud can weigh more than a million pounds.',
  'Sea otters hold hands while sleeping so they don’t drift apart.',
  'The human brain generates enough electricity to power a small light bulb.',
  'Some turtles can breathe through their rear ends.'
];
const OWNER_ONLY_COMMANDS = new Set(['!stats', '!maintenance', '!setbio', '!setpic', '!mode', '!ai', '!addowner', '!addownwer', '!removeowner', '!owners', '!aistatus', '!aitest', '!pair', '!pairstatus', '!unpair', '!unlink']);
const GROUP_ADMIN_COMMANDS = new Set([
  // Information
  '!groupinfo','!members','!membercount','!admins','!creator','!groupid','!groupcreated','!description','!rules','!groupstatus','!settings',
  // Member management
  '!promote','!demote','!remove','!kick','!add','!warn','!warnings','!mute','!unmute','!ban','!unban','!restrict','!whitelist','!blacklist','!resetwarnings',
  // Mentions
  '!tagall','!hidetag','!mention','!tagadmins','!tagmembers','!randommember','!inactive',
  // Settings
  '!groupname','!groupdesc','!setrules','!announcement','!editinfo','!memberadd','!disappearing','!welcome','!goodbye',
  // Moderation
  '!antilink','!antimention','!antispam','!antiflood','!antiword','!antiinvite','!antimedia','!warningsystem','!antidelete','!closegrp','!opengrp',
  // Message cleanup (works in groups AND private chats)
  '!del','!delete','!delmsg','!rm',
  // Existing utilities
  '!poll','!invite','!revoke'
]);
const GROUP_COMMANDS = new Set([...GROUP_ADMIN_COMMANDS, '!group', '!leave']);
const SEARCH_MEDIA_COMMANDS = new Set(['!audio','!song','!ytmp3','!video','!yt','!ytmp4','!play']);
const DIRECT_MEDIA_COMMANDS = new Set(['!tiktok','!facebook','!fb','!instagram','!ig']);

function normalizeJid(jid = '') { return String(jid).split(':')[0]; }
function getSessionPrefixKey(sock) {
  const own = phoneFromJid(sock?.user?.id || sock?.user?.jid || sock?.user?.phoneNumber || '');
  return own || 'main';
}
function getCommandPrefix(sock) {
  const key = getSessionPrefixKey(sock);
  const value = botSettings.sessionPrefixes?.[key];
  return typeof value === 'string' && value.length <= 4 && value.trim() ? value.trim() : '!';
}
function prefixForDisplay(text, prefix) {
  const active = String(prefix || '!');
  const source = String(text ?? '');
  // Only touch command tokens: "!word" at the start or after a space / newline /
  // bracket / asterisk / quote, so phone numbers, "!!!" or "wow!" stay untouched.
  const rewritten = source.replace(/(^|[\s(>\[*_`'"\u2018\u201c])!([a-z][a-z0-9_-]*)/gi,
    (_, lead, name) => `${lead}${active}${name}`);
  if (active === '!') return rewritten;
  return rewritten;
}
function phoneFromJid(jid = '') {
  const clean = normalizeJid(jid);
  if (clean.endsWith('@s.whatsapp.net')) return clean.split('@')[0];
  if (/^\d{7,15}$/.test(clean)) return clean;
  return '';
}
function isConfiguredOwner(jid = '') { return phoneFromJid(jid) === OWNER_NUMBER; }
function isAdditionalOwner(jid = '') {
  const phone = phoneFromJid(jid);
  return Boolean(phone && Array.isArray(botSettings.additionalOwners) && botSettings.additionalOwners.includes(phone));
}
function isAnyOwnerJid(jid = '') { return isConfiguredOwner(jid) || isAdditionalOwner(jid); }
function isBotTarget(jid, sock) { return isOwnAccountJid(jid, sock) || isConfiguredOwner(jid); }
function isOwnAccountJid(jid, sock) {
  if (!jid) return false;
  const candidate = normalizeJid(jid);
  const ownJids = [sock?.user?.id, sock?.user?.lid, sock?.user?.jid, sock?.user?.phoneNumber]
    .filter(Boolean).map(normalizeJid);
  return ownJids.includes(candidate) || isConfiguredOwner(jid);
}
async function resolvePhoneFromJid(sock, jid = '') {
  const direct = phoneFromJid(jid);
  if (direct) return direct;
  const normalized = normalizeJid(jid);
  if (!normalized || !normalized.endsWith('@lid')) return '';
  try {
    const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(normalized);
    return phoneFromJid(mapped || '');
  } catch {
    return '';
  }
}
async function jidMatchesOwner(sock, jid = '', includeAdditional = true) {
  const phone = await resolvePhoneFromJid(sock, jid);
  if (!phone) return false;
  if (phone === OWNER_NUMBER) return true;
  return includeAdditional && Array.isArray(botSettings.additionalOwners) && botSettings.additionalOwners.includes(phone);
}
function messageSender(msg) {
  return msg.key.participant || msg.key.participantPn || msg.key.participantAlt || msg.key.remoteJid || '';
}
async function messageIsPrimaryOwner(msg, sock, chatJid) {
  if (Boolean(msg.key.fromMe)) return true;
  const candidates = [messageSender(msg), msg.key.participantPn, msg.key.participantAlt, chatJid].filter(Boolean);
  for (const candidate of candidates) if (await jidMatchesOwner(sock, candidate, false)) return true;
  return false;
}
async function messageIsOwner(msg, sock, chatJid) {
  if (Boolean(msg.key.fromMe)) return true;
  const candidates = [messageSender(msg), msg.key.participantPn, msg.key.participantAlt, chatJid].filter(Boolean);
  for (const candidate of candidates) if (await jidMatchesOwner(sock, candidate, true)) return true;
  return false;
}
function getText(message) {
  let msg = message;
  while (msg?.ephemeralMessage || msg?.viewOnceMessage || msg?.viewOnceMessageV2 || msg?.viewOnceMessageV2Extension || msg?.documentWithCaptionMessage || msg?.associatedChildMessage) {
    msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message ||
      msg.documentWithCaptionMessage?.message || msg.associatedChildMessage;
  }
  // Native-flow (interactive) button taps send the chosen id inside a JSON blob.
  let nativeFlowId = '';
  const nativeParams = msg?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeParams) {
    try { nativeFlowId = String(JSON.parse(nativeParams)?.id || '').trim(); } catch {}
  }
  return (msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    nativeFlowId ||
    msg?.buttonsResponseMessage?.selectedButtonId ||
    msg?.templateButtonReplyMessage?.selectedId ||
    msg?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg?.imageMessage?.caption || msg?.videoMessage?.caption ||
    msg?.documentMessage?.caption || msg?.stickerMessage?.caption || '').trim();
}
function unwrapMessage(message) {
  let msg = message;
  while (msg?.ephemeralMessage || msg?.viewOnceMessage || msg?.viewOnceMessageV2 || msg?.viewOnceMessageV2Extension || msg?.documentWithCaptionMessage || msg?.associatedChildMessage) {
    msg = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message ||
      msg.documentWithCaptionMessage?.message || msg.associatedChildMessage;
  }
  return msg || {};
}
function getQuotedMessage(msg) {
  const m = unwrapMessage(msg.message);
  const context = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo || m.audioMessage?.contextInfo || m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo || m.conversation?.contextInfo;
  if (!context?.quotedMessage) return null;
  return { message: context.quotedMessage, participant: context.participant || context.participantPn || context.participantAlt, stanzaId: context.stanzaId };
}
function findViewOnceMedia(message) {
  let current = message;
  for (let i = 0; i < 8 && current; i++) {
    if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message;
    else if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else if (current.associatedChildMessage) current = current.associatedChildMessage;
    else break;
  }
  const media = current?.imageMessage || current?.videoMessage || current?.audioMessage;
  return media?.viewOnce ? { content: current, media } : null;
}
function randomItem(items) { return items[Math.floor(Math.random() * items.length)]; }
// Pull fresh jokes/quotes/facts from free, keyless public APIs so users get
// hundreds of different results. Each kind tries two providers, then falls back
// to the local pool so the command NEVER fails even when offline.
async function fetchFunContent(kind) {
  const ua = { 'User-Agent': 'Mozilla/5.0 NancyNovaAI', 'Accept': 'application/json' };
  const timeout = () => AbortSignal.timeout(9000);
  const providers = {
    joke: [
      async () => {
        const r = await fetch('https://v2.jokeapi.dev/joke/Any?safe-mode&format=json', { headers: ua, signal: timeout() });
        const j = await r.json();
        if (j?.type === 'single' && j.joke) return j.joke;
        if (j?.setup && j?.delivery) return `${j.setup}\n\n${j.delivery}`;
        throw new Error('no joke');
      },
      async () => {
        const r = await fetch('https://official-joke-api.appspot.com/random_joke', { headers: ua, signal: timeout() });
        const j = await r.json();
        if (j?.setup && j?.punchline) return `${j.setup}\n\n${j.punchline}`;
        throw new Error('no joke');
      }
    ],
    quote: [
      async () => {
        const r = await fetch('https://zenquotes.io/api/random', { headers: ua, signal: timeout() });
        const j = await r.json();
        const item = Array.isArray(j) ? j[0] : null;
        if (item?.q) return `${item.q}${item.a ? `\n\n— ${item.a}` : ''}`;
        throw new Error('no quote');
      },
      async () => {
        const r = await fetch('https://api.quotable.io/random', { headers: ua, signal: timeout() });
        const j = await r.json();
        if (j?.content) return `${j.content}${j.author ? `\n\n— ${j.author}` : ''}`;
        throw new Error('no quote');
      }
    ],
    fact: [
      async () => {
        const r = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', { headers: ua, signal: timeout() });
        const j = await r.json();
        if (j?.text) return j.text;
        throw new Error('no fact');
      },
      async () => {
        const r = await fetch('https://catfact.ninja/fact', { headers: ua, signal: timeout() });
        const j = await r.json();
        if (j?.fact) return j.fact;
        throw new Error('no fact');
      }
    ]
  };
  for (const provider of (providers[kind] || [])) {
    try {
      const value = (await provider()).trim();
      if (value) return value;
    } catch { /* try next provider */ }
  }
  const pool = kind === 'joke' ? jokes : kind === 'quote' ? quotes : facts;
  return randomItem(pool);
}
// Turn raw low-level errors (yt-dlp dumps, socket codes) into one short, human
// sentence so users see a clear reason instead of a scary full command line.
function friendlyError(error) {
  const raw = String(error?.message || error || 'Unknown error');
  if (/getaddrinfo|ENOTFOUND|\b11001\b|EAI_AGAIN|name resolution|Unable to download webpage|Failed to resolve|Temporary failure/i.test(raw))
    return 'the device running the bot could not reach the internet (a DNS lookup failed). Make sure that computer is online. If other sites work, your DNS may be blocking the source — try changing DNS to 8.8.8.8 / 1.1.1.1, then retry.';
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|network is unreachable|timed out|timeout/i.test(raw))
    return 'the connection to the media source timed out. Check the internet connection and try again in a moment.';
  if (/Private video|login required|Sign in to confirm|HTTP Error 429|rate.?limit|requires authentication|cookies|age.?restricted|not available in your country/i.test(raw))
    return 'the source needs a login or is temporarily blocking automated downloads (common with Instagram, Facebook and YouTube). Try again later, or use a public link.';
  if (/Unsupported URL|Unable to extract|No video formats|is not a valid URL|Video unavailable|This content/i.test(raw))
    return 'that link or format is not supported, is private, or has no downloadable media.';
  if (/yt-dlp could not be started|No module named yt_dlp|yt-dlp.*not found/i.test(raw))
    return 'yt-dlp is not installed on the device. Install it with "pip install -U yt-dlp" (or download the yt-dlp binary) and restart the bot.';
  if (/FFmpeg could not be located/i.test(raw)) return raw;
  // Otherwise strip a "Command failed: <huge command>" dump down to the last real line.
  const cleaned = raw.replace(/Command failed:[\s\S]*/i, '').trim();
  const lastLine = String(cleaned || raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || raw;
  return lastLine.slice(0, 300);
}
// Smart lyrics lookup across MULTIPLE keyless sources for the widest coverage
// (including African / Swahili / non-Western songs). Accepts "Artist - Title"
// OR just a song name. Order: LRCLIB free-text search -> LRCLIB get by
// artist/title -> lyrics.ovh. iTunes is used only to resolve a bare song name
// into an artist/title pair. No API key required anywhere.
async function fetchLyrics(input) {
  const query = String(input || '').trim();
  if (!query) throw new Error('empty query');
  const ua = { 'User-Agent': 'NancyNovaAI (WhatsApp lyrics bot)', 'Accept': 'application/json' };
  const clean = (t) => String(t || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const fetchJson = async (url) => {
    const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  // Split "Artist - Title" if present.
  let artist = '';
  let title = '';
  const dash = query.match(/^(.*?)\s*[-–—]\s*(.*)$/);
  if (dash) { artist = dash[1].trim(); title = dash[2].trim(); }

  // Source 1: LRCLIB free-text search (very forgiving, broad catalogue).
  const lrclibSearch = async (q) => {
    const arr = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
    if (Array.isArray(arr)) {
      const hit = arr.find(x => x && !x.instrumental && clean(x.plainLyrics));
      if (hit) return { artist: hit.artistName || artist, title: hit.trackName || title, lyrics: clean(hit.plainLyrics) };
    }
    return null;
  };
  // Source 2: LRCLIB exact get by artist + track.
  const lrclibGet = async (a, t) => {
    const j = await fetchJson(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(a)}&track_name=${encodeURIComponent(t)}`);
    const lyrics = clean(j?.plainLyrics);
    if (lyrics) return { artist: j.artistName || a, title: j.trackName || t, lyrics };
    return null;
  };
  // Source 3: lyrics.ovh.
  const lyricsOvh = async (a, t) => {
    const j = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`);
    const lyrics = clean(j?.lyrics);
    if (lyrics) return { artist: a, title: t, lyrics };
    return null;
  };

  const attempts = [];
  attempts.push(() => lrclibSearch(query));
  if (dash) {
    attempts.push(() => lrclibSearch(`${artist} ${title}`));
    attempts.push(() => lrclibGet(artist, title));
    attempts.push(() => lyricsOvh(artist, title));
  }
  // Resolve a bare name (or confirm) via iTunes, then retry the good sources.
  let itunesArtist = '';
  let itunesTitle = '';
  try {
    const j = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`);
    const hit = j?.results?.[0];
    if (hit?.artistName && hit?.trackName) { itunesArtist = hit.artistName; itunesTitle = hit.trackName; }
  } catch { /* iTunes optional */ }
  if (itunesArtist && itunesTitle) {
    attempts.push(() => lrclibSearch(`${itunesArtist} ${itunesTitle}`));
    attempts.push(() => lrclibGet(itunesArtist, itunesTitle));
    attempts.push(() => lyricsOvh(itunesArtist, itunesTitle));
  }

  for (const run of attempts) {
    try {
      const res = await run();
      if (res && res.lyrics) return res;
    } catch { /* try next source */ }
  }
  throw new Error('I searched several lyrics libraries but could not find this song. It may be too new or niche to be indexed yet. Tip: try the exact spelling as "Artist - Song title" (e.g. !lyrics Rayvanny - Number One).');
}
function formatUptime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}

function defaultGroupData() {
  const data = {
    rules: '',
    warnings: {},
    muted: {},
    banned: {},
    whitelist: [],
    blacklist: [],
    activity: {},
    memberNumbers: {},
    nextMemberNumber: 1,
    settings: {
      welcome: true,
      welcomeConfigured: false,
      welcomeText: '╭━━━〔 🌟 WELCOME TO THE FAMILY 🌟 〕━━━╮\nHey @user! 👋💖\nA big, warm welcome to @group! 🫶✨\nWe are soooo happy to have you here, sweetie! Make yourself comfy, connect with everyone, respect the group rules, and enjoy your stay! 💫💎\n📌 Type !rules to read the group rules.\n💎 Powered by Nancy Nova AI 🌟 | Team NASA\n💌 You are welcome here. Let us make some lovely memories together! 👑\n╰━━━━━━━━━━━━━━━━━━━━╯',
      goodbye: true,
      goodbyeConfigured: false,
      goodbyeText: '╭━━━〔 💎 UNTIL WE MEET AGAIN 💎 〕━━━╮\nGoodbye @user! 👋🥹\nThank you for being part of @group. Wherever life takes you, keep smiling, growing, and shining, hun. 🌟\nYou will always be welcome back. Take care of yourself and until we meet again! 💖🫶\n💎 Nancy Nova AI 🌟 | Team NASA ✨\n╰━━━━━━━━━━━━━━━━━━━━╯',
      antiLink: false,
      antiLinkMode: 'warn',
      antiMention: false,
      antiMentionMode: 'del',
      antiSpam: false,
      antiFlood: false,
      antiWord: false,
      antiInvite: false,
      antiMedia: false,
      warningSystem: true,
      antiDelete: false,
      antiDeleteMode: 'inbox',
      antiWords: [],
      announcement: false,
      editInfo: false,
      memberAdd: 'all',
      disappearing: 0
    }
  };
  // Anything the owner set from his personal chat becomes the default for every
  // group, including groups Nancy joins later.
  const globals = botSettings?.globalSettings || {};
  for (const [key, value] of Object.entries(globals)) {
    if (Object.prototype.hasOwnProperty.call(data.settings, key)) data.settings[key] = value;
  }
  return data;
}
function getGroupData(jid) {
  if (!groupData.has(jid)) groupData.set(jid, defaultGroupData());
  const data = groupData.get(jid);
  const base = defaultGroupData();
  data.settings = { ...base.settings, ...(data.settings || {}) };
  data.warnings ||= {};
  data.muted ||= {};
  data.banned ||= {};
  data.activity ||= {};
  data.memberNumbers ||= {};
  data.nextMemberNumber = Number(data.nextMemberNumber || 1);
  data.whitelist ||= [];
  data.blacklist ||= [];
  return data;
}
async function loadGroupData() {
  try {
    const raw = JSON.parse(await readFile(GROUP_DATA_FILE, 'utf8'));
    for (const [jid, value] of Object.entries(raw || {})) {
      const mergedSettings = { ...defaultGroupData().settings, ...(value.settings || {}) };
      // Older releases stored welcome=false as the untouched default. Turn those
      // implicit defaults on; preserve choices made with the current settings commands.
      if (!mergedSettings.welcomeConfigured) mergedSettings.welcome = true;
      if (!mergedSettings.goodbyeConfigured) mergedSettings.goodbye = true;
      groupData.set(jid, { ...defaultGroupData(), ...value, settings: mergedSettings });
      if (value.rules) groupRules.set(jid, value.rules);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Group data load failed:', error.message);
  }
}
async function saveGroupData() {
  const out = Object.fromEntries(groupData.entries());
  await writeFile(GROUP_DATA_FILE, JSON.stringify(out, null, 2), 'utf8');
}
async function loadBotSettings() {
  try {
    const raw = JSON.parse(await readFile(BOT_SETTINGS_FILE, 'utf8'));
    botSettings = { mode: ['public','private','admin'].includes(raw?.mode) ? raw.mode : 'public', antiDeletePrivate: Boolean(raw?.antiDeletePrivate), autoTyping: Boolean(raw?.autoTyping), autoRecording: Boolean(raw?.autoRecording), autoReact: Boolean(raw?.autoReact), autoViewStatus: Boolean(raw?.autoViewStatus), autoLikeStatus: Boolean(raw?.autoLikeStatus), aiEnabled: Boolean(raw?.aiEnabled), additionalOwners: Array.isArray(raw?.additionalOwners) ? [...new Set(raw.additionalOwners.map(x => String(x).trim()).filter(Boolean))] : [], sessionPrefixes: raw?.sessionPrefixes && typeof raw.sessionPrefixes === 'object' && !Array.isArray(raw.sessionPrefixes) ? Object.fromEntries(Object.entries(raw.sessionPrefixes).filter(([k,v]) => typeof k === 'string' && typeof v === 'string' && v.length <= 4 && v.trim())) : {}, globalSettings: raw?.globalSettings && typeof raw.globalSettings === 'object' && !Array.isArray(raw.globalSettings) ? raw.globalSettings : {} };
  } catch (error) {
    if (error.code === 'ENOENT') {
      botSettings = { mode: 'public', antiDeletePrivate: false, autoTyping: false, autoRecording: false, autoReact: false, autoViewStatus: false, autoLikeStatus: false, aiEnabled: false, additionalOwners: [], sessionPrefixes: {}, globalSettings: {} };
      await saveBotSettings();
    } else {
      console.error('Bot settings load failed:', error.message);
      botSettings = { mode: 'public', antiDeletePrivate: false, autoTyping: false, autoRecording: false, autoReact: false, autoViewStatus: false, autoLikeStatus: false, aiEnabled: false, additionalOwners: [], sessionPrefixes: {} };
    }
  }
}
async function saveBotSettings() {
  await writeFile(BOT_SETTINGS_FILE, JSON.stringify(botSettings, null, 2), 'utf8');
}
function displayJid(jid='') {
  return `@${phoneFromJid(jid) || normalizeJid(jid).split('@')[0]}`;
}
function participantJid(p) {
  return p?.id || p?.jid || p?.phoneNumber || p?.lid || '';
}
function getQuotedContextInfo(msg) {
  const m = unwrapMessage(msg.message);
  return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo || m.audioMessage?.contextInfo || m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo || m.conversation?.contextInfo || {};
}
function getMentionedJids(msg) {
  const context = getQuotedContextInfo(msg);
  return (context.mentionedJid || []).filter(Boolean);
}
function resolveTargetJids(msg, args = [], { allowCurrentChat = true } = {}) {
  const targets = [];
  const quoted = getQuotedMessage(msg);
  if (quoted?.participant) targets.push(quoted.participant);
  for (const jid of getMentionedJids(msg)) if (!targets.includes(jid)) targets.push(jid);
  for (const raw of args) {
    const digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      const jid = `${digits}@s.whatsapp.net`;
      if (!targets.includes(jid)) targets.push(jid);
    }
  }
  if (!targets.length && allowCurrentChat && msg.key?.remoteJid && !msg.key.remoteJid.endsWith('@g.us') && !msg.key.remoteJid.endsWith('@broadcast')) {
    targets.push(msg.key.remoteJid);
  }
  return targets;
}
function targetLabel(jid) { return displayJid(jid); }
function randomPercent() { return Math.floor(Math.random() * 101); }
function funTargetLine(jid, fallback = 'that person') { return jid ? targetLabel(jid) : fallback; }
function isAdminParticipant(p) {
  return Boolean(p) && (
    p.admin === 'admin' ||
    p.admin === 'superadmin' ||
    p.isAdmin === true ||
    p.isSuperAdmin === true
  );
}
function parseDuration(raw='') {
  const m = String(raw).trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) return 10 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  return n * ({s:1000,m:60000,h:3600000,d:86400000}[unit] || 60000);
}
function remainingTime(until) {
  const ms = Math.max(0, Number(until || 0) - Date.now());
  const minutes = Math.ceil(ms / 60000);
  return minutes < 60 ? `${minutes} minute(s)` : `${Math.ceil(minutes / 60)} hour(s)`;
}
function messageHasMedia(msg) {
  const c = unwrapMessage(msg.message);
  return Boolean(c.imageMessage || c.videoMessage || c.audioMessage || c.documentMessage || c.stickerMessage);
}

async function getProfilePictureUrl(sock, jid) {
  try { return await sock.profilePictureUrl(jid, 'image'); }
  catch { return null; }
}
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length ? buffer : null;
  } catch { return null; }
}
async function getBotMenuImage(sock) {
  const localCandidates = [
    path.join(process.cwd(), 'bot_profile.jpg'),
    path.join(process.cwd(), 'bot_profile.jpeg'),
    path.join(process.cwd(), 'bot_profile.png')
  ];
  for (const file of localCandidates) {
    try { return await readFile(file); } catch {}
  }
  const ownJids = [sock.user?.id, sock.user?.lid, `${OWNER_NUMBER}@s.whatsapp.net`].filter(Boolean);
  for (const ownJid of ownJids) {
    const url = await getProfilePictureUrl(sock, ownJid);
    const buffer = await fetchImageBuffer(url);
    if (buffer) return buffer;
  }
  const remote = await fetchImageBuffer(PROFILE_IMAGE_URL);
  if (remote) return remote;
  // Guaranteed local fallback: the menu remains usable even if the image host
  // or WhatsApp profile-picture endpoint is temporarily unavailable.
  try {
    return await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><radialGradient id="g" cx="50%" cy="38%" r="75%"><stop offset="0%" stop-color="#2b1b4d"/><stop offset="55%" stop-color="#140d2b"/><stop offset="100%" stop-color="#05030f"/></radialGradient><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7dd3fc"/><stop offset="50%" stop-color="#c084fc"/><stop offset="100%" stop-color="#f4c76b"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="512" cy="400" r="230" fill="none" stroke="url(#t)" stroke-width="10" opacity="0.8"/><text x="50%" y="44%" text-anchor="middle" font-family="Georgia, serif" font-size="150" font-weight="700" fill="url(#t)">N</text><text x="50%" y="70%" text-anchor="middle" font-family="Arial" font-size="62" font-weight="800" letter-spacing="4" fill="#ffffff">NANCY NOVA AI</text><text x="50%" y="78%" text-anchor="middle" font-family="Arial" font-size="40" letter-spacing="6" fill="#c7b3ff">TEAM NASA</text></svg>`)).png().toBuffer();
  } catch { return null; }
}
function presenceMode() {
  if (botSettings.autoRecording) return 'recording';
  if (botSettings.autoTyping) return 'composing';
  return null;
}
function clearPresenceTimer(jid) {
  const timer = presenceTimers.get(jid);
  if (timer) clearInterval(timer);
  presenceTimers.delete(jid);
}
async function triggerAutoPresence(sock, jid) {
  const mode = presenceMode();
  if (!mode || !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;
  clearPresenceTimer(jid);
  const send = async () => {
    try { await sock.sendPresenceUpdate(mode, jid); } catch {}
  };
  await send();
  const timer = setInterval(send, 7000);
  presenceTimers.set(jid, timer);
  setTimeout(() => {
    if (presenceTimers.get(jid) === timer) {
      clearPresenceTimer(jid);
      sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
  }, 28000);
}
async function uploadMediaToCatbox(sock, msg) {
  const target = await findMediaTarget(sock, msg);
  if (!target) throw new Error('Reply to an image, video, audio, or document, then send !tourl.');
  const content = unwrapMessage(target.message);
  const media = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage || content.stickerMessage;
  if (!media) throw new Error('Unsupported media. Reply to an image, video, audio, document, or sticker.');
  const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!buffer?.length) throw new Error('WhatsApp could not download the replied media. Try sending the media again, then reply to it with !tourl.');
  if (buffer.length > 200 * 1024 * 1024) throw new Error('Catbox upload limit: this file is over 200 MB.');
  const mime = media.mimetype || (content.imageMessage ? 'image/jpeg' : content.videoMessage ? 'video/mp4' : content.audioMessage ? 'audio/ogg' : content.stickerMessage ? 'image/webp' : 'application/octet-stream');
  const extByMime = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif', 'video/mp4':'mp4', 'video/3gpp':'3gp', 'audio/ogg':'ogg', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'application/pdf':'pdf' };
  const ext = extByMime[mime.split(';')[0].trim()] || (content.videoMessage ? 'mp4' : content.audioMessage ? 'ogg' : content.imageMessage ? 'jpg' : 'bin');
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([buffer], { type: mime }), `dev-brian-media-${Date.now()}.${ext}`);
  // Catbox supports anonymous uploads; only send userhash when the owner configured one.
  const catboxUserhash = String(process.env.CATBOX_USERHASH || '').trim();
  if (catboxUserhash) form.append('userhash', catboxUserhash);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response;
  try {
    response = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Catbox upload timed out after 90 seconds. Try a smaller file or retry later.');
    throw new Error(`Could not reach Catbox: ${error.message}`);
  } finally { clearTimeout(timeout); }
  const result = (await response.text()).trim();
  if (!response.ok || !/^https?:\/\/files\.catbox\.moe\/[\w.-]+$/i.test(result)) {
    throw new Error(`Catbox rejected the upload${response.status ? ` (HTTP ${response.status})` : ''}: ${(result || 'empty response').slice(0, 240)}`);
  }
  return { url: result, mime, bytes: buffer.length };
}
async function sendPersonalStatusMedia(sock, msg, jid, caption = '') {
  const target = await findMediaTarget(sock, msg);
  if (!target) throw new Error('Reply to an image, video, or audio message, then send !tostatus.');
  const content = unwrapMessage(target.message);
  const media = content.imageMessage || content.videoMessage || content.audioMessage;
  if (!media) throw new Error('!tostatus supports images, videos, and audio only.');
  const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!buffer?.length) throw new Error('WhatsApp could not download the replied media. Try sending it again.');
  const statusOptions = { broadcast: true };
  const contextInfo = { featureEligibilities: { canBeReshared: true } };
  if (content.imageMessage) await sock.sendMessage('status@broadcast', { image: buffer, ...(caption ? { caption } : {}), contextInfo }, statusOptions);
  else if (content.videoMessage) await sock.sendMessage('status@broadcast', { video: buffer, ...(caption ? { caption } : {}), contextInfo }, statusOptions);
  else await sock.sendMessage('status@broadcast', { audio: buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: true }, { ...statusOptions, backgroundColor: '#000000' });
}

async function sendGroupStatusMedia(sock, msg, jid, caption = '') {
  if (!jid.endsWith('@g.us')) throw new Error('!togrpstatus can only be used inside a WhatsApp group.');
  const target = await findMediaTarget(sock, msg);
  if (!target) throw new Error('Reply to an image, video, or audio message, then send !togrpstatus.');
  const content = unwrapMessage(target.message);
  const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!buffer?.length) throw new Error('The media could not be downloaded.');
  const metadata = await sock.groupMetadata(jid);
  // WhatsApp does not expose a separate "group status" object in standard Baileys.
  // The supported implementation is a Status/Story whose audience is the group members.
  // Prefer PN JIDs when group metadata exposes them; this avoids LID/PN mix-ups on status sends.
  const rawRecipients = (metadata.participants || [])
    .map(p => p?.phoneNumber || p?.jid || p?.id || p?.lid || '')
    .filter(Boolean);
  const recipients = new Set();
  for (const raw of rawRecipients) {
    const normalized = normalizeJid(raw);
    if (!normalized || isOwnAccountJid(normalized, sock)) continue;
    if (normalized.endsWith('@s.whatsapp.net')) recipients.add(normalized);
    else if (/^\d{7,15}$/.test(normalized)) recipients.add(`${normalized}@s.whatsapp.net`);
    else {
      const pn = rawRecipients.find(candidate => candidate !== raw && /@s.whatsapp.net$/.test(candidate) && phoneFromJid(candidate));
      if (pn) recipients.add(normalizeJid(pn));
    }
  }
  const statusRecipients = [...recipients];
  if (!statusRecipients.length) throw new Error('Could not determine the group status audience.');
  const statusOptions = {
    statusJidList: statusRecipients,
    broadcast: true
  };
  const contextInfo = { featureEligibilities: { canBeReshared: true } };
  const textCaption = caption || 'Shared with this group via Nancy Nova AI';
  if (content.imageMessage) {
    await sock.sendMessage('status@broadcast', { image: buffer, caption: textCaption, contextInfo }, statusOptions);
  } else if (content.videoMessage) {
    await sock.sendMessage('status@broadcast', { video: buffer, caption: textCaption, contextInfo }, statusOptions);
  } else if (content.audioMessage) {
    await sock.sendMessage('status@broadcast', { audio: buffer, mimetype: content.audioMessage.mimetype || 'audio/ogg; codecs=opus', ptt: true }, { ...statusOptions, backgroundColor: '#000000' });
  } else throw new Error('Only image, video, and audio are supported.');
}

function aiCooldownActive(jid) {
  const until = aiCooldowns.get(jid) || 0;
  if (until > Date.now()) return true;
  aiCooldowns.delete(jid);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-PROVIDER AI SERVICE — GroqCloud + Google Gemini + OpenRouter
// Each provider is fully independent: its own key, model, endpoint and errors.
// No OpenAI code path exists anywhere below.
// ═══════════════════════════════════════════════════════════════════════════
const AI_PROVIDERS = {
  groq: {
    key: 'groq', label: 'GroqCloud', emoji: '⚡', command: '!grok',
    aliases: ['!grok', '!groq'],
    signupUrl: 'https://console.groq.com/keys',
    envKey: 'GROQ_API_KEY', envModel: 'GROQ_MODEL', fallbackModel: DEFAULT_GROQ_MODEL,
    apiKey: () => GROQ_API_KEY, model: () => resolveModelId(AI_PROVIDERS.groq, GROQ_MODEL)
  },
  gemini: {
    key: 'gemini', label: 'Google Gemini', emoji: '🌟', command: '!gemini',
    aliases: ['!gemini'],
    signupUrl: 'https://aistudio.google.com/apikey',
    envKey: 'GEMINI_API_KEY', envModel: 'GEMINI_MODEL', fallbackModel: DEFAULT_GEMINI_MODEL,
    apiKey: () => GEMINI_API_KEY, model: () => resolveModelId(AI_PROVIDERS.gemini, GEMINI_MODEL)
  },
  openrouter: {
    key: 'openrouter', label: 'OpenRouter', emoji: '🔀', command: '!openrouter',
    aliases: ['!openrouter', '!or'],
    signupUrl: 'https://openrouter.ai/keys',
    envKey: 'OPENROUTER_API_KEY', envModel: 'OPENROUTER_MODEL', fallbackModel: DEFAULT_OPENROUTER_MODEL,
    apiKey: () => OPENROUTER_API_KEY, model: () => resolveModelId(AI_PROVIDERS.openrouter, OPENROUTER_MODEL)
  }
};
const AI_PROVIDER_ORDER = ['groq', 'gemini', 'openrouter'];
const AI_COMMAND_PROVIDERS = new Set(['!grok', '!groq', '!gemini', '!openrouter', '!or']);

function resolveProvider(name) {
  const clean = String(name || '').toLowerCase().replace(/^!/, '').trim();
  if (AI_PROVIDERS[clean]) return AI_PROVIDERS[clean];
  return AI_PROVIDER_ORDER.map(k => AI_PROVIDERS[k]).find(p => p.aliases.includes(`!${clean}`)) || null;
}
function providerConfigured(provider) { return Boolean(provider && provider.apiKey()); }
function configuredProviders() { return AI_PROVIDER_ORDER.map(k => AI_PROVIDERS[k]).filter(providerConfigured); }
function anyAiConfigured() { return configuredProviders().length > 0; }
function maskKey(key) {
  const clean = String(key || '');
  if (!clean) return 'MISSING';
  if (clean.length <= 10) return `${clean.slice(0, 2)}…`;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}
function nancySystemPrompt() {
  return `You are ${BOT_NAME} 💎 — a brilliant, elegant and confident WhatsApp assistant crafted by ${OWNER_NAME} at ${TEAM_NAME} (a project by Dev Brian and Dev Nancy; website ${WEBSITE_URL}). Your vibe is sleek, modern and premium: warm and friendly, sharp and witty, calm and reassuring, never cutesy. Speak with poise and clarity. Use tasteful luxe emojis (💎✨🌟💫👑🔷) sparingly for accent, never clutter. Keep replies genuinely helpful, smart and concise for WhatsApp. If asked who built or owns you, credit ${OWNER_NAME} and ${TEAM_NAME}, and share the website ${WEBSITE_URL}.`;
}

// ── Group settings controlled from ANY chat ──
// Group moderation switches used to require a group. The owner can now set them
// once from his personal chat: the choice is written into every known group and
// stored as the default for groups Nancy joins later.
const GLOBAL_GROUP_TOGGLES = {
  '!antilink': { setting: 'antiLink', label: 'ANTI-LINK', modeKey: 'antiLinkMode' },
  '!antimention': { setting: 'antiMention', label: 'ANTI-MENTION', modeKey: 'antiMentionMode' },
  '!antispam': { setting: 'antiSpam', label: 'ANTI-SPAM' },
  '!antiflood': { setting: 'antiFlood', label: 'ANTI-FLOOD' },
  '!antiinvite': { setting: 'antiInvite', label: 'ANTI-INVITE' },
  '!antimedia': { setting: 'antiMedia', label: 'ANTI-MEDIA' },
  '!antiword': { setting: 'antiWord', label: 'ANTI-WORD' },
  '!warningsystem': { setting: 'warningSystem', label: 'WARNING SYSTEM' },
  '!antidelete': { setting: 'antiDelete', label: 'ANTI-DELETE' },
  '!welcome': { setting: 'welcome', label: 'WELCOME MESSAGES' },
  '!goodbye': { setting: 'goodbye', label: 'GOODBYE MESSAGES' }
};

async function applyGlobalGroupToggle(sock, msg, jid, command, args) {
  const meta = GLOBAL_GROUP_TOGGLES[command];
  if (!meta) return false;
  const prefix = getCommandPrefix(sock);
  const raw = String(args[0] || '').toLowerCase();
  botSettings.globalSettings ||= {};
  const current = botSettings.globalSettings[meta.setting];
  const hasValue = typeof current === 'boolean';
  const modeNow = meta.modeKey ? botSettings.globalSettings[meta.modeKey] : '';

  if (!raw || raw === 'status' || raw === 'info') {
    await sock.sendMessage(jid, { text: [
      `\U0001F6E1\uFE0F *${meta.label} \u2014 GLOBAL SWITCH*`,
      '\u25C8\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u25C8',
      '',
      `\U0001F4CA *Default:* ${hasValue ? (current ? 'ON \u2705' : 'OFF \u26D4') : 'not set yet'}${modeNow ? ` (${String(modeNow).toUpperCase()} mode)` : ''}`,
      `\U0001F4C2 *Applies to:* ${groupData.size} known group(s) + every future group`,
      '',
      '\u25B8 *Commands*',
      `\u2022 ${prefix}${command.slice(1)} on`,
      `\u2022 ${prefix}${command.slice(1)} off`,
      meta.modeKey ? `\u2022 ${prefix}${command.slice(1)} del  /  ${prefix}${command.slice(1)} warn` : '',
      '',
      `_Set it once here and it follows every group \u2014 no need to repeat it inside each one._`
    ].filter(Boolean).join('\n') }, { quoted: msg });
    return true;
  }

  let value = null;
  let mode = '';
  if (['on', 'enable', 'enabled', 'yes', 'true', '1'].includes(raw)) value = true;
  else if (['off', 'disable', 'disabled', 'no', 'false', '0'].includes(raw)) value = false;
  else if (meta.modeKey && ['del', 'delete', 'warn', 'warning'].includes(raw)) { value = true; mode = raw === 'delete' ? 'del' : raw === 'warning' ? 'warn' : raw; }

  if (value === null) {
    await sock.sendMessage(jid, { text: `\u2699\uFE0F *HOW TO USE ${prefix}${command.slice(1)}*\n\n\u2022 ${prefix}${command.slice(1)} on\n\u2022 ${prefix}${command.slice(1)} off\n\u2022 ${prefix}${command.slice(1)} status${meta.modeKey ? `\n\u2022 ${prefix}${command.slice(1)} del  \u2014 delete and tag\n\u2022 ${prefix}${command.slice(1)} warn \u2014 report only` : ''}` }, { quoted: msg });
    return true;
  }

  botSettings.globalSettings[meta.setting] = value;
  if (mode) botSettings.globalSettings[meta.modeKey] = mode;
  if (command === '!antidelete') botSettings.antiDeletePrivate = value;
  let updated = 0;
  for (const [, data] of groupData.entries()) {
    if (!data?.settings) continue;
    data.settings[meta.setting] = value;
    if (mode) data.settings[meta.modeKey] = mode;
    if (command === '!antidelete') data.settings.antiDeleteMode = data.settings.antiDeleteMode || 'inbox';
    updated++;
  }
  await saveGroupData();
  await saveBotSettings();
  const modeLine = mode ? `\n\U0001F3AD *Mode:* ${mode.toUpperCase()}${mode === 'del' ? ' \u2014 offending messages are deleted' : ' \u2014 members are warned only'}` : '';
  const extra = command === '!antidelete' ? `\n\U0001F4E5 Deleted messages in your private chats are also recovered here.` : '';
  await sock.sendMessage(jid, { text: [
    `${value ? '\U0001F7E2' : '\U0001F534'} *${meta.label} \u2014 ${value ? 'ENABLED' : 'DISABLED'}*`,
    '\u25C8\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u25C8',
    '',
    `\U0001F4C2 *Applied to:* ${updated} group(s), plus every group Nancy joins later`,
    `${modeLine}${extra}`,
    '',
    `_Changed from your personal chat, so it covers all groups at once. Use ${prefix}${command.slice(1)} inside one group to override it there._`
  ].filter(Boolean).join('\n') }, { quoted: msg });
  return true;
}

// ── Error classification: every failure becomes one clear, actionable message ──
function aiFriendlyError(provider, error) {
  const label = provider?.label || 'AI provider';
  const envKey = provider?.envKey || 'API_KEY';
  const raw = String(error?.message || error || 'Unknown error');
  const status = Number(error?.status) || 0;
  if (/missing API key|no api key|not configured|API_KEY_MISSING/i.test(raw)) {
    return `⚙️ *${label.toUpperCase()} NOT CONFIGURED*\n\nAdd *${envKey}* to your .env file, save it, then restart the bot.\n🔑 Free key: ${provider?.signupUrl || 'provider dashboard'}`;
  }
  if (/invalid api key|incorrect api key|invalid_api_key|api key not valid|API_KEY_INVALID|unauthorized|401/i.test(raw) || status === 401) {
    return `🔑 *${label.toUpperCase()} — INVALID KEY*\n\nThe key in *${envKey}* was rejected.\n• Check for a typo or extra space/quotes\n• The key may have been revoked or deleted\n\nGet a fresh key: ${provider?.signupUrl || 'provider dashboard'}\nThen update *${envKey}* in .env and restart.`;
  }
  if (/permission|forbidden|not authorized|403/i.test(raw) || status === 403) {
    return `🚫 *${label.toUpperCase()} — ACCESS DENIED (403)*\n\nYour key is valid but may not have access to *${provider?.model() || 'this model'}*.\nChange *${provider?.envModel || 'the model variable'}* in .env to a model your key can use.`;
  }
  if (/insufficient_quota|quota exceeded|exceeded your current quota|no credits remaining|billing|credit balance|payment required|402/i.test(raw) || status === 402) {
    return `💳 *${label.toUpperCase()} — FREE QUOTA USED UP*\n\nYour key is valid; this is a limit, not a fault.\n• Free tiers reset daily/monthly, so it works again later\n• Or switch to another provider: ${getCommandPrefix(global.__nancySock || {})}grok · ${getCommandPrefix(global.__nancySock || {})}gemini · ${getCommandPrefix(global.__nancySock || {})}openrouter`;
  }
  if (/per-day|free-models-per-day|daily limit|requests per day|RPD/i.test(raw)) {
    const prefix = getCommandPrefix(global.__nancySock || {});
    return `🌙 *${label.toUpperCase()} — DAILY FREE LIMIT REACHED*

The free-model allowance for today is finished. It resets at midnight UTC.

Keep working meanwhile with: ${prefix}grok · ${prefix}gemini`;
  }
  if (/rate.?limit|too many requests|429|RESOURCE_EXHAUSTED/i.test(raw) || status === 429) {
    return `⏳ *${label.toUpperCase()} — RATE LIMITED*

You sent requests very quickly, so this one was held back.
It is not a key or model problem.

• Wait ~30–60 seconds and try again
• Or keep chatting with another engine meanwhile`;
  }
  if (/model.*not.*found|no such model|unknown model|does not exist|models\/|404/i.test(raw) || status === 404) {
    return `🧩 *${label.toUpperCase()} — UNKNOWN MODEL*\n\n*${provider?.model() || 'configured model'}* is not available to your key.\nSet a valid model in *${provider?.envModel || 'the model variable'}*, then restart.`;
  }
  if (/timeout|timed out|aborted|ETIMEDOUT|network|fetch failed|fetch is not defined|ENOTFOUND|ECONNRESET|EAI_AGAIN|socket hang up|ECONNREFUSED|status 5\d\d|HTTP 5\d\d/i.test(raw)) {
    return `📡 *${label.toUpperCase()} — NETWORK PROBLEM*\n\nThe provider could not be reached in time. This is usually temporary.\nTry again in a moment, or use a different AI command.`;
  }
  if (/internal server error|bad gateway|service unavailable|overloaded|HTTP 5\d\d|status 5\d\d|\b5\d\d\b/i.test(raw) || (status >= 500 && status < 600)) {
    return `🛠️ *${label.toUpperCase()} — SERVER PROBLEM*

The provider had a temporary outage. Wait a minute and retry, or use another AI command.`;
  }
  if (/empty response|returned nothing|no text/i.test(raw)) {
    return `🤔 *${label.toUpperCase()} RETURNED NOTHING*\n\nTry rephrasing your question, or ask something shorter.`;
  }
  return `⚠️ *${label.toUpperCase()} ERROR*\n${raw.slice(0, 400)}`;
}

class AiProviderError extends Error {
  constructor(message, { provider = null, status = 0 } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.provider = provider;
    this.status = status;
  }
}

// ── Conversation context: per chat, per provider, in memory, auto-expiring ──
const aiConversations = new Map();
function conversationKey(chatId, providerKey) { return `${providerKey}:${String(chatId || 'unknown')}`; }
function getConversation(chatId, providerKey) {
  if (AI_CONTEXT_TURNS <= 0) return [];
  const key = conversationKey(chatId, providerKey);
  const entry = aiConversations.get(key);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > AI_CONTEXT_TTL_MS) { aiConversations.delete(key); return []; }
  return entry.turns.slice(-AI_CONTEXT_TURNS * 2);
}
function appendConversation(chatId, providerKey, userText, assistantText) {
  if (AI_CONTEXT_TURNS <= 0) return;
  const key = conversationKey(chatId, providerKey);
  const entry = aiConversations.get(key) || { turns: [], updatedAt: Date.now() };
  entry.turns.push({ role: 'user', content: String(userText || '').slice(0, 4000) });
  entry.turns.push({ role: 'assistant', content: String(assistantText || '').slice(0, 4000) });
  entry.turns = entry.turns.slice(-AI_CONTEXT_TURNS * 2);
  let total = entry.turns.reduce((sum, t) => sum + t.content.length, 0);
  while (total > AI_MAX_HISTORY_CHARS && entry.turns.length > 2) total -= entry.turns.shift().content.length;
  entry.updatedAt = Date.now();
  aiConversations.set(key, entry);
  if (aiConversations.size > 400) {
    const oldest = [...aiConversations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) aiConversations.delete(oldest[0]);
  }
}
function clearConversation(chatId, providerKey = null) {
  if (providerKey) { aiConversations.delete(conversationKey(chatId, providerKey)); return; }
  for (const key of [...aiConversations.keys()]) {
    if (key.endsWith(`:${String(chatId || 'unknown')}`)) aiConversations.delete(key);
  }
}
function conversationTurns(chatId, providerKey) { return getConversation(chatId, providerKey).length; }

// ── HTTP helpers ──
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (timer.unref) timer.unref();
  return controller.signal;
}
async function readJsonSafe(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { __raw: text.slice(0, 500) }; }
}
// Providers answer 429 when you knock too fast. One short, patient retry turns a
// confusing red error into a normal reply. Any Retry-After header is respected.
async function fetchWithRetry(url, options) {
  const first = await fetch(url, options);
  if (first.status !== 429) return first;
  let body = '';
  try { body = await first.clone().text(); } catch { body = ''; }
  // A per-DAY cap will not clear in a few seconds, so do not waste the wait.
  if (/per-day|free-models-per-day|daily limit|requests per day/i.test(body)) return first;
  const header = first.headers && first.headers.get ? first.headers.get('retry-after') : null;
  const hinted = Number.parseInt(String(header || ''), 10);
  const waitMs = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted * 1000, 15000) : 4000;
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return fetch(url, options);
}

function extractProviderMessage(data, fallback) {
  return String(
    data?.error?.message ||
    data?.error?.status ||
    (Array.isArray(data?.error) ? data.error[0]?.message : '') ||
    data?.message ||
    (data && data.__raw ? data.__raw : '') ||
    fallback || ''
  ).trim();
}

// ── Provider 1: GroqCloud (OpenAI-compatible chat completions) ──
async function callGroq(provider, messages) {
  const response = await fetchWithRetry(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${provider.apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.model(), messages, temperature: 0.7, max_tokens: 1400 }),
    signal: timeoutSignal(AI_PROVIDER_TIMEOUT_MS)
  });
  const data = await readJsonSafe(response);
  if (!response.ok) throw new AiProviderError(extractProviderMessage(data, `Groq request failed (HTTP ${response.status}).`), { provider, status: response.status });
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new AiProviderError('Groq returned an empty response.', { provider });
  return String(text).trim();
}

// ── Provider 2: Google Gemini (native generateContent API) ──
async function callGemini(provider, messages) {
  const systemInstruction = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));
  const body = {
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1400 }
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(provider.model())}:generateContent`;
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': provider.apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(AI_PROVIDER_TIMEOUT_MS)
  });
  const data = await readJsonSafe(response);
  if (!response.ok) throw new AiProviderError(extractProviderMessage(data, `Gemini request failed (HTTP ${response.status}).`), { provider, status: response.status });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p?.text || '').join('').trim();
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new AiProviderError(blockReason ? `Gemini could not answer (${blockReason}). Try rephrasing.` : 'Gemini returned an empty response.', { provider });
  }
  return text;
}

// ── Provider 3: OpenRouter (OpenAI-compatible chat completions) ──
async function callOpenRouter(provider, messages) {
  const response = await fetchWithRetry(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': OPENROUTER_SITE_URL,
      'X-Title': 'Nancy Nova AI'
    },
    body: JSON.stringify({ model: provider.model(), messages, temperature: 0.7, max_tokens: 1400 }),
    signal: timeoutSignal(AI_PROVIDER_TIMEOUT_MS)
  });
  const data = await readJsonSafe(response);
  if (!response.ok) throw new AiProviderError(extractProviderMessage(data, `OpenRouter request failed (HTTP ${response.status}).`), { provider, status: response.status });
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new AiProviderError('OpenRouter returned an empty response.', { provider });
  return String(text).trim();
}

const PROVIDER_CALLERS = { groq: callGroq, gemini: callGemini, openrouter: callOpenRouter };

// ── Ask ONE provider (strictly independent) ──
async function askProvider(providerName, prompt, options = {}) {
  const provider = resolveProvider(providerName);
  if (!provider) throw new AiProviderError(`Unknown AI provider: ${providerName}`);
  if (!providerConfigured(provider)) {
    throw new AiProviderError(aiFriendlyError(provider, new Error('missing API key')), { provider });
  }
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new AiProviderError(aiFriendlyError(provider, new Error('Please send some text after the command.')), { provider });

  const useContext = options.withContext !== false && AI_CONTEXT_TURNS > 0;
  const history = useContext
    ? (Array.isArray(options.history) ? options.history : getConversation(options.chatId, provider.key))
    : [];
  const messages = [];
  const systemPrompt = String(options.systemPrompt ?? nancySystemPrompt()).trim();
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const turn of history) messages.push({ role: turn.role, content: turn.content });
  messages.push({ role: 'user', content: cleanPrompt.slice(0, 8000) });

  try {
    const answer = await PROVIDER_CALLERS[provider.key](provider, messages);
    if (useContext) appendConversation(options.chatId, provider.key, cleanPrompt, answer);
    return { text: answer, provider: provider.key, label: provider.label };
  } catch (error) {
    const friendly = new AiProviderError(aiFriendlyError(provider, error), { provider, status: error?.status || 0 });
    friendly.rawMessage = String(error?.message || error || '');
    throw friendly;
  }
}

// ── Ask ANY configured provider with automatic failover ──
async function askAnyProvider(prompt, options = {}) {
  const preferred = resolveProvider(options.prefer || AI_DEFAULT_PROVIDER);
  const ordered = [
    ...(preferred && providerConfigured(preferred) ? [preferred] : []),
    ...configuredProviders().filter(p => !preferred || p.key !== preferred.key)
  ];
  if (!ordered.length) {
    throw new AiProviderError(
      `⚙️ *NO AI PROVIDER CONFIGURED*\n\nAdd at least one key to your .env file, then restart:\n\n⚡ *GROQ_API_KEY* — free, fastest\n   console.groq.com/keys\n🌟 *GEMINI_API_KEY* — free tier\n   aistudio.google.com/apikey\n🔀 *OPENROUTER_API_KEY* — free models\n   openrouter.ai/keys`
    );
  }
  const tried = [];
  for (const provider of ordered) {
    try {
      const result = await askProvider(provider.key, prompt, options);
      return { ...result, tried };
    } catch (error) {
      tried.push({ provider: provider.label, error: error.message });
    }
  }
  const summary = tried.map(t => `▸ *${t.provider}*\n${t.error}`).join('\n\n');
  throw new AiProviderError(`⚠️ *ALL AI PROVIDERS FAILED*\n\n${summary}`);
}

// ── Status + live test ──
function aiProviderStatus() {
  return AI_PROVIDER_ORDER.map(key => {
    const provider = AI_PROVIDERS[key];
    const configured = providerConfigured(provider);
    return {
      key, label: provider.label, emoji: provider.emoji, command: provider.command,
      configured, keyPreview: maskKey(provider.apiKey()), model: provider.model(),
      envKey: provider.envKey, envModel: provider.envModel
    };
  });
}
async function testProvider(providerName) {
  const provider = resolveProvider(providerName);
  if (!provider) return { ok: false, provider: String(providerName), error: 'Unknown provider.' };
  if (!providerConfigured(provider)) {
    return { ok: false, provider: provider.label, error: `No key set. Add ${provider.envKey} to .env and restart.` };
  }
  const started = Date.now();
  try {
    const reply = await askProvider(provider.key, 'Reply with the single word: OK', { withContext: false });
    return { ok: true, provider: provider.label, ms: Date.now() - started, sample: reply.text.slice(0, 60) };
  } catch (error) {
    const raw = String(error?.rawMessage || '').replace(/\s+/g, ' ').trim();
    return { ok: false, provider: provider.label, error: error.message, raw, ms: Date.now() - started };
  }
}

// ── Shared dispatcher for !grok / !gemini / !openrouter ──
async function sendProviderChat(sock, msg, jid, command, argument) {
  const provider = resolveProvider(command) || AI_PROVIDERS.groq;
  const prefix = getCommandPrefix(sock);
  const say = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  const sub = String(argument || '').trim();
  const lower = sub.toLowerCase();

  // Sub-commands that manage this provider's context.
  if (lower === 'clear' || lower === 'reset' || lower === 'new') {
    clearConversation(jid, provider.key);
    return say(`🧹 *${provider.label.toUpperCase()} — CONTEXT CLEARED*\nThis chat now starts a fresh conversation with ${provider.label}.`);
  }
  if (lower === 'status' || lower === 'info') {
    const turns = conversationTurns(jid, provider.key);
    return say([
      `${provider.emoji} *${provider.label.toUpperCase()}*`,
      '◈━━━━━━━━━━━━━━━━━━◈',
      `🔑 Key: ${providerConfigured(provider) ? 'CONFIGURED (' + maskKey(provider.apiKey()) + ')' : 'NOT SET'}`,
      `🧠 Model: ${provider.model()}`,
      `💬 Context: ${turns ? Math.floor(turns / 2) + ' messages remembered' : 'empty'}`,
      `⌨️ Command: ${prefix}${provider.command.slice(1)}`,
      '',
      `_${AI_CONTEXT_TURNS} turns of memory, resets after ${Math.round(AI_CONTEXT_TTL_MS / 60000)} min idle._`
    ].join('\n'));
  }
  if (lower === 'test' || lower === 'ping') {
    await say(`🧪 Testing ${provider.label}…`);
    const result = await testProvider(provider.key);
    return say(result.ok
      ? `✅ *${result.provider} IS WORKING*\n⚡ Response in ${result.ms} ms\n📨 Reply: "${result.sample}"`
      : `❌ *${result.provider} FAILED*\n\n${result.error}`);
  }
  if (!sub) {
    const others = AI_PROVIDER_ORDER.map(k => AI_PROVIDERS[k]).filter(p => p.key !== provider.key)
      .map(p => `${prefix}${p.command.slice(1)}`).join(' · ');
    return say([
      `${provider.emoji} *${provider.label.toUpperCase()}*`,
      `🔑 Key: ${providerConfigured(provider) ? 'ready' : 'NOT configured'}`,
      `🧠 Model: ${provider.model()}`,
      '',
      `Ask anything: *${prefix}${provider.command.slice(1)} your question*`,
      '',
      `▸ ${prefix}${provider.command.slice(1)} clear — forget this chat's history`,
      `▸ ${prefix}${provider.command.slice(1)} status — key + context info`,
      `▸ ${prefix}${provider.command.slice(1)} test — live connection check`,
      '',
      `_Other providers: ${others}_`
    ].join('\n'));
  }

  if (providerConfigured(provider) === false) {
    throw new Error(`⚙️ *${provider.label.toUpperCase()} NOT CONFIGURED*\n\nAdd *${provider.envKey}* to your .env, save it, then restart the bot.\n🔑 Free key: ${provider.signupUrl}\n\n_Meanwhile these work if configured: ${prefix}grok · ${prefix}gemini · ${prefix}openrouter_`);
  }

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await say(`${provider.emoji} *${provider.label}* is thinking…`);
  try {
    const result = await askProvider(provider.key, sub, { chatId: jid });
    const turns = conversationTurns(jid, provider.key);
    await sock.sendMessage(jid, {
      text: `${result.text.slice(0, 5500)}\n\n_${provider.emoji} ${provider.label} · ${provider.model()}${turns ? ' · memory on' : ''}_`
    }, { quoted: msg });
    return result.text;
  } finally {
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
}

async function fetchAnimeImageBuffer(command, searchTerm = '') {
  // Keyless, SFW anime image retrieval. No API keys and no image-generation
  // billing: pulls a random picture from free public endpoints and downloads
  // the raw bytes so WhatsApp receives an actual image buffer.
  const map = {
    '!neko':    { nb: 'neko',     wp: 'neko' },
    '!hneko':   { nb: 'neko',     wp: 'neko' },
    '!hwaifu':  { nb: 'waifu',    wp: 'waifu' },
    '!konachan':{ nb: 'kitsune',  wp: 'waifu' },
    '!shorta':  { nb: 'waifu',    wp: 'megumin' },
    '!husby':   { nb: 'husbando', wp: 'waifu' }
  };
  const pick = map[command] || { nb: 'neko', wp: 'neko' };
  const ua = { 'User-Agent': 'Mozilla/5.0 NancyNovaAI' };
  const providers = [
    async () => {
      const r = await fetch(`https://nekos.best/api/v2/${pick.nb}`, { headers: ua, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`nekos.best HTTP ${r.status}`);
      const j = await r.json();
      const url = j?.results?.[0]?.url;
      if (!url) throw new Error('nekos.best returned no image URL.');
      return url;
    },
    async () => {
      const r = await fetch(`https://api.waifu.pics/sfw/${pick.wp}`, { headers: ua, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`waifu.pics HTTP ${r.status}`);
      const j = await r.json();
      const url = j?.url;
      if (!url) throw new Error('waifu.pics returned no image URL.');
      return url;
    }
  ];
  let lastError;
  for (const provider of providers) {
    try {
      const url = await provider();
      const imageRes = await fetch(url, { headers: ua, signal: AbortSignal.timeout(20000) });
      if (!imageRes.ok) throw new Error(`Image download HTTP ${imageRes.status}`);
      const buffer = Buffer.from(await imageRes.arrayBuffer());
      if (!buffer.length) throw new Error('Downloaded image was empty.');
      return buffer;
    } catch (error) { lastError = error; }
  }
  throw new Error(`Anime image sources are unreachable right now (${lastError?.message || 'unknown error'}). Please try again in a moment.`);
}

async function lookupApkDownload(appName) {
  // Primary source: Aptoide's keyless public API, which returns a real, direct
  // .apk download URL (file.path). Fallback: F-Droid for open-source apps.
  const term = appName.trim();
  const query = encodeURIComponent(term);
  // 1) Aptoide keyless search API -> direct .apk URL.
  try {
    const response = await fetch(`https://ws75.aptoide.com/api/7/apps/search?query=${query}&limit=5`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' },
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      const list = data?.datalist?.list || [];
      if (list.length) {
        const wanted = term.toLowerCase();
        const best = list.find(a => (a?.name || '').toLowerCase() === wanted)
          || list.find(a => (a?.name || '').toLowerCase().includes(wanted))
          || list[0];
        const path = best?.file?.path || best?.file?.path_alt;
        if (path && /\.apk(\?|$)/i.test(path)) {
          return {
            title: best?.name || appName,
            url: path,
            page: `https://en.aptoide.com/search?query=${query}`,
            source: 'Aptoide',
            direct: true
          };
        }
      }
    }
  } catch {}
  // 2) F-Droid fallback for open-source apps.
  try {
    const response = await fetch(`https://f-droid.org/en/packages/?q=${query}`, { headers: { 'User-Agent': 'Mozilla/5.0 DevBrianAI' }, signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const html = await response.text();
      const matches = [...html.matchAll(/href="(?:https:\/\/f-droid\.org)?\/packages\/([A-Za-z0-9_.]+)\/?"/g)];
      const pkg = matches.map(m => m[1]).find(x => x && !['packages'].includes(x));
      if (pkg) {
        const detailRes = await fetch(`https://f-droid.org/packages/${pkg}/`, { headers: { 'User-Agent': 'Mozilla/5.0 DevBrianAI' }, signal: AbortSignal.timeout(12000) });
        if (detailRes.ok) {
          const detail = await detailRes.text();
          const apk = detail.match(/href="(https:\/\/f-droid\.org\/repo\/[^"]+\.apk)"/i)?.[1] || detail.match(/href="(\/repo\/[^"]+\.apk)"/i)?.[1];
          if (apk) return { title: appName, url: apk.startsWith('http') ? apk : `https://f-droid.org${apk}`, source: 'F-Droid', direct: true };
        }
      }
    }
  } catch {}
  return { title: appName, url: `https://en.aptoide.com/search?query=${query}`, page: `https://play.google.com/store/search?q=${query}&c=apps`, source: 'search', direct: false };
}

// ---------------------------------------------------------------------------
// FREE IMAGE ENGINE (no paid key needed)
// Images are rendered by a keyless, free provider. There is no paid image path.
// ---------------------------------------------------------------------------
const FREE_IMAGE_PROVIDERS = (() => {
  const list = [];
  const custom = String(process.env.IMAGE_PROVIDER_URL || '').trim();
  if (custom) list.push({ name: 'custom', build: p => custom.replace('{prompt}', encodeURIComponent(p)) });
  // Pollinations: free, keyless, no signup. Free tier allows 1 image / 45s per
  // IP, so it is retried once after its own cooldown instead of failing.
  list.push({
    name: 'pollinations',
    retryAfterMs: 46000,
    build: (p, { w, h, seed }) => `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&seed=${seed}&nologo=true&enhance=true&private=true`
  });
  // a0.dev asset endpoint: free, keyless, square/portrait/landscape images.
  list.push({
    name: 'a0',
    build: (p, { w, h }) => 'https://api.a0.dev/assets/image?text=' + encodeURIComponent(p) + '&aspect=' + (h > w ? '9:16' : w > h ? '16:9' : '1:1')
  });
  return list;
})();
const FREE_IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 110000);

function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 500) return false;
  const b = Buffer.from(buf);
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;                  // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;  // PNG
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
}

// Strip things that confuse free prompt-to-image endpoints.
function cleanImagePrompt(prompt) {
  return String(prompt || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

async function tryImageProvider(provider, prompt, { w, h, seed }) {
  const url = provider.build(prompt, { w, h, seed });
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36', 'Accept': 'image/*,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FREE_IMAGE_TIMEOUT_MS)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const body = buffer.toString('utf8').slice(0, 200);
    const limited = response.status === 402 || response.status === 429 || /FREE_LIMIT|limit/i.test(body);
    const error = new Error(limited ? 'rate limited by the provider' : `HTTP ${response.status}`);
    error.rateLimited = limited;
    throw error;
  }
  if (!looksLikeImageBuffer(buffer)) throw new Error('provider returned no image data');
  return buffer;
}

async function fetchFreeImageBuffer(prompt, { variant = 0, size = '1024x1024' } = {}) {
  const clean = cleanImagePrompt(prompt);
  if (!clean) throw new Error('Describe the image you want.');
  const [w, h] = String(size).split('x').map(n => Number(n) || 1024);
  const fullPrompt = variant === 1 ? `${clean}, alternative artistic interpretation, different composition` : clean;
  const errors = [];
  const delayed = [];
  for (const provider of FREE_IMAGE_PROVIDERS) {
    const seed = Math.floor(Math.random() * 1000000) + variant * 7919;
    try {
      const buffer = await tryImageProvider(provider, fullPrompt, { w, h, seed });
      stats.imagesGenerated = Number(stats.imagesGenerated || 0) + 1;
      return buffer;
    } catch (error) {
      errors.push(`${provider.name}: ${error.message}`);
      if (error.rateLimited && provider.retryAfterMs) delayed.push({ provider, wait: provider.retryAfterMs });
      continue;
    }
  }
  // Everything was rate limited (free tiers are shared per IP): wait out the
  // cooldown of the first limited provider and try it once more.
  for (const { provider, wait } of delayed) {
    await new Promise(resolve => setTimeout(resolve, wait));
    try {
      const seed = Math.floor(Math.random() * 1000000) + variant * 7919;
      const buffer = await tryImageProvider(provider, fullPrompt, { w, h, seed });
      stats.imagesGenerated = Number(stats.imagesGenerated || 0) + 1;
      return buffer;
    } catch (error) {
      errors.push(`${provider.name} (retry): ${error.message}`);
    }
  }
  throw new Error(`Free image engine unavailable right now (${errors.join(' | ')}). Please try again in a moment.`);
}

// ---------------------------------------------------------------------------
// TEXT-EFFECT / POSTER ENGINE (real text, not AI "drawing" letters)
// Old behaviour: the style commands asked an image model to draw words, so the
// result was an unrelated picture and the user's text was often missing or
// misspelled. New behaviour: the wording is rendered locally with a real font
// on a themed background, correctly spelled and always on top.
// ---------------------------------------------------------------------------
const POSTER_STYLES = {
  flagtext:    { bg: ['#0b1220', '#1b2b4a'], accent: '#ffffff', text: '#ffffff', glow: '#4da3ff', top: 'FLAG TEXT', sub: 'NATIONAL PRIDE', flag: true },
  matrixfx:    { bg: ['#000000', '#001a0b'], accent: '#39ff88', text: '#8dffbf', glow: '#39ff88', top: 'MATRIX', sub: 'FOLLOW THE WHITE RABBIT', rain: true },
  neon:        { bg: ['#08060f', '#160a24'], accent: '#ff3df0', text: '#ffffff', glow: '#ff3df0', top: 'NEON', sub: 'GLOW EDITION' },
  fire:        { bg: ['#1a0500', '#3d0c00'], accent: '#ff8a00', text: '#fff1c9', glow: '#ff5a00', top: 'FIRE', sub: 'BURNING TEXT' },
  devil:       { bg: ['#120003', '#2b0008'], accent: '#ff2b48', text: '#ffd7dd', glow: '#ff2b48', top: 'DEVIL', sub: 'INFERNO EDITION' },
  hacker:      { bg: ['#000000', '#031408'], accent: '#22d37a', text: '#b6ffd4', glow: '#22d37a', top: 'HACKER', sub: 'TERMINAL ACCESS', rain: true },
  ice:         { bg: ['#04121f', '#0d3350'], accent: '#7de8ff', text: '#eaffff', glow: '#7de8ff', top: 'ICE', sub: 'FROST EDITION' },
  snow:        { bg: ['#0a1622', '#1e3a52'], accent: '#d9f4ff', text: '#ffffff', glow: '#bfe9ff', top: 'SNOW', sub: 'WINTER EDITION', stars: true },
  impressive:  { bg: ['#0a0a12', '#22203a'], accent: '#ffd166', text: '#ffffff', glow: '#ffd166', top: 'IMPRESSIVE', sub: 'CINEMATIC' },
  nancy:       { bg: ['#140818', '#3b1033'], accent: '#ffb3e6', text: '#ffffff', glow: '#ff8ad4', top: 'NANCY NOVA', sub: 'SIGNATURE' },
  leaves:      { bg: ['#06140c', '#123a20'], accent: '#8ff0a4', text: '#eafff0', glow: '#8ff0a4', top: 'LEAVES', sub: 'BOTANICAL' },
  blackpink:   { bg: ['#000000', '#240016'], accent: '#ff2d87', text: '#ffffff', glow: '#ff2d87', top: 'BLACKPINK', sub: 'POP EDITION' },
  blckpinkstyle:{ bg: ['#0a0008', '#2a0018'], accent: '#ff2d87', text: '#ffe3f1', glow: '#ff2d87', top: 'BLACK & PINK', sub: 'GLAM STYLE' },
  devbrn:      { bg: ['#050a18', '#0d1b3a'], accent: '#6ea8ff', text: '#ffffff', glow: '#6ea8ff', top: 'DEV BRN', sub: 'PERSONAL BRAND' },
  dragonball:  { bg: ['#2a0d00', '#5c2200'], accent: '#ffc300', text: '#fffbe6', glow: '#ffb000', top: 'DRAGON BALL', sub: 'POWER EDITION' },
  typography:  { bg: ['#101014', '#26262e'], accent: '#f2f2f2', text: '#ffffff', glow: '#9aa0ff', top: 'TYPOGRAPHY', sub: 'TYPE STUDY' },
  royaltext:   { bg: ['#140a1e', '#3a1b52'], accent: '#f5d27a', text: '#ffeec2', glow: '#f5d27a', top: 'ROYAL', sub: 'GOLD EDITION' },
  royal:       { bg: ['#150a22', '#3d1657'], accent: '#f5d27a', text: '#fff0cc', glow: '#f5d27a', top: 'ROYAL', sub: 'CROWN EDITION' },
  graffiti:    { bg: ['#141414', '#2b2b2b'], accent: '#ff5f1f', text: '#fff7e6', glow: '#ff5f1f', top: 'GRAFFITI', sub: 'STREET ART' },
  galaxywallpaper:{ bg: ['#04030f', '#160a3a'], accent: '#b18cff', text: '#ffffff', glow: '#b18cff', top: 'GALAXY', sub: 'STARFIELD', stars: true },
  pixelglitch: { bg: ['#08040f', '#1d0730'], accent: '#00e5ff', text: '#ffffff', glow: '#00e5ff', top: 'GLITCH', sub: 'PIXEL EDITION' },
  cartoonstyle:{ bg: ['#0c1a2a', '#25476b'], accent: '#ffd166', text: '#ffffff', glow: '#ffd166', top: 'CARTOON', sub: 'TOON EDITION' },
  deadpool:    { bg: ['#150002', '#3a0008'], accent: '#ff2d2d', text: '#ffffff', glow: '#ff2d2d', top: 'MAXIMUM EFFORT', sub: 'RED & BLACK' },
  bear:        { bg: ['#14100a', '#332413'], accent: '#e0b780', text: '#fff4e2', glow: '#e0b780', top: 'BEAR', sub: 'WILD EDITION' }
};

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapPosterText(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) { lines.push(line); line = word; } else { line = candidate; }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

function buildPosterSvg(styleKey, rawText) {
  const S = POSTER_STYLES[styleKey] || POSTER_STYLES.typography;
  const text = String(rawText || '').trim() || S.top;
  const W = 1080, H = 1080;
  const lines = wrapPosterText(text.toUpperCase(), text.length > 26 ? 14 : 18);
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
  let fontSize = Math.max(56, Math.min(190, Math.floor((W * 0.9) / Math.max(longest, 5)) * 1.25));
  if (lines.length > 2) fontSize = Math.min(fontSize, 110);
  if (lines.length > 3) fontSize = Math.min(fontSize, 88);
  const lineHeight = fontSize * 1.18;
  const blockHeight = lines.length * lineHeight;
  const startY = H / 2 - blockHeight / 2 + fontSize * 0.82;

  const decor = [];
  if (S.stars) {
    for (let i = 0; i < 90; i++) {
      const x = (i * 397.3) % W, y = (i * 211.7) % H;
      const r = (0.8 + ((i * 7) % 20) / 10).toFixed(1);
      const opacity = (0.15 + ((i * 13) % 60) / 100).toFixed(2);
      decor.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r}" fill="${S.accent}" opacity="${opacity}"/>`);
    }
  }
  if (S.rain) {
    for (let c = 0; c < 26; c++) {
      let column = '';
      for (let k = 0; k < 26; k++) {
        const opacity = Math.max(0.06, 0.7 - k * 0.026).toFixed(2);
        column += `<text x="${c * 42 + 10}" y="${k * 40 - 20}" font-family="monospace" font-size="26" fill="${S.accent}" opacity="${opacity}">${'01'[(c * 7 + k * 3) % 2]}</text>`;
      }
      decor.push(column);
    }
  }

  const textNodes = lines.map((line, index) => {
    const y = startY + index * lineHeight;
    return `<text x="${W / 2}" y="${y.toFixed(0)}" text-anchor="middle" font-family="DejaVu Sans, Arial Black, Arial, sans-serif" font-weight="bold" font-size="${fontSize.toFixed(0)}" fill="${S.text}" stroke="${S.glow}" stroke-width="3" filter="url(#glow)" letter-spacing="2">${escapeXml(line)}</text>`;
  }).join('');

  const flagBar = S.flag
    ? `<g opacity="0.95"><rect x="0" y="0" width="${W}" height="14" fill="#111"/><rect x="0" y="0" width="${W}" height="7" fill="#c8102e"/><rect x="0" y="${H - 14}" width="${W}" height="14" fill="#111"/><rect x="0" y="${H - 7}" width="${W}" height="7" fill="#c8102e"/><rect x="0" y="0" width="14" height="${H}" fill="#111"/><rect x="${W - 14}" y="0" width="14" height="${H}" fill="#111"/></g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0%" stop-color="${S.bg[0]}"/><stop offset="100%" stop-color="${S.bg[1]}"/></linearGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="62%"><stop offset="0%" stop-color="${S.glow}" stop-opacity="0.42"/><stop offset="70%" stop-color="${S.glow}" stop-opacity="0.06"/><stop offset="100%" stop-color="${S.glow}" stop-opacity="0"/></radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="${W / 2}" cy="${H / 2}" rx="${W * 0.55}" ry="${H * 0.42}" fill="url(#halo)"/>
  ${flagBar}
  ${decor.join('')}
  <rect x="54" y="54" width="${W - 108}" height="${H - 108}" fill="none" stroke="${S.accent}" stroke-opacity="0.45" stroke-width="2" rx="18"/>
  <text x="${W / 2}" y="${(startY - blockHeight / 2 - 78).toFixed(0)}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" font-weight="bold" fill="${S.accent}" letter-spacing="10" opacity="0.9">${escapeXml(S.top)}</text>
  ${textNodes}
  <text x="${W / 2}" y="${(startY + blockHeight - lineHeight + 96).toFixed(0)}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="${S.accent}" letter-spacing="8" opacity="0.85">${escapeXml(S.sub)}</text>
  <text x="${W / 2}" y="${H - 76}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#ffffff" opacity="0.5" letter-spacing="3">NANCY NOVA AI • TEAM NASA</text>
</svg>`;
}

async function renderTextPoster(styleKey, text) {
  const svg = buildPosterSvg(styleKey, text);
  try {
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (error) {
    throw new Error(`Poster renderer failed (${error.message}).`);
  }
}

async function generateFreeImage(prompt, variant = 0) {
  // 1) Free keyless provider (works on every host, no billing).
  try {
    return await fetchFreeImageBuffer(prompt, { variant });
  } catch (freeError) {
    // No paid image fallback: the free keyless engines are the only image path.
    throw freeError;
  }
}

function photoLabFriendlyError(error) {
  const message = String(error?.message || error || 'Unknown image error');
  if (/quota|billing|insufficient_quota/i.test(message)) return `Image provider quota/billing limit reached. ${message}`;
  if (/rate.?limit|HTTP 429|too many requests/i.test(message)) return `Image provider is busy right now. Please try again in a minute. (${message})`;
  if (/timed out|timeout|aborted/i.test(message)) return `Image generation timed out. Please try again later. (${message})`;
  if (/unavailable right now/i.test(message)) return message;
  return message.slice(0, 700);
}

async function generatePhotoLabImages(prompt, count = PHOTO_LAB_IMAGE_COUNT) {
  const total = Math.max(1, Math.min(2, Number(count) || 1));
  const images = [];
  for (let i = 0; i < total; i++) {
    try {
      const buffer = await generateFreeImage(prompt, i === 1 ? 1 : 0);
      images.push(buffer);
    } catch (error) {
      // Keep whatever succeeded; only surface the error if nothing was produced.
      if (!images.length) throw error;
      break;
    }
  }
  return images;
}

async function sendPhotoLabImages(sock, jid, msg, prompt, captionTitle, count = PHOTO_LAB_IMAGE_COUNT) {
  const key = String(jid || 'unknown');
  if (photoLabActiveChats.has(key)) throw new Error('A PhotoLab request is already running in this chat. Please wait for it to finish.');
  const last = photoLabCooldowns.get(key) || 0;
  const remaining = PHOTO_LAB_COOLDOWN_MS - (Date.now() - last);
  if (remaining > 0) throw new Error(`PhotoLab cooldown: wait ${Math.ceil(remaining / 1000)} seconds before starting another image request.`);
  photoLabActiveChats.add(key);
  photoLabCooldowns.set(key, Date.now());
  try {
    const images = await generatePhotoLabImages(prompt, count);
    for (let i = 0; i < images.length; i++) {
      const variant = images.length > 1 ? `\n🖼️ Choice ${i + 1}/${images.length}` : '';
      await sock.sendMessage(jid, { image: images[i], caption: `🎨 *${captionTitle}*${variant}\n📝 ${String(prompt).slice(0, 800)}\n🧠 Powered by the free AI image engine (no paid key needed)\n🛰️ ${TEAM_NAME}` }, { quoted: msg });
    }
    if (images.length < Math.max(1, Math.min(2, Number(count) || 1))) {
      await sock.sendMessage(jid, { text: `PhotoLab returned ${images.length} image because the provider became unavailable. The successful image was kept; no repeated retry was made.` }, { quoted: msg });
    }
    return images.length;
  } finally {
    photoLabActiveChats.delete(key);
  }
}


async function transcribeAudioBuffer(audioBuffer, filename = 'voice.ogg', mimeType = 'audio/ogg') {
  if (!audioBuffer?.length) throw new Error('No audio data was received.');
  await mkdir(TEMP_DIR, { recursive: true });
  if (WHISPER_CPP_PATH && WHISPER_MODEL_PATH) {
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const input = path.join(TEMP_DIR, `speech-${id}${filename.toLowerCase().endsWith('.wav') ? '.wav' : '.audio'}`);
    const wav = path.join(TEMP_DIR, `speech-${id}.wav`);
    const outputPrefix = path.join(TEMP_DIR, `speech-${id}-transcript`);
    const transcriptFile = `${outputPrefix}.txt`;
    try {
      await writeFile(input, audioBuffer);
      if (!filename.toLowerCase().endsWith('.wav')) await execFileAsync((await resolveFfmpegBinary()) || process.env.FFMPEG_PATH || 'ffmpeg', ['-y','-i',input,'-ar','16000','-ac','1','-c:a','pcm_s16le',wav], { timeout: 120000, windowsHide: true });
      const wavInput = filename.toLowerCase().endsWith('.wav') ? input : wav;
      await execFileAsync(WHISPER_CPP_PATH, ['-m', WHISPER_MODEL_PATH, '-f', wavInput, '-otxt', '-of', outputPrefix, '-nt'], { timeout: 240000, windowsHide: true });
      const transcript = (await readFile(transcriptFile, 'utf8')).trim();
      if (!transcript) throw new Error('Whisper.cpp returned no text.');
      return transcript;
    } catch (error) {
      throw new Error(`Speech-to-text needs local Whisper.cpp. Set WHISPER_CPP_PATH, WHISPER_MODEL_PATH and FFmpeg in .env, then restart. Details: ${error.message}`);
    } finally {
      for (const file of [input,wav,transcriptFile]) await rm(file,{force:true}).catch(()=>{});
    }
  }
  throw new Error('Speech-to-text is not configured. Set WHISPER_CPP_PATH and WHISPER_MODEL_PATH in .env (plus FFmpeg) to transcribe voice notes offline.');
}

// Free, keyless Google Translate TTS (single request limited to ~190 chars, so
// long texts are split into chunks and stitched back into one MP3 file).
async function synthesizeSpeechGoogle(text, voice = 'en') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Provide text to speak.');
  const lang = /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(voice) ? voice.split('-')[0] : 'en';
  const chunks = [];
  let rest = clean.slice(0, 1200);
  while (rest.length) {
    let cut = rest.slice(0, 180);
    if (rest.length > 180) {
      const space = cut.lastIndexOf(' ');
      const stop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf(','), cut.lastIndexOf(';'));
      cut = rest.slice(0, stop > 60 ? stop + 1 : space > 40 ? space : 180);
    }
    chunks.push(cut.trim());
    rest = rest.slice(cut.length).trim();
  }
  const parts = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(chunk)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Referer': 'https://translate.google.com/' },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`TTS provider returned HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 400) throw new Error('TTS provider returned empty audio.');
    parts.push(buffer);
  }
  if (!parts.length) throw new Error('Nothing to speak.');
  return { buffer: Buffer.concat(parts), mimetype: 'audio/mpeg' };
}

async function synthesizeSpeech(text, voice = 'alloy') {
  const cleanText = String(text || '').trim().slice(0, 1200);
  if (!cleanText) throw new Error('Provide text to speak.');
  if (!(PIPER_PATH && PIPER_MODEL_PATH)) {
    // No local Piper installed -> use the free online voice so !tts always works.
    return synthesizeSpeechGoogle(cleanText, 'en');
  }
  await mkdir(TEMP_DIR, { recursive: true });
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const textFile = path.join(TEMP_DIR, `tts-${id}.txt`);
  const wavFile = path.join(TEMP_DIR, `tts-${id}.wav`);
  const mp3File = path.join(TEMP_DIR, `tts-${id}.mp3`);
  try {
    await writeFile(textFile, cleanText, 'utf8');
    await execFileAsync(PIPER_PATH, ['--model', PIPER_MODEL_PATH, '--input_file', textFile, '--output_file', wavFile], { timeout: 180000, windowsHide: true });
    // Send WAV directly if FFmpeg is not installed; WhatsApp supports audio payloads.
    try {
      await execFileAsync((await resolveFfmpegBinary()) || process.env.FFMPEG_PATH || 'ffmpeg', ['-y','-i',wavFile,'-codec:a','libmp3lame','-q:a','4',mp3File], { timeout: 120000, windowsHide: true });
      return { buffer: await readFile(mp3File), mimetype: 'audio/mpeg' };
    } catch {
      return { buffer: await readFile(wavFile), mimetype: 'audio/wav' };
    }
  } catch (error) {
    console.warn('Local Piper speech failed, using the free online voice:', error.message);
    try { return await synthesizeSpeechGoogle(cleanText, 'en'); } catch {}
    throw new Error(`Text-to-speech failed (${error.message}).`);
  } finally {
    for (const file of [textFile, wavFile, mp3File]) await rm(file, { force: true }).catch(() => {});
  }
}

async function getReplyMedia(sock, msg, allowed = ['imageMessage']) {
  const target = await findMediaTarget(sock, msg);
  if (!target) return null;
  const content = unwrapMessage(target.message);
  if (!allowed.some(key => content?.[key])) return null;
  const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  return { target, content, buffer };
}

async function handleAiText(sock, msg, jid, text) {
  if (!botSettings.aiEnabled || !text || text.startsWith(getCommandPrefix(sock)) || msg.key.fromMe) return false;
  if (aiCooldownActive(jid)) return true;
  aiCooldowns.set(jid, Date.now() + AI_COOLDOWN_MS);
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const { text: answer } = await askAnyProvider(text, { chatId: jid });
    await sock.sendMessage(jid, { text: `🤖 ${answer}` }, { quoted: msg });
  } catch (error) {
    await sock.sendMessage(jid, { text: `⚠️ AI could not answer right now: ${error.message}` }, { quoted: msg }).catch(() => {});
  } finally {
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }
  return true;
}

async function setProfilePictureFromMedia(sock, msg, targetJid) {
  const target = await findMediaTarget(sock, msg);
  if (!target) throw new Error('Attach an image or reply to an image, then use !setpp (or !setpic).');
  const content = unwrapMessage(target.message);
  if (!content.imageMessage) throw new Error('The replied media is not an image. Reply to a photo, then use !setpp or !setpic.');
  if (!targetJid || typeof targetJid !== 'string') throw new Error('WhatsApp profile target is unavailable. Check that the bot is connected, then try again.');
  const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The profile image could not be downloaded. Send the photo again and retry.');
  await sock.updateProfilePicture(targetJid, { buffer });
}
function containsLink(text='') {
  const value = String(text || '');
  if (!value.trim()) return false;
  return /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+/i.test(value) ||
    /(?:^|[\s(])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:[\/?#][^\s<]*)?/i.test(value);
}
function containsWhatsAppInvite(text='') {
  return /(?:chat\.whatsapp\.com\/|wa\.me\/|whatsapp\.com\/invite)/i.test(text);
}
function containsBlockedWord(text='', words=[]) {
  const lower = text.toLowerCase();
  return words.some(w => w && lower.includes(String(w).toLowerCase()));
}
async function botIsGroupAdmin(sock, chatJid, participants) {
  const candidates = [sock.user?.id, sock.user?.lid, sock.user?.jid, sock.user?.phoneNumber, `${OWNER_NUMBER}@s.whatsapp.net`].filter(Boolean).map(normalizeJid);
  const entry = participants.find(p => [p.id,p.jid,p.phoneNumber,p.lid,participantJid(p)].filter(Boolean).some(j => candidates.includes(normalizeJid(j))));
  return isAdminParticipant(entry);
}
// ---------------------------------------------------------------------------
// !del / !delete — reliable message deletion in BOTH private chats and groups.
// ---------------------------------------------------------------------------
async function handleDeleteCommand(sock, msg, jid, owner) {
  const prefix = getCommandPrefix(sock);
  const quoted = getQuotedMessage(msg);
  if (!quoted?.stanzaId) {
    await sock.sendMessage(jid, { text: prefixForDisplay('↩️ Reply to the message you want me to delete, then send !del.', prefix) }, { quoted: msg }).catch(() => {});
    return;
  }
  const botPhones = new Set([sock.user?.id, sock.user?.lid, sock.user?.jid, sock.user?.phoneNumber]
    .map(phoneFromJid).filter(Boolean));
  const quotedPhone = phoneFromJid(quoted.participant || '');
  const isOwnMessage = Boolean(quotedPhone && botPhones.has(quotedPhone));

  if (jid.endsWith('@g.us')) {
    let senderIsAdmin = owner;
    let botIsAdmin = false;
    try {
      const ctx = await getGroupContext(sock, msg, jid, owner);
      senderIsAdmin = owner || ctx.senderIsAdmin;
      botIsAdmin = ctx.botIsAdmin;
    } catch (error) {
      await sock.sendMessage(jid, { text: `⚠️ I could not check group permissions: ${error.message}` }, { quoted: msg }).catch(() => {});
      return;
    }
    if (!senderIsAdmin) {
      await sock.sendMessage(jid, { text: '🔒 Only group admins (or the bot owner) can use the delete command in this group.' }, { quoted: msg }).catch(() => {});
      return;
    }
    if (!botIsAdmin && !isOwnMessage) {
      await sock.sendMessage(jid, { text: `⚠️ Please make *${BOT_NAME}* a group admin so I can delete other people’s messages. 💎` }, { quoted: msg }).catch(() => {});
      return;
    }
    const deleteKey = { remoteJid: jid, fromMe: isOwnMessage, id: quoted.stanzaId, ...(isOwnMessage ? {} : { participant: quoted.participant }) };
    let deleted = await deleteGroupMessage(sock, jid, { key: deleteKey }, true);
    if (!deleted) deleted = await deleteGroupMessage(sock, jid, { key: deleteKey }, true);
    if (!deleted) {
      await sock.sendMessage(jid, { text: '❌ WhatsApp refused the delete. In groups the bot must be an admin, and messages older than about 2 days can no longer be revoked.' }, { quoted: msg }).catch(() => {});
      return;
    }
    console.log('[del] removed group message', quoted.stanzaId, 'in', jid);
    await sock.sendMessage(jid, { text: '🗑️ Message deleted. 💎' }, { quoted: msg }).catch(() => {});
    return;
  }

  // Private (1-to-1) chat — revoke for both sides.
  const deleteKey = { remoteJid: jid, fromMe: isOwnMessage, id: quoted.stanzaId };
  try {
    await sock.sendMessage(jid, { delete: deleteKey });
    console.log('[del] removed private message', quoted.stanzaId, 'in', jid);
  } catch (error) {
    try {
      await sock.sendMessage(jid, { delete: deleteKey, deleteForMe: true });
    } catch (secondError) {
      await sock.sendMessage(jid, { text: `❌ I could not delete that message (${error.message || secondError.message}). WhatsApp only allows revoking recent messages.` }, { quoted: msg }).catch(() => {});
    }
  }
}

async function deleteGroupMessage(sock, chatJid, msg, botAdmin) {
  if (!botAdmin) return false;
  try { await sock.sendMessage(chatJid, { delete: msg.key }); return true; } catch { return false; }
}
async function trackGroupActivity(msg, chatJid) {
  const sender = normalizeJid(messageSender(msg));
  if (!sender) return;
  const data = getGroupData(chatJid);
  data.activity[sender] = Date.now();
  if (Object.keys(data.activity).length > 5000) {
    const entries = Object.entries(data.activity).sort((a,b) => b[1]-a[1]).slice(0, 3000);
    data.activity = Object.fromEntries(entries);
  }
}
async function handleGroupModeration(sock, msg, chatJid, text) {
  const data = getGroupData(chatJid);
  const sender = normalizeJid(messageSender(msg));
  const senderEntry = data.whitelist.includes(sender);
  const now = Date.now();
  const mutedUntil = Number(data.muted[sender] || 0);
  const bannedUntil = Number(data.banned[sender] || 0);
  const activeMute = mutedUntil > now;
  const activeBan = bannedUntil > now;
  const activeBlacklist = data.blacklist.includes(sender);
  if (mutedUntil && !activeMute) delete data.muted[sender];
  if (bannedUntil && !activeBan) delete data.banned[sender];

  let needsModeration = activeMute || activeBan || activeBlacklist || data.settings.antiLink || data.settings.antiSpam ||
    data.settings.antiFlood || data.settings.antiWord || data.settings.antiInvite || data.settings.antiMedia ||
    data.settings.antiMention;
  if (!needsModeration) return false;

  let metadata;
  try { metadata = await sock.groupMetadata(chatJid); } catch { return false; }
  const participants = metadata.participants || [];
  const botAdmin = await botIsGroupAdmin(sock, chatJid, participants);
  const senderCandidates = [messageSender(msg), msg.key.participantPn, msg.key.participantAlt]
    .filter(Boolean).map(normalizeJid);
  const admin = participants.some(p =>
    [p.id, p.jid, p.phoneNumber, p.lid, participantJid(p)]
      .filter(Boolean)
      .some(j => senderCandidates.includes(normalizeJid(j))) && isAdminParticipant(p)
  );
  const isOwnerUser = isConfiguredOwner(sender) || isAdditionalOwner(sender);
  // Owners and whitelisted members are always exempt. Group admins are NOT
  // exempt from content filters (anti-link / word / media / invite) — exempting
  // admins is exactly why a link posted by an admin was never deleted. Personal
  // penalties (mute / ban / blacklist) still only target the specific member.
  if (isOwnerUser || senderEntry) return false;
  void admin;

  // Mention detection: @mentions in text, mentions in the contextInfo, and
  // everyone-mentions (@all / @everyone / @here).
  const mentionsOf = (m) => {
    const inner = unwrapMessage(m?.message) || {};
    const ctx = inner.extendedTextMessage?.contextInfo || inner.imageMessage?.contextInfo || inner.videoMessage?.contextInfo || inner.documentMessage?.contextInfo || {};
    const list = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid.map(normalizeJid) : [];
    return list;
  };
  const mentionTargets = mentionsOf(msg);
  const everyOne = /@(all|everyone|here|everybody)\b/i.test(String(text || ''));
  const hasMention = mentionTargets.length > 0 || everyOne;

  let reason = '';
  let reasonKind = '';
  if (activeBan || activeBlacklist) { reason = activeBlacklist ? 'You are on the group bot blacklist.' : `You are temporarily banned from interacting in this group (${remainingTime(bannedUntil)} remaining).`; reasonKind = 'ban'; }
  else if (activeMute) { reason = `You are muted by the group bot (${remainingTime(mutedUntil)} remaining).`; reasonKind = 'mute'; }
  else if (data.settings.antiInvite && containsWhatsAppInvite(text)) { reason = '💬 WhatsApp invite links are not allowed here.'; reasonKind = 'content'; }
  else if (data.settings.antiLink && containsLink(text)) { reason = '🔗 Links are not allowed here.'; reasonKind = 'content'; }
  else if (data.settings.antiMention && hasMention) { reason = '📢 Mentioning / tagging members is not allowed here.'; reasonKind = 'content'; }
  else if (data.settings.antiWord && containsBlockedWord(text, data.settings.antiWords)) { reason = '🤬 That message contains a blocked word.'; reasonKind = 'content'; }
  else if (data.settings.antiMedia && messageHasMedia(msg)) { reason = '🖼️ Media messages are not allowed here.'; reasonKind = 'content'; }
  else if (data.settings.antiFlood) {
    const key = `${chatJid}:${sender}`;
    const arr = (floodCache.get(key) || []).filter(t => now - t < 10000);
    arr.push(now); floodCache.set(key, arr);
    if (arr.length >= 6) { reason = '🌊 Flood protection triggered. Slow down.'; reasonKind = 'content'; }
  }
  if (data.settings.antiSpam && !reason && text) {
    const key = `${chatJid}:${sender}:spam`;
    const last = floodCache.get(key) || [];
    const recent = last.filter(x => now - x.time < 20000);
    recent.push({ time: now, text: text.toLowerCase().trim() });
    floodCache.set(key, recent);
    const same = recent.filter(x => x.text === text.toLowerCase().trim()).length;
    if (same >= 3) { reason = '🚫 Spam protection triggered.'; reasonKind = 'content'; }
  }

  if (!reason) return false;

  // DEL MODE ------------------------------------------------------------
  // antiLinkMode / antiMentionMode = 'del' -> remove the message immediately and
  // tag the sender. 'warn' (default for anti-link) only warns + counts a warning.
  const modeOf = (kind) => String(kind === 'mention' ? (data.settings.antiMentionMode || 'del')
    : kind === 'link' ? (data.settings.antiLinkMode || 'warn')
    : 'warn');
  let filterKind = '';
  if (reasonKind === 'content') {
    if (data.settings.antiMention && hasMention) filterKind = 'mention';
    else if (data.settings.antiLink && containsLink(text)) filterKind = 'link';
    else filterKind = 'other';
  }
  const mode = filterKind === 'mention' ? modeOf('mention') : filterKind === 'link' ? modeOf('link') : 'warn';
  const shouldDelete = reasonKind !== 'content' ? true : mode === 'del';
  const isContentFilter = reasonKind === 'content';

  let deleted = false;
  if (shouldDelete) deleted = await deleteGroupMessage(sock, chatJid, msg, botAdmin);
  const tag = displayJid(sender);
  if (activeBan || activeMute || isContentFilter) {
    if (deleted || activeBan || activeMute) {
      const extra = isContentFilter && mode === 'del'
        ? `\n🗑️ Message deleted by ${BOT_NAME}. ${reasonModeHint(filterKind)}`
        : '';
      await sock.sendMessage(chatJid, { text: `${tag} ${reason}${extra}`, mentions: [sender] }).catch(() => {});
    } else if (isContentFilter && !botAdmin) {
      // The filter matched but the message could not be removed because the bot
      // is not a group admin. Say it once so an admin can promote the bot.
      await sock.sendMessage(chatJid, { text: `⚠️ ${reason}
🛡️ I detected it but I could not delete it — please make me a *group admin* so I can remove blocked content. 💎`, mentions: [sender] }).catch(() => {});
    }
  }
  if (data.settings.warningSystem && !activeBan && !activeMute) {
    data.warnings[sender] = Number(data.warnings[sender] || 0) + 1;
    if (data.warnings[sender] >= 3 && botAdmin) {
      try { await sock.groupParticipantsUpdate(chatJid, [sender], 'remove'); delete data.warnings[sender]; } catch {}
    }
    await saveGroupData().catch(() => {});
  }
  return true;
}


function reasonModeHint(kind) {
  if (kind === 'mention') return `Please do not tag members here. 💎`;
  if (kind === 'link') return `Posting links is not allowed in this group. 💎`;
  return `That content is not allowed in this group. 💎`;
}

function cacheIncomingMessage(msg) {
  const jid = msg?.key?.remoteJid;
  const id = msg?.key?.id;
  if (!jid || !id || !msg?.message) return;
  if (msg.key.fromMe) return;
  let chat = messageCache.get(jid);
  if (!chat) { chat = new Map(); messageCache.set(jid, chat); }
  chat.set(id, msg);
  while (chat.size > MAX_CACHED_MESSAGES_PER_CHAT) chat.delete(chat.keys().next().value);
}
function getCachedMessage(jid, id) {
  return messageCache.get(jid)?.get(id) || null;
}
function isRevokeMessage(msg) {
  const content = unwrapMessage(msg?.message);
  const protocol = content?.protocolMessage;
  return Boolean(protocol?.key?.id && (protocol?.type === 0 || String(protocol?.type).toUpperCase() === 'REVOKE'));
}
async function sendRecoveredMessage(sock, destination, original, sourceJid, deletedBy) {
  const content = unwrapMessage(original.message);
  const sender = messageSender(original);
  const header = `🛡️ *ANTI-DELETE RECOVERY*\n👤 From: ${displayJid(sender)}\n🗑️ Deleted message recovered.\n📍 Source: ${sourceJid.endsWith('@g.us') ? 'Group' : 'Private chat'}${deletedBy ? `\n⚠️ Deleted by: ${displayJid(deletedBy)}` : ''}`;
  try {
    if (content.conversation || content.extendedTextMessage?.text) {
      const text = getText(original.message);
      return await sock.sendMessage(destination, { text: `${header}\n\n💬 *Message:*\n${text}` });
    }
    if (content.imageMessage) {
      const buffer = await downloadMediaMessage(original, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      return await sock.sendMessage(destination, { image: buffer, caption: `${header}\n\n🖼️ ${content.imageMessage.caption || 'Image'}` });
    }
    if (content.videoMessage) {
      const buffer = await downloadMediaMessage(original, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      return await sock.sendMessage(destination, { video: buffer, caption: `${header}\n\n🎬 ${content.videoMessage.caption || 'Video'}` });
    }
    if (content.audioMessage) {
      const buffer = await downloadMediaMessage(original, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      return await sock.sendMessage(destination, { audio: buffer, mimetype: content.audioMessage.mimetype || 'audio/mp4', ptt: Boolean(content.audioMessage.ptt) });
    }
    if (content.documentMessage) {
      const buffer = await downloadMediaMessage(original, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      return await sock.sendMessage(destination, { document: buffer, mimetype: content.documentMessage.mimetype || 'application/octet-stream', fileName: content.documentMessage.fileName || 'recovered-file' }, { quoted: undefined });
    }
    if (content.stickerMessage) {
      const buffer = await downloadMediaMessage(original, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      return await sock.sendMessage(destination, { sticker: buffer });
    }
    return await sock.sendMessage(destination, { text: `${header}\n\n📦 Unsupported message type recovered from cache.` });
  } catch (error) {
    return await sock.sendMessage(destination, { text: `${header}\n\n⚠️ I recovered the message record, but its media could not be re-downloaded.\n🔎 Reason: ${error.message}` });
  }
}
async function handleAntiDeleteRevoke(sock, revokeMsg) {
  const jid = revokeMsg.key.remoteJid;
  const protocol = unwrapMessage(revokeMsg.message)?.protocolMessage;
  const originalId = protocol?.key?.id;
  if (!jid || !originalId) return false;
  const original = getCachedMessage(jid, originalId);
  if (!original) return false;
  const inGroup = jid.endsWith('@g.us');
  const data = inGroup ? getGroupData(jid) : null;
  const enabled = inGroup ? Boolean(data?.settings?.antiDelete) : Boolean(botSettings.antiDeletePrivate);
  if (!enabled) return false;
  const deletedBy = messageSender(revokeMsg) || protocol?.key?.participant || '';
  // Destination by mode:
  //   chat  -> resend in the SAME chat the message was deleted in
  //   group -> resend inside the group (only meaningful for groups)
  //   inbox -> forward privately to the owner DM
  const mode = inGroup ? (data?.settings?.antiDeleteMode || 'inbox') : 'inbox';
  const ownerDm = `${OWNER_NUMBER}@s.whatsapp.net`;
  const destination = (mode === 'chat' || mode === 'group') ? jid : ownerDm;
  await sendRecoveredMessage(sock, destination, original, jid, deletedBy);
  stats.recoveredDeletes++;
  return true;
}
async function revealViewOnce(sock, msg, jid) {
  const quoted = getQuotedMessage(msg);
  if (!quoted) throw new Error('Reply to a view-once photo, video, or audio with !br.');
  const target = { key: { remoteJid: jid, participant: quoted.participant, id: quoted.stanzaId }, message: quoted.message };
  const raw = quoted.message || {};
  const detected = findViewOnceMedia(raw);
  if (!detected) throw new Error('The replied message is not a view-once photo, video, or audio.');
  const content = detected.content;
  const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!buffer?.length) throw new Error('The view-once media could not be downloaded. It may have expired.');
  if (content.imageMessage) {
    await sock.sendMessage(jid, { image: buffer, caption: `👁️‍🗨️ *VIEW-ONCE REVEALED*\n🛡️ ${BOT_NAME}` }, { quoted: msg });
    return;
  }
  if (content.videoMessage) {
    await sock.sendMessage(jid, { video: buffer, caption: `👁️‍🗨️ *VIEW-ONCE VIDEO REVEALED*\n🛡️ ${BOT_NAME}` }, { quoted: msg });
    return;
  }
  if (content.audioMessage) {
    await sock.sendMessage(jid, { audio: buffer, mimetype: content.audioMessage.mimetype || 'audio/mp4', ptt: Boolean(content.audioMessage.ptt) }, { quoted: msg });
    return;
  }
  throw new Error('Unsupported view-once media type.');
}
async function runCommand(command, args, options = {}) {
  const timeout = options.timeout || YTDLP_TIMEOUT;
  if (command !== 'yt-dlp') {
    return execFileAsync(command, args, {
      timeout, maxBuffer: 1024 * 1024 * 8, windowsHide: true
    });
  }

  // Prefer the same Python installation the owner verified with `py -3.14 -m yt_dlp`.
  // Do not rely on yt-dlp.exe or whichever `python` happens to appear first on PATH.
  const attempts = [];
  const configuredPython = String(process.env.YTDLP_PYTHON || '').trim();
  if (configuredPython) attempts.push({ cmd: configuredPython, prefix: ['-m', 'yt_dlp'] });
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('py', ['-3.14', '-c', 'import sys; print(sys.executable)'], {
        timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024
      });
      const pythonExe = String(stdout || '').trim().split(/\r?\n/).find(Boolean);
      if (pythonExe) attempts.push({ cmd: pythonExe, prefix: ['-m', 'yt_dlp'] });
    } catch {}
    attempts.push({ cmd: 'py', prefix: ['-3.14', '-m', 'yt_dlp'] });
  }
  attempts.push(
    { cmd: 'yt-dlp', prefix: [] },
    { cmd: 'python', prefix: ['-m', 'yt_dlp'] },
    { cmd: 'python3', prefix: ['-m', 'yt_dlp'] }
  );

  const errors = [];
  const seen = new Set();
  for (const runner of attempts) {
    const key = `${runner.cmd} ${runner.prefix.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return await execFileAsync(runner.cmd, [...runner.prefix, ...args], {
        timeout, maxBuffer: 1024 * 1024 * 8, windowsHide: true
      });
    } catch (error) {
      errors.push(`${key}: ${error.stderr || error.message || error.code || 'failed'}`);
      // ENOENT means try the next launcher. Other errors can be format/network/auth
      // failures; retain diagnostics instead of silently switching interpreters.
      if (error.code !== 'ENOENT' && !/No module named yt_dlp/i.test(String(error.stderr || error.message || ''))) {
        throw error;
      }
    }
  }
  throw new Error(`yt-dlp could not be started with an installed Python module or executable.\n${errors.join('\n')}`);
}
async function resolveCommand(command) {
  try {
    const checker = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(checker, [command], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const first = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  try {
    await execFileAsync(command, ['-version'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return command;
  } catch {}
  return null;
}
async function getFfmpegLocation() {
  // Honor an explicit FFMPEG_PATH first. Users commonly point it at the ffmpeg
  // executable itself OR at the containing folder (e.g. ...\ffmpeg\bin). Earlier
  // builds spawned that folder directly, which threw ENOENT. Normalize both:
  // yt-dlp's --ffmpeg-location wants the directory on Windows and the exe/dir
  // elsewhere, so we return a directory when we can detect one.
  const envPath = (process.env.FFMPEG_PATH || '').trim();
  if (envPath) {
    try {
      if (statSync(envPath).isDirectory()) return envPath;
      return process.platform === 'win32' ? path.dirname(envPath) : envPath;
    } catch { /* fall through to PATH lookup */ }
  }
  const exe = await resolveCommand('ffmpeg');
  if (!exe) return null;
  return process.platform === 'win32' ? path.dirname(exe) : exe;
}
// Resolve the ACTUAL ffmpeg executable to spawn from whatever getFfmpegLocation
// returns (which may be a directory or the exe itself). Never returns a folder,
// so execFile can never try to spawn a directory (the old ENOENT crash).
async function resolveFfmpegBinary() {
  const location = await getFfmpegLocation();
  if (!location) return null;
  let isDir = false;
  try { isDir = statSync(location).isDirectory(); } catch {}
  if (!isDir) return location; // already a file path to the executable
  if (process.platform === 'win32') {
    const withExe = path.join(location, 'ffmpeg.exe');
    try { if (existsSync(withExe)) return withExe; } catch {}
    return path.join(location, 'ffmpeg');
  }
  return path.join(location, 'ffmpeg');
}
// Re-encode any downloaded video into a universally compatible WhatsApp format.
// WhatsApp plays many containers locally, but forwarded clips and Status posts are
// re-streamed from WhatsApp servers, which only reliably decode H.264 (yuv420p) video
// + AAC audio with the moov atom at the FRONT (+faststart). Downloads that keep VP9/AV1
// video, Opus audio, or an end-of-file moov atom play for the sender but show a black
// screen / "can't open" for recipients. This normalization fixes exactly that.
async function normalizeVideoForWhatsApp(inputFile, prefix) {
  const ffmpegBin = await resolveFfmpegBinary();
  if (!ffmpegBin) {
    console.warn('[Video] FFmpeg not found; sending the original file. Forwarding/Status playback may fail on other devices.');
    return { file: inputFile, converted: false };
  }
  const output = path.join(TEMP_DIR, `${prefix}-wa.mp4`);
  try {
    await execFileAsync(ffmpegBin, [
      '-y', '-i', inputFile,
      // Even dimensions are required by yuv420p/H.264.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-crf', '24',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
      // Put the moov atom at the start so recipients can stream the clip immediately.
      '-movflags', '+faststart',
      output
    ], { timeout: 300000, windowsHide: true, maxBuffer: 1024 * 1024 * 16 });
    if (await fileExists(output)) return { file: output, converted: true };
  } catch (error) {
    console.warn('[Video] WhatsApp normalization failed; sending original file:', error.message);
  }
  return { file: inputFile, converted: false };
}
// Read a video file, normalize it for WhatsApp, and return a ready-to-send payload.
async function prepareWhatsAppVideo(file, prefix) {
  const normalized = await normalizeVideoForWhatsApp(file, prefix);
  const buffer = await readFile(normalized.file);
  return { buffer, converted: normalized.converted, mimetype: 'video/mp4' };
}
// IMPORTANT: Interactive / native-flow / view-once button messages do NOT render
// on WhatsApp Web and Desktop (laptop). They show "This message couldn't load.
// Open the message on your phone to view it" and often stay blank on the phone
// too. To work reliably on EVERY device, we render buttons as a clean, tappable
// text layout (each action on its own line). This is plain text, so it always
// displays correctly on laptop, desktop, and phone.
async function sendButtons(sock, jid, { title = '', body = '', footer = '', image = null, buttons = [] } = {}, quoted) {
  // Button ids are commands like '!menu'. Rewrite them to the prefix the owner
  // actually set, so a '/' session never shows a '!' tap-to-type hint.
  const activePrefix = getCommandPrefix(sock);
  // NOTE: native-flow / "real" interactive buttons relay to the server fine but
  // render as "This message couldn't load. Open on your phone" on most PERSONAL
  // (non-business) WhatsApp accounts used with Baileys. So we always send a clean
  // tappable TEXT layout that renders everywhere; each action is a command the
  // user can tap-to-copy or type.
  const list = (buttons || []).filter(b => b && b.text && b.id).map(b => ({ text: b.text, id: prefixForDisplay(b.id, activePrefix) })).slice(0, 4);
  const taps = list.map(b => `\u25b8 *${prefixForDisplay(b.text, activePrefix)}*\n   \u2937 tap or type:  ${prefixForDisplay(b.id, activePrefix)}`).join('\n\n');
  const safeTitle = title ? prefixForDisplay(title, activePrefix) : '';
  const safeBody = body ? prefixForDisplay(body, activePrefix) : '';
  const text = `${safeTitle ? `*${safeTitle}*\n\n` : ''}${safeBody}${taps ? `\n\n\u2500\u2500 QUICK ACTIONS \u2500\u2500\n\n${taps}` : ''}\n\n_${footer || FOOTER_TEXT}_`;
  try {
    if (image?.length) await sock.sendMessage(jid, { image, caption: text }, { quoted });
    else await sock.sendMessage(jid, { text }, { quoted });
    return true;
  } catch (error) {
    console.warn('[Buttons] send failed:', error.message);
    try { await sock.sendMessage(jid, { text }, { quoted }); } catch {}
    return false;
  }
}

async function searchMedia(query) {
  const clean = String(query || '').trim();
  if (!clean) throw new Error('Give me a song or video name to search for.');
  if (clean.length > 200) throw new Error('Search query is too long. Keep it under 200 characters.');
  stats.mediaSearches++;
  const { stdout } = await runCommand('yt-dlp', ['--flat-playlist', '--no-warnings', '--playlist-end', '1', '--print', '%(id)s\t%(title)s\t%(webpage_url)s', `ytsearch1:${clean}`]);
  const line = String(stdout || '').trim().split(/\r?\n/).find(Boolean);
  if (!line) throw new Error('No result was found for that search.');
  const [id, ...rest] = line.split('\t');
  const url = rest[1] || rest[0] || (id?.startsWith('http') ? id : '');
  const title = rest[0] || id || clean;
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('The search backend returned an invalid result.');
  return { id, title, url };
}
async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}
async function findDownloadedFile(prefix, hintedPaths = []) {
  for (const candidate of hintedPaths) {
    if (!candidate) continue;
    const normalized = String(candidate).trim().replace(/^['"]|['"]$/g, '');
    if (await fileExists(normalized)) return normalized;
  }
  const files = await readdir(TEMP_DIR);
  const mediaExts = new Set(['.mp4','.m4v','.webm','.mkv','.mov','.avi','.3gp','.mp3','.m4a','.aac','.opus','.ogg']);
  const matches = files
    .filter(name => name.startsWith(prefix))
    .filter(name => mediaExts.has(path.extname(name).toLowerCase()))
    .map(name => path.join(TEMP_DIR, name));
  if (!matches.length) throw new Error('Download finished, but yt-dlp did not leave a media file at the expected output path.');
  matches.sort((a,b) => b.localeCompare(a));
  return matches[0];
}
async function cleanupPrefix(prefix) {
  try {
    const files = await readdir(TEMP_DIR);
    await Promise.all(files.filter(name => name.startsWith(prefix)).map(name => rm(path.join(TEMP_DIR, name), { force: true }).catch(() => {})));
  } catch {}
}
async function downloadSearchMedia(sock, msg, jid, mode, query) {
  const send = text => sock.sendMessage(jid, { text }, { quoted: msg });
  if (!query) return send(mode === 'audio' ? '🎵 Usage: !audio Song Name - Artist' : '🎬 Usage: !video What you want to watch');
  await mkdir(TEMP_DIR, { recursive: true });
  const search = await searchMedia(query);
  const safePrefix = `${mode}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  await send(`🔎 *Searching...*\n${mode === 'audio' ? '🎵' : '🎬'} ${query}\n\n🎯 Best match: *${search.title}*\n⏳ Downloading now...`);
  try {
    if (mode === 'audio') {
      const ffmpegLocation = await getFfmpegLocation();
      if (!ffmpegLocation) throw new Error('FFmpeg could not be located by Nancy Nova AI. Open a new CMD after installing FFmpeg, confirm `ffmpeg -version` works, then try !audio again.');
      const output = path.join(TEMP_DIR, `${safePrefix}.mp3`);
      await runCommand('yt-dlp', [
        '--no-playlist', '--no-warnings', '--no-part',
        '--ffmpeg-location', ffmpegLocation,
        '-x', '--audio-format', 'mp3', '--audio-quality', '5',
        '--postprocessor-args', 'ffmpeg:-vn',
        '-o', output, search.url
      ]);
      const file = output;
      const buffer = await readFile(file);
      if (buffer.length > 55 * 1024 * 1024) throw new Error('The audio file is too large for a WhatsApp send.');
      await sock.sendMessage(jid, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        fileName: `${search.title.replace(/[<>:"/\\|?*]+/g, '').slice(0, 80) || 'audio'}.mp3`,
        ptt: false
      }, { quoted: msg });
      await send(`✅ *AUDIO DELIVERED SUCCESSFULLY!*\n🎵 ${search.title}\n📦 ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n🎧 Format: MP3`);
    } else {
      const ffmpegLocation = await getFfmpegLocation();
      // Facebook/Instagram frequently expose separate DASH video and audio streams.
      // Merge them when FFmpeg exists; otherwise request a muxed format only.
      const format = ffmpegLocation ? 'bestvideo*+bestaudio/best' : 'best[acodec!=none]/best';
      const output = path.join(TEMP_DIR, `${safePrefix}.%(ext)s`);
      const args = ['--no-playlist', '--no-warnings', '--no-part', '-f', format];
      if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation, '--merge-output-format', 'mp4');
      args.push('-o', output, search.url);
      await runCommand('yt-dlp', args);
      const file = await findDownloadedFile(safePrefix);
      const ready = await prepareWhatsAppVideo(file, safePrefix);
      if (ready.buffer.length > 65 * 1024 * 1024) throw new Error('The video is too large for a WhatsApp send. Try a shorter video.');
      await sock.sendMessage(jid, { video: ready.buffer, mimetype: ready.mimetype, caption: `🎬 ${search.title}\n✅ Optimized for WhatsApp — safe to forward and post to Status\n✨ Delivered by ${BOT_NAME}` }, { quoted: msg });
    }
  } finally {
    await cleanupPrefix(safePrefix);
  }
}

async function downloadDirectMedia(sock, msg, jid, url) {
  const send = text => sock.sendMessage(jid, { text }, { quoted: msg });
  if (!/^https?:\/\//i.test(url)) return send('🔗 Please provide a valid public http/https URL.');
  await mkdir(TEMP_DIR, { recursive: true });
  const prefix = `direct-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    const ffmpegLocation = await getFfmpegLocation();
    // When FFmpeg is available, combine the separate Facebook video-only and audio-only
    // streams. Without FFmpeg, only select a format that already includes audio.
    const format = ffmpegLocation ? 'bestvideo*+bestaudio/best' : 'best[acodec!=none]/best';
    await send('🔎 *LINK RECEIVED!*\n⏳ Fetching the best available video...');
    if (!ffmpegLocation) {
      await send('ℹ️ FFmpeg was not detected. I will try a ready-made video-with-audio format; quality or availability may be limited. Install FFmpeg for reliable high-quality downloads.');
    }
    const output = path.join(TEMP_DIR, `${prefix}.%(ext)s`);
    const ytArgs = [
      '--no-playlist','--no-warnings','--no-part',
      '--restrict-filenames',
      '--print','%(title)s',
      '--print','after_move:filepath',
      '-f', format
    ];
    if (ffmpegLocation) ytArgs.push('--ffmpeg-location', ffmpegLocation, '--merge-output-format','mp4');
    ytArgs.push('-o', output, url);
    const { stdout } = await runCommand('yt-dlp', ytArgs);
    const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const title = lines.find(line => !/^[A-Za-z]:\\|^\//.test(line) && !line.startsWith(TEMP_DIR)) || 'Downloaded media';
    const hintedPaths = lines.filter(line => line.includes(TEMP_DIR) || /\.(mp4|m4v|webm|mkv|mov|avi|3gp)$/i.test(line));
    const file = await findDownloadedFile(prefix, hintedPaths);
    const ready = await prepareWhatsAppVideo(file, prefix);
    if (ready.buffer.length > 65 * 1024 * 1024) throw new Error('The video is too large for WhatsApp.');
    await sock.sendMessage(jid, { video: ready.buffer, mimetype: ready.mimetype, caption: `✅ *Download complete*\n🎬 ${title}\n📲 Optimized for WhatsApp — safe to forward and post to Status\n✨ ${BOT_NAME}` }, { quoted: msg });
  } finally { await cleanupPrefix(prefix); }
}


async function downloadYouTubeMedia(sock, msg, jid, url) {
  const send = text => sock.sendMessage(jid, { text }, { quoted: msg });
  if (!url) return send('🎬 Usage: !ytb https://www.youtube.com/watch?v=VIDEO_ID');
  let parsed;
  try { parsed = new URL(url); } catch { return send('⚠️ Please provide a valid YouTube video URL.'); }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const allowedHosts = new Set(['youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com', 'youtube-nocookie.com']);
  if (!allowedHosts.has(host) && !host.endsWith('.youtube.com')) {
    return send('⚠️ !ytb only accepts YouTube links (youtube.com or youtu.be).');
  }
  if (host === 'youtu.be' && !parsed.pathname.slice(1)) return send('⚠️ That YouTube link does not include a video ID.');
  if (host !== 'youtu.be' && !parsed.searchParams.get('v') && !/^\/shorts\/[^/]+/.test(parsed.pathname) && !/^\/live\/[^/]+/.test(parsed.pathname) && !/^\/embed\/[^/]+/.test(parsed.pathname)) {
    return send('⚠️ Please send a direct YouTube video, Shorts, or live replay URL.');
  }
  await mkdir(TEMP_DIR, { recursive: true });
  const prefix = `ytb-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    await send('🎬 *YOUTUBE DOWNLOAD STARTED*\n⏳ Fetching the video (maximum 720p where available)...');
    const ffmpegLocation = await getFfmpegLocation();
    const output = path.join(TEMP_DIR, `${prefix}.%(ext)s`);
    // Separate video/audio streams need FFmpeg to merge. Without it, request
    // a single-file format so the download can still work when available.
    const format = ffmpegLocation ? 'bv*[height<=720]+ba/b[height<=720]/b' : 'b[height<=720]/b';
    const args = ['--no-playlist', '--no-warnings', '--no-part', '--restrict-filenames', '--print', '%(title)s', '--print', 'after_move:filepath', '-f', format];
    if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation, '--merge-output-format', 'mp4');
    args.push('-o', output, parsed.href);
    const { stdout } = await runCommand('yt-dlp', args, { timeout: YTDLP_TIMEOUT });
    const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const title = lines.find(line => !line.includes(TEMP_DIR) && !/^[A-Za-z]:\\|^\//.test(line)) || 'YouTube video';
    const hintedPaths = lines.filter(line => line.includes(TEMP_DIR) || /\.(mp4|m4v|webm|mkv|mov|avi|3gp)$/i.test(line));
    const file = await findDownloadedFile(prefix, hintedPaths);
    const rawBuffer = await readFile(file);
    if (!rawBuffer.length) throw new Error('yt-dlp returned an empty file.');
    const ready = await prepareWhatsAppVideo(file, prefix);
    const buffer = ready.buffer;
    if (buffer.length > 65 * 1024 * 1024) throw new Error('The video is larger than the 65 MB WhatsApp send limit. Try a shorter video.');
    const mimetype = ready.mimetype;
    await sock.sendMessage(jid, { video: buffer, mimetype, caption: `🎬 *${title.slice(0, 500)}*\n✅ Optimized for WhatsApp — safe to forward and post to Status\n✅ Downloaded by ${BOT_NAME} | ${TEAM_NAME}` }, { quoted: msg });
    await send(`✅ *YOUTUBE VIDEO SENT*\n📦 ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    await cleanupPrefix(prefix);
  }
}

const CYBER_COMMANDS = new Set([
  '!hack','!scan','!trace','!track','!ipcheck','!access','!root','!bypass','!breach',
  '!decrypt','!encrypt','!decode','!encode','!firewall','!virus','!database',
  '!terminal','!matrix','!overload','!shutdown','!classified','!analysis'
]);

function cyberTarget(msg, args = []) {
  const targets = resolveTargetJids(msg, args, { allowCurrentChat: false });
  return targets[0] || 'TARGET-UNKNOWN';
}

function cyberName(target) {
  if (String(target).includes('@')) return displayJid(target);
  return String(target);
}

async function runCyberSimulation(sock, msg, jid, command, args) {
  const target = cyberTarget(msg, args);
  const targetText = cyberName(target);
  const opId = randomBytes(4).toString('hex').toUpperCase();
  const rnd = n => Math.floor(Math.random() * n);
  const fakeIp = () => `${rnd(223) + 1}.${rnd(256)}.${rnd(256)}.${rnd(256)}`;
  const fakeMac = () => Array.from({ length: 6 }, () => rnd(256).toString(16).padStart(2, '0')).join(':').toUpperCase();
  const hex = n => randomBytes(n).toString('hex').toUpperCase();
  const bar = p => { const f = Math.max(0, Math.min(20, Math.round(p / 5))); return `[${'█'.repeat(f)}${'░'.repeat(20 - f)}] ${p}%`; };
  const ok = s => `✔ ${s}`;
  const hit = s => `⚡ ${s}`;
  const ops = {
    '!hack':    { icon: '🛠️', title: 'REMOTE ACCESS EXPLOIT', logs: () => [`[+] Resolving target vector → ${fakeIp()}`, `[+] Fingerprinting OS kernel... Linux 5.15 x86_64`, `[+] Open ports: 22(ssh) 443(https) 3306(mysql)`, hit(`CVE-2024-${rnd(9000)+1000} exploit armed`), `[*] Injecting payload 0x${hex(6)}`, ok('Firewall rule bypassed'), ok('Auth token forged'), hit('ROOT SHELL ACQUIRED')], finale: ['██ ACCESS GRANTED ██', `root@${fakeIp()}:~#`, `UID=0(root) GID=0(root)`, `SESSION KEY: 0x${hex(8)}`] },
    '!scan':    { icon: '📡', title: 'DEEP PORT & VULN SCAN', logs: () => [`[+] Target → ${fakeIp()}`, `[+] SYN sweep 1-65535...`, ok('Host alive (TTL 64)'), `[!] 22/tcp open   OpenSSH 8.9`, `[!] 80/tcp open   nginx 1.24`, `[!] 445/tcp open  SMB (SIGNING OFF)`, hit(`${rnd(6)+2} CRITICAL vulns detected`), hit('SMBGhost + EternalBlue surface found')], finale: ['██ SCAN COMPLETE ██', `Hosts: 1  Ports: ${rnd(40)+6} open`, `CVSS peak: 9.${rnd(9)} (CRITICAL)`, 'Exploit map saved'] },
    '!trace':   { icon: '🛰️', title: 'GLOBAL SIGNAL TRACE', logs: () => [`[+] Locking signal of ${targetText}`, ` 1  gateway        1ms`, ` 2  ${fakeIp()}   12ms  [US-EAST]`, ` 3  ${fakeIp()}   38ms  [AMS-IX]`, ` 4  ${fakeIp()}   77ms  [SG-TELCO]`, hit('Endpoint triangulated'), ok(`MAC ${fakeMac()}`)], finale: ['██ TRACE LOCKED ██', `Approx coords: ${(rnd(180)-90)}.${rnd(9999)}, ${(rnd(360)-180)}.${rnd(9999)}`, `ISP carrier: AS${rnd(60000)+1000}`, `Hops: ${rnd(6)+7}`] },
    '!track':   { icon: '📍', title: 'LIVE GEO-TELEMETRY LOCK', logs: () => [`[+] Binding telemetry feed...`, `[+] Device IMEI: 35${rnd(10)}${hex(5)}`, ok('GPS beacon captured'), `[*] Sat lock 3/4`, hit('Movement vector resolved'), `[*] Speed ${rnd(80)} km/h  heading ${rnd(360)}°`], finale: ['██ TARGET TRACKED ██', `Lat ${(rnd(180)-90)}.${rnd(99999)}  Lon ${(rnd(360)-180)}.${rnd(99999)}`, `Accuracy: ${rnd(12)+1} m`, 'Live pin dropped'] },
    '!ipcheck': { icon: '🌐', title: 'IP INTELLIGENCE PROBE', logs: () => [`[+] Address → ${fakeIp()}`, ok('rDNS resolved'), `[*] ASN AS${rnd(60000)+1000}`, `[*] Proxy/VPN: ${rnd(2) ? 'DETECTED' : 'none'}`, hit('Geo + carrier fused')], finale: ['██ IP PROFILE ██', `MAC ${fakeMac()}`, `Open services: ${rnd(9)+1}`, `Threat score: ${rnd(40)+60}/100`] },
    '!access':  { icon: '🔓', title: 'PRIVILEGE ESCALATION', logs: () => [`[+] Reading /etc/shadow...`, `[*] Cracking hash 0x${hex(6)}`, bar(40), bar(78), ok('Hash cracked: s*****2024'), hit('sudo token hijacked')], finale: ['██ ADMIN UNLOCKED ██', 'Role: SUPERUSER', `Vault keys: ${rnd(20)+4}`, 'Policy matrix overridden'] },
    '!root':    { icon: '👑', title: 'KERNEL ROOT TAKEOVER', logs: () => [`[+] Mapping privilege ladder...`, hit('ring-3 → ring-0 jump armed'), `[*] Patching syscall table 0x${hex(6)}`, bar(55), bar(92), ok('SELinux set permissive')], finale: ['██ ROOT GRANTED ██', '# whoami', 'root', `Kernel: PWNED (${hex(3)})`] },
    '!bypass':  { icon: '🚫', title: 'SECURITY BYPASS', logs: () => [`[+] Enumerating WAF signatures...`, `[*] Rotating payload encodings`, ok('Rate-limit evaded'), hit('CAPTCHA token spoofed'), ok('2FA relay established')], finale: ['██ GATES BYPASSED ██', `Layers cleared: ${rnd(4)+3}`, 'WAF: BLIND', 'Tunnel open'] },
    '!breach':  { icon: '💥', title: 'PERIMETER BREACH', logs: () => [`[+] Target perimeter → ${fakeIp()}`, `[*] Spear-phish payload delivered`, hit('Foothold established'), `[*] Lateral move → ${fakeIp()}`, ok('Domain controller reached')], finale: ['██ PERIMETER BREACHED ██', `Hosts owned: ${rnd(30)+3}`, 'DC: COMPROMISED', `Exfil staged: ${rnd(900)+100} MB`] },
    '!decrypt': { icon: '🔓', title: 'CIPHER CRACK', logs: () => [`[+] Ciphertext 0x${hex(8)}`, `[*] Detected AES-256-GCM`, `[*] GPU rig spun up (${rnd(8)+2}x RTX)`, bar(33), bar(71), hit('Key recovered')], finale: ['██ DECRYPTED ██', `Key: ${hex(8)}`, `Blocks: ${rnd(900)+100}`, 'Plaintext dumped'] },
    '!encrypt': { icon: '🔒', title: 'MILITARY ENCRYPTION', logs: () => [`[+] Generating key material...`, ok(`AES-256 key ${hex(6)}`), `[*] Wrapping in RSA-4096`, bar(60), ok('HMAC sealed')], finale: ['██ VAULT SEALED ██', `Fingerprint ${hex(8)}`, 'Layers: 5', 'Unbreakable (demo)'] },
    '!decode':  { icon: '🧩', title: 'DATA DECODER', logs: () => [`[+] Sniffing payload...`, `[*] Base64 → hex → raw`, ok('Encoding chain solved'), hit('Hidden layer found')], finale: ['██ DECODED ██', `Format: multipart`, `Entropy: ${rnd(3)+5}.${rnd(9)} bits`, 'Output extracted'] },
    '!encode':  { icon: '📦', title: 'DATA ENCODER', logs: () => [`[+] Packing payload...`, `[*] XOR + Base85 + gzip`, bar(80), ok('Checksum valid')], finale: ['██ ENCODED ██', `Size: ${rnd(90)+10}.${rnd(9)} KB`, `CRC32 ${hex(4)}`, 'Ready for transport'] },
    '!firewall':{ icon: '🧱', title: 'FIREWALL ASSAULT', logs: () => [`[+] Probing rule table...`, `[*] ${rnd(80)+40} ACLs mapped`, hit('Stateful filter confused'), ok('Pinhole punched')], finale: ['██ WALL DOWN ██', `Rules bypassed: ${rnd(40)+10}`, 'Inbound: OPEN', 'Defense: BLIND'] },
    '!virus':   { icon: '☠️', title: 'PAYLOAD FORGE', logs: () => [`[+] Compiling polymorphic stub...`, `[*] Signature 0x${hex(8)}`, hit('AV evasion: FUD'), ok('Persistence installed')], finale: ['██ PAYLOAD ARMED ██', `Detections: 0/${rnd(20)+50}`, 'Mode: DEMO ONLY', 'Nothing was deployed'] },
    '!database':{ icon: '🗄️', title: 'DATABASE DUMP', logs: () => [`[+] SQLi probe → ' OR 1=1--`, hit('Injection accepted'), `[*] Dumping tables...`, `[*] users (${rnd(90000)+1000} rows)`, ok('Credentials harvested')], finale: ['██ DB DUMPED ██', `Tables: ${rnd(30)+8}`, `Rows: ${(rnd(900)+100)}k`, 'Hashes cracked'] },
    '!terminal':{ icon: '🖥️', title: 'SECURE SHELL', logs: () => [`[+] Booting Team NASA shell...`, `root@nasa-term:~# id`, 'uid=0(root)', ok('Modules loaded')], finale: ['██ SHELL READY ██', `Session Team NASA-${opId}`, 'State: INTERACTIVE', 'Type a command (demo)'] },
    '!matrix':  { icon: '🟩', title: 'MATRIX STREAM', logs: () => [`01001${rnd(2)}10 ${hex(4)} 1${rnd(2)}0110`, `${hex(6)} → ${hex(6)}`, hit('Node cluster synced'), ok('Reality buffer stable')], finale: ['██ WAKE UP ██', `Nodes: ${rnd(200)+56}`, `Streams: ${rnd(20)+8}`, 'Follow the white rabbit'] },
    '!overload':{ icon: '🔥', title: 'STRESS OVERLOAD', logs: () => [`[+] Baseline load 12%`, bar(47), bar(83), bar(100), hit('Threshold exceeded')], finale: ['██ PEAK REACHED ██', 'Load: 100% (demo)', `Temp: ${rnd(20)+70}°C`, 'Recovered to idle'] },
    '!shutdown':{ icon: '⛔', title: 'REMOTE SHUTDOWN', logs: () => [`[+] Enumerating services...`, `[*] Killing ${rnd(30)+9} processes`, ok('Sessions flushed'), hit('Power signal sent')], finale: ['██ SYSTEM OFFLINE ██', 'State: HALTED (demo)', 'Services: 0 running', 'Lights out'] },
    '!classified':{ icon: '📁', title: 'CLASSIFIED BRIEF', logs: () => [`[+] Opening clearance channel...`, `[*] Decrypting Team NASA-7 vault`, bar(66), hit('Intel assembled')], finale: ['██ TOP SECRET ██', `Doc #${hex(4)}`, 'Clearance: Team NASA-7', 'Data is synthetic (demo)'] },
    '!analysis':{ icon: '📊', title: 'THREAT ANALYSIS', logs: () => [`[+] Ingesting ${rnd(900)+100} signals`, `[*] Correlating indicators`, ok('Patterns isolated'), hit('Attribution model ready')], finale: ['██ ANALYSIS DONE ██', `Confidence: ${rnd(10)+89}%`, `Patterns: ${rnd(30)+11}`, 'Report sealed'] }
  };
  const op = ops[command] || ops['!hack'];
  const logs = op.logs();
  const topBar = '╔════════════════════╗';
  const botBar = '╚════════════════════╝';
  const head = () => [topBar, `${op.icon} ${op.title}`, `▸ TARGET : ${targetText}`, `▸ OP-ID  : Team NASA-${opId}`, `▸ IP     : ${fakeIp()}`, botBar, ''];
  const msgOut = await sock.sendMessage(jid, { text: [...head(), '> initializing exploit chain...'].join('\n') }, { quoted: msg });
  const shown = [];
  for (let i = 0; i < logs.length; i++) {
    await new Promise(r => setTimeout(r, 600));
    shown.push(logs[i]);
    const frame = [...head(), ...shown.slice(-9), i < logs.length - 1 ? '> running...' : '> finalizing...'].join('\n');
    try { await sock.sendMessage(jid, { text: frame }, { edit: msgOut.key }); }
    catch { await sock.sendMessage(jid, { text: frame }, { quoted: msg }); }
  }
  await new Promise(r => setTimeout(r, 650));
  const report = [topBar, `${op.icon} ${op.title} — RESULT`, botBar, '', ...op.finale, '', '──────────────', '🎭 Role-play only — no real system, account or data was touched. 💎 Team NASA'];
  await sock.sendMessage(jid, { text: report.join('\n') }, { quoted: msg });
}

function taskUserKey(msg, jid) {
  const sender = msg.key?.participant || msg.key?.participantPn || msg.key?.participantAlt || msg.key?.remoteJid || jid;
  return `${jid}|${normalizeJid(sender)}`;
}
async function loadTaskData() {
  try {
    const raw = JSON.parse(await readFile(TASK_DATA_FILE, 'utf8'));
    taskData = { notes: raw?.notes && typeof raw.notes === 'object' ? raw.notes : {}, todos: raw?.todos && typeof raw.todos === 'object' ? raw.todos : {}, reminders: Array.isArray(raw?.reminders) ? raw.reminders : [] };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Task data load failed:', error.message);
  }
}
function saveTaskData() {
  taskSaveQueue = taskSaveQueue.then(() => writeFile(TASK_DATA_FILE, JSON.stringify(taskData, null, 2), 'utf8')).catch(error => console.error('Task data save failed:', error.message));
  return taskSaveQueue;
}
function parseReminderDuration(raw) {
  const match = String(raw || '').match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const ms = n * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()]);
  return ms >= 10000 && ms <= 30 * 86400000 ? ms : null;
}
async function sendTaskReminder(reminder) {
  if (!activeSocket) return false;
  try {
    await activeSocket.sendMessage(reminder.chatJid, { text: `⏰ *NANCY NOVA AI REMINDER*\n${reminder.text}\n\n_Requested by ${displayJid(reminder.senderJid)}_` });
    return true;
  } catch (error) {
    console.error('Reminder delivery failed:', error.message);
    return false;
  }
}
async function pollReminders() {
  const now = Date.now();
  let changed = false;
  for (const reminder of [...taskData.reminders]) {
    if (!reminder || reminder.sentAt || Number(reminder.dueAt) > now) continue;
    if (await sendTaskReminder(reminder)) {
      reminder.sentAt = now;
      changed = true;
    } else {
      // Keep a failed reminder queued and retry on the next poll.
      reminder.dueAt = now + 60000;
      changed = true;
    }
  }
  if (changed) {
    taskData.reminders = taskData.reminders.filter(r => !r.sentAt || now - r.sentAt < 86400000);
    await saveTaskData();
  }
}
function startReminderPoller() {
  if (reminderPoller) clearInterval(reminderPoller);
  reminderPoller = setInterval(() => { pollReminders().catch(error => console.error('Reminder poll failed:', error.message)); }, 15000);
  reminderPoller.unref?.();
}

function makeHelp(owner, inGroup = false, page = 1) {
  const sections = [];
  sections.push([
    '◈━━━━━━━━━━━━━━━━━━━━━◈',
    '    💎 *N A N C Y   N O V A   A I* 💎',
    '      ✨ _premium whatsapp assistant_ ✨',
    '◈━━━━━━━━━━━━━━━━━━━━━◈',
    '┃ 🔷 *FULL COMMAND DIRECTORY*',
    `┃ 👑 ${OWNER_NAME}`,
    `┃ 🌟 ${TEAM_NAME} • v${BOT_VERSION}`,
    `┃ 🌐 ${WEBSITE_URL}`,
    '◈━━━━━━━━━━━━━━━━━━━━━◈'
  ]);
  if (owner) sections.push([
    '👑 *OWNER CONTROL PANEL*',
    '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 📊 !stats — Runtime statistics',
    '┃ 🛠️ !maintenance on/off — Maintenance',
    '┃ ⚙️ !mode public/private/admin — Access mode',
    '┃ 🤖 !ai on/off — AI auto-replies',
    '┃ 🔎 !aistatus — AI provider status (3 providers)',
    '┃ 🧪 !aitest — Live test all AI keys',
    '┃ 📝 !setbio <text> — Update bot bio',
    '┃ 🖼️ !setpic — Update bot profile picture',
    '┃ 👥 !addowner — Add an owner',
    '┃ 👥 !removeowner — Remove an owner',
    '┃ 👥 !owners — List owners',
    '┃ 🔐 !pair <number> — Link a device',
    '┃ 📡 !pairstatus — Check linked sessions',
    '┃ 🔓 !unpair  <number> — Remove a linked account',
    '┃ 💟 !autoreact on/off/status — Auto reactions',
    '┃ ⌨️ !autotyping on/off/status — Typing presence',
    '┃ 🎙️ !autorecording on/off/status — Recording presence',
    '┃ 👀 !autoviewstatus on/off/status — Auto-view contacts’ status',
    '┃ 💎 !autolikestatus on/off/status — Auto-react to status',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛'
  ]);
  sections.push([
    '📌 *GENERAL & PROFILE*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 🆘 !help — Show all commands',
    '┃ 📋 !menu — Open command menu',
    '┃ 🧾 !commands — Command directory',
    '┃ 🏓 !ping — Check if online',
    '┃ ℹ️ !about — About bot',
    '┃ ℹ️ !bot — About bot',
    '┃ 👑 !owner — Owner details',
    '┃ 👑 !ownerinfo — Owner details',
    '┃ 🌟 !team — Full project credits',
    '┃ 🔄 !restart — Restart bot (owner)',
    '┃ 🧩 !version — Bot version',
    '┃ ⏱️ !uptime — Runtime',
    '┃ 🕐 !time — Current time',
    '┃ 📅 !date — Current date',
    '┃ 🆔 !id — Chat/user ID',
    '┃ 👤 !userinfo — User information',
    '┃ 📱 !checknumber <number> — Check WhatsApp number',
    '┃ 🖼️ !getpp — Get profile picture',
    '┃ 📝 !getabout — Get about',
    '┃ 📝 !getbio — Get bio',
    '┃ 📡 !getstatus — Visible status',
    '┃ 📡 !getpresence — Presence',
    '┃ 📇 !vcard — Create a contact card',
    '┃ 🗑️ !del — Delete a replied message when allowed',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '👥 *GROUP COMMANDS*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 📋 !groupinfo — Group information',
    '┃ 👥 !members — List members (numbered)',
    '┃ 🔢 !membercount — Count members',
    '┃ 🧑‍⚖️ !admins — List admins',
    '┃ 👑 !creator — Group creator',
    '┃ 🆔 !groupid — Group ID',
    '┃ 📅 !groupcreated — Creation date',
    '┃ 📝 !description — Group description',
    '┃ 📜 !rules — Group rules',
    '┃ 📊 !groupstatus — Group status',
    '┃ ⚙️ !settings — Group settings',
    '┃ ⬆️ !promote — Promote a member',
    '┃ ⬇️ !demote — Demote an admin',
    '┃ ➕ !add — Add a member',
    '┃ ➖ !remove — Remove a member',
    '┃ 🦵 !kick — Kick a member',
    '┃ ⚠️ !warn — Warn a member',
    '┃ 📋 !warnings — View warnings',
    '┃ ♻️ !resetwarnings — Reset warnings',
    '┃ 🔇 !mute — Mute a member',
    '┃ 🔊 !unmute — Unmute a member',
    '┃ 🚫 !ban — Ban a member',
    '┃ ✅ !unban — Unban a member',
    '┃ ⛔ !restrict — Restrict a member',
    '┃ 🟢 !whitelist — Whitelist control',
    '┃ 🔴 !blacklist — Blacklist control',
    '┃ 📢 !tagall — Tag everyone (numbered list)',
    '┃ 🙈 !hidetag — Silent tag all',
    '┃ 🛡️ !tagadmins — Tag admins (numbered list)',
    '┃ 👤 !tagmembers — Tag members (numbered list)',
    '┃ 🎯 !mention — Mention a member',
    '┃ 🎲 !randommember — Pick a random member',
    '┃ 💤 !inactive — Inactive members',
    '┃ 🏷️ !groupname — Set group name',
    '┃ 📝 !groupdesc — Set group description',
    '┃ 📜 !setrules — Set group rules',
    '┃ 📣 !announcement — Post announcement',
    '┃ ✏️ !editinfo — Edit group info',
    '┃ ➕ !memberadd — Add member helper',
    '┃ ⏳ !disappearing — Disappearing messages',
    '┃ 👋 !welcome — Welcome messages',
    '┃ 🚪 !goodbye — Goodbye messages',
    '┃ 🔗 !invite — Get invite link',
    '┃ 🔄 !revoke — Reset invite link',
    '┃ 🚶 !leave — Bot leaves group',
    '┃ 🚫 !antilink — Block links (on / del / off)',
    '┃ 📢 !antimention — Block member tagging (on / del / off)',
    '┃ 🚫 !antiinvite — Block invite links',
    '┃ 🚫 !antiword — Block bad words',
    '┃ 🚫 !antimedia — Block media',
    '┃ 🧯 !antispam — Anti-spam',
    '┃ 🌊 !antiflood — Anti-flood',
    '┃ ⚠️ !warningsystem — Warning system',
    '┃ 🕵️ !antidelete — Anti-delete (chats | grp | inbox)',
    '┃ 🔒 !closegrp — Close group',
    '┃ 🔓 !opengrp — Open group',
    '┃ 📊 !poll — Create a poll',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '🧰 *TOOLS & PRODUCTIVITY*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 🧮 !calc <expression> — Calculate',
    '┃ 🎲 !roll [sides] — Roll dice',
    '┃ 🔐 !password [8-32] — Generate password',
    '┃ 🔠 !upper — Uppercase text',
    '┃ 🔠 !uppercase — Uppercase text',
    '┃ 🔡 !lower — Lowercase text',
    '┃ 🔡 !lowercase — Lowercase text',
    '┃ 🔄 !reverse — Reverse text',
    '┃ 🔢 !count — Count words and characters',
    '┃ 📝 !note add <text> — Save a note',
    '┃ 📚 !notes — List notes',
    '┃ 🗑️ !note delete <id> — Delete a note',
    '┃ 🧹 !note clear — Clear notes',
    '┃ ☑️ !todo add <text> — Add task',
    '┃ 📋 !todos — List tasks',
    '┃ ✅ !done <id> — Complete task',
    '┃ 🧹 !todo clear — Clear tasks',
    '┃ ⏰ !remind 10m <text> — Set reminder',
    '┃ 🔔 !reminders — List reminders',
    '┃ ❌ !cancelreminder <id> — Cancel reminder',
    '┃ 🔳 !qr <text> — QR image',
    '┃ 🔳 !toqr <text> — QR image',
    '┃ 🔤 !setfont <style> <text> — Styled text',
    '┃ 📦 !apk <app> — Direct APK lookup when verifiable',
    '┃ 🟢 !listonline — Observed presence only',
    '┃ 🟢 !listoffline — Observed presence only',
    '┃ 📡 !presence — Presence controls',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '🧠 *AI ASSISTANTS (3 PROVIDERS)*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ ⚡ !grok — GroqCloud (fastest)',
    '┃ 🌟 !gemini — Google Gemini',
    '┃ 🔀 !openrouter — OpenRouter',
    '┃ 🧹 !grok clear — Reset this chat memory',
    '┃ 🧪 !grok test — Live key check',
    '┃ 🔎 !aistatus — Provider status (owner)',
    '┃ 🧪 !aitest — Test all keys live (owner)',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '👑 *NANCY NOVA PHOTOLAB & CREATIVE*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 🎨 !generate <prompt> — Smart AI image generation',
    '┃ 🎨 !imagine <prompt> — Smart AI image generation',
    '┃ 🖼️ !dalle <prompt> — High-quality AI image',
    '┃ 🎭 !anime <prompt> — Anime-style art',
    '┃ 🎬 !aivideo <prompt> — temporarily disabled (provider removed)',
    '┃ 🪄 !edit <effect> — Edit a replied image locally',
    '┃ 🔁 !variations — Local image variations',
    '┃ ✍️ !caption <topic> — Caption writing',
    '┃ 📝 !rewrite <text> — Rewrite text',
    '┃ 🪪 !bio <details> — Write a bio',
    '┃ 📖 !story <idea> — Write a story',
    '┃ 💡 !ideas <topic> — Brainstorm ideas',
    '┃ 📣 !post <topic> — Draft a social post',
    '┃ 🔥 !fire — Text effect',
    '┃ 😈 !devil — Text effect',
    '┃ 👾 !hacker — Text effect',
    '┃ 🧊 !ice — Text effect',
    '┃ 🟩 !matrixfx — Text effect',
    '┃ 💡 !neon — Text effect',
    '┃ ✨ !impressive — Text effect',
    '┃ ❄️ !snow — Text effect',
    '┃ 🌟 !nancy — Text effect',
    '┃ 🍃 !leaves — Text effect',
    '┃ 💗 !blackpink — Text effect',
    '┃ 💗 !blckpinkstyle — Text effect',
    '┃ 🏳️ !flagtext — Text effect',
    '┃ 🎨 !devbrn — Text effect',
    '┃ 🐉 !dragonball — Text effect',
    '┃ 🔠 !typography — Text effect',
    '┃ 👑 !royaltext — Text effect',
    '┃ 🩸 !deadpool — Text effect',
    '┃ 👑 !royal — Text effect',
    '┃ 🌌 !galaxywallpaper — Text effect',
    '┃ 🟪 !pixelglitch — Text effect',
    '┃ 🧸 !cartoonstyle — Text effect',
    '┃ 🎨 !graffiti — Text effect',
    '┃ 🐻 !bear — Text effect',
    '┃ 🖼️ !sticker — Make a sticker',
    '┃ 🖼️ !toimage — Sticker to image',
    '┃ 🎥 !tovideo — Animated sticker to video',
    '┃ 🗜️ !compress — Compress image',
    '┃ 📐 !resize — Resize image',
    '┃ 📷 !readqr — Read a QR image',
    '┃ 🔎 !ocr — Extract text from image',
    '┃ 📄 !pdf — Make a PDF',
    '┃ 📝 !summarizepdf — Summarize a PDF',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '🎙️ *VOICE & AUDIO*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 📝 !transcribe — Transcribe replied audio',
    '┃ 🔊 !tts <text> — Text to speech (voice note)',
    '┃ ⚙️ !setprefix <char> — Change command prefix (owner)',
    '┃ 🎤 Send a voice note to use voice-input support',
    '┃ ⚙️ Voice provider depends on local tools/API configuration',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '🎭 *ANIME, FUN & GAMES*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 🐱 !hneko — Anime image',
    '┃ 🐱 !hwaifu — Anime image',
    '┃ 🐱 !konachan — Anime image',
    '┃ 🐱 !neko — Anime image',
    '┃ 💞 !shorta — Fun',
    '┃ 💞 !husby — Fun',
    '┃ 😂 !joke — Random joke',
    '┃ 💬 !quote — Random quote',
    '┃ 💪 !motivate — Motivation',
    '┃ 📎 !fact — Random fact',
    '┃ 🎲 !flip — Flip a coin',
    '┃ ❓ !truth — Truth prompt',
    '┃ 😜 !dare — Dare prompt',
    '┃ 🤝 !slap — Fun action',
    '┃ 🤗 !hug — Fun action',
    '┃ 😘 !kiss — Fun action',
    '┃ 💍 !marry — Fun action',
    '┃ 💔 !divorce — Fun action',
    '┃ 🚔 !fakeban — Fun action',
    '┃ 🚔 !jail — Fun action',
    '┃ 🚔 !wanted — Fun action',
    '┃ 🐍 !snake — Game help',
    '┃ 🎮 !tetris — Game help',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '🎬 *MEDIA SEARCH & DOWNLOAD*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 🎵 !audio <query> — Audio download',
    '┃ 🎵 !song <query> — Audio download',
    '┃ 🎵 !play <query> — Audio download (alias)',
    '┃ 🎵 !ytmp3 <query> — YouTube audio',
    '┃ 🎥 !video <query> — Video download',
    '┃ 🎥 !yt <query> — YouTube video',
    '┃ 🎥 !ytmp4 <query> — YouTube video',
    '┃ 📱 !tiktok <URL> — TikTok media',
    '┃ 📘 !facebook <URL> — Facebook media',
    '┃ 📘 !fb <URL> — Facebook media',
    '┃ 📸 !instagram <URL> — Instagram media',
    '┃ 📸 !ig <URL> — Instagram media',
    '┃ 🎼 !lyrics <song> — Lyrics lookup/support',
    '┃ 💎 !tostatus — Post replied media to YOUR status',
    '┃ 💎 !tomystatus — Post replied media to YOUR status',
    '┃ 👁️ !br — Reveal replied view-once media',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '📚 *RELIGION & SCRIPTURE*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 📖 !bible <book chapter:verse> — Bible verse',
    '┃ 📚 !biblelist — Bible books',
    '┃ 🕌 !quran <surah:ayah> — Quran ayah',
    '┃ 🕌 !ayah <surah:ayah> — Quran ayah',
    '┃ 🕉️ !gita — availability depends on provider',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '⚽ *SPORTS*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ ⚽ !livescore — Live scores',
    '┃ ⚽ !fifamatches — FIFA matches',
    '┃ ⚽ !fifaupcoming — Upcoming matches',
    '┃ 🏆 !fifascores — FIFA scores',
    '┃ 🏆 !fifastandings — FIFA standings',
    '┃ 🏆 !gameevents — Game events',
    '┃ 🏴 !epl — Premier League',
    '┃ 🏴 !bundesliga — Bundesliga',
    '┃ 🏴 !laliga — La Liga',
    '┃ 🏴 !seria — Serie A',
    '┃ 🌍 !ulc — Champions League',
    '┃ 🌍 !euros — Euros',
    '┃ 🌍 !kpl — KPL',
    '┃ 🌍 !livehighlights — Highlights',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '🧪 *CYBER SIMULATION (DEMO ONLY)*', '┏━━━━━━━━━━━━━━━━━━━━━━┓',
    '┃ 🖥️ !hack — Demo only',
    '┃ 🖥️ !scan — Demo only',
    '┃ 🖥️ !trace — Demo only',
    '┃ 🖥️ !track — Demo only',
    '┃ 🖥️ !ipcheck — Demo only',
    '┃ 🔐 !access — Demo only',
    '┃ 🔐 !root — Demo only',
    '┃ 🔐 !bypass — Demo only',
    '┃ 🔐 !breach — Demo only',
    '┃ 🔐 !decrypt — Demo only',
    '┃ 🔠 !encrypt — Demo only',
    '┃ 🔠 !decode — Demo only',
    '┃ 🔠 !encode — Demo only',
    '┃ 🔠 !firewall — Demo only',
    '┃ 🔠 !virus — Demo only',
    '┃ 🗄️ !database — Demo only',
    '┃ 🗄️ !terminal — Demo only',
    '┃ 🗄️ !matrix — Demo only',
    '┃ 🗄️ !overload — Demo only',
    '┃ 🚨 !shutdown — Demo only',
    '┃ 🚨 !classified — Demo only',
    '┃ 🚨 !analysis — Demo only',
    '┗━━━━━━━━━━━━━━━━━━━━━━┛',
    '',
    '',
    'ℹ️ Some commands depend on APIs, WhatsApp permissions, external sites, or local tools.',
    '🌟 *Nancy Nova AI 💎 • Team NASA*',
    `🌐 ${WEBSITE_URL}`
  ]);
  if (inGroup) sections.push(['', '👥 *GROUP CONTEXT*', 'Group moderation requires WhatsApp group permissions and, for admin actions, bot-admin rights.']);
  // Cosmic-star styling is applied once to the complete command directory so
  // all categories share one consistent border system without dropping commands.
  return sections.flat().map((line) => {
    if (/^┏━+┓$/.test(line) || /^┗━+┛$/.test(line)) return '🌟══════════ ⋆｡°✩°｡⋆ ══════════🌟';
    if (line.startsWith('┃')) return `💎 ${line.slice(1).trim()}`;
    if (line.includes('FULL COMMAND DIRECTORY')) return '🌟･ﾟ: *NANCY NOVA COMMAND DIRECTORY* :ﾟ･🌟';
    if (line.startsWith('╭━━━')) return `💎･ﾟ: *${BOT_NAME.toUpperCase()}* :ﾟ･✨`;
    if (line.startsWith('╰═══')) return '🌟 ⋆｡°✩°｡⋆ 💎';
    return line;
  }).join('\n');
}
async function sendMenu(sock, jid, owner, inGroup) {
  const menuText = prefixForDisplay(makeHelp(owner, inGroup), getCommandPrefix(sock));
  if (menuText.length > 60000) throw new Error('Menu exceeds WhatsApp message limits; reduce command descriptions.');
  // Deliver the whole menu as ONE message: the profile image carries the full
  // command directory as its caption, so the bot profile and the command list no
  // longer arrive as two separate messages.
  const header = [
    ''
  ].join('\n');
  const fullMenu = `${menuText}`;
  let menuDelivered = false;
  try {
    const image = await getBotMenuImage(sock);
    if (image?.length) {
      await sock.sendMessage(jid, { image, caption: fullMenu });
      menuDelivered = true;
    }
  } catch (error) { console.warn('Menu profile image unavailable; sending text-only menu:', error.message); }
  if (!menuDelivered) await sock.sendMessage(jid, { text: fullMenu });
  await sendProfileSong(sock, jid);
}
async function downloadToTemp(sock, message, prefix = 'media') {
  await mkdir(TEMP_DIR, { recursive: true });
  const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
  if (!buffer?.length) throw new Error('No media data found');
  const file = path.join(TEMP_DIR, `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await writeFile(file, buffer);
  return { buffer, file };
}
async function findMediaTarget(sock, msg) {
  const quoted = getQuotedMessage(msg);
  if (quoted) {
    const quotedMsg = { key: { remoteJid: msg.key.remoteJid, participant: quoted.participant, id: quoted.stanzaId }, message: quoted.message };
    const content = unwrapMessage(quoted.message);
    if (content.imageMessage || content.stickerMessage || content.documentMessage || content.videoMessage || content.audioMessage) return quotedMsg;
  }
  const content = unwrapMessage(msg.message);
  if (content.imageMessage || content.stickerMessage || content.documentMessage || content.videoMessage || content.audioMessage) return msg;
  return null;
}
async function canUseConfiguredMode(sock, msg, jid, owner) {
  if (owner) return true;
  if (botSettings.mode === 'public') return true;
  if (botSettings.mode === 'private') return false;
  if (botSettings.mode === 'admin') {
    if (!jid.endsWith('@g.us')) return false;
    try {
      const metadata = await sock.groupMetadata(jid);
      const senderCandidates = [messageSender(msg), msg.key.participantPn, msg.key.participantAlt].filter(Boolean).map(normalizeJid);
      const entry = (metadata.participants || []).find(p => [p.id,p.jid,p.phoneNumber,p.lid,participantJid(p)].filter(Boolean).some(j => senderCandidates.includes(normalizeJid(j))));
      return isAdminParticipant(entry);
    } catch { return false; }
  }
  return false;
}
function modeLabel(mode) { return mode === 'public' ? '🌍 PUBLIC — everyone can use the bot' : mode === 'private' ? '🔒 PRIVATE — owner only' : '🛡️ ADMIN — group admins only'; }
async function getGroupContext(sock, msg, chatJid, owner) {
  if (!chatJid.endsWith('@g.us')) throw new Error('This command only works inside a WhatsApp group.');
  const metadata = await sock.groupMetadata(chatJid);
  const sender = messageSender(msg);
  const senderCandidates = [sender, msg.key.participantPn, msg.key.participantAlt].filter(Boolean).map(normalizeJid);
  const participants = metadata.participants || [];
  const senderEntry = participants.find(p => [p.id, p.jid, p.phoneNumber, p.lid, participantJid(p)].filter(Boolean).some(j => senderCandidates.includes(normalizeJid(j))));
  const senderIsAdmin = isAdminParticipant(senderEntry);
  if (!owner && !senderIsAdmin) throw new Error('Permission denied. Only group admins and the bot owner can use group commands.');
  const botCandidates = [sock.user?.id, sock.user?.lid, sock.user?.jid, sock.user?.phoneNumber, `${OWNER_NUMBER}@s.whatsapp.net`].filter(Boolean).map(normalizeJid);
  const botEntry = participants.find(p => [p.id, p.jid, p.phoneNumber, p.lid, participantJid(p)].filter(Boolean).some(j => botCandidates.includes(normalizeJid(j))));
  const botIsAdmin = isAdminParticipant(botEntry);
  return { metadata, participants, senderIsAdmin, botIsAdmin };
}
function targetFromQuotedOrArg(msg, args) {
  const quoted = getQuotedMessage(msg);
  if (quoted?.participant) return quoted.participant;
  const raw = args[0]?.replace(/[^0-9]/g, '');
  if (raw && raw.length >= 7 && raw.length <= 15) return `${raw}@s.whatsapp.net`;
  return '';
}
async function sendGroupHelp(sock, chatJid, page = 1, msg = null) {
  const pages = {
    1: {
      title: 'GROUP OVERVIEW',
      lines: [
        '✦ !groupinfo — show group information',
        '✦ !groupid — show the group JID',
        '✦ !groupcreated — show the creation date',
        '✦ !members — list group members',
        '✦ !membercount — count members and admins',
        '✦ !admins — list group admins',
        '✦ !creator — show group creator when available',
        '✦ !description — show group description',
        '✦ !rules — display configured group rules'
      ]
    },
    2: {
      title: 'MEMBER MANAGEMENT',
      lines: [
        '✧ !promote @member — promote a member',
        '✧ !demote @member — demote an admin',
        '✧ !kick @member — remove a member',
        '✧ !add 2547XXXXXXXX — add a phone number',
        '✧ Reply to a member message where supported',
        '✧ The bot must be a group admin for admin actions'
      ]
    },
    3: {
      title: 'MENTIONS & TAGGING',
      lines: [
        '⋆ !tagall — mention all group members',
        '⋆ !hidetag message — mention members with a message',
        '⋆ !tagadmins — mention group admins',
        '⋆ Use mentions respectfully and avoid spam'
      ]
    },
    4: {
      title: 'GROUP SETTINGS',
      lines: [
        '✦ !groupstatus — show group settings',
        '✦ !settings — show group settings',
        '✦ !setrules text — save group rules',
        '✦ !announce on|off — toggle announcement mode',
        '✦ !welcome on|off — toggle welcome messages',
        '✦ !antipromote on|off — toggle promotion protection',
        '✦ Available settings depend on the enabled bot commands'
      ]
    },
    5: {
      title: 'MODERATION & HELP',
      lines: [
        '✧ !group 1 — overview commands',
        '✧ !group 2 — member management',
        '✧ !group 3 — mentions and tagging',
        '✧ !group 4 — group settings',
        '✧ !group 5 — moderation and help',
        '✧ Use !menu to view the full bot menu',
        '✧ Some actions require the bot to be a group admin'
      ]
    }
  };
  const parsed = Number.parseInt(String(page ?? '1'), 10);
  const selectedPage = Number.isFinite(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 1;
  const section = pages[selectedPage];
  const text = [
    '✦⋆━━━━━━━━━━━━━━━━━━━━⋆✦',
    '       💎 *NANCY NOVA AI 🌟 — GROUP COMMANDS*',
    `       ✧ *${section.title}* ✧`,
    '✦⋆━━━━━━━━━━━━━━━━━━━━⋆✦',
    ...section.lines,
    '',
    `📖 Page *${selectedPage}/5*  •  Navigate with *!group 1* to *!group 5*`,
    '✦⋆━━━━━━━━━━━━━━━━━━━━⋆✦',
    '🤖 *Team NASA*'
  ].join('\n');
  return sock.sendMessage(chatJid, { text }, msg ? { quoted: msg } : {});
}

async function groupCommand(sock, msg, chatJid, command, args, argument, owner) {
  const { metadata, participants, botIsAdmin } = await getGroupContext(sock, msg, chatJid, owner);
  const groupPrefix = getCommandPrefix(sock);
  // Every usage hint / status reply inside group commands shows the prefix the
  // owner actually set (e.g. "." instead of a hardcoded "!").
  const send = text => sock.sendMessage(chatJid, { text: typeof text === 'string' ? prefixForDisplay(text, groupPrefix) : text }, { quoted: msg });
  const requireBotAdmin = () => { if (!botIsAdmin) throw new Error('Please make Nancy Nova AI a group admin before using this command.'); };
  const data = getGroupData(chatJid);
  const sender = normalizeJid(messageSender(msg));
  const target = targetFromQuotedOrArg(msg, args);
  const targetParticipant = target ? participants.find(p => [p.id,p.jid,p.phoneNumber,p.lid].filter(Boolean).some(j => normalizeJid(j) === normalizeJid(target))) : null;
  const targetJid = participantJid(targetParticipant) || target;
  const adminJids = participants.filter(isAdminParticipant).map(participantJid).filter(Boolean);
  const memberJids = participants.map(participantJid).filter(Boolean);
  const mentionText = jids => jids.map(displayJid).join(' ');
  // Numbered, one-per-line list (keeps the real @mentions via the `mentions` field).
  const numberedMentions = jids => jids.map((j, i) => `${i + 1}. ${displayJid(j)}`).join('\n');
  const requireTarget = () => { if (!targetJid) throw new Error(prefixForDisplay(`Reply to a member or provide a phone number. Example: ${command} 2547XXXXXXXX`, groupPrefix)); };
  const requireTargetNotBot = () => {
    requireTarget();
    if (isOwnAccountJid(targetJid, sock)) throw new Error('That target is the bot account.');
  };
  const settingValue = args[0]?.toLowerCase();
  const onOff = value => ['on','enable','enabled','yes','true'].includes(value) ? true :
    ['off','disable','disabled','no','false'].includes(value) ? false : null;

  switch (command) {
    case '!group':
      return sendGroupHelp(sock, chatJid, args[0] || 1, msg);

    case '!groupinfo': {
      const admins = participants.filter(isAdminParticipant);
      const creator = metadata.owner || metadata.creator || metadata.subjectOwner || 'Not available';
      await send([
        '*GROUP INFORMATION*',
        `Name: ${metadata.subject || 'Unknown'}`,
        `Members: ${participants.length}`,
        `Admins: ${admins.length}`,
        `Creator: ${displayJid(creator)}`,
        `Group ID: ${chatJid}`,
        `Created: ${metadata.creation ? new Date(Number(metadata.creation) * 1000).toLocaleString() : 'Not available'}`,
        `Description: ${metadata.desc || 'No description'}`
      ].join('\n')); break;
    }
    case '!members':
      await sock.sendMessage(chatJid, { text: `*GROUP MEMBERS (${participants.length})*\n${participants.map((p,i)=>`${i+1}. ${displayJid(participantJid(p))}${isAdminParticipant(p)?' [ADMIN]':''}`).join('\n')}`, mentions: memberJids }, { quoted: msg }); break;
    case '!membercount':
      await send(`Members: ${participants.length}\nAdmins: ${participants.filter(isAdminParticipant).length}`); break;
    case '!admins':
      await sock.sendMessage(chatJid, { text: `*GROUP ADMINS*\n${adminJids.map((j,i)=>`${i+1}. ${displayJid(j)}`).join('\n') || 'No admins found.'}`, mentions: adminJids }, { quoted: msg }); break;
    case '!creator': {
      const creator = metadata.owner || metadata.creator || metadata.subjectOwner;
      await send(`Group creator: ${creator ? displayJid(creator) : 'WhatsApp did not provide creator information.'}`); break;
    }
    case '!groupid': await send(`Group ID:\n${chatJid}`); break;
    case '!groupcreated': await send(`Group creation time: ${metadata.creation ? new Date(Number(metadata.creation) * 1000).toLocaleString() : 'Not available from WhatsApp metadata.'}`); break;
    case '!description': await send(`*GROUP DESCRIPTION*\n${metadata.desc || 'No description set.'}`); break;
    case '!rules': await send(`*GROUP RULES*\n${data.rules || 'No rules have been configured. Use !setrules text.'}`); break;
    case '!groupstatus': case '!settings':
      await send(['*GROUP STATUS*',
        `Announcement: ${data.settings.announcement ? 'ON' : 'OFF'}`,
        `Edit group info restriction: ${data.settings.editInfo ? 'ON' : 'OFF'}`,
        `Member add mode: ${data.settings.memberAdd}`,
        `Disappearing: ${data.settings.disappearing ? `${data.settings.disappearing}s` : 'OFF'}`,
        `Welcome: ${data.settings.welcome ? 'ON' : 'OFF'}`,
        `Anti-link: ${data.settings.antiLink ? `ON (${String(data.settings.antiLinkMode || 'warn').toUpperCase()})` : 'OFF'}`,
        `Anti-mention: ${data.settings.antiMention ? `ON (${String(data.settings.antiMentionMode || 'del').toUpperCase()})` : 'OFF'}`,
        `Anti-invite: ${data.settings.antiInvite ? 'ON' : 'OFF'}`,
        `Anti-spam: ${data.settings.antiSpam ? 'ON' : 'OFF'}`,
        `Anti-flood: ${data.settings.antiFlood ? 'ON' : 'OFF'}`,
        `Anti-word: ${data.settings.antiWord ? 'ON' : 'OFF'}`,
        `Anti-media: ${data.settings.antiMedia ? 'ON' : 'OFF'}`,
        `Anti-delete: ${data.settings.antiDelete ? `ON (${data.settings.antiDeleteMode})` : 'OFF'}`,
        `Goodbye: ${data.settings.goodbye ? 'ON' : 'OFF'}`,
        `Bot mode: ${botSettings.mode.toUpperCase()}`,
        `Warning system: ${data.settings.warningSystem ? 'ON' : 'OFF'}`].join('\n')); break;

    case '!setrules':
      if (!argument) return send('Usage: !setrules Be respectful...');
      data.rules = argument.slice(0, 5000); groupRules.set(chatJid, data.rules); await saveGroupData(); await send('📜 *GROUP RULES SAVED*\n✅ Rules are now stored permanently.'); break;

    case '!add': {
      requireBotAdmin();
      const rawNumber = String(args[0] || '').replace(/[^0-9]/g, '');
      if (!rawNumber || rawNumber.length < 7 || rawNumber.length > 15) {
        return send('Usage: !add 2547XXXXXXXX\\nUse the member phone number with country code, without needing the + sign.');
      }
      const targetJid = `${rawNumber}@s.whatsapp.net`;
      if (participants.some(p => [p.id, p.jid, p.phoneNumber, p.lid, participantJid(p)].filter(Boolean).some(value => normalizeJid(value) === normalizeJid(targetJid)))) {
        return send(`@${rawNumber} is already in this group.`,);
      }
      const result = await sock.groupParticipantsUpdate(chatJid, [targetJid], 'add');
      const item = Array.isArray(result) ? result[0] : result;
      const status = Number(item?.status || item?.content?.status || 200);
      if (status >= 200 && status < 300) {
        await send(`📨 WhatsApp processed the add request for @${rawNumber}.\\nIf the member was not added, their privacy settings may require an invitation link.`);
      } else {
        const code = item?.status || item?.content?.status || 'unknown';
        const inviteCode = await sock.groupInviteCode(chatJid).catch(() => null);
        await send(`⚠️ WhatsApp could not directly add @${rawNumber} (status: ${code}).\\nTheir privacy settings may require an invitation link.${inviteCode ? `\\nGroup invite: https://chat.whatsapp.com/${inviteCode}` : ''}`);
      }
      break;
    }

    case '!promote': case '!demote': case '!remove': case '!kick':
      requireBotAdmin(); requireTargetNotBot();
      if (isConfiguredOwner(targetJid) && ['!remove','!kick','!demote'].includes(command)) throw new Error('The configured bot owner is protected.');
      await sock.groupParticipantsUpdate(chatJid, [targetJid], command === '!promote' ? 'promote' : command === '!demote' ? 'demote' : 'remove');
      await send(`Member ${command === '!promote' ? 'promoted' : command === '!demote' ? 'demoted' : 'removed'} successfully.`); break;

    case '!warn': {
      requireTarget();
      data.warnings[normalizeJid(targetJid)] = Number(data.warnings[normalizeJid(targetJid)] || 0) + 1;
      const count = data.warnings[normalizeJid(targetJid)];
      await saveGroupData();
      await sock.sendMessage(chatJid, { text: `${displayJid(targetJid)} has been warned. Warnings: ${count}`, mentions: [targetJid] }, { quoted: msg });
      if (count >= 3 && botIsAdmin) {
        try { await sock.groupParticipantsUpdate(chatJid, [targetJid], 'remove'); delete data.warnings[normalizeJid(targetJid)]; await saveGroupData(); await send(`${displayJid(targetJid)} reached 3 warnings and was removed.`); } catch {}
      }
      break;
    }
    case '!warnings': {
      requireTarget();
      await send(`${displayJid(targetJid)} has ${Number(data.warnings[normalizeJid(targetJid)] || 0)} warning(s).`); break;
    }
    case '!resetwarnings':
      requireTarget(); delete data.warnings[normalizeJid(targetJid)]; await saveGroupData(); await send(`Warnings reset for ${displayJid(targetJid)}.`); break;
    case '!mute': case '!restrict': {
      requireTarget();
      const durationToken = args.find(a => /^\d+\s*(s|m|h|d)?$/i.test(a)) || '10m';
      const until = Date.now() + parseDuration(durationToken);
      data.muted[normalizeJid(targetJid)] = until; await saveGroupData();
      await sock.sendMessage(chatJid, { text: `${displayJid(targetJid)} is now ${command === '!mute' ? 'muted' : 'restricted'} for ${remainingTime(until)}.`, mentions: [targetJid] }, { quoted: msg }); break;
    }
    case '!unmute':
      requireTarget(); delete data.muted[normalizeJid(targetJid)]; await saveGroupData(); await send(`${displayJid(targetJid)} is no longer muted/restricted.`); break;
    case '!ban': {
      requireBotAdmin(); requireTargetNotBot();
      const until = Date.now() + parseDuration(args[1] || '1d');
      data.banned[normalizeJid(targetJid)] = until;
      await sock.groupParticipantsUpdate(chatJid, [targetJid], 'remove');
      await saveGroupData(); await send(`${displayJid(targetJid)} was banned from bot-managed interaction for ${remainingTime(until)}.`); break;
    }
    case '!unban':
      requireTarget(); delete data.banned[normalizeJid(targetJid)]; await saveGroupData(); await send(`Ban removed for ${displayJid(targetJid)}.`); break;
    case '!whitelist':
      requireTarget(); {
        const key = normalizeJid(targetJid);
        if (!data.whitelist.includes(key)) data.whitelist.push(key);
        data.blacklist = data.blacklist.filter(x => x !== key);
        await saveGroupData(); await send(`${displayJid(targetJid)} added to the moderation whitelist.`);
      } break;
    case '!blacklist':
      requireTarget(); {
        const key = normalizeJid(targetJid);
        if (!data.blacklist.includes(key)) data.blacklist.push(key);
        data.whitelist = data.whitelist.filter(x => x !== key);
        await saveGroupData(); await send(`${displayJid(targetJid)} added to the moderation blacklist.`);
      } break;

    case '!tagall': case '!hidetag': {
      const body = argument || (command === '!hidetag' ? 'Attention everyone.' : 'Attention group members:');
      const list = numberedMentions(memberJids);
      await sock.sendMessage(chatJid, { text: command === '!hidetag' ? body : `${body}\n\n${list}`, mentions: memberJids }, { quoted: msg }); break;
    }
    case '!mention': {
      requireTarget();
      await sock.sendMessage(chatJid, { text: `${argument.replace(/^\S+\s*/, '') || 'Mentioned member:'} ${displayJid(targetJid)}`, mentions: [targetJid] }, { quoted: msg }); break;
    }
    case '!tagadmins':
      await sock.sendMessage(chatJid, { text: `${argument || 'Attention admins:'}\n\n${numberedMentions(adminJids)}`, mentions: adminJids }, { quoted: msg }); break;
    case '!tagmembers': {
      const nonAdmins = participants.filter(p => !isAdminParticipant(p)).map(participantJid).filter(Boolean);
      await sock.sendMessage(chatJid, { text: `${argument || 'Attention members:'}\n\n${numberedMentions(nonAdmins)}`, mentions: nonAdmins }, { quoted: msg }); break;
    }
    case '!randommember': {
      const candidates = participants.filter(p => !isAdminParticipant(p));
      const chosen = participantJid(candidates[Math.floor(Math.random() * candidates.length)] || participants[Math.floor(Math.random() * participants.length)]);
      if (!chosen) return send('No member was available.');
      await sock.sendMessage(chatJid, { text: `Random member: ${displayJid(chosen)}`, mentions: [chosen] }, { quoted: msg }); break;
    }
    case '!inactive': {
      const days = Number((args[0] || '7').replace(/[^0-9.]/g,'')) || 7;
      const cutoff = Date.now() - days * 86400000;
      const inactive = participants.filter(p => {
        const j = normalizeJid(participantJid(p));
        return !isAdminParticipant(p) && (!data.activity[j] || data.activity[j] < cutoff);
      }).map(participantJid).filter(Boolean);
      await sock.sendMessage(chatJid, { text: `Members not seen by the bot in the last ${days} day(s):\n\n${inactive.length ? numberedMentions(inactive) : 'None recorded.'}`, mentions: inactive }, { quoted: msg }); break;
    }

    case '!groupname':
      if (!argument) return send('Usage: !groupname New group name');
      requireBotAdmin(); await sock.groupUpdateSubject(chatJid, argument.slice(0,100)); await send('Group name updated.'); break;
    case '!groupdesc':
      if (!argument) return send('Usage: !groupdesc New group description');
      requireBotAdmin(); await sock.groupUpdateDescription(chatJid, argument.slice(0,2048)); await send('Group description updated.'); break;
    case '!closegrp': case '!opengrp': {
      requireBotAdmin();
      const closing = command === '!closegrp';
      await sock.groupSettingUpdate(chatJid, closing ? 'announcement' : 'not_announcement');
      data.settings.announcement = closing;
      await saveGroupData();
      await send(closing
        ? '🔒 *GROUP CLOSED*\n👮 Only group admins can send messages now.\n🛡️ Nancy Nova AI is enforcing admin-only mode.'
        : '🔓 *GROUP OPENED*\n💬 Everyone can send messages again.\n✨ Welcome back, everyone!');
      break;
    }
    case '!announcement': {
      const value = onOff(settingValue);
      if (value === null) return send('Usage: !announcement on/off');
      requireBotAdmin(); await sock.groupSettingUpdate(chatJid, value ? 'announcement' : 'not_announcement');
      data.settings.announcement = value; await saveGroupData(); await send(`Announcement mode ${value ? 'enabled' : 'disabled'}.`); break;
    }
    case '!editinfo': {
      const value = onOff(settingValue);
      if (value === null) return send('Usage: !editinfo on/off');
      requireBotAdmin(); await sock.groupSettingUpdate(chatJid, value ? 'locked' : 'unlocked');
      data.settings.editInfo = value; await saveGroupData(); await send(`Group info editing restriction ${value ? 'enabled' : 'disabled'}.`); break;
    }
    case '!memberadd': {
      if (!['all','admin'].includes(settingValue)) return send('Usage: !memberadd all/admin');
      requireBotAdmin();
      if (typeof sock.groupMemberAddMode !== 'function') throw new Error('This Baileys version does not expose the group member-add setting.');
      await sock.groupMemberAddMode(chatJid, settingValue === 'admin' ? 'admin_add' : 'all_member_add');
      data.settings.memberAdd = settingValue; await saveGroupData(); await send(`Member-add mode set to ${settingValue}.`); break;
    }
    case '!disappearing': {
      const value = settingValue;
      const seconds = value === 'off' ? 0 : value === '1d' ? 86400 : value === '7d' ? 604800 : value === '90d' ? 7776000 : Number(value);
      if (![0,86400,604800,7776000].includes(seconds)) return send('Usage: !disappearing off/1d/7d/90d');
      requireBotAdmin();
      if (typeof sock.groupToggleEphemeral !== 'function') throw new Error('This Baileys version does not expose disappearing-message controls.');
      await sock.groupToggleEphemeral(chatJid, seconds);
      data.settings.disappearing = seconds; await saveGroupData(); await send(`Disappearing messages ${seconds ? `set to ${seconds / 86400} day(s)` : 'disabled'}.`); break;
    }
    case '!welcome': {
      const value = onOff(settingValue);
      if (value !== null) { data.settings.welcome = value; data.settings.welcomeConfigured = true; await saveGroupData(); return send(`${value ? '🟢' : '🔴'} Welcome messages are now ${value ? 'ENABLED' : 'DISABLED'}.`); }
      if (args[0]?.toLowerCase() === 'text') {
        const welcome = args.slice(1).join(' ').trim();
        if (!welcome) return send('Usage: !welcome text Your message with @user @number @group');
        data.settings.welcomeText = welcome.slice(0,1500); data.settings.welcomeCustom = true; await saveGroupData(); return send('👋 Welcome message saved for THIS group. Use @user, @number and @group as placeholders.\n\n_Tip: !welcome default restores the shared Nancy Nova AI welcome._');
      }
      if (args[0]?.toLowerCase() === 'default' || args[0]?.toLowerCase() === 'reset') {
        data.settings.welcomeCustom = false; delete data.settings.welcomeText; await saveGroupData(); return send('👋 This group now uses the shared default Nancy Nova AI welcome message. 🌟');
      }
      await send(`👋 *WELCOME SYSTEM*\n🔘 Status: ${data.settings.welcome ? 'ON' : 'OFF'}\n📝 Using: ${data.settings.welcomeCustom ? 'custom message' : 'shared default'}\n\n${data.settings.welcomeCustom ? data.settings.welcomeText : DEFAULT_WELCOME}`); break;
    }
    case '!goodbye': {
      const value = onOff(settingValue);
      if (value !== null) { data.settings.goodbye = value; data.settings.goodbyeConfigured = true; await saveGroupData(); return send(`${value ? '🟢' : '🔴'} Goodbye messages are now ${value ? 'ENABLED' : 'DISABLED'}.`); }
      if (args[0]?.toLowerCase() === 'text') {
        const goodbye = args.slice(1).join(' ').trim();
        if (!goodbye) return send('Usage: !goodbye text Your message with @user @number @group');
        data.settings.goodbyeText = goodbye.slice(0,1500); data.settings.goodbyeCustom = true; await saveGroupData(); return send('👋 Goodbye message saved for THIS group.\n\n_Tip: !goodbye default restores the shared Nancy Nova AI goodbye._');
      }
      if (args[0]?.toLowerCase() === 'default' || args[0]?.toLowerCase() === 'reset') {
        data.settings.goodbyeCustom = false; delete data.settings.goodbyeText; await saveGroupData(); return send('👋 This group now uses the shared default Nancy Nova AI goodbye message. 💎');
      }
      await send(`👋 *GOODBYE SYSTEM*\n🔘 Status: ${data.settings.goodbye ? 'ON' : 'OFF'}\n📝 Using: ${data.settings.goodbyeCustom ? 'custom message' : 'shared default'}\n\n${data.settings.goodbyeCustom ? data.settings.goodbyeText : DEFAULT_GOODBYE}`); break;
    }
    case '!invite': {
      requireBotAdmin();
      const code = await sock.groupInviteCode(chatJid); await send(`Group invite link:\nhttps://chat.whatsapp.com/${code}`); break;
    }
    case '!revoke':
      requireBotAdmin(); { const code = await sock.groupRevokeInvite(chatJid); await send(`Invite link regenerated:\nhttps://chat.whatsapp.com/${code}`); } break;

    case '!antilink': case '!antispam': case '!antiflood': case '!antiinvite': case '!antimedia': case '!warningsystem': {
      const settingKeys = {
        '!antilink': 'antiLink',
        '!antispam': 'antiSpam',
        '!antiflood': 'antiFlood',
        '!antiinvite': 'antiInvite',
        '!antimedia': 'antiMedia',
        '!warningsystem': 'warningSystem'
      };
      const key = settingKeys[command];
      const label = command.slice(1).toUpperCase();
      // !antilink supports three actions: on (warn), del (delete + tag), off.
      if (command === '!antilink' && settingValue === 'del') {
        data.settings.antiLink = true;
        data.settings.antiLinkMode = 'del';
        await saveGroupData();
        return send(`🗑️ *ANTILINK* is now *ENABLED (DEL MODE)*\nEvery link posted by a member is deleted instantly and the sender is tagged.\n_Owner and whitelisted members are never touched._`);
      }
      if (command === '!antilink' && (settingValue === 'warn' || settingValue === 'warning')) {
        data.settings.antiLink = true;
        data.settings.antiLinkMode = 'warn';
        await saveGroupData();
        return send(`⚠️ *ANTILINK* is now *ENABLED (WARN MODE)*\nLinks are reported but not deleted. Use ${getCommandPrefix(sock)}antilink del to delete them.`);
      }
      const value = onOff(settingValue);
      if (value === null) {
        return send(command === '!antilink'
          ? `Usage: ${command} on / del / off\n• on = warn about links\n• del = delete the link and tag the sender\n• off = disable`
          : `Usage: ${command} on/off`);
      }
      data.settings[key] = value;
      if (command === '!antilink' && value) data.settings.antiLinkMode = data.settings.antiLinkMode || 'warn';
      await saveGroupData();
      await send(`${value ? '🟢' : '🔴'} *${label}* is now ${value ? 'ENABLED' : 'DISABLED'}.${command === '!antilink' && value ? `\nMode: *${String(data.settings.antiLinkMode || 'warn').toUpperCase()}* (use ${getCommandPrefix(sock)}antilink del to delete links).` : ''}`);
      break;
    }
    case '!antimention': {
      // on  -> delete the tagging message + tag the sender (default)
      // warn-> only warn (no deletion)
      // off -> disable
      const label = 'ANTIMENTION';
      if (settingValue === 'on' || settingValue === 'del' || settingValue === 'enable' || settingValue === 'enabled') {
        const mode = settingValue === 'on' || settingValue === 'del' ? 'del' : 'warn';
        data.settings.antiMention = true;
        data.settings.antiMentionMode = mode;
        await saveGroupData();
        return send(`📢 *${label}* is now *ENABLED (${mode.toUpperCase()} MODE)*${mode === 'del' ? '\nAny message that tags a member (or @all) is deleted instantly and the sender is tagged.' : '\nTagging is reported but not deleted.'}\n_Owner and whitelisted members are never touched._`);
      }
      if (settingValue === 'warn' || settingValue === 'warning') {
        data.settings.antiMention = true; data.settings.antiMentionMode = 'warn'; await saveGroupData();
        return send(`⚠️ *${label}* is now *ENABLED (WARN MODE)*`);
      }
      if (settingValue === 'off' || settingValue === 'disable' || settingValue === 'disabled') {
        data.settings.antiMention = false; await saveGroupData();
        return send(`🔴 *${label}* is now *DISABLED*`);
      }
      return send(`📢 *${label}*\n🔘 Status: ${data.settings.antiMention ? `ON (${String(data.settings.antiMentionMode || 'del').toUpperCase()})` : 'OFF'}\n\nUsage: ${getCommandPrefix(sock)}antimention on / del / warn / off\n• on / del = delete the tag and tag the sender\n• warn = warn only\n• off = disable`);
    }
    case '!antiword': {
      const action = settingValue;
      if (action === 'on' || action === 'off') {
        data.settings.antiWord = action === 'on'; await saveGroupData(); return send(`Anti-word protection ${data.settings.antiWord ? 'enabled' : 'disabled'}.`);
      }
      if (action === 'add') {
        const word = args.slice(1).join(' ').trim();
        if (!word) return send('Usage: !antiword add word');
        if (!data.settings.antiWords.includes(word.toLowerCase())) data.settings.antiWords.push(word.toLowerCase());
        data.settings.antiWord = true; await saveGroupData(); return send(`Blocked word added: ${word}`);
      }
      if (action === 'remove') {
        const word = args.slice(1).join(' ').trim().toLowerCase();
        data.settings.antiWords = data.settings.antiWords.filter(w => w !== word); await saveGroupData(); return send(`Blocked word removed: ${word}`);
      }
      await send(`Anti-word: ${data.settings.antiWord ? 'ON' : 'OFF'}\nBlocked words: ${data.settings.antiWords.join(', ') || 'none'}`); break;
    }
    case '!antidelete': {
      const value = (args[0] || '').toLowerCase();
      const modeLabel = (m) => m === 'chat' ? 'CHATS (resend in same chat)' : m === 'group' ? 'GRP (resend in this group)' : 'INBOX (owner DM)';
      if (!['on','off','chats','chat','grp','group','inbox','status'].includes(value)) return send('\ud83d\udd75\ufe0f *Usage:* !antidelete on | off | status\n\ud83d\udccd *Modes:* !antidelete chats | grp | inbox\n\n• *chats* — resend the deleted message in the same chat\n• *grp* — resend it here in the group\n• *inbox* — forward it to the owner DM');
      if (value === 'status') return send(`\ud83d\udd75\ufe0f *ANTI-DELETE STATUS*\n\ud83d\udd18 Enabled: ${data.settings.antiDelete ? 'ON' : 'OFF'}\n\ud83d\udccd Mode: ${modeLabel(data.settings.antiDeleteMode)}`);
      if (value === 'on') data.settings.antiDelete = true;
      if (value === 'off') data.settings.antiDelete = false;
      if (value === 'chats' || value === 'chat') { data.settings.antiDelete = true; data.settings.antiDeleteMode = 'chat'; }
      if (value === 'grp' || value === 'group') { data.settings.antiDelete = true; data.settings.antiDeleteMode = 'group'; }
      if (value === 'inbox') { data.settings.antiDelete = true; data.settings.antiDeleteMode = 'inbox'; }
      await saveGroupData();
      return send(`\ud83d\udd75\ufe0f Anti-delete is now *${data.settings.antiDelete ? 'ON' : 'OFF'}*.\n\ud83d\udccd Recovery mode: *${modeLabel(data.settings.antiDeleteMode)}*`);
    }
    case '!poll': {
      const parts = argument.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) return send('Usage: !poll Question | Option 1 | Option 2');
      if (parts.length > 13) return send('A poll can contain at most 12 options.');
      await sock.sendMessage(chatJid, { poll: { name: parts[0].slice(0,255), values: parts.slice(1).map(s => s.slice(0,100)), selectableCount: 1 } }); break;
    }
    case '!leave':
      if (!owner) throw new Error('Only the bot owner can make the bot leave a group.');
      await send('Owner requested that I leave this group.'); await sock.groupLeave(chatJid); break;
  }
}

async function processMediaCommand(sock, msg, jid, command, argument) {
  const mediaPrefix = getCommandPrefix(sock);
  const send = text => sock.sendMessage(jid, { text: typeof text === 'string' ? prefixForDisplay(text, mediaPrefix) : text }, { quoted: msg });
  if (command === '!qr') {
    if (!argument) return send('Usage: !qr text or link');
    const buffer = await QRCode.toBuffer(argument, { type: 'png', width: 700, margin: 2 });
    await sock.sendMessage(jid, { image: buffer, caption: 'QR code generated by Nancy Nova AI.' }, { quoted: msg }); return;
  }
  if (command === '!pdf') {
    if (!argument) return send('Usage: !pdf Your text here');
    await mkdir(TEMP_DIR, { recursive: true });
    const file = path.join(TEMP_DIR, `document-${Date.now()}.pdf`);
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = doc.pipe(createWriteStream(file));
      stream.on('finish', resolve); stream.on('error', reject);
      doc.fontSize(12).text(argument, { width: 500, align: 'left' }); doc.end();
    });
    const buffer = await readFile(file);
    await sock.sendMessage(jid, { document: buffer, mimetype: 'application/pdf', fileName: 'dev-brian-ai-document.pdf' }, { quoted: msg });
    await rm(file, { force: true }); return;
  }
  if (command === '!tts') {
    if (!argument) return send(prefixForDisplay('Usage: !tts Your text here\nOr reply to a text message with !tts.', getCommandPrefix(sock)));
    await send('🔊 Generating speech…');
    const speech = await synthesizeSpeech(argument);
    await sock.sendMessage(jid, { audio: speech.buffer, mimetype: speech.mimetype, ptt: false }, { quoted: msg });
    return;
  }
  if (command === '!transcribe') {
    const target = await findMediaTarget(sock, msg);
    const content = target ? unwrapMessage(target.message) : null;
    if (!target || !content?.audioMessage) return send('Reply to a WhatsApp voice note or audio message with !transcribe.');
    const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
    if (!buffer?.length) throw new Error('The audio could not be downloaded.');
    await send('📝 Transcribing the audio...');
    const transcript = await transcribeAudioBuffer(buffer, 'voice.ogg', content.audioMessage.mimetype || 'audio/ogg');
    return send(`📝 *TRANSCRIPTION*\n\n${transcript}`);
  }
  if (command === '!ocr') return send('OCR is not configured yet.');
  if (command === '!summarizepdf') return send('PDF summarization is not configured yet.');
  if (command === '!image') {
    if (!argument) return send('Usage: !image describe the image you want');
    await sendPhotoLabImages(sock, jid, msg, argument, `${BOT_NAME} — IMAGE`);
    return;
  }
  const target = await findMediaTarget(sock, msg);
  if (!target) return send(`Please attach or reply to a supported image/sticker, then use ${command}.`);
  const content = unwrapMessage(target.message);
  const isSticker = Boolean(content.stickerMessage);
  if (command === '!tovideo') {
    if (!isSticker) return send('🎥 Reply to an *animated sticker* with !tovideo to turn it into a short video.');
    if (content.stickerMessage?.isAnimated === false) return send('🎥 That sticker is a still image, not animated — there is nothing to turn into a video. Use !toimage instead.');
    await send('🎥 Converting the animated sticker into a video… 💫');
    await mkdir(TEMP_DIR, { recursive: true });
    const stamp = `tovideo-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const webpFile = path.join(TEMP_DIR, `${stamp}.webp`);
    const mp4File = path.join(TEMP_DIR, `${stamp}.mp4`);
    try {
      const { buffer } = await downloadToTemp(sock, target, 'tovideo-src');
      await writeFile(webpFile, buffer);
      const ffmpeg = (await resolveFfmpegBinary()) || process.env.FFMPEG_PATH || 'ffmpeg';
      // Animated WebP → MP4. Pad to even dimensions and use yuv420p so the clip
      // plays on every WhatsApp client; loop a couple of times so it is long
      // enough to view and post to Status.
      await execFileAsync(ffmpeg, ['-y', '-loop', '0', '-i', webpFile, '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2:color=black,loop=2:1', '-r', '20', '-t', '12', mp4File], { timeout: 120000, windowsHide: true });
      const videoBuffer = await readFile(mp4File);
      if (!videoBuffer.length) throw new Error('conversion produced an empty file');
      await sock.sendMessage(jid, { video: videoBuffer, mimetype: 'video/mp4', caption: `🎥 Sticker → video • 💎 ${TEAM_NAME}` }, { quoted: msg });
    } catch (error) {
      await send(`⚠️ I couldn't convert that sticker to a video (${error.message}). This needs FFmpeg with animated-WebP support, and the sticker must actually be animated.`);
    } finally {
      await rm(webpFile, { force: true }).catch(() => {});
      await rm(mp4File, { force: true }).catch(() => {});
    }
    return;
  }
  if (command === '!sticker' || command === '!toimage' || command === '!compress' || command === '!resize' || command === '!readqr') {
    const { buffer } = await downloadToTemp(sock, target, command.slice(1));
    if (command === '!sticker') {
      const webp = await sharp(buffer).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toBuffer();
      await sock.sendMessage(jid, { sticker: webp }, { quoted: msg }); return;
    }
    if (command === '!toimage') {
      if (!isSticker) return send('!toimage expects a sticker. Reply to a sticker with !toimage.');
      const image = await sharp(buffer).png().toBuffer();
      await sock.sendMessage(jid, { image, caption: 'Sticker converted to image.' }, { quoted: msg }); return;
    }
    if (command === '!compress') {
      const image = await sharp(buffer).rotate().jpeg({ quality: 55, mozjpeg: true }).toBuffer();
      await sock.sendMessage(jid, { image, caption: `Compressed image. Approx. size: ${(image.length / 1024).toFixed(1)} KB` }, { quoted: msg }); return;
    }
    if (command === '!resize') {
      const [w, h] = argument.split(/\s+/).map(Number);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) return send('Usage: reply to an image with !resize 800 600 (max 4096 × 4096).');
      const image = await sharp(buffer).rotate().resize(w, h, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      await sock.sendMessage(jid, { image, caption: `Resized image to fit within ${w} × ${h}.` }, { quoted: msg }); return;
    }
    if (command === '!readqr') {
      const image = await Jimp.read(buffer);
      const { data, width, height } = image.bitmap;
      const code = jsQR(new Uint8ClampedArray(data), width, height);
      return send(code?.data ? `QR content:\n${code.data}` : 'No readable QR code was found in that image.');
    }
  }
}

const pairedSockets = new Map();
const PAIR_SESSIONS_DIR = path.join(process.cwd(), 'paired_sessions');
const PAIR_CODE_TTL_MS = 3 * 60 * 1000;
const PAIR_REQUEST_COOLDOWN_MS = 4000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function pairDigits(input) {
  const digits = String(input || '').replace(/\D/g, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : '';
}

function prettyPairCode(code) {
  const clean = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function pairAgeLabel(record) {
  const seconds = Math.max(0, Math.floor((Date.now() - (record.codeIssuedAt || record.createdAt || Date.now())) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

const PAIR_STATE_LABEL = {
  creating: '⏳ starting the secure channel',
  'requesting-code': '⏳ generating your code',
  'waiting-for-link': '🔐 code sent — waiting for you to enter it',
  connected: '✅ linked and online',
  expired: '⌛ code expired — request a fresh one',
  'pairing-error': '❌ could not generate a code',
  disconnected: '🔄 briefly offline — reconnecting',
  'logged-out': '🚪 removed from that phone',
  restoring: '🔄 restoring after restart'
};

async function destroyPairAttempt(digits, { wipe = false } = {}) {
  const record = pairedSockets.get(digits);
  if (!record) return;
  clearTimeout(record.ttlTimer);
  clearTimeout(record.watchdog);
  clearInterval(record.tick);
  try { record.sock?.end?.(undefined); } catch {}
  pairedSockets.delete(digits);
  if (wipe) {
    try { await rm(path.join(PAIR_SESSIONS_DIR, digits), { recursive: true, force: true }); } catch {}
  }
}

function sendPairCodeCard(parentSock, replyJid, digits, code, quotedMsg) {
  const prefix = getCommandPrefix(parentSock);
  const card = [
    '💎✨ *LINK A WHATSAPP ACCOUNT* ✨💎',
    '◈━━━━━━━━━━━━━━━━━━◈',
    '',
    `📱 *Account:* +${digits}`,
    `🔐 *Pairing code:* *${code}*`,
    '⏳ *Valid for:* about 2 minutes, single use',
    '',
    '*HOW TO ENTER IT — 5 STEPS*',
    '1️⃣ On that phone open *WhatsApp*',
    '2️⃣ Tap *Settings* → *Linked devices*',
    '3️⃣ Tap *Link a device*',
    '4️⃣ Choose *Link with phone number instead*',
    '5️⃣ Type the code above exactly as shown',
    '',
    '⚠️ *PLEASE NOTE*',
    '• Type it promptly — an old code is rejected once it expires',
    '• Send *' + prefix + 'pair ' + digits + '* again any time for a brand-new code',
    '• Never share this code: it can link a device to that account',
    '',
    '_Nancy Nova AI · Team NASA_'
  ].join('\n');
  return parentSock.sendMessage(replyJid, { text: card }).catch(() => {});
}

async function issuePairingCode(record, digits, replyJid, parentSock, attempt = 1) {
  if (record.state === 'connected' || pairedSockets.get(digits) !== record) return;
  record.state = 'requesting-code';
  try {
    const raw = await record.sock.requestPairingCode(digits);
    if (pairedSockets.get(digits) !== record) return;
    record.code = prettyPairCode(raw);
    record.state = 'waiting-for-link';
    record.codeIssuedAt = Date.now();
    await sendPairCodeCard(parentSock, replyJid, digits, record.code);
    clearTimeout(record.ttlTimer);
    record.ttlTimer = setTimeout(() => {
      if (pairedSockets.get(digits) !== record || record.state !== 'waiting-for-link') return;
      record.state = 'expired';
      parentSock.sendMessage(replyJid, {
        text: `⌛ *CODE EXPIRED — +${digits}*\n\nThe pairing code timed out before it was entered. Nothing is broken — codes simply do not last long.\n\nSend *${getCommandPrefix(parentSock)}pair ${digits}* for a fresh code, then enter it straight away.`
      }).catch(() => {});
    }, PAIR_CODE_TTL_MS);
  } catch (error) {
    if (attempt < 3 && pairedSockets.get(digits) === record) {
      await sleep(2500 * attempt);
      return issuePairingCode(record, digits, replyJid, parentSock, attempt + 1);
    }
    record.state = 'pairing-error';
    await parentSock.sendMessage(replyJid, {
      text: `❌ *COULD NOT CREATE A CODE — +${digits}*\n\nWhatsApp refused the pairing request this time.\n▪ Reason: ${String(error?.message || error).slice(0, 200)}\n\nTry again in a minute with *${getCommandPrefix(parentSock)}pair ${digits}*. If it keeps failing, remove any half-finished session on that phone (Linked devices) and retry.`
    }).catch(() => {});
  }
}

async function createPairedSession(phoneNumber, replyJid, parentSock) {
  const digits = pairDigits(phoneNumber);
  if (!digits) throw new Error(`Usage: ${getCommandPrefix(parentSock)}pair 2547XXXXXXXX\nCountry code first, digits only — no plus sign, no spaces.`);
  if (digits === OWNER_NUMBER) throw new Error('That number already runs this bot as the main session — there is nothing to link.');

  const existing = pairedSockets.get(digits);
  if (existing) {
    if (existing.state === 'connected' && existing.sock?.user) {
      return parentSock.sendMessage(replyJid, {
        text: `✅ *+${digits} IS ALREADY LINKED*\n\nIt is online right now.\n• Fresh code: *${getCommandPrefix(parentSock)}pair ${digits}* after *${getCommandPrefix(parentSock)}unpair ${digits}*\n• Check the list: *${getCommandPrefix(parentSock)}pairstatus*`
      });
    }
    // A previous attempt is still around. If a code was just sent, repeat it
    // instead of burning a new socket; otherwise tear it down for a clean start.
    if (existing.state === 'waiting-for-link' && existing.code && Date.now() - (existing.codeIssuedAt || 0) < PAIR_REQUEST_COOLDOWN_MS) {
      return parentSock.sendMessage(replyJid, {
        text: `🔐 *YOUR CURRENT CODE IS STILL VALID — +${digits}*\n\nCode: *${existing.code}*  (sent ${pairAgeLabel(existing)})\n\nEnter it now: WhatsApp → Linked devices → Link a device → *Link with phone number instead*.\n_If it has just expired, send the command again for a new one._`
      });
    }
    await destroyPairAttempt(digits, { wipe: true });
  }

  await mkdir(PAIR_SESSIONS_DIR, { recursive: true });
  const sessionDir = path.join(PAIR_SESSIONS_DIR, digits);
  // A stale folder from an abandoned attempt makes WhatsApp reject a fresh code,
  // so always start from a clean directory.
  await rm(sessionDir, { recursive: true, force: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const sessionSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: [BOT_NAME, 'Chrome', `${BOT_VERSION}-session`]
  });
  const record = { sock: sessionSock, state: 'creating', createdAt: Date.now(), phone: digits, code: '', codeIssuedAt: 0 };
  pairedSockets.set(digits, record);

  await parentSock.sendMessage(replyJid, {
    text: `⏳ *PREPARING +${digits}*\n\nOpening a secure channel to WhatsApp… your pairing code will arrive here in a few seconds.\n_Please do not send the command again while this runs._`
  }).catch(() => {});

  sessionSock.ev.on('creds.update', saveCreds);
  sessionSock.ev.on('presence.update', update => {
    const id = normalizeJid(update?.id || '');
    const first = Object.values(update?.presences || {})[0];
    if (id && first) presenceCache.set(id, { ...first, receivedAt: Date.now() });
  });

  sessionSock.ev.on('connection.update', async update => {
    if (update.connection === 'open') {
      clearTimeout(record.ttlTimer);
      record.state = 'connected';
      record.user = sessionSock.user?.id || digits;
      await parentSock.sendMessage(replyJid, {
        text: `✅ *+${digits} IS LINKED*\n◈━━━━━━━━━━━━━━━━━━◈\n\nThat account is now online with Nancy Nova AI and will answer its own chats.\n• Review sessions: *${getCommandPrefix(parentSock)}pairstatus*\n• Remove access: *${getCommandPrefix(parentSock)}unpair ${digits}*`
      }).catch(() => {});
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (record.state === 'connected' || record.state === 'restoring') {
        record.state = code === DisconnectReason.loggedOut ? 'logged-out' : 'disconnected';
      } else if (record.state !== 'expired' && record.state !== 'pairing-error') {
        record.state = code === DisconnectReason.loggedOut ? 'logged-out' : 'disconnected';
      }
      if (record.state === 'disconnected' && pairedSockets.get(digits) === record) {
        setTimeout(async () => {
          if (pairedSockets.get(digits) !== record) return;
          try { await restartPairedSession(digits, replyJid, parentSock); }
          catch (error) { console.error(`Session reconnect failed (${digits}):`, error.message); }
        }, 5000).unref?.();
      }
    }
    // Fallback: if the direct request failed, the QR event is the moment the
    // socket is ready for a pairing code.
    if (update.qr && record.state === 'creating' && !state.creds.registered) {
      await issuePairingCode(record, digits, replyJid, parentSock);
    }
  });

  sessionSock.ev.on('messages.upsert', payload => handleMessagesUpsert(sessionSock, payload).catch(error => console.error(`Paired-session message error (${digits}):`, error.message)));

  // Ask for the code straight away; the request itself waits for the socket.
  issuePairingCode(record, digits, replyJid, parentSock).catch(() => {});
  record.watchdog = setTimeout(() => {
    if (record.state === 'creating') issuePairingCode(record, digits, replyJid, parentSock).catch(() => {});
  }, 12000);
  record.watchdog?.unref?.();
  return true;
}

async function unlinkPairedSession(phoneNumber, replyJid, parentSock, { all = false } = {}) {
  const wanted = all ? [...pairedSockets.keys()] : [pairDigits(phoneNumber)].filter(Boolean);
  if (!all && !wanted.length) throw new Error(`Usage: ${getCommandPrefix(parentSock)}unpair 2547XXXXXXXX  (or ${getCommandPrefix(parentSock)}unpair all)`);
  await mkdir(PAIR_SESSIONS_DIR, { recursive: true });
  const folders = await readdir(PAIR_SESSIONS_DIR, { withFileTypes: true }).catch(() => []);
  const onDisk = folders.filter(e => e.isDirectory() && /^\d{7,15}$/.test(e.name)).map(e => e.name);
  const targets = all ? [...new Set([...wanted, ...onDisk])] : wanted;
  if (!targets.length) {
    return parentSock.sendMessage(replyJid, { text: `🔓 *NOTHING TO REMOVE*\n\nNo linked sessions were found. Check *${getCommandPrefix(parentSock)}pairstatus* any time.` });
  }
  const lines = [];
  for (const digits of targets) {
    const record = pairedSockets.get(digits);
    let removedFromPhone = false;
    if (record) {
      try { await record.sock.logout(); removedFromPhone = true; } catch {}
      clearTimeout(record.ttlTimer);
      clearTimeout(record.watchdog);
      try { record.sock.end(undefined); } catch {}
      pairedSockets.delete(digits);
    }
    try { await rm(path.join(PAIR_SESSIONS_DIR, digits), { recursive: true, force: true }); } catch {}
    lines.push(removedFromPhone
      ? `✅ +${digits} — unlinked from that phone, local credentials deleted`
      : `🗑️ +${digits} — local session erased (it was not online, so the phone may still list an old device)`);
  }
  return parentSock.sendMessage(replyJid, {
    text: `🔓 *SESSION REMOVAL COMPLETE*\n◈━━━━━━━━━━━━━━━━━━◈\n\n${lines.join('\n')}\n\n_If that phone still shows Nancy Nova AI under Linked devices, open it there and tap the device → Log out._`
  });
}

async function restartPairedSession(digits, replyJid, parentSock) {
  const old = pairedSockets.get(digits);
  if (!old || old.state === 'logged-out') return;
  old.state = 'restoring';
  try { old.sock.end(undefined); } catch {}
  pairedSockets.delete(digits);
  await createPairedSession(digits, replyJid, parentSock);
}

async function startBot() {
  if (activeSocket) {
    try { activeSocket.end(undefined); } catch {}
    activeSocket = null;
  }
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
  version,
  auth: state,
  logger: pino({ level: 'debug' }),
  printQRInTerminal: false,
  browser: [BOT_NAME, 'Chrome', BOT_VERSION]
});
  activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('presence.update', update => {
    const id = normalizeJid(update?.id || '');
    if (!id) return;
    const presences = update?.presences || {};
    const first = Object.values(presences)[0];
    if (first) presenceCache.set(id, { ...first, receivedAt: Date.now() });
  });
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { console.log('\nScan this QR code with WhatsApp:\n'); qrcodeTerminal.generate(qr, { small: true }); }
    if (connection === 'open') {
      console.log(`${BOT_NAME} is connected!`); console.log(`Owner: ${OWNER_NAME}`); console.log(`Bot mode: ${botSettings.mode}`);
      startedAt = Date.now(); reconnecting = false;
    }
    if (connection === 'close') {
      if (activeSocket !== sock) return;
      activeSocket = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('WhatsApp disconnected:', statusCode ?? 'unknown');
      console.log('Disconnect reason:', lastDisconnect?.error?.message ?? 'No error message supplied');
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('WhatsApp logged out. Keep auth_info safe and relink only if necessary.'); reconnecting = false; return;
      }
      if (!reconnecting) {
        reconnecting = true; console.log('Reconnecting in 5 seconds...');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          loadGroupData().then(() => loadBotSettings()).then(() => loadTaskData()).then(() => { startReminderPoller(); return startBot(); }).catch(error => { console.error('Reconnect failed:', error.message); reconnecting = false; });
        }, 5000);
      }
    }
  });
  sock.ev.on('group-participants.update', async update => {
    const chatJid = update.id;
    const data = getGroupData(chatJid);
    const rawMembers = update.participants || [];
    if (!rawMembers.length || !['add','remove','leave'].includes(update.action)) return;
    let metadata = null;
    try { metadata = await sock.groupMetadata(chatJid); } catch {}
    for (const rawMember of rawMembers) {
      const member = typeof rawMember === 'string' ? rawMember : participantJid(rawMember);
      if (!member) continue;
      const key = normalizeJid(member);
      if (!data.memberNumbers[key]) data.memberNumbers[key] = data.nextMemberNumber++;
      const number = data.memberNumbers[key];
      const groupName = metadata?.subject || 'our group';
      if (update.action === 'add' && data.settings.welcome) {
        const template = data.settings.welcomeCustom && data.settings.welcomeText ? data.settings.welcomeText : DEFAULT_WELCOME;
        const text = template
          .replace(/@user/gi, displayJid(member))
          .replace(/@number/gi, String(number))
          .replace(/@group/gi, groupName);
        await sock.sendMessage(chatJid, { text, mentions: [member] }).catch(error => console.error('Welcome message failed:', error.message));
      }
      if ((update.action === 'remove' || update.action === 'leave') && data.settings.goodbye && !isOwnAccountJid(member, sock)) {
        const template = data.settings.goodbyeCustom && data.settings.goodbyeText ? data.settings.goodbyeText : DEFAULT_GOODBYE;
        const text = template
          .replace(/@user/gi, displayJid(member))
          .replace(/@number/gi, String(number))
          .replace(/@group/gi, groupName);
        await sock.sendMessage(chatJid, { text, mentions: [member] }).catch(error => console.error('Goodbye message failed:', error.message));
      }
    }
    await saveGroupData().catch(() => {});
  });

  sock.ev.on('messages.upsert', payload => handleMessagesUpsert(sock, payload).catch(error => console.error('Message handler failed:', error.message)));
}

const STATUS_LIKE_EMOJIS = ['💎','❤️','🔥','😍','👏','✨','🥰','😮','💯','🙌','🌟','💖','😎','👀','🎉','💫','🤩','😂','🫶','⭐'];
// Auto view and/or auto react to contacts' status (story) updates the moment
// they are posted. Controlled by !autoviewstatus and !autolikestatus.
async function handleStatusAutoActions(sock, msg) {
  // Never touch our own status posts, and skip protocol/reaction echoes.
  if (msg.key?.fromMe) return;
  const content = unwrapMessage(msg.message);
  if (!content || content.protocolMessage || content.reactionMessage) return;
  const author = msg.key?.participant || msg.key?.remoteJid;
  if (!author) return;
  // 1) Auto-view: mark the status as seen so the contact sees us in viewers.
  if (botSettings.autoViewStatus) {
    try { await sock.readMessages([msg.key]); }
    catch (error) { console.error('Auto-view status failed:', error.message); }
  }
  // 2) Auto-like: send a random emoji reaction to the status.
  if (botSettings.autoLikeStatus) {
    const emoji = STATUS_LIKE_EMOJIS[Math.floor(Math.random() * STATUS_LIKE_EMOJIS.length)];
    try {
      await sock.sendMessage('status@broadcast', { react: { text: emoji, key: msg.key } }, { statusJidList: [author] });
    } catch (error) {
      console.error('Auto-like status failed:', error.message);
    }
  }
}

// ── "Message yourself" detection ──
// Newer WhatsApp builds key the owner's own chat by LID instead of a phone JID,
// which used to make private-chat commands look like normal chatter. Resolve the
// thread properly so every command works in the owner's personal chat.
async function isSelfChatThread(sock, msg, jid) {
  if (!jid || jid.endsWith('@g.us')) return false;
  if (isOwnAccountJid(jid, sock)) return true;
  const ownPhone = phoneFromJid(sock?.user?.id || sock?.user?.jid || sock?.user?.phoneNumber || '');
  try {
    const phone = await resolvePhoneFromJid(sock, jid);
    if (phone && (phone === OWNER_NUMBER || phone === ownPhone || isAdditionalOwner(`${phone}@s.whatsapp.net`))) return true;
  } catch {}
  const ownIds = [sock?.user?.id, sock?.user?.lid, sock?.user?.jid].filter(Boolean).map(normalizeJid);
  return ownIds.includes(normalizeJid(jid));
}

async function handleMessagesUpsert(sock, { messages, type }) {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (jid === 'status@broadcast' || (jid && jid.endsWith('@broadcast'))) {
        await handleStatusAutoActions(sock, msg).catch(error => console.error('Status auto-action failed:', error.message));
        continue;
      }
      if (!jid) continue;
      if (isRevokeMessage(msg)) { await handleAntiDeleteRevoke(sock, msg).catch(error => console.error('Anti-delete error:', error.message)); continue; }
      cacheIncomingMessage(msg);
      const inGroup = jid.endsWith('@g.us');
      const fromMe = Boolean(msg.key.fromMe);
      const selfChat = fromMe ? await isSelfChatThread(sock, msg, jid) : false;
      // Baileys marks messages sent manually from the bot's registered WhatsApp
      // account as `fromMe`. Previously we discarded every fromMe message that
      // was not a private self-chat, which meant owner commands typed from the
      // bot account inside a group were silently ignored.
      //
      // Keep normal outgoing bot messages ignored, but allow outgoing COMMANDS
      // beginning with `!` so the registered owner can control the bot.
      const text = getText(msg.message);
      if (!fromMe) await triggerAutoPresence(sock, jid);
      // React to incoming messages, commands, and messages sent from the bot
      // account. Ignore protocol/reaction-only payloads to prevent event loops.
      const messageContent = unwrapMessage(msg.message);
      const isReactionOnly = Boolean(messageContent?.reactionMessage || messageContent?.protocolMessage);
      if (botSettings.autoReact && !isReactionOnly && msg.key?.id) {
        const reactions = ['👍','❤️','😂','🔥','💯','👏','😎','✨','🙏','🤝','😁','💙'];
        const emoji = reactions[Math.floor(Math.random() * reactions.length)];
        await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(error => {
          console.error('Auto-reaction failed:', error.message);
        });
      }
      const activePrefix = getCommandPrefix(sock);
      if (fromMe && !selfChat && !text.startsWith(activePrefix)) continue;
      if (!fromMe && type !== 'notify') continue;
      const owner = (await messageIsOwner(msg, sock, jid)) || selfChat;
      if (inGroup) {
        await trackGroupActivity(msg, jid);
        if (await handleGroupModeration(sock, msg, jid, text)) continue;
      }
      if (!text || !text.startsWith(activePrefix)) {
        if (!fromMe && botSettings.aiEnabled && !maintenanceMode && await canUseConfiguredMode(sock, msg, jid, owner)) {
          await handleAiText(sock, msg, jid, text);
        }
        continue;
      }
      const [rawCommand, ...args] = text.trim().split(/\s+/);
      let command = rawCommand.toLowerCase();
      // When a custom prefix is active (e.g. '/'), the text passes the startsWith
      // check but 'command' would be '/menu', which never matches any `case '!menu'`.
      // Normalize the leading custom prefix back to '!' so the switch dispatches.
      if (activePrefix !== '!' && command.startsWith(activePrefix)) command = '!' + command.slice(activePrefix.length);
      const argument = args.join(' ').trim();
      if (!(await canUseConfiguredMode(sock, msg, jid, owner))) {
        await sock.sendMessage(jid, { text: botSettings.mode === 'private' ? '🔒 *PRIVATE MODE*\nOnly the bot owner can command Nancy Nova AI.' : '🛡️ *ADMIN MODE*\nOnly group admins can command Nancy Nova AI.' }, { quoted: msg }).catch(() => {});
        continue;
      }
      if (OWNER_ONLY_COMMANDS.has(command) && !owner) {
        await sock.sendMessage(jid, { text: 'This command is restricted to the bot owner.' }).catch(() => {}); continue;
      }
      if (command === '!prefix' || command === '!setprefix') {
        if (!owner) { await sock.sendMessage(jid, { text: 'Only the bot owner can change this session’s command prefix.' }, { quoted: msg }).catch(() => {}); continue; }
        const requested = (args[0] || '').trim();
        const sessionKey = getSessionPrefixKey(sock);
        const current = getCommandPrefix(sock);
        if (!requested || requested.toLowerCase() === 'status') {
          await sock.sendMessage(jid, { text: `⚙️ *COMMAND PREFIX*\nCurrent prefix: ${current}\nUsage: ${current}prefix .\nReset: ${current}prefix reset\n\n_Prefix changes apply only to this WhatsApp session and are saved across restarts._` }, { quoted: msg });
          continue;
        }
        if (requested.toLowerCase() === 'reset' || requested.toLowerCase() === 'default') {
          delete botSettings.sessionPrefixes[sessionKey];
          await saveBotSettings();
          await sock.sendMessage(jid, { text: '✅ Prefix reset to ! for this session.' }, { quoted: msg });
          continue;
        }
        if (requested.length > 4 || /\s/.test(requested) || /[\p{L}\p{N}@]/u.test(requested)) {
          await sock.sendMessage(jid, { text: prefixForDisplay('Choose 1–4 punctuation characters only (no spaces, letters, numbers, or @). Example: !prefix . or !prefix /', current) }, { quoted: msg });
          continue;
        }
        botSettings.sessionPrefixes[sessionKey] = requested;
        await saveBotSettings();
        await sock.sendMessage(jid, { text: `✅ Prefix changed from ${current} to ${requested} for this session. Example: ${requested}menu` }, { quoted: msg });
        continue;
      }
      // Group moderation + welcome/goodbye switches work from ANY chat. In a
      // private chat the owner sets one global default that every group inherits,
      // so there is no need to repeat the command inside each group.
      if (!inGroup && GLOBAL_GROUP_TOGGLES[command]) {
        if (!owner) {
          await sock.sendMessage(jid, { text: `🔒 *${GLOBAL_GROUP_TOGGLES[command].label}* can only be changed by the bot owner.` }, { quoted: msg }).catch(() => {});
          continue;
        }
        try { await applyGlobalGroupToggle(sock, msg, jid, command, args); }
        catch (error) { await sock.sendMessage(jid, { text: `⚠️ Could not save that setting: ${String(error.message || error).slice(0, 200)}` }, { quoted: msg }).catch(() => {}); }
        continue;
      }
      // !grok / !gemini / !openrouter talk straight to their own provider and work in
      // ANY chat. Handled before the group/mode gates so they never get swallowed.
      if (AI_COMMAND_PROVIDERS.has(command)) {
        try {
          await sendProviderChat(sock, msg, jid, command, argument);
        } catch (error) {
          await sock.sendMessage(jid, { text: error.message.slice(0, 3000) }, { quoted: msg }).catch(() => {});
        }
        continue;
      }
      // !del / !delete work in ANY chat (private + group) and bypass the group
      // and mode gates, so handle them before those checks run.
      if (['!del','!delete','!delmsg','!rm'].includes(command)) {
        if (maintenanceMode && !owner) {
          await sock.sendMessage(jid, { text: 'Nancy Nova AI is temporarily under maintenance. Please try again later.' }).catch(() => {}); continue;
        }
        try { await handleDeleteCommand(sock, msg, jid, owner); }
        catch (error) { console.error('Error in !del:', error.stack || error.message); await sock.sendMessage(jid, { text: `💜 Sorry, !del couldn't finish — ${friendlyError(error)}` }, { quoted: msg }).catch(() => {}); }
        continue;
      }
      if (GROUP_COMMANDS.has(command) && !inGroup) {
        await sock.sendMessage(jid, { quoted: msg, text: [
          '🎯 *GROUP-ONLY COMMAND*',
          '◈━━━━━━━━━━━━━━━━━━━━◈',
          '',
          `*${command}* reads or changes one specific group, so it has to be sent inside that group.`,
          '',
          '• Member actions: open the group and send it there',
          '• Protection switches (anti-link, anti-spam, anti-delete, welcome …) can be set right here in your personal chat — they then cover every group',
          '',
          `_Tip: send *${getCommandPrefix(sock)}menu* to see everything Nancy can do._`
        ].join('\n') }).catch(() => {}); continue;
      }
      if (command === '!leave' && !owner) {
        await sock.sendMessage(jid, { text: 'Only the bot owner can make the bot leave a group.' }, { quoted: msg }).catch(() => {}); continue;
      }
      if (GROUP_ADMIN_COMMANDS.has(command) && inGroup) {
        try { await getGroupContext(sock, msg, jid, owner); }
        catch (error) { await sock.sendMessage(jid, { text: error.message }, { quoted: msg }).catch(() => {}); continue; }
      }
      if (maintenanceMode && !owner) {
        await sock.sendMessage(jid, { text: 'Nancy Nova AI is temporarily under maintenance. Please try again later.' }).catch(() => {}); continue;
      }
      stats.messages++; stats.commands++;
      console.log(`Command ${command} from ${owner ? 'owner' : messageSender(msg)}`);
      try {
        if (!(await canUseConfiguredMode(sock, msg, jid, owner))) {
          await sock.sendMessage(jid, { text: botSettings.mode === 'private' ? '🔒 *PRIVATE MODE*\nOnly the bot owner can command Nancy Nova AI.' : '🛡️ *ADMIN MODE*\nOnly group admins can command Nancy Nova AI.' }, { quoted: msg }).catch(() => {});
          continue;
        }
        if (GROUP_COMMANDS.has(command)) { await groupCommand(sock, msg, jid, command, args, argument, owner); continue; }
        if (command === '!ytb') { await downloadYouTubeMedia(sock, msg, jid, argument); continue; }
        if (SEARCH_MEDIA_COMMANDS.has(command)) { const audioMode = ['!audio','!song','!ytmp3','!play'].includes(command); await downloadSearchMedia(sock, msg, jid, audioMode ? 'audio' : 'video', argument); continue; }
        if (DIRECT_MEDIA_COMMANDS.has(command)) { await downloadDirectMedia(sock, msg, jid, argument); continue; }
        const taskKey = taskUserKey(msg, jid);
        if (['!caption', '!rewrite', '!bio', '!story', '!ideas', '!post'].includes(command)) {
          if (!argument) {
            const usage = { '!caption': '!caption topic, photo context, or product', '!rewrite': '!rewrite text to improve', '!bio': '!bio your interests, role, or personality', '!story': '!story a prompt or theme', '!ideas': '!ideas topic', '!post': '!post topic and desired tone' };
            await sock.sendMessage(jid, { text: `Usage: ${usage[command]}` }, { quoted: msg }); continue;
          }
          const instructions = {
            '!caption': 'Write 5 distinct, catchy social-media captions for the supplied topic or context. Keep them ready to copy, vary tone, include a few relevant hashtags, and do not claim to have seen an image unless its visual contents were provided in text.',
            '!rewrite': 'Rewrite the supplied text for clarity and impact while preserving its meaning. If no tone is specified, use natural polished language. Return the rewritten version first.',
            '!bio': 'Create 3 concise, distinctive profile bios based only on the supplied details. Do not invent achievements or personal facts.',
            '!story': 'Write an engaging short story from the supplied prompt, with a clear beginning, development, and ending. Keep it suitable for a WhatsApp message.',
            '!ideas': 'Brainstorm 12 practical, varied ideas for the supplied topic. Make them specific and avoid duplicates.',
            '!post': 'Create a ready-to-publish social-media post from the supplied topic. Include a strong opening, useful body, call to action, and a small set of relevant hashtags. Do not invent factual claims.'
          };
          await sock.sendMessage(jid, { text: '✨ Nancy Nova AI is creating your content...' }, { quoted: msg }).catch(() => {});
          const aiResult = await askAnyProvider(`${instructions[command]}\n\nUser brief:\n${argument}`, { chatId: jid, withContext: false });
          const result = aiResult.text;
          await sock.sendMessage(jid, { text: result.slice(0, 6000) }, { quoted: msg }); continue;
        }
        if (command === '!note') {
          const action = (args[0] || '').toLowerCase();
          const notes = taskData.notes[taskKey] ||= [];
          if (action === 'add' && args.slice(1).join(' ').trim()) {
            notes.push({ id: (notes.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1), text: args.slice(1).join(' ').trim(), createdAt: Date.now() });
            await saveTaskData(); await sock.sendMessage(jid, { text: `📝 Note saved as #${notes[notes.length - 1].id}. Use !notes to view your notes.` }, { quoted: msg });
          } else if (action === 'delete') {
            const id = Number(args[1]); const index = notes.findIndex(n => Number(n.id) === id);
            if (index < 0) await sock.sendMessage(jid, { text: 'Note not found. Use !notes to see note IDs.' }, { quoted: msg });
            else { notes.splice(index, 1); await saveTaskData(); await sock.sendMessage(jid, { text: `🗑️ Note #${id} deleted.` }, { quoted: msg }); }
          } else if (action === 'clear') {
            taskData.notes[taskKey] = []; await saveTaskData(); await sock.sendMessage(jid, { text: 'All your notes in this chat were deleted.' }, { quoted: msg });
          } else await sock.sendMessage(jid, { text: notes.length ? `📝 *YOUR NOTES*\n${notes.map(n => `${n.id}. ${n.text}`).join('\n').slice(0, 5000)}\n\nAdd: !note add text\nDelete: !note delete ID\nClear: !note clear` : 'You have no notes yet. Add one with !note add your note.' }, { quoted: msg });
          continue;
        }
        if (command === '!notes') {
          const notes = taskData.notes[taskKey] || [];
          await sock.sendMessage(jid, { text: notes.length ? `📝 *YOUR NOTES*\n${notes.map(n => `${n.id}. ${n.text}`).join('\n').slice(0, 5000)}\n\nAdd: !note add text · Delete: !note delete ID · Clear: !note clear` : 'No saved notes. Use !note add your note.' }, { quoted: msg }); continue;
        }
        if (command === '!todo') {
          const action = (args[0] || '').toLowerCase(); const todos = taskData.todos[taskKey] ||= [];
          if (action === 'add' && args.slice(1).join(' ').trim()) {
            todos.push({ id: todos.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1, text: args.slice(1).join(' ').trim(), done: false, createdAt: Date.now() });
            await saveTaskData(); await sock.sendMessage(jid, { text: `✅ Task added as #${todos[todos.length - 1].id}. Use !todos to view your list.` }, { quoted: msg });
          } else if (action === 'clear') {
            taskData.todos[taskKey] = []; await saveTaskData(); await sock.sendMessage(jid, { text: 'Your task list has been cleared.' }, { quoted: msg });
          } else await sock.sendMessage(jid, { text: todos.length ? `📋 *YOUR TASKS*\n${todos.map(t => `${t.done ? '☑' : '☐'} ${t.id}. ${t.text}`).join('\n').slice(0, 5000)}\n\nAdd: !todo add task\nComplete: !done ID` : 'Your task list is empty. Add one with !todo add your task.' }, { quoted: msg });
          continue;
        }
        if (command === '!todos') {
          const todos = taskData.todos[taskKey] || [];
          await sock.sendMessage(jid, { text: todos.length ? `📋 *YOUR TASKS*\n${todos.map(t => `${t.done ? '☑' : '☐'} ${t.id}. ${t.text}`).join('\n').slice(0, 5000)}\n\nAdd: !todo add task · Complete: !done ID · Clear: !todo clear` : 'Your task list is empty. Use !todo add your task.' }, { quoted: msg }); continue;
        }
        if (command === '!done') {
          const todos = taskData.todos[taskKey] || []; const id = Number(args[0]); const todo = todos.find(t => Number(t.id) === id);
          if (!todo) await sock.sendMessage(jid, { text: 'Task not found. Use !todos to view task IDs.' }, { quoted: msg });
          else { todo.done = true; todo.completedAt = Date.now(); await saveTaskData(); await sock.sendMessage(jid, { text: `☑️ Task #${id} marked complete.` }, { quoted: msg }); }
          continue;
        }
        if (command === '!remind') {
          const duration = parseReminderDuration(args[0]); const reminderText = args.slice(1).join(' ').trim();
          if (!duration || !reminderText) { await sock.sendMessage(jid, { text: 'Usage: !remind 10m take a break\nAllowed: 10s–30d (examples: 30s, 10m, 2h, 1d). Reminders are saved across restarts.' }, { quoted: msg }); continue; }
          const senderJid = messageSender(msg); const id = `R${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
          taskData.reminders.push({ id, chatJid: jid, senderJid, text: reminderText.slice(0, 1000), dueAt: Date.now() + duration, createdAt: Date.now() });
          await saveTaskData(); await sock.sendMessage(jid, { text: `⏰ Reminder set for ${args[0]} from now.\nID: ${id}\nCancel: !cancelreminder ${id}` }, { quoted: msg }); continue;
        }
        if (command === '!reminders') {
          const senderJid = normalizeJid(messageSender(msg)); const pending = taskData.reminders.filter(r => r.chatJid === jid && normalizeJid(r.senderJid) === senderJid && !r.sentAt);
          await sock.sendMessage(jid, { text: pending.length ? `⏰ *YOUR REMINDERS*\n${pending.map(r => `• ${r.id} — ${new Date(Number(r.dueAt)).toLocaleString()}\n  ${r.text}`).join('\n').slice(0, 4500)}\n\nCancel: !cancelreminder ID` : 'You have no pending reminders in this chat. Use !remind 10m text.' }, { quoted: msg }); continue;
        }
        if (command === '!cancelreminder') {
          const id = String(args[0] || '').trim(); const senderJid = normalizeJid(messageSender(msg));
          const index = taskData.reminders.findIndex(r => r.id === id && r.chatJid === jid && normalizeJid(r.senderJid) === senderJid && !r.sentAt);
          if (index < 0) await sock.sendMessage(jid, { text: 'Pending reminder not found. Use !reminders to see your reminders.' }, { quoted: msg });
          else { taskData.reminders.splice(index, 1); await saveTaskData(); await sock.sendMessage(jid, { text: `Reminder ${id} cancelled.` }, { quoted: msg }); }
          continue;
        }
        if (['!sticker', '!toimage', '!tovideo', '!qr', '!readqr', '!ocr', '!compress', '!resize', '!pdf', '!summarizepdf', '!transcribe', '!tts', '!image'].includes(command)) {
          await processMediaCommand(sock, msg, jid, command, argument); continue;
        }
        switch (command) {
          case '!tourl': {
            const uploaded = await uploadMediaToCatbox(sock, msg);
            await sock.sendMessage(jid, { text: `✨ *CATBOX MEDIA LINK*\n\n🔗 ${uploaded.url}\n📦 ${(uploaded.bytes / (1024 * 1024)).toFixed(2)} MB\n🧾 ${uploaded.mime}\n\nAnyone with this link may be able to access the uploaded file.`, linkPreview: { title: 'Open uploaded media' } }, { quoted: msg });
            break;
          }
          case '!tostatus': case '!tomystatus': {
            await sendPersonalStatusMedia(sock, msg, jid, argument);
            await sock.sendMessage(jid, { text: '✨ Status upload request sent to WhatsApp. Check your Status/Updates tab to confirm it published.' }, { quoted: msg });
            break;
          }
          case '!togrpstatus': {
            await sendGroupStatusMedia(sock, msg, jid, argument);
            await sock.sendMessage(jid, { text: '✅ Media sent to the group status audience.' }, { quoted: msg });
            break;
          }
          case '!getpp': {
            let targetJid = '';
            const quoted = getQuotedMessage(msg);
            if (quoted?.participant) targetJid = quoted.participant;
            else if (jid.endsWith('@s.whatsapp.net')) targetJid = jid;
            else if (args[0]) targetJid = targetFromQuotedOrArg(msg, args);
            if (!targetJid) throw new Error('Reply to someone, use !getpp in a private chat, or provide their phone number.');
            const pp = await getProfilePictureUrl(sock, targetJid);
            if (!pp) throw new Error('No accessible profile picture was found. Privacy settings may prevent access.');
            await sock.sendMessage(jid, { image: { url: pp }, caption: `🖼️ Profile picture for ${displayJid(targetJid)}` }, { quoted: msg });
            break;
          }
          case '!getabout': {
            let targetJid = '';
            const quoted = getQuotedMessage(msg);
            if (quoted?.participant) targetJid = quoted.participant;
            else if (jid.endsWith('@s.whatsapp.net')) targetJid = jid;
            else if (args[0]) targetJid = targetFromQuotedOrArg(msg, args);
            if (!targetJid) throw new Error('Reply to someone, use !getabout in a private chat, or provide their phone number.');
            const status = await sock.fetchStatus(targetJid);
            const about = status?.status || 'No About text set.';
            await sock.sendMessage(jid, { text: `ℹ️ *ABOUT*\n👤 ${displayJid(targetJid)}\n📝 ${about}` }, { quoted: msg });
            break;
          }
          case '!getbio': {
            const targets = resolveTargetJids(msg, args);
            if (!targets[0]) throw new Error('Reply to someone, mention them, use a phone number, or run !getbio in a private chat.');
            const status = await sock.fetchStatus(targets[0]);
            const about = status?.status || 'No About/bio text set.';
            await sock.sendMessage(jid, { text: `📝 *BIO / ABOUT*\n👤 ${targetLabel(targets[0])}\n${about}` }, { quoted: msg });
            break;
          }
          case '!getstatus': {
            const targets = resolveTargetJids(msg, args);
            if (!targets[0]) throw new Error('Reply to someone, mention them, use a phone number, or use this in a private chat.');
            const target = normalizeJid(targets[0]);
            try { await sock.presenceSubscribe(target); } catch {}
            await new Promise(resolve => setTimeout(resolve, 1200));
            const cached = presenceCache.get(target);
            const status = await sock.fetchStatus(target).catch(() => null);
            await sock.sendMessage(jid, { text: `📡 *STATUS*\n👤 ${targetLabel(targets[0])}\n🟢 Presence: ${cached?.presence || 'unknown'}\n📝 About: ${status?.status || 'Not available'}\nℹ️ WhatsApp may hide presence based on privacy settings.` }, { quoted: msg });
            break;
          }
          case '!getpresence': {
            const targets = resolveTargetJids(msg, args);
            if (!targets[0]) throw new Error('Reply to someone, mention them, use a phone number, or use this in a private chat.');
            const target = normalizeJid(targets[0]);
            try { await sock.presenceSubscribe(target); } catch {}
            await new Promise(resolve => setTimeout(resolve, 1200));
            const cached = presenceCache.get(target);
            await sock.sendMessage(jid, { text: `📡 *PRESENCE*\n👤 ${targetLabel(targets[0])}\nStatus: ${cached?.presence || 'unknown'}${cached?.lastSeen ? `\nLast seen: ${new Date(cached.lastSeen).toLocaleString()}` : ''}\n\nPrivacy settings can make presence unavailable.` }, { quoted: msg });
            break;
          }
          case '!checknumber': {
            const raw = args[0] || '';
            const digits = raw.replace(/[^0-9]/g, '');
            if (digits.length < 7 || digits.length > 15) throw new Error('Usage: !checknumber 2547XXXXXXXX');
            const result = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
            const item = Array.isArray(result) ? result[0] : result;
            if (!item?.exists) {
              await sock.sendMessage(jid, { text: `❌ *NOT FOUND*\n+${digits} does not appear to be registered on WhatsApp.` }, { quoted: msg });
            } else {
              await sock.sendMessage(jid, { text: `✅ *WHATSAPP NUMBER FOUND*\n📱 +${digits}\n🆔 ${item.jid || 'Available'}\n🔗 LID: ${item.lid || 'Not exposed'}` }, { quoted: msg });
            }
            break;
          }
          case '!userinfo': {
            const targets = resolveTargetJids(msg, args);
            if (!targets[0]) throw new Error('Reply to someone, mention them, use a phone number, or use this in a private chat.');
            const target = targets[0];
            const pp = await getProfilePictureUrl(sock, target);
            const about = await sock.fetchStatus(target).catch(() => null);
            const cached = presenceCache.get(normalizeJid(target));
            const textInfo = `👤 *USER INFO*\n📱 ${targetLabel(target)}\n🆔 JID: ${target}\n📝 About: ${about?.status || 'Not available'}\n📡 Presence: ${cached?.presence || 'unknown'}\n🖼️ Profile picture: ${pp ? 'available' : 'not accessible'}`;
            if (pp) await sock.sendMessage(jid, { image: { url: pp }, caption: textInfo }, { quoted: msg });
            else await sock.sendMessage(jid, { text: textInfo }, { quoted: msg });
            break;
          }
          case '!del': case '!delete': case '!delmsg': case '!rm':
            await handleDeleteCommand(sock, msg, jid, owner);
            break;
          case '!id': {
            const targets = resolveTargetJids(msg, args);
            const target = targets[0] || (inGroup ? jid : '');
            if (!target) throw new Error('Reply to someone, mention them, provide a phone number, or use this in a private chat.');
            await sock.sendMessage(jid, { text: `🆔 *WHATSAPP ID*\n👤 ${targetLabel(target)}\n\`${target}\`` }, { quoted: msg });
            break;
          }
          case '!mention': {
            const targets = resolveTargetJids(msg, args, { allowCurrentChat: false });
            if (!targets.length) throw new Error('Mention someone, reply to them, or provide their phone number.');
            const mentionText = args.filter(a => !/^\d{7,15}$/.test(a.replace(/[^0-9]/g, ''))).join(' ').trim() || 'You have been mentioned by Nancy Nova AI.';
            await sock.sendMessage(jid, { text: `${mentionText}\n${targets.map(targetLabel).join(' ')}`, mentions: targets }, { quoted: msg });
            break;
          }
          case '!vcard': {
            const targets = resolveTargetJids(msg, args);
            if (!targets[0]) throw new Error('Reply to someone, mention them, provide their phone number, or use this in a private chat.');
            const target = targets[0];
            const phone = phoneFromJid(target);
            const name = `WhatsApp ${phone || targetLabel(target).replace(/^@/, '')}`;
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${phone}:${phone ? '+' + phone : ''}\nEND:VCARD`;
            await sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } }, { quoted: msg });
            break;
          }
          case '!apk': {
            if (!argument) throw new Error('Usage: !apk App Name (for example: VLC or Signal)');
            await sock.sendMessage(jid, { text: `🔎 Searching APK sources for *${argument}*…` }, { quoted: msg });
            const result = await lookupApkDownload(argument);
            if (!result.direct) {
              await sock.sendMessage(jid, { text: `⚠️ I couldn't find a downloadable APK file for *${argument}*.\n\nTry the exact app name (and the publisher), for example: !apk VLC or !apk Signal.\n\n🔎 You can also search here:\n${result.url}` }, { quoted: msg });
              break;
            }
            // Actually download the APK binary and send it as a document, instead
            // of posting a link. Streaming servers may redirect a few times.
            await sock.sendMessage(jid, { text: `📦 Found *${argument}* on ${result.source}. Downloading the APK… this can take a moment 💫` }, { quoted: msg });
            const MAX_APK_BYTES = 95 * 1024 * 1024;
            let apkBuffer = null;
            let apkError = '';
            try {
              const res = await fetch(result.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' },
                redirect: 'follow',
                signal: AbortSignal.timeout(120000)
              });
              if (!res.ok) throw new Error(`download server returned HTTP ${res.status}`);
              const lenHeader = Number(res.headers.get('content-length') || 0);
              if (lenHeader && lenHeader > MAX_APK_BYTES) throw new Error(`file is too large (${(lenHeader/1048576).toFixed(1)} MB, limit 95 MB)`);
              const buf = Buffer.from(await res.arrayBuffer());
              if (buf.length > MAX_APK_BYTES) throw new Error(`file is too large (${(buf.length/1048576).toFixed(1)} MB, limit 95 MB)`);
              // Basic sanity check: a real APK is a ZIP, so it starts with 'PK'.
              if (buf.length < 1024 || !(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('the server did not return a valid APK/ZIP file (it may be a split XAPK or a blocked link)');
              apkBuffer = buf;
            } catch (error) { apkError = error.message; }
            if (apkBuffer) {
              const safeName = `${argument.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g,'').slice(0,40) || 'app'}.apk`;
              await sock.sendMessage(jid, {
                document: apkBuffer,
                mimetype: 'application/vnd.android.package-archive',
                fileName: safeName,
                caption: `📦 *${argument}* — ${(apkBuffer.length/1048576).toFixed(1)} MB\n💾 Source: ${result.source}\n⚠️ Verify the publisher before installing. 💎 ${TEAM_NAME}`
              }, { quoted: msg });
            } else {
              await sock.sendMessage(jid, { text: `⚠️ I located *${argument}* on ${result.source} but could not deliver the APK file directly (${apkError}).\n\nYou can grab it here:\n${result.page || result.url}` }, { quoted: msg });
            }
            break;
          }
          case '!toqr': case '!qr': {
            const quotedText = getText(getQuotedMessage(msg)?.message || {});
            const payload = argument || quotedText;
            if (!payload) throw new Error('Usage: !toqr text or URL. A QR stores text/a link, not a binary media file; for media use its public URL.');
            if (payload.length > 2500) throw new Error('QR content is too long (maximum 2500 characters).');
            const qrBuffer = await QRCode.toBuffer(payload, { type: 'png', width: 700, margin: 2, errorCorrectionLevel: 'M' });
            await sock.sendMessage(jid, { image: qrBuffer, caption: `🔳 *QR CODE READY*\n${payload.length > 180 ? payload.slice(0,177)+'...' : payload}` }, { quoted: msg });
            break;
          }
          case '!join': {
            const invite = (argument.match(/(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i) || [])[1];
            if (!invite) throw new Error('Usage: !join https://chat.whatsapp.com/INVITECODE');
            if (!owner) throw new Error('Only the bot owner can make Nancy Nova AI join another group.');
            const result = await sock.groupAcceptInvite(invite);
            await sock.sendMessage(jid, { text: `✅ WhatsApp accepted the join request. Group ID: ${result || 'joined (ID not returned)'}` }, { quoted: msg });
            break;
          }
          case '!vcf': {
            if (!inGroup) throw new Error('Use !vcf inside the group whose contacts you want to export.');
            const { metadata } = await getGroupContext(sock, msg, jid, owner);
            const people = metadata.participants || [];
            if (!people.length) throw new Error('WhatsApp returned no participants for this group.');
            // Build ONE vCard block per member, all merged into a single .vcf file.
            const vcardName = (person, index) => {
              const raw = String(person.name || person.notify || person.verifiedName || person.pushName || '').replace(/[\r\n;]/g, ' ').trim();
              return raw || `Group member ${index + 1}`;
            };
            const entries = [];
            let skipped = 0;
            people.forEach((person, index) => {
              // Members who hide their phone number come back as "@lid" ids. The
              // digits of that id still identify the contact on WhatsApp, so it is
              // exported instead of being dropped (that was why only 2 of all
              // members appeared in the file).
              const rawIds = [person.phoneNumber, person.id, person.jid, participantJid(person), person.lid, person.lidJid]
                .filter(Boolean).map(String);
              let phone = '';
              for (const raw of rawIds) {
                const digits = (phoneFromJid(raw.includes('@') ? raw : `${raw}@s.whatsapp.net`) || String(raw).split('@')[0] || '').replace(/\D/g, '');
                if (digits.length >= 7 && digits.length <= 15) { phone = digits; break; }
              }
              if (!phone) { skipped++; return; }
              const name = vcardName(person, index);
              entries.push([
                'BEGIN:VCARD',
                'VERSION:3.0',
                `FN:${name}`,
                `N:${name};;;;`,
                `TEL;TYPE=CELL:+${phone}`,
                `ORG:${String(metadata.subject || 'WhatsApp Group').replace(/[\r\n;]/g, ' ')}`,
                'END:VCARD'
              ].join('\r\n'));
            });
            if (!entries.length) throw new Error('WhatsApp did not expose phone numbers for these participants, so no contacts could be exported.');
            const buffer = Buffer.from('\uFEFF' + entries.join('\r\n') + '\r\n', 'utf8');
            const safeSubject = String(metadata.subject || 'group').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
            await sock.sendMessage(jid, {
              document: buffer,
              mimetype: 'text/vcard',
              fileName: `${safeSubject}-contacts-${new Date().toISOString().slice(0,10)}.vcf`,
              caption: `📇 *GROUP CONTACTS EXPORTED*\n👥 Group: ${metadata.subject || 'this group'}\n✅ Contacts in file: ${entries.length} of ${people.length}${skipped ? `\n⚠️ Skipped: ${skipped} (no usable number exposed by WhatsApp)` : ''}\n💾 One single .vcf file.\n\n📱 *To import:* save the file, then open your Contacts app → Settings/Manage → Import contacts → choose this file → "Import all". On a laptop, open the file with Windows Contacts or your phone after sending it to yourself.`
            }, { quoted: msg });
            break;
          }
          case '!listonline': case '!listoffline': {
            if (!inGroup) throw new Error('Use this command inside a group. Presence may be incomplete because of WhatsApp privacy settings.');
            const { metadata } = await getGroupContext(sock, msg, jid, owner);
            const wantOnline = command === '!listonline';
            const matches = (metadata.participants || []).filter(person => {
              const candidates = [person.id, person.jid, person.phoneNumber, person.lid, participantJid(person)].filter(Boolean).map(normalizeJid);
              const online = candidates.some(candidate => ['available','composing','recording'].includes(presenceCache.get(candidate)?.presence));
              return online === wantOnline;
            });
            const body = matches.slice(0,80).map((person,i)=>`${i+1}. ${displayJid(participantJid(person) || person.id || person.jid || 'Unknown')}`).join('\n');
            await sock.sendMessage(jid, { text: `📡 *${wantOnline ? 'KNOWN ONLINE' : 'OFFLINE / NOT VISIBLE'} MEMBERS*\n${body || 'No matching presence records are currently available.'}\n\n⚠️ This is not a guaranteed complete live list; WhatsApp may hide presence.` }, { quoted: msg });
            break;
          }
          case '!setfont': {
            const style = (args[0] || '').toLowerCase();
            const value = args.slice(1).join(' ').trim();
            const alphabets = {
              bold: ['𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙','𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳','𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗'],
              italic: ['𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍','𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧','0123456789'],
              script: ['𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵','𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏','0123456789'],
              double: ['𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ','𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫','𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡'],
              mono: ['𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉','𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣','𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿']
            };
            if (!value || !alphabets[style]) throw new Error('Usage: !setfont bold|italic|script|double|mono Your text');
            const [upper,lower,digits]=alphabets[style], map=new Map();
            [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].forEach((c,i)=>map.set(c,[...upper][i]||c));
            [...'abcdefghijklmnopqrstuvwxyz'].forEach((c,i)=>map.set(c,[...lower][i]||c));
            [...'0123456789'].forEach((c,i)=>map.set(c,[...digits][i]||c));
            await sock.sendMessage(jid, { text: [...value].map(c=>map.get(c)||c).join('') }, { quoted: msg });
            break;
          }
          case '!antigrpmention': {
            if (!inGroup) throw new Error('Use !antigrpmention on/off inside the group.');
            await getGroupContext(sock, msg, jid, owner);
            await sock.sendMessage(jid, { text: '⚠️ Baileys does not expose reliable group-name mentions in members’ Status posts to this bot, so it cannot safely delete those Status posts. No setting was changed.' }, { quoted: msg });
            break;
          }
          case '!approve': {
            if (!inGroup) throw new Error('Use !approve inside the group.');
            await getGroupContext(sock, msg, jid, owner);
            throw new Error('This connection does not provide a reliable pending-join-request list here. Approve requests in WhatsApp Group info → Pending participants; the bot has not claimed to approve anyone.');
          }
          case '!antiforeign': {
            if (!inGroup) throw new Error('Use !antiforeign on/off inside the group.');
            if (!['on','off','status'].includes((args[0]||'').toLowerCase())) throw new Error('Usage: !antiforeign on | off | status');
            await sock.sendMessage(jid, { text: '⚠️ Automatic country blocking is not enabled. WhatsApp may hide phone numbers behind LIDs, and a number prefix does not reliably prove a member’s current country. No members were removed.' }, { quoted: msg });
            break;
          }
          case '!porn': case '!milf': {
            throw new Error('This video-fetching command has been removed. Use supported, legal video search commands from the menu.');
          }
          case '!biblelist': {
            await sock.sendMessage(jid, { text: '📖 *BIBLE BOOKS*\n*Old Testament📜:* Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, 1–2 Samuel, 1–2 Kings, 1–2 Chronicles, Ezra, Nehemiah, Esther, Job, Psalms, Proverbs, Ecclesiastes, Song of Solomon, Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, Obadiah, Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi.\n\n*New Testament📜:* Matthew, Mark, Luke, John, Acts, Romans, 1–2 Corinthians, Galatians, Ephesians, Philippians, Colossians, 1–2 Thessalonians, 1–2 Timothy, Titus, Philemon, Hebrews, James, 1–2 Peter, 1–3 John, Jude, Revelation.\n\nExample: !bible John 3:16' }, { quoted: msg });
            break;
          }
          case '!quran': case '!ayah': {
            if (!argument) throw new Error(`Usage: ${command} 1:1 (Surah:Ayah) or ${command} Al-Fatiha`);
            let apiUrl;
            if (/^\d{1,3}:\d{1,3}$/.test(argument.trim())) {
              const [surah, ayah] = argument.trim().split(':').map(Number);
              if (surah < 1 || surah > 114 || ayah < 1) throw new Error('Use a valid Surah:Ayah reference, for example !quran 1:1.');
              apiUrl = `https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/en.asad`;
            } else {
              const surah = Number(argument.trim());
              if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw new Error('For a named surah, use a numbered reference like !quran 1:1. Named-surah lookup is not available in this build.');
              apiUrl = `https://api.alquran.cloud/v1/surah/${surah}/en.asad`;
            }
            const response = await fetch(apiUrl, { signal: AbortSignal.timeout(12000) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.code !== 200) throw new Error('Quran lookup service is unavailable right now. Please try again later.');
            const item = data.data;
            const textOut = item?.text ? `Surah ${item.surah?.englishName || item.surah?.number}, Ayah ${item.numberInSurah}: ${item.text}` :
              `Surah ${item?.englishName || item?.number} — ${item?.englishNameTranslation || ''}\n` + (item?.ayahs || []).slice(0, 8).map(a => `${a.numberInSurah}. ${a.text}`).join('\n');
            await sock.sendMessage(jid, { text: `📖 *QURAN TEXT (English translation)*\n${textOut}\n\nTranslation: Muhammad Asad. For full context, consult a trusted Quran edition.` }, { quoted: msg });
            break;
          }
          case '!gita': {
            if (!argument) throw new Error('Usage: !gita chapter:verse, for example !gita 2:47. This build does not have a verified Gita text API configured yet.');
            throw new Error('A verified Bhagavad Gita text provider is not configured, so I will not invent or misquote a verse. Configure a trusted source/API to enable exact verse delivery.');
          }
          case '!bible': {
            if (!argument) throw new Error('Usage: !bible John 3:16');
            const reference = encodeURIComponent(argument.trim());
            const response = await fetch(`https://bible-api.com/${reference}?translation=kjv`, { signal: AbortSignal.timeout(12000) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.text) throw new Error('Bible lookup failed. Check the reference (example: !bible John 3:16) and try again.');
            const passage = String(data.text).trim();
            await sock.sendMessage(jid, { text: `📖 *BIBLE — ${data.reference || argument}*\n\n${passage.slice(0, 3500)}\n\n— ${data.translation_name || 'King James Version'}` }, { quoted: msg });
            break;
          }
          case '!snake': case '!tetris': {
            const game = command.slice(1);
            await sock.sendMessage(jid, { text: `🎮 *${game.toUpperCase()}*\nPlay online: https://www.google.com/search?q=${encodeURIComponent(game+' game play online')}\n\nThis opens playable web results; it is not an interactive game running inside WhatsApp.` }, { quoted: msg });
            break;
          }
          case '!livescore': case '!livehighlights': case '!fifamatches': case '!epl': case '!fifaupcoming': case '!fifascores': case '!bundesliga': case '!euros': case '!laliga': case '!seria': case '!ulc': case '!fifastandings': case '!gameevents': case '!kpl': {
            if (['!livehighlights'].includes(command)) throw new Error('Video highlights need a licensed highlights provider. This command is not connected to one yet.');
            if (['!fifastandings','!kpl'].includes(command)) throw new Error(`${command} needs a dedicated standings/league data provider. I will not return a fake score table.`);
            const leagues = {
              '!epl':['eng.1','English Premier League'],
              '!bundesliga':['ger.1','Bundesliga'],
              '!laliga':['esp.1','La Liga'],
              '!seria':['ita.1','Italian Serie A'],
              '!ulc':['uefa.champions','UEFA Champions League'],
              '!euros':['uefa.euro','UEFA European Championship'],
              '!livescore':['eng.1','Football scores'],
              '!fifamatches':['fifa.friendly','International football'],
              '!fifaupcoming':['eng.1','Upcoming football'],
              '!fifascores':['eng.1','Football scores'],
              '!gameevents':['eng.1','Football match events']
            };
            const [league, label] = leagues[command] || leagues['!livescore'];
            const params = command === '!fifaupcoming' ? '?dates=' + new Date().toISOString().slice(0,10).replaceAll('-','') : '';
            const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard${params}`, { signal: AbortSignal.timeout(12000) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !Array.isArray(data.events)) throw new Error(`The live sports feed for ${label} is unavailable right now. Try again later.`);
            const events = data.events.slice(0, 12);
            if (!events.length) {
              await sock.sendMessage(jid, { text: `⚽ *${label.toUpperCase()}*\nNo fixtures were returned by the current feed. This can mean there are no scheduled matches in the selected window.` }, { quoted: msg });
              break;
            }
            const rows = events.map(event => {
              const comp = event.competitions?.[0];
              const teams = (comp?.competitors || []).map(c => `${c.team?.displayName || c.team?.name || 'Team'} ${c.score ?? ''}`.trim());
              const status = comp?.status?.type?.shortDetail || event.status?.type?.shortDetail || event.date || 'Scheduled';
              return `• ${teams.join(' vs ') || event.name || 'Match'}\n  ${status}`;
            });
            await sock.sendMessage(jid, { text: `⚽ *${label.toUpperCase()}*\n${rows.join('\n')}\n\nFeed: ESPN scoreboard data` }, { quoted: msg });
            break;
          }
          case '!hneko': case '!hwaifu': case '!konachan': case '!neko': case '!shorta': case '!husby': {
            // Keyless anime image retrieval: this path never calls OpenAI or image-generation billing.
            await sock.sendMessage(jid, { text: '🐾⋘ 𝑙𝑜𝑎𝑑𝑖𝑛𝑔 𝑑𝑎𝑡𝑎... ⋙\n⋘ 𝑃𝑙𝑒𝑎𝑠𝑒 𝑤𝑎𝑖𝑡... ⋙' }, { quoted: msg });
            const image = await fetchAnimeImageBuffer(command, argument);
            await sock.sendMessage(jid, { image, caption: `🐾 *${command.slice(1).toUpperCase()}*\nImage Generated 💫 • Team NASA\n_Generated by Nancy Nova AI._` }, { quoted: msg });
            break;
          }
          case '!leaves': case '!fire': case '!devil': case '!hacker': case '!ice': case '!matrixfx': case '!neon': case '!impressive': case '!snow': case '!nancy': case '!blackpink': case '!flagtext': case '!devbrn': case '!typography': case '!royaltext': case '!blckpinkstyle': case '!graffiti': case '!royal': case '!galaxywallpaper': case '!pixelglitch': case '!cartoonstyle': case '!deadpool': case '!bear': case '!dragonball': {
            // These are TEXT EFFECTS: the exact wording the user supplies is rendered
            // locally with a real font on a themed background, so the picture always
            // shows THEIR text (no AI guessing, no misspelled, no unrelated image).
            const styleKey = command.slice(1);
            let posterText = String(argument || '').trim();
            if (!posterText) {
              // No text given -> reply to a message and use its text, or say what to do.
              const quotedContent = getQuotedMessage(msg);
              const quotedText = quotedContent ? getText(quotedContent.message) : '';
              if (!quotedText?.trim()) {
                await sock.sendMessage(jid, { text: `🏳️ *${styleKey.toUpperCase()}*
Send the words after the command, e.g.
${getCommandPrefix(sock)}${styleKey} Dev Brian
_Or reply to any message with the command to use that text._` }, { quoted: msg });
                break;
              }
              posterText = quotedText.trim();
            }
            posterText = posterText.replace(/\s+/g, ' ').slice(0, 120);
            await sock.sendMessage(jid, { text: `🎨 *${styleKey.toUpperCase()}* — rendering your text…` }, { quoted: msg });
            const poster = await renderTextPoster(styleKey, posterText);
            await sock.sendMessage(jid, { image: poster, caption: `🎨 *NANCY NOVA AI — ${styleKey.toUpperCase()}*
📝 ${posterText}
🛰️ ${TEAM_NAME}` }, { quoted: msg });
            break;
          }
          case '!setpp': {
            if (!owner) throw new Error('Only the bot owner can change the bot profile picture.');
            await setProfilePictureFromMedia(sock, msg, sock.user?.id || `${OWNER_NUMBER}@s.whatsapp.net`);
            await sock.sendMessage(jid, { text: '✅ Nancy Nova AI profile picture updated.' }, { quoted: msg });
            break;
          }
          case '!setgpp': {
            if (!inGroup) throw new Error('!setgpp only works inside a group.');
            const { botIsAdmin } = await getGroupContext(sock, msg, jid, owner);
            if (!botIsAdmin) throw new Error('Please make Nancy Nova AI a group admin before using !setgpp.');
            await setProfilePictureFromMedia(sock, msg, jid);
            await sock.sendMessage(jid, { text: '✅ Group profile picture updated.' }, { quoted: msg });
            break;
          }
          case '!autoreact': {
            if (!owner) throw new Error('Only the primary or an additional bot owner can change global auto-reactions.');
            const value = (args[0] || '').toLowerCase();
            if (!['on','off','status'].includes(value)) throw new Error('Usage: !autoreact on | off | status');
            if (value === 'on') botSettings.autoReact = true;
            if (value === 'off') botSettings.autoReact = false;
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `🎲 *AUTO-REACTIONS*\\nStatus: ${botSettings.autoReact ? 'ON' : 'OFF'}\\n${botSettings.autoReact ? 'Nancy Nova AI will react to incoming non-command messages with a random emoji.' : 'Automatic reactions are disabled.'}` }, { quoted: msg });
            break;
          }
          case '!autoviewstatus': case '!autoviewstatuses': case '!autostatusview': {
            if (!owner) throw new Error('Only the primary or an additional bot owner can control status auto-viewing.');
            const value = (args[0] || '').toLowerCase();
            if (!['on','off','status'].includes(value)) throw new Error('Usage: !autoviewstatus on | off | status');
            if (value === 'on') botSettings.autoViewStatus = true;
            if (value === 'off') botSettings.autoViewStatus = false;
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `👀 *AUTO-VIEW STATUS*\nStatus: ${botSettings.autoViewStatus ? 'ON 💎' : 'OFF'}\n${botSettings.autoViewStatus ? 'Nancy Nova AI will automatically view your contacts’ status updates the moment they post.' : 'Automatic status viewing is disabled.'}` }, { quoted: msg });
            break;
          }
          case '!autolikestatus': case '!autolikestatuses': case '!autostatuslike': case '!autoreactstatus': {
            if (!owner) throw new Error('Only the primary or an additional bot owner can control status auto-liking.');
            const value = (args[0] || '').toLowerCase();
            if (!['on','off','status'].includes(value)) throw new Error('Usage: !autolikestatus on | off | status');
            if (value === 'on') botSettings.autoLikeStatus = true;
            if (value === 'off') botSettings.autoLikeStatus = false;
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `💎 *AUTO-LIKE STATUS*\nStatus: ${botSettings.autoLikeStatus ? 'ON ✨' : 'OFF'}\n${botSettings.autoLikeStatus ? 'Nancy Nova AI will auto-react to your contacts’ status updates with a random emoji the moment they post.' : 'Automatic status reactions are disabled.'}` }, { quoted: msg });
            break;
          }
          case '!pair': {
            if (inGroup) throw new Error(`For privacy, run ${getCommandPrefix(sock)}pair only in a private chat with Nancy Nova AI — never in a group.`);
            if (!owner) throw new Error('Only the primary or approved additional owners can create linked sessions.');
            const requestedNumber = args[0] || '';
            const prefix = getCommandPrefix(sock);
            if (!requestedNumber || ['status', 'help'].includes(requestedNumber.toLowerCase())) {
              await sock.sendMessage(jid, { text: [
                '💎 *LINK A SECOND WHATSAPP ACCOUNT* 💎',
                '◈━━━━━━━━━━━━━━━━━━◈',
                '',
                `*Usage:* ${prefix}pair 2547XXXXXXXX`,
                '_Country code first, digits only — no plus sign, no spaces._',
                '',
                '*WHAT HAPPENS NEXT*',
                '1️⃣ Nancy opens a private channel to WhatsApp',
                '2️⃣ You receive an 8-character pairing code here',
                '3️⃣ Enter it on that phone: *Linked devices → Link a device → Link with phone number instead*',
                '4️⃣ The account goes online and answers its own chats',
                '',
                '*GOOD TO KNOW*',
                '• Codes are single use and expire in about 2 minutes',
                '• Sending the command again always gives a fresh code',
                `• See what is linked with *${prefix}pairstatus*`,
                `• Remove access with *${prefix}unpair 2547XXXXXXXX*`,
                '',
                '_Nancy Nova AI · Team NASA_'
              ].join('\n') }, { quoted: msg });
              break;
            }
            if (requestedNumber.toLowerCase() === 'cancel') {
              const pending = [...pairedSockets.entries()].filter(([, row]) => row.state !== 'connected').map(([phone]) => phone);
              for (const phone of pending) await destroyPairAttempt(phone, { wipe: true });
              await sock.sendMessage(jid, { text: pending.length
                ? `🧹 *CANCELLED*\n\nStopped ${pending.length} unfinished pairing attempt(s): ${pending.map(p => '+' + p).join(', ')}.\nNo linked account was touched.`
                : '🧹 *NOTHING TO CANCEL*\n\nNo pairing attempt is currently running.' }, { quoted: msg });
              break;
            }
            await createPairedSession(requestedNumber, jid, sock);
            break;
          }
          case '!pairstatus': {
            if (!owner) throw new Error('Only owners can view linked-session status.');
            const prefix = getCommandPrefix(sock);
            const rows = [...pairedSockets.entries()];
            const detail = rows.length
              ? rows.map(([phone, row]) => {
                  const label = PAIR_STATE_LABEL[row.state] || row.state;
                  const codeLine = row.state === 'waiting-for-link' && row.code ? `\n     🔐 code *${row.code}* — sent ${pairAgeLabel(row)}` : '';
                  return `📱 *+${phone}*\n     ${label}${codeLine}`;
                }).join('\n\n')
              : 'No additional account is linked right now.';
            const connectedCount = rows.filter(([, row]) => row.state === 'connected').length;
            await sock.sendMessage(jid, { text: [
              '🔐 *LINKED DEVICES*',
              '◈━━━━━━━━━━━━━━━━━━◈',
              '',
              detail,
              '',
              `📊 *Online:* ${connectedCount} of ${rows.length || 0} extra account(s)`,
              '',
              '▸ *Next steps*',
              `• Add an account: ${prefix}pair 2547XXXXXXXX`,
              `• New code for a stalled attempt: send ${prefix}pair again`,
              `• Remove access: ${prefix}unpair 2547XXXXXXXX`,
              '',
              `_Sessions are stored per number and restored automatically after a restart. On hosts that wipe storage, linking may be needed again._`
            ].join('\n') }, { quoted: msg });
            break;
          }
          case '!unpair': case '!unlink': {
            if (!owner) throw new Error('Only owners can remove linked sessions.');
            const target = (args[0] || '').toLowerCase();
            if (target === 'all' || target === 'everything') {
              await unlinkPairedSession('', jid, sock, { all: true });
              break;
            }
            await unlinkPairedSession(args[0] || '', jid, sock);
            break;
          }
          case '!autotyping': {
            const value = (args[0] || '').toLowerCase();
            if (!['on','off','status'].includes(value)) throw new Error('Usage: !autotyping on | off | status');
            if (value === 'on') botSettings.autoTyping = true;
            if (value === 'off') botSettings.autoTyping = false;
            if (value === 'off' && !presenceMode()) clearPresenceTimer(jid);
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `⌨️ Auto-typing: ${botSettings.autoTyping ? 'ON' : 'OFF'}` }, { quoted: msg });
            break;
          }
          case '!autorecording': {
            const value = (args[0] || '').toLowerCase();
            if (!['on','off','status'].includes(value)) throw new Error('Usage: !autorecording on | off | status');
            if (value === 'on') botSettings.autoRecording = true;
            if (value === 'off') botSettings.autoRecording = false;
            if (value === 'off' && !presenceMode()) clearPresenceTimer(jid);
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `🎙️ Auto-recording: ${botSettings.autoRecording ? 'ON' : 'OFF'}` }, { quoted: msg });
            break;
          }
          case '!aistatus': {
            const rows = aiProviderStatus();
            const lines = [
              '🧠 *AI PROVIDER STATUS*',
              '◈━━━━━━━━━━━━━━━━━━◈',
              ...rows.map(r => [
                `${r.emoji} *${r.label.toUpperCase()}* — ${r.configured ? '✅ READY' : '❌ NOT SET'}`,
                `   Key: ${r.keyPreview}`,
                `   Model: ${r.model}`,
                `   Command: ${prefixForDisplay(r.command, getCommandPrefix(sock))}`,
                `   Env: ${r.envKey} / ${r.envModel}`
              ].join('\n')),
              '════════════════════',
              `🤖 Auto-reply: ${botSettings.aiEnabled ? 'ON' : 'OFF'}`,
              `💬 Memory: ${AI_CONTEXT_TURNS} turns, ${Math.round(AI_CONTEXT_TTL_MS / 60000)} min idle reset`,
              `⏱️ Timeout: ${Math.round(AI_PROVIDER_TIMEOUT_MS / 1000)}s`,
              '',
              `${getCommandPrefix(sock)}aistatus test — live-check every provider`,
              '',
              '_Keys are masked and never shown in full._'
            ].join('\n');
            await sock.sendMessage(jid, { text: lines }, { quoted: msg });
            break;
          }
          case '!aitest': {
            await sock.sendMessage(jid, { text: '🧪 Testing every configured AI provider… this can take a few seconds.' }, { quoted: msg });
            const results = [];
            for (const key of AI_PROVIDER_ORDER) results.push(await testProvider(key));
            const body = results.map(r => r.ok
              ? `✅ *${r.provider}* — working (${r.ms} ms)\n   _"${String(r.sample || '').replace(/\n/g, ' ')}"_`
              : `❌ *${r.provider}* — failed\n${String(r.error || 'unknown error').split('\n').map(l => '   ' + l).join('\n')}${r.raw ? `\n   ▪ provider said: ${r.raw.slice(0, 180)}` : ''}`).join('\n\n');
            const okCount = results.filter(r => r.ok).length;
            await sock.sendMessage(jid, { text: `🧪 *AI CONNECTION TEST*\n◈━━━━━━━━━━━━━━━━━━◈\n\n${body}\n\n════════════════════\n${okCount}/${results.length} provider(s) responding.` }, { quoted: msg });
            break;
          }
          case '!ai': {
            const value = (args[0] || '').toLowerCase();
            if (!['on','off','status'].includes(value)) throw new Error('Usage: !ai on | off | status');
            if (value === 'on') botSettings.aiEnabled = true;
            if (value === 'off') botSettings.aiEnabled = false;
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `🧠 *AI AUTO-REPLY*\nStatus: ${botSettings.aiEnabled ? 'ON' : 'OFF'}\n${botSettings.aiEnabled ? 'Nancy Nova AI will answer normal incoming text messages.' : 'Normal incoming text will be ignored unless it starts with a command.'}` }, { quoted: msg });
            break;
          }
          case '!generate': case '!dalle': {
            if (!argument) {
              await sock.sendMessage(jid, { text: `🎨 *HOW TO USE ${command}*\n\nType the command and then describe the picture you want, then the bot draws it for you.\n\n▸ *Format:*\n${command} <your description>\n\n▸ *Examples:*\n${command} a futuristic city at night, cinematic, ultra detailed\n${command} a cute cat astronaut floating in space, cartoon style\n${command} a red sports car on a mountain road at sunset\n\n💡 *Tips for better results:*\n1. Be specific — mention colors, mood, and style.\n2. Add a style word like: cinematic, cartoon, 3D, oil painting, anime.\n3. Keep it under 2000 characters.\n\n🎭 Want anime art? Use: !anime <description>` }, { quoted: msg });
              break;
            }
            if (argument.length > 2000) throw new Error('Image prompts must be 2000 characters or less.');
            await sock.sendMessage(jid, { text: '🎨 *PHOTOLAB*\n🧠 Creating your image… this can take up to a minute.' }, { quoted: msg });
            await sendPhotoLabImages(sock, jid, msg, argument, 'NANCY NOVA AI — CREATED');
            break;
          }
          case '!imagine': {
            if (!argument) throw new Error('Usage: !imagine describe the image you want');
            if (argument.length > 2000) throw new Error('Image prompts must be 2000 characters or less.');
            await sock.sendMessage(jid, { text: '🎨 *PHOTOLAB*\n🧠 Bringing your idea to life…' }, { quoted: msg });
            await sendPhotoLabImages(sock, jid, msg, argument, 'NANCY NOVA AI — IMAGINED');
            break;
          }
          case '!anime': {
            if (!argument) throw new Error('Usage: !anime a brave samurai under cherry blossoms, studio-quality anime art');
            if (argument.length > 2000) throw new Error('Image prompts must be 2000 characters or less.');
            const animePrompt = `High-quality anime illustration, vibrant colors, clean line art, expressive character design, detailed background, cinematic lighting. Subject: ${argument}. Studio-grade anime/manga art style.`;
            await sock.sendMessage(jid, { text: '🎭 *ANIME ART*\n🧠 Drawing your anime scene…' }, { quoted: msg });
            await sendPhotoLabImages(sock, jid, msg, animePrompt, 'NANCY NOVA AI — ANIME ART');
            break;
          }
          case '!aivideo': {
            throw new Error('AI video generation has been removed because its external provider was unreliable. No external video API is called.');
          }
          case '!edit': {
            const media = await getReplyMedia(sock, msg, ['imageMessage']);
            if (!media) throw new Error('Reply to an image with !edit followed by an effect: grayscale, sepia, brighten, darken, sharpen, blur, mirror, flip, rotate 90, warm, cool, or saturate.');
            const effect = (argument || '').trim().toLowerCase();
            if (!effect) throw new Error('Usage: reply to an image with !edit grayscale|sepia|brighten|darken|sharpen|blur|mirror|flip|rotate 90|warm|cool|saturate.');
            let image = sharp(media.buffer).rotate();
            if (effect.includes('gray') || effect.includes('greyscale') || effect.includes('grayscale')) image = image.grayscale();
            else if (effect.includes('sepia')) image = image.recomb([[0.393,0.769,0.189],[0.349,0.686,0.168],[0.272,0.534,0.131]]);
            else if (effect.includes('brighten')) image = image.modulate({ brightness: 1.25 });
            else if (effect.includes('darken')) image = image.modulate({ brightness: 0.72 });
            else if (effect.includes('sharpen')) image = image.sharpen();
            else if (effect.includes('blur')) image = image.blur(3);
            else if (effect.includes('mirror') || effect.includes('flop')) image = image.flop();
            else if (effect === 'flip' || effect.includes('flip vertical')) image = image.flip();
            else if (effect.includes('rotate')) { const match = effect.match(/90|180|270/); image = image.rotate(match ? Number(match[0]) : 90, { background: '#111827' }); }
            else if (effect.includes('warm')) image = image.modulate({ brightness: 1.04, saturation: 1.15 }).tint({ r: 255, g: 214, b: 170 });
            else if (effect.includes('cool')) image = image.modulate({ saturation: 1.08 }).tint({ r: 175, g: 210, b: 255 });
            else if (effect.includes('saturate') || effect.includes('vivid')) image = image.modulate({ saturation: 1.7 });
            else throw new Error('Unknown local effect. Try grayscale, sepia, brighten, darken, sharpen, blur, mirror, flip, rotate 90, warm, cool, or saturate.');
            const edited = await image.png().toBuffer();
            await sock.sendMessage(jid, { image: edited, caption: `🖼️ *LOCAL IMAGE EDIT COMPLETE*\n✏️ Effect: ${effect}\n🛰️ ${TEAM_NAME}\n_Processed locally; no image-edit API used._` }, { quoted: msg });
            break;
          }
          case '!variations': {
            const media = await getReplyMedia(sock, msg, ['imageMessage']);
            if (!media) throw new Error('Reply to an image with !variations.');
            const mode = Math.floor(Math.random() * 4);
            let image = sharp(media.buffer).rotate();
            if (mode === 0) image = image.modulate({ saturation: 1.35, brightness: 1.04 });
            else if (mode === 1) image = image.grayscale().modulate({ brightness: 1.08 });
            else if (mode === 2) image = image.modulate({ saturation: 0.78, brightness: 0.94 }).tint({ r: 195, g: 215, b: 255 });
            else image = image.sharpen().modulate({ saturation: 1.12 });
            const edited = await image.png().toBuffer();
            await sock.sendMessage(jid, { image: edited, caption: `🖼️ *LOCAL IMAGE VARIATION*\n🎨 Variant ${mode + 1} of 4\n🛰️ ${TEAM_NAME}\n_Processed locally; no image-edit API used._` }, { quoted: msg });
            break;
          }
          case '!presence': {
            await sock.sendMessage(jid, { text: `📡 *PRESENCE SETTINGS*\n⌨️ Auto-typing: ${botSettings.autoTyping ? 'ON' : 'OFF'}\n🎙️ Auto-recording: ${botSettings.autoRecording ? 'ON' : 'OFF'}` }, { quoted: msg });
            break;
          }
          case '!ship': {
            const targets = resolveTargetJids(msg, args, { allowCurrentChat: false });
            if (targets.length < 2) throw new Error('Use !ship @user @user (or provide two phone numbers).');
            const score = randomPercent();
            await sock.sendMessage(jid, { text: `💘 *SHIP METER*\n${targetLabel(targets[0])} ❤️ ${targetLabel(targets[1])}\n\nCompatibility: *${score}%*\n${score >= 80 ? '🔥 This ship is sailing!' : score >= 50 ? '👀 There might be something here...' : '😂 The bot recommends friendship first.'}`, mentions: targets.slice(0,2) }, { quoted: msg });
            break;
          }
          case '!love': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            const score = randomPercent(); await sock.sendMessage(jid, { text: `❤️ *LOVE METER*\n${funTargetLine(targets[0])}: *${score}%*\n${score >= 80 ? '💞 Dangerous levels of affection!' : score >= 50 ? '🥰 Looking promising.' : '😂 Keep trying!'}`, mentions: targets }, { quoted: msg }); break;
          }
          case '!roast': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            const lines = ['You have premium confidence running on a free trial. 😂','Your Wi-Fi has more connection than your plans. 📶','Even your autocorrect is tired of fixing you. 😭','You bring main-character energy to a background role. 🎬'];
            await sock.sendMessage(jid, { text: `🔥 *ROAST FOR ${funTargetLine(targets[0]).toUpperCase()}*\n${randomItem(lines)}`, mentions: targets }, { quoted: msg }); break;
          }
          case '!compliment': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            const lines = ['You make good energy look effortless. ✨','You are genuinely hard to ignore in the best way. 💎','Your vibe is doing serious work today. 🔥','You have the kind of presence people remember. 🌟'];
            await sock.sendMessage(jid, { text: `💎 *COMPLIMENT*\n${funTargetLine(targets[0])}: ${randomItem(lines)}`, mentions: targets }, { quoted: msg }); break;
          }
          case '!insult': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            const lines = ['Your brain is buffering... please wait. 😂','You are proof that confidence needs no loading screen. 🤣','If confusion were a talent, you would be world class. 😭'];
            await sock.sendMessage(jid, { text: `😈 *PLAYFUL INSULT*\n${funTargetLine(targets[0])}: ${randomItem(lines)}`, mentions: targets }, { quoted: msg }); break;
          }
          case '!truth': {
            const truths = ['What is the most embarrassing message you have ever sent?','Who was your last crush?','What is one thing you pretend to understand?','What is a secret talent you rarely show?'];
            await sock.sendMessage(jid, { text: `🎯 *TRUTH*\n${randomItem(truths)}` }, { quoted: msg }); break;
          }
          case '!dare': {
            const dares = ['Send the group your funniest selfie. 😂','Change your status to “Nancy Nova AI challenged me.”','Reply to the last message with only “NASA approved.”','Send a voice note saying your best dramatic movie line.'];
            await sock.sendMessage(jid, { text: `🔥 *DARE*\n${randomItem(dares)}` }, { quoted: msg }); break;
          }
          case '!8ball': {
            if (!argument) throw new Error('Usage: !8ball Will I become famous?');
            const answers = ['Absolutely.', 'Definitely yes.', 'Probably.', 'Ask me again later.', 'The signs are mixed.', 'Probably not.', 'Nope.', 'The bot refuses to reveal the prophecy. 😂'];
            await sock.sendMessage(jid, { text: `🎱 *MAGIC 8-BALL*\n❓ ${argument}\n🔮 ${randomItem(answers)}` }, { quoted: msg }); break;
          }
          case '!rate': {
            const target = resolveTargetJids(msg, args)[0]; const subject = target ? funTargetLine(target) : (argument || 'you');
            await sock.sendMessage(jid, { text: `📊 *RATE MACHINE*\n${subject}: *${randomPercent()}/100*` }, { quoted: msg }); break;
          }
          case '!compatibility': {
            const targets = resolveTargetJids(msg, args, { allowCurrentChat: false }); if (targets.length < 2) throw new Error('Use !compatibility @user @user or two phone numbers.');
            await sock.sendMessage(jid, { text: `💞 *COMPATIBILITY*\n${targetLabel(targets[0])} + ${targetLabel(targets[1])} = *${randomPercent()}%*`, mentions: targets.slice(0,2) }, { quoted: msg }); break;
          }
          case '!gayrate': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `🌈 *RAINBOW VIBE METER*\n${funTargetLine(targets[0])}: *${randomPercent()}%*\n😂 Just a random joke score — not a statement about anyone's real identity.`, mentions: targets }, { quoted: msg }); break;
          }
          case '!smartness': {
            const targets = resolveTargetJids(msg, args); const subject = targets[0] ? funTargetLine(targets[0]) : (argument || 'you');
            await sock.sendMessage(jid, { text: `🧠 *SMARTNESS SCORE*\n${subject}: *${randomPercent()}%*` }, { quoted: msg }); break;
          }
          case '!luck': {
            const targets = resolveTargetJids(msg, args); const subject = targets[0] ? funTargetLine(targets[0]) : (argument || 'you');
            await sock.sendMessage(jid, { text: `🍀 *LUCK METER*\n${subject}: *${randomPercent()}%*` }, { quoted: msg }); break;
          }
          case '!sus': {
            const targets = resolveTargetJids(msg, args); const subject = targets[0] ? funTargetLine(targets[0]) : (argument || 'you');
            await sock.sendMessage(jid, { text: `🕵️ *SUS METER*\n${subject}: *${randomPercent()}%*\n👀 The bot is watching...` }, { quoted: msg }); break;
          }
          case '!simp': {
            const targets = resolveTargetJids(msg, args); const subject = targets[0] ? funTargetLine(targets[0]) : (argument || 'you');
            await sock.sendMessage(jid, { text: `🥹 *SIMP METER*\n${subject}: *${randomPercent()}%*` }, { quoted: msg }); break;
          }
          case '!clown': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `🤡 *CLOWN CHECK*\n${funTargetLine(targets[0])}: certified for today. 😂`, mentions: targets }, { quoted: msg }); break;
          }
          case '!wanted': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `🚨 *WANTED*\nTarget: ${funTargetLine(targets[0])}\nReward: ${Math.floor(Math.random()*9000)+1000} Team NASA credits\nCharge: Being too legendary. 😂`, mentions: targets }, { quoted: msg }); break;
          }
          case '!fakeban': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `🚫 *FAKE BAN NOTICE*\n${funTargetLine(targets[0])} has been banned from Nancy Nova AI for *3 seconds*.\n😂 Appeal accepted automatically.`, mentions: targets }, { quoted: msg }); break;
          }
          case '!jail': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `🚔 *Team NASA JAIL*\n${funTargetLine(targets[0])} has been sentenced to 10 minutes of thinking about their life choices. 😂`, mentions: targets }, { quoted: msg }); break;
          }
          case '!marry': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `💍 *MARRIAGE ALERT*\n${funTargetLine(targets[0])}, the bot has officially approved this totally fictional marriage. 😂`, mentions: targets }, { quoted: msg }); break;
          }
          case '!divorce': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error('Mention, reply to, or provide a number for the target.');
            await sock.sendMessage(jid, { text: `💔 *DIVORCE ALERT*\n${funTargetLine(targets[0])}: the fictional paperwork has been processed. 😂`, mentions: targets }, { quoted: msg }); break;
          }
          case '!slap': case '!hug': case '!kiss': {
            const targets = resolveTargetJids(msg, args); if (!targets[0]) throw new Error(`Mention, reply to, or provide a number for the target.`);
            const actions = { '!slap': '👋 gives', '!hug': '🤗 sends a warm hug to', '!kiss': '💋 sends a playful kiss to' };
            await sock.sendMessage(jid, { text: `${actions[command]} ${funTargetLine(targets[0])}. 😂`, mentions: targets }, { quoted: msg }); break;
          }
          case '!addowner': case '!addownwer': {
            if (!messageIsPrimaryOwner(msg, sock, jid)) {
              await sock.sendMessage(jid, { text: '⛔ Only the primary bot owner can add another owner.' }, { quoted: msg }); break;
            }
            const targets = resolveTargetJids(msg, args, { allowCurrentChat: false });
            const targetJid = targets[0] || '';
            const phone = phoneFromJid(targetJid);
            if (!phone) {
              await sock.sendMessage(jid, { text: '👑 Usage: !addowner 2547XXXXXXXX\nOr reply to the user with !addowner' }, { quoted: msg }); break;
            }
            if (phone === OWNER_NUMBER) {
              await sock.sendMessage(jid, { text: 'ℹ️ That number is already the primary owner.' }, { quoted: msg }); break;
            }
            if (!Array.isArray(botSettings.additionalOwners)) botSettings.additionalOwners = [];
            if (botSettings.additionalOwners.includes(phone)) {
              await sock.sendMessage(jid, { text: `👑 ${displayJid(`${phone}@s.whatsapp.net`)} is already an additional owner.` }, { quoted: msg }); break;
            }
            botSettings.additionalOwners.push(phone);
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `👑 *ADDITIONAL OWNER ADDED*

${displayJid(`${phone}@s.whatsapp.net`)} can now use owner-level commands and can command Nancy Nova AI even in private mode.

⚠️ Only the primary owner can add/remove owners.` }, { quoted: msg });
            break;
          }
          case '!removeowner': {
            if (!messageIsPrimaryOwner(msg, sock, jid)) {
              await sock.sendMessage(jid, { text: '⛔ Only the primary bot owner can remove an owner.' }, { quoted: msg }); break;
            }
            const targets = resolveTargetJids(msg, args, { allowCurrentChat: false });
            const phone = phoneFromJid(targets[0] || '');
            if (!phone) { await sock.sendMessage(jid, { text: '👑 Usage: !removeowner 2547XXXXXXXX\nOr reply to the owner with !removeowner' }, { quoted: msg }); break; }
            if (!Array.isArray(botSettings.additionalOwners) || !botSettings.additionalOwners.includes(phone)) { await sock.sendMessage(jid, { text: 'That number is not an additional owner.' }, { quoted: msg }); break; }
            botSettings.additionalOwners = botSettings.additionalOwners.filter(x => x !== phone);
            await saveBotSettings();
            await sock.sendMessage(jid, { text: `🗑️ Removed ${displayJid(`${phone}@s.whatsapp.net`)} from additional owners.` }, { quoted: msg });
            break;
          }
          case '!owners': {
            if (!owner) { await sock.sendMessage(jid, { text: '⛔ Owner-only command.' }, { quoted: msg }); break; }
            const extras = Array.isArray(botSettings.additionalOwners) ? botSettings.additionalOwners : [];
            await sock.sendMessage(jid, { text: `👑 *NANCY NOVA AI OWNERS*\n\nPrimary owner: ${displayJid(`${OWNER_NUMBER}@s.whatsapp.net`)}\nAdditional owners: ${extras.length ? extras.map((x,i)=>`${i+1}. ${displayJid(`${x}@s.whatsapp.net`)}`).join('\n') : 'None'}` }, { quoted: msg });
            break;
          }
          case '!mode': {
            const value = (args[0] || '').toLowerCase();
            if (!['public','private','admin','status'].includes(value)) { await sock.sendMessage(jid, { text: '🎛️ Usage: !mode public | private | admin | status\n🌍 public = everyone\n🔒 private = owner only\n🛡️ admin = group admins only' }, { quoted: msg }); break; }
            if (value === 'status') { await sock.sendMessage(jid, { text: `╭━━〔 🎛️ *BOT ACCESS MODE* 〕━━╮\n┃ ${modeLabel(botSettings.mode)}\n╰━━━━━━━━━━━━━━━━━━━━╯` }, { quoted: msg }); break; }
            botSettings.mode = value; await saveBotSettings();
            await sock.sendMessage(jid, { text: `╭━━〔 🎛️ *MODE UPDATED* 〕━━╮\n┃ ${modeLabel(value)}\n╰━━━━━━━━━━━━━━━━━━━━╯` }, { quoted: msg });
            break;
          }
          case '!br': {
            await revealViewOnce(sock, msg, jid); break;
          }
          case '!hack': case '!scan': case '!trace': case '!track': case '!ipcheck': case '!access': case '!root': case '!bypass': case '!breach': case '!decrypt': case '!encrypt': case '!decode': case '!encode': case '!firewall': case '!virus': case '!database': case '!terminal': case '!matrix': case '!overload': case '!shutdown': case '!classified': case '!analysis': {
            await runCyberSimulation(sock, msg, jid, command, args); break;
          }
          case '!help': case '!menu': case '!commands': await sendMenu(sock, jid, owner, inGroup); break;
          case '!ping':
            await sendButtons(sock, jid, {
              title: `🏓 ${BOT_NAME}`,
              body: `🏓 *PONG!* ${BOT_NAME} is online and ready to sparkle! 💎✨\n⏱️ Uptime: ${formatUptime()}`,
              footer: FOOTER_TEXT,
              buttons: [
                { id: '!menu', text: '📋 Open Menu' },
                { id: '!status', text: '🛰️ Bot Status' },
                { id: '!about', text: 'ℹ️ About' }
              ]
            }, msg);
            await sendProfileSong(sock, jid, msg);
            break;
          case '!status':
            await sendButtons(sock, jid, {
              title: `🛰️ ${BOT_NAME} — Status`,
              body: `🛰️ *BOT STATUS*\nState: Online 🟢\nUptime: ${formatUptime()}\nVersion: ${BOT_VERSION}\nMode: ${String(botSettings.mode).toUpperCase()}\nAI auto-reply: ${botSettings.aiEnabled ? 'ON' : 'OFF'}`,
              footer: FOOTER_TEXT,
              buttons: [
                { id: '!menu', text: '📋 Open Menu' },
                { id: '!ping', text: '🏓 Ping' },
                { id: '!owner', text: '👑 Owner' }
              ]
            }, msg);
            await sendProfileSong(sock, jid, msg);
            break;
          case '!about': case '!bot':
            await sendButtons(sock, jid, {
              title: `💎 ${BOT_NAME} 🌟`,
              body: [`✨ Your smart, premium WhatsApp assistant`, `💫 *Creator:* ${OWNER_NAME}`, `🌟 *Team:* ${TEAM_NAME} (${TEAM_MEMBERS.join(' • ')})`, `🌐 *Website:* ${WEBSITE_URL}`, `⚡ *Version:* ${BOT_VERSION}`, `💖 Smart AI (Groq • Gemini • OpenRouter) • 🎨 Free Image Engine • ⬇️ HD Downloads`, `⏱️ *Uptime:* ${formatUptime()}`].join('\n'),
              footer: FOOTER_TEXT,
              buttons: [
                { id: '!menu', text: '📋 Open Menu' },
                { id: '!owner', text: '👑 Owner' },
                { id: '!status', text: '🛰️ Status' }
              ]
            }, msg);
            await sendProfileSong(sock, jid, msg);
            break;
          case '!owner': case '!ownerinfo': {
            const ownerCaption = [
              '👑 *NANCY NOVA AI — OWNER & TEAM*',
              '',
              `👤 *Owner:* ${OWNER_NAME}`,
              '💼 *Role:* Founder & Lead Developer',
              `🌟 *Team:* ${TEAM_NAME}`,
              ...TEAM_MEMBERS.map(m => `   • ${m}`),
              `✍️ *Bio:* ${OWNER_BIO}`,
              `🌐 *Website:* ${WEBSITE_URL}`,
              `📱 *Contact:* +${OWNER_NUMBER}`,
              '',
              '🌍 Building premium, genuinely useful technology — one project at a time.'
            ].join('\n');
            let ownerImage = null;
            try { ownerImage = await getBotMenuImage(sock); } catch {}
            await sendButtons(sock, jid, {
              title: '👑 Bot Owner & Team',
              body: ownerCaption,
              footer: FOOTER_TEXT,
              image: ownerImage?.length ? ownerImage : null,
              buttons: [
                { id: '!menu', text: '📋 Open Menu' },
                { id: '!about', text: 'ℹ️ About Bot' },
                { id: '!status', text: '🛰️ Status' }
              ]
            });
            // Tappable contact card so anyone can reach the owner directly.
            try {
              const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${OWNER_NAME.replace(/[^\x20-\x7E]/g, '').trim() || 'Dev Brian'}\nORG:${TEAM_NAME}\nTITLE:Founder & Developer of ${BOT_NAME}\nTEL;type=CELL;type=VOICE;waid=${OWNER_NUMBER}:+${OWNER_NUMBER}\nURL:https://${WEBSITE_URL}\nEND:VCARD`;
              await sock.sendMessage(jid, { contacts: { displayName: 'Dev Brian — Nancy Nova AI', contacts: [{ displayName: 'Dev Brian — Nancy Nova AI', vcard }] } }, { quoted: msg });
            } catch {}
            break;
          }
          case '!team': case '!credits': case '!credit': {
            const teamCaption = [
              '✨ *NANCY NOVA AI — PROJECT CREDITS* ✨',
              '◈━━━━━━━━━━━━━━━━━━◈',
              '',
              `🤖 *Project:* ${BOT_NAME}`,
              `⚡ *Version:* v${BOT_VERSION}`,
              `🌟 *Team:* ${TEAM_NAME}`,
              '',
              '👥 *The Team Behind It:*',
              ...TEAM_MEMBERS.map(m => `   💎 ${m}`),
              '',
              `👑 *Owner:* ${OWNER_NAME}`,
              '💼 *Role:* Founder & Lead Developer',
              `📱 *Contact:* +${OWNER_NUMBER}`,
              `🌐 *Website:* ${WEBSITE_URL}`,
              '',
              '💡 Built with passion — premium, genuinely useful technology.',
              '◈━━━━━━━━━━━━━━━━━━◈'
            ].join('\n');
            let teamImage = null;
            try { teamImage = await getBotMenuImage(sock); } catch {}
            await sendButtons(sock, jid, {
              title: '🌟 Project Credits',
              body: teamCaption,
              footer: FOOTER_TEXT,
              image: teamImage?.length ? teamImage : null,
              buttons: [
                { id: '!owner', text: '👑 Owner Info' },
                { id: '!about', text: 'ℹ️ About Bot' },
                { id: '!menu', text: '📋 Open Menu' }
              ]
            });
            await sendProfileSong(sock, jid, msg);
            break;
          }
          case '!restart': case '!reboot': {
            if (!owner) { await sock.sendMessage(jid, { text: '⛔ Owner-only command.' }, { quoted: msg }); break; }
            await sock.sendMessage(jid, { text: `🔄 *RESTARTING ${BOT_NAME}*\n💠 Hang tight — I'll be back online in a few seconds...\n🛡️ ${TEAM_NAME}` }, { quoted: msg }).catch(() => {});
            console.log('[RESTART] Owner-triggered restart requested. Exiting so the process manager can relaunch...');
            setTimeout(() => process.exit(0), 1500);
            break;
          }
          case '!version': await sock.sendMessage(jid, { text: `🧩 *${BOT_NAME}*\n⚡ Version: ${BOT_VERSION}\n🛰️ ${TEAM_NAME}` }); break;
          case '!uptime': await sock.sendMessage(jid, { text: `⏱️ *BOT UPTIME*\n🟢 ${formatUptime()}` }); break;
          case '!time': await sock.sendMessage(jid, { text: `🕐 *CURRENT TIME*\n🌍 ${new Date().toLocaleTimeString()}` }); break;
          case '!date': await sock.sendMessage(jid, { text: `📅 *TODAY*\n✨ ${new Date().toLocaleDateString()}` }); break;
          case '!joke': case '!jokes': await sock.sendMessage(jid, { text: `😂 ${await fetchFunContent('joke')}` }); break;
          case '!quote': case '!quotes': case '!motivate': await sock.sendMessage(jid, { text: `💡 ${await fetchFunContent('quote')}` }); break;
          case '!fact': case '!facts': await sock.sendMessage(jid, { text: `🧠 ${await fetchFunContent('fact')}` }); break;
          case '!lyrics': case '!lyric': {
            if (!argument) { await sock.sendMessage(jid, { text: '🎤 *LYRICS*\n\nTell me a song! 💎\nExample: *!lyrics Adele - Hello*\n(or just the song name: *!lyrics Hello*)' }, { quoted: msg }); break; }
            await sock.sendMessage(jid, { text: `🔎 Looking up lyrics for *${argument}*... 🎶` }, { quoted: msg });
            try {
              const { artist, title, lyrics } = await fetchLyrics(argument);
              const header = `🎤 *${title}*\n👤 _${artist}_\n\n`;
              const max = 3500;
              const body = lyrics.length > max ? lyrics.slice(0, max) + '\n\n… _(lyrics trimmed)_' : lyrics;
              await sock.sendMessage(jid, { text: header + body }, { quoted: msg });
            } catch (e) {
              await sock.sendMessage(jid, { text: `😢 ${friendlyError(e)}` }, { quoted: msg });
            }
            break;
          }
          case '!flip': await sock.sendMessage(jid, { text: Math.random() < 0.5 ? '🪙 *HEADS!*' : '🪙 *TAILS!*' }); break;
          case '!roll': {
            const sides = Number(args[0] || 6);
            if (!Number.isInteger(sides) || sides < 2 || sides > 1000) { await sock.sendMessage(jid, { text: 'Usage: !roll [2-1000]' }); break; }
            await sock.sendMessage(jid, { text: `🎲 *ROLL RESULT:* ${Math.floor(Math.random() * sides) + 1}` }); break;
          }
          case '!calc': {
            if (!argument || argument.length > 100 || !/^[0-9+\-*/().%\s]+$/.test(argument)) { await sock.sendMessage(jid, { text: 'Usage: !calc 12*(4+2)' }); break; }
            const result = runInNewContext(`(${argument})`, Object.create(null), { timeout: 100 });
            if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('Invalid calculation result');
            await sock.sendMessage(jid, { text: `🧮 *CALCULATION RESULT*\n✨ ${result}` }); break;
          }
          case '!upper': case '!uppercase': await sock.sendMessage(jid, { text: argument ? argument.toUpperCase() : 'Usage: !upper your text' }); break;
          case '!lower': case '!lowercase': await sock.sendMessage(jid, { text: argument ? argument.toLowerCase() : 'Usage: !lower your text' }); break;
          case '!reverse': await sock.sendMessage(jid, { text: argument ? Array.from(argument).reverse().join('') : 'Usage: !reverse your text' }); break;
          case '!count': { const words = argument.match(/\S+/g) || []; await sock.sendMessage(jid, { text: `🔢 *TEXT ANALYSIS*\n📝 Words: ${words.length}\n🔤 Characters: ${argument.length}` }); break; }
          case '!password': {
            const length = Number(args[0] || 16);
            if (!Number.isInteger(length) || length < 8 || length > 32) { await sock.sendMessage(jid, { text: 'Usage: !password [8-32]' }); break; }
            const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
            const bytes = randomBytes(length); const password = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
            await sock.sendMessage(jid, { text: `Generated password:\n${password}\n\nKeep it private and store it securely.` }); break;
          }
          case '!stats': await sock.sendMessage(jid, { text: ['╭━━〔 📊 *NANCY NOVA AI — RUNTIME STATS* 〕━━╮', `┃ 💬 Messages: ${stats.messages}`, `┃ ⚙️ Commands: ${stats.commands}`, `┃ 🎵 Media searches: ${stats.mediaSearches}`, `┃ 🛡️ Recovered deletes: ${stats.recoveredDeletes}`, `┃ ⏱️ Uptime: ${formatUptime()}`, `┃ 🔧 Maintenance: ${maintenanceMode ? 'ON' : 'OFF'}`, '╰━━━━━━━━━━━━━━━━━━╯', '', 'ℹ️ Counters reset when the bot restarts.'].join('\n') }); break;
          case '!maintenance':
            if (args[0]?.toLowerCase() === 'on') { maintenanceMode = true; await sock.sendMessage(jid, { text: 'Maintenance mode enabled.' }); }
            else if (args[0]?.toLowerCase() === 'off') { maintenanceMode = false; await sock.sendMessage(jid, { text: 'Maintenance mode disabled.' }); }
            else await sock.sendMessage(jid, { text: 'Usage: !maintenance on OR !maintenance off' }); break;
          case '!setbio':
            if (!argument || argument.length > 139) { await sock.sendMessage(jid, { text: 'Usage: !setbio Your new bot About text (max 139 characters)' }); break; }
            await sock.updateProfileStatus(argument); await sock.sendMessage(jid, { text: 'Bot About text updated.' }); break;
          case '!setpic': {
            if (!owner) throw new Error('Only the bot owner can change the bot profile picture.');
            const profileJid = sock.user?.id || `${OWNER_NUMBER}@s.whatsapp.net`;
            // Preferred path: use the image attached to or replied to by the command.
            const mediaTarget = await findMediaTarget(sock, msg);
            const mediaContent = mediaTarget ? unwrapMessage(mediaTarget.message) : {};
            if (mediaContent.imageMessage) {
              await setProfilePictureFromMedia(sock, msg, profileJid);
              await sock.sendMessage(jid, { text: '✨ Nancy Nova AI profile picture updated from your replied image.' }, { quoted: msg });
              break;
            }
            // Backwards-compatible fallback for users who keep a local profile image.
            const candidates = [
              path.join(process.cwd(), 'bot_profile.jpg'),
              path.join(process.cwd(), 'bot_profile.jpeg'),
              path.join(process.cwd(), 'bot_profile.png')
            ];
            let file = '';
            for (const candidate of candidates) {
              try { await access(candidate); file = candidate; break; } catch {}
            }
            if (!file) throw new Error('Reply to an image with !setpic, or place bot_profile.jpg, bot_profile.jpeg, or bot_profile.png in the bot folder.');
            const buffer = await readFile(file);
            if (!buffer?.length) throw new Error('The local profile image is empty or could not be read.');
            await sock.updateProfilePicture(profileJid, { buffer });
            await sock.sendMessage(jid, { text: '✨ Nancy Nova AI profile picture updated from the local image.' }, { quoted: msg });
            break;
          }
          default: await sock.sendMessage(jid, { text: `Unknown command. Send ${getCommandPrefix(sock)}help to see all commands 💎` });
        }
      } catch (error) {
        console.error(`Error in ${command}:`, error.stack || error.message);
        await sock.sendMessage(jid, { text: `\uD83D\uDC9C Sorry, ${command} couldn't finish — ${friendlyError(error)}` }).catch(() => {});
      }
    }
}

async function restorePairedSessions() {
  try {
    await mkdir(PAIR_SESSIONS_DIR, { recursive: true });
    const entries = await readdir(PAIR_SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{7,15}$/.test(entry.name)) continue;
      const dir = path.join(PAIR_SESSIONS_DIR, entry.name);
      if (!existsSync(path.join(dir, 'creds.json'))) continue;
      try {
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        if (!state.creds.registered) continue;
        const { version } = await fetchLatestBaileysVersion();
        const sessionSock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: [BOT_NAME, 'Chrome', `${BOT_VERSION}-session`] });
        const record = { sock: sessionSock, state: 'restoring', createdAt: Date.now(), phone: entry.name };
        pairedSockets.set(entry.name, record);
        sessionSock.ev.on('creds.update', saveCreds);
        sessionSock.ev.on('connection.update', update => {
          if (update.connection === 'open') { record.state = 'connected'; record.user = sessionSock.user?.id || entry.name; }
          else if (update.connection === 'close') record.state = update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut ? 'logged-out' : 'disconnected';
        });
        sessionSock.ev.on('presence.update', update => {
          const id = normalizeJid(update?.id || ''); const first = Object.values(update?.presences || {})[0];
          if (id && first) presenceCache.set(id, { ...first, receivedAt: Date.now() });
        });
        sessionSock.ev.on('messages.upsert', payload => handleMessagesUpsert(sessionSock, payload).catch(error => console.error(`Paired-session message error (${entry.name}):`, error.message)));
      } catch (error) { console.error(`Could not restore paired session ${entry.name}:`, error.message); }
    }
  } catch (error) { console.warn('Paired session restore skipped:', error.message); }
}

loadGroupData().then(() => loadBotSettings()).then(() => loadTaskData()).then(() => restorePairedSessions()).then(() => { startReminderPoller(); return startBot(); }).catch(error => { console.error('Bot startup failed:', error.stack || error.message); });
