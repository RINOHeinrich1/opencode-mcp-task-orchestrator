# Plan — ADR : famille MCP `adr_*` + intégration agents + sélection ADR en contexte (panneau)

- **Plan ID** : `Plan-adr-expositions-mcp-agents-panneau-20260921-044549`
- **Tâche** : `T-20260920-162758-8c12` (executionId `E-T-20260920-162758-8c12-qvhjr4`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 6/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` — **item 125** (execOrder 6)
- **Repos / dossiers concernés** :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (registre MCP)
  - `opencode-agents` = `/root/.config/opencode/agent` (prompts agents)
  - `opencode-observability` = `/root/orchestrator-panel` (panneau : `pilot.mjs`, `session-bridge.mjs`, **+ `server.mjs` et `public/app.js` — HORS SCOPE DÉCLARÉ, cf. §10**)
- **Dépendances (livrées, done)** :
  - `T-20260920-162753-hpcj` (item 120) — modèle ADR structuré : colonnes `status/context/decision/consequences/replaced_by/is_global/meta/updated_at` sur `docs`, tools `doc_register`/`doc_update`/`doc_get`/`doc_list` + filtre `status`. Plan : `plans/Plan-adr-modele-structure-20260920-163126.md`.
  - `T-20260920-162754-b4cb` (item 121) — onglet ADR du panneau : `adrTabHtml`/`adrFormModal`/`adrAttachmentsCell`/`ADR_STATUS`/`adrStatusBadge`/`adrGlobalBadge` (`public/app.js` l.4037-4146), `PUT /api/docs/:id` (`server.mjs` l.1658). Plan : `plans/Plan-onglet-adr-panneau-20260920-165510.md`.
  - `T-20260920-162755-3qxj` (item 122) — pièces jointes ADR : table `doc_attachments`, tools `doc_attachment_add/_remove/_list`, champ `attachments` dans `doc_get`/`doc_list`. Plan : `plans/Plan-adr-pieces-jointes-20260920-173615.md`.
  - `T-20260920-162756-m30s` (item 123) — alignement `schema.sql`. `T-20260920-162757-sxi4` (item 124) — nettoyage repo orphelin.
- **Date** : 2026-09-21 04:45:49
- **Fichier plan** : `plans/Plan-adr-expositions-mcp-agents-panneau-20260921-044549.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)

## 1. Objectif

Exposer les **ADR structurées** (livrées par l'item 120) via une **famille MCP dédiée `adr_*`**
(lecture/contexte, cycle de vie, signalement), **l'intégrer aux 4 agents** (build-notify,
atomic-plan, test-agent, agent-recette) et **remplacer l'ancienne sélection de documents**
(`docIds`/`.as-doc`) par une **sélection multi-lignes d'ADR en contexte** qui alimente
`adr_context` — bloc prêt à injecter, appelé **automatiquement au lancement des sessions**
(recette, test, test libre) depuis le panneau. Le module `doc_*` reste **inchangé** (rétrocompat).

## 2. Contexte & raison d'être

L'item 120 a porté les ADR comme entités structurées en base et les a exposées via `doc_*`
(canal de rétrocompatibilité ADR-12). Mais **aucun agent n'exploite les ADR** :
`build-notify` et `atomic-plan` n'ont **aucun accès ADR** ; `test-agent` et `agent-recette`
reçoivent les docs ADR-12 comme **fichiers passifs** (`session-bridge.mjs` `buildTestPrompt`
l.371-405, `buildRecettePrompt` l.335-365, alimentés par `pilot.mjs`
`launchTestSession` l.934, `launchFreeTestSession` l.888, `launchRecetteSession` l.723), sans
distinguer un statut **Accepté** d'un statut **Déprécié/Remplacé**. Enfin, la sélection de
contexte au lancement d'une session se fait par **cases à cocher de documents bruts**
(`public/app.js` `.as-doc` l.1468/1510, `.ea-doc` l.2152/2170, `.rm-refdoc` l.2643/2635 ;
`pilot.mjs` `docIds` l.667/698, l.888/903, l.934/962 ; `server.mjs` l.1162/1186, l.2075,
l.2199, l.2221) : une grosse liste indifférenciée, sans statut ni repos ni décision.

L'item 125 (discussion Rino) demande donc **3 familles de fonctions** + **intégration par
agent** + **UX de sélection ADR en contexte**. Points structurants du contexte réel :

- **Base existante** : `docs` porte déjà tous les champs ADR (`db.mjs` `rowToDoc` l.1552-1567) ;
  `enrichDocs` (l.1623-1634) expose `projects`/`repos`/`attachments` ; `ADR_STATUS` (l.1498) et
  `assertAdrStatus` (l.1501) sont le référentiel partagé ; `DOC_ATTACHMENT_SOURCES` (l.1513),
  `addDocAttachment` (l.1753), `removeDocAttachment` (l.1797), `listDocAttachments` (l.1810)
  existent. La famille `adr_*` doit être un **sur-ensemble structuré** réutilisant ces
  primitives (pas un second modèle).
- **Décisions humaines** : `requestDecision` (`db.mjs` l.1048) crée une décision
  `awaiting` (colonne `kind` TEXT sans CHECK, `schema.sql` l.254-270) ; `resolveDecisionAndTransition`
  (l.2086) gère `permission`/`recette` et retombe sur un chemin générique (event `CLOSED`)
  pour les autres `kind` — un `kind='conflict'` se résout donc sans transition de tâche.
- **⚠️ INC-011 connu** : `listDocs` (`db.mjs` l.1830-1879) a un **bug de précédence SQL** dans la
  branche `includeRepoDocs` (l.1850-1856 : `WHERE (A) OR (B) AND status…` → le `AND` ne lie que
  la 2ᵉ branche). **La famille `adr_*` ne doit pas en dépendre** : `listAdrs` ne passera
  **jamais** `status` à `listDocs` et filtrera le statut en JS (cf. A003).
- **Rétrocompat** : `doc_list(includeRepoDocs)` est consommé par `docsForProjectContext`
  (l.1884, utilisé par `getProject` l.1274 et `getE2ETest` l.2768) et par les sessions
  recette/test. Aucune signature `doc_*` n'est modifiée.

## 3. Tableau de synthèse des actions

### Bloc 1 — Registre MCP (`opencode-mcp-task-orchestrator`, DANS le scope)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter | `CREATE TABLE IF NOT EXISTS adr_conflicts` (`conflict_id` PK, `adr_id` FK `docs` ON DELETE CASCADE, `task_id` FK `tasks` ON DELETE SET NULL **nullable**, `description` NOT NULL, `status` DEFAULT `'open'`, `decision_id` nullable, `created_at`, `created_by`) + `idx_adr_conflicts_adr` / `idx_adr_conflicts_status`, **après** le bloc `doc_attachments` (l.185) | `schema.sql` | `schema.sql` | Persister un conflit code↔ADR **même sans `taskId`** (« pas de violation silencieuse ») et donner à l'item 126 (gouvernance) un socle d'historique filtrable | `schema.sql` porte le modèle des conflits d'ADR |
| A002 | Ajouter | Le **même** `CREATE TABLE IF NOT EXISTS adr_conflicts` + index dans `migrate()` (après le bloc `doc_attachments`, l.276) | `db.mjs` | `db.mjs` | Bases PostgreSQL **existantes** (branche `feature/migration-postgresql`) : créer la table sans perte, idempotent | `migrate()` crée `adr_conflicts` sur base déjà migrée |
| A003 | Ajouter | `export async function listAdrs({ projectId, repoIds, status, search, includeRepoDocs = true, limit = 500 })` : base = `listDocs({ kind: 'adr-tech', projectId, includeRepoDocs, limit })` **sans passer `status`** (contourne INC-011), puis filtres JS `status`, `repoIds` (intersection de `d.repos` **ou** `d.isGlobal`), `search` (titre/contexte/décision/conséquences/description/path, insensible casse/accents) ; retourne la **vue condensée** `{ adrId, title, status, repos, isGlobal, decision, path, updatedAt }` | `db.mjs` | `db.mjs` | Vue condensée = point d'entrée de tout agent ; **ne dépend pas du SQL `includeRepoDocs` buggé** | `adr_list` renvoie titre/statut/repos sans le bug INC-011 |
| A004 | Ajouter | `export async function getAdr(adrId)` : `getDoc(adrId)` ; `null` si inconnu ; **garde** `kind === 'adr-tech'` (sinon `null`) ; ajoute `conflicts` (conflits `status='open'` via A010) au retour | `db.mjs` | `db.mjs` | Contenu complet structuré (contexte/décision/conséquences/pièces jointes/statut) + conflits ouverts | `adr_get` renvoie l'ADR complète + ses conflits ouverts |
| A005 | Ajouter | `export async function searchAdrs({ query, projectId })` : `listDocs({ kind: 'adr-tech', projectId, includeRepoDocs: true })` puis filtre texte (mêmes champs que A003) ; retourne `[{ adrId, title, status, path, decision, excerpt }]` | `db.mjs` | `db.mjs` | Retrouver la règle pertinente par recherche texte | `adr_search` renvoie les ADR matchantes avec extrait |
| A006 | Ajouter | `export async function buildAdrContext({ projectId, scope, adrIds, taskId })` : si `taskId` → résout `projectId`/`scope` via `getTask(taskId)` (`rowToTask.scope`, l.595) ; ADR = `adrIds` (`getAdr` unitaire) sinon `listAdrs({ projectId, includeRepoDocs: true })` **filtrées statut ∈ {Proposé, Accepté}** ; si `scope` fourni → garder `isGlobal` **ou** correspondance d'un segment du scope avec `title/decision/context/consequences/path` ; construit le **bloc markdown** `## ADR de référence` (une section par ADR : titre, statut, repos, décision, conséquence, chemin) ; retourne `{ projectId, count, adrs, context }` | `db.mjs` | `db.mjs` | Bloc prêt à injecter dans un prompt agent, appelé au lancement des sessions | `adr_context` produit le bloc `## ADR de référence` + les ADR structurées |
| A007 | Ajouter | `export async function registerAdr({ projectId, repoIds, title, path, description, status, context, decision, consequences, global, attachments, organizationId, createdBy })` : `registerDoc({ kind: 'adr-tech', …, status: status || 'Proposé' })` ; puis pour chaque `attachments[]` (`{ repoId?, docId?, path?, title?, nature? }`) → `updateDoc({ docId, addRepoId })` ou `addDocAttachment(...)` | `db.mjs` | `db.mjs` | Créer une ADR **statut initial `Proposé`** (build-notify ne doit pas auto-Accepter) + rattachements optionnels | `adr_register` crée une ADR Proposé avec ses repos/pièces jointes |
| A008 | Ajouter | `export async function setAdrStatus({ adrId, status, replacedBy })` : garde `assertAdrStatus` ; **table de transitions** `Proposé→{Accepté,Déprécié}`, `Accepté→{Déprécié,Remplacé}`, `Déprécié→{Remplacé}`, `Remplacé` terminal (sinon erreur listant les transitions permises) ; `Remplacé` **exige** `replacedBy` (doc existant, `≠ adrId`) ; délègue à `updateDoc({ docId, status, replacedBy })` | `db.mjs` | `db.mjs` | Transitions actées `Proposé → Accepté → Déprécié/Remplacé` + chaînage `replacedBy` (pas de saut incohérent) | `adr_set_status` valide la transition et le chaînage |
| A009 | Ajouter | `export async function attachAdr({ adrId, repoId, docId, path, title, kind, nature, source, meta, createdBy })` : si `repoId` → `updateDoc({ docId: adrId, addRepoId: repoId })` ; si `docId`/`path` → `addDocAttachment({ docId: adrId, targetDocId: docId, path, …, source: source || (docId ? 'registry' : 'ref') })` ; au moins un des trois requis (sinon erreur) ; retourne `getAdr(adrId)` | `db.mjs` | `db.mjs` | Rattacher **repos (1..N) ET pièces jointes (0..N)** via un point d'entrée unique, sans second modèle | `adr_attach` rattache repo ou pièce jointe et retourne l'ADR à jour |
| A010 | Ajouter | `export async function reportAdrConflict({ adrId, taskId, description, by })` : garde ADR (`kind='adr-tech'`) ; INSERT `adr_conflicts` (`conflict_id = adr-conf-<ts>-<rand>`, `status='open'`) ; si `taskId` → `requestDecision({ taskId, kind: 'conflict', detail, requestedBy: by })` puis `UPDATE adr_conflicts SET decision_id = $1` ; retourne `{ conflict, decision }`. + `export async function listAdrConflicts({ adrId, status })` (`SELECT … ORDER BY created_at DESC` → camelCase) | `db.mjs` | `db.mjs` | Signaler une contradiction code↔ADR → **décision humaine trackée** (aucune violation silencieuse), y compris hors tâche | `adr_report_conflict` crée le conflit (+ décision si `taskId`) |
| A011 | Modifier | `resolveDecisionAndTransition()` (l.2086-2130) : dans la transaction générique, si `decision.kind === 'conflict'` → `UPDATE adr_conflicts SET status='resolved' WHERE decision_id = $1` (la branche `validation` l.2129 ne s'applique pas → aucune transition de tâche) | `db.mjs` | `db.mjs` | Clore la boucle : une décision de conflit résolue **ferme** le conflit correspondant (pas d'orphelin ouvert) | Résoudre la décision clôt le conflit d'ADR |
| A012 | Ajouter | Bloc d'imports depuis `./db.mjs` (l.105-145) : `listAdrs`, `getAdr`, `searchAdrs`, `buildAdrContext`, `registerAdr`, `setAdrStatus`, `attachAdr`, `reportAdrConflict`, `listAdrConflicts` | `index.mjs` | `index.mjs` | Rendre les fonctions disponibles au serveur MCP | Fonctions `adr_*` importées dans `index.mjs` |
| A013 | Ajouter | Tool `adr_list` (après `doc_attachment_list`, l.495) : `inputSchema { projectId?, repoIds?, status? (z.enum ADR_STATUS), search?, includeRepoDocs? }` + handler → `{ count, adrs }` | `index.mjs` | `index.mjs` | Point d'entrée de tout agent : vue condensée des ADR d'un projet | `adr_list` opérationnel |
| A014 | Ajouter | Tool `adr_get` : `inputSchema { adrId }` + handler → `{ ok, adr }` (`err` si inconnue / non-ADR) | `index.mjs` | `index.mjs` | Contenu complet structuré (contexte/décision/conséquences/pièces jointes/statut/conflits) | `adr_get` opérationnel |
| A015 | Ajouter | Tool `adr_search` : `inputSchema { query, projectId? }` + handler → `{ count, results }` | `index.mjs` | `index.mjs` | Recherche texte → retrouver la règle pertinente | `adr_search` opérationnel |
| A016 | Ajouter | Tool `adr_context` : `inputSchema { projectId?, scope? (z.array(z.string())), adrIds? (z.array(z.string())), taskId? }` + handler → `{ projectId, count, adrs, context }` | `index.mjs` | `index.mjs` | Bloc de contexte prêt à injecter (appelé au lancement des sessions) | `adr_context` opérationnel |
| A017 | Ajouter | Tool `adr_register` : `inputSchema { projectId, repoIds?, title, path, description?, status?, context?, decision?, consequences?, global?, attachments? }` + handler → `{ ok, adr }` | `index.mjs` | `index.mjs` | Créer une ADR (statut initial Proposé) depuis build-notify / session recette-test | `adr_register` opérationnel |
| A018 | Ajouter | Tool `adr_set_status` : `inputSchema { adrId, status (z.enum ADR_STATUS), replacedBy? }` + handler → `{ ok, adr }` | `index.mjs` | `index.mjs` | Faire transiter une ADR (`Proposé→Accepté→Déprécié/Remplacé` + chaînage) | `adr_set_status` opérationnel |
| A019 | Ajouter | Tool `adr_update` : `inputSchema { adrId, title?, path?, description?, context?, decision?, consequences?, replacedBy?, addRepoIds?, setGlobal? }` + handler → `updateDoc({ docId: adrId, … })` (`err` si inconnue) | `index.mjs` | `index.mjs` | MAJ des champs structurés + rattachements repos d'une ADR | `adr_update` opérationnel |
| A020 | Ajouter | Tool `adr_attach` : `inputSchema { adrId, repoId?, docId?, path?, title?, kind?, nature?, source?, meta? }` + handler → `{ ok, adr }` | `index.mjs` | `index.mjs` | Rattacher repos (1..N) et pièces jointes (0..N) | `adr_attach` opérationnel |
| A021 | Ajouter | Tool `adr_report_conflict` : `inputSchema { adrId, taskId?, description }` + handler → `{ ok, conflict, decision }` | `index.mjs` | `index.mjs` | Signalement d'une contradiction code↔ADR → décision humaine trackée | `adr_report_conflict` opérationnel |

### Bloc 2 — Prompts agents (`opencode-agents`, DANS le scope)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A022 | Ajouter | Section `## ADR de référence (avant implémentation)` (insérée **après** l'intro/`General behavior`, **avant** `## ISOLATION DE SESSION…` l.59) : `adr_list(projectId)` + `adr_get` sur le scope avant d'implémenter ; `adr_register` (statut **Proposé**) si un choix structurel émerge ; `adr_report_conflict` si le code contredit une ADR | `build-notify.md` | `build-notify.md` | build-notify n'a **aujourd'hui aucun accès ADR** (constat item 125) | build-notify consulte/propose/signale les ADR |
| A023 | Modifier | `### Phase 2 — Architecture Analysis` (l.208-216) : ajouter le bullet « consulter `adr_list`/`adr_get` (statut Accepté/Proposé) pour ancrer les étapes dans l'archi **actée**, et **citer les ADR** dans « Contexte & raison d'être » du plan » | `atomic-plan.md` | `atomic-plan.md` | atomic-plan n'a **aucun accès ADR** ; les plans doivent être ancrés sur les décisions actées | Phase 2 consulte les ADR et les cite dans le plan |
| A024 | Modifier | `## Contexte du test (MCP)` (l.87-108) : ajouter `adr_list({ projectId, status })` / `adr_get` — **filtrage par statut** (ne pas écrire/faire évoluer un spec adossé à une ADR **Déprécié/Remplacé**) + lire `decision`/`consequences` pour le design du scénario (complète `doc_list`/`doc_get` existants) | `test-agent.md` | `test-agent.md` | Éviter d'écrire un spec sur une règle obsolète ; aligner le scénario sur la décision | test-agent filtre par statut et lit la décision |
| A025 | Modifier | Section `## Raisonner sur les DOCUMENTS de référence du projet` (ajoutée par un WIP, cf. §10) : ajouter « `adr_get(adrId)` pour cibler **statut/champs exacts** → `docIntent` précis (`update` si ADR Proposé/Accepté à ajuster, `obsolete` si transition Déprécié/Remplacé) » | `agent-recette.md` | `agent-recette.md` | agent-recette doit produire un `docIntent` ciblé sur l'ADR réelle (champs/statut), pas un constat générique | agent-recette cible le statut/champs exacts via `adr_get` |

### Bloc 3 — Panneau : wrappers + injection `adr_context` (`opencode-observability`, DANS le scope)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A026 | Ajouter | `pilot.mjs` : wrappers `listAdrs(args)` → `taskOrchestrator("adr_list", { projectId, repoIds, status, search, includeRepoDocs })` et `adrContext(args)` → `taskOrchestrator("adr_context", { projectId, scope, adrIds, taskId })` (près de `docGet`, l.587-591) | `pilot.mjs` | `pilot.mjs` | Le panneau appelle le registre via le wrapper (comme `docGet`/`listDocs`) | Wrappers `listAdrs` / `adrContext` disponibles |
| A027 | Modifier | `createRecette()` (l.667-719) : renommer le paramètre `docIds` → `adrIds` ; résoudre via `adr_list({ projectId, includeRepoDocs: true })` + filtre `adrIds`, puis rattacher chaque ADR à la recette via `recette_doc_add` (même logique qu'aujourd'hui, nature `[adr-tech] …` conservée) | `pilot.mjs` | `pilot.mjs` | La recette doit rattacher les **ADR sélectionnées** (au lieu des docs bruts) | `createRecette` rattache les ADR sélectionnées |
| A028 | Modifier | `launchFreeTestSession()` (l.888-919) : paramètre `docIds` → `adrIds` ; appeler `adr_context({ projectId: project, adrIds, scope: [] })` et passer `adrContext` au prompt (supprimer l'injection `docs` par défaut, l.896-911) | `pilot.mjs` | `pilot.mjs` | Le test libre reçoit le **bloc ADR** (sélection) au lieu de tous les docs bruts | test libre : `adr_context` injecté |
| A029 | Modifier | `launchTestSession()` (l.934-988) : paramètre `docIds` → `adrIds` ; appeler `adr_context({ projectId, adrIds, scope: [t.specFile] })` ; passer `adrContext` à `buildTestPrompt` (remplacer `docs: sessionDocs` l.980) | `pilot.mjs` | `pilot.mjs` | La session de création/MAJ de test reçoit les ADR **sélectionnées et applicables** | test : `adr_context` injecté |
| A030 | Modifier | `launchRecetteSession()` (l.723-758) : accepter `adrIds?` (sinon ADR **actives** du projet) ; remplacer la collecte `doc_list` (l.745-749) par `adr_context({ projectId: proj, adrIds, scope: [] })` ; passer `adrContext` à `buildRecettePrompt` | `pilot.mjs` | `pilot.mjs` | La session de recette reçoit le **bloc ADR** du projet au lieu de tous les docs | recette : `adr_context` injecté |
| A031 | Modifier | `buildTestPrompt()` (l.371-405) : nouveau paramètre `adrContext = ""` ; insérer le bloc (avant/après `docBlock`) s'il est non vide | `session-bridge.mjs` | `session-bridge.mjs` | Injecter le bloc ADR dans le prompt test-agent | `buildTestPrompt` rend le bloc ADR |
| A032 | Modifier | `buildFreeTestPrompt()` (l.410-435) : nouveau paramètre `adrContext = ""` ; insérer le bloc | `session-bridge.mjs` | `session-bridge.mjs` | Injecter le bloc ADR dans le prompt test libre | `buildFreeTestPrompt` rend le bloc ADR |
| A033 | Modifier | `buildRecettePrompt()` (l.335-365) : nouveau paramètre `adrContext = ""` ; insérer le bloc | `session-bridge.mjs` | `session-bridge.mjs` | Injecter le bloc ADR dans le prompt agent-recette | `buildRecettePrompt` rend le bloc ADR |

### Bloc 4 — Panneau : UX sélection ADR (**HORS SCOPE DÉCLARÉ — cf. §10**)

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A034 | Modifier | `server.mjs` : renommer `docIds` → `adrIds` aux 5 points d'appel — `handleE2ECreate` (l.1162 destructuring, l.1186 `launchTestSession`), `POST /api/recettes` (l.2075 `createRecette`), `POST /api/e2e-tests/:id/session` (l.2199 `launchTestSession`), `POST /api/e2e/agent-sessions` (l.2221 `launchFreeTestSession`) ; `POST /api/recettes/:id/session` (l.2082) transmet `adrIds?` | `server.mjs` | `server.mjs` | Sans ce passage, la sélection ADR du panneau est **perdue** avant `pilot` (le champ `docIds` est retiré) | `adrIds` transmis de bout en bout |
| A035 | Ajouter | `public/app.js` : helper partagé `adrSelectorHtml(adrs, opts)` + `selectedAdrIds()` (top-level, près de `adrTabHtml` l.4146) — **lignes compactes multi-sélection** : case à cocher + titre + `adrStatusBadge(status)` + chips repos + `adrGlobalBadge(d)` + décision condensée (`adrCellText`) ; **filtres** statut/repo + recherche ; réutilise `ADR_STATUS`/`adrStatusBadge`/`adrGlobalBadge`/`adrCellText` (l.4037-4054) | `public/app.js` | `public/app.js` | Cœur de l'UX demandée : sélection multi-lignes d'ADR (pas une grosse liste vulgaire) | Composant de sélection ADR réutilisable |
| A036 | Modifier | `public/app.js` `agentSessionModal()` (l.1458-1523, **test libre**) : remplacer `#as-docs-list`/`renderDocs`/`.as-doc`/`selectedDocIds` (l.1510) par `adrSelectorHtml` (alimenté par `GET /api/docs?projectId=…&includeRepoDocs=1` filtré `kind==='adr-tech'`) ; envoyer `adrIds: selectedAdrIds()` dans `POST /api/e2e/agent-sessions` | `public/app.js` | `public/app.js` | Retirer l'ancienne sélection de docs bruts, la remplacer par la sélection ADR | test libre : sélection ADR |
| A037 | Modifier | `public/app.js` `e2eCreateViaAgentModal()` (l.2105-2200, **création test**) : remplacer `#ea-docs-fieldset`/`renderDocChecks`/`.ea-doc`/`selectedDocIds` (l.2170) par `adrSelectorHtml` ; envoyer `adrIds: selectedAdrIds()` dans `POST /api/e2e-tests` | `public/app.js` | `public/app.js` | Retirer l'ancienne sélection de docs bruts sur le parcours test | création test : sélection ADR |
| A038 | Modifier | `public/app.js` `recetteCreateModal()` (l.2574-2747, **recette**) : remplacer `#rm-docs-ref-fieldset`/`renderRefDocs`/`.rm-refdoc`/`selectedRefDocIds` (l.2635) par `adrSelectorHtml` ; envoyer `adrIds: selectedAdrIds()` dans `POST /api/recettes` | `public/app.js` | `public/app.js` | Retirer l'ancienne sélection de docs bruts sur le parcours recette | recette : sélection ADR |
| A039 | Ajouter | `public/style.css` : styles du composant de sélection ADR (`.adr-pick-list`, `.adr-pick-row`, `.adr-pick-head`, `.adr-pick-meta`) — lignes compactes, scroll maîtrisé, cohérentes avec le panneau | `public/style.css` | `public/style.css` | Rendu « soigné » demandé (pas une liste brute) | Styles du sélecteur ADR |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | Modification — table `adr_conflicts` + index (A001) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | Modification — `migrate()` (A002), `listAdrs` (A003), `getAdr` (A004), `searchAdrs` (A005), `buildAdrContext` (A006), `registerAdr` (A007), `setAdrStatus` (A008), `attachAdr` (A009), `reportAdrConflict`/`listAdrConflicts` (A010), `resolveDecisionAndTransition` (A011) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | Modification — imports (A012) + 9 tools `adr_*` (A013-A021) |
| `/root/.config/opencode/agent/build-notify.md` | Modification — section « ADR de référence » (A022) |
| `/root/.config/opencode/agent/atomic-plan.md` | Modification — Phase 2 Architecture Analysis (A023) |
| `/root/.config/opencode/agent/test-agent.md` | Modification — Contexte du test / filtrage par statut (A024) |
| `/root/.config/opencode/agent/agent-recette.md` | Modification — `adr_get` → `docIntent` précis (A025) |
| `/root/orchestrator-panel/pilot.mjs` | Modification — wrappers (A026), `createRecette` (A027), `launchFreeTestSession` (A028), `launchTestSession` (A029), `launchRecetteSession` (A030) |
| `/root/orchestrator-panel/session-bridge.mjs` | Modification — `buildTestPrompt` (A031), `buildFreeTestPrompt` (A032), `buildRecettePrompt` (A033) |
| `/root/orchestrator-panel/server.mjs` | **HORS SCOPE** — plumbing `adrIds` (A034) |
| `/root/orchestrator-panel/public/app.js` | **HORS SCOPE** — sélecteur ADR (A035-A038) |
| `/root/orchestrator-panel/public/style.css` | **HORS SCOPE** — styles (A039) |

Aucune création de fichier de code. **Aucune** modification de `doc_register`/`doc_update`/
`doc_get`/`doc_list`/`doc_attachment_*` (rétrocompat) ni de `doc_projects`/`doc_repos`/
`doc_attachments`.

## 5. Livrables attendus

1. `schema.sql` + `db.mjs` : table `adr_conflicts` (A001-A002).
2. `db.mjs` : `listAdrs`/`getAdr`/`searchAdrs` (A003-A005) — lecture/condensé/recherche, sans INC-011.
3. `db.mjs` : `buildAdrContext` (A006) — bloc `## ADR de référence` prêt à injecter.
4. `db.mjs` : `registerAdr` (Proposé) / `setAdrStatus` (transitions + `replacedBy`) / `attachAdr` (A007-A009).
5. `db.mjs` : `reportAdrConflict` + `listAdrConflicts` + clôture du conflit à la résolution de la décision (A010-A011).
6. `index.mjs` : tools `adr_list`, `adr_get`, `adr_search`, `adr_context`, `adr_register`, `adr_set_status`, `adr_update`, `adr_attach`, `adr_report_conflict` (A012-A021).
7. `build-notify.md` / `atomic-plan.md` / `test-agent.md` / `agent-recette.md` : exploitation ADR indiquée (A022-A025).
8. `pilot.mjs` : wrappers `listAdrs`/`adrContext` + 4 parcours passant `adrIds` et injectant `adrContext` (A026-A030).
9. `session-bridge.mjs` : 3 constructeurs de prompt acceptant `adrContext` (A031-A033).
10. **[hors scope]** `server.mjs` : `adrIds` transmis (A034) ; `public/app.js` : sélecteur ADR multi-lignes sur les 3 modales (A035-A038) ; `public/style.css` : styles (A039).
11. **Rétrocompat** : `doc_list(includeRepoDocs)` et les tools `doc_*` inchangés ; une ADR reste un doc (`kind='adr-tech'`).

## 6. Ordre & dépendances

```
A001 ─► A002 ─► A010 ─┬─► A011
                      └─► A021
A003 ─┬─► A005 ─┐
      ├─► A006 ─┤
A004 ─┘         │
A007 ─┬─► A008 ─┼─► A012 ─┬─► A013 ─┐
A009 ─┘         │         ├─► A014 ─┤
                │         ├─► A015 ─┤
                │         ├─► A016 ─┼─► A026 ─┬─► A027 ─► A034 ─► A038 ─┐
                │         ├─► A017 ─┤         ├─► A028 ─► A031 ─┐       ├─► A039
                │         ├─► A018 ─┤         ├─► A029 ─► A032 ─┼─► A035 ─► A036/A037 ─┘
                │         └─► A019 ─┘         └─► A030 ─► A033 ─┘
                └─► A020
A022 ─► A023 ─► A024 ─► A025   (prompts agents : indépendants du code panneau)
```

- **A001/A002** (table `adr_conflicts`) précèdent **A010** (écriture du conflit) et **A011** (clôture).
- **A003-A009** (fonctions `db`) sont **indépendantes entre elles** ; toutes précèdent **A012** (imports).
- **A012** précède **A013-A021** (tools) ; les tools sont indépendants entre eux.
- **A026** (wrappers `pilot`) dépend de A013/A016 (tools `adr_list`/`adr_context`) ; **A027-A030** dépendent de A026.
- **A031-A033** (constructeurs de prompt) sont indépendantes entre elles et précèdent leur appelant (A028-A030) pour un rendu correct.
- **A034** (`server.mjs`) dépend de A027-A030 (signatures `adrIds`) ; **A035** (helper app.js) précède A036-A038 ; **A036-A038** dépendent de A034 (plumbing) ; **A039** dépend de A035 (classes CSS).
- **A022-A025** (prompts agents) sont **indépendantes** du code registre/panneau.

## 7. Couverture des objectifs

| Exigence (item 125 / critères d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------------------|----------|-----------|
| `adr_list(projectId, repoIds?, status?, search?)` — vue condensée | A003, A012, A013 | ✅ |
| `adr_get(adrId)` — contenu complet structuré (+ pièces jointes) | A004, A012, A014 | ✅ |
| `adr_search(query, projectId?)` | A005, A012, A015 | ✅ |
| `adr_context(projectId, scope[], adrIds?, taskId?)` — bloc prêt à injecter | A006, A012, A016 | ✅ |
| `adr_register(...)` — statut initial **Proposé** + `attachments?` | A007, A012, A017 | ✅ |
| `adr_set_status(adrId, status, replacedBy?)` — transitions + chaînage | A008, A012, A018 | ✅ |
| `adr_update(adrId, ...)` | A012, A019 (`updateDoc`) | ✅ |
| `adr_attach(adrId, repoId?, docId?, path?)` — repos 1..N + pièces jointes 0..N | A009, A012, A020 | ✅ |
| `adr_report_conflict(adrId, taskId?, description)` → décision humaine trackée | A001-A002, A010-A011, A012, A021 | ✅ |
| **build-notify** : section « ADR de référence » (liste/get avant implémentation, register si choix émergent, report_conflict si contradiction) | A022 | ✅ |
| **atomic-plan** : Phase 2 Architecture Analysis — consulter/ancrer/citer les ADR | A023 | ✅ |
| **test-agent** : filtrage par statut + lecture de la décision | A024 | ✅ |
| **agent-recette** : `adr_get` → `docIntent` précis | A025 | ✅ |
| `adr_context` **appelé automatiquement** au lancement des sessions depuis le panneau | A026, A028, A029, A030 | ✅ |
| **Sélection compacte multi-lignes** d'ADR (titre, statut, repos, décision, badge globale) | A035 (helper), A036-A038 (3 modales), A039 (styles) | ✅ (hors scope, §10) |
| **Filtre** par statut/repo + recherche dans la sélection | A035 | ✅ (hors scope, §10) |
| **Retrait** de l'ancienne sélection (`docIds`, `.as-doc`, `selectedDocIds`, `selectedRefDocIds`) | A034, A036-A038 | ✅ (hors scope, §10) |
| Parcours **recette / test / test libre** mis à jour | A027, A028, A029, A030, A034, A036-A038 | ✅ |
| **Rétrocompat** `doc_*` / `doc_list(includeRepoDocs)` | A003 (contourne INC-011, ne modifie pas `listDocs`), aucune modif `doc_*` | ✅ |
| ADR rattachées au **projet de la recette + ses repos transverses** (jamais un autre projet) | A003/A006 (`projectId` + `includeRepoDocs`), A027, A030 | ✅ |
| Prompts agents **non alourdis** (consultation à la demande, pas d'injection de toutes les ADR) | A022-A025 (consultation ciblée), A028-A030 (`adrIds` sélection, statut actif) | ✅ |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** — regroupement par élément cible :

- `schema.sql` / `adr_conflicts` : **A001 unique** (création) — pas de contradiction.
- `db.mjs` / `adr_conflicts` (DDL) : **A002 unique**, **DDL identique** à A001 (base neuve vs base existante) — complémentaires (pattern déjà suivi par `docs`/`doc_attachments`).
- `db.mjs` / fonctions : `listAdrs` (A003), `getAdr` (A004), `searchAdrs` (A005), `buildAdrContext` (A006), `registerAdr` (A007), `setAdrStatus` (A008), `attachAdr` (A009), `reportAdrConflict`/`listAdrConflicts` (A010) — **fonctions distinctes**, aucun recouvrement.
- `db.mjs` / `resolveDecisionAndTransition` : **A011 unique** (ajout d'une branche `kind='conflict'`) — n'altère ni la branche `permission` (l.2092) ni `recette` (l.2096) ni `validation` (l.2129).
- `db.mjs` / `listDocs` : **aucune étape** ne modifie le SQL `includeRepoDocs` — rétrocompat et INC-011 laissé à la tâche émergente dédiée. A003 **ne passe pas** `status` à `listDocs` → **ne dépend pas** du bug.
- `index.mjs` / tools : A013-A021 — **9 tools distincts**, aucun recouvrement ; A012 (imports) est un prérequis, pas un conflit. Les tools `doc_*` ne sont pas touchés.
- `pilot.mjs` / fonctions : A026 (nouveaux wrappers), A027 (`createRecette`), A028 (`launchFreeTestSession`), A029 (`launchTestSession`), A030 (`launchRecetteSession`) — **régions disjointes** (l.587-591, l.667-719, l.888-919, l.934-988, l.723-758).
- `session-bridge.mjs` / constructeurs : A031, A032, A033 — **trois fonctions distinctes** ; ajout d'un paramètre **additif** (`adrContext = ""`) → les appels existants restent valides.
- `public/app.js` : A035 (nouveau helper top-level), A036/A037/A038 (**trois modales distinctes** : l.1458-1523, l.2105-2200, l.2574-2747) — régions disjointes ; **aucune étape `supprimer` séparée** (le retrait de `selectedDocIds`/`selectedRefDocIds`/`.as-doc` est **inclus dans** A036-A038, ce qui évite toute contradiction `supprimer` + `modifier` sur le même élément).
- **Aucune** lecture d'un élément créé par une étape ultérieure : les dépendances de lecture (A026 lit A013/A016 ; A031-A033 précèdent A028-A030 ; A035 précède A036-A038) sont ordonnées (§6).
- **Aucune étape vague** : chaque action cible un élément nommé (table, fonction, tool, paramètre, modale) dans un fichier identifié, avec un verbe précis.

**Résultat Plan Validator : `Valid`.**

**Cohérence globale (Phase 9)** — recoupement avec les autres tâches du batch :

- **T7 / item 126** (`T-20260920-162800-aov1`, ordre 7) — gouvernance recette : ADR manquantes + conflits, vigilance globale, blocage `recette_confirm`, historique filtrable. A001/A010/A011 lui donnent le **socle** (`adr_conflicts` + décision `kind='conflict'` + clôture) ; T7 ajoutera le blocage de terminaison et la vue d'ensemble. **Aucun conflit** : nous créons l'infrastructure, T7 la consomme (interface documentée §9 note 5). T7 touche aussi `agent-recette.md`/`test-agent.md` (A024/A025) — **même région** : coordination nécessaire, cf. §10 note 4.
- **T8 / item 127** (`T-20260920-162801-jxtr`, ordre 8) — fusion `artifacts` polymorphe : rebasera `doc_*` **et** `adr_*` sur `artifacts`. Nos `adr_*` réutilisent les primitives `docs`/`doc_repos`/`doc_attachments` → le rebasage sera un **mapping** (pas de second modèle). A001 (`adr_conflicts`) devra être rattachée à la nomenclature `doc_type` par T8 (hors périmètre ici).
- **T1/T2/T3** (items 120-122, done) : nous **réutilisons** `ADR_STATUS`, `rowToDoc`, `enrichDocs`, `addDocAttachment`, `doc_attachments`, `PUT /api/docs/:id` — **aucune réécriture**, rétrocompat préservée.
- **T5 / item 124** (`T-20260920-162757-sxi4`, done) : a touché `index.mjs` (nettoyage repo orphelin) — région disjointe des tools `adr_*`.

Aucune incohérence globale bloquante détectée **sur le contenu** ; l'unique point à trancher est l'**élargissement de scope** (§10).

## 9. Risques & notes

1. **INC-011 (bug de précédence `listDocs` + `includeRepoDocs` + `status`)** : `adr_list`/`adr_search`/`adr_context` **ne passent jamais `status` à `listDocs`** et filtrent en JS (A003/A005). Le bug reste à traiter par la **tâche émergente dédiée** (hors périmètre). Ne pas « corriger » `listDocs` ici (risque de régression sur `includeRepoDocs`, consommé par `docsForProjectContext`).
2. **`adr_register` exige `path`** (écart assumé vs la signature littérale de l'item 125 qui ne le liste pas) : une ADR reste un **document pointant un fichier** (`docs.path NOT NULL`, cohérent avec `doc_register`). L'agent appelant écrit le fichier puis l'enregistre. `status` défaut **`Proposé`** (build-notify ne doit pas auto-Accepter).
3. **« Décision humaine pour Accepter »** : c'est une **règle de prompt** (A022 : build-notify ne pose que `Proposé`) — elle n'est **pas** vérifiable côté tool (le tool ne connaît pas l'appelant). Le passage `Accepté` est fait par l'humain (panneau/`adr_set_status`).
4. **`adr_report_conflict` sans `taskId`** : le conflit est **quand même persisté** (`adr_conflicts`, `status='open'`) — « pas de violation silencieuse » ; avec `taskId`, une décision `kind='conflict'` est créée en plus (A010) et clôturée à sa résolution (A011). La branche générique de `resolveDecisionAndTransition` émet l'event `CLOSED` sans transition de tâche (le `kind` n'est pas `validation`) → comportement sûr.
5. **Interface pour T7 (item 126)** : `adr_conflicts(conflict_id, adr_id, task_id, description, status, decision_id, created_at, created_by)` + `listAdrConflicts({ adrId, status })` = base de l'historique filtrable ; T7 ajoutera le blocage `recette_confirm` et la vue d'ensemble. Ne pas dupliquer la table.
6. **`decision_request` (tool) inchangé** : son enum `kind` reste `validation|review|permission|recette`. `adr_report_conflict` appelle **directement** `requestDecision` (db) avec `kind='conflict'` — la colonne `kind` est TEXT sans CHECK (`schema.sql` l.258). Aucun élargissement d'enum nécessaire (évite de modifier un tool rétrocompat).
7. **Retrait des docs bruts des prompts** : A028-A030 remplacent l'injection « tous les docs du projet » par le bloc ADR **sélectionné**. Les docs non-ADR (specs/Gherkin) restent consultables à la demande (`doc_list`/`doc_get`), conformément à la vigilance item 125 (« privilégier la consultation à la demande »). Les constructeurs gardent leur paramètre `docs` (additif, non cassant).
8. **Rattachement ADR ↔ recette** : `recette_documents` ne porte pas de `docId` (seulement `title/nature/path`, `db.mjs` l.2337-2358). A027 conserve donc le chemin existant (`recette_doc_add` avec `path` + nature) en résolvant les ADR via `adr_list` — aucun nouveau modèle.
9. **Vérification manuelle** : le panneau est relancé **sans CI** (vigilance items 121/122) ; la vérification attendue est un contrôle manuel (sélection ADR → session → bloc `## ADR de référence` présent dans le prompt). Côté registre, vérification par appels MCP (outil `adr_*`).
10. **WIP non commité à ne pas écraser** : `public/app.js`/`public/style.css`/`server.mjs` portent un **WIP d'une autre tâche** (visionneuse doc plein écran : `viewRefDoc` l.4115-4134, route `GET /api/docs/:id/download` `server.mjs` l.1768-1788). Les régions ciblées par A034-A039 sont **disjointes** (modales l.1458-2747 ; la route `/download` et `viewRefDoc` ne sont pas touchées). Les agents prompts (`agent-recette.md` +165 l., `atomic-plan.md`/`test-agent.md` permissions) portent aussi un WIP — cf. §10 note 4.

## 10. ⚠️ ÉCART DE PÉRIMÈTRE À TRANCHER PAR L'ORCHESTRATEUR

**Constat** : le `scope` déclaré de `T-20260920-162758-8c12` contient
`index.mjs`, `build-notify.md`, `atomic-plan.md`, `test-agent.md`, `agent-recette.md`,
`session-bridge.mjs`, `pilot.mjs` — il **ne contient NI `public/app.js` NI `server.mjs`**
(du repo `opencode-observability`).

Or l'**item 125 lui-même** exige la refonte de l'UX de sélection (`public/app.js` :
`selectedDocIds`/`selectedRefDocIds`/`.as-doc`) et sa **propre vigilance** cite explicitement
`server.mjs` (l.1162/1186, l.1977, l.2101/2123) et `app.js` (l.1510/2187/2740). Le critère
d'acceptation de la tâche mentionne les modales (docIds/.as-doc retirés).

**Analyse** :

1. **`public/app.js` est indispensable** : le retrait des anciennes cases à cocher et la nouvelle
   sélection multi-lignes ADR vivent **exclusivement** là (A035-A038). Sans lui, la moitié du
   critère d'acceptation n'est pas couverte.
2. **`server.mjs` est également indispensable** (point non signalé dans la demande initiale) :
   les routes recopient `docIds` (l.1162/1186, l.2075, l.2199, l.2221). Si le panneau envoie
   `adrIds` sans que `server.mjs` le transmette, **la sélection est perdue** avant `pilot`.
   Alternative technique dégradée : conserver la clé `docIds` dans le corps HTTP et la
   réinterpréter comme « ids d'ADR » — **rejetée** (nomenclature trompeuse, contraire à
   « docIds retirés »).
3. **`public/style.css`** est nécessaire au rendu « soigné » (A039), mais **non bloquant**
   (les styles peuvent être minimaux/inline en repli).

**Proposition** : élargir le scope à `public/app.js`, `server.mjs` et `public/style.css`
(repo `opencode-observability`). Le plan est **complet** et couvre l'objectif ; les étapes
A034-A039 sont marquées **[HORS SCOPE]** pour que l'orchestrateur tranche. Si l'élargissement est
refusé, A034-A039 deviennent une **tâche émergente séparée** (l'UX de sélection ADR), et le plan
livre la famille `adr_*` + l'injection `adr_context` + l'intégration agents (côté backend).

**Autre point (non bloquant)** : 4. **WIP d'autres tâches sur les mêmes fichiers** —
`agent-recette.md` porte un WIP **non commité** (ajout des sections « Raisonner sur les TESTS /
DOCUMENTS » + `testIntent`/`docIntent`) qui **inclut déjà** la section ciblée par A025 ; de même
`atomic-plan.md` et `test-agent.md` ont un WIP (permissions). Les étapes A023/A024/A025 touchent
des régions **disjointes** des diffs WIP (Phase 2 l.208-216 ; Contexte du test l.87-108 ;
section documents), mais le **même fichier** → un **merge/rebase** ou une coordination est requis
avant édition (ne jamais écraser le WIP). `public/app.js`/`style.css`/`server.mjs` portent le WIP
« visionneuse plein écran » (§9 note 10), régions disjointes.

## 11. Tests E2E Playwright — analyse d'impact

**E2E : NA.** `e2e_list(project="ecosystem")` → `count: 0` : aucun test E2E n'est enregistré pour
ce projet, et les repos `opencode-mcp-task-orchestrator` / `opencode-observability` /
`opencode-agents` n'ont **ni `e2eRepoDir` ni `e2eBaseUrl`**. La tâche porte sur le registre MCP
(tools), des prompts agents (markdown) et un panneau local relancé **sans CI** (vérification
manuelle, §9 note 9). Aucune entité E2E n'est créée ni liée pour cette tâche.
