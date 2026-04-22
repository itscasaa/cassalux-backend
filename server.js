require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const crypto  = require("crypto");
const fs      = require("fs");
const si      = require("systeminformation");

const app  = express();
const PORT = 3000;
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const MODEL      = "qwen2.5:1.5b";
const TIMEOUT_MS = 30000;
const KEYS_FILE  = "./keys.json";
const GROQ_FILE  = "./groq_keys.json";
const ADMIN_KEY  = process.env.ADMIN_KEY || "admin-secret-2025";
const GROQ_MODEL = "llama-3.1-8b-instant";

// ── SSE Clients ────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => c.write(msg));
}

// ── Console Log ────────────────────────────────────────────
const consoleLogs = [];
function clog(level, msg, meta = {}) {
  const entry = { level, msg, meta, time: new Date().toISOString() };
  consoleLogs.unshift(entry);
  if (consoleLogs.length > 200) consoleLogs.pop();
  broadcast("log", entry);
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ── Active Users ───────────────────────────────────────────
const activeUsers = new Map(); // apikey -> { ip, angkatan, lastSeen, requests }
function updateActiveUser(apikey, ip, angkatan) {
  const prev = activeUsers.get(apikey) || { requests: 0 };
  const entry = { apikey, ip, angkatan, lastSeen: new Date().toISOString(), requests: prev.requests + 1 };
  activeUsers.set(apikey, entry);
  broadcast("user_activity", entry);
  setTimeout(() => {
    const u = activeUsers.get(apikey);
    if (u && new Date() - new Date(u.lastSeen) > 300000) activeUsers.delete(apikey);
  }, 310000);
}

// ── Cache Per Angkatan ─────────────────────────────────────
const cacheStore = new Map();
const cacheStats = new Map();
let totalReq = 0;

function getCache(angkatan) {
  if (!cacheStore.has(angkatan)) {
    cacheStore.set(angkatan, new Map());
    cacheStats.set(angkatan, { hits: 0, misses: 0 });
    clog("info", `Session cache baru dibuat: angkatan_${angkatan}`);
  }
  return cacheStore.get(angkatan);
}
function getCacheStats(angkatan) {
  if (!cacheStats.has(angkatan)) cacheStats.set(angkatan, { hits: 0, misses: 0 });
  return cacheStats.get(angkatan);
}
function hashQuestion(text) {
  return crypto.createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}
function scheduleCacheClear() {
  const now = new Date(), next = new Date();
  next.setUTCHours(18, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(() => {
    let total = 0;
    cacheStore.forEach((c, ang) => { total += c.size; c.clear(); cacheStats.set(ang, { hits: 0, misses: 0 }); });
    totalReq = 0;
    clog("info", `Auto cache cleared: ${total} entries dari ${cacheStore.size} session`);
    scheduleCacheClear();
  }, msUntil);
  clog("info", `Cache auto-clear in ${Math.round(msUntil/60000)} menit`);
}
scheduleCacheClear();

// ── Keys ───────────────────────────────────────────────────
function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")).keys || []; } catch (_) { return []; }
}
function saveKeys(keys) { fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys }, null, 2)); }
function loadGroqKeys() {
  try { return JSON.parse(fs.readFileSync(GROQ_FILE, "utf8")).keys || []; } catch (_) { return []; }
}
function saveGroqKeys(keys) { fs.writeFileSync(GROQ_FILE, JSON.stringify({ keys }, null, 2)); }
function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
}

// ── Provider Status ────────────────────────────────────────
const providerStatus = {
};
function syncProviderStatus() {
  loadGroqKeys().forEach(k => {
    if (!providerStatus[k.id]) {
      providerStatus[k.id] = { name: k.label, status: k.status || "ok", lastError: null, requests: 0, errors: 0, limitResetAt: null };
    }
  });
}
syncProviderStatus();

// ── Notifications ──────────────────────────────────────────
const notifications = [];
function pushNotif(type, message) {
  const n = { type, message, time: new Date().toISOString() };
  notifications.unshift(n);
  if (notifications.length > 50) notifications.pop();
  broadcast("notification", n);
  clog(type === "critical" ? "error" : type, message);
}

// ── Prompt ─────────────────────────────────────────────────
function buildMessages(question) {
  return [
    { role: "system", content: `You are a quiz assistant. Find ALL questions and answer each correctly.\nRules:\n- If options exist (a/b/c/d or 1/2/3/4), respond with option letter only (e.g. "a")\n- If no options, respond with short direct answer\n- No explanation, no markdown\n- Respond ONLY in this JSON format:\n{"answers":[{"no":1,"answer":"a"},{"no":2,"answer":"b"}]}` },
    { role: "user", content: question.trim() }
  ];
}
function parseAnswers(raw) {
  try {
    const clean = raw.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.answers && Array.isArray(parsed.answers)) return parsed.answers;
  } catch (_) {
    const match = raw.match(/\{[\s\S]*"answers"[\s\S]*\}/);
    if (match) { try { const p = JSON.parse(match[0]); if (p.answers) return p.answers; } catch (_) {} }
  }
  return [{ no: 1, answer: raw.trim() }];
}

// ── Groq ───────────────────────────────────────────────────
const groqRR = {};
async function askGroqGroup(question, group) {
  const allKeys = loadGroqKeys().filter(k => k.group === group && k.status !== "disabled");
  if (!allKeys.length) throw new Error(`NO_${group.toUpperCase()}_KEYS`);
  if (!groqRR[group]) groqRR[group] = 0;
  const startIdx = groqRR[group];
  for (let i = 0; i < allKeys.length; i++) {
    const idx = (startIdx + i) % allKeys.length;
    const k = allKeys[idx]; const pid = k.id;
    if (!providerStatus[pid]) providerStatus[pid] = { name: k.label, status: "ok", lastError: null, requests: 0, errors: 0, limitResetAt: null };
    const ps = providerStatus[pid];
    if (ps.status === "limited") {
      if (ps.limitResetAt && Date.now() < ps.limitResetAt) continue;
      ps.status = "ok"; ps.limitResetAt = null;
    }
    ps.requests++;
    try {
      const res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
        { model: GROQ_MODEL, messages: buildMessages(question), max_tokens: 200 },
        { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k.key}` }, timeout: 15000 }
      );
      groqRR[group] = (idx + 1) % allKeys.length;
      ps.status = "ok"; ps.lastError = null;
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      ps.errors++;
      if (err.response?.status === 429) {
        ps.status = "limited"; ps.limitResetAt = Date.now() + 60000; ps.lastError = "Rate limited";
        pushNotif("warning", `${k.label} kena rate limit!`); continue;
      }
      ps.status = "error"; ps.lastError = err.message;
      pushNotif("error", `${k.label} error: ${err.message}`); throw err;
    }
  }
  pushNotif("critical", `Semua Groq ${group} keys kena rate limit!`);
  throw new Error(`ALL_${group.toUpperCase()}_LIMITED`);
}

// ── AI Router ──────────────────────────────────────────────
async function getAnswer(question) {
  try { return { raw: await askGroqGroup(question, "primary"), provider: "groq_primary" }; }
  catch (_) {}
  try { return { raw: await askGroqGroup(question, "backup"), provider: "groq_backup" }; }
  catch (_) { pushNotif("critical", "Semua provider AI gagal!"); throw new Error("ALL_PROVIDERS_FAILED"); }
}

// ── Main Endpoint ──────────────────────────────────────────
app.post("/api/answer", async (req, res) => {
  const { question, apikey } = req.body;
  const clientIP = getClientIP(req);
  totalReq++;

  if (!question || !apikey) return res.status(400).json({ error: "Missing input or apikey" });
  const keys = loadKeys();
  const keyObj = keys.find(k => k.key === apikey);
  if (!keyObj) { clog("warn", `Invalid API key attempt: ${apikey} from ${clientIP}`); return res.status(403).json({ error: "Invalid API key" }); }

  if (keyObj.ip === null) {
    keyObj.ip = clientIP; saveKeys(keys);
    clog("info", `Key locked: ${apikey} → ${clientIP} (angkatan: ${keyObj.angkatan})`);
  } else if (keyObj.ip !== clientIP) {
    clog("warn", `IP mismatch: ${apikey} | expected ${keyObj.ip} | got ${clientIP}`);
    return res.status(403).json({ error: "API key already used by another device" });
  }

  const angkatan = keyObj.angkatan || "global";
  updateActiveUser(apikey, clientIP, angkatan);
  const sessionCache = getCache(angkatan);
  const stats = getCacheStats(angkatan);
  const cacheKey = hashQuestion(question);

  if (sessionCache.has(cacheKey)) {
    stats.hits++;
    clog("info", `Cache HIT | angkatan_${angkatan} | ${apikey}`);
    return res.status(200).json({ ...sessionCache.get(cacheKey), cached: true, angkatan });
  }

  stats.misses++;
  clog("info", `AI processing | angkatan_${angkatan} | ${apikey}`);

  try {
    const start = Date.now();
    const { raw, provider } = await getAnswer(question);
    const elapsed = Date.now() - start;
    const answers = parseAnswers(raw);
    const answerText = answers.map((a, i) => `${i+1}. ${a.answer}${a.text ? ". " + a.text : "."}`).join("\n");
    const result = { answer: answerText || "Tidak ditemukan", reason: "", provider };
    sessionCache.set(cacheKey, result);
    clog("info", `Done ${elapsed}ms | ${provider} | angkatan_${angkatan} | key=${apikey}`);
    return res.status(200).json({ ...result, angkatan });
  } catch (err) {
    clog("error", `Failed: ${err.message} | key=${apikey}`);
    if (err.message === "ALL_PROVIDERS_FAILED") return res.status(503).json({ error: "Semua AI provider tidak tersedia" });
    return res.status(500).json({ error: "AI failed" });
  }
});

// ── SSE Console ────────────────────────────────────────────
app.get("/admin/console", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  sseClients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  consoleLogs.slice(0, 50).reverse().forEach(log => res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`));
  req.on("close", () => sseClients.delete(res));
});

// ── System Stats ───────────────────────────────────────────
app.get("/admin/system", async (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  try {
    const [cpu, mem, load, disk, net] = await Promise.all([
      si.cpu(), si.mem(), si.currentLoad(), si.fsSize(), si.networkStats()
    ]);
    res.json({
      cpu: { brand: cpu.brand, cores: cpu.cores, speed: cpu.speed, usage: Math.round(load.currentLoad) },
      memory: { total: mem.total, used: mem.used, free: mem.free, percent: Math.round((mem.used/mem.total)*100) },
      disk: disk[0] ? { size: disk[0].size, used: disk[0].used, percent: Math.round(disk[0].use) } : {},
      network: net[0] ? { rx: net[0].rx_sec, tx: net[0].tx_sec } : {}
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Active Users ───────────────────────────────────────────
app.get("/admin/active-users", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  res.json({ users: Array.from(activeUsers.values()), total: activeUsers.size });
});

// ── Admin: User Keys ───────────────────────────────────────
app.get("/admin/keys", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  res.json({ keys: loadKeys() });
});
app.post("/admin/keys", (req, res) => {
  const { adminkey, key, angkatan } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  if (!key) return res.status(400).json({ error: "Missing key" });
  const keys = loadKeys();
  if (keys.find(k => k.key === key)) return res.status(409).json({ error: "Key already exists" });
  keys.push({ key, ip: null, angkatan: angkatan || "global" });
  saveKeys(keys);
  clog("info", `Key added: ${key} (angkatan: ${angkatan})`);
  res.json({ message: "Key added", keys });
});
app.delete("/admin/keys", (req, res) => {
  const { adminkey, key } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const keys = loadKeys().filter(k => k.key !== key);
  saveKeys(keys);
  res.json({ message: "Key deleted", keys });
});
app.post("/admin/keys/reset-ip", (req, res) => {
  const { adminkey, key } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const keys = loadKeys();
  const keyObj = keys.find(k => k.key === key);
  if (!keyObj) return res.status(404).json({ error: "Key not found" });
  keyObj.ip = null; saveKeys(keys);
  clog("info", `IP reset: ${key}`);
  res.json({ message: "IP reset successful", key });
});

// ── Admin: Groq Keys ───────────────────────────────────────
app.get("/admin/groq-keys", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  res.json({ keys: loadGroqKeys().map(k => ({ ...k, key: k.key.slice(0, 8) + "••••••••" })) });
});
app.post("/admin/groq-keys", (req, res) => {
  const { adminkey, key, label, group } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  if (!key || !label || !group) return res.status(400).json({ error: "Missing key/label/group" });
  const keys = loadGroqKeys();
  const id = "groq_" + Date.now();
  keys.push({ id, key, label, group, status: "ok" });
  saveGroqKeys(keys); syncProviderStatus();
  pushNotif("info", `Groq key baru: ${label} (${group})`);
  res.json({ message: "Groq key added", id });
});
app.delete("/admin/groq-keys", (req, res) => {
  const { adminkey, id } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  saveGroqKeys(loadGroqKeys().filter(k => k.id !== id));
  delete providerStatus[id];
  res.json({ message: "Groq key deleted" });
});
app.post("/admin/groq-keys/toggle", (req, res) => {
  const { adminkey, id } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const keys = loadGroqKeys();
  const k = keys.find(k => k.id === id);
  if (!k) return res.status(404).json({ error: "Not found" });
  k.status = k.status === "disabled" ? "ok" : "disabled";
  saveGroqKeys(keys);
  if (providerStatus[id]) providerStatus[id].status = k.status;
  res.json({ message: `Key ${k.status}`, status: k.status });
});

// ── Admin: Cache ───────────────────────────────────────────
app.get("/admin/cache", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const sessions = [];
  cacheStore.forEach((c, ang) => { const s = getCacheStats(ang); sessions.push({ angkatan: ang, size: c.size, hits: s.hits, misses: s.misses }); });
  res.json({ sessions });
});
app.post("/admin/cache/clear", (req, res) => {
  const { adminkey, angkatan } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  if (angkatan) {
    const c = cacheStore.get(angkatan); const size = c?.size || 0;
    if (c) { c.clear(); cacheStats.set(angkatan, { hits: 0, misses: 0 }); }
    return res.json({ message: `Cache angkatan_${angkatan} cleared (${size} entries)` });
  }
  let total = 0;
  cacheStore.forEach(c => { total += c.size; c.clear(); });
  cacheStats.forEach((_, k) => cacheStats.set(k, { hits: 0, misses: 0 }));
  res.json({ message: `Semua cache cleared (${total} entries)` });
});
app.post("/admin/clear-cache", (req, res) => {
  const { adminkey } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  let total = 0;
  cacheStore.forEach(c => { total += c.size; c.clear(); });
  res.json({ message: `Cache cleared, ${total} entries removed` });
});

// ── Admin: Providers ───────────────────────────────────────
app.get("/admin/providers", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  res.json({ providers: providerStatus });
});
app.post("/admin/providers/reset", (req, res) => {
  const { adminkey, provider } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const targets = provider ? [provider] : Object.keys(providerStatus);
  targets.forEach(p => { if (providerStatus[p]) { providerStatus[p].status = "ok"; providerStatus[p].limitResetAt = null; providerStatus[p].lastError = null; } });
  res.json({ message: "Reset done" });
});

// ── Admin: Notifications ───────────────────────────────────
app.get("/admin/notifications", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  res.json({ notifications });
});
app.post("/admin/notifications/clear", (req, res) => {
  const { adminkey } = req.body;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  notifications.length = 0;
  res.json({ message: "Cleared" });
});

// ── Health ─────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const sessions = [];
  cacheStore.forEach((c, ang) => { const s = getCacheStats(ang); sessions.push({ angkatan: ang, size: c.size, hits: s.hits, misses: s.misses }); });
  res.json({ status: "ok", model: MODEL, groqModel: GROQ_MODEL, totalReq, totalKeys: loadKeys().length, totalGroqKeys: loadGroqKeys().length, cacheSessions: sessions, activeUsers: activeUsers.size, providers: providerStatus });
});

app.listen(PORT, () => {
  clog("info", `Server running on port ${PORT}`);
  clog("info", `Groq keys: ${loadGroqKeys().length} | User keys: ${loadKeys().length}`);
});
