import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLONE_ACTOR_ID } from './usage.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForDone, isTerminal, waitForTerminal } from './clone-test-harness.js';

describe('クローン — ターン1回ぶんの増分を turn_usage として日誌に残す', () => {
  /** `costUsd` に加え cache read/write も動かせる `modelUsage` の素材。 */
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
        // SDK 側の綴りは大文字（`costUSD`）。
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
    // **合計に潰していないこと** — read と write が別々に残っている。
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
    // 同一セッション内の2ターン目。`modelUsage` は同じ値を返し続けるので、
    // 2回目の累積は1回目と変わらない ＝ 増分ゼロ。
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
    // **「行が無い」＝増分ゼロであって、そのターンが無料だったわけではない**
    // （このテストでは実際に増分がゼロなので1件のまま増えない、が正しい）。
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

    // resume / /clear で SDK 側の累積が 0 から始まり、次に読めた値が 3 だった形。
    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      'done イベントが2件届く',
    );

    const all = await s.stores.journal.list({ limit: 50 });
    // **既存の1行（`exchange with=self`）は従来どおり出る**（あちらを壊していない）。
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
      // **`stop()` も捕獲の内側で呼ぶ。** 理由はすぐ上の兄弟
      // （`台帳へ積めなくてもターンは止まらない`）と同じで、外に置くと `stop()` が
      // 積む片付けの蒸留ターンの台帳失敗が**生の stderr へ漏れる**。
      // `turn_usage` が0件であることも、片付けのターンまで含めて見るほうが強い。
      await s.clone.stop();
    });

    expect(stderr.join('')).toContain('利用状況の台帳');
    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(0);
  });

  it('失敗したターン（isSuccessResult が偽）は turn_usage の行を書かず、消費は次の成功したターンへ合算される', async () => {
    // `#recordUsage` は `isSuccessResult` が偽の result を早期 return で捨てる
    // （`schema.ts` の `turn_usage.models` の doc「## これは『このターンの消費』
    // ではなく『前回成功した result からの増分』である」）。1ターン目は失敗、
    // 2ターン目は成功で、SDK側の累積は両方を含む形（$5）を返す ——
    // 失敗ターンの分（$2）は消えるのではなく、2ターン目の増分へ合算されて
    // 現れることを見る。
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

    // **失敗ターンは行を1件も作らない。**
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
    // **失敗ターンの分（$2）は消えたのではなく、2ターン目の増分（$5）へ
    // 合算されて現れている**（基準は失敗ターンで更新されていないので、
    // 2ターン目の差分は 5 - 0 = 5 になる）。
    expect(entry.models['claude-fable-5']?.costUsd).toBe(5);

    await s.clone.stop();
  });

  /**
   * **非対称の解消。** `manager.ts` の `case 'usage'` の `catch` は台帳の
   * 記録が失敗すると `exchange with=manager` を日誌へ書くが、クローン層の
   * `#recordUsage` は `noteDroppedRecord` で stderr にしか跡を残していな
   * かった。台帳の記録が落ちたクローンのターンは、日誌に `turn_usage` も
   * `exchange` も1行も残らなかった（`schema.ts` の `turn_usage` の doc
   * 「行が無い理由は3つある」の2番）。ここでは `#recordUsage` の `catch` が
   * `#journal` を1回だけ呼び直すようになったことを見る（新しい仕組みは
   * 作っていない — `#journal` が既に持つ「best-effort・stderr フォール
   * バック・throw しない」の契約に乗るだけである）。
   */
  it('台帳へ積めなければ、日誌に exchange with=self が1件残る（非対称の解消）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    s.clone.post(humanMessage('やあ'));
    // 台帳が落ちてもターンは正常に畳まれる（既存の振る舞いを壊していない）。
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
    // マネージャー層（`manager.ts` の同じ catch）と文言を揃えてある。
    expect(dropped?.text).toContain('消費を台帳へ記録できなかった（この分は集計に出ない）');
    // クローン層には複数マネージャーのような区別が無い代わりに、呼び出し
    // 文脈を区別する軸である `site` をタグとして前置する。
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
      // done が来る＝ターンが完走している（`#journal` の内側の catch へ
      // 吸収され、`#recordUsage` の外へ例外が漏れていない）。
      await waitForDone(s.events);
    });

    // 台帳の失敗そのものを名指しする跡は stderr に残る。
    expect(stderr.join('')).toContain('利用状況の台帳');
    // 日誌への追記そのものも失敗したので、`#journal` 自身のフォールバックで
    // もう1行 stderr に残る（`noteDroppedRecord('日誌', ...)`）。
    expect(stderr.join('')).toContain('日誌を記録できませんでした');

    await s.clone.stop();
  });

  /**
   * ターンの境界の文脈占有（`contextUsage`）・compaction（`compactions`）・
   * `result.usage`（`mainLoopUsage`）— この3つが `turn_usage` へちゃんと
   * 載ることを見る（PR「turn_usage にターン境界の文脈占有・compaction・
   * result.usage を足す」）。
   */
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

    /**
     * ⭐⭐⭐ **内訳は既に払ってあるものを写すだけである**（#804）。
     *
     * `#observeContextUsage` は `getContextUsage()` を**引数なし**で呼ぶ。SDK の
     * doc は逐語で `Defaults to 'full'.` と言い、`'full'` は「カテゴリごとに
     * token-count API を呼ぶ」である ⟹ **内訳を取り出さなくても費用は同じ。**
     * それを捨てていたのがこの Issue の欠陥だった。
     *
     * ## ⚠️ この歯が測っていないこと（正直に書く）
     *
     * - **SDK が返す数そのものは測っていない。** フェイクの `Query` が返す値は
     *   テストが書いた任意の数である（#804 の「言えないこと(1)」）。ここが測るのは
     *   **写し方**——合計へ畳む・空なら欄を作らない・上限で切る——だけである
     * - **`detail: 'full'` の実費用も測っていない。** 既定がそうであることは
     *   型定義の逐語で確かめたが、往復の時間は本番の `durationMs` にしか出ない
     */
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

      // 配列は合計と件数へ畳まれている（1本ずつは載らない）。
      expect(entry.contextUsage?.mcpToolTokens).toBe(1_000);
      expect(entry.contextUsage?.mcpToolCount).toBe(3);
      expect(entry.contextUsage?.memoryFileTokens).toBe(700);
      expect(entry.contextUsage?.memoryFileCount).toBe(1);
      expect(entry.contextUsage?.systemPromptTokens).toBe(8_000);
      expect(entry.contextUsage?.systemPromptSectionCount).toBe(2);
      // カテゴリはそのまま（軸の数だけなので小さい）。**`kind` もそのまま届く**
      // （#804——`#observeContextUsage` が捨てていた欄）。
      expect(entry.contextUsage?.categories).toEqual([
        { name: 'System prompt', tokens: 8_000, kind: 'used' },
        { name: 'MCP tools', tokens: 3_000, kind: 'deferred' },
      ]);
      // 切っていないので省略の欄は無い。
      expect(entry.contextUsage?.categoriesOmitted).toBeUndefined();
      // **道具の名前は1つも載らない**（畳んだことの裏側）。
      expect(JSON.stringify(entry.contextUsage)).not.toContain('manager_list');

      await s.clone.stop();
    });

    /**
     * ⭐⭐ **`kind` を返さない SDK（実機で未対応の古い版と同じ形）でも、欄が
     * 壊れない**（#804）。`categories[].kind` は `schema.ts` で `.optional()`
     * にしてある——ここは書き込み側（`#observeContextUsage`）が `kind` の無い
     * 軸を落とさず、`kind` だけが無い形で通ることを確かめる。
     */
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

    /**
     * ⭐⭐⭐ **空の軸に 0 の欄を作らない**（AGENTS.md の地雷「取れない軸に 0 の
     * 行を作る」）。
     *
     * SDK の `systemPromptSections` / `mcpTools` は optional である ⟹ 返って
     * こない回が実在する。そこへ 0 を置くと「測ったが 0 だった」と読めるが、
     * 実際は「その軸を測っていない」である。**欄そのものを作らない側へ倒す。**
     */
    it('⭐⭐⭐ SDK が内訳を返さない回は、欄そのものを作らない（0 を置かない）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        getContextUsage: () => ({
          totalTokens: 12_000,
          rawMaxTokens: 200_000,
          percentage: 6,
          isAutoCompactEnabled: true,
          // 内訳はどれも空（実機で古い CLI が返さない形と同じ）。
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

      // **既に在った5つの欄だけで、1つも足されていない。**
      expect(entry.contextUsage).toEqual({
        durationMs: expect.any(Number),
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
        isAutoCompactEnabled: true,
      });

      await s.clone.stop();
    });

    /**
     * ⭐⭐ **軸が増えたら件数の上限で切り、切ったことを名乗る。**
     *
     * いまの SDK が返す軸は1桁なので**この上限は噛まない。** 塞いでいるのは
     * 「版が上がって軸が増えたときに、日誌の1行が黙って伸びること」である。
     */
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
      // 切っている（＝この歯が空振りしていない）。
      expect(omitted).toBeGreaterThan(0);
      // **載った数と省いた数の和が、渡した数と一致する**（黙って落ちた分が無い）。
      expect(shown + omitted).toBe(100);
      // 落ちたのは末尾側（先頭から詰める）。
      expect(entry.contextUsage?.categories?.[0]).toEqual({ name: '軸0', tokens: 0 });

      await s.clone.stop();
    });

    it('`getContextUsage()` が失敗しても、ターンは止まらず `contextUsage.error` に理由が入る（秘密は伏せる）', async () => {
      const s = setup(undefined, createMemoryStores(), {
        modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
        // **`fakeSdk` 側で `SUPER_SECRET_TOKEN` を投げる。** `process.env` に
        // 同じ値を置いておき、`describeProbeError` の `redactEnvSecrets` が
        // それを `[REDACTED]` へ変えることを見る。
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
      // 失敗しても他の欄（成功時だけ載る欄）は無い。
      expect(entry.contextUsage?.totalTokens).toBeUndefined();
      // 失敗してもターン自体は完走している（`done` が来た時点で自明だが、
      // 明示的に置く）。
      expect(s.events.some((event) => event.type === 'done')).toBe(true);

      await s.clone.stop();
    });

    it('`getContextUsage` を実装していない `Query`（実機で未対応のときと同じ形）でも、例外を `error` として拾いターンは止めない', async () => {
      // `getContextUsage` オプションを渡さない ＝ フェイクの `Query` はこの
      // メソッドを持たない（`fakeSdk` の doc）。
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

    /**
     * **Issue #982 — 委譲（マネージャー／ランナー）層は #976 / PR #980 で
     * 直ったが、クローン層には同じ非対称がそのまま残っている。第1段でここに
     * 固定したのは当時の挙動——`#apply` の `case 'turn_ended'`（`clone.ts` の
     * 逐語は
     * `grep -Fn -- 'ターンの境界の文脈占有を、日誌へ1行書く前に1回だけ聞く' packages/core/src/clone.ts`）
     * は成否分岐の**外**で `#observeContextUsage()` を呼び、その戻り値を
     * 無条件に `#recordUsage(event.usage, 'session', 'cumulative', { contextUsage, … })`
     * へ渡す。だが `#recordUsage` 本体（逐語は
     * `grep -Fn -- '積める消費が無い回はここで終わる' packages/core/src/clone.ts`）
     * は `if (usage === undefined) return;` で降りる —— 失敗したターンは
     * `event.usage` 自体が undefined（`claude-provider.ts` の
     * `foldClaudeMessage` が成功した result の消費だけを通すため）なので、
     * **測った文脈占有はここで一緒に捨てられ、journal のどこにも残らなかった。**
     *
     * **`#lastContextUsage`（`self_status` の材料）は更新される**——
     * `#recordUsage` を呼ぶ手前で無条件に `this.#lastContextUsage = contextUsage ?? null;`
     * が走るためである。だから「記憶には残るが日誌には残らない」——
     * プロセスが落ちれば消え、履歴を持たず、事後に振り返れない
     * （#982 本文の「なぜ #980 で一緒に直さなかったか」節）。
     *
     * ⚠️ **委譲層の `runner-context-usage.test.ts` / `manager-context-usage.test.ts`
     * と同じ役割の歯を、クローン層のこのファイルに足した。** #980 が
     * 独立の journal 型 `context_usage`（`layer: 'clone' | 'manager'`）を
     * 新設しており、`layer: 'clone'` は既にスキーマ上許されていた
     * （`schema.ts` の `context_usage.layer` は `usageLayerSchema` で
     * `'clone'` を含む）——足りなかったのは書き手だけだった。
     *
     * **⚠️ 第2ラウンド（レビュー指摘で見つかった見落とし）— 最初はここに
     * 失敗ターンの分岐しか固定していなかった。** `context_usage` という
     * journal 型は、クローン層ではこの Issue が直るまで**成功・失敗を
     * 問わず1件も書かれたことが無かった**——`#recordUsage` を通る成功ターンが
     * 書くのは `turn_usage` であって `context_usage` ではないためである。
     * 失敗ターンだけを固定すると、「新しい書き込みを `event.succeeded` の
     * 内側へ移す」（＝成功ターンでだけ書く形にする）という変異を、この歯は
     * 検出できなかった。**ここでは両方の分岐を併せて固定していた。**
     *
     * **第2段（#982）でこの関門自体を直した。** `case 'turn_ended'` が
     * `event.succeeded` を見る前に、独立の `context_usage` journal 行として
     * 観測できた値を無条件に書くようにした（`clone.ts` の同じ箇所の doc）。
     * `#recordUsage` の早期 return は変えていない——`turn_usage` は今も
     * 増分が無い回（失敗したターン含む）に行を書かない。変わったのは、
     * 文脈占有がそこにしか無かったことである。下の2本のアサーションは、
     * この直った後の挙動（成功・失敗どちらのターンでも `context_usage` に
     * 残る）を検算する——直す前はどちらも `toEqual([])` だった。
     */
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

      // 失敗した result は台帳へ入らない（既存の挙動。上の「失敗した result は
      // 台帳へ入らない」テストと同じ理由）ので、turn_usage の行そのものは今も無い
      // ——#982 が直したのはこちらではない。
      expect(await s.stores.journal.list({ types: ['turn_usage'] })).toEqual([]);

      // **⭐ ここが #982 の直した非対称である。** `#observeContextUsage` 自体は
      // 成否分岐の手前で呼ばれ値を測っており、`context_usage` 行は
      // `event.succeeded` を見る前に無条件で書かれる（`clone.ts` の
      // `case 'turn_ended'`）ので、失敗したターンでも文脈占有はここへ残る
      // ——直す前は `#recordUsage` の早期 return に巻き込まれて空だった。
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

      // 成功して増分もある回なので turn_usage の行も引き続き書かれる
      // （既存の読み手との互換のため——`clone.ts` の `#recordUsage` の doc）。
      const turnUsageRows = await s.stores.journal.list({ types: ['turn_usage'] });
      expect(turnUsageRows.length).toBeGreaterThan(0);

      // **⭐ ここが第2ラウンドで足りていなかった検算である。** 成功ターンでも
      // `context_usage` が独立に1件書かれる——「`event.succeeded` の内側へ
      // 書き込みを移す」という変異（新しい書き込みを成功ターンだけに限る形）
      // を、この歯で検出する。
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

/**
 * 受信箱の到着・配達・消し込み・滞留を、ターンの境界で `inbox_flow` として
 * 日誌へ残す（Issue #783 段0「測るだけ」）。欄の意味は `schema.ts` の
 * `inbox_flow` の doc、数える場所は `clone.ts` の `#remember` / `#inbox.push`
 * （3箇所）/ `#forget` を見よ。
 *
 * ## `settled` は同じ窓には乗らないことがある（重要な非対称）
 *
 * この型は `context_usage` と同じ境界（`case 'turn_ended'`）で書く。だが
 * `#forget`（＝ `settled` を数える場所）は、その書き込みより**後**——
 * `#pump` の `finally`（`#handle` が返ってから）でしか呼ばれない
 * （`clone.ts` の `#pump` のループ本体）。⟹ **1件の人間の発言を処理した
 * その回の `inbox_flow` 行には、その発言自身の `settled` はまだ乗らない**
 * ——次にもう1件処理があったとき、その回の行に「前回ぶんの `settled`」が
 * 乗る（下の「2件目の窓には、1件目の消し込みが型別で載る」がこれを固定
 * する）。**データが失われるのではなく、窓が1つずれるだけである。**
 */
