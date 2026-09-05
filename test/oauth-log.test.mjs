// Fuite de secret dans le journal du callback OAuth.
//
// Une erreur gaxios porte `config.data` : le CORPS de la requête de jeton,
// donc client_secret et le code d'autorisation. `console.error("…", e)`
// imprime les propriétés énumérables d'une Error — le secret partait donc
// dans les journaux Railway, qui sont conservés.
//
// Test de bout en bout : on force getToken à échouer avec une erreur de
// cette forme, on appelle vraiment /oauth/callback, et on inspecte la
// sortie console capturée.
process.env.NODE_ENV = "test";
const PORT = 3989;
process.env.PORT = String(PORT);
process.env.GOOGLE_CLIENT_ID = "client-id-test";
process.env.GOOGLE_CLIENT_SECRET = "SENTINELLE-CLIENT-SECRET";
process.env.GOOGLE_REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth/callback`;

const CODE = "SENTINELLE-CODE-AUTORISATION";
const { google } = await import("googleapis");

// L'erreur telle que gaxios la produit sur un échange de jeton raté : le
// corps de la requête y est attaché.
google.auth.OAuth2.prototype.getToken = async function () {
  throw Object.assign(new Error("invalid_grant"), {
    code: 400,
    config: {
      url: "https://oauth2.googleapis.com/token",
      data: `code=${CODE}&client_id=client-id-test&client_secret=SENTINELLE-CLIENT-SECRET&grant_type=authorization_code`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
    response: { status: 400, data: { error: "invalid_grant" } },
  });
};

await import("../server.js");

let ko = 0;
const eq = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) ko++;
  console.log((ok ? "  ok  " : "  KO  ") + l + (ok ? "" : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`));
};

console.log("── Le risque est réel : l'objet complet EXPOSE le secret");
{
  const { inspect } = await import("node:util");
  let leve;
  try { await google.auth.OAuth2.prototype.getToken(); } catch (e) { leve = e; }
  const objet = inspect(leve, { depth: null });
  eq("console.error(…, e) aurait imprimé le client_secret", objet.includes("SENTINELLE-CLIENT-SECRET"), true);
  eq("… et le code d'autorisation", objet.includes(CODE), true);
  eq("e.message seul, lui, est propre", /SENTINELLE/.test(leve.message), false);
}

console.log("\n── Le vrai callback ne le journalise plus");
{
  // /oauth/start délivre le state anti-CSRF ; on le récupère pour que le
  // callback aille jusqu'à l'échange de jeton.
  const start = await fetch(`http://127.0.0.1:${PORT}/oauth/start`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  eq("un state a bien été délivré", !!state, true);

  // On rend les objets comme console le ferait : sinon un secret caché dans
  // une propriété passerait au travers du grep.
  const { inspect } = await import("node:util");
  const vraiLog = console.log, vraiErr = console.error, vraiWarn = console.warn;
  const journal = [];
  const grab = (...a) => journal.push(a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: null }))).join(" "));
  console.log = grab; console.error = grab; console.warn = grab;
  const r = await fetch(`http://127.0.0.1:${PORT}/oauth/callback?code=${CODE}&state=${state}`);
  const corps = await r.text();
  console.log = vraiLog; console.error = vraiErr; console.warn = vraiWarn;

  const sortie = journal.join("\n");
  eq("le callback a bien échoué (500)", r.status, 500);
  eq("une ligne a été journalisée", journal.length > 0, true);
  eq("AUCUN client_secret dans le journal", sortie.includes("SENTINELLE-CLIENT-SECRET"), false);
  eq("AUCUN code d'autorisation dans le journal", sortie.includes(CODE), false);
  eq("le journal reste utile : il nomme l'étape", /échange du code OAuth/.test(sortie), true);
  eq("et porte le message de Google", /invalid_grant/.test(sortie), true);
  // La réponse HTTP part vers le navigateur de l'utilisateur : même exigence.
  eq("AUCUN secret dans la réponse HTTP non plus", corps.includes("SENTINELLE-CLIENT-SECRET"), false);
}

console.log(ko ? "\n" + ko + " échec(s)" : "\ntout passe");
process.exit(ko ? 1 : 0);
