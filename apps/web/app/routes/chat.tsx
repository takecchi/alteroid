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
  ChatWithdrawnMessage,
  ConversationDeletedNotice,
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
  useDeleteConversation,
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
  ConversationDeleteResult,
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

let replyGroupSeq = 0;
// 厳密一致（scrollTop + clientHeight === scrollHeight）は小数の丸めで成立しないことがあるので余裕を持たせる
const BOTTOM_THRESHOLD_PX = 32;
const NO_REPLY_KEYS: ReadonlySet<string> = new Set();

class TurnFailedError extends Error {
  constructor(
    message: string,
    readonly failureKind: TurnFailureKind,
  ) {
    super(message);
  }
}

const turnFailureAction = (kind: TurnFailureKind) =>
  kind === 'auth' ? (
    <Link to="/tokens" className="text-xs underline underline-offset-2">
      認証トークンの画面を開く
    </Link>
  ) : undefined;

class StreamClosedEarlyError extends Error {
  constructor() {
    super(
      '応答が途中で切れた（done も error も来ないまま接続が閉じた）。出ているのは受け取った分だけ',
    );
  }
}

const REPLAY_MAX_ROUNDS = 40;
const REPLAY_MAX_WAITS = 10;

// 「つながっていない・もう一度試して」と読ませない: 送り直して二重に送らせるため
class ReplyCutOffError extends Error {
  constructor() {
    super(
      '応答の受信が途切れた。発言は受け取り済みなので、送り直さなくてよい。返信は会話に載り次第ここへ出る',
    );
  }
}

function isStreamTerminal(event: ChatStreamEvent): boolean {
  return event.type === 'done' || event.type === 'error' || event.type === 'usage_limited';
}

// lazy にする: 添付のある発言が出たときだけ読み込み、最初の読み込みへ入れない（バンドル予算のため）
const MessageAttachments = lazy(() => import('~/components/message-attachments'));

interface PendingAttachment {
  key: string;
  file?: File;
  meta?: MessageAttachment;
}

const DRAFT_SAVE_DELAY_MS = 400;

function sizedOf(item: PendingAttachment): { name: string; size: number; type: string } {
  return {
    name: item.file?.name ?? item.meta?.name ?? '',
    size: item.file?.size ?? item.meta?.size ?? 0,
    type: item.file?.type ?? item.meta?.mediaType ?? '',
  };
}

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

function attachmentIds(items: readonly PendingAttachment[]): string[] {
  return items.flatMap((item) => (item.meta === undefined ? [] : [item.meta.id]));
}

function carriedAttachments(items: readonly MessageAttachment[]): PendingAttachment[] {
  return items.map((meta) => ({ key: `e-${meta.id}`, meta }));
}

// 前や途中を直したときは全部残す: どこまでが送った分か推測して削ると使い手の編集を失わせる
function withoutSentText(current: string, sent: string): string {
  return current.startsWith(sent) ? current.slice(sent.length) : current;
}

// keep は入力欄に触らない: 触ると、別の発言を書きかけていた入力欄が黙って空になる
type DraftHandling = 'clear' | 'clearSent' | 'keep';

function isAttachmentMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.code === 'attachment_missing';
}

function isClientMessageIdMismatch(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 409 && error.code === 'client_message_id_mismatch'
  );
}

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

// 載っていなければ空にする: 全部の名前を並べると、切れていないものまで疑わせる
function expiredCarriedNames(items: readonly PendingAttachment[], message: string): string[] {
  return items.flatMap((item) =>
    item.file === undefined && item.meta !== undefined && message.includes(item.meta.id)
      ? [item.meta.name]
      : [],
  );
}

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

interface EditDraft {
  text: string;
  attachments: MessageAttachment[];
  added: PendingAttachment[];
  lost: string[];
}

function hasEditDraft(draft: EditDraft | undefined, line: Line): boolean {
  if (draft === undefined) return false;
  if (draft.text !== line.text || draft.added.length > 0 || draft.lost.length > 0) return true;
  const original = line.attachments ?? [];
  return (
    draft.attachments.length !== original.length ||
    draft.attachments.some((item, index) => item.id !== original[index]?.id)
  );
}

interface Line {
  key: string;
  role: 'human' | 'clone' | 'system';
  text: string;
  transient?: boolean;
  // 省略できない形にする: 足し忘れた行が「持ち主なし」として黙って混ざらず、ビルドで落ちるため
  of: string | undefined;
  // 編集の入口を出すかはこの欄の有無だけで決める: role === 'human' だけで判定すると、サーバにまだ無い楽観行にも出る
  // turnFailure は文面では見分けない
  turnFailure?: 'failed' | 'held';
  turnFailureKind?: TurnFailureKind;
  replyGroup?: string;
  journalId?: string;
  attachments?: readonly MessageAttachment[];
  clientMessageId?: string;
  withdrawn?: true;
  approval?: PendingApproval;
}

// 承認のカードは本文ではなく承認 id で結ぶ: 回答で本文は変わらないが状態は変わる
function lineMatchKey(line: Line): string {
  return line.approval !== undefined
    ? `approval\u0000${line.approval.id}`
    : `${line.role}\u0000${line.text}`;
}

function approvalFromAskEvent(approvalId: string, question: string): PendingApproval {
  const now = new Date().toISOString();
  return { id: approvalId, createdAt: now, updatedAt: now, question };
}

// 前の会話の中身を出さない保証はここが持つ。切り替え時に lines を捨てる処理では足りない:
// React が切り替え前の更新を基底から貼り直すと前の会話の lines が丸ごと戻るため。
// filter にとどめる（lines を壊さない）: React は古い props で描き直すことがあり、壊す形だと送ったばかりの発言ごと消える。
export function ownedBy(lines: Line[], shownId: string | undefined): Line[] {
  return lines.filter((line) => line.of === shownId);
}

// 直前の会話も残す: 貼り直しで shownId が一瞬古い値へ戻る回に「いま」だけで刈ると、本物の行まで落ちる。
// of === undefined も残す: 新しい会話では open が届いて of を付け直すまで、送った発言のほうが会話 id より先に画面へ乗る。
// 同じ会話の往復で増える手元の写しは刈らない（issue #446 の筋書き2）。**その刈り込みはこの関数の役目ではなく、pendingOwnLines が持つ。**
export function retainedBy(
  lines: Line[],
  shownId: string | undefined,
  previousShownId: string | undefined,
): Line[] {
  return lines.filter(
    (line) => line.of === undefined || line.of === shownId || line.of === previousShownId,
  );
}

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

// 鉛筆へ戻した直後は false を返す: 確定した発言は置き換わって鉛筆ごと消えることがあり、そのときは入力欄へ戻す
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
  // 戻した後も見張る（false）: 成功すると会話が切り替わって入力欄が作り直されることがある
  if (!isFocusLost()) return false;
  (document.querySelector<HTMLElement>('[data-chat-end]') ?? composerInput())?.focus();
  return false;
}

// 履歴に同じ種類の知らせが増えたら手元のターンを引き取る: 失敗したターンの手元の返信は履歴に当たらず居残り、「もう一度送る」を隠すため
export interface FailedTurn {
  of: string | undefined;
  kind: 'failed' | 'held';
  baseline: number | undefined;
}

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

// 一致が確認できた行だけを落とす: 一致が無ければ理由を問わず残す。履歴の再取得が空を返す窓で、届いたばかりの行を消さないため
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
  // id を持つ手元の人間の行は同じ id の履歴だけが引き取る: 本文だけで見ると、過去の同じ本文（「はい」）がいま送った行を消す
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
  // 分かれた返信は連結した本文で照合する: 日誌はターンの本文を1つの発言として載せるので、行ごとだと二重に出る
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
      // 承認のカードは手元の位置に残す: 履歴の側へ渡すと発言や本文の上に出てしまう。時刻では並べない（手元の行の時刻は端末の時計で、サーバとずれうる）
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

function heldApprovalIds(pending: Line[]): Set<string> {
  const ids = new Set<string>();
  for (const line of pending) if (line.approval !== undefined) ids.add(line.approval.id);
  return ids;
}

// 本文では見ない: 同じ本文の発言が別の経路から届いても取り違えないため
function hasHumanWithClientMessageId(lines: Line[], clientMessageId: string): boolean {
  return lines.some((line) => line.role === 'human' && line.clientMessageId === clientMessageId);
}

export interface EditedVersion {
  text: string;
  hiddenFollowUps: { role: 'human' | 'clone' | 'approval'; text: string }[];
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

function isSettledApproval(approval: PendingApproval): boolean {
  return (
    (approval.answeredAt !== undefined && approval.answeredAt !== null) ||
    (approval.withdrawnAt !== undefined && approval.withdrawnAt !== null)
  );
}

function describeFoldedApproval(approval: PendingApproval): string {
  const settled =
    approval.withdrawnAt !== undefined && approval.withdrawnAt !== null
      ? '（取り下げ済み）'
      : approval.answer
        ? `（回答: ${approval.answer}）`
        : '（回答済み）';
  return `${approval.question}${settled}`;
}

// 畳むかどうかの規則はサーバ（supersededBy）が持つ。ここは承認を見分けるためだけに区間を引く（承認は発言の id を持たないので時刻で当てる）
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

// 畳み込み規則はここで持たない（サーバの computeSupersededIds が持つ。AGENTS.md「畳み込み規則を web 側に再実装しないこと」）。
// 祖先が窓の外へ落ちていたらそこで打ち切る: 遡れない先を捏造しない
export function buildEditVersions(
  messages: ConversationMessage[],
  headId: string,
  approvals: readonly PendingApproval[] = [],
): EditedVersion[] | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const head = byId.get(headId);
  if (head === undefined || head.supersedes === undefined) return undefined;

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

// CLI の describeInterruptOutcome（apps/cli/src/interrupt.ts）と文言を揃えた二重管理: apps 同士はパッケージを共有しない。CLI 側を直したらここも直す
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

  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  const closeList = () => setListOpen(false);

  return (
    <div className="flex h-full">
      {isMobile ? (
        <Drawer open={listOpen} onClose={closeList} label="会話一覧">
          <ConversationList activeId={conversationId} onNavigate={closeList} />
        </Drawer>
      ) : (
        <ConversationList activeId={conversationId} />
      )}
      {/* key を付けない: 新しい会話は受信の途中（open）で id が決まり、作り直しで受信中のストリームが中断される */}
      <ChatPane
        routeId={conversationId}
        onOpenList={isMobile ? () => setListOpen(true) : undefined}
      />
    </div>
  );
}

const CONVERSATION_PAGE_SIZE = 30;

function ConversationList({
  activeId,
  onNavigate,
}: {
  activeId: string | undefined;
  // useEffect で URL の変化を見る形にしない: いま開いている会話をもう一度押すと URL が変わらず、ドロワーが覆ったまま残る
  onNavigate?: (() => void) | undefined;
}) {
  const [pages, setPages] = useState(1);
  const { data, error, isLoading, isValidating, mutate } = useConversations(
    CONVERSATION_PAGE_SIZE,
    { keepPreviousData: true, pages },
  );
  const now = useMinuteNow();
  const loadingMore = pages > 1 && isValidating;
  const moreFailing = pages > 1 && error !== undefined && !isValidating;

  const notes: ReactNode[] = [];
  // 頁を足したあとの scanned は最後の頁の窓の値でしかない: 足し合わせると窓の重なりを二重に数えるため、範囲を言う
  const pagesRead = data?.pagesRead ?? 1;
  if (data !== undefined) {
    notes.push(
      pagesRead > 1
        ? `${pagesRead} 頁ぶんを読んだ（最後の頁の窓は、人間との往復 ${data.scanned} 件を走査）`
        : `人間との往復 ${data.scanned} 件を走査`,
    );
  }
  if (data?.reachedStart === false) {
    notes.push(
      `人間との往復を ${pagesRead > 1 ? `${pagesRead} 頁ぶん` : `${data.scanned} 件`}遡ったが、先頭には届いていない。これより古いやりとりが残っている可能性がある。`,
    );
  }
  if (data?.readStateUnreadable !== undefined) {
    notes.push(
      '既読の記録が読めない。未読の太字と件数は、クローンの発言を全部未読として数えた値で、会話を開いても、記録が読めるようになるまで変わらない。',
    );
  }
  if (data !== undefined && data.hiddenByLimit > 0 && data.nextCursor === undefined) {
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
      unavailable={data === undefined && error !== undefined}
      onRetry={() => void mutate()}
      notes={notes}
      inDrawer={onNavigate !== undefined}
      newConversationTabStop
      renderLink={(target, slot) => (
        <Link
          to={target.id === undefined ? '/chat' : `/chat/${target.id}`}
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

interface Stream {
  controller: AbortController;
  id: string | undefined;
  opened: Promise<string>;
  settleOpen: (conversationId: string) => void;
  failOpen: (reason: unknown) => void;
  // 追送は載せない: 走っているのは先に送った発言のターンで、追送を指すと止めるべきターンを外す
  turn?: {
    clientMessageId: string;
    text: string;
    lineKey: string;
    supersedes: string | undefined;
    attachments: PendingAttachment[];
  };
  resumeTarget?: string | null;
}

// held・queued は選ばない（own を除く）: 走っているターンが pending に無い別の起点のとき、順番待ちを選ぶと別の発言を取り下げてしまう。
// pending を返さない古いデーモンも null（対象を省くと先客のターンを止めうる）
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
  // ここで受けておく: 追送が無いと opened を待つ者は居ないが、open を見ないまま終わると failOpen は呼ばれ、unhandled rejection になる
  opened.catch(() => {});
  const stream: Stream = { controller, id, opened, settleOpen, failOpen };
  if (id !== undefined) settleOpen(id);
  return stream;
}

export function ChatPane({
  routeId,
  onOpenList,
}: {
  routeId: string | undefined;
  onOpenList?: (() => void) | undefined;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const endConversation = useEndConversation();
  const deleteConversation = useDeleteConversation();
  const recordOwnMessage = useRecordOwnMessage();
  const interruptClone = useInterruptClone();

  // URL より先にここが決まる: 新しい会話の id は受信の途中（open）で決まり、URL は後から追いつく。逆にすると追いついた瞬間が「別の会話に変わった」と区別できない
  const [shownId, setShownId] = useState(routeId);
  const [startedHere, setStartedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [lines, setLines] = useState<Line[]>([]);
  const [failedTurns, setFailedTurns] = useState<ReadonlyMap<string, FailedTurn>>(new Map());
  const historyLinesRef = useRef<Line[]>([]);
  const [draft, setDraft] = useState(() => loadChatDraft(routeId));
  // 会話ごとの Map にする: 持たないと、切り替えるたびに他の会話の下書きへ触れずに済ませられない。
  // 送信で空にするのは draft だけでよい。新しい会話で送ると離れるときの鍵は undefined ではなく確定した id に替わるので、入ってくる会話の鍵は読み出した時点で消す（鍵 undefined に送る前の値が残るため）
  const [drafts, setDrafts] = useState<Map<string | undefined, string>>(new Map());
  const [sending, setSending] = useState(false);
  const [approvalDrafts, setApprovalDraftsState] = useState<ApprovalDrafts>(loadApprovalDrafts);
  const approvalDraftsEpoch = useRef(chatDraftEpoch());
  const setApprovalDrafts = useCallback((update: SetStateAction<ApprovalDrafts>) => {
    approvalDraftsEpoch.current = chatDraftEpoch();
    setApprovalDraftsState(update);
  }, []);
  const [leftoverSources, setLeftoverSources] = useState<ApprovalLeftoverSources>(
    loadApprovalLeftoverSources,
  );
  // 会話 id ごとの Map にする: 1つだけ持つと、切り替えのたびに別の会話へ向かう途中の失敗まで消える。
  // キー undefined の失敗を確定した id へ移さない: followUp は open の後にしか投函せず、open を見ないまま終わったストリームに後から open は届かず、サーバは open を最初に書いて error で抜けるため、到達しない
  const [failures, setFailures] = useState<Map<string | undefined, unknown>>(new Map());
  const [retries, setRetries] = useState<
    Map<
      string | undefined,
      {
        text: string;
        supersedes?: string;
        restored?: boolean;
        inComposer?: boolean;
        attachments?: PendingAttachment[];
        clientMessageId?: string;
        // open の前に中断された送信: 本文でも添付でもなく id で見る（同じ本文・同じ添付の別の発言と取り違えない）
        unconfirmed?: true;
        conversationId?: string;
        lostAttachments?: { count: number; names: string[] };
      }
    >
  >(new Map());
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const pendingDraftSave = useRef<{ id: string | undefined; text: string; epoch: number } | null>(
    null,
  );
  const deletedConversationIds = useRef<Set<string | undefined>>(new Set());
  const flushDraftSave = useCallback(() => {
    const waiting = pendingDraftSave.current;
    if (waiting === null) return;
    pendingDraftSave.current = null;
    if (waiting.epoch !== chatDraftEpoch()) return;
    // 削除した会話の書きかけは書き戻さない: 会話を離れる effect が、消したはずの本文を書き直してしまう
    if (deletedConversationIds.current.has(waiting.id)) return;
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
  // 会話 id を持つ: 持たないと、別の会話へ移っても入力欄を塞ぐ
  const [uploading, setUploading] = useState<ReadonlyMap<string | undefined, number>>(new Map());
  const adjustUploading = useCallback((id: string | undefined, delta: 1 | -1) => {
    setUploading((previous) => {
      const next = new Map(previous);
      const count = (next.get(id) ?? 0) + delta;
      if (count > 0) next.set(id, count);
      else next.delete(id);
      return next;
    });
  }, []);
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Map<string | undefined, PendingAttachment[]>
  >(new Map());
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
  // 控えは、この画面が書いた鍵のうち空になったものだけ消す: 読む前に空の状態で消すと案内が出せない
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
  const dismissLostPending = () => {
    savePendingAttachmentsNote(shownId, undefined);
    setLostPending((previous) => {
      const next = new Map(previous);
      next.delete(shownId);
      return next;
    });
  };
  const [attachNotice, setAttachNotice] = useState<string>();
  const attachSeqRef = useRef(0);
  const lookingUpRef = useRef(false);
  // lookingUpRef と共有しない: 共有すると送信が黙って戻る
  const probingRef = useRef(false);
  const probedRef = useRef(new Set<string>());
  const ownLineSeqRef = useRef(0);
  const [interrupting, setInterrupting] = useState<{ conversationId: string } | undefined>(
    undefined,
  );
  // 押した時点の会話 id を持ち、描画の時点の shownId と突き合わせる: shownIdRef は受動効果の中でしか進まず、切り替え直後の窓で別の会話に前の会話の「止めた」を出していた
  const [interruptNotice, setInterruptNotice] = useState<
    { conversationId: string; text: string } | undefined
  >(undefined);
  // 送信経路の failures へ合流させず、会話 id ごとの Map にもしない: 「呼べた」と「呼べなかった」で切り替え後の扱いが割れるため、interruptNotice と同じ「切り替えたら消える」で揃える
  const [interruptFailure, setInterruptFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  const [endingConversation, setEndingConversation] = useState<
    { conversationId: string } | undefined
  >(undefined);
  const [endNotice, setEndNotice] = useState<{ fromId: string } | undefined>(undefined);
  const [endFailure, setEndFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  // deleteResult は消えたあとの /chat に残す（トーストにしない）: 消せなかったものと後始末の失敗は、読んで判断する材料のため
  const [deletingConversation, setDeletingConversation] = useState<
    { conversationId: string } | undefined
  >(undefined);
  const [deleteResult, setDeleteResult] = useState<
    { fromId: string; result: ConversationDeleteResult } | undefined
  >(undefined);
  const [deleteFailure, setDeleteFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  const [editingKey, setEditingKey] = useState<string | undefined>(undefined);
  const focusIntentRef = useRef<FocusIntent | undefined>(undefined);
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
    saveEditDraft(key, undefined);
    setEditDrafts((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  }, []);
  const [liveNote, setLiveNote] = useState<{ id: string | undefined; text: string } | undefined>(
    undefined,
  );
  const [viewingVersionIndex, setViewingVersionIndex] = useState<Record<string, number>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // 測定は onScroll 側で行ってここへ持ち越す: 効果が走る時点では新しい行が既に描かれ scrollHeight が伸びていて、行が来る前の位置は測れない
  const isAtBottomRef = useRef(true);
  const justSentOwnLineRef = useRef(false);
  // 会話の切り替わりを追従の効果自身の中で見分ける: 他の効果の宣言順に依存させないため（ChatPane は切り替えで作り直されず、ref は会話 A の false を持ち越す）
  const lastSeenShownIdRef = useRef(shownId);

  // send は自分のストリームを始めるとき先にこれを畳む: 登録の前に送ると再生と送信の2本が同じ応答を受けて二重に出る
  const pendingResumeRef = useRef<AbortController | undefined>(undefined);

  const streamRef = useRef<Stream | undefined>(undefined);
  // 値は集合: 1本のストリームに返信行は複数ある（ask_human・道具を挟むたびに新しい行）。
  // 再生の open を受けたらこの会話のぶんを捨ててから積む: 前のストリームの途中の行は履歴に無く pendingOwnLines が引き取らないので、再生が頭から積むと二重になる
  const unfinishedReplyRef = useRef(new Map<string, Set<string>>());
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
  // 再生の口での取り直しはしない: 頭から流し直すので、網が落ちている間は張り直しが空回りし、返信は日誌の更新で履歴に載る
  const markCutOff = useCallback((conversationId: string | undefined) => {
    if (conversationId === undefined) return;
    stoppedReplyRef.current.set(
      conversationId,
      historyLinesRef.current.filter((line) => line.role === 'clone').length,
    );
  }, []);
  // 受信の途中からも読める: 後片付けの判断は非同期の奥で、閉じ込めた shownId は古くなっている
  const shownIdRef = useRef(shownId);

  // 刈り込みから除外するために要る: 返信は完成するまで append が同じ key を探して書き換え続け、途中で pendingOwnLines の内容一致が偶然揃って刈られると、以後のチャンクを静かに捨てる（人間の発言は書き換えないので不要）。
  // useRef にしない: 刈り込みの不変条件チェックが render 中にこの値を読み、react-hooks/refs が render 中の ref 読み取りを検出する
  const [activeReplyKeys, setActiveReplyKeys] = useState<ReadonlySet<string>>(NO_REPLY_KEYS);

  // shownId を進める下のブロックでだけ更新する: open では触らない（触る箇所を増やすほど #437 の再発面が広がる）
  const [previousShownId, setPreviousShownId] = useState<string | undefined>(undefined);
  // 見るのは「URL が変わったか」であって「shownId と一致するか」ではない: open で id を決めてから URL が追いつくまでの隙間を「別の会話へ移った」と読み、送ったばかりの発言ごと消してしまう
  const [lastRouteId, setLastRouteId] = useState(routeId);
  if (routeId !== lastRouteId) {
    setLastRouteId(routeId);
    if (routeId !== shownId) {
      setPreviousShownId(shownId);
      setShownId(routeId);
      // ここで lines を捨てない・failures に触れない: この判定は切り替わった瞬間に1回しか真にならず、貼り直しで無かったことにされたり古い props の描き直しで誤って当たったりして、送ったばかりの発言ごと消える。
      // 前の会話の中身を出さないのは ownedBy が持ち、lines が増え続けないのは retainedBy が持つ。failures は会話 id ごとの Map で、消すと A へ戻っても失敗が出せなくなる。
      // 止めた通知・失敗は持ち越さない: 「止める」は会話ごとの操作で、A へ戻ったときに B で押した結果を出し直す理由が無い
      setInterruptNotice(undefined);
      setInterruptFailure(undefined);
      // 入るときに消す（離れるときではなく）: 鍵 undefined は新しい会話全部が共有するので残すと別の白紙の会話に出る。離れるときに消すと、open 後に URL が追いつくだけの遷移でも消しうる
      if (routeId === undefined) {
        setFailures((prev) => {
          if (!prev.has(undefined)) return prev;
          const next = new Map(prev);
          next.delete(undefined);
          return next;
        });
      }
      // 書きかけ（editDrafts）は捨てない
      setEditingKey(undefined);
      setLiveNote(undefined);
      // 読んだ鍵は Map から消す: 残すと、新しい会話（鍵 undefined）で送ったあと、次に新しい会話を開いたとき送ったはずの文章が下書きとして戻る
      setDrafts((previous) => {
        const next = new Map(previous);
        if (!deletedConversationIds.current.has(shownId)) next.set(shownId, draft);
        next.delete(routeId);
        return next;
      });
      setDraft(drafts.get(routeId) ?? loadChatDraft(routeId));
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

  // 一度きりの edge ではなく毎 render 比べる: 貼り直しで前の会話の行が戻っても、次の render で自己修復する
  if (retainedBy(lines, shownId, previousShownId).length !== lines.length) {
    setLines((previous) => {
      const next = retainedBy(previous, shownId, previousShownId);
      return next.length === previous.length ? previous : next;
    });
  }

  // この画面で始めた会話でも履歴を読む（useConversation(null) にしない）: 購読していない画面には無効化が効かず、枠が開いて再試行された遅れた返信が出ないままになる。二重描画は下の all の重ね合わせで防ぐ。
  // includeSuperseded: true で読む: 版の切り替えを組み立てるには畳まれた旧発言も要る。既定ビューの判定は historyLines が supersededBy を見て行う
  const history = useConversation(shownId ?? null, {
    includeSuperseded: true,
    retryOnNotFound: shownId !== undefined && startedHere.has(shownId),
  });
  const conversationMissing =
    history.data === undefined &&
    history.error instanceof ApiError &&
    history.error.status === 404 &&
    shownId !== undefined &&
    !startedHere.has(shownId);

  // exchange だけでは復元できない: ask_human の日誌エントリは conversationId を持たず窓にも入らず、質問・回答は承認の台帳にしか無い
  const conversationApprovals = useConversationApprovals(shownId ?? null);
  // 消すのは、この会話の承認の一覧を読めていて決着済みと分かった id だけ: 読めていないときやほかの会話の書きかけは残す
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
  const refetchApprovalsRef = useRef<() => void>(() => {});
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  refetchApprovalsRef.current = () => {
    if (!mountedRef.current) return;
    try {
      void Promise.resolve(conversationApprovals.mutate()).catch(() => undefined);
    } catch {
      // 同上。
    }
  };

  // history だけを見る（手元の lines や transient は見ない）: 日誌の発言ではないので、返答が日誌に載る前に離れたときも既読になってしまう
  const pageVisible = usePageVisible();
  const markRead = useMarkConversationRead();
  useEffect(() => {
    if (!pageVisible || shownId === undefined || history.data === undefined) return;
    markRead(shownId, history.data);
  }, [pageVisible, shownId, history.data, markRead]);

  // at の文字列比較で並べる: 生成経路はどれも new Date().toISOString()（UTC・ミリ秒3桁・Z 終端）なので、文字列比較がそのまま時刻比較になる。
  // 回答・取り下げも出す: 質問だけ復元すると、回答済みの確認が開き直した瞬間に「まだ返答が無い」に見える
  const historyLines = useMemo<Line[]>(() => {
    const messageItems = (history.data?.messages ?? [])
      .filter((message) => message.supersededBy === undefined)
      .map((message) => ({
        at: message.at,
        line: {
          key: message.id,
          role: message.role === 'inbound' ? ('human' as const) : ('clone' as const),
          text: message.text,
          of: shownId,
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
          ...(message.delivery === 'withdrawn' ? { withdrawn: true as const } : {}),
        },
      }));

    // 未回答は畳まれた区間の中でも常に出す: クローンが答えを待っているので、隠すと答えられない
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

  const editVersions = useMemo(() => {
    const messages = history.data?.messages ?? [];
    const result = new Map<string, EditedVersion[]>();
    for (const message of messages) {
      if (message.role !== 'inbound') continue;
      if (message.supersededBy !== undefined) continue;
      if (message.supersedes === undefined) continue;
      const chain = buildEditVersions(
        messages,
        message.id,
        conversationApprovals.data?.approvals ?? [],
      );
      if (chain !== undefined) result.set(message.id, chain);
    }
    return result;
  }, [history.data, conversationApprovals.data]);

  // useEffect ではなく render 中で行う: コミット後まで遅れると、2チャンク目が届く前に刈り込みが間に合うとは限らず、activeReplyKeys を外しても歯が落ちない。
  // settled の判定にも activeReplyKeys を含める: 外側の判定と内側の filter が同じ集合を見ないと、中で何も落とさない render で setState が無限に呼び直される（Too many re-renders）
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

  useEffect(() => {
    historyLinesRef.current = historyLines;
  }, [historyLines]);
  // 新しい受信が走っているあいだは何もしない: その受信の行を捨てないため
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
    const held = heldApprovalIds(pending);
    return [
      ...historyLines.filter((line) => line.approval === undefined || !held.has(line.approval.id)),
      ...pending,
    ];
  }, [historyLines, lines, shownId, failedTurns]);

  const allRef = useRef<Line[]>([]);
  useEffect(() => {
    allRef.current = all;
  }, [all]);
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
      // File は保存できないので、足したファイルの名前だけ残す
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

  // 印も本文と一緒に残す: retries（メモリ）にしか無いと、再読み込みの後は「送れたか確かめられなかった」の案内が消えて二重送信や編集の取り違えを誘う
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
    if (lastSeenShownIdRef.current !== shownId) {
      lastSeenShownIdRef.current = shownId;
      isAtBottomRef.current = true;
    }
    if (isAtBottomRef.current || justSentOwnLineRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      // scroll イベントを待たずに確定させる: チャンクが立て続けに届くと、イベントが次の効果の実行に間に合わない
      isAtBottomRef.current = true;
    }
    justSentOwnLineRef.current = false;
  }, [all.length, lines, shownId]);

  // shownIdRef の更新と abort() を1つの効果の同期実行の中に置く: owns() と stopped() が同時に切り替わる（片方だけ壊しても、もう片方が writable() を締める）。
  // stream.id が shownId と同じなら止めない: open で採番した id へ同期したときに止めると、続く text / done が出ないまま会話が終わったように見える
  useEffect(() => {
    shownIdRef.current = shownId;
    const stream = streamRef.current;
    if (stream !== undefined && stream.id !== shownId) stream.controller.abort();
  }, [shownId]);

  useEffect(() => () => streamRef.current?.controller.abort(), []);

  const showOwnLine = useCallback(
    (
      text: string,
      attachments: readonly MessageAttachment[] | undefined,
      // 送った先の会話: いま見ている会話ではない（別の会話へ移ったあとに送ることがある）
      owner: string | undefined,
      clientMessageId: string,
    ) => {
      const key = `h-${ownLineSeqRef.current++}-${text.slice(0, 8)}`;
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

  // 入力欄へ戻すのは下の effect: 失敗が届いた時点の会話を shownIdRef で当てると、切り替え直後の窓で取り違える
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

  useEffect(() => {
    const entry = retries.get(shownId);
    if (entry === undefined || entry.restored === true) return;
    setDraft((current) => (current === '' ? entry.text : current));
    const restoredAttachments = entry.attachments;
    if (restoredAttachments !== undefined) {
      setPending((current) => (current.length === 0 ? restoredAttachments : current));
    }
    const inComposer = draft === '' && (restoredAttachments === undefined || pending.length === 0);
    setRetries((prev) => new Map(prev).set(shownId, { ...entry, restored: true, inComposer }));
  }, [retries, shownId, draft, pending]);

  const unconfirmedEntry = retries.get(shownId);
  const unconfirmedText =
    unconfirmedEntry?.unconfirmed === undefined ? undefined : unconfirmedEntry.text;
  // pending が空かどうかでは見ない（編集の続きでは id で戻した添付が入る）。unconfirmed でない編集の失敗にも出す: 確認の枠の中にだけ置くと、案内なしで外した版を送らせる
  const lostAttachmentsNote = pending.some((item) => item.file !== undefined)
    ? undefined
    : unconfirmedEntry?.lostAttachments;
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

  // 実時間の待ちで引き直さない: もう一度引くのは、ページが見えるようになったときと次の送信の冒頭だけ
  const newEntry = retries.get(undefined);
  const probeId =
    newEntry?.unconfirmed !== undefined && newEntry.conversationId === undefined
      ? newEntry.clientMessageId
      : undefined;
  const probeInterrupted = useCallback(
    async (clientMessageId: string) => {
      if (probingRef.current) return;
      probingRef.current = true;
      try {
        const found = await findConversationByClientMessageId(api, clientMessageId);
        if (found === undefined) return;
        setRetries((prev) => {
          const entry = prev.get(undefined);
          if (entry?.clientMessageId !== clientMessageId || entry.conversationId !== undefined) {
            return prev;
          }
          return new Map(prev).set(undefined, { ...entry, conversationId: found });
        });
      } catch {
        // 失敗を案内に足さない。使い手はまだ何も操作しておらず、次の送信が確かめ直して、そこで失敗を出す。
      } finally {
        probingRef.current = false;
      }
    },
    [api],
  );
  useEffect(() => {
    if (probeId === undefined || probedRef.current.has(probeId)) return;
    probedRef.current.add(probeId);
    void probeInterrupted(probeId);
  }, [probeId, probeInterrupted]);
  useEffect(() => {
    if (probeId === undefined) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void probeInterrupted(probeId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [probeId, probeInterrupted]);

  // 入力欄が戻した文のままのときだけ移る: 使い手が書き足した・消した・添付を変えたなら動かさない（書きかけを失わせない）。動かさなくても次の送信は正しい会話へ向かう
  useEffect(() => {
    if (shownId !== undefined) return;
    const entry = newEntry;
    const target = entry?.conversationId;
    if (entry === undefined || target === undefined || entry.unconfirmed === undefined) return;
    if (entry.inComposer !== true || draft !== entry.text) return;
    const carried = entry.attachments ?? [];
    if (pending.length !== carried.length || pending.some((item, i) => item !== carried[i])) return;
    setRetries((prev) => {
      const next = new Map(prev);
      next.delete(undefined);
      next.set(target, { ...entry, inComposer: false });
      return next;
    });
    setDraft('');
    setPending([]);
    void navigate(`/chat/${target}`, { replace: true });
  }, [newEntry, shownId, draft, pending, navigate]);

  // 2本目の SSE を張らない: 購読は会話単位なので2本張ると同じ応答が二度出る。走っている方を張り替えると隙間の分を取りこぼす。
  // だから open を見た時点で接続を捨てる（サーバは open を書く前に受信箱へ積むので、open が届いた＝投函は済んだ）
  const followUp = useCallback(
    async (
      text: string,
      running: Stream,
      supersedes?: string,
      draftHandling: DraftHandling = 'clear',
      attachments: PendingAttachment[] = [],
      clientMessageId: string = newClientMessageId(),
    ) => {
      setInterruptNotice((prev) => (prev?.conversationId === running.id ? undefined : prev));
      setInterruptFailure((prev) => (prev?.conversationId === running.id ? undefined : prev));
      // この追送が向かう会話ぶんの失敗だけを消す: 他の会話のキーは触らない
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
        // id が決まるまで待ってから投函する: id 無しで送ると、続きのつもりの発言が別の会話として立つ
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
          controller.abort();
        }
        recordOwnMessage(conversationId, text);
        const waiting = followUpIdsRef.current.get(conversationId) ?? new Set<string>();
        followUpIdsRef.current.set(conversationId, waiting.add(clientMessageId));
      } catch (caught) {
        // 投函先の会話 id をキーに積む: 1つだけの failure だと、切り替え後に別の会話の画面へ出る
        setFailures((prev) => new Map(prev).set(running.id, caught));
        const next = afterFailure(caught, attachments, clientMessageId);
        giveBack(running.id, text, lineKey, supersedes, next.attachments, next.clientMessageId);
      }
    },
    [api, recordOwnMessage, showOwnLine, giveBack],
  );

  // send と再生が同じ分岐を共有する: 別々に書くと、ask_human の文面など履歴由来の行と1文字でも違えた瞬間に pendingOwnLines の照合が当たらず二重に出る
  const createStreamWriter = useCallback((stream: Stream, controller: AbortController) => {
    // owns() と stopped() を writable() に混ぜない扱い: 「止まったか」と混ぜると、受信をやめたときに進行中の合図を片付ける処理まで飛ばして、本文に合図が残り続ける。
    // owns() は shownIdRef と controller の同期が1つの effect に乗り続ける前提が崩れたときの保険（いまは stopped() が締めるので単独の効きは測れない）
    const owns = () => stream.id === shownIdRef.current;
    const stopped = () => controller.signal.aborted;
    const writable = () => owns() && !stopped();

    let replyKey: string | undefined;
    const ownReplyKeys = new Set<string>();
    let replyCount = 0;
    const replyGroup = `g-${Date.now()}-${(replyGroupSeq += 1)}`;
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
    const endReply = () => {
      replyKey = undefined;
    };
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
      const key = `c-${Date.now()}-${replyCount}`;
      replyKey = key;
      ownReplyKeys.add(key);
      if (stream.id !== undefined) {
        const unfinished = unfinishedReplyRef.current.get(stream.id) ?? new Set<string>();
        unfinished.add(key);
        unfinishedReplyRef.current.set(stream.id, unfinished);
      }
      setActiveReplyKeys((keys) => new Set(keys).add(key));
      setLines((previous) => [
        ...dropTransients(previous),
        { key, role: 'clone', text: '', of: stream.id, replyGroup },
      ]);
    };
    const apply = (event: ChatStreamEvent) => {
      switch (event.type) {
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
              approval: approvalFromAskEvent(event.approvalId, event.question),
            },
          ]);
          if (owns()) refetchApprovalsRef.current();
          break;
        // setTransient にしない: done と finally が transient な行を残らず消すが、枠が閉じたことは人間があとから追うべき事実。
        // 文言は要約しない: event.message をそのまま出さないと usage-limits.ts が約束している「人間が検索できる形」が崩れる。保持されていることを添えないと、人間が「届いていない」と誤解して送り直す
        case 'usage_limited':
          endReply();
          markFailedTurn('held');
          setLines((previous) => [
            ...previous.filter((line) => line.transient !== true),
            {
              key: `u-${Date.now()}`,
              role: 'system',
              of: stream.id,
              replyGroup,
              text: `${redactError(event.message)}\n（この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）`,
            },
          ]);
          break;
        // writable() で締めない: 一度しか起きない終端の事実で、弾くと人間に一度も見せないまま消える。
        // 代わりに stream.id をキーに積み、出すかどうかは描画の時点の shownId で引く（切り替え直後の窓に届いた A の error が B の画面に出ないように）
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
          if (owns()) setLiveNote({ id: stream.id, text: '返信が終わった' });
          setLines((previous) => previous.filter((line) => line.transient !== true));
          if (owns()) refetchApprovalsRef.current();
          break;
      }
    };
    return { setTransient, apply };
  }, []);

  const followUpIdsRef = useRef(new Map<string, Set<string>>());
  const replayControllerRef = useRef<AbortController | undefined>(undefined);

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
            // 進行中でなくても捨てる: 途中の行は本文が違うので pendingOwnLines に引き取られず、確定した本文は履歴が出す
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

  // 待って張り直す: 再生の口は進行中でなければ open だけで閉じるので、ターンが始まるのを購読では待てない。上限で諦める（返信は日誌の更新で履歴に載る）
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
    async (
      text: string,
      options?: {
        supersedes?: string;
        retry?: boolean;
        attachments?: PendingAttachment[];
        clientMessageId?: string;
        draft?: DraftHandling;
        onUploadFailed?: () => void;
        onUploaded?: (key: string, meta: MessageAttachment) => void;
      },
    ) => {
      if (text.trim() === '' && (options?.attachments?.length ?? 0) === 0) return;
      const supersedes = options?.supersedes;
      const retry = options?.retry;
      const streamAtStart = streamRef.current;
      let awaited = false;
      // 再送だけは最初の値を使う: サーバが受け取り済みなら二重に受けない
      const clientMessageId =
        retry === true && options?.clientMessageId !== undefined
          ? options.clientMessageId
          : newClientMessageId();

      // 新しい会話で open の前に中断した送信の後は会話を取り直してから送る: 受け取り済みなら添付は最初の会話に結び付いていて、会話 id を知らないまま新しい会話として送ると attachment_conflict（400）で弾かれる。
      // 引けなかったら黙って新しい会話として送らず、案内を出して入力は残す
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

      // 添付は何かを消す前に上げる: 失敗したら書きかけも添付もそのまま残す
      let attachments = options?.attachments ?? [];
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
              options?.onUploaded?.(item.key, meta);
              setPending((current) =>
                current.map((entry) => (entry.key === item.key ? { ...entry, meta } : entry)),
              );
              // しまっておいた添付にも印を書く: 別の会話へ移っていると上の setPending は効かず、後の失敗で戻ったとき上げ終えた分を上げ直す
              setAttachmentDrafts((previous) => {
                const kept = previous.get(shownId);
                if (kept === undefined || !kept.some((entry) => entry.key === item.key)) {
                  return previous;
                }
                return new Map(previous).set(
                  shownId,
                  kept.map((entry) => (entry.key === item.key ? { ...entry, meta } : entry)),
                );
              });
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
        // 送った分（key）だけ消す: 上げているあいだに足された添付は残す
        setPending((current) => current.filter((item) => !sent.has(item.key)));
        // しまっておいた添付からも外す: 外さないと、元の会話へ戻ったとき送り済みの添付が添えかけとして現れる
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

      const draftHandling: DraftHandling =
        options?.draft ?? (retry === true || waitedForUpload ? 'clearSent' : 'clear');
      // 待つあいだに別の会話へ移っていたら、送った先へ投函だけする: 購読を張ると、いま見ている会話の画面に「受信中」が立ち、送った発言も移った先の会話の行として出てしまう
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

      // 新しい会話から送って別の会話へ移っていたときも同じ: open で id が決まったら接続を捨て、受信は張らず open で画面を奪わない
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

      // 送り先の会話のものでなければ追送しない: 別の会話のストリームへ投函すると、その会話へ届いてしまう
      const running = streamRef.current;
      if (
        running !== undefined &&
        (shownId === undefined ? running === streamAtStart : running.id === shownId)
      ) {
        await followUp(text, running, supersedes, draftHandling, attachments, clientMessageId);
        return;
      }

      pendingResumeRef.current?.abort();
      const controller = new AbortController();
      const stream = createStream(controller, shownId);
      streamRef.current = stream;
      setSending(true);
      setLiveNote(undefined);
      setInterruptNotice((prev) => (prev?.conversationId === shownId ? undefined : prev));
      setInterruptFailure((prev) => (prev?.conversationId === shownId ? undefined : prev));
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
      let sawTerminal = false;

      const { setTransient, apply } = createStreamWriter(stream, controller);

      // 送ると決めた瞬間から「考えている…」を出す。サーバの thinking も queued も待たない: 先客のターンが走っているあいだは thinking が来ず、往復そのものが失敗する窓では queued すら来ない。届いたら case 'queued' / 'thinking' が差し替える
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
              // 先にストリームの所属を新しい id へ移してから state を動かす: 逆にすると、上の effect がこのストリームを「前の会話のもの」と見なして止める
              stream.id = message.data.conversationId;
              // ref も同時に進める: effect を待つと、その隙間に届いた分が owns() に弾かれる
              shownIdRef.current = stream.id;
              // render の中ではなく普通の更新で付け直す: render の中だと貼り直しで無かったことにされる
              const settled = stream.id;
              setLines((previous) =>
                previous.some((line) => line.of === undefined)
                  ? previous.map((line) =>
                      line.of === undefined ? { ...line, of: settled } : line,
                    )
                  : previous,
              );
              setShownId(stream.id);
              const startedId = stream.id;
              setStartedHere((previous) => new Set(previous).add(startedId));
              void navigate(`/chat/${stream.id}`, { replace: true });
            }
            recordOwnMessage(message.data.conversationId, text);
            stream.settleOpen(message.data.conversationId);
            continue;
          }

          if (isStreamTerminal(message.data)) sawTerminal = true;
          apply(message.data);
        }
        if (!sawTerminal && !controller.signal.aborted) {
          if (opened) {
            setFailures((prev) => new Map(prev).set(stream.id, new StreamClosedEarlyError()));
            markCutOff(stream.id);
          } else {
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
        // aborted の除外だけでは、効果が走る前の窓を締めきれない: visibleFailure の突き合わせで二重に守る
        if (!controller.signal.aborted) {
          setFailures((prev) =>
            new Map(prev).set(stream.id, opened ? new ReplyCutOffError() : caught),
          );
          if (opened) markCutOff(stream.id);
          // open を見た後の失敗は文を戻さない: 二重に送らせない
          if (!opened) {
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
        // 受け取られたか分からないので、文は積むだけで自動では送らない
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
        // 待たせたままにすると、続けて打った発言が永久に返ってこない（open を見ないまま終わると追送は投函先を持てない）
        stream.failOpen(new Error('会話が始まらないまま接続が終わったので、続きを送れなかった'));
        // owns() で囲わず line.of === stream.id で絞る: lines を捨てなくなったので、畳まないと別の会話へ移った後、戻ったときに「考えている…」が残ったまま出る
        setLines((previous) =>
          previous.filter((line) => !(line.transient === true && line.of === stream.id)),
        );
        // 切り替えた先で既に別の送信が始まっているなら、そちらの「受信中」を消さない
        if (streamRef.current === stream) {
          setSending(false);
          streamRef.current = undefined;
          setActiveReplyKeys(NO_REPLY_KEYS);
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

  // 積んだ文・添付をそのまま送らず入力欄の今の中身を送る: 直した後に押すと、外したはずの添付つきで届き、直した文は入力欄に残って二重に届く。
  // 中身が違うなら新しい clientMessageId で送る: 同じ id で中身を変えると 409 client_message_id_mismatch で断られる
  const resend = useCallback(
    (stashed: {
      text: string;
      supersedes?: string;
      attachments?: PendingAttachment[];
      clientMessageId?: string;
      inComposer?: boolean;
    }) => {
      if (stashed.inComposer !== true || (draft.trim() === '' && pending.length === 0)) {
        const owner = shownId;
        void send(stashed.text, {
          ...stashed,
          retry: true,
          // 控えの添付は pending に居ないので、印を控えへ書く: 書かないと、途中で失敗した再送が上げ直す
          onUploaded: (key, meta) =>
            setRetries((previous) => {
              const entry = previous.get(owner);
              if (entry?.attachments?.some((item) => item.key === key) !== true) return previous;
              return new Map(previous).set(owner, {
                ...entry,
                attachments: entry.attachments.map((item) =>
                  item.key === key ? { ...item, meta } : item,
                ),
              });
            }),
        });
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
    [draft, pending, send, shownId],
  );

  const { data: attachmentLimits } = useAttachmentLimits();

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

  // open を見る前に Stream を登録しない: 進行中でなかったとき、その間に送った発言が followUp に乗り、応答の流れる先が無くなる
  useEffect(
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

  // 手元の lines から古い行を先回りして消さない: 楽観更新をしない方針（useRecordOwnMessage）を守り、置き換えられた側は次の履歴の読み直しで既定ビューから消える
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
      dropEditDraft(line.key);
      const attachments = [...carriedAttachments(editAttachments), ...added];
      // 書きかけを戻すとき印を載せる: 載せないと、確定し直すたびに上げ直す
      const uploadedMetas = new Map<string, MessageAttachment>();
      await send(text, {
        supersedes: line.journalId,
        draft: 'keep',
        attachments,
        onUploaded: (key, meta) => uploadedMetas.set(key, meta),
        onUploadFailed: () => {
          if (draft !== undefined) {
            const restored: EditDraft = {
              ...draft,
              added: draft.added.map((item) => {
                const meta = uploadedMetas.get(item.key);
                return meta === undefined ? item : { ...item, meta };
              }),
            };
            setEditDrafts((previous) => new Map(previous).set(line.key, restored));
          }
          setEditingKey(line.key);
        },
      });
    },
    [editDraft, editAttachments, editDrafts, send, dropEditDraft],
  );

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

  // 押した会話 id を呼び出し元（その render の shownId）から直接受ける: shownIdRef は受動効果の中でしか進まず、切り替え直後の窓で別の会話に前の会話の「止めた」が出ていた。
  // ここでは出す/出さないを判断せず、描画側が shownId と突き合わせる。リクエスト自体は切り替えても最後まで送る（変えるのは表示だけ）。
  // failures には触れない: 「止める」は送れていない発言を何も変えない
  const handleInterrupt = useCallback(
    async (pressedConversationId: string) => {
      setInterrupting({ conversationId: pressedConversationId });
      setInterruptNotice(undefined);
      setInterruptFailure(undefined);
      // 対象を省かない: 省くと、順番待ちの間に押しても先客のターンを止めてしまう。決められないとき・古いデーモンは呼ばずに言う
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
          const waiting = followUpIdsRef.current.get(pressedConversationId);
          if (waiting?.delete(targetId) === true && waiting.size === 0) {
            replayControllerRef.current?.abort();
          }
        }
        if (outcome === 'withdrawn' && turn !== undefined && running !== undefined) {
          // 取り下げた発言の SSE には終端が流れないので閉じる。文は新しい id で積み直す: 同じ id で送ると重複扱いで配られない
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

  const handleEndConversation = useCallback(
    async (pressedConversationId: string) => {
      focusIntentRef.current = { kind: 'end' };
      setEndingConversation({ conversationId: pressedConversationId });
      setEndFailure(undefined);
      setEndNotice(undefined);
      try {
        await endConversation(pressedConversationId);
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

  const handleDeleteConversation = useCallback(
    async (pressedConversationId: string) => {
      setDeletingConversation({ conversationId: pressedConversationId });
      setDeleteFailure(undefined);
      setDeleteResult(undefined);
      setEndNotice(undefined);
      try {
        const result = await deleteConversation(pressedConversationId);
        deletedConversationIds.current.add(pressedConversationId);
        if (pendingDraftSave.current?.id === pressedConversationId) {
          pendingDraftSave.current = null;
        }
        // 応答を待つ間に別の会話へ移っていたら、そこにとどまる（`handleEndConversation` と同じ）。
        if (shownIdRef.current === pressedConversationId) {
          setDeleteResult({ fromId: pressedConversationId, result });
          navigate('/chat');
        }
      } catch (caught) {
        setDeleteFailure({ conversationId: pressedConversationId, error: caught });
      } finally {
        setDeletingConversation(undefined);
      }
    },
    [deleteConversation, navigate],
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
  const visibleDeleting =
    deletingConversation !== undefined && deletingConversation.conversationId === shownId;
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

  const visibleDeleteFailure =
    deleteFailure !== undefined && deleteFailure.conversationId === shownId
      ? deleteFailure.error
      : undefined;

  const shownFailure =
    visibleFailure ?? visibleInterruptFailure ?? visibleEndFailure ?? visibleDeleteFailure;
  const hasShownFailure = shownFailure !== undefined && shownFailure !== null;

  /**
   * 「会話を終える」の結果の文を出してよいか（#2759）。終えた直後の新しい会話
   * （`shownId` が無い）だけで出す。**終えた会話とは別の会話へ移ったら捨てる**
   * ——render 時に state を直すのは、この画面の他の箇所（`routeId !== shownId`）と同じ形。
   */
  if (endNotice !== undefined && shownId !== undefined && shownId !== endNotice.fromId) {
    setEndNotice(undefined);
  }
  if (deleteResult !== undefined && shownId !== undefined && shownId !== deleteResult.fromId) {
    setDeleteResult(undefined);
  }
  const visibleDeleteNotice =
    deleteResult !== undefined && shownId === undefined ? (
      <ConversationDeletedNotice result={deleteResult.result} />
    ) : undefined;
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
        onDelete={shownId === undefined ? undefined : () => void handleDeleteConversation(shownId)}
        deleting={visibleDeleting}
        /*
         * 「ターンを止める」の結果（3値のどれか）。呼べなかった失敗
         * （ネットワーク断・403 等）は下の `ErrorNote`（`visibleInterruptFailure`）に
         * 出るので、ここに乗るのは正しく応答が返った場合だけである。**いま出している
         * 会話（`shownId`）が押した時点の会話と一致するときだけ出す**
         * （`visibleInterruptNotice` の doc）。
         */
        notice={visibleInterruptNotice ?? visibleEndNotice ?? visibleDeleteNotice}
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
        {conversationMissing ? (
          <Card className="m-3">
            <div className="p-4" data-conversation-missing>
              <p role="status" className="text-sm">
                この会話は見つからない。消されたか、URL が違っているかもしれない。
              </p>
              <Link to="/chat" className="mt-2 inline-block text-xs underline underline-offset-2">
                新しい会話を始める
              </Link>
            </div>
          </Card>
        ) : history.error !== undefined && history.data === undefined ? (
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
                  // 取り下げた発言は、普通の吹き出し（編集の入口つき）にせず、畳んだ行で出す（#3990）
                  if (line.withdrawn === true) {
                    return <ChatWithdrawnMessage key={line.key} text={line.text} />;
                  }
                  if (line.turnFailure !== undefined) {
                    const previous = index > 0 ? all[index - 1] : undefined;
                    const retryLine =
                      line.turnFailure === 'failed' &&
                      index === all.length - 1 &&
                      !sending &&
                      previous?.role === 'human' &&
                      previous.withdrawn !== true &&
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
