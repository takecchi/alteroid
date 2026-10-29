import { countLegacyOnlyOpen } from './digest.js';
import type { Stores } from './store.js';

/** 発意 tick のターンを回した印になる日誌の行の頭（`turn-input.ts` の `describeTurnInput` が `turnInputEntry` で書く、ターンの入力の行）。 */
export const SELF_INITIATIVE_TURN_INPUT_PREFIX = 'ターンの入力: self_initiative ';

/** 1日1回の点検の間隔（#5469 P6a）。 */
export const INITIATIVE_DAILY_CHECK_MS = 24 * 60 * 60 * 1000;

export type InitiativeGateDecision =
  | { readonly run: true; readonly because: InitiativeRunReason }
  | {
      readonly run: false;
      readonly queued: number;
      readonly needsDecision: number;
      readonly waiting: number;
      /** 日誌から読めた、直近に発意 tick のターンを回した時刻（24時間より前は探さない）。無ければ `null`。 */
      readonly lastTickAt: string | null;
    };

export type InitiativeRunReason =
  | 'manual'
  | 'movable_task'
  | 'legacy_ledger_open' // #5469 P7 で消える
  | 'daily_check'
  | 'read_failed';

/**
 * 発意 tick をモデルのターンとして回すかを決める（#5469 P6a）。回すのは次のどれか:
 * (d) 手で起こした回、(a) 待ち行列に動ける task（queued / needs_decision）がある、
 * (b) 旧台帳に task の無い開いた行がある（#5469 P7 で消える）、(c) 直近24時間に発意 tick のターンを回していない。
 *
 * 読みが1つでも失敗したら回す側へ倒す: 黙って起こさない側へ倒すと、仕事が静かに止まるため。
 * 読めない行（`unreadable`）も同じ側へ倒す: 読めない task が動ける task かもしれず、「無い」とは言えないため。
 */
export async function decideInitiativeTick(
  stores: Pick<Stores, 'tasks' | 'commitments' | 'journal'>,
  options: { readonly cause: 'schedule' | 'schedule_catchup' | 'manual'; readonly now: Date },
): Promise<InitiativeGateDecision> {
  if (options.cause === 'manual') return { run: true, because: 'manual' };

  let queued = 0;
  let needsDecision = 0;
  let waiting = 0;
  try {
    const tasks = await stores.tasks.list();
    for (const task of tasks.entries) {
      if (task.status === 'queued') queued += 1;
      else if (task.status === 'needs_decision') needsDecision += 1;
      else if (task.status === 'waiting') waiting += 1;
    }
    if (queued + needsDecision > 0) return { run: true, because: 'movable_task' };
    if (tasks.unreadable.length > 0) return { run: true, because: 'read_failed' };

    // #5469 P7 で、台帳を撤去するときにこの分岐ごと消える
    const legacy = await countLegacyOnlyOpen(stores);
    if (legacy.open > 0) return { run: true, because: 'legacy_ledger_open' };
    if (legacy.unreadable > 0) return { run: true, because: 'read_failed' };

    const lastTickAt = await lastInitiativeTurnAt(stores, options.now);
    if (lastTickAt === null) return { run: true, because: 'daily_check' };
    return { run: false, queued, needsDecision, waiting, lastTickAt };
  } catch {
    return { run: true, because: 'read_failed' };
  }
}

/**
 * 直近24時間で最後に発意 tick のターンを回した時刻。無ければ `null`。
 * 日誌から読む: 再起動を越えて残るのは日誌だけで、メモリの時計は器が入れ替わると消えるため。
 * 印は `turnInputEntry` が書く行（exchange / with: self / inbound / 「ターンの入力: self_initiative …」）。ターンを回す直前に書かれる。
 * 回さずに畳んだ回の行（`[間引き] …`）は role が outbound で頭も違うので、印に数えない。
 * 検索で上位が別の行に埋まっても、見つからなければ「回していない」側（＝回す側）へ倒れるだけで、止まる側へは倒れない。
 */
async function lastInitiativeTurnAt(
  stores: Pick<Stores, 'journal'>,
  now: Date,
): Promise<string | null> {
  const since = new Date(now.getTime() - INITIATIVE_DAILY_CHECK_MS).toISOString();
  const rows = await stores.journal.list({
    types: ['exchange'],
    with: ['self'],
    since,
    q: SELF_INITIATIVE_TURN_INPUT_PREFIX,
    order: 'desc',
    limit: 50,
  });
  for (const row of rows) {
    if (
      row.type === 'exchange' &&
      row.with === 'self' &&
      row.role === 'inbound' &&
      row.text.startsWith(SELF_INITIATIVE_TURN_INPUT_PREFIX)
    ) {
      return row.at;
    }
  }
  return null;
}
