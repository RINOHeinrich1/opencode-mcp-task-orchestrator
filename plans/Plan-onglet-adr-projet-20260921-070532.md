# Plan — Onglet ADR À L'INTÉRIEUR DU PROJET (panneau opencode-observability)

- **Plan ID** : `Plan-onglet-adr-projet-20260921-070532`
- **Remplace** : `Plan-onglet-adr-premier-niveau-20260921-070023` (périmètre erroné : ADR ajoutée à `GLOBAL_TABS` **et** `PROJECT_TABS`)
- **Tâche** : `T-20260921-065829-xa46` (executionId `E-T-20260921-065829-xa46-091kez`)
- **Projet** : `ecosystem` — repo unique `opencode-observability` (`/root/orchestrator-panel`, branche de déploiement `feature/migration-postgresql`)
- **Tâche liée (source)** : `T-20260920-162754-b4cb` (`emergent`) — « onglet ADR interne au modal de détail projet » livré par `Plan-onglet-adr-panneau-20260920-165510.md` (commit `62f67c6`). Rino veut désormais un onglet **à l'intérieur du projet**, hors modal.
- **Date** : 2026-09-21 07:05:32
- **Fichier plan** : `plans/Plan-onglet-adr-projet-20260921-070532.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)
- **Périmètre d'écriture** : `public/app.js`, `public/style.css`. `server.mjs` : **aucune modification** (API déjà complète).

## 1. Objectif

Faire de l'ADR un **onglet À L'INTÉRIEUR DU PROJET** : une entrée de **`PROJECT_TABS` uniquement**
(barre affichée quand un projet est ouvert), avec un **rendu dédié** (`renderAdrs`) enregistré dans la
carte des vues, une **table des ADR du projet courant** (Titre, Statut, Contexte, Décision, Conséquences,
Repos rattachés + badge « globale », Pièces jointes, Actions), des **filtres statut/repo + recherche**,
le **CRUD ADR** et la **gestion des pièces jointes** — le tout en **mutualisant** la logique existante
(`adrTableHtml` + `bindAdrTable` réutilisés, `adrFormModal` / `adrAttachmentModal` / `viewRefDoc` /
`adrAttachmentsCell` réemployés), **sans toucher `GLOBAL_TABS`** et **en retirant l'onglet ADR interne au
`projectDetailModal`**.

## 2. Contexte & raison d'être

- **Correction demandée par Rino** : le plan précédent (`Plan-onglet-adr-premier-niveau-20260921-070023`)
  ajoutait l'ADR à **`GLOBAL_TABS` ET `PROJECT_TABS`** (étapes A001/A002 de ce plan). C'est **faux** :
  `GLOBAL_TABS` = barre de l'accueil (Projets / Vue d'ensemble / Écosystème / Workspaces / Utilisateurs)
  et ne doit **pas** contenir d'entrée ADR. L'ADR est une donnée **de projet**.
- **État réel du code** (vérifié, lecture seule) :
  - `GLOBAL_TABS` (l.88-94) et `PROJECT_TABS` (l.96-108) : **aucune** entrée `adr` aujourd'hui.
  - `projectDetailModal(projectId, tab)` (l.3904) expose un onglet interne ADR : `tabs` (l.3929-3934,
    entrée `['adr', 'ADR (n)']`) + branche de rendu `else if (tab === 'adr') panel.innerHTML = adrTabHtml(...)`
    (l.3951) + bloc de câblage ADR dans `wire()` (l.4167-4199). **À retirer.**
  - Les helpers ADR sont **top-level donc réutilisables** : `ADR_STATUS` (l.4276), `adrStatusBadge` (l.4279),
    `adrGlobalBadge` (l.4285), `adrCellText` (l.4291), `adrAttSourceBadge` (l.4299),
    `adrAttachmentsCell` (l.4313), `arrayBufferToBase64` (l.4338), `viewRefDoc` (l.4351),
    `adrTabHtml` (l.4383), `adrSelectorHtml` (l.4448), `bindAdrSelector` (l.4495),
    `adrFormModal` (l.4532), `adrAttachmentModal` (l.4644).
  - `adrTabHtml` (l.4383-4435) affiche déjà **6 colonnes + Actions** et les filtres statut/repo, mais :
    (a) les `data-*` de `adrAttachmentsCell` (l.4321/4326/4330) sont **codés en dur** `data-pd-adr-*`
    (préfixe « modal projet »), (b) **pas de recherche texte**, (c) les repos/badge globale sont noyés
    dans la cellule Titre, pas dans une colonne dédiée.
  - **Panes statiques** : `index.html` (l.36-51) ne contient **pas** `#pane-adr` ; `switchTab(tab)` (l.80-84)
    active `.pane#pane-<tab>` — sans pane, l'onglet ADR n'affiche rien. `index.html` est **hors périmètre**
    → création **idempotente** du pane côté `app.js`.
  - **API déjà complète** (aucune modif `server.mjs`) : `GET /api/docs?projectId=<id>&includeRepoDocs=1`
    (déjà utilisé l.3912), `GET /api/repos?project=<id>` (l.3907), `GET /api/projects`, `POST /api/docs`,
    `PUT/DELETE /api/docs/:id`, `POST/DELETE /api/docs/:id/attachments`,
    `GET /api/docs/:id/attachments/:attId/download`, `GET /api/docs/:id/content`.
- **Convention de rendu de référence** : les onglets projet (`renderArtifacts` l.1217, `renderTasks` l.477)
  lisent `currentProject` (l.28) et écrivent dans `document.getElementById('pane-<tab>')` ; la carte
  `RENDER` (l.5852-5855) route `refreshActive()` (l.5875). Le nouvel onglet suit ce modèle.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter | helper `ensurePane(tab)` (création **idempotente** de `<section id="pane-<tab>" class="pane">` dans `<main>`) + appel **en tête** de `switchTab(tab)` (l.80-84) | `public/app.js` | `public/app.js` | `index.html` (hors périmètre) n'a **pas** de `#pane-adr` : sans pane, `switchTab('adr')` n'active rien | `#pane-adr` créé à la demande et activé par `switchTab('adr')` |
| A002 | Modifier | `PROJECT_TABS` (l.96-108) : ajouter `['adr', 'ADR']` **après** `['artifacts', 'Artefacts']` (l.105) — **`GLOBAL_TABS` (l.88-94) NON MODIFIÉ** | `public/app.js` | `public/app.js` | L'ADR est une donnée **de projet** : entrée visible uniquement quand un projet est ouvert | `renderNav()` (l.116-120) émet `<button data-tab="adr">ADR</button>` **seulement** en contexte projet ; aucune entrée ADR à l'accueil |
| A003 | Modifier | `adrAttachmentsCell(d)` (l.4313-4334) → `adrAttachmentsCell(d, prefix = 'pd-adr')` : préfixer les `data-*` en `data-<prefix>-att-add\|att-del\|att-view` (l.4321/4326/4330) | `public/app.js` | `public/app.js` | La cellule doit être réutilisable par l'onglet projet (préfixe `adr`) sans collision avec le préfixe modal | Cellule paramétrable ; sortie identique avec le défaut `pd-adr` |
| A004 | Refondre (renommer) | `adrTabHtml(p, adrs, repos, filter)` (l.4383-4435) → **`adrTableHtml(ctx)`**, `ctx = { projectId, adrs, repos, filter, prefix }` : filtres `#<prefix>-search` (recherche) + `#<prefix>-status-filter` + `#<prefix>-repo-filter` + `#<prefix>-new` ; colonnes **Titre / Statut / Contexte / Décision / Conséquences / Repos rattachés / Pièces jointes / Actions** (repos = chips + `adrGlobalBadge`) ; `data-<prefix>-edit\|view\|del` ; appel `adrAttachmentsCell(d, prefix)` | `public/app.js` | `public/app.js` | Rendu de table **unique et paramétrable** (pas de duplication), avec recherche et colonne Repos demandées | `adrTableHtml` partagé ; filtrage client statut/repo/recherche opérationnel |
| A005 | Extraire | nouvelle `bindAdrTable(rootEl, ctx)` (top-level, près de `adrTableHtml`) : câble `[data-<prefix>-new\|edit\|view\|del\|att-add\|att-del\|att-view]` + `#<prefix>-status-filter\|repo-filter\|search` ; `ctx = { prefix, projectId, project, docs, repos, onChange }` ; réutilise `adrFormModal`, `adrAttachmentModal`, `viewRefDoc`, `api` | `public/app.js` | `public/app.js` | Câblage **unique partagé** (CRUD + pièces jointes + filtres) au lieu du bloc inline du modal | `bindAdrTable` unique ; appelé par l'onglet projet |
| A006 | Supprimer | onglet ADR interne au `projectDetailModal` : entrée `['adr', …]` dans `tabs` (l.3933) + branche `else if (tab === 'adr') …` (l.3951) + variable morte `pAdrs` (l.3928) + variable morte `adrFilter` (l.3918) | `public/app.js` | `public/app.js` | L'ADR ne doit **plus** être un onglet du modal (exigence Rino) | Modal projet = onglets Projet / Repos / Documents de référence uniquement ; plus aucune référence à l'ancien rendu ADR |
| A007 | Supprimer | bloc de câblage ADR de `wire()` dans `projectDetailModal` (l.4167-4199) | `public/app.js` | `public/app.js` | Câblage remplacé par `bindAdrTable` (A005) : supprimer le code mort du modal | `wire()` ne contient plus d'action ADR |
| A008 | Ajouter | nouvelle `renderAdrs()` (top-level) + état module `adrFilters = { status:'', repo:'', q:'' }` : (1) garde `currentProject` ; (2) `api('/api/docs?projectId=' + currentProject + '&includeRepoDocs=1')` filtré `kind === 'adr-tech'` + `api('/api/repos?project=' + currentProject)` + `api('/api/projects')` (objet projet pour `adrFormModal`) ; (3) shell dans `#pane-adr` (titre + `<div id="adr-table-wrap">`) ; (4) `adrTableHtml({ projectId: currentProject, adrs, repos, filter: adrFilters, prefix: 'adr' })` ; (5) `bindAdrTable(pane, { prefix:'adr', projectId: currentProject, project, docs: adrs, repos, onChange: renderAdrs })` | `public/app.js` | `public/app.js` | **Cœur de l'onglet projet** : table + filtres + recherche + CRUD + pièces jointes | Onglet ADR projet opérationnel (rendu et rafraîchissement) |
| A009 | Modifier | carte `RENDER` (l.5852-5855) : ajouter `adr: renderAdrs` | `public/app.js` | `public/app.js` | `refreshActive()` (l.5875-5885) route le rendu par `RENDER[activeTab]` (clic d'onglet + polling) | Onglet rendu au clic et au rafraîchissement automatique |
| A010 | Ajouter | styles `.adr-pane-filters`, `.adr-search`, `.adr-table-wrap`, `.adr-table` (barre de filtres responsive + table scrollable), près du bloc `.art-filters` / `.art-manager` (l.999-1009) | `public/style.css` | `public/style.css` | Rendu propre/responsive de l'onglet (classes utilisées par A004/A008) | Classes CSS disponibles et utilisées |
| A011 | Vérifier | `node --check public/app.js` + `pm2 restart orchestrator-panel` + parcours manuel complet (cf. §8) | `/root/orchestrator-panel` | — | `node --check` ne valide **pas** le rendu ; pas de CI | Rapport de vérification + service relancé OK |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/orchestrator-panel/public/app.js` | **Modification** — A001 (`ensurePane`/`switchTab`), A002 (`PROJECT_TABS` **uniquement**), A003 (`adrAttachmentsCell`), A004 (`adrTableHtml`), A005 (`bindAdrTable`), A006 + A007 (retrait onglet ADR du `projectDetailModal`), A008 (`renderAdrs`), A009 (`RENDER`) |
| `/root/orchestrator-panel/public/style.css` | **Modification** — A010 (classes de l'onglet ADR) |
| `/root/orchestrator-panel/server.mjs` | **Aucune modification** — l'API requise existe déjà (`/api/docs[?projectId&includeRepoDocs]`, `/api/docs/:id`, `/api/docs/:id/attachments[/:attId[/download]]`, `/api/docs/:id/content`, `/api/repos?project`, `/api/projects`) |
| `/root/orchestrator-panel/public/index.html` | **Aucune modification** — hors périmètre ; le pane `adr` est créé dynamiquement par A001 |
| `/root/orchestrator-panel/public/app.js` — `GLOBAL_TABS` (l.88-94) | **Aucune modification** — contrainte explicite : aucune entrée ADR dans la barre globale |

**Fonctions / routes réutilisées sans duplication** : `ADR_STATUS`, `adrStatusBadge`, `adrGlobalBadge`,
`adrCellText`, `adrAttSourceBadge`, `adrAttachmentsCell` (A003), `arrayBufferToBase64`, `viewRefDoc`,
`adrFormModal`, `adrAttachmentModal` ; `esc`, `api`, `showModal`, `closeModal` ; `GET /api/docs`,
`POST /api/docs`, `PUT/DELETE /api/docs/:id`, `POST/DELETE /api/docs/:id/attachments`,
`GET /api/docs/:id/attachments/:attId/download`, `GET /api/docs/:id/content`, `GET /api/repos`, `GET /api/projects`.

## 5. Livrables attendus

1. Entrée **« ADR »** présente **uniquement** dans `PROJECT_TABS` (visible projet ouvert, **absente** à l'accueil) — **`GLOBAL_TABS` inchangé**.
2. `renderAdrs()` enregistrée dans la carte `RENDER` (`adr: renderAdrs`), ouvrable **sans** le modal de détail projet.
3. Table des **ADR du projet courant** : **Titre, Statut, Contexte, Décision, Conséquences, Repos rattachés (+ badge « globale »), Pièces jointes, Actions**.
4. **Filtres** statut (`Proposé|Accepté|Déprécié|Remplacé`) / repo + **recherche** texte (titre/contexte/décision/conséquences/chemin).
5. **CRUD ADR** (créer / éditer / regarder / supprimer) et **pièces jointes** (ajouter / retirer / télécharger) depuis l'onglet, via l'API existante.
6. `adrTableHtml` + `bindAdrTable` **mutualisés** (un seul rendu, un seul câblage) ; réemploi de `adrFormModal`, `adrAttachmentModal`, `viewRefDoc`, `adrAttachmentsCell`.
7. **Onglet ADR interne au `projectDetailModal` retiré** (entrée d'onglet, branche de rendu et bloc de câblage supprimés, code mort nettoyé).
8. Classes CSS `.adr-pane-filters` / `.adr-search` / `.adr-table-wrap` / `.adr-table`.
9. **Aucune régression** des autres onglets (Projets, Tâches, Artefacts, Recettes, Écosystème, Workspaces, Utilisateurs…) ni des onglets restants du modal projet ; vérification de rendu effectuée (A011).

## 6. Ordre & dépendances

```
A001 (pane) ──► A002 (PROJECT_TABS)
A003 (cellule préfixée) ──► A004 (adrTableHtml) ──► A005 (bindAdrTable)
                                   │                        │
                                   ├──► A010 (CSS)          │
                                   └──► A008 (renderAdrs) ◄─┘
A004 ──► A006 (retrait onglet ADR du modal)      [supprime la dernière référence à l'ancien rendu]
A005 ──► A007 (retrait câblage ADR du modal)     [remplacé par bindAdrTable]
A008 ──► A009 (RENDER.adr) ──► A011 (vérif)
```

- **A001** : prérequis de rendu (sans `#pane-adr`, l'onglet ne s'affiche pas).
- **A003 → A004** : `adrTableHtml` transmet le préfixe à `adrAttachmentsCell`.
- **A004 → A005** : `bindAdrTable` câble exactement les mêmes préfixes/ids que `adrTableHtml`.
- **A004 → A006** : après le renommage, la branche `tab === 'adr'` (l.3951) référencerait `adrTabHtml` disparu → **A006 est obligatoire** (sinon `ReferenceError` à l'ouverture de l'onglet ADR du modal).
- **A005 → A007** : le bloc de câblage du modal est remplacé par `bindAdrTable`.
- **A004, A005 → A008** : `renderAdrs` consomme la table et le câblage mutualisés.
- **A008 → A009** : `RENDER.adr = renderAdrs` (fonction hoistée, mais ordre logique garanti).
- **A011** : dernier (vérification manuelle après toutes les modifications).

## 7. Couverture des objectifs

| Exigence | Étape(s) | Couvert ? |
|----------|----------|-----------|
| Entrée « ADR » **dans `PROJECT_TABS` uniquement** (à l'intérieur du projet) | A002 | ✅ |
| **`GLOBAL_TABS` NON touché** (aucune entrée ADR à l'accueil) | A002 (contrainte explicite) | ✅ |
| Rendu dédié (`renderAdrs`) enregistré dans la carte des vues | A008, A009 | ✅ |
| Table des ADR **du projet courant** : Titre/Statut/Contexte/Décision/Conséquences/Repos + badge « globale » | A004, A008 | ✅ |
| Filtres statut / repo + **recherche** (projet = contexte, donc pas de filtre projet) | A004, A005, A008 | ✅ |
| CRUD ADR (créer / éditer / supprimer) depuis l'onglet | A005, A008 (API + `adrFormModal` existants) | ✅ |
| Pièces jointes (ajout / retrait / téléchargement) | A003, A004, A005, A008 | ✅ |
| **Retrait de l'onglet ADR interne au `projectDetailModal`** | A006, A007 | ✅ |
| Logique **mutualisée** (rendu + câblage), pas dupliquée | A003, A004, A005 | ✅ |
| Onglet ADR visible/activable (pane) | A001 | ✅ |
| Aucune régression des autres onglets / du modal | A001, A002, A006, A007, A009, A011 | ✅ |
| Vérification de rendu (pas seulement `node --check`) | A011 | ✅ |

## 8. Vérification de cohérence

- **Contradictions intra-plan** : aucun élément de code visé par deux actions incompatibles.
  - `adrTabHtml` : **A004 = renommer/refondre** (définition) et **A006 = supprimer son site d'appel** (l.3951) → actions complémentaires, pas contradictoires (aucun `supprimer`+`modifier` sur le *même* élément).
  - `projectDetailModal` : **A006** cible l'entrée d'onglet + la branche de rendu + 2 variables mortes ; **A007** cible le bloc de câblage `wire()` → éléments distincts.
  - `PROJECT_TABS` : **A002** = un seul `ajouter`. `GLOBAL_TABS` : **aucune action** (contrainte explicite).
  - `adrAttachmentsCell` (A003), `RENDER` (A009) : un seul verbe par élément. Aucun `créer`+`renommer` sur le même élément.
- **Ordre / dépendances** : aucun accès à un élément créé par une étape ultérieure. A004 précède A006 (évite une référence pendante) ; A005 précède A007 ; A008 dépend de A004/A005 ; A009 dépend de A008. ✔
- **Couverture** : 100 % des exigences mappées (§7), y compris la **non-action** sur `GLOBAL_TABS`. ✔
- **Plan Validator** : **Valid** (pas de contradiction, couverture complète, étapes atomiques et localisées).

## 9. Risques & notes

- **`index.html` hors périmètre → pane dynamique** (A001). Le helper `ensurePane` est **idempotent** (ne recrée pas une section existante) et couvre aussi tout futur onglet. Alternative 1-ligne dans `index.html` **non retenue** pour respecter strictement le périmètre déclaré.
- **Recherche = filtre client** : le filtrage `q`/statut/repo s'applique **côté client** sur la liste déjà chargée (`filter` de `adrTableHtml`), sans requête supplémentaire — comportement identique à l'actuel `adrTabHtml` et à `bindAdrSelector` (l.4495).
- **Portée projet** : `renderAdrs` interroge `/api/docs?projectId=<currentProject>&includeRepoDocs=1` (même requête que le modal, l.3912) → les ADR des **repos transverses** du projet sont incluses ; le scoping organisation reste porté par `/api/projects` et `/api/repos` (filtrés par org). Aucune fuite inter-orgs.
- **Retrait d'un repo rattaché** : l'API registre est **additive** (`addRepoIds` / `setGlobal`) ; le retrait d'un repo précis n'est pas exposé. Limitation **existante** conservée (mention déjà présente dans `adrFormModal`, l.4564) — hors périmètre.
- **`adrSelectorHtml` / `bindAdrSelector`** (l.4448/4495, items 125) : utilisés par les modales de création de tâche/recette et la vue Artifacts — **non touchés** par ce plan (leur libellé d'aide « onglet ADR du projet » reste correct et gagne même en exactitude).
- **Collision de nom** : `renderAdrs` existe aussi comme `const` **local** dans des fonctions d'autres onglets (l.1681, l.2349, l.2844) — ces déclarations sont **function-scoped** et masquent la fonction top-level uniquement dans leur portée ; aucun conflit ni TDZ au niveau module.
- **Pas de CI** : la vérification est **manuelle** (A011). `node --check public/app.js` est un pré-check ; il **ne suffit pas** — valider le **rendu** réel après `pm2 restart orchestrator-panel` (onglet ADR présent projet ouvert, **absent** à l'accueil, modal projet sans onglet ADR, CRUD + pièces jointes OK).
- **Tests E2E** : **E2E NA** — `e2e_list(project=ecosystem)` → **0 test** ; le projet `ecosystem` n'a **pas** d'`e2eRepoDir` (panneau d'infra hôte, pas de spec Playwright). Aucun `e2e_test_register` / `e2e_test_link` à créer ; la non-régression est couverte par le parcours manuel A011.
