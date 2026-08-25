import React, { useState, useEffect, useMemo, useRef } from "react";

// ─────────────────────────────────────────────────────────────
//  Vigie — suivi de projets avec copilote IA
//  Synchro entre appareils via le serveur (/api/projects).
//  Cache localStorage pour l'affichage instantané + hors-ligne.
// ─────────────────────────────────────────────────────────────

const theme = {
  ink: "#1B1A2E", paper: "#F3F4FA", panel: "#FFFFFF", line: "#E4E5F1",
  violet: "#5B3DF5", violetSoft: "#ECE8FF", amber: "#D9930A", amberSoft: "#FCF1DA",
  green: "#11875B", greenSoft: "#DFF3E9", teal: "#2A7E8C", slate: "#5A6478", mute: "#6C6B85",
};

const STATUSES = {
  "idée":     { label: "Idée",     color: theme.slate,  bg: "#EAECF3" },
  "en cours": { label: "En cours", color: theme.violet, bg: theme.violetSoft },
  "en pause": { label: "En pause", color: theme.amber,  bg: theme.amberSoft },
  "publié":   { label: "Publié",   color: theme.green,  bg: theme.greenSoft },
  "terminé":  { label: "Terminé",  color: theme.teal,   bg: "#E1F0F2" },
};
const STATUS_ORDER = ["idée", "en cours", "en pause", "publié", "terminé"];

const SOURCES = {
  claude:  { label: "Claude",  color: theme.violet, bg: theme.violetSoft },
  chatgpt: { label: "ChatGPT", color: "#0E8267",    bg: "#DCF1EB" },
  autre:   { label: "Autre",   color: theme.slate,  bg: "#EAECF3" },
};

const uid = () => Math.random().toString(36).slice(2, 10);

const SEED = [
  { name: "CrushNow", source: "claude", status: "en cours", type: "Jeu / App", stack: ["Android", "AAB", "Play Store"], repo: "", nextStep: "Finir la section Data Safety, configurer la fiche Play Store (titre, description, captures, icône, feature graphic), uploader l’AAB, lancer le test fermé (12 testeurs).", notes: "Publication Play Store en cours." },
  { name: "StepCity", source: "claude", status: "en cours", type: "Jeu", stack: ["React", "Vite", "PWA", "Health Connect"], repo: "", nextStep: "", notes: "City-builder qui grandit avec l’activité physique. Prototype PWA fait : rendu pixel isométrique, offline." },
  { name: "Jeu de gestion d’hôtel", source: "claude", status: "idée", type: "Jeu", stack: ["React", "Vite"], repo: "", nextStep: "", notes: "Concept de jeu de gestion pour Android." },
  { name: "StoryForge", source: "claude", status: "en cours", type: "Jeu d’écriture", stack: ["React", "TypeScript", "Node", "Prisma", "PostgreSQL", "Railway"], repo: "liabra/storyforgePrototype", nextStep: "Peaufiner la webapp jusqu’à la rendre parfaite avant de packager en APK pour le Play Store.", notes: "Écriture collaborative avec Maître du Jeu IA — « un ami discret » qui enrichit sans gérer ni épier." },
  { name: "Ma Tirelire Magique", source: "claude", status: "terminé", type: "App enfants", stack: ["React", "Vite", "Tailwind", "PWA"], repo: "liabra/bank_kids", nextStep: "", notes: "Finance éducative : espace parent PIN, simulations d’investissement, badges." },
  { name: "Tableau des Champions", source: "claude", status: "terminé", type: "App enfants", stack: ["React", "TypeScript", "Vite", "Tailwind", "PWA"], repo: "liabra/kids-pwa", nextStep: "", notes: "Tâches / récompenses : points, défis." },
  { name: "Site A2C — retranscription", source: "claude", status: "terminé", type: "Client", stack: ["Site vitrine", "Railway"], repo: "", nextStep: "", notes: "Site vitrine livré. Cliente : Mme Kpodar Muriel." },
  { name: "Dashboard retranscriptions_mk", source: "claude", status: "en cours", type: "Client", stack: ["FastAPI", "PostgreSQL", "JWT"], repo: "retranscriptions_mk", nextStep: "", notes: "Fonction d’upload prestataire intégrée." },
  { name: "Système qualité A2C", source: "claude", status: "terminé", type: "Client", stack: ["Google Sheets", "Apps Script"], repo: "", nextStep: "", notes: "Sheets V2 + 7 scripts : génération de docs, dossiers Drive, substitution de variables." },
  { name: "Détection de pièces LEGO", source: "claude", status: "terminé", type: "Outil", stack: ["FastAPI", "SQLite", "Claude Vision", "Rebrickable"], repo: "", nextStep: "", notes: "" },
  { name: "Trieur Playmobil", source: "claude", status: "terminé", type: "Outil", stack: ["Python"], repo: "liabra/playmobil_trieur", nextStep: "", notes: "Utilise les notices PDF comme données de référence." },
  { name: "Mission Conjugaison", source: "claude", status: "terminé", type: "App enfants", stack: ["PWA", "Replit"], repo: "", nextStep: "", notes: "Conjugaison française, thème spatial." },
  { name: "Tables de multiplication", source: "claude", status: "terminé", type: "App enfants", stack: ["SRS Leitner"], repo: "", nextStep: "", notes: "Mode DYS, répétition espacée, tableau de progression." },
  { name: "Bible Duo", source: "claude", status: "terminé", type: "Foi", stack: [], repo: "", nextStep: "", notes: "Du catalogue apps éducatives / foi." },
  { name: "Flashcards Bibliques", source: "claude", status: "terminé", type: "Foi", stack: [], repo: "", nextStep: "", notes: "" },
  { name: "Mémoire Musicale", source: "claude", status: "terminé", type: "Éducatif", stack: [], repo: "", nextStep: "", notes: "" },
  { name: "LactaCare", source: "claude", status: "terminé", type: "Santé", stack: [], repo: "", nextStep: "", notes: "Soutien à l’allaitement." },
].map((p) => ({ id: uid(), updatedAt: Date.now(), ...p }));

const CACHE_KEY = "vigie:projects";
const APPKEY_KEY = "vigie:key";

const getKey = () => { try { return localStorage.getItem(APPKEY_KEY) || ""; } catch { return ""; } };
const setKey = (k) => { try { localStorage.setItem(APPKEY_KEY, k); } catch {} };
const authHeaders = () => { const k = getKey(); return k ? { "x-app-key": k } : {}; };

const cache = {
  load() { try { const r = localStorage.getItem(CACHE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } },
  save(p) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(p)); } catch {} },
};

// ── Serveur ───────────────────────────────────────────────────
async function serverGet() {
  const r = await fetch("/api/projects", { headers: authHeaders() });
  if (r.status === 401) throw { code: 401 };
  const d = await r.json().catch(() => ({}));
  return Array.isArray(d.projects) ? d.projects : null;
}
async function serverPut(projects) {
  const r = await fetch("/api/projects", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ projects }),
  });
  if (r.status === 401) throw { code: 401 };
}
async function askClaude(prompt) {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Accès verrouillé — recharge la page pour entrer le code.");
  if (!res.ok) throw new Error(data.error || "Erreur");
  return (data.text || "").trim();
}

function serialise(projects) {
  return projects
    .map((p) => {
      const bits = [
        `- ${p.name} [${STATUSES[p.status]?.label || p.status}, source: ${SOURCES[p.source]?.label || p.source}, type: ${p.type || "—"}]`,
      ];
      if (p.stack?.length) bits.push(`  stack: ${p.stack.join(", ")}`);
      if (p.repo) bits.push(`  repo: ${p.repo}`);
      if (p.nextStep) bits.push(`  prochaine étape: ${p.nextStep}`);
      if (p.notes) bits.push(`  notes: ${p.notes}`);
      return bits.join("\n");
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState(null);
  const [locked, setLocked] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("tous");
  const [sourceFilter, setSourceFilter] = useState("tous");
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [cardAI, setCardAI] = useState({});

  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");

  const saveTimer = useRef(null);

  // Styles + polices
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; } body { margin: 0; }
      .at-focus:focus-visible { outline: 2.5px solid ${theme.violet}; outline-offset: 2px; }
      .at-card { transition: transform .12s ease, box-shadow .12s ease; }
      .at-card:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(27,26,46,.10); }
      .at-btn { transition: background .12s ease, opacity .12s ease; }
      ::placeholder { color: ${theme.mute}; opacity: .7; }
      @media (prefers-reduced-motion: reduce) {
        .at-card, .at-btn { transition: none !important; }
        .at-card:hover { transform: none !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { link.remove(); style.remove(); };
  }, []);

  // Chargement : cache d'abord, puis serveur (source de vérité)
  const loadFromServer = async () => {
    const cached = cache.load();
    if (cached && !projects) setProjects(cached);
    try {
      const serverP = await serverGet();
      setLocked(false);
      if (serverP && serverP.length) {
        setProjects(serverP);
        cache.save(serverP);
      } else if (cached && cached.length) {
        setProjects(cached);
        await serverPut(cached).catch(() => {});
      } else {
        setProjects(SEED);
        cache.save(SEED);
        await serverPut(SEED).catch(() => {});
      }
    } catch (e) {
      if (e && e.code === 401) {
        setLocked(true);
        if (!projects && cached) setProjects(cached);
      } else {
        // hors-ligne : on reste sur le cache, ou le seed en dernier recours
        if (!projects) setProjects(cached || SEED);
        setSyncMsg("Hors-ligne — modifications gardées localement.");
      }
    }
  };

  useEffect(() => { loadFromServer(); }, []); // eslint-disable-line

  const scheduleSave = (next) => {
    cache.save(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      serverPut(next)
        .then(() => setSyncMsg(""))
        .catch((e) => {
          if (e && e.code === 401) { setLocked(true); }
          else setSyncMsg("Synchro en attente (hors-ligne).");
        });
    }, 700);
  };

  const stats = useMemo(() => {
    const list = projects || [];
    const by = (s) => list.filter((p) => p.status === s).length;
    return { total: list.length, "en cours": by("en cours"), "en pause": by("en pause"), publiés: by("publié") + by("terminé") };
  }, [projects]);

  const filtered = useMemo(() => {
    const list = projects || [];
    const needle = q.trim().toLowerCase();
    return list
      .filter((p) => statusFilter === "tous" || p.status === statusFilter)
      .filter((p) => sourceFilter === "tous" || p.source === sourceFilter)
      .filter((p) => {
        if (!needle) return true;
        const hay = [p.name, p.type, p.notes, p.repo, (p.stack || []).join(" ")].join(" ").toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  }, [projects, q, statusFilter, sourceFilter]);

  const upsert = (proj) => {
    const withTime = { ...proj, updatedAt: Date.now() };
    const exists = projects.some((p) => p.id === proj.id);
    const next = exists
      ? projects.map((p) => (p.id === proj.id ? withTime : p))
      : [{ ...withTime, id: uid() }, ...projects];
    setProjects(next); scheduleSave(next); setEditing(null);
  };
  const remove = (id) => {
    const next = projects.filter((p) => p.id !== id);
    setProjects(next); scheduleSave(next); setEditing(null);
  };
  const cycleStatus = (id) => {
    const next = projects.map((p) => {
      if (p.id !== id) return p;
      const i = STATUS_ORDER.indexOf(p.status);
      return { ...p, status: STATUS_ORDER[(i + 1) % STATUS_ORDER.length], updatedAt: Date.now() };
    });
    setProjects(next); scheduleSave(next);
  };

  const suggestNext = async (p) => {
    setCardAI((s) => ({ ...s, [p.id]: { loading: true } }));
    try {
      const prompt =
        "Tu es le copilote de projets d'une développeuse indépendante francophone qui construit ses apps en dialoguant avec l'IA. " +
        "Voici l'un de ses projets :\n\n" + serialise([p]) +
        "\n\nPropose 2 à 3 prochaines étapes concrètes et actionnables pour avancer, en français, sous forme de courte liste à puces. " +
        "Reste réaliste : si une information manque pour bien conseiller, dis-le en une ligne au lieu d'inventer. Pas de blabla d'introduction.";
      const text = await askClaude(prompt);
      setCardAI((s) => ({ ...s, [p.id]: { text } }));
    } catch (e) {
      setCardAI((s) => ({ ...s, [p.id]: { error: e.message || "L’IA n’a pas répondu." } }));
    }
  };

  const askPortfolio = async (question) => {
    const question2 = (question || aiQuestion).trim();
    if (!question2 || !projects) return;
    setAiLoading(true); setAiError(""); setAiAnswer("");
    try {
      const prompt =
        "Tu es le copilote de projets d'une développeuse indépendante francophone. " +
        "Tu raisonnes UNIQUEMENT à partir de la liste de projets ci-dessous (tu n'as pas d'autre accès : ni à GitHub, ni à ChatGPT, ni au vrai code). " +
        "Si la liste ne suffit pas pour répondre, dis-le franchement. Réponds en français, de façon concise et concrète, sans flatterie.\n\n" +
        "PROJETS :\n" + serialise(projects) + "\n\nQUESTION : " + question2;
      const text = await askClaude(prompt);
      setAiAnswer(text);
    } catch (e) {
      setAiError(e.message || "L’IA n’a pas répondu.");
    } finally { setAiLoading(false); }
  };

  if (locked) return <Unlock onSubmit={(k) => { setKey(k); loadFromServer(); }} />;

  if (projects === null) {
    return (
      <div style={{ ...S.page, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, sans-serif", color: theme.mute }}>
        Chargement de Vigie…
      </div>
    );
  }

  const quickPrompts = [
    "Qu’est-ce que je devrais finir en priorité ?",
    "Résume l’état de mes projets clients.",
    "Quels projets sont en pause ou risquent d’être oubliés ?",
    "Quelle est la prochaine étape la plus rapide à boucler ?",
  ];

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <header style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h1 style={S.h1}>Vigie</h1>
            <span style={S.subtitle}>le tableau de bord de tous tes projets</span>
          </div>
          <div style={S.statsRow}>
            <Stat n={stats.total} label="projets" color={theme.ink} />
            <Stat n={stats["en cours"]} label="en cours" color={theme.violet} />
            <Stat n={stats["en pause"]} label="en pause" color={theme.amber} />
            <Stat n={stats.publiés} label="finis / publiés" color={theme.green} />
          </div>
          {syncMsg && <div style={S.syncMsg}>{syncMsg}</div>}
        </header>

        <section style={S.copilot}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={S.spark}>✦</span>
            <h2 style={S.h2}>Copilote</h2>
            <span style={{ fontFamily: "Inter", fontSize: 12.5, color: "rgba(255,255,255,.6)" }}>raisonne sur les projets ci-dessous</span>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {quickPrompts.map((qp) => (
              <button key={qp} className="at-btn at-focus" style={S.chip} onClick={() => { setAiQuestion(qp); askPortfolio(qp); }}>{qp}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="at-focus" style={S.aiInput} placeholder="Pose ta question sur l’ensemble de tes projets…" value={aiQuestion} onChange={(e) => setAiQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && askPortfolio()} />
            <button className="at-btn at-focus" style={{ ...S.primaryBtn, background: "#FFFFFF", color: theme.violet, opacity: aiLoading ? 0.6 : 1 }} onClick={() => askPortfolio()} disabled={aiLoading}>
              {aiLoading ? "…" : "Demander"}
            </button>
          </div>
          {(aiAnswer || aiError || aiLoading) && (
            <div style={S.aiAnswer}>
              {aiLoading && <span style={{ opacity: 0.7 }}>Le copilote réfléchit…</span>}
              {aiError && <span style={{ color: "#FFD7C7" }}>{aiError}</span>}
              {aiAnswer && <div style={{ whiteSpace: "pre-wrap" }}>{aiAnswer}</div>}
            </div>
          )}
        </section>

        <div style={S.toolbar}>
          <input className="at-focus" style={S.search} placeholder="Rechercher un projet, une techno, une note…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={S.filterGroup}>
            <FilterChip active={statusFilter === "tous"} onClick={() => setStatusFilter("tous")}>Tous</FilterChip>
            {STATUS_ORDER.map((s) => (
              <FilterChip key={s} active={statusFilter === s} color={STATUSES[s].color} onClick={() => setStatusFilter(s)}>{STATUSES[s].label}</FilterChip>
            ))}
          </div>
          <div style={S.filterGroup}>
            <FilterChip active={sourceFilter === "tous"} onClick={() => setSourceFilter("tous")}>Toutes sources</FilterChip>
            {Object.keys(SOURCES).map((s) => (
              <FilterChip key={s} active={sourceFilter === s} color={SOURCES[s].color} onClick={() => setSourceFilter(s)}>{SOURCES[s].label}</FilterChip>
            ))}
          </div>
          <button className="at-btn at-focus" style={S.primaryBtn} onClick={() => setEditing({ id: null, name: "", source: "chatgpt", status: "idée", type: "", stack: [], repo: "", nextStep: "", notes: "" })}>
            + Nouveau projet
          </button>
        </div>

        {filtered.length === 0 ? (
          <div style={S.empty}>Aucun projet ne correspond. Change les filtres, ou ajoute-en un — pense à tes projets côté ChatGPT.</div>
        ) : (
          <div style={S.grid}>
            {filtered.map((p) => {
              const st = STATUSES[p.status] || {};
              const sr = SOURCES[p.source] || {};
              const ai = cardAI[p.id];
              const open = expanded[p.id];
              return (
                <article key={p.id} className="at-card" style={S.card}>
                  <div style={{ ...S.spine, background: st.color }} />
                  <div style={S.cardBody}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                      <h3 style={S.cardTitle}>{p.name}</h3>
                      <span style={{ ...S.badge, color: sr.color, background: sr.bg }}>{sr.label}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                      <button className="at-btn at-focus" title="Cliquer pour changer le statut" style={{ ...S.pill, color: st.color, background: st.bg }} onClick={() => cycleStatus(p.id)}>● {st.label}</button>
                      {p.type && <span style={S.type}>{p.type}</span>}
                    </div>
                    {p.stack?.length > 0 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                        {p.stack.map((t) => (<span key={t} style={S.tag}>{t}</span>))}
                      </div>
                    )}
                    {p.repo && <div style={S.repo}>⎇ {p.repo}</div>}
                    {p.nextStep && (
                      <div style={S.nextStep}><span style={{ color: theme.amber, fontWeight: 600 }}>Prochaine étape · </span>{p.nextStep}</div>
                    )}
                    {open && p.notes && <p style={S.notes}>{p.notes}</p>}
                    {ai?.text && <div style={S.aiCard}>{ai.text}</div>}
                    {ai?.error && <div style={{ ...S.aiCard, color: "#B23B15" }}>{ai.error}</div>}
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button className="at-btn at-focus" style={S.softBtn} onClick={() => suggestNext(p)} disabled={ai?.loading}>{ai?.loading ? "…" : "✦ Prochaine étape"}</button>
                      <button className="at-btn at-focus" style={S.ghostBtn} onClick={() => setEditing(p)}>Modifier</button>
                      {p.notes && (
                        <button className="at-btn at-focus" style={S.ghostBtn} onClick={() => setExpanded((s) => ({ ...s, [p.id]: !open }))}>{open ? "Masquer" : "Notes"}</button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <footer style={S.footer}>
          Données synchronisées entre tes appareils via le serveur. Le copilote ne voit que ce qui est saisi ici — pas ton GitHub ni tes projets ChatGPT, à ajouter à la main.
        </footer>
      </div>

      {editing && (
        <Editor initial={editing} onCancel={() => setEditing(null)} onSave={upsert} onDelete={editing.id ? () => remove(editing.id) : null} />
      )}
    </div>
  );
}

function Unlock({ onSubmit }) {
  const [k, setK] = useState("");
  return (
    <div style={{ ...S.page, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ ...S.modal, maxWidth: 360, textAlign: "center" }}>
        <h2 style={{ ...S.h2, color: theme.ink, marginBottom: 8 }}>Vigie</h2>
        <p style={{ fontFamily: "Inter", fontSize: 13.5, color: theme.mute, marginTop: 0 }}>Entre ton code d’accès.</p>
        <input className="at-focus" style={{ ...S.field, textAlign: "center", marginBottom: 12 }} type="password" value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.key === "Enter" && k && onSubmit(k)} autoFocus />
        <button className="at-btn at-focus" style={{ ...S.primaryBtn, width: "100%", opacity: k ? 1 : 0.5 }} disabled={!k} onClick={() => onSubmit(k)}>Entrer</button>
      </div>
    </div>
  );
}

function Stat({ n, label, color }) {
  return (<div style={S.stat}><span style={{ ...S.statN, color }}>{n}</span><span style={S.statL}>{label}</span></div>);
}

function FilterChip({ active, color = theme.ink, onClick, children }) {
  return (
    <button className="at-btn at-focus" onClick={onClick} style={{ fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 500, padding: "6px 12px", borderRadius: 999, border: "1px solid " + (active ? color : theme.line), background: active ? color : theme.panel, color: active ? "#fff" : theme.mute, cursor: "pointer" }}>
      {children}
    </button>
  );
}

function Editor({ initial, onCancel, onSave, onDelete }) {
  const [f, setF] = useState({ ...initial, stackText: (initial.stack || []).join(", ") });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const save = () => {
    if (!f.name.trim()) return;
    const { stackText, ...rest } = f;
    onSave({ ...rest, name: f.name.trim(), stack: stackText.split(",").map((s) => s.trim()).filter(Boolean) });
  };
  return (
    <div style={S.overlay} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ ...S.h2, color: theme.ink, marginBottom: 16 }}>{initial.id ? "Modifier le projet" : "Nouveau projet"}</h2>
        <Field label="Nom"><input className="at-focus" style={S.field} value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus /></Field>
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Source" grow><Select value={f.source} onChange={(v) => set("source", v)} options={Object.keys(SOURCES)} labels={SOURCES} /></Field>
          <Field label="Statut" grow><Select value={f.status} onChange={(v) => set("status", v)} options={STATUS_ORDER} labels={STATUSES} /></Field>
        </div>
        <Field label="Type (ex. Jeu, App enfants, Client…)"><input className="at-focus" style={S.field} value={f.type} onChange={(e) => set("type", e.target.value)} /></Field>
        <Field label="Stack / technos (séparées par des virgules)"><input className="at-focus" style={S.field} value={f.stackText} onChange={(e) => set("stackText", e.target.value)} placeholder="React, Vite, FastAPI…" /></Field>
        <Field label="Repo (optionnel)"><input className="at-focus" style={S.field} value={f.repo} onChange={(e) => set("repo", e.target.value)} placeholder="liabra/mon-projet" /></Field>
        <Field label="Prochaine étape"><textarea className="at-focus" style={{ ...S.field, minHeight: 56, resize: "vertical" }} value={f.nextStep} onChange={(e) => set("nextStep", e.target.value)} /></Field>
        <Field label="Notes"><textarea className="at-focus" style={{ ...S.field, minHeight: 56, resize: "vertical" }} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18, gap: 10 }}>
          {onDelete ? (<button className="at-btn at-focus" style={{ ...S.ghostBtn, color: "#B23B15", borderColor: "#F0C6B7" }} onClick={onDelete}>Supprimer</button>) : <span />}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="at-btn at-focus" style={S.ghostBtn} onClick={onCancel}>Annuler</button>
            <button className="at-btn at-focus" style={{ ...S.primaryBtn, opacity: f.name.trim() ? 1 : 0.5 }} onClick={save} disabled={!f.name.trim()}>Enregistrer</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, grow }) {
  return (<div style={{ marginBottom: 12, flex: grow ? 1 : "unset" }}><label style={S.label}>{label}</label>{children}</div>);
}
function Select({ value, onChange, options, labels }) {
  return (<select className="at-focus" style={S.field} value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => (<option key={o} value={o}>{labels[o]?.label || o}</option>))}</select>);
}

const S = {
  page: { minHeight: "100vh", background: theme.paper, fontFamily: "Inter, sans-serif", color: theme.ink },
  wrap: { maxWidth: 1160, margin: "0 auto", padding: "36px 22px 60px" },
  h1: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em", margin: 0, color: theme.ink },
  subtitle: { fontFamily: "Inter", fontSize: 15, color: theme.mute },
  statsRow: { display: "flex", gap: 26, marginTop: 16, flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column" },
  statN: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 700, lineHeight: 1 },
  statL: { fontSize: 12.5, color: theme.mute, marginTop: 3, textTransform: "uppercase", letterSpacing: ".04em" },
  syncMsg: { fontFamily: "Inter", fontSize: 12.5, color: theme.amber, marginTop: 12 },

  copilot: { background: "linear-gradient(135deg, #4B31E0, #6E4BF7)", borderRadius: 18, padding: 20, color: "#fff", marginBottom: 22, boxShadow: "0 12px 30px rgba(75,49,224,.22)" },
  spark: { fontSize: 18 },
  h2: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 19, fontWeight: 600, margin: 0, color: "#fff" },
  chip: { fontFamily: "Inter", fontSize: 12.5, padding: "6px 11px", borderRadius: 999, border: "1px solid rgba(255,255,255,.35)", background: "rgba(255,255,255,.10)", color: "#fff", cursor: "pointer" },
  aiInput: { flex: 1, fontFamily: "Inter", fontSize: 14, padding: "11px 14px", borderRadius: 11, border: "none", background: "rgba(255,255,255,.16)", color: "#fff" },
  aiAnswer: { marginTop: 14, background: "rgba(255,255,255,.12)", borderRadius: 12, padding: "13px 15px", fontSize: 14, lineHeight: 1.55, fontFamily: "Inter" },

  toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 20 },
  search: { flex: "1 1 240px", fontFamily: "Inter", fontSize: 14, padding: "10px 14px", borderRadius: 11, border: "1px solid " + theme.line, background: theme.panel, color: theme.ink },
  filterGroup: { display: "flex", gap: 6, flexWrap: "wrap" },
  primaryBtn: { fontFamily: "Inter", fontSize: 14, fontWeight: 600, padding: "10px 16px", borderRadius: 11, border: "none", background: theme.violet, color: "#fff", cursor: "pointer" },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 },
  card: { position: "relative", background: theme.panel, borderRadius: 15, border: "1px solid " + theme.line, overflow: "hidden", display: "flex" },
  spine: { width: 5, flexShrink: 0 },
  cardBody: { padding: "16px 17px", flex: 1, minWidth: 0 },
  cardTitle: { fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600, margin: 0, color: theme.ink },
  badge: { fontFamily: "Inter", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap" },
  pill: { fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, padding: "4px 10px", borderRadius: 999, border: "none", cursor: "pointer" },
  type: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute },
  tag: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: "2px 7px", borderRadius: 6, background: theme.paper, color: theme.slate, border: "1px solid " + theme.line },
  repo: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: theme.mute, marginTop: 10 },
  nextStep: { fontFamily: "Inter", fontSize: 13, lineHeight: 1.5, color: theme.ink, marginTop: 11, background: theme.amberSoft, borderRadius: 9, padding: "9px 11px" },
  notes: { fontFamily: "Inter", fontSize: 13, lineHeight: 1.55, color: theme.mute, marginTop: 10 },
  aiCard: { fontFamily: "Inter", fontSize: 13, lineHeight: 1.55, color: theme.ink, marginTop: 11, background: theme.violetSoft, borderRadius: 9, padding: "10px 12px", whiteSpace: "pre-wrap" },

  softBtn: { fontFamily: "Inter", fontSize: 13, fontWeight: 600, padding: "7px 12px", borderRadius: 9, border: "none", background: theme.violetSoft, color: theme.violet, cursor: "pointer" },
  ghostBtn: { fontFamily: "Inter", fontSize: 13, fontWeight: 500, padding: "7px 12px", borderRadius: 9, border: "1px solid " + theme.line, background: theme.panel, color: theme.slate, cursor: "pointer" },

  empty: { fontFamily: "Inter", fontSize: 14.5, color: theme.mute, textAlign: "center", padding: "50px 20px", background: theme.panel, borderRadius: 14, border: "1px dashed " + theme.line },
  footer: { fontFamily: "Inter", fontSize: 12.5, color: theme.mute, marginTop: 28, lineHeight: 1.5 },

  overlay: { position: "fixed", inset: 0, background: "rgba(27,26,46,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto", zIndex: 50 },
  modal: { background: theme.panel, borderRadius: 18, padding: 24, width: "100%", maxWidth: 520, boxShadow: "0 24px 60px rgba(27,26,46,.3)" },
  label: { display: "block", fontFamily: "Inter", fontSize: 12.5, fontWeight: 600, color: theme.slate, marginBottom: 6 },
  field: { width: "100%", boxSizing: "border-box", fontFamily: "Inter", fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid " + theme.line, background: theme.paper, color: theme.ink },
};
