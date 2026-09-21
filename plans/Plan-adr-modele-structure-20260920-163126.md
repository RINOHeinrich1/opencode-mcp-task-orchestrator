# Plan — ADR : modèle structuré en base + rattachement 1..N repos du projet

- **Plan ID** : `Plan-adr-modele-structure-20260920-163126`
- **Tâche** : `T-20260920-162753-hpcj` (executionId `E-T-20260920-162753-hpcj-ewmk3e`)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator` (branche `feature/migration-postgresql`)
- **Batch** : `BATCH-mua15lwb-ifqw` (mode session unique, ordre 1/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` — item 120
- **Date** : 2026-09-20 16:31:26

## 1. Objectif

Porter les ADR comme **entités structurées** dans le registre (colonnes Titre, Statut
`Proposé | Accepté | Déprécié | Remplacé`, Contexte, Décision, Conséquences), **rattachées à
un projet et à 1..N de ses repos** (une ADR « globale » = rattachée à tous les repos du
projet), et **exposées par les tools MCP `doc_register` / `doc_update` / `doc_get` /
`doc_list`** avec filtrage par projet / repo / statut, **en conservant la rétrocompatibilité
des docs existants** (`doc_list(includeRepoDocs)` ne doit pas casser).

## 2. Contexte & raison d'être

Aujourd'hui (ADR-12), la table `docs` (créée dans `db.mjs` `migrate()` l.215-236) ne porte
que `id, kind, title, path, description, organization_id, created_at, created_by` : une ADR
n'est qu'**un fichier pointé par un chemin**, sans contenu structuré. Les colonnes ADR
(Titre/Statut/Contexte/Décision/Conséquences) n'existent pas ; le rattachement N:N
projet/repo existe déjà (`doc_projects`, `doc_repos`) mais n'est alimenté que par un
`projectId`/`repoId` unique, sans notion d'ADR globale.

La recette source (`RECT-mu9yzd23-8l7t`, item 120) exige que le **registre** porte le modèle
structuré, base du chantier ADR (item 6 = famille `adr_*`, item 8 = fusion vers `artifacts`
polymorphe). Points de vigilance structurants :

- **Canal** : `doc_*` reste le canal de **rétrocompatibilité** (docs ADR-12 fichiers) ; la
  famille productrice `adr_*` est l'item 6 (hors périmètre de ce plan) — éviter la double
  exposition redondante.
- **Fusion ultérieure (item 8 / ordre 1 → 4 → 8)** : ce modèle sera rebasé sur la table
  `artifacts` polymorphe. Les champs structurés doivent donc être **préservables** → ajout
  d'une colonne `meta` (JSON sérialisé) dès maintenant.
- **Rétrocompat critique** : `doc_list(includeRepoDocs)` est consommé par les sessions
  recette/test-agent (`docsForProjectContext`, `listRepos`, `listProjectsWithRepos`) — le SQL
  existant ne doit pas changer de comportement.

Les fichiers cibles (`db.mjs`, `index.mjs`, `schema.sql`) sont dans le périmètre de la tâche.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter | 8 `ALTER TABLE docs ADD COLUMN IF NOT EXISTS` dans `migrate()` (l.44-53) : `status`, `context`, `decision`, `consequences`, `replaced_by`, `is_global INTEGER NOT NULL DEFAULT 0`, `meta`, `updated_at` | `db.mjs` | `db.mjs` | Bases PostgreSQL **existantes** (branche `feature/migration-postgresql`) : migrer sans perte | `migrate()` idempotent ajoutant les colonnes structurées ADR |
| A002 | Ajouter | Colonnes `status, context, decision, consequences, replaced_by, is_global, meta, updated_at` au `CREATE TABLE IF NOT EXISTS docs` (l.215-223) | `db.mjs` | `db.mjs` | Nouvelles bases : créer directement le modèle complet | Schéma `docs` de `db.mjs` aligné sur les colonnes ADR |
| A003 | Ajouter | Tables `repos`, `project_repos`, `docs` (colonnes ADR), `doc_projects`, `doc_repos` + index, en `CREATE TABLE IF NOT EXISTS` après le bloc `projects` (~l.56) | `schema.sql` | `schema.sql` | `schema.sql` = source de vérité **logique** chargée AVANT `migrate()` ; il ne contient NI `docs` NI `repos` → la FK de `doc_repos` exige `repos` | `schema.sql` reflète le modèle docs/ADR (idempotent) |
| A004 | Ajouter | Constante `export const ADR_STATUS = ["Proposé","Accepté","Déprécié","Remplacé"]` + helper de validation, près de `DOC_KINDS` (l.1455) | `db.mjs` | `db.mjs` | Référentiel unique des statuts, partagé avec `index.mjs` | `ADR_STATUS` exporté et validé |
| A005 | Exposer | Champs `status, context, decision, consequences, replacedBy, isGlobal, meta, updatedAt` dans `rowToDoc()` (l.1457-1463) | `db.mjs` | `db.mjs` | `rowToDoc` alimente `getDoc`/`listDocs`/`enrichDocs` → `doc_get` et `doc_list` exposent les champs sans autre modif | Sérialisation complète d'une ADR (défauts `null` pour les docs legacy) |
| A006 | Modifier | `registerDoc()` (l.1512-1532) : accepter `status` (validé `ADR_STATUS`), `context`, `decision`, `consequences`, `replacedBy`, `repoIds` (array 1..N), `global` (bool) ; si `global` → rattacher **tous** les repos du projet (`project_repos`) + `is_global=1` ; conserver `projectId`/`repoId` | `db.mjs` | `db.mjs` | Persister une ADR structurée + rattachement 1..N repos + cas ADR globale | ADR structurée créée avec ses champs et ses liens repos |
| A007 | Modifier | `updateDoc()` (l.1534-1552) : accepter `status` (validé), `context`, `decision`, `consequences`, `replacedBy`, `addRepoIds` (array), `setGlobal` ; **corriger** le paramètre `nowIso()` poussé mais non référencé (SET `updated_at = $n`) ; conserver `addProjectId`/`addRepoId` | `db.mjs` | `db.mjs` | MAJ des champs + rattachements ; le `nowIso()` orphelin est une incohérence SQL latente (param en trop vs placeholders) | `doc_update` met à jour champs, statut, `updated_at` et rattachements |
| A008 | Ajouter | Filtre optionnel `status` dans `listDocs()` (l.1573-1616), **sans modifier** le SQL `includeRepoDocs` (l.1585-1601) ni le SQL `repoId` | `db.mjs` | `db.mjs` | Filtrage par statut demandé ; préserver strictement la rétrocompat `includeRepoDocs` | `listDocs` filtre par `status` en plus de `kind`/`projectId`/`repoId` |
| A009 | Ajouter | Import `ADR_STATUS` depuis `./db.mjs` dans le bloc d'imports (l.105-111) | `index.mjs` | `index.mjs` | Réutiliser le référentiel de statuts pour le schéma zod | `ADR_STATUS` disponible dans `index.mjs` |
| A010 | Modifier | Tool `doc_register` (l.352-369) : ajouter `status` (z.enum `ADR_STATUS`), `context`, `decision`, `consequences`, `replacedBy`, `repoIds` (z.array(z.string())), `global` (z.boolean()) au `inputSchema` + au handler | `index.mjs` | `index.mjs` | Exposer les champs ADR structurés et le rattachement 1..N repos / global | `doc_register` accepte et retourne l'ADR structurée |
| A011 | Modifier | Tool `doc_update` (l.371-388) : ajouter `status`, `context`, `decision`, `consequences`, `replacedBy`, `addRepoIds`, `setGlobal` au `inputSchema` + handler | `index.mjs` | `index.mjs` | Exposer la MAJ des champs ADR et des rattachements | `doc_update` met à jour l'ADR structurée |
| A012 | Modifier | Tool `doc_list` (l.412-426) : ajouter le filtre `status` (z.enum `ADR_STATUS`) au `inputSchema` + handler ; mettre à jour la description | `index.mjs` | `index.mjs` | Filtrage par statut + rappel du filtrage projet/repo conservé | `doc_list` filtre par statut, projet, repo (rétrocompat `includeRepoDocs`) |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `db.mjs` | Modification — `migrate()` (A001), `CREATE TABLE docs` (A002), constante `ADR_STATUS` (A004), `rowToDoc` (A005), `registerDoc` (A006), `updateDoc` (A007), `listDocs` (A008) |
| `schema.sql` | Modification — ajout des tables `repos`, `project_repos`, `docs`, `doc_projects`, `doc_repos` (A003) |
| `index.mjs` | Modification — imports (A009), tools `doc_register` (A010), `doc_update` (A011), `doc_list` (A012) |

Aucune création de fichier de code. `doc_get` et `doc_delete` ne nécessitent **aucune**
modification : `doc_get` renvoie `getDoc()` → `enrichDocs()` → `rowToDoc()` (couvert par A005).

## 5. Livrables attendus

1. `db.mjs` : `migrate()` idempotent ajoutant 8 colonnes ADR à `docs` (A001).
2. `db.mjs` : `CREATE TABLE docs` complet avec les colonnes ADR (A002).
3. `schema.sql` : tables `repos`/`project_repos`/`docs`/`doc_projects`/`doc_repos` (modèle docs/ADR) (A003).
4. `db.mjs` : constante `ADR_STATUS` exportée (A004).
5. `db.mjs` : `rowToDoc` exposant `status/context/decision/consequences/replacedBy/isGlobal/meta/updatedAt` (A005).
6. `db.mjs` : `registerDoc` persistant l'ADR structurée + rattachement 1..N repos + `global` (A006).
7. `db.mjs` : `updateDoc` mettant à jour champs/statut/rattachements + `updated_at` (bug corrigé) (A007).
8. `db.mjs` : `listDocs` filtrant par `status` sans casser `includeRepoDocs` (A008).
9. `index.mjs` : tools `doc_register`/`doc_update`/`doc_list` exposant les champs ADR et le filtrage statut/projet/repo (A009-A012).
10. Rétrocompatibilité : docs existants (`doc-…`, `kind=adr-tech`) restitués avec champs ADR `null` ; `doc_list(includeRepoDocs)` inchangé (A005, A008, A012).

## 6. Ordre & dépendances

```
A001 ─┐
A002 ─┼─► A004 ─► A005 ─┬─► A006 ─┐
A003 ─┘                 ├─► A007 ─┼─► A009 ─┬─► A010
                        └─► A008 ─┘         ├─► A011
                                            └─► A012
```

- **A001, A002, A003** (schéma : migrations / CREATE TABLE / schema.sql) sont prérequis de
  toute écriture : à réaliser en premier. A001 et A002 ne sont pas contradictoires
  (ALTER pour bases existantes vs CREATE pour bases neuves).
- **A004** (référentiel `ADR_STATUS`) précède **A006, A007, A008** (validation) et **A009** (import).
- **A005** (`rowToDoc`) précède les fonctions qui retournent des docs (A006, A007, A008) et les tools (A010-A012).
- **A006, A007, A008** dépendent du schéma (A001-A003) et de `ADR_STATUS` (A004).
- **A009** (import) précède **A010, A011, A012** (tools).
- A010, A011, A012 sont indépendantes entre elles (tools distincts).

## 7. Couverture des objectifs

| Exigence (item 120 / critères d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------------------|----------|-----------|
| Champ **Titre** structuré | `title` existant + A002, A003, A005, A006, A010 | ✅ |
| Champ **Statut** (`Proposé/Accepté/Déprécié/Remplacé`) | A001, A002, A003, A004, A006, A007, A010, A011 | ✅ |
| Champ **Contexte** | A001, A002, A003, A005, A006, A007, A010, A011 | ✅ |
| Champ **Décision** | A001, A002, A003, A005, A006, A007, A010, A011 | ✅ |
| Champ **Conséquences** | A001, A002, A003, A005, A006, A007, A010, A011 | ✅ |
| ADR rattachée à un **projet** | `doc_projects` (A003, A006, A007) | ✅ |
| ADR rattachée à **1..N repos** du projet | `doc_repos` (A003), `repoIds` (A006), `addRepoIds` (A007), A010, A011 | ✅ |
| **ADR globale** = tous les repos du projet | `is_global` (A001-A003), résolution `project_repos` (A006), `setGlobal` (A007), A010, A011 | ✅ |
| `doc_register` expose les champs | A009, A010 | ✅ |
| `doc_update` expose les champs | A009, A011 | ✅ |
| `doc_get` expose les champs | A005 (`rowToDoc` → `getDoc`/`enrichDocs`) | ✅ |
| `doc_list` expose les champs + filtrage projet/repo | A008, A012 (filtrage projet/repo existant conservé) | ✅ |
| `doc_list` filtre par **statut** | A008, A012 | ✅ |
| **Rétrocompat** docs existants (`doc-…`, `kind=adr-tech`) | A005 (défauts `null`), A008 (SQL `includeRepoDocs` inchangé), A012 | ✅ |
| Champs/meta **préservables** (fusion item 8) | colonne `meta` (A001, A002, A003) + exposition (A005) | ✅ |
| `replacedBy` (statut `Remplacé` — chaînage) | A001-A003 (colonne `replaced_by`), A006, A007, A010, A011 | ✅ |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** — regroupement par élément cible :

- `db.mjs` / `docs` (schéma) : A001 (`ALTER`) et A002 (`CREATE TABLE`) — **complémentaires**
  (bases existantes vs neuves), pas de contradiction. Aucune étape `supprimer` sur `docs`.
- `db.mjs` / `rowToDoc` : A005 unique (exposer) — pas de conflit.
- `db.mjs` / `registerDoc` : A006 unique (créer/persister) — pas de conflit.
- `db.mjs` / `updateDoc` : A007 unique (modifier) — pas de conflit ; correction d'un bug
  local (param `nowIso()` non référencé) sans effet de bord sur les autres étapes.
- `db.mjs` / `listDocs` : A008 unique (ajouter filtre) — **ne touche pas** le SQL
  `includeRepoDocs` (rétrocompat préservée).
- `index.mjs` / tools : A010 (`doc_register`), A011 (`doc_update`), A012 (`doc_list`) —
  trois tools distincts, pas de recouvrement.
- `schema.sql` : A003 unique — pas de conflit intra-plan.

Aucune contradiction (`supprimer`+`modifier`, `déplacer`+`supprimer`, lecture d'un élément
créé plus tard) n'est détectée. Aucune étape vague : chaque action cible un élément nommé
dans un fichier identifié, avec un verbe précis.

**Résultat Plan Validator : `Valid`.**

## 9. Risques & notes

1. **Chevauchement inter-tâches (à signaler en Phase 9)** : l'item 123 (`T-20260920-162756-m30s`,
   ordre 4/8) a pour objet d'**aligner `schema.sql`** sur les tables réellement créées par
   `db.mjs` (`repos`, `project_repos`, `docs`, `doc_projects`, `doc_repos`, `task_repos`,
   `e2e_test_repos`, `org_git_tokens`). A003 ajoute déjà la famille `docs`/`repos` requise par
   le modèle ADR. Comme tout est en `CREATE TABLE IF NOT EXISTS`, l'item 123 reste idempotent
   et n'ajoutera que les tables restantes — mais **la coordination est à vérifier** pour éviter
   une divergence de définition de `repos`/`docs`.
2. **Type de `meta`** : `TEXT` (JSON sérialisé) choisi conformément à l'en-tête de `schema.sql`
   (« TEXT ... JSON sérialisé »), et non `JSONB` (utilisé pour `repos.meta`). Ce choix préserve
   la portabilité et sera normalisé lors de la fusion vers `artifacts` (item 8).
3. **`is_global` dénormalisé** : `is_global` est posé au moment de l'enregistrement (`global=true`).
   Si la composition des repos d'un projet change ensuite, `is_global` peut devenir incohérent ;
   `setGlobal` (A007) permet de re-rattacher tous les repos. Documenter ce comportement.
4. **`doc_update` — bug latent** : le paramètre `nowIso()` (l.1546) est poussé dans `params`
   sans placeholder correspondant → A007 le rattache à `updated_at` (nouvelle colonne). Sans
   cette correction, `UPDATE` fournirait plus de paramètres que de placeholders.
5. **Migration non destructive** : `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` avec défauts
   (`is_global DEFAULT 0`, autres `NULL`) → les docs existants restent lisibles, champs ADR `null`.
6. **Hors périmètre** : famille `adr_*` (item 6), fusion `artifacts` (item 8), onglet panneau
   (item 2), pièces jointes (item 3) — non traités ici.

## 10. Tests E2E Playwright — analyse d'impact

**E2E : NA.** La tâche porte sur le **registre MCP backend** (schéma PostgreSQL + tools MCP
`doc_*`) : aucun comportement utilisateur observable via une UI déployée. Aucun test E2E
Playwright n'est enregistré pour le projet `ecosystem` (`e2e_list(project="ecosystem")` →
`count: 0`) et le repo `opencode-mcp-task-orchestrator` n'a ni `e2eRepoDir` ni `e2eBaseUrl`.
Aucune entité E2E n'est donc créée ni liée pour cette tâche. La validation attendue est un
contrôle d'intégration MCP (appels `doc_register`/`doc_update`/`doc_get`/`doc_list` sur une
base PostgreSQL), hors périmètre E2E Playwright.
