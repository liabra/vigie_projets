import React, { useEffect, useState } from "react";
import { theme, authHeaders } from "./shared.js";

// ─────────────────────────────────────────────────────────────
//  Bouton « Activer les notifications ». Enchaîne : permission →
//  abonnement PushManager avec la clé publique VAPID → envoi au serveur.
//  Ne s'affiche que si le serveur a une clé (sinon rien à faire).
// ─────────────────────────────────────────────────────────────

// La clé VAPID arrive en base64url ; PushManager veut des octets.
export function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export default function Push({ vapidPublicKey, onLocked }) {
  // "idle" | "on" | "denied" | "busy" | "unsupported"
  const [state, setState] = useState(() => (supported() ? "idle" : "unsupported"));
  const [msg, setMsg] = useState("");

  // Au chargement : déjà abonné sur cet appareil ?
  useEffect(() => {
    if (!supported() || !vapidPublicKey) return;
    if (Notification.permission === "denied") { setState("denied"); return; }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => { if (sub) setState("on"); })
      .catch(() => {});
  }, [vapidPublicKey]);

  const enable = async () => {
    setState("busy"); setMsg("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "idle"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
      const r = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(sub.toJSON()),
      });
      if (r.status === 401) { onLocked && onLocked(); setState("idle"); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Le serveur a refusé l’abonnement.");
      setState("on");
      setMsg("Notifications activées sur cet appareil.");
    } catch (e) {
      setState("idle");
      setMsg(e.message || "Activation impossible.");
    }
  };

  if (!vapidPublicKey || state === "unsupported") return null;

  return (
    <span style={S.wrap}>
      {state === "on" ? (
        <span style={S.on}>🔔 Notifications actives</span>
      ) : state === "denied" ? (
        <span style={S.off} title="Autorise les notifications dans les réglages du navigateur pour ce site.">
          🔕 Notifications refusées par le navigateur
        </span>
      ) : (
        <button className="at-btn at-focus" style={S.btn} onClick={enable} disabled={state === "busy"}>
          {state === "busy" ? "…" : "Activer les notifications"}
        </button>
      )}
      {msg && <span style={S.msg}>{msg}</span>}
    </span>
  );
}

const S = {
  wrap: { display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  btn: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, padding: "6px 12px", borderRadius: 999, border: "1px solid " + theme.line, background: theme.panel, color: theme.violet, cursor: "pointer" },
  on: { fontFamily: "Inter", fontSize: 12.5, color: theme.green },
  off: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute },
  msg: { fontFamily: "Inter", fontSize: 12, color: theme.mute },
};
