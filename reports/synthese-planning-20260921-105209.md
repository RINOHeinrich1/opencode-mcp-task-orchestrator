# Synthèse de planification — `T-20260921-091735-wmqd` (T6)

- **Date** : 2026-09-21 10:52:09
- **Agent** : `atomic-plan`
- **Tâche** : `T-20260921-091735-wmqd` — exécution `E-T-20260921-091735-wmqd-u3pb5s` — **tâche 6/9** du batch `BATCH-mub1809u-06ow` (recette `RECT-muaz100k-2iq0`)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`, branche `feature/migration-postgresql` @ `6b0573c`)
- **Périmètre** : `db.mjs`, `index.mjs`

---

## 1. Analyse des objectifs (Phase 0)

La demande porte **deux sous-objectifs** :

| # | Sous-objectif | Nature |
|---|---|---|
| O1 | **Gardes heuristiques de cardinalité** (signalement + traçage, non bloquantes) : recette → ≥1 ADR + ≥1 fonctionnalité + 1 sprint (par défaut si absent) ; tâche → sprint (par défaut si absent) + fonctionnalité + ≥1 ADR (proposé→validé) ; ADR → 1..N fonctionnalités ; sprint → 1..N fonctionnalités et 1..N règles ; **vues de traçage** | fonctionnel (registre MCP) |
| O2 | **Gouvernance de l'émergence** : marqueur flag + origine (`hors_sprint` / `apres_cloture` / `sans_fonctionnalite` / `recette`), **JAMAIS rétroactif**, non bloquant, rattachable ultérieurement | fonctionnel (registre MCP) |

**Décision de segmentation : O1 et O2 sont INTERDÉPENDANTS → un seul plan.**
Justification : les manques de cardinalité sont la *cause* du marquage émergent (« les liens
manquants à la création marquent l'élément ÉMERGENT » — ADR-001 §5) et les deux sous-objectifs
modifient **les mêmes fonctions** (`createTask`, `registerFeature`, `registerRule`) dans les
**mêmes fichiers**. Un découpage en deux plans produirait un conflit inter-plans sur la même région
de code (`createTask`). → **1 plan**, séquencé, avec les deux sous-objectifs explicites.

Aucune question à l'utilisateur n'a été nécessaire (segmentation sans ambiguïté après lecture de
l'ADR-001 et des plans T1→T5).

---

## 2. Plans produits

| PlanId | Fichier | Objectif | Étapes | Livrables |
|---|---|---|---|---|
| `Plan-cardinalites-emergence-20260921-105121` | `plans/Plan-cardinalites-emergence-20260921-105121.md` | Cardinalités heuristiques (signalement + traçage, non bloquantes) + gouvernance de l'émergence (flag + origine, jamais rétroactif) + vues de traçage | **24** (`A001`→`A024`) | 10 (table `cardinality_signals` ; constantes ; 7 fonctions de garde ; `classifyEmergence` étendue ; `createTask`/`startRecette`/`registerAdr`/`createSprint`/`registerFeature`/`registerRule` ; 3 tools MCP ; 6 tools enrichis ; vues de traçage ; preuve de non-rétroactivité) |

**Enregistrements** : `plan_register(taskId=T-20260921-091735-wmqd)` ✅ ;
`artifact_add(kind=plan, docType=plan, contentId=T-20260921-091735-wmqd)` → `ART-mub4lcj0-h3v0` ✅ ;
`task_event(PLAN_CREATED)` ✅ ; `participant_add(atomic-plan, planner)` ✅.

### Séquençage (résumé)

- **Lot 1 — fondation** : `A001` constantes → `A002` table `cardinality_signals` → `A003`
  `checkCardinality` (calcul live) → `A004` `recordCardinalitySignal` (trace, jamais bloquant).
- **Lot 2 — lecture/résolution/vues** : `A005` liste des signaux (+`stale`), `A006` résolution
  tracée, `A007` vues de traçage (10), `A008` rapport agrégé.
- **Lot 3 — émergence & rattachement** : `A009` `classifyEmergence` étendue
  (`sans_fonctionnalite`/`recette`, rétrocompatible), `A010` rattachement non bloquant au sprint
  par défaut.
- **Lot 4 — branchements création** : `A011` `createTask`, `A012` `startRecette`, `A013`
  `registerAdr`, `A014` `createSprint`, `A015` `registerFeature`/`registerRule` (origine `recette`).
- **Lot 5 — exposition MCP** : `A016` imports, `A017`→`A019` nouveaux tools,
  `A020`→`A024` tools existants enrichis sans rupture.

---

## 3. Vérifications de cohérence

### 3.1 Intra-plan (Phases 5-7) — **Valid**

- **Couverture** : table `Exigence → Étape` complète (plan §7) — **100 %** des exigences de la
  tâche et des critères d'acceptation sont couverts ; aucune exigence hors périmètre non justifiée.
- **Contradictions** : **aucune**. Pas d'étape `supprimer` ; aucun `créer`+`renommer` sur un même
  élément ; les 7 nouvelles fonctions ont des noms et responsabilités distincts ; graphe de
  dépendances **acyclique** (§6) et chaque étape ne lit que des éléments produits par des étapes
  **antérieures**.
- **Granularité** : 24 étapes atomiques (1 verbe + 1 élément de code + 1 fichier + 1 raison +
  1 livrable). Aucune étape vague.
- **Gate** : **Valid** (aucune révision nécessaire, pas de boucle Phases 5→7).

### 3.2 Globale / inter-plans (Phase 9) — **Aucune incohérence**

- Un seul plan est produit pour cette tâche : pas de conflit inter-plans **interne** à cette
  planification.
- Les tâches du batch **T7** (panneau, repo `opencode-observability`), **T8** (agent session sprint)
  et **T9** (session de migration) ne sont **pas encore planifiées** (`batch_readiness` : `ready=false`,
  `blockedSteps=[]` — elles dépendent de T6) : aucun plan concurrent ne touche `db.mjs`/`index.mjs`.
- Les plans **T1→T5** touchent bien `db.mjs`/`index.mjs`/`schema.sql` mais toutes leurs étapes sont
  `done` et mergées (`6b0573c`) : les étapes T6 sont **additives** et ne réécrivent pas les zones
  livrées (constat confirmé par relecture du code réel : `classifyEmergence` l.898-919,
  `createTask` l.1954-2030, `startRecette` l.4361-4380, `registerAdr` l.3846-3873,
  `createSprint` l.976-1011, `registerFeature` l.1290-1330, `registerRule` l.1450-1489).
- `INCONSISTENCY_FOUND` **non levé** ; aucun blocage.

---

## 4. Points d'attention remontés à l'orchestrateur

1. **Changement de comportement assumé (à valider)** : `createTask` rattachera le **sprint par
   défaut** quand le projet n'a aucun sprint → l'origine `hors_sprint` devient **rare** sur le chemin
   de création (elle reste produite par `classifyEmergence` appelé directement, et en cas d'échec de
   la réparation capturé en `try/catch`). Application littérale d'ADR-001 §5 ; à ajuster si
   l'orchestrateur préfère conserver `hors_sprint` (plan §9.1).
2. **Dérive DDL `schema.sql` (hors périmètre)** : `cardinality_signals` sera posée **uniquement**
   dans `migrate()` (`db.mjs`) — runtime correct, `schema.sql` non miroité → **tâche de suivi**
   (même situation que les colonnes d'état `task_adr` de T5, cf.
   `reports/report-feature-rule-crud-liaisons-20260921-103723.md` §7.1).
3. **ADR-001 `doc-mub10mo8-lgo3` est `Proposé`** (non `Accepté`) : le plan l'applique comme
   référence normative de la recette ; l'acceptation reste une **décision humaine**. Aucune ADR
   `Accepté` n'est contredite. Le fichier `docs/adr/ADR-001-...md` est **absent** du repo
   (contenu de référence = registre).
4. **Le flag `emergent` n'est jamais effacé** après rattachement ultérieur (trace historique) ; les
   vues recalculent l'état **live** (`currentGaps`/`stale`) et le signal peut être résolu
   (`cardinality_signal_resolve`). Si l'orchestrateur attend un « dé-marquage », cela contredirait
   « JAMAIS rétroactif » (plan §9.5) — **à confirmer**.
5. **Bruit de signalement attendu** : recette neuve et sprint neuf sont toujours incomplets à la
   création → un signal OPEN est créé (index partiel unique = 1 open par entité, pas de doublon).

---

## 5. E2E Playwright — analyse d'impact (cadrage 08)

**E2E : NA.** Aucun `playwright.config.*` ni spec E2E dans `opencode-mcp-task-orchestrator` ; le
comportement livré est **interne** (registre + tools MCP), non observable par un parcours Playwright.
Aucun `e2e_test_register` / `e2e_test_link` pour cette tâche (conforme aux précédents T3/T5).
La vérification se fera par **spawn MCP réel** (`initialize` + `tools/list`) et script de
vérification sous `/tmp/opencode` (jamais dans le repo), à la charge de l'exécutant.

---

## 6. Suite

1. L'orchestrateur peut passer la tâche en **`awaiting_validation`** (validation humaine du plan) —
   puis lancer l'exécution (`build`/`build-notify`) sur une **branche dédiée** (session-guard).
2. Points 4.1 et 4.4 ci-dessus méritent une confirmation humaine **avant** exécution (ils changent
   des comportements observables de `createTask`).
3. Après T6 : T7 (panneau — consommera `cardinality_report` / `cardinality_signals_list`),
   T8 (agent session sprint), T9 (session de migration — **association** des éléments existants,
   **sans** marquage émergent).
