// secret-crypto.mjs — Chiffrement AES-256-GCM des secrets E2E (valeurs jamais en clair).
//
// La clé vit dans un fichier root-only HORS registre/repo :
//   /root/.config/opencode/e2e-secrets.key  (0600, généré au premier usage)
// Format d'une valeur chiffrée stockée :  base64url(iv) ":" base64url(tag) ":" base64url(ciphertext)
// Chaque chiffrement génère un IV aléatoire (12 octets) ; tag 16 octets (GCM).
import { randomBytes, createCipheriv, createDecipheriv, generateKeySync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const KEY_FILE = "/root/.config/opencode/e2e-secrets.key";
let cachedKey = null;

function loadOrCreateKey() {
  if (cachedKey) return cachedKey;
  try {
    if (!existsSync(KEY_FILE)) {
      mkdirSync(dirname(KEY_FILE), { recursive: true });
      const key = generateKeySync("aes", { length: 256 }).export().toString("hex");
      writeFileSync(KEY_FILE, key, { mode: 0o600 });
      chmodSync(KEY_FILE, 0o600);
    }
    const raw = readFileSync(KEY_FILE, "utf8").trim();
    if (raw.length < 64) throw new Error(`clé invalide (${KEY_FILE}) — longueur ${raw.length}`);
    cachedKey = Buffer.from(raw, "hex");
    return cachedKey;
  } catch (e) {
    throw new Error(`secret-crypto: impossible de charger la clé (${KEY_FILE}) : ${e.message}`);
  }
}

export function encryptSecret(plaintext) {
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

export function decryptSecret(payload) {
  const key = loadOrCreateKey();
  const parts = String(payload || "").split(":");
  if (parts.length !== 3) throw new Error("payload secret invalide");
  const iv = Buffer.from(parts[0], "base64url");
  const tag = Buffer.from(parts[1], "base64url");
  const enc = Buffer.from(parts[2], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
