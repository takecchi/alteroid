import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * **Issue #977 — 委譲層（マネージャー／ランナー層）の `contextUsage` 配線に
 * 歯が無かった。第1段でここに固定したのは当時の挙動、第2段（#976）で
 * 「失敗したターンでは載らない」の期待を「載る」へ書き換えた。**
 *
 * `runner.ts` の `case 'turn_ended'` は `#observeContextUsage()` を成否分岐の
 * 手前で呼ぶ（呼び出し直前のコメントが #931 を名指しして理由を書いている。
 * 逐語は `grep -Fn -- '成否で絞ると、失敗したターン' packages/core/src/runner.ts`）。
 * かつては測った値が外へ出る経路が `if (event.succeeded)` の内側にある
 * `usage` イベントしか無く、失敗したターンの文脈占有はどこにも残らな
 * かった（#976）。**いまは `event.succeeded` を見る前に独立の
 * `context_usage` イベントも emit するので、失敗したターンでもそちらへ
 * 残る**（`usage`／`turn_usage.contextUsage` 側は既存の読み手との互換の
 * ため変えていない——両方とも「成功して増分もあった回」には引き続き載る）。
 *
 * **⭐ 歯が噛むこと。** 下の「失敗したターンでも contextUsage は
 * context_usage として残る」のテストは、`runner.ts` の `case 'context_usage'`
 * emit を取り除く（`#976` 実装前の形へ戻す）と実際に赤くなることを確認
 * 済み（PR 本文に変異試験の結果を記録）。
 *
 * **フェイクの `Query` の作り方は `clone.test.ts` の
 * `describe('ターンの境界で聞いた文脈占有・compaction・result.usage')` と
 * 同じ形**——`getContextUsage` を呼び出し側が差し替えられる口にしてあり、
 * 省略すれば `Query` がこのメソッドを持たない実機の古い版と同じ形になる
 * （`clone.test.ts` の `fakeSdk` の doc と同じ理由）。`runner-failure.test.ts`
 * の `fakeSdk` を土台にしている（あちらは `getContextUsage` を持たない）。
 *
 * **別ファイルにしてあるのは `runner-failure.test.ts` と同じ理由**——既存の
 * 100本超のテストと偽物を共有すると、そちらの都合（`getContextUsage` を
 * 持たない前提）を変えることになる。この関心に要る形だけを持つ偽物を
 * 自分で用意する。
 */

interface FakeSession {
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
}

/** `modelUsage`（SDK の綴りは `costUSD`）。1本のモデルだけを固定で返す。 */
function fixedModelUsage() {
  return {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 1,
    },
  };
}

function fakeSdk(options: { getContextUsage?: (callIndex: number) => unknown } = {}) {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const callIndex = sessions.length;
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(finishes += 1)}`,
          // **成功以外の `subtype` では `foldClaudeMessage` がこれを捨てる**
          // （`claude-provider.ts` の `isSuccessResult` — `subtype` だけで
          // 判定する）。だから常に載せても、失敗ターンの挙動は変わらない。
          modelUsage: fixedModelUsage(),
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
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
      ...(options.getContextUsage === undefined
        ? {}
        : { getContextUsage: async () => options.getContextUsage!(callIndex) }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

function setup(options: { getContextUsage?: (callIndex: number) => unknown } = {}): {
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  sessions: FakeSession[];
  inbox: InboxEvent[];
} {
  const { fn, sessions } = fakeSdk(options);
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
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
    post: (event) => inbox.push(event),
    runners: registry,
  });
  return { pool, stores, sessions, inbox };
}

async function turnUsageRows(stores: Stores) {
  const entries = await stores.journal.list({ types: ['turn_usage'] });
  return entries.flatMap((entry) => (entry.type === 'turn_usage' ? [entry] : []));
}

async function contextUsageRows(stores: Stores) {
  const entries = await stores.journal.list({ types: ['context_usage'] });
  return entries.flatMap((entry) => (entry.type === 'context_usage' ? [entry] : []));
}

async function firstSession(sessions: FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

describe('委譲層（ランナー）の contextUsage 配線（Issue #977 / #976）', () => {
  it('成功したターンは turn_usage.contextUsage に値が載る', async () => {
    const s = setup({
      getContextUsage: () => ({
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
      }),
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(s.stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.contextUsage).toEqual({
      durationMs: expect.any(Number),
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    });

    await s.pool.stop();
  });

  it('失敗したターンでも contextUsage は context_usage として残る（#976 の直った後の挙動）', async () => {
    const s = setup({
      getContextUsage: () => ({
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
      }),
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    // **`subtype` を `success` 以外にする。** `is_error` だけでは
    // `isSuccessResult`（`subtype` だけを見る）は真のままなので、
    // `event.succeeded` を偽にするにはこちらが要る（`runner.ts` の
    // 「`succeeded` はこれを兼ねられない」のコメントのとおり）。
    await session.finish('', { subtype: 'error_during_execution', isError: true });

    // 何らかの跡（報告・通知）が届くまで待ってから確かめる——即座に見ると
    // 「まだ処理していないだけ」と「本当に無い」が区別できない。
    // **既定の合流窓（3000ms）より長く取る**（`runner-failure.test.ts` の
    // `reportTexts` と同じ理由——分類できなかった失敗の報告は
    // `synthesized: 'turn_failed'` として合流窓を挟んでから配られる）。
    await vi.waitFor(
      () => {
        if (s.inbox.length === 0) throw new Error('報告がまだ届いていない');
      },
      { timeout: 5000 },
    );

    // **`turn_usage` の側は今も1件も作らない。** `usage` イベントは
    // `if (event.succeeded)` の内側でしか emit されないので、失敗した
    // ターンの消費そのものはここには残らない（#976 が変えたのはこちらでは
    // ない）。
    expect(await turnUsageRows(s.stores)).toHaveLength(0);

    // **⭐ ここが #976 の直した非対称である。** `#observeContextUsage` は
    // 成否分岐の手前で呼ばれ値を測っており、`context_usage` イベントは
    // `event.succeeded` を見る前に無条件で emit される（`runner.ts` の
    // `case 'turn_ended'`）ので、失敗したターンでも文脈占有はここへ残る。
    const contextRows = await vi.waitFor(async () => {
      const found = await contextUsageRows(s.stores);
      if (found.length === 0) throw new Error('context_usage がまだ日誌に無い');
      return found;
    });
    expect(contextRows[0]?.turnSucceeded).toBe(false);
    expect(contextRows[0]?.contextUsage).toEqual({
      durationMs: expect.any(Number),
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    });

    await s.pool.stop();
  });

  it('`getContextUsage()` が例外を投げても、ターンの成否には影響しない', async () => {
    const s = setup({
      getContextUsage: () => {
        throw new Error('観測に失敗（テスト用）');
      },
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    // ターンが成功のまま完走している（成功しなければ turn_usage 自体が
    // 書かれない——上のテストで固定したとおり）。
    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(s.stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    // `#observeContextUsage` は例外を内側で受け止め、`error` として運ぶ
    // （`contextUsageObservationSchema` の doc「試して失敗した」）。
    expect(rows[0]?.contextUsage?.error).toBeDefined();
    expect(rows[0]?.contextUsage?.totalTokens).toBeUndefined();

    await s.pool.stop();
  });

  it('`getContextUsage` を実装していない `Query`（実機で未対応のときと同じ形）でも、ターンは止まらない', async () => {
    // `getContextUsage` オプションを渡さない ＝ フェイクの `Query` はこの
    // メソッドを持たない（`fakeSdk` の doc）。
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(s.stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.contextUsage?.error).toBeDefined();
    expect(typeof rows[0]?.contextUsage?.durationMs).toBe('number');

    await s.pool.stop();
  });
});
