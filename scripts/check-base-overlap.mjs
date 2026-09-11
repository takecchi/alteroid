#!/usr/bin/env node
/**
 * PR の base が古く、かつ (a) merge base 以降に main へ入った変更がこの PR と
 * 同じファイルを触っている（局所の重なり）か、(b) この PR が **repo 全体に効く
 * ファイル**を触っている（大域）ときに赤くする（Issue #838・#839 の実測）。
 *
 * **判定ロジックはここに置かない。** `check-base-overlap-core.mjs` が正本で、
 * compare API の向きの実測・5値の verdict・300件打ち切りの扱い・PR番号抽出・
 * **大域規則をハードコードせず現物から導く理由**はあちらの doc に書いてある。
 * ここはネットワーク（`gh api`）と**ファイル I/O**（大域規則の材料 `facts` を
 * 現物から読む）を持ち、結果を出力し、終了コードを決めるだけの薄い層。
 *
 * ## なぜラッパ側が現物を読むのか
 *
 * core は**ネットワークもファイル I/O も持たない**（合成データだけで判定を
 * 撃てるようにするため）。⟹ 「repo 直下に何が在るか」「根の vitest 設定に
 * 何が書いてあるか」「`pnpm test` がどのファイルから始まるか」を読むのは
 * ここの仕事で、core へは `facts`（読み終えた値）だけを渡す。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: いま呼ばれた時点の `base`/`head`/main の状態から、
 *   「base 以降に main へ入った変更」と「この PR が触るファイル」が重なって
 *   いるか。重なっていれば、どの main 側コミットが原因かも（拾えた範囲で）。
 *   加えて、PR が触ったファイルが**現物から導いた大域規則**に当たるか。
 * - **言えないこと**: **将来 main が進んだ後もこの判定が有効か。** `main` の
 *   ブランチ保護は `strict=false`（2026-09-12実測）なので、この判定の直後にも
 *   main は進みうる。⟹ 緑は「いま測った時点で重ならなかった」だけを言う。
 * - **言えないこと（大域の側）**: **正規表現でソースを読んでいるのであって、
 *   評価しているのではない。** 計算で組み立てられた `setupFiles`
 *   （`setupFiles: SETUP` / `[...BASE, './x']`）は読めない。**そのときは緑には
 *   ならず、`unmeasurable`（赤）へ倒れる。** 同じ理由で、動的に組み立てられた
 *   `import()` は規則7の閉包に入らない（閉包は「読めた範囲」である）。
 * - **書き換えない。** 読むだけである。
 *
 * ## 入力
 *
 * 環境変数を既定にし、コマンドライン引数（`--flag value` / `--flag=value`）で
 * 上書きできる（手元で叩けるようにするため）。
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 * | `--base` | `GITHUB_BASE_REF` | PR の base ブランチ名（例: `main`） |
 * | `--head` | `BASE_OVERLAP_HEAD_SHA` | PR の head の sha。**このスクリプトが決めた名前**——`GITHUB_SHA` は pull_request イベントでは merge commit の sha であって head そのものではないため、ワークフロー側で `github.event.pull_request.head.sha` を明示的にこの名前で渡す |
 * | `--pr` | `BASE_OVERLAP_PR_NUMBER` | PR 番号（メッセージに出すだけ。任意） |
 * | `--repo-root` | （既定 `process.cwd()`） | 大域規則の材料を読む repo の根。テストと手元確認のために切り替えられる |
 *
 * `--repo` / `--base` / `--head` が1つでも欠けたら、**黙って緑にしない。**
 * これは「PR の文脈で呼ばれなかった」ではなく「呼び方が誤っている」として
 * 扱う（終了コード1、`unmeasurable` にはしない——`unmeasurable` は「読もうと
 * したが読めなかった」用の値で、こちらは「読みに行くための情報が最初から
 * 無い」なので別の失敗として扱うほうが筋が良い）。**「PR 以外では走らせない」
 * のはワークフロー側の `if:` が担保する**（`ci.yml` の `base-overlap` ジョブの
 * doc）。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | `fresh` | 0 |
 * | `no-overlap` | 0 |
 * | `overlap` | 1 |
 * | `global-change` | 1 |
 * | `unmeasurable` | 1 |
 * | （引数不足） | 1 |
 *
 * `overlap` / `global-change` / `unmeasurable` は同じ1だが、出力の文言は別である
 * （`check-required-status-checks.mjs` と同じ方針）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  attributeOverlapFiles,
  decideVerdict,
  deriveGlobalRules,
  formatResult,
  relativeImportsOf,
} from './check-base-overlap-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` と `--flag=value` の両方を受ける、この用途に足るだけの簡易パーサ。 */
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = '';
    }
  }
  return result;
}

/**
 * `gh api repos/{repo}/compare/{a}...{b}` を叩き、判定に要る形へ畳む。
 *
 * **例外は握り潰すが、中身（stderr）は捨てない**（`check-required-status-checks.mjs`
 * の `fetchProtection()` と同じ形）。読めなかった理由（401/403/ネットワーク/
 * 存在しない ref）は、次の一手を決める材料そのものである。
 */
function fetchCompare(repo, a, b) {
  try {
    const stdout = execFileSync('gh', ['api', `repos/${repo}/compare/${a}...${b}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const json = JSON.parse(stdout);
    const files = Array.isArray(json.files) ? json.files.map((f) => f.filename) : [];
    const commits = Array.isArray(json.commits)
      ? json.commits.map((c) => ({ sha: c.sha, message: c.commit?.message ?? '' }))
      : [];
    const mergeBase = json.merge_base_commit?.sha ?? null;
    return {
      data: { behindBy: json.behind_by, files, mergeBase, commits },
      error: null,
    };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

/** `gh api repos/{repo}/commits/{sha}` からその1コミットが触ったファイル名一覧を取る。 */
function fetchCommitFiles(repo, sha) {
  try {
    const stdout = execFileSync('gh', ['api', `repos/${repo}/commits/${sha}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const json = JSON.parse(stdout);
    return Array.isArray(json.files) ? json.files.map((f) => f.filename) : [];
  } catch {
    // 読めなかった1コミットは「そのコミットは無かったことにする」——帰属が
    // 付かないファイルは `attributeOverlapFiles` 側で `(帰属不明)` になる。
    return null;
  }
}

/**
 * overlap したファイルの持ち主を、main 側コミットを新しい順に1件ずつ引きながら
 * 探す。**必要な分だけ叩く**——overlap 済みファイル全部の帰属が付いた時点で
 * 打ち切る（behind_by が大きいほど commits も多くなりうるので、無条件に
 * 全件を引かない）。
 *
 * `commits` は `compare/{mergeBase}...{base}` の応答順（古い→新しいが実測での
 * 既定）を前提に、ここで新しい順へ並べ替えてから使う。
 */
function attributeLazily(repo, overlapFiles, commits) {
  const remaining = new Set(overlapFiles);
  const commitsWithFiles = [];
  const newestFirst = [...commits].reverse();
  for (const commit of newestFirst) {
    if (remaining.size === 0) break;
    const files = fetchCommitFiles(repo, commit.sha);
    if (files === null) continue;
    commitsWithFiles.push({ sha: commit.sha, message: commit.message, files });
    for (const path of files) remaining.delete(path);
  }
  return attributeOverlapFiles(overlapFiles, commitsWithFiles);
}

/**
 * 規則7の閉包を辿るときの上限（ファイル数と深さ）。**上限に当たったら黙って
 * 打ち切らず `unmeasurable` へ倒す**——途中で切った閉包は「大域ファイルの
 * 一覧」を名乗れない（切られた先に在ったファイルが静かに緑になる）。
 */
const CLOSURE_FILE_LIMIT = 200;
const CLOSURE_DEPTH_LIMIT = 20;

/** 根の vitest 設定の名前の形（`vitest.config.ts` / `.js` / `.mts` …）。 */
const VITEST_CONFIG_RE = /^vitest\.config\.[cm]?[jt]s$/;

/** `scripts.test` のコマンド文字列から、入口になりうるファイルパスを拾う。 */
function entryPathsFromTestScript(command) {
  if (typeof command !== 'string') return [];
  const found = [];
  const re = /(?:^|\s)((?:\.{0,2}\/)?[\w.@/-]+\.(?:mjs|cjs|js|mts|cts|ts))(?=\s|$)/g;
  let match;
  while ((match = re.exec(command)) !== null) found.push(match[1]);
  return [...new Set(found)];
}

/** repo 相対のパス候補を、実在するファイルへ解く（拡張子が省かれている場合も少しだけ見る）。 */
function resolveExisting(repoRoot, relative) {
  const candidates = [relative, ...['.mjs', '.js', '.ts', '.mts', '.cjs'].map((e) => relative + e)];
  for (const candidate of candidates) {
    if (candidate.startsWith('..')) continue; // repo の外は追わない
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  return null;
}

/**
 * 根の `package.json` の `scripts.test` が指すファイルから、相対 import の
 * **推移閉包**を BFS で作る（入口自身も含む。repo 相対パス）。
 *
 * - **存在するファイルだけ**を入れる（動的に組み立てられた指定子は読めないので
 *   入らない——それはこの道具が言えないことである）
 * - 訪問済み集合を持つので**循環に耐える**
 * - 上限（`CLOSURE_FILE_LIMIT` / `CLOSURE_DEPTH_LIMIT`）に当たったら例外を投げ、
 *   呼び出し側が `unmeasurable` へ倒す
 */
function buildTestEntryClosure(repoRoot, rootPackageJson) {
  const command = rootPackageJson?.scripts?.test;
  const entries = entryPathsFromTestScript(command)
    .map((value) => resolveExisting(repoRoot, value.replace(/^\.\//, '')))
    .filter((value) => value !== null);

  if (entries.length === 0) {
    throw new Error(
      '根の package.json の scripts.test から、実在する入口ファイルを1つも取れなかった' +
        `（scripts.test = ${JSON.stringify(command ?? null)}）。` +
        '規則7（pnpm test の判定そのもの）を導けないので、黙って軸を1本失わずに赤へ倒す。',
    );
  }

  const seen = new Set(entries);
  let frontier = entries;
  let depth = 0;

  while (frontier.length > 0) {
    if (depth++ > CLOSURE_DEPTH_LIMIT) {
      throw new Error(
        `scripts.test の入口からの import を ${CLOSURE_DEPTH_LIMIT} 段まで辿っても終わらなかった。` +
          '途中で切った閉包は「大域ファイルの一覧」を名乗れないので赤へ倒す。',
      );
    }
    const next = [];
    for (const current of frontier) {
      const source = readFileSync(path.join(repoRoot, current), 'utf8');
      const dir = path.posix.dirname(current.split(path.sep).join('/'));
      for (const specifier of relativeImportsOf(source)) {
        const joined = path.posix.normalize(path.posix.join(dir, specifier));
        const resolved = resolveExisting(repoRoot, joined);
        if (resolved === null || seen.has(resolved)) continue;
        seen.add(resolved);
        next.push(resolved);
        if (seen.size > CLOSURE_FILE_LIMIT) {
          throw new Error(
            `scripts.test の入口からの閉包が ${CLOSURE_FILE_LIMIT} ファイルを越えた。` +
              '途中で切った閉包は「大域ファイルの一覧」を名乗れないので赤へ倒す。',
          );
        }
      }
    }
    frontier = next;
  }

  return [...seen].sort();
}

/**
 * 現物を読んで `facts` を組み立て、core に大域規則を導かせる。
 *
 * **I/O が失敗したら黙って空にしない。** 空の `facts` は「大域ファイルは無い」
 * と区別が付かない ＝ 読めなかったことを緑に読み替える形になる。⟹ 例外は
 * `undecidable` として返し、`decideVerdict` が `unmeasurable`（赤）に倒す。
 */
function buildGlobalRules(repoRoot) {
  try {
    const rootEntries = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    const vitestConfigPath = rootEntries.find((name) => VITEST_CONFIG_RE.test(name)) ?? null;
    const vitestConfigSource =
      vitestConfigPath === null
        ? null
        : readFileSync(path.join(repoRoot, vitestConfigPath), 'utf8');

    const rootPackageJson = rootEntries.includes('package.json')
      ? JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      : null;

    const workflowsDir = path.join(repoRoot, '.github', 'workflows');
    const workflowFiles = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `.github/workflows/${entry.name}`)
      .sort();

    return deriveGlobalRules({
      rootEntries,
      vitestConfigPath,
      vitestConfigSource,
      rootPackageJson,
      testEntryClosure: buildTestEntryClosure(repoRoot, rootPackageJson),
      workflowFiles,
    });
  } catch (error) {
    return {
      rules: [],
      undecidable: {
        reason: 'facts-unreadable',
        detail: `大域規則の材料（現物）を読めなかった: ${error?.message ?? String(error)}`,
      },
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';
  const base = args.base || process.env.GITHUB_BASE_REF || '';
  const head = args.head || process.env.BASE_OVERLAP_HEAD_SHA || '';
  const prRaw = args.pr || process.env.BASE_OVERLAP_PR_NUMBER || '';
  const pr = /^\d+$/.test(prRaw) ? Number(prRaw) : null;

  if (repo === '' || base === '' || head === '') {
    logError(
      'check-base-overlap: 呼び方の誤り — --repo/--base/--head（または ' +
        'GITHUB_REPOSITORY/GITHUB_BASE_REF/BASE_OVERLAP_HEAD_SHA）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の if: が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const context = { repo, base, head, pr };

  const firstRaw = fetchCompare(repo, base, head);
  const first = firstRaw.data;

  let secondRaw = null;
  let second = null;
  if (first !== null && first.behindBy !== 0) {
    secondRaw = fetchCompare(repo, first.mergeBase, base);
    second = secondRaw.data;
  }

  // 大域規則は**現物**から導く（一覧をハードコードしない）。`--repo-root` で
  // 読む先を切り替えられる（テストと手元確認のため）。
  const repoRoot = args['repo-root'] || process.cwd();
  const globalRules = buildGlobalRules(repoRoot);

  const result = decideVerdict({ first, second, global: globalRules });

  let attributions = null;
  if (result.verdict === 'overlap') {
    attributions = attributeLazily(repo, result.overlap, second.commits);
  }

  const text = formatResult(result, context, attributions);

  if (result.verdict === 'fresh' || result.verdict === 'no-overlap') {
    log(text);
    return;
  }

  logError(text);
  if (result.reason === 'unreadable-head' && firstRaw.error !== null) {
    logError(`  gh の出力 (compare/${base}...${head}): ${firstRaw.error}`);
  }
  if (result.reason === 'unreadable-main' && secondRaw !== null && secondRaw.error !== null) {
    logError(`  gh の出力 (compare/${first.mergeBase}...${base}): ${secondRaw.error}`);
  }
  process.exitCode = 1;
}

main();
