import { describe, expect, it } from 'vitest';
import { MoneybirdError, parseErrorBody } from '../../src/moneybird/errors.js';

function errorWithStatus(status: number): MoneybirdError {
  return new MoneybirdError('failure', { status, method: 'GET', url: 'https://example.test' });
}

describe('parseErrorBody', () => {
  it('parses the symbolic shape, a plain string message', () => {
    const parsed = parseErrorBody(401, { error: 'Invalid credentials' });
    expect(parsed).toEqual({
      message: 'Invalid credentials',
      validation: undefined,
      details: undefined,
    });
  });

  it('parses the non-symbolic shape, field messages plus machine-readable details', () => {
    const parsed = parseErrorBody(422, {
      error: { company_name: ["can't be blank"] },
      details: { company_name: [{ error: 'blank' }] },
    });

    expect(parsed.message).toBe("company_name: can't be blank");
    expect(parsed.validation).toEqual({ company_name: ["can't be blank"] });
    expect(parsed.details).toEqual({ company_name: [{ error: 'blank' }] });
  });

  it('joins multiple fields and multiple messages per field', () => {
    const parsed = parseErrorBody(422, {
      error: { company_name: ["can't be blank", 'is too short'], email: ['is invalid'] },
    });

    expect(parsed.message).toBe("company_name: can't be blank, is too short; email: is invalid");
  });

  it('trims and returns a plain string body as-is', () => {
    const parsed = parseErrorBody(500, '  Internal Server Error\n');
    expect(parsed).toEqual({
      message: 'Internal Server Error',
      validation: undefined,
      details: undefined,
    });
  });

  it('falls back to the status text for a null body', () => {
    const parsed = parseErrorBody(404, null);
    expect(parsed.message).toBe('Not found');
    expect(parsed.validation).toBeUndefined();
  });

  it('falls back to a generic HTTP message for an unknown status with no body', () => {
    const parsed = parseErrorBody(418, null);
    expect(parsed.message).toBe('HTTP 418');
  });

  it('falls back to the status text when the body is a record without an error field', () => {
    const parsed = parseErrorBody(400, { something: 'else' });
    expect(parsed.message).toBe('Bad request');
  });

  it('prefers a "message" field over the status fallback when present', () => {
    const parsed = parseErrorBody(400, { message: 'custom message' });
    expect(parsed.message).toBe('custom message');
  });
});

describe('MoneybirdError.isRetryable', () => {
  it.each([429, 500, 502, 503, 504, 0])('treats status %d as retryable', (status) => {
    expect(errorWithStatus(status).isRetryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats status %d as not retryable', (status) => {
    expect(errorWithStatus(status).isRetryable).toBe(false);
  });
});
