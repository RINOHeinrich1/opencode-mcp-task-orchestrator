# Rapport — Onglet « ADR » DU PROJET (panneau `opencode-observability`)

- **Tâche** : `T-20260921-070807-t1g6`
- **Exécution** : `E-T-20260921-070807-t1g6-jipzwn`
- **Plan** : `Plan-onglet-adr-projet-20260921-070532` (11 étapes A001–A011 — **100 %**)
- **Projet** : `ecosystem` — repo `opencode-observability` (`/root/orchestrator-panel`)
- **Agent** : `build-notify` (executor)
- **Date** : 2026-09-21 07:14:37

## Résumé

**Demandé** : faire de l'ADR un **onglet À L'INTÉRIEUR DU PROJET** (entrée de `PROJECT_TABS`
uniquement, `GLOBAL_TABS` inchangé), avec rendu dédié `renderAdrs`, table des ADR du projet
courant, filtres statut/repo + recherche, CRUD + pièces jointes, logique **mutualisée**
(`adrTableHtml` + `bindAdrTable`), et **retrait** de l'onglet ADR interne au `projectDetailModal`.

**Fait** : les 11 étapes du plan ont été implémentées et vérifiées.
- Entrée `['adr','ADR']` ajoutée **uniquement** dans `PROJECT_TABS` (juste après « Artefacts ») ;
  `GLOBAL_TABS` **non modifié**.
- `renderAdrs()` enregistrée dans la carte `RENDER` (`adr: renderAdrs`) ; pane `#pane-adr` créé
  dynamiquement par `ensurePane` (index.html hors périmètre, non modifié).
- Table **8 colonnes** : Titre / Statut / Contexte / Décision / Conséquences / **Repos rattachés**
  (+ badge « globale ») / Pièces jointes / Actions ; filtres statut/repo + recherche client.
- `adrTableHtml(ctx)` + `bindAdrTable(rootEl, ctx)` **mutualisés** (un seul rendu, un seul câblage) ;
  réemploi de `adrFormModal`, `adrAttachmentModal`, `viewRefDoc`, `adrAttachmentsCell` (désormais
  paramétrable par `prefix`), `adrStatusBadge`, `adrGlobalBadge`, `adrCellText`.
- Onglet ADR interne au `projectDetailModal` **retiré** (entrée de tabs + branche de rendu + bloc de
  câblage `wire()` + variables mortes `adrFilter`/`pAdrs`).
- `server.mjs` et `index.html` **non modifiés** (l'API ADR existait déjà).

## Isolation

- **Espace Coder** : sans objet — ce repo est le **panneau d'infrastructure hôte** (`/root/orchestrator-panel`).
  Aucun workspace Coder ne le contient ; le cadrage autorise explicitement le travail sur l'hôte
  (« panneau, infra hôte »).
- **Verrou `session-guard`** : acquis en mode `in-place` (aucune autre session détectée sur le dépôt),
  puis **libéré** en fin de traitement.
- **Worktree isolé** : `/root/orchestrator-panel/.worktrees/adr-t1g6` sur la branche dédiée
  `build-notify/adr-projet-t1g6`. Le répertoire `.worktrees/` est déjà exclu par `.git/info/exclude`
  → le **checkout principal est resté propre** (aucune modification non commitée).
  - Note technique : `session-guard worktree` crée le worktree en **sibling**
    (`/root/orchestrator-panel-wt-…`), hors du périmètre d'accès en lecture/édition des outils
    (seul `/root/orchestrator-panel/**` est autorisé). Le worktree a donc été recréé sous
    `.worktrees/` (chemin autorisé) sans changer la sémantique d'isolation.

## Branches et commits

- **Branche de travail** : `build-notify/adr-projet-t1g6` (poussée sur `origin`).
- **Base** : `3828c9519f98dea1c2739a5b9eda6ac64b861b85` (= `origin/feature/migration-postgresql`,
  branche principale du repo → aucun rebase nécessaire).
- **Commits** :
  | SHA | Message | Fichiers |
  |-----|---------|----------|
  | `446e78bbef3b1bb88ec0c99f7b2ac36e3d17a5e8` | feat(adr): panneau — onglet « ADR » DU PROJET (PROJECT_TABS) + retrait de l'onglet ADR du modal (T-20260921-070807-t1g6) | `public/app.js` (+187/−89), `public/style.css` (+22/−0) |

Trace des commits (fichiers + diff) enregistrée via `plan_commit_add` (id 454, append-only).

## Traitements effectués

| Étape | Action | Résultat |
|-------|--------|----------|
| A001 | `ensurePane(tab)` idempotent + appel en tête de `switchTab` | `#pane-adr` créé à la demande et activé ✔ |
| A002 | `PROJECT_TABS` : `['adr','ADR']` après Artefacts ; `GLOBAL_TABS` inchangé | Onglet ADR visible projet ouvert, absent accueil ✔ |
| A003 | `adrAttachmentsCell(d, prefix = 'pd-adr')` | `data-*` paramétrés ; défaut rétrocompatible ✔ |
| A004 | `adrTabHtml` → **`adrTableHtml(ctx)`** + `adrRowVisible` | Table mutualisée 8 colonnes + filtres ✔ |
| A005 | Nouvelle **`bindAdrTable(rootEl, ctx)`** | CRUD + pièces jointes + filtres mutualisés ✔ |
| A006 | Retrait onglet ADR du `projectDetailModal` (entrée + branche + `adrFilter`/`pAdrs`) | Modal = Projet/Repos/Documents ✔ |
| A007 | Retrait du bloc de câblage ADR de `wire()` | Plus de code mort ADR dans le modal ✔ |
| A008 | **`renderAdrs()`** + état `adrFilters` | Onglet projet opérationnel ✔ |
| A009 | Carte `RENDER` : `adr: renderAdrs` | Rendu au clic + polling ✔ |
| A010 | CSS `.adr-pane-filters/.adr-search/.adr-table-wrap/.adr-table/.adr-actions` | Rendu responsive + table scrollable ✔ |
| A011 | `node --check` + **vérification de RENDU** | Voir ci-dessous ✔ (pm2 = étape déploiement, cf. cadrage) |

## Vérifications de rendu (A011 — `node --check` ne suffit pas)

1. **Syntaxe** : `node --check public/app.js` → OK.
2. **Rendu réel** : `public/app.js` chargé dans un contexte VM (DOM minimal stubbé) puis assertions sur
   le HTML/le comportement **générés** (`/tmp/opencode/verify-adr.js`) → **TOUT OK** :
   - `GLOBAL_TABS` **ne contient pas** d'entrée `adr` ; `PROJECT_TABS` contient `['adr','ADR']`
     juste après `artifacts` ;
   - `renderNav()` (projet ouvert) émet `<button data-tab="adr">ADR</button>` ;
     `renderNav()` (accueil) **n'émet pas** d'onglet ADR ;
   - `ensurePane('adr')` crée `#pane-adr` **une seule fois** (idempotent) ; `switchTab('adr')`
     l'active, `switchTab('tasks')` le désactive (cohérence `.pane`) ;
   - `RENDER.adr === renderAdrs` ; **chaque** onglet (global + projet) a un renderer (non-régression) ;
   - `adrTableHtml` rend les 8 colonnes, les contrôles `#adr-search`/`#adr-status-filter`/
     `#adr-repo-filter`/`#adr-new`/`#adr-count`, les actions `data-adr-*`, les pièces jointes
     `data-adr-att-*`, le badge « globale » et les chips de repos ;
   - filtres : `status=Accepté` → 1/3, `repo=r2` → 2/3, recherche `q=zèbre` → 1/3 ; état vide géré ;
   - rétrocompat : `adrAttachmentsCell()` → `data-pd-adr-*` ; `adrAttachmentsCell(d,'adr')` → `data-adr-*` ;
   - source : plus de `tab === 'adr'`, plus de `adrTabHtml`, plus de `data-pd-adr-` codé en dur.

## Fichiers modifiés / créés

- `/root/orchestrator-panel/.worktrees/adr-t1g6/public/app.js` (modifié — A001–A009)
- `/root/orchestrator-panel/.worktrees/adr-t1g6/public/style.css` (modifié — A010)
- `/root/.config/opencode/mcp/task-orchestrator/reports/report-onglet-adr-projet-20260921-071437.md` (ce rapport)
- `/tmp/opencode/verify-adr.js` (harnais de vérification de rendu — transitoire)

## Avertissements / erreurs

- **`server.mjs` non modifié** : l'API ADR/pièces jointes existait déjà (conforme au périmètre).
- **`index.html` non modifié** : le pane `adr` est créé dynamiquement par `ensurePane` (A001).
- **`pm2 restart orchestrator-panel` NON exécuté** : réservé à l'étape de déploiement (orchestrateur),
  conformément au cadrage. La vérification de rendu a donc été faite hors service (VM/DOM) et non en live.
- **Parcours navigateur réel non effectué** (pas de navigateur dans l'environnement d'exécution) :
  la vérification de structure/comportement est couverte par le harnais ; un contrôle visuel humain
  reste recommandé après redéploiement.
- **Secret** : le remote `origin` contient un token d'accès ; il n'a **pas** été reproduit dans ce rapport
  ni dans aucun artefact.
- Aucun incident ni incohérence de plan rencontré.

## Prochaines étapes / recommandations

1. **Déploiement (orchestrateur)** : merger `build-notify/adr-projet-t1g6` dans
   `feature/migration-postgresql`, puis `pm2 restart orchestrator-panel`.
2. **Contrôle visuel** après redéploiement : ouvrir un projet → onglet **ADR** présent ; à l'accueil →
   **absent** ; modal de détail projet → **plus d'onglet ADR** ; vérifier CRUD + pièces jointes + filtres.
3. Nettoyage ultérieur : le worktree `/root/orchestrator-panel/.worktrees/adr-t1g6` et la branche locale
   sont **laissés en place** pour permettre le merge local par l'orchestrateur (aucun push destructif).
