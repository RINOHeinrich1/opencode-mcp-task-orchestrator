# Plan — Recette : sélectionner et référencer en contexte les Fonctionnalités et Règles métier

- **Plan** : `Plan-recette-features-rules-contexte-20260922-070249`
- **Tâche** : `T-20260922-070103-ncs1` (exécution `E-T-20260922-070103-ncs1-c1g8ft`, projet `ecosystem`)
- **Tâche liée exploitée** : `T-20260922-064200-e0yw` (rôles explicites des règles + `sprintIds` bulk) — statut `done`, plan `Plan-sprint-filter-roles-regles-20260922-064347`, commits `6264c88` (repo MCP) et `86535c4` (repo panneau).
- **Repos** :
  - `opencode-mcp-task-orchestrator` → `/root/.config/opencode/mcp/task-orchestrator` (branche de base `feature/migration-postgresql`)
  - `opencode-observability` → `/root/orchestrator-panel` (branche de base `feature/migration-postgresql`)

---

## 1. Objectif

Permettre, à la création d'une recette, de **sélectionner des Fonctionnalités (`US-xxx`) et des Règles métier (`RM-xxxx`) en plus des ADR**, de les **rattacher à la recette** (nouvelle table `recette_regles` + `ruleIds` dans `recette_start`) et d'**injecter leurs blocs de contexte** (« Fonctionnalités de référence », « Règles métier de référence ») dans le prompt de la session `agent-recette`.

## 2. Contexte & raison d'être

Aujourd'hui, le formulaire de création de recette (`public/app.js` `recetteCreateModal`, l.2861-3023) ne propose que le **sélecteur ADR** (`adrSelectorHtml`, l.5872 / `selectedAdrIds('rm-adr-pick')`, l.5913) ; `recette_start` accepte `featureIds`/`adrIds`/`sprintId` mais **pas `ruleIds`** ; aucune table `recette_regles` ni outils `recette_rule_link`/`recette_rule_unlink` n'existent ; `getRecetteById` (db.mjs l.5999) expose `sprints`/`fonctionnalites`/`adrs` mais **pas `regles`** ; `buildRecettePrompt` (`session-bridge.mjs` l.335) n'injecte que `adrContext`.

La recette est une opération de vérification : l'agent doit confronter le constat aux **références fonctionnelles** du projet (user stories, règles métier), pas seulement aux décisions d'architecture. L'utilisateur doit donc pouvoir choisir ces références et les voir figurer dans le prompt.

**Décisions de conception reprises du précédent livré** (tâche liée `T-20260922-064200-e0yw`) :
- le champ `roles` des règles est désormais **explicite** (`regles_metier.roles` + `role_global`), et `rule_list` expose déjà `roles`/`roleGlobal`/`sprintIds` → le bloc « Règles métier de référence » les lit **sans dérivation ni N+1** ;
- le patron de requête bulk (`unnest($1::text[])`, 0 N+1) est le modèle à suivre pour les nouvelles lectures.

**ADR** : aucune ADR `Accepté` du projet `ecosystem` ne contredit ce plan (aucune ADR n'est rattachée à cette tâche ; `task_get` → `adrs: []`). Le plan **ne touche pas** au flux ADR (sélection, `adrContext`, vigilances) : il est purement additif.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | créer | table `recette_regles` (+ index `idx_recette_regles_regle`) | `schema.sql` (après l.891, bloc `recette_adr`) | `schema.sql` | miroir DDL de `recette_fonctionnalites` | DDL idempotente `CREATE TABLE IF NOT EXISTS` |
| A002 | modifier | constante `SCHEMA_VERSION` (l.33) | `db.mjs` | `db.mjs` | forcer le rejeu de `migrate()` (toutes les DDL sont `IF NOT EXISTS`) | version `"2026-09-22-recette-regles-contexte"` |
| A003 | ajouter | fonction `migrate()` (après l.702, après `recette_adr`) | `db.mjs` | `db.mjs` | la table doit exister en base au runtime | `CREATE TABLE IF NOT EXISTS recette_regles` + index dans `migrate()` |
| A004 | créer | fonctions `linkRecetteRule` / `unlinkRecetteRule` (après l.3286, après `unlinkRecetteAdr`) | `db.mjs` | `db.mjs` | liaisons N:N recette↔règle (miroir de `linkRecetteFeature`) | 2 fonctions exportées, garde `getRule(ruleId)` |
| A005 | modifier | fonction `startRecette` — signature (l.5874), JSDoc (l.5869-5873), boucle de liaison (après l.5905) | `db.mjs` | `db.mjs` | accepter `ruleIds` (optionnel, non bloquant) | paramètre `ruleIds` + boucle `try { linkRecetteRule } catch {}` |
| A006 | ajouter | fonction `getRecetteById` — `Promise.all` des liens (l.6040-6051) + objet retour (l.6055-6074) | `db.mjs` | `db.mjs` | exposer `regles` (comme `fonctionnalites`/`adrs`/`sprints`) | requête `ruleRows` + champ `regles: rowToRegle(...)` |
| A007 | créer | `renderFeatureContextBlock` / `renderRuleContextBlock` (modèle `renderAdrContextBlock` l.4997) et `buildFeatureContext` / `buildRuleContext` (modèle `buildAdrContext` l.5191) | `db.mjs` | `db.mjs` | blocs de contexte prêts à injecter, facultatifs | 2 renderers + 2 builders exportés, lecture bulk `WHERE id = ANY($1::text[])`, `context: ""` si vide |
| A008 | modifier | bloc d'import depuis `./db.mjs` (l.40-120 et l.206-209) | `index.mjs` | `index.mjs` | rendre les nouvelles fonctions disponibles aux tools | `linkRecetteRule`, `unlinkRecetteRule`, `buildFeatureContext`, `buildRuleContext` importés |
| A009 | créer | tools `recette_rule_link` / `recette_rule_unlink` (après l.1383, après `recette_adr_unlink`) | `index.mjs` | `index.mjs` | parité avec `recette_feature_link`/`recette_adr_link` | 2 tools MCP enregistrés (`recetteId`, `ruleId`) |
| A010 | modifier | tool `recette_start` — `inputSchema` (l.1814) + handler (l.1822) + description | `index.mjs` | `index.mjs` | accepter `ruleIds` | `ruleIds: z.array(z.string()).optional()` transmis à `startRecette` |
| A011 | modifier | tool `recette_get` — description (l.1847) | `index.mjs` | `index.mjs` | documenter `regles` (comportement porté par A006) | description mentionnant `regles` |
| A012 | créer | tools `feature_context` / `rule_context` (après l.1445, après `adr_context`) | `index.mjs` | `index.mjs` | exposer les builders A007 au panneau (patron `adr_context`) | 2 tools MCP enregistrés (`projectId`, `featureIds`/`ruleIds`) |
| A013 | modifier | fonction `deleteRule` — détachements explicites (l.2429-2433) | `db.mjs` | `db.mjs` | miroir explicite des FK CASCADE (cohérence avec `deleteFeature`) | `DELETE FROM recette_regles WHERE regle_id = $1` |
| B001 | modifier | fonction `createRecette` — signature (l.1120) + appel `recette_start` (l.1123-1131) | `pilot.mjs` | `pilot.mjs` | transmettre la sélection du panneau | `featureIds` + `ruleIds` passés à `recette_start` |
| B002 | créer | fonctions `featureContext(args)` / `ruleContext(args)` (près de `adrContext` l.1005) | `pilot.mjs` | `pilot.mjs` | wrappers MCP + court-circuit « sélection vide » | 2 fonctions exportées (sélection vide ⇒ `context: ""`) |
| B003 | modifier | fonction `launchRecetteSession` (l.1197-1202) | `pilot.mjs` | `pilot.mjs` | construire les blocs depuis les liens de la recette | `featureCtx`/`ruleCtx` passés à `buildRecettePrompt` |
| B004 | modifier | fonction `buildRecettePrompt` — signature (l.335) + insertion des blocs (après `adrBlock`, l.360) | `session-bridge.mjs` | `session-bridge.mjs` | injecter les blocs dans le prompt (facultatifs) | paramètres `featureContext`/`ruleContext` + blocs conditionnels |
| B005 | modifier | route `POST /api/recettes` (l.2606) | `server.mjs` | `server.mjs` | transmettre la sélection du formulaire | `featureIds: b.featureIds`, `ruleIds: b.ruleIds` |
| B006 | modifier | route `POST /api/recettes/:id/session` (l.2613) | `server.mjs` | `server.mjs` | parité avec `adrIds` (surcharge explicite au lancement) | `featureIds`/`ruleIds` transmis à `launchRecetteSession` |
| B007 | ajouter | formulaire `recetteCreateModal` — HTML (après l.2878, après le fieldset ADR) | `public/app.js` | `public/app.js` | conteneurs des sélecteurs | 2 fieldsets + `#rm-feature-pick` / `#rm-rule-pick` |
| B008 | créer | `frSelectorHtml(kind, items, opts)` + `selectedFrIds(kind, prefix)` + `bindFrSelector(prefix)` (près de `adrSelectorHtml` l.5872) | `public/app.js` | `public/app.js` | sélecteurs multi-lignes génériques (recherche/filtre, cases, tout coché) | 3 helpers, réutilisant les classes CSS `.adr-pick*` |
| B009 | ajouter | fonction `loadFeaturesRules()` + branchement sur `projectSel.change` (l.2945-2949) | `public/app.js` | `public/app.js` | charger Fonctionnalités + Règles du projet (1 appel chacun) | rendu + bind des 2 sélecteurs, 0 N+1 |
| B010 | modifier | handler `submit` du formulaire (l.3010-3018) | `public/app.js` | `public/app.js` | envoyer la sélection | `featureIds` + `ruleIds` dans le body `POST /api/recettes` |

## 4. Fichiers concernés

| Fichier | Repo | Type de modification |
|---------|------|----------------------|
| `schema.sql` | opencode-mcp-task-orchestrator | modification (DDL additive) |
| `db.mjs` | opencode-mcp-task-orchestrator | modification (migration + 2 tables de liaison + `startRecette` + `getRecetteById` + `deleteRule` + 4 fonctions) |
| `index.mjs` | opencode-mcp-task-orchestrator | modification (imports + 4 tools + 2 descriptions) |
| `pilot.mjs` | opencode-observability | modification (`createRecette`, `launchRecetteSession` + 2 wrappers) |
| `session-bridge.mjs` | opencode-observability | modification (`buildRecettePrompt`) |
| `server.mjs` | opencode-observability | modification (2 routes recette) |
| `public/app.js` | opencode-observability | modification (formulaire + 3 helpers + chargement + submit) |

Aucune suppression de fichier. Aucun changement de branche principale.

## 5. Livrables attendus

1. Table `recette_regles` (DDL idempotente, `migrate()` **ET** miroir `schema.sql`) + index.
2. `recette_start` accepte `ruleIds` (optionnel, non bloquant) ; `recette_get` expose `regles`.
3. Tools MCP `recette_rule_link` / `recette_rule_unlink` ; tools `feature_context` / `rule_context`.
4. Sélecteurs multi-lignes **Fonctionnalités** et **Règles métier** dans le formulaire de création de recette (recherche + filtre rôle, cases à cocher, toutes cochées par défaut), avec transmission de `featureIds` + `ruleIds`.
5. Blocs « Fonctionnalités de référence » et « Règles métier de référence » injectés dans le prompt `agent-recette`, **facultatifs** (aucun bloc si la sélection est vide).
6. `node --check` OK sur les 3 fichiers `.mjs` modifiés du panneau + le MCP ; spawn MCP réel OK ; 0 N+1.
7. Preuve : recette créée sur `myxmax` avec ≥1 fonctionnalité et ≥1 règle → liens visibles via `recette_get` (`regles`, `fonctionnalites`) + blocs présents dans le prompt de session.

## 6. Ordre & dépendances

```
MCP — modèle
  A001 (schema.sql) ──┐
  A002 (version) ─────┼──> A003 (migrate) ──> A004 (link/unlink) ──> A005 (startRecette.ruleIds)
                      │                                                      │
                      │                                                      ├──> A006 (getRecetteById.regles) ──> A011 (desc recette_get)
                      │                                                      │
                      └──────────────────────────────────────────────────────┴──> A013 (deleteRule détache recette_regles)

MCP — contexte
  A007 (builders + renderers) ──> A008 (imports index) ──┬──> A009 (recette_rule_link/unlink)
                                                         ├──> A010 (recette_start.ruleIds)
                                                         └──> A012 (feature_context / rule_context)

Panneau — contexte (après A012)
  B004 (buildRecettePrompt) ──> B002 (wrappers) ──> B003 (launchRecetteSession)

Panneau — sélection (après A010)
  B007 (formulaire) ──> B008 (helpers) ──> B009 (chargement) ──> B010 (submit)
                                                                   │
  B001 (createRecette) ──> B005 (POST /api/recettes) ──────────────┘
  B003 ──────────────────> B006 (POST /api/recettes/:id/session)
```

Prérequis durs :
- `A004` exige `A001` **et** `A003` (la table doit exister).
- `A005` exige `A004`.
- `A006` exige `A003`.
- `A012` exige `A008` (les builders doivent être importés).
- `B003` exige `A012` **et** `B002` **et** `B004`.
- `B001` exige `A010` ; `B005` exige `B001` ; `B006` exige `B003`.
- `B009` exige `B007` **et** `B008` ; `B010` exige `B008`.

## 7. Choix de conception

### 7.1 Forme des sélecteurs (panneau)
- **Un helper générique** `frSelectorHtml(kind, items, opts)` (kind ∈ `feature|rule`) placé à côté de `adrSelectorHtml` (l.5872), plutôt que deux fonctions dupliquées. Il réutilise **les mêmes classes CSS** que le sélecteur ADR (`.adr-pick`, `.adr-pick-row`, `.adr-pick-cb`, `.adr-pick-filters`, `.adr-pick-search`, `.adr-pick-count`) avec des `id` distincts (`rm-feature-pick`, `rm-rule-pick`) → **aucun changement CSS**.
- **Lignes** : case à cocher + `ref` + badge (rôle / « Global » pour une règle) + texte condensé (`userStory` pour une fonctionnalité, `content` pour une règle). Le `data-search` de chaque ligne agrège `ref + role + userStory` (fonctionnalité) ou `ref + content + roles` (règle).
- **Filtres** : recherche libre (comme l'ADR) + **un filtre Rôle** (options = rôles distincts du projet, calculés depuis les deux listes déjà chargées — union de `features[].role` et `rules[].roles`, comme `projectRoles` l.5686-5689), avec pour les règles une option supplémentaire **« Global »** (règles `roleGlobal=true`). Filtrage **client** uniquement.
- **Tout coché par défaut** : `opts.selected` absent ⇒ toutes les cases cochées (même sémantique que `adrSelectorHtml`, l.5879/5888). Décocher tout est permis ⇒ `featureIds: []` / `ruleIds: []` ⇒ création possible avec 0 sélection (exigence de non-régression).
- Lecture de la sélection : `selectedFrIds(kind, prefix)` retourne **toujours un tableau** (vide si rien de coché), exactement comme `selectedAdrIds` (l.5913).

### 7.2 Construction des blocs de contexte (MCP)
- **Patron `buildAdrContext`** (db.mjs l.5191) repris à l'identique : `buildFeatureContext({ projectId, featureIds })` et `buildRuleContext({ projectId, ruleIds })` retournent `{ projectId, count, features|rules, context }`.
- **Lecture bulk, 0 N+1** : sélection explicite ⇒ **une** requête `SELECT * FROM fonctionnalites WHERE id = ANY($1::text[]) ORDER BY ref ASC` (resp. `regles_metier`) puis `rowToFonctionnalite`/`rowToRegle` — pas de `getFeature` par id (contrairement à la branche explicite de `buildAdrContext`, volontairement améliorée ici). Les ids inconnus sont simplement ignorés (`filter(Boolean)`).
- **Rendu** (modèle `renderAdrContextBlock` l.4997, `oneLine` l.4974) :
  - `## Fonctionnalités de référence` → par fonctionnalité : `### <ref> — <role || "sans rôle">`, `- User story : <oneLine(userStory)>`.
  - `## Règles métier de référence` → par règle : `### <ref>`, `- Contenu : <oneLine(content)>`, `- Rôles : (tous les rôles — globale)` si `roleGlobal`, sinon `<roles.join(", ")>` (ou `(aucun)`).
  - `context` = chaîne vide si `items.length === 0` ⇒ **aucun bloc** injecté (facultatif).
- **Exposition MCP** : 2 nouveaux tools `feature_context` / `rule_context` (patron exact de `adr_context` l.1432) pour que le panneau reste un simple passe-plat (comme `pilot.adrContext`).

### 7.3 Injection dans le prompt
- `buildRecettePrompt` reçoit `featureContext` / `ruleContext` et les insère **après** `adrBlock` (l.360), en n'ajoutant que les blocs non vides (`[..., String(ctx).trim(), ""]` sinon `[]`) — **le flux ADR est inchangé** (mêmes paramètres, même ordre relatif).
- `launchRecetteSession` construit les blocs depuis **les liens persistés** de la recette (`rec.fonctionnalites`, `rec.regles`) lus par le `recette_get` déjà effectué (l.1180) ⇒ **1 seul appel MCP** pour le contexte de liens, 0 N+1, et le prompt reflète toujours la recette réellement enregistrée (le lancement depuis le panneau n'envoie aujourd'hui que `{ force }`, cf. `app.js` l.2527). Les surcharges `featureIds`/`ruleIds` (parité avec `adrIds`, route B006) restent possibles pour un lancement explicite.

### 7.4 Non-régression
- Flux ADR : `recette_adr`, `linkRecetteAdr`, `adrContext`, vigilances et blocs ADR **non touchés** (seule la **description** du tool `recette_get` est enrichie, A011).
- Création avec 0 sélection : les boucles `for (const x of Array.isArray(xs) ? xs : [])` de `startRecette` (A005) et les helpers de sélection (B008) tolèrent le vide ; `recette_start` reste valide sans `ruleIds` (champ optionnel).
- `node --check` sur `db.mjs`, `index.mjs`, `pilot.mjs`, `server.mjs`, `session-bridge.mjs`, `public/app.js`.
- Spawn MCP réel : les nouveaux tools doivent être listés par le serveur après redémarrage (vérification par appel réel `recette_rule_link` + `rule_context`).
- Performance : `loadFeaturesRules()` = **1** `GET /api/features?projectId=` + **1** `GET /api/rules?projectId=` (routes existantes, listes déjà enrichies `links`/`sprintIds`/`roles` par le livré `T-20260922-064200-e0yw`) ⇒ 0 N+1 côté panneau ; 1 requête bulk côté MCP.

### 7.5 E2E Playwright — analyse d'impact
**E2E : NA.** Aucun `playwright.config.*` dans `opencode-mcp-task-orchestrator` ni dans `opencode-observability`, et `e2e_list(project="ecosystem")` renvoie `count: 0`. La tâche porte sur de l'outillage interne (MCP + panneau) sans scénario Playwright existant : **aucun test E2E à créer/lier** ; la preuve d'acceptation passe par `recette_get` + inspection du prompt de session (critère 5 de la tâche).

## 8. Couverture des objectifs

| Exigence (tâche `T-20260922-070103-ncs1`) | Étape(s) | Couvert ? |
|---|---|---|
| Sélecteurs multi-lignes **Fonctionnalités** (Ref, rôle, user story) — recherche/filtre, cases, tout coché | B007, B008, B009 | oui |
| Sélecteurs multi-lignes **Règles métier** (Ref, contenu, rôles/global) — recherche/filtre, cases, tout coché | B007, B008, B009 | oui |
| Transmission `featureIds` + `ruleIds` à `recette_start`/`launchRecetteSession` | B010, B005, B001, A010, A005 | oui |
| MCP : `recette_start` accepte `ruleIds` (optionnel, non bloquant) | A010, A005 | oui |
| MCP : table `recette_regles` + outils `recette_rule_link`/`recette_rule_unlink` | A001, A003, A004, A008, A009 | oui |
| MCP : `recette_get` expose `regles` (+ `fonctionnalites`/`adrs`/`sprints`) | A006, A011 | oui |
| Contexte : bloc « Fonctionnalités de référence » injecté dans le prompt | A007, A012, B002, B003, B004 | oui |
| Contexte : bloc « Règles métier de référence » injecté dans le prompt | A007, A012, B002, B003, B004 | oui |
| Blocs **facultatifs** (aucun bloc si rien de sélectionné) | A007 (`context:""`), B002 (court-circuit), B004 (condition) | oui |
| Non-régression flux ADR (sélection, `adrContext`, vigilances) | A011 (description seule), B003, B004 (blocs ADR inchangés) | oui |
| Création de recette possible avec 0 sélection | A005 (boucles vides), B001 (`[]` toléré), B008 (retourne `[]`) | oui |
| `node --check` OK ; spawn MCP réel OK ; pas de N+1 | A003/A007 (1 requête bulk), B009 (2 appels listes) | oui |
| Preuve : recette `myxmax` avec ≥1 fonctionnalité + ≥1 règle → `recette_get` + blocs dans le prompt | A005, A006, B001, B003, B004 (vérification d'exécution) | oui |

## 9. Vérification de cohérence

**Intra-plan (Phases 6-7)** :
- Regroupement par élément cible — `db.mjs` : `SCHEMA_VERSION` (A002), `migrate()` (A003), `linkRecetteRule`/`unlinkRecetteRule` (A004), `startRecette` (A005), `getRecetteById` (A006), renderers/builders (A007), `deleteRule` (A013) → **8 éléments distincts**, aucun conflit.
- `index.mjs` : imports (A008), `recette_rule_*` (A009), `recette_start` (A010), `recette_get` (A011), `*_context` (A012) → éléments distincts.
- `public/app.js` : formulaire (B007), helpers sélecteurs (B008), chargement (B009), submit (B010) → éléments distincts.
- **Aucun** couple `supprimer` + autre action sur le même élément ; **aucun** `créer` + `renommer` ; **aucun** `déplacer`. A013 est un **ajout** de détachement dans une fonction existante (pas une suppression d'élément du plan).
- Ordre : aucune étape ne lit/modifie un élément créé par une étape ultérieure (dépendances vérifiées §6).
- **Gate : Valid.**

**Globale (Phase 9)** : un seul plan généré ⇒ pas de contradiction inter-plans. Aucune incohérence à signaler.

## 10. Risques & notes

- **Dérive DDL `migrate()` ↔ `schema.sql`** : les deux doivent porter la même table (A001 + A003). C'est une dérive assumée du projet (précédent T5) mais ici **les deux** sont mis à jour.
- **Branches & isolation** : une branche de travail dédiée **par repo** (via session-guard) ; ne **jamais** laisser `/root/orchestrator-panel` ni `/root/.config/opencode/mcp/task-orchestrator` sur une branche de travail (checkouts actuellement propres sur `feature/migration-postgresql`).
- **Redémarrage du serveur MCP** : les nouveaux tools (`recette_rule_link`, `feature_context`, `rule_context`) n'apparaissent qu'après rechargement du process MCP — à vérifier par un appel réel.
- **`roleGlobal`** : le bloc « Règles métier de référence » doit afficher « tous les rôles — globale » et non une liste vide (les règles existantes peuvent avoir `roles: []` + `roleGlobal: true`).
- **Traçabilité** : `task_event` (`PLANNING_STARTED` publié, `PLAN_CREATED` à publier), `plan_register(taskId=…)`, `artifact_add(kind=plan)`.
