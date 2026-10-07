// 判定は `verify.mjs` の外のここへ置く: 中に置くと、歯を書くのに `pnpm build` から始まる一式を実際に走らせるしかなくなるため。
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// 指紋が読めなければ `null` を返し、呼ぶ側は必ず走る側へ倒す: 「判定できない」を「変わっていない」へ倒さないため。
// モードも畳む: 実行ビットだけの変更も `git diff` は差分として見せるが、中身だけでは指紋から漏れるため。
// symlink は追いかけず行き先の文字列を畳む: `readFileSync` は symlink を追い、行き先を差し替えても中身が同じなら指紋が動かないため。
// 長さを前置してから畳む: `パス\0中身\0` を並べるだけだと、「NUL を含む1ファイル」と「空の2ファイル」が同じバイト列になるため。
export function fingerprint(repo) {
  const list = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repo,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (list.status !== 0 || head.status !== 0) return null;

  const hash = createHash('sha256');
  const feed = (label, value) => {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    hash.update(label + ':' + buf.length + ':');
    hash.update(buf);
  };

  feed('HEAD', head.stdout.trim());

  // パスはバイト列のまま扱う: utf8 として読むと、不正なバイトが U+FFFD へ畳まれて別のパスと衝突しうるため。
  const paths = list.stdout
    .toString('binary')
    .split('\0')
    .filter(Boolean)
    // 並びを固定する: git の出力順に依存させると、環境で答えが変わりうるため。
    .sort();

  for (const path of paths) {
    const full = join(repo, Buffer.from(path, 'binary').toString('utf8'));
    feed('path', Buffer.from(path, 'binary'));
    try {
      const st = lstatSync(full);
      feed('mode', st.isSymbolicLink() ? '120000' : (st.mode & 0o111) !== 0 ? '100755' : '100644');
      feed('body', st.isSymbolicLink() ? readlinkSync(full) : readFileSync(full));
    } catch {
      // 読めないファイルは `mode` と `body` の両方へ入れる: 片方だけだと、中身が偶然この文言と同じファイルと衝突しうるため。
      feed('mode', '<unreadable>');
      feed('body', '<unreadable>');
    }
  }
  return hash.digest('hex');
}

// 記録の置き場は git 自身に聞き、`<repo>/.git` を直に組み立てない: `git worktree` では `.git` が1行のファイルで、`ENOTDIR` で一式が全部通った後に記録の書き込みだけが落ちるため。
export function recordPathFor(repo) {
  const dir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (dir.status !== 0) return null;
  const trimmed = dir.stdout.trim();
  if (trimmed === '') return null;
  return join(trimmed, 'alteroid-verify.json');
}

// `HEAD` ではなく tree の sha を使う: commit すると `HEAD` が動いて指紋が必ず不一致になり、正しい順序で作業しても毎回「未検証」になるため。
// 一時 index は空からではなく本物の index の写しから始める: 空からだと、追跡済みで `.gitignore` にも当たるファイルが「ignore された新規ファイル」に化けて tree から漏れ、`fingerprint` が見る集合とずれて、verify 直後の HEAD でも `pnpm check:verified-head` が「不一致」と言うため。
// 一時 index のファイル名は呼ぶたびに乱数を混ぜる: 複数のプロセスが同じツリーで並行して verify しても、固定名だと一時 index を取り合うため。
// `skip-worktree` / `assume-unchanged` の印が1つでもあれば `null`（判定できない）へ倒し、印を外して進めない: 印の付いたパスは `git add -A` が作業ツリーを見ず、古い中身が tree に入って「一致」と誤って言い、印を外すと sparse checkout の前提を壊すため。
export function hasSkipWorktreeOrAssumeUnchanged(lsFilesVOutput) {
  return lsFilesVOutput.split('\n').some((line) => {
    if (line.length === 0) return false;
    const tag = line[0];
    return tag === 'S' || (tag >= 'a' && tag <= 'z');
  });
}

export function writeTreeFor(repo) {
  const dir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (dir.status !== 0) return null;
  const gitDir = dir.stdout.trim();
  if (gitDir === '') return null;

  const indexFile = join(
    gitDir,
    'alteroid-verify-index.' + process.pid + '.' + randomBytes(6).toString('hex'),
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    // コピーできなければ判定できない側（`null`）へ倒す: 以降の `git add -A` がどちらの範囲を見ているか保証できないため。
    const realIndexFile = join(gitDir, 'index');
    if (existsSync(realIndexFile)) {
      try {
        copyFileSync(realIndexFile, indexFile);
      } catch {
        return null;
      }
    }

    const lsFilesV = spawnSync('git', ['ls-files', '-v'], { cwd: repo, env, encoding: 'utf8' });
    if (lsFilesV.status !== 0) return null;
    if (hasSkipWorktreeOrAssumeUnchanged(lsFilesV.stdout)) return null;

    const add = spawnSync('git', ['add', '-A'], { cwd: repo, env });
    if (add.status !== 0) return null;
    const write = spawnSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' });
    if (write.status !== 0) return null;
    return write.stdout.trim();
  } finally {
    try {
      unlinkSync(indexFile);
    } catch {
      // コピーや `git add -A` が一時 index を作る前に落ちた場合は、消すものが無いだけなので無視する。
    }
  }
}

// `new Date()` は `decideSkip` の既定引数の中だけで呼ぶ: 純粋なロジック（`decideRecord` / `recordFor`）では呼ばない。日付依存の検査を数え上げる形は、スイートの内側の日付依存テストまで数え切れず閉じないため、「記録した日」と「いま」を突き合わせて日が変わったら走り直す。
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// 倒す先は常に「走る」: 「判定できない」を「変わっていない」へ倒すと、いちばん危ないときに黙って緑を名乗るため。旧形式の記録（`day` を持たない）も同じ側へ倒す。
export function decideSkip({ repo, recordPath, force = false, today = todayUtc() }) {
  const current = fingerprint(repo);
  if (force) return { skip: false, reason: 'force', fingerprint: current };
  if (current === null) return { skip: false, reason: 'no-fingerprint', fingerprint: null };
  if (recordPath === null || recordPath === undefined) {
    return { skip: false, reason: 'no-record-path', fingerprint: current };
  }
  if (!existsSync(recordPath)) return { skip: false, reason: 'no-record', fingerprint: current };
  try {
    const saved = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (saved.fingerprint === current) {
      if (typeof saved.day !== 'string' || saved.day !== today) {
        return {
          skip: false,
          reason: 'stale-day',
          fingerprint: current,
          at: saved.at,
          day: saved.day,
          // 判定に使った `today` を返す: 呼ぶ側が `new Date()` を引き直すと、真夜中を跨いで判定の日と表示の日が食い違うため。
          today,
        };
      }
      return { skip: true, reason: 'unchanged', fingerprint: current, at: saved.at };
    }
    return { skip: false, reason: 'changed', fingerprint: current };
  } catch {
    return { skip: false, reason: 'broken-record', fingerprint: current };
  }
}

// マッチの前に ANSI を剥がす: 色が付くと `^\s*Test Files` が行頭の SGR に一致せず、完走して緑でも「1本も走っていない」に化けるため。
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- ANSI エスケープの検出そのものが目的
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// 探す語（`Test Files` / `Tests`）は緩めない: 緩めると、集計行が本当に無い入力でも「走った」と読めてしまうため。
export function testRan(output) {
  const plain = stripAnsi(output);
  return /^\s*Test Files\s+/m.test(plain) && /^\s*Tests\s+/m.test(plain);
}

// `undecidable` を `not-run` へ混ぜない: signal で殺された場合は走ったかが分からず、`not-run` に倒すと原因と関係のない「並列度を下げて取り直せ」という助言を出し、読んだ人が無駄に繰り返すため。
export function classifyTest({ status, signal, output }) {
  if (signal !== null && signal !== undefined) {
    return { state: 'undecidable', reason: 'signal', signal, ran: testRan(output) };
  }
  if (status === null || status === undefined) {
    return { state: 'undecidable', reason: 'no-status', ran: testRan(output) };
  }
  if (!testRan(output)) return { state: 'not-run', reason: 'no-summary-lines' };
  return status === 0 ? { state: 'passed' } : { state: 'failed', code: status };
}

// 順序に意味がある（`build` が先）。
// `openapi` の差分検査は `HEAD` を明示する: 手元は index が汚れているのが普通で、素の `git diff` だと `git add` だけした生成物の差分を見落とし、手元は緑・CI は赤になるため。
// env は `workspaceConcurrencyEnv` を持つ手順にだけ足し、手順の名前で分岐しない: 手順を増やしたり名前を変えたときに静かに外れるため。
export const STEPS = [
  { name: 'build', cmd: 'pnpm', args: ['build'], workspaceConcurrencyEnv: true },
  {
    name: 'web-bundle-node-traces',
    cmd: 'pnpm',
    args: ['check:web-bundle-node-traces'],
    hint:
      'apps/web の生成物に Node 専用の痕跡（createRequire / node: 指定子 / process.cwd / Bun.）が' +
      '混入している。@alteroid/core（や他の依存）から値を import してサーバ専用コードを引き込んで' +
      'いないか確認すること（scripts/check-web-bundle-node-traces.mjs の doc）',
  },
  {
    name: 'web-bundle-size',
    cmd: 'pnpm',
    args: ['check:web-bundle-size'],
    hint:
      'apps/web の生成物（apps/web/build/client/assets/*.js）がチャンクのサイズ予算を超えた。' +
      '閾値を上げる前に、増えた原因を特定すること（scripts/check-web-bundle-size.mjs の doc、' +
      'https://github.com/takecchi/alteroid/issues/335）',
  },
  {
    name: 'web-css-comment-classnames',
    cmd: 'pnpm',
    args: ['check:web-css-comment-classnames'],
    hint:
      'apps/web の生成物の CSS に、コメント中のプレースホルダ記法（`...` / `…`）がクラス名として' +
      '拾われて生まれた不正な宣言が入っている。プレースホルダを含む例をコメントへ書いていないか' +
      '確認すること（scripts/check-web-css-comment-classnames-core.mjs の doc、#317）',
  },
  {
    name: 'web-css-no-inline-fonts',
    cmd: 'pnpm',
    args: ['check:web-css-no-inline-fonts'],
    hint:
      'apps/web の生成物の CSS にフォントの base64 埋め込み（`data:font/`）が入っている。' +
      'apps/web/vite.config.ts の build.assetsInlineLimit（フォントを埋め込まない関数形）が' +
      '外れていないか確認すること。埋め込むと unicode-range に関係なく CSS と一緒に最初に' +
      '落ちてくる（scripts/check-web-css-no-inline-fonts-core.mjs の doc）',
  },
  {
    name: 'openapi',
    cmd: 'git',
    args: ['diff', '--exit-code', 'HEAD', '--', 'apps/daemon/openapi.json'],
    hint: 'apps/daemon/openapi.json が古い。`pnpm build` の結果を commit すること',
  },
  {
    name: 'sdk-quotes',
    cmd: 'pnpm',
    args: ['check:sdk-quotes'],
    hint:
      '同梱 SDK の型定義から逐語で引いたコメント（sdk-verbatim の印が付いた行）が、' +
      'いまの版に当たらなくなった。引用を書き換える前に、その引用を根拠にしている判断が' +
      'まだ成り立つかを確かめること（scripts/check-sdk-quotes-core.mjs の doc）',
  },
  {
    name: 'stale-token-restart-advice',
    cmd: 'pnpm',
    args: ['check:stale-token-restart-advice'],
    hint:
      '「世代ずれなら起こし直せ」の助言が、生成元の外に書かれている。字面の生成元は' +
      'packages/core/src/usage-limits.ts の STALE_TOKEN_RESTART_ADVICE 1箇所である' +
      '（scripts/check-stale-token-restart-advice-core.mjs の doc、#1175）',
  },
  {
    name: 'restart-before-check-advice',
    cmd: 'pnpm',
    args: ['check:restart-before-check-advice'],
    hint:
      '「manager_start で起こし直す前に確かめろ」の助言が、生成元の外に書かれている。' +
      '字面の生成元は packages/core/src/usage-limits.ts の RESTART_BEFORE_CHECK_ADVICE / ' +
      'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN 1箇所である' +
      '（scripts/check-restart-before-check-advice-core.mjs の doc、#1287）',
  },
  {
    name: 'no-env-passthrough',
    cmd: 'pnpm',
    args: ['check:no-env-passthrough'],
    hint:
      'テストのコードか変異試験ハーネスが、子プロセスへ親の process.env を丸ごと渡す形' +
      '（...process.env / env: process.env / Object.assign(…, process.env)）を書いている。' +
      '必要な鍵だけを明示的に組み立てる（gitChildEnv() / mutateCliChildEnv() 等）か、' +
      'わざとの場合は理由付きで scripts/check-no-env-passthrough-core.mjs の ALLOWLIST へ' +
      '載せること（scripts/check-no-env-passthrough-core.mjs の doc、Issue #1935 / #1854）',
  },
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'format:check', cmd: 'pnpm', args: ['format:check'], hint: '`pnpm format` で直る' },
  { name: 'test', cmd: 'pnpm', args: ['test'], isTest: true },
];

const WORKSPACE_CONCURRENCY_FLAG = '--workspace-concurrency';

// `=` の形と空白区切りの形の両方を受ける: 片方だけだと、もう片方が静かに無視されて既定へ落ち、「効かない」ことが出力に出ないため。
// 1以上の整数でなければ落とす: 黙って既定へ倒すと、打ち間違いが「効かなかった」という無言の形で出るため。
export function readWorkspaceConcurrency(args) {
  const eqPrefix = WORKSPACE_CONCURRENCY_FLAG + '=';
  const eqArg = args.find((a) => a.startsWith(eqPrefix));
  let raw;
  if (eqArg !== undefined) {
    raw = eqArg.slice(eqPrefix.length);
  } else {
    const idx = args.indexOf(WORKSPACE_CONCURRENCY_FLAG);
    if (idx === -1) return undefined;
    raw = args[idx + 1];
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${WORKSPACE_CONCURRENCY_FLAG} には1以上の整数を渡すこと` +
        `（${WORKSPACE_CONCURRENCY_FLAG} <n> または ${WORKSPACE_CONCURRENCY_FLAG}=<n> の形。` +
        `実際: ${JSON.stringify(raw)}）`,
    );
  }
  return n;
}

// `--workspace-concurrency` を `passthrough` に残さない: 残すと `pnpm test --workspace-concurrency=2` になり、build へ届かず test のほうへ付くため。素の `--` を落とす理由も同じ（`--maxWorkers=4` が vitest へ届かない）。
export function splitVerifyArgs(argv) {
  const workspaceConcurrency = readWorkspaceConcurrency(argv);
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--' || arg === '--force') continue;
    if (arg.startsWith(WORKSPACE_CONCURRENCY_FLAG + '=')) continue;
    if (arg === WORKSPACE_CONCURRENCY_FLAG) {
      // 値の側も落とす: 落とさないと、裸の数字が vitest へ渡ってパスの絞り込みとして解釈されるため。
      i += 1;
      continue;
    }
    passthrough.push(arg);
  }
  return { workspaceConcurrency, passthrough };
}

// build へ引数として渡さず環境変数で渡す: `pnpm build -- --workspace-concurrency=2` はフラグが各パッケージの build スクリプトの引数になり、`react-router build`（`apps/web`）が `--` をルートディレクトリと解釈して落ちるため。
// 大文字の `PNPM_CONFIG_*` だけを足す: pnpm は `NPM_CONFIG_*` を読まず、大文字小文字が混ざった名前は無視するため。
// 既定を持たない: `workspaceConcurrency` が `undefined` なら `baseEnv` をそのまま返し、器の外で設定された値を黙って上書きしないため。
export function envForStep(step, { workspaceConcurrency, baseEnv }) {
  if (workspaceConcurrency === undefined || step.workspaceConcurrencyEnv !== true) return baseEnv;
  return { ...baseEnv, PNPM_CONFIG_WORKSPACE_CONCURRENCY: String(workspaceConcurrency) };
}

// 許可リストにする（拒否リストにしない）: 知らない引数は「絞る」側へ倒すと余分に一式を走らせるだけで済むが、拒否リストだと知らない引数が黙って「絞り込まない」側へ回り、絞り込んだ実行が全体の成功として記録されるため。
export const TEST_ARGS_THAT_DO_NOT_NARROW = [
  { flag: '--maxWorkers', takesValue: true },
  { flag: '--minWorkers', takesValue: true },
  { flag: '--reporter', takesValue: true },
  { flag: '--silent', takesValue: false },
  { flag: '--no-color', takesValue: false },
  { flag: '--color', takesValue: false },
];

function isFlagLike(arg) {
  return arg === undefined || arg.startsWith('-');
}

export function classifyTestScope(passthrough) {
  const narrowing = [];
  for (let i = 0; i < passthrough.length; i += 1) {
    const arg = passthrough[i];
    const eqIdx = arg.indexOf('=');
    const head = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const known = TEST_ARGS_THAT_DO_NOT_NARROW.find((entry) => entry.flag === head);
    if (known === undefined) {
      narrowing.push(arg);
      continue;
    }
    if (eqIdx !== -1) continue;
    // 次の要素が `-` で始まるなら値として飲まない: 飲むと `--reporter --changed` の `--changed` が消え、絞り込みが `full: true` に化けて「全体成功」が記録されるため。
    if (known.takesValue && !isFlagLike(passthrough[i + 1])) i += 1;
  }
  return { full: narrowing.length === 0, narrowing };
}

// `moved` を最優先にする: 絞り込んでいなくても、走行中にツリーが直されていたら「検証していないものを検証済みとして記録する」ことになるため。
export function decideRecord({ scope, moved, recordPath }) {
  if (moved) return { record: false, reason: 'tree-moved' };
  if (!scope.full) return { record: false, reason: 'narrowed', narrowing: scope.narrowing };
  if (recordPath === null || recordPath === undefined) {
    return { record: false, reason: 'no-record-path' };
  }
  return { record: true, reason: 'ok' };
}

// `at` と `day` は同じ `now` から作る: 別々に `new Date()` を呼ぶと、昨日の23:59:59.999 の `at` と今日の `day` のように矛盾しうるため。
export function recordFor(fingerprint, now = new Date(), tree = undefined) {
  const record = { fingerprint, at: now.toISOString(), day: now.toISOString().slice(0, 10) };
  return tree === undefined ? record : { ...record, tree };
}
