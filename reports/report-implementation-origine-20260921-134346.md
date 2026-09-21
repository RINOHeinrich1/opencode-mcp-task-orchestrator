# Rapport de fin de sous-tâche — État d'implémentation + origine (« écosystème » vs « hors écosystème ») des Fonctionnalités / Règles métier

- **Tâche** : `T-20260921-133134-yz2i` (exécution `E-T-20260921-133134-yz2i-lzlkih`)
- **Plan (sous-tâche)** : `Plan-implementation-origine-20260921-133338` — **42/42 étapes done (100 %)**
- **Projet** : `ecosystem`
- **Agent** : `build-notify`
- **Date** : 2026-09-21 13:43:46
- **ADR de référence** : `adr_list({ projectId: 'ecosystem' })` → **0 ADR active** sur ce périmètre (le plan prolonge la sémantique actée en T3 ; aucune ADR Accepté contredite).

---

## 1. Résumé

Implémentation complète des 42 étapes : **état d'implémentation + origine** pour les **Fonctionnalités ET les Règles métier**, de bout en bout (modèle → registre → rapport de sprint → MCP → panneau → prompts d'agents), avec **rétrocompatibilité** et **émergence préservée** comme axe distinct.

1. **Modèle** : 5 colonnes `implemented` / `implemented_origin` / `implemented_at` / `implemented_by` / `implemented_note` sur `fonctionnalites` et `regles_metier`, en `schema.sql` (DDL + `ALTER … IF NOT EXISTS`) **et** dans `migrate()` (idempotent).
2. **Registre** : helper **unique** `applyImplementationQualification` (validation stricte de l'origine, reset, idempotent) branché sur `updateFeature`/`updateRule` ; wrappers exportés `markFeatureImplemented`/`markRuleImplemented`.
3. **Rapport `buildSprintReport`** : « implémentée » = `implemented=1` **OU** `done_tasks>=1` ; ventilation « N implémentée(s) — dont E dans l'écosystème, H hors écosystème » ; **section « Règles métier implémentées »** ; `done_tasks` des règles **dérivé par transitivité** (`task_fonctionnalites` ⨝ `fonctionnalite_regles`, faute de table `task_regles`).
4. **MCP** : `feature_update`/`rule_update` étendus + tools `feature_mark_implemented`/`rule_mark_implemented` ; lecture exposée dans `feature_get`/`feature_list`/`rule_get`/`rule_list` ; descriptions alignées.
5. **Panneau back** : pass-through `pilot.updateFeature`/`updateRule` + routes `PUT /api/features/:id` / `PUT /api/rules/:id` (routes existantes réutilisées, aucune nouvelle route).
6. **Panneau UI** : badge d'état, action « Qualifier » (dans / hors écosystème + motif), filtre d'implémentation, formulaires étendus et détails enrichis (traçabilité), dans les **2 sous-onglets**.
7. **Agents** : `agent-migration.md` / `agent-sprint.md` — **proposition** `hors_ecosystem` des éléments pré-existants avec **validation utilisateur obligatoire**, **sans** marquage émergent.
8. **Vérifications** : `node --check` OK ; **spawn MCP réel 38/38 PASS** sur base jetable ; **preuve live** sur `SPRINT-mub8iyew-j6j8`.

## 2. Isolation

| Repo | Espace | Worktree | Branche de travail |
|------|--------|----------|--------------------|
| `opencode-mcp-task-orchestrator` | **HÔTE** (outillage d'infrastructure — absent de `workspace_list`) | `/root/.config/opencode/mcp/task-orchestrator-wt-impl-origine` | `build-notify/impl-origine` |
| `opencode-observability` (panneau) | **HÔTE** (outillage d'infrastructure) | `/root/orchestrator-panel-wt-impl-origine` | `build-notify/impl-origine` |

- `session-guard acquire` → **code 0 / mode in-place** sur les 2 repos (aucune session parallèle détectée). Le plan interdisant tout commit direct sur `feature/migration-postgresql`, le travail a été mené dans des **worktrees + branches dédiées** (`session-guard worktree`).
- `node_modules` **symlinké** dans le worktree du registre (gitignoré, non committé) pour le spawn MCP réel.
- **Checkout principal du panneau** : `git -C /root/orchestrator-panel status -sb` → **`## feature/migration-postgresql…`, working tree PROPRE** (jamais laissé sur une branche de travail) — exigence respectée.
- **Aucun push** (merge/push = étape d'orchestration ultérieure).

## 3. Branches et commits

| Repo | Branche | Commit | Base |
|------|---------|--------|------|
| `opencode-mcp-task-orchestrator` | `build-notify/impl-origine` | `e576bb75bfe66ff4a51d6f3635b47d30dbf2321e` | `59d243b743ba55b1fa1a917b6a898a68f1e09ac4` |
| `opencode-observability` | `build-notify/impl-origine` | `281acc969e0cfca32ca7e3906a32d25e50da3eba` | `80a5ab1df29bf57125c06aa2114467a79dec65d4` |

Trace **append-only** persistée (`plan_commits` : **2 commits**) via `addPlanCommit` (code identique au tool `plan_commit_add` — diffs exacts) :
`e576bb7` → `db.mjs` (+273/-32), `index.mjs` (+49/-11), `schema.sql` (+24/-0) ;
`281acc9` → `pilot.mjs` (+8/-0), `public/app.js` (+152/-17), `server.mjs` (+8/-0).
`plan_set_branch(Plan-implementation-origine-20260921-133338, "build-notify/impl-origine")` effectué.

## 4. Traitements effectués (42/42)

| Lot | Étapes | Statut | Détail |
|-----|--------|--------|--------|
| Modèle | A001-A004 | done | `schema.sql` : 5 colonnes dans `CREATE TABLE fonctionnalites`/`regles_metier` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (miroir idempotent) ; `migrate()` : 5 × 2 `ALTER … IF NOT EXISTS`. |
| Lecture | A005-A006 | done | `rowToFonctionnalite`/`rowToRegle` exposent `implemented`, `implementedOrigin`, `implementedAt`, `implementedBy`, `implementedNote`. |
| Écriture | A007-A011 | done | `applyImplementationQualification` (helper unique) ; `updateFeature`/`updateRule` branchés (anti double `updated_at`) ; `markFeatureImplemented`/`markRuleImplemented` exportés. |
| Rapport | A012-A017 | done | `feats`/`regles` : `implemented = explicite OU done_tasks>=1`, origine explicite ou dérivée `ecosystem` ; `sections.reglesImplementees` ; `stats` ventilées E/H (2 tables) ; markdown « N implémentée(s) — dont E…, H… » ; listes avec origine+note. |
| MCP | A018-A024 | done | `feature_update`/`rule_update` (+3 champs) ; `feature_mark_implemented`/`rule_mark_implemented` ; import ; descriptions `sprint_report` + `*_get`/`*_list`. |
| Panneau back | A025-A028 | done | `pilot.updateFeature`/`updateRule` pass-through ; routes `PUT` étendues. |
| Panneau UI | A029-A038 | done | badge d'état + bouton Qualifier (2 tables) ; filtre d'implémentation (état + logique, 2 sous-onglets) ; selects + wiring ; formulaires (select + motif + PUT/POST) ; détails (badge + `at`/`by`/`note`). |
| Agents | A039-A040 | done | Sections « Qualification d'implémentation des éléments hérités (hors écosystème) » (proposition + validation, jamais d'émergent) dans `agent-migration.md` et `agent-sprint.md` — **hors dépôt git** (cf. §6). |
| Vérif | A041-A042 | done | `node --check` + spawn MCP réel **38/38 PASS** ; preuve live sur `SPRINT-mub8iyew-j6j8`. |

## 5. Fichiers modifiés / créés

Dans les worktrees (commit `e576bb7` / `281acc9`, **purement additif sur le comportement existant**) :

- `/root/.config/opencode/mcp/task-orchestrator-wt-impl-origine/schema.sql` — A001/A002.
- `/root/.config/opencode/mcp/task-orchestrator-wt-impl-origine/db.mjs` — A003-A017.
- `/root/.config/opencode/mcp/task-orchestrator-wt-impl-origine/index.mjs` — A018-A024.
- `/root/orchestrator-panel-wt-impl-origine/pilot.mjs` — A025/A026.
- `/root/orchestrator-panel-wt-impl-origine/server.mjs` — A027/A028.
- `/root/orchestrator-panel-wt-impl-origine/public/app.js` — A029-A038.

**Hors dépôt git** (non versionnables, modifiés directement) :
- `/root/.config/opencode/agent/agent-migration.md` — A039.
- `/root/.config/opencode/agent/agent-sprint.md` — A040.

## 6. Vérifications (preuves)

### 6.1 `node --check` — OK
`db.mjs`, `index.mjs` (registre) ; `pilot.mjs`, `server.mjs`, `public/app.js` (panneau) → **tous OK**.

### 6.2 Spawn MCP réel (stdio JSON-RPC) sur base PostgreSQL JETABLE — **38/38 PASS**
MCP `index.mjs` du worktree lancé en stdio (`initialize` → `tools/list` → `tools/call`), base créée puis supprimée (aucune donnée réelle touchée) :

- **Tools** : `feature_mark_implemented`/`rule_mark_implemented` exposés ; `feature_update`/`rule_update` portent `implemented`/`implementedOrigin`/`implementedNote`.
- **Défaut rétrocompatible** : élément créé ⇒ `implemented=false`, `implementedOrigin=null`.
- **Qualification** : `mark_implemented hors_ecosystem` ⇒ `implemented=true` + origine + `implementedAt`/`implementedBy`/`implementedNote` ; `origin` manquant ⇒ **err**.
- **Reset / validation** : `implemented=false` ⇒ reset complet ; `implemented=true` sans origine ⇒ **err** ; origine invalide ⇒ **err**.
- **Lecture** : `feature_get`/`feature_list`/`rule_get`/`rule_list` exposent les 5 champs.
- **Rapport** : synthèse « 1 implémentée(s) — dont 0 dans l'écosystème, 1 hors écosystème » (fonctionnalités ET règles) ; section « Règles métier implémentées (1) » ; `stats.*.implementeesEcosystem/HorsEcosystem` ; `sections.reglesImplementees`.
- **Rétrocompat `done_tasks`** : une tâche `done` liée ⇒ fonctionnalité implémentée d'origine **`ecosystem` dérivée** (ventilation E mise à jour).
- **Non-régression T1-T9** : `project_list`, `sprint_list`, `adr_list`, `feature_register` (ref dupliquée ⇒ err), `feature_get` inconnue ⇒ err, `task_register`/`task_delete` → OK.
- **Idempotence schéma/migrate** : **2ᵉ process** sur la même base (rejeu `schema.sql` + `migrate()`) → OK.

### 6.3 Preuve live A042 — sprint myxmax `SPRINT-mub8iyew-j6j8`
Qualification **du minimum nécessaire** (1 fonctionnalité + 1 règle), écriture de données de preuve documentée :

| Élément | id | ref | origine | note |
|---------|----|-----|---------|------|
| Fonctionnalité | `FEAT-mub9y5eh-rlxn` | US-001 (« Partenaire, je peux m'inscrire. ») | `hors_ecosystem` | « Preuve A042 (T-20260921-133134-yz2i) : implémentation pré-existante hors écosystème (aucune tâche écosystème liée). » |
| Règle métier | `RMET-mub9ynm0-mb8c` | RM-001 | `hors_ecosystem` | idem |

Avant : `fonctionnalites {total:45, implementees:0}` / `regles {total:10, implementees:0}`.
Après (rapport généré) :
- `| Fonctionnalités | 45 | 1 implémentée(s) — dont 0 dans l'écosystème, 1 hors écosystème ; 0 émergente(s) |`
- `| Règles métier | 10 | 1 implémentée(s) — dont 0 dans l'écosystème, 1 hors écosystème ; 0 émergente(s) |`
- Section `## Règles métier implémentées (1)` présente, ligne `**RM-001** — … — implémentée (hors écosystème) — …`.

La migration de schéma sur la base réelle (ajout idempotent des colonnes) a été appliquée par ce passage — prérequis du rapport.

### 6.4 E2E Playwright : **NA**
Aucune infra Playwright dans les 2 repos (outillage interne JS vanilla) ; `e2e_list({ project: 'ecosystem' })` → 0 test. Aucun `e2e_test_register`/`e2e_test_link` (conforme plan §10). Non-régression couverte par §6.2.

## 7. Avertissements / erreurs / écarts

1. **A039/A040 — fichiers hors dépôt git et hors scope (6 fichiers)** : `agent-migration.md` / `agent-sprint.md` vivent dans `/root/.config/opencode/agent/`. Option **(a)** de l'orchestrateur retenue : **modification directe** (aucune branche/commit possible). **Écart tracé** (`task_event`) ; ces 2 livrables ne figurent donc pas dans les commits.
2. **Badge du panneau = état EXPLICITE** : `listFeatures`/`listRules` exposent `implemented` (état explicite) mais **pas** le signal dérivé `done_tasks` (le plan ne l'exige qu'au rapport, A012/A013). Une fonctionnalité « implémentée » uniquement par ≥1 tâche `done` apparaît donc sans badge dans la liste, tandis que le **rapport** la compte implémentée (origine `ecosystem`). Filtre `Implémentées` = état explicite. C'est conforme au plan, mais constitue une nuance d'affichage à connaître.
3. **Formulaire à la création (POST)** : `feature_register`/`rule_register` n'acceptent pas la qualification. Si l'utilisateur choisit une origine à la création, un **PUT post-création** applique la qualification (mêmes routes). En édition, les champs sont envoyés directement.
4. **Re-qualification** : conformément à la décision §2.6, `implemented_at` est **re-stampé** à chaque qualification (y compris lors d'une édition qui renvoie `implemented=true`). Idempotent, mais l'horodatage reflète la dernière écriture.
5. **`done_tasks` des règles** = signal **dérivé** (aucune table `task_regles`) : une règle rattachée à une fonctionnalité `hors_ecosystem` n'est **pas** implémentée par ricochet (doit être qualifiée elle-même ou compter une tâche `done`) — conséquence assumée du plan §2.3.

## 8. Prochaines étapes / recommandations

1. **Merge/push** des 2 branches `build-notify/impl-origine` (étape d'orchestration ultérieure ; synchroniser au préalable sur `feature/migration-postgresql`).
2. **Redéploiement du panneau** (`opencode-observability`) pour que le MCP live et l'UI servent la nouvelle version ; le panneau **live** sert actuellement les statiques du working tree (`feature/migration-postgresql`) → il ne montre pas encore les badges/filtres.
3. **Poursuivre la qualification** des éléments hérités de myxmax via les sessions **agent-migration / agent-sprint** (proposition + validation utilisateur), ou depuis le panneau (bouton « Qualifier ») après redéploiement.
4. **Option future** (hors périmètre) : table N:N `task_regles` pour un lien tâche↔règle direct, et exposition du signal `done_tasks` dérivé dans `feature_list`/`rule_list` pour aligner badge et rapport.
