// Dates des tâches côté client : plage, validation du début, et surtout
// l'absence de glissement de fuseau. Joué sous un fuseau EN AVANCE sur UTC
// (Europe/Paris) — c'est là que les bugs de jour se révèlent.
import { dayOf, humanDate, humanRange, isLate, startProblem } from "../src/dates.js";

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const t = (o = {}) => ({ title: "T", status: "a_faire", dueAllDay: true, ...o });

console.log("── Validation du début (mêmes règles que le serveur)");
eq("pas de début → rien à signaler", startProblem("", "2026-09-10"), null);
eq("début sans échéance → refusé", startProblem("2026-09-07", ""), "Ajoute une échéance : un début seul n’a pas de sens.");
eq("début après échéance → refusé", startProblem("2026-09-11", "2026-09-10"), "Le début ne peut pas être après l’échéance.");
eq("début = échéance → accepté", startProblem("2026-09-10", "2026-09-10"), null);
eq("début avant échéance → accepté", startProblem("2026-09-07", "2026-09-10"), null);
eq("comparaison lexicale sûre d'un mois à l'autre", startProblem("2026-09-30", "2026-10-01"), null);
eq("… et d'une année à l'autre", startProblem("2026-12-31", "2027-01-02"), null);

console.log("\n── Plage affichée");
eq("sans début → l'échéance seule, comme avant",
   humanRange(t({ dueDate: "2026-09-10T00:00:00.000Z" })), humanDate(t({ dueDate: "2026-09-10T00:00:00.000Z" })));
eq("même mois → le mois n'est pas répété",
   humanRange(t({ dueDate: "2026-09-10T00:00:00.000Z", startDate: "2026-09-07" })), "lun. 7 → jeu. 10 sept.");
eq("mois différents → le mois est rappelé",
   humanRange(t({ dueDate: "2026-10-02T00:00:00.000Z", startDate: "2026-09-28" })), "lun. 28 sept. → ven. 2 oct.");
eq("début = échéance → une plage d'un jour",
   humanRange(t({ dueDate: "2026-09-10T00:00:00.000Z", startDate: "2026-09-10" })), "jeu. 10 → jeu. 10 sept.");
eq("un début sans échéance ne montre rien (état impossible, mais sans plantage)",
   humanRange(t({ startDate: "2026-09-07" })), "");
{
  // Une échéance horaire reste rendue exactement comme avant — en heure
  // LOCALE, contrairement au début qui est un jour, donc lu en UTC.
  const horaire = t({ dueDate: "2026-09-10T09:00:00.000Z", dueAllDay: false, startDate: "2026-09-07" });
  eq("échéance horaire : la plage = début + le rendu existant",
     humanRange(horaire), "lun. 7 → " + humanDate(horaire));
  eq("et l'heure y figure bien", /\d{1,2}:\d{2}/.test(humanRange(horaire)), true);
}

console.log("\n── Aucun glissement de fuseau");
eq("le 1er du mois reste le 1er",
   humanRange(t({ dueDate: "2026-09-03T00:00:00.000Z", startDate: "2026-09-01" })), "mar. 1 → jeu. 3 sept.");
eq("passage d'année : 31 déc → 2 janv",
   humanRange(t({ dueDate: "2027-01-02T00:00:00.000Z", startDate: "2026-12-31" })), "jeu. 31 déc. → sam. 2 janv.");
eq("dayOf ne décale pas", dayOf("2026-09-07T00:00:00.000Z"), "2026-09-07");

console.log("\n── Le retard reste jugé sur l'échéance, pas sur le début");
eq("échéance passée → en retard", isLate(t({ dueDate: "2020-01-01T00:00:00.000Z", startDate: "2019-12-01" })), true);
eq("échéance à venir, début passé → PAS en retard",
   isLate(t({ dueDate: "2099-01-01T00:00:00.000Z", startDate: "2020-01-01" })), false);
eq("une tâche faite n'est jamais en retard",
   isLate(t({ status: "fait", dueDate: "2020-01-01T00:00:00.000Z", startDate: "2019-12-01" })), false);

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
