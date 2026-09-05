// Repère de jour de début : best-effort, isolé du pipeline de due_date.
// Faux client Calendar : chaque appel est journalisé, rien ne sort.
process.env.NODE_ENV = "test";
process.env.PORT = "3991";
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.GOOGLE_REDIRECT_URI = "https://x.test/oauth/callback";

const { google } = await import("googleapis");
const CAL = "vigie@group.calendar.google.com";
let calls = [], events = [], seq = 0, fail = {};
google.calendar = () => ({
  calendars: { insert: async () => ({ data: { id: CAL } }) },
  events: {
    insert: async (a) => {
      const rep = /^Début : /.test(a.requestBody.summary);
      calls.push({ op: "insert", repere: rep, cal: a.calendarId, summary: a.requestBody.summary,
                   start: a.requestBody.start, end: a.requestBody.end,
                   marker: a.requestBody.extendedProperties?.private?.vigieTaskId });
      if (rep && fail.insert) throw fail.insert;
      const ev = { id: (rep ? "start-" : "evt-") + ++seq };
      events.push(ev); return { data: ev };
    },
    update: async (a) => {
      const rep = /^Début : /.test(a.requestBody.summary);
      calls.push({ op: "update", repere: rep, cal: a.calendarId, id: a.eventId,
                   marker: a.requestBody.extendedProperties?.private?.vigieTaskId });
      if (rep && fail.update) throw fail.update;
      return { data: { id: a.eventId } };
    },
    delete: async (a) => {
      calls.push({ op: "delete", cal: a.calendarId, id: a.eventId });
      if (fail.delete && String(a.eventId).startsWith("start-")) throw fail.delete;
      return {};
    },
    list: async () => ({ data: { items: [] } }),
  },
});

const srv = await import("../server.js");
const H = srv.__testHooks;

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:3991${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const reset = () => {
  calls = []; events = []; seq = 0; fail = {};
  H.setTasks([]); H.setAuth({ refresh_token: "rt" }); H.setSetting("google_calendar_id", CAL);
};
const reperes = () => calls.filter((c) => c.repere || String(c.id || "").startsWith("start-"));

console.log("── Création avec un début");
{
  reset();
  const { json } = await api("POST", "/api/tasks", { title: "Dossier", category: "dev", dueDate: "2026-09-10", startDate: "2026-09-07" });
  const r = reperes();
  eq("un repère créé", r.map((c) => c.op), ["insert"]);
  eq("titre explicite", r[0].summary, "Début : Dossier");
  eq("journée entière sur le jour de début", [r[0].start, r[0].end], [{ date: "2026-09-07" }, { date: "2026-09-08" }]);
  eq("MÊME agenda que l'échéance", r[0].cal, CAL);
  eq("AUCUN marqueur vigieTaskId sur le repère", r[0].marker, undefined);
  eq("l'événement d'échéance, lui, en porte un",
     calls.find((c) => c.op === "insert" && !c.repere).marker, json.task.id);
  eq("l'échéance reste parfaitement synchronisée", json.task.syncStatus, "synced");
  // La paire se lit d'un coup d'œil dans l'agenda.
  eq("les deux événements forment une paire lisible",
     [calls.find((c) => c.op === "insert" && !c.repere).summary, r[0].summary],
     ["Fin : Dossier", "Début : Dossier"]);
}

console.log("\n── Sans début : rien de plus qu'avant");
{
  reset();
  await api("POST", "/api/tasks", { title: "Simple", category: "dev", dueDate: "2026-09-10" });
  eq("aucun appel de repère", reperes(), []);
  eq("un seul insert au total", calls.filter((c) => c.op === "insert").length, 1);
}

console.log("\n── Déplacement, retrait, suppression");
{
  reset();
  const { json } = await api("POST", "/api/tasks", { title: "T", category: "dev", dueDate: "2026-09-20", startDate: "2026-09-15" });
  const id = json.task.id;
  calls = [];
  await api("PATCH", `/api/tasks/${id}`, { startDate: "2026-09-17" });
  eq("début déplacé → update du repère existant", reperes().map((c) => [c.op, c.id]), [["update", "start-2"]]);

  calls = [];
  const apres = await api("PATCH", `/api/tasks/${id}`, { startDate: null });
  eq("début retiré → suppression du repère", reperes().map((c) => c.op), ["delete"]);
  eq("l'id est effacé en base", H.tasks()[0].start_event_id, null);
  eq("la tâche reste synchronisée", apres.json.task.syncStatus, "synced");

  calls = [];
  await api("PATCH", `/api/tasks/${id}`, { startDate: "2026-09-18" });
  eq("un début redonné → nouveau repère", reperes().map((c) => c.op), ["insert"]);

  calls = [];
  await api("DELETE", `/api/tasks/${id}`);
  eq("tâche supprimée → les DEUX événements partent",
     calls.filter((c) => c.op === "delete").length, 2);
}

console.log("\n── Échec du repère : la tâche n'en souffre jamais");
{
  reset();
  fail.insert = Object.assign(new Error("Bad Request"), { code: 400 });
  const { json } = await api("POST", "/api/tasks", { title: "T", category: "dev", dueDate: "2026-09-10", startDate: "2026-09-07" });
  eq("la requête aboutit", json.task.startDate, "2026-09-07");
  eq("sync_status INTACT malgré l'échec du repère", json.task.syncStatus, "synced");
  eq("aucune erreur de synchro sur la tâche", json.task.syncError, null);
  eq("l'événement d'échéance existe bien", !!json.task.calendarEventId, true);
  eq("aucun id de repère stocké", H.tasks()[0].start_event_id, null);
}
{
  // Le cas qui compte : retrait dont la suppression échoue. L'id doit
  // disparaître quand même, sinon plus rien ne pourra le nettoyer.
  reset();
  const { json } = await api("POST", "/api/tasks", { title: "T", category: "dev", dueDate: "2026-09-20", startDate: "2026-09-15" });
  eq("repère bien créé au départ", H.tasks()[0].start_event_id, "start-2");
  fail.delete = Object.assign(new Error("Server Error"), { code: 500 });
  const apres = await api("PATCH", `/api/tasks/${json.task.id}`, { startDate: null });
  eq("l'id est effacé MALGRÉ l'échec de suppression", H.tasks()[0].start_event_id, null);
  eq("sync_status toujours intact", apres.json.task.syncStatus, "synced");
}

console.log("\n── La réconciliation ignore totalement le repère");
{
  reset();
  // Trois tâches avec un début, dont la synchro d'échéance est saine.
  H.setTasks([
    { id: "t-1", title: "A", category: "dev", status: "a_faire", due_date: "2026-09-20T00:00:00.000Z",
      due_all_day: true, urgency: "normale", calendar_event_id: "evt-1", calendar_id: CAL,
      sync_status: "synced", sync_error: null, last_sync_attempt: null,
      start_date: "2026-09-15", start_event_id: "start-1", created_at: new Date(), updated_at: new Date() },
    // Repère manquant, mais échéance saine : ne DOIT PAS être candidate.
    { id: "t-2", title: "B", category: "dev", status: "a_faire", due_date: "2026-09-20T00:00:00.000Z",
      due_all_day: true, urgency: "normale", calendar_event_id: "evt-2", calendar_id: CAL,
      sync_status: "synced", sync_error: null, last_sync_attempt: null,
      start_date: "2026-09-15", start_event_id: null, created_at: new Date(), updated_at: new Date() },
  ]);
  const r = await srv.reconcileCalendarSync();
  eq("aucune tâche retenue : le repère n'entre pas dans le critère", r.checked, 0);
  eq("aucun appel Calendar", calls, []);

  // Et le détail renvoyé ne parle jamais du repère.
  const rendu = JSON.stringify(r);
  eq("le résumé n'expose ni start_date ni start_event_id",
     /start_date|start_event_id|startDate|startEventId/.test(rendu), false);
}
{
  // Une tâche vraiment en échec sur son échéance reste, elle, candidate —
  // et sa réparation ne touche pas au repère.
  reset();
  H.setTasks([
    { id: "t-3", title: "C", category: "dev", status: "a_faire", due_date: "2026-09-20T00:00:00.000Z",
      due_all_day: true, urgency: "normale", calendar_event_id: null, calendar_id: null,
      sync_status: "error", sync_error: "boum", last_sync_attempt: null,
      start_date: "2026-09-15", start_event_id: "start-9", created_at: new Date(), updated_at: new Date() },
  ]);
  const r = await srv.reconcileCalendarSync({ execute: true });
  eq("candidate à cause de l'ÉCHÉANCE, pas du début", [r.checked, r.inserted], [1, 1]);
  eq("le repère existant n'est pas touché", H.tasks()[0].start_event_id, "start-9");
  eq("aucun appel ne vise le repère", calls.filter((c) => c.repere || String(c.id || "").startsWith("start-")), []);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
