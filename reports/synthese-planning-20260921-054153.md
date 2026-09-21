# Synthèse de planification — `T-20260920-162800-aov1`

- **Tâche** : `T-20260920-162800-aov1` (executionId `E-T-20260920-162800-aov1-inpw4z`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 7/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` — item 126
- **Agent** : `atomic-plan`
- **Date** : 2026-09-21 05:42

## 1. Objectifs identifiés

Un **seul objectif** cohérent et borné (les 5 volets de l'item 126 sont **interdépendants** :
le signalement alimente la vigilance, la vigilance bloque la terminaison, l'historique expose les
signalements, le test-agent partage le même mécanisme) → **un plan unique**.

## 2. Plans générés

| Plan ID | Objectif | Fichier | Étapes | Statut |
|---------|----------|---------|--------|--------|
| `Plan-adr-gouvernance-recette-20260921-054153` | Gouvernance des ADR en recette/test (ADR manquantes + conflits, vigilance globale, blocage `recette_confirm`, historique filtrable append-only, capacités test-agent) | `plans/Plan-adr-gouvernance-recette-20260921-054153.md` | 26 (A001-A026) | Valid |

**Persistance** : enregistré en base via `plan_register` (source de vérité) —
`rootPath=/root/.config/opencode/mcp/task-orchestrator`, `taskId=T-20260920-162800-aov1`.
**Artefact** : `ART-T-20260920-162800-aov1-muatjpp2-5pxw` (kind=plan).

## 3. Résumé du plan

### Bloc 1 — Registre MCP (`schema.sql`, `db.mjs`, `index.mjs`)
- **A001-A002** : nouvelle table **`adr_vigilances`** (append-only) + index, dans `schema.sql` **et** `migrate()` (bases PostgreSQL existantes) — même pattern que `adr_conflicts` (item 125).
- **A003-A006** : helpers/types (`ADR_VIGILANCE_TYPES`/`_STATUS`, `adrVigilanceReason`, `insertAdrVigilance`) + `reportAdrMissing` (ADR manquante), `listAdrVigilances` (historique filtrable), `resolveAdrVigilance` (levée tracée).
- **A007** : `reportAdrConflict` **étendu** (`recetteId?`) → crée aussi une vigilance `conflict` liée à `adr_conflicts`.
- **A008** : **garde de terminaison** dans `confirmRecette` — refus avec raisons explicites tant qu'un point est ouvert.
- **A009-A010** : `getRecetteById.adrVigilances` ; clôture des vigilancess d'un conflit à la résolution de la décision humaine.
- **A011-A016** : imports + tools `adr_report_missing`, `adr_vigilance_list`, `adr_vigilance_resolve`, `adr_report_conflict(recetteId)` + descriptions `recette_confirm`/`recette_get`.

### Bloc 2 — Panneau (`pilot.mjs`, `server.mjs`, `public/app.js`, `public/style.css`)
- **A017-A018** : wrappers + **pré-check `finishRecette`** (blocage AVANT création de tâches → pas de tâche orpheline).
- **A019-A020** : routes `GET /api/adr-vigilances` (filtrable) + `POST /api/adr-vigilances/:id/resolve` ; compteur/liste sur les recettes.
- **A021-A024** : **historique filtrable append-only dans la vue d'ensemble** (`renderOverview`), blocage explicite dans la modale « Terminer la recette », badge sur la carte de recette, styles.

### Bloc 3 — Agents (`agent-recette.md`, `test-agent.md`)
- **A025-A026** : sections « Gouvernance des ADR » (signaler une ADR manquante, proposer sa création en **Proposé**, signaler un conflit + proposer la dépréciation, lever via `adr_vigilance_resolve`).

## 4. Vérifications de cohérence

- **Intra-plan (Phases 5-7)** : couverture 100 % de l'objectif (table §7 du plan) ; **aucune contradiction** (pas de `supprimer`+`modifier` sur le même élément, pas de double écriture de `confirmRecette`) ; toutes les étapes sont atomiques (élément × fichier × verbe). **Résultat : `Valid`.**
- **Globale (Phase 9)** : rétrocompat avec l'item 125 (`adr_*`/`adr_conflicts` réutilisés, `adr_report_conflict` étendu par param **optionnel**) ; régions disjointes sur le panneau et les prompts ; cohérent avec l'item 127 (fusion `artifacts`, `adr_vigilances` = table de suivi, pas un doc). **Aucune incohérence globale bloquante.**

## 5. Points de vigilance traités

| Vigilance item 126 | Traitement dans le plan |
|--------------------|-------------------------|
| Ne pas confondre point de vigilance globale bloquant et simple commentaire | Table dédiée `adr_vigilances` + `type`/`status` ; seul `status='open'` bloque (A008) |
| Création ADR depuis session = statut **Proposé** | Consigne prompts A025/A026 + `adr_register` défaut Proposé (item 125) |
| Historique **append-only** | Aucun DELETE exposé ; seul `status` transite (A001/A005/A021) |
| Blocage non infini | Deux canaux de levée : `adr_vigilance_resolve` (raison obligatoire) et décision humaine (A010) |
| Éviter les fausses alertes | `entity` + `description` + contexte requis (A004) ; consigne « entités réellement discutées » |
| Rétrocompat `doc_*` | Aucune modification de `listDocs`/`doc_*` ; INC-011 laissé intact |
| Pas de tâche orpheline | Pré-check `finishRecette` avant création (A018) |

## 6. E2E

**E2E : NA** — `e2e_list(project="ecosystem")` → `count: 0`, aucun `e2eRepoDir`/`e2eBaseUrl` sur les repos
concernés ; vérification manuelle (panneau sans CI) + appels MCP.
