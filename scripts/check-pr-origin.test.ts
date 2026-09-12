import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない検査スクリプト）を読む
import {
  decideGateVerdict,
  ORIGIN_GATE_SINCE,
  parseOriginMarker,
  stripFencedCode,
} from './check-pr-origin-core.mjs';

import {
  formatOriginMarker,
  ORIGIN_GATE_SINCE as ORIGIN_GATE_SINCE_TS,
  ORIGIN_HUMAN,
} from '../packages/core/src/origin-marker.js';
import { CLONE_ACTOR_ID } from '../packages/core/src/usage.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `check-pr-origin-core.mjs` の判定表（doc の全7行）を1本ずつ確かめる。
 */
describe('parseOriginMarker: 判定表の7行', () => {
  it('刻印1つ、値が mgr- で始まる ⟹ manager（managerId も返す）', () => {
    const body = '本文。\n\n<!-- alteroid-origin: mgr-abc123 -->\n';
    expect(parseOriginMarker(body)).toEqual({
      verdict: 'manager',
      managerId: 'mgr-abc123',
      values: ['mgr-abc123'],
    });
  });

  it('刻印1つ、値が clone ⟹ clone', () => {
    const body = '<!-- alteroid-origin: clone -->';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  it('刻印1つ、値が human ⟹ human', () => {
    const body = '<!-- alteroid-origin: human -->';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'human', values: ['human'] });
  });

  it('刻印が0個 ⟹ missing', () => {
    expect(parseOriginMarker('ただの本文。刻印は無い。')).toEqual({ verdict: 'missing' });
  });

  it('刻印は在るが値が語彙のどれでもない ⟹ invalid', () => {
    const body = '<!-- alteroid-origin: bot -->';
    expect(parseOriginMarker(body)).toEqual({
      verdict: 'invalid',
      value: 'bot',
      values: ['bot'],
    });
  });

  it('刻印が2つ以上で値が食い違う ⟹ conflict', () => {
    const body = '<!-- alteroid-origin: mgr-aaa -->\n本文\n<!-- alteroid-origin: clone -->';
    expect(parseOriginMarker(body)).toEqual({
      verdict: 'conflict',
      values: ['mgr-aaa', 'clone'],
    });
  });

  it('刻印が2つ以上で値が同じ ⟹ その値として扱う（単発と同じ判定）', () => {
    const body = '<!-- alteroid-origin: clone -->\n本文\n<!-- alteroid-origin: clone -->';
    expect(parseOriginMarker(body)).toEqual({
      verdict: 'clone',
      values: ['clone', 'clone'],
    });
  });
});

describe('parseOriginMarker: body が null / undefined / 空文字', () => {
  it('null は missing', () => {
    expect(parseOriginMarker(null)).toEqual({ verdict: 'missing' });
  });

  it('undefined は missing', () => {
    expect(parseOriginMarker(undefined)).toEqual({ verdict: 'missing' });
  });

  it('空文字は missing', () => {
    expect(parseOriginMarker('')).toEqual({ verdict: 'missing' });
  });
});

/**
 * フェンス（```` ``` ```` / `~~~`）の中の刻印は数えない。
 *
 * 理由: 刻印の形を説明する PR 本文（このリポジトリ自身の PR がまさにそうなる）が、
 * 例示のためにコードブロックへ刻印を書くと、それだけで自分に対して `conflict` /
 * `invalid` を作ってしまう。
 */
describe('parseOriginMarker: フェンスの中の刻印を数えない', () => {
  it('フェンスの中の刻印1つだけなら missing（本文の説明用の例示が誤検知しない）', () => {
    const body = [
      '刻印の書き方はこう:',
      '',
      '```',
      '<!-- alteroid-origin: mgr-example -->',
      '```',
      '',
      '本文はここまで。',
    ].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
  });

  it('フェンスの外に本物、フェンスの中に別の値の例示があっても conflict にならない', () => {
    const body = [
      '<!-- alteroid-origin: clone -->',
      '',
      '刻印の書き方の例:',
      '```',
      '<!-- alteroid-origin: mgr-example -->',
      '```',
    ].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  it('~~~ フェンスの中も数えない', () => {
    const body = ['~~~', '<!-- alteroid-origin: human -->', '~~~'].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
  });

  it('4文字以上のフェンス（````）の中も数えない', () => {
    const body = ['````', '<!-- alteroid-origin: human -->', '````'].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
  });

  /**
   * PR #796 が固定した欠陥A（`packages/core/src/markdown-span.ts` を先に読んで
   * 同じ規則に合わせた）: 1行に開閉のバックティックが両方在る行
   * （`` `inline code` `` のような形）は、フェンスの開きではなくインライン
   * コードスパンである——CommonMark はバックティックフェンスの info string に
   * バックティックを許さないため。これをフェンスの開きとして誤認すると、
   * それ以降の本文（本物の刻印を含みうる）が丸ごと「フェンスの中」として
   * 無検査になる。
   */
  it('1行に開閉両方在るバックティックの行はフェンスの開きとして扱わない（PR #796 と同じ欠陥を作らない）', () => {
    const body = ['`inline code`という表記がある。', '<!-- alteroid-origin: clone -->'].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  it('stripFencedCode は素の文字列も直接確かめられる（上のテストの裏取り）', () => {
    const body = ['```', '<!-- alteroid-origin: mgr-example -->', '```', '残る行'].join('\n');
    const stripped = stripFencedCode(body);
    expect(stripped).not.toContain('alteroid-origin');
    expect(stripped).toContain('残る行');
  });
});

/**
 * **`toContain` は「どこかに在る」しか言わず「どこに在るか」を言わない、という
 * 罠への手当て（マネージャーからの指摘）。**
 *
 * `parseOriginMarker` の正規表現（`extractMarkerValues`）は、既に
 * `<!--\s*alteroid-origin:\s*(\S+?)\s*-->` という**完全な HTML コメントの形**
 * でしか刻印を拾わない——地の文に `alteroid-origin` という語だけが出てきても
 * 一致しない設計に**なっているはずだが**、それを歯として固定していなかった。
 * ここで固定する。**期待するのは `verdict` の値そのもの**（`toBe` 相当。
 * `toEqual` で結果オブジェクトごと固定する）であって、「落ちない」ではない。
 */
describe('parseOriginMarker: 語の出現だけでは満たされない（説明文・テンプレート現物）', () => {
  it('本文中に「alteroid-origin」という語だけが出てきても missing のまま（完全な HTML コメントの形が要る）', () => {
    const body = 'この PR は alteroid-origin という刻印の仕組みについて説明する。';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
  });

  it('刻印の名前だけを書いた不完全な HTML コメント（値が無い）は invalid にも manager 等にもならない（missing）', () => {
    const body = '<!-- alteroid-origin -->';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
  });

  /**
   * **テンプレートの現物を読み込んで通す歯。** 期待値は `human` の1本しか
   * 書かない——`.github/pull_request_template.md` の説明コメント（`<!-- ... -->`
   * の中に「継承されない」等の地の文がある）が万一 `alteroid-origin:` を含む
   * 形へ書き換わってしまっても、この歯はテンプレートと判定ロジックが別々に
   * 腐ったことをそのまま検知する（テンプレート側を直接読むので、テンプレートの
   * 中身を書き写した合成フィクスチャでは塞げない種類の腐りである）。
   */
  it('.github/pull_request_template.md の現物を通すと human になる', () => {
    const template = readFileSync(`${REPO_ROOT}/.github/pull_request_template.md`, 'utf8');
    expect(parseOriginMarker(template)).toEqual({ verdict: 'human', values: ['human'] });
  });
});

/**
 * **形のずれを見張る歯（#850）。**
 *
 * `packages/core/src/origin-marker.ts`（書き手 — TypeScript）と
 * `check-pr-origin-core.mjs`（読み手 — この .mjs）は、刻印の名前と値の語彙を
 * 別々に持っている（`.mjs` は依存を持てないため `CLONE_ACTOR_ID` を import
 * できず、文字列として複製している。core 側の doc に同じ説明がある）。
 *
 * **この歯が無いと、片方だけを直しても型チェックもテストも落ちない。**
 * `usage.ts` の `CLONE_ACTOR_ID` を `'clone'` から別の値へ改名しても、
 * `check-pr-origin-core.mjs` 側の文字列リテラルはそのまま残り、CI の
 * `pr-origin` ジョブは古い値のままクローンの PR を `invalid` として赤く
 * し続ける——`scripts/mutate-core-strip-ansi.test.ts` の「3箇所に同じ形が
 * 在ることを見張る歯」と同じ形で、**書き手と読み手を実際に呼んで突き合わせる**
 * ことでこれを塞ぐ。測っているのは実装の文字列ではなく、`formatOriginMarker`
 * が作った本物の刻印を `parseOriginMarker` に通したときの verdict である。
 */
describe('書き手（origin-marker.ts）と読み手（check-pr-origin-core.mjs）の形の突き合わせ（#850）', () => {
  it('formatOriginMarker(managerId) は manager と判定される', () => {
    const marker = formatOriginMarker('mgr-xxxxxxxx');
    expect(parseOriginMarker(marker)).toEqual({
      verdict: 'manager',
      managerId: 'mgr-xxxxxxxx',
      values: ['mgr-xxxxxxxx'],
    });
  });

  it('formatOriginMarker(CLONE_ACTOR_ID) は clone と判定される', () => {
    const marker = formatOriginMarker(CLONE_ACTOR_ID);
    expect(parseOriginMarker(marker)).toEqual({ verdict: 'clone', values: [CLONE_ACTOR_ID] });
  });

  it('formatOriginMarker(ORIGIN_HUMAN) は human と判定される', () => {
    const marker = formatOriginMarker(ORIGIN_HUMAN);
    expect(parseOriginMarker(marker)).toEqual({ verdict: 'human', values: [ORIGIN_HUMAN] });
  });
});

/**
 * `decideGateVerdict`: `legacy`（門より前に作られた PR を赤くしない扱い）。
 *
 * **`parseOriginMarker` は本文だけを見る純関数のままである**——この describe の
 * どのテストも `parseOriginMarker` を直接は呼ばない。時刻の判定は別の関数に
 * 分けてある、という設計そのものをこの import の使い分けで示している。
 */
describe('decideGateVerdict: legacy（門より前に作られた PR）', () => {
  const BEFORE_GATE = '2026-09-01T00:00:00Z';
  const AFTER_GATE = '2026-09-12T00:00:00Z';

  it('刻印が missing、かつ ORIGIN_GATE_SINCE より前に作られた ⟹ legacy', () => {
    expect(decideGateVerdict({ body: null, createdAt: BEFORE_GATE })).toEqual({
      verdict: 'legacy',
    });
  });

  it('刻印が missing、かつ ORIGIN_GATE_SINCE 以降に作られた ⟹ legacy にならず missing のまま', () => {
    expect(decideGateVerdict({ body: null, createdAt: AFTER_GATE })).toEqual({
      verdict: 'missing',
    });
  });

  it('invalid は createdAt がどれだけ古くても legacy に逃げない', () => {
    const body = '<!-- alteroid-origin: bot -->';
    expect(decideGateVerdict({ body, createdAt: BEFORE_GATE })).toEqual({
      verdict: 'invalid',
      value: 'bot',
      values: ['bot'],
    });
  });

  it('conflict も createdAt がどれだけ古くても legacy に逃げない', () => {
    const body = '<!-- alteroid-origin: clone -->\n<!-- alteroid-origin: human -->';
    expect(decideGateVerdict({ body, createdAt: BEFORE_GATE })).toEqual({
      verdict: 'conflict',
      values: ['clone', 'human'],
    });
  });

  it('manager / clone / human はそのまま通る（createdAt に関わらず）', () => {
    expect(
      decideGateVerdict({ body: '<!-- alteroid-origin: clone -->', createdAt: BEFORE_GATE }),
    ).toEqual({
      verdict: 'clone',
      values: ['clone'],
    });
  });

  it('createdAt が undefined ⟹ fail closed（legacy へ逃がさず missing のまま）', () => {
    expect(decideGateVerdict({ body: null, createdAt: undefined })).toEqual({
      verdict: 'missing',
    });
  });

  it('createdAt が壊れた文字列 ⟹ fail closed（legacy へ逃がさず missing のまま）', () => {
    expect(decideGateVerdict({ body: null, createdAt: 'not-a-date' })).toEqual({
      verdict: 'missing',
    });
  });

  it('ORIGIN_GATE_SINCE ちょうどの境界は「以降」側（legacy にならない）', () => {
    expect(decideGateVerdict({ body: null, createdAt: ORIGIN_GATE_SINCE })).toEqual({
      verdict: 'missing',
    });
  });
});

/**
 * 🔴 **刻印の境界時刻は2実装で同じ値である（Issue #857）。**
 *
 * この値は2箇所に在る——`scripts/check-pr-origin-core.mjs`（CI の門。
 * **依存を1本も持てない**ので TypeScript を読めない）と
 * `packages/core/src/origin-marker.ts`（`digest.ts` の
 * `classifyUnobservedOutcome` が読む側。`packages/core` の中から `scripts/` の
 * 素の `.mjs` を import すると、パッケージ境界と `dist/` の build を跨ぐ）。
 * **どちらからも相手を import できないので、写しを置くしかない。**
 *
 * ⟹ **「2箇所に同じ値が在って誰も見張っていない」状態を作らないための歯が
 * これである。** この歯が赤くなったら、片方だけを直している。
 *
 * 形は `scripts/mutate-core-strip-ansi.test.ts` と同じ——`@ts-expect-error` 付きで
 * 素の `.mjs` を読み、2実装へ同じものを突き合わせる。
 */
describe('刻印の境界時刻は2実装で同じ値である（#857）', () => {
  it('.mjs（CI の門）と origin-marker.ts（digest が読む側）が同じ文字列を持つ', () => {
    expect(ORIGIN_GATE_SINCE_TS).toBe(ORIGIN_GATE_SINCE);
  });

  /**
   * **同じ「文字列」であるだけでなく、同じ「瞬間」として読めること。**
   * 片方が `Z` 無し・片方がオフセット付き、のような書き換えを通さない
   * （文字列の一致だけだと「読める時刻であること」を1文字も測っていない——
   * `digest.ts` の側は `Date.parse` の結果で `markable` / `pre-marker` を
   * 分けるので、読めない値になった瞬間に全件が `unknown` へ倒れる）。
   */
  it('両方が Date.parse で読める同じ瞬間である', () => {
    expect(Number.isNaN(Date.parse(ORIGIN_GATE_SINCE_TS))).toBe(false);
    expect(Date.parse(ORIGIN_GATE_SINCE_TS)).toBe(Date.parse(ORIGIN_GATE_SINCE));
  });
});
