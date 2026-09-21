# Rapport de fin de sous-tâche — Cardinalités heuristiques + gouvernance de l'émergence

- **Plan** : `Plan-cardinalites-emergence-20260921-105121`
- **Tâche** : `T-20260921-091735-wmqd` (exécution `E-T-20260921-091735-wmqd-u3pb5s`)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Date** : 2026-09-21 11:02:26
- **Agent** : `build-notify` (executor)

---

## 1. Résumé

**Demandé** : implémenter les 24 étapes du plan — gardes HEURISTIQUES de cardinalité
(signalement + traçage, **non bloquantes**) et gouvernance de l'émergence (flag + origine,
**jamais rétroactif**), dans `db.mjs` et `index.mjs` du MCP task-orchestrator.

**Fait** : les 24 étapes sont implémentées et vérifiées (24/24, 100 %). Livrables :

- table `cardinality_signals` posée **uniquement dans `migrate()`** (idempotente, index partiel
  unique « 1 open par entité », **sans backfill**) ;
- constantes `EMERGENT_ORIGINS`, `CARDINALITY_RULES`, `CARDINALITY_VIEWS` exportées ;
- `checkCardinality`, `recordCardinalitySignal`, `listCardinalitySignals`,
  `resolveCardinalitySignal`, `cardinalityView` (10 vues), `cardinalityReport`,
  `ensureDefaultSprintLink` exportées ;
- `classifyEmergence` étendue (`sans_fonctionnalite`, `recette`), **rétrocompatible**, priorité
  documentée (`hors_sprint` > `apres_cloture` > `recette` > `sans_fonctionnalite`) ;
- branchements `createTask` (sprint par défaut si projet sans sprint + liens optionnels
  `featureIds`/`sprintId`/`adrIds` + origine + signal), `startRecette`, `registerAdr`,
  `createSprint`, `registerFeature`/`registerRule` (`recetteId` → origine `recette`) ;
- 3 tools MCP (`cardinality_report`, `cardinality_signals_list`, `cardinality_signal_resolve`) +
  enrichissements `task_register`/`recette_start`/`recette_get`/`task_get`/`feature_register`/`rule_register` ;
- **émergence jamais rétroactive** (aucun backfill ; marquage uniquement à la création) ;
  **flag `emergent` jamais effacé** après rattachement ultérieur.

**Décisions de conception appliquées** : (1) `createTask` rattache le sprint par défaut quand le
projet n'a aucun sprint (ADR-001 §5) ; (2) le flag `emergent` n'est jamais effacé.

---

## 2. Isolation

- **Espace Coder** : le repo cible `opencode-mcp-task-orchestrator`
  (`/root/.config/opencode/mcp/task-orchestrator`) est un **repo HÔTE** d'outillage
  d'infrastructure (le MCP task-orchestrator lui-même) — **absent** de tout workspace Coder
  (vérifié via `workspace_list`). La tâche le désigne explicitement comme repo hôte ; il est
  traité **in-place**, conformément à l'exception « composant d'infrastructure » de la norme.
- **session-guard** : `acquire --dir /root/.config/opencode/mcp/task-orchestrator` → **mode
  `in-place`** (code de sortie 0, aucune session parallèle). Travail sur une **branche de travail
  dédiée** `build-notify/cardinalites-emergence-20260921-105121` (base `6b0573c`), **aucun commit
  direct sur `feature/migration-postgresql`**.
- **Verrou** : release effectué en fin de traitement.

---

## 3. Branches et commits

- **Branche de travail** : `build-notify/cardinalites-emergence-20260921-105121`
- **Base** : `6b0573c` (`feature/migration-postgresql`)
- **Commit** :

| SHA | Message |
|-----|---------|
| `2e4cdabbe4f6940491c89fd2dbd9581f4ae508c5` | `feat(cardinalites): gardes heuristiques (signalement + tracage, non bloquantes) + gouvernance de l'emergence (T-20260921-091735-wmqd)` |

`db.mjs` +578/−19 · `index.mjs` +100/−16. Trace complète (fichiers + diffs) enregistrée via
`plan_commit_add` (id 464). **Pas de push** (merge/push = étape d'orchestration ultérieure).

---

## 4. Traitements effectués (24/24)

### `db.mjs` (A001–A015)

| Étape | Traitement | Résultat |
|-------|-----------|----------|
| A001 | Constantes `EMERGENT_ORIGINS`, `CARDINALITY_RULES`, `CARDINALITY_ENTITY_TYPES`, `CARDINALITY_VIEWS` exportées | ✅ |
| A002 | Table `cardinality_signals` + 4 index (dont index partiel unique « 1 open/entité ») dans `migrate()`, sans backfill | ✅ |
| A003 | `checkCardinality({entityType, entityId})` — 4 types, jamais d'exception sur manque | ✅ |
| A004 | `recordCardinalitySignal` — upsert OPEN, rafraîchit `missing`/`detail`, événement `CARDINALITY_SIGNAL`, **ne throw jamais** | ✅ |
| A005 | `listCardinalitySignals` — filtrable + `currentGaps`/`currentOk`/`stale` | ✅ |
| A006 | `resolveCardinalitySignal` — `resolution` obligatoire, open→resolved | ✅ |
| A007 | `cardinalityView` — 10 vues de traçage | ✅ |
| A008 | `cardinalityReport` — compteurs + vues + synthèse signaux | ✅ |
| A009 | `classifyEmergence` étendue (`hasFeature`, `fromRecette`), rétrocompatible | ✅ |
| A010 | `ensureDefaultSprintLink` — tâche/recette, idempotent, non bloquant | ✅ |
| A011 | `createTask` — sprint par défaut + liens optionnels + origine + signal (try/catch) | ✅ |
| A012 | `startRecette` — sprint par défaut + liens optionnels + signal | ✅ |
| A013 | `registerAdr` — signal `adr` | ✅ |
| A014 | `createSprint` — signal `sprint` | ✅ |
| A015 | `registerFeature`/`registerRule` — `recetteId` → origine `recette` | ✅ |

### `index.mjs` (A016–A024)

| Étape | Traitement | Résultat |
|-------|-----------|----------|
| A016 | Imports additifs (aucun import cassé) | ✅ |
| A017 | Tool `cardinality_report` | ✅ |
| A018 | Tool `cardinality_signals_list` | ✅ |
| A019 | Tool `cardinality_signal_resolve` | ✅ |
| A020 | `task_register` : `featureIds`/`sprintId`/`adrIds` + `cardinalite` | ✅ |
| A021 | `recette_start` : `sprintId`/`featureIds`/`adrIds` + `cardinalite` | ✅ |
| A022 | `recette_get` : `cardinalite` | ✅ |
| A023 | `feature_register`/`rule_register` : `recetteId` | ✅ |
| A024 | `task_get` : `cardinalite` + `adrs` | ✅ |

---

## 5. Vérifications (A024)

- `node --check db.mjs` / `node --check index.mjs` → **OK**.
- Script de vérification `/tmp/opencode/t6-verify.mjs` (hors repo) → **43/43 PASS**, 0 FAIL.
  Couverture :
  - `classifyEmergence` : legacy `{kind:'element'}`/`{kind:'piece'}` **résultats inchangés** ;
    `hasFeature=false` → `sans_fonctionnalite` ; `fromRecette` → `recette` ; priorités
    `hors_sprint` > `recette` et `recette` > `sans_fonctionnalite` ; `apres_cloture` préservé.
  - `createTask` : (a) projet sans sprint → **sprint par défaut créé + rattaché** + origine
    `sans_fonctionnalite` ; (b) `featureIds`+`sprintId` → **non émergente**, liens posés ;
    (c) signal OPEN présent ; (d) **création jamais en erreur** si la réparation échoue
    (projet inexistant → origine `hors_sprint`, pas d'exception).
  - ADR proposée seule → manque `adr` (effectif) ; après `validateTaskAdr` → manque levé.
  - `startRecette` : sprint par défaut + signal recette (`adr`, `fonctionnalite`).
  - `checkCardinality` : ADR sans fonctionnalité, sprint sans fonctionnalité/règle, tâche sans ADR.
  - `listCardinalitySignals` (`currentGaps`/`stale`), `resolveCardinalitySignal`
    (raison obligatoire, double résolution refusée), `ensureDefaultSprintLink` idempotent.
  - **10 vues** opérationnelles + `cardinalityReport`.
  - **Non-rétroactivité** : 0 signal créé sur les tâches préexistantes ; flags `emergent`
    préexistants **inchangés** ; table vide avant tests (0 backfill).
  - **Non-régression** : `sprint_report`/`adr_list`/`adr_get`/`feature_get`/`rule_get`/`task_get`/
    `recette_get`/`piece_list` OK ; `artifacts` inchangé (845 avant = 845 après, modèle ADR intact).
  - **Spawn MCP réel** (`initialize` + `tools/list`) : les 3 nouveaux tools exposés (160 tools au
    total) + tools existants présents.
- **Nettoyage** : données de test supprimées ; base vérifiée propre
  (`cardinality_signals=0`, projets/tâches/artefacts `t6-*` = 0).
- **E2E Playwright : NA** — aucun `playwright.config.*` ni spec dans le repo ; comportement
  interne (registre + tools MCP), non observable par parcours Playwright. Aucun
  `e2e_test_register`/`e2e_test_link`.

---

## 6. Fichiers modifiés / créés

| Fichier | Type | Détail |
|---------|------|--------|
| `db.mjs` | modifié | +578/−19 |
| `index.mjs` | modifié | +100/−16 |
| `reports/report-cardinalites-emergence-20260921-110226.md` | créé | ce rapport |

Aucun autre fichier du repo modifié. `schema.sql` **non touché** (hors périmètre).

---

## 7. Avertissements / erreurs

1. **Dérive DDL `schema.sql` (à signaler, hors périmètre)** : la table `cardinality_signals` est
   posée **uniquement dans `migrate()`** (`db.mjs`). Le runtime est correct (`migrate()` s'exécute
   après `schema.sql` à chaque `ensureSchema()`), mais `schema.sql` **n'est pas miroité**.
   → **Tâche de suivi à créer** (précédent T5 pour les colonnes d'état `task_adr`).
2. **ADR-001 est `Proposé`** (non `Accepté`) : ce plan l'applique comme référence normative de la
   recette. L'acceptation reste une **décision humaine**. Aucune ADR `Accepté` n'est contredite.
   → Aucun `adr_report_conflict` nécessaire.
3. **Bruit de signalement assumé** : une recette neuve et un sprint neuf sont toujours incomplets à
   la création → signal OPEN systématique (comportement demandé) ; `cardinalityReport` expose
   `stale` pour distinguer un signal déjà comblé.
4. **Changement de comportement assumé (déjà validé par le plan §9.1)** : `createTask` rattache le
   sprint par défaut quand le projet n'a aucun sprint, ce qui rend `hors_sprint` rare sur le chemin
   de création (il reste produit par `classifyEmergence` appelé directement et en cas d'échec de la
   réparation).
5. **`sans_piece`** : conservée dans `EMERGENT_ORIGINS` (compat ascendante) mais **non produite**
   (hors mission).
6. Aucune incohérence code ↔ plan détectée → aucun `INCONSISTENCY_FOUND` ; aucun blocage.

---

## 8. Prochaines étapes / recommandations

1. **Orchestration** : merge/rebase de `build-notify/cardinalites-emergence-20260921-105121` sur
   `feature/migration-postgresql` (hors périmètre de cette sous-tâche).
2. **Créer une tâche de suivi** pour miroiter `cardinality_signals` (+ index) dans `schema.sql`.
3. **T7 (panneau, `opencode-observability`)** : consommer `cardinality_report` /
   `cardinality_signals_list` / `cardinality_signal_resolve` et les champs `cardinalite`.
4. **T9 (session de migration)** : associer les éléments existants (sprint/fonctionnalité/ADR)
   — **sans** les marquer émergents (émergence non rétroactive).
5. **Décision humaine** : accepter (ou non) l'ADR-001 (actuellement `Proposé`).
