# Plan — Panneau : filtre par rôle dans les sous-onglets « Fonctionnalités » ET « Règles métier » (rôle d'une règle = rôles de ses fonctionnalités liées)

- **taskId** : `T-20260921-145025-meiv` (exécution `E-T-20260921-145025-meiv-rj11aq`)
- **Projet** : `ecosystem`
- **Type** : `feature` — **un seul plan** (objectifs interdépendants, cf. §0)
- **Repos** (hôtes, pas de workspace Coder) :
  - `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator` (branche de déploiement `feature/migration-postgresql`) → `db.mjs`, `index.mjs`
  - `opencode-observability` = `/root/orchestrator-panel` (branche de déploiement `feature/migration-postgresql`) → `public/app.js` (+ vérif. `pilot.mjs`, `server.mjs`)
- **Branche de travail** : dédiée **par repo** (via `session-guard` / worktree), basée sur `feature/migration-postgresql`. **Jamais** de modification directe de la branche principale.
  ⚠️ **Isolation panneau** : le process PM2 `orchestrator-panel` sert les **statiques du working tree** `/root/orchestrator-panel`. Ne **jamais** laisser ce checkout sur une branche de travail ; ne **pas** redémarrer le PM2 live pendant le build (vérifier sur une instance de test `PORT=4010`, cf. A010).
- **Périmètre réservé (scope)** : `db.mjs`, `index.mjs` (registre) ; `public/app.js`, `pilot.mjs` (panneau).
  **Périmètre NON modifié, vérifié** : `pilot.mjs` (`listRules` l.838-846) et `server.mjs` (route `GET /api/rules` l.2027-2038) sont de **purs passe-plats** (`taskOrchestrator("rule_list", …)` → `sendJson({ rules: r.rules })`) : le nouveau champ additif `roles` **traverse sans modification**. Aucune écriture n'y est donc planifiée (vérification d'ancrage, pas une omission).
- **Racine des plans** : `/root/.config/opencode/mcp/task-orchestrator`
- **Tâche liée (source)** : `T-20260921-140612-t8ub` (relation `emergent`). **Nature de la liaison** : c'est là qu'a été livrée l'**optimisation de performance** de cet onglet — suppression du N+1 de 55 requêtes (index des liens dérivé du payload) et réduction du coût fixe par appel MCP (`schema_meta` + client MCP persistant), via `featureLinkCounts()`/`ruleLinkCounts()` (`db.mjs` l.2013-2058) et le champ additif `links` porté par `feature_list`/`rule_list` (commit `b77cbeb`, plan `Plan-panneau-perf-fr-nplus1-mcp-20260921-141337.md`, étapes **A004/A006/A007**). Le présent plan **étend ce mécanisme existant** (même requête bulk, même esprit additif) — il ne le réécrit pas et **ne doit pas le dégrader**.
- **Tâche liée (amont)** : `T-20260921-120633-mtl2` (relation `emergent` de la tâche liée) — c'est là qu'a été livré le sous-onglet Fonctionnalités/Règles, son filtre rôle côté Fonctionnalités (`#fr-f-role`) et les filtres « sans lien » (plan `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443.md`).
- **ADR** : `adr_list({ projectId: 'ecosystem' })` → **0 ADR** au registre sur ce projet. **Aucune ADR Accepté n'est contredite.**
- **Date** : 2026-09-21 14:51:46

---

## 0. Pourquoi UN SEUL plan (segmentation des objectifs)

Quatre objectifs ont été identifiés :

| # | Objectif | Interdépendance |
|---|---|---|
| O1 | **MCP** : exposer `rules[].roles` (rôles distincts des fonctionnalités liées), **sans N+1** | Contrat de données **requis** par O2 |
| O2 | **Panneau / Règles** : select « Rôle : tous » + filtrage CLIENT + persistance | **Dépend de O1** (sans `roles`, le filtre est vide) |
| O3 | **Panneau / Fonctionnalités** : conserver le filtre rôle existant + homogénéiser | Touche le **même fichier** `public/app.js` que O2 |
| O4 | **Non-régression & performance** : filtres, tri, index des liens, badges, compteurs, `node --check`, spawn MCP réel | Critère d'acceptation **commun** à O1+O2+O3 |

- **O2 dépend de O1** (le filtre consomme le champ produit par O1) ⇒ objectifs **interdépendants**.
- **O2 et O3 modifient le même fichier `public/app.js`** ⇒ non parallélisables (un 2ᵉ plan créerait un conflit d'écriture que la matrice de conflit du batch signalerait).
- **O4 est le verdict conjoint** des trois autres (le critère d'acceptation « non-régression » porte sur l'ensemble).

⇒ **Un plan unique**, avec un chantier « contrat MCP » (O1) ordonné avant le chantier « panneau » (O2/O3), puis une phase de vérification (O4). Règle appliquée : « des objectifs interdépendants = un seul plan ».

---

## 1. Objectif

Ajouter un **filtre par rôle** dans les **deux** sous-onglets de l'onglet « Fonctionnalités & Règles » du panneau, en définissant le rôle d'une **règle métier** comme **l'ensemble des rôles de ses fonctionnalités liées** (`fonctionnalite_regles` ⨝ `fonctionnalites.role`), avec une option **« Sans rôle »** pour les règles sans fonctionnalité liée (ou liées uniquement à des fonctionnalités sans rôle) — le tout **exposé par le MCP en une seule requête** (champ additif `roles`), **filtré côté client** dans le panneau, **sans aucun N+1** et **sans dégrader** l'optimisation de performance récemment livrée (`links` en 1 requête, client MCP persistant, `schema_meta`).

---

## 2. Contexte & raison d'être

### 2.1 État vérifié dans le code (ancrage obligatoire)

**a) Le sous-onglet Fonctionnalités a DÉJÀ un filtre rôle — à conserver.**
- `renderFrFeaturePanel` (`public/app.js` **l.5380-5444**) : `const roles = [...new Set((features||[]).map((x) => x.role).filter(Boolean))].sort();` (**l.5384**) puis `<select id="fr-f-role">` avec `<option value="">Rôle : tous</option>` + un `<option>` par rôle (**l.5390-5393**).
- `frFilterFeatures` (**l.5282-5305**) : `if (f.role && (x.role || '') !== f.role) return false;` (**l.5289**).
- Persistance : `frFeatureFilters = { q, role, emergent, link, impl }` (**l.4964**) + `rerender` (**l.5422-5436**) + listeners `['fr-f-q','fr-f-role',…]` (**l.5437-5440**). **Ce dispositif fonctionne et doit rester inchangé dans son principe.**

**b) Le sous-onglet Règles métier n'a AUCUN filtre rôle.**
- `renderFrRulePanel` (**l.5449-5505**) : toolbar = `#fr-r-q` (recherche), `#fr-r-emergent`, `#fr-r-impl`, `#fr-r-link` — **pas de select rôle**.
- `frFilterRules` (**l.5310-5330**) : `filter = { q, emergent, link, impl }` (commentaire l.5308) — **aucune clause rôle**.
- `frRuleFilters = { q, emergent, link, impl }` (**l.4965**) — **aucune clé `role`**.

**c) La table `regles_metier` n'a PAS de colonne `role`** (`schema.sql` **l.721-733**) : le rôle ne peut donc PAS être lu sur la règle — il **dérive** des fonctionnalités liées.

**d) Le lien règle↔fonctionnalité et le rôle sont bien en base.**
- `fonctionnalites.role TEXT` (`schema.sql` **l.695**) — « rôle ("En tant que <rôle>") ».
- `fonctionnalite_regles (fonctionnalite_id, regle_id)` (`schema.sql` **l.779-783**) + `CREATE INDEX idx_fonctionnalite_regles_regle ON fonctionnalite_regles(regle_id)` (**l.784**) ⇒ la sous-requête corrélée par `regle_id` est **indexée**.

**e) Le mécanisme « 1 requête » à étendre (issu de T-20260921-140612-t8ub).**
- `ruleLinkCounts(ids)` (`db.mjs` **l.2043-2058**) : **une** requête `SELECT … FROM unnest($1::text[]) AS i(id)` + **2 sous-requêtes scalaires** `count(*)` (`fonctionnalite_regles`, `sprint_regles`) → `{ [id]: { features, sprints } }`.
- `listRules()` (`db.mjs` **l.2230-2256**) : après `rows.map(rowToRegle)`, `const counts = await ruleLinkCounts(rules.map((r) => r.id));` (**l.2251**) puis fusion additive `links` (**l.2252-2255**).
- `featureLinkCounts(ids)` (**l.2013-2039**) est le pendant côté fonctionnalités (non touché).
- `index.mjs` : tool `rule_list` (**l.1053-1066**), description documentant `links` (**l.1054**) ; **`inputSchema` inchangé** (aucun nouveau paramètre n'est nécessaire).
- Côté panneau, l'index des liens est **dérivé du payload** (`buildFeatureRuleLinkIndex`, **l.5192-5199**, appelé **l.5546**) : **0 appel réseau supplémentaire**. Toute donnée ajoutée au payload des listes suit ce chemin **sans coût**.

### 2.2 Définition retenue (validée par la demande)

> **Le « rôle » d'une règle métier = l'ensemble des rôles distincts de ses fonctionnalités liées** (`fonctionnalite_regles` ⨝ `fonctionnalites.role`).
> - Règle **sans fonctionnalité liée** ⇒ `roles = []` ⇒ option **« Sans rôle »**.
> - Règle liée **uniquement** à des fonctionnalités dont `role` est `NULL`/vide ⇒ `roles = []` ⇒ **« Sans rôle »** (cohérent avec `.filter(Boolean)` utilisé côté Fonctionnalités).
> - Une règle peut donc apparaître sous **plusieurs** rôles ; le filtre retient la règle si **au moins un** de ses rôles correspond.

### 2.3 Choix de conception tranchés (à respecter par l'exécution)

1. **Extension de `ruleLinkCounts` (1 requête), PAS de nouveau tool ni de nouveau helper.** Les rôles sont calculés par une **3ᵉ sous-requête scalaire** `array_agg(DISTINCT f.role)` ajoutée à la requête `unnest` **existante** : **1 aller-retour**, **0 requête par règle** ⇒ le mécanisme anti-N+1 de T-20260921-140612-t8ub est **réutilisé tel quel**, pas contourné. *Alternative écartée* : un helper `ruleRoleList(ids)` séparé (2ᵉ requête — inutile) ou un tool bulk dédié (1 tool + 1 route + 1 appel réseau en plus).
2. **Champ additif `roles: string[]` sur chaque règle, `links` INCHANGÉ.** `links` garde **exactement** sa forme `{ features, sprints }` (la colonne « Liens » et les filtres « sans lien » en dépendent : `frLinkCellHtml` l.5201, `frFilterRules` l.5323-5327) ⇒ **zéro régression** sur l'existant ; `roles` est un champ **nouveau**, ignoré par les consommateurs actuels.
3. **Défauts explicites.** `roles` absent/`null` en SQL ⇒ `[]` en JS (`|| []`). Le défaut de repli de `listRules` devient `{ features: 0, sprints: 0, roles: [] }` (au lieu de `{ features: 0, sprints: 0 }`) : `links` reste correct par extraction explicite des deux clés.
4. **Dérivation SQL exacte** :
   ```sql
   (SELECT array_agg(DISTINCT f.role)
      FROM fonctionnalite_regles x
      JOIN fonctionnalites f ON f.id = x.fonctionnalite_id
     WHERE x.regle_id = i.id AND f.role IS NOT NULL AND f.role <> '') AS roles
   ```
   Tri/dédup déterministes assurés en JS (`Array.from(new Set(...)).sort()`) ⇒ **sortie stable** (testable, options de select stables).
5. **Filtrage CLIENT (comme les autres filtres), pas de filtrage serveur.** Cohérent avec `frFilterFeatures`/`frFilterRules` (filtrage pur, seule la table est re-rendue au changement ⇒ **la saisie de recherche garde le focus**). Aucun paramètre ajouté à `rule_list`/`feature_list`/`/api/rules` : la liste complète du projet est déjà chargée par `renderFeaturesRules` (**l.5523**).
6. **Sentinelle `__none__` pour « Sans rôle »** (valeur qui ne peut pas être un rôle réel) — utilisée **identiquement** dans les deux sous-onglets ⇒ **homogénéité** du contrat de filtre.
7. **Option « Sans rôle » toujours présente** dans les deux selects (rendu déterministe, indépendant de la présence effective de règles/fonctionnalités sans rôle) ; les autres options = **rôles distincts réellement présents** dans les entités du projet (côté règles : union des `rules[].roles` ; côté fonctionnalités : comportement existant conservé).
8. **Position homogène du select** : immédiatement **après** l'input de recherche (`#fr-f-q` / `#fr-r-q`) et **avant** le select d'émergence — c'est déjà la position de `#fr-f-role` (l.5390) ; le select des règles s'y aligne.
9. **Aucun changement de `pilot.mjs` / `server.mjs`** (passe-plats vérifiés §2.1e) : le champ additif traverse la route `GET /api/rules` sans code.
10. **Aucune écriture en base, aucune DDL, aucune migration** : le plan est **100 % lecture** côté registre ⇒ `schema_meta`/`SCHEMA_VERSION` **non concernés** (pas de bump nécessaire, le schéma ne change pas).

### 2.4 Objectifs mesurables (non-régression de la performance)

| Métrique | Avant (référence T-20260921-140612-t8ub) | Après (cible) |
|---|---|---|
| Requêtes SQL pour `rule_list` | **1** (`ruleLinkCounts`) | **1** (inchangé — sous-requête ajoutée dans la même requête) |
| Requêtes SQL par règle (N+1) | **0** | **0** |
| Appels réseau pour l'onglet FR | **8** (inchangé, `renderFeaturesRules` l.5521-5530) | **8** (inchangé) |
| Coût de la sous-requête `roles` | — | **négligeable** (index `idx_fonctionnalite_regles_regle`, 10 règles sur `myxmax`) |

---

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|---|---|---|---|---|---|---|
| A001 | modifier | `ruleLinkCounts(ids)` (l.2043-2058) : ajouter à la requête `unnest` **existante** une 3ᵉ sous-requête scalaire `array_agg(DISTINCT f.role)` (`fonctionnalite_regles x JOIN fonctionnalites f` sur `x.regle_id = i.id`, `f.role IS NOT NULL AND f.role <> ''`) ; retour `{ [id]: { features, sprints, roles } }` avec `roles` normalisé (`[]` si `null`, dédup + `sort()`) | `db.mjs` | `db.mjs` | Exposer les rôles **dans la même requête** que les compteurs ⇒ **0 N+1** (AC4) | `ruleLinkCounts` renvoie `roles: string[]` |
| A002 | modifier | `listRules()` (l.2230-2256) : après `ruleLinkCounts`, conserver `links` **strictement inchangé** (`{ features: c.features, sprints: c.sprints }`) et ajouter le champ **additif** `roles: c.roles \|\| []` ; défaut de repli `{ features: 0, sprints: 0, roles: [] }` | `db.mjs` | `db.mjs` | Porter le rôle avec la liste (⇒ **0 appel** côté panneau, comme `links`) | `rule_list` renvoie `rules[].roles` |
| A003 | modifier | description du tool `rule_list` (l.1054) : documenter le champ **additif** `roles` (rôles distincts des fonctionnalités liées via `fonctionnalite_regles` ; `[]` = aucune fonctionnalité liée ou rôles vides ⇒ « Sans rôle ») ; **`inputSchema` inchangé** | `index.mjs` | `index.mjs` | Rendre le contrat lisible par les agents (aucun changement d'entrée) | Description `rule_list` à jour |
| A004 | modifier | `frRuleFilters` (l.4965) : `{ q: '', role: '', emergent: '', link: '', impl: '' }` | `public/app.js` | `public/app.js` | Persister le nouveau filtre comme les autres | État de filtre règles avec `role` |
| A005 | modifier | `frFilterRules(rules, filter, linkIndex)` (l.5310-5330) : ajouter la clause rôle — `__none__` ⇒ `if ((x.roles \|\| []).length) return false;` ; sinon `if (f.role && !(x.roles \|\| []).includes(f.role)) return false;` + mettre à jour le commentaire d'entrée (l.5308) | `public/app.js` | `public/app.js` | Appliquer le filtre rôle **CLIENT** (cohérent avec les autres filtres) | `frFilterRules` filtre par rôle |
| A006 | modifier | `renderFrRulePanel()` (l.5449-5505) : (a) calculer `const roles = [...new Set((rules \|\| []).flatMap((x) => x.roles \|\| []))].sort();` ; (b) insérer `<select id="fr-r-role">` **après `#fr-r-q`** — options `Rôle : tous` (`''`), chaque rôle, `Sans rôle` (`__none__`) avec `selected` depuis `f.role` ; (c) persister `role` dans `rerender` (l.5485-5490) ; (d) ajouter `'fr-r-role'` au tableau des listeners (l.5498) | `public/app.js` | `public/app.js` | UI + application + persistance du filtre côté Règles | Select `#fr-r-role` opérationnel |
| A007 | modifier | `frFilterFeatures(features, filter, linkIndex)` (l.5282-5305) : étendre la clause rôle existante (l.5289) à la sentinelle — `if (f.role === '__none__') { if ((x.role \|\| '') !== '') return false; } else if (f.role && (x.role \|\| '') !== f.role) return false;` | `public/app.js` | `public/app.js` | **Conserver** le filtre rôle existant (AC2) tout en **homogénéisant** la sémantique « Sans rôle » | Filtre rôle Fonctionnalités préservé + `__none__` |
| A008 | modifier | `renderFrFeaturePanel()` (l.5390-5393) : ajouter `<option value="__none__" ${f.role === '__none__' ? 'selected' : ''}>Sans rôle</option>` **après** les options de rôles du select `#fr-f-role` | `public/app.js` | `public/app.js` | Homogénéiser libellé/options/position avec le sous-onglet Règles | `#fr-f-role` avec option « Sans rôle » |
| A009 | exécuter | **Vérifications statiques + MCP réel** : `node --check db.mjs index.mjs` (registre) et `node --check public/app.js pilot.mjs server.mjs` (panneau) ; spawn MCP réel avec `MCP_TASK_ORCHESTRATOR_PATH=<worktree registre>/index.mjs` → `rule_list({ projectId: '<projet avec règles>' })` : `rules[].roles` présent (tableau) et **cohérent** avec `rule_get` (rôles des `fonctionnalites` liées) sur 2-3 règles échantillon, `links` **inchangé** ; mesurer le **nombre d'appels** (1) et le temps (pas de dégradation vs `rule_list` avant) | — | — | Prouver AC1/AC3/AC4 (données + non-régression + perf) | Sortie des checks + JSON `rule_list` avec `roles` |
| A010 | exécuter | **Vérification d'intégration panneau sur instance de TEST** : depuis le worktree panneau, `PORT=4010 MCP_TASK_ORCHESTRATOR_PATH=<worktree registre>/index.mjs node server.mjs` → `curl '/api/rules?projectId=<projet>'` : chaque règle expose `roles` ; charger l'onglet et vérifier : (i) `#fr-r-role` présent avec options = rôles distincts + `Sans rôle`, (ii) le filtrage rôle agit (règle multi-rôles visible sous chacun, règle sans fonctionnalité sous `Sans rôle`), (iii) les **autres filtres, le tri, les badges, l'index des liens et les compteurs** sont intacts, (iv) `#fr-f-role` fonctionne toujours (+ `Sans rôle`). **NE PAS** redémarrer le PM2 live ni laisser `/root/orchestrator-panel` sur une branche de travail | — | — | Prouver AC1/AC2/AC5 de bout en bout | Mesures/observations d'intégration |
| A011 | créer | rapport `reports/report-filtre-role-fr-<ts>.md` : définition retenue, commandes exactes, preuve `rules[].roles`, tableau de non-régression, note de déploiement (**registre → panneau → `pm2 restart orchestrator-panel`**) | — | `reports/report-filtre-role-fr-<ts>.md` | Traçabilité de la vérification (AC5) | Rapport de vérification |

---

## 4. Fichiers concernés

| Fichier | Repo | Type de modification |
|---|---|---|
| `db.mjs` | registre | modification (`ruleLinkCounts` l.2043-2058 ; `listRules` l.2230-2256) |
| `index.mjs` | registre | modification (description `rule_list` l.1054 ; `inputSchema` **inchangé**) |
| `public/app.js` | panneau | modification (`frRuleFilters` l.4965 ; `frFilterRules` l.5310-5330 ; `renderFrRulePanel` l.5449-5505 ; `frFilterFeatures` l.5282-5305 ; `renderFrFeaturePanel` l.5390-5393) |
| `pilot.mjs` | panneau | **aucune modification** (passe-plat vérifié : `listRules` l.838-846) |
| `server.mjs` | panneau | **aucune modification** (passe-plat vérifié : `GET /api/rules` l.2027-2038) |
| `schema.sql` | registre | **aucune modification** (pas de DDL : le rôle dérive des tables existantes) |
| `reports/report-filtre-role-fr-<ts>.md` | registre | **création** |
| `plans/Plan-filtre-role-fonctionnalites-regles-20260921-145146.md` | registre | **création** (ce plan) |

**Aucune suppression de fichier.** Aucune table/colonne supprimée, aucune signature modifiée, aucune DDL.

---

## 5. Livrables attendus

1. `rule_list` renvoie, pour chaque règle, un champ **additif** `roles: string[]` (rôles distincts de ses fonctionnalités liées), calculé **dans la même requête bulk** que `links` ⇒ **1 requête**, **0 N+1**.
2. `links` (`{ features, sprints }`) **inchangé** ⇒ colonne « Liens » et filtres « sans lien » intacts.
3. `public/app.js` : sous-onglet **Règles métier** doté d'un select **`#fr-r-role`** (« Rôle : tous » + rôles distincts + « Sans rôle »), filtrant côté client via `frFilterRules`, persisté dans `frRuleFilters.role`.
4. `public/app.js` : sous-onglet **Fonctionnalités** — filtre rôle existant **conservé et fonctionnel**, complété de l'option « Sans rôle » (homogénéisation), libellé/position alignés sur le sous-onglet Règles.
5. **Non-régression** : `node --check` OK sur `db.mjs`, `index.mjs`, `public/app.js`, `pilot.mjs`, `server.mjs` ; spawn MCP réel OK ; autres filtres/tri/badges/compteurs inchangés ; **performance préservée** (nombre d'appels et de requêtes SQL identique).
6. `reports/report-filtre-role-fr-<ts>.md` : preuve de vérification + note de déploiement.

---

## 6. Ordre & dépendances

```
A001 (ruleLinkCounts.roles — 1 requête)  →  A002 (listRules.roles)  →  A003 (desc rule_list)
                                                │
                                                ▼   (le panneau consomme `rules[].roles`)
A004 (frRuleFilters.role)  →  A005 (frFilterRules rôle)  →  A006 (select #fr-r-role)

A007 (frFilterFeatures `__none__`)  →  A008 (option « Sans rôle » #fr-f-role)     ← indépendant de A004-A006
                                                │
                                                ▼
A009 (node --check + spawn MCP réel + cohérence roles/links + perf)
                                                ▼
A010 (instance panneau TEST PORT=4010 → UI + non-régression)
                                                ▼
A011 (rapport de vérification)
```

**Prérequis explicites** : A002 ⟸ A001 · A003 ⟸ A002 (documente un champ produit par A002) · A006 ⟸ A005 ⟸ A004 · A008 ⟸ A007 · A009 ⟸ {A002, A003, A005, A006, A007, A008} · A010 ⟸ A009 · A011 ⟸ A010.
**Indépendances parallélisables** : {A001→A002→A003} ∥ {A004→A005→A006} ∥ {A007→A008} — mais **toutes** précèdent A009.

---

## 7. Couverture des objectifs (100 %)

| Exigence (critère d'acceptation / demande) | Étape(s) | Couvert ? |
|---|---|---|
| **AC1** — le sous-onglet Règles propose un select « Rôle » (options = rôles distincts des fonctionnalités liées aux règles du projet + « Sans rôle ») et le filtrage est appliqué | A001, A002 (données), A004, A005, A006 (UI + filtrage + persistance) | ✅ |
| **AC2** — le sous-onglet Fonctionnalités **conserve** son filtre rôle existant (non-régression vérifiée) | A007, A008 (conservation + homogénéisation), A010-iv (vérif. UI) | ✅ |
| **AC3** — le rôle d'une règle est **dérivé** des rôles de ses fonctionnalités liées (`fonctionnalite_regles`) ; une règle **sans fonctionnalité liée** tombe dans « Sans rôle » | A001 (dérivation SQL `fonctionnalite_regles` ⨝ `fonctionnalites.role`), A002, A005 (`__none__`), A006 (option « Sans rôle ») | ✅ |
| **AC4** — performance préservée : **aucun N+1** (les rôles sont obtenus dans la requête/liste existante) | A001 (sous-requête dans la **même** requête `unnest`), A002 (porté par la liste déjà chargée), §2.3-1/§2.4, A009 (mesure) | ✅ |
| **AC5** — non-régression : autres filtres, tri, index des liens, badges d'état et compteurs inchangés ; `node --check` OK ; spawn MCP réel OK | A002 (`links` inchangé), A005/A006 (filtres additifs), A007/A008 (filtre existant conservé), A009 (`node --check` + spawn MCP réel + cohérence `links`), A010 (UI + non-régression), A011 | ✅ |
| **Demande 1 (MCP)** — exposer les rôles pour chaque règle, même aller-retour que `links`, sans N+1 | A001, A002, A003 | ✅ |
| **Demande 2 (Panneau Règles)** — select « Rôle : tous » + option « Sans rôle », appliqué par `frFilterRules`, persisté avec `frRuleFilters` | A004, A005, A006 | ✅ |
| **Demande 3 (Fonctionnalités)** — conserver le filtre rôle, homogénéiser libellé/position | A007, A008, A006-b (position homogène), A010-iv | ✅ |
| **Cadre — isolation** : branche de travail dédiée par repo, jamais la branche principale, checkout principal `/root/orchestrator-panel` jamais laissé sur une branche de travail | En-tête (norme) + A010 (interdiction de toucher au PM2 live / au checkout principal) | ✅ |
| **Cadre — traçabilité** : `task_event` + `plan_register(taskId=…)` + `artifact_add(kind=plan)` | Phase 8 (faite par le planificateur) | ✅ |

**Aucune exigence non couverte.** Pas de hors-périmètre déclaré (les points « aucune modification de `pilot.mjs`/`server.mjs`/`schema.sql` » sont des **vérifications d'ancrage**, pas des exigences écartées).

---

## 8. Vérification de cohérence

### 8.1 Intra-plan (Phase 6)

Regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `db.mjs` → `ruleLinkCounts()` (l.2043-2058) | A001 seule | ✅ |
| `db.mjs` → `listRules()` (l.2230-2256) | A002 seule | ✅ |
| `index.mjs` → description `rule_list` (l.1054) | A003 seule | ✅ |
| `public/app.js` → `frRuleFilters` (l.4965) | A004 seule | ✅ |
| `public/app.js` → `frFilterRules()` (l.5310-5330) | A005 seule | ✅ |
| `public/app.js` → `renderFrRulePanel()` (l.5449-5505) | A006 seule | ✅ |
| `public/app.js` → `frFilterFeatures()` (l.5282-5305) | A007 seule | ✅ |
| `public/app.js` → `renderFrFeaturePanel()` (l.5390-5393) | A008 seule | ✅ |

Contrôles de contradiction :
- **Aucune action `supprimer`** dans le plan ⇒ pas de conflit `supprimer` + autre action ; **aucun `renommer`** ⇒ pas de `créer`+`renommer` à fusionner ; **aucun `déplacer`** ⇒ pas de conflit `déplacer`+`supprimer`.
- **Aucun écrasement mutuel** : A004 (déclaration `frRuleFilters`) est distinct de A005 (fonction pure) et A006 (renderer) — trois éléments **différents** du même fichier, modifiés **séquentiellement** (A004 → A005 → A006), sans recouvrement de lignes (l.4965 / l.5310-5330 / l.5449-5505).
- **A007/A008 ne touchent pas** les éléments de A004-A006 (`frFilterFeatures` et `renderFrFeaturePanel` sont des éléments **distincts** de `frFilterRules`/`renderFrRulePanel`/`frRuleFilters`) ⇒ pas de conflit, mais **séquentialisation conservée** (même fichier).
- **Aucune lecture d'un élément créé par une étape ultérieure** : A002 lit `counts[r.id].roles` **produit par A001** (A001 → A002 ✅) ; A003 documente un champ **produit par A002** (A002 → A003 ✅) ; A005 lit `x.roles` **produit par A002** et **transporté** par la route existante (A002 → A005 ✅, dépendance inter-repos) ; A006 lit `x.roles` (idem) et `f.role` **déclaré par A004** (A004 → A006 ✅) ; A008 lit `f.role === '__none__'` **implémenté par A007** (A007 → A008 ✅).
- **Point d'attention levé** : `links` est **explicitement ré-extrait** (`{ features: c.features, sprints: c.sprints }`) en A002 — sans cela, l'ajout de `roles` au même objet `counts` aurait pu faire **fuiter** `roles` dans `links` et modifier le contrat existant (aurait été une régression silencieuse). Contrainte **inscrite dans l'étape**.
- **Point d'attention levé** : A007 **conserve** la clause rôle existante (l.5289) au lieu de la remplacer ⇒ AC2 (non-régression) est structurellement garantie ; l'ajout de `__none__` est **additif**.

### 8.2 Plan Validator (Phase 7) — gate

- Contradiction non résolue : **aucune** ✅
- Exigence non couverte : **aucune** (§7) ✅
- Étape vague/imprécise : **aucune** (chaque étape = 1 verbe × 1 élément × 1 fichier, avec lignes, raison et livrable) ✅
- **Verdict : Valid** → Phase 8.

### 8.3 Globale (Phase 9)

**Un seul plan produit** ⇒ aucune contradiction inter-plans possible. Vérifié tout de même : les fichiers touchés sont répartis sur **deux repos** (`db.mjs`/`index.mjs` vs `public/app.js`) et **aucun fichier n'est partagé entre deux plans** (il n'y a qu'un plan). Aucune région de fichier modifiée par deux étapes en conflit (§8.1).

---

## 9. Risques & notes

| Risque | Mitigation prévue dans le plan |
|---|---|
| **Régression du contrat `links`** (ajout de `roles` dans le même objet `counts`) | A002 ré-extrait **explicitement** `{ features, sprints }` pour `links` ; vérification de cohérence en A009 |
| **Réintroduction d'un N+1** | A001 ajoute une **sous-requête** à la requête `unnest` **existante** (1 aller-retour) ; aucune boucle, aucun `rule_get` par règle ; mesure du nombre d'appels en A009 |
| **Dégradation de la perf de `rule_list`** (sous-requête corrélée) | Index `idx_fonctionnalite_regles_regle` (schema.sql l.784) ; coût négligeable (10 règles sur `myxmax`) ; mesure en A009 |
| **Règle liée à des fonctionnalités sans rôle** ⇒ « Sans rôle » alors qu'elle a des fonctionnalités | **Comportement voulu** et documenté (§2.2) : le rôle est celui des fonctionnalités ; l'option « Sans rôle » couvre ce cas ; A010 vérifie l'affichage |
| **Sentinelle `__none__` collisionnant avec un rôle réel** | Valeur non naturelle ; risque négligeable, documenté en §2.3-6 |
| **Option « Sans rôle » toujours affichée alors qu'aucune entité n'est concernée** | Choix assumé (§2.3-7) : rendu déterministe ; libellé explicite |
| **Déploiement panneau avant registre** (`rules[].roles` absent) | Repli **non bloquant** : `x.roles || []` ⇒ toutes les règles en « Sans rôle » (aucune erreur, aucun crash). **Ordre recommandé** : registre → panneau → `pm2 restart orchestrator-panel` |
| **Redémarrage du PM2 live pendant le build** | Interdit : vérification sur **instance de test `PORT=4010`** avec `MCP_TASK_ORCHESTRATOR_PATH` pointant le worktree (A010) |
| **Checkout principal laissé sur une branche de travail** | Travail en **worktree** ; `/root/orchestrator-panel` reste sur `feature/migration-postgresql` (le panneau live sert ses statiques) |
| **Filtres non persistés au rechargement** | Comportement **existant** de tous les filtres de l'onglet (`frFeatureFilters`/`frRuleFilters` sont en mémoire) : le nouveau filtre suit **le même contrat** (aucune régression, aucune nouveauté de persistance introduite) |
| **Affichage du rôle dans la table des règles** (hors demande) | **Non planifié** (discipline de périmètre). Piste de suivi éventuelle : colonne « Rôle(s) » dans `frRuleTableHtml` — à traiter dans une tâche dédiée si souhaité |

---

## 10. Tests E2E Playwright — analyse d'impact

**Verdict : E2E NA.**

- `e2e_list({ project: 'ecosystem' })` → **0 test** enregistré.
- Le repo `opencode-observability` (`/root/orchestrator-panel`) **ne contient aucun `playwright.config.*`, aucun dossier `tests/`, aucun spec Playwright** (vérifié : seuls `scripts/bench-fr-load.mjs` et le code serveur/panneau) ; le repo `opencode-mcp-task-orchestrator` non plus.
- La tâche est de nature **outillage interne** (panneau d'observabilité + registre MCP), **sans harnais Playwright** ⇒ un scénario serait **inexécutable**. **Aucune création « en aveugle »** : pas de `e2e_test_register`, pas de `e2e_test_link`.
- **Substitut de vérification retenu** (explicité, traçable) : A009 (`node --check` + spawn MCP réel + cohérence `roles`/`links` + mesure de perf) et A010 (instance panneau de TEST `PORT=4010` : présence et action du select `#fr-r-role`, non-régression des autres filtres/tri/badges/compteurs, filtre rôle Fonctionnalités toujours fonctionnel).

---

## 11. Récapitulatif des choix de conception

1. **Rôle d'une règle = union des rôles de ses fonctionnalités liées** (`fonctionnalite_regles` ⨝ `fonctionnalites.role`), rôles vides/`NULL` exclus ⇒ « Sans rôle » si l'union est vide (pas de fonctionnalité liée **ou** fonctionnalités sans rôle).
2. **Exposition MCP additive** : `rules[].roles: string[]` à côté de `links`, **dans la même requête bulk** (`ruleLinkCounts` étendu) — **0 nouveau tool, 0 nouvelle route, 0 nouvel appel réseau, 0 N+1**.
3. **`links` strictement inchangé** (`{ features, sprints }`) ⇒ non-régression de la colonne « Liens » et des filtres « sans lien ».
4. **Filtrage CLIENT** dans le panneau (`frFilterRules`), cohérent avec les autres filtres ; seule la table est re-rendue ⇒ le focus de recherche est préservé.
5. **Sentinelle `__none__`** pour « Sans rôle », **identique dans les deux sous-onglets** (homogénéité) ; option toujours présente, position du select alignée (`après` la recherche).
6. **Filtre rôle des Fonctionnalités conservé** et simplement enrichi de l'option « Sans rôle » (aucune réécriture).
7. **Aucune modification** de `pilot.mjs`/`server.mjs` (passe-plats vérifiés) ni de `schema.sql` (aucune DDL, aucun bump de `SCHEMA_VERSION`).
8. **Aucune dégradation de l'optimisation** T-20260921-140612-t8ub : même requête bulk, même client MCP persistant, même payload dérivé (`buildFeatureRuleLinkIndex`), même nombre d'appels (8 pour l'onglet).
