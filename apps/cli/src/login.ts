import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { stdout } from './terminal-out.js';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  clearCredential,
  CredentialsUnreadableError,
  readCredential,
  writeCredential,
} from './credentials.js';
import { redactedErrorMessage, redactError } from './redact.js';
import { isRunnerContainer, resolveTarget, type Target } from './target.js';

// 端末側にサーバを立てない: プロバイダに登録する戻り先が1本で済み、`redirect_uri` の不一致が起きないため
// トークンをブラウザの URL に載せない: 履歴と Referer に鍵が残るため

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
  let lastTransient: string | null = null;
  for (;;) {
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      throw new Error(
        'ログインの期限が切れました（alteroid login をやり直してください）' +
          (lastTransient === null ? '' : `\n最後に繋がらなかった理由: ${lastTransient}`),
      );
    }
    await sleep(POLL_INTERVAL_MS);

    // 200 を受けた後の失敗は再試行しない: ready を返す1回で要求が consumed になり、二度目は 400 になるため
    let response: Response;
    try {
      response = await fetch(`${target.baseUrl}/auth/login/${started.requestId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimSecret: started.claimSecret }),
      });
    } catch (error) {
      lastTransient = `${target.baseUrl} に届きませんでした（${redactedErrorMessage(error)}）`;
      stdout.write(`デーモンに繋がらない。待ちを続けています…（${lastTransient}）\n`);
      continue;
    }
    if (response.status === 202) continue;
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      lastTransient = await errorText(response);
      stdout.write(`デーモンが一時的に応答しない。待ちを続けています…（${lastTransient}）\n`);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `ログインに失敗しました: ${await errorText(response)}` +
          (lastTransient === null
            ? ''
            : '\n直前に通信失敗があったため、その claim が応答を返せないまま引き取り済みに' +
              'なった可能性があります。alteroid login をやり直してください。'),
      );
    }

    let result: ClaimResponse;
    try {
      result = (await response.json()) as ClaimResponse;
    } catch (error) {
      throw new Error(
        `ログイン結果の応答を読めませんでした（${redactedErrorMessage(error)}）。` +
          'この要求は引き取り済みの可能性があり、再試行では取れません。' +
          'alteroid login をやり直してください。',
        { cause: error },
      );
    }
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
      // 黙って終わらない: 「ログインできたのに動かない」になるため
      stdout.write(
        '\nただし、まだ alteroid を使う許可がありません。\n' +
          'デーモンが動いている環境で次を実行してください:\n' +
          `  alteroid access grant ${result.account.id}\n` +
          '（既に別のアカウントが許可されていても構いません。許可できるアカウントの\n' +
          ' 数に上限はなく、同じ人が複数のログイン手段から入れます）\n',
      );
    }
    return;
  }
}

type ServerLogoutOutcome =
  { kind: 'revoked' } | { kind: 'already-invalid' } | { kind: 'failed'; detail: string };

async function requestServerLogout(baseUrl: string, token: string): Promise<ServerLogoutOutcome> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (error) {
    return {
      kind: 'failed',
      detail: `${baseUrl} に届きませんでした（${redactedErrorMessage(error)}）`,
    };
  }
  if (response.ok) return { kind: 'revoked' };
  if (response.status === 401) return { kind: 'already-invalid' };
  return { kind: 'failed', detail: await errorText(response) };
}

export async function logoutCommand(options: { localOnly?: boolean } = {}): Promise<void> {
  const target = await resolveTarget();

  const operatorNote = (): void => {
    if (!target.remote) {
      // 黙らない: 「ログアウトしたのに使える」と見え、境界を誤解させるため
      stdout.write(
        '（手元のデーモンへは、実行環境の持ち主として引き続き接続できます。\n' +
          ' これは ~/.alteroid/state/daemon.json を読めることに基づく資格です）\n',
      );
    }
  };

  if (options.localOnly === true) {
    // `--local-only` ではトークンを読みに行かない: `readCredential` は壊れた・読めないファイルで投げるため
    const quarantinedTo: string[] = [];
    const removed = await clearCredential(target.baseUrl, (dest) => {
      quarantinedTo.push(dest);
    });
    if (removed === false && quarantinedTo.length === 0) {
      stdout.write(`${target.baseUrl} のログイン情報はありません\n`);
      operatorNote();
      return;
    }
    stdout.write(
      '⚠ --local-only: サーバ側のトークンは失効させていません' +
        '（期限が来るか、alteroid access revoke で失効するまで有効なままです）。\n' +
        `${target.baseUrl} の手元のログイン情報だけを消しました\n`,
    );
    if (quarantinedTo.length > 0) {
      stdout.write(
        '資格情報のファイルが壊れていたため、退避して空から始め直しました' +
          `（退避先: ${quarantinedTo[0]}）。ほかの接続先のログイン情報も空になっています。\n`,
      );
    }
    operatorNote();
    return;
  }

  let stored: Awaited<ReturnType<typeof readCredential>>;
  try {
    stored = await readCredential(target.baseUrl);
  } catch (error) {
    if (error instanceof CredentialsUnreadableError && error.reason === 'corrupt') {
      throw new CredentialsUnreadableError(
        error.reason,
        `${error.message}\n` +
          'サーバ側のトークンを失効させるには、そのトークンを読める必要があります。' +
          '手元の資格だけを消すなら alteroid logout --local-only です' +
          '（壊れたファイルは退避され、ほかの接続先のログイン情報も空になります。' +
          'サーバ側のトークンは失効しません）。',
      );
    }
    throw error;
  }

  if (stored === null) {
    stdout.write(`${target.baseUrl} のログイン情報はありません\n`);
    operatorNote();
    return;
  }

  const outcome = await requestServerLogout(target.baseUrl, stored.token);
  if (outcome.kind === 'failed') {
    // 手元の資格を消さない: サーバ側で未失効のまま、失効させる手段が `alteroid access revoke` しか残らないため
    throw new Error(
      `サーバ側のトークンをまだ失効できていません: ${outcome.detail}\n` +
        'もう一度試すか、--local-only を付けて手元だけを消してください' +
        '（その場合、トークンは期限が来るか alteroid access revoke で失効するまで有効です）。',
    );
  }

  await clearCredential(target.baseUrl);
  stdout.write(
    outcome.kind === 'revoked'
      ? `サーバ側のトークンを失効させ、${target.baseUrl} のログイン情報を消しました\n`
      : `サーバ側では既に無効でした。${target.baseUrl} のログイン情報を消しました\n`,
  );
  operatorNote();
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
  if (!target.remote && isRunnerContainer()) {
    stdout.write('この接続は runner の器の中の手元のデーモンです（本番ではありません）\n');
  }
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
    if (typeof body.error === 'string') return `${response.status} ${redactError(body.error)}`;
  } catch {
    // JSON でない応答（HTML など）はそのまま状態コードだけ見せる
  }
  return String(response.status);
}

// 開けなくても失敗にしない: URL は表示済みで、SSH 越しやコンテナ内では開けないのが普通のため
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
