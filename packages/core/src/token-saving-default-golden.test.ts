import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneTools, TOOL_USE_ID_META_KEY } from './tools.js';

// 既定（S1・S2 はどちらも外した。外す前は無効 = 本番の既定）で、
// モデルへ渡す入力の全文・日誌に書く行・道具の応答の全文を、スナップショットで1字ずつ縛る。
// 目的: S1・S2 を有効のときだけ通る経路ごと消すとき、既定の動きが1字も変わっていないことを、この試験が1つも更新されずに通ることで言えるようにする。
// env は一切渡さない（`setup` の env は空 = 既定）。有効にした動きは別の試験が見る。
// 時計は Date だけを固定する（実時間の待ちは使わない）。id は試験が決めた値だけを使い、毎回変わる値（時刻・経過）は固定の Date で一定にする。
// スナップショットの作り直しは意図して既定の動きを変えるときだけ。作り直したら git diff で、どの場面の何が動いたかを読むこと。

const FIXED_NOW = '2026-10-29T00:00:00.000Z';
const AT = FIXED_NOW;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXED_NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

/** モデルへ渡った入力を、場面の読み手のために番号と区切りを付けて1つの文字列にする。 */
function renderInputs(inputs: readonly string[]): string {
  return inputs.map((input, index) => `===== 入力 ${String(index + 1)} =====\n${input}`).join('\n');
}

/** 日誌のうち文面を持つ行（exchange と decision）を、id と時刻を落として古い順に並べる。 */
async function journalLines(stores: Stores): Promise<string> {
  const entries = (await stores.journal.list({ order: 'asc' })) as unknown as Record<
    string,
    unknown
  >[];
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'exchange') {
      const conversation =
        typeof entry.conversationId === 'string' ? ` ${entry.conversationId}` : '';
      lines.push(
        `exchange ${String(entry.with)}/${String(entry.role)}${conversation}: ${String(entry.text)}`,
      );
    } else if (entry.type === 'decision') {
      lines.push(`decision: ${String(entry.decision)} ／根拠: ${String(entry.grounds)}`);
    }
  }
  return lines.join('\n');
}

function summary(id: string, status: ManagerSummary['status'], live: boolean): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: AT,
    updatedAt: AT,
    waiting: [],
  };
}

/** 動いている担当が居る状況（situation の節が空でない形）を作る。 */
function pool(): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () =>
      Promise.resolve([summary('mgr-run', 'running', true), summary('mgr-idle', 'done', true)]),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: [],
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

const CONTEXT_USAGE = () => ({
  categories: [],
  totalTokens: 10_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 1,
  autoCompactThreshold: 200_000,
  isAutoCompactEnabled: true,
});

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

function inputsOf(s: Setup): string[] {
  return (s.calls[0] as FakeCall | undefined)?.inputs ?? [];
}

async function turnTimings(stores: Stores): Promise<number> {
  return (await stores.journal.list({ types: ['turn_timing'] })).length;
}

/** 発言を1つ投げ、そのターンが終わる（turn_timing が日誌に載る）まで待って、その入力を返す。 */
async function humanTurn(s: Setup, text: string): Promise<string> {
  const before = inputsOf(s).length;
  const timings = await turnTimings(s.stores);
  s.clone.post(humanMessage(text));
  await waitFor(() => inputsOf(s).length > before, `「${text}」の入力`);
  await waitFor(async () => (await turnTimings(s.stores)) > timings, `「${text}」のターンの終わり`);
  return inputsOf(s)[before] ?? '';
}

/** 同じ会話の記憶の文書を2つ置く（索引の載せ直しの対象）。 */
async function seedMemory(stores: Stores): Promise<void> {
  await stores.persona.write(
    'values',
    '---\ntype: premise\ndescription: 価値観の要旨\n---\n## VALUES-HEAD\n本文\n',
  );
  await stores.persona.write(
    'habits',
    '---\ntype: premise\ndescription: 習慣の要旨\n---\n## HABITS-HEAD\n本文\n',
  );
}

async function firePreCompact(s: Setup): Promise<void> {
  const main = s.calls[0] as FakeCall;
  const dir = await makeTempDir('alteroid-token-saving-golden-');
  const transcriptPath = join(dir, 'transcript.jsonl');
  await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
  const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
  if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
  await preCompact(
    { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
    undefined,
    {
      signal: new AbortController().signal,
    } as never,
  );
}

async function stopAll(...clones: CloneHost[]): Promise<void> {
  for (const clone of clones) await clone.stop();
}

describe('既定（S1・S2 無効）の入力の全文と日誌の行', () => {
  it('1・2・3ターン目の入力（situation の説明・digest・待ち行列の先頭）と日誌の行', async () => {
    const stores = createMemoryStores();
    const s = setup(
      undefined,
      stores,
      { getContextUsage: CONTEXT_USAGE },
      {},
      { managers: pool() },
    );
    await humanTurn(s, '1ターン目');
    await humanTurn(s, '2ターン目');
    await humanTurn(s, '3ターン目');
    expect(renderInputs(inputsOf(s))).toMatchSnapshot('入力');
    expect(await journalLines(stores)).toMatchSnapshot('日誌');
    await stopAll(s.clone);
  });

  it('人間の答え・外部の指示・マネージャーの報告が混ざった束', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { delayMs: 150, getContextUsage: CONTEXT_USAGE });
    s.clone.post(humanMessage('先客'));
    await waitFor(() => inputsOf(s).length === 1, '先客の入力');
    const events: InboxEvent[] = [
      {
        type: 'human_answer',
        id: 'evt-answer-1',
        at: AT,
        approvalId: 'appr-1',
        answer: '答え1',
      },
      {
        type: 'external',
        id: 'evt-external-1',
        at: AT,
        source: 'github',
        payload: { title: '外部の指示', body: '本文を直してほしい' },
      },
      {
        type: 'manager_message',
        id: 'evt-report-1',
        at: AT,
        managerId: 'mgr-A',
        kind: 'report',
        text: 'mgr-A の報告の本文',
      },
    ];
    for (const event of events) s.clone.post(event);
    await waitFor(() => inputsOf(s).slice(1).join('\n').includes('mgr-A の報告の本文'), '束の入力');
    await waitFor(() => inputsOf(s).length >= 2, '束のターン');
    await waitFor(
      async () => (await turnTimings(stores)) >= inputsOf(s).length,
      '束のターンの終わり',
    );
    expect(renderInputs(inputsOf(s))).toMatchSnapshot('入力');
    expect(await journalLines(stores)).toMatchSnapshot('日誌');
    await stopAll(s.clone);
  });

  it('人間の発言・外部の指示・マネージャーの報告・質問が1つの束になる回', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { delayMs: 150, getContextUsage: CONTEXT_USAGE });
    s.clone.post(humanMessage('先客'));
    await waitFor(() => inputsOf(s).length === 1, '先客の入力');
    const events: InboxEvent[] = [
      humanMessage('束の中の発言'),
      {
        type: 'external',
        id: 'evt-external-2',
        at: AT,
        source: 'github',
        payload: { title: '別の外部の指示' },
      },
      {
        type: 'manager_message',
        id: 'evt-question-1',
        at: AT,
        managerId: 'mgr-B',
        kind: 'question',
        text: 'mgr-B の質問の本文',
        requestId: 'req-1',
      },
      {
        type: 'manager_message',
        id: 'evt-report-2',
        at: AT,
        managerId: 'mgr-A',
        kind: 'report',
        text: 'mgr-A の2つ目の報告の本文',
      },
    ];
    for (const event of events) s.clone.post(event);
    await waitFor(
      () => inputsOf(s).slice(1).join('\n').includes('mgr-A の2つ目の報告の本文'),
      '束の入力',
    );
    await waitFor(
      async () => (await turnTimings(stores)) >= inputsOf(s).length,
      '束のターンの終わり',
    );
    expect(renderInputs(inputsOf(s))).toMatchSnapshot('入力');
    expect(await journalLines(stores)).toMatchSnapshot('日誌');
    await stopAll(s.clone);
  });

  it('自動要約（compact_boundary）の後の次のターンの入力と、記憶の索引の載せ直しの gauge 行', async () => {
    const stores = createMemoryStores();
    await seedMemory(stores);
    let turn = 0;
    const s = setup(undefined, stores, {
      getContextUsage: CONTEXT_USAGE,
      beforeAssistant: () => {
        turn += 1;
        return turn === 2 ? [compactBoundary] : [];
      },
    });
    await humanTurn(s, '1ターン目');
    await firePreCompact(s);
    await humanTurn(s, '2ターン目（要約が走る）');
    await humanTurn(s, '3ターン目（要約の後）');
    // gauge 行は待たれずに書かれる。実時間で刻まずに、土台の waitFor で出るまで待つ
    await waitFor(
      async () => (await journalLines(stores)).includes('[計器] 記憶の索引を'),
      '記憶の索引の載せ直しの gauge 行',
    );
    expect(renderInputs(inputsOf(s))).toMatchSnapshot('入力');
    expect(await journalLines(stores)).toMatchSnapshot('日誌');
    await stopAll(s.clone);
  });

  it('失敗したターンの後のターン', async () => {
    const stores = createMemoryStores();
    let turn = 0;
    const s = setup(undefined, stores, {
      getContextUsage: CONTEXT_USAGE,
      resultFor: () => {
        turn += 1;
        return turn === 2 ? { subtype: 'error_during_execution', isError: true } : undefined;
      },
    });
    await humanTurn(s, '1ターン目');
    await humanTurn(s, '2ターン目（失敗する）');
    await humanTurn(s, '3ターン目（失敗の後）');
    expect(renderInputs(inputsOf(s))).toMatchSnapshot('入力');
    expect(await journalLines(stores)).toMatchSnapshot('日誌');
    await stopAll(s.clone);
  });
});

// ---- output-pin の無い道具の応答 ----
// `foldFixed` の口を渡さない器（蒸留・テストと同じ）で、既定の clone が各道具へ渡す口（常に全文を返す）と同じ応答になる。

const FULL_SHA = 'd'.repeat(40);
const RUNTIME = {
  revision: { commit: FULL_SHA, short: 'd'.repeat(12), source: 'platform' },
  buildTime: { builtAt: '2026-09-18T11:45:00.000Z' },
  declaredModel: 'opus',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: 'xhigh',
  requestedEffort: null,
  claudeCodeVersion: '2.1.0',
  apiKeySource: 'oauth',
  permissionMode: 'default',
  requestedPermissionMode: 'auto',
  mcpServers: [{ name: 'alteroid', status: 'connected' }],
  sessionId: 'sess-observed',
  resumedFrom: null,
  injectedMemoryChars: { chars: 120, tokens: 60, kind: 'heuristic' },
  systemPromptChars: { chars: 4000, tokens: 2000, kind: 'heuristic' },
  lastContextUsage: null,
};

function toolHarness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
    workConversationId: () => 'conv-1',
    runtime: () => RUNTIME as never,
    accountUsage: () => ({ state: 'unknown' }),
  });
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const found = tools.find((entry) => entry.name === tool);
    if (!found) throw new Error(`${tool} が無い`);
    const result = await found.handler(args as never, {
      _meta: { [TOOL_USE_ID_META_KEY]: 'toolu-main' },
    });
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
  return { stores, call };
}

describe('既定（S1 無効）の道具の応答の全文（output-pin の無い道具）', () => {
  it('self_status（2回続けて同じ全文）', async () => {
    const h = toolHarness();
    await h.stores.persona.write(
      'idx1',
      '---\ndescription: 索引\ntype: indexed\n---\n# 題\n## 節\n本文\n',
      { ifMatch: null },
    );
    const first = await h.call('self_status');
    const second = await h.call('self_status');
    expect(second).toBe(first);
    expect(first).toMatchSnapshot();
  });

  it('usage_read（台帳が空・記録が1件）', async () => {
    const h = toolHarness();
    const empty = await h.call('usage_read');
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-opus-5': {
            inputTokens: 10,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 2,
          },
        },
      },
    });
    const first = await h.call('usage_read');
    const second = await h.call('usage_read');
    expect(second).toBe(first);
    expect({ empty, recorded: first }).toMatchSnapshot();
  });

  it('progress_read（2回続けて同じ全文）', async () => {
    const h = toolHarness();
    await h.call('task_add', { title: '約束1', body: '約束1' });
    const first = await h.call('progress_read');
    const second = await h.call('progress_read');
    expect(second).toBe(first);
    expect(first).toMatchSnapshot();
  });

  it('memory_append（2回続けて、床の遷移は数で出る）', async () => {
    const h = toolHarness();
    await h.stores.persona.write('notes', '---\ndescription: 要旨\ntype: indexed\n---\n# 題\n', {
      ifMatch: null,
    });
    const first = await h.call('memory_append', {
      slug: 'notes',
      content: '追記の本文\n',
      summary: '追記',
    });
    const second = await h.call('memory_append', {
      slug: 'notes',
      content: '2回目の追記\n',
      summary: '追記2',
    });
    expect({ first, second }).toMatchSnapshot();
  });

  // 道具名に conversation_list は無い。会話の一覧は conversation_read を conversationId 無しで呼ぶ形（clone-tools-attach.ts の `conversation_read`）
  it('conversation_read の一覧の形（conversation_list 相当。2回続けて同じ全文）', async () => {
    const h = toolHarness();
    await h.stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '人間の発言',
      conversationId: 'conv-abc12345',
    } as never);
    const first = await h.call('conversation_read');
    const second = await h.call('conversation_read');
    expect(second).toBe(first);
    expect(first).toMatchSnapshot();
  });
});
