# Rapport de fin de sous-tâche — SPRINT objet de 1er niveau (cycle de vie produit + rapport)

- **Tâche** : `T-20260921-091731-d1af` (exécution `E-T-20260921-091731-d1af-fz9l2l`)
- **Plan (sous-tâche)** : `Plan-sprint-cycle-de-vie-rapport-20260921-100015` — **17/17 étapes done (100 %)**
- **Projet** : `ecosystem` — batch `BATCH-mub1809u-06ow` (tâche 3/9)
- **Repo** : `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (repo HÔTE, pas de workspace Coder)
- **Agent** : `build-notify`
- **Date** : 2026-09-21 10:10:26
- **Branche de travail** : `build-notify/sprint-cycle-de-vie-rapport` (base `feature/migration-postgresql` @ `5444381`)
- **ADR de référence** : `doc-mub10mo8-lgo3` — ADR-001 (statut **Proposé**) §1/§2/§4

---

## 1. Résumé

Implémentation intégrale des **17 étapes** du plan : le SPRINT devient un **objet de
premier niveau** doté de son **cycle de vie produit** dans le registre du MCP.

- **Modèle additif** : `sprints` étendue (`is_default`, `auto_close`, `closed_at`,
  `close_reason`, `reopened_at`) + index partiel **unique** `idx_sprints_default`
  (« 1 défaut par projet ») + `idx_sprints_project_status` ; `tasks` étendue
  (`emergent`, `emergent_origin`) + `idx_tasks_emergent`.
- **Cycle de vie** (`db.mjs`) : `rowToSprint`, `closeSprint` (idempotent, **n'écrit
  jamais** sur `tasks`/`executions`), `autoCloseExpiredSprints` (clôture **automatique
  à l'échéance**), `getSprint`, `listProjectSprints`, `reopenSprint` (reprise, anti
  re-clôture), `ensureDefaultSprint`, `migrateExistingToDefaultSprint`.
- **Garde d'émergence unique** `classifyEmergence(projectId, { kind })` (non
  bloquante, non rétroactive), **branchée** sur `addPiece` (pièces — comportement T2
  conservé) et `createTask` (tâches) ; disponible pour `feature_*`/`rule_*` (T5).
- **Rapport de sprint** `buildSprintReport` (JSON + markdown) + **tool MCP
  `sprint_report`** (lecture seule, téléchargeable).
- **Non-régression** : modèle ADR/`artifacts` intact, T1 (liens N:N) et T2 (pièces)
  préservés ; frontière T4 respectée (aucun CRUD `sprint_*`).

## 2. Isolation

| Repo | Espace | Worktree | Branche |
|------|--------|----------|---------|
| `opencode-mcp-task-orchestrator` | **HÔTE** (composant d'infrastructure — `workspace_list` ne le contient dans **aucun** workspace Coder) | `/root/.config/opencode/mcp/task-orchestrator-wt-sprint-cycle-de-vie-rapport` | `build-notify/sprint-cycle-de-vie-rapport` |

- `workspace_list` : **7 workspaces Coder** listés (madatalk, ONIRIA, myxmax, affelyos,
  admin-myxmax, ia-crm-frontend, ia-crm-api) — **aucun** ne contient le repo cible ;
  conformément au plan (« repo HÔTE, pas de workspace Coder »), travail sur l'hôte.
- `session-guard acquire` : **code 0 / mode in-place** (aucune autre session parallèle).
  Le plan interdisant tout commit direct sur la branche principale
  (`feature/migration-postgresql`), le travail a été mené dans un **worktree + branche
  dédiée** (`session-guard worktree`), comme pour la tâche T2 précédente.
- `node_modules` symlinké dans le worktree pour l'exécution (gitignoré, non committé).
- **Aucun push** (merge/push = étape d'orchestration ultérieure). Le worktree et la
  branche sont **conservés** (un `session-guard remove` supprimerait la branche et donc
  les commits) ; seul le verrou est libéré (`release`).

## 3. Branches et commits

| Repo | Branche | Commit | Base |
|------|---------|--------|------|
| `opencode-mcp-task-orchestrator` | `build-notify/sprint-cycle-de-vie-rapport` | `8d77d012e7cb977c4191d38914595582d5396621` | `5444381` |

Trace **append-only** persistée (`plan_commits` : **1 commit**, 3 fichiers, **29 287
caractères de diff**) via la fonction de registre `addPlanCommit` (code identique au
tool `plan_commit_add` — garantit les diffs exacts) :
`db.mjs` (modified, +423/-8), `index.mjs` (modified, +21/-0), `schema.sql` (modified, +27/-2).
`plan_set_branch(planId, "build-notify/sprint-cycle-de-vie-rapport")` effectué.

## 4. Traitements effectués (17/17)

| Étape | Statut | Détail |
|-------|--------|--------|
| A001 | done | `schema.sql` — `sprints` étendue (5 colonnes) + `idx_sprints_project_status` + `idx_sprints_default` (partiel unique `WHERE is_default = 1`) + gardes `ALTER … IF NOT EXISTS` (base existante). |
| A002 | done | `schema.sql` — `tasks` : `emergent`, `emergent_origin` + `idx_tasks_emergent` (partiel) + gardes `ALTER`. |
| A003 | done | `db.mjs migrate()` — miroir DDL : `ALTER sprints` ×5, `ALTER tasks` ×2, 3 index. |
| A004 | done | `rowToSprint` + `closeSprint(sprintId, { reason, by })` — clôture bas niveau **idempotente**, aucune écriture `tasks`/`executions`. |
| A005 | done | `autoCloseExpiredSprints({ projectId })` — balayage `open ∧ auto_close=1 ∧ end_date < now` → `close` + `auto_echeance` ; idempotent. |
| A006 | done | `getSprint(sprintId)` + `listProjectSprints(projectId, { status })`. |
| A007 | done | `classifyEmergence(projectId, { kind })` — `piece` / `element`, non bloquante, déterministe, balaye la clôture auto. |
| A008 | done | `detectOpenSprint` appelle `autoCloseExpiredSprints` avant sélection ; forme `{ sprintId, status }` **inchangée**. |
| A009 | done | `addPiece` branché sur `classifyEmergence(pid, { kind:'piece' })` — origines T2 (`apres_init_sprint`/`apres_cloture`) et lien `sprint_pieces` conservés. |
| A010 | done | `createTask` : après INSERT + exécution, `classifyEmergence(project, { kind:'element' })` → `UPDATE tasks SET emergent=1, emergent_origin=…` si émergente. |
| A011 | done | `ensureDefaultSprint(projectId, { title, startDate, endDate, createdBy })` — idempotent (`ON CONFLICT … WHERE is_default = 1`), `close`/`auto_echeance` si échéance passée. |
| A012 | done | `migrateExistingToDefaultSprint({ projectId, … })` — rattache `recette_sprints`/`task_sprints` des recettes/tâches **sans lien**, **sans** marquage émergent. |
| A013 | done | `reopenSprint(sprintId, { endDate, autoClose, by })` — `open` + `reopened_at`, efface `closed_at`/`close_reason`, `auto_close=0` si échéance passée sans prolongation. |
| A014 | done | `buildSprintReport(sprintId, { format })` — JSON + markdown (features implémentées/émergentes, tâches effectuées/émergentes, règles, pièces, recettes). |
| A015 | done | `index.mjs` — import `buildSprintReport` + tool **`sprint_report`** (markdown\|json, lecture seule). |
| A016 | done | `rowToTask` expose `emergent` / `emergentOrigin`. |
| A017 | done | Vérification : **46/46 PASS ×2** (idempotence) + **MCP spawn 7/7 PASS** + `node --check` + non-régression ADR/`artifacts`. |

## 5. Fichiers modifiés / créés

Dans le worktree (commit `8d77d01`) :

- `schema.sql` (modifié) — A001, A002.
- `db.mjs` (modifié) — A003-A014, A016 (+ `detectOpenSprint`, `addPiece`, `createTask`, `rowToTask`).
- `index.mjs` (modifié) — A015 (import + tool `sprint_report`).

Aucun fichier créé. **Aucune** modification de la famille ADR (`adr_*`, `doc_type='adr'`),
ni du modèle polymorphe `artifacts`, ni des tables de liens T1.

## 6. Vérifications (preuves)

### 6.1 Cycle complet + idempotence — **46/46 PASS** (exécuté 2×, 2 process distincts)

- **Colonnes/index** : `sprints` (5 colonnes), `tasks` (2 colonnes) ; `idx_sprints_default`,
  `idx_sprints_project_status`, `idx_tasks_emergent` présents.
- **A010** : `createTask` hors sprint → `emergent=true` / `hors_sprint` ; `rowToTask` expose les champs.
- **A011** : `ensureDefaultSprint` → `is_default`, `close`/`auto_echeance` si échéance passée ;
  **idempotent** ; **1 seul** défaut par projet (index partiel unique).
- **A012** : rattache **1 recette / 1 tâche** ; **émergence non rétroactive** (tâche reste
  `hors_sprint`) ; 2ᵉ passage = 0/0 (idempotent).
- **A007** : `element` sur sprint `close` → `apres_cloture` ; `piece` idem ; `element` sur
  sprint `open` → non émergent ; `piece` sur sprint `open` → `apres_init_sprint`.
- **A013** : `reopen` → `open` + `reopened_at`, `closed_at`/`close_reason` effacés,
  `auto_close=0` (échéance passée) ; **pas de re-clôture** au balayage suivant.
- **A009** : `addPiece` sur sprint `open` → `emergent`/`apres_init_sprint`, lien `sprint_pieces`.
- **A004** : `closeSprint` manuel + **idempotent** (`closed_at` stable).
- **A005** : sprint échu clôturé automatiquement (`auto_echeance`, `closed_at`) ; idempotent ;
  **la clôture de sprint NE TOUCHE PAS les tâches** (statut d'exécution `queued → queued`).
- **A008** : `detectOpenSprint` conserve `{ sprintId, status }`.
- **A014** : rapport → `1` fonctionnalité implémentée, `1` émergente, `1` tâche effectuée,
  `1` émergente, `1` règle émergente, `1` pièce émergente, `1` recette ; markdown non vide.
- **Idempotence** : relance complète du script (nouveau process) → **46/46 PASS** à nouveau
  (rejeu `schema.sql` + `migrate()` sans erreur).
- **Non-régression** : `listAdrs` répond (4 ADR), table `artifacts` intacte (833 lignes).

### 6.2 Spawn réel du MCP — **7/7 PASS**

MCP `index.mjs` du worktree lancé en stdio (JSON-RPC) :
`initialize` OK ; `tools/list` → **119 tools**, expose `sprint_report` **et** `piece_add`
(T2 conservé) ; `sprint_report` **json** (`stats` complet) ; `sprint_report` **markdown** ;
`piece_add` via MCP → `emergent=true`/`apres_init_sprint` ; `sprint_report` sur sprint
inconnu → erreur propre.

### 6.3 E2E Playwright : **NA**

Aucun `playwright.config.*` ni spec E2E dans `opencode-mcp-task-orchestrator` ; comportement
**interne** (registre MCP), non observable par un parcours Playwright. Aucun
`e2e_test_register` / `e2e_test_link` (conforme plan §9). Vérification par appels MCP + requêtes registre.

## 7. Avertissements / erreurs / écarts

1. **Incohérence de plan `INCO-047` (non bloquante, résolue)** — l'ordre DDL du plan était
   inapplicable à une **base existante** : A001 exige `idx_sprints_default` dans
   `schema.sql`, mais la colonne `is_default` n'est ajoutée que par A003 (`migrate()`),
   exécuté **après** `schema.sql` par `ensureSchema()`. Sur la base courante (`sprints`
   déjà créée sans `is_default`), le rejeu de `schema.sql` échouait
   (`column is_default does not exist`) → A017 (idempotence) impossible. **Résolution
   additive** : gardes `ALTER TABLE … ADD COLUMN IF NOT EXISTS` idempotentes insérées dans
   `schema.sql` **avant** les index (miroir de `migrate()`). Aucune signature modifiée,
   A001 conservé. Tracé : `task_event(INCONSISTENCY_FOUND)` + `plan-manager_inconsistency_create`
   → `INCO-047`.
2. **Émergence `hors_sprint` des nouvelles tâches** — tout projet **sans sprint** verra ses
   nouvelles tâches marquées `emergent=1`/`hors_sprint` (conforme ADR-001 §5, tracé et non
   bloquant). Les tâches existantes ne sont **pas** re-marquées (non rétroactif). Attendu
   jusqu'à la migration T9.
3. **Base partagée** — `ensureSchema()` du worktree a appliqué le DDL additif à la base
   PostgreSQL partagée (`task_registry`) : colonnes + index ajoutés (additif, idempotent).
   Aucun impact sur le MCP en cours du checkout principal (rétrocompatible).
4. **Frontière T4** — seul le tool `sprint_report` (lecture seule) est posé ; le CRUD
   `sprint_*` reste à T4, qui réutilisera les fonctions livrées ici.

## 8. Prochaines étapes / recommandations

1. **Merge/push** de la branche `build-notify/sprint-cycle-de-vie-rapport` par
   l'orchestrateur (sync avec `feature/migration-postgresql` avant push) — **non fait ici**.
2. **T4** : famille MCP `sprint_*` CRUD (création/liste/détail/rattachement/clôture
   manuelle/reprise/rapport) — **réutiliser** `getSprint`, `listProjectSprints`,
   `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`, `ensureDefaultSprint`,
   `buildSprintReport` (pas de duplication).
3. **T5** : appeler `classifyEmergence(projectId, { kind:'element' })` à la création d'une
   fonctionnalité/règle.
4. **T9** : session de migration des anciens sprints — appeler
   `migrateExistingToDefaultSprint` par projet avec le calendrier réel (myxmax 14/09/2026,
   madatalk 07/09/2026).
5. **ADR-001** est **Proposé** : l'acceptation reste une **décision humaine**.
