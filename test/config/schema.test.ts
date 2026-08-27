import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_TOOLSETS,
  TOOLSETS,
  configFromEnv,
  permissionsFor,
  resolveToolsets,
} from '../../src/config/schema.js';

describe('resolveToolsets', () => {
  it('returns the defaults when nothing is configured', () => {
    expect(resolveToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
  });

  it('returns an explicit comma-separated list, in canonical order', () => {
    expect(resolveToolsets('reports,core')).toEqual(['core', 'reports']);
  });

  it('returns every toolset for "all"', () => {
    expect(resolveToolsets('all')).toEqual([...TOOLSETS]);
  });

  it('returns nothing selected as an error for "none"', () => {
    expect(() => resolveToolsets('none')).toThrow(ConfigError);
  });

  it('subtracts a toolset from the defaults with a leading "-"', () => {
    const result = resolveToolsets('-banking');
    expect(result).toEqual(DEFAULT_TOOLSETS.filter((toolset) => toolset !== 'banking'));
  });

  it('throws a ConfigError naming an unknown toolset', () => {
    expect(() => resolveToolsets('not-a-toolset')).toThrow(/Unknown toolset "not-a-toolset"/);
  });

  it('throws a ConfigError for an unknown toolset being subtracted', () => {
    expect(() => resolveToolsets('-not-a-toolset')).toThrow(ConfigError);
  });
});

describe('configFromEnv', () => {
  const base = { MONEYBIRD_API_TOKEN: 'token' };

  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
  ])('parses MONEYBIRD_ALLOW_WRITE=%s as %s', (raw, expected) => {
    const config = configFromEnv({ ...base, MONEYBIRD_ALLOW_WRITE: raw });
    expect(config.allowWrite).toBe(expected);
  });

  it('defaults booleans to false when unset', () => {
    const config = configFromEnv(base);
    expect(config.allowWrite).toBe(false);
    expect(config.allowDelete).toBe(false);
  });

  it('throws when a client id is set without a client secret', () => {
    expect(() => configFromEnv({ ...base, MONEYBIRD_CLIENT_ID: 'abc' })).toThrow(ConfigError);
  });

  it('throws when a client secret is set without a client id', () => {
    expect(() => configFromEnv({ ...base, MONEYBIRD_CLIENT_SECRET: 'shh' })).toThrow(ConfigError);
  });

  it('accepts a client id and secret together and builds the oauth config', () => {
    const config = configFromEnv({
      MONEYBIRD_CLIENT_ID: 'abc',
      MONEYBIRD_CLIENT_SECRET: 'shh',
    });
    expect(config.oauth).toMatchObject({ clientId: 'abc', clientSecret: 'shh' });
  });

  it('throws for an invalid transport', () => {
    expect(() => configFromEnv({ ...base, MONEYBIRD_TRANSPORT: 'carrier-pigeon' })).toThrow(
      /MONEYBIRD_TRANSPORT must be "stdio" or "http"/,
    );
  });

  it('accepts a valid transport case-insensitively', () => {
    expect(configFromEnv({ ...base, MONEYBIRD_TRANSPORT: 'HTTP' }).transport).toBe('http');
  });
});

describe('permissionsFor', () => {
  const config = (overrides: { allowWrite: boolean; allowDelete: boolean }) =>
    configFromEnv({
      MONEYBIRD_API_TOKEN: 'token',
      MONEYBIRD_ALLOW_WRITE: String(overrides.allowWrite),
      MONEYBIRD_ALLOW_DELETE: String(overrides.allowDelete),
    });

  it('grants neither write nor destroy by default', () => {
    expect(permissionsFor(config({ allowWrite: false, allowDelete: false }))).toEqual({
      write: false,
      destroy: false,
    });
  });

  it('grants write but not destroy when only allowWrite is set', () => {
    expect(permissionsFor(config({ allowWrite: true, allowDelete: false }))).toEqual({
      write: true,
      destroy: false,
    });
  });

  it('does not grant destroy from allowDelete alone', () => {
    expect(permissionsFor(config({ allowWrite: false, allowDelete: true }))).toEqual({
      write: false,
      destroy: false,
    });
  });

  it('grants destroy only when both allowWrite and allowDelete are set', () => {
    expect(permissionsFor(config({ allowWrite: true, allowDelete: true }))).toEqual({
      write: true,
      destroy: true,
    });
  });
});
