// Résilience + idempotence de l'insert, avec un faux client Calendar :
// chaque appel est journalisé, aucun octet ne sort.
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.GOOGLE_REDIRECT_URI = "https://x.test/oauth/callback";
const G = await import("../google.js");
const { createGoogle, isTransient, retryDelayMs, buildEventBody, buildArticleEventBody, markerOf, MARKER_TASK } = G;
const { google } = await import("googleapis");

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};

// Erreurs réalistes telles que gaxios / node-fetch les produisent.
const premature = () => Object.assign(new Error("Invalid response body while trying to fetch https://www.googleapis.com/... : Premature close"),
  { cause: Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }) });
const httpErr = (status, headers) => Object.assign(new Error("HTTP " + status), { code: status, response: { status, headers } });
const sysErr = (code) => Object.assign(new Error("socket " + code), { code });

console.log("── Classement des erreurs");
eq("Premature close → transitoire", isTransient(premature()), true);
eq("ERR_STREAM_PREMATURE_CLOSE nu → transitoire", isTransient(sysErr("ERR_STREAM_PREMATURE_CLOSE")), true);
for (const c of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]) eq(c + " → transitoire", isTransient(sysErr(c)), true);
for (const s of [429, 500, 502, 503, 504]) eq(s + " → transitoire", isTransient(httpErr(s)), true);
for (const s of [400, 401, 403, 404]) eq(s + " → DÉFINITIF", isTransient(httpErr(s)), false);
// Les trois champs où un statut peut se cacher, isolément. Une erreur HTTP
// sans corps JSON structuré n'expose parfois QUE .status : sans ce cas, la
// détection fatale pourrait passer à côté et rejouer un 404.
eq("statut SEUL dans .status (ni .code ni .response) → 404 DÉFINITIF",
   isTransient(Object.assign(new Error("Not Found"), { status: 404 })), false);
eq("statut SEUL dans .status → 503 transitoire",
   isTransient(Object.assign(new Error("Unavailable"), { status: 503 })), true);
eq("statut SEUL dans .response.status → 400 DÉFINITIF",
   isTransient({ message: "Bad Request", response: { status: 400 } }), false);
eq("statut SEUL dans .response.status → 502 transitoire",
   isTransient({ message: "Bad Gateway", response: { status: 502 } }), true);
eq("statut SEUL dans .code (AIP-193) → 401 DÉFINITIF",
   isTransient(Object.assign(new Error("Unauthorized"), { code: 401 })), false);
eq("statut en chaîne \"429\" → transitoire",
   isTransient(Object.assign(new Error("x"), { status: "429" })), true);
eq("statut fatal repéré dans une cause imbriquée",
   isTransient({ message: "wrap", cause: Object.assign(new Error("inner"), { status: 403 }) }), false);
eq("cause imbriquée inspectée", isTransient({ message: "x", cause: { message: "y", cause: sysErr("ECONNRESET") } }), true);
eq("gaxios response.status prioritaire", isTransient({ message: "boom", response: { status: 403 } }), false);
// Le piège : un premature close qui porte quand même un statut 200.
eq("premature close avec statut 200 → transitoire", isTransient(Object.assign(premature(), { response: { status: 200 } })), true);
// Et l'inverse : un 404 dont le message contient le mot ne doit PAS être rejoué.
eq("404 dont le message dit « premature close » → DÉFINITIF",
   isTransient(Object.assign(new Error("Premature close"), { code: 404 })), false);
eq("erreur inconnue → pas de rejeu", isTransient(new Error("bizarre")), false);
eq("cycle de causes → pas de boucle infinie", (() => { const a = new Error("a"); a.cause = a; return isTransient(a); })(), false);

console.log("\n── Temporisation");
const d1 = retryDelayMs(1, new Error("x"), () => 0), d2 = retryDelayMs(1, new Error("x"), () => 1);
eq("tentative 1 bornée [150,300]", [d1, d2], [150, 300]);
eq("tentative 2 bornée [300,600]", [retryDelayMs(2, new Error("x"), () => 0), retryDelayMs(2, new Error("x"), () => 1)], [300, 600]);
eq("plafonné à 2000 ms", retryDelayMs(9, new Error("x"), () => 1) <= 2000, true);
eq("Retry-After en secondes respecté", retryDelayMs(1, httpErr(429, { "retry-after": "1" })), 1000);
eq("Retry-After démesuré → plafonné", retryDelayMs(1, httpErr(503, { "retry-after": "300" })), 2000);
eq("Retry-After en en-têtes fetch (get)", retryDelayMs(1, httpErr(429, { get: (k) => (k === "retry-after" ? "2" : null) })), 2000);

console.log("\n── Marqueur");
const body = buildEventBody({ id: "t-1", title: "T", category: "dev", status: "a_faire", due_date: "2026-09-15T00:00:00.000Z", due_all_day: true });
eq("marqueur posé sur le corps", body.extendedProperties, { private: { [MARKER_TASK]: "t-1" } });
eq("markerOf le relit", markerOf(body), { key: MARKER_TASK, value: "t-1" });
eq("corps sans marqueur → null", markerOf({ summary: "x" }), null);
// Une seule clé : les articles portent le MÊME marqueur que les tâches.
{
  const ab = buildArticleEventBody({ id: "a-7", title: "A", status: "idee", release_date: "2026-09-15T00:00:00.000Z" });
  eq("article : même clé vigieTaskId", ab.extendedProperties, { private: { [MARKER_TASK]: "a-7" } });
  eq("markerOf le relit sur un article", markerOf(ab), { key: MARKER_TASK, value: "a-7" });
  eq("aucune clé vigieArticleId nulle part", JSON.stringify(ab).includes("vigieArticleId"), false);
  eq("marqueur réaffirmé quand l'article passe en ligne",
     buildArticleEventBody({ id: "a-7", title: "A", status: "en_ligne", release_date: "2026-09-15T00:00:00.000Z" }).extendedProperties,
     { private: { [MARKER_TASK]: "a-7" } });
}
eq("marqueur réaffirmé quand la tâche passe à fait",
   buildEventBody({ id: "t-1", title: "T", category: "dev", status: "fait", due_date: "2026-09-15T00:00:00.000Z", due_all_day: true }).extendedProperties,
   { private: { [MARKER_TASK]: "t-1" } });

// ── Scénarios d'insert ───────────────────────────────────────
const CAL = "vigie@group.calendar.google.com";
let calls, inserted, listResult, insertBehaviour;
const mkClient = () => ({
  calendars: { insert: async () => ({ data: { id: CAL } }) },
  events: {
    insert: async (a) => {
      calls.push({ op: "insert", cal: a.calendarId });
      const r = insertBehaviour(calls.filter((c) => c.op === "insert").length);
      if (r) throw r;
      const ev = { id: "evt-" + (inserted.length + 1), extendedProperties: a.requestBody.extendedProperties };
      inserted.push(ev);
      return { data: ev };
    },
    list: async (a) => {
      calls.push({ op: "list", cal: a.calendarId, filter: a.privateExtendedProperty, showDeleted: a.showDeleted });
      return { data: { items: listResult() } };
    },
    update: async (a) => { calls.push({ op: "update", cal: a.calendarId, id: a.eventId }); return { data: { id: a.eventId } }; },
    delete: async (a) => { calls.push({ op: "delete", cal: a.calendarId, id: a.eventId }); return {}; },
  },
});
google.calendar = mkClient;
const store = (s = {}) => { const m = new Map(Object.entries(s)); return {
  loadAuth: async () => ({ refresh_token: "rt" }), saveAuth: async () => {},
  getSetting: async (k) => m.get(k) ?? null, setSetting: async (k, v) => { v === null ? m.delete(k) : m.set(k, v); } }; };
const mkG = () => createGoogle(store({ google_calendar_id: CAL }), { sleep: async () => {} });
const task = (o = {}) => ({ id: "t-42", title: "Ma tâche", category: "dev", status: "a_faire",
  due_date: "2026-09-15T00:00:00.000Z", due_all_day: true, calendar_event_id: null, calendar_id: null, ...o });
const reset = () => { calls = []; inserted = []; listResult = () => []; insertBehaviour = () => null; };

console.log("\n── Chemin nominal : un seul appel");
reset();
{
  const r = await mkG().syncTask(task());
  eq("un insert, aucune liste", calls.map((c) => c.op), ["insert"]);
  eq("événement créé", [r.eventId, r.calendarId], ["evt-1", CAL]);
}

console.log("\n── Premature close : rejeu SANS doublon");
reset();
{
  // 1er insert : échoue APRÈS avoir créé l'événement côté Google (faux négatif).
  const ghost = { id: "evt-fantome", extendedProperties: { private: { [MARKER_TASK]: "t-42" } } };
  insertBehaviour = (n) => { if (n === 1) { inserted.push(ghost); return premature(); } return null; };
  listResult = () => inserted.filter((e) => e.extendedProperties?.private?.[MARKER_TASK] === "t-42");
  const r = await mkG().syncTask(task());
  eq("séquence : insert échoué → liste → adoption", calls.map((c) => c.op), ["insert", "list"]);
  eq("AUCUN second insert", calls.filter((c) => c.op === "insert").length, 1);
  eq("id de l'événement déjà créé adopté", r.eventId, "evt-fantome");
  eq("un seul événement existe", inserted.length, 1);
  eq("recherche filtrée par le marqueur", calls[1].filter, "vigieTaskId=t-42");
  eq("recherche sur le bon agenda, sans les supprimés", [calls[1].cal, calls[1].showDeleted], [CAL, false]);
}

console.log("\n── Premature close SANS insert abouti : on réinsère");
reset();
{
  insertBehaviour = (n) => (n === 1 ? premature() : null);
  listResult = () => []; // rien côté Google : le premier insert a vraiment échoué
  const r = await mkG().syncTask(task());
  eq("séquence : insert → liste (vide) → insert", calls.map((c) => c.op), ["insert", "list", "insert"]);
  eq("événement finalement créé", r.eventId, "evt-1");
  eq("un seul événement", inserted.length, 1);
}

console.log("\n── Échec transitoire persistant : 3 tentatives puis erreur");
reset();
{
  insertBehaviour = () => premature();
  let err = null;
  try { await mkG().syncTask(task()); } catch (e) { err = e; }
  eq("3 inserts au maximum", calls.filter((c) => c.op === "insert").length, 3);
  eq("l'erreur remonte", /Premature close/.test(err?.message || ""), true);
  eq("aucun événement créé", inserted.length, 0);
}

console.log("\n── Faux négatif sur la DERNIÈRE tentative");
reset();
{
  const ghost = { id: "evt-tardif", extendedProperties: { private: { [MARKER_TASK]: "t-42" } } };
  insertBehaviour = (n) => { if (n === 3) inserted.push(ghost); return premature(); };
  listResult = () => inserted.filter((e) => e.extendedProperties?.private?.[MARKER_TASK] === "t-42");
  const r = await mkG().syncTask(task());
  eq("rattrapé sans erreur ni doublon", [r.eventId, inserted.length], ["evt-tardif", 1]);
}

console.log("\n── Erreurs définitives : AUCUN rejeu");
for (const [label, status] of [["400", 400], ["401 (→ refresh, pas retry)", 401], ["403 (scopes)", 403]]) {
  reset();
  insertBehaviour = () => httpErr(status);
  let err = null;
  try { await mkG().syncTask(task()); } catch (e) { err = e; }
  eq(label + " → un seul insert, aucune liste", calls.map((c) => c.op), ["insert"]);
  eq(label + " → l'erreur remonte", !!err, true);
}

console.log("\n── Garde-fou : la recherche ne peut rien ramener d'étranger");
reset();
{
  insertBehaviour = (n) => (n === 1 ? premature() : null);
  // Google renvoie (à tort) un événement sans marqueur, ou avec un autre.
  listResult = () => [
    { id: "evt-etranger" },
    { id: "evt-autre-tache", extendedProperties: { private: { [MARKER_TASK]: "t-999" } } },
    { id: "evt-annule", status: "cancelled", extendedProperties: { private: { [MARKER_TASK]: "t-42" } } },
  ];
  const r = await mkG().syncTask(task());
  eq("aucun événement étranger adopté", r.eventId, "evt-1");
  eq("un insert de rattrapage a bien eu lieu", calls.filter((c) => c.op === "insert").length, 2);
}

console.log("\n── Update et delete : rejoués, mais jamais à l'aveugle");
reset();
{
  let n = 0;
  google.calendar = () => { const c = mkClient(); const up = c.events.update;
    c.events.update = async (a) => { calls.push({ op: "update", cal: a.calendarId, id: a.eventId }); if (++n === 1) throw premature(); return { data: { id: a.eventId } }; };
    return c; };
  const r = await mkG().syncTask(task({ calendar_event_id: "evt-9", calendar_id: CAL }));
  eq("update rejoué sur le MÊME couple stocké", calls.map((c) => [c.op, c.cal, c.id]), [["update", CAL, "evt-9"], ["update", CAL, "evt-9"]]);
  eq("aucune liste, aucun insert", calls.some((c) => c.op === "list" || c.op === "insert"), false);
  eq("id conservé", r.eventId, "evt-9");
  google.calendar = mkClient;
}
reset();
{
  let n = 0;
  google.calendar = () => { const c = mkClient();
    c.events.delete = async (a) => { calls.push({ op: "delete", cal: a.calendarId, id: a.eventId }); if (++n === 1) throw premature(); return {}; };
    return c; };
  await mkG().removeEvent("evt-7", CAL);
  eq("delete rejoué sur le couple stocké", calls.map((c) => [c.op, c.id]), [["delete", "evt-7"], ["delete", "evt-7"]]);
  google.calendar = mkClient;
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
