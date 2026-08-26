import React from "react";
import { theme } from "./shared.js";

// Barre de statistiques : grand nombre, libellé dessous. Partagée par
// l'onglet Projets et l'onglet Tâches pour que les deux restent
// identiques — une seule définition, pas de dérive entre les deux.

export const statsRow = { display: "flex", gap: 26, marginBottom: 22, flexWrap: "wrap" };

const S = {
  stat: { display: "flex", flexDirection: "column" },
  statN: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 700, lineHeight: 1 },
  statL: { fontFamily: "Inter, sans-serif", fontSize: 12.5, color: theme.mute, marginTop: 3, textTransform: "uppercase", letterSpacing: ".04em" },
};

export default function Stat({ n, label, color = theme.ink }) {
  return (
    <div style={S.stat}>
      <span style={{ ...S.statN, color }}>{n}</span>
      <span style={S.statL}>{label}</span>
    </div>
  );
}
