# Plan — Documentation d'écosystème : ADR structurées, famille `adr_*`, gestionnaire central d'artefacts & gouvernance ADR

- **taskId** : `T-20260921-073448-5a1f`
- **executionId** : `E-T-20260921-073448-5a1f-zux1lm`
- **Projet** : `ecosystem`
- **Repo** : `opencode-observability` = `/root/orchestrator-panel` (branche `feature/migration-postgresql`)
- **Périmètre** : `/root/orchestrator-panel/public/docs/` (docs servis par le panneau sur `/docs/…`)
- **Date** : 2026-09-21

---

## 1. Objectif

Mettre à jour la **documentation d'écosystème** (`public/docs/`) pour qu'elle décrive **le code réellement déployé** : ADR structurées (champs + rattachement projet/repos + ADR globale + pièces jointes), famille MCP `adr_*`, gouvernance ADR en recette/test (vigilances, blocage de `recette_confirm`, levée tracée), gestionnaire central d'artefacts (table polymorphe `artifacts`, taxonomie, neutralisation legacy) et nouvelle organisation des onglets du panneau.

## 2. Contexte & raison d'être

Plusieurs évolutions ont été livrées et déployées (voir plans/rapports de session : `Plan-adr-modele-structure-*`, `Plan-adr-pieces-jointes-*`, `Plan-adr-expositions-mcp-agents-panneau-*`, `Plan-adr-gouvernance-recette-*`, `Plan-artefacts-fusion-polymorphe-*`, `Plan-onglet-adr-projet-*`), mais la documentation d'écosystème (`public/docs/01..12`, `README.md`, `CHANGELOG.md`) reste **en retard** :

- `12-documents-reference-projets-repos.md` décrit encore le stockage `docs` + `doc_projects`/`doc_repos` (l.28-30, 72-80) alors que le stockage est **rebasé sur la table polymorphe `artifacts`** (`doc_type` ∈ {adr, specs, gherkin, project_doc, adr_file}).
- `05-reference.md` décrit `artifacts` comme « Documents liés — `artifact_id`, `task_id`, `kind`, `path` » (l.24) : obsolète (le couple `doc_type`/`content_id` remplace `task_id`, cf. `schema.sql` l.127-149).
- `02-composants.md` liste les onglets « Événements, Déploiements, Documents, Plans » (l.21-23) alors que `PROJECT_TABS` (`public/app.js` l.110-120) expose désormais **Artefacts** et **ADR** et a **retiré** Déploiements/Événements/Plans (accès via le modal de tâche, `app.js` l.5172-5176).
- La **famille MCP `adr_*`** (12 tools, `index.mjs` l.522-729), la **gouvernance ADR en recette** (table `adr_vigilances`, blocage `recette_confirm`, `index.mjs` l.1033) et les **pièces jointes d'ADR** (`doc_type='adr_file'`) ne sont documentées nulle part dans `public/docs/`.

**Sources de vérité exploitées** (lecture seule) :
- MCP : `mcp/task-orchestrator/index.mjs` (tools `adr_*` l.522-729, `doc_*` l.375-464, `artifact_*` l.1808-1858, `recette_confirm` l.1033), `db.mjs` (`DOC_TYPES` l.1667, `DOCS_DOC_TYPES` l.1669, `ADR_VIGILANCE_*` l.2157), `schema.sql` (`artifacts` l.127-149, `artifact_projects`/`artifact_repos` l.156-168, `adr_conflicts` l.185-196, `adr_vigilances` l.386-409, legacy l.170-177, 371-374).
- Panneau : `public/app.js` (`GLOBAL_TABS` l.102-108, `PROJECT_TABS` l.110-120, onglet ADR l.4246-4533, onglet Artefacts l.1210-1235, vigilances l.372-473), `server.mjs` (route `/docs/` l.1446-1449, `/api/artifacts` l.1999-2013, `/api/adr-vigilances` l.2141-2162, `recette` l.2252-2259).
- Taxonomie : `public/docs/nomenclature-doc-type.md` (**référentiel à ne pas dupliquer, seulement référencer**).

**Contraintes** : doc **conforme au code** (pas d'intention) ; ne pas casser les liens ni la table des matières ; renvoyer à `nomenclature-doc-type.md` pour la taxonomie ; vérifier le rendu `/docs/…` (panneau relancé sans CI).

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|---|---|---|---|---|---|---|
| A001 | Créer | nouveau document `13-adr-et-artefacts.md` (5 sections) | — | `public/docs/13-adr-et-artefacts.md` | Regrouper le thème cohérent ADR structurées + `adr_*` + gouvernance + artefacts | Doc autonome, référencé par les autres |
| A002 | Modifier | table des matières (l.12-26) | `public/docs/README.md` | `public/docs/README.md` | Navigation : ajouter le doc 13 + la nomenclature | TOC à jour, liens valides |
| A003 | Remplacer | modèle `docs`/`doc_projects`/`doc_repos` → `artifacts`/`artifact_projects`/`artifact_repos` (§2 l.28-30, §4 l.72-80) | `public/docs/12-documents-reference-projets-repos.md` | idem | Le stockage ADR-12 est rebasé sur `artifacts` | §2/§4 conformes au schéma |
| A004 | Remplacer | ligne `artifacts` du modèle de données (§1, l.24 FR + l.125 EN) | `public/docs/05-reference.md` | idem | `artifacts` est polymorphe (`doc_type`/`content_id`) | §1 conforme (`schema.sql` l.127-168) |
| A005 | Ajouter | §1 tables `adr_conflicts`/`adr_vigilances` + legacy ; §2 machine à états ADR ; §5 glossaire | `public/docs/05-reference.md` | idem | Décrire conflits, vigilances, cycle de vie ADR | §1/§2/§5 à jour |
| A006 | Modifier | liste des onglets du panneau (§1, l.21-23 FR + l.146-147 EN) | `public/docs/02-composants.md` | idem | `PROJECT_TABS` a changé (`app.js` l.110-120) | Onglets conformes |
| A007 | Modifier | liste des tables du registre + outils MCP clés (§4, l.94-103 FR + l.178-184 EN) | `public/docs/02-composants.md` | idem | `schema.sql` + `index.mjs` ont évolué | §4 conforme |
| A008 | Ajouter | section gouvernance ADR dans la recette (§1bis, après l.61) | `public/docs/03-workflow.md` | idem | Décrire le blocage `recette_confirm` + levée tracée | §1bis conforme |
| A009 | Ajouter | table des concepts clés (§2, l.33-42) | `public/docs/01-architecture.md` | idem | Introduire « ADR structurée » et « Artefact » | Concepts à jour |
| A010 | Modifier | note de rattachement ADR N:N (après l.47) | `public/docs/09-modele-projets-repos.md` | idem | Le rattachement passe par `artifact_projects`/`artifact_repos` | Conforme |
| A011 | Ajouter | entrée de changelog en tête (après l.6) | `public/docs/CHANGELOG.md` | idem | Tracer les livraisons du 2026-09-21 | Entrée ajoutée |
| A012 | Vérifier | liens relatifs + route `/docs/*.md` | `public/docs/*` | — | Vérifier que le panneau sert les docs (sans CI) | Rapport de vérification, 0 lien cassé |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---|---|
| `public/docs/13-adr-et-artefacts.md` | **Création** |
| `public/docs/README.md` | Modification (table des matières) |
| `public/docs/01-architecture.md` | Modification (§2 concepts) |
| `public/docs/02-composants.md` | Modification (§1 onglets, §4 tables/MCP, FR+EN) |
| `public/docs/03-workflow.md` | Modification (§1bis gouvernance ADR) |
| `public/docs/05-reference.md` | Modification (§1 modèle de données, §2 machine à états ADR, §5 glossaire, FR+EN) |
| `public/docs/09-modele-projets-repos.md` | Modification (rattachement ADR) |
| `public/docs/12-documents-reference-projets-repos.md` | Modification (§2/§4 rebasage `artifacts`) |
| `public/docs/CHANGELOG.md` | Modification (entrée 2026-09-21) |

> `public/docs/nomenclature-doc-type.md` : **non modifié** (référentiel de la taxonomie — seulement référencé par les autres docs).

## 5. Livrables attendus

1. Nouveau doc `public/docs/13-adr-et-artefacts.md` (modèle ADR structuré, famille `adr_*`, gouvernance ADR en recette, gestionnaire central d'artefacts + renvoi taxonomie).
2. `README.md` : table des matières incluant `13-adr-et-artefacts.md` et `nomenclature-doc-type.md`.
3. `12-documents-reference-projets-repos.md` : stockage décrit comme la table polymorphe `artifacts` (+ `artifact_projects`/`artifact_repos`), renvoi vers 13 et `nomenclature-doc-type.md`.
4. `05-reference.md` : modèle de données (artefacts polymorphes, `adr_conflicts`, `adr_vigilances`, tables legacy `legacy_*`) + machine à états ADR (`Proposé → Accepté → Déprécié → Remplacé`) + glossaire enrichi.
5. `02-composants.md` : onglets du projet (`Artefacts`, `ADR` ; retrait Déploiements/Événements/Plans) + tables/outils MCP à jour.
6. `03-workflow.md` : gouvernance ADR en recette (vigilance globale bloquante, raison explicite, levée tracée 2 canaux, historique append-only).
7. `01-architecture.md` : concepts « ADR structurée » et « Artefact ».
8. `09-modele-projets-repos.md` : rattachement N:N ADR↔projet/repo via `artifact_projects`/`artifact_repos`.
9. `CHANGELOG.md` : entrée datée 2026-09-21.
10. Vérification des liens `/docs/…` (aucun lien cassé, doc 13 servi).

## 6. Ordre & dépendances

```
A001 ──▶ A002            (la TOC référence le fichier 13 qui doit exister)
A001 ──▶ A003            (le doc 12 renvoie vers 13)
A001 ──▶ A008            (le workflow renvoie vers 13)
A001 ──▶ A009            (l'archi renvoie vers 13)
A001 ──▶ A010            (le modèle projets/repos renvoie vers 13)
A004 ──▶ A005            (même fichier 05-reference.md : §1 puis §2/§5, régions ordonnées)
A006 ──▶ A007            (même fichier 02-composants.md : §1 puis §4)
{A001..A011} ──▶ A012    (vérification finale des liens/rendu)
A011 après A001..A010    (le changelog décrit l'état final)
```

- **Séquences obligatoires** : A001 avant A002/A003/A008/A009/A010 (cibles des liens) ; A004 avant A005 ; A006 avant A007.
- **Parallélisables** (fichiers distincts) : A003, A004, A006, A008, A009, A010 — mais ordre recommandé A001 → A002 → A003/A004 → A005 → A006 → A007 → A008/A009/A010 → A011 → A012.

## 7. Couverture des objectifs

| Exigence (critère d'acceptation) | Étape(s) | Couvert ? |
|---|---|---|
| Doc décrit le modèle ADR structuré (champs + rattachement 1..N repos + ADR globale + pièces jointes) | A001, A003, A005, A010 | ✅ |
| Doc décrit la famille MCP `adr_*` (lecture/contexte, cycle de vie, signalement, vigilances) | A001, A007 | ✅ |
| Doc décrit la gouvernance ADR en recette (vigilance globale, blocage `recette_confirm`, levée tracée) | A001, A008 | ✅ |
| Doc décrit le gestionnaire central d'artefacts (table polymorphe, `doc_type`/`content_id`, taxonomie, neutralisation legacy) | A001, A003, A004, A005 | ✅ |
| Doc reflète l'organisation des onglets du panneau (ADR du projet, Artefacts, retrait Déploiements/Événements/Plans) | A006 | ✅ |
| Table des matières et CHANGELOG cohérents ; contenu conforme au code déployé | A002, A011, A012 | ✅ |
| (Mission) Vérification du rendu `/docs/…` sans CI | A012 | ✅ |
| (Mission) Taxonomie renvoyée à `nomenclature-doc-type.md` (pas dupliquée) | A001, A002, A003 | ✅ |

## 8. Vérification de cohérence

**Analyse intra-plan (Phases 6-7)** — regroupement par élément cible :

| Élément cible | Étapes | Verdict |
|---|---|---|
| `public/docs/13-adr-et-artefacts.md` | A001 (créer) | ✅ création unique |
| `public/docs/README.md` | A002 (modifier) | ✅ action unique |
| `public/docs/12-documents-reference-projets-repos.md` | A003 (remplacer) | ✅ action unique |
| `public/docs/05-reference.md` | A004 (§1), A005 (§2/§5) | ✅ régions disjointes, ordre A004→A005, aucune action contradictoire |
| `public/docs/02-composants.md` | A006 (§1), A007 (§4) | ✅ régions disjointes, ordre A006→A007 |
| `public/docs/03-workflow.md` | A008 (ajouter) | ✅ action unique |
| `public/docs/01-architecture.md` | A009 (ajouter) | ✅ action unique |
| `public/docs/09-modele-projets-repos.md` | A010 (modifier) | ✅ action unique |
| `public/docs/CHANGELOG.md` | A011 (ajouter) | ✅ action unique |

- **Aucune contradiction** : aucun couple `supprimer` + autre action sur le même élément ; aucun élément créé puis renommé/supprimé ; aucune lecture d'un élément créé par une étape ultérieure (A012 vérifie après A001-A011).
- **Aucune étape vague** : chaque étape cible un fichier + une section/élément précis avec un verbe d'action.
- **Couverture 100 %** : toutes les exigences ont ≥1 étape (cf. §7).

**Plan Validator : ✅ VALID** (aucune contradiction, aucune exigence non couverte, aucune étape vague).

## 9. Risques & notes

- **Conformité au code** : ne décrire que ce qui existe réellement dans `index.mjs`/`db.mjs`/`schema.sql`/`app.js` (versions lues le 2026-09-21, branche `feature/migration-postgresql`). Ne pas documenter d'intention.
- **Liens** : la route `/docs/*.md` (`server.mjs` l.1446-1449) sert tout `.md` sous `public/` sans liste blanche — le nouveau doc 13 sera servi automatiquement ; vérifier néanmoins les liens **relatifs** de la TOC.
- **Taxonomie** : ne pas recopier la table `doc_type` dans le doc 13 (risque de divergence) — y renvoyer.
- **Doc bilingue** : `02-composants.md` et `05-reference.md` ont une section EN ; garder la parité FR/EN lors des modifications.
- **E2E** : tâche de **documentation** sans comportement utilisateur observable → **E2E NA** (pas de test Playwright à créer/lier).
- **Vérification A012** : contrôle non destructif (ex. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/docs/13-adr-et-artefacts.md` attendu `200`, et vérification de l'existence des cibles de liens).
