# Plan — Session de migration des anciens sprints (par projet)

- **Tâche** : `T-20260921-091738-u76n` (exécution `E-T-20260921-091738-u76n-b59lk6`) — tâche 9/9 du batch `BATCH-mub1809u-06ow`
- **Projet** : `ecosystem`
- **Recette source** : `RECT-muaz100k-2iq0`
- **Date** : 2026-09-21 11:45:40
- **Dépendances (TERMINÉES)** : T1 (modèle SQL), T2 (pièces client), T3 (cycle sprint), T4 (`sprint_*`), T5 (`feature_*`/`rule_*` + liaisons + workflow ADR proposé→validé), T6 (cardinalités/émergence), T7 (panneau + onglets), T8 (agent session SPRINT + prompts alignés).

---

## 1. Objectif

Doter l'écosystème d'une **SESSION DE MIGRATION DES ANCIENS SPRINTS par projet** (type dédié, à l'image des sessions sprint/recette) permettant de : convertir **sans perte** les ADR monolithiques existantes en **plusieurs ADR atomiques** (détails en **pièces jointes** `adr_file`, **lien historique ADR d'origine ↔ ADR converties** conservé), rattacher **tous les éléments migrés** (pièces client, fonctionnalités, règles métier, ADR converties) à l'**ANCIEN SPRINT** (sprint par défaut du projet), associer les **anciennes tâches** (sprint / fonctionnalité / ADR) **sans jamais créer de faux émergents rétroactifs**, et fournir un **agent de migration** qui lit les documents existants, **propose le découpage** et n'écrit qu'**après validation utilisateur**.

## 2. Contexte & raison d'être

- **ADR-001** (`doc-mub10mo8-lgo3`, statut **Proposé**, projet `ecosystem`) §6 décide explicitement : « pour chaque projet, une SESSION DE MIGRATION des anciens sprints est lancée après les modifications (type dédié, panneau) : toutes les pièces/fonctionnalités/règles/ADR converties sont rattachées à l'ANCIEN SPRINT. Les documents ADR monolithiques actuels sont convertis en PLUSIEURS ADR ATOMIQUES avec les bonnes colonnes (titre, statut, contexte, décision, conséquences) ; les grands détails passent en PIÈCES JOINTES de l'ADR (via `adr_attach` → `adr_file`). Les ADR converties sont associées à 1..N fonctionnalités. Les anciennes tâches sont associées SANS être marquées émergentes. Le découpage est proposé par l'agent, validé par l'utilisateur. » Ce plan est l'implémentation directe de cette décision.
- **Constat réel (registre, lecture MCP)** : les documents ADR-12 existants sont des **blocs monolithiques** sans colonnes structurées :
  - `myxmax` → `doc-mu5hetkk-41ms` « ADR-000 — Architecture de l'écosystème myxmax » (`/var/lib/docker/volumes/coder-3c6440d6-867a-4909-9210-01b754326a13-home/_data/myxmax/docs/adr/ADR-000-architecture-ecosysteme-myxmax.md`), `status/context/decision/consequences = null` ;
  - `mada-talk` → `doc-mtq4xd2g-togu` « ADR — Architecture technique Madatalk (état réel) » (`.../mada-talk/docs/adr-architecture-madatalk.md`), colonnes `null` ;
  - `oniria` → `doc-mty5ccha-pxk5` « ADR-001 — Architecture extensible ONIRIA » (`.../oniria/docs/adr/ADR-001-architecture-extensible-oniria.md`), colonnes `null`.
  - Ces docs ont déjà été **requalifiés pièces client** (`meta.piece_client=true`, `requalified_from_doc_type=adr`) par T2 : la conversion ADR doit **préserver** ce marqueur et ne **jamais** réécrire `doc_type`/`content_id`/`path` (pas de perte).
- **Acquis T1–T8 réutilisés** : `ensureDefaultSprint`/`migrateExistingToDefaultSprint` (db.mjs l.974/l.1086), `setSprintSession` (l.1070), `registerAdr`/`getAdr`/`attachAdr` (l.4401/4331/4461), `addDocAttachment` (`adr_file`), `registerFeature`/`linkFeatureAdr`/`linkTaskFeature`/`proposeTaskAdr`+`validateTaskAdr` (T5), `classifyEmergence` (l.941), `attachPiecesToSprint` (l.879), patterns panneau `launchSprintSession` (pilot.mjs l.1145) / `buildSprintPrompt` (session-bridge.mjs l.381) / route `POST /api/sprints/:id/session` (server.mjs l.1917) / bouton `data-sp-session` (app.js l.4779).
- **Contraintes de non-régression** : ne pas casser le modèle ADR/`artifacts`, ni les sessions existantes (recette/sprint/batch/test), ni le cycle d'émergence. Toutes les nouvelles DDL sont **additives** (aucune colonne existante modifiée) ; les nouveaux tools sont **additifs**.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | créer (DDL) | table `adr_conversions` (+ index) dans `migrate()` + miroir `schema.sql` | `db.mjs` (fin de `migrate()`, avant l.659) | `db.mjs`, `schema.sql` | Conserver le **lien historique** ADR d'origine ↔ ADR converties (N converties pour 1 origine) | Table `adr_conversions(conversion_id, original_adr_id, converted_adr_id, created_at, created_by)` idempotente |
| A002 | créer (DDL) | table `migrations` (+ index unique `project`) dans `migrate()` + miroir `schema.sql` | `db.mjs` (fin de `migrate()`) | `db.mjs`, `schema.sql` | Porter l'entité « session de migration » d'un projet (type dédié, reprise) | Table `migrations(migration_id, project, sprint_id, session_id, status, title, organization_id, created_at, updated_at, finished_at, created_by)` |
| A003 | créer | `linkAdrConversion` + `listAdrConversions` + `rowToAdrConversion` | `db.mjs` (après `attachAdr`, ~l.4474) | `db.mjs` | Écrire/lire le lien de conversion avec gardes (ADR existantes, ≠, idempotent) | 2 primitives exportées + sérialiseur |
| A004 | créer | `convertAdr({ originalAdrId, title, status, context, decision, consequences, description, repoIds, global, attachments, by })` | `db.mjs` (après A003) | `db.mjs` | Créer **une** ADR atomique depuis un monolithe, la lier à l'origine, rattacher les détails en pièces jointes — **sans modifier l'original** | Primitive exportée : ADR atomique créée + lien `adr_conversions` + pièces jointes `adr_file` |
| A005 | créer | `startMigration` + `getMigration` + `listMigrations` + `rowToMigration` | `db.mjs` (après `migrateExistingToDefaultSprint`, ~l.1108) | `db.mjs` | Démarrer/résoudre la session de migration d'un projet, ancrée sur le **sprint par défaut** (ancien sprint), idempotente | 3 primitives exportées + sérialiseur ; `{ migration, sprint }` |
| A006 | créer | `setMigrationSession` + `finishMigration` | `db.mjs` (après A005) | `db.mjs` | Rattacher/reprendre la session IA dédiée (sans toucher au statut du sprint) et clôturer la migration | 2 primitives exportées |
| A007 | créer | `migrateProjectElementsToDefaultSprint({ projectId, title, startDate, endDate, createdBy })` | `db.mjs` (après `migrateExistingToDefaultSprint`) | `db.mjs` | Rattacher fonctionnalités (`sprint_fonctionnalites`), règles (`sprint_regles`) et pièces (`sprint_pieces`) sans lien sprint à l'ancien sprint, **sans jamais écrire `emergent`** | Primitive exportée retournant les compteurs par type |
| A008 | créer | tools `migration_start`, `migration_get`, `migration_list`, `migration_session_set`, `migration_finish`, `sprint_migrate_elements` | `index.mjs` (après la famille `sprint_*`, ~l.790) | `index.mjs` | Exposer au panneau et aux agents la session de migration + le rattachement ancien sprint | 6 tools MCP enregistrés |
| A009 | créer | tools `adr_convert`, `adr_conversion_link`, `adr_conversion_list` | `index.mjs` (dans la famille `adr_*`, ~l.1340) | `index.mjs` | Exposer la conversion ADR atomique + le lien historique | 3 tools MCP enregistrés |
| A010 | créer | agent `agent-migration` (frontmatter + corps) | — | `/root/.config/opencode/agent/agent-migration.md` | Agent accompagnant le remplissage : lecture des docs, **proposition de découpage**, **validation utilisateur avant écriture**, aucun faux émergent | Fichier agent créé (repo `agent`, branche `feature/per-plan`) |
| A011 | créer | `buildMigrationPrompt({ migrationId, project, repos, sprintId, title, startDate, endDate, pieces, docs, adrs, adrContext })` | `session-bridge.mjs` (après `buildSprintPrompt`, ~l.437) | `session-bridge.mjs` | Prompt d'ouverture de la session de migration (mission + cadre, jamais méthode) | Fonction exportée |
| A012 | créer | `startMigration`/`listMigrations`/`getMigration` (wrappers MCP) + `launchMigrationSession({ migrationId, force, adrIds })` | `pilot.mjs` (après `launchSprintSession`, ~l.1197) | `pilot.mjs` | Lancer/reprendre la session `agent-migration` depuis le panneau (anti-doublon, reprise par `session_id`) | Fonctions exportées |
| A013 | ajouter | routes `GET /api/migrations`, `POST /api/migrations`, `GET /api/migrations/:id`, `POST /api/migrations/:id/session` | `server.mjs` (après les routes sprints, ~l.1928) | `server.mjs` | Exposer la session de migration au panneau (miroir des routes sprints) | 4 routes HTTP |
| A014 | ajouter | bouton `data-mg-session` + `openMigrationSession` dans `renderSprints` | `public/app.js` (l.4768-4815) | `public/app.js` | Déclencher la session de migration par projet depuis le panneau, en affichant l'ancien sprint cible | Bouton + handler + modale d'état |
| A015 | créer | script CLI `migrate-old-sprints.mjs` | — | `/root/.config/opencode/scripts/migrate-old-sprints.mjs` | Exécuter/relancer la migration d'un projet (ou tous) : `migration_start` + `sprint_migrate_elements`, idempotent, sans émergent | Script CLI (miroir `requalify-pieces-client.mjs`) |

## 4. Fichiers concernés

| Fichier | Repo (branche) | Type de modification |
|---------|----------------|----------------------|
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | `opencode-mcp-task-orchestrator` (`feature/migration-postgresql`) | Modification (A001–A007) |
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | `opencode-mcp-task-orchestrator` | Modification (miroir DDL A001/A002) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | `opencode-mcp-task-orchestrator` | Modification (A008/A009) |
| `/root/.config/opencode/agent/agent-migration.md` | `agent` (`feature/per-plan`) | **Création** (A010) |
| `/root/orchestrator-panel/session-bridge.mjs` | `opencode-observability` (`feature/migration-postgresql`) | Modification (A011) |
| `/root/orchestrator-panel/pilot.mjs` | `opencode-observability` | Modification (A012) |
| `/root/orchestrator-panel/server.mjs` | `opencode-observability` | Modification (A013) |
| `/root/orchestrator-panel/public/app.js` | `opencode-observability` | Modification (A014) |
| `/root/.config/opencode/scripts/migrate-old-sprints.mjs` | `opencode-scripts` (`main`) | **Création** (A015) |

## 5. Livrables attendus

1. **Tables additives** `adr_conversions` et `migrations` (migrate() + miroir `schema.sql`), idempotentes, sur base existante comme neuve.
2. **Primitives registre** : `linkAdrConversion`, `listAdrConversions`, `convertAdr`, `startMigration`, `getMigration`, `listMigrations`, `setMigrationSession`, `finishMigration`, `migrateProjectElementsToDefaultSprint`.
3. **Tools MCP** : `migration_start`, `migration_get`, `migration_list`, `migration_session_set`, `migration_finish`, `sprint_migrate_elements`, `adr_convert`, `adr_conversion_link`, `adr_conversion_list`.
4. **Agent `agent-migration`** : lit les docs ADR monolithiques + pièces client, propose un découpage atomique (titre/statut/contexte/décision/conséquences), n'écrit qu'après validation utilisateur, détaille en pièces jointes, associe chaque ADR convertie à 1..N fonctionnalités, rattache à l'ancien sprint, associe les anciennes tâches **sans** marquer émergent.
5. **Panneau** : `buildMigrationPrompt`, `launchMigrationSession`, routes `/api/migrations*`, bouton « Session de migration » (par projet, avec sprint cible = ancien sprint).
6. **CLI** `migrate-old-sprints.mjs` : migration/relance par projet (`--project <id>` / `--all`), idempotente.
7. **Garanties** : conversion **sans perte** (original intact, `path`/`meta`/liens préservés), lien historique `adr_conversions` conservé, **aucun faux émergent** (aucune écriture `emergent`/`emergent_origin` dans les chemins de migration).

## 6. Ordre & dépendances

```
A001 ─┬─────────────────────────────┐
A002 ─┼─────────────────────────────┼──────────────┐
      │                             │              │
A003 ─┴→ A004 ─────────────┐        │              │
A005 ─────→ A006 ──────────┼──→ A008 ──→ A015     │
A007 ──────────────────────┘        │              │
A004 ─────────────────────────────→ A009 ──→ A010 ─┘
                                     A008 + A010 ──→ A011 ──→ A012 ──→ A013 ──→ A014
```

- **A001, A002** : indépendantes (DDL additive). À livrer en premier.
- **A003 → A004** : `convertAdr` appelle `linkAdrConversion` et `registerAdr` (A004 exige A003).
- **A005 → A006** : `setMigrationSession`/`finishMigration` opèrent sur la ligne créée par `startMigration`.
- **A007** : réutilise `ensureDefaultSprint` (T3) ; indépendante de A003–A006 mais doit précéder A008.
- **A008** : dépend de A005, A006, A007. **A009** : dépend de A003, A004.
- **A010** : dépend de A008 + A009 (l'agent cite les tools `migration_*`, `adr_convert`, `sprint_migrate_elements`).
- **A011 → A012 → A013 → A014** : chaîne panneau ; A011 dépend de A010 (nom d'agent) et A008 ; A012 dépend de A011 + A008.
- **A015** : dépend de A008 (tools MCP).
- **Contrainte d'ordre inter-repos** : livrer `opencode-mcp-task-orchestrator` (A001–A009) **avant** `opencode-observability` (A011–A014) et `opencode-scripts` (A015) ; l'agent (A010) après A009.

## 7. Couverture des objectifs

| Exigence (mission / critères d'acceptation) | Étape(s) | Couvert ? |
|---|---|---|
| Session de migration par projet, **type dédié** à l'image des sessions sprint/recette | A002, A005, A006, A008, A010, A011, A012, A013, A014 | Oui |
| Lancement **depuis le panneau** | A013, A014 | Oui |
| Tous les éléments migrés (pièces client, fonctionnalités, règles métier, ADR converties) rattachés à l'**ANCIEN SPRINT** (sprint par défaut : myxmax 14/09/2026, madatalk 07/09/2026) | A005 (`ensureDefaultSprint`), A007, A015 | Oui |
| **Conversion des ADR** monolithiques → PLUSIEURS petites ADR atomiques avec colonnes (titre, statut, contexte, décision, conséquences) | A004, A009, A010 | Oui |
| Grands détails → **PIÈCES JOINTES** de l'ADR (`adr_attach` → `adr_file`) | A004 (`attachments` via `registerAdr`/`addDocAttachment`), A010 (usage de `adr_attach`/`doc_attachment_add`) | Oui |
| **Sans perte** (original intact) + **lien historique** ADR d'origine ↔ ADR converties | A001, A003, A004 | Oui |
| Chaque ADR convertie **associée à 1..N fonctionnalités** | A010 (via `feature_adr_link`), A004 (signal de cardinalité `adr`) | Oui |
| Anciennes tâches associées (sprint / fonctionnalité / ADR) **SANS faux émergents** | A007 (`task_sprints`), A010 (via `task_feature_link`, `task_adr_propose`+`task_adr_validate`), A015 | Oui |
| **Agent de migration** : lecture des docs existants, proposition de découpage, **validation utilisateur avant écriture** + prompt + déclenchement panneau | A010, A011, A012, A013, A014 | Oui |
| Ne pas casser le modèle ADR/`artifacts` ni les sessions existantes | A001/A002 (DDL additive), A004 (ne modifie pas l'original), A006/A013 (miroirs des patterns existants) | Oui |

## 8. Vérification de cohérence

**Intra-plan (Phases 6–7) — résultat : `Valid`.**

1. **Actions contradictoires sur un même élément** : aucune. Aucune étape `supprimer`/`renommer`/`déplacer` n'est présente ; toutes sont `créer`/`ajouter`/`modifier` sur des éléments **distincts** (tables, primitives, tools, fonctions panneau, agent, script).
2. **`créer` + `renommer` sur un élément neuf** : aucun cas (A003–A007 créent des primitives distinctes ; A008/A009 des tools distincts).
3. **Lecture d'un élément créé par une étape ultérieure** : aucun cas — l'ordre A001→A015 respecte les dépendances (A004 après A003 ; A006 après A005 ; A008 après A005/A006/A007 ; A009 après A003/A004 ; A010 après A008/A009 ; A012 après A011 ; A013 après A012 ; A014 après A013).
4. **Cible unique par étape** : chaque étape cible **un** élément dans **un** fichier (A001/A002 : 1 table chacune, avec miroir `schema.sql` explicitement listé ; A007 : 1 primitive).
5. **Risque d'émergence rétroactive** : A007 utilise des `INSERT ... ON CONFLICT DO NOTHING` directs dans `sprint_fonctionnalites`/`sprint_regles`/`sprint_pieces`/`task_sprints` — **interdiction explicite d'appeler `attachPiecesToSprint`** (qui écrit `meta.emergent`) et **interdiction d'écrire** `fonctionnalites.emergent`, `regles_metier.emergent`, `tasks.emergent`. Aucune étape n'appelle `classifyEmergence` dans un chemin de migration.
6. **Non-régression ADR** : A004 ne réécrit ni `doc_type`, ni `content_id`, ni `path`, ni `meta` de l'ADR d'origine ; il crée une **nouvelle** ligne `artifacts` (via `registerAdr`) et une ligne `adr_conversions`. Le trigger T1 `trg_fonctionnalite_adr_min` (ADR → ≥1 fonctionnalité) est respecté : A010 lie chaque ADR convertie à ≥1 fonctionnalité avant toute fin de session (le signal de cardinalité A004 est non bloquant).
7. **Sessions existantes** : A006 calque `setSprintSession` (ne touche pas au statut du sprint) ; A013 calque les routes sprints ; aucune route/fonction existante n'est modifiée.

**Globale (Phase 9)** : plan unique pour cette tâche (objectifs interdépendants : la session de migration consomme les primitives de conversion). Pas de conflit inter-plans (les autres tâches du batch sont terminées et mergées : `5b6eb76` MCP, `6dc7648` panneau, `512d1b6` agent).

## 9. E2E — analyse d'impact (cadrage 08)

**E2E : NA.** La tâche porte sur de l'**outillage interne** (registre MCP + panneau de pilotage + agent), sans comportement utilisateur observable couvert par un spec Playwright. Vérifié : `e2e_list({ project: "ecosystem" })` → **0 test**. Aucun spec Playwright n'existe pour les repos `opencode-mcp-task-orchestrator` / `opencode-observability` / `opencode-scripts`. Aucun test E2E n'est créé ni lié. La validation est fonctionnelle (appels MCP + parcours panneau) et humaine, conformément à l'acceptation de la tâche.

## 10. Risques & notes

- **R1 — Faux émergents rétroactifs** (risque majeur, critère d'acceptation) : neutralisé par A007 (INSERT directs sans écriture `emergent`) + consigne explicite dans `agent-migration.md` (A010). Contrôle de recette : après migration, `cardinality_report({ projectId })` ne doit produire **aucun** signal d'émergence nouveau sur les éléments hérités.
- **R2 — Perte de contenu lors du découpage ADR** : neutralisé par A004 (création additive, original intact) + `adr_conversions` (A001/A003) + A010 (le détail va en pièce jointe `adr_file`, jamais supprimé). Contrôle : chaque ADR d'origine doit avoir ≥1 ligne `adr_conversions`.
- **R3 — `registerAdr` exige `projectId`** : A004 résout le projet depuis l'ADR d'origine (`getDoc(adrId).projects[0]`, repli `artifact_projects`) et lève une erreur explicite si aucun projet — à documenter dans la description du tool (A009).
- **R4 — Trigger T1 « ADR → ≥1 fonctionnalité »** : une ADR convertie non encore associée à une fonctionnalité ne peut pas perdre son dernier lien ; A010 doit lier chaque ADR convertie à ≥1 fonctionnalité. Le lien est posé dans la **même** session (validation utilisateur), le signal de cardinalité A004 reste informatif.
- **R5 — Agents hors repos déclarés** : `agent-migration.md` vit dans le repo `agent` (`/root/.config/opencode/agent`, branche `feature/per-plan`), non listé dans `task.repos` mais déjà utilisé par T8 (`512d1b6`) — branche dédiée requise (norme d'isolation v1.0).
- **R6 — Projet `myxmax` sans `gitPath`** : `projectAnchorDir` (pilot.mjs l.360) retombe sur `repo_list` (repos `myxmax`, `admin-myxmax`, …) ; A012 doit gérer `dir = null` (repli sur l'ancre du projet ou message d'erreur explicite) comme le font `launchSprintSession`/`launchRecetteSession`.
- **R7 — Exécution de la migration des données** : ce plan livre la **capacité** (agent + tools + panneau + CLI). L'exécution réelle pour `myxmax` / `mada-talk` / `oniria` se fait via la session `agent-migration` (validation utilisateur obligatoire à chaque découpage) et/ou le CLI A015 — elle n'est pas autonome par construction (gouvernance ADR).
