# Rapport — Aligner `schema.sql` sur les tables de `db.mjs`

- **Tâche** : `T-20260920-162756-m30s`
- **Exécution** : `E-T-20260920-162756-m30s-4siepb`
- **Plan** : `Plan-aligner-schema-sql-tables-20260920-183113` (4 étapes A001–A004)
- **Projet** : `ecosystem`
- **Repo** : `opencode-mcp-task-orchestrator` → `/root/.config/opencode/mcp/task-orchestrator`
- **Branche** : `feature/migration-postgresql`
- **Date** : 2026-09-21 03:45:32

## Résumé

Demandé : aligner `schema.sql` (source de vérité **logique**, chargée par
`ensureSchema()` **avant** `migrate()`) sur l'ensemble des tables créées par
`db.mjs`, en ajoutant les 3 tables manquantes en `CREATE TABLE IF NOT EXISTS`
identiques, dans un ordre idempotent (FK → tables déjà créées), sans toucher à
`db.mjs` ni déplacer les `ALTER … ADD COLUMN IF NOT EXISTS` et leurs index.

Fait : ajout des 3 tables + 3 index à `schema.sql` (34 lignes ajoutées, 0
supprimée). `db.mjs` **inchangé**. Toutes les vérifications passent :
`db.mjs − schema.sql = ∅`, `schema.sql` = 42 `CREATE TABLE`, ordre FK valide,
`ensureSchema()` idempotent (2 passes sur base scratch).

## Isolation

- Espace Coder : **non applicable** — `opencode-mcp-task-orchestrator` est un
  composant d'**infrastructure hôte** (panneau/MCP task-orchestrator), absent de
  tout workspace Coder (`workspace_list` : aucun workspace ne contient ce repo).
  Traitement **in-place** sur l'hôte, conformément au cadrage de la tâche.
- `session-guard acquire` → `mode: "in-place"` (aucune autre session parallèle
  sur ce projet) → travail dans le checkout courant, branche
  `feature/migration-postgresql`.
- Aucun worktree dédié nécessaire.

## Branches et commits

- Branche de travail : `feature/migration-postgresql`
- Commit (base `74439ab` → HEAD) :
  - `82d572bdb3ff2b09e2c03b34fa3a351c6f95510e` — `fix(schema): aligner schema.sql sur db.mjs (task_repos, e2e_test_repos, org_git_tokens)`

## Traitements effectués

| Étape | Action | Résultat |
|---|---|---|
| A001 | `org_git_tokens` + `idx_org_git_tokens_org` ajoutés **après** `organizations` | ✅ DDL identique `db.mjs` l.394-402 (`org` FK `organizations(id)` ON DELETE CASCADE) |
| A002 | `task_repos` + `idx_task_repos_repo` ajoutés **après** `project_repos` | ✅ DDL identique `db.mjs` l.297-302 (FK `tasks(id)`/`repos(id)` CASCADE, PK composite) |
| A003 | `e2e_test_repos` + `idx_e2e_test_repos_repo` ajoutés **après** `e2e_test_projects` | ✅ DDL identique `db.mjs` l.320-325 ; `repo_id TEXT NOT NULL` **sans FK** (répliqué tel quel) |
| A004 | Contrôle inventaire + ordre FK + idempotence + `node --check` | ✅ tous verts |

`db.mjs` non modifié : les `ALTER … ADD COLUMN IF NOT EXISTS` et les index sur
colonnes ALTER (`idx_docs_status`, `idx_e2e_executions_origin`) restent dans
`migrate()`.

## Fichiers modifiés / créés

- **Modifié** : `schema.sql` (+34 lignes, 0 suppression) — 3 `CREATE TABLE IF NOT EXISTS` + 3 `CREATE INDEX IF NOT EXISTS`.
- **Créé** : `reports/report-schema-sql-align-20260921-034532.md` (ce rapport).
- `db.mjs` : **inchangé** (git diff : 1 fichier modifié, `schema.sql`).

## Vérifications (preuves)

1. **Inventaire exhaustif `CREATE TABLE`**
   - `db.mjs` : 18 tables ; `schema.sql` : 42 tables.
   - `comm -23` (db.mjs − schema.sql) → **écart vide** ✅
   - `schema.sql − db.mjs` = 24 tables (attendu : `schema.sql` est la source de vérité, `migrate()` n'ajoute que des compléments).
2. **Anti-doublon** : exactement 3 occurrences des nouvelles tables dans `schema.sql` ✅
3. **Ordre FK** : script de scan (42 tables) → **0 FK invalide** (chaque `REFERENCES` cible une table déjà créée) ; `idx_org_git_tokens_org` bien avant `projects` ✅
4. **DDL identique** (contrôle `information_schema`/`pg_constraint` sur base réelle) :
   - `org_git_tokens` : PK `id`, FK `org → organizations(id) ON DELETE CASCADE` ✅
   - `task_repos` : PK `(task_id, repo_id)`, FK `task_id → tasks`, `repo_id → repos` CASCADE ✅
   - `e2e_test_repos` : PK `(e2e_test_id, repo_id)`, FK `e2e_test_id → e2e_tests` CASCADE, **aucune FK sur `repo_id`** ✅
   - 3 index `idx_*` présents ✅
5. **Idempotence `ensureSchema()`** : base scratch `task_registry_idem_test` créée → **passe 1** (base vierge, `listTasks()` → 0) ✅ → **passe 2** (base déjà migrée, rejeu → 0, aucune erreur) ✅ → base scratch supprimée.
6. **`node --check db.mjs`** → OK ✅
7. **Index sur colonnes ALTER** : `idx_docs_status` / `idx_e2e_executions_origin` toujours dans `migrate()` (db.mjs l.244 / l.139), pas dans `schema.sql` ✅

## Avertissements / erreurs

- Aucune erreur.
- Note d'isolation : traitement **in-place sur l'hôte** (composant d'infrastructure hors workspace Coder) — conforme au cadrage explicite de la tâche.

## Prochaines étapes / recommandations

- **Ne rien relancer** : MCP `task-orchestrator` en stdio, pas de process persistant à redémarrer.
- **Déploiement** : merge + push de `feature/migration-postgresql` gérés par l'orchestrateur **après review humain** (non effectués ici).
- E2E : **NA** (alignement de schéma interne au registre, aucun comportement utilisateur observable) — aucun test à créer/modifier/obsoléter.
