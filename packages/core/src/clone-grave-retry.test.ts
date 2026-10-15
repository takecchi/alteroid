import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitFor, waitForDone, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import type { Stores } from './store.js';

// 蒸留（サイドクエリ）だけを、枠（429）で落とせる fake。`state.failing` を下ろすと通る
function makeSdk() {
  const inner = fakeSdk();
  const state = { failing: true };
  const fn = ((params: { prompt: unknown }) => {
    if (typeof params.prompt === 'string' && state.failing) {
      inner.calls.push({
        options: (params as { options?: FakeCall['options'] }).options ?? {},
        inputs: [params.prompt],
        kind: 'sideQuery',
      });
      // eslint-disable-next-line require-yield
      async function* boom(): AsyncGenerator<never, void> {
        throw new Error('API Error: 429 {"type":"rate_limit_error"}');
      }
      return Object.assign(boom(), { close: () => undefined, interrupt: async () => undefined });
    }
    return (inner.fn as unknown as (p: unknown) => unknown)(params);
  }) as unknown as typeof sdkQuery;
  return { fn, calls: inner.calls, state };
}

function build(options: {
  stores?: Stores;
  observations?: TokenRotatorObservation[];
  keyId?: string;
  // 鍵を後から差し替える（回し手が鍵を回した、を再現する）
  keyRef?: { id: string };
  // 観測の `await` の中で走らせる処理（回し手が `recycleSessionForToken()` を呼ぶ形の再現）
  onObserve?: (o: TokenRotatorObservation) => void | Promise<void>;
}) {
  const stores = options.stores ?? createMemoryStores();
  const sdk = makeSdk();
  const keyRef =
    options.keyRef ?? (options.keyId === undefined ? undefined : { id: options.keyId });
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: sdk.fn,
    env: {},
    ...(keyRef === undefined
      ? {}
      : { tokenIdentity: () => ({ tokenId: keyRef.id, generation: 1 }) }),
    ...(options.observations === undefined && options.onObserve === undefined
      ? {}
      : {
          onUsageObservation: async (o: TokenRotatorObservation) => {
            options.observations?.push(o);
            await options.onObserve?.(o);
          },
        }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { clone, stores, ...sdk };
}

function sideCallsWith(calls: FakeCall[], marker: string): number {
  return calls.filter((c) => c.kind === 'sideQuery' && c.inputs.some((i) => i.includes(marker)))
    .length;
}

async function decisions(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['decision'] });
  return rows.map((r) => (r.type === 'decision' ? r.decision : ''));
}

async function firePreCompact(
  calls: FakeCall[],
  transcriptPath: string,
  sessionId = 'sess-fake',
): Promise<void> {
  const hook = calls.find((c) => c.kind === 'session')?.options.hooks?.PreCompact?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
  await hook({ session_id: sessionId, transcript_path: transcriptPath } as never, undefined, {
    signal: new AbortController().signal,
  } as never);
}

describe('クローン — 枠で落ちた蒸留を鍵の契機で拾い直す（#4884）', () => {
  it('起動時の拾い直しが429で落ちても、鍵が回る契機でもう一度走り、成功して印を下ろす', async () => {
    const stores = createMemoryStores();
    const archiveId = (await stores.archive.archive('sess-old', 'RETRY-MARKER-1 生ログ')).id;
    await stores.sessions.setTranscriptGrave({ archiveId });
    const t = build({ stores });

    await waitFor(() => sideCallsWith(t.calls, 'RETRY-MARKER-1') === 1, '起動時の拾い直しが落ちる');
    await waitFor(async () => (await stores.journal.list({})).length > 0, '失敗が日誌へ残る');
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId });

    t.state.failing = false;
    t.clone.recycleSessionForToken();
    await waitFor(
      async () => (await stores.sessions.getTranscriptGrave()) === null,
      '鍵の契機で拾い直して印が下りる',
    );
    expect(sideCallsWith(t.calls, 'RETRY-MARKER-1')).toBe(2);
    expect((await decisions(stores)).some((d) => d.includes('契機（鍵が回った）'))).toBe(true);

    // 印が無ければ契機でも何も起きない
    t.clone.recycleSessionForToken();
    await waitForNoSweep();
    expect(sideCallsWith(t.calls, 'RETRY-MARKER-1')).toBe(2);
    await t.clone.stop();
  });

  it('PreCompact の蒸留が429で落ちたら墓標を残し、次の契機で拾われ、同じ区間は2度移らない', async () => {
    const observations: TokenRotatorObservation[] = [];
    const t = build({ observations, keyId: 'key-A' });
    const { events } = wireEvents(t.clone, 'conv-1');
    t.clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const dir = await makeTempDir('alteroid-clone-grave-retry-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, 'PRECOMPACT-MARKER-2 compaction の前の会話', 'utf8');
    await firePreCompact(t.calls, transcriptPath);

    const grave = await t.stores.sessions.getTranscriptGrave();
    expect(grave).not.toBeNull();
    expect(
      (await decisions(t.stores)).some((d) => d.includes('PreCompact の蒸留を墓標へ回した')),
    ).toBe(true);
    // 枠の観測が、蒸留が走った鍵の身元で上がる。本セッションは枠に当たっていない
    const quota = observations.filter((o) => o.notice !== undefined);
    expect(quota).toHaveLength(1);
    expect(quota[0]?.observedBy?.tokenId).toBe('key-A');
    expect(quota[0]?.notice?.kind).toBe('reached');
    expect(t.clone.usageBlocked).toBe(false);

    t.state.failing = false;
    t.clone.recycleSessionForToken();
    await waitFor(
      async () => (await t.stores.sessions.getTranscriptGrave()) === null,
      '墓標が拾われて下りる',
    );
    expect(sideCallsWith(t.calls, 'PRECOMPACT-MARKER-2')).toBe(2);

    t.clone.recycleSessionForToken();
    await waitForNoSweep();
    expect(sideCallsWith(t.calls, 'PRECOMPACT-MARKER-2')).toBe(2);
    await t.clone.stop();
  });

  it('成功した PreCompact の蒸留は墓標を残さない', async () => {
    const t = build({});
    t.state.failing = false;
    const { events } = wireEvents(t.clone, 'conv-1');
    t.clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const dir = await makeTempDir('alteroid-clone-grave-retry-ok-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, 'OK-MARKER-3', 'utf8');
    await firePreCompact(t.calls, transcriptPath);

    expect(await t.stores.sessions.getTranscriptGrave()).toBeNull();
    expect(sideCallsWith(t.calls, 'OK-MARKER-3')).toBe(1);
    await t.clone.stop();
  });

  it('未処理の墓標 A があるところへ PreCompact の失敗で B を立てても A は残り、A・B とも記憶へ移って両方下りる', async () => {
    const stores = createMemoryStores();
    const archiveA = (await stores.archive.archive('sess-old', 'GRAVE-A-MARKER-4 別のセッション'))
      .id;
    await stores.sessions.setTranscriptGrave({ archiveId: archiveA });
    const t = build({ stores });
    const { events } = wireEvents(t.clone, 'conv-1');
    await waitFor(() => sideCallsWith(t.calls, 'GRAVE-A-MARKER-4') === 1, '起動時に A が落ちる');
    t.clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const dir = await makeTempDir('alteroid-clone-grave-retry-two-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, 'GRAVE-B-MARKER-4 compaction の前', 'utf8');
    await firePreCompact(t.calls, transcriptPath);

    const ids = (await stores.sessions.listTranscriptGraves()).map((g) => g.archiveId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(archiveA);

    t.state.failing = false;
    t.clone.recycleSessionForToken();
    await waitFor(
      async () => (await stores.sessions.listTranscriptGraves()).length === 0,
      'A・B とも拾われて下りる',
    );
    expect(sideCallsWith(t.calls, 'GRAVE-A-MARKER-4')).toBe(2);
    expect(sideCallsWith(t.calls, 'GRAVE-B-MARKER-4')).toBe(2);
    await t.clone.stop();
  });
});

describe('クローン — 墓標の列の拾い直し（#4898）', () => {
  it('列に A・B があり両方が毎回落ちると、それぞれ3回で日誌が止まる（拾い直しは続く）', async () => {
    const stores = createMemoryStores();
    const arcA = (await stores.archive.archive('sess-a', 'QUIET-MARKER-A 生ログ')).id;
    const arcB = (await stores.archive.archive('sess-b', 'QUIET-MARKER-B 生ログ')).id;
    await stores.sessions.addTranscriptGrave({ archiveId: arcA });
    await stores.sessions.addTranscriptGrave({ archiveId: arcB });
    const t = build({ stores });

    const bothTried = (n: number) =>
      sideCallsWith(t.calls, 'QUIET-MARKER-A') >= n &&
      sideCallsWith(t.calls, 'QUIET-MARKER-B') >= n;
    await waitFor(() => bothTried(1), '起動時の拾い直しで A・B が落ちる');
    for (let round = 2; round <= 4; round += 1) {
      await waitForNoSweep();
      t.clone.recycleSessionForToken();
      await waitFor(() => bothTried(round), `${String(round)} 周目`);
    }
    await waitForNoSweep();

    const lines = (await stores.journal.list({})).flatMap((r) =>
      r.type === 'exchange' ? [r.text] : [],
    );
    const count = (id: string, marker: string) =>
      lines.filter((l) => l.includes(marker) && l.includes(id)).length;
    // 拾い直す行 3 + 失敗の行 3 のあと、4 周目以降は書かない
    expect(count(arcA, '記憶へ移せなかった区間を拾い直す:')).toBe(3);
    expect(count(arcB, '記憶へ移せなかった区間を拾い直す:')).toBe(3);
    expect(count(arcA, '蒸留に失敗した')).toBe(3);
    expect(count(arcB, '蒸留に失敗した')).toBe(3);
    expect(await stores.sessions.graveDistillFailures('transcript', arcA)).toBeGreaterThanOrEqual(
      3,
    );
    expect(await stores.sessions.graveDistillFailures('transcript', arcB)).toBeGreaterThanOrEqual(
      3,
    );
    await t.clone.stop();
  });

  it('枠で落ちた蒸留の観測の中から鍵の契機が来ても、同じ鍵なら2周目を回さない。鍵が変われば回す', async () => {
    const stores = createMemoryStores();
    const archiveId = (await stores.archive.archive('sess-old', 'LOOP-MARKER 生ログ')).id;
    await stores.sessions.setTranscriptGrave({ archiveId });
    const keyRef = { id: 'key-A' };
    const holder: { clone?: ReturnType<typeof build>['clone'] } = {};
    let observed = 0;
    const t = build({
      stores,
      keyRef,
      // 回し手が、観測を受けた中で `recycleSessionForToken()` を呼ぶ形
      onObserve: () => {
        observed += 1;
        holder.clone?.recycleSessionForToken();
      },
    });
    holder.clone = t.clone;

    await waitFor(() => sideCallsWith(t.calls, 'LOOP-MARKER') >= 1, '起動時の拾い直しが落ちる');
    await waitFor(() => observed >= 1, '枠の観測が上がる');
    await waitForNoSweep();
    await waitForNoSweep();
    expect(sideCallsWith(t.calls, 'LOOP-MARKER')).toBe(1);

    // 鍵が変われば回す
    keyRef.id = 'key-B';
    t.clone.recycleSessionForToken();
    await waitFor(() => sideCallsWith(t.calls, 'LOOP-MARKER') >= 2, '鍵が変わったので拾い直す');
    await waitForNoSweep();
    await waitForNoSweep();
    expect(sideCallsWith(t.calls, 'LOOP-MARKER')).toBe(2);
    await t.clone.stop();
  });
});

// 拾い直しの列が空になるのを待つ（実時間の待ちを足さない）。内部の列は見えないので、ストアの読みを数周回して流す
async function waitForNoSweep(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
