import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

function setup() {
  const { fn } = fakeSdk(() => '了解');
  return createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
}

describe('Clone#forgetConversation（会話の削除。#4218）', () => {
  it('開いている購読に error を1通流して外し、以後その購読へは何も届かない。ほかの会話の購読は残る', () => {
    const clone = setup();
    const deleted: ChatStreamEvent[] = [];
    const kept: ChatStreamEvent[] = [];
    clone.subscribe('conv-secret', (event) => deleted.push(event));
    clone.subscribe('conv-keep', (event) => kept.push(event));

    clone.forgetConversation('conv-secret');

    expect(deleted).toEqual([{ type: 'error', message: 'この会話は削除された', kind: 'other' }]);
    expect(kept).toEqual([]);
    const attached = clone.attach('conv-secret', (event) => deleted.push(event));
    expect(attached.inProgress).toBeNull();
    attached.unsubscribe();
    expect(deleted).toHaveLength(1);
  });

  it('投げる購読があっても、残りの購読は閉じられる', () => {
    const clone = setup();
    const seen: ChatStreamEvent[] = [];
    clone.subscribe('conv-secret', () => {
      throw new Error('閉じかけ');
    });
    clone.subscribe('conv-secret', (event) => seen.push(event));

    expect(() => clone.forgetConversation('conv-secret')).not.toThrow();
    expect(seen.map((event) => event.type)).toEqual(['error']);
  });
});
