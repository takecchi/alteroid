import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createEventSink, fakeSdk, waitForTerminal } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import type { UsageLimitNotice } from './usage-limits.js';

// `Clone#noteThrownUsageFailure`（例外で届いた失敗を、枠切れの通知として `#noteUsageNotice` へ渡す入口）を、外から固定する。
// 期待の値・文面は仕様を先に書いたものではなく、今の作りの出力を `vitest run <path> -u` で生成して目で読んで確かめた値である。
// 「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。本番コードは変えない。
// 呼び出しを1か所へ寄せる切り出し（`quotaNoticeOfError`）の前に置いた。
// 既存の試験は枠の印が立つか・立たないか（`clone-thrown-usage-limit` の 429 と 500）しか見ない。
// ここが足すのは、縛っていない枝: 分類の3分岐（classify が reached・reached でなく 429・どちらでもない）と、
// 後ろ2つの文が `String(error)` と `reasonOf(error)` のどちらか、`#usageBlocked` が立っている間の素通し、
// 渡る conversationId と source（`'text'`: 回し手への観測と、積んだ入力の畳みが働く）、microtask の周回数。
// 駆動は本物の `Clone` に、例外を投げる偽の `queryFn` を繋ぐ（`#read` の `catch` → `#reportFailure` → `#noteThrownUsageFailure`）。
// microtask は `await Promise.resolve()` を数える歯（実時間は使わない）。

const REACHED = "You've hit your limit · resets 3pm";
const TRANSITION = "You're now using extra usage";
const WARNING = "You've used 90% of your limit";
const ORG_POLICY = 'This service is disabled for your org';
const RATE_429 = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}';

type Thrown = unknown;

interface Drive {
  readonly thrown: Thrown;
  /** 例外の前に `rate_limit_event`（rejected）を流し、`#usageBlocked` を先に立てる */
  readonly blockedBefore?: boolean;
  readonly conversationId?: string;
  /** 本文の長さ。畳みの閾値（200,000字）の手前・先を作る */
  readonly bodyLength?: number;
}

class Clock {
  n = 0;
  #live = true;
  start(): void {
    void (async () => {
      for (let i = 0; i < 2000 && this.#live; i += 1) {
        this.n += 1;
        await Promise.resolve();
      }
    })();
  }
  stop(): void {
    this.#live = false;
  }
}

async function drive(input: Drive) {
  const clock = new Clock();
  let base = 0;
  const timed: string[] = [];
  const mark = (label: string) => timed.push(`${label} @+${String(clock.n - base)}`);
  const conversationId = input.conversationId ?? 'conv-1';
  const thrown = input.thrown;

  const queryFn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<unknown>) {
        void message;
        if (input.blockedBefore === true) {
          yield {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
            session_id: 'sess-fake',
            uuid: 'uuid-ratelimit',
          } as unknown as SDKMessage;
        }
        base = clock.n;
        timed.length = 0;
        throw thrown;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  const stores = createMemoryStores();
  const append = stores.journal.append.bind(stores.journal);
  stores.journal.append = async (entry) => {
    if (entry.type === 'exchange' && entry.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX)) {
      mark('journal.append(gauge)');
    }
    return append(entry);
  };

  const observed: { notice: UsageLimitNotice; hasIdentity: boolean }[] = [];
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn,
    env: {},
    tokenIdentity: () => ({ tokenId: 'key-A', generation: 1 }),
    onUsageObservation: async (observation) => {
      if (observation.notice === undefined) return;
      mark('observe.enter');
      observed.push({
        notice: observation.notice,
        hasIdentity: observation.observedBy !== undefined,
      });
      await Promise.resolve();
      mark('observe.exit');
    },
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });

  const sinks = new Map<string, ChatStreamEvent[]>();
  for (const id of ['conv-1', 'conv-2']) {
    const sink = createEventSink();
    sinks.set(id, sink.events);
    clone.subscribe(id, (event) => {
      if (event.type === 'usage_limited') mark(`emit(${id}: usage_limited)`);
      if (event.type === 'error') mark(`emit(${id}: error)`);
      sink.push(event);
    });
  }

  clock.start();
  const text = input.bodyLength === undefined ? 'やあ' : 'x'.repeat(input.bodyLength);
  clone.post({ ...humanMessage(text, conversationId), id: 'evt-pin' });
  await waitForTerminal(sinks.get(conversationId)!);
  // 終端の後に続く書き込み（畳み・日誌）が済むまで、microtask だけを流す
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
  clock.stop();

  const exchanges = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
  const result = {
    usageBlocked: clone.usageBlocked,
    usageLimited: [...sinks].flatMap(([id, events]) =>
      events.flatMap((event) =>
        event.type === 'usage_limited' ? [`${id}: ${event.message}`] : [],
      ),
    ),
    errors: [...sinks].flatMap(([id, events]) =>
      events.flatMap((event) => (event.type === 'error' ? [`${id}: ${event.message}`] : [])),
    ),
    gauges: exchanges
      .map((entry) => entry.text)
      .filter((line) => line.startsWith(EXCHANGE_KIND_GAUGE_PREFIX))
      .map((line) => line.slice(EXCHANGE_KIND_GAUGE_PREFIX.length)),
    observed: observed.map(
      (o) => `${o.notice.kind}: ${o.notice.text} (identity=${String(o.hasIdentity)})`,
    ),
    folded: exchanges.filter(
      (entry) =>
        entry.text.startsWith(EXCHANGE_KIND_DECISION_PREFIX) && entry.text.includes('Issue #1240'),
    ).length,
    resumeKept: (await stores.sessions.getCloneSessionId()) !== null,
  };
  await clone.stop();
  return { result, timed };
}

const secretParams = 'params: sk-live-SECRET-VALUE';

describe('例外で届いた失敗の分類（#noteThrownUsageFailure）', () => {
  const thrownCases: { name: string; thrown: Thrown }[] = [
    {
      name: 'reached の文言の Error（classify の枝。text は String(error)）',
      thrown: new Error(REACHED),
    },
    {
      name: 'reached の文言 + cause（classify の枝が先。cause は text に載らない）',
      thrown: new Error(REACHED, { cause: new Error('下の理由') }),
    },
    {
      name: 'reached の文言 + 2行目に値（classify の枝: text は String(error) のまま全文）',
      thrown: new Error(`${REACHED}\n${secretParams}`),
    },
    {
      name: '429 の Error（isRateLimitReason の枝。text は reasonOf(error)）',
      thrown: new Error(RATE_429),
    },
    {
      name: '429 + cause: reasonOf は cause を `<-` で連ねる（String(error) では出ない）',
      thrown: new Error(RATE_429, { cause: new Error('下の理由') }),
    },
    {
      name: '429 + 2行目に値: reasonOf は1行目だけ（値を日誌・usage_limited に載せない）',
      thrown: new Error(`${RATE_429}\n${secretParams}`),
    },
    {
      name: '429 の文言が2行目にある文字列（Error でない）: reasonOf は1行目だけ',
      thrown: `途中の1行目\n${RATE_429}\n${secretParams}`,
    },
    { name: 'Error でない文字列（reached の文言）', thrown: REACHED },
    {
      name: 'transition の文言 + 429: classify は reached でないので 429 の枝',
      thrown: new Error(`${TRANSITION} API Error: 429`),
    },
    { name: 'transition だけ: 何も立てない', thrown: new Error(TRANSITION) },
    { name: 'warning だけ: 何も立てない', thrown: new Error(WARNING) },
    { name: 'org_policy だけ: 何も立てない', thrown: new Error(ORG_POLICY) },
    { name: '関係の無い Error: 何も立てない', thrown: new Error('network down') },
    { name: 'Error でない文字列（関係なし）: 何も立てない', thrown: 'plain string' },
    {
      name: '500 の Error: 何も立てない',
      thrown: new Error('API Error: 500 {"type":"api_error"}'),
    },
  ];

  it('classify が reached ならその文をそのまま、そうでなく 429 なら reasonOf を通した文で、どちらでもなければ何も起こさない', async () => {
    const out: Record<string, unknown> = {};
    for (const { name, thrown } of thrownCases) {
      const { result } = await drive({ thrown });
      out[name] = result;
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "429 + 2行目に値: reasonOf は1行目だけ（値を日誌・usage_limited に載せない）": {
          "errors": [
            "conv-1: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
          ],
          "observed": [
            "reached: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
          ],
        },
        "429 + cause: reasonOf は cause を \`<-\` で連ねる（String(error) では出ない）": {
          "errors": [
            "conv-1: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} <- Error: 下の理由",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} <- Error: 下の理由",
          ],
          "observed": [
            "reached: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} <- Error: 下の理由 (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} <- Error: 下の理由",
          ],
        },
        "429 の Error（isRateLimitReason の枝。text は reasonOf(error)）": {
          "errors": [
            "conv-1: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
          ],
          "observed": [
            "reached: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}} (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
          ],
        },
        "429 の文言が2行目にある文字列（Error でない）: reasonOf は1行目だけ": {
          "errors": [
            "conv-1: 途中の1行目",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: 途中の1行目",
          ],
          "observed": [
            "reached: 途中の1行目 (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: 途中の1行目",
          ],
        },
        "500 の Error: 何も立てない": {
          "errors": [
            "conv-1: Error: API Error: 500 {"type":"api_error"}",
          ],
          "folded": 0,
          "gauges": [],
          "observed": [],
          "resumeKept": true,
          "usageBlocked": false,
          "usageLimited": [],
        },
        "Error でない文字列（reached の文言）": {
          "errors": [
            "conv-1: You've hit your limit · resets 3pm",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: You've hit your limit · resets 3pm",
          ],
          "observed": [
            "reached: You've hit your limit · resets 3pm (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: You've hit your limit · resets 3pm",
          ],
        },
        "Error でない文字列（関係なし）: 何も立てない": {
          "errors": [
            "conv-1: plain string",
          ],
          "folded": 0,
          "gauges": [],
          "observed": [],
          "resumeKept": true,
          "usageBlocked": false,
          "usageLimited": [],
        },
        "org_policy だけ: 何も立てない": {
          "errors": [
            "conv-1: Error: This service is disabled for your org",
          ],
          "folded": 0,
          "gauges": [],
          "observed": [],
          "resumeKept": true,
          "usageBlocked": false,
          "usageLimited": [],
        },
        "reached の文言 + 2行目に値（classify の枝: text は String(error) のまま全文）": {
          "errors": [
            "conv-1: Error: You've hit your limit · resets 3pm",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: You've hit your limit · resets 3pm
      params: sk-live-SECRET-VALUE",
          ],
          "observed": [
            "reached: Error: You've hit your limit · resets 3pm
      params: sk-live-SECRET-VALUE (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: You've hit your limit · resets 3pm
      params: sk-live-SECRET-VALUE",
          ],
        },
        "reached の文言 + cause（classify の枝が先。cause は text に載らない）": {
          "errors": [
            "conv-1: Error: You've hit your limit · resets 3pm <- Error: 下の理由",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: You've hit your limit · resets 3pm",
          ],
          "observed": [
            "reached: Error: You've hit your limit · resets 3pm (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: You've hit your limit · resets 3pm",
          ],
        },
        "reached の文言の Error（classify の枝。text は String(error)）": {
          "errors": [
            "conv-1: Error: You've hit your limit · resets 3pm",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: You've hit your limit · resets 3pm",
          ],
          "observed": [
            "reached: Error: You've hit your limit · resets 3pm (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: You've hit your limit · resets 3pm",
          ],
        },
        "transition だけ: 何も立てない": {
          "errors": [
            "conv-1: Error: You're now using extra usage",
          ],
          "folded": 0,
          "gauges": [],
          "observed": [],
          "resumeKept": true,
          "usageBlocked": false,
          "usageLimited": [],
        },
        "transition の文言 + 429: classify は reached でないので 429 の枝": {
          "errors": [
            "conv-1: Error: You're now using extra usage API Error: 429",
          ],
          "folded": 0,
          "gauges": [
            "利用上限に当たった。この文言で仕事が止まっている: Error: You're now using extra usage API Error: 429",
          ],
          "observed": [
            "reached: Error: You're now using extra usage API Error: 429 (identity=true)",
          ],
          "resumeKept": true,
          "usageBlocked": true,
          "usageLimited": [
            "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: You're now using extra usage API Error: 429",
          ],
        },
        "warning だけ: 何も立てない": {
          "errors": [
            "conv-1: Error: You've used 90% of your limit",
          ],
          "folded": 0,
          "gauges": [],
          "observed": [],
          "resumeKept": true,
          "usageBlocked": false,
          "usageLimited": [],
        },
        "関係の無い Error: 何も立てない": {
          "errors": [
            "conv-1: Error: network down",
          ],
          "folded": 0,
          "gauges": [],
          "observed": [],
          "resumeKept": true,
          "usageBlocked": false,
          "usageLimited": [],
        },
      }
    `);
  });

  // 注意: classify が reached の枝は `String(error)` の全文を載せるので、2行目の値が日誌・usage_limited・観測へ載る（`true`）。
  // 今の出力をそのまま固定したもので、望ましい姿とは限らない（`reasonOf` を通すのは 429 の枝だけ）
  it('日誌・usage_limited・観測に値を運ぶ 2行目が載るのは、classify の枝（全文）だけ。429 の枝（reasonOf）では載らない', async () => {
    const leaks: Record<string, boolean> = {};
    for (const { name, thrown } of thrownCases) {
      const { result } = await drive({ thrown });
      const carried = [...result.usageLimited, ...result.gauges, ...result.observed].join('\n');
      leaks[name] = carried.includes('SECRET-VALUE');
    }
    expect(leaks).toMatchInlineSnapshot(`
      {
        "429 + 2行目に値: reasonOf は1行目だけ（値を日誌・usage_limited に載せない）": false,
        "429 + cause: reasonOf は cause を \`<-\` で連ねる（String(error) では出ない）": false,
        "429 の Error（isRateLimitReason の枝。text は reasonOf(error)）": false,
        "429 の文言が2行目にある文字列（Error でない）: reasonOf は1行目だけ": false,
        "500 の Error: 何も立てない": false,
        "Error でない文字列（reached の文言）": false,
        "Error でない文字列（関係なし）: 何も立てない": false,
        "org_policy だけ: 何も立てない": false,
        "reached の文言 + 2行目に値（classify の枝: text は String(error) のまま全文）": true,
        "reached の文言 + cause（classify の枝が先。cause は text に載らない）": false,
        "reached の文言の Error（classify の枝。text は String(error)）": false,
        "transition だけ: 何も立てない": false,
        "transition の文言 + 429: classify は reached でないので 429 の枝": false,
        "warning だけ: 何も立てない": false,
        "関係の無い Error: 何も立てない": false,
      }
    `);
  });
});

describe('#usageBlocked が既に立っている間は何もしない', () => {
  it('rate_limit_event で先に立てた後に 429 が投げられても、日誌・観測・usage_limited は増えない', async () => {
    const { result } = await drive({ thrown: new Error(RATE_429), blockedBefore: true });
    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [
          "conv-1: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
        ],
        "folded": 0,
        "gauges": [
          "利用上限に当たった。この文言で仕事が止まっている: rate_limit_event: status=rejected（kind: five_hour）",
        ],
        "observed": [],
        "resumeKept": true,
        "usageBlocked": true,
        "usageLimited": [
          "conv-1: 利用上限に当たった。この文言で仕事が止まっている: rate_limit_event: status=rejected（kind: five_hour）",
        ],
      }
    `);
  });

  it('対照: 先に立っていなければ同じ 429 で1件ずつ増える（観測は text の分の1件）', async () => {
    const { result } = await drive({ thrown: new Error(RATE_429) });
    expect(result.usageLimited).toHaveLength(1);
    expect(result.observed).toHaveLength(1);
  });

  it('先に立っているとき reached の文言でも同じ（classify の結果に関わらず何も渡さない）', async () => {
    const { result } = await drive({ thrown: new Error(REACHED), blockedBefore: true });
    expect(result.observed).toEqual([]);
    expect(result.usageLimited).toHaveLength(1);
    expect(result.gauges).toHaveLength(1);
  });
});

describe('渡る conversationId と source', () => {
  it('usage_limited は投げられたターンの会話にだけ届く（別の会話へは出ない）', async () => {
    const one = await drive({ thrown: new Error(RATE_429), conversationId: 'conv-1' });
    const two = await drive({ thrown: new Error(RATE_429), conversationId: 'conv-2' });
    expect({ one: one.result.usageLimited, two: two.result.usageLimited }).toMatchInlineSnapshot(`
      {
        "one": [
          "conv-1: 利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
        ],
        "two": [
          "conv-2: 利用上限に当たった。この文言で仕事が止まっている: Error: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}",
        ],
      }
    `);
  });

  it("source は 'text': 観測（回し手へ渡す）が1件上がる", async () => {
    const { result } = await drive({ thrown: new Error(REACHED) });
    expect(result.observed).toMatchInlineSnapshot(`
      [
        "reached: Error: You've hit your limit · resets 3pm (identity=true)",
      ]
    `);
  });

  it("source が 'text' なので、積んだ入力が閾値（200,000字）に達していれば畳む。届かなければ畳まない", async () => {
    const small = await drive({ thrown: new Error(RATE_429), bodyLength: 1000 });
    const big = await drive({ thrown: new Error(RATE_429), bodyLength: 200_100 });
    expect({
      small: { folded: small.result.folded, resumeKept: small.result.resumeKept },
      big: { folded: big.result.folded, resumeKept: big.result.resumeKept },
    }).toMatchInlineSnapshot(`
      {
        "big": {
          "folded": 1,
          "resumeKept": false,
        },
        "small": {
          "folded": 0,
          "resumeKept": true,
        },
      }
    `);
  });
});

describe('microtask の周回数（await の位置）', () => {
  // `@+N` は例外を投げる直前からの microtask の周回数（`await Promise.resolve()` の数）
  it('reached（classify の枝）・429（reasonOf の枝）・何も立てない・先に立っている', async () => {
    const reached = await drive({ thrown: new Error(REACHED) });
    const rate = await drive({ thrown: new Error(RATE_429) });
    const none = await drive({ thrown: new Error('network down') });
    const blocked = await drive({ thrown: new Error(RATE_429), blockedBefore: true });
    expect({
      reached: reached.timed,
      rate: rate.timed,
      none: none.timed,
      blocked: blocked.timed,
    }).toMatchInlineSnapshot(`
      {
        "blocked": [
          "emit(conv-1: error) @+7",
        ],
        "none": [
          "emit(conv-1: error) @+8",
        ],
        "rate": [
          "journal.append(gauge) @+6",
          "observe.enter @+10",
          "observe.exit @+11",
          "emit(conv-1: usage_limited) @+13",
          "emit(conv-1: error) @+16",
        ],
        "reached": [
          "journal.append(gauge) @+6",
          "observe.enter @+10",
          "observe.exit @+11",
          "emit(conv-1: usage_limited) @+13",
          "emit(conv-1: error) @+16",
        ],
      }
    `);
  });
});
