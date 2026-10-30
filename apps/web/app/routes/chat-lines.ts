import { isApprovalAnswered, isApprovalWithdrawn } from '~/components/approval-answer-card';
import type { TurnFailureKind } from '@alteroid/ui';
import { ApiError } from '@alteroid/swr';
import { newClientMessageId } from '@alteroid/logic';
import type {
  ChatDraftMark,
  ConversationMessage,
  MessageAttachment,
  PendingApproval,
} from '@alteroid/logic';

export interface PendingAttachment {
  key: string;
  file?: File;
  meta?: MessageAttachment;
}

export function sizedOf(item: PendingAttachment): { name: string; size: number; type: string } {
  return {
    name: item.file?.name ?? item.meta?.name ?? '',
    size: item.file?.size ?? item.meta?.size ?? 0,
    type: item.file?.type ?? item.meta?.mediaType ?? '',
  };
}

export const attachmentMarkOf = (entry: {
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

export function attachmentIds(items: readonly PendingAttachment[]): string[] {
  return items.flatMap((item) => (item.meta === undefined ? [] : [item.meta.id]));
}

export function carriedAttachments(items: readonly MessageAttachment[]): PendingAttachment[] {
  return items.map((meta) => ({ key: `e-${meta.id}`, meta }));
}

// 前や途中を直したときは全部残す: どこまでが送った分か推測して削ると使い手の編集を失わせる
export function withoutSentText(current: string, sent: string): string {
  return current.startsWith(sent) ? current.slice(sent.length) : current;
}

// keep は入力欄に触らない: 触ると、別の発言を書きかけていた入力欄が黙って空になる
export type DraftHandling = 'clear' | 'clearSent' | 'keep';

export function isAttachmentMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.code === 'attachment_missing';
}

export function isClientMessageIdMismatch(error: unknown): boolean {
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
export function expiredCarriedNames(
  items: readonly PendingAttachment[],
  message: string,
): string[] {
  return items.flatMap((item) =>
    item.file === undefined && item.meta !== undefined && message.includes(item.meta.id)
      ? [item.meta.name]
      : [],
  );
}

export function afterFailure(
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

export function sameAsStashed(
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

export interface EditDraft {
  text: string;
  attachments: MessageAttachment[];
  added: PendingAttachment[];
  lost: string[];
}

export function hasEditDraft(draft: EditDraft | undefined, line: Line): boolean {
  if (draft === undefined) return false;
  if (draft.text !== line.text || draft.added.length > 0 || draft.lost.length > 0) return true;
  const original = line.attachments ?? [];
  return (
    draft.attachments.length !== original.length ||
    draft.attachments.some((item, index) => item.id !== original[index]?.id)
  );
}

export interface Line {
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
  // 時刻は createdAt に固定する: 回答・取り下げは同じカードの状態として出し、別の行にしない。
  // 生配信（SSE の ask_human）が作る行は質問しか知らない最小の形で、履歴が同じ承認を持つようになったら pendingOwnLines が承認 id で引き取る
  approval?: PendingApproval;
}

// 承認のカードは本文ではなく承認 id で結ぶ: 回答で本文は変わらないが状態は変わる
function lineMatchKey(line: Line): string {
  return line.approval !== undefined
    ? `approval\u0000${line.approval.id}`
    : `${line.role}\u0000${line.text}`;
}

export function approvalFromAskEvent(approvalId: string, question: string): PendingApproval {
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
// 同じ会話の往復で増える手元の写しは刈らない。**その刈り込みはこの関数の役目ではなく、pendingOwnLines が持つ。**
export function retainedBy(
  lines: Line[],
  shownId: string | undefined,
  previousShownId: string | undefined,
): Line[] {
  return lines.filter(
    (line) => line.of === undefined || line.of === shownId || line.of === previousShownId,
  );
}

export type FocusIntent =
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
export function applyFocusIntent(intent: FocusIntent): boolean {
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

export function claimedFailedGroups(
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

// 分かれた返信の行を日誌の1発言へ連結するときの区切り: デーモンが境目に入れる空行
const REPLY_SEGMENT_JOINER = '\n\n';

// 一致が確認できた行だけを落とす: 一致が無ければ理由を問わず残す。履歴の再取得が空を返す窓で、届いたばかりの行を消さないため
export function pendingOwnLines(
  lines: Line[],
  shownId: string | undefined,
  historyLines: Line[],
  failedTurns: ReadonlyMap<string, FailedTurn> | undefined,
  /**
   * 編集で畳まれた返答（履歴で `supersededBy` が付いた outbound）。手元の返答がこれに当たったら引き取る（表に残さない）。
   * 渡さないと、返答の途中で過去の発言を編集したとき、畳まれた側の返答は照合先が履歴から消え、手元の行として居座る。
   * 畳むかどうかはサーバの `supersededBy` を読むだけで、規則はここで持たない。
   */
  foldedLines: readonly Line[],
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
  // 返答だけを数える: 人間の発言は id で引き取るので、畳まれた本文で当てると別の発言を消しうる
  const folded = new Map<string, number>();
  for (const line of foldedLines) {
    if (line.role !== 'clone') continue;
    const key = lineMatchKey(line);
    folded.set(key, (folded.get(key) ?? 0) + 1);
  }
  // 見えている履歴を先に使い、無ければ畳まれた返答を使う。どちらかを1つ減らせたら true
  const take = (key: string, allowFolded: boolean): boolean => {
    const visible = remaining.get(key) ?? 0;
    if (visible > 0) {
      remaining.set(key, visible - 1);
      return true;
    }
    const hidden = allowFolded ? (folded.get(key) ?? 0) : 0;
    if (hidden > 0) {
      folded.set(key, hidden - 1);
      return true;
    }
    return false;
  };
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
  // 分かれた返信は連結した本文で照合する: 日誌はターンの本文を1つの発言として載せるので、行ごとだと二重に出る。
  // 連続した行の並びごとに照合する（長い並びを先に当てる）: デーモンは承認カードやターン中に届いた人間の発言でターンの本文を割って書くので、1ターンが日誌の複数の発言になる
  const groups = new Map<string, Line[]>();
  for (const line of owned) {
    if (line.replyGroup === undefined || line.role !== 'clone') continue;
    groups.set(line.replyGroup, [...(groups.get(line.replyGroup) ?? []), line]);
  }
  const absorbedKeys = new Set<string>();
  for (const members of groups.values()) {
    let start = 0;
    while (start < members.length) {
      let next = start + 1;
      for (let end = members.length; end > start + 1; end -= 1) {
        const run = members.slice(start, end);
        const joined = `clone\u0000${run.map((member) => member.text).join(REPLY_SEGMENT_JOINER)}`;
        // 見えている履歴を先に当て、無ければ畳まれた返答に当てる
        if ((remaining.get(joined) ?? 0) <= 0 && (folded.get(joined) ?? 0) <= 0) continue;
        take(joined, true);
        for (const member of run) absorbedKeys.add(member.key);
        next = end;
        break;
      }
      start = next;
    }
  }
  const pending: Line[] = [];
  for (const line of owned) {
    if (absorbedKeys.has(line.key)) continue;
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
      taken = take(key, line.role === 'clone');
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

export function heldApprovalIds(pending: Line[]): Set<string> {
  const ids = new Set<string>();
  for (const line of pending) if (line.approval !== undefined) ids.add(line.approval.id);
  return ids;
}

// 本文では見ない: 同じ本文の発言が別の経路から届いても取り違えないため
export function hasHumanWithClientMessageId(lines: Line[], clientMessageId: string): boolean {
  return lines.some((line) => line.role === 'human' && line.clientMessageId === clientMessageId);
}

export interface EditedVersion {
  text: string;
  hiddenFollowUps: { role: 'human' | 'clone' | 'approval'; text: string }[];
  /** その版の発言に付いていた添付。無ければ欄ごと無い（版によって添付を外したり足したりするので、最新の版の添付で代えない）。 */
  attachments?: readonly MessageAttachment[];
}

export function isSettledApproval(approval: PendingApproval): boolean {
  return isApprovalAnswered(approval) || isApprovalWithdrawn(approval);
}

function describeFoldedApproval(approval: PendingApproval): string {
  const settled = isApprovalWithdrawn(approval)
    ? '（取り下げ済み）'
    : approval.answer
      ? `（回答: ${approval.answer}）`
      : '（回答済み）';
  return `${approval.question}${settled}`;
}

// 畳むかどうかの規則はサーバ（supersededBy）が持つ。ここは承認を見分けるためだけに区間を引く（承認は発言の id を持たないので時刻で当てる）
export function foldedSpans(
  messages: readonly ConversationMessage[],
): { start: string; end: string }[] {
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
    return {
      text: message?.text ?? '',
      hiddenFollowUps,
      // 履歴の行と同じく、空の添付は欄ごと持たない
      ...(message?.attachments === undefined || message.attachments.length === 0
        ? {}
        : { attachments: message.attachments }),
    };
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
