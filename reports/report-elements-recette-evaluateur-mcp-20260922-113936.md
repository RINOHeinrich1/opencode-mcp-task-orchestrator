# Rapport — Éléments de recette évaluateur (registre MCP) — décision admin, reprise en cadrage, pièces par élément

- **Tâche** : `T-20260922-100650-3w6i` (feature, projet `ecosystem`)
- **Exécution** : `E-T-20260922-100650-3w6i-7krbw7` (attempt 1)
- **Plan** : `Plan-elements-recette-evaluateur-mcp-20260922-113243` — **100 %** (25/25 étapes `done`)
- **Repo** : `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (hôte-natif)
- **Agent** : `build-notify`
- **Date** : 2026-09-22 11:39

## 1. Résumé

**Demandé** : étendre le registre MCP pour que les éléments de recette évaluateur
(`evaluation_items`) portent (1) une décision ADMIN « à traiter » distincte du statut
de suivi, (2) une sélection en contexte d'un cadrage technique avec traçage « repris
par le cadrage X », (3) des pièces jointes portées par l'élément — sans réintroduire
de conversion automatique en tâches, et sans dupliquer l'existant `evaluations*` /
`cadrage_*`.

**Fait** : les 25 étapes A001–A025 du plan validé ont été exécutées. Le registre
expose désormais la décision admin (`pending|a_traiter|non_retenu`) tracée
(auteur/date), la table de lien `cadrage_evaluation_items` avec **garde** « à traiter »,
le rattachement de pièces à un élément via `meta.itemId`, et **5 nouveaux tools MCP**
(`evaluation_item_decision`, `evaluation_items_treatable`,
`cadrage_evaluation_item_link` / `_unlink` / `_list`) plus le paramètre `itemId` de
`evaluation_doc_add`. Le contrat d'interface gelé (§6 du plan, consommé par le plan
panneau parallèle) est respecté.

## 2. Isolation

- **Espace Coder** : N/A — repo **hôte-natif** (le MCP task-orchestrator n'est pas
  monté dans un workspace Coder). Confirmé par le plan et l'exécution directe.
- **session-guard** : `acquire --dir /root/.config/opencode/mcp/task-orchestrator` →
  `mode: "in-place"` (aucune session parallèle détectée). Le checkout courant reste
  sur `feature/migration-postgresql`.
- **Branche de travail dédiée** : `build-notify/elements-recette-evaluateur-mcp`
  créée depuis `c4c2243` (base du plan). **Aucun commit sur
  `feature/migration-postgresql`**, aucun push vers la branche de déploiement.
- **Aucun autre repo touché** (`opencode-observability` traité par la sous-tâche
  panneau parallèle).

## 3. Branche et commits

- **Branche** : `build-notify/elements-recette-evaluateur-mcp`
- **Base** : `c4c224344291401c9e124bb75fbf95bfd910d522` (`feature/migration-postgresql`)
- **Commits** :
  - `7001a2f` — feat(evaluations): éléments de recette évaluateur — décision admin « à traiter », reprise en cadrage, pièces par élément (T-20260922-100650-3w6i)
    - `db.mjs` (+202/-…), `index.mjs` (+76/-…), `schema.sql` (+15)
  - (commit du présent rapport, ajouté ci-après)

## 4. Traitements effectués

| Étape | Statut | Résultat |
|-------|--------|----------|
| A001 | done | `SCHEMA_VERSION` → `2026-09-22-evaluation-items-workflow` |
| A002 | done | `migrate()` : `ALTER TABLE evaluation_items ADD COLUMN IF NOT EXISTS decision/decided_at/decided_by` |
| A003 | done | `migrate()` : `CREATE TABLE cadrage_evaluation_items` (PK composite, FKs CASCADE) + index `idx_cadrage_evaluation_items_item` |
| A004 | done | `schema.sql` : 3 colonnes sur `evaluation_items` |
| A005 | done | `schema.sql` : table `cadrage_evaluation_items` + index (miroir exact) |
| A006 | done | `EVALUATION_ITEM_DECISIONS = ["pending","a_traiter","non_retenu"]` exportée |
| A007 | done | `getEvaluationItem` expose `decision/decidedAt/decidedBy` |
| A008 | done | `setEvaluationItemDecision({itemId, decision, by})` + validation enum + throw si introuvable |
| A009 | done | `addEvaluationDocument` accepte `itemId` → `meta.itemId` |
| A010 | done | `listEvaluationDocuments(evaluationId, {itemId})` expose/filtre `itemId` |
| A011 | done | `getEvaluationById` : items enrichis (`decision`, `documents[]` par item, `reprisPar[]`) |
| A012 | done | `listTreatableEvaluationItems({project})` : items `a_traiter` + `reprisPar[]` |
| A013 | done | `linkCadrageEvaluationItem` + **garde** `decision === 'a_traiter'` + `ON CONFLICT DO NOTHING` |
| A014 | done | `unlinkCadrageEvaluationItem` |
| A015 | done | `listCadrageEvaluationItems({recetteId})` |
| A016 | done | `getRecetteById` expose `evaluationItems[]` |
| A017 | done | `listProjectEvaluations` / `rowToEvaluationSummary` : `treatableCount` |
| A018 | done | imports `index.mjs` complétés (6 symboles) |
| A019 | done | tool `evaluation_item_decision` |
| A020 | done | tool `evaluation_items_treatable` |
| A021 | done | tool `cadrage_evaluation_item_link` |
| A022 | done | tool `cadrage_evaluation_item_unlink` |
| A023 | done | tool `cadrage_evaluation_item_list` |
| A024 | done | `evaluation_doc_add` : paramètre `itemId` |
| A025 | done | descriptions `evaluation_get` / `cadrage_get` / `evaluation_item_update` alignées |

## 5. Fichiers modifiés / créés

- `/root/.config/opencode/mcp/task-orchestrator/db.mjs` (modifié)
- `/root/.config/opencode/mcp/task-orchestrator/schema.sql` (modifié)
- `/root/.config/opencode/mcp/task-orchestrator/index.mjs` (modifié)
- `/root/.config/opencode/mcp/task-orchestrator/reports/report-elements-recette-evaluateur-mcp-20260922-113936.md` (créé — ce rapport)

## 6. Vérifications

1. **Syntaxe** : `node --check db.mjs` **OK**, `node --check index.mjs` **OK**.
2. **`migrate()` idempotent** (registre PostgreSQL live `task_registry`) : 2 passes
   consécutives OK ; chemin rapide au 2e appel ; `schema_version` en base =
   `2026-09-22-evaluation-items-workflow`.
3. **DDL en base** : `evaluation_items` porte `decision (def 'pending')`,
   `decided_at`, `decided_by` ; table `cadrage_evaluation_items` + index
   `idx_cadrage_evaluation_items_item` présents.
4. **Test fonctionnel bout-en-bout (19/19 PASS)** — évaluation + élément créés,
   puis :
   - décision par défaut `pending` ; `setEvaluationItemDecision` trace décision/date/auteur ;
   - décision invalide **refusée** ;
   - pièce rattachée à l'élément (`meta.itemId`) + filtre `listEvaluationDocuments({itemId})` ;
   - `evaluation_get` : décision, `documents[]` par item, `reprisPar[]` ;
   - `listTreatableEvaluationItems` : uniquement `a_traiter` ;
   - lien cadrage↔élément créé, **idempotent**, visible dans `listCadrageEvaluationItems`,
     `cadrage_get.evaluationItems`, et `evaluation_get.reprisPar` ;
   - **garde** : reprise d'un élément `non_retenu` **refusée** ; l'élément disparaît
     des « à traiter » ;
   - `treatableCount` exposé par `listProjectEvaluations`.
   - **Nettoyage** : données de test supprimées (évaluation, élément, pièces, recette,
     liens) ; aucune donnée `__VERIF__` résiduelle.
5. **Convergence** : aucune entité concurrente créée, aucun renommage, aucun tool de
   conversion en tâches ajouté (`confirmEvaluation` inchangé).

## 7. Avertissements / erreurs

- La migration additive a été appliquée au registre PostgreSQL **live** (effet
  attendu du bump `SCHEMA_VERSION`, toutes DDL `IF NOT EXISTS`). Aucune donnée
  métier altérée.
- `git status` laisse des fichiers `plans/` et `reports/` **non suivis** provenant
  d'autres tâches : volontairement **non commités** (hors périmètre de ce plan).

## 8. Prochaines étapes / recommandations

- **Recette humaine** : le contrat d'interface (tools + champs) est gelé ; le plan
  panneau `…-panneau-20260922-113244` peut consommer `evaluation_item_decision`,
  `evaluation_items_treatable`, `cadrage_evaluation_item_link/unlink/list` et
  `evaluation_doc_add(itemId)`.
- **Déploiement CI/CD** sur la branche de travail (jamais push direct sur la branche
  de déploiement).
- E2E **NA** (registre MCP, pas de comportement navigateur — cf. plan §10).
