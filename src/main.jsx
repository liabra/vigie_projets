import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);

// Le service worker ne sert qu'aux notifications push. Enregistré après le
// premier rendu pour ne pas concurrencer le chargement de l'app ; un échec
// (navigateur sans support, http non sécurisé) est sans conséquence.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
