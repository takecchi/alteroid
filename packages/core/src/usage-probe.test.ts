import { describe, expect, it } from 'vitest';

import { runUsageProbe, type UsageProbeHandle, type UsageProbeQuery } from './usage-probe.js';

/**
 * `queryFn` に渡された `options`（SDK の `Options`）を横から覗くための偽物。
 * probe は `read` の返り値だけを見るので、`capture` へ実際に渡された `Options`
 * を積んでおいて、呼び出し後にテストがそれを検分する。
 */
function capturingProbe(): { queryFn: UsageProbeQuery; captured: unknown[] } {
  const captured: unknown[] = [];
  const queryFn: UsageProbeQuery = ({ options }) => {
    captured.push(options);
    const handle: UsageProbeHandle = {
      async *[Symbol.asyncIterator]() {
        /* probe は control channel しか読まない */
      },
    };
    return handle;
  };
  return { queryFn, captured };
}

describe('runUsageProbe — env を渡す口', () => {
  it('env を渡さないとき、Options に env が載らない（既定の経路が変わらない）', async () => {
    const { queryFn, captured } = capturingProbe();
    await runUsageProbe(queryFn, { cwd: '/tmp/wherever' }, async () => 'ignored');

    expect(captured).toHaveLength(1);
    const options = captured[0] as Record<string, unknown>;
    expect('env' in options).toBe(false);
  });

  it('env を渡すと { ...process.env, ...渡した値 } になる（丸ごと置き換わらない）', async () => {
    const { queryFn, captured } = capturingProbe();
    // process.env に既に在る変数（PATH）が残っていることまで見る。
    expect(process.env.PATH).toBeDefined();

    await runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', env: { CLAUDE_CODE_OAUTH_TOKEN: 'DUMMY-NOT-A-REAL-TOKEN' } },
      async () => 'ignored',
    );

    expect(captured).toHaveLength(1);
    const options = captured[0] as { env?: Record<string, string | undefined> };
    expect(options.env).toBeDefined();
    // 既存の環境変数が残っている（丸ごと置き換わっていない）。
    expect(options.env?.PATH).toBe(process.env.PATH);
    // 渡した値が上書きとして載っている。
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('DUMMY-NOT-A-REAL-TOKEN');
  });

  it('settingSources は常に project のみ（env の有無で変わらない）', async () => {
    const { queryFn, captured } = capturingProbe();
    await runUsageProbe(
      queryFn,
      { cwd: '/tmp/wherever', env: { CLAUDE_CODE_OAUTH_TOKEN: 'DUMMY-NOT-A-REAL-TOKEN' } },
      async () => 'ignored',
    );
    const options = captured[0] as { settingSources?: string[] };
    expect(options.settingSources).toEqual(['project']);
  });
});
