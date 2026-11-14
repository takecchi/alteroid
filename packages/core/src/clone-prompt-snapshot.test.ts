import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { AgentContextUsage } from './agent-session.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import {
  BUILTIN_TOOLS_UNAVAILABLE_AXIS,
  ClonePromptSnapshotState,
  PROMPT_SNAPSHOT_ROWS_LIMIT,
  describeExternalMcpServers,
  describeMemoryInPrompt,
} from './clone-prompt-snapshot.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { CLONE_TOOL_NAMES } from './tools.js';

const usageOf = (overrides: Partial<AgentContextUsage> = {}): AgentContextUsage => ({
  totalTokens: 1000,
  rawMaxTokens: 200_000,
  percentage: 0.5,
  isAutoCompactEnabled: true,
  ...overrides,
});

function systemPromptOf(call: FakeCall): string {
  const systemPrompt = call.options.systemPrompt;
  if (typeof systemPrompt !== 'string')
    throw new Error('システムプロンプトが素の文字列で渡っていない');
  return systemPrompt;
}

const MEMORY_DOC = (description: string, type = 'premise'): string =>
  `---\ndescription: ${description}\ntype: ${type}\n---\n# 見出し\n本文`;

describe('クローン — 実際に焼いたプロンプトのスナップショット（メモリ上のみ）', () => {
  it('セッションを組む前は空（null）で、組んだ後は焼いた全文そのものを持つ', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', MEMORY_DOC('価値観の要旨'));
    await stores.persona.write('misc', MEMORY_DOC('作業メモの要旨', 'indexed'));
    const s = setup(undefined, stores);
    expect(s.clone.promptSnapshot()).toEqual({ session: null, contextUsage: null });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const session = s.clone.promptSnapshot().session;
    if (session === null || !session.ok) throw new Error('セッションのスナップショットが無い');
    const burned = systemPromptOf(s.calls[0] as FakeCall);
    expect(session.systemPrompt.text).toBe(burned);
    expect(session.systemPrompt.chars).toBe(burned.length);
    expect(session.resumedFrom).toBeNull();
    expect(session.model).toBe((s.calls[0] as FakeCall).options.model);
    expect(Date.parse(session.builtAt)).not.toBeNaN();
    // init が届いた時点で埋まる
    expect(session.sessionId).toBe('sess-fake');
    expect(session.memoryInPrompt.documents).toEqual([
      { slug: 'misc', type: 'indexed', description: '作業メモの要旨', chars: expect.any(Number) },
      { slug: 'values', type: 'premise', description: '価値観の要旨', chars: expect.any(Number) },
    ]);
    expect(JSON.stringify(session.memoryInPrompt)).not.toContain('本文');
    // 並びは `CLONE_TOOL_NAMES`（名前の集合）とは別に `createCloneTools` が決める。ここは集合で比べる（並びは pin が縛る）
    expect(session.tools.map((tool) => tool.name).sort()).toEqual([...CLONE_TOOL_NAMES].sort());
    for (const tool of session.tools) {
      expect(tool.descriptionChars).toBe(tool.description.length);
      expect(tool.inputSchemaChars).toBe(JSON.stringify(tool.inputSchema).length);
    }
    await s.clone.stop();
  });

  it('読み取り専用の凍結した値を返す', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const snapshot = s.clone.promptSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.session)).toBe(true);
    await s.clone.stop();
  });

  it('セッションを組み直すと、新しい版で上書きされる（1件だけ）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', MEMORY_DOC('最初の要旨'));
    const s = setup(undefined, stores, { endSessionAfterTurn: 0 });
    s.clone.post(humanMessage('1つ目'));
    await waitForDone(s.events);
    await stores.persona.write('values', MEMORY_DOC('書き換えた後の要旨'));
    s.events.length = 0;
    s.clone.post(humanMessage('2つ目'));
    await waitForDone(s.events);

    const sessions = s.calls.filter((call) => call.kind === 'session');
    expect(sessions).toHaveLength(2);
    const session = s.clone.promptSnapshot().session;
    if (session === null || !session.ok) throw new Error('セッションのスナップショットが無い');
    expect(session.systemPrompt.text).toBe(systemPromptOf(sessions[1] as FakeCall));
    expect(session.systemPrompt.text).toContain('書き換えた後の要旨');
    expect(session.systemPrompt.text).not.toContain('最初の要旨');
    expect(session.memoryInPrompt.documents[0]?.description).toBe('書き換えた後の要旨');
    await s.clone.stop();
  });

  it('蒸留のサイドクエリでは置かない（記憶が途中で書き換わっても、焼いた版が残る）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', MEMORY_DOC('焼いた時の要旨'));
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const before = s.clone.promptSnapshot().session;

    await stores.persona.write('values', MEMORY_DOC('途中で書き換わった要旨'));
    const dir = await makeTempDir('alteroid-prompt-snapshot-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '生ログ', 'utf8');
    const hook = (s.calls[0] as FakeCall).options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const side = s.calls[1] as FakeCall;
    expect(side.kind).toBe('sideQuery');
    // 蒸留は読み直した新しい記憶で組まれている（＝蒸留で置いたなら、スナップショットはこちらになる）
    expect(systemPromptOf(side)).toContain('途中で書き換わった要旨');

    const after = s.clone.promptSnapshot().session;
    expect(after).toBe(before);
    if (after === null || !after.ok) throw new Error('セッションのスナップショットが無い');
    expect(after.systemPrompt.text).toBe(systemPromptOf(s.calls[0] as FakeCall));
    expect(after.systemPrompt.text).toContain('焼いた時の要旨');
    await s.clone.stop();
  });

  it('外部 MCP の接続設定の値（url・args・env・headers）は保持されず、名前と種別だけが残る', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write({
      local: {
        command: 'node',
        args: ['--token=ARG-SENTINEL-1'],
        env: { API_KEY: 'ENV-SENTINEL-2' },
      },
      remote: {
        type: 'http',
        url: 'https://example.invalid/URL-SENTINEL-3',
        headers: { Authorization: 'Bearer HEADER-SENTINEL-4' },
      },
    });
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const session = s.clone.promptSnapshot().session;
    if (session === null || !session.ok) throw new Error('セッションのスナップショットが無い');
    expect(session.externalMcpServers).toEqual([
      { name: 'local', type: 'stdio' },
      { name: 'remote', type: 'http' },
    ]);
    const json = JSON.stringify(s.clone.promptSnapshot());
    for (const sentinel of [
      'ARG-SENTINEL-1',
      'ENV-SENTINEL-2',
      'URL-SENTINEL-3',
      'HEADER-SENTINEL-4',
      'API_KEY',
      'example.invalid',
    ]) {
      expect(json, sentinel).not.toContain(sentinel);
    }
    await s.clone.stop();
  });

  it('ターン境界の文脈占有を生のまま控え、取れなかった回は理由が残り古い値は残らない', async () => {
    let asked = 0;
    const s = setup(undefined, createMemoryStores(), {
      getContextUsage: () => {
        asked += 1;
        if (asked === 2) throw new Error('control channel が閉じている');
        return {
          ...usageOf({
            mcpTools: [{ name: 'mcp__srv__tool', serverName: 'srv', tokens: 42 }],
            systemTools: [{ name: 'Bash', tokens: 120 }],
            systemPromptSections: [{ name: 'Tone', tokens: 7 }],
            memoryFiles: [{ path: '/work/CLAUDE.md', type: 'Project', tokens: 9 }],
          }),
        };
      },
    });
    s.clone.post(humanMessage('1つ目'));
    await waitForDone(s.events);
    await waitFor(
      () => s.clone.promptSnapshot().contextUsage?.ok === true,
      '1回目の観測が控えられること',
    );

    const first = s.clone.promptSnapshot().contextUsage;
    if (first === null || !first.ok) throw new Error('観測が無い');
    expect(first.totalTokens).toBe(1000);
    expect(first.mcpTools).toEqual({
      available: true,
      value: {
        rows: [{ name: 'mcp__srv__tool', serverName: 'srv', tokens: 42, isLoaded: null }],
        omitted: 0,
      },
    });
    expect(first.systemTools).toEqual({
      available: true,
      value: { rows: [{ name: 'Bash', tokens: 120 }], omitted: 0 },
    });
    // 返さなかった欄は 0 や空にせず、取れなかった理由を持つ
    expect(first.categories.available).toBe(false);
    expect(first.deferredBuiltinTools.available).toBe(false);
    expect(first.messageBreakdown.available).toBe(false);

    s.events.length = 0;
    s.clone.post(humanMessage('2つ目'));
    await waitForDone(s.events);
    await waitFor(
      () => s.clone.promptSnapshot().contextUsage?.ok === false,
      '失敗が控えられること',
    );

    const second = s.clone.promptSnapshot().contextUsage;
    if (second === null || second.ok) throw new Error('失敗の値が置かれていない');
    expect(second.error).toContain('control channel が閉じている');
    expect(Date.parse(second.at)).not.toBeNaN();
    expect(JSON.stringify(second)).not.toContain('mcp__srv__tool');
    await s.clone.stop();
  });

  it('追加の SDK 呼び出しを足さない: getContextUsage はターンごとに1回だけ', async () => {
    let asked = 0;
    const s = setup(undefined, createMemoryStores(), {
      getContextUsage: () => {
        asked += 1;
        return usageOf();
      },
    });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await waitFor(() => s.clone.promptSnapshot().contextUsage !== null, '観測が控えられること');
    s.clone.promptSnapshot();
    s.clone.promptSnapshot();
    expect(asked).toBe(1);
    await s.clone.stop();
  });
});

describe('ClonePromptSnapshotState — 単体', () => {
  it('配列の件数の上限を超えたら、切り捨てた件数を値として持つ', () => {
    const state = new ClonePromptSnapshotState();
    const rows = Array.from({ length: PROMPT_SNAPSHOT_ROWS_LIMIT + 5 }, (_, i) => ({
      name: `t${String(i)}`,
      serverName: 's',
      tokens: 1,
    }));
    state.recordContextUsage(usageOf({ mcpTools: rows }), '2026-11-15T00:00:00.000Z');
    const usage = state.snapshot().contextUsage;
    if (usage === null || !usage.ok || !usage.mcpTools.available) throw new Error('観測が無い');
    expect(usage.mcpTools.value.rows).toHaveLength(PROMPT_SNAPSHOT_ROWS_LIMIT);
    expect(usage.mcpTools.value.omitted).toBe(5);
  });

  it('SDK が空の配列を返した欄は「0 件と測った」で、返さなかった欄は「取れない」', () => {
    const state = new ClonePromptSnapshotState();
    state.recordContextUsage(usageOf({ mcpTools: [] }), '2026-11-15T00:00:00.000Z');
    const usage = state.snapshot().contextUsage;
    if (usage === null || !usage.ok) throw new Error('観測が無い');
    expect(usage.mcpTools).toEqual({ available: true, value: { rows: [], omitted: 0 } });
    expect(usage.memoryFiles.available).toBe(false);
  });

  it('組み込みの道具の定義は「取れない」と理由を値で持つ（0 や空配列を置かない）', () => {
    const state = new ClonePromptSnapshotState();
    state.recordSession({
      builtAt: '2026-11-15T00:00:00.000Z',
      resumedFrom: 'resume-id',
      model: 'opus',
      systemPrompt: 'P',
      documents: [],
      tools: () => [],
      externalMcpServers: {},
      pluginPaths: ['/x/plugins/alpha'],
    });
    const session = state.snapshot().session;
    if (session === null || !session.ok) throw new Error('セッションが無い');
    expect(session.builtinTools).toBe(BUILTIN_TOOLS_UNAVAILABLE_AXIS);
    expect(session.builtinTools.available).toBe(false);
    expect(session.resumedFrom).toBe('resume-id');
    expect(session.plugins).toEqual([{ name: 'alpha' }]);
    expect(JSON.stringify(session)).not.toContain('/x/plugins');
  });

  it('セッションを組み直すと、前のセッションの文脈占有は残らない（失敗の値も同じ）', () => {
    const state = new ClonePromptSnapshotState();
    const input = {
      builtAt: '2026-11-15T00:00:00.000Z',
      resumedFrom: null,
      model: 'opus',
      systemPrompt: 'P',
      documents: [],
      tools: () => [],
      externalMcpServers: {},
      pluginPaths: [],
    };
    state.recordSession(input);
    state.recordContextUsage(usageOf(), '2026-11-15T00:00:01.000Z');
    expect(state.snapshot().contextUsage?.ok).toBe(true);
    state.recordSession(input);
    expect(state.snapshot().contextUsage).toBeNull();
    state.recordContextUsageFailure('失敗', '2026-11-15T00:00:02.000Z');
    state.recordSession(input);
    expect(state.snapshot().contextUsage).toBeNull();
  });

  it('道具の組み立てが投げても投げず、理由を値として置き、前の版を残さない', () => {
    const state = new ClonePromptSnapshotState();
    const input = {
      builtAt: '2026-11-15T00:00:00.000Z',
      resumedFrom: null,
      model: 'opus',
      systemPrompt: 'P',
      documents: [],
      externalMcpServers: {},
      pluginPaths: [],
    };
    state.recordSession({ ...input, tools: () => [] });
    state.recordSession({
      ...input,
      tools: () => {
        throw new Error('組めない');
      },
    });
    const session = state.snapshot().session;
    if (session === null || session.ok) throw new Error('失敗の値が置かれていない');
    expect(session.error).toContain('組めない');
  });

  it('記憶の区分と要旨は frontmatter から導く（要旨が無ければ null、区分が無ければ premise）', () => {
    const described = describeMemoryInPrompt([
      { slug: 'a', content: '本文だけ' },
      { slug: 'b', content: MEMORY_DOC('要旨', 'fact') },
    ]);
    expect(described.documents).toEqual([
      { slug: 'a', type: 'premise', description: null, chars: 4 },
      { slug: 'b', type: 'fact', description: '要旨', chars: MEMORY_DOC('要旨', 'fact').length },
    ]);
  });

  it('外部 MCP は type を省いた stdio も stdio と読み、接続設定の値は読まない', () => {
    expect(
      describeExternalMcpServers({
        a: { command: 'x', env: { K: 'v' } },
        b: { type: 'sse', url: 'https://example.invalid/' },
      }),
    ).toEqual([
      { name: 'a', type: 'stdio' },
      { name: 'b', type: 'sse' },
    ]);
  });
});

// 「組み込みの道具の定義は取れない」は SDK の型を根拠にした主張。SDK が説明・スキーマを返すようになったら、ここが落ちて見直しを促す
describe('SDK 組み込みの道具の定義が取れないという主張の根拠（@anthropic-ai/claude-agent-sdk の型定義）', () => {
  const sdkDir = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
  // 改行を揃える: 配布物は CRLF で、逐語の比較が改行の違いだけで外れる
  const dts = readFileSync(join(sdkDir, 'sdk.d.ts'), 'utf8').replaceAll('\r\n', '\n');

  function typeBlock(header: string): string {
    const start = dts.indexOf(header);
    expect(start, `${header} が sdk.d.ts に無い`).toBeGreaterThanOrEqual(0);
    const end = dts.indexOf('\n};', start);
    return dts.slice(start, end);
  }

  it('getContextUsage の組み込みの道具は name と tokens だけ', () => {
    const block = typeBlock('export declare type SDKControlGetContextUsageResponse = {');
    expect(block).toContain(
      'systemTools?: {\n        name: string;\n        tokens: number;\n    }[];',
    );
    expect(block).toContain(
      'deferredBuiltinTools?: {\n        name: string;\n        tokens: number;\n        isLoaded: boolean;\n    }[];',
    );
  });

  it('init の tools は名前の配列（string[]）', () => {
    expect(typeBlock('export declare type SDKSystemMessage = {')).toContain('tools: string[];');
  });
});
