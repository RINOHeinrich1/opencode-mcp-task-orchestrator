# Synthèse de planification — `T-20260921-145025-meiv`

- **Tâche** : `T-20260921-145025-meiv` (exécution `E-T-20260921-145025-meiv-rj11aq`)
- **Titre** : Panneau — filtre par rôle dans les sous-onglets Fonctionnalités et Règles métier (rôle d'une règle = rôles de ses fonctionnalités liées)
- **Projet** : `ecosystem` — type `feature`
- **Planificateur** : `atomic-plan` (participant `planner`)
- **Date** : 2026-09-21 14:52:39

---

## 1. Objectifs identifiés et segmentation

| # | Objectif | Nature |
|---|---|---|
| O1 | **MCP** : exposer `rules[].roles` (rôles distincts des fonctionnalités liées), sans N+1 | Prérequis de O2 |
| O2 | **Panneau / Règles** : select « Rôle : tous » + « Sans rôle », filtrage CLIENT, persistance | Dépend de O1 |
| O3 | **Panneau / Fonctionnalités** : conserver le filtre rôle existant + homogénéiser | Même fichier que O2 |
| O4 | **Non-régression & performance** : filtres, tri, index des liens, badges, compteurs, `node --check`, spawn MCP réel | Critère commun |

**Décision** : objectifs **interdépendants** (O2 ⟸ O1 ; O2/O3 dans le même fichier `public/app.js` ; O4 = verdict conjoint) ⇒ **UN SEUL plan**.

---

## 2. Plans produits

| planId | Objectif | Étapes | Fichier |
|---|---|---|---|
| `Plan-filtre-role-fonctionnalites-regles-20260921-145146` | Filtre par rôle dans les 2 sous-onglets (rôle d'une règle = rôles de ses fonctionnalités liées) | A001 → A011 | `plans/Plan-filtre-role-fonctionnalites-regles-20260921-145146.md` |

**Étapes** : A001 `ruleLinkCounts` + `roles` (1 requête) · A002 `listRules` champ additif `roles` · A003 description `rule_list` · A004 `frRuleFilters.role` · A005 `frFilterRules` (filtre rôle client) · A006 select `#fr-r-role` · A007 `frFilterFeatures` (`__none__`) · A008 option « Sans rôle » `#fr-f-role` · A009 `node --check` + spawn MCP réel + cohérence/perf · A010 instance panneau TEST `PORT=4010` · A011 rapport.

**Traçabilité** : `plan_register(taskId="T-20260921-145025-meiv")` ✅ · `artifact_add(kind=plan)` ✅ (`ART-mubd6qd0-498l`) · `task_event(PLANNING_STARTED)` ✅ · `task_event(PLAN_CREATED)` ✅.

---

## 3. Choix de conception structurants

1. **Rôle d'une règle = union des rôles de ses fonctionnalités liées** (`fonctionnalite_regles` ⨝ `fonctionnalites.role`) ; rôles `NULL`/vides exclus ⇒ « Sans rôle » si l'union est vide (aucune fonctionnalité liée, ou fonctionnalités sans rôle). `regles_metier` n'a pas de colonne `role` (vérifié `schema.sql` l.721-733) : la dérivation est **obligatoire**, pas un choix.
2. **Exposition MCP additive** : `rules[].roles: string[]` à côté de `links`, calculé par une **3ᵉ sous-requête scalaire** ajoutée à la requête `unnest` **existante** de `ruleLinkCounts` (`db.mjs` l.2043-2058) ⇒ **1 requête**, **0 N+1**, **0 nouveau tool**, **0 nouvelle route**, **0 appel réseau en plus**. Réutilise l'optimisation de `T-20260921-140612-t8ub` au lieu de la contourner.
3. **`links` strictement inchangé** (`{ features, sprints }`) : A002 ré-extrait explicitement les deux clés ⇒ la colonne « Liens » et les filtres « sans lien » ne régressent pas.
4. **Filtrage CLIENT** dans le panneau (`frFilterRules`), cohérent avec les autres filtres (seule la table est re-rendue ⇒ focus de recherche préservé) ; aucun paramètre ajouté aux tools/route.
5. **Sentinelle `__none__`** pour « Sans rôle », **identique dans les deux sous-onglets** (homogénéité) ; option toujours présente ; select positionné **après** la recherche (position homogène).
6. **Filtre rôle des Fonctionnalités conservé** (clause existante l.5289 **étendue**, jamais remplacée) + option « Sans rôle » ⇒ AC2 structurellement garantie.
7. **Aucune modification de `pilot.mjs` / `server.mjs`** (passe-plats vérifiés : `pilot.listRules` l.838-846, `GET /api/rules` l.2027-2038) ni de `schema.sql` (aucune DDL, **aucun bump de `SCHEMA_VERSION`**).

---

## 4. Vérifications de cohérence

### 4.1 Intra-plan (Phase 6/7) — verdict **Valid**

- **Contradictions** : aucune (aucun `supprimer`/`renommer`/`déplacer` ; éléments cibles distincts et séquentiels dans `db.mjs` puis `public/app.js`).
- **Couverture** : 100 % (table §7 du plan : les 5 critères d'acceptation + les 3 points de la demande + le cadre sont couverts).
- **Précision** : chaque étape = 1 verbe × 1 élément × 1 fichier, avec numéros de ligne, raison et livrable.
- **Points d'attention levés et inscrits dans les étapes** : (i) non-fuite de `roles` dans `links` (A002) ; (ii) conservation de la clause rôle existante (A007).

### 4.2 Globale (Phase 9)

**Un seul plan produit** ⇒ aucune contradiction inter-plans possible. Vérifié : fichiers répartis sur 2 repos (`db.mjs`/`index.mjs` vs `public/app.js`), aucun fichier partagé entre plans, aucune région de fichier en conflit.

**Aucune incohérence détectée** ⇒ pas de `task_event(INCONSISTENCY_FOUND)`.

---

## 5. Tests E2E Playwright

**Verdict : E2E NA** (mentionné au §10 du plan). `e2e_list({ project: 'ecosystem' })` → 0 test ; aucun `playwright.config.*` ni dossier `tests/` dans `opencode-observability` ni dans `opencode-mcp-task-orchestrator` ⇒ aucun harnais exploitable. **Aucun enregistrement en aveugle** (`e2e_test_register`/`e2e_test_link` non appelés). Substituts : A009 (`node --check` + spawn MCP réel + cohérence) et A010 (instance panneau TEST `PORT=4010`).

---

## 6. Risques principaux

| Risque | Mitigation |
|---|---|
| Régression du contrat `links` | A002 ré-extrait `{features, sprints}` ; vérif A009 |
| Réintroduction d'un N+1 | Sous-requête dans la requête `unnest` existante ; aucune boucle ; mesure A009 |
| Dégradation de perf `rule_list` | Index `idx_fonctionnalite_regles_regle` ; coût négligeable ; mesure A009 |
| Déploiement panneau avant registre | Repli non bloquant (`x.roles \|\| []`) ; ordre registre → panneau → `pm2 restart orchestrator-panel` |
| PM2 live / checkout principal touchés | Vérification sur instance TEST `PORT=4010` ; worktree ; jamais `/root/orchestrator-panel` sur une branche de travail |

---

## 7. Suite

Plan **Valid**, enregistré et rattaché à `T-20260921-145025-meiv`. L'exécution revient à `build-notify` (suivi via le MCP `plan-manager`). Aucun email envoyé par le planificateur — la notification est dérivée par `opencode-notifier` depuis le registre.
