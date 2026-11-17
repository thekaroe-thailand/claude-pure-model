/* ═══════════════════════════════════════════════════════════════
   server.mjs — หน้าเว็บ localhost กดตรวจทีละเจ้า
     npm run web     → เปิด http://127.0.0.1:3000 ให้อัตโนมัติ
   ฟังเฉพาะ 127.0.0.1 (เครื่องตัวเองเท่านั้น) และไม่ส่ง key ไปที่หน้าเว็บเด็ดขาด
   ═══════════════════════════════════════════════════════════════ */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import {
  ROOT, CFG, DEFAULT_PROMPT, BASELINE, ANSWER_MAX_TOKENS, PROVIDERS,
  getReference, judge, explainError, tenixeSpend, makeCustomProvider, listCustomModels,
} from "./lib/core.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const PAGE = path.join(ROOT, "public", "index.html");
const MAX_PROMPT = 4000;

let tenixeBlocked = false; // โดนหักเงินฝั่ง Tenixe เมื่อไหร่ หยุดยิง Tenixe ทันที

/* ═══════════════ ตรวจ 1 เจ้า — ส่ง event ทีละขั้น (NDJSON) ═══════════════ */
async function runCheck(who, p, prompt, send) {
  if (!p.ready()) throw new Error(p.missing);
  if (who === "tenixe" && tenixeBlocked) throw new Error("หยุดยิง Tenixe แล้ว เพราะรอบก่อนโดนหักเครดิต");

  const step = (id, status, label, detail) => send({ type: "step", id, status, label, detail });
  const usesTenixe = who === "tenixe";
  const spend0 = usesTenixe ? await tenixeSpend() : null;

  // ลายนิ้วมืออ้างอิงเริ่มวัดคู่ขนานไปเลย (cache ต่อ prompt)
  const refJob = getReference(prompt, p.refModel ?? null);

  step("ask", "run", `ส่งคำถามไปที่ ${p.name}`, "รอคำตอบ…");
  const t0 = Date.now();
  const answer = await p.chat(prompt, ANSWER_MAX_TOKENS);
  const ms = Date.now() - t0;
  step("ask", "done", `ส่งคำถามไปที่ ${p.name}`, `ตอบกลับใน ${(ms / 1000).toFixed(1)} วินาที`);
  send({ type: "answer", text: answer.text, ms });

  step("base", "run", `นับ token ของคำว่า "${BASELINE}" (ฐาน)`, "หักส่วนที่ระบบเติมเองออก");
  const base = await p.chat(BASELINE, 1);
  const delta = answer.promptTokens != null && base.promptTokens != null ? answer.promptTokens - base.promptTokens : null;
  step("base", "done", `นับ token ของคำว่า "${BASELINE}" (ฐาน)`, `prompt ${answer.promptTokens ?? "-"} − ฐาน ${base.promptTokens ?? "-"} = ${delta ?? "-"}`);
  send({ type: "tokens", promptTokens: answer.promptTokens, baseTokens: base.promptTokens, delta });

  step("ref", "run", "ดึงลายนิ้วมืออ้างอิง", "Claude อ้างอิง (count_tokens) + Nemotron");
  const ref = await refJob;
  const refFail = [ref.claudeError && `Claude: ${ref.claudeError}`, ref.nemotronError && `Nemotron: ${ref.nemotronError}`, ref.claudeNote].filter(Boolean).join(" · ");
  step("ref", refFail ? "warn" : "done", "ดึงลายนิ้วมืออ้างอิง",
    refFail || `Claude อ้างอิง (${ref.claudeModel}) ${ref.claudeDelta ?? "-"} · Nemotron ${ref.nemotronDelta ?? "-"}`);
  send({ type: "ref", claudeDelta: ref.claudeDelta, claudeModel: ref.claudeModel, isDefaultModel: ref.isDefaultModel, nemotronDelta: ref.nemotronDelta });

  step("judge", "run", "เทียบลายนิ้วมือ แล้วตัดสิน", "");
  const verdict = judge({ delta, text: answer.text }, ref);
  step("judge", "done", "เทียบลายนิ้วมือ แล้วตัดสิน", "");
  send({ type: "verdict", ...verdict });

  if (spend0 != null) {
    const spend1 = await tenixeSpend();
    if (spend1 != null) {
      const spent = spend1 - spend0;
      if (spent > 0) tenixeBlocked = true;
      send({ type: "spend", credits: spent });
    }
  }
}

/* ═══════════════ HTTP ═══════════════ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 64_000) { reject(new Error("body ใหญ่เกิน")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

/** กันเว็บอื่นในเบราว์เซอร์แอบยิงมาที่ server นี้ (CSRF / DNS rebinding) */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function sameOrigin(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(421); return res.end(); }
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(PAGE).pipe(res);
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) =>
        [k, { name: p.name, title: p.title, sub: p.sub, ready: p.ready(), missing: p.ready() ? null : p.missing }]));
      return json(res, 200, { providers, defaultPrompt: DEFAULT_PROMPT, nemotronModel: CFG.nemotron });
    }

    if (req.method === "POST" && url.pathname === "/api/models") {
      if (!sameOrigin(req) || !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 403, { error: "ปฏิเสธคำขอจากที่อื่น" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      try { return json(res, 200, { models: await listCustomModels(body.custom) }); }
      catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }
    }

    const m = url.pathname.match(/^\/api\/check\/(claude|kob|tenixe|custom)$/);
    if (req.method === "POST" && m) {
      if (!sameOrigin(req) || !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return json(res, 403, { error: "ปฏิเสธคำขอจากที่อื่น" });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const prompt = String(body.prompt ?? "").trim() || DEFAULT_PROMPT;
      if (prompt.length > MAX_PROMPT) return json(res, 400, { error: `prompt ยาวเกิน ${MAX_PROMPT} ตัวอักษร` });

      const who = m[1];
      let p;
      try { p = who === "custom" ? makeCustomProvider(body.custom) : PROVIDERS[who]; }
      catch (e) { return json(res, 400, { error: String(e?.message ?? e) }); }

      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const send = (ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
      const started = Date.now();
      console.log(`▶ ตรวจ ${p.title}`);
      try {
        await runCheck(who, p, prompt, send);
        console.log(`✔ ${p.name} เสร็จใน ${Date.now() - started} ms`);
      } catch (e) {
        let msg = who === "claude" ? explainError(e) : String(e?.message ?? e);
        if (p.redact) msg = p.redact(msg);
        console.log(`✘ ${p.name}: ${msg}`);
        send({ type: "error", message: msg });
      }
      send({ type: "end" });
      return res.end();
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
    else res.end();
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`❌ พอร์ต ${PORT} ถูกใช้อยู่ ปิดโปรแกรมที่ใช้อยู่ หรือรันด้วย PORT=3001`);
  else console.error(`❌ ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const link = `http://${HOST}:${PORT}`;
  console.log(`\n🔎 Pure Haiku — หน้าเว็บเทียบลายนิ้วมือ tokenizer`);
  console.log(`   เปิด: ${link}`);
  for (const [k, p] of Object.entries(PROVIDERS)) console.log(`   ${p.ready() ? "✔" : "✘"} ${p.name}${p.ready() ? "" : ` — ${p.missing}`}`);
  console.log(`   กด Ctrl+C เพื่อปิด\n`);
  if (process.platform === "win32" && process.env.NO_OPEN !== "1") exec(`start "" "${link}"`);
});
