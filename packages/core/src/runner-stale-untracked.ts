import type { StaleUntrackedTree } from './rescue-ref.js';

/**
 * 作業ツリーの未追跡のファイルが 30 分以上残っている担当・作業者に、その事実を道具の結果に添えて知らせる（#4863 案C）。
 *
 * 器が作り直されると、作業ツリーの未追跡のファイル（描いた絵など）は失われる。退避 ref（`rescue-ref.ts`）は未追跡を送らない決定なので、
 * commit も出し箱への写しもされないまま残っていると、本人が気づかないうちに消える。
 *
 * **知らせるだけで、止めない・断らない**（能力を削らない）。残すか・消すか・無視するかは担当が決める。
 * 初出時刻の記録は `RescueMemory` が持つ（退避の周期ごとに更新される）。この知らせは、その記録から古いものを読むだけである。
 */

/** 同じ相手へ知らせ直す間隔。未追跡が残り続ける間、道具を使うたびに同じ段落が積まれて文脈を食わないため。 */
export const STALE_UNTRACKED_NOTICE_INTERVAL_MS = 30 * 60_000;

const TREES_LIMIT = 3;

export function describeStaleUntracked(stale: readonly StaleUntrackedTree[]): string {
  const shown = stale.slice(0, TREES_LIMIT).map((tree) => {
    const rest = tree.count - tree.paths.length;
    const more = rest > 0 ? ` ほか ${String(rest)} 件` : '';
    const where = tree.relativePath === '' ? '.' : tree.relativePath;
    return `${where} の ${String(tree.count)} 件: ${tree.paths.join(', ')}${more}`;
  });
  const omittedTrees = stale.length - TREES_LIMIT;
  const trees = shown.join('、') + (omittedTrees > 0 ? `、ほか ${String(omittedTrees)} 本` : '');
  return (
    `⚠ alteroid からの知らせ: 作業ツリーに、30 分以上 commit されていない未追跡のファイルがある（${trees}）。` +
    '未追跡のファイルは退避 ref（器の入れ替えに備えて、未 push の変更を remote へ預ける仕組み）に入らないので、器が作り直されると失われる。' +
    '残すものなら、commit して push するか、成果物なら $ALTEROID_OUTBOX（設定されていれば）の直下へ写して報告に添えること。' +
    '要らないものなら消すか .gitignore に入れてよい。' +
    'これは状況の知らせで、止める指示ではない。どうするかはあなたが決める。'
  );
}

/**
 * 1つのセッションの中で、誰（担当本人か、どの作業者か）にいつ知らせたかを覚える。
 * 古い未追跡が無くなったら忘れる: 次に生じたときは、間隔を待たずにもう一度知らせる。
 */
export class StaleUntrackedNotices {
  readonly #lastNotifiedAt = new Map<string, number>();

  /** 知らせるなら本文を、知らせないなら `null` を返す。 */
  next(actor: string, stale: readonly StaleUntrackedTree[], nowMs: number): string | null {
    if (stale.length === 0) {
      this.#lastNotifiedAt.clear();
      return null;
    }
    const last = this.#lastNotifiedAt.get(actor);
    if (last !== undefined && nowMs - last < STALE_UNTRACKED_NOTICE_INTERVAL_MS) return null;
    this.#lastNotifiedAt.set(actor, nowMs);
    return describeStaleUntracked(stale);
  }
}
