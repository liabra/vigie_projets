// ─────────────────────────────────────────────────────────────
//  Journal de la synchro agenda — un seul format, un seul endroit.
//
//  Une désync silencieuse est ce qui a rendu le bug d'origine si long à
//  diagnostiquer : la tâche était en base, l'événement absent côté Google,
//  et pas une ligne ne le disait. Chaque étape du chemin de synchro écrit
//  donc ici, succès compris — sans trace de succès, un rejeu qui aboutit à
//  la 2e tentative est indiscernable d'un silence.
//
//  Forme : « [sync] {json} ». Le préfixe se grep à l'œil, le JSON se parse
//  par Railway. Pas de dépendance, pas de niveau configurable : ce chemin
//  est toujours journalisé.
//
//  NE JAMAIS Y METTRE : un jeton OAuth (access ou refresh), APP_PASSWORD,
//  la clé Anthropic, ni le contenu d'une tâche. taskId et eventId sont des
//  identifiants opaques : ils suffisent à tout retrouver, sans rien révéler.
// ─────────────────────────────────────────────────────────────

// `error` n'a de sens que sur un échec. Ailleurs on l'écarte, pour qu'une
// ligne de succès ne traîne jamais le message d'une tentative précédente.
const ERROR_STATUSES = new Set(["retry", "error"]);

export function logSync(fields = {}) {
  const line = { timestamp: new Date().toISOString(), ...fields };
  if (!ERROR_STATUSES.has(line.status)) delete line.error;
  if (typeof line.error === "string") line.error = line.error.slice(0, 300);
  // Un champ vide n'apprend rien : on l'omet plutôt que d'écrire null.
  for (const k of Object.keys(line)) if (line[k] === undefined || line[k] === null) delete line[k];
  const out = "[sync] " + JSON.stringify(line);
  if (ERROR_STATUSES.has(line.status)) console.error(out);
  else console.log(out);
}
