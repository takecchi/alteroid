import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { InboxEvent, Job, Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 人間の発言が届いたターンの断り書きに、その会話を起点にした返事待ち（waiting）の task を名乗る行を足す。器は task の状態を変えない。
// 人間の発言のターンだけ。該当が無いターンは1文字も増やさない。

const AT = '2026-10-29T00:00:00.000Z';
const QUEUE_HEAD = '[system] 待ち行列（';
const WAITING_MARK = '返事待ち（waiting）の task:';
const TAIL_FULL = '全文は `task_list`。並べ替えは `task_move`。';

interface Boot {
  clone: CloneHost;
  inputs: string[];
  stores: Stores;
}

function boot(stores: Stores = createMemoryStores(), env: NodeJS.ProcessEnv = {}): Boot {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: `uuid-result-${String(inputs.length)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const clone = createClone({
    stores,
    queryFn: fn,
    env,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs, stores };
}

function human(id: string, text: string, conversationId = 'conv-1'): InboxEvent {
  return { type: 'human_message', id, at: new Date().toISOString(), text, conversationId };
}

function waitingTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status: 'waiting',
    origin: 'self',
    title: `返事待ち-${id}`,
    body: `body-${id}`,
    originConversationId: 'conv-1',
    ...overrides,
  };
}

function job(id: string, status: Job['status'], taskId: string): Job {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status,
    conversationId: 'conv-1',
    summary: 's',
    taskId,
  };
}

async function turn(s: Boot, event: InboxEvent): Promise<string> {
  const before = s.inputs.length;
  s.clone.post(event);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

/** 断り書きの節（待ち行列の見出し〜次の区切り `---` の手前）。 */
function noticeLines(input: string): string[] {
  const lines = input.split('\n');
  const start = lines.findIndex((line) => line.startsWith(QUEUE_HEAD));
  expect(start, '待ち行列の見出しが入力に無い').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line === '---');
  return lines.slice(start, end < 0 ? undefined : end);
}

async function statusOf(stores: Stores, id: string): Promise<string | undefined> {
  return (await stores.tasks.get(id))?.status;
}

describe('人間の返事が来た会話の返事待ち（waiting）の task を、断り書きで名乗る', () => {
  it('⭐ 該当ありなら行が出る。状態は変えない（器は閉じない・戻さない）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(waitingTask('w1'));
    const s = boot(stores);
    const input = await turn(s, human('evt-a', '返事です'));

    const lines = noticeLines(input);
    const hit = lines.filter((line) => line.includes(WAITING_MARK));
    expect(hit).toEqual([
      '[system] この会話を起点にした返事待ち（waiting）の task: `w1` 返事待ち-w1。' +
        '返事が来たなら `task_set_status` で閉じるか queued に戻すこと（器は状態を変えない）。',
    ]);
    // 固定の末尾の前、積んだ旨の行の後に入る
    expect(lines.indexOf(hit[0]!)).toBe(lines.indexOf(TAIL_FULL) - 1);
    process.stderr.write(`[返事待ちの行 測定] ${hit[0]!}\n`);

    expect(await statusOf(stores, 'w1')).toBe('waiting');
    expect(await statusOf(stores, 'evt-a')).toBe('queued');
    await s.clone.stop();
  });

  it('件数が多ければ先頭数件と件数にする', async () => {
    const stores = createMemoryStores();
    for (let i = 1; i <= 7; i += 1) await stores.tasks.add(waitingTask(`w${String(i)}`));
    const s = boot(stores);
    const input = await turn(s, human('evt-many', '返事です'));
    const line = noticeLines(input).find((entry) => entry.includes(WAITING_MARK))!;
    expect(line).toContain('（ほか 2 件）');
    expect((line.match(/`w\d`/g) ?? []).length).toBe(5);
    await s.clone.stop();
  });

  it('⭐ 該当が無いターンは1文字も増えない（積んだ旨の行の直後が固定の末尾）', async () => {
    const stores = createMemoryStores();
    // 該当しない3種: 別の会話の waiting / 同じ会話の queued / needs_decision
    await stores.tasks.add(waitingTask('other', { originConversationId: 'conv-other' }));
    await stores.tasks.add(waitingTask('q', { status: 'queued' }));
    await stores.tasks.add(waitingTask('n', { status: 'needs_decision' }));
    const s = boot(stores);
    const input = await turn(s, human('evt-b', '返事です'));
    const lines = noticeLines(input);
    expect(input).not.toContain(WAITING_MARK);
    expect(input).not.toContain('返事待ち（waiting）');
    const tail = lines.indexOf(TAIL_FULL);
    expect(lines[tail - 1]).toContain('いま届いたこの一件は task `evt-b` として積んだ。');
    expect(lines.slice(tail)).toEqual([TAIL_FULL, '']);
    await s.clone.stop();
  });

  it('走っている委譲（running / waiting_human）が結び付いた waiting は出ない。終わった委譲なら出る', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(waitingTask('d-run'));
    await stores.tasks.add(waitingTask('d-wait'));
    await stores.tasks.add(waitingTask('d-done'));
    await stores.jobs.putJob(job('m1', 'running', 'd-run'));
    await stores.jobs.putJob(job('m2', 'waiting_human', 'd-wait'));
    await stores.jobs.putJob(job('m3', 'done', 'd-done'));
    const s = boot(stores);
    const input = await turn(s, human('evt-c', '返事です'));
    const line = noticeLines(input).find((entry) => entry.includes(WAITING_MARK))!;
    expect(line).toContain('`d-done`');
    expect(line).not.toContain('`d-run`');
    expect(line).not.toContain('`d-wait`');
    await s.clone.stop();
  });

  it('別の会話の waiting は出ない（発言の会話のものだけ）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(waitingTask('mine'));
    await stores.tasks.add(waitingTask('theirs', { originConversationId: 'conv-2' }));
    const s = boot(stores);
    const input = await turn(s, human('evt-d', '返事です', 'conv-1'));
    const line = noticeLines(input).find((entry) => entry.includes(WAITING_MARK))!;
    expect(line).toContain('`mine`');
    expect(line).not.toContain('`theirs`');
    await s.clone.stop();
  });

  it('発意 tick（self_initiative）の束でも出さない。待ち行列の先頭も出さない（A の変更）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(waitingTask('w1'));
    const s = boot(stores);
    const input = await turn(s, {
      type: 'self_initiative',
      id: 'init-1',
      at: new Date().toISOString(),
      reason: 'test',
    });
    expect(input).not.toContain(WAITING_MARK);
    expect(input).not.toContain(QUEUE_HEAD);
    expect(await statusOf(stores, 'w1')).toBe('waiting');
    await s.clone.stop();
  });

  it('tick（timer）の束では出さない。waiting の task があっても', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(waitingTask('w1'));
    const s = boot(stores);
    const input = await turn(s, {
      type: 'timer',
      id: 'tick-1',
      at: new Date().toISOString(),
      kind: 'tick',
    });
    expect(input).not.toContain(WAITING_MARK);
    expect(await statusOf(stores, 'w1')).toBe('waiting');
    await s.clone.stop();
  });

  it('固定の案内文は、同じ会話の2回目も全文のまま', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(waitingTask('w1'));
    const s = boot(stores);
    const first = await turn(s, human('evt-e1', '1回目'));
    const second = await turn(s, human('evt-e2', '2回目'));
    const lineOf = (input: string): string =>
      noticeLines(input).find((entry) => entry.includes(WAITING_MARK))!;
    for (const input of [first, second]) {
      expect(lineOf(input)).toContain(
        '返事が来たなら `task_set_status` で閉じるか queued に戻すこと',
      );
      expect(lineOf(input)).not.toContain('（返事待ちの扱いは会話の上と同じ）');
      expect(lineOf(input)).toContain('`w1`');
    }
    await s.clone.stop();
  });
});
