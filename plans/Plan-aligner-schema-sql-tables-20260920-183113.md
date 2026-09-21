# Plan — Aligner `schema.sql` sur l'ensemble des tables de `db.mjs`

- **Plan ID** : `Plan-aligner-schema-sql-tables-20260920-183113`
- **Tâche** : `T-20260920-162756-m30s` (rework de la recette `RECT-mu9yzd23-8l7t`)
- **Projet** : `ecosystem`
- **Repo** : `opencode-mcp-task-orchestrator` → `/root/.config/opencode/mcp/task-orchestrator`
- **Branche** : `feature/migration-postgresql`
- **Scope** : `schema.sql`, `db.mjs`
- **Date** : 2026-09-20 18:31
- **Type** : feature (alignement schéma) — E2E : **NA** (aucun comportement utilisateur observable)

---

## 1. Objectif

`schema.sql` — **source de vérité LOGIQUE** chargée par `ensureSchema()` **AVANT** `migrate()` (db.mjs l.31-41) — doit contenir **toutes** les tables majeures créées par `db.mjs`, en `CREATE TABLE IF NOT EXISTS` **identiques** (colonnes, contraintes, FK) et dans un **ordre idempotent** (chaque FK pointe vers une table déjà créée).

Critère mesurable : `{tables CREATE TABLE de db.mjs} ⊆ {tables CREATE TABLE de schema.sql}`, et `ensureSchema()` reste **idempotent** sur une base PostgreSQL **déjà migrée**.

## 2. Contexte & raison d'être

Plusieurs tables n'existent aujourd'hui **que** dans `migrate()` de `db.mjs` : leur création dépend de la migration applicative et non du schéma de référence. La recette `RECT-mu9yzd23-8l7t` a relevé cette désynchronisation (source de vérité logique incomplète).

- **T1** (`T-20260920-162753-hpcj`, done) a déjà aligné `repos`, `project_repos`, `docs`, `doc_projects`, `doc_repos` (commit `2ff160c`, merge `eec3a4f`).
- **T3** (`T-20260920-162755-3qxj`, done) a ajouté `doc_attachments` (commit `a2d4f53`, merge `74439ab`).

L'inventaire exhaustif mené ici (Phase 1, `grep -oE "CREATE TABLE IF NOT EXISTS [a-zA-Z0-9_]+"`) révèle qu'il reste **3 tables** manquantes.

### Inventaire exhaustif (preuve Phase 1)

| Source | Nombre | Tables |
|---|---|---|
| `db.mjs` (`migrate()`) | 18 | recette_tasks, e2e_tests, e2e_test_projects, e2e_test_params, task_e2e, e2e_executions, e2e_vars, recette_documents, repos, project_repos, docs, doc_projects, doc_repos, doc_attachments, **task_repos**, **e2e_test_repos**, organizations, **org_git_tokens** |
| `schema.sql` | 39 | tasks, organizations, projects, repos, project_repos, docs, doc_projects, doc_repos, doc_attachments, executions, task_sessions, worktrees, events, deployments, decisions, participants, artifacts, task_links, recettes, recette_tasks, recette_projects, recette_items, recette_documents, plans, plan_executions, plan_commits, plan_steps, plan_incidents, plan_inconsistencies, plan_counters, scope_conflicts, e2e_tests, e2e_test_projects, e2e_test_params, task_e2e, e2e_executions, e2e_vars, batches, batch_tasks |

**Écart `db.mjs` − `schema.sql` = `{ task_repos, e2e_test_repos, org_git_tokens }` → 3 tables à ajouter.**

Les autres tables de `schema.sql` absentes de `migrate()` (tasks, projects, executions, task_sessions, worktrees, events, deployments, decisions, participants, artifacts, task_links, recettes, recette_projects, recette_items, plans, plan_executions, plan_commits, plan_steps, plan_incidents, plan_inconsistencies, plan_counters, scope_conflicts, batches, batch_tasks) sont **normales** : `schema.sql` est la source de vérité, `migrate()` n'ajoute que les compléments. Aucune table de `schema.sql` n'est à retirer.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| **A001** | ajouter | table `org_git_tokens` (`id` PK, `org` FK `organizations(id)` ON DELETE CASCADE, `name`, `token_enc`, `created_at`, `created_by`) + index `idx_org_git_tokens_org` | `db.mjs` l.394-402 | `schema.sql`, **juste après** la table `organizations` (l.42) | v0.10 — tokens git multiples par organisation (chiffrés) ; table absente de `schema.sql` | `org_git_tokens` + `idx_org_git_tokens_org` créés par `schema.sql` (avant `migrate()`) |
| **A002** | ajouter | table `task_repos` (`task_id` FK `tasks(id)` ON DELETE CASCADE, `repo_id` FK `repos(id)` ON DELETE CASCADE, PK `(task_id, repo_id)`) + index `idx_task_repos_repo` | `db.mjs` l.297-302 | `schema.sql`, **juste après** la table `project_repos` (l.89) | ADR 09 — tâches ⇄ repos (N:N) ; table absente de `schema.sql` | `task_repos` + `idx_task_repos_repo` créés par `schema.sql` |
| **A003** | ajouter | table `e2e_test_repos` (`e2e_test_id` FK `e2e_tests(id)` ON DELETE CASCADE, `repo_id` TEXT NOT NULL **sans FK**, PK `(e2e_test_id, repo_id)`) + index `idx_e2e_test_repos_repo` | `db.mjs` l.320-325 | `schema.sql`, **juste après** la table `e2e_test_projects` (l.494) | ADR 11 — repos traversés (N:N) ; table absente de `schema.sql` | `e2e_test_repos` + `idx_e2e_test_repos_repo` créés par `schema.sql` |
| **A004** | vérifier | ensembles `CREATE TABLE IF NOT EXISTS` de `db.mjs` et `schema.sql` + ordre des FK + index laissés dans `migrate()` | `db.mjs`, `schema.sql` | — | garantir la couverture 100 % et l'absence de régression d'ordre/index | rapport de contrôle : écart vide, `schema.sql` = 42 `CREATE TABLE`, ordre FK valide, `ensureSchema()` idempotent |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `schema.sql` | **modification** — ajout de 3 `CREATE TABLE IF NOT EXISTS` + 3 `CREATE INDEX IF NOT EXISTS` |
| `db.mjs` | **aucune modification** — sert de référence DDL ; `migrate()` est conservé tel quel (les `CREATE TABLE IF NOT EXISTS` redondants restent, idempotents) |

## 5. Livrables attendus

1. `schema.sql` contient les tables `org_git_tokens`, `task_repos`, `e2e_test_repos` avec un DDL **identique** à celui de `db.mjs` (colonnes, types, FK, PK, ON DELETE CASCADE).
2. Les 3 index associés (`idx_org_git_tokens_org`, `idx_task_repos_repo`, `idx_e2e_test_repos_repo`) sont déclarés dans `schema.sql` (ces tables n'ont **aucune** colonne ajoutée par `ALTER`, donc les index peuvent y figurer).
3. Plus aucune table de `db.mjs` n'est absente de `schema.sql` (`db.mjs − schema.sql = ∅`).
4. `migrate()` **inchangé** : les `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` et les index sur colonnes ALTER (`idx_docs_status`, `idx_e2e_executions_origin`) restent dans `migrate()`, **après** les ALTER (règle recette item 123).
5. `ensureSchema()` reste idempotent sur une base existante (aucun `DROP`, aucun ALTER destructif ajouté ; `CREATE ... IF NOT EXISTS` uniquement).

## 6. Ordre & dépendances

```
A001 (org_git_tokens)  ┐
A002 (task_repos)      ├─► A004 (contrôle inventaire + idempotence)
A003 (e2e_test_repos)  ┘
```

- **A001, A002, A003** : indépendantes sur le fond (tables/régions distinctes) mais toutes dans `schema.sql` → à appliquer **séquentiellement** pour éviter tout conflit d'édition.
- **A004** : dépend de A001+A002+A003 (vérifie l'ensemble).
- **Ordre interne imposé par les FK** (Phase 4) :
  - `org_git_tokens` → doit suivre `organizations` (l.36) ✅ placé l.42.
  - `task_repos` → doit suivre `tasks` (l.7) **et** `repos` (l.61) ✅ placé l.89.
  - `e2e_test_repos` → doit suivre `e2e_tests` (l.470) ✅ placé après `e2e_test_projects` (l.494).

## 7. Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|----------|----------|-----------|
| `schema.sql` contient `org_git_tokens` (v0.10) | A001 | ✅ |
| `schema.sql` contient `task_repos` (ADR 09) | A002 | ✅ |
| `schema.sql` contient `e2e_test_repos` (ADR 11) | A003 | ✅ |
| DDL identique à `db.mjs` (colonnes, FK, PK, CASCADE) | A001, A002, A003 | ✅ |
| Ordre idempotent (FK → tables déjà créées) | A001, A002, A003 | ✅ |
| Aucune autre table majeure manquante (inventaire exhaustif) | A004 | ✅ |
| `ensureSchema()` idempotent sur base PostgreSQL existante | A001, A002, A003, A004 | ✅ |
| ALTER + index sur colonnes ALTER restent dans `migrate()` | A001, A002, A003 (ne rien déplacer) | ✅ |

## 8. Vérification de cohérence

**Phase 6 — contradictions intra-plan** : aucune.
- Aucune étape `supprimer` / `renommer` / `déplacer` : uniquement des `ajouter` sur 3 tables distinctes.
- Les 3 éléments cibles n'existent pas encore dans `schema.sql` (vérifié par `grep` : aucune occurrence de `idx_task_repos_repo`, `idx_e2e_test_repos_repo`, `idx_org_git_tokens_org`) → pas de doublon.
- Aucune étape ne lit/modifie un élément créé par une étape ultérieure (A004 est en fin de chaîne).
- `db.mjs` n'est pas modifié → aucun risque de contradiction avec `migrate()`.

**Phase 7 — Plan Validator** : **VALID**
- Aucune contradiction (Phase 6) ;
- Couverture 100 % (Phase 5) ;
- Toutes les étapes sont atomiques (un élément × un fichier × un verbe précis).

## 9. Risques & notes

- **Ne pas déplacer** les `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` de `migrate()` ni les index portant sur des colonnes ajoutées par ALTER (`idx_docs_status`, `idx_e2e_executions_origin`) : sur une base **déjà migrée**, `schema.sql` s'exécute **avant** `migrate()`, donc la colonne n'existe pas encore au moment du chargement de `schema.sql` (précédent documenté `schema.sql` l.118-119 et l.544-545).
- **DDL strictement identique** : `e2e_test_repos.repo_id` est un `TEXT NOT NULL` **sans FK** dans `db.mjs` (l.322) → ne **pas** ajouter de `REFERENCES repos(id)` (une FK inexistante côté code ferait diverger le schéma).
- **Ne pas supprimer** les `CREATE TABLE IF NOT EXISTS` redondants de `migrate()` : ils restent la défense des bases existantes et sont idempotents (le but est d'ajouter à `schema.sql`, pas de retirer de `migrate()`).
- **E2E : NA** — tâche d'alignement de schéma interne (registre), sans parcours utilisateur observable. Aucun scénario Playwright à créer/modifier/obsoléter, aucun lien `e2e_test_link`.
- **Base de données** : aucune modification de données ; `ensureSchema()` ne fait que du DDL `IF NOT EXISTS`.
