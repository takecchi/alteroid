import { stdout } from './terminal-out.js';

import { createClient, type DaemonClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';

export async function interruptCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);
  stdout.write(`${await requestInterrupt(client, target)}\n`);
}

export type InterruptOutcome =
  'interrupted' | 'withdrawn' | 'not_target' | 'starting' | 'idle' | 'unsupported';

/** 止める対象の発言（`POST /chat` の `conversationId` と `clientMessageId`）。 */
export interface InterruptTarget {
  conversationId: string;
  clientMessageId: string;
}

export async function requestInterrupt(
  client: DaemonClient,
  target: Target,
  turn?: InterruptTarget,
): Promise<string> {
  return describeInterruptOutcome(await requestInterruptOutcome(client, target, turn));
}

/** 文にする前の outcome。呼び手が `withdrawn` で後始末をするために分けてある。 */
export async function requestInterruptOutcome(
  client: DaemonClient,
  target: Target,
  turn?: InterruptTarget,
): Promise<InterruptOutcome> {
  // 対象を省くと種類を問わず走っているターンを止める（従来どおり）。対象が分からない経路だけが省く。
  const response = await (turn === undefined
    ? client.clone.interrupt.$post()
    : client.clone.interrupt.$post({ json: turn } as never));
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `クローンのターンを止められませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  return (await response.json()).outcome;
}

export function describeInterruptOutcome(outcome: InterruptOutcome): string {
  switch (outcome) {
    case 'withdrawn':
      return '順番待ちだった発言を取り下げました（送っていません）。先客のターンには触れていません。';
    case 'not_target':
      return 'いま走っているのは、この発言のターンではない（別の起点の）ターンです。先客のターンは止めていません。';
    case 'starting':
      return 'この発言のターンが始まる直前でした（まだ止めていません）。もう一度 Ctrl+C を押してください。';
    case 'interrupted':
      return 'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';
    case 'idle':
      return '走っているターンは無かった（止めるものが無い）。';
    case 'unsupported':
      return 'このデーモンのクローンは、ターンを止める口を持っていない。';
  }
}
