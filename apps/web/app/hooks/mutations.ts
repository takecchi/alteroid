/**
 * 書き込みの hooks。
 *
 * **原則、楽観更新はしない。** 書いた結果は日誌に出るので、SSE
 * （`use-journal-live.ts`）がすぐ無効化を回す。画面が先に「できたことにする」と、
 * 実際には拒否された操作が成功したように見える瞬間ができる。ここは正直さを優先する。
 *
 * **例外は自分のチャット送信（`useRecordOwnMessage`）だけ。** `POST /chat` には
 * 拒否という概念が無く、受け付ければ必ず `open` イベントで会話が返る。つまり
 * 「できたことにする」がそのまま「実際にできた」なので、成功に見せても嘘には
 * ならない。例外にした理由は速さ — 会話一覧はサーバが日誌を走査して組み立てる
 * ので、SSE の往復を待つと送信のたびに一覧の反映が目に見えて遅れる。
 */
import { useCallback } from 'react';
import { useSWRConfig } from 'swr';

import { ApiError, expectOk, unwrap, useApi } from '~/lib/api';
import type {
  AgentTokenView,
  ConversationSummary,
  EnvVarScope,
  InboxEventType,
  InboxRemoveManyResult,
  McpServers,
  McpServersUpdateResult,
  ProfileUpdateResult,
  TokenRotationSettings,
} from '~/lib/types';

import { isKeyOfType, KEY } from './queries';

/**
 * 自分のチャット送信を会話一覧へ即時反映する（唯一の楽観更新。理由は冒頭コメント）。
 *
 * API は叩かない — SWR キャッシュを直接書き換えるだけ。`revalidate: false` に
 * しているのは、この直後に必ず SSE 経由の無効化（`exchange(with:'human')`）が
 * 届いて正しい値に置き換わるので、ここで追加の往復を足す意味が無いから。
 *
 * 書き込む値は全部**暫定**である。`startedAt` / `updatedAt` はクライアントの
 * 時計（サーバの時計とはずれうる）、`messages` は+1の推測（サーバ側の数え方と
 * 一致する保証はない）、`preview` は下の `roughPreview` が作る仮の抜粋。どれも
 * SSE 由来の再取得が届いた瞬間に正しい値へ上書きされる。
 */
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
            };
            // `scanned`（日誌をどこまで遡ったか）はここでは動いていないので触らない。
            // 先頭へ足すだけで末尾は切らない。次の再取得で正しい件数に戻る。
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

/**
 * サーバの `preview()`（`apps/daemon/src/app.ts`）を写した。**二重管理である。**
 * サーバ側の切り方が変わったらここも手で追随しないと、反映された瞬間に抜粋の
 * 見た目が飛ぶ（見た目を飛ばさないためだけにここへ写している）。
 */
function roughPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

/** 記憶を書き換える（人間の直接編集）。 */
export function useSaveMemory() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, content: string) => {
      const result = await api.api
        .PUT('/memory/{slug}', { params: { path: { slug } }, body: { content } })
        .then(unwrap);
      await Promise.all([mutate(KEY.memory), mutate(KEY.memoryDoc(slug))]);
      return result.document;
    },
    [api, mutate],
  );
}

export function useDeleteMemory() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string) => {
      await api.api.DELETE('/memory/{slug}', { params: { path: { slug } } }).then(unwrap);
      await mutate(KEY.memory);
    },
    [api, mutate],
  );
}

/**
 * 仕事のやり方を書く（全文置換。無ければ作る、#1055 段3③）。
 *
 * `useSaveMemory` と違い `kind` / `title` も一緒に送る——`PracticeStore.write`
 * は `content` だけの部分更新を持たない（`practiceSchema` の doc）。
 */
export function useSavePractice() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string, kind: string, title: string, content: string) => {
      const result = await api.api
        .PUT('/practices/{slug}', { params: { path: { slug } }, body: { kind, title, content } })
        .then(unwrap);
      await Promise.all([mutate(KEY.practices), mutate(KEY.practice(slug))]);
      return result.practice;
    },
    [api, mutate],
  );
}

export function useDeletePractice() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (slug: string) => {
      await api.api.DELETE('/practices/{slug}', { params: { path: { slug } } }).then(unwrap);
      await mutate(KEY.practices);
    },
    [api, mutate],
  );
}

/** 承認待ちに答える。 */
export function useAnswerApproval() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, answer: string) => {
      await api.api
        .POST('/approvals/{id}/answer', { params: { path: { id } }, body: { answer } })
        .then(unwrap);
      await Promise.all([mutate(KEY.approvals(true)), mutate(KEY.approvals(false))]);
    },
    [api, mutate],
  );
}

/**
 * 溜まった承認待ちに、まとめて答える（`POST /approvals/answer`）。
 *
 * **1件が駄目でも残りは進む。** サーバは `answers` と同じ順で `results` を返す
 * ので、そのまま呼び出し側へ渡す — ここで成功件数へ畳むと、どの id が通らな
 * かったかが画面から見えなくなる。
 */
export function useAnswerApprovals() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (answers: { id: string; answer: string }[]) => {
      const { results } = await api.api
        .POST('/approvals/answer', { body: { answers } })
        .then(unwrap);
      await Promise.all([mutate(KEY.approvals(true)), mutate(KEY.approvals(false))]);
      return results;
    },
    [api, mutate],
  );
}

/**
 * 台帳の両方のキー（未了だけ／片付けたものも）を取り直す。
 *
 * **片方だけ回すと、切り替えた先が古いままになる。** 画面は表示の切り替えで
 * キーを変えるので、いま見ているほうしか回さないと「積んだのに出てこない」が起きる。
 */
function useRefreshCommitments() {
  const { mutate } = useSWRConfig();
  return useCallback(
    () => Promise.all([mutate(KEY.commitments(false)), mutate(KEY.commitments(true))]),
    [mutate],
  );
}

/**
 * 引き受けたことを台帳へ積む。
 *
 * **人間の手でも積めるようにしてある**（`/schedule` に仕込む口を置いたのと同じ理由）。
 * クローンに頼めばよい、で済ませると「人間は台帳を読めるが書けない」という不揃いが
 * 残る。CLI の `/commit` と同じ経路である。
 */
export function usePushCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (body: string) => {
      // 応答の中身は使わない（積んだ1件は下の取り直しで一覧ごと届く）。
      expectOk(await api.api.POST('/commitments', { body: { body } }));
      await refresh();
    },
    [api, refresh],
  );
}

/**
 * 片付いたことを記録する。
 *
 * **理由を必ず送る。** 器は「どう片付いたか」が残る前提で作ってあり
 * （`packages/core/src/schema.ts` の `closedReason`）、空だと「閉じた」という事実
 * だけが残って人間が後から否定できなくなる。空を弾くのは呼ぶ側（画面）の仕事。
 */
export function useCloseCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (id: string, reason: string) => {
      expectOk(
        await api.api.POST('/commitments/{id}/close', {
          params: { path: { id } },
          body: { reason },
        }),
      );
      await refresh();
    },
    [api, refresh],
  );
}

/**
 * 評定を付ける／覆す（`POST /commitments/:id/appraise`。#1054）。
 *
 * **片付いた行にも未了の行にも通る。** サーバが断るのは無い id だけである
 * （`CommitmentStore.appraise` の doc）。⟹ **ここで「片付いた行だけ」のような
 * 先回りの判定を書かないこと** — `useEditCommitment` と同じ理由で、サーバの線を
 * 画面へ写すと、線が変わった日に画面だけが黙ってずれる。
 *
 * **`reason` は任意。** 画面のボタン1つで付けられる経路を塞がないため
 * （そのぶん、なぜその評定なのかは書かれないことがある）。
 */
export function useAppraiseCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (
      id: string,
      appraisal: 'good' | 'bad' | 'unclear',
      reason?: string,
      // 仕事の種類（#1308）。人間の口では任意で、渡さなければ前の種類が残る。
      workKind?: string,
    ) => {
      expectOk(
        await api.api.POST('/commitments/{id}/appraise', {
          params: { path: { id } },
          body: {
            appraisal,
            ...(reason === undefined ? {} : { reason }),
            ...(workKind === undefined ? {} : { workKind }),
          },
        }),
      );
      await refresh();
    },
    [api, refresh],
  );
}

/**
 * 台帳の本文を後から直す（人間の直接編集、`PATCH /commitments/:id`）。
 *
 * **可否の判定はサーバに聞く。** ここで先回りして弾かない。画面
 * （`commitments.tsx` の `OpenRow`）は**未了の行すべてに編集の入口を出す**ので、
 * この hook は `origin` が `human` でない行からも叩かれる——そのとき返るのは
 * 403 で、本文がその行の `origin` を名指しして理由を言う。**呼び出し側は
 * 失敗を握り潰さず `ErrorNote` で見せること**（そこが「なぜ直せないか」が
 * 人間に届く唯一の場所である）。片付けられていれば 409 も同じ経路で返る。
 *
 * **⚠️ サーバの規則（誰が直せるか）をここへ写さないこと。** 写すと、
 * サーバ側の線が変わった日に画面だけが黙ってずれる。これは下の
 * `useRemoveSchedule` が持つ線と同じもので、issue #580 の (C) で台帳の編集も
 * そちらへ寄せた。
 */
export function useEditCommitment() {
  const api = useApi();
  const refresh = useRefreshCommitments();
  return useCallback(
    async (id: string, body: string) => {
      expectOk(
        await api.api.PATCH('/commitments/{id}', {
          params: { path: { id } },
          body: { body },
        }),
      );
      await refresh();
    },
    [api, refresh],
  );
}

/** マネージャーへ話しかける（許可確認への `allow` / `deny` もここ）。 */
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

/**
 * マネージャーを止める。
 *
 * **本文が要る**（`DELETE` だがサーバ側に json バリデータが付いている）。理由が
 * 無くても `{}` を送る必要があり、忘れると 400 になる。
 */
/**
 * 委譲に評定を付ける／覆す（`POST /managers/:id/appraise`。#1054）。
 *
 * **走行中の委譲にも終端した委譲にも通る。** サーバが断るのは台帳に居ない id だけ
 * である（`ManagerPool.appraise` の doc）。⟹ ここで「終端したものだけ」のような
 * 先回りの判定を書かないこと（`useEditCommitment` と同じ理由 —— サーバの線を画面へ
 * 写すと、線が変わった日に画面だけが黙ってずれる）。
 */
export function useAppraiseManager() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (
      id: string,
      appraisal: 'good' | 'bad' | 'unclear',
      reason?: string,
      // 仕事の種類（#1308）。`useAppraiseCommitment` と同じ扱い。
      workKind?: string,
    ) => {
      expectOk(
        await api.api.POST('/managers/{id}/appraise', {
          params: { path: { id } },
          body: {
            appraisal,
            ...(reason === undefined ? {} : { reason }),
            ...(workKind === undefined ? {} : { workKind }),
          },
        }),
      );
      // **一覧と詳細の両方を取り直す。** 評定は両方に出る（`ManagerSummary` が運ぶ）。
      await Promise.all([mutate((key) => isKeyOfType(key, 'managers')), mutate(KEY.manager(id))]);
    },
    [api, mutate],
  );
}

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

/** 定期ジョブを今すぐ回す（待たずに確かめるための口）。 */
export function useRunSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (kind: string) => {
      // `body: {}` は spec が本文を必須にしているから（運ぶ情報は無い）。これがあると
      // openapi-fetch が `content-type: application/json` を自分で付けるので、
      // デーモンの門番（`deliberateClient`）を素通りできる。
      await api.api
        .POST('/schedule/{kind}/run', { params: { path: { kind } }, body: {} })
        .then(unwrap);
      await mutate(KEY.schedule);
    },
    [api, mutate],
  );
}

/**
 * 継続する依頼を仕込む（起点②を人間の手から置く）。
 *
 * **「今すぐ回す」と同じ画面に置くが、別の操作である。** あちらは既定で回っている
 * ものを待たずに確かめる口で、こちらは**依頼そのものを増やす**。CLI（`/schedule
 * <kind> <周期> <依頼>`）とクローンの道具（`schedule_create`）にはあって、画面にだけ
 * 無かった — 自分が出した「これからずっと」の依頼を人間が置けないと、PRD
 * 「インターフェース」が言う3面の等価性が崩れる。
 *
 * **周期の形は API の型そのままを受ける。** 画面で `daily` / `every` / `cron` を
 * 組み直すと、値が増えたときにここだけ古くなる。
 */
export function useCreateSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (body: {
      kind: string;
      request: string;
      spec:
        | { type: 'daily'; at: string }
        | { type: 'every'; minutes: number }
        | { type: 'cron'; expression: string };
    }) => {
      const created = await api.api.POST('/schedule', { body }).then(unwrap);
      await mutate(KEY.schedule);
      return created;
    },
    [api, mutate],
  );
}

/**
 * 継続中の依頼を外す。
 *
 * **既定の定期ジョブ（`RESERVED_SCHEDULE_KINDS`。packages/core/src/schedule.ts）は
 * 外せない**（デーモンが同じ名前で守っている）。画面側でボタンを隠して表現しないこと
 * — 隠すと「なぜ押せないか」が消える。押せて、断られた理由がその場に出るほうが読める。
 * ここに名前を書き写さないこと — 数え上げを持つのは `RESERVED_SCHEDULE_KINDS` だけ
 * である（#701 / #756 と同じ理由。増えても直すのはあちらだけでよい）。
 */
export function useRemoveSchedule() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (kind: string) => {
      // `body: {}` は `useRunSchedule` と同じ理由。**中身は読まれない** —
      // 本文が必須なのは、門番（`deliberateClient`）が `content-type:
      // application/json` を要求することを spec の機械可読部で表す手段が
      // これしか無いからである（`DELETE /schedule/{kind}` の requestBody に
      // その旨が書いてある）。
      await api.api
        .DELETE('/schedule/{kind}', { params: { path: { kind } }, body: {} })
        .then(unwrap);
      await mutate(KEY.schedule);
    },
    [api, mutate],
  );
}

/** 外部イベントを流し込む（起点③を手で起こす）。 */
export function usePostEvent() {
  const api = useApi();
  return useCallback(
    async (source: string, payload: unknown) => {
      return api.api.POST('/events', { body: { source, payload } }).then(unwrap);
    },
    [api],
  );
}

/**
 * `POST /reset` が返す、消した件数の内訳。**何を残し何を消すかは
 * `@alteroid/core` の `resetWorkspaceState` が正本**（サーバ側の doc）——
 * ここは応答の形を写すだけで、範囲を選ぶ口は持たない。
 */
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
  /** pg 構成でだけ付く。 */
  sessionLog?: number;
}

/**
 * ワークスペースをリセットする（「トークン情報以外を全部消す」）。
 *
 * **呼ぶ前に確認するのは呼び出し側（`settings.tsx` のダイアログ）の仕事**で
 * あり、この hook 自体は確認を持たない——`POST /reset` はサーバ側で
 * `confirm: true` を必須にしているので、確認を経ない直接の呼び出しはどこから
 * 来ても 400 で止まる（二重の安全網の片方をここが担う）。
 *
 * **呼んだ後は全キャッシュを引き直す。** `ApiProvider` が接続先を切り替えた
 * ときと同じ形（`api.tsx` の `previousBaseUrl` の effect）——記憶・日誌・
 * ジョブ・スケジュール等すべてが変わるので、種類を選んで落とす形は選び漏れが
 * そのまま「消えたのに画面には残る」になる。
 */
export function useResetWorkspace() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(async (): Promise<WorkspaceResetSummary> => {
    const result = await api.api.POST('/reset', { body: { confirm: true } }).then(unwrap);
    await mutate(() => true);
    return result.cleared;
  }, [api, mutate]);
}

/**
 * デーモンを止める（`POST /shutdown`。CLI の `alteroid daemon stop` と同じ
 * 受け口。issue #1124 の (A)）。
 *
 * **確認は呼び出し側（`settings.tsx` の `ShutdownDaemon`）の仕事。** `POST
 * /reset` と違い、この口自体はサーバ側で確認の印（`confirm: true` 相当）を
 * 必須にしていない（`apps/daemon/src/app.ts` の `/shutdown` の doc）——
 * 確認を経ない直接呼び出しを止める二重の網は無く、呼ぶ前の確認だけが
 * 唯一の網である。
 *
 * **資格は `authenticate` だけ**（`requireOperator` は要求しない。issue
 * #1124 の (B) がその強さを「意図」として確定させている）ので、`useSetEnvVar`
 * `useDeclareOwner` と違って「宣言済みでなければ 403」という前置きは無い。
 *
 * **呼んだ後にキャッシュは引き直さない。** デーモンが止まるので、この画面
 * 自身の接続もすぐ切れる——`useResetWorkspace` の `mutate(() => true)` に
 * 相当する引き直しをしても、応答する相手がいなくなる。
 */
export function useShutdownDaemon() {
  const api = useApi();
  return useCallback(async () => {
    await api.api.POST('/shutdown', { body: {} }).then(unwrap);
  }, [api]);
}

/**
 * 実行環境の持ち主として宣言する／取り消す（`POST /access/:id/owner`
 * `.../owner/revoke`。issue #1198）。
 *
 * **`requireOperator`。** ブラウザは構造的に operator になれない
 * （`apps/daemon/src/app.ts` の `requireOwner` の doc の「なぜ `requireOperator`
 * と分けるのか」）ので、**Web UI から呼ぶと常に 403 になる。** それでもボタンを
 * 出す理由は `routes/access.tsx` の doc にある（`env-vars.tsx` `settings.tsx` と
 * 同じ「ボタンは隠さない」方針——押せない理由を消さず、端末で打つコマンドを
 * 案内する）。
 *
 * `body: {}` の理由は `useRunSchedule` と同じ（spec が本文を必須にしている。
 * デーモンの門番 `deliberateClient` が `content-type: application/json` を要求する）。
 */
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

/** 実行環境の持ち主としての宣言を取り消す（`useDeclareOwner` と対）。 */
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

/**
 * 環境変数を1つ置く（`PUT /credentials`）。
 *
 * **`scope`・`secret` は新規行にのみ渡す意味を持つ**（既存行を更新するときに
 * 省略すると前回の値を引き継ぐ。`secret` を既存行と違う値で渡すとサーバが
 * 400 で拒否する——`apps/cli/src/credential.ts` と同じ資格・同じ制約）。
 *
 * **`requireOwner`。** 宣言済み owner（実行環境の持ち主そのもの、または
 * `ownerDeclaredAt` が入った許可済みアカウント。issue #1198）でなければ 403 が
 * 返る——呼び出し側（`env-vars.tsx`）はボタンを隠さず、失敗を `ErrorNote` で
 * 見せること（`settings.tsx` の `ResetWorkspace` と同じ「隠さない」方針）。
 */
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

/**
 * `PUT /profile` が 400 で返した「読めなかったので保存していない」。
 *
 * **`detail` を落とさないために別の型にしてある。** 共有の `unwrap` は本文の
 * `error` だけを文言にする（`lib/api.tsx` の `describeError`）が、プロファイルの
 * 400 で直すのに要るのは `detail` のほう——シェルの構文エラーは行番号込みで
 * しか直せない（`apps/daemon/src/openapi.ts` の `profileErrorResponseSchema` の doc）。
 * CLI も `error` と `detail` を2行で出している（`apps/cli/src/profile.ts` の `request`）。
 *
 * `ApiError` を継承するので、`status` で分岐している既存の読み手はそのまま動く。
 */
export class ProfileRejectedError extends ApiError {
  readonly detail: string;

  constructor(error: string, detail: string) {
    super(400, error);
    this.name = 'ProfileRejectedError';
    this.detail = detail;
  }
}

/**
 * 実行環境プロファイルを丸ごと差し替える（`PUT /profile`。issue #1122）。
 * **空文字は「外す」**（`alteroid profile clear` と同じ。`profileUpdateRequestSchema`
 * の doc）。
 *
 * **確認は呼び出し側（`routes/profile.tsx`）の仕事。** 送った本文はデーモンの
 * `process.env` を土台にその場で評価される＝記憶ストアの鍵を持つプロセスでの
 * 任意コマンド実行である（`.claude/skills/env-profile/SKILL.md`）。サーバ側に
 * 確認の印は無いので、呼ぶ前の確認だけが網になる（`useShutdownDaemon` と同じ事情）。
 *
 * **`requireOperator`。** ブラウザは構造的に operator になれない（`useDeclareOwner`
 * の doc と同じ）ので、認証を有効にした構成では常に 403 になる。ボタンは隠さない。
 */
export function useSetProfile() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (script: string): Promise<ProfileUpdateResult> => {
      const result = await api.api.PUT('/profile', { body: { script } });
      if (result.response.status === 400) {
        const body = result.error as { error?: unknown; detail?: unknown } | undefined;
        if (typeof body?.error === 'string') {
          throw new ProfileRejectedError(
            body.error,
            typeof body.detail === 'string' ? body.detail : '',
          );
        }
      }
      const updated = unwrap(result);
      await mutate(KEY.profile);
      return updated;
    },
    [api, mutate],
  );
}

/** 環境変数を1つ外す（空値の `PUT /credentials` = 「外す」）。 */
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

/**
 * 認証トークンのプールへ1本足す（`PUT /tokens`）。
 *
 * **`GET /tokens` → 加工 → `PUT /tokens`（全置換）の形。** `apps/cli/src/token.ts`
 * の `tokenAddCommand` と同じパターン——キャッシュではなく都度取り直す
 * （ブラウザのタブが複数開いていても、直前の実際の状態を土台にするため）。
 */
export function useAddToken() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (label: string, value: string) => {
      const current = await api.api.GET('/tokens').then(unwrap);
      const inputs = current.tokens.map(toTokenInput);
      const result = await api.api
        .PUT('/tokens', { body: { tokens: [...inputs, { label, value }] } })
        .then(unwrap);
      await mutate(KEY.tokens);
      return result;
    },
    [api, mutate],
  );
}

/** プールから1本外す。 */
export function useRemoveToken() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string) => {
      const current = await api.api.GET('/tokens').then(unwrap);
      const inputs = current.tokens.filter((token) => token.id !== id).map(toTokenInput);
      const result = await api.api.PUT('/tokens', { body: { tokens: inputs } }).then(unwrap);
      await mutate(KEY.tokens);
      return result;
    },
    [api, mutate],
  );
}

/** 無効化・有効化を切り替える（人間の判断。`disable` は戻らない側の合図として残る）。 */
export function useSetTokenDisabled() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (id: string, disabled: boolean) => {
      const current = await api.api.GET('/tokens').then(unwrap);
      const inputs = current.tokens.map((token) =>
        token.id === id ? { ...toTokenInput(token), disabled } : toTokenInput(token),
      );
      const result = await api.api.PUT('/tokens', { body: { tokens: inputs } }).then(unwrap);
      await mutate(KEY.tokens);
      return result;
    },
    [api, mutate],
  );
}

/** 外向けの顔（値を持たない）を、次の `PUT /tokens` の入力へ変換する。 */
function toTokenInput(token: AgentTokenView): { id: string; label: string; order: number } {
  return { id: token.id, label: token.label, order: token.order };
}

/**
 * 回す契機・冷却の既定を変える（`PUT /tokens/policy`。Issue #1123）。
 *
 * **`alteroid token policy` / `PUT /tokens/policy` と同じ口・同じ資格**
 * （`authenticate` だけ。`apps/daemon/src/app.ts` の `.put('/tokens/policy', …)`
 * の doc）——CLI にできて画面にできないことを作らない、という PRD
 * 「ある入口でできることが別の入口でできない状態を作らない」のための hook。
 *
 * **部分更新をそのまま通す。** 省略した項目はサーバ側で現状維持になる
 * （`tokensPolicyUpdateRequestSchema` の doc）——ここで欠けた項目を補って
 * 埋めない。
 *
 * **⚠️ サーバの規則（値の妥当性）をここへ写さないこと。** `useEditCommitment` /
 * `useAppraiseManager` と同じ理由——「正の整数か」のような判定を画面側で
 * 先回りして弾くと、サーバ側の規則が変わった日に画面だけが黙ってずれる。
 * 呼び出し側はそのまま送り、断られたらサーバの文言をそのまま見せること。
 */
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

/** 会話を終える。クローンがここで学びを蒸留する。 */
export function useEndConversation() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (conversationId: string) => {
      // `body: {}` の理由は `useRunSchedule` と同じ（spec が本文を必須にしている）。
      await api.api
        .POST('/chat/{conversationId}/end', { params: { path: { conversationId } }, body: {} })
        .then(unwrap);
      await mutate(KEY.memory);
    },
    [api, mutate],
  );
}

/**
 * いま走っているクローンのターンを止める（`POST /clone/interrupt`。#1398 c23-1/c30-2）。
 *
 * CLI の `alteroid interrupt`（`apps/cli/src/interrupt.ts`）と同じ口・同じ資格
 * （`deliberateClient`——`/chat/:conversationId/end` と同じ）。**資格の判定は
 * ここでは行わない** —— HTTP の口の認可（`apps/daemon/src/app.ts` の
 * `/clone/interrupt`）にそのまま従う。`useDeclareOwner` 等と同じ「サーバの線を
 * 画面へ写さない」方針。
 *
 * 応答は3値（`interrupted` / `idle` / `unsupported`）——「止めるものが無かった」を
 * 「止めた」と言わないのは CLI 側と同じ理由（`interrupt.ts` の doc）。文言は
 * `routes/chat.tsx` の `describeCloneInterruptOutcome` が持つ。
 *
 * **キャッシュは引き直さない。** セッションと受信箱はそのまま残るので
 * （サーバ側の doc）、この呼び出し自体は画面のどの一覧の中身も変えない——
 * 止めたことは日誌に残り、日誌の SSE（`use-journal-live.ts`）が別途拾う。
 */
export function useInterruptClone() {
  const api = useApi();
  return useCallback(async () => {
    const result = await api.api.POST('/clone/interrupt', { body: {} }).then(unwrap);
    return result.outcome;
  }, [api]);
}

/**
 * アーカイブ済み生ログの本文を1件消す（`DELETE /archive/:id`。tombstone——
 * 行そのものは残る。CLI の `/archive remove` / クローンの道具 `archive_remove`
 * と同じ口。#698 / #776）。
 *
 * **409 をここで握り潰さない。** 走行中のマネージャーの退避は既定で拒まれる
 * ——`overrideReason` を渡さずに呼んで 409 が返ったら、`unwrap` がそのまま
 * `ApiError`（`status === 409`、`message` はサーバの断り文言）を投げる。
 * 呼び出し側（`routes/archive.tsx`）はそれを捕まえて理由の入力欄を出し、
 * 理由付きでこの関数をもう一度呼ぶ——黙って失敗させないための形は画面側が持つ。
 */
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
      await Promise.all([mutate(KEY.archive), mutate(KEY.archiveSessions)]);
      return result;
    },
    [api, mutate],
  );
}

/** `useInboxRemoveMany` に渡す絞り込み（`POST /inbox/remove` の入力そのもの）。 */
export interface InboxRemoveManyInput {
  types: readonly InboxEventType[];
  sources?: readonly string[];
  before?: string;
  reason: string;
  limit?: number;
  dryRun: boolean;
}

/**
 * 受信箱（`inbox_events`）の未読を、絞り込んでまとめて畳む（消す）。
 * `POST /inbox/remove`——CLI の `alteroid inbox remove`（`apps/cli/src/inbox.ts`）
 * と同じ口（issue #972）。
 *
 * **`dryRun` は呼び出し側が決める。** ここでは既定を持たない——「既定は試算」は
 * 呼び出し側（`routes/inbox.tsx`）が「試算する」ボタンで `dryRun: true` を、
 * 明示の「実行する」ボタンでだけ `dryRun: false` を渡す形で守る。CLI の
 * `inboxRemoveCommand`（`--execute` が無ければ `dryRun: true`）と同じ役割分担。
 *
 * **400 の文言をそのまま投げる。** `types` に在る7種類を全部並べた呼び・
 * `before` が ISO8601 として読めない・`limit` が上限超え、のどれも
 * ここでは判定しない——`unwrap` がサーバの `{error}` をそのまま
 * `ApiError.message` に載せて投げるので、呼び出し側は `ErrorNote` に渡すだけで
 * サーバの断り文言がそのまま出る（`apps/cli/src/inbox.ts` の `post()` の
 * コメントと同じ理由——判定を複製すると、サーバ側の文言や条件が変わったとき
 * ここだけ古いまま残る）。
 *
 * **`GET /inbox`（issue #783 段0）が入ったので、実行（`dryRun: false`）の
 * 後だけ `KEY.inbox` を引き直す。** ⚠️ **かつてここには「`GET /inbox` のような
 * 一覧は無く……引き直す必要はない」と書いてあったが、#783 段0でその前提が
 * 消えた——いまは在る。** 試算（`dryRun: true`）は何も変更しないので引き直さ
 * ない（`routes/inbox.tsx` の `InboxBacklogCard` が「絞り込みを変えたら前の
 * 試算結果を無効にする」のと同じく、無駄な GET を送らない側へ倒す）。消した
 * id は日誌にも残るが、日誌は SSE（`use-journal-live.ts`）が別途拾うので、
 * ここから明示的に `mutate(KEY.journal)` する必要はない。
 */
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
      // **試算は何も変更しない——引き直すのは実行できたときだけ。**
      if (!input.dryRun) await mutate(KEY.inbox);
      return result;
    },
    [api, mutate],
  );
}

/**
 * 許可を与える／取り消す（`POST /access/:id/grant` `.../revoke`。Issue #213）。
 *
 * **資格は `authenticate` だけ**（2026-09-06 の同格化。`apps/daemon/src/app.ts` の
 * 該当経路の doc）なので、許可を持つアカウントなら Web UI からも通る。サーバの規則
 * （誰が許可できるか・持ち主の排他）はここへ写さない —— 返ってきた失敗をそのまま
 * 見せる（`useDeclareOwner` と同じ方針）。
 *
 * `body: {}` の理由は `useDeclareOwner` と同じ。
 */
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

/** 許可を取り消す（`useGrantAccess` と対）。**押す前の確認は画面の側が持つ**（`routes/access.tsx`）。 */
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

/**
 * その runner を意図して空ける（drain。`POST /runners/vacate`）。**応答は「立てた」の
 * 確認であって「空き終わった」ではない**ので、呼び出し側はそう言わないこと。
 * 押す前の確認は画面の側が持つ（`routes/settings.tsx` の `VacateRunner`）。
 */
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

/**
 * 人間の MCP 連携の登録を丸ごと差し替える（`PUT /mcp-servers`。#325 段4）。
 * **空の `{}` は「外す」**（`alteroid mcp clear` と同じ）。
 *
 * **形の検査はデーモンに任せる**（`parseMcpServers` が正本）。400 の本文は
 * `{ error }` だけで、不正な欄の位置が `error` の中に入っている（送った値は
 * 載らない）ので、共有の `unwrap` がそのまま文言にすればよい —— `/profile` の
 * `ProfileRejectedError` のような別の型は要らない。
 *
 * **確認は呼び出し側（`routes/mcp-servers.tsx`）の仕事。** stdio の登録は、次の
 * セッションでクローンの SDK が起こすコマンドである（`apps/daemon/src/app.ts` の
 * `GET /mcp-servers` の doc）。サーバ側に確認の印は無いので、呼ぶ前の確認だけが網になる。
 */
export function useSetMcpServers() {
  const api = useApi();
  const { mutate } = useSWRConfig();
  return useCallback(
    async (mcpServers: McpServers): Promise<McpServersUpdateResult> => {
      const updated = await api.api.PUT('/mcp-servers', { body: { mcpServers } }).then(unwrap);
      await mutate(KEY.mcpServers);
      return updated;
    },
    [api, mutate],
  );
}
