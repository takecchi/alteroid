import { excerpt, renderListingFromEnd } from './excerpt.js';
import { EXCHANGE_KIND_REPLY_PREFIX } from './exchange-kind.js';
import {
  externalAttachmentSection,
  EXTERNAL_EVENT_FRAMING,
  externalEventInstruction,
  externalViaLine,
} from './prompt.js';
import type { InboxEvent } from './schema.js';

// `clone.ts` の末尾にあった、束ねて読む入力の文面を作る純関数群（状態を持たない）。
// 切り出した理由: `Clone` クラスの外にあり、`clone-batch-prompts-pin.test.ts` が出力を逐語で固定していて、クラスの private に触れないため。

/** 人間の発言1件。 */
export type HumanMessage = Extract<InboxEvent, { type: 'human_message' }>;

export function isHumanMessage(event: InboxEvent): event is HumanMessage {
  return event.type === 'human_message';
}

/** 報告（`kind === 'report'`）だけを指す。`Extract` ではメンバー内の `kind` を絞れないので交差型で表す。 */
export type ManagerReportMessage = Extract<InboxEvent, { type: 'manager_message' }> & {
  kind: 'report';
};

export function isManagerReport(event: InboxEvent): event is ManagerReportMessage {
  return event.type === 'manager_message' && event.kind === 'report';
}

/** 担い手が報告に添えたファイル（または受け取れなかったものの名前と理由）が付いているか。 */
export function hasReportFiles(event: Extract<InboxEvent, { type: 'manager_message' }>): boolean {
  return (event.attachments?.length ?? 0) > 0 || (event.rejectedAttachments?.length ?? 0) > 0;
}

/** 外部からの出来事1件。 */
export type ExternalEvent = Extract<InboxEvent, { type: 'external' }>;

export function isExternalEvent(event: InboxEvent): event is ExternalEvent {
  return event.type === 'external';
}

/** 束の中の報告を、担当ごとに最初の1件だけ（届いた順）。 */
export function firstReportPerManager(events: readonly InboxEvent[]): ManagerReportMessage[] {
  const seen = new Set<string>();
  const firsts: ManagerReportMessage[] = [];
  for (const event of events) {
    if (!isManagerReport(event) || seen.has(event.managerId)) continue;
    seen.add(event.managerId);
    firsts.push(event);
  }
  return firsts;
}

/** 起点が違っても1ターンにまとめてよい種類（`CloneBatchMerge.mixedSignalBatch`）。人間の発言・回答・タイマー・発意・蒸留は入らない。 */
export type MixableSignal = Extract<InboxEvent, { type: 'manager_message' }> | ExternalEvent;

export function isMixableSignal(event: InboxEvent): event is MixableSignal {
  return event.type === 'manager_message' || event.type === 'external';
}

/**
 * 起点の違う合図の束の本文の合計の予算（字）。報告の束（`MANAGER_REPORT_BATCH_BODY_BUDGET`）と同じ値だが別に置く（用途ごとに別の定数）。
 * 先頭の1件はこれを超えても束の頭になる（単発でも同じ長さを読む）。
 */
export const MIXED_SIGNAL_BATCH_BUDGET = 47_500;

/** 束の予算に数える字数。外部イベントの中身が文字列にできなければ予算いっぱいと数える（混ぜない側へ倒す）。 */
export function mixableSignalChars(event: MixableSignal): number {
  if (event.type === 'manager_message') return event.text.length;
  try {
    return JSON.stringify(event.payload ?? null).length;
  } catch {
    return MIXED_SIGNAL_BATCH_BUDGET;
  }
}

/**
 * 起点の違う合図の束の本文。各件は単発のときと同じ本文（`managerPrompt` / `buildExternalEventPrompt`）をそのまま並べる（要約しない）。
 */
export function mixedSignalBatchPrompt(items: readonly MixedBatchItem[]): string {
  const total = items.reduce(
    (sum, item) => sum + (typeof item === 'string' ? 1 : item.parts.length),
    0,
  );
  let number = 0;
  const lines = items.flatMap((item): string[] => {
    if (typeof item === 'string') {
      number += 1;
      return [`---`, `**(${String(number)})**`, '', item, ''];
    }
    // 同じ担当の報告の連続（`CloneBatchMerge.mergedManagerReportBatch` の束と同じ見出しと注意）を束の中でも保つ: 後の報告が前の報告の補足・訂正のことがあり、並べただけだと連続だと読めないため
    const first = number + 1;
    const last = number + item.parts.length;
    const chunk = [
      `---`,
      `**マネージャー ${item.managerId} からの報告が続けて ${String(item.parts.length)} 件（(${String(first)})〜(${String(last)})）。** ` +
        '後の報告が前の報告を補足・訂正していることがある。**この続きの報告は最後まで読んでから判断すること。**',
      '',
    ];
    for (const part of item.parts) {
      number += 1;
      chunk.push(`**(${String(number)})**`, '', part, '');
    }
    return chunk;
  });
  return [
    `[system] 処理待ちのあいだに届いた合図を **${String(total)} 件** まとめて渡す（届いた順。要約していない）。` +
      '別々の担当・外部からの件が混ざっている。',
    '**最後まで読んでから、1件ずつ要る手を打て。** 質問・確認には、それぞれの宛先（managerId と requestId）で答えること。',
    '',
    ...lines,
  ].join('\n');
}

/** 起点の違う合図の束の1項目。文字列は1件、`parts` は同じ担当の報告が連続した塊（見出しと注意が付く）。 */
export type MixedBatchItem =
  string | { readonly managerId: string; readonly parts: readonly string[] };

/** 人間の発言のターンの入力の先頭に置く、会話の名乗り。セッションが1本なので、名乗らないと別の会話の件を混ぜる。 */
// 同じ会話が続く回は id の1行だけにする: いちばん多い普通の一往復で、読ませるものを増やさないため（`humanTurnText` の doc）
// 会話の題は出さない: 会話は題を持たず、一覧の見出しは最後の発言の抜粋で、名乗りに使うと発言そのものを二重に渡すため
export function humanConversationHeader(conversationId: string, previous: string | null): string {
  if (previous === null || previous === conversationId) return `[system] 会話 ${conversationId}`;
  return (
    `[system] 会話 ${conversationId}（直前の人間の発言は別の会話 ${previous} だった。` +
    'この会話に関係しない件〔別の会話で頼まれた委譲の報告など〕は、ここへ混ぜずにその起点の会話の task へ `task_say` で書くこと）'
  );
}

/**
 * 人間の発言をターン1本の本文にする（複数件は `CloneBatchMerge.mergedHumanBatch`）。
 *
 * 1件なら断り書きを足さない: いちばん多い形で、普通の一往復のたびに読ませるものが増える。
 * 複数件は要約も間引きもせず、時刻を各件に添える: 「言い直した」と「続けて打った」の判断はクローンに任せ、「最後を優先せよ」とは書かない。
 * 文面は「N件が届いた」ではなく「N件をまとめて渡す」: `CloneBatchMerge.drainMergeableWithinLimit` が上限で束を切ると前者は偽になる。
 * `supersedes` 付き（編集）には合図を前置きし、無い発言には1文字も足さない（pure/sync を保つ）。
 */
export function humanTurnText(
  events: HumanMessage[],
  priorTexts: ReadonlyMap<string, string> = new Map(),
  attachmentNotices: ReadonlyMap<string, string> = new Map(),
): string {
  const head = events[0];
  if (head === undefined) return '';
  const bodyOf = (event: HumanMessage): string => {
    const body = editedTurnBody(event, priorTexts.get(event.id));
    const notice = attachmentNotices.get(event.id);
    if (notice === undefined) return body;
    return event.text === '' && event.supersedes === undefined ? notice : `${body}\n\n${notice}`;
  };
  if (events.length === 1) return bodyOf(head);

  return [
    `[system] 前のターンを処理しているあいだに人間から届いた発言を、続けて **${events.length} 件** ` +
      'まとめて渡す（届いた順の全文で、要約していない）。',
    '**まとめて1つの応答で答えよ。** 1件目に答えたうえで、後の発言が' +
      'それを言い直している・取り消している・条件を足していることがある。**最後まで読んでから答えること。**',
    '',
    '---',
    '',
    ...events.map(
      (event, index) =>
        `**(${index + 1}) ${event.at}**` +
        `${event.supersedes === undefined ? '' : '（既出発言の編集）'}` +
        `\n\n${bodyOf(event)}\n`,
    ),
  ].join('\n');
}

/**
 * 1件ぶんの本文に、必要なら編集の合図を前置きする。`priorText` が引けなくても編集である事実は伝える。
 * 副作用の巻き戻しは指示しない: 存在しないロジックをプロンプト側から作ることになる。
 */
function editedTurnBody(event: HumanMessage, priorText: string | undefined): string {
  if (event.supersedes === undefined) return event.text;
  const notice =
    priorText === undefined
      ? `[system] これは既出発言（id=${event.supersedes}）の編集である。` +
        '（編集前の本文は引けなかった。）'
      : `[system] これは既出発言（id=${event.supersedes}）の編集である。編集前の本文:\n\n${priorText}`;
  return event.text === '' ? notice : `${notice}\n\n---\n\n${event.text}`;
}

/** 質問・許可確認が `ManagerPool` の `waiting` で待たれているかの3値。2値にしない: 判定できない場合がどちらかへ黙って倒れる。`'unknown'` は「待っている」の言い換えではない。 */
export type ConfirmationLiveness = 'live' | 'settled' | 'unknown';

/**
 * 「受け取ってからどれだけ経ったか」を丸めて言う。
 *
 * 文言は「受け取ってから」: `event.at` は `post()` が受理した時刻で、書かれた時刻ではない。
 * 閾値を設けない: 古いときだけ出すと、新しい報告に行が出ないのと機能が無いのとが同じ顔になる。
 * 丸めた値に `at` を併記する: 他のタイムスタンプと突き合わせるため。
 * 壊れた・未来の `at` には `NaN` や負の経過を出さず、測れない理由を書く。
 * `now` は引数で受ける: `managerPrompt` を純関数に保つ。
 */
function describeReportAge(at: string, now: Date): string {
  const receivedMs = Date.parse(at);
  if (Number.isNaN(receivedMs)) {
    return `受け取った時刻（${at}）を解析できないため、経過は測れない。`;
  }
  const elapsedMs = now.getTime() - receivedMs;
  if (elapsedMs < 0) {
    return `受け取った時刻（${at}）が現在時刻より未来のため、経過は測れない。`;
  }
  return `受け取ってから${formatElapsed(elapsedMs)}経過（受け取った時刻: ${at}）。`;
}

/** 経過ミリ秒を秒／分／時間／日で丸める（{@link describeReportAge} 専用）。 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return '1秒未満';
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `約${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `約${hours}時間`;
  const days = Math.floor(hours / 24);
  return `約${days}日`;
}

/** 報告への応じ方の案内（単発の報告の末尾）。 */
export const REPORT_FOLLOW_UP_GUIDE =
  '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。\n' +
  '学びや判断の基準になったことがあれば記憶へ移すこと。';

/** 束ねた報告への応じ方の案内。 */
const BATCH_REPORT_FOLLOW_UP_GUIDE =
  '続きが要るなら、それぞれの報告に対して `manager_send` で指示を出せ。要らないなら何もしなくてよい。\n' +
  '学びや判断の基準になったことがあれば記憶へ移すこと。';

/**
 * マネージャーからの一件をクローンの言葉に直す。
 *
 * 「何なら答えてよいか」の一覧を書かない: 線引きはクローンの記憶にあり、書くと人による違いが潰れる（PRD「権限境界」/ AGENTS.md 地雷3）。
 * `now` は呼び出し元から渡す: 純関数に保つため `new Date()` を呼ばない（既定値は本番用で、テストは明示的に渡す）。
 * `event.foldedTurn` の回は見出しを「直近のターンの中身」にする。判定は構造化された印だけで、本文の文言は見ない。
 */
export function managerPrompt(
  event: Extract<InboxEvent, { type: 'manager_message' }>,
  origin: ManagerOrigin,
  liveness: ConfirmationLiveness,
  now: Date = new Date(),
  attachmentLines: readonly string[] = [],
  bodyLimit: number = MANAGER_REPORT_BODY_LIMIT,
): string {
  const head = `[system] マネージャー ${event.managerId} から届いた。`;

  if (event.kind === 'report') {
    const reportLabel = event.foldedTurn === true ? '直近のターンの中身' : '報告';
    return [
      `${head}（${reportLabel}）`,
      '',
      ...(attachmentLines.length === 0 ? [] : [...attachmentLines, '']),
      // 本文に束と同じ予算を掛ける: 単発も新しいセッションの最初のターンで文脈窓を越えうる。
      ...boundedReportBody({ ...event, kind: 'report' }, bodyLimit),
      '',
      // 経過も印も本文の後ろに置く: 前に置くと「読まなくてよい」と読まれて本文を飛ばされる。
      describeReportAge(event.at, now),
      describeManagerOrigin(origin),
      '',
      REPORT_FOLLOW_UP_GUIDE,
    ].join('\n');
  }

  const label = event.kind === 'question' ? '質問' : '実行の許可確認';

  // 待たれていない確認を「まだ止まっている」と偽らない: 同じ requestId へ二重に答え、`manager_send` に弾かれるため。
  if (liveness === 'settled') {
    return [
      `${head}（${label}）`,
      '',
      event.text,
      '',
      'この確認はもう待たれていない（既に解決したか、マネージャーが終わっている）。答え直す必要は無い。',
      describeManagerOrigin(origin),
    ].join('\n');
  }

  // 宛先を requestId まで書く: 同じマネージャーが同時に複数を待つことがあり、欠いた回答は宛先を推測できない。
  const to =
    event.requestId === undefined
      ? `managerId: "${event.managerId}"`
      : `managerId: "${event.managerId}", requestId: "${event.requestId}"`;

  const decisionLine = '許可確認なので `decision` に allow / deny を明示すること。';
  const guide = [
    `返事をするまで ${event.managerId} のこの1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。`,
    `記憶に根拠があるなら自分で決めて \`manager_send\`（${to}）で返し、その判断を \`journal_write\` に残せ。`,
    event.kind === 'permission' ? decisionLine : '',
    `根拠が無いなら \`ask_human\` に ${to} を添えて積み、人間の回答が届いてから同じ宛先へ \`manager_send\` で返せ。` +
      '（宛先を添えないと、人間が答えてもこの仕事を再開できない）',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return [`${head}（${label}）`, '', event.text, '', describeManagerOrigin(origin), guide]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 委譲の起点（台帳の `Job.conversationId` と `Job.taskId`）。
 * `missing` / `unreadable` を「起点の会話が無い」（`job` の `conversationId: null`）に畳まない: 起点が在るかもしれないのに「起点の会話: 無し」と名乗ることになるため。
 * `conversationId` はどの種類にも置く: ターンを起点の会話に結ぶ呼び手（`#runInternal` へ渡す4か所）が種類を見ずに読めるようにするため。分からないときは結ばない（`null`）。
 */
export type ManagerOrigin =
  | { kind: 'job'; conversationId: string | null; taskId?: string }
  | { kind: 'missing'; conversationId: null }
  | { kind: 'unreadable'; conversationId: null; reason: string };

/**
 * 委譲が task に結び付いていないときの案内（起点の会話の有無によらず同じ）。
 * 起点の会話が無い委譲に別の手順を書かない: task_add はこのターンの起点の会話へ、無ければ新しい会話へ器が結ぶ（`task_add` の `getWorkConversationId() ?? randomUUID()`）ので、クローンの手順は同じになるため（#5469）。
 */
export const ORIGIN_NO_TASK_GUIDE =
  '（人間へ知らせるなら、この委譲の起点の会話の task を task_list で探して `task_say` で書く。無ければ task_add で足す〔宛先の会話は器が決める: 起点の会話があればそこ、無ければ新しい会話〕。' +
  '書いたら、知らせるだけの task は task_set_status で done にする。このターンで続きを委譲・確認すると、この委譲と同じ起点に結び付く）';

/** 委譲が task に結び付いているときの案内（起点の会話の有無によらず同じ。task が宛先を持つ）。 */
const ORIGIN_TASK_GUIDE =
  '（人間へ知らせるなら、結び付いた task へ `task_say` で書く。書いたら、知らせるだけの task は task_set_status で done にする）';

/** 委譲が task に結び付いているときだけ出す1行（#5469 P3）。委譲が終わった task は判断待ち（needs_decision）に戻っているので、結果の扱いはその task の上で決める。 */
function describeOriginTask(taskId: string | undefined): string {
  return taskId === undefined
    ? ''
    : `\n結び付いた task: ${taskId}（task_say で書ける。task_list で読める）`;
}

export function describeManagerOrigin(origin: ManagerOrigin): string {
  switch (origin.kind) {
    case 'job':
      return (
        `起点の会話: ${origin.conversationId ?? '無し（会話の外で起こした委譲）'}` +
        (origin.taskId === undefined ? ORIGIN_NO_TASK_GUIDE : ORIGIN_TASK_GUIDE) +
        describeOriginTask(origin.taskId)
      );
    case 'missing':
      return '起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）';
    case 'unreadable':
      return `起点の会話: 分からない（台帳を読めなかった。理由: ${origin.reason}。起点が無いという意味ではない）`;
  }
}

function managerReportRetrievalHint(event: ManagerReportMessage): string {
  return (
    `全文の取り方: \`journal_read\` に \`types: ["exchange"]\` と ` +
    `\`since: "${event.at}"\` を渡して絞り込む（マネージャー ${event.managerId} からの` +
    `${event.kind} が処理されるたびに、"${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}/${event.kind}] " で始まる` +
    '全文を、この束を渡す前に日誌へ個別に書いてある）。'
  );
}

/**
 * `PROMPT_CHARACTER_BUDGET` と値が同じでも定数を使い回さない: 片方だけ直したくなったときに一緒に動くため
 * （AGENTS.md 地雷表「予算の定数は用途ごとに別に置く」）。最新の報告を優先して残す（`renderListingFromEnd`）。
 */
const MANAGER_REPORT_BATCH_BODY_BUDGET = 47_500;

/**
 * 報告 1 件の本文の上限（字）。これを超える報告は頭の側だけを出し、全文は日誌と `manager_report` から引く。
 * 質問・許可確認（`question` / `permission`）には掛けない: 返事を書くのに本文が要るため（`managerPrompt` の `report` 以外の枝は本文をそのまま出す）。
 * 頭を残す: 担当への規約が「最終の報告は結論・PR 番号・SHA・残りを先に書く」で、届く本文は担当のターンの最後の発言のため。
 * 値は 2026-10-29 のクローンの手元の観測（直近の報告の全文が 522〜3,517 字でほとんど 1〜4K 字）から 8,000 字。本番の分布を測ったら、ここだけ直す。
 */
export const MANAGER_REPORT_BODY_LIMIT = 8_000;

// `reportDeliveryTextOf`（manager-notices.ts）が本文の末尾に足す「途中の発言を含む全文…」の段落。頭を切るとこの段落も消えるので、切るときは本文と分けて残す
// `fullText` が無い報告には付かないが、`#emit`（manager.ts）が足す「畳んだ報告を配っていない」「重複の知らせを配っていない」の注記も、本文の後ろに付く。
// どれも配っていない報告があったことをクローンへ伝える注記なので、頭を切っても残す。
const REPORT_DELIVERY_TAIL_MARKS = [
  '\n\n（途中の発言を含む全文 ',
  '\n\n（この間に、背景処理の完了待ちで畳んだターンの報告を ',
  '\n\n（この間に、直前と同じ本文の「機構が合成した知らせ」を ',
] as const;

/** 切ったのに全文の取り方を言わないと、読めるものを減らしたことになる（listing-and-detail の性質2）。 */
function boundedReportBody(
  event: ManagerReportMessage,
  bodyLimit: number = MANAGER_REPORT_BODY_LIMIT,
): string[] {
  // 無限なら切らない（`ALTEROID_TOKEN_SAVING_EXCERPT` が無効のとき）。束の予算（`MANAGER_REPORT_BATCH_BODY_BUDGET`）は別の線で、そのまま掛かる
  if (event.text.length <= bodyLimit) return [event.text];
  // 注記は本文の後ろに並ぶので、いちばん手前の目印から後ろをすべて注記とみなす
  const marks = REPORT_DELIVERY_TAIL_MARKS.map((mark) => event.text.lastIndexOf(mark)).filter(
    (at) => at !== -1,
  );
  const tailAt = marks.length === 0 ? -1 : Math.min(...marks);
  const main = tailAt === -1 ? event.text : event.text.slice(0, tailAt);
  const tail = tailAt === -1 ? '' : event.text.slice(tailAt);
  if (main.length <= bodyLimit) return [event.text];
  return [
    `${main.slice(0, bodyLimit)}…${tail}`,
    '',
    `⚠ 本文が長いので、頭の ${bodyLimit.toLocaleString('en-US')} 字だけを出した（全体 ${main.length.toLocaleString('en-US')} 字）。` +
      `全文は、この担当の直近の報告なら \`manager_report\`（managerId: "${event.managerId}"）、それ以前の報告なら \`journal_read\` で引ける。 ${managerReportRetrievalHint(event)}`,
  ];
}

/**
 * 1件ごとに経過を出す（1つへ潰さない）: 束ねられる報告はいちばん長く待った報告で、待った証拠が要る場所のため。
 * 呼び出し元は常に2件以上で呼ぶので、0・1件の見た目は用意しない。
 * 「N 件が届いた」と書かない: 上限で束を切ると偽になるため「N件をまとめて渡す」とする
 * （切った事実は `#notices` の `mergedBatchTruncation` が言う）。
 */
export function managerReportBatchPrompt(
  events: ManagerReportMessage[],
  origin: ManagerOrigin,
  now: Date,
  attachmentLinesOf: ReadonlyMap<string, readonly string[]> = new Map(),
  bodyLimit: number = MANAGER_REPORT_BODY_LIMIT,
): string {
  const head = events[0];
  if (head === undefined) return '';

  const items = events.map((event, index) => {
    const attachmentLines = attachmentLinesOf.get(event.id) ?? [];
    return [
      `**(${index + 1})** ${describeReportAge(event.at, now)}`,
      '',
      ...(attachmentLines.length === 0 ? [] : [...attachmentLines, '']),
      ...boundedReportBody(event, bodyLimit),
    ].join('\n');
  });

  return [
    `[system] マネージャー ${head.managerId} から届いた報告を、処理待ちのあいだに続けて **${events.length} 件** まとめて渡す（要約していない）。`,
    '**まとめて読んでから答えよ。** 後の報告が前の報告を補足・訂正していることがある。**最後まで読んでから判断すること。**',
    '',
    '---',
    '',
    renderListingFromEnd(items, {
      budget: MANAGER_REPORT_BATCH_BODY_BUDGET,
      omitted: ({ rest, shown, total }) =>
        `⚠ 本文の合計が文字数の予算（${MANAGER_REPORT_BATCH_BODY_BUDGET.toLocaleString('en-US')} 文字）に` +
        `当たったので、古い ${rest} 件（${total} 件中、新しい ${shown} 件だけを本文つきで出した）は本文を省いた。` +
        ` ${managerReportRetrievalHint(head)}`,
    }),
    '',
    describeManagerOrigin(origin),
    '',
    BATCH_REPORT_FOLLOW_UP_GUIDE,
  ].join('\n');
}

/**
 * 本文（`renderPayload`）は1回だけ出し、全件の `at` を出す: 束の中で `source` / `payload` は全件同一で、違うのは `id` と `at` だけのため。
 * 「重複だから無視してよい」とは書かない: 外の世界で別々に発行された合図でありうる。
 * 「N件が届いた」と書かない: 上限で束を切ると偽になるため「N件をまとめて渡す」とする。
 * 呼び出し元は常に2件以上で呼ぶので、0・1件の見た目は用意しない。
 */
export function externalBatchPrompt(
  events: ExternalEvent[],
  attachmentNoticeLines: readonly string[] = [],
): string {
  const head = events[0];
  if (head === undefined) return '';

  const body = renderPayload(head.payload, head.at, head.attachments);
  const timestamps = events.map((event) => event.at).join(' / ');

  const viaNames = events.flatMap((event) => (event.via === undefined ? [] : [event.via.name]));
  const via = externalViaLine(viaNames, viaNames.length < events.length);

  return [
    `[system] 外部から出来事が届いた（source: ${head.source}）。人間はこれを見ていない。`,
    ...(via === null ? [] : [via]),
    EXTERNAL_EVENT_FRAMING,
    ...externalAttachmentSection(attachmentNoticeLines),
    `処理待ちのあいだに、同じ中身の合図を続けて **${events.length} 件** まとめて渡す` +
      '（本文は1回だけ。全件で `source` と中身が一致している）。',
    `届いた時刻（届いた順）: ${timestamps}`,
    '',
    '**同じ中身が複数回届いたからといって、同じ出来事の繰り返しとは限らない**' +
      '——外の世界で別々に発行された合図である可能性がある。',
    '',
    externalEventInstruction(),
    '',
    '---',
    '',
    body,
  ].join('\n');
}

const EXTERNAL_PAYLOAD_LIMIT = 8_000;

// 上限は外さない: 入口が本文の大きさを締めておらず、病的に大きい webhook が1件で日誌を膨らませうるため
export const EXTERNAL_JOURNAL_LIMIT = 200_000;

/** 外部から届いた中身を、切る前の1本の文字列にする。 */
export function payloadText(payload: unknown, attachments?: readonly { name: string }[]): string {
  if (payload === undefined || payload === null || payload === '') {
    return attachments === undefined || attachments.length === 0
      ? '（中身のない通知。source だけが届いた。）'
      : '（本文なし。添付だけが届いた）';
  }
  return typeof payload === 'string' ? payload : safeJson(payload);
}

/** 切ったら省いた量と全文の取り方を名乗る（listing-and-detail の性質2）。取り方の先は `#journalIncomingBody` が切らずに書いた行。 */
export function renderPayload(
  payload: unknown,
  at: string,
  attachments?: readonly { name: string }[],
): string {
  const body = payloadText(payload, attachments);
  if (body.length <= EXTERNAL_PAYLOAD_LIMIT) return body;
  const journalNote =
    body.length > EXTERNAL_JOURNAL_LIMIT
      ? `（日誌にも先頭 ${EXTERNAL_JOURNAL_LIMIT.toLocaleString('en-US')} 文字までしか残っていない）`
      : '（日誌には切らずに書いてある）';
  return [
    excerpt(body, EXTERNAL_PAYLOAD_LIMIT),
    `全文の取り方: \`journal_read\` に \`types: ["external_event"]\` と \`since: "${at}"\` を渡して行を見つけ、` +
      `その id を渡して読む${journalNote}。`,
  ].join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
