# Plan — Séparer « Fonctionnalités » et « Règles métier » en deux sous-onglets

- **Plan** : `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443`
- **Tâche** : `T-20260921-120633-mtl2` (exécution `E-T-20260921-120633-mtl2-jai3ti`)
- **Projet** : `ecosystem` — repo `opencode-observability` → `/root/orchestrator-panel`
- **Branche de travail** : dédiée (session-guard) — la branche principale `feature/migration-postgresql` n'est jamais modifiée directement.
- **Référence de base** : `5299d4c` (branche `feature/migration-postgresql`).
- **Plan frère (exécuté AVANT, à ne pas réécrire)** : `Plan-panneau-cardinalites-vue-ensemble-20260921-120900` (A001–A013 : suppression de l'onglet « Émergents », cartes cardinalité dans la Vue d'ensemble, filtres Tâches/Recettes/Sprints/ADR).

---

## 1. Objectif

Séparer l'onglet actuel « Fonctionnalités / Règles » (entrée `features` de `PROJECT_TABS`) en **deux sous-onglets internes distincts** — « Fonctionnalités » (US-xxx) et « Règles métier » (RM-xxxx) — chacun avec **sa propre liste, ses propres filtres et son propre CRUD**, sans mélange des deux natures d'entités dans une même vue, le tout vérifiable sur le projet **myxmax** (données réelles) comme sur le projet courant.

---

## 2. Contexte & raison d'être

- L'onglet a été livré en **T7** (`T-20260921-091736-yqwv`, commit `70b445f`, plan `Plan-panneau-sprints-fonctionnalites-emergents-20260921-110850`) : `renderFeaturesRules()` (`public/app.js` l.5114-5194) charge `/api/features` **et** `/api/rules` puis affiche **dans une seule vue** la barre de filtres commune, la table « Fonctionnalités » **puis** la table « Règles métier » (l.5165-5182).
- Les **données sont déjà séparées** côté registre (`/api/features` → `feature_list`, `/api/rules` → `rule_list`, deux tables distinctes `fonctionnalites` / `regles_metier`), mais l'UI les **présente comme une seule vue** : deux natures d'entités cohabitent dans le même écran, avec une barre de filtres et des boutons CRUD **communs**. C'est ce mélange de présentation que la demande utilisateur vise.
- La séparation demandée est **interne** (sous-onglets dans l'onglet `features`), pas une nouvelle entrée `PROJECT_TABS` : le pattern UI existant **`.pd-tabs` / `.pd-tab` / `.pd-panel`** (défini dans `public/style.css` l.713-724, utilisé par la modale détail projet `app.js` l.3956-3959) est réutilisé pour rester cohérent.
- Les filtres et le CRUD s'appuient sur l'existant : `.adr-pane-filters` (barre de filtres + boutons), `.adr-table-wrap` / `.adr-table` (tables), `featureFormModal` / `ruleFormModal` / `featureDetailModal` / `ruleDetailModal` / `linkModal` (l.4932-5080) — **aucune nouvelle API n'est nécessaire** : `/api/features` (`projectId`, `emergent`, `search`, `limit`), `/api/rules` (idem), `/api/links` (`POST`), `/api/features/:id` et `/api/rules/:id` (détail avec liens) suffisent.
- **Champs disponibles** (registre `db.mjs` `rowToFonctionnalite` l.1548 / `rowToRegle` l.1566) : fonctionnalité = `{ id, project, ref, role, userStory, sourcedPieceId, emergent, emergentOrigin, createdAt, updatedAt, createdBy }` ; règle = `{ id, project, ref, content, sourcedPieceId, emergent, emergentOrigin, createdAt, updatedAt, createdBy }`. Le détail (`/api/features/:id`) expose `regles`, `gherkin`, `adrs`, `sprints`, `tasks`, `recettes` ; le détail règle expose `fonctionnalites`, `sprints`.
- **Tâche liée exploitée** : `T-20260921-091736-yqwv` (`relationType = emergent`) — c'est la tâche qui a créé l'onglet ; ses commits (`70b445f` pour `public/app.js`, `4b3b3e0` pour `server.mjs`) fixent les conventions et les emplacements réels utilisés ici.
- **ADR** : `adr_list({ projectId: 'ecosystem' })` = **0** ; aucune ADR `Accepté`/`Proposé` ne contraint cette évolution (les commentaires de code citent « ADR-001 » pour le modèle sprint/fonctionnalités/règles, non enregistré au registre ADR). Aucun conflit d'ADR à signaler.

### Disjonction avec le plan frère

| Zone | Plan 1 (`Plan-panneau-cardinalites-vue-ensemble-…`) | Ce plan |
|---|---|---|
| `PROJECT_TABS` | l.120 (`emergents`) — suppression | l.119 (`features`) — renommage du libellé |
| `renderOverview` / cartes | l.462-489 + section cardinalité l.5196-5274 | **non touchés** |
| Filtres Tâches/Recettes/Sprints/ADR | oui | **non touchés** |
| `enrichLinkCells` (l.5082-5112) | non touché | remplacé (A003) |
| `renderFeaturesRules` (l.5114-5194) | non touché | restructuré (A009) |
| `public/style.css` | `.card-link` (après l.85) | `.fr-subtabs`/`.fr-subpanel` (fin de fichier) |

Les deux plans seront exécutés **séquentiellement** ; ce plan est **additif** et ne réécrit aucune région du plan 1. La frontière est la ligne l.5194 (fin de `renderFeaturesRules`) vs l.5196 (début du bloc cardinalité du plan 1).

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | renommer | libellé de l'entrée `['features', 'Fonctionnalités / Règles']` de `PROJECT_TABS` (l.119) → `['features', 'Fonctionnalités & Règles']` | `public/app.js` | `public/app.js` | Lever l'ambiguïté « / » (vue fusionnée) au niveau navigation ; l'entrée reste unique (deux sous-onglets internes) | Libellé `Fonctionnalités & Règles` dans la barre d'onglets projet |
| A002 | ajouter | états module `frSubTab` (`'features'`), `frFeatureFilters` (`{q, role, emergent, link}`), `frRuleFilters` (`{q, emergent, link}`) — insérés après le commentaire d'en-tête (l.4913), avant `const LINK_PRESETS` (l.4917) | `public/app.js` | `public/app.js` | Persister le sous-onglet actif et les filtres propres à chaque liste à travers le polling (`refreshActive`) | 3 variables module initialisées |
| A003 | remplacer | fonction `enrichLinkCells()` (l.5082-5112) → `loadFeatureRuleLinkIndex(features, rules)` + `frLinkCellHtml(kind, id, linkIndex)` | `public/app.js` | `public/app.js` | Passer d'un remplissage **paresseux** des cellules « Liens » à un **index déterministe** des liens par entité, réutilisable pour les filtres « sans lien » | `loadFeatureRuleLinkIndex` (index `{features:{id:{rules,gherkin,adrs,sprints,tasks,recettes}}, rules:{id:{features,sprints}}}`, concurrence bornée 4) + `frLinkCellHtml` |
| A004 | créer | fonctions pures `frFilterFeatures(features, filter, linkIndex)` et `frFilterRules(rules, filter, linkIndex)` (à la suite de A003) | `public/app.js` | `public/app.js` | Filtrage **client** par sous-onglet : recherche texte, rôle, émergence, rattachement (sans règle / sans fonctionnalité / sans sprint / sans ADR / sans Gherkin) | 2 helpers de filtrage purs |
| A005 | créer | fonction `frFeatureTableHtml(features, linkIndex)` (à la suite de A004) | `public/app.js` | `public/app.js` | Table **Fonctionnalités** isolée : `Ref` (badge émergent), `Rôle`, `User story` (`adrCellText`), `Liens` (`frLinkCellHtml`), `Actions` (`data-fr-edit`/`data-fr-detail`/`data-fr-link`) | Builder de table Fonctionnalités |
| A006 | créer | fonction `frRuleTableHtml(rules, linkIndex)` (à la suite de A005) | `public/app.js` | `public/app.js` | Table **Règles métier** isolée : `Ref` (badge émergente), `Contenu` (`adrCellText`), `Pièce source`, `Liens`, `Actions` (`data-rule-edit`/`data-rule-detail`/`data-rule-link`) | Builder de table Règles |
| A007 | créer | fonction `renderFrFeaturePanel(features, refs, pieces, linkIndex)` (à la suite de A006) | `public/app.js` | `public/app.js` | Sous-panneau **Fonctionnalités** : toolbar de filtres propres (compteur, `#fr-f-q`, `#fr-f-role`, `#fr-f-emergent`, `#fr-f-link`), table (A005), bouton `#fr-new-feat`, câblage filtres + CRUD (modales existantes, `onSaved = renderFeaturesRules`) | Sous-panneau Fonctionnalités autonome |
| A008 | créer | fonction `renderFrRulePanel(rules, refs, pieces, linkIndex)` (à la suite de A007) | `public/app.js` | `public/app.js` | Sous-panneau **Règles métier** : toolbar de filtres propres (compteur, `#fr-r-q`, `#fr-r-emergent`, `#fr-r-link`), table (A006), bouton `#fr-new-rule`, câblage filtres + CRUD | Sous-panneau Règles autonome |
| A009 | modifier | corps de `renderFeaturesRules()` (l.5114-5194) : en-tête + barre `.pd-tabs` (2 boutons `data-fr-subtab`) + `<div class="pd-panel" id="fr-subpanel">` ; fonction interne `renderFrSubpanel()` (dispatch A007/A008) ; appel de `loadFeatureRuleLinkIndex` (A003) avant rendu ; suppression du corps monolithique (l.5165-5194) et de l'appel `enrichLinkCells()` (l.5193) | `public/app.js` | `public/app.js` | Remplacer la vue unique par deux sous-onglets ; le chargement des données et `refs` (l.5122-5143) est **conservé** | `renderFeaturesRules` = coquille + sous-onglets |
| A010 | ajouter | règles CSS `.fr-subtabs` et `.fr-subpanel` (fin de `public/style.css`) | `public/style.css` | `public/style.css` | Garantir un rendu correct de la barre de sous-onglets **dans un pane** (et non une modale) ; réutilisation visuelle de `.pd-tabs`/`.pd-panel` | Styles additifs des sous-onglets |
| A011 | vérifier | `node --check public/app.js` + parcours UI/HTTP sur **myxmax** puis projet courant (séparation des listes, filtres, CRUD, non-régression) | `public/app.js` | — | Preuve d'acceptation : contenu correctement séparé, vérifiable sur myxmax | Contrôle vert (aucun changement de code) |

---

## 4. Fichiers concernés

| Fichier | Type de modification | Zones / éléments |
|---|---|---|
| `public/app.js` | modification (additive, sans réécrire le plan 1) | `PROJECT_TABS` l.119 (A001) ; états module avant l.4917 (A002) ; `enrichLinkCells` l.5082-5112 (A003) ; nouveaux helpers A004-A008 (insérés entre l.5112 et l.5114) ; `renderFeaturesRules` l.5114-5194 (A009) |
| `public/style.css` | modification (additive, fin de fichier) | `.fr-subtabs`, `.fr-subpanel` (A010) |
| `server.mjs` / `pilot.mjs` | **non modifiés** | Les routes `/api/features`, `/api/rules`, `/api/links`, `/api/features/:id`, `/api/rules/:id` existent et suffisent (aucun ajustement d'API nécessaire) |

---

## 5. Livrables attendus

1. Entrée `PROJECT_TABS` `['features', 'Fonctionnalités & Règles']` (libellé clarifié).
2. Sous-onglet **Fonctionnalités** : table `Ref` / `Rôle` / `User story` / `Liens` / `Actions`, filtres propres (recherche, rôle, émergence, rattachement), bouton « + Nouvelle fonctionnalité », actions Éditer / Détail / Lier.
3. Sous-onglet **Règles métier** : table `Ref` / `Contenu` / `Pièce source` / `Liens` / `Actions`, filtres propres (recherche, émergence, rattachement), bouton « + Nouvelle règle », actions Éditer / Détail / Lier.
4. `loadFeatureRuleLinkIndex` + `frLinkCellHtml` : index des liens par entité alimentant la colonne « Liens » **et** les filtres « sans lien ».
5. `frFilterFeatures` / `frFilterRules` : filtrage client par sous-onglet.
6. Aucun mélange : le sous-onglet Fonctionnalités ne rend que des `US-xxx`, le sous-onglet Règles métier ne rend que des `RM-xxxx`.
7. Styles `.fr-subtabs` / `.fr-subpanel` additifs.
8. Preuve de vérification sur **myxmax** (données réelles) + projet courant + `node --check` vert.

---

## 6. Ordre & dépendances

```
A001 (indépendant : libellé nav)
A002 ──→ A003 ──→ A004 ──→ A005 ──→ A007 ─┐
                          └─→ A006 ──→ A008 ─┴─→ A009 ──→ A010 ──→ A011
```

- `A002 → A003 → A004 → A005/A006 → A007/A008 → A009` : les helpers de filtrage (A004) et les builders de table (A005/A006) consomment l'index produit par A003 ; les sous-panneaux (A007/A008) consomment A004+A005/A006 ; la coquille (A009) consomme A007/A008.
- `A001` indépendant (libellé `PROJECT_TABS`) ; `A010` indépendant du code JS (fichier distinct) mais après A009 (classes utilisées).
- `A011` **en dernier** (contrôle).
- Prérequis externe : le **plan 1 doit être exécuté avant** (il retire l'onglet « Émergents » et modifie la Vue d'ensemble) ; ce plan n'écrit que des zones disjointes.

---

## 7. Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|---|---|---|
| Séparer l'onglet en **deux sous-onglets distincts** | A009 (+ A010) | ✅ |
| Sous-onglet « Fonctionnalités » (liste : Ref US-xxx, rôle, user story) | A005, A007 | ✅ |
| Sous-onglet « Fonctionnalités » : liens règle/Gherkin/ADR/sprint + rattachements tâches/recettes | A003, A005 | ✅ |
| Sous-onglet « Règles métier » (liste : Ref RM-xxxx, contenu, pièce source) | A006, A008 | ✅ |
| Sous-onglet « Règles métier » : liens fonctionnalité/sprint + marqueur émergence | A003, A006 | ✅ |
| **Filtres propres** à chaque sous-onglet | A004, A007, A008 | ✅ |
| **CRUD propre** à chaque sous-onglet (l'agent propose, l'humain valide) | A007, A008 (modales existantes) | ✅ |
| Contenu **correctement séparé** (pas de mélange des deux listes) | A005, A006, A009 | ✅ |
| Vérifiable sur le projet **myxmax** (données réelles) + projet courant | A011 | ✅ |
| Non-régression (onglets/filtres existants, `node --check`) | A009, A010, A011 | ✅ |
| Réutilisation des patterns UI existants (sous-onglets, table ADR, filtres) | A009 (`.pd-tabs`), A007/A008 (`.adr-pane-filters`, `.adr-table`), A005/A006 | ✅ |
| Aucun ajustement d'API nécessaire (`/api/features`, `/api/rules`, `/api/links`) | §4 (aucune étape `server.mjs`/`pilot.mjs`) | ✅ |
| Traçabilité (`task_event`, `plan_register`, `artifact_add`) | Phase 8 (hors fichier plan) | ✅ |

---

## 8. Vérification de cohérence

### 8.1 Cohérence intra-plan (éléments cibles)

| Élément cible | Étape(s) | Verdict |
|---|---|---|
| `PROJECT_TABS` l.119 | A001 | ✅ seule étape touchant ce libellé (`renommer`) — pas de `supprimer` concurrent |
| États module (`frSubTab`, `frFeatureFilters`, `frRuleFilters`) | A002 | ✅ création unique, consommés par A007/A008/A009 |
| `enrichLinkCells` (l.5082-5112) | A003 | ✅ `remplacer` unique → aucun doublon `enrichLinkCells`/`loadFeatureRuleLinkIndex` |
| `frFilterFeatures` / `frFilterRules` | A004 | ✅ création unique |
| `frFeatureTableHtml` / `frRuleTableHtml` | A005 / A006 | ✅ créations uniques, zones distinctes |
| `renderFrFeaturePanel` / `renderFrRulePanel` | A007 / A008 | ✅ créations uniques, zones distinctes |
| `renderFeaturesRules` (l.5114-5194) | A009 | ✅ seule étape modifiant cette fonction ; le chargement Promise.all + `refs` (l.5122-5143) est conservé |
| `public/style.css` | A010 | ✅ ajout additif en fin de fichier, aucune suppression |

- Aucun `supprimer` + autre action sur le **même** élément ; aucun `créer` + `renommer` sur le même élément.
- Aucune étape ne lit/modifie un élément créé par une étape **ultérieure** (A003 avant A004/A005/A006 ; A004+A005/A006 avant A007/A008 ; A007/A008 avant A009).
- **Aucune contradiction interne.**

### 8.2 Cohérence inter-plans (avec le plan 1)

| Élément | Plan 1 | Ce plan | Verdict |
|---|---|---|---|
| `PROJECT_TABS` l.119 vs l.120 | l.120 `emergents` supprimé | l.119 `features` renommé | ✅ lignes distinctes |
| `renderFeaturesRules` (l.5114-5194) | non touché | A009 | ✅ zone réservée à ce plan |
| Bloc cardinalité (l.5196-5274) | supprimé/recréé | non touché | ✅ zones adjacentes mais disjointes |
| `enrichLinkCells` (l.5082-5112) | non touché | A003 | ✅ zone réservée à ce plan |
| `public/style.css` | `.card-link` (après l.85) | `.fr-subtabs`/`.fr-subpanel` (fin de fichier) | ✅ zones disjointes |
| `renderOverview` / filtres Tâches/Recettes/Sprints/ADR | modifiés | non touchés | ✅ aucun chevauchement |

- **Aucune incohérence globale** : les deux plans touchent `public/app.js` mais sur des régions **disjointes** ; l'exécution séquentielle (plan 1 puis ce plan) ne provoque aucun conflit de réécriture.

---

## 9. Risques & notes

1. **Volume d'appels `/api/features/:id` et `/api/rules/:id`** : l'index (A003) fait N appels de détail à concurrence bornée (4), comme `enrichLinkCells` aujourd'hui. Risque : latence si beaucoup d'entités. Mitigation : concurrence bornée 4 (conservée) ; le rendu reste identique en nombre d'appels au comportement actuel (aucune régression).
2. **Filtres « sans lien »** : dépendent de l'index ; en cas d'échec d'un appel de détail, `frLinkCellHtml` affiche `—` et le filtre considère le lien comme absent (comportement de repli, non bloquant).
3. **Polling** : `frSubTab` et les filtres sont des états **module** → ils survivent au `refreshActive()` (comme `adrFilters`). Le sous-onglet actif n'est pas réinitialisé à chaque rafraîchissement.
4. **Réutilisation `.pd-tabs`** : ces classes ont été créées pour une **modale** ; A010 ajoute un ajustement de marge additif pour un rendu correct dans un pane. Si le rendu est déjà satisfaisant, A010 reste néanmoins sans effet de bord (styles additifs).
5. **Nommage** : le libellé `PROJECT_TABS` devient « Fonctionnalités & Règles » ; le `id` de l'onglet reste `features` (aucune rupture de navigation, `RENDER.features` inchangé).
6. **Non-régression** : `renderFeaturesRules` reste la cible de `RENDER.features` (l.6694) ; les modales et `linkModal` sont réutilisées à l'identique.

### Tests E2E Playwright — analyse d'impact

- **E2E NA**. Le repo `opencode-observability` (`/root/orchestrator-panel`) **ne contient aucune spec Playwright** ni `playwright.config.*` (seul `storage/e2e/` = inbox du worker de runs d'autres projets), et `e2e_list(project='ecosystem')` = **0** test enregistré.
- Conséquence : **aucune création/mise à jour d'entité E2E** ni de lien `e2e_test_link` pour ce plan (pas de comportement couvert par un harnais E2E du repo).
- La preuve d'acceptation est assurée par **A011** : `node --check public/app.js` + **parcours UI/HTTP** sur le projet **myxmax** (ouvrir le projet → onglet « Fonctionnalités & Règles » → vérifier que le sous-onglet Fonctionnalités n'affiche que des `US-xxx` et le sous-onglet Règles métier que des `RM-xxxx`, compteurs cohérents avec `/api/features?projectId=myxmax` et `/api/rules?projectId=myxmax` ; exercer les filtres et un cycle CRUD), puis non-régression sur le projet courant.
