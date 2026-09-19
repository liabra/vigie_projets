// Détection des tâches à notifier. Fonction pure : aucun serveur, aucune
// horloge truquée — le jour de référence est un paramètre.
import { classifyTasks, addDays, DUE_SOON_DAYS } from "../notifications.js";

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const AUJ = "2026-09-20";
// Une tâche : titre = son échéance, pour que les listes se lisent d'un œil.
const t = (jour, o = {}) => ({
  id: "t-" + jour + (o.suffixe || ""), title: jour, category: "dev", status: "a_faire",
  urgency: "normale", due_date: jour ? jour + "T00:00:00.000Z" : null, ...o,
});
const jours = (r, cle) => r[cle].map((x) => x.title);

console.log("── Les trois listes");
{
  const r = classifyTasks([
    t("2026-09-17"), t("2026-09-19"),              // retard
    t("2026-09-20"),                               // aujourd'hui
    t("2026-09-21"), t("2026-09-22"),              // bientôt (J+1, J+2)
    t("2026-09-23"), t("2026-12-01"),              // trop loin
  ], AUJ);
  eq("retards, du plus ancien au plus récent", jours(r, "overdue"), ["2026-09-17", "2026-09-19"]);
  eq("aujourd'hui", jours(r, "dueToday"), ["2026-09-20"]);
  eq("bientôt = J+1 et J+2 seulement", jours(r, "dueSoon"), ["2026-09-21", "2026-09-22"]);
  eq("J+3 et au-delà : dans aucune liste", [...jours(r, "overdue"), ...jours(r, "dueToday"), ...jours(r, "dueSoon")].includes("2026-09-23"), false);
  eq("le jour et l'horizon sont rendus", [r.today, r.horizon, r.soonDays], [AUJ, "2026-09-22", 2]);
}

console.log("\n── Bornes exactes de la fenêtre");
for (const [jour, liste] of [
  ["2026-09-19", "overdue"], ["2026-09-20", "dueToday"],
  ["2026-09-21", "dueSoon"], ["2026-09-22", "dueSoon"],
]) {
  const r = classifyTasks([t(jour)], AUJ);
  eq(`${jour} → ${liste}`, [jours(r, "overdue"), jours(r, "dueToday"), jours(r, "dueSoon")].flat(), [jour]);
  eq(`${jour} est bien dans ${liste}`, jours(r, liste), [jour]);
}
eq("J+3 exclu", classifyTasks([t("2026-09-23")], AUJ).dueSoon, []);

console.log("\n── Exclusions");
{
  const r = classifyTasks([
    t("2026-09-17", { status: "fait", suffixe: "-fait" }),
    t("2026-09-20", { status: "fait", suffixe: "-fait" }),
    t("2026-09-21", { status: "fait", suffixe: "-fait" }),
    t(null, { title: "sans échéance" }),
    t("2026-09-20", { status: "en_cours", suffixe: "-encours" }),
  ], AUJ);
  eq("une tâche faite ne sort dans aucune liste", [r.overdue.length, r.dueSoon.length], [0, 0]);
  eq("« en cours » est bien retenue", jours(r, "dueToday"), ["2026-09-20"]);
  eq("une tâche sans échéance est ignorée", r.dueToday.length, 1);
  eq("entrées nulles sans plantage", classifyTasks([null, undefined, t("2026-09-20")], AUJ).dueToday.length, 1);
  eq("liste vide ou absente", [classifyTasks([], AUJ).dueToday, classifyTasks(null, AUJ).overdue], [[], []]);
}

console.log("\n── Aucune tâche dans deux listes à la fois");
{
  const toutes = ["2026-09-01", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-30"].map((j) => t(j));
  const r = classifyTasks(toutes, AUJ);
  const ids = [...r.overdue, ...r.dueToday, ...r.dueSoon].map((x) => x.id);
  eq("aucun doublon entre les listes", ids.length, new Set(ids).size);
  // 09-01 et 09-19 en retard, 09-20 aujourd'hui, 09-21 et 09-22 bientôt ;
  // seule 09-30 est hors fenêtre.
  eq("total retenu = 5 sur 6", ids.length, 5);
  eq("la seule écartée est la plus lointaine", ids.includes("t-2026-09-30"), false);
}

console.log("\n── Forme de chaque tâche rendue");
{
  const r = classifyTasks([t("2026-09-20", { id: "abc", title: "Relancer le devis", category: "boulot", urgency: "urgente" })], AUJ);
  eq("id, intitulé, catégorie, échéance, urgence",
     r.dueToday[0],
     { id: "abc", title: "Relancer le devis", category: "boulot", dueDate: "2026-09-20T00:00:00.000Z", dueDay: "2026-09-20", urgency: "urgente" });
  eq("urgence absente → 'normale'", classifyTasks([t("2026-09-20", { urgency: undefined })], AUJ).dueToday[0].urgency, "normale");
}

console.log("\n── Échéances horaires et ordre");
{
  const r = classifyTasks([
    t("2026-09-20", { id: "soir", title: "Soir", due_date: "2026-09-20T18:00:00.000Z" }),
    t("2026-09-20", { id: "matin", title: "Matin", due_date: "2026-09-20T08:00:00.000Z" }),
  ], AUJ);
  eq("une échéance horaire compte pour son jour", r.dueToday.length, 2);
  eq("triées par heure croissante", r.dueToday.map((x) => x.id), ["matin", "soir"]);
}
{
  const r = classifyTasks([t("2026-09-21", { id: "b", title: "Bravo" }), t("2026-09-21", { id: "a", title: "Alpha" })], AUJ);
  eq("à échéance égale, par titre — ordre stable", r.dueSoon.map((x) => x.id), ["a", "b"]);
}

console.log("\n── Le seuil est bien une constante ajustable");
eq("valeur par défaut", DUE_SOON_DAYS, 2);
{
  const tasks = ["2026-09-21", "2026-09-22", "2026-09-25", "2026-09-27"].map((j) => t(j));
  eq("seuil 0 → plus de « bientôt »", classifyTasks(tasks, AUJ, 0).dueSoon, []);
  eq("seuil 7 → la fenêtre s'élargit", jours(classifyTasks(tasks, AUJ, 7), "dueSoon"), ["2026-09-21", "2026-09-22", "2026-09-25", "2026-09-27"]);
  eq("horizon recalculé", classifyTasks(tasks, AUJ, 7).horizon, "2026-09-27");
}

console.log("\n── Arithmétique des jours : mois, année, bissextile");
eq("fin de mois", addDays("2026-09-30", 2), "2026-10-02");
eq("fin d'année", addDays("2026-12-31", 1), "2027-01-01");
eq("février bissextile", addDays("2028-02-28", 1), "2028-02-29");
eq("février non bissextile", addDays("2027-02-28", 1), "2027-03-01");
{
  const r = classifyTasks([t("2026-10-01"), t("2026-10-02"), t("2026-10-03")], "2026-09-30");
  eq("la fenêtre traverse le changement de mois", jours(r, "dueSoon"), ["2026-10-01", "2026-10-02"]);
}

// ── L'endpoint d'aperçu ──────────────────────────────────────
console.log("\n── GET /api/notifications/preview");
process.env.NODE_ENV = "test";
process.env.PORT = "3993";
process.env.APP_PASSWORD = "secret";
const srv = await import("../server.js");
const H = srv.__testHooks;
const get = async (q = "", headers = { "x-app-key": "secret" }) => {
  const r = await fetch(`http://127.0.0.1:3993/api/notifications/preview${q}`, { headers });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
H.setTasks([
  t("2026-09-17", { id: "vieille", title: "Vieille" }),
  t("2026-09-20", { id: "auj", title: "Aujourd’hui" }),
  t("2026-09-21", { id: "demain", title: "Demain", urgency: "urgente", category: "boulot" }),
  t("2026-09-20", { id: "faite", title: "Faite", status: "fait" }),
  t(null, { id: "sansdate", title: "Sans date" }),
]);
{
  const r = await get("?today=" + AUJ);
  eq("200 avec la clé", r.status, 200);
  eq("les trois listes", [jours(r.json, "overdue"), jours(r.json, "dueToday"), jours(r.json, "dueSoon")],
     [["Vieille"], ["Aujourd’hui"], ["Demain"]]);
  eq("compteurs", r.json.counts, { overdue: 1, dueToday: 1, dueSoon: 1 });
  eq("chaque tâche porte les cinq champs demandés",
     Object.keys(r.json.dueSoon[0]).sort(), ["category", "dueDate", "dueDay", "id", "title", "urgency"]);
  eq("l'urgence remonte", r.json.dueSoon[0].urgency, "urgente");
}
eq("sans clé → 401", (await get("?today=" + AUJ, {})).status, 401);
eq("mauvaise clé → 401", (await get("?today=" + AUJ, { "x-app-key": "non" })).status, 401);
eq("today mal formé → 400", (await get("?today=demain")).status, 400);
eq("sans today → le jour courant", (await get()).json.today, new Date().toISOString().slice(0, 10));
{
  // Lecture seule : rien ne doit bouger en base.
  const avant = JSON.stringify(H.tasks());
  await get("?today=" + AUJ);
  eq("aucune écriture", JSON.stringify(H.tasks()), avant);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
