import React, { useEffect, useMemo, useState } from "react";
import { theme, authHeaders, canExecuteReconcile } from "./shared.js";
import { dayOf, localInput, humanDate, humanRange, isLate, startProblem } from "./dates.js";
import Stat, { statsRow } from "./Stat.jsx";
import { Chip, FilterRow, sharedStyles } from "./ui.jsx";

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
  admin: { label: "Admin", color: theme.amberDeep, bg: theme.amberSoft, agenda: "perso" },
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

export default function Tasks({ onLocked }) {
  const [tasks, setTasks] = useState(null);
  const [msg, setMsg] = useState("");
  // Réconciliation. `plan` porte l'aperçu du dry-run ; tant qu'il est null,
  // le bouton de confirmation n'existe pas — impossible d'exécuter en un clic.
  const [plan, setPlan] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [details, setDetails] = useState(false);
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
      // Un refus du serveur (400 : début après échéance, par exemple) porte
      // un message qui dit quoi corriger. Le remplacer par « injoignable »
      // ferait croire à une panne réseau.
      setMsg(e.message && e.message !== "Erreur" ? e.message : "Serveur injoignable — modification annulée.");
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

  // Aperçu : n'écrit rien, ni en base ni sur Google (dry-run côté serveur).
  const preview = async () => {
    if (reconciling) return;
    setReconciling(true); setMsg(""); setDetails(false);
    try {
      const d = await api("/api/calendar/reconcile", { method: "POST", body: JSON.stringify({}) });
      setPlan(d);
      if (d.note) setMsg(d.note);
    } catch (e) {
      if (!fail(e)) { setPlan(null); setMsg(e.message || "Vérification impossible."); }
    } finally { setReconciling(false); }
  };

  // Exécution réelle. Inatteignable sans un aperçu préalable : le bouton
  // n'est rendu que si `plan` existe, et la garde ci-dessous le redit.
  const applyPlan = async () => {
    // Même règle que celle qui décide d'afficher le bouton : les deux ne
    // peuvent pas diverger, et un appel direct ne contourne rien.
    if (!canExecuteReconcile(plan, reconciling)) return;
    setReconciling(true);
    try {
      const d = await api("/api/calendar/reconcile", { method: "POST", body: JSON.stringify({ execute: true }) });
      setPlan(null); setDetails(false);
      setMsg(
        d.checked === 0 ? (d.note || "Rien à resynchroniser.")
        : `Resynchro : ${d.adopted} adoptée(s), ${d.inserted} créée(s)` +
          (d.stillFailing ? `, ${d.stillFailing} encore en échec.` : ".")
      );
      // La liste vient de changer côté serveur : on la relit.
      const fresh = await api("/api/tasks");
      setTasks(fresh.tasks || []); cache.save(fresh.tasks || []);
    } catch (e) {
      if (!fail(e)) setMsg(e.message || "Resynchronisation impossible.");
    } finally { setReconciling(false); }
  };

  const list = tasks || [];
  // Totaux sur TOUTES les tâches : la barre de stats ne bouge pas
  // quand on filtre, comme celle des projets.
  const counts = useMemo(() => {
    const by = (s) => list.filter((t) => t.status === s).length;
    return { total: list.length, a_faire: by("a_faire"), en_cours: by("en_cours"), fait: by("fait") };
  }, [list]);

  // Badge permanent : compté sur TOUTES les tâches, filtres inclus ou non.
  const desyncCount = useMemo(() => list.filter((t) => t.syncStatus === "error").length, [list]);

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

      {/* Synchro agenda : le badge est permanent, l'aperçu précède toujours
          l'exécution. Rien de tout ça n'apparaît sans compte Google lié. */}
      {google && google.connected && (
        <div style={S.syncBar}>
          {desyncCount > 0 ? (
            <span style={S.syncBadge} title="Ces tâches n’ont pas pu être écrites dans l’agenda.">
              ⚠ {desyncCount} désynchronisée{desyncCount > 1 ? "s" : ""}
            </span>
          ) : (
            <span style={S.syncOk}>Agenda à jour</span>
          )}
          <button className="at-btn at-focus" style={S.syncBtn} onClick={preview} disabled={reconciling}>
            {reconciling ? "…" : "Vérifier la synchro agenda"}
          </button>
          {plan && (
            <>
              <span style={S.syncPlan}>
                {plan.checked === 0
                  ? "Rien à corriger."
                  : `${plan.wouldAdopt} à adopter · ${plan.wouldInsert} à créer · ${plan.wouldSkip} déjà bonne${plan.wouldSkip > 1 ? "s" : ""}`}
              </span>
              {canExecuteReconcile(plan, reconciling) && (
                <button className="at-btn at-focus" style={S.syncGo} onClick={applyPlan}>
                  Confirmer et resynchroniser
                </button>
              )}
              <button className="at-btn at-focus" style={S.syncLink} onClick={() => setPlan(null)}>Annuler</button>
            </>
          )}
        </div>
      )}

      {/* Détail par tâche : court, on l'affiche ; long, on le replie. */}
      {plan && plan.checked > 0 && (
        <div style={S.planBox}>
          {(plan.details.length <= 5 || details) ? (
            <ul style={S.planList}>
              {plan.details.map((d) => (
                <li key={d.id} style={S.planItem}>
                  <span style={{ ...S.planAction, ...(S.planActionTone[d.action] || null) }}>{PLAN_LABEL[d.action] || d.action}</span>
                  <span>{d.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <button className="at-btn at-focus" style={S.syncLink} onClick={() => setDetails(true)}>
              Voir le détail des {plan.details.length} tâches
            </button>
          )}
          {/* Le doublon est possible ici : on le dit, avant de confirmer. */}
          {plan.wouldInsert > 0 && (
            <p style={S.planWarn}>
              À créer : vérifie dans ton agenda qu’aucun de ces événements n’existe déjà. Un
              événement créé avant l’ajout du marqueur est invisible à cette vérification, et
              serait recréé en double.
            </p>
          )}
        </div>
      )}

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
                      {isLate(t) ? "⚠ " : ""}{humanRange(t)}
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

function TaskEditor({ task, onCancel, onSave, onDelete }) {
  const [title, setTitle] = useState(task.title);
  const [category, setCategory] = useState(task.category);
  const [status, setStatus] = useState(task.status);
  const [urgency, setUrgency] = useState(task.urgency || "normale");
  const [allDay, setAllDay] = useState(task.dueAllDay !== false);
  const [due, setDue] = useState(
    !task.dueDate ? "" : task.dueAllDay !== false ? dayOf(task.dueDate) : localInput(task.dueDate)
  );
  const [start, setStart] = useState(task.startDate || "");

  // L'échéance ramenée au jour, pour comparer au début qui, lui, est un jour.
  const dueDay = due ? due.slice(0, 10) : "";
  const souci = startProblem(start, dueDay);

  const save = () => {
    if (!title.trim() || souci) return;
    onSave({
      title: title.trim(),
      category,
      status,
      urgency,
      dueAllDay: allDay,
      dueDate: due ? (allDay ? due : new Date(due).toISOString()) : null,
      startDate: start || null,
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
        <div style={{ marginTop: 12 }}>
          <label style={S.label}>Début (facultatif — pour une tâche qui s’étale)</label>
          <input
            className="at-focus"
            style={{ ...S.field, borderColor: souci ? theme.red : theme.line }}
            type="date"
            value={start}
            max={dueDay || undefined}
            onChange={(e) => setStart(e.target.value)}
          />
          {souci && <div style={S.startError}>{souci}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, gap: 10 }}>
          <button className="at-btn at-focus" style={{ ...S.ghost, color: "#B23B15", borderColor: "#F0C6B7" }} onClick={onDelete}>Supprimer</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="at-btn at-focus" style={S.ghost} onClick={onCancel}>Annuler</button>
            <button
              className="at-btn at-focus"
              style={{ ...S.addBtn, opacity: title.trim() && !souci ? 1 : 0.5 }}
              onClick={save}
              disabled={!title.trim() || !!souci}
            >
              Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const PLAN_LABEL = { adopt: "à adopter", insert: "à créer", skip: "déjà bonne", error: "erreur" };

const S = {
  ...sharedStyles,

  syncBar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 },
  syncBadge: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, padding: "4px 10px", borderRadius: 999, background: "#FBE9E9", color: theme.red, whiteSpace: "nowrap" },
  syncOk: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute },
  syncBtn: { fontFamily: "Inter", fontSize: 13, fontWeight: 500, padding: "6px 12px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.panel, color: theme.slate, cursor: "pointer" },
  syncGo: { fontFamily: "Inter", fontSize: 13, fontWeight: 600, padding: "6px 13px", borderRadius: 10, border: "none", background: theme.violet, color: "#fff", cursor: "pointer" },
  syncLink: { fontFamily: "Inter", fontSize: 12.5, padding: "5px 8px", borderRadius: 8, border: "none", background: "transparent", color: theme.mute, cursor: "pointer", textDecoration: "underline" },
  syncPlan: { fontFamily: "Inter", fontSize: 12.5, color: theme.ink },
  planBox: { background: theme.panel, border: "1px solid " + theme.line, borderRadius: 12, padding: "12px 14px", marginBottom: 14 },
  planList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 },
  planItem: { display: "flex", alignItems: "center", gap: 9, fontFamily: "Inter", fontSize: 13, color: theme.ink },
  planAction: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, padding: "2px 7px", borderRadius: 6, whiteSpace: "nowrap", flexShrink: 0 },
  planActionTone: {
    adopt: { background: theme.violetSoft, color: theme.violet },
    insert: { background: theme.amberSoft, color: theme.amberDeep },
    skip: { background: theme.doneGreySoft, color: theme.doneGrey },
    error: { background: "#FBE9E9", color: theme.red },
  },
  planWarn: { fontFamily: "Inter", fontSize: 12, color: theme.amberDeep, margin: "10px 0 0", lineHeight: 1.5 },

  // Propre à l'onglet Tâches.
  gOk: { fontFamily: "Inter", fontSize: 12.5, color: theme.green, display: "inline-flex", alignItems: "center", gap: 8 },
  gOff: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute },
  gLink: { fontFamily: "Inter", fontSize: 12, padding: "3px 9px", borderRadius: 999, border: "1px solid " + theme.line, background: theme.panel, color: theme.mute, cursor: "pointer" },
  gBtn: { fontFamily: "Inter", fontSize: 13, fontWeight: 600, padding: "7px 13px", borderRadius: 10, border: "none", background: theme.violetSoft, color: theme.violet, cursor: "pointer" },
  routeHint: { fontFamily: "Inter", fontSize: 11.5, color: theme.mute, marginTop: 7 },
  warnBar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: theme.amberSoft, border: "1px solid #F0DCB0", borderRadius: 11, padding: "10px 13px", marginBottom: 14, fontFamily: "Inter", fontSize: 13, color: theme.ink },
  startError: { fontFamily: "Inter", fontSize: 12, color: theme.red, marginTop: 6 },
  urgBadge: { fontFamily: "Inter", fontSize: 10.5, fontWeight: 700, letterSpacing: ".02em", padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 },
};
