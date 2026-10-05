import { REMOTE_URL_ENV } from './target.js';
import { redactError } from './redact.js';

/**
 * 入口（`index.ts` の最上位の catch）が stderr へ出す、失敗の文（#2855）。
 *
 * 2つを直す。
 * - 接続できなかった（undici の `TypeError: fetch failed`）を、何が起きて次に何をするかの
 *   日本語にする。型名・`fetch failed`・cause の識別子（`ECONNREFUSED` など）は出さない。
 * - `String(error)` が付ける `Error:` / `TypeError:` の接頭辞を出さない（メッセージだけ）。
 *
 * 伏せ字（{@link redactError}）は最後に通す。接続先の URL は origin だけを載せる
 * （userinfo・パス・クエリは出さない）。
 */

/** fetch が「繋がらなかった」ときの形（undici は `TypeError('fetch failed')` に cause を載せる）。 */
function isConnectionFailure(error: unknown): error is TypeError {
  return error instanceof TypeError && error.message === 'fetch failed';
}

function causeCodeOf(error: Error): string | undefined {
  const cause: unknown = error.cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function reasonOf(code: string | undefined): string {
  switch (code) {
    case 'ECONNREFUSED':
      return '接続を断られました';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'ホスト名を引けませんでした';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '応答がありませんでした';
    default:
      return '繋がりませんでした';
  }
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function describeConnectionFailure(
  error: TypeError,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const reason = reasonOf(causeCodeOf(error));
  const remote = (env[REMOTE_URL_ENV] ?? '').trim();
  if (remote.length > 0) {
    const origin = originOf(remote);
    return (
      `接続先${origin === null ? '' : `（${origin}）`}に繋がりませんでした（${reason}）。\n` +
      `${REMOTE_URL_ENV} の値が合っているか、サーバが動いているかを確かめてください。`
    );
  }
  return (
    `手元のデーモンに繋がりませんでした（${reason}）。\n` +
    'alteroid daemon status で状態を確かめ、止まっていれば alteroid daemon start で起こしてください。'
  );
}

export function describeCliFailure(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (isConnectionFailure(error)) return redactError(describeConnectionFailure(error, env));
  return redactError(error instanceof Error ? error.message : String(error));
}
