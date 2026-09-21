# Plan — Pièces client par projet (natures admises, garde photo/vidéo, émergence, requalification des docs ADR-12)

- **Tâche** : `T-20260921-091730-1rt5` (exécution `E-T-20260921-091730-1rt5-rud54z`)
- **Projet** : `ecosystem` — batch `BATCH-mub1809u-06ow` (tâche 2/9)
- **Date** : 2026-09-21 09:33:49
- **Dépendance** : `T-20260921-091728-nviw` (TERMINÉE — modèle SQL `fonctionnalites` / `regles_metier` / `sprints` + 12 liens N:N, commit `3ee7755`)

## 1. Objectif

Mettre en place les **PIÈCES CLIENT par projet** (matière première des sprints) :
- natures admises **markdown, pdf, docx, lien Drive public (lecture)** avec **garde qui refuse photo et vidéo** (à l'import **et** pour les liens externes) ;
- lien Drive ajouté comme **URL publique** (l'agent lit le contenu via l'URL), avec la **limite de sécurité documentée** ;
- **requalification SANS PERTE** des documents ADR-12 existants (`specs`, `gherkin`, `adr`) en pièces client du projet ;
- pièce reçue **après l'initialisation d'un sprint** → marquée **ÉMERGENTE** (tracée, non bloquante) ;
- **traçage par projet** via le gestionnaire central d'artefacts (`content_id = project`), en exploitant la fusion polymorphe déjà livrée ;
- **liste des pièces d'un projet visible** (MCP + panneau).

## 2. Contexte & raison d'être

- La recette `RECT-muaz100k-2iq0` a acté que les pièces client sont la **matière première des sprints** : l'agent de session sprint en extrait fonctionnalités et règles métier (modèle SQL livré en tâche 1/9, commit `3ee7755`).
- **ADR-001** (`doc-mub10mo8-lgo3`, statut **Proposé**, globale aux 3 repos) décide : *« PIÈCES CLIENT : natures admises markdown/pdf/docx/lien Drive (mis en PUBLIC dans un premier temps — accès agent via l'URL) ; photo et vidéo REFUSÉES ; les documents ADR-12 existants sont CONSERVÉS et requalifiés pièces client (source, plus référence normative exclusive) ; une pièce reçue après l'init du sprint est émergente. »* Ce plan implémente ce point 4 de l'ADR — aucune contradiction avec une ADR **Accepté** (aucune n'existe encore sur ce périmètre).
- La **fusion polymorphe** `artifacts` (couple `doc_type` / `content_id`) est déjà livrée (`T-20260920-162801-jxtr`). Les pièces client doivent l'exploiter, **sans** créer un second modèle et **sans** casser la famille ADR (`doc_type='adr'`) ni la famille docs ADR-12.
- La tâche dépend de `T-20260921-091728-nviw` (tables `sprints` / `sprint_pieces` déjà en base) : l'émergence s'appuie sur la table `sprints` livrée, sans attendre les outils sprint (non livrés à ce stade).

### Décisions de conception (à respecter par l'exécution)

1. **Une pièce client = un artefact** `doc_type='piece'`, `content_id = projectId`, `kind='autre'`, `source ∈ {import, ref, registry}`, métadonnées dans `meta` (JSONB) : `piece_nature`, `url`, `filename`, `emergent`, `emergent_origin`, `sprint_id`, `security_note`.
2. **Requalification sans perte** : les docs ADR-12 **gardent** leur `doc_type` (`adr`/`specs`/`gherkin`/`project_doc`), leur `content_id`, leur `path` et leurs liens `artifact_projects`/`artifact_repos` ; ils reçoivent **uniquement** un marqueur dans `meta` (`piece_client=true`, `piece_nature`, `requalified_at`, `requalified_from_doc_type`). **Aucune suppression**, **aucun changement de `doc_type`** (rétrocompat `doc_list`/`doc_get`/`adr_list` préservée).
3. **Émergence** : à l'ajout d'une pièce, si le projet possède **un sprint** (`sprints.project = projectId`) → `emergent=1` (`apres_init_sprint` si `status='open'`, `apres_cloture` si dernier sprint `close`), `sprint_id` renseigné et lien `sprint_pieces` inséré ; sinon `emergent=0`. Marquage **non bloquant** (aucune exception levée).
4. **Garde natures** : la garde est **autoritative côté MCP** (`db.mjs`) et **dupliquée côté panneau** (défense en profondeur avant écriture fichier). Extensions photo refusées : `.jpg/.jpeg/.png/.gif/.webp/.heic/.bmp/.tiff` ; vidéo refusées : `.mp4/.mov/.avi/.mkv/.webm/.m4v` ; hôtes vidéo connus refusés pour les liens (YouTube, Vimeo, Dailymotion…).

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | modifier | constante `DOC_TYPES` (l.1816) + ajout `PIECE_DOC_TYPES`, `PIECE_NATURES`, `PIECE_NATURE_BY_EXT`, `PIECE_REFUSED_EXT`, `PIECE_REFUSED_HOSTS` | `db.mjs` | `db.mjs` | Formaliser la famille `piece` et les natures admises/refusées | `piece` accepté par la taxonomie ; constantes exportées |
| A002 | créer | fonction `assertPieceAllowed({nature, path, url, filename})` | `db.mjs` (près de `addArtifact` l.1335) | `db.mjs` | Garde qui refuse photo/vidéo à l'import ET pour les liens externes | Fonction exportée, erreurs explicites |
| A003 | créer | fonction `detectOpenSprint(projectId)` | `db.mjs` (après `migrate()`) | `db.mjs` | Détecter l'initialisation d'un sprint (table `sprints`, commit `3ee7755`) | `{sprintId, status}` ou `null` |
| A004 | créer | fonction `addPiece({projectId, nature, title, path, url, filename, description, createdBy})` | `db.mjs` | `db.mjs` | Créer la pièce (traçage `content_id=project`) + marquer l'émergence | Artefact `doc_type='piece'` + lien `artifact_projects` + `sprint_pieces` si sprint |
| A005 | créer | fonction `listPieces({projectId, nature, emergent, includeRequalified})` | `db.mjs` | `db.mjs` | Lister les pièces d'un projet (nouvelles + docs requalifiés) | Liste unifiée avec `nature`, `emergent`, `requalified` |
| A006 | créer | fonction `requalifyDocsAsPieces({projectId})` | `db.mjs` | `db.mjs` | Requalifier sans perte les docs ADR-12 en pièces client | Marqueur `meta.piece_client` (idempotent), rapport `{count}` |
| A007 | créer | tool `piece_add` | `index.mjs` (bloc `doc_*`, après l.513) | `index.mjs` | Exposer l'ajout de pièce (garde incluse) | Tool MCP enregistré |
| A008 | créer | tool `piece_list` | `index.mjs` | `index.mjs` | Exposer la liste des pièces d'un projet | Tool MCP enregistré |
| A009 | créer | tool `piece_requalify` | `index.mjs` | `index.mjs` | Exposer la requalification (relançable) | Tool MCP enregistré |
| A010 | créer | script CLI `requalify-pieces-client.mjs` | — | `/root/.config/opencode/scripts/requalify-pieces-client.mjs` | Exécution opérationnelle unique de la requalification | Script exécutable appelant `requalifyDocsAsPieces` |
| A011 | créer | wrappers `listPieces` / `addPiece` / `requalifyPieces` | `pilot.mjs` (après `listDocs` l.539) | `pilot.mjs` | Pont panneau → MCP (source de vérité unique) | 3 fonctions exportées |
| A012 | créer | routes `GET /api/pieces`, `POST /api/pieces`, `DELETE /api/pieces/:id`, `GET /api/pieces/file` | `server.mjs` (après le bloc `/api/docs`, l.1721) | `server.mjs` | API du panneau pour lister/ajouter/servir les pièces | Routes HTTP + `"piece"` dans `DOC_TYPES` local (l.447) |
| A013 | créer | garde d'import pièce + dossier `storage/pieces` | `server.mjs` (route `POST /api/pieces`) | `server.mjs` | Refuser photo/vidéo AVANT écriture du fichier | HTTP 400 explicite, aucune écriture disque |
| A014 | créer | onglet « Pièces client » : `piecesTabHtml` + entrée `tabs` (l.3937-3941) + wiring (l.4064) | `public/app.js` | `public/app.js` | Rendre la liste des pièces visible dans le panneau | Onglet listant nature/émergence/URL Drive + avertissement sécurité |
| A015 | modifier | tableau de taxonomie (l.36-51) + tableau `ON DELETE` (l.86-92) | `public/docs/nomenclature-doc-type.md` | `public/docs/nomenclature-doc-type.md` | Documenter `piece` et la famille pièce | Nomenclature à jour |
| A016 | créer | document `14-pieces-client.md` | — | `public/docs/14-pieces-client.md` | Documenter natures, garde et **limite de sécurité du lien Drive public** | Doc de référence pièces client |

## 4. Fichiers concernés

| Fichier | Repo | Type de modification |
|---------|------|----------------------|
| `db.mjs` | `opencode-mcp-task-orchestrator` | modification (constantes + 5 fonctions) |
| `index.mjs` | `opencode-mcp-task-orchestrator` | modification (3 tools) |
| `requalify-pieces-client.mjs` | `opencode-scripts` | création |
| `pilot.mjs` | `opencode-observability` | modification (3 wrappers) |
| `server.mjs` | `opencode-observability` | modification (`DOC_TYPES` + routes + garde) |
| `public/app.js` | `opencode-observability` | modification (onglet Pièces client) |
| `public/docs/nomenclature-doc-type.md` | `opencode-observability` | modification |
| `public/docs/14-pieces-client.md` | `opencode-observability` | création |

> **Branches** : une branche de travail dédiée par repo (créée via session-guard) ; ne jamais committer sur `feature/migration-postgresql` (MCP/panneau) ni `main` (scripts) directement.
> **Aucun changement de schéma** : la table polymorphe `artifacts` (colonne `meta JSONB`) et la table `sprints` existent déjà. `schema.sql` n'est pas touché.

## 5. Livrables attendus

1. Taxonomie `doc_type` étendue à `piece` (MCP + panneau) et constantes de natures/garde (`db.mjs`).
2. Garde `assertPieceAllowed` refusant photo/vidéo à l'import et pour les liens externes (`db.mjs`, dupliquée dans `server.mjs`).
3. `addPiece` : pièce `doc_type='piece'`, `content_id=projectId`, tracée via `artifact_projects`, `meta` complet (nature, url, filename, emergent, emergent_origin, sprint_id, security_note).
4. `detectOpenSprint` : émergence calculée depuis la table `sprints` (open → `apres_init_sprint`, close → `apres_cloture`), lien `sprint_pieces` posé, **non bloquant**.
5. `listPieces` : liste unifiée pièces nouvelles + docs ADR-12 requalifiés (`requalified=true`).
6. `requalifyDocsAsPieces` : requalification **idempotente et sans perte** (marqueur `meta` uniquement) + script CLI `requalify-pieces-client.mjs`.
7. Tools MCP `piece_add`, `piece_list`, `piece_requalify`.
8. API panneau `/api/pieces` (GET/POST/DELETE/file) + onglet « Pièces client » listant nature, émergence et URL Drive avec avertissement de sécurité.
9. Documentation : `nomenclature-doc-type.md` à jour + `14-pieces-client.md` (limite de sécurité du lien public).

## 6. Ordre & dépendances

```
A001 ─┬─ A002 ─┐
      │        ├─ A004 ── A005 ── A006 ─┬─ A007 ── A008 ── A009
A003 ─┘        │                        └─ A010
               └─────────────────────────────────────────────
A006 ── A011 ── A012 ── A013 ── A014
A001 ── A015 ── A016
```

- **Prérequis bloquants** : A001 avant A002/A004/A005/A015 ; A002 et A003 avant A004 ; A004 avant A005 ; A005 avant A006 (la liste doit déjà lire le marqueur) ; A006 avant A009/A010/A011.
- **Séquence panneau** : A011 → A012 → A013 → A014 (le pont MCP doit précéder l'API, l'API doit précéder l'UI).
- **Indépendants** : A015/A016 (documentation) peuvent être menés en parallèle du reste après A001.
- **Dépendance externe** : table `sprints` livrée par `T-20260921-091728-nviw` (commit `3ee7755`) — disponible, pas de blocage.

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------|----------|-----------|
| Pièces listées/taggées par nature (md/pdf/docx/lien Drive) | A001, A004, A005, A008, A012, A014 | OUI |
| Garde refuse photo/vidéo à l'ajout (import) | A002, A004, A013 | OUI |
| Garde refuse photo/vidéo pour les liens externes | A002, A004 | OUI |
| Lien Drive ajouté comme URL publique (lecture agent via URL) | A004, A012, A014 | OUI |
| Limite de sécurité du lien public documentée | A016 (aussi `security_note` en A004, doc A015) | OUI |
| Requalification SANS PERTE des docs ADR-12 (chemins, projets/repos, nature conservés) | A006, A009, A010, A015 | OUI |
| Docs ADR-12 NON supprimés / modèle ADR non cassé | A006 (UPDATE `meta` seul), A015 | OUI |
| Pièce après init sprint → marqueur émergent + origine, non bloquant | A003, A004, A014 | OUI |
| Traçage par projet via artefacts (`content_id = project`) | A004, A005, A012 | OUI |
| Liste des pièces d'un projet visible MCP | A008 | OUI |
| Liste des pièces d'un projet visible panneau | A011, A012, A014 | OUI |

## 8. Vérification de cohérence

- **Contradictions intra-plan** : aucune. Aucune étape `supprimer` ; A006 **modifie uniquement `meta`** (jamais `doc_type`/`content_id`/`path`), donc aucune incompatibilité avec `doc_update`/`adr_set_status` ni avec la lecture `listDocs`/`listPieces`. A001 **ajoute** une valeur à `DOC_TYPES` sans retirer les existantes.
- **Ordre** : A005 lit le marqueur `meta.piece_client` écrit par A006 → A005 précède A006 mais lit déjà la clé (présence nulle au départ = liste pièces neuves) ; l'ordre `A005 → A006` garantit qu'aucune étape ne lit un élément créé ultérieurement.
- **Éléments uniques** : chaque étape cible un élément distinct (constante, fonction, tool, route, onglet, doc) dans un fichier précis.
- **Gate** : plan **Valide** (couverture 100 %, aucune contradiction, étapes atomiques).

## 9. Risques & notes

- **Périmètre** : le champ `scope` de la tâche liste `db.mjs`, `index.mjs` et `/root/.config/opencode/scripts`. Le critère d'acceptation **« visible (MCP + panneau) »** impose de toucher le repo `opencode-observability` (`pilot.mjs`, `server.mjs`, `public/app.js`, docs). Ce repo figure dans les `repos` de la tâche ; l'écart de `scope` est **assumé et signalé** (aucun conflit de fichier détecté avec les tâches actives).
- **Table `sprints` sans outils dédiés** : à ce stade, aucun tool MCP sprint n'existe (livré : DDL seul). `detectOpenSprint` lit la table directement — **hypothèse** : « sprint initialisé » = existence d'un sprint du projet ; à confirmer lors de la tâche « session sprint ».
- **`meta` JSONB** : utiliser `COALESCE(meta,'{}'::jsonb) || ...` pour la requalification (certains artefacts peuvent avoir `meta = NULL`).
- **Lien Drive public** : par construction, toute personne disposant de l'URL accède au contenu — **risque de sécurité assumé** dans un premier temps (ADR-001), documenté en A016 ; un mécanisme plus strict est prévu ultérieurement.
- **E2E Playwright** : **NA** — aucun `playwright.config.*` ni spec E2E dans les 3 repos ; le comportement est interne (MCP + panneau), non observable par un parcours Playwright. Aucun test E2E à enregistrer/lier. Vérification par appels MCP (`piece_add` refus photo/vidéo, `piece_list`, `piece_requalify`) et par l'onglet panneau.
- **Compat rétro** : ne pas modifier les signatures de `doc_*`/`artifact_*`/`adr_*` ; la nouvelle famille `piece` est additive.
