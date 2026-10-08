import { randomUUID } from 'node:crypto';

import { fingerprintOf } from './credentials.js';

/**
 * Codex の ChatGPT ログイン（`CODEX_HOME/auth.json` の中身）の正本の形（#3939）。
 *
 * **値（`auth.json` の中身）は秘密である。** API・CLI・Web・日誌・ログのどこにも返さない。
 * 外へ出してよいのは {@link CodexChatgptAuthStatus}（ログイン済みか・アカウント・プラン・
 * 最終更新・指紋・最後の失敗）だけ。
 *
 * ## なぜ環境変数の袋（`credentials`）に入れないか
 *
 * 袋の値は runner の子プロセスの環境変数として降りる（`Host#childEnv`）。この値は
 * Codex が `CODEX_HOME/auth.json` から読むもので、子の環境変数に置く理由が無い
 * （`CODEX_API_KEY` を子の env から外しているのと同じ考え。`codex-manager-driver.ts` の
 * `childEnvOf`）。そして書き戻し（Codex がトークンを更新して `auth.json` を書き換えたもの）を
 * 「読んだ版と同じなら上書き」（compare-and-swap）で受ける必要がある。袋の口は全文置換で、
 * 版を持たない。
 */

/** 正本の名前（人間が読む。状態の表示・日誌に出る名前で、環境変数の名前ではない）。 */
export const CODEX_CHATGPT_AUTH_NAME = 'CODEX_CHATGPT_AUTH';

/** `auth.json` の中身の上限（バイト）。実物は数 KB。巨大な本文で器を埋めない。 */
export const CODEX_CHATGPT_AUTH_MAX_BYTES = 64 * 1024;

/** 切れた・失効した・更新に失敗した事実。**再ログイン（`replace`）で消える。** */
export interface CodexChatgptAuthFailure {
  at: string;
  /** 伏せ字を通した理由（鍵の値を含めない）。 */
  reason: string;
}

/** 正本の1行（高々1つ）。 */
export interface CodexChatgptAuthRecord {
  /** `auth.json` の中身。**秘密。** */
  value: string;
  /**
   * 版。**書き換えるたびに新しい値になる不透明な文字列**（compare-and-swap の鍵）。
   * 連番にしないのは、ログアウト → 再ログインで同じ版が蘇り、ログアウト前に配った
   * runner の古い書き戻しが一致してしまうのを避けるため。
   */
  revision: string;
  /** 値が最後に変わった時刻（ログイン・書き戻し）。 */
  updatedAt: string;
  /** ログインしたアカウント（`account/read` の `email`）。取れなければ `null`。 */
  email: string | null;
  /** プラン（`account/read` の `planType`）。取れなければ `null`。 */
  planType: string | null;
  failure: CodexChatgptAuthFailure | null;
}

/**
 * 正本の置き場。**3実装（fs / pg / テスト用のメモリ）とも同じ IF を満たす。**
 *
 * 書き戻しは5台の runner が同じログインを取り合う前提で、{@link compareAndSwap} だけを使う
 * （読んだ版と同じときだけ置く）。古い値が新しい値を潰さない。
 */
export interface CodexChatgptAuthStore {
  get(): Promise<CodexChatgptAuthRecord | null>;
  /** 無条件に置く（新しいログイン）。 */
  replace(record: CodexChatgptAuthRecord): Promise<void>;
  /**
   * いまの版が `expectedRevision` のときだけ `next` を置く。置けたら `true`。
   * 行が無い・版が違うなら何もせず `false`。
   */
  compareAndSwap(expectedRevision: string, next: CodexChatgptAuthRecord): Promise<boolean>;
  /** 消す（ログアウト）。消したなら `true`。 */
  remove(): Promise<boolean>;
}

/** 外へ出してよい形（値を持たない）。 */
export interface CodexChatgptAuthStatus {
  loggedIn: boolean;
  email: string | null;
  planType: string | null;
  updatedAt: string | null;
  /** 値の指紋（sha256 の先頭12桁。`token_list` と同じ `fingerprintOf`）。 */
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

/**
 * `auth.json` の中身として受け取れるかを見る。**中の欄の形は決め打ちしない**（Codex の版で
 * 変わりうるので、読むのは Codex 自身である）。見るのは「JSON のオブジェクトである」と大きさだけ。
 * 理由の文に値を載せない。
 */
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

/** 状態を1行の日本語で（`self_status`・CLI が使う）。値は載せない。 */
export function describeCodexChatgptAuth(status: CodexChatgptAuthStatus): string {
  if (!status.loggedIn) {
    return 'Codex の ChatGPT ログイン: なし（peer の Codex は CODEX_API_KEY があればそれで走る）';
  }
  const who = [status.email ?? '(アカウント不明)', status.planType ?? '(プラン不明)'].join('・');
  const base =
    `Codex の ChatGPT ログイン: あり（${who}。最終更新 ${status.updatedAt ?? '(不明)'}）` +
    // 正本はデーモンにあるが降りるのは runner だけで、この器の `codex` CLI は未ログインと答える。
    // 「あり」だけを出すと、手元の 401 と並べて配り漏れに見える。
    '\n  使えるのは runner のマネージャーが peer で頼む Codex だけ（クローンはマネージャーへの依頼として頼む）。' +
    'この器で `codex` を直接叩くと未ログインと出るのは設計どおり';
  if (status.failure === null) return base;
  return (
    `${base}\n⚠ 切れている・失効した・更新に失敗した（${status.failure.at}）: ${status.failure.reason}` +
    '\n  → 人間に再ログインを頼むこと（`alteroid codex login` か Web の「設定 — Codex」）'
  );
}
