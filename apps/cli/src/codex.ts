import { stdout } from './terminal-out.js';

import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { redactError } from './redact.js';

/**
 * `alteroid codex login|status|logout`（#3939）。Codex を ChatGPT のサブスクリプション（ChatGPT
 * ログイン）で動かすための資格を、デーモンの正本に置く・見る・消す。口は HTTP（`/codex/*`）・
 * Web と同じ API の上に乗る（片方でしかできないことを作らない）。**値は1文字も出さない。**
 */

interface CodexAuthStatus {
  loggedIn: boolean;
  email: string | null;
  planType: string | null;
  updatedAt: string | null;
  fingerprint: string | null;
  failure: { at: string; reason: string } | null;
}

interface CodexLoginView {
  id: string;
  state: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'expired';
  verificationUrl: string;
  userCode: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function describeCodexAuthStatus(status: CodexAuthStatus): string {
  if (!status.loggedIn) {
    return (
      'Codex の ChatGPT ログイン: なし\n' +
      '（正本の CODEX_API_KEY が runner に届いていれば、マネージャーの peer はそれで開いて走る）\n' +
      'ログインするには: alteroid codex login\n'
    );
  }
  const lines = [
    'Codex の ChatGPT ログイン: あり',
    `  アカウント ${status.email ?? '(不明)'} / プラン ${status.planType ?? '(不明)'}`,
    `  最終更新 ${status.updatedAt ?? '(不明)'} / 指紋 sha256=${status.fingerprint ?? '(不明)'}`,
    '  （CODEX_API_KEY が正本に在れば、そちらが先に使われる）',
    // 開く条件はこのログイン（#4118）。器ごとに開いたかは runner の名乗りにしか無い
    '  マネージャーの peer（Codex）は、このログインが runner に届くと開く（器ごとの開閉は alteroid runners）',
  ];
  if (status.failure !== null) {
    lines.push(
      `⚠ 切れている・失効した・更新に失敗した（${status.failure.at}）: ${redactError(status.failure.reason)}`,
      '  再ログインするには: alteroid codex login',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function codexStatusCommand(): Promise<void> {
  const target = await resolveTarget();
  const status = (await request(target, '/codex/auth')) as CodexAuthStatus;
  stdout.write(describeCodexAuthStatus(status));
}

export interface CodexLoginOptions {
  /** 進み具合を見に行く間隔（既定 2 秒）。 */
  pollMs?: number;
  /** 待ち（テストの差し替え口）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 取り消しの合図（既定は Ctrl-C）。 */
  signal?: AbortSignal;
}

export async function codexLoginCommand(options: CodexLoginOptions = {}): Promise<void> {
  const target = await resolveTarget();
  const view = (await request(target, '/codex/login', { method: 'POST' })) as CodexLoginView;
  stdout.write(
    '\nブラウザで次の URL を開き、コードを入力してください（ChatGPT のアカウントで承認する）:\n\n' +
      `  ${view.verificationUrl}\n\n` +
      `  コード: ${view.userCode}\n\n` +
      '承認を待っています（Ctrl-C で取り消す）…\n',
  );

  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  if (options.signal === undefined) process.once('SIGINT', onSigint);
  const signal = options.signal ?? controller.signal;
  try {
    let current = view;
    while (current.state === 'pending') {
      if (signal.aborted) {
        current = (await request(target, `/codex/login/${encodeURIComponent(view.id)}`, {
          method: 'DELETE',
        })) as CodexLoginView;
        break;
      }
      await sleep(options.pollMs ?? 2000);
      current = (await request(
        target,
        `/codex/login/${encodeURIComponent(view.id)}`,
      )) as CodexLoginView;
    }
    switch (current.state) {
      case 'succeeded': {
        stdout.write('ログインしました。正本に置き、runner へ降ろしました。\n');
        const status = (await request(target, '/codex/auth')) as CodexAuthStatus;
        stdout.write(describeCodexAuthStatus(status));
        return;
      }
      case 'canceled':
        throw new Error('ログインを取り消しました（正本は変わっていません）。');
      case 'expired':
        throw new Error(
          'コードの期限が切れました（正本は変わっていません）。もう一度: alteroid codex login',
        );
      default:
        throw new Error(
          `ログインに失敗しました（正本は変わっていません）: ${redactError(current.error ?? '理由不明')}`,
        );
    }
  } finally {
    if (options.signal === undefined) process.off('SIGINT', onSigint);
  }
}

export async function codexLogoutCommand(
  options: { yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const target = await resolveTarget();
  const status = (await request(target, '/codex/auth')) as CodexAuthStatus;
  if (!status.loggedIn) {
    stdout.write('Codex の ChatGPT ログインは正本に在りません（何もしていません）。\n');
    return;
  }
  await confirmIrreversible(
    'Codex の ChatGPT ログインを正本から消し、全 runner から外します。戻すにはもう一度ログインが要ります。',
    options,
    io,
  );
  const result = (await request(target, '/codex/auth', { method: 'DELETE' })) as {
    removed: boolean;
  };
  stdout.write(
    result.removed
      ? 'Codex の ChatGPT ログインを消しました（runner からも外しました）。\n'
      : 'Codex の ChatGPT ログインは既にありませんでした。\n',
  );
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(redactError(body.error));
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
