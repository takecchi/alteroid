import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`AGENTS.md` が他のファイルを指すときの形を固定する歯**（#369）。
 *
 * `AGENTS.md` はドキュメントなので、書いてある内容そのものに歯は当てられない。
 * ここが測るのは**参照の形**だけである — 腐ったときに「移動したのか消えたのか」を
 * 読む側が区別できる形になっているか。守っているのは3つで、それ以外は守っていない。
 *
 * 1. リポジトリ内のファイルを `path:行番号` で指していないこと
 * 2. 「N行目」で指していないこと
 * 3. `grep -Fn -- '<逐語>' <path>` の形で書かれた出典が、現物に当たること
 *
 * **フェンス（```）の中は見ない。** あそこに在るのは出典ではなく**生の出力**
 * （スタックトレース・過去の実測）で、書き換えてはいけないものだからである。
 *
 * **⚠️ なぜ `grep -n` ではなく `grep -Fn --` か（#408）。** 逐語に正規表現の
 * メタ文字（`$` `{` `}` `(` `)` `[` `]` `*` `+` `?` `.` `|` `^` `\` や、`-`
 * 始まりの文言）が入ると、`grep -n` はそれを正規表現として解釈し、0件や誤爆
 * （別の行が当たったように見える）を返すことがある。`-F`（fixed strings）は
 * 逐語をそのままの文字列として扱うので、「逐語の一部で指す」という規約の
 * 意図とちょうど一致する。
 *
 * **`--` は必須である。** 逐語が `-` から始まると、`--` が無い形は**道具ごとに
 * 壊れ方が違い、しかも一部はカレントディレクトリに何があるかにも依存する**
 * （実測。shim=ugrep 7.8.4／GNU grep 3.8／`rg -F`／`git grep -F --no-index`、
 * パターン `-1` で確認。固定した1つの壊れ方には整理しきれない）:
 * - **固まる**（1ファイル引数・標準入力を塞がない＝出典をそのまま打つ形。
 *   shim と GNU grep の両方。`-1` が「1行分の文脈」オプションとして食われ、
 *   ファイル名がパターンに化けてファイル引数が消え、標準入力を待つ）
 * - **exit 1・無出力**（同じ形で標準入力を `/dev/null` に塞いだとき、GNU grep は
 *   常にこう。shim と `git grep --no-index` は代わりに**カレントディレクトリの
 *   再帰探索へ切り替わり**、再帰した先に「本来渡したかったファイル名」を含む
 *   行が無ければ同じ exit 1・無出力になる——だが下の行き先とコインの裏表である）
 * - **exit 0・誤ヒット**（ファイル引数が2つ以上のとき、または上の再帰探索先に
 *   「本来渡したかったファイル名」を含む行が**たまたま**在ったとき。shim と
 *   `git grep --no-index` で確認。**「無検索」ではなく「別ファイル・別行の
 *   誤ヒット」であり、文脈行まで付くので読み手には正しい出典に見える**——
 *   この形は指した行の隣に何が置いてあるかという無関係な事情で現れたり
 *   消えたりする）
 * - **`rg -F` だけは例外で、上のどの形でも `exit 2` と明示エラー
 *   （`Found argument '-1' which wasn't expected...`）を返し、黙って壊れる
 *   ことが無かった**
 *
 * **`--` を付ければ、上の4主体すべてが期待どおりに1ファイルだけをヒットする**
 * （実測。他のメタ文字・実在コード片も含めて全マス確認済み）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export type ProseLine = { line: number; text: string };

/** `AGENTS.md` の本文（フェンスの中を落としたもの）を行番号つきで返す。 */
export function proseLines(markdown: string): ProseLine[] {
  const out: ProseLine[] = [];
  let inFence = false;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push({ line: i + 1, text });
  }
  return out;
}

export type LineNumberCitation = { line: number; token: string; target: string };

/**
 * `path:123` / `path:123-456` の形の参照のうち、**その `path` がこのリポジトリに実在する
 * ファイルを指しているもの**だけを返す。
 *
 * 実在で絞るのが要点である。この形の見た目は時刻（`2026-08-22T09:35`、`06:27`）と
 * 区別が付かず、リポジトリ外の依存（`tsup/dist/index.js:1703`）は版が固定されていれば
 * 腐らない。**腐るのは「このリポジトリのファイルを行番号で指したとき」だけである。**
 */
export function findLineNumberCitations(
  lines: readonly ProseLine[],
  isRepoFile: (candidate: string) => boolean,
): LineNumberCitation[] {
  const out: LineNumberCitation[] = [];
  const pattern = /([A-Za-z0-9_@.][A-Za-z0-9_./@-]*):(\d+)(?:-(\d+))?/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      const target = m[1] ?? '';
      if (!isRepoFile(target)) continue;
      out.push({ line, token: m[0], target });
    }
  }
  return out;
}

export type RowNumberCitation = { line: number; token: string };

/** 「106行目」の形の参照を返す。 */
export function findRowNumberCitations(lines: readonly ProseLine[]): RowNumberCitation[] {
  const out: RowNumberCitation[] = [];
  const pattern = /\d+\s*行目/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      out.push({ line, token: m[0] });
    }
  }
  return out;
}

export type VerbatimCitation = { line: number; pattern: string; target: string };
export type LegacyVerbatimCitation = {
  line: number;
  pattern: string;
  target: string;
  form: string;
};

/**
 * ``` `grep -Fn -- '<逐語>' <path>` ``` の形（インラインのコードスパン）で書かれた出典を、
 * **`-F` と `--` の有無を問わず**まとめて拾う内部ヘルパー（#408）。
 *
 * **この形だけを見る。** 引数にファイルを取らない `grep`（`grep -rn '<語>'`）や
 * `grep -c` は、出典ではなく道具の説明なので拾わない（＝逐語の後に空白区切りの
 * path が続かない形は、そもそもこの正規表現に一致しない）。
 *
 * **⚠️ なぜ「両方の形」を1つの正規表現で拾うか（#408 の裏返しの穴）。** 最初は
 * `-Fn --` だけを拾う正規表現にしたが、それだと**旧形式（`grep -n`、`-F`/`--`
 * 無し）で書かれた出典が歯の視界から丸ごと消える**——落ちない代わりに、
 * 見ていないので何も守っていない緑になる（Issue #408 が「正しく直すと歯の
 * 視界から外れる」と挙げていた懸念が、向きを変えて再現していた）。
 * **見ないのではなく、見つけたら形で判定して落とす**ことにした。
 */
function findAllGrepStyleCitations(
  lines: readonly ProseLine[],
): Array<{ line: number; hasF: boolean; hasDashDash: boolean; pattern: string; target: string }> {
  const out: Array<{
    line: number;
    hasF: boolean;
    hasDashDash: boolean;
    pattern: string;
    target: string;
  }> = [];
  const pattern = /`\s*grep -(F)?n(\s+--)?\s+(['"])(.+?)\3\s+([^\s`]+)\s*`/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      out.push({
        line,
        hasF: m[1] === 'F',
        hasDashDash: m[2] !== undefined,
        pattern: m[4] ?? '',
        target: m[5] ?? '',
      });
    }
  }
  return out;
}

/**
 * `grep -Fn -- '<逐語>' <path>`（正しい形。`-F` と `--` の両方が在る）で書かれた
 * 出典だけを返す。
 */
export function findVerbatimCitations(lines: readonly ProseLine[]): VerbatimCitation[] {
  return findAllGrepStyleCitations(lines)
    .filter((c) => c.hasF && c.hasDashDash)
    .map((c) => ({ line: c.line, pattern: c.pattern, target: c.target }));
}

/**
 * **旧形式**（`-F` が無い、または `--` が無い——`grep -n '<逐語>' <path>` を含む）
 * で書かれた出典を返す。呼び出し側はこれが空でないことを期待する（歯を赤くする側）。
 */
export function findLegacyVerbatimCitations(lines: readonly ProseLine[]): LegacyVerbatimCitation[] {
  return findAllGrepStyleCitations(lines)
    .filter((c) => !(c.hasF && c.hasDashDash))
    .map((c) => ({
      line: c.line,
      pattern: c.pattern,
      target: c.target,
      form: `grep ${c.hasF ? '-F' : ''}n${c.hasDashDash ? ' --' : ''}`,
    }));
}

/**
 * 出典（`VerbatimCitation`）のうち、指した逐語が対象ファイルの中に**現物として
 * 見つからないもの**を返す（#408 で切り出し。元は `it('grep -Fn -- で書かれた
 * 出典が現物に当たる')` の中に直書きしてあった）。
 *
 * **切り出した理由は、この判定そのものへ合成入力の陰性 fixture を当てるため
 * である。** AGENTS.md の実物だけを対象にしていると、「一致しない逐語を
 * missing として拾えているか」を独立に確かめる手段が無い —— `.some(() =>
 * true)` のような、判定を常に「一致した」へ倒す変異が当たっても、AGENTS.md
 * の現在の出典がたまたま全部一致していれば緑のままになりうる。
 *
 * `readTarget` を注入可能にしてあるのは、実ファイルを読まない合成テストからも
 * 同じ関数を通すためである（`isRepoFile` を注入可能にしているのと同じ理由）。
 */
export function findMissingVerbatimCitations(
  citations: readonly VerbatimCitation[],
  isRepoFile: (candidate: string) => boolean,
  readTarget: (target: string) => string,
): VerbatimCitation[] {
  return citations.filter((c) => {
    if (!isRepoFile(c.target)) return false; // リポジトリ外は見ない
    return !readTarget(c.target)
      .split('\n')
      .some((l) => l.includes(c.pattern));
  });
}

function isRepoFile(candidate: string): boolean {
  if (candidate.includes('..')) return false;
  try {
    return statSync(path.join(ROOT, candidate)).isFile();
  } catch {
    return false;
  }
}

function readRepoFile(target: string): string {
  return readFileSync(path.join(ROOT, target), 'utf8');
}

const agentsMd = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const prose = proseLines(agentsMd);

describe('AGENTS.md の参照の形（#369）', () => {
  it('本文がフェンスの中身を含まない（この歯が何を見ているかの確認）', () => {
    // フェンスの中にしか無い逐語。落ちたら proseLines が壊れている＝下の3本が
    // 「見ていないから0件」になりうるので、先にここで止める。
    expect(agentsMd).toContain('error occurred in dts build');
    expect(prose.map((l) => l.text).join('\n')).not.toContain('error occurred in dts build');
    expect(prose.length).toBeGreaterThan(100);
  });

  it('リポジトリ内のファイルを `path:行番号` で指さない', () => {
    const found = findLineNumberCitations(prose, isRepoFile);
    expect(
      found.map((c) => `AGENTS.md:${c.line} ${c.token}`),
      '行番号は腐り、腐ったことが読む側から分からない（開いた人には「そこに無い」としか見えず、' +
        "移動したのか消えたのかが区別できない）。逐語（`grep -Fn -- '<逐語>' <path>`）かシンボル名で指すこと。",
    ).toEqual([]);
  });

  it('「N行目」で指さない', () => {
    const found = findRowNumberCitations(prose);
    expect(
      found.map((c) => `AGENTS.md:${c.line} ${c.token}`),
      '直上と同じ理由。行番号を日本語で書いても腐り方は変わらない。',
    ).toEqual([]);
  });

  it('`grep -Fn --` で書かれた出典が現物に当たる', () => {
    const citations = findVerbatimCitations(prose);
    const missing = findMissingVerbatimCitations(citations, isRepoFile, readRepoFile);
    expect(
      missing.map((c) => `AGENTS.md:${c.line} grep -Fn -- '${c.pattern}' ${c.target} が0件`),
      [
        'AGENTS.md が引いている逐語が、指したファイルに無い。',
        '⚠️ これは「行が動いた」では落ちない（この歯は行番号を一切見ていない）。',
        '落ちたということは、指された文言そのものが書き換えられたか消えたかである。',
        '(a) 文言を直したのなら、AGENTS.md 側の逐語もいまの文言へ直す（またはシンボル名へ変える）',
        '(b) 指していたものが消えたのなら、AGENTS.md の参照ごと畳む',
      ].join('\n'),
    ).toEqual([]);
  });

  it('旧形式（`grep -n` など、`-F` か `--` が無い）で書かれた出典が無い（#408）', () => {
    // ⚠️ この歯自体が一度、向きを変えて同じ穴を再現した——最初は findVerbatimCitations
    // の正規表現を `-Fn --` だけに絞ったところ、旧形式で書かれた出典が「拾われない
    // ＝検査されない」まま緑になった（Issue #408 が挙げていた「正しく直すと歯の
    // 視界から外れる」の逆向き）。ここは「見ない」のではなく「見つけたら赤くする」
    // ことで、新旧どちらの片手落ちも防ぐ。
    const legacy = findLegacyVerbatimCitations(prose);
    expect(
      legacy.map((c) => `AGENTS.md:${c.line} ${c.form} '${c.pattern}' ${c.target}`),
      [
        "出典は `grep -Fn -- '<逐語>' <path>` の形で書くこと（#408）。",
        '`grep -n`（`-F` 無し）は逐語のメタ文字を正規表現として解釈し、0件・誤爆を作る。',
        '`--` が無いと、逐語が `-` から始まったときに道具ごと違う形で壊れる' +
          '（固まる／exit 1 無出力／別ファイルの偽陽性。詳細は AGENTS.md 該当箇所）。',
      ].join('\n'),
    ).toEqual([]);
  });
});

describe('参照を拾う側そのもの（歯が空振りしていないことの確認）', () => {
  // AGENTS.md が偶然きれいでも、拾う側が壊れていれば上の3本は0件で通る。
  // ここは AGENTS.md を見ずに、拾う側だけを合成入力で測る。
  const fixture = [
    'その境界は `packages/core/src/schema.ts:500-503` に在る。',
    '`apps/web/app/test-support.tsx` の106行目を含む。',
    "逐語は `grep -Fn -- 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
    '```',
    'at Worker.<anonymous> (…/tsup/dist/index.js:1545:26)',
    'この中の 42行目 は見ない。',
    '```',
    '時刻は 2026-08-22T09:35 で、`06:27` に出た。',
    'リポジトリ外は `tsup/dist/index.js:1703` のように書いてよい。',
  ].join('\n');
  const fixtureProse = proseLines(fixture);
  const fixtureIsRepoFile = (c: string) =>
    c === 'packages/core/src/schema.ts' || c === 'apps/web/app/test-support.tsx';

  it('フェンスの中は本文から落ちる', () => {
    expect(fixtureProse.map((l) => l.text)).not.toContain(
      'at Worker.<anonymous> (…/tsup/dist/index.js:1545:26)',
    );
    expect(fixtureProse.map((l) => l.line)).toEqual([1, 2, 3, 8, 9]);
  });

  it('リポジトリ内のファイルの `path:行番号` だけを拾う（時刻とリポジトリ外は拾わない）', () => {
    expect(findLineNumberCitations(fixtureProse, fixtureIsRepoFile)).toEqual([
      {
        line: 1,
        token: 'packages/core/src/schema.ts:500-503',
        target: 'packages/core/src/schema.ts',
      },
    ]);
  });

  it('「N行目」を拾う（フェンスの中のものは拾わない）', () => {
    expect(findRowNumberCitations(fixtureProse)).toEqual([{ line: 2, token: '106行目' }]);
  });

  it('`grep -Fn --` の出典から逐語とパスを取り出す', () => {
    expect(findVerbatimCitations(fixtureProse)).toEqual([
      { line: 3, pattern: 'ここに在る文言', target: 'packages/core/src/schema.ts' },
    ]);
  });

  it('旧形式（`grep -n`）は findVerbatimCitations に拾われず、findLegacyVerbatimCitations に拾われる（#408）', () => {
    // ⚠️ 「拾われない」で終わらせると、Issue #408 が挙げていた懸念
    // （正しく直すと歯の視界から外れる）を向きを変えて再現するだけになる。
    // findVerbatimCitations（正しい形専用）には見えない一方で、
    // findLegacyVerbatimCitations（旧形式の検出）には見える——「見ない」のではなく
    // 「別の関数が見つけて赤くする」ことを両方確かめる。
    const oldForm = proseLines(
      "逐語は `grep -n 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
    );
    expect(findVerbatimCitations(oldForm)).toEqual([]);
    expect(findLegacyVerbatimCitations(oldForm)).toEqual([
      {
        line: 1,
        pattern: 'ここに在る文言',
        target: 'packages/core/src/schema.ts',
        form: 'grep n',
      },
    ]);
  });

  it('`-F` は在るが `--` が無い形も、旧形式として拾われる（#408）', () => {
    // `-F` だけでは足りない——先頭が `-` の逐語はこの形でもオプション列に
    // 誤読される（AGENTS.md 該当箇所の実測）。`--` が無ければ旧形式扱いにする。
    const partialForm = proseLines(
      "逐語は `grep -Fn 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
    );
    expect(findVerbatimCitations(partialForm)).toEqual([]);
    expect(findLegacyVerbatimCitations(partialForm)).toEqual([
      {
        line: 1,
        pattern: 'ここに在る文言',
        target: 'packages/core/src/schema.ts',
        form: 'grep -Fn',
      },
    ]);
  });

  it('正しい形（`grep -Fn --`）は findLegacyVerbatimCitations に拾われない', () => {
    expect(findLegacyVerbatimCitations(fixtureProse)).toEqual([]);
  });
});

describe('出典が現物に当たるかの判定そのもの（陰性 fixture。#408）', () => {
  // 上の「`grep -Fn --` で書かれた出典が現物に当たる」は AGENTS.md の実物だけを
  // 対象にしている。AGENTS.md の出典がたまたま全部一致していれば、判定そのものが
  // 壊れていても（例:`.some(() => true)` のように常に「一致した」を返す変異）
  // その事実は見えない。ここは判定関数 findMissingVerbatimCitations だけを、
  // AGENTS.md を経由しない合成入力で測る。
  const readTarget = (target: string): string => {
    // **`needle-is-here` は行の一部であって行そのものではない。** 実在の出典
    // （例: AGENTS.md が引く `packages/core/src/schema.ts` の
    // 'デーモンは PR もブランチも見に行かない'）も、コメントの前後に文字が
    // 付いた「行の一部」である。ここを行全体一致にすると、`l === c.pattern`
    // という「行き過ぎ」側の変異（部分一致を全体一致へ縮める）を見逃す。
    if (target === 'positive.txt') return 'alpha\n * prefix needle-is-here suffix text\nomega\n';
    if (target === 'negative.txt') return 'alpha\nomega\n'; // 逐語を含まない
    throw new Error(`unexpected fixture target: ${target}`);
  };
  const fixtureIsRepoFile = (c: string): boolean => c === 'positive.txt' || c === 'negative.txt';

  it('逐語が対象ファイルに在れば missing に入らない', () => {
    const citations: VerbatimCitation[] = [
      { line: 1, pattern: 'needle-is-here', target: 'positive.txt' },
    ];
    expect(findMissingVerbatimCitations(citations, fixtureIsRepoFile, readTarget)).toEqual([]);
  });

  it('逐語が対象ファイルに無ければ missing に入る（陰性 fixture）', () => {
    const citations: VerbatimCitation[] = [
      { line: 1, pattern: 'needle-is-here', target: 'negative.txt' },
    ];
    expect(findMissingVerbatimCitations(citations, fixtureIsRepoFile, readTarget)).toEqual([
      { line: 1, pattern: 'needle-is-here', target: 'negative.txt' },
    ]);
  });

  it('リポジトリ外の target は見ない（在っても無くても missing に入らない）', () => {
    const citations: VerbatimCitation[] = [
      { line: 1, pattern: 'needle-is-here', target: 'outside-the-repo.txt' },
    ];
    expect(
      findMissingVerbatimCitations(citations, fixtureIsRepoFile, () => {
        throw new Error('リポジトリ外は isRepoFile で弾かれ、readTarget まで来ないはず');
      }),
    ).toEqual([]);
  });
});
