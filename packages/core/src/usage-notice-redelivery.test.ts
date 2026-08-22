import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * **枠（利用上限）の知らせを、同じ内容で二度クローンへ配らない。**
 *
 * 実測（クローンの受信箱、2026-08-22 の報告）: 枠で死んだマネージャー1本から
 * 7通が届き、そのうち少なくとも1通は先に届いた1通と**完全に同じ文言**だった。
 * 配達1本ごとにクローンのターンが1つ焼かれ、しかもそのターンは**枠が閉じている
 * 最中の消費**である（いちばん払えないときにいちばん払う）。
 *
 * 直す前の機構は2箇所とも「**最後に観測した値**」を覚えていた。
 *
 * - `#rateLimits`: 届いた `RateLimitFacts` で丸ごと置き換える。`status` を
 *   運んでいない観測（全フィールドが省略可で、`toRateLimitFacts` は1つでも
 *   読めれば値を返す）が1件挟まるだけで「もう `rejected` を知らせた」という
 *   記憶が消え、次の同じ `rejected` が新しい遷移として配られる
 * - `#usageNotices`: 種類ごとに「最後に見た文言」1つだけを覚え、`!==` で判定する。
 *   同じ種類（`reached`）で英文が2通り届く状況では**毎回「違う」と答える**ので、
 *   A→B→A→B のたびに配られる
 *
 * **覚える対象を「観測した値」から「配った事実」へ変えたのがこの直しである。**
 *
 * ## テストを2種類に分けてある理由
 *
 * 「二重に配らない」と「取りこぼさない」を1本のテストで測ると、**片方を満たして
 * 片方を破る変更が緑のまま通る**（畳みすぎ＝黙って失う、は、このリポジトリが
 * 何度も踏んでいる型である）。だから describe を分け、変異させたときに
 * **落ちる集合が分かれる**ことを確かめられる形にしてある。
 */

/** 実機で観測された文言そのまま（`USAGE_LIMIT_ERROR_PREFIXES` の "You've hit your"）。 */
const SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
/** 同じ分類（`reached`）だが**別の文言**（"You've reached your"）。 */
const FIVE_HOUR_LIMIT = "You've reached your 5-hour limit · resets at 3pm";

interface FakeSession {
  /** `rate_limit_event`（ターンの頭ごとに来る、枠の権威ある事実）。 */
  rateLimit(info: Record<string, unknown>): Promise<void>;
  /** `system` の通知（上限の英文はここに載って降りてくる）。 */
  notify(text: string): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    // 待ち方は `runner-failure.test.ts` の偽 SDK と同じ形にしてある（自前の
    // ポーリングにすると `close()` で畳めず、`pool.stop()` の後も残る）。
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = async (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
      // 降ろした1件をデーモン側が捌き切るまで1マクロタスク譲る。**順序の保証は
      // これに頼っていない** — 判定（畳むか配るか）は `#onEvent` の await より
      // 手前で同期に決まるので、ここは待ち時間を短くするためだけのものである。
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    sessions.push({
      async rateLimit(info) {
        await push({
          type: 'rate_limit_event',
          rate_limit_info: info,
          session_id: 'sess-mgr',
          uuid: `uuid-rl-${JSON.stringify(info).length}`,
        } as unknown as SDKMessage);
      },
      async notify(text) {
        await push({
          type: 'system',
          subtype: 'notification',
          text,
          session_id: 'sess-mgr',
          uuid: `uuid-note-${text.length}`,
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
  inbox: InboxEvent[];
}> {
  const { fn, sessions } = fakeSdk();
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
  await pool.start({ request: '枠の知らせを観測する' });
  const session = await vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
  return { pool, stores, session, inbox };
}

/** 受信箱へ届いた `kind: 'report'` の本文（届いた順）。 */
function reports(inbox: InboxEvent[]): string[] {
  return inbox
    .filter((entry) => entry.type === 'manager_message' && entry.kind === 'report')
    .map((entry) => (entry as { text: string }).text);
}

/** 本文に断片を含む報告の数。 */
function countReports(inbox: InboxEvent[], fragment: string): number {
  return reports(inbox).filter((text) => text.includes(fragment)).length;
}

/** 日誌に残った行のうち、断片を含むもの（古い順に戻す）。 */
async function journalTexts(stores: Stores, fragment: string): Promise<string[]> {
  const entries = await stores.journal.list();
  return entries
    .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
    .filter((text) => text.includes(fragment))
    .reverse();
}

describe('枠の知らせ — 二重に配らない歯', () => {
  it('status を運ばない観測が挟まっても、同じ rejected を二度配らない', async () => {
    const s = await setup();
    const rejected = {
      rateLimitType: 'five_hour',
      status: 'rejected',
      overageDisabledReason: 'org_level_disabled_until',
    };

    await s.session.rateLimit(rejected);
    await vi.waitFor(() => {
      expect(countReports(s.inbox, '枠から追い返された')).toBe(1);
    });

    // **`status` を1つも運ばない観測。** `toRateLimitFacts` は「1つでも読めた」
    // 時点で値を返すので、これは異常な入力ではなく正常な入力である。直す前は
    // ここで「もう知らせた」という記憶が消えていた。
    await s.session.rateLimit({ rateLimitType: 'five_hour', resetsAt: 1_770_000_000 });
    await s.session.rateLimit(rejected);

    // **「まだ届いていないだけ」と区別する。** 後から必ず配られるものを1本
    // 挟み、それが届いたことをもって「上の2件の判定は済んだ」とする。
    await s.session.notify(SPEND_LIMIT);
    await vi.waitFor(() => {
      expect(countReports(s.inbox, '利用上限に当たった')).toBe(1);
    });

    expect(countReports(s.inbox, '枠から追い返された')).toBe(1);

    await s.pool.stop();
  });

  it('同じ種類で文言が交互に届いても、配るのは初めて見た文言のときだけ', async () => {
    const s = await setup();

    // 分類はどちらも `reached`。**文字列は一致しない**（1通目と2通目が同じ事象
    // なのに一致しない、という実測そのものの形）。
    await s.session.notify(SPEND_LIMIT);
    await s.session.notify(FIVE_HOUR_LIMIT);
    await vi.waitFor(() => {
      expect(countReports(s.inbox, '利用上限に当たった')).toBe(2);
    });

    // ここから先は全部「もう配った文言」である。直す前は `!==` が毎回真になり、
    // この3件がそのまま3ターン焼いていた。
    await s.session.notify(SPEND_LIMIT);
    await s.session.notify(FIVE_HOUR_LIMIT);
    await s.session.notify(SPEND_LIMIT);

    await vi.waitFor(async () => {
      expect(
        (await journalTexts(s.stores, '配達済みの知らせなので受信箱へは回さない')).length,
      ).toBe(3);
    });
    expect(countReports(s.inbox, '利用上限に当たった')).toBe(2);

    await s.pool.stop();
  });
});

describe('枠の知らせ — 取りこぼさない歯', () => {
  it('畳んだ分は1件ずつ日誌に残り、件数が次に配る1本の本文に載る', async () => {
    const s = await setup();

    await s.session.notify(SPEND_LIMIT);
    await vi.waitFor(() => {
      expect(countReports(s.inbox, '利用上限に当たった')).toBe(1);
    });

    await s.session.notify(SPEND_LIMIT);
    await s.session.notify(SPEND_LIMIT);
    const folded = await vi.waitFor(async () => {
      const lines = await journalTexts(s.stores, '配達済みの知らせなので受信箱へは回さない');
      expect(lines.length).toBe(2);
      return lines;
    });
    // **何件目かが行に入っている。** 「畳んだ」だけでは、何件ぶんが受信箱へ
    // 回らなかったのかが後から数えられない。
    expect(folded[0]).toContain('この種類で 1 件目');
    expect(folded[1]).toContain('この種類で 2 件目');
    // 畳んだ行にも中身（SDK の原文）が残っている — 記録の側では失っていない。
    expect(folded[1]).toContain(SPEND_LIMIT);

    // **受信箱しか見ていない読み手にも「畳んだ」が見える。** 次に配る1本へ
    // 件数が載る。ここが無いと、畳んだことが受信箱側の観測から消える。
    await s.session.notify(FIVE_HOUR_LIMIT);
    const delivered = await vi.waitFor(() => {
      const found = reports(s.inbox).filter((text) => text.includes('利用上限に当たった'));
      expect(found.length).toBe(2);
      return found;
    });
    expect(delivered[1]).toContain(FIVE_HOUR_LIMIT);
    expect(delivered[1]).toContain('2 件畳んでいる');

    await s.pool.stop();
  });

  it('枠が開いたと観測できたら、次に追い返されたときはもう一度配る', async () => {
    const s = await setup();
    const rejected = { rateLimitType: 'five_hour', status: 'rejected' };

    await s.session.rateLimit(rejected);
    await vi.waitFor(() => {
      expect(countReports(s.inbox, '枠から追い返された')).toBe(1);
    });

    // **これは「何も言っていない観測」ではなく「開いたという観測」である。**
    // 記憶を重ねる形にしたせいで本物の再発が黙って消える、という裏返しを
    // 作っていないことを、ここで固定する。
    await s.session.rateLimit({ rateLimitType: 'five_hour', status: 'allowed' });
    await s.session.rateLimit(rejected);

    await vi.waitFor(() => {
      expect(countReports(s.inbox, '枠から追い返された')).toBe(2);
    });

    await s.pool.stop();
  });
});
