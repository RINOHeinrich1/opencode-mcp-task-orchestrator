# Rapport — Recette : sélectionner et référencer en contexte les Fonctionnalités et Règles métier

- **Tâche** : `T-20260922-070103-ncs1` (exécution `E-T-20260922-070103-ncs1-c1g8ft`)
- **Plan** : `Plan-recette-features-rules-contexte-20260922-070249` — **23/23 étapes done (100 %)**
- **Projet** : `ecosystem`
- **Agent** : `build-notify`
- **Date** : 2026-09-22 07:17 UTC

## 1. Résumé

**Demandé** : à la création d'une recette, pouvoir sélectionner aussi des **Fonctionnalités** (`US-xxx`) et des **Règles métier** (`RM-xxxx`) en plus des ADR, les rattacher à la recette (table `recette_regles` + `ruleIds`) et injecter leurs blocs de contexte (« Fonctionnalités de référence », « Règles métier de référence ») dans le prompt de l'`agent-recette`.

**Fait** :
- **MCP** : table `recette_regles` (DDL idempotente dans `migrate()` **et** miroir `schema.sql`), `SCHEMA_VERSION` bumpé ; `linkRecetteRule`/`unlinkRecetteRule` ; `startRecette(ruleIds)` non bloquant ; `getRecetteById` expose `regles` ; `buildFeatureContext`/`buildRuleContext` + renderers (lecture **bulk** `WHERE id = ANY($1::text[])`, 0 N+1, `context=""` si vide) ; tools `recette_rule_link`/`recette_rule_unlink` + `feature_context`/`rule_context` ; `recette_start.ruleIds` ; `deleteRule` détache `recette_regles`.
- **Panneau** : `createRecette` transmet `featureIds`+`ruleIds` ; wrappers `featureContext`/`ruleContext` ; `launchRecetteSession` dérive les blocs des **liens persistés** de la recette ; `buildRecettePrompt` insère les blocs **après** le bloc ADR, uniquement si non vides ; routes `POST /api/recettes` et `POST /api/recettes/:id/session` ; **2 sélecteurs multi-lignes** (Fonctionnalités + Règles) via un helper générique `frSelectorHtml` réutilisant les classes CSS `.adr-pick*` (0 CSS ajouté) : recherche + filtre rôle/Global, **tout coché par défaut**, **0 sélection possible**.

**Non-régression** : flux ADR intact (sélection, `adrContext`, vigilances, ordre des blocs) ; création de recette avec **0 sélection** OK ; `node --check` OK.

## 2. Isolation

- Projet `ecosystem` **absent de tout workspace Coder** → composants d'**infrastructure d'orchestration** (MCP registre + panneau de supervision), travail hôte assumé et documenté.
- `session-guard acquire` → `mode: in-place` sur les 2 repos (aucune session parallèle). **Travail en worktree imposé par la mission** (le panneau live sert les statiques du working tree) :
  - **MCP** : worktree `/root/.config/opencode/mcp/task-orchestrator-wt-T-20260922-070103-ncs1-mcp`, branche `build-notify/T-20260922-070103-ncs1-mcp`.
  - **Panneau** : worktree `/root/orchestrator-panel/.wt-T-20260922-070103-ncs1-panel`, branche `build-notify/T-20260922-070103-ncs1-panel`.
    - *Note* : le worktree initial `/root/orchestrator-panel-wt-…` (hors périmètre de permission `external_directory`) a été **relocalisé dans** `/root/orchestrator-panel/` et exclu via `.git/info/exclude`.
- `node_modules` **symlinkés** depuis les checkouts principaux dans chaque worktree (gitignoré, non suivi).
- **PM2 non redémarré.** Aucune écriture sur les checkouts principaux.
- **Fin de traitement** : les 2 worktrees physiques sont **retirés** ; les **branches dédiées sont CONSERVÉES** (nécessaires au merge/push de l'étape d'orchestration ultérieure) ; les verrous session-guard sont **libérés** (`release`, pas `remove`, pour ne pas supprimer les branches).

## 3. Branches et commits

| Repo | Branche de travail | SHA | Message |
|---|---|---|---|
| `opencode-mcp-task-orchestrator` | `build-notify/T-20260922-070103-ncs1-mcp` | `f707936` | feat(mcp): recette_regles + ruleIds + blocs de contexte Fonctionnalités/Règles (A001-A013) |
| `opencode-observability` | `build-notify/T-20260922-070103-ncs1-panel` | `333da29` | feat(panneau): sélecteurs Fonctionnalités/Règles + contexte agent-recette (featureIds/ruleIds) (B001-B010) |

Bases : MCP `9d95808`, panneau `86535c4` (toutes deux sur `feature/migration-postgresql`). **Aucun push** (merge/push = étape d'orchestration ultérieure).

Trace des commits enregistrée via `plan_commit_add` (avec diffs) pour les 2 commits.

## 4. Traitements effectués

### MCP (`A001`–`A013`)
- `A001` `schema.sql` : `CREATE TABLE recette_regles` + `idx_recette_regles_regle` (miroir `recette_fonctionnalites`).
- `A002` `SCHEMA_VERSION` → `"2026-09-22-recette-regles-contexte"`.
- `A003` `migrate()` : même DDL idempotente.
- `A004` `linkRecetteRule`/`unlinkRecetteRule` (garde `getRecetteById` + `getRule`).
- `A005` `startRecette({ …, ruleIds })` + boucle `try { linkRecetteRule } catch {}` (non bloquant).
- `A006` `getRecetteById` : `ruleRows` dans le `Promise.all`, champ `regles: rowToRegle(...)`.
- `A007` `renderFeatureContextBlock`/`renderRuleContextBlock` + `buildFeatureContext`/`buildRuleContext` (patron `buildAdrContext`, bulk `ANY`, `context=""` si vide).
- `A008` imports `index.mjs` ; `A009` tools `recette_rule_link`/`recette_rule_unlink` ; `A010` `recette_start.ruleIds` ; `A011` description `recette_get` (mentionne `regles`) ; `A012` tools `feature_context`/`rule_context`.
- `A013` `deleteRule` : `DELETE FROM recette_regles WHERE regle_id = $1`.

### Panneau (`B001`–`B010`)
- `B001` `createRecette` transmet `featureIds`+`ruleIds`.
- `B002` wrappers `featureContext`/`ruleContext` (court-circuit local si sélection vide ⇒ 0 appel).
- `B003` `launchRecetteSession` : blocs dérivés de `rec.fonctionnalites`/`rec.regles` (liens persistés du `recette_get` déjà effectué) ⇒ 1 appel MCP de contexte, 0 N+1 ; surcharge explicite `featureIds`/`ruleIds` possible.
- `B004` `buildRecettePrompt({ …, featureContext, ruleContext })` insère les blocs après `adrBlock`, si non vides.
- `B005`/`B006` routes `POST /api/recettes` et `POST /api/recettes/:id/session`.
- `B007` 2 fieldsets + `#rm-feature-pick`/`#rm-rule-pick`.
- `B008` `frSelectorHtml`/`selectedFrIds`/`bindFrSelector` (classes `.adr-pick*`, tout coché, 0 sélection possible).
- `B009` `loadFeaturesRules()` : `GET /api/features` + `GET /api/rules` en **parallèle** (0 N+1), rôles = union `features[].role` + `rules[].roles` ; branché sur `projectSel.change`.
- `B010` submit envoie `featureIds` + `ruleIds`.

## 5. Fichiers modifiés / créés

| Fichier | Repo | Δ |
|---|---|---|
| `schema.sql` | MCP | +9 |
| `db.mjs` | MCP | +119 / −7 |
| `index.mjs` | MCP | +57 / −4 |
| `pilot.mjs` | panneau | +43 / −3 |
| `session-bridge.mjs` | panneau | +12 / −1 |
| `server.mjs` | panneau | +2 / −2 |
| `public/app.js` | panneau | +140 |

Aucune suppression de fichier.

## 6. Vérifications

| Vérification | Résultat |
|---|---|
| `node --check` (db.mjs, index.mjs, pilot.mjs, server.mjs, session-bridge.mjs, public/app.js) | **OK** |
| Exports `db.mjs` (`linkRecetteRule`, `unlinkRecetteRule`, `buildFeatureContext`, `buildRuleContext`) | **OK** |
| **Spawn MCP réel** (worktree, JSON-RPC stdio) | **PASS** |
| `buildRecettePrompt` : ordre ADR → Fonctionnalités → Règles ; blocs absents si vides | **OK** |
| **Panneau instance de TEST `PORT=4010`** (MCP override vers worktree) | **PASS** — `GET /app.js` sert les helpers (`frSelectorHtml`, `rm-feature-pick`, `rm-rule-pick`, `loadFeaturesRules`, `featureIds/ruleIds`) ; `/api/features` 443, `/api/rules` 111 (myxmax) |
| **Preuve myxmax** | **PASS** (détail ci-dessous) |
| Données de test nettoyées | **OK** (0 recette `TEST-%` restante) |

### Preuve myxmax
- `recette_start` **sans `ruleIds`** (non-régression) → `RECT-mucc27ub-zmqa`, `regles: 0`.
- `recette_start` **avec `featureIds=[FEAT-mub9y5eh-rlxn]` + `ruleIds=[RMET-mub9ynm0-mb8c]`** → `RECT-mucc27y1-3dsg`, `fonctionnalites: 1`, `regles: 1` ; `recette_get` → `fonctionnalites: 1`, `regles: 1` (ref `RM-001`).
- `feature_context` non vide (142 car., `## Fonctionnalités de référence`, `US-001 — Partenaire Affelyos`) / vide → `""`.
- `rule_context` non vide (297 car., `## Règles métier de référence`, `RM-001`) / vide → `""`.
- `recette_rule_link` → `linked:true` ; `recette_rule_unlink` → `unlinked:true`.
- **HTTP panneau** `POST /api/recettes` (myxmax, `featureIds`+`ruleIds`) → `RECT-mucc8mca-4izv`, `fonctionnalites:[US-001]`, `regles:[RM-001]`.
- **Prompt reconstitué à l'identique de `launchRecetteSession`** (wrappers `pilot.featureContext`/`ruleContext` sur les liens persistés + `buildRecettePrompt`) → `prompt_has_feature_block: true`, `prompt_has_rule_block: true`, `order_adr_before_feature_before_rule: true`.
- `POST /api/recettes` avec `featureIds:[]`, `ruleIds:[]`, `adrIds:[]` (0 sélection) → **OK** (`RECT-mucc945w-28g8`).

**Nettoyage** : 4 recettes de test supprimées (`recette_regles:2`, `recette_fonctionnalites:2`, `cardinality_signals:4`, `recettes:4`), token de session panneau de test supprimé, instance `PORT=4010` arrêtée.

## 7. Avancement des 23 étapes

`A001`–`A013` : **done** · `B001`–`B010` : **done** → **23/23 (100 %)**.

## 8. Avertissements / erreurs

- Worktree panneau initialement hors périmètre de permission → relocalisé (voir §2).
- `session-guard` a renvoyé `in-place` ; le travail en worktree a été **imposé manuellement** conformément à la mission (le panneau live sert les statiques du working tree).
- `nohup`/background tué par le timeout du shell → relance via `setsid` (instance de test uniquement).

## 9. Prochaines étapes / recommandations

1. **Merge/push** des 2 branches (orchestration ultérieure) — synchroniser avec `feature/migration-postgresql` avant.
2. **Redémarrage du serveur MCP** (hors de ce traitement) pour exposer `recette_rule_link`, `recette_rule_unlink`, `feature_context`, `rule_context` au panneau live.
3. Rechargement du panneau live (statiques `public/app.js`).
4. Optionnel : charger les sélecteurs Fonctionnalités/Règles **à l'ouverture** de la modale (aujourd'hui sur `change` du projet, comme le sélecteur ADR existant).

## 10. État des checkouts principaux

- `/root/.config/opencode/mcp/task-orchestrator` → `feature/migration-postgresql`, working tree **propre** (hors rapports/plans non suivis, artefacts d'orchestration attendus).
- `/root/orchestrator-panel` → `feature/migration-postgresql`, working tree **propre**.
- **Aucun redémarrage PM2.**
