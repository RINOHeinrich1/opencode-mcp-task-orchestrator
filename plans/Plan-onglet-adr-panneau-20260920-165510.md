# Plan — Onglet ADR dédié au détail projet (panneau opencode-observability)

- **Plan ID** : `Plan-onglet-adr-panneau-20260920-165510`
- **Tâche** : `T-20260920-162754-b4cb` (executionId `E-T-20260920-162754-b4cb-psd1r3`)
- **Projet** : `ecosystem` — repo `opencode-observability` (`/root/orchestrator-panel`)
- **Batch** : `BATCH-mua15lwb-ifqw` (ordre 2/8)
- **Recette source** : `RECT-mu9yzd23-8l7t` — item 121
- **Dépendance (livrée)** : `T-20260920-162753-hpcj` — modèle ADR structuré côté registre MCP
  (`Plan-adr-modele-structure-20260920-163126.md`, commit `2ff160cb`) : `doc_register`/`doc_update`/`doc_get`/`doc_list`
  exposent `status`, `context`, `decision`, `consequences`, `replacedBy`, `repoIds` (1..N), `global`, `setGlobal`, filtre `status`.
- **Date** : 2026-09-20 16:55:10
- **Fichier plan** : `plans/Plan-onglet-adr-panneau-20260920-165510.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)

## 1. Objectif

Ajouter un **onglet ADR dédié** dans la **modale détail d'un projet** du panneau, affichant une
**table structurée à 6 colonnes** (Titre, Statut, Contexte, Décision, Conséquences, Pièces jointes),
avec **CRUD des ADR depuis l'onglet**, **rattachement à 1..N repos du projet** (ou « tous les repos »
= ADR globale, signalée par un badge), et **filtrage par projet incluant les documents des repos
transverses** (`includeRepoDocs`).

## 2. Contexte & raison d'être

Aujourd'hui, la modale détail projet (`public/app.js` → `projectDetailModal`, l.3676) n'a que
**3 onglets internes** : `Projet`, `Repos`, `Documents` (l.3697-3701). L'onglet `Documents`
(`docsTabHtml`, l.3795) liste les documents ADR-12 **comme des fichiers** (kind + titre + `path`),
sans restituer les champs structurés ADR. La recette `RECT-mu9yzd23-8l7t` (description) exige une
ADR « correctement formatée en tables dédiées avec des colonnes adaptées au lieu d'un document
unique » — Titre / Statut / Contexte / Décision / Conséquences / Pièces jointes.

La dépendance `T-20260920-162753-hpcj` (item 120, **livrée et mergée**) a porté ces champs dans le
registre : la table `docs` porte désormais `status` (`Proposé|Accepté|Déprécié|Remplacé`), `context`,
`decision`, `consequences`, `replaced_by`, `is_global`, `meta`, `updated_at` ; `rowToDoc`/`enrichDocs`
les exposent dans `doc_list`/`doc_get` ; `doc_register` accepte `repoIds` (1..N) et `global` ;
`doc_update` accepte `addRepoIds` et `setGlobal`. **Le panneau ne consomme pas encore cette interface** :
le wrapper `pilot.mjs` ne transmet ni ne lit les champs ADR, et aucune route d'édition de doc n'existe
(`pilot.updateDoc` l.556 est **orphelin** : aucune route ne l'appelle).

Ce plan branche donc le panneau sur l'interface ADR livrée :
- `pilot.mjs` : pass-through des champs ADR vers `doc_register` / `doc_update` ;
- `server.mjs` : route d'édition `PUT /api/docs/:id` (manquante) ;
- `public/app.js` : onglet `ADR` (table 6 colonnes + CRUD + rattachement repos/globale + filtres).

Le périmètre de la tâche est limité à `/root/orchestrator-panel/{public/app.js, server.mjs, pilot.mjs}` :
**aucune modification du registre MCP** (`db.mjs`/`index.mjs` déjà livrés par item 120).

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Modifier | `registerDoc()` (l.548-555) : ajouter `status`, `context`, `decision`, `consequences`, `replacedBy`, `repoIds`, `global` à l'appel `taskOrchestrator("doc_register", …)` | `pilot.mjs` | `pilot.mjs` | L'onglet crée des ADR structurées ; le wrapper n'expose pas les champs livrés par item 120 | `registerDoc` transmet les 7 champs ADR à `doc_register` |
| A002 | Modifier | `updateDoc()` (l.556-562) : ajouter `status`, `context`, `decision`, `consequences`, `replacedBy`, `addRepoIds`, `setGlobal` | `pilot.mjs` | `pilot.mjs` | Édition d'une ADR (champs + rattachements) depuis l'onglet | `updateDoc` transmet les champs ADR + `addRepoIds`/`setGlobal` |
| A003 | Modifier | `registerDocUpload()` (l.580-601) : ajouter `status`, `context`, `decision`, `consequences`, `replacedBy`, `repoIds`, `global` au `doc_register` (l.591-599) | `pilot.mjs` | `pilot.mjs` | Création d'ADR par **import de fichier** : ne pas perdre les champs structurés (chemin `upload`) | Une ADR importée conserve ses champs structurés et ses rattachements |
| A004 | Ajouter | Route `PUT /api/docs/:id` (nouveau bloc après `docDelMatch`, ~l.1650) : `pilot.updateDoc({ docId: <id>, ...b })` | `server.mjs` | `server.mjs` | **Aucune route d'édition de doc n'existe** (`pilot.updateDoc` orphelin) — le CRUD de l'onglet exige l'édition | `PUT /api/docs/:id` met à jour une ADR (champs + rattachements) |
| A005 | Ajouter | Constante `ADR_STATUS = ['Proposé','Accepté','Déprécié','Remplacé']` + helpers `adrStatusBadge(status)`, `adrGlobalBadge(d)`, `adrAttachmentsCell(d)`, près de `docKindLabel`/`DOC_KIND_ORDER` (l.3986-3992) | `public/app.js` | `public/app.js` | Référentiel unique des statuts (miroir de `ADR_STATUS` du registre) + rendu badge « globale » + colonne Pièces jointes | Helpers de rendu ADR disponibles |
| A006 | Ajouter | Fonction `adrTabHtml(p, adrs, repos, filter)` (top-level, près de `viewRefDoc`, l.3997) : table 6 colonnes (Titre, Statut, Contexte, Décision, Conséquences, Pièces jointes) + barre de filtres (statut, repo) + chips repos + badge globale + boutons Éditer/Regarder/Supprimer | `public/app.js` | `public/app.js` | Cœur de l'onglet : table structurée ADR | Rendu HTML de la table ADR (6 colonnes) |
| A007 | Ajouter | Fonction `adrFormModal(p, repos, adr, onSaved)` (top-level, près de `viewRefDoc`, l.3997) : formulaire création/édition — Titre, Statut (`ADR_STATUS`), Contexte, Décision, Conséquences, repos multi-select (1..N) + case « tous les repos (globale) », document (upload OU chemin) ; `POST /api/docs` (création) / `PUT /api/docs/:id` (édition) | `public/app.js` | `public/app.js` | CRUD création/édition des ADR depuis l'onglet | Modale de création/édition d'ADR fonctionnelle |
| A008 | Modifier | `projectDetailModal()` : `tabs` (l.3697-3701) + branche de rendu `render()` (l.3716-3718) — ajouter `['adr', 'ADR (n)']`, dériver `pAdrs = allDocs.filter(d => d.kind === 'adr-tech')`, brancher `adrTabHtml(...)` | `public/app.js` | `public/app.js` | Rendre l'onglet ADR accessible dans la modale détail projet | 4e onglet « ADR » affichant la table structurée |
| A009 | Modifier | `wire()` (l.3824-3931) : brancher les actions de l'onglet ADR (`data-pd-adr-new`, `data-pd-adr-edit`, `data-pd-adr-del`, `data-pd-adr-view`) + filtre statut ; recharger via `loadDocs()` + `render()` après mutation | `public/app.js` | `public/app.js` | Câbler le CRUD et la consultation (réutilise `DELETE /api/docs/:id` l.1646 et `viewRefDoc` l.3997) | Actions ADR câblées (créer/éditer/supprimer/regarder) |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/orchestrator-panel/pilot.mjs` | Modification — `registerDoc` (A001), `updateDoc` (A002), `registerDocUpload` (A003) |
| `/root/orchestrator-panel/server.mjs` | Modification — nouvelle route `PUT /api/docs/:id` (A004) |
| `/root/orchestrator-panel/public/app.js` | Modification — helpers ADR (A005), `adrTabHtml` (A006), `adrFormModal` (A007), `projectDetailModal` (A008), `wire` (A009) |

Aucune création de fichier de code. **Aucune** modification de `db.mjs`/`index.mjs` (registre, item 120 déjà livré).
Routes **existantes réutilisées** : `GET /api/docs` (l.1621, `includeRepoDocs=1` → filtrage projet + repos transverses),
`POST /api/docs` (l.1632, `...b` → champs ADR), `DELETE /api/docs/:id` (l.1646), `GET /api/docs/:id/content` (l.1654, via `viewRefDoc`).

## 5. Livrables attendus

1. `pilot.mjs` : `registerDoc` transmet `status/context/decision/consequences/replacedBy/repoIds/global` (A001).
2. `pilot.mjs` : `updateDoc` transmet `status/context/decision/consequences/replacedBy/addRepoIds/setGlobal` (A002).
3. `pilot.mjs` : `registerDocUpload` transmet les champs ADR au `doc_register` (A003).
4. `server.mjs` : route `PUT /api/docs/:id` → `pilot.updateDoc` (A004).
5. `public/app.js` : `ADR_STATUS`, `adrStatusBadge`, `adrGlobalBadge`, `adrAttachmentsCell` (A005).
6. `public/app.js` : `adrTabHtml` — table ADR à 6 colonnes + filtres statut/repo + badge globale (A006).
7. `public/app.js` : `adrFormModal` — création/édition ADR + sélection repos 1..N / globale + document (A007).
8. `public/app.js` : onglet interne « ADR (n) » dans la modale détail projet (A008).
9. `public/app.js` : actions CRUD/consultation câblées dans l'onglet ADR (A009).
10. Comportement : créer / éditer / supprimer une ADR ; choisir 1..N repos ou « tous » (badge globale) ;
    la table affiche Titre/Statut/Contexte/Décision/Conséquences/Pièces jointes et filtre par projet
    (docs des repos transverses inclus via `includeRepoDocs`).

## 6. Ordre & dépendances

```
A001 ─┐
A002 ─┼─► A004 ─┐
A003 ─┘         │
                ├─► A007 ─┐
A005 ─► A006 ───────────┼─► A009
                A008 ───┘
```

- **A001, A002, A003** (pass-through `pilot.mjs`) sont indépendantes entre elles (fonctions distinctes) ;
  **A004** (route d'édition) dépend de **A002** (`pilot.updateDoc`).
- **A005** (helpers) précède **A006** (table) et **A007** (formulaire) — statuts + badge globale + cellule Pièces jointes.
- **A006** (table) et **A008** (onglet) sont nécessaires pour l'affichage ; **A007** (formulaire) pour le CRUD.
- **A009** (wiring) dépend de **A006**, **A007**, **A008** (les fonctions ciblées doivent exister).
- A001/A003 (création) et A002/A004 (édition) alimentent A007 (le formulaire appelle les routes correspondantes).

## 7. Couverture des objectifs

| Exigence (item 121 / critère d'acceptation) | Étape(s) | Couvert ? |
|---------------------------------------------|----------|-----------|
| Un **onglet ADR** dans le détail d'un projet | A008 | ✅ |
| Colonne **Titre** | A006, A007 | ✅ |
| Colonne **Statut** (Proposé/Accepté/Déprécié/Remplacé) | A005, A006, A007 | ✅ |
| Colonne **Contexte** | A006, A007 | ✅ |
| Colonne **Décision** | A006, A007 | ✅ |
| Colonne **Conséquences** | A006, A007 | ✅ |
| Colonne **Pièces jointes** | A005 (`adrAttachmentsCell`), A006 | ✅ (affichage ; alimentation = item 122, cf. §9) |
| **Créer** une ADR depuis l'onglet | A001, A003, A007, A009 | ✅ |
| **Éditer** une ADR depuis l'onglet | A002, A004, A007, A009 | ✅ |
| **Supprimer** une ADR depuis l'onglet | A009 (route `DELETE /api/docs/:id` existante) | ✅ |
| **Consulter** le contenu d'une ADR | A009 (`viewRefDoc` → `GET /api/docs/:id/content`) | ✅ |
| Rattachement à **1..N repos** du projet | A001 (`repoIds`), A002 (`addRepoIds`), A007 | ✅ |
| **ADR globale** = tous les repos du projet | A001 (`global`), A002 (`setGlobal`), A007 | ✅ |
| Ligne ADR globale **identifiable** (badge) | A005 (`adrGlobalBadge`), A006 | ✅ |
| **Filtrage par projet** (incl. docs des repos transverses) | A008 (`loadDocs` existant → `/api/docs?projectId=…&includeRepoDocs=1`) | ✅ |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** — regroupement par élément cible :

- `pilot.mjs` / `registerDoc` (A001), `updateDoc` (A002), `registerDocUpload` (A003) : **trois fonctions
  distinctes**, chacune ajoutant le même jeu de champs à son propre appel MCP — **complémentaires**, pas de
  contradiction (création par chemin / édition / création par import).
- `server.mjs` / `docs` : A004 **ajoute** `PUT /api/docs/:id` (nouvelle route). Aucun conflit avec les routes
  existantes (`GET/POST /api/docs`, `DELETE`, `/content`, `/download`) : méthodes et motifs distincts.
- `public/app.js` / `adrTabHtml` (A006) et `adrFormModal` (A007) : **nouvelles fonctions top-level distinctes**.
- `public/app.js` / `projectDetailModal` : A008 touche la liste `tabs` (l.3697-3701) et la branche de rendu
  `render()` (l.3716-3718) ; A009 touche la closure `wire()` (l.3824-3931). **Régions disjointes** de la même
  fonction — pas de recouvrement, pas de contradiction.
- Aucune étape `supprimer` sur un élément créé/modifié par une autre ; aucune lecture d'un élément créé plus tard.
- Aucune étape vague : chaque action cible un élément nommé, dans un fichier identifié, avec un verbe précis.

**Résultat Plan Validator : `Valid`.**

## 9. Risques & notes

1. **Édition des rattachements repos — interface additive.** `doc_update` (item 120) expose `addRepoIds`
   (ajout) et `setGlobal` (bascule globale) mais **pas** le retrait d'un repo précis. Depuis l'onglet, on peut
   donc **ajouter** des repos et basculer « tous les repos », mais **pas retirer** un repo déjà rattaché. Le
   formulaire le signale ; un retrait complet exigerait une extension registre (`setRepoIds`/`repoIds` remplaçant)
   **hors périmètre** (le scope de la tâche est limité aux 3 fichiers du panneau).
2. **Colonne « Pièces jointes » — alimentation par l'item 122.** Les données sont lues depuis
   `d.meta?.attachments` (ou `d.attachments`) — champ `meta` livré par item 120. Le **CRUD des pièces jointes**
   est l'item 122 (`T-20260920-162755-3qxj`, ordre 3), hors périmètre. Tant que 122 n'est pas livré, la colonne
   affiche « — » (0) ; elle se remplira sans rework. Aucune invention d'interface : lecture tolérante.
3. **`path` requis par `doc_register`.** Une ADR reste un doc pointant un fichier (`path` NOT NULL, item 120).
   Le formulaire ADR conserve donc un champ **document** (import d'un fichier OU référence d'un chemin), cohérent
   avec l'onglet `Documents` existant — les champs structurés sont portés par les colonnes.
4. **Chevauchement avec l'onglet `Documents`.** Une ADR (`kind=adr-tech`) apparaît à la fois dans l'onglet
   `Documents` (vue fichier) et le nouvel onglet `ADR` (vue structurée). Assumé : le nouvel onglet est la vue
   structurée ; la réorganisation en gestionnaire d'« Artefacts » unique est l'item 127 (ordre 8).
5. **Déploiement / vérification.** Le panneau est relancé directement **sans CI** (vigilance item 121) :
   vérification **manuelle** après livraison (créer/éditer/supprimer une ADR, badge globale, filtres).
6. **Ne pas oublier A003.** Si `registerDocUpload` n'est pas étendu, une ADR créée par **import de fichier**
   perdrait `status/context/decision/consequences/replacedBy/repoIds/global` (le serveur emprunte la branche
   `filename && dataBase64`, l.1635).

## 10. Tests E2E Playwright — analyse d'impact

**E2E : NA.** Aucun test E2E Playwright n'est enregistré pour le projet `ecosystem`
(`e2e_list(project="ecosystem")` → `count: 0`) et le repo `opencode-observability` n'a **ni `e2eRepoDir`
ni `e2eBaseUrl`**. La vérification attendue est un **contrôle manuel** du panneau après relance (l'item 121
précise « le panneau est relancé directement sans CI : vérification manuelle après livraison »).
Aucune entité E2E n'est donc créée ni liée pour cette tâche.
