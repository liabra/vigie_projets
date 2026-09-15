// Fondations push : abonnement, upsert, envoi de test, purge des abonnements
// résiliés, auth. web-push est stubbé : rien ne part vers FCM.
process.env.NODE_ENV = "test";
const PORT = 3992;
process.env.PORT = String(PORT);
process.env.VAPID_PUBLIC_KEY = "BPUBLIC-test";
process.env.VAPID_PRIVATE_KEY = "PRIVEE-SENTINELLE-NE-DOIT-JAMAIS-SORTIR";
process.env.VAPID_SUBJECT = "mailto:test@example.com";

const webpush = (await import("web-push")).default;
let sent = [], failWith = {};
webpush.setVapidDetails = () => {};
webpush.sendNotification = async (sub, body) => {
  sent.push({ endpoint: sub.endpoint, body: JSON.parse(body) });
  const code = failWith[sub.endpoint];
  if (code) throw Object.assign(new Error("push failed"), { statusCode: code });
  return {};
};

const srv = await import("../server.js");
const H = srv.__testHooks;
let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const sub = (n, keys = {}) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "P" + n, auth: "A" + n, ...keys } });
const reset = () => { sent = []; failWith = {}; H.subscriptions().length = 0; };

console.log("── /api/config expose la clé publique, jamais la privée");
{
  const { json } = await call("GET", "/api/config");
  eq("clé publique présente", json.vapidPublicKey, "BPUBLIC-test");
  eq("aucune trace de la clé privée", JSON.stringify(json).includes("SENTINELLE"), false);
}

console.log("\n── Abonnement");
{
  reset();
  const r = await call("POST", "/api/push/subscribe", sub(1));
  eq("201 + id", [r.status, typeof r.json.id], [201, "string"]);
  eq("stocké : endpoint + clés", H.subscriptions().map((s) => [s.endpoint, s.p256dh, s.auth]), [[sub(1).endpoint, "P1", "A1"]]);
  const again = await call("POST", "/api/push/subscribe", sub(1, { p256dh: "P1-bis" }));
  eq("même endpoint → upsert, pas de doublon", H.subscriptions().length, 1);
  eq("les clés sont mises à jour", H.subscriptions()[0].p256dh, "P1-bis");
  eq("l'id est conservé", again.json.id, r.json.id);
  await call("POST", "/api/push/subscribe", sub(2));
  eq("un autre endpoint → deuxième ligne", H.subscriptions().length, 2);
}
console.log("\n── Abonnements invalides refusés");
for (const [label, b] of [
  ["vide", {}], ["endpoint http", { ...sub(3), endpoint: "http://x" }],
  ["sans clés", { endpoint: "https://x" }], ["clé non textuelle", sub(4, { auth: 42 })],
]) eq(`${label} → 400`, (await call("POST", "/api/push/subscribe", b)).status, 400);

console.log("\n── Push de test");
{
  reset();
  await call("POST", "/api/push/subscribe", sub(1));
  await call("POST", "/api/push/subscribe", sub(2));
  const r = await call("POST", "/api/push/test");
  eq("bilan", r.json, { total: 2, sent: 2, removed: 0, failed: 0 });
  eq("un envoi par abonnement", sent.map((s) => s.endpoint).sort(), [sub(1).endpoint, sub(2).endpoint]);
  eq("payload : titre + corps", sent[0].body, { title: "Vigie", body: "Ceci est un test", url: "/" });
}
console.log("\n── Abonnement résilié (410) → purgé ; autre erreur → conservé");
{
  reset();
  await call("POST", "/api/push/subscribe", sub(1));
  await call("POST", "/api/push/subscribe", sub(2));
  await call("POST", "/api/push/subscribe", sub(3));
  failWith[sub(1).endpoint] = 410;
  failWith[sub(2).endpoint] = 500;
  const r = await call("POST", "/api/push/test");
  eq("bilan", r.json, { total: 3, sent: 1, removed: 1, failed: 1 });
  eq("le 410 a disparu, le 500 reste", H.subscriptions().map((s) => s.endpoint).sort(), [sub(2).endpoint, sub(3).endpoint]);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
