# Synthèse de planification — tâche `T-20260921-120633-mtl2`

- **Date** : 2026-09-21 12:15
- **Agent** : `atomic-plan`
- **Projet** : `ecosystem` — repo `opencode-observability` → `/root/orchestrator-panel`
- **Branche de référence** : `feature/migration-postgresql` @ `5299d4c`
- **Racine des plans** : `/root/.config/opencode/mcp/task-orchestrator`

## Objectifs identifiés

La tâche comporte **deux objectifs non interdépendants** (planification incrémentale) :

1. **Objectif 1 (plan frère, déjà enregistré)** — Panneau : retirer l'onglet « Émergents », déplacer les cardinalités en cartes statistiques cliquables dans la Vue d'ensemble, ajouter les filtres cibles (Tâches/Recettes/Sprints/ADR).
2. **Objectif 2 (ce plan)** — Séparer l'onglet « Fonctionnalités / Règles » en deux sous-onglets internes distincts, chacun avec ses propres filtres et son CRUD.

## Plans

| Plan | Objectif | Étapes | Statut |
|---|---|---|---|
| `Plan-panneau-cardinalites-vue-ensemble-20260921-120900` | Objectif 1 (plan frère, pré-existant) | A001–A013 (13) | active (0 %) |
| `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443` | Objectif 2 (**ce plan**) | A001–A011 (11) | active (0 %) |

- Plan créé : `plans/Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443.md`
- Enregistré : `plan_register(taskId=T-20260921-120633-mtl2)` — 11 étapes (A001–A011), 10 livrables.
- Artefact : `ART-mub7khxj-5oni` (`kind=plan`, `contentId=T-20260921-120633-mtl2`).
- Événement : `PLAN_CREATED` publié sur `T-20260921-120633-mtl2`.

## Résumé du plan additionnel (objectif 2)

- **Sous-onglet « Fonctionnalités »** : table `Ref` (US-xxx) / `Rôle` / `User story` / `Liens` (règle, Gherkin, ADR, sprint, tâches, recettes) / `Actions` ; filtres propres (recherche, rôle, émergence, sans règle/sprint/ADR/Gherkin) ; CRUD (Nouvelle fonctionnalité, Éditer, Détail, Lier).
- **Sous-onglet « Règles métier »** : table `Ref` (RM-xxxx) / `Contenu` / `Pièce source` / `Liens` (fonctionnalité, sprint) / `Actions` ; filtres propres (recherche, émergence, sans fonctionnalité/sprint) ; CRUD (Nouvelle règle, Éditer, Détail, Lier).
- **Réutilisation** des patterns existants : `.pd-tabs`/`.pd-tab`/`.pd-panel` (sous-onglets internes), `.adr-pane-filters` (barre de filtres), `.adr-table-wrap`/`.adr-table` (tables), modales CRUD existantes.
- **Aucun ajustement d'API** : `/api/features`, `/api/rules`, `/api/links`, `/api/features/:id`, `/api/rules/:id` suffisent (pas de modification `server.mjs`/`pilot.mjs`).

## Vérifications de cohérence

### Intra-plan (Phase 6-7) — ✅ Valid

- Chaque élément cible n'est touché que par une seule étape (pas de `supprimer` + autre action sur le même élément, pas de doublon `enrichLinkCells`/`loadFeatureRuleLinkIndex`).
- Aucune étape ne consomme un élément créé par une étape ultérieure (A003 → A004 → A005/A006 → A007/A008 → A009).
- **Aucune contradiction.**

### Globale / inter-plans (Phase 9) — ✅ Aucune incohérence

Les deux plans touchent `public/app.js` et `public/style.css` mais sur des **régions disjointes** :

| Zone | Plan 1 | Plan 2 (ce plan) |
|---|---|---|
| `PROJECT_TABS` | l.120 (`emergents`, suppression) | l.119 (`features`, renommage) |
| `renderOverview` / cartes cardinalité | l.462-489 + l.5196-5274 | non touchés |
| Filtres Tâches/Recettes/Sprints/ADR | oui | non touchés |
| `enrichLinkCells` (l.5082-5112) | non touché | remplacé (A003) |
| `renderFeaturesRules` (l.5114-5194) | non touché | restructuré (A009) |
| `public/style.css` | `.card-link` (après l.85) | `.fr-subtabs`/`.fr-subpanel` (fin de fichier) |

Exécution **séquentielle** (plan 1 puis plan 2) : aucune réécriture concurrente, aucun conflit de fichiers. **Aucune incohérence globale à signaler** (pas de `INCONSISTENCY_FOUND`).

### ADR

- `adr_list({ projectId: 'ecosystem' })` = 0 ADR ; aucune ADR `Accepté`/`Proposé` contrainte. Aucun conflit d'ADR.

## Tests E2E Playwright — analyse d'impact

- **E2E NA** : le repo `opencode-observability` (`/root/orchestrator-panel`) ne contient **aucune spec Playwright** ni `playwright.config.*`, et `e2e_list(project='ecosystem')` = 0. Aucune entité E2E créée/liée.
- Preuve d'acceptation assurée par la vérification (A011) : `node --check public/app.js` + parcours UI/HTTP sur **myxmax** (séparation US-xxx / RM-xxxx, filtres, CRUD) + non-régression.

## Incohérences

Aucune.

## Prochaine étape

- Validation humaine du plan additionnel (`Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443`).
- Exécution : **plan 1 d'abord** (`Plan-panneau-cardinalites-vue-ensemble-20260921-120900`), puis **ce plan** (zones disjointes).
