# Plan — ADR : rattacher 0..N documents/fichiers (pièces jointes & annexes)

- **Plan ID** : `Plan-adr-pieces-jointes-20260920-173615`
- **Tâche** : `T-20260920-162755-3qxj` (executionId `E-T-20260920-162755-3qxj-6vv3ke`)
- **Projet** : `ecosystem` — batch `BATCH-mua15lwb-ifqw` (position 3/8)
- **Repos en périmètre** :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (registre MCP)
  - `opencode-observability` = `/root/orchestrator-panel` (panneau)
- **Recette source** : `RECT-mu9yzd23-8l7t` — item 122
- **Dépendances (livrées, done)** :
  - `T-20260920-162753-hpcj` (item 120) — modèle ADR structuré : colonnes `status/context/decision/consequences/replaced_by/is_global/meta/updated_at` sur `docs`, tools `doc_register`/`doc_update`/`doc_get`/`doc_list`. Plan : `plans/Plan-adr-modele-structure-20260920-163126.md`.
  - `T-20260920-162754-b4cb` (item 121) — onglet ADR du panneau : `adrTabHtml` / `adrFormModal` / `adrAttachmentsCell` (`public/app.js`), `PUT /api/docs/:id` (`server.mjs`), pass-through `pilot.mjs`. Plan : `plans/Plan-onglet-adr-panneau-20260920-165510.md`.
- **Date** : 2026-09-20 17:36:15
- **Fichier plan** : `plans/Plan-adr-pieces-jointes-20260920-173615.md` (enregistré sous `rootPath=/root/.config/opencode/mcp/task-orchestrator`)

## 1. Objectif

Permettre à **une ADR (`docs.kind = 'adr-tech'`) d'être rattachée à 0..N pièces jointes**
(documents du registre et/ou fichiers importés ou référencés par chemin) :
- **côté registre MCP** : persister le lien ADR ↔ pièce jointe et l'exposer dans `doc_get`/`doc_list` (champ `attachments`) + tools dédiés `doc_attachment_add` / `doc_attachment_remove` / `doc_attachment_list` ;
- **côté panneau** : gérer les pièces jointes depuis l'onglet ADR (ajout, retrait, téléchargement) et les afficher dans la colonne « Pièces jointes » (le cas **0 pièce jointe** est admis).

## 2. Contexte & raison d'être

La recette `RECT-mu9yzd23-8l7t` définit la colonne « Pièces jointes » : *« Document ou fichier complémentaire à l'ADR »* (item 122). Aujourd'hui :

- **Registre** : la table `docs` porte les champs ADR structurés (item 120) mais **aucune notion de pièce jointe**. Le seul champ disponible est `docs.meta` (TEXT JSON, documenté « préservable pour la fusion `artifacts` », `db.mjs` l.227 / `schema.sql` l.111) — jamais alimenté.
- **Panneau** : `adrAttachmentsCell(d)` (`public/app.js` l.4049-4060) lit `d.meta.attachments` **ou** `d.attachments` et affiche « — » faute d'alimentation (constat explicite du plan de l'item 121, §9 note 2). Aucune route d'upload/retrait/téléchargement de pièce jointe n'existe : `POST /api/docs` (`server.mjs` l.1632) crée un **document**, pas une pièce jointe ; `GET /api/docs/:id/download` (l.1684) télécharge le **fichier de l'ADR elle-même**, pas une annexe.

### Décision de modélisation (à ancrer)

Une **table de liaison dédiée `doc_attachments`** (et non `docs.meta.attachments`) est retenue, car elle est le seul modèle qui :

1. donne un **identifiant stable** (`attachment_id`) indispensable au **retrait** d'une pièce précise ;
2. **distingue sans ambiguïté** le lien « ADR ↔ pièce jointe » du rattachement **projet/repo** d'un doc (`doc_projects` / `doc_repos` restent intacts) — point de vigilance explicite de l'item 122 ;
3. permet de distinguer nativement les **3 natures** de pièce jointe : **document du registre** (`target_doc_id`), **fichier importé** (`source='import'`, stocké sous `storage/ref-docs`), **fichier référencé par chemin** (`source='ref'`, workspace/checkout) ;
4. **préfigure la table polymorphe `artifacts` de l'item 127 (T8)** : la ligne porte dès maintenant les colonnes cibles `doc_type` (`'adr_file'`), `content_id` (`= adrId`), `kind`, `nature`, `source`, `meta` — la migration de T8 sera un **mapping 1:1** de `doc_attachments` vers `artifacts`, sans perte ni retraitement.

**Hors périmètre (garde-fou)** : aucune modification de la table `artifacts` ni de son `task_id NOT NULL` (c'est le chantier de T8 / item 127, ordre 8) ; aucune famille de tools `adr_*` (item 125, ordre 6) ; la famille `doc_*` reste le canal de rétrocompatibilité.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter | `CREATE TABLE IF NOT EXISTS doc_attachments` (colonnes `attachment_id`, `doc_id` FK `docs` CASCADE, `doc_type` DEFAULT `'adr_file'`, `content_id`, `kind`, `nature`, `title`, `path`, `target_doc_id` FK `docs` CASCADE, `source`, `meta`, `created_at`, `created_by`) + `idx_doc_attachments_doc` / `idx_doc_attachments_target`, **après** le bloc `doc_repos` (l.129-134) | `schema.sql` | `schema.sql` | `schema.sql` = source de vérité logique chargée AVANT `migrate()` ; table dédiée (pas `meta`) pour ID stable + natures + mapping 1:1 vers `artifacts` (T8) | `schema.sql` porte le modèle des pièces jointes d'ADR |
| A002 | Ajouter | Le **même** `CREATE TABLE IF NOT EXISTS doc_attachments` + index dans `migrate()` (après le bloc `doc_repos`, l.251-256) | `db.mjs` | `db.mjs` | Bases PostgreSQL **existantes** (branche `feature/migration-postgresql`) : créer la table sans perte, de façon idempotente | `migrate()` crée `doc_attachments` sur une base déjà migrée |
| A003 | Ajouter | Constante `export const DOC_ATTACHMENT_SOURCES = ["registry","import","ref"]` + `assertAttachmentSource(source)` + `rowToAttachment(r)` (sérialisation camelCase, `meta` via `parseDocMeta`), près de `ADR_STATUS` (l.1478) / `parseDocMeta` (l.1491) | `db.mjs` | `db.mjs` | Référentiel unique des sources + sérialisation réutilisée par les 3 fonctions et les tools | `DOC_ATTACHMENT_SOURCES` exporté, `rowToAttachment` disponible |
| A004 | Modifier | `enrichDocs()` (l.1555-1559) : ajouter un 3ᵉ enrichissement `attachments` via la nouvelle `getAttachmentsForDocs(rows)` (modèle de `getReposForDocs`, l.1543-1552) | `db.mjs` | `db.mjs` | `enrichDocs` alimente `getDoc`/`listDocs`/`docsForProjectContext` → `doc_get` et `doc_list` exposent les pièces jointes **sans autre modif** | Chaque doc expose `attachments: []` (0 pièce jointe par défaut) |
| A005 | Ajouter | `addDocAttachment({ docId, targetDocId, path, title, kind, nature, source, meta, createdBy })` (près de `registerDoc`/`updateDoc`) : valide le doc porteur, `source ∈ DOC_ATTACHMENT_SOURCES`, `registry ⇒ targetDocId` existant et `≠ docId`, `import/ref ⇒ path` non vide ; INSERT (`attachment_id = att-<ts>-<rand>`, `doc_type='adr_file'`, `content_id=docId`) ; retourne `getDoc(docId)` | `db.mjs` | `db.mjs` | Persister le lien ADR ↔ pièce jointe avec ses 3 natures et la cohérence des champs | `doc_attachment_add` enregistre une pièce jointe valide |
| A006 | Ajouter | `removeDocAttachment({ attachmentId, docId })` : vérifie l'appartenance si `docId` fourni, `DELETE FROM doc_attachments WHERE attachment_id = $1`, retourne `{ attachmentId, deleted: true }` (ou `null`) | `db.mjs` | `db.mjs` | Retrait d'une pièce jointe (ID stable) sans toucher au fichier ni aux rattachements projet/repo | `doc_attachment_remove` supprime le lien |
| A007 | Ajouter | `listDocAttachments({ docId })` : `SELECT * FROM doc_attachments WHERE doc_id = $1 ORDER BY created_at` → `rowToAttachment` | `db.mjs` | `db.mjs` | Lecture dédiée de la famille (symétrie `artifact_list`, usage agents) | `doc_attachment_list` retourne les pièces jointes d'une ADR |
| A008 | Modifier | Bloc d'imports depuis `./db.mjs` (l.105-112) : ajouter `addDocAttachment`, `removeDocAttachment`, `listDocAttachments`, `DOC_ATTACHMENT_SOURCES` | `index.mjs` | `index.mjs` | Rendre les fonctions/tools disponibles au serveur MCP | Fonctions de pièces jointes importées dans `index.mjs` |
| A009 | Ajouter | Tool `doc_attachment_add` (après `doc_list`, l.442) : `inputSchema { docId, targetDocId?, path?, title?, kind?, nature?, source?, meta? }` + handler → `addDocAttachment` | `index.mjs` | `index.mjs` | Exposer l'ajout de pièce jointe (document du registre, fichier importé ou chemin) | `doc_attachment_add` opérationnel |
| A010 | Ajouter | Tool `doc_attachment_remove` : `inputSchema { docId?, attachmentId }` + handler → `removeDocAttachment` (`err` si inconnu) | `index.mjs` | `index.mjs` | Exposer le retrait d'une pièce jointe | `doc_attachment_remove` opérationnel |
| A011 | Ajouter | Tool `doc_attachment_list` : `inputSchema { docId }` + handler → `{ count, attachments }` | `index.mjs` | `index.mjs` | Lecture explicite de la famille (doc_get expose déjà `attachments`) | `doc_attachment_list` opérationnel |
| A012 | Modifier | `pilot.mjs` : ajouter `addDocAttachment(args)` → `taskOrchestrator("doc_attachment_add", { docId, targetDocId, path, title, kind, nature, source, meta })` (près de `docGet`, l.587-591) | `pilot.mjs` | `pilot.mjs` | Le panneau doit appeler le registre via le wrapper (comme `docGet`/`registerDoc`) | Wrapper `addDocAttachment` disponible |
| A013 | Modifier | `pilot.mjs` : ajouter `removeDocAttachment(args)` → `taskOrchestrator("doc_attachment_remove", { docId, attachmentId })` | `pilot.mjs` | `pilot.mjs` | Wrapper du retrait pour les routes du panneau | Wrapper `removeDocAttachment` disponible |
| A014 | Ajouter | Route `POST /api/docs/:id/attachments` (après `PUT /api/docs/:id`, l.1658-1662) : `filename && dataBase64` → écrit sous `storage/ref-docs` (max 2 Mo, nom assaini) puis `pilot.addDocAttachment({ docId, path: dest, source:'import', … })` ; `targetDocId` → `source:'registry'` ; `path` → `source:'ref'` ; sinon 400 | `server.mjs` | `server.mjs` | Ajout d'une pièce jointe depuis l'onglet (import PC OU référence OU doc du registre) | `POST /api/docs/:id/attachments` opérationnel |
| A015 | Ajouter | Route `DELETE /api/docs/:id/attachments/:attachmentId` : résout la pièce via `pilot.docGet(id).attachments`, `pilot.removeDocAttachment({ docId, attachmentId })`, puis supprime le **fichier physique** uniquement si `source === 'import'` et `path` sous `storage/ref-docs` (garde de préfixe `normalize`) | `server.mjs` | `server.mjs` | Retrait depuis l'onglet + nettoyage du fichier importé (jamais de suppression hors storage) | `DELETE /api/docs/:id/attachments/:aid` opérationnel |
| A016 | Ajouter | Route `GET /api/docs/:id/attachments/:attachmentId/download` : résout la pièce via `pilot.docGet(id).attachments`, `404` si inconnue, garde `existsSync`/`isDirectory`, `Content-Disposition: attachment` (`MIME[ext]` comme l.1694), `createReadStream(abs).pipe(res)` | `server.mjs` | `server.mjs` | Téléchargement d'une pièce jointe (fichier importé **ou** référencé) | `GET /api/docs/:id/attachments/:aid/download` opérationnel |
| A017 | Modifier | `adrAttachmentsCell(d)` (l.4049-4060) : lire `d.attachments` (tableau) en priorité (ne plus dépendre de `d.meta.attachments`) ; par pièce : libellé + badge de source (`importé`/`référencé`/`registre`) + lien de téléchargement `/api/docs/<docId>/attachments/<attachmentId>/download` (fichiers) ou `viewRefDoc(targetDocId)` (doc du registre) + bouton retrait `data-pd-adr-att-del` ; bouton `+ Joindre` `data-pd-adr-att-add="<docId>"` ; cas 0 → « — » + bouton | `public/app.js` | `public/app.js` | Remplir et rendre opérationnelle la colonne « Pièces jointes » (ajout/retrait/téléchargement) | Colonne « Pièces jointes » fonctionnelle (0..N) |
| A018 | Ajouter | `adrAttachmentModal(docId, docs, onSaved)` (top-level, près de `adrFormModal` l.4157) : 3 modes — import fichier (base64, max 2 Mo) / référence de chemin / document du registre (`<select>` des `docs` du projet) ; `POST /api/docs/<docId>/attachments` ; `onSaved` | `public/app.js` | `public/app.js` | Interface d'ajout d'une pièce jointe depuis l'onglet ADR | Modale d'ajout de pièce jointe |
| A019 | Modifier | `wire()` (l.3939-3956) : brancher `[data-pd-adr-att-add]` → `adrAttachmentModal(d.docId, allDocs, reload)` et `[data-pd-adr-att-del]` → confirm + `DELETE /api/docs/<docId>/attachments/<aid>` + `loadDocs()` + `render()` | `public/app.js` | `public/app.js` | Câbler les actions d'ajout/retrait de pièces jointes de l'onglet | Actions de pièces jointes câblées dans l'onglet ADR |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | Modification — table `doc_attachments` + index (A001) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | Modification — `migrate()` (A002), `DOC_ATTACHMENT_SOURCES`/`rowToAttachment` (A003), `enrichDocs` (A004), `addDocAttachment` (A005), `removeDocAttachment` (A006), `listDocAttachments` (A007) |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | Modification — imports (A008), tools `doc_attachment_add`/`doc_attachment_remove`/`doc_attachment_list` (A009-A011) |
| `/root/orchestrator-panel/pilot.mjs` | Modification — `addDocAttachment` (A012), `removeDocAttachment` (A013) |
| `/root/orchestrator-panel/server.mjs` | Modification — routes `POST/DELETE /api/docs/:id/attachments[/:aid]` (A014, A015), `GET …/download` (A016) |
| `/root/orchestrator-panel/public/app.js` | Modification — `adrAttachmentsCell` (A017), `adrAttachmentModal` (A018), `wire` (A019) |

Aucune création de fichier de code. **Aucune** modification de la table `artifacts` (T8 / item 127), ni de `doc_projects`/`doc_repos` (rattachement projet/repo laissé intact).

## 5. Livrables attendus

1. `schema.sql` : table `doc_attachments` + index, préfigurant `artifacts(doc_type='adr_file', content_id=adrId)` (A001).
2. `db.mjs` : `migrate()` crée `doc_attachments` sur base existante (A002).
3. `db.mjs` : `DOC_ATTACHMENT_SOURCES` + `rowToAttachment` (A003).
4. `db.mjs` : `enrichDocs` expose `attachments` → `doc_get`/`doc_list` retournent 0..N pièces jointes par ADR (A004).
5. `db.mjs` : `addDocAttachment` (3 natures + validations) / `removeDocAttachment` / `listDocAttachments` (A005-A007).
6. `index.mjs` : tools `doc_attachment_add` / `doc_attachment_remove` / `doc_attachment_list` (A008-A011).
7. `pilot.mjs` : wrappers `addDocAttachment` / `removeDocAttachment` (A012-A013).
8. `server.mjs` : routes d'ajout (import/référence/registre), de retrait (avec nettoyage du fichier importé) et de téléchargement (A014-A016).
9. `public/app.js` : colonne « Pièces jointes » opérationnelle (0..N) + modale d'ajout + wiring (A017-A019).
10. Comportement : ajouter/retirer/télécharger une pièce jointe depuis l'onglet ADR ; le cas « 0 pièce jointe » affiche « — » ; un doc du registre, un fichier importé (`storage/ref-docs`) et un fichier référencé par chemin sont distingués.

## 6. Ordre & dépendances

```
A001 ─┬─► A005 ─┬─► A009 ─┐
A002 ─┘         │         │
A003 ───────────┘         ├─► A012 ─► A014 ─┐
A004 ─► A007 ─► A011      │                 ├─► A017 ─┐
A006 ─► A010 ─────────────┘                 │         ├─► A019
                          A013 ─► A015 ─────┘  A018 ──┘
                          A016 ────────────────────────► A017
```

- **A001** (`schema.sql`) et **A002** (`migrate()`) : **prérequis** de toute écriture ; complémentaires (source logique vs base existante), DDL identique.
- **A003** (`DOC_ATTACHMENT_SOURCES` + `rowToAttachment`) précède A004-A007.
- **A004** (`enrichDocs`) précède A011 et le téléchargement A016 (qui résout la pièce via `docGet().attachments`).
- **A005 → A009 → A012 → A014** (chaîne d'ajout) ; **A006 → A010 → A013 → A015** (chaîne de retrait) ; A005 et A006 sont indépendants entre eux.
- **A008** (imports) précède **A009, A010, A011** (tools).
- **A017** dépend de A004 (données), A016 (lien de téléchargement) et A009/A010 (boutons) ; **A018** dépend de A014 ; **A019** dépend de A017 et A018 (les éléments ciblés doivent exister).

## 7. Couverture des objectifs

| Exigence (item 122 / critère d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------------------|----------|-----------|
| Une ADR expose sa **liste de pièces jointes** | A001, A002, A003, A004 (`attachments`), A011 | ✅ |
| Pièce jointe = **document du registre** | A001 (`target_doc_id`), A003, A005 (`source='registry'`), A014, A018 (select des docs) | ✅ |
| Pièce jointe = **fichier importé** (`storage/ref-docs`) | A001 (`source`), A005, A014 (écriture `storage/ref-docs`), A017 (badge « importé ») | ✅ |
| Pièce jointe = **fichier référencé par chemin** (workspace/checkout) | A001 (`source='ref'`), A005, A014, A017 (badge « référencé ») | ✅ |
| **Ajout** possible depuis l'onglet ADR | A009, A012, A014, A017 (bouton), A018, A019 | ✅ |
| **Retrait** possible depuis l'onglet ADR | A006, A010, A013, A015, A017, A019 | ✅ |
| **Téléchargement** d'une pièce jointe | A016, A017 | ✅ |
| La colonne « Pièces jointes » les **affiche** | A004, A017 | ✅ |
| Cas **« 0 pièce jointe » admis** | A004 (`attachments: []` par défaut), A017 (« — ») | ✅ |
| **Distinguer** importés / référencés par chemin | A001, A003, A005, A014, A017 | ✅ |
| Le lien **ADR ↔ document** n'est pas confondu avec le **rattachement projet/repo** d'un doc | A001 (table `doc_attachments` distincte de `doc_projects`/`doc_repos`), A005 (validations) | ✅ |
| **Alignement T8 (item 127)** : prévoir `doc_type='adr_file'` / `content_id=adrId` | A001 (`doc_type`, `content_id`, `kind`, `nature`, `source`, `meta`) | ✅ (mapping 1:1 prêt pour la migration T8) |
| Rétrocompat `doc_get`/`doc_list` (item 120) | A004 (champ **additif** `attachments`), A008-A011 (nouveaux tools) | ✅ |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** — regroupement par élément cible :

- `schema.sql` / `doc_attachments` : A001 unique (création) — pas de contradiction.
- `db.mjs` / `doc_attachments` (DDL) : A002 unique ; **DDL identique** à A001 (même table, deux points d'entrée : base neuve / base existante) — complémentaires, pas redondants (schéma `docs` item 120 suit déjà ce pattern A001/A002).
- `db.mjs` / `enrichDocs` : A004 unique (ajout d'un enrichissement) ; n'altère ni `rowToDoc`, ni les requêtes `doc_projects`/`doc_repos` — rétrocompat préservée.
- `db.mjs` / `addDocAttachment` (A005), `removeDocAttachment` (A006), `listDocAttachments` (A007) : **trois fonctions distinctes**, pas de recouvrement.
- `index.mjs` / tools : A009 (`add`), A010 (`remove`), A011 (`list`) — trois tools distincts ; A008 (imports) est un prérequis, pas un conflit.
- `server.mjs` / `docs` : A014 (`POST …/attachments`), A015 (`DELETE …/attachments/:aid`), A016 (`GET …/download`) — **méthodes et motifs distincts** des routes existantes (`POST/GET /api/docs`, `PUT/DELETE /api/docs/:id`, `/content`, `/download`) ; aucun recouvrement.
- `public/app.js` / `adrAttachmentsCell` : A017 unique (remplacement de l'implémentation de lecture) ; A018 est une **nouvelle fonction top-level** ; A019 touche la closure `wire()` (l.3939-3956) — région **disjointe** de A017/A018. Aucune contradiction (`supprimer` + autre action, `déplacer` + `supprimer`, lecture d'un élément créé plus tard) : les dépendances de lecture (A017 lit `d.attachments` produit par A004 ; A019 câble les boutons rendus par A017 et la modale A018) sont **ordonnées correctement** (§6).
- Aucune étape vague : chaque action cible un élément nommé (table, fonction, tool, route, helper) dans un fichier identifié, avec un verbe précis.

**Résultat Plan Validator : `Valid`.**

**Cohérence globale (Phase 9)** — recoupement avec les autres tâches du batch :

- **T4 / item 123** (`T-20260920-162756-m30s`, ordre 4) aligne `schema.sql` sur les tables créées par `db.mjs` : il **ajoutera** d'autres tables en `CREATE TABLE IF NOT EXISTS`. A001 (nous) et T4 touchent tous deux `schema.sql` mais sur des tables **différentes** ; l'idempotence garantit l'absence de divergence **à condition** que la définition de `doc_attachments` soit identique en A001 (`schema.sql`) et A002 (`db.mjs`). **Point de coordination signalé** (pas de contradiction).
- **T8 / item 127** (`T-20260920-162801-jxtr`, ordre 8) fusionne `artifacts`/`recette_documents`/`docs` en une table polymorphe et migre les pièces jointes en `doc_type='adr_file'` + `content_id=adrId`. Nos colonnes A001 rendent la migration 1:1. **Aucun conflit** : nous ne modifions **pas** `artifacts` (chantier T8) ; T8 supprimera `doc_attachments` après validation de sa migration.
- **T6 / item 125** (`T-20260920-162758-8c12`, ordre 6) crée la famille `adr_*` dont `adr_attach(adrId, repoId?, docId?, path?)` : `adr_attach` devra **réutiliser la même table `doc_attachments`** (canal `doc_*` conservé en rétrocompat) — interface documentée ici, pas de double modèle.
- **T5 / item 124** (`T-20260920-162757-sxi4`, ordre 5) touche `index.mjs` pour le nettoyage d'un repo orphelin : région **disjointe** des tools `doc_attachment_*` (A009-A011).

Aucune incohérence globale bloquante détectée ; aucune escalade utilisateur requise.

## 9. Risques & notes

1. **`meta.attachments` abandonné comme source de vérité.** `adrAttachmentsCell` (item 121) lisait `d.meta.attachments` **en priorité** puis `d.attachments`. A017 bascule la lecture sur `d.attachments` (produit par A004). Aucune donnée n'a jamais été écrite dans `meta.attachments` (constat item 121 : colonne toujours « — ») → **aucune migration de données** nécessaire. `docs.meta` reste disponible pour la fusion T8.
2. **Frontière registre / stockage.** Le registre MCP ne stocke **jamais de contenu** : `doc_attachment_add` reçoit un **chemin** (`path`) ou un **docId** cible. L'écriture du fichier importé sous `/root/orchestrator-panel/storage/ref-docs` reste dans `server.mjs` (A014), comme pour `registerDocUpload` (`pilot.mjs` l.598-608). Limite **2 Mo** alignée sur l'existant.
3. **Suppression de fichier encadrée.** A015 ne supprime le fichier physique que si `source === 'import'` **et** `path` commence par `storage/ref-docs` (garde de préfixe après `normalize`) — jamais de suppression d'un fichier du workspace/checkout.
4. **`ON DELETE CASCADE` sur `doc_id` et `target_doc_id`.** Supprimer une ADR retire ses liens de pièces jointes (les fichiers importés restent sur disque : nettoyage volontairement **hors** registre) ; supprimer un doc du registre cible retire le lien correspondant. Comportement à confirmer lors de la fusion T8 (choix ON DELETE par `doc_type`).
5. **Rétrocompat additive.** A004 n'ajoute qu'un champ `attachments` aux docs retournés ; les consommateurs existants (`docsForProjectContext`, sessions recette/test-agent, `doc_list(includeRepoDocs)`) ne sont pas affectés. Aucun changement du SQL `includeRepoDocs`.
6. **Coût de lecture.** `enrichDocs` exécute une requête batch supplémentaire (`doc_id = ANY($1)`), du même ordre que `getProjectsForDocs`/`getReposForDocs` — impact négligeable.
7. **Vérification manuelle.** Le panneau est relancé directement **sans CI** (vigilance item 121) : vérification manuelle après livraison (ajouter un fichier importé, un chemin, un doc du registre ; retirer ; télécharger ; ADR sans pièce jointe → « — »).
8. **Hors périmètre** : famille `adr_*` (item 125), fusion `artifacts` (item 127), sélection d'ADR en contexte (item 125), gouvernance recette (item 126).

## 10. Tests E2E Playwright — analyse d'impact

**E2E : NA.** `e2e_list(project="ecosystem")` → `count: 0` : aucun test E2E n'est enregistré pour ce projet, et les repos `opencode-mcp-task-orchestrator` / `opencode-observability` n'ont **ni `e2eRepoDir` ni `e2eBaseUrl`**. La tâche porte sur le registre MCP (schéma PostgreSQL + tools) et sur le panneau local relancé **sans CI** (vérification manuelle, cf. §9 note 7). Aucune entité E2E n'est créée ni liée pour cette tâche.
