# Synthèse de planification — `T-20260921-133134-yz2i`

- **Tâche** : `T-20260921-133134-yz2i` — « Fonctionnalités/Règles métier — état d'implémentation avec origine « dans l'écosystème » vs « hors écosystème » (modèle, rapport de sprint, MCP, panneau) »
- **Exécution** : `E-T-20260921-133134-yz2i-lzlkih` (attempt 1)
- **Projet** : `ecosystem` — repos `opencode-mcp-task-orchestrator` + `opencode-observability`
- **Agent** : `atomic-plan` (planner) — `PLANNING_STARTED` publié, `PLAN_CREATED` publié
- **Date** : 2026-09-21 13:34:29

---

## 1. Objectifs identifiés

Un **objectif unique, borné** : *qualifier une Fonctionnalité et une Règle métier comme implémentée en distinguant l'origine (`ecosystem` vs `hors_ecosystem`), et restituer cette ventilation dans le modèle, le rapport de sprint, l'API MCP et le panneau, sans casser l'existant.*

Les 5 livrables de la mission (modèle / rapport / MCP / panneau / agents) sont **interdépendants** (le panneau consomme le MCP, qui consomme le modèle) → **un seul plan** avec section « Ordre & dépendances » (règle : objectifs dépendants = un plan unique). Aucune ambiguïté de segmentation → pas de question utilisateur nécessaire.

## 2. Plan produit

| Plan | Objectif | Étapes | Statut |
|---|---|---|---|
| `Plan-implementation-origine-20260921-133338` | Qualifier fonctionnalité/règle comme implémentée avec origine (ecosystem/hors_ecosystem) + ventilation rapport + MCP + panneau + agents | **A001 → A042** (42 étapes, 8 lots) | enregistré (Plan Manager) — suivi `todo` |

**Fichier** : `plans/Plan-implementation-origine-20260921-133338.md`
**Artefact** : `ART-mubae7y1-1ymb` (kind=`plan`, docType=`plan`) — pièce jointe du notifier.

### Structure du plan (lots)

| Lot | Étapes | Contenu |
|---|---|---|
| 1. Modèle | A001-A004 | 5 colonnes ×2 tables (`schema.sql` + `migrate()` idempotent) |
| 2. Lecture/écriture registre | A005-A011 | sérialisation camelCase, helper `applyImplementationQualification`, `updateFeature`/`updateRule`, `markFeatureImplemented`/`markRuleImplemented` |
| 3. Rapport | A012-A017 | `buildSprintReport` : implémentée = `implemented=1` OU `done_tasks>=1`, stats ventilées E/H, section « Règles métier implémentées », markdown |
| 4. MCP | A018-A024 | `feature_update`/`rule_update` + tools `feature_mark_implemented`/`rule_mark_implemented`, import, descriptions |
| 5. Panneau back | A025-A028 | `pilot.mjs` + `server.mjs` pass-through (PUT existants) |
| 6. Panneau UI | A029-A038 | badges, actions de qualification, filtres, formulaires, détails (2 sous-onglets) |
| 7. Agents | A039-A040 | `agent-migration.md` / `agent-sprint.md` : proposer `hors_ecosystem`, validation utilisateur, jamais émergent |
| 8. Vérifications | A041-A042 | `node --check` + spawn MCP réel (T1-T9) ; preuve sur `SPRINT-mub8iyew-j6j8` |

## 3. Ancrage dans le code (vérifié en Phase 1-2)

| Fait | Localisation vérifiée |
|---|---|
| `implemented = done_tasks >= 1` | `db.mjs` **l.1427** |
| Requête fonctionnalités (`done_tasks`) | `db.mjs` **l.1405-1428** |
| Requête règles (aucun `done_tasks`, émergence seule) | `db.mjs` **l.1447-1458** |
| `sections` / `stats` / markdown | `db.mjs` **l.1477-1495** / **l.1510,1512** / **l.1523-1527** |
| Tables sans champ d'implémentation | `schema.sql` **l.680-693** (`fonctionnalites`) / **l.697-709** (`regles_metier`) |
| `migrate()` (bloc T1) | `db.mjs` **l.44** (début), **l.511-520** (bloc T1) |
| Sérialisation | `rowToFonctionnalite` **l.1548-1563**, `rowToRegle` **l.1566-1580** |
| `updateFeature` / `updateRule` | `db.mjs` **l.1650-1691** / **l.1809-1849** |
| Familles MCP `feature_*`/`rule_*` | `index.mjs` **l.910-1028** (import **l.172-180**) |
| Tool `sprint_report` | `index.mjs` **l.670-682** |
| Panneau back | `pilot.mjs` **l.822-832 / l.863-872** ; `server.mjs` **l.2011-2021 / l.2051-2059** ; rapport **l.1895-1912** (non modifié) |
| Panneau UI | `app.js` tables **l.5246/5266**, filtres **l.5203/5226**, sous-panneaux **l.5288/5348**, modales **l.5026/5063/5098/5119** |

**Absence vérifiée** : aucune table `task_regles` (→ `done_tasks` d'une règle dérivé par transitivité via `fonctionnalite_regles` ⨝ `task_fonctionnalites`).

## 4. Choix de conception tranchés

1. **Modèle additif idempotent** : 5 colonnes `implemented`(0/1), `implemented_origin`, `implemented_at`, `implemented_by`, `implemented_note` sur les 2 tables ; `DEFAULT 0` ⇒ rétrocompatibilité stricte.
2. **Définition unique** : `implémentée = implemented=1 OU done_tasks>=1` ; origine = explicite si `implemented=1`, sinon `ecosystem` dérivé, sinon `null`.
3. **Règles : `done_tasks` dérivé par transitivité** (pas de lien tâche↔règle) ; une règle explicitement `hors_ecosystem` n'est **pas** propagée par ricochet depuis sa fonctionnalité.
4. **Émergence = axe distinct**, jamais touché par la qualification.
5. **MCP : « et/ou » → les deux** : `*_update` étendus **et** tools `*_mark_implemented` dédiés.
6. **Panneau : réutilisation des routes PUT existantes** (pas de nouvelle route) ; filtre **client** (cohérent avec `emergent`/`link`) ; rapport téléchargeable ventilé **sans modification** de `server.mjs` (le markdown vient du registre).
7. **Agents : proposition + validation utilisateur**, jamais d'écriture silencieuse, jamais de marquage émergent.

## 5. Vérifications de cohérence

- **Intra-plan (Phase 6-7)** : aucun verbe destructeur ; sous-blocs de `buildSprintReport` disjoints (A012→A017) ; couches distinctes pour `updateFeature`/`updateRule` (registre → MCP → serveur → UI) ; risque de double `updated_at` **résolu par conception** (helper A007 seul écrivain) ; aucune dépendance inversée. → **Valid**.
- **Globale (Phase 9)** : **un seul plan** → aucune contradiction inter-plans possible. Cohérence triviale. **Aucune incohérence à signaler.**
- **Couverture** : 14 exigences / 14 couvertes (table §7 du plan) → **100 %**.
- **ADR** : `adr_list(projectId='ecosystem')` → 0 ADR active ; aucune ADR Accepté contredite (l'ADR-001 référencée par le plan T3 n'est plus résolue dans le registre courant — signalé dans le plan).

## 6. Tests E2E Playwright

**E2E NA** — aucune infra Playwright dans les 2 repos (`playwright.config.*`/`*.spec.ts` : 0 résultat) et `e2e_list({ project: 'ecosystem' })` → 0 test. Outillage interne (registre + panneau d'admin), aucun parcours utilisateur produit. Pas de `e2e_test_register`/`e2e_test_link`. Non-régression couverte par A041 (`node --check` + spawn MCP réel).

## 7. Point à trancher par l'exécution

**A039/A040** ciblent `/root/.config/opencode/agent/agent-migration.md` et `agent-sprint.md` : **hors des 6 fichiers du scope réservé** et **hors dépôt git**. Options : (a) les modifier sans toucher aux branches des repos ; (b) si non modifiables, livrer le livrable 5 via les seuls tools MCP (`*_mark_implemented` + validation panneau) et le **signaler** (`task_event`). Risque tracé dans le plan (§9.1).

## 8. Traçabilité

- `task_event(T-20260921-133134-yz2i, PLANNING_STARTED, atomic-plan)`
- `participant_add(T-20260921-133134-yz2i, atomic-plan, planner)`
- `plan_register(rootPath=/root/.config/opencode/mcp/task-orchestrator, planFile=plans/Plan-implementation-origine-20260921-133338.md, taskId=T-20260921-133134-yz2i)` → `planId=Plan-implementation-origine-20260921-133338`
- `task_event(T-20260921-133134-yz2i, PLAN_CREATED, atomic-plan)`
- `artifact_add(taskId=T-20260921-133134-yz2i, kind=plan, docType=plan, path=…/Plan-implementation-origine-20260921-133338.md)` → `ART-mubae7y1-1ymb`
- Notifications : dérivées par le daemon `opencode-notifier` depuis le registre (aucun email envoyé par l'agent).
