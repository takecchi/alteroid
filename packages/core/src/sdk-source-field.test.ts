import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);

function sdkTypesPath(): string {
  // `package.json` を resolve しない: `exports` に載っていないため
  return join(dirname(require_.resolve('@anthropic-ai/claude-agent-sdk')), 'sdk.d.ts');
}

// `sdk.d.ts` 全文を対象に文字列を探さない: 他の場所に似た一文があると、目的のフィールドの doc が消えていても通ってしまうため
function sourceFieldJsDoc(): string {
  const path = sdkTypesPath();
  const text = readFileSync(path, 'utf8');
  const declaration = "    source?: 'user' | 'sdk' | 'system'";
  const at = text.indexOf(declaration);
  if (at < 0) return '';
  const opened = text.lastIndexOf('/**', at);
  if (opened < 0) return '';
  const closed = text.indexOf('*/', opened);
  if (closed < 0 || closed > at) return '';
  return text.slice(opened, closed);
}

describe('SDK の UserPromptSubmitHookInput.source（worker_wait.sources の前提）', () => {
  it('sdk.d.ts が実在し、source の JSDoc を切り出せる（読めなかったを通さない）', () => {
    expect(existsSync(sdkTypesPath())).toBe(true);
    expect(sourceFieldJsDoc().length).toBeGreaterThan(0);
  });

  it('切り出しは source フィールドの doc だけを見ている（他所の文に当たらない）', () => {
    const doc = sourceFieldJsDoc();
    // [sdk-verbatim UserPromptSubmitHookInput.source] 「Who authored/injected the prompt」
    expect(doc).toContain('Who authored/injected the prompt');
    expect(doc).not.toContain('hook_event_name');
  });

  it('system は「機械が起こしたターン」で、task notifications と auto-continuation を畳んでいる', () => {
    // [sdk-verbatim UserPromptSubmitHookInput.source] 「`system` = other machine-injected turns (peer/channel messages, task notifications, auto-continuation)」
    expect(sourceFieldJsDoc()).toContain(
      '`system` = other machine-injected turns (peer/channel messages, task notifications, auto-continuation)',
    );
  });

  it('取れる見込みは「付かないこともある」であって「外部には付かない」ではない', () => {
    const doc = sourceFieldJsDoc();
    // [sdk-verbatim UserPromptSubmitHookInput.source] 「Payloads may omit it while the field rolls out.」
    expect(doc).toContain('Payloads may omit it while the field rolls out.');
    expect(doc).not.toContain('external payloads omit it');
  });
});
