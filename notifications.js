// ─────────────────────────────────────────────────────────────
//  Détection des tâches à notifier.
//
//  Pur calcul : ce module ne lit pas la base, n'envoie rien, et ne connaît
//  ni le service worker ni les abonnements. On lui passe des tâches et un
//  jour de référence, il rend trois listes. C'est ce qui le rend testable
//  sans serveur ni horloge truquée.
// ─────────────────────────────────────────────────────────────

// Fenêtre « bientôt » : J+1 jusqu'à J+N inclus. Deux jours pour commencer,
// à ajuster une fois qu'on aura vu le volume réel de notifications.
export const DUE_SOON_DAYS = 2;

// Une tâche faite n'a plus rien à signaler.
const DONE_STATUS = "fait";

// Les échéances « journée entière » sont rangées à minuit UTC (voir
// parseDue dans server.js), et le front juge le retard sur le jour UTC lui
// aussi (isLate, src/dates.js). On garde la même référence ici : sinon une
// tâche pourrait s'afficher « en retard » dans l'interface sans figurer
// dans overdue, ou l'inverse.
//
// Conséquence connue : entre minuit et 2 h du matin heure de Paris, le jour
// UTC est encore celui de la veille. Sans importance tant que l'envoi réel
// (étape 3) tourne à une heure ouvrable ; à revoir si on notifie la nuit.
export const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
export const todayUtc = () => new Date().toISOString().slice(0, 10);

// Décalage en jours sur une date « AAAA-MM-JJ », en UTC pour ne pas
// dépendre du fuseau de la machine qui exécute le serveur.
export function addDays(day, n) {
  const d = new Date(day + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Ce qu'on expose d'une tâche : de quoi écrire un message et rien de plus.
const toJson = (t) => ({
  id: t.id,
  title: t.title,
  category: t.category,
  dueDate: t.due_date ? new Date(t.due_date).toISOString() : null,
  dueDay: dayOf(t.due_date),
  urgency: t.urgency || "normale",
});

// Trois listes disjointes. Le chevauchement demandé (overdue > dueToday >
// dueSoon) ne peut pas se produire : une échéance tombe sur UN jour, qui est
// soit avant, soit égal, soit après le jour de référence. L'ordre ci-dessous
// suit quand même cette priorité, pour que la lecture du code le confirme.
export function classifyTasks(tasks, today = todayUtc(), soonDays = DUE_SOON_DAYS) {
  const horizon = addDays(today, soonDays);
  const overdue = [], dueToday = [], dueSoon = [];

  for (const t of tasks || []) {
    if (!t || t.status === DONE_STATUS || !t.due_date) continue;
    const jour = dayOf(t.due_date);
    if (jour < today) overdue.push(t);
    else if (jour === today) dueToday.push(t);
    else if (jour <= horizon) dueSoon.push(t);
    // Au-delà de l'horizon : rien à signaler aujourd'hui.
  }

  // Par échéance croissante : les plus anciennes en tête des retards, les
  // plus proches en tête de « bientôt ». À échéance égale, par titre, pour
  // que deux appels successifs rendent le même ordre.
  const parEcheance = (a, b) =>
    new Date(a.due_date) - new Date(b.due_date) || String(a.title).localeCompare(String(b.title), "fr");

  return {
    today,
    horizon,
    soonDays,
    overdue: overdue.sort(parEcheance).map(toJson),
    dueToday: dueToday.sort(parEcheance).map(toJson),
    dueSoon: dueSoon.sort(parEcheance).map(toJson),
  };
}
