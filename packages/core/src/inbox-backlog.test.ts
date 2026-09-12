import { describe, expect, it } from 'vitest';

import {
  INBOX_BACKLOG_LOUD_THRESHOLD,
  describeInboxBacklogBreakdown,
  inboxBacklogDedupeKey,
  summarizeInboxBacklog,
  type InboxBacklogBreakdown,
} from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const HOUR_MS_FOR_TEST = 60 * 60 * 1000;

function row(event: InboxEvent, at: string, deliveries = 0): PendingInboxEvent {
  return { event, at, deliveries };
}

/**
 * `Record<InboxEvent['type'], InboxEvent>` にすると、各値が union 全体へ
 * 広がり、`{ ...a, text: '...' }` のような narrow なフィールドの上書きが
 * 「そんな欄は無い」で弾かれる（このテストは元々これを踏んだ）。
 * 型ごとに narrow な型を保つマップにする。
 */
type SampleEvents = { readonly [K in InboxEvent['type']]: Extract<InboxEvent, { type: K }> };

/** 7つの型それぞれの、素な1件（`id` / `at` は呼び出し側が上書きする前提）。 */
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
    source: 'webhook-a',
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

const ALL_TYPES = Object.keys(SAMPLE_EVENTS) as InboxEvent['type'][];

describe('inboxBacklogDedupeKey', () => {
  it.each(ALL_TYPES)('%s: id と at だけが違う2件は同じ鍵になる', (type) => {
    const base = SAMPLE_EVENTS[type];
    const a: InboxEvent = { ...base, id: 'id-a', at: '2026-09-11T00:00:00.000Z' } as InboxEvent;
    const b: InboxEvent = { ...base, id: 'id-b', at: '2026-09-11T05:00:00.000Z' } as InboxEvent;

    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('human_message: text が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_message;
    const b: InboxEvent = { ...a, id: 'id-b', text: '別の発言' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('human_message: conversationId が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_message;
    const b: InboxEvent = { ...a, id: 'id-b', conversationId: 'conv-2' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('human_answer: answer が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_answer;
    const b: InboxEvent = { ...a, id: 'id-b', answer: 'no' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('human_answer: approvalId が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.human_answer;
    const b: InboxEvent = { ...a, id: 'id-b', approvalId: 'appr-2' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('manager_message: managerId / kind / text のいずれが違っても別の鍵', () => {
    const a = SAMPLE_EVENTS.manager_message;
    const byManager: InboxEvent = { ...a, id: 'id-b', managerId: 'mgr-2' };
    const byKind: InboxEvent = { ...a, id: 'id-c', kind: 'question' };
    const byText: InboxEvent = { ...a, id: 'id-d', text: '別の報告' };
    const key = inboxBacklogDedupeKey(a);
    expect(inboxBacklogDedupeKey(byManager)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byKind)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byText)).not.toBe(key);
  });

  it('manager_message: requestId / markup（id・at 以外だが鍵に含めない欄）が違っても同じ鍵', () => {
    const a: InboxEvent = { ...SAMPLE_EVENTS.manager_message, requestId: 'req-1' };
    const b: InboxEvent = { ...SAMPLE_EVENTS.manager_message, id: 'id-b', requestId: 'req-2' };
    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('external: source が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.external;
    const b: InboxEvent = { ...a, id: 'id-b', source: 'webhook-b' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('external: payload の中身が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.external;
    const b: InboxEvent = { ...a, id: 'id-b', payload: { foo: 'baz' } };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('external: payload が省略（undefined）と null は同じ鍵になる（`payload ?? null`）', () => {
    const a: InboxEvent = { ...SAMPLE_EVENTS.external, payload: undefined };
    const b: InboxEvent = { ...SAMPLE_EVENTS.external, id: 'id-b', payload: null };
    expect(inboxBacklogDedupeKey(a)).toBe(inboxBacklogDedupeKey(b));
  });

  it('timer: kind / target / cause のいずれが違っても別の鍵', () => {
    const a = SAMPLE_EVENTS.timer;
    const byKind: InboxEvent = { ...a, id: 'id-b', kind: 'weekly_report' };
    const byTarget: InboxEvent = { ...a, id: 'id-c', target: '2026-09-09' };
    const byCause: InboxEvent = { ...a, id: 'id-d', cause: 'manual' };
    const key = inboxBacklogDedupeKey(a);
    expect(inboxBacklogDedupeKey(byKind)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byTarget)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byCause)).not.toBe(key);
  });

  it('timer: cause 省略は "schedule" と同じ鍵（省略時の既定と揃う）', () => {
    const withCause: InboxEvent = {
      type: 'timer',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      kind: 'daily_report',
      target: '2026-09-10',
      cause: 'schedule',
    };
    const withoutCause: InboxEvent = {
      type: 'timer',
      id: 'id-b',
      at: '2026-09-11T05:00:00.000Z',
      kind: 'daily_report',
      target: '2026-09-10',
    };
    expect(inboxBacklogDedupeKey(withCause)).toBe(inboxBacklogDedupeKey(withoutCause));
  });

  it('self_initiative: reason / cause のいずれが違っても別の鍵', () => {
    const a = SAMPLE_EVENTS.self_initiative;
    const byReason: InboxEvent = { ...a, id: 'id-b', reason: '別の理由' };
    const byCause: InboxEvent = { ...a, id: 'id-c', cause: 'manual' };
    const key = inboxBacklogDedupeKey(a);
    expect(inboxBacklogDedupeKey(byReason)).not.toBe(key);
    expect(inboxBacklogDedupeKey(byCause)).not.toBe(key);
  });

  it('distill: reason が違えば別の鍵', () => {
    const a = SAMPLE_EVENTS.distill;
    const b: InboxEvent = { ...a, id: 'id-b', reason: 'shutdown' };
    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  it('型が違えば、他の欄が同じでも別の鍵になる（type 自体が鍵に含まれる）', () => {
    // self_initiative と distill はどちらも reason 相当の1文字列を持つが、
    // human_message.type/manager_message.type を混ぜても畳まれないことを、
    // self_initiative と timer（どちらも cause を持つ）で確かめる。
    const timerLike: InboxEvent = {
      type: 'timer',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      kind: 'x',
      cause: 'schedule',
    };
    const selfLike: InboxEvent = {
      type: 'self_initiative',
      id: 'id-b',
      at: '2026-09-11T00:00:00.000Z',
      reason: 'x',
      cause: 'schedule',
    };
    expect(inboxBacklogDedupeKey(timerLike)).not.toBe(inboxBacklogDedupeKey(selfLike));
  });

  /**
   * ⚠️ 実行時の倒れ先（AGENTS.md「型で塞いだ分岐にも、実行時の倒れ先の歯を
   * 足す」#285 の作法）。型では防げない未知の `type` が実行時に来ても、
   * 黙って別の型として畳んだり本文を握り潰したりせず、必ず投げる
   * （この repo の同じ union に対する既存の倒れ先——`clone.ts` の
   * `#dispatch` の `default` ——と同じ形）。
   */
  it('未知の type は（型では防げない実行時の値として）例外を投げる', () => {
    const unknown = { type: 'not_a_real_type', id: 'x', at: '2026-09-11T00:00:00.000Z' };
    expect(() => inboxBacklogDedupeKey(unknown as unknown as InboxEvent)).toThrow();
  });

  /**
   * ⭐ 区切りが NUL であることが実際に効いていることを測る歯（レビューで
   * 半角スペースから NUL へ変えた変更そのものの裏取り）。
   *
   * `conversationId` と `text` の境界に半角スペースが挟まると、**区切りが
   * 半角スペースのままなら2つの別のフィールド分けが同じ文字列に潰れる**
   * ——`conversationId='conv'` / `text='1 x'` と
   * `conversationId='conv 1'` / `text='x'` は、どちらも
   * `'human_message' + SEP + conversationId + SEP + text` を素直に
   * 半角スペースで結ぶと同じ `'human_message conv 1 x'` になる。
   *
   * **区切りが NUL なら、本文に半角スペースが含まれても境界がずれない**
   * ——NUL は本文中の半角スペースとは別の文字なので、2つは別の鍵になる。
   * ⚠️ この歯は、区切りを半角スペースへ戻すと落ちる形になっている
   * （`DEDUPE_SEPARATOR` を `' '` に戻して自分で確かめた。報告に生出力を
   * 添える）。
   */
  it('⭐ 本文に半角スペースを含む2件は、境界がずれても別の鍵になる（NUL区切りの裏取り）', () => {
    const a: InboxEvent = {
      type: 'human_message',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      conversationId: 'conv',
      text: '1 x',
    };
    const b: InboxEvent = {
      type: 'human_message',
      id: 'id-b',
      at: '2026-09-11T00:00:00.000Z',
      conversationId: 'conv 1',
      text: 'x',
    };

    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });

  /**
   * ⭐ issue #841 が `external` の束ね鍵として {@link inboxBacklogDedupeKey} を
   * 再利用してよい根拠の裏取り。**`JSON.stringify` は生の NUL を1つも出力
   * しない**（制御文字としての NUL は `\u0000` という6文字へエスケープされる）
   * ので、鍵の第3フィールド（`JSON.stringify(payload ?? null)`）には NUL が
   * 絶対に現れない。⟹ 鍵の文字列に現れる**最後の NUL は、常に `source` と
   * `payload` の境界を指す**——`source` 自身に生の NUL を混ぜて境界をずらそう
   * としても、`payload` 側の json にはもう NUL が無いため境界はずれない。
   */
  it('⭐ external: JSON.stringify は payload に生の NUL を出力しない（第3フィールドは NUL を含まない）', () => {
    const NUL = '\u0000';
    const withNul = { text: `x${NUL}y` };
    const json = JSON.stringify(withNul);
    expect(json).not.toContain(NUL);
    // エスケープされた6文字表現としては現れる。
    expect(json).toContain('\\u0000');
  });

  /**
   * ⭐ 直上の裏取りが実際に効いていることを、束ね鍵そのもので測る。**`source`
   * に生の NUL を混ぜて、あたかも `source`/`payload` の境界をずらそうとしても、
   * 鍵は衝突しない。**
   */
  it('⭐ external: source に生の NUL を混ぜて境界をずらそうとしても、鍵は衝突しない（NUL区切りの裏取り）', () => {
    const NUL = '\u0000';
    const a: InboxEvent = {
      type: 'external',
      id: 'id-a',
      at: '2026-09-11T00:00:00.000Z',
      source: 'foo',
      payload: { x: 1 },
    };
    // `source` の中に「NUL + a の payload を JSON 化した文字列」を丸ごと埋め込み、
    // 自分の payload は `null` にする——素朴な文字列連結ならここで a と衝突しうる
    // 形を狙っている。
    const b: InboxEvent = {
      type: 'external',
      id: 'id-b',
      at: '2026-09-11T00:00:00.000Z',
      source: `foo${NUL}${JSON.stringify({ x: 1 })}`,
      payload: null,
    };

    expect(inboxBacklogDedupeKey(a)).not.toBe(inboxBacklogDedupeKey(b));
  });
});

describe('summarizeInboxBacklog', () => {
  it('0件のとき、total は0で oldestAt は持たない（値を作らない）', () => {
    const b = summarizeInboxBacklog([], NOW);
    expect(b.total).toBe(0);
    expect(b).not.toHaveProperty('oldestAt');
    expect(b.byType).toEqual([]);
    expect(b.bySource).toEqual([]);
    expect(b.ageBuckets).toEqual([]);
    expect(b.distinct).toBe(0);
  });

  it('最古の at を oldestAt にする', () => {
    const b = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T05:00:00.000Z'),
        row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-10T00:00:00.000Z'),
      ],
      NOW,
    );
    expect(b.oldestAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('byType: 0件の型は載らず、載っている行を足すと total に一致する', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.byType).toEqual([
      { type: 'human_message', count: 2 },
      { type: 'manager_message', count: 1 },
    ]);
    expect(b.byType.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
    // 0件の型（human_answer など）は配列に無い。
    expect(b.byType.some((e) => e.type === 'human_answer')).toBe(false);
  });

  it('bySource: external の source / manager_message の managerId を数え、他の型は数えない', () => {
    const rows = [
      row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.external, id: 'e2' }, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z'),
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.bySource).toEqual([
      { source: 'external:webhook-a', count: 2 },
      { source: 'manager:mgr-1', count: 1 },
    ]);
    // human_message は source を言えない型なので、bySource には現れず
    // unknownCount 側へ数えられる。5件以内なので溢れは0。
    expect(b.bySourceOverflowKinds).toBe(0);
    expect(b.bySourceOverflowCount).toBe(0);
    expect(b.bySourceUnknownCount).toBe(1);
  });

  /**
   * ⚠️ #818: `bySource` は上位5件で打ち切るため、それだけでは `total` に
   * 届かない。境界の両側（5種＝溢れ無し／6種＝1件溢れる）を撃つ。
   * `5` という上限そのものは実装の定数を直接書いた値であり、入力からは
   * 導いていない——変異（`5` → `6`）を当てると、5種のケースは変わらず
   * 緑のままだが、6種のケースは `bySource` の長さと `bySourceOverflowKinds`
   * の両方が変わって赤くなるはずである（下の mutation 節の M1 に対応）。
   */
  it('bySource: 送信元がちょうど5種のとき、溢れは0（境界の内側）', () => {
    const rows = ['e', 'd', 'c', 'b', 'a'].map((name, i) =>
      row({ ...SAMPLE_EVENTS.external, id: `e-${i}`, source: name }, '2026-09-11T00:00:00.000Z'),
    );
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.bySource).toHaveLength(5);
    expect(b.bySource.map((e) => e.source)).toEqual([
      'external:a',
      'external:b',
      'external:c',
      'external:d',
      'external:e',
    ]);
    expect(b.bySourceOverflowKinds).toBe(0);
    expect(b.bySourceOverflowCount).toBe(0);
    // 全件が bySource に入っているので、算術がそのまま total に一致する。
    expect(b.bySource.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
  });

  it('bySource: 上位5件まで、同数は名前順で安定する（6種目は打ち切られ、溢れとして数えられる）', () => {
    const rows = ['e', 'd', 'c', 'b', 'a', 'f'].map((name, i) =>
      row({ ...SAMPLE_EVENTS.external, id: `e-${i}`, source: name }, '2026-09-11T00:00:00.000Z'),
    );
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.bySource).toHaveLength(5);
    expect(b.bySource.map((e) => e.source)).toEqual([
      'external:a',
      'external:b',
      'external:c',
      'external:d',
      'external:e',
    ]);
    // 6種目（f、1件）が打ち切られて溢れ側へ数えられる。
    expect(b.bySourceOverflowKinds).toBe(1);
    expect(b.bySourceOverflowCount).toBe(1);
    expect(b.bySourceUnknownCount).toBe(0);
    // 不変条件: bySource の総和 + 溢れ「件数」 + unknown件数 === total。
    // （bySourceOverflowKinds は種類数であって件数ではないため、この和には
    // 含めない——次のテストで種類数と件数がずれるケースを別途確かめる）
    const bySourceSum = b.bySource.reduce((sum, e) => sum + e.count, 0);
    expect(bySourceSum + b.bySourceOverflowCount + b.bySourceUnknownCount).toBe(b.total);
  });

  /**
   * ⭐ 不変条件そのものを固定する歯。`bySource` の件数の総和 +
   * `bySourceOverflowCount`（溢れた**件数**。種類数の `bySourceOverflowKinds`
   * とは別軸）+ `bySourceUnknownCount` === `total`。
   *
   * 送信元7種（件数は不均一: a=3, b=3, c=2, d=2, e=1, f=1, g=1）+
   * source を言えない型（human_message）を2件混ぜ、上位5件・溢れ2種・
   * unknown2件の全部が同時に非0になる入力で撃つ。
   */
  it('⭐ 不変条件: bySource の総和 + bySourceOverflowCount + bySourceUnknownCount === total', () => {
    const externalRows = [
      ['a', 3],
      ['b', 3],
      ['c', 2],
      ['d', 2],
      ['e', 1],
      ['f', 1],
      ['g', 1],
    ].flatMap(([name, count]) =>
      Array.from({ length: count as number }, (_, i) =>
        row(
          { ...SAMPLE_EVENTS.external, id: `${name as string}-${i}`, source: name as string },
          '2026-09-11T00:00:00.000Z',
        ),
      ),
    );
    const unknownRows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'h2' }, '2026-09-11T00:00:00.000Z'),
    ];
    const rows = [...externalRows, ...unknownRows];
    const b = summarizeInboxBacklog(rows, NOW);

    expect(b.total).toBe(15); // 3+3+2+2+1+1+1 + 2
    expect(b.bySource).toEqual([
      { source: 'external:a', count: 3 },
      { source: 'external:b', count: 3 },
      { source: 'external:c', count: 2 },
      { source: 'external:d', count: 2 },
      { source: 'external:e', count: 1 },
    ]);
    expect(b.bySourceOverflowKinds).toBe(2); // f, g
    expect(b.bySourceOverflowCount).toBe(2); // f(1) + g(1)
    expect(b.bySourceUnknownCount).toBe(2); // human_message 2件

    const bySourceSum = b.bySource.reduce((sum, e) => sum + e.count, 0);
    expect(bySourceSum).toBe(11);
    expect(bySourceSum + b.bySourceOverflowCount + b.bySourceUnknownCount).toBe(b.total);
  });

  it('distinct: 同一本文（id/at 以外が同じ）を畳んだ件数', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T05:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e3', text: '別の発言' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.total).toBe(3);
    expect(b.distinct).toBe(2);
  });

  it('配達回数: 0 / 1 / 2以上の3分割と最大値', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 1),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, '2026-09-11T00:00:00.000Z', 2),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, '2026-09-11T00:00:00.000Z', 4),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.undelivered).toBe(1);
    expect(b.deliveredOnce).toBe(1);
    expect(b.redelivered).toBe(2);
    expect(b.maxDeliveries).toBe(4);
  });

  /**
   * #783 段0 追補: 「未配達の中に人間の依頼が混ざっているか」を種類別で
   * 直接言えるようにする（`undeliveredByType`）。境界は `deliveries` の
   * 0 / 1 / 2 の3値を直接撃つ（`=== 0` を `<= 1` に変異すると、
   * deliveries=1 の行まで未配達側へ数えられて赤くなるはず）。
   */
  it('undeliveredByType: deliveries===0 の行だけを種類別に数える（0/1/2の境界）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 1),
      row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.manager_message, id: 'e4' }, '2026-09-11T00:00:00.000Z', 2),
      row(SAMPLE_EVENTS.timer, '2026-09-11T00:00:00.000Z', 0),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    // human_message 1件（e1のみ。e2は1回配達済みなので数えない）、
    // manager_message 1件（e3のみ。e4は2回で redelivered なので数えない）、
    // timer 1件。INBOX_EVENT_TYPE_ORDER の並び
    // （human_message, human_answer, distill, timer, external,
    // self_initiative, manager_message）どおりに並ぶ。
    expect(b.undeliveredByType).toEqual([
      { type: 'human_message', count: 1 },
      { type: 'timer', count: 1 },
      { type: 'manager_message', count: 1 },
    ]);
    expect(b.undelivered).toBe(3);
    expect(b.undeliveredByType.reduce((sum, e) => sum + e.count, 0)).toBe(b.undelivered);
  });

  it('undeliveredByType: 未配達が0件のとき、空配列になる（0件の型は載せない）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 1),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 2),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.undeliveredByType).toEqual([]);
    expect(b.undelivered).toBe(0);
  });

  it('齢: 0件のバケツは省かれ、残りを足すと total に一致する', () => {
    const rows = [
      // 30分前 -> 1時間未満
      row(SAMPLE_EVENTS.human_message, new Date(NOW - 30 * 60 * 1000).toISOString()),
      // 30時間前 -> 24時間以上
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e2' },
        new Date(NOW - 30 * 60 * 60 * 1000).toISOString(),
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.ageBuckets).toEqual([
      { label: '1時間未満', count: 1 },
      { label: '24時間以上', count: 1 },
    ]);
    // 1〜6時間・6〜24時間は0件なので載らない。
    expect(b.ageBuckets.some((e) => e.label === '1〜6時間')).toBe(false);
    expect(b.ageBuckets.reduce((sum, e) => sum + e.count, 0)).toBe(b.total);
  });

  it('齢: 4つのバケツそれぞれに1件ずつ落ちる（各バケツの真ん中を通す）', () => {
    const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR_MS_FOR_TEST).toISOString();
    const rows = [
      row(SAMPLE_EVENTS.human_message, at(0.5)), // 1時間未満
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, at(3)), // 1〜6時間
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, at(12)), // 6〜24時間
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, at(48)), // 24時間以上
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(b.ageBuckets).toEqual([
      { label: '1時間未満', count: 1 },
      { label: '1〜6時間', count: 1 },
      { label: '6〜24時間', count: 1 },
      { label: '24時間以上', count: 1 },
    ]);
  });

  /**
   * ⚠ **上の歯は境界を1つも踏んでいない。** 0.5h / 3h / 12h / 48h は各バケツの
   * *真ん中*なので、境界が1時間ずれても（`hours < 6` を `hours < 7` に取り違え
   * ても）4件とも同じバケツに落ちたままで、歯は緑のままになる——実際に変異を
   * 当てて生存することを確かめた（#783 の引き継ぎ時の変異試験 M3）。
   *
   * だから**境界のちょうど上と、その 1ms 手前**を対で撃つ。境界が動けば、
   * どちらか（たいていは両方）が別のバケツへ落ちて赤くなる。
   *
   * ⭐ 実装の分岐は `hours < 1` / `hours < 6` / `hours < 24` なので、
   * **「ちょうど」は必ず上のバケツ側**（1時間ちょうどは「1時間未満」ではない）。
   */
  it('齢: 境界ちょうどは上のバケツ側、その 1ms 手前は下のバケツ側', () => {
    const atMs = (ms: number) => new Date(NOW - ms).toISOString();
    const bucketOf = (ms: number) => {
      const b = summarizeInboxBacklog([row(SAMPLE_EVENTS.human_message, atMs(ms))], NOW);
      expect(b.ageBuckets).toHaveLength(1);
      return b.ageBuckets[0]?.label;
    };

    expect(bucketOf(1 * HOUR_MS_FOR_TEST)).toBe('1〜6時間');
    expect(bucketOf(1 * HOUR_MS_FOR_TEST - 1)).toBe('1時間未満');

    expect(bucketOf(6 * HOUR_MS_FOR_TEST)).toBe('6〜24時間');
    expect(bucketOf(6 * HOUR_MS_FOR_TEST - 1)).toBe('1〜6時間');

    expect(bucketOf(24 * HOUR_MS_FOR_TEST)).toBe('24時間以上');
    expect(bucketOf(24 * HOUR_MS_FOR_TEST - 1)).toBe('6〜24時間');
  });
});

/**
 * 描画（`describeInboxBacklogBreakdown`）を「語」ではなく「行」で測るための
 * ヘルパ。`AGENTS.md`「静かに失敗する道具」——同じ語が別の行にも在ると
 * `toContain` は節ごと消しても緑のままになる——を避けるため、対象の行を
 * 改行で割って1本に特定してから、その行の中身を丸ごと突き合わせる。
 */
function lineStartingWith(text: string, prefix: string): string {
  const matches = text.split('\n').filter((line) => line.startsWith(prefix));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('describeInboxBacklogBreakdown', () => {
  it('必ず total を出す', () => {
    const b: InboxBacklogBreakdown = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z')],
      NOW,
    );
    expect(describeInboxBacklogBreakdown(b)).toContain('計 1 件');
  });

  it('0件でも呼べる（全部の軸が「無し」で埋まる）', () => {
    const b = summarizeInboxBacklog([], NOW);
    const text = describeInboxBacklogBreakdown(b);
    expect(text).toContain('計 0 件');
  });

  it('本文（text / payload の中身）を1文字も含まない', () => {
    const rows = [
      row(
        { ...SAMPLE_EVENTS.human_message, text: '絶対に外へ出てはいけない本文XYZ' },
        '2026-09-11T00:00:00.000Z',
      ),
      row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    const text = describeInboxBacklogBreakdown(b);
    expect(text).not.toContain('絶対に外へ出てはいけない本文XYZ');
    expect(text).not.toContain('bar'); // external.payload.foo の値
  });

  /**
   * ⭐ #818: 溢れ件数・unknown件数は**0のときも省かず載せる**——省くと
   * 「省いた＝0だった」という他の軸（byType/ageBuckets）と同じ見た目になり、
   * 「測っていない」との区別が読み手からできなくなる。行そのものを
   * `toBe` で固定し、`toContain` の弱さ（別の行に同じ数字が在っても
   * 通ってしまう）を避ける。
   */
  it('送信元の行: 溢れ・unknownが0でも数字として必ず出る（0件でも省略しない）', () => {
    const b = summarizeInboxBacklog([row(SAMPLE_EVENTS.external, '2026-09-11T00:00:00.000Z')], NOW);
    const line = lineStartingWith(describeInboxBacklogBreakdown(b), '送信元');
    expect(line).toBe(
      '送信元（上位5件。source/managerIdを持つ型のみ。溢れ 0 種 0 件 / source を言えない型 0 件）: external:webhook-a 1',
    );
  });

  it('送信元の行: 溢れ・unknownが実際に非0のとき、その数がそのまま出る', () => {
    const rows = [
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) =>
        row({ ...SAMPLE_EVENTS.external, id: `e-${i}`, source: name }, '2026-09-11T00:00:00.000Z'),
      ),
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    const line = lineStartingWith(describeInboxBacklogBreakdown(b), '送信元');
    expect(line).toBe(
      '送信元（上位5件。source/managerIdを持つ型のみ。溢れ 2 種 2 件 / source を言えない型 1 件）: ' +
        'external:a 1 / external:b 1 / external:c 1 / external:d 1 / external:e 1',
    );
  });

  /**
   * 未配達の内訳（種類別）の行——0件のときは他の0件軸と同じ「（無し）」で
   * よい（`undelivered` 自体が0なので「測っていない」との混同が起きない）。
   */
  it('未配達の内訳の行: 未配達が無ければ「（無し）」、在れば種類別に出る', () => {
    const zero = summarizeInboxBacklog(
      [row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 1)],
      NOW,
    );
    expect(lineStartingWith(describeInboxBacklogBreakdown(zero), '未配達の内訳')).toBe(
      '未配達の内訳（種類別）: （無し）',
    );

    const some = summarizeInboxBacklog(
      [
        row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
        row(SAMPLE_EVENTS.manager_message, '2026-09-11T00:00:00.000Z', 0),
      ],
      NOW,
    );
    expect(lineStartingWith(describeInboxBacklogBreakdown(some), '未配達の内訳')).toBe(
      '未配達の内訳（種類別）: human_message 1 / manager_message 1',
    );
  });

  /**
   * ⭐ #910: **軸の名前と断り書きが「刷られること」を測る歯。**
   *
   * この2行（`同一本文…` と `器の入れ替え回数…`）は #818 の時点から
   * `describeInboxBacklogBreakdown` の doc が但し書きを持っていたのに、
   * **出力には1文字も刷っていなかった。** クローンはこの出力しか読まないので、
   * doc の但し書きは届かず、2つの誤った結論が立ち、その筋で委譲が1本出た（#910）。
   *
   * **`toContain` で語を拾わない。** 語だけを見る形だと、断り書きを節ごと消しても
   * 数字の側が残って緑のままになる（`lineStartingWith` の doc）。行を1本に特定して
   * **丸ごと `toBe` で固定する** —— 断り書きの1文字が消えれば赤くなる。
   *
   * **`not.toContain('配達回数')` を対で置く。** 全文固定だけだと、この関数の
   * *他の行*（あるいは将来足される行）に古い名前が戻ってきても緑のままになる。
   * #910 が塞いだのは「この計器が `配達回数` と名乗ること」そのものなので、
   * 名前が戻らないことを出力全体に対して測る。
   */
  it('同一本文の行: 数字だけでなく、両方向にぶれることと doc の在り処が刷られる', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z'),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T05:00:00.000Z'),
      row(
        { ...SAMPLE_EVENTS.human_message, id: 'e3', text: '別の発言' },
        '2026-09-11T00:00:00.000Z',
      ),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(lineStartingWith(describeInboxBacklogBreakdown(b), '同一本文')).toBe(
      '同一本文（id/at を除いた中身）を畳むと 2 件 ⚠ 本文が同じでも別々に起きた出来事である。' +
        'この数は上下どちらへもぶれる（向きと理由は inboxBacklogDedupeKey の doc）',
    );
  });

  it('器の入れ替え回数の行: 軸名が「配達回数」ではなく、0回が未配達だと名乗る', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e2' }, '2026-09-11T00:00:00.000Z', 1),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e3' }, '2026-09-11T00:00:00.000Z', 2),
      row({ ...SAMPLE_EVENTS.human_message, id: 'e4' }, '2026-09-11T00:00:00.000Z', 4),
    ];
    const b = summarizeInboxBacklog(rows, NOW);
    expect(lineStartingWith(describeInboxBacklogBreakdown(b), '器の入れ替え回数')).toBe(
      '器の入れ替え回数: 0回（＝未配達）1 / 1回 1 / 2回以上 2（最大 4）',
    );
  });

  /**
   * **陰性対照と対になる歯である。** 上の2本（陽性）は「その行がその文言で在ること」を
   * 測るので、断り書きを消せば赤くなる。こちらは逆側 —— **古い名前が出力のどこにも
   * 戻っていないこと**を、同じ被験体（同じ行）に対して測る。片方だけだと、
   * 名前を戻しつつ新しい行を足す形が緑のまま通る。
   */
  it('出力のどこにも「配達回数」という軸名が現れない（#910 で塞いだ名前）', () => {
    const rows = [
      row(SAMPLE_EVENTS.human_message, '2026-09-11T00:00:00.000Z', 0),
      row({ ...SAMPLE_EVENTS.external, id: 'e2' }, '2026-09-11T00:00:00.000Z', 3),
    ];
    const text = describeInboxBacklogBreakdown(summarizeInboxBacklog(rows, NOW));

    expect(text).not.toContain('配達回数');
    // **「未配達」そのものは残っている**（`deliveries === 0` は実際に
    // 「一度も配っていない」ことを言えるので、この語は嘘ではない）。
    // 消したのは軸名としての「配達回数」だけであることを、同じ被験体で固定する。
    expect(text).toContain('0回（＝未配達）');
    expect(lineStartingWith(text, '未配達の内訳')).toBe('未配達の内訳（種類別）: human_message 1');
  });
});

describe('INBOX_BACKLOG_LOUD_THRESHOLD', () => {
  it('50 である（#562 の28件の倍を超えたら「詰まり」では説明が付かない、という線）', () => {
    expect(INBOX_BACKLOG_LOUD_THRESHOLD).toBe(50);
  });
});
