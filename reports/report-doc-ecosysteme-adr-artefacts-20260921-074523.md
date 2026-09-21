# Rapport — Documentation d'écosystème : ADR structurées, famille `adr_*`, artefacts & gouvernance ADR

- **taskId** : `T-20260921-073448-5a1f`
- **executionId** : `E-T-20260921-073448-5a1f-zux1lm`
- **planId** : `Plan-doc-ecosysteme-adr-artefacts-20260921-073755` (12 étapes A001–A012)
- **Projet / repo** : `ecosystem` / `opencode-observability` = `/root/orchestrator-panel`
- **Branche de déploiement** : `feature/migration-postgresql`
- **Date** : 2026-09-21 07:45 UTC
- **Agent** : `build-notify` (executor)

---

## 1. Résumé

**Demandé** : mettre à jour la documentation d'écosystème (`/root/orchestrator-panel/public/docs/`,
servie par le panneau sur `/docs/…`) pour qu'elle décrive **le code réellement déployé** :
ADR structurées, famille MCP `adr_*`, gouvernance ADR en recette/test, gestionnaire
central d'artefacts (table polymorphe `artifacts`) et nouvelle organisation des onglets
du panneau.

**Fait** : exécution complète des 12 étapes du plan approuvé — **1 doc créé**
(`13-adr-et-artefacts.md`) et **8 docs mis à jour** (`README.md`, `01`, `02`, `03`,
`05`, `09`, `12`, `CHANGELOG.md`), en s'appuyant strictement sur les sources de vérité
lues (`index.mjs`, `db.mjs`, `schema.sql`, `app.js`, `server.mjs`, `pilot.mjs`).
Vérifications : **30 liens relatifs valides (0 cassé)** et **rendu `/docs/*.md` = HTTP 200**
pour tous les docs (dont le nouveau `13-adr-et-artefacts.md`).

## 2. Isolation

- **Espace Coder** : le repo `opencode-observability` (`/root/orchestrator-panel`) est le
  **panneau de supervision** (composant d'infrastructure) ; il **n'existe dans aucun
  workspace Coder** (`workspace_list` → 7 workspaces, aucun ne contient ce repo). La tâche
  désigne explicitement ce chemin hôte — traitement sur l'hôte **assumé et documenté** ici
  (conformément à l'exception « composant d'infrastructure »).
- **session-guard** : `acquire` → **mode `in-place`** (aucune session parallèle détectée),
  verrou posé pour la session `ses_f3d180ad1ffeFB7LM8yY2l1X2f`.
- **Worktree isolé + branche dédiée** (exigence tâche) : le worktree par défaut de
  session-guard (`/root/orchestrator-panel-wt-…`, **hors** du périmètre outillé
  `/root/orchestrator-panel/**`) n'était pas accessible aux outils → worktree créé **dans**
  le dépôt, à la convention existante (`.worktrees/`, déjà gitignoré) :
  - worktree : `/root/orchestrator-panel/.worktrees/build-notify-doc-ecosysteme`
  - branche : `build-notify/doc-ecosysteme-adr-artefacts` (base `130fd6d`)
- **Checkout principal** : `/root/orchestrator-panel` **propre** (vérifié avant et après,
  `git status --short` vide). Non-root : aucune commande du workspace Coder n'était requise
  (doc-only, pas d'exécution de code projet) ; toutes les commandes git/édition ont visé le
  worktree.

## 3. Branches et commits

| Branche | Commit | Message |
|---|---|---|
| `build-notify/doc-ecosysteme-adr-artefacts` | `756ac0b39385c466c1209c4c46947f051522576a` | `docs(écosystème): ADR structurées, famille adr_*, gestionnaire d'artefacts & gouvernance ADR` |

- Base : `130fd6db289f9dfb99cd211bf498ab844b330684` (`feature/migration-postgresql`).
- Trace enregistrée dans le registre : `plan_commit_add` → **id 455** (9 fichiers + diffs).
- **Non poussé** (pas de demande explicite) ; la branche est prête pour merge/déploiement par
  l'orchestrateur. Pas de push sur la branche principale.

## 4. Traitements effectués (A001 → A012)

| Étape | Action | Fichier | Résultat |
|---|---|---|---|
| A001 | **Créer** doc 13 (5 sections : ADR structurées, famille `adr_*`, gouvernance recette, artefacts polymorphes, panneau) + version EN | `public/docs/13-adr-et-artefacts.md` | ✅ créé (316 lignes) |
| A002 | **Modifier** table des matières (+ doc 13 + nomenclature) | `public/docs/README.md` | ✅ |
| A003 | **Remplacer** stockage `docs`/`doc_projects`/`doc_repos` → `artifacts`/`artifact_projects`/`artifact_repos` (§2, §4) | `public/docs/12-documents-reference-projets-repos.md` | ✅ |
| A004 | **Remplacer** ligne `artifacts` du modèle de données (§1 FR + EN) | `public/docs/05-reference.md` | ✅ |
| A005 | **Ajouter** tables `adr_conflicts`/`adr_vigilances` + note legacy `legacy_*` ; machine à états ADR (§2) ; glossaire (§5) | `public/docs/05-reference.md` | ✅ |
| A006 | **Modifier** liste des onglets (globaux + projet ; retrait Déploiements/Événements/Plans) FR + EN | `public/docs/02-composants.md` | ✅ |
| A007 | **Modifier** tables du registre + outils MCP clés (§4 FR + EN) | `public/docs/02-composants.md` | ✅ |
| A008 | **Ajouter** §1bis « Gouvernance ADR en recette » (blocage + levée tracée) + §4bis EN | `public/docs/03-workflow.md` | ✅ |
| A009 | **Ajouter** concepts « ADR structurée », « Artefact », « Point de vigilance ADR » (§2) | `public/docs/01-architecture.md` | ✅ |
| A010 | **Modifier** note de rattachement N:N ADR via `artifact_projects`/`artifact_repos` (§2) | `public/docs/09-modele-projets-repos.md` | ✅ |
| A011 | **Ajouter** entrée de changelog datée 2026-09-21 (en tête) | `public/docs/CHANGELOG.md` | ✅ |
| A012 | **Vérifier** liens relatifs + rendu `/docs/*.md` | `public/docs/*` | ✅ (cf. §6) |

Avancement `plan-manager` : **12/12 étapes `done` — 100 %**.

## 5. Fichiers modifiés / créés

| Fichier | Nature | +/− |
|---|---|---|
| `public/docs/13-adr-et-artefacts.md` | **créé** | +316 |
| `public/docs/02-composants.md` | modifié | +40 / −16 |
| `public/docs/05-reference.md` | modifié | +38 / −4 |
| `public/docs/CHANGELOG.md` | modifié | +30 / −0 |
| `public/docs/03-workflow.md` | modifié | +29 / −0 |
| `public/docs/12-documents-reference-projets-repos.md` | modifié | +22 / −6 |
| `public/docs/09-modele-projets-repos.md` | modifié | +6 / −0 |
| `public/docs/01-architecture.md` | modifié | +3 / −0 |
| `public/docs/README.md` | modifié | +2 / −0 |

`public/docs/nomenclature-doc-type.md` : **non modifié** (référentiel de taxonomie, seulement
référencé — conformément au plan).

## 6. Vérifications

1. **Liens relatifs** (`/tmp/opencode/check-doc-links.mjs`, liste explicite des 16 docs — pas
   de glob/listing récursif) : **30 liens vérifiés, 0 cassé**. La TOC (`README.md`) liste bien
   `13-adr-et-artefacts.md` et `nomenclature-doc-type.md` ; les liens croisés des docs `01`,
   `02`, `03`, `05`, `09`, `12` vers `13` résolvent.
2. **Rendu `/docs/*.md`** (panneau `orchestrator-panel`, `http://127.0.0.1:4000`, **sans
   relance pm2**) : matérialisation temporaire des 9 fichiers dans le checkout principal
   (servi statiquement), puis `curl` :
   - `README.md`, `CHANGELOG.md`, `01`, `02`, `03`, `05`, `09`, `12`, **`13-adr-et-artefacts.md`**,
     `nomenclature-doc-type.md` → **HTTP 200** ;
   - `/docs` → **302** vers `/docs/README.md` ;
   - contrôle de contenu : le doc 13 servi contient bien la section « Famille MCP ».
   - **Restauration** ensuite (`git checkout -- public/docs` + suppression du fichier nouveau) :
     checkout principal **propre** (`git status --short` vide).
   - Note : après restauration (avant merge), `/docs/13-adr-et-artefacts.md` redevient 404 sur
     le checkout principal — il sera servi dès le merge de la branche sur
     `feature/migration-postgresql` (étape orchestrateur).
3. **Conformité au code** : contenu dérivé de `index.mjs` (tools `adr_*`, `doc_*`, `artifact_*`,
   `recette_confirm`), `db.mjs` (`ADR_STATUS`, `ADR_TRANSITIONS`, `DOC_TYPES`, `confirmRecette`),
   `schema.sql` (`artifacts`, `artifact_projects`/`artifact_repos`, `adr_conflicts`,
   `adr_vigilances`, note legacy), `app.js` (`GLOBAL_TABS`/`PROJECT_TABS`, onglets ADR/Artefacts,
   modal tâche), `server.mjs` (routes `/docs/`, `/api/artifacts`, `/api/adr-vigilances`),
   `pilot.mjs` (pré-check `finishRecette`). Aucune intention documentée.

## 7. Avertissements / erreurs

- **Worktree session-guard hors périmètre outillé** : le chemin par défaut
  (`/root/orchestrator-panel-wt-…`) n'est pas couvert par les règles d'accès aux répertoires
  externes → worktree recréé dans `.worktrees/` (convention existante du dépôt). Impact : le
  registre session-guard conserve le mode `in-place` ; le verrou est libéré en fin de tâche.
- **A010 — référence de ligne** : le plan indiquait « après l.47 » de
  `09-modele-projets-repos.md` ; la ligne 47 y est un séparateur. La note a été insérée au
  début de la §2 « Modèle cible » (emplacement sémantiquement correct : c'est là que le N:N
  projet/repo est décrit). Aucune incohérence de fond.
- Aucune erreur de build/test (tâche **doc-only**, aucun code exécutable modifié).
- **E2E NA** : tâche de documentation, sans comportement utilisateur observable → aucun test
  Playwright à créer/lier (conforme au plan §9).

## 8. Prochaines étapes / recommandations

1. **Orchestrateur** : merger `build-notify/doc-ecosysteme-adr-artefacts` dans
   `feature/migration-postgresql` (branche de déploiement). Après merge, `/docs/13-adr-et-artefacts.md`
   sera servi en 200 par le panneau (aucune relance pm2 nécessaire : route statique `/docs/*.md`).
2. Revue humaine des docs (contenu conforme au code déployé).
3. Optionnel : aligner le `README.md` (écosystème) sur la doc 13 si d'autres évolutions
   ADR/artefacts sont livrées.
