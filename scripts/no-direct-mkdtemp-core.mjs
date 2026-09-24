/**
 * テストファイルが `mkdtemp` / `mkdtempSync` を**直接**呼んでいたら赤くする
 * 静的な歯（#1436 案B）の中核。`scripts/no-direct-mkdtemp.test.ts` が読む。
 *
 * ## なぜ vitest の中（このファイルが `*.test.ts` の counterpart から
 * import される先）に置いてよいのか——`test-guard-core.mjs` との違い
 *
 * `test-guard-core.mjs`（無条件の `.skip` を検出する歯）は、**判定そのものを
 * vitest の外（`test.mjs`）に置く**。歯を vitest の中に置くと `.skip` で
 * 判別器自身を黙らせられるからである。
 *
 * この歯（mkdtemp の直接呼び出し検出）には、その脆弱性が無い。
 * `describe.skip` / `it.skip` で自分自身を黙らせる手口は、**既存の
 * `test-guard-core.mjs` の歯B自身がすべてのテストファイルを走査して
 * 捕まえる**——この歯の `*.test.ts` counterpart もその走査対象の1つに
 * 過ぎない。⟹ この歯を vitest の中の普通のテスト
 * （`packages/core/src/exchange-kind-coverage.test.ts` と同じ形）として
 * 書いても、`.skip` による回避は歯Bが既に塞いでいる。二重に「vitest の
 * 外側」を作る理由が無い。
 *
 * ## 検出パターン
 *
 * `MKDTEMP_CALL_RE` は `\bmkdtemp(Sync)?\s*\(` —— 名前付き import
 * （`import { mkdtempSync } from 'node:fs'` の後で `mkdtempSync(...)`）と、
 * 名前空間・default import 経由の呼び出し（`fs.mkdtempSync(...)`）の
 * **両方**を、同じ正規表現1本で拾う。`\b` は `.` と識別子の先頭のあいだにも
 * 境界を作るので、`fs.mkdtempSync(` の `mkdtempSync(` 部分にも当たる
 * （`fs` の直後の `.` は非単語文字、`m` は単語文字なのでそこが境界になる）。
 * 動的 import 経由の分割代入（`const { mkdtempSync } = await import('node:fs')`
 * の後で呼ぶ形。実例: `apps/daemon/src/runner-client.test.ts`）も、呼び出し
 * そのものの字面が同じなので同じ正規表現で拾える。
 *
 * **import 文そのものは拾わない。** `import { mkdtempSync } from 'node:fs'`
 * のように識別子の直後が `,` や `}` のときは `\(` が続かないので当たらない
 * ——見ているのは「呼んでいるか」であって「import しているか」ではない。
 *
 * ## この歯の限界（doc に書いておく——ここが対象外）
 *
 * - **テストファイル以外の helper を経由する間接の呼び出しは対象外。**
 *   例: `railway/cli-stub.ts`（`*.test.ts` ではない）の `prepare()` が内部で
 *   `mkdtempSync` を呼び、`railway/setup.test.ts` や
 *   `railway/scale-runners.test.ts` がそれを利用する形——これはテスト
 *   ファイル自身が `mkdtemp` を呼んでいないので検出されない。歯を
 *   `*.test.ts` だけに絞っているのは、production 相当のコード
 *   （`railway/cli-stub.ts` はテスト用の偽 CLI で production コードではないが、
 *   同様に「helper 関数」という扱い）にまで検出を広げると、helper 関数の
 *   中身を書くたびに歯が誤爆するため（helper 自身は正当に `mkdtemp` を
 *   呼ってよい）。
 * - **子プロセス（シェルスクリプト等）が自分で作る一時ディレクトリも対象外**
 *   （Issue #1436 が最初から挙げていた限界。`vitest.tmpdir.ts` の doc の
 *   「子プロセスの限界」と同じ）。
 *
 * ## 許可リスト
 *
 * `ALLOWLIST` は当初「helper 導入より前からある直接呼び出し」を機械的に
 * 洗ったもの（当初52ファイル、2026-09-24 時点、PR #1437 マージ後の `main` 上で
 * 洗い直した）。移行は3本の PR に分けて段階的にやると決めた（PR 本文に理由を
 * 書く）。理由は1ファイル1行、そのファイルがいま実際にどう後片付けして
 * いるかを現物で確かめて書いた。**1本目の PR（packages/core/ の18件）で
 * 34ファイルへ、2本目の PR（apps/cli・apps/daemon・apps/runner・
 * packages/storage-fs の16件）で18ファイルへ、3本目の PR（scripts/・
 * .github/scripts/・docker/・railway/ の18件）で0件へ減った。**
 * ⟹ **2026-09-24 時点で `ALLOWLIST` は空である。** 許可リストに無いファイルで
 * 新しく直接呼び出しが増えたら、この歯が即座に赤くなる。
 *
 * **許可リストは古びたら赤くする。** 許可リストに載っているのに実際には
 * もう直接呼んでいないファイル（＝移行が済んだ）が残っていると、
 * `judgeMkdtempScan` の「stale」判定でこの歯自身が赤くなる。空になった今も、
 * この判定そのものは生きている——将来また正当な理由で許可リストへ書き戻す
 * ファイルが出たときに、消し忘れがあれば同じ仕組みで気づける。
 */

/** 名前付き呼び出し（`mkdtemp(` / `mkdtempSync(`）と名前空間呼び出し
 * （`fs.mkdtempSync(`）の両方を、1本の正規表現で拾う（doc 参照）。 */
const MKDTEMP_CALL_RE = /\bmkdtemp(Sync)?\s*\(/g;

/**
 * `files`（`{ path, content }` の配列）を走査し、直接呼び出しの箇所を返す。
 * ディスクを読まない純粋関数——合成した文字列でも試せる
 * （`test-guard-core.mjs` の `findUnconditionalSkips` と同じ作法）。
 */
export function findDirectMkdtempCalls(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      MKDTEMP_CALL_RE.lastIndex = 0;
      const m = MKDTEMP_CALL_RE.exec(lines[i]);
      if (m) {
        hits.push({ path: file.path, line: i + 1, matched: m[0].trim() });
      }
    }
  }
  return hits;
}

/** 歯が落ちたときの文言（許可リストに無い直接呼び出し）。 */
export function formatMkdtempGuardMessage(violations) {
  const lines = violations.map((h) => `  ${h.path}:${h.line}  ${h.matched}`);
  return [
    `no-direct-mkdtemp: 許可リストに無い直接呼び出しが ${violations.length} 件見つかった:`,
    ...lines,
    '',
    'テストファイルから mkdtemp / mkdtempSync を直接呼ばず、',
    'vitest.tmpdir.ts の makeTempDir / makeTempDirSync を使うこと。',
    '（本番コードの挙動そのものを確かめるテストなど、正当な理由があるなら',
    ' scripts/no-direct-mkdtemp-core.mjs の ALLOWLIST へ理由つきで追加する。）',
  ].join('\n');
}

/** 歯が落ちたときの文言（許可リストが古びている＝もう直接呼んでいない）。 */
export function formatStaleAllowlistMessage(stalePaths) {
  return [
    `no-direct-mkdtemp: 許可リストに載っているが、もう直接呼び出しが無いファイルが ${stalePaths.length} 件ある:`,
    ...stalePaths.map((p) => `  ${p}`),
    '',
    '移行が済んだ（helper へ寄せた、または呼び出し自体を消した）なら、',
    'scripts/no-direct-mkdtemp-core.mjs の ALLOWLIST からその行を消すこと。',
    '許可リストを実態より広いまま残すと、次に何が移行済みかが分からなくなる。',
  ].join('\n');
}

/**
 * 歯の最終判定。3値: `matchedPaths.length === 0` → 判定できない /
 * 許可リストに無い hit が在る → 検出 / 許可リストが古びている → 検出 /
 * それ以外 → 合格。ディスクを読まない純粋関数。
 */
export function judgeMkdtempScan(matchedPaths, hits, allowlist) {
  if (matchedPaths.length === 0) {
    return {
      ok: false,
      kind: 'scan-empty',
      message: [
        'no-direct-mkdtemp: 判定できない — 走査対象が0ファイルだった。',
        'root の vitest.config.ts の include に一致するテストファイルが1件も見つからない。',
        'include の glob 展開に失敗した、走査の起点がずれた、などが疑われる',
        '（test-guard-core.mjs の EXIT_SCAN_EMPTY と同じ状態）。',
      ].join('\n'),
    };
  }

  const violations = hits.filter((h) => !allowlist.has(h.path));
  if (violations.length > 0) {
    return { ok: false, kind: 'violation', message: formatMkdtempGuardMessage(violations) };
  }

  const hitPaths = new Set(hits.map((h) => h.path));
  const stalePaths = [...allowlist.keys()].filter((p) => !hitPaths.has(p));
  if (stalePaths.length > 0) {
    return { ok: false, kind: 'stale-allowlist', message: formatStaleAllowlistMessage(stalePaths) };
  }

  return { ok: true, scanned: matchedPaths.length, allowlisted: allowlist.size };
}

/**
 * 許可リスト（相対パス → 理由）。3本の PR に分けて段階的に移した
 * （1本目 #1441 で packages/core/ の18件、2本目 #1443 で apps/cli・
 * apps/daemon・apps/runner・packages/storage-fs の16件、3本目で
 * scripts/・.github/scripts/・docker/・railway/ の残り18件を helper へ移した）。
 * **2026-09-24 時点で ALLOWLIST は空。** 新しく直接呼び出しを書いたテスト
 * ファイルは、理由の有無を問わずこの歯へ即座に引っかかる——`vitest.tmpdir.ts`
 * の `makeTempDir` / `makeTempDirSync` を使うこと。
 *
 * `packages/storage-fs/src/index.test.ts`（1本目 #1441）や
 * `scripts/mutate-delivery-scaffold-leftover.test.ts`（3本目、このファイル
 * 自身の逐語）のように、**一時ディレクトリの後片付けとは別の理由で**
 * `mkdtemp` 系の呼び出しではない `rm()` / `setRootOverride()` 等を残した
 * 箇所はある——それらはこの歯の対象外（`mkdtemp` / `mkdtempSync` の呼び出し
 * そのものではないため）なので、ALLOWLIST に載せる理由にはならない。
 *
 * 本番コードの mkdtemp の挙動そのものを確かめるテストなど、helper に
 * 移せない正当な理由が今後出てきたら、そのファイル固有の事実を添えて
 * ここへ書き戻すこと（`formatMkdtempGuardMessage` の案内と同じ）。
 */
export const ALLOWLIST = new Map([]);
