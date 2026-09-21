# Rapport — Performance onglet Fonctionnalités / Règles métier (N+1 + coût fixe MCP)

- **Plan** : `Plan-panneau-perf-fr-nplus1-mcp-20260921-141337` (16 étapes A001–A016)
- **Tâche** : `T-20260921-140612-t8ub` (exécution `E-T-20260921-140612-t8ub-vklw72`)
- **Projet** : `ecosystem`
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 14:29:52
- **Résultat** : ✅ **Onglet FR myxmax (45+10) < 1 s** — 611 ms à froid / 108 ms à chaud (cible < 1 s).

---

## 1. Résumé

**Demandé** : supprimer le N+1 de 55 requêtes du chargement Fonctionnalités/Règles et réduire le coût fixe
par appel MCP (~0,7 s), sans cache de données périmable ni perte d'idempotence du schéma.

**Fait** :
1. **N+1 supprimé** — `feature_list`/`rule_list` renvoient un champ additif `links` (compteurs) calculé en
   **1 requête SQL bulk** (`unnest($1::text[])` + sous-requêtes `count(*)`). Le panneau dérive l'index
   localement via `buildFeatureRuleLinkIndex()` **synchrone, 0 appel réseau** (les 55 appels disparaissent).
2. **Coût fixe réduit (a)** — table `schema_meta` + `SCHEMA_VERSION` : `ensureSchema()` saute le rejeu de
   `schema.sql` + `migrate()` (~240 ms) quand le marqueur est à jour ; apply complet sous `pg_advisory_lock`
   sinon (+ re-check + marqueur écrit après succès).
3. **Coût fixe réduit (b)** — client MCP **persistant** par `(serveur, lane)` dans `mcp-client.mjs`
   (`getClient` paresseux, `initialize` unique, multiplexage des `id`, respawn si mort, kill sur timeout,
   `closeAllMcpClients()` + hook `exit`), chemins surchargeables par env, lane `long` pour `e2e_run`.
   Handlers `SIGTERM`/`SIGINT` dans `server.mjs`.
4. **Mesures avant/après**, `node --check` (6/6), idempotence, compteurs inchangés, smoke MCP réel et
   vérification d'intégration sur instance de test `PORT=4010`.

---

## 2. Isolation (norme v1.0)

- **Espace Coder** : les deux repos sont **hôtes** (outillage d'infrastructure — panneau de supervision et
  registre MCP), **absents de tout workspace Coder** (`workspace_list` vérifié : seuls mada-talk, ONIRIA,
  myxmax, affelyos… y figurent). Travail sur l'hôte **assumé et conforme au plan** (§ en-tête du plan :
  « Repos (hôtes, pas de workspace Coder) »).
- **`session-guard acquire`** : `in-place` sur les deux repos (aucune session parallèle détectée).
- **Worktrees créés** (décision imposée par la contrainte « ne pas laisser le checkout principal sur une
  branche de travail / le panneau live sert les statiques du working tree ») :

| Repo | Checkout principal | Worktree | Branche dédiée |
|---|---|---|---|
| `opencode-observability` | `/root/orchestrator-panel` | `/root/orchestrator-panel-wt-panel-perf-fr-nplus1` | `build-notify/panel-perf-fr-nplus1` |
| `opencode-mcp-task-orchestrator` | `/root/.config/opencode/mcp/task-orchestrator` | `/root/.config/opencode/mcp/task-orchestrator-wt-mcp-perf-fr-nplus1` | `build-notify/mcp-perf-fr-nplus1` |

- `node_modules` **symlinkés** depuis les checkouts principaux dans chaque worktree (non suivis ; le symlink
  du worktree panneau est neutralisé par `.git/info/exclude`).
- **PM2 id 4 `orchestrator-panel` NON redémarré** (uptime 12:03 conservée, restarts=51 inchangé).
- **Verrous libérés** (`session-guard release`) en fin de traitement. ⚠️ **Pas de `remove`** : `remove`
  supprime le worktree **et la branche** (`git branch -D`) — or la consigne est de **ne pas pousser** et de
  laisser le merge/push à l'orchestration ultérieure : les branches non poussées auraient été perdues. Les
  worktrees + branches sont donc **conservés** pour l'étape de merge.

---

## 3. Branches et commits

### `opencode-mcp-task-orchestrator` — branche `build-notify/mcp-perf-fr-nplus1`
- Base : `e576bb75bfe66ff4a51d6f3635b47d30dbf2321e`
- **`b77cbeb19d6216e703feb859566f23f497eea264`** — *perf(mcp): skip rejeu schéma via schema_meta + compteurs `links` bulk sur feature_list/rule_list (A002-A009)*
  - `db.mjs` (+125 −6), `index.mjs` (+2 −2), `schema.sql` (+11 −0)

### `opencode-observability` — branche `build-notify/panel-perf-fr-nplus1`
- Base : `281acc969e0cfca32ca7e3906a32d25e50da3eba`
- **`4fd70a009cb433c11ac730494512801384509e26`** — *perf(panneau): onglet Fonctionnalités/Règles sans N+1 (index dérivé de `links`) + client MCP persistant (A001,A010-A013)*
  - `mcp-client.mjs` (+143 −74), `public/app.js` (+21 −41), `server.mjs` (+12 −0), `scripts/bench-fr-load.mjs` (+163, nouveau)

> **Non poussé** (conforme à la consigne) — merge/push = étape d'orchestration ultérieure.

---

## 4. Traitements effectués (16/16)

| Étape | Statut | Détail |
|---|---|---|
| A001 | ✅ | `scripts/bench-fr-load.mjs` créé + **mesures AVANT** exécutées |
| A002 | ✅ | `schema_meta (key,value,updated_at)` ajoutée en tête de `schema.sql` |
| A003 | ✅ | `ensureSchema()` : `SCHEMA_VERSION`, `readSchemaVersion`/`writeSchemaVersion`, skip si version OK, apply sous `pg_advisory_lock` + re-check, reset de `_schemaPromise` sur échec |
| A004 | ✅ | `featureLinkCounts(ids)` — 1 requête `unnest` + 6 `count(*)` |
| A005 | ✅ | `listFeatures()` fusionne `links` |
| A006 | ✅ | `ruleLinkCounts(ids)` — 1 requête `unnest` + 2 `count(*)` |
| A007 | ✅ | `listRules()` fusionne `links` |
| A008 | ✅ | description `feature_list` (champ additif `links`) — `inputSchema` inchangé |
| A009 | ✅ | description `rule_list` — `inputSchema` inchangé |
| A010 | ✅ | `loadFeatureRuleLinkIndex` → `buildFeatureRuleLinkIndex` **synchrone, 0 réseau** |
| A011 | ✅ | appel `renderFeaturesRules` sans `await` + `console.warn` unique si `links` absent |
| A012 | ✅ | `mcp-client.mjs` : clients persistants `(serveur, lane)`, `closeAllMcpClients()`, env `MCP_*_PATH`, lane `long` |
| A013 | ✅ | `server.mjs` : handlers `SIGTERM`/`SIGINT` → `closeAllMcpClients()` |
| A014 | ✅ | mesures APRÈS + `node --check` + idempotence + compteurs + smoke MCP réel |
| A015 | ✅ | instance de test `PORT=4010` + `MCP_TASK_ORCHESTRATOR_PATH=<worktree>` → onglet < 1 s |
| A016 | ✅ | ce rapport |

---

## 5. Mesures AVANT / APRÈS

**Commandes** :
- AVANT : `node scripts/bench-fr-load.mjs myxmax` (depuis le worktree panneau, MCP principal par défaut)
- APRÈS : `MCP_TASK_ORCHESTRATOR_PATH=<worktree MCP>/index.mjs node scripts/bench-fr-load.mjs myxmax`

| Métrique | AVANT | APRÈS | Cible | Verdict |
|---|---|---|---|---|
| Appel MCP simple #1 (process neuf) | 636 ms | **484 ms**¹ | ≤ 500 ms | ✅ |
| Appel MCP simple #2/#3 (chaud) | 703 / 703 ms | **6,1 / 6,1 ms** | ≤ 50 ms | ✅ |
| `feature_list` myxmax (45) | 590 ms | **22 ms** | ≤ 100 ms | ✅ |
| `rule_list` myxmax (10) | 592 ms | **15 ms** | ≤ 50 ms | ✅ |
| Index liens — **ancien** (55 appels, conc. 4) | **10 633 ms** | 163 ms² | — | (chemin supprimé) |
| Index liens — **nouveau** | — | **0,29 ms / 0 appel réseau** | 0 appel | ✅ |
| **Onglet FR myxmax (HTTP, 8 requêtes ∥)** | ~11 s (diagnostic) | **611 ms froid / 108 ms chaud** | **< 1 s** | ✅ |
| Requêtes réseau pour l'index | **55** | **0** | 0 | ✅ |

¹ 484 ms = spawn + bootstrap MCP + `ensureSchema` (marqueur présent → skip schéma). À la toute première
exécution (marqueur absent) : 731 ms (apply complet).
² L'ancien chemin mesuré APRÈS (163 ms) utilise le client persistant : chaque appel devient bon marché, mais
il reste **55 appels** — chemin désormais **supprimé** côté panneau (0 appel).

**Détail HTTP onglet FR (instance `PORT=4010`, warm)** : features 32 ms, rules 18 ms, docs 20 ms,
e2e-tests 21 ms, sprints 18 ms, tasks 92 ms, recettes 11 ms, pieces 25 ms.

---

## 6. Vérifications

| Vérification | Commande | Résultat |
|---|---|---|
| Syntaxe (6 fichiers) | `node --check` | ✅ db.mjs, index.mjs, mcp-client.mjs, server.mjs, public/app.js, scripts/bench-fr-load.mjs |
| `links` présent bout-en-bout | `GET /api/features` & `/api/rules` | ✅ 45/45 features, 10/10 rules portent `links` |
| **Compteurs inchangés** | `links` vs longueurs `feature_get`/`rule_get` (45+10) | ✅ **0 mismatch** |
| **Idempotence schéma** | `schema_meta.updated_at` avant/après nouveau process | ✅ stable (`2026-09-21T14:21:01.315Z`) — skip prouvé |
| Marqueur de version | `SELECT * FROM schema_meta` | ✅ `schema_version = 2026-09-21-perf-fr-nplus1` |
| Smoke MCP réel | `org_list`, `feature_list`, `rule_list` | ✅ OK (via banc) |
| **Arrêt propre (A013)** | `SIGTERM` sur l'instance 4010 | ✅ « SIGTERM reçu — arrêt propre… », port libéré, **0 process MCP orphelin** |
| Panneau live intact | `pm2 jlist` + `curl :4000/login` | ✅ `online`, restarts=51 (inchangé), HTTP 200 |
| Checkout principal panneau | `git -C /root/orchestrator-panel status -sb` | ✅ `feature/migration-postgresql`, aucune modif suivie |
| Checkout principal MCP | `git -C …/task-orchestrator status -sb` | ✅ `feature/migration-postgresql`, aucune modif suivie (artefacts `plans/`/`reports/` non suivis préexistants) |

---

## 7. Fichiers modifiés / créés

**Registre MCP** (`build-notify/mcp-perf-fr-nplus1`) :
- `db.mjs` — `ensureSchema` (version-skip + verrou advisory), `featureLinkCounts`, `ruleLinkCounts`, `listFeatures`/`listRules`
- `index.mjs` — descriptions `feature_list`/`rule_list`
- `schema.sql` — table `schema_meta`

**Panneau** (`build-notify/panel-perf-fr-nplus1`) :
- `mcp-client.mjs` — clients persistants, `closeAllMcpClients`, env, lanes
- `public/app.js` — `buildFeatureRuleLinkIndex` (synchrone, 0 réseau) + appel
- `server.mjs` — handlers `SIGTERM`/`SIGINT`
- `scripts/bench-fr-load.mjs` — **créé** (banc de mesure)

**Rapport** : `reports/report-perf-fr-load-20260921-142952.md` (ce fichier).

Aucune suppression de fichier, aucune table/colonne supprimée, aucune signature modifiée.

---

## 8. Avertissements / erreurs

1. **Banc A001 — détail d'erreurs évalué trop tôt** : le libellé `0 erreur(s)` était calculé avant l'exécution
   (2 `feature_get` ont échoué transitoirement sous l'ancien client *spawn-par-appel* à concurrence 4 —
   symptôme même du problème corrigé). Corrigé (détail évalué après). Vérification séquentielle : **45/45 OK**.
2. **`plan_commit_add` est append-only (INSERT simple, sans upsert)** : le commit MCP a été enregistré avec
   `db.mjs` ; les fichiers `index.mjs` (+2/−2) et `schema.sql` (+11) — mineurs — n'ont **pas** été ajoutés à la
   même entrée (aucun outil de mise à jour/suppression n'existe). Le commit panneau est enregistré avec ses
   **4 fichiers complets**. (Complétude partielle assumée pour préserver l'exactitude du nombre de commits.)
3. **Marqueur `schema_meta` écrit dans la base partagée `task_registry`** pendant les vérifications. Sans
   impact sur le panneau live (l'ancien MCP ne lit pas ce marqueur ; au déploiement, le nouveau code
   bénéficiera du skip).
4. **`node_modules` symlinkés** dans les worktrees (gitignorés / exclus) — nécessaire pour exécuter le MCP et le
   panneau d'un worktree.
5. **Worktrees conservés** (pas de `session-guard remove`) — voir §2 : préserver les branches non poussées.

---

## 9. Prochaines étapes / recommandations

1. **Ordre de déploiement (important)** : **registre MCP d'abord** (fournit `links`), **puis panneau**
   (`buildFeatureRuleLinkIndex`), **puis** `pm2 restart orchestrator-panel`. Si le panneau est déployé avant le
   registre, la colonne « Liens » retombe en repli `—` (non bloquant, `console.warn` unique).
2. **Merge/push** des deux branches par l'orchestration :
   - `build-notify/mcp-perf-fr-nplus1` → `feature/migration-postgresql` (registre)
   - `build-notify/panel-perf-fr-nplus1` → `feature/migration-postgresql` (panneau)
3. **Rappel maintenance** : incrémenter `SCHEMA_VERSION` (db.mjs) à **chaque** évolution de `schema.sql`/`migrate()`.
4. **Après déploiement** : re-mesurer l'onglet FR réel sur myxmax (attendu ≈ 0,1–0,4 s) et confirmer le
   redémarrage PM2 (les process MCP persistants sont alors créés paresseusement et fermés proprement à l'arrêt).
5. E2E : **NA** (repo sans harnais Playwright ; tâche de performance — substitut = banc + test d'intégration 4010),
   conforme à l'analyse d'impact du plan (§10).
