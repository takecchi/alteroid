import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createDelegatedPermissionRuleService,
  createManagerPool,
  createMemoryStores,
  createRunnerHost,
  createRunnerRegistry,
  RunnerPermissionRulesUnsupportedError,
  type ManagerPool,
  type PermissionGrant,
  type RunnerClient,
  type RunnerHost,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { createHttpRunner } from './runner-client.js';

// 人間が承認した許可を、委譲先のセッションの許可規則として runner へ配る（#4952）。HTTP の口を通した往復
const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function grant(id: string, rule: string, extra: Partial<PermissionGrant> = {}): PermissionGrant {
  return {
    id,
    rule,
    allows: ['x'],
    denies: ['y'],
    approvalId: `ap-${id}`,
    answer: '許可します',
    grantedAt: '2026-10-16T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
    ...extra,
  };
}

function fakeSdk(): { fn: typeof sdkQuery; flagAllows: string[][] } {
  const flagAllows: string[][] = [];
  const fn = ((input: { options: Options }) => {
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
  return { fn, flagAllows };
}

interface Rig {
  pool: ManagerPool;
  stores: Stores;
  host: RunnerHost;
  client: RunnerClient;
  posted: string[];
  flagAllows: string[][];
  close(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.close();
});

async function rig(options: { stores?: Stores; oldRunner?: boolean } = {}): Promise<Rig> {
  const { fn, flagAllows } = fakeSdk();
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  const posted: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname === '/permission-rules') {
      if (options.oldRunner === true) return new Response('404 Not Found', { status: 404 });
      if (init?.method === 'POST') posted.push(String(init.body));
    }
    return app.request(`${url.pathname}${url.search}`, init as never);
  }) as typeof fetch;
  const client = await createHttpRunner({ baseUrl: 'http://runner.test', token: TOKEN, fetchFn });
  const stores = options.stores ?? createMemoryStores();
  const registry = createRunnerRegistry([client]);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    permissionRules: createDelegatedPermissionRuleService({ stores, runners: registry }),
  });
  const created: Rig = {
    pool,
    stores,
    host,
    client,
    posted,
    flagAllows,
    async close() {
      await pool.stop();
      await host.shutdown();
    },
  };
  rigs.push(created);
  return created;
}

describe('委譲先の許可規則を HTTP の runner へ降ろす（#4952）', () => {
  it('runner が繋がると完全一致の許可だけが降り、開いたセッションの許可規則に載る', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g-exact', 'Bash(gh pr view 1)'));
    await stores.permissionGrants.put(grant('g-prefix', 'Bash(gh pr view:*)'));
    const r = await rig({ stores });

    await r.pool.start({ request: '1本' });

    // 繋いだときと名乗り（hello）のときの両方で降ろす。中身は同じ
    expect(r.posted.length).toBeGreaterThanOrEqual(1);
    for (const body of r.posted) {
      expect(JSON.parse(body)).toEqual({ rules: ['Bash(gh pr view 1)'] });
    }
    expect(r.flagAllows).toEqual([['Bash(gh pr view 1)']]);
    expect(r.pool.pushHealthOf('runner-primary')?.permissionRules?.status).toBe('ok');

    // 「配った」は一覧が変わった1回だけ日誌に残る（件数と許可の id。規則の本文は書かない）
    const placed = (await stores.journal.list({})).filter(
      (entry) => entry.type === 'decision' && entry.decision.includes('委譲先の許可規則を'),
    );
    expect(placed).toHaveLength(1);
    expect(JSON.stringify(placed)).toContain('runner-primary へ委譲先の許可規則を 1 件配った');
    expect(JSON.stringify(placed)).toContain('g-exact');
    expect(JSON.stringify(placed)).not.toContain('gh pr view');
  });

  it('古い runner（口が無い＝404）は「口なし」と記録され、委譲は止まらない', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g-exact', 'Bash(gh pr view 1)'));
    const r = await rig({ stores, oldRunner: true });

    await r.pool.start({ request: '1本' });

    const outcome = r.pool.pushHealthOf('runner-primary')?.permissionRules;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('委譲先の許可規則を受け取る口を持たない');
    await expect(r.client.setPermissionRules?.([])).rejects.toBeInstanceOf(
      RunnerPermissionRulesUnsupportedError,
    );
    const journal = JSON.stringify(await stores.journal.list({}));
    expect(journal).toContain('委譲先の許可規則を降ろせなかった');
    expect(journal).not.toContain('gh pr view 1');
  });

  it('載せてよい形でない規則は runner が 400 で拒み、前の一覧が残る（応答に規則の本文を載せない）', async () => {
    const r = await rig();
    expect(await r.client.setPermissionRules?.(['Bash(echo ok)'])).toEqual({
      count: 1,
      changed: true,
    });

    let message = '';
    try {
      await r.client.setPermissionRules?.(['Bash(echo ok)', 'Bash(SECRET-PREFIX:*)']);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/\(400\)/);
    expect(message).toContain('1 番目');
    expect(message).not.toContain('SECRET');
    expect(r.host.setPermissionRules(['Bash(echo ok)'])).toEqual({ count: 1, changed: false });
  });
});
