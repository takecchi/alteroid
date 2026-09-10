import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { JobStatus } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 「後続の報告」の断り書き（`superseded.ts`）が、ターンの入口（`clone.ts` の
 * `#runTurn`）に**実際に載る**かの配線を測る。
 *
 * **置き場所について。** `clone-situation-notice.test.ts` が同じ骨格（`fakeSdk` /
 * `stubPool` / `bootClone`）を持つが、あちらは `situation.ts`（委譲・器の
 * 数え上げ）専用で、この節が読む材料（`stores.commitments`）とも、読めなかった
 * ときの倒れ先（`describeSuperseded` の `uncountable`）とも別物である
 * （`superseded.ts` 冒頭の「`#commitmentNoticeFor` に混ぜない」と同じ理由）。
 * 1本の歯で両方を見ると、落ちたときにどちらの配線が壊れたのか判別できなく
 * なるので、別ファイルに分けた。
 *
 * **数え方と字面そのものは `superseded.test.ts` が別に固定している。** ここで
 * 測るのは「クローンが実際にそれを渡していること」と「台帳が読めなくても
 * 受信箱のループが死なないこと」だけである。
 */

interface Fake {
  fn: typeof sdkQuery;
  /** SDK へ渡った本文（＝クローンが実際に読んだプロンプト）。 */
  inputs: string[];
}

/** SDK の代わり（`clone-situation-notice.test.ts` の `fakeSdk` と同じ骨格）。 */
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

function summary(id: string, status: JobStatus, live: boolean): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
  };
}

/**
 * `ManagerPool` のスタブ。**この節が測っているのは `stores.commitments` の
 * 配線なので、`managers` の中身そのものは重要ではない**——`#situationNoticeFor`
 * が既存の配線として同じターンで `list()` / `runners()` を呼ぶので、投げない
 * 程度に応えれば十分である（`clone.test.ts` の `throwingPool` と同じ作法で
 * それ以外は未実装のまま置く）。
 */
function stubPool(managers: ManagerSummary[]): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () => Promise.resolve(managers),
    denials: () => [],
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: [
          {
            label: 'runner-0',
            state: 'connected' as RunnerLiveness,
            since: '2026-09-05T00:00:00.000Z',
            managers: [],
            revision: { status: 'unheard' as const },
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
    transcript: notImplemented,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

function bootClone(stores: Stores, managers: ManagerPool): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({ stores, queryFn: fake.fn, env: {}, managers });
  return { ...fake, clone };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const AT = '2026-09-05T00:00:00.000Z';
const MANAGER_ID = 'mgr-run';

function pool(): ManagerPool {
  return stubPool([summary(MANAGER_ID, 'running', true)]);
}

describe('後続の報告が台帳に在るとき、プロンプトに件数の行が出る', () => {
  it('先に積んである「未来」の報告を数えて件数の行を出す', async () => {
    const stores = createMemoryStores();
    // デーモン落ちからの拾い直しを模す——古い合図が配られる前に、同じ委譲から
    // 既に後続の報告が台帳へ積まれている状態を先に作る。
    await stores.commitments.open({
      id: 'evt-future',
      at: '2026-09-05T00:05:00.000Z',
      origin: 'manager',
      source: MANAGER_ID,
      body: '[report] 先に進んでいた',
    });
    const s = bootClone(stores, pool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-old',
      at: AT, // 台帳の行（00:05）より前
      managerId: MANAGER_ID,
      kind: 'report',
      text: '拾い直された古い報告',
    });
    await waitFor(() => s.inputs.length > 0, '1本目のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain(`この委譲（${MANAGER_ID}）`);
    expect(text).toContain('報告が 1 件届いている');
    expect(text).toContain('2026-09-05T00:05:00.000Z');

    await s.clone.stop();
  });
});

/**
 * ⭐ **これが「赤くなってはいけない変異」の歯である。** 後続の報告が0件で
 * 数え切れたとき、`describeSuperseded` は `''` を返す契約（`superseded.ts`）
 * なので、プロンプトはこの断り書きが実装される前とバイト単位で同じでなければ
 * ならない。
 */
describe('後続が0件で数え切れたときは、プロンプトを1文字も変えない', () => {
  it('台帳に他の行が無ければ、この節の語彙がプロンプトに1つも現れない', async () => {
    const s = bootClone(createMemoryStores(), pool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-only',
      at: AT,
      managerId: MANAGER_ID,
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターン');

    const text = s.inputs.join('\n');
    // **番兵はこの節の主題語（`後続`）にしてある。** 最初は
    // `'この合図より後'` を見ていたが、**変異試験で通り抜けた** ——
    // `describeSuperseded` が `'none'` でも別の文言を返すように壊すと、
    // その断片を含まないので緑のままになる。⟹ 「文面のどれか1つが出ない」
    // ではなく「この節の語彙が1つも出ない」を測る。
    //
    // **バイト単位の「1文字も足さない」を持つのはこの歯ではない。**
    // `superseded.test.ts` の
    // `0件・障害なし ⟹ none で、describeSuperseded は空文字を返す`
    // が `toBe('')` で押さえており、こちらはその値が配線を素通りして
    // ターンの入口まで来ることだけを測る。
    expect(text).not.toContain('後続');
    expect(text).not.toContain('この合図より後');
    // それでも本文そのものは変わらず届く。
    expect(text).toContain('終わった');

    await s.clone.stop();
  });
});

describe('台帳（stores.commitments）が読めなくても、受信箱のループは死なない', () => {
  it('list() が投げても、uncountable の文が出て、次の合図もちゃんと処理される', async () => {
    const stores = createMemoryStores();
    stores.commitments.list = () => Promise.reject(new Error('台帳が壊れている（実測を模す）'));
    const s = bootClone(stores, pool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-1',
      at: AT,
      managerId: MANAGER_ID,
      kind: 'report',
      text: '終わった1',
    });
    await waitFor(() => s.inputs.length > 0, '1本目のターン');

    // ②「数えられなかった」の文がプロンプトに出ている。
    const first = s.inputs[0];
    expect(first).toContain('数えられなかった');
    expect(first).toContain('台帳が壊れている（実測を模す）');
    expect(first).toContain('「0 件」ではなく');

    // ①受信箱のループが生きている——次の合図が処理される。
    s.clone.post({
      type: 'human_message',
      id: 'evt-2',
      at: AT,
      text: '次の合図はちゃんと届く',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 1, '2本目のターン');
    expect(s.inputs[1]).toContain('次の合図はちゃんと届く');

    await s.clone.stop();
  });
});
