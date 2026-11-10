import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentTurnEnded } from './agent-events.js';
import type { CloneGravePorts } from './clone-graves.js';
import { createClone } from './clone.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';
import type { UsageLimitNotice } from './usage-limits.js';

// `Clone#distillFromTranscript` の後半（蒸留のターンを読むループと、失敗・枠切れを観測へ上げる分岐）を、外から固定する。
// 期待の値・文面は仕様を先に書いたものではなく、今の作りの出力を `vitest run <path> -u` で生成して目で読んで確かめた値である。
// 「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。本番コードは変えない。
// 後半（失敗の分類と観測への引き上げ）を1か所にまとめる切り出しの前に置いた。
// 既存の試験（`clone-grave-pickup-journal-pin`・`clone-grave-retry` など）は結果の文面・拾い直しの回数だけを見る。
// ここが足すのは、縛っていない枝: 観測の呼ばれ方（回数・引数・順序）・候補の優先順・`break` の効き・二重に数えないこと・
// `onQuotaFailure` の時機（観測の `await` より前）と鍵（蒸留を組んだ時点の値）・`catch` の3分岐と元の例外の再送出・microtask の周回数。
// 駆動は `CloneGraves` の口（`ports.distill`）を `vi.mock` で掴んで直に呼ぶ: `onQuotaFailure` を渡せるのは墓標の拾い直しだけで、
// その経路を通すと鍵の控えが `retryFor` の振る舞いに化けて見えるため。蒸留の中身（駆動役の `distill`）は偽の async generator に差し替える。
// microtask は `await Promise.resolve()` を数える歯（実時間は使わない）。

const captured = vi.hoisted(() => ({ ports: [] as unknown[] }));

vi.mock('./clone-graves.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clone-graves.js')>();
  class Capturing extends actual.CloneGraves {
    constructor(ports: CloneGravePorts) {
      super(ports);
      captured.ports.push(ports);
    }
  }
  return { ...actual, CloneGraves: Capturing };
});

const REACHED_1 = "You've hit your limit · resets 3pm";
const REACHED_2 = "You're out of usage credits";
const TRANSITION = "You're now using extra usage";
const WARNING = "You've used 90% of your limit";
const ORG_POLICY = 'This service is disabled for your org';
const RATE_429 = 'API Error: 429 {"type":"rate_limit_error"}';

type DistillOptions = {
  journalInput?: boolean;
  onQuotaFailure?: (tokenKey: string | undefined) => void;
};
type Script = (ctl: Control) => AsyncGenerator<AgentEvent, void>;

interface Control {
  mark(): void;
  log(label: string): void;
  keyRef: { id: string };
}

class Clock {
  n = 0;
  #live = true;
  start(): void {
    void (async () => {
      for (let i = 0; i < 300 && this.#live; i += 1) {
        this.n += 1;
        await Promise.resolve();
      }
    })();
  }
  stop(): void {
    this.#live = false;
  }
}

function usageOf(sessionId: string) {
  return {
    sessionId,
    models: {
      'claude-fable-5': {
        inputTokens: 4,
        outputTokens: 8,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 3,
        webSearchRequests: 0,
        costUsd: 0.25,
      },
    },
  };
}

function ended(
  succeeded: boolean,
  extra: Partial<AgentTurnEnded> = {},
  sessionId = 'sess-distill',
): AgentTurnEnded {
  return {
    type: 'turn_ended',
    succeeded,
    body: '',
    errorLines: [],
    denials: [],
    usage: usageOf(sessionId),
    ...extra,
  };
}

function delta(text: string): AgentEvent {
  return { type: 'text_delta', text };
}

interface Built {
  readonly stores: Stores;
  readonly log: { label: string; tick: number }[];
  readonly observed: UsageLimitNotice[];
  readonly observedBy: unknown[];
  readonly keyRef: { id: string };
  distillCalls(): number;
  run(options?: DistillOptions): Promise<{ resolved: true } | { rejected: unknown }>;
  names(): string[];
  timed(): string[];
}

interface BuildOptions {
  readonly script: Script;
  /** 観測のコールバック（`onUsageObservation`）の中身。既定は何もしない */
  readonly onObserve?: () => void;
  readonly noIdentity?: boolean;
  /** `onQuotaFailure` を渡すか。渡すと、呼ばれた鍵を `log` に残す */
  readonly withQuotaHook?: boolean;
  readonly quotaHookThrows?: Error;
}

function build(options: BuildOptions): Built {
  const stores = createMemoryStores();
  const clock = new Clock();
  const log: { label: string; tick: number }[] = [];
  let base = 0;
  const push = (label: string) => log.push({ label, tick: clock.n - base });
  const keyRef = { id: 'key-A' };
  const observed: UsageLimitNotice[] = [];
  const observedBy: unknown[] = [];
  let distillCalls = 0;

  const record = stores.usage.record.bind(stores.usage);
  stores.usage.record = async (input) => {
    push(`usage.record(${input.site}, ${input.accumulation}, ${input.snapshot.sessionId ?? '-'})`);
    return record(input);
  };
  const append = stores.journal.append.bind(stores.journal);
  stores.journal.append = async (entry) => {
    push(
      entry.type === 'decision'
        ? `journal.append(decision: ${entry.decision})`
        : `journal.append(${entry.type})`,
    );
    return append(entry);
  };

  const ctl: Control = { mark: () => (base = clock.n), log: push, keyRef };
  captured.ports.length = 0;
  createClone({
    stores,
    env: {},
    driver: {
      providerId: 'claude',
      open: () => {
        throw new Error('この試験は本セッションを開かない');
      },
      distill: () => {
        distillCalls += 1;
        return options.script(ctl);
      },
    },
    ...(options.noIdentity === true
      ? {}
      : { tokenIdentity: () => ({ tokenId: keyRef.id, generation: 1 }) }),
    onUsageObservation: async (observation) => {
      push(`observe.enter(${observation.notice?.text ?? '-'})`);
      if (observation.notice !== undefined) observed.push(observation.notice);
      observedBy.push(observation.observedBy);
      await Promise.resolve();
      options.onObserve?.();
      push('observe.exit');
    },
  });
  const ports = captured.ports.at(-1) as {
    distill(tail: string, options?: DistillOptions): Promise<void>;
  };

  return {
    stores,
    log,
    observed,
    observedBy,
    keyRef,
    distillCalls: () => distillCalls,
    names: () => log.map((entry) => entry.label),
    timed: () => log.map((entry) => `${entry.label} @+${String(entry.tick)}`),
    run: async (distillOptions = {}) => {
      const hook =
        options.withQuotaHook === true
          ? {
              onQuotaFailure: (tokenKey: string | undefined) => {
                push(`onQuotaFailure(${String(tokenKey)})`);
                if (options.quotaHookThrows !== undefined) throw options.quotaHookThrows;
              },
            }
          : {};
      clock.start();
      const outcome = await ports
        .distill('TAIL', { journalInput: false, ...hook, ...distillOptions })
        .then(
          () => ({ resolved: true as const }),
          (error: unknown) => ({ rejected: error }),
        );
      push('settled');
      clock.stop();
      return outcome;
    },
  };
}

function messageOf(outcome: { resolved: true } | { rejected: unknown }): string {
  return 'resolved' in outcome ? '(resolved)' : String(outcome.rejected);
}

describe('蒸留のターンの読み方（成功）', () => {
  it('turn_ended 以外は読み飛ばして使用量も数えない。成功は recordUsage を1回・成功の印を日誌へ書いて resolve し、後ろは読まない', async () => {
    const s = build({
      script: async function* (ctl) {
        try {
          yield delta('途中');
          ctl.log('yielded delta');
          yield delta('途中2');
          yield ended(true, {}, 'sess-first');
          ctl.log('RESUMED AFTER FIRST turn_ended');
          yield ended(true, {}, 'sess-second');
        } finally {
          ctl.log('generator closed');
        }
      },
    });
    const outcome = await s.run();
    expect(outcome).toEqual({ resolved: true });
    expect(s.distillCalls()).toBe(1);
    expect(s.names()).toMatchInlineSnapshot(`
      [
        "yielded delta",
        "usage.record(distill, oneshot, sess-first)",
        "journal.append(turn_usage)",
        "journal.append(decision: 蒸留が成功で終わった: reason=pre_compact)",
        "generator closed",
        "settled",
      ]
    `);
    expect(s.observed).toEqual([]);
    expect(await s.stores.journal.list({ types: ['turn_usage'] })).toHaveLength(1);
  });
});

describe('蒸留のターンの読み方（失敗）', () => {
  const scenarios: {
    name: string;
    failure?: string;
    body?: string;
    errorLines?: string[];
  }[] = [
    { name: 'failure.text だけ reached', failure: REACHED_1 },
    { name: 'body だけ reached（failure は無い）', body: REACHED_1 },
    { name: 'errorLines の2本目だけ reached', errorLines: ['x', REACHED_1] },
    {
      name: '3か所すべて reached: 先頭の failure.text だけ',
      failure: REACHED_1,
      body: REACHED_2,
      errorLines: ["You've reached your cap"],
    },
    {
      name: 'failure.text が reached でなく body が reached: body',
      failure: 'boom',
      body: REACHED_2,
    },
    { name: 'body・errorLines が両方 reached: body', body: REACHED_1, errorLines: [REACHED_2] },
    { name: 'errorLines が2本とも reached: 1本目だけ', errorLines: [REACHED_1, REACHED_2] },
    {
      name: 'transition・warning・org_policy は観測しない',
      failure: TRANSITION,
      body: WARNING,
      errorLines: [ORG_POLICY],
    },
    {
      name: 'transition が先・後ろの reached は拾う',
      failure: TRANSITION,
      errorLines: [REACHED_2],
    },
    { name: 'どれも reached でない', failure: 'boom', body: 'ただの失敗', errorLines: ['err'] },
    { name: '429 の文言だけ（classify は reached にしない）: 観測しない', failure: RATE_429 },
    { name: '空の候補は飛ばす', failure: '', body: '   ', errorLines: ['', REACHED_1] },
  ];

  it('候補は failure.text・body・errorLines の順。最初の reached の1件だけを観測して break し、いずれも同じ Error を投げる', async () => {
    const result: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      const s = build({
        script: async function* () {
          yield ended(false, {
            ...(scenario.failure === undefined
              ? {}
              : { failure: { via: 'result_is_error', code: 'x', text: scenario.failure } }),
            body: scenario.body ?? '',
            errorLines: scenario.errorLines ?? [],
          });
        },
      });
      const outcome = await s.run();
      result[scenario.name] = {
        error: messageOf(outcome),
        observed: s.observed.map((n) => `${n.kind}: ${n.text}`),
        recorded: s.names().filter((n) => n.startsWith('usage.record')).length,
      };
    }
    expect(result).toMatchInlineSnapshot(`
      {
        "3か所すべて reached: 先頭の failure.text だけ": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
        "429 の文言だけ（classify は reached にしない）: 観測しない": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [],
          "recorded": 1,
        },
        "body だけ reached（failure は無い）": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
        "body・errorLines が両方 reached: body": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
        "errorLines が2本とも reached: 1本目だけ": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
        "errorLines の2本目だけ reached": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
        "failure.text が reached でなく body が reached: body": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You're out of usage credits",
          ],
          "recorded": 1,
        },
        "failure.text だけ reached": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
        "transition が先・後ろの reached は拾う": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You're out of usage credits",
          ],
          "recorded": 1,
        },
        "transition・warning・org_policy は観測しない": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [],
          "recorded": 1,
        },
        "どれも reached でない": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [],
          "recorded": 1,
        },
        "空の候補は飛ばす": {
          "error": "Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）",
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
          "recorded": 1,
        },
      }
    `);
  });

  it('succeeded: false でも recordUsage は呼ばれ、成功の印は書かれない。観測は1回だけ（catch で二重に数えない）', async () => {
    const s = build({
      script: async function* () {
        yield ended(false, { body: REACHED_1 });
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toBe(
      'Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）',
    );
    expect(s.observed).toHaveLength(1);
    expect(s.names()).toMatchInlineSnapshot(`
      [
        "usage.record(distill, oneshot, sess-distill)",
        "journal.append(turn_usage)",
        "observe.enter(You've hit your limit · resets 3pm)",
        "observe.exit",
        "settled",
      ]
    `);
  });

  it('succeeded: false で body だけが 429 の文言（reached ではない）でも、catch で拾い直さない', async () => {
    const s = build({
      script: async function* () {
        yield ended(false, { body: RATE_429, errorLines: [RATE_429] });
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toBe(
      'Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）',
    );
    expect(s.observed).toEqual([]);
  });
});

describe('観測の呼ばれ方', () => {
  it('onQuotaFailure は観測の await より前に、蒸留を組んだ時点の鍵で1回。観測の identity も組んだ時点の値（その後に鍵が回っても）', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* (ctl) {
        // 蒸留を組んだ後・枠で落ちる前に鍵が回った状態
        ctl.keyRef.id = 'key-B';
        yield ended(false, { failure: { via: 'result_is_error', code: 'x', text: REACHED_1 } });
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toContain('成功で終わらなかった');
    expect(s.names()).toMatchInlineSnapshot(`
      [
        "usage.record(distill, oneshot, sess-distill)",
        "journal.append(turn_usage)",
        "onQuotaFailure(key-A#1)",
        "observe.enter(You've hit your limit · resets 3pm)",
        "observe.exit",
        "settled",
      ]
    `);
    expect(s.observedBy).toMatchInlineSnapshot(`
      [
        {
          "generation": 1,
          "tokenId": "key-A",
        },
      ]
    `);
  });

  it('onQuotaFailure が無くても動く（観測は上がる）', async () => {
    const s = build({
      script: async function* () {
        yield ended(false, { body: REACHED_1 });
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toContain('成功で終わらなかった');
    expect(s.observed.map((n) => n.text)).toEqual([REACHED_1]);
  });

  it('身元が取れないとき: onQuotaFailure は undefined の鍵で呼ばれ、観測は上がらない', async () => {
    const s = build({
      noIdentity: true,
      withQuotaHook: true,
      script: async function* () {
        yield ended(false, { body: REACHED_1 });
      },
    });
    await s.run();
    expect(s.names()).toMatchInlineSnapshot(`
      [
        "usage.record(distill, oneshot, sess-distill)",
        "journal.append(turn_usage)",
        "onQuotaFailure(undefined)",
        "settled",
      ]
    `);
    expect(s.observed).toEqual([]);
  });

  it('枠切れでない失敗・成功では onQuotaFailure を呼ばない', async () => {
    for (const make of [() => ended(false, { body: 'ただの失敗' }), () => ended(true)] as const) {
      const s = build({
        withQuotaHook: true,
        script: async function* () {
          yield make();
        },
      });
      await s.run();
      expect(s.names().filter((n) => n.startsWith('onQuotaFailure'))).toEqual([]);
      expect(s.observed).toEqual([]);
    }
  });

  it('観測のコールバックが投げても、蒸留の失敗は同じ Error のまま（観測の例外は stderr へ落ちる）', async () => {
    const boom = new Error('観測の受け手が落ちた');
    const s = build({
      onObserve: () => {
        throw boom;
      },
      script: async function* () {
        yield ended(false, { body: REACHED_1 });
      },
    });
    let outcome: Awaited<ReturnType<Built['run']>> | undefined;
    const stderr = await captureStderr(async () => {
      outcome = await s.run();
    });
    expect(messageOf(outcome!)).toBe(
      'Error: 蒸留のターンが成功で終わらなかった（枠切れ・実行中の失敗など）',
    );
    expect(stderr.join('')).toContain('認証トークンの切替（蒸留）');
    expect(s.observed).toHaveLength(1);
  });

  it('onQuotaFailure が投げると、その例外が元の Error を置き換える（succeeded: false の枝。catch で分類されても観測は二重にならない）', async () => {
    const hookBoom = new Error('onQuotaFailure が落ちた');
    const s = build({
      withQuotaHook: true,
      quotaHookThrows: hookBoom,
      script: async function* () {
        yield ended(false, { body: REACHED_1 });
      },
    });
    const outcome = await s.run();
    expect('rejected' in outcome && outcome.rejected).toBe(hookBoom);
    expect(s.names().filter((n) => n.startsWith('observe.enter'))).toEqual([]);
  });
});

describe('catch（蒸留の for await が投げる例外）', () => {
  const thrown: { name: string; error: unknown }[] = [
    { name: 'reached の文言の Error', error: new Error(REACHED_1) },
    { name: '429（rate_limit_error）の Error', error: new Error(RATE_429) },
    {
      name: 'reached の文言 + cause: classify の枝が先（text は String(error)）',
      error: new Error(REACHED_2, { cause: new Error('下の理由') }),
    },
    {
      name: '429 + cause: isRateLimitReason の枝（text は reasonOf(error)）',
      error: new Error(RATE_429, { cause: new Error('下の理由') }),
    },
    {
      name: '429 を含む transition の文言: classify は reached でないので isRateLimitReason の枝',
      error: new Error(`${TRANSITION} API Error: 429`),
    },
    { name: 'transition だけ', error: new Error(TRANSITION) },
    { name: 'warning だけ', error: new Error(WARNING) },
    { name: 'org_policy だけ', error: new Error(ORG_POLICY) },
    { name: '関係の無い Error', error: new Error('network down') },
    { name: 'Error でない文字列（reached の文言）', error: REACHED_1 },
    { name: 'Error でない文字列（関係なし）', error: 'plain string' },
  ];

  it('reached なら観測、そうでなく 429 なら reasonOf(error) で観測、どちらでもなければ観測しない。onQuotaFailure は観測する分岐だけ', async () => {
    const result: Record<string, unknown> = {};
    for (const { name, error } of thrown) {
      const s = build({
        withQuotaHook: true,
        script: async function* () {
          yield delta('途中');
          throw error;
        },
      });
      await s.run();
      result[name] = {
        observed: s.observed.map((n) => `${n.kind}: ${n.text}`),
        hook: s.names().filter((n) => n.startsWith('onQuotaFailure')),
      };
    }
    expect(result).toMatchInlineSnapshot(`
      {
        "429 + cause: isRateLimitReason の枝（text は reasonOf(error)）": {
          "hook": [
            "onQuotaFailure(key-A#1)",
          ],
          "observed": [
            "reached: Error: API Error: 429 {"type":"rate_limit_error"} <- Error: 下の理由",
          ],
        },
        "429 を含む transition の文言: classify は reached でないので isRateLimitReason の枝": {
          "hook": [
            "onQuotaFailure(key-A#1)",
          ],
          "observed": [
            "reached: Error: You're now using extra usage API Error: 429",
          ],
        },
        "429（rate_limit_error）の Error": {
          "hook": [
            "onQuotaFailure(key-A#1)",
          ],
          "observed": [
            "reached: Error: API Error: 429 {"type":"rate_limit_error"}",
          ],
        },
        "Error でない文字列（reached の文言）": {
          "hook": [
            "onQuotaFailure(key-A#1)",
          ],
          "observed": [
            "reached: You've hit your limit · resets 3pm",
          ],
        },
        "Error でない文字列（関係なし）": {
          "hook": [],
          "observed": [],
        },
        "org_policy だけ": {
          "hook": [],
          "observed": [],
        },
        "reached の文言 + cause: classify の枝が先（text は String(error)）": {
          "hook": [
            "onQuotaFailure(key-A#1)",
          ],
          "observed": [
            "reached: Error: You're out of usage credits",
          ],
        },
        "reached の文言の Error": {
          "hook": [
            "onQuotaFailure(key-A#1)",
          ],
          "observed": [
            "reached: Error: You've hit your limit · resets 3pm",
          ],
        },
        "transition だけ": {
          "hook": [],
          "observed": [],
        },
        "warning だけ": {
          "hook": [],
          "observed": [],
        },
        "関係の無い Error": {
          "hook": [],
          "observed": [],
        },
      }
    `);
  });

  it('いずれの分岐でも、元の例外は同じ参照のまま再送出される', async () => {
    for (const { name, error } of thrown) {
      const s = build({
        withQuotaHook: true,
        // eslint-disable-next-line require-yield
        script: async function* () {
          throw error;
        },
      });
      const outcome = await s.run();
      expect('rejected' in outcome ? outcome.rejected : undefined, name).toBe(error);
    }
  });

  it('観測のコールバックが投げても、元の例外が同じ参照で出る（観測の例外は置き換えない）', async () => {
    const original = new Error(RATE_429);
    const s = build({
      onObserve: () => {
        throw new Error('観測の受け手が落ちた');
      },
      // eslint-disable-next-line require-yield
      script: async function* () {
        throw original;
      },
    });
    let outcome: Awaited<ReturnType<Built['run']>> | undefined;
    await captureStderr(async () => {
      outcome = await s.run();
    });
    expect('rejected' in outcome! && outcome.rejected).toBe(original);
    expect(s.observed).toHaveLength(1);
  });

  it('onQuotaFailure が投げると、catch の中では元の例外を置き換える', async () => {
    const hookBoom = new Error('onQuotaFailure が落ちた');
    const original = new Error(REACHED_1);
    const s = build({
      withQuotaHook: true,
      quotaHookThrows: hookBoom,
      // eslint-disable-next-line require-yield
      script: async function* () {
        throw original;
      },
    });
    const outcome = await s.run();
    expect('rejected' in outcome && outcome.rejected).toBe(hookBoom);
  });

  it('turn_ended を受ける前に投げた場合: 使用量も成功の印も無く、例外はそのまま出る', async () => {
    const s = build({
      script: async function* () {
        yield delta('途中');
        throw new Error('途中で落ちた');
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toBe('Error: 途中で落ちた');
    expect(s.names()).toMatchInlineSnapshot(`
      [
        "settled",
      ]
    `);
  });
});

describe('turn_ended が来ないまま閉じた', () => {
  it('turn_ended 以外だけで閉じると「終わりを告げないまま閉じた」。観測も成功の印も使用量もない', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* () {
        yield delta(REACHED_1);
        yield delta('2');
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toBe('Error: 蒸留のターンが終わりを告げないまま閉じた');
    expect(s.names()).toMatchInlineSnapshot(`
      [
        "settled",
      ]
    `);
    expect(s.observed).toEqual([]);
  });

  it('何も yield せずに閉じても同じ', async () => {
    const s = build({
      script: async function* () {
        // 何も出さずに閉じる
      },
    });
    const outcome = await s.run();
    expect(messageOf(outcome)).toBe('Error: 蒸留のターンが終わりを告げないまま閉じた');
  });
});

describe('microtask の周回数（await の位置）', () => {
  // `ctl.mark()` は最後の `yield` の直前。`@+N` はそこからの microtask の周回数（`await Promise.resolve()` の数）
  it('成功', async () => {
    const s = build({
      script: async function* (ctl) {
        ctl.mark();
        yield ended(true);
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "usage.record(distill, oneshot, sess-distill) @+2",
        "journal.append(turn_usage) @+5",
        "journal.append(decision: 蒸留が成功で終わった: reason=pre_compact) @+10",
        "settled @+18",
      ]
    `);
  });

  it('succeeded: false の reached（onQuotaFailure あり）', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* (ctl) {
        ctl.mark();
        yield ended(false, { body: REACHED_1 });
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "usage.record(distill, oneshot, sess-distill) @+2",
        "journal.append(turn_usage) @+5",
        "onQuotaFailure(key-A#1) @+10",
        "observe.enter(You've hit your limit · resets 3pm) @+10",
        "observe.exit @+11",
        "settled @+18",
      ]
    `);
  });

  it('succeeded: false で reached でない', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* (ctl) {
        ctl.mark();
        yield ended(false, { body: 'ただの失敗' });
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "usage.record(distill, oneshot, sess-distill) @+2",
        "journal.append(turn_usage) @+5",
        "settled @+14",
      ]
    `);
  });

  it('catch の reached（classify の枝）', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* (ctl) {
        ctl.mark();
        yield delta('x');
        throw new Error(REACHED_1);
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "onQuotaFailure(key-A#1) @+3",
        "observe.enter(Error: You've hit your limit · resets 3pm) @+3",
        "observe.exit @+4",
        "settled @+9",
      ]
    `);
  });

  it('catch の 429（isRateLimitReason の枝）', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* (ctl) {
        ctl.mark();
        yield delta('x');
        throw new Error(RATE_429);
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "onQuotaFailure(key-A#1) @+3",
        "observe.enter(Error: API Error: 429 {"type":"rate_limit_error"}) @+3",
        "observe.exit @+4",
        "settled @+9",
      ]
    `);
  });

  it('catch の関係の無い例外（観測なし）', async () => {
    const s = build({
      withQuotaHook: true,
      script: async function* (ctl) {
        ctl.mark();
        yield delta('x');
        throw new Error('network down');
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "settled @+5",
      ]
    `);
  });

  it('turn_ended 無しで閉じる', async () => {
    const s = build({
      script: async function* (ctl) {
        ctl.mark();
        yield delta('x');
      },
    });
    await s.run();
    expect(s.timed()).toMatchInlineSnapshot(`
      [
        "settled @+5",
      ]
    `);
  });
});
