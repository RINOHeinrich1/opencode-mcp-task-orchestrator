# Synthèse de planification — `T-20260922-070103-ncs1`

- **Date** : 2026-09-22 07:03
- **Agent** : `atomic-plan` (planner)
- **Projet** : `ecosystem`
- **Exécution** : `E-T-20260922-070103-ncs1-c1g8ft`
- **Demande** : à la création d'une recette, pouvoir sélectionner et référencer en contexte les **Fonctionnalités** et **Règles métier** (en plus des ADR).

## Objectifs identifiés (Phase 0)

Un **objectif unique et borné** : « Sélectionner et référencer en contexte les Fonctionnalités et Règles métier d'une recette ». Les 4 groupes d'exigences (panneau, MCP, contexte agent, non-régression) sont **interdépendants** (le contexte exige `recette_get.regles` ; les sélecteurs exigent `recette_start.ruleIds`) ⇒ **un seul plan**, avec section « Ordre & dépendances ».

## Plans générés

| Plan | planId | Objectif | Étapes | Repos |
|---|---|---|---|---|
| `Plan-recette-features-rules-contexte-20260922-070249.md` | `Plan-recette-features-rules-contexte-20260922-070249` | Sélectionner (panneau) + rattacher (MCP) + référencer en contexte (prompt agent-recette) les Fonctionnalités et Règles métier | 23 (`A001`→`A013` MCP, `B001`→`B010` panneau) | `opencode-mcp-task-orchestrator`, `opencode-observability` |

Plan enregistré : `plan_register` (23 étapes, 10 livrables) + `artifact_add(kind=plan)` (`ART-mucbvchd-sfi8`).

## Choix de conception

1. **Sélecteurs (panneau)** — helper générique `frSelectorHtml(kind, items, opts)` à côté de `adrSelectorHtml` (`public/app.js` l.5872) ; **réutilise les classes CSS `.adr-pick*`** (aucun changement CSS) ; lignes = case à cocher + ref + badge (rôle / « Global ») + texte condensé ; filtres = recherche libre + filtre **Rôle** (options = rôles distincts du projet, + « Global » pour les règles) ; **tout coché par défaut** (`selected` absent ⇒ toutes cochées), `selectedFrIds` retourne **toujours un tableau**.
2. **Blocs de contexte (MCP)** — patron `buildAdrContext` : `buildFeatureContext` / `buildRuleContext` retournent `{ projectId, count, features|rules, context }` ; **lecture bulk** `WHERE id = ANY($1::text[])` (1 requête, 0 N+1) ; `context: ""` si vide ⇒ **blocs facultatifs** ; rendu « ## Fonctionnalités de référence » (ref, rôle, user story) et « ## Règles métier de référence » (ref, contenu, rôles/global) ; exposés par 2 tools MCP `feature_context` / `rule_context` (patron `adr_context`).
3. **Injection prompt** — `buildRecettePrompt` reçoit `featureContext`/`ruleContext` insérés **après** le bloc ADR, uniquement si non vides ; `launchRecetteSession` les construit depuis **les liens persistés** de la recette (`rec.fonctionnalites`, `rec.regles` du `recette_get` déjà effectué) ⇒ 1 appel, 0 N+1, prompt toujours fidèle à la recette enregistrée.
4. **Modèle** — table `recette_regles` (miroir de `recette_fonctionnalites`) en **DDL idempotente** dans `migrate()` **ET** `schema.sql`, avec bump de `SCHEMA_VERSION` ; `recette_start` accepte `ruleIds` (optionnel, non bloquant) ; `recette_get` expose `regles`.
5. **Non-régression** — flux ADR intact (seule la description du tool `recette_get` est enrichie) ; création possible avec 0 sélection (boucles et helpers tolèrent le vide) ; `deleteRule` détache `recette_regles`.

## Vérifications de cohérence

- **Intra-plan (Phases 6-7)** : regroupement par élément cible effectué — 8 éléments distincts dans `db.mjs`, 5 dans `index.mjs`, 4 dans `public/app.js` ; **aucun** couple `supprimer` + autre action, **aucun** `créer` + `renommer`, **aucun** `déplacer`. Ordre et dépendances vérifiés (§6 du plan). **Gate : Valid.**
- **Globale (Phase 9)** : un seul plan ⇒ **aucune incohérence inter-plans**.
- **Couverture (Phase 5)** : 13 exigences tracées, **toutes couvertes** (table §8 du plan).

## E2E Playwright — analyse d'impact

**E2E : NA.** Aucun `playwright.config.*` dans les deux repos ; `e2e_list(project="ecosystem")` = `count: 0`. Outillage interne sans scénario Playwright : aucun test E2E créé/lien établi. La preuve d'acceptation passe par `recette_get` + inspection du prompt de session.

## Traçabilité & isolation

- `task_event` : `PLANNING_STARTED` puis `PLAN_CREATED` publiés sur `T-20260922-070103-ncs1`.
- `plan_register(taskId=…)` + `artifact_add(kind=plan)` effectués.
- **Branche de travail dédiée par repo** (via session-guard) ; ne pas laisser `/root/orchestrator-panel` ni `/root/.config/opencode/mcp/task-orchestrator` sur une branche de travail (checkouts actuellement propres sur `feature/migration-postgresql`).
- Redémarrage du serveur MCP requis pour exposer les nouveaux tools (`recette_rule_link`, `recette_rule_unlink`, `feature_context`, `rule_context`).

## Incidents / incohérences

Aucun.
