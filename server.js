/**
 * SnapStudy local server (Node 18+, no npm install needed).
 *
 * Reads XAI_API_KEY from .env, serves the app, and sends photos to the AI.
 * The key never reaches the browser or the phone.
 * (On Vercel, api/study.js does this job instead; the AI logic lives in lib/study.js.)
 *
 * Run:   node server.js
 * Open:  http://localhost:3000  (phones on the same Wi-Fi: use the "Phone" link it prints)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

/* ---------- .env (must load before lib/study.js reads process.env) ---------- */
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

const { handleStudy, KEY, IS_GROQ } = require("./lib/study");
const PORT = Number(process.env.PORT || 3000);

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
const HIDDEN = ["/.env", "/server.js", "/package.json", "/.env.example", "/vercel.json"];

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
      const body = JSON.parse(await readBody(req) || "{}");
      return send(res, 200, await handleStudy(body));
    }

    if (req.method === "GET") {
      let p = decodeURIComponent(url);
      if (p === "/") p = "/index.html";
      // Only serve the page itself; never source code, .env or the lib/api folders.
      if (HIDDEN.includes(p.toLowerCase()) || /^\/(lib|api)\//i.test(p) || p.startsWith("/.")) return send(res, 404, { error: "Not found" });
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
