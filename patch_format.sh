#!/bin/bash
# Patch server.js: ubah prompt & parseAnswers supaya kasih teks pilihan
cd ~/quiz-backend

# Backup
cp server.js server.js.bak.format.$(date +%Y%m%d_%H%M%S)

node << 'NODESCRIPT'
const fs = require("fs");
let src = fs.readFileSync("./server.js", "utf8");

// ── Ganti buildMessages (prompt) ──
const oldPrompt = `function buildMessages(question) {
  return [
    { role: "system", content: \`You are a quiz assistant. Find ALL questions and answer each correctly.\\nRules:\\n- If options exist (a/b/c/d or 1/2/3/4), respond with option letter only (e.g. "a")\\n- If no options, respond with short direct answer\\n- No explanation, no markdown\\n- Respond ONLY in this JSON format:\\n{"answers":[{"no":1,"answer":"a"},{"no":2,"answer":"b"}]}\` },
    { role: "user", content: question.trim() }
  ];
}`;

const newPrompt = `function buildMessages(question) {
  return [
    { role: "system", content: \`You are a quiz assistant. Find ALL questions and answer each correctly.
Rules:
- If options exist (a/b/c/d or 1/2/3/4), include BOTH the letter AND the full text of that option
- If no options exist, provide a short direct answer as the text
- No explanation, no markdown
- Respond ONLY in this JSON format:
{"answers":[{"no":1,"answer":"a","text":"the full text of option a"},{"no":2,"answer":"b","text":"the full text of option b"}]}
- "answer" = the letter (a/b/c/d) or short keyword
- "text" = full text of the chosen option (copy exactly from the question)\` },
    { role: "user", content: question.trim() }
  ];
}`;

// ── Ganti parseAnswers ──
const oldParse = `function parseAnswers(raw) {
  try {
    const clean = raw.replace(/\`\`\`json|\`\`\`/gi, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.answers && Array.isArray(parsed.answers)) return parsed.answers;
  } catch (_) {
    const match = raw.match(/\\{[\\s\\S]*"answers"[\\s\\S]*\\}/);
    if (match) { try { const p = JSON.parse(match[0]); if (p.answers) return p.answers; } catch (_) {} }
  }
  return [{ no: 1, answer: raw.trim() }];
}`;

const newParse = `function parseAnswers(raw) {
  try {
    const clean = raw.replace(/\`\`\`json|\`\`\`/gi, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.answers && Array.isArray(parsed.answers)) return parsed.answers;
  } catch (_) {
    const match = raw.match(/\\{[\\s\\S]*"answers"[\\s\\S]*\\}/);
    if (match) { try { const p = JSON.parse(match[0]); if (p.answers) return p.answers; } catch (_) {} }
  }
  return [{ no: 1, answer: raw.trim(), text: "" }];
}`;

// ── Ganti format answerText di /api/answer ──
const oldFormat = `    const answerText = answers.map(a => \`\${a.no}. \${a.answer}.\`).join("\\n");
    const result = { answer: answerText || "Tidak ditemukan", reason: "", provider };`;

const newFormat = `    // Format: "1. a. (Teks pilihan)"
    const answerText = answers.map(a => {
      const letter = a.answer || "";
      const text   = a.text   || "";
      return \`\${a.no}. \${letter}.\${text ? " (" + text + ")" : ""}\`;
    }).join("\\n");
    const result = { answer: answerText || "Tidak ditemukan", answers, reason: "", provider };`;

let patched = src;

if (patched.includes('respond with option letter only')) {
  patched = patched.replace(oldPrompt, newPrompt);
  console.log("✓ Patch 1: Prompt diupdate — AI sekarang kasih huruf + teks pilihan");
} else {
  console.log("! Patch 1: Prompt sudah diupdate sebelumnya");
}

if (patched.includes("return [{ no: 1, answer: raw.trim() }]")) {
  patched = patched.replace(oldParse, newParse);
  console.log("✓ Patch 2: parseAnswers diupdate");
} else {
  console.log("! Patch 2: parseAnswers sudah ok");
}

if (patched.includes("answers.map(a => `${a.no}. ${a.answer}.`)")) {
  patched = patched.replace(oldFormat, newFormat);
  console.log("✓ Patch 3: Format output diupdate — sekarang include teks pilihan");
} else {
  console.log("! Patch 3: Format sudah diupdate");
}

fs.writeFileSync("./server.js", patched);
console.log("\n✅ Server patch selesai!");
NODESCRIPT

pm2 restart quiz-backend
echo ""
echo "✅ Server di-restart. Format jawaban baru aktif!"
echo "Contoh output baru: 1. a. (True)  /  2. b. (John and Jeff)"
