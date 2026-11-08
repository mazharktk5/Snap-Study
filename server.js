/**
 * SnapStudy server (Node 18+, no npm install needed).
 *
 * Reads XAI_API_KEY from .env, serves the app, and sends photos to Grok.
 * The key never reaches the browser or the phone.
 *
 * Run:   node server.js
 * Open:  http://localhost:3000  (phones on the same Wi-Fi: use the "Phone" link it prints)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

/* ---------- .env ---------- */
(function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const PORT = Number(process.env.PORT || 3000);
const KEY = (process.env.XAI_API_KEY || process.env.GROK_API_KEY || "").trim();

// Works with an xAI Grok key (xai-...). A Groq key (gsk_...) also works as a fallback.
const IS_GROQ = KEY.startsWith("gsk_");
const BASE = process.env.AI_BASE || (IS_GROQ ? "https://api.groq.com/openai/v1" : "https://api.x.ai/v1");
const CANDIDATES = process.env.XAI_MODEL
  ? [process.env.XAI_MODEL]
  : IS_GROQ
    ? ["qwen/qwen3.8-27b", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"]
    : ["grok-4-fast-non-reasoning", "grok-4-fast", "grok-4", "grok-2-vision-1212"];
let workingModel = null; // remembered after the first success

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- prompt ---------- */
function systemPrompt(lang) {
  return `You are SnapStudy, a friendly study assistant for university and college students.
You receive a photo of study material: a whiteboard, textbook page, handwritten notes, slides or a past paper.
Read it carefully (including messy handwriting, diagrams and equations) and build a study pack.

Reply with ONLY a JSON object, no markdown, using exactly these keys:
{
  "is_study_material": true or false,
  "title": "short topic title, max 8 words",
  "subject": "e.g. Physics, Data Structures, Economics",
  "summary": ["4 to 7 key points, each one clear sentence"],
  "explain": "Explain the topic like a helpful senior talking to a junior the night before the exam. 120-180 words. Simple words, one everyday example, no fluff.",
  "quiz": [ {"q": "question", "options": ["A","B","C","D"], "answer": 0, "why": "one-sentence reason"} ],
  "exam": [ {"q": "likely exam question", "answer": "short model answer, 2-4 sentences"} ]
}
Rules:
- quiz has exactly 5 questions, each with 4 options; "answer" is the index (0-3) of the correct option. Vary which index is correct.
- exam has exactly 3 questions.
- Base everything on what is in the photo; if the photo is partial, fill gaps with standard knowledge of that topic.
- Write "explain" in ${lang}. Write everything else in ${lang === "English" ? "English" : lang + " (keep technical terms in English)"}.
- If the photo is clearly NOT study material, set "is_study_material": false and put a short, friendly, slightly funny comment about what you see in "title", with empty arrays and an empty "explain".`;
}

/* ---------- call Grok ---------- */
async function callModel(model, image, lang, useJsonMode) {
  const body = {
    model,
    temperature: 0.4,
    max_tokens: 2500,
    messages: [
      { role: "system", content: systemPrompt(lang) },
      { role: "user", content: [
        { type: "image_url", image_url: { url: image, detail: "high" } },
        { type: "text", text: "Make my study pack from this photo." }
      ] }
    ]
  };
  if (useJsonMode) body.response_format = { type: "json_object" };

  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(BASE + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
        body: JSON.stringify(body)
      });
    } catch (e) { // dropped connection / weak Wi-Fi
      last = e;
      console.log(`  ! network problem (${e.cause?.code || e.message}), retrying...`);
      await sleep(900 * (attempt + 1));
    }
  }
  throw new Error("Network kept dropping the connection to the AI (" + (last?.cause?.code || last?.message) + "). Check the laptop's internet.");
}

function parseJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON");
  return JSON.parse(clean.slice(s, e + 1));
}

// Ask the provider which models this key can use (model names change often).
async function discoverModels(exclude) {
  try {
    const r = await fetch(BASE + "/models", { headers: { Authorization: "Bearer " + KEY } });
    if (!r.ok) return [];
    const ids = ((await r.json()).data || []).map(m => m.id).filter(id => typeof id === "string");
    const skip = /whisper|tts|guard|embed|moderation|orpheus|playai|image-gen|imagine/i;
    const vision = /vision|vl\b|-vl|scout|maverick|llama-4|qwen.*(vl|3\.[5-9])|gemma-3|pixtral|grok-(2-vision|4)|grok-.*(vision|fast)/i;
    const usable = ids.filter(id => !skip.test(id) && !exclude.includes(id));
    const ranked = [...usable.filter(id => vision.test(id)), ...usable.filter(id => !vision.test(id))].slice(0, 8);
    console.log("  ? trying models from provider list: " + ranked.join(", "));
    return ranked;
  } catch (e) { return []; }
}

async function makeStudyPack(image, lang) {
  const first = workingModel ? [workingModel, ...CANDIDATES.filter(m => m !== workingModel)] : CANDIDATES;
  try { return await tryModels(first, image, lang); }
  catch (e) {
    if (e.status === 401 || e.status === 429) throw e;
    const more = await discoverModels(first);
    if (!more.length) throw e;
    return await tryModels(more, image, lang);
  }
}

async function tryModels(models, image, lang) {
  let lastError = "";
  for (const model of models) {
    for (const jsonMode of [true, false]) {
      let r;
      for (let rl = 0; rl < 3; rl++) { // rate limit -> wait and retry
        r = await callModel(model, image, lang, jsonMode);
        if (r.status !== 429) break;
        const wait = (parseFloat(r.headers.get("retry-after")) || 3 * (rl + 1)) * 1000;
        console.log(`  ! rate limited, waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
      const raw = await r.text();
      if (r.ok) {
        const data = JSON.parse(raw);
        const pack = parseJson(data.choices?.[0]?.message?.content);
        if (workingModel !== model) console.log(`  ✓ using model ${model}`);
        workingModel = model;
        return pack;
      }
      let msg = raw;
      try { const j = JSON.parse(raw); msg = j.error?.message || j.error || j.message || raw; } catch {}
      msg = String(msg).slice(0, 300);
      console.log(`  x ${model}${jsonMode ? " (json mode)" : ""}: ${r.status} ${msg}`);
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error("The AI provider rejected the API key (" + r.status + "). Check XAI_API_KEY in .env and that the account has credits. " + msg), { status: 401 });
      }
      if (r.status === 429) throw Object.assign(new Error("Too many requests right now. Wait a few seconds and try again."), { status: 429 });
      lastError = `${r.status}: ${msg}`;
      // 400 with json mode -> retry without it; model not found / no vision -> try next model
      if (!(jsonMode && r.status === 400)) break;
    }
  }
  throw new Error("No available model could read the image. Last error " + lastError + ". You can set XAI_MODEL in .env to a vision model from your xAI console.");
}

/* ---------- helpers ---------- */
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Photo is too large."), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

/* ---------- server ---------- */
http.createServer(async (req, res) => {
  // Allow the page to be opened from VS Code Live Server or file:// on this computer.
  const origin = req.headers.origin || "";
  if (origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    const url = req.url.split("?")[0];

    if (req.method === "POST" && url === "/api/study") {
      if (!KEY) return send(res, 500, { error: "No API key on the server. Add XAI_API_KEY=xai-... to .env and restart (node server.js)." });
      const { image, lang } = JSON.parse(await readBody(req) || "{}");
      if (!/^data:image\/(png|jpe?g|webp);base64,/.test(image || "")) return send(res, 400, { error: "That file isn't a photo. Use a JPG or PNG image." });
      const language = ["English", "Roman Urdu", "Urdu"].includes(lang) ? lang : "English";
      const t0 = Date.now();
      const pack = await makeStudyPack(image, language);
      console.log(`  -> study pack "${pack.title}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return send(res, 200, { pack, seconds: (Date.now() - t0) / 1000 });
    }

    if (req.method === "GET") {
      let p = decodeURIComponent(url);
      if (p === "/") p = "/index.html";
      if (["/.env", "/server.js", "/package.json", "/.env.example"].includes(p.toLowerCase())) return send(res, 404, { error: "Not found" });
      const file = path.join(__dirname, path.normalize(p));
      if (!file.startsWith(__dirname)) return send(res, 403, { error: "Forbidden" });
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, { error: "Not found" });
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("  ! " + e.message);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);
  const shown = KEY.length > 12 ? KEY.slice(0, 6) + "..." + KEY.slice(-4) : "NOT SET";
  console.log(`\n  SnapStudy is running`);
  console.log(`  Laptop: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Phone (same Wi-Fi): http://${ip}:${PORT}`));
  console.log(`  API key: ${shown}  (${IS_GROQ ? "Groq" : "xAI Grok"})`);
  if (!KEY) console.log("  -> Add XAI_API_KEY=xai-... to .env and restart.");
  console.log("  Press Ctrl+C to stop.\n");
});
