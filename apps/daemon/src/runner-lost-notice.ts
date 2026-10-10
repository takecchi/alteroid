// 器が一斉に作り直されると `onLost` が1台ごとに来て、クローンの受信箱へ1台1通届く（実測: 約20秒で8通）。
// クローンへの知らせだけをここで1通へ合流する。stderr の1行・移送・日誌は1台ずつその場で行い、ここへは通さない（遅らせると移送が遅れるため）。

/**
 * `packages/core/src/runner-protocol.ts` の `HEARTBEAT_LOST_MS`（30秒）の写し。
 * core は export していない。窓を「器が名乗らなくなるまでの時間」に揃えるための値で、ずれたらこちらを直す。
 */
export const RUNNER_LOST_COALESCE_MS = 30_000;

export interface RunnerLostEntry {
  readonly label: string;
  readonly runnerId?: string | undefined;
  /** 秘匿済みの理由。 */
  readonly reason: string;
}

const NOTICE_TAIL =
  '新しい委譲の宛先からは外し、そこで走っていた委譲の移送を試みます' +
  '（貸し出し期限が切れていない委譲は、切れてから自動で移します）';

const nameOf = (entry: RunnerLostEntry): string =>
  entry.runnerId === undefined ? entry.label : entry.runnerId;

const fullNameOf = (entry: RunnerLostEntry): string =>
  entry.runnerId === undefined ? entry.label : `${entry.runnerId}（${entry.label}）`;

/** 1台ぶんの文面。stderr の1行にも使う。 */
export function describeRunnerLost(entry: RunnerLostEntry): string {
  return (
    `runner (${entry.label}${entry.runnerId === undefined ? '' : ` / ${entry.runnerId}`}) が` +
    `名乗らなくなりました。${NOTICE_TAIL}: ${entry.reason}`
  );
}

/** 窓の中の台をクローンへ送る1通にする。1台なら `describeRunnerLost` と同じ。 */
export function composeRunnerLostNotice(entries: readonly RunnerLostEntry[]): string {
  const [only] = entries;
  if (only === undefined) return '';
  if (entries.length === 1) return describeRunnerLost(only);

  const head = `runner ${entries.length} 台が名乗らなくなりました（${entries.map(nameOf).join('・')}）。${NOTICE_TAIL}。`;
  const firstReason = only.reason;
  if (entries.every((entry) => entry.reason === firstReason)) {
    // 宛先の名指し（runnerId と label の両方）を、ひとまとめの理由の側でも落とさない。
    const detailed = entries.some(
      (entry) => entry.runnerId !== undefined && entry.runnerId !== entry.label,
    );
    const targets = detailed ? `\n宛先: ${entries.map(fullNameOf).join('、')}` : '';
    return `${head}${targets}\n理由（${entries.length} 台とも同じ）: ${firstReason}`;
  }
  return `${head}\n${entries.map((entry) => `- ${fullNameOf(entry)}: ${entry.reason}`).join('\n')}`;
}

export interface RunnerLostNoticeDeps {
  readonly send: (text: string) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly windowMs?: number;
}

export interface RunnerLostNotice {
  add(entry: RunnerLostEntry): void;
  /** 窓の中の分をすぐ送り、タイマーを止める。空なら何も送らない。 */
  flush(): void;
}

export function createRunnerLostNotice(deps: RunnerLostNoticeDeps): RunnerLostNotice {
  const windowMs = deps.windowMs ?? RUNNER_LOST_COALESCE_MS;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    });
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));

  let pending: RunnerLostEntry[] = [];
  let timer: unknown = undefined;
  let open = false;

  const drain = (): void => {
    open = false;
    timer = undefined;
    const entries = pending;
    pending = [];
    if (entries.length === 0) return;
    deps.send(composeRunnerLostNotice(entries));
  };

  return {
    add(entry) {
      pending.push(entry); // 窓は最初の1台で開き、延長しない: 来続ける限り送られない形にしないため。
      if (open) return;
      open = true;
      timer = setTimer(drain, windowMs);
    },
    flush() {
      if (timer !== undefined) clearTimer(timer);
      drain();
    },
  };
}
