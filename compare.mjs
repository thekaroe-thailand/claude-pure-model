/* ═══════════════════════════════════════════════════════════════
   compare.mjs — ส่ง prompt เดียวไป 3 ที่พร้อมกัน แล้วเทียบ 3 หน้าต่าง
     ① Tenixe  claude-haiku-5-5      (ตัวที่ตรวจ)
     ② Anthropic claude-haiku-5-5    (ค่าอ้างอิง)
     ③ Kob AI  anthropic/claude-haiku-5.5 (ของเรา)

   สรุปผลจาก 2 อย่าง
   - หลักฐานหลัก: ลายนิ้วมือ tokenizer ของ prompt นี้
       ส่วนต่าง = token(prompt) − token("Hello")   ← หักส่วนที่แต่ละระบบเติมเองออก
       เทียบกับ Claude อ้างอิง (count_tokens ของ Anthropic) และ Nemotron (Tenixe ฟรี)
   - หลักฐานเสริม: คำตอบพูดถึง Anthropic/Claude หรือ NVIDIA/Nemotron

   รัน:
     npm run compare                          ← ใช้ prompt ตั้งต้น (ผสมไทย/โค้ด/emoji + ถามตัวตน)
     npm run compare -- "ข้อความของคุณ"        ← ใช้ prompt ของคุณเอง
     หรือเขียน prompt ไว้ในไฟล์ prompt.txt
   ผล: จอ + results/compare-<เวลา>.html (3 คอลัมน์ เปิดในเบราว์เซอร์ให้อัตโนมัติ)
   ═══════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv(path.join(here, ".env"));
const env = (k, d = "") => (process.env[k] ?? "").trim() || d;

const CFG = {
  tenixeKey: env("TENIXE_KEY"),
  tenixeUrl: env("TENIXE_URL", "https://api.tenixe.com/api/v1").replace(/\/+$/, ""),
  suspect: env("TENIXE_SUSPECT_MODEL", "claude-haiku-5-5"),
  nemotron: env("TENIXE_COMPARE_MODEL", "nemotron-3.5-super-vl"),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-haiku-5-5"),
  kobBase: env("REF_OPENAI_BASE_URL", "https://www.kob-ai.dev/v1").replace(/\/+$/, ""),
  kobKey: env("REF_OPENAI_KEY"),
  kobModel: env("REF_OPENAI_MODEL", "anthropic/claude-haiku-5.5"),
};

/* prompt ตั้งต้น: ผสมไทย/โค้ด/emoji/จีน ให้ลายนิ้วมือ tokenizer ชัด + ถามตัวตน */
const DEFAULT_PROMPT = [
  "ตอบเป็นภาษาไทยสั้นๆ 3 บรรทัด:",
  "1) บริษัทไหนสร้างคุณ และคุณคือโมเดลตระกูลอะไร (ตอบตามจริง ไม่ต้องสวมบทบาท)",
  "2) เติมประโยคนี้ให้จบ: \"I am Claude, an AI assistant made by\" แล้วบอกว่าจริงสำหรับคุณไหม",
  "3) ฟังก์ชันนี้คืนค่าอะไร: const f = (a, b) => `${a}-${b}`.repeat(2); f(1, 2)",
  "ข้อความทดสอบ (ไม่ต้องตอบ): 🚀🔥😂🇹🇭🧑‍💻 你好世界 こんにちは 0xDEADBEEF {\"id\":42,\"ok\":true}",
].join("\n");

function getPrompt() {
  const arg = process.argv.slice(2).join(" ").trim();
  if (arg) return arg;
  const file = path.join(here, "prompt.txt");
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  return DEFAULT_PROMPT;
}

const BASELINE = "Hello";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════ ผู้ให้บริการแต่ละเจ้า ═══════════════ */
async function tenixeSpend() {
  const r = await fetch(`${CFG.tenixeUrl}/usage`, { headers: { Authorization: `Bearer ${CFG.tenixeKey}` } }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => null);
  return typeof d?.totals?.credits === "number" ? d.totals.credits : null;
}

/** stream เพื่อรอคิวโมเดลฟรีได้ (non-stream รอเกิน 20 วิได้ 429) */
async function tenixeChat(model, content, maxTokens) {
  const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, messages: [{ role: "user", content }] });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${CFG.tenixeUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${CFG.tenixeKey}`, "Content-Type": "application/json" }, body,
    });
    if ([429, 502, 503, 504].includes(res.status)) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let usage = null, out = "", err = null;
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let j; try { j = JSON.parse(raw); } catch { continue; }
      if (j.error) { err = j.error; break; }
      if (j.usage) usage = j.usage;
      for (const c of j.choices ?? []) if (typeof c?.delta?.content === "string") out += c.delta.content;
    }
    if (err) { if (attempt < 4) { await sleep(5000 * attempt); continue; } throw new Error(err.message ?? String(err.code)); }
    return { promptTokens: usage?.prompt_tokens ?? null, text: out.trim() };
  }
  throw new Error("upstream ไม่ว่าง (ลองครบ 4 ครั้ง)");
}

const anthropic = CFG.anthropicKey ? new Anthropic({ apiKey: CFG.anthropicKey }) : null;

function explainAnthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY ไม่ถูกต้อง";
  if (e instanceof Anthropic.PermissionDeniedError) return "key นี้ไม่มีสิทธิ์ใช้โมเดลนี้";
  if (e instanceof Anthropic.NotFoundError) return `ไม่พบโมเดล ${CFG.anthropicModel}`;
  if (e instanceof Anthropic.RateLimitError) return "โดนจำกัดอัตรา (429) — รอสักครู่แล้วรันใหม่";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
  return String(e?.message ?? e);
}

const countClaude = async (text) =>
  (await anthropic.messages.countTokens({ model: CFG.anthropicModel, messages: [{ role: "user", content: text }] })).input_tokens;

async function kobChat(content, maxTokens) {
  const r = await fetch(`${CFG.kobBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CFG.kobKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CFG.kobModel, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return { promptTokens: d.usage?.prompt_tokens ?? null, text: (d.choices?.[0]?.message?.content ?? "").trim() };
}

/* ═══════════════ ตัดสิน ═══════════════ */
function identitySignal(text) {
  const t = text.toLowerCase();
  const claude = /anthropic|claude/.test(t);
  const nvidia = /nvidia|nemotron/.test(t);
  // "made by Anthropic … ไม่จริง/not true" = เติมประโยคได้แต่ปฏิเสธ — นับเป็นฝั่ง NVIDIA ถ้ามีคำว่า NVIDIA ด้วย
  if (nvidia) return { side: "nvidia", note: "คำตอบพูดถึง NVIDIA/Nemotron" };
  if (claude) return { side: "claude", note: "คำตอบพูดถึง Anthropic/Claude และไม่มี NVIDIA" };
  return { side: "none", note: "คำตอบไม่ได้บอกตัวตนชัด" };
}

function judge(win, ref) {
  const reasons = [];
  let tok = "unknown";
  if (win.delta != null && ref.claudeDelta != null) {
    if (win.delta === ref.claudeDelta) { tok = "claude"; reasons.push(`✔ tokenizer ตรงกับ Claude อ้างอิง (ส่วนต่าง ${win.delta} = ${ref.claudeDelta})`); }
    else if (ref.nemotronDelta != null && win.delta === ref.nemotronDelta) { tok = "nemotron"; reasons.push(`✘ tokenizer ตรงกับ Nemotron (ส่วนต่าง ${win.delta}) ไม่ตรง Claude อ้างอิง (${ref.claudeDelta})`); }
    else { tok = "other"; reasons.push(`? tokenizer ไม่ตรงทั้ง Claude (${ref.claudeDelta}) และ Nemotron (${ref.nemotronDelta}) — ได้ ${win.delta}`); }
  } else {
    reasons.push("? วัด tokenizer ไม่ได้ (ไม่มีตัวอ้างอิงหรือไม่มีตัวเลข usage)");
  }
  const id = identitySignal(win.text ?? "");
  reasons.push(`${id.side === "claude" ? "✔" : id.side === "nvidia" ? "✘" : "?"} ${id.note}`);

  let label, level;
  if (tok === "claude" && id.side !== "nvidia") { label = "ตรงกับ Claude"; level = id.side === "claude" ? "มั่นใจสูง" : "มั่นใจ"; }
  else if (tok === "nemotron") { label = "ไม่ตรงกับ Claude"; level = "ลายนิ้วมือตรงกับ Nemotron"; }
  else if (tok === "claude" && id.side === "nvidia") { label = "ไม่แน่ใจ"; level = "tokenizer ตรงกับ Claude แต่คำตอบบอกว่าเป็น NVIDIA"; }
  else if (tok === "unknown") { label = id.side === "nvidia" ? "น่าจะไม่ตรงกับ Claude" : id.side === "claude" ? "น่าจะตรงกับ Claude" : "วัดไม่ได้"; level = "หลักฐานอ่อน (ดูจากคำตอบอย่างเดียว)"; }
  else { label = "ไม่แน่ใจ"; level = "tokenizer ไม่ตรงกับค่าอ้างอิงที่มี"; }
  return { label, level, reasons };
}

/* ═══════════════ แสดงผล ═══════════════ */
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function printWindow(n, w) {
  const bar = "═".repeat(70);
  console.log(`\n╔${bar}`);
  console.log(`║ ${n}  ${w.title}`);
  console.log(`║    ${w.sub}`);
  console.log(`╠${bar}`);
  if (w.error) { console.log(`║ ❌ ${w.error}`); console.log(`╚${bar}`); return; }
  console.log(`║ ผล: ${w.verdict.label}  (${w.verdict.level})`);
  for (const r of w.verdict.reasons) console.log(`║   ${r}`);
  console.log(`║ token: prompt=${w.promptTokens ?? "-"}  ฐาน=${w.baseTokens ?? "-"}  ส่วนต่าง=${w.delta ?? "-"}   เวลา ${w.ms ?? "-"} ms`);
  console.log(`╟${"─".repeat(70)}`);
  for (const line of (w.text || "(ไม่มีข้อความตอบ)").split("\n")) console.log(`║ ${line}`);
  console.log(`╚${bar}`);
}

function htmlReport(prompt, windows, ref, startedAt) {
  const color = (label) => (label.startsWith("ตรงกับ") || label.startsWith("น่าจะตรงกับ") ? "ok" : label.startsWith("ไม่ตรงกับ") || label.startsWith("น่าจะไม่ตรงกับ") ? "bad" : "warn");
  const cols = windows.map((w, i) => `
    <section class="win">
      <header><div class="n">${i + 1}</div><div><h2>${escapeHtml(w.title)}</h2><p>${escapeHtml(w.sub)}</p></div></header>
      ${w.error ? `<div class="verdict bad">❌ ${escapeHtml(w.error)}</div>` : `
      <div class="verdict ${color(w.verdict.label)}"><strong>${escapeHtml(w.verdict.label)}</strong><span>${escapeHtml(w.verdict.level)}</span></div>
      <ul class="reasons">${w.verdict.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      <dl class="nums"><div><dt>token prompt</dt><dd>${w.promptTokens ?? "-"}</dd></div><div><dt>ฐาน "Hello"</dt><dd>${w.baseTokens ?? "-"}</dd></div><div><dt>ส่วนต่าง</dt><dd>${w.delta ?? "-"}</dd></div><div><dt>เวลา</dt><dd>${w.ms ?? "-"} ms</dd></div></dl>
      <pre class="out">${escapeHtml(w.text || "(ไม่มีข้อความตอบ)")}</pre>`}
    </section>`).join("");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pure Haiku Compare</title>
<style>
:root{--bg:#0f1117;--card:#171a23;--line:#2a2f3d;--text:#e6e8ee;--muted:#9aa1b2;--ok:#2fbf71;--bad:#ef5350;--warn:#e0a526}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--card:#fff;--line:#dfe3ea;--text:#1b1f27;--muted:#5d6577}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,"Noto Sans Thai",sans-serif;padding:24px 16px}
h1{margin:0 0 4px;font-size:22px}.meta{color:var(--muted);margin:0 0 16px}
.prompt{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;white-space:pre-wrap;margin-bottom:12px}
.ref{color:var(--muted);font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}@media (max-width:1000px){.grid{grid-template-columns:1fr}}
.win{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.win header{display:flex;gap:12px;align-items:center}.n{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--line);font-weight:700}
.win h2{margin:0;font-size:16px}.win header p{margin:0;color:var(--muted);font-size:12px;word-break:break-all}
.verdict{border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;border:1px solid}
.verdict strong{font-size:18px}.verdict span{font-size:13px;opacity:.85}
.ok{border-color:var(--ok);color:var(--ok)}.bad{border-color:var(--bad);color:var(--bad)}.warn{border-color:var(--warn);color:var(--warn)}
.reasons{margin:0;padding-left:18px;font-size:13px;color:var(--muted)}
.nums{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:0}.nums div{background:var(--bg);border-radius:8px;padding:6px 8px}
.nums dt{font-size:11px;color:var(--muted)}.nums dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
.out{margin:0;white-space:pre-wrap;word-break:break-word;background:var(--bg);border-radius:10px;padding:12px;font:13px/1.55 ui-monospace,Consolas,monospace;flex:1}
</style></head><body>
<h1>เทียบ 3 หน้าต่าง: ลายนิ้วมือ tokenizer ของ Claude Haiku</h1>
<p class="meta">${escapeHtml(startedAt.toLocaleString("th-TH"))}</p>
<div class="prompt">${escapeHtml(prompt)}</div>
<div class="ref">อ้างอิง tokenizer ของ prompt นี้ (หลังหักฐาน "Hello"): Claude อ้างอิง = <b>${ref.claudeDelta ?? "-"}</b> · Nemotron = <b>${ref.nemotronDelta ?? "-"}</b></div>
<div class="grid">${cols}</div>
</body></html>`;
}

/* ═══════════════ main ═══════════════ */
async function timed(fn) {
  const t0 = Date.now();
  const r = await fn();
  return { ...r, ms: Date.now() - t0 };
}

async function main() {
  const prompt = getPrompt();
  const startedAt = new Date();
  console.log(`\n🔎 เทียบ 3 หน้าต่าง — ${startedAt.toLocaleString("th-TH")}`);
  console.log(`prompt:\n${prompt}\n`);
  if (!CFG.tenixeKey) console.log("⚠️  ไม่มี TENIXE_KEY — หน้าต่าง 1 จะว่าง");
  if (!anthropic) console.log("⚠️  ไม่มี ANTHROPIC_API_KEY — ไม่มีตัวอ้างอิง tokenizer ของ Claude อ้างอิง");
  if (!CFG.kobKey) console.log("⚠️  ไม่มี REF_OPENAI_KEY (Token Key ของ Kob AI) — หน้าต่าง 3 จะว่าง");
  console.log("กำลังส่งไป 3 ที่พร้อมกัน… (Tenixe อาจต้องรอคิวสักครู่)");

  const spend0 = CFG.tenixeKey ? await tenixeSpend() : null;

  const tasks = {
    tenixe: CFG.tenixeKey
      ? (async () => {
        const main = await timed(() => tenixeChat(CFG.suspect, prompt, 600));
        const base = await tenixeChat(CFG.suspect, BASELINE, 1);
        return { ...main, baseTokens: base.promptTokens };
      })()
      : Promise.reject(new Error("ยังไม่ได้ใส่ TENIXE_KEY ใน .env")),
    anthropic: anthropic
      ? (async () => {
        const t0 = Date.now();
        const r = await anthropic.messages.create({ model: CFG.anthropicModel, max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
        const ms = Date.now() - t0;
        const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        const [p, b] = await Promise.all([countClaude(prompt), countClaude(BASELINE)]);
        return { text, ms, promptTokens: p, baseTokens: b };
      })()
      : Promise.reject(new Error("ยังไม่ได้ใส่ ANTHROPIC_API_KEY ใน .env")),
    kob: CFG.kobKey
      ? (async () => {
        const main = await timed(() => kobChat(prompt, 600));
        const base = await kobChat(BASELINE, 1);
        return { ...main, baseTokens: base.promptTokens };
      })()
      : Promise.reject(new Error("ยังไม่ได้ใส่ REF_OPENAI_KEY (Token Key ของ Kob AI) ใน .env")),
    // ตัวเทียบที่สอง: tokenizer ของ Nemotron (Tenixe ฟรี) — ไม่ได้แสดงเป็นหน้าต่าง
    nemotron: CFG.tenixeKey
      ? Promise.all([tenixeChat(CFG.nemotron, prompt, 1), tenixeChat(CFG.nemotron, BASELINE, 1)])
      : Promise.reject(new Error("no tenixe")),
  };
  const keys = Object.keys(tasks);
  const settled = Object.fromEntries((await Promise.allSettled(Object.values(tasks))).map((s, i) => [keys[i], s]));

  const delta = (r) => (r?.promptTokens != null && r?.baseTokens != null ? r.promptTokens - r.baseTokens : null);
  const ref = {
    claudeDelta: settled.anthropic.status === "fulfilled" ? delta(settled.anthropic.value) : null,
    nemotronDelta: settled.nemotron.status === "fulfilled"
      ? (settled.nemotron.value[0].promptTokens ?? NaN) - (settled.nemotron.value[1].promptTokens ?? NaN)
      : null,
  };
  if (Number.isNaN(ref.nemotronDelta)) ref.nemotronDelta = null;

  const defs = [
    { key: "tenixe", title: `Tenixe · ${CFG.suspect}`, sub: `${CFG.tenixeUrl} (ตัวที่ตรวจ)` },
    { key: "anthropic", title: `Anthropic · ${CFG.anthropicModel}`, sub: "api.anthropic.com (ค่าอ้างอิง)" },
    { key: "kob", title: `Kob AI · ${CFG.kobModel}`, sub: `${CFG.kobBase} (ของเรา)` },
  ];
  const windows = defs.map((d) => {
    const s = settled[d.key];
    if (s.status === "rejected") {
      const e = s.reason;
      return { ...d, error: d.key === "anthropic" ? explainAnthropicError(e) : String(e?.message ?? e) };
    }
    const w = { ...d, ...s.value, delta: delta(s.value) };
    w.verdict = judge(w, ref);
    return w;
  });

  windows.forEach((w, i) => printWindow(["①", "②", "③"][i], w));
  console.log(`\nอ้างอิง tokenizer ของ prompt นี้ (หลังหักฐาน): Claude อ้างอิง = ${ref.claudeDelta ?? "-"} · Nemotron = ${ref.nemotronDelta ?? "-"}`);
  if (ref.claudeDelta != null && ref.claudeDelta === ref.nemotronDelta) {
    console.log("⚠️  prompt นี้ Claude กับ Nemotron นับได้เท่ากันพอดี — แยกไม่ออก ลองใช้ prompt ที่ยาวขึ้น/มีภาษาไทยหรือ emoji มากขึ้น");
  }

  if (spend0 != null) {
    const spend1 = await tenixeSpend();
    if (spend1 != null) console.log(`ยอดใช้จ่ายฝั่ง Tenixe รอบนี้: ${(spend1 - spend0).toFixed(6)} credits`);
  }

  const outDir = path.join(here, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const htmlPath = path.join(outDir, `compare-${stamp}.html`);
  fs.writeFileSync(htmlPath, htmlReport(prompt, windows, ref, startedAt));
  console.log(`\n📄 เปิดดู 3 หน้าต่างคู่กัน: ${htmlPath}`);
  if (process.platform === "win32" && process.env.NO_OPEN !== "1") exec(`start "" "${htmlPath}"`);
}

main().catch((e) => {
  console.error(`\n❌ ผิดพลาด: ${e?.message ?? e}`);
  process.exit(1);
});
