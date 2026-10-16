import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDelegatedPermissionRuleService } from './delegated-permission-rules.js';
import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { PermissionGrant } from './schema.js';
import { createMemoryStores } from './testing.js';

// 委譲先の許可規則を、runner が繋がったときと許可の足し引きのときに配る（#4952）

function grant(id: string, rule: string): PermissionGrant {
  return {
    id,
    rule,
    allows: ['x'],
    denies: ['y'],
    approvalId: `ap-${id}`,
    answer: '許可します',
    grantedAt: '2026-10-16T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
  };
}

function fakeSdk(flagAllows: string[][]): typeof sdkQuery {
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
      applyFlagSettings: async (settings: { permissions?: { allow?: string[] } }) => {
        flagAllows.push([...(settings.permissions?.allow ?? [])]);
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

function setup() {
  const stores = createMemoryStores();
  const flagAllows: string[][] = [];
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fakeSdk(flagAllows),
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const permissionRules = createDelegatedPermissionRuleService({ stores, runners: registry });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    permissionRules,
  });
  return { stores, runner, pool, permissionRules, flagAllows };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('委譲先の許可規則の配布（#4952）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runner が繋がったときに配られ、開いたセッションに載る', async () => {
    const s = setup();
    await s.stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    const calls: string[][] = [];
    const real = s.runner.setPermissionRules?.bind(s.runner);
    s.runner.setPermissionRules = async (rules) => {
      calls.push([...rules]);
      if (real === undefined) throw new Error('口が無い');
      return real(rules);
    };

    await s.pool.start({ request: '走る' });
    await flush();

    expect(calls[0]).toEqual(['Bash(make test)']);
    expect(s.flagAllows[0]).toEqual(['Bash(make test)']);
    expect(s.pool.pushHealthOf('runner-test')?.permissionRules?.status).toBe('ok');
    await s.pool.stop();
  });

  it('runner が一覧を失っても（器の入れ替え）、名乗り直し（hello）で降り直す', async () => {
    const s = setup();
    await s.stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    await s.pool.start({ request: '走る' });
    await flush();
    const lost = s.runner.setPermissionRules?.bind(s.runner);
    await lost?.([]);
    await flush();
    expect(s.flagAllows.at(-1)).toEqual([]);

    await s.pool.reattachRunner('runner-test');
    await flush();
    expect(s.flagAllows.at(-1)).toEqual(['Bash(make test)']);
    await s.pool.stop();
  });

  it('許可が足された・取り消されたときに配られ、走行中のセッションへ置き直される', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });
    await flush();
    expect(s.flagAllows).toEqual([]);

    await s.stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    await s.permissionRules.pushAll('許可 g1 が記録された');
    await flush();
    expect(s.flagAllows.at(-1)).toEqual(['Bash(make test)']);

    await s.stores.permissionGrants.revoke('g1', '2026-10-16T01:00:00.000Z');
    await s.permissionRules.pushAll('許可 g1 が取り消された');
    await flush();
    expect(s.flagAllows.at(-1)).toEqual([]);
    await s.pool.stop();
  });

  it('繋がったときに配れなければ帳面が failed になり、日誌に理由が残り、挑み直されて ok に戻る', async () => {
    const s = setup();
    await s.stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    let broken = true;
    const real = s.runner.setPermissionRules?.bind(s.runner);
    s.runner.setPermissionRules = async (rules) => {
      if (broken) throw new Error('permission rules failed (test, transient)');
      if (real === undefined) throw new Error('口が無い');
      return real(rules);
    };

    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.permissionRules?.status).toBe('failed');
    const failed = JSON.stringify(await s.stores.journal.list({}));
    expect(failed).toContain('委譲先の許可規則を降ろせなかった');
    expect(failed).not.toContain('make test');

    broken = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.pool.pushHealthOf('runner-test')?.permissionRules?.status).toBe('ok');
    expect(s.flagAllows.at(-1)).toEqual(['Bash(make test)']);
    await s.pool.stop();
  });

  it('許可の足し引きで配れなかった失敗も帳面に積む（pushAll は投げない）', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });
    s.runner.setPermissionRules = async () => {
      throw new Error('permission rules failed (test)');
    };
    await s.stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    const results = await s.permissionRules.pushAll('許可 g1 が記録された');
    expect(results).toEqual([expect.objectContaining({ runnerId: 'runner-test', ok: false })]);
    expect(s.pool.pushHealthOf('runner-test')?.permissionRules?.status).toBe('failed');
    expect(await s.stores.permissionGrants.get('g1')).not.toBeNull();
    await s.pool.stop();
  });
});
