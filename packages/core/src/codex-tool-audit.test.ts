import { describe, expect, it } from 'vitest';

import type { CodexThreadItem } from './codex-protocol.js';
import { toCodexToolAudit } from './codex-tool-audit.js';

const image = (fields: Record<string, unknown>): CodexThreadItem =>
  ({ type: 'imageGeneration', id: 'i1', status: 'completed', ...fields }) as CodexThreadItem;

const inputOf = (item: CodexThreadItem): Record<string, unknown> => {
  const audit = toCodexToolAudit(item, (text) => text);
  if (audit?.outcome !== 'success') throw new Error(`成功ではない: ${audit?.outcome}`);
  return audit.record.toolInput as Record<string, unknown>;
};

describe('toCodexToolAudit: imageGeneration', () => {
  it('savedPath（文字列）を toolInput に載せる', () => {
    expect(
      inputOf(image({ revisedPrompt: 'p', savedPath: '/h/.codex/generated_images/a.png' })),
    ).toEqual({ revisedPrompt: 'p', savedPath: '/h/.codex/generated_images/a.png' });
  });

  it('result（画像の中身）は載せない', () => {
    const body = 'BASE64-' + 'A'.repeat(200);
    const audit = toCodexToolAudit(image({ savedPath: '/x/a.png', result: body }), (t) => t);
    expect(JSON.stringify(audit)).not.toContain('BASE64-');
  });

  it('savedPath が null・無い・文字列でないときは欄を作らない', () => {
    expect(inputOf(image({ savedPath: null }))).not.toHaveProperty('savedPath');
    expect(inputOf(image({}))).not.toHaveProperty('savedPath');
    expect(inputOf(image({ savedPath: 3 }))).not.toHaveProperty('savedPath');
  });
});
