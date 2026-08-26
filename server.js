import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { randomUUID } from "crypto";
import { createGoogle } from "./google.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));

const KEY = process.env.ANTHROPIC_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD || "";

// ── Modèles & tarifs ──────────────────────────────────────────
// Tarifs en dollars par million de tokens. Table unique : les prix
// évoluent, c'est le SEUL endroit à corriger.
const PRICES = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  // Tarif introductif : passe à 3 / 15 le 1er septembre 2026 — à mettre à jour.
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-4-8": { in: 5, out: 25 },
};
// Liste blanche : le client choisit un modèle, mais JAMAIS un nom libre.
const ALLOWED_MODELS = Object.keys(PRICES);
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

// Coût estimé d'un appel, à partir de l'usage renvoyé par l'API.
// null si le modèle n'est pas dans la table (ex. ANTHROPIC_MODEL exotique).
function estimateCost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

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
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY,
    title text NOT NULL,
    category text NOT NULL DEFAULT 'perso',
    status text NOT NULL DEFAULT 'a_faire',
    due_date timestamptz,
    due_all_day boolean NOT NULL DEFAULT true,
    calendar_event_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // user_id : un seul 'owner' aujourd'hui, la clé est là pour plus tard.
  await pool.query(`CREATE TABLE IF NOT EXISTS google_auth (
    user_id text PRIMARY KEY,
    refresh_token text,
    access_token text,
    expiry timestamptz
  )`);
  await pool.query("CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value text)");
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


// ── Tâches, réglages, jetons Google ───────────────────────────
// Même principe que le stockage des projets : PostgreSQL si
// DATABASE_URL, sinon mémoire (repli dev, remis à zéro au reboot).
const OWNER = "owner";
let memTasks = [];
let memAuth = null;
let memSettings = new Map();

const CATEGORIES = ["perso", "admin", "dev"];
const TASK_STATUSES = ["a_faire", "en_cours", "fait"];

async function getSetting(key) {
  if (!pool) return memSettings.get(key) ?? null;
  const r = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : null;
}
async function setSetting(key, value) {
  if (!pool) { value === null ? memSettings.delete(key) : memSettings.set(key, value); return; }
  if (value === null) { await pool.query("DELETE FROM app_settings WHERE key = $1", [key]); return; }
  await pool.query(
    "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    [key, value]
  );
}
async function loadAuth() {
  if (!pool) return memAuth;
  const r = await pool.query("SELECT * FROM google_auth WHERE user_id = $1", [OWNER]);
  return r.rows[0] || null;
}
async function saveAuth(a) {
  if (!pool) { memAuth = a; return; }
  if (a === null) { await pool.query("DELETE FROM google_auth WHERE user_id = $1", [OWNER]); return; }
  await pool.query(
    `INSERT INTO google_auth (user_id, refresh_token, access_token, expiry)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET refresh_token = $2, access_token = $3, expiry = $4`,
    [OWNER, a.refresh_token || null, a.access_token || null, a.expiry || null]
  );
}

async function listTasks() {
  if (!pool) return [...memTasks].sort(sortTasks);
  const r = await pool.query("SELECT * FROM tasks");
  return r.rows.sort(sortTasks);
}
// Échéances d'abord (les plus proches en tête), sans date à la fin.
function sortTasks(a, b) {
  const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
  const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
  if (da !== db) return da - db;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}
async function getTask(id) {
  if (!pool) return memTasks.find((t) => t.id === id) || null;
  const r = await pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
  return r.rows[0] || null;
}
async function insertTask(t) {
  if (!pool) { memTasks.push(t); return t; }
  await pool.query(
    `INSERT INTO tasks (id, title, category, status, due_date, due_all_day, calendar_event_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [t.id, t.title, t.category, t.status, t.due_date, t.due_all_day, t.calendar_event_id, t.created_at, t.updated_at]
  );
  return t;
}
async function writeTask(t) {
  if (!pool) { memTasks = memTasks.map((x) => (x.id === t.id ? t : x)); return t; }
  await pool.query(
    `UPDATE tasks SET title=$2, category=$3, status=$4, due_date=$5, due_all_day=$6,
       calendar_event_id=$7, updated_at=$8 WHERE id=$1`,
    [t.id, t.title, t.category, t.status, t.due_date, t.due_all_day, t.calendar_event_id, t.updated_at]
  );
  return t;
}
async function deleteTask(id) {
  if (!pool) { memTasks = memTasks.filter((t) => t.id !== id); return; }
  await pool.query("DELETE FROM tasks WHERE id = $1", [id]);
}

// Ligne SQL → JSON du front (camelCase).
const taskToJson = (t) => ({
  id: t.id,
  title: t.title,
  category: t.category,
  status: t.status,
  dueDate: t.due_date ? new Date(t.due_date).toISOString() : null,
  dueAllDay: t.due_all_day,
  calendarEventId: t.calendar_event_id || null,
  createdAt: t.created_at ? new Date(t.created_at).toISOString() : null,
  updatedAt: t.updated_at ? new Date(t.updated_at).toISOString() : null,
});

// Une journée entière est rangée à minuit UTC : l'aller-retour
// "2026-09-01" → base → agenda reste sur le même jour partout.
function parseDue(value, allDay) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return allDay ? new Date(d.toISOString().slice(0, 10) + "T00:00:00.000Z") : d;
}

// ── Google Agenda (sens unique : Vigie écrit, ne lit rien d'autre) ─
const gcal = createGoogle({ loadAuth, saveAuth, getSetting, setSetting });

// Pousse l'état d'une tâche vers l'agenda. Ne lève jamais : sans
// compte Google lié — ou si Google répond mal — la tâche reste
// enregistrée, et repartira à la prochaine modification.
async function syncTask(task) {
  try {
    const { eventId, skipped } = await gcal.syncTask(task);
    if (skipped) return null;
    if ((eventId || null) !== (task.calendar_event_id || null)) {
      task.calendar_event_id = eventId || null;
      await writeTask(task);
    }
    return null;
  } catch (e) {
    console.error("Google Agenda:", e.message);
    return "Tâche enregistrée, mais l'agenda Google n'a pas suivi : " + e.message;
  }
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
  const { prompt, model } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Prompt manquant." });
  }
  // Le modèle demandé n'est retenu que s'il figure dans la liste blanche.
  const used = ALLOWED_MODELS.includes(model) ? model : DEFAULT_MODEL;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: used,
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
    const usage = data.usage || null;
    res.json({ text, model: used, usage, costUsd: estimateCost(used, usage) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Le serveur n'a pas pu joindre l'IA." });
  }
});


// ── Tâches (mêmes règles d'accès que /api/projects) ───────────
app.get("/api/tasks", auth, async (_req, res) => {
  try {
    res.json({ tasks: (await listTasks()).map(taskToJson) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lecture des tâches impossible." });
  }
});

app.post("/api/tasks", auth, async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Titre manquant." });
  const now = new Date();
  const allDay = b.dueAllDay === undefined ? true : !!b.dueAllDay;
  const task = {
    id: randomUUID(),
    title: title.slice(0, 300),
    category: CATEGORIES.includes(b.category) ? b.category : "perso",
    status: TASK_STATUSES.includes(b.status) ? b.status : "a_faire",
    due_date: parseDue(b.dueDate, allDay),
    due_all_day: allDay,
    calendar_event_id: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await insertTask(task);
    const syncWarning = await syncTask(task);
    res.status(201).json({ task: taskToJson(task), syncWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Création impossible." });
  }
});

app.patch("/api/tasks/:id", auth, async (req, res) => {
  const b = req.body || {};
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Tâche introuvable." });

    if (typeof b.title === "string") {
      const t = b.title.trim();
      if (!t) return res.status(400).json({ error: "Titre vide." });
      task.title = t.slice(0, 300);
    }
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Catégorie inconnue." });
      task.category = b.category;
    }
    if (b.status !== undefined) {
      if (!TASK_STATUSES.includes(b.status)) return res.status(400).json({ error: "Statut inconnu." });
      task.status = b.status;
    }
    if (b.dueAllDay !== undefined) task.due_all_day = !!b.dueAllDay;
    if (b.dueDate !== undefined) task.due_date = parseDue(b.dueDate, task.due_all_day);
    else if (b.dueAllDay !== undefined && task.due_date) task.due_date = parseDue(task.due_date, task.due_all_day);
    task.updated_at = new Date();

    await writeTask(task);
    const syncWarning = await syncTask(task);
    res.json({ task: taskToJson(task), syncWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Modification impossible." });
  }
});

app.delete("/api/tasks/:id", auth, async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Tâche introuvable." });
    await deleteTask(task.id);
    let syncWarning = null;
    try {
      await gcal.removeEvent(task.calendar_event_id);
    } catch (e) {
      console.error("Google Agenda:", e.message);
      syncWarning = "Tâche supprimée, mais l'événement d'agenda est peut-être resté.";
    }
    res.json({ ok: true, syncWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Suppression impossible." });
  }
});

// ── Google : état, lien de connexion, déconnexion ─────────────
app.get("/api/google/status", auth, async (_req, res) => {
  try {
    res.json(await gcal.status());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "État Google indisponible." });
  }
});

// Le consentement Google est une navigation du navigateur : elle ne
// peut pas porter l'en-tête x-app-key. Le front demande donc d'abord
// ici un jeton à usage unique (avec l'en-tête), et ne fait suivre que
// lui dans l'URL — le code d'accès, lui, ne sort jamais.
app.post("/api/google/start-link", auth, (_req, res) => {
  if (!gcal.configured()) {
    return res.status(400).json({ error: "Google n'est pas configuré sur le serveur (GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI)." });
  }
  const t = issueToken(startTokens);
  res.json({ url: APP_PASSWORD ? "/oauth/start?t=" + t : "/oauth/start" });
});

app.post("/api/google/disconnect", auth, async (_req, res) => {
  try {
    await gcal.disconnect();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Déconnexion impossible." });
  }
});

// Jetons à usage unique : lien de démarrage et state anti-CSRF.
// En mémoire : une reconnexion après redémarrage, ce n'est pas grave.
const startTokens = new Map();
const oauthStates = new Map();
function issueToken(map, ttlMs = 5 * 60 * 1000) {
  const t = randomUUID();
  map.set(t, Date.now() + ttlMs);
  if (map.size > 50) for (const [k, exp] of map) if (exp < Date.now()) map.delete(k);
  return t;
}
function useToken(map, t) {
  const exp = map.get(t);
  if (!exp) return false;
  map.delete(t);
  return exp > Date.now();
}

app.get("/oauth/start", (req, res) => {
  res.type("text/plain");
  if (!gcal.configured()) {
    return res.status(500).send("Google n'est pas configuré sur le serveur (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).");
  }
  if (APP_PASSWORD && !useToken(startTokens, String(req.query.t || ""))) {
    return res.status(401).send("Lien de connexion expiré ou invalide. Relance « Connecter l'agenda » depuis Vigie.");
  }
  res.redirect(gcal.consentUrl(issueToken(oauthStates, 10 * 60 * 1000)));
});

app.get("/oauth/callback", async (req, res) => {
  res.type("text/plain");
  const { code, state, error } = req.query;
  if (error) return res.redirect("/?google=refus");
  if (!code || !useToken(oauthStates, String(state || ""))) {
    return res.status(400).send("Requête OAuth invalide ou expirée. Recommence depuis Vigie.");
  }
  try {
    await gcal.handleCallback(String(code));
    res.redirect("/?google=ok");
  } catch (e) {
    console.error("OAuth Google:", e);
    res.status(500).send("Connexion Google échouée : " + e.message);
  }
});

// Indique au front si un code d'accès est requis
app.get("/api/config", (_req, res) =>
  res.json({ needsKey: !!APP_PASSWORD, models: ALLOWED_MODELS, defaultModel: DEFAULT_MODEL, google: gcal.configured() })
);

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
