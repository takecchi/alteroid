import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * **同じ枠落ちの連なりを、日誌へ1行にまとめる**（issue #1311）。
 *
 * `journal` は本番で **4,394 MB ＝ DB 最大**・**約 1.9 GB/日**で増えており、
 * **1行あたり約 985 バイト**（うち 618 バイトは本文に依存しない固定費）である。
 * ⟹ **効く梃子は本文の長さではなく行数である。** そして本番には
 * **同じ本文が4時間で162行・間隔 4.6〜8.2 秒**という反復が実際に在る。
 *
 * ## ⚠️ 測り分けたいこと（畳みすぎと畳み足りないの両方）
 *
 * 「減った」だけを測ると**黙って失う**側の壊れ方が緑のまま通る。だから
 * describe を分け、**落ちる集合が分かれる**形にしてある。
 *
 * ## ⭐ `usageTransitionOf` は縁でしか発火しない
 *
 * `next.status === 'rejected' && previous?.status !== 'rejected'` なので、
 * `rejected` を続けて送っても2件目以降は**そもそも日誌へ来ない**。
 * ⟹ **反復を作るには `allowed` を挟んで縁を立て直す**（`allowed` 自体は
 * 遷移を返さないので日誌へ1行も書かない）。
 */

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
}> {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  // **時計は注入する**（`manager-withheld-reports.test.ts` と同じ作法）。
  // 畳みの窓は `setTimeout` ではなく観測時の判定なので、`vi.useFakeTimers` は要らない。
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
    now: () => clock,
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
  };
}

/** 日誌に残った本文のうち、断片を含むもの（古い順）。 */
async function journalTexts(stores: Stores, fragment: string): Promise<string[]> {
  const entries = await stores.journal.list();
  return entries
    .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
    .filter((text) => text.includes(fragment))
    .reverse();
}

/**
 * 🔴 **素の「追い返された」の行だけ**（要約を除く）。
 *
 * ⚠️ **要約は畳んだ本文を丸ごと載せる**（`foldedRunText` —— そうしないと読み手が
 * 「何が N 回起きたのか」を別の場所から探すことになる）。⟹ **断片で数えるだけだと
 * 要約も一緒に数えてしまい、「本物の行が2本」と「1本＋要約」が区別できない。**
 *
 * **実際にこれで測り損ねた**: 空きの判定を殺す変異を当てても、要約が断片に当たる
 * せいで件数が2のまま緑になった（＝**畳みすぎが緑のまま通る**という、この
 * リポジトリが何度も踏んでいる型）。⟹ 要約を明示的に外す。
 */
async function bounceLines(stores: Stores): Promise<string[]> {
  const all = await journalTexts(stores, REJECTED_FRAGMENT);
  return all.filter((text) => !text.includes(FOLD_FRAGMENT));
}

/** 縁を立て直して、もう一度「追い返された」を起こす。 */
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

    // 2件目・3件目は畳まれるので、行は増えない
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await journalTexts(s.stores, FOLD_FRAGMENT)).toHaveLength(0);

    await s.pool.stop();

    const summaries = await journalTexts(s.stores, FOLD_FRAGMENT);
    expect(summaries).toHaveLength(1);
    // 要約は「何が」「何回」を自分だけで名乗る
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

    // 既定の空き（60秒）を大きく超える
    s.advance(600_000);
    await bounceAgain(s.session);

    await vi.waitFor(async () => {
      expect(await bounceLines(s.stores)).toHaveLength(2);
    });

    await s.pool.stop();
  }, 12_000);
});
