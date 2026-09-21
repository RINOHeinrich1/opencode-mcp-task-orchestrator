# Synthèse de planification — `T-20260921-091731-d1af`

- **Tâche** : `T-20260921-091731-d1af` (exécution `E-T-20260921-091731-d1af-fz9l2l`)
- **Projet** : `ecosystem` — batch `BATCH-mub1809u-06ow` (tâche 3/9, mode `session`)
- **Repo** : `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (branche de déploiement `feature/migration-postgresql`)
- **Recette source** : `RECT-muaz100k-2iq0`
- **Agent** : `atomic-plan` (rôle `planner`)
- **Date** : 2026-09-21 10:05:27

## 1. Objectifs identifiés (Phase 0)

La demande est **un objectif unique et borné** : faire du SPRINT un objet de premier niveau avec son cycle de vie produit. Les sous-exigences (durée paramétrable, clôture auto, reprise, émergence, sprint par défaut, rapport) sont **interdépendantes** (elles portent toutes sur le même modèle `sprints` / la même garde d'émergence) → **un plan unique**, avec section « Ordre & dépendances ».

Aucune ambiguïté de segmentation : pas de question utilisateur nécessaire.

## 2. Plans générés

| PlanId | Objectif | Étapes | Fichier |
|---|---|---|---|
| `Plan-sprint-cycle-de-vie-rapport-20260921-100015` | SPRINT objet de 1er niveau : cycle de vie produit (durée paramétrable, clôture auto à l'échéance, reprise, sprint par défaut/anciens sprints, rapport) | **17** (A001→A017) | `plans/Plan-sprint-cycle-de-vie-rapport-20260921-100015.md` |

- Enregistré au Plan Manager : `plan_register(taskId=T-20260921-091731-d1af)` → `planId=Plan-sprint-cycle-de-vie-rapport-20260921-100015` (17 étapes à `todo`, fichiers par étape reconnus).
- Artefact rattaché : `artifact_add(kind=plan, docType=plan, contentId=T-20260921-091731-d1af)` → `ART-mub2xdjc-7lao`.
- Événements publiés : `PLANNING_STARTED`, `PLAN_CREATED` (par `atomic-plan`).

## 3. Ancrage sur le code réel (Phases 1-2)

Éléments localisés et vérifiés par lecture :

| Élément | Fichier:ligne | État |
|---|---|---|
| Table `sprints` (project, title, start_date, end_date, status, session_id) | `schema.sql:703-717`, `db.mjs:495-509` | livrée par T1 (commit `3ee7755`) |
| Liens N:N `sprint_fonctionnalites` / `sprint_regles` / `sprint_pieces` / `task_sprints` / `recette_sprints` | `schema.sql:765-812`, `db.mjs:551-592` | livrés par T1, **réutilisés tels quels** |
| Table `tasks` | `schema.sql:7-31` | cible A002 (émergence) |
| `createTask` | `db.mjs:647-712` | cible A010 |
| `rowToTask` | `db.mjs:791-819` | cible A016 |
| `detectOpenSprint` | `db.mjs:612-624` | cible A008 |
| `addPiece` (émergence inline `apres_init_sprint`/`apres_cloture`) | `db.mjs:4578-4628` (l.4596-4607) | cible A009 — comportement T2 à conserver |
| Tools MCP via `server.registerTool` (`piece_add` l.527, `piece_list` l.546) | `index.mjs:527-585` | point d'insertion du tool `sprint_report` (A015) |
| Import db.mjs | `index.mjs:125-145` | cible A015 |

**ADR de référence** : `doc-mub10mo8-lgo3` — « ADR-001 — Modèle sprint / fonctionnalités / règles métier dans le registre ecosystem », statut **Proposé**, globale aux 3 repos du projet `ecosystem`. Décisions §1 (sprint 1er niveau, clôture auto + reprise, émergence), §2 (sprint par défaut / anciens sprints), §4 (rapport de sprint) → **citées et implémentées**. Aucune ADR **Accepté** n'existe sur ce périmètre → aucun conflit ADR.

## 4. Couverture des objectifs (Phase 5)

Les 14 lignes du tableau de couverture du plan (§7) couvrent 100 % des critères d'acceptation :

- 1 projet → 1..N sprints, dates paramétrables, statut open/close, session IA dédiée → A001/A003/A006/A011 ;
- clôture AUTOMATIQUE à l'échéance, distincte de la clôture des tâches → A004/A005/A008 (aucune écriture `tasks`/`executions`) ;
- reprise/réouverture → A013 ;
- émergence non bloquante après clôture (pièce → A007/A009 ; tâche → A002/A007/A010/A016 ; fonctionnalité/règle → garde A007, branchement en T5) ;
- sprint par défaut + rattachement (migration) des recettes/tâches existantes sans émergence rétroactive → A001/A011/A012 ;
- sprint ↔ 1..N fonctionnalités / 1..N règles → tables T1 réutilisées + lecture A014 ;
- RAPPORT DE SPRINT + téléchargeable → A014/A015 ;
- non-régression T1/T2 + ADR/`artifacts` → A003/A008/A009/A017.

## 5. Vérification de cohérence

### Intra-plan (Phases 6-7) — ✅ VALID

- **Aucune contradiction** : aucune étape `supprimer` ; aucune étape `renommer`/`déplacer`. A001/A003 et A002/A003 portent le **même modèle** sur **deux supports** (schema.sql = source logique, `migrate()` = base existante), pattern déjà utilisé par T1. A004 (`close`) et A013 (`reopen`) sont des transitions **complémentaires** de `sprints.status`.
- **Aucune lecture d'un élément créé par une étape ultérieure** : toutes les étapes appelantes viennent après la création de leur dépendance (§6 du plan).
- **Aucune étape vague** : chaque étape cible une colonne / fonction / tool nommé, dans un fichier précis, avec verbe d'action et livrable.
- **Couverture 100 %**.

### Globale / inter-plans (Phase 9)

- Un **seul plan** généré pour cette tâche → pas de contradiction inter-plans **sur cette tâche**.
- **Frontières explicites** documentées (§2.8 du plan) avec les tâches du même batch (dépendantes de celle-ci) : T4 `T-20260921-091732-9jqg` (CRUD `sprint_*` — **réutilise** les fonctions livrées ici, ne réimplémente pas le rapport), T5 `T-20260921-091733-rpvh` (`feature_*`/`rule_*` — doit **appeler** `classifyEmergence`), T6 `T-20260921-091735-wmqd` (cardinalités), T9 `T-20260921-091738-u76n` (session de migration — **appelle** `migrateExistingToDefaultSprint`). Ces tâches sont **bloquées par celle-ci** dans la matrice de readiness du batch → pas de conflit concurrent.
- **Conflits de fichiers avec T1/T2** : T1 et T2 sont **done** (commits `3ee7755`, `5444381`) → les régions de `db.mjs` touchées ici sont libres. La matrice de conflit du batch ne signale que des chevauchements **déjà terminés** (T1↔T2), pas avec ce plan.
- **Aucune incohérence globale** détectée → pas de `INCONSISTENCY_FOUND`, pas de question utilisateur.

## 6. Risques & points d'attention (repris du plan §9)

1. Index partiel unique « 1 sprint par défaut par projet » : sûr (aucun sprint en base aujourd'hui) ; garde dans `ensureDefaultSprint`.
2. `createTask` marquera `emergent=hors_sprint` les tâches de projets **sans sprint** avant la migration T9 — conforme ADR-001 §5, tracé et non bloquant, non rétroactif.
3. `reopenSprint` sans prolongation → `auto_close=0` pour éviter une re-clôture immédiate par le balayage.
4. `detectOpenSprint` : forme de retour `{ sprintId, status }` **conservée** (acquis T2 préservés, vérifié par A017).
5. Frontière T4 : seul tool `sprint_*` posé ici = `sprint_report` (lecture seule) ; le CRUD reste à T4.
6. Définition explicite de « fonctionnalité implémentée » (≥1 tâche liée `done`) dans `buildSprintReport`.
7. Vérification finale : **spawn réel du MCP** + `tools/call` en plus de `node --check` (leçon du hotfix `ARTIFACT_KINDS`).

## 7. Tests E2E Playwright — NA

Aucun `playwright.config.*` ni spec E2E dans le repo `opencode-mcp-task-orchestrator` (vérifié : `**/playwright.config.*` → aucun fichier). Le comportement livré est **interne au registre MCP** (modèle SQL + fonctions `db.mjs` + tool `sprint_report`), non observable par un parcours Playwright. L'exposition panneau (onglet/téléchargement) relève des tâches suivantes (repo `opencode-observability`, hors périmètre de cette tâche).

→ **E2E NA** : aucun `e2e_test_register` / `e2e_test_link`. Vérification par appels MCP + requêtes registre (étape A017).

## 8. Conclusion

- Plan Valid (couverture 100 %, aucune contradiction, aucune étape vague).
- 1 plan enregistré, 1 artefact `plan` rattaché, 2 événements publiés.
- Aucune incohérence inter-plans ; frontières avec T4/T5/T6/T9 explicitées.
- Planification **terminée** — prête à être consommée par `build`/`build-notify` sur branche dédiée.
