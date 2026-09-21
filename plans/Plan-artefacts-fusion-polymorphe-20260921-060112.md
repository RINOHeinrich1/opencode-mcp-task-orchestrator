# Plan — Artefacts : gestionnaire central UNIQUE polymorphe (fusion physique `artifacts` + `recette_documents` + `docs`, `doc_type` + `content_id`, taxonomie, plan de migration)

- **Plan ID** : `Plan-artefacts-fusion-polymorphe-20260921-060112`
- **Tâche** : `T-20260920-162801-jxtr` (executionId `E-T-20260920-162801-jxtr-vfbfzp`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 8/8, dernière)
- **Recette source** : `RECT-mu9yzd23-8l7t` — **item 127**
- **Repos / dossiers concernés** :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (registre MCP : `schema.sql`, `db.mjs`, `index.mjs` + nouveau `scripts/`)
  - `opencode-observability` = `/root/orchestrator-panel` (panneau : `server.mjs`, `public/app.js`, `public/style.css` + nouveau `public/docs/nomenclature-doc-type.md`)
- **Dépendances (livrées, done)** :
  - `T-20260920-162753-hpcj` (item 120) — champs ADR structurés sur `docs` (`status/context/decision/consequences/replaced_by/is_global/meta/updated_at`) + `doc_projects`/`doc_repos`. Plan `plans/Plan-adr-modele-structure-20260920-163126.md`.
  - `T-20260920-162755-3qxj` (item 122) — table `doc_attachments`. Plan `plans/Plan-adr-pieces-jointes-20260920-173615.md`.
  - `T-20260920-162758-8c12` (item 125) — famille `adr_*` (9 tools) + `adr_conflicts` (commit MCP `077bcb9`). Plan `plans/Plan-adr-expositions-mcp-agents-panneau-20260921-044549.md`.
  - `T-20260920-162800-aov1` (item 126) — `adr_vigilances` append-only + garde `confirmRecette` (commit MCP `9187ea9`). Plan `plans/Plan-adr-gouvernance-recette-20260921-054153.md`.
- **Date** : 2026-09-21 06:01:12
- **Fichier plan** : `plans/Plan-artefacts-fusion-polymorphe-20260921-060112.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)

## 1. Objectif

Fusionner **physiquement** les 3 silos d'artefacts (`artifacts` lié aux tâches, `recette_documents`, `docs` ADR-12 — + les pièces jointes `doc_attachments` qui préfiguraient déjà `artifacts`) en **UNE SEULE table polymorphe `artifacts`** identifiée par le couple **(`doc_type`, `content_id`)** — `doc_type` = type d'artefact (taxonomie énumérée de 14 valeurs dont `autre`), `content_id` = identifiant de l'entité porteuse (taskId/recetteId/projectId/docId) ; `content_type` **jamais utilisé** (nom réservé) ; `kind` = **NATURE** (`plan|audit|report|autre`) distincte de `doc_type`. Conserver `kind`, `title`, `path`, `created_at`, `nature`, `source`, `meta` (JSONB) + les **champs ADR structurés** (`status/context/decision/consequences/replaced_by/is_global`) et le **N:N ADR↔projet/repo**. Étendre `artifact_add`/`artifact_list` (docType+contentId+kind+nature+meta) en gardant **`artifact_list(taskId)` rétrocompatible**. **Rebaser** les implémentations MCP `doc_*` ET `adr_*` sur `artifacts`. Transformer l'onglet panneau en **« Artefacts »**, gestionnaire central (toutes entités, colonnes Entité/Type/Nature, filtres, recherche, Regarder/Télécharger, ajout pour toute entité). Livrer le **plan de migration** complet (inventaire, mapping 1:1, script idempotent, validation, rollback défini, bascule, neutralisation des tables legacy).

## 2. Contexte & raison d'être

Aujourd'hui les artefacts sont **éclatés en 4 modèles physiques** qui dupliquent le même concept :

- **`artifacts`** (`schema.sql` l.302-312 ; `db.mjs` l.1184-1231) : `task_id TEXT NOT NULL REFERENCES tasks(id)` — **un artefact n'existe que rattaché à une tâche** ; visible seulement dans l'onglet « Documents » (scope tâche).
- **`recette_documents`** (`schema.sql` l.388-398 ; `db.mjs` l.2900-2941) : `recette_id` FK, `title/nature/source/path/artifact_id` — visible seulement dans la modale recette (`getRecetteById` l.2876 → `listRecetteDocuments`).
- **`docs`** (ADR-12, `schema.sql` l.123-158 ; `db.mjs` l.1531-1936) : `kind` ADR-12 + champs ADR structurés (item 120) + N:N `doc_projects`/`doc_repos` — visible seulement dans le détail projet / l'onglet ADR.
- **`doc_attachments`** (item 122, `schema.sql` l.169-185) : pièces jointes d'ADR, **déjà préfigurées** vers `artifacts` (`doc_type`/`content_id` présents, cf. commentaire `schema.sql` l.160-168).

Conséquences : trois vues disjointes, trois modèles d'API (`artifact_*`, `recette_doc_*`, `doc_*`/`adr_*`), aucune vue centrale. La décision Rino (item 127) est de **fusionner physiquement** en une table polymorphe et d'en faire un **gestionnaire central**.

Points structurants du contexte réel (ancrés sur le code lu) :

- **Rétrocompat CRITIQUE** : `artifact_list(taskId)` est consommé par 4 agents (`atomic-plan`, `build-notify`, `agent-recette`, `test-agent`) + le panneau (`public/app.js` l.1200, l.2601, l.2746). `recette_get` → `documents` est lu par l'agent-recette et par `server.mjs` l.2145-2154. `doc_list(includeRepoDocs)` est utilisé par `app.js` (l.1587, l.2238, l.2724, l.3795). Les jointures E2E (`e2e_executions.report_artifact_id` l.621, `video_url` l.623) pointent un `artifact_id` — elles ne doivent **jamais** perdre leur cible.
- **FK dépendantes de `docs(id)`** à rebaser/neutraliser : `doc_projects.doc_id` (l.147), `doc_repos.doc_id` (l.154), `doc_attachments.doc_id` (l.171) et `target_doc_id` (l.178), `adr_conflicts.adr_id` (l.195). Sans traitement, la neutralisation de `docs` casse ces contraintes.
- **`docs.meta` est TEXT** (JSON sérialisé, `parseDocMeta` l.1568-1572) alors que la cible demande **`meta` JSONB** : migration avec cast sûr (valeurs legacy non-JSON tolérées).
- **`artifacts.id`** est un IDENTITY (ordre d'insertion) et **`artifact_id`** la PK stable (l.304-305) : la migration **préserve `artifact_id`** (indispensable pour `report_artifact_id`).
- **`recette_documents.id` est un IDENTITY INTEGER** exposé en `documentId` par `listRecetteDocuments` (l.2922) et consommé par les routes panneau `[0-9]+` (`server.mjs` l.2113, l.2126) : il faut **préserver un `documentId` entier** (utiliser `artifacts.id` IDENTITY) pour ne pas casser la modale recette.
- **⚠️ INC-011** (`listDocs` `includeRepoDocs`+`status`, `db.mjs` l.1942-1944) est **hors périmètre** (tâche émergente séparée) : le rebasage doit **préserver la sémantique SQL actuelle** de `listDocs` (mêmes conditions, mêmes précédences) et ne pas « corriger » INC-011 ici.
- **Ordre séquentiel strict** (décision Rino) : le rebasage `doc_*`/`adr_*` n'intervient **qu'après** la bascule sur `artifacts` ; la neutralisation des tables legacy n'intervient **qu'après** validation complète ; **jamais de suppression avant validation**.

## 3. Tableau de synthèse des actions

> Convention : « Action » = verbe atomique (`Créer`/`Ajouter`/`Modifier`/`Remplacer`/`Rebaser`/`Migrer`/`Renommer`/`Supprimer`) ; « Élément de code » = l'entité précise (table, colonne, fonction, tool, route, fonction UI) ; le fichier cible = fichier source sauf mention contraire.

### Bloc 0 — Référentiel de taxonomie (nouveau fichier)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Créer | Fichier de référence **`public/docs/nomenclature-doc-type.md`** : (1) liste des 14 `doc_type` (`adr, specs, gherkin, project_doc, adr_file, plan, task_synthese, task_report, audit_report, recette_report, recette_doc, e2e_report, e2e_video, autre`) avec définition + exemple ; (2) **table de mapping 1:1** source→(`doc_type`,`content_id`,`kind`,`nature`,`source`,`meta`) ; (3) `kind` = NATURE (`plan|audit|report|autre`), domaines `source` (`import|artifact|registry|ref`) ; (4) **`content_type` = nom RÉSERVÉ, jamais créé/utilisé** (futur « type d'artefact ») ; (5) **comportement ON DELETE par famille** ; (6) règle : toute nouvelle valeur passe **d'abord** par `autre` puis formalisation ici | — (nouveau) | `/root/orchestrator-panel/public/docs/nomenclature-doc-type.md` | Fichier de référence **central partagé** (MCP + panneau) ; sert de source de vérité de la taxonomie et du mapping de migration | `nomenclature-doc-type.md` accessible via `/docs/nomenclature-doc-type.md` |

### Bloc 1 — Schéma cible (`schema.sql`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A002 | Remplacer | Bloc `CREATE TABLE IF NOT EXISTS artifacts` (l.302-312) par le **modèle polymorphe** : `id INTEGER GENERATED ALWAYS AS IDENTITY`, `artifact_id TEXT PRIMARY KEY`, `doc_type TEXT NOT NULL DEFAULT 'autre'`, `content_id TEXT NOT NULL`, `kind TEXT NOT NULL DEFAULT 'autre'`, `title TEXT`, `path TEXT`, `nature TEXT`, `source TEXT NOT NULL DEFAULT 'import'`, `meta JSONB`, `description TEXT`, `status TEXT`, `context TEXT`, `decision TEXT`, `consequences TEXT`, `replaced_by TEXT`, `is_global INTEGER NOT NULL DEFAULT 0`, `organization_id TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT`, `created_by TEXT` — **`task_id` supprimé**, **pas de colonne `content_type`** ; index `idx_artifacts_doc_type`, `idx_artifacts_content`, `idx_artifacts_kind` ; **déplacer le bloc AVANT `adr_conflicts`** (l.193) pour que la FK rebasée soit valide | `schema.sql` | `schema.sql` | Cœur de la fusion : une table polymorphe `(doc_type, content_id)` remplace les 4 modèles ; `content_type` reste réservé (jamais créé) | `schema.sql` porte la table polymorphe unique |
| A003 | Ajouter | `CREATE TABLE IF NOT EXISTS artifact_projects (artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, PRIMARY KEY (artifact_id, project_id))` + `idx_artifact_projects_project` ; idem `artifact_repos (artifact_id, repo_id, …)` + `idx_artifact_repos_repo` — **remplace** `doc_projects` (l.146-151) et `doc_repos` (l.153-158) | `schema.sql` | `schema.sql` | Conserver le **N:N ADR↔projet/repo** sur le nouveau modèle (item 120) | Tables de liaison rebasées |
| A004 | Modifier | `adr_conflicts.adr_id` (l.195) : FK `REFERENCES docs(id)` → `REFERENCES artifacts(artifact_id)` (DROP de l'ancienne FK + ADD de la nouvelle côté `migrate()`, cf. A014) | `schema.sql` | `schema.sql` | `adr_conflicts` doit survivre à la neutralisation de `docs` (l'ADR devient un `artifacts` `doc_type='adr'`) | FK `adr_conflicts.adr_id` → `artifacts` |
| A005 | Supprimer | DDL `CREATE TABLE docs` (l.123-140), `doc_projects` (l.146-151), `doc_repos` (l.153-158), `doc_attachments` (l.169-185), `recette_documents` (l.388-398) — remplacées par un **bloc commentaire « LEGACY (neutralisées par T-20260920-162801-jxtr — cf. `nomenclature-doc-type.md`) »** ; garder `adr_conflicts` (l.193-204) et `adr_vigilances` (l.410-433) | `schema.sql` | `schema.sql` | Une base **neuve** ne doit plus créer les tables legacy (source logique unique = `artifacts`) ; la neutralisation des bases existantes est faite par le script (A056) | `schema.sql` ne crée plus les tables legacy |

### Bloc 2 — `migrate()` + constantes + modèle `artifacts` (`db.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A006 | Ajouter | Constantes exportées près de `DOC_KINDS` (l.1538) : `DOC_TYPES` (14 valeurs dont `autre`), `TASK_DOC_TYPES = ['plan','task_synthese','task_report','audit_report','autre']`, `RECETTE_DOC_TYPES = ['recette_doc','recette_report']`, `DOCS_DOC_TYPES = ['adr','specs','gherkin','project_doc']`, `E2E_DOC_TYPES = ['e2e_report','e2e_video']`, `ARTIFACT_KINDS = ['plan','audit','report','autre']`, `ARTIFACT_SOURCES = ['import','artifact','registry','ref']`, `DOC_TYPE_BY_DOC_KIND = {'adr-tech':'adr','specs-fonctionnelles':'specs','scenarios-gherkin':'gherkin'}`, `DOC_KIND_BY_DOC_TYPE` (inverse), `DOC_TYPE_BY_ARTIFACT_KIND = {'plan':'plan','audit':'audit_report','report':'task_report','autre':'autre'}` | `db.mjs` | `db.mjs` | Référentiel unique de la taxonomie (partagé avec `index.mjs`) et **mapping kind↔doc_type** | Constantes de taxonomie exportées |
| A007 | Ajouter | Dans `migrate()` (l.44-458) : **expansion additive** de `artifacts` — `ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS doc_type/content_id/nature/source/meta/description/status/context/decision/consequences/replaced_by/is_global/organization_id/updated_at` (types cibles A002) ; `CREATE INDEX IF NOT EXISTS idx_artifacts_doc_type/_content/_kind` ; `CREATE TABLE IF NOT EXISTS artifact_projects/artifact_repos` + index (miroir A003) | `db.mjs` | `db.mjs` | Bases PostgreSQL **existantes** : créer le modèle cible sans perte (idempotent) | `migrate()` crée/étend `artifacts` + liaisons |
| A008 | Ajouter | Dans `migrate()` : **backfill idempotent** du silo tâche — `UPDATE artifacts SET content_id = task_id WHERE content_id IS NULL` ; puis `UPDATE artifacts SET doc_type = CASE kind WHEN 'plan' THEN 'plan' WHEN 'audit' THEN 'audit_report' WHEN 'report' THEN 'task_report' ELSE 'autre' END, source = COALESCE(source,'import') WHERE doc_type IS NULL OR doc_type = 'autre'` ; **ne s'exécute que si la colonne `task_id` existe** (guard `information_schema.columns`) | `db.mjs` | `db.mjs` | Backfill **idempotent** (guard par `content_id`/`doc_type`) du silo `artifacts` existant ; rejouable sans effet de bord | Colonnes remplies pour le silo tâche |
| A009 | Supprimer | Dans `migrate()` : les `CREATE TABLE IF NOT EXISTS` legacy — `recette_documents` (l.167-173), `docs` (l.215-231), `doc_projects` (l.245-250), `doc_repos` (l.251-256), `doc_attachments` (l.260-276) ; **conserver** `adr_conflicts` (l.279-290) avec FK `REFERENCES artifacts(artifact_id)` ; conserver `adr_vigilances` (l.296-319) | `db.mjs` | `db.mjs` | Une base neuve ne crée plus les tables legacy ; les bases existantes les ont déjà (migration script A056) | `migrate()` ne crée plus le legacy |
| A010 | Modifier | `migrate()` : boucle d'organisation (l.448-457) — retirer `docs` de la liste `[... "docs", "artifacts"]` (colonne inexistante en base neuve) ; garder `artifacts` | `db.mjs` | `db.mjs` | `docs` n'existe plus en base neuve → l'`ALTER TABLE docs` échouerait | Boucle org sans `docs` |
| A011 | Modifier | `rowToArtifact(r)` (l.1202-1212) : retourner `{ artifactId, id, docType, contentId, taskId (dérivé = contentId si docType ∈ TASK_DOC_TYPES sinon null — rétrocompat agents/panneau), kind, title, path, nature, source, meta (parseDocMeta), description, status, context, decision, consequences, replacedBy, isGlobal, organizationId, createdAt, updatedAt, createdBy }` | `db.mjs` | `db.mjs` | **Rétrocompat** de la forme `artifact_list(taskId)` (`taskId` conservé) + exposition du modèle polymorphe | `rowToArtifact` polymorphe |
| A012 | Modifier | `addArtifact({ taskId, docType, contentId, kind, title, path, nature, meta, source, organizationId, createdBy })` (l.1185-1200) : `docType` dérivé de `kind` via `DOC_TYPE_BY_ARTIFACT_KIND` si absent (rétrocompat) ; `contentId = contentId ?? taskId` ; **plus de `assertTaskExists` obligatoire** (seulement si `docType` ∈ famille task) ; idempotence par `(doc_type, content_id, kind, path)` ; INSERT dans les nouvelles colonnes | `db.mjs` | `db.mjs` | Étendre `artifact_add` (docType/contentId/kind/nature/meta) tout en gardant l'appel `artifact_add(taskId, kind, path)` fonctionnel | `addArtifact` étendu + rétrocompat |
| A013 | Modifier | `listArtifacts(arg)` (l.1220-1226) : accepter **`string`** (taskId, rétrocompat) **ou** objet `{ taskId, docType, contentId, kind, q, limit }` ; si `taskId` → `WHERE content_id = $1 AND doc_type = ANY(TASK_DOC_TYPES)` (rétrocompat exacte) ; sinon filtres `doc_type`/`content_id`/`kind` + recherche `title/path` (`q`) + `ORDER BY id DESC LIMIT` | `db.mjs` | `db.mjs` | **`artifact_list(taskId)` rétrocompatible** (filtre doc_type des familles task) + nouvelle lecture centrale filtrée | `listArtifacts` rétrocompat + filtres |
| A014 | Ajouter | Dans `migrate()` : rebasage FK `adr_conflicts` — `ALTER TABLE adr_conflicts DROP CONSTRAINT IF EXISTS adr_conflicts_adr_id_fkey` puis `ADD CONSTRAINT adr_conflicts_adr_id_fkey FOREIGN KEY (adr_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE` (guard si `artifacts` rempli) | `db.mjs` | `db.mjs` | `adr_conflicts` doit référencer `artifacts` (les ids ADR = `artifact_id` conservés) | FK rebasée |
| A015 | Ajouter | Helpers de liaison : `getArtifactProjects(artifactId)`, `getArtifactRepos(artifactId)`, `getArtifactProjectsBatch(ids)`, `getArtifactReposBatch(ids)` (remplacent `docTargets` l.1620-1626, `getProjectsForDocs` l.1629-1638, `getReposForDocs` l.1641-1650) sur `artifact_projects`/`artifact_repos` | `db.mjs` | `db.mjs` | Lecture N:N sur les tables rebasées | Helpers de liaison |
| A016 | Modifier | `getArtifact(artifactId)` (l.1214-1218) : enrichir avec `projects`, `repos`, `attachments` (artifacts `doc_type='adr_file'` & `content_id=artifactId`) | `db.mjs` | `db.mjs` | Un artefact porte ses cibles + pièces jointes (symétrie `doc_get`/`adr_get`) | `getArtifact` enrichi |

### Bloc 3 — Rebasage `doc_*` sur `artifacts` (`db.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A017 | Rebaser | `registerDoc(...)` (l.1679-1728) : INSERT dans `artifacts` (`artifact_id = doc-…`, `doc_type = DOC_TYPE_BY_DOC_KIND[kind]`, `content_id = id`, `kind = 'autre'`, `path`, `description`, `status/context/decision/consequences/replaced_by/is_global`, `source='registry'`, `organization_id`, `created_at/updated_at`), puis liens `artifact_projects`/`artifact_repos` (mêmes règles : `projectId`, `repoId`, `repoIds`, `global` → tous les repos du projet) | `db.mjs` | `db.mjs` | **Rebasage doc_register** : plus d'écriture dans `docs` | `registerDoc` écrit `artifacts` |
| A018 | Rebaser | `updateDoc({ docId, … })` (l.1730-1781) : `UPDATE artifacts SET … WHERE artifact_id = $n` (mapping colonnes identique) + liens `artifact_projects`/`artifact_repos` (`addProjectId`, `addRepoId`, `addRepoIds`, `setGlobal`) | `db.mjs` | `db.mjs` | **Rebasage doc_update** | `updateDoc` met à jour `artifacts` |
| A019 | Rebaser | `deleteDoc(docId)` (l.1783-1789) : `DELETE FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY(DOCS_DOC_TYPES)` + suppression des pièces jointes (`doc_type='adr_file' AND content_id = $1`) + des liens (`artifact_projects`/`artifact_repos`, CASCADE) | `db.mjs` | `db.mjs` | **Rebasage doc_delete** + comportement ON DELETE famille docs | `deleteDoc` supprime l'artefact + ses dépendances |
| A020 | Rebaser | `getDoc(docId)` (l.1862-1868) : `SELECT * FROM artifacts WHERE artifact_id = $1 AND doc_type = ANY(DOCS_DOC_TYPES)` puis `enrichDocs([row])` | `db.mjs` | `db.mjs` | **Rebasage doc_get** | `getDoc` lit `artifacts` |
| A021 | Rebaser | `listDocs({ kind, status, projectId, repoId, includeRepoDocs, limit })` (l.1873-1922) : remplacer `docs d` par `artifacts d` ; `kind` ADR-12 → `doc_type = DOC_TYPE_BY_DOC_KIND[kind]` ; `status` → `d.status` ; branches `projectId`/`repoId` via `artifact_projects`/`artifact_repos` — **conserver la structure SQL et les précédences actuelles** (⚠️ **ne pas corriger INC-011** ici) | `db.mjs` | `db.mjs` | **Rebasage doc_list** rétrocompatible (`includeRepoDocs`), INC-011 laissé hors périmètre | `listDocs` lit `artifacts` |
| A022 | Rebaser | `docsForProjectContext(projectId)` (l.1927-1936) : `artifacts` + `artifact_projects`/`artifact_repos` (JOIN `project_repos`) | `db.mjs` | `db.mjs` | Contexte projet (test-agent / recette) sur le nouveau modèle | `docsForProjectContext` rebasée |
| A023 | Rebaser | `docsByProjectRepoBatch(projectIds, repoIds)` (l.1500-1529) : `artifacts` + `artifact_projects`/`artifact_repos` | `db.mjs` | `db.mjs` | Lecture groupée (évite N+1) rebasée | `docsByProjectRepoBatch` rebasée |
| A024 | Rebaser | `rowToDoc(r)` (l.1595-1610) : mapper une ligne `artifacts` → forme doc (`docId = artifact_id`, `kind = DOC_KIND_BY_DOC_TYPE[doc_type]` (défaut `doc_type`), `title/path/description/status/context/decision/consequences/replacedBy/isGlobal/meta/updatedAt/createdAt/createdBy`) | `db.mjs` | `db.mjs` | Forme de sortie `doc_*` **inchangée** (rétrocompat agents/panneau) | `rowToDoc` mappe `artifacts` |
| A025 | Rebaser | `enrichDocs(rows)` (l.1666-1677) : `projects`/`repos` via helpers A015 ; `attachments` = artifacts `doc_type='adr_file' AND content_id = artifact_id` (batch) | `db.mjs` | `db.mjs` | Enrichissement doc (cibles + pièces jointes) rebasé | `enrichDocs` rebasé |
| A026 | Rebaser | `listRepos(projectId)` (l.1399-1438, JOIN `docs`/`doc_repos` l.1417) : `artifacts a JOIN artifact_repos ar ON ar.artifact_id = a.artifact_id` filtré `doc_type = ANY(DOCS_DOC_TYPES)` | `db.mjs` | `db.mjs` | `repos[].docs` (ADR-12) rebasé | `listRepos` lit `artifacts` |
| A027 | Rebaser | `getProject(id)` (l.1313-1319 → `docsForProjectContext`) et `listProjectsWithRepos()` (l.1476-1496 → `docsByProjectRepoBatch`) : **aucune modification de code** (délégué à A022/A023) — **vérifier** seulement que les appels restent corrects | `db.mjs` | `db.mjs` | Éviter une double modification (déjà couvert par A022/A023) | Vérification (pas d'édition) |
| A028 | Rebaser | `getE2ETest(e2eTestId)` (l.3352 `docsForProjectContext(t.project)`) : **aucune modification** (délégué A022) — vérifier | `db.mjs` | `db.mjs` | Contexte docs du test E2E rebasé par A022 | Vérification (pas d'édition) |

### Bloc 4 — Rebasage `adr_*` + pièces jointes (`db.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A029 | Rebaser | `listAdrs({ projectId, repoIds, status, search, includeRepoDocs, limit })` (l.2122-2146) : `listDocs({ kind:'adr-tech', … })` → `listDocs({ docType:'adr', … })` (ou `kind:'adr-tech'` conservé si A021 garde le mapping) ; filtre `status` JS inchangé | `db.mjs` | `db.mjs` | **adr_list** lit les ADR depuis `artifacts` (doc_type='adr') | `listAdrs` rebasée |
| A030 | Rebaser | `getAdr(adrId)` (l.2150-2157) : `getDoc(adrId)` + contrôle `doc_type === 'adr'` (au lieu de `kind === 'adr-tech'`) | `db.mjs` | `db.mjs` | **adr_get** (champs structurés préservés) | `getAdr` rebasée |
| A031 | Rebaser | `searchAdrs` (l.2160-2182) et `buildAdrContext` (l.2188-2215) : appels `listDocs`/`getDoc`/`getAdr` rebasés (mapping doc_type) | `db.mjs` | `db.mjs` | `adr_search` / `adr_context` sur `artifacts` | Rebasés |
| A032 | Rebaser | `registerAdr(...)` (l.2220-2247) : `registerDoc` avec `kind:'adr-tech'` (mappé `doc_type='adr'`) ; pièces jointes via `addDocAttachment` rebasé (A035) | `db.mjs` | `db.mjs` | `adr_register` (statut initial Proposé) sur `artifacts` | Rebasé |
| A033 | Rebaser | `setAdrStatus` (l.2251-2274), `attachAdr` (l.2278-2291) : `getAdr`/`getDoc`/`updateDoc` rebasés ; `replacedBy` validé via `getDoc` rebasé | `db.mjs` | `db.mjs` | Transitions ADR + rattachements sur `artifacts` | Rebasés |
| A034 | Rebaser | `reportAdrConflict` (l.2299-2342) : `getDoc(adrId)` + contrôle `doc_type==='adr'` ; INSERT `adr_conflicts.adr_id` (FK rebasée A014) | `db.mjs` | `db.mjs` | `adr_report_conflict` sur `artifacts` | Rebasé |
| A035 | Rebaser | `addDocAttachment({ docId, targetDocId, path, title, kind, nature, source, meta, createdBy })` (l.1796-1836) : valider le porteur (`artifacts` `doc_type='adr'`), valider la cible (`source='registry'` → artifact existant) ; **INSERT dans `artifacts`** (`artifact_id = att-…`, `doc_type='adr_file'`, `content_id = docId`, `kind`, `nature`, `title`, `path`, `source`, `meta = { targetDocId }` le cas échéant) ; retour `getDoc(docId)` | `db.mjs` | `db.mjs` | Les pièces jointes deviennent des `artifacts` `doc_type='adr_file'` (taxonomie) — plus de table dédiée | `addDocAttachment` écrit `artifacts` |
| A036 | Rebaser | `removeDocAttachment({ attachmentId, docId })` (l.1840-1850) : `DELETE FROM artifacts WHERE artifact_id = $1 AND doc_type='adr_file'` (+ contrôle `content_id` si `docId`) | `db.mjs` | `db.mjs` | Retrait d'une pièce jointe sur `artifacts` | Rebasé |
| A037 | Rebaser | `listDocAttachments({ docId })` (l.1853-1860) et `getAttachmentsForDocs(rows)` (l.1653-1662) : `SELECT * FROM artifacts WHERE content_id = ANY($1) AND doc_type='adr_file'` | `db.mjs` | `db.mjs` | Lecture des pièces jointes (batch + unitaire) | Rebasés |
| A038 | Modifier | `rowToAttachment(r)` (l.1576-1593) : mapper une ligne `artifacts` `doc_type='adr_file'` (`attachmentId=artifact_id`, `docId=content_id`, `targetDocId=meta.targetDocId`, `meta`) | `db.mjs` | `db.mjs` | Forme de sortie pièce jointe **inchangée** (rétrocompat panneau) | `rowToAttachment` rebasé |

### Bloc 5 — Rebasage `recette_documents` (`db.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A039 | Rebaser | `addRecetteDocument({ recetteId, title, nature, source, path, artifactId })` (l.2901-2909) : INSERT dans `artifacts` (`artifact_id = ART-REC-…`, `doc_type = recette_report si artifactId lié à un artifact kind='report' sinon recette_doc`, `content_id = recetteId`, `kind='report'`, `nature`, `source`, `path`, `meta={artifactId}`) ; retour `listRecetteDocuments(recetteId)` | `db.mjs` | `db.mjs` | **Rebasage recette_doc_add** sur `artifacts` | `addRecetteDocument` écrit `artifacts` |
| A040 | Rebaser | `listRecetteDocuments(recetteId)` (l.2911-2932) : `SELECT a.*, ar.title AS artifact_title, ar.content_id AS artifact_task FROM artifacts a LEFT JOIN artifacts ar ON ar.artifact_id = (a.meta->>'artifactId') WHERE a.content_id = $1 AND a.doc_type = ANY(RECETTE_DOC_TYPES)` ; **`documentId = a.id` (IDENTITY INTEGER, rétrocompat)** + `artifactId = a.artifact_id` + `title/nature/source/path/artifactTask/createdAt` | `db.mjs` | `db.mjs` | **Rétrocompat `recette_get` → `documents`** : `documentId` reste un entier (routes panneau `[0-9]+`) | `listRecetteDocuments` rebasée |
| A041 | Rebaser | `removeRecetteDocument(documentId)` (l.2934-2941) : `DELETE FROM artifacts WHERE id = $1 AND doc_type = ANY(RECETTE_DOC_TYPES) RETURNING content_id` | `db.mjs` | `db.mjs` | **Rebasage recette_doc_remove** | Rebasé |
| A042 | Vérifier | `getRecetteById(recetteId)` (l.2843-2898, `documents = listRecetteDocuments` l.2876) : **aucune modification** (délégué A040) ; vérifier la forme `documents[]` | `db.mjs` | `db.mjs` | `recette_get` → documents stable | Vérification (pas d'édition) |

### Bloc 6 — Suppression / liens / E2E (`db.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A043 | Modifier | `deleteTask(taskId)` (l.2446-2465, l.2455 `DELETE FROM artifacts WHERE task_id = $1`) : `DELETE FROM artifacts WHERE content_id = $1 AND doc_type = ANY(TASK_DOC_TYPES)` | `db.mjs` | `db.mjs` | **Comportement ON DELETE famille task** (content_id polymorphe → pas de FK) | Nettoyage task-family |
| A044 | Modifier | `listTaskLinks(taskId)` (l.580 `COUNT(*) FROM artifacts a WHERE a.task_id = l.linked_task_id`) : `WHERE a.content_id = l.linked_task_id AND a.doc_type = ANY(TASK_DOC_TYPES)` | `db.mjs` | `db.mjs` | Le compteur `linked_artifacts` des tâches liées doit rester exact | Compteur rebasé |
| A045 | Ajouter | `updateE2EExecution` (l.3496-3510) : quand `reportArtifactId` est fourni, **vérifier** que l'artifact existe (sinon laisser passer avec avertissement) ; quand `videoUrl` est fourni, **upsert** un artifact `doc_type='e2e_video'`, `content_id=e2eTestId`, `kind='autre'`, `title`, `path=videoUrl` (idempotent par `content_id`+`path`) ; `reportArtifactId` reste un `artifact_id` (aucune écriture supplémentaire) | `db.mjs` | `db.mjs` | **Taxonomie `e2e_report`/`e2e_video`** implémentée : les preuves E2E deviennent visibles dans le gestionnaire central ; jointures E2E préservées | Preuves E2E exposées en artefacts |
| A046 | Vérifier | Jointures E2E : `e2e_executions.report_artifact_id` (l.621) et `video_url` (l.623) pointent `artifact_id` **préservé** par la migration (A057) ; aucun FK à casser ; documenter dans la nomenclature | `db.mjs` | `db.mjs` | Contrat de rétrocompat E2E | Vérification tracée |

### Bloc 7 — Tools MCP (`index.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A047 | Modifier | Tool `artifact_add` (l.1800-1822) : `inputSchema` étendu `docType?` (`z.enum(DOC_TYPES)`), `contentId?`, `nature?`, `meta?` (`z.record`), `source?` (`z.enum(ARTIFACT_SOURCES)`) ; `taskId` **optionnel** (rétrocompat : requis si `docType` ∈ famille task) ; garde `kind='audit' ⇒ task.type='audit'` conservée quand `taskId` fourni ; handler → `addArtifact({...})` | `index.mjs` | `index.mjs` | **`artifact_add` étendu** (docType+contentId+kind+nature+meta) + rétrocompat | `artifact_add` étendu |
| A048 | Modifier | Tool `artifact_list` (l.1824-1835) : `inputSchema` étendu `docType?`, `contentId?`, `kind?`, `q?` ; `taskId?` conservé ; handler → `listArtifacts({ taskId, docType, contentId, kind, q })` | `index.mjs` | `index.mjs` | **`artifact_list(taskId)` rétrocompatible** + filtres centraux | `artifact_list` étendu |
| A049 | Modifier | Descriptions des tools `doc_register/doc_update/doc_get/doc_list/doc_attachment_*` (l.372-510) : mentionner « rebasés sur la table polymorphe `artifacts` (doc_type adr/specs/gherkin/project_doc/adr_file) » ; **signatures inchangées** | `index.mjs` | `index.mjs` | Contrat explicite pour les agents (même API, stockage unifié) | Descriptions à jour |
| A050 | Modifier | Descriptions des tools `adr_*` (l.519-726) : mentionner le rebasage sur `artifacts` (`doc_type='adr'`) ; **signatures inchangées** | `index.mjs` | `index.mjs` | Contrat explicite | Descriptions à jour |
| A051 | Ajouter | Import depuis `./db.mjs` (bloc d'imports l.1-120) : `DOC_TYPES`, `ARTIFACT_SOURCES`, `ARTIFACT_KINDS` | `index.mjs` | `index.mjs` | Rendre les référentiels disponibles aux schémas zod | Constantes importées |
| A052 | Vérifier | Tools `recette_doc_add` (l.870-894, `getArtifact(artifactId)` l.885) et `recette_doc_remove` (l.897-908) : **aucune modification** (signatures/forme conservées par A039-A041) | `index.mjs` | `index.mjs` | Rétrocompat recette_doc_* | Vérification (pas d'édition) |

### Bloc 8 — Script de migration (nouveau fichier, livrable obligatoire)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A053 | Créer | `scripts/artifacts-fusion-migration.mjs` : point d'entrée CLI avec sous-commandes `inventory`, `snapshot`, `migrate`, `validate`, `neutralize`, `rollback` (connexion PG via `DATABASE_URL`, `pg` déjà en `node_modules`) | — (nouveau) | `scripts/artifacts-fusion-migration.mjs` | Livrable « script de migration idempotent » (mission, plan de migration §3) | Script de migration opérationnel |
| A054 | Ajouter | Mode **`inventory`** (lecture seule) : comptages par source (`artifacts` par `kind`, `recette_documents`, `docs` par `kind`, `doc_attachments`, `doc_projects`, `doc_repos`) + **échantillons** (5 lignes/source) ; sortie JSON + markdown | `scripts/artifacts-fusion-migration.mjs` | `scripts/artifacts-fusion-migration.mjs` | **Inventaire pré-migration** (mission §1) — état des lieux avant toute écriture | `inventory` produit le rapport |
| A055 | Ajouter | Mode **`snapshot`** (rollback défini AVANT exécution) : `CREATE TABLE artifacts_backup_<ts> AS SELECT * FROM artifacts` + idem `docs_backup_<ts>`, `recette_documents_backup_<ts>`, `doc_attachments_backup_<ts>`, `doc_projects_backup_<ts>`, `doc_repos_backup_<ts>` ; consigne `pg_dump` documentée en tête de script | `scripts/artifacts-fusion-migration.mjs` | `scripts/artifacts-fusion-migration.mjs` | **Rollback défini avant exécution** (mission §5) | Snapshots de restauration |
| A056 | Ajouter | Mode **`migrate`** idempotent, ordre strict `artifacts → recette_documents → docs → doc_attachments` puis liens : (1) backfill `artifacts` (A008) ; (2) `recette_documents` → `INSERT INTO artifacts (artifact_id='ART-REC-<id>', doc_type=recette_doc/recette_report, content_id=recette_id, kind='report', nature, source, path, meta={legacyId,artifactId}, created_at) SELECT … WHERE NOT EXISTS (artifact_id)` ; (3) `docs` → `INSERT … artifact_id=id, doc_type=DOC_TYPE_BY_DOC_KIND[kind], content_id=id, kind='autre', path/description/status/context/decision/consequences/replaced_by/is_global, source='registry', meta` (cast sûr : `CASE WHEN meta ~ '^\s*[\{\[]' THEN meta::jsonb ELSE jsonb_build_object('legacy',meta) END`) ; (4) `doc_attachments` → `INSERT … artifact_id=attachment_id, doc_type='adr_file', content_id=doc_id, meta={targetDocId}` ; (5) `doc_projects`→`artifact_projects`, `doc_repos`→`artifact_repos` (`ON CONFLICT DO NOTHING`) ; chaque INSERT gardé par `NOT EXISTS (artifact_id)` (rejouable sans effet de bord) | `scripts/artifacts-fusion-migration.mjs` | `scripts/artifacts-fusion-migration.mjs` | **Migration idempotente** (guard par identifiant) — mission §2/§3 | `migrate` rejouable |
| A057 | Ajouter | Mode **`validate`** : compare comptages pré/post (snapshot vs état), vérifie **pas de perte / pas de doublon**, échantillonne chaque famille (chemins/projets/repos/nature/statut ADR conservés) et exécute les requêtes de **rétrocompat** : `artifact_list(taskId)` (content_id+doc_type task), `recette_get`→documents (`documentId` entier), `doc_list(includeRepoDocs)`, `doc_get`, `adr_list`/`adr_get`, jointures E2E (`report_artifact_id`/`video_url` résolvent un artifact) ; sortie verdict PASS/FAIL par contrôle | `scripts/artifacts-fusion-migration.mjs` | `scripts/artifacts-fusion-migration.mjs` | **Validation post-migration** (mission §4) | `validate` PASS/FAIL |
| A058 | Ajouter | Mode **`rollback`** : `DELETE FROM artifacts WHERE artifact_id IN (SELECT artifact_id FROM <source>_backup_<ts>) AND doc_type IN (docs/recette/adr_file families)` + restauration des colonnes `artifacts` depuis `artifacts_backup_<ts>` + `TRUNCATE artifact_projects/artifact_repos` puis restauration ; **ne touche jamais** aux tables legacy (intactes) | `scripts/artifacts-fusion-migration.mjs` | `scripts/artifacts-fusion-migration.mjs` | **Rollback** documenté et exécutable (mission §5) | `rollback` restaure l'état |

### Bloc 9 — Panneau : serveur (`server.mjs`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A059 | Rebaser | `registryArtifacts(url)` (l.446-464) → **gestionnaire central** : `SELECT a.*, … FROM artifacts a` avec filtres `docType` (`doc_type`), `contentId` (`content_id`), `kind`, `q` (ILIKE `title`/`path`), `project` (via `artifact_projects` ou tâche du content_id) ; résolution **Entité** (`content_id` + libellé : tâche→`tasks.title`, recette→`recettes.title`, projet, doc) ; filtre `archived` **uniquement** pour la famille task ; plus de référence à `a.task_id` | `server.mjs` | `server.mjs` | **Liste TOUS les artefacts toutes entités** (colonnes Entité/Type/Nature, filtres, recherche) | `/api/artifacts` central |
| A060 | Rebaser | `downloadArtifact(res, taskId, artifactId)` (l.542-559) : `SELECT * FROM artifacts WHERE artifact_id = $1` (plus de `task_id`) ; si `taskId` fourni, contrôle souple `content_id === taskId` pour la famille task | `server.mjs` | `server.mjs` | Le téléchargement ne dépend plus de `task_id` | Téléchargement rebasé |
| A061 | Rebaser | `viewArtifact(res, taskId, artifactId)` (l.562-577) : `SELECT * FROM artifacts WHERE artifact_id = $1` (plus de `task_id`) | `server.mjs` | `server.mjs` | La visionneuse ne dépend plus de `task_id` | Visionneuse rebasée |
| A062 | Ajouter | Routes centrales : `GET /api/artifacts/:artifactId/view` et `GET /api/artifacts/:artifactId/download` (au voisinage de l.1906-1909) → `viewArtifact`/`downloadArtifact` **sans** `taskId` ; conserver les routes legacy `/api/tasks/:taskId/artifacts/:artifactId/(view|download)` (rétrocompat `view-md.html`) | `server.mjs` | `server.mjs` | « Regarder »/« Télécharger » **pour chaque artefact** (toute entité) | Routes centrales |
| A063 | Ajouter | Route `POST /api/artifacts` : body `{ docType, contentId, kind, title, path, nature, source?, meta? }` → validation `doc_type`/`kind` (liste locale `DOC_TYPES`, commentaire pointant `nomenclature-doc-type.md`) → `INSERT INTO artifacts (artifact_id, doc_type, content_id, kind, title, path, nature, source, meta, organization_id, created_at, created_by)` → renvoie l'artefact | `server.mjs` | `server.mjs` | **Ajout possible depuis le gestionnaire central pour toute entité** | `POST /api/artifacts` |
| A064 | Rebaser | `/api/recettes` (l.2019-2029) : `documents_count` → `(SELECT COUNT(*) FROM artifacts a WHERE a.content_id = r.recette_id AND a.doc_type IN ('recette_doc','recette_report'))` | `server.mjs` | `server.mjs` | Compteur documents recette sur `artifacts` | Compteur rebasé |
| A065 | Rebaser | `recetteDocView` (l.2113-2120) : `SELECT * FROM artifacts WHERE id = $1 AND doc_type IN ('recette_doc','recette_report')` | `server.mjs` | `server.mjs` | Lecture du document de recette sur `artifacts` (`documentId` = `id` entier) | Route view rebasée |
| A066 | Rebaser | `recetteDocDel` (l.2126-2129) et `/api/recettes/:id` documents (l.2145-2149) : `artifacts` filtré famille recette ; exposer `documentId = id` + `artifactId` (rétrocompat modale recette) | `server.mjs` | `server.mjs` | **`recette_get` → documents stable** côté panneau | Routes recette rebasées |
| A067 | Rebaser | Contexte docs du test E2E (l.1045-1051, `SELECT … FROM docs d …`) : `SELECT DISTINCT a.artifact_id AS "docId", a.doc_type AS kind, a.title, a.path, a.description FROM artifacts a WHERE a.doc_type IN ('adr','specs','gherkin','project_doc') AND (a.artifact_id IN (SELECT artifact_id FROM artifact_projects WHERE project_id=$1) OR a.artifact_id IN (SELECT ar.artifact_id FROM artifact_repos ar JOIN project_repos pr ON pr.repo_id=ar.repo_id WHERE pr.project_id=$1))` | `server.mjs` | `server.mjs` | Contexte docs du test E2E rebasé | Requête rebasée |
| A068 | Vérifier | Routes `/api/docs*` (l.1621-1767) et `/api/docs/file` (l.2380) : **aucune modification** (déléguées à `pilot.*` → MCP `doc_*` rebasé) ; `pilot.listDocs` (l.539) et `pilot.docGet` (l.587) inchangés | `server.mjs` | `server.mjs` | Rétrocompat onglet ADR / documents de référence | Vérification (pas d'édition) |

### Bloc 10 — Panneau : UI (`public/app.js`)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A069 | Renommer | `PROJECT_TABS` (l.96-108) : entrée `['artifacts', 'Documents']` (l.105) → `['artifacts', 'Artefacts']` ; bouton l.4937 `data-goto="artifacts">Documents` → `Artefacts` | `public/app.js` | `public/app.js` | **L'onglet s'appelle « Artefacts »** (plus « Documents ») | Onglet renommé |
| A070 | Remplacer | `renderArtifacts()` (l.1198-1207) → **gestionnaire central** : colonnes **Entité / Type (`doc_type`) / Nature (`kind`) / Titre / Date / Actions** ; barre de filtres (`docType`, `contentId`, `kind`, recherche `q`) alimentée par `GET /api/artifacts?...` ; « Regarder » (modale markdown via `GET /api/artifacts/:artifactId/view`) et « Télécharger » (`/api/artifacts/:artifactId/download`) pour **chaque** artefact ; bouton « Ajouter un artefact » (toute entité) | `public/app.js` | `public/app.js` | Gestionnaire central (toutes entités, filtres, recherche, Regarder/Télécharger, ajout) | `renderArtifacts` central |
| A071 | Ajouter | Modale « Ajouter un artefact » : formulaire `docType` (liste A001), `contentId` (avec autocomplétion entité : tâche/recette/projet/doc), `kind`, `title`, `path`, `nature`, `meta` → `POST /api/artifacts` ; rafraîchit le gestionnaire | `public/app.js` | `public/app.js` | Ajout depuis le gestionnaire central pour toute entité | Modale d'ajout |
| A072 | Ajouter | Modale visionneuse markdown in-app : `GET /api/artifacts/:artifactId/view` → injection `html` (évite de dépendre de `view-md.html`) | `public/app.js` | `public/app.js` | « Regarder » fonctionnel pour tout artefact | Visionneuse in-app |
| A073 | Modifier | Modale détail projet (l.3783+), sous-onglet `['docs', 'Documents (n)']` (l.3815) → libellé **« Documents de référence »** ; l'onglet ADR reste (adr_list) ; le gestionnaire central est l'onglet principal « Artefacts » | `public/app.js` | `public/app.js` | Éviter la confusion « Documents » entre référentiel projet et gestionnaire central | Libellés clarifiés |
| A074 | Ajouter | `public/style.css` : styles du gestionnaire central (`.art-manager`, `.art-filters`, `.art-entity`, `.art-type`, `.art-nature`, badges) — cohérents avec l'existant | `public/style.css` | `public/style.css` | Rendu lisible du gestionnaire (pas une table brute) | Styles du gestionnaire |

### Bloc 11 — Exécution migration / bascule / neutralisation

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A075 | Exécuter | `node scripts/artifacts-fusion-migration.mjs inventory` puis `snapshot` **avant** toute écriture — archiver les sorties dans `reports/` | `scripts/artifacts-fusion-migration.mjs` | `reports/artifacts-inventory-<ts>.md` | Inventaire + rollback défini **avant** exécution (mission §1/§5) | Rapport d'inventaire + snapshots |
| A076 | Exécuter | `node scripts/artifacts-fusion-migration.mjs migrate` (ordre `artifacts → recette_documents → docs → doc_attachments → liens`), puis **rejouer** `migrate` pour prouver l'idempotence (comptages inchangés) | `scripts/artifacts-fusion-migration.mjs` | base `task_registry` | Migration idempotente (mission §3) | Données migrées, idempotence prouvée |
| A077 | Exécuter | `node scripts/artifacts-fusion-migration.mjs validate` → **PASS obligatoire** (comptages, échantillons, rétrocompat `artifact_list(taskId)`, `recette_get`→documents, `doc_list(includeRepoDocs)`, `doc_get`, `adr_list`/`adr_get`, jointures E2E) | `scripts/artifacts-fusion-migration.mjs` | `reports/artifacts-validation-<ts>.md` | Validation post-migration (mission §4) — **bloque** la suite si FAIL | Rapport de validation PASS |
| A078 | Exécuter | `node scripts/artifacts-fusion-migration.mjs neutralize` (après PASS) : `ALTER TABLE artifacts DROP COLUMN IF EXISTS task_id` ; renommer `docs`→`legacy_docs`, `recette_documents`→`legacy_recette_documents`, `doc_attachments`→`legacy_doc_attachments`, `doc_projects`→`legacy_doc_projects`, `doc_repos`→`legacy_doc_repos` (**jamais de DROP**) | `scripts/artifacts-fusion-migration.mjs` | base `task_registry` | Neutralisation des tables legacy — **jamais de suppression** avant validation (mission §6) | Legacy neutralisées, `artifacts` seule table |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/orchestrator-panel/public/docs/nomenclature-doc-type.md` | **Création** — référentiel central taxonomie + mapping (A001) |
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | Modification — `artifacts` polymorphe (A002), `artifact_projects`/`artifact_repos` (A003), FK `adr_conflicts` (A004), retrait DDL legacy (A005) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | Modification — constantes (A006), `migrate()` (A007-A010, A014), `rowToArtifact`/`addArtifact`/`listArtifacts`/`getArtifact` (A011-A016), rebasage `doc_*` (A017-A028), rebasage `adr_*`/pièces jointes (A029-A038), rebasage recette (A039-A042), `deleteTask`/`listTaskLinks`/E2E (A043-A046) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | Modification — `artifact_add`/`artifact_list` (A047-A048), descriptions `doc_*`/`adr_*` (A049-A050), imports (A051) |
| `/root/.config/opencode/mcp/task-orchestrator/scripts/artifacts-fusion-migration.mjs` | **Création** — script de migration idempotent + inventory/validate/rollback/neutralize (A053-A058) |
| `/root/orchestrator-panel/server.mjs` | Modification — `registryArtifacts` central (A059), `downloadArtifact`/`viewArtifact` (A060-A061), routes centrales (A062), `POST /api/artifacts` (A063), recettes (A064-A066), contexte docs E2E (A067) |
| `/root/orchestrator-panel/public/app.js` | Modification — onglet « Artefacts » (A069), `renderArtifacts` central (A070), modales ajout/visionneuse (A071-A072), libellés (A073) |
| `/root/orchestrator-panel/public/style.css` | Modification — styles gestionnaire (A074) |
| `reports/artifacts-inventory-<ts>.md`, `reports/artifacts-validation-<ts>.md` | **Création** — sorties de migration (A075, A077) |

**Aucune** modification de `pilot.mjs` (hors périmètre déclaré : `server.mjs` fait les accès `artifacts` en SQL direct, comme aujourd'hui l.446-464 / l.2113-2154). **Aucune** modification des prompts agents (l'API `artifact_list(taskId)` reste compatible).

## 5. Livrables attendus

1. **Table polymorphe unique `artifacts`** (`doc_type`, `content_id`, `kind`=nature, `nature`, `source`, `meta` JSONB, champs ADR structurés, `updated_at`, `organization_id`) — `schema.sql` (A002) + `migrate()` (A007-A008).
2. **N:N ADR↔projet/repo** conservé via `artifact_projects`/`artifact_repos` (A003, A015, A017-A018).
3. **Taxonomie** `doc_type` (14 valeurs dont `autre`) formalisée dans `nomenclature-doc-type.md` (A001) + constantes `DOC_TYPES` (A006) ; **`content_type` réservé, jamais créé** (A001/A002).
4. **`artifact_add`/`artifact_list` étendus** (docType+contentId+kind+nature+meta) avec **`artifact_list(taskId)` rétrocompatible** (A012-A013, A047-A048).
5. **Rebasage `doc_*`** sur `artifacts` (A017-A028) — `doc_register/doc_update/doc_get/doc_list(includeRepoDocs)/doc_attachment_*`.
6. **Rebasage `adr_*`** sur `artifacts` (`doc_type='adr'`) — `adr_list/adr_get/adr_search/adr_context/adr_register/adr_set_status/adr_update/adr_attach/adr_report_conflict` (A029-A034).
7. **Rebasage `recette_documents`** sur `artifacts` avec **`recette_get`→documents stable** (`documentId` entier) (A039-A042, A064-A066).
8. **Panneau « Artefacts »** gestionnaire central (toutes entités, Entité/Type/Nature, filtres doc_type/content_id/kind, recherche, Regarder/Télécharger, ajout) (A059-A063, A069-A074).
9. **Script de migration** idempotent + `inventory`/`snapshot`/`validate`/`rollback`/`neutralize` (A053-A058) ; rapports d'inventaire et de validation (A075, A077).
10. **Bascule** (code) puis **neutralisation** des tables legacy **sans suppression** (A078).
11. **Rétrocompat préservée** : `artifact_list(taskId)` (4 agents + panneau), `recette_get`→documents, `doc_list(includeRepoDocs)`, `doc_get`, `adr_list`/`adr_get`, jointures E2E `report_artifact_id`/`video_url` (A046, A052, A068, A077).

## 6. Ordre & dépendances

Séquence **strictement ordonnée** (décision Rino « traiter séquentiellement ») :

```
A001 (nomenclature)
  └─ A002 → A003 → A004 → A005                 (schéma cible)
       └─ A006 → A007 → A008 → A009 → A010 → A011 → A012 → A013 → A014 → A015 → A016
            ├─ Bloc 3 : A017 → A018 → A019 → A020 → A021 → A022 → A023 → A024 → A025 → A026 → (A027, A028 vérif)
            ├─ Bloc 4 : A029 → A030 → A031 → A032 → A033 → A034 → A035 → A036 → A037 → A038
            ├─ Bloc 5 : A039 → A040 → A041 → (A042 vérif)
            └─ Bloc 6 : A043 → A044 → A045 → (A046 vérif)
                 └─ Bloc 7 : A047 → A048 → A049 → A050 → A051 → (A052 vérif)
                      └─ Bloc 8 : A053 → A054 → A055 → A056 → A057 → A058
                           └─ Bloc 9 : A059 → A060 → A061 → A062 → A063 → A064 → A065 → A066 → A067 → (A068 vérif)
                                └─ Bloc 10 : A069 → A070 → A071 → A072 → A073 → A074
                                     └─ A075 (inventory+snapshot) → A076 (migrate ×2) → A077 (validate PASS) → A078 (neutralize)
```

Prérequis durs :
- **A075/A076 (migration des données) avant A077/A078** ; **A077 PASS avant A078** (jamais de neutralisation avant validation).
- **A075 (`snapshot`) avant A076** (rollback défini **avant** exécution).
- **Bloc 3-6 (rebasage code) avant Bloc 9-10 (panneau)** pour que les routes rebasées s'appuient sur des fonctions MCP déjà rebasées.
- **A078 (`DROP task_id`) après** que plus aucun code ne référence `task_id` (Bloc 2-7) : `db.mjs` (A011-A013, A043-A044), `index.mjs` (A047), `server.mjs` (A059-A062).
- **A045** (E2E) dépend de A007 (colonnes `artifacts`) et de A057 (validation).

## 7. Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|----------|----------|-----------|
| Fusion physique en UNE table polymorphe `artifacts` (`doc_type`+`content_id`, `task_id` supprimé) | A002, A007, A008, A078 | ✅ |
| `content_type` jamais utilisé (réservé) | A001, A002 (pas de colonne) | ✅ |
| `kind` = NATURE distincte de `doc_type` | A002, A006, A011 | ✅ |
| Colonnes conservées : `kind`, `title`, `path`, `created_at` + `nature` + `source` + `meta` JSONB | A002, A007, A011 | ✅ |
| Champs ADR structurés préservés (statut/contexte/décision/conséquences) | A002, A007, A020-A021, A024, A030 | ✅ |
| N:N ADR↔projet/repo conservé | A003, A015, A017-A018, A023, A026 | ✅ |
| `artifact_add`/`artifact_list` étendus (docType+contentId+kind+nature+meta) | A012-A013, A047-A048 | ✅ |
| `artifact_list(taskId)` rétrocompatible (filtre doc_type familles task) | A006, A013, A048 | ✅ |
| Rebasage `doc_*` sur `artifacts` (plus de table `docs`) | A017-A028 | ✅ |
| Rebasage `adr_*` sur `artifacts` | A029-A034 | ✅ |
| Panneau onglet « Artefacts » gestionnaire central (Entité/Type/Nature, filtres, recherche, Regarder/Télécharger, ajout) | A059-A063, A069-A074 | ✅ |
| Taxonomie 14 valeurs + `autre` + fichier de référence `nomenclature-doc-type.md` | A001, A006 | ✅ |
| Migration : inventaire pré-migration | A054, A075 | ✅ |
| Migration : mapping 1:1 | A001 (table), A056 | ✅ |
| Migration : script idempotent (ordre artifacts → recette_documents → docs) | A056, A076 (rejeu) | ✅ |
| Migration : validation post-migration (comptages + échantillons + rétrocompat) | A057, A077 | ✅ |
| Migration : rollback défini AVANT exécution | A055, A058, A075 | ✅ |
| Migration : bascule + neutralisation des tables legacy (jamais de suppression avant validation) | A077 (PASS) → A078 | ✅ |
| Rétrocompat `recette_get`→documents stable (`documentId` entier) | A040, A042, A065-A066 | ✅ |
| Jointures E2E (`reportArtifactId`/`videoUrl`) préservées | A046, A045, A057 | ✅ |
| Comportement ON DELETE par famille défini | A001, A019 (docs), A043 (task), A045 (e2e) | ✅ |
| INC-011 (bug `listDocs`) laissé hors périmètre | A021 (préserver la sémantique) | ✅ |

## 8. Vérification de cohérence

**Phase 6 — Contradictions intra-plan** (regroupement par élément cible) :

- `artifacts` est **créé** (A002) puis **étendu** (A007) puis **backfillé** (A008) puis `task_id` **supprimé** (A078) : ordre cohérent (expand → migrate → validate → contract), pas de contradiction. `A007` (ALTER ADD) s'exécute **avant** `A008` (UPDATE) et **avant** `A078` (DROP) — l'ordre du tableau et le §6 le garantissent.
- `docs` / `recette_documents` / `doc_attachments` / `doc_projects` / `doc_repos` : **retirés du DDL** (A005, A009) mais **renommés** en legacy (A078) et **jamais supprimés** ; le script de migration (A056) **lit** les tables legacy avant A078. Aucune action `Supprimer` sur ces tables → pas de contradiction avec la migration.
- `adr_conflicts.adr_id` : FK rebasée (A004/A014) **avant** neutralisation (A078) → pas de FK orpheline.
- `rowToDoc` (A024) et `rowToArtifact` (A011) sont **deux mappers distincts** sur la **même** table `artifacts` (l'un pour la forme doc, l'autre pour la forme artefact) : pas de contradiction (formes de sortie différentes, publics différents).
- `listArtifacts` (A013) et `listDocs` (A021) filtrent `artifacts` sur des **familles `doc_type` disjointes** (`TASK_DOC_TYPES` vs `DOCS_DOC_TYPES`) → pas de double lecture incohérente.
- `A027`/`A028`/`A042`/`A046`/`A052`/`A068` sont des **vérifications** (pas d'édition) : aucun conflit avec les étapes d'édition des mêmes fichiers (déjà couvertes par A022/A023/A040/A045/A039-A041/A017-A038).
- **Aucune** étape ne modifie un élément créé/déplacé par une étape ultérieure : `doc_*`/`adr_*` (A017-A038) sont rebasés **après** la création de `artifacts` (A002/A007) et **avant** la neutralisation (A078).

**Phase 7 — Plan Validator** :

- Exigence non couverte ? **Non** (table §7, 100 %).
- Contradiction non résolue ? **Non** (§8).
- Étape vague ? **Non** (chaque étape nomme l'élément, le fichier, l'action, la raison et le livrable ; les lignes sont référencées).
- **Verdict : VALID** → passage à l'écriture du plan + enregistrement.

## 9. Risques & notes

1. **`documentId` recette (INTEGER → `artifacts.id`)** : `listRecetteDocuments` (A040) expose `documentId = artifacts.id` (IDENTITY INTEGER) pour préserver les routes panneau `[0-9]+` (l.2113, l.2126) et la forme `recette_get`→`documents`. `artifactId` est exposé **en plus** (nouveau). **Risque** : un consommateur qui déduirait `recette_documents.id` d'un ancien id persisté — aucun consommateur de ce type n'existe (les liens sont générés dynamiquement).
2. **`meta` TEXT → JSONB** : cast sûr obligatoire (A056, `CASE WHEN meta ~ '^\s*[\{\[]' …`). **Risque** : valeur legacy non-JSON → encapsulée `{legacy: …}` (pas de perte, traçable).
3. **`content_id` sans FK (polymorphe)** : perte des `ON DELETE CASCADE` DB. Comportement **par famille** défini (A001) et implémenté côté code : task (A043), docs (A019), e2e (A045) ; **recette** et **projet** n'ont pas de chemin de suppression (aucune `deleteRecette`/`deleteE2ETest` n'existe) → documenté dans la nomenclature (si un chemin est ajouté, il devra nettoyer la famille correspondante).
4. **`content_id` pour la famille docs = `docId` (self)** : le doc ADR-12 est sa propre entité porteuse (il peut être rattaché à N projets/repos via `artifact_projects`/`artifact_repos`). La colonne « Entité » du panneau affiche donc le `docId` et, pour la famille docs, les projets/répos rattachés (A059). Décision documentée dans la nomenclature.
5. **Taxonomie « 14 valeurs + `autre` »** : la liste explicite de la mission compte **13 familles nommées + `autre` (= 14 valeurs)** ; le libellé « 14 valeurs + `autre` » de la recette est ambigu (15 si on l'interprète littéralement). Le plan retient **la liste explicite** (A001/A006) et le signale pour réconciliation humaine — **ne pas inventer de 14ᵉ valeur**.
6. **INC-011** : le rebasage de `listDocs` (A021) **préserve la sémantique SQL actuelle** (précédence `includeRepoDocs`+`status`) ; la correction reste dans la tâche émergente dédiée (hors périmètre).
7. **Ordre de déploiement** : `migrate()` (A007-A010) s'exécute au boot MCP ; le script `migrate` (A076) doit tourner **avant** le démarrage du code rebasé en production. Le `snapshot` (A055/A075) est obligatoire **avant** `migrate`.
8. **`pilot.mjs` non modifié** : les accès `artifacts` du panneau restent en SQL direct dans `server.mjs` (pattern existant) ; si l'on préfère passer par le MCP, ajouter des wrappers `pilot.addArtifact/listArtifacts` — **hors périmètre déclaré**, noté pour arbitrage.
9. **Tests E2E — NA** : les repos de l'écosystème (`opencode-mcp-task-orchestrator`, `opencode-observability`, `opencode-scripts`, `opencode-agents`) **ne contiennent pas de `playwright.config.*` ni de `tests/e2e/**`** (vérifié) ; `e2e_list(project='ecosystem')` → 0 test. La stratégie E2E est donc **E2E NA** (pas de harnais Playwright pour le panneau) ; aucune création « en aveugle ». Si un harnais est ajouté ultérieurement, scénario candidat : « le gestionnaire central « Artefacts » liste tous les artefacts (tâche/recette/projet/doc), filtre par `doc_type`/`content_id`/`kind`, et « Regarder »/« Télécharger » fonctionne ».
10. **Volume du plan** : 78 étapes atomiques réparties en 11 blocs, exécution strictement séquentielle (8/8, dernière tâche du batch). La neutralisation (A078) est **irréversible côté code** : ne l'exécuter qu'après `validate` PASS et confirmation.
