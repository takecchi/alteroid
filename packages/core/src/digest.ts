import { excerptLine } from './excerpt.js';
import { describeScheduleSpec } from './schedule.js';
import type { JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { formatUsd, summarizeUsage, usageDate } from './usage.js';

/**
 * ある期間に何が起きたかの要約（日報と発意 tick の材料）。
 *
 * 日誌・ジョブ台帳・承認待ちキューはすべてデーモン側にあり、クローンは
 * `journal_read` などの道具で覗ける。それでも要約をこちらで組んで渡すのは、
 * 「1日を締める」「次の一手を決める」ときに**まず全体が見えている**状態から
 * 始めさせたいからである。細部が要るならクローンが自分で掘る。
 *
 * ここに「何をすべきか」は書かない。材料だけを渡し、判断はクローンに残す。
 */

export interface DigestWindow {
  /** この時刻以降（含む）。 */
  since: Date;
  /**
   * この時刻より前（含まない）。省略時は「いまこの瞬間まで（含む）」。
   *
   * 上端を含まないのは日の境界のためである（`00:00:00.000` の記録が前日と当日の
   * 両方に出ないように）。省略時だけは 1ms 足して、たったいま書かれた記録が
   * 落ちないようにする。
   */
  until?: Date;
}

/** 各節に並べる件数の上限。全部はクローンが `journal_read` で掘れる。 */
const MAX_ITEMS = 15;

export async function buildActivityDigest(stores: Stores, window: DigestWindow): Promise<string> {
  const until = window.until ?? new Date(Date.now() + 1);
  const entries = (await stores.journal.list({ since: window.since.toISOString() })).filter(
    (entry) => entry.at < until.toISOString(),
  );

  const jobs = await stores.jobs.listJobs();
  const pending = await stores.jobs.listApprovals({ pendingOnly: true });
  // 継続中の依頼は期間で切らない。「いま何を頼まれたままか」は常に材料である
  // （これが無いと、発意 tick のたびに頼まれた仕事を思い出せるかの賭けになる）。
  const standing = await stores.schedules.list();
  // 未了も期間で切らない。**切ると、この器の目的そのものが消える** — 24時間の窓で
  // 切れば、2日前に頼まれてまだ手を付けていない仕事だけが静かに落ちる（それは
  // いちばん落としてはいけないものである）。
  const commitments = await stores.commitments.list();
  // **片付けたものは期間で切る。** 未了と逆で、こちらは「この期間に何を終えたか」
  // だからである（日報の「今日何をしたか」の材料になる）。切らないと、日報が
  // 過去に片付けた分を毎日並べ直すことになる。
  const settled = (await stores.commitments.list({ includeClosed: true })).filter(
    (entry) =>
      entry.closedAt !== undefined &&
      entry.closedAt >= window.since.toISOString() &&
      entry.closedAt < until.toISOString(),
  );

  const of = <T extends JournalEntry['type']>(type: T) =>
    entries.filter((entry): entry is Extract<JournalEntry, { type: T }> => entry.type === type);

  const exchanges = of('exchange');
  const humanTurns = exchanges.filter(
    (entry) => entry.with === 'human' && entry.role === 'inbound',
  );
  const decisions = of('decision');
  const escalations = of('escalation');
  const memoryUpdates = of('memory_update');
  const externals = of('external_event');
  const toolUses = of('tool_use');

  // 走行中・返事待ちは期間の外で始まったものも「いまの状態」として要る
  const managers = jobs.filter(
    (job) =>
      job.updatedAt >= window.since.toISOString() ||
      job.status === 'running' ||
      job.status === 'waiting_human',
  );

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    '',
    `- 人間からの発言: ${humanTurns.length} 件`,
    `- マネージャーへの委譲（この期間に動いたもの）: ${managers.length} 本`,
    `- 自分で決めたこと（日誌の decision）: ${decisions.length} 件`,
    `- エスカレーション: ${escalations.length} 件`,
    `- 記憶の更新: ${memoryUpdates.length} 件`,
    `- 外部イベント: ${externals.length} 件`,
    `- マネージャー・作業者のツール実行: ${toolUses.length} 件`,
    `- いま人間の回答を待っているもの: ${pending.length} 件`,
    `- 継続中の依頼（定期の仕込み）: ${standing.length} 件`,
    `- 引き受けたまま終わっていない仕事: ${commitments.length} 件`,
    `- この期間に片付けた仕事: ${settled.length} 件`,
  ];

  if (commitments.length > 0) {
    sections.push(
      '',
      '## 引き受けたまま終わっていない仕事（古い順。片付いたら `commitment_close` で閉じる）',
      '**順序はここには無い。** どれを先にやるかは記憶にある目的と価値観に照らして決めること。',
    );
    for (const entry of commitments.slice(0, MAX_ITEMS)) {
      sections.push(
        `- ${entry.id}（${entry.at} / ${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）` +
          `\n  ${brief(entry.body)}`,
      );
    }
    // 継続中の依頼と同じ理由で、黙って切らない。
    if (commitments.length > MAX_ITEMS) {
      sections.push(
        `- …ほか ${commitments.length - MAX_ITEMS} 件（\`commitment_list\` で全部見える）`,
      );
    }
  }

  if (standing.length > 0) {
    sections.push('', '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）');
    for (const plan of standing.slice(0, MAX_ITEMS)) {
      sections.push(
        `- ${plan.kind}（${describeScheduleSpec(plan.spec)}）${brief(plan.request)}` +
          `\n  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
      );
    }
    // 黙って切らない。他の節は期間で切った一部だが、ここは「常に材料である」ことが
    // 趣旨なので、切ったことを見せないと「あるのに見えない」になる。
    if (standing.length > MAX_ITEMS) {
      sections.push(`- …ほか ${standing.length - MAX_ITEMS} 件（\`schedule_list\` で全部見える）`);
    }
  }

  if (settled.length > 0) {
    sections.push('', '## この期間に片付けた仕事');
    for (const entry of settled.slice(0, MAX_ITEMS)) {
      sections.push(
        `- ${brief(entry.body, 120)}\n  片付いたとした理由: ${brief(entry.closedReason ?? '', 120)}`,
      );
    }
    if (settled.length > MAX_ITEMS) {
      sections.push(`- …ほか ${settled.length - MAX_ITEMS} 件`);
    }
  }

  if (managers.length > 0) {
    sections.push('', '## マネージャー');
    for (const job of managers.slice(0, MAX_ITEMS)) {
      sections.push(
        `- ${job.id} [${job.status}] ${brief(job.request ?? job.summary)}` +
          (job.lastReport === undefined ? '' : `\n  直近の報告: ${brief(job.lastReport)}`),
      );
    }
  }

  if (decisions.length > 0) {
    sections.push('', '## 聞かずに決めたこと');
    for (const entry of decisions.slice(0, MAX_ITEMS)) {
      sections.push(`- ${entry.at} ${brief(entry.decision)}（根拠: ${brief(entry.grounds, 80)}）`);
    }
  }

  if (escalations.length > 0) {
    sections.push('', '## エスカレーション');
    for (const entry of escalations.slice(0, MAX_ITEMS)) {
      const state = entry.answer === undefined ? '未回答' : `回答: ${brief(entry.answer, 80)}`;
      sections.push(`- ${brief(entry.question)} → ${state}`);
    }
  }

  if (pending.length > 0) {
    sections.push('', '## 人間の回答待ち（保留中。他の仕事は進めてよい）');
    for (const approval of pending.slice(0, MAX_ITEMS)) {
      sections.push(
        `- ${approval.id}（${approval.createdAt}）${brief(approval.question)}` +
          (approval.jobId === undefined ? '' : ` [マネージャー ${approval.jobId}]`),
      );
    }
  }

  if (memoryUpdates.length > 0) {
    sections.push('', '## 記憶の更新');
    for (const entry of memoryUpdates.slice(0, MAX_ITEMS)) {
      sections.push(`- ${entry.slug}（${entry.cause}）${brief(entry.summary, 120)}`);
    }
  }

  if (externals.length > 0) {
    sections.push('', '## 届いた外部イベント');
    for (const entry of externals.slice(0, MAX_ITEMS)) {
      sections.push(`- ${entry.source}: ${brief(entry.summary, 120)}`);
    }
  }

  sections.push('', ...(await usageSection(stores, window.since, until)));

  return sections.join('\n');
}

/**
 * この期間にいくら使ったか。
 *
 * **これは判断の材料である。** 委譲を続けてよいか、重い仕事をいま投げてよいかは、
 * 使った量が見えなければ勘で決めるしかない。実際に支出上限へ当たって走行中の
 * マネージャーが2本同時に落ちたことがあり、そのときクローンには事前に知る手段が
 * 無かった。日報では「どの委譲が高かったか」「どの層（Fable / Opus / Sonnet）が
 * 高いか」が、委譲の粒度を直す材料になる。
 *
 * **取れなかったものを 0 と書かない。** 台帳が無かった期間は「記録が無い」であって
 * 「使っていない」ではない。
 */
async function usageSection(stores: Stores, since: Date, until: Date): Promise<string[]> {
  let aggregate;
  try {
    aggregate = await stores.usage.aggregate({
      from: usageDate(since),
      // 上端は含まないので 1ms 引いてから日付にする（境界の日が余分に入らない）。
      to: usageDate(new Date(until.getTime() - 1)),
    });
  } catch {
    // 台帳が読めないこと自体で digest を落とさない。ただし黙らない。
    return ['## 使った分', '（台帳を読めなかった。集計は出せない）'];
  }

  const lines = ['## 使った分'];
  if (aggregate.since === null) {
    lines.push('（台帳にまだ記録が無い。この機能を入れる前の分は残っていない）');
    return lines;
  }

  const summary = summarizeUsage(aggregate.rows);
  if (aggregate.rows.length === 0) {
    lines.push('この期間の記録は無い。');
  } else {
    lines.push(`- 合計: ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `- 出力トークン: ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `入力: ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み: ${summary.total.cacheReadInputTokens.toLocaleString('en-US')}`,
    );
    // 高い順。どの層・どの委譲に効くかを先に見せる。
    const top = <T extends { totals: { costUsd: number } }>(entries: readonly T[]) =>
      [...entries].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, MAX_ITEMS);
    lines.push(
      `- モデル別: ${top(summary.byModel)
        .map((entry) => `${entry.model} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}`,
    );
    // **誰が**使ったか。モデル別と別に出す — `ALTEROID_CLONE_MODEL` を置けば
    // クローンとマネージャーは同じモデル帯に並び、モデル名では層を見分けられない。
    lines.push(
      `- 層別（誰が）: ${top(summary.byLayer)
        .map((entry) => `${entry.layer} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}`,
    );
    lines.push(
      `- 場所別（どこで）: ${top(summary.bySite)
        .map((entry) => `${entry.site} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}`,
    );
    lines.push('- 高かった委譲:');
    for (const entry of top(summary.byManager)) {
      lines.push(`  - ${entry.managerId}: ${formatUsd(entry.totals.costUsd)}`);
    }
    if (summary.byManager.length > MAX_ITEMS) {
      // **「`usage_read` で全部見える」と書かない。** あちらも軸ごとに打ち切るので
      // 嘘になる。実際に打てる手（続きを辿る呼び方）をそのまま書く。
      lines.push(
        `  - …ほか ${summary.byManager.length - MAX_ITEMS} 本` +
          '（`usage_read` に axis="manager", offset=0 を渡すと続きから辿れる）',
      );
    }
  }

  if (aggregate.beforeLedger) {
    lines.push(
      `- この期間の一部は台帳の始点（${aggregate.since}）より前で、**記録が無い**（0 ではない）`,
    );
  }
  if (aggregate.beforeLayers) {
    // **層の始点を台帳の始点と混ぜない。** 層の軸のほうが後から入ったので、それより
    // 前の行の層と場所は既定値であって観測ではない。
    lines.push(
      '- この期間の一部は層と場所の軸の始点' +
        `（${aggregate.layersSince ?? 'まだ1件も記録が無い'}）より前で、` +
        'その分の層と場所は**既定値であって観測ではない**',
    );
  }
  lines.push(`- ${aggregate.notice}`);
  return lines;
}

/**
 * 一覧に載せるための抜粋。
 *
 * **切ったことを黙らない。** 省いた分量が出ていれば、続きが要るかどうかを
 * 読んだ側が判断できる（報告の全文は `manager_report` で取れる）。
 */
function brief(value: string, limit = 200): string {
  return excerptLine(value, limit);
}
