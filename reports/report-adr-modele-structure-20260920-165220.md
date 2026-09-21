# Rapport de fin de tâche — ADR : modèle structuré en base + rattachement 1..N repos

- **Tâche** : `T-20260920-162753-hpcj`
- **ExecutionId** : `E-T-20260920-162753-hpcj-ewmk3e`
- **Plan** : `Plan-adr-modele-structure-20260920-163126` (12 étapes A001–A012)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-20 16:52:20
- **Recette source** : `RECT-mu9yzd23-8l7t` (item 120)

## 1. Résumé

Demandé : porter les ADR comme **entités structurées** dans le registre (Titre, Statut
`Proposé | Accepté | Déprécié | Remplacé`, Contexte, Décision, Conséquences), rattachées à
un projet et à **1..N de ses repos** (ADR « globale » = tous les repos du projet), exposées
par `doc_register` / `doc_update` / `doc_get` / `doc_list` avec filtrage projet/repo/statut,
**sans casser la rétrocompatibilité** des docs existants.

Fait : les 12 étapes du plan sont implémentées et vérifiées (tests d'intégration sur base
PostgreSQL isolée + test MCP de bout en bout + test du chemin de migration d'une base
existante). Progression plan : **100 % (12/12 done)**.

## 2. Isolation

- **Espace Coder** : le repo `opencode-mcp-task-orchestrator` **n'existe dans aucun
  workspace Coder** (vérifié via `workspace_list`) : c'est un repo d'infrastructure qui vit
  sur l'hôte (`/root/.config/opencode/mcp/task-orchestrator`) — checkout légitime conforme au
  cadre de la tâche. Aucun autre repo du projet n'a été touché.
- **session-guard** : `acquire` → `mode: in-place`, `exit 0` (aucune session parallèle).
  Un **worktree dédié** a néanmoins été créé pour respecter l'exigence de branche de travail :
  - worktree : `/root/.config/opencode/mcp/task-orchestrator-wt-adr-modele-structure`
  - branche : `build-notify/adr-modele-structure`
  - SHA de base : `ecdfad1d547dab0ba01bfa316950de132feb4c06`
- **Chemins autorisés** : écritures confinées à `/root/.config/opencode/**` (worktree + rapport)
  et `/tmp/opencode/**` (scripts de test). Aucune écriture hors périmètre.
- **Périmètre (scope)** respecté : seuls `db.mjs`, `index.mjs`, `schema.sql` modifiés.
  `package.json` **non touché** (hors scope) — le message de commit n'embarque donc pas de
  bump de version.

## 3. Branche et commits

- **Branche de travail** : `build-notify/adr-modele-structure` (basée sur
  `feature/migration-postgresql` @ `ecdfad1`).
- **Commit** (1) :

| SHA | Message |
|-----|---------|
| `2ff160cb43f34ba38e4f1d66a1e6b26391448c7b` | `feat(adr): ADR structurées en base (statut/contexte/décision/conséquences) + rattachement 1..N repos` |

Aucun push effectué (non demandé). La branche est conservée localement pour le merge/déploiement
(voir §7 — écart volontaire sur `session-guard remove`).

## 4. Traitements effectués (étapes A001–A012)

| Étape | Fichier | Traitement | Résultat |
|-------|---------|-----------|----------|
| A001 | `db.mjs` | 8 × `ALTER TABLE docs ADD COLUMN IF NOT EXISTS` (`status, context, decision, consequences, replaced_by, is_global, meta, updated_at`) + `idx_docs_status` dans `migrate()` | ✅ |
| A002 | `db.mjs` | `CREATE TABLE IF NOT EXISTS docs` complété avec les 8 colonnes ADR | ✅ |
| A003 | `schema.sql` | Tables `repos`, `project_repos`, `docs` (colonnes ADR), `doc_projects`, `doc_repos` + index | ✅ |
| A004 | `db.mjs` | `ADR_STATUS` exporté + `assertAdrStatus()` (validation partagée) | ✅ |
| A005 | `db.mjs` | `rowToDoc()` expose `status/context/decision/consequences/replacedBy/isGlobal/meta/updatedAt` | ✅ |
| A006 | `db.mjs` | `registerDoc()` : champs ADR + `repoIds` (1..N) + `global=true` (tous les repos du projet) | ✅ |
| A007 | `db.mjs` | `updateDoc()` : champs ADR + `addRepoIds` + `setGlobal` ; **bug `updated_at` corrigé** (param `nowIso()` orphelin) | ✅ |
| A008 | `db.mjs` | `listDocs()` : filtre `status` (SQL `includeRepoDocs`/`repoId` inchangés) | ✅ |
| A009 | `index.mjs` | Import de `ADR_STATUS` depuis `./db.mjs` | ✅ |
| A010 | `index.mjs` | Tool `doc_register` : `status/context/decision/consequences/replacedBy/repoIds/global` | ✅ |
| A011 | `index.mjs` | Tool `doc_update` : `status/context/decision/consequences/replacedBy/addRepoIds/setGlobal` | ✅ |
| A012 | `index.mjs` | Tool `doc_list` : filtre `status` + description | ✅ |

## 5. Fichiers modifiés / créés

| Fichier | Nature | Lignes |
|---------|--------|--------|
| `db.mjs` | Modifié | +128 / −11 |
| `index.mjs` | Modifié | +26 / −10 |
| `schema.sql` | Modifié | +78 / −0 |
| `reports/report-adr-modele-structure-20260920-165220.md` | Créé (rapport, hors code) | — |

Aucun fichier de code créé. `doc_get` / `doc_delete` : aucune modification requise (couverts par
`rowToDoc`).

## 6. Tests / vérifications

Base PostgreSQL isolée (`orchestrator-postgres`), jamais la base de production.

1. **Test d'intégration couche db** (`/tmp/opencode/adr-test/test.mjs`) — **36 assertions PASS** :
   - doc legacy (`kind=adr-tech`, `projectId`+`repoId`) : champs ADR `null`, `isGlobal=false`,
     rattachements projet/repo conservés ;
   - ADR structurée + `repoIds=[r1,r2]` : champs et rattachements 1..N restitués ;
   - ADR globale (`global=true`) : rattachée aux 3 repos du projet, `isGlobal=true` ;
   - `global=true` sans `projectId` → erreur ; statut invalide → erreur ;
   - `updateDoc` : statut/`replacedBy`/contexte, `addRepoIds`, `setGlobal` true/false,
     **`updatedAt` rafraîchi** (bug corrigé), enrichissement d'un doc legacy ;
   - `listDocs` : filtre `status`, `projectId`+`includeRepoDocs` (rétrocompat), `repoId`,
     combinaison `kind`+`status`.
2. **Test du chemin MIGRATION** (`test-migration.mjs`) — base « legacy » sans colonnes ADR :
   `ensureSchema()` ne casse pas, les 8 colonnes + `organization_id` sont ajoutées, l'index
   `idx_docs_status` est créé, le doc legacy reste lisible (champs ADR `null`) puis enrichissable.
   → **6 assertions PASS**.
3. **Test MCP de bout en bout** (`test-mcp.mjs`, JSON-RPC stdio sur `index.mjs`) —
   **10 assertions PASS** : `initialize`, `tools/list` (schémas exposant les champs ADR),
   `doc_register` structuré, `doc_list` filtré par statut, `doc_update`, `doc_get`,
   rejet d'un statut invalide.
4. **Vérifications statiques** : `node --check db.mjs` et `node --check index.mjs` OK ;
   `z.enum(ADR_STATUS)` validé avec zod 4.4.3.

### Point de vigilance corrigé en cours de route
Ajouter `CREATE INDEX ... ON docs(status)` dans `schema.sql` **aurait cassé les bases
existantes** (colonne `status` absente au moment où `schema.sql` est chargé, avant `migrate()`).
L'index est donc créé **dans `migrate()` après les `ALTER`** ; `schema.sql` ne crée que l'index
`kind` (colonne toujours présente). Comportement validé par le test de migration.

## 7. Avertissements / erreurs

1. **Trace commits — entrée erronée** : un appel `plan_commit_add` a été émis par erreur avec
   `sha="placeholder-noop"` (entrée id 430, sans branche/fichiers). La trace est **append-only**
   (aucun outil de suppression) : cette entrée est du **bruit** et doit être ignorée. Le seul
   commit réel est `2ff160c`.
2. **Écart volontaire sur `session-guard remove`** : la commande `remove` supprime la branche
   dédiée (`git branch -D`), ce qui **détruirait le commit livré** (non mergé/pushé). Pour ne pas
   perdre le livrable, le **worktree physique a été retiré manuellement** et le **verrou libéré**
   via `session-guard release`, en **conservant la branche** `build-notify/adr-modele-structure`.
3. **`is_global` dénormalisé** (risqué, documenté au plan §9.3) : `is_global` est posé à
   l'enregistrement ; si la composition des repos du projet évolue ensuite, l'ADR globale peut
   devenir incomplète — `doc_update(setGlobal=true)` permet de re-rattacher tous les repos.
4. **`meta` en `TEXT`** (JSON sérialisé) pour `docs`, conformément à l'en-tête de `schema.sql`
   (normalisation prévue lors de la fusion vers `artifacts`, item 8) ; `repos.meta` reste `JSONB`
   (aligné sur `db.mjs`).
5. **E2E** : **NA** (plan §10) — registre MCP backend, aucun comportement UI observable ; aucun
   test Playwright créé/lié.

## 8. Prochaines étapes / recommandations

1. **Merge** de `build-notify/adr-modele-structure` vers `feature/migration-postgresql`
   (branche de déploiement du repo) — décision humaine/orchestrateur.
2. Au redémarrage du serveur MCP, `ensureSchema()` appliquera `schema.sql` + `migrate()` sur la
   base de production : migration **non destructive** validée sur base legacy.
3. **Coordination item 123** (`T-20260920-162756-m30s`, alignement `schema.sql` sur les tables
   réelles) : `A003` ajoute déjà la famille `docs`/`repos` en `CREATE TABLE IF NOT EXISTS` ;
   vérifier l'absence de divergence de définition `repos`/`docs`.
4. Hors périmètre de ce plan : famille `adr_*` (item 6), fusion `artifacts` polymorphe (item 8),
   onglet panneau (item 2), pièces jointes (item 3).
