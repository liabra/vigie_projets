// Réconciliation : dry-run et mode réel, avec un faux client Calendar.
// Le dry-run ne doit toucher NI Google NI la base — on le prouve en
// comptant les écritures sur les deux.
process.env.NODE_ENV = "test"; // sinon __testHooks vaut null
const PORT = 3987;
process.env.PORT = String(PORT);
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.GOOGLE_REDIRECT_URI = "https://x.test/oauth/callback";

const { google } = await import("googleapis");
const CAL = "vigie@group.calendar.google.com";
let calls = [], events = [], seq = 0, gate = null;
google.calendar = () => ({
  calendars: { insert: async (a) => { calls.push({ op: "calendars.insert" }); return { data: { id: CAL } }; } },
  events: {
    list: async (a) => {
      calls.push({ op: "list", cal: a.calendarId, filter: a.privateExtendedProperty });
      if (gate) await gate;
      const [k, v] = String(a.privateExtendedProperty || "=").split("=");
      return { data: { items: events.filter((e) => e.calendarId === a.calendarId && e.extendedProperties?.private?.[k] === v) } };
    },
    insert: async (a) => {
      calls.push({ op: "insert", cal: a.calendarId, marker: a.requestBody.extendedProperties?.private?.vigieTaskId });
      const ev = { id: "evt-" + ++seq, calendarId: a.calendarId, extendedProperties: a.requestBody.extendedProperties };
      events.push(ev); return { data: ev };
    },
    update: async (a) => { calls.push({ op: "update", cal: a.calendarId, id: a.eventId }); return { data: { id: a.eventId } }; },
    delete: async (a) => { calls.push({ op: "delete", cal: a.calendarId, id: a.eventId }); return {}; },
  },
});

const srv = await import("../server.js");
const { reconcileCalendarSync, __testHooks: H } = srv;

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const task = (o = {}) => ({ id: "t-1", title: "Ma tâche", category: "dev", status: "a_faire",
  due_date: "2026-09-15T00:00:00.000Z", due_all_day: true, urgency: "normale",
  calendar_event_id: null, calendar_id: null, sync_status: "pending", sync_error: null,
  last_sync_attempt: null, created_at: new Date(), updated_at: new Date(), ...o });
const writes = () => calls.filter((c) => ["insert", "update", "delete", "calendars.insert"].includes(c.op));
const reset = (tasks) => {
  calls = []; events = []; seq = 0;
  gate = null;
  H.setTasks(tasks); H.setAuth({ refresh_token: "rt" }); H.setSetting("google_calendar_id", CAL);
};

console.log("── Un appel sans paramètre n'écrit RIEN");
{
  reset([task({ id: "t-a" }), task({ id: "t-b", category: "perso" })]);
  const before = JSON.stringify(H.tasks());
  const r = await reconcileCalendarSync();
  eq("mode dry-run par défaut", r.executed, false);
  eq("aucune écriture Google", writes(), []);
  eq("aucune écriture en base", JSON.stringify(H.tasks()), before);
  eq("des lectures, oui — toutes filtrées par marqueur",
     calls.every((c) => c.op === "list" && /^vigieTaskId=/.test(c.filter)), true);
}

console.log("\n── Dry-run : les trois actions");
{
  // t-sync : déjà liée au bon événement → skip
  // t-orph : événement existe AVEC marqueur, lien perdu → adopt
  // t-neuf : aucun événement → insert
  reset([
    task({ id: "t-sync", title: "Déjà bonne", calendar_event_id: "evt-sync", calendar_id: CAL, sync_status: "pending" }),
    task({ id: "t-orph", title: "Lien perdu", calendar_event_id: null, sync_status: "error" }),
    task({ id: "t-neuf", title: "Jamais créée" }),
  ]);
  events = [
    { id: "evt-sync", calendarId: CAL, extendedProperties: { private: { vigieTaskId: "t-sync" } } },
    { id: "evt-orph", calendarId: CAL, extendedProperties: { private: { vigieTaskId: "t-orph" } } },
  ];
  const r = await reconcileCalendarSync();
  eq("compteurs", [r.checked, r.wouldSkip, r.wouldAdopt, r.wouldInsert], [3, 1, 1, 1]);
  eq("détail par tâche, pas juste des compteurs",
     r.details.map((d) => [d.id, d.title, d.action]),
     [["t-sync", "Déjà bonne", "skip"], ["t-orph", "Lien perdu", "adopt"], ["t-neuf", "Jamais créée", "insert"]]);
  eq("l'événement à adopter est nommé", r.details[1].eventId, "evt-orph");
  eq("toujours aucune écriture", writes(), []);
}

console.log("\n── Dry-run rejouable : deux passes identiques");
{
  reset([task({ id: "t-neuf" })]);
  const a = await reconcileCalendarSync();
  const b = await reconcileCalendarSync();
  eq("même verdict", [a.wouldInsert, b.wouldInsert], [1, 1]);
  eq("aucune écriture après deux passes", writes(), []);
}

console.log("\n── Mode réel : insert → un seul événement, marqueur inclus");
{
  reset([task({ id: "t-neuf", title: "Jamais créée" })]);
  const r = await reconcileCalendarSync({ execute: true });
  eq("mode réel signalé", r.executed, true);
  eq("compteurs", [r.checked, r.inserted, r.adopted, r.stillFailing], [1, 1, 0, 0]);
  eq("UN seul insert", calls.filter((c) => c.op === "insert").length, 1);
  eq("marqueur posé", calls.find((c) => c.op === "insert").marker, "t-neuf");
  const t = H.tasks()[0];
  eq("tâche passée à synced avec son event_id", [t.sync_status, t.calendar_event_id], ["synced", "evt-1"]);
}

console.log("\n── Mode réel : adoption, JAMAIS de doublon");
{
  reset([task({ id: "t-orph", calendar_event_id: null, sync_status: "error", sync_error: "vieux" })]);
  events = [{ id: "evt-existant", calendarId: CAL, extendedProperties: { private: { vigieTaskId: "t-orph" } } }];
  const r = await reconcileCalendarSync({ execute: true });
  eq("compté comme adoption", [r.adopted, r.inserted], [1, 0]);
  eq("AUCUN insert — l'événement existait", calls.filter((c) => c.op === "insert").length, 0);
  eq("mise à jour sur l'événement adopté", calls.filter((c) => c.op === "update").map((c) => c.id), ["evt-existant"]);
  eq("un seul événement au total", events.length, 1);
  const t = H.tasks()[0];
  eq("lien réparé + synced + erreur effacée",
     [t.calendar_event_id, t.sync_status, t.sync_error], ["evt-existant", "synced", null]);
}

console.log("\n── Mode réel rejouable : la 2e passe ne fait plus rien");
{
  reset([task({ id: "t-neuf" })]);
  await reconcileCalendarSync({ execute: true });
  const insertsAfter1 = calls.filter((c) => c.op === "insert").length;
  const r2 = await reconcileCalendarSync({ execute: true });
  eq("1er passage : un insert", insertsAfter1, 1);
  eq("2e passage : plus candidate du tout", r2.checked, 0);
  eq("toujours un seul événement", events.length, 1);
}

console.log("\n── Sélection : qui est candidat");
{
  reset([
    task({ id: "ok", calendar_event_id: "e1", calendar_id: CAL, sync_status: "synced" }),
    task({ id: "sans-date", due_date: null }),
    task({ id: "cat-inconnue", category: "zzz" }),
    task({ id: "en-erreur", sync_status: "error" }),
    task({ id: "synced-sans-id", sync_status: "synced", calendar_event_id: null }),
  ]);
  const r = await reconcileCalendarSync();
  eq("seules les tâches miroir au miroir douteux",
     r.details.map((d) => d.id).sort(), ["en-erreur", "synced-sans-id"]);
  eq("une tâche déjà synced n'est pas touchée", r.details.some((d) => d.id === "ok"), false);
  eq("hors périmètre ignoré", r.details.some((d) => ["sans-date", "cat-inconnue"].includes(d.id)), false);
}

console.log("\n── Google non lié : rien du tout");
{
  reset([task({ id: "t-neuf" })]);
  const saved = google.calendar;
  google.calendar = () => { throw new Error("ne devrait pas être appelé"); };
  H.setAuth(null);
  const r = await reconcileCalendarSync();
  eq("checked = 0 et une note", [r.checked, !!r.note], [0, true]);
  eq("aucun appel", calls, []);
  google.calendar = saved; H.setAuth({ refresh_token: "rt" });
}

// ── L'endpoint ───────────────────────────────────────────────
// On tape sur le vrai serveur HTTP démarré par l'import de server.js.
console.log("\n── POST /api/calendar/reconcile");
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/calendar/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
{
  reset([task({ id: "t-neuf", title: "Jamais créée" })]);
  const r = await post(undefined);
  eq("sans corps → dry-run", [r.status, r.json.executed], [200, false]);
  eq("sans corps → aucune écriture", writes(), []);
}
{
  reset([task({ id: "t-neuf" })]);
  const r = await post({});
  eq("corps vide → dry-run", r.json.executed, false);
  eq("corps vide → aucune écriture", writes(), []);
}
// Les valeurs piégeuses : truthy mais pas le booléen true.
for (const v of ["true", "false", 1, "1", {}, [], "execute"]) {
  reset([task({ id: "t-neuf" })]);
  const r = await post({ execute: v });
  eq(`execute: ${JSON.stringify(v)} → reste en dry-run`, r.json.executed, false);
  eq(`execute: ${JSON.stringify(v)} → aucune écriture`, writes(), []);
}
{
  reset([task({ id: "t-neuf" })]);
  const r = await post({ execute: true });
  eq("execute: true (booléen) → mode réel", r.json.executed, true);
  eq("un événement créé", calls.filter((c) => c.op === "insert").length, 1);
  eq("résumé du mode réel", [r.json.checked, r.json.inserted, r.json.stillFailing], [1, 1, 0]);
}
{
  reset([task({ id: "t-neuf", title: "Jamais créée" })]);
  const r = await post({});
  eq("le détail par tâche est bien renvoyé au client",
     r.json.details.map((d) => [d.id, d.title, d.action]), [["t-neuf", "Jamais créée", "insert"]]);
}

// ── Verrou de concurrence ────────────────────────────────────
console.log("\n── Deux passes simultanées");
{
  reset([task({ id: "t-neuf" })]);
  let ouvrir;
  gate = new Promise((r) => { ouvrir = r; });      // bloque la 1re passe dans events.list
  const premiere = reconcileCalendarSync({ execute: true });
  await new Promise((r) => setImmediate(r));        // laisse la 1re entrer dans le verrou
  const seconde = await reconcileCalendarSync({ execute: true });
  eq("la 2e passe est refusée, pas exécutée", [seconde.busy, seconde.executed], [true, false]);
  eq("la 2e ne touche à rien", seconde.checked, 0);
  ouvrir();
  const p1 = await premiere;
  eq("la 1re passe aboutit normalement", [p1.executed, p1.inserted], [true, 1]);
  eq("UN SEUL événement malgré les deux appels", events.length, 1);
  eq("un seul insert", calls.filter((c) => c.op === "insert").length, 1);
}
{
  // Le verrou est relâché quoi qu'il arrive.
  reset([task({ id: "t-neuf" })]);
  const r = await reconcileCalendarSync();
  eq("après la passe précédente, le verrou est libre", r.busy, undefined);
}
{
  // Relâché même si la passe lève.
  reset([task({ id: "t-boum" })]);
  const saved = google.calendar;
  google.calendar = () => { throw new Error("panne"); };
  let leve = false;
  try { await reconcileCalendarSync(); } catch { leve = true; }
  google.calendar = saved;
  const apres = await reconcileCalendarSync();
  eq("verrou relâché après une exception", [leve, apres.busy], [true, undefined]);
}

console.log("\n── Le verrou refusé est journalisé");
{
  reset([task({ id: "t-neuf" })]);
  let ouvrir;
  gate = new Promise((r) => { ouvrir = r; });
  const premiere = reconcileCalendarSync({ execute: true });
  await new Promise((r) => setImmediate(r));
  // Capture uniquement pendant le refus.
  const vraiLog = console.log, vraiErr = console.error;
  const lignes = [];
  const grab = (...a) => lignes.push(a.map(String).join(" "));
  console.log = grab; console.error = grab;
  const seconde = await reconcileCalendarSync({ execute: true });
  console.log = vraiLog; console.error = vraiErr;
  const busy = lignes.filter((l) => l.startsWith("[sync] {")).map((l) => JSON.parse(l.slice(7)))
                     .find((l) => l.status === "busy");
  eq("le refus produit une ligne « busy »", !!busy, true);
  eq("elle nomme l'opération", busy && busy.operation, "reconcile");
  eq("et porte un horodatage", !!(busy && busy.timestamp), true);
  eq("le refus est bien signalé à l'appelant", seconde.busy, true);
  ouvrir(); await premiere;
}

console.log("\n── L'endpoint traduit le verrou en 409");
{
  reset([task({ id: "t-neuf" })]);
  let ouvrir;
  gate = new Promise((r) => { ouvrir = r; });
  const premiere = post({ execute: true });
  await new Promise((r) => setImmediate(r));
  const vraiLog = console.log, vraiErr = console.error;
  const journal = [];
  const grab = (...a) => journal.push(a.map(String).join(" "));
  console.log = grab; console.error = grab;
  const seconde = await post({ execute: true });
  console.log = vraiLog; console.error = vraiErr;
  eq("409, pas 200 — la demande n'a PAS été traitée", seconde.status, 409);
  eq("le log « busy » a été écrit AVANT que la réponse arrive",
     journal.some((l) => l.startsWith("[sync] {") && JSON.parse(l.slice(7)).status === "busy"), true);
  eq("le client sait pourquoi", /déjà en cours/.test(seconde.json.note || ""), true);
  ouvrir();
  await premiere;
  eq("un seul événement", events.length, 1);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
