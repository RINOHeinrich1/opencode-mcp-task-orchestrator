# Synthèse de planification — `T-20260920-162801-jxtr` (item 127)

- **Tâche** : `T-20260920-162801-jxtr` (executionId `E-T-20260920-162801-jxtr-vfbfzp`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 8/8, dernière)
- **Recette source** : `RECT-mu9yzd23-8l7t` — item 127
- **Date** : 2026-09-21 06:03:05
- **Agent** : `atomic-plan`

## 1. Objectifs identifiés (Phase 0)

**Un seul objectif** (non fragmentable, dépendances internes séquentielles) :

> Fusionner **physiquement** les silos d'artefacts (`artifacts` tâche, `recette_documents`, `docs` ADR-12, + `doc_attachments`) en **UNE table polymorphe `artifacts`** identifiée par (`doc_type`, `content_id`), avec taxonomie énumérée, rebasage des couches MCP `doc_*`/`adr_*`, onglet panneau « Artefacts » gestionnaire central, et **plan de migration** complet (inventaire, mapping, script idempotent, validation, rollback, bascule, neutralisation).

→ **Un seul plan** produit (pas de segmentation : les sous-livrables sont interdépendants et strictement ordonnés).

## 2. Plans générés (Phase 8)

| PlanId | Fichier | Étapes | Verdict |
|--------|---------|--------|---------|
| `Plan-artefacts-fusion-polymorphe-20260921-060112` | `plans/Plan-artefacts-fusion-polymorphe-20260921-060112.md` | 78 (A001→A078, 11 blocs) | **VALID** |

- Enregistré via `plan_register` (taskId `T-20260920-162801-jxtr`) — persistance en base.
- Rattachement tâche : `artifact_add` (kind=plan) + `task_event` `PLAN_CREATED`.

## 3. Découpage du plan

| Bloc | Contenu | Étapes |
|------|---------|--------|
| 0 | Référentiel central `nomenclature-doc-type.md` | A001 |
| 1 | Schéma cible (`schema.sql`) : `artifacts` polymorphe + `artifact_projects`/`artifact_repos` + FK `adr_conflicts` + retrait DDL legacy | A002-A005 |
| 2 | `migrate()` + constantes taxonomie + modèle `artifacts` (`db.mjs`) | A006-A016 |
| 3 | Rebasage `doc_*` sur `artifacts` | A017-A028 |
| 4 | Rebasage `adr_*` + pièces jointes (`adr_file`) | A029-A038 |
| 5 | Rebasage `recette_documents` (rétrocompat `documentId` entier) | A039-A042 |
| 6 | `deleteTask`/`listTaskLinks`/E2E (ON DELETE par famille + preuves E2E) | A043-A046 |
| 7 | Tools MCP `artifact_add`/`artifact_list` étendus + descriptions | A047-A052 |
| 8 | Script de migration (inventory/snapshot/migrate/validate/rollback/neutralize) | A053-A058 |
| 9 | Panneau serveur (`server.mjs`) : gestionnaire central + routes | A059-A068 |
| 10 | Panneau UI (`app.js`/`style.css`) : onglet « Artefacts » | A069-A074 |
| 11 | Exécution migration → bascule → validation → neutralisation | A075-A078 |

## 4. Vérifications de cohérence

### 4.1 Intra-plan (Phases 6-7)
- Aucune contradiction : `artifacts` suit **expand (A007) → migrate (A008) → validate (A077) → contract (A078)** ; les tables legacy sont **renommées** (A078), jamais supprimées, et lues par le script avant (A056).
- `adr_conflicts.adr_id` : FK rebasée (A004/A014) **avant** neutralisation (A078).
- `listArtifacts` (familles task) et `listDocs` (familles docs) filtrent des `doc_type` **disjoints** → pas de lecture incohérente.
- Les étapes `Vérifier` (A027/A028/A042/A046/A052/A068) ne ré-éditent pas les éléments déjà traités.
- **Verdict : VALID**.

### 4.2 Globale (Phase 9 — inter-plans)
- La présente tâche est **8/8** et **dernière du batch**. Aucun autre plan actif de ce batch ne cible `artifacts`/`docs`/`recette_documents` (les plans des items 120/122/125/126 sont **done** et leurs livrables sont des **dépendances** exploitées ici).
- **Aucune incohérence inter-plans détectée** : pas de `task_event INCONSISTENCY_FOUND` émis.

## 5. Points de risque identifiés (à l'attention de l'exécution)

1. **Rétrocompat `artifact_list(taskId)`** (4 agents + panneau) → filtre `content_id = taskId AND doc_type = ANY(TASK_DOC_TYPES)` (A013/A048).
2. **`recette_get` → documents stable** → `documentId` conservé **entier** (`artifacts.id` IDENTITY) + `artifactId` ajouté (A040/A066).
3. **Jointures E2E** `report_artifact_id`/`video_url` → `artifact_id` **préservé** par la migration ; `video_url` devient un artefact `e2e_video` (A045/A046).
4. **`meta` TEXT → JSONB** → cast sûr obligatoire (A056), valeurs non-JSON encapsulées (pas de perte).
5. **`content_id` polymorphe sans FK** → perte des `ON DELETE CASCADE` DB ; comportement par famille défini + implémenté côté code (task A043, docs A019, e2e A045) ; recette/projet sans chemin de suppression (documenté).
6. **Taxonomie « 14 valeurs + `autre` » ambiguë** : la liste explicite de la mission = 13 familles + `autre` (= 14). Le plan retient la **liste explicite** et le signale pour réconciliation — **ne pas inventer de 14ᵉ valeur**.
7. **Ordre de déploiement** : `snapshot` (A055/A075) **avant** `migrate` (A076) ; `validate` **PASS** (A077) **avant** `neutralize` (A078) ; `DROP task_id` seulement après que plus aucun code ne le référence.
8. **INC-011 hors périmètre** : le rebasage de `listDocs` (A021) préserve la sémantique SQL actuelle (dont la précédence `includeRepoDocs`+`status`).
9. **`pilot.mjs` non modifié** (hors périmètre déclaré) : les accès `artifacts` du panneau restent en SQL direct dans `server.mjs`.

## 6. Stratégie E2E

**E2E NA** — les repos de l'écosystème (`opencode-mcp-task-orchestrator`, `opencode-observability`, `opencode-scripts`, `opencode-agents`) ne contiennent **aucun `playwright.config.*`** ni `tests/e2e/**` ; `e2e_list(project='ecosystem')` → **0 test**. Aucun test E2E à créer/modifier/obsoléter, **aucun enregistrement en aveugle**. Scénario candidat (si harnais ajouté plus tard) : « le gestionnaire central « Artefacts » liste tous les artefacts (tâche/recette/projet/doc), filtre par doc_type/content_id/kind, Regarder/Télécharger fonctionne ».

## 7. Rattachements (registre)

- `plan_register` : `Plan-artefacts-fusion-polymorphe-20260921-060112` (taskId `T-20260920-162801-jxtr`).
- `participant_add` : `atomic-plan` (role=planner).
- `artifact_add` : kind=plan → `/root/.config/opencode/mcp/task-orchestrator/plans/Plan-artefacts-fusion-polymorphe-20260921-060112.md`.
- `task_event` : `PLANNING_STARTED`, `PLAN_CREATED`.
- `artifact_add` : kind=report → présent document.

**Fin de planification — 1 plan VALID, 0 incohérence.**
