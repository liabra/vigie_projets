import React, { useEffect, useMemo, useState } from "react";
import { theme, authHeaders } from "./shared.js";
import Stat, { statsRow } from "./Stat.jsx";
import { Chip, FilterRow, LinkBtn, sharedStyles, isWebUrl } from "./ui.jsx";

// ─────────────────────────────────────────────────────────────
//  Articles — suivi de rédaction, de l'idée à la mise en ligne.
//  Même mécanique que les tâches : cache localStorage pour
//  l'affichage instantané, serveur comme source de vérité.
//  Un article daté est poussé par le serveur dans l'agenda
//  « Vigie – Articles » (sens unique).
// ─────────────────────────────────────────────────────────────

const CACHE_KEY = "vigie:articles";

// « redaction » reprend le violet « en cours » des tâches, « en_ligne »
// le gris + ✓ d'une tâche faite. Idée et brouillon sont deux teintes
// distinctes, toutes deux au-dessus du seuil AA sur leur fond.
const STATUSES = {
  idee: { label: "Idée", color: theme.indigo, bg: theme.indigoSoft },
  brouillon: { label: "Brouillon", color: theme.orange, bg: theme.orangeSoft },
  redaction: { label: "Rédaction", color: theme.statusViolet, bg: theme.statusVioletSoft },
  en_ligne: { label: "✓ En ligne", color: theme.doneGrey, bg: theme.doneGreySoft },
};
const STATUS_ORDER = ["idee", "brouillon", "redaction", "en_ligne"];
const NEXT_STATUS = { idee: "brouillon", brouillon: "redaction", redaction: "en_ligne", en_ligne: "idee" };

// Les trois liens d'un article, dans l'ordre où ils servent.
const LINKS = [
  { field: "promptUrl", label: "Prompt" },
  { field: "docUrl", label: "Doc" },
  { field: "notebooklmUrl", label: "NotebookLM" },
];

const cache = {
  load() { try { const r = localStorage.getItem(CACHE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } },
  save(a) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(a)); } catch {} },
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

// Les dates de sortie sont rangées à minuit UTC : on les lit en UTC,
// sinon le fuseau les ferait glisser d'un jour.
const dayOf = (iso) => (iso || "").slice(0, 10);
const humanDate = (iso) =>
  new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function Articles({ onLocked }) {
  const [articles, setArticles] = useState(null);
  const [msg, setMsg] = useState("");
  const [statusFilter, setStatusFilter] = useState("tous");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  // Nouvel article
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("idee");
  const [release, setRelease] = useState("");

  const fail = (e) => {
    if (e && e.code === 401) { onLocked && onLocked(); return true; }
    return false;
  };

  useEffect(() => {
    const cached = cache.load();
    if (cached) setArticles(cached);
    api("/api/articles")
      .then((d) => { setArticles(d.articles || []); cache.save(d.articles || []); setMsg(""); })
      .catch((e) => {
        if (fail(e)) return;
        if (!cached) setArticles([]);
        setMsg("Hors-ligne — articles affichés depuis le cache.");
      });
  }, []); // eslint-disable-line

  const apply = (next) => { setArticles(next); cache.save(next); };

  // Modification optimiste : on affiche tout de suite, et on revient
  // en arrière si le serveur refuse.
  const mutate = async (next, run) => {
    const before = articles;
    apply(next);
    try {
      const d = await run();
      if (d && d.article) apply(next.map((a) => (a.id === d.article.id ? d.article : a)));
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
      const d = await api("/api/articles", {
        method: "POST",
        body: JSON.stringify({ title: t, status, releaseDate: release || null }),
      });
      apply([...(articles || []), d.article]);
      setTitle(""); setRelease(""); setStatus("idee");
      setMsg(d.syncWarning || "");
    } catch (e) {
      if (!fail(e)) setMsg(e.message || "L’article n’a pas pu être créé.");
    } finally { setBusy(false); }
  };

  const cycle = (article) => {
    const next = NEXT_STATUS[article.status];
    mutate(
      articles.map((a) => (a.id === article.id ? { ...a, status: next } : a)),
      () => api("/api/articles/" + article.id, { method: "PATCH", body: JSON.stringify({ status: next }) })
    );
  };

  const saveEdit = (patch) => {
    const article = editing;
    setEditing(null);
    mutate(
      articles.map((a) => (a.id === article.id ? { ...a, ...patch } : a)),
      () => api("/api/articles/" + article.id, { method: "PATCH", body: JSON.stringify(patch) })
    );
  };

  const remove = async (article) => {
    setEditing(null);
    const before = articles;
    apply(articles.filter((a) => a.id !== article.id));
    try {
      const d = await api("/api/articles/" + article.id, { method: "DELETE" });
      setMsg(d.syncWarning || "");
    } catch (e) {
      if (fail(e)) return;
      apply(before);
      setMsg("Suppression impossible — serveur injoignable.");
    }
  };

  const list = articles || [];
  // Totaux sur TOUS les articles : la barre ne bouge pas quand on filtre.
  const counts = useMemo(() => {
    const by = (s) => list.filter((a) => a.status === s).length;
    return { total: list.length, idee: by("idee"), brouillon: by("brouillon"), redaction: by("redaction"), en_ligne: by("en_ligne") };
  }, [list]);

  const filtered = useMemo(
    () => list.filter((a) => statusFilter === "tous" || a.status === statusFilter),
    [list, statusFilter]
  );

  return (
    <section style={S.wrap}>
      <div style={S.head}>
        <h2 style={S.h2}>Articles</h2>
      </div>

      <div style={statsRow}>
        <Stat n={counts.total} label="articles" color={theme.ink} />
        <Stat n={counts.idee} label="idée" color={STATUSES.idee.color} />
        <Stat n={counts.brouillon} label="brouillon" color={STATUSES.brouillon.color} />
        <Stat n={counts.redaction} label="rédaction" color={STATUSES.redaction.color} />
        <Stat n={counts.en_ligne} label="en ligne" color={STATUSES.en_ligne.color} />
      </div>

      {/* Pas de <form> : un bouton et une touche Entrée suffisent. */}
      <div style={S.addRow}>
        <input
          className="at-focus"
          style={S.input}
          placeholder="Ajouter un article…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <select className="at-focus" style={S.select} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_ORDER.map((s) => (<option key={s} value={s}>{STATUSES[s].label.replace("✓ ", "")}</option>))}
        </select>
        <input
          className="at-focus"
          style={S.date}
          type="date"
          value={release}
          onChange={(e) => setRelease(e.target.value)}
          title="Date de sortie (facultative)"
        />
        <button className="at-btn at-focus" style={{ ...S.addBtn, opacity: title.trim() && !busy ? 1 : 0.5 }} onClick={add} disabled={!title.trim() || busy}>
          {busy ? "…" : "+ Ajouter"}
        </button>
      </div>

      <div style={S.filters}>
        <FilterRow label="Statut">
          <Chip active={statusFilter === "tous"} onClick={() => setStatusFilter("tous")}>Tous</Chip>
          {STATUS_ORDER.map((s) => (
            <Chip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>{STATUSES[s].label}</Chip>
          ))}
        </FilterRow>
      </div>

      {msg && <div style={S.msg}>{msg}</div>}

      {articles === null ? (
        <div style={S.empty}>Chargement des articles…</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>Aucun article. Ajoutes-en un ci-dessus, ou change le filtre.</div>
      ) : (
        <div style={S.grid}>
          {filtered.map((a) => {
            const st = STATUSES[a.status] || STATUSES.idee;
            const online = a.status === "en_ligne";
            const links = LINKS.filter((l) => isWebUrl(a[l.field]));
            return (
              <article key={a.id} className="at-card" style={{ ...S.card, borderColor: online ? theme.line : st.color + "44" }}>
                {/* Liseré latéral : la couleur de statut, comme les cartes de tâches. */}
                <div style={{ ...S.spine, background: st.color, opacity: online ? 0.45 : 1 }} />
                <div style={S.cardBody}>
                  <div style={S.cardTop}>
                    <h3 style={{ ...S.cardTitle, textDecoration: online ? "line-through" : "none", color: online ? theme.mute : theme.ink }}>
                      {a.title}
                    </h3>
                  </div>
                  <div style={S.cardMeta}>
                    <button
                      className="at-btn at-focus"
                      style={{ ...S.statusBtn, color: st.color, background: st.bg }}
                      title="Cliquer pour changer le statut"
                      onClick={() => cycle(a)}
                    >
                      {online ? "" : "● "}{st.label}
                    </button>
                  </div>
                  {a.releaseDate && (
                    <div style={{ ...S.due, color: theme.mute }}>
                      Sortie {humanDate(a.releaseDate)}{a.calendarEventId ? " · agenda" : ""}
                    </div>
                  )}
                  {links.length > 0 && (
                    <div style={{ ...S.cardActions, marginTop: 10 }}>
                      {links.map((l) => (<LinkBtn key={l.field} href={a[l.field]}>{l.label}</LinkBtn>))}
                    </div>
                  )}
                  <div style={S.cardActions}>
                    <button className="at-btn at-focus" style={S.rowBtn} onClick={() => setEditing(a)}>Modifier</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editing && (
        <ArticleEditor
          article={editing}
          onCancel={() => setEditing(null)}
          onSave={saveEdit}
          onDelete={() => remove(editing)}
        />
      )}
    </section>
  );
}

function ArticleEditor({ article, onCancel, onSave, onDelete }) {
  const [f, setF] = useState({
    title: article.title,
    status: article.status,
    releaseDate: dayOf(article.releaseDate),
    promptUrl: article.promptUrl || "",
    docUrl: article.docUrl || "",
    notebooklmUrl: article.notebooklmUrl || "",
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  // Un lien non vide qui ne ressemble pas à une adresse web bloque
  // l'enregistrement : le serveur le refuserait de toute façon.
  const badLink = LINKS.some((l) => f[l.field].trim() && !isWebUrl(f[l.field]));

  const save = () => {
    if (!f.title.trim() || badLink) return;
    onSave({
      title: f.title.trim(),
      status: f.status,
      releaseDate: f.releaseDate || null,
      promptUrl: f.promptUrl.trim(),
      docUrl: f.docUrl.trim(),
      notebooklmUrl: f.notebooklmUrl.trim(),
    });
  };

  return (
    <div style={S.overlay} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ ...S.h2, fontSize: 19, marginBottom: 16 }}>Modifier l’article</h3>
        <label style={S.label}>Titre</label>
        <input className="at-focus" style={S.field} value={f.title} onChange={(e) => set("title", e.target.value)} autoFocus />
        <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Statut</label>
            <select className="at-focus" style={S.field} value={f.status} onChange={(e) => set("status", e.target.value)}>
              {STATUS_ORDER.map((s) => (<option key={s} value={s}>{STATUSES[s].label.replace("✓ ", "")}</option>))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Date de sortie</label>
            <input className="at-focus" style={S.field} type="date" value={f.releaseDate} onChange={(e) => set("releaseDate", e.target.value)} />
          </div>
        </div>
        {LINKS.map((l) => (
          <div key={l.field} style={{ marginTop: 12 }}>
            <label style={S.label}>{l.label} (facultatif)</label>
            <input
              className="at-focus"
              style={{ ...S.field, borderColor: f[l.field].trim() && !isWebUrl(f[l.field]) ? theme.red : theme.line }}
              value={f[l.field]}
              onChange={(e) => set(l.field, e.target.value)}
              placeholder="https://…"
            />
          </div>
        ))}
        {badLink && <div style={S.linkError}>Un lien doit commencer par http:// ou https://.</div>}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, gap: 10 }}>
          <button className="at-btn at-focus" style={{ ...S.ghost, color: "#B23B15", borderColor: "#F0C6B7" }} onClick={onDelete}>Supprimer</button>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="at-btn at-focus" style={S.ghost} onClick={onCancel}>Annuler</button>
            <button
              className="at-btn at-focus"
              style={{ ...S.addBtn, opacity: f.title.trim() && !badLink ? 1 : 0.5 }}
              onClick={save}
              disabled={!f.title.trim() || badLink}
            >
              Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const S = {
  ...sharedStyles,
  linkError: { fontFamily: "Inter", fontSize: 12, color: theme.red, marginTop: 10 },
};
