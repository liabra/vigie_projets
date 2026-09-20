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

// Jour de référence : celui de day.js, partagé avec l'affichage des cartes
// (isLate, src/dates.js). C'est ce partage qui garantit qu'une tâche ne peut
// pas être « en retard » d'un côté et pas de l'autre.
import { dayIn as dayOf, today, addDays, APP_TIMEZONE } from "./day.js";
export { dayOf, today, addDays, APP_TIMEZONE };

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
export function classifyTasks(tasks, jour = today(), soonDays = DUE_SOON_DAYS) {
  const horizon = addDays(jour, soonDays);
  const overdue = [], dueToday = [], dueSoon = [];

  for (const t of tasks || []) {
    if (!t || t.status === DONE_STATUS || !t.due_date) continue;
    const jourTache = dayOf(t.due_date);
    if (jourTache < jour) overdue.push(t);
    else if (jourTache === jour) dueToday.push(t);
    else if (jourTache <= horizon) dueSoon.push(t);
    // Au-delà de l'horizon : rien à signaler aujourd'hui.
  }

  // Par échéance croissante : les plus anciennes en tête des retards, les
  // plus proches en tête de « bientôt ». À échéance égale, par titre, pour
  // que deux appels successifs rendent le même ordre.
  const parEcheance = (a, b) =>
    new Date(a.due_date) - new Date(b.due_date) || String(a.title).localeCompare(String(b.title), "fr");

  return {
    today: jour,
    timeZone: APP_TIMEZONE,
    horizon,
    soonDays,
    overdue: overdue.sort(parEcheance).map(toJson),
    dueToday: dueToday.sort(parEcheance).map(toJson),
    dueSoon: dueSoon.sort(parEcheance).map(toJson),
  };
}
