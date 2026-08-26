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

  // Urgence : un rouge franc, volontairement distinct de l'orange
  // « à faire » (plus jaune) pour que les deux ne se confondent pas.
  red: "#C51F1F", redSoft: "#FBE5E3",
};

const APPKEY_KEY = "vigie:key";
export const getKey = () => { try { return localStorage.getItem(APPKEY_KEY) || ""; } catch { return ""; } };
export const setKey = (k) => { try { localStorage.setItem(APPKEY_KEY, k); } catch {} };
export const authHeaders = () => { const k = getKey(); return k ? { "x-app-key": k } : {}; };
