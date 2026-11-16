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

describe('toCodexToolAudit: commandExecution の失敗は、コマンド・cwd・出力を伏せて運ぶ', () => {
  const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const env = { OPENAI_API_TOKEN: 'tok-0123456789abcdef' };
  const redact = (text: string) => redactErrorText(text, env);
  const command = (fields: Record<string, unknown>): CodexThreadItem =>
    ({
      type: 'commandExecution',
      id: 'c1',
      command: 'rg -n foo',
      cwd: '/tmp/mgr-1/work',
      commandActions: [],
      ...fields,
    }) as CodexThreadItem;
  const failureOf = (item: CodexThreadItem) => {
    const audit = toCodexToolAudit(item, redact);
    if (audit?.outcome !== 'failure') throw new Error(`失敗ではない: ${audit?.outcome}`);
    return audit.record;
  };

  it('127 で落ちたら、終了コードの error に、コマンド・cwd・出力の欄が付く', () => {
    const record = failureOf(
      command({
        status: 'failed',
        exitCode: 127,
        aggregatedOutput: '/bin/bash: line 1: rg: command not found\n',
      }),
    );
    expect(record.error).toBe('コマンドが失敗した（終了コード 127）');
    expect(record.commandFailure).toEqual({
      command: 'rg -n foo',
      cwd: '/tmp/mgr-1/work',
      output: '/bin/bash: line 1: rg: command not found',
    });
  });

  it('status が completed でも終了コードが非0なら、同じ欄が付く', () => {
    const record = failureOf(command({ status: 'completed', exitCode: 2, aggregatedOutput: 'x' }));
    expect(record.commandFailure).toEqual({
      command: 'rg -n foo',
      cwd: '/tmp/mgr-1/work',
      output: 'x',
    });
  });

  it('aggregatedOutput が null・無いときは output の欄を作らない', () => {
    expect(
      failureOf(command({ status: 'failed', exitCode: 127, aggregatedOutput: null }))
        .commandFailure,
    ).not.toHaveProperty('output');
    expect(
      failureOf(command({ status: 'failed', exitCode: 127 })).commandFailure,
    ).not.toHaveProperty('output');
  });

  it('コマンドと出力の中の鍵らしい値（固有の形・env の鍵の値）を伏せる', () => {
    const record = failureOf(
      command({
        command: `curl -H "Authorization: token ${FAKE_TOKEN}" https://x.test --key tok-0123456789abcdef`,
        status: 'failed',
        exitCode: 127,
        aggregatedOutput: `curl: not found (token=${FAKE_TOKEN}, tok-0123456789abcdef)`,
      }),
    );
    const carried = JSON.stringify(record);
    expect(carried).not.toContain(FAKE_TOKEN);
    expect(carried).not.toContain('tok-0123456789abcdef');
    expect(record.commandFailure?.command).toContain('curl -H');
    expect(record.commandFailure?.output).toContain('curl: not found');
    expect(record.commandFailure?.output).toContain('[REDACTED]');
  });

  it('巨大な出力は上限で切って運ぶ。切り口にかかった鍵も、切る前に伏せるので頭が残らない', () => {
    const record = failureOf(
      command({
        status: 'failed',
        exitCode: 1,
        aggregatedOutput: 'a'.repeat(3990) + ' ' + FAKE_TOKEN,
      }),
    );
    const output = record.commandFailure?.output ?? '';
    expect(output.length).toBeLessThanOrEqual(4001);
    expect(output).not.toContain('ghp_');
  });

  it('成功では出力を運ばない', () => {
    const audit = toCodexToolAudit(
      command({ status: 'completed', exitCode: 0, aggregatedOutput: 'SECRET-OUTPUT' }),
      redact,
    );
    expect(audit?.outcome).toBe('success');
    expect(JSON.stringify(audit)).not.toContain('SECRET-OUTPUT');
  });
});
