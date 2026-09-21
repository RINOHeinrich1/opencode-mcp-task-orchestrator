# Synthèse de planification — Tâche `T-20260921-091733-rpvh` (T5)

- **Tâche** : `T-20260921-091733-rpvh` — exécution `E-T-20260921-091733-rpvh-d3owq1`
- **Batch** : `BATCH-mub1809u-06ow` (5/9)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator` (branche `feature/migration-postgresql` @ `947fcf3`)
- **Agent** : `atomic-plan` (rôle `planner`)
- **Date** : 2026-09-21 10:28:22
- **Racine** : `/root/.config/opencode/mcp/task-orchestrator`

---

## 1. Objectifs identifiés (Phase 0)

Demande : exposer les familles MCP `feature_*` / `rule_*` (CRUD) + les outils de liaison
(fonctionnalité↔règle, fonctionnalité↔scénario Gherkin existant, fonctionnalité↔ADR,
tâche↔sprint/fonctionnalité/ADR, recette↔sprint/fonctionnalité(s)/ADR(s)), avec :

- pièce source gardée (T2) ;
- émergence réutilisée (`classifyEmergence`) et rattachement à un sprint ultérieur ;
- lien ADR d'une tâche **proposé par l'agent → effectif après validation humaine**.

**Classification** : objectifs **interdépendants** (les outils de liaison s'appuient sur les CRUD
`feature_*`/`rule_*`) ⇒ **un plan unique** (méthode atomic-plan, Phase 0).

## 2. Plans produits

| Plan ID | Objectif | Étapes | Fichier | Enregistré (plan-manager) | Artefact (task) |
|---------|----------|--------|---------|---------------------------|-----------------|
| `Plan-feature-rule-crud-liaisons-20260921-102722` | CRUD MCP `feature_*`/`rule_*` + outils de liaison + workflow ADR proposé→validé | **44** (A001-A044) | `plans/Plan-feature-rule-crud-liaisons-20260921-102722.md` | ✅ | ✅ `ART-mub3qvaa-8zjo` (kind=`plan`) |

## 3. Contenu du plan (résumé)

- **Groupe A — socle DB (`db.mjs`)** : A001 colonnes d'état `task_adr` (`propose`/`valide` + traçabilité) ;
  A002/A003 sérialiseurs ; A004-A007 CRUD fonctionnalité ; A008-A011 CRUD règle.
- **Groupe B — liaisons DB (`db.mjs`)** : A012-A018 liaisons feature↔rule/gherkin/adr/sprint,
  rule↔sprint, task↔sprint/feature ; A019 workflow ADR (`proposeTaskAdr`/`validateTaskAdr`/…).
- **Groupe C — recette + lecture** : A020-A022 liaisons recette↔sprint/feature/adr ; A023
  `getRecetteById` enrichie.
- **Groupe D — exposition MCP (`index.mjs`)** : A024 imports ; A025-A032 tools CRUD `feature_*`/`rule_*` ;
  A033-A043 tools de liaison + workflow ADR ; A044 vérification.

**Réutilisation** : `classifyEmergence`, `assertAttachablePiece`, tables N:N T1, primitives T3/T4 —
aucune réimplémentation.

## 4. Vérifications de cohérence

- **Intra-plan (Phases 6-7)** : aucune étape `supprimer`/`renommer`/`déplacer` ; aucun élément ciblé par
  deux actions incompatibles ; aucune lecture d'un élément créé par une étape ultérieure ; **Gate = Valid**
  (exigences 100 % couvertes, aucune étape vague).
- **Globale (Phase 9)** : un **seul plan** ⇒ aucune incohérence inter-plans. Frontière inter-tâches
  respectée : T1-T4 non modifiés, panneau (T7) et cardinalités heuristiques (T6) hors périmètre.

## 5. Incohérences éventuelles

**Aucune.** Aucun point de vigilance ADR : ADR-001 (`doc-mub10mo8-lgo3`, statut **Proposé**) est la
référence de conception et les étapes restent **additives** (pas de contradiction avec une ADR Accepté).

## 6. Notes / suites

- **`schema.sql` non modifié** (hors périmètre déclaré `index.mjs` + `db.mjs`) : la seule extension de
  schéma (`task_adr.status` & co) est posée dans `migrate()` (A001). Un **suivi** doit miroiter ces
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dans `schema.sql` pour éviter la dérive DDL.
- **Tests E2E Playwright : NA** — repo outillage MCP sans `playwright.config.*` ni spec E2E ; comportement
  interne registre/MCP non observable par parcours Playwright. Aucun `e2e_test_register`/`e2e_test_link`.

## 7. Traçabilité

- `task_event` `PLANNING_STARTED` (début) et `PLAN_CREATED` (fin) sur `T-20260921-091733-rpvh`.
- `participant_add` (`atomic-plan`, rôle `planner`).
- `plan_register(taskId=…)` → suivi d'exécution en base (`Plan-feature-rule-crud-liaisons-20260921-102722`).
- `artifact_add(kind=plan)` → pièce jointe du notifier (`ART-mub3qvaa-8zjo`).
