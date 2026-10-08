import { describe, expect, it } from 'vitest';

import type { CodexThreadItem } from './codex-protocol.js';
import { toCodexToolAudit } from './codex-tool-audit.js';
import { redactErrorText, redactSecretsInBody } from './redact.js';

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

describe('toCodexToolAudit: パスの欄の伏せ字（#4143）', () => {
  const env = { OPENAI_API_TOKEN: 'tok-0123456789abcdef' };
  const audit = (item: CodexThreadItem) =>
    toCodexToolAudit(
      item,
      (text) => redactErrorText(text, env),
      (text) => redactSecretsInBody(text, env),
    );
  const uuidPath =
    '/home/worker/.codex/generated_images/019a2b3c-4d5e-7f80-9a1b-2c3d4e5f6a7b/019a2b3c-4d5e-7f80-9a1b-2c3d4e5f6a7c.png';

  it('savedPath と fileChange の path は、uuid 入りでも [REDACTED] に化けない', () => {
    const image = audit({
      type: 'imageGeneration',
      id: 'i1',
      status: 'completed',
      savedPath: uuidPath,
    } as CodexThreadItem);
    expect(image?.outcome === 'success' && image.record.toolInput).toEqual({ savedPath: uuidPath });
    const change = audit({
      type: 'fileChange',
      id: 'i2',
      status: 'completed',
      changes: [{ path: uuidPath, kind: { type: 'add' }, diff: 'd' }],
    } as CodexThreadItem);
    expect(change?.outcome === 'success' && change.record.toolInput).toEqual({
      changes: [{ path: uuidPath, kind: { type: 'add' } }],
    });
  });

  it('パスの欄でも秘密（環境変数の値）は伏せる。パス以外の欄は今までどおり広く伏せる', () => {
    const result = audit({
      type: 'imageGeneration',
      id: 'i1',
      status: 'completed',
      revisedPrompt: 'id 019a2b3c-4d5e-7f80-9a1b-2c3d4e5f6a7b',
      savedPath: '/x/tok-0123456789abcdef/a.png',
    } as CodexThreadItem);
    expect(result?.outcome === 'success' && result.record.toolInput).toEqual({
      revisedPrompt: 'id [REDACTED]',
      savedPath: '/x/[REDACTED]/a.png',
    });
  });

  it('redactPath を省くと、パスの欄も redact で伏せる', () => {
    const result = toCodexToolAudit(
      {
        type: 'imageGeneration',
        id: 'i1',
        status: 'completed',
        savedPath: uuidPath,
      } as CodexThreadItem,
      (text) => redactErrorText(text, env),
    );
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });
});
