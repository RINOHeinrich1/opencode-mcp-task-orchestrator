# Plan — ADR : gouvernance en recette/test (ADR manquantes + conflits, vigilance globale, blocage de terminaison, historique filtrable)

- **Plan ID** : `Plan-adr-gouvernance-recette-20260921-054153`
- **Tâche** : `T-20260920-162800-aov1` (executionId `E-T-20260920-162800-aov1-inpw4z`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 7/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` — **item 126** (execOrder 7)
- **Repos / dossiers concernés** :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (registre MCP : `schema.sql`, `db.mjs`, `index.mjs`)
  - `opencode-observability` = `/root/orchestrator-panel` (panneau : `pilot.mjs`, `server.mjs`, `public/app.js`, `public/style.css`)
  - `opencode-agents` = `/root/.config/opencode/agent` (prompts : `agent-recette.md`, `test-agent.md`)
- **Dépendances (livrées, done)** :
  - `T-20260920-162758-8c12` (item 125) — famille `adr_*` (9 tools) + table `adr_conflicts` + `reportAdrConflict` + clôture du conflit à la résolution de décision. Plan : `plans/Plan-adr-expositions-mcp-agents-panneau-20260921-044549.md` ; commits mergés MCP `077bcb9`, panneau `d043d01`, agents `72300fc`.
  - `T-20260920-162753-hpcj` (item 120) — modèle ADR structuré (`docs.status/context/decision/consequences/replaced_by/is_global`) + `ADR_STATUS`/`ADR_TRANSITIONS`/`assertAdrStatus`.
  - `T-20260920-162755-3qxj` (item 122) — pièces jointes (`doc_attachments`).
- **Date** : 2026-09-21 05:41:53
- **Fichier plan** : `plans/Plan-adr-gouvernance-recette-20260921-054153.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)

## 1. Objectif

Instaurer la **gouvernance des ADR pendant les sessions de recette et de test** : (1) signaler une
**ADR manquante** pour une entité réellement discutée et **proposer sa création** (statut **Proposé**),
(2) signaler un **conflit d'ADR** et **proposer la dépréciation** de l'ancienne (`adr_set_status` →
Déprécié/Remplacé + `replacedBy`) puis la création de la nouvelle, (3) **BLOQUER la terminaison de la
recette** (`recette_confirm`) tant qu'un point de vigilance ADR est **ouvert**, avec la **raison
explicite** (« ADR manquant pour [entité] » / « Conflit d'ADR : [ancienne] vs [nouvelle] »), (4) exposer
dans la **vue d'ensemble du panneau** un **HISTORIQUE FILTRABLE append-only** (projet, recette liée, type
manquant/conflit, statut ouvert/résolu, date), (5) donner les **mêmes capacités au test-agent**. Le module
`doc_*` et la famille `adr_*` livrée restent **rétrocompatibles**.

## 2. Contexte & raison d'être

L'item 125 a livré la famille `adr_*` et la table `adr_conflicts` (`reportAdrConflict` persiste un conflit
code↔ADR, `status='open'` ; sa résolution via décision `kind='conflict'` le clôt — `db.mjs` l.2172-2214,
l.2441-2452). **Mais rien ne relie ces signalements à une recette** : un conflit ou une ADR manquante
détecté en recette **ne remonte nulle part** dans la recette, **ne bloque pas** `confirmRecette`
(`db.mjs` l.2860-2878 : `UPDATE recettes SET status='done'` sans aucune garde) et **n'est pas visible**
dans la vue d'ensemble du panneau. Le constat disparaît silencieusement à la clôture.

Points structurants du contexte réel :

- **`adr_conflicts`** (`schema.sql` l.193-204) porte `adr_id`, `task_id`, `decision_id`, `status` — mais
  **ni `recette_id` ni notion d'entité manquante** : il ne couvre que le conflit code↔ADR, pas l'ADR
  manquante, et n'est pas filtrable par recette.
- **`recette_confirm`** (`index.mjs` l.968-982 → `confirmRecette` `db.mjs` l.2860) clôt sans contrôle.
  ⚠️ **`pilot.finishRecette`** (`pilot.mjs` l.1071-1183) **crée les tâches AVANT** d'appeler
  `recette_confirm` (l.1134-1157 puis l.1159) : un refus côté registre après création laisserait la
  recette `in_progress` avec des tâches déjà créées → **le pré-check doit être fait en tête de
  `finishRecette`**, avant toute écriture.
- **`getRecetteById`** (`db.mjs` l.2604-2653) expose `tasks`/`items`/`documents` — pas de point de
  vigilance ADR ; l'agent-recette lit `recette_get` et le panneau lit `/api/recettes/:id`
  (`server.mjs` l.2101-2121, requête **autonome**, pas via MCP).
- **Modèle recette** : 1 recette = 1 **projet** (`recettes.project`) + **repos transverses** (`repos[]`).
  Un point de vigilance ADR se rattache donc au **projet** de la recette (filtre « projet » de
  l'historique) et à la **recette** (`recette_id`).
- **`adr_set_status`** (`db.mjs` l.2127-2152) gère déjà `Déprécié`/`Remplacé` + `replacedBy` : la
  dépréciation proposée en recette **réutilise** ce tool (pas de nouveau mécanisme).
- **Vue d'ensemble** : `renderOverview` (`public/app.js` l.360-372) — global (aucun projet) ou scopé
  projet ; les filtres demandés (projet, recette, type, statut, date) s'y insèrent naturellement.
- **⚠️ WIP non commité** : le repo `/root/.config/opencode/agent` porte un **WIP d'une autre session**
  (`agent-recette.md` **stagé**, `test-agent.md`/`atomic-plan.md`/… modifiés). Les sections ciblées par
  A025/A026 sont **disjointes** des diffs WIP, mais le **même fichier** → lire `git show HEAD:<fichier>`
  pour la version de référence et **ne jamais écraser** le WIP (cf. §9 note 6).
- **Rétrocompat** : aucune signature `doc_*` modifiée ; `doc_list(includeRepoDocs)` (⚠️ INC-011) n'est
  **pas** touché ; `adr_report_conflict` est **étendu** par un paramètre **optionnel** `recetteId`
  (additif, non cassant).

## 3. Tableau de synthèse des actions

### Bloc 1 — Registre MCP (`opencode-mcp-task-orchestrator`, DANS le scope)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter | `CREATE TABLE IF NOT EXISTS adr_vigilances` (`vigilance_id` PK, `project` NOT NULL, `recette_id` FK `recettes` ON DELETE CASCADE nullable, `task_id` FK `tasks` ON DELETE SET NULL nullable, `session_id` nullable, `type` NOT NULL (`missing`\|`conflict`), `status` DEFAULT `'open'`, `entity` nullable, `description` NOT NULL, `adr_id` nullable, `related_adr_id` nullable, `conflict_id` nullable, `resolution` nullable, `resolution_kind` nullable, `created_at`, `created_by`, `resolved_at`, `resolved_by`) + `idx_adr_vigilances_project` / `_recette` / `_status` / `_type`, **après** le bloc `adr_conflicts` (l.204) | `schema.sql` | `schema.sql` | Socle de l'**historique append-only** des points de vigilance ADR (manquant/conflit) remontés par les recettes/test — filtrable par projet, recette, type, statut, date | `schema.sql` porte le modèle `adr_vigilances` |
| A002 | Ajouter | Le **même** `CREATE TABLE IF NOT EXISTS adr_vigilances` + index dans `migrate()` (après le bloc `adr_conflicts`, l.290) | `db.mjs` | `db.mjs` | Bases PostgreSQL **existantes** (branche `feature/migration-postgresql`) : créer la table sans perte, idempotent | `migrate()` crée `adr_vigilances` sur base déjà migrée |
| A003 | Ajouter | `export const ADR_VIGILANCE_TYPES = ['missing','conflict']` + `export const ADR_VIGILANCE_STATUS = ['open','resolved']` + `rowToAdrVigilance(r)` (camelCase) + `adrVigilanceReason(v)` (→ `ADR manquant pour ${v.entity}` si `type==='missing'` ; `Conflit d'ADR : ${v.adrId} vs ${v.relatedAdrId}` si `type==='conflict'`) + `insertAdrVigilance(fields)` (helper interne d'INSERT réutilisé par A004/A007), **près de** `rowToAdrConflict` (l.1982-1999) | `db.mjs` | `db.mjs` | Référentiel unique des types/statuts + **raison explicite** réutilisée par le blocage et l'UI | Helpers de vigilance + `adrVigilanceReason` partagés |
| A004 | Ajouter | `export async function reportAdrMissing({ recetteId, taskId, projectId, entity, description, proposedAdrId, sessionId, by })` : exige `entity` ET `description` ; résout `project` (recette → `recettes.project`, sinon tâche → `tasks.project`, sinon `projectId` requis) ; si `proposedAdrId` → vérifie que c'est une ADR (`getAdr`) ; `insertAdrVigilance({ type:'missing', status:'open', … })` ; retourne `getAdrVigilance(vigilanceId)` | `db.mjs` | `db.mjs` | **Signaler une ADR manquante** pour une entité réellement discutée, rattachée au projet/recette — sans fausse alerte (entity+description+contexte exigés) | `reportAdrMissing` crée un point `missing` ouvert |
| A005 | Ajouter | `export async function listAdrVigilances({ projectId, recetteId, type, status, from, to, limit = 500 })` : `SELECT * FROM adr_vigilances` + `WHERE` dynamique (`project`, `recette_id`, `type`, `status`, `created_at >= from`, `created_at <= to`), `ORDER BY created_at DESC LIMIT`, mapping `rowToAdrVigilance` + `reason` (`adrVigilanceReason`) | `db.mjs` | `db.mjs` | **Historique filtrable** (projet, recette, type, statut, date) — lecture append-only | `listAdrVigilances` renvoie l'historique filtré |
| A006 | Ajouter | `export async function resolveAdrVigilance({ vigilanceId, resolution, resolvedBy, adrId, resolutionKind })` : exige `resolution` (raison **tracée**) ; garde vigilance existante et `status='open'` (sinon erreur) ; `UPDATE adr_vigilances SET status='resolved', resolved_at, resolved_by, resolution, resolution_kind = COALESCE(resolutionKind,'manual'), related_adr_id = COALESCE(adrId, related_adr_id)` ; retourne la vigilance | `db.mjs` | `db.mjs` | **Levée** d'un point (ADR créée / dépréciation actée / décision explicite) avec **raison tracée** — le blocage n'est jamais infini | `resolveAdrVigilance` clôt un point avec raison |
| A007 | Modifier | `reportAdrConflict({ adrId, taskId, description, by })` (l.2172-2200) → nouveau paramètre **optionnel** `recetteId` ; après l'INSERT `adr_conflicts`, si `recetteId` → `insertAdrVigilance({ type:'conflict', recette_id: recetteId, adr_id: adrId, conflict_id, description, entity?, by })` ; retour enrichi `{ conflict, decision, vigilance }` | `db.mjs` | `db.mjs` | Un conflit d'ADR signalé en recette devient un **POINT DE VIGILANCE GLOBALE** de la recette (bloquant) — en plus de `adr_conflicts` | `adr_report_conflict(recetteId)` crée aussi la vigilance |
| A008 | Modifier | `confirmRecette({ recetteId, confirmedBy })` (l.2860-2878) : **garde en tête** — `const open = await listAdrVigilances({ recetteId, status:'open' })` ; si `open.length` → `throw new Error("terminaison bloquée : " + open.map(adrVigilanceReason).join(" ; ") + " — résolvez chaque point (adr_vigilance_resolve) ou levez-le explicitement avec une raison tracée")` ; l'UPDATE `status='done'` ne s'exécute qu'ensuite | `db.mjs` | `db.mjs` | **Garde-fou de terminaison** : `recette_confirm` BLOQUÉ avec la **raison explicite** tant qu'un point ADR est ouvert | `recette_confirm` refuse avec les raisons |
| A009 | Modifier | `getRecetteById(recetteId)` (l.2604-2653) : ajouter au retour `adrVigilances: await listAdrVigilances({ recetteId })` (+ `adrVigilancesOpen` = filtrées `open`) | `db.mjs` | `db.mjs` | `recette_get` expose les points de vigilance ADR (l'agent-recette et l'UI les lisent) | `recette_get` porte `adrVigilances` |
| A010 | Modifier | `resolveDecisionAndTransition()` (l.2441-2452) : dans la branche `decision.kind === 'conflict'`, après la clôture de `adr_conflicts`, ajouter `UPDATE adr_vigilances SET status='resolved', resolved_at=$ts, resolution_kind='decision', resolution='Conflit d'ADR résolu par décision humaine' WHERE conflict_id IN (SELECT conflict_id FROM adr_conflicts WHERE decision_id = $1)` | `db.mjs` | `db.mjs` | **Levée par résolution** : trancher le conflit (décision humaine) lève aussi le point de vigilance de recette (pas de blocage orphelin) | Résoudre la décision clôt la vigilance liée |
| A011 | Ajouter | Bloc d'imports depuis `./db.mjs` (l.114-123) : `reportAdrMissing`, `listAdrVigilances`, `resolveAdrVigilance`, `ADR_VIGILANCE_TYPES`, `ADR_VIGILANCE_STATUS` | `index.mjs` | `index.mjs` | Rendre les fonctions disponibles au serveur MCP | Fonctions de vigilance importées |
| A012 | Ajouter | Tool `adr_report_missing` (après `adr_report_conflict`, l.666) : `inputSchema { recetteId?, taskId?, projectId?, entity, description, proposedAdrId?, sessionId? }` + handler → `{ ok, vigilance }` | `index.mjs` | `index.mjs` | **Signaler une ADR manquante** depuis une session recette/test | `adr_report_missing` opérationnel |
| A013 | Ajouter | Tool `adr_vigilance_list` : `inputSchema { projectId?, recetteId?, type? (z.enum ADR_VIGILANCE_TYPES), status? (z.enum ADR_VIGILANCE_STATUS), from?, to?, limit? }` + handler → `{ count, vigilancess }` | `index.mjs` | `index.mjs` | **Lecture de l'historique filtrable** (vue d'ensemble + agent) | `adr_vigilance_list` opérationnel |
| A014 | Ajouter | Tool `adr_vigilance_resolve` : `inputSchema { vigilanceId, resolution, resolutionKind? (z.enum ['adr_created','adr_deprecated','manual']), adrId?, resolvedBy? }` + handler → `{ ok, vigilance }` | `index.mjs` | `index.mjs` | **Levée tracée** d'un point de vigilance (ADR créée / dépréciation actée / décision explicite) | `adr_vigilance_resolve` opérationnel |
| A015 | Modifier | Tool `adr_report_conflict` (l.654-666) : ajouter `recetteId?` au `inputSchema` et le passer au handler (`reportAdrConflict({ adrId, taskId, recetteId, description, by })`) ; retour `{ ok, conflict, decision, vigilance }` | `index.mjs` | `index.mjs` | Le conflit signalé **dans une recette** remonte en vigilance globale (A007) | `adr_report_conflict` accepte `recetteId` |
| A016 | Modifier | Description du tool `recette_confirm` (l.970) : mentionner la **garde ADR** (« refusé avec raison explicite tant qu'un point de vigilance ADR (ADR manquante / conflit) est ouvert ») ; description de `recette_get` (l.784) : mentionner `adrVigilances` | `index.mjs` | `index.mjs` | Rendre le contrat explicite pour les agents (pas de surprise au blocage) | Descriptions `recette_confirm`/`recette_get` à jour |

### Bloc 2 — Panneau (`opencode-observability`, DANS le scope)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A017 | Ajouter | `pilot.mjs` : wrappers `listAdrVigilances(args)` → `taskOrchestrator("adr_vigilance_list", { projectId, recetteId, type, status, from, to, limit })` et `resolveAdrVigilance(args)` → `taskOrchestrator("adr_vigilance_resolve", { vigilanceId, resolution, resolutionKind, adrId, resolvedBy })` (près de `adrContext`, l.618) | `pilot.mjs` | `pilot.mjs` | Le panneau appelle le registre via wrapper (comme `listAdrs`/`adrContext`) | Wrappers `listAdrVigilances`/`resolveAdrVigilance` |
| A018 | Modifier | `finishRecette()` (l.1071-1076) : **avant** toute création de tâche, `const vig = await listAdrVigilances({ recetteId, status: 'open' })` ; si `vig.count`/`vig.vigilancess.length` → `throw new Error("terminaison bloquée : " + raisons.join(" ; "))` (raisons issues de `v.reason`) | `pilot.mjs` | `pilot.mjs` | Éviter la **création de tâches orpheline** : le pré-check bloque AVANT les écritures (le registre reste la source de vérité via A008) | `finishRecette` refuse tôt avec les raisons |
| A019 | Ajouter | `server.mjs` : route `GET /api/adr-vigilances` (query `project`, `recetteId`, `type`, `status`, `from`, `to`, `limit`) → `pilot.listAdrVigilances(...)` puis `sendJson({ vigilancess, count })` ; route `POST /api/adr-vigilances/:id/resolve` (body `{ resolution, resolutionKind, adrId }`) → `pilot.resolveAdrVigilance({ vigilanceId, resolution, resolutionKind, adrId, resolvedBy: user.username })` (près des routes recette, l.2032) | `server.mjs` | `server.mjs` | Exposer l'historique filtrable + la levée tracée au panneau | Routes vigilance opérationnelles |
| A020 | Modifier | `/api/recettes` (l.2019-2024) : ajouter `(SELECT COUNT(*) FROM adr_vigilances v WHERE v.recette_id = r.recette_id AND v.status = 'open') AS adr_vigilances_count` ; `/api/recettes/:id` (l.2101-2121) : ajouter `adrVigilances` (SELECT `adr_vigilances WHERE recette_id = … ORDER BY created_at DESC`) à l'objet renvoyé | `server.mjs` | `server.mjs` | La carte de recette affiche un badge ; la modale de clôture liste les points bloquants | Compteur + liste exposés par l'API |
| A021 | Ajouter | `renderOverview()` (l.360-372) : section « **Vigilances ADR (recettes)** » — barre de filtres (projet si global, recette, type `missing`/`conflict`, statut `open`/`resolved`, date from/to) alimentée par `GET /api/adr-vigilances`, **table append-only** (date détection, projet, recette, type, entité/ADR, raison, statut, date résolution) + bouton « Lever » sur les points ouverts (prompt raison → `POST /api/adr-vigilances/:id/resolve`) ; **aucun bouton supprimer** | `public/app.js` | `public/app.js` | **Vue d'ensemble** : détecter et afficher l'historique filtrable des ADR manquants/conflits des recettes, append-only | Section d'historique filtrable dans la vue d'ensemble |
| A022 | Modifier | `recetteItemsModal()` (l.2719-2931) : au chargement, `GET /api/adr-vigilances?recetteId=…&status=open` → bloc d'alerte listant les **raisons explicites** (`v.reason`) + bouton « Lever » par point (raison tracée) ; **désactiver** `#modal-confirm` et `#modal-finish-notasks` tant qu'il reste un point ouvert ; réafficher les raisons renvoyées par l'erreur serveur dans `#recette-finish-msg` (chemin existant l.2905-2910) | `public/app.js` | `public/app.js` | **« Terminer la recette » bloqué avec la raison explicite** dans l'UI (pas seulement côté serveur) | Modale de clôture : blocage visible + levée |
| A023 | Modifier | `recetteCard()` (l.2248-2265) : ajouter un badge `⚠ ADR (n)` (classe `danger`) si `r.adr_vigilances_count > 0`, avec `title` « n point(s) de vigilance ADR ouvert(s) — terminaison bloquée » | `public/app.js` | `public/app.js` | Repérer les recettes bloquées depuis la liste | Badge de vigilance ADR sur la carte de recette |
| A024 | Ajouter | `public/style.css` : styles `.adr-vig-list`, `.adr-vig-row`, `.adr-vig-open`, `.adr-vig-reason` (table compacte, raison en évidence, cohérent avec le panneau) | `public/style.css` | `public/style.css` | Rendu lisible de l'historique (pas une liste brute) | Styles de l'historique de vigilance |

### Bloc 3 — Prompts agents (`opencode-agents`, DANS le scope)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A025 | Ajouter | `agent-recette.md` : section « **Gouvernance des ADR en recette** » (insérée **après** la section « Raisonner sur les DOCUMENTS de référence du projet », l.220) — pour une entité **réellement discutée** sans ADR couvrante (`adr_list`/`adr_search` négatifs) : `adr_report_missing({ recetteId, entity, description, proposedAdrId? })` + proposer `adr_register` (statut **Proposé**) ; si une décision **contredit** une ADR : `adr_report_conflict({ adrId, recetteId, description })` + proposer `adr_set_status(adrId, 'Déprécié'|'Remplacé', replacedBy)` + `adr_register` (nouvelle) ; rappeler que le point **bloque** « Terminer la recette » et se lève via `adr_vigilance_resolve` (raison tracée) ; ne signaler QUE les entités discutées | `agent-recette.md` | `agent-recette.md` | L'agent-recette doit **signaler** et **proposer** (création/dépréciation) depuis la session — aujourd'hui il ne peut que poser un `docIntent` | agent-recette gouverne les ADR en recette |
| A026 | Ajouter | `test-agent.md` : section « **Gouvernance des ADR (test)** » (insérée **après** le bullet `adr_list`/`adr_get`, l.103) — **mêmes capacités** : signaler une ADR manquante pour un **comportement testé** (`adr_report_missing({ taskId?, entity, description })` + `adr_register` **Proposé**), signaler un conflit (`adr_report_conflict` + proposition de dépréciation) ; rappeler le statut initial **Proposé** | `test-agent.md` | `test-agent.md` | Le test-agent doit pouvoir signaler/créer une ADR depuis sa session (item 5) | test-agent gouverne les ADR en test |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | Modification — table `adr_vigilances` + index (A001) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | Modification — `migrate()` (A002), helpers (A003), `reportAdrMissing` (A004), `listAdrVigilances` (A005), `resolveAdrVigilance` (A006), `reportAdrConflict` (A007), `confirmRecette` (A008), `getRecetteById` (A009), `resolveDecisionAndTransition` (A010) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | Modification — imports (A011), tools `adr_report_missing`/`adr_vigilance_list`/`adr_vigilance_resolve` (A012-A014), `adr_report_conflict` (A015), descriptions `recette_confirm`/`recette_get` (A016) |
| `/root/orchestrator-panel/pilot.mjs` | Modification — wrappers (A017), `finishRecette` (A018) |
| `/root/orchestrator-panel/server.mjs` | Modification — routes vigilance (A019), `/api/recettes` + `/api/recettes/:id` (A020) |
| `/root/orchestrator-panel/public/app.js` | Modification — `renderOverview` (A021), `recetteItemsModal` (A022), `recetteCard` (A023) |
| `/root/orchestrator-panel/public/style.css` | Modification — styles historique (A024) |
| `/root/.config/opencode/agent/agent-recette.md` | Modification — section gouvernance ADR (A025) |
| `/root/.config/opencode/agent/test-agent.md` | Modification — section gouvernance ADR (A026) |

Aucune création de fichier de code. **Aucune** modification de `doc_register`/`doc_update`/`doc_get`/
`doc_list`/`doc_attachment_*` ni de `adr_list`/`adr_get`/`adr_search`/`adr_context`/`adr_register`/
`adr_set_status`/`adr_update`/`adr_attach` (rétrocompat). `adr_report_conflict` est **étendu** (paramètre
optionnel, non cassant).

## 5. Livrables attendus

1. `schema.sql` + `db.mjs` : table `adr_vigilances` (append-only) + index (A001-A002).
2. `db.mjs` : `reportAdrMissing` (A004), `listAdrVigilances` (A005), `resolveAdrVigilance` (A006) + helpers/types (A003).
3. `db.mjs` : `reportAdrConflict` étendu (vigilance conflit) (A007) ; **garde de terminaison** `confirmRecette` (A008) ; `getRecetteById.adrVigilances` (A009) ; clôture de vigilance par décision (A010).
4. `index.mjs` : tools `adr_report_missing`, `adr_vigilance_list`, `adr_vigilance_resolve` + `adr_report_conflict(recetteId)` (A011-A016).
5. `pilot.mjs` : wrappers + pré-check `finishRecette` (A017-A018).
6. `server.mjs` : routes `/api/adr-vigilances` (+ resolve) + compteur/liste sur les recettes (A019-A020).
7. `public/app.js` + `public/style.css` : historique filtrable append-only dans la vue d'ensemble, blocage explicite de la modale de clôture, badge recette (A021-A024).
8. `agent-recette.md` / `test-agent.md` : gouvernance ADR (signaler/proposer/lever) (A025-A026).
9. **Rétrocompat** : `doc_*` et la famille `adr_*` (hors `adr_report_conflict` étendu) inchangés.

## 6. Ordre & dépendances

```
A001 ─► A002 ─┐
              ├─► A004 ─┬─► A012 ─┐
A003 ─────────┘         │         │
              ├─► A005 ─┼─► A013 ─┼─► A011 ─► A015 ─► A016
              │         │         │
              ├─► A006 ─┴─► A014 ─┘
A007 ─► (A003, A004)
A005 ─► A008 ─► A018 ─► A022
A005 ─► A009 ─► A020
A010 ─► (A001/A002)
A011 ─► A012/A013/A014/A015
A017 ─┬─► A018 ─► A022
      ├─► A019 ─► A021
      └─► A020 ─► A023
A021 ─► A024   (styles)
A025 ─► A026   (prompts agents : indépendants du code)
```

- **A001/A002** (table `adr_vigilances`) précèdent **A004-A010** (écriture/lecture/levée).
- **A003** (types + `adrVigilanceReason` + `insertAdrVigilance`) précède **A004**, **A005**, **A007**.
- **A004/A005/A006** (fonctions `db`) sont **indépendantes entre elles** ; toutes précèdent **A011** (imports).
- **A007** dépend de A003 (helper) et A004 (pattern de contexte) ; **A008** dépend de A005 ; **A009** dépend de A005 ; **A010** dépend de A001/A002.
- **A011** précède **A012-A015** (tools) ; les tools sont indépendants entre eux ; **A015** étend un tool existant ; **A016** (descriptions) dépend de A008/A009.
- **A017** (wrappers `pilot`) dépend de A013/A014 ; **A018** dépend de A017 (et A005 côté registre).
- **A019/A020** (`server.mjs`) dépendent de A017 ; **A021-A023** (`app.js`) dépendent de A019/A020.
- **A024** (styles) dépend de A021 (classes utilisées).
- **A025/A026** (prompts agents) sont **indépendantes** du code registre/panneau (aucune dépendance technique).

## 7. Couverture des objectifs

| Exigence (item 126 / critères d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------------------|----------|-----------|
| **1. ADR manquante** : signaler si aucune ADR ne couvre l'entité/constat discuté | A003, A004, A011, A012 | ✅ |
| **1. ADR manquante** : la session PROPOSE sa création (`adr_register`, statut **Proposé**) | A012 (lien `proposedAdrId`), A025, A026 (le prompt appelle `adr_register` Proposé) | ✅ |
| **1. ADR manquante** → **POINT DE VIGILANCE GLOBALE** de la recette (liste consolidée) | A004, A009 (recette_get), A022 (modale de clôture) | ✅ |
| **2. Conflit d'ADR** : signalement d'une contradiction | A007, A015 | ✅ |
| **2. Conflit** : PROPOSE la dépréciation de l'ancienne (`adr_set_status` Déprécié/Remplacé + `replacedBy`) + création nouvelle | A025, A026 (prompts) — tools `adr_set_status`/`adr_register` existants (item 125) | ✅ |
| **2. Conflit** → **POINT DE VIGILANCE GLOBALE** de la recette | A007 (vigilance `conflict`), A009, A022 | ✅ |
| **3. Blocage de terminaison** : `recette_confirm` BLOQUÉ tant qu'un point est ouvert, **raison explicite** (« ADR manquant pour [entité] » / « Conflit d'ADR : [ancienne] vs [nouvelle] ») | A003 (`adrVigilanceReason`), A005, A008 | ✅ |
| **3. Blocage** : levée par **résolution** (ADR créée / dépréciation actée) ou **décision explicite tracée** | A006 (`resolution` + `resolutionKind`), A010 (décision de conflit), A014 | ✅ |
| **3. Blocage non infini** : levée manuelle avec raison tracée | A006, A014, A022 (bouton « Lever ») | ✅ |
| **3. Pas de tâche orpheline** : blocage AVANT la création de tâches | A018 (pré-check `finishRecette`) | ✅ |
| **4. Vue d'ensemble** : DÉTECTER et AFFICHER les ADR manquants + conflits des recettes | A005, A013, A019, A021 | ✅ |
| **4. HISTORIQUE FILTRABLE** : projet, recette liée, type manquant/conflit, statut ouvert/résolu, date | A005, A013, A019, A021 (filtres UI) | ✅ |
| **4. Append-only** (aucune suppression) | A001 (pas de DELETE exposé), A005/A013/A021 (lecture seule ; seul `status` transite) | ✅ |
| **5. test-agent** : mêmes capacités (signaler une ADR manquante pour un comportement testé, créer/MAJ l'ADR) | A012 (`taskId`/`projectId`), A026 | ✅ |
| **Signaler depuis une session recette** | A012 (`recetteId`), A025 | ✅ |
| **Éviter les fausses alertes** (entités réellement discutées) | A004 (`entity` + `description` + contexte exigés), A025/A026 (consigne « uniquement les entités discutées ») | ✅ |
| **Création depuis session = statut Proposé** (pas d'auto-acceptation) | A025/A026 (consigne) + `adr_register` défaut Proposé (item 125) | ✅ |
| **Rétrocompat** `doc_list(includeRepoDocs)` / module `doc_*` | aucune étape ne touche `listDocs`/`doc_*` ; `adr_report_conflict` étendu par param optionnel | ✅ |
| **1 recette = 1 projet + repos transverses** (le point de vigilance porte le projet) | A004 (`recettes.project`), A005 (filtre `project`) | ✅ |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** — regroupement par élément cible :

- `schema.sql` / `adr_vigilances` : **A001 unique** (création) — pas de contradiction.
- `db.mjs` / `adr_vigilances` (DDL) : **A002 unique**, DDL **identique** à A001 (base neuve vs existante) — complémentaires (pattern déjà suivi par `adr_conflicts`, item 125).
- `db.mjs` / helpers : `ADR_VIGILANCE_TYPES`/`rowToAdrVigilance`/`adrVigilanceReason`/`insertAdrVigilance` (**A003 unique**) — A004/A005/A007 les **lisent** (pas de redéfinition).
- `db.mjs` / fonctions : `reportAdrMissing` (A004), `listAdrVigilances` (A005), `resolveAdrVigilance` (A006) — **fonctions distinctes**, aucun recouvrement.
- `db.mjs` / `reportAdrConflict` : **A007 unique** (ajout param `recetteId` + vigilance) — n'altère pas la création de `adr_conflicts` existante.
- `db.mjs` / `confirmRecette` : **A008 unique** (garde en tête) — **aucune** autre étape ne modifie `confirmRecette`.
- `db.mjs` / `getRecetteById` : **A009 unique** — n'altère pas `tasks`/`items`/`documents`.
- `db.mjs` / `resolveDecisionAndTransition` : **A010 unique** — ajout dans la branche `kind='conflict'` (l.2441-2452) ; **A006** (levée explicite) et **A010** (levée par décision) sont **complémentaires** (deux canaux de résolution, pas de contradiction).
- `index.mjs` / tools : A012/A013/A014 (**3 tools distincts**) + A015 (extension d'un tool existant) + A016 (descriptions) — aucun recouvrement ; A011 (imports) est un prérequis.
- `pilot.mjs` : A017 (nouveaux wrappers, l.618) et A018 (`finishRecette`, l.1071-1076) — **régions disjointes**.
- `server.mjs` : A019 (nouvelles routes, l.2032) et A020 (`/api/recettes` l.2019-2024 + `/api/recettes/:id` l.2101-2121) — **régions disjointes**.
- `public/app.js` : A021 (`renderOverview` l.360-372), A022 (`recetteItemsModal` l.2719-2931), A023 (`recetteCard` l.2248-2265) — **régions disjointes** ; **aucune étape `supprimer`** (l'historique est append-only ; le bouton « Lever » ne supprime pas).
- `agent-recette.md` (A025) et `test-agent.md` (A026) — **fichiers distincts** ; sections **disjointes** des diffs WIP (cf. §9 note 6).
- **Aucune** lecture d'un élément créé par une étape ultérieure : les dépendances de lecture (A004/A005/A007 lisent A003 ; A008/A009 lisent A005 ; A011 précède A012-A015 ; A017 précède A018-A020 ; A019/A020 précèdent A021-A023 ; A021 précède A024) sont ordonnées (§6).
- **Aucune étape vague** : chaque action cible un élément nommé (table, fonction, paramètre, tool, route, fonction UI) dans un fichier identifié, avec un verbe précis.

**Résultat Plan Validator : `Valid`.**

**Cohérence globale (Phase 9)** — recoupement avec les autres tâches du batch :

- **T6 / item 125** (`T-20260920-162758-8c12`, done) — nous **réutilisons** `adr_conflicts`, `reportAdrConflict` (étendu), `resolveDecisionAndTransition` (branche `kind='conflict'`, étendue), `ADR_STATUS`, `adr_set_status`, `adr_register`, `listAdrs`, `getAdr`. **Aucune réécriture** ; `adr_report_conflict` gagne un param **optionnel** `recetteId` → rétrocompat. Nous **créons** `adr_vigilances` (nouvelle table, ne duplique pas `adr_conflicts`).
- **T8 / item 127** (`T-20260920-162801-jxtr`, ordre 8) — fusion `artifacts` polymorphe : rebasera `doc_*` et `adr_*`. `adr_vigilances` est une table **de suivi** (pas un doc) ; à rattacher à la nomenclature de T8 le cas échéant (hors périmètre ici).
- **T1/T2/T3** (items 120-122, done) : réutilisation de `ADR_STATUS`/`adr_set_status`/`doc_attachments` — aucune réécriture.
- **Panneau** : T6 a touché `pilot.mjs` (wrappers `listAdrs`/`adrContext`, l.595-618), `session-bridge.mjs`, `public/app.js` (sélecteur ADR, l.4156-4218). Nos régions sont **disjointes** (`renderOverview` l.360-372 ; `recetteItemsModal` l.2719-2931 ; `recetteCard` l.2248-2265) ; nous **réutilisons** `esc`/`badge`/`api`.

Aucune incohérence globale bloquante détectée.

## 9. Risques & notes

1. **Append-only** : la table `adr_vigilances` n'expose **aucun** DELETE (ni tool, ni fonction, ni route). Seul `status` transite `open → resolved` ; `resolved_at`/`resolution`/`resolved_by` sont **ajoutés** (jamais effacés). L'historique reste complet (filtre « résolu » + « date de résolution »).
2. **Blocage non infini** : deux canaux de levée — (a) `adr_vigilance_resolve` (ADR créée / dépréciation actée / décision explicite, avec `resolution` **obligatoire**), (b) résolution de la décision humaine `kind='conflict'` (A010) pour les conflits. L'UI (A022) expose un bouton « Lever » avec saisie de la raison.
3. **Pas de tâche orpheline** : `pilot.finishRecette` **pré-check** (A018) avant toute création de tâche ; `confirmRecette` (A008) reste le **garde-fou de la source de vérité**. Un appel direct à `recette_confirm` (hors panneau) est également bloqué.
4. **`adr_report_conflict` étendu, pas cassé** : `recetteId` est **optionnel** — les appels existants (build-notify, item 125) restent valides ; sans `recetteId`, aucune vigilance n'est créée (comportement inchangé).
5. **`entity` + `description` + contexte requis** (A004) : évite les fausses alertes (un signalement sans entité réellement discutée est refusé). Les prompts (A025/A026) rappellent de ne signaler **que** les entités discutées.
6. **⚠️ WIP non commité à ne pas écraser** : `/root/.config/opencode/agent` porte un WIP d'une **autre session** (`agent-recette.md` **stagé**, `test-agent.md`/`atomic-plan.md`/`hexagonal-architecture-auditor.md`/`clean-arch-detector-react.md`/`orchestrator.md` modifiés). Les sections ciblées par A025 (après l.220) et A026 (après l.103) sont **disjointes** des diffs WIP, mais le **même fichier** → lire `git show HEAD:agent-recette.md` / `git show HEAD:test-agent.md` pour la version de référence, éditer par insertion **ciblée** (jamais de réécriture complète), et laisser le WIP intact. Un merge/rebase est requis avant édition.
7. **`schema.sql` vs `migrate()`** : les deux DDL doivent être **identiques** (A001/A002) — pattern établi (item 125 `adr_conflicts`, item 122 `doc_attachments`). La base active est PostgreSQL (`feature/migration-postgresql`) : `migrate()` est le chemin réel pour une base déjà migrée.
8. **Rétrocompat `doc_*`** : aucune étape ne touche `listDocs`/`docsForProjectContext`/`doc_list(includeRepoDocs)`. Le bug **INC-011** (`listDocs` + `includeRepoDocs` + `status`) n'est **pas** touché (hors périmètre, tâche émergente dédiée).
9. **Vérification** : le panneau est relancé **sans CI** (vigilance items 121/122) ; vérification **manuelle** (créer un point de vigilance → « Terminer la recette » bloqué avec la raison → lever → clôture possible) et **registre** (appels MCP `adr_report_missing` / `adr_vigilance_list` / `adr_vigilance_resolve` / `recette_confirm`).
10. **`session_id`** : renseigné si la session est connue (`adr_report_missing.sessionId`) — utile pour tracer l'origine (recette/test) sans contrainte forte.

## 10. Tests E2E Playwright — analyse d'impact

**E2E : NA.** `e2e_list(project="ecosystem")` → `count: 0` : aucun test E2E n'est enregistré pour ce projet, et les repos `opencode-mcp-task-orchestrator` / `opencode-observability` / `opencode-agents` n'ont **ni `e2eRepoDir` ni `e2eBaseUrl`**. La tâche porte sur le registre MCP (tools), des prompts agents (markdown) et un panneau local relancé **sans CI** (vérification manuelle, §9 note 9). Aucune entité E2E n'est créée ni liée pour cette tâche.
