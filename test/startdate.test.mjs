// Jour de début : modèle, validation, exposition. Contre le vrai serveur
// HTTP en repli mémoire — pas de base, pas de réseau.
process.env.NODE_ENV = "test";
const PORT = 3990;
process.env.PORT = String(PORT);
await import("../server.js");

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const call = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const post = (b) => call("POST", "/api/tasks", b);
const patch = (id, b) => call("PATCH", `/api/tasks/${id}`, b);

console.log("── Plages acceptées");
{
  const r = await post({ title: "Dossier", dueDate: "2026-09-10", startDate: "2026-09-07" });
  eq("créée", r.status, 201);
  eq("le début est rendu tel quel, en jour", r.json.task.startDate, "2026-09-07");
  eq("l'échéance n'a pas bougé", r.json.task.dueDate.slice(0, 10), "2026-09-10");
}
eq("début = échéance (délai d'un jour) accepté",
   (await post({ title: "X", dueDate: "2026-09-10", startDate: "2026-09-10" })).json.task.startDate, "2026-09-10");

console.log("\n── Refus, avec un message qui dit quoi faire");
{
  const r = await post({ title: "X", dueDate: "2026-09-07", startDate: "2026-09-10" });
  eq("début après échéance → 400", r.status, 400);
  eq("le message cite les deux dates", /2026-09-10.*2026-09-07/.test(r.json.error), true);
}
{
  const r = await post({ title: "X", startDate: "2026-09-07" });
  eq("début seul → 400", r.status, 400);
  eq("le message propose une issue", /ajoute une échéance|retire le début/.test(r.json.error), true);
}
for (const mauvais of ["07/09/2026", "2026-13-01", "demain", "2026-9-7", 42, true]) {
  const r = await post({ title: "X", dueDate: "2026-09-10", startDate: mauvais });
  eq(`format « ${mauvais} » refusé`, r.status, 400);
}

console.log("\n── Sans début : rien ne change");
{
  const r = await post({ title: "Simple", dueDate: "2026-09-10" });
  eq("startDate vaut null, pas undefined", r.json.task.startDate, null);
  eq("la synchro reste sur ses rails", r.json.task.syncStatus, "pending");
}
{
  const r = await post({ title: "Sans rien" });
  eq("ni début ni échéance → accepté", [r.status, r.json.task.startDate, r.json.task.dueDate], [201, null, null]);
}

console.log("\n── Modification");
{
  const { json: { task } } = await post({ title: "Étalée", dueDate: "2026-09-20", startDate: "2026-09-15" });
  eq("déplacer le seul début", (await patch(task.id, { startDate: "2026-09-18" })).json.task.startDate, "2026-09-18");
  // Le piège : le corps ne contient PAS startDate, mais la nouvelle échéance
  // le rendrait invalide. La validation doit porter sur l'état résultant.
  const r = await patch(task.id, { dueDate: "2026-09-16" });
  eq("avancer l'échéance AVANT le début en base → 400", r.status, 400);
  eq("l'échéance n'a pas été appliquée malgré tout",
     (await call("GET", "/api/tasks")).json.tasks.find((t) => t.id === task.id).dueDate.slice(0, 10), "2026-09-20");
  eq("retirer le début (null)", (await patch(task.id, { startDate: null })).json.task.startDate, null);
  eq("une fois le début retiré, l'échéance peut avancer",
     (await patch(task.id, { dueDate: "2026-09-16" })).json.task.dueDate.slice(0, 10), "2026-09-16");
}

console.log("\n── Le jour ne glisse pas selon le fuseau");
{
  const r = await post({ title: "Fuseau", dueDate: "2026-01-01", startDate: "2025-12-31" });
  eq("31 décembre reste le 31 décembre", r.json.task.startDate, "2025-12-31");
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
