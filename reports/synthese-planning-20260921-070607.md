# Synthèse de planification — 2026-09-21 07:06:07

- **Tâche** : `T-20260921-065829-xa46` (executionId `E-T-20260921-065829-xa46-091kez`)
- **Projet** : `ecosystem` — repo `opencode-observability` (`/root/orchestrator-panel`, branche `feature/migration-postgresql`)
- **Demandeur** : Rino (correction de périmètre)
- **Agent** : `atomic-plan` (rôle planner)

## 1. Objectifs identifiés (Phase 0)

| # | Objectif | Nature | Plan |
|---|----------|--------|------|
| 1 | Faire de l'ADR un **onglet À L'INTÉRIEUR DU PROJET** (`PROJECT_TABS` uniquement), retirer l'onglet ADR interne au `projectDetailModal`, mutualiser rendu/câblage | Bounded, non interdépendant (objectif unique) | `Plan-onglet-adr-projet-20260921-070532` |

Un seul objectif → **un seul plan**. Aucune ambiguïté de segmentation.

## 2. Plans produits

| Plan ID | Fichier | Étapes | Statut |
|---------|---------|--------|--------|
| `Plan-onglet-adr-projet-20260921-070532` | `plans/Plan-onglet-adr-projet-20260921-070532.md` | A001–A011 (11) | Enregistré (Plan Manager + `artifact_add` kind=plan) |

**Plan remplacé** : `Plan-onglet-adr-premier-niveau-20260921-070023` — périmètre erroné (ajoutait l'ADR à
`GLOBAL_TABS` **et** `PROJECT_TABS`). Le nouveau plan **supprime** toute action sur `GLOBAL_TABS`.

## 3. Résumé du plan (correction de périmètre)

- **`PROJECT_TABS` uniquement** (A002) : entrée `['adr', 'ADR']` ajoutée après `['artifacts', 'Artefacts']` (l.105).
- **`GLOBAL_TABS` (l.88-94) : AUCUNE modification** — contrainte explicite (A002 = non-action documentée, §7 du plan).
- **Rendu dédié** `renderAdrs` (A008) + enregistrement `adr: renderAdrs` dans `RENDER` (A009) ; pane `#pane-adr` créé dynamiquement (A001, `index.html` hors périmètre).
- **Table du projet courant** (A004) : Titre / Statut / Contexte / Décision / Conséquences / **Repos rattachés (+ badge « globale »)** / Pièces jointes / Actions.
- **Filtres** statut/repo + **recherche** (A004, A005, A008) — le projet est le contexte, donc pas de filtre projet.
- **CRUD + pièces jointes** (A003, A005, A008) via l'API existante ; réemploi de `adrFormModal`, `adrAttachmentModal`, `viewRefDoc`.
- **Mutualisation** (A004 `adrTableHtml` + A005 `bindAdrTable`) : rendu et câblage uniques, pas de duplication.
- **Retrait de l'onglet ADR interne au `projectDetailModal`** (A006 : entrée d'onglet l.3933 + branche de rendu l.3951 + variables mortes l.3918/3928 ; A007 : bloc de câblage `wire()` l.4167-4199).
- **`server.mjs` : aucune modification** (API `/api/docs…`, `/api/docs/:id/attachments…`, `/api/repos?project`, `/api/projects` déjà complètes).

## 4. Vérifications de cohérence

### 4.1 Intra-plan (Phases 6–7) — `Plan-onglet-adr-projet-20260921-070532`

- **Contradictions** : aucune. `adrTabHtml` → A004 (renommer/refondre la définition) + A006 (supprimer le site d'appel) = actions complémentaires. `projectDetailModal` : A006 (onglet/rendu) et A007 (câblage) ciblent des éléments distincts. `PROJECT_TABS` : un seul `ajouter` ; `GLOBAL_TABS` : aucune action.
- **Ordre/dépendances** : A004 → A006 (évite une référence pendante à `adrTabHtml`) ; A005 → A007 ; A004/A005 → A008 → A009 ; A011 en dernier. Aucun accès à un élément créé par une étape ultérieure.
- **Couverture** : 100 % des exigences mappées (table §7 du plan), y compris la **non-action sur `GLOBAL_TABS`**.
- **Plan Validator** : **Valid**.

### 4.2 Globale (Phase 9) — inter-plans

- Un **seul** plan généré dans cette session → **aucune** possibilité de conflit inter-plans sur un même élément/région.
- **Incohérence historique traitée** : le plan précédent (`…-20260921-070023`) est **remplacé** ; sa modification de `GLOBAL_TABS` est **abandonnée**. Aucune autre tâche active n'a d'étape déclarée sur `public/app.js` / `public/style.css` du repo `opencode-observability` (conflit de scope vérifiable via `scope_conflict`/`batch_conflict_matrix` avant lancement).
- **Incohérences à signaler à l'utilisateur** : aucune.

## 5. Tests E2E (analyse d'impact)

**E2E NA.** `e2e_list(project=ecosystem)` → **0 test** ; le projet `ecosystem` n'a **pas** d'`e2eRepoDir`
(panneau d'infra hôte, pas de spec Playwright). Aucun `e2e_test_register` / `e2e_test_link` créé ;
non-régression couverte par le parcours manuel A011.

## 6. Traçabilité

- `task_event(PLANNING_STARTED)` — publié (by `atomic-plan`).
- `plan_register` → `planId=Plan-onglet-adr-projet-20260921-070532`, steps A001–A011, taskId rattaché.
- `participant_add(atomic-plan, planner)` — enregistré.
- `task_event(PLAN_CREATED)` — publié (detail : planId, planFile, plan remplacé, correction).
- `artifact_add(kind=plan)` → `ART-T-20260921-065829-xa46-muawitdj-we1d`.
- `artifact_add(kind=report)` → présente synthèse.

**Aucun email envoyé** (notifications dérivées par le daemon `opencode-notifier` depuis le registre).
Aucun code du projet modifié (planificateur en lecture seule).
