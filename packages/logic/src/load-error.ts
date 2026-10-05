/**
 * 読み込みの失敗を、利用者に見せる日本語の要約へ分類する。
 *
 * **応答の素の文（`boom`・`Failed to fetch`）を主文にしない。** 主文は「何が起きたか」
 * （つながらない／サーバーが失敗した 等）で、素の文は `detail` として別に持つ。
 * 画面は `detail` を「詳細」の中へ小さく添える。
 *
 * React も SWR も知らない純関数。`ApiError`（`@alteroid/swr`）は import できないので、
 * `status` を数で持つ `Error` として見分ける（`ApiError` はそれに当たる）。
 */

export type LoadErrorKind =
  /** 応答が無い（ネットワーク断・デーモンが落ちている・接続先違い）。 */
  | 'network'
  /** 5xx。デーモンの側で処理に失敗した。 */
  | 'server'
  /** 401。ログインが切れた／鍵が無効。 */
  | 'unauthorized'
  /** 403。許可が無い。 */
  | 'forbidden'
  /** 404。デーモンがその口を持たない（版のずれ）か、対象が無い。 */
  | 'notFound'
  /** 上以外の 4xx。 */
  | 'rejected'
  /** 分類できない。 */
  | 'unknown';

export interface LoadErrorInfo {
  kind: LoadErrorKind;
  /** 利用者向けの1文（原因の要約）。素の応答文を含まない。 */
  summary: string;
  /** 次の一手の案内。無いことがある。 */
  hint: string | undefined;
  /** 生の文。「詳細」の中へ出す。空なら `undefined`。 */
  detail: string | undefined;
  /** 取り直せば直りうるか（再試行ボタンの意味があるか）。 */
  retryable: boolean;
}

const NETWORK_MESSAGE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|aborted/i;

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function classifyLoadError(error: unknown): LoadErrorInfo {
  const raw = messageOf(error).trim();
  const detail = raw === '' ? undefined : raw;
  const status = statusOf(error);

  if (status !== undefined) {
    const withStatus = (text: string): string =>
      text === '' ? `HTTP ${String(status)}` : `HTTP ${String(status)}: ${text}`;
    const base = { detail: withStatus(raw) };
    if (status === 401) {
      return {
        kind: 'unauthorized',
        summary: 'ログインの有効期限が切れたか、鍵が無効になっています。',
        hint: 'ログインし直してから、もう一度試してください。',
        retryable: true,
        ...base,
      };
    }
    if (status === 403) {
      return {
        kind: 'forbidden',
        summary: 'この画面を見る許可がありません。',
        // 日本語の理由（デーモンが返す「持ち主だけが操作できる」など）は利用者に要る情報なので、
        // 案内として残す。英語の素の文は出さず「詳細」へ回す。
        hint: /[\u3040-\u30ff\u3400-\u9fff]/.test(raw) ? raw : undefined,
        retryable: false,
        ...base,
      };
    }
    if (status === 404) {
      return {
        kind: 'notFound',
        summary: 'デーモンがこの情報の窓口を持っていません（デーモンの版が古い可能性があります）。',
        hint: 'デーモンを更新してから、もう一度試してください。ここに何も無い、という意味ではありません。',
        retryable: true,
        ...base,
      };
    }
    if (status >= 500) {
      return {
        kind: 'server',
        summary: 'デーモンの側で処理に失敗しました。',
        hint: '少し待ってから、もう一度試してください。',
        retryable: true,
        ...base,
      };
    }
    return {
      kind: 'rejected',
      summary: 'デーモンが要求を受け付けませんでした。',
      hint: undefined,
      retryable: true,
      ...base,
    };
  }

  if (error instanceof TypeError || NETWORK_MESSAGE.test(raw)) {
    return {
      kind: 'network',
      summary: 'デーモンにつながっていません。',
      hint: 'デーモンが起きているか、接続先が合っているかを確かめて、もう一度試してください。',
      detail,
      retryable: true,
    };
  }

  return {
    kind: 'unknown',
    summary: '原因を特定できませんでした。',
    hint: '少し待ってから、もう一度試してください。',
    detail,
    retryable: true,
  };
}
