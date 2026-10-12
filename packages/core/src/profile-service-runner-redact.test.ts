import { describe, expect, it } from 'vitest';

import type { ProfileApplier } from './profile.js';
import { createProfileService } from './profile-service.js';
import type { RunnerClient } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

function okApplier(): ProfileApplier {
  return {
    vessel: {} as never,
    fingerprint: () => undefined,
    env: () => ({}),
    async apply(script: string) {
      const prepared = await this.prepare(script);
      if (prepared.ok) await prepared.commit();
      return prepared;
    },
    async prepare() {
      return { ok: true, commit: async () => undefined, discard: async () => undefined };
    },
  };
}

function registryOf(runners: RunnerClient[]) {
  return {
    async list() {
      return runners;
    },
    async get(id: string) {
      return runners.find((runner) => runner.runnerId === id) ?? null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
}

/** 入口で伏せない器（差し替えた器）の形: 応答の error / output に鍵の値が入って返る。 */
function leakingRunner(runnerId: string) {
  return {
    runnerId,
    workspacePath: '/work',
    async profile() {
      return undefined;
    },
    async setProfile() {
      return {
        ok: false as const,
        error: `bash: export GH_TOKEN=${TOKEN}: bad`,
        output: `+ export GH_TOKEN=${TOKEN}`,
      };
    },
  } as unknown as RunnerClient;
}

function throwingRunner(runnerId: string) {
  return {
    runnerId,
    workspacePath: '/work',
    async profile() {
      return undefined;
    },
    async setProfile() {
      throw new Error(`runner が断った: export GH_TOKEN=${TOKEN}`);
    },
  } as unknown as RunnerClient;
}

describe('runner ごとの結果を出口で伏せる（クローンの結果と同じ redactProfileFailure）', () => {
  it('更新の応答の runners[] の error / output に鍵の値を残さない', async () => {
    const service = createProfileService({
      stores: createMemoryStores(),
      applier: okApplier(),
      runners: registryOf([leakingRunner('runner-a'), throwingRunner('runner-b')]),
    });

    const result = await service.set('default', 'export GH_TOKEN=placeholder');

    expect(result.runners.map((runner) => runner.runnerId)).toEqual(['runner-a', 'runner-b']);
    expect(result.runners.every((runner) => !runner.ok)).toBe(true);
    expect(JSON.stringify(result.runners)).not.toContain(TOKEN);
    // 伏せた後も、何が起きたかの地の文は残る
    expect(result.runners[0]?.error).toContain('bash: export GH_TOKEN=');
    expect(result.runners[1]?.error).toContain('runner が断った');
  });

  it('無い欄は足さない（成功の応答に error / output を生やさない）', async () => {
    const quiet = {
      runnerId: 'runner-ok',
      workspacePath: '/work',
      async profile() {
        return undefined;
      },
      async setProfile() {
        return { ok: true as const };
      },
    } as unknown as RunnerClient;
    const service = createProfileService({
      stores: createMemoryStores(),
      applier: okApplier(),
      runners: registryOf([quiet]),
    });

    const result = await service.set('default', 'export A=1');

    expect(result.runners).toEqual([{ runnerId: 'runner-ok', ok: true }]);
  });

  it('降ろし直し（syncRunner）の結果も伏せる: 呼び手はこの error を日誌へ書くため', async () => {
    const stores = createMemoryStores();
    await stores.profile.set('default', 'export A=1\n', 'all');
    const service = createProfileService({ stores, runners: registryOf([]) });

    const result = await service.syncRunner(leakingRunner('runner-a'));

    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result?.ok).toBe(false);
  });
});
