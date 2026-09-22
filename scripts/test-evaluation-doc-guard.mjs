#!/usr/bin/env node
// Test de non-régression — GARDE CIBLÉE des pièces d'ÉVALUATION.
//
// Vérifie que :
//   1. la garde AUTORITATIVE des pièces CLIENT (`assertPieceAllowed`) continue de
//      REFUSER les PHOTOS et VIDÉOS (import de fichier par extension ET lien
//      externe par hôte/extension) — comportement INCHANGÉ ;
//   2. la nouvelle garde CIBLÉE (`assertRecetteDocAllowed`) ADMET
//      explicitement les PHOTOS et VIDÉOS pour les pièces d'une cadrage de
//      l'évaluateur (`doc_type='recette_doc'`), à l'import comme pour un lien ;
//   3. la nature est VALIDÉE contre l'allow-list `RECETTE_DOC_NATURES` et
//      RÉSOLUE par extension.
//
// Le test n'utilise QUE des fonctions PURES (aucune connexion base) : il importe
// `db.mjs` (le pool PostgreSQL est créé paresseusement, jamais ouvert ici).
//
// Usage : node scripts/test-recette-doc-guard.mjs
import {
  assertPieceAllowed,
  assertRecetteDocAllowed,
  RECETTE_DOC_NATURES,
  PIECE_NATURES,
} from "../db.mjs";

let failures = 0;
const results = [];

function ok(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures += 1;
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `\n        attendu: ${e}\n        obtenu : ${a}`}`);
}

function throws(name, fn) {
  let threw = false;
  let msg = "";
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  if (!threw) failures += 1;
  results.push(`${threw ? "PASS" : "FAIL"}  ${name}${threw ? "" : " (aucune erreur levée)"}${threw && msg ? `\n        → ${msg}` : ""}`);
}

// ---------------------------------------------------------------------------
// 0. Contrat : allow-lists distinctes (photo/vidéo admises côté évaluation).
// ---------------------------------------------------------------------------
ok("PIECE_NATURES n'admet PAS photo", PIECE_NATURES.includes("photo"), false);
ok("PIECE_NATURES n'admet PAS video", PIECE_NATURES.includes("video"), false);
ok("RECETTE_DOC_NATURES = [lien,document,photo,video,maquette,performance]", RECETTE_DOC_NATURES, ["lien", "document", "photo", "video", "maquette", "performance"]);

// ---------------------------------------------------------------------------
// 1. GARDE PIÈCES CLIENT (assertPieceAllowed) — PHOTO/VIDÉO TOUJOURS REFUSÉES.
// ---------------------------------------------------------------------------
throws("client — import photo (.jpg) refusé", () => assertPieceAllowed({ nature: "photo", path: "/tmp/a.jpg" }));
throws("client — import photo (.png) refusé (extension)", () => assertPieceAllowed({ path: "/tmp/a.png" }));
throws("client — import vidéo (.mp4) refusé", () => assertPieceAllowed({ nature: "video", path: "/tmp/v.mp4" }));
throws("client — import vidéo (.mov) refusé (extension)", () => assertPieceAllowed({ path: "/tmp/v.mov" }));
throws("client — lien vidéo (youtube.com) refusé", () => assertPieceAllowed({ url: "https://www.youtube.com/watch?v=abc" }));
throws("client — lien photo (extension .jpg) refusé", () => assertPieceAllowed({ url: "https://exemple.fr/photo.jpg" }));
throws("client — nature 'photo' sans fichier refusée", () => assertPieceAllowed({ nature: "photo" }));

// Pièces client LÉGITIMES : comportement inchangé.
ok("client — markdown accepté", assertPieceAllowed({ nature: "markdown", path: "/tmp/a.md" }), "markdown");
ok("client — pdf déduit de l'extension", assertPieceAllowed({ path: "/tmp/a.pdf" }), "pdf");
ok("client — docx déduit de l'extension", assertPieceAllowed({ path: "/tmp/a.docx" }), "docx");
ok("client — lien Drive accepté", assertPieceAllowed({ nature: "lien", url: "https://drive.google.com/file/d/abc/view" }), "lien");

// ---------------------------------------------------------------------------
// 2. GARDE CIBLÉE ÉVALUATION (assertRecetteDocAllowed) — PHOTO/VIDÉO ADMISES.
// ---------------------------------------------------------------------------
ok("évaluation — photo (.jpg) admise", assertRecetteDocAllowed({ nature: "photo", path: "/tmp/a.jpg" }), "photo");
ok("évaluation — vidéo (.mp4) admise", assertRecetteDocAllowed({ nature: "video", path: "/tmp/v.mp4" }), "video");
ok("évaluation — photo déduite de l'extension (.png)", assertRecetteDocAllowed({ path: "/tmp/a.png" }), "photo");
ok("évaluation — vidéo déduite de l'extension (.mov)", assertRecetteDocAllowed({ path: "/tmp/v.mov" }), "video");
ok("évaluation — photo via filename (.jpeg)", assertRecetteDocAllowed({ filename: "capture.jpeg" }), "photo");
ok("évaluation — lien photo admis (URL .jpg)", assertRecetteDocAllowed({ nature: "photo", path: "https://exemple.fr/photo.jpg" }), "photo");
ok("évaluation — lien vidéo admis (nature explicite + URL)", assertRecetteDocAllowed({ nature: "video", path: "https://www.youtube.com/watch?v=abc" }), "video");
ok("évaluation — document déduit (.pdf)", assertRecetteDocAllowed({ path: "/tmp/rapport.pdf" }), "document");
ok("évaluation — document déduit (.md)", assertRecetteDocAllowed({ path: "/tmp/notes.md" }), "document");
ok("évaluation — lien explicite (path = URL)", assertRecetteDocAllowed({ nature: "lien", path: "https://drive.google.com/file/d/abc/view" }), "lien");
ok("évaluation — url dédiée → 'lien'", assertRecetteDocAllowed({ url: "https://exemple.fr/page" }), "lien");
ok("évaluation — sans nature ni localisation → null (legacy)", assertRecetteDocAllowed({}), null);
ok("évaluation — nature inconnue sans extension → 'document'", assertRecetteDocAllowed({ path: "/tmp/fichier" }), "document");

// Nature hors allow-list → refus explicite.
throws("évaluation — nature 'markdown' refusée (hors allow-list)", () => assertRecetteDocAllowed({ nature: "markdown", path: "/tmp/a.md" }));
throws("évaluation — nature 'pdf' refusée (hors allow-list)", () => assertRecetteDocAllowed({ nature: "pdf", path: "/tmp/a.pdf" }));

// ---------------------------------------------------------------------------
console.log("\n=== Test non-régression — garde ciblée pièces d'évaluation ===");
for (const r of results) console.log(r);
const total = results.length;
console.log(`\n${failures === 0 ? "OK" : "ÉCHEC"} — ${total - failures}/${total} assertions passées`);
process.exit(failures === 0 ? 0 : 1);
