import { describe, expect, it } from 'vitest';

import { redactErrorText } from './denial-input-head.js';
import { excerptLine } from './excerpt.js';
import {
  COMMAND_FAILURE_HEAD_CHARS,
  TOOL_USE_FAILURE_ERROR_EXCERPT,
  toolFailureErrorText,
} from './tool-failure-error.js';

const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
// 固有の形にも「英数字混在の長い塊」の網にも当たらない（23字）: 保管庫の値として渡したときだけ伏せられる
const VAULT_VALUE = 'hunter2secretpassphrase';

describe('toolFailureErrorText: コマンドの失敗の欄（Codex の commandExecution）', () => {
  it('127 の失敗は、終了コード・コマンドの先頭・cwd・出力の先頭を1行で出す', () => {
    const text = toolFailureErrorText(
      {
        toolName: 'commandExecution',
        error: 'コマンドが失敗した（終了コード 127）',
        commandFailure: {
          command: 'rg -n foo src',
          cwd: '/tmp/mgr-1/work',
          output: '/bin/bash: line 1: rg: command not found',
        },
      },
      {},
      [],
    );
    expect(text).toBe(
      'コマンドが失敗した（終了コード 127）・コマンド=rg -n foo src・cwd=/tmp/mgr-1/work・出力=/bin/bash: line 1: rg: command not found',
    );
  });

  it('長いコマンドは上限で切り、後ろの出力の先頭が残る。全体も上限に収まる', () => {
    const text = toolFailureErrorText(
      {
        error: 'コマンドが失敗した（終了コード 127）',
        commandFailure: {
          command: 'cat <<EOF\n' + 'line\n'.repeat(400) + 'EOF',
          cwd: '/w/' + 'd/'.repeat(300),
          output: 'sh: 1: tool-x: not found\n' + 'noise '.repeat(500),
        },
      },
      {},
      [],
    );
    expect(text).toContain('出力=sh: 1: tool-x: not found');
    expect(text).not.toContain('省略');
    const command = /コマンド=(.*?)・cwd=/.exec(text)?.[1] ?? '';
    expect(command.endsWith('…')).toBe(true);
    expect(command.length).toBe(COMMAND_FAILURE_HEAD_CHARS.command + 1);
    expect(text.length).toBeLessThanOrEqual(TOOL_USE_FAILURE_ERROR_EXCERPT);
  });

  it('鍵らしい値（固有の形・env の鍵の値・保管庫の値）を伏せる。切り口にかかった保管庫の値も頭が残らない', () => {
    const text = toolFailureErrorText(
      {
        error: 'コマンドが失敗した（終了コード 127）',
        commandFailure: {
          // 保管庫の値が、コマンドの欄の切り口（120字）をまたぐ位置にある
          command: 'x'.repeat(110) + ' ' + VAULT_VALUE + ` --token ${FAKE_TOKEN}`,
          cwd: '/w',
          output: `push failed: https://u:${VAULT_VALUE}@example.test token=${FAKE_TOKEN} key=env-secret-value-0001`,
        },
      },
      { OPENAI_API_KEY: 'env-secret-value-0001' },
      [VAULT_VALUE],
    );
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('env-secret-value-0001');
    expect(text).toContain('出力=push failed:');
    expect(text).toContain('[REDACTED]');
  });

  it('出力が空なら (空) と出す', () => {
    const text = toolFailureErrorText(
      {
        error: 'コマンドが失敗した（終了コード 127）',
        commandFailure: { command: 'x', output: '  \n' },
      },
      {},
      [],
    );
    expect(text).toBe('コマンドが失敗した（終了コード 127）・コマンド=x・出力=(空)');
  });
});

describe('toolFailureErrorText: 欄を持たない記録（Claude の Bash など）は今までどおり', () => {
  it('error を伏せて 500 字で切ったものと1文字も変わらない', () => {
    const error = `Exit code 1\nfatal: ${FAKE_TOKEN}\n` + 'y'.repeat(800);
    expect(toolFailureErrorText({ toolName: 'Bash', error }, {}, [])).toBe(
      excerptLine(redactErrorText(error, {}, []), TOOL_USE_FAILURE_ERROR_EXCERPT),
    );
  });

  it('error が文字列でなければ (不明)', () => {
    expect(toolFailureErrorText({ toolName: 'Bash' }, {}, [])).toBe('(不明)');
  });
});
