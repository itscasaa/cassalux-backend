#!/bin/bash
# ============================================================
#  CASSALUX — Smart Groq Load Balancer Patcher
#  Jalankan di folder ~/quiz-backend/
#  Usage: bash patch_balancer.sh
# ============================================================
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
info() { echo -e "${CYAN}[→]${NC} $1"; }

TARGET="./server.js"
BACKUP="./server.js.bak.$(date +%Y%m%d_%H%M%S)"

if [ ! -f "$TARGET" ]; then
  echo "ERROR: server.js tidak ditemukan. Jalankan di folder quiz-backend!"
  exit 1
fi

info "Backup server.js → $BACKUP"
cp "$TARGET" "$BACKUP"
log "Backup dibuat"

info "Menambahkan Smart Load Balancer ke server.js..."

# Gunakan Node.js untuk patch (lebih aman dari sed untuk kode panjang)
node << 'NODESCRIPT'
const fs = require("fs");
const src = fs.readFileSync("./server.js", "utf8");

// ── 1. Tambah Key Health Tracker setelah providerStatus block ──
const healthTracker = `
// ── Key Health Tracker ─────────────────────────────────────
const keyHealth = new Map();
function getKeyHealth(id) {
  if (!keyHealth.has(id)) {
    keyHealth.set(id, { score: 100, activeRequests: 0, lastUsed: 0, avgResponseMs: 500, totalRequests: 0, successCount: 0, failCount: 0 });
  }
  return keyHealth.get(id);
}
function calcScore(h, ps) {
  if (ps?.status === "disabled") return -1;
  if (ps?.status === "limited") {
    if (ps.limitResetAt && Date.now() < ps.limitResetAt) return -1;
    ps.status = "ok"; ps.limitResetAt = null;
  }
  let score = 100;
  score -= h.activeRequests * 25;
  score -= Math.min(h.avgResponseMs / 50, 30);
  if (h.totalRequests > 0) score -= (h.failCount / h.totalRequests) * 40;
  return Math.max(0, Math.round(score));
}
`;

// ── 2. Replace fungsi askGroqGroup ──
const oldGroq = `// ── Groq ───────────────────────────────────────────────────
const groqRR = {};
async function askGroqGroup(question, group) {
  const allKeys = loadGroqKeys().filter(k => k.group === group && k.status !== "disabled");
  if (!allKeys.length) throw new Error(\`NO_\${group.toUpperCase()}_KEYS\`);
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
        { headers: { "Content-Type": "application/json", "Authorization": \`Bearer \${k.key}\` }, timeout: 15000 }
      );
      groqRR[group] = (idx + 1) % allKeys.length;
      ps.status = "ok"; ps.lastError = null;
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      ps.errors++;
      if (err.response?.status === 429) {
        ps.status = "limited"; ps.limitResetAt = Date.now() + 60000; ps.lastError = "Rate limited";
        pushNotif("warning", \`\${k.label} kena rate limit!\`); continue;
      }
      ps.status = "error"; ps.lastError = err.message;
      pushNotif("error", \`\${k.label} error: \${err.message}\`); throw err;
    }
  }
  pushNotif("critical", \`Semua Groq \${group} keys kena rate limit!\`);
  throw new Error(\`ALL_\${group.toUpperCase()}_LIMITED\`);
}`;

const newGroq = `// ── Groq Smart Load Balancer ──────────────────────────────
async function askGroqKey(k, question) {
  const h  = getKeyHealth(k.id);
  if (!providerStatus[k.id]) providerStatus[k.id] = { name: k.label, status: "ok", lastError: null, requests: 0, errors: 0, limitResetAt: null };
  const ps = providerStatus[k.id];
  h.activeRequests++; h.lastUsed = Date.now(); h.totalRequests++; ps.requests++;
  const start = Date.now();
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: GROQ_MODEL, messages: buildMessages(question), max_tokens: 200 },
      { headers: { "Content-Type": "application/json", "Authorization": \`Bearer \${k.key}\` }, timeout: 12000 }
    );
    const elapsed = Date.now() - start;
    h.avgResponseMs = Math.round((h.avgResponseMs * 0.7) + (elapsed * 0.3));
    h.successCount++; h.activeRequests = Math.max(0, h.activeRequests - 1);
    ps.status = "ok"; ps.lastError = null;
    return res.data?.choices?.[0]?.message?.content || "";
  } catch (err) {
    h.activeRequests = Math.max(0, h.activeRequests - 1); h.failCount++; ps.errors++;
    if (err.response?.status === 429) {
      ps.status = "limited"; ps.limitResetAt = Date.now() + 60000; ps.lastError = "Rate limited";
      pushNotif("warning", \`\${k.label} kena rate limit, skip ke key lain\`);
    } else if (err.code === "ECONNABORTED" || err.message.includes("timeout")) {
      ps.lastError = "Timeout";
      pushNotif("warning", \`\${k.label} timeout, skip\`);
    } else {
      ps.status = "error"; ps.lastError = err.message;
    }
    throw err;
  }
}

async function askGroqGroup(question, group) {
  const allKeys = loadGroqKeys().filter(k => k.group === group && k.status !== "disabled");
  if (!allKeys.length) throw new Error(\`NO_\${group.toUpperCase()}_KEYS\`);
  const sorted = [...allKeys].sort((a, b) => {
    return calcScore(getKeyHealth(b.id), providerStatus[b.id]) - calcScore(getKeyHealth(a.id), providerStatus[a.id]);
  });
  for (const k of sorted) {
    const score = calcScore(getKeyHealth(k.id), providerStatus[k.id]);
    if (score < 0) { clog("info", \`Skip \${k.label} (score: \${score})\`); continue; }
    clog("info", \`Coba \${k.label} (score: \${score})\`);
    try { return await askGroqKey(k, question); }
    catch (err) { clog("warn", \`\${k.label} gagal: \${err.message}, lanjut key berikutnya\`); continue; }
  }
  pushNotif("critical", \`Semua Groq \${group} keys tidak tersedia!\`);
  throw new Error(\`ALL_\${group.toUpperCase()}_LIMITED\`);
}`;

// ── 3. Replace fungsi getAnswer ──
const oldRouter = `// ── AI Router ──────────────────────────────────────────────
async function getAnswer(question) {
  try { return { raw: await askOllama(question), provider: "ollama" }; }
  catch (err) { if (err.message !== "OLLAMA_BUSY") pushNotif("warning", \`Ollama error: \${err.message}\`); }
  try { return { raw: await askGroqGroup(question, "primary"), provider: "groq_primary" }; }
  catch (_) {}
  try { return { raw: await askGroqGroup(question, "backup"), provider: "groq_backup" }; }
  catch (_) { pushNotif("critical", "Semua provider AI gagal!"); throw new Error("ALL_PROVIDERS_FAILED"); }
}`;

const newRouter = `// ── AI Router (Smart) ─────────────────────────────────────
async function getAnswer(question) {
  const primaryKeys = loadGroqKeys().filter(k => k.group === "primary" && k.status !== "disabled");
  const availablePrimary = primaryKeys.filter(k => calcScore(getKeyHealth(k.id), providerStatus[k.id]) >= 25);

  // Ada primary tersedia → langsung Groq (lebih cepat dari Ollama)
  if (availablePrimary.length > 0) {
    try { return { raw: await askGroqGroup(question, "primary"), provider: "groq_primary" }; }
    catch (_) {}
  }

  // Primary habis → fallback backup
  clog("warn", "Primary habis, fallback ke backup");
  try { return { raw: await askGroqGroup(question, "backup"), provider: "groq_backup" }; }
  catch (_) {}

  // Backup juga habis → coba Ollama kalau tidak busy
  if (!ollamaBusy) {
    try { return { raw: await askOllama(question), provider: "ollama" }; }
    catch (err) { if (err.message !== "OLLAMA_BUSY") pushNotif("warning", \`Ollama error: \${err.message}\`); }
  }

  pushNotif("critical", "Semua provider AI gagal!");
  throw new Error("ALL_PROVIDERS_FAILED");
}`;

// ── Apply patches ──
let patched = src;

// Patch 1: tambah health tracker sebelum syncProviderStatus
if (!patched.includes("keyHealth")) {
  patched = patched.replace(
    "// ── Provider Status ──",
    healthTracker + "\n// ── Provider Status ──"
  );
  console.log("✓ Patch 1: Key Health Tracker ditambahkan");
} else {
  console.log("! Patch 1: Key Health Tracker sudah ada, skip");
}

// Patch 2: replace askGroqGroup
if (patched.includes("const groqRR = {};")) {
  patched = patched.replace(oldGroq, newGroq);
  console.log("✓ Patch 2: askGroqGroup diganti dengan Smart Load Balancer");
} else {
  console.log("! Patch 2: Tidak ketemu blok Groq lama, mungkin sudah diupdate");
}

// Patch 3: replace getAnswer
if (patched.includes("try { return { raw: await askOllama(question), provider: \"ollama\" }; }")) {
  patched = patched.replace(oldRouter, newRouter);
  console.log("✓ Patch 3: AI Router diupgrade");
} else {
  console.log("! Patch 3: Tidak ketemu AI Router lama");
}

// Patch 4: tambah endpoint /admin/key-health sebelum /health
const keyHealthEndpoint = `
// ── Admin: Key Health ──────────────────────────────────────
app.get("/admin/key-health", (req, res) => {
  const { adminkey } = req.query;
  if (adminkey !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const health = {};
  loadGroqKeys().forEach(k => {
    const h = getKeyHealth(k.id);
    const ps = providerStatus[k.id];
    health[k.id] = {
      label: k.label, group: k.group,
      score: calcScore(h, ps),
      activeRequests: h.activeRequests,
      avgResponseMs: h.avgResponseMs,
      successRate: h.totalRequests > 0 ? Math.round((h.successCount / h.totalRequests) * 100) : 100,
      status: ps?.status || "ok",
    };
  });
  res.json({ health });
});
`;

if (!patched.includes("/admin/key-health")) {
  patched = patched.replace("// ── Health ──", keyHealthEndpoint + "\n// ── Health ──");
  console.log("✓ Patch 4: Endpoint /admin/key-health ditambahkan");
}

fs.writeFileSync("./server.js", patched);
console.log("\n✅ Semua patch berhasil diterapkan!");
NODESCRIPT

log "Patch selesai"

info "Restart server..."
pm2 restart quiz-backend

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Smart Load Balancer Aktif! ✓       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "Fitur baru:"
echo "  ✓ Key dipilih berdasarkan SCORE (health score 0-100)"
echo "  ✓ Timeout 12 detik per key → langsung skip, tidak nunggu"
echo "  ✓ Rate limit → otomatis skip ke key berikutnya"
echo "  ✓ Tracking: response time, success rate, active requests"
echo "  ✓ Endpoint baru: /admin/key-health?adminkey=xxx"
echo ""
echo "Cek status:"
echo "  pm2 logs quiz-backend --lines 20"
echo ""
