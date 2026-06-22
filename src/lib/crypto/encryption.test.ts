import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  sha256,
  generateSalt,
  createKeyVerifier,
  verifyPassphrase,
} from "@/lib/crypto/encryption";

describe("encryption", () => {
  it("round-trips a plaintext payload", async () => {
    const pass = "correct horse battery staple";
    const enc = await encrypt("hello synkro", pass);
    expect(enc).not.toContain("hello"); // ciphertext, not plaintext
    expect(await decrypt(enc, pass)).toBe("hello synkro");
  });

  it("fails to decrypt with the wrong passphrase", async () => {
    const enc = await encrypt("secret", "right-passphrase");
    await expect(decrypt(enc, "wrong-passphrase")).rejects.toThrow();
  });

  it("handles large payloads (chunked base64, no RangeError)", async () => {
    const big = "x".repeat(300_000);
    const enc = await encrypt(big, "pw");
    expect(await decrypt(enc, "pw")).toBe(big);
  });

  it("sha256 matches the known vector for 'abc'", async () => {
    expect(await sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("generateSalt returns 16 distinct random bytes", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a.length).toBe(16);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("verifies a passphrase via the verifier token", async () => {
    const v = await createKeyVerifier("hunter2");
    expect(await verifyPassphrase("hunter2", v)).toBe(true);
    expect(await verifyPassphrase("not-it", v)).toBe(false);
  });
});
