# Rapport — Fix précédence SQL `listDocs` (INC-011)

- **Tâche** : `T-20260920-172734-370n` — *Fix précédence SQL listDocs (filtre status ignoré avec includeRepoDocs)*
- **Exécution** : `E-T-20260920-172734-370n-iiiqve` (exécution directe, `directExecution: true`)
- **Agent** : `build-notify`
- **Date** : 2026-09-21 06:53 UTC
- **Type** : debug / correctif précisément spécifié
- **Incident** : INC-011

## Résumé

**Demandé** : dans `db.mjs`, fonction `listDocs` (branche `includeRepoDocs`), la clause SQL
`WHERE ... IN (docs projet) OR ... IN (docs repos) AND <conds>` subissait la précédence SQL
(`AND` > `OR`) : le filtre `status` (et tout `conds`) ne s'appliquait qu'à la 2ᵉ branche
(docs des repos). `doc_list(projectId, includeRepoDocs=true, status=X)` renvoyait donc des
docs **du projet** de statut non filtré.

**Fait** : l'expression `OR` est désormais parenthésée, de sorte que les conditions
s'appliquent aux deux branches. Les autres branches (`else` projet seul, `repoId`, cas
global) sont inchangées. Un test de non-régression a été ajouté et validé (8/8), y compris
sa falsifiabilité (2 échecs sans le correctif).

## Isolation

- **Espace Coder** : non applicable — le projet `opencode-mcp-task-orchestrator` (produit
  `ecosystem`) est un **composant d'infrastructure** (le MCP registre lui-même) ; il
  n'existe dans **aucun** workspace Coder (`workspace: null` dans le registre, absent des
  7 workspaces listés). Travail **sur l'hôte** conformément à l'exception « composant
  d'infrastructure » de la norme, et conformément au périmètre fourni par la demande.
- **Session guard** : `session-guard acquire` → **code 0 / mode `in-place`** (aucune autre
  session en parallèle sur ce dépôt). Travail dans le checkout courant.
- **Worktree** : aucun (in-place), branche active `feature/migration-postgresql`.

## Branches et commits

- **Branche de travail** : `feature/migration-postgresql`
- **SHA de référence (base)** : `cf33751ab7bf533bb01a540fc77de0370f534b2a`
- **Commit** :

| SHA | Message |
| --- | --- |
| `45ccf90f539f776af38292ef701fc1caec666365` | `fix(db): listDocs includeRepoDocs — parenthéser l'expression OR (précédence SQL, INC-011)` |

- **Push** :
  - `cf33751..45ccf90  feature/migration-postgresql -> feature/migration-postgresql`
  - Promotion **fast-forward** : `main` `cf33751..45ccf90` (aucun `--force`)
  - État final : `main` = `feature/migration-postgresql` = `origin` = `45ccf90` ; retour sur
    `feature/migration-postgresql`.

## Traitements effectués

1. **ÉTAPE 0/1** — Projet cible identifié : `opencode-mcp-task-orchestrator`,
   `/root/.config/opencode/mcp/task-orchestrator` ; `workspace_list` → aucun workspace Coder
   ne porte ce projet (composant d'infrastructure). Base de code hôte assumée et documentée.
2. **ÉTAPE 2** — `session-guard acquire` → `mode: in-place`, exit 0. Base SHA mémorisée.
3. **Correctif** — `db.mjs` (`listDocs`, ≈ l.2013-2021) : parenthésage de l'expression `OR`
   + mise à jour du commentaire qui actait la préservation du bug (l.2002-2004).
4. **`node --check db.mjs`** → OK.
5. **Test de non-régression** — création de `scripts/test-listdocs-include-repodocs.mjs` :
   base PostgreSQL **jetable** (créée puis supprimée ; process enfant pour les assertions),
   1 projet + 2 repos + 4 ADR (projet/repo × statuts Accepté/Proposé), 8 assertions.
   - Avec correctif : **OK — 8/8**.
   - **Falsifiabilité** : correctif temporairement retiré (`git stash`) → **ÉCHEC — 6/8**,
     les 2 assertions `includeRepoDocs + status` échouent en exposant les docs du projet de
     statut non filtré. Correctif restauré (fichier identique).
6. **Spawn réel du MCP** via `/root/orchestrator-panel/mcp-client.mjs`
   (`taskOrchestrator(tool,args)`) : `doc_list`, `artifact_list`, `org_list` → **OK**
   (pas de crash). Post-déploiement : `doc_list` count=5, `artifact_list` count=500,
   `org_list` count=2.
7. **Round-trip end-to-end MCP (données réelles)** : 2 ADR temporaires enregistrées
   (`doc_register`) sur `ecosystem` / repo `opencode-mcp-task-orchestrator`, puis
   `doc_list(projectId=ecosystem, includeRepoDocs=true, status=…)` :
   - sans `status` → les 2 docs (inchangé) ;
   - `status=Accepté` → **uniquement** l'ADR projet Accepté ;
   - `status=Proposé` → **uniquement** l'ADR repo Proposé.
   → **PASS**. Nettoyage : les 2 ADR supprimées (`doc_delete`) ; **0 doc INC011 restant**,
   les 5 ADR préexistantes (myxmax / oniria / mada-talk) intactes.
8. **Déploiement** : commit sur `feature/migration-postgresql`, push, promotion
   **fast-forward** sur `main`, push, retour sur `feature/migration-postgresql`.
9. **Vérification post-déploiement** : `node --check` OK, test 8/8 OK, MCP 3 tools OK.

## Fichiers modifiés / créés

- `db.mjs` *(modifié, +5/-5)* — parenthésage de la clause `OR` dans `listDocs`/`includeRepoDocs` + commentaire.
- `scripts/test-listdocs-include-repodocs.mjs` *(créé, +185)* — test de non-régression (base jetable).

## Avertissements / erreurs

- Le dépôt **n'a aucune infrastructure de test** (pas de `package.json#scripts.test`, pas de
  framework) : le test est un script Node autonome (`node scripts/test-…mjs`, exit 0/1),
  exécutable en CI ou manuellement.
- Le test crée une base PostgreSQL jetable (`task_registry_inc011_*`) : il exige les droits
  `CREATEDB` (l'utilisateur `orchestrator` est superuser ici). Elle est systématiquement
  supprimée (`DROP … WITH (FORCE)`), y compris en cas d'erreur.
- Le round-trip end-to-end a écrit **temporairement** 2 ADR dans le registre réel avant
  suppression ; état vérifié après coup (aucun résidu).
- Aucun email envoyé (notifications gérées par la plateforme `opencode-notifier`).

## Prochaines étapes / recommandations

- Envisager de **pérenniser le test** dans un runner (npm script / CI) et d'étendre la
  couverture aux autres filtres combinés (`kind` + `includeRepoDocs`, `limit`).
- Le même patron de parenthésage mérite un audit rapide des autres requêtes construites par
  concaténation de `conds` avec un `OR` interne (recherche ` OR ` dans les templates SQL de
  `db.mjs`) — aucune autre occurrence identifiée dans le périmètre de cette tâche.
- Rien à faire côté panneau : l'impact était limité au contrat du registre (filtrage
  côté client dans l'onglet ADR).
