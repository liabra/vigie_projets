// Garde de l'interface : impossible de lancer le mode réel sans être passé
// par l'aperçu. La règle est une fonction pure, testée ici ; on vérifie en
// plus, sur la source, que le JSX n'a pas de chemin parallèle.
import { readFileSync } from "node:fs";
import { canExecuteReconcile } from "../src/shared.js";

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};

console.log("── Sans aperçu, jamais d'exécution");
eq("aucun aperçu (null) → non", canExecuteReconcile(null, false), false);
eq("aperçu absent (undefined) → non", canExecuteReconcile(undefined, false), false);
eq("aperçu vide {} → non", canExecuteReconcile({}, false), false);
eq("aperçu avec 0 à corriger → non", canExecuteReconcile({ checked: 0 }, false), false);

console.log("\n── Avec un aperçu exploitable");
eq("aperçu avec 2 à corriger → oui", canExecuteReconcile({ checked: 2 }, false), true);
eq("mais pas si une passe tourne", canExecuteReconcile({ checked: 2 }, true), false);
eq("un RÉSULTAT de mode réel n'est pas un aperçu",
   canExecuteReconcile({ checked: 2, executed: true }, false), false);

console.log("\n── La source ne contourne pas la règle");
const src = readFileSync(new URL("../src/Tasks.jsx", import.meta.url), "utf8");
const executeCalls = src.match(/execute:\s*true/g) || [];
eq("un seul endroit demande le mode réel", executeCalls.length, 1);
eq("il est dans applyPlan", /const applyPlan[\s\S]{0,900}execute: true/.test(src), true);
eq("applyPlan est gardé par canExecuteReconcile",
   /const applyPlan[\s\S]{0,300}canExecuteReconcile\(plan, reconciling\)/.test(src), true);
eq("le bouton de confirmation est rendu sous la même règle",
   /canExecuteReconcile\(plan, reconciling\) && \(\s*<button[\s\S]{0,200}applyPlan/.test(src), true);
eq("l'aperçu, lui, part sans execute", /body: JSON\.stringify\(\{\}\)/.test(src), true);

console.log("\n── Le badge compte les tâches en erreur");
const badge = /list\.filter\(\(t\) => t\.syncStatus === "error"\)\.length/.test(src);
eq("compté sur la liste complète, pas sur les tâches filtrées", badge, true);
eq("le badge ne dépend pas de l'aperçu", /desyncCount > 0 \?/.test(src) && !/plan && desyncCount/.test(src), true);

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
