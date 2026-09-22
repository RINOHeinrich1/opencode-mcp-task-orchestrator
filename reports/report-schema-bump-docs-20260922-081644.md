# Rapport — T-20260922-075536-rj8g (exécution directe `build-notify`)

- **Tâche** : `T-20260922-075536-rj8g`
- **Exécution** : `E-T-20260922-075536-rj8g-oj9fd2` (tentative 1)
- **Projet** : `ecosystem`
- **Agent** : `build-notify`
- **Date** : 2026-09-22 08:16 (host)

## Résumé

Deux volets demandés, exécutés en **exécution directe** (sans plan) :

1. **Bump `SCHEMA_VERSION`** dans le repo MCP `task-orchestrator` (`db.mjs` ~l.33),
   en cohérence avec le commit `f45c4ff` (alignement de `schema.sql` sur
   `migrate()`) qui n'avait pas incrémenté le marqueur. Seule la constante a été
   modifiée. Rejeu vérifié : apply complet une fois, puis chemin rapide, idempotent.
2. **Mise à jour de la documentation** du repo panneau (`orchestrator-panel`,
   `public/docs/`) : modèle Sprint / Fonctionnalités / Règles, familles d'outils
   MCP, état réel du panneau, cycle de vie / émergence / cardinalités / sessions,
   + CHANGELOG daté. Documentation **vérifiée dans le code** (db.mjs, index.mjs,
   schema.sql, public/app.js) — rien d'inventé.

## Isolation (norme v1.0)

- Les **deux repos sont des composants d'infrastructure** (serveur MCP
  `task-orchestrator` et panneau `orchestrator-panel`) hébergés sur la machine,
  **absents de tout workspace Coder** (`workspace_list`). La tâche désigne
  explicitement ces chemins hôte → traitement sur l'hôte **assumé et documenté**.
- **session-guard** exécuté sur chaque git root → **code de sortie 0**, mode
  `in-place` (aucune autre session en parallèle) :
  - `/root/.config/opencode/mcp/task-orchestrator` → branche `feature/migration-postgresql`
  - `/root/orchestrator-panel` → branche `feature/migration-postgresql`
- Pas de worktree dédié (in-place) ; verrous libérés en fin de traitement.

## Branches et commits

| Repo | Branche | Base (avant) | Commit (après) |
|---|---|---|---|
| `opencode-mcp-task-orchestrator` | `feature/migration-postgresql` | `f45c4ff` | `257f6f5` — `fix(db): bump SCHEMA_VERSION -> 2026-09-22-schema-sql-align-migrate (aligne le marqueur sur schema.sql/migrate, T-20260922-075536-rj8g)` |
| `opencode-observability` (panneau) | `feature/migration-postgresql` | `333da29` | `7b103cc` — `docs: modèle sprint/fonctionnalités/règles, familles d'outils MCP, état réel du panneau + CHANGELOG (T-20260922-075536-rj8g)` |

- `git fetch origin` : les deux repos étaient **0 en retard / 1 en avance** →
  push **fast-forward** direct sur `feature/migration-postgresql` (branche
  principale configurée au registre). Aucun rebase nécessaire.
- Push effectués : `f45c4ff..257f6f5` (MCP) et `333da29..7b103cc` (panneau).

## Traitements effectués

### Volet 1 — Bump `SCHEMA_VERSION`

1. Constante modifiée : `"2026-09-22-recette-regles-contexte"` →
   **`"2026-09-22-schema-sql-align-migrate"`** (seule la ligne 33 a changé).
2. `node --check db.mjs` → **OK**.
3. **Marqueur AVANT** (base `task_registry`, `schema_meta.schema_version`) :
   `2026-09-22-recette-regles-contexte`.
4. Déclenchement `ensureSchema()` via une fonction exportée read-only
   (`listProjectSprints`) :
   - **1er appel : 455 ms** → apply complet (`schema.sql` + `migrate()` sous
     `pg_advisory_lock`) + écriture du nouveau marqueur.
   - **2e appel : 123 ms**, **3e appel : 114 ms** → **chemin rapide** (aucun DDL ;
     le temps résiduel = démarrage process + imports).
5. **Marqueur APRÈS** : `2026-09-22-schema-sql-align-migrate`
   (`updated_at` = 2026-09-22T08:14:06.882Z).
6. Objets vérifiés présents en base (alignement `schema.sql`/`migrate()` effectif) :
   - `task_adr` colonnes : `adr_id, proposed_at, proposed_by, reason, status,
     task_id, validated_at, validated_by` + index `idx_task_adr_status` ;
   - table `cardinality_signals` + index partiel unique
     `idx_cardinality_signals_open_entity` ;
   - tables structurées présentes : `sprints`, `fonctionnalites`, `regles_metier`,
     `recette_regles`, `migrations`, `adr_conversions`, `schema_meta`.
7. Idempotence confirmée (rejeux sans effet de bord, marqueur inchangé).

### Volet 2 — Documentation (`public/docs/`)

Faits **lus dans le code** : `db.mjs` (DDL `migrate()`, `SCHEMA_VERSION`,
`ensureSchema`), `schema.sql` (tables/colonnes/index/triggers), `index.mjs`
(noms d'outils MCP via `registerTool`), `public/app.js` (`GLOBAL_TABS`,
`PROJECT_TABS`, `CARDINALITY_CARDS`, `frSubTab`, filtres `fr-*`, sélecteurs
`rm-adr/feature/rule-pick`, modale `projectDetailModal`).

- **`05-reference.md`** : ajout de `schema_meta` au modèle + nouvelle sous-section
  **« Modèle structuré Sprints / Fonctionnalités / Règles (ADR-001) »** (`sprints`,
  `fonctionnalites` + `implemented*`, `regles_metier` + `roles`/`role_global`,
  `cardinality_signals`, `migrations`, `adr_conversions`, `recette_regles`,
  `task_adr.*`, tables de liens N:N) + note `SCHEMA_VERSION` ; nouvelle section
  **§1bis « Familles d'outils MCP »** (`sprint_*`, `feature_*`, `rule_*`,
  `migration_*`, `adr_conversion_*`, `cardinality_*`, `recette_rule_link`/`unlink`,
  `feature_context`/`rule_context`, `*_delete`, `*_mark_implemented`). Versions FR
  **et** EN.
- **`02-composants.md`** : onglets projet mis à jour (Sprints, Fonctionnalités &
  Règles) ; Vue d'ensemble = **cartes de cardinalité cliquables** (10 vues) et
  **onglet « Émergents » retiré** ; Fonctionnalités & Règles en **2 sous-onglets**
  avec filtres (rôle/sprint/émergence/implémentation/lien) ; modale **Détail projet
  = Projet/Repos/Pièces client** (sans « Documents de référence ») ; **sélecteurs
  de contexte** en création de recette (ADR + Fonctionnalités + Règles) ; §4 registre
  (tables + familles MCP). FR + EN.
- **`03-workflow.md`** : nouvelle section **§1ter** (cycle de vie sprint — durée
  paramétrable, clôture auto à l'échéance, reprise ; émergence **tracée, jamais
  rétroactive** ; cardinalités heuristiques **non bloquantes** ; lien ADR de tâche
  **proposé → validé** ; sessions **sprint** / **migration**) + contexte de la
  recette (ADR + Fonctionnalités + Règles) dans §1bis. FR + EN.
- **`CHANGELOG.md`** : entrée datée **2026-09-22** résumant les deux volets.
- **`12-documents-reference-projets-repos.md`** : §3 (contexte test = sélecteur ADR ;
  contexte recette = ADR + Fonctionnalités + Règles) et §5 (modale projet sans
  onglet « Documents de référence ») mis en cohérence avec le code.
- **`13-adr-et-artefacts.md`** : `PROJECT_TABS` complété (Sprints, Fonctionnalités
  & Règles) + mention de la modale Détail projet (Projet/Repos/Pièces client).

## Fichiers modifiés / créés

**Repo `opencode-mcp-task-orchestrator`** :
- `db.mjs` (constante `SCHEMA_VERSION`) — modifié
- `reports/report-schema-bump-docs-20260922-081644.md` — créé (ce rapport)

**Repo `opencode-observability` (panneau)** :
- `public/docs/05-reference.md` — modifié
- `public/docs/02-composants.md` — modifié
- `public/docs/03-workflow.md` — modifié
- `public/docs/12-documents-reference-projets-repos.md` — modifié
- `public/docs/13-adr-et-artefacts.md` — modifié
- `public/docs/CHANGELOG.md` — modifié

## Avertissements / erreurs

- **Hôte vs Coder** : les deux repos cibles ne sont pas dans un workspace Coder
  (composants d'infrastructure) — traitement sur l'hôte, conforme à la demande
  explicite (documenté ci-dessus).
- **Temps de « chemin rapide »** (~120 ms) : il inclut le démarrage process et les
  imports (`pg`, `better-sqlite3`, `load-env`) ; la différence 455 ms → ~120 ms
  atteste que le DDL n'est pas rejoué.
- **PM2 non redémarré** (contrainte respectée). Aucun incident, aucune incohérence
  détectée pendant le traitement.
- Le bump de `SCHEMA_VERSION` **n'a pas** modifié `migrate()`, `schema.sql` ni de DDL
  (contrainte respectée).

## Prochaines étapes / recommandations

- La valeur `SCHEMA_VERSION` est désormais alignée sur l'état DDL ; les prochains
  changements de `schema.sql`/`migrate()` devront **incrémenter** le marqueur
  (convention `AAAA-MM-JJ-<description>`), comme documenté dans `05-reference.md`.
- Recette : la tâche est `emergent` / `sans_fonctionnalite` (traçage, non bloquant) —
  rattachement fonctionnalité/sprint à décider en recette humaine.
