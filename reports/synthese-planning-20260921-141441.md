# Synthèse de planification — T-20260921-140612-t8ub

- **Tâche** : `T-20260921-140612-t8ub` (exécution `E-T-20260921-140612-t8ub-vklw72`)
- **Projet** : `ecosystem` · **Type** : `debug` (performance)
- **Demande** : onglet Fonctionnalités / Règles métier du panneau anormalement lent (~11 s pour 45 fonctionnalités + 10 règles).
- **Planificateur** : `atomic-plan`
- **Date** : 2026-09-21 14:14:41

---

## 1. Objectifs identifiés et segmentation

| # | Objectif | Nature | Décision |
|---|---|---|---|
| O1 | Supprimer le N+1 : index des liens en **1 seul appel** (au lieu de 55) | Interdépendant (partage `db.mjs` avec O2) | **Fusionné dans un plan unique** |
| O2 | Réduire le **coût fixe par appel MCP** (persistant + version-skip du schéma) | Interdépendant (partage `db.mjs` avec O1) | **Fusionné dans un plan unique** |
| O3 | **Mesurer** avant/après et prouver onglet **< 1 s** | Dépend de O1 **et** O2 (critère conjoint) | **Fusionné dans un plan unique** |

**Justification du plan unique** : O1 et O2 écrivent dans le **même fichier `db.mjs`** (conflit de fichier ⇒ non parallélisables) et le critère d'acceptation (`chargement de l'onglet < 1 s`, `appel MCP simple nettement réduit`) est un résultat **conjoint**. Règle appliquée : *des objectifs interdépendants = un seul plan*.

## 2. Plan produit

| PlanId | Fichier | Étapes | Objectif |
|---|---|---|---|
| `Plan-panneau-perf-fr-nplus1-mcp-20260921-141337` | `plans/Plan-panneau-perf-fr-nplus1-mcp-20260921-141337.md` | **A001 → A016** (16) | Rendre le chargement de l'onglet Fonctionnalités/Règles **< 1 s** sur myxmax (45+10) : index des liens en **1 appel** + **coût fixe MCP réduit**, sans cache de données périmable ni perte d'idempotence du schéma |

Artefact : `ART-mubbtv0s-aan1` (kind=`plan`), événement `PLAN_CREATED`, participant `atomic-plan` (rôle `planner`).

## 3. Diagnostic vérifié dans le code (ancrage) + mesures de référence

**Cause 1 — N+1.** `loadFeatureRuleLinkIndex()` (`public/app.js` **l.5188-5222**) appelle `GET /api/features/:id` (45×) + `GET /api/rules/:id` (10×) = **55 requêtes**, concurrence **4** (`app.js` l.5217-5219) ⇒ ~14 vagues. Appelé par `renderFeaturesRules()` (**l.5570**). Routes `server.mjs` **l.2006-2010** / **l.2050-2054** → `pilot.getFeature/getRule` → `feature_get`/`rule_get`.

**Cause 2 — coût fixe ~0,7 s/appel.** `mcp-client.mjs` `callTool()` (**l.43-116**) fait `spawn(…)` **à chaque appel** (l.49). `db.mjs` `ensureSchema()` (**l.28-41**) applique paresseusement `schema.sql` (913 l., 61 CREATE TABLE, 68 CREATE INDEX) puis `migrate()` (**l.44-714**, 77 `ALTER TABLE`) au 1er accès DB de **chaque process** (`_schemaReady` l.29 perdu avec le process).

Mesures **capturées par le planificateur** (lecture seule, 2026-09-21) :

| Mesure | Résultat |
|---|---|
| `node -e 1` | 0,037 s |
| import `db.mjs` | 0,166 s |
| `ensureSchema` 1er accès DB / requête suivante (même process) | **244 ms** / **4 ms** |
| appel MCP trivial `org_list` | **0,718 s** |
| `feature_list` myxmax (45) | 0,826 s |
| `rule_list` myxmax (10) | 0,711 s |
| `feature_get` (1 entité) | ~0,69 s |
| **Onglet FR myxmax** (55 appels / concurrence 4) | **~11 s** ✅ reproduit |

## 4. Choix de conception tranchés

1. **N+1 → enrichissement des listes** (et non un tool bulk dédié) : `feature_list`/`rule_list` renvoient un champ **additif** `links` par entité, calculé par **1 requête SQL bulk** (`unnest($1::text[])` + sous-requêtes `count(*)`). Le panneau **ne fait plus aucun appel réseau** pour l'index ⇒ **0 route nouvelle, 0 tool nouveau, 0 appel supplémentaire**, données **toujours fraîches**.
2. **Coût fixe → les DEUX mécanismes** : (a) **marqueur de version de schéma EN BASE** (`schema_meta`) — `ensureSchema()` lit une ligne (~2 ms) et **saute** `schema.sql` + `migrate()` ; (b) **process MCP persistant** par `(serveur, lane)` — `spawn` + bootstrap + `initialize` + pool PG amortis.
3. **Marqueur EN BASE (pas de cache disque)** : un cache disque peut être périmé par rapport à la base ; le marqueur vit **dans la base qu'il décrit**. `SCHEMA_VERSION` **à incrémenter à chaque évolution DDL** ⇒ version différente = apply complet.
4. **Garde d'idempotence** : apply complet sous **`pg_advisory_lock`** + re-check du marqueur ; toutes les DDL restent `IF NOT EXISTS` ; marqueur écrit **après** succès ; `_schemaPromise` réinitialisé en cas d'échec.
5. **Aucun cache de RÉSULTAT de tool** (source de vérité unique) : seuls le process et le pool de connexions sont réutilisés.
6. **Lane dédiée `long`** pour `e2e_run`/`e2e_sync_repo` (20 min) : un run Playwright ne bloque pas le canal principal.
7. **Chemins MCP surchargeables par env** (`MCP_TASK_ORCHESTRATOR_PATH`, `MCP_CODER_WORKSPACES_PATH`), **défaut inchangé** : vérifier le MCP d'un worktree sans toucher au checkout principal.
8. **Repli non bloquant** : `links` absent ⇒ entité hors index ⇒ colonne « Liens » = `—` (repli actuel) + `console.warn` unique.

## 5. Couverture des objectifs

| Exigence (AC de la tâche) | Étapes | Couvert |
|---|---|---|
| AC1 — index en **1 seul appel** (plus de N+1 55) | A004, A005, A006, A007, A010, A011 | ✅ |
| AC2a — plus de rejeu `schema.sql` + `migrate()` | A002, A003 | ✅ |
| AC2b — process MCP persistant/pool | A012, A013 | ✅ |
| AC3 — mesures avant/après, onglet **< 1 s**, appel MCP réduit | A001, A014, A015, A016 | ✅ |
| AC4 — non-régression (`node --check`, spawn réel, idempotence, compteurs) | A003, A010, A014, A015 | ✅ |
| AC5 — pas de cache périmable (compat. `refreshActive()`) | A005, A007, A010, A012 | ✅ |
| AC6 — source de vérité unique (écriture via MCP) | A003, A012 | ✅ |

**Aucune exigence non couverte.**

## 6. Vérifications de cohérence

**Intra-plan (Phases 6-7)** — regroupement par élément cible : chaque élément (`ensureSchema` l.28-41, helpers A004/A006, `listFeatures` l.1958-1977, `listRules` l.2118-2137, descriptions `index.mjs` l.977/l.1054, `loadFeatureRuleLinkIndex` l.5188-5222, appel l.5570, `callTool` l.43-116, `MCP_SERVERS` l.11-14, handlers `server.mjs`) est ciblé par **une seule** étape. Aucune action `supprimer`, aucun `créer`+`renommer`, aucun `déplacer`. Aucune lecture d'un élément créé par une étape ultérieure (A004→A005, A006→A007, A010→A011 respectés). **Point d'attention levé** : A003 (version-skip) change le régime de latence que A001 doit mesurer ⇒ A001 imposée **en premier**.

**Verdict Plan Validator : Valid.**

**Globale (Phase 9)** — **un seul plan** ⇒ aucune contradiction inter-plans. Vérifié tout de même : les éléments touchés des deux repos sont **disjoints**.

**Note technique** : `plan_register` a auto-extrait `index.mjs` comme fichier de l'étape **A015** (heuristique de parsing du texte : la commande de vérification y cite `<worktree>/index.mjs`). A015 est une **étape de vérification**, pas d'écriture ; impact nul (aucune paire de tâches, un seul plan).

## 7. Tests E2E Playwright — analyse d'impact

**Verdict : E2E NA.**
- `/root/orchestrator-panel` **ne contient aucun `playwright.config.*` ni dossier `tests/`** ; `e2e_list({ project: 'ecosystem' })` → **0 test** enregistré.
- Tâche **performance/infrastructure** : le comportement observable est une **latence** + des **compteurs inchangés**, sans parcours utilisateur nouveau.
- **Aucune création « en aveugle »** : pas de `e2e_test_register`, pas de `e2e_test_link`.
- **Substitut de vérification** : `scripts/bench-fr-load.mjs` (avant/après) + instance panneau de test `PORT=4010` (A015) + `node --check` + smoke MCP réel (A014).

## 8. Incohérences

**Aucune incohérence** détectée (intra-plan ni globale). Aucun `INCONSISTENCY_FOUND` publié.

## 9. Mesures de référence attendues (avant → après)

| Métrique | Avant (mesuré) | Après (cible) |
|---|---|---|
| Appel MCP **1er** (process neuf) | 0,718 s | ≤ 0,50 s |
| Appel MCP **suivant** (process chaud) | 0,718 s | **≤ 0,05 s** |
| `ensureSchema` régime établi | 244 ms | ≤ 5 ms |
| `feature_list` myxmax (45) | 0,826 s | ≤ 0,10 s |
| `rule_list` myxmax (10) | 0,711 s | ≤ 0,05 s |
| Requêtes pour l'index des liens | **55** | **0** |
| **Onglet FR myxmax (45+10)** | **~11 s** | **< 1 s** |

## 10. Cadre d'isolation & déploiement

- Branche de travail **dédiée par repo** (via `session-guard`/worktree), basée sur `feature/migration-postgresql` ; **jamais** de modification directe de la branche principale.
- ⚠️ **Panneau live** : PM2 `orchestrator-panel` (id 4, `node /root/orchestrator-panel/server.mjs`) sert les **statiques du working tree** ⇒ ne pas laisser `/root/orchestrator-panel` sur une branche de travail, ne pas redémarrer le PM2 pendant le build (vérifier sur `PORT=4010` + `MCP_TASK_ORCHESTRATOR_PATH=<worktree>/index.mjs`).
- **Ordre de déploiement recommandé** : registre (`schema.sql`/`db.mjs`/`index.mjs`) → panneau (`mcp-client.mjs`/`server.mjs`/`public/app.js`) → `pm2 restart orchestrator-panel`.
