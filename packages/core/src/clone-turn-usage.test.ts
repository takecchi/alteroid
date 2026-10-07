import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLONE_ACTOR_ID } from './usage.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForDone, isTerminal, waitForTerminal } from './clone-test-harness.js';

describe('クローン — ターン1回ぶんの増分を turn_usage として日誌に残す', () => {
  function usageOf(
    model: string,
    fields: {
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUsd?: number;
    },
  ) {
    return {
      [model]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: fields.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: fields.cacheCreationInputTokens ?? 0,
        webSearchRequests: 0,
        costUSD: fields.costUsd ?? 0,
      },
    };
  }

  it('cacheReadInputTokens / cacheCreationInputTokens / costUsd が潰されずに日誌へ入る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () =>
        usageOf('claude-fable-5', {
          costUsd: 0.5,
          cacheReadInputTokens: 120,
          cacheCreationInputTokens: 40,
        }),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
    expect(entry.layer).toBe('clone');
    expect(entry.site).toBe('session');
    expect(entry.managerId).toBe(CLONE_ACTOR_ID);
    expect(entry.models['claude-fable-5']).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 120,
      cacheCreationInputTokens: 40,
      webSearchRequests: 0,
      costUsd: 0.5,
    });
    expect(entry.reset).toBeUndefined();

    await s.clone.stop();
  });

  it('増分が空の回（同じ累積が2ターン続く）は turn_usage の行を書かない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      'done イベントが2件届く',
    );

    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(1);

    await s.clone.stop();
  });

  it('累積が数え直された回は turn_usage に reset が付く（models は差分ではなく新しい累積の先頭）', async () => {
    let turnCount = 0;
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => {
        turnCount += 1;
        return turnCount === 1
          ? usageOf('claude-fable-5', { costUsd: 5 })
          : usageOf('claude-fable-5', { costUsd: 3 });
      },
    });

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      'done イベントが2件届く',
    );

    const all = await s.stores.journal.list({ limit: 50 });
    const note = all.find(
      (entry) => entry.type === 'exchange' && entry.text.includes('数え直された'),
    );
    expect(note).toBeDefined();

    const turnUsageEntries = all.filter((entry) => entry.type === 'turn_usage');
    expect(turnUsageEntries).toHaveLength(2);
    const resetEntry = turnUsageEntries.find(
      (entry) => entry.type === 'turn_usage' && entry.reset !== undefined,
    );
    if (resetEntry?.type !== 'turn_usage') throw new Error('reset 付きの turn_usage が無い');
    expect(resetEntry.reset).toEqual({ fromCostUsd: 5, toCostUsd: 3 });
    expect(resetEntry.models['claude-fable-5']?.costUsd).toBe(3);

    await s.clone.stop();
  });

  it('台帳へ積めなければ turn_usage も書かれない（黙って消さないが、殺しもしない）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      await s.clone.stop();
    });

    expect(stderr.join('')).toContain('利用状況の台帳');
    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(0);
  });

  it('失敗したターン（isSuccessResult が偽）は turn_usage の行を書かず、消費は次の成功したターンへ合算される', async () => {
    let modelUsageCalls = 0;
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex === 0 ? { subtype: 'error_during_execution' } : undefined,
      modelUsage: () => {
        modelUsageCalls += 1;
        return modelUsageCalls === 1
          ? usageOf('claude-fable-5', { costUsd: 2 })
          : usageOf('claude-fable-5', { costUsd: 5 });
      },
    });

    s.clone.post(humanMessage('1回目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const afterFirst = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(afterFirst).toHaveLength(0);

    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 1,
      'done イベントが1件届く',
    );

    const afterSecond = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(afterSecond).toHaveLength(1);
    const entry = afterSecond[0];
    if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
    expect(entry.models['claude-fable-5']?.costUsd).toBe(5);

    await s.clone.stop();
  });

  it('台帳へ積めなければ、日誌に exchange with=self が1件残る（非対称の解消）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
    const dropped = exchanges.find(
      (entry) => entry.with === 'self' && entry.text.includes('消費を台帳へ記録できなかった'),
    );
    expect(dropped).toBeDefined();
    expect(dropped?.text).toContain('消費を台帳へ記録できなかった（この分は集計に出ない）');
    expect(dropped?.text).toContain('site=session');

    await s.clone.stop();
  });

  it('台帳の記録も日誌への追記も両方失敗しても、throw が外へ出ずターンが畳まれる', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));
    stores.journal.append = () => Promise.reject(new Error('日誌も書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
    });

    expect(stderr.join('')).toContain('利用状況の台帳');
    expect(stderr.join('')).toContain('日誌を記録できませんでした');

    await s.clone.stop();
  });

  describe('ターンの境界で聞いた文脈占有・compaction・result.usage', () => {
    it('`getContextUsage()` が成功すれば `contextUsage` に値が入り、`error` は付かない', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
          autoCompactThreshold: 160_000,
          isAutoCompactEnabled: true,
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.contextUsage).toEqual({
        durationMs: expect.any(Number),
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
        autoCompactThreshold: 160_000,
        isAutoCompactEnabled: true,
      });
      expect(entry.contextUsage?.error).toBeUndefined();

      await s.clone.stop();
    });

    it('⭐⭐⭐ 配列の内訳は合計へ畳んで載る（道具ごとに1行ずつ写さない）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
          isAutoCompactEnabled: true,
          categories: [
            { name: 'System prompt', tokens: 8_000, kind: 'used' },
            { name: 'MCP tools', tokens: 3_000, kind: 'deferred' },
          ],
          mcpTools: [
            { name: 'memory_read', serverName: 'alteroid', tokens: 100 },
            { name: 'manager_list', serverName: 'alteroid', tokens: 400 },
            { name: 'runner_list', serverName: 'alteroid', tokens: 500 },
          ],
          memoryFiles: [{ path: '/x/CLAUDE.md', type: 'project', tokens: 700 }],
          systemPromptSections: [
            { name: 'core', tokens: 5_000 },
            { name: 'memory', tokens: 3_000 },
          ],
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');

      expect(entry.contextUsage?.mcpToolTokens).toBe(1_000);
      expect(entry.contextUsage?.mcpToolCount).toBe(3);
      expect(entry.contextUsage?.memoryFileTokens).toBe(700);
      expect(entry.contextUsage?.memoryFileCount).toBe(1);
      expect(entry.contextUsage?.systemPromptTokens).toBe(8_000);
      expect(entry.contextUsage?.systemPromptSectionCount).toBe(2);
      expect(entry.contextUsage?.categories).toEqual([
        { name: 'System prompt', tokens: 8_000, kind: 'used' },
        { name: 'MCP tools', tokens: 3_000, kind: 'deferred' },
      ]);
      expect(entry.contextUsage?.categoriesOmitted).toBeUndefined();
      expect(JSON.stringify(entry.contextUsage)).not.toContain('manager_list');

      await s.clone.stop();
    });

    it('⭐⭐ kind を返さない SDK でも、categories の欄は壊れず kind だけが無い', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
          categories: [{ name: 'System prompt', tokens: 8_000 }],
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');

      expect(entry.contextUsage?.categories).toEqual([{ name: 'System prompt', tokens: 8_000 }]);
      expect(entry.contextUsage?.categories?.[0]?.kind).toBeUndefined();

      await s.clone.stop();
    });

    it('⭐⭐⭐ SDK が内訳を返さない回は、欄そのものを作らない（0 を置かない）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
          isAutoCompactEnabled: true,
          categories: [],
          mcpTools: [],
          memoryFiles: [],
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');

      expect(entry.contextUsage).toEqual({
        durationMs: expect.any(Number),
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
        isAutoCompactEnabled: true,
      });

      await s.clone.stop();
    });

    it('⭐⭐ categories が上限を超えたら切り、省いた件数を名乗る', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
          isAutoCompactEnabled: true,
          categories: Array.from({ length: 100 }, (_, i) => ({ name: `軸${i}`, tokens: i })),
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');

      const shown = entry.contextUsage?.categories?.length ?? 0;
      const omitted = entry.contextUsage?.categoriesOmitted ?? 0;
      expect(omitted).toBeGreaterThan(0);
      expect(shown + omitted).toBe(100);
      expect(entry.contextUsage?.categories?.[0]).toEqual({ name: '軸0', tokens: 0 });

      await s.clone.stop();
    });

    it('`getContextUsage()` が失敗しても、ターンは止まらず `contextUsage.error` に理由が入る（秘密は伏せる）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => {
          throw new Error(`失敗: token=${process.env.ALTEROID_TEST_SECRET_TOKEN}`);
        },
      });
      const previous = process.env.ALTEROID_TEST_SECRET_TOKEN;
      process.env.ALTEROID_TEST_SECRET_TOKEN = 'sekret-value-12345';

      try {
        s.clone.post(humanMessage('やあ'));
        await waitForDone(s.events);
      } finally {
        if (previous === undefined) delete process.env.ALTEROID_TEST_SECRET_TOKEN;
        else process.env.ALTEROID_TEST_SECRET_TOKEN = previous;
      }

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.contextUsage?.error).toBeDefined();
      expect(entry.contextUsage?.error).toContain('[REDACTED]');
      expect(entry.contextUsage?.error).not.toContain('sekret-value-12345');
      expect(entry.contextUsage?.totalTokens).toBeUndefined();
      expect(s.events.some((event) => event.type === 'done')).toBe(true);

      await s.clone.stop();
    });

    it('`getContextUsage` を実装していない `Query`（実機で未対応のときと同じ形）でも、例外を `error` として拾いターンは止めない', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.contextUsage?.error).toBeDefined();
      expect(typeof entry.contextUsage?.durationMs).toBe('number');

      await s.clone.stop();
    });

    it('ターンの途中に届いた compact_boundary は `compactions` としてまとめて載る', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        beforeAssistant: () => [
          {
            type: 'system',
            subtype: 'compact_boundary',
            session_id: 'sess-fake',
            uuid: 'uuid-compact-1',
            compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 42_000 },
          } as unknown as SDKMessage,
        ],
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.compactions).toEqual([
        { trigger: 'auto', preTokens: 180_000, postTokens: 42_000 },
      ]);

      await s.clone.stop();
    });

    it('compaction が起きなかったターンは `compactions` の欄自体が無い（空配列を作らない）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.compactions).toBeUndefined();

      await s.clone.stop();
    });

    it('`result.usage` は `mainLoopUsage` として `turn_usage` へ載る（`models` とは別の値のまま潰さない）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        resultUsage: () => ({
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 40,
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.mainLoopUsage).toEqual({
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 40,
      });

      await s.clone.stop();
    });

    it('`result.usage` を渡さない回は `mainLoopUsage` の欄自体が無い（作り物を出さない）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const entries = await s.stores.journal.list({ types: ['turn_usage'] });
      const entry = entries[0];
      if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
      expect(entry.mainLoopUsage).toBeUndefined();

      await s.clone.stop();
    });

    it('失敗したターンでも contextUsage は context_usage として日誌に残る（#982 の直った後の挙動）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        resultSubtype: 'error_during_execution',
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForTerminal(s.events);
      expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

      expect(await s.stores.journal.list({ types: ['turn_usage'] })).toEqual([]);

      const contextRows = await s.stores.journal.list({ types: ['context_usage'] });
      expect(contextRows).toHaveLength(1);
      const contextRow = contextRows[0];
      if (contextRow?.type !== 'context_usage') throw new Error('context_usage が日誌に無い');
      expect(contextRow.layer).toBe('clone');
      expect(contextRow.site).toBe('session');
      expect(contextRow.managerId).toBe(CLONE_ACTOR_ID);
      expect(contextRow.turnSucceeded).toBe(false);
      expect(contextRow.contextUsage).toEqual({
        durationMs: expect.any(Number),
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
      });

      await s.clone.stop();
    });

    it('成功したターンでも contextUsage は context_usage として日誌に残る（#982 の直った後の挙動。レビューで見つかった見落としの回帰）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
        }),
      });

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const turnUsageRows = await s.stores.journal.list({ types: ['turn_usage'] });
      expect(turnUsageRows.length).toBeGreaterThan(0);

      const contextRows = await s.stores.journal.list({ types: ['context_usage'] });
      expect(contextRows).toHaveLength(1);
      const contextRow = contextRows[0];
      if (contextRow?.type !== 'context_usage') throw new Error('context_usage が日誌に無い');
      expect(contextRow.layer).toBe('clone');
      expect(contextRow.site).toBe('session');
      expect(contextRow.managerId).toBe(CLONE_ACTOR_ID);
      expect(contextRow.turnSucceeded).toBe(true);
      expect(contextRow.contextUsage).toEqual({
        durationMs: expect.any(Number),
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
      });

      await s.clone.stop();
    });
  });
});
