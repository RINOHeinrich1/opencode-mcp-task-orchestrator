# Rapport de fin de tâche — Pièces client par projet

- **Tâche** : `T-20260921-091730-1rt5` (exécution `E-T-20260921-091730-1rt5-rud54z`)
- **Plan (sous-tâche)** : `Plan-pieces-client-projet-20260921-093349` — **16/16 étapes done (100 %)**
- **Projet** : `ecosystem`
- **Agent** : `build-notify`
- **Date** : 2026-09-21 09:43:43
- **Branche de travail** : `build-notify/pieces-client-projet` (commune aux 3 repos)

---

## 1. Résumé

Implémentation intégrale des **pièces client par projet** (matière première des
sprints) :

- famille `doc_type='piece'` (`content_id = projectId`) + constantes de natures/garde ;
- **garde `assertPieceAllowed`** refusant **photo et vidéo** à l'import **et** pour
  les liens externes (hôtes vidéo connus) ;
- **ajout de pièce** (`addPiece`) avec `meta` complet (nature, url, filename,
  emergent, emergent_origin, sprint_id, security_note), lien `artifact_projects`,
  et **émergence non bloquante** via la table `sprints` (+ lien `sprint_pieces`) ;
- **requalification SANS PERTE** des docs ADR-12 (`requalifyDocsAsPieces`, marqueur
  `meta` seul, idempotente) — **exécutée pour de vrai : 6/6 docs requalifiés** ;
- **tools MCP** `piece_add` / `piece_list` / `piece_requalify` (+ `piece_delete`,
  additif — cf. §7) ;
- **script CLI** `requalify-pieces-client.mjs` ;
- **API panneau** `/api/pieces` (GET/POST/DELETE/file) + **onglet « Pièces client »** ;
- **documentation** : `nomenclature-doc-type.md` à jour + `14-pieces-client.md`
  (dont la **limite de sécurité du lien Drive public**).

Aucun modèle ADR ni la fusion polymorphe `artifacts` n'a été cassé : la famille
`piece` est **additive**, et la requalification ne touche que `meta`.

## 2. Isolation

| Repo | Espace | Worktree | Branche |
|------|--------|----------|---------|
| `opencode-mcp-task-orchestrator` | **HÔTE** (outillage d'infra — aucun workspace Coder) | `/root/.config/opencode/mcp/task-orchestrator-wt-pieces-client-projet` | `build-notify/pieces-client-projet` |
| `opencode-scripts` | **HÔTE** | `/root/.config/opencode/scripts-wt-pieces-client-projet` | `build-notify/pieces-client-projet` |
| `opencode-observability` | **HÔTE** | `/root/orchestrator-panel-wt-pieces-client-projet` | `build-notify/pieces-client-projet` |

- `workspace_list` : **aucun** workspace Coder ne contient ces 3 repos (ce sont les
  composants d'infrastructure de l'écosystème) — conforme à la consigne « HÔTES ».
- `session-guard acquire` : **in-place** (aucune autre session parallèle).
- Le plan §4 interdisant tout commit direct sur les branches principales
  (`feature/migration-postgresql`, `main`), le travail a été mené dans un
  **worktree + branche dédiée** par repo (`session-guard worktree`).
- Les verrous sont **libérés** (`release`) mais les **worktrees et branches sont
  conservés** : le push/merge est une étape d'orchestration ultérieure — un
  `session-guard remove` supprimerait la branche et donc les commits (délivrable).
- `node_modules` symlinké dans les worktrees pour exécuter/valider (gitignoré, non
  committé, symlinks retirés).

## 3. Branches et commits

| Repo | Branche | Commit | Base |
|------|---------|--------|------|
| `opencode-mcp-task-orchestrator` | `build-notify/pieces-client-projet` | `54443812d0627c7efd6946b204b643ceb8cbbec7` | `570483c` |
| `opencode-scripts` | `build-notify/pieces-client-projet` | `d723e9e292509614166faadd5e40a28029a03195` | `3bf4c71` |
| `opencode-observability` | `build-notify/pieces-client-projet` | `685fbdabb35284060978689f8b3df3190322913c` | `756ac0b` |

Traces enregistrées via `plan_commit_add` (append-only) : commits **id 458, 459,
460** avec **fichiers + diffs** complets (`plan_commits_list` → count = 3).
`plan_set_branch(planId, "build-notify/pieces-client-projet")` effectué.

**Aucun push** (merge/push = étape d'orchestration ultérieure).

## 4. Traitements effectués

| Étape | Statut | Détail |
|-------|--------|--------|
| A001 | done | `DOC_TYPES += "piece"` ; constantes `PIECE_DOC_TYPES`, `PIECE_NATURES`, `PIECE_NATURE_BY_EXT`, `PIECE_REFUSED_EXT`, `PIECE_REFUSED_HOSTS`, `PIECE_LINK_SECURITY_NOTE` (`db.mjs`). |
| A002 | done | `assertPieceAllowed` exportée : refus photo/vidéo import + liens (hôtes vidéo + extension d'URL). |
| A003 | done | `detectOpenSprint(projectId)` → `{sprintId, status}` \| `null` (après `migrate()`). |
| A004 | done | `addPiece` : `doc_type='piece'`, `content_id=projectId`, `kind='autre'`, `meta` complet, lien `artifact_projects`, émergence (`sprint_pieces`). |
| A005 | done | `listPieces` : pièces nouvelles + docs requalifiés (`requalified=true`), filtres `nature`/`emergent`/`includeRequalified`. |
| A006 | done | `requalifyDocsAsPieces` : `meta` seul, `COALESCE(meta,'{}') \|\| marqueur`, idempotent. |
| A007 | done | Tool MCP `piece_add`. |
| A008 | done | Tool MCP `piece_list`. |
| A009 | done | Tool MCP `piece_requalify` (+ `piece_delete`, additif — §7). |
| A010 | done | Script `requalify-pieces-client.mjs` (repo `opencode-scripts`). |
| A011 | done | `pilot.mjs` : `listPieces` / `addPiece` / `requalifyPieces` / `removePiece` + garde miroir. |
| A012 | done | `server.mjs` : `DOC_TYPES += "piece"`, MIME pdf/docx, routes `/api/pieces` (GET/POST/DELETE) + `/api/pieces/file`. |
| A013 | done | Garde miroir **avant écriture** (HTTP 400, aucune écriture disque) + dossier `storage/pieces`. |
| A014 | done | `public/app.js` : `piecesTabHtml` + entrée onglet « Pièces client » + wiring. |
| A015 | done | `nomenclature-doc-type.md` : 14 familles, ligne `piece`, mapping, `ON DELETE`, requalification. |
| A016 | done | `public/docs/14-pieces-client.md` (+ index `README.md`). |

## 5. Vérifications (preuves)

**MCP — 42/42 PASS** (script de vérification contre PostgreSQL, données de test nettoyées) :
- **Garde photo/vidéo** : `.jpg`, `.mp4`, `.png` refusés ; YouTube/Vimeo refusés ;
  lien `.mp4` refusé ; `.md/.pdf/.docx` → natures correctes ; URL Drive → `lien`.
- **addPiece** : refus photo/vidéo, refus projet inconnu, `doc_type='piece'` +
  `content_id=project`, lien `artifact_projects`, `meta.piece_nature`,
  `security_note` sur les liens, **idempotence** (même URL → même pièce).
- **Émergence** : `detectOpenSprint` null sans sprint ; sprint ouvert →
  `emergent=true` / `apres_init_sprint` / `sprint_id` + lien `sprint_pieces` ;
  sprint clôturé → `apres_cloture` ; **non bloquant**.
- **Requalification réelle** : **6/6** docs requalifiés ; 2ᵉ passage = **0**
  (idempotent) ; `doc_type`/`content_id`/`path` **inchangés** ; `meta.piece_client=true`
  partout ; liens `artifact_projects` conservés (6) ; docs non supprimés (6).
- **Régression** : `listDocs` (6), `listAdrs` (1), `doc_list`/`doc_get` intacts ;
  `listPieces(ecosystem)` inclut le doc requalifié.

**Tools MCP — 6/6 PASS** (JSON-RPC réel) : `tools/list` expose `piece_add`,
`piece_list`, `piece_requalify`, `piece_delete` ; refus vidéo ; ajout lien +
`securityNote` ; delete ; requalify idempotent.

**Script CLI — PASS** : `--project ecosystem` (total 1, already 1),
`--all` (total 6, already 6), `--dry-run` refusé (exit 1).

**Panneau — 9/9 PASS** : garde miroir `pilot.assertPieceAllowed` (refus
photo/vidéo/YouTube/lien `.mov` ; md/pdf/docx/lien corrects). `node --check`
OK sur `pilot.mjs`, `server.mjs`, `public/app.js`.

**E2E Playwright** : **NA** — comportement interne (MCP + panneau), aucun
`playwright.config.*` dans les 3 repos. Aucun test E2E enregistré/lié (cf. plan §9).

## 6. Fichiers modifiés / créés

**`opencode-mcp-task-orchestrator`** (commit `5444381`)
- `db.mjs` (modifié) — taxonomie + constantes + `detectOpenSprint`,
  `assertPieceAllowed`, `pieceNatureFromPath`, `rowToPiece`, `addPiece`, `getPiece`,
  `listPieces`, `requalifyDocsAsPieces`, `removePiece`.
- `index.mjs` (modifié) — imports + tools `piece_add` / `piece_list` /
  `piece_requalify` / `piece_delete`.

**`opencode-scripts`** (commit `d723e9e`)
- `requalify-pieces-client.mjs` (créé).

**`opencode-observability`** (commit `685fbda`)
- `pilot.mjs` (modifié) — wrappers + garde miroir.
- `server.mjs` (modifié) — taxonomie, MIME, routes, garde d'import.
- `public/app.js` (modifié) — onglet « Pièces client ».
- `public/docs/nomenclature-doc-type.md` (modifié).
- `public/docs/README.md` (modifié) — index.
- `public/docs/14-pieces-client.md` (créé).

## 7. Avertissements / erreurs / écarts

1. **Écart de plan (NON bloquant) — incohérence `INCO-046`** : A012 exige la route
   `DELETE /api/pieces/:id` mais A007–A009 ne prévoient **aucun tool de
   suppression**. Le panneau n'écrivant que via le MCP, la route était
   inimplémentable sans tool dédié. Résolution : ajout **additif** du tool
   `piece_delete` (famille `piece` uniquement, CASCADE). Aucune signature
   existante modifiée. Persisté via `plan-manager_inconsistency_create`.
2. **`path NOT NULL`** : le registre PostgreSQL porte `path NOT NULL` (schéma
   historique), alors que `schema.sql` le déclare nullable. Pour les liens, l'URL
   est stockée **aussi** dans `path` (localisation) en plus de `meta.url`.
   Aucun changement de schéma (`schema.sql` non touché, conformément au plan).
3. **Ordre d'intégration** : le panneau (`mcp-client.mjs`) lance le MCP du
   checkout **principal** ; les tools `piece_*` ne seront donc effectifs pour le
   panneau **qu'après merge** du MCP. L'intégration panneau↔MCP est vérifiée au
   niveau MCP (JSON-RPC) et au niveau garde ; le test bout-en-bout via l'onglet
   reste à faire après merge.
4. **Espace Coder** : les 3 repos sont des composants d'infrastructure HÔTES
   (hors workspaces Coder) — assumé et documenté.
5. **Sécurité** : le lien Drive public expose le contenu à quiconque a l'URL
   (risque assumé ADR-001) — documenté (A016) et rappelé dans l'UI.

## 8. Prochaines étapes / recommandations

1. **Merge/push** des 3 branches `build-notify/pieces-client-projet` par
   l'orchestrateur (sync avec la branche principale avant push).
2. **Après merge** : vérifier l'onglet « Pièces client » dans le panneau
   (bout-en-bout MCP↔panneau) et l'ajout d'un lien Drive public réel.
3. **ADR-001** est **Proposé** : ce plan implémente son point 4 — l'acceptation
   reste une **décision humaine**.
4. **Sprint** : `detectOpenSprint` repose sur l'hypothèse « sprint initialisé =
   existence d'un sprint » ; à confirmer lors de la tâche « session sprint ».
5. **Mécanisme d'accès strict** au lien Drive (compte de service / URL signée) à
   décider ultérieurement (ADR).
