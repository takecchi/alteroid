import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, fakeScriptedSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';

const SECRET_RAW = '{"content": "記憶の本文 sk-secret-0123456789 が入った壊れた JSON';

async function run(steps: ScriptedStep[]) {
  const stores = createMemoryStores();
  const { fn } = fakeScriptedSdk(() => steps);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  clone.post(humanMessage('やって'));
  await waitForTerminal(events);
  await clone.stop();
  return stores.journal.list({ types: ['tool_use'], order: 'asc' });
}

describe('入力が JSON として読めず本体が断った tool_use を日誌へ残す（#5313）', () => {
  it('tool_use / failed を1行残し、error・input のどこにも raw を含めない', async () => {
    const rows = await run([
      {
        assistant: [
          {
            type: 'tool_use',
            name: 'Write',
            id: 'tu-1',
            input: { __unparsedToolInput: { raw: SECRET_RAW, len: 4321 } },
          },
        ],
      },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'tool_use',
      actor: 'clone',
      tool: 'Write',
      outcome: 'failed',
    });
    expect((rows[0] as { error?: string }).error).toContain('4321');
    expect('input' in rows[0]!).toBe(false);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('記憶の本文');
  });

  it('普通の入力の tool_use では何も書かない', async () => {
    const rows = await run([
      { assistant: [{ type: 'tool_use', name: 'Read', id: 'tu-1', input: { file_path: '/a' } }] },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);
    expect(rows).toEqual([]);
  });

  it('形が近いだけの入力（キーが2つ・raw が数値・len が文字列）では書かない', async () => {
    const rows = await run([
      {
        assistant: [
          {
            type: 'tool_use',
            name: 'Write',
            id: 'tu-1',
            input: { __unparsedToolInput: { raw: 'x', len: 1 }, other: 1 },
          },
          {
            type: 'tool_use',
            name: 'Write',
            id: 'tu-2',
            input: { __unparsedToolInput: { raw: 123, len: 3 } },
          },
          {
            type: 'tool_use',
            name: 'Write',
            id: 'tu-3',
            input: { __unparsedToolInput: { raw: 'x', len: '1' } },
          },
        ],
      },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);
    expect(rows).toEqual([]);
  });

  it('同じ id が再び届いても二重に書かない', async () => {
    const block = {
      type: 'tool_use' as const,
      name: 'Write',
      id: 'tu-same',
      input: { __unparsedToolInput: { raw: SECRET_RAW, len: 99 } },
    };
    const rows = await run([
      { assistant: [block] },
      { toolResult: true },
      { assistant: [block] },
      { toolResult: true },
      { assistant: [{ type: 'text', text: '了解' }] },
    ]);
    expect(rows).toHaveLength(1);
  });
});
