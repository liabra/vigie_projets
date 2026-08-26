import React, { useEffect, useMemo, useState } from "react";
import { theme, authHeaders } from "./shared.js";

// ─────────────────────────────────────────────────────────────
//  Tâches — perso / admin / dev, avec échéance facultative.
//  Même logique que les projets : cache localStorage pour
//  l'affichage instantané, serveur comme source de vérité.
//  Une tâche datée est poussée vers l'agenda Google « Vigie »
//  par le serveur (sens unique, jamais l'inverse).
// ─────────────────────────────────────────────────────────────

const CACHE_KEY = "vigie:tasks";

const CATEGORIES = {
  perso: { label: "Perso", color: theme.teal, bg: "#E1F0F2" },
  admin: { label: "Admin", color: theme.amber, bg: theme.amberSoft },
  dev: { label: "Dev", color: theme.violet, bg: theme.violetSoft },
};
const CATEGORY_ORDER = ["perso", "admin", "dev"];

const STATUSES = {
  a_faire: { label: "À faire", color: theme.slate, bg: "#EAECF3" },
  en_cours: { label: "En cours", color: theme.violet, bg: theme.violetSoft },
  fait: { label: "Fait", color: theme.green, bg: theme.greenSoft },
};
const STATUS_ORDER = ["a_faire", "en_cours", "fait"];
const NEXT_STATUS = { a_faire: "en_cours", en_cours: "fait", fait: "a_faire" };

const cache = {
  load() { try { const r = localStorage.getItem(CACHE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } },
  save(t) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(t)); } catch {} },
};

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) throw { code: 401 };
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Erreur");
  return d;
}

// ── Dates ─────────────────────────────────────────────────────
// Une journée entière est stockée à minuit UTC : on la lit donc en
// UTC, sinon le fuseau la ferait glisser d'un jour.
export const dayOf = (iso) => (iso || "").slice(0, 10);
export const localInput = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export function humanDate(task) {
  if (!task.dueDate) return "";
  const d = new Date(task.dueDate);
  if (task.dueAllDay) {
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  }
  return d.toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
// Aujourd'hui en UTC, pour comparer aux échéances « journée entière ».
const todayUtc = () => new Date().toISOString().slice(0, 10);
export const isLate = (task) => task.status !== "fait" && task.dueDate && dayOf(task.dueDate) < todayUtc();

export default function Tasks({ onLocked }) {
  const [tasks, setTasks] = useState(null);
  const [msg, setMsg] = useState("");
  const [statusFilter, setStatusFilter] = useState("tous");
  const [catFilter, setCatFilter] = useState("toutes");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(null);

  // Nouvelle tâche
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("perso");
  const [due, setDue] = useState("");
  const [allDay, setAllDay] = useState(true);

  const fail = (e) => {
    if (e && e.code === 401) { onLocked && onLocked(); return true; }
    return false;
  };

  useEffect(() => {
    const cached = cache.load();
    if (cached) setTasks(cached);
    api("/api/tasks")
      .then((d) => { setTasks(d.tasks || []); cache.save(d.tasks || []); setMsg(""); })
      .catch((e) => {
        if (fail(e)) return;
        if (!cached) setTasks([]);
        setMsg("Hors-ligne — tâches affichées depuis le cache.");
      });
    api("/api/google/status").then(setGoogle).catch(() => {});

    // Retour du consentement Google.
    const p = new URLSearchParams(window.location.search);
    if (p.has("google")) {
      setMsg(p.get("google") === "ok" ? "Agenda Google connecté." : "Connexion à Google annulée.");
      p.delete("google");
      const q = p.toString();
      window.history.replaceState({}, "", window.location.pathname + (q ? "?" + q : ""));
      api("/api/google/status").then(setGoogle).catch(() => {});
    }
  }, []); // eslint-disable-line

  const apply = (next) => { setTasks(next); cache.save(next); };

  // Modification optimiste : on affiche tout de suite, et on revient
  // en arrière si le serveur refuse.
  const mutate = async (next, run) => {
    const before = tasks;
    apply(next);
    try {
      const d = await run();
      if (d && d.task) apply(next.map((t) => (t.id === d.task.id ? d.task : t)));
      setMsg(d && d.syncWarning ? d.syncWarning : "");
    } catch (e) {
      if (fail(e)) return;
      apply(before);
      setMsg("Serveur injoignable — modification annulée.");
    }
  };

  const add = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const d = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ title: t, category, dueDate: due || null, dueAllDay: allDay }),
      });
      apply([...(tasks || []), d.task]);
      setTitle(""); setDue("");
      setMsg(d.syncWarning || "");
    } catch (e) {
      if (!fail(e)) setMsg("La tâche n'a pas pu être créée (serveur injoignable ?).");
    } finally { setBusy(false); }
  };

  const cycle = (task) => {
    const status = NEXT_STATUS[task.status];
    mutate(
      tasks.map((t) => (t.id === task.id ? { ...t, status } : t)),
      () => api("/api/tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ status }) })
    );
  };

  const saveEdit = (patch) => {
    const task = editing;
    setEditing(null);
    mutate(
      tasks.map((t) => (t.id === task.id ? { ...t, ...patch } : t)),
      () => api("/api/tasks/" + task.id, { method: "PATCH", body: JSON.stringify(patch) })
    );
  };

  const remove = async (task) => {
    setEditing(null);
    const before = tasks;
    apply(tasks.filter((t) => t.id !== task.id));
    try {
      const d = await api("/api/tasks/" + task.id, { method: "DELETE" });
      setMsg(d.syncWarning || "");
    } catch (e) {
      if (fail(e)) return;
      apply(before);
      setMsg("Suppression impossible — serveur injoignable.");
    }
  };

  const connectGoogle = async () => {
    try {
      const d = await api("/api/google/start-link", { method: "POST" });
      window.location.href = d.url;
    } catch (e) {
      if (!fail(e)) setMsg(e.message || "Connexion Google impossible.");
    }
  };
  const disconnectGoogle = async () => {
    try {
      await api("/api/google/disconnect", { method: "POST" });
      setGoogle(await api("/api/google/status"));
      setMsg("Agenda Google délié. Les tâches restent, l'agenda ne bouge plus.");
    } catch (e) { if (!fail(e)) setMsg("Déconnexion impossible."); }
  };

  const list = tasks || [];
  const counts = useMemo(() => {
    const by = (s) => list.filter((t) => t.status === s).length;
    return { a_faire: by("a_faire"), en_cours: by("en_cours"), fait: by("fait") };
  }, [list]);

  const filtered = useMemo(
    () =>
      list
        .filter((t) => statusFilter === "tous" || t.status === statusFilter)
        .filter((t) => catFilter === "toutes" || t.category === catFilter),
    [list, statusFilter, catFilter]
  );

  return (
    <section style={S.wrap}>
      <div style={S.head}>
        <h2 style={S.h2}>Tâches</h2>
        <span style={S.counts}>
          {counts.a_faire} à faire · {counts.en_cours} en cours · {counts.fait} faites
        </span>
        <div style={{ marginLeft: "auto" }}>
          {google && google.connected && (
            <span style={S.gOk}>
              Agenda « {google.calendarName} » connecté
              <button className="at-btn at-focus" style={S.gLink} onClick={disconnectGoogle}>délier</button>
            </span>
          )}
          {google && google.configured && !google.connected && (
            <button className="at-btn at-focus" style={S.gBtn} onClick={connectGoogle}>Connecter l’agenda Google</button>
          )}
          {google && !google.configured && <span style={S.gOff}>Agenda Google non configuré</span>}
        </div>
      </div>

      {/* Pas de <form> : un bouton et une touche Entrée suffisent. */}
      <div style={S.addRow}>
        <input
          className="at-focus"
          style={S.input}
          placeholder="Ajouter une tâche…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <select className="at-focus" style={S.select} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORY_ORDER.map((c) => (<option key={c} value={c}>{CATEGORIES[c].label}</option>))}
        </select>
        <input
          className="at-focus"
          style={S.date}
          type={allDay ? "date" : "datetime-local"}
          value={due}
          onChange={(e) => setDue(e.target.value)}
          title="Échéance (facultative)"
        />
        <label style={S.check}>
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => { setAllDay(e.target.checked); setDue(""); }}
          />
          journée
        </label>
        <button className="at-btn at-focus" style={{ ...S.addBtn, opacity: title.trim() && !busy ? 1 : 0.5 }} onClick={add} disabled={!title.trim() || busy}>
          {busy ? "…" : "+ Ajouter"}
        </button>
      </div>

      <div style={S.filters}>
        <Chip active={statusFilter === "tous"} onClick={() => setStatusFilter("tous")}>Toutes</Chip>
        {STATUS_ORDER.map((s) => (
          <Chip key={s} active={statusFilter === s} color={STATUSES[s].color} onClick={() => setStatusFilter(s)}>{STATUSES[s].label}</Chip>
        ))}
        <span style={{ width: 10 }} />
        <Chip active={catFilter === "toutes"} onClick={() => setCatFilter("toutes")}>Catégories</Chip>
        {CATEGORY_ORDER.map((c) => (
          <Chip key={c} active={catFilter === c} color={CATEGORIES[c].color} onClick={() => setCatFilter(c)}>{CATEGORIES[c].label}</Chip>
        ))}
      </div>

      {msg && <div style={S.msg}>{msg}</div>}

      {tasks === null ? (
        <div style={S.empty}>Chargement des tâches…</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>Rien ici. Ajoute une tâche ci-dessus, ou change les filtres.</div>
      ) : (
        <div style={S.list}>
          {filtered.map((t) => {
            const st = STATUSES[t.status];
            const cat = CATEGORIES[t.category] || CATEGORIES.perso;
            return (
              <div key={t.id} style={S.row}>
                <button
                  className="at-btn at-focus"
                  style={{ ...S.statusBtn, color: st.color, background: st.bg }}
                  title="Cliquer pour changer le statut"
                  onClick={() => cycle(t)}
                >
                  ● {st.label}
                </button>
                <span style={{ ...S.title, textDecoration: t.status === "fait" ? "line-through" : "none", opacity: t.status === "fait" ? 0.6 : 1 }}>
                  {t.title}
                </span>
                <span style={{ ...S.catTag, color: cat.color, background: cat.bg }}>{cat.label}</span>
                {t.dueDate && (
                  <span style={{ ...S.due, color: isLate(t) ? "#B23B15" : theme.mute }}>
                    {humanDate(t)}{t.calendarEventId ? " · agenda" : ""}
                  </span>
                )}
                <button className="at-btn at-focus" style={S.rowBtn} onClick={() => setEditing(t)}>Modifier</button>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <TaskEditor
          task={editing}
          onCancel={() => setEditing(null)}
          onSave={saveEdit}
          onDelete={() => remove(editing)}
        />
      )}
    </section>
  );
}

function Chip({ active, color = theme.ink, onClick, children }) {
  return (
    <button
      className="at-btn at-focus"
      onClick={onClick}
      style={{
        fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 500, padding: "6px 12px",
        borderRadius: 999, border: "1px solid " + (active ? color : theme.line),
        background: active ? color : theme.panel, color: active ? "#fff" : theme.mute, cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function TaskEditor({ task, onCancel, onSave, onDelete }) {
  const [title, setTitle] = useState(task.title);
  const [category, setCategory] = useState(task.category);
  const [status, setStatus] = useState(task.status);
  const [allDay, setAllDay] = useState(task.dueAllDay !== false);
  const [due, setDue] = useState(
    !task.dueDate ? "" : task.dueAllDay !== false ? dayOf(task.dueDate) : localInput(task.dueDate)
  );

  const save = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      category,
      status,
      dueAllDay: allDay,
      dueDate: due ? (allDay ? due : new Date(due).toISOString()) : null,
    });
  };

  return (
    <div style={S.overlay} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ ...S.h2, marginBottom: 16 }}>Modifier la tâche</h3>
        <label style={S.label}>Intitulé</label>
        <input className="at-focus" style={S.field} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Catégorie</label>
            <select className="at-focus" style={S.field} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORY_ORDER.map((c) => (<option key={c} value={c}>{CATEGORIES[c].label}</option>))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Statut</label>
            <select className="at-focus" style={S.field} value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_ORDER.map((s) => (<option key={s} value={s}>{STATUSES[s].label}</option>))}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={S.label}>Échéance (vide = pas d’événement d’agenda)</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              className="at-focus"
              style={{ ...S.field, flex: 1 }}
              type={allDay ? "date" : "datetime-local"}
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <label style={S.check}>
              <input type="checkbox" checked={allDay} onChange={(e) => { setAllDay(e.target.checked); setDue(""); }} />
              journée entière
            </label>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, gap: 10 }}>
          <button className="at-btn at-focus" style={{ ...S.ghost, color: "#B23B15", borderColor: "#F0C6B7" }} onClick={onDelete}>Supprimer</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="at-btn at-focus" style={S.ghost} onClick={onCancel}>Annuler</button>
            <button className="at-btn at-focus" style={{ ...S.addBtn, opacity: title.trim() ? 1 : 0.5 }} onClick={save} disabled={!title.trim()}>Enregistrer</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const S = {
  wrap: { marginTop: 34 },
  head: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 },
  h2: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 700, margin: 0, color: theme.ink, letterSpacing: "-0.01em" },
  counts: { fontFamily: "Inter", fontSize: 13, color: theme.mute },
  gOk: { fontFamily: "Inter", fontSize: 12.5, color: theme.green, display: "inline-flex", alignItems: "center", gap: 8 },
  gOff: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute },
  gLink: { fontFamily: "Inter", fontSize: 12, padding: "3px 9px", borderRadius: 999, border: "1px solid " + theme.line, background: theme.panel, color: theme.mute, cursor: "pointer" },
  gBtn: { fontFamily: "Inter", fontSize: 13, fontWeight: 600, padding: "7px 13px", borderRadius: 10, border: "none", background: theme.violetSoft, color: theme.violet, cursor: "pointer" },

  addRow: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
  input: { flex: "1 1 220px", fontFamily: "Inter", fontSize: 14, padding: "10px 14px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink },
  select: { fontFamily: "Inter", fontSize: 14, padding: "10px 12px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink, cursor: "pointer" },
  date: { fontFamily: "Inter", fontSize: 13.5, padding: "9px 12px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink },
  check: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" },
  addBtn: { fontFamily: "Inter", fontSize: 14, fontWeight: 600, padding: "10px 16px", borderRadius: 11, border: "none", background: theme.violet, color: "#fff", cursor: "pointer" },

  filters: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 14 },
  msg: { fontFamily: "Inter", fontSize: 12.5, color: theme.amber, marginBottom: 10 },

  list: { display: "flex", flexDirection: "column", gap: 8 },
  row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: theme.panel, border: "1px solid " + theme.line, borderRadius: 12, padding: "10px 13px" },
  statusBtn: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, padding: "4px 10px", borderRadius: 999, border: "none", cursor: "pointer", whiteSpace: "nowrap" },
  title: { fontFamily: "Inter", fontSize: 14.5, color: theme.ink, flex: "1 1 160px", minWidth: 0 },
  catTag: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: "2px 7px", borderRadius: 6 },
  due: { fontFamily: "Inter", fontSize: 12.5, whiteSpace: "nowrap" },
  rowBtn: { fontFamily: "Inter", fontSize: 12.5, padding: "5px 11px", borderRadius: 9, border: "1px solid " + theme.line, background: theme.paper, color: theme.slate, cursor: "pointer" },

  empty: { fontFamily: "Inter", fontSize: 14, color: theme.mute, textAlign: "center", padding: "30px 20px", background: theme.panel, borderRadius: 12, border: "1px dashed " + theme.line },

  overlay: { position: "fixed", inset: 0, background: "rgba(27,26,46,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto", zIndex: 50 },
  modal: { background: theme.panel, borderRadius: 18, padding: 24, width: "100%", maxWidth: 480, boxShadow: "0 24px 60px rgba(27,26,46,.3)" },
  label: { display: "block", fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, color: theme.slate, marginBottom: 6 },
  field: { width: "100%", fontFamily: "Inter", fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.paper, color: theme.ink },
  ghost: { fontFamily: "Inter", fontSize: 13, fontWeight: 500, padding: "9px 14px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.panel, color: theme.slate, cursor: "pointer" },
};
