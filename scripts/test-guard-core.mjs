/**
 * `test.mjs` の判定だけを切り出したもの（`verify.mjs` / `verify-core.mjs` と同じ分け方）。
 *
 * #311: `describe.skip` / `it.skip` で全部飛ばしても `pnpm test` が exit 0 のまま
 * 緑になる。直しは2枚に分かれている。
 *
 * - **歯A（実行の側）**: vitest の集計行（`Test Files` / `Tests`）を読み、
 *   `Tests` 行の passed が 0 なら赤くする。集計行そのものが出ていなければ、
 *   それは「1本も走らなかった」であって「1本も通らなかった」ではないので、
 *   別の文言で赤くする（`AGENTS.md`「『判定できない』という3つ目の状態を持つ」。
 *   2値にしない）。歯Aだけでは Issue の症状（1ファイルだけを `describe.skip` で
 *   丸ごと飛ばしても、他が passed なので `passed > 0` のまま）を捕まえられない。
 * - **歯B（ソースの側）**: root の `vitest.config.ts` の `include` に一致する
 *   全テストファイルを静的に走査し、**無条件の** `describe.skip` / `it.skip` /
 *   `test.skip`（`.each` や `.concurrent` のような修飾子との連鎖・tagged
 *   template 形の `.each` を含む）を検出する。**条件付き（`skipIf` / `runIf` /
 *   実行時の `ctx.skip()`）は対象外** — `describe`/`it`/`test` に続く `.` 区切り
 *   の連鎖を分解し、その要素に文字列として厳密に一致する `'skip'` が含まれる
 *   かで決める（`skipIf` は `'skip'` と文字列として等しくないので、連鎖の
 *   どこに現れても引っかからない。`SKIP_CALL_CHAIN_RE` の doc）。**歯Bも2値に
 *   しない** — 走査対象が0ファイルなら「無条件の skip が0件だった」ではなく
 *   「判定できない」（`EXIT_SCAN_EMPTY`）にする（`judgeStaticSkipScan`）。
 *
 * **この判定を vitest の中（テストや `setupFiles`）に置かない。** 置けば
 * `.skip` で判別器自身を黙らせられる。だから `test.mjs`（薄い CLI 層。vitest の
 * 外側の素の node プロセス）がここを呼ぶ形にしてある。**そして歯Bはすべての
 * テストファイルを走査するので、歯Bの単体テスト自身（`test-guard-core.test.ts`）が
 * `.skip` されたら歯Bが捕まえる。** 判別器が自分を守る形になっている。
 *
 * - **歯C（観測用テストの見直し期限）**: Issue #396。「観測用テスト」——
 *   いまの挙動を記録しただけで受け入れ基準ではない、と自分で名乗るテスト——は、
 *   終了条件を本文に書いていても腐る。実例（孤児ブランチ
 *   `packages/core/src/inbox-delivery.observed.test.ts`）は「直すと決めた時点で
 *   『基準』に書き換えるか捨てること」と書いていたが、その終了条件に到達した
 *   後もアサーションが緑のまま残り、テスト名が嘘になった。**足りなかったのは
 *   「終了条件を書かせること」ではなく「到達したかを誰が・いつ見るか」——だから
 *   歯Cは、その「見る人」を `pnpm test` にする。** 観測用テストと名乗った
 *   ファイル（パスの慣習 `.observed.` / `.scratch.` / `-scratch.`、または
 *   冒頭コメントの `@観測`）にだけ「終了条件」「見直し期限」を書かせ、期限を
 *   過ぎたら赤くする。**名乗っていない普通のテストファイルは対象外**
 *   （散文の「観測」は137ファイルが別の意味で使っており、誤検出になる —
 *   名乗りはパスの慣習と `@観測` の2形だけに絞る）。**走査対象0ファイル**
 *   （見ていない）・**申告不備**（書かせる項目が書かれていない）・**期限超過**
 *   （到達を見る番が来た）の3状態を混ぜない（歯Bと同じ作法）。
 *
 * ## 変異試験ハーネスとの関係（実装前に実測して確定させたこと）
 *
 * `.claude/skills/mutation-testing/mutate-core.mjs` の `decideJudgementCategory` は
 * **`testResult.exitCode` を1文字も見ない**。生存/検出は `testsAllPassed`
 * （＝ `Test Files` / `Tests` の集計行の文字列に `passed` / `failed` が
 * 含まれるか）だけで決まる（`exitCode` はフィールドとして保持されるだけで、
 * `decideJudgementCategory` の本体では参照されていない）。**だからこの歯が
 * 追加する exit 1（歯A・「判定できない」・歯B）は、集計行の文字列を書き換え
 * ない限り「検出」に化けない。** `test.mjs` は vitest の生出力を一切改変せず
 * 素通しするので、集計行はいつも vitest 自身が出した本物のままである。
 * 実測は PR 本文へ添えてある。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

/** `scripts/` の1つ上 ＝ リポジトリ根。`process.cwd()` に依存しない
 * （`pnpm --filter <pkg> test` では cwd がそのパッケージ配下になるため）。 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 変異試験や本物のビルド成果物と同じ理由で、走査から外すもの。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

// ── 歯A: 実行の側（vitest の集計行を読む） ──────────────────────────

/**
 * ANSI エスケープシーケンス（色付け）を取り除く。
 *
 * **CI で実際に踏んだ欠陥（実測、GitHub Actions 実行）**: vitest は
 * `Test Files` / `Tests` の行を色付きで出す（`\x1b[2m Test Files \x1b[22m …`
 * のように、ラベルの前後をエスケープシーケンスで挟む）。ローカル（このリポジトリの
 * 開発機やこのハーネスからの手元実行）では標準出力がパイプになるため vitest が
 * 自動で色を消し、この問題は出ない——しかし GitHub Actions のログでは色が
 * 付いたまま出る。**`^\s*Test Files` の `^\s*` はエスケープシーケンスを
 * 空白として読まない**ため、色が付いた回だけ「集計行が見つからない」＝
 * 「判定できない」に誤って倒れ、緑のまま走り切ったテストが赤くなった
 * （CI run 32665717865、head sha `d26f5a4`、vitest 自身は
 * `Test Files 130 passed (130)` / `Tests 2493 passed (2493)` を出していたが、
 * この関数がそれを見つけられずに `EXIT_UNKNOWN` を返していた）。
 * 色の有無に判定が依存してはならないので、マッチの前に必ず剥がす。
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- ANSI エスケープの検出そのものが目的
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** vitest の生出力（stdout + stderr）から `Test Files` / `Tests` の集計行を取り出す。
 * どちらかが無ければ `null`（＝「判定できない」の材料）。 */
export function parseAggregateLines(rawOutput) {
  const plain = stripAnsi(rawOutput);
  const filesLine = plain.match(/^\s*Test Files\s+.+$/m)?.[0]?.trim() ?? null;
  const testsLine = plain.match(/^\s*Tests\s+.+$/m)?.[0]?.trim() ?? null;
  return { filesLine, testsLine };
}

/** `Tests` 行から passed の件数を読む。`passed` という語自体が無ければ 0
 * （例: `Tests  1 skipped (1)` には `passed` が一度も出ない）。 */
export function parsePassedCount(testsLine) {
  if (testsLine === null) return 0;
  const m = testsLine.match(/(\d+)\s+passed/);
  return m ? Number(m[1]) : 0;
}

/** 歯A・「判定できない」用の exit code。vitest 自身の exit code（0/1）と
 * 混ざらないよう、vitest が exit 0 を返した後にだけこの分岐へ入る
 * （vitest が非0で落ちたときは、その exit code をそのまま返す。`test.mjs` 側）。 */
export const EXIT_ZERO_PASSED = 2;
export const EXIT_UNKNOWN = 3;
export const EXIT_STATIC_SKIP = 4;

/**
 * 歯Bの走査そのものが0ファイルしか読めなかったときの exit code。
 *
 * **マネージャーの追加の枷（依頼者経由）**: `include` の glob 展開に失敗した・
 * 走査の起点がずれた・`vitest.config.ts` を読めなかった等で対象が0件になると、
 * 「無条件の静的 skip が0件だった」と**同じ見た目**になる。前者は「見ていない」、
 * 後者は「見て、無かった」で、意味が違う（`AGENTS.md`「`grep` が静かに取りこぼす
 * 形」の `grep -c` が返す 0 と同じ形）。**混ぜない** — `EXIT_STATIC_SKIP` とも
 * `EXIT_UNKNOWN`（歯Aの集計行不在）とも別の exit code にする。
 */
export const EXIT_SCAN_EMPTY = 5;

/** 歯Aの判定そのもの。vitest が exit 0 を返した後に呼ぶ想定
 * （非0はそのまま伝播するので、ここには来ない）。 */
export function judgeExecution(rawOutput) {
  const { filesLine, testsLine } = parseAggregateLines(rawOutput);
  if (filesLine === null || testsLine === null) {
    return {
      ok: false,
      exitCode: EXIT_UNKNOWN,
      message: [
        'test-guard: 判定できない — vitest の集計行（Test Files / Tests）が出ていない。',
        '「1本も通らなかった」のか「1本も走らなかった」のかが区別できない。',
        '器が混雑していると vitest の fork pool が write EPIPE で死に、集計行そのものが',
        '出ないまま exit することがある（AGENTS.md「静かに失敗する道具」）。',
        '--maxWorkers を下げて取り直すこと。',
      ].join('\n'),
    };
  }
  const passed = parsePassedCount(testsLine);
  if (passed === 0) {
    return {
      ok: false,
      exitCode: EXIT_ZERO_PASSED,
      message: [
        `test-guard: 実行の側 — vitest の集計行に passed が無い、または 0 件だった: ${testsLine}`,
        '1本も実行されて成功したテストが無い。describe.skip / it.skip / test.skip で',
        '全部飛ばされていないか、フィルタが空になっていないかを確認すること。',
      ].join('\n'),
    };
  }
  return { ok: true, filesLine, testsLine, passed };
}

// ── 歯B: ソースの側（無条件の静的 skip を走査する） ──────────────────

/**
 * `describe` / `it` / `test` に続く**修飾子の連鎖**（`.each` / `.concurrent` 等）を
 * 呼び出しの直前まで拾い、その連鎖のどこかに `skip` という**完全一致の**要素が
 * あるかを見る。連鎖は `(` だけでなく、tagged template（`` it.each`...` ``）の
 * `` ` `` でも終われる。
 *
 * **マネージャーの差し戻し（実測、`SKIP_CALL_RE` を直接抜き出して13ケースに
 * 掛けた結果）が起点**: 旧実装（`\.skip(\.\w+)?\s*\(`）は次の2形を取りこぼして
 * いた。
 *
 * 1. `it.skip.each\`テーブル\`(...)` / `describe.skip.each\`テーブル\`(...)`
 *    （tagged template 形の `.each`。終端が `` ` `` で、旧実装は `\(` しか
 *    許していなかった）
 * 2. `it.concurrent.skip(...)`（修飾子が `skip` の**前**に来る形。旧実装は
 *    `(describe|it|test)` の直後に `\.skip` が直接続くことしか許していなかった）
 *
 * **どちらも、この repo にいま現用の実例は無い**（`.each` は全部丸括弧＋配列の
 * 形、`.concurrent` は実例そのものが無い）。**それでも直す判断は変えていない**
 * — どちらも vitest 標準の構文であり、次に書かれたときに歯Bが見逃してよい
 * 理由にはならない。歯Bが「無条件の静的 skip はソースに残らない」と名乗る
 * 判別器である以上、いま使われていないという事実は保証の穴を正当化しない。
 * （当初「tagged template 形は `packages/core/src/tools.test.ts` /
 * `railway/setup.test.ts` に実在する」と grep で読んだが、ヒットの中身は
 * すべて Markdown コードスパンの散文であり実コードは無かった。取り違えた
 * 経緯と検算は PR 本文に書いてある。）
 *
 * **`skipIf` / `runIf` の除外は、文字列一致ではなく配列の完全一致で行う。**
 * 連鎖を `.` で割った要素の配列（例: `['concurrent', 'skip']`）を作り、その中に
 * 文字列として厳密に `'skip'` が含まれるかどうかだけを見る。`'skipIf'` は
 * `'skip'` と文字列として等しくないので、連鎖のどこに現れても引っかからない
 * （`\b` の境界トリックに頼らないぶん、連鎖の途中に来ても・前に来ても同じ判定
 * になる）。
 *
 * **意図して直さないもの**: `it .skip(`（識別子と `.skip` のあいだの空白）。
 * この repo は prettier を通すので、そもそもこの空白は入らない形にしか
 * ならない（`pnpm format:check` が守る）。塞ぐ価値が無いので塞がない。
 *
 * **バッククォート終端は `.each` の直後だけに絞る。** マネージャーの差し戻しへ
 * 対応する過程で、`scripts/workspace-test-scripts.test.ts` の doc コメント
 * （Markdown の逆引用符でコードスパンとして「`describe.skip`」「`it.skip`」と
 * 書いてあるだけの散文）が誤検出することが実地で分かった —— どちらも「識別子
 * ＋連鎖」の直後に**閉じる**逆引用符が来るので、素朴に「終端が `` ` `` なら
 * tagged template」と読むと、Markdown のコードスパンの閉じ記号まで tagged
 * template の開き記号として拾ってしまう。**本物の tagged template 呼び出しは
 * 必ず `.each` の直後にしか現れない**（vitest の逆引用符呼び出しは `.each`
 * にしか無い）ため、連鎖の**最後の要素が `each` であるときだけ**バッククォート
 * 終端を認める。開き括弧 `(` のほうはこの制限を掛けない（`.skip(` は連鎖の
 * 中身によらず常に本物でありうる）。
 */
const SKIP_CALL_CHAIN_RE = /\b(describe|it|test)((?:\.\w+)*)\s*([(`])/g;

/** 連鎖（`.skip.each` のような文字列。先頭の `.` を含む）に `skip` という
 * 完全一致の要素が含まれるか。 */
function chainHasUnconditionalSkip(chain) {
  const segments = chain.split('.').filter(Boolean);
  return segments.includes('skip');
}

/**
 * `files`（`{ path, content }` の配列）を走査し、無条件の静的 skip の箇所を返す。
 * ディスクを読まない — 合成した文字列でも試せる
 * （`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」）。
 */
export function findUnconditionalSkips(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      SKIP_CALL_CHAIN_RE.lastIndex = 0;
      let m;
      while ((m = SKIP_CALL_CHAIN_RE.exec(line)) !== null) {
        const base = m[1];
        const chain = m[2];
        const terminal = m[3];
        const segments = chain.split('.').filter(Boolean);
        // バッククォート終端は `.each` の直後だけ（上の doc）。開き括弧は無条件。
        if (terminal === '`' && segments[segments.length - 1] !== 'each') continue;
        if (chainHasUnconditionalSkip(chain)) {
          hits.push({
            path: file.path,
            line: i + 1,
            matched: `${base}${chain}`,
          });
        }
      }
    }
  }
  return hits;
}

/** 歯Bが落ちたときの文言。ファイル・行・見つかった形と、次の手を書く。 */
export function formatSkipGuardMessage(hits) {
  const lines = hits.map((h) => `  ${h.path}:${h.line}  ${h.matched}`);
  return [
    `test-guard: ソースの側 — 無条件の静的 skip が ${hits.length} 件見つかった:`,
    ...lines,
    '',
    '戻し忘れなら消す。意図的に止めたいなら skipIf で条件を書くか、消して Issue にする。',
  ].join('\n');
}

/**
 * 歯Bの最終判定。**「0ファイルを読んだ」と「読んで、無条件の skip が0件だった」を
 * 混ぜない**（上の `EXIT_SCAN_EMPTY` の doc）。ディスクを読まない純粋関数 —
 * `matchedPaths` / `hits` を合成しても試せる。
 *
 * 3値: `matchedPaths.length === 0` → 判定できない（`EXIT_SCAN_EMPTY`) /
 * `hits.length > 0` → 検出（`EXIT_STATIC_SKIP`) / それ以外 → 合格。
 */
export function judgeStaticSkipScan(matchedPaths, hits) {
  if (matchedPaths.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message: [
        'test-guard: 判定できない — 歯Bの走査対象が0ファイルだった。',
        'root の vitest.config.ts の include に一致するテストファイルが1件も見つからない。',
        'include の glob 展開に失敗した、走査の起点（ROOT）がずれた、などが疑われる。',
        '「無条件の静的 skip が0件だった」と同じ見た目になるが、別の状態である',
        '（見て0件だったのではなく、見ていない）。',
      ].join('\n'),
    };
  }
  if (hits.length > 0) {
    return { ok: false, exitCode: EXIT_STATIC_SKIP, message: formatSkipGuardMessage(hits) };
  }
  return { ok: true, scanned: matchedPaths.length };
}

// ── 歯C: 観測用テストの見直し期限（#396） ──────────────────────────

/** 歯Cが「申告不備」と判定したときの exit code（歯A/歯Bのどれとも混ざらない
 * 新規の値）。「名乗ったのに終了条件／見直し期限が無い、または見直し期限の
 * 書式が壊れている」——書かせる項目が書かれていない、という状態。 */
export const EXIT_OBSERVATION_UNDECLARED = 6;

/** 歯Cが「見直し期限を過ぎた」と判定したときの exit code。**到達を見る番が
 * 来た**という状態であって、申告不備（`EXIT_OBSERVATION_UNDECLARED`）とは
 * 別に扱う——前者は「書かれていない」、後者は「書かれてはいるが古い」。 */
export const EXIT_OBSERVATION_DUE = 7;

/** `YYYY-MM-DD`（ゼロ埋め4桁-2桁-2桁）にちょうど一致するか。`2026-9-1` の
 * ようなゼロ埋め無しは弾く——文字列比較で日付順と一致させるための前提
 * （下の `today > 見直し期限` の比較がこれに乗っている）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ファイル先頭の「コメント領域」を切り出す。**コメントでも空行でもない
 * 最初の行の直前まで**（`//`・`/*`・` *`・ブロックコメント終端（`*` に続けて
 * `/`）で始まる行と空行だけを通す）。それより後ろは見ない——`@観測` の
 * 名乗りも `終了条件` / `見直し期限` の申告も、この領域の中でだけ拾う。
 */
function leadingCommentArea(content) {
  const areaLines = [];
  for (const line of content.split('\n')) {
    if (
      line.trim() === '' ||
      line.startsWith('//') ||
      line.startsWith('/*') ||
      line.startsWith(' *') ||
      line.startsWith('*/')
    ) {
      areaLines.push(line);
    } else {
      break;
    }
  }
  return areaLines.join('\n');
}

/** 行頭のコメント記号（`/**`・`/*`・ブロックコメント終端（`*` に続けて `/`）・
 * `*`・`//`）と、それに続く空白を1つだけ剥がす。
 * `" * 終了条件: xxx"` → `"終了条件: xxx"`。 */
function stripCommentPrefix(line) {
  return line.replace(/^\s*(\/\*\*|\/\*|\*\/|\*|\/\/)\s?/, '');
}

/** コメント領域の中から `<label>: <値>` / `<label>：<値>`（全角コロンも通す）
 * の行を探し、値（前後の空白を除いたもの）を返す。見つからなければ
 * `undefined`。 */
function extractField(area, label) {
  const re = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`);
  for (const line of area.split('\n')) {
    const m = stripCommentPrefix(line).trim().match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** コメント領域の中で `<label>: …` の行が現れる行番号（1始まり）。無ければ
 * `null`（`findObservationDebts` がメッセージの `file:line` に使う）。 */
function findFieldLine(content, label) {
  const re = new RegExp(`^${label}\\s*[:：]`);
  const lines = content.split('\n');
  const areaLineCount = leadingCommentArea(content).split('\n').length;
  for (let i = 0; i < areaLineCount; i++) {
    if (re.test(stripCommentPrefix(lines[i]).trim())) return i + 1;
  }
  return null;
}

/**
 * `path` / `content` が「観測用テスト」を名乗っているか。**名乗りは2形だけ**
 * （散文の「観測」「書き捨て」等では判定しない——137ファイルが「観測」を
 * 別の意味で使っており誤検出になることを実測済み）。
 *
 * 1. パスの慣習: ファイル名に `.observed.` / `.scratch.` / `-scratch.` を含む
 *    （実在の2例: 孤児ブランチの `inbox-delivery.observed.test.ts`、
 *    `origin/measure/fb1c80e3-388-signal-scaffold` の
 *    `chat.issue388-scratch.test.tsx`）
 * 2. 冒頭コメント領域に `@観測` という語が在る（領域より後ろは見ない）
 */
export function isObservationFile(path, content) {
  if (path.includes('.observed.') || path.includes('.scratch.') || path.includes('-scratch.')) {
    return true;
  }
  return leadingCommentArea(content).includes('@観測');
}

/**
 * 冒頭コメント領域から「終了条件」「見直し期限」を読む。**見つからない欄は
 * `undefined`**（`終了条件` は空文字列も `undefined` 扱い。`見直し期限` は
 * `YYYY-MM-DD` に一致しなければ ── 書式が壊れていても ── `undefined` 扱い）。
 * `見直し期限Raw` は書式検証前の生の値（見つからなければ `undefined`）——
 * 「見つからない」と「書式が壊れている」をメッセージで書き分けるための
 * 診断用の補助フィールドで、必須の2項目には含まれない。
 */
export function readObservationDeclaration(content) {
  const area = leadingCommentArea(content);
  const termRaw = extractField(area, '終了条件');
  const deadlineRaw = extractField(area, '見直し期限');
  return {
    終了条件: termRaw && termRaw.length > 0 ? termRaw : undefined,
    見直し期限: deadlineRaw !== undefined && DATE_RE.test(deadlineRaw) ? deadlineRaw : undefined,
    見直し期限Raw: deadlineRaw,
  };
}

/** 歯Cが落ちたときの文言。ファイル:行と、次の手を書く（`formatSkipGuardMessage`
 * と同じ形）。`kind` ごとに次の手が違う——`undeclared` は「2項目を書くこと」
 * だけだが、`due` は3つの選択肢がある。 */
export function formatObservationGuardMessage(debts, kind) {
  const lines = debts.map((d) => `  ${d.path}:${d.line}  ${d.detail}`);
  const header =
    kind === 'undeclared'
      ? `test-guard: 観測用テストの申告不備 — 終了条件／見直し期限が無い、または書式が壊れているものが ${debts.length} 件:`
      : `test-guard: 観測用テストの見直し期限超過 — 到達を見る番が来たものが ${debts.length} 件:`;
  const footer =
    kind === 'undeclared'
      ? [
          '',
          '観測用テストと名乗るなら、冒頭コメント領域に',
          '「終了条件: <空でない文字列>」「見直し期限: YYYY-MM-DD」の両方を書くこと。',
        ]
      : [
          '',
          '次の手（いずれか）: 終了条件に到達していれば「基準」に書き換える／捨てる／',
          'まだ到達していないなら見直し期限を延ばす（延ばすなら、なぜ延ばすかも一緒に書く）。',
        ];
  return [header, ...lines, ...footer].join('\n');
}

/**
 * `files`（`{ path, content }` の配列）のうち `isObservationFile` に当たる
 * ものだけを見て、負債を返す。**名乗っていないファイルは中身を見ない**
 * （何を書いてあっても素通り）。`today` は `'YYYY-MM-DD'` の文字列——**この
 * 関数の中で `new Date()` を呼ばない**（呼べばテストが日付で腐る。それは
 * この Issue が直そうとしている当のものである）。日付の比較は文字列比較
 * （`today > 見直し期限`）でよい——`YYYY-MM-DD` は辞書順が日付順と一致する。
 * **期限当日はまだ赤くしない**（`>` であって `>=` ではない）。
 */
export function findObservationDebts(files, today) {
  const debts = [];
  for (const file of files) {
    if (!isObservationFile(file.path, file.content)) continue;
    const decl = readObservationDeclaration(file.content);
    if (decl.終了条件 === undefined || decl.見直し期限 === undefined) {
      const missing = [];
      if (decl.終了条件 === undefined) missing.push('終了条件が無い');
      if (decl.見直し期限 === undefined) {
        missing.push(
          decl.見直し期限Raw !== undefined
            ? `見直し期限の書式が壊れている（${decl.見直し期限Raw}）`
            : '見直し期限が無い',
        );
      }
      debts.push({
        path: file.path,
        line:
          findFieldLine(file.content, '見直し期限') ?? findFieldLine(file.content, '終了条件') ?? 1,
        kind: 'undeclared',
        detail: missing.join(' / '),
      });
      continue;
    }
    if (today > decl.見直し期限) {
      debts.push({
        path: file.path,
        line: findFieldLine(file.content, '見直し期限') ?? 1,
        kind: 'due',
        detail: `終了条件: ${decl.終了条件} / 見直し期限: ${decl.見直し期限}（today=${today}）`,
      });
    }
  }
  return debts;
}

/**
 * 歯Cの最終判定。3状態を混ぜない（`judgeStaticSkipScan` と同じ作法）:
 * `matchedPaths.length === 0` → 判定できない（`EXIT_SCAN_EMPTY`、歯Bと同じ
 * 値——「見ていない」という意味そのものが歯Bと同じ走査に乗っているため）／
 * `undeclared` な負債が1件以上 → 申告不備（`EXIT_OBSERVATION_UNDECLARED`）／
 * `due` な負債が1件以上 → 見直し期限超過（`EXIT_OBSERVATION_DUE`）／それ以外
 * → 合格。**`undeclared` を `due` より先に見る**——申告そのものが壊れている
 * ファイルは、期限の比較ができない（`見直し期限` が `undefined` のままでは
 * `today > 見直し期限` が意味を持たない）ので、先に直すべき負債として優先する。
 */
export function judgeObservationScan(matchedPaths, debts) {
  if (matchedPaths.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message: [
        'test-guard: 判定できない — 歯Cの走査対象が0ファイルだった。',
        'root の vitest.config.ts の include に一致するテストファイルが1件も見つからない。',
        '（見て0件だったのではなく、見ていない。歯Bと同じ理由・同じ exit code。）',
      ].join('\n'),
    };
  }
  const undeclared = debts.filter((d) => d.kind === 'undeclared');
  if (undeclared.length > 0) {
    return {
      ok: false,
      exitCode: EXIT_OBSERVATION_UNDECLARED,
      message: formatObservationGuardMessage(undeclared, 'undeclared'),
    };
  }
  const due = debts.filter((d) => d.kind === 'due');
  if (due.length > 0) {
    return {
      ok: false,
      exitCode: EXIT_OBSERVATION_DUE,
      message: formatObservationGuardMessage(due, 'due'),
    };
  }
  return { ok: true, scanned: matchedPaths.length };
}

// ── I/O: include globs の読み取りとファイル走査 ──────────────────────

/**
 * root の `vitest.config.ts` を直接 `import` し、`test.include` を読む。
 * **書き写さない** — `scripts/workspace-test-scripts.test.ts` と同じ理由で、
 * 二重管理はずれる。この repo の node（22.23 系、`mise.toml`）は `.ts` の型
 * ストリッピングを素で解決できるので、ビルドを挟まずに読める（実測済み）。
 */
export async function readIncludeGlobs(root = ROOT) {
  const configPath = path.join(root, 'vitest.config.ts');
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default.test.include;
}

function collectFiles(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/** repo 全体を走査し、`includeGlobs` に一致するファイルの相対パス（`/` 区切り）を返す。 */
export function collectMatchingTestFiles(root, includeGlobs) {
  const all = [];
  collectFiles(root, root, all);
  return all.filter((f) => includeGlobs.some((g) => path.matchesGlob(f, g)));
}

/** 相対パスの配列を `{ path, content }` へ読み込む（`findUnconditionalSkips` の入力形）。 */
export function readFilesForScan(root, relPaths) {
  return relPaths.map((p) => ({ path: p, content: readFileSync(path.join(root, p), 'utf8') }));
}

/**
 * 歯Bを実際に1回分回す（I/O込みの薄い合成）。`test.mjs` はこれを呼ぶだけにする。
 *
 * `readIncludeGlobs` が例外を投げた場合・`include` が配列でない/空だった場合も
 * `judgeStaticSkipScan([], [])` と同じ「判定できない」（`EXIT_SCAN_EMPTY`）へ倒す
 * ——「見ていない」の入口を1つに絞る。
 */
export async function runStaticSkipGuard(root = ROOT) {
  let includeGlobs;
  try {
    includeGlobs = await readIncludeGlobs(root);
  } catch (err) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message:
        `test-guard: 判定できない — root の vitest.config.ts から include を読めなかった: ` +
        `${err?.message ?? err}`,
    };
  }
  if (!Array.isArray(includeGlobs) || includeGlobs.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message:
        'test-guard: 判定できない — vitest.config.ts の test.include が配列でない、または空だった。',
    };
  }
  const matchedPaths = collectMatchingTestFiles(root, includeGlobs);
  const files = readFilesForScan(root, matchedPaths);
  const hits = findUnconditionalSkips(files);
  return judgeStaticSkipScan(matchedPaths, hits);
}

/** 今日の日付を `'YYYY-MM-DD'`（UTC）で作る。**I/O 層でだけ呼ぶ**——
 * `runObservationGuard` の既定引数の中だけで使い、`findObservationDebts` /
 * `judgeObservationScan` などの純粋関数の中では絶対に呼ばない。 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 歯Cを実際に1回分回す（I/O込みの薄い合成）。`test.mjs` はこれを呼ぶだけにする。
 * `readIncludeGlobs` / `collectMatchingTestFiles` / `readFilesForScan` は歯Bと
 * 完全に共用する——再実装しない（同じ include glob・同じ走査で「観測用テスト」
 * を名乗ったファイルだけを絞り込む）。
 *
 * `today` は引数で受ける（既定値だけがここで `new Date()` を呼ぶ）。呼び出し側
 * （`test.mjs`）は素の呼び出し（`runObservationGuard(ROOT)`）でよい。
 */
export async function runObservationGuard(root = ROOT, today = todayUtc()) {
  let includeGlobs;
  try {
    includeGlobs = await readIncludeGlobs(root);
  } catch (err) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message:
        `test-guard: 判定できない — root の vitest.config.ts から include を読めなかった: ` +
        `${err?.message ?? err}`,
    };
  }
  if (!Array.isArray(includeGlobs) || includeGlobs.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message:
        'test-guard: 判定できない — vitest.config.ts の test.include が配列でない、または空だった。',
    };
  }
  const matchedPaths = collectMatchingTestFiles(root, includeGlobs);
  const files = readFilesForScan(root, matchedPaths);
  const debts = findObservationDebts(files, today);
  return judgeObservationScan(matchedPaths, debts);
}
