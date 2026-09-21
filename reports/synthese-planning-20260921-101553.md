# Synthèse de planification — `T-20260921-091732-9jqg`

- **Tâche** : `T-20260921-091732-9jqg` (exécution `E-T-20260921-091732-9jqg-hbobz6`)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`)
- **Batch** : `BATCH-mub1809u-06ow` (4/9) — dépendances T1/T2/T3 **TERMINÉES**
- **Agent** : `atomic-plan` — rôle planner
- **Date** : 2026-09-21 10:15:53

## 1. Objectifs identifiés (Phase 0)

**1 objectif unique et borné** (indépendant, un seul plan) :

> Exposer la famille MCP `sprint_*` (CRUD) — `sprint_start`, `sprint_list`, `sprint_get`,
> `sprint_close`, `sprint_reopen`, `sprint_attach_pieces` — au-dessus des primitives de cycle de vie
> livrées en T3, en réutilisant `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`, `getSprint`,
> `listProjectSprints`, `buildSprintReport`, `classifyEmergence`, `assertPieceAllowed` et le tool
> `sprint_report` existant (sans doublon).

Aucune segmentation multiple (pas d'objectif interdépendant distinct) ; les sous-exigences du critère
d'acceptation sont couvertes par des étapes du **même** plan (§4).

## 2. Plans produits

| PlanId | Fichier | Objectif | Étapes |
|--------|---------|----------|--------|
| `Plan-sprint-crud-mcp-20260921-101521` | `plans/Plan-sprint-crud-mcp-20260921-101521.md` | Famille MCP `sprint_*` (CRUD) au-dessus des primitives T3 | A001-A012 (12) |

**Enregistrements** :
- `plan_register` → `planId=Plan-sprint-crud-mcp-20260921-101521`, `taskId=T-20260921-091732-9jqg`
- `artifact_add(kind=plan)` → `ART-mub3atce-m779` (`/root/.config/opencode/mcp/task-orchestrator/plans/Plan-sprint-crud-mcp-20260921-101521.md`)
- `task_event(PLANNING_STARTED)` puis `task_event(PLAN_CREATED)`
- `participant_add(atomic-plan, planner)`

## 3. Contenu du plan (étapes atomiques)

| ID | Fichier | Action | Élément |
|----|---------|--------|---------|
| A001 | `db.mjs` | créer | `assertAttachablePiece(pieceId)` — garde nature du rattachement |
| A002 | `db.mjs` | créer | `attachPiecesToSprint(sprintId, { pieceIds, atInit, by })` — lien + émergence |
| A003 | `db.mjs` | créer | `createSprint({ projectId, title, startDate, endDate, autoClose, sessionId, createdBy, pieces })` |
| A004 | `db.mjs` | créer | `getSprintDetail(sprintId)` — pièces/fonctionnalités/règles/tâches/recettes |
| A005 | `index.mjs` | modifier | import `db.mjs` (l.133-138) |
| A006 | `index.mjs` | modifier | commentaire bloc SPRINT + tool `sprint_start` |
| A007 | `index.mjs` | ajouter | tool `sprint_list` |
| A008 | `index.mjs` | ajouter | tool `sprint_get` |
| A009 | `index.mjs` | ajouter | tool `sprint_close` (manuelle ou auto à l'échéance) |
| A010 | `index.mjs` | ajouter | tool `sprint_reopen` |
| A011 | `index.mjs` | ajouter | tool `sprint_attach_pieces` |
| A012 | `db.mjs`, `index.mjs` | vérifier | `node --check` + spawn MCP réel + cycle complet + non-régression |

## 4. Vérifications de cohérence

### Intra-plan (Phases 6-7) — **Valid**
- Aucune étape `supprimer` / `renommer` / `déplacer` → aucune contradiction de ce type.
- Aucune lecture d'un élément créé par une étape ultérieure : A001 → A002 → A003 ; A005 → A006-A011 ; A012 en dernier.
- Aucune modification des primitives T3 (elles sont **appelées**, pas réécrites) ; aucune modification de `schema.sql`.
- `sprint_report` **non recréé** (A006 insère `sprint_start` après lui, sans le toucher).
- Couverture 100 % des sous-exigences (§7 du plan) → gate **Valid**.

### Globale (Phase 9) — **Aucune incohérence**
- Un seul plan généré pour cette tâche → pas de conflit inter-plans.
- Frontières respectées : `feature_*`/`rule_*` (T5) et panneau (T7) non touchés.

## 5. Points de vigilance / risques

1. **Émergence au rattachement** : pièce rattachée à un sprint `open` → `apres_init_sprint` ; à un sprint `close` → `apres_cloture` ; à la **création** (`atInit=true`) → **non émergente** (pièce constitutive du sprint).
2. **Sprints `open` multiples** : aucune unicité (seul le sprint *par défaut* est unique) ; `detectOpenSprint` retient le plus récent. Non bloquant.
3. **Reprise sans prolongation** : `auto_close=0` (comportement T3) pour éviter la re-clôture immédiate.
4. **Clôture de sprint ≠ clôture de tâche** (ADR-001 §1) — garantie héritée de `closeSprint`.
5. **ADR-001 statut `Proposé`** : étapes purement **additives**, aucune contrainte nouvelle ; pas de contradiction avec une ADR Acceptée.
6. **E2E Playwright : NA** — repo outillage MCP sans `playwright.config.*` ni spec E2E ; comportement interne non observable par parcours. Aucun `e2e_test_register`/`e2e_test_link`.

## 6. Conclusion

Planification **terminée** pour `T-20260921-091732-9jqg` : **1 plan** (`Plan-sprint-crud-mcp-20260921-101521`,
12 étapes atomiques), enregistré, rattaché à la tâche et notifié via le registre (le daemon
`opencode-notifier` dérive la notification). Aucun blocage, aucune validation humaine requise à ce stade.
