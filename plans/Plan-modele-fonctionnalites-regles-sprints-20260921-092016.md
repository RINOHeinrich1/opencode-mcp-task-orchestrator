# Plan — Modèle structuré : Fonctionnalités (US-xxx), Règles métier (RM-xxxx), Sprints + liens N:N

- **taskId** : `T-20260921-091728-nviw`
- **executionId** : `E-T-20260921-091728-nviw-2d79yg`
- **Projet** : `ecosystem`
- **Repo** : `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (repo hôte, pas de workspace Coder)
- **Branche de travail** : dédiée, basée sur `feature/migration-postgresql` (branche de déploiement). Jamais de modification directe sur la branche principale.
- **Périmètre (scope)** : `schema.sql`, `db.mjs` — **uniquement**.
- **Recette source** : `RECT-muaz100k-2iq0` (item 128)
- **ADR de référence** : `doc-mub10mo8-lgo3` — « ADR-001 — Modèle sprint / fonctionnalités / règles métier dans le registre ecosystem » (statut **Proposé**)
- **Date** : 2026-09-21

---

## 1. Objectif

Créer le **modèle de données structuré** (tables SQL + liens N:N) dans `schema.sql` et `db.mjs` du repo `opencode-mcp-task-orchestrator` :

- tables `fonctionnalites`, `regles_metier`, `sprints` (objets de 1er niveau) ;
- liens N:N : fonctionnalité↔règle, fonctionnalité↔scénario Gherkin **existant** (`e2e_tests.gherkin`), fonctionnalité↔ADR, sprint↔fonctionnalité/règle/pièce, tâche↔sprint/fonctionnalité/ADR, recette↔sprint/fonctionnalité/ADR ;
- `sourced_piece_id` + flag émergence + origine sur chaque fonctionnalité et règle ;
- contrainte DB : une ADR est toujours rattachée à ≥1 fonctionnalité ;
- schéma **idempotent** (`CREATE TABLE IF NOT EXISTS`) sur PostgreSQL existant.

## 2. Contexte & raison d'être

Les documents ADR-12 (`specs-fonctionnelles`, `scenarios-gherkin`, `adr-tech`) portaient jusqu'ici la norme fonctionnelle sous forme de gros blocs monolithiques. La recette `RECT-muaz100k-2iq0` a acté la **requalification de ces documents en pièces client** (item 129, tâche séparée `T-20260921-091730-1rt5`) : les **valeurs de référence** doivent désormais vivre dans des **tables structurées** du registre, à l'image des ADR déjà structurées dans la table polymorphe `artifacts` (`doc_type='adr'`, famille `adr_*`).

Le présent plan couvre **l'item 128** (le modèle de données, cœur de la chaîne) : les tables et les liens qui permettent ensuite à l'agent de session sprint de remplir les fonctionnalités/règles à partir des pièces (item 135), au CRUD MCP `feature_*`/`rule_*`/`sprint_*` (items 131-132) et aux cardinalités heuristiques (item 133) de s'appuyer dessus.

**Décisions structurantes reprises de l'ADR-001 (Proposé)** :
1. Le sprint est un objet de 1er niveau (projet, titre, dates, statut `open`/`close`, session IA dédiée).
2. Les scénarios Gherkin ne sont **pas** re-modélisés : le rattachement se fait vers les scénarios **existants** (`e2e_tests.gherkin`) — pas de 4ᵉ table de scénarios.
3. Une ADR est toujours rattachée à ≥1 fonctionnalité (contrainte DB).
4. L'émergence (fonctionnalité/règle apparue hors sprint ou après clôture) est **tracée, non bloquante** : `emergent` + `emergent_origin`.
5. Le modèle ADR existant (`artifacts` `doc_type='adr'`, famille `adr_*`) n'est **pas** modifié.

**Contraintes d'exécution** :
- Le traitement DB est **séquentiel** (vigilance item 128) : pas de parallélisme sur `schema.sql`/`db.mjs` avec les autres items DB (129, 130, 131, 132…).
- Toute étape doit rester **idempotente** (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`).
- `schema.sql` est rejoué à chaque démarrage du process MCP (`ensureSchema()` l.31-41) **avant** `migrate()` (l.44-456) : le DDL doit être identique dans les deux.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|---|---|---|---|---|---|---|
| A001 | Créer | table `fonctionnalites` (+ index `project/ref` unique, `project`) | `schema.sql` | `schema.sql` | Objet 1er niveau : user stories US-xxx | Table créée, idempotente |
| A002 | Créer | table `regles_metier` (+ index `project/ref` unique, `project`) | `schema.sql` | `schema.sql` | Objet 1er niveau : règles RM-xxxx | Table créée, idempotente |
| A003 | Créer | table `sprints` (+ index `project`, `status`) | `schema.sql` | `schema.sql` | Objet 1er niveau : session de sprint | Table créée, idempotente |
| A004 | Créer | table de liens `fonctionnalite_regles` (+ index `regle_id`) | `schema.sql` | `schema.sql` | Lien N:N fonctionnalité↔règle | Table de liens créée |
| A005 | Créer | table de liens `fonctionnalite_gherkin` (+ index `e2e_test_id`) | `schema.sql` | `schema.sql` | Lien fonctionnalité↔scénario Gherkin **existant** (`e2e_tests`) | Table de liens créée |
| A006 | Créer | table de liens `fonctionnalite_adr` + fonction `fn_fonctionnalite_adr_min()` + `CONSTRAINT TRIGGER` différé | `schema.sql` | `schema.sql` | Lien fonctionnalité↔ADR + contrainte « ADR ≥1 fonctionnalité » | Table + contrainte DB créées |
| A007 | Créer | table de liens `sprint_fonctionnalites` (+ index `fonctionnalite_id`) | `schema.sql` | `schema.sql` | Lien sprint↔fonctionnalité | Table de liens créée |
| A008 | Créer | table de liens `sprint_regles` (+ index `regle_id`) | `schema.sql` | `schema.sql` | Lien sprint↔règle métier | Table de liens créée |
| A009 | Créer | table de liens `sprint_pieces` (+ index `piece_id`) | `schema.sql` | `schema.sql` | Lien sprint↔pièce client | Table de liens créée |
| A010 | Créer | table de liens `task_sprints` (+ index `sprint_id`) | `schema.sql` | `schema.sql` | Lien tâche↔sprint | Table de liens créée |
| A011 | Créer | table de liens `task_fonctionnalites` (+ index `fonctionnalite_id`) | `schema.sql` | `schema.sql` | Lien tâche↔fonctionnalité | Table de liens créée |
| A012 | Créer | table de liens `task_adr` (+ index `adr_id`) | `schema.sql` | `schema.sql` | Lien tâche↔ADR | Table de liens créée |
| A013 | Créer | table de liens `recette_sprints` (+ index `sprint_id`) | `schema.sql` | `schema.sql` | Lien recette↔sprint | Table de liens créée |
| A014 | Créer | table de liens `recette_fonctionnalites` (+ index `fonctionnalite_id`) | `schema.sql` | `schema.sql` | Lien recette↔fonctionnalité | Table de liens créée |
| A015 | Créer | table de liens `recette_adr` (+ index `adr_id`) | `schema.sql` | `schema.sql` | Lien recette↔ADR | Table de liens créée |
| A016 | Ajouter | DDL des 3 tables core (`fonctionnalites`, `regles_metier`, `sprints`) + index dans `migrate()` | `db.mjs` | `db.mjs` | Répliquer le schéma sur base PostgreSQL existante | Bloc DDL identique à `schema.sql` |
| A017 | Ajouter | DDL des 12 tables de liens + index dans `migrate()` | `db.mjs` | `db.mjs` | Répliquer le schéma sur base PostgreSQL existante | Bloc DDL identique à `schema.sql` |
| A018 | Ajouter | fonction `fn_fonctionnalite_adr_min()` + `CONSTRAINT TRIGGER` dans `migrate()` | `db.mjs` | `db.mjs` | Répliquer la contrainte DB sur base existante | Fonction + trigger créés, idempotents |
| A019 | Vérifier | idempotence (rejeu de `schema.sql`+`migrate()`), non-régression du modèle ADR (`adr_register`/`adr_set_status`), `node --check db.mjs` | `schema.sql`, `db.mjs` | — | Garantir « idempotent sur PostgreSQL existant » + ne pas casser les ADR | Rapport de vérification (2ᵉ rejeu sans erreur ; ADR créée/liée sans échec) |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---|---|
| `schema.sql` | **Modification** — ajout d'un bloc `MODÈLE STRUCTURÉ` en fin de fichier (3 tables core + 12 tables de liens + index + fonction/trigger) |
| `db.mjs` | **Modification** — ajout du même DDL en fin de `migrate()` (l.44-456), en `await pool().query(...)` |

> Aucun fichier créé. `index.mjs` **non modifié** (hors scope : CRUD MCP = items 131/132). La famille `artifacts`/`adr_*` **non modifiée**.

## 5. Livrables attendus

1. **3 tables de 1er niveau** dans `schema.sql` et `db.mjs` :
   - `fonctionnalites` : `id`, `project`, `ref` (US-xxx), `role`, `user_story`, `sourced_piece_id`, `emergent`, `emergent_origin`, `organization_id`, `created_at`, `updated_at`, `created_by` ; `UNIQUE (project, ref)`.
   - `regles_metier` : `id`, `project`, `ref` (RM-xxxx), `content`, `sourced_piece_id`, `emergent`, `emergent_origin`, `organization_id`, `created_at`, `updated_at`, `created_by` ; `UNIQUE (project, ref)`.
   - `sprints` : `id`, `project`, `title`, `start_date`, `end_date`, `status` (`open`|`close`), `session_id`, `organization_id`, `created_at`, `updated_at`, `created_by`.
2. **12 tables de liens N:N** : `fonctionnalite_regles`, `fonctionnalite_gherkin` (→ `e2e_tests.id`), `fonctionnalite_adr` (→ `artifacts.artifact_id`), `sprint_fonctionnalites`, `sprint_regles`, `sprint_pieces` (→ `artifacts.artifact_id`), `task_sprints`, `task_fonctionnalites`, `task_adr`, `recette_sprints`, `recette_fonctionnalites`, `recette_adr`.
3. **Contrainte DB** : fonction `fn_fonctionnalite_adr_min()` + `CONSTRAINT TRIGGER` différé sur `fonctionnalite_adr` (une ADR ne peut perdre sa dernière fonctionnalité).
4. **DDL répliqué** dans `migrate()` (`db.mjs`) à l'identique (idempotent sur base existante).
5. **Schéma idempotent** : un second rejeu de `schema.sql` + `migrate()` ne produit aucune erreur.
6. **Non-régression ADR** : `adr_register` (création d'ADR sans lien) et `adr_set_status` restent fonctionnels.

## 6. Ordre & dépendances

```
A001 ─┬─▶ A004 ─┐
A002 ─┼─▶ A005  │
      ├─▶ A006  │
      └─▶ A007  ├─▶ A016 ─▶ A017 ─▶ A018 ─▶ A019
A003 ─┬─▶ A008  │
      ├─▶ A009  │
      ├─▶ A010  │
      └─▶ A013  │
A001 ─▶ A011, A014
A002 ─▶ A008
A003 ─▶ A007, A008, A009, A010, A013
```

- **Séquences obligatoires** :
  - A001/A002/A003 **avant** toutes les tables de liens (FK vers `fonctionnalites`/`regles_metier`/`sprints`).
  - A006 **avant** A018 (la fonction/trigger référence `fonctionnalite_adr`).
  - A001..A015 **avant** A016/A017/A018 (le miroir `db.mjs` reprend le DDL de `schema.sql`).
  - A019 **après** A016/A017/A018 (vérification finale).
- **Parallélisables** : A004/A005/A006/A007/A008/A009/A010/A011/A012/A013/A014/A015 (tables distinctes, même fichier `schema.sql` → sérialiser l'édition pour éviter les conflits de rebase).
- **Séquentialité imposée** : `schema.sql` d'abord (source logique), puis `db.mjs` (miroir) ; jamais l'inverse.

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|---|---|---|
| Table `fonctionnalites` (Ref US-xxx, rôle, user story, `sourced_piece_id`, flag émergent + origine) | A001, A016 | ✅ |
| Table `regles_metier` (RM-xxxx, contenu, `sourced_piece_id`, flag émergent + origine) | A002, A016 | ✅ |
| Table `sprints` (projet, titre, début/fin, statut open/close, session IA dédiée) | A003, A016 | ✅ |
| Lien fonctionnalité↔règle métier | A004, A017 | ✅ |
| Lien fonctionnalité↔scénario Gherkin **existant** (`e2e_tests.gherkin`, pas de 4ᵉ table) | A005, A017 | ✅ |
| Lien fonctionnalité↔ADR | A006, A017 | ✅ |
| Lien sprint↔fonctionnalité / règle / pièce | A007, A008, A009, A017 | ✅ |
| Lien tâche↔sprint / fonctionnalité / ADR | A010, A011, A012, A017 | ✅ |
| Lien recette↔sprint / fonctionnalité / ADR | A013, A014, A015, A017 | ✅ |
| **Contrainte DB** : une ADR toujours rattachée à ≥1 fonctionnalité | A006, A018 | ✅ |
| Schéma **idempotent** (`CREATE IF NOT EXISTS`) sur PostgreSQL existant | A001..A015, A016, A017, A018, A019 | ✅ |
| Modèle ADR existant non cassé (`artifacts` `doc_type='adr'`, famille `adr_*`) | A006 (trigger non bloquant à la création), A019 | ✅ |
| Tables présentes dans `schema.sql` **et** `db.mjs` | A001..A018 | ✅ |

## 8. Vérification de cohérence

**Analyse intra-plan (Phases 6-7)** — regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `fonctionnalites` | A001 (créer), A016 (miroir) | ✅ création unique, miroir idempotent |
| `regles_metier` | A002 (créer), A016 (miroir) | ✅ |
| `sprints` | A003 (créer), A016 (miroir) | ✅ |
| `fonctionnalite_regles` | A004, A017 | ✅ |
| `fonctionnalite_gherkin` | A005, A017 | ✅ |
| `fonctionnalite_adr` + trigger | A006, A017, A018 | ✅ table créée 1×, trigger répliqué (CREATE OR REPLACE + DROP/CREATE) |
| `sprint_fonctionnalites`/`sprint_regles`/`sprint_pieces` | A007/A008/A009, A017 | ✅ |
| `task_sprints`/`task_fonctionnalites`/`task_adr` | A010/A011/A012, A017 | ✅ |
| `recette_sprints`/`recette_fonctionnalites`/`recette_adr` | A013/A014/A015, A017 | ✅ |

- **Aucune contradiction** : chaque table a une seule action `créer` (dans `schema.sql`) + une seule réplication (dans `migrate()`). Aucun `supprimer`/`renommer`/`déplacer` sur un même élément. Aucun élément créé puis modifié par une étape contradictoire.
- **Aucune lecture d'un élément créé par une étape ultérieure** : les FK ne référencent que des tables créées en amont (A001-A003) ou préexistantes (`artifacts`, `tasks`, `recettes`, `e2e_tests`).
- **Aucune étape vague** : chaque étape cible une table/objet précis dans un fichier précis, avec un verbe d'action.
- **Couverture 100 %** : toutes les exigences ont ≥1 étape (cf. §7).

**Plan Validator : ✅ VALID** (aucune contradiction, aucune exigence non couverte, aucune étape vague).

## 9. Risques & notes

1. **Contrainte « ADR ≥1 fonctionnalité » et non-régression `adr_register`** — `registerAdr()` (`db.mjs` l.2343-2370) crée une ADR **sans** lien fonctionnalité ; un trigger immédiat sur `artifacts` casserait ce flux (et toute ADR legacy déjà en base). Décision retenue : la contrainte est portée par un **`CONSTRAINT TRIGGER` différé sur `fonctionnalite_adr`** qui garantit qu'une ADR **existante** ne peut perdre sa **dernière** fonctionnalité (fonction `fn_fonctionnalite_adr_min()`, avec garde « ADR supprimée → pas de contrainte »). La cardinalité complète à la **création** (ADR créée sans fonctionnalité) est signalée/tracée par les heuristiques de l'item 133 (non bloquant), puis rendue possible par la migration (item 136). Cette limite est **explicite et volontaire** pour ne pas casser le modèle ADR existant.
2. **`sourced_piece_id` en `TEXT` sans FK** — la représentation des pièces client (natures md/pdf/docx/lien Drive, `doc_type`) est définie par l'item 129 (tâche séparée). On stocke l'identifiant de la pièce (prévu = `artifacts.artifact_id`) sans FK pour ne pas coupler ce plan à un modèle non encore livré ; un commentaire de colonne documente la référence.
3. **`fonctionnalite_gherkin` référence `e2e_tests(id)`** — le scénario Gherkin existant vit dans `e2e_tests.gherkin` ; aucune 4ᵉ table de scénarios n'est créée (exigence explicite).
4. **`fonctionnalite_adr.adr_id` référence `artifacts(artifact_id)` sans filtrer `doc_type`** — la restriction « uniquement `doc_type='adr'` » est du ressort de la couche MCP (item 132), pas du DDL.
5. **Ordre dans `schema.sql`** : le bloc doit être placé **en fin de fichier**, après `artifacts`, `tasks`, `recettes`, `e2e_tests` (dépendances FK), et les tables core avant les tables de liens.
6. **`schema.sql` est exécuté comme une requête multi-instructions** (`pool().query(readFileSync(...))`) : la fonction PL/pgSQL en `$$ ... $$` est acceptée ; ne pas y insérer de `${` (interpolation JS) lors de l'ajout dans `db.mjs` (template literal).
7. **Suppression d'une fonctionnalité** : supprimer la dernière fonctionnalité liée à une ADR est **refusé** par la contrainte (comportement voulu) ; les flux MCP devront relier une autre fonctionnalité avant suppression.
8. **E2E : NA** — tâche backend (schéma/registre PostgreSQL), aucun comportement utilisateur observable (pas de spec Playwright à créer/lier). Mention explicite : aucun `e2e_test_register`/`e2e_test_link`.

## 10. Annexe — DDL de référence (à produire tel quel)

```sql
-- ===========================================================================
-- MODÈLE STRUCTURÉ — Fonctionnalités (US-xxx), Règles métier (RM-xxxx), Sprints
-- (ADR-001, item 128). Les documents ADR-12 (specs/gherkin) deviennent des
-- PIÈCES CLIENT ; les valeurs de référence vivent ici. Idempotent.
-- NE TOUCHE PAS la famille ADR (artifacts doc_type='adr', adr_*).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS fonctionnalites (
  id               TEXT PRIMARY KEY,               -- FEAT-<ts>-<rand>
  project          TEXT NOT NULL,
  ref              TEXT NOT NULL,                  -- US-001, US-002…
  role             TEXT,                           -- rôle (« En tant que <rôle> »)
  user_story       TEXT NOT NULL,                  -- « En tant que <rôle>, je peux … »
  sourced_piece_id TEXT,                           -- pièce client source (artifacts.artifact_id)
  emergent         INTEGER NOT NULL DEFAULT 0,     -- 1 = émergente (hors sprint / après clôture)
  emergent_origin  TEXT,                           -- hors_sprint | apres_cloture | sans_piece | recette
  organization_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,
  created_by       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fonctionnalites_project_ref ON fonctionnalites(project, ref);
CREATE INDEX IF NOT EXISTS idx_fonctionnalites_project ON fonctionnalites(project);

CREATE TABLE IF NOT EXISTS regles_metier (
  id               TEXT PRIMARY KEY,               -- RMET-<ts>-<rand>
  project          TEXT NOT NULL,
  ref              TEXT NOT NULL,                  -- RM-0001…
  content          TEXT NOT NULL,                  -- contenu de la règle
  sourced_piece_id TEXT,                           -- pièce client source (artifacts.artifact_id)
  emergent         INTEGER NOT NULL DEFAULT 0,
  emergent_origin  TEXT,
  organization_id  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,
  created_by       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_regles_metier_project_ref ON regles_metier(project, ref);
CREATE INDEX IF NOT EXISTS idx_regles_metier_project ON regles_metier(project);

CREATE TABLE IF NOT EXISTS sprints (
  id              TEXT PRIMARY KEY,                -- SPRINT-<ts>-<rand>
  project         TEXT NOT NULL,
  title           TEXT NOT NULL,
  start_date      TEXT,                            -- début (ISO 8601)
  end_date        TEXT,                            -- fin (ISO 8601)
  status          TEXT NOT NULL DEFAULT 'open',    -- open | close
  session_id      TEXT,                            -- session IA dédiée
  organization_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  created_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project);
CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);

CREATE TABLE IF NOT EXISTS fonctionnalite_regles (
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  regle_id          TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
  PRIMARY KEY (fonctionnalite_id, regle_id)
);
CREATE INDEX IF NOT EXISTS idx_fonctionnalite_regles_regle ON fonctionnalite_regles(regle_id);

CREATE TABLE IF NOT EXISTS fonctionnalite_gherkin (
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  e2e_test_id       TEXT NOT NULL REFERENCES e2e_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (fonctionnalite_id, e2e_test_id)
);
CREATE INDEX IF NOT EXISTS idx_fonctionnalite_gherkin_test ON fonctionnalite_gherkin(e2e_test_id);

CREATE TABLE IF NOT EXISTS fonctionnalite_adr (
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  adr_id            TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (fonctionnalite_id, adr_id)
);
CREATE INDEX IF NOT EXISTS idx_fonctionnalite_adr_adr ON fonctionnalite_adr(adr_id);

-- Contrainte : une ADR (existante) ne peut perdre sa dernière fonctionnalité.
CREATE OR REPLACE FUNCTION fn_fonctionnalite_adr_min() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = OLD.adr_id)
       AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr WHERE adr_id = OLD.adr_id) THEN
      RAISE EXCEPTION 'ADR % doit être rattachée à au moins 1 fonctionnalité', OLD.adr_id;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.adr_id IS DISTINCT FROM NEW.adr_id
     AND EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = OLD.adr_id)
     AND NOT EXISTS (SELECT 1 FROM fonctionnalite_adr WHERE adr_id = OLD.adr_id) THEN
    RAISE EXCEPTION 'ADR % doit être rattachée à au moins 1 fonctionnalité', OLD.adr_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fonctionnalite_adr_min ON fonctionnalite_adr;
CREATE CONSTRAINT TRIGGER trg_fonctionnalite_adr_min
  AFTER INSERT OR UPDATE OR DELETE ON fonctionnalite_adr
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_fonctionnalite_adr_min();

CREATE TABLE IF NOT EXISTS sprint_fonctionnalites (
  sprint_id         TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  PRIMARY KEY (sprint_id, fonctionnalite_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_fonctionnalites_feat ON sprint_fonctionnalites(fonctionnalite_id);

CREATE TABLE IF NOT EXISTS sprint_regles (
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  regle_id  TEXT NOT NULL REFERENCES regles_metier(id) ON DELETE CASCADE,
  PRIMARY KEY (sprint_id, regle_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_regles_regle ON sprint_regles(regle_id);

CREATE TABLE IF NOT EXISTS sprint_pieces (
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  piece_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (sprint_id, piece_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_pieces_piece ON sprint_pieces(piece_id);

CREATE TABLE IF NOT EXISTS task_sprints (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, sprint_id)
);
CREATE INDEX IF NOT EXISTS idx_task_sprints_sprint ON task_sprints(sprint_id);

CREATE TABLE IF NOT EXISTS task_fonctionnalites (
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, fonctionnalite_id)
);
CREATE INDEX IF NOT EXISTS idx_task_fonctionnalites_feat ON task_fonctionnalites(fonctionnalite_id);

CREATE TABLE IF NOT EXISTS task_adr (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  adr_id  TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, adr_id)
);
CREATE INDEX IF NOT EXISTS idx_task_adr_adr ON task_adr(adr_id);

CREATE TABLE IF NOT EXISTS recette_sprints (
  recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  sprint_id  TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, sprint_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_sprints_sprint ON recette_sprints(sprint_id);

CREATE TABLE IF NOT EXISTS recette_fonctionnalites (
  recette_id        TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  fonctionnalite_id TEXT NOT NULL REFERENCES fonctionnalites(id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, fonctionnalite_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_fonctionnalites_feat ON recette_fonctionnalites(fonctionnalite_id);

CREATE TABLE IF NOT EXISTS recette_adr (
  recette_id TEXT NOT NULL REFERENCES recettes(recette_id) ON DELETE CASCADE,
  adr_id     TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
  PRIMARY KEY (recette_id, adr_id)
);
CREATE INDEX IF NOT EXISTS idx_recette_adr_adr ON recette_adr(adr_id);
```
