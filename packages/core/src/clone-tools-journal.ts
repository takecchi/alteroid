// 日誌（journal_write / journal_read）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { journalWindowCrossesHorizon } from './journal-horizon.js';
import {
  describeUnreadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from './journal-time.js';
import { noteDroppedRecord } from './dropped-record.js';
import { describePage, excerpt, excerptLine, excerptRow, page, renderListing } from './excerpt.js';
import { describeTurnTimingBody, describeTurnTimingHead } from './turn-timing-format.js';
import { describeHttpTimingBody, describeHttpTimingHead } from './http-timing-format.js';
import { describeGithubCi } from './progress-github.js';
import { describeMessageBreakdown } from './message-breakdown.js';
import { JOURNAL_ENTRY_TYPES, describeAnsweredVia, type JournalEntry } from './schema.js';
import {
  EXCHANGE_WITH_VALUES,
  JournalAnchorNotFoundError,
  UnreadableJournalEntryError,
  type JournalStore,
} from './store.js';
import { formatUsd } from './usage.js';
import { JOURNAL_SEARCH_UNCOVERED_LIST } from './journal-search.js';
import {
  JOURNAL_SEARCH_BUDGET_MS,
  journalSearchContinuationUntil,
  searchJournalBackwardInSlices,
  type JournalSearchCoverage,
} from './journal-sliced-search.js';
import { describeIntRangeViolation, formatIntRangeJa } from './tool-arg-checks.js';
import {
  JOURNAL_TEXT_EXCERPT,
  text,
  tool,
  appendJournalOrThrow,
  describeUnreadableJournalEntry,
} from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import { CLOSES_SCHEMA, describeClosesViolation, finishWithCloses } from './clone-tools-closes.js';

// `asc` のときだけ `order=asc` を名乗る: afterId の「次」は返る順序の次なので、order を揃えないと逆向き（desc）に読み継いでしまう。desc の文言は変えない
function describeJournalContinuation(
  cursor: { id: string; at: string },
  order?: 'asc' | 'desc',
): string {
  return (
    `続きは journal_read afterId=${cursor.id} afterAt=${cursor.at}` +
    (order === 'asc' ? ' order=asc' : '') +
    ' （ほかの絞りは同じものを渡す）'
  );
}

const JOURNAL_BUDGET = 8_000;

// 一覧の見出しに出す添付の数。超えた分は「ほか N 件」にする
const JOURNAL_LISTING_ATTACHMENTS = 5;

const JOURNAL_PAGE = 8_000;

// クローンが書いた「根拠なし」と同じ文字列にしない: 日誌を読む人間が「根拠を持たずに実行した」と「根拠が記録経路から落ちた」を区別できなくなるため
export const GROUNDS_NOT_DELIVERED =
  '（根拠は記録されていない —— 呼び出しに grounds が届かなかった。' +
  'クローンが「根拠なし」と書いたのではない）';

// 型を写さず `JournalEntry` の union から取り出す: 写した側が古いままでも気づけないため
type ContextUsageRow = NonNullable<Extract<JournalEntry, { type: 'turn_usage' }>['contextUsage']>;

// 欄が無い回は 0 を置かず空文字を返す: 「測ったが 0 だった」と「測っていない」を混ぜないため
// SDK の語をそのまま使わない: `memoryFiles` は `CLAUDE.md` 系で、alteroid の記憶はシステムプロンプト側に入り取り違えるため
function describeContextLine(context: ContextUsageRow | undefined): string {
  if (context === undefined) return '';
  if (context.error !== undefined) return `\n文脈: 測れなかった（${context.error}）。`;
  return (
    `\n文脈: ${context.totalTokens?.toLocaleString('en-US') ?? '不明'} トークン` +
    (context.rawMaxTokens === undefined
      ? ''
      : ` / ${context.rawMaxTokens.toLocaleString('en-US')}`) +
    (context.percentage === undefined ? '' : `（${context.percentage}%）`) +
    '。' +
    describeContextBreakdown(context)
  );
}

function describeContextBreakdown(context: ContextUsageRow): string {
  const parts: string[] = [];
  if (context.systemPromptTokens !== undefined) {
    parts.push(
      `システムプロンプト ${context.systemPromptTokens.toLocaleString('en-US')} トークン` +
        (context.systemPromptSectionCount === undefined
          ? ''
          : `（${context.systemPromptSectionCount} 節。**記憶の焼き込みはここに入る**）`),
    );
  }
  if (context.mcpToolTokens !== undefined) {
    parts.push(
      `MCP の道具の説明文 ${context.mcpToolTokens.toLocaleString('en-US')} トークン` +
        (context.mcpToolCount === undefined ? '' : `（${context.mcpToolCount} 本）`),
    );
  }
  if (context.memoryFileTokens !== undefined) {
    parts.push(
      `CLAUDE.md 系のファイル ${context.memoryFileTokens.toLocaleString('en-US')} トークン` +
        (context.memoryFileCount === undefined ? '' : `（${context.memoryFileCount} 件）`) +
        '——**alteroid の記憶ではない**',
    );
  }
  const categories =
    context.categories === undefined || context.categories.length === 0
      ? ''
      : `\n  カテゴリ別（SDK が名乗る軸。名前は SDK の版で変わりうる）: ` +
        context.categories
          .map(
            (category) =>
              // `kind` が無ければ「分類なし」と名乗る: `0` や `used` へ倒さないため
              `${category.name} ${category.tokens.toLocaleString('en-US')} [${category.kind ?? '分類なし'}]`,
          )
          .join(' / ') +
        (context.categoriesOmitted === undefined
          ? ''
          : `…ほか ${context.categoriesOmitted} 軸は省略`);

  // 1行に収める: 道具ごとの全行は日誌の `contextUsage.messageBreakdown.toolsByName` にあり、ここは上位だけ。欄が無い回は書かない
  const messages =
    context.messageBreakdown === undefined
      ? ''
      : `\n  ${describeMessageBreakdown(context.messageBreakdown)}。`;

  return (parts.length === 0 ? '' : `\n  内訳: ${parts.join(' / ')}。`) + messages + categories;
}

// 付けるのは窓の始点が地平より前にかかるときだけ: 窓がまるごと地平より後ろなら0件でも「本当に無かった」と言い切れ、注記を出すと確定できることまで「判定できない」と言う誤りになるため。前にかかるなら非空でも付ける: 同じ区間について同じ区別が付かないため
function describeJournalHorizonNote(
  oldestAt: string | null,
  since: string | undefined,
  isEmpty: boolean,
): string | undefined {
  if (oldestAt === null) return undefined;
  if (!journalWindowCrossesHorizon(oldestAt, since)) return undefined;
  const range =
    since === undefined ? 'それより前は' : `指定の since（${since}）から ${oldestAt} までの区間は`;
  return isEmpty
    ? `この記憶ストアの日誌の最古は ${oldestAt}。${range}判定できない` +
        '（該当する行が無かったのか、日誌がそこまで遡れないのかは、' +
        'この返り値だけからは区別できない）。'
    : `この記憶ストアの日誌の最古は ${oldestAt}。${range}判定できない` +
        '（その区間に該当する行が無かったのか、日誌がそこまで遡れないのかは、' +
        'この返り値だけからは区別できない）。';
}

function journalAttachmentHead(
  attachments: readonly { id: string; name: string; mediaType: string; size: number }[] | undefined,
  rejected?: readonly { name: string; reason: string }[],
  limit: number = Number.POSITIVE_INFINITY,
  field: (value: string) => string = keepHeadField,
): string {
  // 一覧では先頭の数件だけ出し、残りは件数にする: 添付の多い1行が一覧の予算を食い潰さないため。全件は id 指定で出る
  const more = (total: number): string =>
    total > limit ? `; ほか ${total - limit} 件（全件は journal_read id=<id>）` : '';
  const kept =
    attachments === undefined || attachments.length === 0
      ? ''
      : ` attachments=[${attachments
          .slice(0, limit)
          .map(
            (a) =>
              `id=${field(a.id)} name=${excerptLine(a.name, 80)} type=${a.mediaType} size=${a.size}`,
          )
          .join('; ')}${more(attachments.length)}]`;
  // 受け取れなかったファイルも出す: 全部断られた報告が、添付なしの空の発言に見えないため
  const refused =
    rejected === undefined || rejected.length === 0
      ? ''
      : ` rejectedAttachments=[${rejected
          .slice(0, limit)
          .map((r) => `${excerptLine(r.name, 80)}（${excerptLine(r.reason, 80)}）`)
          .join('; ')}${more(rejected.length)}]`;
  return kept + refused;
}

const JOURNAL_LISTING_MODELS = 3;

// 一覧の本文の抜粋。turn_usage だけは、先頭のモデルの行（本文の先頭から models の数だけ）を行ごとに切り、残り（数え直し・文脈・compaction の行）はこれまでどおりまとめて1本の上限で切る:
// 全部を1行に潰して切ると、1つ目のモデルの行（cache 内訳つき）で字数が尽き、2つ目以降のモデルが一覧に出ないため。
// モデルの行は JOURNAL_LISTING_MODELS 本まで。超えた分は「…ほか N モデル」に畳む（全部は id 指定の全文読みで出る）ので、行の長さは「モデル最大3行 + 残り120字」で頭打ちになる
function journalListingBody(entry: JournalEntry, body: string): string {
  if (entry.type !== 'turn_usage') return excerptRow(body, JOURNAL_TEXT_EXCERPT);
  const modelCount = Object.keys(entry.models).length;
  const lines = body.split('\n');
  const modelLines = lines.slice(0, modelCount);
  const rest = lines.slice(modelCount).join('\n');
  const shown = modelLines
    .slice(0, JOURNAL_LISTING_MODELS)
    .map((line) => excerptRow(line, JOURNAL_TEXT_EXCERPT));
  const hidden = modelLines.length - shown.length;
  const parts = [
    ...shown,
    ...(hidden > 0 ? [`…ほか ${hidden} モデル`] : []),
    ...(rest.trim() === '' ? [] : [excerptRow(rest, JOURNAL_TEXT_EXCERPT)]),
  ];
  return parts.join(' / ');
}

// 凡例の札は `conv#N`: 実在の会話 id（UUID など）と取り違えない形にする。札にしない id は行にそのまま出る
function journalConversationLegend(entries: readonly JournalEntry[]): {
  labels: ReadonlyMap<string, string>;
  lines: string[];
} {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === 'exchange' && entry.conversationId !== undefined) {
      counts.set(entry.conversationId, (counts.get(entry.conversationId) ?? 0) + 1);
    }
  }
  const labels = new Map<string, string>();
  const lines: string[] = [];
  for (const [conversationId, count] of counts) {
    if (count < 2) continue;
    const label = `conv#${labels.size + 1}`;
    labels.set(conversationId, label);
    lines.push(`（${label} = conversation ${conversationId}）`);
  }
  return { labels, lines };
}

// 一覧の見出しに埋まる id・名前の欄の上限。超えた分は excerpt の注記（…（N 文字省略。全 M 文字））で切ったと分かる:
// 本文だけを抜粋で切っても、見出しの欄（approvalId など）が長いと1件で一覧の予算を超えるため（#6318）。
// 添付名の 80 字（journalAttachmentHead）に揃える。全文読み（id 指定）では掛けない
const JOURNAL_LISTING_HEAD_FIELD = 80;

function clipListingHeadField(value: string): string {
  return excerpt(value, JOURNAL_LISTING_HEAD_FIELD);
}

function keepHeadField(value: string): string {
  return value;
}

function renderJournalEntry(
  entry: JournalEntry,
  attachmentLimit: number = Number.POSITIVE_INFINITY,
  conversationLabels?: ReadonlyMap<string, string>,
  field: (value: string) => string = keepHeadField,
): { head: string; body: string } {
  switch (entry.type) {
    case 'exchange': {
      const conversation =
        entry.conversationId === undefined
          ? ''
          : ` conversation=${conversationLabels?.get(entry.conversationId) ?? field(entry.conversationId)}`;
      return {
        head: `[exchange ${entry.with}/${entry.role}]${conversation}${journalAttachmentHead(entry.attachments, entry.rejectedAttachments, attachmentLimit, field)}`,
        body: entry.text,
      };
    }
    case 'decision': {
      // 印の無い行の head は従来の `[decision]` のまま: 既存の読み手（画面・試験）の形を変えないため
      const practice =
        entry.target?.kind === 'practice' ? ` practice=${field(entry.target.slug)}` : '';
      const human =
        entry.humanAction === undefined
          ? ''
          : ` humanAction=${entry.humanAction.kind} target=${field(entry.humanAction.target)} via=${field(describeAnsweredVia(entry.humanAction.via))}`;
      return {
        head: `[decision${practice}${human}]`,
        body: `${entry.decision}（根拠: ${entry.grounds}）`,
      };
    }
    case 'escalation': {
      const to = entry.managerId === undefined ? '' : ` manager=${field(entry.managerId)}`;
      const status =
        entry.withdrawnAt !== undefined
          ? `取り下げ済み ${entry.withdrawnAt}`
          : entry.answeredAt === undefined
            ? '未回答'
            : `回答済み ${entry.answeredAt}`;
      const body =
        entry.withdrawnAt !== undefined
          ? `${entry.question} →（取り下げ: ${entry.withdrawnReason ?? '（理由の記録なし）'}）`
          : entry.answer === undefined
            ? entry.question
            : `${entry.question} → ${entry.answer}`;
      const via =
        entry.answeredVia === undefined
          ? ''
          : ` via=${field(describeAnsweredVia(entry.answeredVia))}`;
      return {
        head: `[escalation approval=${field(entry.approvalId)}${to} ${status}${via}]`,
        body,
      };
    }
    case 'tool_use':
      return {
        head: `[tool_use ${field(entry.actor)} ${field(entry.tool)}]`,
        body: safeJson(entry.input),
      };
    case 'memory_update': {
      // バイトは `head`、文字を含みうる自由文（`summary`）は `body` に分ける: 1行・1文にバイトと文字を混ぜないため
      // 値が無いときは `0` ではなく「不明」と明示する: `0` だと「変化が無かった」と読め、省くと出ている行と混ざって「変化なし」に読めるため
      const action = entry.action === undefined ? '' : ` ${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? ' bytes=不明(旧形式)'
          : ` bytes=${entry.bytesBefore}→${entry.bytesAfter}`;
      return {
        head: `[memory_update ${field(entry.slug)} (${entry.cause})${action}${bytes}]`,
        body: entry.summary,
      };
    }
    case 'daily_report':
      return { head: `[daily_report ${entry.date}]`, body: entry.body };
    case 'external_event':
      return {
        head: `[external_event ${field(entry.source)}]${journalAttachmentHead(entry.attachments, undefined, attachmentLimit, field)}`,
        body: entry.summary,
      };
    case 'worker_wait': {
      const cause = entry.byCause;
      return {
        head: `[worker_wait tasks=${entry.tasks} turns=${entry.turns} settled=${entry.settled}]`,
        body:
          `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
          `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
          `うち ${entry.toolless} ターンは道具を1つも動かしていない。` +
          `UserPromptSubmit の発火は ${entry.submits} 回` +
          (entry.sources === undefined
            ? '（source は取れていない）'
            : `（内訳: ${Object.entries(entry.sources)
                .map(([source, count]) => `${source}=${count}`)
                .join(', ')}）`) +
          '。',
      };
    }
    case 'turn_usage': {
      // キャッシュの書き直しを目で分かる形にする: 潰すと測る意味が消えるため、印の行を一覧から隠さない
      const modelLines = Object.entries(entry.models)
        .map(([model, totals]) => {
          const cache =
            totals.cacheReadInputTokens === 0 && totals.cacheCreationInputTokens === 0
              ? ''
              : ` cache(read=${totals.cacheReadInputTokens} write=${totals.cacheCreationInputTokens})`;
          return (
            `${model}: ${formatUsd(totals.costUsd)}${cache} ` +
            `in=${totals.inputTokens} out=${totals.outputTokens}`
          );
        })
        .join('\n');
      const resetLine =
        entry.reset === undefined
          ? ''
          : `\n⚠ 数え直しを挟んだ回（${formatUsd(entry.reset.fromCostUsd)} → ` +
            `${formatUsd(entry.reset.toCostUsd)}）。models は差分ではなく新しい累積の先頭 — ` +
            '他の行と足し合わせると二重に数える。';
      const context = entry.contextUsage;
      const contextLine = describeContextLine(context);
      const compactionLine =
        entry.compactions === undefined || entry.compactions.length === 0
          ? ''
          : `\ncompaction ${entry.compactions.length} 回: ` +
            entry.compactions
              .map(
                (compaction) =>
                  `${compaction.trigger} ${compaction.preTokens.toLocaleString('en-US')} → ` +
                  `${compaction.postTokens?.toLocaleString('en-US') ?? '不明'}`,
              )
              .join(' / ');
      return {
        head:
          `[turn_usage ${entry.layer}/${entry.site} ${field(entry.managerId)}]` +
          (entry.reset === undefined ? '' : ' ⚠reset') +
          (context?.percentage === undefined ? '' : ` 文脈 ${context.percentage}%`),
        body: `${modelLines}${resetLine}${contextLine}${compactionLine}`,
      };
    }
    case 'context_usage': {
      const context = entry.contextUsage;
      return {
        head:
          `[context_usage ${entry.layer}/${entry.site} ${field(entry.managerId)} ` +
          `${entry.turnSucceeded ? '成功' : '失敗'}]` +
          (context.percentage === undefined ? '' : ` 文脈 ${context.percentage}%`),
        body: describeContextLine(context).replace(/^\n/, ''),
      };
    }
    case 'turn_timing':
      return { head: describeTurnTimingHead(entry), body: describeTurnTimingBody(entry) };
    case 'http_timing':
      return { head: describeHttpTimingHead(entry), body: describeHttpTimingBody(entry) };
    case 'token_rotation': {
      // `exhausted`（全層が止まる）を `not_rotated`（正常）と同じ顔にしない: 見出しに `event` を出す
      const where =
        entry.tokenId === undefined
          ? ''
          : ` → ${field(entry.tokenId)}${entry.label === undefined ? '' : `「${field(entry.label)}」`}`;
      const gen = entry.generation === undefined ? '' : ` 世代${String(entry.generation)}`;
      // `earliestAt` が無いことを「すぐ戻る」と読ませない: 無いのは戻る見込みの立っている候補が1本も無いとき。`parked` でも言い方を変えて出す: その時刻より前に重い委譲を起こす判断をしないために要るため
      const earliest =
        entry.event === 'parked'
          ? entry.earliestAt === undefined
            ? '\n⚠ 撒いた鍵が通るようになる時刻が取れていない'
            : `\n⚠ 撒いた鍵は ${entry.earliestAt} まで通らない（それまでのターンは失敗する）`
          : entry.event !== 'exhausted'
            ? ''
            : entry.earliestAt === undefined
              ? '\n⚠ 戻る見込みの立っている候補が1本も無い（プールが空か、全部外されている）'
              : // 全体の最速として書かない: `exhausted` に `earliestAt` が付くのは現役自身か現役のほうが早い回だけのため
                `\n撒き直す候補のうちいちばん早く戻るのは ${entry.earliestAt}（現役はこれと同時かより早く戻る見込みなので撒き直していない）`;
      // `recoveredSource` を潰さない: どちらの生産者が「通る」と観測したかを見出しから引ける形で出す
      const recoveredSource =
        entry.recoveredSource === undefined ? '' : ` src=${entry.recoveredSource}`;
      return {
        head:
          `[token_rotation ${entry.event}` +
          (entry.signal === undefined ? '' : ` ${entry.signal}`) +
          (entry.freshness === undefined ? '' : `/${entry.freshness}`) +
          `${gen}]${where}${recoveredSource}`,
        // 本文は整形済みの行をそのまま出す: 組み直すと人間が読む面と言い方が分かれるため
        body: `${entry.text}${earliest}`,
      };
    }
    case 'subagent_stall': {
      const agentType = entry.agentType === undefined ? '' : `/${field(entry.agentType)}`;
      return {
        head:
          `[subagent_stall ${entry.outcome} agent=${field(entry.agentId)}${agentType} ` +
          `owned=${entry.ownedTaskCount} session=${entry.sessionTaskCount} ` +
          `wakeup=${entry.wakeupCount}]`,
        body: entry.text,
      };
    }
    case 'inbox_flow': {
      const byTypeText = (count: { byType: { type: string; count: number }[] }): string =>
        count.byType.length === 0
          ? '（無し）'
          : count.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
      // `retained` は見出しに出さない: 一覧の1行を太らせないため、詳細は本文（全文モード）に回す
      const retainedLine =
        entry.retained === undefined
          ? ''
          : `\n残存: unread=${entry.retained.unread} redelivered=${entry.retained.redelivered} ` +
            `pendingCollapse=${entry.retained.pendingCollapse}`;
      return {
        head:
          `[inbox_flow arrived=${entry.arrived.total} delivered=${entry.delivered.total} ` +
          `settled=${entry.settled.total} pending=${entry.pending.count}]`,
        body:
          `窓: ${entry.windowStartedAt} 〜 ${entry.at}\n` +
          `到着: ${byTypeText(entry.arrived)}\n` +
          `配達: ${byTypeText(entry.delivered)}\n` +
          `消し込み: ${byTypeText(entry.settled)}` +
          (entry.pending.oldestAt === undefined ? '' : `\n最古の滞留: ${entry.pending.oldestAt}`) +
          retainedLine,
      };
    }
    case 'github_observation': {
      // 申告であることを見出しに出す。数が取れなかった回は数を出さない
      const head = `[github_observation ${field(entry.repo)} by ${field(entry.observedBy)} ${entry.result.status}]`;
      const scope = `母集合: ${entry.query}${entry.limit === undefined ? '' : ` / limit ${entry.limit}`}`;
      return entry.result.status === 'ok'
        ? {
            head,
            body:
              `open Issue ${entry.result.openIssues} 件 / open PR ${entry.result.openPulls} 件` +
              (entry.result.truncated ? '（limit に達した。実数はこれ以上）' : '') +
              `\n${describeGithubCi(entry.result)}` +
              `\n${scope}`,
          }
        : { head, body: `取れなかった: ${entry.result.reason}\n${scope}` };
    }
    case 'conversation_deleted':
      return {
        head: '[conversation_deleted]',
        body: `会話 ${entry.deletedConversationId} を削除した（${entry.hiddenCount} 件。${entry.deletedBy}）`,
      };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type JournalStores = CloneToolsShared['stores'];

type JournalListQuery = NonNullable<Parameters<JournalStore['listPage']>[0]>;

type JournalPageResult = Awaited<ReturnType<JournalStore['listPage']>>;

// `journal_read` の一覧（id を渡さない読み方）の引数。`limit` と `offset` の検査は呼び元で済んでいる
type JournalListArgs = {
  limit: number | undefined;
  since: string | undefined;
  until: string | undefined;
  types: JournalListQuery['types'];
  q: string | undefined;
  withFilter: JournalListQuery['with'];
  afterId: string | undefined;
  afterAt: string | undefined;
  order: 'asc' | 'desc' | undefined;
};

// 一覧の出力を組むのに要る、読んだあとの値（取れた頁・探した範囲・地平の注記）
type JournalListOutcome = {
  entries: JournalEntry[];
  moreBeyond: { id: string; at: string } | null;
  coverage: JournalSearchCoverage;
  budgetSeconds: number;
  horizonNoteLines: string[];
};

// 引数の検査（id の有無にかかわらず先に行う）: limit → offset → q と order=asc の組、の順
function checkJournalReadArgs(args: {
  limit: number | undefined;
  offset: number;
  id: string | undefined;
  q: string | undefined;
  order: 'asc' | 'desc' | undefined;
}): { kind: 'ok' } | { kind: 'refused'; body: string } {
  const { limit, offset, id, q, order } = args;
  const limitError = describeIntRangeViolation('limit', limit, { min: 1, max: 200 });
  if (limitError !== null) return { kind: 'refused', body: limitError };
  const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
  if (offsetError !== null) return { kind: 'refused', body: offsetError };
  // 語の検索は新しい側から1日ずつ遡る前提（続きの案内・coverage の until もその向き）なので、asc とは組まない。`q=`（空）は絞らないので断らない。id の全文読みは他の条件を無視するので対象外
  if (id === undefined && order === 'asc' && q !== undefined && q !== '') {
    return {
      kind: 'refused',
      body:
        'q は新しい側から遡る検索で、order=asc とは合わない。古い側から読むなら since / until で窓を閉じること。' +
        '**日誌は読んでいない。**',
    };
  }
  return { kind: 'ok' };
}

// ---- 読み方1: id で1件を全文で読む ----

async function readJournalEntryById(
  stores: JournalStores,
  id: string,
  offset: number,
): Promise<string> {
  let entry: JournalEntry | null;
  try {
    entry = await stores.journal.get(id);
  } catch (error) {
    // 在るが読めない行を「無い」と言わない
    if (error instanceof UnreadableJournalEntryError)
      return describeUnreadableJournalEntry('日誌', id);
    throw error;
  }
  if (!entry) return `日誌 ${id} は無い（id が違うか、まだ書かれていない）。`;
  return describeJournalEntryFull(entry, offset);
}

// 1件の全文: 見出し + 頁の注記 + 本文の1頁（JOURNAL_PAGE 字まで）+ 切れたときの続きの案内
function describeJournalEntryFull(entry: JournalEntry, offset: number): string {
  const { head, body } = renderJournalEntry(entry);
  if (body === '') return `${entry.at} ${head}`;
  const part = page(body, offset, JOURNAL_PAGE);
  return `${entry.at} ${head}（${describePage(part)}）\n\n${part.body}${describeJournalEntryPageTail(entry, part)}`;
}

function describeJournalEntryPageTail(entry: JournalEntry, part: ReturnType<typeof page>): string {
  return part.more
    ? `\n\n…（ここで切れている。続きは journal_read id=${entry.id} offset=${part.to}）`
    : '';
}

// ---- 読み方2: 一覧（q があれば窓をまたいで探す） ----

async function readJournalListing(
  context: ToolContext,
  stores: JournalStores,
  args: JournalListArgs,
): Promise<string> {
  const { limit, q, types, afterId, order } = args;
  const checked = checkJournalListArgs(args);
  if (checked.kind === 'refused') return checked.body;
  const { normalizedSince, normalizedUntil } = checked;

  const requested = limit ?? 20;
  const fetched = await fetchJournalPage(context, stores, args, requested, checked);
  if (fetched.kind === 'refused') return fetched.body;
  const { entries, moreBeyond, coverage } = fetched;
  // 0件かどうかで注記を決めない: 窓がまるごと地平より後ろなら、0件でも「本当に無かった」と言い切れるため
  const oldestAt =
    normalizedSince !== undefined || normalizedUntil !== undefined
      ? await stores.journal.oldestAt()
      : null;
  const horizonNote = describeJournalHorizonNote(oldestAt, normalizedSince, entries.length === 0);
  const horizonNoteLines = horizonNote === undefined ? [] : [horizonNote];

  if (entries.length === 0 && moreBeyond !== null) {
    return describeUnreadablePageOnly(requested, order, moreBeyond, horizonNoteLines);
  }

  const budgetSeconds = Math.round(
    (context.journalSearch?.budgetMs ?? JOURNAL_SEARCH_BUDGET_MS) / 1000,
  );
  const outcome: JournalListOutcome = {
    entries,
    moreBeyond,
    coverage,
    budgetSeconds,
    horizonNoteLines,
  };

  if (entries.length === 0) {
    return describeEmptyJournalListing(args, normalizedSince, outcome);
  }
  return describeJournalListing({ q, types, afterId, order }, outcome);
}

// 日時・続きの位置の検査（since → until → afterId と afterAt の対 → afterAt の日時）。通れば since/until を正規化して返す
// since/until を `toISOString()` へ正規化してからストアへ渡す: pg は時刻で比べるが fs・インメモリは文字列比較で、秒の省略やオフセットで3実装の答えが割れるため
function checkJournalListArgs(
  args: Pick<JournalListArgs, 'since' | 'until' | 'afterId' | 'afterAt'>,
):
  | { kind: 'ok'; normalizedSince: string | undefined; normalizedUntil: string | undefined }
  | { kind: 'refused'; body: string } {
  const { since, until, afterId, afterAt } = args;
  if (since !== undefined && normalizeJournalTimeBoundary(since) === null) {
    return {
      kind: 'refused',
      body: describeUnreadableJournalTimeBoundary('since', since) + '**日誌は読んでいない。**',
    };
  }
  if (until !== undefined && normalizeJournalTimeBoundary(until) === null) {
    return {
      kind: 'refused',
      body: describeUnreadableJournalTimeBoundary('until', until) + '**日誌は読んでいない。**',
    };
  }
  // `afterAt` は正規化しない: 錨の `at` と文字列で一致させる値のため、応答の値をそのまま渡させる
  if ((afterId === undefined) !== (afterAt === undefined)) {
    return {
      kind: 'refused',
      body:
        'afterId と afterAt は両方一緒に渡す（片方だけでは続きの位置が決まらない。' +
        '応答の「続きは …」の2つをそのまま渡すこと）。**日誌は読んでいない。**',
    };
  }
  if (afterAt !== undefined && Number.isNaN(Date.parse(afterAt))) {
    return {
      kind: 'refused',
      body:
        `afterAt に渡された「${afterAt}」は日時として読めない（ISO 8601 で、` +
        '応答の「続きは …」の値をそのまま渡すこと）。**日誌は読んでいない。**',
    };
  }
  return {
    kind: 'ok',
    normalizedSince:
      since === undefined ? undefined : (normalizeJournalTimeBoundary(since) ?? undefined),
    normalizedUntil:
      until === undefined ? undefined : (normalizeJournalTimeBoundary(until) ?? undefined),
  };
}

// ストアへ渡す問い合わせ。`[]`（空配列）もそのまま転送する: `{}` へ落とすと「0件」の契約が「絞らない」に化け、契約の歯からも見えないため
function buildJournalQuery(
  args: JournalListArgs,
  requested: number,
  normalized: { normalizedSince: string | undefined; normalizedUntil: string | undefined },
): JournalListQuery & { readonly limit: number } {
  const { types, q, withFilter, order, afterId, afterAt } = args;
  return {
    limit: requested,
    ...(normalized.normalizedSince === undefined ? {} : { since: normalized.normalizedSince }),
    ...(normalized.normalizedUntil === undefined ? {} : { until: normalized.normalizedUntil }),
    ...(types === undefined ? {} : { types }),
    ...(q === undefined ? {} : { q }),
    ...(withFilter === undefined ? {} : { with: withFilter }),
    ...(order === undefined ? {} : { order }),
    ...(afterId === undefined || afterAt === undefined
      ? {}
      : { after: { id: afterId, at: afterAt } }),
  };
}

// 頁を読む（語があれば窓で区切って遡る）。錨が見つからないときは断りの本文を返す
async function fetchJournalPage(
  context: ToolContext,
  stores: JournalStores,
  args: JournalListArgs,
  requested: number,
  normalized: { normalizedSince: string | undefined; normalizedUntil: string | undefined },
): Promise<
  | {
      kind: 'ok';
      entries: JournalEntry[];
      moreBeyond: JournalPageResult['next'];
      coverage: JournalSearchCoverage;
    }
  | { kind: 'refused'; body: string }
> {
  const { q, afterId, afterAt } = args;
  let journalPage: JournalPageResult;
  // 語の検索の探した範囲（#5126）。語が無い・空の呼びは今どおり1本で読むので `complete`
  let coverage: JournalSearchCoverage = { kind: 'complete' };
  try {
    const query = buildJournalQuery(args, requested, normalized);
    // 語で探すときは窓で区切って遡る（#5126）: 当たりの少ない語が本番の大きさで1本数十秒かかり、その間なにも返らないため
    if (q !== undefined && q !== '') {
      const searched = await searchJournalBackwardInSlices(
        stores.journal,
        { ...query, q },
        context.journalSearch,
      );
      journalPage = { entries: searched.entries, next: searched.next };
      coverage = searched.coverage;
    } else {
      journalPage = await stores.journal.listPage(query);
    }
  } catch (error) {
    // 錨が見つからないのは「判定できない」で「先頭から」ではない: 黙って先頭から読み直すと、続きを読んでいるつもりのクローンが同じ行を読み返すため
    if (error instanceof JournalAnchorNotFoundError) {
      return { kind: 'refused', body: describeAnchorNotFound(afterId, afterAt) };
    }
    throw error;
  }
  return { kind: 'ok', entries: journalPage.entries, moreBeyond: journalPage.next, coverage };
}

function describeAnchorNotFound(afterId: string | undefined, afterAt: string | undefined): string {
  return (
    `afterId=${afterId ?? ''} afterAt=${afterAt ?? ''} が指す日誌の行が見つからない` +
    '（id と at の両方が一致する行が無い）。続きの位置は判定できない。' +
    '応答に出た「続きは …」の値を書き写し間違えていないか確かめること。' +
    '**日誌は読んでいない（先頭から読み直してもいない）。**'
  );
}

// 空を「無かった」と言わない: ストアは形の合わない行を `limit` の後で捨てるため、読めない行の向こうの行を無かったことにする
function describeUnreadablePageOnly(
  requested: number,
  order: 'asc' | 'desc' | undefined,
  moreBeyond: { id: string; at: string },
  horizonNoteLines: string[],
): string {
  return [
    `この頁の ${requested} 行は読めない形の行だけだった（日誌が無いのではない）。` +
      `さらに${order === 'asc' ? '新しい' : '古い'}側に行が在る。下の続きの位置を afterId / afterAt に渡せば、` +
      '読めない行の向こうへ進める（窓をずらして読み直す必要は無い）。',
    describeJournalContinuation(moreBeyond, order),
    ...horizonNoteLines,
  ].join('\n');
}

// ---- 0件のときの本文 ----

function describeEmptyJournalListing(
  args: JournalListArgs,
  normalizedSince: string | undefined,
  outcome: JournalListOutcome,
): string {
  const { q } = args;
  // 予算で打ち切った0件は「無い」と言わず、未探索の範囲を最初の行に出す
  if (q !== undefined && outcome.coverage.kind === 'budget') {
    return describeEmptyBudgetSearch(q, outcome.coverage, outcome);
  }
  if (q !== undefined) return describeEmptySearch(q, normalizedSince, outcome.horizonNoteLines);
  return describeEmptyListNote(args, outcome.horizonNoteLines);
}

// #5126。`conversation_read` の「この窓には無い（判定できない）」と同じ形
function describeEmptyBudgetSearch(
  q: string,
  coverage: Extract<JournalSearchCoverage, { kind: 'budget' }>,
  outcome: Pick<JournalListOutcome, 'budgetSeconds' | 'horizonNoteLines'>,
): string {
  return [
    `"${q}" は、この窓（${coverage.from} 〜 ${coverage.to}）には無い（判定できない）。` +
      `日誌を ${coverage.from} まで遡ったところで時間の予算（${outcome.budgetSeconds} 秒）を使い切り、それより古い側は見ていない。` +
      `古い側を探すには journal_read q="${q}" until=${journalSearchContinuationUntil(coverage.from)} を渡す（ほかの絞りは同じものを渡す）。`,
    `探す対象に入っていない欄（${JOURNAL_SEARCH_UNCOVERED_LIST}）にだけ書かれている語は、ここでは当たらない。`,
    ...outcome.horizonNoteLines,
  ].join('\n');
}

// `q` で0件でも、探す対象に入っていない欄が在ることまで言う: 黙ると「日誌にその語は無い」と読めるが tool_use の input に書かれているかもしれないため
function describeEmptySearch(
  q: string,
  normalizedSince: string | undefined,
  horizonNoteLines: string[],
): string {
  return [
    `"${q}" に当たる日誌は無い（この条件の中では）。` +
      `ただし ${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象外で、` +
      'そこにだけ書かれた語は当たらない。',
    ...(q === ''
      ? []
      : [
          normalizedSince === undefined
            ? '（日誌の先頭まで探した）'
            : `（since=${normalizedSince} まで探した。それより古い側は見ていない）`,
        ]),
    ...horizonNoteLines,
  ].join('\n');
}

// afterId があるときは「まだ空」と言わない: 続きの位置は実在の行を指しており、日誌は空ではないため
function describeEmptyListNote(args: JournalListArgs, horizonNoteLines: string[]): string {
  const { since, until, types, withFilter, afterId, order } = args;
  const emptyNote =
    afterId !== undefined &&
    since === undefined &&
    until === undefined &&
    types === undefined &&
    withFilter === undefined
      ? `（この位置より先（${order === 'asc' ? '新しい' : '古い'}側）に日誌の行は無い。日誌が空なのではない）`
      : since === undefined &&
          until === undefined &&
          types === undefined &&
          withFilter === undefined
        ? '（日誌はまだ空）'
        : '（その条件に当たる日誌は無い）';
  return [emptyNote, ...horizonNoteLines].join('\n');
}

// ---- 1件以上のときの本文 ----

function describeJournalListing(
  args: Pick<JournalListArgs, 'q' | 'types' | 'afterId' | 'order'>,
  outcome: JournalListOutcome,
): string {
  const { q, types, order } = args;
  const { entries, moreBeyond, coverage, budgetSeconds, horizonNoteLines } = outcome;
  // 予算を先に決めて入るところまで積む: 件数から出力量を決めると何件で壊れるかが運任せになるため
  // 同じ会話の行が2つ以上あるときだけ、長い id を凡例に1回書いて行では短い札（conv#1, conv#2…）にする: 会話 id（UUID）が exchange の行ごとに出て、一覧の約17%を占めるため。1回しか出ない id は札にしない（凡例の方が長くなる）
  const conversationLegend = journalConversationLegend(entries);
  const items = describeJournalListingItems(entries, conversationLegend.labels);
  const toolUseNotice = describeToolUseNotice(entries, types);
  const { listing, shownCount } = renderBudgetedListing(items, order);
  const cursor = describeListingCursorPosition(entries, shownCount, moreBeyond);
  // 当たりがあっても、予算で打ち切ったなら未探索の範囲を最初の行に出す: 一覧の末尾に置くと、出た分が全部だと読まれるため（#5126）
  const coverageHead = describeCoverageHead(q, coverage, budgetSeconds);
  return [
    ...coverageHead,
    ...conversationLegend.lines,
    listing,
    ...(cursor === null ? [] : [describeJournalContinuation(cursor, order)]),
    '（本文は抜粋。全文は journal_read id=<id> で取れる）',
    ...toolUseNotice,
    ...horizonNoteLines,
  ].join('\n');
}

// 1件ごとの行: `<at> <head> id=<id>` と、本文があれば抜粋の行
function describeJournalListingItems(
  entries: readonly JournalEntry[],
  conversationLabels: ReadonlyMap<string, string>,
): string[] {
  return entries.map((entry) => {
    const { head, body } = renderJournalEntry(
      entry,
      JOURNAL_LISTING_ATTACHMENTS,
      conversationLabels,
      clipListingHeadField,
    );
    return (
      `${entry.at} ${head} id=${entry.id}` +
      (body === '' ? '' : `\n  ${journalListingBody(entry, body)}`)
    );
  });
}

// `tool_use` の混み具合は習慣（types で絞るのを忘れない）に預けず、この呼びで数えた件数だけを言う: `tool_use` が decision / exchange を押し出す速さが上がったため
function describeToolUseNotice(
  entries: readonly JournalEntry[],
  types: JournalListArgs['types'],
): string[] {
  const toolUseCount = entries.filter((entry) => entry.type === 'tool_use').length;
  // 出す条件は取れた分が全部 tool_use だったか（`M === N`）ではなく呼びが渡した `types` で判定する: `types` を省略した呼びでは外せば判断の記録が出てくるため
  // 「だけを名指しした」は every で見る: `length === 1` だと重複指定が名指しでないことになり、外す先が無い呼びで断り書きが出るため
  const typesIsToolUseOnly =
    types !== undefined && types.length > 0 && types.every((type) => type === 'tool_use');
  return toolUseCount > 0 && !typesIsToolUseOnly
    ? [
        `（tool_use が今回の ${entries.length} 件中 ${toolUseCount} 件。` +
          '判断の記録だけを見るなら types で外せる）',
      ]
    : [];
}

// 予算（JOURNAL_BUDGET 字）で省略する。省略したときの断り書きと、表示した件数を返す
function renderBudgetedListing(
  items: string[],
  order: 'asc' | 'desc' | undefined,
): { listing: string; shownCount: number } {
  let shownCount = items.length;
  const listing = renderListing(items, {
    budget: JOURNAL_BUDGET,
    omitted: ({ rest, shown, total }) => {
      shownCount = shown;
      return (
        `…ほか ${rest} 件は省略（この条件で ${total} 件あり、${order === 'asc' ? '古い' : '新しい'}順に ${shown} 件だけ出した）。` +
        '省略した行から読み継ぐには、下の続きの位置を afterId / afterAt に渡すこと' +
        // asc では q を勧めない: q と order=asc の組は断られるため（勧めのとおりに呼ぶと失敗する）
        (order === 'asc'
          ? '（狭めるなら since / until / types / with を指定する）。'
          : '（狭めるなら since / types / with / q を指定する）。')
      );
    },
  });
  return { listing, shownCount };
}

// 予算で省略したときは `next` を案内しない: `next` は省略した行を飛び越えるため、表示した最後の行を続きの位置にする
function describeListingCursorPosition(
  entries: readonly JournalEntry[],
  shownCount: number,
  moreBeyond: { id: string; at: string } | null,
): { id: string; at: string } | null {
  const lastShown = entries[shownCount - 1];
  return shownCount < entries.length && lastShown !== undefined
    ? { id: lastShown.id, at: lastShown.at }
    : moreBeyond;
}

function describeCoverageHead(
  q: string | undefined,
  coverage: JournalSearchCoverage,
  budgetSeconds: number,
): string[] {
  return q !== undefined && coverage.kind === 'budget'
    ? [
        `（"${q}" は、日誌を ${coverage.from} まで遡ったところで時間の予算（${budgetSeconds} 秒）を使い切った。` +
          `${coverage.from} より古い側は見ていない。古い側を探すには journal_read until=${journalSearchContinuationUntil(coverage.from)} を渡す（ほかの絞りは同じものを渡す））`,
      ]
    : [];
}

// 省いた回は日誌の本文で名乗り `self_dropped` にも跡を残す: 道具は成功しているので、ここで残さないと「根拠が届かなかった」がどこにも出ないため
function noteJournalWriteGroundsNotDelivered(decision: string, grounds: string | undefined): void {
  if (grounds === undefined) {
    noteDroppedRecord(
      '判断の根拠（journal_write の grounds）',
      `decision.chars=${decision.length}`,
      new Error('呼び出しに grounds が届かなかった'),
    );
  }
}

function buildJournalWriteEntry(
  decision: string,
  grounds: string | undefined,
): { type: 'decision'; decision: string; grounds: string } {
  return { type: 'decision', decision, grounds: grounds ?? GROUNDS_NOT_DELIVERED };
}

function renderJournalWriteDone(entryId: string, grounds: string | undefined): string {
  return grounds === undefined
    ? `日誌に記録した（${entryId}）。⚠ grounds が呼び出しに届かなかったので、` +
        '根拠は「届かなかった」として残してある（あなたが「根拠なし」と' +
        '書いた場合とは区別してある）。根拠が在るなら、もう一度 grounds 付きで' +
        '呼べば別の行として残る。'
    : `日誌に記録した（${entryId}）。`;
}

export function journalTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;
  return [
    // `grounds` を必須にしない: 長い本文の後ろに必須の引数が残る形を持つのはこの道具だけで、呼び出しの組み立て破損で選択的に落ちるため
    // 届かなかった `grounds` を「根拠なし」と同じ文字列にしない: 「無い」の種類が潰れるため
    tool(
      'journal_write',
      [
        '判断を日誌に残す（追記専用）。',
        '人間に聞かずに実行した判断は必ずここに残すこと。',
        '人間が後から読んで否定できることが、最終承認の実体である。',
        'grounds を省くと、根拠は「呼び出しに届かなかった」として記録される（「根拠なし」とは区別される）。根拠が記憶に無いと判断したなら、省かずに「根拠なし」と書いて渡す。',
      ].join(' '),
      {
        decision: z.string().describe('何を判断し、何をしたか'),
        grounds: z
          .string()
          .optional()
          .describe(
            '記憶のどこに根拠があったか。無いなら「根拠なし」と書く。省いた呼び出しも記録は通るが、根拠は「届かなかった」として残る',
          ),
        closes: CLOSES_SCHEMA,
      },
      async ({ decision, grounds, closes }) => {
        const closesError = describeClosesViolation(closes);
        if (closesError !== null) return text(closesError);
        noteJournalWriteGroundsNotDelivered(decision, grounds);
        // 書き込みが落ちて投げたときは、ここから先へ進まない（1行も閉じない）
        const entry = await appendJournalOrThrow(
          'journal_write',
          stores.journal,
          buildJournalWriteEntry(decision, grounds),
          'act-not-performed',
        );
        return finishWithCloses(
          stores,
          text(renderJournalWriteDone(entry.id, grounds)),
          closes,
          true,
          'journal_write',
        );
      },
    ),

    // 全文を素で並べない: 出力上限で丸ごと落ちてクローンに1文字も届かないため、予算で抜粋にする
    tool(
      'journal_read',
      [
        '日誌を新しい順に読む。過去の一点を掘るには since/until で窓を閉じること',
        '（新しい順に返るので、until を指定しないと最新分しか見えない）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
        'q で本文を語で探せる（他の絞りと併用できる）。',
        'q で探すときは新しい側から1日ずつ遡り、時間の予算（8 秒）を使い切ったら、どこまで探したかと続きの until を最初の行で名乗って止まる。',
        '文脈窓超過の失敗は本文に `context_window_failure` を含むので、q で引ける。',
        '**q が当たらないことは「日誌にその語が無い」を意味しない** —',
        `${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていない。`,
        'with で exchange の相手を絞れる（他の絞りと併用できる）。',
        '**with を指定すると exchange 以外の種別は1件も返らない** —',
        'types で別途除く必要はない。',
        '応答に「続きは journal_read afterId=… afterAt=…」と出たら、その2つをそのまま渡すと',
        'その行の次（新しい順なら、より古い側）から読み継げる（ほかの絞りは同じものを渡す）。',
        '頁の行が全部読めない形だったときも、これで読めない区間の向こうへ進める。',
      ].join(' '),
      {
        limit: z
          .number()
          .optional()
          .describe(`件数（${formatIntRangeJa({ min: 1, max: 200 })}。既定 20）`),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        types: z
          .array(z.enum(JOURNAL_ENTRY_TYPES))
          .optional()
          .describe(
            '例 {"types":["escalation"]}。配列で渡し、値は引用符で囲む。種別で絞る。省略すると全種別',
          ),
        // 説明文は `conversation_read` の `q` と変えない: 同じ語で探す口の言い方が違うと違う意味論を疑われるため
        q: z
          .string()
          .optional()
          .describe('語で探す（大文字小文字を区別しない部分一致）。他の絞りと併用できる'),
        // キー名は `JournalQuery.with` に合わせて `with` のまま: 新しい呼び方を作らないため
        with: z
          .array(z.enum(EXCHANGE_WITH_VALUES))
          .optional()
          .describe('exchange の相手（human/manager/self）で絞る。省略すると絞らない'),
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
        afterId: z
          .string()
          .optional()
          .describe(
            '続きの位置の id。応答に出た「続きは journal_read afterId=… afterAt=…」の値をそのまま渡す。' +
              'afterAt と必ず対で渡す。この行の次から読む',
          ),
        afterAt: z
          .string()
          .optional()
          .describe(
            '続きの位置の時刻（ISO 8601）。afterId と必ず対で渡す。応答に出た値をそのまま渡すこと',
          ),
        order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe(
            '返す順序。既定 desc（新しい順）、asc で古い順。afterId / afterAt の「次」は返る順序の次なので、asc で読み継ぐときは order=asc も揃えて渡す。' +
              '**q とは組めない**（q は新しい側から遡る検索で、asc を指定すると断られる。古い側から読むなら since / until で窓を閉じる）',
          ),
      },
      async ({
        limit,
        since,
        until,
        types,
        q,
        with: withFilter,
        id,
        offset = 0,
        afterId,
        afterAt,
        order,
      }) => {
        const checked = checkJournalReadArgs({ limit, offset, id, q, order });
        if (checked.kind === 'refused') return text(checked.body);
        if (id !== undefined) return text(await readJournalEntryById(stores, id, offset));
        return text(
          await readJournalListing(context, stores, {
            limit,
            since,
            until,
            types,
            q,
            withFilter,
            afterId,
            afterAt,
            order,
          }),
        );
      },
    ),
  ];
}
