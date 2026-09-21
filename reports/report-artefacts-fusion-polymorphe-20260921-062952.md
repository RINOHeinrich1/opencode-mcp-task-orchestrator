# Rapport de fin de tâche — Artefacts : fusion polymorphe + gestionnaire central

- **Tâche** : `T-20260920-162801-jxtr` (executionId `E-T-20260920-162801-jxtr-vfbfzp`)
- **Plan** : `Plan-artefacts-fusion-polymorphe-20260921-060112` (78 étapes A001–A078)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 8/8, dernière)
- **Recette source** : `RECT-mu9yzd23-8l7t` (item 127)
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 06:29

## 1. Résumé

Demande : **fusionner physiquement** les 3 silos d'artefacts (`artifacts` tâche,
`recette_documents`, `docs`/`doc_attachments`) en **UNE table polymorphe
`artifacts`** identifiée par (`doc_type`, `content_id`), rebaser les implémentations
MCP `doc_*`/`adr_*`/recette sur cette table, transformer l'onglet panneau en
**gestionnaire central « Artefacts »**, et livrer/exécuter le **plan de migration**
(inventaire, mapping, script idempotent, validation, rollback, neutralisation).

Fait :
- Schéma cible (`schema.sql`), `migrate()` et modèle polymorphe (`db.mjs`), tools
  MCP étendus (`index.mjs`), **script de migration** (`scripts/artifacts-fusion-migration.mjs`).
- Panneau : serveur rebasé (`server.mjs`), onglet **« Artefacts »** gestionnaire
  central (`public/app.js`, `public/style.css`) + référentiel `public/docs/nomenclature-doc-type.md`.
- **Migration exécutée sur la base LIVE** : inventaire → snapshot → migrate ×2
  (idempotence prouvée) → **validate PASS (13/13)**.
- **A078 (neutralize) NON exécuté** : précondition de mise en service non
  satisfaite (cf. §6 blocage). Commande prête, à lancer après déploiement.

**Avancement du plan : 77/78 étapes `done`, 1 `blocked` (A078), 99 %.**

## 2. Isolation

- **Espace Coder** : les repos du projet `ecosystem` sont des **composants
  d'infrastructure** de l'hôte (`/root/.config/opencode/mcp/task-orchestrator`,
  `/root/orchestrator-panel`, `/root/.config/opencode/scripts`) — **aucun
  workspace Coder** ne les héberge. Conformément au CADRE (zones (a) MCP et (b)
  Panneau sur l'hôte) et à la norme (dérogation « composant d'infrastructure »),
  le travail a été fait sur l'hôte, en **non-root** pour les commandes, et ce
  point est documenté ici.
- **session-guard** : `acquire` → code 0 (mode in-place, aucune session
  parallèle) sur les deux repos. Verrous libérés en fin de traitement (§7).
- **Worktrees dédiés** (branche de travail par repo, checkouts principaux
  laissés **propres**) :
  - MCP : `/root/.config/opencode/mcp/task-orchestrator-wt-artefacts-fusion-mcp`
    (branche `build-notify/artefacts-fusion-mcp`) — `node_modules` lié
    symboliquement au checkout principal (hors index, via `.git/info/exclude`).
  - Panneau : `/root/orchestrator-panel/.worktrees/artefacts-fusion`
    (branche `build-notify/artefacts-fusion-panel`) — **worktree imbriqué** car
    la politique d'accès aux répertoires externes refuse l'écriture hors de
    `/root/orchestrator-panel/**` ; `.worktrees/` exclu via `.git/info/exclude`.
  - **Note** : les worktrees et branches sont **conservés** (non supprimés) pour
    permettre le merge/déploiement par l'orchestrateur ; seuls les verrous
    session-guard sont libérés.

## 3. Branches et commits

### Repo `opencode-mcp-task-orchestrator` — branche `build-notify/artefacts-fusion-mcp`
Base : `9187ea9` (feature/migration-postgresql)
| SHA | Message |
|-----|---------|
| `090d310` | feat(artefacts): fusion polymorphe — table unique artifacts (doc_type/content_id), rebasage doc_*/adr_*/recette/E2E, script de migration (T-20260920-162801-jxtr) |
| `3ebf9f0` | fix(artefacts): migration — lever task_id NOT NULL (familles non-task) + timestamp snapshot sans point (T-20260920-162801-jxtr) |

### Repo `opencode-observability` (panneau) — branche `build-notify/artefacts-fusion-panel`
Base : `5fef85b` (feature/migration-postgresql)
| SHA | Message |
|-----|---------|
| `3ab81ba` | feat(artefacts): panneau — onglet « Artefacts » gestionnaire central (toutes entités) + nomenclature doc_type (T-20260920-162801-jxtr) |

## 4. Traitements effectués (par bloc du plan)

| Bloc | Étapes | Résultat |
|------|--------|----------|
| 0 — Référentiel taxonomie | A001 | `public/docs/nomenclature-doc-type.md` (13 familles + `autre`, mapping 1:1, `content_type` réservé, ON DELETE par famille) |
| 1 — Schéma cible | A002–A005 | `artifacts` polymorphe (avant `adr_conflicts`), `artifact_projects`/`artifact_repos`, FK `adr_conflicts.adr_id` → `artifacts`, DDL legacy retiré (bloc commentaire) |
| 2 — `migrate()` + modèle | A006–A016 | Constantes de taxonomie, expansion additive + backfill idempotent, `rowToArtifact`/`addArtifact`/`listArtifacts`/`getArtifact` polymorphes, helpers de liaison |
| 3 — Rebasage `doc_*` | A017–A028 | `registerDoc`/`updateDoc`/`deleteDoc`/`getDoc`/`listDocs`/`docsForProjectContext`/`docsByProjectRepoBatch`/`listRepos` sur `artifacts` (INC-011 préservé) |
| 4 — Rebasage `adr_*` + PJ | A029–A038 | `adr_*` via primitives rebasées ; pièces jointes = `artifacts` `doc_type='adr_file'` (cible dans `meta.targetDocId`) |
| 5 — Rebasage recette | A039–A042 | `recette_documents` → `artifacts` ; `documentId` = `artifacts.id` (entier) conservé |
| 6 — Suppression/liens/E2E | A043–A046 | `deleteTask`/`listTaskLinks` par famille task ; E2E `e2e_video` upsert ; jointures E2E préservées |
| 7 — Tools MCP | A047–A052 | `artifact_add`/`artifact_list` étendus + rétrocompat `taskId` ; descriptions `doc_*`/`adr_*` à jour |
| 8 — Script migration | A053–A058 | `scripts/artifacts-fusion-migration.mjs` : `inventory`/`snapshot`/`migrate`/`validate`/`neutralize`/`rollback` |
| 9 — Panneau serveur | A059–A068 | `/api/artifacts` central, routes centrales view/download, `POST /api/artifacts`, recettes et contexte E2E rebasés |
| 10 — Panneau UI | A069–A074 | Onglet « Artefacts », `renderArtifacts` central, modales ajout + visionneuse, libellés, styles |
| 11 — Migration LIVE | A075–A078 | A075 ✅ A076 ✅ A077 ✅ **A078 bloqué** (cf. §6) |

## 5. Inventaire / mapping / validation de migration (chiffré)

**Inventaire pré-migration (LIVE)** — `reports/artifacts-inventory-live.md` :

| Source | Total |
|--------|-------|
| `artifacts` | **770** (`plan`=184, `report`=572, `audit`=1, `autre`=13) |
| `recette_documents` | **30** |
| `docs` | **5** |
| `doc_attachments` | **0** |
| `doc_projects` | **5** |
| `doc_repos` | **5** |

**Snapshot (rollback défini AVANT écriture)** — timestamp `20260921062725` :
`artifacts_backup_20260921062725`, `docs_backup_…`, `recette_documents_backup_…`,
`doc_attachments_backup_…`, `doc_projects_backup_…`, `doc_repos_backup_…`.

**Migration (LIVE)** — ordre strict `artifacts → recette_documents → docs →
doc_attachments → liens` :
- Run 1 : `recette_documents`=**30 insérés**, `docs`=**5 insérés**,
  `doc_attachments`=0, `doc_projects→artifact_projects`=**5**,
  `doc_repos→artifact_repos`=**5**.
- Run 2 (rejeu) : **0 insert** partout → **idempotence prouvée**.

**État post-migration** : `artifacts` = **805** lignes
(`plan`=184, `task_report`=572, `audit_report`=1, `autre`=13, `recette_doc`=30,
`adr`=3, `specs`=1, `gherkin`=1) ; `content_id` NULL = **0** ;
`artifact_projects`=5, `artifact_repos`=5.

**Validation post-migration (LIVE)** — `reports/artifacts-validation-live.md` :
**verdict PASS — 13/13 contrôles** :
unicité `artifact_id` (0 doublon) ; `docs→artifacts` 5/5 ; `recette_documents→artifacts`
30/30 ; `doc_attachments→artifacts` 0/0 ; liens projet 5/5 ; liens repo 5/5 ;
statut ADR conservé (0 écart) ; `meta` TEXT→JSONB (0 valeur non-JSON) ;
rétrocompat `artifact_list(taskId)` (2 artefacts) ; rétrocompat `recette_get`→documents
(documentId entier, 4 documents) ; rétrocompat `doc_list(includeRepoDocs)` (4 docs) ;
rétrocompat `doc_get`/`adr_get` ; jointures E2E (`report_artifact_id` résout un
artefact — 50 exécutions, 0 cible introuvable).

## 6. Fichiers modifiés / créés

**MCP `opencode-mcp-task-orchestrator`** :
- `schema.sql` — table polymorphe `artifacts`, `artifact_projects`/`artifact_repos`, FK `adr_conflicts`, retrait DDL legacy.
- `db.mjs` — constantes taxonomie, `migrate()`, modèle artefacts, rebasages `doc_*`/`adr_*`/recette/E2E.
- `index.mjs` — `artifact_add`/`artifact_list` étendus, descriptions, imports.
- `scripts/artifacts-fusion-migration.mjs` — **créé** (migration idempotente + inventory/snapshot/validate/neutralize/rollback).
- `reports/artifacts-inventory-live.md`, `reports/artifacts-validation-live.md` — **créés** (sorties de migration).

**Panneau `opencode-observability`** :
- `server.mjs` — `/api/artifacts` central, routes centrales view/download, `POST /api/artifacts`, recettes + contexte E2E rebasés.
- `public/app.js` — onglet « Artefacts », gestionnaire central, modales ajout/visionneuse, libellés.
- `public/style.css` — styles `.art-*`.
- `public/docs/nomenclature-doc-type.md` — **créé** (référentiel central de taxonomie).

## 7. Avertissements / erreurs

1. **A078 `neutralize` NON exécuté (BLOCAGE)** — le code **actuellement en
   service** (MCP `task-orchestrator` spawné depuis le checkout principal, non
   redéployé ; `pm2 orchestrator-panel` en v0.9.65) lit encore `artifacts.task_id`,
   `docs` et `recette_documents`. Renommer ces objets maintenant **casserait le
   registre LIVE** (`artifact_add`/`artifact_list`, `doc_*`, recette) et
   empêcherait la traçabilité de fin de tâche. La garde-fou interdit par ailleurs
   tout `DROP` : le `neutralize` implémenté est un **renommage**
   (`docs→legacy_docs`, `recette_documents→legacy_recette_documents`,
   `doc_attachments→legacy_doc_attachments`, `doc_projects→legacy_doc_projects`,
   `doc_repos→legacy_doc_repos`, `artifacts.task_id→legacy_task_id`) + rebasage
   de la FK `adr_conflicts.adr_id` → `artifacts`. **Aucun DROP de table/colonne.**
2. **Écart A014 (assumé)** — le rebasage de la FK `adr_conflicts.adr_id` a été
   déplacé de `migrate()` vers `neutralize()` : le rebaser avant redéploiement
   ferait échouer `reportAdrConflict` du code legacy (docs encore autoritaire).
   Le rebasage est ainsi atomique avec la bascule.
3. **`content_id` nullable sur base existante** — `schema.sql` (base neuve) la
   déclare `NOT NULL` ; sur la base existante elle est ajoutée nullable puis
   backfillée (0 NULL constaté). Divergence volontaire pour ne pas bloquer le boot.
4. **Levée de contrainte `artifacts.task_id DROP NOT NULL`** (nécessaire aux
   familles non-task) — il s'agit d'une levée de contrainte, **pas** d'un DROP de
   colonne.
5. **INC-011** (`listDocs` `includeRepoDocs`+`status`) — sémantique SQL actuelle
   **préservée**, non corrigée (hors périmètre).
6. **Ambiguïté taxonomie « 14 valeurs + autre »** — la liste explicite compte
   **13 familles nommées + `autre`** ; retenu tel quel, **aucune 14ᵉ valeur
   inventée** (à réconcilier humainement).
7. **Worktree panneau imbriqué** (`.worktrees/`) au lieu d'un worktree externe,
   contrainte de politique d'accès aux répertoires externes.
8. **Push non effectué** — livraison sur branches locales (le merge/déploiement
   est l'étape orchestrateur) ; aucun `pm2` relancé.

## 8. E2E

`e2e_list(project='ecosystem')` → **0 test** ; les repos de l'écosystème ne
contiennent pas de harnais Playwright. Stratégie **E2E NA** (aucune création en
aveugle), conforme au §9.9 du plan.

## 9. Prochaines étapes / recommandations

1. **Merge** de `build-notify/artefacts-fusion-mcp` et
   `build-notify/artefacts-fusion-panel` dans `feature/migration-postgresql`
   (branche principale), puis **push** → CI/CD.
2. **Rejouer la migration avant/avec le redémarrage** du code rebasé (les
   écritures legacy survenues entre-temps seront rattrapées — script idempotent) :
   `node scripts/artifacts-fusion-migration.mjs migrate` puis `… validate`
   (PASS obligatoire).
3. **Redémarrer** le MCP `task-orchestrator` et `pm2 restart orchestrator-panel`
   (mise en service — étape orchestrateur).
4. **Puis seulement** exécuter la neutralisation :
   `node scripts/artifacts-fusion-migration.mjs neutralize`
   (renommage `legacy_*` + `legacy_task_id` + rebasage FK — **aucun DROP**).
5. **Rollback** si besoin : `node scripts/artifacts-fusion-migration.mjs rollback --ts 20260921062725`
   (+ consigne `pg_dump` en tête de script). Les tables legacy restent intactes.
6. Réconciliation humaine de l'ambiguïté « 14 valeurs + `autre` » (13 familles
   nommées retenues) et arbitrage éventuel sur `pilot.mjs` (hors périmètre).
