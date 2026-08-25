import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// ── Stockage : PostgreSQL si DATABASE_URL, sinon mémoire (dev) ─
const { Pool } = pg;
let pool = null;
if (process.env.DATABASE_URL) {
  const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(process.env.DATABASE_URL);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
  });
}
let memState = null; // repli en mémoire quand pas de base

async function ensureTable() {
  if (!pool) return;
  await pool.query(
    "CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '[]'::jsonb)"
  );
}
async function loadState() {
  if (pool) {
    const r = await pool.query("SELECT data FROM app_state WHERE id = 'default'");
    return r.rows[0] ? r.rows[0].data : null;
  }
  return memState;
}
async function saveState(data) {
  if (pool) {
    await pool.query(
      "INSERT INTO app_state (id, data) VALUES ('default', $1) ON CONFLICT (id) DO UPDATE SET data = $1",
      [JSON.stringify(data)]
    );
    return;
  }
  memState = data;
}

// ── Code d'accès optionnel ────────────────────────────────────
function auth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if ((req.header("x-app-key") || "") === APP_PASSWORD) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ── Projets (synchro entre appareils) ─────────────────────────
app.get("/api/projects", auth, async (_req, res) => {
  try {
    const projects = await loadState();
    res.json({ projects: projects ?? null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lecture impossible." });
  }
});

app.put("/api/projects", auth, async (req, res) => {
  const { projects } = req.body || {};
  if (!Array.isArray(projects)) return res.status(400).json({ error: "Format invalide." });
  try {
    await saveState(projects);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Écriture impossible." });
  }
});

// ── Relais vers Claude (la clé reste côté serveur) ────────────
app.post("/api/ask", auth, async (req, res) => {
  if (!KEY) {
    return res
      .status(500)
      .json({ error: "Clé API non configurée sur le serveur (variable ANTHROPIC_API_KEY)." });
  }
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Prompt manquant." });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Erreur de l'API." });
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Le serveur n'a pas pu joindre l'IA." });
  }
});

// Indique au front si un code d'accès est requis
app.get("/api/config", (_req, res) => res.json({ needsKey: !!APP_PASSWORD }));

// ── Front (build Vite) ────────────────────────────────────────
const dist = path.join(__dirname, "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const port = process.env.PORT || 3000;
ensureTable()
  .catch((e) => console.error("Init base:", e))
  .finally(() =>
    app.listen(port, () => console.log("Vigie en ligne sur le port " + port))
  );
