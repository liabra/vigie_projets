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
//    · toute écriture vise un couple (calendar_id, event_id) que Vigie a
//      elle-même créé et stocké sur la tâche ;
//    · aucune énumération (events.list, calendarList, calendars.list) ;
//    · aucun événement sans id stocké n'est touché, jamais.
//  Les seuls points d'écriture sont syncTask / insertEvent / removeEvent
//  ci-dessous — trois fonctions, toutes tributaires d'un id stocké.
//
//  Le module ne touche pas à la base directement : server.js lui
//  passe un petit adaptateur de stockage (store).
// ─────────────────────────────────────────────────────────────
import { google } from "googleapis";

// Deux scopes, deux destinations :
//  - calendar.app.created : l'agenda « Vigie » que l'app crée et possède.
//  - calendar.events      : nécessaire pour écrire dans l'agenda principal
//                           (primary), que l'app ne possède pas.
// calendar.events est large côté Google (il couvre les événements de tous
// les agendas). C'est le code ci-dessous qui le borne : Vigie n'agit JAMAIS
// que sur un couple (calendar_id, event_id) qu'elle a elle-même créé et
// stocké. Aucune énumération, aucune écriture à l'aveugle — voir syncTask
// et removeEvent, seuls points d'écriture du module.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.events",
];
const CALENDAR_NAME = "Vigie";
const GRAPHITE = "8"; // colorId « Graphite » (gris) des événements

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

export function createGoogle(store) {
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
        .catch((e) => console.error("Google: sauvegarde du jeton:", e.message));
    });
    return c;
  }

  // Tout appel à l'API passe par ici : en cas d'échec, le log dit
  // EXACTEMENT quelle opération a échoué, et l'erreur porte ce nom.
  async function callCalendar(op, fn) {
    try {
      return await fn();
    } catch (e) {
      const code = e?.code || e?.status;
      const detail = e?.errors?.[0]?.message || e?.message || "";
      if (code === 403) {
        console.error(
          `Google Agenda: ${op} → 403 (${detail}). Scopes demandés : ${SCOPES.join(", ")}. ` +
            `Si le compte a été lié avant l'ajout de calendar.events, il faut repasser par ` +
            `« Connecter l'agenda Google » pour redonner le consentement.`
        );
      } else {
        console.error(`Google Agenda: ${op} → ${code || "erreur"} (${detail})`);
      }
      e.gcalOp = op;
      e.message = `${op} : ${detail || e.message}`;
      throw e;
    }
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
  let cachedCalendarId = null;
  async function ensureCalendar() {
    if (cachedCalendarId) return cachedCalendarId;
    const cal = await calendarApi();
    if (!cal) return null;

    const known = await store.getSetting("google_calendar_id");
    if (known) {
      cachedCalendarId = known;
      return known;
    }
    // Première fois : calendars.insert, couvert par le scope, et c'est
    // sa réponse qui nous donne l'id à conserver.
    const created = await callCalendar("calendars.insert", () =>
      cal.calendars.insert({
        requestBody: { summary: CALENDAR_NAME, description: "Échéances des tâches Vigie." },
      })
    );
    const id = created.data.id;
    await store.setSetting("google_calendar_id", id);
    cachedCalendarId = id;
    return id;
  }

  // Id déjà connu, sans rien créer : pour les opérations qui n'ont de
  // sens que si l'agenda existe déjà (suppression d'un événement).
  async function knownCalendarId() {
    return cachedCalendarId || (await store.getSetting("google_calendar_id")) || null;
  }

  // Oublie l'agenda mémorisé : appelé quand Google répond qu'il n'existe
  // plus (supprimé à la main), pour en recréer un au prochain besoin.
  async function forgetCalendar() {
    cachedCalendarId = null;
    await store.setSetting("google_calendar_id", null);
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
    cachedCalendarId = null;
    await store.saveAuth(null);
    await store.setSetting("google_calendar_id", null);
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
      if (task.calendar_event_id) await removeEvent(task.calendar_event_id, current);
      return { eventId: null, calendarId: null };
    }

    const requestBody = buildEventBody(task);

    // La catégorie a changé d'agenda : on retire l'ancien événement par
    // son id stocké, puis on recrée sur la bonne destination.
    if (task.calendar_event_id && current && current !== target) {
      await removeEvent(task.calendar_event_id, current);
      const moved = await insertEvent(requestBody, target);
      return { eventId: moved.data.id, calendarId: target };
    }

    // Même agenda qu'avant : mise à jour sur place.
    if (task.calendar_event_id && current) {
      try {
        const r = await callCalendar("events.update", () =>
          cal.events.update({ calendarId: current, eventId: task.calendar_event_id, requestBody })
        );
        return { eventId: r.data.id, calendarId: current };
      } catch (e) {
        if (!isGone(e)) throw e;
        // Événement (ou agenda) effacé à la main : on repart sur une création.
      }
    }
    const created = await insertEvent(requestBody, target);
    return { eventId: created.data.id, calendarId: created.calendarId };
  }

  // Création d'un événement, toujours dans l'agenda de l'app. Si Google
  // répond que l'agenda n'existe plus, on en recrée un et on réessaie
  // une fois — sans jamais aller chercher ailleurs dans le compte.
  async function insertEvent(requestBody, calendarId) {
    const cal = await calendarApi();
    try {
      const r = await callCalendar("events.insert", () => cal.events.insert({ calendarId, requestBody }));
      return { data: r.data, calendarId };
    } catch (e) {
      // Le repli « l'agenda a disparu, on le recrée » n'a de sens que pour
      // l'agenda de l'app : primary, lui, ne disparaît pas.
      if (!isGone(e) || calendarId === PRIMARY) throw e;
      await forgetCalendar();
      const fresh = await ensureCalendar();
      if (!fresh) throw e;
      const r = await callCalendar("events.insert (après recréation de l'agenda)", () =>
        cal.events.insert({ calendarId: fresh, requestBody })
      );
      return { data: r.data, calendarId: fresh };
    }
  }

  async function removeEvent(eventId, calendarId) {
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
      await callCalendar("events.delete", () => cal.events.delete({ calendarId: id, eventId }));
    } catch (e) {
      if (!isGone(e)) throw e; // déjà parti : très bien
    }
  }

  return {
    configured, consentUrl, handleCallback, status, disconnect,
    ensureCalendar, syncTask, removeEvent, isScopeError,
    SCOPES, CALENDAR_NAME, PRIMARY,
  };
}
