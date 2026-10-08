import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, SetStateAction } from 'react';
import { Link, useNavigate } from 'react-router';

import {
  ChatComposer,
  ChatHeader,
  ChatMessage,
  ChatMessageEditor,
  ChatMessageList,
  ChatTurnFailure,
  ConversationList as UiConversationList,
  Drawer,
  Button,
  Card,
  Empty,
  ErrorNote,
  Spinner,
  TurnFailureNote,
  type TurnFailureKind,
  useIsMobile,
  EMPTY_QUESTIONS_DRAFT,
} from '@alteroid/ui';
import {
  useEndConversation,
  useInterruptClone,
  useRecordOwnMessage,
  useConversation,
  useConversationApprovals,
  useConversations,
  useMarkConversationRead,
  findConversationByClientMessageId,
  getChatStream,
  postChat,
  uploadAttachment,
  ApiError,
  useApi,
  useAttachmentLimits,
  type ChatStreamEvent,
  type ChatStreamPending,
} from '@alteroid/swr';
import {
  attachmentMediaType,
  checkAttachments,
  formatBytes,
  formatDateTime,
  isPreviewableImage,
  chatDraftEpoch,
  describeApprovalLeftover,
  isEmptyQuestionsDraft,
  loadApprovalDrafts,
  loadApprovalLeftoverSources,
  loadChatDraft,
  loadChatDraftMark,
  loadEditDrafts,
  loadPendingAttachmentsNote,
  newClientMessageId,
  saveApprovalDrafts,
  saveApprovalLeftoverSources,
  saveChatDraft,
  saveChatDraftMark,
  settleApprovalDraft,
  saveEditDraft,
  savePendingAttachmentsNote,
  redactError,
} from '@alteroid/logic';
import type {
  ApprovalDrafts,
  ApprovalLeftoverSources,
  ChatDraftMark,
  ConversationMessage,
  MessageAttachment,
  PendingApproval,
  PendingAttachmentsNote,
} from '@alteroid/logic';

import {
  ApprovalAnswerCard,
  approvalDetailPath,
  isApprovalAnswered,
  isApprovalWithdrawn,
} from '~/components/approval-answer-card';
import { LeftoverDrafts } from '~/components/approval-leftover-drafts';
import { UnreadableApprovalNote } from '~/components/unreadable-approval-note';
import { LeaveGuardScope, useReportDirty, type LeaveNotice } from '~/lib/leave-guard';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';
import { usePageVisible } from '~/lib/use-page-visible';

import type { Route } from './+types/chat';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { conversationId: params.conversationId };
}

/**
 * 「最下部にいるか」の余裕（px）。**厳密一致（`scrollTop + clientHeight ===
 * scrollHeight`）は小数の丸めで成立しないことがある**ので余裕を持たせる。
 *
 * 32px にしたのは、この画面の行間・パディング（やりとりの `gap-3` = 12px、
 * 吹き出しの `py-2` など）を見て、1行ぶん未満の隙間であればブラウザの丸め・
 * サブピクセルのずれを吸収するのに足り、かつ「実質的にもう1行分スクロール
 * しないと最下部が見えない」ほど手前では反応しない値だと判断したため
 * （深い理由がある値ではない。広すぎると「読み返している」を誤って
 * 「最下部にいる」と判定し、狭すぎると丸め誤差で最下部にいるのに追従
 * しない、の両方に転びうる）。
 */
let replyGroupSeq = 0;
const BOTTOM_THRESHOLD_PX = 32;
/** 返信行を1つも持たない集合（state の初期値。同じ参照を使い回して余計な再描画を避ける）。 */
const NO_REPLY_KEYS: ReadonlySet<string> = new Set();

/**
 * ストリームの `error` イベント（ターンが失敗した）由来の失敗。入力欄の上の帯が、ネットワーク断・
 * 403 のような「呼べなかった」失敗（ただの `Error`）と見分けて、利用者向けの文で描くための型。
 */
class TurnFailedError extends Error {
  constructor(
    message: string,
    readonly failureKind: TurnFailureKind,
  ) {
    super(message);
  }
}

/** 失敗の案内の導線。受信中の帯と読み直した失敗の行で同じものを出す。 */
const turnFailureAction = (kind: TurnFailureKind) =>
  kind === 'auth' ? (
    <Link to="/tokens" className="text-xs underline underline-offset-2">
      認証トークンの画面を開く
    </Link>
  ) : undefined;

/**
 * `done` / `error` / `usage_limited` のどれも来ないまま、接続が正常に閉じた（プロキシ・再起動など、#3564）。
 * 途中までの返信は完成したものではない。文言は CLI・TUI（#3410）にそろえる。
 */
class StreamClosedEarlyError extends Error {
  constructor() {
    super(
      '応答が途中で切れた（done も error も来ないまま接続が閉じた）。出ているのは受け取った分だけ',
    );
  }
}

/** 追送が次のターンに回ったとき、再生を張り直す回数の上限（#4085）。 */
const REPLAY_MAX_ROUNDS = 40;
/** 進行中のターンが無いまま追送が待っているとき、待って張り直す回数の上限（間隔は 0.5 秒から倍々、5 秒まで）。 */
const REPLAY_MAX_WAITS = 10;

/**
 * `open` のあとに、接続が（終端なしで閉じる以外の形で）切れた。サーバは発言を受け取り済みで、ターンは続く。
 * 「接続先につながっていない・もう一度試して」と読ませると、送り直して二重に送らせる。
 */
class ReplyCutOffError extends Error {
  constructor() {
    super(
      '応答の受信が途切れた。発言は受け取り済みなので、送り直さなくてよい。返信は会話に載り次第ここへ出る',
    );
  }
}

/** ストリームの終端（これらのどれかを見たら、閉じてよい）。 */
function isStreamTerminal(event: ChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'error' || event.type === 'usage_limited';
}

/**
 * 添付を見せる部品。**添付のある発言が画面に出たときだけ読み込む**（別チャンク。
 * バンドル予算のため、最初の読み込みへ入れない）。
 */
const MessageAttachments = lazy(() => import('~/components/message-attachments'));

/**
 * 入力欄に添えた、まだ送っていない添付。`meta` は上げた後に入る（上げるのは送るとき。
 * 上げ終えたものは、後の失敗で送り直しても二重に上げない）。
 */
interface PendingAttachment {
  key: string;
  /** 選んだファイル。**無いものは、すでにサーバにある添付**（発言の編集で引き継いだもの。`meta` を持つ）。 */
  file?: File;
  meta?: MessageAttachment;
}

/** 書きかけの本文を `sessionStorage` へ書くまでの、打鍵が止まってからの待ち（ミリ秒。#3400）。 */
const DRAFT_SAVE_DELAY_MS = 400;

/** 検査（個数・大きさ）に渡す形。引き継いだ添付は控え（`meta`）から作る。 */
function sizedOf(item: PendingAttachment): { name: string; size: number; type: string } {
  return {
    name: item.file?.name ?? item.meta?.name ?? '',
    size: item.file?.size ?? item.meta?.size ?? 0,
    type: item.file?.type ?? item.meta?.mediaType ?? '',
  };
}

/**
 * 編集の続き（`supersedes`）では、すでにサーバにある添付（`meta`）は id で戻せるので控えに残し、戻せない
 * （実体を失う）ぶんだけを件数と名前にする（#4069）。編集でない送信は、これまでどおり全部を件数と名前にする。
 */
const attachmentMarkOf = (entry: {
  attachments?: PendingAttachment[];
  lostAttachments?: { count: number; names: string[] };
  supersedes?: string;
}): Pick<ChatDraftMark, 'attachmentCount' | 'attachmentNames' | 'attachments'> => {
  const items = entry.attachments ?? [];
  const isEdit = entry.supersedes !== undefined;
  const gone = isEdit ? items.filter((item) => item.meta === undefined) : items;
  const restorable = isEdit
    ? items.flatMap((item) => (item.meta === undefined ? [] : [item.meta]))
    : [];
  const kept = restorable.length > 0 ? { attachments: restorable } : {};
  if (gone.length > 0) {
    return {
      ...kept,
      attachmentCount: gone.length,
      attachmentNames: gone.map((item) => sizedOf(item).name),
    };
  }
  return entry.lostAttachments === undefined
    ? kept
    : {
        ...kept,
        attachmentCount: entry.lostAttachments.count,
        attachmentNames: entry.lostAttachments.names,
      };
};

/** 上げ終えた添付の id（`POST /chat` の `attachments`）。 */
function attachmentIds(items: readonly PendingAttachment[]): string[] {
  return items.flatMap((item) => (item.meta === undefined ? [] : [item.meta.id]));
}

/**
 * すでに上げてある添付（発言に付いている控え）を、送る形へ直す。`meta` を持つので上げ直さない。
 * 編集の添付の引き継ぎ（#3399）と、失敗したターンの再送（#3566）が使う。
 */
function carriedAttachments(items: readonly MessageAttachment[]): PendingAttachment[] {
  return items.map((meta) => ({ key: `e-${meta.id}`, meta }));
}

/**
 * 入力欄から、送った分（`sent`）を取り除く（#3248）。**送った分だけを消し、送った後に
 * 打ち足した分は残す。**
 *
 * - 今の本文が送った本文で始まる → その頭を取り除き、残りを返す（のまま同じなら `''`）
 * - それ以外（前や途中を直した）→ **全部残す**。どこまでが送った分か決められず、
 *   推測して削ると使い手の編集を失わせる。残して二重に送りうる側のほうが、
 *   使い手に見えていて直せる（黙って失うほうは取り返せない）
 */
function withoutSentText(current: string, sent: string): string {
  return current.startsWith(sent) ? current.slice(sent.length) : current;
}

/**
 * 送るとき、入力欄の本文をどうするか。
 *
 * - `clear` — 入力欄の文を送ったので空にする
 * - `clearSent` — 送った分だけ取り除き、待つあいだに打ち足した分は残す（再送・添付を上げて待った送信。#3248）
 * - `keep` — 入力欄の文は送っていない（編集の確定・失敗した返信の「もう一度送る」）ので触らない。
 *   触ると、別の発言を書きかけていた入力欄が黙って空になる（#3391）
 */
type DraftHandling = 'clear' | 'clearSent' | 'keep';

/** 送信失敗の応答が、添付の期限切れ・欠落（400 `attachment_missing`）か。 */
function isAttachmentMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.code === 'attachment_missing';
}

/**
 * 同じ `clientMessageId` で中身が違うと断られた（409 `client_message_id_mismatch`。#3243）か。
 * その id はもう使えない——次の再送は新しい id で送る。
 */
function isClientMessageIdMismatch(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 409 && error.code === 'client_message_id_mismatch'
  );
}

/**
 * 期限切れ（400 `attachment_missing`）になった添付の控え（`meta`）を外す（#3778。CLI の `expireUploads`、#3246 と同じ形）。
 * 外すのは**手元のファイルを持つ項目だけ**——次の送信で上げ直す。`file` の無い項目（編集で引き継いだ添付）は
 * 上げ直せないので触らない。サーバの文に id が載った項目だけを外し、どれも載っていなければ手元のファイルの分を全部外す。
 * 引き継いだ添付の id が載っていたら何も外さない（外して付け直す案内を出す）。
 */
function expireUploads(items: PendingAttachment[], message: string): PendingAttachment[] {
  const named = (item: PendingAttachment) =>
    item.meta !== undefined && message.includes(item.meta.id);
  if (items.some((item) => item.file === undefined && named(item))) return items;
  const reuploadable = items.filter((item) => item.file !== undefined && item.meta !== undefined);
  const expired = new Set(
    (reuploadable.some(named) ? reuploadable.filter(named) : reuploadable).map((item) => item.key),
  );
  return items.map((item) => (expired.has(item.key) ? { key: item.key, file: item.file } : item));
}

/**
 * サーバの文に id が載った、引き継いだ添付の名前（#4070）。サーバは id しか返さず、入力欄のチップは名前で出るため、
 * 名前に引き直さないと、どれを外せばよいか分からない。載っていなければ空（全部の名前を並べると、切れていないものまで疑わせる）。
 */
function expiredCarriedNames(items: readonly PendingAttachment[], message: string): string[] {
  return items.flatMap((item) =>
    item.file === undefined && item.meta !== undefined && message.includes(item.meta.id)
      ? [item.meta.name]
      : [],
  );
}

/**
 * `open` の前の失敗の後、積む添付と `clientMessageId` を決める。409 `client_message_id_mismatch`（#3243）と、
 * 期限切れの添付を外したとき（#3778。付ける id が変わる）は、その id を捨てて新しく作る。
 */
function afterFailure(
  caught: unknown,
  attachments: PendingAttachment[],
  clientMessageId: string,
): { attachments: PendingAttachment[]; clientMessageId: string } {
  const expired = isAttachmentMissing(caught)
    ? expireUploads(attachments, (caught as ApiError).message)
    : attachments;
  return {
    attachments: expired,
    clientMessageId:
      isClientMessageIdMismatch(caught) || expired.some((item, i) => item !== attachments[i])
        ? newClientMessageId()
        : clientMessageId,
  };
}

/** 積んでおいた送信（`retries` の1件）と、入力欄の今の中身が同じか（本文と添付の並び）。 */
function sameAsStashed(
  stashed: { text: string; attachments?: PendingAttachment[] },
  text: string,
  attachments: readonly PendingAttachment[],
): boolean {
  const before = stashed.attachments ?? [];
  return (
    stashed.text === text &&
    before.length === attachments.length &&
    before.every((item, index) => item.key === attachments[index]?.key)
  );
}

/** 発言の編集の書きかけ（#3565）。 */
interface EditDraft {
  text: string;
  /** 引き継ぐ添付（上げ済みの控え）。 */
  attachments: MessageAttachment[];
  /** 編集で足したファイル（`file` を持つ。確定のとき上げる。`File` は保存できない。#3779）。 */
  added: PendingAttachment[];
  /** 再読み込みで実体を失った、足していたファイルの名前。開いたとき案内し、閉じたら消す。 */
  lost: string[];
}

/** 書きかけが元の発言と違うか。元のまま（開いただけ）なら「書きかけ」とは言わない。 */
function hasEditDraft(draft: EditDraft | undefined, line: Line): boolean {
  if (draft === undefined) return false;
  if (draft.text !== line.text || draft.added.length > 0 || draft.lost.length > 0) return true;
  const original = line.attachments ?? [];
  return (
    draft.attachments.length !== original.length ||
    draft.attachments.some((item, index) => item.id !== original[index]?.id)
  );
}

/** 画面に出す1行。届いた順に並べる。 */
interface Line {
  key: string;
  role: 'human' | 'clone' | 'system';
  text: string;
  /** 進行中の合図（考え中・ツール実行中）。落ち着いたら消す。 */
  transient?: boolean;
  /**
   * **この行がどの会話のものか**（会話 id。まだ id が決まっていなければ `undefined`）。
   *
   * **画面に出すかどうかは、これといま見ている会話の一致だけで決まる**（下の
   * `ownedBy`）。**省略できない形にしてあるのは、行を作る場所を型に数えさせる
   * ためである** —— 足し忘れた行は「持ち主なし」として黙って混ざるのではなく、
   * ビルドで落ちる。
   *
   * **⚠️ 画面の中だけのものである。** サーバの応答にも、保存される形にも、
   * API の契約（`apps/daemon/openapi.json`）にも出ない。
   */
  of: string | undefined;
  /**
   * この行の**本物の日誌エントリ id**（`GET /conversations/:id` が返す
   * `ConversationMessage.id`）。**サーバから確定済みの発言（`historyLines`）
   * だけが持つ。** 送信直後の楽観行（`pendingOwnLines` に刈られる前の行。
   * `showOwnLine` が作る）や、承認の台帳から織り込んだ `system` 行には
   * まだ本物の id が無いので、ここは常に `undefined` のままである。
   *
   * **編集の入口（鉛筆）を出してよいかは、この欄の有無だけで判定する**
   * （チャットのメッセージ編集、#1010）。送信中の楽観行に鉛筆を出さないための
   * 唯一の根拠がこれ——`role === 'human'` だけで判定すると、まだサーバに
   * 存在しない行にも編集の入口が出てしまう。
   */
  /**
   * この行が「返信ではなく、返せなかった知らせ」であれば、その種類（サーバの
   * `ConversationMessage.turnFailure` をそのまま写す。**文面では見分けない**）。
   * `failed` はもう一度送れば試し直せる、`held` は枠が開けばクローンが自分で試し直す。
   */
  turnFailure?: 'failed' | 'held';
  /** サーバの `turnFailureKind` をそのまま写す（`turnFailure` と同時に付く）。 */
  turnFailureKind?: TurnFailureKind;
  /**
   * 同じストリーム（＝1ターン）の返信行をまとめる印（#3593）。`ask_human`・道具を挟んで返信が
   * 複数の行に分かれても、日誌には**ターン末に1つの発言**（本文を連結したもの）として載る
   * （`clone.ts` の `exchange` の書き込み）。`pendingOwnLines` は、この印を持つ行の連結を履歴の
   * 1発言と突き合わせる。画面の中だけのもの。
   */
  replyGroup?: string;
  journalId?: string;
  /** この発言に添えられた添付の控え（中身ではない。表示の部品が取りに行く）。 */
  attachments?: readonly MessageAttachment[];
  /**
   * 送ったときに付けた発言の id（サーバの `ConversationMessage.clientMessageId` の写し。#3203）。
   * 履歴の人間の発言だけが持つ（付けずに届いた発言・手元の楽観行・クローンの返事は持たない）。
   */
  clientMessageId?: string;
  /**
   * この行が承認待ち（`ask_human`）のカードであれば、その承認（#3259）。
   *
   * **時刻は `createdAt` に固定する。** 回答・取り下げは同じカードの状態として出し、別の行にしない。
   * 生配信（SSE の `ask_human`）が作る行は質問しか知らない最小の形で、台帳から読んだ行（履歴）が
   * 同じ承認を持つようになったら `pendingOwnLines` が承認 id で引き取る。
   */
  approval?: PendingApproval;
}

/** 履歴と手元の行を突き合わせる鍵。承認のカードは本文ではなく承認 id で結ぶ（回答で本文は変わらないが、状態は変わる）。 */
function lineMatchKey(line: Line): string {
  return line.approval !== undefined
    ? `approval\u0000${line.approval.id}`
    : `${line.role}\u0000${line.text}`;
}

/** SSE の `ask_human` から、質問しか知らない最小の承認を作る（台帳の行が来たら置き換わる）。 */
function approvalFromAskEvent(approvalId: string, question: string): PendingApproval {
  const now = new Date().toISOString();
  return { id: approvalId, createdAt: now, updatedAt: now, question };
}

/**
 * **いま見ている会話のものだけを返す。**
 *
 * ⚠️ **これが「前の会話の中身を出さない」ことの本体である**（#437）。
 * 会話を切り替えたときに `lines` を捨てる処理（下の「人間が別の会話を選んだ
 * ときだけ状態を捨てる」）は残してあるが、**保証はそちらが持っていない** ——
 * 捨てた後に React が「切り替えより前に積まれていた更新」を基底の値から
 * 貼り直すと、前の会話の `lines` が丸ごと戻ってくることがあるからである
 * （実測: 60回中11回。既定の並列度の全スイートでも捕まえた。生の観測は #437）。
 * **戻ってきても持ち主が違うので、ここで落ちる。**
 *
 * **⚠️ そして、ここは何も壊さない（filter であって破壊ではない）。** これが
 * 2つ目の条件である —— React は**古い props で描き直す**ことがあり
 * （実測: `main` で40記録中7回、`routeId` が定義済みの後に `undefined` へ
 * 戻る描画が起きている）、その回に `lines` を壊す形にしていると、**人間が
 * 送ったばかりの発言ごと消える。** ここは選ぶだけなので、次の描画で戻る。
 */
export function ownedBy(lines: Line[], shownId: string | undefined): Line[] {
  return lines.filter((line) => line.of === shownId);
}

/**
 * **`lines` に保ち続けてよい行を、いま見ている会話・直前に見ていた会話・
 * まだ持ち主の決まっていない行に絞る**（issue #446）。
 *
 * ⚠️ **`ownedBy` と役目が違う。** `ownedBy` は「いま画面に出す」を決め、
 * こちらは「state（`lines`）に保ち続けてよいか」を決める。会話を何度も
 * 行き来すると `lines` が単調に増え続けたのが #446 の症状で、これは
 * その上限を「持ち主の集合」で切る側である。使い方は下の `ChatPane` の
 * 不変条件チェックを参照。
 *
 * **なぜ「いま」だけでなく「直前」も残すか。** 会話を切り替える処理
 * （下の `routeId !== lastRouteId` のブロック）は、`shownId` を進めるのと
 * **同じ render で** `previousShownId` も進める。だから React が
 * 「切り替えの直前まで積まれていた更新」を古い基底から貼り直しても
 * （#437 の実測: 60回中11回）、貼り直された回でも `shownId`／
 * `previousShownId` の組は直前の会話をまだ憶えている。**もし直前を
 * 落として「いま」だけで刈ると、貼り直しで `shownId` が一瞬古い値へ
 * 戻る回（`main` で40記録中7回観測）に「いま見ている会話」そのものが
 * 入れ替わり、その回の刈りが本物の行まで落としてしまう** — #437 の
 * 回帰テスト「古い routeId で描き直されても、送った発言も届いた本文も
 * 消えない」が守っているのはまさにこの経路である。
 *
 * **なぜ `of === undefined` を残すか。** 新しい会話では、送った発言の
 * ほうが会話 id より先に画面へ乗る（`open` が届いて `of` を付け直すまでの
 * 窓。下の「まだ持ち主の無い行に、決まった id を付け直す」参照）。ここを
 * 落とすと、送ったばかりの発言が消える — #437 で実際に踏んだ形そのもの
 * である。
 *
 * **同じ会話へ戻って続けた分の手元の写しは、ここでは刈らない。** 上限は
 * 「見ている会話の数」であって「行の古さ」ではないので、`retainedBy` 単体
 * では同じ2つの会話を何度往復しても手元の写しは増え続けうる（issue #446
 * の筋書き2）。**その刈り込みはこの関数の役目ではなく、下の
 * `pendingOwnLines` が持つ。**「サーバの履歴が既にその行を引き取ったか」を
 * 見て判断するのは変わらないが、**一致が確認できた行だけを落とし、確認
 * できない限りは理由を問わず残す**（履歴の再取得がまだ空を返している窓も
 * 「確認できない」に含まれる）ことで、届いたばかりの行を画面から消す形を
 * 避けている。詳細は `pendingOwnLines` の doc を参照。
 */
export function retainedBy(
  lines: Line[],
  shownId: string | undefined,
  previousShownId: string | undefined,
): Line[] {
  return lines.filter(
    (line) => line.of === undefined || line.of === shownId || line.of === previousShownId,
  );
}

/**
 * **`ownedBy(lines, shownId)` のうち、`historyLines`（サーバの履歴、いま見て
 * いる会話ぶん）に同じもの（`role` と本文の組の多重集合で照合）が無いものだけ
 * を返す。** 「まだサーバの履歴に引き取られていない、手元にしか無い行」——
 * 画面に出す `all`（下の `ChatPane`）と、`lines` 自体を刈る不変条件チェック
 * （同じく `ChatPane`）の**両方から同じ関数を呼ぶ**。別々に書くと、どちらか
 * だけ直して突き合わせがずれる将来を作る。
 *
 * ⚠️ **一致した行だけを「引き取られた」とみなす。一致が無ければ、理由を
 * 問わず（履歴がまだ読み込まれていない・再取得の途中で一時的に空を返して
 * いる・本当にまだ引き取られていない、のどれでも）その行は返り値に残る。**
 * だから、届いたばかりの行が履歴再取得の窓で画面から消えることはない ——
 * PR #467 が「サーバの履歴が引き取ったかで刈る形」を見送った理由（履歴の
 * 再取得がまだ空を返す窓で新着行を消してしまう）は、「無いと確認できたら
 * 落とす」構造でだけ起きる。ここは逆に「有ると確認できたときだけ落とす」
 * 構造なので、その窓では単に何も起きない（一致0件のまま何も落ちない）。
 *
 * **同じ本文が複数あっても1件ずつしか消さない**（多重集合の照合。理由は
 * `ChatPane` 内の `all` の doc に同じものがある）。
 */
/** 操作で消える要素から、フォーカスを戻す先（#3595）。 */
type FocusIntent =
  { kind: 'edit'; lineKey: string } | { kind: 'approval'; approvalId: string } | { kind: 'end' };

const FOCUSABLE = 'textarea, input, select, button:not([disabled]), a[href]';

function isFocusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

function composerInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-chat-input]');
}

/**
 * 戻す先へフォーカスを移す。**戻し終えた（もう見張らなくてよい）ときだけ `true`。**
 * 鉛筆へ戻した直後は `false` を返す——確定した発言は置き換わって鉛筆ごと消えることがあり、
 * そのときはもう一度（入力欄へ）戻す。
 */
function applyFocusIntent(intent: FocusIntent): boolean {
  if (intent.kind === 'edit') {
    if (!isFocusLost()) return false;
    const pencil = [...document.querySelectorAll<HTMLElement>('[data-edit-key]')].find(
      (element) => element.getAttribute('data-edit-key') === intent.lineKey,
    );
    if (pencil !== undefined) {
      pencil.focus();
      return false;
    }
    composerInput()?.focus();
    return true;
  }
  if (intent.kind === 'approval') {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-approval-card]')];
    const answered = cards.find(
      (element) => element.getAttribute('data-approval-card') === intent.approvalId,
    );
    // 答えが台帳から戻って、カードが答え済みの表示に変わるまで待つ。
    if (answered?.getAttribute('data-approval-state') === 'unanswered') return false;
    const active = document.activeElement;
    if (!isFocusLost() && !(answered !== undefined && answered.contains(active))) return true;
    const unanswered = cards.filter(
      (element) => element.getAttribute('data-approval-state') === 'unanswered',
    );
    const index = answered === undefined ? -1 : cards.indexOf(answered);
    const next = unanswered.find((element) => cards.indexOf(element) > index) ?? unanswered[0];
    const target = next?.querySelector<HTMLElement>(FOCUSABLE) ?? composerInput();
    target?.focus();
    return true;
  }
  // 会話を終える: 確認を閉じたあと。成功なら新しい会話の入力欄、失敗なら押したボタンへ。
  // 成功すると会話が切り替わって入力欄が作り直されることがあるので、戻した後も見張る（使い手が動かすまで）。
  if (!isFocusLost()) return false;
  (document.querySelector<HTMLElement>('[data-chat-end]') ?? composerInput())?.focus();
  return false;
}

/**
 * 失敗した（または枠が閉じて保留になった）ターンの返信行に付ける印（#3705）。`error` を受けた時点で、
 * そのターンの `replyGroup` に付ける。
 *
 * サーバは失敗したターンの返信を日誌に載せず、`turnFailure` の知らせだけを載せる。手元の途中の返信は
 * 「履歴に当たらないものは落とさない」ので居残り、知らせの後ろに並んで「もう一度送る」を隠す。
 * **履歴に同じ種類の知らせが増えたら、その分の手元のターンを引き取って落とす。** 受信中（履歴に知らせが
 * まだ無い）は落とさず、受け取った分を見せ続ける。
 */
export interface FailedTurn {
  /** そのターンの会話（`Line.of`）。 */
  of: string | undefined;
  kind: 'failed' | 'held';
  /** 印を付けた時点で、履歴にあった同じ種類の知らせの数。`undefined`（履歴を見ていなかった）なら引き取らない。 */
  baseline: number | undefined;
}

/** 履歴の知らせが引き取った分の `replyGroup`（印を付けた順に、増えた知らせを1つずつ割り当てる）。 */
function claimedFailedGroups(
  failedTurns: ReadonlyMap<string, FailedTurn> | undefined,
  shownId: string | undefined,
  historyLines: Line[],
): Set<string> {
  const claimed = new Set<string>();
  if (failedTurns === undefined || failedTurns.size === 0) return claimed;
  const counts = { failed: 0, held: 0 };
  for (const line of historyLines) {
    if (line.turnFailure !== undefined) counts[line.turnFailure] += 1;
  }
  const consumed = { failed: 0, held: 0 };
  for (const [group, turn] of failedTurns) {
    if (turn.of !== shownId || turn.baseline === undefined) continue;
    const start = Math.max(turn.baseline, consumed[turn.kind]);
    if (counts[turn.kind] > start) {
      claimed.add(group);
      consumed[turn.kind] = start + 1;
    }
  }
  return claimed;
}

export function pendingOwnLines(
  lines: Line[],
  shownId: string | undefined,
  historyLines: Line[],
  failedTurns?: ReadonlyMap<string, FailedTurn>,
): Line[] {
  const claimedGroups = claimedFailedGroups(failedTurns, shownId, historyLines);
  const owned = ownedBy(lines, shownId).filter(
    (line) => line.replyGroup === undefined || !claimedGroups.has(line.replyGroup),
  );
  const remaining = new Map<string, number>();
  for (const line of historyLines) {
    const key = lineMatchKey(line);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  /*
   * **id を持つ手元の人間の行（送った発言。#3826）は、履歴の同じ id の行だけが引き取る。** 本文だけで
   * 見ると、過去の同じ本文（「はい」）が、いま送った行を引き取って消してしまう。id を持たない履歴の
   * 行（id 無しで届いた発言）とは、従来どおり本文で突き合わせる。
   */
  const historyIds = new Set<string>();
  const historyUnlabeled = new Map<string, number>();
  for (const line of historyLines) {
    if (line.role !== 'human') continue;
    if (line.clientMessageId !== undefined) historyIds.add(line.clientMessageId);
    else historyUnlabeled.set(line.text, (historyUnlabeled.get(line.text) ?? 0) + 1);
  }
  const historyApprovals = new Map<string, PendingApproval>();
  for (const line of historyLines) {
    if (line.approval !== undefined) historyApprovals.set(line.approval.id, line.approval);
  }
  /*
   * **分かれた返信（#3593）は、連結した本文で履歴の1発言と突き合わせる。** 日誌はターンの本文を
   * 1つの発言として載せるので、行ごとに照合すると、履歴が引き取っても手元の行が全部残って二重に出る。
   * 連結が当たらなければ、行ごとの照合へ落ちる（一致を確認できないものは落とさない）。
   */
  const groups = new Map<string, Line[]>();
  for (const line of owned) {
    if (line.replyGroup === undefined || line.role !== 'clone') continue;
    groups.set(line.replyGroup, [...(groups.get(line.replyGroup) ?? []), line]);
  }
  const absorbedGroups = new Set<string>();
  for (const [group, members] of groups) {
    if (members.length < 2) continue;
    const key = `clone\u0000${members.map((member) => member.text).join('')}`;
    const count = remaining.get(key) ?? 0;
    if (count === 0) continue;
    remaining.set(key, count - 1);
    absorbedGroups.add(group);
  }
  const pending: Line[] = [];
  for (const line of owned) {
    if (line.replyGroup !== undefined && absorbedGroups.has(line.replyGroup)) continue;
    const key = lineMatchKey(line);
    const labeled = line.role === 'human' && line.clientMessageId !== undefined;
    let taken: boolean;
    if (labeled && historyIds.has(line.clientMessageId ?? '')) {
      historyIds.delete(line.clientMessageId ?? '');
      taken = true;
    } else if (labeled) {
      const unlabeled = historyUnlabeled.get(line.text) ?? 0;
      taken = unlabeled > 0;
      if (taken) historyUnlabeled.set(line.text, unlabeled - 1);
    } else {
      const count = remaining.get(key) ?? 0;
      taken = count > 0;
      if (taken) remaining.set(key, count - 1);
    }
    if (taken) {
      /*
       * **承認のカードは、手元の行より前にいる行がまだ引き取られていないあいだ、手元の位置に残す
       * （#3396）。** 手元の行（送った発言・受信中の本文）は履歴の後ろに置くので、カードを履歴の側へ
       * 渡すと、起きた順（発言 → 本文 → 質問）より前（発言や本文の上）に出てしまう。時刻では並べない
       * （手元の行の時刻は端末の時計で、サーバの時刻とずれうる）。残すあいだの中身は、台帳から取り直した
       * もの（回答・取り下げ・設問）に差し替える。前の行が引き取られたら、履歴の側（`createdAt` の位置）へ移る。
       */
      const approval = historyApprovals.get(line.approval?.id ?? '');
      if (line.approval !== undefined && approval !== undefined && pending.length > 0) {
        pending.push({ ...line, approval });
      }
      continue;
    }
    pending.push(line);
  }
  return pending;
}

/** `pendingOwnLines` が手元の位置に残している承認カードの id（履歴の側からは外す）。 */
function heldApprovalIds(pending: Line[]): Set<string> {
  const ids = new Set<string>();
  for (const line of pending) if (line.approval !== undefined) ids.add(line.approval.id);
  return ids;
}

/**
 * 履歴に、この `clientMessageId` を持つ人間の発言があるか（#3121 / #3203。積んだ送信が受け取られたかの照合）。
 * **本文では見ない。** 同じ本文の発言が別の経路から届いても、id は違うので取り違えない。
 */
function hasHumanWithClientMessageId(lines: Line[], clientMessageId: string): boolean {
  return lines.some((line) => line.role === 'human' && line.clientMessageId === clientMessageId);
}

/** 版の切り替え（`< 2/2 >`）が1つ差し出す、編集前のある版。 */
export interface EditedVersion {
  /** その版で実際に送った本文。 */
  text: string;
  /**
   * この版のすぐ後に続いていた、いまは既定ビューから畳まれているやりとり
   * （この版自身の発言は含まない）。古い順。
   */
  hiddenFollowUps: { role: 'human' | 'clone' | 'approval'; text: string }[];
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/** 決着した（回答済みか取り下げ済み）承認か。 */
function isSettledApproval(approval: PendingApproval): boolean {
  return (
    (approval.answeredAt !== undefined && approval.answeredAt !== null) ||
    (approval.withdrawnAt !== undefined && approval.withdrawnAt !== null)
  );
}

/** 畳まれた版の後ろに出す、決着済みの確認の1行。 */
function describeFoldedApproval(approval: PendingApproval): string {
  const settled =
    approval.withdrawnAt !== undefined && approval.withdrawnAt !== null
      ? '（取り下げ済み）'
      : approval.answer
        ? `（回答: ${approval.answer}）`
        : '（回答済み）';
  return `${approval.question}${settled}`;
}

/**
 * 編集で畳まれた区間（畳まれた発言のいちばん古い時刻から、畳んだ編集の時刻まで）。
 * 畳むかどうかの規則そのものはサーバ（`supersededBy`）が持つ。ここはその区間に上がった承認を
 * 見分けるためだけに、同じ印から区間を引く（承認は発言の id を持たないので、時刻で当てる）。
 */
function foldedSpans(messages: readonly ConversationMessage[]): { start: string; end: string }[] {
  const starts = new Map<string, string>();
  for (const message of messages) {
    if (message.supersededBy === undefined) continue;
    const current = starts.get(message.supersededBy);
    if (current === undefined || message.at < current) starts.set(message.supersededBy, message.at);
  }
  const spans: { start: string; end: string }[] = [];
  for (const [editId, start] of starts) {
    const edit = messages.find((message) => message.id === editId);
    if (edit !== undefined) spans.push({ start, end: edit.at });
  }
  return spans;
}

/**
 * 編集で置き換えられた発言の版を、`supersedes` / `supersededBy` の連結から
 * 組み立てる（チャットのメッセージ編集、#1010）。
 *
 * **畳み込み規則そのものはここでは持たない。** 何を隠すか・どの編集が隠したか
 * を決めるのはサーバ（`packages/core/src/conversation.ts` の
 * `computeSupersededIds`）で、ここは `GET /conversations/:id?includeSuperseded=true`
 * が返す結果（各発言が持つ `supersedes` / `supersededBy`）を辿って束ねるだけ
 * である（AGENTS.md「畳み込み規則を web 側に再実装しないこと」）。
 *
 * `headId` は**いま既定ビューに出ている**（`supersededBy` が付いていない）
 * 発言の id。これが `supersedes` を持たなければ「編集されていない」ので
 * `undefined` を返す。
 *
 * **祖先が窓の外へ落ちていたら、そこで打ち切る**（サーバの
 * `computeSupersededIds` が「T が窓の中に見つからなければ何も隠さない」と
 * 防御的に振る舞うのと同じ考え方——見つからないものを無いことにはしないが、
 * 遡れない先を捏造もしない）。
 */
export function buildEditVersions(
  messages: ConversationMessage[],
  headId: string,
  approvals: readonly PendingApproval[] = [],
): EditedVersion[] | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const head = byId.get(headId);
  if (head === undefined || head.supersedes === undefined) return undefined;

  // 古い順の id 列（先頭がいちばん古い版）。
  const ids: string[] = [headId];
  for (let cursor = head; cursor.supersedes !== undefined;) {
    const previous = byId.get(cursor.supersedes);
    if (previous === undefined) break;
    ids.unshift(previous.id);
    cursor = previous;
  }
  if (ids.length < 2) return undefined;

  return ids.map((id, index) => {
    const message = byId.get(id);
    const nextId = ids[index + 1];
    // この版のすぐ後に畳まれた分——「次の版に隠された発言」のうち、
    // この版自身（`id`）を除いたもの（＝この版が受け取った応答など）。
    const next = nextId === undefined ? undefined : byId.get(nextId);
    const folded: { at: string; role: 'human' | 'clone' | 'approval'; text: string }[] =
      nextId === undefined
        ? []
        : messages
            .filter((entry) => entry.supersededBy === nextId && entry.id !== id)
            .map((entry) => ({
              at: entry.at,
              role: entry.role === 'inbound' ? ('human' as const) : ('clone' as const),
              text: entry.text,
            }));
    // この版の区間（この版の発言から、次の版の発言まで）に上がった、決着済みの確認も畳む（#3397）。
    if (message !== undefined && next !== undefined) {
      for (const approval of approvals) {
        if (!isSettledApproval(approval)) continue;
        if (approval.createdAt < message.at || approval.createdAt >= next.at) continue;
        folded.push({
          at: approval.createdAt,
          role: 'approval',
          text: describeFoldedApproval(approval),
        });
      }
    }
    const hiddenFollowUps = folded
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map(({ role, text }) => ({ role, text }));
    return { text: message?.text ?? '', hiddenFollowUps };
  });
}

/**
 * `POST /clone/interrupt` の3値（`useInterruptClone` の doc）を人間の言葉にする
 * （#1398 c23-1/c30-2。入口の等価性——CLI の `alteroid interrupt` にあって
 * Web UI に無かった口を足す）。
 *
 * **CLI の `describeInterruptOutcome`（`apps/cli/src/interrupt.ts`）と文言を
 * 1文字も違えていない。二重管理である**——apps 同士はパッケージを共有しない
 * （共有先は `packages/` だけ）ので、揃える手段がここに書き写す以外に無い
 * （`hooks/mutations.ts` の `roughPreview` と同じ事情）。CLI 側の文言を直したら
 * ここも直すこと。
 */
export function describeCloneInterruptOutcome(
  outcome: 'interrupted' | 'withdrawn' | 'not_target' | 'starting' | 'idle' | 'unsupported',
): string {
  switch (outcome) {
    case 'withdrawn':
      return '順番待ちだった発言を取り下げました（送っていません）。書いた文は入力欄へ戻しました。先客のターンには触れていません。';
    case 'not_target':
      return 'いま走っているのは、この発言のターンではない（別の起点の）ターンです。先客のターンは止めていません。';
    case 'starting':
      return 'この発言のターンが始まる直前でした（まだ止めていません）。もう一度押してください。';
    case 'interrupted':
      return 'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';
    case 'idle':
      return '走っているターンは無かった（止めるものが無い）。';
    case 'unsupported':
      return 'このサーバのクローンは、ターンを止められない。';
  }
}

/**
 * 会話の切り替えは `/chat/:id` どうしの移動で、添えかけは画面がしまって戻す（`attachmentDrafts`）。
 * 離れる確認の対象にするのは、チャットの外へ出る移動だけ。
 */
const staysInChat = (pathname: string) => pathname === '/chat' || pathname.startsWith('/chat/');

const PENDING_ATTACHMENTS_LEAVE_NOTICE: LeaveNotice = {
  title: '添えかけのファイルがあります',
  description:
    'このまま離れると、入力欄に添えたファイルは失われます（本文の書きかけと違い、ファイルは戻せません）。',
  confirmLabel: '破棄して離れる',
};

export default function Chat(props: Route.ComponentProps) {
  return (
    <LeaveGuardScope staysOn={staysInChat}>
      <ChatScreen {...props} />
    </LeaveGuardScope>
  );
}

function ChatScreen({ loaderData }: Route.ComponentProps) {
  const { conversationId } = loaderData;

  /*
   * 狭い画面では会話一覧も畳む。**shell の nav と2枚重なると本文が残らない** —
   * 幅 375px で nav 208px ＋ 会話一覧 256px なので、そのままでは足りない。
   */
  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  const closeList = () => setListOpen(false);

  return (
    /*
     * **`h-dvh` ではなく `h-full`。** 高さの出どころは shell（`AuthedShell`）の
     * `h-dvh` 1つにまとめてある。ここでも viewport を取ると、狭い画面で上端に
     * 出す帯のぶんだけ画面からはみ出す（帯は shell が持っていて、この部品からは
     * 見えない）。
     */
    <div className="flex h-full">
      {isMobile ? (
        <Drawer open={listOpen} onClose={closeList} label="会話一覧">
          <ConversationList activeId={conversationId} onNavigate={closeList} />
        </Drawer>
      ) : (
        <ConversationList activeId={conversationId} />
      )}
      {/*
        **`key` を付けてはいけない。** 新しい会話は受信の途中（`open`）で id が決まり、
        URL をそこへ揃える。`key={conversationId}` にすると、その同期で作り直しが起きて
        受信中のストリームが中断され、続く text / done が画面に出ない。
        会話の切り替えは ChatPane が自分で見分ける。
      */}
      <ChatPane
        routeId={conversationId}
        onOpenList={isMobile ? () => setListOpen(true) : undefined}
      />
    </div>
  );
}

/**
 * 会話の一覧。
 *
 * **広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く**（`shell.tsx`
 * の `Nav` と同じ形）。別々に書くと、一覧に何か足したときに片方だけ増える。
 */
/** 会話の一覧が 1 頁で読む件数（`GET /conversations` の `limit`）。続きは継続点（`nextCursor`）で足す。 */
const CONVERSATION_PAGE_SIZE = 30;

function ConversationList({
  activeId,
  onNavigate,
}: {
  activeId: string | undefined;
  /**
   * 行き先を押したとき。ドロワーの中では閉じる。
   *
   * **`useEffect` で URL の変化を見る形にしていない。** いま開いている会話を
   * もう一度押すと URL が変わらず、覆ったまま残る。
   */
  onNavigate?: (() => void) | undefined;
}) {
  /*
   * 「もっと見る」（#3404 → #3550）。押すたびに 1 頁（30 件）ぶん多く、**継続点（`nextCursor`）で
   * 続きを足す**。`limit` の上限（200）や `scan` の窓の外の会話にも辿れる。
   * **取り直しの間も、失敗したときも、直前の一覧を残す**（`keepPreviousData`）。
   * 失敗は画面の上の `ErrorNote` ではなく、一覧の下に小さく言う。もう一度押せば同じ頁を取り直す。
   * 続き（`nextCursor`）が無ければボタンを出さない。
   */
  const [pages, setPages] = useState(1);
  const { data, error, isLoading, isValidating, mutate } = useConversations(
    CONVERSATION_PAGE_SIZE,
    { keepPreviousData: true, pages },
  );
  // 「たった今」「N分前」を古いまま残さない（#3596）。
  const now = useMinuteNow();
  const loadingMore = pages > 1 && isValidating;
  const moreFailing = pages > 1 && error !== undefined && !isValidating;

  /*
   * 但し書きを組み立てるのは画面の側（`ConversationList` の `notes`）。出す条件は
   * 従来どおり、この順に並べる。
   */
  const notes: ReactNode[] = [];
  /*
   * `scanned` は「人間との往復をどこまで遡ったか」（マネージャーとの往復・
   * 内部ターンは数えない。issue #418）。全部を見たとは限らないので、
   * 黙って切らずに出す（掘れば降りられる、が要件）。
   */
  /*
   * 頁を足したあと（#4021）、`scanned` は最後の頁の窓の値でしかない（窓は頁ごとに読み直し、次の窓は前の窓の
   * 途中から始まるので、足し合わせると重なりを二重に数える）。一覧全体の値のように言わず、どの範囲の値かを言う。
   * `reachedStart` も最後の（いちばん古い）窓のもの——それが先頭に届いていれば、日誌は先頭まで読めている。
   */
  const pagesRead = data?.pagesRead ?? 1;
  if (data !== undefined) {
    notes.push(
      pagesRead > 1
        ? `${pagesRead} 頁ぶんを読んだ（最後の頁の窓は、人間との往復 ${data.scanned} 件を走査）`
        : `人間との往復 ${data.scanned} 件を走査`,
    );
  }
  /*
   * **窓（`scan`）が日誌の先頭に届いていないことを言う。** 下の `ChatPane`
   * の「先頭には届いていない」と同じ作法 — `reachedStart` が真のときは
   * 出さない（窓が先頭に届いているなら、そこに但し書きを出すと「常に
   * 出ているもの」になって情報でなくなる）。
   */
  if (data?.reachedStart === false) {
    notes.push(
      `人間との往復を ${pagesRead > 1 ? `${pagesRead} 頁ぶん` : `${data.scanned} 件`}遡ったが、先頭には届いていない。これより古いやりとりが残っている可能性がある。`,
    );
  }
  /*
   * 既読の記録が読めないとき、デーモンは**位置を全て無いものとして、クローンの発言を全部未読として数える**
   * （`ConversationReadView`）。一覧の未読の太字と件数はその値なので、断らないと本当の未読に見える（#4021）。
   * シェルのナビの「未読の会話を読めていない」と同じ趣旨。
   */
  if (data?.readStateUnreadable !== undefined) {
    notes.push(
      '既読の記録が読めない。未読の太字と件数は、クローンの発言を全部未読として数えた値で、会話を開いても、記録が読めるようになるまで変わらない。',
    );
  }
  /*
   * **窓の中で `limit` に収まらず落とした会話があることを言う（#418 の
   * 裏返し）。** #418 は「他の種別に食われる」窓、こちらは「自分の種別で
   * 溢れる」窓 — 人間との会話は増え続けるので、時間が経てば必ず踏む。
   * 語彙はクローンの道具（`tools.ts` の「…ほか N 件は省略」）に寄せる。
   * `reachedStart` とは別の条件なので、両方出ることも片方だけのこともある。
   */
  if (data !== undefined && data.hiddenByLimit > 0 && data.nextCursor === undefined) {
    // 続き（`nextCursor`）を返さない古いデーモンのとき。続きがあるなら、下の「もっと見る」が言う。
    notes.push(
      `…ほか ${data.hiddenByLimit} 件は省略（この窓に ${data.conversations.length + data.hiddenByLimit} 件あり、新しい順に ${data.conversations.length} 件だけ出した）。`,
    );
  }

  return (
    <UiConversationList
      items={data?.conversations.map((conversation) => ({
        id: conversation.conversationId,
        preview: conversation.preview,
        updatedLabel: formatRelativeAtMinute(conversation.updatedAt, now),
        messages: conversation.messages,
        messagesAtLeast: data.windowsComplete === false,
        unread: conversation.unreadCount,
      }))}
      activeId={activeId}
      // 続きを取っている間は、直前の一覧を残す（`keepPreviousData` でも `isLoading` は真になる）。
      loading={isLoading && data === undefined}
      error={pages > 1 && data !== undefined ? undefined : error}
      more={
        data !== undefined && (data.nextCursor !== undefined || moreFailing)
          ? {
              onClick: () => {
                if (moreFailing) void mutate();
                else setPages((current) => current + 1);
              },
              loading: loadingMore,
              ...(moreFailing ? { error } : {}),
            }
          : undefined
      }
      // 取れなかったのを0件と描かない（#2323）。再検証の失敗で `data` が残るときは当たらない。
      unavailable={data === undefined && error !== undefined}
      notes={notes}
      inDrawer={onNavigate !== undefined}
      // 従来は「新しい会話」のボタンも Tab の順路に残っていた（振る舞いは変えない）。
      newConversationTabStop
      renderLink={(target, slot) => (
        <Link
          to={target.id === undefined ? '/chat' : `/chat/${target.id}`}
          // 開いている会話を読み上げへ伝える（色の class だけでは伝わらない、#3568）。
          aria-current={target.id !== undefined && target.id === activeId ? 'page' : undefined}
          onClick={onNavigate}
          className={slot.className}
        >
          {slot.children}
        </Link>
      )}
    />
  );
}

/**
 * 走っているストリーム1本ぶん。
 *
 * `opened` を持つのは**追送**（受信中に続けて打った発言）のためである。追送は
 * 自分では購読を張らず、走っているこのストリームへ応答を流させるので、投函先の
 * 会話 id が要る。新しい会話では id が `open` まで決まらないので、約束として持つ。
 */
interface Stream {
  controller: AbortController;
  /** このストリームが**どの会話のものか**。`open` で確定したらここも移す。 */
  id: string | undefined;
  /** 会話 id が確定したら解決する。確定しないまま終わったら reject する。 */
  opened: Promise<string>;
  settleOpen: (conversationId: string) => void;
  failOpen: (reason: unknown) => void;
  /**
   * このストリームを立てた送信（#3956）。止めるボタンはこの発言だけを対象に渡す。追送は載せない
   * （走っているのは先に送った発言のターンで、追送を指すと止めるべきターンを外す）。
   */
  turn?: {
    clientMessageId: string;
    text: string;
    lineKey: string;
    supersedes: string | undefined;
    attachments: PendingAttachment[];
  };
  /**
   * 再生（再読み込み・戻ってきた会話）が止める対象に選んだ発言の `clientMessageId`（#3990）。
   * 決められなければ `null`。再生でないストリーム（自分の送信）では持たない。
   */
  resumeTarget?: string | null;
}

/**
 * 再生で「ターンを止める」が止める発言を、`open.pending` から決める（#3990。CLI の `/resume` と同じ決め方）。
 * `running` の先頭、無ければ `starting` の先頭。まとめ読みで複数あっても同じターンなので1件で止まる。
 *
 * `held`・`queued` は選ばない: 再生しているのは走っているターンで、それが `pending` に無い
 * （`clientMessageId` を持たない別の起点）のに順番待ちを選ぶと、見ているターンは止まらず別の発言を
 * 取り下げてしまう。`pending` を返さない古いデーモンも `null`（対象を省くと先客のターンを止めうる）。
 *
 * **例外は、この画面が自分で追送した発言（`own`。#3990）。** 走っているのが先客のターンで、自分の追送だけが
 * `queued`・`held` で待っているときは、それが「止める」で取り下げる対象になる（自分が打った発言だと
 * 分かっているので、別の起点の発言を取り下げる心配が無い）。`own` の中で `pending` の先頭のものを選ぶ。
 */
function pickResumeTarget(
  pending: ChatStreamPending[] | undefined,
  own?: ReadonlySet<string>,
): string | null {
  if (!Array.isArray(pending)) return null;
  for (const state of ['running', 'starting'] as const) {
    const found = pending.find((entry) => entry.state === state);
    if (found !== undefined) return found.clientMessageId;
  }
  if (own !== undefined) {
    const waiting = pending.find(
      (entry) =>
        (entry.state === 'queued' || entry.state === 'held') && own.has(entry.clientMessageId),
    );
    if (waiting !== undefined) return waiting.clientMessageId;
  }
  return null;
}

function createStream(controller: AbortController, id: string | undefined): Stream {
  let settleOpen: (conversationId: string) => void = () => {};
  let failOpen: (reason: unknown) => void = () => {};
  const opened = new Promise<string>((resolve, reject) => {
    settleOpen = resolve;
    failOpen = reject;
  });
  /*
   * **読み手が居なくても reject する約束なので、ここで受けておく。** 追送が
   * 一度も無ければ `opened` を待つ者は居ないが、ストリームが `open` を見ないまま
   * 終われば下の `failOpen` は呼ばれる。受け手の無い reject は unhandled rejection
   * になり、テストでは実行そのものを落とす。
   */
  opened.catch(() => {});
  const stream: Stream = { controller, id, opened, settleOpen, failOpen };
  // 既存の会話なら id は最初から分かっている。追送を `open` まで待たせない。
  if (id !== undefined) settleOpen(id);
  return stream;
}

/** 会話1つ分の画面。**作り直しに弱いので**、回帰テストから直接組み立てられるようにしてある。 */
export function ChatPane({
  routeId,
  onOpenList,
}: {
  routeId: string | undefined;
  /** 会話一覧を開く口。狭い画面でドロワーに畳んだときだけ渡ってくる。 */
  onOpenList?: (() => void) | undefined;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const endConversation = useEndConversation();
  const recordOwnMessage = useRecordOwnMessage();
  const interruptClone = useInterruptClone();

  /**
   * この画面が見せている会話。
   *
   * 新しい会話の id は受信の途中（`open`）で決まるので、**URL より先にここが決まる**。
   * URL は後から追いつく。逆にすると、追いついた瞬間が「別の会話に変わった」と
   * 区別できなくなる。
   */
  const [shownId, setShownId] = useState(routeId);
  const [lines, setLines] = useState<Line[]>([]);
  /** 失敗・保留で終わったターンの印（#3705）。`replyGroup` → 印。履歴に知らせが現れたら、そのターンの手元の返信を落とす。 */
  const [failedTurns, setFailedTurns] = useState<ReadonlyMap<string, FailedTurn>>(new Map());
  /** いまの履歴の行。受信の `error` の時点で、履歴にある知らせの数を数えるために読む（#3705）。 */
  const historyLinesRef = useRef<Line[]>([]);
  // 書きかけの本文は会話ごとに `sessionStorage` にも残す（再読み込み・タブの破棄から戻る。#3400）。
  const [draft, setDraft] = useState(() => loadChatDraft(routeId));
  /**
   * 「いま見ている会話ではない」会話の下書き（#1618）。**キーは会話 id
   * （`shownId` と同じ形。新しい会話＝id 無しは `undefined` という1つの鍵に
   * 持つ）。**
   *
   * **いま見ている会話ぶんはここには無い** — それは `draft`（上）が持つ。
   * 会話を切り替える瞬間（下の `routeId !== lastRouteId` の同期ブロック）に
   * 限って、双方向に1回だけ動く: 出ていく会話の `draft` をここへしまい、
   * 入ってくる会話の下書きをここから読んで `draft` へ差し替える。`failures`
   * （上の同名の Map の doc）と同じ理由で Map にしてある — 会話ごとに持たない
   * 限り、切り替えるたびに他の会話の下書きへ触れずに済ませられない。
   *
   * **送信で空にするのは `draft`（表示中の1つ）だけでよい。** `send`/`followUp`
   * が `setDraft('')` を呼ぶのは常に「いま見ている会話」に対してで、次に
   * この会話から離れるときにその空の値がここへしまわれる（下の同期ブロック）
   * ので、送った会話の下書きだけが空になり、他の会話のエントリには触れない。
   * **新しい会話で送ると、離れるときの鍵は `undefined` ではなく確定した id に
   * 替わっている**（`open` の `setShownId(stream.id)`）。だから入ってくる会話の
   * 鍵は、読み出した時点で Map から消しておく（下の同期ブロック、#2453）——
   * そうしないと鍵 `undefined` に送る前の値が残る。
   *
   * **再読み込みを跨いでは残さない**（`localStorage` 等は Issue #1618 の
   * 範囲外）。この Map はメモリの中だけの state である。
   */
  const [drafts, setDrafts] = useState<Map<string | undefined, string>>(new Map());
  const [sending, setSending] = useState(false);
  /**
   * 会話の中の承認カードの書きかけ（承認 id ごと。回答欄の文と設問フォームの選択・補足）。
   * カードは会話を移ると外れるので、カードの中で持つと書きかけが消える（#3398）。ここは
   * `ChatPane` が生きているあいだ残る。
   */
  /*
   * **承認の画面（`routes/approvals.tsx`）と同じ保存先**（`alteroid.approvalDrafts`、承認 id がキー。#3481）。
   * チャットの画面を離れる・再読み込みするとここの state は消えるので、`sessionStorage` にも写す。
   * 会話で書きかけた答えを承認の画面で開いても続きが出て、逆も同じ。
   */
  const [approvalDrafts, setApprovalDraftsState] = useState<ApprovalDrafts>(loadApprovalDrafts);
  /** 書きかけを最後に決めた時点の `chatDraftEpoch()`。ログアウトの後にメモリから書き戻さない（#3706）。 */
  const approvalDraftsEpoch = useRef(chatDraftEpoch());
  const setApprovalDrafts = useCallback((update: SetStateAction<ApprovalDrafts>) => {
    approvalDraftsEpoch.current = chatDraftEpoch();
    setApprovalDraftsState(update);
  }, []);
  /** 答えが通ったが送らなかった下書きが残った承認の、本文と設問の控え。承認の画面と同じ保存先（#3861）。 */
  const [leftoverSources, setLeftoverSources] = useState<ApprovalLeftoverSources>(
    loadApprovalLeftoverSources,
  );
  /**
   * 送信経路（`send`/`followUp`、ストリームの `error` イベント）の失敗。**会話 id ごとに持つ（#1585）。**
   *
   * PR #1579（#1576）は `{ conversationId, error }` を1つだけ持つ形にして、
   * 描画の時点の `shownId` と一致するときだけ出すようにした——「別の会話の
   * 画面に出る」（#1576 の穴）はそれで直った。**だが `ChatPane` は会話を切り替える
   * たびに、どの会話へ向かうかを見ずにこの1つだけの `failure` を消していた**
   * （旧・下の `routeId !== lastRouteId` の同期リセット）。A で追送した発言が
   * B を見ている間に失敗すると、A に戻ってももう消えた後——「出す会話を間違える」
   * バグが「言えるはずの失敗が消える」バグに変わっていた（#1585）。
   *
   * **直し方: 1つの `{ conversationId, error }` ではなく、会話 id ごとの Map で持つ。**
   * キーは失敗を積む時点の `stream.id`/`running.id`。**新しい会話でまだ id が
   * 確定していない失敗は、キー `undefined` に積む**——その時点の `shownId` も
   * 同じく `undefined` なので、いま見えている「新しい会話」の画面にはそのまま出る。
   *
   * **キー `undefined` の失敗を、後から確定した id へ移すことはしない。** そうなる
   * 前提（キー `undefined` に失敗が積まれた後で、同じ会話の `open` が届く）が
   * 作れないからである——
   * - `followUp` は `await running.opened` の後にしか投函しない ⟹ 追送の失敗は
   *   常に id が確定した後に起き、キー `undefined` には入らない
   * - キー `undefined` に入るのは、ストリームが `open` を1度も見ないまま終わった回
   *   （`send` の `finally` の `failOpen`）だけで、そのストリームに後から `open` は届かない
   * - サーバーは `open` を必ず最初の SSE のイベントとして書き、`error` を書いたら抜ける
   *   （`apps/daemon/src/app.ts` の `POST /chat` の `streamSSE`）⟹ `open` より前に `error`
   *   のイベントが届いて、その後に同じストリームで `open` が来ることもない
   *
   * #1585 の直しは `open` の分岐でキー `undefined` を確定した id へ移す処理を持って
   * いたが、到達しないので消した（消しても Web の全スイートが緑のままだったことが
   * 横断レビューで分かった。PR 本文に再現を書いてある）。
   *
   * **消えるときは「その会話で次の送信・追送を始めたとき」だけ。** 会話の
   * 切り替えでは消さない——切り替えても Map から他の会話のエントリを触らない
   * ので、A に戻れば A のぶんがそのまま出る。`send`/`followUp` の冒頭で、
   * これから送ろうとしている会話のキーだけを消す（他の会話のキーは残す）。
   *
   * 出すかどうかはここでは決めない——描画する側（下の `visibleFailure`）が、
   * **その描画の時点で決まっている `shownId`** をキーに引いてから決める。
   */
  const [failures, setFailures] = useState<Map<string | undefined, unknown>>(new Map());
  /**
   * **`open` に届く前に失敗した送信の、送り直しの手がかり（#3064）。** キーは
   * `failures` と同じ（失敗が出る会話）で、`failures` を消すのと同じ場所で消す。
   * 文は下書きにも戻すが、使い手がもう新しく打ち始めていれば戻せない——そのとき
   * 文を失わないための置き場がここで、失敗表示の「再送」が読む。
   */
  const [retries, setRetries] = useState<
    Map<
      string | undefined,
      {
        text: string;
        supersedes?: string;
        restored?: boolean;
        /**
         * 積んだ中身を入力欄へ戻したか（#3247）。戻していれば、入力欄が「再送」の元になる
         * （使い手が直したものを送る）。戻していない（失敗が届く前に使い手が新しく打ち始めていた）
         * なら、入力欄は別の発言なので、「再送」は積んだ中身を送って入力欄には触らない。
         */
        inComposer?: boolean;
        attachments?: PendingAttachment[];
        /**
         * この送信に付けた `clientMessageId`（#3203）。**再送では同じ値を使う**——サーバが同じ会話で
         * 受け取り済みなら、二重に受けずに続きを返す。
         */
        clientMessageId?: string;
        /**
         * `open` の前に**中断された**送信（#3121）。サーバが受け取ったか分からない。
         * `clientMessageId` を持つ人間の発言が履歴に現れたら、受け取られていたと見て下ろす
         * （本文でも添付でもなく id で見る。同じ本文・同じ添付の別の発言と取り違えない）。
         */
        unconfirmed?: true;
        /**
         * 新しい会話（キーが `undefined`）の送信について、取り直した会話の id（#3258）。ある間は、次の送信は
         * 新しい会話ではなく、この会話へ送る（受け取り済みの添付が別の会話へ結ばれて 400 になるのを避ける）。
         */
        conversationId?: string;
        /**
         * 再読み込みで復元した印が、添付つきの送信のものだった（#3708）。ファイルの実体は残せないので
         * 戻せていない。案内に件数と名前を出し、使い手が添え直して送るか、本文だけで送るかを選ぶ。
         */
        lostAttachments?: { count: number; names: string[] };
      }
    >
  >(new Map());
  /** 入力欄に添えた添付（送る前）。上げるのは `send` のとき。 */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /*
   * 本文の書きかけを、いま見ている会話の鍵で残す。**残すのは本文だけ**（添付・承認の回答・編集の
   * 続きは残さない）。空なら鍵ごと消えるので、送信（入力欄が空になる）で消え、失敗して戻した文は
   * また残る。**入力のたびには書かず、少し間引く**（打鍵が止まって `DRAFT_SAVE_DELAY_MS` 後に書く）。
   * 空にしたときは待たずに消す（送った文が復元されない）。会話を替える・画面を離れる・タブを
   * 隠す／閉じる（`pagehide`）ときは、待っている分をすぐ書く。
   */
  const pendingDraftSave = useRef<{ id: string | undefined; text: string; epoch: number } | null>(
    null,
  );
  const flushDraftSave = useCallback(() => {
    const waiting = pendingDraftSave.current;
    if (waiting === null) return;
    pendingDraftSave.current = null;
    // 待っているあいだにログアウト（全部消す）されたなら、書き戻さない。
    if (waiting.epoch !== chatDraftEpoch()) return;
    saveChatDraft(waiting.id, waiting.text);
  }, []);
  useEffect(() => {
    if (pendingDraftSave.current !== null && pendingDraftSave.current.id !== shownId)
      flushDraftSave();
    if (draft === '') {
      pendingDraftSave.current = null;
      saveChatDraft(shownId, '');
      return;
    }
    pendingDraftSave.current = { id: shownId, text: draft, epoch: chatDraftEpoch() };
    const timer = setTimeout(flushDraftSave, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [shownId, draft, flushDraftSave]);
  useEffect(() => {
    window.addEventListener('pagehide', flushDraftSave);
    return () => {
      window.removeEventListener('pagehide', flushDraftSave);
      flushDraftSave();
    };
  }, [flushDraftSave]);
  /**
   * 添付を上げている最中か。真のあいだは、**上げ始めた会話の**入力欄は送れない。
   * 押した時点の会話 id を持ち、描画で `shownId` と一致するときだけ composer へ渡す
   * （`interruptNotice` と同じ形。持たないと、別の会話へ移っても入力欄を塞ぐ、#3567）。
   */
  const [uploading, setUploading] = useState<ReadonlyMap<string | undefined, number>>(new Map());
  /** 会話 `id` の「上げている最中」の数を1つ増やす／減らす。別の会話の上げ終わりは、この会話の印に触れない（#3709）。 */
  const adjustUploading = useCallback((id: string | undefined, delta: 1 | -1) => {
    setUploading((previous) => {
      const next = new Map(previous);
      const count = (next.get(id) ?? 0) + delta;
      if (count > 0) next.set(id, count);
      else next.delete(id);
      return next;
    });
  }, []);
  /** 会話を離れているあいだ、その会話の添えかけの添付をしまっておく（`drafts` と同じ鍵・同じ扱い）。 */
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Map<string | undefined, PendingAttachment[]>
  >(new Map());
  /*
   * 添えかけのファイルは、画面が外れると失われる（メモリだけ。`File` は残せない）。**会話にしまってあるぶんも含めて**
   * 数え、在るあいだは離れる前の確認を挟む（#4019）。再読み込みで失ったときのために、件数と名前だけを会話ごとに
   * `sessionStorage` へ控え（`chat-drafts`）、戻ったときに言う。
   * 控えは、この画面が書いた鍵のうち空になったものだけ消す——読む前に空の状態で消すと、案内が出せない。
   */
  const heldAttachments = useMemo(() => {
    const held = new Map<string | undefined, PendingAttachment[]>();
    for (const [key, items] of attachmentDrafts) if (items.length > 0) held.set(key, items);
    if (pending.length > 0) held.set(shownId, pending);
    else held.delete(shownId);
    return held;
  }, [attachmentDrafts, pending, shownId]);
  useReportDirty(
    'chat-pending-attachments',
    heldAttachments.size > 0,
    PENDING_ATTACHMENTS_LEAVE_NOTICE,
  );
  const writtenNoteKeys = useRef(new Set<string | undefined>());
  useEffect(() => {
    for (const [key, items] of heldAttachments) {
      writtenNoteKeys.current.add(key);
      savePendingAttachmentsNote(key, {
        count: items.length,
        names: items.map((item) => sizedOf(item).name),
      });
    }
    for (const key of writtenNoteKeys.current) {
      if (heldAttachments.has(key)) continue;
      writtenNoteKeys.current.delete(key);
      savePendingAttachmentsNote(key, undefined);
    }
  }, [heldAttachments]);
  const [lostPending, setLostPending] = useState<
    ReadonlyMap<string | undefined, PendingAttachmentsNote>
  >(new Map());
  const lostPendingChecked = useRef(new Set<string | undefined>());
  useEffect(() => {
    if (lostPendingChecked.current.has(shownId)) return;
    lostPendingChecked.current.add(shownId);
    const note = loadPendingAttachmentsNote(shownId);
    if (note === undefined || writtenNoteKeys.current.has(shownId)) return;
    setLostPending((previous) => new Map(previous).set(shownId, note));
  }, [shownId]);
  const shownLostPending = pending.length === 0 ? lostPending.get(shownId) : undefined;
  /** 添え直し始めたら控えは新しいもので置き換わる。言い終えた案内は、閉じる（または添え直す）まで出す。 */
  const dismissLostPending = () => {
    savePendingAttachmentsNote(shownId, undefined);
    setLostPending((previous) => {
      const next = new Map(previous);
      next.delete(shownId);
      return next;
    });
  };
  /** 添えようとして断った理由（個数・大きさ。クライアントの先行検査）。 */
  const [attachNotice, setAttachNotice] = useState<string>();
  const attachSeqRef = useRef(0);
  /** 中断した新しい会話の送信の会話を、`clientMessageId` で引いている最中か（#3258。二重に引かない）。 */
  const lookingUpRef = useRef(false);
  const ownLineSeqRef = useRef(0);
  /**
   * `POST /clone/interrupt` を呼んでいる最中かどうか（#1398 c23-1/c30-2）。
   * ボタンの二重打鍵を防ぐためだけの、この画面だけの状態——サーバ側の状態には
   * 対応しない。
   */
  const [interrupting, setInterrupting] = useState<{ conversationId: string } | undefined>(
    undefined,
  );
  /**
   * `POST /clone/interrupt` の応答を人間の言葉にしたもの（`describeCloneInterruptOutcome`）。
   * 失敗（ネットワーク断・403 等）は `interruptFailure`（下）へ回すので、
   * ここに乗るのは3値のどれかに正しく応答が返った場合だけである。
   *
   * **押した時点の会話 id（`conversationId`）を一緒に持つ（#1570）。** 出すかどうかは
   * ここでは決めない——描画する側（下の `interruptNotice` の読み出し）が、
   * **その描画の時点で決まっている `shownId`** と突き合わせてから決める。
   *
   * ⚠️ 以前は `shownIdRef.current === pressedConversationId`（#1548）で判定していた。
   * `shownIdRef.current` は `useEffect(() => { shownIdRef.current = shownId; ... },
   * [shownId])`（下）という**受動効果の中でしか進まない**ため、会話を切り替えた
   * render から効果が走るまでの窓の中で応答が返ると、切り替え後もまだ古い会話の
   * ままの `shownIdRef.current` と比べてしまい、別の会話の画面に前の会話の
   * 「止めた」を出していた（#1570）。**この形は効果の順序にもう依らない** ——
   * `conversationId` は「押した」という事実にくっついた、変わらないデータであり、
   * 一致判定は毎 render 同期的に決まる `shownId` に対して行うので、効果が
   * いつ走るかに一切関係が無い。
   */
  const [interruptNotice, setInterruptNotice] = useState<
    { conversationId: string; text: string } | undefined
  >(undefined);
  /**
   * `handleInterrupt` の呼べなかった失敗（ネットワーク断・403 等）。`interruptNotice`
   * と同じ理由・同じ形で会話 id を持つ（#1570）。
   *
   * **送信経路の `failures`（上）へは合流させない。** どちらも会話 id を持つように
   * なった（#1576）が、発生源（`handleInterrupt` と `send`/`followUp`）が別なので
   * state は分けたまま持ち、描画する場所（下の `ErrorNote`）で `visibleFailure` /
   * `visibleInterruptFailure` として同じ形の突き合わせをしてから合流させる。
   *
   * **`failures` と違って会話 id ごとの Map にはしていない（#1585 で検討して
   * 見送った）。** 揃えるなら「B で『止める』が失敗した後 A へ戻ったら出す」に
   * なるが、`interruptNotice`（呼べた側）は今回も切り替えで消す判断のままで
   * ——`interruptFailure`（呼べなかった側）だけ Map にすると、同じボタンの
   * 応答なのに「呼べた」と「呼べなかった」で切り替え後の扱いが割れる。
   * 「止める」は会話ごとの人間の入力（送れていない発言）ではなく、押した
   * その場で結果が分かる操作なので、`interruptNotice` と同じ「切り替えたら
   * 消える」で揃えたままにする。
   */
  const [interruptFailure, setInterruptFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  /**
   * `POST /chat/:conversationId/end`（「会話を終える」）を呼んでいる最中かどうか
   * （Issue #2171）。ボタンの二重打鍵を防ぐためだけの、この画面だけの状態
   * ——`interrupting` と同じ理由・同じ形。
   */
  const [endingConversation, setEndingConversation] = useState<
    { conversationId: string } | undefined
  >(undefined);
  /**
   * 「会話を終える」が成功した結果（#2759）。終えた会話の id を持つ。成功すると画面は
   * 新しい会話（`/chat`）へ移るので、**移った先の見出しの下に1行で出す**——何も
   * 出さないと、押した人には空の画面へ切り替わっただけに見える。出すのは新しい会話
   * （`shownId` が無い）の間だけで、別の会話へ移ったら捨てる（下の render 時の判断）。
   */
  const [endNotice, setEndNotice] = useState<{ fromId: string } | undefined>(undefined);
  /**
   * `handleEndConversation` の失敗（ネットワーク断・403 等）。`interruptFailure`
   * と同じ理由・同じ形で押した時点の会話 id を持つ（Issue #2171）——`ChatPane` は
   * 会話を切り替えても作り直されない（このファイル冒頭の doc）ので、応答が
   * 返るより先に別の会話へ切り替えられうる。出すかどうかは描画する側
   * （下の `visibleEndFailure`）が、その描画の時点の `shownId` と突き合わせて
   * から決める——`interruptFailure`/`interruptNotice` と同じ形。
   */
  const [endFailure, setEndFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  /**
   * いま編集中の行の `key`（チャットのメッセージ編集、#1010）。無ければ
   * `undefined`。**`Line.key`（サーバ確定済みの発言では日誌エントリ id と
   * 同じ）で持つ** —— `journalId` だけで持たない理由は、`journalId` を持たない
   * 行（楽観行・確認由来の `system` 行）はそもそも編集の入口を出さないので
   * 区別する必要が無く、`key` のほうが `Line` 全般の一意な識別子として
   * 素直だからである。
   */
  const [editingKey, setEditingKey] = useState<string | undefined>(undefined);
  /**
   * 操作で消えた要素から、フォーカスを戻す先（#3595）。無ければ `undefined`。
   * 要素が unmount されるとブラウザはフォーカスを `document.body` へ捨てるので、キーボードで
   * 続けるには先頭から Tab し直すことになる。**戻す効果は下の `useEffect`（`applyFocusIntent`）。**
   */
  const focusIntentRef = useRef<FocusIntent | undefined>(undefined);
  /**
   * **発言の編集の下書きは、発言（`Line.key`）ごとに持つ（#3565）。** 確定するまで消さない——
   * Escape・「キャンセル」・別の発言の鉛筆・会話の切り替えでは捨てない。その発言の鉛筆をもう一度
   * 押すと、書きかけから再開する。確定（`confirmEdit`）で消す（送った文は、失敗すれば入力欄へ
   * 編集の続きとして戻る。#3393）。
   *
   * 添付（#3399）は**編集では引き継ぐ**——外さない限り、新しい版にも付ける。同じ会話の中なら、
   * サーバは同じ添付の結び直しを受ける（冪等）。
   *
   * `sessionStorage` にも本文と同じ作法で残す（#3707。鍵は発言の id、残すのは本文と引き継ぐ添付の控え、
   * 元のままなら残さない、間引き、ログアウトの `clearChatDrafts`・epoch に乗せる）。再読み込みの後は
   * ここへ読み戻すので、鉛筆を押せば書きかけから再開でき、書きかけの印も出る。
   */
  const [editDrafts, setEditDrafts] = useState<ReadonlyMap<string, EditDraft>>(
    () =>
      new Map(
        [...loadEditDrafts()].map(([key, stored]) => [
          key,
          {
            text: stored.text,
            attachments: stored.attachments,
            added: [],
            lost: stored.lostNames ?? [],
          },
        ]),
      ),
  );
  /** 編集で足そうとして断った理由（個数・大きさ）。編集を閉じる・確定するまで出す。 */
  const [editAttachNotice, setEditAttachNotice] = useState<string>();
  const editDraft = editingKey === undefined ? '' : (editDrafts.get(editingKey)?.text ?? '');
  const editAttachments = useMemo(
    () => (editingKey === undefined ? [] : (editDrafts.get(editingKey)?.attachments ?? [])),
    [editDrafts, editingKey],
  );
  const updateEditDraft = useCallback(
    (key: string, change: (current: EditDraft) => EditDraft) =>
      setEditDrafts((previous) => {
        const current = previous.get(key) ?? { text: '', attachments: [], added: [], lost: [] };
        return new Map(previous).set(key, change(current));
      }),
    [],
  );
  const dropEditDraft = useCallback((key: string) => {
    // 保存したものも待たずに消す（確定が通ったあと・元のままになったあとに復元されない）。
    saveEditDraft(key, undefined);
    setEditDrafts((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  }, []);
  /**
   * 「受信を始めた」「返信が終わった」を読み上げるための知らせ（#3568）。本文の流れは読まない。
   * 会話（`id`）を持たせ、いま見ている会話のものだけ出す。
   */
  const [liveNote, setLiveNote] = useState<{ id: string | undefined; text: string } | undefined>(
    undefined,
  );
  /**
   * 版の切り替え（`< 2/2 >`）がいま見せている版の添字（0始まり）。
   * key は `Line.journalId`（編集された発言の、いま既定ビューに出ている側の
   * 本物の id）。**無い（未操作）ときは最新の版を見せる**——`editVersions`
   * （上）が返す配列の末尾が常に「いま既定ビューに出ている内容」と一致する
   * ため、記録していない発言は最新を見せるのと同じ結果になる（下の render
   * が `?? versions.length - 1` で表す）。
   */
  const [viewingVersionIndex, setViewingVersionIndex] = useState<Record<string, number>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** スクロールする器そのもの。「最下部にいるか」を見るのに要る（#247 の 1）。 */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  /**
   * 直近に分かっている「最下部にいるか」。
   *
   * 効果（下の `useEffect`）はこの値だけを見て追従するかを決める — 効果が
   * 走る時点では新しい行が既に描かれた後で、器の `scrollHeight` はもう
   * 伸びているので、そこで測っても「新しい行が来る前にどこにいたか」は
   * 分からない。だから測定は `onScroll` 側（ユーザーの操作、および自分で
   * 呼んだ `scrollIntoView` が発火させる `scroll` イベント）で行い、ここへ
   * 持ち越す。既定は `true`（＝初回描画は最下部から始まる。旧来どおり）。
   */
  const isAtBottomRef = useRef(true);
  /**
   * 直前の `setLines` が自分の発言を積んだものかどうか。
   *
   * 自分が送った直後は遡って読んでいる最中ではない（入力欄を使うのに画面を
   * 触っているので、読み返しの途中ではなく会話に参加しようとしている）。
   * だから最下部にいなくても、送った直後だけは追従してよいと判断した。
   */
  const justSentOwnLineRef = useRef(false);
  /**
   * 追従の効果が直前に見た `shownId`。
   *
   * **`isAtBottomRef` は `ChatPane` が生きているあいだ値を保つ ref であり、
   * `ChatPane` は会話を切り替えても作り直されない**（`key` を付けない理由は
   * 上のコメントのとおり、受信中のストリームを切らないためである）。つまり
   * 会話 A で上へ遡って `isAtBottomRef.current` が `false` になったあと、
   * 会話 B へ移っても ref はそのまま `false` を持ち越す — 直さなければ、
   * 開いたばかりの会話 B が最下部から始まらない。
   *
   * **他の効果（`shownId` を見て前の会話のストリームを止める効果）の宣言順に
   * 依存させない。** 会話の切り替わりをこの効果自身の中で見分けることで、
   * 同じコミットでどちらの効果が先に走っても結果が変わらないようにしてある。
   */
  const lastSeenShownIdRef = useRef(shownId);

  /**
   * 張りかけの再生（`open` をまだ見ていない接続）。**`send` が自分のストリームを
   * 始めるとき、先にこれを畳む**——登録の前に人間が送ると、再生と送信の2本が
   * 同じ応答を受けて二重に出る。登録（`streamRef`）した後なら `followUp` の経路に
   * 乗るので、これは要らない。
   */
  const pendingResumeRef = useRef<AbortController | undefined>(undefined);

  /** 走っているストリーム。無ければ `undefined`。 */
  const streamRef = useRef<Stream | undefined>(undefined);
  /**
   * **終端（`done`/`error`）を見ないまま途中で終わったかもしれない返信行**のキー
   * （会話 id → `replyKey` の集合）。Issue #2662。
   *
   * **1本のストリームに返信行は複数ある**（`ask_human`・道具・`usage_limited` を挟んで
   * 続く text は新しい行で始まる。#3593）ので、値は集合である。
   *
   * サーバの再生（`GET /chat/:id/stream`）は進行中のターンを**頭から**流す。資格が
   * 替わって効果が張り直された・会話を切り替えて戻った・自分の送信が途中で切れた、の
   * どれでも、前のストリームが積んだ途中の返信行は `lines` に残る（まだ履歴に無いので
   * `pendingOwnLines` が引き取らない）。そこへ再生が新しい行を頭から積むと二重になる。
   * だから再生の `open`（`inProgress: true`）を受けたとき、この会話のぶんだけ捨ててから積む。
   *
   * 書くのは `createStreamWriter`（返信行を作ったとき登録し、`done`/`error` で外す）、
   * 読むのは再生の効果だけ。`done` まで届いて確定した行は外れているので消えない。
   * render では読まないので ref でよい。
   */
  const unfinishedReplyRef = useRef(new Map<string, Set<string>>());
  /**
   * その会話の、終端を見なかった途中の返信行を捨てる（再生の `open` から、進行中かどうかを
   * 問わず呼ぶ。Issue #2662）。進行中なら再生が頭から積み直し、進行中でなければ確定した
   * 本文を履歴が出す。どちらでも前の途中の行は残さない。
   */
  /** 「受信をやめる」で止めた会話 id → 止めた時点の履歴のクローン発言数（#3761）。 */
  const stoppedReplyRef = useRef(new Map<string, number>());
  const discardUnfinishedReply = useCallback((conversationId: string) => {
    const stale = unfinishedReplyRef.current.get(conversationId);
    if (stale === undefined) return;
    unfinishedReplyRef.current.delete(conversationId);
    setLines((previous) => previous.filter((line) => !stale.has(line.key)));
    setActiveReplyKeys((keys) => {
      if (![...keys].some((key) => stale.has(key))) return keys;
      return new Set([...keys].filter((key) => !stale.has(key)));
    });
  }, []);
  /**
   * `open` のあと終端を見ないまま受信が切れた会話を、履歴が新しいクローンの発言を出したら畳む印を付ける（#4084）。
   * 途中の行がまだ無くても付ける（帯だけが残るのを避ける）。再生の口での取り直しはしない——
   * 頭から流し直すので、網が落ちている間は張り直しが空回りし、返信は日誌の更新で履歴に載るため。
   */
  const markCutOff = useCallback((conversationId: string | undefined) => {
    if (conversationId === undefined) return;
    stoppedReplyRef.current.set(
      conversationId,
      historyLinesRef.current.filter((line) => line.role === 'clone').length,
    );
  }, []);
  /**
   * いま見えている会話を、受信の途中からも読めるようにしたもの。
   *
   * ストリームの後片付けは「**この結果を今の画面へ書いてよいか**」で決まるが、
   * 判断する時点は非同期の奥なので、閉じ込めた `shownId` は古くなっている。
   */
  const shownIdRef = useRef(shownId);

  /**
   * **いま走っているストリームが積んだクローンの返信行の `key`（複数。#3593）。**
   * 無ければ空。1本のストリームの返信は、`ask_human`・道具を挟むたびに別の行になる。
   * 以下、単数で書いてある箇所は、この集合の要素ごとに読むこと（旧名 `activeReplyKey`）。
   *
   * ⚠️ **`pendingOwnLines` による刈り込み（下の不変条件チェック）から、この
   * `key` を持つ行だけを除外するために要る。** クローンの返信は完成するまで
   * `append` が同じ `key` を探して中身を書き換え続けるので、**その途中で
   * `pendingOwnLines` の内容一致（`role`＋本文）が偶然すでにある履歴行と
   * 揃ってしまうと**（同じ短い返信を過去にもしていた場合など）、刈られた
   * 瞬間に `append` は `key` を見失って以後のチャンクを静かに捨てる
   * （`findIndex` が `-1` を返す no-op）。**人間の発言（`showOwnLine`）は
   * 一度作ったら書き換えないので、この危険が無い** —— 除外するのはクローン
   * の返信の、いままさに継ぎ足され得るものだけで足りる。
   *
   * ⚠️ **`useRef` ではなく `useState` にしてある。** 下の刈り込みの不変条件
   * チェックは `retainedBy`（上）と同じ「render のたびに確認し、貼り直しにも
   * 自己修復する」形にする必要があり（doc は下）、そのためにはこの値を
   * **render 中に読む**必要がある。ref の `.current` を render 中に読むのは
   * React の前提（render は ref に依存しない）に反し、`react-hooks/refs` の
   * 歯が検出する。**state にしても余計な再描画は増えない** —— 値を書き換える
   * 箇所（下の `case 'text'` / ストリーム終了時の `finally`）は、どちらも
   * 同じ tick で `setLines` を呼んでいる箇所であり、React は同じコミットへ
   * まとめる。
   */
  const [activeReplyKeys, setActiveReplyKeys] = useState<ReadonlySet<string>>(NO_REPLY_KEYS);

  /**
   * 直前に見ていた会話。`retainedBy`（上）が「いま」に加えて残す2つ目の持ち主。
   *
   * **`shownId` を進めるのと同じ、この下のブロックでだけ更新する。**
   * `open`（新しい会話の id が決まるところ）では触らない — 触る箇所を
   * 増やすほど #437 の再発面が広がる。この結果、保つ持ち主は「いま」
   * 「直前」に加えて `of === undefined`（まだ id の付いていない、送った
   * ばかりの発言）を合わせて一時的に3つになることがあるが、それ以上には
   * 増えない（このブロックが走るたびに1つ前の `shownId` で上書きされる
   * だけで、積み上がらない）。
   */
  const [previousShownId, setPreviousShownId] = useState<string | undefined>(undefined);
  /**
   * 人間が別の会話を選んだときだけ状態を捨てる。
   *
   * **見るのは「URL が変わったか」であって「shownId と一致するか」ではない。**
   * `open` で id を決めてから URL が追いつくまでのあいだ、shownId は URL より
   * 先へ進んでいる。そこで一致だけを見ると、その隙間を「別の会話へ移った」と
   * 誤って読み、送ったばかりの発言ごと消してしまう。
   *
   * （React の「props が変わったら state を調整する」パターン。effect でやると
   * 一度古い内容を描いてから消すことになる。）
   */
  const [lastRouteId, setLastRouteId] = useState(routeId);
  if (routeId !== lastRouteId) {
    setLastRouteId(routeId);
    // URL が自分の採番に追いついただけなら、捨てるものは何も無い。
    if (routeId !== shownId) {
      setPreviousShownId(shownId);
      setShownId(routeId);
      /*
       * **この `setLines([])` は、下の `owns()`/`stopped()`（`writable()` の
       * 中身）と同じ役目の二重書きではない。守っている失敗が違う。**
       *
       * - **ここ（render 時の同期リセット）** — 会話を切り替えた**瞬間**に、
       *   前の会話の `lines`（自分の発言・受信中の合図・進行中の transient
       *   な行）を消す。ストリームが動いているかどうかとは無関係——
       *   ただ会話を切り替えただけで、静的にでも古い内容が新しい会話の
       *   画面に残るのを防ぐのはこちらの役目。
       * - **`owns()`/`stopped()`（`writable()`。この下の `send()` 参照）** —
       *   切り替えた**後**に、前の会話のストリームがなおも `setLines(...)`
       *   を呼ぼうとするのを止める。**動いているストリームがあって初めて
       *   意味を持つ**、上とは別の失敗を防いでいる。
       *
       * `git log -S` で確かめた限り、この3つ（この `setLines([])` /
       * `owns()` / `stopped()`）は同じ初期コミット（`04c1049`、#27）で
       * 同時に入った——「後から別の障害を踏んで1枚ずつ足した」歴史ではない。
       * それでも上のとおり守備範囲は最初から別である。
       *
       * **ただし変異試験（#363）は、この2つが実際には独立して働いていない
       * ことを見つけている。** 詳しい構造は下の `owns()`/`stopped()` の
       * doc（`writable()` の直前）にまとめてある。
       */
      /*
       * **⚠️ ここで `lines` を捨てない（#437 で外した）。**
       *
       * 前は `setLines([])` が在った。外したのは、**この判定が「一度きりの
       * edge」だからである** —— `routeId !== lastRouteId` は切り替わった瞬間に
       * 1回しか真にならないので、その1回の結果が失われると二度と走らない。
       * そして実測（#437）で、失われる経路が2つあることが分かっている:
       *
       * - **貼り直しで無かったことにされる** — 切り替えより前に積まれていた
       *   `lines` の更新が、捨てた後に基底の値から再適用される（60回中11回）
       * - **古い props で描き直された回に誤って当たる** — React は `routeId` が
       *   確定した後でも、古い基底から描き直すことがある（`main` で40記録中
       *   7回観測）。そこで破壊すると、**人間が送ったばかりの発言ごと消える**
       *
       * **⟹ 前の会話の中身を出さないことは `ownedBy`（持ち主で絞る）が持つ。**
       * あちらは選ぶだけで何も壊さないので、どちらの経路でも結果が変わらない。
       *
       * **`failures` はここでは触らない（#1585。以前はここで `setFailure(undefined)`
       * を呼んで1つだけの `failure` を丸ごと消していた）。** `failures` は会話 id
       * ごとの Map（上の doc）なので、切り替えでは何も消さなくても、別の会話の
       * 画面に他の会話の失敗が出ることはない——出すかどうかは描画の時点の
       * `shownId` で引く `visibleFailure` が決める。むしろここで消すと、A で
       * 追送が B を見ている間に失敗した後に A へ戻っても、その失敗がもう
       * どこにも出せなくなる（#1585 の本体）。**消えるときは、その会話で次の
       * 送信・追送を始めたとき**（`send`/`followUp` の冒頭がそのキーだけ消す）。
       *
       * **`lines` 自体が増え続けないことは、下の不変条件チェック（`retainedBy`）
       * が別に持つ（#446）。** ここは「出す/出さない」だけで「保つ/捨てる」を
       * 持たないので、会話を行き来するたびに手元へ積まれた行そのものは、
       * この render リセットだけでは減らない。
       */
      // 前の会話で出した「止めた」を持ち越さない。クローンのターンは会話ごとではない
      // ので、A へ戻ったときに古い表示を出し直さない（#1548）。応答がこの後に届いた
      // 場合は、会話 id の突き合わせ（`visibleInterruptNotice`）が別の会話へ出すのを防ぐ（#1570）。
      //
      // `interruptFailure`（呼べなかった失敗）も同じ理由で一緒に消す。`failures`
      // （送信経路）とは発生源が違うので分けて持っているが（下の `interruptFailure`
      // の doc）、ここでの扱いは #1585 でも変えていない——「止める」を押した事実
      // そのものは会話ごとの操作であり、A へ戻ったときに B で押した「止めた」を
      // 出し直す理由が無い（`interruptNotice` と同じ判断）。
      setInterruptNotice(undefined);
      setInterruptFailure(undefined);
      /*
       * **白紙の新しい会話へ入るときだけ、鍵 `undefined` の失敗を消す（#2460）。**
       * 鍵 `undefined` は「まだ id の無い新しい会話」全部が共有するので、前回の
       * 新しい会話の失敗（`open` の前の投函の失敗）を残すと、別の白紙の新しい
       * 会話にそのまま出てしまう。id のある会話の鍵は触らない（#1585 の
       * 「切り替えでは消さない」はそのまま）。**入るときに消す**のは、失敗した
       * 新しい会話から離れずにいるあいだは出続けるため、そして離れるときに
       * 消すと `open` 後に URL が追いつくだけの遷移でも消しうるため。
       */
      if (routeId === undefined) {
        setFailures((prev) => {
          if (!prev.has(undefined)) return prev;
          const next = new Map(prev);
          next.delete(undefined);
          return next;
        });
      }
      // 編集欄は閉じる（`editingKey` は `Line.key` で、別の会話では出ない）。**書きかけは捨てない**
      // （`editDrafts`。戻って鉛筆を押せば再開できる。#3565）。
      setEditingKey(undefined);
      setLiveNote(undefined);
      /*
       * **送っていない下書きは会話ごとに持ち、戻ったら戻す（#1618）。**
       *
       * `editingKey`/`editDraft`（直上。送信済みの発言を編集中の下書き）や
       * `sending`（この画面のものと明示的に決めてある、上の doc）とは違う——
       * こちらは「まだ送っていない、これから送るはずの入力」なので、会話を
       * 離れても人間にとっては消えてよい理由が無い。
       *
       * **`shownId` をキーに、いま出ていく会話の `draft` をしまう。** この
       * 時点の `shownId` はまだ古い会話（切り替わる前）を指しているので、
       * これがそのまま「離れる会話」の鍵になる——`setShownId(routeId)`（上）
       * より前に読んでいるので取り違えない。新しい会話（id 無し）から離れる
       * ときは鍵 `undefined` にしまわれる。
       *
       * **入ってくる会話（`routeId`）の下書きは `drafts`（この render 開始
       * 時点の値）から読む。** まだ一度もこの鍵に何もしまっていなければ
       * `undefined` なので `?? ''` で空にする——初めて開く会話や、送信済みで
       * まだ何も書きかけていない会話がこれに当たる。
       *
       * **読んだ鍵（`routeId`）は Map から消す（#2453）。** 読み出した値は
       * これ以降 `draft` が持つので、Map に残す理由が無い。残すと、新しい
       * 会話（鍵 `undefined`）で送ったときに古い値が生き残る——送信の
       * `setDraft('')` の後、`open` で `shownId` が確定した id へ替わるので、
       * 次に離れるときの鍵はその id になり、鍵 `undefined` は空で上書き
       * されない。そのまま次に新しい会話を開くと、送ったはずの文章が
       * 下書きとして戻っていた。
       */
      setDrafts((previous) => {
        const next = new Map(previous);
        next.set(shownId, draft);
        next.delete(routeId);
        return next;
      });
      setDraft(drafts.get(routeId) ?? loadChatDraft(routeId));
      /*
       * **添えかけの添付も、下書きと同じく会話ごとにしまい、戻ったら戻す。**
       * 使い手が選んだファイルを、会話を移っただけで黙って失わせない。しまうのは
       * メモリの中だけ（`File` は `localStorage` 等へ永続化できない。下書き `drafts` も
       * もともとメモリ内なので、リロードで消える点は同じ）。別の会話へ送ってしまう
       * 事故は、表示（`pending`）がいま見ている会話のものだけであることで避ける。
       */
      setAttachmentDrafts((previous) => {
        const next = new Map(previous);
        next.set(shownId, pending);
        next.delete(routeId);
        return next;
      });
      setPending(attachmentDrafts.get(routeId) ?? []);
      setAttachNotice(undefined);
    }
  }

  /**
   * **不変条件として毎 render 確かめる（issue #446。#440 の指摘への直接の答え）。**
   *
   * #440 は「一度きりの edge を印で見分けて、当たったら破壊する形は、React の
   * 貼り直しに対して成立しない」と指摘していた——直上の旧 `setLines([])` が
   * #437 でまさにこの形で壊れている。ここは逆に、**毎 render で `retainedBy`
   * の結果と現在の `lines` を比べるだけ**にしてある。貼り直しで前の会話の
   * 行が戻ってきても、次の render でまた同じ比較を通るので自己修復する——
   * 一度きりの `setLines([])` との決定的な違いはここにある。
   *
   * **刈っても、その render で画面に出せる行は1つも減らない。** `ownedBy`
   * が出すのは `of === shownId` の行だけで、`retainedBy` はそれに加えて
   * `previousShownId` と `undefined` の行を残すので、刈った後の集合は常に
   * `ownedBy` の出力を（部分集合として）含む。
   *
   * `previous` をそのまま返す分岐は、`retainedBy` が何も落とさなかった
   * render で `setLines` を無意味に呼んで再描画を増やさないためのもの
   * （長さが変わらない＝何も落ちていない、で判定する）。
   */
  if (retainedBy(lines, shownId, previousShownId).length !== lines.length) {
    setLines((previous) => {
      const next = retainedBy(previous, shownId, previousShownId);
      return next.length === previous.length ? previous : next;
    });
  }

  /*
   * **この画面で始めた会話でも履歴を読む（#92 で変えた）。**
   *
   * 直す前は `startedHere` を立てて `useConversation(null)` にしていた
   * （手元の `lines` が全文だから重ねると二重に出る、という理由）。だがそれは
   * 「サーバ側で後から進んだぶんを、この画面は永久に受け取らない」ことでもあった。
   * 枠（利用上限）で保持された発言は、枠が開いてから再試行されて返信が日誌へ載る
   * — その返信は `use-journal-live.ts` の無効化を経てここへ届くはずだったが、
   * **購読していない画面には無効化が効かない。** 同じタブに居続ける限り、遅れた
   * 返信は出ないままだった（人間の「あとで良いのでちゃんと返信してほしい」が
   * 満たされていなかった経路がここである）。
   *
   * 二重描画は購読をやめることではなく、下の `all` の重ね合わせで防ぐ。
   *
   * **`includeSuperseded: true` で読む（チャットのメッセージ編集、#1010）。**
   * 版の切り替え（`< 2/2 >`、下の `editVersions`）を組み立てるには、編集で
   * 畳まれた旧発言も見えている必要がある。**既定ビューに出すかどうかの
   * 判定は下の `historyLines` が `supersededBy` を見て自分でやる**——サーバの
   * `includeSuperseded=false` の絞り込みを、ここで型どおりに借りるのをやめた
   * だけで、既定ビューが「畳んだ後」であること自体は変えていない。
   */
  const history = useConversation(shownId ?? null, { includeSuperseded: true });

  /**
   * この会話に上がった確認（`ask_human`）（issue #782 の2）。
   *
   * **`exchange` だけでは復元できない。** `ask_human` が積む日誌エントリは
   * `escalation`（`packages/core/src/schema.ts`）で、`conversationId` を
   * 持たず、`readConversationWindow`（`with: ['human']`）の窓にも入らない。
   * 質問・回答は承認の台帳（`GET /approvals`）にしか無いので、ここで別に
   * 読んで `historyLines` へ織り込む。**journal / 台帳へは何も書かない**——
   * 読むだけである。
   */
  const conversationApprovals = useConversationApprovals(shownId ?? null);
  /*
   * 承認カードの書きかけを `sessionStorage` へ写す（#3481）。**ここで消すのは、この会話の承認の
   * 一覧を読めていて、決着済み（回答済み・取り下げ済み）と分かった id だけ。** 一覧を読めていない
   * （取得に失敗した・読み込み中）ときや、ほかの会話の承認の書きかけは、消さずに残す。
   */
  const settledApprovalIds = useMemo(
    () =>
      new Set(
        (conversationApprovals.data?.approvals ?? [])
          .filter(isSettledApproval)
          .map((approval) => approval.id),
      ),
    [conversationApprovals.data],
  );
  useEffect(() => {
    // 残した下書き（`leftoverSources` に在る id）は、決着済みでも保つ。
    const keep = (id: string) => !settledApprovalIds.has(id) || id in leftoverSources;
    saveApprovalDrafts(
      {
        texts: Object.fromEntries(Object.entries(approvalDrafts.texts).filter(([id]) => keep(id))),
        questions: Object.fromEntries(
          Object.entries(approvalDrafts.questions).filter(([id]) => keep(id)),
        ),
      },
      approvalDraftsEpoch.current,
    );
  }, [approvalDrafts, settledApprovalIds, leftoverSources]);
  useEffect(() => {
    saveApprovalLeftoverSources(
      Object.fromEntries(
        Object.entries(leftoverSources).filter(
          ([id]) => id in approvalDrafts.texts || id in approvalDrafts.questions,
        ),
      ),
    );
  }, [leftoverSources, approvalDrafts]);
  /** この会話の決着済みの承認のうち、送らなかった下書きが残っているもの。未回答のうちはカードの欄に見えている。 */
  const leftovers = useMemo(
    () =>
      Object.entries(leftoverSources)
        .filter(([id]) => settledApprovalIds.has(id))
        .map(([id, source]) => ({
          id,
          source,
          text: describeApprovalLeftover(source, approvalDrafts, id),
        }))
        .filter((entry) => entry.text !== ''),
    [leftoverSources, settledApprovalIds, approvalDrafts],
  );
  const discardLeftover = useCallback(
    (id: string) => {
      setApprovalDrafts((previous) => ({
        texts: omitKey(previous.texts, id),
        questions: omitKey(previous.questions, id),
      }));
      setLeftoverSources((previous) => omitKey(previous, id));
    },
    [setApprovalDrafts],
  );
  // 生配信の分岐（`useMemo` の中）から、いまの会話の承認を取り直す口（#3299）。
  const refetchApprovalsRef = useRef<() => void>(() => {});
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  refetchApprovalsRef.current = () => {
    // 画面が外れたあとに届いた生配信では呼ばない（SWR のキャッシュが片付いている）。
    if (!mountedRef.current) return;
    try {
      // 失敗は `conversationApprovals.error` に出る（下の `ErrorNote`）ので、ここでは未処理にしないだけ。
      void Promise.resolve(conversationApprovals.mutate()).catch(() => undefined);
    } catch {
      // 同上。
    }
  };

  /**
   * **既読にする（1つの規則）: この画面が表示されていて、タブが見えているとき、画面に出ている
   * 日誌由来の発言の最後のものまで。** 開いたとき・裏のタブで届いた分が表に戻ったとき・送信して
   * 完了まで居た後に返答が出たとき、のどれもこの1か所で済む。
   *
   * 見るのは `history`（`GET /conversations/:id`）だけで、受信の途中の一時的な文字（transient）や
   * 手元の `lines` は見ない——日誌の発言ではないので、それで既読にすると、返答が日誌に載る前に
   * 離れた（接続が切れた）ときも既読になってしまう。送るかどうかの判定と重複の抑止は
   * `useMarkConversationRead` が持つ。画面を離れれば（アンマウント）効果が止まり、送らない。
   */
  const pageVisible = usePageVisible();
  const markRead = useMarkConversationRead();
  useEffect(() => {
    if (!pageVisible || shownId === undefined || history.data === undefined) return;
    markRead(shownId, history.data);
  }, [pageVisible, shownId, history.data, markRead]);

  /**
   * 履歴（日誌から再構成されたもの）＋確認（承認の台帳）を時刻順に1本へ
   * 織り込む。
   *
   * **`at` の文字列比較で並べる。** サーバの会話（`GET /conversations/:id`）は
   * 既に古い順で返るが、確認は別の口から読むので混ぜるときは自分で並べ直す。
   * `message.at` も `approval.createdAt`/`answeredAt`/`withdrawnAt` も、生成
   * 経路（`clone.ts` の `#record` / `tools.ts` の `ask_human` / `tools.ts` の
   * `approval_withdraw`）はどれも `new Date().toISOString()`（UTC・ミリ秒3桁・
   * `Z` 終端）なので、文字列の比較がそのまま時刻の比較になる
   * （`approvalsCursorSchema` の doc と同じ前提）。
   *
   * **回答も出す（不変条件A）。** 質問だけ復元すると、回答済みの確認が画面を
   * 開き直した瞬間に「まだ返答が無い」に見える——新しい嘘の「無い」を作って
   * しまう。
   *
   * **取り下げも出す（issue #974。不変条件Aの取り下げ側）。** 詳細は下の
   * `approvalItems` 内の doc。
   */
  const historyLines = useMemo<Line[]>(() => {
    /*
     * **`history` は `includeSuperseded: true` で読んでいる**（上の doc）ので、
     * ここで既定ビュー（畳んだ後）を組み立て直す——`supersededBy` が付いた
     * 発言（編集で隠された旧発言・その応答）は除く。サーバの
     * `includeSuperseded=false` が返す集合と同じものを、ここで作り直して
     * いるだけである（畳み込み規則そのものは足していない——隠すかどうかは
     * サーバが計算した `supersededBy` の有無だけで判断する）。
     */
    const messageItems = (history.data?.messages ?? [])
      .filter((message) => message.supersededBy === undefined)
      .map((message) => ({
        at: message.at,
        line: {
          key: message.id,
          role: message.role === 'inbound' ? ('human' as const) : ('clone' as const),
          text: message.text,
          of: shownId,
          // **本物の日誌エントリ id を持つのは人間の発言だけに絞る必要は無い**
          // ——編集の入口を出すかは呼び出し側が `role === 'human'` も併せて
          // 見るので、ここでは単に「サーバ確定済みの発言である」ことを表す。
          journalId: message.id,
          ...(message.turnFailure === undefined
            ? {}
            : {
                turnFailure: message.turnFailure,
                turnFailureKind: message.turnFailureKind ?? 'other',
              }),
          ...(message.attachments === undefined || message.attachments.length === 0
            ? {}
            : { attachments: message.attachments }),
          ...(message.clientMessageId === undefined
            ? {}
            : { clientMessageId: message.clientMessageId }),
        },
      }));

    /*
     * **承認は1件を1枚のカードにして、`createdAt` の位置に置く（#3259）。** 回答（`answeredAt`）と
     * 取り下げ（`withdrawnAt`）は別の行にせず、同じカードの状態として出す（回答の時刻もカードの中）。
     * 回答済みが「まだ返答が無い」に見えない（不変条件A）・取り下げが痕跡なく終わらない
     * （issue #974）のどちらも、カードが状態と回答・理由を持つことで満たす。
     * 回答のあとのクローンの返答は、時刻順でカードの後ろに並ぶ。
     */
    /*
     * **決着済みの承認は、編集で畳まれた区間のものなら畳む（#3397。版を戻せば`hidden`に出る）。
     * 未回答は区間の中でも常に出す** —— クローンが答えを待っているので、隠すと答えられない。
     */
    const spans = foldedSpans(history.data?.messages ?? []);
    const approvalItems = (conversationApprovals.data?.approvals ?? [])
      .filter(
        (approval) =>
          !isSettledApproval(approval) ||
          !spans.some((span) => approval.createdAt >= span.start && approval.createdAt < span.end),
      )
      .map((approval) => ({
        at: approval.createdAt,
        line: {
          key: `a-${approval.id}`,
          role: 'system' as const,
          of: shownId,
          text: approval.question,
          approval,
        } satisfies Line,
      }));

    return [...messageItems, ...approvalItems]
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((item) => item.line);
  }, [history.data, conversationApprovals.data, shownId]);

  /**
   * **編集された発言の版の一覧（チャットのメッセージ編集、#1010）。**
   *
   * `history.data.messages`（`includeSuperseded: true` で読んだ、畳まれた分も
   * 含む全件）を1回だけ走査し、いま既定ビューに出ている（`supersededBy` の
   * 無い）人間の発言のうち `supersedes` を持つもの（＝編集で置き換えた側）
   * だけを入口として `buildEditVersions` に束ねさせる。
   *
   * key はその発言の**本物の日誌エントリ id**（`Line.journalId`）。版を持たない
   * 発言はここに現れない——`Map.get` が `undefined` を返すので、呼び出し側
   * （下の render）は「版がある行かどうか」をこの1点で判定できる。
   */
  const editVersions = useMemo(() => {
    const messages = history.data?.messages ?? [];
    const result = new Map<string, EditedVersion[]>();
    for (const message of messages) {
      if (message.role !== 'inbound') continue;
      if (message.supersededBy !== undefined) continue; // 隠された側は入口にしない
      if (message.supersedes === undefined) continue; // 編集していない発言
      const chain = buildEditVersions(
        messages,
        message.id,
        conversationApprovals.data?.approvals ?? [],
      );
      if (chain !== undefined) result.set(message.id, chain);
    }
    return result;
  }, [history.data, conversationApprovals.data]);

  /**
   * **同じ会話へ繰り返し戻った分も、`lines` 自体から刈る（issue #446 の
   * 筋書き2。`retainedBy`（上）が持たない側）。**
   *
   * `retainedBy` の不変条件チェック（上）は「見ている会話の数」で切るので、
   * 同じ1〜2個の会話を何度往復しても、その会話ぶんの手元の写しは
   * `retainedBy` だけでは減らない。ここは「行の古さ」ではなく「サーバの
   * 履歴が実際に引き取ったと確認できたか」で切る側 —— `pendingOwnLines`
   * （上）を、画面に出す `all`（下）だけでなく `lines` 自体にも適用する。
   *
   * ⚠️ **一致していない行は絶対に落とさない**（`pendingOwnLines` の doc）。
   * 履歴の再取得がまだ空を返している窓では一致が0件なので、この不変条件は
   * 何もしない —— 届いたばかりの行が画面から消える形にはならない。刈るのは
   * 「サーバが引き取ったと確認できた」ときだけである。
   *
   * ⚠️ **`activeReplyKey`（state。上）の行だけは対象から外す**（同 state の
   * doc）。ここも `retainedBy` と同じ「毎 render の不変条件」であって
   * 「一度きりの edge」ではないので、貼り直しで一致済みの行が戻ってきても
   * 自己修復する——**この自己修復を保つために、`useEffect` ではなく render
   * 中で直接行う。** `useEffect` に移す形も試したが、コミットの後まで
   * 刈り込みが遅れることで、ストリーミングの2チャンク目が届くより前に
   * 刈り込みが間に合うとは限らなくなり、**`activeReplyKey` を外した変異を
   * 当てても歯が落ちなくなった**（下のテストの変異試験で実際に確認した）。
   * render 中で同期的に行えば、コミットより前に必ず一度は確認される。
   *
   * `previous`（旧い会話・持ち主なしの行）にはここでは触れない ——
   * `pendingOwnLines` が見るのは `ownedBy(lines, shownId)`（いま見ている分）
   * だけであり、直前の会話の分は次にその会話が「いま」になったときに
   * 同じ形で刈られる（`historyLines` がその時点の `shownId` 向けに読み直
   * されるため）。
   *
   * ⚠️ **`settled` の判定に `activeReplyKey` を必ず含める。** 最初は
   * 「`pendingOwnLines` の結果が `ownedBy` と長さで違えば呼ぶ」という荒い
   * 判定にしていたが、それだと「一致した行がちょうど `activeReplyKey`
   * 自身だけ」の render でも毎回 `setLines` を呼んでしまい、中で結局
   * 何も落とさず `previous` をそのまま返す no-op のはずが、**render 中の
   * state 更新として実際に「無限に呼び直される」形になった**（jsdom の
   * 実機で `Too many re-renders` を再現して見つけた）。**呼ぶかどうかの
   * 判定自体に、中で保護する対象（`activeReplyKey`）を含めておかないと、
   * 「呼んでも中で何もしない」はずの render で無限に setState を呼び続ける
   * ことがある**——だから外側の判定と内側の filter は同じ集合（保つ理由）
   * を見るように揃えてある。
   */
  const pendingCurrentKeys = new Set(
    pendingOwnLines(lines, shownId, historyLines, failedTurns).map((line) => line.key),
  );
  const settled = ownedBy(lines, shownId).some(
    (line) => !pendingCurrentKeys.has(line.key) && !activeReplyKeys.has(line.key),
  );
  if (settled) {
    setLines((previous) => {
      const stillPendingKeys = new Set(
        pendingOwnLines(previous, shownId, historyLines, failedTurns).map((line) => line.key),
      );
      const next = previous.filter(
        (line) =>
          line.of !== shownId || stillPendingKeys.has(line.key) || activeReplyKeys.has(line.key),
      );
      return next.length === previous.length ? previous : next;
    });
  }

  /*
   * 履歴（サーバが日誌から再構成したもの）と、この画面で流れてきた分を重ねる。
   *
   * **同じやりとりが両側に載る。** 人間の発言は受理した時点で日誌へ載り
   * （`clone.ts` の `#record`）、クローンの返信もターンの終わりに載る。一方この
   * 画面は送った発言と届いた本文を手元の `lines` にも積んでいるので、履歴を
   * 読み直した瞬間に同じものが2つになる。だから**重ねる時に消す**——照合の
   * 中身（多重集合で突き合わせる理由・id では突き合わせられない理由・NUL を
   * エスケープで書く理由）は `pendingOwnLines`（上）の doc にまとめてある。
   * **表示側（ここ）と、下の `lines` 自体を刈る不変条件チェックの両方が同じ
   * 関数を呼ぶ**ので、突き合わせ方はここではもう定義しない。
   *
   * 進行中の合図（`transient`）と `system` の行は履歴に相当するものが無いので
   * そのまま残る（`role` が一致しないので `pendingOwnLines` の照合対象にも
   * ならない）。
   */
  useEffect(() => {
    historyLinesRef.current = historyLines;
  }, [historyLines]);
  /*
   * 「受信をやめる」で止めた会話の途中の返信行を、履歴がその会話の新しいクローンの発言を
   * 出した時点で畳む（#3761）。止めた時点より履歴のクローン発言が増えていれば、完全な発言が
   * 載ったということ。新しい受信が走っているあいだは、その受信の行を捨てないよう何もしない。
   */
  useEffect(() => {
    if (shownId === undefined) return;
    const baseline = stoppedReplyRef.current.get(shownId);
    if (baseline === undefined) return;
    const running = streamRef.current;
    if (running !== undefined && !running.controller.signal.aborted) {
      stoppedReplyRef.current.delete(shownId);
      return;
    }
    if (historyLines.filter((line) => line.role === 'clone').length <= baseline) return;
    stoppedReplyRef.current.delete(shownId);
    discardUnfinishedReply(shownId);
    // 切れた受信の帯（#4084）。返信が完成して載ったので、「受け取った分だけ」は嘘になる。
    setFailures((prev) => {
      const failure = prev.get(shownId);
      if (!(failure instanceof StreamClosedEarlyError || failure instanceof ReplyCutOffError))
        return prev;
      const next = new Map(prev);
      next.delete(shownId);
      return next;
    });
  }, [historyLines, shownId, discardUnfinishedReply]);
  const all = useMemo(() => {
    const pending = pendingOwnLines(lines, shownId, historyLines, failedTurns);
    // 手元の位置に残したカードは、履歴の側では出さない（二重にしない。#3396）。
    const held = heldApprovalIds(pending);
    return [
      ...historyLines.filter((line) => line.approval === undefined || !held.has(line.approval.id)),
      ...pending,
    ];
  }, [historyLines, lines, shownId, failedTurns]);

  /*
   * **発言ごとの編集の書きかけを `sessionStorage` へ残す（#3707）。** 本文の書きかけ（上）と同じ作法——
   * 入力のたびには書かず `DRAFT_SAVE_DELAY_MS` 間引く／タブを隠す・離れるときは待っている分をすぐ書く／
   * 待つあいだにログアウトされたら書き戻さない（epoch）。元の発言と同じもの（`hasEditDraft` が偽）は残さない。
   * 確定が通った・元のままキャンセルした書きかけは `dropEditDraft` が消す。
   */
  const allRef = useRef<Line[]>([]);
  useEffect(() => {
    allRef.current = all;
  }, [all]);
  /** 鉛筆を押した時点の元の発言（いま画面に無い会話の発言でも、元のままかを見分けるため）。 */
  const editOriginals = useRef(new Map<string, Line>());
  const pendingEditSave = useRef<{ drafts: ReadonlyMap<string, EditDraft>; epoch: number } | null>(
    null,
  );
  const flushEditSave = useCallback(() => {
    const waiting = pendingEditSave.current;
    if (waiting === null) return;
    pendingEditSave.current = null;
    if (waiting.epoch !== chatDraftEpoch()) return;
    for (const [key, saved] of waiting.drafts) {
      const original =
        allRef.current.find((line) => line.key === key) ?? editOriginals.current.get(key);
      // `File` は保存できない。足したファイルの名前だけ残し、再読み込み後に「外れた」と案内する（#3779）。
      const lostNames = [...saved.lost, ...saved.added.map((item) => sizedOf(item).name)];
      saveEditDraft(
        key,
        original !== undefined && !hasEditDraft(saved, original)
          ? undefined
          : {
              text: saved.text,
              attachments: saved.attachments,
              ...(lostNames.length > 0 ? { lostNames } : {}),
            },
      );
    }
  }, []);
  useEffect(() => {
    pendingEditSave.current = { drafts: editDrafts, epoch: chatDraftEpoch() };
    const timer = setTimeout(flushEditSave, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [editDrafts, flushEditSave]);
  useEffect(() => {
    window.addEventListener('pagehide', flushEditSave);
    return () => {
      window.removeEventListener('pagehide', flushEditSave);
      flushEditSave();
    };
  }, [flushEditSave]);

  /*
   * **入力欄へ戻した文の印（`unconfirmed`・`supersedes`・`clientMessageId`）も、本文と一緒に残す（#3708）。**
   * `retries`（メモリ）にしか無いと、再読み込みの後は本文だけが普通の下書きに戻り、「送れたか確かめられなかった」
   * の案内が消えて二重送信や編集の取り違えを誘う。会話ごとに、その会話を初めて見るときに1度だけ読み戻す
   * （本文の書きかけが在るときだけ）。戻したあとは `retries` の変化に合わせて書き直す／消す。
   * 入力欄へ戻せていない（`restored` になる前、または使い手が先に打ち始めていた）文の印は触らない。
   */
  const markTried = useRef(new Set<string | undefined>());
  useEffect(() => {
    const markOf = (
      entry: NonNullable<ReturnType<typeof retries.get>>,
    ): ChatDraftMark | undefined =>
      entry.unconfirmed === undefined && entry.supersedes === undefined
        ? undefined
        : {
            ...attachmentMarkOf(entry),
            ...(entry.clientMessageId === undefined
              ? {}
              : { clientMessageId: entry.clientMessageId }),
            ...(entry.unconfirmed === undefined ? {} : { unconfirmed: true as const }),
            ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
          };
    // 別の会話で積まれて、まだ入力欄へ戻していない文（見ていない会話の中断）。本文と印を先に残す。
    // 入力欄が空でないなら、使い手の書きかけを上書きしない。
    for (const [key, other] of retries) {
      if (key === shownId || other.restored === true) continue;
      const mark = markOf(other);
      if (mark === undefined) continue;
      if (loadChatDraft(key) === '') saveChatDraft(key, other.text);
      saveChatDraftMark(key, mark);
    }
    const entry = retries.get(shownId);
    if (!markTried.current.has(shownId)) {
      markTried.current.add(shownId);
      if (entry === undefined) {
        const text = loadChatDraft(shownId);
        const mark = text === '' ? undefined : loadChatDraftMark(shownId);
        if (mark !== undefined) {
          // すでにサーバにある添付は、実体が無くても戻す（入力欄が空のときだけ。#4069）。
          const carried = carriedAttachments(mark.attachments ?? []);
          if (carried.length > 0)
            setPending((current) => (current.length === 0 ? carried : current));
          setRetries((prev) =>
            prev.has(shownId)
              ? prev
              : new Map(prev).set(shownId, {
                  text,
                  restored: true,
                  inComposer: true,
                  ...(mark.clientMessageId === undefined
                    ? {}
                    : { clientMessageId: mark.clientMessageId }),
                  ...(mark.unconfirmed === undefined ? {} : { unconfirmed: mark.unconfirmed }),
                  ...(mark.supersedes === undefined ? {} : { supersedes: mark.supersedes }),
                  ...(carried.length === 0 ? {} : { attachments: carried }),
                  ...(mark.attachmentCount === undefined
                    ? {}
                    : {
                        lostAttachments: {
                          count: mark.attachmentCount,
                          names: mark.attachmentNames ?? [],
                        },
                      }),
                }),
          );
          return;
        }
      }
    }
    if (entry === undefined) saveChatDraftMark(shownId, undefined);
    else if (entry.restored === true && entry.inComposer === true) {
      saveChatDraftMark(shownId, markOf(entry));
    }
  }, [retries, shownId]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el === null) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    // **会話を切り替えたら、前の会話でどこを読んでいたかは持ち越さない。**
    // `lastSeenShownIdRef` と `shownId` が違えば「今回の実行で会話が変わった」
    // と分かる（他の効果の実行順には依存しない、この効果だけで完結する判定）。
    // 新しい会話は常に最下部から始まる（初回描画と同じ扱いにする）。
    if (lastSeenShownIdRef.current !== shownId) {
      lastSeenShownIdRef.current = shownId;
      isAtBottomRef.current = true;
    }
    if (isAtBottomRef.current || justSentOwnLineRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      // `scrollIntoView` が発火させる `scroll` イベント（延いては上の
      // `handleScroll`）を待たずに確定させる。ストリーミングでチャンクが
      // 立て続けに届くと、イベントが次の効果の実行に間に合わないことがある。
      isAtBottomRef.current = true;
    }
    justSentOwnLineRef.current = false;
  }, [all.length, lines, shownId]);

  /**
   * 別の会話へ移ったら、**前の会話の**ストリームだけを止める。
   *
   * `open` で自分が採番した id へ同期したときは、ストリームの所属も同時に
   * その id へ移してあるので、ここは何もしない（止めると、続く text / done が
   * 画面に出ないまま会話が終わったように見える）。
   *
   * **`shownIdRef.current` の更新と `abort()` は、この1つの効果の中で
   * 同じ同期実行の中にある。** これが下の `owns()`/`stopped()` の関係を
   * 決めている——`owns()` は `shownIdRef.current` を、`stopped()` は
   * `controller.signal.aborted` を見るが、**この効果が走った後は、両方が
   * 同時に切り替わる。** `owns()` が「別の会話へ移った」と言えるようになる
   * 瞬間には、`stopped()` も既に「止まった」と言えるようになっている
   * （順序ではなく同一関数呼び出しの中での事実）。**`owns()` だけを壊しても
   * `stopped()` が代わりに `writable()` を締める、が起きる構造的な理由は
   * ここにある。**
   *
   * 加えて、この効果は React の受動的 effect なので **render の commit より
   * 後に走る**。commit そのもの（`routeId` の変化を見て `setLines([])` を
   * 呼ぶ、上の「捨てる」ブロック）と、この効果が走るまでの短い窓では
   * `shownIdRef.current`・`controller.signal.aborted` のどちらも**まだ
   * 古い値のまま**である。詳細と実測は下の `owns()`/`stopped()` の doc。
   */
  useEffect(() => {
    shownIdRef.current = shownId;
    const stream = streamRef.current;
    if (stream !== undefined && stream.id !== shownId) stream.controller.abort();
  }, [shownId]);

  // 画面を離れたら読むのをやめる（クローンのターンは止まらない。購読を外すだけ）。
  useEffect(() => () => streamRef.current?.controller.abort(), []);

  /** 打った本文を画面へ積む。送信の入口が2つ（新規・追送）あるので1本にしてある。 */
  const showOwnLine = useCallback(
    (
      text: string,
      attachments: readonly MessageAttachment[] | undefined,
      /** 行の持ち主＝**送った先の会話**。いま見ている会話ではない（別の会話へ移ったあとに送ることがある。#3395）。 */
      owner: string | undefined,
      /** この送信に付けた `clientMessageId`。履歴が引き取るかを、本文ではなくこれで見る（#3826）。 */
      clientMessageId: string,
    ) => {
      const key = `h-${ownLineSeqRef.current++}-${text.slice(0, 8)}`;
      // 最下部にいなくても、送った直後だけは追従してよい（上の
      // `justSentOwnLineRef` のコメント参照）。
      justSentOwnLineRef.current = true;
      setLines((previous) => [
        ...previous,
        {
          key,
          role: 'human',
          text,
          of: owner,
          clientMessageId,
          ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
        },
      ]);
      return key;
    },
    [],
  );

  /**
   * **`open` に届く前に送信が失敗したとき、書いた文を使い手へ返す（#3064）。**
   * 吹き出し（`lineKey`）を外し、文を `retries`（キー `key` ＝送った側の会話）へ
   * 積む。入力欄へ戻すのは下の effect — 失敗が届いた時点で見ている会話を
   * `shownIdRef` で当てると、切り替え直後（effect が回る前）の窓で取り違える
   * （#1576）ので、「いま見ている会話のキーに未復元の文があれば戻す」で決める。
   */
  const giveBack = useCallback(
    (
      key: string | undefined,
      text: string,
      lineKey: string,
      supersedes: string | undefined,
      attachments: PendingAttachment[] | undefined,
      clientMessageId: string,
      unconfirmed?: true,
      conversationId?: string,
    ) => {
      setLines((previous) => previous.filter((line) => line.key !== lineKey));
      setRetries((prev) =>
        new Map(prev).set(key, {
          text,
          clientMessageId,
          ...(supersedes === undefined ? {} : { supersedes }),
          ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
          ...(unconfirmed === undefined ? {} : { unconfirmed }),
          ...(conversationId === undefined ? {} : { conversationId }),
        }),
      );
    },
    [],
  );

  // 未復元の文を、その会話を見ているあいだに1度だけ入力欄へ戻す。使い手が
  // もう打ち始めていたら上書きしない（文は「再送」が持っている）。
  useEffect(() => {
    const entry = retries.get(shownId);
    if (entry === undefined || entry.restored === true) return;
    setDraft((current) => (current === '' ? entry.text : current));
    // 添付も同じ扱い（上げ終えたものは `meta` を持つので、再送で二重に上げない）。
    const restoredAttachments = entry.attachments;
    if (restoredAttachments !== undefined) {
      setPending((current) => (current.length === 0 ? restoredAttachments : current));
    }
    // 戻せたか（入力欄が空だったか）。上の2つの更新と同じ判定を、いまの描画の値で数える。
    const inComposer = draft === '' && (restoredAttachments === undefined || pending.length === 0);
    setRetries((prev) => new Map(prev).set(shownId, { ...entry, restored: true, inComposer }));
    // 戻すのは1度きり（`restored`）。`draft` / `pending` を依存に持つのは、戻せたかの判定のため。
  }, [retries, shownId, draft, pending]);

  /**
   * 中断で積んだ文（`unconfirmed`）が履歴に現れたら（その `clientMessageId` を持つ人間の発言が出たら。
   * 本文の一致では見ない、#3203）、
   * サーバは受け取っていた——積んだ文と表示を下ろす（二重送信を誘わない、#3121）。
   * 入力欄は、戻した文のまま（使い手が手を入れていない）ときだけ空にする。
   */
  const unconfirmedEntry = retries.get(shownId);
  const unconfirmedText =
    unconfirmedEntry?.unconfirmed === undefined ? undefined : unconfirmedEntry.text;
  /**
   * 再読み込みで戻せなかった添付の案内。添え直した（実体のあるファイルが入った）ら下ろす。
   * 編集の続きでは、id で戻した添付が入力欄に入るので、`pending` が空かどうかでは見ない（#4069）。
   * `unconfirmed` でない編集の失敗にも出す——確認の枠の中にだけ置くと、案内なしで外した版を送らせる。
   */
  const lostAttachmentsNote = pending.some((item) => item.file !== undefined)
    ? undefined
    : unconfirmedEntry?.lostAttachments;
  /** 入力欄に戻した文が、発言の編集の続きであるときの積んだ中身（#3393）。 */
  const editContinuation =
    unconfirmedEntry?.supersedes !== undefined && unconfirmedEntry.inComposer === true
      ? unconfirmedEntry
      : undefined;
  const unconfirmedSeen =
    unconfirmedEntry?.unconfirmed !== undefined &&
    unconfirmedEntry.clientMessageId !== undefined &&
    hasHumanWithClientMessageId(historyLines, unconfirmedEntry.clientMessageId);
  useEffect(() => {
    if (!unconfirmedSeen || unconfirmedText === undefined) return;
    setRetries((prev) => {
      const next = new Map(prev);
      next.delete(shownId);
      return next;
    });
    setDraft((current) => (current === unconfirmedText ? '' : current));
  }, [unconfirmedSeen, unconfirmedText, shownId]);

  /**
   * **受信中に続けて打った発言を、購読を張らずに投函だけする。**
   *
   * ここが無いと、人間は返事が返るまで次を打てない（入力欄を閉じるしかない）。
   * だが**サーバは、順番待ちのあいだに積み上がった同じ会話の発言を1ターンに
   * まとめて読む**（`packages/core/src/clone.ts` の `#mergedHumanBatch` /
   * `humanTurnText`）。人間が Claude Code に立て続けに3行打ったときと同じ振る舞い
   * がサーバ側には既にあり、**それを引き出せないのは画面の側の都合だけ**だった。
   *
   * **2本目の SSE を張らないのが要点である。** `POST /chat` は投函と購読が一体で、
   * 購読は会話単位（`clone.subscribe`）なので、2本張ると同じ応答が両方に流れて
   * 画面に二度出る。かといって走っている方を止めて張り替えると、止めてから
   * 繋がるまでの隙間に届いた分を取りこぼす。**だから追送は `open` を見た時点で
   * 接続を捨てる** — サーバは `open` を書く前に受信箱へ積んでいる（`app.ts` の
   * `POST /chat`。この順序はあちらのコメントが理由ごと持っている）ので、
   * `open` が届いた＝投函は済んだ、と言い切れる。応答は走っている方に流れてくる。
   */
  const followUp = useCallback(
    /**
     * `supersedes` — この追送が送信済みの人間の発言を編集したものなら、
     * 置き換える対象の日誌エントリ id（チャットのメッセージ編集、#1010）。
     * 通常の追送では渡らない。
     * `draftHandling` — 入力欄の本文の扱い（`DraftHandling`）。
     */
    async (
      text: string,
      running: Stream,
      supersedes?: string,
      draftHandling: DraftHandling = 'clear',
      attachments: PendingAttachment[] = [],
      clientMessageId: string = newClientMessageId(),
    ) => {
      /*
       * **この追送が向かう会話（`running.id`）ぶんの失敗だけを消す（#1585）。**
       * 前回この会話で失敗していても、次に送ろうとしたのだから立て直しの
       * 機会は今回に移る——他の会話のキーは触らないので、別の会話で見えている
       * 失敗はここでは消えない。
       */
      setFailures((prev) => {
        if (!prev.has(running.id)) return prev;
        const next = new Map(prev);
        next.delete(running.id);
        return next;
      });
      setRetries((prev) => {
        if (!prev.has(running.id)) return prev;
        const next = new Map(prev);
        next.delete(running.id);
        return next;
      });
      if (draftHandling === 'clearSent') setDraft((current) => withoutSentText(current, text));
      else if (draftHandling === 'clear') setDraft('');
      const lineKey = showOwnLine(
        text,
        attachments.flatMap((item) => (item.meta === undefined ? [] : [item.meta])),
        running.id,
        clientMessageId,
      );

      try {
        // 新しい会話は `open` まで id が決まらない。決まるまで待ってから投函する
        // （id 無しで送ると、続きのつもりの発言が別の会話として立つ）。
        const conversationId = await running.opened;
        const controller = new AbortController();
        try {
          for await (const message of postChat(
            api,
            {
              text,
              conversationId,
              ...(supersedes === undefined ? {} : { supersedes }),
              attachments: attachmentIds(attachments),
              clientMessageId,
            },
            {
              signal: controller.signal,
            },
          )) {
            if (message.event === 'open') break;
          }
        } finally {
          // `break` でも generator は畳まれるが、本文の読み取りを確実に閉じる。
          controller.abort();
        }
        recordOwnMessage(conversationId, text);
        // 次のターンに回ったかは、最初のターンが終わってから再生の `open` で確かめる（`followUpIdsRef`）。
        const waiting = followUpIdsRef.current.get(conversationId) ?? new Set<string>();
        followUpIdsRef.current.set(conversationId, waiting.add(clientMessageId));
      } catch (caught) {
        /*
         * **投函先の会話 id をキーに積む（#1576 / #1585）。** ここは投函先を
         * 見ずに1つだけの `failure` を立てていた——`ChatPane` は会話を切り替え
         * ても作り直されないので、A で追送を打って B へ切り替えた後に投函が
         * 失敗すると、B の画面に出ていた（#1576）。#1579 でキーを持たせて
         * 「B に出る」は直したが、会話ごとの Map にする前は、切り替えるたびに
         * その1つだけの `failure` を丸ごと消していたので、今度は A に戻っても
         * 出なくなっていた（#1585）。Map なら他の会話のエントリを消さずに済む。
         *
         * `running.id` を読む。`send()` が渡す `running`（＝ `streamRef.current`）
         * は、受信中のメインのストリームが `open` を見た時点で `stream.id` を
         * その場で書き換える（`send` の doc）ので、ここで読む時点の `running.id`
         * は「いま分かっている投函先」を指す——新しい会話でまだ確定していなければ
         * `undefined`。`running.opened` が解決しないまま失敗した場合も、
         * `running.id` は作成時の値（既存の会話ならその id、新しい会話ならまだ
         * `undefined`）のままなので、そのまま使える。**`undefined` キーで積むのは
         * `running.opened` が reject された回（ストリームが `open` を見ないまま
         * 終わった）だけ**で、そのストリームに後から `open` は届かないので、
         * 確定した id へ移す必要は無い（`failures` の doc）。
         */
        setFailures((prev) => new Map(prev).set(running.id, caught));
        // 投函は `open` の前に終わっている（ここへ来るのはそれだけ）。
        const next = afterFailure(caught, attachments, clientMessageId);
        giveBack(running.id, text, lineKey, supersedes, next.attachments, next.clientMessageId);
      }
    },
    [api, recordOwnMessage, showOwnLine, giveBack],
  );

  /**
   * 1本のストリームから届いた出来事を、画面へ書く手（`setTransient` / `apply`）。
   *
   * **`send`（自分の送信）と、画面に戻ったときの再生（下の `useEffect`）が同じ分岐を
   * 共有する。** 別々に書くと、`ask_human` の文面など履歴由来の行と1文字でも違えた
   * 瞬間に、`pendingOwnLines` の照合が当たらず二重に出る。
   * 状態を触るのは安定した setter と ref だけなので、依存は無い。
   */
  const createStreamWriter = useCallback((stream: Stream, controller: AbortController) => {
    /**
     * このストリームの結果を、いま見えている画面へ書いてよいか。
     *
     * **「止まったか」と混ぜてはいけない。** 混ぜると、人間が受信をやめたときに
     * 進行中の合図（考えている… / 実行中…）を片付ける処理まで飛ばしてしまい、
     * 入力欄は戻るのに本文にだけ合図が residue として残り続ける。
     *
     * - `owns()` — まだこの会話を見ている（別の会話へ移っていない）
     * - `stopped()` — 人間が受信をやめた
     *
     * ---
     *
     * **⚠️ #363（変異試験）: `owns()` 単独の効きは、いまの構造では測れない。
     * 「歯が無い」わけではない——測定そのものが成立しない。歯を無理に
     * 生やしてもいない。**
     *
     * 変異試験（`.claude/skills/mutation-testing/`）で `owns()` を
     * `() => true` に固定する変異（`chat-owns-always-true`）を当てると、
     * 既存のテスト（`chat.test.tsx`。#356 で足した、navigate と同じ tick
     * で前の会話のストリームからチャンクが届く回帰テストを含む）が
     * 1本も落ちない（生存）。一方、切り替え時の `setLines([])`
     * （上の「捨てる」ブロック）を消す変異（`chat-discard-setlines-removed`）
     * は、まさにその回帰テストを含む2本を落とす（検出）。
     *
     * **理由は「壁が1枚しか無い」からではない。** 上の切り替え検知の
     * `useEffect`（`shownIdRef.current = shownId; ...abort()...`）の
     * doc に書いたとおり、`shownIdRef.current` の更新と `abort()` は
     * **同じ effect の中で同期している**——`owns()` が「移った」と
     * 言えるようになる瞬間には、`stopped()` も既に「止まった」と
     * 言えるようになっている。だから **その effect が走った後**は、
     * `owns()` を壊しても `stopped()` が `writable()` を締め続ける。
     *
     * **そしてその effect が走る前（render の commit から、この
     * 受動的 effect が走るまでの短い窓）は、`owns()`/`stopped()` の
     * どちらも本物のままで「まだ移っていない」側の値を返す** ——
     * `shownIdRef.current`/`controller.signal.aborted` がまだ更新されて
     * いないため。この窓で `append()`（`text` チャンク）が実際には
     * 漏れないのは、`owns()`/`stopped()` が締めているからではなく、
     * 上の「捨てる」ブロックが**同じ render の中で同期的に** `lines` を
     * `[]` にしていて、`append()` の `findIndex(line => line.key ===
     * replyKey)` が対象を見失い無害な no-op になるからである
     * （`setTransient()` は既存の行を探さず無条件に積むので、この
     * 窓ではこの保護を受けない——これは #363 とは別に見つかった実際の
     * 描画バグとして別途報告する。ここでは「この窓で owns()/stopped()
     * は保護していない」ことの裏付けとしてだけ書く）。
     *
     * **つまり `owns()` が単独で効く窓は、いまの実装には無い。** 効果が
     * 走った後は `stopped()` に隠れ、効果が走る前は `setLines([])` に
     * 隠れる（`append()` の場合）か、そもそも保護されていない
     * （`setTransient()` の場合）。`owns()` を壊しても壊さなくても、
     * 既存のどのテストの結果も変わらない——これは
     * `.claude/skills/mutation-testing/SKILL.md` の生存の4分類のうち
     * **3（テストの構造が観測不能にしている）** であって、2（歯が無い）
     * ではない。**`owns()` を残しているのは、いま測れているからではなく、
     * `stopped()` だけでは説明が付かない前提——`shownIdRef` と
     * `controller` の同期がこの1つの effect に将来も乗り続けるという
     * 前提——が崩れたときの保険であり、その保険の効きは今回の変異試験の
     * 対象にできなかった、というだけである。** 歯を追加で書けば
     * 「この性質は測って確認した」と嘘をつくことになるので、足していない
     * （同 SKILL.md「2 と判断しても、歯を無理に生やさないこと」）。
     */
    const owns = () => stream.id === shownIdRef.current;
    const stopped = () => controller.signal.aborted;
    /** 新しい中身を足してよいのは、見ていて、かつ止めていないときだけ。 */
    const writable = () => owns() && !stopped();

    // クローンの応答は細切れで届く。1行に継ぎ足していく。
    let replyKey: string | undefined;
    /** このストリームが積んだ返信行のキー（settle で `unfinishedReplyRef` から外す）。 */
    const ownReplyKeys = new Set<string>();
    let replyCount = 0;
    const replyGroup = `g-${Date.now()}-${(replyGroupSeq += 1)}`;
    /** このターンの返信行に「失敗・保留」の印を付ける（#3705）。付けるのは1ターンに1度。 */
    const markFailedTurn = (kind: 'failed' | 'held') => {
      const baseline = owns()
        ? historyLinesRef.current.filter((line) => line.turnFailure === kind).length
        : undefined;
      setFailedTurns((previous) =>
        previous.has(replyGroup)
          ? previous
          : new Map(previous).set(replyGroup, { of: stream.id, kind, baseline }),
      );
    };
    /** 返信行を閉じる。次の text は新しい行で始まる（#3593）。 */
    const endReply = () => {
      replyKey = undefined;
    };
    /** 続きの text が来たら、この会話の「〜を実行中…」などの合図を消す。 */
    const dropTransients = (previous: Line[]) =>
      previous.filter((line) => !(line.transient === true && line.of === stream.id));
    const append = (chunk: string) => {
      if (!writable()) return;
      setLines((previous) => {
        const index = previous.findIndex((line) => line.key === replyKey);
        if (index === -1) return previous;
        const next = [...previous];
        const current = next[index];
        if (current === undefined) return previous;
        next[index] = { ...current, text: current.text + chunk, transient: false };
        return next;
      });
    };

    const setTransient = (text: string) => {
      if (!writable()) return;
      setLines((previous) => {
        const withoutTransient = previous.filter((line) => line.transient !== true);
        return [
          ...withoutTransient,
          { key: `t-${Date.now()}`, role: 'system', text, transient: true, of: stream.id },
        ];
      });
    };
    /** 終端まで届いた＝この返信行は確定した。再生の頭出しで捨てる対象から外す。 */
    const settleReply = () => {
      if (stream.id === undefined) return;
      const unfinished = unfinishedReplyRef.current.get(stream.id);
      if (unfinished === undefined) return;
      for (const key of ownReplyKeys) unfinished.delete(key);
      if (unfinished.size === 0) unfinishedReplyRef.current.delete(stream.id);
    };
    const startReply = () => {
      if (replyKey !== undefined) return;
      if (writable()) setLiveNote({ id: stream.id, text: '返信の受信を始めた' });
      replyCount += 1;
      // 同じ ms に2行始まっても衝突しないよう、通し番号を付ける。
      const key = `c-${Date.now()}-${replyCount}`;
      replyKey = key;
      ownReplyKeys.add(key);
      if (stream.id !== undefined) {
        const unfinished = unfinishedReplyRef.current.get(stream.id) ?? new Set<string>();
        unfinished.add(key);
        unfinishedReplyRef.current.set(stream.id, unfinished);
      }
      // `pendingOwnLines` による刈り込みから、この行が完成するまで
      // 守る（`activeReplyKeys` の doc）。
      setActiveReplyKeys((keys) => new Set(keys).add(key));
      setLines((previous) => [
        ...dropTransients(previous),
        { key, role: 'clone', text: '', of: stream.id, replyGroup },
      ]);
    };
    const apply = (event: ChatStreamEvent) => {
      switch (event.type) {
        /*
         * **`queued` は「考えている」ではない。** サーバが言っているのは
         * 「受理したが、まだ順番が来ていない」である（先客のターンが走って
         * いれば、ここで数分待つ）。上の楽観的な「考えている…」は、この画面が
         * 言える範囲＝「送った」までの表示なので、サーバから届いた**より
         * 正確な事実**で上書きする。続けて `thinking` が来たら、そのときに
         * 初めて「考えている…」へ戻る。
         */
        case 'queued':
          setTransient('順番を待っている…');
          break;
        case 'thinking':
          setTransient('考えている…');
          break;
        case 'tool':
          endReply();
          setTransient(`${event.tool} を実行中…`);
          break;
        case 'text':
          startReply();
          append(event.text);
          break;
        // クローンが返信に添えた添付（#4126）。本文より先に来ても、添付だけの返信でも、返信行を起こして載せる
        case 'attachments': {
          startReply();
          const key = replyKey;
          if (!writable() || key === undefined) break;
          setLines((previous) =>
            previous.map((line) =>
              line.key === key
                ? { ...line, attachments: [...(line.attachments ?? []), ...event.attachments] }
                : line,
            ),
          );
          break;
        }
        case 'ask_human':
          endReply();
          setLines((previous) => [
            ...previous.filter((line) => line.transient !== true),
            {
              key: `a-${event.approvalId}`,
              role: 'system',
              of: stream.id,
              text: event.question,
              // 履歴の行と同じカードで出す（承認 id で引き取られる。`lineMatchKey`）。
              approval: approvalFromAskEvent(event.approvalId, event.question),
            },
          ]);
          // 生配信の行は質問しか知らない最小の形なので、台帳から取り直す（#3299）。
          if (owns()) refetchApprovalsRef.current();
          break;
        /*
         * **枠（利用上限）が閉じていて、この合図はモデルへ一度も渡っていない
         * ことを画面に残す。** 終端ではない — 直後に必ず `error` が続く
         * （`schema.ts` の `usage_limited` の doc。送り主を待たせないための
         * 終端で、枠が閉じたこと自体はターンの失敗とは別の事実）。
         *
         * **`setTransient(...)` にしないこと。** transient で出すと、続く
         * `error` はこの行に触れないが、この `switch` の下にある `case 'done'`
         * と、ストリーム終了時の `finally` の両方が `line.transient !== true`
         * で transient な行を残らず消す（filter が2か所ある）。枠が閉じている
         * ことは「そのとき考え中だった」ような一時的な状態ではなく、人間が
         * あとから検索して追うべき事実なので、`ask_human` と同じ**残る行**
         * として積む。
         *
         * 文言は要約しない。`event.message`（`describeUsageNotice()` が作った、
         * SDK 自身の文言をそのまま含む文字列）をそのまま出す — 言い換えると
         * `usage-limits.ts` が約束している「人間が検索できる形」が崩れる。
         * 加えて、この発言は**捨てられておらず**次に届く合図（人間の発言・
         * 自律の発意など）で配り直されて試し直されることを一文添える。ここが
         * 欠けると、人間が「届いていない」と誤解してもう一度同じ発言を
         * 送り直してしまう（すでに保持されている分と重複する）。
         */
        case 'usage_limited':
          endReply();
          markFailedTurn('held');
          setLines((previous) => [
            ...previous.filter((line) => line.transient !== true),
            {
              key: `u-${Date.now()}`,
              role: 'system',
              of: stream.id,
              // 履歴に `held` の知らせが現れたら、返信行と一緒に引き取られる（#3705）。
              replyGroup,
              text: `${redactError(event.message)}\n（この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）`,
            },
          ]);
          break;
        /*
         * **`writable()` では締めない（#1576）。** `append`/`setTransient`
         * と違い、ここは同じ会話の中で一度しか起きない終端の事実であって、
         * 積み足す・差し替える対象の行を持たない——`writable()` で弾いて
         * 握り潰すと、人間に一度も見せないまま消える。**その代わり、下の
         * `conversationId: stream.id` で会話を持たせ、出すかどうかは描画の
         * 時点の `shownId` との突き合わせ（`visibleFailure`）に任せる**
         * （`interruptNotice`/`interruptFailure` と同じ形、#1570）。
         *
         * この形が要る理由: 会話を切り替えたときにストリームを止める効果
         * （`shownIdRef.current = shownId; ...abort()...`）が走るより前——
         * B の画面が commit された直後の窓——に A のこの `error` が届くと、
         * 以前は無条件に `failure` を立てていたので B の画面に A のエラーが
         * 出ていた。
         *
         * **`stream.id` をキーに Map へ積む（#1585）。** 会話ごとに持つので、
         * 切り替えて A に戻っても消えていない——上と同じく出すかどうかは
         * `visibleFailure` が `shownId` で引いて決める。
         */
        case 'error':
          settleReply();
          markFailedTurn('failed');
          setFailures((prev) =>
            new Map(prev).set(stream.id, new TurnFailedError(event.message, event.kind)),
          );
          if (owns()) refetchApprovalsRef.current();
          break;
        case 'done':
          settleReply();
          // 失敗の知らせは Alert が持つので、ここで読むのは正常に終わったときだけ（#3568）。
          if (owns()) setLiveNote({ id: stream.id, text: '返信が終わった' });
          setLines((previous) => previous.filter((line) => line.transient !== true));
          if (owns()) refetchApprovalsRef.current();
          break;
      }
    };
    return { setTransient, apply };
  }, []);

  /**
   * 追送（`followUp`）の投函が済んだ（`open` を見た）発言の `clientMessageId`（会話 id ごと。#4085）。
   * 追送は走っているターンへ流れる前提で購読を捨てるが、サーバのまとめ読みは**ターンが始まる時に受信箱に
   * あった分**だけなので、あとから来た追送は次のターンになり、その出来事を受ける購読者がいない。
   * 最初のターンが終わったあと、これがまだ待っているかを再生の `open` の `pending` で確かめる。
   */
  const followUpIdsRef = useRef(new Map<string, Set<string>>());
  /** いまの取り直し（`replayLoop`）の中断口。会話を離れたとき・次の取り直しを始めるときに畳む。 */
  const replayControllerRef = useRef<AbortController | undefined>(undefined);

  /**
   * 再生の口（`GET /chat/:id/stream`）を1回張って、進行中なら最後まで画面へ流す。
   * `pending` は `open` が運んだ、答えを待っている発言（古いデーモンは無い）。
   * 画面へ流す規則は `useEffect`（下）の doc。
   */
  const replayOnce = useCallback(
    async (id: string, controller: AbortController) => {
      let stream: Stream | undefined;
      let writer: ReturnType<typeof createStreamWriter> | undefined;
      let sawTerminal = false;
      let pending: ChatStreamPending[] | undefined;
      let busy = false;
      let aborted: boolean | undefined;
      try {
        for await (const message of getChatStream(api, id, { signal: controller.signal })) {
          if (message.event === 'open') {
            pending = message.data.pending;
            // 進行中でなくても捨てる。離れている間にターンが終わっていれば、確定した
            // 本文は履歴が出す（途中の行は本文が違うので `pendingOwnLines` に引き取られない）。
            if (!message.data.inProgress) {
              discardUnfinishedReply(id);
              break;
            }
            const current = streamRef.current;
            if (current !== undefined && !current.controller.signal.aborted) {
              busy = true;
              break;
            }
            discardUnfinishedReply(id);
            stream = createStream(controller, id);
            stream.resumeTarget = pickResumeTarget(pending, followUpIdsRef.current.get(id));
            streamRef.current = stream;
            pendingResumeRef.current = undefined;
            setSending(true);
            writer = createStreamWriter(stream, controller);
            writer.setTransient('考えている…');
            continue;
          }
          if (isStreamTerminal(message.data)) sawTerminal = true;
          writer?.apply(message.data);
        }
        aborted = controller.signal.aborted;
        // 再生が終端を見ないまま閉じた（#3564）。始める前（`stream` 無し）は何も見せていないので黙る。
        if (stream !== undefined && !sawTerminal && !aborted) {
          const closedId = stream.id;
          setFailures((prev) => new Map(prev).set(closedId, new StreamClosedEarlyError()));
          markCutOff(closedId);
        }
      } catch {
        aborted = controller.signal.aborted;
        if (!aborted && stream !== undefined) {
          const failedId = stream.id;
          setFailures((prev) => new Map(prev).set(failedId, new ReplyCutOffError()));
          markCutOff(failedId);
        }
      } finally {
        // 途中で抜けた場合（進行中でなかった等）も、接続は閉じておく。
        controller.abort();
        if (pendingResumeRef.current === controller) pendingResumeRef.current = undefined;
        if (stream !== undefined) {
          const ended = stream;
          setLines((previous) =>
            previous.filter((line) => !(line.transient === true && line.of === ended.id)),
          );
          if (streamRef.current === ended) {
            setSending(false);
            streamRef.current = undefined;
            setActiveReplyKeys(NO_REPLY_KEYS);
          }
        }
      }
      return {
        streamed: stream !== undefined,
        terminal: sawTerminal,
        pending,
        busy,
        aborted: aborted === true,
      };
    },
    [api, createStreamWriter, discardUnfinishedReply, markCutOff],
  );

  /**
   * 再生を張り、追送が次のターンに回っているあいだは張り直す（#4085）。画面を開いたときは
   * `followUpIdsRef` が空なので1回で終わる。
   *
   * - 進行中のターンを流し終えたら、追送がまだ残っていれば張り直す（その追送が次のターンのものかは、
   *   新しい `open` の `pending` でしか分からない）。
   * - 進行中でなく、追送が `pending` に居る（`starting`・`queued`・`held`）間は、少し待って張り直す。
   *   再生の口は進行中でなければ `open` だけで閉じるので、ターンが始まるのを購読では待てない。
   *   待つのは上限まで。尽きたら諦める（返信は日誌の更新で履歴に載る）。
   * - `pending` が無い（古いデーモン）なら、確かめる手段が無いので止める。
   */
  const replayLoop = useCallback(
    async (id: string, outer: AbortController) => {
      let waits = 0;
      for (let round = 0; round < REPLAY_MAX_ROUNDS && !outer.signal.aborted; round += 1) {
        const pass = new AbortController();
        const link = () => pass.abort();
        outer.signal.addEventListener('abort', link, { once: true });
        pendingResumeRef.current = pass;
        const result = await replayOnce(id, pass);
        outer.signal.removeEventListener('abort', link);
        if (result.aborted || result.busy || outer.signal.aborted) return;
        const ids = followUpIdsRef.current.get(id);
        if (ids === undefined || ids.size === 0) return;
        if (result.streamed) {
          if (!result.terminal) return;
          waits = 0;
          continue;
        }
        if (result.pending === undefined) {
          ids.clear();
          return;
        }
        const stillWaiting = new Set(result.pending.map((entry) => entry.clientMessageId));
        for (const key of [...ids]) if (!stillWaiting.has(key)) ids.delete(key);
        if (ids.size === 0) return;
        waits += 1;
        if (waits > REPLAY_MAX_WAITS) return;
        const pause = new AbortController();
        pendingResumeRef.current = pause;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(500 * 2 ** (waits - 1), 5000));
          const stop = () => {
            clearTimeout(timer);
            resolve();
          };
          pause.signal.addEventListener('abort', stop, { once: true });
          outer.signal.addEventListener('abort', stop, { once: true });
        });
        if (pendingResumeRef.current === pause) pendingResumeRef.current = undefined;
        if (pause.signal.aborted || outer.signal.aborted) return;
      }
    },
    [replayOnce],
  );

  /** 送信（または再生）が終端で終わったあと、追送が残っていれば取り直しを始める。 */
  const startFollow = useCallback(
    (id: string) => {
      if ((followUpIdsRef.current.get(id)?.size ?? 0) === 0) return;
      replayControllerRef.current?.abort();
      const outer = new AbortController();
      replayControllerRef.current = outer;
      void replayLoop(id, outer);
    },
    [replayLoop],
  );

  /** 入力欄のチップへ渡す形。画像だけ縮小表示の中身を持たせる。 */
  const composerAttachments = useMemo(
    () =>
      pending.map((item) => ({
        key: item.key,
        name: sizedOf(item).name,
        sizeLabel: formatBytes(sizedOf(item).size),
        ...(item.file !== undefined && isPreviewableImage(item.file.type)
          ? { preview: item.file }
          : {}),
      })),
    [pending],
  );

  const send = useCallback(
    /**
     * `options.supersedes` — 送信済みの人間の発言を編集して送り直すときだけ
     * 渡す、置き換える対象の日誌エントリ id（チャットのメッセージ編集、
     * #1010）。渡さない通常の送信では今までどおり `conversationId` だけを
     * 運ぶ。
     */
    async (
      text: string,
      options?: {
        supersedes?: string;
        retry?: boolean;
        attachments?: PendingAttachment[];
        /** 再送のとき、最初の送信で付けた値。無ければ（新しい送信なら）ここで作る。 */
        clientMessageId?: string;
        /** 入力欄の本文の扱い。無ければ、再送・添付を上げて待った送信は `clearSent`、それ以外は `clear`。 */
        draft?: DraftHandling;
        /** 添付を上げるのに失敗して、何も送らずに戻るとき。編集の確定が書きかけを元へ戻す（#3779）。 */
        onUploadFailed?: () => void;
      },
    ) => {
      // 本文が空でも添付があれば送る（サーバも添付のある空本文を受ける）。
      if (text.trim() === '' && (options?.attachments?.length ?? 0) === 0) return;
      const supersedes = options?.supersedes;
      const retry = options?.retry;
      // 待つ前（上げる・会話を引く）に走っていたストリーム。新しい会話の `open` を待つ追送の見分けに使う（下）。
      const streamAtStart = streamRef.current;
      // 上げる・会話を引くために待ったか。待つあいだに別の会話へ移りうる（#3395）。
      let awaited = false;
      // 送るたびに作る。**再送だけは最初の値を使う**（サーバが受け取り済みなら二重に受けない。#3203）。
      const clientMessageId =
        retry === true && options?.clientMessageId !== undefined
          ? options.clientMessageId
          : newClientMessageId();

      /*
       * **新しい会話で `open` の前に中断した送信の後は、会話を取り直してから送る（#3258）。**
       * 中断した送信をサーバが受け取っていると、添付はもう最初の会話に結び付いている。会話 id を知らない
       * まま新しい会話として送ると、`attachment_conflict`（400）で弾かれる。`clientMessageId` で引き、
       * 見つかればその会話へ送る（同じ id の再送は重複の 200、直した本文は新しい id で同じ会話へ）。
       * 404 なら受け取られていないので、今までどおり新しい会話。**引けなかったら、黙って新しい会話として
       * 送らない**——案内を出して送らず、入力は残す（もう一度送ると確かめ直す）。
       */
      let adoptedId: string | undefined;
      if (shownId === undefined) {
        const stashed = retries.get(undefined);
        if (stashed?.conversationId !== undefined) {
          adoptedId = stashed.conversationId;
        } else if (stashed?.unconfirmed !== undefined && stashed.clientMessageId !== undefined) {
          if (lookingUpRef.current) return;
          lookingUpRef.current = true;
          awaited = true;
          try {
            adoptedId = await findConversationByClientMessageId(api, stashed.clientMessageId);
          } catch (caught) {
            setFailures((prev) =>
              new Map(prev).set(
                shownId,
                new Error(
                  `前の送信が受け取られたか確かめられなかった（${redactError(caught instanceof Error ? caught.message : String(caught))}）。もう一度送ると確かめ直す`,
                  { cause: caught },
                ),
              ),
            );
            return;
          } finally {
            lookingUpRef.current = false;
          }
        }
      }

      /*
       * **添付は、何かを消す前に上げる。** 上げるのに失敗したら、書きかけも添付も
       * そのまま残してエラーだけ出す（下書きを消すのは上げ終えた後）。上げ終えたものは
       * `meta` を持って state に残るので、直して送り直しても二重に上げない。
       * 上げているあいだは `uploading` が送信ボタンを止める。
       */
      let attachments = options?.attachments ?? [];
      // 添付を上げて待ったか。待ったなら、そのあいだに入力欄へ足された分が在りうる（#3215）。
      const waitedForUpload = attachments.some((item) => item.meta === undefined);
      if (waitedForUpload) {
        awaited = true;
        adjustUploading(shownId, 1);
        setFailures((prev) => {
          if (!prev.has(shownId)) return prev;
          const next = new Map(prev);
          next.delete(shownId);
          return next;
        });
        const uploaded: PendingAttachment[] = [];
        try {
          for (const item of attachments) {
            const file = item.file;
            if (item.meta !== undefined || file === undefined) {
              uploaded.push(item);
              continue;
            }
            try {
              const meta = await uploadAttachment(api, file, {
                name: file.name,
                type: attachmentMediaType(file),
              });
              uploaded.push({ ...item, meta });
              setPending((current) =>
                current.map((entry) => (entry.key === item.key ? { ...entry, meta } : entry)),
              );
            } catch (caught) {
              throw new Error(
                `${file.name} を上げられなかった: ${redactError(caught instanceof Error ? caught.message : String(caught))}`,
                { cause: caught },
              );
            }
          }
          attachments = uploaded;
        } catch (caught) {
          setFailures((prev) => new Map(prev).set(shownId, caught));
          options?.onUploadFailed?.();
          return;
        } finally {
          adjustUploading(shownId, -1);
        }
      }
      if (attachments.length > 0) {
        const sent = new Set(attachments.map((item) => item.key));
        // 送った分（key）だけ消す。上げているあいだに足された添付は残す（#3215）。
        setPending((current) => current.filter((item) => !sent.has(item.key)));
        /*
         * 上げているあいだに別の会話へ移っていたら、送った添付は移る前の会話の「しまっておいた
         * 添付」に居る（上の `setPending` は、いま見ている会話の添えかけにしか効かない）。
         * そちらからも外す。外さないと、元の会話へ戻ったとき、送り済みの添付が添えかけとして
         * 現れる（#3249）。
         */
        setAttachmentDrafts((previous) => {
          const kept = previous.get(shownId);
          if (kept === undefined || !kept.some((item) => sent.has(item.key))) return previous;
          return new Map(previous).set(
            shownId,
            kept.filter((item) => !sent.has(item.key)),
          );
        });
        setAttachNotice(undefined);
      }

      /*
       * **走っているストリームがあるなら、張り替えずに投函だけする。**
       * `sending` で弾いていた頃は、ここが「返事が返るまで次を打てない」の実体
       * だった（`followUp` の doc に理由）。
       */
      const draftHandling: DraftHandling =
        options?.draft ?? (retry === true || waitedForUpload ? 'clearSent' : 'clear');
      /*
       * **待つあいだに別の会話へ移っていたら、送った先（`shownId`）へ投函だけする（#3395）。**
       * 受信の購読は張らない——張ると、いま見ている会話の画面に「受信中」が立ち、送った発言も
       * 移った先の会話の行として出てしまう。応答は、送った先へ戻ったときの履歴が出す。
       * 行の持ち主も送った先で、入力欄に残した本文（しまってある下書き）からは送った分を取り除く。
       */
      if (awaited && shownId !== undefined && shownIdRef.current !== shownId) {
        await followUp(
          text,
          createStream(new AbortController(), shownId),
          supersedes,
          'keep',
          attachments,
          clientMessageId,
        );
        setDrafts((previous) => {
          const kept = previous.get(shownId);
          if (kept === undefined) return previous;
          const rest = withoutSentText(kept, text);
          return rest === kept ? previous : new Map(previous).set(shownId, rest);
        });
        return;
      }

      /*
       * **新しい会話から送り、待つあいだに別の会話へ移っていたときも同じ（#3766）。** 送り先の
       * 会話はまだ無いので、新しい会話として投函し、`open` で id が決まったら接続を捨てる
       * （`followUp` と同じ。サーバは `open` の前に受信箱へ積む）。受信は張らず、`open` で
       * 画面を奪わない。移った先の入力欄・受信の表示には触れない。送った本文の書きかけ
       * （新しい会話の分）からは送った分を取り除く。
       */
      if (awaited && shownId === undefined && shownIdRef.current !== undefined) {
        setDrafts((previous) => {
          const kept = previous.get(undefined);
          if (kept === undefined) return previous;
          const rest = withoutSentText(kept, text);
          return rest === kept ? previous : new Map(previous).set(undefined, rest);
        });
        const postController = new AbortController();
        let opened = false;
        try {
          for await (const message of postChat(
            api,
            {
              text,
              ...(adoptedId === undefined ? {} : { conversationId: adoptedId }),
              ...(supersedes === undefined ? {} : { supersedes }),
              attachments: attachmentIds(attachments),
              clientMessageId,
            },
            { signal: postController.signal },
          )) {
            if (message.event === 'open') {
              opened = true;
              recordOwnMessage(message.data.conversationId, text);
              break;
            }
          }
          if (!opened) throw new StreamClosedEarlyError();
        } catch (caught) {
          // 投函は `open` の前に終わっている。新しい会話の失敗として積み、戻ったときに文を返す。
          setFailures((prev) => new Map(prev).set(undefined, caught));
          giveBack(
            undefined,
            text,
            '',
            supersedes,
            attachments,
            isClientMessageIdMismatch(caught) ? newClientMessageId() : clientMessageId,
            undefined,
            adoptedId,
          );
        } finally {
          postController.abort();
        }
        return;
      }

      /*
       * **走っているストリームがあっても、送り先の会話のものでなければ追送しない（#3395）。**
       * 別の会話のストリーム（切り替えで止める途中のもの・戻ってきた再生）へ投函すると、その会話へ
       * 届いてしまう。新しい会話（`shownId` が無い）では、送る前から走っていたものだけが自分の続き。
       */
      const running = streamRef.current;
      if (
        running !== undefined &&
        (shownId === undefined ? running === streamAtStart : running.id === shownId)
      ) {
        await followUp(text, running, supersedes, draftHandling, attachments, clientMessageId);
        return;
      }

      // 張りかけの再生があれば畳む（`pendingResumeRef` の doc）。
      pendingResumeRef.current?.abort();
      const controller = new AbortController();
      const stream = createStream(controller, shownId);
      streamRef.current = stream;
      setSending(true);
      setLiveNote(undefined);
      // この会話（`shownId` == `stream.id` の初期値）ぶんの失敗だけを消す（#1585）。
      // followUp と同じ理由——次の送信に立て直しの機会が移るのはこの会話だけ。
      setFailures((prev) => {
        if (!prev.has(shownId)) return prev;
        const next = new Map(prev);
        next.delete(shownId);
        return next;
      });
      setRetries((prev) => {
        if (!prev.has(shownId)) return prev;
        const next = new Map(prev);
        next.delete(shownId);
        return next;
      });
      if (draftHandling === 'clearSent') setDraft((current) => withoutSentText(current, text));
      else if (draftHandling === 'clear') setDraft('');
      const lineKey = showOwnLine(
        text,
        attachments.flatMap((item) => (item.meta === undefined ? [] : [item.meta])),
        shownId,
        clientMessageId,
      );
      stream.turn = { clientMessageId, text, lineKey, supersedes, attachments };
      let opened = false;
      // 終端（`done` / `error` / `usage_limited`）を見たか。見ないまま閉じたら失敗として出す（#3564）。
      let sawTerminal = false;

      const { setTransient, apply } = createStreamWriter(stream, controller);

      /*
       * **送ると決めた瞬間から「考えている…」を出す。サーバの `thinking` を待たない。**
       *
       * 待つと、**待ち時間が長いときにこそ出ない。** クローンは受信箱を一件ずつ
       * 取り出して直列に処理していて（`docs/architecture.md` の同時実行モデル）、
       * `thinking` を送るのは自分のターンが**始まってから**である。先客（蒸留・
       * マネージャーとの往復・自律の起点）が走っているあいだ、こちらの発言は
       * 受信箱で待つだけなので、`thinking` は来ない。**その直列は意図された
       * 設計なので壊さない。** 出せないのは画面の側の都合なので、画面で直す。
       *
       * **サーバは `queued`（積んだ＝順番待ち）を返すが、それも待たない。** ここが
       * 埋めているのは「往復そのものが失敗する」窓（デーモンが応答しない・認証で
       * 弾かれる）で、そのときは `queued` すら来ない。届いたら下の `case 'queued'`
       * がより正確な表示へ差し替える。
       *
       * **これは虚偽表示ではない。** ここが主張しているのは「この画面は発言を
       * 渡して応答を待っている」であって、`sending` が真であるあいだ、それは
       * 実際に起きている。渡すのに失敗すれば `catch` が `failure` を立て、
       * `finally` がこの合図を畳む（＝嘘のまま残らない）。
       *
       * **サーバの `thinking` を受ける経路（下の `case 'thinking'`）は消さない。**
       * あちらは「クローンが実際に入力を受け取ってターンを始めた」という別の事実で、
       * クライアントに言えるのは「送った」までである。2つは別のことを証拠立てて
       * いるので、片方で片方を置き換えない — 後から来たら上書きされるだけ。
       */
      setTransient('考えている…');

      try {
        for await (const message of postChat(
          api,
          {
            text,
            ...(shownId === undefined
              ? adoptedId === undefined
                ? {}
                : { conversationId: adoptedId }
              : { conversationId: shownId }),
            ...(supersedes === undefined ? {} : { supersedes }),
            attachments: attachmentIds(attachments),
            clientMessageId,
          },
          { signal: controller.signal },
        )) {
          if (message.event === 'open') {
            opened = true;
            if (stream.id === undefined) {
              // **順番が大事。** 先にストリームの所属を新しい id へ移してから
              // state を動かす。逆にすると、上の effect がこのストリームを
              // 「前の会話のもの」と見なして止めてしまう。
              stream.id = message.data.conversationId;
              // ref も同時に進める。effect が回るのは描き直しの後なので、
              // それを待つと、その隙間に届いた分が `owns()` に弾かれる。
              shownIdRef.current = stream.id;
              /*
               * **まだ持ち主の無い行に、決まった id を付け直す。** 新しい会話では
               * 送った発言のほうが id より先に画面へ乗るので、ここで揃えないと
               * 「持ち主なし」の行が出なくなる（`ownedBy`）。
               *
               * **これは普通の更新なので、貼り直されても replay されるだけで
               * 消えない**（render の中でやると、貼り直しで無かったことにされる）。
               */
              const settled = stream.id;
              setLines((previous) =>
                previous.some((line) => line.of === undefined)
                  ? previous.map((line) =>
                      line.of === undefined ? { ...line, of: settled } : line,
                    )
                  : previous,
              );
              setShownId(stream.id);
              // URL は後から追いつかせるだけ。作り直しは起きない（key を付けていない）。
              void navigate(`/chat/${stream.id}`, { replace: true });
            }
            // 新規・既存どちらでも、ここで会話 id が確定する。会話一覧が
            // SSE の往復を待たずに動くよう、暫定値で先に反映しておく
            // （`useRecordOwnMessage` のコメントに詳細）。
            recordOwnMessage(message.data.conversationId, text);
            // 追送（`followUp`）は投函先の id をここから受け取る。既に確定して
            // いれば二度目は無視される（`Promise` の resolve は1回きり）。
            stream.settleOpen(message.data.conversationId);
            continue;
          }

          if (isStreamTerminal(message.data)) sawTerminal = true;
          apply(message.data);
        }
        if (!sawTerminal && !controller.signal.aborted) {
          if (opened) {
            // 受け取った分の返信は残す。完成したように見せない。履歴が完成した返信を出したら畳む。
            setFailures((prev) => new Map(prev).set(stream.id, new StreamClosedEarlyError()));
            markCutOff(stream.id);
          } else {
            // 受け取られたか分からない。中断（#3121）と同じ道で文を積む（自動では送らない）。
            giveBack(
              stream.id,
              text,
              lineKey,
              supersedes,
              attachments,
              clientMessageId,
              true,
              stream.id === undefined ? adoptedId : undefined,
            );
          }
        }
      } catch (caught) {
        /*
         * `!controller.signal.aborted` は「人間が受信をやめた／会話を切り替えて
         * 止めた」を除くためのものだが、それだけでは #1576 の窓（効果が走る
         * 前）を締めきれない——ここも `conversationId` を持たせ、`visibleFailure`
         * の突き合わせで二重に守る。
         */
        if (!controller.signal.aborted) {
          setFailures((prev) =>
            new Map(prev).set(stream.id, opened ? new ReplyCutOffError() : caught),
          );
          if (opened) markCutOff(stream.id);
          // サーバが受け取った（`open` を見た）後の失敗は、文を戻さない（二重に送らせない）。
          if (!opened) {
            // 同じ id で中身が違うと 409 になった（#3243）なら、その id は捨てて次の再送で新しく作る。
            const next = afterFailure(caught, attachments, clientMessageId);
            giveBack(
              stream.id,
              text,
              lineKey,
              supersedes,
              next.attachments,
              next.clientMessageId,
              undefined,
              stream.id === undefined ? adoptedId : undefined,
            );
          }
        }
      } finally {
        // `open` の前に中断された（受信をやめる・会話の切り替え）。受け取られたか
        // 分からないので、文は積むだけで自動では送らない（#3121）。
        if (!opened && controller.signal.aborted) {
          giveBack(
            stream.id,
            text,
            lineKey,
            supersedes,
            attachments,
            clientMessageId,
            true,
            stream.id === undefined ? adoptedId : undefined,
          );
        }
        // `open` を一度も見ないまま終わったなら、追送は投函先を持てない。
        // 待たせたままにすると、続けて打った発言が永久に返ってこない
        // （既に確定していれば、この reject は無視される）。
        stream.failOpen(new Error('会話が始まらないまま接続が終わったので、続きを送れなかった'));
        // 進行中の合図は、**まだこの会話を見ているなら必ず**畳む。人間が止めた
        // 場合も畳む対象である（止めた瞬間に「考えている…」で固まらせない）。
        // 見ていない＝別の会話へ移った場合だけ、向こうの内容を触らない。
        /*
         * **自分の会話に積んだ進行中の合図だけを畳む。**
         *
         * 前は `owns()`（まだこの会話を見ているか）で囲っていた。理由は
         * 「見ていない＝別の会話へ移った場合に、向こうの内容を触らない」で、
         * **その理由はいまも正しい。変えたのは絞り方だけである** ——
         * `line.of === stream.id` は「このストリームが積んだ行」だけを指すので、
         * 向こうの内容には最初から届かない。
         *
         * **囲いを外したのは、#437 で `lines` を捨てなくなったからである。**
         * 捨てていた頃は、別の会話へ移れば合図ごと消えていた。いまは残るので、
         * 畳まないと「考えている…」が、その会話へ戻ったときに残ったまま出る。
         */
        setLines((previous) =>
          previous.filter((line) => !(line.transient === true && line.of === stream.id)),
        );
        // 入力欄の状態は会話ではなくこの画面のもの。ただし、切り替えた先で既に
        // 別の送信が始まっているなら、そちらの「受信中」を消さない。
        if (streamRef.current === stream) {
          setSending(false);
          streamRef.current = undefined;
          // このストリームが積んだ返信は、もう `append` から継ぎ足されない
          // （このストリームのやりとりが終わったので）——刈り込みから守る
          // 理由が消えたので、`pendingOwnLines` の対象に戻す。
          setActiveReplyKeys(NO_REPLY_KEYS);
          // 追送が次のターンに回っていれば、その返信を再生の口から取る（#4085）。
          if (sawTerminal && !controller.signal.aborted && stream.id !== undefined) {
            startFollow(stream.id);
          }
        }
      }
    },
    [
      api,
      startFollow,
      adjustUploading,
      shownId,
      retries,
      navigate,
      recordOwnMessage,
      showOwnLine,
      followUp,
      createStreamWriter,
      giveBack,
      markCutOff,
    ],
  );

  /**
   * **「再送」。入力欄の今の中身を送る（#3247）。** 積んでおいた文・添付（`stashed`）を
   * そのまま送らない——戻った文を直したり添付を外したりした後に押すと、直す前の中身が
   * 外したはずの添付つきで届き、直した文は入力欄に残って Enter で二重に届く。
   *
   * - 入力欄の今の中身が積んだものと同じ → 最初の `clientMessageId` で送る（サーバが
   *   受け取り済みなら二重に受けず続きを返す。#3203）
   * - 違う → **新しい `clientMessageId` で、今の中身を送る。** 同じ id で中身を変えると、
   *   サーバが 409 `client_message_id_mismatch` で断る（#3243）ので、そもそも使い回さない
   * - 入力欄が空（本文も添付も）→ 送るものが無いので、積んだものをそのまま送る
   */
  const resend = useCallback(
    (stashed: {
      text: string;
      supersedes?: string;
      attachments?: PendingAttachment[];
      clientMessageId?: string;
      inComposer?: boolean;
    }) => {
      // 入力欄へ戻していない（使い手が先に別の発言を打ち始めていた）なら、入力欄は別物。
      // 積んだ中身をそのまま送り、入力欄には触らない（`send` の `retry`）。
      if (stashed.inComposer !== true || (draft.trim() === '' && pending.length === 0)) {
        void send(stashed.text, { ...stashed, retry: true });
        return;
      }
      if (sameAsStashed(stashed, draft, pending)) {
        void send(draft, { ...stashed, attachments: pending, retry: true });
        return;
      }
      void send(draft, {
        attachments: pending,
        ...(stashed.supersedes === undefined ? {} : { supersedes: stashed.supersedes }),
      });
    },
    [draft, pending, send],
  );

  /**
   * デーモンの添付の上限（#3204。取れなければ `undefined` で、検査は既定値のまま）。
   * `useSWR` が1回だけ取って覚える。
   */
  const { data: attachmentLimits } = useAttachmentLimits();

  /** 入力欄へ添付を足す。個数・大きさは先に検査し、断ったものは理由を出す（最終判定はサーバ）。 */
  const attach = useCallback(
    (files: File[]) => {
      const { accepted, rejected } = checkAttachments(
        pending.map(sizedOf),
        files,
        attachmentLimits,
      );
      if (accepted.length > 0) {
        setPending((current) => [
          ...current,
          ...accepted.map((file) => ({ key: `f-${attachSeqRef.current++}`, file })),
        ]);
      }
      setAttachNotice(
        rejected.length === 0
          ? undefined
          : rejected.map((item) => `${item.name}: ${item.reason}`).join('\n'),
      );
    },
    [pending, attachmentLimits],
  );

  /**
   * **画面に戻ったとき、処理中の会話の途中経過へ戻る**（Issue #2652）。同じタブで別の
   * 画面へ行って戻った・再読み込みした・同じ画面で会話を切り替えて戻った、のどれも
   * ここに来る（アンマウントや切り替えで購読は切れており、`lines` は空から始まる）。
   *
   * - 張るのは `shownId` が確定していて、**自分の送信中のストリームが無い**とき。
   *   新しい会話（`shownId === undefined`）では張らない。`open` で採番して
   *   `shownId` が動いたときも、そのときの送信が `streamRef` を持っているので張らない。
   * - `shownId` が変わったとき・アンマウントのときに abort する（クローンのターンは
   *   止まらない。購読を外すだけ）。
   * - `inProgress: false` のときは何も出さずに閉じる（会話の中身は履歴が持つ）。
   * - `inProgress: true` のときだけ `Stream` として `streamRef` に登録する。**`open` を
   *   見る前に登録しない**——進行中でなかったとき、その間に送った発言が `followUp` に
   *   乗り、応答の流れる先が無くなる。登録後に送った発言は `followUp` になり、
   *   同じ応答が二重に流れない。
   * - `sending` は立てる。受信中の見た目（「受信をやめる」の口）が、再生中にも
   *   本当に効くため。
   * - 受けた出来事は `send` と同じ書き手（`createStreamWriter`）で反映する。
   *   `ask_human` の文面を含め、履歴由来の行と同じなので、履歴を取り直しても
   *   `pendingOwnLines` が引き取って二重にならない。
   * - 失敗は、再生を始めた（`inProgress: true` を見た）後のものだけ出す。始める前
   *   （古いデーモンの 503・繋がらない）は何も見せていないので、履歴側のエラーに任せる。
   */
  useEffect(
    // 送信の後に起こした取り直し（`startFollow`）も、会話を離れたら止める。
    () => () => replayControllerRef.current?.abort(),
    [shownId],
  );
  useEffect(() => {
    if (shownId === undefined) return;
    const existing = streamRef.current;
    if (existing !== undefined && !existing.controller.signal.aborted) return;

    const outer = new AbortController();
    replayControllerRef.current = outer;
    void replayLoop(shownId, outer);
    return () => outer.abort();
  }, [shownId, replayLoop]);

  /**
   * 編集を確定する（チャットのメッセージ編集、#1010）。
   *
   * **`send` をそのまま呼ぶ。** 編集後の発言は「`supersedes` を持つ、会話への
   * 新しい送信」でしかない——サーバ側は日誌へ新しい `exchange` を追記するだけで
   * （旧発言は1件も書き換えない）、置き換えられた側は次にサーバの履歴を読み
   * 直した瞬間（`use-journal-live.ts` の無効化。この発言も他の送信と同じく
   * `queued` の時点で日誌に載るので、既存の無効化がそのまま効く）に既定
   * ビューから消える。ここで先回りして手元の `lines` から古い行を消したり
   * しない——**楽観更新をしない**という `mutations.ts`（`useRecordOwnMessage`
   * の doc）の方針をここでも守る。
   *
   * **対象は常に「いま既定ビューに出ている行」の `journalId`。** 版の切り替え
   * （`viewingVersionIndex`）で古い版を眺めている最中でも、鉛筆は常にその
   * 発言の最新の内容を編集対象にする（下の render が鉛筆クリック時に
   * `editDraft` を最新の `line.text` で初期化し、`viewingVersionIndex` は
   * 触らずに残す——古い版を見ていた状態自体は編集を終えても保たれる）。
   */
  const confirmEdit = useCallback(
    async (line: Line) => {
      const text = editDraft.trim();
      const draft = editDrafts.get(line.key);
      const added = draft?.added ?? [];
      const total = editAttachments.length + added.length;
      if ((text === '' && total === 0) || line.journalId === undefined) return;
      focusIntentRef.current = { kind: 'edit', lineKey: line.key };
      setEditingKey(undefined);
      setEditAttachNotice(undefined);
      // 送る文は送信の側が持つ（失敗すれば入力欄へ編集の続きとして戻る。#3393）。書きかけは消す。
      dropEditDraft(line.key);
      // 引き継ぐ添付は、すでに上げてある（`meta`）ので上げ直さない。足した分は `send` が上げてから送る（#3779）。
      const attachments = [...carriedAttachments(editAttachments), ...added];
      // 入力欄の文を送るのではないので、入力欄の書きかけには触らない（#3391）。
      await send(text, {
        supersedes: line.journalId,
        draft: 'keep',
        attachments,
        // 上げるのに失敗したら何も送られない。書きかけを消したままにせず、編集を開き直して戻す。
        onUploadFailed: () => {
          if (draft !== undefined)
            setEditDrafts((previous) => new Map(previous).set(line.key, draft));
          setEditingKey(line.key);
        },
      });
    },
    [editDraft, editAttachments, editDrafts, send, dropEditDraft],
  );

  /** 編集中の発言へ添付を足す。入力欄と同じ検査に、元の添付と足した分の合計で通す（#3779）。 */
  const attachToEdit = useCallback(
    (key: string, files: File[]) => {
      const current = editDrafts.get(key);
      const { accepted, rejected } = checkAttachments(
        [...carriedAttachments(current?.attachments ?? []), ...(current?.added ?? [])].map(sizedOf),
        files,
        attachmentLimits,
      );
      if (accepted.length > 0) {
        updateEditDraft(key, (draft) => ({
          ...draft,
          added: [
            ...draft.added,
            ...accepted.map((file) => ({ key: `ef-${attachSeqRef.current++}`, file })),
          ],
        }));
      }
      setEditAttachNotice(
        rejected.length === 0
          ? undefined
          : rejected.map((item) => `${item.name}: ${item.reason}`).join('\n'),
      );
    },
    [editDrafts, attachmentLimits, updateEditDraft],
  );

  /**
   * 「ターンを止める」ボタンの押下（#1398 c23-1/c30-2）。
   *
   * **「受信をやめる」（`streamRef.current?.controller.abort()`）とは別物。**
   * あちらはこの画面の購読を切るだけでクローンのターンは走り続けるが
   * （そのボタンの `title` が明言している）、これは `POST /clone/interrupt`
   * を叩いてサーバ側のターンそのものを止めにいく——CLI の `alteroid interrupt`
   * と同じ経路（`useInterruptClone` の doc）。
   *
   * **成功と失敗を別の場所に出す。** 3値（`interrupted`/`idle`/`unsupported`）
   * はどれも「呼べた」ので `interruptNotice` へ、ネットワーク断・403 等の
   * 呼べなかった失敗は `interruptFailure` へ——このパターンは `settings.tsx` の
   * `ResetWorkspace`（成功と失敗の結果表示を分ける）と同じ。
   *
   * **押したときの会話と、応答が返ったときの会話が同じかを確かめる（#1548 /
   * #1570）。** `ChatPane` は会話を切り替えても作り直されない（doc 冒頭）ので、
   * `await interruptClone()` の間に別の会話へ `navigate` されうる。ここは受信中の
   * ストリームとは違って `AbortController` を持たない——止めたいのはサーバ側の
   * ターンそのものであって、切り替えたからといって「止めた」という事実が
   * 消えるわけではないので、リクエスト自体は最後まで送る。**変えるのは
   * 表示だけ。**
   *
   * ⚠️ **#1548 はここを `shownIdRef.current === pressedConversationId`（送った
   * 時点の `shownIdRef.current` を閉じ込め、応答が返った時点の値と比べる）で
   * 直したが、#1570 でその判定が抜けることが分かった。** `shownIdRef.current`
   * は `useEffect(() => { shownIdRef.current = shownId; ... }, [shownId])`
   * （上）という**受動効果の中でしか進まない**。会話を切り替えた render から
   * その効果が走るまでの短い窓があり、窓の中で応答が返ると
   * `shownIdRef.current` はまだ古い会話のままなので、一致判定が誤って真になり
   * 別の会話の画面に前の会話の「止めた」が出ていた（`chat.interrupt.test.tsx`
   * の `act()` で効果を流さずに応答を返す回帰）。
   *
   * **#1570 の直し方: 判定を ref にも効果の順序にも依らせない。** `pressedConversationId`
   * は呼び出し元（下の `onClick`）が**その render で決まっている `shownId`**
   * （state。render の同期処理でしか進まないため、効果を待たずに毎 render
   * 正しい）から直接渡す。応答が返ったら会話 id を必ず `interruptNotice` /
   * `interruptFailure` へ積む——**ここでは出す/出さないを判断しない。**
   * 判断するのは描画する側で、**その描画の時点の `shownId`** と
   * `conversationId` を突き合わせてから出す（下のヘッダー・`ErrorNote` の
   * 読み出し）。ref の更新タイミングに依存する窓がそもそも存在しない——
   * render は常に最新の `shownId` を見るので、いつ effect が走ったかは
   * 関係が無くなる。
   */
  const handleInterrupt = useCallback(
    async (pressedConversationId: string) => {
      setInterrupting({ conversationId: pressedConversationId });
      /*
       * **送信経路の `failures` はここで触らない（#1585）。** 前はここでも
       * `setFailure(undefined)` を呼んで1つだけの `failure` を消していた——
       * 「止める」を押しただけの操作が、無条件に別の会話（送信中に切り替えた
       * 先が B なら A）の「送れていない」まで消していた。
       *
       * **「止める」は「送り直す」ではない。** `send`/`followUp` の冒頭で
       * その会話ぶんの `failures` を消すのは、そこで立て直しの機会が実際に
       * 生まれるからである。`handleInterrupt` はクローンのターンを止める
       * だけで、`pressedConversationId` で送れていない発言を何も変えない
       * ——押した会話の送信失敗が解決したわけでも、再送されたわけでもない。
       * 消す理由が無いので、消さない。
       */
      setInterruptNotice(undefined);
      setInterruptFailure(undefined);
      /*
       * **いま送った発言があれば、それだけを止める対象に渡す（#3956）。** 渡さないと、順番待ちの間に
       * 押しても先客のターン（蒸留・マネージャーとの往復など）を止めてしまう。
       *
       * **再生中（再読み込み・戻ってきた会話）は、自分の発言が手元に無いので、`open.pending` から決めた
       * 発言を対象に渡す（#3990）。** 決められないとき・古いデーモンは、呼ばずに言う（対象を省いた呼びは、
       * 止めてはいけないターンを止めうる）。
       */
      const running = streamRef.current;
      const here =
        running !== undefined && running.id === pressedConversationId ? running : undefined;
      const turn = here?.turn;
      const resumeTarget = here?.resumeTarget;
      if (resumeTarget === null) {
        setInterruptNotice({
          conversationId: pressedConversationId,
          text: '止める対象が分からないので、何も止めていません（走っているのが、この会話の別の起点のターンかもしれません）。',
        });
        setInterrupting(undefined);
        return;
      }
      /*
       * **追送だけが順番待ちで、取り直しを待っている間（受信が無い）は、その追送を対象に渡す（#3990）。**
       * 対象を省くと、走っている先客のターンを止めてしまう。複数あれば先頭（最古）。待っている追送は
       * 取り直しのたびに `pending` で絞られている（`replayLoop`）ので、もう答えた発言が残っていても、
       * 対象を付けた呼びは先客を止めず、outcome が `idle`／`not_target` で返るだけである。
       */
      const followUpTarget =
        turn === undefined && here === undefined
          ? followUpIdsRef.current.get(pressedConversationId)?.values().next().value
          : undefined;
      const targetId = turn?.clientMessageId ?? resumeTarget ?? followUpTarget;
      try {
        const outcome = await interruptClone(
          targetId === undefined
            ? undefined
            : { conversationId: pressedConversationId, clientMessageId: targetId },
        );
        const withdrawnReplay =
          outcome === 'withdrawn' &&
          turn === undefined &&
          (here !== undefined || followUpTarget !== undefined);
        if (outcome === 'withdrawn' && turn === undefined && targetId !== undefined) {
          // 取り下げた追送は、もう取り直しの待ち相手ではない。残りが無ければ取り直しも畳む。
          const waiting = followUpIdsRef.current.get(pressedConversationId);
          if (waiting?.delete(targetId) === true && waiting.size === 0) {
            replayControllerRef.current?.abort();
          }
        }
        if (outcome === 'withdrawn' && turn !== undefined && running !== undefined) {
          // 取り下げた発言の SSE には終端が流れない。閉じないと「順番を待っている…」のまま残る。
          // 文は新しい id で積み直す（同じ id で送ると重複扱いで配られない）。
          running.controller.abort();
          giveBack(
            pressedConversationId,
            turn.text,
            turn.lineKey,
            turn.supersedes,
            turn.attachments,
            newClientMessageId(),
          );
        } else if (withdrawnReplay) {
          // 再生の流れも終端が来ない。本文は手元に無いので入力欄へは戻せない。
          here?.controller.abort();
        }
        setInterruptNotice({
          conversationId: pressedConversationId,
          text: withdrawnReplay
            ? '順番待ちだった発言を取り下げました（送っていません）。本文は手元に無いので、入力欄へは戻していません。先客のターンには触れていません。'
            : describeCloneInterruptOutcome(outcome),
        });
      } catch (caught) {
        setInterruptFailure({ conversationId: pressedConversationId, error: caught });
      } finally {
        setInterrupting(undefined);
      }
    },
    [interruptClone, giveBack],
  );

  /**
   * 「会話を終える」ボタンの押下（Issue #2171）。
   *
   * 直す前は `void endConversation(shownId).then(() => navigate('/chat'));`
   * だけで、失敗（ネットワーク断・403 等）が起きても画面には何も出ず
   * （コンソールに unhandled rejection が残るだけ）、押している間の
   * `loading`/`disabled` も無かったので二度押しで2回撃てた。同じ画面の
   * 「ターンを止める」（`handleInterrupt`、上）・`manager-detail.tsx` の
   * 「停止する」と同じ形（押している間は `loading`/`disabled`、失敗は
   * state へ入れて `ErrorNote`、成功したら今どおり `/chat` へ）に直す。
   *
   * **`navigate('/chat')` は成功したら常に行う（今までどおり）。** issue
   * #2171 が直すのは失敗の可視化と二度押しで、遷移そのものの挙動は変えない
   * ——`handleInterrupt` が押した会話を覚えて遷移を出し分けているのは、
   * あちらは「出すか出さないか」を描画時の `shownId` で判断できる文言
   * 表示だからで、ここは遷移という一度きりの行為なので同じ形は当てはまらない。
   *
   * **失敗（`endFailure`）だけは `interruptFailure` と同じ形で会話 id を
   * 持たせる。** `ChatPane` は会話を切り替えても作り直されないので、応答が
   * 返るより先に別の会話へ切り替えられうる——出すかどうかは描画する側
   * （`visibleEndFailure`）が、その描画の時点の `shownId` と突き合わせて
   * から決める。
   */
  const handleEndConversation = useCallback(
    async (pressedConversationId: string) => {
      // 確認を閉じたあと、押したボタンは読み込み中で戻れない。終わったら戻す先を決めておく（#3595）。
      focusIntentRef.current = { kind: 'end' };
      setEndingConversation({ conversationId: pressedConversationId });
      setEndFailure(undefined);
      setEndNotice(undefined);
      try {
        await endConversation(pressedConversationId);
        // 応答を待つ間に別の会話へ移っていたら、そこにとどまる（#3762）。
        if (shownIdRef.current === pressedConversationId) {
          setEndNotice({ fromId: pressedConversationId });
          navigate('/chat');
        }
      } catch (caught) {
        setEndFailure({ conversationId: pressedConversationId, error: caught });
      } finally {
        setEndingConversation(undefined);
      }
    },
    [endConversation, navigate],
  );

  /**
   * `interruptNotice`/`interruptFailure` を**いま出してよいか**の判断（#1570）。
   *
   * ここだけが判断する場所である——`handleInterrupt` 側はもう判断しない
   * （上の doc）。`shownId` はこの render の同期処理でしか進まない state
   * なので、この比較は常に「この render の時点で正しい」答えを返す。
   */
  const visibleUploading = (uploading.get(shownId) ?? 0) > 0;
  const visibleInterrupting = interrupting !== undefined && interrupting.conversationId === shownId;
  const visibleEnding =
    endingConversation !== undefined && endingConversation.conversationId === shownId;
  /*
   * **フォーカスを戻す（#3595）。** 編集欄・承認カードの押した要素・「会話を終える」の確認は、
   * 閉じる・答える・終えると unmount されるか disabled になり、フォーカスが `document.body` に
   * 落ちる。毎 commit で、戻す先が決まっていて（`focusIntentRef`）フォーカスが失われているときだけ、
   * 戻す。**使い手が自分でフォーカスを動かしたら（pointerdown / keydown。capture で先に見る）、
   * 戻す約束は取り下げる。**
   */
  useEffect(() => {
    const clear = () => {
      focusIntentRef.current = undefined;
    };
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('keydown', clear, true);
    return () => {
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('keydown', clear, true);
    };
  }, []);
  useEffect(() => {
    const intent = focusIntentRef.current;
    if (intent === undefined) return;
    if (intent.kind === 'edit' && editingKey !== undefined) {
      focusIntentRef.current = undefined;
      return;
    }
    if (intent.kind === 'end' && visibleEnding) return;
    const done = applyFocusIntent(intent);
    if (done) focusIntentRef.current = undefined;
  });
  const visibleInterruptNotice =
    interruptNotice !== undefined && interruptNotice.conversationId === shownId
      ? interruptNotice.text
      : undefined;
  const visibleInterruptFailure =
    interruptFailure !== undefined && interruptFailure.conversationId === shownId
      ? interruptFailure.error
      : undefined;
  /**
   * `endFailure` を**いま出してよいか**の判断。`visibleInterruptFailure` と
   * 同じ形——判断するのはここだけで、`handleEndConversation` 側はもう判断しない。
   */
  const visibleEndFailure =
    endFailure !== undefined && endFailure.conversationId === shownId
      ? endFailure.error
      : undefined;
  /**
   * `failures`（送信経路: `send`/`followUp`）から**いま見せている会話ぶんだけ**
   * 引く（#1576 / #1585）。上の2つと同じ形——判断するのはここだけで、
   * `failures` に積む側（`if (message.event === 'error')` の分岐・outer
   * `catch`・`followUp` の `catch`）はもう判断しない。
   *
   * **`failures.has(shownId)` で存在を確かめてから読む。** `caught` は
   * `throw undefined` のような普通ではない例外だと値そのものが `undefined`
   * になりうるので、`failures.get(shownId)` が `undefined` を返しただけでは
   * 「無い」と「積まれている値が `undefined`」を区別できない。
   */
  const visibleFailure = failures.has(shownId) ? failures.get(shownId) : undefined;

  const shownFailure = visibleFailure ?? visibleInterruptFailure ?? visibleEndFailure;
  const hasShownFailure = shownFailure !== undefined && shownFailure !== null;

  /**
   * 「会話を終える」の結果の文を出してよいか（#2759）。終えた直後の新しい会話
   * （`shownId` が無い）だけで出す。**終えた会話とは別の会話へ移ったら捨てる**
   * ——render 時に state を直すのは、この画面の他の箇所（`routeId !== shownId`）と同じ形。
   */
  if (endNotice !== undefined && shownId !== undefined && shownId !== endNotice.fromId) {
    setEndNotice(undefined);
  }
  const visibleEndNotice =
    endNotice !== undefined && shownId === undefined
      ? '会話を終えました。ここまでの学びを記憶にまとめます。終えた会話は左の一覧に残っていて、開けば続きを話せます。'
      : undefined;

  /**
   * 見出しの下の1行（#2760）。会話 id ではなく、見分けに役立つ開始日時と発言数（人間とクローンの発言の合計。畳まれた旧発言は除く）を出す。
   * **遡った窓の中でしか数えていない**（`history.data.reachedStart`）ので、先頭に
   * 届いていないときは「以降」「以上」と言い、実際の開始を言い切らない。
   * 履歴がまだ読めていない間は何も出さない（嘘の数を出さない）。
   */
  const headerSubtitle = (() => {
    const data = history.data;
    if (shownId === undefined || data === undefined) return undefined;
    const visible = (data.messages ?? []).filter((message) => message.supersededBy === undefined);
    const first = visible[0];
    if (first === undefined) return 'まだ発言が無い';
    const startedAt = visible.reduce(
      (earliest, message) => (message.at < earliest ? message.at : earliest),
      first.at,
    );
    const open = data.reachedStart === false;
    return `${formatDateTime(startedAt)}${open ? ' 以降' : ' に開始'} · 発言 ${visible.length} 件${open ? '以上' : ''}`;
  })();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ChatHeader
        conversationId={shownId}
        subtitle={headerSubtitle}
        onOpenList={onOpenList}
        onInterrupt={shownId === undefined ? undefined : () => void handleInterrupt(shownId)}
        interrupting={visibleInterrupting}
        onEnd={shownId === undefined ? undefined : () => void handleEndConversation(shownId)}
        ending={visibleEnding}
        /*
         * 「ターンを止める」の結果（3値のどれか）。呼べなかった失敗
         * （ネットワーク断・403 等）は下の `ErrorNote`（`visibleInterruptFailure`）に
         * 出るので、ここに乗るのは正しく応答が返った場合だけである。**いま出している
         * 会話（`shownId`）が押した時点の会話と一致するときだけ出す**
         * （`visibleInterruptNotice` の doc）。
         */
        notice={visibleInterruptNotice ?? visibleEndNotice}
      />

      {/* 読み上げ専用（#3568）。「受信を始めた／返信が終わった」だけで、本文の流れは読まない。 */}
      <div role="status" className="sr-only">
        {liveNote !== undefined && liveNote.id === shownId ? liveNote.text : ''}
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto py-4 pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]"
      >
        <LeftoverDrafts leftovers={leftovers} onDiscard={discardLeftover} />
        {/*
          **遡り切れていないことを言う。** サーバは人間との往復の新しい方から
          `scan` 件しか見ない（マネージャーとの往復・内部ターンは数えない。
          issue #418）ので、古い会話は「続きがあるのに出ていない」状態になり
          うる。ここが無いと、出ている分が全部だと読める（下の `Empty` は
          「まだ何も話していない」と読めるので、空のときこそ効く）。

          `reachedStart` が真のときは出さない。**窓が先頭に届いているなら、出ている
          分が全部である**ことが言えていて、そこに但し書きを出すと「常に出ている
          もの」になって情報でなくなる。
        */}
        {history.data?.reachedStart === false && (
          <p className="mb-3 text-[11px] text-muted-foreground">
            {`人間との往復を ${history.data.scanned} 件遡ったが、先頭には届いていない。これより古いやりとりが残っている可能性がある。`}
          </p>
        )}
        {/*
          **`history.error` を最優先する（issue #2210）。** `GET
          /conversations/:id` が失敗すると `history.data` は無いままなので、
          直さないと下の判定（Spinner→Empty）が「行が0件」の枝へ落ち、新しい
          会話の案内文（「目的や価値観を伝えると…」）と紛れる——失敗と「本当に
          空」が見分けられない。`dashboard.tsx`/`practice-detail.tsx`
          （issue #2138/#2139、PR #2143）と同じ判断をここでも採る。

          **ただし本文を差し替えるのは、読めた `data` が無いときだけ（issue
          #2266）。** SWR は再検証が失敗しても前回の `data` を残したまま
          `error` を立てるので、`error` だけで分けると、一過性の失敗1回で読めて
          いた履歴と手元の行まで消える。`data` があるときは本文を出したまま、
          失敗は本文の上の注記で知らせる（黙って消さない）。
        */}
        {history.error !== undefined && history.data === undefined ? (
          <ErrorNote error={history.error} className="m-3" />
        ) : (
          <>
            {history.error !== undefined && <ErrorNote error={history.error} className="mb-3" />}
            {conversationApprovals.error !== undefined && (
              // **この会話の承認待ち（`ask_human`）が読めていない（issue
              // #2210）。** `conversationApprovals.data` が無いままだと
              // `historyLines` の `approvalItems` が空になるので、会話の
              // 本文は読めていても確認の質問・回答・取り下げだけが黙って
              // 0件に見える——専用の `ErrorNote` で区別する。本文は読めて
              // いるので、下の Spinner/Empty/ul とは排他にしない。
              <ErrorNote error={conversationApprovals.error} className="mb-3" />
            )}
            {/* 読めない行は `approvals` に入らないので、断らないと確認が無いように見える（#4018）。
                形の違う応答は無いものとして扱い、読めた本文まで巻き込んで落とさない。 */}
            <UnreadableApprovalNote
              unreadable={
                Array.isArray(conversationApprovals.data?.unreadable)
                  ? conversationApprovals.data.unreadable
                  : []
              }
              className="mb-3"
              hint="クローンはこの会話の確認の答えを待っているかもしれない。承認の画面で確かめられる。"
            />
            {/*
              **読み込み中の表示は、見せるものが何も無いときだけ。** この画面で始めた
              会話でも履歴を読むようになったので（上の `useConversation` のコメント）、
              `open` の直後に履歴の取得が始まる。手元に流れてきた分があるのに
              スピナーへ差し替えると、受信中の本文が一度消えてから戻ることになる。
            */}
            {history.isLoading && shownId !== undefined && ownedBy(lines, shownId).length === 0 ? (
              <Spinner label="履歴を読み込み中" />
            ) : all.length === 0 ? (
              <Card>
                <Empty>
                  目的や価値観を伝えると、クローンはそれを記憶に蒸留して次の判断に使う。
                </Empty>
              </Card>
            ) : (
              <ChatMessageList>
                {all.map((line, index) => {
                  /*
                   * **失敗の知らせは返信と別の部品で描く**（サーバが付けた `turnFailure` の印で
                   * 判定する。文面は見ない）。「もう一度送る」は、**いちばん後ろの**失敗で、
                   * **すぐ前が自分の発言**のときだけ出す——承認への回答から起きた失敗（間に確認の
                   * 行が挟まる）では、前の発言が失敗の原因とは限らないので出さない。送信中も出さない。
                   */
                  if (line.approval !== undefined) {
                    const approvalId = line.approval.id;
                    const { question, questions } = line.approval;
                    return (
                      <li
                        key={line.key}
                        data-approval-card={approvalId}
                        data-approval-state={
                          isApprovalWithdrawn(line.approval)
                            ? 'withdrawn'
                            : isApprovalAnswered(line.approval)
                              ? 'answered'
                              : 'unanswered'
                        }
                      >
                        <ApprovalAnswerCard
                          approval={line.approval}
                          showSettledAt
                          draft={approvalDrafts.texts[approvalId] ?? ''}
                          onDraftChange={(text) =>
                            setApprovalDrafts((previous) => ({
                              ...previous,
                              texts:
                                text === ''
                                  ? omitKey(previous.texts, approvalId)
                                  : { ...previous.texts, [approvalId]: text },
                            }))
                          }
                          questionsDraft={
                            approvalDrafts.questions[approvalId] ?? EMPTY_QUESTIONS_DRAFT
                          }
                          onQuestionsDraftChange={(next) =>
                            setApprovalDrafts((previous) => ({
                              ...previous,
                              questions: isEmptyQuestionsDraft(next)
                                ? omitKey(previous.questions, approvalId)
                                : { ...previous.questions, [approvalId]: next },
                            }))
                          }
                          onAnswered={(sent) => {
                            // 押した要素は答えの表示に変わって消える。次の未回答のカードへ戻す（#3595）。
                            focusIntentRef.current = { kind: 'approval', approvalId };
                            // 送った分だけ畳む。送信中に打ち足した分・送らなかった本文は残す（承認の画面と同じ規則）。
                            setApprovalDrafts((previous) =>
                              settleApprovalDraft(previous, approvalId, sent),
                            );
                            setLeftoverSources((previous) => ({
                              ...previous,
                              [approvalId]: {
                                question,
                                questions: questions ?? undefined,
                              },
                            }));
                            void conversationApprovals.mutate();
                          }}
                          hideFailureWhenSettled
                          onFailed={(caught) => {
                            // 409 は回答済み・取り下げ済み。実際の状態へカードを変える（#3827）。
                            if (caught instanceof ApiError && caught.status === 409) {
                              void conversationApprovals.mutate();
                            }
                          }}
                          trailing={
                            <Link
                              to={approvalDetailPath(line.approval.id)}
                              className="mt-3 inline-block text-[11px] text-primary hover:underline"
                            >
                              承認の画面で開く →
                            </Link>
                          }
                        />
                      </li>
                    );
                  }
                  if (line.turnFailure !== undefined) {
                    const previous = index > 0 ? all[index - 1] : undefined;
                    const retryLine =
                      line.turnFailure === 'failed' &&
                      index === all.length - 1 &&
                      !sending &&
                      previous?.role === 'human' &&
                      (previous.text.trim() !== '' || (previous.attachments?.length ?? 0) > 0)
                        ? previous
                        : undefined;
                    return (
                      <ChatTurnFailure
                        key={line.key}
                        kind={line.turnFailure}
                        failureKind={line.turnFailureKind ?? 'other'}
                        action={turnFailureAction}
                        text={line.text}
                        onRetry={
                          retryLine === undefined
                            ? undefined
                            : // 入力欄の文を送るのではないので、書きかけには触らない（#3391）。
                              // 元の発言の添付も付ける（付けないと、返信は添付を読まずに返る、#3566）。
                              () =>
                                void send(retryLine.text, {
                                  draft: 'keep',
                                  attachments: carriedAttachments(retryLine.attachments ?? []),
                                })
                        }
                      />
                    );
                  }
                  /*
                   * **編集の入口（鉛筆）は、本物の日誌エントリ id を持つ人間の
                   * 発言だけに出す（チャットのメッセージ編集、#1010。制約C）。**
                   * `journalId` は `historyLines` にしか付かない（`Line` の doc）
                   * ので、送信直後の楽観行（`pendingOwnLines` が刈る前）には
                   * 出ない——本物の id が無いものを編集の対象にできない、という
                   * 制約をここで自然に満たす。クローンの発言（`role: 'clone'`）は
                   * `role === 'human'` の条件で最初から外れる（サーバ側の 400 と
                   * 同じ制約を、画面側は「そもそも入口を出さない」形で守る）。
                   */
                  const isEditable = line.role === 'human' && line.journalId !== undefined;
                  const isEditing = editingKey === line.key;
                  // `journalId` をこの後何度も参照するので、一度だけ絞り込んでおく
                  // （`versions` / `versionIndex` の「無ければ触らない」の根拠は
                  // すべてこの1つの束縛に依る）。
                  const journalId = line.journalId;
                  const versions =
                    journalId === undefined ? undefined : editVersions.get(journalId);
                  const versionIndex =
                    versions === undefined || journalId === undefined
                      ? undefined
                      : (viewingVersionIndex[journalId] ?? versions.length - 1);
                  const viewing =
                    versions !== undefined && versionIndex !== undefined
                      ? versions[versionIndex]
                      : undefined;
                  // 版を切り替えていれば、その版の本文を出す。切り替えていない
                  // （＝最新を見ている）ときは `viewing.text` も `line.text` と
                  // 同じ値になる（`buildEditVersions` の doc）——常にこちらを
                  // 使っても、版を持たない発言の見え方は1文字も変わらない。
                  const displayedText = viewing?.text ?? line.text;

                  return (
                    <ChatMessage
                      key={line.key}
                      role={line.role}
                      text={displayedText}
                      transient={line.transient}
                      editKey={line.key}
                      onEdit={
                        isEditable
                          ? () => {
                              setEditingKey(line.key);
                              editOriginals.current.set(line.key, line);
                              // 書きかけがあればそこから再開する。無ければ元の本文で始める（#3565）。
                              setEditDrafts((previous) =>
                                previous.has(line.key)
                                  ? previous
                                  : new Map(previous).set(line.key, {
                                      text: line.text,
                                      attachments: [...(line.attachments ?? [])],
                                      added: [],
                                      lost: [],
                                    }),
                              );
                            }
                          : undefined
                      }
                      hasDraft={hasEditDraft(editDrafts.get(line.key), line)}
                      attachments={
                        line.attachments === undefined ? undefined : (
                          <Suspense fallback={null}>
                            <MessageAttachments attachments={line.attachments} />
                          </Suspense>
                        )
                      }
                      versions={
                        versions !== undefined &&
                        versionIndex !== undefined &&
                        journalId !== undefined
                          ? {
                              index: versionIndex,
                              total: versions.length,
                              onPrevious: () =>
                                setViewingVersionIndex((current) => ({
                                  ...current,
                                  [journalId]: versionIndex - 1,
                                })),
                              onNext: () =>
                                setViewingVersionIndex((current) => ({
                                  ...current,
                                  [journalId]: versionIndex + 1,
                                })),
                              hidden: viewing?.hiddenFollowUps,
                            }
                          : undefined
                      }
                    >
                      {isEditing ? (
                        <ChatMessageEditor
                          value={editDraft}
                          onChange={(text) =>
                            updateEditDraft(line.key, (current) => ({ ...current, text }))
                          }
                          attachments={[
                            ...editAttachments.map((attachment) => ({
                              id: attachment.id,
                              name: attachment.name,
                              sizeLabel: formatBytes(attachment.size),
                            })),
                            ...(editDrafts.get(line.key)?.added ?? []).map((item) => ({
                              id: item.key,
                              name: sizedOf(item).name,
                              sizeLabel: formatBytes(sizedOf(item).size),
                            })),
                          ]}
                          onRemoveAttachment={(id) =>
                            updateEditDraft(line.key, (current) => ({
                              ...current,
                              attachments: current.attachments.filter(
                                (attachment) => attachment.id !== id,
                              ),
                              added: current.added.filter((item) => item.key !== id),
                            }))
                          }
                          onAttach={(files) => attachToEdit(line.key, files)}
                          uploading={visibleUploading}
                          notice={
                            [
                              editAttachNotice,
                              (editDrafts.get(line.key)?.lost.length ?? 0) > 0
                                ? `再読み込みで、足していたファイルが外れた（${editDrafts.get(line.key)?.lost.join('、')}）。必要なら足し直す`
                                : undefined,
                            ]
                              .filter((part) => part !== undefined)
                              .join('\n') || undefined
                          }
                          onConfirm={() => void confirmEdit(line)}
                          onCancel={() => {
                            // 閉じるだけで、書きかけは残す（#3565）。元のままなら残す理由が無い。
                            // 外れたファイルの案内（`lost`）は、見せたので閉じたら消す。
                            const current = editDrafts.get(line.key);
                            const settled =
                              current === undefined ? undefined : { ...current, lost: [] };
                            if (!hasEditDraft(settled, line)) {
                              dropEditDraft(line.key);
                            } else if (settled !== undefined && current?.lost.length) {
                              updateEditDraft(line.key, () => settled);
                            }
                            setEditAttachNotice(undefined);
                            focusIntentRef.current = { kind: 'edit', lineKey: line.key };
                            setEditingKey(undefined);
                          }}
                        />
                      ) : undefined}
                    </ChatMessage>
                  );
                })}
              </ChatMessageList>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/*
        `visibleFailure`（送信経路: `send`/`followUp`、会話が一致するときだけ、
        #1576）・`visibleInterruptFailure`（interrupt 由来、同じく会話が
        一致するときだけ、#1570）・`visibleEndFailure`（「会話を終える」由来、
        同じく会話が一致するときだけ、#2171）を同じ枠へ合流させる。3つとも
        同時に立つことは無い想定だが、立っても先勝ちの優先順位そのものに
        強い意味は無い——どれが出ても「何かの失敗が出ている」という事実
        自体は変わらない。
      */}
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => {
          if (visibleUploading) return;
          // 編集の送信が失敗して戻った文は、編集の続きとして送る（`supersedes` を保つ。#3393）。
          if (editContinuation !== undefined) resend(editContinuation);
          else void send(draft, { attachments: pending });
        }}
        editContinuation={
          editContinuation === undefined
            ? undefined
            : {
                onCancel: () =>
                  setRetries((prev) => {
                    const entry = prev.get(shownId);
                    if (entry === undefined) return prev;
                    const next = { ...entry };
                    delete next.supersedes;
                    return new Map(prev).set(shownId, next);
                  }),
              }
        }
        sending={sending}
        uploading={visibleUploading}
        attachments={composerAttachments}
        onAttach={attach}
        onRemoveAttachment={(key) => {
          setPending((current) => current.filter((item) => item.key !== key));
          setAttachNotice(undefined);
        }}
        onStopReceiving={() => {
          const stopping = streamRef.current;
          if (stopping === undefined) return;
          // 止めたあともターンはサーバで続く。途中の返信行は、履歴が新しいクローンの発言を出したら畳む（#3761）。
          if (stopping.id !== undefined && unfinishedReplyRef.current.has(stopping.id)) {
            stoppedReplyRef.current.set(
              stopping.id,
              historyLinesRef.current.filter((line) => line.role === 'clone').length,
            );
          }
          stopping.controller.abort();
        }}
        error={
          /*
           * **3つを排他にしない（#3594）。** 添付を断った理由・送信の失敗・未確認の送信の操作
           * （再送／破棄）は別の事実で、どれかが出ているあいだ他が隠れると、選んだファイルが
           * 理由なく落ちたり、再送／破棄の操作が見えなくなったりする。**並べて出す。**
           */
          attachNotice === undefined &&
          shownLostPending === undefined &&
          lostAttachmentsNote === undefined &&
          unconfirmedText === undefined &&
          !hasShownFailure ? undefined : (
            <div className="flex flex-col gap-2">
              {attachNotice !== undefined && (
                <p role="alert" className="text-xs break-words whitespace-pre-line text-warn">
                  {attachNotice}
                </p>
              )}
              {shownLostPending !== undefined && (
                <div
                  role="status"
                  data-lost-pending-attachments
                  className="flex flex-wrap items-center gap-2 text-xs text-warn"
                >
                  <span>
                    添えていたファイル {shownLostPending.count} 件
                    {shownLostPending.names.length === 0
                      ? ''
                      : `（${shownLostPending.names.join('、')}）`}
                    は戻せませんでした。必要なら添え直す
                  </span>
                  <Button size="sm" variant="ghost" onClick={dismissLostPending}>
                    閉じる
                  </Button>
                </div>
              )}
              {unconfirmedText === undefined && lostAttachmentsNote !== undefined && (
                <p role="status" data-lost-attachments className="text-xs text-warn">
                  添えていたファイル {lostAttachmentsNote.count} 件
                  {lostAttachmentsNote.names.length === 0
                    ? ''
                    : `（${lostAttachmentsNote.names.join('、')}）`}
                  は、再読み込みで戻せなかった。必要なら添え直す。このまま送ると、そのファイルの無い版になる
                </p>
              )}
              {unconfirmedText !== undefined && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    送れたか確かめられなかった。サーバが受け取っていれば会話に出る（二重に送らないよう、確かめてから再送する）
                  </span>
                  {lostAttachmentsNote !== undefined && (
                    <span data-lost-attachments className="basis-full text-warn">
                      添えていたファイル {lostAttachmentsNote.count} 件
                      {lostAttachmentsNote.names.length === 0
                        ? ''
                        : `（${lostAttachmentsNote.names.join('、')}）`}
                      は、再読み込みで戻せなかった。添え直してから再送するか、本文だけで再送する
                    </span>
                  )}
                  <Button
                    size="sm"
                    onClick={() => unconfirmedEntry !== undefined && resend(unconfirmedEntry)}
                  >
                    再送
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRetries((prev) => {
                        const next = new Map(prev);
                        next.delete(shownId);
                        return next;
                      });
                      setDraft((current) => (current === unconfirmedText ? '' : current));
                    }}
                  >
                    破棄
                  </Button>
                </div>
              )}
              {shownFailure === undefined ||
              shownFailure === null ? undefined : shownFailure instanceof TurnFailedError ? (
                <TurnFailureNote
                  kind={shownFailure.failureKind}
                  message={shownFailure.message}
                  action={turnFailureAction}
                />
              ) : (
                <div>
                  <ErrorNote error={shownFailure} />
                  {isAttachmentMissing(shownFailure) && (
                    <p role="alert" className="mt-2 text-xs text-warn">
                      {/* 手元のファイルの分は控えを外してある（#3778）ので、次の送信で上げ直す。引き継いだ添付は上げ直せない。 */}
                      {(() => {
                        const items = retries.get(shownId)?.attachments ?? [];
                        const names = expiredCarriedNames(
                          items,
                          (shownFailure as ApiError).message,
                        );
                        // 名前が多いときは先頭3件と「ほか N 件」にする（長い案内で本題を押し流さないため）
                        const named =
                          names.length === 0
                            ? ''
                            : `（${names.slice(0, 3).join('、')}${names.length > 3 ? ` ほか ${names.length - 3} 件` : ''}）`;
                        if (
                          items.some((item) => item.file !== undefined && item.meta === undefined)
                        ) {
                          return items.some((item) => item.file === undefined)
                            ? `添付が期限切れだった。手元のファイルは次の送信で上げ直す。引き継いだ添付${named}は上げ直せないので、期限切れなら外してから送る。`
                            : '添付が期限切れだった。次の「再送」か送信で、手元のファイルを上げ直す。';
                        }
                        return `添付が期限切れか、サーバに無い${named}。「再送」は同じ添付で送るので、添付を外して付け直してから送る。`;
                      })()}
                    </p>
                  )}
                  {/* 未確認の送信の「再送」が上に出ているときは、同じ再送をもう1つ出さない。 */}
                  {visibleFailure !== undefined &&
                    retries.has(shownId) &&
                    unconfirmedText === undefined && (
                      <Button
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          const stashed = retries.get(shownId);
                          if (stashed !== undefined) resend(stashed);
                        }}
                      >
                        再送
                      </Button>
                    )}
                </div>
              )}
            </div>
          )
        }
      />
    </div>
  );
}
