# Synthèse de planification — T-20260921-120633-mtl2

- **Tâche** : `T-20260921-120633-mtl2` (exécution `E-T-20260921-120633-mtl2-jai3ti`)
- **Projet** : `ecosystem` — repo `opencode-observability` → `/root/orchestrator-panel`
- **Tâche liée** : `T-20260921-091736-yqwv` (`emergent` — livraison de l'onglet « Émergents », commit `70b445f`)
- **Agent** : `atomic-plan`
- **Date** : 2026-09-21 12:09:41

## Objectifs identifiés (Phase 0)

Un **objectif unique** : refondre la restitution des cardinalités dans le panneau — retirer l'onglet
« Émergents », déplacer ses indicateurs dans la Vue d'ensemble sous forme de cartes statistiques
cliquables (filtres cibles pré-appliqués), conserver l'accès discret aux signaux.

Les 6 sous-exigences sont **interdépendantes** (même registre d'onglets `PROJECT_TABS`/`RENDER`, même
route `GET /api/cardinality`, mêmes régions de `public/app.js`) → **un seul plan**.

## Plans produits

| Plan ID | Objectif | Étapes | Fichiers | Statut |
|---|---|---|---|---|
| `Plan-panneau-cardinalites-vue-ensemble-20260921-120900` | Retirer l'onglet Émergents + déplacer les cardinalités en 10 cartes statistiques cliquables dans la Vue d'ensemble, avec filtres cibles pré-appliqués | A001→A013 (13) | `public/app.js`, `public/style.css` | Enregistré (todo) |

Fichier : `plans/Plan-panneau-cardinalites-vue-ensemble-20260921-120900.md`
(`server.mjs`/`pilot.mjs` **non modifiés** : la route `/api/cardinality` existante est réutilisée.)

## Vérifications de cohérence

- **Intra-plan (Phases 6-7)** : aucune contradiction. Le bloc cardinalité (`app.js` l.5196-5274) est
  découpé en zones disjointes (A003 supprime `renderEmergents`/`CARDINALITY_VIEW_LABELS` ; A004 crée
  `CARDINALITY_CARDS` + helpers ; A007 crée `cardinalitySignalsModal`). Aucun `supprimer` + autre
  action sur un même élément, aucun `créer` + `renommer`. → **Valid**.
- **Couverture (Phase 5)** : 100 % des exigences et des 7 critères d'acceptation couverts (table §7 du
  plan).
- **Globale inter-plans (Phase 9)** : plan unique → aucun conflit inter-plans. `Plan-panneau-sprints-
  fonctionnalites-emergents-*` (T7, terminé) est la source de `renderEmergents` ; ce plan le supprime
  (suite `emergent` assumée, pas un conflit). Aucun autre plan actif ne touche les fichiers du repo
  panneau.

## Incohérences

**Aucune** incohérence intra-plan ni inter-plans détectée.

## Choix de conception tranchés

1. **Cible de la carte « Éléments émergents » → onglet `tasks` + filtre « Émergentes »** (id-set de la
   vue `emergents` restreinte à `entityType === 'task'`). La vue agrège 4 types (tâche, fonctionnalité,
   règle, pièce) ; aucune page unique ne les affiche tous. Les tâches sont l'entité porteuse principale
   du flag `emergent` et l'onglet le plus actionnable ; les fonctionnalités/règles/pièces émergentes
   restent listées dans le panneau discret des signaux. Alternative écartée : `features` (ne couvre ni
   tâches ni pièces) ou un onglet dédié (contredit la suppression demandée).
2. **Forme des filtres = ensemble d'ids issu des vues cardinalité, appliqué côté client** (cache 15 s).
   Réutilise la route existante, aucune nouvelle route ni changement de schéma ; sémantique identique
   au registre ; exposé par un `<select>` visible et persisté dans la barre de filtres de chaque page
   (défaut « tous » = non-régression).
3. **Point d'entrée discret** : bouton `#card-signals-open` (« Signaux de cardinalité — N ouvert(s) »)
   ouvrant une **modale** (table des signaux + clôture tracée à résolution obligatoire). Plus de table
   de signaux affichée en permanence.
4. **Pas de recalcul d'émergence côté panneau** : le panneau affiche les compteurs/ensembles renvoyés
   par le registre.
5. **Limitation documentée** : le filtre ADR s'appuie sur la vue scopée projet
   `adr_sans_fonctionnalite` ; une ADR rattachée uniquement à un repo transverse n'est pas dans
   l'ensemble et sera masquée quand le filtre est actif.

## Tests E2E — analyse d'impact

- `e2e_list(project=ecosystem)` → **0 test** ; le repo panneau n'a **aucun harnais Playwright**
  (pas de `playwright.config.*`, aucun `*.spec.ts` hors `node_modules`), pas de `e2eRepoDir`.
- **Décision : E2E NA** (aucune création d'entité E2E en aveugle). Preuve de parcours assurée par
  l'étape A013 (vérification `node --check` + parcours UI carte → onglet + filtre).
- Scénarios recommandés documentés dans le plan (§9) pour une activation ultérieure quand un harnais
  existera.

## Traçabilité

- `task_event(T-20260921-120633-mtl2, PLANNING_STARTED, by=atomic-plan)`
- `participant_add(T-20260921-120633-mtl2, atomic-plan, planner)`
- `plan_register(rootPath=…, planFile=…, taskId=T-20260921-120633-mtl2, steps=A001..A013)`
- `task_event(T-20260921-120633-mtl2, PLAN_CREATED, detail={planId, planFile})`
- `artifact_add(T-20260921-120633-mtl2, kind=plan, docType=plan, path=…)` → `ART-mub7d706-iex9`
