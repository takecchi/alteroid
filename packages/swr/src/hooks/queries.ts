/**
 * 読み取りの hooks。
 *
 * SWR のキーは**文字列ではなくオブジェクト**にしてある。文字列だと連結の順番や
 * 区切りで衝突しうるし、何のキャッシュなのかが読めない。`{type: ...}` にしておけば
 * `mutate` 側でも同じ形で指せる（`packages/swr/src/hooks/use-journal-live.ts`）。
 */
import useSWR from 'swr';

import { ApiError, unwrap, useApi } from '../api';
import { normalizeProfile } from '@alteroid/logic';
import type {
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
  /**
   * 誰が（層）・どこで（場所）。**4つの口すべてに同じ絞り込みを置く**ため、
   * 画面にも API・CLI・クローンの道具と同じものがある（PRD「インターフェース」）。
   */
  layer?: UsageLayer;
  site?: UsageSite;
  /**
   * どの認証トークンで（issue #2059）。画面の token 欄はここに積んでいたのに、
   * この型に欄が無く、下の `useUsage` も取り出していなかったので、`GET /usage`
   * へ届いていなかった（欄に入れても絞り込まれなかった）。
   */
  tokenId?: string;
}

/**
 * `GET /managers` の絞り込みと窓（issue #670）。
 *
 * **全部 optional で、1つも渡さない呼びはクエリ文字列を1文字も付けない。**
 * デーモン側が opt-in（渡さなければ応答が1バイトも変わらない）なので、
 * 画面側でも「渡さない」を渡せる形にしておく必要がある——ここで既定値を
 * 埋めると、`dashboard.tsx` の `useManagers()`（引数なし）が黙って窓の
 * 掛かった呼びに変わる。
 *
 * **`status` は配列で受けてカンマ区切りへ畳む**（`useJournal` の `types` と
 * 同じ形）。**空配列は「絞らない」** ——`status=` を送るのと同じ結果に
 * なるが、そもそもパラメタを付けない側に倒す（クエリ文字列が空のままなら、
 * 上の opt-in がそのまま効く）。
 *
 * **錨は `managerId` ＋ `startedAt` の組で渡す**（片方だけは 400）。値は
 * 応答に載っている `managerId` / `startedAt` をそのまま使う——封筒
 * （`total` / `nextCursor`）は無い（`apps/daemon/src/app.ts` の
 * `managersQuery` の doc）。
 */
export interface ManagersQuery {
  status?: readonly ManagerStatus[];
  limit?: number;
  after?: { managerId: string; startedAt: string };
}

/**
 * SWR のキーはオブジェクトなので、`type` を見て束で指す。
 *
 * `use-journal-live.ts`（無効化）と `mutations.ts`（自分の送信の即時反映）の
 * 両方から使うのでここに置く。キーの形を決めているのがこのファイルなので、
 * その判定もここに置くのが自然（重複させない）。
 */
export function isKeyOfType(key: unknown, type: string): boolean {
  return typeof key === 'object' && key !== null && (key as { type?: unknown }).type === type;
}

export const KEY = {
  health: { type: 'health' } as const,
  status: { type: 'status' } as const,
  attachmentLimits: { type: 'attachmentLimits' } as const,
  /**
   * **窓ごとに別のキーになる**（issue #670）。かつてここは
   * `{ type: 'managers' }` の1つだけで、`mutate(KEY.managers)` が呼べていた。
   *
   * **⚠️ その形はもう使えない。** 関数になった `KEY.managers` を
   * `mutate(KEY.managers)` へ渡すと、SWR は**キーではなく絞り込みの述語**
   * として受け取る（`mutate(fn)` の形）。述語は毎回真値のオブジェクトを
   * 返すので、**キャッシュの全キーが落ちる**——型検査は通り、画面は
   * 「よく効いている」ように見えるので、気づく契機が無い。
   *
   * ⟹ **落とすときは必ず束で指すこと**（`mutate((key) => isKeyOfType(key,
   * 'managers'))`）。`journal` / `reports` / `conversations` / `approvals` が
   * 既にそうしている形と同じである。
   */
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
  /**
   * ある会話に上がった確認だけの束（issue #782 の2・3）。
   *
   * **`type` は `approvals` のまま揃えてある。** `use-journal-live.ts` の
   * `invalidate()` は `escalation` が届くと `isKeyOfType(key, 'approvals')`
   * で束ねて無効化する——ここだけ別の `type` にすると、確認に答えが付いた
   * ときにこのキャッシュだけ古いまま取り残される。
   */
  conversationApprovals: (conversationId: string) =>
    ({ type: 'approvals', pending: false, conversationId }) as const,
  /**
   * 回答済みの画面（`approvals/answered`）の2つの読み。**どちらも `type` は `approvals` のまま
   * 揃えてある**（上の `conversationApprovals` と同じ理由——`escalation` が届いたときの束での
   * 無効化から外れると、答えが付いた直後の画面だけ古いまま取り残される）。
   */
  approvalsAnsweredDates: (limit: number) =>
    ({ type: 'approvals', answeredDates: true, limit }) as const,
  approvalsAnsweredOn: (date: string) => ({ type: 'approvals', answeredOn: date }) as const,
  /** 承認を id で1件（`GET /approvals/{id}`）。`type` は `approvals` のまま（上と同じ理由）。 */
  approvalById: (id: string) => ({ type: 'approvals', byId: id }) as const,
  commitments: (includeClosed: boolean) => ({ type: 'commitments', includeClosed }) as const,
  reports: (limit: number) => ({ type: 'reports', limit }) as const,
  report: (date: string) => ({ type: 'report', date }) as const,
  journal: (limit: number, types: string) => ({ type: 'journal', limit, types }) as const,
  schedule: { type: 'schedule' } as const,
  /** `windowHours` を含める。窓ごとに別の集計なので、キーが同じだと切り替えても古い窓の値が出る。 */
  progress: (windowHours: number | undefined) => ({ type: 'progress', windowHours }) as const,
  usage: (query: UsageQuery) => ({ type: 'usage', ...query }) as const,
  memory: { type: 'memory' } as const,
  memoryDoc: (slug: string) => ({ type: 'memoryDoc', slug }) as const,
  practices: { type: 'practices' } as const,
  practice: (slug: string) => ({ type: 'practice', slug }) as const,
  practiceVersions: (slug: string) => ({ type: 'practiceVersions', slug }) as const,
  practiceVersion: (slug: string, version: number) =>
    ({ type: 'practiceVersion', slug, version }) as const,
  /**
   * `pages` は「もっと見る」で何頁ぶん読むか（#3550）。頁数が違えば別の取得なので、キーに含める。
   * `isKeyOfType(key, 'conversations')` は `type` だけを見るので、楽観更新・既読・SSE の無効化の束ねは変わらない。
   */
  conversations: (limit: number, pages = 1) => ({ type: 'conversations', limit, pages }) as const,
  /**
   * **`includeSuperseded` をキーに含める（チャットのメッセージ編集、#1010）。**
   *
   * `chat.tsx`（版の切り替えを組み立てるため `includeSuperseded: true` で読む）と
   * `approvals.tsx`（既定ビューだけでよい）が同じ会話 id を別の形で読むので、
   * キーを分けないと SWR のキャッシュが1枠を取り合い、後勝ちの形が先勝ちを
   * 上書きする——`isKeyOfType(key, 'conversation')`（`use-journal-live.ts` の
   * 無効化）は `type` だけを見るので、この欄を足しても無効化の束ね方は変わらない。
   */
  conversation: (id: string, includeSuperseded = false) =>
    ({ type: 'conversation', id, includeSuperseded }) as const,
  approvalTrace: (id: string) => ({ type: 'approvalTrace', id }) as const,
  runners: { type: 'runners' } as const,
  tokens: { type: 'tokens' } as const,
  access: { type: 'access' } as const,
  credentials: { type: 'credentials' } as const,
  profile: { type: 'profile' } as const,
  mcpServers: { type: 'mcpServers' } as const,
  integrationKeys: { type: 'integrationKeys' } as const,
  permissionGrants: { type: 'permissionGrants' } as const,
  dropped: { type: 'dropped' } as const,
  archive: { type: 'archive' } as const,
  archiveSessions: { type: 'archiveSessions' } as const,
  archiveBody: (id: string) => ({ type: 'archiveBody', id }) as const,
  inbox: { type: 'inbox' } as const,
};

/** デーモンが応答するか。接続先が合っているかの唯一の手がかりでもある。 */
export function useHealth() {
  const api = useApi();
  return useSWR(KEY.health, () => api.api.GET('/health').then(unwrap), {
    // 繋がらないときに黙って諦めない（接続先を直したらすぐ復帰してほしい）。
    errorRetryInterval: 5000,
    refreshInterval: 30_000,
  });
}

/**
 * デーモン自身の説明（いまは記憶の置き場）。**資格が要る**（`GET /status`。#2869）。
 * 無認証の `/health` は置き場を返さないので、置き場はここから取る。
 * 資格が通らない（401）ときは `error` になる——呼び出し側は例外にせず表示で受ける。
 */
export function useStatus() {
  const api = useApi();
  return useSWR(KEY.status, () => api.api.GET('/status').then(unwrap), {
    errorRetryInterval: 5000,
  });
}

/**
 * デーモンの添付の上限（`GET /attachments/limits`。#3204）。先行検査に使う。
 * - 取れた値は SWR のキャッシュに覚える（再検証しない）。
 * - 古いデーモンの 404 は `null` を値として覚える（取り直さない。呼び手は既定値で検査する）。
 * - 接続失敗など一時的な失敗は `data` が無いまま `error` になり、次にこの hook が使われたとき
 *   （画面の表示）に取り直す。再試行の自動ループはしない。最終判断はデーモン。
 */
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

/**
 * 委譲先マネージャーの一覧（issue #670 で絞り込みと窓が付いた）。
 *
 * **引数なしの呼びは、クエリ文字列を1文字も付けない。** デーモン側が opt-in
 * なので、`dashboard.tsx` の `useManagers()` はこの変更の前と1バイトも同じ
 * 応答を受ける（`managersToQuery` がそれを支えている——空の欄を落とすのは
 * 見た目の整えではなく、この保証そのものである）。
 *
 * **空の `query` を渡しても URL は変わらない。** `openapi-fetch` の
 * `createFinalURL` は `querySerializer(params.query ?? {})` の結果が空文字なら
 * `?` そのものを付けない（`openapi-fetch@0.17.0` の `createFinalURL`）。
 * ⟹ ここで `params` を条件付きで外す必要は無い。**この主張は
 * `managers.test.tsx` の「引数なしの呼びは `?` を付けない」で測ってある**
 * ——上流の実装に乗った主張なので、版が上がったら歯の側が落ちる。
 */
export function useManagers(query: ManagersQuery = {}) {
  const api = useApi();
  const params = managersToQuery(query);
  return useSWR(KEY.managers(query), () =>
    api.api.GET('/managers', { params: { query: params } }).then(unwrap),
  );
}

/**
 * `ManagersQuery` を `GET /managers` のクエリへ畳む。
 *
 * **空の欄は付けない**（`undefined` の欄すら作らない）。これは見た目の整えでは
 * なく、**デーモン側の opt-in を成り立たせているものである**——あちらは
 * 生のクエリ（`c.req.query('limit') !== undefined`）で「渡されたか」を判定する
 * ので、空の値を送った時点で窓の掛かった呼びに化ける。
 *
 * **`status` の空配列は「絞らない」。** `status=` を送っても同じ結果になる
 * （デーモン側が空を「渡さなかった」と同じに扱う）が、送らない側に倒せば
 * 上の opt-in がそのまま効く。
 */
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

/**
 * 生ログ。`text/plain` の JSONL がそのまま返る。
 *
 * `null` を渡すと取りに行かない（SWR の条件付き取得）。**空文字を渡して
 * `/managers//transcript` を叩かせない** — 404 が「無い」なのか「聞き方が
 * 間違っている」なのか区別できなくなる。
 */
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

/**
 * 承認待ちの一覧。
 *
 * **`order` を明示して呼ぶ。窓（`limit` / `cursor`）は作らない。**
 *
 * 直しているのは**並びの不安定さ**であって、件数の可視化ではない。ここは全件を
 * 受け取っているので、応答へ載る `total` は受け取った配列の長さと必ず一致する
 * 冗長な値である（**だから画面には出さない** — 出すと「意味の在る数」に見える）。
 *
 * **何が不安定だったか。** `order` / `limit` / `cursor` のどれも渡さない呼びは、
 * デーモンがストアの生の並びをそのまま返す（`apps/daemon/src/app.ts` の
 * `/approvals`）。そしてその生の並びは**実装ごとに違う**:
 *
 * - `packages/storage-fs` / `packages/core/src/testing.ts` — 配列・Map の挿入順。
 *   `putApproval` が既存の id を**末尾へ動かす**ので、回答するたびに並びが変わる
 * - `packages/storage-pg` — `orderBy(asc(approvals.createdAt))` で既に作成順
 *
 * ⟹ **同じ画面が、どの永続化層で動いているかによって違う順で出ていた。**
 * `order` を明示すると、デーモンが `(createdAt, id)` の昇順へ揃えるので
 * （`compareApprovalPagingKey`）、**実装によらず同じ順になる。**
 *
 * **既定値と同じ `'asc'` を送っている。** 並びの意味は変えず、「渡した」という
 * 事実だけで封筒と整列を有効にする（デーモン側は生のクエリで opt-in を判定する）。
 */
export function useApprovals(pending = true) {
  const api = useApi();
  return useSWR(KEY.approvals(pending), ({ pending }) =>
    api.api
      .GET('/approvals', {
        params: { query: { pending: pending ? 'true' : 'false', order: 'asc' } },
      })
      .then(unwrap),
  );
}

/**
 * 承認が決着した日と件数（`GET /approvals/answered-dates`。新しい日が上）。回答済みの画面の
 * 左の目次。**日はデーモンの `localDate()` で決まる**（日報と同じ区切り。ブラウザの TZ ではない）。
 * `GET /reports` と同じく封筒は無いので、続きが在るかは `limit` 件ちょうど返ったかで判る。
 */
export function useAnsweredApprovalDates(limit = 60) {
  const api = useApi();
  return useSWR(KEY.approvalsAnsweredDates(limit), ({ limit }) =>
    api.api.GET('/approvals/answered-dates', { params: { query: { limit } } }).then(unwrap),
  );
}

/**
 * その日に決着した承認（回答済み・取り下げ済み）を決着の新しい順に（`GET /approvals?answeredOn=`）。
 * 並びも「その日」の意味もデーモンが決める——**画面で並べ直さない**。`null` なら取りに行かない
 * （日がまだ決まっていない）。
 */
export function useApprovalsAnsweredOn(date: string | null) {
  const api = useApi();
  return useSWR(date === null ? null : KEY.approvalsAnsweredOn(date), ({ answeredOn }) =>
    api.api.GET('/approvals', { params: { query: { answeredOn } } }).then(unwrap),
  );
}

/**
 * ある会話に上がった確認（`ask_human`）だけの一覧（issue #782 の2）。
 *
 * **`chat.tsx` がチャットの履歴へ質問・回答を織り込むために読む。** 質問は
 * `createdAt` の位置へ、回答は `answeredAt` の位置へ——両方とも `chat.tsx`
 * の `historyLines` が担う。
 *
 * **`pending=false` を渡す。** 答えた分も含めて取らないと、回答済みの確認が
 * 画面をリロードした瞬間に「まだ返答が無い」へ戻って見える——新しい「嘘の
 * 『無い』」を作ってしまう（不変条件 A）。
 *
 * `null` なら取りに行かない（まだ会話 id が無い＝新しい会話。`useConversation`
 * と同じ形）。
 */
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

/**
 * 引き受けたまま終わっていない仕事の台帳。
 *
 * **承認待ちとは別のものである。** あちらは「クローンが人間の答えを待って止まって
 * いる」で、こちらは「頼まれたことがまだ片付いていない」。止まっていなくても
 * 片付いていない仕事はあるので、片方で他方は代用できない。
 *
 * 並びはデーモンが決める（未了が古い順、片付いたものが新しい順で後ろ。
 * `packages/core/src/store.ts` の `CommitmentStore`）。**画面で並べ直さない** —
 * 並べ直すと、齢の見え方が CLI・クローンとここで食い違う。
 */
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
    // **`includeClosed` を切り替えて別キーになっても、前の一覧を出したままにする（#3074）。**
    // 初回は `data` が無く `isLoading` が真になり、画面が一覧をスピナーに置き換えると、
    // 未了の行の書きかけ（本文の下書き・片付ける理由）が unmount で黙って消える。
    // 前のキーのデータは読み込み中だけ `data` に載る（`isValidating` は真のまま）。
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

/**
 * 作業の進捗（`GET /progress`）。`windowHours` は速度と見込みを数える窓の長さで、省略すると
 * デーモンの既定（168 時間）。30 秒ごとに取り直す（`useSchedule` と同じ間隔）。
 */
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
    // **窓を替えて別キーになっても、前の数を出したままにする（#3419。`useCommitments` の #3074 と同じ）。**
    // 前のキーのデータは読み込み中だけ `data` に載り、`isLoading` は真になる。
    // 画面は、その間「前の期間の数」と数のそばで言うこと。
    { refreshInterval: 30_000, keepPreviousData: true },
  );
}

/**
 * 利用状況（いくら使ったか）。経路は `GET /usage` の1本だけで、CLI・chat の
 * `/usage`・クローンの `usage_read` と同じものを見る（`apps/daemon/src/app.ts`
 * 「経路は1本だけにする」）。
 */
export function useUsage(query: UsageQuery = {}) {
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
    // **絞り込みや期間を替えて別キーになっても、前の中身を出したままにする（#3419。`useCommitments` の #3074 と同じ）。**
    // 前のキーのデータは読み込み中だけ `data` に載り、`isLoading` は真になる。
    // 画面は、その間「前の条件の数字」と数のそばで言うこと。
    { keepPreviousData: true },
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

/**
 * 仕事のやり方（#1055 段3③）。`useMemoryDocuments` / `useMemoryDocument` と
 * 同じ形——一覧はメタ情報だけ、詳細は本文まで。
 */
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

/**
 * やり方の追記専用の版の履歴（メタだけ。#1309）。`usePractices` と同じ形——
 * 本文は含まない。個別の本文は `usePracticeVersion` で読む。
 */
export function usePracticeVersions(slug: string) {
  const api = useApi();
  return useSWR(KEY.practiceVersions(slug), ({ slug }) =>
    api.api.GET('/practices/{slug}/versions', { params: { path: { slug } } }).then(unwrap),
  );
}

/** やり方の版を1つ、本文まで読む（#1309）。`version` が無ければ問い合わせない。 */
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

/**
 * 会話の一覧。**`pages` 頁ぶんを、継続点（`nextCursor`）で順に辿って1つの一覧にする**（「もっと見る」、
 * #3404 → #3550。`limit` を増やして取り直す形では 201 件目以降と `scan` の窓の外へ辿り着けなかった）。
 *
 * - **1 頁目は `cursor` 無し**（従来と同じ呼び）。2 頁目以降は**直前の頁の応答の `nextCursor`** を渡す。
 *   取り直すたびに先頭から辿り直すので、新しい発言で並びが動いても、頁の継ぎ目で会話を落とさない
 *   （保存した継続点を使い回すと、先頭に新しい会話が入った分だけ押し出された会話が、どの頁にも出なくなる）。
 * - **同じ会話が頁をまたいで現れたら、先の（新しい側の）頁の1件だけを残す。**
 * - `reachedStart` / `hiddenByLimit` / `scanned` / `nextCursor` は**最後に読んだ頁**のもの
 *   （どこまで辿ったかを言う）。`windowsComplete` は、**どの頁の窓も**日誌の先頭に届いていたか
 *   （偽なら、一覧の `messages` は下限である）。
 * - どの頁かの取得に失敗したら、一覧全体を失敗にする（SWR の `error`）。**頁の欠けた一覧を成功のように
 *   返さない**。`keepPreviousData` なら直前の一覧は残る。
 *
 * **`keepPreviousData`（一覧の「もっと見る」、#3404）。** `pages` を増やすと鍵が変わるので、
 * 既定のままだと取り直しの間（と失敗したとき）に一覧が消える。真なら直前の一覧を残す。
 */
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
      for (let index = 0; index < pages; index += 1) {
        const page: ConversationsResponse = await api.api
          .GET('/conversations', {
            params: { query: { limit, ...(cursor === undefined ? {} : { cursor }) } },
          })
          .then(unwrap);
        first ??= page;
        last = page;
        if (page.reachedStart === false) windowsComplete = false;
        for (const conversation of page.conversations) {
          if (seen.has(conversation.conversationId)) continue;
          seen.add(conversation.conversationId);
          conversations.push(conversation);
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      // `pages >= 1` なので `first` / `last` は必ず入る。
      const { readStateUnreadable } = first as ConversationsResponse;
      const tail = last as ConversationsResponse;
      return {
        ...tail,
        conversations,
        windowsComplete,
        ...(readStateUnreadable === undefined ? {} : { readStateUnreadable }),
      };
    },
    // 失敗した直後にもう一度押したとき、SWR の重複排除（既定 2 秒）で取り直しを飲ませない。
    options.keepPreviousData === true ? { keepPreviousData: true, dedupingInterval: 0 } : undefined,
  );
}

/**
 * `null` なら取りに行かない（まだ会話 id が無い＝新しい会話）。
 *
 * **`includeSuperseded`（チャットのメッセージ編集、#1010）。** 既定は `false`
 * （編集で畳まれた旧発言とその応答を含めない、サーバの既定と同じ）。`chat.tsx`
 * は版の切り替え（`< 2/2 >`）を組み立てるために `true` で読む——**畳み込み
 * 規則そのものは画面側で再実装しない**（サーバの `supersedes` / `supersededBy`
 * をそのまま束ねるだけ。`packages/core/src/conversation.ts` の
 * `computeSupersededIds` が正本）。
 */
export function useConversation(id: string | null, options: { includeSuperseded?: boolean } = {}) {
  const api = useApi();
  const includeSuperseded = options.includeSuperseded ?? false;
  return useSWR(id === null ? null : KEY.conversation(id, includeSuperseded), ({ id }) =>
    api.api
      .GET('/conversations/{id}', {
        params: {
          path: { id },
          query: { includeSuperseded: includeSuperseded ? 'true' : 'false' },
        },
      })
      .then(unwrap),
  );
}

/**
 * 承認を id で1件、決着した日つきで（`GET /approvals/{id}`）。`/approvals/item/:approvalId` の入口が
 * 移り先を決める1回の読み。**`id` が null なら取りに行かない。** 無ければ（404）`null`、
 * それ以外の失敗は投げる（SWR の `error`）。
 */
export function useApprovalById(id: string | null) {
  const api = useApi();
  return useSWR(id === null ? null : KEY.approvalById(id), async ({ byId }) => {
    const result = await api.api.GET('/approvals/{id}', { params: { path: { id: byId } } });
    // 404 は「無い」（`null`）。それ以外の失敗（5xx・409＝読めない行・繋がらない）は投げる——
    // 「無い」と「確かめられなかった」を取り違えない。
    if (result.response.status === 404) return null;
    return unwrap(result);
  });
}

/**
 * 承認の答えと、その後にクローンが取った行動の対（`GET /approvals/:id/trace`。
 * issue #847 の案B）。**`id` が null なら取りに行かない**——画面は人間が開いた
 * ときだけ読む（答え済みのカードを並べただけで全件ぶん日誌を走査しないため）。
 */
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

/**
 * 認証トークンのプールと、回す契機・冷却の設定（`GET /tokens`）。
 *
 * **alteroid を使う許可があれば読める**（2026-09-06 の同格化で `requireOperator` が
 * 外れた。それ以前は実行環境の持ち主だけだった）。**2026-09-14 以降、この hook を
 * 呼ぶ画面（`routes/tokens.tsx`）は `PUT /tokens` も呼ぶ**（追加・削除・
 * 無効化/有効化——`mutations.ts` の `useAddToken` / `useRemoveToken` /
 * `useSetTokenDisabled`）。**もう読み取り専用ではない。** **2026-09-20 以降、
 * 回す契機・冷却の設定（`policy`）も同じ画面から変えられる**（`mutations.ts` の
 * `useSetTokenPolicy`、`PUT /tokens/policy`。Issue #1123）——CLI
 * （`alteroid token policy`）だけの仕事ではなくなった。
 */
export function useTokens() {
  const api = useApi();
  return useSWR(KEY.tokens, () => api.api.GET('/tokens').then(unwrap));
}

/**
 * ログインしたアカウントと許可の一覧（`GET /access`）。CLI の
 * `alteroid access list` と同じもの。
 *
 * **alteroid を使う許可があれば読める**（2026-09-06 の同格化で `requireOperator`
 * が外れた。それ以前は実行環境の持ち主だけだった——`/tokens` と同格。
 * `.claude/skills/auth-and-access/SKILL.md`）。**読み取り専用**——`grant` /
 * `revoke` はこの hook を呼ぶ画面（`routes/access.tsx`）からは呼ばない
 * （Issue #213。理由はその画面の doc）。
 */
export function useAccess() {
  const api = useApi();
  return useSWR(KEY.access, () => api.api.GET('/access').then(unwrap));
}

/**
 * 人間が承認した Bash 許可の一覧（`GET /permission-grants`。Issue #863）。
 * CLI の `alteroid permission list` と同じもの。
 *
 * **資格は認証のみ**（`/access` と同じ強さ。`apps/daemon/src/app.ts` の
 * `GET /permission-grants` は `deliberateClient` を要求していない）。
 * **有効・取り消し済みの両方を返す**——絞り込み（既定は有効なものだけ）は
 * 画面側で行う（`routes/permissions.tsx`。CLI の `--all` と同じ形）。
 */
export function usePermissionGrants() {
  const api = useApi();
  return useSWR(KEY.permissionGrants, () => api.api.GET('/permission-grants').then(unwrap));
}

/**
 * 環境変数の袋（`GET /credentials`。旧「マネージャーへ降ろす環境変数」）。
 *
 * **資格は `authenticate` だけ**（`PUT /credentials` は実行環境の持ち主だけ
 * だが、読み出しは指紋のみを返すので `/tokens` / `/credentials` GET と同じ
 * 強さで開けてある）。
 */
export function useCredentials() {
  const api = useApi();
  return useSWR(KEY.credentials, () => api.api.GET('/credentials').then(unwrap));
}

/**
 * 実行環境プロファイル（`GET /profile`。issue #1122）。
 *
 * **資格は `requireOwner`**（`/credentials` の GET と違い、本文を丸ごと返す口
 * だからである）。ただし中身は素通しで、許可済みでログインできるアカウントは全員
 * 通る（2026-10-05 オーナー決定、#2862 / PR #2945）。403 が返るのは許可の無い
 * アカウント（`authenticate`）だけ——判定はサーバに任せ、呼び出し側（`routes/profile.tsx`）
 * は返ってきた失敗をそのまま見せる。
 *
 * **フォーカス・再接続での再取得をしない。** 本文には鍵が入りうるので、画面が
 * 開いているあいだに勝手に何度も運ばせない（取り直すのは保存した直後だけ）。
 */
export function useProfile() {
  const api = useApi();
  // **古いデーモン（`entries` 無しの応答）も `default` 1行として読める形にする**
  // （`normalizeProfile`）。Web は Vercel でマージ直後に入るが、デーモンは1日1回夜に入るので、
  // 「新しい画面 × 古いデーモン」の窓が必ず生じる。型は新しい形を約束するので、実行時の倒れ先である。
  return useSWR(KEY.profile, () => api.api.GET('/profile').then(unwrap).then(normalizeProfile), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

/**
 * 連携の鍵の一覧（`GET /integration-keys`。#3113 段2）。値は返らない。
 *
 * **フォーカス・再接続での再取得は既定のまま**（他の一覧と同じ。`lastUsedAt` が動くので取り直す価値がある）。
 * 再取得が失敗しても SWR は `data` を残す——画面は `error` を帯で言うだけで、一覧も発行の欄も消さない。
 */
export function useIntegrationKeys() {
  const api = useApi();
  return useSWR(KEY.integrationKeys, () => api.api.GET('/integration-keys').then(unwrap));
}

/**
 * 人間の MCP 連携の登録（`GET /mcp-servers`。#325 段4）。
 *
 * **資格は `requireOwner`**（`/profile` と同じ）。ただし中身は素通しで、許可済みで
 * ログインできるアカウントは全員持ち主として通る（2026-10-05 オーナー決定、#2862 / PR #2945）。
 * 403 が返るのは許可の無いアカウント（`authenticate`）だけで、その失敗を
 * 呼び出し側（`routes/mcp-servers.tsx`）がそのまま見せる。
 *
 * **フォーカス・再接続での再取得をしない**（`useProfile` と同じ理由 —— 値に鍵が
 * 入りうるので、画面が開いているあいだに勝手に何度も運ばせない）。
 */
export function useMcpServers() {
  const api = useApi();
  return useSWR(KEY.mcpServers, () => api.api.GET('/mcp-servers').then(unwrap), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

/**
 * 握り潰しの跡（`GET /dropped`）。**資格は認証のみ**（`/journal` `/managers`
 * `/conversations` と同じ強さ。`requireOperator` は付いていない——
 * `apps/daemon/src/app.ts` の `GET /dropped` の doc）。読み取り専用。
 */
export function useDropped() {
  const api = useApi();
  return useSWR(KEY.dropped, () => api.api.GET('/dropped').then(unwrap));
}

/**
 * 受信箱の滞留の内訳（`GET /inbox`。issue #783 段0の最後の欠落）。**資格は
 * 認証のみ**（`POST /inbox/remove` と同じ強さ）。読み取り専用——
 * `claimPending()` ではなく `peekPending()` を使うので、呼んでも
 * `deliveries`（器の入れ替え回数）は1つも進まない（`apps/daemon/src/app.ts`
 * の `GET /inbox` の doc）。
 *
 * クローンの道具 `manager_list` の中にしか出ていなかった内訳が、これで
 * 3つの入口（HTTP・CLI の `alteroid inbox show`・この Web UI）すべてから
 * 読める——集計は `@alteroid/core` の `summarizeInboxBacklog` 1箇所でしか
 * 行われないので、3つが違う数を返すことは無い。
 */
export function useInboxBacklog() {
  const api = useApi();
  return useSWR(KEY.inbox, () => api.api.GET('/inbox').then(unwrap));
}

/**
 * アーカイブ済みセッション生ログの一覧（`GET /archive`）。CLI の `/archive`
 * と同じ口（#698）。**HTTP の口は上限を持たない**（意図——人間はブラウザで
 * 扱えるので、ここを締めると人間側の能力が落ちる。
 * `.claude/skills/listing-and-detail/SKILL.md`「HTTP の口は上限を持たない」）。
 */
export function useArchive() {
  const api = useApi();
  return useSWR(KEY.archive, () => api.api.GET('/archive').then(unwrap));
}

/**
 * `sessionId` ごとの行数・使用量の集計（`GET /archive/sessions`、#698）。
 * 「1本が何度積まれているか」を個々の大きさより先に見せる——調査の動機
 * そのもの（`apps/cli/src/chat.ts` の `/archive sessions` と同じ口）。
 */
export function useArchiveSessions() {
  const api = useApi();
  return useSWR(KEY.archiveSessions, () => api.api.GET('/archive/sessions').then(unwrap));
}

/** `useArchiveBody` の結果。本文が消された退避（410）は失敗ではなく、1つの正当な状態である。 */
export type ArchiveBody =
  { kind: 'body'; body: string } | { kind: 'removed'; removedAt: string; bytes: number };

/**
 * 退避した生ログ1件の本文（`GET /archive/{id}`、`text/plain` の JSONL。CLI の `/archive <id>`
 * と同じ口）。**大きくなりうる**ので、呼び出し側は一度に全部を描かないこと
 * （`routes/archive-detail.tsx`）。
 *
 * - **410 は例外にしない。** 本文だけ消された行（tombstone）は `{ kind: 'removed' }` で返す。
 *   応答の形が読めなければ例外（読めない応答を「消された」と言わない）。
 * - **404 と5xxは `ApiError`**（呼び出し側が「無い」と「読めなかった」を分ける）。
 * - **本文が空の200（`Content-Length: 0`）は `''`。** `openapi-fetch` はこれを `data: undefined`
 *   で返し、`unwrap` に通すと「200 OK」という失敗になる。
 * - `null` を渡すと取りに行かない。再取得（フォーカス・再接続）は止める——大きな本文を
 *   画面を開いているあいだ何度も運ばせない。
 */
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

/**
 * 日誌エントリを人間が読む1行に潰す。**実体は `@alteroid/logic` へ移した**（#2558）。
 * React にも SWR にも依存しない純関数で、CLI（`apps/cli`）も読めるようにするため。
 * 既存の import 元（`@alteroid/swr`）を壊さないよう、ここから再 export する。
 */
export { summarizeJournalEntry } from '@alteroid/logic';
