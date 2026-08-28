import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Bytes of entropy behind every value this server hands out as a credential. */
const TOKEN_BYTES = 32;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** A URL-safe random secret: authorization codes, access tokens, refresh tokens, request ids. */
export function randomToken(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Fingerprints a token for storage.
 *
 * Tokens this server issues are only ever compared against a value the caller presents, so the
 * database never needs the token itself. SHA-256 without a salt is deliberate: the input is 256
 * bits of entropy, which is not guessable, and an unsalted digest is what makes the lookup a
 * single indexed equality.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

/**
 * Authenticated encryption for the credentials that must be replayed against Moneybird.
 *
 * Sealed as `iv | tag | ciphertext`. GCM means a tampered row fails to open rather than
 * decrypting to something attacker-chosen.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new EncryptionKeyError(
        'MONEYBIRD_TOKEN_ENCRYPTION_KEY must be 32 bytes as 64 hex characters. ' +
          'Generate one with: openssl rand -hex 32',
      );
    }
    this.key = Buffer.from(keyHex, 'hex');
    if (this.key.length !== KEY_BYTES) {
      throw new EncryptionKeyError('MONEYBIRD_TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
    }
  }

  seal(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  open(sealed: Buffer): string {
    if (sealed.length <= IV_BYTES + TAG_BYTES) {
      throw new EncryptionKeyError('Sealed value is too short to be valid.');
    }
    const iv = sealed.subarray(0, IV_BYTES);
    const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = sealed.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

/** Constant-time string comparison, for values a caller controls. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifies an RFC 7636 code verifier against the stored challenge.
 *
 * Only S256 is accepted. `plain` is still legal in the RFC but offers no protection against an
 * attacker who can read the authorization request, which is exactly the threat PKCE exists for.
 */
export function verifyCodeChallenge(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEquals(computed, challenge);
}
