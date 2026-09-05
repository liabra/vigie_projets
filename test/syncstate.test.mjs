// Règle de mise à jour de sync_status. La transition est une fonction pure :
// on la teste sans Google ni base.
process.env.PORT = "0";
process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.GOOGLE_REDIRECT_URI = "https://x.test/oauth/callback";
const { shouldMirror, applySyncOutcome } = await import("../server.js");
const { createGoogle } = await import("../google.js");
const { google } = await import("googleapis");

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const T = new Date("2026-09-05T10:00:00.000Z");
const task = (o = {}) => ({ id: "t-1", category: "dev", due_date: "2026-09-15T00:00:00.000Z",
  calendar_event_id: null, calendar_id: null, sync_status: "pending", sync_error: null, last_sync_attempt: null, ...o });
const state = (t) => [t.sync_status, t.calendar_event_id, t.sync_error === null ? null : "…", t.last_sync_attempt];

console.log("── « Doit être miroir »");
for (const c of ["perso", "admin", "dev", "boulot"]) eq(`${c} avec échéance → miroir`, shouldMirror(task({ category: c })), true);
eq("sans échéance → PAS miroir", shouldMirror(task({ due_date: null })), false);
eq("catégorie inconnue → PAS miroir", shouldMirror(task({ category: "zzz" })), false);
eq("ni l'un ni l'autre → PAS miroir", shouldMirror(task({ due_date: null, category: "zzz" })), false);

console.log("\n── Succès : 'synced' exige un event_id");
{
  const t = applySyncOutcome(task(), { eventId: "evt-1", calendarId: "cal-A" }, T);
  eq("insert réussi → synced + couple stocké", state(t), ["synced", "evt-1", null, T]);
  eq("calendar_id conservé", t.calendar_id, "cal-A");
}
{
  // Adoption via marqueur : même chemin, même résultat.
  const t = applySyncOutcome(task({ sync_status: "error", sync_error: "vieille erreur" }),
                             { eventId: "evt-adopte", calendarId: "cal-A", adopted: true }, T);
  eq("adoption via marqueur → synced, erreur effacée", state(t), ["synced", "evt-adopte", null, T]);
}
{
  // Événement supprimé (échéance retirée) : pas d'event_id → pending, PAS error.
  const t = applySyncOutcome(task({ due_date: null, calendar_event_id: "evt-1", sync_status: "synced" }),
                             { eventId: null, calendarId: null }, T);
  eq("échéance retirée → pending, jamais synced sans event_id", state(t), ["pending", null, null, T]);
}
{
  const t = applySyncOutcome(task(), { eventId: null, calendarId: "cal-A" }, T);
  eq("succès SANS event_id → jamais 'synced'", t.sync_status, "pending");
}

console.log("\n── Échec définitif");
{
  const t = applySyncOutcome(task(), { error: new Error("events.insert : Premature close") }, T);
  eq("tâche miroir en échec → error", t.sync_status, "error");
  eq("message exploitable, pas « Error »", t.sync_error, "events.insert : Premature close");
  eq("dernière tentative horodatée", t.last_sync_attempt, T);
}
{
  const scope = Object.assign(new Error("insufficient authentication scopes"), { code: 403 });
  const t = applySyncOutcome(task(), { error: scope }, T);
  eq("403 de scopes → message actionnable", /reconnecter l'agenda/i.test(t.sync_error), true);
}
{
  const t = applySyncOutcome(task(), { error: new Error("") }, T);
  eq("erreur vide → message de repli, jamais vide", t.sync_error, "Échec inconnu de la synchro agenda");
}
{
  const t = applySyncOutcome(task(), { error: new Error("x".repeat(900)) }, T);
  eq("message tronqué à 500", t.sync_error.length, 500);
}

console.log("\n── Hors périmètre : 'pending', JAMAIS 'error'");
for (const [label, o] of [
  ["sans échéance", { due_date: null }],
  ["catégorie sans mapping", { category: "zzz" }],
  ["les deux", { due_date: null, category: "zzz" }],
]) {
  const t = applySyncOutcome(task(o), { error: new Error("events.delete : boom") }, T);
  eq(`${label} + échec → reste 'pending'`, t.sync_status, "pending");
  eq(`${label} → l'échec est tout de même consigné`, t.sync_error, "events.delete : boom");
}

console.log("\n── Échéance retirée + suppression Google en échec");
// Le cas concret : la tâche n'a plus d'échéance, donc son événement doit
// disparaître — mais Google refuse la suppression. L'événement traîne dans
// l'agenda : vraie désync. La tâche n'étant plus miroir, elle reste
// 'pending' (jamais 'error'), et le message d'échec est conservé.
// Monté sur la vraie chaîne : c'est gcal.syncTask qui produit l'erreur.
{
  const CAL = "vigie@group.calendar.google.com";
  const calls = [];
  google.calendar = () => ({
    calendars: { insert: async () => ({ data: { id: CAL } }) },
    events: {
      // 400 : définitif, donc aucun rejeu — l'échec est immédiat.
      delete: async (a) => {
        calls.push(["delete", a.calendarId, a.eventId]);
        throw Object.assign(new Error("Invalid resource id"), { code: 400 });
      },
      insert: async () => { calls.push(["insert"]); return { data: { id: "ne-devrait-pas-arriver" } }; },
      update: async () => { calls.push(["update"]); return { data: { id: "x" } }; },
      list: async () => { calls.push(["list"]); return { data: { items: [] } }; },
    },
  });
  const gcal = createGoogle({
    loadAuth: async () => ({ refresh_token: "rt" }), saveAuth: async () => {},
    getSetting: async (k) => (k === "google_calendar_id" ? CAL : null), setSetting: async () => {},
  }, { sleep: async () => {} });

  // Tâche jadis synchronisée, dont on vient de retirer l'échéance.
  const t = task({ due_date: null, calendar_event_id: "evt-1", calendar_id: CAL, sync_status: "synced" });
  let caught = null;
  try { await gcal.syncTask(t); } catch (e) { caught = e; }

  eq("Google a bien été sollicité pour supprimer, sur le couple stocké", calls, [["delete", CAL, "evt-1"]]);
  eq("aucun insert ni update de compensation", calls.some((c) => c[0] === "insert" || c[0] === "update"), false);
  eq("l'échec remonte", !!caught, true);

  applySyncOutcome(t, { error: caught }, T);
  eq("statut : reste 'pending' — la tâche n'est plus miroir", t.sync_status, "pending");
  eq("jamais 'error' sur une tâche hors périmètre", t.sync_status === "error", false);
  eq("sync_error porte le message d'échec réel", t.sync_error, "events.delete : Invalid resource id");
  eq("tentative horodatée", t.last_sync_attempt, T);
  eq("le couple reste en base : l'événement existe encore côté Google", [t.calendar_event_id, t.calendar_id], ["evt-1", CAL]);
}

console.log("\n── Aucune tentative : l'état n'est pas touché");
{
  const before = task({ sync_status: "synced", calendar_event_id: "evt-1", last_sync_attempt: null });
  const t = applySyncOutcome(before, { skipped: true }, T);
  eq("skipped → état inchangé, pas d'horodatage", state(t), ["synced", "evt-1", null, null]);
}
{
  // Une tâche déjà 'synced' que Google ne peut pas traiter ne régresse pas.
  const t = applySyncOutcome(task({ sync_status: "synced", calendar_event_id: "evt-1" }), { skipped: true }, T);
  eq("pas de régression sur une tâche déjà synced", t.sync_status, "synced");
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
