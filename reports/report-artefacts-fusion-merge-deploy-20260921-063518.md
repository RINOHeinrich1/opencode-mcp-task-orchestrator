# Rapport — Merge + déploiement « Artefacts fusion polymorphe »

- **Tâche** : `T-20260920-162801-jxtr`
- **Exécution** : `E-T-20260920-162801-jxtr-vfbfzp`
- **Plan** : `Plan-artefacts-fusion-polymorphe-20260921-060112`
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 06:35 UTC
- **Périmètre** : 2 repos d'outillage (produit `ecosystem`)

## 1. Résumé

Demandé : merger les branches de travail de la fusion polymorphe des artefacts dans
`feature/migration-postgresql` sur les **2 repos** (MCP task-orchestrator + panneau
orchestrator-panel), pousser, redémarrer le panneau, vérifier, **sans exécuter
`neutralize` (A078)**.

Fait :
- MCP : merge `build-notify/artefacts-fusion-mcp` → `feature/migration-postgresql` (merge commit `3c4773e`), poussé.
- Panneau : merge `build-notify/artefacts-fusion-panel` → `feature/migration-postgresql` (merge commit `76e3ad0`), poussé, `pm2 restart orchestrator-panel` → `online`.
- A078 (`neutralize`) **NON exécutée** : tables `docs` / `recette_documents` vérifiées intactes en base.
- Aucun push vers `main`, aucune modification non commitée sur les fichiers suivis.

## 2. Isolation / localisation

- **Espaces Coder** : aucun des deux repos n'existe dans un workspace Coder. Ce sont des
  **composants d'infrastructure de l'écosystème opencode** (le MCP et le panneau qui *pilotent*
  les workspaces) — cas d'exception explicite de la norme. Traitement en **in-place** sur les
  git roots hôte désignés par la demande : `/root/.config/opencode/mcp/task-orchestrator` et
  `/root/orchestrator-panel`.
- **session-guard** : `acquire` sur les deux git roots → `mode: "in-place"`, code de sortie `0`
  (aucune autre session en parallèle). Verrous libérés en fin de traitement (`release`).
- Aucun worktree créé, aucune branche dédiée session (`build-notify/<session>`) nécessaire.

## 3. Branches et commits

### Repo 1 — MCP `/root/.config/opencode/mcp/task-orchestrator`
| Élément | Valeur |
|---|---|
| Branche de travail mergée | `build-notify/artefacts-fusion-mcp` |
| Base | `9187ea9` |
| Commits de la branche | `090d310`, `3ebf9f0` |
| **SHA de merge** | **`3c4773ed338b64e9be14b325d3bd18076ca7d888`** |
| Branche cible / poussée | `feature/migration-postgresql` |

### Repo 2 — Panneau `/root/orchestrator-panel`
| Élément | Valeur |
|---|---|
| Branche de travail mergée | `build-notify/artefacts-fusion-panel` |
| Base | `5fef85b` |
| Commits de la branche | `3ab81ba` |
| **SHA de merge** | **`76e3ad0da4cca9355dc26aadb61f6711c806ee48`** |
| Branche cible / poussée | `feature/migration-postgresql` |

Merges réalisés en `--no-ff` (aligné sur le style d'historique du repo : merge commits explicites).

## 4. Traitements effectués

1. Reconnaissance : `workspace_list` (MCP coder-workspaces), état git des 2 repos, `task_get`.
2. `session-guard acquire` ×2 → in-place, exit 0.
3. `git fetch` ×2 ; contrôle base == HEAD, merge-base == base (branches fast-forwardables).
4. MCP : `git merge --no-ff build-notify/artefacts-fusion-mcp` → `3c4773e` (6 fichiers, +1295/−335).
5. MCP : `node --check` sur `db.mjs`, `index.mjs`, `scripts/artifacts-fusion-migration.mjs` → OK.
6. MCP : contrôle `doc_type`/`content_id` présents dans `schema.sql` (5 occurrences chacun).
7. MCP : `git push origin feature/migration-postgresql` → `9187ea9..3c4773e` ; local == origin ✅.
8. Panneau : `git merge --no-ff build-notify/artefacts-fusion-panel` → `76e3ad0` (4 fichiers, +366/−37).
9. Panneau : `node --check server.mjs` OK ; `/api/artifacts` présent dans `server.mjs` (2 routes) ;
   onglet « Artefacts » présent dans `public/app.js` (4 occurrences).
10. Panneau : `git push origin feature/migration-postgresql` → `5fef85b..76e3ad0` ; local == origin ✅.
11. Panneau : `pm2 restart orchestrator-panel` → `online`.
12. Vérifs HTTP live (port 4000) : `GET /login` → **200** ; `GET /api/artifacts` → **401**
    (route existante, authentification requise) ; `GET /docs/nomenclature-doc-type.md` → **200** ;
    `app.js` servi contient bien « Artefacts ».
13. Vérif lecture seule base PostgreSQL (tables legacy) — voir §6.
14. Trace : `plan_commit_add` ×2 (commits de merge), `deployment_record` (status `deployed`),
    `plan_transition` `merge_pending → merged → deploy_pending → deploying → deployed`,
    `plan_set_branch` = `feature/migration-postgresql`, événements `EXECUTION_STARTED` / `CHECKPOINT` / `EXECUTION_COMPLETED`.
15. `session-guard release` ×2.

## 5. Vérifications — résultats

| Vérification | MCP | Panneau |
|---|---|---|
| `local == origin` | ✅ `3c4773e` = `3c4773e` | ✅ `76e3ad0` = `76e3ad0` |
| Fichiers suivis non commités | ✅ 0 | ✅ 0 |
| `node --check` | ✅ 3/3 | ✅ 1/1 |
| `doc_type`/`content_id` dans `schema.sql` | ✅ 5 + 5 | n/a |
| `/api/artifacts` dans `server.mjs` | n/a | ✅ 2 |
| Onglet « Artefacts » dans `app.js` | n/a | ✅ 4 |
| Service `online` (pm2) | n/a (bibliothèque MCP) | ✅ `online`, v0.9.65 |
| `GET /login` → 200 | n/a | ✅ 200 |
| `GET /api/artifacts` → route | n/a | ✅ 401 (auth) |

## 6. Contrainte A078 — `neutralize` NON exécutée (conforme)

Contrôle lecture seule de la base `task_registry` :

| Table | Présente | Lignes |
|---|---|---|
| `artifacts` | ✅ | 806 |
| `docs` | ✅ | 5 |
| `recette_documents` | ✅ | 30 |
| `doc_attachments` | ✅ | 0 |
| `doc_projects` | ✅ | 5 |
| `doc_repos` | ✅ | 5 |

- **Aucune** table renommée `legacy_*` → `neutralize` n'a pas été lancée.
- Les tables `docs` / `recette_documents` sont **intactes** (le MCP des sessions en cours peut
  toujours lire le legacy).
- Des tables de snapshot `*_backup_20260921062725` existent (créées lors de la session de
  migration précédente, avant ce merge) : point de restauration, laissées en place.
- A078 est restée au statut `blocked` dans le registre du plan (pas de modification).

## 7. Fichiers modifiés / créés

Aucune écriture directe de code par cette session (opérations git + pm2 uniquement).
Contenu apporté par les merges :

**MCP (`3c4773e`)** : `db.mjs`, `index.mjs`, `schema.sql`, `scripts/artifacts-fusion-migration.mjs` (nouveau),
`reports/artifacts-inventory-live.md` (nouveau), `reports/artifacts-validation-live.md` (nouveau).

**Panneau (`76e3ad0`)** : `server.mjs`, `public/app.js`, `public/style.css`,
`public/docs/nomenclature-doc-type.md` (nouveau).

**Rapport produit** : `reports/report-artefacts-fusion-merge-deploy-20260921-063518.md` (ce fichier).

## 8. Avertissements / erreurs

- **Fichiers untracked pré-existants** dans le repo MCP : `plans/` et `reports/` (rapports/plans des
  sessions précédentes, volontairement non suivis). Ils ne sont **pas** de cette session et n'ont
  pas été touchés ; ils n'ont pas gêné les merges (noms de fichiers distincts). « Aucune
  modification non commitée » s'entend sur les fichiers **suivis** : 0.
- `collect-git-commits.mjs` renvoie `files: []` pour un commit de **merge** ; la liste des fichiers
  du merge a donc été renseignée manuellement (via `git diff --numstat <base> <merge>`).
- Le MCP task-orchestrator n'est pas un service redémarré : il est chargé au démarrage des sessions
  opencode. Conformément à la consigne « ne relance pas les instances opencode », aucun redémarrage
  de session n'a été effectué ; le nouveau code MCP sera pris en compte à la prochaine session.
- `plan_set_branch` est exposé par le MCP **plan-manager** (et non task-orchestrator) — appelé
  correctement sur ce serveur.

## 9. Prochaines étapes / recommandations

1. **A078 (`neutralize`) reste à exécuter** après bascule effective du code rebasé
   (redémarrage des sessions opencode consommant le MCP + panneau déjà redémarré) :
   `node scripts/artifacts-fusion-migration.mjs neutralize`.
   Elle renomme les tables legacy en `legacy_*` (jamais de DROP) et rebase la FK `adr_conflicts`.
2. Avant A078 : s'assurer qu'aucune session opencode en cours ne lit encore le legacy, et que le
   point de restauration (`*_backup_20260921062725`) est conservé.
3. Recette fonctionnelle du panneau (onglet « Artefacts » : filtres, Regarder/Télécharger, Ajout)
   une fois authentifié — non couverte par les vérifs HTTP anonymes de ce rapport.
4. Le plan est au statut `deployed` ; la recette de la tâche reste `pending` (décision humaine).
