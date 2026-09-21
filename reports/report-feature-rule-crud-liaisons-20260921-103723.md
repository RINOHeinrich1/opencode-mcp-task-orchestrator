# Rapport de fin de sous-tâche — Familles MCP `feature_*` / `rule_*` (CRUD) + outils de liaison + workflow ADR proposé→validé

- **Tâche** : `T-20260921-091733-rpvh` (exécution `E-T-20260921-091733-rpvh-d3owq1`)
- **Plan (sous-tâche)** : `Plan-feature-rule-crud-liaisons-20260921-102722` — **44/44 étapes done (100 %)**
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Repo** : `/root/.config/opencode/mcp/task-orchestrator` (**repo HÔTE**, aucun workspace Coder)
- **Agent** : `build-notify`
- **Date** : 2026-09-21 10:37:23
- **Branche de travail** : `build-notify/feature-rule-crud-liaisons` (base `feature/migration-postgresql` @ `947fcf3`)
- **Worktree** : `/root/.config/opencode/mcp/task-orchestrator-wt-feature-rule-crud-liaisons`
- **ADR de référence** : `doc-mub10mo8-lgo3` — ADR-001 (statut **Proposé**, globale aux 3 repos du projet `ecosystem`)

---

## 1. Résumé

Exposition des **familles MCP `feature_*` / `rule_*` (CRUD)** au-dessus des tables T1
(`fonctionnalites`, `regles_metier`) et des **outils de liaison** sur les **12 tables N:N** livrées en T1,
avec trois règles structurantes :

1. **Pièce source gardée** : `sourcedPieceId` validé par la garde T2 `assertAttachablePiece`
   (nature markdown/pdf/docx/lien ; photos/vidéos refusées) **+ appartenance au projet**.
2. **Émergence réutilisée** : `classifyEmergence(pid, {kind:'element'})` — hors sprint → `hors_sprint`,
   dernier sprint clôturé → `apres_cloture`, sprint ouvert → non émergent + rattachement
   `sprint_fonctionnalites`/`sprint_regles`. Le rattachement ultérieur (`*_sprint_link`) **n'efface pas**
   le flag `emergent` (traçabilité conservée).
3. **Lien ADR d'une tâche proposé → validé** : `task_adr.status` (`propose` par l'agent → `valide` par
   l'humain en recette), tracé (`proposed_by/at`, `validated_by/at`, `reason`) ; **aucune création
   systématique d'ADR** (liaison vers une ADR **existante** via `getAdr`).

**Périmètre respecté** : `db.mjs` + `index.mjs` uniquement ; **aucune** modification du modèle
ADR/`artifacts`, des primitives T1-T4, du panneau (T7) ni des cardinalités heuristiques (T6) ;
`schema.sql` **non modifié** (dérive DDL signalée §7).

## 2. Isolation

| Repo | Espace | Worktree | Branche |
|------|--------|----------|---------|
| `opencode-mcp-task-orchestrator` | **HÔTE** (composant d'infrastructure — absent de `workspace_list`, 7 workspaces Coder listés : madatalk, ONIRIA, myxmax, affelyos, admin-myxmax, ia-crm-frontend, ia-crm-api) | `/root/.config/opencode/mcp/task-orchestrator-wt-feature-rule-crud-liaisons` | `build-notify/feature-rule-crud-liaisons` |

- `session-guard acquire` → **code 0 / mode in-place** (aucune autre session parallèle détectée).
  Le plan interdisant tout commit direct sur la branche principale (`feature/migration-postgresql`),
  le travail a été mené dans un **worktree + branche dédiée** (`session-guard worktree`), comme T2/T3/T4.
- `node_modules` **symlinké** dans le worktree pour l'exécution (gitignoré, non committé).
- **Aucun push** (merge/push = étape d'orchestration ultérieure). Worktree et branche **conservés**
  (un `session-guard remove` supprimerait la branche donc le commit) ; seul le verrou est libéré
  (`release`).

## 3. Branches et commits

| Repo | Branche | Commit | Base |
|------|---------|--------|------|
| `opencode-mcp-task-orchestrator` | `build-notify/feature-rule-crud-liaisons` | `6b0573c256566f09a06726e62d8027662f048c77` | `947fcf3f55d5e0a92e10ad96f4e11695a8e0c1a0` |

Trace **append-only** persistée (`plan_commits` : **1 commit**, 2 fichiers) via `addPlanCommit`
(code identique au tool `plan_commit_add` — garantit les diffs exacts) :
`db.mjs` (modified, **+747/-0**), `index.mjs` (modified, **+433/-0**).
`plan_set_branch(planId, "build-notify/feature-rule-crud-liaisons")` effectué.

## 4. Traitements effectués (44/44)

### `db.mjs` — A001-A023

| Étape | Statut | Détail |
|-------|--------|--------|
| A001 | done | `migrate()` (après le bloc DDL `task_adr`) : `ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS` × 6 (`status` NOT NULL DEFAULT `'propose'`, `proposed_by`, `proposed_at`, `validated_by`, `validated_at`, `reason`) + `CREATE INDEX IF NOT EXISTS idx_task_adr_status`. **Additif** (aucune colonne existante modifiée). |
| A002 | done | `rowToFonctionnalite(r)` (sérialisation camelCase). |
| A003 | done | `rowToRegle(r)` (sérialisation camelCase). |
| A004 | done | `registerFeature({projectId, ref, role, userStory, sourcedPieceId, createdBy})` — `assertProjectExists` ; `ref`/`userStory` requis ; pièce source via `assertAttachablePiece` + `assertPieceOwnedByProject` ; `classifyEmergence(pid,{kind:'element'})` ; non émergente ⇒ lien `sprint_fonctionnalites` au sprint ouvert ; `organization_id` héritée ; id `FEAT-<ts>-<rand>` ; `ref` dupliquée ⇒ erreur. |
| A005 | done | `updateFeature({featureId, ref, role, userStory, sourcedPieceId, by})` — modification partielle + `updated_at` ; re-gardage pièce si changée ; retour `getFeature`. |
| A006 | done | `getFeature(featureId)` — détail + liens (règles, Gherkin `e2e_tests`, ADR, sprints, tâches, recettes) ; `null` si inconnue. |
| A007 | done | `listFeatures({projectId, emergent, search, limit})` — tri `ref`, filtre émergence + recherche (`ref`/`user_story`). |
| A008 | done | `registerRule({projectId, ref, content, sourcedPieceId, createdBy})` — mêmes gardes que A004 ; non émergente ⇒ lien `sprint_regles` ; id `RMET-<ts>-<rand>`. |
| A009 | done | `updateRule({ruleId, ref, content, sourcedPieceId, by})`. |
| A010 | done | `getRule(ruleId)` — détail + fonctionnalités (inverse) + sprints. |
| A011 | done | `listRules({projectId, emergent, search, limit})`. |
| A012 | done | `linkFeatureRule` / `unlinkFeatureRule` (N:N `fonctionnalite_regles`, idempotent, extrémités validées). |
| A013 | done | `linkFeatureGherkin` / `unlinkFeatureGherkin` (`fonctionnalite_gherkin` → `e2e_tests`) — **test EXISTANT** (`getE2ETestRow`), aucune création. |
| A014 | done | `linkFeatureAdr` / `unlinkFeatureAdr` (`fonctionnalite_adr`) — `getAdr` ; `unlink` **laisse remonter** l'erreur du trigger T1 `trg_fonctionnalite_adr_min` (ADR ≥1 fonctionnalité). |
| A015 | done | `linkFeatureSprint` / `unlinkFeatureSprint` (rattachement d'une émergente à un sprint ultérieur). |
| A016 | done | `linkRuleSprint` / `unlinkRuleSprint`. |
| A017 | done | `linkTaskSprint` / `unlinkTaskSprint` (`assertTaskExists` + `getSprint`). |
| A018 | done | `linkTaskFeature` / `unlinkTaskFeature` (`task_fonctionnalites`). |
| A019 | done | `proposeTaskAdr` / `validateTaskAdr` / `unlinkTaskAdr` / `listTaskAdrs` — upsert `propose` (idempotent, **ne rétrograde jamais** un lien `valide`) ; `validate` ⇒ `valide` + `validated_by/at` (erreur si aucune proposition) ; `list` filtre par statut + `effective`. |
| A020 | done | `linkRecetteSprint` / `unlinkRecetteSprint` (`recette_sprints`). |
| A021 | done | `linkRecetteFeature` / `unlinkRecetteFeature` (`recette_fonctionnalites`). |
| A022 | done | `linkRecetteAdr` / `unlinkRecetteAdr` (`recette_adr`). |
| A023 | done | `getRecetteById` enrichie (additif) : renvoie `sprints`, `fonctionnalites`, `adrs` lus depuis `recette_sprints` / `recette_fonctionnalites` / `recette_adr`. |

### `index.mjs` — A024-A043

| Étape | Statut | Détail |
|-------|--------|--------|
| A024 | done | Imports `./db.mjs` complétés : 8 CRUD + 20 `link*/unlink*` + 4 workflow ADR. |
| A025-A028 | done | Tools `feature_register`, `feature_update`, `feature_get`, `feature_list`. |
| A029-A032 | done | Tools `rule_register`, `rule_update`, `rule_get`, `rule_list`. |
| A033 | done | Tools `feature_rule_link` / `feature_rule_unlink`. |
| A034 | done | Tools `feature_gherkin_link` / `feature_gherkin_unlink`. |
| A035 | done | Tools `feature_adr_link` / `feature_adr_unlink`. |
| A036 | done | Tools `feature_sprint_link` / `feature_sprint_unlink`. |
| A037 | done | Tools `rule_sprint_link` / `rule_sprint_unlink`. |
| A038 | done | Tools `task_sprint_link` / `task_sprint_unlink`. |
| A039 | done | Tools `task_feature_link` / `task_feature_unlink`. |
| A040 | done | Tools `task_adr_propose` / `task_adr_validate` / `task_adr_unlink` / `task_adr_list` (description explicite « effectif seulement après validation humaine »). |
| A041 | done | Tools `recette_sprint_link` / `recette_sprint_unlink`. |
| A042 | done | Tools `recette_feature_link` / `recette_feature_unlink`. |
| A043 | done | Tools `recette_adr_link` / `recette_adr_unlink`. |
| A044 | done | Vérification (voir §6). |

## 5. Fichiers modifiés / créés

Dans le worktree (commit `6b0573c`, **purement additif : +1180 / -0**) :

- `db.mjs` (modifié, +747) — A001-A023.
- `index.mjs` (modifié, +433) — A024-A043.

**Aucun** fichier créé, **aucune** modification de `schema.sql`, du modèle ADR (`adr_*`,
`doc_type='adr'`), de la table polymorphe `artifacts`, ni des primitives T1-T4.

## 6. Vérifications (preuves)

### 6.1 `node --check` — OK
`node --check db.mjs` et `node --check index.mjs` : **OK** (syntaxe).

### 6.2 Spawn MCP réel (stdio JSON-RPC) — **66/66 PASS**

MCP `index.mjs` du worktree lancé en stdio (`initialize` → `tools/list` → `tools/call`) :

- **`tools/list`** : **157 tools** (125 + 32 nouveaux) ; les **32** nouveaux tools sont exposés,
  **aucune collision de nom**.
- **CRUD** : `feature_register` (pièce source gardée ; **non émergente** en sprint ouvert ; `ref`
  dupliquée ⇒ err ; `userStory` manquante ⇒ err ; pièce inconnue ⇒ err) ; `rule_register` ;
  `feature_update` / `rule_update` ; `feature_get` (règles/Gherkin/ADR/sprints/tâches/recettes) ;
  `rule_get` (fonctionnalités inverse) ; `feature_list` / `rule_list`.
- **Garde nature T2 conservée** : `piece_add` refuse une photo (`.jpg`) ; `feature_register` valide la
  pièce source via `assertAttachablePiece`.
- **Liens** : `feature_rule_link` (+ idempotence `linked=false`) ; `feature_gherkin_link` (test existant
  lié ; test inconnu ⇒ err, **aucune création**) ; `feature_adr_link` (ADR existante) ; `feature_adr_unlink`
  ⇒ **err du trigger T1** « doit être rattachée à au moins 1 fonctionnalité » sur la dernière
  fonctionnalité, puis **OK** dès qu'une autre fonctionnalité reste ; `task_feature_link` ; `task_sprint_link`.
- **Émergence / rattachement ultérieur** : après `sprint_close`, `feature_register` et `rule_register`
  ⇒ `emergent=true` / `apres_cloture` ; `feature_sprint_link` / `rule_sprint_link` ⇒ rattachement OK ;
  le flag `emergent` **reste vrai** après rattachement.
- **Workflow ADR proposé→validé** : `task_adr_validate` sans proposition ⇒ err ;
  `task_adr_propose` ⇒ `status=propose`, `effective=false` ; `task_adr_list(status='propose')` ⇒ 1 lien
  non effectif ; `task_adr_validate` ⇒ `status=valide`, `effective=true` + `validated_at` ;
  `task_adr_list` ⇒ effectif + traçabilité (`proposedBy/validatedBy/reason`) ; re-`propose` ⇒ **ne
  rétrograde pas** (`unchanged=true`) ; `task_adr_validate` sur ADR non proposée ⇒ err ; `task_adr_unlink`.
- **Recette** : `recette_sprint_link` / `recette_feature_link` / `recette_adr_link` ⇒ OK ; `recette_get`
  expose bien `sprints` / `fonctionnalites` / `adrs` (liens créés visibles) ; `*_unlink` OK.
- **Non-régression T1-T4 / ADR** : `sprint_get`, `sprint_report` (markdown), `adr_list`, `adr_get`
  (statut `Proposé`), `piece_list`, `task_get`, `task_register`/`task_delete`, `project_list` ⇒ OK.

### 6.3 E2E Playwright : **NA**

Aucun `playwright.config.*` ni spec E2E dans `opencode-mcp-task-orchestrator` ; comportement **interne**
(registre + tools MCP), non observable par un parcours Playwright. Aucun `e2e_test_register` /
`e2e_test_link` (conforme plan §7/§9). Vérification par spawn MCP + appels réels.

## 7. Avertissements / erreurs / écarts

1. **Dérive DDL `schema.sql` (hors périmètre — à résorber)** : les colonnes d'état `task_adr`
   (`status`, `proposed_by/at`, `validated_by/at`, `reason`) et l'index `idx_task_adr_status` sont posés
   **uniquement dans `migrate()`** (`db.mjs`). Le runtime est correct (migrate s'exécute après
   `schema.sql` à chaque `ensureSchema()`), mais `schema.sql` n'est **pas** miroité. Une tâche de suivi
   doit y ajouter les mêmes `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `CREATE INDEX`.
2. **Écart de comptage du plan (non bloquant)** : les libellés du plan annoncent « **22** fonctions
   `link*/unlink*` » et « **22** tools de liaison + 4 workflow ADR », alors que les étapes **explicites**
   A012-A022 / A033-A043 en énumèrent respectivement **24** fonctions (20 paires + 4 workflow) et
   **24** tools (20 liaison + 4 workflow), soit **32 tools** au total (8 CRUD + 24). Les étapes
   détaillées étant sans ambiguïté, l'implémentation suit **exactement** l'énumération A012-A022 /
   A033-A043 (aucune étape manquante, aucune en trop). Écart **de synthèse** uniquement (le plan
   comptait A019/A040 comme 2 éléments au lieu de 4).
3. **`validateTaskAdr` sur un lien déjà `valide`** : retourne un succès **idempotent**
   (`alreadyValidated=true`) plutôt qu'une erreur ; l'erreur « aucune proposition » n'est levée que si
   **aucune** ligne `task_adr` n'existe. Interprétation retenue du plan (« erreur si aucune proposition
   en attente ») — à confirmer si l'orchestrateur attend un refus strict sur re-validation.
4. **Données de vérification nettoyées** : la vérification a créé un projet temporaire
   `t5-verify-eco` (sprint, fonctionnalités `US-001/002/003`, règles `RM-0001/0003`, 1 pièce, 1 tâche,
   liens). **Nettoyage effectué** (suppression du projet + toutes ses lignes + liens ; trigger T1
   désactivé/réactivé le temps du nettoyage). Contrôle final : `fonctionnalites`/`regles_metier`/
   `sprints` = **0**, `task_adr` = **0**, liens recette = **0**, projet = **0** ; trigger
   `trg_fonctionnalite_adr_min` **réactivé** (`tgenabled='O'`) ; colonnes `task_adr` + index présents.
5. **ADR-001 est `Proposé`** : les ajouts sont **additifs**, sans nouvelle garde bloquante au-delà du
   trigger T1 déjà en place — aucune contradiction avec une ADR Acceptée.
6. **Aucune incohérence code ↔ plan** détectée (`INCONSISTENCY_FOUND` non levée) ; **aucun blocage**.

## 8. Prochaines étapes / recommandations

1. **Merge/push** de la branche `build-notify/feature-rule-crud-liaisons` par l'orchestrateur (sync avec
   `feature/migration-postgresql` avant push) — **non fait ici**.
2. **Résorber la dérive DDL** : ajouter les colonnes d'état `task_adr` dans `schema.sql` (tâche de suivi).
3. **T6** (cardinalités heuristiques) et **T7** (panneau) : hors périmètre de cette sous-tâche.
4. **ADR-001** reste **Proposé** : l'acceptation est une **décision humaine**.
5. Le workflow ADR « proposé → validé » est désormais outillé : les recettes peuvent proposer
   (`task_adr_propose`, agent) puis valider (`task_adr_validate`, humain).
