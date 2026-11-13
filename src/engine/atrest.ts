// ─── Encryption at rest, opt-in: backups and quarantine ─────────
//
// The brain is plain JSON on purpose — people read it, diff it and fix it by
// hand. Its two copies are a different matter: a backup is made to be carried
// to a synced folder, and the quarantine holds exactly what somebody asked to
// forget, credentials included. Whoever syncs those to a cloud drive may want
// them sealed. Off by default; nothing changes for anyone who does not ask.
//
//   CRBRO_ENCRYPT_AT_REST=1   seal new backups and quarantine copies
//
// The key: 32 random bytes, base64, kept in the OS keychain under
// CRBRO_AT_REST_KEY (crbro_secret / `crbro-memory secret set`), never in the
// brain and never next to the files it protects. With the switch on and no key
// CRBRO fails loudly: it never falls back to writing in clear and never deletes
// anything for lack of a key. Create the key once, explicitly:
//
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
//     | npx crbro-memory secret set CRBRO_AT_REST_KEY --description "crbro - at-rest key"
//
// Lose the key and the sealed copies are gone with it: that is what sealing
// means. Clear files stay readable whatever the switch says.
//
// Format: MAGIC (8 bytes) | IV (12) | GCM tag (16) | ciphertext. AES-256-GCM
// from node:crypto, the magic bound as additional data. Readers recognise a
// sealed file by its first bytes, never by its name.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getSecret } from './keychain.js';

export const AT_REST_KEY_NAME = 'CRBRO_AT_REST_KEY';
const MAGIC = Buffer.from('CRBRENC1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;

export class AtRestKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtRestKeyError';
  }
}

/** The switch. Only an explicit "1"/"true"/"on" turns it on. */
export function atRestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env['CRBRO_ENCRYPT_AT_REST'] || '').trim());
}

/** A fresh key, base64. For the person setting it up; CRBRO never stores one by itself. */
export function generateAtRestKey(): string {
  return randomBytes(32).toString('base64');
}

let cache: { key: Buffer; at: number } | null = null;
const CACHE_MS = 60_000;

/** Tests switch keys and keychain folders between cases. */
export function _resetAtRestKeyCache(): void {
  cache = null;
}

/** The key from the keychain, or a loud error saying how to create it. */
export function loadAtRestKey(): Buffer {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.key;
  let raw: string | null;
  try {
    raw = getSecret(AT_REST_KEY_NAME);
  } catch (err) {
    throw new AtRestKeyError(
      `Encryption at rest is on (CRBRO_ENCRYPT_AT_REST) but the keychain could not be read: ${(err as Error).message}. ` +
      'Nothing was written in clear and nothing was deleted.');
  }
  if (!raw || !raw.trim()) {
    throw new AtRestKeyError(
      `Encryption at rest is on (CRBRO_ENCRYPT_AT_REST) but there is no ${AT_REST_KEY_NAME} in the keychain. ` +
      'Nothing was written in clear and nothing was deleted. Create the key once with: ' +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | npx crbro-memory secret set ${AT_REST_KEY_NAME}`);
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new AtRestKeyError(`${AT_REST_KEY_NAME} must be 32 bytes in base64 (got ${key.length} bytes). Nothing was written.`);
  }
  cache = { key, at: Date.now() };
  return key;
}

export function isSealed(data: Buffer): boolean {
  return data.length >= MAGIC.length + IV_LEN + TAG_LEN && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function seal(plain: Buffer, key: Buffer = loadAtRestKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/**
 * Clear data comes back as it is; sealed data is opened with the keychain key
 * whatever the switch says (turning encryption off must not orphan old copies).
 */
export function unseal(data: Buffer, key?: Buffer): Buffer {
  if (!isSealed(data)) return data;
  const k = key ?? (() => {
    try {
      return loadAtRestKey();
    } catch (err) {
      throw new AtRestKeyError(`This file is encrypted at rest and the key is not available: ${(err as Error).message}`);
    }
  })();
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = data.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const body = data.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new AtRestKeyError('Encrypted file could not be opened: wrong key or damaged file.');
  }
}

/** Seal when the switch is on, else return the bytes untouched. Throws (never writes clear) if on and keyless. */
export function maybeSeal(plain: Buffer, env: NodeJS.ProcessEnv = process.env): { data: Buffer; sealed: boolean } {
  if (!atRestEnabled(env)) return { data: plain, sealed: false };
  return { data: seal(plain), sealed: true };
}
