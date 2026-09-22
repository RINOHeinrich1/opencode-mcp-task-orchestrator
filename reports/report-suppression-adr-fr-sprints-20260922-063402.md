# Rapport — Suppression ADR / Fonctionnalités / Règles métier / Sprints

- **taskId** : `T-20260922-060057-febv`
- **executionId** : `E-T-20260922-060057-febv-ldsper`
- **planId** : `Plan-suppression-adr-fonctionnalites-regles-sprints-20260922-060417`
- **projet** : `ecosystem`
- **agent** : `build-notify`
- **date** : 2026-09-22 06:34
- **scope** : `Plan-suppression-adr-fonctionnalites-regles-sprints-20260922-060417`

---

## 1. Résumé

**Demandé** : ajouter les outils MCP de suppression manquants (`feature_delete` avec garde
« ADR ≥ 1 fonctionnalité » + `cascadeAdrs`, `rule_delete`, `sprint_delete` avec refus du sprint par
défaut et des sprints portant tâches/recettes) et les exposer dans le panneau (sous-onglet
Fonctionnalités, sous-onglet Règles métier, onglet Sprints ; onglet ADR déjà couvert par
`doc_delete`), avec confirmation obligatoire, messages d'erreur explicites et rafraîchissement.

**Fait** : les 24 étapes (A001–A024) sont **terminées**. 5 fichiers modifiés (2 MCP + 3 panneau),
2 commits sur branches dédiées, `node --check` OK ×5, **spawn MCP réel 12/12 PASS** (gardes
d'intégrité testées + données de test nettoyées) et **parcours panneau sur instance de TEST
PORT=4010 15/15 PASS**. Aucune modification ADR (le bouton/route/tool de suppression ADR
existaient déjà — constat A020). Aucune DDL, aucun bump `SCHEMA_VERSION`, PM2 non redémarré.

---

## 2. Isolation

- **Espace Coder** : aucun workspace Coder ne contient ces deux dépôts (outillage d'infrastructure
  hôte) → travail sur l'hôte conformément à la norme (composant d'infrastructure).
- **session-guard** : `acquire` sur les 2 dépôts → `mode: in-place` (aucune session parallèle).
  La consigne imposant le **worktree** (ne pas laisser les checkouts principaux sur une branche de
  travail, le panneau live servant les statiques du working tree), deux worktrees ont été créés sur
  la branche dédiée `build-notify/T-20260922-060057-febv` :
  - **opencode-mcp-task-orchestrator** : `/root/.config/opencode/mcp/task-orchestrator-wt-T-20260922-060057-febv`
  - **opencode-observability** : `/root/orchestrator-panel/.worktrees/build-notify-T-20260922-060057-febv`
    (relocalisé dans le dossier `.worktrees/` du dépôt : le chemin par défaut
    `/root/orchestrator-panel-wt-…` est **hors des chemins autorisés** par la politique
    `external_directory`. Voir §7 Écart 1.)
- **Checkouts principaux** : restés sur `feature/migration-postgresql` (branche principale) pendant
  tout le traitement, aucun commit dessus, **jamais** sur la branche de travail.

---

## 3. Branches et commits

| Repo | Branche de travail | Base | Commit |
|------|--------------------|------|--------|
| `opencode-mcp-task-orchestrator` | `build-notify/T-20260922-060057-febv` | `720e7d6` | **`bf40c830dd82ca63a08bd48de2aec601b772e5bd`** |
| `opencode-observability` | `build-notify/T-20260922-060057-febv` | `1cc0293` | **`68b16bd3d94752ad1c778b67e954a918ce0f89a2`** |

- `bf40c830` — `feat(mcp): outils de suppression feature_delete (garde ADR ≥1 fonctionnalité + cascadeAdrs), rule_delete, sprint_delete (refus sprint par défaut / tâches / recettes) (A001-A007)`
- `68b16bd3` — `feat(panneau): boutons Supprimer (confirmation + erreurs explicites) Fonctionnalités/Règles/Sprints + wrappers pilot + routes DELETE (cascade ADR sur 2e confirmation, sprint par défaut masqué) (A008-A019)`

Trace append-only enregistrée via `plan_commit_add` (2 commits, avec fichiers + diffs).
**Aucun push** (merge/push = étape d'orchestration ultérieure).

---

## 4. Traitements effectués (A001–A024)

| Étape | Action | Résultat |
|-------|--------|----------|
| A001 | `db.mjs` : `deleteFeature(featureId,{cascadeAdrs,by})` | pré-check ADR orphelines ; refus `[ADR_LAST_FEATURE]` ; cascade ADR **dans la même transaction, avant les liens** ; détachement des 6 tables ; retour `{featureId,deleted,cascadedAdrs}` |
| A002 | `db.mjs` : `deleteRule(ruleId)` | transaction + détachement `fonctionnalite_regles`/`sprint_regles` |
| A003 | `db.mjs` : `deleteSprint(sprintId)` | refus dur `[SPRINT_DEFAULT]` / `[SPRINT_LINKED]` ; sinon détache `sprint_*`, `migrations.sprint_id`→NULL (SET NULL), nettoie signaux cardinalité `open` |
| A004 | `index.mjs` : imports `deleteFeature`/`deleteRule`/`deleteSprint` | OK |
| A005 | `index.mjs` : tool `feature_delete` (`featureId`,`cascadeAdrs?`,`by?`) | OK |
| A006 | `index.mjs` : tool `rule_delete` (`ruleId`) | OK |
| A007 | `index.mjs` : tool `sprint_delete` (`sprintId`) | OK |
| A008 | `pilot.mjs` : `deleteFeature` | pont `taskOrchestrator("feature_delete",…)` |
| A009 | `pilot.mjs` : `deleteRule` | pont `rule_delete` |
| A010 | `pilot.mjs` : `deleteSprint` | pont `sprint_delete` |
| A011 | `server.mjs` : `DELETE /api/features/:id?cascadeAdrs=1` | 409 si `[ADR_LAST_FEATURE]` |
| A012 | `server.mjs` : `DELETE /api/rules/:id` | 409 en cas de refus |
| A013 | `server.mjs` : `DELETE /api/sprints/:id` | 409 si `[SPRINT_DEFAULT]`/`[SPRINT_LINKED]` |
| A014 | `app.js` : bouton `data-fr-del` (frFeatureTableHtml) | OK |
| A015 | `app.js` : câblage `deleteFeatureFlow` | confirm → DELETE → refresh ; refus ADR → **2ᵉ confirmation** cascade |
| A016 | `app.js` : bouton `data-rule-del` (frRuleTableHtml) | OK |
| A017 | `app.js` : câblage `deleteRuleFlow` | confirm → DELETE → refresh |
| A018 | `app.js` : bouton `data-sp-del` (renderSprints) | **masqué si `s.isDefault`** |
| A019 | `app.js` : câblage sprint delete | confirm → DELETE → `renderSprints()` ; refus affiché tel quel |
| A020 | Vérif suppression ADR (déjà existante) | **aucun code ajouté** (voir §6) |
| A021 | `node --check` ×5 | **5/5 OK** |
| A022 | spawn MCP réel (cycle + gardes + nettoyage) | **12/12 PASS** |
| A023 | parcours panneau TEST `PORT=4010` | **15/15 PASS** |
| A024 | rapport de vérification | ce document |

---

## 5. Fichiers modifiés / créés

| Fichier | Repo | Type |
|---------|------|------|
| `db.mjs` | opencode-mcp-task-orchestrator | modifié (+139) : 3 fonctions `delete*` |
| `index.mjs` | opencode-mcp-task-orchestrator | modifié (+44) : 3 imports + 3 tools |
| `pilot.mjs` | opencode-observability | modifié (+26) : 3 wrappers |
| `server.mjs` | opencode-observability | modifié (+24) : 3 routes DELETE |
| `public/app.js` | opencode-observability | modifié (+49) : 3 boutons + 2 helpers + 3 câblages |
| `reports/report-suppression-adr-fr-sprints-20260922-063402.md` | opencode-mcp-task-orchestrator | créé (ce rapport) |

Aucun changement de schéma (`schema.sql` intact) ; **aucune DDL** ; `SCHEMA_VERSION` inchangé.
Non-régression perf : aucune requête ajoutée aux listes (`feature_list`/`rule_list`/`sprint_list`/
`doc_list` inchangés) ; les seules requêtes nouvelles sont celles des suppressions (à la demande).

---

## 6. Vérifications

### A020 — constat ADR (déjà couvert, aucun code ajouté)
- Bouton : `public/app.js:4524` `data-${prefix}-del` (« Supprimer ») rendu par `adrTableHtml`.
- Câblage + confirmation + erreur explicite : `public/app.js:4574-4578` (`bindAdrTable`).
- Route : `server.mjs:1723-1727` `DELETE /api/docs/:id` (`docDelMatch`).
- Tool : `index.mjs:510` `doc_delete`.
→ La demande « bouton Supprimer dans l'onglet ADR » **était déjà satisfaite** ; **aucun code ADR
ajouté** (évite le doublon). L'onglet ADR gère le refus via `alert('Suppression impossible : …')`.

### A021 — `node --check` (5 fichiers)
```
OK db.mjs · OK index.mjs · OK pilot.mjs · OK server.mjs · OK public/app.js
```

### A022 — spawn MCP réel (worktree `index.mjs`), projet `ecosystem`, 12/12 PASS
1. `feature_delete` sans cascade sur une ADR à 1 fonctionnalité → **refus `[ADR_LAST_FEATURE]`**,
   ADR et fonctionnalité **toujours présentes** (aucune suppression silencieuse).
2. `feature_delete cascadeAdrs=true` → fonctionnalité supprimée **+ ADR cascadée** (`cascadedAdrs`
   contient l'ADR) ; `doc_get` → « doc inconnu ».
3. `rule_delete` → supprimée (`rule_get` → erreur).
4. `sprint_delete` sur le **sprint par défaut** `SPRINT-mub8nu9e-tsl0` → **refus `[SPRINT_DEFAULT]`**.
5. `sprint_delete` sur un sprint portant une tâche → **refus `[SPRINT_LINKED]`** (1 tâche) ;
   après `task_sprint_unlink`, suppression nominale OK.
6. **Nettoyage vérifié** : `features=0 · rules=0 · docs=0 · sprints=1` (le sprint par défaut).

### A023 — parcours panneau sur instance de TEST `PORT=4010` (jamais le PM2 live), 15/15 PASS
- Instance démarrée depuis le **worktree** avec `MCP_TASK_ORCHESTRATOR_PATH` pointant sur le MCP du
  worktree ; statiques servis = version du worktree (boutons/handlers présents).
- `POST /api/features` 201 → `DELETE` **409 `[ADR_LAST_FEATURE]`** → `DELETE ?cascadeAdrs=1` **200**
  + ADR cascadée ; ADR absente après.
- `POST /api/rules` 201 → `DELETE /api/rules/:id` **200**.
- `POST /api/sprints` 201 → `DELETE /api/sprints/:id` **200**.
- `DELETE /api/sprints/<défaut>` → **409 `[SPRINT_DEFAULT]`**.
- Statique : présence de `data-fr-del`/`data-rule-del`/`data-sp-del`, `deleteFeatureFlow`,
  `cascadeAdrs=1`, `s.isDefault ? '' :` (masquage du sprint par défaut), `deleteRuleFlow`.
- Nettoyage vérifié : `features=0 · rules=0 · docs=0 · sprints=1`.
- **PM2 non redémarré** ; panneau live (port 4000) toujours en ligne ; session de test supprimée.

---

## 7. Avertissements / écarts

1. **Worktree panneau relocalisé** : le chemin par défaut de `session-guard`
   (`/root/orchestrator-panel-wt-T-…`) est **hors des chemins autorisés** par la politique
   `external_directory`. Le worktree a donc été créé manuellement sous
   `/root/orchestrator-panel/.worktrees/build-notify-T-20260922-060057-febv` (chemin autorisé,
   dossier `.worktrees/` déjà présent dans le dépôt). Conséquence : le nettoyage final de ce
   worktree est fait manuellement (`git worktree remove` + `git branch -D`) et non par
   `session-guard remove` (le verrou est libéré via `session-guard release`). Le checkout principal
   du panneau n'est jamais passé sur la branche de travail.
2. **Session de test panneau** : une session admin éphémère a été créée dans la base PG `panel`
   (utilisateur `admin`, id 12) pour exercer les routes protégées sur l'instance de TEST ; elle a
   été **supprimée** en fin de parcours.
3. **Données de test** : créées puis **entièrement nettoyées** (vérifié par compteurs).
4. **Écart de constat (demande vs code)** : la demande affirmait que l'onglet ADR n'avait aucune
   action de suppression ; le code prouve le contraire (déjà présent). Traité en vérification (A020),
   **aucun code ADR ajouté** (voir §6).
5. **`sprint_delete` volontairement strict** (pas de `force`) : le détachement des tâches/recettes
   reste explicite (`task_sprint_unlink` / `recette_sprint_unlink`).
6. `doc_delete` (ADR) ne nettoie pas les signaux de cardinalité ADR — comportement **préexistant**,
   hors périmètre (seul `sprint` peut porter un signal `open` parmi les entités supprimées).

---

## 8. État des checkouts principaux (fin de traitement)

| Checkout principal | Branche | Working tree |
|--------------------|---------|--------------|
| `/root/.config/opencode/mcp/task-orchestrator` | `feature/migration-postgresql` | suivi propre (seuls `plans/`+`reports/` non versionnés préexistants) |
| `/root/orchestrator-panel` | `feature/migration-postgresql` | suivi propre (le worktree est retiré en fin de traitement) |

Aucun des deux n'est sur la branche de travail. PM2 : `orchestrator-panel` **non redémarré**.

---

## 9. Prochaines étapes / recommandations

1. **Orchestrateur** : merge/push des branches `build-notify/T-20260922-060057-febv`
   (repo1 `bf40c830`, repo2 `68b16bd3`) vers `feature/migration-postgresql`, puis déploiement CI/CD
   (le déploiement ne se fait pas depuis cette sous-tâche).
2. Après déploiement, **recette humaine** : vérifier depuis l'UI les 3 boutons Supprimer, la 2ᵉ
   confirmation de cascade ADR, le masquage du bouton pour le sprint par défaut et les messages de
   refus explicites.
3. Aucune action de schéma requise (aucune DDL).
