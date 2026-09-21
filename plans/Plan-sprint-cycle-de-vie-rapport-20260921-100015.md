# Plan — SPRINT objet de 1er niveau : cycle de vie produit (durée paramétrable, clôture auto à l'échéance, reprise, sprint par défaut, rapport)

- **taskId** : `T-20260921-091731-d1af` (exécution `E-T-20260921-091731-d1af-fz9l2l`)
- **Projet** : `ecosystem` — batch `BATCH-mub1809u-06ow` (tâche 3/9)
- **Repo** : `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (repo hôte, pas de workspace Coder)
- **Branche de travail** : dédiée, basée sur `feature/migration-postgresql` (branche de déploiement). Jamais de modification directe de la branche principale.
- **Périmètre (scope)** : `schema.sql`, `db.mjs`, `index.mjs` — **uniquement**.
- **Recette source** : `RECT-muaz100k-2iq0` (item « Objet SPRINT de premier niveau »)
- **ADR de référence** : `doc-mub10mo8-lgo3` — « ADR-001 — Modèle sprint / fonctionnalités / règles métier dans le registre ecosystem » (statut **Proposé**, globale aux 3 repos) → décisions §1 (sprint 1er niveau, clôture auto + reprise, émergence), §2 (sprint par défaut / anciens sprints), §4 (rapport de sprint).
- **Dépendances (TERMINÉES)** : `T-20260921-091728-nviw` (tables `fonctionnalites`/`regles_metier`/`sprints` + 12 liens N:N, commit `3ee7755`) et `T-20260921-091730-1rt5` (pièces client `doc_type='piece'`, `assertPieceAllowed`, émergence via `sprints`, commit `5444381`).
- **Date** : 2026-09-21 10:00:15

---

## 1. Objectif

Faire du **SPRINT un objet de premier niveau** doté de son **cycle de vie produit**, dans le registre du repo `opencode-mcp-task-orchestrator` :

- 1 projet → 1..N sprints, **durée paramétrable** (dates début/fin), statut `open` → `close`, **session IA dédiée** ;
- **clôture AUTOMATIQUE à l'échéance** (`end_date`), **distincte** de la clôture d'exécution des tâches (la machine à états des tâches n'est pas touchée) ;
- **reprise / réouverture** possible d'un sprint clôturé (le cycle n'est pas définitif) ;
- après clôture, tout **nouvel élément** (pièce / fonctionnalité / règle / tâche) est **ÉMERGENT** (tracé, non bloqué) via une **garde partagée** ;
- **SPRINT PAR DÉFAUT** par projet (« anciens sprints ») + **rattachement (migration)** des recettes/tâches existantes sans sprint explicite, **sans marquage émergent rétroactif** ;
- sprint associé à **1..N fonctionnalités** et **1..N règles métier** (tables de liens déjà livrées par T1) ;
- **RAPPORT DE SPRINT** (agrégation registre) exposé en lecture pour être téléchargé (panneau).

## 2. Contexte & raison d'être

La recette `RECT-muaz100k-2iq0` a acté que le produit est piloté par des **sessions de sprint** reposant sur les **pièces client**. T1 a livré le **modèle SQL** (tables `sprints`, `fonctionnalites`, `regles_metier` + 12 liens N:N, commit `3ee7755`) ; T2 a livré les **pièces client** et leur **émergence** (calculée par `detectOpenSprint`, commit `5444381`). Il manque le **cycle de vie du sprint** et le **rapport** : à ce stade la table `sprints` n'a **aucune logique** (pas de clôture automatique, pas de reprise, pas de sprint par défaut, pas d'outil de lecture/rapport), et l'émergence n'est calculée que pour les pièces.

**ADR-001 (`doc-mub10mo8-lgo3`, Proposé)** décide explicitement (§1, §2, §4) :
1. sprint 1er niveau, **durée paramétrable**, statut `open→close`, **clôture automatique à l'échéance** distincte de la clôture des tâches, **reprise** possible ; après clôture tout élément apparu est **émergent** (tracé, non bloquant) ;
2. **sprint par défaut** par projet (« anciens sprints » : ex. myxmax lundi 14/09/2026, madatalk lundi 07/09/2026) auquel sont **rattachées** les recettes/tâches existantes sans sprint — **jamais de marquage émergent rétroactif** ;
3. **rapport de sprint** téléchargeable (features implémentées, tâches effectuées, tâches émergentes, règles et fonctionnalités émergentes, pièces).

Ce plan implémente ces points — **aucune contradiction** avec une ADR **Accepté** (aucune ADR Accepté n'existe sur ce périmètre).

### Décisions de conception (à respecter par l'exécution)

1. **Modèle additif, idempotent.** Colonnes ajoutées à `sprints` : `is_default` (0/1), `auto_close` (0/1), `closed_at`, `close_reason` (`auto_echeance` | `manuel`), `reopened_at`. Colonnes ajoutées à `tasks` : `emergent` (0/1), `emergent_origin`. Statut de sprint inchangé (`open` | `close`) — la réouverture revient à `open` (pas de nouveau statut).
2. **Un seul sprint par défaut par projet** : index **partiel unique** `sprints(project) WHERE is_default = 1`.
3. **Clôture automatique** = balayage idempotent `autoCloseExpiredSprints()` : passe à `close` les sprints `open`, `auto_close=1` et `end_date < now`, en posant `closed_at` + `close_reason='auto_echeance'`. **Aucune écriture sur `tasks`/`executions`** (distinction exigée).
4. **Reprise** : `reopenSprint(sprintId, { endDate?, autoClose? })` repasse à `open` et efface `closed_at`/`close_reason`. Si l'échéance résultante est **passée** et que `autoClose` n'est pas explicitement `true`, on pose `auto_close=0` — sinon le balayage re-clôturerait immédiatement (reprise sans prolongation). Si `endDate` est fourni (prolongation), `auto_close=1`.
5. **Émergence — garde unique `classifyEmergence(projectId, { kind })`** :
   - `kind='piece'` (comportement T2 conservé) : un sprint existe → `emergent=true`, origine `apres_init_sprint` (sprint `open`) ou `apres_cloture` (sprint `close`) ; aucun sprint → `emergent=false`.
   - `kind='element'` (fonctionnalité / règle / tâche) : aucun sprint → `emergent=true` origine `hors_sprint` ; dernier sprint `close` → `emergent=true` origine `apres_cloture` ; sprint `open` → `emergent=false` (l'élément appartient au sprint courant).
   - **Jamais bloquant** : aucune exception levée, jamais rétroactif (les éléments existants ne sont pas re-marqués).
6. **Sprint par défaut / migration** : `ensureDefaultSprint(projectId, { title, startDate, endDate })` (idempotent) puis `migrateExistingToDefaultSprint({ projectId, … })` qui rattache `recette_sprints` et `task_sprints` pour les recettes/tâches **sans lien sprint**, **sans** marquer émergent. Les dates réelles (myxmax 14/09/2026, madatalk 07/09/2026) sont fournies par l'appelant (session de migration T9).
7. **Rapport de sprint** = agrégation **registre** (`buildSprintReport`) : fonctionnalités implémentées/émergentes, tâches effectuées/émergentes, règles émergentes, pièces (+ émergentes), recettes ; renvoyée en JSON **et** markdown, exposée en lecture par le tool `sprint_report` (téléchargement panneau).
8. **Frontière avec les tâches suivantes** (à ne pas empiéter) :
   - **T4** (`T-20260921-091732-9jqg`) = famille MCP `sprint_*` **CRUD** (création, liste, détail, rattachement pièces, clôture manuelle, reprise, rapport) → T4 **réutilise** les fonctions `db.mjs` livrées ici (`getSprint`, `listProjectSprints`, `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`, `ensureDefaultSprint`, `buildSprintReport`) et **ne réimplémente pas** le rapport (le tool `sprint_report` posé ici est réutilisé).
   - **T5** (`T-20260921-091733-rpvh`) = familles `feature_*`/`rule_*` + liens → **doit appeler** `classifyEmergence(projectId, { kind:'element' })` à la création d'une fonctionnalité/règle.
   - **T6** (`T-20260921-091735-wmqd`) = validations heuristiques de cardinalité → s'appuie sur la garde d'émergence et rattache les nouveaux éléments au sprint courant.
   - **T9** (`T-20260921-091738-u76n`) = session de migration des anciens sprints → appelle `migrateExistingToDefaultSprint` par projet avec le calendrier réel.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|---|---|---|---|---|---|---|
| A001 | modifier | table `sprints` (l.703-717) : ajouter colonnes `is_default`, `auto_close`, `closed_at`, `close_reason`, `reopened_at` + index `idx_sprints_default` (partiel unique `WHERE is_default = 1`) + `idx_sprints_project_status` | `schema.sql` | `schema.sql` | Porter le cycle de vie produit (défaut + clôture/reprise) sur l'objet sprint | Table `sprints` étendue, index posés, idempotent |
| A002 | modifier | table `tasks` (l.7-31) : ajouter `emergent INTEGER NOT NULL DEFAULT 0`, `emergent_origin TEXT` + index `idx_tasks_emergent` | `schema.sql` | `schema.sql` | Marquer l'émergence d'une **tâche** apparue après clôture / hors sprint (aligné sur `fonctionnalites`/`regles_metier`) | Colonnes émergence sur `tasks` |
| A003 | ajouter | DDL miroir dans `migrate()` (près du bloc sprints l.495-509) : `ALTER TABLE sprints ADD COLUMN IF NOT EXISTS …` (×5), `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS …` (×2), index `idx_sprints_default` / `idx_sprints_project_status` / `idx_tasks_emergent` | `db.mjs` | `db.mjs` | Appliquer le modèle aux bases **existantes** (schema.sql ne fait que `CREATE TABLE IF NOT EXISTS`) | Base migrée sans recréation |
| A004 | créer | `rowToSprint(r)` + `closeSprint(sprintId, { reason = 'manuel', by } = {})` — clôture bas niveau idempotente (`status='close'`, `closed_at`, `close_reason`, `updated_at`) | `db.mjs` (après `detectOpenSprint` l.624) | `db.mjs` | Primitive de clôture réutilisable (auto + manuelle) **sans toucher aux tâches** | `closeSprint` exporté, idempotent |
| A005 | créer | `autoCloseExpiredSprints({ projectId } = {})` — balaye `status='open' AND auto_close=1 AND end_date IS NOT NULL AND end_date < now` et appelle `closeSprint(id,{reason:'auto_echeance'})` ; retourne `{ closed: [ids] }` | `db.mjs` | `db.mjs` | **Clôture AUTOMATIQUE à l'échéance** (idempotente, distincte de la clôture des tâches) | Sprints échus clôturés automatiquement |
| A006 | créer | `getSprint(sprintId)` + `listProjectSprints(projectId, { status } = {})` (SELECT `sprints` → camelCase via `rowToSprint`) | `db.mjs` | `db.mjs` | Base de lecture (détail/liste) pour clôture, reprise, rapport et T4 | `getSprint` / `listProjectSprints` exportés |
| A007 | créer | `classifyEmergence(projectId, { kind = 'element' } = {})` — balaye la clôture auto puis retourne `{ sprintId, sprintStatus, emergent, emergentOrigin }` (règles §2.5) | `db.mjs` | `db.mjs` | **Garde traçable unique** de l'émergence (pièce/fonctionnalité/règle/tâche), non bloquante | `classifyEmergence` exporté, déterministe |
| A008 | modifier | `detectOpenSprint(projectId)` (l.612-624) : appeler `autoCloseExpiredSprints({ projectId })` **avant** la sélection ; forme de retour `{ sprintId, status }` **inchangée** | `db.mjs` | `db.mjs` | Rendre la clôture auto **effective dès la 1ʳᵉ lecture** (chemin pièces T2) | Clôture auto appliquée à la lecture |
| A009 | modifier | `addPiece(...)` (l.4596-4607) : remplacer le calcul inline de l'émergence par `classifyEmergence(pid, { kind:'piece' })` (origines `apres_init_sprint`/`apres_cloture` **inchangées**) | `db.mjs` | `db.mjs` | Centraliser la garde (une seule source), **comportement T2 conservé** | `addPiece` utilise la garde partagée |
| A010 | modifier | `createTask(task)` (l.647-712) : après l'INSERT de la tâche, `classifyEmergence(task.project, { kind:'element' })` → `UPDATE tasks SET emergent=…, emergent_origin=…` si émergente | `db.mjs` | `db.mjs` | « Après clôture, toute nouvelle **tâche** est émergente (tracée, non bloquée) » | Nouvelle tâche marquée émergente le cas échéant |
| A011 | créer | `ensureDefaultSprint(projectId, { title, startDate, endDate, createdBy } = {})` — idempotent : si `is_default=1` existe → le retourne ; sinon INSERT `SPRINT-<ts>-<rand>` (`is_default=1`, statut `close` + `close_reason='auto_echeance'` si `end_date` passée, sinon `open`) | `db.mjs` | `db.mjs` | **SPRINT PAR DÉFAUT** par projet (« anciens sprints ») | Un sprint par défaut par projet, sans doublon |
| A012 | créer | `migrateExistingToDefaultSprint({ projectId, title, startDate, endDate } = {})` — `ensureDefaultSprint` puis rattache `recette_sprints` / `task_sprints` des recettes/tâches du projet **sans lien sprint** (`ON CONFLICT DO NOTHING`), **sans** marquage émergent ; retourne `{ sprintId, recettes, tasks }` | `db.mjs` | `db.mjs` | **Migration** : rattacher les recettes/tâches existantes au sprint par défaut | Comptes de rattachement, émergence non rétroactive |
| A013 | créer | `reopenSprint(sprintId, { endDate, autoClose, by } = {})` — repasse `status='open'`, efface `closed_at`/`close_reason`, pose `reopened_at` ; applique la règle §2.4 (`auto_close=0` si échéance passée sans prolongation) | `db.mjs` | `db.mjs` | **Reprise / réouverture** d'un sprint clôturé (cycle non définitif) | `reopenSprint` exporté, re-clôture évitée |
| A014 | créer | `buildSprintReport(sprintId, { format = 'markdown' } = {})` — agrège sprint + fonctionnalités (implémentées = ≥1 tâche liée `done` / émergentes) + tâches (effectuées `done` / émergentes) + règles émergentes + pièces (+ émergentes) + recettes ; retourne `{ sprint, stats, sections, markdown }` | `db.mjs` | `db.mjs` | **RAPPORT DE SPRINT** côté registre | Rapport JSON + markdown |
| A015 | ajouter | import `buildSprintReport` (l.132-139) + tool `sprint_report` (bloc après l.584, famille sprint) — `sprintId`, `format` (`markdown`|`json`) ; **lecture seule** | `index.mjs` | `index.mjs` | Rendre le rapport **téléchargeable** (panneau) | Tool `sprint_report` enregistré |
| A016 | modifier | `rowToTask(row)` (l.791-819) : exposer `emergent: !!row.emergent` + `emergentOrigin: row.emergent_origin ?? null` | `db.mjs` | `db.mjs` | Visibilité de l'émergence des tâches (rapport + T6) | Champs exposés par `getTask`/`listTasks` |
| A017 | vérifier | idempotence (rejeu `schema.sql` + `migrate()`), non-régression T1/T2 + ADR/`artifacts`, cycle complet (défaut → émergence → clôture auto → reprise → rapport), spawn réel du MCP (`sprint_report`, `piece_add`) + `node --check` | `schema.sql`, `db.mjs`, `index.mjs` | — | Garantir le modèle, le cycle de vie et le rapport sans régression | Rapport de vérification (2ᵉ rejeu sans erreur ; cycle OK) |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---|---|
| `schema.sql` | **Modification** — `sprints` étendue (A001), `tasks` étendue (A002), index associés |
| `db.mjs` | **Modification** — miroir DDL dans `migrate()` (A003) ; cycle de vie + garde + rapport (A004-A014) ; `detectOpenSprint` (A008) ; `addPiece` (A009) ; `createTask` (A010) ; `rowToTask` (A016) |
| `index.mjs` | **Modification** — import + tool `sprint_report` (A015) |

> Aucun fichier créé. **Aucune** modification de la famille ADR (`artifacts` `doc_type='adr'`, `adr_*`) ni du modèle polymorphe `artifacts`. Les tables de liens de T1 (`sprint_fonctionnalites`, `sprint_regles`, `sprint_pieces`, `task_sprints`, `recette_sprints`) sont **réutilisées telles quelles** (aucune nouvelle table).

## 5. Livrables attendus

1. **Table `sprints` étendue** : `is_default`, `auto_close`, `closed_at`, `close_reason`, `reopened_at` + index partiel unique « 1 sprint par défaut par projet » + index `(project, status)` — dans `schema.sql` **et** `db.mjs`.
2. **Table `tasks` étendue** : `emergent`, `emergent_origin` (+ index) — dans `schema.sql` **et** `db.mjs`.
3. **Cycle de vie** (`db.mjs`) : `closeSprint`, `autoCloseExpiredSprints`, `getSprint`, `listProjectSprints`, `reopenSprint`.
4. **Garde d'émergence unique** (`db.mjs`) : `classifyEmergence(projectId, { kind })`, branchée sur `addPiece` (pièces, comportement T2 conservé) et `createTask` (tâches) ; disponible pour `feature_*`/`rule_*` (T5).
5. **Sprint par défaut + migration** (`db.mjs`) : `ensureDefaultSprint`, `migrateExistingToDefaultSprint` (rattachement recettes/tâches existants, **sans** émergence rétroactive).
6. **Rapport de sprint** (`db.mjs`) : `buildSprintReport` (JSON + markdown) et tool MCP `sprint_report` (`index.mjs`).
7. **Non-régression** : `detectOpenSprint` conserve sa forme de retour ; `addPiece` conserve ses origines d'émergence ; machine à états des tâches **inchangée** ; famille ADR/`artifacts` **inchangée** ; schéma **idempotent** (2ᵉ rejeu sans erreur).

## 6. Ordre & dépendances

```
A001 ─▶ A002 ─▶ A003 ─▶ A004 ─▶ A005 ─▶ A006 ─▶ A007 ─┬─▶ A008
                                                        ├─▶ A009
                                                        ├─▶ A010
                                                        └─▶ A011 ─▶ A012
A006 ─▶ A013
A005 ─▶ A014
A006 ─▶ A014
A014 ─▶ A015
A010 ─▶ A016
A003 ─▶ A017 ; A015 ─▶ A017 ; A016 ─▶ A017
```

- **Séquences obligatoires** :
  - A001/A002 **avant** A003 (le miroir `migrate()` reprend les colonnes) ;
  - A003 **avant** A004-A016 (les colonnes doivent exister) ;
  - A004 **avant** A005 (le balayage réutilise `closeSprint`) ;
  - A005 **avant** A007 (la garde balaye la clôture auto) et **avant** A014 (le rapport est calculé sur l'état à jour) ;
  - A006 **avant** A013/A014 (reprise et rapport lisent le sprint) ;
  - A007 **avant** A009/A010 (garde partagée) ;
  - A011 **avant** A012 (le défaut doit exister avant le rattachement) ;
  - A014 **avant** A015 (le tool expose la fonction) ; A003/A015/A016 **avant** A017 (vérification finale).
- **Parallélisables** : A008/A009/A010/A011 (fonctions distinctes, après A007) ; A013 (après A006) ; A016 (indépendant, après A003).
- **Séquentialité imposée** : `schema.sql` d'abord (source logique), puis `db.mjs` (miroir + logique), puis `index.mjs` (exposition).
- **Dépendances externes** : tables `sprints` / liens N:N livrées par T1 (commit `3ee7755`) ; pièces client + `detectOpenSprint` livrées par T2 (commit `5444381`) — disponibles, pas de blocage.

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|---|---|---|
| 1 projet → 1..N sprints ; titre, dates début/fin **paramétrables**, statut `open`/`close`, session IA dédiée | A001, A003, A006, A011 (défaut) — la création d'un sprint **nominal** est exposée par T4 (réutilise A006/A011) | ✅ |
| **Clôture AUTOMATIQUE à l'échéance** | A004, A005, A008 | ✅ |
| Clôture de sprint **distincte** de la clôture d'exécution des tâches (tâches non touchées) | A004 (aucune écriture `tasks`/`executions`), A005, A017 | ✅ |
| Sprint clôturé **REPRIS** (réouverture possible) | A013 (+ A004 pour la re-clôture) | ✅ |
| Après clôture, **pièce** nouvelle → ÉMERGENTE (tracée, non bloquée) | A007, A009 | ✅ |
| Après clôture, **tâche** nouvelle → ÉMERGENTE (tracée, non bloquée) | A002, A007, A010, A016 | ✅ |
| Après clôture, **fonctionnalité / règle** nouvelle → ÉMERGENTE (garde traçable) | A007 (+ colonnes `emergent`/`emergent_origin` déjà livrées T1) — **branchement** dans `feature_*`/`rule_*` = T5 | ✅ (garde livrée, appel T5) |
| **SPRINT PAR DÉFAUT** par projet (« anciens sprints ») | A001 (`is_default` + index unique), A011 | ✅ |
| **Rattachement (migration)** des recettes/tâches existantes sans sprint explicite | A012 (+ A011) ; exécution par projet = T9 | ✅ |
| Émergence **jamais rétroactive** (éléments existants non marqués) | A012 (rattachement sans `emergent`) | ✅ |
| Un sprint associé à **1..N fonctionnalités** et **1..N règles métier** | tables `sprint_fonctionnalites`/`sprint_regles` (T1, réutilisées) + lecture/rapport A014 | ✅ |
| **RAPPORT DE SPRINT** (fonctionnalités implémentées, tâches effectuées/émergentes, règles et fonctionnalités émergentes, pièces) | A014 | ✅ |
| Rapport **téléchargeable** (panneau) | A015 (`sprint_report`) | ✅ |
| Non-régression T1/T2 + ADR/`artifacts` + machine à états des tâches | A003 (ALTER additif), A009 (comportement conservé), A008 (forme de retour conservée), A017 | ✅ |

## 8. Vérification de cohérence

**Analyse intra-plan (Phases 6-7)** — regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `sprints` (colonnes cycle de vie) | A001 (schéma), A003 (miroir ALTER) | ✅ même modèle, deux supports (pattern T1) |
| `tasks` (colonnes émergence) | A002 (schéma), A003 (miroir ALTER), A010 (écriture), A016 (lecture) | ✅ création puis lecture, ordre respecté |
| `closeSprint` | A004 (créer), A005 (appel), A013 (état inverse) | ✅ primitive unique, réutilisée |
| `autoCloseExpiredSprints` | A005 (créer), A008 (appel), A014 (appel) | ✅ appel après création |
| `detectOpenSprint` | A008 (modifier) | ✅ forme de retour conservée (T2 non cassé) |
| `addPiece` | A009 (modifier) | ✅ comportement conservé (origines identiques) |
| `createTask` | A010 (modifier) | ✅ ajout additif après INSERT |
| `rowToTask` | A016 (modifier) | ✅ champs additifs |
| `classifyEmergence` | A007 (créer), A009/A010 (appel) | ✅ garde unique |
| `ensureDefaultSprint` | A011 (créer), A012 (appel) | ✅ |
| `migrateExistingToDefaultSprint` | A012 (créer) | ✅ |
| `reopenSprint` | A013 (créer) | ✅ |
| `buildSprintReport` | A014 (créer), A015 (exposer) | ✅ |
| tool `sprint_report` | A015 (créer) | ✅ |

- **Aucune contradiction** : aucune étape `supprimer` ; aucune étape `renommer`/`déplacer`. A001/A003 (schéma + miroir) et A002/A003 portent sur des **fichiers différents** avec le **même modèle** (pattern T1). A004 (`close`) et A013 (`reopen`) sont des transitions **complémentaires** de `sprints.status` (pas d'action incompatible). A008/A009 **conservent** les comportements T2 (aucune rupture).
- **Aucune lecture d'un élément créé par une étape ultérieure** : toutes les fonctions appelantes (A005, A008, A009, A010, A012, A013, A014, A015) viennent **après** la création de leur dépendance (cf. §6).
- **Aucune étape vague** : chaque étape cible une colonne / fonction / tool nommé, dans un fichier précis, avec un verbe d'action et un livrable.
- **Couverture 100 %** : toutes les exigences ont ≥1 étape (cf. §7).

**Plan Validator : ✅ VALID** (aucune contradiction, aucune exigence non couverte, aucune étape vague).

## 9. Risques & notes

1. **Index partiel unique « 1 défaut par projet »** — `CREATE UNIQUE INDEX … ON sprints(project) WHERE is_default = 1` échouerait si des doublons existaient. État actuel : **aucun sprint en base** (T1 n'a créé que le DDL) → création sûre. Garde : `ensureDefaultSprint` vérifie `is_default=1` avant INSERT.
2. **`createTask` marque émergent `hors_sprint`** — tout projet **sans sprint** (cas de tous les projets avant la migration T9) verra ses nouvelles tâches marquées `emergent=1 / hors_sprint`. C'est **conforme** à ADR-001 §5 (« liens manquants à la création → émergent, non bloquant ») et **non rétroactif** (T9 rattache les anciennes tâches sans les marquer). Effet tracé, non bloquant ; à surveiller lors de la vérification (A017).
3. **Reprise sans prolongation** — si `reopenSprint` est appelé sur un sprint dont `end_date` est passée sans nouvelle `endDate`, on pose `auto_close=0` pour empêcher une re-clôture immédiate par le balayage (A005). Comportement **explicite et documenté**.
4. **`detectOpenSprint` et T2** — l'ajout du balayage (A008) ne change **pas** la forme de retour (`{ sprintId, status }`) ni les origines d'émergence des pièces (A009) : les acquis de T2 (commit `5444381`) sont préservés. A017 le vérifie.
5. **Frontière T4** — le tool `sprint_report` (A015) est **le seul** tool `sprint_*` posé ici (lecture seule, livrable « rapport »). La famille **CRUD** `sprint_*` reste à T4, qui **réutilise** les fonctions `db.mjs` de ce plan (pas de duplication).
6. **« Fonctionnalités implémentées »** — définition retenue pour le rapport : une fonctionnalité du sprint est *implémentée* si **au moins une tâche** qui lui est liée (`task_fonctionnalites`) a sa dernière exécution au statut `done`. Définition **explicite** dans `buildSprintReport` (A014), ajustable sans changement de modèle.
7. **Valeurs `close_reason`** — `auto_echeance` (balayage A005) | `manuel` (T4). Documenté en commentaire de colonne.
8. **Non-régression ADR / `artifacts`** — aucune étape ne touche `artifacts`, `adr_*`, `doc_*` ; `schema.sql`/`migrate()` ne font que des `ALTER TABLE … ADD COLUMN IF NOT EXISTS` **additifs** sur `sprints`/`tasks`.
9. **E2E Playwright : NA** — aucun `playwright.config.*` ni spec E2E dans le repo `opencode-mcp-task-orchestrator` ; le comportement est interne (registre MCP), **non observable** par un parcours Playwright. Aucun `e2e_test_register` / `e2e_test_link` (mention explicite). Vérification par appels MCP + requêtes registre (A017).
10. **Vérification sans `node --check` seul** — l'expérience du repo (hotfix `ARTIFACT_KINDS`) impose un **spawn réel du MCP** + `tools/call` (A017) en plus de `node --check db.mjs index.mjs`.

## 10. Annexe — DDL de référence (à produire tel quel)

### A001 — `sprints` (schema.sql, remplace la définition l.703-717)

```sql
CREATE TABLE IF NOT EXISTS sprints (
  id              TEXT PRIMARY KEY,                -- SPRINT-<ts>-<rand>
  project         TEXT NOT NULL,
  title           TEXT NOT NULL,
  start_date      TEXT,                            -- début (ISO 8601)
  end_date        TEXT,                            -- fin (ISO 8601) — échéance de clôture AUTO
  status          TEXT NOT NULL DEFAULT 'open',    -- open | close (reprise : close -> open)
  is_default      INTEGER NOT NULL DEFAULT 0,      -- 1 = sprint par défaut du projet (« anciens sprints »)
  auto_close      INTEGER NOT NULL DEFAULT 1,      -- 1 = clôture automatique à end_date
  closed_at       TEXT,                            -- date de clôture (auto ou manuelle)
  close_reason    TEXT,                            -- auto_echeance | manuel
  reopened_at     TEXT,                            -- dernière réouverture
  session_id      TEXT,                            -- session IA dédiée
  organization_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  created_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project);
CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
CREATE INDEX IF NOT EXISTS idx_sprints_project_status ON sprints(project, status);
-- Au plus UN sprint par défaut par projet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_default ON sprints(project) WHERE is_default = 1;
```

### A002 — `tasks` (schema.sql, deux colonnes à ajouter au `CREATE TABLE`, l.7-31)

```sql
  emergent        INTEGER NOT NULL DEFAULT 0,     -- 1 = émergente (hors sprint / après clôture)
  emergent_origin TEXT,                           -- hors_sprint | apres_cloture
```

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_emergent ON tasks(project) WHERE emergent = 1;
```

### A003 — miroir `db.mjs` (dans `migrate()`, à la suite du bloc sprints l.495-509)

```js
  // Sprint — cycle de vie produit : sprint par défaut, clôture auto à l'échéance, reprise.
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS auto_close INTEGER NOT NULL DEFAULT 1");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS closed_at TEXT");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS close_reason TEXT");
  await pool().query("ALTER TABLE sprints ADD COLUMN IF NOT EXISTS reopened_at TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_sprints_project_status ON sprints(project, status)");
  await pool().query("CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_default ON sprints(project) WHERE is_default = 1");
  // Tâche — émergence (apparue hors sprint / après clôture) : tracée, non bloquante.
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS emergent INTEGER NOT NULL DEFAULT 0");
  await pool().query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS emergent_origin TEXT");
  await pool().query("CREATE INDEX IF NOT EXISTS idx_tasks_emergent ON tasks(project) WHERE emergent = 1");
```

> Dans `db.mjs`, ces `ALTER TABLE` sont des **template literals** : ne pas y insérer de `${…}` (interpolation JS). Le `WHERE` de l'index partiel est du SQL littéral, sans `$`.
