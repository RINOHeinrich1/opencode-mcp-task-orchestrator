# Rapport de fin de tâche — Modèle structuré Fonctionnalités / Règles métier / Sprints

- **Tâche** : `T-20260921-091728-nviw` — « Fonctionnalités + Règles métier + Sprints — modèle SQL structuré (tables, liens N:N, flags émergence) »
- **Exécution** : `E-T-20260921-091728-nviw-2d79yg` (attempt 1)
- **Sous-tâche (plan)** : `Plan-modele-fonctionnalites-regles-sprints-20260921-092016`
- **Projet** : `ecosystem`
- **Repo cible** : `opencode-mcp-task-orchestrator` — `/root/.config/opencode/mcp/task-orchestrator`
- **Agent** : `build-notify`
- **Date** : 2026-09-21 09:28 UTC
- **Recette source** : `RECT-muaz100k-2iq0` (item 128)
- **ADR de référence** : `doc-mub10mo8-lgo3` — ADR-001 (statut Proposé)

---

## 1. Résumé

**Demandé** : implémenter les 19 étapes du plan — créer le modèle de données structuré
remplaçant les documents de spécification fonctionnelle et scénarios Gherkin par de
véritables tables SQL : `fonctionnalites` (US-xxx), `regles_metier` (RM-xxxx), `sprints`
(objets de 1er niveau), les 12 tables de liens N:N, `sourced_piece_id` + flags
émergence/origine, la contrainte DB « ADR ≥1 fonctionnalité », le tout **idempotent**
sur PostgreSQL existant et **sans casser** le modèle ADR.

**Fait** : le bloc `MODÈLE STRUCTURÉ` (3 tables core + 12 tables de liens + index +
fonction `fn_fonctionnalite_adr_min()` + `CONSTRAINT TRIGGER` différé) a été ajouté en
fin de `schema.sql` et répliqué à l'identique dans `migrate()` de `db.mjs`.
Les 19 étapes du plan sont **toutes `done` (100 %)**.

**Vérifications** (étape A019) — toutes **PASS** :
- `node --check db.mjs` : OK.
- **Idempotence** : `schema.sql` rejoué 3× + `migrate()` sur la base PostgreSQL
  **existante** (2 passes complètes) → aucune erreur ; 15/15 tables présentes.
- **Contrainte** : `CONSTRAINT TRIGGER` différé présent et actif — retirer la dernière
  fonctionnalité d'une ADR est **refusé** ; supprimer l'ADR (cascade) est **autorisé**.
- **Non-régression ADR** : `adr_register` (ADR créée **sans** lien fonctionnalité) et
  `adr_set_status` (`Proposé → Accepté → Déprécié`) fonctionnels ; ADR-001 de référence
  intacte.

---

## 2. Isolation

- **Espace Coder** : le repo `opencode-mcp-task-orchestrator`
  (`/root/.config/opencode/mcp/task-orchestrator`) n'existe dans **aucun** workspace
  Coder (`workspace_list` : 7 workspaces, aucun ne contient ce projet). Conformément à
  la tâche et au plan, c'est un **composant d'infrastructure hôte** → travail sur l'hôte,
  pas de workspace Coder.
- **session-guard** : `acquire` → **exit 0**, `mode: "in-place"` — aucune autre session
  ne travaille sur ce projet.
- **Branche de travail** : `feature/migration-postgresql` (branche de déploiement
  désignée par la mission ; session-guard a confirmé le mode in-place sur la branche
  active). Aucun worktree physique créé.

> ⚠️ **Point d'attention (à lever côté orchestrateur)** : la mission désigne comme
> « branche de travail » la branche de déploiement `feature/migration-postgresql`
> (qui est aussi `mainBranch` du repo), tandis que le CADRE générique demande « une
> branche de travail dédiée, jamais de modification directe sur la branche principale ».
> Ces deux consignes sont en tension. **Interprétation retenue** : suivre la mission
> explicite + le mode in-place de session-guard → commit sur
> `feature/migration-postgresql`. Voir §6.

---

## 3. Branches et commits

- **Branche** : `feature/migration-postgresql`
- **SHA de référence (avant)** : `9a0d8a3ebae46ba6c9d1a09232eccf28f7c80ce5`
- **Commit(s)** :

| SHA | Message | Fichiers |
|---|---|---|
| `3ee7755a4203ae41a43aae1798176fbffc7aacc1` | `feat(db): modèle structuré fonctionnalités/règles métier/sprints + liens N:N (item 128)` | `schema.sql` (+165), `db.mjs` (+149) |

Trace des commits enregistrée dans le registre : `plan_commit_add` → commit id **456**
(fichiers + diffs, append-only). Branche rattachée via `plan_set_branch`.

> Push : **non effectué** (non demandé explicitement dans cette sous-tâche).

---

## 4. Traitements effectués (19/19 étapes)

| Étape | Statut | Objet | Fichier |
|---|---|---|---|
| A001 | done | Table `fonctionnalites` (+ index unique `project,ref`, index `project`) | `schema.sql` |
| A002 | done | Table `regles_metier` (+ index unique `project,ref`, index `project`) | `schema.sql` |
| A003 | done | Table `sprints` (+ index `project`, `status`) | `schema.sql` |
| A004 | done | Table `fonctionnalite_regles` (+ index `regle_id`) | `schema.sql` |
| A005 | done | Table `fonctionnalite_gherkin` → `e2e_tests(id)` (+ index `e2e_test_id`) | `schema.sql` |
| A006 | done | Table `fonctionnalite_adr` → `artifacts(artifact_id)` + `fn_fonctionnalite_adr_min()` + `CONSTRAINT TRIGGER` différé | `schema.sql` |
| A007 | done | Table `sprint_fonctionnalites` (+ index `fonctionnalite_id`) | `schema.sql` |
| A008 | done | Table `sprint_regles` (+ index `regle_id`) | `schema.sql` |
| A009 | done | Table `sprint_pieces` → `artifacts(artifact_id)` (+ index `piece_id`) | `schema.sql` |
| A010 | done | Table `task_sprints` (+ index `sprint_id`) | `schema.sql` |
| A011 | done | Table `task_fonctionnalites` (+ index `fonctionnalite_id`) | `schema.sql` |
| A012 | done | Table `task_adr` → `artifacts(artifact_id)` (+ index `adr_id`) | `schema.sql` |
| A013 | done | Table `recette_sprints` (+ index `sprint_id`) | `schema.sql` |
| A014 | done | Table `recette_fonctionnalites` (+ index `fonctionnalite_id`) | `schema.sql` |
| A015 | done | Table `recette_adr` → `artifacts(artifact_id)` (+ index `adr_id`) | `schema.sql` |
| A016 | done | DDL des 3 tables core + index répliqué dans `migrate()` | `db.mjs` |
| A017 | done | DDL des 12 tables de liens + index répliqué dans `migrate()` | `db.mjs` |
| A018 | done | `fn_fonctionnalite_adr_min()` + `CONSTRAINT TRIGGER` répliqués dans `migrate()` | `db.mjs` |
| A019 | done | Vérifications idempotence + non-régression ADR + `node --check` | `schema.sql`, `db.mjs` |

**Détails d'implémentation**
- 3 tables core : `fonctionnalites`, `regles_metier`, `sprints` — chacune avec
  `sourced_piece_id` (le cas échéant), `emergent` + `emergent_origin`,
  `organization_id`, `created_at`, `updated_at`, `created_by`.
- 12 tables de liens N:N (toutes en PK composite + index sur la 2ᵉ FK) :
  `fonctionnalite_regles`, `fonctionnalite_gherkin`, `fonctionnalite_adr`,
  `sprint_fonctionnalites`, `sprint_regles`, `sprint_pieces`, `task_sprints`,
  `task_fonctionnalites`, `task_adr`, `recette_sprints`, `recette_fonctionnalites`,
  `recette_adr`.
- Contrainte « ADR ≥1 fonctionnalité » portée par un **`CONSTRAINT TRIGGER` différé**
  (`DEFERRABLE INITIALLY DEFERRED`) sur `fonctionnalite_adr`, avec garde « ADR supprimée »
  → ne casse pas `adr_register` (ADR créée sans lien) ni la cascade de suppression d'une ADR.
- DDL strictement **idempotent** : `CREATE TABLE IF NOT EXISTS`,
  `CREATE UNIQUE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
  `DROP TRIGGER IF EXISTS` + `CREATE CONSTRAINT TRIGGER`.
- Le modèle ADR existant (`artifacts` `doc_type='adr'`, famille `adr_*`) **n'est pas modifié**.

**Preuve idempotence (base PostgreSQL existante `task_registry`)** :
```
== PHASE 1 : rejeu schema.sql x2 (base existante) ==   → OK, OK
== PHASE 2 : import db.mjs + ensureSchema (schema.sql + migrate) ==  → OK
== PHASE 3 : présence des 15 tables ==                 → 15/15 ✅
== PHASE 4 : trigger contrainte ADR >=1 fonctionnalité == → CONSTRAINT, deferrable ✅
== PHASE 5 : test contrainte ==
  ✔ DELETE dernière fonctionnalité REFUSÉ: ADR ART-TEST-CONSTRAINT doit être rattachée à au moins 1 fonctionnalité
  ✔ suppression de l'ADR (cascade) AUTORISÉE (garde « ADR supprimée »)
== PHASE 6 : contrôle résidus de test ==               → 0 résidu
IDEMPOTENCE_TEST_RESULT: OK   (2 passes complètes)
```

**Preuve non-régression ADR** :
- `adr_register` → ADR `doc-mub1jr8v-krt4` créée **sans lien fonctionnalité** (statut
  Proposé) → OK.
- `adr_set_status` → `Proposé → Accepté → Déprécié` → OK.
- ADR de test supprimée (`doc_delete`) → OK, aucun résidu.
- ADR-001 `doc-mub10mo8-lgo3` relue via `adr_get` → **intacte**.

---

## 5. Fichiers modifiés / créés

| Fichier | Type | Détail |
|---|---|---|
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | Modifié | +165 lignes : bloc `MODÈLE STRUCTURÉ` (3 tables core + 12 liens + index + fonction/trigger) en fin de fichier |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | Modifié | +149 lignes : DDL identique répliqué en fin de `migrate()` |
| `/root/.config/opencode/mcp/task-orchestrator/reports/report-fonctionnalites-regles-sprints-20260921-092807.md` | Créé | Ce rapport |

**Hors périmètre, non touchés** : `index.mjs` (CRUD MCP = items 131/132), famille
`artifacts`/`adr_*`, `plans/` et `reports/synthese-planning-20260921-092016.md`
(artefacts d'orchestration non suivis, laissés tels quels).

**Effet de bord DB** : le rejeu a **créé les 15 tables + le trigger** sur la base
PostgreSQL `task_registry` existante (effet attendu de la migration, idempotent).

---

## 6. Avertissements / erreurs / incohérences

1. **Tension de consignes (branche de travail)** — la mission impose
   `feature/migration-postgresql` (branche de déploiement = `mainBranch`) comme branche
   de travail, alors que le CADRE demande une branche dédiée et « jamais de modification
   directe sur la branche principale ». Résolu par : mission explicite + `session-guard`
   en mode `in-place` (aucune session parallèle). **Aucune modification hors du
   périmètre `schema.sql`/`db.mjs`.** À confirmer par l'orchestrateur si une branche
   dédiée était réellement attendue.
2. **`sourced_piece_id` sans FK** — volontaire (plan §9.2) : la représentation des pièces
   client est définie par l'item 129 (tâche séparée). L'identifiant vise
   `artifacts.artifact_id` sans couplage.
3. **`fonctionnalite_adr.adr_id` sans filtre `doc_type`** — volontaire (plan §9.4) :
   la restriction « uniquement `doc_type='adr'` » relève de la couche MCP (item 132).
4. **Contrainte non bloquante à la création** — une ADR peut être créée sans
   fonctionnalité (préserve `adr_register`) ; la cardinalité complète à la création est
   traitée par les heuristiques de l'item 133 (tracée, non bloquante). Limite explicite
   et volontaire (plan §9.1).
5. **`artifacts` en base existante** : contraintes legacy `path NOT NULL` / `kind NOT NULL`
   observées lors du test (sans impact sur le périmètre) — le test a été adapté.
6. **E2E : NA** — tâche backend (schéma/registre PostgreSQL), aucun comportement
   utilisateur observable → aucun `e2e_test_register`/`e2e_test_link` (plan §9.8).

**Aucune incohérence code ↔ plan** détectée ; le code produit correspond au DDL de
référence du plan (§10).

---

## 7. Prochaines étapes / recommandations

1. **Pousser la branche** `feature/migration-postgresql` (non fait ici) après
   synchronisation avec la branche principale, pour déclencher le CI/CD de déploiement.
2. **Items dépendants** (hors périmètre) : CRUD MCP `feature_*`/`rule_*`/`sprint_*`
   (items 131-132), heuristiques de cardinalité (item 133), agent de session sprint
   (item 135), migration des anciens sprints (item 136), requalification des documents
   ADR-12 en pièces client (item 129).
3. **Contrôle recette** : vérifier en préprod que les 15 tables et le trigger sont bien
   présents après déploiement (`to_regclass` / `pg_trigger`).
4. **Confirmer la politique de branche** pour ce repo d'infrastructure (cf. §6.1).

---

*Rapport généré par `build-notify` — aucune notification email envoyée par l'agent
(la plateforme `opencode-notifier` gère les notifications).*
