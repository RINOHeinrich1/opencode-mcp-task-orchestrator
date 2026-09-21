# Rapport — ADR : gouvernance en recette/test (item 126)

- **Tâche** : `T-20260920-162800-aov1` — executionId `E-T-20260920-162800-aov1-inpw4z`
- **Plan** : `Plan-adr-gouvernance-recette-20260921-054153` (26 étapes A001–A026, **100 % done**)
- **Projet** : `ecosystem` — recette source `RECT-mu9yzd23-8l7t`, item 126 (execOrder 7)
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 05:55:00

## 1. Résumé

**Demandé** : instaurer la gouvernance des ADR pendant les sessions de recette et de test —
(1) signaler une **ADR manquante** pour une entité réellement discutée et proposer sa création
(statut **Proposé**), (2) signaler un **conflit d'ADR** et proposer la dépréciation de l'ancienne
(`adr_set_status` → Déprécié/Remplacé + `replacedBy`) puis la création de la nouvelle, (3) **BLOQUER
la terminaison** de la recette tant qu'un point est ouvert avec **raison explicite**, (4) exposer dans
la vue d'ensemble du panneau un **HISTORIQUE FILTRABLE append-only**, (5) donner les mêmes capacités
au test-agent — le tout **rétrocompatible**.

**Fait** : les 26 étapes du plan sont implémentées et vérifiées sur les 3 zones (registre MCP,
panneau, prompts agents). Nouvelle table `adr_vigilances` (append-only), famille de fonctions + 3
nouveaux tools MCP, garde de terminaison à double niveau (registre + pré-check panneau), routes et
UI (vue d'ensemble filtrable + blocage de la modale de clôture + badge recette), et sections de
gouvernance ADR dans les prompts `agent-recette` et `test-agent`.

## 2. Isolation

Les 3 repos sont des **composants d'infrastructure** de l'écosystème, hébergés sur l'hôte (hors
workspace Coder) — conformément à l'exception de la norme v1.0. Aucun projet n'existe dans un
workspace Coder pour ces chemins.

- `session-guard acquire` exécuté sur les 3 repos → **`mode: in-place`** (aucune session parallèle).
- Aucun worktree créé ; travail sur la branche active de chaque repo.
- Les 3 checkouts étaient propres au départ ; aucun WIP non commité créé dans les checkouts principaux.
- Verrous libérés en fin de traitement (`session-guard release`).

## 3. Branches et commits

| Repo | Branche | Commit | Fichiers |
|------|---------|--------|----------|
| `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`) | `feature/migration-postgresql` | `9187ea9e7f85a5d340ff8f797cfaf3d982a6c55a` | `schema.sql`, `db.mjs`, `index.mjs` |
| `opencode-observability` (`/root/orchestrator-panel`) | `feature/migration-postgresql` | `5fef85b2b38cae3df108a3341e225d016b3299cd` | `pilot.mjs`, `server.mjs`, `public/app.js`, `public/style.css` |
| `opencode-agents` (`/root/.config/opencode/agent`) | `feature/per-plan` | `0cec533a…` | `agent-recette.md`, `test-agent.md` |

- SHA de base : MCP `077bcb9…`, panneau `d043d01…`, agents `6061534…` (WIP de l'autre session
  **conservé** — notre commit s'appuie dessus, aucune écrasure).
- Trace des commits publiée au registre via `plan_commit_add` (3 commits, fichiers + diffs).
- **Aucun push** (déploiement = étape orchestrateur/CI, non demandée ici).

## 4. Traitements effectués (par étape)

### Bloc 1 — Registre MCP (`schema.sql`, `db.mjs`, `index.mjs`)

| Étape | Livrable | État |
|-------|----------|------|
| A001 | `schema.sql` : table `adr_vigilances` (append-only) + 4 index | ✅ |
| A002 | `db.mjs` `migrate()` : DDL identique (bases PostgreSQL déjà migrées) | ✅ |
| A003 | `ADR_VIGILANCE_TYPES/STATUS/RESOLUTION_KINDS`, `rowToAdrVigilance`, `adrVigilanceReason`, `insertAdrVigilance`, `getAdrVigilance` | ✅ |
| A004 | `reportAdrMissing({recetteId,taskId,projectId,entity,description,proposedAdrId,sessionId,by})` | ✅ |
| A005 | `listAdrVigilances({projectId,recetteId,type,status,from,to,limit})` (+ `reason`) | ✅ |
| A006 | `resolveAdrVigilance({vigilanceId,resolution,resolvedBy,adrId,resolutionKind})` | ✅ |
| A007 | `reportAdrConflict` étendu (`recetteId` **optionnel** + vigilance conflit) | ✅ |
| A008 | `confirmRecette` : garde de terminaison (raison explicite) | ✅ |
| A009 | `getRecetteById` : `adrVigilances` + `adrVigilancesOpen` | ✅ |
| A010 | `resolveDecisionAndTransition` : levée de la vigilance liée (kind=`conflict`) | ✅ |
| A011 | `index.mjs` : imports | ✅ |
| A012 | tool `adr_report_missing` | ✅ |
| A013 | tool `adr_vigilance_list` | ✅ |
| A014 | tool `adr_vigilance_resolve` | ✅ |
| A015 | `adr_report_conflict` accepte `recetteId` (+ `entity`, `relatedAdrId`) | ✅ |
| A016 | descriptions `recette_get` / `recette_confirm` | ✅ |

### Bloc 2 — Panneau (`pilot.mjs`, `server.mjs`, `public/app.js`, `public/style.css`)

| Étape | Livrable | État |
|-------|----------|------|
| A017 | wrappers `listAdrVigilances` / `resolveAdrVigilance` | ✅ |
| A018 | pré-check `finishRecette` **avant** toute création de tâche | ✅ |
| A019 | `GET /api/adr-vigilances` + `POST /api/adr-vigilances/:id/resolve` | ✅ |
| A020 | `/api/recettes` → `adr_vigilances_count` ; `/api/recettes/:id` → `adrVigilances` (+Open) | ✅ |
| A021 | `renderOverview` : section « Vigilances ADR (recettes) » filtrable + table append-only + bouton « Lever » | ✅ |
| A022 | `recetteItemsModal` : bloc de blocage + raisons + boutons désactivés + levée | ✅ |
| A023 | `recetteCard` : badge `⚠ ADR (n)` (danger) | ✅ |
| A024 | `public/style.css` : styles `.adr-vig-*` | ✅ |

### Bloc 3 — Prompts agents (`agent-recette.md`, `test-agent.md`)

| Étape | Livrable | État |
|-------|----------|------|
| A025 | `agent-recette.md` : section « Gouvernance des ADR en recette » | ✅ |
| A026 | `test-agent.md` : section « Gouvernance des ADR (test) » | ✅ |

## 5. Fichiers modifiés / créés

| Fichier | Nature |
|---------|--------|
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | Modifié — table `adr_vigilances` + index (A001) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | Modifié — migrate (A002), helpers (A003), `reportAdrMissing`/`listAdrVigilances`/`resolveAdrVigilance` (A004-A006), `reportAdrConflict` (A007), `confirmRecette` (A008), `getRecetteById` (A009), `resolveDecisionAndTransition` (A010) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | Modifié — imports (A011) + 3 tools (A012-A014), `adr_report_conflict` (A015), descriptions (A016) |
| `/root/orchestrator-panel/pilot.mjs` | Modifié — wrappers (A017), pré-check `finishRecette` (A018) |
| `/root/orchestrator-panel/server.mjs` | Modifié — routes vigilance (A019), `/api/recettes` + `/api/recettes/:id` (A020) |
| `/root/orchestrator-panel/public/app.js` | Modifié — `renderOverview` (A021), `recetteItemsModal` (A022), `recetteCard` (A023) |
| `/root/orchestrator-panel/public/style.css` | Modifié — styles `.adr-vig-*` (A024) |
| `/root/.config/opencode/agent/agent-recette.md` | Modifié — section gouvernance ADR (A025) |
| `/root/.config/opencode/agent/test-agent.md` | Modifié — section gouvernance ADR (A026) |

Aucun fichier de code créé. Aucune modification de `doc_*` ni de `adr_list`/`adr_get`/`adr_search`/
`adr_context`/`adr_register`/`adr_set_status`/`adr_update`/`adr_attach` (rétrocompat).
`adr_report_conflict` est **étendu** par paramètres optionnels uniquement.

## 6. Vérifications

### Vérification syntaxique
`node --check` : `db.mjs` ✅, `index.mjs` ✅, `pilot.mjs` ✅, `server.mjs` ✅, `public/app.js` ✅.

### Test fonctionnel registre (base PostgreSQL réelle, 17/17 PASS)
Table créée par `schema.sql` + `migrate()` sur la base active (valide l'ordre DDL et l'idempotence).
Scénarios validés : `reportAdrMissing` (type/raison), historique filtrable, **blocage `confirmRecette`**
avec raison `ADR manquant pour TestEntite`, `resolveAdrVigilance` (raison obligatoire + levée),
clôture après levée, `getRecetteById.adrVigilances`, `reportAdrConflict(recetteId)` → vigilance conflit
+ blocage `Conflit d'ADR : …`, **rétrocompat** (sans `recetteId` → `vigilance: null`), filtre `type`.

### Test fonctionnel panneau + MCP (11/11 PASS)
Wrappers `pilot.listAdrVigilances` / `pilot.resolveAdrVigilance` ; tools MCP via stdio ; **pré-check
`pilot.finishRecette` bloque AVANT écriture** ; `finishRecette` OK après levée ; `recette_get.adrVigilances`.

### Nettoyage
Données de test supprimées : `adr_vigilances` = 0, recettes de test = 0, ADR de test = 0 (vérifié en base).

## 7. Avertissements / erreurs

1. **Déviation justifiée A001** : le plan demandait de placer `adr_vigilances` « après le bloc
   `adr_conflicts` » (l.204). Or `recettes` (référencée par la FK `recette_id`) est défini plus bas
   (l.332) et PostgreSQL exige la table référencée **avant** le `CREATE TABLE`. La table a donc été
   placée juste après le bloc `recette_documents` (après `recettes`), avec un commentaire explicite.
   Le DDL de `migrate()` (A002) reste à l'emplacement prévu (après `adr_conflicts`), car `schema.sql`
   s'exécute en amont. **Aucun impact fonctionnel.**
2. **`entity` requis** : `adr_report_missing` déclare `entity` requis dans le schéma zod — un appel
   sans `entity` est rejeté **avant** le handler (message « Input validation error »), ce qui satisfait
   l'exigence « pas de fausse alerte ». La validation applicative (`entity requis`) reste en défense
   en profondeur.
3. **`adr_vigilance_list` renvoie la clé `vigilancess`** (orthographe imposée par le plan A013) —
   conservée pour conformité au plan ; le panneau lit bien `vigilancess`.
4. **Mise en service non effectuée** (conforme à la consigne) : `pm2 orchestrator-panel` et les
   instances opencode **n'ont pas été relancés**. Le panneau en cours d'exécution sert l'ancien code
   jusqu'au redémarrage par l'orchestrateur ; les tools MCP, eux, sont lus à chaque spawn (donc déjà
   actifs pour les appels panneau/agents).
5. Aucun incident, aucune incohérence, aucun blocage rencontré.

## 8. Prochaines étapes / recommandations

1. **Étape orchestrateur** : redémarrer `pm2 orchestrator-panel` pour charger les nouvelles routes et
   l'UI (aucune relance faite ici, par consigne).
2. **Vérification manuelle de recette** (plan §9 note 9) : depuis le panneau, créer un point de
   vigilance sur une recette `in_progress` → vérifier « Terminer la recette » bloqué avec la raison →
   lever avec raison tracée → clôture possible ; vérifier l'historique filtrable dans la vue
   d'ensemble (filtres projet / recette / type / statut / dates) et le badge `⚠ ADR (n)` sur la carte.
3. **Rétrocompat** : aucun test de non-régression `doc_list(includeRepoDocs)` / `adr_*` n'a été
   exécuté (hors périmètre) ; les signatures concernées sont inchangées.
4. **E2E** : NA pour cette tâche (`e2e_list(project="ecosystem")` = 0 ; repos sans `e2eRepoDir`/
   `e2eBaseUrl`) — aucune entité E2E créée ni liée (conforme au plan §10).
