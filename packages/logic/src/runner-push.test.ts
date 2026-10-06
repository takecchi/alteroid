import { describe, expect, it } from 'vitest';

import {
  failedRunnerPushes,
  hasMcpFingerprintMismatch,
  hasMcpPushProblem,
  hasRunnerPushFailure,
} from './runner-push.js';

describe('hasRunnerPushFailure', () => {
  it('全部 ok なら失敗ではない', () => {
    expect(hasRunnerPushFailure({ runners: [{ ok: true }, { ok: true }] })).toBe(false);
  });

  it('1台でも ok:false なら失敗（残りが ok でも）', () => {
    expect(hasRunnerPushFailure({ runners: [{ ok: true }, { ok: false }] })).toBe(true);
  });

  it('runner が0台（配る先なし）は失敗ではない', () => {
    expect(hasRunnerPushFailure({ runners: [] })).toBe(false);
  });

  it('runners 欄が無い（古いデーモン）は失敗と言わない', () => {
    expect(hasRunnerPushFailure({})).toBe(false);
  });
});

describe('failedRunnerPushes', () => {
  it('失敗した行だけを順のまま返す', () => {
    const runners = [
      { runnerId: 'a', ok: false },
      { runnerId: 'b', ok: true },
      { runnerId: 'c', ok: false },
    ];
    expect(failedRunnerPushes({ runners }).map((r) => r.runnerId)).toEqual(['a', 'c']);
  });
});

describe('MCP の指紋の不一致', () => {
  it('ok でも指紋が違えば反映できていない側に数える', () => {
    const update = { sha256: 'aaa', runners: [{ ok: true, mcpServers: { sha256: 'bbb' } }] };
    expect(hasMcpFingerprintMismatch(update)).toBe(true);
    expect(hasMcpPushProblem(update)).toBe(true);
  });

  it('指紋が同じ・指紋が返らない・保存側に指紋が無い（外した）は問題ではない', () => {
    expect(
      hasMcpPushProblem({ sha256: 'aaa', runners: [{ ok: true, mcpServers: { sha256: 'aaa' } }] }),
    ).toBe(false);
    expect(hasMcpPushProblem({ sha256: 'aaa', runners: [{ ok: true }] })).toBe(false);
    expect(hasMcpPushProblem({ runners: [{ ok: true, mcpServers: { sha256: 'bbb' } }] })).toBe(
      false,
    );
  });

  it('ok:false（unsupported 含む）は問題', () => {
    expect(hasMcpPushProblem({ runners: [{ ok: false }] })).toBe(true);
  });
});
