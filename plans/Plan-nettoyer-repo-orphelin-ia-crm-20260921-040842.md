# Plan — Retirer le repo orphelin `opencode-agents` (nom « ia-crm ») du projet `ecosystem`

- **Plan ID** : `Plan-nettoyer-repo-orphelin-ia-crm-20260921-040842`
- **Tâche** : `T-20260920-162757-sxi4` (improvement de la recette `RECT-mu9yzd23-8l7t`)
- **Projet** : `ecosystem`
- **Repo** : `opencode-mcp-task-orchestrator` → `/root/.config/opencode/mcp/task-orchestrator`
- **Branche** : `feature/migration-postgresql`
- **Scope déclaré** : `index.mjs` — **AUCUNE modification de code n'est nécessaire** (voir §4) : l'action est une **opération registre** (données) via les tools MCP.
- **Date** : 2026-09-21 04:08
- **Type** : improvement (nettoyage de données registre) — E2E : **NA** (aucun comportement utilisateur observable ; `e2e_list(project='ecosystem')` = 0 test)

---

## 1. Objectif

Le repo `opencode-agents` (nom « ia-crm », `workspace='ia-crm'`, `repoDir=/var/lib/docker/volumes/coder-6c7acd90-5eb9-40e2-89b5-854577664712-home/_data/ia-crm`) est rattaché au projet `ecosystem` alors que **son workspace Coder `ia-crm` a été supprimé** (confirmé par Rino). Objectif : **retirer ce repo orphelin du projet `ecosystem`** et neutraliser le pointeur obsolète, de sorte que **plus aucun repo du projet `ecosystem` ne pointe vers un workspace inexistant**.

Critère mesurable : `repo_list(projectId='ecosystem')` renvoie **3** repos (`opencode-mcp-task-orchestrator`, `opencode-observability`, `opencode-scripts`) — aucun ne portant de `workspace` vers un workspace Coder inexistant.

## 2. Contexte & raison d'être

Le workspace Coder `ia-crm` a été supprimé ; seuls subsistent `ia-crm-api` et `ia-crm-frontend` (vérifié par `workspace_list` : 7 workspaces, **aucun** `ia-crm`). Le registre conserve néanmoins :

- la liaison `project_repos(project_id='ecosystem', repo_id='opencode-agents', role='outillage')` ;
- l'entité `repos[id='opencode-agents']` avec `workspace='ia-crm'` (inexistant) ;
- 9 associations `task_repos` (auto-affectées par la règle « défaut = tous les repos du projet », `db.mjs` l.634-655).

Le projet `ecosystem` doit refléter la réalité. Comme toute tâche créée sans `repoIds` reçoit **par défaut tous les repos du projet** (`setTaskRepos`, `db.mjs` l.637-647), laisser `opencode-agents` rattaché **pollue aussi toutes les tâches futures** du projet.

### Inventaire d'impact (Phase 1 — preuve)

Références à `opencode-agents` dans le registre :

| Nature | Cible | Détail | Impact d'un retrait |
|---|---|---|---|
| `project_repos` | `ecosystem` ↔ `opencode-agents` | rôle `outillage` | **retirée** par A002 |
| `repos` (entité) | `id='opencode-agents'` | `workspace='ia-crm'` (inexistant) | **neutralisée** par A003 |
| `task_repos` | 9 tâches | voir tableau ci-dessous | **conservées** (unlink ne les touche pas) |
| `doc_repos` | — | `doc_list(repoId='opencode-agents')` = **0** | aucun |
| `e2e_test_repos` | — | `e2e_list(project='ecosystem')` = **0** | aucun |
| `worktrees` | — | `worktree_list(project='ecosystem')` = **0** | aucun |

**Tâches portant `opencode-agents` dans leurs `repos` (9)** :

| TaskId | Statut | Repos de la tâche |
|---|---|---|
| `T-20260913-134907-apsr` | done | 4 repos projet (dont `opencode-agents`) |
| `T-20260920-162753-hpcj` | done | 4 repos projet |
| `T-20260920-162754-b4cb` | done | 4 repos projet |
| `T-20260920-162755-3qxj` | done | 4 repos projet |
| `T-20260920-162756-m30s` | done | 4 repos projet |
| `T-20260920-162757-sxi4` | planning (courante) | 4 repos projet |
| `T-20260920-162758-8c12` | queued | 4 repos projet |
| `T-20260920-162800-aov1` | queued | 4 repos projet |
| `T-20260920-162801-jxtr` | queued | 4 repos projet |

Tâches du projet `ecosystem` **ne** portant **pas** `opencode-agents` (repos explicites) : `T-20260906-124956-8hd1` (`opencode-scripts`), `T-20260906-125011-9f9p` (`opencode-observability`), `T-20260920-172734-370n` (`opencode-mcp-task-orchestrator`).

**Aucun commit/plan de ces tâches n'a été produit sur `opencode-agents`** : tous les livrables ont été faits sur `opencode-mcp-task-orchestrator` / `opencode-observability` / `opencode-scripts` → l'association à `opencode-agents` est purement automatique et sans substance.

### Décision (justifiée)

| Option | Verdict | Raison |
|---|---|---|
| **`project_repo_unlink`** (A002) | **RETENUE** | Répond exactement au critère d'acceptation (« retiré du projet »), **réversible** (`project_repo_link`), **zéro perte de données**. |
| `repo_delete` | **REJETÉE** | Irréversible ; `task_repos.repo_id` et `doc_repos.repo_id` ont `ON DELETE CASCADE` (`schema.sql` l.110, l.155) → supprimerait les 9 associations `task_repos` (mutation de l'historique). Contredit la consigne « en cas de doute, ne pas supprimer ». |
| Marquage inactif via `repos.meta` (JSONB) | **IMPOSSIBLE sans code** | La colonne `meta JSONB` existe (`schema.sql` l.92) et est **lue** (`rowToRepo`, `db.mjs` l.1322), mais **aucun tool MCP ne l'écrit** (`repo_register` n'expose pas `meta`, `index.mjs` l.295-310) et **aucun code ne la filtre**. Un statut `inactive` n'aurait donc aucun effet → écarté (hors périmètre, pas de modification de code). |
| Marquage inactif via `name`/`description` + `workspace=NULL` (A003) | **RETENUE (complément)** | Seule forme de « marquage inactif » réalisable avec les tools actuels ; **réversible** ; rend le registre véridique sans rien supprimer. |

## 3. Tableau de synthèse des actions

| ID | Action | Élément ciblé | Support | Raison | Livrable attendu |
|----|--------|---------------|---------|--------|------------------|
| **A001** | vérifier (lecture seule) | références à `opencode-agents` (`project_repos`, `task_repos`, `doc_repos`, `e2e_test_repos`, `worktrees`) + inexistence du workspace Coder `ia-crm` | tools MCP : `repo_get`, `repo_list`, `doc_list(repoId)`, `e2e_list(project)`, `worktree_list(project)`, `task_get` ×9 | confirmer l'inventaire §2 **avant** toute mutation (garde-fou recette item 124) | inventaire d'impact confirmé : 1 `project_repos`, 1 entité `repos`, 9 `task_repos`, 0 doc/e2e/worktree |
| **A002** | retirer | ligne `project_repos(project_id='ecosystem', repo_id='opencode-agents')` | tool MCP `project_repo_unlink` | le repo n'appartient plus au projet (workspace supprimé) ; action réversible | `repo_list(projectId='ecosystem')` ne contient plus `opencode-agents` |
| **A003** | marquer inactif / neutraliser | colonnes `repos.workspace`, `repos.name`, `repos.description` de `repos[id='opencode-agents']` | tool MCP `repo_register` (upsert ; `workspace` omis → `NULL`) | supprimer le pointeur vers le workspace inexistant tout en **conservant l'entité** pour la traçabilité des 9 `task_repos` | `repos['opencode-agents'].workspace = NULL` + libellé explicite « inactif — workspace supprimé » |
| **A004** | vérifier | état final `repos` / `project_repos` / `project_list` | tools MCP : `repo_list(projectId='ecosystem')`, `repo_get('opencode-agents')`, `project_list` | prouver le critère d'acceptation et l'absence de régression | rapport de contrôle : 3 repos projet, aucun `workspace` non nul pointant vers un workspace inexistant, entité conservée et marquée |

**Formulations exactes des appels (A002 / A003)** :

```
A002 → project_repo_unlink({ projectId: "ecosystem", repoId: "opencode-agents" })

A003 → repo_register({
         id: "opencode-agents",
         name: "ia-crm [inactif — workspace supprimé]",
         description: "Repo orphelin — workspace Coder « ia-crm » supprimé (2026-09-21). Retiré du projet ecosystem ; conservé pour la traçabilité des tâches historiques (task_repos).",
         repoDir: "/var/lib/docker/volumes/coder-6c7acd90-5eb9-40e2-89b5-854577664712-home/_data/ia-crm",
         organizationId: "onirtech"
         // workspace volontairement OMIS → remis à NULL (registerRepo, db.mjs l.1341)
       })
```

## 4. Ressources concernées (registre — **aucun fichier de code**)

| Ressource | Type d'opération |
|---|---|
| `project_repos` (registre) | **retrait** d'une liaison (A002) |
| `repos` (registre) | **modification** d'une entité : `workspace` → `NULL`, `name` + `description` marqués inactifs (A003) |
| `task_repos` (registre) | **aucune modification** — associations historiques conservées (A002 ne les touche pas) |
| `index.mjs` (scope déclaré) | **aucune modification** — les tools `project_repo_unlink` (l.511-518) et `repo_register` (l.293-317) existent déjà et couvrent le besoin |
| `db.mjs`, `schema.sql` | **aucune modification** — aucun besoin de colonne/tool nouveau (cf. décision §2) |

## 5. Livrables attendus

1. `project_repos` ne contient plus la paire `('ecosystem','opencode-agents')`.
2. `repo_list(projectId='ecosystem')` retourne exactement 3 repos, aucun avec un `workspace` pointant vers un workspace Coder inexistant.
3. `project_list` → `ecosystem.repos = ["opencode-mcp-task-orchestrator","opencode-observability","opencode-scripts"]`.
4. L'entité `repos['opencode-agents']` est **conservée** (traçabilité) avec `workspace = NULL` et un libellé/description explicites d'inactivité.
5. Les 9 associations `task_repos` sont **intactes** (aucune perte d'historique).
6. Rapport de contrôle A004 attestant les points 1-5.

## 6. Ordre & dépendances

```
A001 (inventaire read-only)
      │
      ▼
A002 (project_repo_unlink)
      │
      ▼
A003 (repo_register — neutralisation)
      │
      ▼
A004 (contrôle final)
```

- **A001 → A002** : l'inventaire conditionne le retrait (garde-fou recette item 124 : « AVANT tout retrait, vérifier qu'aucune tâche/historique ne référence le repo »). Si A001 révélait une référence **forte** non prévue (doc attaché, test E2E, worktree), **stopper** et remonter en incident (voir §9).
- **A002 → A003** : A003 s'applique à l'entité une fois celle-ci détachée du projet (évite toute fenêtre où le projet pointerait une entité en cours de modification).
- **A003 → A004** : la vérification porte sur l'état final.
- Aucune étape ne lit/modifie un élément créé par une étape ultérieure.

## 7. Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|----------|----------|-----------|
| Le repo orphelin `opencode-agents` est **retiré du projet `ecosystem`** | A002 | ✅ |
| … **ou marqué inactif** (forme réalisable sans code) | A003 | ✅ |
| … **ou supprimé** (option écartée, cf. §2) | — (rejet justifié) | ✅ (décision tracée) |
| Plus aucun repo du projet `ecosystem` ne pointe vers un workspace supprimé | A002, A003, A004 | ✅ |
| Le registre reflète la réalité (workspace inexistant non référencé) | A003, A004 | ✅ |
| Vérification préalable : aucune tâche/historique ne référence le repo de façon substantielle | A001 | ✅ |
| Aucune perte d'historique (les tâches et leurs associations restent) | A001, A002 (unlink only) | ✅ |
| Aucune modification de code nécessaire | §4 (index.mjs/db.mjs/schema.sql inchangés) | ✅ |

## 8. Vérification de cohérence

**Phase 6 — contradictions intra-plan** : aucune.

- A002 **retire** une liaison (`project_repos`) ; A003 **modifie** une entité distincte (`repos`) → éléments différents, aucune contradiction.
- **Aucune étape `supprimer`** n'est retenue (le `repo_delete` est explicitement écarté §2) → aucun conflit `supprimer` + autre action.
- A003 ne `renomme` pas un élément créé par une étape antérieure : l'entité `repos['opencode-agents']` **préexiste** (créée 2026-09-06).
- A004 est en fin de chaîne → ne contredit aucune étape.
- A002 et A003 n'agissent pas sur `task_repos` → aucune contradiction avec l'exigence de conservation d'historique.

**Phase 7 — Plan Validator** : **VALID**
- Aucune contradiction (Phase 6) ;
- Couverture 100 % des exigences de l'objectif (Phase 5) ;
- Toutes les étapes sont atomiques : **un élément du registre × une action × un livrable**.

## 9. Risques & notes

- **Ne pas utiliser `repo_delete`** : `task_repos` (`schema.sql` l.110) et `doc_repos` (l.155) sont en `ON DELETE CASCADE` → la suppression détruirait les 9 associations `task_repos` (historique des tâches). Le retrait (`unlink`) suffit et est réversible.
- **`meta` JSONB non exploitable** : aucun tool MCP n'écrit `repos.meta` (`index.mjs` l.295-310) et aucun code ne le filtre → un statut `inactive` en `meta` serait inerte. Un vrai « statut de repo » nécessiterait une évolution de code (nouveau tool `repo_set_status` + lecture/affichage), **hors périmètre** de cette tâche.
- **`repo_register` est un upsert « plein »** : les champs non fournis sont remis à `NULL` (`db.mjs` l.1334-1340). Pour `opencode-agents`, seuls `branches`/`main_branch`/`e2e_*` sont déjà `NULL` → sans effet ; **`repoDir` doit être re-fourni** (sinon `git_path` serait perdu) — c'est le cas dans la commande A003.
- **Aucune modification de code** : le scope déclaré (`index.mjs`) n'est **pas** nécessaire ; le plan est un **plan d'opérations registre**. Le validateur du scope (batch) n'en est pas affecté (les tools appelés existent déjà).
- **Bénéfice collatéral** : après A002, les futures tâches `ecosystem` créées sans `repoIds` n'hériteront plus du repo orphelin (`setTaskRepos` défaut = repos du projet, `db.mjs` l.637-647).
- **Garde-fou A001** : si une référence forte inattendue est découverte (doc attaché, test E2E, worktree), **ne pas exécuter A002/A003** et publier un incident (`plan-manager incident_create`) + `task_event BLOCKED`.
- **E2E : NA** — opération de données registre sans parcours utilisateur observable ; `e2e_list(project='ecosystem')` = 0 test → aucun scénario à créer/modifier/obsoléter, aucun `e2e_test_link`.
