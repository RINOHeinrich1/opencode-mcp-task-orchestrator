# Rapport — Plan `Plan-sprint-filter-roles-regles-20260922-064347`

- **Tâche** : `T-20260922-064200-e0yw` — exécution `E-T-20260922-064200-e0yw-lnf52t`
- **Projet** : `ecosystem`
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-22 06:55:43
- **Plan** : 27 étapes (A001–A027) — **27/27 done (100 %)**

---

## 1. Résumé

Demandé : (1) un **filtre par SPRINT** dans les sous-onglets « Fonctionnalités » et
« Règles métier » du panneau (options = sprints du projet + « Sans sprint », filtrage
client persisté, **0 N+1**) ; (2) une **association EXPLICITE de rôles** aux règles
métier (1..N rôles **ou** rôle GLOBAL) de bout en bout (modèle + migration idempotente
+ MCP + panneau), en **remplaçant** le champ `roles` dérivé des fonctionnalités liées.

Fait : les 27 étapes sont implémentées sur deux branches dédiées (une par repo), avec
migration idempotente (`schema.sql` **et** `migrate()`), bump de `SCHEMA_VERSION`,
exposition `roles`/`roleGlobal`/`sprintIds`, garde « ≥1 rôle OU global », filtre sprint
dans les 2 sous-onglets, colonne « Rôles » (badges / chip « Global »), formulaire règle
(multi-sélection + case « Rôle global »), et filtre rôle basé sur l'association
explicite (+ option « Global »). **`links` reste strictement inchangé** ; les requêtes
bulk (`unnest`) restent au nombre de 2 (**0 N+1** ajouté).

---

## 2. Isolation

- **Workspaces Coder** : ni `opencode-mcp-task-orchestrator` ni `opencode-observability`
  n'existent dans un workspace Coder → **composants d'infrastructure** (le MCP
  orchestrateur et le panneau de supervision), traités **sur l'hôte** conformément aux
  chemins hôtes explicitement fournis par la tâche.
- **session-guard** : `acquire` → mode `in-place` sur les 2 repos (aucune session
  parallèle détectée). Travail réalisé malgré tout en **worktree** (exigence tâche :
  le panneau live sert les statiques du working tree ; les checkouts principaux ne
  doivent pas être laissés sur une branche de travail).
- **Worktrees utilisés** :
  - MCP : `/root/.config/opencode/mcp/task-orchestrator-wt-sprint-filter-roles-regles-mcp`
    (branche `feature/sprint-filter-roles-regles-mcp`)
  - Panneau : `/tmp/opencode/orchestrator-panel-wt-sprint-filter-roles-regles-panel`
    (branche `feature/sprint-filter-roles-regles-panel`) — **relocalisé sous
    `/tmp/opencode`** car le chemin `…-wt-…` initial sortait du périmètre
    `external_directory` autorisé pour les outils d'édition.
- **Fin de traitement** : worktrees physiques **supprimés**, **branches conservées**
  (livrable pour le merge/push ultérieur), verrous session-guard **libérés**.
  ⚠️ Écart assumé à la procédure `session-guard remove` (qui supprime la branche) :
  la tâche interdit le push et désigne la branche comme livrable → la suppression de
  la branche aurait détruit le travail.

---

## 3. Branches et commits

| Repo | Branche | Base | Commit |
|---|---|---|---|
| `opencode-mcp-task-orchestrator` | `feature/sprint-filter-roles-regles-mcp` | `6e32eac` | **`6264c886f5e1ac680da24bf1a6b0173bae42c3a6`** |
| `opencode-observability` | `feature/sprint-filter-roles-regles-panel` | `68b16bd` | **`86535c4285e91ade9de38b2d52a10899851f63a2`** |

- Aucun push (merge/push = étape d'orchestration ultérieure).
- Traces des commits enregistrées via `plan_commit_add` (3 fichiers par commit, avec diff).

---

## 4. Traitements effectués

### Repo `opencode-mcp-task-orchestrator` (`schema.sql`, `db.mjs`, `index.mjs`)

| Étape | Statut | Détail |
|---|---|---|
| A001 | done | `schema.sql` : `regles_metier.roles TEXT[] NOT NULL DEFAULT '{}'` + `role_global INTEGER NOT NULL DEFAULT 0` dans le `CREATE TABLE` + miroir `ALTER … ADD COLUMN IF NOT EXISTS`. |
| A002 | done | `migrate()` : colonnes ajoutées au `CREATE TABLE` + 2 `ALTER … IF NOT EXISTS`. **Bump `SCHEMA_VERSION` → `2026-09-22-sprint-filter-roles-regles`**. |
| A003 | done | `rowToRegle` expose `roles: string[]` et `roleGlobal: boolean`. |
| A004 | done | `normalizeRuleRoles({roles, roleGlobal})` : garde « ≥1 rôle OU global », trim/dédup, rejet des chaînes vides. |
| A005 | done | `registerRule` : params `roles`/`roleGlobal`, garde, `INSERT` des colonnes. |
| A006 | done | `updateRule` : params `roles`/`roleGlobal`, **état effectif** (champ non fourni ⇒ valeur courante) puis garde. |
| A007 | done | `ruleLinkCounts` : **retrait de la sous-requête `roles` dérivée**, **ajout `sprintIds`** (même requête bulk `unnest`). |
| A008 | done | `listRules` : mappe `sprintIds`, ne surcharge plus `roles` ; `links` **strictement** `{features, sprints}`. |
| A009 | done | `featureLinkCounts` : ajout `sprintIds` (même requête bulk). |
| A010 | done | `listFeatures` : mappe `sprintIds` ; **`links` strictement inchangé** (ré-extraction explicite — cf. §7). |
| A011/A012 | done | Tools `rule_register`/`rule_update` : schema `roles` (array) + `roleGlobal` (bool) + pass-through. |
| A013/A014 | done | Descriptions `rule_get`/`rule_list`/`feature_list` mises à jour (roles explicites, `sprintIds`, dérivation retirée). |

### Repo `opencode-observability` (`pilot.mjs`, `server.mjs`, `public/app.js`)

| Étape | Statut | Détail |
|---|---|---|
| A015/A016 | done | `pilot.mjs` `createRule`/`updateRule` : pass-through `roles`/`roleGlobal` (`[]` distingué d'absent). |
| A017 | done | `server.mjs` routes `POST`/`PUT /api/rules` : lecture de `roles`/`roleGlobal`. |
| A018 | done | `frFeatureFilters`/`frRuleFilters` : clé `sprint` (état module, persisté au polling). |
| A019 | done | `frFilterFeatures` : prédicat sprint (`sprintIds` + `__none__`). |
| A020 | done | `frFilterRules` : prédicat sprint + sémantique « Global » (`__global__` ; règle globale retenue par tout rôle spécifique et par « Global », jamais « Sans rôle »). |
| A021 | done | Helper `frRuleRolesBadges` (badges rôles / chip « Global » / `—`). |
| A022 | done | `frRuleTableHtml` : colonne « Rôles » (+ `colspan` 7). |
| A023 | done | `ruleFormModal` : multi-sélection des rôles + case « Rôle global (tous les rôles) » + garde UI miroir du registre. |
| A024 | done | `renderFrRulePanel` : filtre rôle (explicite + « Global » + « Sans rôle »), filtre sprint, `projectRoles`. |
| A025 | done | `renderFrFeaturePanel` : select sprint câblé. |
| A026 | done | `renderFrSubpanel`/`renderFeaturesRules` : transmission `sprints` + `projectRoles` (0 appel réseau en plus). |

### Décisions validées appliquées
- `roles` dérivé **remplacé sans repli** (pas de backfill : les règles existantes restent « Sans rôle »).
- Vocabulaire des rôles = **rôles distincts du projet** (union `fonctionnalites.role` + rôles des règles) — pas de référentiel, pas de saisie libre.
- Modèle = **colonnes** (pas de table de liaison).
- Filtres persistés en **état module**.

---

## 5. Fichiers modifiés

| Fichier | Repo | Nature |
|---|---|---|
| `schema.sql` | MCP | +2 colonnes (CREATE + ALTER miroir) |
| `db.mjs` | MCP | `SCHEMA_VERSION`, `migrate`, `rowToRegle`, `normalizeRuleRoles`, `registerRule`, `updateRule`, `ruleLinkCounts`, `listRules`, `featureLinkCounts`, `listFeatures` |
| `index.mjs` | MCP | tools `rule_register`, `rule_update`, descriptions `rule_get`/`rule_list`/`feature_list` |
| `pilot.mjs` | Panneau | `createRule`, `updateRule` |
| `server.mjs` | Panneau | routes `POST`/`PUT /api/rules` |
| `public/app.js` | Panneau | filtres, table règles, formulaire règle, sous-panneaux |

Aucune suppression de fichier.

---

## 6. Vérifications (A027)

1. **`node --check`** : OK sur `db.mjs`, `index.mjs`, `pilot.mjs`, `server.mjs`, `public/app.js`.
2. **Spawn MCP RÉEL** (worktree, base jetable `task_registry_spawn_test`) — **14/14 PASS** :
   - garde `rule_register` sans rôle/global ⇒ **ERREUR** « au moins 1 rôle ou roleGlobal=true requis » ;
   - `rule_register` avec `roles` ⇒ persisté, `roleGlobal=false` ;
   - `rule_list` ⇒ `links` **clés strictes `{features,sprints}`**, `sprintIds` = `[sprint]`, `roles` explicites ;
   - `rule_update` `roleGlobal=true` (état effectif) ; garde `roles=[] + roleGlobal=false` ⇒ **ERREUR** ; `roles=[gamma]` ⇒ OK ;
   - `rule_get` ⇒ `roles`/`roleGlobal` exposés ;
   - `feature_list` ⇒ `sprintIds` = `[sprint]`, `links` **clés strictes** `{rules,gherkin,adrs,sprints,tasks,recettes}`.
3. **Idempotence de `migrate()`** : colonnes retirées + `schema_meta` effacé → rejeu complet OK (colonnes reposées, `schema_version` = nouvelle valeur), puis chemin rapide OK.
4. **Instance de TEST du panneau `PORT=4010`** (bases jetables `task_registry_spawn_test` + `panel_spawn_test`, `MCP_TASK_ORCHESTRATOR_PATH` → MCP du worktree) :
   - boot OK, statiques neufs servis (`frRuleRolesBadges`, `fr-f-sprint`, `fr-r-sprint`) ;
   - login OK ; `POST /api/rules` (rôles) ⇒ 201 ; `GET /api/rules` ⇒ `roles`, `roleGlobal`, `sprintIds`, `links {features,sprints}` ;
   - `PUT /api/rules/:id` `roleGlobal=true` ⇒ 200 ; `PUT` `roles=[] + roleGlobal=false` ⇒ **HTTP 400** (garde) ;
   - `POST`/`GET /api/features` ⇒ `sprintIds` + `links` intact.
   - **PM2 `orchestrator-panel` NON redémarré** (restarts/uptime inchangés ; script path = checkout principal).
5. **Bases jetables supprimées** après test (aucune pollution du registre live).
6. **ADR** : `adr_list(projectId=ecosystem)` ⇒ **0 ADR** (conforme au plan) ; aucun conflit ADR.

---

## 7. Avertissements / écarts

1. **Bug détecté et corrigé pendant A027** : `featureLinkCounts` plaçait `sprintIds` dans
   l'objet des compteurs, ce qui **fuyait `sprintIds` dans `links`** des fonctionnalités.
   `listFeatures` a été corrigé pour **ré-extraire explicitement `links`** (contrat
   strictement inchangé) ; `sprintIds` reste un champ **additif top-level**. Non détecté
   comme incohérence de plan (le plan exigeait déjà `links` inchangé) — corrigé dans la
   même sous-tâche.
2. **Garde stricte à la création (assumé, plan §9.2)** : tout appelant de `rule_register`
   (agents, scripts) qui ne fournit **ni `roles` ni `roleGlobal`** échouera désormais.
   Le formulaire panneau fournit toujours l'un des deux. À intégrer par les appelants.
3. **Bump de `SCHEMA_VERSION`** : au prochain démarrage d'un MCP **ancien** (checkout
   principal non encore déployé), `ensureSchema` rejouera son ancien schéma et
   **réécrira `schema_meta` à l'ancienne version** ; les colonnes ajoutées ne sont jamais
   supprimées (`IF NOT EXISTS`). Après merge/déploiement, le nouveau code reposera la
   version cible. Impact opérationnel **nul** sur les données ; simple churn de version.
4. **Chemins hors périmètre `external_directory`** : le worktree initial du panneau
   (`/root/orchestrator-panel-wt-…`) n'était pas éditable → relocalisé sous
   `/tmp/opencode/…`. À prévoir pour les futures sessions panneau (ou étendre la règle).
5. **`session-guard remove` non utilisé** (il supprime la branche) : worktrees retirés
   manuellement, **branches conservées**, verrous libérés.

---

## 8. État final des checkouts principaux

| Checkout | Branche | Working tree |
|---|---|---|
| `/root/.config/opencode/mcp/task-orchestrator` | `feature/migration-postgresql` | propre (hors fichiers non suivis préexistants `plans/…`, `reports/…`) |
| `/root/orchestrator-panel` | `feature/migration-postgresql` | **propre** |

Worktrees de cette sous-tâche supprimés ; PM2 `orchestrator-panel` **non redémarré**.

---

## 9. Prochaines étapes / recommandations

1. **Orchestration** : merge/push des branches
   `feature/sprint-filter-roles-regles-mcp` et `feature/sprint-filter-roles-regles-panel`
   (synchroniser d'abord sur `feature/migration-postgresql`).
2. **Déploiement** : après déploiement du nouveau MCP, le premier appel appliquera la
   migration (colonnes `roles`/`role_global`) et écrira `schema_version`
   `2026-09-22-sprint-filter-roles-regles`.
3. **Backfill optionnel** (non retenu) : reprendre `array_agg(DISTINCT fonctionnalites.role)`
   pour les règles à `roles='{}' AND role_global=0` si le confort d'affichage prime
   (décision utilisateur).
4. **E2E** : aucun dépôt `ecosystem` ne contient de config Playwright ⇒ **E2E NA**.
