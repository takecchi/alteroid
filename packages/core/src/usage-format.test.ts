import { describe, expect, it } from 'vitest';

import {
  describeAccountUsage,
  describeUnrecordedManagers,
  findUnrecordedManagers,
  type UnrecordedManagerCandidate,
} from './usage-format.js';
import type { AccountUsageState } from './usage-snapshot.js';

/**
 * 「台帳が取りこぼした委譲」（Issue #98）の突き合わせと整形。
 *
 * **判定は「台帳に1行も無いか」の1つだけ。** `status` では絞らない——途中まで
 * 記録が在る委譲は取りこぼしではない、という Issue の制約をここで固定する。
 */

function manager(over: Partial<UnrecordedManagerCandidate> & { managerId: string }) {
  return {
    status: 'running' as const,
    startedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

describe('findUnrecordedManagers', () => {
  it('台帳に行が在る managerId を除く', () => {
    const managers = [manager({ managerId: 'mgr-a' }), manager({ managerId: 'mgr-b' })];
    const result = findUnrecordedManagers(managers, new Set(['mgr-a']), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-b']);
  });

  /**
   * **`status` は絞り込みには使わない。** `running` / `done` / `lost` のどれでも、
   * 台帳に行が無ければ同じく取りこぼしとして数える——途中まで記録が在る委譲だけが
   * 「取りこぼしではない」側であって、それは `recordedManagerIds` に載っている
   * ことで表現される（`status` では表せない・表さない）。
   */
  it('status では絞らない（running / done / lost のどれでも、行が無ければ数える）', () => {
    const managers = [
      manager({ managerId: 'mgr-running', status: 'running' }),
      manager({ managerId: 'mgr-done', status: 'done' }),
      manager({ managerId: 'mgr-lost', status: 'lost' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId).sort()).toEqual(['mgr-done', 'mgr-lost', 'mgr-running']);
  });

  /**
   * **`since` より前に立った委譲は数えない。** あれは「記録が無い」ではなく
   * 「台帳が無かった」で、その但し書きは `beforeLedger` が持つ（Issue #98）。
   */
  it('since より前に createdAt を持つ委譲は数えない', () => {
    const managers = [
      manager({ managerId: 'mgr-before-ledger', startedAt: '2026-07-01T00:00:00.000Z' }),
      manager({ managerId: 'mgr-after-ledger', startedAt: '2026-08-15T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-after-ledger']);
  });

  /**
   * `since` ちょうどの委譲は「台帳が始まった後」として数える（`>=`）。
   */
  it('startedAt が since と同じ瞬間なら数える（境界は含む）', () => {
    const managers = [
      manager({ managerId: 'mgr-on-boundary', startedAt: '2026-08-01T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-on-boundary']);
  });

  /**
   * `since` が `null`（台帳がまだ1件も記録していない）なら、比べる相手が無いので
   * 誰も除外しない——渡された委譲全員がそのまま対象になる。
   */
  it('since が null なら誰も除外しない', () => {
    const managers = [
      manager({ managerId: 'mgr-a', startedAt: '2020-01-01T00:00:00.000Z' }),
      manager({ managerId: 'mgr-b', startedAt: '2026-08-20T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), null);

    expect(result.map((m) => m.managerId).sort()).toEqual(['mgr-a', 'mgr-b']);
  });

  /**
   * ⚠️ この歯が測っているのは「関数に全期間の集合を渡せば正しく答える」ことまでで
   * ある。呼び出し側（`app.ts` / `tools.ts`）が実際に `UsageStore.
   * recordedManagerIds()`（引数を持たない・全期間）を渡しているかどうかは、
   * この歯では測れない——そちらは `apps/daemon/src/app.test.ts` の
   * 「期間で絞っても取りこぼしの数が変わらない」歯が持つ。
   *
   * ここで確かめるのは、**関数自身が `recordedManagerIds` を絞り込みの材料として
   * 受け取っていない**（引数はそのまま素通しで使う）ことだけである——`since` 以外の
   * 期間の概念をこの関数は一切持たない。
   */
  it('recordedManagerIds に載っていれば、startedAt が最近でも除外する', () => {
    const managers = [manager({ managerId: 'mgr-a', startedAt: '2026-08-25T00:00:00.000Z' })];
    // 「照会範囲の外で記録された」ことを模す——この managerId は全期間の集合には
    // 載っているが、いま照会している期間の rows には出てこないかもしれない。
    // それでもここでは除外されるべきである（別の期間の record で載った集合を
    // そのまま渡している、という契約）。
    const result = findUnrecordedManagers(managers, new Set(['mgr-a']), '2026-08-01T00:00:00.000Z');

    expect(result).toEqual([]);
  });

  it('startedAt の昇順で返す', () => {
    const managers = [
      manager({ managerId: 'mgr-later', startedAt: '2026-08-20T00:00:00.000Z' }),
      manager({ managerId: 'mgr-earlier', startedAt: '2026-08-10T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), null);

    expect(result.map((m) => m.managerId)).toEqual(['mgr-earlier', 'mgr-later']);
  });
});

describe('describeUnrecordedManagers', () => {
  /**
   * **0件のときも黙らない。** 空配列は「取りこぼしが無い」であって「調べていない」
   * ではない（AGENTS.md の地雷表）——そう読める形で、0件でも必ず1行返す。
   */
  it('0件のときは「0件」と明示する（黙らない）', () => {
    const lines = describeUnrecordedManagers([]);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('0件');
  });

  it('1件以上のときは managerId と status と起こした時刻を出す', () => {
    const lines = describeUnrecordedManagers([
      { managerId: 'mgr-x', status: 'running', startedAt: '2026-08-25T13:20:00.000Z' },
    ]);
    const text = lines.join('\n');

    expect(text).toContain('mgr-x');
    expect(text).toContain('running');
    expect(text).toContain('2026-08-25T13:20:00.000Z');
    expect(text).toContain('1件');
  });
});

/**
 * `describeAccountUsage` の `apiKeySource` 行（#681 (2)）。
 *
 * この関数の文言は4つの口（クローンの `usage_read` / CLI の `alteroid usage`
 * と `/usage` / Web の `/usage` 画面）が単独で共有するので、ここに1本通せば
 * 全面に効く。**逆に、ここに出さなければクローンは `apiKeySource` を一切
 * 読めない**——それがこの改修の目的そのものである。
 */
describe('describeAccountUsage の apiKeySource 行（#681 (2)）', () => {
  function okState(over: Partial<Extract<AccountUsageState, { state: 'ok' }>['usage']>) {
    return {
      state: 'ok' as const,
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        limitsAvailable: true,
        windows: [],
        ...over,
      },
    };
  }

  it('apiKeySource が取れているとき、値をそのまま出す', () => {
    const text = describeAccountUsage(okState({ apiKeySource: 'none' })).join('\n');
    expect(text).toContain('none');
  });

  /**
   * ⚠️ `'none'` を「ログインしていない」と読ませないこと（`tokenSource` の
   * doc と同型の注意）。`'none'` は「API キーを使っていない」（claude.ai の
   * OAuth ログイン等）という意味で、鍵が無いことではない。
   */
  it('apiKeySource: none を「API キーを使っていない」という意味で出す', () => {
    const text = describeAccountUsage(okState({ apiKeySource: 'none' })).join('\n');
    expect(text).toContain('API キーを使っていない');
  });

  it('判定には使っていない観測であることが文言から読める', () => {
    const text = describeAccountUsage(okState({ apiKeySource: 'none' })).join('\n');
    expect(text).toContain('判定には使っていない');
  });

  it('apiKeySource が取れなかったとき、埋めずに「（取れなかった）」と言う', () => {
    const text = describeAccountUsage(okState({})).join('\n');
    expect(text).toContain('（取れなかった）');
    // 架空の値（'none' 等）で埋めていないことも確かめる。
    expect(text).not.toContain('apiKeySource. none');
  });
});

/**
 * `describeAccountUsage` の `unavailable` 枝の `apiKeySource` 行（#681 の続き）。
 *
 * ⚠️ 上の4本は全部 `okState(...)`（`state: 'ok'` 固定）を通り、`unavailable` の
 * 状態は1つも作っていなかった——これが今回の欠陥を見逃していた理由そのもの。
 * ここでは `unavailable` の状態だけを作るヘルパーを別に用意する（`okState` は
 * 触らない）。
 */
describe('describeAccountUsage の unavailable 枝の apiKeySource 行', () => {
  function unavailableState(
    apiKeySource: Extract<AccountUsageState, { state: 'unavailable' }>['apiKeySource'],
  ): AccountUsageState {
    return {
      state: 'unavailable',
      at: '2026-08-14T10:00:00.000Z',
      reason: '枠が効かない理由を言い分けられない（テスト用フィクスチャ）',
      cause: 'undetermined',
      apiKeySource,
    };
  }

  it('apiKeySource: none のとき、none と「API キーを使っていない」の注記が出る', () => {
    const text = describeAccountUsage(unavailableState('none')).join('\n');
    expect(text).toContain('none');
    expect(text).toContain('API キーを使っていない');
  });

  /**
   * ⭐ この依頼の芯を測る歯。
   *
   * `apiKeySource` が無い（＝ SDK がこの欄を返さなかった）ときは「取れなかった」が
   * 出て、かつ出力に `none` が1文字も含まれないことを固定する。ここが無いと、
   * 変異試験(a)「取れなかったを none に畳む」が生き残る——`none` と「取れなかった」
   * は意味が正反対（前者は積極的な事実、後者は欠落）なので、混同は許されない。
   */
  it('apiKeySource: undefined のとき「取れなかった」が出て、none は一切出ない', () => {
    const text = describeAccountUsage(unavailableState(undefined)).join('\n');
    expect(text).toContain('（取れなかった）');
    expect(text).not.toContain('none');
  });

  it('apiKeySource: unrecognized のとき、unrecognized と出る（生の文字列は出ない）', () => {
    const text = describeAccountUsage(unavailableState('unrecognized')).join('\n');
    expect(text).toContain('unrecognized');
  });

  it('既存の「枠が返ってこない」の行は消えない', () => {
    const text = describeAccountUsage(unavailableState('none')).join('\n');
    expect(text).toContain('枠が返ってこない');
    expect(text).toContain('枠が効かない理由を言い分けられない（テスト用フィクスチャ）');
  });
});

/**
 * `describeAccountUsage` の `tokenSourcePresence` 行（#706 の本題）。
 *
 * ⭐ この依頼の芯を測る歯。**4つの事実（取れなかった／値が在る／値が無い（空）／
 * この版は送らない）が、互いに別の表示になること**を固定する。既存の
 * `apiKeySource` の歯（`（取れなかった）` / `unrecognized` の書き分け）と
 * 同じ役割を、こちらの4値でも果たす。
 */
describe('describeAccountUsage の tokenSourcePresence 行（#706）', () => {
  function okState(
    tokenSourcePresence: Extract<
      AccountUsageState,
      { state: 'ok' }
    >['usage']['tokenSourcePresence'],
  ): AccountUsageState {
    return {
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        limitsAvailable: true,
        windows: [],
        tokenSourcePresence,
      },
    };
  }

  it('present のとき、値が届いていると言い、内容は出さない', () => {
    const text = describeAccountUsage(okState('present')).join('\n');
    expect(text).toContain('値が届いている');
  });

  it('empty のとき、欄はあるが空だと言う（not_returned とは違う文言）', () => {
    const text = describeAccountUsage(okState('empty')).join('\n');
    expect(text).toContain('欄はあるが空');
  });

  it('not_returned のとき、取得できずと言う（積極的な事実。version skew ではない）', () => {
    const text = describeAccountUsage(okState('not_returned')).join('\n');
    expect(text).toContain('取得できず');
  });

  /**
   * **4つ目の状態: この版は送らない。** `tokenSourcePresence` が `undefined`
   * （＝旧い daemon が返した応答にこの欄そのものが無い）のときは、
   * 「取得できず」（試して駄目だった）とは別の文言にする——読み違えると
   * 「対応している daemon へ繋ぎ直せば直る」と「鍵が届くのを待てばよい」を
   * 取り違える。
   */
  it('欄が無い（version skew）のとき、「取得できず」とは別の文言（この版は出さない）', () => {
    const text = describeAccountUsage(okState(undefined)).join('\n');
    expect(text).toContain('この版はこの情報を出さない');
    expect(text).not.toContain('取得できず');
  });

  /**
   * 4状態が互いに別の文言であることを、まとめて固定する。**どの2つも同じ
   * 表示へ倒れないこと**が受け入れ基準そのもの。
   */
  it('4つの状態はどの2つを取っても異なる行になる', () => {
    const lines = (['present', 'empty', 'not_returned', undefined] as const).map((presence) =>
      describeAccountUsage(okState(presence)).join('\n'),
    );

    expect(new Set(lines).size).toBe(lines.length);
  });

  it('内容（生の tokenSource）はどの状態でも出力に一切現れない', () => {
    // 意味の無い短い文字列（前例: #704 の 'zz'）を使う。生値は AccountUsageState
    // の型にもう存在しないので、これは「型で守られていることの再確認」である。
    const marker = 'zz';
    for (const presence of ['present', 'empty', 'not_returned'] as const) {
      const text = describeAccountUsage(okState(presence)).join('\n');
      expect(text).not.toContain(marker);
    }
  });
});
