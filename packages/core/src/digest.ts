import { excerptLine } from './excerpt.js';
import { describeScheduleSpec } from './schedule.js';
import type { JournalEntry } from './schema.js';
import type { Stores } from './store.js';

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
  ];

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

  return sections.join('\n');
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
