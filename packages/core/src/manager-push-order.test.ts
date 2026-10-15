import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialService } from './credential-service.js';
import { createCredentialStore } from './credentials.js';
import { createManagerPool, WITHHELD_ENV_KEYS } from './manager.js';
import { createMcpServerService } from './mcp-server-service.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

function fakeSdk(): typeof sdkQuery {
  return ((input: { options: Options }) => {
    void input;
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

function setup() {
  const stores = createMemoryStores();
  // 鍵の器を持たせる: 無いと `setCredentials` が常に投げ、降ろす順が測れない。
  const credentialStore = createCredentialStore({
    dir: join(makeTempDirSync('alteroid-4841-'), 'creds'),
  });
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
    credentials: credentialStore,
  });
  const registry = createRunnerRegistry([runner]);
  const mcpServers = createMcpServerService({ stores, runners: registry });
  const profile = createProfileService({ stores, runners: registry });
  const credentials = createCredentialService({
    stores,
    runners: registry,
    withheldEnvKeys: [...WITHHELD_ENV_KEYS],
  });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    mcpServers,
    profile,
    credentials,
  });
  return { stores, runner, pool, mcpServers, profile, credentials };
}

describe('runner へ降ろす順: 鍵 → プロファイル（#4841）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('⭐ 繋がった runner へは、鍵を降ろしてからプロファイルを降ろす（プロファイルが鍵の無い env で評価されて固まらない）', async () => {
    const s = setup();
    await s.stores.credentials.put([
      { name: 'GH_TOKEN', value: 'dummy-gh-token-value', scope: 'all', secret: true },
    ]);
    await s.stores.profile.set('gh', 'export GH_X="$GH_TOKEN"\n', 'runner');

    const order: string[] = [];
    const realProfile = s.runner.setProfile.bind(s.runner);
    const realCredentials = s.runner.setCredentials.bind(s.runner);
    s.runner.setProfile = async (script) => {
      order.push('profile');
      return realProfile(script);
    };
    s.runner.setCredentials = async (entries) => {
      order.push('credentials');
      return realCredentials(entries);
    };

    await s.pool.start({ request: '走る' });

    expect(order.indexOf('credentials')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('profile')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('credentials')).toBeLessThan(order.indexOf('profile'));

    await s.pool.stop();
  });
});
