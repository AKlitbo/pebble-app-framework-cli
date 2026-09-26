/**
 * The hashes paf keeps in its stamps and records.
 */
import crypto from 'node:crypto';

/**
 * A sha256 of some text or bytes, as hex.
 *
 * @param data What to hash. Several pieces are hashed in order, each ended by a NUL so two pieces can
 *   never read as one.
 * @param length How many hex characters to keep, or all of them when left out.
 * @return The hash.
 */
export function sha256(data: string | Buffer | (string | Buffer)[], length?: number): string {
  const hasher = crypto.createHash('sha256');

  if (Array.isArray(data)) {
    for (const piece of data) {
      hasher.update(piece).update('\0');
    }
  } else {
    hasher.update(data);
  }

  const hex = hasher.digest('hex');

  return length ? hex.slice(0, length) : hex;
}
