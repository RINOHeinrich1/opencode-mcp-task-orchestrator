# Rapport de fin de sous-tâche — Famille MCP `sprint_*` (CRUD complet) au-dessus des primitives T3

- **Tâche** : `T-20260921-091732-9jqg` (exécution `E-T-20260921-091732-9jqg-hbobz6`)
- **Plan (sous-tâche)** : `Plan-sprint-crud-mcp-20260921-101521` — **12/12 étapes done (100 %)**
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Repo** : `/root/.config/opencode/mcp/task-orchestrator` (**repo HÔTE**, aucun workspace Coder)
- **Agent** : `build-notify`
- **Date** : 2026-09-21 10:21:48
- **Branche de travail** : `build-notify/sprint-crud-mcp` (base `feature/migration-postgresql` @ `8d77d01`)
- **Worktree** : `/root/.config/opencode/mcp/task-orchestrator-wt-sprint-crud-mcp`
- **ADR de référence** : `doc-mub10mo8-lgo3` — ADR-001 (statut **Proposé**), §1/§4/§5

---

## 1. Résumé

Exposition de la **famille MCP `sprint_*` (CRUD complet)** au-dessus des primitives de cycle de
vie livrées en **T3**, **sans aucune réimplémentation** :

- **4 fonctions `db.mjs`** : `assertAttachablePiece` (garde nature), `attachPiecesToSprint`
  (lien `sprint_pieces` + émergence selon l'état du sprint), `createSprint` (durée paramétrable,
  statut initial, pièces optionnelles), `getSprintDetail` (sprint + pièces + fonctionnalités +
  règles + tâches + recettes + compteurs).
- **6 tools `index.mjs`** : `sprint_start`, `sprint_list`, `sprint_get`, `sprint_close`,
  `sprint_reopen`, `sprint_attach_pieces` ; le tool `sprint_report` (T3) est **réutilisé tel quel**
  (aucun doublon).
- **Réutilisation** des primitives T3 : `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`,
  `getSprint`, `listProjectSprints`, `classifyEmergence`, `buildSprintReport`, `assertPieceAllowed`.
- **Émergence** : la clôture **déclenche** la règle, la reprise la **suspend** ; une pièce reçue
  après l'init est émergente (`apres_init_sprint` / `apres_cloture`), une pièce rattachée à la
  création (`atInit=true`) ne l'est pas.
- **Additif** : modèle ADR / `artifacts` intact, T1-T3 non modifiés, `schema.sql` non modifié,
  aucune famille `feature_*`/`rule_*` (T5) ni panneau (T7).

## 2. Isolation

| Repo | Espace | Worktree | Branche |
|------|--------|----------|---------|
| `opencode-mcp-task-orchestrator` | **HÔTE** (composant d'infrastructure — `workspace_list` ne le contient dans **aucun** workspace Coder) | `/root/.config/opencode/mcp/task-orchestrator-wt-sprint-crud-mcp` | `build-notify/sprint-crud-mcp` |

- `workspace_list` : **7 workspaces Coder** listés (madatalk, ONIRIA, myxmax, affelyos,
  admin-myxmax, ia-crm-frontend, ia-crm-api) — **aucun** ne contient le repo cible ; conformément
  au plan (« repo HÔTE »), travail sur l'hôte.
- `session-guard acquire` : **code 0 / mode in-place** (aucune autre session parallèle).
  Le plan interdisant tout commit direct sur la branche principale
  (`feature/migration-postgresql`), le travail a été mené dans un **worktree + branche dédiée**
  (`session-guard worktree`), comme pour T2/T3.
- `node_modules` symlinké dans le worktree pour l'exécution (gitignoré, non committé).
- **Aucun push** (merge/push = étape d'orchestration ultérieure). Le worktree et la branche sont
  **conservés** (un `session-guard remove` supprimerait la branche et donc le commit) ; seul le
  verrou est libéré (`release`).

## 3. Branches et commits

| Repo | Branche | Commit | Base |
|------|---------|--------|------|
| `opencode-mcp-task-orchestrator` | `build-notify/sprint-crud-mcp` | `947fcf3f55d5e0a92e10ad96f4e11695a8e0c1a0` | `8d77d012e7cb977c4191d38914595582d5396621` |

Trace **append-only** persistée (`plan_commits` : **1 commit**, 2 fichiers) via la fonction de
registre `addPlanCommit` (code identique au tool `plan_commit_add` — garantit les diffs exacts) :
`db.mjs` (modified, **+213/-0**), `index.mjs` (modified, **+124/-3**).
`plan_set_branch(planId, "build-notify/sprint-crud-mcp")` effectué.

## 4. Traitements effectués (12/12)

| Étape | Statut | Détail |
|-------|--------|--------|
| A001 | done | `assertAttachablePiece(pieceId)` (db.mjs, après `rowToPiece`) — pièce `doc_type='piece'` **ou** doc ADR-12 requalifié (`meta.piece_client=true`) ; nature **re-vérifiée** via `assertPieceAllowed({nature, path, url, filename})` (refus photo/vidéo). Erreur explicite si artefact inconnu / non-pièce / nature refusée. |
| A002 | done | `attachPiecesToSprint(sprintId, { pieceIds, atInit, by })` (bloc SPRINT, après `listProjectSprints`) — garde A001 + lien `sprint_pieces` (idempotent) + marquage `meta` : `atInit=true` → **non émergent** ; sinon `open`→`apres_init_sprint`, `close`→`apres_cloture`. Retourne `{ sprintId, attached, pieces }`. |
| A003 | done | `createSprint({ projectId, title, startDate, endDate, autoClose=true, sessionId, createdBy, pieces })` (après `ensureDefaultSprint`) — `assertProjectExists`, `title` requis, `endDate >= startDate`, statut `open` ou `close`+`auto_echeance` si échéance passée, `is_default=0`, `organization_id` du projet, pièces via A002 (`atInit=true`). Retourne `getSprintDetail`. |
| A004 | done | `getSprintDetail(sprintId)` (après `getSprint`) — sprint + pièces (`sprint_pieces`⋈`artifacts`→`rowToPiece`) + fonctionnalités + règles + tâches + recettes + `counts`. `null` si inconnu. |
| A005 | done | `index.mjs` : import complété (`createSprint`, `getSprintDetail`, `attachPiecesToSprint`, `getSprint`, `listProjectSprints`, `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`, `classifyEmergence`) ; `buildSprintReport` conservé. |
| A006 | done | Commentaire du bloc SPRINT mis à jour (T4 livré) + tool **`sprint_start`** ajouté après `sprint_report` (conservé sans doublon). |
| A007 | done | Tool **`sprint_list`** — `autoCloseExpiredSprints({projectId})` **avant** `listProjectSprints` → `{ count, sprints, autoClosed }`. |
| A008 | done | Tool **`sprint_get`** — `getSprintDetail` ; `err` si inconnu. |
| A009 | done | Tool **`sprint_close`** — MANUEL (`sprintId`→`closeSprint`) ou AUTO échéance (`projectId`/global→`autoCloseExpiredSprints`) ; renvoie `{ ok, sprints, emergence }` (`classifyEmergence`). |
| A010 | done | Tool **`sprint_reopen`** — `reopenSprint` (prolongation `endDate`/`autoClose`) ; renvoie `{ ok, sprint, emergence }` (émergence **suspendue**). |
| A011 | done | Tool **`sprint_attach_pieces`** — `attachPiecesToSprint` (garde nature + émergence) → `{ ok, sprintId, attached, pieces }`. |
| A012 | done | Vérification : `node --check` + **spawn MCP réel** + cycle complet + non-régression (voir §6). |

## 5. Fichiers modifiés / créés

Dans le worktree (commit `947fcf3`) :

- `db.mjs` (modifié) — A001-A004 (additif, aucune primitive T3 touchée).
- `index.mjs` (modifié) — A005-A011 (imports + 6 tools ; `sprint_report` inchangé).

**Aucun** fichier créé, **aucune** modification de `schema.sql`, du modèle ADR (`adr_*`,
`doc_type='adr'`), de la table polymorphe `artifacts`, ni des tables de liens T1.

## 6. Vérifications (preuves)

### 6.1 `node --check` — OK
`node --check db.mjs` et `node --check index.mjs` : **OK** (syntaxe).

### 6.2 Spawn MCP réel (stdio JSON-RPC) — **45/45 PASS ×2** (rejeu idempotent)

MCP `index.mjs` du worktree lancé en stdio (`initialize` → `tools/list` → `tools/call`) :

- **`tools/list`** : **125 tools** ; expose les **6** tools `sprint_*` + `sprint_report` ;
  `sprint_report` présent **une seule fois** (aucun doublon).
- **`sprint_start`** (durée paramétrable) : statut initial `open`, `is_default=false`,
  pièce `atInit` **non émergente**, `counts.pieces=1` ; échéance passée → `close`/`auto_echeance`.
- **`sprint_get`** : détail complet (counts) ; `err` si sprint inconnu.
- **`sprint_attach_pieces`** : `open` → `apres_init_sprint` ; `close` → `apres_cloture` ;
  pièce inconnue → `err` ; artefact non-pièce (`plan`) → `err` « non rattachable » ;
  doc ADR-12 **requalifié** (`doc-mub10mo8-lgo3`) → **rattachable**.
- **`sprint_close`** manuel → `close`/`manuel` + émergence **déclenchée** ; pièce reçue après
  clôture → `apres_cloture`.
- **`sprint_reopen`** → `open` + `reopened_at` + émergence **suspendue** (non émergent).
- **`sprint_report`** (json + markdown) — **réutilisé**, stats complètes.
- **`sprint_list`** → clôture **AUTO à l'échéance** appliquée (`autoClosed` non vide), sprint
  passé à `close`/`auto_echeance` ; `sprint_close { projectId }` OK.
- **Garde nature** : `piece_add` refuse une photo (`.jpg`) — comportement T2 conservé.
- **Non-régression** : `task_register` + `task_delete` OK ; `adr_list` (ADR/`artifacts` intacts) OK ;
  `project_list` OK.

### 6.3 E2E Playwright : **NA**

Aucun `playwright.config.*` ni spec E2E dans `opencode-mcp-task-orchestrator` ; comportement
**interne** (registre + tools MCP), non observable par un parcours Playwright. Aucun
`e2e_test_register` / `e2e_test_link` (conforme plan §7/§9). Vérification par spawn MCP + appels réels.

## 7. Avertissements / erreurs / écarts

1. **Base partagée `task_registry`** — la vérification a créé des données de test (sprints
   `T4 verify*`, pièces `/tmp/t4-*`, 1 tâche) sur le projet `ecosystem`. **Nettoyage effectué** :
   14 sprints de test supprimés, pièces de test supprimées (dont 1 pièce créée en debug direct),
   1 tâche supprimée via `task_delete`. `artifacts` revenue à **836** lignes (identique à l'état
   initial) ; aucun résidu `T4 verify%` / `/tmp/t4-*`.
2. **Sprints `open` multiples** (plan §9.2) — `classifyEmergence` retient le sprint ouvert **le
   plus récent** ; l'émergence reflète donc l'état global du projet, pas seulement le sprint ciblé.
   Comportement conforme à T3, non bloquant ; le test a été rendu déterministe en clôturant les
   sprints ouverts résiduels en pré-nettoyage.
3. **`assertAttachablePiece` — `path`** : pour un doc ADR-12 requalifié, la nature est re-vérifiée
   avec le `path` du document (et non `null`), sans quoi la garde `assertPieceAllowed` refusait à
   tort un doc `markdown` sans `filename`. Corrigé avant commit (les 45 PASS le couvrent).
4. **`meta` de retour de `attachPiecesToSprint`** : le `meta` renvoyé est désormais celui
   **post-marquage** (fusion du marqueur d'émergence), pour éviter un état obsolète dans la réponse.
5. **ADR-001 est `Proposé`** : les ajouts restent **additifs**, sans nouvelle table/colonne ni garde
   bloquante — aucune contradiction avec une ADR Acceptée.
6. **Aucune incohérence code ↔ plan** détectée (`INCONSISTENCY_FOUND` non levée) ; aucun blocage.

## 8. Prochaines étapes / recommandations

1. **Merge/push** de la branche `build-notify/sprint-crud-mcp` par l'orchestrateur (sync avec
   `feature/migration-postgresql` avant push) — **non fait ici**.
2. **T5** : familles `feature_*`/`rule_*` (non implémentées ici, frontière respectée).
3. **T7** : panneau — consommation des tools `sprint_*` (liste/détail/clôture/reprise).
4. **ADR-001** reste **Proposé** : l'acceptation est une **décision humaine**.
