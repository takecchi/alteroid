import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import type { ManagerSummary } from './manager.js';
import { QUOTA_SESSION_WINDOW_KEY, QUOTA_STOP_MANAGER_IDS_KEY } from './quota-stop-notice.js';
import type { InboxEvent } from './schema.js';

interface QuotaStopTargets {
  /** 到着順・重複なし。 */
  managerIds: string[];
  /** いちばん早く積まれた知らせの時刻。 */
  earliestAt: string;
}

function payloadManagerIdsOf(payload: unknown): string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const ids = (payload as Record<string, unknown>)[QUOTA_STOP_MANAGER_IDS_KEY];
  if (!Array.isArray(ids)) return undefined;
  return ids.filter((id): id is string => typeof id === 'string');
}

/** 束の中の「枠に当たって止まった」の知らせが名指す担当。1件も無ければ `undefined`。 */
export function quotaStopTargetsOf(events: readonly InboxEvent[]): QuotaStopTargets | undefined {
  const managerIds: string[] = [];
  let earliestAt: string | undefined;
  for (const event of events) {
    let ids: readonly string[] | undefined;
    if (event.type === 'manager_message' && event.quotaStop === true) ids = [event.managerId];
    else if (event.type === 'external' && event.source === DAEMON_RUNNER_REGISTRY_SOURCE) {
      ids = payloadManagerIdsOf(event.payload);
    }
    if (ids === undefined || ids.length === 0) continue;
    for (const id of ids) if (!managerIds.includes(id)) managerIds.push(id);
    if (earliestAt === undefined || Date.parse(event.at) < Date.parse(earliestAt)) {
      earliestAt = event.at;
    }
  }
  return earliestAt === undefined ? undefined : { managerIds, earliestAt };
}

export type QuotaRecoverySummary = Pick<
  ManagerSummary,
  | 'managerId'
  | 'status'
  | 'live'
  | 'usageStoppedAt'
  | 'tokenGeneration'
  | 'activeTokenGeneration'
  | 'lastFailure'
  | 'lastUnreported'
  | 'lastReportAt'
  | 'supersededBy'
>;

type Verdict = { recovered: true; line: string } | { recovered: false; line: string };

// 3つ全部を要る: `live` だけだと枠で止まったまま生きているセッションを、印だけだと古い鍵のまま走っている担当を、回復と言ってしまうため。
// 世代が取れないときは回復と言わない: 比べる相手が居ないのに一致を捏造しない（`tokenGenerationMismatched` と逆向きに倒す。こちらは「確かめ直さなくてよい」と言う側のため）。
function verdictOf(managerId: string, found: QuotaRecoverySummary | undefined): Verdict {
  if (found === undefined) return { recovered: false, line: `${managerId}（一覧に居ない）` };
  if (!found.live) {
    return { recovered: false, line: `${managerId}（live でない。状態 \`${found.status}\`）` };
  }
  if (found.usageStoppedAt !== undefined) {
    return {
      recovered: false,
      line: `${managerId}（枠で止まった印が残っている。${found.usageStoppedAt} から）`,
    };
  }
  if (found.tokenGeneration === undefined || found.activeTokenGeneration === undefined) {
    return { recovered: false, line: `${managerId}（鍵の世代を確かめられない）` };
  }
  if (found.tokenGeneration !== found.activeTokenGeneration) {
    return {
      recovered: false,
      line:
        `${managerId}（鍵の世代 ${String(found.tokenGeneration)} が現役の ` +
        `${String(found.activeTokenGeneration)} と違う）`,
    };
  }
  return {
    recovered: true,
    line: `${managerId}（\`${found.status}\`・鍵の世代 ${String(found.tokenGeneration)}）`,
  };
}

function elapsedPhrase(fromIso: string, toMs: number): string {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return '';
  const minutes = Math.floor(Math.max(0, toMs - from) / 60_000);
  return `（${String(minutes)} 分前）`;
}

// 末尾の区切り（---）まで含めて返す: `describeSuperseded` と同じく、呼び出し側の連結に手を足さないため
function block(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}

/**
 * 「枠に当たって止まった」の知らせを配る直前に、名指された担当がもう回復しているかを1節で添える。
 * 1本も回復していなければ空文字: 本文の「止まった」がそのまま今の状態なので、足す事実が無い。
 * 一覧を引けなければ「確かめられなかった」と名乗る（空文字にすると、回復していないと読めるため）。
 */
export function describeQuotaRecovery(
  targets: QuotaStopTargets,
  managers: readonly QuotaRecoverySummary[] | { readonly detail: string },
  nowMs: number,
): string {
  const now = new Date(nowMs).toISOString();
  const queued = `知らせが積まれたのは ${targets.earliestAt}${elapsedPhrase(targets.earliestAt, nowMs)}。`;
  if ('detail' in managers) {
    return block([
      `⚠ この「枠に当たって止まった」の知らせが名指す担当が、配る時点（${now}）で回復しているかを確かめられなかった（${managers.detail}）。` +
        queued,
    ]);
  }
  const verdicts = targets.managerIds.map((id) =>
    verdictOf(
      id,
      managers.find((manager) => manager.managerId === id),
    ),
  );
  const recovered = verdicts.filter((verdict) => verdict.recovered);
  if (recovered.length === 0) return '';
  const pending = verdicts.filter((verdict) => !verdict.recovered);
  const grounds =
    '回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること。';
  if (pending.length === 0) {
    return block([
      `✅ **配る時点（${now}）の担当一覧では、この知らせが名指す担当 ${String(recovered.length)} 本はすべて回復している**: ` +
        `${recovered.map((verdict) => verdict.line).join('、')}。${grounds}`,
      `${queued}**本文の「止まった」は積まれた時点の話で、いま止まっているとは読まないこと。** ` +
        '回復を確かめ直すために `manager_list` / `token_list` を引く必要は無い。',
    ]);
  }
  return block([
    `配る時点（${now}）の担当一覧では、この知らせが名指す担当 ${String(verdicts.length)} 本のうち ` +
      `**${String(recovered.length)} 本は回復している**: ${recovered.map((verdict) => verdict.line).join('、')}。${grounds}`,
    `まだ回復したと言えない ${String(pending.length)} 本: ${pending.map((verdict) => verdict.line).join('、')}。`,
    `${queued}本文の「止まった」は積まれた時点の話である。`,
  ]);
}

/**
 * 畳んでよい枠の知らせが名指す担当（1件ずつ見る）。5時間枠の印が無ければ `undefined`（＝届ける）。
 * 週の上限のように時間ですぐ戻らない枠は、オーナーへ知らせる判断に要るので印が付かず、ここで落ちる（#4499）。
 */
export function foldableQuotaStopTargetsOf(event: InboxEvent): QuotaStopTargets | undefined {
  const sessionWindow =
    event.type === 'manager_message'
      ? event.quotaSessionWindow === true
      : event.type === 'external' &&
        typeof event.payload === 'object' &&
        event.payload !== null &&
        (event.payload as Record<string, unknown>)[QUOTA_SESSION_WINDOW_KEY] === true;
  if (!sessionWindow) return undefined;
  return quotaStopTargetsOf([event]);
}

// `describeQuotaRecovery` の「回復」より狭く取る: こちらはクローンに読ませずに消す側なので、`done` は知らせより後に成功したターンが在るときだけ戻ったと読む。
// `lastFailure` / `lastUnreported` は成功したターンの報告で消える欄（manager.ts の `case 'report'`）なので、残っていれば直近のターンは成功していない。
export function backOnCurrentToken(
  found: QuotaRecoverySummary | undefined,
  noticeAt: string,
): boolean {
  if (found === undefined) return false;
  if (!found.live || found.usageStoppedAt !== undefined) return false;
  if (found.tokenGeneration === undefined || found.activeTokenGeneration === undefined)
    return false;
  if (found.tokenGeneration !== found.activeTokenGeneration) return false;
  if (found.status === 'running') return true;
  if (found.status !== 'done') return false;
  if (found.lastFailure !== undefined || found.lastUnreported !== undefined) return false;
  if (found.lastReportAt === undefined) return false;
  return Date.parse(found.lastReportAt) > Date.parse(noticeAt);
}

/**
 * 枠の知らせ以外で「担当が戻っていれば畳んでよい」印（`foldWhenBack`）の付いた知らせを、配る時点で畳むかを決める（#5048）。
 * 畳むなら日誌へ書く1節を、届けるなら `null` を返す。一覧を引けなかったときも `null`（確かめられないまま消さない）。
 * 戻ったかの基準は `backOnCurrentToken`（#4499 と同じ）。`movedFromGeneration` が在れば、担当がその世代から別の世代へ移っていることも要る:
 * 同じ鍵のまま作業者だけが落ちた回（#5021 の筋A）は、担当が動けていても作業者は落ち続けるので消さない。
 */
export function recoveredNoticeFoldOf(
  event: InboxEvent,
  managers: readonly QuotaRecoverySummary[] | { readonly detail: string },
  nowMs: number,
): string | null {
  if (event.type !== 'manager_message' || event.foldWhenBack === undefined) return null;
  if ('detail' in managers) return null;
  const found = managers.find((manager) => manager.managerId === event.managerId);
  if (event.foldWhenBack.attached === true) {
    // デーモン再起動の引き取り直し: 鍵の世代を記録しない回なので世代は見ない。live・枠停止の印なし・running のすべてが要る（倒れ側は届ける）
    if (found === undefined || !found.live || found.usageStoppedAt !== undefined) return null;
    if (found.status !== 'running') return null;
    return block([
      `✅ 配る時点（${new Date(nowMs).toISOString()}）の担当一覧では、デーモン再起動で引き取り直したこの担当 ${event.managerId} は live で \`running\`` +
        '（枠で止まった印なし）。runner の中で走り続けていると読み、本文（最後の報告の抜粋）は日誌に全文で残してある。',
      `知らせが積まれたのは ${event.at}${elapsedPhrase(event.at, nowMs)}。`,
    ]);
  }
  if (!backOnCurrentToken(found, event.at) || found === undefined) return null;
  const from = event.foldWhenBack.movedFromGeneration;
  if (from !== undefined && found.tokenGeneration === from) return null;
  const now = new Date(nowMs).toISOString();
  return block([
    `✅ 配る時点（${now}）の担当一覧では、この知らせが名指す担当 ${event.managerId} はいまの世代の鍵で戻っている` +
      `（\`${found.status}\`・鍵の世代 ${String(found.tokenGeneration)}` +
      (from === undefined ? '' : `。知らせを積んだ時点の世代 ${String(from)} から移った`) +
      '）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること・' +
      '`running`、または `done` で知らせより後のターンが成功していること。',
    `知らせが積まれたのは ${event.at}${elapsedPhrase(event.at, nowMs)}。`,
  ]);
}

/**
 * 名指す担当が全員いまの世代の鍵で戻っていれば、ターンを起こさず日誌へ書く1節を返す。1本でも戻っていなければ `null`（＝届ける）。
 * 一覧を引けなかったときも `null`: 確かめられないまま消すより、届けてクローンに見てもらう側へ倒す。
 */
export function quotaFoldNoticeOf(
  targets: QuotaStopTargets,
  managers: readonly QuotaRecoverySummary[] | { readonly detail: string },
  nowMs: number,
): string | null {
  if ('detail' in managers) return null;
  const all = targets.managerIds.every((id) =>
    backOnCurrentToken(
      managers.find((manager) => manager.managerId === id),
      targets.earliestAt,
    ),
  );
  if (!all) return null;
  return (
    '5時間枠で止まった知らせだが、配る時点で名指す担当は全員いまの世代の鍵で戻っていた' +
    '（`running`、または `done` で知らせより後のターンが成功している）。\n\n' +
    describeQuotaRecovery(targets, managers, nowMs)
  );
}
