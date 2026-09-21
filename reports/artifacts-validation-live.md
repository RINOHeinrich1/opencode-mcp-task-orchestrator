# Validation post-migration — fusion artefacts polymorphe

- Généré : 2026-09-21T06:27:46.396Z
- **Verdict : PASS**

| Contrôle | Verdict | Détail |
|----------|---------|--------|
| unicité artifact_id (aucun doublon) | PASS | 0 doublon(s) |
| docs → artifacts (aucune perte) | PASS | 5 docs, 5 artefacts famille docs, 0 manquant(s) |
| recette_documents → artifacts (aucune perte) | PASS | 30 docs recette, 30 artefacts recette, 0 manquant(s) |
| doc_attachments → artifacts (aucune perte) | PASS | 0 pièces jointes, 0 artefacts adr_file, 0 manquant(s) |
| doc_projects → artifact_projects | PASS | 5 liens source, 5 liens cible |
| doc_repos → artifact_repos | PASS | 5 liens source, 5 liens cible |
| ADR : status conservé (échantillon global) | PASS | 0 écart(s) de statut |
| meta TEXT → JSONB (encapsulation des valeurs non-JSON) | PASS | 0 meta legacy non-JSON, 0 encapsulée(s) |
| rétrocompat artifact_list(taskId) | PASS | task=T-20260920-162801-jxtr, 2 artefact(s) |
| rétrocompat recette_get → documents (documentId entier) | PASS | recette=RECT-mu6zvvkm-8g1l, 4 document(s) |
| rétrocompat doc_list(includeRepoDocs) | PASS | projet=mada-talk, 4 doc(s) |
| rétrocompat doc_get/adr_get | PASS | adr=doc-mtq4xd2g-togu |
| jointures E2E (report_artifact_id résout un artefact) | PASS | 50 exécution(s) avec preuve, 0 cible(s) introuvable(s) |
