# Plan — Prompts agents : proposer les liens ADR / Fonctionnalité (validation humaine en recette)

- **Plan ID** : `Plan-prompts-liens-adr-fonctionnalite-20260921-112946`
- **Tâche** : `T-20260921-091737-79uj` (exécution `E-T-20260921-091737-79uj-9cx4t0`)
- **Batch** : `BATCH-mub1809u-06ow` (tâche 8/9) — recette source `RECT-muaz100k-2iq0`
- **Date** : 2026-09-21 11:29:46
- **Racine** : `/root/.config/opencode/mcp/task-orchestrator`

---

## 1. Objectif

Mettre à jour les prompts des agents **`agent-recette`**, **`build-notify`** et
**`test-agent`** pour qu'ils **proposent les liens ADR et fonctionnalité** au
rattachement des tâches, la **validation restant humaine (en recette)** — aucune
auto-validation, aucune création systématique d'ADR.

## 2. Contexte & raison d'être

- **T5** a livré les outils de liaison et le workflow ADR d'une tâche
  **`proposé → validé`** (`task_adr_propose` / `task_adr_validate`), ainsi que
  `task_feature_link`, `feature_gherkin_link`, `feature_adr_link`,
  `recette_*_link`. **T6** a livré les cardinalités heuristiques et la gouvernance
  de l'émergence (`cardinality_report`, `cardinality_signals_list`,
  `cardinality_signal_resolve`) et `task_register` accepte désormais
  `featureIds`/`sprintId`/`adrIds` (ADR proposées).
- Les prompts actuels des agents **ne mentionnent pas** ces liens : `agent-recette`
  ne propose pas la liaison fonctionnalité/ADR d'une tâche, `build-notify` ne
  propose pas `featureIds`/`adrIds` à la création, `test-agent` ne relie pas le
  test à une fonctionnalité. Il en résulte des tâches **sans fonctionnalité ni
  ADR effectif** (signalées mais non complétées).
- Cadre : **ADR-001** (fonctionnalités/règles/émergence) et la **gouvernance ADR**
  déjà en place (`adr_report_missing` / `adr_report_conflict` en recette). Les ADR
  restent des **décisions humaines** : un agent **propose**, l'humain **valide**.
- **Indépendance** : ce plan ne dépend d'aucune étape du plan
  `Plan-agent-session-sprint-20260921-112946` (fichiers et objectifs distincts) —
  deux objectifs non interdépendants → deux plans.

## 3. Tableau de synthèse des actions

| ID | Action | Élément de code | Fichier source | Fichier cible | Raison | Livrable attendu |
|----|--------|-----------------|----------------|---------------|--------|------------------|
| B001 | ajouter | Nouvelle section « Rattachement des tâches : liens Fonctionnalité / ADR (proposé → validé) » dans le corps du prompt, après la section « Gouvernance des ADR en recette » (l.222-260) | `/root/.config/opencode/agent/agent-recette.md` | idem | En recette, pour chaque tâche couverte : proposer la fonctionnalité (`task_feature_link`) et l'ADR (`task_adr_propose`), **faire valider** par l'humain (`task_adr_validate`), contrôler les cardinalités (`cardinality_report`) et tracer les émergents **sans bloquer** | Section ajoutée à `agent-recette.md` |
| B002 | ajouter | Nouvelle section « Liens Fonctionnalité / ADR à la création d'une tâche (proposé, non validé) » dans le corps du prompt, après la section « ADR de référence » (l.59-79) | `/root/.config/opencode/agent/build-notify.md` | idem | À la création/au traitement d'une tâche, proposer `featureIds` et `adrIds` à `task_register` (lien ADR en `propose`, jamais `valide`), et signaler les manques via `cardinality_signals_list` | Section ajoutée à `build-notify.md` |
| B003 | ajouter | Nouvelle section « Rattachement Fonctionnalité du test / ADR » dans le corps du prompt, après la section « Contexte du test (MCP) » (l.87-124) | `/root/.config/opencode/agent/test-agent.md` | idem | Relier le scénario Gherkin à une fonctionnalité (`feature_gherkin_link`) et signaler l'ADR manquante/à proposer — cohérence avec le modèle Fonctionnalités/Règles | Section ajoutée à `test-agent.md` |

## 4. Fichiers concernés

| Fichier | Type de modification |
|---------|----------------------|
| `/root/.config/opencode/agent/agent-recette.md` | modification (ajout d'une section) |
| `/root/.config/opencode/agent/build-notify.md` | modification (ajout d'une section) |
| `/root/.config/opencode/agent/test-agent.md` | modification (ajout d'une section) |

> Repo config opencode : `/root/.config/opencode/agent` (versionné, branche courante
> `feature/per-plan`). Modifications **additives** : ne rien retirer des sections
> existantes (elles couvrent déjà `adr_report_missing`/`adr_report_conflict`).

## 5. Livrables attendus

1. `agent-recette.md` : l'agent propose et fait **valider** les liens
   fonctionnalité/ADR des tâches couvertes (`task_feature_link`,
   `task_adr_propose` → `task_adr_validate` par l'humain), contrôle
   `cardinality_report`, trace les émergents sans bloquer.
2. `build-notify.md` : à la création d'une tâche, propose `featureIds`/`adrIds`
   (ADR en `propose`) et **ne valide jamais** ; signale les manques via
   `cardinality_signals_list`.
3. `test-agent.md` : relie le scénario Gherkin à une fonctionnalité
   (`feature_gherkin_link`) et signale l'ADR manquante (`adr_report_missing`) —
   sans créer d'ADR acceptée.
4. Aucune régression : les sections existantes des 3 prompts restent intactes.

## 6. Ordre & dépendances

```
B001 ─┐
B002 ─┼─  (indépendantes : 3 fichiers distincts, aucune dépendance croisée)
B003 ─┘
```

- Aucune dépendance entre B001, B002, B003 (fichiers distincts) : exécutables dans
  n'importe quel ordre.
- Ce plan est **indépendant** du plan `Plan-agent-session-sprint-20260921-112946`
  (aucun fichier commun).

## 7. Couverture des objectifs

| Exigence (mission / critère d'acceptation) | Étape(s) | Couvert ? |
|--------------------------------------------|----------|-----------|
| Mettre à jour le prompt `agent-recette` (proposer liens ADR/fonctionnalité, valider en recette) | B001 | ✅ |
| Mettre à jour le prompt `build-notify` (proposer liens ADR/fonctionnalité au rattachement des tâches) | B002 | ✅ |
| Mettre à jour le prompt `test-agent` (proposer liens ADR/fonctionnalité) | B003 | ✅ |
| Validation **humaine** (aucune auto-validation) | B001, B002, B003 (règles explicites `propose` vs `valide`) | ✅ |
| Pas de création systématique d'ADR | B001, B002, B003 (liaison à une ADR EXISTANTE ou signalement `adr_report_missing`) | ✅ |

## 8. Vérification de cohérence (Phases 6-7)

- **Contradictions intra-plan** : aucune. Chaque fichier est cible d'une seule
  étape (`agent-recette.md`→B001, `build-notify.md`→B002, `test-agent.md`→B003).
  Aucune étape `supprimer`, aucun `créer`+`renommer`.
- **Ordre/dépendances** : étapes parallélisables, aucune lecture d'un élément créé
  par une étape ultérieure.
- **Précision** : chaque étape nomme le fichier, la section d'insertion (avec
  bornes de lignes) et le contenu/outils MCP attendus.
- **Verdict : VALID** (couverture 100 %, aucune contradiction).

## 9. Risques & notes

- **Ne pas dupliquer** la gouvernance ADR déjà présente dans `agent-recette.md`
  (section « Gouvernance des ADR en recette ») : B001 doit **référencer** les
  outils existants et se concentrer sur le **rattachement de la tâche**.
- **Outils exacts** (noms MCP réels, T5/T6) : `task_feature_link`,
  `task_adr_propose`, `task_adr_validate`, `task_adr_list`,
  `feature_gherkin_link`, `feature_adr_link`, `cardinality_report`,
  `cardinality_signals_list`, `task_register` (`featureIds`/`adrIds`/`sprintId`).
- **Isolation (norme v1.0)** : repo `agent/` versionné sur `feature/per-plan` →
  travailler sur une **branche de travail dédiée** (via `session-guard.mjs`),
  jamais sur la branche courante.
- **Tests E2E (cadrage 08)** : **E2E NA** (modification de prompts d'agents, aucun
  comportement utilisateur observable ; `ecosystem` n'a aucun spec Playwright).
- **Traçabilité** : `task_event(taskId="T-20260921-091737-79uj")` par
  `build-notify` ; `plan_set_branch` en fin de sous-tâche.
