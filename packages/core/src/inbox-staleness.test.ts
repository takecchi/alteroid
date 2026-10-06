import { describe, expect, it } from 'vitest';

import {
  commitmentFor,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
} from './clone.js';
import { completedTimerRoundVerdict, restoredInboxEventVerdict } from './inbox-staleness.js';
import type { InboxEvent } from './schema.js';

/**
 * `inboxBacklogDedupeKey`（`inbox-backlog.ts` / `inbox-backlog.test.ts`）と
 * 同じ作法。`Record<InboxEvent['type'], InboxEvent>` にすると各値が union
 * 全体へ広がり、narrow なフィールドの上書きが「そんな欄は無い」で弾かれるので、
 * 型ごとに narrow な型を保つマップにする。
 */
type SampleEvents = { readonly [K in InboxEvent['type']]: Extract<InboxEvent, { type: K }> };

/** 7つの型それぞれの、素な1件（`external` の `source` はここでは無関係な値）。 */
const SAMPLE_EVENTS: SampleEvents = {
  human_message: {
    type: 'human_message',
    id: 'e-human_message',
    at: '2026-09-11T00:00:00.000Z',
    text: 'こんにちは',
    conversationId: 'conv-1',
  },
  human_answer: {
    type: 'human_answer',
    id: 'e-human_answer',
    at: '2026-09-11T00:00:00.000Z',
    approvalId: 'appr-1',
    answer: 'yes',
  },
  distill: {
    type: 'distill',
    id: 'e-distill',
    at: '2026-09-11T00:00:00.000Z',
    reason: 'conversation_end',
  },
  timer: {
    type: 'timer',
    id: 'e-timer',
    at: '2026-09-11T00:00:00.000Z',
    kind: 'daily_report',
    target: '2026-09-10',
    cause: 'schedule',
  },
  external: {
    type: 'external',
    id: 'e-external',
    at: '2026-09-11T00:00:00.000Z',
    source: 'unrelated-source-for-non-external-tests',
    payload: { foo: 'bar' },
  },
  self_initiative: {
    type: 'self_initiative',
    id: 'e-self_initiative',
    at: '2026-09-11T00:00:00.000Z',
    reason: '暇なので',
    cause: 'schedule',
  },
  manager_message: {
    type: 'manager_message',
    id: 'e-manager_message',
    at: '2026-09-11T00:00:00.000Z',
    managerId: 'mgr-1',
    kind: 'report',
    text: '終わった',
  },
};

describe('restoredInboxEventVerdict', () => {
  // `external` 以外の6つの型は、拾い直しでもすべて `live`
  // （このファイルの doc「⟹ どちらも `live` に倒す」と対になる ——
  // `external` 以外は性質で割る余地が無く、一律で残す）。
  const LIVE_ALWAYS_TYPES = (Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][]).filter(
    (type) => type !== 'external',
  );

  it.each(LIVE_ALWAYS_TYPES)(
    '%s: 常に live（token-pool の合図以外を消し込む理由が無い）',
    (type) => {
      expect(restoredInboxEventVerdict(SAMPLE_EVENTS[type])).toBe('live');
    },
  );

  it('external: source が DAEMON_TOKEN_POOL_REOPENED_SOURCE（token-pool）なら stale', () => {
    const event: InboxEvent = {
      ...SAMPLE_EVENTS.external,
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    };
    expect(restoredInboxEventVerdict(event)).toBe('stale');
  });

  it('external: source が DAEMON_RUNNER_REGISTRY_SOURCE（runner-registry）なら live（過去の事実の記録であり、今の状態の再掲ではない）', () => {
    const event: InboxEvent = {
      ...SAMPLE_EVENTS.external,
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
    };
    expect(restoredInboxEventVerdict(event)).toBe('live');
  });

  it('external: 自由文字列の source（POST /events 由来のつもり）なら live（中身を知らない以上、要らないとは言えない）', () => {
    const event: InboxEvent = {
      ...SAMPLE_EVENTS.external,
      source: 'webhook-from-somewhere-outside',
    };
    expect(restoredInboxEventVerdict(event)).toBe('live');
  });

  it('未知の type は typecheck 済みの列挙で拾われ、実行時に届いても throw する（網羅性を型と実行時の両方で縛る）', () => {
    const unknown = { type: 'not-a-real-type' } as unknown as InboxEvent;
    expect(() => restoredInboxEventVerdict(unknown)).toThrow();
  });
});

describe('restoredInboxEventVerdict は usageBlocked を受け取らない（門の気分ではなく合図の性質だけで答えることを型で縛る）', () => {
  it('引数は event 1つだけ（実行時のシグネチャ）。増えたら「揺れる値で判定する」形へ戻ったということ', () => {
    // `restoredInboxEventVerdict.length` は、デフォルト値も rest も無い
    // パラメータの個数（ここでは `event` の1個）。関数の doc
    // 「この関数は usageBlocked を受け取らない」「引数に無いことが、その形に
    // ならないことの保証である」を、実行時にも固定する。
    expect(restoredInboxEventVerdict.length).toBe(1);
  });

  it('2引数目（usageBlocked のつもりの値）を渡すと型エラーになる（tsc が検査する）', () => {
    // @ts-expect-error 2引数目は無い。`usageBlocked` を受け取る形へ広げようと
    // すると、この行の型エラーが消えて `@ts-expect-error` 自体が「不要な抑制」
    // として `pnpm typecheck` を落とす —— つまりこの歯は、実装が
    // `usageBlocked` を受け取る形へ戻る変更を、typecheck の失敗として検出する。
    restoredInboxEventVerdict(SAMPLE_EVENTS.human_message, true);
    expect(true).toBe(true);
  });
});

/**
 * Issue #1534 案1。`#removeStaleRedeliveryChunk`（`clone.ts`）が
 * `#redeliveredClosed.delete` に歯を持てないのは、**いまの判定の下では
 * stale の合図が `commitmentFor` 非 null（＝台帳に載る＝`#redeliveredClosed`
 * に載りうる）になることが無いから**である（`clone-summary-reindex-and-tail.test.ts` の
 * grep -Fn -- '`#removeStaleRedeliveryChunk` の `#redeliveredClosed.delete` には歯を' packages/core/src/clone-summary-reindex-and-tail.test.ts
 * の注釈）。**その前提そのものを、判定の側（ここ）で固定する。**
 *
 * ⚠️ **この歯が赤くなったら**——`restoredInboxEventVerdict` が
 * `commitmentFor` 非 null の種別を `stale` と判定するよう変わった、
 * ということ。そのときは #1534 と上の `clone-summary-reindex-and-tail.test.ts` の注釈を読み、
 * `#removeStaleRedeliveryChunk` の `#redeliveredClosed.delete` に歯を
 * 足すこと（この歯はその歯の不在を正当化していた前提が崩れたと知らせる
 * だけで、崩れた後の穴そのものは塞がない）。
 *
 * 対象は `restoredInboxEventVerdict` の `switch` が分岐する全ての合図——
 * `external` 以外の6型は `SAMPLE_EVENTS` の1件ずつ（型レベルの
 * `SampleEvents` により、`InboxEvent['type']` が増えれば `SAMPLE_EVENTS`
 * 自体が typecheck で落ちる。上の「7つの型それぞれの、素な1件」の doc）、
 * `external` は分岐する3つの `source`（token-pool / runner-registry /
 * 自由文字列）すべてを列挙する——`type` だけで束ねると `external` の中の
 * 分岐が数え上げから漏れる。
 */
describe('restoredInboxEventVerdict が stale と言う合図は、必ず commitmentFor が null（Issue #1534 案1）', () => {
  const CANDIDATES: ReadonlyArray<readonly [string, InboxEvent]> = [
    ...(Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][]).map(
      (type) => [type, SAMPLE_EVENTS[type]] as const,
    ),
    [
      'external/DAEMON_TOKEN_POOL_REOPENED_SOURCE',
      { ...SAMPLE_EVENTS.external, source: DAEMON_TOKEN_POOL_REOPENED_SOURCE },
    ],
    [
      'external/DAEMON_RUNNER_REGISTRY_SOURCE',
      { ...SAMPLE_EVENTS.external, source: DAEMON_RUNNER_REGISTRY_SOURCE },
    ],
  ];

  it.each(CANDIDATES)('%s: stale なら commitmentFor は null', (_label, event) => {
    if (restoredInboxEventVerdict(event) !== 'stale') {
      // live 側には何も要求しない（含意なので空振り。次のテストが
      // 「少なくとも1件は stale」を別に固定し、この it.each が丸ごと
      // 空振りで終わっていないことを保証する）。
      return;
    }
    expect(commitmentFor(event)).toBeNull();
  });

  it('候補のうち少なくとも1件は stale である（この歯が空振りしていないことの対照）', () => {
    expect(CANDIDATES.some(([, event]) => restoredInboxEventVerdict(event) === 'stale')).toBe(true);
  });
});

/**
 * #3291 (c)。完了まで済んだのに受信箱の消し込みだけ失敗した timer 行を、再起動の配り直しで
 * もう一度走らせない。畳むのは**完了済みの回だけ**（`lastScheduledRunAt` 以前）である。
 */
describe('completedTimerRoundVerdict（#3291）', () => {
  const timer = (at: string, cause?: 'schedule' | 'schedule_catchup' | 'manual'): InboxEvent => ({
    type: 'timer',
    id: 't-1',
    at,
    kind: 'weekly-check',
    ...(cause === undefined ? {} : { cause }),
  });
  const LAST = '2026-08-18T00:00:00.000Z';

  it('回の時刻が lastScheduledRunAt と同じ・以前なら stale（完了済みの回）', () => {
    expect(completedTimerRoundVerdict(timer(LAST), LAST)).toBe('stale');
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z'), LAST)).toBe('stale');
    expect(completedTimerRoundVerdict(timer(LAST, 'schedule_catchup'), LAST)).toBe('stale');
  });

  it('まだ走っていない回（lastScheduledRunAt より後）は live — 畳まない', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-18T00:00:00.001Z'), LAST)).toBe('live');
    expect(completedTimerRoundVerdict(timer('2026-08-25T00:00:00.000Z'), LAST)).toBe('live');
  });

  it('時刻は実時刻で比べる（オフセット表記が違っても文字列順に引きずられない）', () => {
    // 2026-08-18T08:00+09:00 は 2026-08-17T23:00Z ＝ LAST より前。文字列では '2026-08-18T08' > LAST。
    expect(completedTimerRoundVerdict(timer('2026-08-18T08:00:00+09:00'), LAST)).toBe('stale');
    // 2026-08-17T20:00-05:00 は 2026-08-18T01:00Z ＝ LAST より後。文字列では LAST より前。
    expect(completedTimerRoundVerdict(timer('2026-08-17T20:00:00-05:00'), LAST)).toBe('live');
  });

  it('manual は定期の基準を進めないので判定しない（live）', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z', 'manual'), LAST)).toBe(
      'live',
    );
  });

  it('枠保持の印（heldForUsage）のある行は、完了済みの回でも live — 配り直す（#2814 / #3317）', () => {
    const held = { ...timer('2026-08-11T00:00:00.000Z'), heldForUsage: true } as InboxEvent;
    expect(completedTimerRoundVerdict(held, LAST)).toBe('live');
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z'), LAST)).toBe('stale');
  });

  it('基準が無い（未登録・一度も完了していない・読めなかった）なら live、timer 以外も live', () => {
    expect(completedTimerRoundVerdict(timer('2026-08-11T00:00:00.000Z'), undefined)).toBe('live');
    expect(completedTimerRoundVerdict(SAMPLE_EVENTS.human_message, LAST)).toBe('live');
  });
});
