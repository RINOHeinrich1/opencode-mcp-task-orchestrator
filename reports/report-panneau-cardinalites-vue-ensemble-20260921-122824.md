# Rapport d'exécution — Plan `Plan-panneau-cardinalites-vue-ensemble-20260921-120900`

- **Tâche** : `T-20260921-120633-mtl2` (exécution `E-T-20260921-120633-mtl2-jai3ti`)
- **Projet** : `ecosystem` — repo `opencode-observability` → `/root/orchestrator-panel`
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 12:28 (UTC)
- **Branche** : `build-notify/panneau-cardinalites-vue-ensemble`
- **Commit** : `3d82e751638476aa9f3e8a15c91c42d5c1a19afc`
- **Base** : `feature/migration-postgresql` @ `5299d4c70241d80bd8213eb1f584eff8ee2150ef`

---

## 1. Résumé

**Demandé** — implémenter les 13 étapes (A001–A013) du plan 1 : retirer l'onglet
« Émergents », déplacer les cardinalités dans la **Vue d'ensemble** sous forme de
**10 cartes statistiques cliquables** (compteurs de `GET /api/cardinality`), ajouter
un **point d'entrée discret** vers les signaux (clôture tracée), ajouter les
**filtres cibles** manquants sur Tâches / Recettes / Sprints / ADR, styler les cartes.

**Fait** — les 13 étapes sont **terminées** (avancement plan : **13/13 = 100 %**).
L'onglet « Émergents » a disparu de la navigation, ses cardinalités sont devenues
10 cartes cliquables dans la Vue d'ensemble ; chaque clic ouvre l'onglet cible avec
le **filtre pré-appliqué et visible** (select persistant) et la liste **réellement
filtrée** par id-set issu du registre. Les signaux restent accessibles via un bouton
discret ouvrant une **modale** (clôture à résolution obligatoire). Aucune nouvelle
route de données : `GET /api/cardinality` et
`POST /api/cardinality/signals/:id/resolve` sont **réutilisées telles quelles**
(`server.mjs` / `pilot.mjs` **non modifiés**).

## 2. Isolation

- **Espace Coder** : le repo `opencode-observability` (`/root/orchestrator-panel`) est
  un **composant d'infrastructure — le panneau de supervision lui-même** — présent
  **uniquement sur l'hôte**. Vérification : `workspace_list` (7 workspaces Coder :
  madatalk, ONIRIA, myxmax, affelyos, admin-myxmax, ia-crm-frontend, ia-crm-api) →
  **aucun ne contient ce repo**. Conformément à la norme (dérogation documentée pour
  un composant d'infrastructure), le travail a été fait sur l'hôte, et non
  silencieusement (voir §8).
- **session-guard** : `acquire --dir /root/orchestrator-panel` → `mode: in-place`
  (aucune session parallèle détectée). Afin de respecter la consigne « branche de
  travail dédiée, jamais de commit sur `feature/migration-postgresql` »,
  `worktree --branch build-notify/panneau-cardinalites-vue-ensemble` a été utilisé.
  - worktree : `/root/orchestrator-panel-wt-panneau-cardinalites-vue-ensemble`
  - branche : `build-notify/panneau-cardinalites-vue-ensemble` (base `5299d4c`)
- **Travail strictement in-worktree** : édition, `node --check`, serveur HTTP de
  contrôle, commit. Le checkout principal n'a **jamais** été modifié
  (`git -C /root/orchestrator-panel status` : propre, toujours sur
  `feature/migration-postgresql` @ `5299d4c`).
- **Fin** : worktree physique retiré + verrou libéré ; **branche conservée**
  (délivrable nécessaire à l'étape d'orchestration ultérieure de merge/push — écart
  volontaire et documenté par rapport à `session-guard remove`, qui supprime aussi la
  branche ; voir §8).

## 3. Branches et commits

| Branche | Commit | Message |
|---|---|---|
| `build-notify/panneau-cardinalites-vue-ensemble` | `3d82e751638476aa9f3e8a15c91c42d5c1a19afc` | `feat(panneau): cardinalités en cartes cliquables dans la Vue d'ensemble — retrait de l'onglet Émergents (A001-A012) (T-20260921-120633-mtl2)` |

Traces de commits enregistrées via le MCP `task-orchestrator` (`plan_commit_add`) :
entrée `id=477` (complète : fichiers + diffs). Voir §8 pour l'entrée `id=478` (doublon vide).

## 4. Traitements effectués (13/13)

| Étape | État | Traitement | Vérification |
|---|---|---|---|
| A001 | done | `['emergents','Émergents']` retiré de `PROJECT_TABS` | nav rendue : « Émergents » absent, 8 autres onglets conservés |
| A002 | done | `emergents: renderEmergents` retiré de `RENDER` | `grep renderEmergents` = 0 |
| A003 | done | `renderEmergents()` + `CARDINALITY_VIEW_LABELS` + bloc commentaire supprimés | `grep` = 0 (hors clé de vue `emergents`) |
| A004 | done | `CARDINALITY_CARDS` (10 × `{view,label,tab,filter}`) + `cardinalityReportCached` (cache 15 s + dédup de promesse) + `cardinalityIdSet`/`cardinalityIdSetFor` | 10 entrées, compteurs conformes |
| A005 | done | `renderOverview` : section « Cardinalités & émergence », 10 cartes `.card.card-link[data-card-view]`, compteurs `counts`, bouton discret `#card-signals-open` ; `wireCardinalityOverview` (dégradation `—`) | 10 cartes, compteurs = `counts`, bouton présent |
| A006 | done | `openCardinalityTarget(view)` près de `goToTab` (filtre + persistance + `switchTab` + `refreshActive`) | 10 cartes → bon onglet |
| A007 | done | `cardinalitySignalsModal()` : signaux en modale, `Clôturer` → `POST /api/cardinality/signals/:id/resolve` avec résolution **obligatoire**, invalidation du cache + re-rendu | modale ouverte, `Clôturer` présent ssi signal ouvert |
| A008 | done | Tâches : `tasksMissingFilter` (+ `localStorage`), `<select id="f-missing">` (Sans ADR / Sans fonctionnalité / Sans sprint / Émergentes), filtre id-set dans `apply()`, handler `change` | select visible + liste filtrée |
| A009 | done | Recettes : `recettesMissingFilter`, `<select id="rec-missing">` (Sans ADR / fonctionnalité / sprint), filtre de `recs` par `recette_id`, handler | select visible + liste filtrée |
| A010 | done | Sprints : `sprintsMissingFilter`, `<select id="sp-missing">` (Sans fonctionnalité / Sans règle métier), filtre de `sprints` avant `rows`, handler | select visible + liste filtrée |
| A011 | done | ADR : `adrFilters.missingFeature` (persisté), `<select id="adr-missing-filter">`, `data-missing` par ligne, prise en compte dans `adrTableHtml` **et** `bindAdrTable.apply()`, chargement de `missingFeatureIds` dans `renderAdrs()` | select visible + liste filtrée |
| A012 | done | `public/style.css` : règles `.card-link` (cursor, hover, `focus-visible`, `font: inherit`, `width: 100%`) | 6 occurrences servies |
| A013 | done | `node --check` + parcours UI + données réelles + HTTP | 139/139 vérifications OK |

## 5. Fichiers modifiés / créés

| Fichier | Nature | Diff |
|---|---|---|
| `public/app.js` | modifié | +237 / −57 |
| `public/style.css` | modifié | +12 / −0 |

**Non modifiés** (vérifié : `git diff 5299d4c -- server.mjs pilot.mjs public/index.html` vide) :
`server.mjs`, `pilot.mjs`, `public/index.html`. Aucun fichier créé/supprimé dans le repo.

Hors repo : rapport de fin de tâche
`/root/.config/opencode/mcp/task-orchestrator/reports/report-panneau-cardinalites-vue-ensemble-20260921-122824.md`.

## 6. Vérifications (A013) — preuves

### 6.1 Syntaxe
- `node --check public/app.js` → **OK**.

### 6.2 Données réelles (`pilot.cardinalityReport({projectId:'ecosystem'})`, même chemin que la route)
10 vues renvoyées, compteurs :

| Vue | Compteur |
|---|---|
| `tache_sans_adr` | 28 |
| `tache_sans_fonctionnalite` | 28 |
| `tache_sans_sprint` | 28 |
| `recette_sans_adr` | 2 |
| `recette_sans_fonctionnalite` | 2 |
| `recette_sans_sprint` | 2 |
| `adr_sans_fonctionnalite` | 0 |
| `sprint_sans_fonctionnalite` | 0 |
| `sprint_sans_regle` | 0 |
| `emergents` | 0 |

Signaux : total 0 / ouverts 0 / résolus 0.

### 6.3 Parcours UI (clic réel sur chaque carte) — `jsdom`, `public/app.js` du worktree
**139 / 139 vérifications OK** (0 échec). Méthode : chargement du livrable dans un
vrai DOM, `fetch` simulé (agrégat `/api/cardinality` **réel** en scénario A,
**synthétique** en scénario B), **clic** sur chaque carte puis assertion sur
(1) l'onglet actif + panneau actif, (2) le **select de filtre visible** portant la
valeur pré-appliquée, (3) le **nombre de lignes réellement affichées** = taille de
l'id-set.

- **Scénario A (données réelles `ecosystem`)** : 10 cartes, compteurs = `counts`,
  chaque carte → bon onglet + `#f-missing`/`#rec-missing`/`#sp-missing`/
  `#adr-missing-filter` visible avec la bonne valeur, lignes affichées = compteur
  (ex. `tache_sans_adr` → 28 lignes, `recette_sans_adr` → 2, `adr_*`/`sprint_*`/
  `emergents` → 0).
- **Scénario B (données synthétiques non vides + leurres)** : ensembles de 2 membres
  + 2 leurres par vue → **exactement 2 lignes affichées par carte** (les leurres sont
  **exclus**), ce qui prouve un filtrage réel et non un « tout ». Cas `emergents` :
  la vue agrège 4 types (2 tâches, 1 fonctionnalité, 1 pièce) → **2 tâches**
  affichées (décision §2.1 du plan : seules les tâches, l'entité porteuse).
- **Point d'entrée discret** : `#card-signals-open` présent ; clic → modale ouverte
  avec la table des signaux ; bouton `Clôturer` présent **si et seulement si** un
  signal est ouvert.
- **Non-régression navigation** : « Émergents » absent de `#tabs` ; « Vue d'ensemble,
  Tâches, Recettes, ADR, Sprints, Fonctionnalités / Règles, Tests E2E, Archives »
  conservés.
- Log complet : `/tmp/opencode/proof-ui.log` (`139/139 vérifications OK`).

### 6.4 HTTP
Serveur du panneau lancé **depuis le worktree** (port 4111, arrêté ensuite) :
- `GET /` → `302` (redirection login) ; `GET /app.js` → `200` (434 971 o) ;
  `GET /style.css` → `200` (46 268 o) ;
- **intégrité** : `cmp` → les octets servis sont **identiques** aux fichiers du worktree ;
- contenu servi : `CARDINALITY_CARDS`, `cardinalityReportCached`, `cardinalityIdSet`,
  `openCardinalityTarget`, `cardinalitySignalsModal`, `card-signals-open`, `card-link`,
  `id="f-missing"`, `id="rec-missing"`, `id="sp-missing"` présents ;
  `renderEmergents`, `CARDINALITY_VIEW_LABELS`, `pane-emergents`,
  `['emergents', 'Émergents']` → **0** ;
- `GET /api/cardinality?projectId=ecosystem` → `401` (route présente, protégée par auth —
  non modifiée).

## 7. Contrôles de non-régression / non-collision avec le plan frère

- Les régions réservées au plan frère
  `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443` — `renderFeaturesRules`,
  `enrichLinkCells` — **n'ont pas été touchées** (aucune modification dans ces zones).
- L'entrée `['features', 'Fonctionnalités / Règles']` de `PROJECT_TABS` est intacte
  (seule la ligne `emergents` a été retirée) → l'édition prévue par le plan frère sur
  cette entrée reste possible.
- Défaut des nouveaux filtres = « tous » → comportement des onglets inchangé sans clic
  sur une carte.
- Défaillance de `/api/cardinality` → dégradation propre : compteurs `—` dans la Vue
  d'ensemble et **liste non filtrée** (jamais vide) dans les pages cibles.

## 8. Avertissements / écarts / anomalies

1. **Repo hôte (dérogation norme)** : `opencode-observability` = le panneau de
   supervision lui-même, absent de tout workspace Coder → travail sur l'hôte
   (dérogation « composant d'infrastructure »), documenté ici et tracé par
   `EXECUTION_STARTED`.
2. **Branche conservée après retrait du worktree** : `session-guard remove` supprime
   aussi la branche, ce qui aurait détruit le livrable. Le worktree physique a été
   retiré (`git worktree remove --force`) et le verrou libéré (`session-guard release`),
   mais la **branche `build-notify/panneau-cardinalites-vue-ensemble` est conservée**
   pour l'étape d'orchestration (merge/push). Aucun push effectué (conforme à la consigne).
3. **Doublon de trace de commit** : la trace du plan contient deux entrées pour le même
   SHA — `id=477` (complète : fichiers + diffs, enregistrée via le client MCP du panneau)
   et `id=478` (vide, créée par un appel `plan_commit_add` redondant avec seulement
   `sha`/`branch`). La trace étant **append-only**, l'entrée vide n'a pas été supprimée.
   L'entrée de référence est **`id=477`**. Aucun impact fonctionnel.
4. **Limitation documentée (plan §9.1)** : la vue `adr_sans_fonctionnalite` est scopée
   projet (`artifact_projects`) alors que l'onglet ADR affiche aussi les ADR des repos
   transverses → lorsqu'un filtre ADR est actif, une ADR rattachée uniquement à un repo
   n'appartient pas à l'ensemble et est masquée. Comportement conforme à la décision du
   plan (aucun recalcul côté panneau).
5. **Écart de numérotation** : le plan annonce la création d'`openCardinalityTarget` en
   A006 « près de `goToTab` » et son câblage en A005 ; l'implémentation respecte cet
   ordre logique (déclaration de fonction hissée, appel au clic). Aucune incohérence
   code ↔ plan détectée — **aucun `INCONSISTENCY_FOUND`**.

## 9. E2E

Aucun test E2E Playwright associé (`e2e_list(project=ecosystem)` = 0 ; le repo panneau
n'a pas de harnais Playwright) → **E2E NA** (décision du plan §9, confirmée). La preuve
de parcours exigée est assurée par §6.3 (parcours UI sur DOM réel).

## 10. Prochaines étapes / recommandations

1. **Exécuter le plan frère** `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443`
   (régions `renderFeaturesRules` / `enrichLinkCells` / entrée `PROJECT_TABS` l.119) —
   aucune collision avec ce plan (exécution séquentielle respectée).
2. **Étape d'orchestration** : merge de
   `build-notify/panneau-cardinalites-vue-ensemble` dans `feature/migration-postgresql`
   (synchroniser d'abord avec `origin/feature/migration-postgresql`), puis déploiement CI/CD.
3. **Après merge** : contrôle visuel humain de la Vue d'ensemble (10 cartes + hover
   `.card-link` + modale signaux) sur l'environnement déployé.
4. Optionnel (dette) : ajouter un harnais Playwright au repo panneau pour transformer la
   preuve de parcours §6.3 en tests E2E enregistrés (`e2e_test_register`) — scénarios
   listés au §9 du plan.
