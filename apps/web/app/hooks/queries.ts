/**
 * 読み取りの hooks。
 *
 * SWR のキーは**文字列ではなくオブジェクト**にしてある。文字列だと連結の順番や
 * 区切りで衝突しうるし、何のキャッシュなのかが読めない。`{type: ...}` にしておけば
 * `mutate` 側でも同じ形で指せる（`app/hooks/use-journal-live.ts`）。
 */
import useSWR from 'swr';

import { unwrap, useApi } from '~/lib/api';
import type {
  JournalEntry,
  JournalEntryType,
  ManagerStatus,
  UsageLayer,
  UsageSite,
} from '~/lib/types';

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
  commitments: (includeClosed: boolean) => ({ type: 'commitments', includeClosed }) as const,
  reports: (limit: number) => ({ type: 'reports', limit }) as const,
  report: (date: string) => ({ type: 'report', date }) as const,
  journal: (limit: number, types: string) => ({ type: 'journal', limit, types }) as const,
  schedule: { type: 'schedule' } as const,
  usage: (query: UsageQuery) => ({ type: 'usage', ...query }) as const,
  memory: { type: 'memory' } as const,
  memoryDoc: (slug: string) => ({ type: 'memoryDoc', slug }) as const,
  practices: { type: 'practices' } as const,
  practice: (slug: string) => ({ type: 'practice', slug }) as const,
  practiceVersions: (slug: string) => ({ type: 'practiceVersions', slug }) as const,
  practiceVersion: (slug: string, version: number) =>
    ({ type: 'practiceVersion', slug, version }) as const,
  conversations: (limit: number) => ({ type: 'conversations', limit }) as const,
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
  runners: { type: 'runners' } as const,
  tokens: { type: 'tokens' } as const,
  access: { type: 'access' } as const,
  credentials: { type: 'credentials' } as const,
  profile: { type: 'profile' } as const,
  dropped: { type: 'dropped' } as const,
  archive: { type: 'archive' } as const,
  archiveSessions: { type: 'archiveSessions' } as const,
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
  return useSWR(KEY.commitments(includeClosed), ({ includeClosed }) =>
    api.api
      .GET('/commitments', {
        params: { query: { includeClosed: includeClosed ? 'true' : 'false' } },
      })
      .then(unwrap),
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
 * 利用状況（いくら使ったか）。経路は `GET /usage` の1本だけで、CLI・chat の
 * `/usage`・クローンの `usage_read` と同じものを見る（`apps/daemon/src/app.ts`
 * 「経路は1本だけにする」）。
 */
export function useUsage(query: UsageQuery = {}) {
  const api = useApi();
  return useSWR(KEY.usage(query), ({ from, to, managerId, layer, site }) =>
    api.api
      .GET('/usage', {
        params: {
          query: {
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(managerId === undefined ? {} : { managerId }),
            ...(layer === undefined ? {} : { layer }),
            ...(site === undefined ? {} : { site }),
          },
        },
      })
      .then(unwrap),
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

export function useConversations(limit = 30) {
  const api = useApi();
  return useSWR(KEY.conversations(limit), ({ limit }) =>
    api.api.GET('/conversations', { params: { query: { limit } } }).then(unwrap),
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
 * **資格は `requireOperator`**（`/credentials` の GET と違い、本文を丸ごと返す口
 * だからである）。ブラウザは構造的に operator になれないので、認証を有効に
 * した構成では常に 403 が返る——判定はサーバに任せ、呼び出し側（`routes/profile.tsx`）
 * は返ってきた失敗をそのまま見せる。
 *
 * **フォーカス・再接続での再取得をしない。** 本文には鍵が入りうるので、画面が
 * 開いているあいだに勝手に何度も運ばせない（取り直すのは保存した直後だけ）。
 */
export function useProfile() {
  const api = useApi();
  return useSWR(KEY.profile, () => api.api.GET('/profile').then(unwrap), {
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

/**
 * `contextUsage` から「 文脈 X%（Y トークン）」の断片を作る（先頭に半角
 * スペースを含む。無ければ空文字）。`turn_usage`（欄が optional）と
 * `context_usage`（欄が必須）の両方の `summarizeJournalEntry` から呼ぶ
 * 共通部分——書き方を2箇所で複製しない（#976 で `context_usage` を
 * 足すときに揃えた）。
 */
function contextUsageNote(
  context: { percentage?: number; totalTokens?: number } | undefined,
): string {
  if (context === undefined || context.percentage === undefined) return '';
  return (
    ` 文脈 ${context.percentage}%` +
    (context.totalTokens === undefined ? '' : `（${context.totalTokens} トークン）`)
  );
}

/** 日誌エントリを人間が読む1行に潰す（一覧と通知で同じ文言を使うため）。 */
export function summarizeJournalEntry(entry: JournalEntry): string {
  switch (entry.type) {
    case 'exchange':
      return `${entry.with} ${entry.role === 'inbound' ? '←' : '→'} ${entry.text}`;
    case 'decision':
      return `${entry.decision}（根拠: ${entry.grounds}）`;
    case 'escalation':
      // **取り下げを先に見る（#963）。** `withdrawnAt` と `answeredAt` は
      // 正常な経路では両立しない（`schema.ts` の `journalEntrySchema` の
      // `escalation` 分岐、`withdrawnAt` の doc）。この分岐が無いと、
      // `approval_withdraw` が積む行（`answeredAt` 未設定）が「確認:」
      // （＝まだ誰も答えていない新しい質問）と誤読される——日誌フィード・
      // ダッシュボードのどちらも、取り下げた事実が読めなくなる
      // （issue #963 の受け入れ基準「取り下げの事実と理由が日誌に残る」は、
      // 行が在るだけでなく人間が読んで分かることを指す）。
      if (entry.withdrawnAt !== undefined) return `取り下げ済み: ${entry.question}`;
      return entry.answeredAt === undefined
        ? `確認: ${entry.question}`
        : `回答済: ${entry.question}`;
    case 'tool_use':
      return `${entry.actor} が ${entry.tool}`;
    case 'memory_update': {
      // **単位はバイトである**（`schema.ts` の `bytesBefore`/`bytesAfter` の
      // doc）。`entry.summary` には文字数が埋め込まれていることがある
      // （`memory_delete` の「削除直前 N 文字」）ので、バイトの注記は
      // `:` の手前——`cause`/`action` と同じ構造化された括弧の中——に置き、
      // 自由文の `summary` はコロンの後ろへ分ける（1行の中でも、単位の
      // 混ざる場所を分ける。#318 のコメントで実際に読み違いが起きている）。
      //
      // `action` と `bytesBefore`/`bytesAfter` は `optional`——この区別が
      // 導入される前の古いエントリは両方とも無い。無いことを `0` として
      // 出すと「変化が無かった」と読めてしまう（AGENTS.md の地雷表「取れない
      // 軸に 0 の行を作る」）ので、値が無いときは「不明」と明示し、
      // 黙って省かない（省くと、バイトが出ている行と混ざったときに
      // 「変化なし」に読める）。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      return `記憶 ${entry.slug} を更新（${entry.cause}${action} / ${bytes}）: ${entry.summary}`;
    }
    case 'daily_report':
      // **印の付いた行を「日報」と呼ばない**（`schema.ts` の `unavailable` の doc）。
      // 日誌の一覧は日報の有無を人間が拾い読みする面でもあるので、ここが
      // 「2026-08-20 の日報」としか言わないと、書けなかった日が書けた日と同じ顔で
      // 並ぶ。理由まで出すのは日報の面の仕事なので、ここでは印だけを言う。
      return entry.unavailable === undefined
        ? `${entry.date} の日報`
        : `⚠ ${entry.date} の日報は作れなかった: ${entry.unavailable}`;
    case 'external_event':
      return `${entry.source}: ${entry.summary}`;
    case 'worker_wait': {
      const cause = entry.byCause;
      return (
        `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
        `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
        `うち ${entry.toolless} ターンは道具を1つも動かしていない` +
        (entry.settled ? '' : '（区間は閉じずに終わった）')
      );
    }
    case 'turn_usage': {
      // **キャッシュの書き直しを潰さない**（read/write を分けたまま見せる。
      // 潰すと「キャッシュ書き直しに払っているか」が推測に戻る）。数え直しの
      // 印は隠さない — 印の行を一覧から見えなくすると誤読を招く。
      const models = Object.entries(entry.models);
      const totalCost = models.reduce((sum, [, totals]) => sum + totals.costUsd, 0);
      const cacheWrite = models.reduce(
        (sum, [, totals]) => sum + totals.cacheCreationInputTokens,
        0,
      );
      const cacheRead = models.reduce((sum, [, totals]) => sum + totals.cacheReadInputTokens, 0);
      // **⚠️ Issue #976 以降、これは唯一の経路ではない。** 独立した
      // `context_usage`（下のケース）が、失敗したターン・増分がゼロだった
      // ターンも含めて必ず残す——この欄は「成功して増分もあった回」に限り
      // 従来どおり載る（既存の読み手との互換のため）。
      const contextNote = contextUsageNote(entry.contextUsage);
      const compactionNote =
        entry.compactions === undefined || entry.compactions.length === 0
          ? ''
          : ` ⚠ compaction ${entry.compactions.length} 回`;
      return (
        `[${entry.layer}/${entry.site}] ${entry.managerId} 1ターン $${totalCost.toFixed(4)}` +
        `（cache read=${cacheRead} write=${cacheWrite}）` +
        contextNote +
        compactionNote +
        (entry.reset === undefined ? '' : ' ⚠ 数え直しを挟んだ回（models は差分ではない）')
      );
    }
    case 'context_usage': {
      // **消費（`turn_usage`）とは独立の行（Issue #976）。** 失敗したターン
      // （`turnSucceeded: false`）こそがこの型の存在理由——#976 より前は
      // どこにも残らなかった値である。
      const context = entry.contextUsage;
      const status = entry.turnSucceeded ? '成功' : '失敗';
      const note =
        context.error !== undefined
          ? `測れなかった（${context.error}）`
          : contextUsageNote(context).trim() || '（詳細なし）';
      return `[${entry.layer}/${entry.site}] ${entry.managerId} ターン${status}: ${note}`;
    }
    case 'token_rotation':
      // **`text` をそのまま出す。** ここで組み直すと、同じ事実を読む4つの面
      // （stderr・この画面・クローンの `journal_read`・CLI）で言い方が分かれる。
      // 文言の持ち主は `describeTokenRotation` 1つである。
      //
      // **見出しの `event` は落とさない** — 一覧の1行しか読まない人が、
      // `exhausted`（全層が止まる）と `not_rotated`（正常）を見分けられなくなる。
      return `[${entry.event}] ${entry.text}`;
    case 'subagent_stall': {
      // **`token_rotation` と違い、`text` をそのまま出さない。** `entry.text`
      // は `runner.ts` の `#onSubagentStop` が組み立てた `note.text` そのままで、
      // 残っている背景処理の一覧（`taskLines`）と「この行が出ないことは空転が
      // 無かったを意味しない」という断り書きを含む複数行である——`token_rotation`
      // の `text`（`describeTokenRotation` が作る本当の1行）とは密度が違う。
      // この関数の役目は「一覧と通知で同じ文言を使うための、潰した1行」なので、
      // 丸ごと連結すると一覧の1行がこの種別だけ極端に長くなる。ここでは
      // `entry.text` に既に書かれている事情を、必要な欄だけ拾って組み直す。
      //
      // **`outcome` の2値は潰さない** — `woken`（起こし直した。まだ委譲が進む
      // 見込みがある）と `limit_reached`（上限に達して起こし直さなかった。
      // 自動では再開しない＝人が要る）は性質が違う
      // （`schema.ts` の `subagent_stall.outcome` の doc と同じ理由）。
      const agentType = entry.agentType === undefined ? '' : `/${entry.agentType}`;
      const outcome =
        entry.outcome === 'woken'
          ? `起こし直した（${entry.wakeupCount}回目）`
          : `上限に達し、起こし直さなかった（要対応。既に${entry.wakeupCount}回起こし直し済み）`;
      return (
        `作業者 ${entry.agentId}${agentType} が自分で起こした背景処理を ` +
        `${entry.ownedTaskCount}件 残したまま畳もうとした（セッション全体 ${entry.sessionTaskCount}件）: ` +
        outcome
      );
    }
    case 'inbox_flow': {
      // **4つの総数を1行に並べる（Issue #783 段0）。** この種別の読み方は
      // 窓どうしを並べた推移で、1行に潰すときも**4つの軸を混ぜない**こと
      // ——`arrived`（受理）・`delivered`（待ち行列へ載った）・`settled`
      // （ストアから消えた）・`pending`（窓の終わりの1点）は別のものを
      // 数えており、食い違いそのものが読む材料である（`schema.ts` の
      // `inbox_flow` の doc）。種類別の内訳はここでは落とす —— 一覧の1行に
      // 収まらないので、詳細は日誌の本文側で読む。
      const oldest =
        entry.pending.oldestAt === undefined ? '' : `（最古 ${entry.pending.oldestAt}）`;
      return (
        `受信箱 到着${entry.arrived.total} / 配達${entry.delivered.total} / ` +
        `消し込み${entry.settled.total} / 滞留${entry.pending.count}${oldest}`
      );
    }
  }
}
