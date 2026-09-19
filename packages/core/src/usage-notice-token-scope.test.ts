import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **枠の事実の記憶は、トークン（アカウント）ごとに分かれている。**
 *
 * `rate_limit_event` が運ぶのは「そのセッションが乗っているアカウントの事実」で
 * あって、デーモン全体の事実ではない。**この repo のアカウントは1つではない**
 * （トークンのプール。#393）。しかも鍵が回っても走行中のセッションには届かない
 * ので、回転の前後では「古い鍵で走る委譲」と「新しい鍵で起きた委譲」が同時に
 * 存在する。
 *
 * ## ここで固定している穴（Issue #1222 の実測）
 *
 * 1本のマネージャーから「枠から追い返された（five_hour）」という**完全に同じ
 * 文言**が、4時間43分で10回以上、台帳と受信箱の両方へ積まれた。機序は、記憶の鍵が
 * 枠の種類だけだったため、**別の（健全な）トークンで走る委譲の `allowed` が、
 * 枠の尽きたトークンの `rejected` の記憶を踏み消していた**こと。⟹ 次の
 * `rejected` が「新しい遷移」に化けて、同じ文言がもう一度配られる。
 *
 * ## テストを2種類に分けてある理由
 *
 * `usage-notice-redelivery.test.ts` と同じ作法である —— 「二重に配らない」と
 * 「取りこぼさない」を1本で測ると、**片方を満たして片方を破る変更が緑のまま通る。**
 * 畳みすぎ（黙って失う）は、このリポジトリが何度も踏んでいる型なので、describe を
 * 分けて、変異させたときに落ちる集合が分かれる形にしてある。
 *
 * ⚠️ **ここが測っているのは記憶の鍵だけである。** 配達の合流窓
 * （`SYNTHESIZED_NOTICE_WINDOW_MS`）も、`#usageNotices` の畳みも触っていない。
 */

/** 送った順を保つための連番（同じ本文の観測でも uuid を分ける）。 */
let messageSeq = 0;

interface FakeSession {
  /** `rate_limit_event`（ターンの頭ごとに来る、枠の権威ある事実）。 */
  rateLimit(info: Record<string, unknown>): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    // 待ち方は `usage-notice-redelivery.test.ts` の偽 SDK と同じ形にしてある
    // （自前のポーリングにすると `close()` で畳めず、`pool.stop()` の後も残る）。
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const sessionId = `sess-mgr-${sessions.length}`;
    const push = async (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
      // 降ろした1件をデーモン側が捌き切るまで1マクロタスク譲る。**順序の保証は
      // これに頼っていない** —— 判定（畳むか配るか）は `#onEvent` の await より
      // 手前で同期に決まるので、ここは待ち時間を短くするためだけのものである。
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    sessions.push({
      async rateLimit(info) {
        messageSeq += 1;
        await push({
          type: 'rate_limit_event',
          rate_limit_info: info,
          session_id: sessionId,
          uuid: `uuid-rl-${messageSeq}`,
        } as unknown as SDKMessage);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: `uuid-init-${sessionId}`,
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

/**
 * 委譲を2本立て、**それぞれ別のトークンの身元で**セッションを起こす。
 *
 * `#rememberTokenIdentity` は `start()` の瞬間に `tokenIdentity()` を1度だけ読む
 * ので、起こす前に現役を差し替えると「回転の前後で2本が別の鍵に乗っている」実際の
 * 状態を、往復を1つも足さずに作れる。
 */
async function setupTwoTokens(): Promise<{
  pool: ReturnType<typeof createManagerPool>;
  a: FakeSession;
  b: FakeSession;
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
  let active: { tokenId: string; generation: number } = { tokenId: 'tok-old', generation: 1 };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    tokenIdentity: () => active,
  });

  await pool.start({ request: '古い鍵で走り続ける委譲' });
  const a = await vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('1本目のセッションがまだ開いていない');
    return found;
  });

  // 鍵が回った。**走行中の1本目には届かない**（token-pool の「走行中には届かない」）
  // ので、ここから起こす2本目だけが新しい鍵に乗る。
  active = { tokenId: 'tok-new', generation: 2 };
  await pool.start({ request: '新しい鍵で起きた委譲' });
  const b = await vi.waitFor(() => {
    const found = sessions[1];
    if (!found) throw new Error('2本目のセッションがまだ開いていない');
    return found;
  });

  return { pool, a, b, inbox };
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

const rejected = (kind: string) => ({ rateLimitType: kind, status: 'rejected' });
const allowed = (kind: string) => ({ rateLimitType: kind, status: 'allowed' });

/**
 * **「その後に送った分まで捌き終えた」を、時間ではなく別の配達で待つ。**
 *
 * 「N 件しか配られていない」は、配られていないことの確認なので、待ち方を時間に
 * 頼ると器の速さで揺れる。⟹ 同じセッションへ**必ず配られる別の種類**を最後に
 * 流し、それが届いたことをもって「手前の分は全部捌き終えた」と読む（同じ
 * セッションの観測は順序を保つ）。
 */
const SENTINEL_KIND = 'seven_day_opus';
async function drain(session: FakeSession, inbox: InboxEvent[]): Promise<void> {
  const before = countReports(inbox, SENTINEL_KIND);
  await session.rateLimit(rejected(SENTINEL_KIND));
  await vi.waitFor(() => expect(countReports(inbox, SENTINEL_KIND)).toBe(before + 1), {
    timeout: 10_000,
  });
}

describe('枠の知らせ — 二重に配らない歯（トークンを跨がない）', () => {
  it('別のトークンで走る委譲の allowed は、枠が尽きた側の rejected の記憶を消さない', async () => {
    const s = await setupTwoTokens();
    try {
      // 1本目（古い鍵）が枠から追い返された。**ここは配る**（1件目は必ず配る）。
      await s.a.rateLimit(rejected('five_hour'));
      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(1), {
        timeout: 10_000,
      });

      // 2本目（新しい鍵）は健全なので、ターンの頭ごとに `allowed` を運ぶ。
      // **これが1本目の記憶を踏み消していたのが Issue #1222 の機序である。**
      await s.b.rateLimit(allowed('five_hour'));
      // 1本目は同じ状態のまま追い返され続ける。**同じ出来事なので配らない。**
      await s.a.rateLimit(rejected('five_hour'));
      await s.b.rateLimit(allowed('five_hour'));
      await s.a.rateLimit(rejected('five_hour'));

      await drain(s.a, s.inbox);

      expect(countReports(s.inbox, 'five_hour')).toBe(1);
    } finally {
      await s.pool.stop();
    }
  }, 30_000);
});

describe('枠の知らせ — 取りこぼさない歯', () => {
  it('同じトークンで枠が開いたと観測できたら、次に追い返されたときはもう一度配る', async () => {
    const s = await setupTwoTokens();
    try {
      await s.a.rateLimit(rejected('five_hour'));
      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(1), {
        timeout: 10_000,
      });

      // **同じ鍵**で枠が開き、そのうえで閉じ直した。これは本物の再発である。
      await s.a.rateLimit(allowed('five_hour'));
      await s.a.rateLimit(rejected('five_hour'));

      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(2), {
        timeout: 10_000,
      });
    } finally {
      await s.pool.stop();
    }
  }, 30_000);

  it('別のトークンで同じ種類の枠に当たったら、それは新しい出来事として配る', async () => {
    const s = await setupTwoTokens();
    try {
      await s.a.rateLimit(rejected('five_hour'));
      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(1), {
        timeout: 10_000,
      });

      // **新しい鍵でも枠に当たった。** 記憶を `kind` だけで引いていた版では
      // `usageTransitionOf` が `undefined` を返し、これが1度も配られなかった
      // （Issue #668。実運用で20分以上の停止として観測された）。
      await s.b.rateLimit(rejected('five_hour'));

      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(2), {
        timeout: 10_000,
      });
    } finally {
      await s.pool.stop();
    }
  }, 30_000);
});
