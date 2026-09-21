# Synthèse de planification — `T-20260921-091737-79uj`

- **Tâche** : Agent session SPRINT — pipeline pièces→discussion→remplissage Fonctionnalités/Règles métier (pas d'ADR), prompts agents alignés
- **Exécution** : `E-T-20260921-091737-79uj-9cx4t0`
- **Batch** : `BATCH-mub1809u-06ow` (tâche 8/9) — recette source `RECT-muaz100k-2iq0`
- **Projet** : `ecosystem`
- **Agent planificateur** : `atomic-plan`
- **Date** : 2026-09-21 11:30:31
- **Racine des plans** : `/root/.config/opencode/mcp/task-orchestrator`

## 1. Objectifs identifiés (Phase 0)

Deux objectifs **non interdépendants** (fichiers et livrables distincts) → **2 plans** :

| # | Objectif | Plan | Étapes |
|---|----------|------|--------|
| 1 | Créer l'agent IA de **session de SPRINT** (pipeline pièces → discussion → proposition/remplissage Fonctionnalités/Règles métier, sans écrire d'ADR) et permettre son **lancement depuis le panneau** (session dédiée rattachée à un sprint) | `Plan-agent-session-sprint-20260921-112946` | A001-A006 |
| 2 | Mettre à jour les prompts `agent-recette`, `build-notify`, `test-agent` pour **proposer les liens ADR / fonctionnalité** au rattachement des tâches, avec **validation humaine en recette** | `Plan-prompts-liens-adr-fonctionnalite-20260921-112946` | B001-B003 |

Aucune ambiguïté de segmentation nécessitant une question utilisateur : les deux
objectifs sont explicitement listés par la mission et portent sur des fichiers
disjoints.

## 2. Plans produits

### 2.1 `Plan-agent-session-sprint-20260921-112946`

- **Fichier** : `plans/Plan-agent-session-sprint-20260921-112946.md`
- **Étapes** : A001 (créer `agent-sprint.md`) · A002 (`buildSprintPrompt` dans
  `session-bridge.mjs`) · A003 (`launchSprintSession` dans `pilot.mjs`) ·
  A004 (`setSprintSession` db.mjs + tool `sprint_session_set` index.mjs) ·
  A005 (route `POST /api/sprints/:id/session`) · A006 (bouton « Session de
  sprint » + handler `app.js`).
- **Fichiers touchés** : `agent-sprint.md` (nouveau), `session-bridge.mjs`,
  `pilot.mjs`, `db.mjs`, `index.mjs`, `server.mjs`, `public/app.js`.
- **Ordre** : A001/A002/A004 → A003 → A005 → A006.
- **Verdict** : VALID (couverture 100 %, aucune contradiction).

### 2.2 `Plan-prompts-liens-adr-fonctionnalite-20260921-112946`

- **Fichier** : `plans/Plan-prompts-liens-adr-fonctionnalite-20260921-112946.md`
- **Étapes** : B001 (`agent-recette.md`) · B002 (`build-notify.md`) ·
  B003 (`test-agent.md`).
- **Fichiers touchés** : `agent-recette.md`, `build-notify.md`, `test-agent.md`.
- **Ordre** : B001/B002/B003 parallélisables.
- **Verdict** : VALID (couverture 100 %, aucune contradiction).

## 3. Vérifications de cohérence

### 3.1 Intra-plan (Phases 6-7)

- **Plan A** : aucun couple `supprimer`+autre ni `créer`+`renommer` sur un même
  élément ; graphe d'ordre respecté (aucune lecture d'un élément créé par une
  étape ultérieure) ; étapes atomiques (élément × fichier). **VALID**.
- **Plan B** : un seul fichier cible par étape ; aucune suppression ; étapes
  parallélisables. **VALID**.

### 3.2 Globale inter-plans (Phase 9)

- Regroupement par élément cible à travers les deux plans :
  - `agent-sprint.md` → Plan A uniquement ;
  - `session-bridge.mjs`, `pilot.mjs`, `db.mjs`, `index.mjs`, `server.mjs`,
    `public/app.js` → Plan A uniquement ;
  - `agent-recette.md`, `build-notify.md`, `test-agent.md` → Plan B uniquement.
- **Aucun fichier commun, aucune région de fichier partagée → aucune
  contradiction inter-plans détectée.**

## 4. Points de vigilance remontés à l'orchestrateur

1. **Extension de périmètre (Plan A, A004-A006)** : la route/bouton/primitive de
   persistance de session sortent de la liste de scope stricte de la tâche
   (`agent-recette.md`, `build-notify.md`, `test-agent.md`, `session-bridge.mjs`,
   `pilot.mjs`) mais sont **nécessaires** au critère d'acceptation « session
   dédiée depuis le panneau, type sprint ». Mêmes repos que le périmètre déclaré.
   **T9** (`T-20260921-091738-u76n`, session de migration) dépend de T8 et partage
   `index.mjs`/`db.mjs`/`server.mjs`/`app.js` → exécution **séquentielle**, aucun
   conflit parallèle.
2. **Isolation (norme v1.0)** : repo panneau (`/root/orchestrator-panel`, branche
   principale `feature/migration-postgresql`) et repo config opencode
   (`/root/.config/opencode/agent`, branche courante `feature/per-plan`) →
   travailler sur des **branches de travail dédiées** via `session-guard.mjs`.
3. **A004** ne doit pas modifier le statut `open`/`close` du sprint (à la
   différence de `setRecetteSession` qui force `in_progress`).
4. **Tests E2E (cadrage 08)** : **E2E NA** pour les deux plans. Le projet
   `ecosystem` n'a aucun spec Playwright (`e2e_list(project="ecosystem")` → 0
   test ; aucun `playwright.config.*` dans les repos concernés). Aucun lien E2E
   créé.

## 5. Traçabilité

- `task_event(T-20260921-091737-79uj, PLANNING_STARTED)` — publié en début de planification.
- `task_event(T-20260921-091737-79uj, PLAN_CREATED)` ×2 (un par plan).
- `artifact_add(kind=plan)` ×2 (pièces jointes du notifier).
- `plan_register(taskId=T-20260921-091737-79uj)` ×2 (persistance en base).
- `participant_add(atomic-plan, role=planner)`.

**Aucune incohérence globale** → la planification est considérée terminée.
