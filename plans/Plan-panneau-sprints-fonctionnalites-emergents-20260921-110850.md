# Plan — Panneau : sprints, rapport de sprint, Fonctionnalités/Règles métier, émergents

- **Plan ID** : `Plan-panneau-sprints-fonctionnalites-emergents-20260921-110850`
- **Tâche** : `T-20260921-091736-yqwv` (exécution `E-T-20260921-091736-yqwv-heumu4`) — tâche 7/9 du batch `BATCH-mub1809u-06ow`
- **Projet** : `ecosystem`
- **Repo** : `opencode-observability` → `/root/orchestrator-panel` (branche de travail dédiée via session-guard, jamais `feature/migration-postgresql` en direct)
- **Périmètre** : `server.mjs`, `public/app.js`, `pilot.mjs`, `session-bridge.mjs` (ce dernier **non modifié**, voir §4)
- **Date** : 2026-09-21 11:08:50

---

## 1. Objectif

Exposer, **côté PANNEAU** (`opencode-observability`), la consommation des familles MCP livrées par
T4/T5/T6, sans réimplémenter la logique (le registre reste la source de vérité) :

1. **Sprints** : liste par projet (titre, dates, statut `open`/`close`), création à **durée
   paramétrable**, boutons **CLÔTURER** / **REPRENDRE** (réouverture), **rattachement des pièces
   client** ;
2. **RAPPORT DE SPRINT téléchargeable** : export généré **côté registre** via `sprint_report`
   (fonctionnalités implémentées/émergentes, tâches effectuées/émergentes, règles et
   fonctionnalités émergentes, pièces rattachées), affiché puis **téléchargé** ;
3. **Onglet « Fonctionnalités / Règles métier »** : table (Ref, rôle, user story), règles métier,
   liens fonctionnalité↔règle / ↔scénario Gherkin / ↔ADR, **visibilité des rattachements
   sprint/tâches/recettes**, CRUD (l'agent propose, l'humain valide) ;
4. **Vue des ÉLÉMENTS ÉMERGENTS par projet** : tâches sans ADR / sans fonctionnalité / sans sprint,
   recettes sans ADR/fonctionnalité/sprint, ADR sans fonctionnalité, sprint sans
   fonctionnalité/règle, pièces après clôture, règles/fonctionnalités émergentes — **s'appuyant
   sur `cardinality_report` / `cardinalityView`** (T6) ;
5. l'onglet **« Artefacts »** montre les **pièces client par projet avec leur nature**.

**Un seul plan.** Les 5 sous-objectifs sont **interdépendants** : ils partagent le **même registre
d'onglets** (`PROJECT_TABS`/`RENDER`), la **même chaîne de routes** (`server.mjs`) et les **mêmes
wrappers** (`pilot.mjs`) ; le **rapport de sprint** est attaché à une ligne de sprint (objectif 1) ;
la **vue des émergents** (objectif 4) découle de la **clôture de sprint** (objectif 1) et des
éléments fonctionnalités/règles (objectif 3). Les scinder créerait des conflits inter-plans sur des
régions de fichiers identiques → **un plan unique, séquencé** (§6).

---

## 2. Contexte & raison d'être

- La recette `RECT-muaz100k-2iq0` (« Règle métier plus cadrer dans l'écosystème ») a produit 9 tâches.
  Les tâches **T1→T6 sont TERMINÉES** :
  - **T1** modèle SQL (`fonctionnalites`, `regles_metier`, `sprints` + 9 tables de liens N:N) ;
  - **T2** pièces client (`doc_type='piece'`) + émergence ;
  - **T3** cycle de vie sprint (`closeSprint`/`autoCloseExpiredSprints`/`reopenSprint`/
    `classifyEmergence`/`buildSprintReport`) ;
  - **T4** famille MCP `sprint_start`/`sprint_list`/`sprint_get`/`sprint_close`/`sprint_reopen`/
    `sprint_attach_pieces` + `sprint_report` ;
  - **T5** familles `feature_*`/`rule_*` + outils de liaison (`feature_rule_link`,
    `feature_gherkin_link`, `feature_adr_link`, `feature_sprint_link`, `rule_sprint_link`,
    `task_sprint_link`, `task_feature_link`, `recette_sprint_link`, `recette_feature_link` + unlink) ;
  - **T6** cardinalités heuristiques (`cardinality_report`, `cardinality_signals_list`,
    `cardinality_signal_resolve`) + les **10 vues** `cardinalityView`.
- **T7 (ce plan)** = **consommation panneau**. Le MCP (repo `opencode-mcp-task-orchestrator`) est
  **hors périmètre** : aucune modification de `index.mjs`/`db.mjs`.
- **ADR de référence** : `doc-mub10mo8-lgo3` — « **ADR-001 — Modèle sprint / fonctionnalités /
  règles métier dans le registre ecosystem** », **statut `Proposé`** (non encore acceptée — décision
  humaine), **globale** aux 3 repos du projet `ecosystem`. Ses §3 (sprint = unité de temps,
  durée paramétrable) et §5 (clôture de sprint = **action officielle** qui bascule la garde
  d'émergence ; émergence **non bloquante**, signalée/tracée) sont la **source normative** de ce
  plan. Aucune ADR **Accepté** n'existe sur ce périmètre : l'implémentation est **additive** et ne
  contredit aucune décision actée.
- **Patterns existants à réutiliser (cohérence UX, aucune duplication)** :
  - onglet **ADR du projet** (`renderAdrs` app.js l.4614, `adrTableHtml`/`bindAdrTable` l.4471/4535,
    `adrFormModal` l.4729) — modèle de table + CRUD + filtres + modale ;
  - **gestionnaire Artefacts** (`renderArtifacts` app.js l.1229, `artRow` l.1217,
    `artAddModal` l.1291) ;
  - **pièces client** (`piecesTabHtml` app.js l.4074, routes `/api/pieces` server.mjs l.1737-1814,
    wrappers `pilot.listPieces`/`addPiece`/`removePiece` l.633-667) ;
  - **routes + `sendJson`** server.mjs (`registryArtifacts` l.457, `createArtifactCentral` l.509,
    `DOC_TYPES` l.447 inclut déjà `"piece"`) ;
  - **wrappers MCP** pilot.mjs (`taskOrchestrator(tool, args)` via `mcp-client.mjs`, ex.
    `listDocs` l.539, `listAdrs` l.671) ;
  - **téléchargement** `Content-Disposition` (routes `/api/docs/:id/download` l.1922,
    `/api/pieces/file` l.1794) ; **rendu markdown** `/api/render-md` (server.mjs l.1500) /
    `artViewModal` (app.js l.1279).
- **Contraintes de non-régression** : ne pas casser les onglets existants (`overview`, `tasks`,
  `recettes`, `e2etests`, `decisions`, `artifacts`, `adr`, `e2esecrets`, `archives`) ni le modal
  Détail Projet (sous-onglet « Pièces client ») ; ne pas dupliquer les vues pièces/artefacts déjà
  livrées ; **aucune modification de `public/style.css`** (hors périmètre) → réutiliser les classes
  CSS existantes (`pd-tabs`, `recette-list`, `recette-item`, `badge`, `chip`, `muted-sm`,
  `e2e-actions`, `art-*`, `adr-*`, `modal`, `pilot-form`) + styles inline ponctuels.

### Décisions de conception (à respecter par l'exécutant)

1. **Aucune écriture directe en base** : tout passe par `pilot.mjs` → `taskOrchestrator` (MCP).
2. **La clôture de sprint via le panneau** (`sprint_close` → `closeSprint`) **et** la clôture
   automatique à l'échéance (`sprint_list` applique `autoCloseExpiredSprints` avant lecture) sont
   les **actions officielles** qui basculent la garde d'émergence — le panneau **ne recalcule
   jamais** l'émergence lui-même, il **affiche** l'état renvoyé par le registre.
3. **Rapport de sprint** : généré par `sprint_report` (registre), **affiché** (markdown) puis
   **téléchargé** (`Content-Disposition: attachment`, nom `rapport-sprint-<sprintId>.md`).
4. **Liens N:N** : un **dispatcher unique** `pilot.linkEntities(kind, a, b)` / `unlinkEntities`
   mappe 9 `kind` vers les 9 tools MCP — évite 18 routes dédiées.
5. **CRUD fonctionnalités/règles** : `feature_register`/`feature_update`/`rule_register`/
   `rule_update` (l'agent propose via le registre, **l'humain valide/ajuste** dans le panneau).
   Pas de nouveau workflow de validation côté panneau (le workflow propose→valide de T5 concerne
   les liens ADR de tâche, déjà exposé ailleurs ; hors mission ici).
6. **Émergents** : lecture **seule** de `cardinality_report` (10 vues + signaux) ; la clôture d'un
   signal (`cardinality_signal_resolve`) exige une **résolution tracée obligatoire** (miroir de
   `resolveAdrVigilance`).
7. **Onglet Artefacts** : ajouter `'piece'` à `DOC_TYPE_LIST` et afficher la **nature** de
   l'artefact (colonne `nature` déjà renvoyée par `registryArtifacts` via `SELECT a.*`) — pour les
   pièces, `nature` ∈ {markdown, pdf, docx, lien}.

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | créer | bloc de wrappers `listSprints`, `getSprintDetail`, `createSprint`, `closeSprint`, `reopenSprint`, `attachSprintPieces`, `sprintReport` (inséré après `removePiece`, l.667) | `pilot.mjs` | `pilot.mjs` | Pont panneau→MCP `sprint_*` (source de vérité, aucune écriture DB directe) | 7 fonctions exportées appelant `sprint_list`/`sprint_get`/`sprint_start`/`sprint_close`/`sprint_reopen`/`sprint_attach_pieces`/`sprint_report` |
| A002 | créer | bloc de wrappers `listFeatures`, `getFeature`, `createFeature`, `updateFeature`, `listRules`, `getRule`, `createRule`, `updateRule` (même bloc) | `pilot.mjs` | `pilot.mjs` | Pont panneau→MCP `feature_*`/`rule_*` (CRUD) | 8 fonctions exportées appelant `feature_list`/`feature_get`/`feature_register`/`feature_update`/`rule_list`/`rule_get`/`rule_register`/`rule_update` |
| A003 | créer | `linkEntities(kind, a, b)` + `unlinkEntities(kind, a, b)` (dispatcher 9 relations) (même bloc) | `pilot.mjs` | `pilot.mjs` | Un point d'entrée pour les 9 liens N:N (évite 18 routes) | Dispatcher exporté + table `LINK_TOOLS` mappant `feature_rule`\|`feature_gherkin`\|`feature_adr`\|`feature_sprint`\|`rule_sprint`\|`task_sprint`\|`task_feature`\|`recette_sprint`\|`recette_feature` → tool `*_link`/`*_unlink` |
| A004 | créer | `cardinalityReport({projectId, view})`, `listCardinalitySignals(args)`, `resolveCardinalitySignal({signalId, resolution, resolvedBy})` (même bloc) | `pilot.mjs` | `pilot.mjs` | Pont panneau→MCP `cardinality_*` (T6) | 3 fonctions exportées ; `resolution` obligatoire (miroir `resolveAdrVigilance` l.713) |
| A005 | ajouter | routes sprints (insérées après le bloc pièces, l.1814) : `GET /api/sprints`, `POST /api/sprints`, `GET /api/sprints/:id`, `POST /api/sprints/:id/close`, `POST /api/sprints/:id/reopen`, `POST /api/sprints/:id/pieces`, `GET /api/sprints/:id/report` | `server.mjs` | `server.mjs` | Exposer la famille `sprint_*` + **rapport téléchargeable** | Routes JSON + route rapport (`?download=1` → `Content-Disposition`) |
| A006 | ajouter | routes fonctionnalités/règles + dispatcher liens : `GET/POST /api/features`, `GET/PUT /api/features/:id`, `GET/POST /api/rules`, `GET/PUT /api/rules/:id`, `POST /api/links`, `DELETE /api/links/:kind/:a/:b` | `server.mjs` | `server.mjs` | Exposer `feature_*`/`rule_*` + les 9 liens N:N | Routes CRUD + routes de liaison (dispatcher) |
| A007 | ajouter | routes cardinalité : `GET /api/cardinality`, `GET /api/cardinality/signals`, `POST /api/cardinality/signals/:id/resolve` | `server.mjs` | `server.mjs` | Exposer `cardinality_*` (vue émergents + signaux) | 3 routes JSON |
| A008 | modifier | `PROJECT_TABS` (l.110-120) + objet `RENDER` (l.6049-6052) | `public/app.js` | `public/app.js` | Enregistrer les 3 nouveaux onglets (infra partagée) | `['sprints','Sprints']`, `['features','Fonctionnalités / Règles']`, `['emergents','Émergents']` + `RENDER.sprints/features/emergents` |
| A009 | créer | `renderSprints()` + helpers (table, modales créer/rattacher, boutons clôturer/reprendre) — inséré après `renderAdrs` (l.4632) | `public/app.js` | `public/app.js` | Onglet Sprints (liste, création durée paramétrable, CLÔTURER/REPRENDRE, pièces) | Onglet Sprints fonctionnel (données `GET /api/sprints`) |
| A010 | créer | `sprintReportModal(sprintId)` (affichage markdown + bouton télécharger) — inséré à côté de `renderSprints` | `public/app.js` | `public/app.js` | Rapport de sprint **téléchargeable** (généré par le registre) | Modale rapport + téléchargement `GET /api/sprints/:id/report?download=1` |
| A011 | créer | `renderFeaturesRules()` + helpers (2 tables, colonnes de liens, panneau détail, modales CRUD + liaison) | `public/app.js` | `public/app.js` | Onglet « Fonctionnalités / Règles métier » | Onglet complet (table Ref/rôle/user story, règles, liens, rattachements, CRUD) |
| A012 | créer | `renderEmergents()` + helpers (vues `cardinality_report`, signaux + clôture tracée, pièces émergentes) | `public/app.js` | `public/app.js` | Vue des **éléments émergents** par projet | Onglet Émergents (10 vues + signaux + pièces) |
| A013 | modifier | `DOC_TYPE_LIST` (l.1212) + `artRow` (l.1217-1227) | `public/app.js` | `public/app.js` | Montrer les **pièces client par projet avec leur nature** dans l'onglet Artefacts | `'piece'` ajouté + nature affichée (`a.nature`) |

---

## 4. Fichiers concernés

| Fichier | Type de modification | Zones touchées |
|---------|----------------------|----------------|
| `pilot.mjs` | modification (additive) | insertion d'un bloc après `removePiece` (l.667), avant le commentaire « Famille ADR » (l.669) : wrappers sprint / feature-rule / liens / cardinalité |
| `server.mjs` | modification (additive) | insertion des routes sprint / feature-rule / cardinalité après le bloc pièces (l.1814), avant le bloc « Pièces jointes d'ADR » (l.1815). `DOC_TYPES` (l.447) **déjà** conforme (`"piece"` présent) — **aucune** modification |
| `public/app.js` | modification | `PROJECT_TABS` (l.110-120) ; `RENDER` (l.6049-6052) ; `DOC_TYPE_LIST` (l.1212) ; `artRow` (l.1217-1227) ; nouvelles fonctions `renderSprints`/`sprintReportModal`/`renderFeaturesRules`/`renderEmergents` insérées après `renderAdrs` (l.4632) |
| `public/style.css` | **hors périmètre** | aucune modification — réutilisation des classes existantes + styles inline |
| `session-bridge.mjs` | **non modifié** | la mission n'exige aucun lancement de session IA liée au sprint (le `sessionId` optionnel de `sprint_start` n'est pas exposé par le panneau) |
| `index.mjs` / `db.mjs` (repo MCP) | **hors périmètre** | T1→T6 livrés ; aucune modification |

Aucune suppression de fichier. Aucun nouveau fichier dans le repo panneau.

---

## 5. Livrables attendus

1. `pilot.mjs` : wrappers exportés `listSprints`, `getSprintDetail`, `createSprint`, `closeSprint`,
   `reopenSprint`, `attachSprintPieces`, `sprintReport`, `listFeatures`, `getFeature`,
   `createFeature`, `updateFeature`, `listRules`, `getRule`, `createRule`, `updateRule`,
   `linkEntities`, `unlinkEntities`, `cardinalityReport`, `listCardinalitySignals`,
   `resolveCardinalitySignal`.
2. `server.mjs` : routes `/api/sprints*`, `/api/features*`, `/api/rules*`, `/api/links*`,
   `/api/cardinality*` fonctionnelles, **avec** la route rapport de sprint téléchargeable.
3. `public/app.js` : onglet **Sprints** (liste dates/statut, création durée paramétrable,
   **CLÔTURER**/**REPRENDRE**, rattachement pièces client), **rapport de sprint téléchargeable**,
   onglet **Fonctionnalités / Règles métier** (table Ref/rôle/user story, règles, liens
   règle/Gherkin/ADR, visibilité rattachements sprint/tâches/recettes, CRUD), onglet **Émergents**
   (10 vues `cardinalityView` + signaux + pièces émergentes), onglet **Artefacts** montrant les
   pièces client par projet **avec leur nature**.
4. La **clôture d'un sprint** (bouton panneau ou échéance auto) est l'action officielle qui bascule
   la garde d'émergence : après clôture, les éléments suivants apparaissent **émergents** dans
   l'onglet Émergents (état renvoyé par le registre, jamais recalculé côté panneau).
5. Aucune régression : les onglets et le modal Détail Projet existants restent inchangés.

---

## 6. Ordre & dépendances

Graphe (Phase 4) :

```
A001 ─┐
A002 ─┼─→ A005 ─┬─→ A009 ─→ A010
A003 ─┘         └─→ (rapport)
A002 ─┐
A003 ─┼─→ A006 ─→ A011
A004 ───→ A007 ─→ A012
A008 ─→ A009, A011, A012
A013  (indépendant : app.js, onglet Artefacts)
```

Enchaînement linéaire recommandé :

`A001 → A002 → A003 → A004 → A005 → A006 → A007 → A008 → A009 → A010 → A011 → A012 → A013`

Prérequis stricts :

- **A001/A002/A003/A004 avant A005/A006/A007** (les routes appellent les wrappers).
- **A005 avant A009/A010** (l'onglet Sprints et le rapport consomment `/api/sprints*`).
- **A006 avant A011** (l'onglet Fonctionnalités/Règles consomme `/api/features*`, `/api/rules*`,
  `/api/links*`).
- **A007 avant A012** (l'onglet Émergents consomme `/api/cardinality*`).
- **A008 avant A009/A011/A012** (les onglets doivent être enregistrés dans `PROJECT_TABS`/`RENDER`
  pour être affichés/rafraîchis ; `RENDER` référence des déclarations de fonction — **hoisting**,
  donc l'ordre d'insertion dans le fichier n'est pas un prérequis d'exécution, mais A008 doit être
  présent pour la navigation).
- **A013 indépendant** (n'ajoute ni route ni onglet : modifie une constante et une ligne de rendu
  de l'onglet Artefacts existant).

Aucune étape ne dépend d'une étape ultérieure. Aucune étape n'est bloquée par T8/T9.

---

## 7. Couverture des objectifs

| Exigence (tâche `T-20260921-091736-yqwv`) | Étape(s) | Couvert ? |
|---|---|---|
| Sprint : liste par projet (titre, dates, statut open/close) | A001, A005, A009 | ✅ |
| Sprint : création avec **durée paramétrable** | A001, A005, A009 | ✅ |
| Sprint : bouton **CLÔTURER** | A001, A005, A009 | ✅ |
| Sprint : bouton **REPRENDRE** (réouverture) | A001, A005, A009 | ✅ |
| Sprint : rattachement des **pièces client** | A001, A005, A009 | ✅ |
| **RAPPORT DE SPRINT téléchargeable** (généré via `sprint_report` puis téléchargé) | A001, A005, A010 | ✅ |
| Rapport : fonctionnalités implémentées / émergentes, tâches effectuées / émergentes, règles métier et fonctionnalités émergentes, pièces rattachées | A001, A005, A010 | ✅ |
| Onglet « Fonctionnalités / Règles métier » : table **Ref, rôle, user story** | A002, A006, A011 | ✅ |
| Onglet : **règles métier** | A002, A006, A011 | ✅ |
| Onglet : liens **fonctionnalité↔règle** | A003, A006, A011 | ✅ |
| Onglet : liens **fonctionnalité↔scénario Gherkin** | A003, A006, A011 | ✅ |
| Onglet : liens **fonctionnalité↔ADR** | A003, A006, A011 | ✅ |
| Onglet : **visibilité des rattachements sprint/tâches/recettes** | A001, A003, A006, A011 | ✅ |
| Onglet : **CRUD** (l'agent propose, l'humain valide) | A002, A006, A011 | ✅ |
| **Vue des ÉLÉMENTS ÉMERGENTS** par projet (tâches sans ADR/sans fonctionnalité, pièces après clôture, règles émergentes…) | A004, A007, A012 | ✅ |
| Émergents : s'appuyer sur les vues **`cardinalityView`/`cardinality_report`** (T6) | A004, A007, A012 | ✅ |
| **Clôture de sprint** = action officielle qui bascule la garde d'émergence | A005, A009, A012 | ✅ |
| Onglet « **Artefacts** » : pièces client par projet **avec leur nature** | A013 | ✅ |
| Non-régression onglets/modal existants | A008 (additif), A013 (additif) | ✅ |

Toutes les exigences de la tâche sont couvertes par au moins une étape atomique.

---

## 8. Vérification de cohérence

**Contradictions intra-plan (Phase 6)** — regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `pilot.mjs` (bloc après l.667) | A001, A002, A003, A004 | ✅ insertions **additives** contiguës, aucun verbe `supprimer`/`renommer` concurrent |
| `server.mjs` (routes après l.1814) | A005, A006, A007 | ✅ blocs de routes **additifs** distincts (préfixes d'URL disjoints : `/api/sprints*`, `/api/features*`+`/api/rules*`+`/api/links*`, `/api/cardinality*`) |
| `public/app.js` `PROJECT_TABS` + `RENDER` | A008 | ✅ seule étape touchant ces deux constantes |
| `public/app.js` onglet Sprints | A009, A010 | ✅ A010 fournit `sprintReportModal` (déclaration de fonction, **hoistée**) appelée par A009 — aucune contradiction ; A010 est une **création** complémentaire, pas un doublon |
| `public/app.js` onglet Fonctionnalités/Règles | A011 | ✅ zone distincte |
| `public/app.js` onglet Émergents | A012 | ✅ zone distincte |
| `public/app.js` onglet Artefacts (`DOC_TYPE_LIST` + `artRow`) | A013 | ✅ modification **additive** (ajout `'piece'` + colonne nature), aucune suppression |

Aucun couple `supprimer` + autre action sur un même élément. Aucun `créer` + `renommer` sur un
élément créé. Aucune étape ne lit/modifie un élément créé par une étape **ultérieure** (les
déclarations de fonctions JS sont hoistées ; les routes ne référencent que des wrappers créés en
amont). **Aucune contradiction.**

**Plan Validator (Phase 7)** : couverture 100 % (§7), étapes atomiques (élément × fichier × verbe),
aucune contradiction → **Valid**.

**Cohérence globale inter-plans (Phase 9)** : plan unique pour cette tâche → aucun conflit
inter-plans. À noter : T6 a produit `Plan-cardinalites-emergence-*` (repo MCP, `db.mjs`/`index.mjs`)
— **périmètres disjoints** du présent plan (repo panneau), aucun chevauchement de fichiers.

---

## 9. Risques & notes

1. **`pilot.mjs` spawn un process MCP par appel** (timeout 30 s, `mcp-client.mjs` l.17) : les listes
   volumineuses peuvent être lentes. Mitigation : `feature_list`/`rule_list` avec `limit` raisonnable
   (défaut MCP 500) ; pas d'appel en boucle côté serveur.
2. **`public/style.css` hors périmètre** : réutiliser impérativement les classes existantes ; tout
   ajustement visuel passe par des styles inline ponctuels (pratique déjà employée dans le fichier).
3. **Clôture auto à l'échéance** : `sprint_list` applique `autoCloseExpiredSprints` **avant** lecture ;
   le panneau n'a donc rien à faire de spécial — il affiche l'état reçu. Ne jamais tenter de
   recalculer l'émergence côté panneau.
4. **Rapport de sprint** : la génération se fait côté registre (`sprint_report`) ; le panneau se
   limite à l'affichage et au téléchargement. Le `Content-Type` markdown est déjà présent dans `MIME`
   (server.mjs l.105).
5. **`feature_adr_unlink`** : une ADR garde ≥1 fonctionnalité (trigger T1) — l'erreur du registre est
   remontée telle quelle par la route (aucun contournement côté panneau).
6. **Traçabilité d'isolation** : la branche de travail dédiée est gérée par `session-guard` ; aucune
   modification directe de `feature/migration-postgresql`. Événements `task_event` sur
   `T-20260921-091736-yqwv` (`PLANNING_STARTED`, `PLAN_CREATED`) + `plan_register(taskId=…)` +
   `artifact_add(kind=plan)`.

### Tests E2E Playwright — analyse d'impact

- **Existante** : le repo panneau `/root/orchestrator-panel` **ne contient aucun harnais Playwright**
  (pas de `playwright.config.*`, aucun `*.spec.ts` hors `node_modules`) et `e2e_list(project=ecosystem)`
  renvoie **0 test**. Le projet `ecosystem` n'a pas de `e2eRepoDir` configuré pour
  `opencode-observability`.
- **Décision : E2E NA** (aucun scénario `create`/`update`/`delete` enregistré, aucune création « en
  aveugle » d'entité E2E sans spec file réel).
- **Stratégie recommandée (documentée, à réaliser quand un harnais existera)** :
  - `create` — « Créer un sprint à durée paramétrable puis le clôturer » : ouvre un projet, onglet
    Sprints, crée un sprint (dates), vérifie le statut `open`, clique **CLÔTURER**, vérifie `close`,
    clique **REPRENDRE**, vérifie `open` ;
  - `create` — « Rapport de sprint téléchargeable » : clôture un sprint, ouvre le rapport, vérifie le
    contenu (fonctionnalités/tâches/pièces) et le téléchargement ;
  - `create` — « Éléments émergents après clôture » : crée une tâche/pièce après clôture, vérifie son
    apparition dans l'onglet Émergents ;
  - `create` — « CRUD fonctionnalité + lien règle/Gherkin/ADR » : crée une fonctionnalité, la lie,
    vérifie les colonnes de rattachement ;
  - `keep` (non-régression) — les onglets ADR/Artefacts/Tâches existants restent fonctionnels.
  Ces scénarios devront être **enregistrés via `e2e_test_register`** (projet `ecosystem`, repo source
  `opencode-observability`, `repoIds` = repos traversés) **au moment où un harnais Playwright sera
  ajouté** au repo panneau.
