import { isPidsUnderPressure } from './manager-auto-fold.js';

/**
 * 器（runner）の pids が上限に近いとき、走っている担当に、その事実を道具の結果に添えて知らせる。
 *
 * pids の上限は器全体で1つで、同じ器の担当・作業者・dev サーバー・E2E・ブラウザが全部その1つを分け合う。上限に当たると fork が断られ、
 * Claude Code 本体がスレッドを作れずに SIGABRT で落ちることがある。置き先の選び方（`chooseByResources`）は新しい委譲を
 * 飽和した器から外すが、**すでにその器で走っている担当には何も届かず**、知らないまま重い処理を重ねていく。
 *
 * **知らせるだけで、止めない・断らない**（能力を削らない）。重い処理を続けるかは担当が決める。
 * 閾値はデーモンが手の空いた担当を畳む判定（{@link isPidsUnderPressure}、上限の 80%）と同じ値を使い、設定項目にしない。
 */

export interface PidsPressureReading {
  readonly current: number;
  readonly max: number;
  /** この器で手を動かしている担当（ターン中・返事待ち・背景処理が残っている委譲）の本数。手が空いた done の担当は数えない。 */
  readonly delegations: number;
}

/** 同じ相手へ知らせ直すまでの間隔。逼迫が続く間、道具を使うたびに同じ段落が積まれて文脈を食わないため。 */
export const PIDS_PRESSURE_NOTICE_INTERVAL_MS = 5 * 60_000;

export function describePidsPressure(reading: PidsPressureReading): string {
  const percent = Math.round((reading.current / reading.max) * 100);
  return (
    `⚠ alteroid からの知らせ: この器（runner）の pids が ${String(reading.current)}/${String(reading.max)}（${String(percent)}%）で、上限に近い。` +
    `pids の上限は器全体で1つで、この器で手を動かしている担当 ${String(reading.delegations)} 本（ターン中・返事待ち・背景処理が残っているもの）と、` +
    'それぞれの作業者・dev サーバー・テスト・ブラウザが分け合っている。上限に当たると fork が断られ、Claude Code 本体ごと落ちることがある。' +
    '新しく重い処理（作業者の並列起動・dev サーバー・E2E・テストの並列実行・ブラウザ）を始める前に、' +
    '要らなくなった背景処理や dev サーバーを止め、同時に走らせる数を減らすことを考えること。' +
    'これは状況の知らせで、止める指示ではない。どうするかはあなたが決める。'
  );
}

/**
 * 1つのセッションの中で、誰（担当本人か、どの作業者か）にいつ知らせたかを覚える。
 * 逼迫が解けたら忘れる: 次に逼迫したときは、間隔を待たずにもう一度知らせる。
 */
export class PidsPressureNotices {
  readonly #lastNotifiedAt = new Map<string, number>();

  /** 知らせるなら本文を、知らせないなら `null` を返す。読めなかった（`undefined`）ときは知らせず、覚えも変えない。 */
  next(actor: string, reading: PidsPressureReading | undefined, nowMs: number): string | null {
    if (reading === undefined) return null;
    if (!isPidsUnderPressure(reading)) {
      this.#lastNotifiedAt.clear();
      return null;
    }
    const last = this.#lastNotifiedAt.get(actor);
    if (last !== undefined && nowMs - last < PIDS_PRESSURE_NOTICE_INTERVAL_MS) return null;
    this.#lastNotifiedAt.set(actor, nowMs);
    return describePidsPressure(reading);
  }
}

/**
 * 読み取りを短い間だけ使い回す: 道具を使うたびに cgroup のファイルを読み直さないため。器全体の値なので、セッションを跨いで共有してよい。
 * 読み取りが投げたら `undefined`（知らせない側）へ倒す: 知らせのために道具の結果を壊さないため。
 */
export function cachedPidsReader(
  read: () => Promise<{ current: number; max: number } | undefined>,
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<{ current: number; max: number } | undefined> {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: Promise<{ current: number; max: number } | undefined> } | null =
    null;
  return () => {
    const at = now();
    if (cached === null || at - cached.at >= ttlMs) {
      cached = { at, value: read().catch(() => undefined) };
    }
    return cached.value;
  };
}
