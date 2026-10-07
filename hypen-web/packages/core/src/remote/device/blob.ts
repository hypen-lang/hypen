/**
 * Device Capability Protocol — blob hashing (RFC 001 §2.4).
 *
 * One-shot SHA-256 for the TS endpoints: the client runtime hashes the items
 * it announces, and the server handler API hashes `device.save()` payloads.
 * Verifying RECEIVED uploads (item set, sizes, SHA-256 of the bytes that
 * arrived) is the Rust broker's job on the server; the client runtime hashes
 * streamed bytes incrementally with its own `Sha256` (./runtime.ts). A hash
 * detects corruption/mismatch only — it does not establish authenticity of a
 * potentially hostile peer (RFC 001 §1.9). Uses Web Crypto (`crypto.subtle`),
 * available in Bun, browsers, and modern Node.
 */

const subtle = (globalThis as unknown as { crypto: { subtle: SubtleLike } })
  .crypto.subtle;

interface SubtleLike {
  digest(alg: string, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
}

/** Lowercase hex SHA-256 of the bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}
