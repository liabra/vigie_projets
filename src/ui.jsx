import React from "react";
import { theme } from "./shared.js";

// ─────────────────────────────────────────────────────────────
//  Briques d'interface partagées par les onglets Tâches et
//  Articles : mêmes cartes, mêmes filtres, mêmes champs — une
//  seule définition, pour qu'ils ne divergent pas.
// ─────────────────────────────────────────────────────────────

// Une ligne de filtre = un intitulé de dimension (simple texte, JAMAIS
// cliquable) suivi de ses pastilles. Le tout passe à la ligne sur mobile.
export function FilterRow({ label, children }) {
  return (
    <div style={sharedStyles.filterRow}>
      <span style={sharedStyles.filterLabel}>{label}</span>
      <div style={sharedStyles.filterChips}>{children}</div>
    </div>
  );
}

// Pastille active en violet plein, comme l'onglet actif ; inactive en
// simple contour. Une seule couleur d'état : ce qui est plein est choisi.
export function Chip({ active, onClick, children }) {
  return (
    <button
      className="at-btn at-focus"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: active ? 600 : 500,
        padding: "6px 12px", borderRadius: 999,
        border: "1px solid " + (active ? theme.violet : theme.line),
        background: active ? theme.violet : theme.panel,
        color: active ? "#FFFFFF" : theme.slate, cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// Bouton-lien d'une carte (repo, doc, prompt…) : ouvre dans un onglet
// à part, toujours avec rel="noopener noreferrer".
export function LinkBtn({ href, children }) {
  return (
    <a className="at-btn at-focus" style={sharedStyles.linkBtn} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// Une URL n'est proposée que si elle ressemble à une adresse web.
export const isWebUrl = (u) => /^https?:\/\//i.test((u || "").trim());

export const sharedStyles = {
  wrap: { marginTop: 0 },
  head: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 },
  h2: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 700, margin: 0, color: theme.ink, letterSpacing: "-0.01em" },

  addRow: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
  input: { flex: "1 1 220px", fontFamily: "Inter", fontSize: 14, padding: "10px 14px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink },
  select: { fontFamily: "Inter", fontSize: 14, padding: "10px 12px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink, cursor: "pointer" },
  date: { fontFamily: "Inter", fontSize: 13.5, padding: "9px 12px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink },
  check: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" },
  addBtn: { fontFamily: "Inter", fontSize: 14, fontWeight: 600, padding: "10px 16px", borderRadius: 11, border: "none", background: theme.violet, color: "#fff", cursor: "pointer" },

  filters: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  filterRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  filterLabel: { fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: theme.mute, minWidth: 74, flexShrink: 0 },
  filterChips: { display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 },
  msg: { fontFamily: "Inter", fontSize: 12.5, color: theme.amber, marginBottom: 10 },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 },
  card: { position: "relative", background: theme.panel, borderRadius: 14, border: "1px solid " + theme.line, overflow: "hidden", display: "flex" },
  spine: { width: 5, flexShrink: 0 },
  cardBody: { padding: "13px 15px", flex: 1, minWidth: 0 },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  cardTitle: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 15.5, fontWeight: 600, margin: 0, lineHeight: 1.3 },
  cardMeta: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 },
  cardActions: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" },
  statusBtn: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, padding: "4px 10px", borderRadius: 999, border: "none", cursor: "pointer", whiteSpace: "nowrap" },
  catTag: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: "2px 7px", borderRadius: 6 },
  due: { fontFamily: "Inter", fontSize: 12.5, marginTop: 10 },
  rowBtn: { fontFamily: "Inter", fontSize: 12.5, padding: "5px 11px", borderRadius: 9, border: "1px solid " + theme.line, background: theme.paper, color: theme.slate, cursor: "pointer" },
  linkBtn: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 500, padding: "5px 11px", borderRadius: 999, border: "1px solid " + theme.line, background: theme.paper, color: theme.violet, textDecoration: "none", cursor: "pointer" },

  empty: { fontFamily: "Inter", fontSize: 14, color: theme.mute, textAlign: "center", padding: "30px 20px", background: theme.panel, borderRadius: 12, border: "1px dashed " + theme.line },

  overlay: { position: "fixed", inset: 0, background: "rgba(27,26,46,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto", zIndex: 50 },
  modal: { background: theme.panel, borderRadius: 18, padding: 24, width: "100%", maxWidth: 480, boxShadow: "0 24px 60px rgba(27,26,46,.3)" },
  label: { display: "block", fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, color: theme.slate, marginBottom: 6 },
  field: { width: "100%", fontFamily: "Inter", fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.paper, color: theme.ink },
  ghost: { fontFamily: "Inter", fontSize: 13, fontWeight: 500, padding: "9px 14px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.panel, color: theme.slate, cursor: "pointer" },
};
