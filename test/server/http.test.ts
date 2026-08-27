import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/server/http.js';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/mcp', { headers });
}

describe('authenticate', () => {
  it('passes anything in "none" mode, even with no Authorization header', () => {
    const result = authenticate(request(), { authMode: 'none' });
    expect(result.ok).toBe(true);
  });

  describe('shared-token mode', () => {
    it('rejects a missing Authorization header', () => {
      const result = authenticate(request(), { authMode: 'shared-token', sharedToken: 'secret' });
      expect(result.ok).toBe(false);
    });

    it('rejects the wrong token', () => {
      const result = authenticate(request({ authorization: 'Bearer wrong' }), {
        authMode: 'shared-token',
        sharedToken: 'secret',
      });
      expect(result.ok).toBe(false);
    });

    it('accepts the right token', () => {
      const result = authenticate(request({ authorization: 'Bearer secret' }), {
        authMode: 'shared-token',
        sharedToken: 'secret',
      });
      expect(result.ok).toBe(true);
    });

    it('carries a WWW-Authenticate header on rejection', () => {
      const result = authenticate(request(), { authMode: 'shared-token', sharedToken: 'secret' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.headers.get('www-authenticate')).toBe(
          'Bearer realm="moneybird-mcp"',
        );
        expect(result.response.status).toBe(401);
      }
    });
  });

  describe('passthrough mode', () => {
    it('rejects a missing Authorization header', () => {
      const result = authenticate(request(), { authMode: 'passthrough' });
      expect(result.ok).toBe(false);
    });

    it('returns the presented token for use as the Moneybird token', () => {
      const result = authenticate(request({ authorization: 'Bearer caller-token' }), {
        authMode: 'passthrough',
      });
      expect(result).toEqual({ ok: true, token: 'caller-token' });
    });
  });
});
