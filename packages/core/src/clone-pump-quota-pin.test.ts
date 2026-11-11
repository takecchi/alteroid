import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  createEventSink,
  fakeSdk,
  withoutQueueNotice,
  type FakeCall,
} from './clone-test-harness.js';
import { DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// `Clone#pump` の枠（`#usageBlocked`）まわりの2つの塊を、外から固定する。
//   (1) 解除ブロック: `#releaseRequested && !inbox.closed` → `#usageBlocked` を降ろし、保持分と今回の合図を `held → event` の順で先頭へ戻して `continue`
//   (2) 短絡ブロック: `#usageBlocked !== null` → `usage_limited` を emit し、会話があれば `#reportFailure`、内部の合図なら件数だけ積み、`#settleInboxEvent(event, true)` で保持して `continue`
// 期待の値・文面は仕様を先に書いたものではなく、今の出力から変えないための歯である。
// `vitest run <path> -u` でインライン snapshot を生成し、目で読んで確かめた値で、文面の正しさの保証ではない。本番コードは変えない。
// 既存の試験（`clone-quota-hold` / `clone-quota-fold`）が縛っているのは、保持と配り直しの結果（FIFO・ターンが回らない・件数の文言の一部）。
// ここが足すのは、縛っていない枝: 「解除の印が立っているのに枠が既に降りている」素通し、解除の1行の全文（件数あり・なし）と2つのカウンタが0へ戻ること、
// 短絡の内部の合図が `#reportFailure` を呼ばないこと（日誌の失敗行が増えない）、`usage_limited` が `error` より先で解除では出ないこと、
// 解除が墓標の拾い直し（`retryFor('枠の保持を解いた')`）を起こし直すこと、
// そして各 await の位置（microtask の周回数。短絡は続けて来た2件の2件目の周回数が1件目の後始末の長さを写す）。
// 解除ブロックの「受信箱が閉じている」枝（`inbox.closed`）は、ここでは縛っていない（閉じた受信箱でループが回る形を作っていない）。
// 駆動は本物の `Clone` に偽の `queryFn` を繋ぐ。microtask は `await Promise.resolve()` を数える歯（実時間は使わない・sleep しない）。

// 実時間を読まずに「まだ先」と言える固定の時刻（2100-01-01）。回復予定時刻より前＝再武装を抑止する枝になる
const FAR_FUTURE_RESETS_AT_MS = 4_102_444_800_000;
const SPEND_LIMIT = "You've hit your individual spend limit for this account.";

class Clock {
  n = 0;
  #live = true;
  start(): void {
    void (async () => {
      for (let i = 0; i < 200_000 && this.#live; i += 1) {
        this.n += 1;
        await Promise.resolve();
      }
    })();
  }
  stop(): void {
    this.#live = false;
  }
}

interface Tools {
  readonly clone: CloneHost;
  readonly stores: Stores;
  readonly calls: FakeCall[];
  /** 以降の印を新しい区間へ書き、周回数を 0 から数え直す */
  segment(name: string): void;
  post(event: InboxEvent): void;
  until(predicate: () => boolean, label: string): Promise<void>;
  /** 後続の書き込みが済むまで microtask だけを流す */
  settle(): Promise<void>;
  events(): readonly ChatStreamEvent[];
}

interface DriveInput {
  readonly sdk: Parameters<typeof fakeSdk>[1];
  readonly script: (tools: Tools) => Promise<void>;
  readonly sameKey?: boolean;
  /** 起動前に購読して、受けた event から合図を足す（窓の中で post するため） */
  readonly onEvent?: (event: ChatStreamEvent, post: (event: InboxEvent) => void) => void;
}

const KNOWN_LABELS = ['一件目', '二件目', '三件目', 'internal-1', 'internal-2'] as const;

async function drive(input: DriveInput) {
  const clock = new Clock();
  let base = 0;
  const segments: Record<string, string[]> = {};
  let current: string[] = [];
  // 窓の先は記さない: 窓の先は蒸留など後ろの書き込みで、時計を止めた後に走る分が同じ周回数に潰れて載り、意味のある位置にならないため
  const WINDOW = 150;
  const mark = (label: string) => {
    const at = clock.n - base;
    if (at > WINDOW) return;
    current.push(`${label} @+${String(at)}`);
  };

  const { fn, calls } = fakeSdk(undefined, input.sdk);
  const wrapped = fn as unknown as typeof sdkQuery;

  const stores = createMemoryStores();
  const append = stores.journal.append.bind(stores.journal);
  stores.journal.append = async (entry) => {
    if (entry.type === 'exchange') {
      mark(
        `journal(${entry.with}/${entry.role}${
          'conversationId' in entry && entry.conversationId !== undefined ? '/conv' : ''
        }) ${entry.text.slice(0, 22)}`,
      );
    }
    return append(entry);
  };
  const remove = stores.inbox.remove.bind(stores.inbox);
  stores.inbox.remove = async (id) => {
    mark(`inbox.remove(${id})`);
    return remove(id);
  };

  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn: wrapped,
    env: {},
    ...(input.sameKey === false
      ? {}
      : { tokenIdentity: () => ({ tokenId: 'tok-a', generation: 1 }) }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });

  const sink = createEventSink();
  clone.subscribe('conv-1', (event) => {
    if (event.type === 'usage_limited') mark('emit(usage_limited)');
    if (event.type === 'error') mark(`emit(error kind=${event.kind ?? '-'})`);
    if (event.type === 'done') mark('emit(done)');
    sink.push(event);
    input.onEvent?.(event, (posted) => clone.post(posted));
  });

  const until = async (predicate: () => boolean, label: string) => {
    for (let i = 0; i < 50_000; i += 1) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error(`until: ${label}`);
  };
  const settle = async () => {
    for (let i = 0; i < 300; i += 1) await Promise.resolve();
  };

  clock.start();
  await input.script({
    clone,
    stores,
    calls,
    segment: (name) => {
      current = [];
      segments[name] = current;
      base = clock.n;
    },
    post: (event) => clone.post(event),
    until,
    settle,
    events: () => sink.events,
  });
  clock.stop();

  const pending = await stores.inbox.claimPending();
  const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
    with: string;
    text: string;
  }[];
  const inputs = (calls[0]?.inputs ?? []).map((text) =>
    KNOWN_LABELS.filter((label) => withoutQueueNotice(text).includes(label)).join('+'),
  );
  const out = {
    segments,
    inputs,
    pendingIds: pending.map((p) => p.event.id),
    usageBlocked: clone.usageBlocked,
    usageReleasePending: clone.usageReleasePending,
    // `journal.list` は新しい順で返すので、起きた順に読めるよう反転する
    releaseLines: exchanges
      .filter((e) => e.text.includes('枠の解除を試す'))
      .map((e) => e.text)
      .reverse(),
    // 解除の `#graves.retryFor('枠の保持を解いた')` が墓標を見つけたときに書く判断の行（起きた順）
    graveRetryDecisions: (await stores.journal.list({ types: ['decision'] }))
      .flatMap((r) => (r.type === 'decision' ? [r.decision] : []))
      .filter((d) => d.includes('墓標の拾い直しを、契機'))
      .reverse(),
    internalFailureLines: exchanges.filter(
      (e) => e.with === 'self' && e.text.includes('内部ターンが失敗した'),
    ).length,
    humanFailureLines: exchanges.filter((e) => e.text.includes('いま利用上限に当たっている'))
      .length,
    sessions: calls.length,
  };
  await clone.stop();
  return out;
}

function internalSignal(id: string): InboxEvent {
  return { type: 'external', id, at: '2026-01-01T00:00:00.000Z', source: `test-${id}` };
}

function reopenedBy(id: string, tokenId: string): InboxEvent {
  return {
    type: 'external',
    id,
    at: '2026-01-01T00:00:00.000Z',
    source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    payload: { text: 'ダミー本文', tokenId, observedRecovery: true },
  };
}

const human = (label: string): InboxEvent => ({
  ...humanMessage(label, 'conv-1'),
  id: `evt-${label}`,
});

/** 回復予定時刻が先の枠に当たり続ける（同じ鍵のままなら、どの合図でも再武装しない） */
const cooldownSdk: Parameters<typeof fakeSdk>[1] = {
  resultSubtype: 'error_during_execution',
  resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
  rateLimitEventAt: () => ({
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: FAR_FUTURE_RESETS_AT_MS,
  }),
};

describe('短絡ブロック（#usageBlocked が立っている間）', () => {
  it('人間の会話の合図: usage_limited → error の順で届き、失敗の日誌行が書かれ、合図は消されずに未読で残る', async () => {
    const out = await drive({
      sdk: cooldownSdk,
      script: async (t) => {
        t.post(human('一件目'));
        await t.until(() => t.events().some((e) => e.type === 'error'), '1本目の error');
        await t.settle();
        t.segment('shortcircuit-human');
        t.post(human('二件目'));
        await t.until(
          () => t.events().filter((e) => e.type === 'error').length === 2,
          '2本目の error',
        );
        await t.settle();
      },
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "graveRetryDecisions": [],
        "humanFailureLines": 2,
        "inputs": [
          "一件目",
        ],
        "internalFailureLines": 0,
        "pendingIds": [
          "evt-一件目",
          "evt-二件目",
        ],
        "releaseLines": [],
        "segments": {
          "shortcircuit-human": [
            "journal(human/inbound/conv) 二件目 @+1",
            "emit(usage_limited) @+4",
            "emit(error kind=quota) @+4",
            "journal(self/outbound/conv) [障害] 人間との対話ターンが失敗した: 枠 @+5",
            "journal(human/outbound/conv) いま利用上限に当たっているので、この発言には @+9",
          ],
        },
        "sessions": 1,
        "usageBlocked": true,
        "usageReleasePending": false,
      }
    `);
  });

  it('続けて来た2件の短絡: 2件目の emit の周回数が、1件目の後始末（await）の長さを写す', async () => {
    const out = await drive({
      sdk: cooldownSdk,
      script: async (t) => {
        t.post(human('一件目'));
        await t.until(() => t.events().some((e) => e.type === 'error'), '1本目の error');
        await t.settle();
        t.segment('shortcircuit-two');
        t.post(internalSignal('internal-1'));
        t.post(human('二件目'));
        t.post(internalSignal('internal-2'));
        t.post(human('三件目'));
        await t.until(
          () => t.events().filter((e) => e.type === 'error').length === 3,
          '短絡の error が2本',
        );
        await t.settle();
      },
    });
    expect(out.segments).toMatchInlineSnapshot(`
      {
        "shortcircuit-two": [
          "journal(human/inbound/conv) 二件目 @+1",
          "emit(usage_limited) @+8",
          "emit(error kind=quota) @+8",
          "journal(human/inbound/conv) 三件目 @+8",
          "journal(self/outbound/conv) [障害] 人間との対話ターンが失敗した: 枠 @+9",
          "journal(human/outbound/conv) いま利用上限に当たっているので、この発言には @+13",
          "emit(usage_limited) @+22",
          "emit(error kind=quota) @+22",
          "journal(self/outbound/conv) [障害] 人間との対話ターンが失敗した: 枠 @+23",
          "journal(self/outbound/conv) [間引き] 人間へ返す1行は畳んだ（最後に返 @+27",
        ],
      }
    `);
  });

  it('内部の合図: #reportFailure を呼ばない（error は届かず、失敗の日誌行も増えない）。件数だけが積まれ、合図は未読で残る', async () => {
    const out = await drive({
      sdk: cooldownSdk,
      script: async (t) => {
        t.post(human('一件目'));
        await t.until(() => t.events().some((e) => e.type === 'error'), '1本目の error');
        await t.settle();
        t.segment('shortcircuit-internal');
        t.post(internalSignal('internal-1'));
        await t.settle();
      },
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "graveRetryDecisions": [],
        "humanFailureLines": 1,
        "inputs": [
          "一件目",
        ],
        "internalFailureLines": 0,
        "pendingIds": [
          "internal-1",
          "evt-一件目",
        ],
        "releaseLines": [],
        "segments": {
          "shortcircuit-internal": [],
        },
        "sessions": 1,
        "usageBlocked": true,
        "usageReleasePending": false,
      }
    `);
  });
});

describe('解除ブロック（#releaseRequested が立っているとき）', () => {
  it('解除: 日誌の1行（件数0・suffix なし）→ held が先・event が後で配り直され、解除の回では usage_limited も error も出ない', async () => {
    const out = await drive({
      sdk: {
        resultFor: (turnIndex) =>
          turnIndex < 1 ? { subtype: 'error_during_execution', text: SPEND_LIMIT } : undefined,
      },
      script: async (t) => {
        t.post(human('一件目'));
        await t.until(() => t.events().some((e) => e.type === 'error'), '1本目の error');
        await t.settle();
        t.segment('release');
        t.post(human('二件目'));
        await t.until(
          () => t.events().filter((e) => e.type === 'done').length === 2,
          '2本ぶんの done',
        );
        await t.settle();
      },
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "graveRetryDecisions": [],
        "humanFailureLines": 1,
        "inputs": [
          "一件目",
          "一件目",
          "二件目",
        ],
        "internalFailureLines": 0,
        "pendingIds": [],
        "releaseLines": [
          "[間引き] 枠の解除を試す。新しい合図が届いたので、保持していた 1 件を配り直す。",
        ],
        "segments": {
          "release": [
            "journal(human/inbound/conv) 二件目 @+1",
            "journal(self/outbound) [間引き] 枠の解除を試す。新しい合図が届い @+4",
            "journal(human/outbound/conv) わかった @+99",
            "emit(done) @+117",
            "inbox.remove(evt-一件目) @+123",
          ],
        },
        "sessions": 1,
        "usageBlocked": false,
        "usageReleasePending": false,
      }
    `);
  });

  it('解除の1行: 抑止した再武装と畳んだ内部の失敗の件数が出て、解除のたびに0へ戻る（次の行へ持ち越さない）', async () => {
    const out = await drive({
      sdk: {
        // 0本目（人間）と、解除後の最初の再試行（1本目）だけ枠に当たる。その後は通る
        resultFor: (turnIndex) =>
          turnIndex < 2
            ? { subtype: 'error_during_execution', text: '（結果なし）' }
            : { subtype: 'success' },
        rateLimitEventAt: (turnIndex) =>
          turnIndex < 2
            ? { status: 'rejected', rateLimitType: 'five_hour', resetsAt: FAR_FUTURE_RESETS_AT_MS }
            : undefined,
      },
      script: async (t) => {
        t.post(human('一件目'));
        await t.until(() => t.clone.usageBlocked, '枠に当たる');
        await t.settle();
        t.post(internalSignal('internal-1'));
        await t.settle();
        t.post(internalSignal('internal-2'));
        await t.settle();
        t.segment('release-1');
        t.post(reopenedBy('evt-reopened-1', 'tok-b'));
        await t.until(
          () => t.clone.usageBlocked && t.calls[0] !== undefined && t.calls[0].inputs.length >= 2,
          '解除して再試行がまた枠に当たる',
        );
        await t.settle();
        t.segment('release-2');
        t.post(reopenedBy('evt-reopened-2', 'tok-b'));
        await t.until(() => !t.clone.usageBlocked, '2回目の解除で枠が降りる');
        await t.settle();
      },
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "graveRetryDecisions": [],
        "humanFailureLines": 2,
        "inputs": [
          "一件目",
          "一件目",
          "一件目",
          "internal-1",
        ],
        "internalFailureLines": 0,
        "pendingIds": [
          "internal-2",
          "evt-reopened-1",
        ],
        "releaseLines": [
          "[間引き] 枠の解除を試す。新しい合図が届いたので、保持していた 3 件を配り直す。 回復予定時刻より前だったので再武装を抑止: 2 回。 人間が待っていない内部の失敗記録を畳んだ: 2 件。（件数・回数は、この枠の区間でこのプロセスが数えた分だけ。器の入れ替えを跨いだ分と、ターンの成功で枠が降りた回の分は数えずに0へ戻るので、実際より少ない＝下限。）",
          "[間引き] 枠の解除を試す。新しい合図が届いたので、保持していた 4 件を配り直す。 人間が待っていない内部の失敗記録を畳んだ: 3 件。（件数・回数は、この枠の区間でこのプロセスが数えた分だけ。器の入れ替えを跨いだ分と、ターンの成功で枠が降りた回の分は数えずに0へ戻るので、実際より少ない＝下限。）",
        ],
        "segments": {
          "release-1": [
            "journal(self/outbound) [間引き] 枠の解除を試す。新しい合図が届い @+4",
            "emit(usage_limited) @+78",
            "journal(human/outbound/conv) （このターンは失敗して終わった。以下は失敗す @+106",
            "emit(error kind=quota) @+112",
            "journal(self/outbound/conv) [障害] 人間との対話ターンが失敗した: 結 @+113",
            "journal(self/outbound/conv) [間引き] 人間へ返す1行は畳んだ（最後に返 @+117",
          ],
          "release-2": [
            "journal(self/outbound) [間引き] alteroid 自身が合成した @+0",
            "journal(self/outbound) [間引き] 枠の解除を試す。新しい合図が届い @+4",
            "journal(human/outbound/conv) わかった @+99",
            "emit(done) @+117",
            "inbox.remove(evt-一件目) @+123",
          ],
        },
        "sessions": 1,
        "usageBlocked": false,
        "usageReleasePending": false,
      }
    `);
  });

  it('解除は墓標の拾い直しを「枠の保持を解いた」契機で起こし直す', async () => {
    const out = await drive({
      sdk: {
        resultFor: (turnIndex) =>
          turnIndex < 1 ? { subtype: 'error_during_execution', text: SPEND_LIMIT } : undefined,
      },
      script: async (t) => {
        t.post(human('一件目'));
        await t.until(() => t.events().some((e) => e.type === 'error'), '1本目の error');
        await t.settle();
        // 起動時の拾い直しが済んだ後に墓標を立てる（起動時の拾い直しに消されない）。本文の無い退避の印で、拾い直しは「見つからない」として印を下ろす
        await t.stores.sessions.addTranscriptGrave({ archiveId: 'archive-missing' });
        await t.settle();
        expect(await t.stores.sessions.listTranscriptGraves()).toHaveLength(1);
        t.post(human('二件目'));
        await t.until(
          () => t.events().filter((e) => e.type === 'done').length === 2,
          '2本ぶんの done',
        );
        await t.settle();
        expect(await t.stores.sessions.listTranscriptGraves()).toHaveLength(0);
      },
    });
    expect(out.graveRetryDecisions).toMatchInlineSnapshot(`
      [
        "墓標の拾い直しを、契機（枠の保持を解いた）で起こし直した",
      ]
    `);
  });

  it('印が立っていても枠が既に降りていれば、印だけを戻して素通しする（解除の1行も unshift も無い）', async () => {
    let injected = false;
    const out = await drive({
      sdk: {
        // result は成功のまま、rate_limit_event（rejected）だけが先に枠を立てる（成功の result が枠を降ろす）
        rateLimitEventAt: (turnIndex) =>
          turnIndex === 0 ? { status: 'rejected', rateLimitType: 'five_hour' } : undefined,
      },
      onEvent: (event, post) => {
        // 枠が立った瞬間（usage_limited）に別の合図を足す。resetsAt が無いので `#admit` は印を立てる
        if (event.type !== 'usage_limited' || injected) return;
        injected = true;
        post(human('二件目'));
      },
      script: async (t) => {
        t.segment('stale-release-flag');
        t.post(human('一件目'));
        await t.until(
          () => t.events().filter((e) => e.type === 'done').length === 2,
          '2本ぶんの done',
        );
        await t.settle();
      },
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "graveRetryDecisions": [],
        "humanFailureLines": 0,
        "inputs": [
          "一件目",
          "二件目",
        ],
        "internalFailureLines": 0,
        "pendingIds": [],
        "releaseLines": [],
        "segments": {
          "stale-release-flag": [
            "journal(human/inbound/conv) 一件目 @+1",
            "journal(self/outbound) [計器] 利用上限に当たった。この文言で仕事 @+94",
            "emit(usage_limited) @+98",
            "journal(human/inbound/conv) 二件目 @+100",
            "journal(human/outbound/conv) わかった @+126",
            "emit(done) @+144",
            "inbox.remove(evt-一件目) @+150",
          ],
        },
        "sessions": 1,
        "usageBlocked": false,
        "usageReleasePending": false,
      }
    `);
  });
});

describe('microtask の周回数（await の位置）', () => {
  // 上の各シナリオの `@+N` は、区間の始め（`post` の直前）からの `await Promise.resolve()` の数。
  // 位置そのものの歯は上の snapshot が持つ。ここは「同じ駆動を2回走らせて同じ周回数になる」ことだけを見る（周回数が実行ごとに揺れていないこと）
  it('同じ駆動は同じ周回数になる（短絡・解除）', async () => {
    const run = async () => {
      const out = await drive({
        sdk: {
          resultFor: (turnIndex) =>
            turnIndex < 1 ? { subtype: 'error_during_execution', text: SPEND_LIMIT } : undefined,
        },
        script: async (t) => {
          t.post(human('一件目'));
          await t.until(() => t.events().some((e) => e.type === 'error'), '1本目の error');
          await t.settle();
          t.segment('release');
          t.post(human('二件目'));
          await t.until(
            () => t.events().filter((e) => e.type === 'done').length === 2,
            '2本ぶんの done',
          );
          await t.settle();
        },
      });
      return out.segments;
    };
    expect(await run()).toEqual(await run());
  });
});
