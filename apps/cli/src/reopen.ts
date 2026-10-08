import { stdout } from './terminal-out.js';

import { createClient, type DaemonClient } from './client.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';

export interface ReopenOptions {
  yes?: boolean;
  distill?: boolean;
  reason?: string;
}

export interface ReopenResult {
  outcome: 'now' | 'deferred' | 'unsupported';
  previousSessionId?: string | null | undefined;
  runningManagers?: number | undefined;
}

/**
 * `alteroid reopen` — クローンのセッションを resume せずに新しく開き直す（#4173）。
 *
 * 安全分類器に弾かれる内容が長寿命のセッションへ入ると、以後のターンが全部弾かれ、
 * デーモンを再起動しても同じ生ログが戻る。人間がそこから抜けるための口で、経路は
 * `POST /clone/session/reopen` の1本だけである。生ログは消えない（退避される）。
 * 会話の文脈は戻らないので、`reset` と同じ確認を経る（`--yes` で省ける）。
 */
export async function reopenCommand(options: ReopenOptions = {}, io?: ConfirmIo): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  await confirmIrreversible(buildReopenConfirmMessage(options), options, io);
  const client = createClient(target.baseUrl, target.headers);
  const result = await requestReopen(client, target, options);
  stdout.write(`${describeReopenResult(result)}\n`);
}

export function buildReopenConfirmMessage(options: ReopenOptions): string {
  return (
    'クローンのセッションを resume せずに開き直しますか？\n' +
    '古いセッションの生ログは消さず、アーカイブへ退避します（会話の記録も残ります）。\n' +
    'ただし、クローンはそれまでの会話の文脈を持たない新しいセッションで始まります。\n' +
    '走っているターンは最後まで走ります。マネージャーは止めません。\n' +
    (options.distill === true
      ? '古いセッションの末尾を記憶へ蒸留します（--distill）。'
      : '古いセッションの末尾は記憶へ蒸留しません（既定。蒸留するなら --distill）。')
  );
}

export async function requestReopen(
  client: DaemonClient,
  target: Target,
  options: ReopenOptions,
): Promise<ReopenResult> {
  const response = await client.clone.session.reopen.$post({
    json: {
      confirm: true,
      ...(options.distill === undefined ? {} : { distill: options.distill }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
  });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `クローンのセッションを開き直せませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  return (await response.json()) as ReopenResult;
}

/** 応答の3値を人間の言葉にする。 */
export function describeReopenResult(result: ReopenResult): string {
  const lines: string[] = [];
  switch (result.outcome) {
    case 'deferred':
      lines.push(
        'いまのターンが終わった境界で、新しいセッションに開き直す（走っているターンは最後まで走る）。',
      );
      break;
    case 'now':
      lines.push('いまはセッションが無かった。次の合図から新しいセッションで始まる。');
      break;
    case 'unsupported':
      lines.push('このデーモンのクローンは、セッションを開き直す口を持っていない。');
      return lines.join('\n');
  }
  if (result.previousSessionId !== undefined && result.previousSessionId !== null) {
    lines.push(`古いセッション id: ${result.previousSessionId}`);
  }
  if (result.runningManagers !== undefined && result.runningManagers > 0) {
    lines.push(
      `走っているマネージャーが ${String(result.runningManagers)} 本いる。マネージャーは止めていない。その報告は新しいセッションへ届く。`,
    );
  }
  return lines.join('\n');
}
