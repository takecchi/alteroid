import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';


const REJECTED = { rateLimitType: 'five_hour', status: 'rejected' };
const ALLOWED = { rateLimitType: 'five_hour', status: 'allowed' };
const REJECTED_FRAGMENT = '枠から追い返された';
const FOLD_FRAGMENT = '同じ合図が続いたので畳んだ';

interface FakeSession {
  rateLimit(info: Record<string, unknown>): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = async (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    sessions.push({
      async rateLimit(info) {
        await push({
          type: 'rate_limit_event',
          rate_limit_info: info,
          session_id: 'sess-mgr',
          uuid: `uuid-rl-${String(Math.random())}`,
        } as unknown as SDKMessage);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

async function setup(): Promise<{
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  session: FakeSession;
  advance: (ms: number) => void;
  clockNow: () => number;
  nowCalls: number[];
}> {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  const nowCalls: number[] = [];
  // `vi.useFakeTimers` は使わず時計を注入する: 畳みの窓は `setTimeout` ではなく観測時の判定。
  let clock = Date.parse('2026-09-23T00:00:00.000Z');
  const registry = createRunnerRegistry([
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
    }),
  ]);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    now: () => {
      nowCalls.push(clock);
      return clock;
    },
  });
  await pool.start({ request: '枠の知らせを観測する' });
  const session = await vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
  return {
    pool,
    stores,
    session,
    advance: (ms) => {
      clock += ms;
    },
    clockNow: () => clock,
    nowCalls,
  };
}

// 畳まれた回は日誌に何も書かず「行が増えた」では済んだと分からないので、縁の処理が `now()` を2回呼ぶことを印にする。2回目（合成通知の組み立て）は日誌の書き込みの後ろなので、見えたときにはその縁の行は書き終わっている。時計の値は縁ごとに違うこと（呼び出し側が先に `advance` する）。
async function waitForEdgeHandled(s: {
  clockNow: () => number;
  nowCalls: number[];
}): Promise<void> {
  const at = s.clockNow();
  await vi.waitFor(() => {
    expect(s.nowCalls.filter((value) => value === at).length).toBeGreaterThanOrEqual(2);
  });
}

async function journalTexts(stores: Stores, fragment: string): Promise<string[]> {
  const entries = await stores.journal.list();
  return entries
    .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
    .filter((text) => text.includes(fragment))
    .reverse();
}

// 要約を明示的に外す: 要約は畳んだ本文を丸ごと載せるので、断片で数えるだけだと「本物の行が2本」と「1本＋要約」が区別できず、畳みすぎが緑のまま通る。
async function bounceLines(stores: Stores): Promise<string[]> {
  const all = await journalTexts(stores, REJECTED_FRAGMENT);
  return all.filter((text) => !text.includes(FOLD_FRAGMENT));
}

// `rejected` を続けても2件目以降は日誌へ来ない（縁でしか発火しない）ので、`allowed` を挟んで縁を立て直す。
async function bounceAgain(session: FakeSession): Promise<void> {
  await session.rateLimit(ALLOWED);
  await session.rateLimit(REJECTED);
}

describe('日誌の畳み込み — 速い反復は1行にまとまる', () => {
  it('⭐ 3回続けて追い返されても、日誌の「追い返された」は1行だけ', async () => {
    const s = await setup();

    await s.session.rateLimit(REJECTED);
    await vi.waitFor(async () => {
      expect(await bounceLines(s.stores)).toHaveLength(1);
    });

    s.advance(8_000);
    await bounceAgain(s.session);
    s.advance(8_000);
    await bounceAgain(s.session);

    // 「増えないこと」は待てないので、先に3回目の処理が済むのを待つ: 待たずに数えると、処理が遅れたとき空振りで緑になる。
    await waitForEdgeHandled(s);
    expect(await bounceLines(s.stores)).toHaveLength(1);

    await s.pool.stop();
  }, 12_000);

  it('⭐ 止めるときに、畳んだぶんの要約が1行残る（黙って消えない）', async () => {
    const s = await setup();

    await s.session.rateLimit(REJECTED);
    s.advance(8_000);
    await bounceAgain(s.session);
    s.advance(8_000);
    await bounceAgain(s.session);
    await waitForEdgeHandled(s);

    expect(await journalTexts(s.stores, FOLD_FRAGMENT)).toHaveLength(0);

    await s.pool.stop();

    const summaries = await journalTexts(s.stores, FOLD_FRAGMENT);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain(REJECTED_FRAGMENT);
    expect(summaries[0]).toContain('1 + 2');
  }, 12_000);
});

describe('⛔ 日誌の畳み込み — 間の空いた本物の再発は畳まない', () => {
  it('⭐ 10分空けて再発したら、本文が同じでも2行目が書かれる', async () => {
    const s = await setup();

    await s.session.rateLimit(REJECTED);
    await vi.waitFor(async () => {
      expect(await bounceLines(s.stores)).toHaveLength(1);
    });

    s.advance(600_000);
    await bounceAgain(s.session);

    await vi.waitFor(async () => {
      expect(await bounceLines(s.stores)).toHaveLength(2);
    });

    await s.pool.stop();
  }, 12_000);
});
