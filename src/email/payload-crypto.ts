import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Encrypts the data of e-mail jobs (recipient and the link with the password token) before it is
 * stored in the pg-boss tables: the database keeps only hashes of password tokens (spec 01,
 * section 7.4), so the job row must not carry the token in clear text either.
 * AES-256-GCM with a key derived (HKDF) from `EMAIL_PAYLOAD_SECRET`.
 */
export class PayloadCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'varal', 'email-job-payload/v1', 32));
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  /** Throws when the payload was changed or encrypted with another secret. */
  decrypt(payload: string): unknown {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== VERSION || iv === undefined || tag === undefined || data === undefined) {
      throw new Error('Unknown e-mail payload format');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const json = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
    return JSON.parse(json.toString('utf8'));
  }
}
