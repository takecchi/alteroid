export interface RunnerPushOutcomeLike {
  ok: boolean;
}

export interface RunnerPushesLike<T extends RunnerPushOutcomeLike = RunnerPushOutcomeLike> {
  runners?: readonly T[];
}

// `runners` が空・欄が無いのは失敗に数えない: 配る相手が居ないだけで、反映が壊れたのではないため。
export function failedRunnerPushes<T extends RunnerPushOutcomeLike>(
  update: RunnerPushesLike<T>,
): T[] {
  return (update.runners ?? []).filter((runner) => !runner.ok);
}

export function hasRunnerPushFailure(update: RunnerPushesLike): boolean {
  return failedRunnerPushes(update).length > 0;
}

// `ok: true` でも指紋が違う runner は反映できていない側に数える: 成功の見出しの下に赤い行だけが並ぶと `ok: false` が埋もれるのと同じ形になるため。
export function hasMcpFingerprintMismatch(update: {
  sha256?: string;
  runners?: readonly { ok: boolean; mcpServers?: { sha256: string } }[];
}): boolean {
  if (update.sha256 === undefined) return false;
  return (update.runners ?? []).some(
    (runner) =>
      runner.ok && runner.mcpServers !== undefined && runner.mcpServers.sha256 !== update.sha256,
  );
}

export function hasMcpPushProblem(
  update: Parameters<typeof hasMcpFingerprintMismatch>[0],
): boolean {
  return hasRunnerPushFailure(update) || hasMcpFingerprintMismatch(update);
}
