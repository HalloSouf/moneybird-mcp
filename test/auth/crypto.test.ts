import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EncryptionKeyError,
  SecretBox,
  hashToken,
  randomToken,
  verifyCodeChallenge,
} from '../../src/auth/server/crypto.js';

const KEY = randomBytes(32).toString('hex');

describe('SecretBox', () => {
  it('opens what it sealed', () => {
    const box = new SecretBox(KEY);
    expect(box.open(box.seal('moneybird-token'))).toBe('moneybird-token');
  });

  it('produces a different ciphertext every time', () => {
    const box = new SecretBox(KEY);
    expect(box.seal('same').equals(box.seal('same'))).toBe(false);
  });

  it('refuses a tampered ciphertext rather than returning something else', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('moneybird-token');
    const last = sealed.length - 1;
    sealed[last] = ((sealed[last] ?? 0) ^ 0xff) & 0xff;
    expect(() => box.open(sealed)).toThrow();
  });

  it('cannot open what another key sealed', () => {
    const sealed = new SecretBox(KEY).seal('moneybird-token');
    expect(() => new SecretBox(randomBytes(32).toString('hex')).open(sealed)).toThrow();
  });

  it('rejects a key that is not 32 bytes of hex', () => {
    expect(() => new SecretBox('too-short')).toThrow(EncryptionKeyError);
    expect(() => new SecretBox(randomBytes(16).toString('hex'))).toThrow(EncryptionKeyError);
  });
});

describe('tokens', () => {
  it('hashes deterministically without storing the token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toContain('abc');
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('mints url-safe secrets', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken()).not.toBe(token);
  });
});

describe('verifyCodeChallenge', () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('accepts the verifier the challenge was derived from', () => {
    expect(verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
  });

  it('rejects a different verifier', () => {
    expect(verifyCodeChallenge(randomBytes(32).toString('base64url'), challenge, 'S256')).toBe(
      false,
    );
  });

  it('rejects the plain method even when the values match', () => {
    expect(verifyCodeChallenge(verifier, verifier, 'plain')).toBe(false);
  });

  it('rejects a verifier outside the length RFC 7636 allows', () => {
    const short = 'a'.repeat(42);
    expect(
      verifyCodeChallenge(short, createHash('sha256').update(short).digest('base64url'), 'S256'),
    ).toBe(false);
  });
});
