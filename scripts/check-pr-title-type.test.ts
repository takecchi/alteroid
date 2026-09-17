import { describe, expect, it } from 'vitest';

import {
  CONVENTION_TYPES,
  evaluatePrTitleType,
  formatVerdict,
  stripLeadingMarkers,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-title-type-core.mjs';

/**
 * `check-pr-title-type` の歯（Issue #1097）。
 *
 * 本物の `gh pr view` は叩かない —— 合成したタイトルで判定だけを確かめる
 * （`check-no-attribution-trailers.test.ts` と同じ理由）。
 *
 * **この歯は fixture として規約違反のタイトルの逐語を持つ。** それ自体が対象に
 * なってはいけない——この門は repo のファイルも git の履歴も一切走査しない
 * （`check-pr-title-type-core.mjs` の doc、#785 の族）ので、この歯の中身がこの門
 * 自身に引っかかることは無い。
 *
 * ⚠️ **ここで測っているのは判定だけで、「門が効くこと」ではない。** workflow が
 * 実際に起きて赤くなることは別に測る必要がある（PR #1097 の実装では、この PR
 * 自身のタイトルを一度型の無い形へ変えて `pr-title-type` が赤くなることを観測
 * した。記録は PR 本文）。
 */

/** Issue #1097 の実測（2026-09-16、`main` 直近200本）で型を持たなかった14本の件名。 */
const MAIN_TITLES_WITHOUT_TYPE = [
  '変異試験の判定を、落ちた歯の件数ではなく名前で決める（#993）',
  'question/permissionもcommitment_close済みなら答え直せと言わない（#871）',
  'archive を消す操作を CLI / Web UI へ出す（#776）',
  'クローン層の失敗ターンでも contextUsage を context_usage として残す（#982）',
  '委譲層の失敗ターンでも contextUsage を残す（#976 / #977）',
  '取り下げられた確認を会話のタイムラインに出す',
  'clone が承認待ちを理由付きで取り下げられるようにする',
  'railway/setup.sh: GH_TOKEN等をShared Variablesではなく正本(DB)へ置く',
  'railway/setup.sh: ワークスペースとブランチを尋ねる',
  '境界を決める5変数をDB管理から外し、正本を器の生の環境変数だけにする',
  'runner ごとの押し込み(push)結果を記録し、失敗したら諦めずに挑み直す',
  '環境変数をDB管理化しCLI/Web UIから操作可能にする。トークンプールの環境変数フォールバックを撤去',
  '[併設] SDK 更新 PR に CI未起動を条件付き・本文先頭で知らせる（#867）',
  'ask_human の質問・回答をチャットと承認画面に出す',
];

describe('stripLeadingMarkers', () => {
  it('先頭の [印] を剥がす', () => {
    expect(stripLeadingMarkers('[CI未起動] chore: SDK を上げる')).toEqual({
      stripped: 'chore: SDK を上げる',
      markers: ['[CI未起動]'],
    });
  });

  it('印が複数あっても全部剥がす', () => {
    expect(stripLeadingMarkers('[保留][CI未起動] fix: 何か')).toEqual({
      stripped: 'fix: 何か',
      markers: ['[保留]', '[CI未起動]'],
    });
  });

  it('印が無ければそのまま返す', () => {
    expect(stripLeadingMarkers('fix: 何か')).toEqual({ stripped: 'fix: 何か', markers: [] });
  });

  it('途中の [ ] は剥がさない（先頭だけを見る）', () => {
    expect(stripLeadingMarkers('fix: [not a marker] 何か')).toEqual({
      stripped: 'fix: [not a marker] 何か',
      markers: [],
    });
  });

  it('文字列でなければ空（例外にしない）', () => {
    expect(stripLeadingMarkers(null)).toEqual({ stripped: '', markers: [] });
    expect(stripLeadingMarkers(undefined)).toEqual({ stripped: '', markers: [] });
  });
});

describe('evaluatePrTitleType — 通す形', () => {
  for (const type of CONVENTION_TYPES) {
    it(`${type}: を通す（規約の型8つすべて）`, () => {
      expect(evaluatePrTitleType({ title: `${type}: 何かをする` }).verdict).toBe('ok');
    });
  }

  it('(scope) 付きを通す（実測: main 直近400本中18本が実在する）', () => {
    expect(evaluatePrTitleType({ title: 'fix(web): ボタンが押せない' }).verdict).toBe('ok');
  });

  it('先頭の [CI未起動] を通す（repo 自身の自動化が出す形。open-claude-sdk-pr.sh）', () => {
    const result = evaluatePrTitleType({
      title: '[CI未起動] chore: @anthropic-ai/claude-agent-sdk を 0.3.271 へ上げる',
    });
    expect(result.verdict).toBe('ok');
    expect(result.markers).toEqual(['[CI未起動]']);
  });

  it('印 + scope の組み合わせも通す', () => {
    expect(evaluatePrTitleType({ title: '[CI未起動] chore(deps): 上げる' }).verdict).toBe('ok');
  });
});

describe('evaluatePrTitleType — 落とす形', () => {
  it.each(MAIN_TITLES_WITHOUT_TYPE)('main に実在した型の無い件名を落とす: %s', (title: string) => {
    expect(evaluatePrTitleType({ title }).verdict).toBe('missing-type');
  });

  it('印だけで型が無い形は落とす（[併設] …。Issue #1097 の数え方と一致する）', () => {
    const result = evaluatePrTitleType({ title: '[併設] SDK 更新 PR に CI未起動を知らせる' });
    expect(result.verdict).toBe('missing-type');
    expect(result.markers).toEqual(['[併設]']);
    expect(result.stripped).toBe('SDK 更新 PR に CI未起動を知らせる');
  });

  it('feat!: は落とす（破壊的変更の ! は規約にも main の実測にも無い）', () => {
    expect(evaluatePrTitleType({ title: 'feat!: API を壊す' }).verdict).toBe('missing-type');
  });

  it('大文字始まりは落とす（規約は小文字。main に反例が無い）', () => {
    expect(evaluatePrTitleType({ title: 'Fix: 何か' }).verdict).toBe('missing-type');
  });

  it('規約に無い型は落とす', () => {
    expect(evaluatePrTitleType({ title: 'build: 何か' }).verdict).toBe('missing-type');
    expect(evaluatePrTitleType({ title: 'style: 何か' }).verdict).toBe('missing-type');
  });

  it('コロンの後ろに空白が無い形は落とす（<type>: <description> の形ではない）', () => {
    expect(evaluatePrTitleType({ title: 'fix:何か' }).verdict).toBe('missing-type');
  });

  it('説明が空の形は落とす', () => {
    expect(evaluatePrTitleType({ title: 'fix: ' }).verdict).toBe('missing-type');
    expect(evaluatePrTitleType({ title: 'fix:  　' }).verdict).toBe('missing-type');
  });

  it('型が語の途中に在るだけの形は落とす（先頭一致であること）', () => {
    expect(evaluatePrTitleType({ title: 'prefix: 何か' }).verdict).toBe('missing-type');
    expect(evaluatePrTitleType({ title: '何かを fix: する' }).verdict).toBe('missing-type');
  });

  it('空のタイトルは missing-type（unreadable ではない）', () => {
    expect(evaluatePrTitleType({ title: '' }).verdict).toBe('missing-type');
  });
});

describe('evaluatePrTitleType — 判定できない（3つ目の状態）', () => {
  it('title が null なら unreadable（fail-closed。「型が在った」に倒さない）', () => {
    expect(evaluatePrTitleType({ title: null }).verdict).toBe('unreadable');
  });

  it('title が undefined でも unreadable（例外にしない）', () => {
    expect(evaluatePrTitleType({ title: undefined }).verdict).toBe('unreadable');
  });
});

describe('formatVerdict', () => {
  it('ok はタイトルを添えて OK と名乗る', () => {
    const text = formatVerdict(1097, evaluatePrTitleType({ title: 'feat: 門を置く' }));
    expect(text).toContain('check-pr-title-type(#1097): OK');
    expect(text).toContain('feat: 門を置く');
  });

  it('missing-type は、squash が見るのが PR のタイトルであることまで言う', () => {
    const text = formatVerdict(1097, evaluatePrTitleType({ title: '門を置く' }));
    expect(text).toContain('NG');
    expect(text).toContain('門を置く');
    expect(text).toContain('squash');
    // 直し方が出力だけで分かること（型の一覧が出る）
    for (const type of CONVENTION_TYPES) expect(text).toContain(type);
  });

  it('missing-type で印を剥がしたなら、剥がした後の形も見せる', () => {
    const text = formatVerdict(1097, evaluatePrTitleType({ title: '[併設] 何かをする' }));
    expect(text).toContain('[併設]');
    expect(text).toContain('剥がした後');
  });

  it('unreadable は「読めなかった」と明言する（緑と紛らわしくしない）', () => {
    const text = formatVerdict(1097, evaluatePrTitleType({ title: null }));
    expect(text).toContain('判定できなかった');
    expect(text).toContain('fail-closed');
  });
});
