# Vigie — suivi de projets avec copilote IA

Tableau de bord perso pour garder tous tes projets au même endroit, avec un
copilote Claude qui raisonne sur ta liste. Front React + Vite (PWA) servi par
un petit serveur Express, données rangées dans PostgreSQL et synchronisées
entre PC et téléphone.

- **Synchro PC + téléphone** : les données vivent dans une base côté serveur,
  donc la même liste partout. Un cache local garde l'affichage instantané et
  un mode hors-ligne de secours.
- **Clé API à l'abri** : le navigateur ne parle jamais directement à
  Anthropic. Il passe par le serveur, qui seul détient la clé.
- **Code d'accès optionnel** : si tu définis `APP_PASSWORD`, l'app le demande
  à l'ouverture. Sinon elle est ouverte.

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
   - `ANTHROPIC_MODEL` — *optionnel*, par défaut `claude-sonnet-5`.
   - `APP_PASSWORD` — *optionnel*, un code d'accès pour verrouiller l'app.
5. Railway installe, construit (`npm run build`) et démarre (`npm start`) tout
   seul. Puis **Settings → Networking → Generate Domain** pour obtenir l'URL.
6. Ouvre l'URL sur PC **et** téléphone. Sur mobile → menu du navigateur →
   **Ajouter à l'écran d'accueil** pour l'installer comme une app.

> ⚠️ Ne mets **jamais** ta clé API ni ton code d'accès dans le code ou dans un
> fichier commité — uniquement dans les variables Railway. `.env` est ignoré
> par git.

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

Le serveur lit les variables d'environnement du processus (pas de `dotenv`) :
passe-les en ligne comme ci-dessus, ou via `export`. Voir `.env.example` pour
la liste complète.

---

## Coût de l'API

Chaque question au copilote part vers l'API Anthropic et coûte **quelques
centimes**. La note dépend surtout du nombre de projets (toute la liste est
envoyée dans le prompt) et de la longueur de la réponse. Pour réduire :
mets `ANTHROPIC_MODEL` sur un modèle **Haiku**, bien moins cher.

## Limites — à garder en tête

- Le copilote ne voit **que** la liste saisie dans l'app. Pas d'accès à
  GitHub, ni à tes conversations ChatGPT, ni au vrai code. Ce qui n'est pas
  écrit dans une fiche projet n'existe pas pour lui.
- Ses réponses sont donc aussi bonnes que tes notes : plus la prochaine étape
  et les notes sont précises, plus les suggestions sont utiles.
- Ce sont des **pistes à vérifier**, pas des instructions sûres — surtout pour
  les étapes sensibles (publication Play Store, base de données, sécurité).
