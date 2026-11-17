/* ═══════════════════════════════════════════════════════════════
   Pure_Haiku — เทียบลายนิ้วมือ tokenizer ของ "claude-haiku-5-5" (Tenixe) กับค่าอ้างอิง Claude

   หลักการ (ไม่ต้องเชื่อคำตอบของโมเดล):
   ทุกตระกูลโมเดลมี tokenizer ของตัวเอง — ข้อความเดียวกันถูกนับเป็นจำนวน token ต่างกัน
   ส่งข้อความชุดเดียวกัน (อังกฤษ/ไทย/โค้ด/emoji/จีน/JSON …) ไปที่
     1) ตัวที่ตรวจ      : Tenixe "claude-haiku-5-5"
     2) ตัวเทียบ          : Tenixe "nemotron-3.5-super-vl"
     3) Claude อ้างอิง    : Anthropic API (count_tokens) และ/หรือ gateway ที่ส่งไป Anthropic
   แล้วเทียบ "ส่วนต่าง" ของจำนวน token เทียบกับข้อความฐาน — ตัด token ที่ระบบแอบเติม (system/wrapper) ออก
   ตัวที่ตรวจตรงกับใครทุกข้อ = ใช้ tokenizer เดียวกับตัวนั้น

   รัน:  npm run prove     (ใส่ key ใน .env ก่อน)
   ผล:   แสดงบนจอ + บันทึกที่ results/report-<เวลา>.md และ .json (ไม่มี key อยู่ในไฟล์ผล)
   ═══════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

/* ── อ่าน .env (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม) ── */
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
  compare: env("TENIXE_COMPARE_MODEL", "nemotron-3.5-super-vl"),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL", "claude-haiku-5-5"),
  refBase: env("REF_OPENAI_BASE_URL").replace(/\/+$/, ""),
  refKey: env("REF_OPENAI_KEY"),
  refModel: env("REF_OPENAI_MODEL"),
  askRefIdentity: env("ASK_REFERENCE_IDENTITY", "1") === "1",
};

/* ── ข้อความทดสอบ — ช่อง 0 คือข้อความฐาน ที่เหลือจงใจให้ tokenizer แต่ละตระกูลนับต่างกัน ── */
const TEXTS = [
  { name: "ฐาน (Hello)", text: "Hello" },
  { name: "อังกฤษ", text: "The quick brown fox jumps over the lazy dog while the sun sets behind the hills." },
  { name: "ไทย", text: "สวัสดีครับ วันนี้อากาศดีมาก เราไปเที่ยวทะเลที่หัวหินกันไหม แล้วแวะกินข้าวมันไก่ด้วย" },
  { name: "โค้ด", text: "function add(a, b) {\n  return a + b; // sum\n}\nconst x = await fetch(`/api/${id}?q=${encodeURIComponent(q)}`);" },
  { name: "emoji", text: "🚀🔥😂👍🏽🇹🇭🧑‍💻✨🎉🙏❤️‍🔥" },
  { name: "จีน/ญี่ปุ่น", text: "你好世界，今天天气很好。こんにちは、元気ですか？東京タワーへ行きましょう。" },
  { name: "ตัวเลข/วันที่", text: "3.14159265358979 2026-11-17T09:45:00Z 1,234,567.89 0xDEADBEEF 192.168.1.254" },
  { name: "JSON", text: '{"user":{"id":42,"name":"Somchai","roles":["admin","dev"],"active":true,"score":98.6}}' },
  { name: "คำแปลก", text: "antidisestablishmentarianism supercalifragilisticexpialidocious pneumonoultramicroscopicsilicovolcanoconiosis" },
  { name: "ช่องว่าง/ย่อหน้า", text: "a\n\n\n    b\t\t\tc          d\r\n  e" },
  { name: "ข้อความยาว", text: "The mitochondria is the powerhouse of the cell. ".repeat(25) },
];

const IDENTITY_QUESTIONS = [
  "Who created you? Answer in one short sentence.",
  'Output only JSON: {"developer": "...", "model_family": "...", "model_name": "..."}. Be factual, not a persona.',
  "Are you Claude, made by Anthropic? Answer yes or no, then one sentence.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ═══════════════ Tenixe (OpenAI-compatible) ═══════════════ */
const tenixeHeaders = () => ({ Authorization: `Bearer ${CFG.tenixeKey}`, "Content-Type": "application/json" });

async function tenixeSpend() {
  const r = await fetch(`${CFG.tenixeUrl}/usage`, { headers: tenixeHeaders() });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return typeof d?.totals?.credits === "number" ? d.totals.credits : null;
}

/**
 * เรียกแบบ stream เพื่อรอคิวได้ (โมเดลฟรีของ Tenixe รันทีละคำขอ — non-stream รอเกิน 20 วิได้ 429)
 * คืน prompt_tokens และข้อความตอบ
 */
async function tenixeChat(model, content, maxTokens) {
  const body = JSON.stringify({
    model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${CFG.tenixeUrl}/chat/completions`, { method: "POST", headers: tenixeHeaders(), body });
    if ([429, 502, 503, 504].includes(res.status)) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`Tenixe ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    if (err) { if (attempt < 4) { await sleep(5000 * attempt); continue; } throw new Error(`Tenixe ${model}: ${err.message ?? err.code}`); }
    return { promptTokens: usage?.prompt_tokens ?? null, text: out.trim() };
  }
  throw new Error(`Tenixe ${model}: ลองครบ 4 ครั้งแล้วยังไม่สำเร็จ (upstream ไม่ว่าง)`);
}

/* ═══════════════ Claude อ้างอิง ═══════════════ */
const anthropic = CFG.anthropicKey ? new Anthropic({ apiKey: CFG.anthropicKey }) : null;

function explainAnthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY ไม่ถูกต้อง";
  if (e instanceof Anthropic.PermissionDeniedError) return "key นี้ไม่มีสิทธิ์ใช้โมเดลนี้";
  if (e instanceof Anthropic.NotFoundError) return `ไม่พบโมเดล ${CFG.anthropicModel}`;
  if (e instanceof Anthropic.RateLimitError) return "โดนจำกัดอัตรา (429) — รอสักครู่แล้วรันใหม่";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
  return String(e?.message ?? e);
}

/** count_tokens — นับ token ด้วย tokenizer ของ Claude โดยไม่ต้องให้โมเดลตอบ */
async function anthropicCount(text) {
  const r = await anthropic.messages.countTokens({
    model: CFG.anthropicModel,
    messages: [{ role: "user", content: text }],
  });
  return r.input_tokens;
}

async function anthropicAsk(question) {
  const r = await anthropic.messages.create({
    model: CFG.anthropicModel,
    max_tokens: 400,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: question }],
  });
  return r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function refChat(content, maxTokens) {
  const r = await fetch(`${CFG.refBase}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CFG.refKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CFG.refModel, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`ตัวอ้างอิง ${CFG.refModel} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return { promptTokens: d.usage?.prompt_tokens ?? null, text: (d.choices?.[0]?.message?.content ?? "").trim() };
}

/* ═══════════════ วิเคราะห์ ═══════════════ */
const deltas = (counts) => counts.map((c) => (c == null || counts[0] == null ? null : c - counts[0]));

function compareDeltas(a, b) {
  let match = 0, total = 0;
  for (let i = 1; i < a.length; i++) {
    if (a[i] == null || b[i] == null) continue;
    total++;
    if (a[i] === b[i]) match++;
  }
  return { match, total };
}

/* ═══════════════ main ═══════════════ */
async function main() {
  if (!CFG.tenixeKey) {
    log("❌ ยังไม่ได้ใส่ TENIXE_KEY ในไฟล์ .env");
    process.exit(1);
  }
  const refs = [];
  if (anthropic) refs.push({ id: "anthropic", label: `Claude อ้างอิง (Anthropic API · ${CFG.anthropicModel})` });
  if (CFG.refBase && CFG.refKey && CFG.refModel) refs.push({ id: "ref", label: `Claude อ้างอิง (ผ่าน gateway · ${CFG.refModel})` });
  if (refs.length === 0) {
    log("⚠️  ไม่ได้ใส่ตัวอ้างอิง Claude อ้างอิง (ANTHROPIC_API_KEY หรือ REF_OPENAI_*) — จะเทียบได้แค่กับ Nemotron");
  }

  const startedAt = new Date();
  log(`\n🔎 Pure_Haiku — เริ่มตรวจ ${startedAt.toLocaleString("th-TH")}`);
  log(`   ตัวที่ตรวจ : Tenixe ${CFG.suspect}`);
  log(`   ตัวเทียบ     : Tenixe ${CFG.compare}`);
  for (const r of refs) log(`   อ้างอิง      : ${r.label}`);

  /* ── กันเสียเงิน: ยิงครั้งแรกแล้วเช็คยอดใช้จ่ายของ Tenixe ── */
  const spend0 = await tenixeSpend();
  if (spend0 == null) log("⚠️  อ่านยอดใช้จ่ายของ Tenixe ไม่ได้ (/usage) — จะไม่มีด่านกันเสียเงินอัตโนมัติ");

  const counts = { suspect: [], compare: [] };
  for (const r of refs) counts[r.id] = [];

  log(`\n① นับ token ข้อความ ${TEXTS.length} ชุด`);
  for (const [i, t] of TEXTS.entries()) {
    counts.suspect.push((await tenixeChat(CFG.suspect, t.text, 1)).promptTokens);
    counts.compare.push((await tenixeChat(CFG.compare, t.text, 1)).promptTokens);
    for (const r of refs) {
      try {
        counts[r.id].push(r.id === "anthropic" ? await anthropicCount(t.text) : (await refChat(t.text, 1)).promptTokens);
      } catch (e) {
        counts[r.id].push(null);
        if (i === 0) log(`   ⚠️  ${r.label}: ${r.id === "anthropic" ? explainAnthropicError(e) : e.message}`);
      }
    }
    if (i === 0 && spend0 != null) {
      const s = await tenixeSpend();
      if (s != null && s > spend0) {
        log(`\n🛑 หยุด: Tenixe หักเงินจริง (${spend0} → ${s}) — โมเดล ${CFG.suspect} หรือ ${CFG.compare} ไม่ใช่ตัวฟรี`);
        process.exit(2);
      }
    }
    log(`   ${String(i).padStart(2)}. ${t.name.padEnd(16)} ตัวที่ตรวจ=${String(counts.suspect[i]).padStart(4)}  ${CFG.compare}=${String(counts.compare[i]).padStart(4)}` +
      refs.map((r) => `  ${r.id === "anthropic" ? "Claude(API)" : "Claude(gw)"}=${String(counts[r.id][i]).padStart(4)}`).join(""));
  }

  /* ── เทียบส่วนต่างจากข้อความฐาน ── */
  const d = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, deltas(v)]));
  const vsCompare = compareDeltas(d.suspect, d.compare);
  const vsRefs = refs.map((r) => ({ ...r, ...compareDeltas(d.suspect, d[r.id]), refVsCompare: compareDeltas(d[r.id], d.compare) }));

  log(`\n② ส่วนต่างจากข้อความฐาน (ตัด token ที่ระบบเติมออก)`);
  log(`   ${"ข้อความ".padEnd(16)} ${"ตัวที่ตรวจ".padStart(12)} ${"Nemotron".padStart(9)}` + refs.map((r) => (r.id === "anthropic" ? "  Claude(API)" : "   Claude(gw)")).join(""));
  for (let i = 1; i < TEXTS.length; i++) {
    log(`   ${TEXTS[i].name.padEnd(16)} ${String(d.suspect[i]).padStart(12)} ${String(d.compare[i]).padStart(9)}` + refs.map((r) => String(d[r.id][i]).padStart(13)).join(""));
  }

  /* ── ถามตัวตน (หลักฐานเสริม) ── */
  log(`\n③ ถามตัวตน (หลักฐานเสริม — โมเดลอาจตอบผิดได้)`);
  const identity = [];
  for (const q of IDENTITY_QUESTIONS) {
    const row = { question: q, suspect: (await tenixeChat(CFG.suspect, q, 300)).text };
    if (CFG.askRefIdentity && refs.length) {
      try {
        row.reference = refs[0].id === "anthropic" ? await anthropicAsk(q) : (await refChat(q, 300)).text;
      } catch (e) {
        row.reference = `(ถามไม่สำเร็จ: ${refs[0].id === "anthropic" ? explainAnthropicError(e) : e.message})`;
      }
    }
    identity.push(row);
    log(`   ถาม: ${q}`);
    log(`     Tenixe ${CFG.suspect}: ${row.suspect.replace(/\s+/g, " ").slice(0, 200)}`);
    if (row.reference !== undefined) log(`     Claude อ้างอิง     : ${row.reference.replace(/\s+/g, " ").slice(0, 200)}`);
  }

  const spend1 = await tenixeSpend();

  /* ── ตัดสิน ── */
  const lines = [];
  const pct = (x) => (x.total ? Math.round((x.match / x.total) * 100) : 0);
  lines.push(`ตัวที่ตรวจ vs ${CFG.compare}: ตรงกัน ${vsCompare.match}/${vsCompare.total} ข้อ (${pct(vsCompare)}%)`);
  for (const r of vsRefs) lines.push(`ตัวที่ตรวจ vs ${r.label}: ตรงกัน ${r.match}/${r.total} ข้อ (${pct(r)}%)`);

  let verdict;
  const refOk = vsRefs.filter((r) => r.total >= 5);
  if (refOk.length === 0) {
    verdict = vsCompare.total && vsCompare.match === vsCompare.total
      ? `⚠️ ยังสรุปไม่ได้ 100%: tokenizer ของ "${CFG.suspect}" ตรงกับ ${CFG.compare} ทุกข้อ แต่ยังไม่มีตัวอ้างอิง Claude อ้างอิงให้เทียบ — ใส่ ANTHROPIC_API_KEY หรือ REF_OPENAI_* แล้วรันใหม่`
      : `⚠️ ยังสรุปไม่ได้: ไม่มีตัวอ้างอิง Claude อ้างอิง และไม่ตรงกับ ${CFG.compare} ทุกข้อ`;
  } else if (refOk.every((r) => r.match === r.total)) {
    verdict = `✅ ตรงกับ Claude: tokenizer ของ "${CFG.suspect}" ตรงกับ Claude อ้างอิงทุกข้อ`;
  } else if (vsCompare.total && vsCompare.match === vsCompare.total && refOk.every((r) => r.match < r.total / 2)) {
    verdict = `❌ ไม่ตรงกับ Claude: tokenizer ของ "${CFG.suspect}" ตรงกับ ${CFG.compare} ทุกข้อ (${vsCompare.match}/${vsCompare.total}) แต่ไม่ตรงกับ Claude อ้างอิง`;
  } else {
    verdict = `⚠️ ไม่แน่ใจ — ดูตารางส่วนต่างประกอบ`;
  }
  // ถ้าตัวอ้างอิง "Claude อ้างอิง" ดันตรงกับ Nemotron ทุกข้อ แปลว่าตัวอ้างอิงเองก็ไม่น่าเชื่อ
  for (const r of refOk) {
    if (r.refVsCompare.total && r.refVsCompare.match === r.refVsCompare.total) {
      verdict += `\n⚠️ ระวัง: ตัวอ้างอิง ${r.label} ก็ตรงกับ ${CFG.compare} ทุกข้อ — ตัวอ้างอิงเองอาจไม่ถูกต้อง`;
    }
  }

  log(`\n④ สรุป`);
  for (const l of lines) log(`   ${l}`);
  log(`\n   ${verdict.replace(/\n/g, "\n   ")}`);
  if (spend0 != null && spend1 != null) log(`\n   ยอดใช้จ่ายฝั่ง Tenixe ระหว่างทดสอบ: ${(spend1 - spend0).toFixed(6)} credits`);

  /* ── บันทึกผล (ไม่มี key) ── */
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(here, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    tenixe: { url: CFG.tenixeUrl, suspect: CFG.suspect, compare: CFG.compare, spendDuringTest: spend0 != null && spend1 != null ? spend1 - spend0 : null },
    references: refs.map((r) => r.label),
    texts: TEXTS.map((t) => t.name),
    tokenCounts: counts,
    deltasFromBase: d,
    comparison: { suspectVsCompare: vsCompare, suspectVsReferences: vsRefs.map(({ label, match, total }) => ({ label, match, total })) },
    identity,
    verdict,
  };
  fs.writeFileSync(path.join(outDir, `report-${stamp}.json`), JSON.stringify(report, null, 2));

  const md = [
    `# ผลตรวจ ${CFG.suspect} ของ Tenixe`,
    ``,
    `- เวลา: ${startedAt.toLocaleString("th-TH")}`,
    `- ตัวที่ตรวจ: Tenixe \`${CFG.suspect}\``,
    `- ตัวเทียบ: Tenixe \`${CFG.compare}\``,
    ...refs.map((r) => `- อ้างอิง: ${r.label}`),
    ``,
    `## สรุป`,
    ``,
    ...verdict.split("\n").map((l) => `**${l}**`),
    ``,
    ...lines.map((l) => `- ${l}`),
    ``,
    `## จำนวน token (prompt) ของแต่ละข้อความ`,
    ``,
    `| ข้อความ | ตัวที่ตรวจ | ${CFG.compare} | ${refs.map((r) => r.label).join(" | ")} |`,
    `|---|---|---|${refs.map(() => "---|").join("")}`,
    ...TEXTS.map((t, i) => `| ${t.name} | ${counts.suspect[i]} | ${counts.compare[i]} | ${refs.map((r) => counts[r.id][i]).join(" | ")} |`),
    ``,
    `## ส่วนต่างจากข้อความฐาน (ใช้ตัดสิน)`,
    ``,
    `| ข้อความ | ตัวที่ตรวจ | ${CFG.compare} | ${refs.map((r) => r.label).join(" | ")} |`,
    `|---|---|---|${refs.map(() => "---|").join("")}`,
    ...TEXTS.slice(1).map((t, j) => `| ${t.name} | ${d.suspect[j + 1]} | ${d.compare[j + 1]} | ${refs.map((r) => d[r.id][j + 1]).join(" | ")} |`),
    ``,
    `## ถามตัวตน (หลักฐานเสริม)`,
    ``,
    ...identity.flatMap((r) => [
      `**ถาม:** ${r.question}`,
      ``,
      `- Tenixe \`${CFG.suspect}\`: ${r.suspect.replace(/\s+/g, " ")}`,
      ...(r.reference !== undefined ? [`- Claude อ้างอิง: ${r.reference.replace(/\s+/g, " ")}`] : []),
      ``,
    ]),
    `## วิธีอ่านผล`,
    ``,
    `แต่ละตระกูลโมเดลมี tokenizer ของตัวเอง ข้อความเดียวกันจึงถูกนับเป็นจำนวน token ต่างกัน`,
    `ใช้ "ส่วนต่างจากข้อความฐาน" แทนตัวเลขดิบ เพื่อตัด token ที่ระบบแต่ละเจ้าเติมเอง (system prompt / wrapper) ออก`,
    `ถ้าส่วนต่างของตัวที่ตรวจตรงกับโมเดลไหนทุกข้อ แปลว่าใช้ tokenizer เดียวกับโมเดลนั้น`,
  ].join("\n");
  const mdPath = path.join(outDir, `report-${stamp}.md`);
  fs.writeFileSync(mdPath, md);
  log(`\n📄 บันทึกผลแล้ว: ${mdPath}`);
}

main().catch((e) => {
  console.error(`\n❌ ผิดพลาด: ${e?.message ?? e}`);
  process.exit(1);
});
