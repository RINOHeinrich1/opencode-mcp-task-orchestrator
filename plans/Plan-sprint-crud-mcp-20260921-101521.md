# Plan — Famille MCP `sprint_*` (CRUD complet) au-dessus des primitives T3

- **Tâche** : `T-20260921-091732-9jqg` (exécution `E-T-20260921-091732-9jqg-hbobz6`), batch `BATCH-mub1809u-06ow` (4/9)
- **Projet** : `ecosystem` — repo `opencode-mcp-task-orchestrator`
- **Racine** : `/root/.config/opencode/mcp/task-orchestrator` (branche de travail dédiée via session-guard)
- **Date** : 2026-09-21 10:15:21
- **Plan ID** : `Plan-sprint-crud-mcp-20260921-101521`

---

## 1. Objectif

Exposer la **famille MCP `sprint_*` (CRUD)** — `sprint_start`, `sprint_list`, `sprint_get`,
`sprint_close`, `sprint_reopen`, `sprint_attach_pieces` — au-dessus des primitives de cycle de vie
livrées en T3, en **réutilisant** `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`,
`getSprint`, `listProjectSprints`, `buildSprintReport`, `classifyEmergence`, `assertPieceAllowed`,
et en **réutilisant le tool `sprint_report` existant** (ne pas le recréer).

## 2. Contexte & raison d'être

La recette `RECT-muaz100k-2iq0` (élément 131) demande une famille MCP pour piloter les **sessions de
sprint** : création à durée paramétrable, lecture détaillée (pièces, fonctionnalités, règles, statut,
dates), rattachement de pièces client, clôture (auto à l'échéance ou manuelle) et reprise.

Les dépendances sont **TERMINÉES** et fusionnées sur `feature/migration-postgresql` :

- **T1** (`3ee7755`) : modèle SQL `fonctionnalites` / `regles_metier` / `sprints` + liens N:N.
- **T2** (`5444381`) : pièces client `doc_type='piece'`, garde `assertPieceAllowed` (refus photo/vidéo),
  requalification des docs ADR-12.
- **T3** (`8d77d01`) : cycle de vie produit du sprint (`closeSprint`, `autoCloseExpiredSprints`,
  `reopenSprint`, `getSprint`, `listProjectSprints`, `ensureDefaultSprint`, `buildSprintReport`,
  tool `sprint_report`, garde partagée `classifyEmergence`).

Le présent plan **ne réimplémente aucune** de ces primitives : il ajoute la **couche CRUD MCP**
(3 fonctions `db.mjs` + 6 tools `index.mjs`) qui les assemble.

**ADR de référence** : `ADR-001 — Modèle sprint / fonctionnalités / règles métier dans le registre
ecosystem` (`doc-mub10mo8-lgo3`, statut **Proposé**, globale aux 3 repos du projet `ecosystem`).
Points applicables : sprint 1ᵉʳ niveau à **durée paramétrable**, statut `open`→`close`, clôture
**automatique à l'échéance** *distincte* de la clôture d'exécution des tâches, **reprise possible**,
après clôture tout élément est **ÉMERGENT** (tracé, non bloquant), une pièce reçue **après l'init**
du sprint est émergente. ADR-001 étant **Proposé** (non encore Accepté), aucune étape ne doit figer
le modèle au-delà de ce que T1-T3 ont déjà posé ; les ajouts sont **additifs**.

**Frontière explicite** : les familles `feature_*` / `rule_*` et les outils de liaison appartiennent
à **T5** (`T-20260921-091733-rpvh`) — **non implémentés ici**.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | créer | `assertAttachablePiece(pieceId)` — garde nature unique du rattachement (nouvelle fonction, juste après `rowToPiece` l.4985) | `db.mjs` | `db.mjs` | Une pièce rattachable = `doc_type='piece'` **ou** doc requalifié (`meta.piece_client=true`) ; re-vérifier la nature via `assertPieceAllowed({ nature, path, url, filename })` (refus photo/vidéo, nature ∈ `PIECE_NATURES`) | `assertAttachablePiece` exportée ; erreur explicite si artefact inconnu / non-pièce / nature refusée |
| A002 | créer | `attachPiecesToSprint(sprintId, { pieceIds, atInit = false, by } = {})` — lien `sprint_pieces` + émergence (nouvelle fonction, dans le bloc SPRINT après `listProjectSprints` l.740) | `db.mjs` | `db.mjs` | Rattacher des pièces à un sprint avec **garde nature** (A001) et **marquage émergent selon l'état du sprint** (`close`→`apres_cloture`, `open`→`apres_init_sprint`) ; `atInit=true` = rattachement à la création (pièces du sprint, **non** émergentes) | `attachPiecesToSprint` exportée ; `{ sprintId, attached, pieces }` |
| A003 | créer | `createSprint({ projectId, title, startDate, endDate, autoClose = true, sessionId, createdBy, pieces } = {})` (nouvelle fonction, après `ensureDefaultSprint` l.818) | `db.mjs` | `db.mjs` | Création d'un sprint **nominal** à **durée paramétrable** : validation (`projectId` + `assertProjectExists`, `title`, `endDate >= startDate`), statut initial (`open`, ou `close` + `close_reason='auto_echeance'` si échéance passée — logique `ensureDefaultSprint`), `is_default=0`, `organization_id` du projet, puis rattachement des pièces optionnelles via A002 (`atInit=true`) | `createSprint` exportée ; sprint créé avec ses pièces |
| A004 | créer | `getSprintDetail(sprintId)` — lecture détaillée (nouvelle fonction, après `getSprint` l.723) | `db.mjs` | `db.mjs` | Détail `sprint_get` : sprint (statut, dates, cycle de vie) + pièces (`sprint_pieces` JOIN `artifacts` → `rowToPiece`) + fonctionnalités (`sprint_fonctionnalites`) + règles (`sprint_regles`) + tâches (`task_sprints`) + recettes (`recette_sprints`) | `getSprintDetail` exportée ; `{ sprint, pieces, fonctionnalites, regles, tasks, recettes, counts }` |
| A005 | modifier | import `db.mjs` (l.133-138) : ajouter `createSprint`, `getSprintDetail`, `attachPiecesToSprint`, `getSprint`, `listProjectSprints`, `closeSprint`, `autoCloseExpiredSprints`, `reopenSprint`, `classifyEmergence` | `index.mjs` | `index.mjs` | Rendre les primitives disponibles aux tools `sprint_*` (`buildSprintReport` déjà importé, conservé) | Imports complétés |
| A006 | modifier | bloc famille SPRINT (commentaire l.587-591) + ajout du tool `sprint_start` après `sprint_report` (l.605) | `index.mjs` | `index.mjs` | Exposer la **CRÉATION** (projet, titre, **dates début/fin paramétrables**, pièces optionnelles) ; corriger le commentaire « le CRUD `sprint_*` complet appartient à T4 » (désormais livré) | Commentaire à jour + tool `sprint_start` enregistré |
| A007 | ajouter | tool `sprint_list` (après `sprint_start`) | `index.mjs` | `index.mjs` | Lister les sprints d'un projet (statut, dates) en reflétant la **clôture auto** (`autoCloseExpiredSprints({ projectId })` **avant** lecture) via `listProjectSprints` | Tool `sprint_list` enregistré → `{ count, sprints }` |
| A008 | ajouter | tool `sprint_get` (après `sprint_list`) | `index.mjs` | `index.mjs` | Détail d'un sprint (pièces, fonctionnalités, règles, statut, dates) via A004 ; `err` si inconnu | Tool `sprint_get` enregistré |
| A009 | ajouter | tool `sprint_close` (après `sprint_get`) | `index.mjs` | `index.mjs` | Clôture **MANUELLE** (`sprintId` → `closeSprint(sprintId,{reason:'manuel'})`) **ou AUTO à l'échéance** (`projectId`/global → `autoCloseExpiredSprints`) ; retourne le sprint + l'**état d'émergence déclenché** (`classifyEmergence(sprint.project,{kind:'element'})`) | Tool `sprint_close` enregistré → `{ ok, sprints, emergence }` |
| A010 | ajouter | tool `sprint_reopen` (après `sprint_close`) | `index.mjs` | `index.mjs` | **Reprise** d'un sprint clôturé (`reopenSprint`, prolongation `endDate`/`autoClose`) ; retourne le sprint + l'état d'émergence **suspendu** (sprint `open` → éléments non émergents) | Tool `sprint_reopen` enregistré → `{ ok, sprint, emergence }` |
| A011 | ajouter | tool `sprint_attach_pieces` (après `sprint_reopen`) | `index.mjs` | `index.mjs` | Rattacher des pièces client à un sprint (**garde nature** + **marquage émergent si après init**) via A002 | Tool `sprint_attach_pieces` enregistré → `{ ok, sprintId, attached, pieces }` |
| A012 | vérifier | `node --check db.mjs index.mjs` + **spawn réel** du MCP (`tools/list` = 6 tools `sprint_*` + `sprint_report` **réutilisé**) + cycle complet (start → get → attach_pieces → close → emergence → reopen → report) + non-régression (`piece_add`, `task_register`, ADR/`artifacts`) | `db.mjs`, `index.mjs` | — | Garantir l'exposition **sans régression T1-T3** ni ADR/`artifacts`, et l'absence de doublon de `sprint_report` | Rapport de vérification (rejeu idempotent, cycle OK, `sprint_report` unique) |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `db.mjs` | **Modification additive** — `assertAttachablePiece` (A001), `attachPiecesToSprint` (A002), `createSprint` (A003), `getSprintDetail` (A004). **Aucune** modification des primitives T3 (`closeSprint`, `reopenSprint`, `autoCloseExpiredSprints`, `classifyEmergence`, `buildSprintReport`, `getSprint`, `listProjectSprints`, `ensureDefaultSprint`) ni de `addPiece`/`getPiece`. |
| `index.mjs` | **Modification additive** — import (A005), commentaire du bloc SPRINT + tool `sprint_start` (A006), tools `sprint_list` (A007), `sprint_get` (A008), `sprint_close` (A009), `sprint_reopen` (A010), `sprint_attach_pieces` (A011). Le tool `sprint_report` (l.593-605) est **conservé tel quel**. |
| `schema.sql` | **Non modifié** — les tables `sprints` / `sprint_pieces` / `sprint_fonctionnalites` / `sprint_regles` / `task_sprints` / `recette_sprints` et toutes les colonnes nécessaires existent déjà (T1/T3). |

## 5. Livrables attendus

1. **`db.mjs`** : `assertAttachablePiece`, `attachPiecesToSprint`, `createSprint`, `getSprintDetail` exportées.
2. **`index.mjs`** : 6 tools enregistrés — `sprint_start`, `sprint_list`, `sprint_get`, `sprint_close`, `sprint_reopen`, `sprint_attach_pieces` — avec `sprint_report` **réutilisé** (aucun doublon).
3. **Comportements** :
   - création d'un sprint à durée paramétrable (début/fin), 0..N pièces optionnelles, statut initial cohérent (échéance passée → `close`) ;
   - lecture liste + détail (pièces, fonctionnalités, règles, statut, dates) ;
   - clôture manuelle et clôture automatique à l'échéance, **distinctes** de la clôture d'exécution des tâches ;
   - reprise (réouverture) d'un sprint clôturé ;
   - rattachement de pièces avec **garde nature** (refus photo/vidéo) et **marquage émergent** si rattachement après init (`apres_init_sprint` / `apres_cloture`) ;
   - la clôture **déclenche** la règle d'émergence, la reprise la **suspend** (via `classifyEmergence`, état renvoyé par les tools).
4. **Rapport de vérification** (A012) : `node --check` + spawn MCP réel + cycle complet + non-régression.
5. **Aucun** élément `feature_*` / `rule_*` (périmètre T5), **aucune** modification du modèle ADR/`artifacts`.

## 6. Ordre & dépendances

```
A001 ─▶ A002 ─▶ A003
        └────▶ A011
A004 ─▶ A008
A005 ─▶ A006 ─▶ A007 ─▶ A008 ─▶ A009 ─▶ A010 ─▶ A011
A003 ─▶ A006 ;  A004 ─▶ A006
A011 ─▶ A012 ;  A005..A011 ─▶ A012 ;  A003 ─▶ A012
```

- A001 **avant** A002 (la garde nature est utilisée par le rattachement).
- A002 **avant** A003 (la création rattache les pièces via `attachPiecesToSprint`) et **avant** A011 (le tool expose la fonction).
- A003 **avant** A006 (le tool `sprint_start` appelle `createSprint`) ; A004 **avant** A006/A008 (le tool `sprint_get` appelle `getSprintDetail`).
- A005 **avant** A006-A011 (les tools consomment les imports).
- A009/A010 ne dépendent d'**aucune** nouvelle fonction `db.mjs` : ils réutilisent `closeSprint` / `autoCloseExpiredSprints` / `reopenSprint` / `classifyEmergence` (T3).
- A012 **en dernier** (vérification).
- **Parallélisables** : A004 (indépendant de A001-A003) ; A007/A009/A010 après A005 ; A011 après A002 + A005.

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|----------------------------------|----------|-----------|
| `sprint_start` — création (projet, titre, **durée paramétrable** début/fin, pièces optionnelles) | A003 (fonction), A006 (tool), A002 (pièces) | ✅ |
| `sprint_list` — liste par projet | A007 (`listProjectSprints` T3 + clôture auto) | ✅ |
| `sprint_get` — détail : pièces, fonctionnalités, règles, statut, dates | A004 (fonction), A008 (tool) | ✅ |
| `sprint_close` — clôture **auto à l'échéance OU manuelle** | A009 (`autoCloseExpiredSprints` / `closeSprint` T3) | ✅ |
| `sprint_reopen` — reprise d'un sprint clôturé | A010 (`reopenSprint` T3) | ✅ |
| `sprint_attach_pieces` — rattachement pièces **avec garde nature** | A001 (garde), A002 (fonction), A011 (tool) | ✅ |
| `sprint_attach_pieces` — **marquage émergent si après init** | A002 (`close`→`apres_cloture`, `open`→`apres_init_sprint`) | ✅ |
| `sprint_report` — **génération du rapport** (déjà livré T3, réutiliser) | tool existant `index.mjs` l.593-605 — **aucune** étape de création ; A006 n'ajoute que `sprint_start` après lui ; A012 vérifie l'unicité | ✅ (réutilisé) |
| La **clôture déclenche** la règle d'émergence ; la **reprise la suspend** | A009 (émergence renvoyée après clôture), A010 (émergence suspendue après reprise), A002 (marquage selon l'état) | ✅ |
| Création possible **avec 0 pièce** (pièces ajoutées ensuite = émergentes si après init) | A003 (`pieces` optionnel), A002 (`atInit=false` → émergent) | ✅ |
| Ne pas casser ADR/`artifacts` ni T1-T3 | A001-A004 **additifs** (aucune primitive T3 modifiée), A005 (imports seuls), A012 | ✅ |
| Ne pas implémenter `feature_*`/`rule_*` (T5) | Périmètre A001-A012 borné à `sprint_*` | ✅ |
| Traçabilité (événement, plan, artefact) | Phase 8 (`task_event` `PLANNING_STARTED`/`PLAN_CREATED`, `plan_register`, `artifact_add`) | ✅ |
| Tests E2E Playwright | **NA** — aucun `playwright.config.*` ni spec E2E dans `opencode-mcp-task-orchestrator` (repo outillage MCP) ; comportement interne registre, non observable par parcours Playwright. Aucun `e2e_test_register`/`e2e_test_link` (mention explicite, §9) | ✅ (NA) |

## 8. Vérification de cohérence

**Intra-plan (Phases 6-7)** :

- **Aucune étape `supprimer` / `renommer` / `déplacer`** → aucune contradiction de ce type.
- **Élément × fichier** :
  - `db.mjs` : A001-A004 créent des **fonctions distinctes** (`assertAttachablePiece`, `attachPiecesToSprint`, `createSprint`, `getSprintDetail`) — pas de collision.
  - `index.mjs` : A005 modifie l'import ; A006 modifie le commentaire + ajoute un tool ; A007-A011 ajoutent des tools distincts. Tous **additifs**, emplacements explicites (après `sprint_report` l.605).
- **Lecture d'un élément créé par une étape ultérieure** : non. `attachPiecesToSprint` (A002) appelle `assertAttachablePiece` (A001) — créée **avant**. `createSprint` (A003) appelle A002 — avant. Les tools (A006-A011) viennent après l'import (A005) et les fonctions (A001-A004).
- **`sprint_report`** : aucune étape ne le recrée ni ne le modifie (A006 insère `sprint_start` **après** lui, sans le toucher) → pas de doublon.
- **Primitives T3** : aucune étape ne les modifie ; elles sont **appelées** (A002/A003/A009/A010). Cohérent avec la consigne « réutilise, ne réimplémente pas ».
- **Ordre d'écriture `artifacts.meta`** : A002 écrit `meta` (émergence) ; A004 lit `artifacts` — A004 est indépendant mais ne dépend pas du marquage, pas de conflit.
- **Gate** : exigences 100 % couvertes (§7), aucune étape vague (chaque étape cible une fonction/un tool précis avec emplacement et signature) → **Valid**.

**Globale (Phase 9)** : un **seul plan** est produit pour cette tâche (objectif unique). Aucune
incohérence inter-plans. Frontière inter-tâches respectée : `feature_*`/`rule_*` (T5) et panneau
(T7) ne sont pas touchés.

## 9. Risques & notes

1. **Émergence au rattachement sur sprint `open`** — `attachPiecesToSprint` marque une pièce
   `emergent=true, emergent_origin='apres_init_sprint'` lorsqu'elle est rattachée à un sprint `open`
   (cohérent avec le comportement T2 de `addPiece` via `classifyEmergence`). À la **création**
   (`atInit=true`, A003), les pièces sont au contraire **non émergentes** (elles constituent le
   sprint). Sémantique explicite et documentée en commentaire de A002.
2. **Sprints `open` multiples** — aucune contrainte d'unicité sur les sprints ouverts (seul le sprint
   *par défaut* est unique). `sprint_start` **n'interdit pas** un second sprint ouvert ;
   `detectOpenSprint` retient le plus récent. Comportement conforme à « 1 projet → 1..N sprints » ;
   le panneau (T7) porte l'ergonomie. Non bloquant.
3. **Reprise sans prolongation** — `reopenSprint` (T3) pose `auto_close=0` si l'échéance reste passée
   sans nouvelle `endDate` (évite la re-clôture immédiate). Comportement T3 conservé, à documenter
   dans la description du tool `sprint_reopen`.
4. **Clôture de sprint ≠ clôture de tâche** — `closeSprint` n'écrit jamais sur `tasks`/`executions`
   (ADR-001 §1) ; `sprint_close` hérite de cette garantie. A012 le vérifie.
5. **ADR-001 statut `Proposé`** — le modèle n'est pas encore *Accepté* : les étapes restent
   **additives** et n'introduisent aucune contrainte nouvelle (pas de table, pas de colonne, pas de
   garde bloquante). Aucune contradiction avec une ADR Acceptée.
6. **E2E Playwright : NA** — repo outillage MCP sans `playwright.config.*` ni spec E2E ; le
   comportement est interne (registre + tools). Vérification par `node --check`, spawn réel du MCP et
   cycle complet (A012). Aucun `e2e_test_register` / `e2e_test_link`.
7. **Vérification par spawn réel** — l'expérience du repo (hotfix `ARTIFACT_KINDS`) impose un
   `tools/list` + `tools/call` réels, pas seulement `node --check` (A012).
