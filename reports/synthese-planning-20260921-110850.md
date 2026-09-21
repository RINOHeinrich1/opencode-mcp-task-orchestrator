# Synthèse de planification — T-20260921-091736-yqwv

- **Tâche** : `T-20260921-091736-yqwv` (exécution `E-T-20260921-091736-yqwv-heumu4`) — tâche 7/9 du batch `BATCH-mub1809u-06ow`
- **Projet** : `ecosystem` — repo `opencode-observability` → `/root/orchestrator-panel`
- **Recette source** : `RECT-muaz100k-2iq0`
- **Agent** : `atomic-plan`
- **Date** : 2026-09-21 11:09
- **Statut** : planification **terminée** (1 plan, Valid)

---

## 1. Objectifs détectés

La demande porte sur 5 surfaces fonctionnelles **interdépendantes** du panneau :

1. Sprints (liste par projet, création à durée paramétrable, CLÔTURER / REPRENDRE, rattachement des pièces client) ;
2. Rapport de sprint téléchargeable (export registre via `sprint_report`) ;
3. Onglet « Fonctionnalités / Règles métier » (table Ref/rôle/user story, règles, liens règle/Gherkin/ADR, rattachements sprint/tâches/recettes, CRUD) ;
4. Vue des éléments émergents par projet (vues `cardinalityView`/`cardinality_report`) ;
5. Onglet « Artefacts » montrant les pièces client par projet avec leur nature.

**Segmentation retenue : un plan unique.** Ces objectifs partagent le même registre d'onglets
(`PROJECT_TABS`/`RENDER`), la même chaîne de routes (`server.mjs`) et les mêmes wrappers
(`pilot.mjs`) ; le rapport est attaché à une ligne de sprint et la vue des émergents découle de la
clôture de sprint. Les scinder produirait des conflits inter-plans sur des régions de fichiers
identiques → **1 plan séquencé**.

---

## 2. Plans produits

| PlanId | Objectif | Étapes | Fichier |
|---|---|---|---|
| `Plan-panneau-sprints-fonctionnalites-emergents-20260921-110850` | Exposer sprints + rapport de sprint + onglet Fonctionnalités/Règles métier + vue émergents + pièces dans Artefacts | A001→A013 (13) | `plans/Plan-panneau-sprints-fonctionnalites-emergents-20260921-110850.md` |

### Étapes (résumé)

- **A001** `pilot.mjs` — wrappers sprint (`listSprints`, `getSprintDetail`, `createSprint`, `closeSprint`, `reopenSprint`, `attachSprintPieces`, `sprintReport`)
- **A002** `pilot.mjs` — wrappers CRUD fonctionnalités/règles
- **A003** `pilot.mjs` — dispatcher de liens N:N (`linkEntities`/`unlinkEntities`, 9 relations)
- **A004** `pilot.mjs` — wrappers cardinalité (`cardinalityReport`, `listCardinalitySignals`, `resolveCardinalitySignal`)
- **A005** `server.mjs` — routes `/api/sprints*` + rapport téléchargeable
- **A006** `server.mjs` — routes `/api/features*`, `/api/rules*`, `/api/links*`
- **A007** `server.mjs` — routes `/api/cardinality*`
- **A008** `public/app.js` — `PROJECT_TABS` + `RENDER` (3 nouveaux onglets)
- **A009** `public/app.js` — onglet Sprints (liste, création durée paramétrable, CLÔTURER/REPRENDRE, pièces)
- **A010** `public/app.js` — rapport de sprint (affichage + téléchargement)
- **A011** `public/app.js` — onglet Fonctionnalités / Règles métier
- **A012** `public/app.js` — onglet Émergents
- **A013** `public/app.js` — onglet Artefacts (pièces client + nature)

---

## 3. Vérifications de cohérence

### Intra-plan (Phases 5-7)

- **Couverture** : 100 % des exigences de la tâche couvertes (table §7 du plan) — ✅.
- **Contradictions** : aucune. Les 4 étapes `pilot.mjs` et les 3 étapes `server.mjs` sont des
  **insertions additives contiguës** dans des blocs distincts (préfixes d'URL disjoints) ; une seule
  étape touche `PROJECT_TABS`/`RENDER` (A008) ; une seule touche `DOC_TYPE_LIST`/`artRow` (A013).
  Aucun couple `supprimer` + autre action sur un même élément ; aucune étape ne dépend d'une étape
  ultérieure (hoisting des déclarations de fonctions JS).
- **Plan Validator** : **Valid**.

### Globale inter-plans (Phase 9)

- Plan **unique** pour cette tâche → aucun conflit inter-plans.
- Le plan de T6 (`Plan-cardinalites-emergence-*`) porte sur le repo MCP (`db.mjs`/`index.mjs`) —
  **périmètre disjoint** du présent plan (repo panneau `opencode-observability`).
- **Aucune incohérence globale** détectée → aucune escalade nécessaire.

---

## 4. Traçabilité

- `task_event(T-20260921-091736-yqwv, PLANNING_STARTED, by=atomic-plan)`
- `plan_register(taskId=T-20260921-091736-yqwv, planId=Plan-panneau-sprints-fonctionnalites-emergents-20260921-110850, steps=A001..A013)`
- `participant_add(taskId, agent=atomic-plan, role=planner)`
- `task_event(T-20260921-091736-yqwv, PLAN_CREATED, planId=…)`
- `artifact_add(taskId, kind=plan, docType=plan, artifactId=ART-mub57pwk-dcxu)`
- `artifact_add(taskId, kind=report, docType=task_report, path=reports/synthese-planning-20260921-110850.md)` (cette synthèse)

---

## 5. Tests E2E Playwright — analyse d'impact

**E2E NA.** Le repo panneau ne contient **aucun harnais Playwright** (pas de `playwright.config.*`,
aucun `*.spec.ts` hors `node_modules`) et `e2e_list(project=ecosystem)` renvoie **0 test** ;
`opencode-observability` n'a pas de `e2eRepoDir` configuré. Aucune création « en aveugle » d'entité
E2E sans spec file réel.

**Stratégie documentée** (à exécuter lorsqu'un harnais sera ajouté au repo panneau, via
`e2e_test_register` projet `ecosystem`, repo source `opencode-observability`) :

| Scénario | Classification | Raison |
|---|---|---|
| Créer un sprint à durée paramétrable, le clôturer, le reprendre | create | Parcours sprint nominal (objectif 1) |
| Télécharger le rapport de sprint après clôture | create | Livrable rapport (objectif 2) |
| Vérifier l'apparition d'un élément émergent après clôture de sprint | create | Garde d'émergence (objectifs 1+4) |
| CRUD fonctionnalité + liens règle/Gherkin/ADR | create | Onglet Fonctionnalités/Règles (objectif 3) |
| Onglets ADR / Artefacts / Tâches existants | keep | Non-régression |

---

## 6. Risques notables

1. `pilot.mjs` spawn un process MCP par appel (timeout 30 s) — borner les `limit` des listes.
2. `public/style.css` **hors périmètre** → réutiliser les classes existantes + styles inline.
3. L'émergence n'est **jamais recalculée** côté panneau : affichage de l'état renvoyé par le registre.
4. Le rapport de sprint est **généré côté registre** ; le panneau ne fait qu'afficher/télécharger.
