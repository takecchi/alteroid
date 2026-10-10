import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

import { CREDENTIAL_NAME } from '@alteroid/core/cli-light';
import { hasRunnerPushFailure } from '@alteroid/logic';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { redactError } from './redact.js';
import { readInputFile } from './input-errors.js';

interface CredentialFingerprint {
  name: string;
  sha256: string;
  updatedAt: string;
  scope: 'all' | 'app' | 'runner';
  secret: boolean;
  value?: string;
}

interface CredentialsView {
  credentials: CredentialFingerprint[];
}

interface CredentialsUpdateView {
  credentials: CredentialFingerprint[];
  runners: { runnerId: string; ok: boolean; error?: string }[];
}

export function describeScope(scope: 'all' | 'app' | 'runner'): string {
  switch (scope) {
    case 'all':
      return 'all（共通）';
    case 'app':
      return 'app（clone だけ）';
    case 'runner':
      return 'runner（manager だけ）';
    default:
      // 投げない: 古い CLI が新しいデーモンの値を知らないことがあるため
      return `未知の撒く先（${String(scope)}）`;
  }
}

export async function credentialListCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const view = (await request(target, '/credentials')) as CredentialsView;

  if (view.credentials.length === 0) {
    stdout.write('正本に置かれた環境変数はありません。\n');
    stdout.write(
      '**この状態では、マネージャーへ配られる環境変数はありません。**\n' +
        '（デーモンの器の環境変数も、runner の環境変数も配られません。正本が唯一の出所です。\n' +
        '　既存の器の GH_TOKEN などは、起動時に1度だけ正本へ移されています）\n',
    );
    stdout.write('置くには: alteroid credential set <名前> --file <path>\n');
    return;
  }

  stdout.write('\n');
  for (const entry of view.credentials) {
    stdout.write(`${entry.name}\n`);
    stdout.write(
      `  撒く先=${describeScope(entry.scope)} / ` +
        `${entry.secret ? 'シークレット' : '非シークレット'} / 更新 ${entry.updatedAt}\n`,
    );
    stdout.write(
      entry.secret
        ? `  指紋 sha256=${entry.sha256}\n`
        : `  値=${entry.value ?? '（サーバがまだ値を返していない版）'}\n`,
    );
  }
  stdout.write('\n');
  stdout.write(
    '届いているかは runner 側の指紋と突き合わせます: alteroid runners\n' +
      '（値はどちらにも出ません。指紋が一致していれば同じものです）\n',
  );
}

export async function credentialSetCommand(
  name: string,
  options: { file?: string; scope?: string; secret?: boolean; yes?: boolean },
  io?: ConfirmIo,
): Promise<void> {
  if (
    options.scope !== undefined &&
    options.scope !== 'all' &&
    options.scope !== 'app' &&
    options.scope !== 'runner'
  ) {
    throw new Error(
      `--scope は all / app / runner のいずれかである（渡されたのは ${options.scope}）`,
    );
  }

  // 名前の形を値より先に見る: 空の標準入力で「値が空」とだけ言われて、本当の誤りが隠れるため
  if (!CREDENTIAL_NAME.test(name)) {
    throw new Error(
      `名前 <name> は英大文字で始まり、英大文字・数字・_ だけで書く（渡されたのは ${name}。例: GH_TOKEN）`,
    );
  }

  // 確認は入力を読む前に出す: 標準入力を読み切ると、端末の `yes` を聞けないため
  const target = await resolveTarget();
  // 確認と標準入力の読み取りより前に断る: 読み切ってから落ちると、渡した値が無駄になり理由も遅れるため
  if (target.note !== null) throw new Error(target.note);
  const current = (await request(target, '/credentials')) as CredentialsView;
  if (current.credentials.some((entry) => entry.name === name)) {
    await confirmIrreversible(
      `環境変数 ${name} を置き換えます。前の値は残らず、読み出せないので戻すには元の値が要ります（runner の器の値も入れ替わります）。`,
      options,
      io,
    );
  }

  const raw =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  // `trim()` しない: 内側の空白は値の一部でありうる（末尾の改行だけ落とす）
  const value = raw.replace(/\r?\n$/, '');
  if (value.length === 0) {
    throw new Error(
      '値が空である（ファイルか標準入力から、空でない値を渡す）。' +
        `外すなら: alteroid credential remove ${name}`,
    );
  }

  const view = (await put(target, [
    {
      name,
      value,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.secret === undefined ? {} : { secret: options.secret }),
    },
  ])) as CredentialsUpdateView;
  stdout.write(
    hasRunnerPushFailure(view)
      ? `警告: ${name} は正本に置きましたが、一部の runner へ反映できていません。\n`
      : `${name} を置きました。\n`,
  );
  reportRunners(view);
  failOnPartialPush(view);
}

export async function credentialRemoveCommand(
  name: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  // 確認を出す前に断る: 未ログインのまま「外してよいか」を聞くのは無意味なため
  if (target.note !== null) throw new Error(target.note);
  const current = (await request(target, '/credentials')) as CredentialsView;
  if (!current.credentials.some((entry) => entry.name === name)) {
    // 無い名前を成功にしない: 打ち間違いが成功と同じ終わり方になるため
    throw new Error(
      `${name} は正本に置かれていません。\n` +
        'なおデーモン（クローン）の環境変数に同じ名前が在れば、そちらが配られます' +
        '（この口が持つのは正本の側だけです）。',
    );
  }

  await confirmIrreversible(
    `環境変数 ${name} を外します。値は読み出せないので、戻すには元の値が要ります（runner の器からも消えます）。`,
    options,
  );

  const view = (await put(target, [{ name, value: '' }])) as CredentialsUpdateView;
  stdout.write(
    hasRunnerPushFailure(view)
      ? `警告: ${name} は正本から外しましたが、一部の runner へ反映できていません。\n`
      : `${name} を外しました。\n`,
  );
  reportRunners(view);
  failOnPartialPush(view);
}

function failOnPartialPush(view: CredentialsUpdateView): void {
  if (!hasRunnerPushFailure(view)) return;
  throw new Error(
    'runner への反映が一部失敗しました（正本への保存は済んでいます。失敗した runner へは次に名乗ったときに降ろし直します）',
  );
}

function reportRunners(view: CredentialsUpdateView): void {
  if (view.runners.length === 0) {
    stdout.write('（runner が1台も繋がっていないので、配布はしていません。正本には在ります）\n');
    return;
  }
  for (const runner of view.runners) {
    stdout.write(
      runner.ok
        ? `  ${runner.runnerId}: 降ろしました\n`
        : `  ${runner.runnerId}: 降ろせませんでした（次に名乗ったときに追いつきます）: ${runner.error === undefined ? '理由不明' : redactError(runner.error)}\n`,
    );
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function put(
  target: Target,
  credentials: { name: string; value: string; scope?: string; secret?: boolean }[],
) {
  return request(target, '/credentials', {
    method: 'PUT',
    body: JSON.stringify({ credentials }),
  });
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 403) {
      // 403 の本文を見ずに固定の文言を出さない: 理由が複数あり、誤った案内になるため
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // `not_operator` と `unknown` は案内を出さずに止める: どの手順で直るか判別できないため
      throw new Error(
        'マネージャーへ降ろす環境変数へのアクセスが拒否されました（403）。' +
          '理由を判別できなかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(redactError(body.error));
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
