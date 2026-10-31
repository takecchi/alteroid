export interface ReopenResultView {
  outcome: 'now' | 'deferred' | 'unsupported';
  previousSessionId?: string | null | undefined;
  runningManagers?: number | undefined;
}

/** `POST /clone/session/reopen` の応答の3値を人間の言葉にする（CLI の `alteroid reopen` と設定画面が共有する）。 */
export function describeReopenResult(result: ReopenResultView): string {
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
