import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneTools } from './tools.js';

interface FakeCall {
  options: Options;
  inputs: string[];
}

function fakeSdk(): { fn: typeof sdkQuery; calls: FakeCall[] } {
  const calls: FakeCall[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = { options: params.options ?? {}, inputs: [] };
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        call.inputs.push(prompt);
        yield* turn(prompt);
        return;
      }

      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const text = String(message.message.content);
        call.inputs.push(text);
        yield* turn(text);
      }
    }

    function* turn(inputText: string): Generator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'わかった' }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'わかった',
        session_id: 'sess-fake',
        uuid: 'uuid-result',
      } as unknown as SDKMessage;
      void inputText;
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

interface Setup {
  clone: CloneHost;
  stores: Stores;
  calls: FakeCall[];
  events: ChatStreamEvent[];
}

function setup(stores: Stores = createMemoryStores()): Setup {
  const { fn, calls } = fakeSdk();
  const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });
  const events: ChatStreamEvent[] = [];
  clone.subscribe('conv-1', (event) => events.push(event));
  return { clone, stores, calls, events };
}

function waitForDone(events: ChatStreamEvent[]): Promise<void> {
  return waitFor(() => events.some((event) => event.type === 'done'), 'done が来る');
}

const ABOUT_ME_BODY = Array.from(
  { length: 40 },
  (_, i) => `about-me文書の本文${i}行目: 変わらないはずの長い自己紹介の一節である。`,
).join('\n');
const NOTES_BODY_OLD = '## notes見出し（旧）\nnotes文書の本文（旧）: 短いメモである。';
const NOTES_BODY_NEW = '## notes見出し（新）\nnotes文書の本文（新）: 短いメモを書き換えた。';

describe('クローンの記憶注入（差分のみを載せるべき、という固定したい振る舞い）', () => {
  it('変わっていない文書の本文は、注入に含まれてはならない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('about-me', ABOUT_ME_BODY);
    await stores.persona.write('notes', NOTES_BODY_OLD);

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('notes', NOTES_BODY_NEW);

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const secondInjectedInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    expect(secondInjectedInput).not.toContain(ABOUT_ME_BODY);

    await s.clone.stop();
  });

  it('歯1（足場健全性チェック）: 変わった文書の本文は、注入に含まれる（現状の実装でも通る）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('about-me', ABOUT_ME_BODY);
    await stores.persona.write('notes', NOTES_BODY_OLD);

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('notes', NOTES_BODY_NEW);

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const secondInjectedInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    expect(secondInjectedInput).toContain('## notes見出し（新）');
    expect(secondInjectedInput).not.toContain('短いメモを書き換えた。');

    await s.clone.stop();
  });

  it('歯2（空振り防止）: 偽 query は実際に呼ばれ、入力テキストを1件以上捕まえている', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('about-me', ABOUT_ME_BODY);
    await stores.persona.write('notes', NOTES_BODY_OLD);

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('notes', NOTES_BODY_NEW);

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const capturedInputs = (s.calls[0] as FakeCall).inputs;
    expect(capturedInputs.length).toBeGreaterThanOrEqual(2);

    await s.clone.stop();
  });
});

// 期待値を renderMemoryDocuments(...) の呼び直しで組み立てない: 実装と同じ式を2度書くだけになり、書く側と読む側が食い違っても検出できないため
describe('通しの歯 — memory_write の見込み文字数と、次のターンに実際に載る塊の文字数が一致する', () => {
  it('⭐ 親が今回の書き込みに含まれない fact を書いたとき、見込みと実物が一致する（直す前は32文字少なかった）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('core', '# core\n\n前提の本文\n');

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const emitted: ChatStreamEvent[] = [];
    const tools = createCloneTools({
      stores,
      emit: (event) => emitted.push(event),
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const memoryWrite = tools.find((entry) => entry.name === 'memory_write');
    if (memoryWrite === undefined) throw new Error('memory_write が無い（足場の欠陥）');
    const result = await memoryWrite.handler(
      {
        slug: 'child',
        content: '---\ntype: fact\ndescription: 子の要旨\nparent: core\n---\n# child\n\n子の本文\n',
        summary: '子を書いた',
      } as never,
      {},
    );
    const reply = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    // カンマを剥がして戻す: formatMemoryCharCount が toLocaleString('en-US') で桁区切りを入れうるため
    const match = reply.match(/次のターンの会話へ載る見込み: ([\d,]+) 文字/);
    const matchedDigits = match?.[1];
    expect(matchedDigits).toBeDefined();
    const estimatedChars = Number((matchedDigits ?? '').replaceAll(',', ''));

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    const secondTurnInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    expect(secondTurnInput).not.toContain('前提の本文');
    expect(secondTurnInput).not.toContain('<!-- memory: core.md -->');
    expect(secondTurnInput).toContain('親 core は在るが、ここに載せた分には含まれない');

    expect(secondTurnInput).not.toContain('前のセッションを引き継いで');

    const marker = '<!-- memory: index -->';
    const markerIndex = secondTurnInput.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const boundary = '\n\n---\n\n';
    const boundaryIndex = secondTurnInput.indexOf(boundary, markerIndex);
    expect(boundaryIndex).toBeGreaterThan(markerIndex);
    const actualInjectedChars = secondTurnInput.slice(markerIndex, boundaryIndex).length;

    expect(actualInjectedChars).toBe(estimatedChars);

    const markerOccurrences = secondTurnInput.split(marker).length - 1;
    expect(markerOccurrences).toBe(1);

    const chunk = secondTurnInput.slice(markerIndex, boundaryIndex);

    expect(chunk.startsWith(marker)).toBe(true);

    expect(chunk).toContain('## 記憶の目次');
    expect(chunk).toContain('child');
    expect(chunk).toContain('子の要旨');
    expect(chunk).toContain('親 core は在るが、ここに載せた分には含まれない');
    expect(actualInjectedChars).toBeGreaterThan(marker.length + 20);

    expect(chunk).not.toContain('[system] 記憶が更新された');
    expect(chunk).not.toContain('前提の本文');
    expect(chunk).not.toContain('<!-- memory: core.md -->');
    expect(chunk).not.toContain('2回目');

    // boundary が全体で1回だけという不変条件は立てない: commitment の断り自身が同じ区切りを内部に持つため。末尾が人間の発話で終わることで確認する
    const afterBoundary = secondTurnInput.slice(boundaryIndex + boundary.length);
    expect(afterBoundary.endsWith('2回目')).toBe(true);
    expect(afterBoundary).not.toContain(marker);

    await s.clone.stop();
  });
});

describe('通しの歯 — 既に見ている premise への追記は、追記した分だけが載る', () => {
  it('⭐ 元の本文は載らず、追記した行と「省いた側」の断りだけが載る。見込みとも一致する', async () => {
    const stores = createMemoryStores();
    const originalBody = Array.from(
      { length: 60 },
      (_, i) => `## 既存の節${i}\n${`ここは本文である。`.repeat(20)}`,
    ).join('\n');
    await stores.persona.write(
      'alteroid-work',
      `---\ntype: premise\ndescription: 既存の要旨\n---\n${originalBody}\n`,
    );

    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const memoryAppend = tools.find((entry) => entry.name === 'memory_append');
    if (memoryAppend === undefined) throw new Error('memory_append が無い（足場の欠陥）');
    const result = await memoryAppend.handler(
      {
        slug: 'alteroid-work',
        content: '## 追記した節\n追記した本文である。',
        summary: '追記',
      } as never,
      {},
    );
    const reply = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    const match = reply.match(/次のターンの会話へ載る見込み: ([\d,]+) 文字/);
    const matchedDigits = match?.[1];
    expect(matchedDigits).toBeDefined();
    const estimatedChars = Number((matchedDigits ?? '').replaceAll(',', ''));
    expect(reply).toContain('alteroid-work（premise・カードの変わった範囲だけ）');

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    const secondTurnInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    expect(secondTurnInput).not.toContain('## 既存の節30');
    expect(secondTurnInput).not.toContain('ここは本文である。');
    expect(secondTurnInput).not.toContain('追記した本文である。');
    expect(secondTurnInput).toContain('## 追記した節');
    expect(secondTurnInput).toContain('行は変わっていないので載せていない');

    const marker = '<!-- memory: alteroid-work.md（カードの変わった範囲だけ） -->';
    const markerIndex = secondTurnInput.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(secondTurnInput.split(marker).length - 1).toBe(1);
    const boundary = '\n\n---\n\n';
    const boundaryIndex = secondTurnInput.indexOf(boundary, markerIndex);
    expect(boundaryIndex).toBeGreaterThan(markerIndex);
    const chunk = secondTurnInput.slice(markerIndex, boundaryIndex);

    expect(chunk.length).toBe(estimatedChars);

    expect(chunk.startsWith(marker)).toBe(true);
    expect(chunk.length).toBeGreaterThan(marker.length + 20);
    expect(chunk).not.toContain('[system] 記憶が更新された');
    expect(chunk).not.toContain('2回目');

    const fullDocument = (await stores.persona.read('alteroid-work'))?.content ?? '';
    expect(fullDocument.length).toBeGreaterThan(1_000);
    expect(chunk.length).toBeLessThan(fullDocument.length / 10);
  });

  it('⭐ 断り書きは「システムプロンプトはセッション構築時点の全文」だと言う（現在の内容だとは言わない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('doc', '# doc\n\n本文\n');
    const s = setup(stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('doc', '# doc\n\n本文\n足した行\n');

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    const secondTurnInput = (s.calls[0] as FakeCall).inputs[1] ?? '';

    expect(secondTurnInput).toContain('このセッションを組んだ時点の索引');
    expect(secondTurnInput).not.toContain('システムプロンプトに載っているものが現在の内容である');
    expect(secondTurnInput).toContain('`memory_section_read` で開くこと');
  });
});
