# Plan — Cardinalités heuristiques + gouvernance de l'émergence

- **Plan ID** : `Plan-cardinalites-emergence-20260921-105121`
- **Tâche** : `T-20260921-091735-wmqd` (exécution `E-T-20260921-091735-wmqd-u3pb5s`) — tâche 6/9 du batch `BATCH-mub1809u-06ow`
- **Projet** : `ecosystem`
- **Repo** : `opencode-mcp-task-orchestrator` → `/root/.config/opencode/mcp/task-orchestrator` (branche de travail dédiée, jamais `feature/migration-postgresql` en direct)
- **Périmètre** : `db.mjs`, `index.mjs` uniquement
- **Date** : 2026-09-21 10:51:21

---

## 1. Objectif

Implémenter, dans le registre MCP `task-orchestrator`, les **gardes HEURISTIQUES de cardinalité**
(signalement + traçage, **NON bloquantes**) et la **gouvernance de l'émergence** :

- **recette** → ≥1 ADR + ≥1 fonctionnalité + 1 sprint (sprint **par défaut** du projet si absent) ;
- **tâche** → 1 sprint (par défaut si absent) + 1 fonctionnalité + ≥1 ADR (lien **proposé par l'agent**,
  **validé par l'humain**) ;
- **ADR** → 1..N fonctionnalités ; **sprint** → 1..N fonctionnalités et 1..N règles ;
- **marqueur ÉMERGENT** (flag + origine : `hors_sprint` / `apres_cloture` / `sans_fonctionnalite` /
  `recette`), appliqué **uniquement aux éléments créés après la mise en place du modèle**,
  **JAMAIS rétroactivement** ;
- **aucune garde ne bloque** l'exécution : les manques sont **signalés** (réponse d'outil) et
  **tracés** (table append-only + événement de tâche) ; les éléments émergents restent
  **rattachables ultérieurement** (outils de liaison T5) ;
- **vues de traçage** exposées (tâche sans ADR, tâche sans fonctionnalité, tâche sans sprint,
  recette sans ADR/fonctionnalité/sprint, ADR sans fonctionnalité, sprint sans fonctionnalité/règle,
  émergents) ;
- **ne pas casser le flot d'ajout rapide de tâches** (panneau) : les nouveaux paramètres sont
  **optionnels**, et tout ce qui relève de la garde est enveloppé en **non-bloquant**.

**Deux sous-objectifs, un seul plan.** Les manques de cardinalité sont la *cause* du marquage
émergent (« les liens manquants à la création marquent l'élément ÉMERGENT ») et les deux
sous-objectifs modifient **les mêmes fonctions** (`createTask`, `registerFeature`, `registerRule`) :
ils sont **interdépendants** → un plan unique, séquencé (voir §6).

---

## 2. Contexte & raison d'être

- La recette `RECT-muaz100k-2iq0` (« Règle métier plus cadrer dans l'écosystème ») a produit 9 tâches.
  Les tâches **T1→T5 sont TERMINÉES** (tables + liens N:N ; pièces client + émergence ;
  cycle de vie sprint + `classifyEmergence` + `ensureDefaultSprint` + `migrateExistingToDefaultSprint` ;
  famille `sprint_*` ; familles `feature_*`/`rule_*` + 20 outils de liaison + workflow ADR tâche
  `proposeTaskAdr`/`validateTaskAdr` + colonnes d'état `task_adr`). **T6 (ce plan)** ajoute les
  cardinalités heuristiques et la gouvernance de l'émergence.
- **T7** (panneau, repo `opencode-observability`) et **T8** (agent session sprint) sont **hors
  périmètre** : ce plan expose les **vues de traçage** que T7 consommera. **T9** = session de
  migration (les éléments existants y seront **associés**, jamais marqués émergents).
- **ADR de référence** : `doc-mub10mo8-lgo3` — « **ADR-001 — Modèle sprint / fonctionnalités /
  règles métier dans le registre ecosystem** » (`path`
  `docs/adr/ADR-001-modele-sprint-fonctionnalites-regles-metier.md`), **statut `Proposé`**
  (non encore acceptée — décision humaine). Elle est **globale** aux 3 repos du projet `ecosystem`
  et ses §2 (sprint par défaut, émergence non rétroactive) et §5 (cardinalités signalées, non
  bloquantes ; lien ADR proposé→validé) sont la **source normative** de ce plan.
  Le fichier `docs/adr/ADR-001-...md` **n'existe pas** dans le repo
  (`/root/.config/opencode/mcp/task-orchestrator/docs/` absent) — le contenu de référence est
  celui du registre (`adr_get`). Aucune étape de ce plan ne contredit une ADR **Accepté**
  (il n'en existe aucune sur ce périmètre) ; l'implémentation est **additive**.
- **DDL existante à réutiliser** (T1, `db.mjs` l.464-628) : `fonctionnalites`, `regles_metier`,
  `sprints`, `recette_sprints`, `recette_fonctionnalites`, `recette_adr`, `task_sprints`,
  `task_fonctionnalites`, `task_adr` (avec `status`/`proposed_*`/`validated_*`), `sprint_fonctionnalites`,
  `sprint_regles`, `sprint_pieces`, `fonctionnalite_adr` + trigger `fn_fonctionnalite_adr_min` (l.541-562).
- **Primitives à réutiliser sans les modifier sémantiquement** :
  `classifyEmergence` (l.898-919), `ensureDefaultSprint` (l.925-966), `detectOpenSprint` (l.636-651),
  `linkTaskSprint` (l.1711), `linkTaskFeature` (l.1735), `proposeTaskAdr` (l.1763),
  `linkRecetteSprint` (l.1864), `linkRecetteFeature` (l.1887), `linkRecetteAdr` (l.1910),
  `linkFeatureAdr` (l.1635), `linkFeatureSprint` (l.1662), `linkRuleSprint` (l.1687).
- **Contraintes de non-régression** : ne pas casser T1→T5, le modèle ADR/`artifacts`
  (`doc_type='adr'`, `artifact_projects`) ni les tables de liens. Aucun `UPDATE` de masse sur les
  lignes existantes (émergence **non rétroactive**) ; aucun backfill dans `migrate()`.

### Décisions de conception (à respecter par l'exécutant)

1. **Priorité des origines d'émergence** (documentée en commentaire au-dessus de `classifyEmergence`) :
   `hors_sprint` (1) > `apres_cloture` (2) > `recette` (3) > `sans_fonctionnalite` (4).
   `apres_init_sprint` (pièces, T2/T4) reste inchangé et hors de cette échelle (kind `piece`).
2. **`classifyEmergence` reste rétrocompatible** : les appels existants
   (`{kind:'element'}`, `{kind:'piece'}`) doivent produire **exactement** le même résultat.
   Les nouveaux paramètres `hasFeature` / `fromRecette` sont **optionnels**.
3. **Rattachement au sprint par défaut** : si l'entité créée (tâche/recette) n'a **aucun** lien sprint
   **et** que le projet n'a **aucun sprint**, on attache le **sprint par défaut**
   (`ensureDefaultSprint` + `link*Sprint`). Conséquence assumée : `hors_sprint` devient rare sur le
   chemin de création (il reste produit par `classifyEmergence` appelé directement et si la
   réparation échoue).
4. **Le flag `emergent` n'est JAMAIS effacé** quand un lien est ajouté plus tard (trace historique) ;
   c'est le **signal** de cardinalité qui peut être **résolu** (A006) et les vues qui recalculent
   l'état **live** (A007/A008).
5. **Un signal OPEN par entité** : index partiel unique `(entity_type, entity_id) WHERE status='open'` ;
   un nouveau passage **rafraîchit** `missing`/`detail` au lieu de dupliquer.
6. **Non-bloquant strict** : `recordCardinalitySignal`, `ensureDefaultSprintLink` et les appels de
   garde dans `createTask`/`startRecette`/`registerAdr`/`createSprint` sont enveloppés en
   `try/catch` et ne peuvent **jamais** faire échouer la création (le flot panneau doit rester intact).
7. `sans_piece` figure dans le commentaire `schema.sql` l.688 (héritage T1) mais **n'est pas
   implémenté** ici : hors mission (noté en §9).

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | ajouter | constantes `EMERGENT_ORIGINS`, `CARDINALITY_RULES` (bloc constantes l.3130-3183) | `db.mjs` | `db.mjs` | Référentiel unique des origines + des cardinalités par entité | Constantes exportées et documentées |
| A002 | créer | table `cardinality_signals` + index (dans `migrate()`, après l.628) | `db.mjs` | `db.mjs` | Trace **append-only** des manques, sans blocage | DDL idempotente + 4 index dont l'index partiel unique « 1 open par entité » |
| A003 | créer | fonction `checkCardinality({entityType, entityId})` | `db.mjs` | `db.mjs` | Calcul **live** des manques par entité (recette/tâche/ADR/sprint) | Fonction exportée retournant `{ok, missing[], detail}` sans exception sur manque |
| A004 | créer | fonction `recordCardinalitySignal({entityType, entityId, by})` | `db.mjs` | `db.mjs` | Persister le signal OPEN (upsert) + événement tâche | Fonction exportée, **ne throw jamais** |
| A005 | créer | fonction `listCardinalitySignals({projectId, entityType, entityId, status})` | `db.mjs` | `db.mjs` | Historique filtrable des signaux + détection `stale` | Fonction exportée (signaux enrichis `currentGaps`/`stale`) |
| A006 | créer | fonction `resolveCardinalitySignal({signalId, resolution, resolvedBy})` | `db.mjs` | `db.mjs` | Clôture **tracée** d'un signal (raison obligatoire) | Fonction exportée (style `resolveAdrVigilance`) |
| A007 | créer | fonction `cardinalityView({projectId, view})` | `db.mjs` | `db.mjs` | Vues de traçage live (10 vues) | Fonction exportée retournant `{view, count, items}` |
| A008 | créer | fonction `cardinalityReport({projectId})` | `db.mjs` | `db.mjs` | Agrégat des vues + compteurs de signaux | Fonction exportée `{projectId, counts, views, signals}` |
| A009 | modifier | `classifyEmergence` (l.898-919) — paramètres `hasFeature`/`fromRecette` | `db.mjs` | `db.mjs` | Origines `sans_fonctionnalite` et `recette` | Signature étendue **rétrocompatible** + priorité documentée |
| A010 | créer | fonction `ensureDefaultSprintLink({entityType, entityId, projectId, by})` | `db.mjs` | `db.mjs` | Rattachement **non bloquant** au sprint par défaut | Fonction exportée (tâche \| recette), idempotente |
| A011 | modifier | `createTask` (l.1954-2030), bloc émergence l.1997-2007 | `db.mjs` | `db.mjs` | Tâche : sprint par défaut + liens optionnels + origine + signal | `createTask` non bloquant, `emergent_origin` conforme, signal tracé |
| A012 | modifier | `startRecette` (l.4361-4380) | `db.mjs` | `db.mjs` | Recette : sprint par défaut + signal ADR/fonctionnalité | `startRecette` non bloquant + signal recette |
| A013 | modifier | `registerAdr` (l.3846-3873) | `db.mjs` | `db.mjs` | Garde ADR → 1..N fonctionnalités (signal) | Signal `adr` créé à l'enregistrement (non bloquant) |
| A014 | modifier | `createSprint` (l.976-1011) | `db.mjs` | `db.mjs` | Garde sprint → 1..N fonctionnalités + 1..N règles (signal) | Signal `sprint` créé à la création (non bloquant) |
| A015 | modifier | `registerFeature` (l.1290-1330) + `registerRule` (l.1450-1489) | `db.mjs` | `db.mjs` | Origine `recette` pour un élément apparu en recette | Paramètre optionnel `recetteId` + marquage `recette` |
| A016 | modifier | bloc d'import depuis `./db.mjs` (l.147-211) | `index.mjs` | `index.mjs` | Exposer les nouvelles fonctions/constantes au serveur MCP | Imports ajoutés (aucun import cassé) |
| A017 | ajouter | tool `cardinality_report` | `index.mjs` | `index.mjs` | Vue/agrégat de traçage consommable par le panneau (T7) | Tool enregistré (lecture seule) |
| A018 | ajouter | tool `cardinality_signals_list` | `index.mjs` | `index.mjs` | Historique filtrable des signaux | Tool enregistré (lecture seule) |
| A019 | ajouter | tool `cardinality_signal_resolve` | `index.mjs` | `index.mjs` | Clôture tracée d'un signal | Tool enregistré (`resolution` obligatoire) |
| A020 | modifier | tool `task_register` (l.261-306) | `index.mjs` | `index.mjs` | Liens optionnels + cardinalité en réponse, sans bloquer le panneau | `featureIds`/`sprintId`/`adrIds` optionnels + champ `cardinalite` |
| A021 | modifier | tool `recette_start` (l.1457-1476) | `index.mjs` | `index.mjs` | Liens optionnels + cardinalité en réponse | `sprintId`/`featureIds`/`adrIds` optionnels + champ `cardinalite` |
| A022 | modifier | tool `recette_get` (l.1492-1503) | `index.mjs` | `index.mjs` | Exposer les manques d'une recette (panneau) | Champ `cardinalite` ajouté (à côté de `adrVigilances`) |
| A023 | modifier | tools `feature_register` (l.774-789) / `rule_register` (l.834-848) | `index.mjs` | `index.mjs` | Exposer `recetteId` (origine `recette`) | Input `recetteId` optionnel sur les 2 tools |
| A024 | modifier | tool `task_get` (l.1403-1422) | `index.mjs` | `index.mjs` | Vue « tâche sans ADR / sans fonctionnalité » côté tâche | Champs `cardinalite` + `adrs` (via `listTaskAdrs`) ajoutés |

---

## 4. Fichiers concernés

| Fichier | Type de modification | Zones touchées |
|---------|----------------------|----------------|
| `db.mjs` | modification (additive) | bloc constantes (~l.3130-3183) ; `migrate()` fin (~l.628) ; `classifyEmergence` (l.898-919) ; `createSprint` (l.976-1011) ; `registerFeature` (l.1290-1330) ; `registerRule` (l.1450-1489) ; `createTask` (l.1954-2030) ; `registerAdr` (l.3846-3873) ; `startRecette` (l.4361-4380) ; nouvelles fonctions de garde (nouveau bloc après `listRules`/`listTaskAdrs`) |
| `index.mjs` | modification (additive) | bloc d'import (l.147-211) ; `task_register` (l.261-306) ; `feature_register`/`rule_register` (l.774-848) ; nouveaux tools après le bloc ADR (l.1376) ; `task_get` (l.1403-1422) ; `recette_start` (l.1457-1476) ; `recette_get` (l.1492-1503) |
| `schema.sql` | **hors périmètre** | Miroir DDL de `cardinality_signals` → **tâche de suivi** (voir §9, risque 2 — précédent T5) |

Aucune suppression de fichier. Aucun nouveau fichier dans le repo (les scripts de vérification
vivent sous `/tmp/opencode`).

---

## 5. Livrables attendus

1. `db.mjs` : table `cardinality_signals` (+ index, dont l'index partiel unique « 1 open par entité »)
   créée par `migrate()` de façon **idempotente** et **sans backfill** (aucune ligne pour l'existant).
2. `db.mjs` : `EMERGENT_ORIGINS` et `CARDINALITY_RULES` exportés, documentant les cardinalités
   (recette ≥1 ADR / ≥1 fonctionnalité / 1 sprint ; tâche 1 sprint / 1 fonctionnalité / ≥1 ADR
   *effectif* ; ADR 1..N fonctionnalités ; sprint 1..N fonctionnalités et 1..N règles).
3. `db.mjs` : `checkCardinality`, `recordCardinalitySignal`, `listCardinalitySignals`,
   `resolveCardinalitySignal`, `cardinalityView`, `cardinalityReport`, `ensureDefaultSprintLink`
   exportées.
4. `db.mjs` : `classifyEmergence` étendue (`hasFeature`, `fromRecette`) produisant
   `sans_fonctionnalite` et `recette`, **rétrocompatible** avec les appels T2/T3/T4/T5.
5. `db.mjs` : `createTask` attache le sprint par défaut si absent, lie les liens optionnels
   (`featureIds`, `sprintId`, `adrIds` proposées), pose `emergent`/`emergent_origin` et **trace** le
   signal — **sans jamais échouer**.
6. `db.mjs` : `startRecette` (sprint par défaut + signal), `registerAdr` (signal), `createSprint`
   (signal), `registerFeature`/`registerRule` (`recetteId` → origine `recette`).
7. `index.mjs` : tools `cardinality_report`, `cardinality_signals_list`, `cardinality_signal_resolve`
   enregistrés et fonctionnels (spawn MCP réel : `tools/list` les expose).
8. `index.mjs` : `task_register`, `recette_start`, `recette_get`, `task_get`, `feature_register`,
   `rule_register` enrichis **sans rupture** des schémas existants.
9. Vues de traçage opérationnelles : « tâche sans ADR », « tâche sans fonctionnalité »,
   « tâche sans sprint », « recette sans ADR / sans fonctionnalité / sans sprint »,
   « ADR sans fonctionnalité », « sprint sans fonctionnalité / sans règle », « émergents ».
10. Preuve de **non-rétroactivité** : une tâche/recette/fonctionnalité/règle **existante** avant la
    mise en place n'est ni marquée émergente ni dotée d'un signal par `migrate()`.

---

## 6. Ordre & dépendances

Graphe (Phase 4) :

```
A001 ─→ A002 ─→ A003 ─┬─→ A004 ─┬─→ A005 ──→ A018
                      │         ├─→ A006 ──→ A019
                      │         ├─→ A011 ──→ A020
                      │         ├─→ A012 ──→ A021
                      │         ├─→ A013
                      │         └─→ A014
                      ├─→ A007 ─┬─→ A008 ──→ A017
                      │         └─→ A024
                      └─→ A022
A009 ─→ A011, A015 ─→ A023
A010 ─→ A011, A012
A016 ─→ A017, A018, A019, A020, A021, A022, A023, A024
```

Enchaînement linéaire recommandé (les lots `A001→A015` sont dans `db.mjs`, puis `A016→A024` dans `index.mjs`) :

`A001 → A002 → A003 → A004 → A005 → A006 → A007 → A008 → A009 → A010 → A011 → A012 → A013 → A014 → A015 → A016 → A017 → A018 → A019 → A020 → A021 → A022 → A023 → A024`

Prérequis stricts :

- **A002 avant A003/A004/A005/A006** (la table doit exister).
- **A003 avant A004** (`recordCardinalitySignal` consomme `checkCardinality`).
- **A004 avant A011/A012/A013/A014** (les gardes de création écrivent le signal).
- **A009 et A010 avant A011/A012/A015** (la classification et le rattachement par défaut sont appelés par la création).
- **A016 avant tous les tools** (`index.mjs` importe les nouvelles fonctions).
- **A001 avant A003/A009** (constantes référencées).

Aucune étape ne dépend d'une étape ultérieure. Aucune étape n'est bloquée par T7/T8/T9.

---

## 7. Couverture des objectifs

| Exigence (tâche `T-20260921-091735-wmqd`) | Étape(s) | Couvert ? |
|---|---|---|
| recette → ≥1 ADR | A003, A007, A012, A021, A022 | ✅ |
| recette → ≥1 fonctionnalité | A003, A007, A012, A021, A022 | ✅ |
| recette → 1 sprint (**par défaut si absent**) | A010, A012, A021 | ✅ |
| tâche → 1 sprint (**par défaut si absent**) | A010, A011, A020, A024 | ✅ |
| tâche → 1 fonctionnalité (spécificité fonctionnelle) | A003, A007, A011, A020, A024 | ✅ |
| tâche → ≥1 ADR (lien **proposé** agent, **validé** humain) | A003 (`task_adr.status='valide'`), A011 (`proposeTaskAdr`), A020, A024 | ✅ |
| ADR → 1..N fonctionnalités | A003, A007, A013 | ✅ |
| sprint → 1..N fonctionnalités | A003, A007, A014 | ✅ |
| sprint → 1..N règles | A003, A007, A014 | ✅ |
| Marqueur ÉMERGENT = flag + origine `hors_sprint` | A009 (existant conservé), A011 | ✅ |
| Marqueur ÉMERGENT = origine `apres_cloture` | A009 (existant conservé), A011 | ✅ |
| Marqueur ÉMERGENT = origine `sans_fonctionnalite` | A001, A009, A011 | ✅ |
| Marqueur ÉMERGENT = origine `recette` | A001, A009, A011 (`recetteId`), A015 | ✅ |
| ÉMERGENCE **JAMAIS rétroactive** (aucun backfill) | A002 (DDL seule, sans `INSERT`/`UPDATE` de masse), A011/A012/A015 (marquage **uniquement** à la création) | ✅ |
| Éléments existants **non** marqués émergents (associés en session de migration T9) | A011/A012/A015 (hooks de création) ; aucun backfill ; vérification §9 | ✅ |
| Gardes **NON bloquantes** (signalent + tracent) | A004, A005, A006, A011, A012, A013, A014 (try/catch + aucune exception sur manque) | ✅ |
| Émergents **rattachables ultérieurement** (sans blocage) | A006 (résolution tracée), A007/A008 (`stale` recalculé), réutilisation des liaisons T5 | ✅ |
| Vues de traçage « tâche sans ADR » / « tâche sans fonctionnalité » | A007, A008, A017, A024 | ✅ |
| Vues de traçage « émergents » | A007 (`view='emergents'`), A008, A017 | ✅ |
| Ne pas casser le flot d'ajout rapide de tâches (panneau) | A020 (paramètres **optionnels**, réponse enrichie sans rupture), A011 (non-bloquant) | ✅ |
| Réutiliser `classifyEmergence`, `ensureDefaultSprint`, liaisons T5 | A009, A010, A011, A012, A015 | ✅ |
| Ne pas casser le modèle ADR/`artifacts` ni T1→T5 | A013 (additif sur `registerAdr`), A016 (imports additifs) ; aucune modification de `artifacts`/`doc_*` | ✅ |
| Outillage MCP consommable par le panneau (T7) | A017, A018, A019, A020, A021, A022, A023, A024 | ✅ |

Aucune exigence de la tâche n'est hors couverture.

---

## 8. Vérification de cohérence

### 8.1 Contradictions intra-plan (Phase 6)

Regroupement par élément cible :

| Élément cible (fichier · fonction) | Étapes | Verbe(s) | Contradiction ? |
|---|---|---|---|
| `db.mjs` · constantes | A001 | ajouter | non |
| `db.mjs` · `migrate()` | A002 | créer | non |
| `db.mjs` · `classifyEmergence` | A009 | modifier | non (une seule étape) |
| `db.mjs` · `createSprint` | A014 | modifier | non |
| `db.mjs` · `registerFeature` / `registerRule` | A015 | modifier | non |
| `db.mjs` · `createTask` | A011 | modifier | non (une seule étape ; A009/A010 sont des **dépendances** appelées, pas des modifications concurrentes) |
| `db.mjs` · `registerAdr` | A013 | modifier | non |
| `db.mjs` · `startRecette` | A012 | modifier | non |
| `index.mjs` · imports | A016 | modifier | non |
| `index.mjs` · `task_register` | A020 | modifier | non |
| `index.mjs` · `recette_start` | A021 | modifier | non |
| `index.mjs` · `recette_get` | A022 | modifier | non |
| `index.mjs` · `feature_register`/`rule_register` | A023 | modifier | non |
| `index.mjs` · `task_get` | A024 | modifier | non |

Contrôles explicites :

- **Aucune étape `supprimer`** (aucune combinaison `supprimer` + autre action sur un même élément).
- **Aucun doublon `créer` + `renommer`** ; les 7 nouvelles fonctions ont des noms distincts et des
  responsabilités distinctes (calcul / trace / lecture / résolution / vue / rapport / rattachement).
- **Aucune lecture d'un élément créé par une étape ultérieure** : le graphe §6 est acyclique et
  chaque dépendance pointe vers une étape **antérieure** (A003→A004→A011/A012/A013/A014 ;
  A016→tools).
- **A020/A021 (tools) ne bloquent pas la création** : ils **lisent** (`checkCardinality`) et
  transmettent des paramètres optionnels ; la garde qui écrit est en `try/catch` (A011/A012).
- **A013 (signal ADR) vs trigger T1 `fn_fonctionnalite_adr_min`** : le trigger reste le seul
  mécanisme **bloquant** (préexistant, sur la suppression du dernier lien fonctionnalité d'une ADR) ;
  la garde heuristique de A013 est **distincte** et **non bloquante**. Aucune contradiction.
- **A009 ne casse pas T2/T3/T4/T5** : paramètres ajoutés **optionnels**, comportement par défaut
  identique (vérifié par non-régression §9).

### 8.2 Plan Validator (Phase 7) — **Valid**

- Contradiction non résolue : **aucune**.
- Exigence non couverte : **aucune** (table §7 complète).
- Étape vague / imprécise : **aucune** (chaque étape = 1 verbe + 1 élément de code + 1 fichier +
  1 raison + 1 livrable).

→ **Plan Valid** ; passage à la Phase 8 (écriture + enregistrement).

---

## 9. Risques & notes

1. **Changement de comportement assumé (à valider)** : `createTask` rattache désormais le **sprint
   par défaut** quand le projet n'a aucun sprint, ce qui rend l'origine `hors_sprint` **rare** sur le
   chemin de création (elle reste produite par `classifyEmergence` appelé directement et en cas
   d'échec de la réparation, capturé en `try/catch`). C'est l'application littérale de
   « tâche → sprint (par défaut si absent) » (ADR-001 §5). Si l'orchestrateur préfère conserver
   `hors_sprint` pour toute tâche créée sans sprint explicite, **A011 doit être ajusté** (retirer le
   rattachement automatique, conserver le signal).
2. **Dérive DDL `schema.sql` (hors périmètre, précédent T5)** : la table `cardinality_signals` sera
   posée **uniquement** dans `migrate()` (`db.mjs`). Le runtime est correct (`migrate()` s'exécute
   après `schema.sql` à chaque `ensureSchema()`), mais `schema.sql` ne sera pas miroité — **tâche de
   suivi** à créer (comme pour les colonnes d'état `task_adr` de T5, cf.
   `reports/report-feature-rule-crud-liaisons-20260921-103723.md` §7.1).
3. **ADR-001 est `Proposé`** (pas `Accepté`) : ce plan l'applique comme référence normative de la
   recette ; l'acceptation reste une **décision humaine**. Aucune ADR `Accepté` n'est contredite.
4. **Bruit de signalement** : une recette neuve (A012) et un sprint neuf (A014) sont **toujours**
   incomplets à la création → un signal OPEN est créé systématiquement. C'est le comportement
   demandé (« signalent et tracent les manques ») ; l'index partiel unique évite les doublons et
   `cardinalityReport` expose `stale` pour distinguer un signal déjà comblé.
5. **Le flag `emergent` n'est pas effacé** après rattachement ultérieur (décision §2.4) : les vues
   affichent l'état **live** (`currentGaps`, `stale`) et le signal peut être résolu (A006). Si
   l'orchestrateur attend un « dé-marquage », cela contredirait « JAMAIS rétroactif » — **à
   confirmer** ; aucune étape ne l'implémente.
6. **`sans_piece`** (commentaire `schema.sql` l.688, héritage T1) n'est **pas** implémenté : hors
   mission. Il est **inclus** dans `EMERGENT_ORIGINS` (A001) pour compatibilité ascendante, mais
   aucune étape ne le produit.
7. **Vérification (à la charge de l'exécutant)** : spawn MCP réel (`initialize` + `tools/list` →
   les 3 nouveaux tools exposés) + script de vérification sous `/tmp/opencode` (jamais dans le repo) :
   - `classifyEmergence` : sprint `open` + `hasFeature=false` → `sans_fonctionnalite` ;
     `fromRecette=true` → `recette` ; sprint `close` → `apres_cloture` ; aucun sprint → `hors_sprint` ;
     appels legacy `{kind:'element'}` / `{kind:'piece'}` → **résultats inchangés** (non-régression) ;
   - `createTask` : (a) projet sans sprint → sprint par défaut créé + lien + origine
     `sans_fonctionnalite` (sprint open) ; (b) avec `featureIds`+`sprintId` → non émergente ;
     (c) signal OPEN présent ; (d) création **jamais** en erreur si la garde échoue (simuler) ;
   - `startRecette` : sprint par défaut + signal recette (`adr`, `fonctionnalite`) ;
   - `checkCardinality` : ADR sans fonctionnalité, sprint sans fonctionnalité/règle, tâche sans ADR
     **effectif** (lien `propose` seul → manque) ;
   - **non-rétroactivité** : après `migrate()` sur la base existante, **0** ligne
     `cardinality_signals` et **0** `emergent` nouvellement posé sur les tâches existantes ;
   - non-régression : `sprint_get`/`sprint_report`, `adr_list`/`adr_get`, `feature_get`, `rule_get`,
     `task_get`, `recette_get`, `piece_list` → OK ; `artifacts` inchangé (comptage avant/après) ;
   - **E2E Playwright : NA** — aucun `playwright.config.*` ni spec dans
     `opencode-mcp-task-orchestrator` ; comportement **interne** (registre + tools MCP), non
     observable par un parcours Playwright (précédent T3/T5). Aucun `e2e_test_register` /
     `e2e_test_link` pour cette tâche.
8. **Isolation** : travail sur une **branche dédiée** (session-guard) ; jamais de modification
   directe de `feature/migration-postgresql`.
