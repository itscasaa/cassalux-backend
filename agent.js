require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const { exec } = require("child_process");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GROQ_AGENT_KEY = process.env.GROQ_AGENT_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const SERVER_FILE = "./server.js";
const KEYS_FILE = "./keys.json";
const GROQ_FILE = "./groq_keys.json";

// ── Discord Client ─────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ]
});

// ── Pending Actions ────────────────────────────────────────
const pendingActions = new Map();

// ── Read Server Context ────────────────────────────────────
function readServerContext() {
  try {
    const serverCode = fs.readFileSync(SERVER_FILE, "utf8");
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
    const groqKeys = JSON.parse(fs.readFileSync(GROQ_FILE, "utf8"));
    return {
      serverCode: serverCode.slice(0, 3000),
      totalUserKeys: keys.keys?.length || 0,
      totalGroqKeys: groqKeys.keys?.length || 0,
      groqGroups: {
        primary: groqKeys.keys?.filter(k => k.group === "primary").length || 0,
        backup: groqKeys.keys?.filter(k => k.group === "backup").length || 0
      }
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Get Server Health ──────────────────────────────────────
async function getServerHealth() {
  try {
    const res = await axios.get("http://localhost:3000/health", { timeout: 5000 });
    return { online: true, data: res.data };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ── Get PM2 Status ─────────────────────────────────────────
function getPM2Status() {
  return new Promise((resolve) => {
    exec("pm2 jlist", (err, stdout) => {
      if (err) return resolve({ error: err.message });
      try {
        const list = JSON.parse(stdout);
        const app = list.find(p => p.name === "quiz-backend");
        resolve(app ? {
          status: app.pm2_env.status,
          restarts: app.pm2_env.restart_time,
          uptime: app.pm2_env.pm_uptime,
          memory: app.monit?.memory,
          cpu: app.monit?.cpu
        } : { error: "Process not found" });
      } catch { resolve({ error: "Parse error" }); }
    });
  });
}

// ── Get PM2 Logs ───────────────────────────────────────────
function getPM2Logs() {
  return new Promise((resolve) => {
    exec("pm2 logs quiz-backend --lines 30 --nostream", (err, stdout, stderr) => {
      resolve((stdout + stderr).slice(-3000));
    });
  });
}

// ── Analyze with Groq ──────────────────────────────────────
async function analyzeWithAI(health, pm2, logs, context) {
  const prompt = `Kamu adalah AI agent security & DevOps profesional untuk server Node.js bernama "Quiz Helper AI / Cassalux".

KONTEKS SERVER:
- Total User Keys: ${context.totalUserKeys}
- Total Groq Keys: ${context.totalGroqKeys} (Primary: ${context.groqGroups?.primary}, Backup: ${context.groqGroups?.backup})
- Server Status: ${health.online ? "ONLINE" : "OFFLINE"}
${health.data ? `- Cache Size: ${health.data.cacheSize}, Total Req: ${health.data.totalReq}` : ""}

PM2 STATUS:
${JSON.stringify(pm2, null, 2)}

LOG TERBARU (30 baris terakhir):
${logs}

SERVER CODE (ringkasan):
${context.serverCode?.slice(0, 1500)}

TUGAS:
Analisa kondisi server sekarang. Jika ada masalah, jelaskan:
1. Apa masalahnya (bahasa Indonesia yang jelas)
2. Penyebab kemungkinan
3. Dampak ke server (0-100%)
4. Solusi yang direkomendasikan (spesifik, langkah-langkah)
5. Apakah perlu tindakan segera? (ya/tidak)
6. Kode fix jika perlu edit file (tulis kode lengkap jika ada)

Respond dalam JSON:
{
  "ada_masalah": true/false,
  "judul": "ringkasan masalah",
  "masalah": "penjelasan detail",
  "penyebab": "kemungkinan penyebab",
  "dampak_persen": 0-100,
  "dampak_deskripsi": "penjelasan dampak",
  "solusi": "langkah-langkah solusi",
  "perlu_segera": true/false,
  "tipe_fix": "restart|edit_code|none",
  "kode_fix": "kode lengkap jika tipe_fix=edit_code, null jika tidak",
  "perintah_fix": "perintah shell jika ada, null jika tidak"
}`;

  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.3
    },
    {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_AGENT_KEY}` },
      timeout: 30000
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content || "";
  const clean = raw.replace(/```json|```/gi, "").trim();
  return JSON.parse(clean);
}

// ── Send Discord Report ────────────────────────────────────
async function sendReport(analysis, health, pm2) {
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (!channel) return;

  const color = analysis.dampak_persen > 70 ? 0xff4444 : analysis.dampak_persen > 40 ? 0xffa500 : 0x22c97a;
  const emoji = analysis.dampak_persen > 70 ? "🔴" : analysis.dampak_persen > 40 ? "🟡" : "🟢";

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${analysis.judul}`)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: "Cassalux AI Agent" })
    .addFields(
      { name: "📋 Masalah", value: analysis.masalah || "-", inline: false },
      { name: "🔍 Penyebab", value: analysis.penyebab || "-", inline: false },
      { name: "⚡ Dampak", value: `**${analysis.dampak_persen}%** — ${analysis.dampak_deskripsi}`, inline: false },
      { name: "🛠 Solusi", value: analysis.solusi || "-", inline: false },
      { name: "📊 Server", value: `Status: ${health.online ? "✅ Online" : "❌ Offline"} | PM2: ${pm2.status || "?"} | Restarts: ${pm2.restarts || 0}`, inline: false }
    );

  if (analysis.tipe_fix !== "none" && analysis.ada_masalah) {
    const actionId = Date.now().toString();
    pendingActions.set(actionId, { analysis, health, pm2 });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve_${actionId}`).setLabel("✅ Approve & Fix").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`reject_${actionId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`detail_${actionId}`).setLabel("📄 Lihat Kode Fix").setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ embeds: [embed], components: [row] });
  } else {
    embed.addFields({ name: "✅ Status", value: analysis.ada_masalah ? "Menunggu tindakan manual" : "Server dalam kondisi normal", inline: false });
    await channel.send({ embeds: [embed] });
  }
}

// ── Execute Fix ────────────────────────────────────────────
async function executeFix(analysis, channel, interaction) {
  try {
    await interaction.reply({ content: "⏳ Mengeksekusi fix...", ephemeral: true });

    if (analysis.tipe_fix === "restart") {
      exec("pm2 restart quiz-backend", async (err, stdout) => {
        const embed = new EmbedBuilder()
          .setTitle("🔄 Fix Dieksekusi: Restart")
          .setColor(err ? 0xff4444 : 0x22c97a)
          .addFields({ name: err ? "❌ Error" : "✅ Hasil", value: err ? err.message : stdout || "Berhasil restart" });
        await channel.send({ embeds: [embed] });
      });

    } else if (false && analysis.kode_fix) {
      fs.writeFileSync(SERVER_FILE, analysis.kode_fix);
      exec("pm2 restart quiz-backend", async (err, stdout) => {
        const embed = new EmbedBuilder()
          .setTitle("🛠 Fix Dieksekusi: Edit Kode + Restart")
          .setColor(err ? 0xff4444 : 0x22c97a)
          .addFields({ name: err ? "❌ Error" : "✅ Hasil", value: err ? err.message : "Kode diupdate dan server di-restart" });
        await channel.send({ embeds: [embed] });
      });

    } else if (analysis.perintah_fix) {
      exec(analysis.perintah_fix, async (err, stdout) => {
        const embed = new EmbedBuilder()
          .setTitle("⚙️ Fix Dieksekusi: Perintah Shell")
          .setColor(err ? 0xff4444 : 0x22c97a)
          .addFields({ name: err ? "❌ Error" : "✅ Output", value: (err ? err.message : stdout) || "-" });
        await channel.send({ embeds: [embed] });
      });
    }
  } catch (err) {
    await channel.send(`❌ Gagal eksekusi fix: ${err.message}`);
  }
}

// ── Button Handler ─────────────────────────────────────────
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;
  const [action, actionId] = interaction.customId.split("_");
  const pending = pendingActions.get(actionId);
  if (!pending) return interaction.reply({ content: "Action sudah expired.", ephemeral: true });

  const channel = interaction.channel;

  if (action === "approve") {
    pendingActions.delete(actionId);
    await executeFix(pending.analysis, channel, interaction);

  } else if (action === "reject") {
    pendingActions.delete(actionId);
    await interaction.reply({ content: "❌ Fix ditolak. Agent kembali standby.", ephemeral: true });

  } else if (action === "detail") {
    const code = pending.analysis.kode_fix || pending.analysis.perintah_fix || "Tidak ada kode fix";
    const preview = code.length > 1900 ? code.slice(0, 1900) + "\n..." : code;
    await interaction.reply({ content: `\`\`\`\n${preview}\n\`\`\``, ephemeral: true });
  }
});

// ── Monitor Loop ───────────────────────────────────────────
let isAnalyzing = false;
let lastReportTime = 0;

async function runMonitor() {
  if (isAnalyzing) return;
  const now = Date.now();
  if (now - lastReportTime < 300000) return; // max 1 report per 5 menit

  isAnalyzing = true;
  console.log("[AGENT] Menjalankan analisa...");

  try {
    const [health, pm2, logs] = await Promise.all([
      getServerHealth(),
      getPM2Status(),
      getPM2Logs()
    ]);
    const context = readServerContext();
    const analysis = await analyzeWithAI(health, pm2, logs, context);

    console.log(`[AGENT] Analisa selesai | ada_masalah=${analysis.ada_masalah} | dampak=${analysis.dampak_persen}%`);

    // Kirim ke Discord hanya kalau ada masalah atau dampak > 20%
    if (analysis.ada_masalah || analysis.dampak_persen > 20) {
      await sendReport(analysis, health, pm2);
      lastReportTime = now;
    }
  } catch (err) {
    console.error("[AGENT] Error:", err.message);
  }

  isAnalyzing = false;
}

// ── Bot Ready ──────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`[AGENT] Bot online: ${client.user.tag}`);
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
  if (channel) {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("🤖 Cassalux AI Agent Online")
        .setColor(0x6c63ff)
        .setDescription("Agent monitoring aktif. Saya akan menganalisa server setiap 5 menit dan melaporkan jika ada masalah.")
        .addFields(
          { name: "📡 Server", value: "cassalux.duckdns.org", inline: true },
          { name: "🔄 Interval", value: "5 menit", inline: true },
          { name: "🤖 Model AI", value: "llama-3.3-70b-versatile", inline: true }
        )
        .setTimestamp()
      ]
    });
  }

  // Jalankan pertama kali langsung
  await runMonitor();

  // Loop setiap 5 menit
  setInterval(runMonitor, 300000);
});

client.login(DISCORD_TOKEN);
