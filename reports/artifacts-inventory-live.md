# Inventaire pré-migration — fusion artefacts polymorphe

- Généré : 2026-09-21T06:27:14.808Z
- Base : `postgres://orchestrator:***@localhost:5432/task_registry`

| Source | Existe | Total |
|--------|--------|-------|
| `artifacts` | oui | 770 |
| `recette_documents` | oui | 30 |
| `docs` | oui | 5 |
| `doc_attachments` | oui | 0 |
| `doc_projects` | oui | 5 |
| `doc_repos` | oui | 5 |

## Détail

### `artifacts`
Par `kind` : `audit`=1, `autre`=13, `plan`=184, `report`=572
Par `doc_type` : —

Échantillon (max 5) :
```json
[
  {
    "artifact_id": "ART-T-20260828-152254-mtd9vczm-90jw",
    "doc_type": null,
    "content_id": "T-20260828-152254",
    "kind": "plan",
    "title": "Plan-precharger-comptes-audio-read-model-20260828-181303",
    "path": "/var/lib/docker/volumes/coder-3b96a73a-fad9-457e-b291-be70a9fcc2f5-home/_data/oniria/plans/Plan-precharger-comptes-audio-read-model-20260828-181303.md",
    "created_at": "2026-08-28T18:15:37.858Z"
  },
  {
    "artifact_id": "ART-T-20260828-152254-mtdao48v-sn8j",
    "doc_type": null,
    "content_id": "T-20260828-152254",
    "kind": "report",
    "title": "Rapport exécution — précharger comptes audio (read model)",
    "path": "/var/lib/docker/volumes/coder-3b96a73a-fad9-457e-b291-be70a9fcc2f5-home/_data/oniria/reports/report-precharger-comptes-audio-read-model-20260828-183713.md",
    "created_at": "2026-08-28T18:37:59.552Z"
  },
  {
    "artifact_id": "ART-T-20260828-152254-mtdbf2f0-mw16",
    "doc_type": null,
    "content_id": "T-20260828-152254",
    "kind": "report",
    "title": "report-merge-release-deploy-chatbot-management",
    "path": "/var/lib/docker/volumes/coder-3b96a73a-fad9-457e-b291-be70a9fcc2f5-home/_data/oniria/reports/report-merge-release-deploy-chatbot-management-20260828-185812.md",
    "created_at": "2026-08-28T18:58:56.892Z"
  },
  {
    "artifact_id": "ART-T-20260828-152254-mtdbiu84-7rmm",
    "doc_type": null,
    "content_id": "T-20260828-152254",
    "kind": "report",
    "title": "Rapport de clôture T-20260828-152254",
    "path": "/tmp/opencode/task-T-20260828-152254-final-report.md",
    "created_at": "2026-08-28T19:01:52.900Z"
  },
  {
    "artifact_id": "ART-T-20260829-115442-mted8uv6-ck1w",
    "doc_type": null,
    "content_id": "T-20260829-115442",
    "kind": "plan",
    "title": "Plan-restaurer-variables-contexte-canoniques-20260829-123630",
    "path": "/var/lib/docker/volumes/coder-3b96a73a-fad9-457e-b291-be70a9fcc2f5-home/_data/oniria/plans/Plan-restaurer-variables-contexte-canoniques-20260829-123630.md",
    "created_at": "2026-08-29T12:37:52.578Z"
  }
]
```

### `recette_documents`

Échantillon (max 5) :
```json
[
  {
    "id": 3,
    "recette_id": "RECT-mtixray1-rlmj",
    "title": "Spécificité fonctionnelle",
    "nature": "Nous avons créé le package **`madatalk-requests`** et traité plusieurs incohérences. Ces tâches sont issues des **spécifications fonctionnelles** et doivent donc les respecter.\n\nL’objectif est que le package **`madatalk-requests`** serve principalement aux **administrateurs MadaTalk** et aux **opérateurs Havet**. Il sert également de **backend pour le panneau client**.\n\nEn revanche, le **client final** doit disposer d’un **panneau frontend indépendant d’ONIRIA**. En effet, **ONIRIA est destiné uniquement aux utilisateurs internes** (administrateurs et opérateurs Havet) et ne doit pas constituer l’interface frontend du client.\nEn résumé le spécificité fonctionnel est notre fichier de référence pour les fonctionnalités obligatoirement présent, et les règles métier à respecter. Il y a juste cette contrainte sur le frontend du client",
    "source": "import",
    "path": "/root/orchestrator-panel/storage/recette-docs/RECT-mtixray1-rlmj-1788283390287-sp_cificit_fonctionnel.md",
    "artifact_id": null,
    "created_at": "2026-09-01T17:23:10.695Z"
  },
  {
    "id": 5,
    "recette_id": "RECT-mtixray1-rlmj",
    "title": "Rapport de revue comparative — madatalk-requests vs spec fonctionnelle",
    "nature": "Rapport de la revue US par US réalisée en recette : comparaison entre le package madatalk-requests (v0.2.10) et le document « Spécificité fonctionnelle ». Couvre les rôles Opérateur Havet / Admin (fullstack) et Client (backend endpoints). Détaille les constats (conformes, écarts 2a/2b/2c/2d, 3-US003/009, 4a/4b) et propose une classification + scope pour chaque élément. À exploiter pour la liste consolidée de la recette.",
    "source": "import",
    "path": "/var/lib/docker/volumes/coder-3b96a73a-fad9-457e-b291-be70a9fcc2f5-home/_data/oniria/reports/rapport-recette-revue-comparative-madatalk-requests-spec-fonctionnelle-20260902.md",
    "artifact_id": null,
    "created_at": "2026-09-02T04:52:12.264Z"
  },
  {
    "id": 6,
    "recette_id": "RECT-mtjmkf62-bpm7",
    "title": "Synthèse — Affinement ONIRIA pour besoins madatalk (RECT-mtjmkf62-bpm7)",
    "nature": "Synthèse de la session de recette exploratoire : rappel des 4 axes de besoins, cartographie des points d'ancrage dans l'existant (modèle P22, /v2/access, navigation/Toolbox, redirection post-auth), liste des 6 éléments feature enregistrés (T1–T6) et points de vigilance. À exploiter comme vue d'ensemble avant la clôture et la création des tâches.",
    "source": "import",
    "path": "/tmp/opencode/recette-mtjmkf62-bpm7/synthese-affinement-oniria-madatalk.md",
    "artifact_id": null,
    "created_at": "2026-09-02T05:29:51.148Z"
  },
  {
    "id": 7,
    "recette_id": "RECT-mtl8jn0d-lomd",
    "title": "spécificité fonctionnel",
    "nature": "Spécificité fonctionnel de madatalk",
    "source": "import",
    "path": "/root/orchestrator-panel/storage/recette-docs/RECT-mtl8jn0d-lomd-1788422440785-sp_cificit_fonctionnel.md",
    "artifact_id": null,
    "created_at": "2026-09-03T08:00:41.185Z"
  },
  {
    "id": 9,
    "recette_id": "RECT-mtmoh3k0-wz17",
    "title": "Revue des scénarios E2E à couvrir",
    "nature": "Revue/tri des scénarios métier à couvrir par les tests E2E Playwright exploitables par l'IA (surfaces SPA client mada-talk, backoffice madatalk-requests, chatbot-management, cœur ONIRIA récent). Document de travail : à exploiter pendant la recette pour cadrer les éléments et lister les scénarios par parcours ; contient aussi les points de vigilance (session en mémoire, pause/résiliation = demandes approuvées admin) et les décisions à trancher avant rédaction des tests.",
    "source": "import",
    "path": "/root/orchestrator-panel/storage/recette-docs/RECT-mtmoh3k0-wz17-1788510942713-revue-scenarios-e2e.md",
    "artifact_id": null,
    "created_at": "2026-09-04T08:35:46.152Z"
  }
]
```

### `docs`

Échantillon (max 5) :
```json
[
  {
    "id": "doc-mtq4xd2g-togu",
    "kind": "adr-tech",
    "title": "ADR — Architecture technique Madatalk (état réel)",
    "path": "/var/lib/docker/volumes/coder-0cd77cec-d43b-40ef-8ead-bcd4bafc8921-home/_data/mada-talk/docs/adr-architecture-madatalk.md",
    "status": null,
    "is_global": 0,
    "created_at": "2026-09-06T18:18:13.480Z"
  },
  {
    "id": "doc-mtq5ofgk-9jfl",
    "kind": "specs-fonctionnelles",
    "title": "Spécification fonctionnelle — Madatalk (User stories + règles métier)",
    "path": "/var/lib/docker/volumes/coder-0cd77cec-d43b-40ef-8ead-bcd4bafc8921-home/_data/mada-talk/docs/specification-fonctionnelle-madatalk.md",
    "status": null,
    "is_global": 0,
    "created_at": "2026-09-06T18:39:16.292Z"
  },
  {
    "id": "doc-mtq5yrsh-mfp9",
    "kind": "scenarios-gherkin",
    "title": "Scénarios Gherkin — Madatalk (E2E à couvrir)",
    "path": "/var/lib/docker/volumes/coder-0cd77cec-d43b-40ef-8ead-bcd4bafc8921-home/_data/mada-talk/docs/scenarios-gherkin-madatalk.md",
    "status": null,
    "is_global": 0,
    "created_at": "2026-09-06T18:47:18.833Z"
  },
  {
    "id": "doc-mty5ccha-pxk5",
    "kind": "adr-tech",
    "title": "ADR-001 — Architecture extensible ONIRIA (packages V3 : build, staging, exécution)",
    "path": "/var/lib/docker/volumes/coder-3b96a73a-fad9-457e-b291-be70a9fcc2f5-home/_data/oniria/docs/adr/ADR-001-architecture-extensible-oniria.md",
    "status": null,
    "is_global": 0,
    "created_at": "2026-09-12T08:52:01.966Z"
  },
  {
    "id": "doc-mu5hetkk-41ms",
    "kind": "adr-tech",
    "title": "ADR-000 — Architecture de l'écosystème myxmax",
    "path": "/var/lib/docker/volumes/coder-3c6440d6-867a-4909-9210-01b754326a13-home/_data/myxmax/docs/adr/ADR-000-architecture-ecosysteme-myxmax.md",
    "status": null,
    "is_global": 0,
    "created_at": "2026-09-17T12:04:16.052Z"
  }
]
```

### `doc_attachments`

Échantillon (max 5) :
```json
[]
```

### `doc_projects`
Orphelins FK : 0

Échantillon (max 5) :
```json
[
  {
    "doc_id": "doc-mtq4xd2g-togu",
    "project_id": "mada-talk"
  },
  {
    "doc_id": "doc-mtq5ofgk-9jfl",
    "project_id": "mada-talk"
  },
  {
    "doc_id": "doc-mtq5yrsh-mfp9",
    "project_id": "mada-talk"
  },
  {
    "doc_id": "doc-mty5ccha-pxk5",
    "project_id": "oniria"
  },
  {
    "doc_id": "doc-mu5hetkk-41ms",
    "project_id": "myxmax"
  }
]
```

### `doc_repos`
Orphelins FK : 0

Échantillon (max 5) :
```json
[
  {
    "doc_id": "doc-mtq4xd2g-togu",
    "repo_id": "mada-talk"
  },
  {
    "doc_id": "doc-mtq5ofgk-9jfl",
    "repo_id": "mada-talk"
  },
  {
    "doc_id": "doc-mtq5yrsh-mfp9",
    "repo_id": "mada-talk"
  },
  {
    "doc_id": "doc-mty5ccha-pxk5",
    "repo_id": "oniria"
  },
  {
    "doc_id": "doc-mu5hetkk-41ms",
    "repo_id": "myxmax"
  }
]
```
