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

export async function ensureTable() {
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
    urgency text NOT NULL DEFAULT 'normale',
    calendar_event_id text,
    calendar_id text,
    sync_status text NOT NULL DEFAULT 'pending',
    sync_error text,
    last_sync_attempt timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Ajouté après coup : les tâches déjà en base passent à 'normale'.
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS urgency text NOT NULL DEFAULT 'normale'");
  // Agenda où l'événement a réellement été créé. NULL sur les tâches
  // d'avant le routage : elles sont toutes dans l'agenda « Vigie », et
  // google.js sait le déduire.
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_id text");

  // État de la synchro agenda, pour qu'une désync cesse de passer inaperçue.
  //   'pending' — pas (encore) miroir, ou jamais tenté
  //   'synced'  — événement confirmé par Google, event_id en base
  //   'error'   — échec définitif, sync_error dit lequel
  //
  // NOTE: sync_status/sync_error/last_sync_attempt ne couvrent que `tasks`
  // pour l'instant. `articles` a le même risque de désync (calendar_event_id
  // /calendar_id propres) mais est volontairement laissé hors périmètre —
  // décision du 2026-09-05, à reprendre plus tard. Les articles gardent le
  // rejeu idempotent hérité de callCalendar/withRetry, mais n'auront ni
  // colonne d'état, ni suivi d'erreur persistant, ni réconciliation dédiée
  // tant que cette décision n'est pas revisitée.
  const hadSyncStatus = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'sync_status'"
  );
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'pending'");
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_error text");
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_sync_attempt timestamptz");
  // Rattrapage UNE SEULE FOIS, à la création de la colonne : une tâche qui
  // porte déjà un calendar_event_id tient cet id de Google, elle est donc
  // bien synchronisée. La laisser à 'pending' ferait re-vérifier tout
  // l'existant pour rien. Conditionné à l'absence préalable de la colonne
  // pour ne jamais réécrire un 'pending' voulu au redémarrage suivant.
  if (!hadSyncStatus.rowCount) {
    const done = await pool.query(
      "UPDATE tasks SET sync_status = 'synced' WHERE calendar_event_id IS NOT NULL AND sync_status = 'pending'"
    );
    if (done.rowCount) console.log(`Migration : ${done.rowCount} tâche(s) déjà synchronisée(s) marquée(s) 'synced'.`);
  }

  // user_id : un seul 'owner' aujourd'hui, la clé est là pour plus tard.
  await pool.query(`CREATE TABLE IF NOT EXISTS google_auth (
    user_id text PRIMARY KEY,
    refresh_token text,
    access_token text,
    expiry timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS articles (
    id uuid PRIMARY KEY,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'idee',
    release_date timestamptz,
    prompt_url text,
    doc_url text,
    notebooklm_url text,
    calendar_event_id text,
    calendar_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
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

// La catégorie décide de l'agenda de destination : voir google.js.
const CATEGORIES = ["perso", "admin", "dev", "boulot"];
const TASK_STATUSES = ["a_faire", "en_cours", "fait"];
// Urgence : purement interne à Vigie. Elle ne part JAMAIS vers l'agenda
// Google — voir buildEventBody dans google.js, qui ne lit pas ce champ.
const URGENCIES = ["normale", "importante", "urgente"];

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
    `INSERT INTO tasks (id, title, category, status, due_date, due_all_day, urgency, calendar_event_id, calendar_id,
       sync_status, sync_error, last_sync_attempt, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [t.id, t.title, t.category, t.status, t.due_date, t.due_all_day, t.urgency, t.calendar_event_id, t.calendar_id,
     t.sync_status || "pending", t.sync_error ?? null, t.last_sync_attempt ?? null, t.created_at, t.updated_at]
  );
  return t;
}
async function writeTask(t) {
  if (!pool) { memTasks = memTasks.map((x) => (x.id === t.id ? t : x)); return t; }
  await pool.query(
    `UPDATE tasks SET title=$2, category=$3, status=$4, due_date=$5, due_all_day=$6,
       urgency=$7, calendar_event_id=$8, calendar_id=$9, updated_at=$10,
       sync_status=$11, sync_error=$12, last_sync_attempt=$13 WHERE id=$1`,
    [t.id, t.title, t.category, t.status, t.due_date, t.due_all_day, t.urgency, t.calendar_event_id, t.calendar_id, t.updated_at,
     t.sync_status || "pending", t.sync_error ?? null, t.last_sync_attempt ?? null]
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
  urgency: t.urgency || "normale",
  calendarEventId: t.calendar_event_id || null,
  calendarId: t.calendar_id || null,
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

// ── Articles ──────────────────────────────────────────────────
const ARTICLE_STATUSES = ["idee", "brouillon", "redaction", "en_ligne"];
let memArticles = [];

// Une URL vide est acceptée (champ facultatif) ; sinon on exige une
// adresse web — validation volontairement grossière, c'est un garde-fou
// de saisie, pas un contrôle d'accès.
function parseUrl(v) {
  const u = (v || "").trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u.slice(0, 2000) : undefined; // undefined = refus
}

async function listArticles() {
  if (!pool) return [...memArticles].sort(sortArticles);
  const r = await pool.query("SELECT * FROM articles");
  return r.rows.sort(sortArticles);
}
// Sorties les plus proches en tête, sans date à la fin.
function sortArticles(a, b) {
  const da = a.release_date ? new Date(a.release_date).getTime() : Infinity;
  const db = b.release_date ? new Date(b.release_date).getTime() : Infinity;
  if (da !== db) return da - db;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}
async function getArticle(id) {
  if (!pool) return memArticles.find((a) => a.id === id) || null;
  const r = await pool.query("SELECT * FROM articles WHERE id = $1", [id]);
  return r.rows[0] || null;
}
async function insertArticle(a) {
  if (!pool) { memArticles.push(a); return a; }
  await pool.query(
    `INSERT INTO articles (id, title, status, release_date, prompt_url, doc_url, notebooklm_url,
       calendar_event_id, calendar_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [a.id, a.title, a.status, a.release_date, a.prompt_url, a.doc_url, a.notebooklm_url,
     a.calendar_event_id, a.calendar_id, a.created_at, a.updated_at]
  );
  return a;
}
async function writeArticle(a) {
  if (!pool) { memArticles = memArticles.map((x) => (x.id === a.id ? a : x)); return a; }
  await pool.query(
    `UPDATE articles SET title=$2, status=$3, release_date=$4, prompt_url=$5, doc_url=$6,
       notebooklm_url=$7, calendar_event_id=$8, calendar_id=$9, updated_at=$10 WHERE id=$1`,
    [a.id, a.title, a.status, a.release_date, a.prompt_url, a.doc_url, a.notebooklm_url,
     a.calendar_event_id, a.calendar_id, a.updated_at]
  );
  return a;
}
async function deleteArticle(id) {
  if (!pool) { memArticles = memArticles.filter((a) => a.id !== id); return; }
  await pool.query("DELETE FROM articles WHERE id = $1", [id]);
}

const articleToJson = (a) => ({
  id: a.id,
  title: a.title,
  status: a.status,
  releaseDate: a.release_date ? new Date(a.release_date).toISOString() : null,
  promptUrl: a.prompt_url || null,
  docUrl: a.doc_url || null,
  notebooklmUrl: a.notebooklm_url || null,
  calendarEventId: a.calendar_event_id || null,
  calendarId: a.calendar_id || null,
  createdAt: a.created_at ? new Date(a.created_at).toISOString() : null,
  updatedAt: a.updated_at ? new Date(a.updated_at).toISOString() : null,
});

// ── Google Agenda (sens unique : Vigie écrit, ne lit rien d'autre) ─
const gcal = createGoogle({ loadAuth, saveAuth, getSetting, setSetting });

// Pousse l'état d'une tâche vers l'agenda. Ne lève jamais : sans
// compte Google lié — ou si Google répond mal — la tâche reste
// enregistrée, et repartira à la prochaine modification.
// « Doit être miroir » : la tâche a une échéance ET une catégorie qui mène
// à un agenda (perso/admin → primary, dev/boulot → « Vigie »). Une tâche
// hors de cette définition n'a rien à refléter : ce n'est pas un échec.
const MIRRORED_CATEGORIES = CATEGORIES; // les 4 catégories mènent à un agenda
export function shouldMirror(task) {
  return !!task.due_date && MIRRORED_CATEGORIES.includes(task.category);
}

// Transition d'état après une tentative de synchro. Isolée et pure : elle
// ne touche ni Google ni la base, ce qui la rend testable exhaustivement.
//   outcome.skipped → aucune tentative n'a eu lieu, on ne consigne rien
//   outcome.error   → échec définitif
//   sinon           → succès, eventId fait foi
export function applySyncOutcome(task, outcome, attemptedAt) {
  if (outcome.skipped) return task;
  task.last_sync_attempt = attemptedAt;

  if (outcome.error) {
    task.sync_error = syncErrorMessage(outcome.error);
    // Hors périmètre : l'échec est consigné, mais l'état ne passe pas en
    // 'error' — une tâche sans échéance n'a pas de miroir à rater.
    task.sync_status = shouldMirror(task) ? "error" : "pending";
    return task;
  }

  // On garde le couple (agenda, événement) : c'est le seul moyen de
  // savoir plus tard où patcher ou supprimer.
  task.calendar_event_id = outcome.eventId || null;
  task.calendar_id = outcome.eventId ? outcome.calendarId || null : null;
  // 'synced' EXIGE un event_id confirmé par Google. Sans lui — tâche sans
  // échéance, événement supprimé — on retombe à 'pending', pas 'error' :
  // il n'y a rien à refléter.
  task.sync_status = task.calendar_event_id ? "synced" : "pending";
  task.sync_error = null;
  return task;
}

// Message d'erreur exploitable : jamais un « Error » nu. rawCall (google.js)
// a déjà préfixé l'opération, on ajoute de quoi agir quand c'est possible.
function syncErrorMessage(e) {
  if (gcal.isScopeError(e)) {
    return "Droits Google insuffisants — reconnecter l'agenda dans l'onglet Tâches. " + (e.message || "");
  }
  const detail = (e && e.message ? String(e.message) : "").trim();
  return (detail || "Échec inconnu de la synchro agenda").slice(0, 500);
}

async function syncTask(task) {
  const attemptedAt = new Date();
  try {
    const outcome = await gcal.syncTask(task);
    // Google pas configuré ou pas lié : aucune tentative n'a eu lieu, donc
    // rien à consigner. L'état reste ce qu'il était.
    if (outcome.skipped) return null;
    applySyncOutcome(task, outcome, attemptedAt);
    await writeTask(task);
    return null;
  } catch (e) {
    console.error(
      `Synchro tâche ${task.id} (${task.category}, miroir=${shouldMirror(task)}) → échec définitif : ${e.message}`
    );
    applySyncOutcome(task, { error: e }, attemptedAt);
    // L'écriture d'état ne doit jamais faire échouer la requête : la tâche
    // elle-même est déjà enregistrée.
    try { await writeTask(task); } catch (w) { console.error("Écriture de l'état de synchro:", w.message); }

    if (gcal.isScopeError(e)) {
      return "Tâche enregistrée. L'agenda Google demande de nouveaux droits : " +
        "clique « Reconnecter l'agenda Google » dans l'onglet Tâches.";
    }
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


// Pousse la date de sortie d'un article vers l'agenda « Vigie – Articles ».
// Ne lève jamais : sans compte Google lié, l'article vit sa vie.
async function syncArticle(article) {
  try {
    const { eventId, calendarId, skipped } = await gcal.syncArticle(article);
    if (skipped) return null;
    if ((eventId || null) !== (article.calendar_event_id || null) ||
        (calendarId || null) !== (article.calendar_id || null)) {
      article.calendar_event_id = eventId || null;
      article.calendar_id = eventId ? calendarId || null : null;
      await writeArticle(article);
    }
    return null;
  } catch (e) {
    console.error("Google Agenda (articles):", e.message);
    if (gcal.isScopeError(e)) {
      return "Article enregistré. L'agenda Google demande de nouveaux droits : " +
        "clique « Reconnecter l'agenda Google » dans l'onglet Tâches.";
    }
    return "Article enregistré, mais l'agenda Google n'a pas suivi : " + e.message;
  }
}

// ── Articles (mêmes règles d'accès que /api/tasks) ────────────
app.get("/api/articles", auth, async (_req, res) => {
  try {
    res.json({ articles: (await listArticles()).map(articleToJson) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lecture des articles impossible." });
  }
});

app.post("/api/articles", auth, async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return res.status(400).json({ error: "Titre manquant." });

  const urls = {};
  for (const [field, key] of [["promptUrl", "prompt_url"], ["docUrl", "doc_url"], ["notebooklmUrl", "notebooklm_url"]]) {
    const u = parseUrl(b[field]);
    if (u === undefined) return res.status(400).json({ error: "Lien invalide : il doit commencer par http:// ou https://." });
    urls[key] = u;
  }
  const now = new Date();
  const article = {
    id: randomUUID(),
    title: title.slice(0, 300),
    status: ARTICLE_STATUSES.includes(b.status) ? b.status : "idee",
    // Toujours une journée entière : on range à minuit UTC, comme les
    // tâches « journée », pour que le jour ne glisse pas d'un fuseau.
    release_date: parseDue(b.releaseDate, true),
    ...urls,
    calendar_event_id: null,
    calendar_id: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await insertArticle(article);
    const syncWarning = await syncArticle(article);
    res.status(201).json({ article: articleToJson(article), syncWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Création impossible." });
  }
});

app.patch("/api/articles/:id", auth, async (req, res) => {
  const b = req.body || {};
  try {
    const article = await getArticle(req.params.id);
    if (!article) return res.status(404).json({ error: "Article introuvable." });

    if (typeof b.title === "string") {
      const t = b.title.trim();
      if (!t) return res.status(400).json({ error: "Titre vide." });
      article.title = t.slice(0, 300);
    }
    // Statut inconnu → 'idee', comme une catégorie inconnue devient 'perso'.
    if (b.status !== undefined) article.status = ARTICLE_STATUSES.includes(b.status) ? b.status : "idee";
    if (b.releaseDate !== undefined) article.release_date = parseDue(b.releaseDate, true);
    for (const [field, key] of [["promptUrl", "prompt_url"], ["docUrl", "doc_url"], ["notebooklmUrl", "notebooklm_url"]]) {
      if (b[field] === undefined) continue;
      const u = parseUrl(b[field]);
      if (u === undefined) return res.status(400).json({ error: "Lien invalide : il doit commencer par http:// ou https://." });
      article[key] = u;
    }
    article.updated_at = new Date();

    await writeArticle(article);
    const syncWarning = await syncArticle(article);
    res.json({ article: articleToJson(article), syncWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Modification impossible." });
  }
});

app.delete("/api/articles/:id", auth, async (req, res) => {
  try {
    const article = await getArticle(req.params.id);
    if (!article) return res.status(404).json({ error: "Article introuvable." });
    await deleteArticle(article.id);
    let syncWarning = null;
    try {
      // Uniquement le couple stocké : jamais d'opération à l'aveugle.
      await gcal.removeEvent(article.calendar_event_id, article.calendar_id);
    } catch (e) {
      console.error("Google Agenda (articles):", e.message);
      syncWarning = "Article supprimé, mais l'événement d'agenda est peut-être resté.";
    }
    res.json({ ok: true, syncWarning });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Suppression impossible." });
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
    urgency: URGENCIES.includes(b.urgency) ? b.urgency : "normale",
    due_date: parseDue(b.dueDate, allDay),
    due_all_day: allDay,
    calendar_event_id: null,
    calendar_id: null,
    sync_status: "pending",
    sync_error: null,
    last_sync_attempt: null,
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
    if (b.urgency !== undefined) task.urgency = URGENCIES.includes(b.urgency) ? b.urgency : "normale";
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
      await gcal.removeEvent(task.calendar_event_id, task.calendar_id);
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
    // e.gcalOp est posé par google.js : il nomme l'appel Calendar fautif
    // (calendars.insert, events.update…) plutôt qu'un « 403 » anonyme.
    const where = e.gcalOp ? "appel " + e.gcalOp : "échange du code OAuth";
    console.error("OAuth Google — échec sur " + where + ":", e);
    res.status(500).send(
      "Connexion Google échouée pendant : " + where + "\n\n" + e.message +
        (e.code === 403
          ? "\n\nUn 403 ici veut dire que cette opération sort du scope demandé " +
            "(calendar.app.created), qui ne donne accès qu'aux agendas créés par Vigie."
          : "")
    );
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

console.log("Node", process.version);
const port = process.env.PORT || 3000;
ensureTable()
  .catch((e) => console.error("Init base:", e))
  .finally(() =>
    app.listen(port, () => console.log("Vigie en ligne sur le port " + port))
  );
