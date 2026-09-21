# Synthèse de planification — T-20260921-065829-xa46

- **Tâche** : `T-20260921-065829-xa46` (executionId `E-T-20260921-065829-xa46-091kez`)
- **Titre** : Panneau — onglet ADR de PREMIER NIVEAU (hors modal détail projet)
- **Projet** : `ecosystem` — repo `opencode-observability` (`/root/orchestrator-panel`)
- **Agent** : `atomic-plan` (planner)
- **Date** : 2026-09-21 07:01:13

## 1. Objectifs identifiés

| # | Objectif | Type | Plan |
|---|----------|------|------|
| 1 | Exposer les ADR dans un onglet de PREMIER NIVEAU de la navigation principale (table complète + filtres + recherche + CRUD + pièces jointes), en réutilisant l'existant | Unique, borné | `Plan-onglet-adr-premier-niveau-20260921-070023` |

**Aucun objectif indépendant multiple** : la tâche porte un seul objectif cohérent (le « sort de l'onglet
interne au modal » est une **sous-décision**, pas un objectif distinct). → **un seul plan**.

## 2. Plan produit

- **planId** : `Plan-onglet-adr-premier-niveau-20260921-070023`
- **Fichier** : `plans/Plan-onglet-adr-premier-niveau-20260921-070023.md`
- **Chemin hôte** : `/root/.config/opencode/mcp/task-orchestrator/plans/Plan-onglet-adr-premier-niveau-20260921-070023.md`
- **Étapes** : 10 (`A001` → `A010`)
- **Statut** : enregistré (`plan_register`, taskId) — suivi à `todo`

### Étapes (atomiques)

| ID | Action | Élément | Fichier |
|----|--------|---------|---------|
| A001 | Ajouter | `ensurePane(tab)` + appel dans `switchTab` (création dynamique de `#pane-adr`) | `public/app.js` |
| A002 | Modifier | `GLOBAL_TABS` + `PROJECT_TABS` → entrée `['adr','ADR']` | `public/app.js` |
| A003 | Modifier | `adrAttachmentsCell(d, prefix='pd-adr')` | `public/app.js` |
| A004 | Extraire | `adrTableHtml(ctx)` partagé ; `adrTabHtml` → adaptateur `scope='project'` | `public/app.js` |
| A005 | Extraire | `bindAdrTable(rootEl, ctx)` partagé ; `wire()` du modal délègue | `public/app.js` |
| A006 | Modifier | `adrFormModal(p, repos, adr, onSaved, opts)` → mode global (select projet) | `public/app.js` |
| A007 | Ajouter | `renderAdrs()` (fetch + scoping org + cache + filtres + table) | `public/app.js` |
| A008 | Modifier | carte `RENDER` → `adr: renderAdrs` | `public/app.js` |
| A009 | Ajouter | classes `.adr-pane-filters` / `.adr-table-wrap` / `.adr-table` | `public/style.css` |
| A010 | Vérifier | `pm2 restart orchestrator-panel` + parcours manuel complet | `/root/orchestrator-panel` |

## 3. Fichiers concernés (bilan)

- `public/app.js` — **modifié** (A001-A008)
- `public/style.css` — **modifié** (A009)
- `server.mjs` — **non modifié** (API `/api/docs…` déjà complète)
- `public/index.html` — **non modifié** (pane créé dynamiquement, fichier hors scope)
- `pilot.mjs` — **non modifié** (wrapper MCP déjà complet)

## 4. Vérifications de cohérence

### Intra-plan (Phases 5-7) — **Valid**

- **Contradictions** : aucune. Chaque élément de code n'est visé que par **une** étape avec **un** verbe
  (`adrTabHtml`→A004, `adrAttachmentsCell`→A003, `wire()` ADR→A005, `adrFormModal`→A006,
  `GLOBAL_TABS`/`PROJECT_TABS`→A002, `RENDER`→A008). Pas de `supprimer` sur un élément `modifier`/`déplacer`.
- **Ordre** : aucune étape n'accède à un élément créé par une étape ultérieure (`A007 → A008` respecté).
- **Couverture** : 100 % des critères d'acceptation mappés (table §8 du plan).

### Globale (Phase 9) — **aucune incohérence inter-plans**

Un seul plan produit → pas de conflit inter-plans. Aucune autre tâche active ne touche
`/root/orchestrator-panel/{public/app.js, public/style.css}` (scope de la tâche).

## 5. Décisions structurantes (explicitées dans le plan)

1. **Sort de l'onglet ADR interne au modal** : **conservé comme raccourci** (aucune suppression) —
   rétrocompat maximale ; l'onglet global et l'onglet du modal **partagent** rendu et câblage.
2. **Pane dynamique** : `index.html` étant hors scope, `#pane-adr` est créé par un helper idempotent
   `ensurePane` dans `app.js`.
3. **Scoping organisation** : filtré **côté client** (intersection avec les projets/repos visibles),
   car `doc_list` sans `projectId` n'est pas filtré par organisation côté MCP.
4. **Filtre `status` côté client** : évite de modifier `pilot.mjs` (hors scope).

## 6. E2E — NA

- `e2e_list(project="ecosystem")` → **0 test** ; `e2e_list(taskId="T-20260920-162754-b4cb")` → **0 test**.
- Le panneau `opencode-observability` est de l'infra hôte **sans spec Playwright** ni `e2eRepoDir`.
- **Aucun** `e2e_test_register` / `e2e_test_link` créé. Non-régression couverte par la vérification
  manuelle (A010).

## 7. Risques

- `node --check` ne valide pas le rendu → vérification manuelle obligatoire (A010, pas de CI).
- Limite `doc_list` : 500 documents (suffisant à ce stade).
- Retrait d'un repo rattaché à une ADR non exposé par l'API (additif) — limitation existante conservée.
