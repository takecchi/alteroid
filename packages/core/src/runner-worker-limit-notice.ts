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

/** 同じ作業者を重ねて数えない期間。 */
export const WORKER_LIMIT_DEDUPE_MS = 60 * 60_000;

/** 原文の抜粋の長さ。 */
export const WORKER_LIMIT_RAW_MAX_CHARS = 300;

const NOTICES_SHOWN = 3;

interface PendingEntry {
  label: string;
  raw: string;
  at: number;
}

/** 日誌の note に足す1文。鍵の回転の後も回転前の鍵で走っているセッションの作業者が落ちたとき。 */
export const WORKER_LIMIT_PRE_ROTATION_KEY_SENTENCE =
  'このセッションは、鍵の回転の後もまだ回転前の鍵で走っている（ターンの境界で新しい鍵へ移る）。作業者は古い鍵で落ちた見込みが高い。';

/**
 * 回転前の鍵で作業者が落ちていたセッションを、境界で新しい鍵へ開き直した直後に入れる一言（#5046）。
 * 担当は知らせ（`describeWorkerLimit` の回転前の文）に従ってターンを終え、開き直しを待っている。入れないと誰にも起こされない。
 */
export const WORKER_LIMIT_REOPENED_NUDGE =
  '（alteroid より: 鍵の回転の後、回転前の鍵のまま作業者が利用上限で落ちていた。ターンの境界で、新しい鍵でセッションを開き直した（会話は続いている）。' +
  '落ちた作業者がどこまで進めたか（未コミットの変更が残っていないかも）を確かめ、必要なら作業者を立て直して続きを進めよ。' +
  'もう終わっていたなら、そう報告して終えること）';

/**
 * `preRotationKey` が真のときだけ、「戻るまで〜同じく落ちうる」を言わない: 鍵は回っていて、境界で新しい鍵へ移るため。
 * 真偽は配る時点のセッションの印で決める（記録した時点ではない）: 配る前に開き直していれば、もう回転前の鍵ではない。
 */
export function describeWorkerLimit(
  entries: readonly { label: string; raw: string }[],
  preRotationKey = false,
): string {
  const shown = entries
    .slice(0, NOTICES_SHOWN)
    .map(
      (entry) => `作業者（${entry.label}）が利用上限で落ちた（原文: ${truncateRaw(entry.raw)}）`,
    );
  const omitted = entries.length - NOTICES_SHOWN;
  const list = shown.join('、') + (omitted > 0 ? `、ほか ${String(omitted)} 体` : '');
  const advice = preRotationKey
    ? '鍵は回っているので、このターンを終えれば新しい鍵で開き直る。' +
      // 開き直した後に続きを促す一言が届くことを言う（#5046）: 言わないと、ターンを終えたら止まったままになると読んで、古い鍵のまま作業者を立て直すため
      '開き直すと、続きを促す一言が届く。' +
      '作業者を立て直すなら、ターンを終えて開き直った後にする（止める指示ではない）。'
    : '戻るまで、作業者を立て直しても同じく落ちうる。自分で進めるか、戻るのを待つか、別の手を選べ。' +
      'これは状況の知らせで、止める指示ではない。';
  return `⚠ alteroid からの知らせ: ${list}。${advice}`;
}

/** 名札。分かる id を全部書く（tool_use と task の両方が分かれば両方）。どちらも無ければ「背景の作業者」。 */
export function workerLimitLabel(
  toolUseId: string | undefined,
  taskId: string | undefined,
): string {
  if (toolUseId !== undefined && taskId !== undefined)
    return `tool_use ${toolUseId} ・task ${taskId}`;
  if (toolUseId !== undefined) return `tool_use ${toolUseId}`;
  if (taskId !== undefined) return `task ${taskId}`;
  return '背景の作業者';
}

function truncateRaw(raw: string): string {
  const flat = raw.trim();
  return flat.length <= WORKER_LIMIT_RAW_MAX_CHARS
    ? flat
    : `${flat.slice(0, WORKER_LIMIT_RAW_MAX_CHARS)}…`;
}

export class WorkerLimitNotices {
  #pending: PendingEntry[] = [];
  /** 配り済みでも、同じ作業者を重ねて数えないための控え（身元 → 記録した時刻）。 */
  readonly #recent = new Map<string, number>();
  readonly #lastNotifiedAt = new Map<string, number>();
  /** 担当本人以外（作業者）に配った記録。エントリごとに、誰に配ったかを覚える。 */
  readonly #deliveredTo = new Map<PendingEntry, Set<string>>();

  /**
   * 新しく覚えたら `true`（日誌・クローンへ運ぶ側がこれで1回だけ運ぶ）。重複は `false`。
   * 重複は作業者の身元（`identity`）だけで判定する。名札（`label`）と原文は判定に使わない:
   * 作業者が落ちると発言の拒否の印とタスクの失敗通知の2つが届き、名札も原文も違うので、名札＋原文で見ると2回記録されたため（#4996）。
   */
  record(identity: string, label: string, raw: string, nowMs: number): boolean {
    for (const [key, at] of this.#recent) {
      if (nowMs - at >= WORKER_LIMIT_DEDUPE_MS) this.#recent.delete(key);
    }
    if (this.#recent.has(identity)) return false;
    this.#recent.set(identity, nowMs);
    if (this.#pending.length >= WORKER_LIMIT_PENDING_MAX) {
      const dropped = this.#pending.shift();
      if (dropped !== undefined) this.#deliveredTo.delete(dropped);
    }
    this.#pending.push({ label, raw, at: nowMs });
    return true;
  }

  /** 知らせるなら本文を、知らせないなら `null` を返す。担当本人に配ったものは消す。 */
  next(
    actor: string,
    isOwner: boolean,
    nowMs: number,
    preRotationKey = false,
  ): { text: string; count: number } | null {
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
    return { text: describeWorkerLimit(fresh, preRotationKey), count: fresh.length };
  }
}
