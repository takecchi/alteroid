import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProfileService } from './profile-service.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// Issue #6506: 正本とクローンの器へ反映した後の失敗（runner の一覧の読み・配布後の正本の読み直し）は、
// 書けた側を正にして `stored: true` で返す（投げない・戻さない）。runner の一覧の失敗は `runnersUnconfirmed`（伏せた理由）で伝える。

const SECRET_ENV_NAME = 'PIN_FAKE_DEPLOY_SECRET';
const FAKE_ENV_VALUE = 'pinfake-env-value-0123456789';

afterEach(() => {
  vi.unstubAllEnvs();
});

function runnersWhoseListThrows(message: string) {
  return {
    async list(): Promise<never> {
      throw new Error(message);
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
}

function okRunners(calls: string[]) {
  return {
    async list() {
      return [
        {
          runnerId: 'runner-a',
          async setProfile(script: string) {
            calls.push(script);
            return { ok: true as const };
          },
        },
      ];
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
}

/** `profile.list` の n 回目（1 から）だけ投げる記憶ストア */
function storesWhoseListFailsAt(failAt: number[]): { stores: Stores; discards: string[] } {
  const base = createMemoryStores();
  let count = 0;
  const replaced: string[] = [];
  const stores: Stores = {
    ...base,
    profile: {
      ...base.profile,
      list: async () => {
        count += 1;
        if (failAt.includes(count)) throw new Error('正本の一覧が読めない（test）');
        return base.profile.list();
      },
      replaceAll: async (previous) => {
        replaced.push('replaceAll');
        await base.profile.replaceAll(previous);
      },
    },
  };
  return { stores, discards: replaced };
}

describe('正本に書いた後の失敗は、書けた側を正にして置けたと返す（#6506）', () => {
  it('runner の一覧が落ちる: stored=true・runners=[]・runnersUnconfirmed は伏せた理由。戻さず、行は残る', async () => {
    vi.stubEnv(SECRET_ENV_NAME, FAKE_ENV_VALUE);
    const { stores, discards } = storesWhoseListFailsAt([]);
    const service = createProfileService({
      stores,
      runners: runnersWhoseListThrows(`一覧が取れない ${FAKE_ENV_VALUE}`),
    });
    const pushed: unknown[] = [];
    service.onPushed((results) => pushed.push(results));

    const result = await service.set('rust', 'export R=1');

    expect(result.stored).toBe(true);
    expect(result.runners).toEqual([]);
    expect(result.runnersUnconfirmed).toBe('Error: 一覧が取れない [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(FAKE_ENV_VALUE);
    expect(result.entries?.map((entry) => entry.name)).toEqual(['rust']);
    expect((await stores.profile.list()).map((row) => row.name)).toEqual(['rust']);
    expect(discards).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('配布後の正本の読み直しが落ちる: entries は書いた行・composed はその行から。足す欄は無い', async () => {
    const calls: string[] = [];
    // 1 回目は前の版の読み、2 回目が配布後の読み直し
    const { stores, discards } = storesWhoseListFailsAt([2]);
    const service = createProfileService({ stores, runners: okRunners(calls) });
    const pushed: unknown[] = [];
    service.onPushed((results) => pushed.push(results));

    const result = await service.set('rust', 'export R=1', 'app');

    expect(result.stored).toBe(true);
    expect(result.runnersUnconfirmed).toBeUndefined();
    expect('runnersUnconfirmed' in result).toBe(false);
    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'rust', script: 'export R=1\n', scope: 'app' }),
    ]);
    expect(result.composed?.clone.sha256).toBeDefined();
    expect(result.composed?.runner.sha256).toBeUndefined();
    expect(result.runners).toEqual([{ runnerId: 'runner-a', ok: true }]);
    expect(calls).toEqual(['']);
    expect(pushed).toHaveLength(1);
    expect(discards).toEqual([]);
  });

  it('remove でも同じ: 外した後の行（書いた行）が entries になる', async () => {
    const { stores } = storesWhoseListFailsAt([]);
    await stores.profile.set('a', 'export A=1\n', 'all');
    await stores.profile.set('b', 'export B=1\n', 'all');
    const service = createProfileService({
      stores,
      runners: runnersWhoseListThrows('一覧が取れない'),
    });

    const result = await service.remove('a');

    expect(result.removed).toBe(true);
    expect(result.stored).toBe(true);
    expect(result.runnersUnconfirmed).toBe('Error: 一覧が取れない');
    expect(result.entries?.map((entry) => entry.name)).toEqual(['b']);
    expect((await stores.profile.list()).map((row) => row.name)).toEqual(['b']);
  });

  it('両方起きる: 一覧の失敗は runnersUnconfirmed、読み直しの失敗は書いた行で補う（それぞれ適用）', async () => {
    vi.stubEnv(SECRET_ENV_NAME, FAKE_ENV_VALUE);
    const { stores, discards } = storesWhoseListFailsAt([2]);
    const service = createProfileService({
      stores,
      runners: runnersWhoseListThrows(`一覧が取れない ${FAKE_ENV_VALUE}`),
    });
    const pushed: unknown[] = [];
    service.onPushed((results) => pushed.push(results));

    const result = await service.set('rust', 'export R=1');

    expect(result.stored).toBe(true);
    expect(result.runners).toEqual([]);
    expect(result.runnersUnconfirmed).toBe('Error: 一覧が取れない [REDACTED]');
    expect(result.entries?.map((entry) => entry.name)).toEqual(['rust']);
    expect(result.composed?.clone.sha256).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(FAKE_ENV_VALUE);
    expect(pushed).toEqual([]);
    expect(discards).toEqual([]);
  });
});
