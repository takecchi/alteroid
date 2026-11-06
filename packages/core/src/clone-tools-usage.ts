// 日報と使用量（daily_report_write / usage_read）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { encodeUsageCursor, findUsageCursorTies, resolveUsageCursor } from './usage-cursor.js';
import { localDate, localDayRange } from './schedule.js';
import type { Stores } from './store.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  describeUnreadableUsage,
  describeUnreadableUsageRows,
  describeUnmeteredUsage,
  describeUnrecordedManagers,
  describeUsageDateOrder,
  describeWebSearchRequests,
  findUnrecordedManagers,
  formatUsd,
  isRealUsageDate,
  summarizeUsage,
  usageLayerSchema,
  usageSiteSchema,
  type UsageAggregate,
  type UsageBreakdown,
  type UsageLayer,
  type UsageRow,
  type UsageSite,
  type UsageTotals,
} from './usage.js';
import { describeStringLengthViolation, formatStringLengthJa } from './tool-arg-checks.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import {
  USAGE_AXIS_PAGE,
  maxUpdatedAt,
  renderRisenSection,
  USAGE_AXIS_LIMIT,
  tool,
  appendJournalOrThrow,
  text,
} from './clone-tools-common.js';

export const USAGE_AXES = ['date', 'manager', 'model', 'layer', 'site', 'token'] as const;

type UsageAxis = (typeof USAGE_AXES)[number];

// `USAGE_AXIS_TITLES` と分ける: 見出しと、その軸が何で切っているかの注記は用途が違うため
const USAGE_AXIS_NOTES: Record<UsageAxis, string> = {
  date: '日',
  manager: '誰の分か',
  model: 'どのモデルで',
  layer: '誰が: clone / manager',
  site: 'どこで: session / distill / peer',
  token: 'どの認証トークンで',
};

const USAGE_AXIS_TITLES: Record<UsageAxis, string> = {
  date: '日別',
  manager: 'マネージャー別',
  model: 'モデル別',
  layer: '層別（誰が）',
  site: '場所別（どこで）',
  token: '認証トークン別',
};

interface UsageAxisEntry {
  label: string;
  totals: UsageTotals;
  // 無いときは `0` にせず欄そのものを持たない: `model` の枝は `UsageBreakdown.byModel` に欄が無く渡せないため
  turns?: number;
  updatedAt: string;
  cost: number;
}

// 定数へ寄せて書き写さない: 畳んだラベルの綴りが1文字でもずれると `updatedAt` の引き当てが外れて静かに握り潰すため
const USAGE_TOKEN_UNATTRIBUTED_LABEL = '（トークンの帰属が無い分）';

// `usageAxisEntries` と同じ鍵の取り方をする: ずれると `resolveUsageCursor` の取りこぼし対策が誤動作するため
function usageAxisUpdatedAtByLabel(
  rows: readonly UsageRow[],
  axis: UsageAxis,
): Map<string, string> {
  const map = new Map<string, string>();
  const bump = (label: string, updatedAt: string) => {
    const found = map.get(label);
    if (found === undefined || updatedAt > found) map.set(label, updatedAt);
  };
  for (const row of rows) {
    switch (axis) {
      case 'date':
        bump(row.date, row.updatedAt);
        break;
      case 'manager':
        bump(row.managerId, row.updatedAt);
        break;
      case 'model':
        bump(row.model, row.updatedAt);
        break;
      case 'layer':
        bump(row.layer, row.updatedAt);
        break;
      case 'site':
        bump(row.site, row.updatedAt);
        break;
      case 'token':
        bump(row.tokenId ?? USAGE_TOKEN_UNATTRIBUTED_LABEL, row.updatedAt);
        break;
    }
  }
  return map;
}

// まとめ表示と `axis` モードが同じここを通る: 並びが違うとページングが取りこぼすか重複するため
// 全順序にする（費用降順 → ラベル昇順）: 費用の降順だけだと同額のときの順序が実装の偶然に依存するため
// `summary` に `updatedAt` を足さない: ブラウザと共有する型で、HTTP の応答の形が変わるため同じ `rows` から別に畳む
function usageAxisEntries(
  summary: UsageBreakdown,
  axis: UsageAxis,
  rows: readonly UsageRow[],
): UsageAxisEntry[] {
  const updatedAtByLabel = usageAxisUpdatedAtByLabel(rows, axis);
  // 見つからなければ `risen` へ回さない安全側（最古のタイムスタンプ）に倒す: 「常に伸びた」と誤解して余計な節を出すより安全なため
  const updatedAtOf = (label: string): string => updatedAtByLabel.get(label) ?? '';
  const withUpdatedAt = <E extends { label: string; totals: UsageTotals }>(
    e: E,
  ): E & { updatedAt: string; cost: number } => ({
    ...e,
    updatedAt: updatedAtOf(e.label),
    cost: e.totals.costUsd,
  });
  const byCost = (entries: UsageAxisEntry[]) =>
    entries.sort((a, b) => b.totals.costUsd - a.totals.costUsd || a.label.localeCompare(b.label));
  switch (axis) {
    case 'date':
      // 日別は新しい順: 古い日で上限を使い切らせないため
      return summary.byDate
        .map((entry) =>
          withUpdatedAt({ label: entry.date, totals: entry.totals, turns: entry.turns }),
        )
        .sort((a, b) => b.label.localeCompare(a.label));
    case 'manager':
      return byCost(
        summary.byManager.map((e) =>
          withUpdatedAt({ label: e.managerId, totals: e.totals, turns: e.turns }),
        ),
      );
    case 'model':
      return byCost(
        summary.byModel.map((e) => withUpdatedAt({ label: e.model, totals: e.totals })),
      );
    case 'layer':
      return byCost(
        summary.byLayer.map((e) =>
          withUpdatedAt({ label: e.layer, totals: e.totals, turns: e.turns }),
        ),
      );
    case 'site':
      return byCost(
        summary.bySite.map((e) =>
          withUpdatedAt({ label: e.site, totals: e.totals, turns: e.turns }),
        ),
      );
    case 'token':
      // `null` を「記録が無い」と書き、id を捏造しない: 空文字や `'unknown'` だと1本のトークンに見え、費用をそこへ帰属させた話が始まるため
      return byCost(
        summary.byToken.map((e) =>
          withUpdatedAt({
            label: e.tokenId ?? USAGE_TOKEN_UNATTRIBUTED_LABEL,
            totals: e.totals,
            turns: e.turns,
          }),
        ),
      );
  }
}

// `turns` が無いときは `0回` とも `-` とも書かない
function formatUsageAxisLine(entry: UsageAxisEntry): string {
  const cost = formatUsd(entry.totals.costUsd);
  if (entry.turns === undefined) return `  ${entry.label}: ${cost}`;
  return `  ${entry.label}: ${cost} / ${entry.turns}回 / 1回 ${formatUsd(entry.totals.costUsd / entry.turns)}`;
}

// 文言を書き写さない: 同じ値を見る口の間で言い方が分かれ、いつか片方だけが「取れなかった」を 0 と描くため
function renderAccountUsage(state: AccountUsageState): string {
  return [`## ${ACCOUNT_USAGE_TITLE}`, ...describeAccountUsage(state)].join('\n');
}

// `context.managers` が `undefined` のとき 0 と出さず「確かめられなかった」と明示する: 空配列と同じ形にすると蒸留の場では常に「取りこぼしは無い」と嘘をつくため
async function unrecordedManagersLines(
  context: ToolContext,
  stores: Stores,
  since: string | null,
): Promise<string[]> {
  if (context.managers === undefined) {
    return [
      '⚠ 台帳に1行も記録が無い委譲: 確かめられなかった' +
        '（この場ではマネージャーの一覧が読めない。0 件ではない）。',
    ];
  }
  const [managers, recordedManagerIds] = await Promise.all([
    context.managers.list(),
    stores.usage.recordedManagerIds(),
  ]);
  return describeUnrecordedManagers(findUnrecordedManagers(managers, recordedManagerIds, since));
}

function renderUsage(
  aggregate: UsageAggregate,
  view: {
    axis?: UsageAxis;
    cursor?: string;
    // `undefined` は「軸モードなので出さない」であって「取りこぼしが無い」ではない
    unrecordedManagers?: readonly string[];
  } = {},
): string {
  const {
    rows,
    turnRows,
    since,
    layersSince,
    tokensSince,
    turnsSince,
    beforeLedger,
    beforeLayers,
    beforeTokens,
    beforeTurns,
    notice,
  } = aggregate;
  const unreadableRowsLines = describeUnreadableUsageRows(aggregate.unreadableRows);
  const unmeteredLines = describeUnmeteredUsage(aggregate.unmeteredRows);

  if (since === null) {
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
      ...unreadableRowsLines,
      ...unmeteredLines,
      ...(view.unrecordedManagers === undefined ? [] : ['', ...view.unrecordedManagers]),
    ].join('\n');
  }

  const summary = summarizeUsage(rows, turnRows);
  const lines: string[] = [];

  if (view.axis !== undefined) {
    // 軸モードではまとめ表示も他の軸も出さない: 続きを取るたびに同じ全体が返ると、辿るほど入力を食うため
    const axis = view.axis;
    const entries = usageAxisEntries(summary, axis, rows);
    const cursorOutcome = resolveUsageCursor(entries, axis, view.cursor);
    if (cursorOutcome.kind === 'malformed') {
      lines.push(
        `${USAGE_AXIS_TITLES[axis]}`,
        'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
          `cursor を付けずに axis="${axis}" で usage_read を呼び直すと先頭から読める。`,
      );
      return lines.join('\n');
    }
    if (cursorOutcome.kind === 'wrong-axis') {
      lines.push(
        `${USAGE_AXIS_TITLES[axis]}`,
        `cursor が別の軸（または self_status）のものである。axis="${axis}" の cursor を` +
          'そのまま渡すこと（自分で組み立てない）。',
      );
      return lines.join('\n');
    }
    const { page: afterAnchor, risen } = cursorOutcome;
    lines.push(`${USAGE_AXIS_TITLES[axis]}（全 ${entries.length} 件）`);
    const page = afterAnchor.slice(0, USAGE_AXIS_PAGE);
    if (page.length === 0) {
      // 黙って空を返さない: 空の一覧だけでは「この軸には記録が無い」と「最後の頁」を区別できないため
      lines.push(
        view.cursor === undefined
          ? `  （その軸には記録が無い）`
          : '  （cursor より後ろは無い。これが最後の頁）',
      );
    } else {
      for (const entry of page) {
        lines.push(formatUsageAxisLine(entry));
      }
      const rest = afterAnchor.length - page.length;
      if (rest > 0) {
        const lastShown = page[page.length - 1]!;
        const nextAsOf = maxUpdatedAt(rows);
        const nextCursor = encodeUsageCursor({
          axis,
          label: lastShown.label,
          cost: lastShown.totals.costUsd,
          asOf: nextAsOf,
          tiedAtAsOf: findUsageCursorTies(entries, axis, lastShown, nextAsOf),
        });
        lines.push(
          `  …（残り ${rest} 件は出していない。` +
            `axis="${axis}", cursor="${nextCursor}" で続きが出る）`,
        );
      }
    }
    lines.push(...renderRisenSection(risen, formatUsageAxisLine));
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
  } else if (rows.length === 0) {
    lines.push('その範囲には記録が無い。');
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
    // 取りこぼしは照会範囲と無関係に全期間で判定するので、この範囲に台帳の行が無くても出す
    if (view.unrecordedManagers !== undefined) lines.push('', ...view.unrecordedManagers);
  } else {
    lines.push(
      `合計 ${formatUsd(summary.total.costUsd)}` +
        (summary.turns === undefined
          ? ''
          : ` / ${summary.turns}回 / 1回 ${formatUsd(summary.total.costUsd / summary.turns)}`),
    );
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}` +
        describeWebSearchRequests(summary.total),
    );
    lines.push(...describeUnreadableUsage(summary.total));
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
    if (view.unrecordedManagers !== undefined) lines.push(...view.unrecordedManagers);

    for (const axis of USAGE_AXES) {
      const entries = usageAxisEntries(summary, axis, rows);
      lines.push('', `${USAGE_AXIS_TITLES[axis]}:`);
      for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) {
        lines.push(formatUsageAxisLine(entry));
      }
      if (entries.length > USAGE_AXIS_LIMIT) {
        const lastShown = entries[USAGE_AXIS_LIMIT - 1]!;
        const nextAsOf = maxUpdatedAt(rows);
        const nextCursor = encodeUsageCursor({
          axis,
          label: lastShown.label,
          cost: lastShown.totals.costUsd,
          asOf: nextAsOf,
          tiedAtAsOf: findUsageCursorTies(entries, axis, lastShown, nextAsOf),
        });
        lines.push(
          `  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない。` +
            `axis="${axis}", cursor="${nextCursor}" で続きが出る）`,
        );
      }
    }
    // 回数が1つでも出ているときだけ、モデル別に出ない理由を書く: 出さないと「モデル別だけ0回」に読めるため
    if (summary.turns !== undefined) {
      lines.push(
        '',
        'モデル別に回数は出さない（1ターンが複数のモデル行を作るので、回数をモデルへ帰属させられない）。',
      );
    }
  }

  lines.push('', `台帳の始点: ${since}`);
  if (beforeLedger) {
    // 0 と言わない: 台帳が無かった期間を「使っていない期間」と読ませないため
    lines.push(
      '照会した範囲は台帳の始点より前にかかっている。その分は **0 ではなく「記録が無い」**。',
    );
  }
  // 層の始点を台帳の始点と混ぜない: 層の軸は台帳より後から入ったので、それより前の行の層と場所は既定値で観測ではないため
  lines.push(
    layersSince === null
      ? '層と場所の軸はまだ1件も記録していない。'
      : `層と場所の軸の始点: ${layersSince}`,
  );
  if (beforeLayers) {
    lines.push(
      '照会した範囲は層と場所の軸の始点より前にかかっている。' +
        'その分の層と場所は **既定値であって観測ではない**（クローンが使っていなかった、' +
        '蒸留が起きていなかった、とは読まないこと）。',
    );
  }
  // トークンの軸の始点を上の2つと混ぜない: null はプールを使っていないので取れないこともあり、「トークンを回していない」と読ませないため
  lines.push(
    tokensSince === null
      ? '認証トークンの軸はまだ1件も記録していない' +
          '（プールを使っていない構成なら、これが正常である）。'
      : `認証トークンの軸の始点: ${tokensSince}`,
  );
  if (beforeTokens) {
    lines.push(
      '照会した範囲は認証トークンの軸の始点より前にかかっている。' +
        'その分に **トークンの帰属は無い**（0 でも既定値でもなく、取れていない）。',
    );
  }
  // 回数の軸の始点を上の3つと混ぜない: null は「まだ1件も数えられる形で起きていない」であって「0回だった」ではないため
  lines.push(
    turnsSince === null ? '回数の軸はまだ1件も記録していない。' : `回数の軸の始点: ${turnsSince}`,
  );
  if (beforeTurns) {
    lines.push(
      '照会した範囲は回数の軸の始点より前にかかっている。' +
        'その分の回数は **0 ではなく「取れていない」**。',
    );
  }
  lines.push(notice);
  return lines.join('\n');
}

function renderUsageDateRefusal(name: 'from' | 'to', value: string): string {
  return (
    `\`${name}\` は、暦の上に実在する日付（YYYY-MM-DD）で書く（受け取った値: ${JSON.stringify(value)}）。` +
    '形の合わない値や、2026-02-30 のような実在しない日では絞り込めない。'
  );
}

// `from` / `to` は形を確かめてから店へ渡す: 店は日付を文字列の大小で比べるだけで、`2026-02-30` などが黙って絞り込みになるため
// `from` を先に見て、最初に断った方の文を返す（どちらも通れば null）
function describeUsageDateViolation(
  from: string | undefined,
  to: string | undefined,
): string | null {
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value !== undefined && !isRealUsageDate(value)) return renderUsageDateRefusal(name, value);
  }
  return null;
}

// 渡した絞り込みだけを載せる: 欠けた欄を `undefined` で載せると、店が欄の有無で分ける絞り込みが変わるため
function buildUsageQuery(args: {
  from: string | undefined;
  to: string | undefined;
  managerId: string | undefined;
  layer: UsageLayer | undefined;
  site: UsageSite | undefined;
  tokenId: string | undefined;
}): Parameters<Stores['usage']['aggregate']>[0] {
  const { from, to, managerId, layer, site, tokenId } = args;
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(managerId === undefined ? {} : { managerId }),
    ...(layer === undefined ? {} : { layer }),
    ...(site === undefined ? {} : { site }),
    ...(tokenId === undefined ? {} : { tokenId }),
  };
}

// `to` が `from` より前の注記を応答の先頭へ添える: 0件が「期間の指定が逆」と「記録が無い」で区別できないため
function withUsageDateOrderNotice(notice: string | null, body: string): string {
  return notice === null ? body : `${notice}\n${body}`;
}

function renderUsageSummary(
  account: AccountUsageState,
  aggregate: UsageAggregate,
  unrecordedManagers: readonly string[],
): string {
  return [
    renderAccountUsage(account),
    '',
    '## alteroid が使った分（台帳）',
    renderUsage(aggregate, { unrecordedManagers }),
  ].join('\n');
}

export function usageTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;
  return [
    tool(
      'daily_report_write',
      [
        'その日の日報を残す。人間が普段読むのはこれだけである。',
        '今日何をしたか・何が決まったか・何が保留か、が読んだだけで分かるように書くこと。',
      ].join(' '),
      {
        date: z
          .string()
          .optional()
          .describe('対象日 YYYY-MM-DD（省略時は今日。締めの指示に書かれた日付を使うこと）'),
        body: z.string().describe('日報の本文（Markdown）'),
      },
      async ({ date, body }) => {
        // 形の検査だけで通さず localDayRange に確かめさせる: 存在しない日付で残すとその日報は二度と読めないため
        const target =
          date !== undefined && localDayRange(date) !== null ? date : localDate(new Date());
        await appendJournalOrThrow(
          'daily_report_write',
          stores.journal,
          { type: 'daily_report', date: target, body },
          'act-not-performed',
        );
        return text(`${target} の日報を残した。`);
      },
    ),

    tool(
      'usage_read',
      [
        'アカウント全体の残り枠と支出上限（claude.ai 側の値）と、alteroid が使った分（トークンと費用）を台帳から読む。',
        '軸（axis）を渡したときは、その軸だけを出す——アカウント全体の残りもまとめ表示も他の軸も出ない。',
        // 軸の件数も名前も数え直さない: 出所は `USAGE_AXES` と `USAGE_AXIS_NOTES` のため
        `軸は${USAGE_AXES.length}つ — ${USAGE_AXES.map((axis) => `${axis}（${USAGE_AXIS_NOTES[axis]}）`).join('・')}。`,
        'token の軸に「（トークンの帰属が無い分）」が出るのは、プールを使っていない構成では正常である（0 でも既定値でもなく、取れていない）。',
        '**推定値であり請求明細ではない。**「取れなかった」と「0」は分けて出るので、読み替えないこと。',
        '記録は台帳を置いた日から始まっているので、それより前は 0 ではなく「記録が無い」と出る。',
        'まとめ表示は軸ごとに打ち切る。続きは axis と cursor で辿れる（打ち切りの行にそのまま書いてある。' +
          'cursor は前回の応答に出たものをそのまま渡す——自分で組み立てない）。',
        '続きの応答に「順位が上がった、または既に見せた行が伸びた可能性がある行」が別枠で出ることがある' +
          '（前回の呼び出し以降に記録が増えて起きる。通常の続きの頁と重複しない）。',
      ].join(' '),
      {
        from: z.string().optional().describe('この日から（YYYY-MM-DD）。省略すると台帳の全期間'),
        to: z.string().optional().describe('この日まで（YYYY-MM-DD）'),
        managerId: z
          .string()
          .optional()
          .describe('この actor の分だけ（マネージャーの id か "clone"）'),
        layer: usageLayerSchema.optional().describe('誰が使った分だけ（clone / manager）'),
        site: usageSiteSchema.optional().describe('どこで使った分だけ（session / distill / peer）'),
        tokenId: z
          .string()
          .optional()
          .describe(
            `この認証トークンで使った分だけ（token_list の id。${formatStringLengthJa({ min: 1 })}）`,
          ),
        axis: z
          .enum(USAGE_AXES)
          .optional()
          .describe(
            'この軸だけを出す（まとめ表示・他の軸・アカウント全体の残りは出ない）。省略すると先頭から',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'axis と一緒に使う。その軸の続きを読む位置。前回の応答の断り書きに出た cursor を' +
              'そのまま渡す（自分で組み立てない）。省略すると先頭から',
          ),
      },
      async ({ from, to, managerId, layer, site, tokenId, axis, cursor }) => {
        const tokenIdError = describeStringLengthViolation('tokenId', tokenId, { min: 1 });
        if (tokenIdError !== null) return text(tokenIdError);
        const dateViolation = describeUsageDateViolation(from, to);
        if (dateViolation !== null) return text(dateViolation);
        const aggregate = await stores.usage.aggregate(
          buildUsageQuery({ from, to, managerId, layer, site, tokenId }),
        );
        const dateOrderNotice = describeUsageDateOrder(from, to);
        // 軸モードでは続きの1軸だけを返す: 続きを辿るほど同じ全体が積み増しで返ってくるのを避けるため
        if (axis !== undefined) {
          return text(
            withUsageDateOrderNotice(dateOrderNotice, renderUsage(aggregate, { axis, cursor })),
          );
        }
        const unrecordedManagers = await unrecordedManagersLines(context, stores, aggregate.since);
        return text(
          withUsageDateOrderNotice(
            dateOrderNotice,
            renderUsageSummary(
              context.accountUsage?.() ?? { state: 'unknown' },
              aggregate,
              unrecordedManagers,
            ),
          ),
        );
      },
    ),
  ];
}
