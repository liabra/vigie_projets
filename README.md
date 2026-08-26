# Vigie — suivi de projets avec copilote IA

Tableau de bord perso pour garder tes **projets** et tes **tâches** au même
endroit, avec un copilote Claude qui raisonne sur ta liste. Front React + Vite
(PWA) servi par un petit serveur Express, données rangées dans PostgreSQL et
synchronisées entre PC et téléphone.

- **Synchro PC + téléphone** : les données vivent dans une base côté serveur,
  donc la même liste partout. Un cache local garde l'affichage instantané et
  un mode hors-ligne de secours.
- **Clé API à l'abri** : le navigateur ne parle jamais directement à
  Anthropic. Il passe par le serveur, qui seul détient la clé.
- **Code d'accès optionnel** : si tu définis `APP_PASSWORD`, l'app le demande
  à l'ouverture. Sinon elle est ouverte.
- **Copilote personnalisable** : le bouton **✎ Profil** du panneau Copilote
  règle la phrase qui ouvre chaque prompt (« Tu es le copilote de projets
  de… »). Gardé sur l'appareil, vide = description par défaut.
- **Choix du modèle** : un menu dans le panneau Copilote bascule entre
  **Haiku** (rapide, éco — par défaut), **Sonnet** (équilibré) et **Opus**
  (max). Le choix est gardé sur l'appareil.
- **Raccourcis par projet** : chaque carte peut afficher **Code** (le repo),
  **Ouvrir** (le site en ligne) et **Discussion** (la conversation Claude).
- **Deux onglets** : *Projets dev* (les cartes projet et le copilote) et
  *Tâches agenda*. L'onglet ouvert est retenu d'une visite à l'autre.
- **Tâches** : perso / admin / dev, filtrables par statut, catégorie et
  urgence, avec une échéance facultative. Celles qui ont une échéance sont
  poussées dans un agenda Google dédié (voir plus bas).
- **Deux lectures visuelles distinctes** sur une carte de tâche : le
  **statut** colore la carte (orange à faire, violet en cours, grisé + ✓
  fait, comme dans l'agenda), l'**urgence** n'est qu'un badge (rien,
  *Important*, ou une pastille rouge *Urgent*). L'urgence reste **interne à
  Vigie** : elle ne part jamais vers Google.

---

## Mettre en ligne sur Railway

1. Pousse ce dossier sur GitHub (ici : `liabra/vigie_projets`).
2. Sur [railway.app](https://railway.app) : **New Project → Deploy from GitHub
   repo** → choisis le repo.
3. Dans ce même projet Railway : **New → Database → PostgreSQL**. Railway crée
   la base et fournit la variable `DATABASE_URL`.
   - Vérifie que le service de l'app voit bien `DATABASE_URL` (dans
     **Variables** ; si elle manque, ajoute-la en référence à la base avec la
     valeur `${{Postgres.DATABASE_URL}}`).
   - Sans base, l'app tourne quand même mais garde les projets **en mémoire** :
     tout est perdu à chaque redémarrage.
4. Toujours dans **Variables**, ajoute :
   - `ANTHROPIC_API_KEY` — ta clé ([console.anthropic.com](https://console.anthropic.com), avec des crédits). **Obligatoire** pour le copilote.
   - `ANTHROPIC_MODEL` — *optionnel*. Modèle de repli quand le client n'en
     demande aucun ; par défaut `claude-haiku-4-5-20251001`. Le menu de
     l'app prend le dessus, dans la limite de la liste blanche du serveur.
   - `APP_PASSWORD` — *optionnel*, un code d'accès pour verrouiller l'app.
5. Railway installe, construit (`npm run build`) et démarre (`npm start`) tout
   seul. Puis **Settings → Networking → Generate Domain** pour obtenir l'URL.
6. Ouvre l'URL sur PC **et** téléphone. Sur mobile → menu du navigateur →
   **Ajouter à l'écran d'accueil** pour l'installer comme une app.

> ⚠️ Ne mets **jamais** ta clé API ni ton code d'accès dans le code ou dans un
> fichier commité — uniquement dans les variables Railway. `.env` est ignoré
> par git.

---

## Agenda Google — synchro à sens unique

Vigie écrit les échéances de tâches dans **un agenda Google dédié qu'elle crée
elle-même**, nommé « Vigie ».

> **Sens unique, et un seul agenda.** Vigie *écrit* dans l'agenda « Vigie » :
> elle n'y lit rien, ne remonte jamais un événement vers une tâche, et n'a
> aucun accès à tes autres agendas. Le scope demandé est
> `calendar.app.created`, qui limite l'accès aux seuls agendas créés par
> l'application — tes agendas perso et pro restent invisibles, même en
> lecture. Modifier un événement dans Google ne change donc **rien** dans
> Vigie, et la prochaine modification de la tâche réécrira l'événement.

Ce qui est synchronisé :

| Dans Vigie | Dans l'agenda « Vigie » |
| --- | --- |
| tâche créée avec une échéance | événement créé (journée entière, ou 30 min si tu décoches « journée ») |
| échéance modifiée | événement déplacé |
| statut passé à **Fait** | événement **grisé** et titre préfixé « ✓ » |
| retour à **À faire** / **En cours** | gris et « ✓ » retirés |
| échéance effacée | événement supprimé |
| tâche supprimée | événement supprimé |
| tâche **sans** échéance | aucun événement |

### Mise en place (une fois)

1. Sur [console.cloud.google.com](https://console.cloud.google.com) : crée un
   projet (n'importe quel nom).
2. **APIs & Services → Library** → active **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** : type **External**, remplis le
   nom de l'app et ton adresse. Ajoute-toi comme utilisateur de test, puis
   **publie l'app en Production**. Sans vérification Google elle reste marquée
   « non vérifiée » : c'est normal pour un usage perso, tu passeras par
   *Paramètres avancés → Continuer vers…* au consentement. Publier évite que
   le refresh token expire au bout de 7 jours (limite du mode Testing).
4. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Dans *Authorized redirect URIs*, mets exactement :
   `https://<ton-domaine-railway>/oauth/callback`
5. Copie les 3 valeurs dans les **Variables** Railway :
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` = la même URL qu'à l'étape 4.
6. Redéploie, ouvre Vigie, section **Tâches** → **Connecter l'agenda Google**.
   L'agenda « Vigie » est créé automatiquement au premier lien.

### Comment Vigie retrouve son agenda

Le scope `calendar.app.created` interdit de **lister** les agendas du compte
(`calendarList.list`, `calendars.list`) et d'accéder à `primary` : c'est
justement ce qui garantit que Vigie ne voit rien d'autre. Elle ne peut donc
pas chercher son agenda par son nom. À la place : `calendars.insert` une
seule fois, et l'id retourné est gardé dans la table `app_settings`
(clé `google_calendar_id`). Tous les événements ciblent ensuite cet id.

Deux conséquences à connaître :

- si tu supprimes l'agenda « Vigie » côté Google, Vigie s'en aperçoit à la
  première écriture (404) et en recrée un ;
- si la ligne `google_calendar_id` disparaît de la base, Vigie crée un
  **nouvel** agenda « Vigie » au lieu de retrouver l'ancien — elle n'a aucun
  moyen de le reconnaître. L'ancien reste dans ton compte, à supprimer à la
  main le cas échéant.

Sans ces variables, tout le reste marche : les tâches s'enregistrent
normalement, la synchro est simplement inactive. Idem si Google est injoignable
— la tâche est gardée, un message discret le signale, et elle repartira à la
prochaine modification. Le bouton **délier** coupe le lien : les tâches
restent, l'agenda cesse de bouger.

---

## Tester en local

Sans `DATABASE_URL`, l'app utilise le stockage en mémoire (remis à zéro à
chaque redémarrage) — pratique pour essayer.

```bash
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:3000
```

Développement avec rechargement à chaud (deux terminaux) :

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start   # serveur, port 3000
npm run dev                              # Vite, port 5173 (proxy /api → 3000)
```

Le flux OAuth Google, lui, a besoin d'une URL publique : en local, il ne
fonctionne que si `GOOGLE_REDIRECT_URI` pointe vers une adresse que Google peut
rappeler (un tunnel type ngrok). Les tâches, elles, marchent sans.

Le serveur lit les variables d'environnement du processus (pas de `dotenv`) :
passe-les en ligne comme ci-dessus, ou via `export`. Voir `.env.example` pour
la liste complète.

---

## Coût de l'API — et pourquoi ce n'est qu'une estimation

Chaque question au copilote part vers l'API Anthropic et coûte **quelques
centimes**. La note dépend surtout du nombre de projets (toute la liste est
envoyée dans le prompt), de la longueur de la réponse et du modèle choisi.

L'app affiche sous chaque réponse le coût estimé de la question, plus un
**total de session** (gardé sur l'appareil, bouton *remettre à zéro*). Il
compte tous les appels : questions globales **et** boutons « ✦ Prochaine
étape » des cartes.

> ⚠️ C'est une **estimation** : les tokens réellement consommés (renvoyés par
> l'API dans `usage`) multipliés par une table de tarifs écrite en dur. Ce
> n'est pas ta facture Anthropic. Le cache de prompt, les remises et les
> changements de prix ne sont pas pris en compte.

**La table de tarifs est à maintenir à la main** : constante `PRICES` en haut
de [`server.js`](server.js), en dollars par million de tokens. Un seul endroit
à corriger quand les prix bougent. Deux points de vigilance :

- le tarif Sonnet inscrit (2 / 10) est **introductif** — il passe à 3 / 15 le
  1er septembre 2026 ;
- `PRICES` sert aussi de **liste blanche** : le serveur n'accepte du client
  que ces identifiants de modèle et retombe sur le repli sinon. Ajouter un
  modèle au menu de l'app suppose de l'ajouter d'abord ici.

## Limites — à garder en tête

- Le lien **Discussion** (`chatUrl`) est un raccourci **personnel** : une URL
  de conversation Claude ne s'ouvre que depuis le compte qui l'a créée. Elle
  ne donne rien à quelqu'un d'autre, et le copilote de Vigie n'y a pas accès
  non plus — c'est un simple marque-page.
- Le lien **Ouvrir** (`liveUrl`) et le lien **Code** (`repo`, une URL complète
  ou un raccourci `owner/name` transformé en lien GitHub) n'apparaissent que
  si le champ est rempli.
- Le copilote ne voit que les **projets**, pas les tâches ni l'agenda.
- Le copilote ne voit **que** la liste saisie dans l'app. Pas d'accès à
  GitHub, ni à tes conversations ChatGPT, ni au vrai code. Ce qui n'est pas
  écrit dans une fiche projet n'existe pas pour lui.
- Ses réponses sont donc aussi bonnes que tes notes : plus la prochaine étape
  et les notes sont précises, plus les suggestions sont utiles.
- Ce sont des **pistes à vérifier**, pas des instructions sûres — surtout pour
  les étapes sensibles (publication Play Store, base de données, sécurité).
