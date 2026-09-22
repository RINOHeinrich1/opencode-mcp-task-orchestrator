# Plan — Suppression ADR / Fonctionnalités / Règles métier / Sprints (outils MCP manquants + boutons panneau)

- **taskId** : `T-20260922-060057-febv`
- **executionId** : `E-T-20260922-060057-febv-ldsper`
- **projet** : `ecosystem`
- **repos** : `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`) · `opencode-observability` (`/root/orchestrator-panel`)
- **branches** : `feature/migration-postgresql` (état propre au moment de la planification)
- **date** : 2026-09-22 06:04

---

## 1. Objectif

Permettre la **suppression** d'une Fonctionnalité, d'une Règle métier, d'un Sprint (MCP, avec gardes
d'intégrité) et de ces entités **plus l'ADR** depuis le panneau (bouton + confirmation), avec
**messages d'erreur explicites** en cas de refus, sans dégrader les CRUD/filtres/index/performance
existants.

---

## 2. Contexte & raison d'être

**Constat ancré dans le code (lecture seule) :**

- **ADR — DÉJÀ FAIT.** L'outil MCP `doc_delete` (`index.mjs:507`) → `deleteDoc()` (`db.mjs:4570`,
  `DOCS_DOC_TYPES` `db.mjs:4352`) existe ; la route `DELETE /api/docs/:id` existe
  (`server.mjs:1723`) ; le bouton `data-${prefix}-del` (« Supprimer ») est rendu par
  `adrTableHtml` (`public/app.js:4524`) et câblé par `bindAdrTable` (`public/app.js:4574-4578`,
  `confirm('Supprimer cette ADR ?')` + `alert('Suppression impossible : …')`). L'onglet ADR est un
  onglet de projet (`PROJECT_TABS` `app.js:126`) rendu par `renderAdrs` (`app.js:4637`) qui utilise
  bien `adrTableHtml` + `bindAdrTable`. **→ la demande « bouton Supprimer dans l'onglet ADR » est
  déjà satisfaite ; le plan la traite en VÉRIFICATION (A020), pas en création.**
  Le trigger différé `fn_fonctionnalite_adr_min` **n'empêche pas** `doc_delete` d'une ADR liée à des
  fonctionnalités : `fonctionnalite_adr.adr_id` est `ON DELETE CASCADE` et le contrôle différé voit
  l'ADR déjà supprimée au COMMIT (`schema.sql:793-823`).

- **Fonctionnalité — MANQUANT.** Aucune fonction `deleteFeature` (`db.mjs`) ni tool `feature_delete`
  (`index.mjs` : `feature_register/update/mark_implemented/get/list` seulement).
- **Règle métier — MANQUANT.** Aucune `deleteRule` / `rule_delete`.
- **Sprint — MANQUANT.** Aucune `deleteSprint` / `sprint_delete`.

**Modèle de données (FK `ON DELETE CASCADE`, vérifié `schema.sql:779-886`) :**

- `fonctionnalites` ← `fonctionnalite_regles`, `fonctionnalite_gherkin`, `fonctionnalite_adr`,
  `sprint_fonctionnalites`, `task_fonctionnalites`, `recette_fonctionnalites`.
- `regles_metier` ← `fonctionnalite_regles`, `sprint_regles`.
- `sprints` ← `sprint_fonctionnalites`, `sprint_regles`, `sprint_pieces`, `task_sprints`,
  `recette_sprints` ; `migrations.sprint_id REFERENCES sprints(id) ON DELETE SET NULL`
  (`schema.sql:912`).
- `cardinality_signals` n'a **aucune FK** (`entity_type`/`entity_id` génériques, `db.mjs:706-726`) :
  un signal `open` sur un sprint supprimé deviendrait orphelin.

**Invariant métier à respecter** : `fn_fonctionnalite_adr_min` + `CREATE CONSTRAINT TRIGGER
trg_fonctionnalite_adr_min … DEFERRABLE INITIALLY DEFERRED` (`schema.sql:801-823`) :
`RAISE EXCEPTION 'ADR % doit être rattachée à au moins 1 fonctionnalité'` si une ADR **existante**
perd sa **dernière** fonctionnalité.

**Tâche liée** : `T-20260921-145025-meiv` (liaison `emergent` — même session, même zone de code
panneau/MCP, même auteur de la demande). Conventions reprises : champ/tool **additif**, **0 N+1**,
`node --check` sur les 5 fichiers, **spawn MCP réel**, vérification panneau sur instance de TEST
`PORT=4010`. `adr_list(projectId="ecosystem")` = **0 ADR** → aucune ADR de référence à citer.

---

## 3. Décisions de conception (gardes d'intégrité & périmètre `sprint_delete`)

### 3.1 `feature_delete(featureId, cascadeAdrs=false)`

- **Garde** : avant suppression, on calcule les **ADR qui perdraient leur dernière fonctionnalité** :

  ```sql
  SELECT fa.adr_id FROM fonctionnalite_adr fa
   WHERE fa.fonctionnalite_id = $1
     AND EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id = fa.adr_id)
     AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr x
                      WHERE x.adr_id = fa.adr_id AND x.fonctionnalite_id <> $1)
  ```

- Si non vide et `cascadeAdrs !== true` → **refus explicite** (message préfixé `[ADR_LAST_FEATURE]`,
  marqueur stable lu par le panneau) : rattacher une autre fonctionnalité, supprimer l'ADR
  (`doc_delete`), ou relancer avec `cascadeAdrs=true`.
- Si `cascadeAdrs=true` → **dans la MÊME transaction**, supprimer d'abord ces ADR
  (`DELETE artifacts WHERE content_id=$1 AND doc_type='adr_file'` puis
  `DELETE artifacts WHERE artifact_id=$1 AND doc_type=ANY(DOCS_DOC_TYPES)`, miroir de `deleteDoc`)
  **avant** les lignes `fonctionnalite_adr` : au COMMIT le trigger différé ne voit plus l'ADR → OK.
- Suppression explicite des 6 tables de liens + `DELETE FROM fonctionnalites` (les FK CASCADE sont le
  filet de sécurité). Retourne `{ featureId, deleted:true, cascadedAdrs:[…] }`.

### 3.2 `rule_delete(ruleId)`

- Aucun invariant. Transaction : `fonctionnalite_regles`, `sprint_regles`, puis `regles_metier`.
  Retourne `{ ruleId, deleted:true }`.

### 3.3 `sprint_delete(sprintId)` — périmètre retenu

- **REFUS DUR** (pas de flag `force`) du **sprint par défaut** (`is_default=1`) : c'est l'ancre des
  migrations / de « l'ancien sprint » (`ensureDefaultSprint`, `migrations.sprint_id`). Message
  explicite.
- **REFUS DUR** si des **tâches** (`task_sprints`) ou **recettes** (`recette_sprints`) sont
  rattachées : message explicite avec les compteurs et l'action de détachement
  (`task_sprint_unlink` / `recette_sprint_unlink`). On ne détache pas silencieusement (perte de
  traçabilité).
- **AUTORISÉ** sinon : les liens `sprint_fonctionnalites` / `sprint_regles` / `sprint_pieces` sont
  **détachés** (CASCADE : les fonctionnalités/règles/pièces restent au projet), `migrations.sprint_id`
  passe à `NULL` (SET NULL), et les **signaux de cardinalité `open`** du sprint sont supprimés
  (évite un signal orphelin). Retourne `{ sprintId, deleted:true, detached:{fonctionnalites,regles,pieces} }`.

---

## 4. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | créer | `deleteFeature(featureId,{cascadeAdrs,by})` (après `getFeature`, ~l.2008) | `db.mjs` | `db.mjs` | outil MCP manquant + garde invariant ADR | fonction exportée, pré-check ADR orphelines + transaction |
| A002 | créer | `deleteRule(ruleId)` (après `getRule`, ~l.2241) | `db.mjs` | `db.mjs` | outil MCP manquant | fonction exportée, transaction + liens CASCADE |
| A003 | créer | `deleteSprint(sprintId)` (après `getSprintDetail`, ~l.960) | `db.mjs` | `db.mjs` | outil MCP manquant + gardes | fonction exportée (refus défaut/tâches/recettes) |
| A004 | ajouter | imports `deleteFeature`, `deleteRule`, `deleteSprint` (bloc T5/sprint, l.143-182) | `index.mjs` | `index.mjs` | rendre les fonctions accessibles aux tools | 3 imports ajoutés |
| A005 | créer | tool `feature_delete` (après `feature_list`, l.989) | `index.mjs` | `index.mjs` | exposer `feature_delete` | tool enregistré (`featureId`, `cascadeAdrs?`, `by?`) |
| A006 | créer | tool `rule_delete` (après `rule_list`, l.1067) | `index.mjs` | `index.mjs` | exposer `rule_delete` | tool enregistré (`ruleId`) |
| A007 | créer | tool `sprint_delete` (après `sprint_attach_pieces`, l.792) | `index.mjs` | `index.mjs` | exposer `sprint_delete` | tool enregistré (`sprintId`) |
| A008 | créer | `deleteFeature(args)` (après `updateFeature`, ~l.837) | `pilot.mjs` | `pilot.mjs` | pont panneau→MCP | wrapper `taskOrchestrator("feature_delete", …)` |
| A009 | créer | `deleteRule(args)` (après `updateRule`, ~l.881) | `pilot.mjs` | `pilot.mjs` | pont panneau→MCP | wrapper `taskOrchestrator("rule_delete", …)` |
| A010 | créer | `deleteSprint(args)` (après `attachSprintPieces`, ~l.744) | `pilot.mjs` | `pilot.mjs` | pont panneau→MCP | wrapper `taskOrchestrator("sprint_delete", …)` |
| A011 | ajouter | branche `featureMatch && req.method === "DELETE"` (après le PUT, l.2026) | `server.mjs` | `server.mjs` | route HTTP de suppression | `DELETE /api/features/:id?cascadeAdrs=1` → `pilot.deleteFeature` ; 409 si `[ADR_LAST_FEATURE]` |
| A012 | ajouter | branche `ruleMatch && req.method === "DELETE"` (après le PUT, l.2069) | `server.mjs` | `server.mjs` | route HTTP | `DELETE /api/rules/:id` → `pilot.deleteRule` |
| A013 | ajouter | branche `sprintGetMatch && req.method === "DELETE"` (après le GET, l.1855) | `server.mjs` | `server.mjs` | route HTTP | `DELETE /api/sprints/:id` → `pilot.deleteSprint` |
| A014 | ajouter | bouton `data-fr-del` dans la cellule Actions de `frFeatureTableHtml` (l.5351) | `public/app.js` | `public/app.js` | suppression depuis le sous-onglet Fonctionnalités | bouton « Supprimer » rendu |
| A015 | modifier | `wireRows()` de `renderFrFeaturePanel` (l.5423-5428) | `public/app.js` | `public/app.js` | câbler la suppression | handler : confirm → DELETE → `renderFeaturesRules()` ; refus `ADR_LAST_FEATURE` → 2ᵉ confirm (cascade) |
| A016 | ajouter | bouton `data-rule-del` dans la cellule Actions de `frRuleTableHtml` (l.5373) | `public/app.js` | `public/app.js` | suppression depuis le sous-onglet Règles métier | bouton « Supprimer » rendu |
| A017 | modifier | `wireRows()` de `renderFrRulePanel` (l.5492-5497) | `public/app.js` | `public/app.js` | câbler la suppression | handler : confirm → DELETE → `renderFeaturesRules()` |
| A018 | ajouter | bouton `data-sp-del` dans la cellule Actions de `renderSprints` (l.4803-4811) | `public/app.js` | `public/app.js` | suppression depuis l'onglet Sprints | bouton rendu **uniquement si `!s.isDefault`** |
| A019 | modifier | câblage de `renderSprints` (l.4842-4859) | `public/app.js` | `public/app.js` | câbler la suppression | handler : confirm → DELETE → `renderSprints()` + `alert` du refus explicite |
| A020 | vérifier | `bindAdrTable` `[data-adr-del]` + route `docDelMatch` + `doc_delete` | `public/app.js`, `server.mjs`, `index.mjs` | — | la suppression ADR existe déjà | constat écrit : bouton + confirmation + erreur explicite déjà présents (aucun code) |
| A021 | vérifier | `node --check` sur `db.mjs`, `index.mjs`, `pilot.mjs`, `server.mjs`, `public/app.js` | — | — | non-régression syntaxique | 5 fichiers OK |
| A022 | vérifier | spawn MCP réel : cycle de test (créer → supprimer → vérifier) puis nettoyage | — | — | prouver les tools + gardes + cascades | preuve d'appel réelle sur données de test nettoyées |
| A023 | vérifier | intégration panneau sur instance de TEST (`PORT=4010`) | — | — | prouver les boutons/refus/rafraîchissement | parcours vérifié (boutons, confirm, refus, refresh) |
| A024 | créer | rapport de vérification | — | `reports/report-suppression-adr-fr-sprints-<ts>.md` | traçabilité | rapport (preuves A020-A023) |

---

## 5. Fichiers concernés

| Fichier | Repo | Type de modification |
|---------|------|----------------------|
| `db.mjs` | opencode-mcp-task-orchestrator | modification (3 fonctions `delete*`) |
| `index.mjs` | opencode-mcp-task-orchestrator | modification (3 imports + 3 tools) |
| `pilot.mjs` | opencode-observability | modification (3 wrappers) |
| `server.mjs` | opencode-observability | modification (3 routes DELETE) |
| `public/app.js` | opencode-observability | modification (3 boutons + 3 câblages) |
| `reports/report-suppression-adr-fr-sprints-<ts>.md` | opencode-mcp-task-orchestrator | création (rapport) |

**Aucun changement de schéma** : toutes les tables/FK nécessaires existent (`schema.sql`, `migrate()`).

---

## 6. Livrables attendus

1. `db.mjs` : `deleteFeature` (garde `[ADR_LAST_FEATURE]` + `cascadeAdrs`), `deleteRule`, `deleteSprint`
   (refus sprint par défaut / tâches / recettes).
2. `index.mjs` : tools MCP `feature_delete`, `rule_delete`, `sprint_delete` (+ imports).
3. `pilot.mjs` : `deleteFeature` / `deleteRule` / `deleteSprint` (pont panneau → MCP).
4. `server.mjs` : `DELETE /api/features/:id?cascadeAdrs=1`, `DELETE /api/rules/:id`,
   `DELETE /api/sprints/:id`.
5. `public/app.js` : boutons « Supprimer » (confirmation obligatoire) dans le sous-onglet
   Fonctionnalités, le sous-onglet Règles métier et l'onglet Sprints, rafraîchissement après
   suppression, messages d'erreur explicites.
6. Constat écrit : la suppression ADR du panneau **existe déjà** (A020).
7. Rapport de vérification + preuves (`node --check`, spawn MCP réel, parcours panneau TEST).

---

## 7. Ordre & dépendances

```
A001 ┐
A002 ├─→ A004 ─→ A005 ─→ A008 ─→ A011 ─→ A014 ─→ A015 ┐
A003 ┘          ├─→ A006 ─→ A009 ─→ A012 ─→ A016 ─→ A017 ┼─→ A020 → A021 → A022 → A023 → A024
                └─→ A007 ─→ A010 ─→ A013 ─→ A018 ─→ A019 ┘
```

- A001, A002, A003 sont **parallélisables** (3 fonctions distinctes dans `db.mjs`).
- A004 (imports) est un **prérequis** de A005/A006/A007.
- A008/A009/A010 (ponts) dépendent des tools ; A011/A012/A013 (routes) des ponts ;
  A015/A017/A019 (câblage) des boutons (A014/A016/A018) **et** des routes.
- A020-A024 (vérifications) sont **après** toutes les actions.
- **Prérequis externes** : aucun (aucune migration, aucune ADR).

---

## 8. Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|----------|----------|-----------|
| MCP `feature_delete` + liens CASCADE | A001, A005 | oui |
| Garde « ADR ≥ 1 fonctionnalité » avec erreur explicite | A001, A005, A011, A015 | oui |
| MCP `rule_delete` + liens CASCADE | A002, A006 | oui |
| MCP `sprint_delete` (refus sprint par défaut / tâches / recettes) | A003, A007 | oui |
| Panneau — bouton Supprimer onglet **ADR** (via `doc_delete`) | A020 (déjà présent — vérification) | oui |
| Panneau — bouton Supprimer **Fonctionnalités** + confirmation | A014, A015 | oui |
| Panneau — bouton Supprimer **Règles métier** + confirmation | A016, A017 | oui |
| Panneau — bouton Supprimer **Sprints** + confirmation | A018, A019 | oui |
| Confirmation obligatoire + pas d'état incohérent | A015, A017, A019, A020 | oui |
| Refus explicites (invariant ADR, sprint défaut, entités rattachées) | A001, A003, A011, A015, A019 | oui |
| ADR via `doc_delete` sans régression (pièces jointes `adr_file`, liens) | A020 | oui |
| Non-régression CRUD/filtres/index/performance | A021, A022, A023 | oui |
| `node --check` OK + spawn MCP réel OK | A021, A022 | oui |

---

## 9. Vérification de cohérence (Phases 6-7)

**Regroupement par élément cible :**

- `db.mjs` : A001 (`deleteFeature`, zone ~l.2008), A002 (`deleteRule`, zone ~l.2241), A003
  (`deleteSprint`, zone ~l.960) → **3 zones distinctes, aucune interaction**.
- `index.mjs` : A004 (imports), A005 (l.989), A006 (l.1067), A007 (l.792) → zones distinctes.
- `pilot.mjs` : A008, A009, A010 → 3 fonctions distinctes.
- `server.mjs` : A011 (l.2026), A012 (l.2069), A013 (l.1855) → 3 branches distinctes.
- `public/app.js` : A014 (rendu feature), A015 (câblage feature), A016 (rendu règle),
  A017 (câblage règle), A018 (rendu sprint), A019 (câblage sprint) → 3 couples rendu/câblage
  **indépendants**.

**Contradictions recherchées :**

- `supprimer` + autre action sur le même élément ? **Non** — chaque fonction/route/bouton est créé ou
  câblé une seule fois.
- `créer` + `renommer` sur un même élément ? **Non**.
- Étape lisant un élément créé par une étape **ultérieure** ? **Non** — le graphe §7 est un DAG
  strictement ordonné (MCP → ponts → routes → UI → vérifications).
- Cohérence interne des gardes : A003 refuse le sprint par défaut ; A018 **ne rend pas** le bouton
  pour `isDefault` → cohérent. A001 refuse par défaut et n'accepte la cascade que sur opt-in
  explicite (`cascadeAdrs=true`) ; A015 ne propose la cascade qu'après un refus `[ADR_LAST_FEATURE]`
  → cohérent, aucune suppression silencieuse d'ADR.

**Résultat : VALID** (aucune contradiction, aucune exigence non couverte, aucune étape vague).

---

## 10. Tests E2E Playwright — analyse d'impact

**E2E : NA.** `e2e_list(project="ecosystem")` = **0 test** ; aucun `playwright.config.*` ni
`tests/e2e/**` dans `opencode-mcp-task-orchestrator` ni dans `opencode-observability` (les seuls
artefacts Playwright présents sont des *runs* importés sous `storage/e2e/runs/`). La tâche liée
`T-20260921-145025-meiv` a également conclu « E2E : NA ». **Aucun `e2e_test_register` / lien E2E ne
sera créé.** La vérification fonctionnelle repose sur A021-A023 (syntaxe, spawn MCP réel, parcours
panneau sur instance de TEST).

---

## 11. Risques & notes

- **Écart de constat à remonter** : la demande affirme que l'onglet ADR n'a **aucune** action de
  suppression ; le code montre le contraire (bouton + route + tool + confirmation déjà présents,
  `app.js:4524/4574`, `server.mjs:1723`, `index.mjs:507`). A020 acte ce constat ; **aucun code ADR
  n'est ajouté** (éviter un doublon). Si l'orchestrateur veut malgré tout un renforcement ADR, il
  faudra le préciser (hors périmètre de ce plan).
- **Trigger différé** : le pré-check A001 est indispensable — sans lui, l'erreur brute
  `ADR … doit être rattachée à au moins 1 fonctionnalité` remonterait au **COMMIT** (message peu
  exploitable). Le `cascadeAdrs` supprime les ADR **avant** les liens pour que le contrôle différé
  passe.
- **`sprint_delete`** : suppression volontairement **stricte** (pas de `force`). Le détachement des
  tâches/recettes se fait via les tools existants `task_sprint_unlink` / `recette_sprint_unlink`.
- **Signaux de cardinalité** : seul `sprint` peut porter un signal `open` parmi les entités
  supprimées (`CARDINALITY_ENTITY_TYPES`, `db.mjs:2592`) ; A003 les nettoie. `doc_delete` (ADR) ne les
  nettoie pas — comportement **préexistant**, hors périmètre.
- **Isolation Git (norme v1.0)** : chaque repo doit être travaillé sur une **branche dédiée** via
  session-guard ; **ne jamais** laisser le checkout principal `/root/orchestrator-panel` (ni
  `/root/.config/opencode/mcp/task-orchestrator`) sur une branche de travail en fin d'exécution.
- **Périmètre des fichiers** : limité aux 5 fichiers listés §5 (conformes au `scope` de la tâche).
- **Non-régression perf** : aucune requête supplémentaire par entité n'est introduite dans les listes
  (`feature_list`/`rule_list`/`sprint_list`/`doc_list` inchangés) ; les seules requêtes ajoutées sont
  celles des suppressions (à la demande).
