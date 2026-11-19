import crypto from 'node:crypto';

/**
 * Encrypts credentials (an institute's WhatsApp token and app secret) before they are stored, so a
 * copied database file or backup doesn't hand anyone the keys to send WhatsApp messages.
 *
 * The key comes from DATA_ENCRYPTION_KEY, or is derived from SESSION_SECRET when that isn't set.
 * It never goes in the database or the backups. Lose it and the stored tokens can't be read: they
 * have to be entered again in Settings → WhatsApp.
 *
 * Stored form: enc:v1:<key id>:<iv>:<tag>:<ciphertext>  (AES-256-GCM, base64url)
 */
const PREFIX = 'enc:v1:';

export class SecretUnreadableError extends Error {}

export function createSecretBox(keyMaterial) {
  if (!keyMaterial || String(keyMaterial).length < 16) throw new Error('An encryption key of at least 16 characters is required');
  const key = Buffer.from(crypto.hkdfSync('sha256', String(keyMaterial), 'attendance-alert', 'stored-credentials-v1', 32));
  // A short fingerprint of the key, so "wrong key" can be told apart from "damaged value".
  const keyId = crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8);

  return {
    keyId,
    isSealed: (v) => typeof v === 'string' && v.startsWith(PREFIX),
    seal(plain) {
      if (plain === '' || plain == null) return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return `${PREFIX}${keyId}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
    },
    /** Plaintext values (from before encryption) pass through unchanged. */
    open(stored) {
      if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored ?? '';
      const [id, iv, tag, ct] = stored.slice(PREFIX.length).split(':');
      if (id !== keyId) throw new SecretUnreadableError('Stored with a different encryption key');
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretUnreadableError('Stored value is damaged');
      }
    },
  };
}
