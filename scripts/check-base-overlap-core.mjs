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
 * ## 2本目の軸: 「大域に効くファイル」（重なりが0でも赤くする）
 *
 * 上の「局所の重なり」だけでは足りないことが実測で分かった。**PR #839 の実測**:
 * `behind_by=4` / main 側が触ったファイル47 / PR 側が触ったファイル2 /
 * **重なり0**。この歯は `no-overlap`（緑）を出し、門は全部緑だった。
 *
 * **それでも通してはいけなかった。** PR が触った2ファイルの一方が
 * `vitest.setup.ts` で、根の vitest 設定に `setupFiles` として載っている
 * ⟹ **repo の全テストファイルに効く。** #839 はそこへ `afterEach` を足していた。
 * ⟹ main 側の47ファイルぶんに含まれる新しいテストは、その `afterEach` と
 * 一緒に**一度も走っていなかった**。
 *
 * 🔑 **ファイルは1つも重なっていない。それでも相互作用は全テストに及ぶ。**
 *
 * ⟹ 「PR が触ったファイルのうち、**どのファイルからも import されていないのに
 * repo 全体の判定を左右するもの**」を2本目の軸として足す。判定の表:
 *
 * | 入力 | 期待 |
 * |---|---|
 * | `behind > 0` ／ 重なり0 ／ PR が大域ファイルを触る | 赤（`global-change`） |
 * | `behind > 0` ／ 重なり1以上 | 赤（`overlap`。大域も当たっていれば両方出す） |
 * | `behind = 0` ／ 大域ファイルを触る | **緑**（追いついているなら問題ない） |
 * | `behind > 0` ／ 重なり0 ／ 大域ファイルを触らない | **緑**（ここを赤にしたらこの歯は使われなくなる） |
 *
 * ## 大域の一覧をハードコードしない（現物から導く）
 *
 * 固定のリストを書くと、次に足された大域ファイル（新しい `globalSetup`、新しい
 * ワークフロー）がここに現れず、**歯が黙って1本ぶん薄くなる。** だから
 * {@link deriveGlobalRules} は**現物から導いた `facts`**（ラッパが読む。core は
 * I/O を持たない）だけを材料にする。
 *
 * ### ⚠ `scripts/*` をどこで切るか（決定済み）
 *
 * **`scripts/*` を丸ごと大域にはしない。** 大域にするのは**根の `package.json` の
 * `scripts.test` が指すファイルからの相対 import の推移閉包だけ**（規則7）。
 *
 * 理由: それは「`pnpm test` が緑か赤かを決めるプログラムそのもの」であって、
 * **どのテストもそれを import していないのに全テストの判定を左右する**——これが
 * 「大域」の定義に正確に当たる。`scripts/check-web-bundle-size.mjs` のような個別の
 * 検査はこの閉包に入らないので大域ではない（**それが壊れても、壊れるのはその検査
 * 1本だけである**——`pnpm test` の全テストの判定は動かない）。
 *
 * ⟹ 「`scripts/` に在るから」ではなく「`pnpm test` の判定に載っているから」で
 * 切る。この切り方なら、`test.mjs` が新しいモジュールを import した日に、その
 * モジュールが自動でこちら側へ入る。
 *
 * ## 🔴 導出が成立しなかったら赤（fail closed）
 *
 * {@link extractVitestGlobalEntries} は**正規表現でソースを読んでいるのであって、
 * 評価しているのではない。** ⟹ `setupFiles: SETUP,` のように変数・スプレッド・
 * glob で書かれていると、1つも抜けない。**このとき「大域ファイルは無い」と言わない。**
 * 抜けなかったのは「無い」ではなく「**読めなかった**」である。300件打ち切りと
 * 同じ理由で `unmeasurable` に倒して赤くする。
 *
 * 根に vitest 設定が1つも無いときも同じ（この repo の構造が変わったという
 * ことなので、黙って軸を1本失わない）。
 *
 * ## 5値の verdict（3値にしない理由は `contextsFromProtection` / `unreadable` と同じ）
 *
 * | verdict | 意味 | 終了コード |
 * |---|---|---|
 * | `fresh` | `behindBy === 0` | 0 |
 * | `no-overlap` | 古いが、局所の重なりも大域ファイルも無い | 0 |
 * | `overlap` | 局所の重なりが在る（大域も在ればメッセージに両方出す） | 1 |
 * | `global-change` | 局所の重なりは0だが、大域ファイルを触っている | 1 |
 * | `unmeasurable` | 打ち切り／API が読めない／大域規則が導出できない | 1 |
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
 * 判定の順番は「局所の重なり → 大域 → 打ち切り」の順（どれかが見つかっているなら、
 * 打ち切っていても答えは赤で、より具体的なメッセージが出せるため）。**大域を
 * 打ち切りより先に見る**のも同じ理由——大域が当たっているなら、「測れなかった」
 * より具体的な赤（どのファイルが、なぜ大域か）が出せる。
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

/** 先頭の `./` を落として、repo 相対の形へ揃える（`./a/b.ts` と `a/b.ts` を同じものとして突き合わせるため）。 */
function normalizeRepoPath(value) {
  const slashes = String(value).replace(/\\/g, '/');
  return slashes.startsWith('./') ? slashes.slice(2) : slashes;
}

/** `setupFiles` / `globalSetup` の**キーとしての**出現を拾う（コメント中の言及も含めて当たる——`mentioned` はそれでよい）。 */
const VITEST_GLOBAL_KEY_RE = /\b(setupFiles|globalSetup)\b/g;

/** 文字列リテラル（3種のクォート）。 */
const STRING_LITERAL_RE = /'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g;

/**
 * 根の vitest 設定のソース文字列から、`setupFiles` / `globalSetup` に載っている
 * **文字列リテラル**を抜く。配列形（`setupFiles: ['./a.ts', './b.ts']`）と
 * 単一文字列形（`setupFiles: './a.ts'`）の両方を受ける。
 *
 * @returns {{entries: string[], mentioned: boolean}}
 *   `mentioned` は「`setupFiles` / `globalSetup` という語がソースに在ったか」。
 *   **`mentioned === true && entries.length === 0` は「無い」ではなく「読めなかった」**
 *   （変数・スプレッド・glob で書かれている）——呼び出し側はこれを区別して
 *   `unmeasurable` に倒すこと。`entries` と `mentioned` を分けて返すのは、
 *   `entries: []` の1値では**この2つが混ざって区別できなくなる**からである。
 *
 * ⚠ **正規表現でソースを読んでいるのであって、評価しているのではない。**
 * 計算で組み立てられた `setupFiles`（`setupFiles: SETUP` / `[...BASE, './x']`）は
 * 読めない。そのときは緑ではなく赤（`unmeasurable`）へ倒れる。
 */
export function extractVitestGlobalEntries(source) {
  if (typeof source !== 'string' || source === '') {
    return { entries: [], mentioned: false };
  }

  const mentioned = new RegExp(VITEST_GLOBAL_KEY_RE.source).test(source);
  const entries = [];

  const keyRe = new RegExp(VITEST_GLOBAL_KEY_RE.source, 'g');
  let keyMatch;
  while ((keyMatch = keyRe.exec(source)) !== null) {
    // キーの直後が `:` でなければ（コメント中の言及・別の用途）値は読まない。
    const afterKey = source.slice(keyMatch.index + keyMatch[0].length);
    const colon = /^\s*:/.exec(afterKey);
    if (colon === null) continue;

    const rest = afterKey.slice(colon[0].length).replace(/^\s+/, '');

    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close === -1) continue;
      const inner = rest.slice(1, close);
      const literalRe = new RegExp(STRING_LITERAL_RE.source, 'g');
      let literal;
      while ((literal = literalRe.exec(inner)) !== null) {
        const value = literal[1] ?? literal[2] ?? literal[3];
        if (value !== undefined && value !== '') entries.push(normalizeRepoPath(value));
      }
      continue;
    }

    const single = new RegExp(`^(?:${STRING_LITERAL_RE.source})`).exec(rest);
    if (single === null) continue;
    const value = single[1] ?? single[2] ?? single[3];
    if (value !== undefined && value !== '') entries.push(normalizeRepoPath(value));
  }

  return { entries: [...new Set(entries)], mentioned };
}

/** `from './x.mjs'` / `import('./x.mjs')` / `import './x.mjs'` の**相対**指定子。 */
const RELATIVE_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])(\.{1,2}\/[^'"`\n]+)\1/g;

/**
 * ソース文字列から相対 import の指定子だけを抜く（`node:fs` やパッケージ名は
 * 対象外——**この repo の中のファイルだけを辿りたい**ので、相対指定子で切る）。
 *
 * ⚠ ここも正規表現である。動的に組み立てられた指定子
 * （`import(pathToFileURL(configPath).href)`）は抜けない。**抜けないものは
 * 閉包に入らない**ので、規則7は「読めた範囲の閉包」であることを doc に断っておく。
 */
export function relativeImportsOf(source) {
  if (typeof source !== 'string' || source === '') return [];
  const found = [];
  const re = new RegExp(RELATIVE_IMPORT_RE.source, 'g');
  let match;
  while ((match = re.exec(source)) !== null) found.push(match[2]);
  return [...new Set(found)];
}

/** 根の `package.json` / ワークスペース定義のうち、大域として扱う名前。 */
const DEPENDENCY_ROOT_FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];

/** 根の lint / format 設定の名前の形（`rootEntries` に当てて導出する。名前を決め打ちで並べない）。 */
const LINT_FORMAT_ROOT_RE = /^(?:eslint\.config\.[^/]+|\.prettierrc.*|\.prettierignore)$/;

/** 根の型検査の土台の名前の形（同上）。 */
const TSCONFIG_ROOT_RE = /^tsconfig.*\.json$/;

/**
 * 現物から作った `facts` から、大域規則 `[{paths, why}]` を導く。**一覧を
 * ハードコードしない**——次に足された大域ファイルが自動で入る形にするため、
 * 材料は全部 `facts`（ラッパが読んだ現物）側に在る。
 *
 * @param {object} facts
 * @param {string[]} facts.rootEntries repo 直下のファイル名一覧
 * @param {string|null} facts.vitestConfigPath 根の vitest 設定（repo 相対）
 * @param {string|null} facts.vitestConfigSource そのソース
 * @param {object|null} facts.rootPackageJson 根の package.json を parse したもの
 * @param {string[]} facts.testEntryClosure `scripts.test` の入口からの相対 import の推移閉包（入口自身も含む）
 * @param {string[]} facts.workflowFiles `.github/workflows/` 配下（repo 相対）
 *
 * @returns {{rules: {paths: string[], why: string}[], undecidable: {reason: string, detail: string}|null}}
 *   **配列だけを返さない。** 「導出が成立しなかった」を呼び出し側へ渡せないと、
 *   読めなかったソースが静かに `rules: []`（＝大域ファイルは無い）に化ける——
 *   それはこの歯が潰そうとしている事故そのものの形である。`undecidable` が
 *   非 null なら {@link decideVerdict} は `unmeasurable` に倒す。
 */
export function deriveGlobalRules(facts) {
  const rules = [];
  const rootEntries = facts.rootEntries ?? [];

  // 🔴 根の vitest 設定が読めなければ、軸そのものが立たない。
  if (!facts.vitestConfigPath || typeof facts.vitestConfigSource !== 'string') {
    return {
      rules: [],
      undecidable: {
        reason: 'no-vitest-config',
        detail:
          '根に vitest 設定（vitest.config.*）が見つからないか、読めなかった。' +
          'この repo の構造が変わったということなので、黙って軸を1本失わずに赤へ倒す。',
      },
    };
  }

  const { entries, mentioned } = extractVitestGlobalEntries(facts.vitestConfigSource);

  // 🔴 語は在るのに1つも抜けなかった ＝「無い」ではなく「読めなかった」。
  if (mentioned && entries.length === 0) {
    return {
      rules: [],
      undecidable: {
        reason: 'vitest-entries-unreadable',
        detail:
          `${facts.vitestConfigPath} に setupFiles / globalSetup の語は在るのに、` +
          '文字列リテラルを1つも抜けなかった（変数・スプレッド・glob で書かれている）。' +
          '正規表現でソースを読んでいるのであって、評価しているのではない。',
      },
    };
  }

  if (entries.length > 0) {
    rules.push({
      paths: entries,
      why:
        `根の vitest 設定（${facts.vitestConfigPath}）の setupFiles / globalSetup に` +
        '名前が載っている。**どのテストファイルも import していないのに、全テストへ注入される。**',
    });
  }

  rules.push({
    paths: [facts.vitestConfigPath],
    why: '根の vitest 設定そのもの。どのテストを走らせるか（include）・別名（alias）・setupFiles を決める。',
  });

  const tsconfigs = rootEntries.filter((name) => TSCONFIG_ROOT_RE.test(name));
  if (tsconfigs.length > 0) {
    rules.push({
      paths: tsconfigs,
      why: '根の tsconfig。全ワークスペースの型検査の土台になる。',
    });
  }

  const lintFormat = rootEntries.filter((name) => LINT_FORMAT_ROOT_RE.test(name));
  if (lintFormat.length > 0) {
    rules.push({
      paths: lintFormat,
      why: '根の lint / format 設定。lint と format の判定を repo の全ファイルについて決める。',
    });
  }

  const dependencyFiles = DEPENDENCY_ROOT_FILES.filter((name) => rootEntries.includes(name));
  if (dependencyFiles.length > 0) {
    rules.push({
      paths: dependencyFiles,
      why: '根の依存とワークスペースの定義。依存の解決を全パッケージについて決める。',
    });
  }

  const workflows = facts.workflowFiles ?? [];
  if (workflows.length > 0) {
    rules.push({
      paths: workflows,
      why: '.github/workflows/ 配下。どの門が走るかを決める。',
    });
  }

  const closure = facts.testEntryClosure ?? [];
  if (closure.length > 0) {
    rules.push({
      paths: closure,
      why:
        '根の package.json の scripts.test が指すプログラム（とそこからの相対 import の推移閉包）。' +
        '**pnpm test の判定そのものである。どのテストもこれを import しないのに、緑か赤かはここが決める。**',
    });
  }

  return { rules, undecidable: null };
}

/**
 * PR が触ったファイルのうち、大域規則に当たるものを `[{path, why}]` で返す
 * （パスでソート）。**`why` を必ず持ち回る**——「このファイルが大域である」は
 * 出力を読む人にとって自明ではないので、名指しの理由が無いと赤の意味が伝わらない。
 *
 * 1つのパスが複数の規則に当たったときは、**先に書いた規則の `why` を採る**
 * （{@link deriveGlobalRules} は具体的なものから先に積んでいる）。
 */
export function globalHits(prFiles, rules) {
  const byPath = new Map();
  for (const rule of rules ?? []) {
    const paths = new Set((rule.paths ?? []).map(normalizeRepoPath));
    for (const file of prFiles ?? []) {
      const path = normalizeRepoPath(file);
      if (!paths.has(path)) continue;
      if (byPath.has(path)) continue;
      byPath.set(path, { path, why: rule.why });
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
 * @param {ReturnType<typeof deriveGlobalRules> | undefined} input.global
 *   大域規則（{@link deriveGlobalRules} の戻り値をそのまま）。**ラッパは必ず
 *   渡す**（`check-base-overlap.mjs` が facts を組み立てて渡し、I/O が失敗したら
 *   `undecidable` を立てて渡す。その配線は歯で固定してある）。省いたときは
 *   大域の軸を持たない判定になる——これは**局所の軸だけを合成データで撃つ
 *   テストのための既定**であって、本番の経路ではない。
 *
 * **`unreadable` を `no-overlap`（＝緑）に丸めない。** どちらの compare 呼び出しが
 * 読めなかったかで `reason` を分け、メッセージ側でどちらの API が失敗したかを
 * 言えるようにする。
 *
 * 判定順: `first===null` → `behindBy===0` → `second===null` → **局所の重なり**
 * → **大域** → 打ち切り → `no-overlap`。
 */
export function decideVerdict({ first, second, global: globalInput }) {
  if (first === null) {
    return {
      verdict: 'unmeasurable',
      reason: 'unreadable-head',
      behindBy: null,
      mergeBase: null,
      overlap: [],
      globalHits: [],
      globalDetail: null,
      prFilesCount: null,
      mainFilesCount: null,
      truncated: false,
    };
  }

  // behind_by = 0 なら、大域ファイルを触っていても緑である。**追いついているなら
  // 「main 側の新しいテストと一緒に走っていない」が成り立たない**——この軸が
  // 塞ぎたい事故はそこにしか無いので、ここを赤にしてはいけない。
  if (first.behindBy === 0) {
    return {
      verdict: 'fresh',
      reason: null,
      behindBy: 0,
      mergeBase: first.mergeBase,
      overlap: [],
      globalHits: [],
      globalDetail: null,
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
      globalHits: [],
      globalDetail: null,
      prFilesCount: first.files.length,
      mainFilesCount: null,
      truncated: false,
    };
  }

  const overlap = intersectFiles(first.files, second.files);
  const truncated =
    first.files.length >= FILES_TRUNCATION_LIMIT || second.files.length >= FILES_TRUNCATION_LIMIT;
  const undecidable = globalInput?.undecidable ?? null;
  const hits = undecidable === null ? globalHits(first.files, globalInput?.rules ?? []) : [];
  const common = {
    behindBy: first.behindBy,
    mergeBase: first.mergeBase,
    prFilesCount: first.files.length,
    mainFilesCount: second.files.length,
  };

  if (overlap.length > 0) {
    return {
      verdict: 'overlap',
      reason: null,
      overlap,
      globalHits: hits,
      globalDetail: undecidable,
      truncated,
      ...common,
    };
  }

  // 大域は打ち切りより**先**に見る（大域が当たっているなら、「測れなかった」より
  // 具体的な赤——どのファイルが、なぜ大域か——が出せる）。
  if (undecidable !== null) {
    return {
      verdict: 'unmeasurable',
      reason: 'global-rules-underivable',
      overlap: [],
      globalHits: [],
      globalDetail: undecidable,
      truncated,
      ...common,
    };
  }

  if (hits.length > 0) {
    return {
      verdict: 'global-change',
      reason: null,
      overlap: [],
      globalHits: hits,
      globalDetail: null,
      truncated,
      ...common,
    };
  }

  if (truncated) {
    return {
      verdict: 'unmeasurable',
      reason: 'truncated',
      overlap: [],
      globalHits: [],
      globalDetail: null,
      truncated: true,
      ...common,
    };
  }

  return {
    verdict: 'no-overlap',
    reason: null,
    overlap: [],
    globalHits: [],
    globalDetail: null,
    truncated: false,
    ...common,
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
 * 「なぜ重なりが0でも赤いのか」——#839 の形を短く。**この説明が無いと、読む人は
 * 「重なりは0だと書いてあるのに赤い」を道具の誤りとして読む。**
 */
const WHY_RED_WITHOUT_OVERLAP =
  'ファイルは1つも重なっていない。それでも相互作用は repo 全体に及ぶ: ' +
  'これらのファイルは全テスト（または全ワークスペースの型検査・lint・門の構成）に効くので、' +
  'base が古いままだと、**main 側に入った新しいテストが、この変更と一緒に走った回が一度も無い**。' +
  '実例（#839）: behind_by=4 / 重なり0 / 全部緑だったが、PR が触った vitest.setup.ts は ' +
  '根の vitest 設定の setupFiles に載っていて、そこへ足された afterEach と、' +
  'main 側の47ファイルぶんの新しいテストは、一度も同時に走っていなかった。';

/**
 * 局所の重なりも在るときに、大域の節へ添える一文。**上の文言を使い回さない**——
 * あちらは「1つも重なっていない」で始まるので、重なりが在る出力に置くと
 * その1行だけが嘘になる（読む人はそこで道具を信じなくなる）。
 */
const WHY_GLOBAL_SECTION_WITH_OVERLAP =
  '重なったファイルとは別に、これらは repo 全体に効く（全テスト、または全ワークスペースの' +
  '型検査・lint・門の構成）。**rebase 後に見直す範囲は、重なったファイルだけではない**——' +
  '大域ファイルの変更は、main 側に入った新しいテスト全部と一緒に走ったことが無い。' +
  '実例（#839）: PR が触った vitest.setup.ts は根の vitest 設定の setupFiles に載っていて、' +
  'そこへ足された afterEach と、main 側の47ファイルぶんの新しいテストは、一度も同時に走っていなかった。';

/** 当たった大域ファイルを、1行1ファイル＋`why` の形へ畳む（1つも落とさない）。 */
function globalSectionLines(hits) {
  const lines = ['【大域に効くファイル（PR が触っている）】'];
  for (const hit of hits) {
    lines.push(`  ${hit.path}`);
    lines.push(`    なぜ大域か: ${hit.why}`);
  }
  return lines;
}

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

  if (result.verdict === 'global-change') {
    const lines = [
      `check-base-overlap: NG — この PR${prLabel} は「repo 全体に効くファイル」を触っているのに、` +
        `base(${context.base}) が古い。behind_by=${result.behindBy}`,
      ...globalSectionLines(result.globalHits),
      `【なぜ重なりが0でも赤いのか】${WHY_RED_WITHOUT_OVERLAP}`,
      `【何をすればいいか】このブランチを ${context.base} に rebase して、判定を取り直すこと` +
        '（＝ main 側の新しいテストを、この変更と一緒に1回走らせること）。',
      `【この歯について】${IDENTITY_STATEMENT}`,
    ];
    if (result.truncated) {
      lines.splice(
        -2,
        0,
        `⚠ compare の files が${FILES_TRUNCATION_LIMIT}件で打ち切られている可能性がある` +
          '（大域ファイルは見つかったが、打ち切りの影響で局所の重なりも在るかもしれない）。',
      );
    }
    return lines.join('\n');
  }

  if (result.verdict === 'unmeasurable') {
    if (result.reason === 'global-rules-underivable') {
      return [
        'check-base-overlap: NG — 判定できなかった（大域規則を導出できなかった）。' +
          `behind_by=${result.behindBy}`,
        '【赤の意味】これは「大域に効くファイルは無い」ではない。**導出できていない。**',
        `詳細: ${result.globalDetail?.detail ?? '(詳細なし)'}`,
        'この検査は正規表現でソースを読んでいるのであって、評価しているのではない。' +
          '⟹ 計算で組み立てられた setupFiles / globalSetup は読めない。' +
          '**読めなかったことを「無い」と読み替えて緑にするのは、この歯が潰そうとしている' +
          '事故そのものの形である。**だから赤にしている。',
        '手元で確かめるなら: 根の vitest 設定の setupFiles / globalSetup を、' +
          "文字列リテラルの配列（例: ['./vitest.setup.ts']）で書けばここは通る。",
      ].join('\n');
    }

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

  // 局所の重なりが在るときでも、大域が当たっていれば**黙って落とさずに両方出す**
  // （rebase 後に何を見直すべきかが変わる——大域ファイルは diff の外まで効く）。
  const hitsForOverlap = result.globalHits ?? [];
  if (hitsForOverlap.length > 0) {
    lines.push(...globalSectionLines(hitsForOverlap));
    lines.push(`【この節の意味】${WHY_GLOBAL_SECTION_WITH_OVERLAP}`);
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
