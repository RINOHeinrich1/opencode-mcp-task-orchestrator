# Synthèse de planification — T-20260920-162756-m30s

- **Date** : 2026-09-20 18:31
- **Tâche** : `T-20260920-162756-m30s` (rework de la recette `RECT-mu9yzd23-8l7t`)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Branche** : `feature/migration-postgresql`
- **Planner** : `atomic-plan`
- **Batch** : `BATCH-mua15lwb-ifqw` (position 4/8)

## Objectifs identifiés

Un seul objectif (mono-plan) : **aligner `schema.sql` sur l'ensemble des tables créées par `db.mjs`**.

## Plans produits

| Plan | Fichier | Étapes | E2E |
|------|---------|--------|-----|
| `Plan-aligner-schema-sql-tables-20260920-183113` | `plans/Plan-aligner-schema-sql-tables-20260920-183113.md` | A001 → A002 → A003 → A004 | NA |

## Inventaire — tables manquantes recensées

Comparaison `{CREATE TABLE IF NOT EXISTS}` entre `db.mjs` (18) et `schema.sql` (39) :

**`db.mjs − schema.sql = { task_repos, e2e_test_repos, org_git_tokens }`** (3 tables).

| Table | Source `db.mjs` | Nature | Étape |
|-------|-----------------|--------|-------|
| `org_git_tokens` | l.394-402 | v0.10 — tokens git multiples par organisation | A001 |
| `task_repos` | l.297-302 | ADR 09 — tâches ⇄ repos N:N | A002 |
| `e2e_test_repos` | l.320-325 | ADR 11 — repos traversés N:N | A003 |

Déjà alignées par T1 (`repos`, `project_repos`, `docs`, `doc_projects`, `doc_repos`) et T3 (`doc_attachments`).

## Vérifications de cohérence

- **Intra-plan (Phase 6)** : aucune contradiction — 3 `ajouter` sur des tables distinctes et absentes ; aucune suppression/renommage/déplacement ; `db.mjs` non modifié.
- **Globale (Phase 9)** : un seul plan → aucune incohérence inter-plans.
- **Gate (Phase 7)** : plan **VALID** (couverture 100 %, étapes atomiques, ordre FK idempotent).

## Points de vigilance (recette item 123)

- Les `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` restent dans `migrate()`.
- Les index sur colonnes ajoutées par ALTER (`idx_docs_status`, `idx_e2e_executions_origin`) restent dans `migrate()` **après** les ALTER — non déplacés dans `schema.sql`.
- `e2e_test_repos.repo_id` = `TEXT NOT NULL` **sans FK** (DDL identique exigé).
- Les `CREATE TABLE IF NOT EXISTS` redondants de `migrate()` sont conservés (défense base existante, idempotence).

## E2E

**NA** — tâche d'alignement de schéma interne au registre, sans comportement utilisateur observable.
