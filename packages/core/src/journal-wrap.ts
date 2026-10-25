import type { JournalStore } from './store.js';

/**
 * 日誌の器を包み、`overrides` に渡した口だけを差し替える。それ以外の口は、任意の口（`conversationWindowHeads`・`humanReplies` など）も含めて中身へそのまま渡す。
 * 中身が持たない任意の口は、包んだ後も `undefined` のまま（呼び手は `!== undefined` で器の口の有無を見て、遅い道へ倒すため）。
 *
 * 口を1つずつ並べて渡す形にしない: 包みが並べた口しか持たず、器に足した任意の口を黙って落とすため。
 * デーモンの購読の包みとクローンの道具の包みが `append`・`list`・`listPage`・`get`・`oldestAt`・`clear` だけを渡していて、
 * #5089・#5140 で足した速い口が本番の経路では全部落ち、会話の一覧が本文ごと読む道へ倒れて1回 6〜13 秒・DB 163〜178 本かかっていた。
 * 口は中身に束ねて返す: pg の器はクラスの private な欄（`#hidden` など）を使うので、`this` が包みのままだと呼んだ時点で落ちるため。
 */
export function wrapJournalStore(
  inner: JournalStore,
  overrides: Partial<JournalStore>,
): JournalStore {
  return new Proxy(inner, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return (overrides as Record<PropertyKey, unknown>)[property];
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    has(target, property) {
      return Object.hasOwn(overrides, property) || Reflect.has(target, property);
    },
  });
}
