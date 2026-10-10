// 楽観更新はしない: 拒否された操作が成功したように見える瞬間ができるため。
// 例外は useRecordOwnMessage だけ: POST /chat は拒否が無く、SSE の往復を待つと送信のたびに一覧の反映が遅れる
import { useCallback } from 'react';
import { useSWRConfig } from 'swr';

import { ApiError, expectOk, unwrap, uploadAttachment, useApi } from '../api';
import type {
  AgentTokenView,
  AttachmentList,
  ApprovalSelection,
  Commitment,
  ConversationDeleteResult,
  ConversationSummary,
  EnvVarScope,
  InboxEventType,
  InboxRemoveManyResult,
  IntegrationKeyInput,
  IntegrationKeyIssued,
  McpServers,
  MemoryDocument,
  McpServersState,
  McpServersUpdateResult,
  PluginInstallResult,
  PluginPreview,
  PluginPreviewRequest,
  PluginRemoveResult,
  PluginScope,
  Practice,
  ProfileScope,
  ProfileUpdateResult,
  ScheduleEntry,
  ScheduleSpec,
  TokenRotationSettings,
} from '@alteroid/logic';
import { saveChatDraft, saveChatDraftMark } from '@alteroid/logic';

import { isKeyOfType, KEY } from './queries';
import { writeThenRefresh } from './write-then-refresh';

export function useRecordOwnMessage() {
  const { mutate } = useSWRConfig();
  return useCallback(
    (conversationId: string, text: string) => {
      const now = new Date().toISOString();
      const shortened = roughPreview(text);
      void mutate(
        (key) => isKeyOfType(key, 'conversations'),
        (
          current:
            | {
                conversations: ConversationSummary[];
                scanned: number;
                reachedStart: boolean;
                hiddenByLimit: number;
              }
            | undefined,
        ) => {
          // まだ一度も取得していないキャッシュに勝手に値を作らない。
          if (current === undefined) return current;

          const index = current.conversations.findIndex(
            (conversation) => conversation.conversationId === conversationId,
          );

          if (index === -1) {
            const inserted: ConversationSummary = {
              conversationId,
              startedAt: now,
              updatedAt: now,
              messages: 1,
              preview: shortened,
              unreadCount: 0,
              readThrough: now,
            };
            return { ...current, conversations: [inserted, ...current.conversations] };
          }

          const existing = current.conversations[index];
          if (existing === undefined) return current;
          const updated: ConversationSummary = {
            ...existing,
            updatedAt: now,
            preview: shortened,
            messages: existing.messages + 1,
          };
          const rest = current.conversations.filter((_, i) => i !== index);
          return { ...current, conversations: [updated, ...rest] };
        },
        { revalidate: false },
      );
    },
    [mutate],
  );
}

// サーバの `preview()`（`apps/daemon/src/app.ts`）の写し: 切り方がずれると、反映された瞬間に抜粋の見た目が飛ぶ
function roughPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

export class MemoryConflictError extends ApiError {
  readonly current: { document: MemoryDocument; version: string } | null;

  constructor(message: string, current: { document: MemoryDocument; version: string } | null) {
    super(409, message);
    this.name = 'MemoryConflictError';
    this.current = current;
  }
}

export function useSaveMemory() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, content: string, ifMatch?: string | null) => {
      const result = await api.api.PUT('/memory/{slug}', {
        params: { path: { slug } },
        body: ifMatch === undefined ? { content } : { content, ifMatch },
      });
      if (result.response.status === 409 && result.error !== undefined) {
        await Promise.all([mutate(KEY.memory), mutate(KEY.memoryDoc(slug))]);
        const body = result.error as {
          error?: string;
          current?: { document: MemoryDocument; version: string } | null;
        };
        throw new MemoryConflictError(
          body.error ?? '記憶が読んだ後に変わっている',
          body.current ?? null,
        );
      }
      const saved = unwrap(result);
      await Promise.all([mutate(KEY.memory), mutate(KEY.memoryDoc(slug))]);
      return { document: saved.document, version: saved.version };
    },
    [api, mutate],
  );
}

export function useDeleteMemory() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, ifMatch?: string) => {
      const result = await api.api.DELETE('/memory/{slug}', {
        params: { path: { slug }, query: ifMatch === undefined ? {} : { ifMatch } },
      });
      if (result.response.status === 409 && result.error !== undefined) {
        await Promise.all([mutate(KEY.memory), mutate(KEY.memoryDoc(slug))]);
        const body = result.error as {
          error?: string;
          current?: { document: MemoryDocument; version: string } | null;
        };
        throw new MemoryConflictError(
          body.error ?? '記憶が読んだ後に変わっている',
          body.current ?? null,
        );
      }
      unwrap(result);
      await mutate(KEY.memory);
    },
    [api, mutate],
  );
}

export class PracticeConflictError extends ApiError {
  readonly current: { practice: Practice; version: string } | null;

  constructor(message: string, current: { practice: Practice; version: string } | null) {
    super(409, message);
    this.name = 'PracticeConflictError';
    this.current = current;
  }
}

export function useSavePractice() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, kind: string, title: string, content: string, ifMatch?: string | null) => {
      const result = await api.api.PUT('/practices/{slug}', {
        params: { path: { slug } },
        body: ifMatch === undefined ? { kind, title, content } : { kind, title, content, ifMatch },
      });
      if (result.response.status === 409 && result.error !== undefined) {
        await Promise.all([mutate(KEY.practices), mutate(KEY.practice(slug))]);
        const body = result.error as {
          error?: string;
          current?: { practice: Practice; version: string } | null;
        };
        throw new PracticeConflictError(
          body.error ?? 'やり方が読んだ後に変わっている',
          body.current ?? null,
        );
      }
      const saved = unwrap(result);
      await Promise.all([
        mutate(KEY.practices),
        mutate(KEY.practice(slug)),
        mutate(KEY.practiceVersions(slug)),
      ]);
      return { practice: saved.practice, version: saved.version };
    },
    [api, mutate],
  );
}

export function useDeletePractice() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, ifMatch?: string) => {
      const result = await api.api.DELETE('/practices/{slug}', {
        params: { path: { slug }, query: ifMatch === undefined ? {} : { ifMatch } },
      });
      if (result.response.status === 409 && result.error !== undefined) {
        await Promise.all([mutate(KEY.practices), mutate(KEY.practice(slug))]);
        const body = result.error as {
          error?: string;
          current?: { practice: Practice; version: string } | null;
        };
        throw new PracticeConflictError(
          body.error ?? 'やり方が読んだ後に変わっている',
          body.current ?? null,
        );
      }
      unwrap(result);
      await Promise.all([mutate(KEY.practices), mutate(KEY.practiceVersions(slug))]);
    },
    [api, mutate],
  );
}

export function useAnswerApproval() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, answer: string | undefined, selections?: ApprovalSelection[]) => {
      // 失敗しても一覧を取り直す（409 に限らない）: 裏で先に片付いていると、例外で抜けた分カードが未回答の見た目で残るため
      // 取り直しの失敗で元の失敗を上書きしない: 呼び出し側へ伝えるのは「なぜ答えられなかったか」
      let answerError: unknown;
      try {
        await api.api
          .POST('/approvals/{id}/answer', {
            params: { path: { id } },
            body: {
              ...(answer === undefined ? {} : { answer }),
              ...(selections === undefined ? {} : { selections }),
            },
          })
          .then(unwrap);
      } catch (caught) {
        answerError = caught;
      }
      try {
        await Promise.all([mutate(KEY.approvals(true)), mutate(KEY.approvals(false))]);
      } catch (refreshError) {
        if (answerError === undefined) throw refreshError;
      }
      if (answerError !== undefined) throw answerError;
    },
    [api, mutate],
  );
}

export function useAnswerApprovals() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (answers: { id: string; answer?: string; selections?: ApprovalSelection[] }[]) => {
      // 失敗しても取り直す: 届いて応答だけ失われた書き込みは、取り直さないとカードが未回答のまま残り、送り直しが 409 になるため
      const post = () => api.api.POST('/approvals/answer', { body: { answers } }).then(unwrap);
      let results: Awaited<ReturnType<typeof post>>['results'] = [];
      await writeThenRefresh(
        async () => {
          ({ results } = await post());
        },
        () => Promise.all([mutate(KEY.approvals(true)), mutate(KEY.approvals(false))]),
      );
      return results;
    },
    [api, mutate],
  );
}

// 台帳のキーは両方回す: 画面は表示の切り替えでキーを変えるので、片方だけだと切り替えた先が古いままになる
function useRefreshCommitments() {
  const { mutate } = useSWRConfig();
  return useCallback(
    () =>
      Promise.all([
        mutate(KEY.commitments(false)),
        mutate(KEY.commitments(true)),
        mutate((key) => isKeyOfType(key, 'progress')),
      ]),
    [mutate],
  );
}

export function usePushCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (body: string) => {
      await writeThenRefresh(async () => {
        expectOk(await api.api.POST('/commitments', { body: { body } }));
      }, refresh);
    },
    [api, refresh],
  );
}

export function useCloseCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (id: string, reason: string) => {
      await writeThenRefresh(async () => {
        expectOk(
          await api.api.POST('/commitments/{id}/close', {
            params: { path: { id } },
            body: { reason },
          }),
        );
      }, refresh);
    },
    [api, refresh],
  );
}

// 可否をここで先回りして弾かない: サーバの規則を写すと、サーバ側の線が変わった日に画面だけがずれるため
/** 読んだ版（`editedAt ?? at`）と違うと断られた。`current` が null なら、読んだあとに行が消えている。 */
export class CommitmentConflictError extends ApiError {
  readonly current: Commitment | null;

  constructor(message: string, current: Commitment | null) {
    super(409, message);
    this.name = 'CommitmentConflictError';
    this.current = current;
  }
}

// 版の衝突は本文に `current` の鍵があるかで見分ける: 片付き済み・読めない行の 409 は `{ error }` だけで、
// 混ぜると「下書きを新しい版に載せ直す」を勧めてしまう。`ifMatch` を送らない呼び出しは従来どおり後勝ち
export function useEditCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (id: string, body: string, ifMatch?: string) => {
      await writeThenRefresh(async () => {
        const result = await api.api.PATCH('/commitments/{id}', {
          params: { path: { id } },
          body: ifMatch === undefined ? { body } : { body, ifMatch },
        });
        if (result.response.status === 409 && typeof result.error === 'object') {
          const conflict = result.error as { error?: string; current?: Commitment | null } | null;
          if (conflict !== null && 'current' in conflict) {
            throw new CommitmentConflictError(
              conflict.error ?? '本文が読んだ後に変わっている',
              conflict.current ?? null,
            );
          }
        }
        expectOk(result);
      }, refresh);
    },
    [api, refresh],
  );
}

export function useSendManagerMessage() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, body: { text: string; requestId?: string; decision?: 'allow' | 'deny' }) => {
      const result = await api.api
        .POST('/managers/{id}/messages', { params: { path: { id } }, body })
        .then(unwrap);
      await Promise.all([mutate((key) => isKeyOfType(key, 'managers')), mutate(KEY.manager(id))]);
      return result;
    },
    [api, mutate],
  );
}

// 理由が無くても本文 `{}` を送る: DELETE だがサーバ側に json バリデータが付いており、無いと 400 になるため
export function useAbortManager() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, reason?: string) => {
      const result = await api.api
        .DELETE('/managers/{id}', {
          params: { path: { id } },
          body: reason === undefined || reason === '' ? {} : { reason },
        })
        .then(unwrap);
      await Promise.all([mutate((key) => isKeyOfType(key, 'managers')), mutate(KEY.manager(id))]);
      return result;
    },
    [api, mutate],
  );
}

export function useRunSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (kind: string) => {
      // `body: {}` を送る: これがあると openapi-fetch が `content-type: application/json` を付け、デーモンの門番（`deliberateClient`）を通る
      await api.api
        .POST('/schedule/{kind}/run', { params: { path: { kind } }, body: {} })
        .then(unwrap);
      await mutate(KEY.schedule);
    },
    [api, mutate],
  );
}

export interface ScheduleCurrent {
  request: string;
  spec: ScheduleSpec;
  updatedAt: string;
}

// 周期の形は API の型のまま受ける: 画面で daily / every / cron を組み直すと、値が増えたときにここだけ古くなる
export function useCreateSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (
      body: {
        kind: string;
        request: string;
        spec:
          | { type: 'daily'; at: string }
          | { type: 'every'; minutes: number }
          | { type: 'cron'; expression: string };
      },
      ifMatch?: string | null,
    ) => {
      // ifMatch を分岐せず常に渡す: undefined は JSON に載らず、省略（後勝ち）のままになるため
      const result = await api.api.POST('/schedule', { body: { ...body, ifMatch } });
      const failed = result.error as { current?: ScheduleCurrent | null } | undefined;
      // `current` の鍵が在るものだけを版の衝突にする: 予約名・読めない形の予定の 409 は `{ error }` だけで、同じ扱いにすると別の失敗を「読んだ後に変わった」と案内するため
      if (result.response.status === 409 && failed !== undefined && 'current' in failed) {
        await mutate(KEY.schedule);
        // 例外にせず値で返す: 衝突は下書きを残して続きの操作を促す通常の分岐で、失敗の表示に流れないようにするため
        return { conflict: { current: failed.current ?? null } };
      }
      unwrap(result);
      // 応答には版が無いので読み直した一覧から取る: 保存後に打ち足した分の次の保存が、自分の保存と衝突しないようにするため
      const fresh = await mutate<{ entries: ScheduleEntry[] }>(KEY.schedule);
      return { updatedAt: fresh?.entries.find((entry) => entry.kind === body.kind)?.updatedAt };
    },
    [api, mutate],
  );
}

// 既定の定期ジョブの名前をここへ書き写さない: 数え上げを持つのは `RESERVED_SCHEDULE_KINDS` だけにするため
export function useRemoveSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (kind: string) => {
      // `body: {}` を送る: 門番（`deliberateClient`）が `content-type: application/json` を要求し、本文が無いと付かないため
      await api.api
        .DELETE('/schedule/{kind}', { params: { path: { kind } }, body: {} })
        .then(unwrap);
      await mutate(KEY.schedule);
    },
    [api, mutate],
  );
}

export function usePostEvent() {
  const api = useApi();
  return useCallback(
    async (source: string, payload: unknown) => {
      return api.api.POST('/events', { body: { source, payload } }).then(unwrap);
    },
    [api],
  );
}

export interface WorkspaceResetSummary {
  memory: number;
  journal: number;
  jobs: number;
  approvals: number;
  schedules: number;
  schedulePhases: number;
  inbox: number;
  commitments: number;
  practices: number;
  archive: number;
  sessions: number;
  profile: number;
  usageDaily: number;
  usageBaseline: number;
  usageLedger: number;
  usageTurns: number;
  attachments: number;
  sessionLog?: number;
}

// 全キャッシュを引き直す: 種類を選んで落とすと、選び漏れが「消えたのに画面には残る」になるため
export function useResetWorkspace() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(async (): Promise<WorkspaceResetSummary> => {
    const result = await api.api.POST('/reset', { body: { confirm: true } }).then(unwrap);
    await mutate(() => true);
    return result.cleared;
  }, [api, mutate]);
}

// 呼んだ後にキャッシュを引き直さない: デーモンが止まるので、応答する相手がいなくなるため
export function useShutdownDaemon() {
  const api = useApi();
  return useCallback(async () => {
    await api.api.POST('/shutdown', { body: {} }).then(unwrap);
  }, [api]);
}

export function useDeclareOwner() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (accountId: string) => {
      const result = await api.api
        .POST('/access/{accountId}/owner', { params: { path: { accountId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.access);
      return result;
    },
    [api, mutate],
  );
}

export function useRevokeOwnerDeclaration() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (accountId: string) => {
      const result = await api.api
        .POST('/access/{accountId}/owner/revoke', { params: { path: { accountId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.access);
      return result;
    },
    [api, mutate],
  );
}

/** Codex の ChatGPT ログインを始める。確認用 URL とコードが返る。 */
export function useStartCodexLogin() {
  const api = useApi();
  return useCallback(async () => api.api.POST('/codex/login').then(unwrap), [api]);
}

export function useCancelCodexLogin() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string) => {
      const result = await api.api
        .DELETE('/codex/login/{id}', { params: { path: { id } } })
        .then(unwrap);
      await mutate(KEY.codexLogin(id), result, { revalidate: false });
      return result;
    },
    [api, mutate],
  );
}

/** ログアウト（正本から消し、全 runner から外す）。 */
export function useCodexLogout() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(async () => {
    const result = await api.api.DELETE('/codex/auth').then(unwrap);
    await mutate(KEY.codexAuth);
    return result;
  }, [api, mutate]);
}

export function useSetEnvVar() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (entry: { name: string; value: string; scope?: EnvVarScope; secret?: boolean }) => {
      const result = await api.api
        .PUT('/credentials', { body: { credentials: [entry] } })
        .then(unwrap);
      await mutate(KEY.credentials);
      return result;
    },
    [api, mutate],
  );
}

// 別の型にして `detail` を落とさない: 共有の `unwrap` は `error` だけを文言にするが、プロファイルの 400 は行番号込みの `detail` でしか直せない
export class ProfileRejectedError extends ApiError {
  readonly detail: string;

  constructor(error: string, detail: string) {
    super(400, error);
    this.name = 'ProfileRejectedError';
    this.detail = detail;
  }
}

export function useSetProfileEntry() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (name: string, script: string, scope?: ProfileScope): Promise<ProfileUpdateResult> => {
      const result = await api.api.PUT('/profile/{name}', {
        params: { path: { name } },
        body: { script, ...(scope === undefined ? {} : { scope }) },
      });
      throwIfProfileRejected(result);
      const updated = unwrap(result);
      await mutate(KEY.profile);
      return updated;
    },
    [api, mutate],
  );
}

export function useSetProfileLegacy() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (script: string): Promise<ProfileUpdateResult> => {
      const result = await api.api.PUT('/profile', { body: { script } });
      throwIfProfileRejected(result);
      const updated = unwrap(result);
      await mutate(KEY.profile);
      return updated;
    },
    [api, mutate],
  );
}

export function useRemoveProfileEntry() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (name: string): Promise<ProfileUpdateResult> => {
      const result = await api.api.DELETE('/profile/{name}', { params: { path: { name } } });
      throwIfProfileRejected(result);
      // 404（行が無い）でも取り直してから投げる: 既に外されていると、行が一覧に残り続け、開いている編集欄から蘇るため
      if (result.response.status === 404) await mutate(KEY.profile);
      const updated = unwrap(result);
      await mutate(KEY.profile);
      return updated;
    },
    [api, mutate],
  );
}

function throwIfProfileRejected(result: { response: Response; error?: unknown }): void {
  if (result.response.status !== 400) return;
  const body = result.error as { error?: unknown; detail?: unknown } | undefined;
  if (typeof body?.error === 'string') {
    throw new ProfileRejectedError(body.error, typeof body.detail === 'string' ? body.detail : '');
  }
}

export function useRemoveEnvVar() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (name: string) => {
      const result = await api.api
        .PUT('/credentials', { body: { credentials: [{ name, value: '' }] } })
        .then(unwrap);
      await mutate(KEY.credentials);
      return result;
    },
    [api, mutate],
  );
}

// 全置換は直列に流す: 続けて押すと2つの書き込みが同じ古い一覧を土台にし、後から着いた PUT が先の変更を巻き戻すため
// 列は大域に1本ではなく API クライアントごとに持つ: 接続先やテストどうしで無関係な書き込みが互いを待つため
const tokenWriteTails = new WeakMap<object, Promise<unknown>>();

function serializeTokenWrite<T>(client: object, run: () => Promise<T>): Promise<T> {
  const tail = tokenWriteTails.get(client) ?? Promise.resolve();
  const next = tail.then(run, run);
  tokenWriteTails.set(
    client,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

// キャッシュではなく都度取り直す: タブが複数開いていても、直前の実際の状態を土台にするため
export function useAddToken() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    (label: string, value: string) =>
      serializeTokenWrite(api, async () => {
        const current = await api.api.GET('/tokens').then(unwrap);
        const inputs = current.tokens.map(toTokenInput);
        const result = await api.api
          .PUT('/tokens', { body: { tokens: [...inputs, { label, value }] } })
          .then(unwrap);
        await mutate(KEY.tokens);
        return result;
      }),
    [api, mutate],
  );
}

export function useRemoveUnreadableTokens() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (ids: readonly string[]) => {
      const result = await api.api
        .POST('/tokens/unreadable/remove', { body: { ids: [...ids] } })
        .then(unwrap);
      await mutate(KEY.tokens);
      return result;
    },
    [api, mutate],
  );
}

export class TokenNotFoundError extends ApiError {
  readonly tokenId: string;

  constructor(id: string) {
    super(
      404,
      `id ${id} のトークンは見つかりません（既に無い。別の画面か CLI で消された。一覧を取り直した）`,
    );
    this.name = 'TokenNotFoundError';
    this.tokenId = id;
  }
}

async function assertTokenPresent(
  tokens: readonly AgentTokenView[],
  id: string,
  refresh: () => Promise<unknown>,
): Promise<void> {
  if (tokens.some((token) => token.id === id)) return;
  await refresh();
  throw new TokenNotFoundError(id);
}

export function useRemoveToken() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    (id: string) =>
      serializeTokenWrite(api, async () => {
        const current = await api.api.GET('/tokens').then(unwrap);
        await assertTokenPresent(current.tokens, id, () => mutate(KEY.tokens));
        const inputs = current.tokens.filter((token) => token.id !== id).map(toTokenInput);
        const result = await api.api.PUT('/tokens', { body: { tokens: inputs } }).then(unwrap);
        await mutate(KEY.tokens);
        return result;
      }),
    [api, mutate],
  );
}

export function useSetTokenDisabled() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    (id: string, disabled: boolean) =>
      serializeTokenWrite(api, async () => {
        const current = await api.api.GET('/tokens').then(unwrap);
        await assertTokenPresent(current.tokens, id, () => mutate(KEY.tokens));
        const inputs = current.tokens.map((token) =>
          token.id === id ? { ...toTokenInput(token), disabled } : toTokenInput(token),
        );
        const result = await api.api.PUT('/tokens', { body: { tokens: inputs } }).then(unwrap);
        await mutate(KEY.tokens);
        return result;
      }),
    [api, mutate],
  );
}

function toTokenInput(token: AgentTokenView): { id: string; label: string; order: number } {
  return { id: token.id, label: token.label, order: token.order };
}

// 欠けた項目を補わず、値の妥当性もここで判定しない: サーバ側の規則が変わった日に画面だけがずれるため
export function useSetTokenPolicy() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (patch: Partial<Pick<TokenRotationSettings, 'rotateOn' | 'cooldownMs'>>) => {
      const result = await api.api.PUT('/tokens/policy', { body: patch }).then(unwrap);
      await mutate(KEY.tokens);
      return result;
    },
    [api, mutate],
  );
}

export function useEndConversation() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (conversationId: string) => {
      await api.api
        .POST('/chat/{conversationId}/end', { params: { path: { conversationId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.memory);
    },
    [api, mutate],
  );
}

// 論理削除。結果（件数・`incomplete`・`remainsIn`）は呼び出し側が人間へ見せるので、そのまま返す。
// 下書きもここで消す: 消した会話の id で残る本文は、どこからも開けないのに端末に平文で残るだけになるため
export function useDeleteConversation() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (conversationId: string): Promise<ConversationDeleteResult> => {
      const result = await api.api
        .DELETE('/conversations/{id}', { params: { path: { id: conversationId } } })
        .then(unwrap);
      saveChatDraft(conversationId, '');
      saveChatDraftMark(conversationId, undefined);
      // 一覧・未読数・本文・台帳を捨てる。`use-journal-live.ts` の `conversation_deleted` と同じ束（墓標の SSE を待たずに揃える）
      await Promise.all([
        mutate((key) => isKeyOfType(key, 'conversations')),
        mutate((key) => isKeyOfType(key, 'conversationUnreadCount')),
        mutate((key) => isKeyOfType(key, 'conversation')),
        mutate((key) => isKeyOfType(key, 'commitments')),
      ]);
      return result;
    },
    [api, mutate],
  );
}

// キャッシュは引き直さない: 止めてもセッションと受信箱は残り、どの一覧の中身も変わらないため
// 対象（会話 id と `POST /chat` の clientMessageId）は2つとも渡すか2つとも省く。省くと種類を問わず走っているターンを止める
export function useInterruptClone() {
  const api = useApi();
  return useCallback(
    async (target?: { conversationId: string; clientMessageId: string }) => {
      const result = await api.api.POST('/clone/interrupt', { body: target ?? {} }).then(unwrap);
      return result.outcome;
    },
    [api],
  );
}

export interface ReopenCloneSessionResult {
  outcome: 'now' | 'deferred' | 'unsupported';
  previousSessionId?: string | null | undefined;
  runningManagers?: number | undefined;
}

// `confirm: true` はここで付ける: 確認は呼び出し側の画面が済ませてから呼ぶ前提のため
// キャッシュは引き直さない: 開き直しは走っているターンの境界で起きる（deferred）ので、呼んだ時点では何の一覧も変わらないため
// distill は省かず常に送る（既定 false）。reason は空なら送らない
export function useReopenCloneSession() {
  const api = useApi();
  return useCallback(
    async (options: { distill?: boolean; reason?: string }): Promise<ReopenCloneSessionResult> => {
      const reason = options.reason?.trim();
      return api.api
        .POST('/clone/session/reopen', {
          body: {
            confirm: true,
            distill: options.distill ?? false,
            ...(reason === undefined || reason === '' ? {} : { reason }),
          },
        })
        .then(unwrap);
    },
    [api],
  );
}

// 409 をここで握り潰さない: 呼び出し側が理由の入力欄を出し、`overrideReason` 付きでもう一度呼ぶため
export function useRemoveArchive() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, overrideReason?: string) => {
      const result = await api.api
        .DELETE('/archive/{id}', {
          params: {
            path: { id },
            query: overrideReason === undefined ? {} : { overrideReason },
          },
        })
        .then(unwrap);
      await Promise.all([
        mutate(KEY.archive),
        mutate(KEY.archiveSessions),
        mutate((key) => isKeyOfType(key, 'archiveBody')),
      ]);
      return result;
    },
    [api, mutate],
  );
}

export interface InboxRemoveManyInput {
  types: readonly InboxEventType[];
  sources?: readonly string[];
  before?: string;
  reason: string;
  limit?: number;
  dryRun: boolean;
}

// `dryRun` の既定を持たない: 「既定は試算」は呼び出し側が守る
// 入力の妥当性をここで判定しない: 複製すると、サーバ側の文言や条件が変わったときここだけ古いまま残る
export function useInboxRemoveMany() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (input: InboxRemoveManyInput): Promise<InboxRemoveManyResult> => {
      const result = await api.api
        .POST('/inbox/remove', {
          body: {
            types: [...input.types],
            ...(input.sources === undefined ? {} : { sources: [...input.sources] }),
            ...(input.before === undefined ? {} : { before: input.before }),
            reason: input.reason,
            dryRun: input.dryRun,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
        })
        .then(unwrap);
      if (!input.dryRun) await mutate(KEY.inbox);
      return result;
    },
    [api, mutate],
  );
}

export function useGrantAccess() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (accountId: string) => {
      const result = await api.api
        .POST('/access/{accountId}/grant', { params: { path: { accountId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.access);
      return result;
    },
    [api, mutate],
  );
}

export function useRevokeAccess() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (accountId: string) => {
      const result = await api.api
        .POST('/access/{accountId}/revoke', { params: { path: { accountId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.access);
      return result;
    },
    [api, mutate],
  );
}

export function useRevokePermissionGrant() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string) => {
      const result = await api.api
        .POST('/permission-grants/{id}/revoke', { params: { path: { id } }, body: {} })
        .then(unwrap);
      await mutate(KEY.permissionGrants);
      return result;
    },
    [api, mutate],
  );
}

export function useVacateRunner() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (runnerId: string) => {
      const result = await api.api.POST('/runners/vacate', { body: { runnerId } }).then(unwrap);
      await mutate(KEY.runners);
      return result;
    },
    [api, mutate],
  );
}

// 形の検査をここでしない: `parseMcpServers`（デーモン）が正本で、400 の文言は共有の `unwrap` がそのまま見せるため
export function useSetMcpServers() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (
      mcpServers: McpServers,
      ifMatch?: string,
    ): Promise<
      | { update: McpServersUpdateResult; conflict?: undefined }
      | { conflict: McpServersState; update?: undefined }
    > => {
      const result = await api.api.PUT('/mcp-servers', { body: { mcpServers, ifMatch } });
      // 409 を版の衝突だけとして読む: この口に他の 409 は無いため
      if (result.response.status === 409 && result.error !== undefined) {
        await mutate(KEY.mcpServers);
        // 例外にせず値で返す: 下書きを残して続きの操作を促す通常の分岐で、失敗の表示に流れないようにするため
        return { conflict: (result.error as { current: McpServersState }).current };
      }
      const update = unwrap(result);
      await mutate(KEY.mcpServers);
      return { update };
    },
    [api, mutate],
  );
}

// 取り元の検査をここでしない: 画面の parsePluginSource とデーモンの schema が持ち、400 の文言は共有の `unwrap` がそのまま見せるため
export function usePreviewPlugin() {
  const api = useApi();
  return useCallback(
    async (body: PluginPreviewRequest): Promise<PluginPreview> =>
      unwrap(await api.api.POST('/plugins/preview', { body })),
    [api],
  );
}

// 404（預かりの期限切れ）・409（名前の衝突）は ApiError の status で画面が分ける
export function useInstallPlugin() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (body: {
      previewId: string;
      scope: PluginScope;
      enableHooks: boolean;
      enableMcp: boolean;
    }): Promise<PluginInstallResult> => {
      const result = unwrap(await api.api.POST('/plugins', { body }));
      await mutate(KEY.plugins);
      return result;
    },
    [api, mutate],
  );
}

export function useRemovePlugin() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (name: string): Promise<PluginRemoveResult> => {
      const result = unwrap(
        await api.api.DELETE('/plugins/{name}', { params: { path: { name } } }),
      );
      await mutate(KEY.plugins);
      return result;
    },
    [api, mutate],
  );
}

// 取り直しの失敗を発行の失敗にしない: 発行は済んでおり、投げると画面が「失敗した」と言って、人間が値を受け取れないまま作り直すことになる
export function useIssueIntegrationKey() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (input: IntegrationKeyInput): Promise<IntegrationKeyIssued> => {
      const issued = await api.api.POST('/integration-keys', { body: input }).then(unwrap);
      await mutate(KEY.integrationKeys).catch(() => undefined);
      return issued;
    },
    [api, mutate],
  );
}

export function useRevokeIntegrationKey() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string) => {
      const result = await api.api
        .POST('/integration-keys/{id}/revoke', { params: { path: { id } }, body: {} })
        .then(unwrap);
      await mutate(KEY.integrationKeys).catch(() => undefined);
      return result;
    },
    [api, mutate],
  );
}

export function useRemoveUnreadableIntegrationKeys() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (ids: readonly string[]) => {
      const result = await api.api
        .POST('/integration-keys/unreadable/remove', { body: { ids: [...ids] } })
        .then(unwrap);
      await mutate(KEY.integrationKeys);
      return result;
    },
    [api, mutate],
  );
}

export function useRemoveUnreadablePermissionGrants() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (ids: readonly string[]) => {
      const result = await api.api
        .POST('/permission-grants/unreadable/remove', { body: { ids: [...ids] } })
        .then(unwrap);
      await mutate(KEY.permissionGrants);
      return result;
    },
    [api, mutate],
  );
}

export function useRemoveUnreadableAccounts() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (ids: readonly string[]) => {
      const result = await api.api
        .POST('/access/unreadable/remove', { body: { ids: [...ids] } })
        .then(unwrap);
      await mutate(KEY.access);
      return result;
    },
    [api, mutate],
  );
}

// 保存の付け外しは楽観更新しない: 応答（更新後の控え）で、キャッシュ中の同じ id の行だけを差し替える。
// 一覧を取り直さない（使用量も並びも変わらず、絞り込み中の行が応答の前に消えないため）。404（期限切れ・削除済み）は ApiError のまま投げ、一覧は取り直す
export function useSetAttachmentKept() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, kept: boolean) => {
      const response = await api.api.PATCH('/attachments/{id}', {
        params: { path: { id } },
        body: { kept },
      });
      if (response.response.status === 404) {
        await mutate((key) => isKeyOfType(key, 'attachments'));
      }
      const updated = unwrap(response);
      await mutate(
        (key) => isKeyOfType(key, 'attachments'),
        (current: AttachmentList | undefined) =>
          current === undefined
            ? current
            : {
                ...current,
                items: current.items.map((item) => (item.id === updated.id ? updated : item)),
              },
        { revalidate: false },
      );
      return updated;
    },
    [api, mutate],
  );
}

// 消したあとは一覧と使用量を取り直す（行を手で外さない）。404 でも取り直してから投げる: 期限切れで先に消えた行を一覧から外すため
export function useDeleteAttachment() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string) => {
      const result = await api.api.DELETE('/attachments/{id}', { params: { path: { id } } });
      if (result.response.status === 404) {
        await mutate((key) => isKeyOfType(key, 'attachments'));
      }
      expectOk(result);
      await mutate((key) => isKeyOfType(key, 'attachments'));
    },
    [api, mutate],
  );
}

// 「ファイル」画面から上げたものは保存の印つき（`keep=1`）。上げたら一覧と使用量を取り直す
export function useUploadKeptAttachment() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (file: File, mediaType: string) => {
      const meta = await uploadAttachment(
        api,
        file,
        { name: file.name, type: mediaType },
        { keep: true },
      );
      await mutate((key) => isKeyOfType(key, 'attachments'));
      return meta;
    },
    [api, mutate],
  );
}
