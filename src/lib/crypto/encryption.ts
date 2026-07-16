/**
 * Konode Encryption Module
 * Sprint 2 — End-to-End Encryption via Web Crypto API (AES-256-GCM)
 *
 * Design:
 *  - User provides a passphrase
 *  - PBKDF2 derives a 256-bit AES-GCM key (600k iterations, SHA-256)
 *  - Each encrypted blob has a random 12-byte IV prepended
 *  - Key never leaves the device; only the derived key is used in-memory
 *
 * Status: ACTIVE — wired into the sync engine, opt-in via settings.encryption_enabled.
 */

// ─── Constants ────────────────────────────────────────────────────────────

// OWASP 2023 minimum for PBKDF2-HMAC-SHA256. Raising this only affects newly
// written blobs (each blob carries its own salt; old data stays decryptable
// only if the count matches — E2EE was never active before, so there is none).
const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 16; // bytes
const IV_LENGTH = 12;   // bytes — optimal for AES-GCM
const KEY_LENGTH = 256; // bits

// ─── Key derivation ───────────────────────────────────────────────────────

/**
 * Derives an AES-GCM CryptoKey from a user passphrase.
 * The salt should be stored alongside encrypted data.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH },
    false, // non-extractable
    ["encrypt", "decrypt"]
  );
}

/**
 * Generates a new random salt for key derivation.
 */
export function generateSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

// ─── Encrypt ──────────────────────────────────────────────────────────────

/**
 * Encrypts a string payload with AES-256-GCM.
 * Returns a base64-encoded string: [salt(16)][iv(12)][ciphertext]
 */
export async function encrypt(
  plaintext: string,
  passphrase: string
): Promise<string> {
  const enc = new TextEncoder();
  const salt = generateSalt();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(passphrase, salt);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  // Combine: salt + iv + ciphertext
  const combined = new Uint8Array(
    SALT_LENGTH + IV_LENGTH + cipherBuffer.byteLength
  );
  combined.set(salt, 0);
  combined.set(iv, SALT_LENGTH);
  combined.set(new Uint8Array(cipherBuffer), SALT_LENGTH + IV_LENGTH);

  return bufferToBase64(combined);
}

// ─── Decrypt ──────────────────────────────────────────────────────────────

/**
 * Decrypts a base64-encoded AES-256-GCM payload.
 * Throws if the passphrase is wrong or data is corrupt.
 */
export async function decrypt(
  encryptedBase64: string,
  passphrase: string
): Promise<string> {
  const combined = base64ToBuffer(encryptedBase64);
  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(passphrase, salt);

  try {
    const plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plainBuffer);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted data.");
  }
}

// ─── Key verification ─────────────────────────────────────────────────────

/**
 * LEGACY — no longer called by the sync engine's upload path. A verifier is
 * encrypt(known-constant), and publishing that to third-party storage hands an
 * attacker a purpose-built offline brute-force oracle on the passphrase; a
 * mismatch is detected just as loudly by the payload's GCM decrypt failing.
 * Kept so verifyPassphrase can validate packets from older builds (and for tests
 * that simulate such peers). Format: base64(salt + iv + ciphertext).
 */
export async function createKeyVerifier(passphrase: string): Promise<string> {
  return encrypt("konode-verify-v1", passphrase);
}

export async function verifyPassphrase(
  passphrase: string,
  verifier: string
): Promise<boolean> {
  try {
    const result = await decrypt(verifier, passphrase);
    return result === "konode-verify-v1";
  } catch {
    return false;
  }
}

// ─── Passphrase strength ──────────────────────────────────────────────────

/**
 * Minimum length for a NEW, manually-typed E2EE passphrase. Encrypted blobs live
 * on storage the provider (or anyone who breaches it) can read, so the passphrase
 * can be guessed OFFLINE — PBKDF2's 600k iterations only slow each guess down; the
 * entropy has to come from the passphrase itself. 12 characters is a floor, not a
 * target — the generated recovery key remains the recommendation. Enforced only on
 * new entries so an existing shorter passphrase keeps decrypting old data.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

// ─── Recovery key ─────────────────────────────────────────────────────────

/**
 * Generates a strong, human-copyable recovery key (no ambiguous characters,
 * grouped for readability) — an alternative to a user-invented passphrase, so
 * people can save a high-entropy key instead of choosing (and forgetting) a weak
 * one. ~98 bits of entropy over a 30-character alphabet.
 */
export function generateRecoveryKey(): string {
  const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i / l / o / 0 / 1
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]; // negligible modulo bias at this entropy
    if ((i + 1) % 4 === 0 && i < bytes.length - 1) out += "-";
  }
  return out;
}

// ─── SHA-256 checksum ────────────────────────────────────────────────────

/**
 * Computes a SHA-256 hash of a string. Used for SyncPacket checksums.
 */
export async function sha256(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return bufferToHex(new Uint8Array(buffer));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function bufferToBase64(buffer: Uint8Array): string {
  // Encode in chunks — `String.fromCharCode(...buffer)` spreads every byte as a
  // separate argument and throws RangeError on large payloads (history, big trees).
  let binary = "";
  const CHUNK = 0x8000; // 32 KiB per chunk, well under the argument-count limit
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
