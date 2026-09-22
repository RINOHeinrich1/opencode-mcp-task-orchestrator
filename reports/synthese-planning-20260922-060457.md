# Synthèse de planification — `T-20260922-060057-febv`

- **Tâche** : Suppression ADR / Fonctionnalités / Règles métier (+ Sprints) — outils MCP manquants + boutons panneau avec confirmation et gardes d'intégrité
- **Projet** : `ecosystem`
- **Exécution** : `E-T-20260922-060057-febv-ldsper` (statut `planning`)
- **Agent** : `atomic-plan` (planner)
- **Date** : 2026-09-22 06:04

---

## 1. Objectifs identifiés (Phase 0 — Goal Analyzer)

Un seul **objectif fonctionnel cohérent et borné** :

> Rendre les entités **Fonctionnalité / Règle métier / Sprint** supprimables via le registre MCP
> (avec gardes d'intégrité) et exposables dans le panneau (bouton + confirmation), tout en
> confirmant que l'**ADR** est déjà supprimable depuis l'UI — sans régression.

**Segmentation retenue : 1 plan** (et non 2). Raison : les objectifs « outils MCP » et « boutons
panneau » sont **interdépendants** (le panneau appelle le MCP ; le bouton ne peut fonctionner sans
l'outil). Conformément à la règle « objectifs dépendants → un plan unique avec section Ordre &
dépendances », les deux couches (2 repos) sont traitées dans **un seul plan** ordonné.

## 2. Plan généré

| PlanId | Objectif | Étapes | Livrables |
|--------|----------|--------|-----------|
| `Plan-suppression-adr-fonctionnalites-regles-sprints-20260922-060417` | Outils MCP `feature_delete` / `rule_delete` / `sprint_delete` (gardes d'intégrité) + boutons panneau (Fonctionnalités, Règles métier, Sprints ; ADR déjà couvert) | 24 (`A001`→`A024`) | `db.mjs`, `index.mjs`, `pilot.mjs`, `server.mjs`, `public/app.js`, rapport de vérification |

- Fichier : `plans/Plan-suppression-adr-fonctionnalites-regles-sprints-20260922-060417.md`
- Artefact : `ART-muc9rxxn-bg5s` (`kind=plan`, `docType=plan`, `contentId=T-20260922-060057-febv`)
- Enregistrement : `plan_register` OK (`taskId=T-20260922-060057-febv`), 24 étapes à `todo`

## 3. Choix de conception (à valider / porter à la recette)

### 3.1 `feature_delete` — garde « ADR ≥ 1 fonctionnalité »
- Pré-check SQL des **ADR qui perdraient leur dernière fonctionnalité** (trigger différé
  `trg_fonctionnalite_adr_min`, `schema.sql:801-823`).
- Refus **explicite** par défaut, message préfixé `[ADR_LAST_FEATURE]` (marqueur stable lu par le
  panneau).
- Option **`cascadeAdrs=true`** : suppression des ADR devenues orphelines **dans la même
  transaction**, AVANT les lignes `fonctionnalite_adr`, pour que le contrôle différé passe au
  COMMIT. Le panneau ne propose cette cascade qu'après un refus (2ᵉ confirmation).
- Liens supprimés en CASCADE (`fonctionnalite_regles`, `fonctionnalite_gherkin`, `fonctionnalite_adr`,
  `sprint_fonctionnalites`, `task_fonctionnalites`, `recette_fonctionnalites`).

### 3.2 `rule_delete`
- Aucun invariant métier → suppression directe + liens CASCADE (`fonctionnalite_regles`,
  `sprint_regles`).

### 3.3 `sprint_delete` — périmètre retenu
- **REFUS DUR** du **sprint par défaut** (`is_default=1`, ancre des migrations / « ancien sprint »).
- **REFUS DUR** si des **tâches** (`task_sprints`) ou **recettes** (`recette_sprints`) sont
  rattachées → message explicite + action de détachement (`task_sprint_unlink` /
  `recette_sprint_unlink`). Pas de flag `force` (choix : sécurité > souplesse).
- **AUTORISÉ** sinon : détache `sprint_fonctionnalites` / `sprint_regles` / `sprint_pieces` (les
  entités restent au projet), `migrations.sprint_id` → `NULL` (SET NULL), et supprime les signaux de
  cardinalité `open` du sprint (évite un signal orphelin).

### 3.4 ADR — écart de constat (important)
La demande indique que l'onglet ADR n'a **aucune** action de suppression. Le code montre le
**contraire** : bouton `data-adr-del` (`public/app.js:4524`), câblage avec `confirm('Supprimer cette
ADR ?')` + `alert` d'erreur (`app.js:4574-4578`), route `DELETE /api/docs/:id`
(`server.mjs:1723`), tool `doc_delete` (`index.mjs:507`) → `deleteDoc` (`db.mjs:4570`).
**Aucun code ADR n'est ajouté** ; l'étape `A020` acte ce constat (vérification). Si l'orchestrateur
souhaite malgré tout un renforcement ADR, il devra le préciser (hors périmètre).

## 4. Vérifications de cohérence

### Intra-plan (Phases 6-7) — **VALIDE**
- Regroupement par élément cible : 3 zones distinctes dans `db.mjs`, 4 dans `index.mjs`, 3 dans
  `pilot.mjs`, 3 branches dans `server.mjs`, 3 couples rendu/câblage indépendants dans `app.js`.
- Aucune contradiction (`supprimer` + autre action sur le même élément, `créer` + `renommer`,
  lecture d'un élément créé par une étape ultérieure).
- Graphe de dépendances strictement ordonné (DAG) : MCP → ponts → routes → UI → vérifications.
- Couverture des exigences : **100 %** (table §8 du plan).

### Globale (Phase 9) — **AUCUNE INCOHÉRENCE**
- **Un seul plan** généré → pas de conflit inter-plans possible.
- Aucun recouvrement de fichier avec un autre plan de la même tâche (aucun autre plan).

## 5. Tests E2E Playwright

**E2E : NA.** `e2e_list(project="ecosystem")` = 0 test ; aucun `playwright.config.*` /
`tests/e2e/**` dans les deux repos (seuls des *runs* importés existent sous `storage/e2e/runs/`).
Aucune entité E2E créée / liée. Vérification par `node --check`, spawn MCP réel et parcours panneau
sur instance de TEST (`PORT=4010`).

## 6. Risques & notes

1. **Trigger différé** : sans pré-check, l'erreur brute `ADR … doit être rattachée à au moins 1
   fonctionnalité` remonterait au COMMIT (message peu exploitable) → le pré-check + `cascadeAdrs`
   sont essentiels.
2. **`sprint_delete` strict** (pas de `force`) : détachement des tâches/recettes via les tools
   `*_unlink` existants.
3. **Signaux de cardinalité** : seul `sprint` peut en porter un `open` parmi les entités
   supprimées ; `doc_delete` (ADR) ne les nettoie pas — comportement préexistant, hors périmètre.
4. **Isolation Git (norme v1.0)** : branche dédiée par repo via session-guard ; **ne pas** laisser
   les checkouts principaux (`/root/orchestrator-panel`, `/root/.config/opencode/mcp/task-orchestrator`)
   sur une branche de travail en fin d'exécution.
5. **Aucun changement de schéma** : toutes les tables/FK nécessaires existent déjà.

## 7. Traçabilité

- `task_event` : `PLANNING_STARTED` puis `PLAN_CREATED` (`by=atomic-plan`).
- `participant_add` : `atomic-plan` (rôle `planner`).
- `plan_register` : `Plan-suppression-adr-fonctionnalites-regles-sprints-20260922-060417`
  (`taskId=T-20260922-060057-febv`, 24 étapes `todo`).
- `artifact_add` : `ART-muc9rxxn-bg5s` (`kind=plan`).
- Aucun email envoyé par l'agent (notifications dérivées par `opencode-notifier`).
