// ─────────────────────────────────────────────────────────────
//  Dates des tâches. Extraites de Tasks.jsx pour être testables :
//  un module .jsx ne s'importe pas depuis un test node, et ces règles
//  (glissement de fuseau, plage début → échéance, validation du début)
//  méritent d'être vérifiées plutôt que relues.
// ─────────────────────────────────────────────────────────────
import { dayIn, today } from "../day.js";

// Le jour tel qu'il est STOCKÉ, lu à même la chaîne ISO. Sert à remplir le
// champ date du formulaire, qui doit rendre exactement ce qui a été
// enregistré. Pour juger d'un retard ou comparer à aujourd'hui, c'est dayIn
// (day.js) qu'il faut — voir isLate.
export const dayOf = (iso) => (iso || "").slice(0, 10);
export const localInput = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export function humanDate(task) {
  if (!task.dueDate) return "";
  const d = new Date(task.dueDate);
  if (task.dueAllDay) {
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  }
  return d.toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
// Plage « début → échéance ». Le mois n'est rappelé sur le début que s'il
// diffère de celui de l'échéance : « 7 → 10 sept », mais « 28 sept → 2 oct ».
export function humanRange(task) {
  const fin = humanDate(task);
  if (!task.startDate || !task.dueDate) return fin;
  const debut = new Date(task.startDate + "T00:00:00.000Z");
  const memeMois = task.startDate.slice(0, 7) === dayIn(task.dueDate).slice(0, 7);
  const opts = memeMois
    ? { weekday: "short", day: "numeric", timeZone: "UTC" }
    : { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" };
  return debut.toLocaleDateString("fr-FR", opts) + " → " + fin;
}

// Les deux mêmes règles que le serveur, dites une fois : un début n'a de
// sens qu'avec une échéance, et il ne peut pas la dépasser. Renvoie le
// message à afficher, ou null. Le serveur revalide de toute façon — ceci
// évite juste d'envoyer une requête vouée au 400.
export function startProblem(start, dueDay) {
  if (!start) return null;
  if (!dueDay) return "Ajoute une échéance : un début seul n’a pas de sens.";
  if (start > dueDay) return "Le début ne peut pas être après l’échéance.";
  return null;
}

// « En retard » se juge sur le MÊME jour que les notifications : day.js est
// la source commune aux deux. Sans ça, entre minuit et 2 h à Paris, une
// carte pouvait afficher « ⚠ en retard » sans que la tâche soit dans overdue
// côté serveur. dayIn des deux côtés de la comparaison : l'échéance ET
// aujourd'hui doivent se lire dans le même fuseau.
export const isLate = (task, now) => task.status !== "fait" && !!task.dueDate && dayIn(task.dueDate) < today(now);
