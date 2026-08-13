import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { clearCredential, readCredential, writeCredential } from './credentials.js';
import { resolveTarget, type Target } from './target.js';

/**
 * `alteroid login` — ブラウザでログインして、この端末用のアクセストークンを貰う。
 *
 * `gh auth login` と同じ形にしてある。**デーモンがコールバックを受ける**ので、
 * 端末側にサーバを立てない（プロバイダに登録する戻り先が1本で済み、
 * `redirect_uri` の不一致という一番よくある事故が構造的に起きない）。
 *
 * トークンは**引き取り経路でだけ**渡る。ブラウザの URL には載せない — 履歴と
 * Referer に鍵が残るため。
 */

interface HealthResponse {
  auth?: { enabled?: boolean; providers?: { id: string; label: string; kind: string }[] };
}

interface StartResponse {
  requestId: string;
  authorizationUrl: string;
  claimSecret: string;
  expiresAt: string;
}

type ClaimResponse =
  | { status: 'pending' }
  | {
      status: 'ready';
      token: string;
      account: { id: string; email: string | null; displayName: string | null };
      granted: boolean;
    };

const POLL_INTERVAL_MS = 1500;

export async function loginCommand(options: { provider?: string }): Promise<void> {
  const target = await resolveTarget();

  const health = (await getJson(target, '/health')) as HealthResponse;
  const providers = health.auth?.providers ?? [];
  if (health.auth?.enabled !== true && providers.length === 0) {
    stdout.write(
      `${target.baseUrl} は認証を要求していません（ログインは不要です）。\n` +
        'Google ログインを有効にするには、デーモン側で ALTEROID_GOOGLE_CLIENT_ID と\n' +
        'ALTEROID_GOOGLE_CLIENT_SECRET を設定してください。\n',
    );
    return;
  }
  if (providers.length === 0) {
    throw new Error('このデーモンにはログイン手段が設定されていません');
  }

  const provider = options.provider ?? providers[0]?.id;
  if (provider === undefined || !providers.some((it) => it.id === provider)) {
    throw new Error(
      `使えるログイン手段: ${providers.map((it) => it.id).join(', ')}（--provider で指定します）`,
    );
  }

  const started = (await postJson(target, '/auth/login', {
    provider,
    label: `${process.env.USER ?? 'cli'}@${hostname()}`,
  })) as StartResponse;

  stdout.write('ブラウザでログインしてください:\n');
  stdout.write(`  ${started.authorizationUrl}\n\n`);
  openBrowser(started.authorizationUrl);
  stdout.write('ブラウザでの操作を待っています…\n');

  const deadline = Date.parse(started.expiresAt);
  for (;;) {
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      throw new Error('ログインの期限が切れました（alteroid login をやり直してください）');
    }
    await sleep(POLL_INTERVAL_MS);

    const response = await fetch(`${target.baseUrl}/auth/login/${started.requestId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimSecret: started.claimSecret }),
    });
    if (response.status === 202) continue;
    if (!response.ok) {
      throw new Error(`ログインに失敗しました: ${await errorText(response)}`);
    }

    const result = (await response.json()) as ClaimResponse;
    if (result.status === 'pending') continue;

    const label = result.account.email ?? result.account.displayName ?? result.account.id;
    await writeCredential(target.baseUrl, {
      token: result.token,
      accountId: result.account.id,
      label,
      createdAt: new Date().toISOString(),
    });

    stdout.write(`\nログインしました: ${label}\n`);
    if (result.granted) {
      stdout.write('このアカウントは alteroid を使えます。\n');
    } else {
      // ここで黙って終わると「ログインできたのに動かない」になる。何をすれば
      // 使えるようになるかまで書く。
      stdout.write(
        '\nただし、まだ alteroid を使う許可がありません。\n' +
          'デーモンが動いている環境で次を実行してください:\n' +
          `  alteroid access grant ${result.account.id}\n`,
      );
    }
    return;
  }
}

export async function logoutCommand(): Promise<void> {
  const target = await resolveTarget();
  const removed = await clearCredential(target.baseUrl);
  stdout.write(
    removed
      ? `${target.baseUrl} のログイン情報を消しました\n`
      : `${target.baseUrl} のログイン情報はありません\n`,
  );
  if (!target.remote) {
    // 手元のデーモンは状態ファイルの token で通るので、消しても繋がり続ける。
    // 黙っていると「ログアウトしたのに使える」と見え、境界を誤解させる。
    stdout.write(
      '（手元のデーモンへは、実行環境の持ち主として引き続き接続できます。\n' +
        ' これは ~/.alteroid/state/daemon.json を読めることに基づく資格です）\n',
    );
  }
}

export async function whoamiCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }

  const me = (await getJson(target, '/auth/me')) as
    | { kind: 'operator' }
    | {
        kind: 'account';
        account: { id: string; email: string | null; displayName: string | null };
        granted: boolean;
      };

  stdout.write(`接続先: ${target.baseUrl}\n`);
  if (me.kind === 'operator') {
    stdout.write('資格: 実行環境の持ち主（state/daemon.json を読めること）\n');
    return;
  }
  const stored = await readCredential(target.baseUrl);
  stdout.write(`資格: ${me.account.email ?? me.account.displayName ?? me.account.id}\n`);
  stdout.write(`  アカウント id: ${me.account.id}\n`);
  stdout.write(`  許可: ${me.granted ? 'あり' : 'なし（alteroid access grant が要る）'}\n`);
  if (stored !== null) stdout.write(`  ログイン日時: ${stored.createdAt}\n`);
}

// ---------------------------------------------------------------------------

async function getJson(target: Target, path: string): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, { headers: target.headers });
  if (!response.ok) throw new Error(`${path} が失敗しました: ${await errorText(response)}`);
  return response.json();
}

async function postJson(target: Target, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    method: 'POST',
    headers: { ...target.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} が失敗しました: ${await errorText(response)}`);
  return response.json();
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return `${response.status} ${body.error}`;
  } catch {
    // JSON でない応答（HTML など）はそのまま状態コードだけ見せる
  }
  return String(response.status);
}

/**
 * ブラウザを開く。**開けなくても失敗にしない** — URL は既に表示済みで、
 * 人間が手で開けば同じように進む（SSH 越しやコンテナ内では開けないのが普通）。
 */
function openBrowser(url: string): void {
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 表示済みの URL を人間が開けばよい
  }
}
