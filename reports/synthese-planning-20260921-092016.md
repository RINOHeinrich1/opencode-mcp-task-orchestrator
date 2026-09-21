# Synthèse de planification — Modèle structuré Fonctionnalités / Règles métier / Sprints

- **taskId** : `T-20260921-091728-nviw`
- **executionId** : `E-T-20260921-091728-nviw-2d79yg`
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`)
- **Recette source** : `RECT-muaz100k-2iq0` (item 128)
- **Agent** : `atomic-plan` (planner)
- **Date** : 2026-09-21 09:20:16

## 1. Objectifs identifiés (Phase 0)

La demande est un **objectif unique et borné** : créer le **modèle de données structuré** (tables + liens N:N) dans `schema.sql` et `db.mjs`. Ses sous-parties (tables core, liens N:N, contrainte DB, idempotence) sont **interdépendantes** (les liens dépendent des tables ; le miroir `db.mjs` dépend de `schema.sql`) → **un seul plan**, avec ordre & dépendances explicites (règle « Dependent → plan unique »).

Aucune ambiguïté de segmentation n'a nécessité de question utilisateur.

## 2. Plans générés

| Plan ID | Objectif | Étapes | Fichiers | Statut |
|---|---|---|---|---|
| `Plan-modele-fonctionnalites-regles-sprints-20260921-092016` | Créer le modèle de données structuré : tables `fonctionnalites`, `regles_metier`, `sprints` + 12 tables de liens N:N, flags émergence, contrainte DB ADR≥1 fonctionnalité, idempotent sur PostgreSQL, sans casser le modèle ADR | 19 (A001–A019) | `schema.sql`, `db.mjs` | ✅ enregistré |

- **Fichier** : `plans/Plan-modele-fonctionnalites-regles-sprints-20260921-092016.md`
- **Artefact plan** : `ART-mub1cd51-89hp` (kind=`plan`, docType=`plan`)
- **Progression** : initialisée (toutes les étapes à `todo`).

## 3. Sources exploitées (Phases 1-2)

- **Code réel** : `schema.sql` (661 l. — tables `artifacts`, `tasks`, `recettes`, `e2e_tests` lues), `db.mjs` (`ensureSchema()` l.31-41, `migrate()` l.44-456, `registerAdr()` l.2343-2370), confirmé sans aucune occurrence préalable de `fonctionnalites`/`regles_metier`/`sprints` (pas de conflit).
- **ADR de référence** : `doc-mub10mo8-lgo3` — ADR-001 « Modèle sprint / fonctionnalités / règles métier » (**Proposé**, globale sur les 3 repos ecosystem) : reprise des décisions 1-6.
- **Recette** : `RECT-muaz100k-2iq0` (items 128-136) — périmètre item 128, vigilance de séquentialité DB et de non-régression ADR/Gherkin.
- **Taxonomie** : `nomenclature-doc-type.md` (référentiel partagé) — les documents ADR-12 deviennent pièces client (item 129), le modèle ADR (`artifacts doc_type='adr'`) est préservé.
- **Conventions** : tables de liens `<a>_<b>` (ex. `task_e2e`, `recette_tasks`, `project_repos`), PK `TEXT`, FK `ON DELETE CASCADE`, `organization_id` sur les entités de 1er niveau, DDL répliqué dans `migrate()`.

## 4. Vérification de cohérence

### Intra-plan (Phases 6-7)
- Regroupement par élément cible : chaque table a **une** action `créer` (`schema.sql`) + **une** réplication (`migrate()`). Aucun `supprimer`/`renommer`/`déplacer` ; aucune lecture d'un élément créé en aval.
- Couverture 100 % des exigences (table §7 du plan) ; aucune étape vague.
- **Plan Validator : ✅ VALID**.

### Globale (Phase 9)
- **Un seul plan** pour cette tâche → aucune contradiction inter-plans possible.
- **Inter-tâches (séquentialité DB)** : les items 129 (pièces client), 130 (sprint lifecycle), 131/132 (CRUD MCP), 133 (cardinalités) touchent aussi `schema.sql`/`db.mjs`/`index.mjs`. Ce plan **n'ajoute pas** leurs colonnes/objets (ex. `is_default`, `closed_at`, `status` du lien tâche↔ADR) pour éviter les doublons/divergences ; la vigilance de séquentialité (item 128) est respectée et documentée dans le plan §9.
- **Aucune incohérence globale détectée** → pas de `INCONSISTENCY_FOUND`.

## 5. Point d'attention explicite (décision de conception)

La contrainte « une ADR est toujours rattachée à ≥1 fonctionnalité » **ne peut pas** être un trigger immédiat sur `artifacts` : `registerAdr()` crée une ADR **sans** lien et les ADR legacy n'en ont aucun — un tel trigger casserait le flux ADR existant (interdit par la mission). Le plan retient donc :
- une **`CONSTRAINT TRIGGER` différée sur `fonctionnalite_adr`** garantissant qu'une ADR **existante** ne peut perdre sa **dernière** fonctionnalité (invariant réellement vérifiable en base) ;
- le manque à la **création** est signalé/tracé par les heuristiques de l'item 133 (non bloquant), puis résolu par la migration (item 136).

Cette limite est **documentée et justifiée** dans le plan (§9.1) — pas une omission.

## 6. Tests E2E

**NA** — tâche backend (schéma/registre PostgreSQL), aucun comportement utilisateur observable. Aucun spec Playwright à créer/modifier/lier ; aucun `e2e_test_register`/`e2e_test_link` émis.

## 7. Suite

1. Validation humaine du plan (décision `validation`).
2. Exécution par `build-notify` sur une **branche de travail dédiée** (basée sur `feature/migration-postgresql`), périmètre strict `schema.sql` + `db.mjs`.
3. A019 : vérifier l'idempotence (rejeu) et la non-régression ADR avant merge.
