import { randomUUID } from 'node:crypto';

import { fingerprintOf } from './credentials.js';

// 環境変数の袋（`credentials`）に入れない: 袋の値は子プロセスの環境変数として降りてしまうし、袋の口は全文置換で版を持たず compare-and-swap できないため。
// auth.json の値は秘密。外へ出してよいのは CodexChatgptAuthStatus だけ。

export const CODEX_CHATGPT_AUTH_NAME = 'CODEX_CHATGPT_AUTH';

export const CODEX_CHATGPT_AUTH_MAX_BYTES = 64 * 1024;

export interface CodexChatgptAuthFailure {
  at: string;
  /** 鍵の値を含めない。 */
  reason: string;
}

export interface CodexChatgptAuthRecord {
  /** 秘密。API・CLI・Web・日誌・ログのどこにも返さない。 */
  value: string;
  // 連番にしない: ログアウト → 再ログインで同じ版が蘇ると、ログアウト前に配った runner の古い書き戻しが一致してしまうため。
  revision: string;
  updatedAt: string;
  email: string | null;
  planType: string | null;
  failure: CodexChatgptAuthFailure | null;
}

// 書き戻しは複数の runner が同じログインを取り合うので、compareAndSwap だけを使う: 古い値が新しい値を潰さないため。
export interface CodexChatgptAuthStore {
  get(): Promise<CodexChatgptAuthRecord | null>;
  replace(record: CodexChatgptAuthRecord): Promise<void>;
  compareAndSwap(expectedRevision: string, next: CodexChatgptAuthRecord): Promise<boolean>;
  remove(): Promise<boolean>;
}

// 値を持たない（外へ出してよい形）。
export interface CodexChatgptAuthStatus {
  loggedIn: boolean;
  email: string | null;
  planType: string | null;
  updatedAt: string | null;
  fingerprint: string | null;
  failure: CodexChatgptAuthFailure | null;
}

export function codexChatgptAuthStatusOf(
  record: CodexChatgptAuthRecord | null,
): CodexChatgptAuthStatus {
  if (record === null) {
    return {
      loggedIn: false,
      email: null,
      planType: null,
      updatedAt: null,
      fingerprint: null,
      failure: null,
    };
  }
  return {
    loggedIn: true,
    email: record.email,
    planType: record.planType,
    updatedAt: record.updatedAt,
    fingerprint: fingerprintOf(record.value),
    failure: record.failure,
  };
}

export function newCodexChatgptAuthRevision(): string {
  return randomUUID();
}

// 中の欄の形は決め打ちしない（Codex の版で変わりうる）。理由の文に値を載せない。
export function checkCodexAuthJson(text: string): { ok: true } | { ok: false; reason: string } {
  if (Buffer.byteLength(text, 'utf8') > CODEX_CHATGPT_AUTH_MAX_BYTES) {
    return {
      ok: false,
      reason: `auth.json が大きすぎる（上限 ${String(CODEX_CHATGPT_AUTH_MAX_BYTES)} バイト）`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'auth.json が JSON として読めない' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'auth.json が JSON のオブジェクトではない' };
  }
  return { ok: true };
}

export function describeCodexChatgptAuth(status: CodexChatgptAuthStatus): string {
  if (!status.loggedIn) {
    return (
      'Codex の ChatGPT ログイン: なし' +
      '（runner に CODEX_API_KEY が届いていれば、マネージャーの peer はそれで開いて走る）'
    );
  }
  const who = [status.email ?? '(アカウント不明)', status.planType ?? '(プラン不明)'].join('・');
  const base =
    `Codex の ChatGPT ログイン: あり（${who}。最終更新 ${status.updatedAt ?? '(不明)'}）` +
    // 「使える」と断定しない: 器ごとに開いているかは名乗りで決まり、ここからは分からないため
    '\n  Codex を頼む口は runner のマネージャーの peer だけで、このログインが runner に届くと開く' +
    '（器ごとに開いているか・閉じている理由は runner_list の peer の行）。' +
    'クローンはマネージャーへの依頼として頼む。この器で `codex` を直接叩くと未ログインと出るのは設計どおり';
  if (status.failure === null) return base;
  return (
    `${base}\n⚠ 切れている・失効した・更新に失敗した（${status.failure.at}）: ${status.failure.reason}` +
    '\n  → 人間に再ログインを頼むこと（`alteroid codex login` か Web の「設定 — Codex」）'
  );
}
