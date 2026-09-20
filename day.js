// ─────────────────────────────────────────────────────────────
//  « Quel jour sommes-nous ? » — une seule réponse, partagée par le
//  serveur (notifications.js) et le navigateur (src/dates.js).
//
//  Pourquoi ce module existe : les deux côtés répondaient différemment.
//  Le serveur lisait le jour UTC, le navigateur son fuseau local. Entre
//  minuit et 2 h du matin à Paris, une tâche pouvait donc s'afficher « en
//  retard » sur une carte sans figurer dans overdue côté notifications —
//  ou l'inverse. Une seule référence, et l'écart disparaît.
//
//  Fuseau IANA, pas un décalage fixe : le passage heure d'été / heure
//  d'hiver est géré par la base de données de fuseaux, sans rien à changer
//  deux fois par an.
// ─────────────────────────────────────────────────────────────

export const APP_TIMEZONE = "Europe/Paris";

// Intl exige une ICU complète. Node 22 et tous les navigateurs visés l'ont ;
// si jamais ce n'était pas le cas, on retombe sur UTC — mais bruyamment,
// parce qu'un retour silencieux au bug qu'on vient de corriger serait pire
// que le bug lui-même.
function makeFormatter(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
}
let formatter;
try {
  formatter = makeFormatter(APP_TIMEZONE);
} catch (e) {
  console.error(
    `[day] Fuseau « ${APP_TIMEZONE} » indisponible (ICU incomplète ?) → repli sur UTC. ` +
      `Les jours seront faux entre minuit et 2 h heure de Paris.`
  );
  formatter = makeFormatter("UTC");
}

// Le jour d'un instant, lu dans le fuseau de référence. « AAAA-MM-JJ ».
//
// Vaut pour les deux formes d'échéance. Une échéance « journée entière » est
// rangée à minuit UTC, ce qui tombe à 1 h ou 2 h du matin à Paris : même
// jour, donc son jour intentionnel est préservé. Une échéance horaire est un
// instant, et c'est bien son jour parisien qu'on veut.
//
// ATTENTION si ce fuseau change un jour : la propriété ci-dessus tient parce
// que Paris est EN AVANCE sur UTC. Un fuseau en retard (les Amériques)
// ferait basculer toutes les échéances « journée entière » à la veille.
export function dayIn(instant) {
  // Piège : new Date(null) vaut l'epoch, pas une date invalide. Sans cette
  // garde, une échéance absente ressortirait en « 1970-01-01 », donc en
  // retard de cinquante-six ans.
  if (instant === null || instant === undefined || instant === "") return "";
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return "";
  // formatToParts plutôt que format() : aucune dépendance à la façon dont
  // la locale assemble les morceaux.
  const p = Object.fromEntries(formatter.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Le jour courant, dans le fuseau de référence. `now` est injectable : la
// fenêtre où UTC et Paris divergent (minuit → 2 h) ne se teste pas
// autrement qu'en fixant l'instant.
export const today = (now = new Date()) => dayIn(now);

// Décalage en jours sur une date « AAAA-MM-JJ ». Arithmétique de calendrier
// pure : on avance de N quantièmes, pas de N × 24 h, donc les changements
// d'heure ne peuvent pas décaler le résultat.
export function addDays(day, n) {
  const d = new Date(day + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
