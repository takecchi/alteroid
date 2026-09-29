import { describe, expect, it } from 'vitest';

import { isDaemonAnsweredTool } from './daemon-answered-tool.js';

/**
 * `isDaemonAnsweredTool`（Issue #2173）——`runner.ts` の `#onPermission` が
 * 確認を「質問」と「許可」に分けているのと**同じ分け方**を切り出した述語。
 * この歯が測るのは述語そのもの。`runner.ts` 側がこれを使って挙動を1バイトも
 * 変えていないことは、既存の runner の歯（`manager.test.ts` /
 * `runner-infer-decision.test.ts` / `tools.test.ts` の `AskUserQuestion` 系）が
 * 引き続き緑であることで確かめる——ここでは重複しない。
 */
describe('isDaemonAnsweredTool', () => {
  it('AskUserQuestion は true（runner.ts の #onPermission と同じ分け方）', () => {
    expect(isDaemonAnsweredTool('AskUserQuestion')).toBe(true);
  });

  it('Bash は false（ふつうの道具。既定の permissionMode: auto では canUseTool を通らない）', () => {
    expect(isDaemonAnsweredTool('Bash')).toBe(false);
  });

  it('Agent は false（前景の作業者委譲も、canUseTool を通らない道具の1つ）', () => {
    expect(isDaemonAnsweredTool('Agent')).toBe(false);
  });

  it('WebFetch は false', () => {
    expect(isDaemonAnsweredTool('WebFetch')).toBe(false);
  });

  it('空文字でも投げない（false）', () => {
    expect(isDaemonAnsweredTool('')).toBe(false);
  });
});
