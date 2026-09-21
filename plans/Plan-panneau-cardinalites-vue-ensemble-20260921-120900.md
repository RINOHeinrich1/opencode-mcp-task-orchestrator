# Plan — Panneau : retirer l'onglet « Émergents », déplacer les cardinalités en cartes statistiques cliquables dans la Vue d'ensemble

- **Plan ID** : `Plan-panneau-cardinalites-vue-ensemble-20260921-120900`
- **Tâche** : `T-20260921-120633-mtl2` (exécution `E-T-20260921-120633-mtl2-jai3ti`)
- **Projet** : `ecosystem`
- **Repo** : `opencode-observability` → `/root/orchestrator-panel` (branche de travail dédiée via session-guard, jamais `feature/migration-postgresql` @ `5299d4c` en direct)
- **Tâche liée** : `T-20260921-091736-yqwv` (`emergent` — c'est là que l'onglet « Émergents » a été livré, commit `70b445f`, et que le pattern de filtres de pages a été posé)
- **Périmètre** : `public/app.js`, `public/style.css`, `server.mjs`, `pilot.mjs` — **seuls `public/app.js` et `public/style.css` sont modifiés** (`server.mjs`/`pilot.mjs` **non modifiés**, voir §4)
- **Date** : 2026-09-21 12:09:00

---

## 1. Objectif

Refondre la restitution des **cardinalités** dans le panneau (repo `opencode-observability`) :

1. **SUPPRIMER** l'onglet « Émergents » de la navigation projet (`PROJECT_TABS`) et son renderer dédié
   (`RENDER.emergents` + `renderEmergents()` + la constante `CARDINALITY_VIEW_LABELS`).
2. **DÉPLACER** son contenu dans la **« Vue d'ensemble »** (onglet `overview`, renderer existant
   `renderOverview`) sous forme de **CARTES avec STATISTIQUES** : une carte par indicateur de
   cardinalité (10 indicateurs), valeur = compteur de `GET /api/cardinality` → `counts`.
3. **CARTES CLIQUABLES** : le clic redirige vers la **page cible** avec le **FILTRE adapté
   pré-appliqué et visible** (onglet + filtre visibles dans l'UI).
4. **AJOUTER les filtres cibles manquants** aux pages concernées pour que le clic aboutisse à une
   **liste réellement filtrée** (pas seulement un changement d'onglet).
5. **Conserver l'accès aux signaux de cardinalité** (clôture tracée, résolution obligatoire) depuis
   la Vue d'ensemble via un **point d'entrée discret** (bouton ouvrant un panneau modal), sans table
   volumineuse affichée en permanence.
6. Ne pas casser les onglets/filtres existants ; réutiliser les patterns UI existants (cartes,
   chips, selects de filtre) pour la cohérence.

**Un seul plan.** Les 6 sous-objectifs sont **interdépendants** : la suppression de l'onglet (1) et
les cartes (2) libèrent le contenu déplacé ; les cartes cliquables (3) n'aboutissent que si les
filtres cibles existent (4) ; le point d'entrée signaux (5) réutilise le code de l'ancien renderer ;
le tout partage le **même registre d'onglets** (`PROJECT_TABS`/`RENDER`), la **même route de données**
(`/api/cardinality`) et les **mêmes régions de `public/app.js`**. Les scinder créerait des conflits
inter-plans sur des régions de fichier identiques → **un plan unique, séquencé** (§6).

---

## 2. Contexte & raison d'être

- L'onglet « Émergents » a été livré en **T7** (`T-20260921-091736-yqwv`, commit `70b445f` :
  `PROJECT_TABS` + `RENDER` + `renderEmergents` = 10 vues `cardinalityView` en tables `<details>` +
  une table de signaux). Après livraison, l'utilisateur le juge **inadapté** : une table volumineuse
  affichée en permanence pour des indicateurs qui sont avant tout des **compteurs à cliquer**.
- La demande est une **évolution UX** (pas de nouvelle donnée) : la route `GET /api/cardinality?projectId=…`
  **existe déjà** (livrée en T6) et renvoie `{ projectId, generatedAt, counts, views, signals }`
  (`pilot.cardinalityReport` l.919-925 → `cardinalityReport` `db.mjs` l.2613-2638). **Aucune nouvelle
  route de données n'est nécessaire** : les filtres cibles sont dérivés des **items des vues** déjà
  renvoyées (`views[<vue>].items[].id`).
- **ADR de référence** : aucune ADR `Accepté` n'existe pour le projet `ecosystem`
  (`adr_list(projectId=ecosystem)` → 0). Le plan est **additif/UX** et ne contredit aucune décision
  actée. À noter : `Plan-cardinalites-emergence-*` (repo MCP, T6) est la source normative des 10 vues
  et du caractère **non bloquant** de l'émergence ; il n'est pas modifié (repo MCP hors périmètre).
- **Patterns existants à réutiliser (cohérence UX, aucune duplication)** :
  - cartes statistiques de la Vue d'ensemble : `.cards` / `.card` / `.card .num` / `.card .lbl`
    (`style.css` l.82-85 ; `renderOverview` `app.js` l.462-489) ;
  - barres de filtres : `.filters` (Tâches/Recettes), `.adr-pane-filters` (Sprints/ADR/Fonctionnalités),
    chips `.status-chip`/`.chip-x` (Tâches/Recettes) ;
  - modale : `showModal` / `closeModal` (`app.js` l.3372/3378), table `.adr-table-wrap`/`.adr-table`,
    `badge`, `chip`, `muted-sm` ;
  - filtrage **client** déjà en place : `tasksStatusFilter`/`tasksUserFilter`/`tasksNeedRecette`/
    `tasksActifOnly` (`app.js` l.13-25, `apply()` l.580-602), `recettesUserFilter` (l.18, l.2527),
    filtres ADR `adrFilters` + `adrRowVisible` (l.4467-4603).
- **Contraintes de non-régression** : les onglets `overview`, `tasks`, `recettes`, `e2etests`,
  `decisions`, `artifacts`, `adr`, `sprints`, `features`, `e2esecrets`, `archives` et leurs filtres
  continuent de fonctionner ; `node --check` OK. Les panes sont créées à la demande
  (`ensurePane` l.83-91), donc retirer l'onglet `emergents` **n'exige aucune modification de
  `public/index.html`**.

### Décisions de conception (à respecter par l'exécutant)

1. **Cible de la carte « Éléments émergents » → onglet `tasks` + filtre « Émergentes »**
   (id-set de la vue `emergents` restreinte à `entityType === 'task'`). Justification : la vue
   `emergents` agrège **4 types** (`task`, `fonctionnalite`, `regle`, `piece`, `db.mjs` l.2584-2606) ;
   aucune page unique ne les affiche tous. Les **tâches** sont l'entité porteuse principale du flag
   (`tasks.emergent`) et l'onglet le plus actionnable ; les fonctionnalités/règles/pièces émergentes
   restent consultables via le **panneau discret** (§5) qui les liste par type. *Alternative
   écartée* : rediriger vers `features` (ne couvre ni tâches ni pièces) ou vers un onglet dédié
   (contredit la suppression demandée).
2. **Forme des filtres = ENSEMBLE D'IDS issu de la vue cardinalité, appliqué côté client.** Chaque
   filtre cible charge `GET /api/cardinality?projectId=…` (mise en cache 15 s) et ne conserve que
   les lignes dont l'`id` appartient à la vue correspondante (`tache_sans_*`, `recette_sans_*`,
   `adr_sans_fonctionnalite`, `sprint_sans_*`, `emergents`). Avantages : **réutilise la route
   existante** (aucune nouvelle route, aucun changement de schéma/`server.mjs`), sémantique
   **identique** à celle du registre (les vues sont la source de vérité de l'émergence), filtrage
   instantané. Le filtre est exposé par un **`<select>` visible** dans la barre de filtres de la
   page (valeur par défaut « tous » = non-régression) et **persisté** (`localStorage`) comme les
   filtres existants.
3. **Pas de recalcul d'émergence côté panneau** : le panneau **affiche** les compteurs et les
   ensembles d'ids renvoyés par le registre ; il ne recalcule jamais la cardinalité.
4. **Point d'entrée discret** : un bouton `#card-signals-open` (« Signaux de cardinalité — N
   ouvert(s) ») dans la section Vue d'ensemble ouvre une **modale** reprenant la table des signaux
   et la clôture **tracée** (résolution obligatoire). La table n'est **plus affichée en permanence**.

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | supprimer | entrée `['emergents', 'Émergents']` du tableau `PROJECT_TABS` (l.120) | `public/app.js` | `public/app.js` | Retirer l'onglet de la navigation projet | `PROJECT_TABS` sans `emergents` |
| A002 | supprimer | propriété `emergents: renderEmergents,` de l'objet `RENDER` (l.6694) | `public/app.js` | `public/app.js` | Retirer le renderer dédié du registre de rendu | `RENDER` sans `emergents` |
| A003 | supprimer | bloc commentaire « ONGLET ÉMERGENTS » (l.5196-5201) + constante `CARDINALITY_VIEW_LABELS` (l.5203-5214) + fonction `renderEmergents()` (l.5216-5274) | `public/app.js` | `public/app.js` | Supprimer le renderer et le libellé devenus inutiles | Emplacement l.5196 libéré, plus de `renderEmergents`/`CARDINALITY_VIEW_LABELS` |
| A004 | créer | constante `CARDINALITY_CARDS` (10 entrées `{view, label, tab, filter}`) + `cardinalityReportCached(projectId)` (cache 15 s) + `cardinalityIdSet(rep, view, entityType)` (à l'emplacement libéré par A003) | `public/app.js` | `public/app.js` | Socle unique : config des cartes + accès mutualisé à `/api/cardinality` + extraction d'id-set | `CARDINALITY_CARDS` (10) + 2 helpers |
| A005 | modifier | `renderOverview()` (l.462-489) : ajouter la section « Cardinalités & émergence » (grille `.cards` de 10 cartes `.card.card-link` `data-card-view`, `.num` = compteur, `.lbl` = libellé) + bouton `#card-signals-open` (discret), uniquement si `currentProject` ; câblage `[data-card-view]` → `openCardinalityTarget`, `#card-signals-open` → `cardinalitySignalsModal()` | `public/app.js` | `public/app.js` | Déplacer les cardinalités en cartes statistiques cliquables dans la Vue d'ensemble | Vue d'ensemble : 10 cartes + point d'entrée signaux |
| A006 | créer | `openCardinalityTarget(view)` (près de `goToTab`, l.327) | `public/app.js` | `public/app.js` | Traduire une carte en (onglet + filtre) puis naviguer | Helper de redirection filtrée |
| A007 | créer | `cardinalitySignalsModal()` (section cardinalité) | `public/app.js` | `public/app.js` | Conserver l'accès aux signaux + clôture **tracée** (résolution obligatoire) via un panneau discret | Modale signaux (table + `Clôturer` → `POST /api/cardinality/signals/:id/resolve`) |
| A008 | modifier | onglet **Tâches** : variable module `tasksMissingFilter` (l.13-25) + `<select id="f-missing">` dans `.filters` (l.503-530) + filtre dans `apply()` (l.580-602) + handler `change` (après l.744) | `public/app.js` | `public/app.js` | Ajouter les filtres cibles manquants « Sans ADR / Sans fonctionnalité / Sans sprint / Émergentes » | Onglet Tâches filtré par id-set cardinalité, select visible + persisté |
| A009 | modifier | onglet **Recettes** : variable module `recettesMissingFilter` + `<select id="rec-missing">` (l.2532-2540) + filtre de `recs` (l.2527) + handler | `public/app.js` | `public/app.js` | Ajouter les filtres cibles manquants « Sans ADR / Sans fonctionnalité / Sans sprint » | Onglet Recettes filtré par id-set (`recette_id`) |
| A010 | modifier | onglet **Sprints** : variable module `sprintsMissingFilter` + `<select id="sp-missing">` (l.4788-4792) + filtre de `sprints` avant `rows` (l.4768) + handler + persist | `public/app.js` | `public/app.js` | Ajouter les filtres cibles manquants « Sans fonctionnalité / Sans règle métier » | Onglet Sprints filtré par id-set |
| A011 | modifier | onglet **ADR** : `adrFilters.missingFeature` (l.4615) + param `ctx.missingFeatureIds` dans `adrTableHtml` (l.4474-4532 : `<select id="adr-missing-filter">` + attribut `data-missing` par ligne) + prise en compte dans `bindAdrTable.apply()` (l.4588-4603) + chargement du set dans `renderAdrs()` (l.4626-4634) | `public/app.js` | `public/app.js` | Ajouter le filtre cible manquant « Sans fonctionnalité » | Onglet ADR filtré par id-set (`adr_sans_fonctionnalite`) |
| A012 | ajouter | règles `.card-link` (curseur, hover/focus, affordance de clic) après `.card .lbl` (l.85) | `public/style.css` | `public/style.css` | Rendre les cartes cliquables visuellement (cohérence) | Cartes cliquables stylées |
| A013 | vérifier | `node --check public/app.js` + parcours HTTP/UI (chaque carte → bon onglet + filtre visible ; non-régression des onglets) | `public/app.js` | — | Preuve de parcours (critère d'acceptation) | Contrôle vert (aucun changement de code) |

---

## 4. Fichiers concernés

| Fichier | Type de modification | Zones touchées |
|---------|----------------------|----------------|
| `public/app.js` | modification | `PROJECT_TABS` (l.110-123) ; `RENDER` (l.6691-6695) ; `renderOverview` (l.462-489) ; `openCardinalityTarget` (nouveau, près de `goToTab` l.327) ; section cardinalité (l.5196-5274 : suppression A003 + création A004/A007) ; onglet Tâches (l.13-25, l.503-530, l.580-602, l.744+) ; onglet Recettes (l.18, l.2527, l.2532-2540) ; onglet Sprints (l.4768, l.4788-4792) ; onglet ADR (l.4474-4532, l.4588-4603, l.4615, l.4626-4634) |
| `public/style.css` | modification (additive) | règles `.card-link` après l.85 (à côté de `.cards`/`.card`) |
| `server.mjs` | **non modifié** | la route `GET /api/cardinality` (l.2081-2088) et `GET /api/cardinality/signals` + `POST /api/cardinality/signals/:id/resolve` (l.2089-2113) sont **réutilisées telles quelles** ; les filtres sont dérivés des items des vues (aucun nouveau paramètre/route) |
| `pilot.mjs` | **non modifié** | `cardinalityReport`/`listCardinalitySignals`/`resolveCardinalitySignal` (l.919-947) inchangés |
| `public/index.html` | **non modifié** | les panes sont créées à la demande (`ensurePane` l.83-91) — le retrait de l'onglet n'exige rien ici |
| `index.mjs` / `db.mjs` (repo MCP) | **hors périmètre** | T6 livré ; aucune modification |

Aucune suppression de fichier. Aucun nouveau fichier dans le repo panneau.

---

## 5. Livrables attendus

1. `public/app.js` : onglet « Émergents » **retiré** de `PROJECT_TABS`/`RENDER`, `renderEmergents()` et
   `CARDINALITY_VIEW_LABELS` **supprimés**.
2. `public/app.js` : Vue d'ensemble affichant **10 cartes statistiques** (une par indicateur de
   cardinalité) alimentées par `GET /api/cardinality` → `counts`, **cliquables**.
3. `public/app.js` : redirection filtrée par carte —
   - tâches sans ADR/fonctionnalité/sprint → onglet **Tâches** filtré ;
   - recettes sans ADR/fonctionnalité/sprint → onglet **Recettes** filtré ;
   - ADR sans fonctionnalité → onglet **ADR** filtré ;
   - sprints sans fonctionnalité / sans règle → onglet **Sprints** filtré ;
   - émergents → onglet **Tâches** filtré « Émergentes » (décision §2.1).
4. `public/app.js` : **filtres cibles ajoutés** (selects visibles + persistés) sur Tâches, Recettes,
   Sprints, ADR → la liste est **réellement filtrée**.
5. `public/app.js` : **point d'entrée discret** `#card-signals-open` ouvrant la modale des signaux,
   avec **clôture tracée** (résolution obligatoire) — plus de table de signaux en permanence.
6. `public/style.css` : style des cartes cliquables (`.card-link`).
7. Non-régression : onglets et filtres existants inchangés ; `node --check public/app.js` vert.

---

## 6. Ordre & dépendances

Graphe (Phase 4) :

```
A001 ─┐
A002 ─┼─→ A003 ─→ A004 ─┬─→ A005 ─┬─→ A007
      │                 │        └─→ A006 ─┬─→ A008
      │                 │                  ├─→ A009
      │                 │                  ├─→ A010
      │                 │                  └─→ A011
A012 (indépendant : style.css)
A013 (après tout)
```

Enchaînement linéaire recommandé :

`A001 → A002 → A003 → A004 → A005 → A006 → A007 → A008 → A009 → A010 → A011 → A012 → A013`

Prérequis stricts :

- **A001/A002/A003 avant A004** : l'emplacement l.5196 doit être libéré avant d'y installer le socle
  cardinalité (`CARDINALITY_CARDS` + helpers).
- **A004 avant A005/A006/A007/A008/A009/A010/A011** : tous consomment `cardinalityReportCached`/
  `cardinalityIdSet`/`CARDINALITY_CARDS`.
- **A006 avant A008/A009/A010/A011** (logique) : `openCardinalityTarget` référence les variables de
  filtre définies par ces étapes (déclarations `let` **hoistées en TDZ** — l'appel n'a lieu qu'au
  clic, donc pas de prérequis d'exécution, mais l'ordre évite toute référence manquante à l'écriture).
- **A005 avant A007** (logique) : le bouton `#card-signals-open` ouvre `cardinalitySignalsModal`.
- **A012 indépendant** (fichier distinct, styles additifs).
- **A013 en dernier** (contrôle).

Aucune étape ne dépend d'une étape ultérieure. Aucune étape n'est bloquée par une autre tâche.

---

## 7. Couverture des objectifs

| Exigence (tâche `T-20260921-120633-mtl2`) | Étape(s) | Couvert ? |
|---|---|---|
| L'onglet « Émergents » n'apparaît plus dans `PROJECT_TABS` | A001 | ✅ |
| Le renderer dédié est retiré (`RENDER.emergents` + `renderEmergents` + `CARDINALITY_VIEW_LABELS`) | A002, A003 | ✅ |
| Vue d'ensemble : **cartes statistiques** pour les **10 indicateurs** de cardinalité | A004, A005 | ✅ |
| Chaque carte affiche son **compteur** issu de `GET /api/cardinality` (`counts`) | A004, A005 | ✅ |
| Chaque carte est **cliquable** → page cible correspondante | A005, A006 | ✅ |
| Tâches sans ADR / sans fonctionnalité / sans sprint → onglet **Tâches** filtré | A006, A008 | ✅ |
| Recettes sans ADR / sans fonctionnalité / sans sprint → onglet **Recettes** filtré | A006, A009 | ✅ |
| ADR sans fonctionnalité → onglet **ADR** filtré | A006, A011 | ✅ |
| Sprints sans fonctionnalité / sans règle → onglet **Sprints** filtré | A006, A010 | ✅ |
| Émergents → onglet cible + filtre (choix documenté §2.1) | A006, A008 | ✅ |
| Le **filtre adapté** est **pré-appliqué et visible** dans l'UI | A008, A009, A010, A011 | ✅ |
| Les **filtres cibles manquants** sont ajoutés (sans fonctionnalité, sans ADR, sans règle, sans sprint, émergentes) | A008, A009, A010, A011 | ✅ |
| Le clic produit une **liste réellement filtrée** (pas un simple changement d'onglet) | A008, A009, A010, A011 | ✅ |
| Les **signaux de cardinalité** restent accessibles via un **point d'entrée discret** | A005, A007 | ✅ |
| Clôture **tracée** avec **résolution obligatoire** | A007 | ✅ |
| Pas de table volumineuse affichée en permanence | A003, A005, A007 | ✅ |
| **Non-régression** onglets/filtres existants ; `node --check` OK | A008, A009, A010, A011 (défaut « tous »), A012, A013 | ✅ |
| **Preuve de parcours** (clic carte → bon onglet + bon filtre) | A013 | ✅ |

Toutes les exigences de la tâche sont couvertes par au moins une étape atomique.

---

## 8. Vérification de cohérence

**Contradictions intra-plan (Phase 6)** — regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `PROJECT_TABS` (l.120) | A001 | ✅ seule étape touchant cette entrée (`supprimer`) |
| `RENDER` (l.6694) | A002 | ✅ seule étape touchant `RENDER.emergents` (`supprimer`) |
| Bloc cardinalité `app.js` l.5196-5274 | A003 (supprimer), A004 (créer), A007 (créer) | ✅ **zones disjointes** : A003 retire `renderEmergents`/`CARDINALITY_VIEW_LABELS` ; A004 crée `CARDINALITY_CARDS`/helpers ; A007 crée `cardinalitySignalsModal`. Noms d'éléments distincts → aucun `supprimer` + autre action sur le **même** élément, aucun `créer` + `renommer` |
| `renderOverview` (l.462-489) | A005 | ✅ seule étape modifiant ce renderer |
| `openCardinalityTarget` (nouveau) | A006 | ✅ création unique (appelée par A005) |
| Filtres Tâches | A008 | ✅ zone distincte (`.filters` + `apply()`) |
| Filtres Recettes | A009 | ✅ zone distincte (l.2527/2532-2540) |
| Filtres Sprints | A010 | ✅ zone distincte (l.4768/4788-4792) |
| Filtres ADR | A011 | ✅ zone distincte (`adrTableHtml`/`bindAdrTable`/`adrFilters`) |
| `public/style.css` `.card-link` | A012 | ✅ ajout additif, aucune suppression |

Aucun couple `supprimer` + autre action sur un **même** élément. Aucun `créer` + `renommer` sur un
élément créé. Aucune étape ne lit/modifie un élément créé par une étape **ultérieure** (A004 précède
tous ses consommateurs ; A006 est déclarée avant son câblage dans A005). **Aucune contradiction.**

**Plan Validator (Phase 7)** : couverture 100 % (§7), étapes atomiques (élément × fichier × verbe),
aucune contradiction → **Valid**.

**Cohérence globale inter-plans (Phase 9)** : plan unique pour cette tâche → aucun conflit
inter-plans. À noter : `Plan-panneau-sprints-fonctionnalites-emergents-*` (T7, **terminé**) a créé
`renderEmergents`/`CARDINALITY_VIEW_LABELS` — ce plan les **supprime** (évolution assumée, pas un
conflit : la tâche source est `done` et ce plan est sa suite `emergent`). Aucun autre plan actif ne
touche `public/app.js`/`public/style.css` du repo panneau.

---

## 9. Risques & notes

1. **Sémantique des id-sets** : les filtres s'appuient sur les vues du registre (source de vérité de
   l'émergence). Pour les **ADR**, la vue `adr_sans_fonctionnalite` est **scopée projet**
   (`artifact_projects`) alors que l'onglet ADR affiche aussi les ADR des **repos transverses**
   (`includeRepoDocs=1`) : une ADR rattachée **uniquement à un repo** n'est pas dans l'ensemble et
   sera masquée quand le filtre est actif. Limitation **documentée** ; ne pas la contourner par un
   recalcul côté panneau (décision §2.3).
2. **Latence MCP** : `/api/cardinality` agrège **10 vues** (10 requêtes) + les signaux via le
   registre. Le cache client 15 s (`cardinalityReportCached`) évite de refetcher à chaque rendu
   (polling). En cas d'échec de l'appel, la Vue d'ensemble doit **dégrader proprement** (message
   `muted-sm`, pas d'exception qui casse tout l'onglet) et les pages cibles doivent retomber sur la
   liste **non filtrée** plutôt que de rester vides.
3. **Persistance des filtres** : comme les filtres existants (`localStorage`), un filtre activé par
   un clic de carte reste actif après rechargement — c'est cohérent avec le comportement actuel, et
   le select visible permet de revenir à « tous ».
4. **Ordre de retrait** : A003 supprime `renderEmergents` ; vérifier qu'aucune autre référence
   ne subsiste (`grep -n "renderEmergents\|emergents" public/app.js` → 0 hors éventuel texte) avant
   A013.
5. **Traçabilité d'isolation** : branche de travail dédiée gérée par `session-guard` ; aucune
   modification directe de `feature/migration-postgresql`. Événements `task_event` sur
   `T-20260921-120633-mtl2` (`PLANNING_STARTED`, `PLAN_CREATED`) + `plan_register(taskId=…)` +
   `artifact_add(kind=plan)`.

### Tests E2E Playwright — analyse d'impact

- **Existante** : le repo panneau `/root/orchestrator-panel` **ne contient aucun harnais Playwright**
  (pas de `playwright.config.*`, aucun `*.spec.ts` hors `node_modules`) et `e2e_list(project=ecosystem)`
  renvoie **0 test**. Le projet `ecosystem` n'a pas de `e2eRepoDir` configuré pour
  `opencode-observability`.
- **Décision : E2E NA** — aucun scénario `create`/`update`/`delete` enregistré, aucune création
  « en aveugle » d'entité E2E sans spec file réel. La preuve de parcours exigée par la tâche est
  assurée par **A013** (vérification HTTP/UI manuelle).
- **Stratégie recommandée (documentée, à réaliser quand un harnais existera)** :
  - `create` — « Cartes de cardinalité cliquables » : ouvre un projet, Vue d'ensemble, vérifie la
    présence des 10 cartes avec compteurs, clique chaque carte, vérifie l'onglet actif + le select de
    filtre visible + la liste filtrée ;
  - `create` — « Signaux de cardinalité via point d'entrée discret » : ouvre la modale depuis la Vue
    d'ensemble, vérifie la table des signaux, clôture un signal avec résolution (champ obligatoire) ;
  - `delete`/`update` — « Onglet Émergents retiré » : vérifie l'absence de l'onglet « Émergents »
    dans la navigation projet ;
  - `keep` (non-régression) — les onglets Tâches/Recettes/Sprints/ADR et leurs filtres existants
    restent fonctionnels.
  Ces scénarios devront être **enregistrés via `e2e_test_register`** (projet `ecosystem`, repo source
  `opencode-observability`, `repoIds` = repos traversés) **au moment où un harnais Playwright sera
  ajouté** au repo panneau.
