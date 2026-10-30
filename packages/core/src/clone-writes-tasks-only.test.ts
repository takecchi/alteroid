import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import {
  fakeScriptedSdk,
  fakeSdk,
  waitFor,
  waitForTerminal,
  wireEvents,
} from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { renderMemoryDocuments } from './memory.js';
import type { InboxEvent } from './schema.js';
import { buildCloneSystemPrompt } from './prompt.js';
import { createMemoryStores } from './testing.js';

// #5923（台帳の撤去の段2a）: クローンは台帳（CommitmentStore）へ書かない。人間の発言は同じ id の Task だけを開き、回答は何も開かない。

const say = (text: string): ScriptedStep[] => [
  { delta: text },
  { assistant: [{ type: 'text', text }] },
];

function boot(script: () => ScriptedStep[] = () => say('受けた')) {
  const stores = createMemoryStores();
  const { fn } = fakeScriptedSdk(() => script());
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, events };
}

function human(id: string, text: string): InboxEvent {
  return {
    type: 'human_message',
    id,
    at: new Date().toISOString(),
    text,
    conversationId: 'conv-1',
  };
}

describe('クローンは台帳へ書かない', () => {
  it('人間の発言は同じ id の Task だけを開き、台帳の行は開かない', async () => {
    const s = boot();
    s.clone.post(human('evt-a', '調べてほしい'));
    await waitFor(async () => (await s.stores.tasks.get('evt-a')) !== null, 'Task が積まれる');
    await waitForTerminal(s.events);

    expect((await s.stores.tasks.get('evt-a'))?.origin).toBe('human');
    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toEqual([]);
    expect(await s.stores.commitments.get('evt-a')).toBeNull();
    await s.clone.stop();
  });

  it('日誌に「台帳に開いた」という記録を残さない', async () => {
    const s = boot();
    s.clone.post(human('evt-b', '調べてほしい'));
    await waitFor(async () => (await s.stores.tasks.get('evt-b')) !== null, 'Task');
    await waitForTerminal(s.events);

    const rows = await s.stores.journal.list({});
    expect(JSON.stringify(rows)).not.toContain('台帳に開いた');
    await s.clone.stop();
  });

  it('回答（human_answer）は台帳にも Task にも何も開かない', async () => {
    const s = boot(() => say('承認の回答を受けた'));
    s.clone.post({
      type: 'human_answer',
      id: 'ans-1',
      at: new Date().toISOString(),
      approvalId: 'appr-1',
      answer: '進めてよい',
      conversationId: 'conv-1',
    });
    await waitForTerminal(s.events);

    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toEqual([]);
    expect((await s.stores.tasks.list({ includeClosed: true })).entries).toEqual([]);
    await s.clone.stop();
  });
});

describe('台帳の書き込みの道具を案内する文が残っていない', () => {
  const removed = /commitment_(open|close_many|close|reopen|edit)\b/;
  const root = fileURLToPath(new URL('.', import.meta.url));

  it('システムプロンプトに、消した道具の名前も「台帳へ載る」の文も無い', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });
    expect(prompt).not.toMatch(removed);
    expect(prompt).not.toContain('自動的に台帳へ載る');
    expect(prompt).not.toContain('台帳に載せること');
    expect(prompt).toContain('task_set_status_many');
  });

  it.each(['prompt.ts', 'digest.ts', 'superseded.ts', 'clone.ts', 'tools.ts', 'manager.ts'])(
    '%s に、消した道具の名前が残っていない',
    (file) => {
      const source = readFileSync(`${root}${file}`, 'utf8');
      const hits = source.split('\n').filter((line) => removed.test(line));
      expect(hits, `${file} に消した道具の名前が在る`).toEqual([]);
    },
  );
});
