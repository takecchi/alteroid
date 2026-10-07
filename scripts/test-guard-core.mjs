// この判定を vitest の中（テストや `setupFiles`）に置かない: 置くと `.skip` で判別器自身を黙らせられるため。`test.mjs`（vitest の外側の素の node プロセス）がここを呼ぶ。
// 歯A・歯B・歯C は 2 値にしない: 走査対象 0 件（見ていない）・申告不備・期限超過を、無条件の skip が 0 件・合格と混ぜないため（`AGENTS.md`「『判定できない』という3つ目の状態を持つ」）。
// 歯C は名乗ったファイルだけを対象にする: 散文の「観測」は別の意味で使われており、誤検出になるため。名乗りはパスの慣習 `.observed.` / `.scratch.` / `-scratch.` と冒頭コメントの `@観測` の 2 形だけ。
// ## 変異試験ハーネスとの関係: `decideJudgementCategory` は `testResult.exitCode` を見ず集計行の文字列だけで判定するため、この歯が足す exit 1 は集計行を書き換えない限り「検出」に化けない。

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

// `process.cwd()` に依存しない: `pnpm --filter <pkg> test` では cwd がそのパッケージ配下になるため。
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

// 位置を問わずすべての素の `--` を落とす: pnpm が `--` ごと渡し、vitest は `--` より後ろを読まないため、絞り込みが効かずスイート全体が走る。
export function dropBareDashDash(argv) {
  return argv.filter((arg) => arg !== '--');
}

// 範囲を位置引数でなく named 引数で渡す: vitest の位置引数は OR で効き、利用者が足した絞り込みよりパッケージ全体の範囲が常に勝つため。
export const SCOPE_FLAG = '--scope';

export function extractScope(argv) {
  const scopePrefix = SCOPE_FLAG + '=';
  let scope;
  const rest = [];
  for (const arg of argv) {
    if (arg.startsWith(scopePrefix)) {
      scope = arg.slice(scopePrefix.length);
      continue;
    }
    rest.push(arg);
  }
  return { scope, rest };
}

// `verify-core.mjs` の `TEST_ARGS_THAT_DO_NOT_NARROW` を流用しない: これは「次の要素を値として飲むか」だけを見る一覧で、許可リストの目的が違うため。
// ここへ足していく形にしない: 次の vitest の版で同じ漏れが出るため。網羅は `loadVitestFlagInfo` が vitest の CLI 定義から読む。
const VALUE_TAKING_FLAGS = new Set([
  '--maxWorkers',
  '--minWorkers',
  '--reporter',
  '--testNamePattern',
  '-t',
  // `--shard` を載せる: `--shard=1/3` が通るのに `--shard 1/3`（空白区切り）だけテストが 1 本も走らず断られる非対称を無くすため。
  '--shard',
]);

// `-` で始まるものは値として飲まない: 位置引数側へ回るだけで安全側に倒れるため。
function isFlagLike(arg) {
  return arg === undefined || arg.startsWith('-');
}

// 手で足す一覧だけにせず vitest 自身の CLI 定義（`vitest/node` の `createCLI`）を実行時に読む: 次の vitest の版で同じ漏れが出るため。
export async function loadVitestFlagInfo() {
  try {
    const { createCLI } = await import('vitest/node');
    const cli = createCLI();
    const valueTaking = new Set();
    const booleans = new Set();
    for (const command of [cli.globalCommand, ...cli.commands]) {
      for (const option of command.options) {
        const takesValue = /[<[]/.test(option.rawName);
        for (const name of option.names) {
          const flag = name.length === 1 ? `-${name}` : `--${name}`;
          (takesValue ? valueTaking : booleans).add(flag);
        }
      }
    }
    // 値を取る側を優先する: 値を取るのに位置引数と読むと範囲判定を狂わせるため（逆は安全側で断られる）。
    for (const flag of valueTaking) booleans.delete(flag);
    if (valueTaking.size === 0) return null;
    return { valueTaking, booleans };
  } catch {
    return null;
  }
}

// 値を取るか分からないフラグの直後のトークンは黙って範囲に持ち込まず、呼び出し側が断る: 位置引数と読めば範囲が黙って狂い、値と読めば本当の位置引数を落とすため。
function classifyArgs(rest, flagInfo) {
  const positionalIdx = [];
  const ambiguous = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (isFlagLike(arg)) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1 || isFlagLike(rest[i + 1])) continue;
      if (VALUE_TAKING_FLAGS.has(arg) || flagInfo?.valueTaking.has(arg)) {
        i += 1;
      } else if (flagInfo?.booleans.has(arg)) {
        // 次の要素は次の周回で位置引数として読む。
      } else {
        ambiguous.push({ flag: arg, next: rest[i + 1] });
        i += 1;
      }
      continue;
    }
    positionalIdx.push(i);
  }
  return { positionalIdx, ambiguous };
}

function ambiguousFlagRefusal(ambiguous, flagInfo) {
  const listed = ambiguous.map((a) => `${a.flag} ${a.next}`).join(' / ');
  return {
    ok: false,
    exitCode: EXIT_SCOPE_VIOLATION,
    message: [
      `test-guard: 判定できない — 値を取るか分からないフラグの直後にトークンが続いている: ${listed}`,
      flagInfo
        ? 'vitest の CLI 定義にこのフラグが無い（綴りの誤りか、この版に無いフラグ）。'
        : 'vitest の CLI 定義を読めなかったので、既知の少数のフラグ以外は値を取るか分からない。',
      '直後のトークンを絞り込みのパスと読めば範囲が黙って狂い、値と読めば本当のパスを落とす。',
      '`=` 形（例: --testTimeout=5000）で渡すこと。',
    ].join('\n'),
  };
}

export const EXIT_SCOPE_VIOLATION = 8;

// 素の部分一致文字列をそのまま vitest へ渡さず、範囲内の実ファイルのパスへ差し替える: 範囲の外にある同じ部分文字列のファイルまで拾うため。
// 一致が 0 件のときは黙って全体を走らせたり 0 本で緑を名乗ったりせず断る: 「範囲外」と「範囲内に一致なし」の文言は混ぜない。
export function matchScopedPositionals(rest, scope, { cwd, repoRoot, filesInScope, flagInfo }) {
  const { positionalIdx, ambiguous } = classifyArgs(rest, flagInfo);
  if (ambiguous.length > 0) return ambiguousFlagRefusal(ambiguous, flagInfo);
  if (positionalIdx.length === 0) {
    return { ok: true, args: [...rest, scope] };
  }

  const packageDirRaw = path.relative(repoRoot, cwd).split(path.sep).join('/');
  const packageDir = packageDirRaw === '' ? '.' : packageDirRaw;

  const outArgs = [];
  let cursor = 0;
  for (const i of positionalIdx) {
    outArgs.push(...rest.slice(cursor, i));
    cursor = i + 1;

    const rawArg = rest[i];
    const pattern = rawArg.replace(/^\.\//, '');
    const matches = [...filesInScope].filter((f) => f.includes(pattern)).sort();

    if (matches.length > 0) {
      outArgs.push(...matches);
      continue;
    }

    const abs = path.resolve(cwd, rawArg);
    const candidateRel = path.relative(repoRoot, abs).split(path.sep).join('/');
    const escapesPackage = !(
      candidateRel === packageDir || candidateRel.startsWith(`${packageDir}/`)
    );

    if (escapesPackage) {
      return {
        ok: false,
        exitCode: EXIT_SCOPE_VIOLATION,
        message: [
          `test-guard: 範囲外 — 指定したパス「${rawArg}」は、この test の範囲` +
            `（${scope}）の外を指している（打った場所 ${cwd} から repo の根への相対パスは` +
            `「${candidateRel}」）。`,
          'このパッケージの test はここまでしか見ない。範囲内のパスを指すか、',
          'root の `pnpm test <パスの一部>` を使うこと。',
        ].join('\n'),
      };
    }

    return {
      ok: false,
      exitCode: EXIT_SCOPE_VIOLATION,
      message: [
        `test-guard: 範囲内に一致なし — 「${rawArg}」に部分一致するテストファイルが` +
          `範囲（${scope}）の中に1本も無い。`,
        '綴りを確認すること。範囲の外まで見たいなら root の `pnpm test <パスの一部>`',
        'を使うこと。',
      ].join('\n'),
    };
  }
  outArgs.push(...rest.slice(cursor));

  return { ok: true, args: outArgs };
}

// 歯Bの走査（`readIncludeGlobs` / `collectMatchingTestFiles`）を二重実装しない。`include` を読めない・空なら `EXIT_SCAN_EMPTY` と混ぜず空配列を返す。
export async function listScopeTestFiles(root, scope) {
  let includeGlobs;
  try {
    includeGlobs = await readIncludeGlobs(root);
  } catch {
    return [];
  }
  if (!Array.isArray(includeGlobs) || includeGlobs.length === 0) return [];
  return collectMatchingTestFiles(root, includeGlobs).filter(
    (f) => f === scope || f.startsWith(`${scope}/`),
  );
}

export async function resolveScopedArgs(argv, { cwd = process.cwd(), repoRoot = ROOT } = {}) {
  const { scope, rest } = extractScope(argv);
  if (scope === undefined) {
    return { ok: true, args: rest };
  }

  // vitest の CLI 定義は、値を取るか分からないフラグがあるときだけ読む: 既知のフラグだけの通常の打ち方では読み込みを起こさないため。
  let flagInfo;
  if (classifyArgs(rest).ambiguous.length > 0) {
    flagInfo = await loadVitestFlagInfo();
  }
  const { positionalIdx, ambiguous } = classifyArgs(rest, flagInfo);
  if (ambiguous.length > 0) return ambiguousFlagRefusal(ambiguous, flagInfo);
  if (positionalIdx.length === 0) {
    return { ok: true, args: [...rest, scope] };
  }

  const filesInScope = await listScopeTestFiles(repoRoot, scope);
  return matchScopedPositionals(rest, scope, { cwd, repoRoot, filesInScope, flagInfo });
}

export function hasReporterFlag(argv) {
  for (const arg of argv) {
    if (arg === '--reporter' || arg.startsWith('--reporter=')) return true;
  }
  return false;
}

// TTY・CI の判定をしない: この器の Bash は非TTY のまま `CI=true` を既定で持ち、CI 判定で毎回弾かれて狙った相手に効かないため。
// `CLAUDECODE` で見る: 人間の端末にも GitHub Actions の runner にも無く、どちらも vitest 既定の reporter のままになるため。
// `--reporter=default` を明示する変異試験ハーネスは `hasReporterFlag` が真になり素通りするので、出力形は変わらない。
export function resolveReporterArgs(argv, { CLAUDECODE } = {}) {
  if (hasReporterFlag(argv)) return argv;
  if (!CLAUDECODE) return argv;
  return [...argv, '--reporter=dot'];
}

const DEADLINE_FLAG = '--deadline-seconds';

export const EXIT_BAD_DEADLINE = 9;

// 打ち切った回は歯A/B/C の判定を走らせない: SIGTERM/SIGKILL の後の出力は、集計行が出ていないのか途中で切れたのか区別できず、判定できない材料に判定を掛けないため。
export const EXIT_DEADLINE = 10;

// 外側の `timeout` に頼らず自前の締め切りを持つ: GNU `timeout` は時間切れでパイプの読み手（`| grep` 等）にも SIGTERM を送り、出力も打ち切りも 1 行も残らないため。
// `VALUE_TAKING_FLAGS` に足さず `--scope` の位置引数判定より前に argv から取り除く: 範囲の絞り込みに締め切りという無関係な軸を混ぜないため。
export function extractDeadlineSeconds(argv) {
  const eqPrefix = DEADLINE_FLAG + '=';
  let raw;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith(eqPrefix)) {
      raw = arg.slice(eqPrefix.length);
      continue;
    }
    if (arg === DEADLINE_FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return {
          ok: false,
          exitCode: EXIT_BAD_DEADLINE,
          message: [
            'test-guard: --deadline-seconds に値が無い。',
            '1以上の整数（秒）を指定すること（例: --deadline-seconds=300）。',
          ].join('\n'),
        };
      }
      raw = next;
      i += 1;
      continue;
    }
    rest.push(arg);
  }

  if (raw === undefined) {
    return { ok: true, deadlineSeconds: undefined, rest: argv };
  }

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return {
      ok: false,
      exitCode: EXIT_BAD_DEADLINE,
      message: [
        `test-guard: --deadline-seconds の値が不正: ${JSON.stringify(raw)}`,
        '1以上の整数（秒）を指定すること（小数・負・0・非数は受け付けない）。',
      ].join('\n'),
    };
  }

  return { ok: true, deadlineSeconds: Number(raw), rest };
}

// 集計行が出ていないことと「通ったのでも落ちたのでもない」ことを明示する: 歯A（`EXIT_UNKNOWN`）と混同されないため。
export function formatDeadlineMessage(deadlineSeconds) {
  return (
    `test-guard: --deadline-seconds=${deadlineSeconds} で打ち切った` +
    `（vitest が ${deadlineSeconds} 秒で終わらなかった）。` +
    '集計行は出ていない——通ったのでも落ちたのでもない。分けて回す: ' +
    '.claude/skills/test-in-chunks/SKILL.md'
  );
}

// マッチの前に必ず剥がす: GitHub Actions では集計行が色付きで出て、`^\s*Test Files` がエスケープシーケンスを空白と読まず、緑のテストが「判定できない」に誤って倒れたため。
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- ANSI エスケープの検出そのものが目的
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function parseAggregateLines(rawOutput) {
  const plain = stripAnsi(rawOutput);
  const filesLine = plain.match(/^\s*Test Files\s+.+$/m)?.[0]?.trim() ?? null;
  const testsLine = plain.match(/^\s*Tests\s+.+$/m)?.[0]?.trim() ?? null;
  return { filesLine, testsLine };
}

export function parsePassedCount(testsLine) {
  if (testsLine === null) return 0;
  const m = testsLine.match(/(\d+)\s+passed/);
  return m ? Number(m[1]) : 0;
}

// vitest が exit 0 を返した後にだけこの分岐へ入る: vitest 自身の exit code（0/1）と混ざらないため。
export const EXIT_ZERO_PASSED = 2;
export const EXIT_UNKNOWN = 3;
export const EXIT_STATIC_SKIP = 4;

// `EXIT_STATIC_SKIP` / `EXIT_UNKNOWN` と別の exit code にする: 走査対象 0 件（見ていない）は「無条件の skip が 0 件だった」（見て、無かった）と同じ見た目になり、混ぜないため。
export const EXIT_SCAN_EMPTY = 5;

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

// `skipIf` / `runIf` の除外は連鎖を `.` で割った要素の完全一致で行う: `'skipIf'` は `'skip'` と等しくないので、連鎖のどこに現れても引っかからない。
// バッククォート終端は連鎖の最後が `each` のときだけ認める: 本物の tagged template は `.each` の直後にしか現れず、Markdown のコードスパンの閉じ記号を誤検出するため。
// `it .skip(`（識別子と `.skip` の間の空白）は塞がない: prettier を通すのでその形にならないため。
const SKIP_CALL_CHAIN_RE = /\b(describe|it|test)((?:\.\w+)*)\s*([(`])/g;

function chainHasUnconditionalSkip(chain) {
  const segments = chain.split('.').filter(Boolean);
  return segments.includes('skip');
}

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

export function formatSkipGuardMessage(hits) {
  const lines = hits.map((h) => `  ${h.path}:${h.line}  ${h.matched}`);
  return [
    `test-guard: ソースの側 — 無条件の静的 skip が ${hits.length} 件見つかった:`,
    ...lines,
    '',
    '戻し忘れなら消す。意図的に止めたいなら skipIf で条件を書くか、消して Issue にする。',
  ].join('\n');
}

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

export const EXIT_OBSERVATION_UNDECLARED = 6;

export const EXIT_OBSERVATION_DUE = 7;

// ゼロ埋め無しの `2026-9-1` を弾く: `today > 見直し期限` を文字列比較で日付順と一致させる前提のため。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function stripCommentPrefix(line) {
  return line.replace(/^\s*(\/\*\*|\/\*|\*\/|\*|\/\/)\s?/, '');
}

function extractField(area, label) {
  const re = new RegExp(`^${label}\\s*[:：]\\s*(.*)$`);
  for (const line of area.split('\n')) {
    const m = stripCommentPrefix(line).trim().match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

function findFieldLine(content, label) {
  const re = new RegExp(`^${label}\\s*[:：]`);
  const lines = content.split('\n');
  const areaLineCount = leadingCommentArea(content).split('\n').length;
  for (let i = 0; i < areaLineCount; i++) {
    if (re.test(stripCommentPrefix(lines[i]).trim())) return i + 1;
  }
  return null;
}

// 名乗りは 2 形（パスの慣習と冒頭コメント領域の `@観測`）だけにする: 散文の「観測」「書き捨て」は別の意味で使われており誤検出になるため。
export function isObservationFile(path, content) {
  if (path.includes('.observed.') || path.includes('.scratch.') || path.includes('-scratch.')) {
    return true;
  }
  return leadingCommentArea(content).includes('@観測');
}

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
          '運用ルールは .claude/skills/observation-tests/SKILL.md を見ること。',
        ]
      : [
          '',
          '次の手（いずれか）: 終了条件に到達していれば「基準」に書き換える／捨てる／',
          'まだ到達していないなら見直し期限を延ばす（延ばすなら、なぜ延ばすかも一緒に書く）。',
          '運用ルールは .claude/skills/observation-tests/SKILL.md を見ること。',
        ];
  return [header, ...lines, ...footer].join('\n');
}

// `today` を引数で受け、中で `new Date()` を呼ばない: 呼ぶとテストが日付で腐るため。期限当日はまだ赤くしない（`>` であって `>=` ではない）。
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

// `undeclared` を `due` より先に見る: 申告が壊れたファイルは期限の比較ができず、先に直すべき負債のため。
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

// `vitest.config.ts` を書き写さず直接 import する: 二重管理はずれるため。
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

export function collectMatchingTestFiles(root, includeGlobs) {
  const all = [];
  collectFiles(root, root, all);
  return all.filter((f) => includeGlobs.some((g) => path.matchesGlob(f, g)));
}

export function readFilesForScan(root, relPaths) {
  return relPaths.map((p) => ({ path: p, content: readFileSync(path.join(root, p), 'utf8') }));
}

// `readIncludeGlobs` の失敗や空の `include` も「判定できない」（`EXIT_SCAN_EMPTY`）へ倒す: 「見ていない」の入口を 1 つに絞るため。
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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

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
