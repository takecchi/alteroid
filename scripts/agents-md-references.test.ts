import { execFileSync } from 'node:child_process';
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
 * ---
 *
 * ## この歯は `AGENTS.md` 専用である。`.claude/**`・どの階層かの `src/**`・`apps/web/app/**` は下の別の歯が持つ
 *
 * 上の3本は `AGENTS.md` 1ファイルしか見ていなかった（#369 で書かれた当時のまま）。
 * PR #760（コードの `path:行番号` 出典29件を逐語・シンボル名へ寄せた）の後、
 * `.claude/**` とどの階層かの `src/**` へ**「1. `path:行番号`」だけ**を広げる歯を
 * 下に足した。**その範囲は `src` という名前で決めていたので `apps/web`（`app/` を
 * 使う）にだけ当たらず、後から `apps/web/app/**` を足した**（理由と実測は
 * `isWidenedScopeFile` の直上に書いてある）（この下にある2本目の `describe(...)` ブロックがそれである。
 * その describe 名の中身は下の `// ` 行コメント側で確認できる——ここでは
 * 名前の文字列を引用しない。JSDoc の中で `*` の直後に `/` が続く形を書くと
 * コメントがそこで閉じてしまうため）。
 *
 * **⚠️ 「2. N行目」は広げない。理由と実測は、その歯のすぐ上の doc に書いてある**
 * （コードの中の「N行目」は出典ではなく語彙だから——詳細はそちらを読むこと）。
 * **「3. `grep -Fn --` の現物一致」も広げていない**——依頼の主題は
 * `path:行番号` の腐りだけで（コード中の裸のファイル名を `isRepoFile` が
 * 解決できず素通りしていた穴）、3.（逐語出典の現物一致）はこの PR が確かめた
 * 対象ではないため、範囲を広げると同時に線を引く側（AGENTS.md「範囲を広げるなら、
 * 広げると同時に新しい線を引くこと」）に倣ってここで止めてある。
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

/**
 * フェンス（```` ``` ```` / `~~~`）の状態機械そのもの。`proseLines`（下）はこれの
 * 薄いラッパで、戻り値から `lines` だけを取り出す——`proseLines` は既存の呼び出し
 * 元を持つ公開シグネチャなので戻り値の形は変えず、フェンスが閉じずに末尾へ
 * 達したこと（`unterminated`）だけを新しく外へ出す口をここに足した（#786）。
 *
 * 判定は CommonMark のフェンス付きコードブロックの規則
 * （https://spec.commonmark.org/0.31.2/#fenced-code-blocks）に合わせてある：
 *
 * 1. **開き**: 接頭辞（`//+` または `*`。前後の空白は無制限、上限は入れない）を
 *    剥がした残りの先頭が、同じ文字（`` ` `` または `~`）の3個以上の連続。
 *    **バックティックの連続に限り、その直後（同じ行の残り）にバックティックが
 *    1個でも在れば開きフェンスとして扱わない**——CommonMark はバックティックの
 *    フェンスの info string がバックティックを含むことを禁じており、含む行は
 *    「フェンスの開き」ではなく単なるインラインのコードスパン
 *    （``` `...` ```）だからである。この追加条件はバックティックにだけ掛かる。
 *    `~` の info string はチルダを含んでよい（CommonMark 上の非対称性）。
 * 2. **閉じ**: 開いたときと**同じ文字**で、開いたときの**連続の長さ以上**、
 *    後ろは空白のみ（info string を持たない）。文字が違う・長さが足りない
 *    行はトグルせず、フェンスの中のまま扱う。
 * 3. フェンスの中で2を満たさない行はプローズに数えない（生の出力として捨てる。
 *    閉じた行自身もプローズには数えない）。
 * 4. 末尾に達してもフェンスが閉じていなければ `unterminated: true` を返す——
 *    「フェンスの中（意図して無検査）」と「フェンス判定がずれた結果の無検査」を
 *    区別できないままにしないための口である。呼び出し側（下の歯）がこれを見て
 *    赤くする。
 * 5. **`unterminated` だけでは足りない（#786 の実際の欠陥）。** 閉じてはいるが
 *    **余計に開いた**——1行に開閉が両方在る行が正しく除外されないと、対応する
 *    閉じの無いフェンスが本文の途中で開いたまま、次のフェンス記号までが丸ごと
 *    無検査になる。この形は `unterminated` を `false` のまま通す（フェンス自体は
 *    最後まで閉じているため）。実測（旧実装、歯自身のファイル）: 933 行中
 *    704 行＝75.46% が無検査になっていたのに `unterminated` は `false` だった。
 *    **残った行が全部正しければ歯は緑のままなので、誰も気づけない。**
 *    ⟹ 何行を検査し、何行をフェンスの中として落としたかを `coverage`
 *    （戻り値。下の `FenceCoverage`）として外へ出す。
 *
 * **先頭空白に上限（3個など）を入れないこと。** 入れると、JSDoc の意図した
 * 字下げ（4+スペースの揃え）が開きフェンスとして認識されなくなる回帰を起こす
 * （`packages/core/src/runner.ts` の JSDoc コメントで一度この回帰が起きた）。
 */
export type FenceBlock = { open: number; close: number | null; lines: number };
export type FenceCoverage = {
  /** 総行数（`markdown.split('\n').length`）。 */
  total: number;
  /** 検査した行数（＝ `lines.length`）。 */
  prose: number;
  /** フェンスの中として落とした行数。**`prose + dropped === total` が常に成り立つ。** */
  dropped: number;
  /** `dropped / total`（`total === 0` なら 0）。 */
  ratio: number;
  /** 落とした区間。`close` が `null` なら末尾まで閉じていない（`unterminated`）。 */
  blocks: FenceBlock[];
};

export function proseLinesWithFenceState(markdown: string): {
  lines: ProseLine[];
  unterminated: boolean;
  coverage: FenceCoverage;
} {
  const out: ProseLine[] = [];
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  let blockOpen: number | null = null;
  const blocks: FenceBlock[] = [];
  const lines = markdown.split('\n');

  const prefixRe = /^\s*(?:\/\/+|\*)?\s*/;
  const openRe = /^(`{3,}|~{3,})(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const prefixMatch = prefixRe.exec(text);
    const content = text.slice(prefixMatch ? prefixMatch[0].length : 0);

    if (!inFence) {
      const m = openRe.exec(content);
      if (!m) {
        out.push({ line: i + 1, text });
        continue;
      }
      const marker = m[1];
      const markerChar = marker[0] as '`' | '~';
      const rest = m[2];
      if (markerChar === '`' && rest.includes('`')) {
        // info string にバックティックを含む ⟹ フェンスの開きではなく
        // インラインのコードスパン（#786 の欠陥A: 1行に開閉が両方在る行）。
        out.push({ line: i + 1, text });
        continue;
      }
      inFence = true;
      fenceChar = markerChar;
      fenceLen = marker.length;
      blockOpen = i + 1;
      continue;
    }

    // フェンスの中。同じ文字・長さ以上・後ろ空白のみの行だけが閉じる。
    if (fenceChar !== null && new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`).test(content)) {
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
      if (blockOpen !== null) {
        blocks.push({ open: blockOpen, close: i + 1, lines: i + 1 - blockOpen + 1 });
        blockOpen = null;
      }
    }
    // 閉じなかった行も、閉じた行自身も、プローズには数えない。
  }

  if (inFence && blockOpen !== null) {
    blocks.push({ open: blockOpen, close: null, lines: lines.length - blockOpen + 1 });
  }

  const total = lines.length;
  const prose = out.length;
  // `dropped` は `blocks` から独立に積み上げる（`total - prose` を直接使わない）。
  // こうしておくと「検査した行数」と「落とした区間の合計」という別々の計算経路が
  // 一致することを、下の歯（`prose + dropped === total`）が実際に確かめられる。
  const dropped = blocks.reduce((sum, b) => sum + b.lines, 0);
  const ratio = total === 0 ? 0 : dropped / total;

  return {
    lines: out,
    unterminated: inFence,
    coverage: { total, prose, dropped, ratio, blocks },
  };
}

/**
 * 本文（フェンスの中を落としたもの）を行番号つきで返す。`proseLinesWithFenceState`
 * （上）の薄いラッパ——既存の呼び出し元が多数在るため戻り値の形（`ProseLine[]`）は
 * 変えていない。`unterminated`（フェンスが閉じずに末尾へ達したか）を見る必要が
 * ある呼び出し元は `proseLinesWithFenceState` を直接呼ぶこと。
 *
 * 元々は `AGENTS.md`（生の Markdown）専用だったが、`.claude/**` とどの階層かの
 * `src/**` にも同じ考え方（フェンス＝出典ではなく生の出力なので見ない）を適用するために
 * ここで汎用化した。`.ts` のコメントの中のフェンスは行頭がそのまま
 * ` ``` ` にならず、コメント記号（`//` または JSDoc の `*`）が前に付く
 * （実例: `packages/core/src/inbox.ts` の JSDoc 内 ` * \`\`\` `、
 * `packages/core/src/clone.ts` の行コメント内 `// \`\`\` `）。
 */
export function proseLines(markdown: string): ProseLine[] {
  return proseLinesWithFenceState(markdown).lines;
}

// ---------------------------------------------------------------------------
// フェンス被覆の歯（#786 残り）—— 「何行を検査し、何行をフェンスの中として
// 落としたか」を測り、被覆が黙って縮んだときに赤くする。
// ---------------------------------------------------------------------------

export interface FenceCoverageExemption {
  /** リポジトリ相対パス。 */
  readonly file: string;
  /** **非空であること**（歯が測る）。 */
  readonly why: string;
}

export interface FenceCoverageLimits {
  readonly maxDroppedRatio: number;
  readonly minDroppedLines: number;
}

export type FenceCoverageViolation = {
  file: string;
  total: number;
  prose: number;
  dropped: number;
  ratio: number;
  blocks: FenceBlock[];
};

function exceedsFenceCoverageLimits(coverage: FenceCoverage, limits: FenceCoverageLimits): boolean {
  // ⚠ 「割合」と「行数」の両方を超えたときだけ違反にする（AND）。片方だけだと、
  // 正当な小さいファイル（割合だけ超える）と正当な大きいファイル（行数だけ超える）
  // のどちらかで誤爆する——下の合成 fixture がその2つを個別に確かめている。
  return coverage.ratio > limits.maxDroppedRatio && coverage.dropped >= limits.minDroppedLines;
}

/**
 * 対象ファイルのうち、被覆の閾値（`limits`）を超えていて、かつ免除表
 * （`exemptions`）に載っていないものを返す。
 */
export function findFenceCoverageViolations(
  entries: readonly { file: string; text: string }[],
  exemptions: readonly FenceCoverageExemption[],
  limits: FenceCoverageLimits,
): FenceCoverageViolation[] {
  const exemptFiles = new Set(exemptions.map((e) => e.file));
  const out: FenceCoverageViolation[] = [];
  for (const { file, text } of entries) {
    const { coverage } = proseLinesWithFenceState(text);
    if (!exceedsFenceCoverageLimits(coverage, limits)) continue;
    if (exemptFiles.has(file)) continue;
    out.push({
      file,
      total: coverage.total,
      prose: coverage.prose,
      dropped: coverage.dropped,
      ratio: coverage.ratio,
      blocks: coverage.blocks,
    });
  }
  return out;
}

/**
 * 免除表に載っているのに、もう閾値を超えていない（＝幽霊免除）ものを返す
 * （`file` の一覧）。免除の対象が既に直っている／消えているのに免除表にだけ
 * 残る形は、「守っていないのに守っているように見える」ので歯自体で防ぐ
 * （`WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS` の幽霊免除の歯と同じ考え方）。
 */
export function findGhostFenceCoverageExemptions(
  entries: readonly { file: string; text: string }[],
  exemptions: readonly FenceCoverageExemption[],
  limits: FenceCoverageLimits,
): string[] {
  const violatingFiles = new Set<string>();
  for (const { file, text } of entries) {
    const { coverage } = proseLinesWithFenceState(text);
    if (exceedsFenceCoverageLimits(coverage, limits)) violatingFiles.add(file);
  }
  return exemptions.filter((e) => !violatingFiles.has(e.file)).map((e) => e.file);
}

const FENCE_COVERAGE_MAX_BLOCKS_SHOWN = 5;

/**
 * 赤の意味そのもの。歯の失敗メッセージはこれを使って組み立てる。
 *
 * **⛔ 数字だけの赤にしない**——落とした区間の一覧と、何が起きたのかの説明
 * （対応がずれたのか、正当に長い生の出力なのか）と、この歯だけが捕まえる
 * ものであることの注意を必ず含める。
 */
export function formatFenceCoverageViolation(v: FenceCoverageViolation): string {
  const percent = (v.ratio * 100).toFixed(1);
  const sortedBlocks = [...v.blocks].sort((a, b) => b.lines - a.lines);
  const shown = sortedBlocks.slice(0, FENCE_COVERAGE_MAX_BLOCKS_SHOWN);
  const restCount = sortedBlocks.length - shown.length;
  const ranges = shown.map((b) => `${b.open}-${b.close === null ? '末尾' : b.close}`).join(', ');
  const rangesLine = restCount > 0 ? `${ranges}, 他 ${restCount} 件` : ranges;

  return [
    `${v.file}: 落とした行数 ${v.dropped}/${v.total} (${percent}%)。検査した行数 ${v.prose}。`,
    `落とした区間（長い順）: ${rangesLine}`,
    'この歯は「フェンスの中＝生の出力なので出典として数えない」として行を落とす。',
    'ここまで大きく落ちているときの原因は2つしか無い:',
    '(a) フェンスの対応がずれている（#786 の形）: コメントの中のインライン ``` が' +
      '「開き」と誤読され、そこから次のフェンス記号までが丸ごと無検査になる。' +
      '⟹ 落とした区間の開始行を開いて、その行が本当にコードブロックの開きかを見ること。',
    '(b) このファイルが正当に長い生の出力を持つ: ⟹ FENCE_COVERAGE_EXEMPTIONS へ理由つきで足すこと。',
    '⚠ (a) のとき、残った行が全部正しければ他の歯は全部緑のまま通る。この歯だけがそれを捕まえる。',
  ].join('\n');
}

/**
 * 40% は「いまの値を焼き込んだ」ものではない。実測した**正当な最大**（AGENTS.md の
 * 18.54%）と**欠陥の署名**（旧実装での scripts/agents-md-references.test.ts の 75.46%）
 * の**幾何中点（37.4%）に最も近いきりのよい値**である ⟹ 上へ 2.2 倍・下へ 1.9 倍の余裕。
 * ⭐ 割合はファイルが伸びても動かないので、doc が増えただけでは赤くならない
 * （絶対行数の下限だと、doc が1行増えるたびに動く数を門にすることになる）。
 */
export const FENCE_COVERAGE_MAX_DROPPED_RATIO = 0.4;

/**
 * 実測でフェンス1ブロックの最大長は 22 行（AGENTS.md）。小さいファイルが
 * 長いコード例1つを持つと割合だけでは誤爆する（30 行のファイルに 22 行の例で 73%）ので、
 * 行数の下限を対にして置く。22 行の約 2 倍。⚠ 逆に「大きいファイルの中の、
 * 割合は小さいが行数は大きい盲点」はこの歯では捕まらない —— いまの corpus の
 * 最大は 34 行なので線を引く根拠が無い。その形が現れたら実測してから引き直すこと。
 */
export const FENCE_COVERAGE_MIN_DROPPED_LINES = 40;

/** ⭐ いまは0件（実測。閾値を超えるファイルが1つも無い）。1件でも足すなら理由つきで。 */
export const FENCE_COVERAGE_EXEMPTIONS: readonly FenceCoverageExemption[] = [];

// ---------------------------------------------------------------------------
// 旧実装（#796 より前）との食い違い（#786 残り）—— 「被覆の歯が
// FENCE_COVERAGE_SELF_FILE を名指しで測っている」という前提（食い違うファイルは
// リポジトリ全体で1本だけ）を、機械に見張らせる。
// ---------------------------------------------------------------------------

/**
 * **PR #796 より前のフェンス判定（1行トグル）。⚠ 実装としては壊れている。**
 *
 * ここに残してあるのは**使うため**ではなく、**いまの実装とどこで食い違うかを機械に
 * 数えさせるため**だけである（下の `findFenceRuleDivergences`）。⛔ この関数を
 * `proseLines` の代わりに呼ばないこと。
 */
export function proseLinesLegacyToggle(markdown: string): ProseLine[] {
  const out: ProseLine[] = [];
  let inFence = false;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (/^\s*(?:\/\/+|\*)?\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push({ line: i + 1, text });
  }
  return out;
}

export type FenceRuleDivergence = {
  file: string;
  /** 現実装が検査した行数。 */
  current: number;
  /** 旧実装（1行トグル）が検査した行数。 */
  legacy: number;
};

/**
 * 現実装（`proseLinesWithFenceState`）と旧実装（`proseLinesLegacyToggle`）とで、
 * 検査した行数（＝プローズとして数えた行数）が食い違うファイルを返す。
 * 一致するファイルは1件も含めない——ここが返す件数がそのまま
 * 「#786 の回帰が署名を出せる場所の数」になる。
 */
export function findFenceRuleDivergences(
  entries: readonly { file: string; text: string }[],
): FenceRuleDivergence[] {
  const out: FenceRuleDivergence[] = [];
  for (const { file, text } of entries) {
    const current = proseLinesWithFenceState(text).lines.length;
    const legacy = proseLinesLegacyToggle(text).length;
    if (current !== legacy) {
      out.push({ file, current, legacy });
    }
  }
  return out;
}

export interface FenceRuleDivergenceFile {
  readonly file: string;
  /** **非空であること**（歯が測る）。 */
  readonly why: string;
}

/**
 * **旧実装（#796 前）と現実装で落とし行が食い違う、リポジトリ全体で唯一のファイル。**
 * ⟹ **#786 の回帰が署名を出せる唯一の場所**であり、被覆の歯が
 * `FENCE_COVERAGE_SELF_FILE` を名指しで測っている根拠そのものである。
 *
 * ⚠ **この表は「いまの repo の形に依存した事実」である。**2本目が現れたら
 * （＝別のファイルにも #786 の形が書かれたら）**下の歯が赤くなる。**
 * ⛔ **0件になっても赤くなる** —— 「食い違いが無くなった」と「数え方が壊れた」を
 * 同じ顔にしないため。どちらの向きでも、**赤を消す前に何が起きたのかを確かめること。**
 */
export const FENCE_RULE_DIVERGENCE_FILES: readonly FenceRuleDivergenceFile[] = [
  {
    file: 'scripts/agents-md-references.test.ts',
    why: '#786 の欠陥そのものを再現する合成 fixture と、フェンス記号を含む doc を持つ唯一のファイル。旧実装ではここだけが 933 行中 704 行（75.46%）を無検査にしていた（2026-09-12 実測、main = 77e6088）。',
  },
];

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
      form: `grep -${c.hasF ? 'F' : ''}n${c.hasDashDash ? ' --' : ''}`,
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

// ---------------------------------------------------------------------------
// `.claude/**` と `*/src/**` と `apps/web/app/**` — path:行番号 だけを広げる（#前述の doc）
// ---------------------------------------------------------------------------

// この歯の対象を `.claude/**` と、どの階層でも `src` という名前のディレクトリを
// 持つパスと、`apps/web/app/**` に絞る（`AGENTS.md` はここに来ない——別ファイル
// なので、そもそも `git ls-files` の一覧にしか現れず、`src` も `.claude` も
// `apps/web/app/` も含まないので false になる）。
//
// 「どの階層でも」で実装した——PR #760 の再現コマンドが実際に2階層下の
// `src`（`apps/daemon/src/*`）にも当たっていたことを確かめたうえでの実装
// （git のパス指定の `*` は `/` を跨ぐ。再現コマンドは下の doc comment に
// そのまま書ける——`//` 行コメントは `*/` で終わらないため）:
//
// ```
// git grep -nE '[A-Za-z0-9_.-]+\.(ts|tsx|mjs|js|md|json|yml|yaml):[0-9]+' -- '.claude/**' '*/src/**'
// ```
//
// ## ⚠️ `apps/web/app/**` を足したのは、前の委譲が意図して引いた線を動かす行為である
//
// #760 の続きは `apps/web/app/routes/chat.tsx` を **false 側に固定していた**
// （下の `isWidenedScopeFile` の歯が、その1行を期待値として持っていた）。
// **偶然そうなっていたのではなく、`src` という名前で範囲を決めた結果である。**
//
// **いま動かす理由は、その決め方が `apps/web` にだけ当たらないからである。**
// このリポジトリで自分のソースを `src/` の下に置いていないワークスペースは
// `apps/web` だけで、そこは `app/` を使う（Remix / React Router の規約）。
// ⟹ **「`src` を持つか」で範囲を決めると、`apps/web` のコードだけが規約の外に
// 落ちる。**実測（2026-09-10、この PR の前の `main`）: `.claude/**` と
// `*/src/**` の `path:行番号` は0件、免除表も0件で、いっぽう
// `apps/web/app/**` には25件が残っていた（うち22件は指した行が既に別物）。
//
// **⚠️ 広げていない範囲を、広げたように読まないこと。**
//
// - **`scripts/**` は入れていない。** この歯自身が `scripts/` に在り、doc と
//   合成 fixture の中に `path:行番号` の形を12件持っている（`clone.ts:505` など。
//   どれも出典ではなく**この歯の入力そのもの**である）。⟹ 素直に足すと**歯が
//   自分自身を数える**。自己参照をどう外すかは、それ自体が設計の問題なので
//   ここでは足さない（`apps/web/app/reserved-schedule-kind-prose.test.ts` は
//   同じ問題に `SELF` 除外で答えている——次に `scripts/**` を足す人はそこを読むこと）
// - **`docs/**`（正典）は入れていない。** 実測で `path:行番号` は0件であり、
//   広げても線を引いたことにならない
// - **「2. N行目」と「3. `grep -Fn --` の現物一致」は、`apps/web/app/**` へも
//   広げていない。**上の doc の理由（コードの中の「N行目」は語彙であって出典
//   ではない／依頼の主題は `path:行番号` の腐りだけ）がそのまま当てはまる
// - **`path:` の付かない裸の行番号（`… / \`2258\` / \`2533\` …` の形）は、
//   この歯では1件も検出できない。** `path:` が無いのでそもそも候補に上がらない。
//   この PR は `apps/web/app/routes/commitments.tsx` に在った11件を人手で畳んだが、
//   **畳んだだけで、歯は置いていない**（同じ形が明日また書かれても赤くならない）
export function isWidenedScopeFile(relativePath: string): boolean {
  if (relativePath === '.claude' || relativePath.startsWith('.claude/')) return true;
  if (relativePath.startsWith('apps/web/app/')) return true;
  return /(^|\/)src\//.test(relativePath);
}

/** `git ls-files -z` で追跡済みファイルの相対パスを列挙する（`check-tracked-nul-bytes.mjs` と同じ形）。 */
function listTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
}

/**
 * **この PR の本体。** `isRepoFile`（上）はリポジトリ相対の解決だけで、`clone.ts:505`
 * のような**裸のファイル名**を1件も拾えない。#760 より前の実測（30件中）は
 * リポジトリ相対5件・裸のファイル名25件（83%）だったので、裸のファイル名を
 * 解決できないままでは、この歯は「広げた」を名乗って中身の大半を素通りさせる。
 *
 * `repoRelativePaths`（`git ls-files` の出力）から、(a) 完全一致（リポジトリ
 * 相対） (b) `/` を含まない候補が、どれかのファイルの basename と一致——の
 * どちらかを許す解決器を作る。**basename が複数のファイルに一致しても
 * （`index.ts` は7パッケージに1つずつある）曖昧さは解決しない**——ここで
 * 答える必要があるのは「これはリポジトリのどこかのファイルを指しているか」
 * だけで、「どのファイルか」ではないため（`findLineNumberCitations` は
 * target を出典として拾うだけで、どのファイルかを本文と突き合わせない）。
 */
export function buildBasenameAwareRepoFileResolver(
  repoRelativePaths: readonly string[],
): (candidate: string) => boolean {
  const exact = new Set(repoRelativePaths);
  const basenames = new Set(repoRelativePaths.map((p) => path.posix.basename(p)));
  return (candidate: string): boolean => {
    if (candidate.includes('..')) return false;
    if (exact.has(candidate)) return true;
    if (candidate.includes('/')) return false;
    return basenames.has(candidate);
  };
}

export interface WidenedLineNumberCitationExemption {
  /** `.claude/**` の中、またはどの階層かの `src/**` の中の、リポジトリ相対パス。 */
  readonly file: string;
  /** `findLineNumberCitations` が返す `token`（例: `clone.ts:505`）。完全一致で照合する。 */
  readonly token: string;
  /** **非空であること**（下の歯が測る）。「あとで書く」を空文字で表せない。 */
  readonly why: string;
}

/**
 * 免除は「理由付き」であること（#756 `tool-description-enumeration.test.ts` の
 * 免除表と同じ形）。**⭐ いまは0件——2026-09-10 の実測で、#760 が29件、この PR が
 * 残り1件（`packages/core/src/memory.ts` の `store.ts:48-53` 引用。#760 が
 * 「別委譲が同じファイルを持っているため範囲外にした」としていたが、その委譲は
 * 着地済みで `gh pr list --json files` に `memory.ts` を触る開いた PR は
 * 無かったため、この PR で直した）を直したので、免除するものが無い。**
 * 1件でも新しく免除するなら、ここへ理由つきで足すこと。
 */
export const WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS: readonly WidenedLineNumberCitationExemption[] =
  [];

const TRACKED_FILES = listTrackedFiles();
const WIDENED_SCOPE_FILES = TRACKED_FILES.filter(isWidenedScopeFile);
const isRepoFileOrBasename = buildBasenameAwareRepoFileResolver(TRACKED_FILES);

const agentsMd = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const prose = proseLines(agentsMd);

/**
 * **被覆の歯だけが名指しで測る1ファイル。**
 *
 * ⛔ **これは #785 が決める「`path:行番号` の歯を `scripts/**` へ広げる」ではない** ——
 * ここが数えるのは**フェンスで落ちた行数だけ**で、出典を1件も読まない ⟹ 歯が自分自身を
 * 出典として数える問題（#785 の本題）は起きない。
 *
 * ⭐ **名指しする理由は実測1つだけである**（2026-09-12、`main` = 77e6088）。
 * 旧実装（#796 より前）と現実装で落とし行が食い違うファイルは**リポジトリ全体でこの1本だけ**で、
 * ⟹ **#786 の回帰が署名を出す場所がここしか無い**（現行 6/933 = 0.64% ↔ 旧実装 704/933 = 75.46%）。
 * 対象範囲（`AGENTS.md` ＋ 431 ファイル）では旧実装と現実装の落とし行が**1ファイルも違わない**。
 * ⟹ **この1ファイルを外すと、被覆の歯は #786 の回帰で1ミリも動かない。**
 *
 * ⚠ **「食い違うのは1本だけ」という前提そのものは、下の `FENCE_RULE_DIVERGENCE_FILES` の
 * 歯が機械で見張っている**（増えても減っても赤くなる）。
 */
const FENCE_COVERAGE_SELF_FILE = 'scripts/agents-md-references.test.ts';

// フェンス被覆の歯（下）が対象とする corpus。`AGENTS.md` 自身 + 広げた対象範囲
// （`WIDENED_SCOPE_FILES`）+ `FENCE_COVERAGE_SELF_FILE`（歯自身のファイル。理由は
// 直上の doc）。`scripts/**` はこの1件を除いて対象に足さない（#785 が決める範囲。
// この歯自身が `scripts/` に在り、doc と合成 fixture の中に大量のフェンス例を
// 持つため、素直に全部足すと歯が自分自身を大量に数える。上の `isWidenedScopeFile`
// の「`scripts/**` は入れていない」の doc と同じ理由——ただし被覆の歯は出典を
// 読まないので、名指しした1件だけは安全に足せる）。
const FENCE_COVERAGE_ENTRIES: readonly { file: string; text: string }[] = [
  { file: 'AGENTS.md', text: agentsMd },
  ...WIDENED_SCOPE_FILES.map((file) => ({ file, text: readRepoFile(file) })),
  { file: FENCE_COVERAGE_SELF_FILE, text: readRepoFile(FENCE_COVERAGE_SELF_FILE) },
];
const FENCE_COVERAGE_LIMITS: FenceCoverageLimits = {
  maxDroppedRatio: FENCE_COVERAGE_MAX_DROPPED_RATIO,
  minDroppedLines: FENCE_COVERAGE_MIN_DROPPED_LINES,
};

describe('AGENTS.md の参照の形（#369）', () => {
  it('本文がフェンスの中身を含まない（この歯が何を見ているかの確認）', () => {
    // フェンスの中にしか無い逐語。落ちたら proseLines が壊れている＝下の3本が
    // 「見ていないから0件」になりうるので、先にここで止める。
    expect(agentsMd).toContain('error occurred in dts build');
    expect(prose.map((l) => l.text).join('\n')).not.toContain('error occurred in dts build');
    expect(prose.length).toBeGreaterThan(100);
  });

  it('フェンスが最後まで閉じている（#786: 判定がずれた無検査を緑にしない）', () => {
    // 「フェンスの中（意図して無検査）」と「フェンス判定がずれた結果の無検査」を
    // 同じ状態にしないための歯。AGENTS.md が末尾までにフェンスを閉じていなければ、
    // それ以降が丸ごと「フェンスの中」として無検査になっているのに、それを
    // 読む側から見分けられない——ここで赤くする。
    expect(proseLinesWithFenceState(agentsMd).unterminated).toBe(false);
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

// ## なぜここは「N行目」を広げないか（実測。#369 の穴を広げる前に、まず狭める）
//
// `.claude/**` と `*/src/**` に対して `findRowNumberCitations`（＝「N行目」を
// 探す既存のパターン）を素直に当てると **131件** ヒットする（2026-09-10 実測。
// `//` 行コメントなら再現コマンドを1文字も変えずに書ける——`/** */` だと
// `'*/src/**'` の中の `*/` がコメントを閉じてしまうため、上の doc comment 群は
// この形に書き直してある）:
//
// ```
// git grep -noP '\d+\s*行目' -- '.claude/**' '*/src/**' | wc -l
// ```
//
// **抽出したサンプルは全件が誤検出だった** —— コードの中の「N行目」は出典では
// なく**語彙**として使われている。処理している**データ**（ログ・メッセージ本文・
// 台帳の行）の何行目かを指しているのであって、**ファイルを指す出典ではない**。
// 実例（自分で確かめること）:
//
// - `grep -Fn -- '理由は1行目だけ・200字で切る' packages/core/src/uncaught-net.test.ts`
//   —— 例外メッセージの1行目という意味
// - `grep -Fn -- '**1行目だけ・長さも切る**' packages/core/src/dropped-record.ts`
//   —— ドライバの例外オブジェクトの1行目という意味
// - `grep -Fn -- '2行目の補足です' apps/cli/src/chat.test.ts`
//   —— テストの合成入力（質問文）の2行目という意味
//
// **⟹ `AGENTS.md`（ファイルについての散文）では「N行目」は出典の形だが、
// コードでは同じ文字列が別の意味（語彙）を持つ。だから「2. N行目」の規則は
// `.claude/**` / `*/src/**` へは広げない**——広げれば131件、実測した範囲では
// 全件が門を鳴らすだけの偽陽性になる。規則を広げる代わりに、規則そのものを
// 狭く保つ（誤検出率を実測してから門を広げるかどうかを決める、という判断）。
//
// **`.claude/skills/mutation-testing/SKILL.md` の「より前の1行目へ挿入された」も
// この形（`path:行番号` ではなく `N行目` 単体）であることを確認済み**——
// `grep -Fn -- 'より前の1行目へ挿入された' .claude/skills/mutation-testing/SKILL.md`
// で当たる。この決定（N行目を広げない）により、そもそも今回のどちらの歯にも
// 引っ掛からない。フェンスの外か中かを気にする必要も無い。
describe('.claude/** と */src/** と apps/web/app/** の path:行番号 出典（PR #760 の続き）', () => {
  it('免除表の理由（why）が全部、非空である', () => {
    const blank = WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => e.why.trim().length === 0,
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      blank,
      '免除の理由が空である。なぜ広げた歯の対象から外すのかを書くこと' +
        '（空欄を許すと、免除表は数合わせの場所になる）。',
    ).toEqual([]);
  });

  it('免除表に載っている項目が、いまも実際に検出される現物と一致する（幽霊免除が無い）', () => {
    // 免除の対象が既に直っている／消えているのに免除表にだけ残る形は、
    // 「守っていないのに守っているように見える」ので歯自体で防ぐ。
    const stillDetected = new Set<string>();
    for (const file of WIDENED_SCOPE_FILES) {
      const text = readRepoFile(file);
      const lines = proseLines(text);
      for (const c of findLineNumberCitations(lines, isRepoFileOrBasename)) {
        stillDetected.add(`${file} ${c.token}`);
      }
    }
    const ghosts = WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => !stillDetected.has(`${e.file} ${e.token}`),
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      ghosts,
      '免除表に載っている file:token が、もう検出されない（直った/消えた）。' +
        '免除表からこの行を消すこと——直った後も免除に残すと、次に本当に必要な' +
        '免除が増えたときに見分けが付かなくなる。',
    ).toEqual([]);
  });

  it('リポジトリ内のファイルを `path:行番号`（裸のファイル名を含む）で指さない', () => {
    const hits: string[] = [];
    for (const file of WIDENED_SCOPE_FILES) {
      const text = readRepoFile(file);
      const lines = proseLines(text);
      for (const c of findLineNumberCitations(lines, isRepoFileOrBasename)) {
        const exempted = WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS.some(
          (e) => e.file === file && e.token === c.token,
        );
        if (exempted) continue;
        hits.push(`${file}:${c.line} ${c.token}`);
      }
    }
    expect(
      hits,
      '行番号は腐り、腐ったことが読む側から分からない（AGENTS.md「他のファイルを' +
        '出典として指すときは、行番号を単独の出典にしない」）。逐語' +
        "（`grep -Fn -- '<逐語>' <path>`）かシンボル名で指すこと。" +
        '直せない理由があるなら WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS へ理由つきで足すこと' +
        '（scripts/agents-md-references.test.ts）。',
    ).toEqual([]);
  });

  it('広げた対象範囲でフェンスが最後まで閉じている（#786）', () => {
    // AGENTS.md と同じ不変条件を、広げた対象範囲（407ファイル）にも適用する。
    // ここで実測すると0件——だから赤にできる（見つかったら実際に踏んでいる証拠）。
    const unterminated: string[] = [];
    for (const file of WIDENED_SCOPE_FILES) {
      const text = readRepoFile(file);
      if (proseLinesWithFenceState(text).unterminated) unterminated.push(file);
    }
    expect(
      unterminated,
      '末尾に達してもフェンスが閉じていない。これ以降の行が丸ごと' +
        '「フェンスの中」として無検査になっている——フェンス記号の対応' +
        '（開いた文字・長さと同じもので閉じる）を直すこと。',
    ).toEqual([]);
  });
});

// フェンス被覆の歯（#786 残り）。「何行を検査し、何行をフェンスの中として
// 落としたか」を実在の corpus（AGENTS.md + WIDENED_SCOPE_FILES）に当てる。
// 対応がずれて被覆が黙って縮んだときは、他の歯（`unterminated` を含む）が
// 全部緑のままでも、ここだけが赤くなる。
describe('フェンス被覆（#786 残り）', () => {
  it('被覆の違反が0件である', () => {
    const violations = findFenceCoverageViolations(
      FENCE_COVERAGE_ENTRIES,
      FENCE_COVERAGE_EXEMPTIONS,
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations.map(formatFenceCoverageViolation)).toEqual([]);
  });

  it('幽霊免除が0件である', () => {
    const ghosts = findGhostFenceCoverageExemptions(
      FENCE_COVERAGE_ENTRIES,
      FENCE_COVERAGE_EXEMPTIONS,
      FENCE_COVERAGE_LIMITS,
    );
    expect(
      ghosts,
      '免除表に載っている file が、もう閾値を超えていない（直った/消えた）。' +
        '免除表からこの行を消すこと。',
    ).toEqual([]);
  });

  it('免除表の理由（why）が全部、非空である', () => {
    const blank = FENCE_COVERAGE_EXEMPTIONS.filter((e) => e.why.trim().length === 0).map(
      (e) => e.file,
    );
    expect(blank, '免除の理由が空である。正当に長い生の出力である理由を書くこと。').toEqual([]);
  });

  it('`prose + dropped === total` が対象の全ファイルで成り立つ（勘定が壊れていないことの確認）', () => {
    const broken: string[] = [];
    for (const { file, text } of FENCE_COVERAGE_ENTRIES) {
      const { coverage } = proseLinesWithFenceState(text);
      if (coverage.prose + coverage.dropped !== coverage.total) {
        broken.push(
          `${file}: prose=${coverage.prose} dropped=${coverage.dropped} total=${coverage.total}`,
        );
      }
    }
    expect(
      broken,
      '検査した行数と落とした行数の合計が総行数と一致しない。' +
        '`proseLinesWithFenceState` の勘定が壊れている。',
    ).toEqual([]);
  });
});

describe('findFenceCoverageViolations / formatFenceCoverageViolation（合成 fixture。#786）', () => {
  it('割合と行数の両方が閾値を超える ⟹ 違反1件', () => {
    const fenceBody = Array.from({ length: 50 }, (_, i) => `dropped line ${i}`);
    const text = ['prose 1', '```', ...fenceBody, '```', 'prose 2'].join('\n');
    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/both-exceeded.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([
      {
        file: 'fixture/both-exceeded.md',
        total: 54,
        prose: 2,
        dropped: 52,
        ratio: 52 / 54,
        blocks: [{ open: 2, close: 53, lines: 52 }],
      },
    ]);
  });

  it('割合は超えるが行数が足りない小さいファイル ⟹ 違反0件（正当な小さいファイルで誤爆しない）', () => {
    const text = [
      'prose 1',
      '```',
      'a',
      'b',
      'c',
      'd',
      '```',
      'prose 2',
      'prose 3',
      'prose 4',
    ].join('\n');
    // total=10, dropped(block)=6 ⟹ ratio=0.6 > 0.4 だが dropped=6 < 40。
    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/small.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([]);
  });

  it('行数は超えるが割合が足りない大きいファイル ⟹ 違反0件（AGENTS.md と同じ形）', () => {
    const fenceBody = Array.from({ length: 43 }, (_, i) => `dropped line ${i}`);
    const proseBefore = Array.from({ length: 80 }, (_, i) => `prose before ${i}`);
    const proseAfter = Array.from({ length: 75 }, (_, i) => `prose after ${i}`);
    const text = [...proseBefore, '```', ...fenceBody, '```', ...proseAfter].join('\n');
    // total=80+1+43+1+75=200, dropped(block)=45 ⟹ ratio=0.225 < 0.4 だが dropped=45 >= 40。
    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/large.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([]);
  });

  it('免除表に載せた違反は違反にならない。免除したのに閾値を超えていないものは幽霊免除として拾われる', () => {
    const fenceBody = Array.from({ length: 50 }, (_, i) => `dropped line ${i}`);
    const violatingText = ['prose 1', '```', ...fenceBody, '```', 'prose 2'].join('\n');
    const cleanText = ['prose 1', 'prose 2', 'prose 3'].join('\n');
    const entries = [
      { file: 'fixture/violating.md', text: violatingText },
      { file: 'fixture/already-fixed.md', text: cleanText },
    ];
    const exemptions: FenceCoverageExemption[] = [
      {
        file: 'fixture/violating.md',
        why: '正当に長いスタックトレースの実測を含む（合成fixture）',
      },
      { file: 'fixture/already-fixed.md', why: '合成fixture: もう閾値を超えていない想定' },
    ];

    expect(findFenceCoverageViolations(entries, exemptions, FENCE_COVERAGE_LIMITS)).toEqual([]);
    expect(findGhostFenceCoverageExemptions(entries, exemptions, FENCE_COVERAGE_LIMITS)).toEqual([
      'fixture/already-fixed.md',
    ]);
  });

  it('#786 の形（1行に開閉が両方在る行の後ろに長い本文が続く）で coverage.dropped が増えない（被覆が縮まない）', () => {
    const tail = Array.from({ length: 100 }, (_, i) => `prose line ${i}`);
    const text = [' * ```code``` の続き', ...tail].join('\n');
    const { coverage } = proseLinesWithFenceState(text);
    expect(coverage.total).toBe(101);
    expect(coverage.prose).toBe(101);
    expect(coverage.dropped).toBe(0);
    expect(coverage.blocks).toEqual([]);
  });

  it('formatFenceCoverageViolation の出力: 落とした区間・原因の説明・警告の一文を含む（⛔ 数字だけの赤にしない）', () => {
    const violation: FenceCoverageViolation = {
      file: 'fixture/report-sample.md',
      total: 800,
      prose: 80,
      dropped: 720,
      ratio: 0.9,
      blocks: [
        { open: 700, close: null, lines: 60 },
        { open: 500, close: 550, lines: 51 },
        { open: 100, close: 140, lines: 41 },
        { open: 200, close: 230, lines: 31 },
        { open: 300, close: 320, lines: 21 },
        { open: 400, close: 411, lines: 12 },
        { open: 600, close: 605, lines: 6 },
      ],
    };
    const formatted = formatFenceCoverageViolation(violation);

    // パスと数字。
    expect(formatted).toContain('fixture/report-sample.md');
    expect(formatted).toContain('720/800');
    expect(formatted).toContain('90.0%');
    expect(formatted).toContain('80');

    // 落とした区間（長い順に上位5件。close===null は「末尾」）。他2件。
    expect(formatted).toContain('700-末尾');
    expect(formatted).toContain('500-550');
    expect(formatted).toContain('100-140');
    expect(formatted).toContain('200-230');
    expect(formatted).toContain('300-320');
    expect(formatted).not.toContain('400-411');
    expect(formatted).not.toContain('600-605');
    expect(formatted).toContain('他 2 件');

    // (a)(b) の説明。
    expect(formatted).toContain('フェンスの対応がずれている');
    expect(formatted).toContain('インライン');
    expect(formatted).toContain('正当に長い生の出力');
    expect(formatted).toContain('FENCE_COVERAGE_EXEMPTIONS');

    // ⚠ この歯だけが捕まえる、という一文。
    expect(formatted).toContain('他の歯は全部緑のまま通る');
    expect(formatted).toContain('この歯だけがそれを捕まえる');
  });

  it('coverage.blocks が期待どおり（開き行・閉じ行・長さ。unterminated のとき close === null）', () => {
    const closed = proseLinesWithFenceState(
      [
        ' * ```code``` の続き',
        '```',
        'real fence content (must stay hidden)',
        '```',
        'after the real fence, this line is prose again',
      ].join('\n'),
    );
    expect(closed.coverage.blocks).toEqual([{ open: 2, close: 4, lines: 3 }]);

    const unterminated = proseLinesWithFenceState(
      ['prose before', '```', 'hidden, the fence never closes'].join('\n'),
    );
    expect(unterminated.coverage.blocks).toEqual([{ open: 2, close: null, lines: 2 }]);
    expect(unterminated.unterminated).toBe(true);
  });
});

// 旧実装（#796 より前）との食い違い（#786 残り）。「対象集合が1つより増えたら
// 気づける形にする」「取れなかった軸に0の行を作らない」「集合の数え方に grep を
// 単独で使わない」という条件のもとで、`FENCE_COVERAGE_SELF_FILE` を名指しできる
// 根拠（食い違うファイルはリポジトリ全体でこの1本だけ）を機械に見張らせる。
describe('findFenceRuleDivergences（実在 corpus。TRACKED_FILES 全体。#786 残り）', () => {
  it('FENCE_RULE_DIVERGENCE_FILES の why が全部、非空である', () => {
    const blank = FENCE_RULE_DIVERGENCE_FILES.filter((f) => f.why.trim().length === 0).map(
      (f) => f.file,
    );
    expect(
      blank,
      '理由が空である。なぜこのファイルだけが #786 の回帰の署名を出せる場所なのかを書くこと。',
    ).toEqual([]);
  });

  it('食い違うファイルの集合が FENCE_RULE_DIVERGENCE_FILES と完全一致する（増えても減っても赤）', () => {
    // `TRACKED_FILES` は `git ls-files -z`（`listTrackedFiles`）が返す全追跡ファイル
    // そのもの——grep は使わない。取得できなければ execFileSync が例外を投げて
    // ここまで来ないので、「対象が無かった」と「取れなかった」を混同しない。
    const entries = TRACKED_FILES.map((file) => ({ file, text: readRepoFile(file) }));
    // 対象集合そのものが空/激減していないことの確認（「0件だから一致」という
    // 見かけ上の緑を、コーパスが取れていない場合と区別するための下限）。
    expect(entries.length).toBeGreaterThan(400);

    const divergences = findFenceRuleDivergences(entries);
    const divergentFiles = new Map(divergences.map((d) => [d.file, d]));
    const expectedFiles = new Set(FENCE_RULE_DIVERGENCE_FILES.map((f) => f.file));

    const added = [...divergentFiles.values()]
      .filter((d) => !expectedFiles.has(d.file))
      .map((d) => `${d.file} 現行${d.current}行/旧実装${d.legacy}行`);
    const removed = FENCE_RULE_DIVERGENCE_FILES.map((f) => f.file).filter(
      (file) => !divergentFiles.has(file),
    );

    expect(
      { added, removed },
      [
        '旧実装（1行トグル、#796 より前）と現実装とで検査した行数が食い違うファイルの',
        '集合が、FENCE_RULE_DIVERGENCE_FILES と一致しなくなった。',
        '',
        '増えた場合（added、`パス 現行N行/旧実装N行` の形）: このファイルにも #786 の形',
        '（コメント内のインライン ``` など）が新しく書かれた ⟹ 被覆の歯が名指しで測る',
        '対象（FENCE_COVERAGE_SELF_FILE）を見直すこと。⟹ FENCE_RULE_DIVERGENCE_FILES へ',
        '理由つきで足すこと。',
        '',
        '消えた場合（removed、パスのみ）: 前提（署名を出せる場所は1本だけ）が実際に',
        '変わったか、もしくは数え方そのものが壊れた ⟹ ⛔ 表からこの行を消す前に、',
        'どちらなのかを確かめること（0件になっても赤くする——「食い違いが無くなった」と',
        '「数え方が壊れた」を同じ顔にしないため）。',
      ].join('\n'),
    ).toEqual({ added: [], removed: [] });
  });
});

describe('findFenceRuleDivergences / proseLinesLegacyToggle（合成 fixture。#786）', () => {
  it('当たるべきところで当たる: #786 の形（1行に開閉が両方在る行の後ろに本文が続く）は current > legacy で1件検出する', () => {
    const tail = Array.from({ length: 20 }, (_, i) => `prose line ${i}`);
    const text = [' * ```code``` の続き', ...tail].join('\n');
    const divergences = findFenceRuleDivergences([{ file: 'fixture/defect.md', text }]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.file).toBe('fixture/defect.md');
    expect(divergences[0] && divergences[0].current > divergences[0].legacy).toBe(true);
  });

  it('当たってはいけないところで当たらない: 開き行と閉じ行が別々に在る普通のフェンスは食い違わない（0件）', () => {
    const text = ['prose 1', '```', 'fenced content', '```', 'prose 2'].join('\n');
    expect(findFenceRuleDivergences([{ file: 'fixture/normal-fence.md', text }])).toEqual([]);
  });

  it('当たってはいけないところで当たらない: フェンスを1つも持たない入力は食い違わない（0件）', () => {
    const text = ['prose 1', 'prose 2', 'prose 3'].join('\n');
    expect(findFenceRuleDivergences([{ file: 'fixture/no-fence.md', text }])).toEqual([]);
  });

  it('proseLinesLegacyToggle 自身が旧実装のとおりに壊れている（1行に開閉が両方在る行でトグルし、後ろを落とす）', () => {
    // ⛔ これが緑にならないなら旧実装のコピーが間違っている——`0f7b9ed^` の
    // proseLines をそのまま持ってきたものであること（当時のコミットで確認済み）。
    const tail = Array.from({ length: 5 }, (_, i) => `prose line ${i}`);
    const text = [' * ```code``` の続き', ...tail].join('\n');
    // 1行目でトグルし inFence=true になった後、閉じるフェンスが無いまま末尾へ
    // 達する ⟹ 1行目も含めて全行が「フェンスの中」として落ちる。
    expect(proseLinesLegacyToggle(text)).toEqual([]);
  });
});

describe('proseLines のフェンス判定（#786 の欠陥そのものを再現する合成 fixture）', () => {
  // ⚠️ ここは「この歯が緑になる経路が測りたい経路だけか」を確認済み
  // （実装をそれぞれ意図的に壊して、対応する it が個別に赤くなることを
  // 1本ずつ確認してから戻した。壊し方と結果は PR の報告に書く）。

  it('A: 1行に開閉が両方在る行（JSDoc の `* ` 接頭辞つき。歯自身の実例と同じ形）はトグルせずプローズのまま', () => {
    // この歯自身の doc（`proseLinesWithFenceState` の直上、` * ``` \`grep ...\` ``` `
    // の行）が実際にこの形である。旧実装はここでトグルし、ファイルの残り
    // （このケースでは5行目）を無検査にしていた。
    const fixture = [
      ' * ```code``` の続き',
      '```',
      'real fence content (must stay hidden)',
      '```',
      'after the real fence, this line is prose again',
    ].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([1, 5]);
    expect(lines.map((l) => l.text)).not.toContain('real fence content (must stay hidden)');
    expect(unterminated).toBe(false);
  });

  it('B: `~~~` と ``` の混在は閉じない（開いた文字でしか閉じられない）', () => {
    const fixture = [
      '~~~',
      'hidden line 1',
      '```',
      'still hidden: a different fence character does not close ~~~',
      '~~~',
      'now closed, prose again',
    ].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([6]);
    expect(unterminated).toBe(false);
  });

  it('C: フェンス長の不一致は閉じない（閉じは開いた長さ以上が必要）', () => {
    const fixture = [
      '````',
      'hidden inside a 4-backtick fence',
      '```',
      'still hidden: 3 backticks cannot close a 4-backtick fence',
      '````',
      'now closed by a matching (>=4) length, prose again',
    ].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([6]);
    expect(unterminated).toBe(false);
  });

  it('D: 末尾まで閉じられていないフェンスは unterminated: true を返す', () => {
    const fixture = ['prose before', '```', 'hidden, the fence never closes'].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([1]);
    expect(unterminated).toBe(true);
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
        form: 'grep -n',
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

describe('isWidenedScopeFile（歯の対象範囲そのもの。合成 fixture）', () => {
  it('.claude/** に入る', () => {
    expect(isWidenedScopeFile('.claude/skills/x/SKILL.md')).toBe(true);
    expect(isWidenedScopeFile('.claude')).toBe(true);
  });

  it('2階層下の src/** にも入る（PR #760 の再現コマンドが実際に当てていた形）', () => {
    expect(isWidenedScopeFile('apps/daemon/src/index.ts')).toBe(true);
    expect(isWidenedScopeFile('packages/core/src/clone.ts')).toBe(true);
  });

  it('apps/web/app/** に入る（src を持たない唯一のワークスペース。この PR で足した）', () => {
    expect(isWidenedScopeFile('apps/web/app/routes/chat.tsx')).toBe(true);
    expect(isWidenedScopeFile('apps/web/app/components/page.tsx')).toBe(true);
  });

  it('AGENTS.md・docs/・scripts/ は入らない', () => {
    expect(isWidenedScopeFile('AGENTS.md')).toBe(false);
    expect(isWidenedScopeFile('docs/north_star.md')).toBe(false);
    // この歯自身が置かれている場所。自己参照になるので入れていない（上の doc）。
    expect(isWidenedScopeFile('scripts/agents-md-references.test.ts')).toBe(false);
  });

  it('apps/web でも app/ の外（設定ファイル）は入らない', () => {
    expect(isWidenedScopeFile('apps/web/package.json')).toBe(false);
    expect(isWidenedScopeFile('apps/web/vite.config.ts')).toBe(false);
    // 前方一致であって部分一致ではない（別ワークスペースの同名ディレクトリを巻き込まない）。
    expect(isWidenedScopeFile('apps/webhooks/app/x.ts')).toBe(false);
  });

  it('パスの一部に "src" を含む語（srcじゃない）では誤爆しない', () => {
    expect(isWidenedScopeFile('packages/core/srcs/foo.ts')).toBe(false);
    expect(isWidenedScopeFile('packages/resrc/foo.ts')).toBe(false);
  });
});

describe('buildBasenameAwareRepoFileResolver（この PR の本体。合成 fixture）', () => {
  const repoFiles = [
    'packages/core/src/clone.ts',
    'apps/daemon/src/index.ts',
    'apps/runner/src/index.ts',
  ];
  const resolve = buildBasenameAwareRepoFileResolver(repoFiles);

  it('リポジトリ相対の完全一致を解決する（従来どおり）', () => {
    expect(resolve('packages/core/src/clone.ts')).toBe(true);
  });

  it('裸のファイル名（basename）も解決する——これが無いと #760 前の83%を取りこぼす', () => {
    expect(resolve('clone.ts')).toBe(true);
  });

  it('複数ファイルに一致する basename も解決する（曖昧さは解決しない仕様）', () => {
    // index.ts は apps/daemon と apps/runner の2つに一致するが、
    // 「リポジトリのどこかを指しているか」だけを答えればよいので true。
    expect(resolve('index.ts')).toBe(true);
  });

  it('リポジトリに存在しない裸のファイル名は解決しない', () => {
    expect(resolve('does-not-exist.ts')).toBe(false);
  });

  it('"/" を含むが完全一致しない候補は解決しない（部分パスの当て推量はしない）', () => {
    expect(resolve('core/src/clone.ts')).toBe(false);
  });

  it('".." を含む候補は解決しない', () => {
    expect(resolve('../clone.ts')).toBe(false);
  });
});

describe('広げた歯の end-to-end（合成 fixture。裸のファイル名の形が実際に鳴ることの確認）', () => {
  const repoFiles = ['packages/core/src/clone.ts', 'apps/daemon/src/index.ts'];
  const resolve = buildBasenameAwareRepoFileResolver(repoFiles);

  it('裸のファイル名の出典（`clone.ts:505`）を findLineNumberCitations が拾う', () => {
    const lines = proseLines('参照は `clone.ts:505` に在る。');
    expect(findLineNumberCitations(lines, resolve)).toEqual([
      { line: 1, token: 'clone.ts:505', target: 'clone.ts' },
    ]);
  });

  it('リポジトリ相対の出典（`apps/daemon/src/index.ts:1049-1050`）も引き続き拾う', () => {
    const lines = proseLines('参照は `apps/daemon/src/index.ts:1049-1050` に在る。');
    expect(findLineNumberCitations(lines, resolve)).toEqual([
      {
        line: 1,
        token: 'apps/daemon/src/index.ts:1049-1050',
        target: 'apps/daemon/src/index.ts',
      },
    ]);
  });

  it('時刻・版番号・リポジトリ外は拾わない（basename 解決を足しても誤検出が増えない）', () => {
    const lines = proseLines(
      [
        '時刻は 2026-08-22T09:35 で、`06:27` に出た。',
        'バージョンは `typescript-eslint:8.67.0` ではない。',
        'リポジトリ外は `tsup/dist/index.js:1703` のように書いてよい。',
      ].join('\n'),
    );
    expect(findLineNumberCitations(lines, resolve)).toEqual([]);
  });

  it('コメント記号つきのフェンス（`// \\`\\`\\` `）の中は見ない', () => {
    const lines = proseLines(
      ['// ```', '// clone.ts:505 のような実測はここでは書き換えない', '// ```'].join('\n'),
    );
    expect(findLineNumberCitations(lines, resolve)).toEqual([]);
  });
});
