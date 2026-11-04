import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 墓標（退避の `transcript` と、捨てたセッションの `lost_session`）の拾い直しが日誌へ書く行を、全文一致（`toBe` / `toEqual`）で固定する。
// 既存の `clone-grave-pickup-*.test.ts` / `clone-grave-retry.test.ts` は `includes` で部分を見ているので、文言が1文字ずれても通る。ここはそのずれを捕まえる。
// 本番コードは変えない。拾い直しの後半（蒸留と印の下ろし方）を1つにまとめる変更の前に、いまの出力を固定するための試験である。

const FAILURE = '[障害] ';
const RECOVERY = '[復旧] ';
const BODY = 'GRAVE-PIN-MARKER-1 前の器の生ログ';
// `reasonOf(error)` は `Error: ` を頭に付けて返す（いまの出力をそのまま固定する）
const DISTILL_FAILED_REASON =
  'Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）';
const LIMIT_NOTE =
  '。同じ区間の蒸留が 3 回続けて失敗したので、以後は成功するまで、この区間の拾い直しと失敗の行を日誌に書かない（拾い直しは続ける）';

type Kind = 'transcript' | 'lost_session';
type Shape = 'body' | 'missing' | 'removed';
type Mode = 'ok' | 'fail' | 'quota';

// 蒸留（サイドクエリ = prompt が文字列）だけを、モードで成功・失敗・枠（429）に切り替えられる fake
function makeSdk(initial: Mode) {
  const ok = fakeSdk();
  const failing = fakeSdk(undefined, { resultSubtype: 'error_during_execution' });
  const state = { mode: initial };
  let sideCalls = 0;
  const call = (inner: { fn: unknown }, params: unknown): unknown =>
    (inner.fn as (p: unknown) => unknown)(params);
  const fn = ((params: { prompt: unknown }) => {
    if (typeof params.prompt === 'string') {
      sideCalls += 1;
      if (state.mode === 'quota') {
        // eslint-disable-next-line require-yield
        async function* boom(): AsyncGenerator<never, void> {
          throw new Error('API Error: 429 {"type":"rate_limit_error"}');
        }
        return Object.assign(boom(), { close: () => undefined, interrupt: async () => undefined });
      }
      if (state.mode === 'fail') return call(failing, params);
    }
    return call(ok, params);
  }) as unknown as typeof sdkQuery;
  return { fn, state, sideCalls: () => sideCalls };
}

function boot(stores: Stores, sdk: ReturnType<typeof makeSdk>, keyRef?: { id: string }) {
  return createClone({
    stores,
    queryFn: sdk.fn,
    env: {},
    ...(keyRef === undefined
      ? {}
      : { tokenIdentity: () => ({ tokenId: keyRef.id, generation: 1 }) }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
}

interface World {
  stores: Stores;
  id: string;
  graveCount(): Promise<number>;
  failures(): Promise<number>;
  noteFailures(times: number): Promise<void>;
  addAnother(): Promise<void>;
}

// `raced`: 読んでいる間に、別の経路が同じ印を先に下ろした状態を作る（`clear…If` が偽を返す）
async function makeWorld(kind: Kind, shape: Shape, raced = false): Promise<World> {
  const base = createMemoryStores();
  if (kind === 'transcript') {
    let id = 'sess-gone-0001';
    if (shape !== 'missing') {
      id = (await base.archive.archive('sess-old', BODY)).id;
      if (shape === 'removed') await base.archive.remove(id);
    }
    await base.sessions.addTranscriptGrave({ archiveId: id });
    const stores: Stores = raced
      ? {
          ...base,
          archive: {
            ...base.archive,
            readTail: async (archiveId: string, maxChars: number) => {
              const result = await base.archive.readTail(archiveId, maxChars);
              await base.sessions.clearTranscriptGraveIf(archiveId);
              return result;
            },
          },
        }
      : base;
    return {
      stores,
      id,
      graveCount: async () => (await base.sessions.listTranscriptGraves()).length,
      failures: () => base.sessions.graveDistillFailures('transcript', id),
      noteFailures: async (times) => {
        for (let i = 0; i < times; i += 1)
          await base.sessions.noteGraveDistillFailure('transcript', id);
      },
      addAnother: async () => {
        const other = (await base.archive.archive('sess-two', `${BODY} 2本目`)).id;
        await base.sessions.addTranscriptGrave({ archiveId: other });
      },
    };
  }
  const id = 'sess-lost';
  await base.sessions.addLostSessionGrave({ projectKey: 'proj', sessionId: id });
  const body = shape === 'body' ? BODY : null;
  const stores: Stores = {
    ...base,
    sessionTranscriptTail: {
      readTail: async () => {
        if (raced) await base.sessions.clearLostSessionGraveIf(id);
        return body;
      },
      measureSize: async () => null,
    },
  };
  return {
    stores,
    id,
    graveCount: async () => (await base.sessions.listLostSessionGraves()).length,
    failures: () => base.sessions.graveDistillFailures('lost_session', id),
    noteFailures: async (times) => {
      for (let i = 0; i < times; i += 1)
        await base.sessions.noteGraveDistillFailure('lost_session', id);
    },
    addAnother: async () => {
      await base.sessions.addLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-lost-2' });
    },
  };
}

// 拾い直しが書く行（`[障害] ` と `[復旧] ` で始まる自分宛ての exchange）だけを、書かれた順に取る
async function graveLines(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], order: 'asc' });
  return rows.flatMap((row) =>
    row.type === 'exchange' &&
    row.with === 'self' &&
    (row.text.startsWith(FAILURE) || row.text.startsWith(RECOVERY))
      ? [row.text]
      : [],
  );
}

async function distillInputLines(stores: Stores): Promise<number> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  return rows.filter(
    (row) => row.type === 'exchange' && row.text.includes('ターンの入力: pre_compact_distill'),
  ).length;
}

// 実時間の待ちを足さない: 後続の書き込みが済むまで、マイクロタスクとマクロタスクを数周流す
async function flush(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForLines(stores: Stores, count: number): Promise<void> {
  await waitFor(
    async () => (await graveLines(stores)).length >= count,
    `日誌の行が${count}本になる`,
  );
  await flush();
}

const LINES = {
  transcript: {
    recovery: (id: string) => `${RECOVERY}前の器が記憶へ移せなかった区間を拾い直す: ${id}`,
    failure: (id: string, note: string) =>
      `${FAILURE}前の器が記憶へ移せなかった区間の蒸留に失敗した: ${DISTILL_FAILED_REASON}` +
      `（印は残す。次の起動で拾い直す: ${id}）${note}`,
  },
  lost_session: {
    recovery: (id: string) =>
      `${RECOVERY}捨てたセッションの区間を、預けた生ログから拾い直す: ${id}`,
    failure: (id: string, note: string) =>
      `${FAILURE}捨てたセッションの区間の蒸留に失敗した: ${DISTILL_FAILED_REASON}` +
      `（印は残す。次の起動で拾い直す: ${id}）${note}`,
  },
};

describe.each<Kind>(['transcript', 'lost_session'])(
  '墓標の拾い直しの日誌の行を全文で固定する（%s）',
  (kind) => {
    const lines = LINES[kind];

    describe('読めなかったとき', () => {
      it('印を下ろせたら、下ろした旨の1行だけを書き、蒸留へ進まない', async () => {
        const world = await makeWorld(kind, 'missing');
        const sdk = makeSdk('ok');
        const clone = boot(world.stores, sdk);
        await waitForLines(world.stores, 1);
        await clone.stop();

        const expected =
          kind === 'transcript'
            ? `${FAILURE}記憶へ移せていない区間の退避が見つからないので、印を下ろした: ${world.id}` +
              '（器を作り直した、あるいはそもそも積まれなかった。⚠️ この区間は記憶へ移せていない）'
            : `${FAILURE}捨てたセッションの生ログが1件も無いので、印を下ろした: ${world.id}` +
              '（⚠️ この区間は記憶へ移せていない）';
        expect(await graveLines(world.stores)).toEqual([expected]);
        expect(await world.graveCount()).toBe(0);
        expect(sdk.sideCalls()).toBe(0);
      });

      it('印を下ろせなかった（拾っている間に先に下りた）ら、下ろしていないと書く', async () => {
        const world = await makeWorld(kind, 'missing', true);
        const sdk = makeSdk('ok');
        const clone = boot(world.stores, sdk);
        await waitForLines(world.stores, 1);
        await clone.stop();

        const expected =
          kind === 'transcript'
            ? `${FAILURE}記憶へ移せていない区間の退避を拾えなかったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${world.id}`
            : `${FAILURE}捨てたセッションの生ログが1件も無かったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${world.id}`;
        expect(await graveLines(world.stores)).toEqual([expected]);
        expect(sdk.sideCalls()).toBe(0);
      });

      if (kind === 'transcript') {
        it('removed（本文が消されている）で印を下ろせたら、消した時刻とバイト数を添えて書く', async () => {
          const world = await makeWorld(kind, 'removed');
          const tomb = await world.stores.archive.readTail(world.id, 10);
          if (tomb.kind !== 'removed') throw new Error('前提: 退避が removed であること');
          const sdk = makeSdk('ok');
          const clone = boot(world.stores, sdk);
          await waitForLines(world.stores, 1);
          await clone.stop();

          expect(await graveLines(world.stores)).toEqual([
            `${FAILURE}記憶へ移せていない区間の退避の本文が消されているので、印を下ろした: ${world.id}` +
              `（${tomb.removedAt} に ${tomb.bytes} バイトを落とした` +
              '（消した本文の素の UTF-8 バイト数。置き場で解放した量ではなく、storedBytes とは単位が違う）。' +
              '⚠️ この区間は記憶へ移せていない）',
          ]);
          expect(await world.graveCount()).toBe(0);
          expect(sdk.sideCalls()).toBe(0);
        });

        it('removed で印を下ろせなかったら、missing と同じ「下ろさなかった」文面になる', async () => {
          const world = await makeWorld(kind, 'removed', true);
          const sdk = makeSdk('ok');
          const clone = boot(world.stores, sdk);
          await waitForLines(world.stores, 1);
          await clone.stop();

          expect(await graveLines(world.stores)).toEqual([
            `${FAILURE}記憶へ移せていない区間の退避を拾えなかったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${world.id}`,
          ]);
          expect(sdk.sideCalls()).toBe(0);
        });
      }
    });

    describe('拾い直しの行と蒸留の結果', () => {
      it('静かでなければ拾い直しの行を書き、蒸留が成功したら印を下ろす（失敗の行は無い）', async () => {
        const world = await makeWorld(kind, 'body');
        const sdk = makeSdk('ok');
        const clone = boot(world.stores, sdk);
        await waitFor(async () => (await world.graveCount()) === 0, '印が下りること');
        await flush();
        await clone.stop();

        expect(await graveLines(world.stores)).toEqual([lines.recovery(world.id)]);
        expect(await distillInputLines(world.stores)).toBe(1);
        expect(sdk.sideCalls()).toBe(1);
      });

      it('静かな印（失敗が上限に達している）は、拾い直しの行も蒸留の入力の行も書かないが、蒸留は試み、成功したら印を下ろす', async () => {
        const world = await makeWorld(kind, 'body');
        await world.noteFailures(3);
        const sdk = makeSdk('ok');
        const clone = boot(world.stores, sdk);
        await waitFor(async () => (await world.graveCount()) === 0, '印が下りること');
        await flush();
        await clone.stop();

        expect(await graveLines(world.stores)).toEqual([]);
        expect(await distillInputLines(world.stores)).toBe(0);
        expect(sdk.sideCalls()).toBe(1);
      });

      it('蒸留が失敗したら、印を残し、添える文が空（上限未満）の失敗の行を書く', async () => {
        const world = await makeWorld(kind, 'body');
        const sdk = makeSdk('fail');
        const clone = boot(world.stores, sdk);
        await waitForLines(world.stores, 2);
        await clone.stop();

        expect(await graveLines(world.stores)).toEqual([
          lines.recovery(world.id),
          lines.failure(world.id, ''),
        ]);
        expect(await world.graveCount()).toBe(1);
        expect(await world.failures()).toBe(1);
      });

      it('失敗が上限ちょうどに達した回は、「以後は書かない」を添えた失敗の行を書く（拾い直しの行はまだ書く）', async () => {
        const world = await makeWorld(kind, 'body');
        await world.noteFailures(2);
        const sdk = makeSdk('fail');
        const clone = boot(world.stores, sdk);
        await waitForLines(world.stores, 2);
        await clone.stop();

        expect(await graveLines(world.stores)).toEqual([
          lines.recovery(world.id),
          lines.failure(world.id, LIMIT_NOTE),
        ]);
        expect(await world.graveCount()).toBe(1);
        expect(await world.failures()).toBe(3);
      });

      it('上限を超えて失敗したら、拾い直しも失敗の行も書かない。印は残り、蒸留は試み続ける', async () => {
        const world = await makeWorld(kind, 'body');
        await world.noteFailures(3);
        const sdk = makeSdk('fail');
        const clone = boot(world.stores, sdk);
        await waitFor(async () => (await world.failures()) === 4, '4回目の失敗が数えられること');
        await flush();
        await clone.stop();

        expect(await graveLines(world.stores)).toEqual([]);
        expect(await distillInputLines(world.stores)).toBe(0);
        expect(await world.graveCount()).toBe(1);
        expect(sdk.sideCalls()).toBe(1);
      });
    });

    describe('枠の失敗で控える鍵（#graveFailedTokenKey）', () => {
      it('枠で落ちた鍵は控えられ、同じ鍵の契機では撃ち直さず、成功すると控えが消える', async () => {
        const world = await makeWorld(kind, 'body');
        const sdk = makeSdk('quota');
        const keyRef = { id: 'key-A' };
        const clone = boot(world.stores, sdk, keyRef);
        await waitFor(async () => (await world.failures()) === 1, '起動時の拾い直しが枠で落ちる');
        await flush();
        expect(sdk.sideCalls()).toBe(1);

        // 控えている鍵と同じなら、契機が来ても撃ち直さない
        clone.recycleSessionForToken();
        await flush();
        expect(sdk.sideCalls()).toBe(1);

        // 鍵が変われば撃ち直し、成功して印が下りる
        sdk.state.mode = 'ok';
        keyRef.id = 'key-B';
        clone.recycleSessionForToken();
        await waitFor(
          async () => (await world.graveCount()) === 0,
          '鍵が変わって拾い直され、印が下りる',
        );
        await flush();
        expect(sdk.sideCalls()).toBe(2);

        // 成功で控えが消えているなら、鍵を最初の key-A へ戻しても止まらない（控えが残っていれば止まる）
        sdk.state.mode = 'fail';
        keyRef.id = 'key-A';
        await world.addAnother();
        clone.recycleSessionForToken();
        await waitFor(
          () => sdk.sideCalls() === 3,
          '控えが消えているので、同じ鍵 key-A でも撃ち直す',
        );
        await flush();
        await clone.stop();
      });
    });
  },
);
