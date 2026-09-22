# Plan — Filtre par SPRINT (Fonctionnalités & Règles) + association EXPLICITE des rôles aux règles métier

- **PlanId** : `Plan-sprint-filter-roles-regles-20260922-064347`
- **Tâche** : `T-20260922-064200-e0yw` (exécution `E-T-20260922-064200-e0yw-lnf52t`)
- **Projet** : `ecosystem`
- **Date** : 2026-09-22 06:43:47
- **Type** : feature (panneau + registre MCP)
- **Statut de validation** : **Valid** (couverture 100 %, aucune contradiction intra-plan)

---

## 1. Objectif

Ajouter au panneau (`opencode-observability`) et au registre MCP (`opencode-mcp-task-orchestrator`) :

1. un **filtre par SPRINT** dans les deux sous-onglets « Fonctionnalités » et « Règles métier », options = sprints du projet + « Sans sprint », filtrage CLIENT, persisté comme les autres filtres, **sans N+1** (ids de sprints liés exposés par la requête bulk existante) ;
2. une **association EXPLICITE de rôles** aux règles métier : **1..N rôles** OU **RÔLE GLOBAL** (tous les rôles), de bout en bout (modèle + migration idempotente + MCP + panneau), en **remplaçant** le champ `roles` aujourd'hui **dérivé** des fonctionnalités liées (T-20260921-145025-meiv).

---

## 2. Contexte & raison d'être

- Le filtre **rôle** existe déjà dans les deux sous-onglets ; le filtre **sprint** est absent. Le filtre « Sans sprint » du sous-onglet Règles s'appuie sur un **compteur** (`links.sprints`) mais **pas sur les ids**, donc on ne peut pas filtrer « lié au sprint X » sans N+1. Il faut exposer les **ids** de sprints liés dans la même requête bulk.
- Le champ `roles` d'une règle est aujourd'hui **dérivé** (`ruleLinkCounts` : `array_agg(DISTINCT fonctionnalites.role)` via `fonctionnalite_regles`). Ce n'est pas le modèle voulu : une règle doit porter sa **propre** association (1..N rôles ou global), éditable, indépendante de ses fonctionnalités.
- **ADR** : `adr_list(projectId=ecosystem)` → **aucune ADR** enregistrée ; aucun conflit ADR à signaler. Le modèle « rôle global » s'inspire de la notion existante d'**ADR globale** (`artifacts.is_global`) — cohérence de vocabulaire.
- **Tâche liée exploitée** : `T-20260921-145025-meiv` (relation `emergent`) — c'est là qu'ont été livrés `ruleLinkCounts` (+`roles` dérivé) et le filtre rôle des règles. Les conventions de ce plan s'appuient sur ses commits (`76800010` : `db.mjs`/`index.mjs` ; `1cc02930` : `public/app.js`) : requête bulk unique, champs **additifs** top-level (jamais de fuite dans le contrat `links`), filtres CLIENT à état module.
- **Tâche liée** : `T-20260921-140612-t8ub` (perf) — a supprimé le N+1 (index des liens dérivé du payload). Contrainte à préserver : `links`/`roles`/`sprintIds` proviennent d'**une seule** requête bulk ; le client MCP persistant et `schema_meta` ne sont pas touchés.

### 2.1 Décisions tranchées (explicites)

- **(a) Champ `roles` DÉRIVÉ → REMPLACÉ, sans repli d'affichage.** La dérivation est retirée de `ruleLinkCounts` ; `roles` (et `roleGlobal`) sont désormais lus **directement** depuis la table `regles_metier`. Aucun repli « rôles des fonctionnalités liées » : une source de vérité unique. `links` reste **strictement** `{features, sprints}` (compteurs), et `sprintIds` est un champ **additif** top-level. Conséquence assumée : les règles existantes démarrent « Sans rôle » jusqu'à édition explicite (pas de backfill automatique — voir Risques).
- **(b) Vocabulaire des rôles = RÔLES DISTINCTS DU PROJET.** Union de : (i) `fonctionnalites.role` distincts du projet, (ii) rôles explicitement déjà associés à des règles du projet. **Pas de table référentiel dédiée**, **pas de saisie libre** dans le formulaire (multi-sélection sur ce vocabulaire) : garantit un filtre cohérent. Le flag « Rôle global » dispense de sélection.
- **(c) Modèle = colonnes** `regles_metier.roles TEXT[] NOT NULL DEFAULT '{}'` + `regles_metier.role_global INTEGER NOT NULL DEFAULT 0` (plutôt qu'une table de liaison `regle_roles`) : miroir du booléen `is_global` des ADR, pas de jointure supplémentaire, et `SELECT *` de `listRules`/`getRule` renvoie déjà les colonnes (0 requête en plus).
- **(d) « Persisté »** = même mécanisme que les filtres existants : état **module** (`frFeatureFilters`/`frRuleFilters`) qui survit au polling `refreshActive()` et au re-rendu. Pas de localStorage (seul `frSubTab` l'utilise) — homogénéité avec les filtres livrés en `T-20260921-145025-meiv`.
- **(e) Un seul plan pour les deux objectifs** : bien que sémantiquement indépendants, ils **partagent les mêmes fonctions** (`ruleLinkCounts`, `listRules`, `frFilterRules`, `renderFrRulePanel`, `index.mjs`) — deux plans concurrents créeraient des conflits inter-plans. Livraison ordonnée dans un plan unique (cf. §6).

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| A001 | Ajouter colonnes | `regles_metier` (`roles`, `role_global`) — CREATE TABLE + ALTER miroir | `schema.sql` (l.721-746) | `schema.sql` | Modèle explicite, schéma neuf + base existante | Colonnes présentes dans `schema.sql` (CREATE + ALTER idempotents) |
| A002 | Ajouter colonnes | `migrate()` — 2 `ALTER TABLE regles_metier ADD COLUMN IF NOT EXISTS` | `db.mjs` (l.584-589) | `db.mjs` | Migration idempotente base existante | `migrate()` pose `roles`/`role_global` sans erreur |
| A003 | Exposer | `rowToRegle` → `roles` (array) + `roleGlobal` (bool) | `db.mjs` (l.1762-1782) | `db.mjs` | `rule_get`/`rule_list` exposent l'association | `roles: string[]`, `roleGlobal: boolean` |
| A004 | Créer | helper `normalizeRuleRoles({roles, roleGlobal})` | `db.mjs` (nouveau, près l.2226) | `db.mjs` | Garde unique ≥1 rôle OU global + normalisation | Fonction exportable interne (trim/dédup/validation) |
| A005 | Modifier | `registerRule` : params `roles`/`roleGlobal`, garde, INSERT | `db.mjs` (l.2230-2269) | `db.mjs` | Création avec association explicite | `rule_register` persiste `roles`/`role_global` |
| A006 | Modifier | `updateRule` : params `roles`/`roleGlobal` (état effectif + garde) | `db.mjs` (l.2274-2322) | `db.mjs` | Édition de l'association | `rule_update` met à jour `roles`/`role_global` |
| A007 | Modifier | `ruleLinkCounts` : retirer la sous-requête `roles` dérivée ; ajouter `sprintIds` | `db.mjs` (l.2169-2193) | `db.mjs` | Remplace la dérivation + expose les sprints liés (0 N+1) | Requête bulk → `{features, sprints, sprintIds}` |
| A008 | Modifier | `listRules` : mapper `sprintIds`, ne plus surcharger `roles` | `db.mjs` (l.2382-2415) | `db.mjs` | Expose sprints liés + rôles explicites | Chaque règle : `links` inchangé + `sprintIds` + `roles`/`roleGlobal` |
| A009 | Modifier | `featureLinkCounts` : ajouter `sprintIds` | `db.mjs` (l.2135-2161) | `db.mjs` | Sprints liés des fonctionnalités (0 N+1) | Requête bulk → `{..., sprintIds}` |
| A010 | Modifier | `listFeatures` : mapper `sprintIds` | `db.mjs` (l.2197-2224) | `db.mjs` | Expose sprints liés côté fonctionnalités | Chaque fonctionnalité : `links` inchangé + `sprintIds` |
| A011 | Modifier | tool `rule_register` : schema `roles`/`roleGlobal` + pass-through | `index.mjs` (l.1022-1037) | `index.mjs` | Expose l'association au MCP | Tool accepte `roles` (array) + `roleGlobal` (bool) |
| A012 | Modifier | tool `rule_update` : schema `roles`/`roleGlobal` + pass-through | `index.mjs` (l.1039-1056) | `index.mjs` | Édition via MCP | Tool accepte `roles` + `roleGlobal` |
| A013 | Modifier | descriptions `rule_get` / `rule_list` | `index.mjs` (l.1073-1097) | `index.mjs` | Documenter `roles`/`roleGlobal`/`sprintIds` (dérivation retirée) | Descriptions à jour |
| A014 | Modifier | description `feature_list` | `index.mjs` (l.992-1005) | `index.mjs` | Documenter `sprintIds` additif | Description à jour |
| A015 | Modifier | `createRule` : pass-through `roles`/`roleGlobal` | `pilot.mjs` (l.873-885) | `pilot.mjs` | Relais panneau → MCP | `createRule` transmet l'association |
| A016 | Modifier | `updateRule` : pass-through `roles`/`roleGlobal` | `pilot.mjs` (l.887-900) | `pilot.mjs` | Relais panneau → MCP | `updateRule` transmet l'association |
| A017 | Modifier | routes `POST`/`PUT /api/rules` : lire `roles`/`roleGlobal` | `server.mjs` (l.2058-2089) | `server.mjs` | API HTTP du panneau | Body `roles`/`roleGlobal` transmis à `pilot` |
| A018 | Modifier | `frFeatureFilters` / `frRuleFilters` : clé `sprint` | `app.js` (l.4975-4976) | `app.js` | État du nouveau filtre | `{ …, sprint: '' }` |
| A019 | Modifier | `frFilterFeatures` : filtre sprint client | `app.js` (l.5294-5318) | `app.js` | Filtrage « lié au sprint X » / « Sans sprint » | Prédicat `sprint` + `__none__` |
| A020 | Modifier | `frFilterRules` : filtre sprint + sémantique « Global » du filtre rôle | `app.js` (l.5325-5347) | `app.js` | Rôle global retenu par tout rôle + option Global | Prédicats `sprint` et `role=__global__` |
| A021 | Créer | helper `frRuleRolesBadges(r)` | `app.js` (près l.5408) | `app.js` | Affichage badges rôles / « Global » | Badges rôles ou chip « Global » ou `—` |
| A022 | Modifier | `frRuleTableHtml` : colonne « Rôles » | `app.js` (l.5408-5427) | `app.js` | Visibilité de l'association | `<th>Rôles</th>` + cellule badges |
| A023 | Modifier | `ruleFormModal` : multi-sélection rôles + case « Rôle global » | `app.js` (l.5097-5150) | `app.js` | Définir/éditer l'association | Checkboxes rôles + case global + garde UI |
| A024 | Modifier | `renderFrRulePanel` : filtre rôle (explicite + Global), filtre sprint, `projectRoles` | `app.js` (l.5505-5569) | `app.js` | Filtres + formulaire cohérents | 2 selects (rôle/global, sprint) + form câblé |
| A025 | Modifier | `renderFrFeaturePanel` : select sprint | `app.js` (l.5433-5499) | `app.js` | Filtre sprint côté fonctionnalités | Select `fr-f-sprint` câblé |
| A026 | Modifier | `renderFrSubpanel` / `renderFeaturesRules` : transmettre `sprints` + `projectRoles` | `app.js` (l.5572-5631) | `app.js` | Alimenter les options (0 appel réseau en plus) | Paramètres passés aux sous-panneaux |
| A027 | Vérifier | `node --check` sur les fichiers JS modifiés + spawn MCP réel | (transverse) | — | Contrainte de non-régression | Check OK + un appel MCP réel OK |

---

## 4. Fichiers concernés

| Fichier | Repo | Type de modification |
|---------|------|----------------------|
| `schema.sql` | `opencode-mcp-task-orchestrator` | modification (colonnes `regles_metier`) |
| `db.mjs` | `opencode-mcp-task-orchestrator` | modification (`migrate`, `rowToRegle`, `normalizeRuleRoles`, `registerRule`, `updateRule`, `ruleLinkCounts`, `listRules`, `featureLinkCounts`, `listFeatures`) |
| `index.mjs` | `opencode-mcp-task-orchestrator` | modification (tools `rule_register`, `rule_update`, `rule_get`, `rule_list`, `feature_list`) |
| `pilot.mjs` | `opencode-observability` | modification (`createRule`, `updateRule`) |
| `server.mjs` | `opencode-observability` | modification (routes `POST`/`PUT /api/rules`) |
| `public/app.js` | `opencode-observability` | modification (filtres, table règles, formulaire règle, sous-panneaux) |

Aucune suppression de fichier. Aucune modification directe de la branche principale : travail sur **branche dédiée par repo** (via session-guard). ⚠️ Ne pas laisser le checkout principal `/root/orchestrator-panel` sur une branche de travail en fin de sous-tâche.

---

## 5. Livrables attendus

1. **Modèle** : `regles_metier.roles TEXT[] NOT NULL DEFAULT '{}'` + `regles_metier.role_global INTEGER NOT NULL DEFAULT 0` — présents dans `schema.sql` **et** dans `migrate()` (idempotents).
2. **MCP** : `rule_register`/`rule_update` acceptent `roles` (array) + `roleGlobal` (bool) ; `rule_get`/`rule_list` exposent `roles` + `roleGlobal` ; garde « ≥1 rôle OU global » ; le champ `roles` **dérivé** est **remplacé** (dérivation retirée de `ruleLinkCounts`).
3. **Sprints liés** : `feature_list`/`rule_list` exposent `sprintIds` (additif, même requête bulk → **0 N+1**) ; `links` inchangé.
4. **Panneau** : formulaire règle avec **multi-sélection des rôles** + case **« Rôle global (tous les rôles) »** ; table des règles avec colonne **Rôles** (badges / « Global ») ; **filtre rôle** des règles basé sur l'association explicite + option **« Global »** ; **filtre sprint** dans les **deux** sous-onglets (options = sprints du projet + « Sans sprint »).
5. **Non-régression** : `links`/compteurs, filtres existants, CRUD, badges, index des liens, client MCP persistant et `schema_meta` intacts ; `node --check` OK ; spawn MCP réel OK.

---

## 6. Ordre & dépendances

```
A001 ─→ A002 ─┐
              ├─→ A005 ─┐
A004 ─────────┘         │
A004 ─→ A006 ───────────┤
A001/A002 ─→ A003 ──────┤
                        ├─→ A011 ─→ A012 ─→ A013 ─→ A014
A007 ─→ A008 ───────────┤
A009 ─→ A010 ───────────┤
                        ├─→ A015 ─→ A016 ─→ A017
                        └─→ A018 ─→ A019 ─→ A020 ─→ A021 ─→ A022 ─→ A023 ─→ A024 ─→ A025 ─→ A026 ─→ A027
```

Prérequis clés :
- **A005** requiert **A002** (colonnes) et **A004** (helper).
- **A006** requiert **A004**.
- **A007/A008** requièrent **A001/A002** (les colonnes `roles`/`role_global` doivent exister pour que `listRules` les renvoie) ; **A007** retire la sous-requête dérivée.
- **A009/A010** indépendants de A001-A008 (sprintIds).
- **A011-A014** requièrent **A003** (payload) et **A005/A006** (comportement).
- **A015-A017** requièrent **A011/A012**.
- **A018-A026** requièrent **A008/A010** (données `sprintIds`/`roles`) et **A015-A017** (persistance de l'association depuis le formulaire).
- **A027** en dernier.

Exécution **séquentielle** recommandée (les étapes touchent les mêmes fichiers). Un seul writer par repo ; `opencode-mcp-task-orchestrator` et `opencode-observability` peuvent être traités par la même sous-tâche dans l'ordre ci-dessus.

---

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|---|---|---|
| Filtre sprint dans **Fonctionnalités** (options = sprints + « Sans sprint »), filtrage client, persisté | A009, A010, A018, A019, A025, A026 | ✅ |
| Filtre sprint dans **Règles métier** (options = sprints + « Sans sprint »), filtrage client, persisté | A007, A008, A018, A020, A024, A026 | ✅ |
| Ids de sprints liés exposés par la requête bulk (**0 N+1**) | A007, A009, A010 | ✅ |
| Modèle règle : **1..N rôles OU rôle global** ; migration idempotente (`migrate()` **ET** `schema.sql`) | A001, A002, A003 | ✅ |
| MCP : `rule_register`/`rule_update` acceptent `roles`+`roleGlobal` ; `rule_get`/`rule_list` les exposent ; garde ≥1 rôle ou global | A003, A004, A005, A006, A011, A012, A013 | ✅ |
| Champ `roles` **dérivé remplacé** (dérivation retirée) | A007, A008, A013 | ✅ |
| Panneau : formulaire règle multi-sélection rôles + case « Rôle global » | A023, A024, A026 | ✅ |
| Panneau : table affiche rôles (badges) ou « Global » | A021, A022 | ✅ |
| Panneau : filtre rôle des règles sur l'association explicite + option « Global » | A020, A024 | ✅ |
| Persistance association de bout en bout (panneau → MCP) | A015, A016, A017 | ✅ |
| Vocabulaire = rôles distincts du projet (union features + rôles explicites) | A024, A026 | ✅ |
| Performance préservée : 0 N+1, `links` inchangé, client MCP persistant / `schema_meta` non touchés | A007, A008, A009, A010, A026, A027 | ✅ |
| Non-régression filtres/CRUD/badges + `node --check` + spawn MCP réel | A027 (transverse) | ✅ |

**Couverture = 100 %** des critères d'acceptation de `T-20260922-064200-e0yw`.

---

## 8. Vérification de cohérence (Phases 6-7)

### 8.1 Contradictions intra-plan (par élément cible)

| Élément cible | Étapes | Verdict |
|---|---|---|
| `regles_metier.roles` / `role_global` | A001, A002 (création colonnes), A003 (lecture), A005, A006 (écriture) | ✅ Cohérent : création → lecture/écriture, aucun `supprimer` sur le même élément |
| `ruleLinkCounts` | A007 (retrait dérivation `roles` + ajout `sprintIds`) | ✅ Une seule étape modifie la fonction ; pas de contradiction |
| `listRules` | A008 (mappe `sprintIds`, cesse de surcharger `roles`) | ✅ Compatible avec A003 (roles viennent de `...r`) et A007 (`c.roles` n'existe plus → n'est plus référencé) |
| `featureLinkCounts` / `listFeatures` | A009, A010 | ✅ Ordre création (A009) → consommation (A010) respecté |
| `frFilterRules` | A020 (sprint + `__global__`) | ✅ Aucune autre étape ne modifie ce prédicat |
| `renderFrRulePanel` | A024 (rôle/global + sprint + projectRoles) | ✅ Étapes A021/A022 (helpers/table) préalables, pas de conflit |
| `ruleFormModal` | A023 | ✅ Appelants (A024) mis à jour dans la même foulée |
| `index.mjs` tools | A011, A012, A013, A014 | ✅ Tools distincts, pas de double écriture du même bloc |

**Aucune contradiction détectée.** En particulier : le retrait de la sous-requête `roles` (A007) et l'arrêt de la surcharge dans `listRules` (A008) sont **cohérents** (le champ `roles` ne provient plus que de la colonne, via A003) ; `links` n'est **jamais** modifié par une étape.

### 8.2 Ordre / dépendances (lecture d'un élément créé par une étape ultérieure)

- A005/A006 écrivent `roles`/`role_global` (créés en A001/A002) → ordre OK.
- A008 consomme `c.sprintIds` produit en A007 → ordre OK.
- A010 consomme `counts.sprintIds` produit en A009 → ordre OK.
- A024 consomme `x.sprintIds`/`x.roles`/`x.roleGlobal` produits côté registre (A008/A010) → ordre OK.

### 8.3 Gate Plan Validator

- Couverture objectif : **100 %** (§7).
- Contradictions : **aucune** (§8.1).
- Étapes vagues : **aucune** (chaque étape = 1 élément × 1 fichier × 1 verbe).
→ **Valid** → écriture + enregistrement (Phase 8).

---

## 9. Risques & notes

1. **Pas de backfill des rôles dérivés** (décision (a)) : après livraison, les règles existantes apparaissent « Sans rôle » jusqu'à édition explicite. C'est volontaire (le modèle dérivé est incorrect). Un backfill idempotent *one-shot* (reprendre `array_agg(DISTINCT fonctionnalites.role)` pour les règles à `roles='{}' AND role_global=0`) est possible en option mais **non retenu** ici pour ne pas figer la dérivation erronée. À re-trancher par l'utilisateur si le confort d'affichage prime.
2. **Garde stricte à la création** : `rule_register` sans `roles` ni `roleGlobal` échouera (« au moins 1 rôle ou roleGlobal »). Tout appelant agent existant doit fournir l'association. Le formulaire panneau fournit toujours l'un des deux.
3. **Type `TEXT[]`** : `pg` renvoie un tableau JS natif ; la normalisation (A004) garantit trim/dédup et rejette les chaînes vides. Pas d'index nécessaire (filtrage CLIENT).
4. **Filtre « Global »** : une règle `roleGlobal=true` est retenue par **tout** filtre rôle spécifique **et** par l'option « Global » (sémantique « s'applique à tous les rôles »). Une règle globale n'est **pas** « Sans rôle ».
5. **Performance** : `sprintIds` est une sous-requête scalaire `array_agg` ajoutée dans la requête `unnest` existante → toujours **1 aller-retour**. Le retrait de la sous-requête `roles` dérivée **réduit** le coût de `ruleLinkCounts`. Aucune nouvelle requête par entité ; le client MCP persistant et `schema_meta` ne sont pas touchés.
6. **Tests E2E** : aucun dépôt du projet `ecosystem` ne contient de configuration Playwright (`playwright.config.*` absent de `/root/orchestrator-panel` et de `/root/.config/opencode/mcp/task-orchestrator`) → **E2E NA**. La validation reste : `node --check` sur les JS modifiés + **spawn MCP réel** (appel `rule_list`/`feature_list` avec `sprintIds`/`roles` + un `rule_update` d'association).
7. **Isolation** : branche de travail dédiée par repo (session-guard) ; ne jamais modifier la branche principale `feature/migration-postgresql` directement ; **ne pas laisser le checkout principal `/root/orchestrator-panel` sur une branche de travail** en fin de sous-tâche.
