# Rapport — Prompts agents : liens Fonctionnalité / ADR (proposé → validé en recette)

- **Tâche** : `T-20260921-091737-79uj` (exécution `E-T-20260921-091737-79uj-9cx4t0`)
- **Sous-tâche (plan)** : `Plan-prompts-liens-adr-fonctionnalite-20260921-112946`
- **Projet** : `ecosystem`
- **Agent** : `build-notify`
- **Date** : 2026-09-21 11:36:34
- **Branche de travail** : `build-notify/f3c40cf39f`
- **Worktree** : `/root/.config/opencode/agent-wt-f3c40cf39f`
- **Commit** : `74ce471e3056b72ae81ed11dad59e56952b12fd4`
- **Push** : NON (conformément au cadrage)

---

## 1. Résumé

**Demandé** : mettre à jour les prompts de 3 agents opencode (`agent-recette`,
`build-notify`, `test-agent`) pour qu'ils **proposent** les liens Fonctionnalité /
ADR au rattachement des tâches, la **validation restant HUMAINE (en recette)** —
aucune auto-validation, aucune création systématique d'ADR (3 étapes B001–B003,
parallélisables).

**Fait** : les 3 sections ont été ajoutées (modifications **purement additives**,
117 insertions, 0 suppression). Tous les outils MCP cités ont été **vérifiés
contre le serveur réel** (`mcp/task-orchestrator/index.mjs`).

## 2. Isolation

- Le projet cible (`agent/`) est un **dépôt git** (`/root/.config/opencode/agent`,
  branche `feature/per-plan`) — il **n'est pas** dans un workspace Coder : c'est de
  l'**outillage d'infrastructure de l'écosystème** (prompts d'agents), traité sur
  l'hôte conformément à l'exception de la norme v1.0.
- `session-guard acquire` → **exit 2 (`parallel: true`)** : une autre session
  (`ses_f3c40d9efffeCAds0IqP1lN5kg`, sous-tâche `Plan-agent-session-sprint-...`)
  travaillait déjà sur ce dépôt.
- Travail effectué dans un **worktree dédié** : `/root/.config/opencode/agent-wt-f3c40cf39f`,
  branche `build-notify/f3c40cf39f`. Fichiers modifiés **disjoints** de la
  sous-tâche parallèle (qui touche `agent-sprint.md`, `session-bridge.mjs`,
  `pilot.mjs`, `server.mjs`, `app.js`, `db.mjs`, `index.mjs`) → **aucune collision**.

## 3. Branches et commits

| Élément | Valeur |
|---------|--------|
| Branche de travail | `build-notify/f3c40cf39f` |
| Base (SHA de référence) | `0cec533ab9765ebe5932613b84f3c74b7088dd87` |
| Commit | `74ce471` — `feat(agents v0.9.41): rattachement Fonctionnalité/ADR des tâches (proposé → validé en recette) — agent-recette, build-notify, test-agent (T-20260921-091737-79uj)` |

Commit enregistré dans la trace du plan via `plan_commit_add` (append-only) et
branche rattachée via `plan_set_branch`.

## 4. Traitements effectués

| Étape | Action | Résultat |
|-------|--------|----------|
| B001 | `agent-recette.md` — section « Rattachement des tâches : liens Fonctionnalité / ADR (proposé → validé) (v0.9.41) » insérée après « Gouvernance des ADR en recette » (l.262, 53 lignes) | ✅ done |
| B002 | `build-notify.md` — section « Liens Fonctionnalité / ADR à la création d'une tâche (proposé, non validé) (v0.9.41) » insérée après « ADR de référence » (l.81, 37 lignes) | ✅ done |
| B003 | `test-agent.md` — section « Rattachement Fonctionnalité du test / ADR (v0.9.41) » insérée après « Contexte du test (MCP) » (l.126, 27 lignes) | ✅ done |

**Avancement du plan** : 3/3 étapes `done` → **100 %**.

### Vérification de cohérence des outils MCP

Tous les outils cités existent réellement dans `mcp/task-orchestrator/index.mjs` :

- `task_feature_link(taskId, featureId)` / `task_feature_unlink`
- `task_adr_propose(taskId, adrId, reason?, by?)` → `status='propose'` (NON effectif)
- `task_adr_validate(taskId, adrId, by?)` → `status='valide'` (action HUMAINE, effectif)
- `task_adr_list(taskId, status?)`
- `feature_list(projectId, emergent?, search?, limit?)`, `rule_list(projectId, …)`
- `feature_gherkin_link(featureId, e2eTestId)` / `feature_gherkin_unlink`
- `feature_adr_link(featureId, adrId)`
- `recette_feature_link(recetteId, featureId)`, `recette_adr_link(recetteId, adrId)`
- `cardinality_report(projectId, view?)` — vues : `tache_sans_adr`,
  `tache_sans_fonctionnalite`, `tache_sans_sprint`, `recette_sans_adr`,
  `recette_sans_fonctionnalite`, `recette_sans_sprint`, `adr_sans_fonctionnalite`,
  `sprint_sans_fonctionnalite`, `sprint_sans_regle`, `emergents`
- `cardinality_signals_list(projectId?, entityType?, entityId?, status?, limit?)`
- `cardinality_signal_resolve(signalId, resolution, resolvedBy?)`
- `task_register` accepte bien `featureIds`, `sprintId`, `adrIds` (ADR en `propose`)
- `adr_report_missing`, `adr_report_conflict`, `adr_register`, `adr_search`

### Règle commune respectée (les 3 sections)

Proposer les liens ; **validation HUMAINE en recette** ; pas de création
systématique d'ADR ; pas d'auto-validation. Chaque section comporte une
« Règle d'or » explicite (`task_adr_validate` = action HUMAINE).

## 5. Fichiers modifiés

| Fichier | Type | Lignes ajoutées |
|---------|------|-----------------|
| `/root/.config/opencode/agent-wt-f3c40cf39f/agent-recette.md` | modification (additive) | +53 |
| `/root/.config/opencode/agent-wt-f3c40cf39f/build-notify.md` | modification (additive) | +37 |
| `/root/.config/opencode/agent-wt-f3c40cf39f/test-agent.md` | modification (additive) | +27 |

> Les fichiers sources du checkout principal (`/root/.config/opencode/agent/…`)
> sont **inchangés** — tout passe par le worktree (isolation).

## 6. Avertissements / erreurs

- **Aucune erreur.** Aucune incohérence détectée : les outils MCP référencés dans
  le plan **existent tous**.
- **Écart d'isolation (documenté)** : le projet `agent/` n'est pas dans un
  workspace Coder (outillage écosystème sur l'hôte). Conforme à l'exception
  « composant d'infrastructure » de la norme.
- **Non appliqué volontairement** : `session-guard remove` supprime **physiquement
  le worktree ET la branche** (`git branch -D`). Or la branche est le **livrable à
  merger** (le dépôt suit la convention « Merge branch 'build-notify/…' into
  feature/per-plan », cf. historique). J'ai donc **conservé** worktree + branche
  et seulement **libéré le verrou** pour ne pas détruire un travail non mergé.
  La sous-tâche parallèle a fait de même (`build-notify/session-sprint-agent`).

## 7. Prochaines étapes / recommandations

1. **Merger** `build-notify/f3c40cf39f` dans `feature/per-plan` (flux habituel de
   l'orchestrateur), puis nettoyer le worktree (`session-guard remove`).
2. **Validation HUMAINE** : ces prompts encadrent la proposition → validation en
   recette ; aucune ADR n'a été créée ni validée par l'agent.
3. **Tests E2E** : **E2E NA** — modification de prompts d'agents, aucun
   comportement utilisateur observable ; `ecosystem` n'a aucun spec Playwright.
