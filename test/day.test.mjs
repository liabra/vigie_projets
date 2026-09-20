// Source unique du « jour ». C'est ici que se joue le bug qu'on corrige :
// à 00 h 30 heure de Paris, UTC est encore la veille.
import { dayIn, today, addDays, APP_TIMEZONE } from "../day.js";
import { isLate } from "../src/dates.js";
import { classifyTasks } from "../notifications.js";

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};

console.log("── Le fuseau de référence");
eq("Europe/Paris, pas UTC", APP_TIMEZONE, "Europe/Paris");

console.log("\n── La fenêtre où UTC se trompait");
// 2026-09-19T22:14Z = 2026-09-20 00:14 à Paris. C'est l'instant exact où
// l'aperçu annonçait « aujourd'hui = 19 » alors qu'on était le 20.
{
  const instant = new Date("2026-09-19T22:14:00.000Z");
  eq("UTC dirait la veille", instant.toISOString().slice(0, 10), "2026-09-19");
  eq("Paris dit le bon jour", today(instant), "2026-09-20");
}
eq("21:59 UTC en été → encore la veille à Paris", today(new Date("2026-07-15T21:59:00.000Z")), "2026-07-15");
eq("22:00 UTC en été → minuit pile à Paris", today(new Date("2026-07-15T22:00:00.000Z")), "2026-07-16");
eq("22:59 UTC en hiver → encore la veille", today(new Date("2026-01-15T22:59:00.000Z")), "2026-01-15");
eq("23:00 UTC en hiver → minuit pile", today(new Date("2026-01-15T23:00:00.000Z")), "2026-01-16");

console.log("\n── Changements d'heure, sans intervention");
// Été 2026 : du 29 mars au 25 octobre. La bascule doit être automatique.
eq("veille du passage à l'heure d'été (UTC+1)", dayIn("2026-03-28T23:30:00.000Z"), "2026-03-29");
eq("lendemain du passage (UTC+2)", dayIn("2026-03-29T23:30:00.000Z"), "2026-03-30");
eq("veille du retour à l'heure d'hiver (UTC+2)", dayIn("2026-10-24T23:30:00.000Z"), "2026-10-25");
eq("lendemain du retour (UTC+1)", dayIn("2026-10-25T23:30:00.000Z"), "2026-10-26");
eq("23:30 UTC bascule le jour en été", dayIn("2026-07-01T23:30:00.000Z"), "2026-07-02");
eq("23:30 UTC bascule aussi en hiver", dayIn("2026-12-01T23:30:00.000Z"), "2026-12-02");

console.log("\n── Les échéances « journée entière » gardent leur jour");
// Rangées à minuit UTC : à Paris c'est 1 h ou 2 h du matin, même jour.
for (const j of ["2026-01-15", "2026-03-29", "2026-07-01", "2026-10-25", "2026-12-31"]) {
  eq(`${j} reste ${j}`, dayIn(j + "T00:00:00.000Z"), j);
}

console.log("\n── Entrées limites");
eq("date invalide → chaîne vide", dayIn("pas une date"), "");
// new Date(null) vaut l'epoch : sans garde, une échéance absente
// ressortirait « en retard depuis 1970 ».
eq("null → chaîne vide, PAS 1970-01-01", dayIn(null), "");
eq("undefined → chaîne vide", dayIn(undefined), "");
eq("chaîne vide → chaîne vide", dayIn(""), "");
eq("un objet Date est accepté", dayIn(new Date("2026-09-20T12:00:00.000Z")), "2026-09-20");

console.log("\n── Arithmétique des jours");
eq("fin de mois", addDays("2026-09-30", 2), "2026-10-02");
eq("fin d'année", addDays("2026-12-31", 1), "2027-01-01");
eq("29 février", addDays("2028-02-28", 1), "2028-02-29");
eq("le passage à l'heure d'été n'avance ni ne retarde", addDays("2026-03-28", 2), "2026-03-30");
eq("ni le retour à l'heure d'hiver", addDays("2026-10-24", 2), "2026-10-26");

console.log("\n── L'INVARIANT : carte et notifications ne peuvent pas diverger");
// Le contrat du correctif : isLate(tâche) ⟺ la tâche est dans overdue.
{
  const t = (id, due, status = "a_faire") => ({ id, title: id, status, urgency: "normale",
    due_date: due, dueDate: due, category: "dev" });
  const instants = [
    ["00:14 à Paris (UTC la veille)", new Date("2026-09-19T22:14:00.000Z")],
    ["midi",                          new Date("2026-09-20T10:00:00.000Z")],
    ["23:30 UTC (déjà demain)",       new Date("2026-09-20T23:30:00.000Z")],
    ["hiver, 23:30 UTC",              new Date("2026-01-15T23:30:00.000Z")],
  ];
  const taches = [
    t("veille", "2026-09-19T00:00:00.000Z"), t("jour", "2026-09-20T00:00:00.000Z"),
    t("lendemain", "2026-09-21T00:00:00.000Z"), t("janv-15", "2026-01-15T00:00:00.000Z"),
    t("janv-16", "2026-01-16T00:00:00.000Z"), t("faite", "2026-01-01T00:00:00.000Z", "fait"),
  ];
  let divergences = 0;
  for (const [label, now] of instants) {
    const r = classifyTasks(taches, today(now));
    const enRetardServeur = new Set(r.overdue.map((x) => x.id));
    for (const tache of taches) {
      const carte = isLate(tache, now);
      if (carte !== enRetardServeur.has(tache.id)) {
        divergences++;
        console.log(`        divergence à ${label} sur ${tache.id} : carte=${carte}, serveur=${enRetardServeur.has(tache.id)}`);
      }
    }
    eq(`${label} : carte et serveur d'accord sur les ${taches.length} tâches`, divergences, 0);
  }
  // Et la preuve que le test mord : avec l'ancienne règle UTC, ça divergeait.
  const ancienIsLate = (task, now) =>
    task.status !== "fait" && !!task.dueDate && task.dueDate.slice(0, 10) < now.toISOString().slice(0, 10);
  const minuitPassé = new Date("2026-09-19T22:14:00.000Z");
  const serveur = new Set(classifyTasks(taches, today(minuitPassé)).overdue.map((x) => x.id));
  eq("l'ancienne règle UTC, elle, divergeait bien",
     taches.some((x) => ancienIsLate(x, minuitPassé) !== serveur.has(x.id)), true);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
