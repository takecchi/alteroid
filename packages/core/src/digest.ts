import { excerptLine } from './excerpt.js';
import { describeScheduleSpec } from './schedule.js';
import type { JobStatus, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { formatUsd, isCloneActor, summarizeUsage, usageDate } from './usage.js';

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

/**
 * 各節に並べる件数の上限。細部はクローンが自分の道具で掘れる。
 *
 * **切ったなら必ず `omitted()` を通すこと**（下の doc を読むこと）。export して
 * あるのはテストが期待件数を計算するためで、`index.ts` からは出していない。
 */
export const MAX_ITEMS = 15;

/**
 * 上限で切ったことと、残りの件数と、続きの取り方を出す。
 *
 * **切ること自体は要件である** — 件数に比例して伸びる材料は MCP の出力上限を
 * 超えるとクローンに1文字も届かない。壊れるのは**切ったことが出力から消える**
 * 場合であって、そのときクローンの手元に残るのは「これで全部だ」と読める一覧に
 * なる。続きを掘るという判断そのものが起きなくなるので、件数が増えるほど静かに
 * 材料が減る。
 *
 * **節ごとに手で書いていたのをここへ寄せた。** 後から足した6節（マネージャー・
 * 決定・エスカレーション・回答待ち・記憶の更新・外部イベント）が黙って切れて
 * いたのは、この行が各節の実装の側にあって、書き忘れても何も落ちなかったから
 * である。節ごとに違うのは「続きをどう取るか」だけなので、それだけを渡す。
 *
 * **`where` に「全部見える」と書けるのは、その道具が打ち切らないときだけである。**
 * `approvals_list` はそう。`journal_read` / `manager_list` / `commitment_list` /
 * `usage_read` は予算や件数で打ち切るので、そう書けば嘘になる（`usage_read` に
 * ついて先に踏んだ轍である。下の `usageSection` のコメント参照）。
 *
 * **`total` からではなく「実際に出した件数（`shown`）」から引く。** 理由は
 * 下の `usageOmitted` の doc（「省いた件数は `MAX_ITEMS` ではなく…」の段）と
 * 同じである——呼ぶ側の `.slice(0, MAX_ITEMS)` の件数がこの定数から離れた日に、
 * 出した数と合図の数が食い違う（合図そのものは在るので、読んだ側からは
 * 気づけない）。呼ぶ側は切った配列の長さをそのまま渡すこと。
 */
function omitted(total: number, shown: number, where: string): string[] {
  if (total <= shown) return [];
  return [`- …ほか ${total - shown} 件（${where}）`];
}

/**
 * 日誌から作った節の続きの取り方。
 *
 * **`since` だけでは続きに届かない。** ここに出ているのは新しい側の一部で、
 * `journal_read` も新しい順に返すので、手前の最新分が `limit` を食い尽くして
 * 狙った時刻には決して届かない。だから `until` まで書く（`journal_read` の
 * 説明文が言っているのと同じことを、切った現場でもう一度言う）。
 */
function journalWhere(type: JournalEntry['type']): string {
  return (
    `新しい側だけ出している。続きは \`journal_read\` に types=["${type}"] と until を渡して掘る` +
    '（あちらも予算で打ち切り、残りの件数が本文に出る）'
  );
}

/**
 * `usageSection` の4軸（モデル・層・場所・委譲）を `top()` で切ったときの合図。
 *
 * **4軸ともここを通すこと。「3軸に if を3つ足す」形にしない。** 上の `omitted()`
 * の doc が逐語で記録している轍——「節ごとに手で書いていたのをここへ寄せた。
 * 後から足した6節が黙って切れていたのは、この行が各節の実装の側にあって、
 * 書き忘れても何も落ちなかったから」——を、軸の側でも踏むことになる。合図を
 * 作る場所を1つに閉じておけば、軸を足す人はこの関数を呼ぶだけで済み、書き
 * 忘れる余地が無い。
 *
 * **到達可能性は軸で違うが、それを理由にここを通す/通さないを分けない。**
 * `model`（`ALTEROID_*_MODEL` は値を検証しない `z.string()`）と `manager`
 * （委譲ごとに `randomUUID()`）は `MAX_ITEMS` を超えうる。`layer` / `site`
 * （`usage-format.ts` の `USAGE_LAYERS` / `USAGE_SITES`）はいまは2値の閉じた
 * enum なので超ええない。**それでも4軸ともここを通すのは、値が増えた日に
 * ここだけ書き忘れないためである。**
 *
 * 文言は `usage_read`（`tools.ts` の `USAGE_AXES`）の `axis` 引数と同じ名前を
 * 使う——続きを辿る呼び方を渡す以上、そこで通る名前でなければ嘘になる。
 *
 * **省いた件数は `MAX_ITEMS` ではなく「実際に出した件数」から引く。** 定数から
 * 引くと、`top()` が切る件数がこの定数から離れた日に、出した数と合図の数が
 * 食い違う——**合図そのものは在るので、出力は黙って嘘になる**（合図が無いのと
 * 違って、読んだ側からは食い違いに気づけない）。切った側が出した数を渡す形に
 * しておけば、その食い違いが起きようがない。
 */
function usageOmitted(total: number, shown: number, axis: string, unit: string): string {
  if (total <= shown) return '';
  return (
    `…ほか ${total - shown} ${unit}` +
    `（\`usage_read\` に axis="${axis}", offset=0 を渡すと続きから辿れる）`
  );
}

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
  //
  // **`list()` は `{ entries, unreadable }` を返す（issue #296）。** 読めない行を
  // 件数からもここからも消さないため、`unreadable` を別に持ち回り、下の節へ渡す。
  const commitmentList = await stores.commitments.list();
  const commitments = commitmentList.entries;
  const unreadableCommitments = commitmentList.unreadable;
  // **片付けたものは期間で切る。** 未了と逆で、こちらは「この期間に何を終えたか」
  // だからである（日報の「今日何をしたか」の材料になる）。切らないと、日報が
  // 過去に片付けた分を毎日並べ直すことになる。
  const settled = (await stores.commitments.list({ includeClosed: true })).entries.filter(
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
  /**
   * ツール実行は**層で分ける**。
   *
   * クローンが自分の手で使った道具も同じ日誌へ落ちるようになった（#32）ので、
   * 1つの数にまとめると「委譲した量」として読める数がクローン自身の手の量で
   * 膨らむ（AGENTS.md「消費の層をモデル名で見分けるな ＝ 層は層の列で言う」と
   * 同じ話で、ここでの層の列は `actor` である）。**この数は digest を読む
   * クローン自身と日報の材料になるので、混ぜると委譲の判断がそのまま狂う。**
   */
  const toolUses = of('tool_use');
  const cloneToolUses = toolUses.filter((entry) => isCloneActor(entry.actor));
  const delegatedToolUses = toolUses.filter((entry) => !isCloneActor(entry.actor));

  // 走行中・返事待ちは期間の外で始まったものも「いまの状態」として要る
  const inFlight = (status: JobStatus) => status === 'running' || status === 'waiting_human';
  // **上限で切っても「いまの状態」が落ちない順に並べる。** 材料の順序は器ごとに
  // 違う（pg は `createdAt` 昇順・fs は最終更新順・memory は挿入順）ので、並べ直さ
  // ないと、上で期間の外からわざわざ拾った走行中・返事待ちが古い `done` に押し
  // 出されて消えうる。それはこの節がやろうとしていることの逆である。
  const managers = jobs
    .filter((job) => job.updatedAt >= window.since.toISOString() || inFlight(job.status))
    .sort((a, b) => {
      if (inFlight(a.status) !== inFlight(b.status)) return inFlight(a.status) ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    '',
    `- 人間からの発言: ${humanTurns.length} 件`,
    `- マネージャーへの委譲（この期間に動いたもの）: ${managers.length} 本`,
    `- 自分で決めたこと（日誌の decision）: ${decisions.length} 件`,
    `- エスカレーション: ${escalations.length} 件`,
    `- 記憶の更新: ${memoryUpdates.length} 件`,
    `- 外部イベント: ${externals.length} 件`,
    `- マネージャー・作業者のツール実行: ${delegatedToolUses.length} 件`,
    `- あなた自身が手を動かした回数（委譲せずに使った道具）: ${cloneToolUses.length} 件`,
    `- いま人間の回答を待っているもの: ${pending.length} 件`,
    `- 継続中の依頼（定期の仕込み）: ${standing.length} 件`,
    `- 引き受けたまま終わっていない仕事: ${commitments.length} 件`,
    // **0件でも出す**（他の行と同じ扱い）。台帳の破損は稀だが、無いことも
    // 常に言えるようにしておく（「取れない軸に0の行を作る」の逆 — ここは
    // 実際に取れている軸なので0を隠さない）。詳細は下の節（issue #296）。
    `- 読めない行（台帳が壊れている。片付いたのではない）: ${unreadableCommitments.length} 件`,
    `- この期間に片付けた仕事: ${settled.length} 件`,
  ];

  // **読めない行が在れば、件数と一緒に節を出す（issue #296）。** `commitments`
  // （＝ `entries`）が0件でも読めない行だけは在りうるので、`commitments.length`
  // だけをこの節の出し分けの条件にしない。
  if (commitments.length > 0 || unreadableCommitments.length > 0) {
    sections.push(
      '',
      '## 引き受けたまま終わっていない仕事（古い順。片付いたら `commitment_close` で閉じる）',
      '**順序はここには無い。** どれを先にやるかは記憶にある目的と価値観に照らして決めること。',
    );
    if (unreadableCommitments.length > 0) {
      // **件数やログではなくここでも明言する。** 「片付いたのではない」を
      // 落とすと、読めない行が静かに未了から消えたのと区別が付かなくなる
      // （`store.ts` の `CommitmentList` の doc と同じ理由）。
      const idsAll = unreadableCommitments
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      // **ここも上限を付ける。** `unreadableCommitments` は台帳の破損の度合いに
      // 比例して伸びるので、`ids.join(', ')` を無制限にすると台帳が壊れるほど
      // digest が伸びる（MAX_ITEMS で切っている他の一覧と同じ理由）。
      const ids = idsAll.slice(0, MAX_ITEMS);
      // **「commitment_list を呼べば全部出る」と書けるのは、実際に確かめたから
      // である。** `tools.ts` の `commitment_list`（id を渡さない一覧モード）が
      // 読めない行の id を出す節は `ids.join(', ')` をそのまま使っており、件数の
      // 上限を掛けていない（実装を読んで確認した。まだ上限が無い時点の話なので、
      // 後で上限が付いたらこの文言も直す必要がある）。
      // 省いた件数は、他の節と同じく**出した件数から引く**（`omitted()` の doc）。
      const idsExtra =
        idsAll.length > ids.length
          ? `（…ほか ${idsAll.length - ids.length} 件。id は commitment_list（id を指定しない一覧モード）を呼べば読めない行の id が全部出る）`
          : '';
      sections.push(
        `**読めない行が ${unreadableCommitments.length} 件ある（片付いたのではない）。**` +
          (ids.length === 0 ? '' : ` id: ${ids.join(', ')}${idsExtra}。`) +
          // **「全文が見られる」とは書かない。** `commitment_list id=<id>` の
          // 全文モードは `get(id)` が読めない行で throw するので、本文は
          // 返らない（`UnreadableCommitmentError` を捕まえて「読めない」と
          // 返すだけの3値目になる。`tools.ts` の該当箇所）。ここは実際に
          // できることだけを書く。
          '`commitment_list id=<id>` で状態は確かめられる（本文はここでは取れない）。',
      );
    }
    const shownCommitments = commitments.slice(0, MAX_ITEMS);
    for (const entry of shownCommitments) {
      sections.push(
        `- ${entry.id}（${entry.at} / ${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）` +
          `\n  ${brief(entry.body)}`,
      );
    }
    // 継続中の依頼と同じ理由で、黙って切らない。
    sections.push(
      // **`commitment_list` も件数で打ち切る**ので「全部見える」とは書けない
      // （あちらは残り件数を本文に出す）。
      ...omitted(
        commitments.length,
        shownCommitments.length,
        '`commitment_list` で古い順に辿れる。あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
  }

  if (standing.length > 0) {
    sections.push('', '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）');
    const shownStanding = standing.slice(0, MAX_ITEMS);
    for (const plan of shownStanding) {
      sections.push(
        `- ${plan.kind}（${describeScheduleSpec(plan.spec)}）${brief(plan.request)}` +
          `\n  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
      );
    }
    // 黙って切らない。他の節は期間で切った一部だが、ここは「常に材料である」ことが
    // 趣旨なので、切ったことを見せないと「あるのに見えない」になる。
    sections.push(
      ...omitted(standing.length, shownStanding.length, '`schedule_list` で全部見える'),
    );
  }

  if (settled.length > 0) {
    sections.push('', '## この期間に片付けた仕事');
    const shownSettled = settled.slice(0, MAX_ITEMS);
    for (const entry of shownSettled) {
      sections.push(
        `- ${brief(entry.body, 120)}\n  片付いたとした理由: ${brief(entry.closedReason ?? '', 120)}`,
      );
    }
    sections.push(
      ...omitted(
        settled.length,
        shownSettled.length,
        '`commitment_list` に includeClosed=true を渡すと辿れる',
      ),
    );
  }

  if (managers.length > 0) {
    sections.push('', '## マネージャー（走行中・返事待ちから先に出す）');
    const shownManagers = managers.slice(0, MAX_ITEMS);
    for (const job of shownManagers) {
      sections.push(
        `- ${job.id} [${job.status}] ${brief(job.request ?? job.summary)}` +
          (job.lastReport === undefined ? '' : `\n  直近の報告: ${brief(job.lastReport)}`),
      );
    }
    sections.push(
      ...omitted(
        managers.length,
        shownManagers.length,
        '`manager_list` で状態を見る。あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
  }

  if (decisions.length > 0) {
    sections.push('', '## 聞かずに決めたこと');
    const shownDecisions = decisions.slice(0, MAX_ITEMS);
    for (const entry of shownDecisions) {
      sections.push(`- ${entry.at} ${brief(entry.decision)}（根拠: ${brief(entry.grounds, 80)}）`);
    }
    sections.push(...omitted(decisions.length, shownDecisions.length, journalWhere('decision')));
  }

  if (escalations.length > 0) {
    sections.push('', '## エスカレーション');
    const shownEscalations = escalations.slice(0, MAX_ITEMS);
    for (const entry of shownEscalations) {
      const state = entry.answer === undefined ? '未回答' : `回答: ${brief(entry.answer, 80)}`;
      sections.push(`- ${brief(entry.question)} → ${state}`);
    }
    sections.push(
      ...omitted(escalations.length, shownEscalations.length, journalWhere('escalation')),
    );
  }

  if (pending.length > 0) {
    sections.push('', '## 人間の回答待ち（保留中。他の仕事は進めてよい）');
    const shownPending = pending.slice(0, MAX_ITEMS);
    for (const approval of shownPending) {
      sections.push(
        `- ${approval.id}（${approval.createdAt}）${brief(approval.question)}` +
          (approval.jobId === undefined ? '' : ` [マネージャー ${approval.jobId}]`),
      );
    }
    // ここだけは打ち切らない道具があるので「全部見える」と書ける。
    sections.push(...omitted(pending.length, shownPending.length, '`approvals_list` で全部見える'));
  }

  if (memoryUpdates.length > 0) {
    sections.push('', '## 記憶の更新');
    const shownMemoryUpdates = memoryUpdates.slice(0, MAX_ITEMS);
    for (const entry of shownMemoryUpdates) {
      // `queries.ts` の `summarizeJournalEntry` と同じ言い方に揃える
      // （`action`/`cause` を1つの括弧にまとめ、バイトの注記を `/` で続ける）。
      // 単位はバイト（`schema.ts` の `bytesBefore`/`bytesAfter` の doc）。
      // `action`/`bytesBefore`/`bytesAfter` はこの区別が導入される前の
      // 古いエントリでは `undefined` — 無いことを `0` として出すと
      // 「変化が無かった」と読めてしまうので、値が無いときは「不明」と
      // 明示する（`tools.ts`/`queries.ts` と同じ扱い）。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      sections.push(
        `- ${entry.slug}（${entry.cause}${action} / ${bytes}）${brief(entry.summary, 120)}`,
      );
    }
    sections.push(
      ...omitted(memoryUpdates.length, shownMemoryUpdates.length, journalWhere('memory_update')),
    );
  }

  if (externals.length > 0) {
    sections.push('', '## 届いた外部イベント');
    const shownExternals = externals.slice(0, MAX_ITEMS);
    for (const entry of shownExternals) {
      sections.push(`- ${entry.source}: ${brief(entry.summary, 120)}`);
    }
    sections.push(
      ...omitted(externals.length, shownExternals.length, journalWhere('external_event')),
    );
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
    // **合図は `usageOmitted` から取る（4軸とも同じ関数を通す）。** 超えて
    // いなければ空文字が返るので、その行には何も足さない。
    const shownModels = top(summary.byModel);
    const modelExtra = usageOmitted(summary.byModel.length, shownModels.length, 'model', '件');
    lines.push(
      `- モデル別: ${shownModels
        .map((entry) => `${entry.model} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${modelExtra === '' ? '' : ` / ${modelExtra}`}`,
    );
    // **誰が**使ったか。モデル別と別に出す — `ALTEROID_CLONE_MODEL` を置けば
    // クローンとマネージャーは同じモデル帯に並び、モデル名では層を見分けられない。
    const shownLayers = top(summary.byLayer);
    const layerExtra = usageOmitted(summary.byLayer.length, shownLayers.length, 'layer', '件');
    lines.push(
      `- 層別（誰が）: ${shownLayers
        .map((entry) => `${entry.layer} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${layerExtra === '' ? '' : ` / ${layerExtra}`}`,
    );
    const shownSites = top(summary.bySite);
    const siteExtra = usageOmitted(summary.bySite.length, shownSites.length, 'site', '件');
    lines.push(
      `- 場所別（どこで）: ${shownSites
        .map((entry) => `${entry.site} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${siteExtra === '' ? '' : ` / ${siteExtra}`}`,
    );
    lines.push('- 高かった委譲:');
    const shownManagers = top(summary.byManager);
    for (const entry of shownManagers) {
      lines.push(`  - ${entry.managerId}: ${formatUsd(entry.totals.costUsd)}`);
    }
    // **「`usage_read` で全部見える」と書かない。** あちらも軸ごとに打ち切るので
    // 嘘になる。実際に打てる手（続きを辿る呼び方）をそのまま書く——文言は
    // `usageOmitted` から取る（同じ関数を4軸とも通す理由は同関数の doc）。
    const managerExtra = usageOmitted(
      summary.byManager.length,
      shownManagers.length,
      'manager',
      '本',
    );
    if (managerExtra !== '') lines.push(`  - ${managerExtra}`);
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
