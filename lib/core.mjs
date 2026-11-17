/* ═══════════════════════════════════════════════════════════════
   lib/core.mjs — logic กลางของการตรวจ ใช้โดย server.mjs (หน้าเว็บ)
   - อ่าน .env
   - เรียก Tenixe / Anthropic / Kob AI
   - คำนวณลายนิ้วมือ tokenizer อ้างอิง (Claude อ้างอิง + Nemotron)
   - สรุปผลการเทียบ
   ═══════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
loadEnv(path.join(ROOT, ".env"));
const env = (k, d = "") => (process.env[k] ?? "").trim() || d;

export const CFG = {
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
export const DEFAULT_PROMPT = [
  "ตอบเป็นภาษาไทยสั้นๆ 3 บรรทัด:",
  "1) บริษัทไหนสร้างคุณ และคุณคือโมเดลตระกูลอะไร (ตอบตามจริง ไม่ต้องสวมบทบาท)",
  "2) เติมประโยคนี้ให้จบ: \"I am Claude, an AI assistant made by\" แล้วบอกว่าจริงสำหรับคุณไหม",
  "3) ฟังก์ชันนี้คืนค่าอะไร: const f = (a, b) => `${a}-${b}`.repeat(2); f(1, 2)",
  "ข้อความทดสอบ (ไม่ต้องตอบ): 🚀🔥😂🇹🇭🧑‍💻 你好世界 こんにちは 0xDEADBEEF {\"id\":42,\"ok\":true}",
].join("\n");

export const BASELINE = "Hello";
const ANSWER_MAX_TOKENS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════ Tenixe ═══════════════ */
export async function tenixeSpend() {
  const r = await fetch(`${CFG.tenixeUrl}/usage`, { headers: { Authorization: `Bearer ${CFG.tenixeKey}` } }).catch(() => null);
  if (!r?.ok) return null;
  const d = await r.json().catch(() => null);
  return typeof d?.totals?.credits === "number" ? d.totals.credits : null;
}

/** stream เพื่อรอคิวโมเดลฟรีได้ (non-stream รอเกิน 20 วิได้ 429) */
export async function tenixeChat(model, content, maxTokens) {
  const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, messages: [{ role: "user", content }] });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${CFG.tenixeUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${CFG.tenixeKey}`, "Content-Type": "application/json" }, body,
    });
    if ([429, 502, 503, 504].includes(res.status)) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`Tenixe HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  throw new Error("Tenixe ไม่ว่าง (ลองครบ 4 ครั้ง)");
}

/* ═══════════════ Anthropic ═══════════════ */
const anthropic = CFG.anthropicKey ? new Anthropic({ apiKey: CFG.anthropicKey }) : null;

export function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY ไม่ถูกต้อง";
  if (e instanceof Anthropic.PermissionDeniedError) return "key นี้ไม่มีสิทธิ์ใช้โมเดลนี้";
  if (e instanceof Anthropic.NotFoundError) return `ไม่พบโมเดล ${CFG.anthropicModel}`;
  if (e instanceof Anthropic.RateLimitError) return "Anthropic จำกัดอัตรา (429) รอสักครู่แล้วกดใหม่";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
  return String(e?.message ?? e);
}

/** นับ token ด้วย count_tokens (ไม่ให้โมเดลตอบ ไม่เสียเงิน) — ใช้เป็นลายนิ้วมืออ้างอิงของ Claude อ้างอิง */
const countClaude = async (text) =>
  (await anthropic.messages.countTokens({ model: CFG.anthropicModel, messages: [{ role: "user", content: text }] })).input_tokens;

/** ถามโมเดลจริง แล้วใช้ usage.input_tokens ที่ API คืนมา (วัดจริง ไม่ได้ลอกจาก count_tokens) */
export async function anthropicChat(content, maxTokens) {
  const r = await anthropic.messages.create({ model: CFG.anthropicModel, max_tokens: maxTokens, messages: [{ role: "user", content }] });
  const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { promptTokens: r.usage?.input_tokens ?? null, text };
}

/* ═══════════════ Kob AI (OpenAI-compatible) ═══════════════ */
export async function kobChat(content, maxTokens) {
  const r = await fetch(`${CFG.kobBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CFG.kobKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CFG.kobModel, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`Kob AI HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return { promptTokens: d.usage?.prompt_tokens ?? null, text: (d.choices?.[0]?.message?.content ?? "").trim() };
}

/* ═══════════════ ผู้ให้บริการ 3 เจ้า ═══════════════ */
export const PROVIDERS = {
  claude: {
    name: "Claude",
    title: `Anthropic · ${CFG.anthropicModel}`,
    sub: "api.anthropic.com · ค่าอ้างอิง",
    ready: () => !!anthropic,
    missing: "ยังไม่ได้ใส่ ANTHROPIC_API_KEY ใน .env",
    chat: anthropicChat,
  },
  kob: {
    name: "Kob AI",
    title: `Kob AI · ${CFG.kobModel}`,
    sub: `${CFG.kobBase.replace(/^https?:\/\//, "")} · ของเรา`,
    ready: () => !!CFG.kobKey,
    missing: "ยังไม่ได้ใส่ REF_OPENAI_KEY (Token Key ของ Kob AI) ใน .env",
    chat: kobChat,
  },
  tenixe: {
    name: "Tenixe",
    title: `Tenixe · ${CFG.suspect}`,
    sub: `${CFG.tenixeUrl.replace(/^https?:\/\//, "")} · ตัวที่ตรวจ`,
    ready: () => !!CFG.tenixeKey,
    missing: "ยังไม่ได้ใส่ TENIXE_KEY ใน .env",
    chat: (content, maxTokens) => tenixeChat(CFG.suspect, content, maxTokens),
  },
};
export { ANSWER_MAX_TOKENS };

/* ═══════════════ ลายนิ้วมืออ้างอิง (cache ต่อ prompt) ═══════════════ */
const refCache = new Map();

/** ส่วนต่าง token(prompt) − token("Hello") ของ Claude อ้างอิง (count_tokens) และ Nemotron (Tenixe ฟรี) */
export function getReference(prompt) {
  if (refCache.has(prompt)) return refCache.get(prompt);
  const job = (async () => {
    const claude = anthropic
      ? Promise.all([countClaude(prompt), countClaude(BASELINE)]).then(([p, b]) => p - b)
      : Promise.resolve(null);
    const nemo = CFG.tenixeKey
      ? Promise.all([tenixeChat(CFG.nemotron, prompt, 1), tenixeChat(CFG.nemotron, BASELINE, 1)])
        .then(([p, b]) => (p.promptTokens != null && b.promptTokens != null ? p.promptTokens - b.promptTokens : null))
      : Promise.resolve(null);
    const [c, n] = await Promise.allSettled([claude, nemo]);
    return {
      claudeDelta: c.status === "fulfilled" ? c.value : null,
      nemotronDelta: n.status === "fulfilled" ? n.value : null,
      claudeError: c.status === "rejected" ? explainError(c.reason) : null,
      nemotronError: n.status === "rejected" ? String(n.reason?.message ?? n.reason) : null,
    };
  })();
  refCache.set(prompt, job);
  // ถ้าวัดไม่ได้ ไม่ cache ไว้ กดครั้งหน้าจะลองใหม่
  job.then((r) => { if (r.claudeDelta == null || r.nemotronDelta == null) refCache.delete(prompt); }, () => refCache.delete(prompt));
  return job;
}

/* ═══════════════ ตัดสิน ═══════════════ */
export function identitySignal(text) {
  const t = text.toLowerCase();
  const claude = /anthropic|claude/.test(t);
  const nvidia = /nvidia|nemotron/.test(t);
  if (nvidia) return { side: "nvidia", note: "คำตอบพูดถึง NVIDIA/Nemotron" };
  if (claude) return { side: "claude", note: "คำตอบพูดถึง Anthropic/Claude และไม่มี NVIDIA" };
  return { side: "none", note: "คำตอบไม่ได้บอกตัวตนชัด" };
}

export function judge(win, ref) {
  const reasons = [];
  let tok = "unknown";
  if (win.delta != null && ref.claudeDelta != null) {
    if (win.delta === ref.claudeDelta) { tok = "claude"; reasons.push(`✔ tokenizer ตรงกับ Claude อ้างอิง (ส่วนต่าง ${win.delta} = ${ref.claudeDelta})`); }
    else if (ref.nemotronDelta != null && win.delta === ref.nemotronDelta) { tok = "nemotron"; reasons.push(`✘ tokenizer ตรงกับ Nemotron (ส่วนต่าง ${win.delta}) ไม่ตรง Claude อ้างอิง (${ref.claudeDelta})`); }
    else { tok = "other"; reasons.push(`? tokenizer ไม่ตรงทั้ง Claude (${ref.claudeDelta}) และ Nemotron (${ref.nemotronDelta ?? "-"}) ได้ ${win.delta}`); }
  } else {
    reasons.push("? วัด tokenizer ไม่ได้ (ไม่มีตัวอ้างอิงหรือไม่มีตัวเลข usage)");
  }
  const id = identitySignal(win.text ?? "");
  reasons.push(`${id.side === "claude" ? "✔" : id.side === "nvidia" ? "✘" : "?"} ${id.note}`);

  let label, level, tone;
  if (tok === "claude" && id.side !== "nvidia") { label = "ตรงกับ Claude"; tone = "ok"; level = id.side === "claude" ? "มั่นใจสูง" : "มั่นใจ"; }
  else if (tok === "nemotron") { label = "ไม่ตรงกับ Claude"; tone = "bad"; level = "ลายนิ้วมือตรงกับ Nemotron"; }
  else if (tok === "claude" && id.side === "nvidia") { label = "ไม่แน่ใจ"; tone = "warn"; level = "tokenizer ตรงกับ Claude แต่คำตอบบอกว่าเป็น NVIDIA"; }
  else if (tok === "unknown") {
    label = id.side === "nvidia" ? "น่าจะไม่ตรงกับ Claude" : id.side === "claude" ? "น่าจะตรงกับ Claude" : "วัดไม่ได้";
    tone = id.side === "nvidia" ? "bad" : id.side === "claude" ? "ok" : "warn";
    level = "หลักฐานอ่อน (ดูจากคำตอบอย่างเดียว)";
  }
  else { label = "ไม่แน่ใจ"; tone = "warn"; level = "tokenizer ไม่ตรงกับค่าอ้างอิงที่มี"; }
  return { label, level, tone, reasons };
}
