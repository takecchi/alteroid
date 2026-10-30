import type { RunnerEvent } from '@alteroid/core';

import type { Outbox } from './app.js';

// 試験が「接続」を作るための道具。どれも本番の /events と同じ口（`Outbox#subscribe`）の上に作ってあり、`Outbox` に試験専用の口は無い。

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

// 脚が繋がっていて、溜まった分も後から積んだ分も同期で流し切る接続。渡した分は書き終えたことにする。外す関数を返す。
export function connectedSubscriber(
  outbox: Outbox,
  onEvent: (event: RunnerEvent, seq: number, queuedAt: string) => void,
): () => void {
  const deliver = (): void => {
    for (let item = subscription.peek(); item !== undefined; item = subscription.peek()) {
      onEvent(item.event, item.seq, item.queuedAt);
      subscription.wrote(item);
    }
  };
  const subscription = outbox.subscribe({ wake: deliver });
  deliver();
  return () => subscription.detach();
}

// 接続を1本つないで、いま列にある分（`lastEventId` があればその次から）を全部書き終えて外す。書いた連番を返す。
// `chars` を渡すと、その連番の本文の字数として控えの字数に数える（100万字級の出来事を本当に書かずに、上限の勘定だけを見るため）。
export function writeAll(
  outbox: Outbox,
  options: { lastEventId?: number; chars?: (seq: number) => number | undefined } = {},
): number[] {
  const subscription = outbox.subscribe({
    ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
    wake: () => undefined,
  });
  const written: number[] = [];
  for (let item = subscription.peek(); item !== undefined; item = subscription.peek()) {
    subscription.wrote(item, options.chars?.(item.seq));
    written.push(item.seq);
  }
  subscription.detach();
  return written;
}
