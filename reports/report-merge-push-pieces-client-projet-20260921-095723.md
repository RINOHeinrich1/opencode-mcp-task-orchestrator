# Rapport — Étape MERGE/PUSH — Pièces client par projet

- **Plan (sous-tâche)** : `Plan-pieces-client-projet-20260921-093349`
- **Tâche** : `T-20260921-091730-1rt5` (projet `ecosystem`)
- **Exécution** : `E-T-20260921-091730-1rt5-rud54z`
- **Agent** : `build-notify`
- **Date** : 2026-09-21 09:57 (UTC)
- **Review** : **APPROUVÉE** par l'humain (`DEC-T-20260921-091730-1rt5-mub26efd-nkfj`, 09:55:00Z)

---

## Résumé

Demande : réaliser l'étape **MERGE/PUSH** de la sous-tâche « Pièces client » — pour chacun des
3 repos, se placer sur la branche de déploiement, se synchroniser, merger la branche de travail
`build-notify/pieces-client-projet`, pousser sur `origin`, puis vérifier les livrables et la
cohérence de la base.

Résultat : **3/3 repos mergés en fast-forward et poussés avec succès**, livrables présents et
vérifiés (syntaxe + grep), base PostgreSQL cohérente (`migrate()` idempotent rejoué sans erreur),
**aucun conflit**. Aucun déploiement CI/CD ni manuel (conforme à `repo.deploy = null`).

---

## Isolation

- **Espace Coder** : les 3 repos cibles (`opencode-mcp-task-orchestrator`,
  `opencode-scripts`, `opencode-observability`) sont des **composants d'infrastructure de la
  plateforme d'orchestration**, hébergés sur l'hôte (`/root/...`) et **absents de tout workspace
  Coder** (vérifié via `workspace_list`). La tâche les désigne explicitement par leur chemin hôte.
  Conformément à la norme (exception « composant d'infrastructure »), le travail est fait **in-place
  sur l'hôte**, ce point étant documenté ici. (Précédent identique : tâche `T-20260921-091728-nviw`.)
- **session-guard** : `acquire` → **mode `in-place`** sur les 3 repos (aucune autre session
  parallèle détectée). Verrous libérés en fin de traitement (`release`).
- **Worktrees de la sous-tâche** (branches de travail, laissés en place par l'exécution précédente) :
  - `/root/.config/opencode/mcp/task-orchestrator-wt-pieces-client-projet`
  - `/root/.config/opencode/scripts-wt-pieces-client-projet`
  - `/root/orchestrator-panel-wt-pieces-client-projet`

---

## Branches et commits

| Repo | Branche de travail | Branche de déploiement | HEAD avant | HEAD après | Type de merge |
|---|---|---|---|---|---|
| opencode-mcp-task-orchestrator | `build-notify/pieces-client-projet` | `feature/migration-postgresql` | `570483c` | `5444381` | fast-forward |
| opencode-scripts | `build-notify/pieces-client-projet` | `main` | `3bf4c71` | `d723e9e` | fast-forward |
| opencode-observability | `build-notify/pieces-client-projet` | `feature/migration-postgresql` | `756ac0b` | `685fbda` | fast-forward |

**Commits mergés/poussés** :
- `54443812d0627c7efd6946b204b643ceb8cbbec7` — *feat(pieces-client): famille doc_type 'piece' + garde photo/vidéo + émergence sprint + requalification sans perte*
- `d723e9e292509614166faadd5e40a28029a03195` — *feat(pieces-client): script CLI requalify-pieces-client.mjs*
- `685fbdabb35284060978689f8b3df3190322913c` — *feat(pieces-client): API /api/pieces + onglet « Pièces client » + garde miroir + docs*

> **Note** : les 3 merges sont des **fast-forward** → **aucun commit de merge** créé.
> `plan_commit_add` n'est donc **pas applicable** (aucun nouveau SHA ; les 3 commits étaient déjà
> tracés dans le plan). Pour `opencode-scripts`, le push a également publié 2 commits locaux
> pré-existants de la branche `main` (`61baeb5..d723e9e`) : `90a837a` (e2e-runner v0.2.3) et
> `3bf4c71` (send-mail --to) — travail déjà présent sur la branche de déploiement, conservé intact.

---

## Traitements effectués

1. **Isolation** : `workspace_list` (3 repos absents des workspaces Coder → infra hôte) +
   `session-guard acquire` (in-place ×3).
2. **Synchronisation** : `git fetch origin --prune` sur les 3 repos → **aucun mouvement distant**
   (branches de déploiement locales à jour, hors `main` de scripts déjà en avance locale de 2 commits).
3. **Merges** : `git merge --ff-only build-notify/pieces-client-projet` → **fast-forward 3/3**,
   **aucun conflit**.
4. **Push** : `git push origin <branche de déploiement>` → **3/3 succès**.
5. **Vérification post-merge** :
   - **MCP** : `node --check db.mjs index.mjs` **OK** ; tools `piece_add`, `piece_list`,
     `piece_requalify`, `piece_delete` présents (`index.mjs:527/546/561/573`) ; exports
     `assertPieceAllowed`/`addPiece`/`listPieces`/`requalifyDocsAsPieces`/`removePiece`/`detectOpenSprint`
     présents (`db.mjs`).
   - **Scripts** : `node --check requalify-pieces-client.mjs` **OK**, fichier exécutable
     (`-rwxr-xr-x`).
   - **Panneau** : `node --check server.mjs pilot.mjs public/app.js` **OK** ; routes
     `/api/pieces` (GET/POST), `/api/pieces/:id` (DELETE), `/api/pieces/file` (GET) présentes ;
     onglet « Pièces client » (`piecesTabHtml`, entrée `tabs` ligne 3947) présent ;
     wrappers `pilot.mjs` (`listPieces`/`addPiece`/`requalifyPieces`/`removePiece`/`assertPieceAllowed`) présents.
6. **Cohérence base PostgreSQL** (migration via `ensureSchema()` + `migrate()`, idempotents) :
   - Rejeu **sans erreur** ; base cohérente.
   - Documents ADR-12 requalifiés : **6** (`adr` ×4, `specs` ×1, `gherkin` ×1) — marqueur
     `meta.piece_client=true`, conforme à A006.
   - Pièces nouvelles (`doc_type='piece'`) : **0**.
   - Table `sprint_pieces` présente avec les bonnes colonnes (`sprint_id`, `piece_id`).
7. **Traçabilité** : `plan_transition(merge_pending → merged)`, `plan_set_branch`, `task_event MERGED`,
   `task_event EXECUTION_COMPLETED` (step `merge/push`).

---

## Fichiers modifiés / créés

Aucun fichier de code modifié par cette étape (merge/push uniquement). Fichiers concernés par les
commits mergés (rappel) :

- `opencode-mcp-task-orchestrator` : `db.mjs`, `index.mjs`
- `opencode-scripts` : `requalify-pieces-client.mjs`
- `opencode-observability` : `pilot.mjs`, `server.mjs`, `public/app.js`,
  `public/docs/nomenclature-doc-type.md`, `public/docs/README.md`, `public/docs/14-pieces-client.md`

Créé par cette étape : le présent rapport
`/root/.config/opencode/mcp/task-orchestrator/reports/report-merge-push-pieces-client-projet-20260921-095723.md`

---

## Avertissements / erreurs

- **Aucune erreur**, **aucun conflit**, **aucun force-push**.
- **Pas de déploiement CI/CD ni manuel** : `repo.deploy = null` pour les 3 repos. Conformément à la
  consigne, **aucun** `scp`/`rsync`/`pm2` n'a été exécuté.
- **Caveat runtime (important)** : ces repos sont des checkouts *in-place* utilisés par des process
  **long-running** démarrés avant le merge :
  - `node /root/.config/opencode/mcp/task-orchestrator/index.mjs` (serveur MCP, ~2 h d'uptime) ;
  - `node /root/orchestrator-panel/server.mjs` (panneau, ~2 h d'uptime).
  Le **code mergé ne sera chargé qu'au prochain redémarrage** de ces process. Le redémarrage n'est
  **pas** effectué ici (hors périmètre de l'étape merge/push, et interdit en tant que « déploiement
  manuel »). À déclencher côté plateforme si l'on veut activer les nouveaux tools/routes immédiatement.
  (Le changement de cette sous-tâche n'ajoute **aucune** nouvelle table/migration : `migrate()` était
  déjà appliqué par la tâche 1 ; la base est donc déjà à jour.)
- `opencode-mcp-task-orchestrator` : le checkout principal conserve 4 fichiers **non suivis**
  (`plans/…`, `reports/…`) sans rapport avec cette étape — laissés intacts.

---

## Prochaines étapes / recommandations

1. **Clôture de la tâche** par l'orchestrateur (`in_progress → done`, E2E : NA — aucun test lié),
   comme pour la tâche sœur `T-20260921-091728-nviw`.
2. **Redémarrage des process** MCP `task-orchestrator` et panneau `orchestrator-panel` pour activer
   les tools `piece_*` et l'onglet « Pièces client » côté runtime (action plateforme, hors merge/push).
3. **Recette** (`task.recetteStatus = pending`) : vérifier dans le panneau l'onglet « Pièces client »
   et l'ajout/refus (photo/vidéo) après redémarrage.
4. **Incidence résiduelle** : l'incohérence `INCO-046` (DELETE `/api/pieces/:id` sans tool) a été
   résolue par l'ajout additif du tool `piece_delete` (présent et mergé).
