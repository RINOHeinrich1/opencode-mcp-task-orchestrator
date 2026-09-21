# Plan — État d'implémentation d'une Fonctionnalité / Règle métier avec ORIGINE (« dans l'écosystème » vs « hors écosystème »)

- **taskId** : `T-20260921-133134-yz2i` (exécution `E-T-20260921-133134-yz2i-lzlkih`)
- **Projet** : `ecosystem`
- **Repos** (hôtes, pas de workspace Coder) :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (branche de déploiement `feature/migration-postgresql`)
  - `opencode-observability` = `/root/orchestrator-panel` (branche de déploiement `feature/migration-postgresql`)
- **Branche de travail** : dédiée par repo (via session-guard), basée sur `feature/migration-postgresql`. **Jamais** de modification directe de la branche principale.
- **Périmètre réservé (scope)** : `schema.sql`, `db.mjs`, `index.mjs` (repo registre) ; `public/app.js`, `pilot.mjs`, `server.mjs` (repo panneau).
- **Racine des plans** : `/root/.config/opencode/mcp/task-orchestrator`
- **Tâche liée (source)** : `T-20260921-091731-d1af` — « Objet SPRINT de premier niveau … rapport de sprint » (relation `emergent`). **Nature de la liaison** : c'est là qu'a été livré `buildSprintReport` + le tool `sprint_report` (commit `8d77d01`) ; c'est ce rapport qui affiche « Fonctionnalités 45 — 0 implémentée(s) » / « Règles métier 10 » sur le sprint myxmax `SPRINT-mub8iyew-j6j8`. Le présent plan **étend** ce rapport (aucune réécriture de l'existant).
- **ADR** : `adr_list({ projectId: 'ecosystem' })` → **0 ADR active** sur ce périmètre dans le registre courant (l'ADR-001 « modèle sprint / fonctionnalités / règles » référencée par le plan T3 n'est plus résolue par `adr_get`). **Aucune ADR Accepté n'est contredite** ; le plan prolonge la sémantique actée en T3.
- **Date** : 2026-09-21 13:33:38

---

## 1. Objectif

Permettre de **qualifier une Fonctionnalité (`fonctionnalites`) et une Règle métier (`regles_metier`) comme IMPLÉMENTÉE**, en distinguant l'**origine** de l'implémentation — `ecosystem` (implémentée par une/des tâche(s) de l'écosystème, cas actuel : ≥1 tâche liée `done`) vs `hors_ecosystem` (implémentée **en dehors** de l'écosystème : devs via leur IDE / leurs propres agents IA, **aucune tâche écosystème liée**) — et de **restituer cette ventilation** dans le rapport de sprint, l'API MCP et le panneau, sans casser le calcul historique ni l'axe d'émergence.

## 2. Contexte & raison d'être

Le sprint myxmax `SPRINT-mub8iyew-j6j8` (45 fonctionnalités, 10 règles métier) affiche « 0 implémentée(s) » alors que des fonctionnalités/règles sont **réellement implémentées dans le code** des produits : elles l'ont été **hors écosystème** (avant/pendant la migration, par les devs dans leur IDE), donc **sans aucune tâche écosystème liée**.

Cause racine **vérifiée dans le code** :
1. `buildSprintReport` (db.mjs **l.1427**) définit `implemented: (Number(r.done_tasks) || 0) >= 1` — seule l'origine « écosystème » est représentable, et uniquement via le lien tâche↔fonctionnalité (`task_fonctionnalites`).
2. Les tables `fonctionnalites` (schema.sql **l.680-693**) et `regles_metier` (schema.sql **l.697-709**) n'ont **aucun** champ d'état d'implémentation ni d'origine.
3. Les règles métier ne sont comptées **que par émergence** : la requête `regles` (db.mjs **l.1447-1458**) ne calcule aucun `done_tasks` et `stats.regles` (l.1492) n'expose que `total`/`emergentes` ; le rapport n'a **aucune** section « Règles métier implémentées ».

Il manque donc : (a) un **état d'implémentation explicite** (+ traçabilité) sur les 2 tables ; (b) un **calcul de rapport** qui agrège l'état explicite **et** le signal écosystème, avec **ventilation E/H** ; (c) l'**exposition MCP** (écriture + lecture) ; (d) l'**UI panneau** (qualification, badge, filtre) ; (e) la possibilité pour les **agents migration/sprint** de **proposer** la qualification `hors_ecosystem` des éléments pré-existants (validation utilisateur avant écriture).

### Décisions de conception tranchées (à respecter par l'exécution)

1. **Modèle additif, idempotent, rétrocompatible.** 5 colonnes ajoutées **à l'identique** sur `fonctionnalites` ET `regles_metier` : `implemented INTEGER NOT NULL DEFAULT 0`, `implemented_origin TEXT` (`ecosystem` | `hors_ecosystem` | NULL), `implemented_at TEXT`, `implemented_by TEXT`, `implemented_note TEXT`. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` dans `migrate()` **et** miroir dans `schema.sql` (qui ne fait que `CREATE TABLE IF NOT EXISTS`). **Champs absents ⇒ `implemented=0` ⇒ comportement actuel inchangé.**
2. **Définition unique « implémentée »** : `implemented = (implemented === 1) OU (done_tasks >= 1)`.
   - `implementedOrigin` = `implemented_origin` **explicite** si `implemented=1` ; sinon `ecosystem` **dérivé** si `done_tasks >= 1` ; sinon `null`.
   - Le signal `done_tasks` reste la définition écosystème actuelle (≥1 tâche liée dont la **dernière** exécution est `done`).
3. **Règles métier — `done_tasks` dérivé (pas de table `task_regles`)** : il n'existe **aucun** lien tâche↔règle dans le schéma. On dérive donc le signal écosystème d'une règle **par transitivité** : `done_tasks` = nombre de tâches **distinctes** `done` liées à une fonctionnalité qui **porte** cette règle (`task_fonctionnalites` ⨝ `fonctionnalite_regles`). Une règle explicitement qualifiée `implemented=1` prime (origine explicite). *Conséquence assumée : une règle rattachée à une fonctionnalité explicitement `hors_ecosystem` n'est pas marquée implémentée « par ricochet » — elle doit être qualifiée elle-même (ou compter une tâche done).*
4. **Émergence = axe DISTINCT et INCHANGÉ.** `emergent` / `emergent_origin` ne sont **jamais** touchés par la qualification d'implémentation ; une fonctionnalité/règle peut être à la fois `implemented` et `emergent` ; le rapport conserve ses sections et statistiques d'émergence.
5. **API MCP — « et/ou » tranché : les DEUX.** `feature_update`/`rule_update` acceptent `implemented`, `implementedOrigin`, `implementedNote` (source de vérité, validation incluse) **et** deux tools dédiés `feature_mark_implemented`/`rule_mark_implemented` (intention explicite pour les agents). Lecture exposée par `feature_get`/`feature_list`/`rule_get`/`rule_list` via la sérialisation camelCase existante.
6. **Règles de validation d'écriture** : `implementedOrigin` fourni ⇒ `implemented` forcé à `1` et origine **requise** ∈ `{ecosystem, hors_ecosystem}` (toute autre valeur → erreur) ; `implemented=false` ⇒ **reset** de `implemented_origin`/`implemented_at`/`implemented_by`/`implemented_note` ; à la qualification, `implemented_at = nowIso()` et `implemented_by = by ?? null`. **Idempotent** (re-qualifier écrase proprement).
7. **Panneau — réutilisation maximale des routes existantes** : la qualification passe par `PUT /api/features/:id` et `PUT /api/rules/:id` (aucune nouvelle route, aucun nouveau tool côté panneau) ; le **filtre d'implémentation** est **client** (comme les filtres existants `emergent`/`link`), et le **rapport téléchargeable** reflète la ventilation **sans modification** (server.mjs **l.1895-1912** proxifie le markdown du registre).
8. **Agents migration/sprint — proposition, jamais écriture silencieuse** : l'agent **propose** `hors_ecosystem` pour les éléments **pré-existants**, l'**utilisateur valide** (panneau ou confirmation explicite) avant écriture, et l'élément hérité **reste NON émergent**.
9. **Ne pas casser T1-T9** : aucune table supprimée, aucune signature existante modifiée (ajouts optionnels uniquement), `node --check` + spawn MCP réel en vérification.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|---|---|---|---|---|---|---|
| A001 | ajouter | table `fonctionnalites` (l.680-693) : colonnes `implemented INTEGER NOT NULL DEFAULT 0`, `implemented_origin TEXT`, `implemented_at TEXT`, `implemented_by TEXT`, `implemented_note TEXT` | `schema.sql` | `schema.sql` | Porter l'état d'implémentation + origine + traçabilité sur la fonctionnalité | DDL miroir `fonctionnalites` étendue |
| A002 | ajouter | table `regles_metier` (l.697-709) : les 5 mêmes colonnes | `schema.sql` | `schema.sql` | Même état d'implémentation pour la règle métier | DDL miroir `regles_metier` étendue |
| A003 | ajouter | `migrate()` — bloc T1 (après l.519-520, colonnes `tasks.emergent`) : 5 × `ALTER TABLE fonctionnalites ADD COLUMN IF NOT EXISTS …` | `db.mjs` | `db.mjs` | Appliquer le modèle aux bases **existantes** (idempotent) | Base migrée sans recréation |
| A004 | ajouter | `migrate()` — 5 × `ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS …` | `db.mjs` | `db.mjs` | Idem pour les règles | Base migrée sans recréation |
| A005 | modifier | `rowToFonctionnalite(r)` (l.1548-1563) : exposer `implemented` (bool), `implementedOrigin`, `implementedAt`, `implementedBy`, `implementedNote` | `db.mjs` | `db.mjs` | Lecture camelCase des nouveaux champs (`feature_get`/`feature_list`) | Champs exposés en lecture |
| A006 | modifier | `rowToRegle(r)` (l.1566-1580) : exposer les 5 mêmes champs | `db.mjs` | `db.mjs` | Lecture camelCase (`rule_get`/`rule_list`) | Champs exposés en lecture |
| A007 | créer | `applyImplementationQualification({ table, id, implemented, origin, note, by })` — helper **interne** : valide `origin ∈ {ecosystem, hors_ecosystem}` (requis si `implemented`), force `implemented=1` si `origin` fourni, pose `implemented_at=nowIso()`/`implemented_by`, `implemented=false` ⇒ reset des 4 champs, écrit `updated_at` ; **idempotent** | `db.mjs` (après `updateFeature`) | `db.mjs` | **Une seule** logique de validation/écriture pour les 2 tables et les 4 points d'entrée | Helper interne unique, testé par les deux chemins |
| A008 | modifier | `updateFeature(...)` (l.1650-1691) : brancher `implemented`/`implementedOrigin`/`implementedNote` sur `applyImplementationQualification` ; si **seuls** ces champs sont fournis → retourner `getFeature` **sans** second `UPDATE` (`updated_at` posé par le helper) | `db.mjs` | `db.mjs` | Qualification via le chemin d'édition existant (panneau + agents) | `feature_update` qualifie |
| A009 | modifier | `updateRule(...)` (l.1809-1849) : idem A008 | `db.mjs` | `db.mjs` | Qualification des règles | `rule_update` qualifie |
| A010 | créer | `markFeatureImplemented({ featureId, origin, note, by })` exporté — wrapper idempotent sur `applyImplementationQualification` (`implemented=true`, `origin` requis) | `db.mjs` (après `updateFeature`) | `db.mjs` | Intention explicite « marquer implémentée » pour les agents | `markFeatureImplemented` exporté |
| A011 | créer | `markRuleImplemented({ ruleId, origin, note, by })` exporté — idem A010 | `db.mjs` (après `updateRule`) | `db.mjs` | Idem pour les règles | `markRuleImplemented` exporté |
| A012 | modifier | requête `feats` de `buildSprintReport` (l.1405-1428) : mapper `implemented = !!r.implemented \|\| doneTasks >= 1`, `implementedOrigin = r.implemented ? r.implemented_origin : (doneTasks >= 1 ? 'ecosystem' : null)`, `implementedAt`, `implementedBy`, `implementedNote` | `db.mjs` | `db.mjs` | **Définition « implémentée » = état explicite OU ≥1 tâche done** | Fonctionnalités qualifiées prises en compte |
| A013 | modifier | requête `regles` de `buildSprintReport` (l.1447-1458) : calculer `done_tasks` (COUNT DISTINCT tâches `done` via `task_fonctionnalites` ⨝ `fonctionnalite_regles`, dernière exécution `done`) puis mapper `implemented`/`implementedOrigin`/`implementedAt`/`implementedBy`/`implementedNote` (décision §2.3) | `db.mjs` | `db.mjs` | Les règles ne sont aujourd'hui comptées **que par émergence** | Règles implémentées calculées |
| A014 | modifier | `sections` de `buildSprintReport` (l.1477-1487) : ajouter `reglesImplementees: regles.filter((r) => r.implemented)` (les sections existantes restent) | `db.mjs` | `db.mjs` | **Nouvelle section « Règles métier implémentées »** | Section présente dans `sections` |
| A015 | modifier | `stats` de `buildSprintReport` (l.1489-1495) : `fonctionnalites.{implementees, implementeesEcosystem, implementeesHorsEcosystem, emergentes}` et `regles.{total, implementees, implementeesEcosystem, implementeesHorsEcosystem, emergentes}` | `db.mjs` | `db.mjs` | Ventilation **E/H** exploitable (JSON + panneau) | Stats ventilées |
| A016 | modifier | markdown de synthèse (l.1510 et l.1512) : lignes « Fonctionnalités » et « Règles métier » au format `N implémentée(s) — dont E dans l'écosystème, H hors écosystème` | `db.mjs` | `db.mjs` | Restituer la ventilation dans le rapport **téléchargeable** | Rapport markdown ventilé |
| A017 | modifier | markdown `list(...)` (l.1523-1527) : formater les fonctionnalités/règles implémentées avec l'origine + note (`— implémentée (écosystème\|hors écosystème)…`) ; **ajouter** `list("Règles métier implémentées", sections.reglesImplementees, …)` avant/après la liste « Règles métier » | `db.mjs` | `db.mjs` | Section « Règles métier implémentées » effective + traçabilité lisible | Rapport complet |
| A018 | modifier | tool `feature_update` (l.928-943) : inputSchema `implemented` (bool), `implementedOrigin` (enum `ecosystem`\|`hors_ecosystem`), `implementedNote` ; passer à `updateFeature` ; description mise à jour | `index.mjs` | `index.mjs` | Qualification via le tool CRUD existant | `feature_update` qualifie |
| A019 | modifier | tool `rule_update` (l.988-1002) : idem A018 | `index.mjs` | `index.mjs` | Qualification des règles | `rule_update` qualifie |
| A020 | ajouter | tool `feature_mark_implemented` (bloc après `feature_update`, l.943) : `featureId`, `origin` (enum, requis), `note`, `by` → `markFeatureImplemented` | `index.mjs` | `index.mjs` | Intention explicite pour agents/panneau | Tool enregistré |
| A021 | ajouter | tool `rule_mark_implemented` (bloc après `rule_update`, l.1002) : idem A020 | `index.mjs` | `index.mjs` | Idem pour les règles | Tool enregistré |
| A022 | modifier | import `./db.mjs` (l.172-180, famille T5) : ajouter `markFeatureImplemented`, `markRuleImplemented` | `index.mjs` | `index.mjs` | Rendre les nouveaux helpers disponibles | Import complété |
| A023 | modifier | description du tool `sprint_report` (l.671) : remplacer « fonctionnalités implémentées (≥1 tâche liée dont la dernière exécution est `done`) » par « implémentées (`implemented=1` **ou** ≥1 tâche liée `done`), **ventilées** écosystème / hors écosystème ; section « Règles métier implémentées » » | `index.mjs` | `index.mjs` | Contrat du rapport exact | Description alignée |
| A024 | modifier | descriptions de `feature_get` (l.946) / `feature_list` (l.957) / `rule_get` (l.1005) / `rule_list` (l.1016) : mentionner les champs `implemented`/`implementedOrigin`/`implementedAt`/`implementedBy`/`implementedNote` exposés | `index.mjs` | `index.mjs` | Contrat de lecture explicite | Descriptions alignées |
| A025 | modifier | `pilot.updateFeature(args)` (l.822-832) : transmettre `implemented`, `implementedOrigin`, `implementedNote` au tool `feature_update` | `pilot.mjs` | `pilot.mjs` | Le panneau doit pouvoir écrire l'état | Pass-through complet |
| A026 | modifier | `pilot.updateRule(args)` (l.863-872) : idem A025 | `pilot.mjs` | `pilot.mjs` | Idem pour les règles | Pass-through complet |
| A027 | modifier | route `PUT /api/features/:id` (l.2011-2021) : passer `implemented`, `implementedOrigin`, `implementedNote` à `pilot.updateFeature` | `server.mjs` | `server.mjs` | Exposer la qualification à l'UI | Route étendue |
| A028 | modifier | route `PUT /api/rules/:id` (l.2051-2059) : idem A027 | `server.mjs` | `server.mjs` | Idem pour les règles | Route étendue |
| A029 | modifier | `frFeatureTableHtml` (l.5246-5262) : colonne « État » avec **badge** (`implémentée · écosystème` / `implémentée · hors écosystème` / `émergente` / `—`) + bouton `data-fr-impl` (qualifier) ; `colspan` du vide ajusté | `public/app.js` | `public/app.js` | Badge d'état + action de qualification dans le sous-onglet Fonctionnalités | Colonne état + action |
| A030 | modifier | `frRuleTableHtml` (l.5266-5282) : idem A029 + bouton `data-rule-impl` | `public/app.js` | `public/app.js` | Badge d'état + action dans le sous-onglet Règles métier | Colonne état + action |
| A031 | modifier | `frFeatureFilters` (l.4964) + `frFilterFeatures` (l.5203-5222) : ajouter la clé `impl` ∈ `'' \| 'yes' \| 'ecosystem' \| 'hors_ecosystem' \| 'no'` (filtre **client**) | `public/app.js` | `public/app.js` | **Filtre d'implémentation** (fonctionnalités) | Filtre fonctionnel |
| A032 | modifier | `frRuleFilters` (l.4965) + `frFilterRules` (l.5226-5242) : idem A031 | `public/app.js` | `public/app.js` | Filtre d'implémentation (règles) | Filtre fonctionnel |
| A033 | modifier | `renderFrFeaturePanel` (l.5288-5343) : `<select id="fr-f-impl">` (toutes / implémentées / écosystème / hors écosystème / non implémentées), reprise dans `rerender()`, + wiring des boutons `data-fr-impl` → `PUT /api/features/:id` puis `renderFeaturesRules()` | `public/app.js` | `public/app.js` | Qualification + filtre opérationnels | UI Fonctionnalités complète |
| A034 | modifier | `renderFrRulePanel` (l.5348-5395) : idem A033 (`fr-r-impl`, `data-rule-impl`, `PUT /api/rules/:id`) | `public/app.js` | `public/app.js` | Qualification + filtre opérationnels | UI Règles complète |
| A035 | modifier | `featureFormModal` (l.5026-5061) : champ `<select id="feat-impl">` (non implémentée / implémentée · écosystème / implémentée · hors écosystème) + `<input id="feat-impl-note">` ; envoyer `implemented`/`implementedOrigin`/`implementedNote` dans le body PUT/POST | `public/app.js` | `public/app.js` | Qualification à l'édition (avec motif) | Formulaire étendu |
| A036 | modifier | `ruleFormModal` (l.5063-5096) : idem A035 (`rule-impl`, `rule-impl-note`) | `public/app.js` | `public/app.js` | Idem pour les règles | Formulaire étendu |
| A037 | modifier | `featureDetailModal` (l.5098-5117) : afficher le **badge d'origine** + `implementedAt` / `implementedBy` / `implementedNote` (traçabilité) | `public/app.js` | `public/app.js` | Visibilité de l'origine et de la traçabilité | Détail enrichi |
| A038 | modifier | `ruleDetailModal` (l.5119-5133) : idem A037 | `public/app.js` | `public/app.js` | Idem pour les règles | Détail enrichi |
| A039 | modifier | `/root/.config/opencode/agent/agent-migration.md` : nouvelle section « Qualification d'implémentation des éléments hérités » — **proposer** `hors_ecosystem` via `feature_mark_implemented`/`rule_mark_implemented` (ou `feature_update`/`rule_update`), **validation utilisateur avant écriture**, **jamais** de marquage émergent | `agent-migration.md` (hors dépôt) | `agent-migration.md` | Livrable 5 : les éléments pré-existants cessent d'être « 0 implémentée » **sans** devenir émergents | Prompt agent mis à jour |
| A040 | modifier | `/root/.config/opencode/agent/agent-sprint.md` : idem A039 (la session de sprint peut **proposer** la qualification des éléments hérités, validation utilisateur) | `agent-sprint.md` (hors dépôt) | `agent-sprint.md` | Livrable 5 côté session de sprint | Prompt agent mis à jour |
| A041 | vérifier | `node --check` sur `db.mjs`, `index.mjs` (registre) et `pilot.mjs`, `server.mjs`, `public/app.js` (panneau) + **spawn MCP réel** (T1-T9 : `feature_register`, `feature_update`, `feature_get`, `feature_list`, `rule_*`, `sprint_report`, `sprint_list`) + rejeu `schema.sql`/`migrate()` | `db.mjs`, `index.mjs`, `pilot.mjs`, `server.mjs`, `app.js` | — | **Rétrocompatibilité** : sans qualification, comportement inchangé ; aucune régression T1-T9 | Rapport de vérification |
| A042 | vérifier | **Preuve sur le sprint myxmax** `SPRINT-mub8iyew-j6j8` : qualifier ≥1 fonctionnalité et ≥1 règle en `hors_ecosystem`, puis `sprint_report` → vérifier « N implémentée(s) — dont E dans l'écosystème, H hors écosystème » + section « Règles métier implémentées » | registre (données) | — | Critère d'acceptation 6 | Sortie de rapport prouvant la ventilation |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---|---|
| `schema.sql` | **Modification** — `fonctionnalites` (A001) et `regles_metier` (A002) étendues (5 colonnes chacune) |
| `db.mjs` | **Modification** — `migrate()` (A003/A004) ; `rowToFonctionnalite`/`rowToRegle` (A005/A006) ; `updateFeature`/`updateRule` (A008/A009) ; `buildSprintReport` (A012-A017) ; **créations** `applyImplementationQualification` (A007), `markFeatureImplemented`/`markRuleImplemented` (A010/A011) |
| `index.mjs` | **Modification** — import (A022) ; `feature_update`/`rule_update` (A018/A019) ; descriptions (A023/A024) ; **créations** `feature_mark_implemented`/`rule_mark_implemented` (A020/A021) |
| `pilot.mjs` | **Modification** — `updateFeature` (A025) / `updateRule` (A026) pass-through |
| `server.mjs` | **Modification** — `PUT /api/features/:id` (A027) / `PUT /api/rules/:id` (A028) |
| `public/app.js` | **Modification** — tables (A029/A030), filtres (A031/A032), sous-panneaux (A033/A034), formulaires (A035/A036), détails (A037/A038) |
| `/root/.config/opencode/agent/agent-migration.md` | **Modification** (hors dépôt) — A039 |
| `/root/.config/opencode/agent/agent-sprint.md` | **Modification** (hors dépôt) — A040 |

> **Aucune table créée ni supprimée.** Aucune modification de la famille ADR (`artifacts` `doc_type='adr'`, `adr_*`). La route du rapport (`GET /api/sprints/:id/report`, server.mjs l.1895-1912) **n'est pas modifiée** : elle restitue automatiquement la ventilation (markdown du registre).

## 5. Livrables attendus

1. **Modèle** : 5 colonnes (`implemented`, `implemented_origin`, `implemented_at`, `implemented_by`, `implemented_note`) sur `fonctionnalites` **et** `regles_metier`, en `schema.sql` **et** `migrate()` (idempotent).
2. **Helper d'écriture** `applyImplementationQualification` + wrappers `markFeatureImplemented` / `markRuleImplemented` (validés, idempotents).
3. **`buildSprintReport` étendu** : « implémentée » = `implemented=1` **OU** `done_tasks>=1` ; `stats` ventilées E/H pour fonctionnalités **et** règles ; **section « Règles métier implémentées »** ; markdown de synthèse « N implémentée(s) — dont E dans l'écosystème, H hors écosystème ».
4. **MCP** : `feature_update`/`rule_update` acceptent les 3 champs ; tools `feature_mark_implemented`/`rule_mark_implemented` ; lecture exposée dans `feature_get`/`feature_list`/`rule_get`/`rule_list`.
5. **Panneau** : badge d'état (implémentée · écosystème / hors écosystème / émergente), action de qualification, filtre d'implémentation dans **les 2 sous-onglets** ; rapport téléchargeable reflétant la ventilation.
6. **Agents migration/sprint** : pouvoir **proposer** la qualification `hors_ecosystem` des éléments pré-existants (validation utilisateur avant écriture), **sans** marquage émergent.
7. **Preuve** : sur `SPRINT-mub8iyew-j6j8` (myxmax), ≥1 fonctionnalité et ≥1 règle qualifiées `hors_ecosystem` → rapport avec ventilation E/H.
8. **Non-régression** : `node --check` + spawn MCP réel (T1-T9) OK ; sans qualification, comportement strictement inchangé.

## 6. Ordre & dépendances

```
Lot 1 (modèle)            A001 → A002 → A003 → A004
                                │
Lot 2 (lecture/écriture)  A005, A006 ──┐
                          A007 ──→ A008 ──→ A009
                                   └──→ A010, A011
                                │
Lot 3 (rapport)           A012, A013 (dépendent de A001-A006) → A014 → A015 → A016 → A017
                                │
Lot 4 (MCP)               A022 → A018, A019 → A020, A021 ; A023, A024 (doc, indépendants)
                                │
Lot 5 (panneau back)      A025, A026 (dépendent de A018/A019) → A027, A028
                                │
Lot 6 (panneau UI)        A031, A032 (filtres) ; A029, A030 (tables) ; A035-A038 (modales)
                          → A033, A034 (assemblage : dépendent de A029-A032 + A027/A028)
                                │
Lot 7 (agents)            A039, A040 (indépendants, après Lot 4 : les tools doivent exister)
                                │
Lot 8 (vérif)             A041 → A042
```

**Prérequis durs** :
- A003/A004 (colonnes) **avant** A005-A013 (lecture/calcul).
- A007 (helper) **avant** A008/A009/A010/A011.
- A010/A011 **avant** A020/A021 (tools) ; A022 (import) **avant** A020/A021.
- A018/A019 (MCP) **avant** A025-A028 (panneau back) **avant** A033/A034 (panneau UI).
- A001-A017 **avant** A042 (la preuve utilise le rapport et l'écriture).

## 7. Couverture des objectifs

| Exigence (tâche / critère d'acceptation) | Étape(s) | Couvert ? |
|---|---|---|
| Modèle : `implemented`, `implemented_origin`, `implemented_at`, `implemented_by`, `implemented_note` sur les **2 tables**, `migrate()` idempotent **et** miroir `schema.sql` | A001, A002, A003, A004 | ✅ |
| `buildSprintReport` : implémentée si `implemented=1` **OU** `done_tasks>=1` | A012, A013 | ✅ |
| Ventilation « dont E dans l'écosystème / H hors écosystème » (stats + markdown) | A015, A016 | ✅ |
| Nouvelle section « Règles métier implémentées » | A014, A017 | ✅ |
| MCP : `feature_update`/`rule_update` acceptent les champs | A007, A008, A009, A018, A019 | ✅ |
| MCP : tools dédiés `feature_mark_implemented`/`rule_mark_implemented` | A010, A011, A020, A021, A022 | ✅ |
| MCP : lecture exposée dans `*_get`/`*_list` (+ contrat) | A005, A006, A024 | ✅ |
| Panneau : qualification (dans / hors écosystème) dans les 2 sous-onglets | A025-A028, A033, A034, A035, A036 | ✅ |
| Panneau : badge d'état (implémentée / hors écosystème / émergente) | A029, A030, A037, A038 | ✅ |
| Panneau : filtre d'implémentation dans les 2 sous-onglets | A031, A032, A033, A034 | ✅ |
| Panneau : rapport téléchargeable reflétant la ventilation | A016 (source) + route existante (l.1895-1912, non modifiée) | ✅ |
| Agents migration/sprint : proposer `hors_ecosystem` des éléments pré-existants, validation utilisateur, **sans** émergent | A039, A040 | ✅ |
| Rétrocompatibilité : sans qualification, comportement inchangé ; émergence = axe distinct ; non-régression T1-T9 | A001-A004 (DEFAULT 0), A012/A013 (repli `done_tasks`), A041 | ✅ |
| Preuve : ≥1 fonctionnalité + ≥1 règle `hors_ecosystem` sur myxmax → ventilation E/H | A042 | ✅ |

**Aucune exigence non couverte.**

## 8. Vérification de cohérence

**Méthode** : regroupement des étapes par `(fichier, élément cible)` + contrôle des verbes/ordres.

- **Aucun verbe destructeur** (`supprimer`/`remplacer`) sur un élément existant : toutes les étapes sont `ajouter`/`modifier`/`créer`/`vérifier`. Aucune contradiction `supprimer` + autre action.
- **Éléments ciblés par plusieurs étapes** (modifications **additives** sur des sous-blocs distincts, ordonnées) :
  - `db.mjs / buildSprintReport` : A012 (requête `feats`), A013 (requête `regles`), A014 (`sections`), A015 (`stats`), A016 (synthèse markdown), A017 (`list`) → sous-blocs **disjoints**, ordre A012→A017. ✅
  - `db.mjs / updateFeature` : A008 (db) puis A018 (tool) puis A025 (pilot) puis A027 (route) → couches **différentes** (registre → MCP → serveur panneau), cohérentes. ✅
  - `db.mjs / updateRule` : A009 → A019 → A026 → A028, idem. ✅
  - `public/app.js / sous-onglet Fonctionnalités` : A029 (table), A031 (filtre), A033 (panneau), A035 (formulaire), A037 (détail) → fonctions **distinctes**. ✅
- **Risque de double écriture `updated_at`** (A007 vs A008/A009) : **résolu par conception** — le helper pose `updated_at` ; `updateFeature`/`updateRule` ne poussent **pas** un second `UPDATE` quand seuls les champs d'implémentation sont fournis (retour direct `getFeature`/`getRule`). Explicitement prescrit en A008/A009.
- **Ordre / dépendance inversée** : aucun élément n'est lu ou modifié avant d'être créé (A007 avant A008-A011 ; A001-A004 avant A012/A013 ; A022 avant A020/A021 ; A018/A019 avant A025-A028 ; A027/A028 avant A033/A034).
- **Aucune fusion nécessaire** : `créer` (A007/A010/A011) et `modifier` (A008/A009) portent sur des **fonctions différentes** — pas de doublon `créer` + `renommer`.
- **Émergence préservée** : aucune étape n'écrit `emergent`/`emergent_origin` ; A039/A040 l'interdisent explicitement aux agents.

**Résultat : plan Valid** (aucune contradiction, couverture 100 %, étapes atomiques ancrées sur le code réel).

## 9. Risques & notes

1. **A039/A040 hors scope réservé** : `agent-migration.md` / `agent-sprint.md` vivent dans `/root/.config/opencode/agent/` — **hors des 6 fichiers du scope** et **hors dépôt git**. L'exécution doit (a) les modifier **sans** toucher aux branches des repos, ou (b) si l'orchestrateur juge ces fichiers non modifiables, **livrer le livrable 5 par les seuls tools MCP** (`*_mark_implemented` + validation panneau) et le **signaler** (`task_event`). À trancher au démarrage de l'exécution.
2. **`done_tasks` des règles = signal dérivé** (décision §2.3) : aucune table `task_regles` n'existe. Si le métier veut un lien tâche↔règle direct, c'est une **tâche ultérieure** (nouvelle table N:N) — hors périmètre ici.
3. **`buildSprintReport` et `format='json'`** : les nouveaux champs (`stats.*.implementeesEcosystem/HorsEcosystem`, `sections.reglesImplementees`) sont **additifs** ; les consommateurs existants (panneau l.4883-4900, `sprint_report` json) ne cassent pas.
4. **Non-régression des migrations** : `ALTER TABLE … ADD COLUMN IF NOT EXISTS` est idempotent sur PostgreSQL (repo `feature/migration-postgresql`) ; le `DEFAULT 0` garantit `implemented=0` sur les lignes existantes → repli sur `done_tasks` (comportement actuel).
5. **Sprint de preuve** : `SPRINT-mub8iyew-j6j8` (myxmax). La qualification `hors_ecosystem` de 1 fonctionnalité + 1 règle est une **écriture de données** (pas de code) ; elle doit être **proposée puis validée** (esprit du livrable 5).

## 10. Tests E2E Playwright — analyse d'impact

- **Aucune infrastructure Playwright** dans les 2 repos concernés (recherche `playwright.config.*` / `*.spec.ts` → **0 résultat**) et `e2e_list({ project: 'ecosystem' })` → **0 test**.
- Le périmètre est de l'**outillage interne** (registre MCP + panneau d'administration, JS vanilla sans runner E2E) ; **aucun parcours utilisateur produit** n'est concerné (pas de frontend applicatif).
- **Verdict : E2E NA** — pas de `e2e_test_register` / `e2e_test_link` (aucun scénario, aucune infra). La non-régression est couverte par A041 (`node --check` + spawn MCP réel).
