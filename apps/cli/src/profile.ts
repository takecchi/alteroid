import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { describeAuthFailure, resolveTarget, type Target } from './target.js';

/**
 * `alteroid profile` — 実行環境プロファイル（人間の `.zprofile` に当たるもの）。
 *
 * **これは「環境変数を器に増やす」の代わりである。** 道具の鍵を1つ足すたびに
 * `compose.yaml` を直して器を焼き直すのは、人間が自分の端末で `~/.zshenv` に
 * 1行足せば済ませていることを実装作業に変えてしまっている、ということである。
 * それはデグレードなので、口をここに開けてある。
 *
 * 置いたものはクローンにもマネージャーにも作業者にも効き、**器を作り直さずに
 * 差し替えられる**（走行中のマネージャーにも次のコマンドから届く）。
 */

interface ProfileView {
  script: string;
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
  sha256?: string;
  bytes?: number;
  clone: ApplyResult;
  runners: (ApplyResult & { runnerId: string })[];
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
  }

  // **どの runner に何が届いているかを見せる。** 見えないと「置いた」「効いて
  // いない」のすれ違いが起きて、鍵の権限の問題なのか配布の問題なのかを誰も
  // 切り分けられない（鍵の指紋を出しているのと同じ理由）。
  const { runners } = (await request(target, '/runners')) as {
    runners: { runnerId: string; profile?: { sha256: string; updatedAt: string } }[];
  };
  for (const runner of runners) {
    stdout.write(
      runner.profile === undefined
        ? `  ${runner.runnerId}: プロファイル無し\n`
        : `  ${runner.runnerId}: sha256 ${runner.profile.sha256} (${runner.profile.updatedAt})\n`,
    );
  }
}

/** ファイルか標準入力から丸ごと置き換える。 */
export async function profileSetCommand(options: { file?: string }): Promise<void> {
  const script =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  await put(script);
}

/** いま置いてあるものを `$EDITOR` で開いて、閉じたら反映する。 */
export async function profileEditCommand(): Promise<void> {
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

    if (edited === current.script) {
      stdout.write('変更はありません。\n');
      return;
    }
    await put(edited, target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function profileClearCommand(): Promise<void> {
  await put('');
}

async function put(script: string, known?: Target): Promise<void> {
  const target = known ?? (await resolveTarget());
  const result = (await request(target, '/profile', {
    method: 'PUT',
    body: JSON.stringify({ script }),
  })) as UpdateView;

  if (script.trim().length === 0) {
    stdout.write('プロファイルを外しました。\n');
  } else {
    stdout.write(`プロファイルを更新しました (sha256 ${result.sha256 ?? '?'})\n`);
  }

  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);

  // **走行中のマネージャーにも届く**ことを言っておく。器を焼き直す手順を
  // 探させないためで、これが無いと「反映には再デプロイが要る」と思われる。
  if (script.trim().length > 0) {
    stdout.write('（走行中のマネージャーにも、次のコマンドから効きます）\n');
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
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      detail?: unknown;
    };
    if (typeof body.error === 'string') {
      throw new Error(
        typeof body.detail === 'string' && body.detail.length > 0
          ? `${body.error}\n${body.detail}`
          : body.error,
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
# ここに書いたものは、クローン・マネージャー・作業者のすべてに効きます。
# 器（コンテナ）を作り直す必要はありません。走行中のマネージャーにも、
# 次に走るコマンドから届きます。
#
# 例:
#   export SOME_API_TOKEN=xxxx
#   export PATH="$HOME/.local/bin:$PATH"
#   eval "$(some-tool env)"
#
# 注意:
# - このファイルは毎コマンド読み直されます。重い処理や、返ってこないコマンドを
#   書かないでください（1コマンドごとにそれだけ遅くなります）
# - 記憶（人格）ではありません。価値観や「何を任せてよいか」は alteroid chat で
#   伝えてください
`;
