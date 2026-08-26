// ─────────────────────────────────────────────────────────────
//  Agenda Google — synchro À SENS UNIQUE : Vigie écrit dans un
//  agenda dédié qu'elle a créé (« Vigie »), et ne lit jamais les
//  autres agendas du compte.
//
//  SCOPE : calendar.app.created. C'est le plus étroit qui permette
//  de créer un agenda et d'y gérer des événements : il ne donne
//  accès QU'AUX agendas créés par cette application — les agendas
//  personnels ou professionnels existants restent invisibles, même
//  en lecture. (Les scopes calendar / calendar.events, eux, ouvrent
//  tout le compte : on ne les utilise pas.)
//
//  Le module ne touche pas à la base directement : server.js lui
//  passe un petit adaptateur de stockage (store).
// ─────────────────────────────────────────────────────────────
import { google } from "googleapis";

const SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const CALENDAR_NAME = "Vigie";
const GRAPHITE = "8"; // colorId « Graphite » (gris) des événements

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
      scope: [SCOPE],
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
          `Google Agenda: ${op} → 403 (${detail}). Cette opération n'est PAS ` +
            `couverte par le scope ${SCOPE} : seuls les agendas créés par l'app y sont accessibles.`
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
    await ensureCalendar();
  }

  async function status() {
    if (!configured()) return { configured: false, connected: false, calendarId: null };
    const row = await store.loadAuth();
    return {
      configured: true,
      connected: !!row?.refresh_token,
      calendarId: (await store.getSetting("google_calendar_id")) || null,
      calendarName: CALENDAR_NAME,
    };
  }

  async function disconnect() {
    cachedCalendarId = null;
    await store.saveAuth(null);
    await store.setSetting("google_calendar_id", null);
  }

  // Crée / met à jour / supprime l'événement d'une tâche.
  // Renvoie l'id d'événement à stocker (ou null s'il n'y en a plus).
  // Ne lève pas : si Google n'est pas joignable, la tâche vit sa vie.
  async function syncTask(task) {
    const cal = await calendarApi();
    if (!cal) return { eventId: task.calendar_event_id || null, skipped: true };

    const calendarId = await ensureCalendar();
    if (!calendarId) return { eventId: task.calendar_event_id || null, skipped: true };

    // Plus d'échéance → plus d'événement.
    if (!task.due_date) {
      if (task.calendar_event_id) await removeEvent(task.calendar_event_id, calendarId);
      return { eventId: null };
    }

    const requestBody = buildEventBody(task);

    // Mise à jour de l'événement existant, dans l'agenda mémorisé.
    if (task.calendar_event_id) {
      try {
        const r = await callCalendar("events.update", () =>
          cal.events.update({ calendarId, eventId: task.calendar_event_id, requestBody })
        );
        return { eventId: r.data.id };
      } catch (e) {
        if (!isGone(e)) throw e;
        // Événement (ou agenda) effacé à la main : on repart sur une création.
      }
    }
    return { eventId: (await insertEvent(requestBody, calendarId)).data.id };
  }

  // Création d'un événement, toujours dans l'agenda de l'app. Si Google
  // répond que l'agenda n'existe plus, on en recrée un et on réessaie
  // une fois — sans jamais aller chercher ailleurs dans le compte.
  async function insertEvent(requestBody, calendarId) {
    const cal = await calendarApi();
    try {
      return await callCalendar("events.insert", () => cal.events.insert({ calendarId, requestBody }));
    } catch (e) {
      if (!isGone(e)) throw e;
      await forgetCalendar();
      const fresh = await ensureCalendar();
      if (!fresh) throw e;
      return await callCalendar("events.insert (après recréation de l'agenda)", () =>
        cal.events.insert({ calendarId: fresh, requestBody })
      );
    }
  }

  async function removeEvent(eventId, calendarId) {
    if (!eventId) return;
    const cal = await calendarApi();
    if (!cal) return;
    // Surtout pas ensureCalendar() ici : supprimer un événement ne doit
    // jamais avoir pour effet de créer un agenda.
    const id = calendarId || (await knownCalendarId());
    if (!id) return;
    try {
      await callCalendar("events.delete", () => cal.events.delete({ calendarId: id, eventId }));
    } catch (e) {
      if (!isGone(e)) throw e; // déjà parti : très bien
    }
  }

  return { configured, consentUrl, handleCallback, status, disconnect, ensureCalendar, syncTask, removeEvent, SCOPE, CALENDAR_NAME };
}
