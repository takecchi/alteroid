/**
 * Codex の ChatGPT ログインをデバイスコードで回す（#3939。オーナー決定 2026-10-07）。
 *
 * デーモンの器で、`codex app-server` を**一時的な `CODEX_HOME`** で起こし、
 * `account/login/start { type: 'chatgptDeviceCode' }` を送る。返ってきた確認用 URL とコードを
 * 人間へ見せ、人間がブラウザで承認すると `account/login/completed` が届く。そのとき
 * 一時 `CODEX_HOME` に書かれた `auth.json` を読み、正本へ置くのは呼び出し側である。
 * **一時ディレクトリは、成功・失敗・取り消し・期限切れのどれでも消す。**
 *
 * - `chatgptAuthTokens`（外から tokens を渡す形）は「OPENAI INTERNAL USE ONLY - DO NOT USE」
 *   なので使わない（生成スキーマ 0.160.0 の `LoginAccountParams`）。
 * - 保存先は `cli_auth_credentials_store="file"` で固定する。既定の `auto` は keyring を
 *   選びうるが、keyring に入ると `auth.json` が書かれず、ここで読めない。
 * - **鍵の値（`auth.json` の中身）は、戻り値の `authJson` 以外のどこにも載せない。** 失敗の理由は
 *   app-server の文言をそのまま運ぶが、伏せ字（`redactErrorText`）を通す。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChildProcess, AgentSpawnOptions, AgentSpawnProcess } from './agent-session.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { checkCodexAuthJson } from './codex-chatgpt-auth.js';
import type { CodexAccountLoginCompletedNotification } from './codex-protocol.js';
import { redactErrorText } from './denial-input-head.js';

/** app-server を起こす引数（保存先を file に固定する）。 */
export const CODEX_FILE_AUTH_STORE_OVERRIDE = 'cli_auth_credentials_store="file"';

/** デバイスコードの待ちの既定（15分。OpenAI のデバイスコードの寿命に合わせた見込みで、実測ではない）。 */
export const CODEX_DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface CodexDeviceLoginStarted {
  /** app-server の loginId。 */
  loginId: string;
  /** 人間がブラウザで入力する1回限りのコード。 */
  userCode: string;
  /** 人間が開く確認用 URL。 */
  verificationUrl: string;
}

export type CodexDeviceLoginOutcome =
  | { kind: 'succeeded'; authJson: string; email: string | null; planType: string | null }
  | { kind: 'failed'; reason: string }
  | { kind: 'canceled' }
  | { kind: 'expired' };

export interface CodexDeviceLogin {
  readonly started: CodexDeviceLoginStarted;
  /** 決着（必ず解く。reject しない）。解いた時点で子は止まり、一時ディレクトリは消えている。 */
  readonly outcome: Promise<CodexDeviceLoginOutcome>;
  /** 取り消す。決着済みなら何もしない。 */
  cancel(): void;
}

/** 一時ディレクトリまわり（テストの差し替え口）。 */
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
  /** 子の env の土台。`CODEX_API_KEY` は外し、`CODEX_HOME` は一時ディレクトリで上書きする。 */
  env: NodeJS.ProcessEnv;
  /** 起動するコマンド（既定 `codex`）。 */
  command?: string;
  spawnProcess?: AgentSpawnProcess;
  /** 一時ディレクトリの親（既定 `os.tmpdir()`）。 */
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

/** 伏せ字を通した1行の理由。 */
function reasonText(error: unknown, env: NodeJS.ProcessEnv): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactErrorText(text, env);
}

/**
 * デバイスコードのログインを始める。確認用 URL とコードが返った時点で解く。
 * 始められなかったら（起動・`initialize`・`account/login/start` の失敗）投げる。
 * そのときも一時ディレクトリは消してある。
 */
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
    throw new Error(`codex app-server を起こせなかった: ${reasonText(error, options.env)}`);
  }
  (child as { stderr?: { resume?: () => void } }).stderr?.resume?.();
  // 起動の失敗（ENOENT 等）は client が閉じとして拾う。未処理の 'error' で落とさない。
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

  // 完了の通知は、開始の応答より先に届きうる（届いた順に配られる）ので、先に購読する。
  let completed: ((notification: CodexAccountLoginCompletedNotification) => void) | undefined;
  const early: CodexAccountLoginCompletedNotification[] = [];
  client.onNotificationOf('account/login/completed', (notification) => {
    if (completed === undefined) early.push(notification);
    else completed(notification);
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
      return; // 別のログインの決着
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
  completed = onCompleted;
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
