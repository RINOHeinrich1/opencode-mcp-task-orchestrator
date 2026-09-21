# Rapport d'exécution — Onglet ADR dédié au détail projet (panneau opencode-observability)

- **Tâche** : `T-20260920-162754-b4cb` (executionId `E-T-20260920-162754-b4cb-psd1r3`)
- **Plan** : `Plan-onglet-adr-panneau-20260920-165510` (9 étapes A001–A009 — **100 % done**)
- **Projet** : `ecosystem` — repo `opencode-observability` (`/root/orchestrator-panel`, workspace Coder = `null`, outil d'infra hébergé sur l'hôte)
- **Agent** : `build-notify` (executor) — date : 2026-09-20 17:26 UTC

## 1. Résumé

Ajout d'un **onglet ADR dédié** dans la modale détail projet du panneau : table structurée à
**6 colonnes** (Titre, Statut, Contexte, Décision, Conséquences, Pièces jointes) + colonne Actions,
**CRUD** (créer / éditer / regarder / supprimer), **rattachement à 1..N repos** du projet ou « tous
les repos » (ADR **globale**, signalée par un badge), **filtres statut/repo**. Le panneau est
désormais branché sur l'interface MCP `doc_*` livrée par la dépendance `T-20260920-162753-hpcj`
(item 120) : `status/context/decision/consequences/replacedBy/repoIds/global` (+ `addRepoIds`/
`setGlobal` en édition). Route `PUT /api/docs/:id` **ajoutée** (elle était absente).

## 2. Isolation

- **Espace Coder** : aucun (`opencode-observability` a `workspace=null`) — panneau = outil
  d'infrastructure hébergé sur l'hôte, checkout `/root/orchestrator-panel` **légitime** (cadre fourni).
- **session-guard** : `acquire` a renvoyé `mode=in-place`, **mais** le checkout principal était sur la
  branche `build-notify/opencode-restart-buttons` avec des **modifications non commitées d'une AUTRE
  tâche** (visionneuse plein écran + route `GET /api/docs/:id/download`, dont `public/style.css` **hors
  périmètre**). Pour ne pas perturber ce travail, j'ai basculé en **worktree isolé** (le cadre autorise
  « worktree si possible »).
- **Worktree** : `/tmp/opencode/opencode-observability-wt-adr` (chemin autorisé par les règles
  d'accès de la session ; le chemin par défaut de session-guard, `/root/orchestrator-panel-wt-…`, était
  **hors** des chemins autorisés → recréé dans `/tmp/opencode/`, verrou session-guard corrigé en
  conséquence).
- **Branche de travail** : `build-notify/onglet-adr-panneau`, basée sur `d7a5867` (HEAD du checkout
  principal, **26 commits devant / 0 derrière** `origin/feature/migration-postgresql` → base à jour
  avec la branche de déploiement).
- Le checkout principal et ses modifications non commitées n'ont **pas** été touchés.

## 3. Branches et commits

| Branche | Base | Commit | Message |
|---------|------|--------|---------|
| `build-notify/onglet-adr-panneau` | `d7a5867` | `62f67c6` | feat(adr): onglet ADR structuré dans le détail projet (table 6 colonnes + CRUD + rattachement repos) |

- `git show --stat 62f67c6` : 3 fichiers, +279 / −2.
- Commit enregistré dans la trace append-only du plan (`plan_commit_add` → `count:1`).
- **Pas de push** effectué (push/déploiement = orchestrateur après review/merge humain).
- **Pas de redémarrage** du service de prod (`pm2 orchestrator-panel`) — étape de déploiement.

## 4. Traitements effectués (A001–A009)

| Étape | Fichier | Traitement | Statut |
|-------|---------|-----------|--------|
| A001 | `pilot.mjs` | `registerDoc` transmet `status/context/decision/consequences/replacedBy/repoIds/global` | done |
| A002 | `pilot.mjs` | `updateDoc` transmet `status/context/decision/consequences/replacedBy/addRepoIds/setGlobal` | done |
| A003 | `pilot.mjs` | `registerDocUpload` conserve les champs ADR + rattachements (chemin import) | done |
| A004 | `server.mjs` | route `PUT /api/docs/:id` → `pilot.updateDoc` ; pass-through ADR sur la branche upload | done |
| A005 | `public/app.js` | `ADR_STATUS`, `adrStatusBadge`, `adrGlobalBadge`, `adrAttachmentsCell`, `adrCellText` | done |
| A006 | `public/app.js` | `adrTabHtml` — table 6 colonnes + Actions, filtres statut/repo, badge globale | done |
| A007 | `public/app.js` | `adrFormModal` — création (upload/chemin + repoIds/global) / édition (champs + addRepoIds/setGlobal) | done |
| A008 | `public/app.js` | onglet « ADR (n) » dans `projectDetailModal` (tabs + branche render) | done |
| A009 | `public/app.js` | `wire()` — créer/éditer/regarder/supprimer + filtres, reload `loadDocs()`+`render()` | done |

## 5. Fichiers modifiés / créés

- `pilot.mjs` (modifié) — A001/A002/A003.
- `server.mjs` (modifié) — A004 + pass-through upload.
- `public/app.js` (modifié) — A005/A006/A007/A008/A009.
- **Aucun fichier de code créé**, **aucune** modification du registre MCP (`db.mjs`/`index.mjs`),
  **aucune** modification de `public/style.css` (hors périmètre).

## 6. Tests / vérifications

- **Syntaxe** : `node --check` OK sur `pilot.mjs`, `server.mjs`, `public/app.js`.
- **Test de contrat MCP (16/17 PASS)** via `mcp-client.mjs` du panneau (spawn frais de
  `index.mjs`, exactement le chemin d'appel du panneau) : `doc_register` persiste
  `status/context/decision/consequences`, `repoIds` → `repos`, `isGlobal=false` ; `doc_get` ;
  `doc_update` (`status`, `decision`, `addRepoIds`) ; `setGlobal=true` → `isGlobal=true` + rattachement
  des 4 repos du projet ; `doc_list(projectId, includeRepoDocs)` retrouve le doc et expose `status`.
  Doc de test créé puis **supprimé** (nettoyage).
- **Test unitaire du rendu (16/16 PASS)** : code réel extrait de `public/app.js` — en-têtes des 6
  colonnes, badge « globale », pièce jointe, boutons Actions, bouton « Nouvelle ADR », chips repo,
  filtres statut/repo (inclusion/exclusion), état vide.
- **Route HTTP** : regex `^/api/docs/([^/]+)$` matche `/api/docs/:id` et **exclut** `/content` et
  `/download` (pas de collision) ; `readBody` ne rejette jamais (résout `{}`).
- **Non testé en live** : pas de démarrage d'une instance serveur (évite de perturber la prod) ;
  vérification fonctionnelle finale = **contrôle manuel après relance** (E2E NA — plan §10 : aucun test
  E2E enregistré pour `ecosystem`, ni `e2eRepoDir`/`e2eBaseUrl`).

## 7. Avertissements / erreurs

1. **Serveur MCP de la session agent périmé** : les process MCP longue durée d'opencode (dont le mien)
   ont démarré à 15:27, **avant** le commit item 120 (16:51) → mes premiers appels via mes *outils* MCP
   ne voyaient pas les champs ADR. **Sans impact sur le livrable** : le panneau (`mcp-client.mjs`)
   **spawn un process MCP frais par appel** et chargera donc le code à jour. Le test de contrat a été
   rejoué par ce chemin (16/17 PASS).
2. **Bug de registre découvert (hors périmètre)** : `db.mjs` `listDocs`, branche
   `projectId && includeRepoDocs`, a une **précédence SQL** fautive
   (`WHERE id IN (…) OR id IN (…) AND d.status=$n`) → le filtre `status` ne s'applique qu'à la branche
   repo, pas aux docs directement rattachés au projet. Tracé en incident **`INC-011`** (sévérité
   medium). **Impact nul sur l'onglet livré** : le panneau filtre le statut **côté client** dans
   `adrTabHtml` (conforme au plan A006).
3. **Retrait d'un repo rattaché impossible** : l'interface registre est **additive** (`addRepoIds`,
   `setGlobal`) — pas de retrait d'un repo précis. Le formulaire le signale (limitation connue, plan
   §9.1, extension registre hors périmètre).
4. **Colonne « Pièces jointes »** : lue depuis `d.meta?.attachments` / `d.attachments` ; affiche « — »
   tant que l'item 122 (CRUD des pièces jointes) n'est pas livré — lecture tolérante, aucun rework
   attendu (plan §9.2).
5. **Édition d'ADR** : le formulaire d'édition expose le **chemin** du document (pas de ré-upload, faute
   de route d'upload en édition) ; la création propose import fichier OU chemin.
6. Le formulaire ADR remplace la modale détail projet (un seul `modal-backdrop`) ; après
   enregistrement, `render()` ré-affiche le détail projet. Comportement identique à l'existant
   `viewRefDoc`.

## 8. Prochaines étapes / recommandations

1. **Review/merge humain** de `build-notify/onglet-adr-panneau` (commit `62f67c6`) puis **relance**
   manuelle du panneau (pas de CI) — l'orchestrateur gère le déploiement.
2. **Vérification manuelle** post-relance : créer/éditer/supprimer une ADR ; choisir 1..N repos ou
   « tous » (badge globale) ; filtres statut/repo ; consulter le contenu ; vérifier l'inclusion des
   docs des repos transverses.
3. Corriger le bug de registre `INC-011` (parenthéser l'OR dans `listDocs`) — tâche dédiée, hors
   périmètre de celle-ci.
4. Item 122 (pièces jointes) alimentera la colonne sans rework.
5. Base de sync `origin/feature/migration-postgresql` : HEAD déjà à jour (0 derrière) — rebase trivial
   avant push si la branche principale avance.
