// ─────────────────────────────────────────────────────────────
//  Agenda Google — synchro À SENS UNIQUE, vers DEUX destinations :
//    dev, boulot   → l'agenda « Vigie », créé et possédé par l'app
//    perso, admin  → l'agenda principal de l'utilisateur (primary)
//
//  Vigie écrit, ne lit jamais, et ne remonte jamais rien vers les tâches.
//
//  GARDE-FOU. Écrire dans primary impose le scope calendar.events, qui
//  côté Google couvre les événements de TOUS les agendas. La limite est
//  donc tenue par ce module, pas par Google :
//    · toute écriture vise soit un couple (calendar_id, event_id) que
//      Vigie a elle-même créé et stocké, soit un événement portant SON
//      marqueur privé vigieTaskId ;
//    · la seule lecture d'agenda autorisée est events.list FILTRÉE par ce
//      marqueur (findByMarker) — elle ne peut ramener que des événements
//      créés par Vigie. Jamais de liste nue, jamais calendarList ni
//      calendars.list ;
//    · aucun événement sans id stocké ni marqueur n'est touché, jamais ;
//    · une lecture ne remonte JAMAIS vers les tâches : elle sert seulement
//      à retrouver un id d'événement perdu. Le sens reste unique.
//  Les seuls points d'écriture sont syncTask / syncArticle / insertEvent /
//  removeEvent ci-dessous.
//
//  Le module ne touche pas à la base directement : server.js lui
//  passe un petit adaptateur de stockage (store).
// ─────────────────────────────────────────────────────────────
import { google } from "googleapis";
import { logSync } from "./log.js";

// Deux scopes, deux destinations :
//  - calendar.app.created : l'agenda « Vigie » que l'app crée et possède.
//  - calendar.events      : nécessaire pour écrire dans l'agenda principal
//                           (primary), que l'app ne possède pas.
// calendar.events est large côté Google (il couvre les événements de tous
// les agendas). C'est le code ci-dessous qui le borne : Vigie n'agit JAMAIS
// que sur un événement qu'elle a elle-même créé — couple (calendar_id,
// event_id) stocké, ou marqueur privé. Aucune liste nue, aucune écriture à
// l'aveugle : voir le GARDE-FOU en tête de fichier.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.events",
];
const CALENDAR_NAME = "Vigie";
const ARTICLES_CALENDAR_NAME = "Vigie – Articles";
// Chaque agenda app-created : son nom, sa description, et la clé sous
// laquelle son id est mémorisé.
const APP_CALENDARS = {
  tasks: { key: "google_calendar_id", name: CALENDAR_NAME, description: "Échéances des tâches Vigie." },
  articles: { key: "google_articles_calendar_id", name: ARTICLES_CALENDAR_NAME, description: "Dates de sortie des articles Vigie." },
};
const GRAPHITE = "8"; // colorId « Graphite » (gris) des événements

// Nom d'appel Google → `operation` du journal, pour qu'un grep porte sur un
// vocabulaire stable et non sur la formulation de l'appel.
function operationOf(op) {
  // Le repère de début d'abord : ses insert/update/delete se journalisent
  // tous sous « start_marker », pour ne jamais se confondre avec le
  // pipeline de due_date, autrement plus exigeant.
  if (/repère de début/.test(op)) return "start_marker";
  if (/events\.insert/.test(op)) return "insert";
  if (/events\.update/.test(op)) return "update";
  if (/events\.delete/.test(op)) return "delete";
  if (/events\.list/.test(op)) return "lookup";
  if (/calendars\.insert/.test(op)) return "calendar_create";
  return "call";
}

// Agenda principal de l'utilisateur : destination des tâches perso/admin.
const PRIMARY = "primary";
// Catégories qui vont dans l'agenda « Vigie » ; les autres vont dans primary.
const OWN_CALENDAR_CATEGORIES = ["dev", "boulot"];

// 403 « insufficient authentication scopes » : jeton délivré avant
// l'élargissement des scopes. Il faut repasser par le consentement.
export function isScopeError(e) {
  const code = e?.code || e?.status;
  const msg = (e?.message || "") + " " + (e?.errors?.[0]?.message || "");
  return code === 403 && /insufficient|scope/i.test(msg);
}

// ── Marqueur d'appartenance ───────────────────────────────────
// Posé sur CHAQUE événement écrit par Vigie, dans les propriétés privées.
// C'est le lien de secours : si (calendar_id, event_id) venait à manquer
// en base, il permet de retrouver l'événement — et lui seul. Une recherche
// filtrée par ce marqueur ne peut pas ramener un événement que Vigie n'a
// pas créé : c'est ce qui la rend compatible avec le garde-fou.
// Une seule clé pour les tâches ET les articles : les deux id sont des
// uuid distincts, et une recherche est toujours bornée à UN agenda — un
// article ne vit que dans « Vigie – Articles », jamais là où sont les tâches.
export const MARKER_TASK = "vigieTaskId";

// ── Résilience réseau ─────────────────────────────────────────
// Node 22.23.0 et 24.17.0 ont introduit une régression qui fait échouer
// node-fetch@2 (sous gaxios/googleapis) avec « Premature close » ALORS QUE
// la requête a pu aboutir côté Google. C'est un faux négatif : rejouer un
// insert à l'aveugle créerait un doublon. D'où deux mécanismes distincts —
//   · withRetry ne rejoue QUE ce qui est transitoire ;
//   · avant tout ré-insert, findByMarker vérifie si l'événement existe déjà.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 2000; // pire cas : ~4 s de latence ajoutée, jamais plus

// Codes système / réseau : la requête n'a pas abouti proprement, on rejoue.
const TRANSIENT_CODES = new Set([
  "ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "ETIMEDOUT",
  "EAI_AGAIN", "ENOTFOUND", "EPIPE",
]);
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
// Jamais rejoués. La requête est mauvaise (400), le droit manque (403),
// la cible n'existe plus (404) — et le 401 relève du rafraîchissement de
// jeton, fait par la librairie OAuth dans authed(), pas d'un retry aveugle.
const FATAL_STATUS = new Set([400, 401, 403, 404]);
const PREMATURE = /premature close/i;

// gaxios et node-fetch empilent les causes : la vraie raison est souvent
// deux niveaux plus bas. On parcourt la chaîne, en se gardant des cycles.
function* causeChain(e, max = 6) {
  const seen = new Set();
  let cur = e;
  for (let i = 0; cur && i < max; i++) {
    if (seen.has(cur)) return;
    seen.add(cur);
    yield cur;
    cur = cur.cause;
  }
}

// Statut HTTP, où qu'il se cache : gaxios le met dans response.status,
// googleapis parfois dans code (nombre OU chaîne).
export function httpStatusOf(e) {
  for (const err of causeChain(e)) {
    for (const v of [err.response?.status, err.status, err.code]) {
      const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
      if (typeof n === "number" && n >= 100 && n < 600) return n;
    }
  }
  return null;
}
function sysCodeOf(e) {
  for (const err of causeChain(e)) {
    if (typeof err.code === "string" && !/^\d+$/.test(err.code)) return err.code;
  }
  return null;
}
const messagesOf = (e) => [...causeChain(e)].map((x) => x?.message || "").join(" | ");

export function isTransient(e) {
  // Une erreur définitive le reste, quel que soit le reste du message.
  const status = httpStatusOf(e);
  if (status !== null && FATAL_STATUS.has(status)) return false;
  // Le « Premature close » n'expose pas de statut HTTP exploitable : il
  // faut le reconnaître au message, avant de regarder les statuts.
  if (PREMATURE.test(messagesOf(e))) return true;
  if (TRANSIENT_CODES.has(sysCodeOf(e))) return true;
  return status !== null && TRANSIENT_STATUS.has(status);
}

// Retry-After (429 / 503) : en secondes ou en date HTTP. Plafonné, sinon
// un « reviens dans 5 minutes » bloquerait la requête de l'utilisateur —
// la réconciliation rattrapera plus tard.
function retryAfterMs(e) {
  for (const err of causeChain(e)) {
    const h = err.response?.headers;
    if (!h) continue;
    const raw = typeof h.get === "function" ? h.get("retry-after") : h["retry-after"] ?? h["Retry-After"];
    if (raw == null || raw === "") continue;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  return null;
}

// Exponentiel, moitié fixe / moitié aléatoire : borné, mais désynchronisé.
export function retryDelayMs(attempt, e, random = Math.random) {
  const after = retryAfterMs(e);
  if (after !== null) return Math.min(after, MAX_DELAY_MS);
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(exp / 2 + random() * (exp / 2));
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rejoue fn tant que l'erreur est transitoire. beforeAttempt permet de
// court-circuiter une re-tentative (c'est là que l'insert va vérifier si
// l'événement existe déjà) : toute valeur qu'il renvoie devient le résultat.
export async function withRetry(fn, opts = {}) {
  const { attempts = MAX_ATTEMPTS, sleep = realSleep, beforeAttempt, onAttemptError } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (beforeAttempt && attempt > 1) {
      const shortcut = await beforeAttempt(attempt, lastErr);
      if (shortcut !== undefined) return shortcut;
    }
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const transient = isTransient(e);
      if (onAttemptError) onAttemptError(e, attempt, transient, attempts);
      if (!transient || attempt === attempts) throw e;
      await sleep(retryDelayMs(attempt, e));
    }
  }
  throw lastErr;
}

// ── Forme de l'événement ──────────────────────────────────────
// Les journées entières sont manipulées en UTC : la tâche est rangée
// à minuit UTC, l'agenda reçoit le même jour quel que soit le fuseau.
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const nextDay = (d) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

// Corps COMPLET de l'événement : on utilise events.update (et non
// patch), donc ce qui n'est pas envoyé est effacé — repasser une tâche
// en « à faire » enlève bien le gris et le « ✓ ».
export function buildEventBody(task) {
  const done = task.status === "fait";
  const body = {
    summary: (done ? "✓ " : "") + task.title,
    description: "Tâche Vigie · " + task.category,
  };
  if (done) body.colorId = GRAPHITE;
  // Réaffirmé à chaque écriture : events.update remplace le corps entier,
  // donc reconstruire le marqueur depuis la tâche le préserve toujours.
  if (task.id) body.extendedProperties = { private: { [MARKER_TASK]: String(task.id) } };
  if (task.due_all_day) {
    body.start = { date: ymd(task.due_date) };
    body.end = { date: nextDay(task.due_date) };
  } else {
    const start = new Date(task.due_date);
    body.start = { dateTime: start.toISOString() };
    body.end = { dateTime: new Date(start.getTime() + 30 * 60000).toISOString() };
  }
  return body;
}

// Un article est toujours une journée entière, à sa date de sortie.
// « En ligne » se lit comme une tâche faite : ✓ et gris.
export function buildArticleEventBody(article) {
  const online = article.status === "en_ligne";
  const body = {
    summary: (online ? "✓ " : "") + article.title,
    description: "Article Vigie",
    start: { date: ymd(article.release_date) },
    end: { date: nextDay(article.release_date) },
  };
  if (online) body.colorId = GRAPHITE;
  if (article.id) body.extendedProperties = { private: { [MARKER_TASK]: String(article.id) } };
  return body;
}

// Repère de jour de début. Une journée entière, un titre qui dit ce que
// c'est, et SURTOUT aucun extendedProperties : ce repère n'est pas marqué
// et ne doit jamais l'être. C'est ce qui garantit que la recherche par
// marqueur (findByMarker, donc reconcileCalendarSync) ne peut pas tomber
// dessus et le confondre avec l'événement d'échéance.
export function buildStartEventBody(task) {
  return {
    summary: "Début : " + task.title,
    description: "Jour de début — Vigie",
    start: { date: ymd(task.start_date) },
    end: { date: nextDay(task.start_date) },
  };
}

// Le marqueur porté par un corps d'événement, s'il en a un.
export function markerOf(requestBody) {
  const value = requestBody?.extendedProperties?.private?.[MARKER_TASK];
  return value ? { key: MARKER_TASK, value: String(value) } : null;
}

// `sleep` est injectable pour que les tests n'attendent pas réellement.
export function createGoogle(store, { sleep = realSleep } = {}) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";

  // Sans les 3 variables, tout le module reste dormant : les tâches
  // fonctionnent, la synchro ne fait rien.
  const configured = () => !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

  const newClient = () => new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  function consentUrl(state) {
    return newClient().generateAuthUrl({
      access_type: "offline",     // indispensable pour obtenir un refresh_token
      prompt: "consent",          // force un refresh_token même si déjà autorisé
      include_granted_scopes: false,
      scope: SCOPES,
      state,
    });
  }

  // Client prêt à l'emploi, jeton rafraîchi automatiquement par la
  // librairie à partir du refresh_token. null si pas encore connecté.
  async function authed() {
    if (!configured()) return null;
    const row = await store.loadAuth();
    if (!row || !row.refresh_token) return null;
    const c = newClient();
    c.setCredentials({
      refresh_token: row.refresh_token,
      access_token: row.access_token || undefined,
      expiry_date: row.expiry ? new Date(row.expiry).getTime() : undefined,
    });
    // Chaque rafraîchissement est réécrit en base pour éviter de
    // redemander un jeton à chaque requête.
    c.on("tokens", (t) => {
      store
        .saveAuth({
          refresh_token: t.refresh_token || row.refresh_token,
          access_token: t.access_token || row.access_token,
          expiry: t.expiry_date ? new Date(t.expiry_date) : null,
        })
        // Ni access_token ni refresh_token dans le journal : seulement
        // qu'un rafraîchissement a eu lieu, et jusqu'à quand il vaut.
        .then(() => logSync({
          operation: "oauth_refresh", status: "success",
          expiry: t.expiry_date ? new Date(t.expiry_date).toISOString() : undefined,
        }))
        .catch((e) => logSync({ operation: "oauth_refresh", status: "error", error: e.message }));
    });
    return c;
  }

  // Un appel, sans rejeu. Seul journaliseur des appels Calendar : succès de
  // rattrapage, rejeu et échec définitif passent tous par ici, avec le même
  // contexte (ctx) que l'appelant lui a donné.
  // `benign` laisse l'appelant déclarer qu'une erreur est ATTENDUE (un 404
  // sur une suppression, par exemple). Elle est alors journalisée en
  // « skipped » et non en « error » : sans ça, une condition parfaitement
  // normale déclencherait une alerte, et le journal perdrait sa valeur.
  // Le prédicat lui-même ne doit jamais atterrir dans la ligne de log.
  async function rawCall(op, fn, ctx = {}, attempt = 1, attempts = 1) {
    const { benign, ...logCtx } = ctx;
    try {
      const r = await fn();
      // Succès APRÈS un échec : c'est le signal qui manquait pour savoir si
      // la panne réseau se produit encore et à quelle fréquence elle se
      // résout d'elle-même. Un premier essai réussi ne logue rien.
      if (attempt > 1) logSync({ ...logCtx, operation: operationOf(op), attempt, status: "success" });
      return r;
    } catch (e) {
      // Nommer l'opération à CHAQUE échec, pas seulement quand le budget de
      // rejeu est épuisé : une erreur définitive (400/403/404) sort dès la
      // première tentative et doit porter son nom elle aussi. gcalOp sert de
      // garde pour ne pas préfixer deux fois le même objet d'erreur. Fait
      // AVANT le journal, pour que `error` y soit déjà préfixé.
      if (!e.gcalOp) {
        e.gcalOp = op;
        e.message = `${op} : ${e?.errors?.[0]?.message || e.message || ""}`;
      }
      const tolerated = typeof benign === "function" && benign(e);
      const willRetry = !tolerated && isTransient(e) && attempt < attempts;
      logSync({
        ...logCtx,
        operation: operationOf(op),
        attempt: attempts > 1 ? attempt : undefined,
        status: tolerated ? "skipped" : willRetry ? "retry" : "error",
        error: e.message,
      });
      // Le 403 mérite une phrase en clair : le JSON dit ce qui a échoué,
      // pas quoi faire.
      if (httpStatusOf(e) === 403) {
        console.error(
          `[sync] 403 sur ${op}. Scopes demandés : ${SCOPES.join(", ")}. Si le compte a été lié ` +
            `avant l'ajout de calendar.events, repasse par « Connecter l'agenda Google ».`
        );
      }
      throw e;
    }
  }

  // Tout appel à l'API passe par ici : rejeu des erreurs transitoires
  // inclus. Sûr pour update / delete / calendars.insert, qui sont
  // naturellement idempotents. L'insert, lui, a son propre chemin
  // (insertResilient) car le rejouer à l'aveugle créerait un doublon.
  async function callCalendar(op, fn, ctx = {}) {
    return withRetry((attempt) => rawCall(op, fn, ctx, attempt, MAX_ATTEMPTS), { sleep });
  }

  // SEULE lecture d'agenda du module, et elle est toujours filtrée par le
  // marqueur privé de Vigie : sans marqueur, elle ne cherche rien. Google
  // ne peut donc renvoyer que des événements écrits par Vigie — et on le
  // revérifie nous-mêmes, parce que le garde-fou est tenu par ce code.
  // Elle ne modifie jamais rien dans Vigie : elle rend un id, c'est tout.
  async function findByMarker(cal, calendarId, marker) {
    if (!cal || !calendarId || !marker?.value) return null;
    const r = await callCalendar("events.list (par marqueur)", () =>
      cal.events.list({
        calendarId,
        privateExtendedProperty: `${marker.key}=${marker.value}`,
        showDeleted: false,
        singleEvents: true,
        maxResults: 5,
      }), { taskId: marker.value, calendarId }
    );
    const items = r?.data?.items || [];
    return (
      items.find(
        (ev) => ev?.status !== "cancelled" && ev?.extendedProperties?.private?.[marker.key] === marker.value
      ) || null
    );
  }

  // 404 / 410 : l'objet visé (événement ou agenda) n'existe plus.
  const isGone = (e) => e?.code === 404 || e?.code === 410 || e?.status === 404 || e?.status === 410;

  async function calendarApi() {
    const auth = await authed();
    return auth ? google.calendar({ version: "v3", auth }) : null;
  }

  // Id de l'agenda « Vigie ». Le seul moyen de le retrouver est de
  // l'avoir gardé : le scope calendar.app.created ne donne accès NI à
  // calendarList.list, NI à calendars.list, NI à l'agenda primary. On
  // ne cherche donc jamais l'agenda par son nom — on crée une fois, on
  // mémorise l'id, on le réutilise.
  // Un cache par agenda de l'app (tâches, articles).
  const cachedIds = {};
  async function ensureAppCalendar(which) {
    const spec = APP_CALENDARS[which];
    if (cachedIds[spec.key]) return cachedIds[spec.key];
    const cal = await calendarApi();
    if (!cal) return null;

    const known = await store.getSetting(spec.key);
    if (known) {
      cachedIds[spec.key] = known;
      return known;
    }
    // Première fois : calendars.insert, couvert par le scope, et c'est
    // sa réponse qui nous donne l'id à conserver.
    const created = await callCalendar(`calendars.insert (${spec.name})`, () =>
      cal.calendars.insert({ requestBody: { summary: spec.name, description: spec.description } })
    );
    const id = created.data.id;
    await store.setSetting(spec.key, id);
    cachedIds[spec.key] = id;
    return id;
  }
  const ensureCalendar = () => ensureAppCalendar("tasks");
  const ensureArticlesCalendar = () => ensureAppCalendar("articles");

  // Id déjà connu, sans rien créer : pour les opérations qui n'ont de
  // sens que si l'agenda existe déjà (suppression d'un événement).
  async function knownCalendarId() {
    return cachedIds[APP_CALENDARS.tasks.key] || (await store.getSetting(APP_CALENDARS.tasks.key)) || null;
  }

  // Oublie l'agenda mémorisé : appelé quand Google répond qu'il n'existe
  // plus (supprimé à la main), pour en recréer un au prochain besoin.
  async function forgetCalendar(which = "tasks") {
    const spec = APP_CALENDARS[which];
    delete cachedIds[spec.key];
    await store.setSetting(spec.key, null);
  }

  async function handleCallback(code) {
    const c = newClient();
    const { tokens } = await c.getToken(code);
    if (!tokens.refresh_token) {
      // Google ne renvoie le refresh_token qu'au premier consentement :
      // on garde celui déjà en base plutôt que de l'écraser par null.
      const prev = await store.loadAuth();
      if (!prev?.refresh_token) {
        throw new Error(
          "Google n'a pas renvoyé de refresh_token. Retire l'accès de l'app dans " +
            "https://myaccount.google.com/permissions puis recommence."
        );
      }
      tokens.refresh_token = prev.refresh_token;
    }
    await store.saveAuth({
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token || null,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    });
    await store.setSetting("google_scopes", tokens.scope || "");
    await ensureCalendar();
  }

  async function status() {
    if (!configured()) return { configured: false, connected: false, calendarId: null };
    const row = await store.loadAuth();
    const connected = !!row?.refresh_token;
    // Un compte lié avant l'ajout de calendar.events n'a pas le droit
    // d'écrire dans primary : on le signale sans attendre le premier 403.
    const granted = (await store.getSetting("google_scopes")) || "";
    const missing = SCOPES.filter((sc) => !granted.split(/\s+/).includes(sc));
    return {
      configured: true,
      connected,
      needsReconsent: connected && missing.length > 0,
      calendarId: (await store.getSetting("google_calendar_id")) || null,
      calendarName: CALENDAR_NAME,
    };
  }

  async function disconnect() {
    for (const spec of Object.values(APP_CALENDARS)) {
      delete cachedIds[spec.key];
      await store.setSetting(spec.key, null);
    }
    await store.saveAuth(null);
    await store.setSetting("google_scopes", null);
  }

  // Crée / met à jour / supprime l'événement d'une tâche.
  // Renvoie l'id d'événement à stocker (ou null s'il n'y en a plus).
  // Ne lève pas : si Google n'est pas joignable, la tâche vit sa vie.
  // Destination d'une tâche, décidée par sa seule catégorie.
  // dev / boulot → agenda « Vigie » ; perso / admin → primary.
  async function targetCalendar(category) {
    if (OWN_CALENDAR_CATEGORIES.includes(category)) return await ensureCalendar();
    return PRIMARY;
  }

  // Même routage, mais SANS jamais rien créer : le dry-run de la
  // réconciliation ne doit écrire ni sur Google ni en base, or
  // ensureCalendar() crée l'agenda s'il manque. Renvoie null quand l'agenda
  // de l'app n'existe pas encore — il n'y a alors aucun événement à y
  // trouver, ce que l'appelant traduit par « il faudrait insérer ».
  async function targetCalendarForRead(category) {
    if (OWN_CALENDAR_CATEGORIES.includes(category)) return await knownCalendarId();
    return PRIMARY;
  }

  // Où vit l'événement DÉJÀ créé pour cette tâche. Les tâches d'avant le
  // routage n'ont pas de calendar_id : elles sont dans l'agenda « Vigie ».
  // On ne devine jamais vers primary — au pire on ne trouve rien.
  async function currentCalendar(task) {
    if (!task.calendar_event_id) return null;
    return task.calendar_id || (await knownCalendarId());
  }

  async function syncTask(task) {
    const cal = await calendarApi();
    if (!cal) return { eventId: task.calendar_event_id || null, calendarId: task.calendar_id || null, skipped: true };

    const target = await targetCalendar(task.category);
    if (!target) return { eventId: task.calendar_event_id || null, calendarId: task.calendar_id || null, skipped: true };

    const current = await currentCalendar(task);

    // Plus d'échéance → plus d'événement.
    if (!task.due_date) {
      if (task.calendar_event_id) await removeEvent(task.calendar_event_id, current, task.id);
      return { eventId: null, calendarId: null };
    }

    const requestBody = buildEventBody(task);

    // La catégorie a changé d'agenda : on retire l'ancien événement par
    // son id stocké, puis on recrée sur la bonne destination.
    if (task.calendar_event_id && current && current !== target) {
      await removeEvent(task.calendar_event_id, current, task.id);
      const moved = await insertEvent(requestBody, target);
      return { eventId: moved.data.id, calendarId: target };
    }

    // Même agenda qu'avant : mise à jour sur place.
    if (task.calendar_event_id && current) {
      try {
        const r = await callCalendar("events.update", () =>
          cal.events.update({ calendarId: current, eventId: task.calendar_event_id, requestBody }),
          { taskId: task.id, calendarId: current, eventId: task.calendar_event_id, benign: isGone }
        );
        return { eventId: r.data.id, calendarId: current };
      } catch (e) {
        if (!isGone(e)) throw e;
        // Événement (ou agenda) effacé à la main côté Google : on repart sur
        // une création. Marqué « recreate » et non « insert » pour rester
        // repérable au milieu des créations ordinaires — c'est le symétrique
        // du cas « Travailler mon linkedin » trouvé à l'étape 3.
        logSync({
          taskId: task.id, calendarId: current, eventId: task.calendar_event_id,
          operation: "recreate", status: "retry", error: e.message,
        });
      }
    }
    const created = await insertEvent(requestBody, target);
    return { eventId: created.data.id, calendarId: created.calendarId };
  }

  // Même schéma que syncTask, mais la destination ne dépend de rien :
  // toujours l'agenda « Vigie – Articles ».
  async function syncArticle(article) {
    const cal = await calendarApi();
    const untouched = { eventId: article.calendar_event_id || null, calendarId: article.calendar_id || null, skipped: true };
    if (!cal) return untouched;

    const target = await ensureArticlesCalendar();
    if (!target) return untouched;

    // L'agenda où vit l'événement déjà créé — jamais deviné.
    const current = article.calendar_event_id ? article.calendar_id || target : null;

    // Plus de date de sortie → plus d'événement.
    if (!article.release_date) {
      if (article.calendar_event_id) await removeEvent(article.calendar_event_id, current);
      return { eventId: null, calendarId: null };
    }

    const requestBody = buildArticleEventBody(article);

    if (article.calendar_event_id && current) {
      try {
        const r = await callCalendar("events.update (article)", () =>
          cal.events.update({ calendarId: current, eventId: article.calendar_event_id, requestBody })
        );
        return { eventId: r.data.id, calendarId: current };
      } catch (e) {
        if (!isGone(e)) throw e;
        // Événement effacé à la main : on repart sur une création.
      }
    }
    const created = await insertEvent(requestBody, target, "articles");
    return { eventId: created.data.id, calendarId: created.calendarId };
  }

  // Cycle de vie du repère de début. Délibérément à l'écart de syncTask :
  // il ne partage ni son marqueur, ni son état, ni sa réconciliation.
  // AUCUNE recherche ici — le seul lien est start_event_id. Un double
  // insert accidentel produirait donc un doublon que personne ne
  // rattraperait : c'est le compromis assumé pour ce repère de confort.
  // callCalendar est réutilisé pour la seule résilience réseau (rejeu sur
  // « Premature close »), sans l'idempotence par marqueur.
  async function syncStartMarker(task) {
    const cal = await calendarApi();
    if (!cal) return { eventId: task.start_event_id || null, skipped: true };
    // Le même agenda que l'échéance de cette tâche : celui où elle vit
    // déjà, sinon celui vers lequel sa catégorie l'enverrait.
    const target = task.calendar_id || (await targetCalendar(task.category));
    if (!target) return { eventId: task.start_event_id || null, skipped: true };

    // Plus de jour de début → plus de repère.
    if (!task.start_date) {
      if (task.start_event_id) {
        await removeEvent(task.start_event_id, target, task.id, "events.delete (repère de début)");
      }
      return { eventId: null };
    }

    const requestBody = buildStartEventBody(task);
    if (task.start_event_id) {
      try {
        const r = await callCalendar("events.update (repère de début)", () =>
          cal.events.update({ calendarId: target, eventId: task.start_event_id, requestBody }),
          { taskId: task.id, calendarId: target, eventId: task.start_event_id, benign: isGone }
        );
        return { eventId: r.data.id, calendarId: target };
      } catch (e) {
        if (!isGone(e)) throw e;
        // Repère effacé à la main côté Google : on le recrée.
      }
    }
    const created = await callCalendar("events.insert (repère de début)", () =>
      cal.events.insert({ calendarId: target, requestBody }),
      { taskId: task.id, calendarId: target }
    );
    return { eventId: created.data.id, calendarId: target };
  }

  // Création d'un événement, toujours dans l'agenda de l'app. Si Google
  // répond que l'agenda n'existe plus, on en recrée un et on réessaie
  // une fois — sans jamais aller chercher ailleurs dans le compte.
  // Insert idempotent. Le chemin nominal reste UN appel : on insère, point.
  // Ce n'est qu'en cas d'échec transitoire qu'on va vérifier, avant de
  // rejouer, si l'insert précédent avait en fait abouti — c'est ce qui
  // rend le « Premature close » inoffensif au lieu de créer un doublon.
  async function insertResilient(cal, calendarId, requestBody, op = "events.insert") {
    const marker = markerOf(requestBody);
    const ctx = { taskId: marker?.value, calendarId, benign: isGone };
    // Une recherche qui échoue ne doit jamais masquer l'erreur d'insert.
    const lookup = async () => {
      try {
        return await findByMarker(cal, calendarId, marker);
      } catch (e) {
        logSync({ ...ctx, operation: "lookup", status: "error", error: e.message });
        return null;
      }
    };
    const adopt = (found) => {
      // Un doublon évité : la trace la plus utile de tout ce chantier.
      logSync({ ...ctx, operation: "adopt", status: "success", eventId: found.id });
      return { data: found, adopted: true };
    };

    try {
      return await withRetry(
        async (attempt) => ({
          data: (await rawCall(op, () => cal.events.insert({ calendarId, requestBody }), ctx, attempt, MAX_ATTEMPTS)).data,
          adopted: false,
        }),
        {
          sleep,
          // Avant CHAQUE re-tentative : l'insert précédent a-t-il abouti ?
          beforeAttempt: async () => {
            const found = marker ? await lookup() : null;
            return found ? adopt(found) : undefined;
          },
        }
      );
    } catch (e) {
      // La tentative finale aussi peut être un faux négatif : une dernière
      // vérification avant d'abandonner. Sinon la réconciliation prendra
      // le relais (elle adoptera l'événement, sans le dupliquer).
      if (marker && isTransient(e)) {
        const found = await lookup();
        if (found) return adopt(found);
      }
      throw e;
    }
  }

  async function insertEvent(requestBody, calendarId, which = "tasks") {
    const cal = await calendarApi();
    try {
      const r = await insertResilient(cal, calendarId, requestBody);
      return { data: r.data, calendarId, adopted: r.adopted };
    } catch (e) {
      // Le repli « l'agenda a disparu, on le recrée » n'a de sens que pour
      // les agendas de l'app : primary, lui, ne disparaît pas.
      if (!isGone(e) || calendarId === PRIMARY) throw e;
      // Recréer un agenda entier n'est pas anodin : ça doit se voir.
      logSync({
        taskId: markerOf(requestBody)?.value, calendarId,
        operation: "recreate_calendar", status: "retry", error: e.message,
      });
      await forgetCalendar(which);
      const fresh = await ensureAppCalendar(which);
      if (!fresh) throw e;
      const r = await insertResilient(cal, fresh, requestBody, "events.insert (après recréation de l'agenda)");
      return { data: r.data, calendarId: fresh, adopted: r.adopted };
    }
  }

  async function removeEvent(eventId, calendarId, taskId, op = "events.delete") {
    if (!eventId) return;
    const cal = await calendarApi();
    if (!cal) return;
    // Surtout pas ensureCalendar() ici : supprimer un événement ne doit
    // jamais avoir pour effet de créer un agenda. Et le repli ne peut
    // désigner que l'agenda « Vigie » (tâches d'avant le routage) —
    // jamais primary, où l'on ne supprime que sur id explicite.
    const id = calendarId || (await knownCalendarId());
    if (!id) return;
    try {
      await callCalendar(op, () => cal.events.delete({ calendarId: id, eventId }),
        { taskId, calendarId: id, eventId, benign: isGone });
      logSync({ taskId, calendarId: id, eventId, operation: operationOf(op), status: "success" });
    } catch (e) {
      if (!isGone(e)) throw e;
      // Déjà parti : rawCall l'a déjà journalisé en « skipped ». C'est le
      // signe qu'un événement a été supprimé à la main côté Google.
    }
  }

  return {
    configured, consentUrl, handleCallback, status, disconnect,
    ensureCalendar, ensureArticlesCalendar, syncTask, syncArticle, removeEvent, isScopeError,
    findByMarker, calendarApi, targetCalendar, targetCalendarForRead, syncStartMarker,
    SCOPES, CALENDAR_NAME, ARTICLES_CALENDAR_NAME, PRIMARY,
  };
}
