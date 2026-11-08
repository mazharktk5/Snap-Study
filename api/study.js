/** Vercel serverless function: POST /api/study */
const { handleStudy } = require("../lib/study");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    res.status(200).json(await handleStudy(body));
  } catch (e) {
    console.error("  ! " + e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
};
