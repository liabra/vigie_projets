// Petits éléments partagés entre App (projets) et Tasks (tâches) :
// la palette et l'accès au code d'accès optionnel.

export const theme = {
  ink: "#1B1A2E", paper: "#F3F4FA", panel: "#FFFFFF", line: "#E4E5F1",
  violet: "#5B3DF5", violetSoft: "#ECE8FF", amber: "#D9930A", amberSoft: "#FCF1DA",
  green: "#11875B", greenSoft: "#DFF3E9", teal: "#2A7E8C", slate: "#5A6478", mute: "#6C6B85",

  // Statuts de tâches. « violet » ci-dessus est le violet de MARQUE
  // (boutons, onglet actif) : le statut « en cours » utilise un violet
  // plus sombre et plus chaud, pour qu'une pastille de statut ne se lise
  // jamais comme un bouton.
  orange: "#A64F06", orangeSoft: "#FDEEDC",
  statusViolet: "#6B2FB5", statusVioletSoft: "#F1E6FB",
  doneGrey: "#5A5972", doneGreySoft: "#EBECF2",

  // Ambre assombri, réservé au tag « Admin » : #D9930A plafonnait à
  // 2,30:1 sur son fond crème. Même famille, 4,83:1 — dans la bande des
  // autres tags (à faire 4,93 · dev 5,12 · boulot 6,53).
  amberDeep: "#8F6100",

  // Catégorie « boulot » : un bleu franc, distinct du teal (perso), de
  // l'ambre (admin) et du violet (dev).
  work: "#1B5490", workSoft: "#E3EDF9",

  // Statut « idée » des articles : indigo ardoise, distinct du bleu
  // « boulot » comme du violet « en cours ».
  indigo: "#45528A", indigoSoft: "#E8EAF4",

  // Urgence : un rouge franc, volontairement distinct de l'orange
  // « à faire » (plus jaune) pour que les deux ne se confondent pas.
  red: "#C51F1F", redSoft: "#FBE5E3",
};

const APPKEY_KEY = "vigie:key";
export const getKey = () => { try { return localStorage.getItem(APPKEY_KEY) || ""; } catch { return ""; } };
export const setKey = (k) => { try { localStorage.setItem(APPKEY_KEY, k); } catch {} };
export const authHeaders = () => { const k = getKey(); return k ? { "x-app-key": k } : {}; };

// ── Réconciliation agenda ─────────────────────────────────────
// L'exécution réelle exige d'être passé par l'aperçu : `plan` n'est
// renseigné qu'au retour d'un dry-run. Isolé ici plutôt qu'en ligne dans le
// JSX pour que la règle soit vérifiable par un test, et pour qu'affichage du
// bouton et garde de la fonction ne puissent pas diverger.
export function canExecuteReconcile(plan, busy) {
  if (busy) return false;          // une passe est déjà en cours
  if (!plan) return false;         // aucun aperçu : rien à confirmer
  if (plan.executed) return false; // ce n'est pas un aperçu, c'est un résultat
  return plan.checked > 0;         // rien à corriger → rien à confirmer
}
