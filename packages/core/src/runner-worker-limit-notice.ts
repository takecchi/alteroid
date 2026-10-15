/**
 * 作業者（サブエージェント）だけが利用上限で落ちた事実を、担当の次の道具の結果に添えて知らせる（#4903）。
 *
 * 作業者だけが上限に当たっても担当のターンは成功しうる。ターンの集計（`RunnerTurnTally`）は結果ごとに空になるので、
 * 担当のターンが成功すると事実が捨てられ、担当のモデルの文脈には SDK の通知文しか残らない。ここはターンをまたいで保持する。
 * **知らせるだけで、止めない・断らない**。進めるか・待つか・別の手を選ぶかは担当が決める。鍵の回転や枠の印の契機にもしない。
 */

/** 同じ相手へ知らせ直す間隔。落ちた作業者が続けて通知を出しても、道具を使うたびに同じ段落が積まれないため。 */
export const WORKER_LIMIT_NOTICE_INTERVAL_MS = 10 * 60_000;

/** 配る前の知らせを抱える上限。 */
export const WORKER_LIMIT_PENDING_MAX = 8;

/** 同じ（作業者・原文）を重ねて数えない期間。 */
export const WORKER_LIMIT_DEDUPE_MS = 60 * 60_000;

/** 原文の抜粋の長さ。 */
export const WORKER_LIMIT_RAW_MAX_CHARS = 300;

const NOTICES_SHOWN = 3;

interface PendingEntry {
  label: string;
  raw: string;
  at: number;
}

export function describeWorkerLimit(entries: readonly { label: string; raw: string }[]): string {
  const shown = entries
    .slice(0, NOTICES_SHOWN)
    .map(
      (entry) => `作業者（${entry.label}）が利用上限で落ちた（原文: ${truncateRaw(entry.raw)}）`,
    );
  const omitted = entries.length - NOTICES_SHOWN;
  const list = shown.join('、') + (omitted > 0 ? `、ほか ${String(omitted)} 体` : '');
  return (
    `⚠ alteroid からの知らせ: ${list}。` +
    '戻るまで、作業者を立て直しても同じく落ちうる。自分で進めるか、戻るのを待つか、別の手を選べ。' +
    'これは状況の知らせで、止める指示ではない。'
  );
}

function truncateRaw(raw: string): string {
  const flat = raw.trim();
  return flat.length <= WORKER_LIMIT_RAW_MAX_CHARS
    ? flat
    : `${flat.slice(0, WORKER_LIMIT_RAW_MAX_CHARS)}…`;
}

export class WorkerLimitNotices {
  #pending: PendingEntry[] = [];
  /** 配り済みでも、同じものを重ねて数えないための控え（キー → 記録した時刻）。 */
  readonly #recent = new Map<string, number>();
  readonly #lastNotifiedAt = new Map<string, number>();
  /** 担当本人以外（作業者）に配った記録。エントリごとに、誰に配ったかを覚える。 */
  readonly #deliveredTo = new Map<PendingEntry, Set<string>>();

  /** 新しく覚えたら `true`（日誌・クローンへ運ぶ側がこれで1回だけ運ぶ）。重複・上限超えは `false`。 */
  record(label: string, raw: string, nowMs: number): boolean {
    for (const [key, at] of this.#recent) {
      if (nowMs - at >= WORKER_LIMIT_DEDUPE_MS) this.#recent.delete(key);
    }
    const key = `${label}\u0000${raw}`;
    if (this.#recent.has(key)) return false;
    this.#recent.set(key, nowMs);
    if (this.#pending.length >= WORKER_LIMIT_PENDING_MAX) {
      const dropped = this.#pending.shift();
      if (dropped !== undefined) this.#deliveredTo.delete(dropped);
    }
    this.#pending.push({ label, raw, at: nowMs });
    return true;
  }

  /** 知らせるなら本文を、知らせないなら `null` を返す。担当本人に配ったものは消す。 */
  next(actor: string, isOwner: boolean, nowMs: number): { text: string; count: number } | null {
    this.#pending = this.#pending.filter((entry) => nowMs - entry.at < WORKER_LIMIT_DEDUPE_MS);
    const fresh = this.#pending.filter((entry) => !this.#deliveredTo.get(entry)?.has(actor));
    if (fresh.length === 0) return null;
    const last = this.#lastNotifiedAt.get(actor);
    if (last !== undefined && nowMs - last < WORKER_LIMIT_NOTICE_INTERVAL_MS) return null;
    this.#lastNotifiedAt.set(actor, nowMs);
    for (const entry of fresh) {
      const set = this.#deliveredTo.get(entry) ?? new Set<string>();
      set.add(actor);
      this.#deliveredTo.set(entry, set);
    }
    if (isOwner) {
      const delivered = new Set(fresh);
      this.#pending = this.#pending.filter((entry) => !delivered.has(entry));
      for (const entry of fresh) this.#deliveredTo.delete(entry);
    }
    return { text: describeWorkerLimit(fresh), count: fresh.length };
  }
}
