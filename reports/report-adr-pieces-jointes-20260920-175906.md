# Rapport — ADR : rattacher 0..N documents/fichiers (pièces jointes & annexes)

- **Tâche** : `T-20260920-162755-3qxj`
- **executionId** : `E-T-20260920-162755-3qxj-6vv3ke`
- **Plan** : `Plan-adr-pieces-jointes-20260920-173615` (19 étapes A001–A019 — **100 % done**)
- **Projet** : `ecosystem`
- **Agent** : `build-notify`
- **Date** : 2026-09-20 17:59
- **Recette source** : `RECT-mu9yzd23-8l7t` (item 122)

## 1. Résumé

**Demandé** : permettre à une ADR (`docs.kind='adr-tech'`) d'être rattachée à **0..N pièces jointes** (documents du registre et/ou fichiers), côté registre MCP (persistance + exposition + tools) et côté panneau (ajout / retrait / téléchargement depuis l'onglet ADR + colonne « Pièces jointes » opérationnelle).

**Fait** : les 19 étapes du plan ont été implémentées et vérifiées. Une **table de liaison dédiée `doc_attachments`** a été créée (source stable `attachment_id`, 3 natures `registry`/`import`/`ref`, colonnes préfigurant la table polymorphe `artifacts` de T8 : `doc_type='adr_file'`, `content_id=adrId`). Le registre expose `attachments` (0..N) via `doc_get`/`doc_list` + 3 tools dédiés. Le panneau offre l'ajout (import / référence de chemin / document du registre), le retrait (avec nettoyage du fichier importé) et le téléchargement, et la colonne « Pièces jointes » est opérationnelle (badge de source, lien, retrait, bouton « + Joindre », cas 0 → « — »).

## 2. Isolation

- **Workspace Coder** : non applicable — les deux repos sont des composants d'**infrastructure hôte** (`workspace=null`, cf. cadre de la tâche). Aucun workspace Coder ne les héberge → travail sur l'hôte assumé et documenté.
- **session-guard** : `acquire` exécuté sur les deux repos (`/root/.config/opencode/mcp/task-orchestrator` et `/root/orchestrator-panel`) → **mode in-place** (aucune autre session parallèle détectée). Verrous détenus par la session `ses_f400c51d3ffeTWo14xaJKjWKlt`, libérés en fin de traitement.
- **Worktrees dédiés** (créés sous `/tmp/opencode/**` pour ne pas polluer les checkouts, cf. contrainte d'accès) :
  - MCP : `/tmp/opencode/mcp-adr-att` — branche `build-notify/adr-pieces-jointes`
  - Panneau : `/tmp/opencode/panel-adr-att` — branche `build-notify/adr-pieces-jointes`
- **WIP d'une autre tâche préservé** : le checkout `/root/orchestrator-panel` porte un WIP non commité (3 fichiers : `public/app.js`, `public/style.css`, `server.mjs` — visionneuse plein écran d'un document). Il **n'a été ni modifié, ni commité, ni perdu** : tout le travail panneau a été fait dans le worktree isolé (basé sur `HEAD` `62f67c6`, sans le WIP).
- **Non-root / Coder** : non applicable (repos hôte hors Coder).

## 3. Branches et commits

| Repo | Branche de travail | Base | Commit |
|------|--------------------|------|--------|
| `opencode-mcp-task-orchestrator` (`/root/.config/opencode/mcp/task-orchestrator`) | `build-notify/adr-pieces-jointes` | `eec3a4f` | `a2d4f53` — feat(adr): pièces jointes 0..N par ADR (table doc_attachments + tools doc_attachment_add/remove/list) |
| `opencode-observability` (`/root/orchestrator-panel`) | `build-notify/adr-pieces-jointes` | `62f67c6` | `cd092aa` — feat(adr): onglet ADR — pièces jointes (ajout/retrait/téléchargement) |

Traces de commits enregistrées dans le registre (`plan_commit_add`, ids 433 et 434). **Aucun push** effectué (étape déploiement orchestrateur ; `mainBranch` = `feature/migration-postgresql`, non poussé directement).

## 4. Traitements effectués

### 4.1 Registre MCP (`db.mjs`, `schema.sql`, `index.mjs`)

- **A001** `schema.sql` : `CREATE TABLE IF NOT EXISTS doc_attachments` + `idx_doc_attachments_doc` / `idx_doc_attachments_target`, après le bloc `doc_repos`.
- **A002** `db.mjs` `migrate()` : même DDL idempotent (base PostgreSQL existante) — **DDL vérifié identique** à `schema.sql`.
- **A003** `DOC_ATTACHMENT_SOURCES = ["registry","import","ref"]` + `assertAttachmentSource()` + `rowToAttachment()`.
- **A004** `getAttachmentsForDocs()` + `enrichDocs()` expose `attachments: []` (additif, rétrocompat item 120).
- **A005–A007** `addDocAttachment()` (3 sources + validations : porteur existant, source valide, `registry ⇒ targetDocId` existant et `≠ docId`, `import/ref ⇒ path`), `removeDocAttachment()` (ID stable + contrôle d'appartenance), `listDocAttachments()`.
- **A008–A011** imports + tools `doc_attachment_add` / `doc_attachment_remove` / `doc_attachment_list`.

### 4.2 Panneau (`pilot.mjs`, `server.mjs`, `public/app.js`)

- **A012–A013** wrappers `addDocAttachment` / `removeDocAttachment` / `listDocAttachments`.
- **A014** `POST /api/docs/:id/attachments` : import PC (`filename`+`dataBase64`, max 2 Mo → `storage/ref-docs`), `targetDocId` → `registry`, `path` → `ref`, sinon 400.
- **A015** `DELETE /api/docs/:id/attachments/:aid` : retrait + suppression du **fichier physique uniquement si `source==='import'` et sous `storage/ref-docs`** (garde de préfixe `normalize`).
- **A016** `GET /api/docs/:id/attachments/:aid/download` : `Content-Disposition: attachment`, MIME, `createReadStream(...).pipe(res)` + `return`.
- **A017** `adrAttachmentsCell` : lit `d.attachments` (plus `d.meta.attachments`), badge de source (importé/référencé/registre), lien de téléchargement (fichiers) ou `viewRefDoc(targetDocId)` (registre), bouton de retrait, bouton « + Joindre » ; cas 0 → « — » + bouton.
- **A018** `adrAttachmentModal(docId, docs, onSaved)` : 3 modes (import / référence / document du registre) + helper `arrayBufferToBase64` par blocs (> 64 Ko).
- **A019** `wire()` : câblage `data-pd-adr-att-add` / `-del` / `-view`.

## 5. Fichiers modifiés / créés

| Fichier | Modification |
|---------|--------------|
| `/root/.config/opencode/mcp/task-orchestrator/schema.sql` | +27 (table + index) |
| `/root/.config/opencode/mcp/task-orchestrator/db.mjs` | +149 / -3 |
| `/root/.config/opencode/mcp/task-orchestrator/index.mjs` | +53 |
| `/root/orchestrator-panel/pilot.mjs` | +32 |
| `/root/orchestrator-panel/server.mjs` | +86 |
| `/root/orchestrator-panel/public/app.js` | +140 / -13 |
| `/root/.config/opencode/mcp/task-orchestrator/reports/report-adr-pieces-jointes-20260920-175906.md` | rapport (ce fichier) |

Aucune autre modification. **`artifacts` non touchée** (chantier T8) ; `doc_projects`/`doc_repos` intacts.

## 6. Tests / vérifications

| Test | Résultat |
|------|----------|
| `node --check` sur les 6 fichiers | OK |
| **DDL parity** `schema.sql` vs `migrate()` (normalisée) | identique |
| **Table en base** : colonnes + index (`information_schema` / `pg_indexes`) | conformes (13 colonnes, PK + 2 index) |
| **db.mjs** (26 assertions) : 0 PJ par défaut, 3 sources, natures, `doc_type`/`content_id`, ordre, `doc_list`, retrait, 6 validations, cascade | **ALL TESTS PASSED** |
| **pilot + tools MCP bout-en-bout** (11 assertions, panel→MCP→DB) | **ALL PILOT TESTS PASSED** |
| **Probe MCP stdio** `tools/list` | `doc_attachment_add/remove/list` présents (102 tools) |
| **Routes HTTP** (16 assertions sur serveur panneau de test, port 4599) : POST import/référence/registre, 400 sans cible, list, download (contenu + `Content-Disposition`), registry→400, inconnue→404, DELETE + nettoyage fichier, cleanup | **ALL HTTP ROUTE TESTS PASSED** |
| **Nettoyage** : docs de test supprimés, `doc_attachments` = 0 ligne | OK |

Note : le test HTTP a été exécuté sur une **copie de test** (`/tmp/opencode/panel-test`) avec `mcp-client.mjs` pointé vers le worktree MCP et `auth.mjs` stubé (admin fixe) — **aucun fichier de repo modifié pour les tests**. Le serveur panneau de production et le MCP déployé **n'ont pas été relancés**.

## 7. Avertissements / erreurs

- **Bug détecté et corrigé en cours de route** : la route de téléchargement ne faisait pas `return` après `pipe()` → fall-through vers `sendJson` → `ERR_HTTP_HEADERS_SENT` (crash du serveur). Corrigé (`return;`) et couvert par le test HTTP.
- **Zod v4** : `meta` déclaré `z.record(z.string(), z.any())` (forme explicite v4).
- **Frontière de vérification** : les routes panneau appellent le MCP **déployé** (`/root/.config/opencode/mcp/task-orchestrator/index.mjs`) ; tant que le MCP n'est pas rechargé avec le nouveau code (étape déploiement), l'onglet ADR du panneau en production renverra une erreur « tool inconnu » sur les pièces jointes. C'est attendu (déploiement = orchestrateur).
- **Base partagée** : `ensureSchema()` (appelé par les tests) a créé la table `doc_attachments` sur la base PostgreSQL réelle — opération idempotente prévue par A002, sans effet de bord (0 ligne, aucune donnée de test résiduelle).

## 8. Prochaines étapes / recommandations

1. **Review + merge** des branches `build-notify/adr-pieces-jointes` (MCP puis panneau) dans `feature/migration-postgresql`.
2. **Déploiement (orchestrateur)** : recharger le MCP `task-orchestrator` (nouveau `index.mjs`/`db.mjs`) **puis** relancer `pm2 orchestrator-panel` — ordre impératif (le panneau dépend des nouveaux tools).
3. **Vérification manuelle** (le panneau n'a pas de CI, cf. plan §9 note 7) : depuis l'onglet ADR d'un projet — ajouter un fichier importé, un chemin référencé, un document du registre ; retirer ; télécharger ; vérifier une ADR sans pièce jointe → « — ».
4. **Coordination T8 (item 127)** : la migration de `doc_attachments` vers `artifacts` est un mapping 1:1 (`doc_type='adr_file'`, `content_id=adrId`).
5. **Coordination T6 (item 125)** : la famille `adr_*` (`adr_attach`) devra réutiliser la même table `doc_attachments`.

## 9. E2E

**NA** (conforme au plan §10) : `e2e_list(project="ecosystem")` = 0 ; repos sans `e2eRepoDir`/`e2eBaseUrl` ; vérification manuelle après déploiement.
