// `chatgptAuthTokens`（外から tokens を渡す形）は使わない: 「OPENAI INTERNAL USE ONLY - DO NOT USE」のため。
// 鍵の値（auth.json の中身）は、戻り値の authJson 以外のどこにも載せない。失敗の理由は伏せ字（redactErrorText）を通す。

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChildProcess, AgentSpawnOptions, AgentSpawnProcess } from './agent-session.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { checkCodexAuthJson } from './codex-chatgpt-auth.js';
import type { CodexAccountLoginCompletedNotification } from './codex-protocol.js';
import { redactErrorText } from './denial-input-head.js';

// 保存先を file に固定する: 既定の `auto` は keyring を選びうるが、keyring に入ると auth.json が書かれず読めないため。
export const CODEX_FILE_AUTH_STORE_OVERRIDE = 'cli_auth_credentials_store="file"';

// 15分は OpenAI のデバイスコードの寿命に合わせた見込みで、実測ではない。
export const CODEX_DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface CodexDeviceLoginStarted {
  loginId: string;
  userCode: string;
  verificationUrl: string;
}

export type CodexDeviceLoginOutcome =
  | { kind: 'succeeded'; authJson: string; email: string | null; planType: string | null }
  | { kind: 'failed'; reason: string }
  | { kind: 'canceled' }
  | { kind: 'expired' };

export interface CodexDeviceLogin {
  readonly started: CodexDeviceLoginStarted;
  readonly outcome: Promise<CodexDeviceLoginOutcome>;
  cancel(): void;
}

export interface CodexDeviceLoginFs {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<string>;
  rm(path: string): Promise<void>;
}

const defaultFs: CodexDeviceLoginFs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  readFile: (path) => readFile(path, 'utf8'),
  rm: (path) => rm(path, { recursive: true, force: true }),
};

export interface CodexDeviceLoginOptions {
  env: NodeJS.ProcessEnv;
  command?: string;
  spawnProcess?: AgentSpawnProcess;
  tmpRoot?: string;
  timeoutMs?: number;
  fs?: CodexDeviceLoginFs;
  clientVersion?: string;
}

function defaultSpawn(options: AgentSpawnOptions): AgentChildProcess {
  return spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function reasonText(error: unknown, env: NodeJS.ProcessEnv): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactErrorText(text, env);
}

export async function startCodexDeviceLogin(
  options: CodexDeviceLoginOptions,
): Promise<CodexDeviceLogin> {
  const fs = options.fs ?? defaultFs;
  const home = await fs.mkdtemp(join(options.tmpRoot ?? tmpdir(), 'alteroid-codex-login-'));
  const abort = new AbortController();
  const env: Record<string, string | undefined> = { ...options.env, CODEX_HOME: home };
  delete env['CODEX_API_KEY'];

  let child: AgentChildProcess;
  try {
    child = (options.spawnProcess ?? defaultSpawn)({
      command: options.command ?? 'codex',
      args: ['-c', CODEX_FILE_AUTH_STORE_OVERRIDE, 'app-server', '--listen', 'stdio://'],
      env,
      signal: abort.signal,
    });
  } catch (error) {
    await fs.rm(home).catch(() => undefined);
    throw new Error(`codex app-server を起こせなかった: ${reasonText(error, options.env)}`, {
      cause: error,
    });
  }
  (child as { stderr?: { resume?: () => void } }).stderr?.resume?.();
  // 未処理の 'error' で落とさない: 起動の失敗（ENOENT 等）は client が閉じとして拾うため。
  child.on('error', () => undefined);
  const client = new CodexAppServerClient(child);

  const stop = async (): Promise<void> => {
    client.close();
    try {
      child.stdin.end();
    } catch {
      // 既に閉じている。
    }
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 既に終わっている。
      }
    }
    await fs.rm(home).catch(() => undefined);
  };

  // 先に購読する: 完了の通知は開始の応答より先に届きうるため。
  const route: { completed?: (notification: CodexAccountLoginCompletedNotification) => void } = {};
  const early: CodexAccountLoginCompletedNotification[] = [];
  client.onNotificationOf('account/login/completed', (notification) => {
    if (route.completed === undefined) early.push(notification);
    else route.completed(notification);
  });

  let started: CodexDeviceLoginStarted;
  try {
    await client.initialize({
      name: 'alteroid',
      title: 'alteroid',
      version: options.clientVersion ?? '0',
    });
    const response = await client.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (response.type !== 'chatgptDeviceCode') {
      throw new Error(
        `account/login/start がデバイスコードの形で答えなかった（type=${response.type}）`,
      );
    }
    started = {
      loginId: response.loginId,
      userCode: response.userCode,
      verificationUrl: response.verificationUrl,
    };
  } catch (error) {
    await stop();
    throw new Error(
      `デバイスコードのログインを始められなかった: ${reasonText(error, options.env)}`,
      {
        cause: error,
      },
    );
  }

  let settle!: (outcome: CodexDeviceLoginOutcome) => void;
  let settled = false;
  const outcome = new Promise<CodexDeviceLoginOutcome>((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stop().then(() => resolve(value));
    };
  });

  const timer = setTimeout(() => {
    client.request('account/login/cancel', { loginId: started.loginId }).catch(() => undefined);
    settle({ kind: 'expired' });
  }, options.timeoutMs ?? CODEX_DEVICE_LOGIN_TIMEOUT_MS);
  timer.unref?.();

  const onCompleted = (notification: CodexAccountLoginCompletedNotification): void => {
    if (settled) return;
    if (
      notification.loginId !== undefined &&
      notification.loginId !== null &&
      notification.loginId !== started.loginId
    ) {
      return;
    }
    if (!notification.success) {
      settle({
        kind: 'failed',
        reason: redactErrorText(
          notification.error ?? 'ログインが成功しなかった（理由は返らなかった）',
          options.env,
        ),
      });
      return;
    }
    void (async () => {
      try {
        const account = await client.request('account/read', { refreshToken: false });
        const authJson = await fs.readFile(join(home, 'auth.json'));
        const checked = checkCodexAuthJson(authJson);
        if (!checked.ok) {
          settle({ kind: 'failed', reason: checked.reason });
          return;
        }
        const chatgpt =
          account.account !== null &&
          account.account !== undefined &&
          account.account.type === 'chatgpt'
            ? (account.account as { email?: string | null; planType?: string | null })
            : undefined;
        if (chatgpt === undefined) {
          settle({
            kind: 'failed',
            reason:
              'ログインは完了と言われたが、account/read が ChatGPT のアカウントを返さなかった',
          });
          return;
        }
        settle({
          kind: 'succeeded',
          authJson,
          email: chatgpt.email ?? null,
          planType: chatgpt.planType ?? null,
        });
      } catch (error) {
        settle({
          kind: 'failed',
          reason: `ログインの結果を読めなかった: ${reasonText(error, options.env)}`,
        });
      }
    })();
  };
  route.completed = onCompleted;
  for (const notification of early.splice(0)) onCompleted(notification);

  void client.closed.then((reason) => {
    settle({
      kind: 'failed',
      reason: `codex app-server が終わった: ${reasonText(reason, options.env)}`,
    });
  });

  return {
    started,
    outcome,
    cancel: () => {
      if (settled) return;
      client.request('account/login/cancel', { loginId: started.loginId }).catch(() => undefined);
      settle({ kind: 'canceled' });
    },
  };
}
