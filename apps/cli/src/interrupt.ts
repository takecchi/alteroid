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

export async function requestInterrupt(client: DaemonClient, target: Target): Promise<string> {
  const response = await client.clone.interrupt.$post();
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
  return describeInterruptOutcome((await response.json()).outcome);
}

export function describeInterruptOutcome(
  outcome: 'interrupted' | 'idle' | 'unsupported' | 'withdrawn' | 'not_target' | 'starting',
): string {
  switch (outcome) {
    case 'interrupted':
      return 'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';
    case 'idle':
      return '走っているターンは無かった（止めるものが無い）。';
    case 'withdrawn':
      return '順番待ちだった発言を取り下げた（クローンには配らない）。';
    case 'not_target':
      return '走っているのは別の仕事のターンなので、止めなかった。';
    case 'starting':
      return 'ターンがまだ始まる前だったので、止められなかった。もう一度止めると止まる。';
    case 'unsupported':
      return 'このデーモンのクローンは、ターンを止める口を持っていない。';
  }
}
