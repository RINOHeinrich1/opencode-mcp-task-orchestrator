# Rapport — HOTFIX CRITIQUE : constantes de taxonomie manquantes dans `db.mjs` (MCP task-orchestrator HS)

- **Tâche** : `T-20260921-064606-g7s5` (priorité `critical`, type `debug`, exécution directe)
- **Exécution** : `E-T-20260921-064606-g7s5-775txx` (tentative 1)
- **Agent** : `build-notify`
- **Date** : 2026-09-21 06:48:22
- **Repo** : `opencode-mcp-task-orchestrator` = `/root/.config/opencode/mcp/task-orchestrator`
- **Branche de déploiement** : `feature/migration-postgresql`

---

## 1. Résumé

**Demande** : le MCP `task-orchestrator` ne démarrait plus (panneau HS). `index.mjs`
importait `DOC_TYPES`, `ARTIFACT_SOURCES`, `ARTIFACT_KINDS` depuis `./db.mjs`, jamais
exportés → `SyntaxError: The requested module './db.mjs' does not provide an export
named 'ARTIFACT_KINDS'`. `db.mjs` utilisait en outre 6 constantes jamais définies.

**Fait** :
1. Définition + export des **6 constantes** demandées au top-level de `db.mjs`, exactement
   selon le référentiel `/root/orchestrator-panel/public/docs/nomenclature-doc-type.md`.
2. **Découverte par l'audit ALL_CAPS (vérification 3)** : **3 constantes supplémentaires**
   utilisées à l'exécution mais jamais définies — `DOC_TYPE_BY_DOC_KIND`,
   `DOC_KIND_BY_DOC_TYPE`, `DOC_TYPE_BY_ARTIFACT_KIND` — introduites par le commit
   `090d310` (fusion polymorphe) et jamais définies depuis. **Définies + exportées
   également** (dans le périmètre `db.mjs`), sinon les chemins `doc_get`/`doc_update`/
   `doc_list`/migration levaient un `ReferenceError`.
3. Vérifications réelles (spawn MCP, pas seulement `node --check`) : **3/3 PASS**.
4. Commit, push branche de déploiement, promotion **fast-forward** sur `main`, push.

**Résultat** : le MCP redémarre et répond ; le panneau est rétabli.

---

## 2. Isolation

- **Espace Coder** : ce repo est un **composant d'infrastructure** (serveur MCP du
  panneau, produit `ecosystem`), **absent de tout workspace Coder** (`workspace_list` :
  seuls mada-talk, ONIRIA, myxmax, affelyos, admin-myxmax, ia-crm-frontend, ia-crm-api).
  Conformément à la norme, le traitement a été fait sur l'hôte car il s'agit d'un
  composant d'infrastructure (MCP socle), et non du code applicatif d'un projet.
- **Worktree / branche** : `session-guard acquire` → **mode `in-place`** (aucune session
  parallèle détectée), branche active `feature/migration-postgresql`. Aucun worktree créé.
- **SHA de référence (base)** : `3c4773ed338b64e9be14b325d3bd18076ca7d888`.

---

## 3. Branches et commits

| Branche | Commit | Message |
|---------|--------|---------|
| `feature/migration-postgresql` | `cf33751ab7bf533bb01a540fc77de0370f534b2a` | `fix(db): définir/exporter les constantes de taxonomie doc_type manquantes (HOTFIX démarrage MCP)` |
| `main` (fast-forward) | `cf33751ab7bf533bb01a540fc77de0370f534b2a` | idem (aucun commit de merge, `--ff-only`) |

- `git push origin feature/migration-postgresql` → `3c4773e..cf33751` ✅
- `git checkout main && git merge --ff-only feature/migration-postgresql` → Fast-forward ✅
- `git push origin main` → `3c4773e..cf33751` ✅ (jamais de `--force`)
- Retour sur `feature/migration-postgresql` ✅
- État final : `main` = `origin/main` = `feature/migration-postgresql` = `cf33751`.

---

## 4. Traitements effectués

| # | Étape | Résultat |
|---|-------|----------|
| 1 | `workspace_list` + `session-guard acquire` | Composant infra hors Coder ; verrou `in-place` acquis |
| 2 | Analyse `index.mjs` (imports l.120-163) + `db.mjs` (usages des 6 constantes) | Cause racine confirmée |
| 3 | Édition `db.mjs` : ajout du bloc de constantes (l.~1662) | 6 + 3 constantes définies/exportées |
| 4 | Vérification 1 — `import('./db.mjs')` | 9 exports présents ✅ |
| 5 | Vérification 2 — spawn réel MCP + `initialize` + 4 `tools/call` | `org_list`/`doc_list`/`artifact_list`/`adr_list` OK ✅ |
| 6 | Vérification 3 — audit statique ALL_CAPS (scanner hors chaînes/commentaires) | Aucune constante réellement non définie restante ✅ |
| 7 | Exercice des chemins runtime des mappings | `doc_list(kind=adr-tech)`→3, `doc_get`→`kind=adr-tech`, `artifact_list(kind=…)`, `recette_get` OK ✅ |
| 8 | Commit + push + promotion `main` (ff-only) + push | Déployé ✅ |

---

## 5. Fichiers modifiés / créés

- **Modifié** : `/root/.config/opencode/mcp/task-orchestrator/db.mjs` (+22 lignes).
- **Créé** : ce rapport
  (`reports/report-hotfix-constantes-taxonomie-db-20260921-064822.md`).

Aucun autre fichier touché (périmètre strict respecté).

### Détail du correctif

```js
export const DOC_TYPES = ["adr","specs","gherkin","project_doc","adr_file","plan",
  "task_synthese","task_report","audit_report","recette_report","recette_doc",
  "e2e_report","e2e_video","autre"];
export const DOCS_DOC_TYPES = ["adr","specs","gherkin","project_doc","adr_file"];
export const TASK_DOC_TYPES = ["plan","task_synthese","task_report","audit_report","autre"];
export const RECETTE_DOC_TYPES = ["recette_report","recette_doc"];
export const ARTIFACT_KINDS = ["plan","audit","report","autre"];
export const ARTIFACT_SOURCES = ["import","artifact","registry","ref"];
// Bonus (vérification 3) — mappings utilisés mais jamais définis :
export const DOC_TYPE_BY_DOC_KIND = {"adr-tech":"adr","specs-fonctionnelles":"specs","scenarios-gherkin":"gherkin"};
export const DOC_KIND_BY_DOC_TYPE = {"adr":"adr-tech","specs":"specs-fonctionnelles","gherkin":"scenarios-gherkin"};
export const DOC_TYPE_BY_ARTIFACT_KIND = {"plan":"plan","audit":"audit_report","report":"task_report","autre":"autre"};
```

---

## 6. Vérifications (détail des 3 obligatoires)

### Vérification 1 — exports du module
```
$ node --check db.mjs          → OK
$ node -e 'import("./db.mjs").then(...)'
EXPORTS: ["ARTIFACT_KINDS","ARTIFACT_SOURCES","DOCS_DOC_TYPES","DOC_KIND_BY_DOC_TYPE",
"DOC_TYPES","DOC_TYPE_BY_ARTIFACT_KIND","DOC_TYPE_BY_DOC_KIND","RECETTE_DOC_TYPES","TASK_DOC_TYPES"]
```
→ les **6 constantes demandées** (+ les 3 mappings) sont exposées. ✅

### Vérification 2 — spawn réel du MCP (`/root/orchestrator-panel/mcp-client.mjs`)
```
OK  org_list      -> object(keys=count,organizations)
OK  doc_list      -> object(keys=count,docs)
OK  artifact_list -> object(keys=count,artifacts)
OK  adr_list      -> object(keys=count,adrs)
VERIF2_PASS
```
→ `initialize` + `tools/call` répondent, **aucun crash, aucun timeout**. ✅

### Vérification 3 — aucune constante ALL_CAPS utilisée sans définition
Scanner statique (hors chaînes de caractères et commentaires) : les seuls identifiants
restants sont des **faux positifs** :
- `OPENCODE_DB`, `OPENCODE_USER` → accès `process.env.*` (membres, pas des identifiants nus) ;
- `WHERE` → SQL dans des chaînes (limite du scanner, vérifié ligne à ligne).

→ **aucune constante non définie restante**. ✅

### Exercice des chemins runtime des 3 mappings (preuve complémentaire)
```
OK doc_list(kind=adr-tech) -> count=3          (DOC_TYPE_BY_DOC_KIND)
OK doc_get(doc-mu5hetkk-41ms) -> kind=adr-tech  (DOC_KIND_BY_DOC_TYPE)
OK artifact_list(kind=plan|audit|report|autre)  (DOC_TYPE_BY_ARTIFACT_KIND)
OK recette_list -> count=32 ; recette_get OK    (RECETTE_DOC_TYPES)
PATHS_PASS
```
✅

---

## 7. Avertissements / erreurs

- **Écart vs énoncé** : 3 constantes supplémentaires (`DOC_TYPE_BY_*`, `DOC_KIND_BY_DOC_TYPE`)
  étaient également non définies. Elles ont été ajoutées (périmètre `db.mjs`, cohérent avec
  le référentiel §3 « table de mapping »). Sans elles, les outils `doc_*` et la migration
  auraient échoué en `ReferenceError`.
- **`node --check` seul** ne détecte pas ces bugs (il ne résout pas les imports) — d'où le
  spawn réel exigé et réalisé.
- **E2E** : tâche d'infrastructure sans comportement produit observable → **E2E NA** (aucun
  test E2E enregistré/lié, conforme au cadrage).
- **`plan_commit_add`** : **non applicable** — tâche en exécution directe, **aucun plan**
  (`planExecutions: []`).
- Les fichiers non suivis `plans/` et `reports/*.md` préexistants n'ont **pas** été committés
  (seul `db.mjs` a été stagé).
- Aucun blocage restant.

---

## 8. Prochaines étapes / recommandations

1. **Redémarrer la session MCP du panneau** si un process persistant chargeait l'ancien
   code (le panneau spawne un MCP par appel → effet immédiat, mais le serveur MCP
   long-running d'opencode doit être relancé pour recharger `db.mjs`).
2. **Garde-fou CI** : ajouter un test de « démarrage MCP » (`import` de `index.mjs` +
   `initialize` + smoke `tools/call`) pour empêcher la réintroduction de ce type de
   régression (constante utilisée/importée sans définition).
3. La régression a été livrée par la tâche liée `T-20260920-162801-jxtr` (fusion artefacts) :
   un contrôle de cohérence imports↔exports en pré-commit serait pertinent.
