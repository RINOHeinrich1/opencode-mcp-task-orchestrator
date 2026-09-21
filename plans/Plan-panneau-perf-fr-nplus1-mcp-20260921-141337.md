# Plan — Panneau : performance de l'onglet Fonctionnalités / Règles métier (suppression du N+1 de 55 requêtes + réduction du coût fixe par appel MCP)

- **taskId** : `T-20260921-140612-t8ub` (exécution `E-T-20260921-140612-t8ub-vklw72`)
- **Projet** : `ecosystem`
- **Type** : `debug` (performance) — **un seul plan** (objectifs interdépendants, cf. §0)
- **Repos** (hôtes, pas de workspace Coder) :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (branche de déploiement `feature/migration-postgresql`) → `db.mjs`, `index.mjs`, `schema.sql`, `scripts/`
  - `opencode-observability` = `/root/orchestrator-panel` (branche de déploiement `feature/migration-postgresql`) → `mcp-client.mjs`, `server.mjs`, `public/app.js`, `scripts/` (nouveau)
- **Branche de travail** : dédiée **par repo** (via `session-guard` / worktree), basée sur `feature/migration-postgresql`. **Jamais** de modification directe de la branche principale.
  ⚠️ **Isolation panneau** : le process PM2 `orchestrator-panel` (id 4, `node /root/orchestrator-panel/server.mjs`) sert les **statiques du working tree**. Ne **jamais** laisser le checkout principal `/root/orchestrator-panel` sur une branche de travail ; ne **pas** redémarrer le PM2 live pendant le build (vérifier sur une instance de test `PORT=4010`, cf. A015).
- **Périmètre réservé (scope)** : `db.mjs`, `index.mjs`, `schema.sql` (registre) ; `mcp-client.mjs`, `server.mjs`, `public/app.js` (panneau).
  **Extension de périmètre justifiée** : `scripts/bench-fr-load.mjs` (repo panneau, dossier `scripts/` **à créer**) — banc de mesure reproductible exigé par le critère d'acceptation « mesures avant/après fournies » ; chemin neuf ⇒ aucun risque de conflit.
- **Racine des plans** : `/root/.config/opencode/mcp/task-orchestrator`
- **Tâche liée (source)** : `T-20260921-120633-mtl2` (relation `emergent`). **Nature de la liaison** : c'est là qu'a été livré le **sous-onglet Fonctionnalités / Règles métier**, et précisément `loadFeatureRuleLinkIndex()` + la colonne « Liens » + les filtres « sans lien » (plan `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443.md`, étape **A003** — qui a remplacé l'ancien remplissage **paresseux** `enrichLinkCells()` par un index **systématique** des 55 entités). Le présent plan **corrige la performance** de ce qui a été livré là — il ne le réécrit pas.
- **ADR** : `adr_list({ projectId: 'ecosystem' })` → **0 ADR** au registre sur ce périmètre ; `adr_search` (« schéma migration MCP performance ») → **0 résultat**. **Aucune ADR Accepté n'est contredite.**
- **Date** : 2026-09-21 14:13:37

---

## 0. Pourquoi UN SEUL plan (segmentation des objectifs)

Trois objectifs ont été identifiés :

| # | Objectif | Interdépendance |
|---|---|---|
| O1 | Supprimer le N+1 : index des liens construit en **1 seul appel** (plus de 55) | Touche `db.mjs` (listFeatures/listRules) |
| O2 | Réduire le **coût fixe par appel MCP** (persistant/pool **et** version-skip du schéma) | Touche `db.mjs` (ensureSchema) + `mcp-client.mjs` |
| O3 | **Mesurer** avant/après et **prouver** `< 1 s` | Dépend de O1 **et** O2 (le critère d'acceptation est un résultat **conjoint**) |

**O1 et O2 partagent le même fichier `db.mjs`** (conflit de fichier ⇒ non parallélisables) et **O3 est le critère d'acceptation commun** (`chargement de l'onglet < 1 s`, `appel MCP simple nettement réduit`). Ce sont donc des objectifs **interdépendants** ⇒ **un plan unique** avec deux chantiers ordonnés + une phase de mesure (règle « des objectifs interdépendants = un seul plan »). Produire 2 plans créerait un conflit d'écriture sur `db.mjs` que la matrice de conflit du batch signalerait, sans bénéfice de parallélisme.

---

## 1. Objectif

Rendre le chargement de l'onglet **Fonctionnalités / Règles métier** du panneau **< 1 s** sur `myxmax` (45 fonctionnalités + 10 règles) en (1) construisant l'**index des liens en un seul appel** au lieu de 55, et (2) **réduisant le coût fixe par appel MCP** (process MCP **persistant** et **saut du rejeu `schema.sql` + `migrate()`** via un marqueur de version en base), sans introduire de cache de données périmable et sans casser l'idempotence du schéma.

---

## 2. Contexte & raison d'être

### 2.1 Diagnostic vérifié dans le code (ancrage obligatoire)

**Cause 1 — N+1 côté panneau.** `loadFeatureRuleLinkIndex(features, rules)` (`public/app.js` **l.5188-5222**) construit l'index des liens en appelant **un endpoint par entité** : `GET /api/features/:id` (45×) + `GET /api/rules/:id` (10×) = **55 requêtes**, avec une concurrence bornée à **4** (`app.js` **l.5217-5219**) ⇒ ~14 vagues. Chaque route proxifie un appel MCP (`server.mjs` **l.2006-2010** et **l.2050-2054** → `pilot.getFeature`/`getRule` → `feature_get`/`rule_get`). Appelé depuis `renderFeaturesRules()` (`app.js` **l.5570**).

**Cause 2 — coût fixe ~0,7 s PAR appel MCP.** `mcp-client.mjs` **l.43-116** `callTool()` fait `spawn(cmd[0], cmd.slice(1), …)` **à chaque appel** (l.49) : `initialize` + `notifications/initialized` + `tools/call` + `child.kill()` (l.96-110). Or `db.mjs` **l.28-41** `ensureSchema()` applique **paresseusement** `schema.sql` (913 lignes, **61 CREATE TABLE**, **68 CREATE INDEX**) **puis** `migrate()` (**l.44-714**, **77 `ALTER TABLE`**) au **premier accès DB de chaque process** ; le flag `_schemaReady` (l.29) **meurt avec le process**.

### 2.2 Mesures de RÉFÉRENCE (capturées par le planificateur, lecture seule, 2026-09-21)

| Mesure | Commande | Résultat |
|---|---|---|
| Démarrage Node nu | `time node -e 1` | **0,037 s** |
| Import `db.mjs` (pg + better-sqlite3 + env) | `time node -e "await import('…/db.mjs')"` | **0,166 s** |
| **`ensureSchema` 1er accès DB** (schema.sql + migrate) | `db.listFeatures()` puis `db.listFeatures()` **dans le même process** | **244 ms** (1er) vs **4 ms** (2e) |
| Appel MCP trivial `org_list` | `taskOrchestrator('org_list', {})` | **0,718 s** |
| `feature_list` myxmax (45) | `taskOrchestrator('feature_list', {projectId:'myxmax'})` | **0,826 s** |
| `rule_list` myxmax (10) | `taskOrchestrator('rule_list', {projectId:'myxmax'})` | **0,711 s** |
| `feature_get` (1 entité) | `taskOrchestrator('feature_get', …)` | **~0,69 s** |
| **Onglet FR myxmax** (55 appels / concurrence 4) | 55 × ~0,69 s / 4 | **~11 s** ✅ reproduit |

**Décomposition du coût fixe** : ~0,04 s (node) + ~0,13 s (import modules) + **~0,24 s (rejeu schéma)** + ~0,3 s (bootstrap serveur MCP + enregistrement des ~200 tools zod + handshake JSON-RPC) ≈ **0,7 s**, **payé 55 fois** pour un seul onglet.

### 2.3 Objectifs mesurables

- **1 seul appel** (0 appel supplémentaire) pour l'index des liens.
- Appel MCP simple : **< 0,05 s** (process chaud, schéma vérifié) au lieu de 0,72 s.
- Onglet FR myxmax : **< 1 s** (cible d'acceptation).

### 2.4 Choix de conception tranchés (à respecter par l'exécution)

1. **N+1 → enrichissement des listes (et non un nouveau tool bulk).** `feature_list` / `rule_list` renvoient un champ **additif** `links` (compteurs) par entité, calculé par **une requête SQL bulk**. Le panneau **ne fait plus aucun appel réseau** pour l'index : il dérive l'index du payload des listes qu'il **fetchait déjà** (`app.js` l.5546-5555). Bénéfices : **0 route nouvelle**, **0 tool nouveau**, **0 appel réseau supplémentaire**, données **toujours fraîches** (compatibles `refreshActive()` / polling 10 s). *Alternative écartée* : un tool `feature_rule_links_index` dédié — il aurait ajouté 1 route + 1 tool + 1 appel réseau pour un résultat identique.
2. **Coût fixe → les DEUX mécanismes (a + b), complémentaires.** (a) **Marqueur de version de schéma EN BASE** (`schema_meta`) : `ensureSchema()` lit une ligne (~2 ms) et **saute** `schema.sql` + `migrate()` si la version correspond ; (b) **process MCP persistant** par `(serveur, lane)` : le `spawn` + `initialize` + bootstrap + pool PG sont **amortis sur toute la vie du panneau**. Le (a) accélère même le **1er** appel (process neuf) ; le (b) supprime le coût des appels suivants.
3. **Marqueur EN BASE, pas de cache disque.** Un cache disque peut être **périmé par rapport à la base** (base restaurée/réinitialisée ⇒ skip à tort, schéma absent). Le marqueur vit **dans la base qu'il décrit** ⇒ toujours cohérent. `SCHEMA_VERSION` est une constante de code, **à incrémenter à chaque évolution de `schema.sql`/`migrate()`** (documenté dans le code) : version différente ⇒ **apply complet** (idempotent).
4. **Garde d'idempotence.** Apply complet sous **verrou advisory PostgreSQL** (`pg_advisory_lock`) + **re-vérification** du marqueur après acquisition : deux process concurrents ne rejouent pas les ~130 DDL en parallèle. Toutes les DDL restent `IF NOT EXISTS` (rejeu inoffensif). Le marqueur n'est écrit **qu'après** un apply réussi ; `_schemaPromise` est **réinitialisé** en cas d'échec (retentative au prochain appel).
5. **`migrate()` reste la source des évolutions DDL** — aucune DDL déplacée ; seule la **décision de l'exécuter** change.
6. **Aucun cache de RÉSULTAT de tool.** Le client persistant ne mémoïse **rien** : chaque appel lit le registre (source de vérité unique). Seuls le **process** et le **pool de connexions** sont réutilisés.
7. **Lane dédiée pour les appels longs.** `LONG_CALL_TOOLS` (`e2e_run`, `e2e_sync_repo`, timeout 20 min, `mcp-client.mjs` l.21-22) sont routés vers un **process persistant distinct** afin qu'un run Playwright de 20 min ne bloque pas le canal principal.
8. **Chemins MCP surchargeables par env** (`MCP_TASK_ORCHESTRATOR_PATH`, `MCP_CODER_WORKSPACES_PATH`), **défaut inchangé** : indispensable pour vérifier le MCP d'un **worktree** sans toucher au checkout principal (norme d'isolation) et pour tester.
9. **Repli non bloquant préservé.** Si `links` est **absent** du payload (registre non encore déployé), le panneau **n'invente pas** de compteurs : l'entité est absente de l'index ⇒ colonne « Liens » = `—` (exactement le repli actuel documenté l.5186-5187), + un `console.warn` **unique** pour rendre le décalage de déploiement visible.
10. **Aucune signature existante modifiée.** `callTool`/`taskOrchestrator`/`coderWorkspaces` gardent leur signature (131 sites d'appel dans `pilot.mjs`) ; `listFeatures`/`listRules`/`feature_list`/`rule_list` restent **additifs**.

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|---|---|---|---|---|---|---|
| A001 | créer | `scripts/bench-fr-load.mjs` — banc de mesure reproductible : (1) appel MCP simple ×3 (froid/chaud), (2) `feature_list`+`rule_list` myxmax, (3) **simulation de l'ANCIEN chemin** (55 appels `feature_get`/`rule_get`, concurrence 4), (4) **nouveau chemin** (8 appels `pilot` de l'onglet, `Promise.all`) | `scripts/` (nouveau) | `scripts/bench-fr-load.mjs` | Exiger une preuve avant/après **reproductible** (AC3) — **à exécuter AVANT tout autre changement** | Banc exécutable `node scripts/bench-fr-load.mjs myxmax`, sortie tableau ms |
| A002 | ajouter | table `schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)` — en **tête** de fichier (après l'entête l.1-4, avant `tasks` l.7) | `schema.sql` | `schema.sql` | Miroir **logique** du marqueur de version (une base neuve le crée dès le 1er apply) | DDL `schema_meta` dans `schema.sql` |
| A003 | modifier | `ensureSchema()` (l.28-41) : constante `SCHEMA_VERSION`, `readSchemaVersion()`, `writeSchemaVersion()`, **skip** si marqueur == version, sinon **apply complet sous `pg_advisory_lock`** + re-check + écriture du marqueur ; reset de `_schemaPromise` en cas d'échec | `db.mjs` | `db.mjs` | **Supprimer le rejeu de `schema.sql` (913 l.) + `migrate()` (77 ALTER) à chaque process** ; l'idempotence est **préservée** (version différente ⇒ apply) | `ensureSchema` : ~2 ms en régime établi, apply complet si version absente/différente |
| A004 | créer | helper interne `featureLinkCounts(ids)` — **1 requête** `SELECT … FROM unnest($1::text[]) AS i(id)` + 6 sous-requêtes `count(*)` (`fonctionnalite_regles`, `fonctionnalite_gherkin`, `fonctionnalite_adr`, `sprint_fonctionnalites`, `task_fonctionnalites`, `recette_fonctionnalites`) → `{ [id]: {rules, gherkin, adrs, sprints, tasks, recettes} }` | `db.mjs` (après `getFeature`, l.1954) | `db.mjs` | Fournir les compteurs **en une requête** (pas de N+1 SQL) | Helper `featureLinkCounts` |
| A005 | modifier | `listFeatures()` (l.1958-1977) : après `rows.map(rowToFonctionnalite)`, fusionner `links` via `featureLinkCounts(ids)` | `db.mjs` | `db.mjs` | Porter les compteurs avec la liste (⇒ **0 appel** côté panneau) | `feature_list` renvoie `features[].links` |
| A006 | créer | helper interne `ruleLinkCounts(ids)` — **1 requête** `unnest($1::text[])` + 2 sous-requêtes `count(*)` (`fonctionnalite_regles`, `sprint_regles`) → `{ [id]: {features, sprints} }` | `db.mjs` (après `featureLinkCounts`) | `db.mjs` | Idem pour les règles | Helper `ruleLinkCounts` |
| A007 | modifier | `listRules()` (l.2118-2137) : fusionner `links` via `ruleLinkCounts(ids)` | `db.mjs` | `db.mjs` | Porter les compteurs avec la liste | `rule_list` renvoie `rules[].links` |
| A008 | modifier | description du tool `feature_list` (l.977) : documenter le champ **additif** `links` (`{rules,gherkin,adrs,sprints,tasks,recettes}`) ; **`inputSchema` inchangé** | `index.mjs` | `index.mjs` | Rendre le contrat lisible par les agents (aucun changement d'entrée) | Description `feature_list` à jour |
| A009 | modifier | description du tool `rule_list` (l.1054) : documenter `links` (`{features,sprints}`) ; **`inputSchema` inchangé** | `index.mjs` | `index.mjs` | Idem pour les règles | Description `rule_list` à jour |
| A010 | remplacer | `loadFeatureRuleLinkIndex(features, rules)` (l.5188-5222) → `buildFeatureRuleLinkIndex(features, rules)` **synchrone, sans réseau** : `index.features[f.id] = f.links` si `f.links` défini (sinon entité **absente** de l'index = repli `—`) ; idem `index.rules[r.id] = r.links`. Mettre à jour le commentaire l.5180-5187 | `public/app.js` | `public/app.js` | **Supprimer les 55 requêtes** : l'index est dérivé du payload déjà reçu | `buildFeatureRuleLinkIndex` (pur, sans `fetch`) |
| A011 | modifier | appel l.5570 : `const linkIndex = buildFeatureRuleLinkIndex(features, rules);` (supprimer l'`await`) + `console.warn` unique si `features.length && !features[0].links` | `public/app.js` | `public/app.js` | Brancher le nouvel index ; rendre visible un décalage de déploiement registre/panneau | `renderFeaturesRules` : **0 appel réseau** pour l'index |
| A012 | remplacer | `callTool()` (l.43-116) → **client MCP persistant par `(serveur, lane)`** : `getClient()` (spawn paresseux), `initialize` **une seule fois**, multiplexage des `id` (map `pending` conservée), `respawn` si le process meurt, **kill du client sur timeout** (un process partagé ne doit pas rester bloqué), `closeAllMcpClients()` exporté + hook `process.on("exit")` (kill sync) ; `parseToolResult` (l.26-41) **inchangé** ; `MCP_SERVERS` (l.11-14) surchargé par env (`MCP_TASK_ORCHESTRATOR_PATH`, `MCP_CODER_WORKSPACES_PATH`), défaut **inchangé** ; lane `long` pour `LONG_CALL_TOOLS` | `mcp-client.mjs` | `mcp-client.mjs` | Amortir `spawn` + bootstrap MCP + `initialize` + pool PG sur la vie du process | Appels 2..N ≈ 0,01–0,03 s |
| A013 | modifier | `server.mjs` : handler `SIGTERM`/`SIGINT` (près de `server.listen`, l.2915) → `await closeAllMcpClients()` puis `process.exit(0)` | `server.mjs` | `server.mjs` | **Ne pas laisser de process MCP orphelins** au redémarrage PM2 | Arrêt propre du panneau |
| A014 | exécuter | **Mesures APRÈS** : `node scripts/bench-fr-load.mjs myxmax` avec `MCP_TASK_ORCHESTRATOR_PATH=<worktree registre>/index.mjs` ; `node --check` sur `db.mjs`, `index.mjs`, `mcp-client.mjs`, `server.mjs`, `public/app.js`, `scripts/bench-fr-load.mjs` ; smoke MCP réel (`org_list`, `feature_list`, `rule_list`) ; vérif **idempotence** (2e exécution = même schéma, marqueur stable) ; vérif **compteurs inchangés** (comparer `links` aux longueurs rendues par `feature_get`/`rule_get` sur un échantillon) | — | — | Prouver AC3 + AC4 | Sortie de banc « après » + logs de vérification |
| A015 | exécuter | **Vérification d'intégration panneau** sur instance de TEST : `PORT=4010 MCP_TASK_ORCHESTRATOR_PATH=<worktree>/index.mjs node server.mjs` (depuis le worktree panneau) → charger `/api/features`, `/api/rules` puis l'onglet ; **NE PAS** redémarrer le PM2 live ni laisser `/root/orchestrator-panel` sur une branche de travail | — | — | Prouver `< 1 s` **de bout en bout** sans toucher au panneau live | Mesure HTTP de l'onglet < 1 s |
| A016 | créer | rapport `reports/report-perf-fr-load-<ts>.md` : tableau **avant/après**, commandes exactes, preuve `< 1 s`, vérifs de non-régression, note de déploiement (registre puis panneau puis `pm2 restart orchestrator-panel`) | — | `reports/report-perf-fr-load-<ts>.md` | Traçabilité de la preuve exigée par AC3 | Rapport de mesures |

---

## 4. Fichiers concernés

| Fichier | Repo | Type de modification |
|---|---|---|
| `schema.sql` | registre | modification (ajout table `schema_meta` en tête) |
| `db.mjs` | registre | modification (`ensureSchema` l.28-41 ; helpers A004/A006 ; `listFeatures` l.1958-1977 ; `listRules` l.2118-2137) |
| `index.mjs` | registre | modification (descriptions `feature_list` l.977, `rule_list` l.1054) |
| `mcp-client.mjs` | panneau | refonte (`callTool` l.43-116 ; `MCP_SERVERS` l.11-14 ; nouvel export `closeAllMcpClients`) |
| `server.mjs` | panneau | modification (handlers d'arrêt, près de l.2915) |
| `public/app.js` | panneau | modification (l.5180-5222 remplacé ; l.5570) |
| `scripts/bench-fr-load.mjs` | panneau | **création** (dossier `scripts/` à créer) |
| `reports/report-perf-fr-load-<ts>.md` | registre | **création** |
| `plans/Plan-panneau-perf-fr-nplus1-mcp-20260921-141337.md` | registre | **création** (ce plan) |

**Aucune suppression de fichier.** Aucune table supprimée, aucune colonne supprimée, aucune signature modifiée.

---

## 5. Livrables attendus

1. `feature_list` et `rule_list` renvoient `links` (compteurs) par entité — calculés en **1 requête SQL bulk** chacun.
2. `public/app.js` : `buildFeatureRuleLinkIndex()` **synchrone**, **0 appel réseau** (les 55 appels disparaissent) ; colonne « Liens » et filtres « sans lien » **inchangés à l'écran** (mêmes compteurs).
3. `db.mjs` : `ensureSchema()` **saute** `schema.sql` + `migrate()` quand `schema_meta.schema_version == SCHEMA_VERSION` ; apply complet + verrou advisory sinon ; idempotence **prouvée** par 2 exécutions successives.
4. `mcp-client.mjs` : client MCP **persistant** (par serveur et par lane) ; appels 2..N ≈ **0,01–0,03 s** ; `closeAllMcpClients()` ; arrêt propre côté `server.mjs`.
5. `scripts/bench-fr-load.mjs` : banc reproductible **avant/après**.
6. `reports/report-perf-fr-load-<ts>.md` : tableau de mesures prouvant **onglet myxmax < 1 s** et **appel MCP simple nettement réduit**.
7. **Non-régression** : `node --check` OK sur les 6 fichiers ; spawn MCP réel OK ; onglets/routes/sessions du panneau fonctionnels ; compteurs de liens **inchangés**.

---

## 6. Ordre & dépendances

```
A001 (banc — MESURE AVANT, obligatoirement avant tout changement)
  ↓
A002 (schema_meta dans schema.sql)
  ↓
A003 (ensureSchema : version-skip + verrou)   ← chantier « coût fixe » (a)

A004 (featureLinkCounts) → A005 (listFeatures.links)
A006 (ruleLinkCounts)    → A007 (listRules.links)
A008 (desc feature_list)   A009 (desc rule_list)      ← indépendants

A010 (buildFeatureRuleLinkIndex) → A011 (appel l.5570)   ← A011 EXIGE A010

A012 (client MCP persistant)   A013 (arrêt propre server.mjs)
  ↓
A014 (mesures APRÈS + node --check + idempotence + compteurs)
  ↓
A015 (instance panneau de test PORT=4010 → preuve < 1 s)
  ↓
A016 (rapport de mesures)
```

**Prérequis explicites** : A005 ⟸ A004 · A007 ⟸ A006 · A011 ⟸ A010 · A014 ⟸ {A003, A005, A007, A008, A009, A011, A012, A013} · A015 ⟸ A014 · A016 ⟸ A015.
**Indépendances parallélisables** : {A004→A005, A006→A007} ∥ {A008, A009} ∥ {A010→A011} ∥ {A012, A013} — mais **toutes** précèdent A014.

---

## 7. Couverture des objectifs (100 %)

| Exigence (critère d'acceptation de la tâche) | Étape(s) | Couvert ? |
|---|---|---|
| **AC1** — index des liens construit en **UN SEUL appel** réseau (plus de N+1 de 55) | A004, A005, A006, A007, A010, A011 | ✅ |
| **AC2a** — plus de rejeu de `schema.sql` + `migrate()` à chaque appel (marqueur de version) | A002, A003 | ✅ |
| **AC2b** — process MCP persistant / pool | A012, A013 | ✅ |
| **AC3** — mesures avant/après : onglet myxmax (45+10) **< 1 s** ; appel MCP simple **nettement réduit** | A001 (avant), A014 (après), A015 (bout en bout), A016 (rapport) | ✅ |
| **AC4** — non-régression : onglets/routes/sessions OK, `node --check` OK, spawn MCP réel OK, idempotence du schéma préservée, compteurs de liens inchangés | A003 (idempotence + repli), A010 (repli `—` non bloquant), A014 (vérifs), A015 (onglet réel) | ✅ |
| **AC5** — pas de cache de données périmable sans invalidation (compat. `refreshActive()`) | A005/A007 (compteurs recalculés à **chaque** appel), A012 (aucun cache de résultat de tool), A010 (index dérivé du payload **frais** de chaque rendu) | ✅ |
| **AC6** (contrainte) — source de vérité unique : toute écriture via le MCP | A003 (aucune écriture métier : marqueur de schéma technique, idempotent), A012 (client persistant **lecture seule** côté panneau, aucune écriture directe en base) | ✅ |
| **AC7** (cadre) — traçabilité : `task_event` + `plan_register(taskId)` + `artifact_add(kind=plan)` | Phase 8 (faite par le planificateur) | ✅ |

**Aucune exigence non couverte.** Pas de hors-périmètre déclaré.

---

## 8. Vérification de cohérence

### 8.1 Intra-plan (Phase 6)

Regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `db.mjs` → `ensureSchema()` (l.28-41) | A003 seule | ✅ pas de conflit |
| `db.mjs` → nouveaux helpers `featureLinkCounts`/`ruleLinkCounts` | A004, A006 (éléments **distincts**) | ✅ |
| `db.mjs` → `listFeatures()` (l.1958-1977) | A005 seule | ✅ |
| `db.mjs` → `listRules()` (l.2118-2137) | A007 seule | ✅ |
| `index.mjs` → description `feature_list` / `rule_list` | A008 / A009 (éléments distincts) | ✅ |
| `public/app.js` → `loadFeatureRuleLinkIndex` (l.5188-5222) | A010 seule (remplacement) | ✅ |
| `public/app.js` → appel l.5570 | A011 seule | ✅ |
| `mcp-client.mjs` → `callTool` (l.43-116) / `MCP_SERVERS` (l.11-14) | A012 / A012 (même étape) | ✅ |
| `server.mjs` → handlers d'arrêt | A013 seule | ✅ |
| `schema.sql` → table `schema_meta` | A002 seule | ✅ |

Contrôles de contradiction :
- **Aucune action `supprimer`** dans le plan ⇒ pas de conflit `supprimer` + autre action.
- **Aucun `créer` suivi de `renommer`** ⇒ pas de doublon à fusionner.
- **Aucun `déplacer`** ⇒ pas de conflit `déplacer` + `supprimer`.
- **Aucune lecture d'un élément créé par une étape ultérieure** : A011 lit `buildFeatureRuleLinkIndex` **créé par A010** (A010 → A011 ✅) ; A005 lit `featureLinkCounts` **créé par A004** (A004 → A005 ✅) ; A007 lit `ruleLinkCounts` **créé par A006** (A006 → A007 ✅).
- **A001 doit précéder TOUTE modification** (c'est la mesure « avant ») — contrainte d'ordre explicite, pas une contradiction.
- ⚠️ **Point d'attention levé** : A003 (version-skip) **modifie le régime de latence** que A001 doit mesurer ⇒ A001 est **imposé en premier** (§6). Sans cela, la référence « avant » serait faussée.

### 8.2 Plan Validator (Phase 7) — gate

- Contradiction non résolue : **aucune** ✅
- Exigence non couverte : **aucune** (§7) ✅
- Étape vague/imprécise : **aucune** (chaque étape = 1 verbe × 1 élément × 1 fichier, avec lignes, raison et livrable) ✅
- **Verdict : Valid** → Phase 8.

### 8.3 Globale (Phase 9)

**Un seul plan produit** ⇒ pas de contradiction inter-plans possible. Vérifié tout de même : les éléments touchés des deux repos sont **disjoints** (aucun fichier n'est partagé entre deux plans, puisqu'il n'y a qu'un plan).

---

## 9. Risques & notes

| Risque | Mitigation prévue dans le plan |
|---|---|
| **Process MCP persistant = fuite mémoire / process zombie** | `respawn` sur mort du process ; `kill` du client sur timeout ; `closeAllMcpClients()` + hook `process.on("exit")` (A012) ; handler `SIGTERM`/`SIGINT` côté panneau (A013) |
| **`e2e_run` (20 min) bloque le canal partagé** | Lane `long` dédiée pour `LONG_CALL_TOOLS` (A012) |
| **Marqueur de version périmé** (table supprimée manuellement sans bump) | `SCHEMA_VERSION` **à incrémenter à chaque évolution DDL** — documenté dans le code et dans `schema.sql` ; toute version différente ⇒ apply complet idempotent |
| **Deux process appliquent le schéma en parallèle** | `pg_advisory_lock` + re-check du marqueur après acquisition (A003) ; toutes les DDL restent `IF NOT EXISTS` |
| **Déploiement panneau avant registre** (champ `links` absent) | Repli **non bloquant** : colonne « Liens » = `—` (comportement actuel en cas d'échec) + `console.warn` unique (A011). **Ordre recommandé** : registre → panneau → `pm2 restart orchestrator-panel` |
| **Redémarrage du PM2 live pendant le build** | Interdit : vérification sur **instance de test `PORT=4010`** avec `MCP_TASK_ORCHESTRATOR_PATH` pointant le worktree (A015) |
| **Checkout principal laissé sur une branche de travail** | Travail en **worktree** ; `/root/orchestrator-panel` reste sur `feature/migration-postgresql` (le panneau live sert ses statiques) |
| **Le banc écrit-il en base ?** | Non : uniquement des **lectures** (`org_list`, `feature_list`, `rule_list`, `feature_get`, `rule_get`) |

---

## 10. Tests E2E Playwright — analyse d'impact

**Verdict : E2E NA.**

- Le repo `opencode-observability` (`/root/orchestrator-panel`) **ne contient aucun `playwright.config.*` ni dossier `tests/`** (vérifié) ; `e2e_list({ project: 'ecosystem' })` → **0 test** enregistré.
- La tâche est de nature **performance / infrastructure** : le comportement observable est une **latence** et des **compteurs inchangés**, pas un parcours utilisateur nouveau.
- **Aucune création « en aveugle »** : pas de `e2e_test_register`, pas de `e2e_test_link` (aucun harnais Playwright dans ce repo ⇒ un scénario serait inexécutable).
- **Substitut de vérification retenu** (explicité, traçable) : `scripts/bench-fr-load.mjs` (mesures avant/après) + vérification d'intégration sur instance de test `PORT=4010` (A015) + `node --check` + smoke MCP réel (A014).

---

## 11. Mesures de référence attendues (avant → après)

| Métrique | Avant (mesuré) | Après (cible) | Mécanisme |
|---|---|---|---|
| Appel MCP **1er** (process neuf) | 0,718 s | **≤ 0,50 s** | A003 (skip schéma ≈ −0,24 s) |
| Appel MCP **suivant** (process chaud) | 0,718 s | **≤ 0,05 s** | A012 (persistant) + A003 (version-skip) |
| `ensureSchema` régime établi | 244 ms | **≤ 5 ms** | A003 (1 `SELECT` sur `schema_meta`) |
| `feature_list` myxmax (45) | 0,826 s | **≤ 0,10 s** | A005 + A012 |
| `rule_list` myxmax (10) | 0,711 s | **≤ 0,05 s** | A007 + A012 |
| Requêtes pour l'index des liens | **55** | **0** | A010/A011 |
| **Onglet FR myxmax (45+10)** | **~11 s** | **< 1 s** (attendu ≈ 0,1–0,4 s) | A010/A011 + A012 + A003 |
