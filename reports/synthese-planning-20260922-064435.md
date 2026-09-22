# Synthèse de planification — T-20260922-064200-e0yw

- **Tâche** : `T-20260922-064200-e0yw` — exécution `E-T-20260922-064200-e0yw-lnf52t`
- **Projet** : `ecosystem`
- **Date** : 2026-09-22 06:44:35
- **Agent** : `atomic-plan` (planner)

## 1. Objectifs identifiés (Phase 0)

| # | Objectif | Nature | Décision de segmentation |
|---|----------|--------|--------------------------|
| O1 | Filtre par SPRINT dans les sous-onglets Fonctionnalités & Règles (options = sprints du projet + « Sans sprint »), filtrage client persisté, ids de sprints liés exposés par la requête bulk (0 N+1) | feature panneau + registre | **Fusionné dans un plan unique** (voir §3) |
| O2 | Association EXPLICITE de rôles aux règles métier (1..N rôles OU rôle GLOBAL), de bout en bout (modèle + migration idempotente + MCP + panneau), remplaçant le champ `roles` dérivé | feature registre + panneau | **Fusionné dans un plan unique** (voir §3) |

## 2. Plans générés (Phase 8)

| PlanId | Objectif | Étapes | Fichier |
|--------|----------|--------|---------|
| `Plan-sprint-filter-roles-regles-20260922-064347` | O1 + O2 (plan unique) | 27 (A001→A027) | `plans/Plan-sprint-filter-roles-regles-20260922-064347.md` |

- Enregistré en base : **oui** (`plan_register`, taskId `T-20260922-064200-e0yw`).
- Artefact rattaché : **oui** (`artifact_add`, kind=plan, `ART-mucb6x0k-0vd1`).
- Événement : `PLAN_CREATED` publié sur la tâche.

## 3. Décision de segmentation (objectifs O1/O2)

O1 et O2 sont **sémantiquement indépendants** mais **fortement couplés au niveau du code** : les deux modifient les mêmes fonctions/fichiers (`ruleLinkCounts`, `listRules`, `index.mjs`, `frFilterRules`, `renderFrRulePanel`). Deux plans concurrents auraient généré des **contradictions inter-plans** (mêmes régions de fichiers). Conformément à la règle « objectifs interdépendants = un seul plan », un **plan unique ordonné** a été produit.

## 4. Décisions tranchées explicitement

1. **Champ `roles` dérivé → REMPLACÉ, sans repli d'affichage.** La dérivation (`array_agg(DISTINCT fonctionnalites.role)`) est retirée de `ruleLinkCounts` ; `roles`/`roleGlobal` sont lus depuis `regles_metier`. `links` reste strictement `{features, sprints}` ; `sprintIds` est additif top-level. Pas de backfill automatique (les règles existantes démarrent « Sans rôle »).
2. **Vocabulaire des rôles = rôles distincts du projet** : union des `fonctionnalites.role` + rôles explicitement déjà associés à des règles. **Pas de référentiel dédié**, **pas de saisie libre** (multi-sélection), pour un filtre cohérent.
3. **Modèle = colonnes** `regles_metier.roles TEXT[] NOT NULL DEFAULT '{}'` + `regles_metier.role_global INTEGER NOT NULL DEFAULT 0` (plutôt qu'une table de liaison), miroir du booléen `is_global` des ADR ; `SELECT *` suffit → 0 requête supplémentaire.
4. **« Persisté » = état module** (comme les filtres existants, survit au polling), pas de localStorage.
5. **Sémantique « Global »** : une règle globale est retenue par tout filtre rôle spécifique **et** par l'option « Global » ; elle n'est pas « Sans rôle ».

## 5. Vérifications de cohérence

### 5.1 Intra-plan (Phases 6-7)

- Contradictions par élément cible : **aucune** (création colonnes → lecture/écriture ; `links` jamais modifié ; une seule étape par fonction sensible).
- Ordre/dépendances : respecté (A001/A002 → A005/A006 ; A007 → A008 ; A009 → A010 ; registre → panneau → validation A027).
- Couverture des critères d'acceptation : **100 %** (table de couverture du plan, §7).
- Gate Plan Validator : **Valid**.

### 5.2 Globale (Phase 9)

- Un seul plan → **aucune contradiction inter-plans** à signaler.
- Aucune ADR enregistrée pour `ecosystem` (`adr_list` → 0) → aucun conflit ADR.
- **Aucune incohérence** nécessitant `INCONSISTENCY_FOUND`.

## 6. Contraintes de performance

- `sprintIds` : sous-requête scalaire `array_agg` ajoutée dans la requête `unnest` existante → **1 aller-retour, 0 N+1**.
- Retrait de la sous-requête `roles` dérivée → **réduction** du coût de `ruleLinkCounts`.
- `links` inchangé ; client MCP persistant et `schema_meta` non touchés.

## 7. Tests E2E (cadrage)

**E2E NA** : aucun dépôt du projet `ecosystem` ne contient de configuration Playwright (`playwright.config.*` absent des deux repos). Aucun test E2E à enregistrer. Validation : `node --check` + **spawn MCP réel**.

## 8. Prochaine étape

Exécution du plan `Plan-sprint-filter-roles-regles-20260922-064347` par l'agent `build`/`build-notify` (branche de travail dédiée par repo via session-guard ; ne pas laisser le checkout principal `/root/orchestrator-panel` sur une branche de travail).
