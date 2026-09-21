# Rapport de fin de tâche — ADR : famille MCP `adr_*` + intégration agents + sélection ADR (panneau)

- **Tâche** : `T-20260920-162758-8c12` (executionId `E-T-20260920-162758-8c12-qvhjr4`)
- **Plan** : `Plan-adr-expositions-mcp-agents-panneau-20260921-044549` — **39/39 étapes done (100 %)**
- **Projet** : `ecosystem` — recette source `RECT-mu9yzd23-8l7t` (item 125, batch `BATCH-mua15lwb-ifqw` position 6/8)
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 05:04:07

## 1. Résumé

Demandé : exposer les ADR structurées via une **famille MCP `adr_*`** (lecture/contexte,
cycle de vie, signalement), les **intégrer aux 4 agents** (build-notify, atomic-plan,
test-agent, agent-recette) et **remplacer l'ancienne sélection de documents bruts**
(`docIds` / `.as-doc`) par une **sélection multi-lignes d'ADR en contexte** qui alimente
`adr_context`, appelé automatiquement au lancement des sessions (recette / test / test libre).
Le module `doc_*` devait rester **inchangé (rétrocompat)**.

Réalisé : les 9 tools `adr_*` sont opérationnels (testés de bout en bout), la table
`adr_conflicts` est créée (schema.sql + migrate, additive), les 4 prompts agents
exploitent les ADR, le panneau injecte le bloc `## ADR de référence` et présente un
sélecteur ADR compact (titre, statut, repos, badge globale, décision) sur les 3 modales.
**39/39 étapes du plan exécutées.** Tous les tests passent ; la rétrocompat `doc_*` est vérifiée
sur la base réelle.

## 2. Isolation

Norme v1.0. Le projet `ecosystem` est un ensemble d'**outillages d'infrastructure** sur
l'hôte (le registre MCP et le panneau de supervision), hors workspace Coder — cas
explicitement autorisé (§ ÉTAPE 1). `session-guard acquire` a renvoyé `mode: in-place`
(aucune session parallèle) sur les 3 dépôts. Travail en **worktrees isolés**, branches dédiées :

| Zone | Dépôt (checkout principal) | Worktree | Branche |
|------|---------------------------|----------|---------|
| Registre MCP | `/root/.config/opencode/mcp/task-orchestrator` @ `82d572b` | `/root/.config/opencode/mcp/task-orchestrator-wt-adr-expositions-mcp` | `build-notify/adr-expositions-mcp` |
| Prompts agents | `/root/.config/opencode/agent` @ `d52041a` | `/root/.config/opencode/agent-wt-adr-expositions-agents` | `build-notify/adr-expositions-agents` |
| Panneau | `/root/orchestrator-panel` @ `45bf62f` | `/tmp/opencode/panel-wt-adr-expositions-panneau` | `build-notify/adr-expositions-panneau` |

- **Checkouts principaux intacts** : panneau **propre** (`feature/migration-postgresql` @ `45bf62f`) ;
  MCP inchangé (seuls `plans/` et `reports/` non suivis, préexistants) ; **WIP agents préservé**
  (6 fichiers `M` non commités) — aucun écrasement.
- Le worktree panneau a été recréé sous `/tmp/opencode/` : le sandbox n'autorise l'accès
  qu'à `/root/orchestrator-panel/**` (le worktree initial `/root/orchestrator-panel-wt-…`
  était hors périmètre → auto-rejeté).
- **Verrous libérés** (`release`) mais **worktrees et branches CONSERVÉS** : `session-guard remove`
  exécute `git branch -D` — le supprimerait les livrables avant merge. Les branches restent donc
  disponibles pour l'intégration par l'orchestrateur (même pratique que les tâches précédentes).

## 3. Branches et commits

| Branche | SHA | Message |
|---------|-----|---------|
| `build-notify/adr-expositions-mcp` | `aa934598d3fe46b6f7a0d55fc10c51f23a994acc` | `feat(adr): famille MCP adr_* — lecture/contexte, cycle de vie, signalement (item 125)` |
| `build-notify/adr-expositions-mcp` | `d68d4dc1` (`d68d4dc1…`, 2ᵉ commit) | `fix(adr): buildAdrContext — la sélection explicite adrIds prime sur le filtre de scope` |
| `build-notify/adr-expositions-agents` | `07fa9bab80602ce9ead8aa23cccc559111d36ace` | `feat(agents v0.6.13): ADR — exploitation de la famille adr_* par les 4 agents (item 125)` |
| `build-notify/adr-expositions-panneau` | `3d8e6cd899ec63a752b7936a31f402020b52ea33` | `feat(adr): panneau — sélection ADR multi-lignes + injection adr_context (item 125)` |

**Aucun push effectué** : le déploiement (merge + relance) est l'étape de l'orchestrateur.
Trace complète (diff par fichier) enregistrée via `plan_commit_add` — **4 commits** (ids 439/440/441 + le 2ᵉ MCP) :
une sous-tâche peut porter plusieurs commits (trace append-only).

## 4. Traitements effectués (par bloc du plan)

### Bloc 1 — Registre MCP (`aa93459`) — A001→A021 ✅

- **A001/A002** : table `adr_conflicts` (+ index `idx_adr_conflicts_adr`, `idx_adr_conflicts_status`)
  ajoutée dans `schema.sql` (après `doc_attachments`) **et** dans `migrate()` (bases existantes,
  idempotent). `task_id` nullable + `ON DELETE SET NULL` ; `decision_id` nullable.
- **A003** `listAdrs` : vue condensée `{adrId,title,status,repos,isGlobal,decision,path,updatedAt}` ;
  **ne passe jamais `status` à `listDocs`** (contourne INC-011) → filtrage statut/repo/recherche en JS
  (insensible casse **et accents** via `normalizeText`).
- **A004** `getAdr` : contenu complet + `conflicts` ouverts ; `null` si non-ADR.
- **A005** `searchAdrs` : recherche texte + extrait.
- **A006** `buildAdrContext` : bloc `## ADR de référence` ; `taskId` résout `projectId`/`scope` ;
  auto = ADR **Proposé/Accepté** filtrées par `scope` (ADR globale toujours retenue).
- **A007** `registerAdr` : statut initial **Proposé** ; `attachments[]` (repos/pièces jointes).
- **A008** `setAdrStatus` : table de transitions `Proposé→{Accepté,Déprécié}`, `Accepté→{Déprécié,Remplacé}`,
  `Déprécié→{Remplacé}`, `Remplacé` terminal ; `Remplacé` **exige** `replacedBy` (existant, ≠ adrId).
- **A009** `attachAdr` : repo (1..N) et/ou pièce jointe ; au moins un requis.
- **A010** `reportAdrConflict` (+ `listAdrConflicts`) : conflit **toujours persisté**, même sans `taskId` ;
  avec `taskId` → décision humaine `kind='conflict'` liée.
- **A011** `resolveDecisionAndTransition` : la résolution d'une décision `kind='conflict'` **clôt**
  le conflit (`status='resolved'`), sans transition de tâche.
- **A012→A021** : imports + **9 tools** `adr_list`, `adr_get`, `adr_search`, `adr_context`,
  `adr_register`, `adr_set_status`, `adr_update`, `adr_attach`, `adr_report_conflict`.

**Écart assumé vs plan (A006)** : la **sélection explicite `adrIds` PRIME sur le filtre de scope**
(sinon une ADR cochée par l'utilisateur pourrait être filtrée et ne pas apparaître dans le bloc,
violant le critère « la sélection alimente `adr_context` »). Le filtre de scope ne s'applique qu'à
la liste automatique. Corrigé dans le **2ᵉ commit MCP** (`d68d4dc1`) et vérifié : sélection + scope
non concordant → sélection conservée ; liste auto + scope → filtrée.

### Bloc 2 — Prompts agents (`07fa9ba`) — A022→A025 ✅

- **A022** `build-notify.md` : nouvelle section `## ADR de référence (avant implémentation)`
  (insérée avant `## ISOLATION DE SESSION…`) — `adr_list`/`adr_get`, statuts, `adr_register`
  (Proposé), `adr_report_conflict`.
- **A023** `atomic-plan.md` : bullet ADR en **Phase 2 — Architecture Analysis** (consulter, retenir
  le statut, **citer** les ADR dans « Contexte & raison d'être »).
- **A024** `test-agent.md` : bullet `adr_list({projectId,status})`/`adr_get` dans **Contexte du test**
  — filtre par statut (pas de spec sur une ADR Déprécié/Remplacé) + lecture de la décision.
- **A025** `agent-recette.md` : `adr_get` → `docIntent` précis (update si Proposé/Accepté,
  obsolete si Déprécié/Remplacé). **Adaptation** (cf. §7) : la section visée par le plan est un WIP
  non commité absent de HEAD → bullet ajouté à l'ancre existante « Documents de la recette ».

### Bloc 3 — Panneau : wrappers + injection (`3d8e6cd`) — A026→A033 ✅

- **A026** `pilot.mjs` : wrappers `listAdrs` / `adrContext` (près de `docGet`) ; `adrIds` fourni
  vide = aucun ADR, absent = ADR actives.
- **A027** `createRecette` : paramètre `adrIds` ; résolution via `adr_list` + rattachement
  `recette_doc_add` (nature `[adr-tech] …` conservée).
- **A028** `launchFreeTestSession` : `adrIds` + `adr_context` (plus d'injection `doc_list` brute).
- **A029** `launchTestSession` : `adrIds` + `adr_context(scope=[specFile])`.
- **A030** `launchRecetteSession` : `adrIds?` sinon ADR actives ; `adr_context` au prompt.
- **A031→A033** `session-bridge.mjs` : `buildTestPrompt` / `buildFreeTestPrompt` / `buildRecettePrompt`
  acceptent `adrContext = ""` (**additif, non cassant**) et insèrent le bloc.

### Bloc 4 — Panneau : UX sélection ADR (`3d8e6cd`) — A034→A039 ✅ (périmètre élargi, approuvé humain)

- **A034** `server.mjs` : `docIds` → `adrIds` aux 5 points d'appel + session recette.
- **A035** `public/app.js` : helpers `adrSelectorHtml` / `selectedAdrIds` / `bindAdrSelector` —
  lignes compactes (checkbox + titre + `adrStatusBadge` + chips repos + `adrGlobalBadge` + décision
  `adrCellText`), filtres statut/repo + recherche. Réutilise `ADR_STATUS`/helpers de l'onglet ADR.
- **A036/A037/A038** : les 3 modales migrées (**test libre**, **création test**, **recette**) ;
  retrait de l'ancienne sélection brute (`.as-doc` / `.ea-doc` / `.rm-refdoc`,
  `selectedDocIds` / `selectedRefDocIds`).
- **A039** `public/style.css` : styles `.adr-pick`, `.adr-pick-row`, `.adr-pick-head`,
  `.adr-pick-meta`, `.adr-pick-filters`, `.adr-pick-list` (+ `[hidden]`).

## 5. Fichiers modifiés / créés

| Fichier | Nature |
|---------|--------|
| `/root/.config/opencode/mcp/task-orchestrator-wt-adr-expositions-mcp/schema.sql` | table `adr_conflicts` + 2 index (+19) |
| `…/db.mjs` | `migrate()` + famille ADR complète + clôture conflit (+327) |
| `…/index.mjs` | imports + 9 tools `adr_*` (+171) |
| `/root/.config/opencode/agent-wt-adr-expositions-agents/build-notify.md` | section « ADR de référence » (+22) |
| `…/atomic-plan.md` | Phase 2 Architecture Analysis (+6) |
| `…/test-agent.md` | Contexte du test (+5) |
| `…/agent-recette.md` | `adr_get` → docIntent (+5) |
| `/tmp/opencode/panel-wt-adr-expositions-panneau/pilot.mjs` | wrappers + 4 parcours (+76/−58) |
| `…/session-bridge.mjs` | 3 constructeurs de prompt (+22/−2) |
| `…/server.mjs` | plumbing `adrIds` |
| `…/public/app.js` | sélecteur ADR + 3 modales (+140/−85) |
| `…/public/style.css` | styles `.adr-pick-*` |
| `/root/.config/opencode/mcp/task-orchestrator/reports/report-adr-expositions-mcp-agents-panneau-20260921-050407.md` | ce rapport |

**Aucun** `doc_*` modifié (signatures/DDL inchangées) ; `doc_list(includeRepoDocs)` intact.
**Aucune** modification non commitée laissée dans les checkouts principaux.

## 6. Tests / vérifications

1. **Suite d'intégration base jetable** (`task_registry_adr_test`) — **33 assertions OK** :
   `adr_conflicts` créée ; `registerAdr`→Proposé ; `listAdrs` (statut/repo/recherche, vue condensée) ;
   `getAdr` ; `searchAdrs` ; transitions (Proposé→Accepté OK ; Accepté→Proposé **refusé** ;
   Accepté→Remplacé sans `replacedBy` **refusé** ; chaînage OK) ; `attachAdr` ; conflit sans/avec
   `taskId` ; **résolution de décision ⇒ conflit `resolved`** ; `buildAdrContext` (auto/adrIds/scope/
   taskId/vide) ; **rétrocompat `listDocs(includeRepoDocs[, status])`**.
2. **Tools MCP via JSON-RPC stdio** — **20 vérifications OK** : les 9 `adr_*` enregistrés + `doc_*`
   toujours présents ; handlers `adr_register/get/list/search/context/set_status/update/attach/report_conflict`
   fonctionnels ; `adr_get` inconnu → erreur.
3. **Base RÉELLE** (`task_registry`) : `ensureSchema` a créé `adr_conflicts` (DDL vérifié via `\d`) ;
   `adr_list(ecosystem)` → count 0 ; **rétrocompat `doc_list(includeRepoDocs)` → 3, `doc_list()` → 5**.
4. **Prompts panneau** (`session-bridge.mjs`) — **8 vérifications OK** : bloc ADR injecté quand
   `adrContext` non vide, absent sinon ; rétrocompat docs seuls.
5. **Syntaxe** : `node --check` OK sur `db.mjs`, `index.mjs`, `pilot.mjs`, `session-bridge.mjs`,
   `server.mjs`, `public/app.js`.

## 7. Avertissements / erreurs

- **INCO-045** (incohérence tracée) : A025 cible une section d'`agent-recette.md` « ajoutée par un WIP
  non commité » (§10 note 4) — **absente de HEAD `d52041a`**, donc absente d'un worktree isolé. La
  guidance `adr_get`→`docIntent` a été placée sur l'ancre **existante** (« Documents de la recette »),
  **sans toucher au WIP**. Au merge, l'auteur du WIP devra intégrer ce bullet dans sa section
  (régions disjointes → aucun écrasement). Événement `INCONSISTENCY_FOUND` publié.
- **WIP agents non commités préservés** dans le checkout principal (6 fichiers `M`) — non modifiés,
  non commités par cette tâche.
- **Périmètre élargi** (A034–A039 : `server.mjs`, `public/app.js`, `public/style.css`) : approuvé par
  l'humain, indispensable au critère d'acceptation (sans `server.mjs`, `adrIds` serait perdu).
- **Vérification UI manuelle attendue** : le panneau n'a **pas** de CI ; la vérification de bout en
  bout (sélection ADR → session → bloc `## ADR de référence` présent dans le prompt) reste un contrôle
  manuel après relance (vigilance items 121/122, §9 note 9).
- **Worktree panneau** hors des chemins sandbox `/root/orchestrator-panel/**` → recréé sous
  `/tmp/opencode/panel-wt-adr-expositions-panneau`.

## 8. Prochaines étapes / recommandations

1. **Merge** des 3 branches dans `feature/migration-postgresql` (branche principale de chaque repo) —
   étape orchestrateur. Coordination : `agent-recette.md`/`atomic-plan.md`/`test-agent.md` ont un WIP
   non commité sur le checkout principal → rebase/merge nécessaire avant intégration.
2. **Relancer les instances opencode** pour recharger les prompts agents et le serveur MCP
   (les nouveaux tools `adr_*` n'apparaîtront qu'après redémarrage du MCP côté sessions).
3. **Relancer `pm2 orchestrator-panel`** (étape déploiement, **non faite ici**) puis contrôle manuel
   des 3 modales.
4. **T7 / item 126** (`T-20260920-162800-aov1`) consomme `adr_conflicts` + `listAdrConflicts` (interface
   §9 note 5) ; **T8 / item 127** (`T-20260920-162801-jxtr`) rebasera `adr_*` sur `artifacts`.
5. **INC-011** (bug `listDocs` `includeRepoDocs`+`status`) reste ouvert — `T-20260920-172734-370n`,
   non touché ici (la famille `adr_*` ne passe jamais `status` à `listDocs`).
6. **E2E : NA** — aucun test E2E enregistré pour `ecosystem`, repos sans `e2eRepoDir`/`e2eBaseUrl` ;
   vérification manuelle (§9 note 9). Aucune entité E2E créée/liée.
