/**
 * `check-base-overlap.mjs` の判定だけを切り出したもの（`check-required-status-checks-core.mjs`
 * と同じ分け方・同じ理由 —— 本物の GitHub API を叩かずに、合成した応答で判定だけを
 * 確かめられるようにする）。**このファイルはネットワークもファイル I/O も持たない。**
 *
 * ## 何を塞ぐために在るか（Issue #838）
 *
 * PR の base が古いまま放置されると、「PR の diff の外で main が変わった」ことに
 * レビューアもマージ担当者も気づけない。とくに **merge base 以降に main へ入った
 * 変更が、この PR と同じファイルを触っていた場合**——PR のブランチ上のテストは
 * 通っていても、mainへ実際にマージされた瞬間の内容は誰も検証していない。
 *
 * **この歯が赤くするのは「base が古い」ことそのものではない。** ただ古いだけで
 * ファイルが重ならないなら、rebase を強制する理由が無い（無関係な merge を
 * 挟むたびに全 PR が赤くなる、というほうがよほど摩擦になる）。赤くするのは
 * **「古い」かつ「同じファイルを触られた」の両方が成り立つときだけ**である。
 *
 * ## compare API の向き（実測で確定。推測ではない）
 *
 * `GET /repos/{owner}/{repo}/compare/{A}...{B}` の `files` は常に
 * `merge_base(A,B)` から `B` への差分。`behind_by` は「A に在って B に無い
 * コミット数」、`ahead_by` はその逆。`merge_base_commit.sha` は向きを変えても
 * 同じ値。
 *
 * ⟹ `compare/{base}...{head}`（第2引数が head）で、`behind_by`（PR がどれだけ
 * 古いか）・`files`（PR が触るファイル）・`merge_base_commit.sha` が1回の呼び出しで
 * 全部取れる。`gh pr view --json files` の `files[].path` と件数・順序・中身まで
 * 一致することも実測済み。
 *
 * ⟹ `compare/{mergeBase}...{base}` で、merge base 以降に main（base ブランチ）へ
 * 入った `files` と `commits` が取れる（`merge_base(mergeBase, base)` は
 * `mergeBase` 自身なので、これは「mergeBase から base までに入った全部」になる）。
 *
 * ## 4値の verdict（3値にしない理由は `contextsFromProtection` / `unreadable` と同じ）
 *
 * | verdict | 意味 | 終了コード |
 * |---|---|---|
 * | `fresh` | `behindBy === 0` | 0 |
 * | `no-overlap` | 古いが重なりが0（打ち切りも無し） | 0 |
 * | `overlap` | 重なった | 1 |
 * | `unmeasurable` | 打ち切り、または API が読めなかった | 1 |
 *
 * **`overlap` と `unmeasurable` は同じ終了コード1だが、出力の文言は別にする。**
 * `unmeasurable` を `no-overlap`（＝緑）へ丸めることは絶対にしない —— それは
 * この Issue が潰そうとしている事故そのものの形である（「測れなかった」を
 * 「問題ない」に読み替えて見逃す）。
 *
 * ## 300件打ち切りの扱い（決定済み。fail closed）
 *
 * 実測で確定: compare の `files` は300件で切れる。`per_page`/`page` を付けても
 * `files` はページングされない（`page>=2` は `files: []` を返す）。`Link`
 * ヘッダも総件数フィールドも無い。
 *
 * **決定: `files.length >= {@link FILES_TRUNCATION_LIMIT}` なら「測れなかった」
 * として赤くする。`.diff` 形式へのフォールバックは作らない。**
 *
 * 理由:
 * - 「測れなかった」を「重なり0」に丸めるのは、この Issue が潰そうとしている
 *   事故そのものの形である（`check-required-status-checks-core.mjs` が
 *   `unreadable` を `match` に丸めないのと同じ理由）
 * - `Accept: application/vnd.github.v3.diff` なら300の上限を受けずに全ファイルが
 *   返ることは実測済み（542件で確認）。**採らなかったのは、`diff --git a/... b/...`
 *   の行はパスに空白が含まれると a/ と b/ の切れ目が一意に決まらず、パーサが
 *   黙って取りこぼす経路を新しく作るからである。** 静かに間違える歯を足すより、
 *   測れないと言って赤くするほうが良い
 * - 実測: この repo の `main` は30マージで106ファイルしか動いていない
 *   （`git diff --name-only HEAD~30 HEAD | wc -l` = 106）。⟹ 300件に達するには
 *   80マージ以上遅れる必要があり、ふだんの摩擦にはならない
 * - 逃げ道は失敗メッセージに書く: `gh api -H 'Accept: application/vnd.github.v3.diff'
 *   repos/<repo>/compare/<a>...<b>` で手で数えられる
 * - ⚠ `files.length === 300` は「ちょうど300件変更した」場合と区別できない
 *   （偽陽性がありうる）。**これもこの検査が言えないことである。**
 *
 * 判定の順番は「重なり → 打ち切り」の順（重なりが見つかっているなら、打ち切って
 * いても答えは赤で、より具体的なメッセージが出せるため）。
 *
 * ## PR番号の抽出（コミットメッセージの1行目だけを見る）
 *
 * squash-merge のコミットメッセージは `... (#NNN)` を1行目の**行末に半角括弧**で
 * 持つ。本文中の全角括弧の issue 参照（`（#832 #833）`）と混ざるので、1行目の
 * **行末アンカー＋半角括弧**で拾う（`PR_NUMBER_RE`）。
 *
 * ## 帰属（attribution）が言えないことがある
 *
 * `compare/{mergeBase}...{base}` の `commits` は既定250件で切れる（`files` と
 * 違って `per_page`/`page` でページングできるが、このスクリプトはそこまでは
 * しない —— behind_by が大きいほど main 側 commit を1件ずつ `gh api
 * repos/.../commits/{sha}` で引く回数が増えるため、全件を必ず取り切る形には
 * していない）。⟹ overlap したファイルの持ち主が、取得できた commit の中に
 * 見つからないことがある。**そのときは黙って何も出さず消すのではなく、
 * `(帰属不明)` と明示する。**
 */

/** compare API の `files` が打ち切られる件数（実測。ページングでは越えられない）。 */
export const FILES_TRUNCATION_LIMIT = 300;

/** コミットメッセージの1行目の**行末**にある半角括弧の `(#NNN)` だけを拾う。 */
const PR_NUMBER_RE = /\(#(\d+)\)\s*$/;

/** コミットメッセージの1行目を取り出す。 */
export function firstLine(message) {
  if (typeof message !== 'string') return '';
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}

/**
 * コミットメッセージから、squash-merge が付ける PR 番号を取り出す。
 *
 * **1行目だけを見て、行末アンカーで拾う。** 本文中に全角括弧の issue 参照
 * （`（#832 #833）`）が混ざっても、それは ASCII の `(` `)` ではないので
 * 引っかからない。1行目に半角括弧の `(#NNN)` が複数在っても、行末に位置する
 * もの（squash-merge が最後に足す本物の PR 番号）だけを拾う。
 *
 * 見つからなければ `null`（＝「拾えなかった」。0 や空文字にしない —— 0 は
 * 存在しない PR 番号ではないので、`null` と区別できないと「PR #0」のような
 * 嘘が出力に混ざりかねない）。
 */
export function extractPrNumber(message) {
  const match = PR_NUMBER_RE.exec(firstLine(message));
  return match === null ? null : Number(match[1]);
}

/** 2つのパス集合の積を、ソートして返す（順序に依存しない突き合わせにする）。 */
export function intersectFiles(a, b) {
  const setB = new Set(b);
  return [...new Set(a.filter((path) => setB.has(path)))].sort();
}

/**
 * 判定そのもの。**ネットワークの結果（既に取得済みのデータ）だけを受け取る。**
 *
 * @param {object} input
 * @param {{behindBy: number, files: string[], mergeBase: string} | null} input.first
 *   `compare/{base}...{head}` の結果。`null` は「読めなかった」（`gh api` が
 *   失敗した）。
 * @param {{files: string[]} | null | undefined} input.second
 *   `compare/{mergeBase}...{base}` の結果。`first.behindBy === 0` のときは
 *   呼ばれない設計なので `undefined` でよい。`null` は「読めなかった」。
 *
 * **`unreadable` を `no-overlap`（＝緑）に丸めない。** どちらの compare 呼び出しが
 * 読めなかったかで `reason` を分け、メッセージ側でどちらの API が失敗したかを
 * 言えるようにする。
 */
export function decideVerdict({ first, second }) {
  if (first === null) {
    return {
      verdict: 'unmeasurable',
      reason: 'unreadable-head',
      behindBy: null,
      mergeBase: null,
      overlap: [],
      prFilesCount: null,
      mainFilesCount: null,
      truncated: false,
    };
  }

  if (first.behindBy === 0) {
    return {
      verdict: 'fresh',
      reason: null,
      behindBy: 0,
      mergeBase: first.mergeBase,
      overlap: [],
      prFilesCount: first.files.length,
      mainFilesCount: null,
      truncated: false,
    };
  }

  if (second === null || second === undefined) {
    return {
      verdict: 'unmeasurable',
      reason: 'unreadable-main',
      behindBy: first.behindBy,
      mergeBase: first.mergeBase,
      overlap: [],
      prFilesCount: first.files.length,
      mainFilesCount: null,
      truncated: false,
    };
  }

  const overlap = intersectFiles(first.files, second.files);
  const truncated =
    first.files.length >= FILES_TRUNCATION_LIMIT || second.files.length >= FILES_TRUNCATION_LIMIT;

  if (overlap.length > 0) {
    return {
      verdict: 'overlap',
      reason: null,
      behindBy: first.behindBy,
      mergeBase: first.mergeBase,
      overlap,
      prFilesCount: first.files.length,
      mainFilesCount: second.files.length,
      truncated,
    };
  }

  if (truncated) {
    return {
      verdict: 'unmeasurable',
      reason: 'truncated',
      behindBy: first.behindBy,
      mergeBase: first.mergeBase,
      overlap: [],
      prFilesCount: first.files.length,
      mainFilesCount: second.files.length,
      truncated: true,
    };
  }

  return {
    verdict: 'no-overlap',
    reason: null,
    behindBy: first.behindBy,
    mergeBase: first.mergeBase,
    overlap: [],
    prFilesCount: first.files.length,
    mainFilesCount: second.files.length,
    truncated: false,
  };
}

/**
 * overlap したファイルそれぞれに、それを触った main 側のコミットを結び付ける。
 *
 * @param {string[]} overlapFiles ソート済みの重なりファイルパス
 * @param {{sha: string, message: string, files: string[]}[]} commitsWithFiles
 *   main 側の候補コミット（**呼び出し側が新しい順に並べて渡すこと**——同じ
 *   ファイルを複数のコミットが触っていた場合、最初に一致したものを採るため、
 *   最新のコミットを優先したいなら新しい順に渡す）
 *
 * 一致するコミットが見つからなければ `attributed: false` を返す（`commits` が
 * 250件で打ち切られている、または呼び出し側がその commit の `files` を
 * 取得できなかった場合にありうる）。**このとき黙って何も返さないのではなく、
 * `attributed: false` を明示すること** —— 呼び出し側（フォーマッタ）はこれを
 * `(帰属不明)` として出力する。
 */
export function attributeOverlapFiles(overlapFiles, commitsWithFiles) {
  return overlapFiles.map((path) => {
    const hit = commitsWithFiles.find((commit) => commit.files.includes(path));
    if (hit === undefined) {
      return { path, attributed: false, sha: null, prNumber: null, titleLine: null };
    }
    return {
      path,
      attributed: true,
      sha: hit.sha.slice(0, 7),
      prNumber: extractPrNumber(hit.message),
      titleLine: firstLine(hit.message),
    };
  });
}

/**
 * 「これは気付くための歯であって、不可能にするための歯ではない」という名乗り。
 *
 * `main` のブランチ保護は `strict=false`（2026-09-12実測、
 * `.github/required-status-checks.json` の同時点の観測と同じ調査）なので、この
 * 判定が出た後にも `main` は進みうる。⟹ この歯が緑でも「併合後の状態でテストが
 * 走った」ことにはならない。**overlap のメッセージには必ずこの一文を入れる**
 * ——読む人がこの歯を「止める門」だと誤解しないようにするため。
 */
export const IDENTITY_STATEMENT =
  'これは気付くための歯であって、不可能にするための歯ではない。' +
  'main のブランチ保護は strict=false（2026-09-12実測）なので、この判定が出た後にも ' +
  'main は進みうる。つまりこの歯が緑でも『併合後の状態でテストが走った』ことにはならない。';

/**
 * 判定結果を、人が読んで次の一手が決まる文へ畳む。
 *
 * @param {ReturnType<typeof decideVerdict>} result
 * @param {{repo: string, base: string, head: string, pr: number | null}} context
 * @param {ReturnType<typeof attributeOverlapFiles> | null} attributions
 *   `verdict === 'overlap'` のときだけ使う。
 */
export function formatResult(result, context, attributions) {
  const prLabel = context.pr === null ? '' : ` (#${context.pr})`;

  if (result.verdict === 'fresh') {
    return `check-base-overlap: OK — behind_by=0（PR${prLabel} は ${context.base} に追随済み）`;
  }

  if (result.verdict === 'no-overlap') {
    return (
      `check-base-overlap: OK — behind_by=${result.behindBy} だが、PR${prLabel} と ` +
      `${context.base} 側の変更に重なるファイルは無い`
    );
  }

  if (result.verdict === 'unmeasurable') {
    if (result.reason === 'truncated') {
      return [
        `check-base-overlap: NG — 判定できなかった（打ち切り）。behind_by=${result.behindBy}`,
        '【赤の意味】これは「重なりが無い」ではない。**測れていない。**',
        `compare API の files は${FILES_TRUNCATION_LIMIT}件で切れ、per_page/page でも` +
          '越えられない（ページングされない）。打ち切られた側にだけ在るファイルの重なりは' +
          'この道具からは見えない。',
        '「測れなかった」を「重なり0」に丸めることは、この歯が潰そうとしている事故そのものの' +
          '形である。だから緑ではなく赤にしている。',
        `⚠ files.length === ${FILES_TRUNCATION_LIMIT} は「ちょうど${FILES_TRUNCATION_LIMIT}件` +
          '変更した」場合と区別できない（偽陽性がありうる）。',
        `手元で数え直すなら: gh api -H 'Accept: application/vnd.github.v3.diff' ` +
          `repos/${context.repo}/compare/<a>...<b>`,
        '（`.diff` 形式は300件の上限を受けないが、パスに空白を含むファイルがあると' +
          'a/ と b/ の境界が一意に決まらず自動判定には使えないため、ここでは手で数える' +
          '逃げ道としてだけ案内する。）',
      ].join('\n');
    }

    const which =
      result.reason === 'unreadable-head' ? 'compare/base...head' : 'compare/mergeBase...base';
    return [
      `check-base-overlap: NG — 判定できなかった（API を読めなかった）: ${which}`,
      '【赤の意味】これは「重なりが無い」ではない。**読めていない。**',
      '手元で確かめるなら: gh api コマンドの詳細は check-base-overlap.mjs の呼び出しログを見よ。',
    ].join('\n');
  }

  // verdict === 'overlap'
  const lines = [
    `check-base-overlap: NG — base(${context.base}) 以降に main へ入った変更と、` +
      `この PR${prLabel} が同じファイルを触っている。behind_by=${result.behindBy}`,
    '【重なったファイル】',
  ];

  const byPath = new Map((attributions ?? []).map((a) => [a.path, a]));
  for (const path of result.overlap) {
    lines.push(`  ${path}`);
    const attribution = byPath.get(path);
    if (attribution === undefined || !attribution.attributed) {
      lines.push('    main側: (帰属不明)');
    } else {
      const pr = attribution.prNumber === null ? '(PR番号不明)' : `#${attribution.prNumber}`;
      lines.push(`    main側: ${attribution.sha} ${pr} ${attribution.titleLine}`);
    }
  }

  if (result.truncated) {
    lines.push(
      `⚠ compare の files が${FILES_TRUNCATION_LIMIT}件で打ち切られている可能性がある` +
        '（重なりは見つかったが、打ち切りの影響で他にも重なりが在るかもしれない）。',
    );
  }

  lines.push(
    `【何をすればいいか】このブランチを ${context.base} に rebase して、判定を取り直すこと。`,
  );
  lines.push(`【この歯について】${IDENTITY_STATEMENT}`);

  return lines.join('\n');
}
