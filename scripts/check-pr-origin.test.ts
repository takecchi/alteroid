import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない検査スクリプト）を読む
import {
  decideGateVerdict,
  ORIGIN_GATE_SINCE,
  parseOriginMarker,
  stripFencedCode,
  stripInlineCode,
} from './check-pr-origin-core.mjs';

import {
  formatOriginMarker,
  ORIGIN_AUTOMATION,
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

  /**
   * **`automation` 単体では `parseOriginMarker`（本文だけを見る純関数）は
   * `automation` を返す。** 作者種別による担保（`authorType !== 'Bot'` なら
   * `unverified` に倒す）は `decideGateVerdict` 側の仕事であり、
   * `parseOriginMarker` はそれを一切知らない——上の doc「`parseOriginMarker`
   * は本文だけを見る純関数のままにする」のとおり。担保のテストは下の
   * `describe('decideGateVerdict: automation の担保（authorType）')` に置く。
   */
  it('刻印1つ、値が automation ⟹ automation（Issue #893 / #930）', () => {
    const body = '<!-- alteroid-origin: automation -->';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'automation', values: ['automation'] });
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
 * **インラインのコードスパン（バックティック1個で囲んだ部分）の中の刻印を数えない（Issue #857）。**
 *
 * `stripFencedCode` が落とすのはフェンス付きコードブロックだけで、PR #796 が
 * 固定した欠陥Aの直し（同じ行に開閉のバックティックが両方在ればフェンスの開き
 * として扱わずプローズとして残す）は、そのプローズに残った行の**中身**まで
 * 検査していなかった。⟹ 刻印の書き方をインラインのコードスパンで説明する
 * 本文が、その例をそのまま本物として拾われていた。
 */
describe('parseOriginMarker: インラインのコードスパンの中の刻印を数えない（Issue #857）', () => {
  /**
   * **(陽性) Issue #857 の実物の形。** 本文中の唯一の刻印はインラインスパンの
   * 中の例（値は全角三点リーダを含む5文字で、実在しない managerId）で、
   * 直す前はこれを `manager`（`managerId: 'mgr-…'`）と誤判定していた。
   * 正しくは、本文に本物の刻印は無いので `missing` である。
   */
  it('刻印がインラインスパンの中の例だけなら missing（Issue #857 の実物）', () => {
    const body =
      '**PR #854（Issue #850）で、PR / Issue の本文に `<!-- alteroid-origin: mgr-… -->` の刻印が入るようになった。**';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
  });

  /**
   * **(陰性対照) プローズに在る本物の刻印は、今までどおり拾われる。**
   * これが無いと「インラインスパンを含む行を丸ごと無視する」ような過剰な
   * 直し方（＝刻印の抽出そのものが壊れて何も拾わなくなる退化）でも、
   * 上の陽性テストは緑のままになってしまう。
   */
  it('インラインスパンの説明と並んで本物の刻印がプローズに在れば拾われる', () => {
    const body = [
      '**PR #854（Issue #850）で、PR / Issue の本文に `<!-- alteroid-origin: mgr-… -->` の刻印が入るようになった。**',
      '',
      '<!-- alteroid-origin: clone -->',
    ].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  /**
   * **(陰性対照) フェンスの中の例は、今までどおり除かれる**（PR #854 / #925 の形）。
   * インラインスパンの直しがフェンスの判定へ手を伸ばしていないことの確認。
   */
  it('フェンス（```` ``` ````）で囲んだ例は今までどおり除かれる', () => {
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

  /**
   * **(陰性対照) PR #796 の欠陥A —— 同じ行に開閉のバックティックが両方在る行の
   * 後ろに続くプローズの刻印が、無検査にならないこと。** インラインスパンの
   * 直しは「その行自身の中身」だけを除く形なので、後続の行には影響しない
   * ——欠陥Aの直しが壊れて後続の行ごとフェンスとして無視される、という
   * 退化が起きていないことをここで固定する。
   */
  it('1行に開閉両方在るバックティックの行の後ろの、別行の本物の刻印は拾われる（PR #796 の欠陥Aが戻っていない）', () => {
    const body = ['`inline code`という表記がある。', '<!-- alteroid-origin: clone -->'].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  /**
   * **Issue #927 の形。** 本物の `clone` の刻印がプローズに在り、かつ別の行の
   * インラインスパンの中にも `clone` の例が在る。直す前は `values` が
   * `['clone', 'clone']`（値は一致するので verdict はどちらも `clone` のまま
   * ——だから verdict だけを見ていると壊れていることに気づけない）、直した
   * 後は `['clone']` になる。**もし例の値が本物と違っていたら、直す前は偽の
   * `conflict` になっていたはずである** ——この歯はその危険を検出する。
   */
  it('本物の clone とインラインスパンの中の clone の例が両方在っても、values は本物の1件だけになる（Issue #927）', () => {
    const body = [
      '<!-- alteroid-origin: clone -->',
      '',
      '刻印の書き方の例: `<!-- alteroid-origin: clone -->` のように書く。',
    ].join('\n');
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  it('stripInlineCode は素の文字列も直接確かめられる（上のテストの裏取り）', () => {
    const stripped = stripInlineCode('例: `<!-- alteroid-origin: mgr-example -->` のように書く。');
    expect(stripped).not.toContain('alteroid-origin');
    expect(stripped).toContain('例:');
    expect(stripped).toContain('のように書く。');
  });

  it('stripInlineCode は行を跨がない（離れた行の孤立したバックティック2個が、間の本物の刻印を巻き込まない）', () => {
    const body = [
      'この行には開きだけの孤立したバックティックが `在る。',
      '<!-- alteroid-origin: clone -->',
      'この行にも孤立したバックティックが在る`。',
    ].join('\n');
    // 行を跨いで対応させる実装だと、1行目の ` と3行目の ` が対応してしまい、
    // 挟まれた本物の刻印ごと1つの巨大なコードスパンとして消えてしまう。
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  /**
   * **除いた span を空文字ではなく空白1個に置き換える設計の回帰確認。**
   * `<!-- alteroid-orig` の直後にインラインスパン（中身は `X` で、刻印とは
   * 無関係）が在り、その直後に `in: clone -->` が続く。**もし空文字で
   * 除くと、スパンの前後（`alteroid-orig` と `in:`）が直接連結して
   * `alteroid-origin:` という文字列を作ってしまい、実際には本文のどこにも
   * 書かれていなかった刻印が捏造される。** 空白1個で除けば `orig in:` の
   * ように途中に空白が残るので、`alteroid-origin:` という連続した文字列には
   * ならず、`missing` のままになる。
   */
  it('除いたインラインスパンの前後が連結して偽の刻印を作らない（空文字ではなく空白1個で除く設計の回帰）', () => {
    const body = '<!-- alteroid-orig`X`in: clone -->';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'missing' });
    expect(stripInlineCode(body)).toBe('<!-- alteroid-orig in: clone -->');
  });

  /**
   * **CommonMark のコードスパンは、開きと「同じ長さちょうど」の連なりでしか
   * 閉じない、という規則の回帰確認。** 長さの違う連なり同士が対応してしまうと
   * （たとえば `` ` `` と `` ``` `` が対応する、というような緩い実装だと）、
   * 開きと閉じの間に挟まった本物の刻印まで巻き込んで1つの巨大なスパンとして
   * 消してしまう。ここでは長さ1の孤立したバックティックの後ろに本物の刻印を
   * 置き、さらにその後ろに長さ3の孤立したバックティックの連なりを置く——
   * どちらも対応する閉じが無いので、CommonMark の規則どおりならどちらも
   * ただの文字として残り、刻印はそのまま拾われる。
   */
  it('長さの違うバックティックの連なりは対応しない（誤って閉じにならず、挟まれた刻印を巻き込まない）', () => {
    const body = 'before ` <!-- alteroid-origin: clone --> ``` after';
    expect(parseOriginMarker(body)).toEqual({ verdict: 'clone', values: ['clone'] });
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

  it('formatOriginMarker(ORIGIN_AUTOMATION) は automation と判定される（Issue #893）', () => {
    const marker = formatOriginMarker(ORIGIN_AUTOMATION);
    expect(parseOriginMarker(marker)).toEqual({
      verdict: 'automation',
      values: [ORIGIN_AUTOMATION],
    });
  });
});

/**
 * **写しの突き合わせ（Issue #893 / #930）。**
 *
 * `.github/scripts/open-claude-sdk-pr.sh` は TypeScript の
 * `ORIGIN_AUTOMATION` を import できない（シェルスクリプトのため）ので、
 * 値 `automation` を直書きした「写し」を持つ（同スクリプトの doc「なぜ値を
 * 直書きするか」）。**この歯が無いと、`origin-marker.ts` 側だけを直しても
 * シェル側の写しはそのまま残り、CI に付かない自動化の PR が生まれる**
 * ——`scripts/check-pr-origin.test.ts` の「書き手と読み手の形の突き合わせ」
 * や「刻印の境界時刻は2実装で同じ値である（#857）」と同じ形（測っているのは
 * 実装の文字列ではなく、2箇所が同じ値を指していること）。
 */
describe('写しの突き合わせ: open-claude-sdk-pr.sh の刻印は origin-marker.ts と同じ値である（#893 / #930）', () => {
  it('.github/scripts/open-claude-sdk-pr.sh に直書きされた刻印の行が formatOriginMarker(ORIGIN_AUTOMATION) と一致する', () => {
    const script = readFileSync(`${REPO_ROOT}/.github/scripts/open-claude-sdk-pr.sh`, 'utf8');
    const marker = formatOriginMarker(ORIGIN_AUTOMATION);
    // ダブルクォートではなくシングルクォートで書いてある前提（シェルの
    // echo 呼び出しの実物と揃える）。値そのものが変わればここも赤くなる。
    expect(script).toContain(`echo '${marker}'`);
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
 * **`decideGateVerdict`: `automation` の担保（`authorType`、Issue #893 / #930）。**
 *
 * 本文が `automation` を名乗っていても、それだけでは通さない——本文の外の
 * 事実（GitHub が発行する `user.type`）で裏付けが取れたときだけ通す。
 * 担保の理由・限界（3点）は `check-pr-origin-core.mjs` の doc「`automation`
 * の担保と限界」を見よ。
 */
describe('decideGateVerdict: automation の担保（authorType、Issue #893 / #930）', () => {
  const AUTOMATION_BODY = '<!-- alteroid-origin: automation -->';
  const AFTER_GATE = '2026-09-12T00:00:00Z';

  it('authorType: "Bot" ⟹ automation で通る', () => {
    expect(
      decideGateVerdict({ body: AUTOMATION_BODY, createdAt: AFTER_GATE, authorType: 'Bot' }),
    ).toEqual({ verdict: 'automation', values: ['automation'] });
  });

  it('authorType: "User" ⟹ unverified（人間の作者が automation を名乗っている）', () => {
    expect(
      decideGateVerdict({ body: AUTOMATION_BODY, createdAt: AFTER_GATE, authorType: 'User' }),
    ).toEqual({ verdict: 'unverified', values: ['automation'] });
  });

  it('authorType が undefined ⟹ fail closed（unverified）', () => {
    expect(
      decideGateVerdict({ body: AUTOMATION_BODY, createdAt: AFTER_GATE, authorType: undefined }),
    ).toEqual({ verdict: 'unverified', values: ['automation'] });
  });

  it('authorType が渡されていない（キーごと無い） ⟹ fail closed（unverified）', () => {
    expect(decideGateVerdict({ body: AUTOMATION_BODY, createdAt: AFTER_GATE })).toEqual({
      verdict: 'unverified',
      values: ['automation'],
    });
  });

  it('authorType が空文字 ⟹ fail closed（unverified）', () => {
    expect(
      decideGateVerdict({ body: AUTOMATION_BODY, createdAt: AFTER_GATE, authorType: '' }),
    ).toEqual({ verdict: 'unverified', values: ['automation'] });
  });

  it('authorType が null ⟹ fail closed（unverified）', () => {
    expect(
      decideGateVerdict({ body: AUTOMATION_BODY, createdAt: AFTER_GATE, authorType: null }),
    ).toEqual({ verdict: 'unverified', values: ['automation'] });
  });
});

/**
 * **`authorType` は `automation` 以外の verdict を一切動かさない
 * （Issue #893 / #930）。**
 *
 * `decideGateVerdict` の分岐は `base.verdict === 'automation'` のときだけ
 * `authorType` を見る（`check-pr-origin-core.mjs` の doc「`authorType` が
 * 動かすのは `automation` の verdict だけである」）。ここではその境界線を
 * 固定する——同じ本文に対して `authorType` を variance させても、
 * `automation` 以外の verdict はどれも変わらないことを見る。**変更の血管を
 * 細く保つ、という設計判断そのものの回帰確認である。**
 */
describe('decideGateVerdict: authorType は automation 以外の verdict を動かさない（Issue #893 / #930）', () => {
  const AFTER_GATE = '2026-09-12T00:00:00Z';
  const AUTHOR_TYPES = ['Bot', 'User', undefined, null, ''] as const;

  it.each(AUTHOR_TYPES)('human: authorType=%p でも human のまま', (authorType) => {
    expect(
      decideGateVerdict({
        body: '<!-- alteroid-origin: human -->',
        createdAt: AFTER_GATE,
        authorType,
      }),
    ).toEqual({ verdict: 'human', values: ['human'] });
  });

  it.each(AUTHOR_TYPES)('clone: authorType=%p でも clone のまま', (authorType) => {
    expect(
      decideGateVerdict({
        body: '<!-- alteroid-origin: clone -->',
        createdAt: AFTER_GATE,
        authorType,
      }),
    ).toEqual({ verdict: 'clone', values: ['clone'] });
  });

  it.each(AUTHOR_TYPES)('mgr- : authorType=%p でも manager のまま', (authorType) => {
    expect(
      decideGateVerdict({
        body: '<!-- alteroid-origin: mgr-abc123 -->',
        createdAt: AFTER_GATE,
        authorType,
      }),
    ).toEqual({ verdict: 'manager', managerId: 'mgr-abc123', values: ['mgr-abc123'] });
  });

  it.each(AUTHOR_TYPES)(
    'missing: authorType=%p でも missing のまま（legacy 判定は別軸）',
    (authorType) => {
      expect(decideGateVerdict({ body: null, createdAt: AFTER_GATE, authorType })).toEqual({
        verdict: 'missing',
      });
    },
  );

  it.each(AUTHOR_TYPES)('invalid: authorType=%p でも invalid のまま', (authorType) => {
    expect(
      decideGateVerdict({
        body: '<!-- alteroid-origin: bot -->',
        createdAt: AFTER_GATE,
        authorType,
      }),
    ).toEqual({ verdict: 'invalid', value: 'bot', values: ['bot'] });
  });

  it.each(AUTHOR_TYPES)('conflict: authorType=%p でも conflict のまま', (authorType) => {
    expect(
      decideGateVerdict({
        body: '<!-- alteroid-origin: clone -->\n<!-- alteroid-origin: human -->',
        createdAt: AFTER_GATE,
        authorType,
      }),
    ).toEqual({ verdict: 'conflict', values: ['clone', 'human'] });
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
