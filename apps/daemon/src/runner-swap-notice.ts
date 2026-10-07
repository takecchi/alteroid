import { reasonOf, type Job } from '@alteroid/core';

// 「起こさない」を選ぶのは影響が0本と積極的に数え切れたときだけにする: 起こしすぎるコストはクローンの1ターンだが、拾い損ねた委譲は人間が気づくまで宙に浮くため。
// `'affected'` 以外の3つの理由を1つへ畳まない: 日誌の `grounds` を読む人間・クローンが、本当に影響があって起こしたのか、数え切れず安全側に倒しただけなのかを区別できなくなるため。
export type RunnerSwapNoticeReason =
  'affected' | 'none-affected' | 'runner-unnamed' | 'ledger-unreadable';

export interface RunnerSwapNoticeDecision {
  readonly wake: boolean;
  readonly reason: RunnerSwapNoticeReason;
  /** 数え切れたときだけ本数。数えられなかったときは undefined。 */
  readonly affected: number | undefined;
  /** 日誌の `grounds` に載せる、なぜそう判定したかの文。 */
  readonly grounds: string;
}

export function decideRunnerSwapNotice(input: {
  readonly runnerId: string | undefined;
  readonly jobs: readonly Job[] | undefined;
  readonly aliveRunnerIds: ReadonlySet<string> | undefined;
}): RunnerSwapNoticeDecision {
  const { runnerId, jobs, aliveRunnerIds } = input;

  // 1. 入れ替わった宛先そのものが分からなければ、何も数えられない。
  if (runnerId === undefined) {
    return {
      wake: true,
      reason: 'runner-unnamed',
      affected: undefined,
      grounds: '入れ替わった宛先の runnerId を聞けていないので、対象を数えられず起こした',
    };
  }

  // 2. 台帳が読めなければ、同じく何も数えられない。
  if (jobs === undefined) {
    return {
      wake: true,
      reason: 'ledger-unreadable',
      affected: undefined,
      grounds: '台帳 listJobs() を読めなかったので、対象を数えられず起こした',
    };
  }

  // 3. ここから先は数える。
  let total = 0;
  let unfinished = 0;
  let onThisRunner = 0;
  let unassigned = 0;
  let silentElsewhere = 0;
  let aliveElsewhereSkipped = 0;

  for (const job of jobs) {
    total += 1;

    // `#reattach` と同じ境界にする: ずれると、ここが0本と言った直後に `#reattach` が実際には何本か引き取る食い違いが起きるため。
    if (job.status !== 'running' && job.status !== 'waiting_human') continue;
    unfinished += 1;

    if (job.runnerId === undefined) {
      unassigned += 1;
      continue;
    }
    if (job.runnerId === runnerId) {
      onThisRunner += 1;
      continue;
    }
    // 名簿を読めない・宛先が死んでいる／載っていないときは対象に数える: 迷ったら起こす。
    if (aliveRunnerIds === undefined || !aliveRunnerIds.has(job.runnerId)) {
      silentElsewhere += 1;
    } else {
      aliveElsewhereSkipped += 1;
    }
  }

  const affected = onThisRunner + unassigned + silentElsewhere;
  const grounds =
    `台帳 listJobs() と名簿 entries() を突き合わせて数えた: 全 ${total} 件のうち` +
    `未了（running/waiting_human）${unfinished} 件、うちこの宛先 ${onThisRunner} 件・` +
    `宛先未記入 ${unassigned} 件・黙った別宛先 ${silentElsewhere} 件` +
    `（生きている別宛先の ${aliveElsewhereSkipped} 件は対象外）`;

  if (affected > 0) return { wake: true, reason: 'affected', affected, grounds };
  return { wake: false, reason: 'none-affected', affected, grounds };
}

export interface NoteRunnerSwapDeps {
  readonly notice: string;
  readonly runnerId: string | undefined;
  readonly listJobs: () => Promise<readonly Job[]>;
  readonly aliveRunnerIds: () => ReadonlySet<string>;
  readonly journal: (entry: {
    type: 'decision';
    decision: string;
    grounds: string;
  }) => Promise<unknown>;
  readonly wake: ((text: string) => void) | undefined;
  readonly warn: (message: string) => void;
}

export async function noteRunnerSwap(deps: NoteRunnerSwapDeps): Promise<void> {
  // `listJobs()` はこの関数の最初の文で呼ぶ: 呼び出し側が直後に `takeOverOnSwap` を呼び、引き取りが台帳を書き換え始める前に読みを発行しておくため。
  let jobsPromise: Promise<readonly Job[] | undefined>;
  try {
    jobsPromise = deps.listJobs().then(
      (jobs) => jobs,
      () => undefined,
    );
  } catch {
    jobsPromise = Promise.resolve(undefined);
  }

  let aliveRunnerIds: ReadonlySet<string> | undefined;
  try {
    aliveRunnerIds = deps.aliveRunnerIds();
  } catch {
    aliveRunnerIds = undefined;
  }

  const jobs = await jobsPromise;
  const decision = decideRunnerSwapNotice({ runnerId: deps.runnerId, jobs, aliveRunnerIds });

  // 日誌より先に起こす: 日誌が書けなくても起床は済んでいるようにするため。
  let wokeViaStderrOnly = false;
  if (decision.wake) {
    if (deps.wake !== undefined) {
      deps.wake(deps.notice);
    } else {
      wokeViaStderrOnly = true;
      deps.warn(
        `クローンの受信箱がまだ無いので、器の入れ替えの知らせを stderr にだけ残しました: ${deps.notice}`,
      );
    }
  }

  const label = `runner の器の入れ替え（${deps.runnerId ?? '宛先不明'}）`;
  const decisionText = !decision.wake
    ? `${label}: 引き取りの対象になりうる委譲が 0 本だったので、クローンを起こさなかった（日誌にだけ残す）`
    : decision.affected === undefined
      ? `${label}: 対象の本数を数えられなかったので、クローンを起こした`
      : `${label}: 引き取りの対象になりうる委譲が ${decision.affected} 本あったので、クローンを起こした`;

  // `notice`（元の文言）は必ず含める: あとから `grounds` で「本当に0本だったのか」を検算できるようにするため。
  const grounds =
    decision.grounds +
    (wokeViaStderrOnly ? '。クローンの受信箱がまだ無いので stderr にだけ残した' : '') +
    `。元の知らせ: ${deps.notice}`;

  try {
    await deps.journal({ type: 'decision', decision: decisionText, grounds });
  } catch (error: unknown) {
    deps.warn(`器の入れ替えの判断を日誌へ残せませんでした: ${reasonOf(error)}\n  ${decisionText}`);
  }
}
