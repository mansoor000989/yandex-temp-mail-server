// Yandex Temp Mail Inbox — backend server (Render ke liye)
// Base email: Man50or1@yandex.com (setup me dala jata hai, code me password kabhi nahi likhna)
// Har visitor ko alag +tag address milta hai, jaise man50or1+uvhxb6@yandex.com.
// Sab mail ek hi Yandex inbox me aati hai. Server har mail ke To header se +tag
// nikal kar us tag wale visitor ko dikhata hai. Yandex ki mail kabhi delete nahi karni,
// sirf read karna hai.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors()); // CORS open — artifact / frontend kahin se bhi call kar sake
app.use(express.json({ limit: '1mb' }));

// ---------- Data (memory + data.json + env vars) ----------
// data.json sirf server ke paas rehta hai. Render free par file ephemeral hai,
// restart par data.json wala setup kho sakta hai — is liye durable setup
// Render ke env vars (YANDEX_BASE_EMAIL / YANDEX_APP_PASSWORD) se aata hai.
// Password kabhi kisi response me wapas nahi bhejna.
let data = { setup: null, aliases: [], messages: {}, seen: [] };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        data.setup = raw.setup || null;
        data.aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
        data.messages = raw.messages && typeof raw.messages === 'object' ? raw.messages : {};
        data.seen = Array.isArray(raw.seen) ? raw.seen : [];
      }
    }
  } catch (e) {
    console.log('data.json load nahi hua, khaali shuru kar raha hun:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.log('data.json save nahi hua:', e.message);
  }
}

loadData();

// Env vars (Render dashboard me ek dafa set karo — restart par bhi rehte hain,
// code me kabhi password nahi likhna):
//   YANDEX_BASE_EMAIL, YANDEX_APP_PASSWORD
// Agar env vars set hain to wahi setup use hota hai, data.json wala backup rehta hai.
const ENV_SETUP = (process.env.YANDEX_BASE_EMAIL && process.env.YANDEX_APP_PASSWORD)
  ? { baseEmail: String(process.env.YANDEX_BASE_EMAIL).trim().toLowerCase(), appPassword: String(process.env.YANDEX_APP_PASSWORD).trim() }
  : null;

function effectiveSetup() {
  return ENV_SETUP || data.setup;
}

// Purani / expired aliases aur un ki messages saaf karo (60 minute ke baad)
function pruneExpired() {
  const now = Date.now();
  const before = data.aliases.length;
  data.aliases = data.aliases.filter((a) => new Date(a.expiresAt).getTime() > now);
  if (data.aliases.length !== before) {
    const live = new Set(data.aliases.map((a) => a.tag));
    for (const tag of Object.keys(data.messages)) {
      if (!live.has(tag)) delete data.messages[tag];
    }
    saveData();
  }
}
setInterval(pruneExpired, 5 * 60 * 1000);
pruneExpired();

function isConfigured() {
  const s = effectiveSetup();
  return !!(s && s.baseEmail && s.appPassword);
}

function publicSetup() {
  const s = effectiveSetup();
  return {
    configured: isConfigured(),
    baseEmail: s ? s.baseEmail : null,
    hasAppPassword: !!(s && s.appPassword),
  };
}

function randomTag() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tag = '';
  for (let i = 0; i < 6; i++) tag += chars[Math.floor(Math.random() * chars.length)];
  return tag;
}

function tagFromAddress(address) {
  if (!address) return null;
  const m = String(address).match(/\+([a-z0-9]{6})@/i);
  return m ? m[1].toLowerCase() : null;
}

function extractOtp(text) {
  if (!text) return null;
  // 4-8 digit code, jo lambi number ka hissa na ho
  const m = String(text).match(/(?<![0-9])(\d{4,8})(?![0-9])/);
  return m ? m[1] : null;
}

// ---------- Routes ----------

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'yandex-temp-mail-server', setup: publicSetup() });
});

// GET /api/setup -> {configured, baseEmail, hasAppPassword} (password kabhi nahi)
app.get('/api/setup', (req, res) => {
  res.json(publicSetup());
});

// POST /api/setup {baseEmail, appPassword} -> save karo
app.post('/api/setup', (req, res) => {
  const baseEmail = String(req.body && req.body.baseEmail ? req.body.baseEmail : '').trim().toLowerCase();
  const appPassword = String(req.body && req.body.appPassword ? req.body.appPassword : '').trim();
  if (!baseEmail || !baseEmail.includes('@') || !baseEmail.endsWith('@yandex.com')) {
    return res.status(400).json({ error: 'Sahi Yandex base email dalo, jaise man50or1@yandex.com' });
  }
  if (!appPassword) {
    return res.status(400).json({ error: 'App password dalo — ye Yandex login password nahi, App Password hota hai' });
  }
  data.setup = { baseEmail, appPassword };
  saveData();
  res.json({ configured: true, baseEmail, hasAppPassword: true });
});

// POST /api/alias -> naya random 6-char tag, 60-min expiry
app.post('/api/alias', (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: 'Pehle Setup me apna Yandex base email dalo' });
  }
  pruneExpired();
  let tag = randomTag();
  const used = new Set(data.aliases.map((a) => a.tag));
  while (used.has(tag)) tag = randomTag();
  const base = effectiveSetup().baseEmail;
  const local = base.split('@')[0];
  const address = `${local}+${tag}@yandex.com`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const alias = { address, tag, code: tag, expiresAt, createdAt: new Date().toISOString() };
  data.aliases.push(alias);
  if (!data.messages[tag]) data.messages[tag] = [];
  saveData();
  res.json(alias);
});

// GET /api/alias/:code -> alias dhoondo, na mile to 404
app.get('/api/alias/:code', (req, res) => {
  pruneExpired();
  const code = String(req.params.code || '').trim().toLowerCase();
  const alias = data.aliases.find((a) => a.tag === code);
  if (!alias) {
    return res.status(404).json({ error: 'Is code par koi address nahi mila' });
  }
  res.json(alias);
});

// Spam folder dhoondo — Yandex kabhi kabhi mail ko Spam me daal deta hai.
// listMailboxes se Junk wala ya naam se Spam wala folder dhoondo, na mile to 'Spam' try karo.
async function findSpamMailbox(client) {
  try {
    const boxes = await client.listMailboxes();
    const all = [];
    const walk = (list) => {
      for (const b of list || []) {
        all.push(b);
        if (b.children) walk(b.children);
      }
    };
    walk(boxes);
    const junk = all.find((b) => {
      const name = String(b.name || '').toLowerCase();
      const p = String(b.path || '').toLowerCase();
      const special = (b.specialUse || []).map((s) => String(s).toLowerCase());
      return special.some((s) => s.includes('junk')) || name === 'spam' || p === 'spam' || name.includes('spam');
    });
    if (junk) return junk.path;
  } catch (e) {
    console.log('Mailbox list nahi mili:', e.message);
  }
  return 'Spam';
}

// POST /api/sync {tag} -> Yandex IMAP se INBOX + Spam parho, +tag ke hisab se save karo
app.post('/api/sync', async (req, res) => {
  const tag = String((req.body && req.body.tag) || '').trim().toLowerCase();
  const totalForTag = () => (data.messages[tag] ? data.messages[tag].length : 0);

  if (!isConfigured()) {
    return res.json({ status: 'no_credentials', newCount: 0, total: totalForTag(), error: 'Pehle Setup me apna Yandex base email aur app password dalo' });
  }

  const client = new ImapFlow({
    host: 'imap.yandex.com',
    port: 993,
    secure: true,
    auth: { user: effectiveSetup().baseEmail, pass: effectiveSetup().appPassword },
    logger: false,
  });

  const seenSet = new Set(data.seen);

  // Ek mailbox (INBOX ya Spam) se aakhri 50 mail parho, +tag wali save karo.
  // folderLabel: 'inbox' ya 'spam' — spam wali mail par Spam nishan lagta hai.
  async function fetchMailbox(mailboxPath, folderLabel) {
    const lock = await client.mailboxOpen(mailboxPath);
    const total = lock.exists || 0;
    let count = 0;
    if (total <= 0) return count;
    // Sirf pehle 50 recent mail parho — purani mail nahi chahiye
    const from = Math.max(1, total - 49);
    const range = `${from}:*`;

    for await (const msg of client.fetch(range, { envelope: true, source: true, uid: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        const toAddr = (parsed.to && parsed.to.value && parsed.to.value[0] && parsed.to.value[0].address)
          || (msg.envelope && msg.envelope.to && msg.envelope.to[0] && msg.envelope.to[0].address)
          || '';
        const msgTag = tagFromAddress(toAddr);
        if (!msgTag) continue; // +tag nahi — ye temp mail nahi hai, skip karo

        const messageId = parsed.messageId || `uid-${msg.uid}`;
        const key = `${msgTag}:${messageId}`;
        if (seenSet.has(key)) continue; // pehle se save hai

        const text = parsed.text || '';
        const html = parsed.html || null;
        const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0])
          ? (parsed.from.value[0].name ? `${parsed.from.value[0].name} <${parsed.from.value[0].address}>` : parsed.from.value[0].address)
          : (msg.envelope && msg.envelope.from && msg.envelope.from[0] ? msg.envelope.from[0].address : '');
        const item = {
          id: key,
          tag: msgTag,
          to: toAddr,
          from: fromAddr,
          subject: parsed.subject || '(No subject)',
          date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
          text,
          html,
          otp: extractOtp(text),
          read: false,
          uid: msg.uid,
          folder: folderLabel,
          spam: folderLabel === 'spam',
        };
        if (!data.messages[msgTag]) data.messages[msgTag] = [];
        data.messages[msgTag].push(item);
        // Newest first rakho
        data.messages[msgTag].sort((a, b) => new Date(b.date) - new Date(a.date));
        seenSet.add(key);
        data.seen.push(key);
        if (msgTag === tag) count++;
      } catch (e) {
        console.log('Ek mail parse nahi hui, skip:', e.message);
      }
    }
    return count;
  }

  let newCount = 0;
  try {
    await client.connect();
    newCount += await fetchMailbox('INBOX', 'inbox');
    // Spam folder bhi parho — Yandex kabhi kabhi mail ko spam me daal deta hai.
    // Spam folder na mile ya error aaye to Inbox wala result phir bhi wapas do.
    try {
      const spamPath = await findSpamMailbox(client);
      if (spamPath) newCount += await fetchMailbox(spamPath, 'spam');
    } catch (e) {
      console.log('Spam folder nahi parha ja saka, skip:', e.message);
    }

    await client.logout();
    saveData();
    return res.json({ status: 'ok', newCount, total: totalForTag() });
  } catch (err) {
    try { await client.logout(); } catch (e) { /* already closed */ }
    // Error ho to saaf batao, kabhi mail invent mat karo
    return res.json({ status: 'connect_failed', newCount: 0, total: totalForTag(), error: String((err && err.message) || err) });
  }
});

// GET /api/messages/:tag -> us tag ki mail list, newest first
app.get('/api/messages/:tag', (req, res) => {
  const tag = String(req.params.tag || '').trim().toLowerCase();
  const list = (data.messages[tag] || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ tag, messages: list, total: list.length });
});

// GET /api/message/:tag/:id -> ek mail ka full body, read mark karo
app.get('/api/message/:tag/:id', (req, res) => {
  const tag = String(req.params.tag || '').trim().toLowerCase();
  const id = decodeURIComponent(String(req.params.id || ''));
  const list = data.messages[tag] || [];
  const msg = list.find((m) => m.id === id);
  if (!msg) {
    return res.status(404).json({ error: 'Mail nahi mili' });
  }
  msg.read = true;
  saveData();
  res.json(msg);
});

// 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ye endpoint nahi hai' });
});

app.listen(PORT, () => {
  console.log(`Yandex Temp Mail server chal raha hai, port ${PORT}`);
  console.log(`Setup configured: ${isConfigured()}${ENV_SETUP ? ' (env vars se)' : ''}`);
});
