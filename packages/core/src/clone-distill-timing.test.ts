import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  DISTILL_GAP_NOTICE_HEAD,
  DISTILL_SUCCEEDED_DECISION_PREFIX,
  deriveDistillGapFromJournal,
  describeDistillGap,
  distillSucceededEntry,
} from './distill-gap.js';
import type { DistillGap } from './distill-gap.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ACTOR_ID } from './usage.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, wireEvents, waitFor, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — 蒸留が間に合わなかった区間の検出', () => {
  async function distillSucceededEntries(stores: Stores): Promise<{ decision: string }[]> {
    const entries = (await stores.journal.list({ types: ['decision'] })) as { decision: string }[];
    return entries.filter((entry) => entry.decision.startsWith(DISTILL_SUCCEEDED_DECISION_PREFIX));
  }

  async function distillStartedEntries(stores: Stores): Promise<{ text: string }[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return entries.filter((entry) => entry.text.startsWith('ターンの入力: distill'));
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  it('1: 蒸留が成功で終わったら、日誌にその印が残る', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    const marks = await distillSucceededEntries(s.stores);
    expect(marks.length).toBe(1);
    expect(marks[0]?.decision).toContain('reason=conversation_end');

    await s.clone.stop();
  });

  it('2: 蒸留が失敗して終わったら、成功の印は残らない（開始の印は残る）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'error_during_execution', isError: true } : undefined,
    });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    expect((await distillStartedEntries(s.stores)).length).toBe(1);
    expect(await distillSucceededEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

  it('3: ずれが在れば、次のセッションの最初のターンにだけ断り書きが載る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけたが、蒸留される前に落ちた',
    });
    await tick();

    const s = setup(undefined, stores);
    await tick();

    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0]).toContain(DISTILL_GAP_NOTICE_HEAD);

    const other = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('別件です', 'conv-2'));
    await waitForDone(other.events);

    expect((s.calls[0] as FakeCall).inputs[1]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await s.clone.stop();
  });

  it('4: 正常に蒸留して落ちた器の次のセッションでは、断り書きは載らない（毎回鳴らない）', async () => {
    const stores = createMemoryStores();
    let nth = 0;
    const first = setup(undefined, stores, {
      modelUsage: () => {
        nth += 1;
        return {
          'claude-fable-5': {
            inputTokens: 10 * nth,
            outputTokens: 20 * nth,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5 * nth,
          },
        };
      },
    });

    first.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(first.events);
    await first.clone.endConversation('conv-1');
    await first.clone.stop();
    await tick();

    const second = setup(undefined, stores);
    await tick();

    second.clone.post(humanMessage('こんにちは'));
    await waitForDone(second.events);

    expect((second.calls[0] as FakeCall).inputs[0]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await second.clone.stop();
  });

  it('5: 成功の印と同じミリ秒に積まれた行を、印より後ろと数えない（境界）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけた',
    });
    await stores.journal.append(distillSucceededEntry('shutdown'));
    await tick();

    const s = setup(undefined, stores);
    await tick();

    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).inputs[0]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await s.clone.stop();
  });

  it('6: PreCompact のサイドセッションで蒸留が成功したら、reason=pre_compact の印が残る', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-distill-gap-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const marks = await distillSucceededEntries(s.stores);
    expect(marks.map((mark) => mark.decision)).toEqual([
      `${DISTILL_SUCCEEDED_DECISION_PREFIX} reason=pre_compact`,
    ]);

    await s.clone.stop();
  });

  it('7: `site` が `session` でない `turn_usage` は活動として数えない（蒸留のサイドセッションの分）', async () => {
    const usageEntry = (site: 'session' | 'distill'): JournalEntryInput => ({
      type: 'turn_usage',
      layer: 'clone',
      site,
      managerId: CLONE_ACTOR_ID,
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 0.5,
        },
      },
    });

    const stores = createMemoryStores();
    await stores.journal.append(distillSucceededEntry('pre_compact'));
    await stores.journal.append(usageEntry('distill'));
    await tick();

    expect(
      await deriveDistillGapFromJournal(stores.journal, { until: new Date().toISOString() }),
    ).toBeNull();

    await stores.journal.append(usageEntry('session'));
    await tick();

    const gap = await deriveDistillGapFromJournal(stores.journal, {
      until: new Date().toISOString(),
    });
    expect(gap?.activityCount).toBe(1);
  });

  it('8: 区間の始まりが蒸留の時刻と同じミリ秒のとき、断り書きにその理由が載る', () => {
    const gap: DistillGap = {
      lastDistilledAt: '2026-08-28T00:00:00.000Z',
      firstActivityAt: '2026-08-28T00:00:00.000Z',
      lastActivityAt: '2026-08-28T00:00:00.500Z',
      activityCount: 1,
      window: 'since_last_distill',
    };

    expect(describeDistillGap(gap)).toContain(
      '**区間の始まりが蒸留の時刻と同じに見えるのは、日誌の時刻がミリ秒までしか' +
        '無いためである。**数えているのは時刻ではなく日誌の並びで、成功の印そのものより' +
        '後ろに積まれた行だけを数えている（印と同じミリ秒でも、印より前に積まれた行は' +
        '数えていない）。',
    );
  });

  it('9: 区間の始まりが蒸留の時刻と違うとき、その1文は載らない', () => {
    const gap: DistillGap = {
      lastDistilledAt: '2026-08-28T00:00:00.000Z',
      firstActivityAt: '2026-08-28T00:00:00.500Z',
      lastActivityAt: '2026-08-28T00:00:01.000Z',
      activityCount: 1,
      window: 'since_last_distill',
    };

    expect(describeDistillGap(gap)).not.toContain('区間の始まりが蒸留の時刻と同じに見えるのは');
  });
});

describe('クローン — 定期の棚卸し（scheduled な蒸留）', () => {
  const FAT = `---\ntype: premise\ndescription: 要旨\n---\n${Array.from(
    { length: 300 },
    (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
  ).join('\n')}`;

  const COMMITMENT_NOTICE = '[system] 引き受けたまま終わっていない仕事は';
  const SITUATION_NOTICE = '[system] いまの全体';

  function tidyEvent(): InboxEvent {
    return { type: 'distill', id: 'evt-tidy', at: new Date().toISOString(), reason: 'scheduled' };
  }

  it('⭐ 棚卸しの刻みでは、いま測った的の一覧がターンの入力に載る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(tidyEvent());
    await waitFor(() => ((s.calls[0] as FakeCall).inputs.length ?? 0) >= 2, '棚卸しのターン');

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('定期の棚卸しの刻みが来た');
    expect(input).toContain('- alteroid-work:');
    expect(input).toContain('memory_section_move');

    await s.clone.stop();
  });

  it('会話終了の蒸留には的の一覧を載せない（本題を薄めない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await s.clone.endConversation('conv-1');

    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).toContain('記憶へ移すべきものがあるか確認せよ');
    expect(distill).not.toContain('- alteroid-work:');
    expect(distill).not.toContain('定期の棚卸しの刻みが来た');

    await s.clone.stop();
  });

  it('⭐⭐ 棚卸しのターンは distill として走る（記憶の守りが効く側）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(tidyEvent());
    await waitFor(() => ((s.calls[0] as FakeCall).inputs.length ?? 0) >= 2, '棚卸しのターン');

    const human = (s.calls[0] as FakeCall).inputs[0] ?? '';
    const tidy = (s.calls[0] as FakeCall).inputs[1] ?? '';

    expect(human).toContain(COMMITMENT_NOTICE);
    expect(human).toContain(SITUATION_NOTICE);
    expect(tidy).not.toContain(COMMITMENT_NOTICE);
    expect(tidy).not.toContain(SITUATION_NOTICE);

    await s.clone.stop();
  });
});
