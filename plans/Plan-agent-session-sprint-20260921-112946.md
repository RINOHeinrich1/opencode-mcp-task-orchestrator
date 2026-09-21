# Plan — Agent de SESSION DE SPRINT + lancement panneau

- **Plan ID** : `Plan-agent-session-sprint-20260921-112946`
- **Tâche** : `T-20260921-091737-79uj` (exécution `E-T-20260921-091737-79uj-9cx4t0`)
- **Batch** : `BATCH-mub1809u-06ow` (tâche 8/9) — recette source `RECT-muaz100k-2iq0`
- **Date** : 2026-09-21 11:29:46
- **Racine** : `/root/.config/opencode/mcp/task-orchestrator`

---

## 1. Objectif

Créer l'**agent IA de SESSION DE SPRINT** (à l'image des sessions recette/test) et
permettre son **lancement depuis le panneau** comme **session dédiée rattachée à un
sprint** : lecture des pièces client → synthèse/discussion avec l'utilisateur
(confirmations/clarifications, admin dans un premier temps) → **PROPOSITION** puis
**REMPLISSAGE** des tables Fonctionnalités et Règles métier via `feature_*`/`rule_*`
(pièce source + marqueur émergence si pertinent). L'agent **n'écrit PAS d'ADR**.

## 2. Contexte & raison d'être

- Les tâches **T1-T7** (dépendances TERMINÉES) ont livré : le modèle SQL
  (`sprints`, `fonctionnalites`, `regles_metier`, tables N:N), les pièces client
  (famille `piece`), le cycle de vie sprint (`sprint_*`), les familles
  `feature_*`/`rule_*` + liaisons + workflow ADR `propose→valide`, les
  cardinalités/émergence (`cardinality_report`, `cardinality_signals_list`) et le
  panneau (onglets Sprints / Fonctionnalités-Règles / Émergents + rapport).
- **Il manque l'acteur conversationnel** qui transforme les pièces client d'un
  sprint en fonctionnalités/règles métier : c'est l'objet de ce plan.
- Modèles de référence existants à imiter : `agent-recette` (session de recette,
  `recette_session_set`, `buildRecettePrompt`, `launchRecetteSession`) et
  `test-agent` (`e2e_test_session_set`, `buildTestPrompt`, `launchTestSession`).
- **ADR-001** (modèle sprints / fonctionnalités / règles / émergence) et **ADR-11**
  (projets ↔ repos) cadrent le périmètre. Gouvernance : **les ADR ne sont jamais
  écrites par cet agent** (elles restent à la charge des utilisateurs en recette).
- **Extension de périmètre assumée** : le critère d'acceptation exige « session
  dédiée **depuis le panneau**, type sprint ». Or aucun outil MCP ne permet
  aujourd'hui de rattacher une session à un sprint **existant** (`sprints.session_id`
  n'est posé qu'à la création par `sprint_start(sessionId)`), et aucune route/bouton
  n'expose le lancement. Les étapes A004-A006 ajoutent donc la primitive de
  persistance + la route + le bouton (mêmes repos que le périmètre déclaré :
  `opencode-mcp-task-orchestrator` et `opencode-observability`). La tâche **T9**
  (`T-20260921-091738-u76n`, session de migration) dépend de T8 et partage
  `index.mjs`/`db.mjs`/`server.mjs`/`app.js` : l'exécution est **séquentielle**
  (T9 bloquée tant que T8 n'est pas `done`) → aucun conflit parallèle.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | créer | Nouveau prompt d'agent `agent-sprint` (frontmatter YAML + corps) | — (nouveau) | `/root/.config/opencode/agent/agent-sprint.md` | Donner à la session de sprint sa mission + son cadre (pipeline pièces→discussion→remplissage), lecture seule sur le code, écritures uniquement via MCP | Fichier `agent-sprint.md` enregistré par opencode (agent invocable) |
| A002 | ajouter | Fonction exportée `buildSprintPrompt({ sprintId, project, repos, title, startDate, endDate, pieces, docs, adrContext })` | `/root/orchestrator-panel/session-bridge.mjs` (après `buildRecettePrompt`, l.371) | idem | Construire le prompt « mission + cadre, jamais méthode » de la session de sprint (contexte sprint, pièces, docs de référence) | Fonction `buildSprintPrompt` exportée |
| A003 | ajouter | Fonction exportée `launchSprintSession({ sprintId, force })` + import de `buildSprintPrompt` | `/root/orchestrator-panel/pilot.mjs` (import l.8 ; fonction après `launchRecetteSession`, l.1136) | idem | Lancer (ou REPRENDRE) la session dédiée depuis le panneau, ancrée sur le projet du sprint, puis rattacher la session au sprint | Fonction `launchSprintSession` exportée, anti-doublon (reprise si `sessionId` vivant) |
| A004 | ajouter | Fonction `setSprintSession({ sprintId, sessionId })` (db.mjs) + tool MCP `sprint_session_set` (index.mjs) + import | `/root/.config/opencode/mcp/task-orchestrator/db.mjs` (après `createSprint`, l.1063) et `index.mjs` (import l.139-146 ; tool après `sprint_attach_pieces`, l.781) | idem | Persister le lien session↔sprint sur un sprint **existant** (miroir de `setRecetteSession`), sans toucher au statut open/close du sprint | Primitive `setSprintSession` + tool `sprint_session_set` (retourne `{ ok, sprint }`) |
| A005 | ajouter | Route `POST /api/sprints/:id/session` (corps `{ force }`) | `/root/orchestrator-panel/server.mjs` (après la route rapport sprint, l.1912) | idem | Exposer le lancement de la session de sprint au panneau (miroir de `/api/recettes/:id/session`) | Route renvoyant `{ sprintId, sessionId, resumed }` |
| A006 | ajouter | Bouton `data-sp-session` dans la colonne Actions de `renderSprints()` + fonction `openSprintSession(sprintId, force)` | `/root/orchestrator-panel/public/app.js` (lignes du tableau `renderSprints` l.4770-4782, bindings l.4795-4812 ; handler près de `sprintReportModal`, l.4854) | idem | Déclencher la session depuis l'onglet Sprints (comme « Session de la recette ») | Bouton « Session de sprint » + handler appelant la route A005 |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/.config/opencode/agent/agent-sprint.md` | **création** |
| `/root/orchestrator-panel/session-bridge.mjs` | modification (ajout `buildSprintPrompt`) |
| `/root/orchestrator-panel/pilot.mjs` | modification (import + `launchSprintSession`) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | modification (ajout `setSprintSession`) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | modification (import + tool `sprint_session_set`) |
| `/root/orchestrator-panel/server.mjs` | modification (route `POST /api/sprints/:id/session`) |
| `/root/orchestrator-panel/public/app.js` | modification (bouton + handler session sprint) |

> Deux repos : `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`, branche principale `feature/migration-postgresql`) et `opencode-observability` (`/root/orchestrator-panel`, branche principale `feature/migration-postgresql`). Le repo `agent/` (config opencode) est versionné (`/root/.config/opencode/agent`, branche courante `feature/per-plan`).

## 5. Livrables attendus

1. `agent-sprint.md` — agent opencode « session de sprint » invocable (`--agent agent-sprint`).
2. `buildSprintPrompt` (session-bridge.mjs) + `launchSprintSession` (pilot.mjs) — lancement/reprise panneau.
3. `setSprintSession` (db.mjs) + tool `sprint_session_set` (index.mjs) — rattachement session↔sprint persistant.
4. Route `POST /api/sprints/:id/session` (server.mjs) + bouton « Session de sprint » (app.js).
5. Agent capable de : lire les pièces client (md/pdf/docx/lien Drive + docs ADR-12 requalifiés), dialoguer (confirmer/clarifier, admin), **proposer puis remplir** fonctionnalités (`feature_register`) et règles (`rule_register`) avec pièce source + marqueur émergence ; **sans écrire d'ADR** ; distinguant « déjà en place » vs « à faire » ; signalant/traçant les émergents **sans bloquer**.

## 6. Ordre & dépendances

```
A001 (agent-sprint.md)  ─┐
A004 (setSprintSession + sprint_session_set) ─┐
                          ├─► A003 (launchSprintSession, utilise buildSprintPrompt + sprint_session_set)
A002 (buildSprintPrompt) ─┘                     │
                                                └─► A005 (route) ─► A006 (bouton)
```

- **A001** doit précéder **A003** (le fichier agent doit exister pour `opencode run --agent agent-sprint`, et `readAgentModel` le lit).
- **A002** doit précéder **A003** (import de `buildSprintPrompt`).
- **A004** doit précéder **A003** (l'appel `sprint_session_set` doit exister côté MCP pour persister le lien).
- **A005** doit précéder **A006** (le bouton appelle la route).
- **A005/A006** n'ont pas d'autre prérequis entre eux que la séquence route→bouton.
- A001, A002, A004 peuvent être menées en parallèle (fichiers distincts).

## 7. Couverture des objectifs

| Exigence (mission / critère d'acceptation) | Étape(s) | Couvert ? |
|--------------------------------------------|----------|-----------|
| Agent IA de session SPRINT à l'image des sessions recette/test | A001 | ✅ |
| Session dédiée lancée **depuis le panneau**, type « sprint » | A002, A003, A005, A006 | ✅ |
| Session **rattachée à un sprint** (projet, durée, pièces) | A002 (contexte), A003, A004 (persistance `sprints.session_id`) | ✅ |
| Lecture des pièces client md/pdf/docx/lien Drive + docs ADR-12 requalifiés | A001 (pipeline) + A002 (injection `piece_list`/`doc_list` en contexte) | ✅ |
| Synthèse/discussion avec l'utilisateur (confirmations/clarifications, admin) | A001 (phase discussion) | ✅ |
| **PROPOSITION puis REMPLISSAGE** des tables Fonctionnalités/Règles via `feature_*`/`rule_*` | A001 (pipeline `feature_register`/`rule_register` + `feature_rule_link`/`feature_sprint_link`/`rule_sprint_link`) | ✅ |
| Pièce source + marqueur émergence si pertinent | A001 (`sourcedPieceId` ; émergence calculée par le registre T6) | ✅ |
| L'agent **n'écrit PAS d'ADR** | A001 (interdiction explicite dans le prompt) | ✅ |
| Distinguer « déjà en place » vs « à faire » | A001 (règle de tri du prompt : ne pas générer de fonctionnalité à tort) | ✅ |
| Éléments émergents signalés, tracés, **non bloqués** | A001 (`cardinality_report`/`cardinality_signals_list`, marqueur émergence, non bloquant) | ✅ |
| Ne casse pas les sessions recette/test existantes | A002/A003 (ajouts additifs, aucune modif des fonctions recette/test) | ✅ |

## 8. Vérification de cohérence (Phases 6-7)

- **Contradictions intra-plan** : aucune. Regroupement par élément cible :
  - `session-bridge.mjs` → A002 (ajout, aucun autre) ;
  - `pilot.mjs` → A003 (ajout, aucun autre) ;
  - `db.mjs` → A004 (ajout `setSprintSession`) ; `index.mjs` → A004 (import + tool) ;
  - `server.mjs` → A005 (ajout route) ; `app.js` → A006 (ajout bouton + handler) ;
  - `agent-sprint.md` → A001 (création unique).
  Aucun couple `supprimer`+autre, ni `créer`+`renommer` sur le même élément.
- **Ordre/dépendances** : l'ordre A001/A002/A004 → A003 → A005 → A006 respecte le
  graphe ; aucune étape ne lit un élément créé par une étape ultérieure.
- **Précision** : chaque étape cible un élément nommé dans un fichier nommé, avec
  un verbe d'action et un livrable. Aucune étape générique.
- **Verdict : VALID** (couverture 100 %, aucune contradiction).

## 9. Risques & notes

- **Périmètre étendu (A004-A006)** : hors liste de scope stricte de la tâche, mais
  **requis** par le critère d'acceptation « session dédiée depuis le panneau ». T9
  dépend de T8 → exécution séquentielle, pas de conflit. À signaler à l'orchestrateur.
- **Isolation (norme v1.0)** : le repo panneau (`/root/orchestrator-panel`) est un
  composant d'infrastructure ; travailler sur une **branche de travail dédiée** via
  `session-guard.mjs` (jamais la branche principale `feature/migration-postgresql`).
  Le repo `agent/` est versionné sur `feature/per-plan` : branche dédiée également.
- **A004 ne doit pas modifier le statut** du sprint (contrairement à
  `setRecetteSession` qui force `in_progress`) : `sprint_close`/`sprint_reopen`
  restent les seules actions qui basculent la garde d'émergence.
- **Modèle de l'agent** : réutiliser la cohérence existante (`model:` dans le
  frontmatter, lu par `readAgentModel`). Le modèle exact est au choix de
  l'exécutant ; ne pas casser `session-bridge.readAgentModel`.
- **Tests E2E (cadrage 08)** : **E2E NA**. Le projet `ecosystem` n'a aucun spec
  Playwright (aucun `playwright.config.*` dans `/root/orchestrator-panel` ni
  `/root/.config/opencode/agent` ; `e2e_list(project="ecosystem")` → 0 test). Aucun
  comportement utilisateur observable ne relève d'un run E2E → aucun lien E2E créé.
- **Traçabilité** : `task_event(taskId="T-20260921-091737-79uj")` (EXECUTION_STARTED,
  CHECKPOINT, EXECUTION_COMPLETED) par `build-notify` ; `plan_set_branch` en fin de
  sous-tâche.
