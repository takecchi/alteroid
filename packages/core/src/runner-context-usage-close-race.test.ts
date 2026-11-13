import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 担当: 文脈占有の観測（`getContextUsage`）が走っている間に、閉じる／入力を閉じる境界へ達しても、
// 観測が「閉じたセッションへの問い合わせ」という偽の失敗にならない。
// 偽のセッションは、閉じられた（`close()`）・入力を閉じられた（プロンプトの列の終端）後の `getContextUsage` を失敗させる。
const usage = { totalTokens: 12_000, rawMaxTokens: 200_000, percentage: 6 };

/** 実時間で待たず、イベントループを数周回す。 */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

interface FakeSession {
  push(message: SDKMessage): void;
  /** `close()` が呼ばれた、または入力（プロンプトの列）が閉じられた */
  readonly dead: () => boolean;
  readonly inputClosed: () => boolean;
}

function fakeSdk(opts: {
  getContextUsage: (callIndex: number, session: FakeSession) => Promise<unknown>;
  sessionUsage?: () => Promise<unknown>;
}) {
  let calls = 0;
  let finishes = 0;
  const sessions: FakeSession[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let closed = false;
    let inputClosed = false;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };
    const session: FakeSession = {
      push,
      dead: () => closed || inputClosed,
      inputClosed: () => inputClosed,
    };
    sessions.push(session);
    const label = (params.options as Options | undefined)?.resume ?? 'sess-mgr';
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: label,
        uuid: `uuid-init-${String(sessions.length)}`,
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
        // 入力が閉じたら CLI は終わる
        inputClosed = true;
        if (emit) emit(null);
      })();
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (inputClosed || closed) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: () => {
        closed = true;
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
      getContextUsage: () => opts.getContextUsage((calls += 1) - 1, session),
      ...(opts.sessionUsage === undefined
        ? {}
        : { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: opts.sessionUsage }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const finish = async (text: string) => {
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションがまだ開いていない');
    session.push({
      type: 'result',
      subtype: 'success',
      result: text,
      session_id: 'sess-mgr',
      uuid: `uuid-result-${(finishes += 1)}`,
      modelUsage: {},
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { fn, finish, sessions, callCount: () => calls };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-context-usage-close-race-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function start(sdk: ReturnType<typeof fakeSdk>) {
  const events: RunnerEvent[] = [];
  const credentials = createCredentialStore({
    dir: join(dir, 'creds'),
    seed: { CLAUDE_CODE_OAUTH_TOKEN: 'token-fake-old-000' },
    names: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: sdk.fn,
    env: { PATH: '/usr/bin' },
    credentials,
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
  });
  hosts.push(host);
  await host.resume({
    managerId: 'mgr-wire',
    sessionId: 'sess-mgr',
    cwd: '/work/project',
    request: '調べて',
    entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
  });
  await vi.waitFor(() => {
    if (sdk.sessions.length === 0) throw new Error('セッションがまだ開いていない');
  });
  return { host, events };
}

const typesOf = (events: RunnerEvent[]) => events.map((event) => event.type);
const rowsOf = (events: RunnerEvent[]) =>
  events.flatMap((event) => (event.type === 'context_usage' ? [event] : []));

describe('担当（ランナー）— 観測と閉じる境界の競合', () => {
  it('⭐ 畳みが観測の完了を待った後・セッションを閉じる前に turn_ended が届いても、閉じた後に偽の失敗の行が出ない', async () => {
    const g0 = gate();
    const g2 = gate();
    const usageGate = gate();
    let usageReadStarted = false;
    const sdk = fakeSdk({
      getContextUsage: async (callIndex, session) => {
        if (callIndex === 0) await g0.opened;
        if (callIndex === 1) await g2.opened;
        // 閉じられたセッションへの問い合わせは失敗する（本物の SDK と同じ）
        if (session.dead()) throw new Error('閉じたセッションへの getContextUsage');
        return { ...usage, totalTokens: 1_000 * (callIndex + 1) };
      },
      sessionUsage: async () => {
        usageReadStarted = true;
        await usageGate.opened;
        return undefined;
      },
    });
    const { host, events } = await start(sdk);
    await sdk.finish('1回目');
    await vi.waitFor(() => {
      if (!typesOf(events).includes('report')) throw new Error('report がまだ出ていない');
    });

    const shutting = host.shutdown();
    await settle();
    // 観測 1 が返るまで畳みは先へ進まない（ここまでは今までどおり）
    expect(usageReadStarted).toBe(false);
    g0.open();
    // 観測の待ちを抜けて、累積の読み出し（閉じる前）で止まる
    await vi.waitFor(() => {
      if (!usageReadStarted) throw new Error('畳みが累積の読み出しまで進んでいない');
    });

    // 待ちを抜けた後・閉じる前に、次のターンの終わりが届く
    await sdk.finish('2回目');
    await settle();
    usageGate.open();
    await vi.waitFor(() => {
      if (!sdk.sessions[0]?.dead()) throw new Error('セッションがまだ閉じられていない');
    });
    g2.open();
    await shutting;
    await settle();

    // 閉じた後に、偽の失敗の行（error 付き）は出ない
    expect(rowsOf(events).filter((row) => row.contextUsage.error !== undefined)).toEqual([]);
    // 閉じかけに届いたターンの観測は積まない（積むと閉じたセッションへ聞くことになる）
    expect(sdk.callCount()).toBe(1);
    expect(rowsOf(events)).toHaveLength(1);
  });

  it('⭐ トークン回転の境界で観測が走っていれば、観測が終わるまで入力を閉じず、行は本来の中身で書かれる', async () => {
    const g = gate();
    const sdk = fakeSdk({
      getContextUsage: async (_callIndex, session) => {
        await g.opened;
        // 入力が閉じて CLI が終わった後の問い合わせは失敗する（本物の SDK と同じ）
        if (session.dead()) throw new Error('入力を閉じた後の getContextUsage');
        return usage;
      },
    });
    const { host, events } = await start(sdk);
    await sdk.finish('できました');
    await vi.waitFor(() => {
      if (!typesOf(events).includes('report')) throw new Error('report がまだ出ていない');
    });

    // 観測が返らないまま、鍵が回る（ターンの境界にいるので、すぐ入力を閉じにかかる）
    await host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-111' }]);
    await settle(40);
    // (i) 観測が終わるまで、入力は閉じず、セッションは差し替わらない
    expect(sdk.sessions[0]?.inputClosed()).toBe(false);
    expect(sdk.sessions).toHaveLength(1);

    g.open();
    // 観測が終わってから入力が閉じ、新しいセッションに差し替わる
    await vi.waitFor(() => {
      if (sdk.sessions.length < 2) throw new Error('セッションがまだ差し替わっていない');
    });
    // (ii) 行は偽の失敗でなく、本来の中身
    const rows = rowsOf(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contextUsage.error).toBeUndefined();
    expect(rows[0]?.contextUsage).toMatchObject({ ...usage });
  });
});
