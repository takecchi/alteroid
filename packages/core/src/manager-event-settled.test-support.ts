/**
 * 出来事の処理（`Pool#onEvent`）の完了が、microtask の何周目に戻るかを数える試験のための目印。
 *
 * `connect` へ渡る受け口は Promise を返さないので、外からは完了が見えない。代わりに、`Pool` が出来事の追跡用の枝を
 * `#eventsInFlight`（`Set`）から外す瞬間（`running.finally(...)` の中）を、`Set.prototype.delete` の呼び出しとして拾う。
 * Promise を渡された `delete` だけを数え、元の動きは変えない。`restore()` で戻す。
 *
 * 外す瞬間は、`#onEvent` の Promise が決着してから `.catch` の枝と `.finally` の枝を経た 2 周後になる。
 * 周回数で読むときは、見えた周から {@link EVENT_SETTLED_LAG} を引くと、`#onEvent` の完了そのものの周になる
 * （以前は `#onEvent` の `finally` で直に印を打っていた。その周と同じ数で読むための引き算）。
 */
export const EVENT_SETTLED = 'runner-event-settled';
export const EVENT_SETTLED_LAG = 2;

export function trackEventSettled(sink: string[]): { restore(): void } {
  const original = Set.prototype.delete;
  Set.prototype.delete = function (this: Set<unknown>, value: unknown): boolean {
    if (value instanceof Promise) sink.push(EVENT_SETTLED);
    return original.call(this, value);
  };
  return {
    restore() {
      Set.prototype.delete = original;
    },
  };
}
