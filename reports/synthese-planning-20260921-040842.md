# Synthèse de planification — T-20260920-162757-sxi4

- **Date** : 2026-09-21 04:09
- **Agent** : `atomic-plan`
- **Tâche** : `T-20260920-162757-sxi4` (executionId `E-T-20260920-162757-sxi4-oq4bgd`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 5/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` (item improvement — recette item 124)
- **Repo** : `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`, branche `feature/migration-postgresql`)

---

## 1. Objectifs identifiés (Phase 0)

**Un seul objectif** (borné, non interdépendant d'un autre) :

> Retirer du projet `ecosystem` le repo orphelin `opencode-agents` (nom « ia-crm ») dont le workspace Coder `ia-crm` a été supprimé, et neutraliser son pointeur de workspace, afin que plus aucun repo du projet ne pointe vers un workspace inexistant.

→ **1 plan** (aucun autre plan requis).

## 2. Plan produit

| Plan | Fichier | Étapes | Décision structurante |
|---|---|---|---|
| `Plan-nettoyer-repo-orphelin-ia-crm-20260921-040842` | `plans/Plan-nettoyer-repo-orphelin-ia-crm-20260921-040842.md` | A001 → A002 → A003 → A004 | `project_repo_unlink` + neutralisation de l'entité — **pas** de `repo_delete` |

**Nature** : plan d'**opérations registre** (données) via tools MCP. **Aucune modification de code** (`index.mjs`, `db.mjs`, `schema.sql` inchangés) — le scope déclaré `index.mjs` n'est pas nécessaire, les tools `project_repo_unlink` (`index.mjs` l.511-518) et `repo_register` (l.293-317) couvrent le besoin.

**Résumé des étapes** :
- **A001** — inventaire read-only des références à `opencode-agents` (garde-fou recette item 124) ;
- **A002** — `project_repo_unlink(projectId='ecosystem', repoId='opencode-agents')` ;
- **A003** — `repo_register` sur l'entité conservée : `workspace` → `NULL` + libellé/description « inactif — workspace supprimé » ;
- **A004** — contrôle final du critère d'acceptation.

## 3. Inventaire d'impact — références à `opencode-agents`

| Nature | Cible | Impact |
|---|---|---|
| `project_repos` | `ecosystem` ↔ `opencode-agents` (rôle `outillage`) | **retirée** (A002) |
| `repos` (entité) | `workspace='ia-crm'` (workspace supprimé) | **neutralisée** (A003) |
| `task_repos` | **9 tâches** | **conservées** (unlink ne les touche pas) |
| `doc_repos` | 0 (`doc_list(repoId='opencode-agents')` = 0) | aucun |
| `e2e_test_repos` | 0 (`e2e_list(project='ecosystem')` = 0) | aucun |
| `worktrees` | 0 (`worktree_list(project='ecosystem')` = 0) | aucun |

**9 tâches portant `opencode-agents`** (association automatique « défaut = tous les repos du projet ») :

| TaskId | Statut |
|---|---|
| `T-20260913-134907-apsr` | done |
| `T-20260920-162753-hpcj` | done |
| `T-20260920-162754-b4cb` | done |
| `T-20260920-162755-3qxj` | done |
| `T-20260920-162756-m30s` | done |
| `T-20260920-162757-sxi4` | planning (courante) |
| `T-20260920-162758-8c12` | queued |
| `T-20260920-162800-aov1` | queued |
| `T-20260920-162801-jxtr` | queued |

Aucune de ces tâches n'a produit de commit/plan sur `opencode-agents` (livrables sur `opencode-mcp-task-orchestrator` / `opencode-observability` / `opencode-scripts`) → association sans substance.

## 4. Justification de la décision

| Option | Verdict | Raison |
|---|---|---|
| `project_repo_unlink` | **retenue** | Satisfait le critère (« retiré du projet »), réversible, zéro perte de données |
| `repo_delete` | rejetée | Irréversible + `ON DELETE CASCADE` sur `task_repos`/`doc_repos` → destruction des 9 associations historiques |
| Marquage inactif via `repos.meta` (JSONB) | impossible sans code | `meta` est lu (`db.mjs` l.1322) mais **aucun tool ne l'écrit** ni aucun code ne le filtre |
| Marquage inactif via `name`/`description` + `workspace=NULL` | **retenue (complément)** | Seule forme de marquage inactif réalisable avec les tools actuels, réversible |

## 5. Vérifications de cohérence

- **Phase 6 — intra-plan** : aucune contradiction (A002 retire une liaison, A003 modifie une entité distincte ; aucune étape `supprimer` ; A004 en fin de chaîne). **VALID**.
- **Phase 7 — Plan Validator** : **VALID** (couverture 100 %, étapes atomiques).
- **Phase 9 — globale (inter-plans du batch)** : **aucune incohérence**. Ce plan **ne modifie aucun fichier de code** → aucun chevauchement de fichiers avec les plans du batch (qui touchent `db.mjs`, `index.mjs`, `schema.sql`, `pilot.mjs`, `server.mjs`, `public/app.js`). Les opérations registre portent sur l'entité `repos['opencode-agents']` et la liaison `project_repos('ecosystem','opencode-agents')`, non touchées par les autres plans.

## 6. Tests E2E

**NA** — opération de données registre sans comportement utilisateur observable ; `e2e_list(project='ecosystem')` = 0 test. Aucun scénario à créer/modifier/obsoléter, aucun `e2e_test_link`.

## 7. Traçabilité

- `plan_register` : `planId = Plan-nettoyer-repo-orphelin-ia-crm-20260921-040842` (taskId `T-20260920-162757-sxi4`) ;
- `artifact_add` : `ART-T-20260920-162757-sxi4-muaq7iwm-o7c2` (kind=plan) ;
- `participant_add` : `atomic-plan` / `planner` ;
- `task_event` : `PLANNING_STARTED` + `PLAN_CREATED` (by `atomic-plan`).
