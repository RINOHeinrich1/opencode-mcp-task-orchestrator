# Rapport de fin de tâche — Panneau sprints / fonctionnalités-règles / émergents

- **Plan** : `Plan-panneau-sprints-fonctionnalites-emergents-20260921-110850` (13 étapes A001→A013)
- **Tâche** : `T-20260921-091736-yqwv` (exécution `E-T-20260921-091736-yqwv-heumu4`) — projet `ecosystem`
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 11:22:21
- **Repo cible** : `opencode-observability` → `/root/orchestrator-panel` (branche de déploiement `feature/migration-postgresql`)

## 1. Résumé

Implémentation **côté panneau** (`opencode-observability`) de la consommation des familles MCP livrées par T1→T6, sans réimplémentation (le registre reste la source de vérité) :

1. **Onglet Sprints** — liste par projet (titre, dates, statut `open`/`close`), création à **durée paramétrable**, boutons **CLÔTURER** / **REPRENDRE**, rattachement des **pièces client**, détail.
2. **RAPPORT DE SPRINT téléchargeable** — généré par `sprint_report` (registre), affiché en markdown puis téléchargé (`Content-Disposition: attachment`).
3. **Onglet « Fonctionnalités / Règles métier »** — table (Ref / rôle / user story) + règles métier, liens fonctionnalité↔règle / ↔Gherkin / ↔ADR (et sprint/tâche/recette), visibilité des rattachements, CRUD (création/modification).
4. **Onglet « Émergents »** — 10 vues `cardinalityView` + signaux (clôture tracée obligatoire), s'appuyant sur `cardinality_report`.
5. **Onglet « Artefacts »** — pièces client (`doc_type='piece'`) affichées **avec leur nature** (`markdown`/`pdf`/`docx`/`lien`).

La **clôture d'un sprint** (bouton panneau ou échéance auto appliquée par le registre) est l'action officielle qui bascule la garde d'émergence ; le panneau n'affiche que l'état renvoyé par le registre.

## 2. Isolation

- **Espace Coder** : le projet `ecosystem` (repos `opencode-observability`, `opencode-mcp-task-orchestrator`, `opencode-scripts`) n'existe dans **aucun workspace Coder** (cf. `workspace_list`). Il s'agit de **l'outillage d'infrastructure** de l'écosystème, explicitement désigné comme **repo HÔTE** par la tâche. Traitement effectué sur l'hôte, conformément à l'exception « composant d'infrastructure » (documenté ici).
- **session-guard** : `acquire` → `mode: in-place` (aucune session parallèle détectée) ; création d'un **worktree dédié** (exigence du plan : jamais de commit sur la branche principale).
  - Worktree : `/root/orchestrator-panel-wt-panneau-sprints-emergents`
  - Branche : `build-notify/panneau-sprints-emergents` (basée sur `feature/migration-postgresql` @ `685fbda`)
  - Fin : `session-guard release` → **verrou libéré**, **worktree + branche CONSERVÉS** pour l'étape d'orchestration ultérieure (merge/push). *Écart assumé vs la lettre de la norme (`remove` supprimerait la branche dédiée et rendrait les commits inaccessibles au merge à venir)* ; ce choix suit la pratique observée des sous-tâches précédentes (le worktree `build-notify/pieces-client-projet` de T2 est toujours présent et a été mergé).
- **Aucun push / merge** (étape d'orchestration ultérieure).

## 3. Branches et commits

- **Branche de travail** : `build-notify/panneau-sprints-emergents`
- **Base** : `685fbdabb35284060978689f8b3df3190322913c`
- **Commits** (trace append-only enregistrée via `plan_commit_add`, ids 465–467) :

| SHA | Message | Fichier |
|---|---|---|
| `5b4b201` | feat(panneau): wrappers MCP sprint_*/feature_*/rule_*/liens/cardinalité | `pilot.mjs` (+247) |
| `4b3b3e0` | feat(panneau): routes API sprints/features/rules/liens/cardinalité + rapport de sprint téléchargeable | `server.mjs` (+231) |
| `70b445f` | feat(panneau): onglets Sprints, Fonctionnalités/Règles métier, Émergents + rapport téléchargeable + nature des pièces | `public/app.js` (+593/−2) |

## 4. Traitements effectués (13/13 étapes)

| Étape | Fichier | Réalisation | Statut |
|---|---|---|---|
| A001 | `pilot.mjs` | 7 wrappers `sprint_*` (`listSprints`, `getSprintDetail`, `createSprint`, `closeSprint`, `reopenSprint`, `attachSprintPieces`, `sprintReport`) | ✅ |
| A002 | `pilot.mjs` | 8 wrappers `feature_*`/`rule_*` (CRUD) | ✅ |
| A003 | `pilot.mjs` | Dispatcher `linkEntities`/`unlinkEntities` + `LINK_KINDS` (9 relations) | ✅ |
| A004 | `pilot.mjs` | 3 wrappers `cardinality_*` (`resolution` obligatoire) | ✅ |
| A005 | `server.mjs` | 7 routes `/api/sprints*` + rapport téléchargeable | ✅ |
| A006 | `server.mjs` | CRUD `/api/features*` + `/api/rules*` + dispatcher `/api/links*` | ✅ |
| A007 | `server.mjs` | 3 routes `/api/cardinality*` | ✅ |
| A008 | `public/app.js` | `PROJECT_TABS` + `RENDER` (3 onglets) | ✅ |
| A009 | `public/app.js` | Onglet **Sprints** (liste, création durée paramétrable, CLÔTURER/REPRENDRE, pièces, détail) | ✅ |
| A010 | `public/app.js` | Modale **rapport de sprint** + téléchargement | ✅ |
| A011 | `public/app.js` | Onglet **Fonctionnalités / Règles métier** (2 tables, liens, détail, CRUD, modale de liaison) | ✅ |
| A012 | `public/app.js` | Onglet **Émergents** (10 vues + signaux + clôture tracée) | ✅ |
| A013 | `public/app.js` | `DOC_TYPE_LIST` + `'piece'` ; `artRow` affiche la **nature** | ✅ |

Avancement du plan : **13/13 — 100 %**.

## 5. Fichiers modifiés / créés

**Modifiés (repo `opencode-observability`)** :
- `pilot.mjs` — bloc additif de wrappers MCP (après `removePiece`).
- `server.mjs` — bloc additif de routes (après le bloc pièces) ; `DOC_TYPES` contenait déjà `"piece"` (aucune modification).
- `public/app.js` — `PROJECT_TABS`, `RENDER`, `DOC_TYPE_LIST`, `artRow`, + fonctions `renderSprints`/`sprintReportModal`/`renderFeaturesRules`/`renderEmergents` et helpers.

**Créé (hors repo panneau)** :
- `/root/.config/opencode/mcp/task-orchestrator/reports/report-panneau-sprints-fonctionnalites-emergents-20260921-112221.md` (ce rapport).

**Non modifiés** (conforme au plan) : `public/style.css` (hors périmètre, classes existantes réutilisées), `session-bridge.mjs`, `index.mjs`/`db.mjs` du MCP.

## 6. Vérifications (A013)

1. **Syntaxe** — `node --check` sur les 3 fichiers touchés : `pilot.mjs`, `server.mjs`, `public/app.js` → **OK**.
2. **Exports** — import dynamique de `pilot.mjs` : **21/21** symboles attendus présents (`LINK_KINDS` = 9 relations).
3. **Round-trip MCP live** (registre PostgreSQL réel) : `listSprints`, `listFeatures`, `listRules`, `cardinalityReport` (10 vues) → OK.
4. **Round-trip HTTP authentifié** (serveur du worktree sur `127.0.0.1:4100`, projet temporaire `smoke-tmp-bn` créé puis supprimé) :
   - `POST /api/sprints` (durée 7 j) → sprint `open` ; `GET /api/sprints` → `open` ;
   - `GET /api/sprints/:id/report` → markdown ; `?download=1` → `200` + `Content-Disposition: attachment; filename="rapport-sprint-<id>.md"` ;
   - `POST /api/sprints/:id/close` → `close` (motif `manuel`) ; `POST /api/sprints/:id/reopen` → `open` ;
   - `POST /api/features` / `POST /api/rules` → création ; `POST /api/links` (`feature_rule`, `feature_sprint`) → lien ; `GET /api/features/:id` → liens visibles (règle + sprint) ; `DELETE /api/links/...` → déliage ;
   - `GET /api/cardinality?projectId=…` → 10 vues ; `GET /api/cardinality/signals` → signaux.
   - Erreurs de validation : `POST /api/sprints` sans `projectId` → `400` ; `kind` de lien inconnu → `400` ; résolution de signal sans `resolution` → `400` ; `GET /api/sprints/<inconnu>/report` → `400`.
5. **Non-régression** — tous les endpoints des onglets existants renvoient `200` : `/api/me`, `/api/projects`, `/api/tasks`, `/api/recettes`, `/api/e2e-tests`, `/api/docs`, `/api/artifacts`, `/api/pieces` + les nouveaux. Aucun `500`. Routes purement additives (préfixes d'URL disjoints, aucune ombre sur l'existant).
6. **Nettoyage** — projet temporaire, utilisateur de test, sessions et **toutes les lignes de test** (sprint/fonctionnalité/règle/signal) supprimés ; registre vérifié sans résidu (`0`).

## 7. Avertissements / erreurs

- **Rendu navigateur (app.js) non exécuté** : le repo panneau ne contient **aucun harnais Playwright/jsdom** (constat du plan). La validation front est limitée à `node --check` + revue ; le **parcours complet** a été validé au niveau HTTP (les fonctions `render*` sont des consommatrices directes de ces routes). **E2E NA** (conforme au plan).
- **Pas de suppression** dans les familles `feature_*`/`rule_*`/`sprint_*` côté MCP : le « CRUD » livré couvre **Create / Read / Update** (le plan §Décision 5 énumère explicitement `register`/`update`). Aucune incohérence code↔plan.
- **Nettoyage de test** : la suppression des lignes de test (projet temporaire sans FK, aucun outil MCP de suppression d'entités) a été faite par SQL strictement scopé sur `project='smoke-tmp-bn'` — **hors chemin applicatif**, à seule fin d'hygiène de test. Le code applicatif n'écrit jamais directement en base (tout passe par `pilot.mjs` → MCP).
- Worktree : `node_modules` a été lié temporairement (symlink, gitignoré) pour exécuter le serveur de test, puis retiré.
- **Aucun incident, aucune incohérence** ; aucun `INCONSISTENCY_FOUND` / `BLOCKED`.

## 8. Prochaines étapes / recommandations

1. **Orchestration** : merge/push de `build-notify/panneau-sprints-emergents` vers `feature/migration-postgresql` (hors périmètre de cette sous-tâche).
2. **Test visuel** : ouvrir le panneau, vérifier les 3 nouveaux onglets sur un projet disposant de sprints/fonctionnalités (ex. créer un sprint réel sur `ecosystem`).
3. **Harnais E2E** : quand un harnais Playwright sera ajouté au repo panneau, enregistrer les scénarios documentés au §9 du plan (`create` sprint/clôture/reprise, rapport téléchargeable, émergents après clôture, CRUD fonctionnalité + liens, `keep` non-régression).
4. **ADR** : l'ADR-001 (`doc-mub10mo8-lgo3`, statut **Proposé**) reste la source normative ; son **acceptation** est une décision humaine.
