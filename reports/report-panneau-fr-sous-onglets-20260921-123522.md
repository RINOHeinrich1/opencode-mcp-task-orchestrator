# Rapport — Séparation « Fonctionnalités » / « Règles métier » en deux sous-onglets (plan 2/2)

- **Tâche** : `T-20260921-120633-mtl2`
- **Exécution** : `E-T-20260921-120633-mtl2-jai3ti`
- **Plan** : `Plan-separer-fonctionnalites-regles-sous-onglets-20260921-121443` (11 étapes A001–A011)
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 12:35 UTC
- **Projet** : `ecosystem` — repo `opencode-observability` → `/root/orchestrator-panel`
- **Branche de travail** : `build-notify/panneau-fr-sous-onglets`
- **Commit** : `35380316fceb4b9e93b0402bb5581ea9d5cc3873`
- **Base imposée (empilement)** : `build-notify/panneau-cardinalites-vue-ensemble` @ `3d82e751638476aa9f3e8a15c91c42d5c1a19afc` (plan 1/2 déjà exécuté)

## Résumé

Demande : **séparer l'onglet « Fonctionnalités / Règles » en deux sous-onglets internes distincts** — « Fonctionnalités » (US-xxx) et « Règles métier » (RM-xxxx) — chacun avec sa propre liste, ses propres filtres et son propre CRUD, sans mélange des deux natures d'entités, avec sous-onglet actif persisté au polling, et vérification sur **myxmax** + le projet courant.

Fait : les 11 étapes du plan ont été implémentées dans `public/app.js` et `public/style.css` :
- `PROJECT_TABS` : libellé clarifié `Fonctionnalités & Règles` (l'`id` reste `features`) ;
- états module `frSubTab` / `frFeatureFilters` / `frRuleFilters` (survivent au `refreshActive()` ; `frSubTab` aussi persisté en localStorage) ;
- socle `loadFeatureRuleLinkIndex(features, rules)` + `frLinkCellHtml(kind, id, linkIndex)` **remplaçant** `enrichLinkCells` (index déterministe, concurrence bornée 4) ;
- filtres clients purs `frFilterFeatures` / `frFilterRules` ;
- tables isolées `frFeatureTableHtml` (Ref/Rôle/User story/Liens/Actions) et `frRuleTableHtml` (Ref/Contenu/Pièce source/Liens/Actions) ;
- sous-panneaux `renderFrFeaturePanel` / `renderFrRulePanel` (toolbar de filtres propres + table + CRUD via modales existantes) ;
- `renderFeaturesRules` restructuré en coquille + barre `.pd-tabs`/`.fr-subtabs` + `#fr-subpanel` + dispatch `renderFrSubpanel` ;
- styles additifs `.fr-subtabs` / `.fr-subpanel` / `.fr-filters` dans `public/style.css`.

**Aucune nouvelle route API** (réutilisation de `/api/features`, `/api/rules`, `/api/features/:id`, `/api/rules/:id`, `/api/links`).

## Isolation

- **Espace Coder** : le repo `/root/orchestrator-panel` **n'existe dans aucun workspace Coder** (`workspace_list` : mada-talk, ONIRIA, myxmax, affelyos, admin-myxmax, ia-crm-frontend, ia-crm-api). C'est le **panneau de supervision lui-même** = composant d'**infrastructure** ; travail sur l'hôte justifié et documenté (dérogation « composant d'infrastructure », cohérent avec la mission qui désigne explicitement le repo HÔTE).
- **session-guard** : `acquire --dir /root/orchestrator-panel` → **exit 0, mode `in-place`** (aucune session parallèle détectée). `release` effectué en fin de traitement.
- **Empilement** : branche `build-notify/panneau-fr-sous-onglets` créée **à partir du commit imposé** `3d82e75` (plan 1/2), **pas** depuis `feature/migration-postgresql` (`5299d4c`), afin que les deux plans soient livrés ensemble.

## Branches et commits

- Branche de travail : `build-notify/panneau-fr-sous-onglets`
- Base (empilement) : `3d82e751638476aa9f3e8a15c91c42d5c1a19afc`
- Commit de travail : `35380316fceb4b9e93b0402bb5581ea9d5cc3873` — *feat(panneau): séparer « Fonctionnalités » et « Règles métier » en deux sous-onglets (A001-A010) (T-20260921-120633-mtl2)*
- **Aucun push** (merge/push = étape d'orchestration ultérieure, conformément à la consigne).

Fichiers du commit : `public/app.js` (modified +289/−74), `public/style.css` (modified +10/−0).

## Traitements effectués (11/11 étapes `done`)

| Étape | Action | Résultat |
|---|---|---|
| A001 | Renommer l'entrée `PROJECT_TABS` `features` → `Fonctionnalités & Règles` | ✅ |
| A002 | États module `frSubTab` / `frFeatureFilters` / `frRuleFilters` (+ `persistFrSubTab`) | ✅ |
| A003 | Remplacer `enrichLinkCells` par `loadFeatureRuleLinkIndex` + `frLinkCellHtml` | ✅ |
| A004 | Helpers purs `frFilterFeatures` / `frFilterRules` | ✅ |
| A005 | `frFeatureTableHtml` (table Fonctionnalités isolée) | ✅ |
| A006 | `frRuleTableHtml` (table Règles isolée, colonne Pièce source) | ✅ |
| A007 | `renderFrFeaturePanel` (toolbar + table + CRUD) | ✅ |
| A008 | `renderFrRulePanel` (toolbar + table + CRUD) | ✅ |
| A009 | `renderFeaturesRules` en coquille + `.pd-tabs` + `#fr-subpanel` + `renderFrSubpanel` | ✅ |
| A010 | Styles additifs `.fr-subtabs` / `.fr-subpanel` / `.fr-filters` | ✅ |
| A011 | Vérification (`node --check` + parcours UI) | ✅ |

## Vérifications

### `node --check public/app.js`
✅ OK (`NODE_CHECK_OK`). Aucune occurrence résiduelle de `enrichLinkCells` (hors commentaire historique) ni de `data-fr-links` / `data-rule-links`.

### Périmètre / non-régression (régions du plan 1/2 intactes)
`git diff --stat` = **uniquement** `public/app.js` + `public/style.css` (scope du plan 2). Tous les hunks sont dans la région `features` (l. 5025–5519) et la ligne 128 (`PROJECT_TABS`), plus la fin de `style.css`. Les régions du plan 1/2 (`renderOverview`, `CARDINALITY_CARDS`, `openCardinalityTarget`, `cardinalitySectionHtml`, `.card-link`, filtres Tâches/Recettes/Sprints/ADR) sont **intactes** ; `RENDER.features = renderFeaturesRules` inchangé.

### Parcours UI (Playwright, Chromium headless) — **33/33 PASS**
Le registre (`task_registry`) **ne contient AUCUNE ligne** `fonctionnalites` / `regles_metier` (0 pour tous les projets, y compris myxmax) : les réponses `/api/features` et `/api/rules` (liste + détail) ont donc été **injectées de façon déterministe** pour myxmax (3 fonctionnalités US-101/102/103, 2 règles RM-2001/2002, liens variés) ; le reste des appels passait au serveur réel. Parcours prouvés :

- **A001** : onglet « Fonctionnalités & Règles ».
- **A009** : barre `.fr-subtabs` (2 `.pd-tab`), sous-onglet par défaut « Fonctionnalités », conteneur `.pd-panel #fr-subpanel`, bascule vers « Règles métier » (actif).
- **A005/A006 — séparation stricte** : la table Fonctionnalités ne contient **que** US-xxx (aucun RM-xxxx) ; la table Règles ne contient **que** RM-xxxx (aucun US-xxx) ; la table Fonctionnalités est **absente** du sous-onglet Règles. Entêtes et colonne « Pièce source » conformes.
- **A003** : colonne Liens indexée (US-101 → `1 règle(s) 1 Gherkin 1 ADR 1 sprint(s) 1 tâche(s) 1 recette(s)`).
- **A004/A007/A008 — filtres propres** : Fonctionnalités (recherche « payer » → US-103 ; rôle « opérateur » → US-102 ; émergence → US-102 ; sans règle → US-102 ; sans sprint → US-102 ; sans ADR → US-102+US-103 ; compteur `1 / 3`) ; Règles (recherche « paiement » → RM-2002 ; émergence → RM-2002 ; sans fonctionnalité → RM-2002 ; sans sprint → RM-2002).
- **A002/A009 — persistance au polling** : après `window.refreshActive()`, le sous-onglet « Règles métier » reste actif et la liste reste rendue (état module).
- **A007/A008 — CRUD** : modales « Nouvelle fonctionnalité » et « Nouvelle règle métier » ouvertes (modales existantes) ; modale Détail fonctionnalité exposant règle/Gherkin/ADR/sprint/tâches/recettes.
- **A011 — projet courant `ecosystem`** : les 2 sous-onglets sont rendus, états vides corrects (« Aucune fonctionnalité pour ce projet. » / « Aucune règle métier pour ce projet. ») — sans erreur JS.

Harnais : `/tmp/opencode/verify-fr-subtabs.mjs` (artefact transitoire).

## Fichiers modifiés / créés

| Fichier | Nature |
|---|---|
| `public/app.js` | modifié (+289/−74) — A001–A009 |
| `public/style.css` | modifié (+10) — A010 |
| `/tmp/opencode/verify-fr-subtabs.mjs` | harnais de vérification (transitoire, hors repo) |
| `reports/report-panneau-fr-sous-onglets-20260921-123522.md` | présent rapport |

## Avertissements / erreurs

- ⚠️ **Écart plan ↔ réalité des données (non bloquant)** : le plan A011 suppose une vérification sur **myxmax avec « données réelles »** ; or le registre est **vide** en fonctionnalités/règles (tables `fonctionnalites` / `regles_metier` = 0 ligne pour **tous** les projets). La preuve UI a donc été réalisée avec des **réponses injectées déterministes** pour myxmax + l'état vide réel pour `ecosystem`. Signalé via `task_event(INCONSISTENCY_FOUND)`. Aucune écriture dans le registre (pas de pollution ; les routes `POST /api/features|rules` n'ont pas été utilisées et il n'existe pas de `DELETE`).
- ℹ️ Le serveur panneau `server.mjs` tournait déjà (port 4000) ; il sert `public/` depuis le disque, donc les fichiers de la branche ont été pris en compte sans redémarrage.
- Aucune erreur JS (`pageerror`) pendant le parcours.

## Prochaines étapes / recommandations

1. **Orchestration** : le plan 1/2 (`build-notify/panneau-cardinalites-vue-ensemble` @ `3d82e75`) et le plan 2/2 (`build-notify/panneau-fr-sous-onglets` @ `3538031`, **empilé**) doivent être **fusionnés ensemble** dans `feature/migration-postgresql` (ou livrés via le CI/CD sur la branche de travail) — push/merge laissés à l'étape d'orchestration.
2. **Données** : si une recette fonctionnelle sur myxmax est attendue, **créer des fonctionnalités/règles réelles** pour ce projet (via l'agent ou le panneau) — le rendu des sous-onglets avec données réelles n'a pas pu être exercé faute de lignes au registre.
3. **E2E** : NA (le repo `opencode-observability` ne contient aucune spec Playwright ni config ; `e2e_list(project='ecosystem')` = 0) — preuve assurée par le parcours A011.
