import type { Outbox } from './app.js';

// 購読が付いたまま書かない接続（読まなくなったデーモン）を作る。出来事は列に残り、`drain` で書き終えたことにする。
export function stuckSubscriber(outbox: Outbox): { drain: () => void; detach: () => void } {
  const subscription = outbox.subscribe({ wake: () => undefined });
  return {
    drain: () => {
      for (let item = subscription.peek(); item !== undefined; item = subscription.peek()) {
        subscription.wrote(item);
      }
    },
    detach: () => subscription.detach(),
  };
}
