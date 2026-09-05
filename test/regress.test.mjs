// Non-régression du comportement de synchro EXISTANT, après l'ajout du
// rejeu et du marqueur. Faux client Calendar : rien ne sort.
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.GOOGLE_REDIRECT_URI = "https://x.test/oauth/callback";
const { createGoogle, buildEventBody, buildArticleEventBody } = await import("../google.js");
const { google } = await import("googleapis");

const VIGIE = "vigie@group.calendar.google.com";
const ARTS = "vigie-articles@group.calendar.google.com";
let ko = 0, calls = [], seq = 0, created = [];
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
google.calendar = () => ({
  calendars: { insert: async (a) => { created.push(a.requestBody.summary); return { data: { id: a.requestBody.summary.includes("Articles") ? ARTS : VIGIE } }; } },
  events: {
    insert: async (a) => { calls.push({ op: "insert", cal: a.calendarId, summary: a.requestBody.summary, colorId: a.requestBody.colorId, start: a.requestBody.start, end: a.requestBody.end, marker: a.requestBody.extendedProperties?.private?.vigieTaskId }); return { data: { id: "evt-" + ++seq } }; },
    update: async (a) => { calls.push({ op: "update", cal: a.calendarId, id: a.eventId, summary: a.requestBody.summary, colorId: a.requestBody.colorId, marker: a.requestBody.extendedProperties?.private?.vigieTaskId }); return { data: { id: a.eventId } }; },
    delete: async (a) => { calls.push({ op: "delete", cal: a.calendarId, id: a.eventId }); return {}; },
    list: async () => { calls.push({ op: "list" }); return { data: { items: [] } }; },
  },
});
const store = (s = {}) => { const m = new Map(Object.entries(s)); return { map: m,
  loadAuth: async () => ({ refresh_token: "rt" }), saveAuth: async () => {},
  getSetting: async (k) => m.get(k) ?? null, setSetting: async (k, v) => { v === null ? m.delete(k) : m.set(k, v); } }; };
const G = (s) => createGoogle(s ?? store({ google_calendar_id: VIGIE, google_articles_calendar_id: ARTS }), { sleep: async () => {} });
const task = (o = {}) => ({ id: "t-1", title: "Ma tâche", category: "dev", status: "a_faire",
  due_date: "2026-09-15T00:00:00.000Z", due_all_day: true, calendar_event_id: null, calendar_id: null, ...o });
const art = (o = {}) => ({ id: "a-1", title: "Mon article", status: "idee",
  release_date: "2026-09-15T00:00:00.000Z", calendar_event_id: null, calendar_id: null, ...o });
const reset = () => { calls = []; created = []; };

console.log("── Routage par catégorie");
for (const [cat, dest] of [["dev", VIGIE], ["boulot", VIGIE], ["perso", "primary"], ["admin", "primary"]]) {
  reset();
  const r = await G().syncTask(task({ category: cat }));
  eq(`${cat} → ${dest}`, [calls[0].cal, r.calendarId], [dest, dest]);
}

console.log("\n── Bascule d'agenda quand la catégorie change");
reset();
{
  const r = await G().syncTask(task({ category: "perso", calendar_event_id: "evt-old", calendar_id: VIGIE }));
  eq("ancien supprimé sur SON agenda, puis recréé sur primary",
     calls.map((c) => [c.op, c.cal, c.id].filter((x) => x !== undefined)),
     [["delete", VIGIE, "evt-old"], ["insert", "primary"]]);
  eq("nouveau couple renvoyé", r.calendarId, "primary");
}

console.log("\n── Statut, échéance, suppression");
reset();
await G().syncTask(task({ status: "fait", calendar_event_id: "e1", calendar_id: VIGIE }));
eq("fait → ✓ + gris", [calls[0].summary, calls[0].colorId], ["✓ Ma tâche", "8"]);
reset();
await G().syncTask(task({ status: "a_faire", calendar_event_id: "e1", calendar_id: VIGIE }));
eq("retour à faire → ✓ et gris retirés", [calls[0].summary, calls[0].colorId], ["Ma tâche", undefined]);
reset();
{
  const r = await G().syncTask(task({ due_date: null, calendar_event_id: "e1", calendar_id: VIGIE }));
  eq("échéance effacée → événement supprimé", calls.map((c) => c.op), ["delete"]);
  eq("couple vidé", [r.eventId, r.calendarId], [null, null]);
}
reset();
await G().syncTask(task({ due_date: null }));
eq("jamais eu d'échéance → aucun appel", calls, []);

console.log("\n── Journée entière vs horaire");
eq("journée entière", [buildEventBody(task()).start, buildEventBody(task()).end], [{ date: "2026-09-15" }, { date: "2026-09-16" }]);
{
  const b = buildEventBody(task({ due_all_day: false, due_date: "2026-09-15T14:00:00.000Z" }));
  eq("horaire → 30 min", [b.start.dateTime, b.end.dateTime], ["2026-09-15T14:00:00.000Z", "2026-09-15T14:30:00.000Z"]);
}
eq("urgence jamais envoyée à Google", JSON.stringify(buildEventBody(task({ urgency: "urgente" }))).includes("urgen"), false);

console.log("\n── Articles");
reset();
{
  const st = store({ google_calendar_id: VIGIE });
  const g = G(st);
  const r = await g.syncArticle(art());
  eq("agenda « Vigie – Articles » créé", created, ["Vigie – Articles"]);
  eq("id mémorisé sous sa propre clé", st.map.get("google_articles_calendar_id"), ARTS);
  eq("agenda des tâches intact", st.map.get("google_calendar_id"), VIGIE);
  eq("événement sur l'agenda des articles", r.calendarId, ARTS);
}
reset();
await G().syncArticle(art({ status: "en_ligne", calendar_event_id: "e1", calendar_id: ARTS }));
eq("en ligne → ✓ + gris", [calls[0].summary, calls[0].colorId], ["✓ Mon article", "8"]);
eq("article all-day", [buildArticleEventBody(art()).start, buildArticleEventBody(art()).end], [{ date: "2026-09-15" }, { date: "2026-09-16" }]);
eq("fin de mois → 1er octobre", buildArticleEventBody(art({ release_date: "2026-09-30T00:00:00.000Z" })).end, { date: "2026-10-01" });

console.log("\n── Marqueur préservé par les updates");
// Une tâche DÉJÀ synchronisée : chaque modification doit renvoyer le marqueur.
const synced = { calendar_event_id: "evt-9", calendar_id: VIGIE };
for (const [label, patch] of [
  ["titre modifié",     { title: "Titre changé" }],
  ["date modifiée",     { due_date: "2026-10-01T00:00:00.000Z" }],
  ["passage à fait",    { status: "fait" }],
  ["retour à faire",    { status: "a_faire" }],
  ["journée → horaire", { due_all_day: false, due_date: "2026-09-15T14:00:00.000Z" }],
  ["urgence modifiée",  { urgency: "urgente" }],
]) {
  reset();
  await G().syncTask(task({ ...synced, ...patch }));
  eq(`update après ${label} → marqueur présent`, calls[0].marker, "t-1");
  eq(`update après ${label} → toujours un update, pas un insert`, calls[0].op, "update");
}
// Et la bascule d'agenda : l'événement est recréé, le marqueur doit suivre.
reset();
await G().syncTask(task({ ...synced, category: "perso" }));
eq("après bascule d'agenda → marqueur sur le nouvel événement",
   calls.find((c) => c.op === "insert").marker, "t-1");

console.log("\n── Garde-fou");
reset();
await G().removeEvent(null, VIGIE);
eq("suppression sans event_id → aucun appel", calls, []);
reset();
{
  const g = createGoogle({ loadAuth: async () => null, saveAuth: async () => {}, getSetting: async () => null, setSetting: async () => {} }, { sleep: async () => {} });
  const r = await g.syncTask(task());
  eq("sans compte Google → ignoré, aucun appel", [r.skipped, calls.length], [true, 0]);
}
reset();
await G().syncTask(task({ calendar_event_id: "e9", calendar_id: VIGIE }));
eq("update ciblé sur le couple stocké", calls.map((c) => [c.op, c.cal, c.id]), [["update", VIGIE, "e9"]]);
eq("aucune liste sur le chemin nominal", calls.some((c) => c.op === "list"), false);

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
