import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { redactedExcerpt } from '@alteroid/core/redact';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';

/**
 * `alteroid profile` — 実行環境プロファイル（人間の `.zprofile` に当たるもの）。
 *
 * **これは「環境変数を器に増やす」の代わりである。** 道具の鍵を1つ足すたびに
 * `compose.yaml` を直して器を焼き直すのは、人間が自分の端末で `~/.zshenv` に
 * 1行足せば済ませていることを実装作業に変えてしまっている、ということである。
 * それはデグレードなので、口をここに開けてある。
 *
 * 置いたものは既定ではクローンにもマネージャーにも作業者にも効き（撒く先 `--scope`
 * で `app`＝クローンだけ / `runner`＝マネージャー・作業者だけに絞れる。環境変数
 * （`alteroid credential set --scope`）と同じ3値）、**器を作り直さずに
 * 差し替えられる**（これから起こす仕事には即座に。走行中の仕事は `gh` / `git` が
 * 次の呼び出しから拾う）。
 */

/** 失敗の応答の `error` / `detail` を画面に出す長さの上限（伏せた後に切る）。 */
const ERROR_LIMIT = 512;
const DETAIL_LIMIT = 2000;

type ProfileScope = 'all' | 'app' | 'runner';

interface ProfileView {
  script: string;
  /** 古いデーモンは返さない。無ければ `all`（この欄が無かった頃は両方へ撒かれていた）。 */
  scope?: ProfileScope;
  updatedAt?: string;
  sha256?: string;
  bytes?: number;
}

interface ApplyResult {
  ok: boolean;
  error?: string;
  output?: string;
  names?: string[];
}

interface UpdateView {
  updatedAt: string;
  scope?: ProfileScope;
  sha256?: string;
  bytes?: number;
  clone: ApplyResult;
  runners: (ApplyResult & { runnerId: string })[];
}

function describeScope(scope: string): string {
  switch (scope) {
    case 'all':
      return 'all（クローンと runner の両方）';
    case 'app':
      return 'app（クローンだけ）';
    case 'runner':
      return 'runner（マネージャー・作業者だけ）';
    default:
      // 送られてくる値である。古い CLI が新しいデーモンの値を知らないことがある
      // ——投げずに「未知」とそのまま出す（`credential.ts` の同名の関数と同じ判断）。
      return `未知の撒く先（${scope}）`;
  }
}

/** `--scope` を検査する。省略は undefined（＝今の撒く先を保つ）。 */
function parseScope(raw: string | undefined): ProfileScope | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'all' || raw === 'app' || raw === 'runner') return raw;
  throw new Error(`--scope は all / app / runner のいずれかである（渡されたのは ${raw}）`);
}

/** runner へ本文が降りるべきか（`profileScopeAppliesTo(scope, 'runner')` と同じ判定）。 */
function appliesToRunner(scope: string): boolean {
  return scope !== 'app';
}

export async function profileShowCommand(): Promise<void> {
  const target = await resolveTarget();
  const profile = (await request(target, '/profile')) as ProfileView;

  if (profile.script.length === 0) {
    stdout.write('プロファイルは置かれていません。\n');
    stdout.write('置くには: alteroid profile edit\n');
    return;
  }
  stdout.write(profile.script.endsWith('\n') ? profile.script : `${profile.script}\n`);
}

export async function profileStatusCommand(): Promise<void> {
  const target = await resolveTarget();
  const profile = (await request(target, '/profile')) as ProfileView;

  if (profile.script.length === 0) {
    stdout.write('プロファイル: 置かれていません\n');
  } else {
    stdout.write(
      `プロファイル: ${String(profile.bytes ?? 0)} バイト` +
        ` (sha256 ${profile.sha256 ?? '?'} / 更新 ${profile.updatedAt ?? '?'})\n`,
    );
    stdout.write(`撒く先: ${describeScope(profile.scope ?? 'all')}\n`);
  }
  const scope = profile.scope ?? 'all';

  // **どの runner に何が届いているかを見せる。** 見えないと「置いた」「効いて
  // いない」のすれ違いが起きて、鍵の権限の問題なのか配布の問題なのかを誰も
  // 切り分けられない（鍵の指紋を出しているのと同じ理由）。
  const { runners } = (await request(target, '/runners')) as {
    runners: {
      label: string;
      state: string;
      runnerId?: string;
      profile?: { sha256: string; updatedAt: string };
    }[];
  };
  for (const runner of runners) {
    // 繋がるまで runner_id は分からない。宛先（label）なら登録した時点で言える。
    const name = runner.runnerId ?? runner.label;
    // **撒く先が runner に届かない（`app`）なら、載っていないのが正しい。** 食い違い
    // として見せると、直せない（直すと撒く先の意味が消える）ものを直させる。
    // 逆に載っているなら、降ろし直しが済んでいないので、それは言う。
    const expected = profile.script.length > 0 && appliesToRunner(scope);
    if (runner.profile === undefined) {
      stdout.write(
        profile.script.length > 0 && !expected
          ? `  ${name}: プロファイル無し（撒く先が app なので、載っていないのが正しい。${runner.state}）\n`
          : `  ${name}: プロファイル無し（${runner.state}）\n`,
      );
    } else {
      stdout.write(
        `  ${name}: sha256 ${runner.profile.sha256} (${runner.profile.updatedAt})` +
          (profile.script.length > 0 && !expected
            ? '（撒く先が app なので載っているはずがない — 外しの降ろしが済んでいない）'
            : '') +
          '\n',
      );
    }
  }
}

/** ファイルか標準入力から丸ごと置き換える。 */
export async function profileSetCommand(options: {
  file?: string;
  scope?: string;
}): Promise<void> {
  // 先に検査する（標準入力を読み終えてから「綴りが違う」で落とさない）。
  const scope = parseScope(options.scope);
  const script =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  await put(script, undefined, scope);
}

/** いま置いてあるものを `$EDITOR` で開いて、閉じたら反映する。 */
export async function profileEditCommand(options: { scope?: string } = {}): Promise<void> {
  const scope = parseScope(options.scope);
  const target = await resolveTarget();
  const current = (await request(target, '/profile')) as ProfileView;

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-profile-'));
  const path = join(dir, 'profile.sh');
  try {
    await writeFile(path, current.script.length > 0 ? current.script : TEMPLATE, {
      encoding: 'utf8',
      // 中身は人間が置いた鍵そのものになりうる。一時ファイルでも絞る。
      mode: 0o600,
    });
    await openEditor(path);
    const edited = await readFile(path, 'utf8');

    // 撒く先だけを変えるのも更新である（本文が同じでも、外れる側が出る）。
    const scopeChanged = scope !== undefined && scope !== (current.scope ?? 'all');
    if (edited === current.script && !scopeChanged) {
      stdout.write('変更はありません。\n');
      return;
    }
    await put(edited, target, scope);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function profileClearCommand(): Promise<void> {
  await put('');
}

async function put(script: string, known?: Target, scope?: ProfileScope): Promise<void> {
  const target = known ?? (await resolveTarget());
  const result = (await request(target, '/profile', {
    method: 'PUT',
    // 省略は「今の撒く先を保つ」（デーモン側の約束）。
    body: JSON.stringify({ script, ...(scope === undefined ? {} : { scope }) }),
  })) as UpdateView;

  if (script.trim().length === 0) {
    stdout.write('プロファイルを外しました。\n');
  } else {
    stdout.write(`プロファイルを更新しました (sha256 ${result.sha256 ?? '?'})\n`);
    stdout.write(`  撒く先: ${describeScope(result.scope ?? 'all')}\n`);
  }

  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);

  // **どこまで届いたかを正直に言う。** 器を焼き直す手順を探させないために
  // 「即座に効く」ことは言うが、走行中の仕事に全部届くとは言わない — `BASH_ENV`
  // は非対話の bash なら `bash -c` でも読まれるものの、実測では届く相手と届かない
  // 相手が混在する（`packages/core/src/profile.ts` のモジュール doc）。
  // ここを大きく書くと、効いていない相手が居ることに誰も気づけなくなる。
  if (script.trim().length > 0) {
    stdout.write('（これから起こす仕事には即座に効きます。走行中の仕事は gh / git だけが\n');
    stdout.write('  次の呼び出しから拾います — それ以外は次の仕事から）\n');
  }
}

function report(label: string, result: ApplyResult): void {
  if (result.ok) {
    const names = result.names ?? [];
    stdout.write(
      names.length === 0
        ? `  ${label}: 反映しました\n`
        : `  ${label}: 反映しました（${names.join(' ')}）\n`,
    );
  } else {
    // 失敗を小さく出さない。ここを見落とすと、以後ずっと古い環境で走り続ける。
    stdout.write(`  ${label}: 反映できませんでした — ${result.error ?? '理由不明'}\n`);
  }
  const output = result.output ?? '';
  if (output.trim().length > 0) {
    for (const line of output.trimEnd().split('\n')) stdout.write(`    | ${line}\n`);
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function openEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} が異常終了しました (${String(code)})`));
    });
  });
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    // **403 の意味が `access` とは違うことがある。** ここは基本「実行環境の
    // 持ち主か」を見ているが、**403 はそれ以外の理由でも返る**——ログイン済み
    // だが未 grant のとき、デーモンの `authenticate` が別の本文で 403 を返す。
    // 本文を見ずに固定の文言を出すと、未 grant の人にまで「持ち主だけです」と
    // 案内してしまい、`access grant` で直る状況で直らない手順を勧めることに
    // なる（許可が持っているのは「使ってよい」の2値だけで、実行環境そのものを
    // 差し替える資格はそこに含まれない、という線引きは変えていない——本文で
    // 出し分けるようにしただけである）。
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      // **2026-09-24（#1122）に `/profile` の門は `requireOwner` へ移った** ⟹ 宣言して
      // いないアカウントの 403 はこの本文で返る。案内は `credential.ts` と同じ
      // （`alteroid access owner <id>`）。下の `not_operator` の枝は、移す前の
      // デーモンと繋いだときのために残してある。
      if (kind === 'not_declared_owner') {
        throw new Error(
          describeAuthFailure(403, target, kind) ??
            '実行環境の持ち主として宣言されたアカウントだけが操作できます。',
        );
      }
      if (kind === 'not_operator') {
        throw new Error(
          '実行環境プロファイルを触れるのは、その実行環境の持ち主だけです。\n' +
            'デーモンが動いているのと同じ環境で実行してください:\n' +
            '  docker compose exec app alteroid profile edit\n' +
            '（人間が ~/.zshenv を直すのも、その人が持っている箱の上である、という線引きです）',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // **⭐ `kind === 'unknown'`——本文からはどちらの理由かが判別できない。**
      // 「器の中で実行しろ」と「access grant しろ」は意味も解決策も正反対で、
      // どちらかを当てずっぽうで出せば半分の状況では必ず嘘になる。分からない
      // ときは、解決策を書かずに止める。
      throw new Error(
        '実行環境プロファイルへのアクセスが拒否されました（403）。理由を判別でき' +
          'なかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      detail?: unknown;
    };
    if (typeof body.error === 'string') {
      // **伏せてから切る**（issue #2418）。`detail` はデーモンが評価したシェルの
      // stderr で、bash は構文エラーで入力の行そのもの（`export GH_TOKEN=…`）を
      // 引用する。message は画面に出る。
      const error = redactedExcerpt(body.error, ERROR_LIMIT, process.env);
      throw new Error(
        typeof body.detail === 'string' && body.detail.length > 0
          ? `${error}\n${redactedExcerpt(body.detail, DETAIL_LIMIT, process.env)}`
          : error,
      );
    }
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}

/**
 * 空から始めるときの案内。
 *
 * **「確認が要る行為の一覧」を書かせない。** ここは実行環境の宣言であって、
 * 何をしてよいかの表ではない（それはクローンが記憶で判断する）。
 */
const TEMPLATE = `# alteroid 実行環境プロファイル（人間の ~/.zprofile に当たるもの）
#
# ここに書いたものは、既定ではクローン・マネージャー・作業者のすべてに効きます
# （alteroid profile edit --scope runner のように撒く先を絞れます。
#  all=両方 / app=クローンだけ / runner=マネージャー・作業者だけ）。
# 器（コンテナ）を作り直す必要はありません。
#
# 例:
#   export SOME_API_TOKEN=xxxx
#   export PATH="$HOME/.local/bin:$PATH"
#   eval "$(some-tool env)"
#
# 注意:
# - 重い処理や、返ってこないコマンドを書かないでください（仕事を起こすたびに
#   1度評価されるので、そのぶん遅くなります）
# - 差し替えは**これから起こす仕事**に効きます。既に走っている仕事のうち、
#   次の呼び出しから拾うのは gh / git だけです
# - 記憶（人格）ではありません。価値観や「何を任せてよいか」は alteroid chat で
#   伝えてください
`;
