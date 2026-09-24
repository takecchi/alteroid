import { stdout } from 'node:process';

import { createClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid interrupt` — いま走っているクローンのターンを止める（#1398 c23-1）。
 *
 * 経路は `POST /clone/interrupt` の1本だけである。それまで人間が走行中のクローンの
 * ターンを止める口は、HTTP・CLI・Web UI のどこにも無かった。止めるのはいまの
 * ターンだけで、セッション（会話の続き）と受信箱はそのまま残る。
 *
 * 応答の3値（`interrupted` / `idle` / `unsupported`）を言い分ける —— 「止めるものが
 * 無かった」を「止めた」と言わない。
 */
export async function interruptCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.clone.interrupt.$post();
  if (!response.ok) {
    stdout.write(`クローンのターンを止められませんでした（HTTP ${String(response.status)}）\n`);
    return;
  }
  stdout.write(`${describeInterruptOutcome((await response.json()).outcome)}\n`);
}

/** 応答の3値を人間の言葉にする。 */
export function describeInterruptOutcome(outcome: 'interrupted' | 'idle' | 'unsupported'): string {
  switch (outcome) {
    case 'interrupted':
      return 'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';
    case 'idle':
      return '走っているターンは無かった（止めるものが無い）。';
    case 'unsupported':
      return 'このデーモンのクローンは、ターンを止める口を持っていない。';
  }
}
