// 自分自身（alteroid）の正典と実行時の状態（self_*）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { codexChatgptAuthStatusOf, describeCodexChatgptAuth } from './codex-chatgpt-auth.js';
import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  reasonOf,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
} from './dropped-record.js';
import { encodeUsageCursor, findUsageCursorTies, resolveUsageCursor } from './usage-cursor.js';
import { describePage, excerptLine, fillListingBudget, page, renderListing } from './excerpt.js';
import { renderTurnTimingSummary, type TurnTimingEntry } from './turn-timing-format.js';
import { renderHttpTimingSummary, type HttpTimingEntry } from './http-timing-format.js';
import type { ManagerPool, RunnerFleetOverview } from './manager.js';
import {
  formatMemoryCreatedAt,
  measureMemoryFloor,
  renderMemoryDocuments,
  type MemoryPart,
} from './memory.js';
import type { MemoryDocumentMeta } from './schema.js';
import { describeManagerPeers } from './manager-peers-format.js';
import {
  CANON_REVISION,
  CLONE_RUNTIME_ITEM_LABELS,
  canonDocument,
  canonNames,
  describeCloneRuntime,
} from './self.js';
import { formatUsd, type UsageAggregate } from './usage.js';
import { describeIntRangeViolation, formatIntRangeJa } from './tool-arg-checks.js';
import {
  RUNNER_MANAGER_PEERS_EXCERPT,
  USAGE_AXIS_PAGE,
  renderRisenSection,
  maxUpdatedAt,
  USAGE_AXIS_LIMIT,
  tool,
  text,
} from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

// 名簿を読めなければ黙って省く: `self_status` の本題を、器の名簿の失敗で落とさないため
export async function renderPeerReach(managers: ManagerPool | undefined): Promise<string[]> {
  if (managers === undefined) return [];
  let overview: RunnerFleetOverview;
  try {
    overview = await managers.runners();
  } catch {
    return [];
  }
  const rows: { label: string; line: string }[] = [];
  for (const runner of overview.runners) {
    const line = describeManagerPeers(runner.managerPeers);
    if (line === undefined) continue;
    rows.push({ label: runner.runnerId ?? runner.label, line });
  }
  if (rows.length === 0) return [];
  return [
    '',
    // 開いている器と、閉じている器（理由つき）を並べる: ログイン済みなのに開いていない器を見せるため
    'マネージャーが peer（Codex など）に作業を頼めるか（器ごと。頼める器は manager_start の runnerId で名指しできる。詳細は runner_list）:',
    renderListing(
      rows.map((row) => `- ${row.label}: ${excerptLine(row.line, RUNNER_MANAGER_PEERS_EXCERPT)}`),
      {
        budget: SELF_STATUS_PEER_REACH_BUDGET,
        omitted: ({ rest, shown, total }) =>
          `…ほか ${rest} 台は省略（全 ${total} 台のうち ${shown} 台だけ出した。runner_list で全部見える）。`,
      },
    ),
  ];
}

const SELF_STATUS_PEER_REACH_BUDGET = 1600;

const CANON_PAGE = 8_000;

// 他の一覧と定数を共有しない: 片方だけ直したくなったときに一緒に動かないため
const SELF_DROPPED_BUDGET = 8_000;

const SELF_DROPPED_DEFAULT_LIMIT = 50;

// self_status の「直近のターンの時間」が読む件数（#5086）。中央値・90% 点が意味を持つ数で、1回の読みを軽く保つ
const SELF_STATUS_TURN_TIMING_LIMIT = 30;

// self_status の「HTTP API の時間」が読む窓の数（#5089）。10 分の窓で直近 2 時間ぶん
const SELF_STATUS_HTTP_TIMING_LIMIT = 12;

// `memory.ts` の `MEMORY_TOC_LINE_LIMIT` を使い回さない: 値が同じでも、片方だけ直したくなったときに一緒に動くため
const SELF_STATUS_MEMORY_DESCRIPTION_LIMIT = 120;

// `MEMORY_LISTING_BUDGET` より小さく取る: `self_status` は3節同居で、合計を一覧総当たり試験の `OUTPUT_CAP`（12,000）に収める必要があるため
const SELF_STATUS_MEMORY_LISTING_BUDGET = 3_500;

// 単位のラベル（文字 / bytes）を両方に必ず付ける: 単位が混ざると、読み手が bytes から文字数を割り戻すことになるため
// 並びは毎ターンの寄与が大きい順にする: slug 順のままだと予算に達したとき大きい premise でも黙って落ち、測れていない0を測ったつもりで読むため。`stores.persona.list()` 自体の並びは変えない: 他の面がその順に依存するため
function renderMemorySize(
  documents: MemoryDocumentMeta[],
  memoryDocuments: readonly MemoryPart[],
  totalMemory: string,
): string {
  const lines = [
    '## 記憶の大きさ（いま stores.persona を読み直した値）',
    '',
    `- 総文字数: ${totalMemory.length.toLocaleString('en-US')} 文字（${documents.length} 文書）`,
  ];
  if (documents.length === 0) return lines.join('\n');

  const floor = measureMemoryFloor(memoryDocuments);

  const contentBySlug = new Map(memoryDocuments.map((doc) => [doc.slug, doc]));
  const contribution = new Map(
    documents.map((doc) => {
      const part = contentBySlug.get(doc.slug);
      const chars = part === undefined ? 0 : measureMemoryFloor([part]).totalChars;
      return [doc.slug, chars] as const;
    }),
  );
  const sorted = [...documents].sort(
    (a, b) => (contribution.get(b.slug) ?? 0) - (contribution.get(a.slug) ?? 0),
  );

  const items = sorted.map((doc) => {
    const descriptor =
      doc.description === undefined
        ? ''
        : ` — ${excerptLine(doc.description, SELF_STATUS_MEMORY_DESCRIPTION_LIMIT)}`;
    const chars = contribution.get(doc.slug) ?? 0;
    return (
      `  - [${doc.kind}] ${doc.slug}: ${doc.title} ` +
      `(作成: ${formatMemoryCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt}) ` +
      `${doc.bytes.toLocaleString('en-US')} bytes / ${chars.toLocaleString('en-US')} 文字${descriptor}`
    );
  });

  lines.push(
    renderListing(items, {
      budget: SELF_STATUS_MEMORY_LISTING_BUDGET,
      omitted: ({ rest, shown, total }) =>
        `  …ほか ${rest} 文書は省略（全 ${total} 文書のうち ${shown} 文書だけ出した）。` +
        '全件は memory_list、本文は memory_read slug=<slug> で取れる。',
    }),
  );
  // 区分ごとの小計は文書一覧の後ろへ0字下げで置く: 2字下げのままだと総当たり試験が「5項目を満たさない文書」として撃つため
  // 蓋が噛んだ件数は同じ行で名乗り、噛んでいない回は足さない: 毎回付けると本当に噛んだときの目印が効かなくなるため
  const demotedSuffix =
    floor.demotedPremiseDocs === 0
      ? ''
      : `。⚠️ うち ${floor.demotedPremiseDocs.toLocaleString('en-US')} 文書は束ねた予算に当たって` +
        'カードを落とし、1行になっている（節の目次は焼かれていない。' +
        '落ちた文書の名前と直し方は焼き込みの断り書きに在り、節は memory_outline で開ける）';
  lines.push(
    `- premise 合計: ${floor.premiseChars.toLocaleString('en-US')} 文字（${floor.premiseDocs} 文書。毎ターン「要旨＋節の目次」が焼かれる${demotedSuffix}）`,
    `- indexed 合計: ${floor.indexedChars.toLocaleString('en-US')} 文字（${floor.indexedDocs} 文書。毎ターン要旨だけが焼かれる。節の目次は焼かれない）`,
    `- fact 目次合計: ${floor.tocChars.toLocaleString('en-US')} 文字（${floor.factDocs} 文書。目次の1行だけが焼かれる）`,
  );
  return lines.join('\n');
}

// 「あなたの消費が台帳に載っている／載っていない」と書かない: 台帳の軸が変わった瞬間に嘘になるため、軸そのものを構造として出す
// 畳む鍵に層と場所を入れる: クローンとマネージャーはどちらも opus で同じモデル id に並び、`managerId` だけだと見分けられないため
// 素の位置ではなく keyset の `ledgerCursor`: 内訳が委譲の進行で順位を変えると欠落・重複を生むため。3項目は区切り文字（`\u0000`）で連結した合成ラベルにする: 区切りが個々のフィールドより小さい codepoint なら `localeCompare` がタプル比較と同じ順序になるため
// 軸の名前は `'ledger'`: `UsageAxis` のどれとも重ならず、`usage_read` の cursor との取り違えが `wrong-axis` で断られるため
const LEDGER_CURSOR_AXIS = 'ledger';

const LEDGER_LABEL_SEP = '\u0000';

function renderLedgerCrossReference(
  sdkModel: string | null,
  aggregate: UsageAggregate | null,
  ledgerCursor?: string,
): string {
  const lines = ['## 台帳との突き合わせ（軸: 日 × actor × モデル × 層 × 場所）', ''];

  if (sdkModel === null) {
    lines.push('まだ init を観測していないので、SDK のモデル id が分からず突き合わせられない。');
    return lines.join('\n');
  }
  if (aggregate === null || aggregate.since === null) {
    lines.push(`台帳にはまだ1件も記録が無い（いまのモデル id: ${sdkModel}）。`);
    return lines.join('\n');
  }

  const matches = aggregate.rows.filter((row) => row.model === sdkModel);
  if (matches.length === 0) {
    lines.push(`モデル id ${sdkModel} と同じ行は無い（台帳の始点: ${aggregate.since}）。`);
    return lines.join('\n');
  }

  const buckets = new Map<
    string,
    { managerId: string; layer: string; site: string; costUsd: number; updatedAt: string }
  >();
  for (const row of matches) {
    const key = `${row.managerId} ${row.layer} ${row.site}`;
    const found = buckets.get(key);
    if (found === undefined) {
      buckets.set(key, {
        managerId: row.managerId,
        layer: row.layer,
        site: row.site,
        costUsd: row.totals.costUsd,
        updatedAt: row.updatedAt,
      });
    } else {
      found.costUsd += row.totals.costUsd;
      if (row.updatedAt > found.updatedAt) found.updatedAt = row.updatedAt;
    }
  }
  const entries = [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      label: [bucket.managerId, bucket.layer, bucket.site].join(LEDGER_LABEL_SEP),
      cost: bucket.costUsd,
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        a.managerId.localeCompare(b.managerId) ||
        a.layer.localeCompare(b.layer) ||
        a.site.localeCompare(b.site),
    );

  const formatEntry = (entry: (typeof entries)[number]): string =>
    `  - managerId: "${entry.managerId}" / layer: ${entry.layer} / site: ${entry.site}` +
    ` / 合計 ${formatUsd(entry.costUsd)}`;

  const cursorOutcome = resolveUsageCursor(entries, LEDGER_CURSOR_AXIS, ledgerCursor);
  if (cursorOutcome.kind === 'malformed') {
    lines.push(
      'ledgerCursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
        'ledgerCursor を付けずに self_status を呼び直すと先頭の内訳から読める。',
    );
    return lines.join('\n');
  }
  if (cursorOutcome.kind === 'wrong-axis') {
    lines.push(
      'ledgerCursor が別の文脈（usage_read の axis 用など）のものである。' +
        'self_status が返した ledgerCursor をそのまま渡すこと。',
    );
    return lines.join('\n');
  }
  const { page: afterAnchor, risen } = cursorOutcome;

  if (ledgerCursor !== undefined) {
    lines.push(`モデル id ${sdkModel} の行の内訳（全 ${entries.length} 件）:`);
    const page = afterAnchor.slice(0, USAGE_AXIS_PAGE);
    if (page.length === 0) {
      lines.push('  （ledgerCursor より後ろは無い。これが最後の頁）');
      lines.push(...renderRisenSection(risen, formatEntry));
      return lines.join('\n');
    }
    for (const entry of page) lines.push(formatEntry(entry));
    const rest = afterAnchor.length - page.length;
    if (rest > 0) {
      const lastShown = page[page.length - 1]!;
      const nextAsOf = maxUpdatedAt(matches);
      const nextCursor = encodeUsageCursor({
        axis: LEDGER_CURSOR_AXIS,
        label: lastShown.label,
        cost: lastShown.cost,
        asOf: nextAsOf,
        tiedAtAsOf: findUsageCursorTies(entries, LEDGER_CURSOR_AXIS, lastShown, nextAsOf),
      });
      lines.push(
        `  …（残り ${rest} 件は出していない。self_status の ledgerCursor=${nextCursor} で続きが出る）`,
      );
    }
    lines.push(...renderRisenSection(risen, formatEntry));
    return lines.join('\n');
  }

  lines.push(
    `モデル id ${sdkModel} の行の内訳（台帳の軸そのもの。行には必ず actor と層と場所が付く）:`,
  );
  for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) lines.push(formatEntry(entry));
  if (entries.length > USAGE_AXIS_LIMIT) {
    const lastShown = entries[USAGE_AXIS_LIMIT - 1]!;
    const nextAsOf = maxUpdatedAt(matches);
    const nextCursor = encodeUsageCursor({
      axis: LEDGER_CURSOR_AXIS,
      label: lastShown.label,
      cost: lastShown.cost,
      asOf: nextAsOf,
      tiedAtAsOf: findUsageCursorTies(entries, LEDGER_CURSOR_AXIS, lastShown, nextAsOf),
    });
    lines.push(
      `  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない。` +
        `self_status の ledgerCursor=${nextCursor} で続きが出る）`,
    );
  }
  return lines.join('\n');
}

type SelfStatusStores = CloneToolsShared['stores'];
type SelfStatusRuntime = NonNullable<ReturnType<NonNullable<ToolContext['runtime']>>>;
type SelfStatusRunnerModels =
  Awaited<ReturnType<NonNullable<ToolContext['runnerModels']>>> | undefined;
type SelfStatusRunnerRoutes =
  Awaited<ReturnType<NonNullable<ToolContext['runnerAnthropicRoutes']>>> | undefined;

function renderSelfStatusRuntimeUnavailable(): string {
  return (
    'いまは自分の実行時の事実を読めない場面である（記憶へ移すための内部ターン）。' +
    '次の会話で呼ぶこと。'
  );
}

async function readSelfStatusLedgerPage(
  stores: SelfStatusStores,
  runtime: SelfStatusRuntime,
  ledgerCursor: string,
): Promise<string> {
  const aggregate = runtime.sdkModel === null ? null : await stores.usage.aggregate({});
  return renderLedgerCrossReference(runtime.sdkModel, aggregate, ledgerCursor);
}

// 読めなければ黙らずに言う
function renderSelfStatusCodexAuth(
  record: Parameters<typeof codexChatgptAuthStatusOf>[0] | null,
): string | null {
  return record === null ? null : describeCodexChatgptAuth(codexChatgptAuthStatusOf(record));
}

function renderSelfStatusCodexAuthUnreadable(error: unknown): string {
  return `Codex の ChatGPT ログイン: 正本を読めなかった（${reasonOf(error)}）`;
}

function renderSelfStatusTurnTiming(entries: { type: string }[]): string {
  return renderTurnTimingSummary(
    entries.filter((entry): entry is TurnTimingEntry => entry.type === 'turn_timing'),
  );
}

function renderSelfStatusTurnTimingUnreadable(error: unknown): string {
  return `直近のターンの時間: 日誌を読めなかった（${reasonOf(error)}）。`;
}

function renderSelfStatusHttpTiming(entries: { type: string }[]): string {
  return renderHttpTimingSummary(
    entries.filter((entry): entry is HttpTimingEntry => entry.type === 'http_timing'),
  );
}

function renderSelfStatusHttpTimingUnreadable(error: unknown): string {
  return `HTTP API の時間: 日誌を読めなかった（${reasonOf(error)}）。`;
}

function renderSelfStatusFull(args: {
  runtime: SelfStatusRuntime;
  runnerModels: SelfStatusRunnerModels;
  runnerAnthropicRoutes: SelfStatusRunnerRoutes;
  documents: Awaited<ReturnType<SelfStatusStores['persona']['list']>>;
  memoryDocuments: Awaited<ReturnType<SelfStatusStores['persona']['documents']>>;
  aggregate: UsageAggregate | null;
  codexAuth: string | null;
  turnTiming: string;
  httpTiming: string;
  peerReach: string[];
}): string {
  const { runtime, runnerModels, runnerAnthropicRoutes } = args;
  return [
    describeCloneRuntime({
      ...runtime,
      ...(runnerModels === undefined ? {} : { runnerModels }),
      ...(runnerAnthropicRoutes === undefined ? {} : { runnerAnthropicRoutes }),
    }),
    ...(args.codexAuth === null ? [] : [args.codexAuth]),
    '',
    // クローンの文脈へ実際に載る形で数える: 本文だけを足すと、見出しのぶんだけ本当より少ない数を名乗るため
    renderMemorySize(
      args.documents,
      args.memoryDocuments,
      renderMemoryDocuments(args.memoryDocuments),
    ),
    '',
    renderLedgerCrossReference(runtime.sdkModel, args.aggregate),
    '',
    args.turnTiming,
    '',
    args.httpTiming,
    ...args.peerReach,
  ].join('\n');
}

async function readSelfStatusFull(
  context: ToolContext,
  stores: SelfStatusStores,
  runtime: SelfStatusRuntime,
): Promise<string> {
  const runnerModels = await context.runnerModels?.();
  const runnerAnthropicRoutes = await context.runnerAnthropicRoutes?.();
  const [documents, memoryDocuments, aggregate, codexAuth, turnTiming, httpTiming] =
    await Promise.all([
      stores.persona.list(),
      stores.persona.documents(),
      runtime.sdkModel === null ? Promise.resolve(null) : stores.usage.aggregate({}),
      stores.codexAuth.get().then(renderSelfStatusCodexAuth, renderSelfStatusCodexAuthUnreadable),
      // 直近のターンの時間（#5086）。読むのは種別と件数で絞った行だけで、この呼び出しのときにしか読まない
      stores.journal
        .list({ types: ['turn_timing'], limit: SELF_STATUS_TURN_TIMING_LIMIT })
        .then(renderSelfStatusTurnTiming, renderSelfStatusTurnTimingUnreadable),
      // HTTP API の時間（#5089）。同じく種別と件数で絞って読む
      stores.journal
        .list({ types: ['http_timing'], limit: SELF_STATUS_HTTP_TIMING_LIMIT })
        .then(renderSelfStatusHttpTiming, renderSelfStatusHttpTimingUnreadable),
    ]);

  const peerReach = await renderPeerReach(context.managers);
  return renderSelfStatusFull({
    runtime,
    runnerModels,
    runnerAnthropicRoutes,
    documents,
    memoryDocuments,
    aggregate,
    codexAuth,
    turnTiming,
    httpTiming,
    peerReach,
  });
}

export function selfTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;
  return [
    tool(
      'self_read',
      [
        '自分自身（alteroid）の正典を1つ読む。',
        '自分が何で出来ているか・何が要件か・どう設計されているか・何が未着手かはここにある。',
        'ビルド時に焼き込んだ写しなので、実装の最新が要るならマネージャーにリポジトリを読ませること。',
        '長いので切れて出る（続きの取り方が出力に付く）。',
      ].join(' '),
      {
        document: z
          .string()
          .describe(`正典の名前。読めるのは ${canonNames().join(' / ')}（上ほど優先順位が高い）`),
        offset: z
          .number()
          .optional()
          .describe(`何文字目から読むか（${formatIntRangeJa({ min: 0 })}。既定 0）`),
      },
      async ({ document, offset = 0 }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const doc = canonDocument(document);
        if (doc === undefined) {
          return text(`正典 ${document} は無い。読めるのは ${canonNames().join(' / ')}。`);
        }
        const part = page(doc.content, offset, CANON_PAGE);
        const tail = part.more
          ? `\n\n…（ここで切れている。続きは self_read document=${doc.name} offset=${part.to}）`
          : '';
        return text(
          `${doc.path}（${CANON_REVISION.length > 0 ? `リビジョン ${CANON_REVISION}` : 'リビジョン不明'} の写し / ${describePage(part)}）\n\n${part.body}${tail}`,
        );
      },
    ),

    tool(
      'self_status',
      [
        // 項目を数え直さず `CLONE_RUNTIME_ITEM_LABELS` から導出する: 散文に書くと実出力とずれて腐るが、クローンは道具の説明しか読まないので列挙は残す
        `いま自分が何で走っているかを返す（${CLONE_RUNTIME_ITEM_LABELS.join('・')}）。`,
        'これに加えて、いまの記憶の大きさと、台帳との突き合わせも出る。',
        '**effort はこのセッションで最初の道具呼び出しでは取れない**（前の道具呼び出しの結果として',
        '観測するため）。モデルが effort に対応していない場合もずっと取れない。',
        '取れない値は「まだ分からない」と出る（既定値では埋めない）。',
        // 素の位置ではなく keyset の `ledgerCursor` にする: 台帳は増え続け、途中で内訳の順位が入れ替わると欠落・重複を生むため
        '台帳との突き合わせの内訳は14件で打ち切る。続きは ledgerCursor で辿れる' +
          '（打ち切りの行にそのまま書いてある。ledgerCursor を渡すとその節だけを出す。' +
          '前回の呼び出し以降に記録が増えていたら、順位が上がった行が別枠で出ることがある）。',
      ].join(' '),
      {
        ledgerCursor: z
          .string()
          .optional()
          .describe(
            '台帳との突き合わせの内訳の続きを読む位置。前回の応答の断り書きに出た ledgerCursor を' +
              'そのまま渡す（自分で組み立てない。実行時の事実・記憶の大きさは出ない）',
          ),
      },
      async ({ ledgerCursor }) => {
        const runtime = context.runtime?.();
        if (runtime === undefined) return text(renderSelfStatusRuntimeUnavailable());

        // 続きを取りに来た呼び出しは、その節だけを返す: 続きを辿るたびに同じ全体が返ると、辿るほど入力を食うため
        if (ledgerCursor !== undefined) {
          return text(await readSelfStatusLedgerPage(stores, runtime, ledgerCursor));
        }
        return text(await readSelfStatusFull(context, stores, runtime));
      },
    ),

    // `journal_read` と二重に持たない: 日誌は起きたことを持ち、ここは日誌そのものへは書けなかった側を持つ
    // `cursor` ではなく `offset` にする: 帳面はプロセス内の配列で、直近から何件スキップするかの整数で足りるため
    tool(
      'self_dropped',
      [
        '自分（クローン）が記録・読み出しをしそこねた跡（`noteDroppedRecord` 等が',
        'stderr へ残す行）を、このプロセスの中から読み戻す。',
        '器の外（Railway 等のホスティング先のログ）へ出ている生の stderr の代わりではない',
        '——そちらは既に人間が読める。ここは、器の中からは1行も遡れなかった',
        '穴を塞ぐためのものである。',
        'このプロセスが生きているあいだの直近の分だけを持つ（帳面の保持件数は',
        `${RECENT_TRACE_LIMIT} 件。それより古い分はこのプロセスの中には無く、器の外の`,
        'stderr を見るしかない）。再起動・デプロイの入れ替えでも消える。',
        '予算で切れた古い側は offset で読み進められる（limit を上げても境界は動かない）。',
      ].join(' '),
      {
        limit: z
          .number()
          .optional()
          .describe(
            `一度に対象にする件数（${formatIntRangeJa({ min: 1, max: RECENT_TRACE_LIMIT })}。既定 ${SELF_DROPPED_DEFAULT_LIMIT}、最大 ${RECENT_TRACE_LIMIT}` +
              '＝帳面が保持している件数そのもの）。⚠️ 予算（文字数）が先に尽きることが' +
              'あり、そのときはこれを上げても実際に載る内容は動かない——古い側へ進むには' +
              '`offset` を使うこと。',
          ),
        offset: z
          .number()
          .optional()
          .describe(
            `直近から数えて何件をスキップしてから見るか（${formatIntRangeJa({ min: 0, max: RECENT_TRACE_LIMIT })}。既定 0＝最新から）。` +
              '前回の応答の断り書きに出た offset をそのまま渡せば、' +
              '予算や limit で切れて省略された古い側へ実際に進める。',
          ),
      },
      async ({ limit = SELF_DROPPED_DEFAULT_LIMIT, offset = 0 }) => {
        const limitError = describeIntRangeViolation('limit', limit, {
          min: 1,
          max: RECENT_TRACE_LIMIT,
        });
        if (limitError !== null) return text(limitError);
        const offsetError = describeIntRangeViolation('offset', offset, {
          min: 0,
          max: RECENT_TRACE_LIMIT,
        });
        if (offsetError !== null) return text(offsetError);
        const origin = describeDroppedTraceOrigin('daemon');
        const since = `この帳面が数え始めたのは ${droppedTraceLedgerSince()}。`;
        const all = recentDroppedTraces();
        if (all.length === 0) {
          return text([describeDroppedTraceEmpty(), origin, since].join(' '));
        }
        // `limit` と予算の両方をこの1本の窓に通す: どちらで切れても、次に渡す offset を同じ式（`skip + shown`）で組めるようにするため
        const skip = Math.min(offset, all.length);
        const windowed = skip === 0 ? all : all.slice(0, all.length - skip);
        if (windowed.length === 0) {
          return text(
            `offset（${String(offset)}）が帳面の件数（${String(all.length)}）以上なので、` +
              `これより古い分は無い。offset を ${String(all.length - 1)} 以下にして呼び直すこと。 ` +
              `${origin} ${since}`,
          );
        }
        const traces = windowed.slice(-limit);
        const fill = fillListingBudget(traces, SELF_DROPPED_BUDGET, true);
        // 残りは `limit` で除外された分と予算で除外された分を1つに数える: 呼び手にどちらが原因かを区別させないため
        const remaining = windowed.length - fill.shown;
        const nextOffset = skip + fill.shown;
        const lines = [...fill.lines];
        if (remaining > 0) {
          lines.unshift(
            `…ほか古い ${String(remaining)} 件は省略（帳面には全 ${String(all.length)} 件あり、` +
              `直近から ${String(fill.shown)} 件だけ出した）。続きは ` +
              `self_dropped offset=${String(nextOffset)} で取れる（limit を上げても動かない）。`,
          );
        }
        return text(
          [
            lines.join('\n'),
            origin,
            `（${describeDroppedTraceRetention(RECENT_TRACE_LIMIT)} ${since}）`,
          ].join('\n'),
        );
      },
    ),
  ];
}
