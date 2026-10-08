import { describe, expect, it } from 'vitest';

import { isDaemonAnsweredTool } from './daemon-answered-tool.js';

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
