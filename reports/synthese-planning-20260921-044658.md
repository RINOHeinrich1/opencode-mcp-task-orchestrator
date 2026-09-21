# Synthèse de planification — tâche `T-20260920-162758-8c12`

- **Tâche** : `T-20260920-162758-8c12` — « ADR — expositions MCP `adr_*` + intégration agents (build-notify, atomic-plan, recette, test) »
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 6/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` — item 125 (execOrder 6)
- **Agent** : `atomic-plan` — date : 2026-09-21 04:46:58
- **Execution** : `E-T-20260920-162758-8c12-qvhjr4`

## 1. Objectifs analysés (Phase 0)

La demande est **un seul objectif cohérent et borné** : exposer les ADR structurées via une
famille MCP `adr_*` et l'exploiter (agents + panneau). Les 4 sous-ensembles (lecture/contexte,
cycle de vie, signalement, UX sélection ADR) sont **interdépendants** (l'UX et les agents
consomment `adr_context` ; le cycle de vie alimente la lecture) → **un plan unique**, pas de
segmentation.

## 2. Plan produit

| Plan | Objectif | Fichier | Étapes |
|------|----------|---------|--------|
| `Plan-adr-expositions-mcp-agents-panneau-20260921-044549` | Famille MCP `adr_*` + intégration 4 agents + sélection ADR en contexte (`adr_context`) dans le panneau | `plans/Plan-adr-expositions-mcp-agents-panneau-20260921-044549.md` | 39 (A001-A039) |

### Découpage

- **A001-A021 — Registre MCP** (`schema.sql`, `db.mjs`, `index.mjs`) : table `adr_conflicts` ;
  `listAdrs`/`getAdr`/`searchAdrs`/`buildAdrContext`/`registerAdr`/`setAdrStatus`/`attachAdr`/
  `reportAdrConflict`(+`listAdrConflicts`)/clôture du conflit ; 9 tools `adr_*`.
- **A022-A025 — Prompts agents** (`build-notify.md`, `atomic-plan.md`, `test-agent.md`,
  `agent-recette.md`).
- **A026-A033 — Panneau, dans le scope** (`pilot.mjs`, `session-bridge.mjs`) : wrappers +
  `adr_context` appelé au lancement des sessions (recette/test/test libre).
- **A034-A039 — Panneau, HORS SCOPE** (`server.mjs`, `public/app.js`, `public/style.css`) :
  plumbing `adrIds` + sélecteur multi-lignes d'ADR + styles.

## 3. Vérifications de cohérence

- **Intra-plan (Phases 6-7)** : **Valid**. Aucune contradiction ; le retrait des anciennes cases
  (`selectedDocIds`/`selectedRefDocIds`/`.as-doc`) est **inclus** dans les étapes de modale
  (A036-A038) — pas d'étape `supprimer` séparée sur le même élément. Dépendances ordonnées
  (aucune lecture d'un élément créé plus tard).
- **INC-011** : `adr_list`/`adr_search`/`adr_context` **ne passent jamais `status` à `listDocs`**
  (filtrage JS) → la famille `adr_*` **ne dépend pas** du bug de précédence SQL ; `listDocs` et
  `doc_list(includeRepoDocs)` ne sont **pas modifiés** (rétrocompat).
- **Globale (Phase 9)** : aucune incohérence de contenu avec T7 (item 126 — la famille fournit le
  socle `adr_conflicts` + décision `kind='conflict'`) ni T8 (item 127 — rebasage `artifacts`,
  nos `adr_*` réutilisent les primitives `docs`/`doc_repos`/`doc_attachments`). Aucun conflit de
  fichier avec T5/T1/T2/T3 (done, régions disjointes).

## 4. ⚠️ Écart de périmètre signalé (arbitrage orchestrateur)

Le `scope` déclaré **n'inclut pas** `public/app.js` ni `server.mjs`, alors que :
- la demande et le critère d'acceptation exigent la refonte de la sélection ADR dans les
  **modales** (test libre, création test, recette) et le retrait de `docIds`/`.as-doc` ;
- **`server.mjs` est aussi requis** (non signalé dans la demande initiale) : il recopie `docIds`
  vers `pilot` (l.1162/1186, l.2075, l.2199, l.2221) — sans lui, la sélection `adrIds` est perdue ;
- la **vigilance de l'item 125** cite elle-même `server.mjs` (l.1162/1186, l.1977, l.2101/2123)
  et `app.js` (l.1510/2187/2740).

**Proposition** : élargir le scope à `public/app.js`, `server.mjs` (+ `public/style.css`).
**Repli si refusé** : A034-A039 deviennent une **tâche émergente séparée** (UX sélection ADR) ; le
plan livre alors la famille `adr_*` + `adr_context` + l'intégration agents (backend).
→ Tracé par `task_event(INCONSISTENCY_FOUND, kind=scope_gap)` sur la tâche.

**Autre point** : WIP **non commité** d'autres tâches sur les fichiers ciblés —
`agent-recette.md` (sections `testIntent`/`docIntent`, inclut déjà la section ciblée par A025),
`atomic-plan.md`/`test-agent.md` (permissions), `public/app.js`/`style.css`/`server.mjs`
(visionneuse doc plein écran). Les régions sont **disjointes** des étapes, mais un
**rebase/coordination** est requis avant édition (ne jamais écraser le WIP).

## 5. Tests E2E Playwright

**E2E : NA** — `e2e_list(project="ecosystem")` = 0 ; les repos concernés n'ont ni `e2eRepoDir` ni
`e2eBaseUrl`. Aucune entité E2E créée ni liée. Vérification attendue : contrôle MCP (tools `adr_*`)
+ contrôle **manuel** du panneau après relance (sans CI).

## 6. Notifications

Aucun email envoyé par `atomic-plan`. Le daemon `opencode-notifier` est informé via le registre :
`participant_add` (planner), `plan_register`, `artifact_add` (kind=plan), `task_event`
`PLANNING_STARTED` / `PLAN_CREATED` / `INCONSISTENCY_FOUND`.
