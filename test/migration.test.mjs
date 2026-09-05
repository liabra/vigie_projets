// Migration des colonnes de synchro, avec un faux pool PostgreSQL :
// chaque requête est capturée, aucune base n'est touchée.
// Ne prouve PAS que le SQL est valide côté PostgreSQL (pas de serveur ici) :
// prouve la logique d'idempotence, l'ordre, et le périmètre.
process.env.DATABASE_URL = "postgres://faux";
process.env.PORT = "0";

const pg = (await import("pg")).default;
let queries = [], columnAlreadyThere = false, backfilled = 0;
pg.Pool = class {
  async query(sql) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    queries.push(q);
    if (/information_schema\.columns/.test(q)) return { rowCount: columnAlreadyThere ? 1 : 0, rows: [] };
    if (/^UPDATE tasks SET sync_status/.test(q)) return { rowCount: backfilled };
    return { rowCount: 0, rows: [] };
  }
  on() {} end() {}
};

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const settled = async () => { for (let i = 0; i < 50 && !queries.some((q) => /app_settings/.test(q)); i++) await new Promise((r) => setTimeout(r, 10)); };

// ── Base existante, colonne absente : migration + rattrapage ──
backfilled = 3;
const server = await import("../server.js");
await settled();
const first = [...queries];

const alters = first.filter((q) => /^ALTER TABLE/.test(q));
eq("les 3 colonnes sont ajoutées en IF NOT EXISTS", alters.filter((q) => /sync_status|sync_error|last_sync_attempt/.test(q)), [
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'pending'",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_error text",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_sync_attempt timestamptz",
]);
eq("la sonde information_schema précède l'ALTER",
   first.findIndex((q) => /information_schema/.test(q)) < first.findIndex((q) => /ADD COLUMN IF NOT EXISTS sync_status/.test(q)), true);
eq("rattrapage joué quand la colonne n'existait pas",
   first.filter((q) => /^UPDATE tasks SET sync_status/.test(q)).length, 1);
eq("le rattrapage ne vise que les tâches ayant un event_id",
   first.find((q) => /^UPDATE tasks SET sync_status/.test(q)),
   "UPDATE tasks SET sync_status = 'synced' WHERE calendar_event_id IS NOT NULL AND sync_status = 'pending'");

// ── Périmètre : rien sur articles ────────────────────────────
eq("aucun ALTER sur articles", first.filter((q) => /^ALTER TABLE articles/.test(q)), []);
eq("aucun UPDATE sur articles", first.filter((q) => /^UPDATE articles/.test(q)), []);
eq("la table articles n'a pas de colonne de synchro",
   /sync_status|sync_error|last_sync_attempt/.test(first.find((q) => /CREATE TABLE IF NOT EXISTS articles/.test(q)) || ""), false);
eq("les colonnes existantes sont conservées",
   ["calendar_event_id text", "calendar_id text"].every((c) => (first.find((q) => /CREATE TABLE IF NOT EXISTS tasks/.test(q)) || "").includes(c)), true);

// ── Rejeu sur une base DÉJÀ migrée : pas de second rattrapage ─
queries = []; columnAlreadyThere = true;
await server.ensureTable();
eq("rejeu : les ALTER repassent (IF NOT EXISTS, sans effet)",
   queries.filter((q) => /ADD COLUMN IF NOT EXISTS (sync_status|sync_error|last_sync_attempt)/.test(q)).length, 3);
eq("rejeu : AUCUN rattrapage — un 'pending' voulu n'est pas écrasé",
   queries.filter((q) => /^UPDATE tasks SET sync_status/.test(q)).length, 0);

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
