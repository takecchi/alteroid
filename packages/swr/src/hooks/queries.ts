// SWR のキーは文字列ではなくオブジェクトにする: 連結の順番や区切りで衝突しうるうえ、`mutate` 側でも同じ形で指すため
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

import { ApiError, unwrap, useApi } from '../api';
import { normalizeProfile } from '@alteroid/logic';
import type {
  AttachmentFrom,
  AttachmentItem,
  AttachmentList,
  ConversationsResponse,
  ConversationSummary,
  JournalEntryType,
  ManagerStatus,
  UsageLayer,
  UsageSite,
} from '@alteroid/logic';

export interface UsageQuery {
  from?: string;
  to?: string;
  managerId?: string;
  layer?: UsageLayer;
  site?: UsageSite;
  tokenId?: string;
}

export interface ManagersQuery {
  status?: readonly ManagerStatus[];
  limit?: number;
  after?: { managerId: string; startedAt: string };
}

export interface AttachmentsQuery {
  kept?: boolean;
  from?: AttachmentFrom;
  conversationId?: string;
  q?: string;
}

export function isKeyOfType(key: unknown, type: string): boolean {
  return typeof key === 'object' && key !== null && (key as { type?: unknown }).type === type;
}

export const KEY = {
  health: { type: 'health' } as const,
  status: { type: 'status' } as const,
  attachmentLimits: { type: 'attachmentLimits' } as const,
  attachments: (query: AttachmentsQuery, limit: number, pages: number) =>
    ({
      type: 'attachments',
      kept: query.kept,
      from: query.from,
      conversationId: query.conversationId,
      q: query.q,
      limit,
      pages,
    }) as const,
  // `mutate(KEY.managers)` と書かない: 関数を渡すと SWR は絞り込みの述語と読み、キャッシュの全キーが落ちる。束（`isKeyOfType`）で指す
  managers: (query: ManagersQuery = {}) =>
    ({
      type: 'managers',
      status: [...(query.status ?? [])].join(','),
      limit: query.limit,
      afterId: query.after?.managerId,
      afterStartedAt: query.after?.startedAt,
    }) as const,
  manager: (id: string) => ({ type: 'manager', id }) as const,
  transcript: (id: string) => ({ type: 'transcript', id }) as const,
  approvals: (pending: boolean) => ({ type: 'approvals', pending }) as const,
  // 承認系のキーは `type` を `approvals` のまま揃える: `escalation` 受信時の束での無効化から外れると、古いまま取り残されるため
  conversationApprovals: (conversationId: string) =>
    ({ type: 'approvals', pending: false, conversationId }) as const,
  approvalsAnsweredDates: (limit: number) =>
    ({ type: 'approvals', answeredDates: true, limit }) as const,
  approvalsAnsweredOn: (date: string) => ({ type: 'approvals', answeredOn: date }) as const,
  approvalById: (id: string) => ({ type: 'approvals', byId: id }) as const,
  commitments: (includeClosed: boolean) => ({ type: 'commitments', includeClosed }) as const,
  reports: (limit: number) => ({ type: 'reports', limit }) as const,
  report: (date: string) => ({ type: 'report', date }) as const,
  journal: (limit: number, types: string) => ({ type: 'journal', limit, types }) as const,
  schedule: { type: 'schedule' } as const,
  progress: (windowHours: number | undefined) => ({ type: 'progress', windowHours }) as const,
  usage: (query: UsageQuery) => ({ type: 'usage', ...query }) as const,
  memory: { type: 'memory' } as const,
  memoryDoc: (slug: string) => ({ type: 'memoryDoc', slug }) as const,
  practices: { type: 'practices' } as const,
  practice: (slug: string) => ({ type: 'practice', slug }) as const,
  practiceVersions: (slug: string) => ({ type: 'practiceVersions', slug }) as const,
  practiceVersion: (slug: string, version: number) =>
    ({ type: 'practiceVersion', slug, version }) as const,
  conversations: (limit: number, pages = 1) => ({ type: 'conversations', limit, pages }) as const,
  // `includeSuperseded` をキーに含める: `chat.tsx` と `approvals.tsx` が同じ会話 id を別の形で読み、キーが同じだと後勝ちで上書きされるため
  conversation: (id: string, includeSuperseded = false) =>
    ({ type: 'conversation', id, includeSuperseded }) as const,
  approvalTrace: (id: string) => ({ type: 'approvalTrace', id }) as const,
  runners: { type: 'runners' } as const,
  tokens: { type: 'tokens' } as const,
  access: { type: 'access' } as const,
  credentials: { type: 'credentials' } as const,
  codexAuth: { type: 'codexAuth' } as const,
  codexLogin: (id: string) => ({ type: 'codexLogin', id }) as const,
  profile: { type: 'profile' } as const,
  mcpServers: { type: 'mcpServers' } as const,
  plugins: { type: 'plugins' } as const,
  integrationKeys: { type: 'integrationKeys' } as const,
  permissionGrants: { type: 'permissionGrants' } as const,
  dropped: { type: 'dropped' } as const,
  archive: { type: 'archive' } as const,
  archiveSessions: { type: 'archiveSessions' } as const,
  archiveBody: (id: string) => ({ type: 'archiveBody', id }) as const,
  inbox: { type: 'inbox' } as const,
};

export function useHealth() {
  const api = useApi();
  return useSWR(KEY.health, () => api.api.GET('/health').then(unwrap), {
    errorRetryInterval: 5000,
    refreshInterval: 30_000,
  });
}

export function useStatus() {
  const api = useApi();
  return useSWR(KEY.status, () => api.api.GET('/status').then(unwrap), {
    errorRetryInterval: 5000,
  });
}

/**
 * クローンのセッションが安全分類器に弾かれ続けている状況（`/status` の `cloneSessionRefusal`。#4173）を、
 * ホームの帯が使うために一定間隔で取り直す。`useStatus` と同じキー（同じ応答を共有する）で、間隔だけが違う。
 */
export function useCloneSessionRefusal() {
  const api = useApi();
  return useSWR(KEY.status, () => api.api.GET('/status').then(unwrap), {
    errorRetryInterval: 5000,
    refreshInterval: 30_000,
  });
}

export function useAttachmentLimits() {
  const api = useApi();
  return useSWR(
    KEY.attachmentLimits,
    async () => {
      const result = await api.api.GET('/attachments/limits');
      return result.response.status === 404 ? null : unwrap(result);
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      shouldRetryOnError: false,
    },
  );
}

// 頁は `useConversations` と同じ形で辿る（`limit` を増やさず `nextCursor` で。取り直すたびに先頭から辿り直し、どれかの頁の失敗は一覧全体の失敗にする）
// 使用量（`usage`）は絞り込みに関わらず全体のもの。最後に取れた頁のものを返す
export function useAttachments(
  query: AttachmentsQuery = {},
  options: { pages?: number; limit?: number } = {},
) {
  const api = useApi();
  const pages = Math.max(1, options.pages ?? 1);
  const limit = options.limit ?? 50;
  return useSWR(
    KEY.attachments(query, limit, pages),
    async (): Promise<AttachmentList> => {
      const seen = new Set<string>();
      const items: AttachmentItem[] = [];
      let cursor: string | undefined;
      let last: AttachmentList | undefined;
      for (let index = 0; index < pages; index += 1) {
        const page: AttachmentList = await api.api
          .GET('/attachments', {
            params: {
              query: {
                limit,
                ...(query.kept === undefined ? {} : { kept: query.kept ? '1' : '0' }),
                ...(query.from === undefined ? {} : { from: query.from }),
                ...(query.conversationId === undefined
                  ? {}
                  : { conversationId: query.conversationId }),
                ...(query.q === undefined || query.q === '' ? {} : { q: query.q }),
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          })
          .then(unwrap);
        last = page;
        for (const item of page.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      const tail = last as AttachmentList;
      return {
        items,
        usage: tail.usage,
        ...(tail.nextCursor === undefined ? {} : { nextCursor: tail.nextCursor }),
      };
    },
    // 絞り込みを変えた直後に、前の一覧を出したまま読み込み中に見せる
    { keepPreviousData: true, dedupingInterval: 0 },
  );
}

// `params` を条件付きで外さない: `openapi-fetch` は空の query なら `?` そのものを付けない
export function useManagers(query: ManagersQuery = {}) {
  const api = useApi();
  const params = managersToQuery(query);
  return useSWR(KEY.managers(query), () =>
    api.api.GET('/managers', { params: { query: params } }).then(unwrap),
  );
}

// 空の欄は付けない（`undefined` の欄も作らない）: デーモンは生のクエリで「渡されたか」を判定するので、空の値を送ると窓の掛かった呼びに化ける
export function managersToQuery(query: ManagersQuery): {
  status?: string;
  limit?: number;
  afterId?: string;
  afterStartedAt?: string;
} {
  const status = [...(query.status ?? [])].join(',');
  return {
    ...(status === '' ? {} : { status }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.after === undefined
      ? {}
      : { afterId: query.after.managerId, afterStartedAt: query.after.startedAt }),
  };
}

export function useManager(id: string) {
  const api = useApi();
  return useSWR(KEY.manager(id), ({ id }) =>
    api.api.GET('/managers/{id}', { params: { path: { id } } }).then(unwrap),
  );
}

// 空文字を渡して `/managers//transcript` を叩かせない: 404 が「無い」のか「聞き方の間違い」なのか区別できなくなるため
export function useManagerTranscript(id: string | null) {
  const api = useApi();
  return useSWR(id === null ? null : KEY.transcript(id), async ({ id }) => {
    const result = await api.api.GET('/managers/{id}/transcript', {
      params: { path: { id } },
      parseAs: 'text',
    });
    return unwrap(result);
  });
}

// `order` を明示する: 渡さないと生の並びが永続化層ごとに違い（回答のたびに末尾へ動く実装がある）、同じ画面が違う順で出る
// 窓（`limit` / `cursor`）は作らない: `total` は受け取った配列の長さと一致する冗長な値で、画面には出さない
// `enabled` が false の間は取りに行かない: 鍵が無いまま出し続けると 401 を叩き続けるため
export function useApprovals(pending = true, enabled = true) {
  const api = useApi();
  return useSWR(enabled ? KEY.approvals(pending) : null, ({ pending }) =>
    api.api
      .GET('/approvals', {
        params: { query: { pending: pending ? 'true' : 'false', order: 'asc' } },
      })
      .then(unwrap),
  );
}

export function useAnsweredApprovalDates(limit = 60) {
  const api = useApi();
  return useSWR(KEY.approvalsAnsweredDates(limit), ({ limit }) =>
    api.api.GET('/approvals/answered-dates', { params: { query: { limit } } }).then(unwrap),
  );
}

// 画面で並べ直さない: 並びも「その日」の意味もデーモンが決める
export function useApprovalsAnsweredOn(date: string | null) {
  const api = useApi();
  return useSWR(date === null ? null : KEY.approvalsAnsweredOn(date), ({ answeredOn }) =>
    api.api.GET('/approvals', { params: { query: { answeredOn } } }).then(unwrap),
  );
}

// `pending=false` を渡す: 答えた分も含めないと、回答済みの確認がリロードで「まだ返答が無い」へ戻って見える
export function useConversationApprovals(conversationId: string | null) {
  const api = useApi();
  return useSWR(
    conversationId === null ? null : KEY.conversationApprovals(conversationId),
    ({ conversationId }) =>
      api.api
        .GET('/approvals', {
          params: { query: { pending: 'false', order: 'asc', conversationId } },
        })
        .then(unwrap),
  );
}

// 画面で並べ直さない: 並べ直すと、齢の見え方が CLI・クローンとここで食い違う
export function useCommitments(includeClosed = false) {
  const api = useApi();
  return useSWR(
    KEY.commitments(includeClosed),
    ({ includeClosed }) =>
      api.api
        .GET('/commitments', {
          params: { query: { includeClosed: includeClosed ? 'true' : 'false' } },
        })
        .then(unwrap),
    // 別キーになっても前の一覧を出したままにする: スピナーに置き換わると、未了の行の書きかけ（下書き・片付ける理由）が unmount で消える
    { keepPreviousData: true },
  );
}

export function useReports(limit = 7) {
  const api = useApi();
  return useSWR(KEY.reports(limit), ({ limit }) =>
    api.api.GET('/reports', { params: { query: { limit } } }).then(unwrap),
  );
}

export function useReport(date: string) {
  const api = useApi();
  return useSWR(KEY.report(date), ({ date }) =>
    api.api.GET('/reports/{date}', { params: { path: { date } } }).then(unwrap),
  );
}

export function useJournal(limit = 100, types: readonly JournalEntryType[] = []) {
  const api = useApi();
  const joined = types.join(',');
  return useSWR(KEY.journal(limit, joined), ({ limit, types }) =>
    api.api
      .GET('/journal', {
        params: { query: { limit, ...(types === '' ? {} : { type: types }) } },
      })
      .then(unwrap),
  );
}

export function useSchedule() {
  const api = useApi();
  return useSWR(KEY.schedule, () => api.api.GET('/schedule').then(unwrap), {
    refreshInterval: 30_000,
  });
}

export function useProgress(windowHours?: number) {
  const api = useApi();
  return useSWR(
    KEY.progress(windowHours),
    ({ windowHours }) =>
      api.api
        .GET('/progress', {
          params: { query: windowHours === undefined ? {} : { windowHours: String(windowHours) } },
        })
        .then(unwrap),
    // 別キーになっても前の数を出したままにする: 取り直しの間に数が消えないようにするため
    { refreshInterval: 30_000, keepPreviousData: true },
  );
}

export interface UsageOptions {
  refreshInterval?: number;
}

export function useUsage(query: UsageQuery = {}, options: UsageOptions = {}) {
  const api = useApi();
  return useSWR(
    KEY.usage(query),
    ({ from, to, managerId, layer, site, tokenId }) =>
      api.api
        .GET('/usage', {
          params: {
            query: {
              ...(from === undefined ? {} : { from }),
              ...(to === undefined ? {} : { to }),
              ...(managerId === undefined ? {} : { managerId }),
              ...(layer === undefined ? {} : { layer }),
              ...(site === undefined ? {} : { site }),
              ...(tokenId === undefined ? {} : { tokenId }),
            },
          },
        })
        .then(unwrap),
    // 別キーになっても前の中身を出したままにする: 取り直しの間に数字が消えないようにするため
    { keepPreviousData: true, ...options },
  );
}

export function useMemoryDocuments() {
  const api = useApi();
  return useSWR(KEY.memory, () => api.api.GET('/memory').then(unwrap));
}

export function useMemoryDocument(slug: string) {
  const api = useApi();
  return useSWR(KEY.memoryDoc(slug), ({ slug }) =>
    api.api.GET('/memory/{slug}', { params: { path: { slug } } }).then(unwrap),
  );
}

export function usePractices() {
  const api = useApi();
  return useSWR(KEY.practices, () => api.api.GET('/practices').then(unwrap));
}

export function usePractice(slug: string) {
  const api = useApi();
  return useSWR(KEY.practice(slug), ({ slug }) =>
    api.api.GET('/practices/{slug}', { params: { path: { slug } } }).then(unwrap),
  );
}

export function usePracticeVersions(slug: string) {
  const api = useApi();
  return useSWR(KEY.practiceVersions(slug), ({ slug }) =>
    api.api.GET('/practices/{slug}/versions', { params: { path: { slug } } }).then(unwrap),
  );
}

export function usePracticeVersion(slug: string, version: number | undefined) {
  const api = useApi();
  return useSWR(
    version === undefined ? null : KEY.practiceVersion(slug, version),
    ({ slug, version }) =>
      api.api
        .GET('/practices/{slug}/versions/{version}', {
          params: { path: { slug, version: String(version) } },
        })
        .then(unwrap),
  );
}

// `limit` を増やす形ではなく継続点（`nextCursor`）で頁を辿る: 201 件目以降と `scan` の窓の外へ届かないため
// 取り直すたびに先頭から辿り直す: 保存した継続点を使い回すと、先頭に入った新しい会話の分だけ押し出された会話がどの頁にも出なくなる
// 頁の欠けた一覧を成功のように返さない: どれかの取得に失敗したら一覧全体を失敗にする
// `scanned` を頁ごとの値の合計にしない: 次の頁の窓は前の頁の窓の途中（最後に出した会話の発言）から始まるので、足すと重なりを二重に数える。`scanned`・`reachedStart` は最後（いちばん古い）の窓の値のまま返し、何頁ぶんかを `pagesRead` で添える
export function useConversations(
  limit = 30,
  options: { keepPreviousData?: boolean; pages?: number } = {},
) {
  const api = useApi();
  const pages = Math.max(1, options.pages ?? 1);
  return useSWR(
    KEY.conversations(limit, pages),
    async ({ limit }) => {
      const seen = new Set<string>();
      const conversations: ConversationSummary[] = [];
      let windowsComplete = true;
      let cursor: string | undefined;
      let last: ConversationsResponse | undefined;
      let first: ConversationsResponse | undefined;
      let pagesRead = 0;
      for (let index = 0; index < pages; index += 1) {
        const page: ConversationsResponse = await api.api
          .GET('/conversations', {
            params: { query: { limit, ...(cursor === undefined ? {} : { cursor }) } },
          })
          .then(unwrap);
        first ??= page;
        last = page;
        pagesRead += 1;
        if (page.reachedStart === false) windowsComplete = false;
        for (const conversation of page.conversations) {
          if (seen.has(conversation.conversationId)) continue;
          seen.add(conversation.conversationId);
          conversations.push(conversation);
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      const { readStateUnreadable } = first as ConversationsResponse;
      const tail = last as ConversationsResponse;
      return {
        ...tail,
        conversations,
        windowsComplete,
        pagesRead,
        ...(readStateUnreadable === undefined ? {} : { readStateUnreadable }),
      };
    },
    // 重複排除（SWR の既定 2 秒）を切る: 失敗した直後にもう一度押したとき、取り直しを飲ませないため
    options.keepPreviousData === true ? { keepPreviousData: true, dedupingInterval: 0 } : undefined,
  );
}

// 畳み込み規則を画面側で再実装しない: サーバの `supersedes` / `supersededBy` を束ねるだけにする（`computeSupersededIds` が正本）
export function useConversation(
  id: string | null,
  options: { includeSuperseded?: boolean; retryOnNotFound?: boolean } = {},
) {
  const api = useApi();
  const includeSuperseded = options.includeSuperseded ?? false;
  const retryOnNotFound = options.retryOnNotFound ?? true;
  return useSWR(
    id === null ? null : KEY.conversation(id, includeSuperseded),
    ({ id }) =>
      api.api
        .GET('/conversations/{id}', {
          params: {
            path: { id },
            query: { includeSuperseded: includeSuperseded ? 'true' : 'false' },
          },
        })
        .then(unwrap),
    retryOnNotFound
      ? undefined
      : {
          // 404（会話ではない id）で再試行しない: 待っても変わらず、日誌を遡る読みを黙って繰り返すため
          shouldRetryOnError: (error: Error) =>
            !(error instanceof ApiError && error.status === 404),
        },
  );
}

export function useApprovalById(id: string | null) {
  const api = useApi();
  // この mount の最初の取り直しが済んだ id: キャッシュに前に開いたときの「未回答」が残っていても、
  // 呼び出し側が済むまで信用しないで済むようにする（`isValidating` だけだと最初の描画で false のことがある）
  const [revalidatedId, setRevalidatedId] = useState<string | null>(null);
  const sawValidating = useRef(false);
  const swr = useSWR(
    id === null ? null : KEY.approvalById(id),
    async ({ byId }) => {
      const result = await api.api.GET('/approvals/{id}', { params: { path: { id: byId } } });
      // 404 だけを `null` にし、それ以外の失敗は投げる: 「無い」と「確かめられなかった」を取り違えないため
      if (result.response.status === 404) return null;
      return unwrap(result);
    },
    {
      // 開くたびに必ず取り直す: 別の経路（チャット・CLI・別タブ）で答えられていても古い値のままにしない
      revalidateOnMount: true,
      onSuccess: () => setRevalidatedId(id),
      onError: () => setRevalidatedId(id),
    },
  );
  const { isValidating } = swr;
  // 取り直しが他の呼び出しと重なって自分の onSuccess が呼ばれない場合に備え、「検証中を見たあと止まった」でも済みとする
  useEffect(() => {
    if (id === null) return;
    if (isValidating) sawValidating.current = true;
    else if (sawValidating.current) setRevalidatedId(id);
  }, [id, isValidating]);
  return { ...swr, revalidated: id !== null && revalidatedId === id };
}

export function useApprovalTrace(id: string | null) {
  const api = useApi();
  return useSWR(id === null ? null : KEY.approvalTrace(id), ({ id }) =>
    api.api.GET('/approvals/{id}/trace', { params: { path: { id } } }).then(unwrap),
  );
}

export function useRunners() {
  const api = useApi();
  return useSWR(KEY.runners, () => api.api.GET('/runners').then(unwrap));
}

export function useTokens() {
  const api = useApi();
  return useSWR(KEY.tokens, () => api.api.GET('/tokens').then(unwrap));
}

export function useAccess() {
  const api = useApi();
  return useSWR(KEY.access, () => api.api.GET('/access').then(unwrap));
}

export function usePermissionGrants() {
  const api = useApi();
  return useSWR(KEY.permissionGrants, () => api.api.GET('/permission-grants').then(unwrap));
}

/** Codex の ChatGPT ログインの状態（#3939）。値は返らない。 */
export function useCodexAuth() {
  const api = useApi();
  return useSWR(KEY.codexAuth, () => api.api.GET('/codex/auth').then(unwrap));
}

/**
 * デバイスコードのログイン1本の進み具合（#3939）。**決着するまで2秒ごとに見に行く**（人間が
 * ブラウザで承認したことを、画面を触らずに知るため）。`id` が無ければ何もしない。
 */
export function useCodexLogin(id: string | undefined) {
  const api = useApi();
  return useSWR(
    id === undefined ? null : KEY.codexLogin(id),
    () => api.api.GET('/codex/login/{id}', { params: { path: { id: id ?? '' } } }).then(unwrap),
    {
      refreshInterval: (latest) => (latest === undefined || latest.state === 'pending' ? 2000 : 0),
    },
  );
}

export function useCredentials() {
  const api = useApi();
  return useSWR(KEY.credentials, () => api.api.GET('/credentials').then(unwrap));
}

// フォーカス・再接続で再取得しない: 本文には鍵が入りうるので、画面が開いているあいだ勝手に何度も運ばせない
export function useProfile() {
  const api = useApi();
  // 古いデーモン（`entries` 無しの応答）も `default` 1行として読める形にする: 「新しい画面 × 古いデーモン」の窓が必ず生じるため
  return useSWR(KEY.profile, () => api.api.GET('/profile').then(unwrap).then(normalizeProfile), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

export function useIntegrationKeys() {
  const api = useApi();
  return useSWR(KEY.integrationKeys, () => api.api.GET('/integration-keys').then(unwrap));
}

// フォーカス・再接続で再取得しない: 値に鍵が入りうるので、画面が開いているあいだ勝手に何度も運ばせない
export function useMcpServers() {
  const api = useApi();
  return useSWR(KEY.mcpServers, () => api.api.GET('/mcp-servers').then(unwrap), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

export function usePlugins() {
  const api = useApi();
  return useSWR(KEY.plugins, () => api.api.GET('/plugins').then(unwrap), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

export function useDropped() {
  const api = useApi();
  return useSWR(KEY.dropped, () => api.api.GET('/dropped').then(unwrap));
}

export function useInboxBacklog() {
  const api = useApi();
  return useSWR(KEY.inbox, () => api.api.GET('/inbox').then(unwrap));
}

export function useArchive() {
  const api = useApi();
  return useSWR(KEY.archive, () => api.api.GET('/archive').then(unwrap));
}

export function useArchiveSessions() {
  const api = useApi();
  return useSWR(KEY.archiveSessions, () => api.api.GET('/archive/sessions').then(unwrap));
}

export type ArchiveBody =
  { kind: 'body'; body: string } | { kind: 'removed'; removedAt: string; bytes: number };

// 再取得（フォーカス・再接続）を止める: 大きな本文を、画面を開いているあいだ何度も運ばせないため
export function useArchiveBody(id: string | null) {
  const api = useApi();
  return useSWR(
    id === null ? null : KEY.archiveBody(id),
    async ({ id }): Promise<ArchiveBody> => {
      const result = await api.api.GET('/archive/{id}', {
        params: { path: { id } },
        parseAs: 'text',
      });
      const { status } = result.response;
      if (status === 410) {
        const removed: unknown = result.error;
        const { removedAt, bytes } = (
          typeof removed === 'object' && removed !== null ? removed : {}
        ) as { removedAt?: unknown; bytes?: unknown };
        if (typeof removedAt === 'string' && typeof bytes === 'number') {
          return { kind: 'removed', removedAt, bytes };
        }
        throw new ApiError(status, '消された印の応答が読めない');
      }
      if (result.response.ok && result.data === undefined) return { kind: 'body', body: '' };
      return { kind: 'body', body: unwrap(result) };
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );
}

export { summarizeJournalEntry } from '@alteroid/logic';
