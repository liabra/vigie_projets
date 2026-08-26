import React, { useEffect, useMemo, useState } from "react";
import { theme, authHeaders } from "./shared.js";
import Stat, { statsRow } from "./Stat.jsx";

// ─────────────────────────────────────────────────────────────
//  Tâches — perso / admin / dev, avec échéance facultative.
//  Même logique que les projets : cache localStorage pour
//  l'affichage instantané, serveur comme source de vérité.
//  Une tâche datée est poussée vers l'agenda Google « Vigie »
//  par le serveur (sens unique, jamais l'inverse).
// ─────────────────────────────────────────────────────────────

const CACHE_KEY = "vigie:tasks";

// La catégorie décide aussi de l'agenda de destination (voir google.js) :
// dev et boulot vont dans l'agenda « Vigie », perso et admin dans l'agenda
// principal du compte Google.
const CATEGORIES = {
  perso: { label: "Perso", color: theme.teal, bg: "#E1F0F2", agenda: "perso" },
  admin: { label: "Admin", color: theme.amber, bg: theme.amberSoft, agenda: "perso" },
  dev: { label: "Dev", color: theme.violet, bg: theme.violetSoft, agenda: "vigie" },
  boulot: { label: "Boulot", color: theme.work, bg: theme.workSoft, agenda: "vigie" },
};
const CATEGORY_ORDER = ["perso", "admin", "dev", "boulot"];

// Le statut colore la carte entière (liseré + pastille). « Fait »
// reprend le gris + ✓ de l'agenda, pour que les deux se ressemblent.
const STATUSES = {
  a_faire: { label: "À faire", color: theme.orange, bg: theme.orangeSoft },
  en_cours: { label: "En cours", color: theme.statusViolet, bg: theme.statusVioletSoft },
  fait: { label: "✓ Fait", color: theme.doneGrey, bg: theme.doneGreySoft },
};
const STATUS_ORDER = ["a_faire", "en_cours", "fait"];
const NEXT_STATUS = { a_faire: "en_cours", en_cours: "fait", fait: "a_faire" };

// L'urgence est un canal SÉPARÉ du statut : jamais de liseré, seulement
// un badge. Elle reste interne à Vigie et ne part pas vers l'agenda.
const URGENCIES = {
  normale: { label: "Normale", badge: null },
  importante: {
    label: "Importante",
    badge: "Important",
    style: { color: theme.ink, background: theme.panel, border: "1.5px solid " + theme.ink },
  },
  urgente: {
    label: "Urgente",
    badge: "● Urgent",
    style: { color: "#FFFFFF", background: theme.red, border: "1.5px solid " + theme.red },
  },
};
const URGENCY_ORDER = ["normale", "importante", "urgente"];

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
  const [urgFilter, setUrgFilter] = useState("toutes");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(null);

  // Nouvelle tâche
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("perso");
  const [due, setDue] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [urgency, setUrgency] = useState("normale");

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
        body: JSON.stringify({ title: t, category, urgency, dueDate: due || null, dueAllDay: allDay }),
      });
      apply([...(tasks || []), d.task]);
      setTitle(""); setDue(""); setUrgency("normale");
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
  // Totaux sur TOUTES les tâches : la barre de stats ne bouge pas
  // quand on filtre, comme celle des projets.
  const counts = useMemo(() => {
    const by = (s) => list.filter((t) => t.status === s).length;
    return { total: list.length, a_faire: by("a_faire"), en_cours: by("en_cours"), fait: by("fait") };
  }, [list]);

  const filtered = useMemo(
    () =>
      list
        .filter((t) => statusFilter === "tous" || t.status === statusFilter)
        .filter((t) => catFilter === "toutes" || t.category === catFilter)
        .filter((t) => urgFilter === "toutes" || (t.urgency || "normale") === urgFilter),
    [list, statusFilter, catFilter, urgFilter]
  );

  return (
    <section style={S.wrap}>
      <div style={S.head}>
        <h2 style={S.h2}>Tâches</h2>
        <div style={{ marginLeft: "auto" }}>
          {google && google.connected && !google.needsReconsent && (
            <span style={S.gOk}>
              Agendas connectés
              <button className="at-btn at-focus" style={S.gLink} onClick={connectGoogle}>reconnecter</button>
              <button className="at-btn at-focus" style={S.gLink} onClick={disconnectGoogle}>délier</button>
            </span>
          )}
          {google && google.configured && !google.connected && (
            <button className="at-btn at-focus" style={S.gBtn} onClick={connectGoogle}>Connecter l’agenda Google</button>
          )}
          {google && !google.configured && <span style={S.gOff}>Agenda Google non configuré</span>}
        </div>
      </div>

      {google && google.connected && google.needsReconsent && (
        <div style={S.warnBar}>
          <span>
            <strong>Nouveaux droits à accorder.</strong> Les tâches <em>perso</em> et
            <em> admin</em> vont maintenant dans ton agenda principal, ce que l’autorisation
            actuelle ne permet pas. Les tâches sont enregistrées, mais l’agenda ne suivra
            qu’après un nouveau consentement.
          </span>
          <button className="at-btn at-focus" style={{ ...S.gBtn, marginLeft: "auto" }} onClick={connectGoogle}>
            Reconnecter l’agenda Google
          </button>
        </div>
      )}

      <div style={statsRow}>
        <Stat n={counts.total} label="tâches" color={theme.ink} />
        <Stat n={counts.a_faire} label="à faire" color={STATUSES.a_faire.color} />
        <Stat n={counts.en_cours} label="en cours" color={STATUSES.en_cours.color} />
        <Stat n={counts.fait} label="fait" color={STATUSES.fait.color} />
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
        <select className="at-focus" style={S.select} value={urgency} onChange={(e) => setUrgency(e.target.value)} title="Niveau d’urgence">
          {URGENCY_ORDER.map((u) => (<option key={u} value={u}>{URGENCIES[u].label}</option>))}
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
        <FilterRow label="Statut">
          <Chip active={statusFilter === "tous"} onClick={() => setStatusFilter("tous")}>Toutes</Chip>
          {STATUS_ORDER.map((s) => (
            <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>{STATUSES[s].label}</Chip>
          ))}
        </FilterRow>
        <FilterRow label="Catégorie">
          <Chip active={catFilter === "toutes"} onClick={() => setCatFilter("toutes")}>Toutes</Chip>
          {CATEGORY_ORDER.map((c) => (
            <Chip key={c} active={catFilter === c} onClick={() => setCatFilter(c)}>{CATEGORIES[c].label}</Chip>
          ))}
        </FilterRow>
        <FilterRow label="Urgence">
          <Chip active={urgFilter === "toutes"} onClick={() => setUrgFilter("toutes")}>Toutes</Chip>
          {URGENCY_ORDER.map((u) => (
            <Chip key={u} active={urgFilter === u} onClick={() => setUrgFilter(u)}>{URGENCIES[u].label}</Chip>
          ))}
        </FilterRow>
      </div>

      {msg && <div style={S.msg}>{msg}</div>}

      {tasks === null ? (
        <div style={S.empty}>Chargement des tâches…</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>Rien ici. Ajoute une tâche ci-dessus, ou change les filtres.</div>
      ) : (
        <div style={S.grid}>
          {filtered.map((t) => {
            const st = STATUSES[t.status];
            const cat = CATEGORIES[t.category] || CATEGORIES.perso;
            const urg = URGENCIES[t.urgency] || URGENCIES.normale;
            const done = t.status === "fait";
            return (
              <article key={t.id} className="at-card" style={{ ...S.card, borderColor: done ? theme.line : st.color + "44" }}>
                {/* Liseré latéral : la couleur de statut, comme sur les cartes projet. */}
                <div style={{ ...S.spine, background: st.color, opacity: done ? 0.45 : 1 }} />
                <div style={S.cardBody}>
                  <div style={S.cardTop}>
                    <h3 style={{ ...S.cardTitle, textDecoration: done ? "line-through" : "none", color: done ? theme.mute : theme.ink }}>
                      {t.title}
                    </h3>
                    {urg.badge && (
                      <span style={{ ...S.urgBadge, ...urg.style, opacity: done ? 0.45 : 1 }}>{urg.badge}</span>
                    )}
                  </div>
                  <div style={S.cardMeta}>
                    <button
                      className="at-btn at-focus"
                      style={{ ...S.statusBtn, color: st.color, background: st.bg }}
                      title="Cliquer pour changer le statut"
                      onClick={() => cycle(t)}
                    >
                      {done ? "" : "● "}{st.label}
                    </button>
                    <span style={{ ...S.catTag, color: cat.color, background: cat.bg }}>{cat.label}</span>
                  </div>
                  {t.dueDate && (
                    <div style={{ ...S.due, color: isLate(t) ? theme.red : theme.mute }}>
                      {isLate(t) ? "⚠ " : ""}{humanDate(t)}
                      {t.calendarEventId ? (t.calendarId === "primary" ? " · agenda perso" : " · agenda Vigie") : ""}
                    </div>
                  )}
                  <div style={S.cardActions}>
                    <button className="at-btn at-focus" style={S.rowBtn} onClick={() => setEditing(t)}>Modifier</button>
                  </div>
                </div>
              </article>
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

// Une ligne de filtre = un intitulé de dimension (simple texte, JAMAIS
// cliquable) suivi de ses pastilles. Le tout passe à la ligne sur mobile.
function FilterRow({ label, children }) {
  return (
    <div style={S.filterRow}>
      <span style={S.filterLabel}>{label}</span>
      <div style={S.filterChips}>{children}</div>
    </div>
  );
}

// Pastille active en violet plein, comme l'onglet actif ; inactive en
// simple contour. Une seule couleur d'état : ce qui est plein est choisi.
function Chip({ active, onClick, children }) {
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

function TaskEditor({ task, onCancel, onSave, onDelete }) {
  const [title, setTitle] = useState(task.title);
  const [category, setCategory] = useState(task.category);
  const [status, setStatus] = useState(task.status);
  const [urgency, setUrgency] = useState(task.urgency || "normale");
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
      urgency,
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
        <div style={S.routeHint}>
          {CATEGORIES[category]?.agenda === "vigie"
            ? "Cette catégorie va dans l’agenda « Vigie »."
            : "Cette catégorie va dans ton agenda principal."}
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={S.label}>Urgence (interne à Vigie — n’apparaît pas dans l’agenda)</label>
          <select className="at-focus" style={S.field} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            {URGENCY_ORDER.map((u) => (<option key={u} value={u}>{URGENCIES[u].label}</option>))}
          </select>
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
  wrap: { marginTop: 0 },
  head: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 },
  h2: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 700, margin: 0, color: theme.ink, letterSpacing: "-0.01em" },
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

  filters: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  filterRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  filterLabel: { fontFamily: "Inter, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: theme.mute, minWidth: 74, flexShrink: 0 },
  filterChips: { display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 },
  msg: { fontFamily: "Inter", fontSize: 12.5, color: theme.amber, marginBottom: 10 },
  routeHint: { fontFamily: "Inter", fontSize: 11.5, color: theme.mute, marginTop: 7 },
  warnBar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: theme.amberSoft, border: "1px solid #F0DCB0", borderRadius: 11, padding: "10px 13px", marginBottom: 14, fontFamily: "Inter", fontSize: 13, color: theme.ink },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 },
  card: { position: "relative", background: theme.panel, borderRadius: 14, border: "1px solid " + theme.line, overflow: "hidden", display: "flex" },
  spine: { width: 5, flexShrink: 0 },
  cardBody: { padding: "13px 15px", flex: 1, minWidth: 0 },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  cardTitle: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 15.5, fontWeight: 600, margin: 0, lineHeight: 1.3 },
  cardMeta: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 },
  cardActions: { display: "flex", gap: 8, marginTop: 12 },
  urgBadge: { fontFamily: "Inter", fontSize: 10.5, fontWeight: 700, letterSpacing: ".02em", padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 },
  statusBtn: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, padding: "4px 10px", borderRadius: 999, border: "none", cursor: "pointer", whiteSpace: "nowrap" },
  catTag: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: "2px 7px", borderRadius: 6 },
  due: { fontFamily: "Inter", fontSize: 12.5, marginTop: 10 },
  rowBtn: { fontFamily: "Inter", fontSize: 12.5, padding: "5px 11px", borderRadius: 9, border: "1px solid " + theme.line, background: theme.paper, color: theme.slate, cursor: "pointer" },

  empty: { fontFamily: "Inter", fontSize: 14, color: theme.mute, textAlign: "center", padding: "30px 20px", background: theme.panel, borderRadius: 12, border: "1px dashed " + theme.line },

  overlay: { position: "fixed", inset: 0, background: "rgba(27,26,46,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto", zIndex: 50 },
  modal: { background: theme.panel, borderRadius: 18, padding: 24, width: "100%", maxWidth: 480, boxShadow: "0 24px 60px rgba(27,26,46,.3)" },
  label: { display: "block", fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, color: theme.slate, marginBottom: 6 },
  field: { width: "100%", fontFamily: "Inter", fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.paper, color: theme.ink },
  ghost: { fontFamily: "Inter", fontSize: 13, fontWeight: 500, padding: "9px 14px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.panel, color: theme.slate, cursor: "pointer" },
};
