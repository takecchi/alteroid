import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 拾い上げ（`#pickUpTranscriptGrave` / `#pickUpLostSession`）が印を下ろすとき、
 * **拾っている間に立った新しい印まで消さないか**（issue #1157 の段2）。
 *
 * ## なぜ窓が在るか
 *
 * 拾い上げは `#pump` から **`void` で launch され、待たれない** ——
 * ⟹ ターンと直列化されていない。一方で新しい印を書くのは `#salvageTranscript`
 * （文脈窓で畳んだ回）と `#noteLostSession`（init すら来ずに落ちた回）で、
 * どちらも `#read` の中から走る。**⟹ 拾い上げの途中に新しい印が立ちうる。**
 *
 * ## ⛔ そしてプロセスを跨がなくても起きる
 *
 * 読みと書きが別々の `await` なので、**単一プロセスの中で割り込める。**
 * ⟹ ストア側のロックでは直らない（1回の呼び出しの中にしか掛からない）。
 *
 * ## 引き直しが片方の分岐にしか無い
 *
 * `#pickUpTranscriptGrave` の doc は「**⚠️ 引き直してから下ろす。** 拾っている
 * 間に新しい印が立つ窓が在る」と書いており、**蒸留に成功した側ではそのとおりに
 * している。** だが「退避が見つからない」側は素で `null` を書く——しかも
 * そちらのほうが**窓が広い**（`archive.read` と日誌の書き込みを跨ぐ）。
 * `#pickUpLostSession` も同じ形である。
 *
 * **⟹ ここで測るのは、引き直しが無い2つの分岐である。**
 */

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(): Fake {
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
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

function bootClone(stores: Stores, fake: Fake): CloneHost {
  return createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
}

function report(text: string, id = 'evt-report'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date(0).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

/** 日誌にその一行が出るまで待つ（＝拾い上げがその分岐を通り終えた合図）。 */
async function waitForJournal(stores: Stores, needle: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const entries = await stores.journal.list();
    if (entries.some((entry) => JSON.stringify(entry).includes(needle))) return;
    if (Date.now() - started > 3000) throw new Error(`日誌に「${needle}」が出ない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('拾い上げが新しい印を消す（#1157 段2）', () => {
  it('⭐ 退避が見つからない分岐: 拾っている間に立った新しい印まで消える', async () => {
    const base = createMemoryStores();
    // 前の器が残した印。退避そのものは器の作り直しで失われている（＝ `missing`）。
    await base.sessions.setTranscriptGrave({ archiveId: 'arc-old' });

    // **拾い上げが `archive.read` を待っているあいだに、文脈窓で畳んだ回が
    // 新しい印を立てる。** 実際に書くのは `#salvageTranscript` だが、それが
    // いつ書くかは拾い上げの側から見て任意なので、ここでは「読んでいる最中」に
    // 固定する。**窓を作っているのではなく、在る窓の中の1点を選んでいる。**
    const stores: Stores = {
      ...base,
      archive: {
        ...base.archive,
        read: async (id: string) => {
          const result = await base.archive.read(id);
          if (id === 'arc-old') {
            await base.sessions.setTranscriptGrave({ archiveId: 'arc-new' });
          }
          return result;
        },
      },
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    // **待つ文言は、下ろした側と下ろさなかった側の両方に共通する部分にする。**
    // 片方だけの文言で待つと、直した実装では永遠に待つ（＝赤の理由が
    // アサーションではなくタイムアウトに化ける）。
    await waitForJournal(stores, '記憶へ移せていない区間の退避');
    await clone.stop();

    // **新しい印は生き残っていなければならない** —— その区間はまだ記憶へ
    // 移せておらず、消すと二度と拾われない。
    expect(await base.sessions.getTranscriptGrave()).toEqual({ archiveId: 'arc-new' });
  });

  it('⭐ 生ログが1件も無い分岐: 同じ形で新しい印が消える', async () => {
    const base = createMemoryStores();
    await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-old' });

    const tail = {
      readTail: async () => {
        await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-new' });
        return null;
      },
    };
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: tail as unknown as Stores['sessionTranscriptTail'],
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '捨てたセッションの生ログが1件も無');
    await clone.stop();

    expect(await base.sessions.getLostSessionGrave()).toEqual({
      projectKey: 'proj',
      sessionId: 'sess-new',
    });
  });

  it('⛔ 陰性対照: 新しい印が立たなければ、退避が無い印はちゃんと下ろされる', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setTranscriptGrave({ archiveId: 'arc-old' });

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '記憶へ移せていない区間の退避');
    await clone.stop();

    // **「一切下ろさない」実装ならここで落ちる。** 下ろさないと、拾えないものを
    // 起動のたびに引きに行くことになる（元の doc「印だけを残さない」）。
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
  });

  it('⛔ 陰性対照: 新しい印が立たなければ、生ログが無い印もちゃんと下ろされる', async () => {
    const base = createMemoryStores();
    await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-old' });
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: {
        readTail: () => Promise.resolve(null),
      } as unknown as Stores['sessionTranscriptTail'],
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '捨てたセッションの生ログが1件も無');
    await clone.stop();

    expect(await base.sessions.getLostSessionGrave()).toBeNull();
  });

  /**
   * **ここが「残った窓を閉じた」ことの現物である。**
   *
   * ⚠️ 引き直して比べる形（`get` → 比較 → `set(null)`）は、**引き直しの後・
   * 下ろす書き込みが効く前**に新しい印が landing すると破れる。実測で再現した
   * ——`setTranscriptGrave(null)` の呼びの中で新しい印を landing させると、
   * 直す前の実装は新しい方を消した。
   *
   * ⛔ **そして、閉じたことを「窓へ割り込んでも消えない」という形では測れない。**
   * 正しい実装にはその窓が無いので、割り込む先が無い（黒箱からは、窓の無い実装と
   * 「割り込みに強い」実装を区別できない）。⟹ **測るのは「素の `set(null)` を
   * 一度も打たない」という、窓が生まれない形そのものである。**
   */
  it('⭐ 拾い上げは印を素の set(null) では下ろさない（判定と書き込みが1操作である）', async () => {
    const base = createMemoryStores();
    await base.sessions.setTranscriptGrave({ archiveId: 'arc-old' });
    await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-old' });

    const nullWrites: string[] = [];
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: {
        readTail: () => Promise.resolve(null),
      } as unknown as Stores['sessionTranscriptTail'],
      sessions: {
        ...base.sessions,
        setTranscriptGrave: async (g) => {
          if (g === null) nullWrites.push('transcript');
          return base.sessions.setTranscriptGrave(g);
        },
        setLostSessionGrave: async (g) => {
          if (g === null) nullWrites.push('lost');
          return base.sessions.setLostSessionGrave(g);
        },
      },
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '記憶へ移せていない区間の退避');
    await waitForJournal(stores, '捨てたセッションの生ログが1件も無');
    await clone.stop();

    // 印は下りている（＝その経路を実際に通った）。
    expect(await base.sessions.getTranscriptGrave()).toBeNull();
    expect(await base.sessions.getLostSessionGrave()).toBeNull();
    // **なのに素の `set(null)` は一度も打たれていない** —— 下ろしたのは
    // `clearTranscriptGraveIf` / `clearLostSessionGraveIf` である。
    expect(nullWrites).toEqual([]);
  });
});
