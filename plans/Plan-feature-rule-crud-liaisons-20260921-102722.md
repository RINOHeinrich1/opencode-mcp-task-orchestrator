# Plan — Familles MCP `feature_*` / `rule_*` (CRUD) + outils de liaison (feature↔rule/gherkin/adr, tâche→sprint/feature/adr, recette→sprint/feature/adr ; lien ADR proposé→validé)

- **Tâche** : `T-20260921-091733-rpvh` (exécution `E-T-20260921-091733-rpvh-d3owq1`), batch `BATCH-mub1809u-06ow` (5/9)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Racine** : `/root/.config/opencode/mcp/task-orchestrator` (branche de travail dédiée via session-guard)
- **Date** : 2026-09-21 10:27:22
- **Plan ID** : `Plan-feature-rule-crud-liaisons-20260921-102722`

---

## 1. Objectif

Exposer les **familles MCP `feature_*` et `rule_*` (CRUD)** au-dessus des tables T1
(`fonctionnalites`, `regles_metier`) et les **outils de liaison** associés
(fonctionnalité↔règle, fonctionnalité↔scénario Gherkin **existant** `e2e_tests`,
fonctionnalité↔ADR, tâche↔sprint/fonctionnalité/ADR, recette↔sprint/fonctionnalité(s)/ADR(s)),
avec deux règles structurantes :

1. **Pièce source** : `sourced_piece_id` est validé par la **garde de pièce** de T2 (`assertAttachablePiece`).
2. **Lien ADR d'une tâche** : **PROPOSÉ** par l'agent (`task_adr.status='propose'`) → **EFFECTIF**
   seulement après **validation humaine** (`task_adr.status='valide'`). Pas de création systématique
   d'ADR par tâche.
3. **Émergence** : fonctionnalités/règles créées **hors sprint** ou **après clôture** sont marquées
   émergentes (réutilisation de `classifyEmergence`) et **rattachables à un sprint ultérieur**.

## 2. Contexte & raison d'être

La recette `RECT-muaz100k-2iq0` demande que les valeurs de référence du modèle
(fonctionnalités `US-xxx`, règles métier `RM-xxxx`) soient **remplies/lues via MCP** à partir des
**pièces client**, et reliées entre elles, aux scénarios Gherkin existants, aux ADR, aux sprints,
tâches et recettes.

Les dépendances sont **TERMINÉES** et fusionnées sur `feature/migration-postgresql` :

- **T1** (`3ee7755`) : tables `fonctionnalites` / `regles_metier` / `sprints` + **12 liens N:N**
  (`fonctionnalite_regles`, `fonctionnalite_gherkin`, `fonctionnalite_adr`, `sprint_fonctionnalites`,
  `sprint_regles`, `sprint_pieces`, `task_sprints`, `task_fonctionnalites`, `task_adr`,
  `recette_sprints`, `recette_fonctionnalites`, `recette_adr`).
- **T2** (`5444381`) : pièces client (`doc_type='piece'`) + garde `assertPieceAllowed` +
  `assertAttachablePiece` + requalification des docs ADR-12.
- **T3** (`8d77d01`) : cycle de vie sprint + garde partagée **`classifyEmergence`** + `sprint_report`.
- **T4** (`947fcf3`) : famille MCP `sprint_*` (`sprint_start/list/get/close/reopen/attach_pieces`).

Le présent plan **ne réimplémente aucune** primitive : il ajoute (a) les **CRUD `feature_*`/`rule_*`**
dans `db.mjs` + tools `index.mjs`, (b) les **fonctions de liaison** sur les tables N:N existantes, et
(c) l'**état `propose`→`valide`** sur `task_adr` (seule extension de schéma, **additive**).

**ADR de référence** : `ADR-001 — Modèle sprint / fonctionnalités / règles métier dans le registre
ecosystem` (`doc-mub10mo8-lgo3`, statut **Proposé**, globale aux 3 repos du projet `ecosystem`).
Points applicables : §3 features/règles reliées aux **scénarios Gherkin existants / ADR / sprints** et
alimentées depuis les pièces client ; §5 **cardinalités** — `ADR → 1..N fonctionnalités`, `sprint →
1..N fonctionnalités et 1..N règles`, `tâche → AU MOINS 1 ADR` (**lien proposé par l'agent, validé par
l'humain en recette — pas d'ADR systématique par tâche**), liens manquants à la création ⇒ **ÉMERGENT**
(flag + origine, non bloquant, **rattachable à un sprint ultérieur**). ADR-001 étant **Proposé** (non
encore Accepté), les étapes restent **additives** et n'introduisent aucune garde bloquante nouvelle.

**Frontière explicite** : le panneau (`opencode-observability`, T7) et les **cardinalités heuristiques**
(T6) sont **hors périmètre** ; le modèle ADR/`artifacts` (doc_type='adr', `adr_*`) n'est **pas** modifié.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | modifier | bloc DDL `task_adr` dans `migrate()` (l.593-598) : `ALTER TABLE task_adr ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'propose'`, `proposed_by`, `proposed_at`, `validated_by`, `validated_at`, `reason` + `CREATE INDEX IF NOT EXISTS idx_task_adr_status` | `db.mjs` | `db.mjs` | Porter l'**état tracé** « proposé → validé » du lien ADR d'une tâche (ADR-001 §5) ; **additif**, aucune colonne existante modifiée | Colonnes d'état sur `task_adr` + index `idx_task_adr_status` |
| A002 | créer | `rowToFonctionnalite(r)` (sérialise `fonctionnalites` → `{ id, project, ref, role, userStory, sourcedPieceId, emergent, emergentOrigin, createdAt, updatedAt, createdBy }`) | `db.mjs` | `db.mjs` | Sérialisation camelCase homogène avec `rowToSprint`/`rowToPiece` | `rowToFonctionnalite` (interne, section « FONCTIONNALITÉS / RÈGLES / LIAISONS ») |
| A003 | créer | `rowToRegle(r)` (sérialise `regles_metier` → `{ id, project, ref, content, sourcedPieceId, emergent, emergentOrigin, … }`) | `db.mjs` | `db.mjs` | Sérialisation camelCase homogène | `rowToRegle` (interne) |
| A004 | créer | `registerFeature({ projectId, ref, role, userStory, sourcedPieceId, createdBy })` | `db.mjs` | `db.mjs` | CRÉATION d'une fonctionnalité (`US-xxx`) : validation projet (`assertProjectExists`) + `ref`/`userStory` requis ; **garde pièce** (`assertAttachablePiece(sourcedPieceId)` + appartenance au projet) ; **émergence** `classifyEmergence(pid,{kind:'element'})` (émergent ⇒ `hors_sprint`/`apres_cloture`, non émergent ⇒ lien `sprint_fonctionnalites` au sprint ouvert) ; `organization_id` héritée | `registerFeature` exportée ; id `FEAT-<ts>-<rand>` ; ref dupliquée ⇒ erreur explicite |
| A005 | créer | `updateFeature({ featureId, ref, role, userStory, sourcedPieceId, by })` | `db.mjs` | `db.mjs` | MODIFICATION partielle des champs d'une fonctionnalité + `updated_at` ; re-gardage de la pièce source si changée (projet inchangé) | `updateFeature` exportée ; retour `getFeature` |
| A006 | créer | `getFeature(featureId)` — détail + liens | `db.mjs` | `db.mjs` | LECTURE détaillée : fonctionnalité + règles (`fonctionnalite_regles`), Gherkin (`fonctionnalite_gherkin` JOIN `e2e_tests`), ADR (`fonctionnalite_adr` JOIN `artifacts`), sprints (`sprint_fonctionnalites`), tâches (`task_fonctionnalites`), recettes (`recette_fonctionnalites`) | `getFeature` exportée ; `null` si inconnue |
| A007 | créer | `listFeatures({ projectId, emergent, search, limit })` | `db.mjs` | `db.mjs` | LISTE par projet, filtre émergence + recherche (`ref`/`user_story`), tri stable | `listFeatures` exportée |
| A008 | créer | `registerRule({ projectId, ref, content, sourcedPieceId, createdBy })` | `db.mjs` | `db.mjs` | CRÉATION d'une règle métier (`RM-xxxx`) : mêmes gardes que A004 (projet, pièce, émergence) ; non émergente ⇒ lien `sprint_regles` | `registerRule` exportée ; id `RMET-<ts>-<rand>` |
| A009 | créer | `updateRule({ ruleId, ref, content, sourcedPieceId, by })` | `db.mjs` | `db.mjs` | MODIFICATION partielle du contenu d'une règle + `updated_at` ; re-gardage pièce | `updateRule` exportée |
| A010 | créer | `getRule(ruleId)` — détail + liens | `db.mjs` | `db.mjs` | LECTURE détaillée : règle + fonctionnalités (`fonctionnalite_regles` inverse), sprints (`sprint_regles`) | `getRule` exportée ; `null` si inconnue |
| A011 | créer | `listRules({ projectId, emergent, search, limit })` | `db.mjs` | `db.mjs` | LISTE par projet, filtre émergence + recherche (`ref`/`content`) | `listRules` exportée |
| A012 | créer | `linkFeatureRule({ featureId, regleId })` / `unlinkFeatureRule({ featureId, regleId })` | `db.mjs` | `db.mjs` | Liaison **N:N** fonctionnalité↔règle (`fonctionnalite_regles`, idempotente) ; validation des 2 extrémités (`getFeature`/`getRule`) | 2 fonctions exportées ; `{ ok, featureId, regleId }` |
| A013 | créer | `linkFeatureGherkin({ featureId, e2eTestId })` / `unlinkFeatureGherkin({ featureId, e2eTestId })` | `db.mjs` | `db.mjs` | Liaison fonctionnalité↔**scénario Gherkin EXISTANT** (`fonctionnalite_gherkin` → `e2e_tests`) ; validation existence via `getE2ETestRow` (interne) — aucune création de test | 2 fonctions exportées ; erreur explicite si test inconnu |
| A014 | créer | `linkFeatureAdr({ featureId, adrId })` / `unlinkFeatureAdr({ featureId, adrId })` | `db.mjs` | `db.mjs` | Liaison **N:N** fonctionnalité↔ADR (`fonctionnalite_adr`) ; validation via `getAdr` (`kind='adr-tech'`) ; `unlink` **laisse remonter** l'erreur du trigger `trg_fonctionnalite_adr_min` (une ADR garde ≥1 fonctionnalité) | 2 fonctions exportées ; contrainte `ADR ≥1 fonctionnalité` respectée |
| A015 | créer | `linkFeatureSprint({ featureId, sprintId })` / `unlinkFeatureSprint({ featureId, sprintId })` | `db.mjs` | `db.mjs` | Rattacher une fonctionnalité **émergente** à un **sprint ultérieur** (`sprint_fonctionnalites`, ADR-001 §5) | 2 fonctions exportées |
| A016 | créer | `linkRuleSprint({ regleId, sprintId })` / `unlinkRuleSprint({ regleId, sprintId })` | `db.mjs` | `db.mjs` | Rattacher une règle émergente à un sprint ultérieur (`sprint_regles`) | 2 fonctions exportées |
| A017 | créer | `linkTaskSprint({ taskId, sprintId })` / `unlinkTaskSprint({ taskId, sprintId })` | `db.mjs` | `db.mjs` | Liaison tâche↔sprint (`task_sprints`) ; validation `assertTaskExists` + `getSprint` | 2 fonctions exportées |
| A018 | créer | `linkTaskFeature({ taskId, featureId })` / `unlinkTaskFeature({ taskId, featureId })` | `db.mjs` | `db.mjs` | Liaison tâche↔fonctionnalité (`task_fonctionnalites`) — alimente `buildSprintReport` (features implémentées) | 2 fonctions exportées |
| A019 | créer | `proposeTaskAdr({ taskId, adrId, reason, by })`, `validateTaskAdr({ taskId, adrId, by })`, `unlinkTaskAdr({ taskId, adrId })`, `listTaskAdrs({ taskId, status })` | `db.mjs` | `db.mjs` | **Workflow proposé→validé** (A001) : `propose` = upsert `task_adr.status='propose'` (idempotent, ne rétrograde **jamais** un lien déjà `valide`) vers une ADR **existante** (`getAdr`) ; `validate` = `status='valide'` + `validated_by`/`validated_at` (erreur si aucune proposition en attente) ; **effectif = `status='valide'`** | 4 fonctions exportées ; traçabilité `proposed_by/at`, `validated_by/at`, `reason` |
| A020 | créer | `linkRecetteSprint({ recetteId, sprintId })` / `unlinkRecetteSprint({ recetteId, sprintId })` | `db.mjs` | `db.mjs` | Liaison recette↔sprint (`recette_sprints`) ; validation `getRecetteById` + `getSprint` | 2 fonctions exportées |
| A021 | créer | `linkRecetteFeature({ recetteId, featureId })` / `unlinkRecetteFeature({ recetteId, featureId })` | `db.mjs` | `db.mjs` | Liaison recette↔fonctionnalité(s) (`recette_fonctionnalites`) | 2 fonctions exportées |
| A022 | créer | `linkRecetteAdr({ recetteId, adrId })` / `unlinkRecetteAdr({ recetteId, adrId })` | `db.mjs` | `db.mjs` | Liaison recette↔ADR(s) (`recette_adr`) ; validation `getAdr` | 2 fonctions exportées |
| A023 | modifier | `getRecetteById(recetteId)` (l.3744-3799) — ajouter les lectures `recette_sprints`→sprints, `recette_fonctionnalites`→fonctionnalités, `recette_adr`→ADR | `db.mjs` | `db.mjs` | Rendre **lisibles** les liens recette→sprint/feature(s)/ADR(s) créés en A020-A022 (complète `recette_get`), **additif** | `getRecetteById` renvoie `sprints`, `fonctionnalites`, `adrs` |
| A024 | modifier | import `./db.mjs` (l.138-147) : ajouter `registerFeature`, `updateFeature`, `getFeature`, `listFeatures`, `registerRule`, `updateRule`, `getRule`, `listRules`, les 22 fonctions `link*`/`unlink*` (A012-A022) et `proposeTaskAdr`/`validateTaskAdr`/`unlinkTaskAdr`/`listTaskAdrs` | `index.mjs` | `index.mjs` | Rendre les primitives disponibles aux tools `feature_*`/`rule_*` et aux outils de liaison | Imports complétés |
| A025 | ajouter | tool `feature_register` (nouvelle section « FONCTIONNALITÉS / RÈGLES / LIAISONS » après `sprint_attach_pieces` l.726) | `index.mjs` | `index.mjs` | Exposer la CRÉATION (`projectId`, `ref` US-xxx, `role`, `userStory`, `sourcedPieceId`) via A004 ; renvoie le détail | Tool `feature_register` enregistré |
| A026 | ajouter | tool `feature_update` (après `feature_register`) | `index.mjs` | `index.mjs` | Exposer la MODIFICATION via A005 | Tool `feature_update` enregistré |
| A027 | ajouter | tool `feature_get` (après `feature_update`) | `index.mjs` | `index.mjs` | Exposer la LECTURE détaillée + liens via A006 ; `err` si inconnue | Tool `feature_get` enregistré |
| A028 | ajouter | tool `feature_list` (après `feature_get`) | `index.mjs` | `index.mjs` | Exposer la LISTE par projet (+ émergence, recherche) via A007 | Tool `feature_list` enregistré → `{ count, features }` |
| A029 | ajouter | tool `rule_register` (après `feature_list`) | `index.mjs` | `index.mjs` | Exposer la CRÉATION (`ref` RM-xxxx, `content`, `sourcedPieceId`) via A008 | Tool `rule_register` enregistré |
| A030 | ajouter | tool `rule_update` (après `rule_register`) | `index.mjs` | `index.mjs` | Exposer la MODIFICATION via A009 | Tool `rule_update` enregistré |
| A031 | ajouter | tool `rule_get` (après `rule_update`) | `index.mjs` | `index.mjs` | Exposer la LECTURE détaillée + liens via A010 | Tool `rule_get` enregistré |
| A032 | ajouter | tool `rule_list` (après `rule_get`) | `index.mjs` | `index.mjs` | Exposer la LISTE par projet via A011 | Tool `rule_list` enregistré → `{ count, rules }` |
| A033 | ajouter | tools `feature_rule_link` / `feature_rule_unlink` (après `rule_list`) | `index.mjs` | `index.mjs` | Exposer la liaison fonctionnalité↔règle via A012 | 2 tools enregistrés |
| A034 | ajouter | tools `feature_gherkin_link` / `feature_gherkin_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison fonctionnalité↔**scénario Gherkin existant** (`e2eTestId`) via A013 | 2 tools enregistrés |
| A035 | ajouter | tools `feature_adr_link` / `feature_adr_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison fonctionnalité↔ADR (`adrId`) via A014 | 2 tools enregistrés |
| A036 | ajouter | tools `feature_sprint_link` / `feature_sprint_unlink` | `index.mjs` | `index.mjs` | Exposer le rattachement d'une fonctionnalité émergente à un sprint ultérieur via A015 | 2 tools enregistrés |
| A037 | ajouter | tools `rule_sprint_link` / `rule_sprint_unlink` | `index.mjs` | `index.mjs` | Exposer le rattachement d'une règle émergente à un sprint ultérieur via A016 | 2 tools enregistrés |
| A038 | ajouter | tools `task_sprint_link` / `task_sprint_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison tâche↔sprint via A017 | 2 tools enregistrés |
| A039 | ajouter | tools `task_feature_link` / `task_feature_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison tâche↔fonctionnalité via A018 | 2 tools enregistrés |
| A040 | ajouter | tools `task_adr_propose` / `task_adr_validate` / `task_adr_unlink` / `task_adr_list` | `index.mjs` | `index.mjs` | Exposer le **workflow ADR proposé→validé** via A019 (le tool `propose` est l'action **agent**, `validate` l'action **humaine**) ; `task_adr_list` filtre par statut | 4 tools enregistrés ; description explicite « effectif seulement après validation humaine » |
| A041 | ajouter | tools `recette_sprint_link` / `recette_sprint_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison recette↔sprint via A020 | 2 tools enregistrés |
| A042 | ajouter | tools `recette_feature_link` / `recette_feature_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison recette↔fonctionnalité(s) via A021 | 2 tools enregistrés |
| A043 | ajouter | tools `recette_adr_link` / `recette_adr_unlink` | `index.mjs` | `index.mjs` | Exposer la liaison recette↔ADR(s) via A022 | 2 tools enregistrés |
| A044 | vérifier | `node --check db.mjs index.mjs` + **spawn réel** du MCP (`tools/list` = nouveaux tools présents, **aucun doublon**) + cycle complet (register feature/rule → link rule/gherkin/adr/sprint → task_adr_propose → `task_adr_list(status='propose')` → task_adr_validate → `status='valide'` → recette links) + non-régression (`sprint_get`, `sprint_report`, `adr_*`, `piece_*`, `task_register`) | `db.mjs`, `index.mjs` | — | Garantir l'exposition **sans régression T1-T4** ni ADR/`artifacts`, et le bon état `propose`/`valide` | Rapport de vérification (cycle OK, état ADR tracé, non-régression) |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `db.mjs` | **Modification additive** — DDL `migrate()` (A001) ; nouvelle section « FONCTIONNALITÉS / RÈGLES / LIAISONS » (insérée après `buildSprintReport` l.1205) contenant A002-A022 ; enrichissement de `getRecetteById` (A023). **Aucune** primitive T1-T4 modifiée (`classifyEmergence`, `getSprintDetail`, `buildSprintReport`, `assertAttachablePiece`, `addPiece`, `adr_*` inchangées). |
| `index.mjs` | **Modification additive** — import (A024) ; nouvelle section « FONCTIONNALITÉS / RÈGLES / LIAISONS » après `sprint_attach_pieces` (l.726) avec les tools A025-A043. La famille `sprint_*` (l.596-726) et `adr_*` (l.728+) restent **intactes**. |
| `schema.sql` | **Non modifié (hors périmètre déclaré)** — les tables et liens N:N existent déjà (T1). La seule extension (`task_adr.status` & co) est posée dans `migrate()` (A001), qui s'exécute après `schema.sql` à chaque `ensureSchema()`. Miroir `schema.sql` à prévoir en suivi (cf. §9). |

## 5. Livrables attendus

1. **`db.mjs`** : 4 fonctions CRUD fonctionnalité (`registerFeature`, `updateFeature`, `getFeature`,
   `listFeatures`), 4 fonctions CRUD règle (`registerRule`, `updateRule`, `getRule`, `listRules`),
   22 fonctions de liaison (`link*/unlink*` A012-A022), 4 fonctions workflow ADR
   (`proposeTaskAdr`, `validateTaskAdr`, `unlinkTaskAdr`, `listTaskAdrs`), 2 sérialiseurs (A002/A003),
   colonnes d'état `task_adr` (A001), `getRecetteById` enrichie (A023).
2. **`index.mjs`** : imports (A024) + **8 tools CRUD** (`feature_register/update/get/list`,
   `rule_register/update/get/list`) + **22 tools de liaison** (A033-A043) + **4 tools workflow ADR**
   (A040).
3. **Comportements** :
   - création/lecture/modification de fonctionnalités (`US-xxx`) et règles (`RM-xxxx`) avec **pièce
     source** validée par la garde T2 ;
   - fonctionnalités/règles **émergentes** hors sprint / après clôture (origine tracée), **rattachables**
     à un sprint ultérieur ;
   - liaison fonctionnalité↔règle (N:N), fonctionnalité↔scénario Gherkin **existant**, fonctionnalité↔ADR
     (une ADR garde **≥1 fonctionnalité** via le trigger T1) ;
   - liaison tâche↔sprint/fonctionnalité, recette↔sprint/fonctionnalité(s)/ADR(s) ;
   - **lien ADR d'une tâche** : `propose` (agent) → `valide` (humain) avec traçabilité
     `proposed_by/at`, `validated_by/at`, `reason` ; **aucune** création systématique d'ADR.
4. **Rapport de vérification** (A044).
5. **Aucun** élément de panneau (T7) ni de cardinalité heuristique (T6) ; **aucune** modification du
   modèle ADR/`artifacts`.

## 6. Ordre & dépendances

```
A001 ─────────────────────────────────▶ A019 ─▶ A040
A002 ─▶ A004 ─▶ A005 ─▶ A006 ─▶ A007
A003 ─▶ A008 ─▶ A009 ─▶ A010 ─▶ A011
A004..A011 ─▶ A012..A018 ─▶ A020..A022 ─▶ A023
A024 ─▶ A025..A043
A004..A011 ─▶ A025..A032 ;  A012..A022 ─▶ A033..A043 ;  A019 ─▶ A040
A025..A043 ─▶ A044 ;  A023 ─▶ A044
```

- **A002/A003 avant** A004-A011 (sérialiseurs utilisés par les CRUD).
- **A001 avant A019/A040** (colonnes d'état `task_adr` nécessaires au workflow).
- **A004-A011 avant A012-A022** (les liaisons valident les extrémités via `getFeature`/`getRule`).
- **A019 avant A040** (les tools exposent les fonctions du workflow).
- **A024 avant A025-A043** (les tools consomment les imports).
- **A012-A022 avant A033-A043** (chaque tool appelle sa paire de fonctions).
- **A044 en dernier** (vérification).
- **Parallélisables** : A002↔A003 ; A005↔A007↔A009↔A011 ; A012-A018 indépendantes entre elles ;
  A020-A022 indépendantes ; A025-A043 par paire de liaison après A024.

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------|----------|-----------|
| `feature_register` (Ref US-xxx, rôle, user story, pièce source) | A004 (fonction), A025 (tool) | ✅ |
| `feature_update` | A005, A026 | ✅ |
| `feature_get` | A006, A027 | ✅ |
| `feature_list` | A007, A028 | ✅ |
| `rule_register` (RM-xxxx, contenu, pièce source) | A008, A029 | ✅ |
| `rule_update` | A009, A030 | ✅ |
| `rule_get` | A010, A031 | ✅ |
| `rule_list` | A011, A032 | ✅ |
| Liaison fonctionnalité↔règle (N:N) | A012, A033 | ✅ |
| Liaison fonctionnalité↔scénario Gherkin **existant** (`e2e_tests`) | A013, A034 | ✅ |
| Liaison fonctionnalité↔ADR (N:N, une ADR ≥1 fonctionnalité) | A014, A035 (+ trigger T1) | ✅ |
| Liaison tâche↔sprint | A017, A038 | ✅ |
| Liaison tâche↔fonctionnalité | A018, A039 | ✅ |
| Liaison tâche↔ADR **proposé par l'agent → effectif après validation humaine** | A001 (état), A019 (workflow), A040 (tools) | ✅ |
| Liaison recette↔sprint | A020, A041 (+ lecture A023) | ✅ |
| Liaison recette↔fonctionnalité(s) | A021, A042 (+ lecture A023) | ✅ |
| Liaison recette↔ADR(s) | A022, A043 (+ lecture A023) | ✅ |
| **Émergentes** hors sprint / après clôture (réutiliser `classifyEmergence`) | A004, A008 (`classifyEmergence(pid,{kind:'element'})`) | ✅ |
| Fonctionnalités/règles émergentes **rattachables à un sprint ultérieur** | A015, A016, A036, A037 | ✅ |
| **Pas de création systématique d'ADR** par tâche | A019 (`propose` vers ADR **existante** via `getAdr` ; aucune création d'ADR) | ✅ |
| Réutiliser la garde de pièce (T2) | A004, A008 (`assertAttachablePiece`) | ✅ |
| Ne pas casser le modèle ADR/`artifacts` ni T1-T4 | A001/A023 **additifs** ; aucune primitive T1-T4 modifiée ; A044 | ✅ |
| Hors périmètre : panneau (T7), cardinalités heuristiques (T6) | Périmètre A001-A044 borné à `db.mjs`+`index.mjs` | ✅ |
| Traçabilité (événement, plan, artefact) | Phase 8 (`task_event` `PLANNING_STARTED`/`PLAN_CREATED`, `plan_register`, `artifact_add`) | ✅ |
| Tests E2E Playwright | **NA** — aucun `playwright.config.*` ni spec E2E dans `opencode-mcp-task-orchestrator` ; comportement interne registre/MCP, non observable par parcours Playwright. Aucun `e2e_test_register`/`e2e_test_link` (mention §9) | ✅ (NA) |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** :

- **Aucune étape `supprimer` / `renommer` / `déplacer`** → aucune contradiction de ce type.
- **Élément × fichier** :
  - `db.mjs` : A001 modifie **une** table (`task_adr`, additive) ; A002-A022 créent des fonctions
    **distinctes** ; A023 modifie **un** élément (`getRecetteById`, additif). Pas de collision.
  - `index.mjs` : A024 modifie **l'import** ; A025-A043 ajoutent des **tools distincts** à emplacement
    explicite (après `sprint_attach_pieces` l.726). Aucun tool existant n'est modifié/supprimé.
- **Lecture d'un élément créé par une étape ultérieure** : non.
  - `registerFeature`/`registerRule` (A004/A008) n'utilisent que des primitives T1-T3 (`classifyEmergence`,
    `assertAttachablePiece`, `assertProjectExists`) **antérieures**.
  - Les liaisons (A012-A022) appellent `getFeature`/`getRule` (A006/A010) — créés **avant**.
  - Le workflow ADR (A019) dépend de A001 (colonnes) — **avant**.
  - Les tools (A025-A043) viennent après l'import (A024) et les fonctions.
- **`task_adr`** : A001 **ajoute** des colonnes ; A019 les utilise ; A040 les expose. Aucune étape ne
  supprime/renomme `task_adr` → pas de conflit.
- **`getRecetteById`** : seule A023 la modifie (additif). Aucune autre étape ne la touche.
- **Familles existantes** : `sprint_*` (l.596-726), `adr_*`, `piece_*`, `e2e_*` ne sont **pas** modifiés ;
  A023 lit `recette_*` sans toucher `recette_start`/`recette_item_*`.
- **Gate** : exigences **100 % couvertes** (§7), aucune étape vague (chaque étape cible une fonction/un
  tool précis avec signature, fichier et emplacement) → **Valid**.

**Globale (Phase 9)** : un **seul plan** est produit pour cette tâche (objectifs interdépendants :
les liaisons dépendent des CRUD). Aucune incohérence inter-plans. Frontière inter-tâches respectée :
T1-T4 non modifiés, panneau (T7) et cardinalités heuristiques (T6) non touchés.

## 9. Risques & notes

1. **`schema.sql` non miroité (hors périmètre déclaré)** — A001 pose les colonnes d'état `task_adr` dans
   `migrate()` (db.mjs), exécuté après `schema.sql` à chaque `ensureSchema()` : le runtime est correct.
   Pour éviter une **dérive** entre `schema.sql` (DDL de référence) et le runtime, un **suivi** (tâche
   ultérieure) doit ajouter les mêmes `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dans `schema.sql`.
   Ce plan **ne modifie pas** `schema.sql` (périmètre = `index.mjs` + `db.mjs`).
2. **Default `task_adr.status='propose'`** — un lien inséré hors workflow (ex. legacy) serait `propose`
   (non effectif). Aucun lecteur existant de `task_adr` n'est impacté (vérifié : seul le trigger
   `fonctionnalite_adr` existe, sur une autre table). `proposeTaskAdr` est idempotent et **ne rétrograde
   jamais** un lien déjà `valide`.
3. **Validation humaine** — `validateTaskAdr` est exposé par `task_adr_validate` (action **humaine**) ;
   `proposeTaskAdr` par `task_adr_propose` (action **agent**). Aucune création d'ADR n'est déclenchée :
   si aucune ADR pertinente n'existe, l'agent utilise les tools existants `adr_register` +
   `adr_report_missing` (hors périmètre). « Effectif » = `task_adr.status='valide'`.
4. **Contrainte `ADR ≥1 fonctionnalité`** — `unlinkFeatureAdr` peut échouer avec l'erreur du trigger T1
   (`ADR % doit être rattachée à au moins 1 fonctionnalité`) ; le tool doit **laisser remonter** ce
   message (pas de contournement). `linkFeatureAdr` (INSERT) n'est pas bloqué.
5. **Émergence non rétroactive** — `registerFeature`/`registerRule` classent à la **création** via
   `classifyEmergence` ; aucune re-classification des lignes existantes (ADR-001 §2/§5). Les liens de
   rattachement (A015/A016) n'effacent **pas** le flag `emergent` (traçabilité conservée).
6. **ADR-001 statut `Proposé`** — le modèle n'est pas encore *Accepté* : les étapes restent **additives**
   et n'introduisent aucune garde bloquante nouvelle au-delà du trigger T1 déjà en place.
7. **E2E Playwright : NA** — repo outillage MCP sans `playwright.config.*` ni spec E2E ; le comportement
   est interne (registre + tools MCP). Vérification par `node --check`, spawn réel du MCP (`tools/list`)
   et cycle complet (A044). Aucun `e2e_test_register` / `e2e_test_link`.
8. **Vérification par spawn réel** — l'expérience du repo (hotfix `ARTIFACT_KINDS`) impose un
   `tools/list` + `tools/call` réels, pas seulement `node --check` (A044).
