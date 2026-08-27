import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCredentialStore, type StoredCredentials } from '../../src/config/store.js';

const credentials: StoredCredentials = {
  version: 1,
  kind: 'personal_access_token',
  accessToken: 'a-token',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'moneybird-mcp-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileCredentialStore', () => {
  it('round-trips credentials written to disk', async () => {
    const store = new FileCredentialStore(join(dir, 'credentials.json'));
    await store.write(credentials);
    expect(await store.read()).toEqual(credentials);
  });

  it.skipIf(process.platform === 'win32')('writes the file with mode 0600', async () => {
    const location = join(dir, 'credentials.json');
    const store = new FileCredentialStore(location);
    await store.write(credentials);

    const { stat } = await import('node:fs/promises');
    const mode = (await stat(location)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns undefined when the file does not exist', async () => {
    const store = new FileCredentialStore(join(dir, 'missing.json'));
    expect(await store.read()).toBeUndefined();
  });

  it('throws a message naming the file path when the content is not valid JSON', async () => {
    const location = join(dir, 'credentials.json');
    await writeFile(location, 'not json at all');
    const store = new FileCredentialStore(location);

    await expect(store.read()).rejects.toThrow(location);
  });

  it('throws a message naming the file path when the content fails schema validation', async () => {
    const location = join(dir, 'credentials.json');
    await writeFile(location, JSON.stringify({ kind: 'oauth' }));
    const store = new FileCredentialStore(location);

    await expect(store.read()).rejects.toThrow(location);
  });

  it('is safe to clear when no file exists', async () => {
    const store = new FileCredentialStore(join(dir, 'missing.json'));
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('removes the file on clear', async () => {
    const location = join(dir, 'credentials.json');
    const store = new FileCredentialStore(location);
    await store.write(credentials);

    await store.clear();

    await expect(readFile(location, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
