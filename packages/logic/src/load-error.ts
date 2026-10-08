export type LoadErrorKind =
  | 'network'
  | 'server'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rejected'
  | 'unreadable'
  | 'unknown';

export interface LoadErrorInfo {
  kind: LoadErrorKind;
  summary: string;
  hint: string | undefined;
  detail: string | undefined;
  retryable: boolean;
}

const NETWORK_MESSAGE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|aborted/i;

const UNREADABLE = {
  kind: 'unreadable',
  summary: '応答が読めない形で届きました。',
  hint: 'サーバと画面の版がずれているか、接続先が違う可能性があります。',
  retryable: true,
} as const;

// `ApiError` を import せず `status` で見分ける: `@alteroid/swr` は import できないため。
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

// 素の応答文（`Failed to fetch` など）を主文にしない: 主文は何が起きたかで、素の文は `detail` へ回すため。
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
        hint: /[\u3040-\u30ff\u3400-\u9fff]/.test(raw) ? raw : undefined,
        retryable: false,
        ...base,
      };
    }
    if (status === 404) {
      return {
        kind: 'notFound',
        summary: 'サーバがこの情報の窓口を持っていません（サーバの版が古い可能性があります）。',
        hint: 'サーバを更新してから、もう一度試してください。ここに何も無い、という意味ではありません。',
        retryable: true,
        ...base,
      };
    }
    if (status >= 500) {
      return {
        kind: 'server',
        summary: 'サーバの側で処理に失敗しました。',
        hint: '少し待ってから、もう一度試してください。',
        retryable: true,
        ...base,
      };
    }
    // 400 未満は「受け付けなかった」ではない: 応答は届いており、読めなかっただけのため
    if (status < 400) return { ...UNREADABLE, ...base };
    return {
      kind: 'rejected',
      summary: 'サーバが要求を受け付けませんでした。',
      hint: undefined,
      retryable: true,
      ...base,
    };
  }

  // 本文が JSON として読めない失敗は、読み込みの経路では応答の形のずれ（HTML を返す別のサーバなど）としてしか起きない
  if (error instanceof SyntaxError) return { ...UNREADABLE, detail };

  if (error instanceof TypeError || NETWORK_MESSAGE.test(raw)) {
    return {
      kind: 'network',
      summary: '接続先のサーバにつながっていません。',
      hint: 'サーバが起きているか、接続先が合っているかを確かめて、もう一度試してください。',
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
