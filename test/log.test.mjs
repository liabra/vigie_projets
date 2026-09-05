// Journalisation structurée du chemin de synchro. On CAPTURE la sortie
// console et on l'inspecte : c'est ce qui distingue « le code a l'air bon »
// de « la ligne est bien écrite ».
process.env.NODE_ENV = "test";
const PORT = 3988;
process.env.PORT = String(PORT);
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "SENTINELLE-CLIENT-SECRET";
process.env.GOOGLE_REDIRECT_URI = "https://x.test/oauth/callback";

// Jetons reconnaissables : s'ils apparaissent dans un log, le grep les voit.
const REFRESH = "SENTINELLE-REFRESH-TOKEN-1//abcdef";
const ACCESS = "SENTINELLE-ACCESS-TOKEN-ya29.xyz";

const { google } = await import("googleapis");
const { createGoogle } = await import("../google.js");

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};

// Capture : tout ce qui part sur stdout/stderr pendant le bloc.
const realLog = console.log, realErr = console.error, realWarn = console.warn;
let captured = [];
const capture = async (fn) => {
  captured = [];
  const grab = (...a) => captured.push(a.map(String).join(" "));
  console.log = grab; console.error = grab; console.warn = grab;
  try { return await fn(); } finally { console.log = realLog; console.error = realErr; console.warn = realWarn; }
};
// Les lignes [sync], désérialisées.
const syncLines = () => captured.filter((l) => l.startsWith("[sync] {")).map((l) => JSON.parse(l.slice(7)));

const CAL = "vigie@group.calendar.google.com";
const premature = () => Object.assign(new Error("Invalid response body : Premature close"),
  { cause: Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }) });
let insertBehaviour = () => null, listResult = () => [], deleteBehaviour = () => null;
google.calendar = () => ({
  calendars: { insert: async () => ({ data: { id: CAL } }) },
  events: {
    insert: async (a) => { const e = insertBehaviour(); if (e) throw e; return { data: { id: "evt-1" } }; },
    update: async (a) => ({ data: { id: a.eventId } }),
    delete: async () => { const e = deleteBehaviour(); if (e) throw e; return {}; },
    list: async () => ({ data: { items: listResult() } }),
  },
});
const store = {
  loadAuth: async () => ({ refresh_token: REFRESH, access_token: ACCESS, expiry: null }),
  saveAuth: async () => {},
  getSetting: async (k) => (k === "google_calendar_id" ? CAL : null),
  setSetting: async () => {},
};
const G = () => createGoogle(store, { sleep: async () => {} });
const task = (o = {}) => ({ id: "t-1", title: "Ma tâche", category: "dev", status: "a_faire",
  due_date: "2026-09-15T00:00:00.000Z", due_all_day: true, calendar_event_id: null, calendar_id: null, ...o });
const reset = () => { insertBehaviour = () => null; listResult = () => []; deleteBehaviour = () => null; };

console.log("── Rejeu réussi à la 2e tentative : « retry » PUIS « success »");
{
  reset();
  let n = 0;
  insertBehaviour = () => (++n === 1 ? premature() : null);
  await capture(() => G().syncTask(task()));
  const lignes = syncLines().filter((l) => l.operation === "insert");
  eq("deux lignes insert, dans l'ordre", lignes.map((l) => l.status), ["retry", "success"]);
  eq("numéros de tentative cohérents", lignes.map((l) => l.attempt), [1, 2]);
  eq("même taskId sur les deux", lignes.map((l) => l.taskId), ["t-1", "t-1"]);
  eq("l'agenda est nommé", lignes.map((l) => l.calendarId), [CAL, CAL]);
  eq("le rejeu porte l'erreur, préfixée par l'opération",
     /^events\.insert : /.test(lignes[0].error), true);
  eq("le succès ne traîne AUCUNE erreur", "error" in lignes[1], false);
  eq("horodatage ISO sur chaque ligne", syncLines().every((l) => /^\d{4}-\d\d-\d\dT.*Z$/.test(l.timestamp)), true);
}

console.log("\n── Premier essai réussi : pas de bruit");
{
  reset();
  await capture(() => G().syncTask(task()));
  eq("aucune ligne insert (rien d'anormal à signaler)",
     syncLines().filter((l) => l.operation === "insert").length, 0);
}

console.log("\n── Événement disparu → « recreate », pas « insert »");
{
  reset();
  const gone = Object.assign(new Error("Not Found"), { code: 404 });
  let n = 0;
  google.calendar = () => ({
    calendars: { insert: async () => ({ data: { id: CAL } }) },
    events: {
      update: async () => { throw gone; },
      insert: async () => ({ data: { id: "evt-2" } }),
      list: async () => ({ data: { items: [] } }),
      delete: async () => ({}),
    },
  });
  await capture(() => G().syncTask(task({ calendar_event_id: "evt-parti", calendar_id: CAL })));
  const rec = syncLines().find((l) => l.operation === "recreate");
  eq("une ligne « recreate » distincte", !!rec, true);
  eq("elle nomme l'événement disparu et sa tâche", [rec.taskId, rec.eventId], ["t-1", "evt-parti"]);
}

console.log("\n── Suppression d'un événement déjà parti → « skipped »");
{
  reset();
  google.calendar = () => ({
    calendars: { insert: async () => ({ data: { id: CAL } }) },
    events: {
      delete: async () => { throw Object.assign(new Error("Not Found"), { code: 404 }); },
      insert: async () => ({ data: { id: "x" } }), update: async () => ({ data: { id: "x" } }),
      list: async () => ({ data: { items: [] } }),
    },
  });
  await capture(() => G().removeEvent("evt-fantome", CAL, "t-1"));
  const l = syncLines().find((x) => x.operation === "delete");
  eq("journalisé en skipped, pas en échec", [l.status, l.taskId, l.eventId], ["skipped", "t-1", "evt-fantome"]);
  eq("pas d'erreur sur un skipped", "error" in l, false);
}

console.log("\n── AUCUN jeton ne fuit dans les journaux");
{
  reset();
  const tout = [];
  const collect = async (fn) => { await capture(fn); tout.push(...captured); };
  let n = 0;
  google.calendar = () => ({
    calendars: { insert: async () => ({ data: { id: CAL } }) },
    events: {
      insert: async () => { if (++n === 1) throw premature(); return { data: { id: "evt-1" } }; },
      update: async () => { throw Object.assign(new Error("Forbidden"), { code: 403 }); },
      delete: async () => { throw Object.assign(new Error("Bad"), { code: 400 }); },
      list: async () => ({ data: { items: [] } }),
    },
  });
  await collect(() => G().syncTask(task()));                                        // rejeu + succès
  await collect(() => G().syncTask(task({ calendar_event_id: "e", calendar_id: CAL })).catch(() => {})); // 403
  await collect(() => G().removeEvent("e", CAL, "t-1").catch(() => {}));            // 400
  const sortie = tout.join("\n");
  eq("aucun refresh_token", sortie.includes(REFRESH), false);
  eq("aucun access_token", sortie.includes(ACCESS), false);
  eq("aucun client_secret", sortie.includes("SENTINELLE-CLIENT-SECRET"), false);
  eq("aucune trace du mot « SENTINELLE »", /SENTINELLE/.test(sortie), false);
  eq("des lignes ont bien été produites (le test ne teste pas le vide)", tout.length > 0, true);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
