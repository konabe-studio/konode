/**
 * PKCE (RFC 7636) helpers, shared by the Google Drive and Dropbox sign-ins.
 *
 * A verifier is 64 random bytes as base64url (86 characters, inside the 43 to 128 the RFC
 * allows), and the challenge is its SHA-256, base64url without padding (method S256).
 */

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(64)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
