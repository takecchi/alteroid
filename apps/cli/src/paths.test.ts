import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { alteroidRoot, stateDir } from './paths.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('alteroidRoot', () => {
  it('置かれた ALTEROID_HOME を使い、state はその下になる', () => {
    vi.stubEnv('ALTEROID_HOME', '/data/alteroid');
    expect(alteroidRoot()).toBe('/data/alteroid');
    expect(stateDir()).toBe(join('/data/alteroid', 'state'));
  });

  it.each(['', '   '])('ALTEROID_HOME が %j なら ~/.alteroid に倒れる', (value) => {
    vi.stubEnv('ALTEROID_HOME', value);
    expect(alteroidRoot()).toBe(join(homedir(), '.alteroid'));
  });
});
