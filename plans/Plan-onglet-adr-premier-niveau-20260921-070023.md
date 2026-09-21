# Plan — Onglet ADR de PREMIER NIVEAU (panneau opencode-observability)

- **Plan ID** : `Plan-onglet-adr-premier-niveau-20260921-070023`
- **Tâche** : `T-20260921-065829-xa46` (executionId `E-T-20260921-065829-xa46-091kez`)
- **Projet** : `ecosystem` — repo unique `opencode-observability` (`/root/orchestrator-panel`, branche `feature/migration-postgresql`)
- **Tâche liée (source)** : `T-20260920-162754-b4cb` (`emergent`) — onglet ADR interne au modal de détail projet, livré par
  `Plan-onglet-adr-panneau-20260920-165510.md` (commit `62f67c6`). Rino préfère un onglet de **premier niveau**.
- **Date** : 2026-09-21 07:00:23
- **Fichier plan** : `plans/Plan-onglet-adr-premier-niveau-20260921-070023.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)

## 1. Objectif

Exposer les **ADR** dans un **onglet de PREMIER NIVEAU « ADR »** de la navigation principale du panneau
(et non plus seulement comme onglet interne du modal de détail projet), avec une **table complète**
(Titre, Statut, Contexte, Décision, Conséquences, Pièces jointes, Projet, Repos rattachés + badge
« globale »), des **filtres** (projet / statut / repo) + **recherche**, le **CRUD ADR** et la **gestion
des pièces jointes** (ajout / retrait / téléchargement) — le tout en **réutilisant l'existant** (aucune
duplication) et **sans régression** des autres onglets ni de l'API.

## 2. Contexte & raison d'être

- Aujourd'hui l'ADR n'existe que comme **onglet interne** de `projectDetailModal(projectId, tab)` :
  `tabs` (l.3929-3934) + branche `else if (tab === 'adr') panel.innerHTML = adrTabHtml(p, pAdrs, pRepos, adrFilter)`
  (l.3951). Il faut donc **ouvrir le détail d'un projet** pour voir les ADR.
- La logique ADR existe déjà et est **top-level donc réutilisable** :
  `ADR_STATUS` (l.4276), `adrStatusBadge` (l.4279), `adrGlobalBadge` (l.4285), `adrCellText` (l.4291),
  `adrAttachmentsCell` (l.4313), `adrTabHtml` (l.4383), `adrSelectorHtml`/`bindAdrSelector` (l.4448/4495),
  `adrFormModal` (l.4532), `adrAttachmentModal` (l.4644), `viewRefDoc` (l.4351).
- L'**API/MCP est complète** (livrée T1/T2/T3/T6/T7) : `GET/POST /api/docs`, `PUT/DELETE /api/docs/:id`,
  `POST/DELETE /api/docs/:id/attachments`, `GET /api/docs/:id/attachments/:attId/download`,
  `GET /api/docs/:id/content`, `GET /api/projects`, `GET /api/repos` (server.mjs l.1655-1819).
  Le MCP `doc_list` (index.mjs l.449) accepte `kind` **sans `projectId`** → renvoie **toutes** les ADR
  (`db.mjs` l.2037-2042), chaque doc exposant `projects[]`, `repos[]`, `isGlobal`, `attachments[]`
  (`enrichDocs`, db.mjs l.1764-1775). **`server.mjs` n'a donc besoin d'aucune modification.**
- La tâche liée `T-20260920-162754-b4cb` fournit les conventions de nommage à réutiliser
  (`data-pd-adr-*`, `pd-adr-*-filter`, `adr-*` pour les ids de formulaire) — d'où l'extraction
  paramétrée par **préfixe** proposée ici.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter | helper `ensurePane(tab)` (création **idempotente** de `<section id="pane-<tab>" class="pane">` dans `<main>`) + appel en **tête** de `switchTab(tab)` (l.80-84) | `public/app.js` | `public/app.js` | Les panes sont **statiques** dans `index.html` (l.36-51), **hors scope** : sans `#pane-adr`, `switchTab('adr')` n'active rien | `#pane-adr` créé à la demande ; `switchTab('adr')` active bien le pane |
| A002 | Modifier | `GLOBAL_TABS` (l.88-94) **et** `PROJECT_TABS` (l.96-108) : ajouter l'entrée `['adr', 'ADR']` | `public/app.js` | `public/app.js` | Onglet de premier niveau visible (accueil **et** projet ouvert) | `renderNav()` émet un `<button data-tab="adr">ADR</button>` |
| A003 | Modifier | `adrAttachmentsCell(d)` (l.4313) → `adrAttachmentsCell(d, prefix = 'pd-adr')` : préfixer les `data-*` en `data-<prefix>-att-add\|att-del\|att-view` | `public/app.js` | `public/app.js` | La cellule doit être réutilisable par le rendu global (préfixe `adr`) sans casser le modal | Cellule paramétrable ; modal inchangé (défaut `pd-adr`) |
| A004 | Extraire | nouvelle `adrTableHtml(ctx)` (top-level, près de `adrTabHtml` l.4383) ; `ctx = { adrs, projects, repos, scope, filter, prefix }` — barre de filtres + table ; colonnes Titre/Statut/Contexte/Décision/Conséquences/Pièces jointes + (`scope==='global'` → **Projet** + **Repos**) + Actions ; `adrTabHtml(p, adrs, repos, filter)` devient un **adaptateur** `adrTableHtml({ scope:'project', prefix:'pd-adr', projects: [], repos, filter })` | `public/app.js` | `public/app.js` | Rendu de table **unique** partagé (pas de duplication) entre modal et onglet global | `adrTableHtml` partagé ; `adrTabHtml` conservée, sortie modal identique |
| A005 | Extraire | nouvelle `bindAdrTable(rootEl, ctx)` (top-level) : câble `[data-<prefix>-new\|edit\|view\|del\|att-add\|att-del\|att-view]` + `#<prefix>-status-filter\|repo-filter\|project-filter` ; `ctx = { prefix, scope, docs, repos, projects, onChange, onFilterChange }` ; remplace le bloc ADR de `projectDetailModal.wire()` (l.4167-4199) par un appel `bindAdrTable(panel, { prefix:'pd-adr', scope:'project', … })` | `public/app.js` | `public/app.js` | Câblage **unique** partagé (créer/éditer/voir/supprimer + pièces jointes + filtres) | `bindAdrTable` partagé ; comportement modal identique |
| A006 | Modifier | `adrFormModal(p, repos, adr, onSaved, opts = {})` (l.4532) : si `p` est **null** (contexte global) → `<select id="adr-project">` peuplé par `opts.projects`, repos dérivés du projet choisi (`opts.reposByProject`) ; à la création `body.projectId` = projet sélectionné ; comportement inchangé quand `p` est fourni | `public/app.js` | `public/app.js` | Créer/éditer une ADR **depuis l'onglet global** (choix du projet) | Modale ADR fonctionnelle en contexte global **et** projet |
| A007 | Ajouter | nouvelle `renderAdrs()` (top-level) : (1) `api('/api/docs?kind=adr-tech')` + `api('/api/projects')` + `api('/api/repos')` ; (2) **scoping org** = ADR dont `projects[]`/`repos[]` intersecte les projets/repos visibles ; (3) cache module `adrState` + état `adrFilters = { project, status, repo, q }` ; (4) shell (titre + `#adr-table-wrap`) puis `draw()` → `adrTableHtml({ scope:'global', prefix:'adr', … })` + `bindAdrTable(…)` ; filtres/recherche re-rendent **depuis le cache** (sans re-fetch) | `public/app.js` | `public/app.js` | **Cœur de l'onglet** de premier niveau | Onglet ADR global : table + filtres + recherche opérationnels |
| A008 | Modifier | carte `RENDER` (l.5852-5855) : ajouter `adr: renderAdrs` | `public/app.js` | `public/app.js` | `refreshActive()` route le rendu par `RENDER[activeTab]` (clic + polling) | Onglet rendu au clic et au rafraîchissement automatique |
| A009 | Ajouter | styles `.adr-pane-filters` / `.adr-table-wrap` / `.adr-table` (barre de filtres responsive + table scrollable), près du bloc `.adr-pick` (l.944-966) | `public/style.css` | `public/style.css` | Rendu propre/responsive de l'onglet (classes utilisées par A004/A007) | Classes CSS disponibles et utilisées |
| A010 | Vérifier | relance `pm2 restart orchestrator-panel` + parcours manuel complet (cf. §8) | `/root/orchestrator-panel` | — | `node --check` ne valide **pas** le rendu ; pas de CI | Rapport de vérification (notes/captures) + service relancé OK |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/orchestrator-panel/public/app.js` | **Modification** — A001 (`ensurePane`/`switchTab`), A002 (`GLOBAL_TABS`/`PROJECT_TABS`), A003 (`adrAttachmentsCell`), A004 (`adrTableHtml`/`adrTabHtml`), A005 (`bindAdrTable`/`wire`), A006 (`adrFormModal`), A007 (`renderAdrs`), A008 (`RENDER`) |
| `/root/orchestrator-panel/public/style.css` | **Modification** — A009 (classes de l'onglet ADR) |
| `/root/orchestrator-panel/server.mjs` | **Aucune modification** — l'API requise existe déjà (`/api/docs`, `/api/docs/:id`, `/api/docs/:id/attachments[/:attId[/download]]`, `/api/docs/:id/content`, `/api/projects`, `/api/repos`) |
| `/root/orchestrator-panel/public/index.html` | **Aucune modification** — le pane `adr` est créé dynamiquement (A001) car `index.html` est **hors scope** |
| `/root/orchestrator-panel/pilot.mjs` | **Aucune modification** — wrapper MCP déjà complet (T2) ; filtre `status` fait côté client |

**Routes / fonctions réutilisées sans duplication** : `GET /api/docs?kind=adr-tech` (global),
`POST /api/docs`, `PUT/DELETE /api/docs/:id`, `POST/DELETE /api/docs/:id/attachments`,
`GET /api/docs/:id/attachments/:attId/download`, `GET /api/docs/:id/content` ;
`adrStatusBadge`, `adrGlobalBadge`, `adrCellText`, `adrAttachmentsCell`, `adrFormModal`,
`adrAttachmentModal`, `viewRefDoc`, `esc`, `api`, `showModal`, `closeModal`.

## 5. Livrables attendus

1. Onglet **« ADR »** présent dans la navigation principale (accueil **et** projet ouvert), ouvrable **sans** passer par le modal de détail projet.
2. `renderAdrs()` : table listant les ADR avec **Titre, Statut, Contexte, Décision, Conséquences, Pièces jointes, Projet, Repos rattachés** + **badge « globale »**.
3. **Filtres** projet / statut (`Proposé|Accepté|Déprécié|Remplacé`) / repo + **recherche** texte (titre/contexte/décision/conséquences/chemin).
4. **CRUD ADR** (créer / éditer / supprimer) et **pièces jointes** (ajouter / retirer / télécharger) depuis l'onglet, via l'API existante.
5. `adrTableHtml` + `bindAdrTable` **partagés** entre l'onglet global et le modal projet (aucune duplication de rendu ni de câblage).
6. Classes CSS `.adr-pane-filters` / `.adr-table-wrap` / `.adr-table`.
7. Onglet ADR **interne au modal conservé comme raccourci** (voir §7 — décision).
8. **Aucune régression** des autres onglets (Projets, Tâches, Artefacts, Recettes, Écosystème, Workspaces, Utilisateurs…) ni du modal projet ; vérification de rendu effectuée (A010).

## 6. Ordre & dépendances

```
A001 (pane) ──► A002 (nav)
A003 (cellule préfixée) ──► A004 (table partagée) ──► A005 (câblage partagé)
                                   │                        │
                                   ├──► A009 (CSS)          │
                                   └──► A007 (renderAdrs) ◄─┘
A006 (formulaire global) ──────────► A007 ──► A008 (RENDER) ──► A010 (vérif)
```

- **A001** : prérequis de rendu (sans pane, l'onglet ne s'affiche pas).
- **A003 → A004** : `adrTableHtml` passe le préfixe à `adrAttachmentsCell`.
- **A004 → A005** : `bindAdrTable` respecte les mêmes préfixes/ids que `adrTableHtml`.
- **A004, A005, A006 → A007** : `renderAdrs` consomme la table, le câblage et le formulaire.
- **A007 → A008** : `RENDER.adr = renderAdrs` exige que `renderAdrs` existe (évite un `ReferenceError` au chargement).
- **A010** : dernier (vérification manuelle après toutes les modifications).

## 7. Décision — sort de l'onglet ADR interne au modal de détail projet

**Choix retenu : CONSERVER l'onglet interne comme raccourci** (aucune suppression).
Justification : (a) rétrocompat maximale, aucun risque de régression sur un parcours existant livré et
validé ; (b) l'onglet global et l'onglet du modal partagent désormais rendu et câblage (A004/A005),
donc la maintenance est unique ; (c) le périmètre de la tâche n'exige que l'onglet de premier niveau.
Le modal continue d'appeler `adrTabHtml(p, pAdrs, pRepos, adrFilter)` (l.3951), qui devient un adaptateur
`scope='project'` — **comportement identique**.

## 8. Couverture des objectifs

| Exigence (acceptance criteria) | Étape(s) | Couvert ? |
|--------------------------------|----------|-----------|
| Onglet « ADR » de premier niveau, ouvrable sans le modal projet | A001, A002, A008 | ✅ |
| Table Titre/Statut/Contexte/Décision/Conséquences/Pièces jointes/Projet/Repos + badge « globale » | A004, A007 | ✅ |
| Filtres projet / statut / repo + recherche | A004, A005, A007 | ✅ |
| CRUD ADR (créer / éditer / supprimer) depuis l'onglet | A005, A006, A007 (API existante) | ✅ |
| Pièces jointes (ajout / retrait / téléchargement) | A003, A005, A007 | ✅ |
| Réutiliser/extraire l'existant, pas de duplication | A004, A005, A006 | ✅ |
| Sort de l'onglet interne au modal explicité | §7 (décision : raccourci conservé) | ✅ |
| Aucune régression des autres onglets | A001, A002, A004, A005, A008, A010 | ✅ |
| Vérification de rendu (pas seulement `node --check`) | A010 | ✅ |

## 9. Vérification de cohérence

- **Contradictions intra-plan** : aucun élément de code n'est visé par deux actions incompatibles.
  `adrTabHtml` (A004), `adrAttachmentsCell` (A003), `wire()` ADR (A005), `adrFormModal` (A006),
  `GLOBAL_TABS`/`PROJECT_TABS` (A002), `RENDER` (A008) : **un seul** verbe par élément. Aucun
  `supprimer` sur un élément par ailleurs `modifier`/`déplacer`. Pas de `créer` + `renommer` sur le même élément.
- **Ordre** : aucun accès à un élément créé par une étape ultérieure (A008 dépend bien de A007 ;
  A007 dépend de A004/A005/A006). ✔
- **Couverture** : 100 % des exigences mappées (§8). ✔
- **Plan Validator** : **Valid** (pas de contradiction, couverture complète, étapes atomiques et localisées).

## 10. Risques & notes

- **`index.html` hors scope → pane dynamique** (A001). Alternative plus conventionnelle (1 ligne
  `<section id="pane-adr" class="pane"></section>` dans `index.html`) **non retenue** pour respecter
  strictement le périmètre déclaré (`public/app.js`, `server.mjs`, `public/style.css`). Le helper
  `ensurePane` est **idempotent** et couvre aussi tout futur onglet.
- **Scoping organisation** : `doc_list` sans `projectId` n'est pas filtré par organisation côté MCP ;
  le rendu **filtre côté client** en intersectant `d.projects`/`d.repos` avec les projets/repos visibles
  (`GET /api/projects` et `GET /api/repos` sont, eux, filtrés par org). Aucune fuite inter-orgs à l'écran.
- **Filtre `status` côté client** : `pilot.listDocs` ne transmet pas `status` au MCP — on filtre dans le
  rendu (comme `adrTabHtml` aujourd'hui), ce qui évite de modifier `pilot.mjs` (hors scope).
- **Retrait d'un repo rattaché** : l'API registre est **additive** (`addRepoIds`/`setGlobal`) ; le retrait
  d'un repo précis n'est pas exposé. Limitation **existante** conservée (mention déjà présente dans le
  formulaire du modal) — hors périmètre.
- **Limite `doc_list`** : `LIMIT 500` par défaut (db.mjs l.2039) ; suffisant à ce stade.
- **Polling** : `renderAdrs` re-fetch `/api/docs?kind=adr-tech` à chaque cycle de rafraîchissement
  (comportement identique aux autres onglets) ; les filtres/recherche re-rendent **depuis le cache**.
- **Pas de CI** : la vérification est **manuelle** (A010). `node --check public/app.js` peut être lancé
  en pré-check, mais **ne suffit pas** : valider le **rendu** réel après `pm2 restart orchestrator-panel`.
- **Tests E2E** : **E2E NA** — le projet `ecosystem` n'a aucun test Playwright (`e2e_list project=ecosystem`
  → 0 ; pas d'`e2eRepoDir`), le panneau est de l'infra hôte sans spec E2E. Aucun `e2e_test_register` /
  `e2e_test_link` à créer ; la non-régression est couverte par le parcours manuel A010.
