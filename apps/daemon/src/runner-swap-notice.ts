import type { Job } from '@alteroid/core';

/**
 * 器の入れ替え（`onSwap`。`apps/daemon/src/index.ts`）でクローンを起こすかどうかを決める。
 *
 * ## なぜこのファイルがあるのか
 *
 * runner は3台あり、デプロイのたびに最低3回 `onSwap` が起きる。これまでは
 * 台帳を見ずに毎回クローンを起こしていたため、**引き取り対象の委譲が0本の
 * ときも無条件に起こしていた。** 依頼者は24時間で6回起こされ、6回とも
 * 「何もしない」と答えている——クローンの1ターンは安くない。
 *
 * ## 設計の芯: 迷ったら起こす
 *
 * **「起こさない」を選ぶのは、影響が0本だと積極的に数え切れたときだけである。**
 * 数えられない・読めない・runnerId を聞けていない、のいずれも必ず起こす側へ
 * 倒す。
 *
 * 理由は非対称だから——起こしすぎて「何もしない」と答えるコストはクローンの
 * 1ターン分でしかないが、起こさなすぎて拾い損ねた委譲は、人間が気づくまで
 * （最悪ずっと）宙に浮く。**「起こさない」という判断にだけ高い証明の水準を
 * 課す**のは、この非対称を反映しているからである。
 *
 * ## 何を数えるか（`ManagerPool#reattach` と同じ境界）
 *
 * `packages/core/src/manager.ts` の `#reattach` が引き取りの対象にするのは
 * `status` が `'running'` か `'waiting_human'` のジョブだけである（それ以外は
 * `continue`）。ここで数える「対象」もこれに合わせる——境界がずれると、
 * ここが「0本だから起こさなかった」と言った直後に `#reattach` が実際には
 * 何本か引き取る、という食い違いが起きる。
 */

/**
 * 判定の理由。**`'affected'` 以外は3つとも「起こす」側**——理由が違っても
 * 挙動は同じである。にもかかわらず1つの `'affected'` へ畳まないのは、日誌の
 * `grounds` を読む人間・クローンが「本当に影響があって起こしたのか」「数え
 * 切れなかったから安全側に倒しただけなのか」を区別できるようにするためである。
 */
export type RunnerSwapNoticeReason =
  | 'affected' // 1本以上が引き取り/移送の対象になりうる → 起こす
  | 'none-affected' // 0本と数え切れた → 起こさない
  | 'runner-unnamed' // runnerId を聞けていない → 数えられないので起こす
  | 'ledger-unreadable'; // 台帳を読めなかった → 数えられないので起こす

export interface RunnerSwapNoticeDecision {
  readonly wake: boolean;
  readonly reason: RunnerSwapNoticeReason;
  /** 数え切れたときだけ本数。数えられなかったときは undefined。 */
  readonly affected: number | undefined;
  /** 日誌の `grounds` に載せる、なぜそう判定したかの文。 */
  readonly grounds: string;
}

/**
 * 純粋な判定関数。I/O をしない——呼び出し側（`noteRunnerSwap`）が台帳・名簿を
 * 読んでから渡す。副作用と判定を分けておくことで、判定の分岐それぞれに歯を
 * 直接通せる（I/O のモックを介さずに済む）。
 */
export function decideRunnerSwapNotice(input: {
  readonly runnerId: string | undefined;
  /** 台帳の全ジョブ。読めなかったときは undefined。 */
  readonly jobs: readonly Job[] | undefined;
  /** いま名簿で生きている宛先。読めなかったときは undefined。 */
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

    // `#reattach`（packages/core/src/manager.ts の
    // `if (status !== 'running' && status !== 'waiting_human') continue;`）と
    // 同じ境界。done / failed / lost / stopped は引き取りの対象にならないので
    // 数えない——ここが緩いと「まだ何か残っている」と見誤り、厳しいと
    // `#reattach` が実際に拾う分を見落とす。
    if (job.status !== 'running' && job.status !== 'waiting_human') continue;
    unfinished += 1;

    if (job.runnerId === undefined) {
      // 宛先未記入。起動時の restore() が拾いうる対象なので数える。
      unassigned += 1;
      continue;
    }
    if (job.runnerId === runnerId) {
      // 入れ替わった宛先そのもの。直撃。
      onThisRunner += 1;
      continue;
    }
    // ここから先は別の宛先のジョブ。その宛先がいま名簿で生きていれば対象外
    // ——生きている別宛先へ移送を試みる理由が無い。名簿を読めない、または
    // その宛先が死んでいる／載っていないなら、黙った宛先からの移送先に
    // なりうるので対象に数える（迷ったら起こす、をここでも適用する）。
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

/**
 * `decideRunnerSwapNotice` を実際に使う口。台帳・名簿を読み、判定に従って
 * クローンを起こし（または起こさず）、どちらへ転んだかを日誌へ残す。
 */
export interface NoteRunnerSwapDeps {
  /** 既存の通知文言そのもの（変えない）。 */
  readonly notice: string;
  readonly runnerId: string | undefined;
  readonly listJobs: () => Promise<readonly Job[]>;
  readonly aliveRunnerIds: () => ReadonlySet<string>;
  readonly journal: (entry: {
    type: 'decision';
    decision: string;
    grounds: string;
  }) => Promise<unknown>;
  /** クローンの受信箱へ入れる口。クローンがまだ立ち上がっていなければ undefined。 */
  readonly wake: ((text: string) => void) | undefined;
  /** stderr へ出す口。 */
  readonly warn: (message: string) => void;
}

export async function noteRunnerSwap(deps: NoteRunnerSwapDeps): Promise<void> {
  // **この呼び出しがこの関数の最初の文でなければならない。** 呼び出し側は
  // この関数を `void` で起こした直後に `takeOverOnSwap(runnerId)` を呼び、
  // 引き取りは台帳を書き換える（走行中だった委譲を lost へ落とす等）。
  // async 関数は最初の `await` まで同期に走るので、ここで `listJobs()` を
  // 呼んで Promise を掴んでおけば、呼び出し側が
  // `void noteRunnerSwap(...); takeOverOnSwap(...);` と書く限り、台帳の読みの
  // *発行*が引き取りより先に起きる。これは「読めた内容が入れ替え前の状態だと
  // 保証する」ものではない（実装がストレージ層を挟む以上、発行順と完了順は
  // 別物になりうる）——それでも、引き取りが書き換え始める前に読みを投げて
  // おくほうが、後回しにして「引き取りが `lost` へ落とした後の台帳」を数えて
  // しまう事故より確実に安全側である。
  //
  // 同期に投げた例外も reject も同じく「読めなかった（undefined）」へ畳む。
  let jobsPromise: Promise<readonly Job[] | undefined>;
  try {
    jobsPromise = deps.listJobs().then(
      (jobs) => jobs,
      () => undefined,
    );
  } catch {
    jobsPromise = Promise.resolve(undefined);
  }

  // 同じ理由で名簿の読みも `await` より前で済ませる。`aliveRunnerIds` は
  // 同期に返る契約だが、万一 TDZ 等の稀な順序で同期に投げても「読めなかった」
  // （undefined）へ畳んで起こす側に倒す——数えられないときは常に安全側。
  let aliveRunnerIds: ReadonlySet<string> | undefined;
  try {
    aliveRunnerIds = deps.aliveRunnerIds();
  } catch {
    aliveRunnerIds = undefined;
  }

  const jobs = await jobsPromise;
  const decision = decideRunnerSwapNotice({ runnerId: deps.runnerId, jobs, aliveRunnerIds });

  // **先に起こす。** `deps.wake` が無ければ（クローンがまだ立ち上がっていない）
  // stderr にだけ残す——`announce` の既定と同じ形。
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

  // `notice`（元の文言）は必ずどこかに含める——依頼者が後から「あのとき本当に
  // 0本だったのか」を `grounds` から検算できるようにするため。
  const grounds =
    decision.grounds +
    (wokeViaStderrOnly ? '。クローンの受信箱がまだ無いので stderr にだけ残した' : '') +
    `。元の知らせ: ${deps.notice}`;

  // **その後で日誌へ。** `decision` が済んでいれば、日誌が書けなくても起床は
  // 既に済んでいる——日誌の失敗で「起こすはずだったのに起きなかった」という
  // 事故を作らない（`reportRunnerUnknown` / `reportRunnerDropped` と同じ、
  // 「記録の失敗でデーモンを止めない」作法）。
  try {
    await deps.journal({ type: 'decision', decision: decisionText, grounds });
  } catch (error: unknown) {
    deps.warn(`器の入れ替えの判断を日誌へ残せませんでした: ${String(error)}\n  ${decisionText}`);
  }
}
