import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  setStderrSinkForTesting,
  type RunnerClient,
  type RunnerRegistry,
  type TokenCredential,
} from '@alteroid/core';

import { createAgentTokenHolder, createTokenSpread } from './token-spread.js';

// 鍵を撒く処理（`createTokenSpread().spread`）の振る舞いを、場面ごとにコミットした固定値
// （token-spread-behavior-pin.json）と丸ごと比べる。購読と知らせを共通部品（createPushChannel）へ寄せるとき、
// 呼びの並び・返り値・知らせ・stderr が1文字も変わらないことを機械で確かめる歯。
//
// 記録するもの（場面ごと）:
//   - out: `spread` の返り値（投げたときは名前と文言）
//   - events: 偽の runner・名簿・クローンの箱・プロファイルの名前の問い合わせ・`onShadowed`・`onPushed` の購読者への呼びを、
//     呼び始め（`>`）と戻り（`<`）の両方で並べる。各行の頭の数字は「マイクロタスクの世代」: 場面の間ずっと
//     自分を積み直すマイクロタスクを1本回して世代を数える。`spread` の中の await が1段増える・減ると、後ろの呼びの
//     数字が動くので、await の段が固定値に写る。runner を順に撒く（前の runner の戻りの後に次を呼ぶ）ことも、
//     この並びで固定される
//   - stderr: 握って stderr へ出た行の全文（この処理は日誌を持たない）
//
// 固定値の作り直し（意図して振る舞いを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_SPREAD_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/daemon exec vitest run src/token-spread-behavior-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write apps/daemon/src/token-spread-behavior-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の何が動いたかを読む。
//
// 秘密: 値はすべて作りもの（FAKE_…）。json に長い [A-Za-z0-9_./@-] の連続を作らない。

const PIN_URL = new URL('./token-spread-behavior-pin.json', import.meta.url);
// 環境変数の名前に TOKEN を入れない（器によっては名前に TOKEN を含む変数が子へ渡らない）
const UPDATE = process.env.UPDATE_SPREAD_PIN === '1';

const FAKE = 'FAKE_NOT_A_REAL_VALUE';
const TOKEN: { id: string; generation: number } & TokenCredential = {
  id: 'tok-a',
  generation: 2,
  kind: 'stored',
  value: FAKE,
};

interface Ev {
  t: number;
  e: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function show(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined) return '<undefined>';
    if (typeof item === 'function') return '<fn>';
    if (typeof item === 'string' && item.length > 100) return `<str ${String(item.length)} chars>`;
    return item;
  });
  return text ?? 'undefined';
}

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await run() };
  } catch (error) {
    return {
      threw: {
        name: error instanceof Error ? error.name : typeof error,
        message: messageOf(error),
      },
    };
  }
}

class Ctx {
  readonly ev: Ev[] = [];
  tick = 0;

  log(e: string): void {
    this.ev.push({ t: this.tick, e });
  }

  /** 戻り値がいくつかの await を挟んで返る偽の runner。`awaits` 回だけ待ってから `behavior` を実行する */
  runner(id: string, behavior: () => unknown = () => [], awaits = 0): RunnerClient {
    return {
      runnerId: id,
      setCredentials: async (credentials: { name: string; value: string }[]) => {
        this.log(`> ${id}.setCredentials ${show(credentials)}`);
        try {
          for (let i = 0; i < awaits; i += 1) await Promise.resolve();
          const result = behavior();
          this.log(`< ${id}.setCredentials ${show(result)}`);
          return result;
        } catch (error) {
          this.log(`< ${id}.setCredentials threw ${messageOf(error)}`);
          throw error;
        }
      },
    } as unknown as RunnerClient;
  }

  registry(clients: readonly RunnerClient[] | Error): RunnerRegistry {
    return {
      list: async () => {
        this.log('> registry.list');
        if (clients instanceof Error) {
          this.log(`< registry.list threw ${clients.message}`);
          throw clients;
        }
        this.log(`< registry.list ${String(clients.length)} runners`);
        return [...clients];
      },
    } as unknown as RunnerRegistry;
  }

  /** `set`・`clear` の呼びを並べるクローンの箱 */
  clone(): ReturnType<typeof createAgentTokenHolder> {
    const real = createAgentTokenHolder();
    return {
      ...real,
      set: (value, identity) => {
        this.log(`> clone.set ${show([value, identity])}`);
        real.set(value, identity);
        this.log(`< clone.set values=${show(real.values())} identity=${show(real.identity())}`);
      },
    };
  }

  names(label: string, behavior: string[] | Error): () => Promise<string[]> {
    return async () => {
      this.log(`> ${label}`);
      if (behavior instanceof Error) {
        this.log(`< ${label} threw ${behavior.message}`);
        throw behavior;
      }
      this.log(`< ${label} ${show(behavior)}`);
      return behavior;
    };
  }

  onShadowed(): (names: readonly string[], target?: 'runner' | 'clone') => void {
    return (names, target) => {
      this.log(`onShadowed ${show(names)} ${show(target)}`);
    };
  }

  /** 購読者: `throws` なら知らされた直後に投げる */
  listener(label: string, throws = false): (results: readonly unknown[]) => void {
    return (results) => {
      this.log(`onPushed[${label}] ${show(results)}`);
      if (throws) throw new Error(`${label} が投げた（test）`);
    };
  }
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  run: (c: Ctx) => Promise<unknown>;
}

type Options = Parameters<typeof createTokenSpread>[0];

function build(
  c: Ctx,
  runners: readonly RunnerClient[] | Error,
  extra: Partial<Omit<Options, 'runners' | 'clone'>> = {},
) {
  const spread = createTokenSpread({
    runners: c.registry(runners),
    clone: c.clone(),
    profileEnvNames: c.names('profileEnvNames', []),
    ...extra,
  });
  return spread;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'no-runners-empty-roster',
    covers:
      '名簿が空: 「撒く先が無い」（selfHealing:true）の結果を足し、クローンへは置く。購読者へは知らせない（撒いた結果が無い）',
    run: async (c) => {
      const spread = build(c, []);
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'roster-fails',
    covers:
      '名簿が引けない（list が投げる）: 握って空と同じ扱い（selfHealing の結果）。投げない。購読者へは知らせない',
    run: async (c) => {
      const spread = build(c, new Error('名簿が引けない（test）'));
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'one-runner-ok-no-listener',
    covers: '1台成功・購読者なし: runner → クローンの順。結果は runner・clone',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')]);
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'one-runner-ok-one-listener',
    covers: '1台成功・購読者1つ: クローンへ置いた後に runner の結果（runnerId・ok）を知らせる',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')]);
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'two-runners-in-order',
    covers:
      '2台成功: 順に撒く（runner-a の戻りの後に runner-b を呼ぶ。a は遅くしてあるので、並行なら b の呼びが先に出る）',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a', () => [], 4), c.runner('runner-b')]);
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'one-fails-one-ok',
    covers:
      '1台失敗・1台成功: 失敗した runner だけ ok:false（理由は1行目だけ。値が混ざりうる続きの行は載せない）。失敗しても次の runner へ進む',
    run: async (c) => {
      const spread = build(c, [
        c.runner('runner-a', () => {
          throw new Error('runner が応答しない\nstack: 値が混ざりうる行');
        }),
        c.runner('runner-b'),
      ]);
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'fail-reason-empty',
    covers: '失敗の理由が空（空文字の Error・文字列でない値）: 固定文言「理由不明」',
    run: async (c) => {
      const spread = build(c, [
        c.runner('runner-a', () => {
          throw new Error('');
        }),
        c.runner('runner-b', () => {
          // 理由が取れない値（Error でない）の分岐を縛る
          throw undefined;
        }),
      ]);
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'all-runners-fail',
    covers: '全台失敗: 結果は ok:false が並び、クローンへは置く。購読者へは失敗の結果を知らせる',
    run: async (c) => {
      const down = () => {
        throw new Error('runner が落ちている（test）');
      };
      const spread = build(c, [c.runner('runner-a', down), c.runner('runner-b', down)]);
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'listeners-two-one-throws',
    covers:
      '購読者2つ・先の購読者が投げる: 例外は握り、次の購読者へ知らせ、spread は成功のまま返す（登録した順に呼ぶ）',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')]);
      spread.onPushed(c.listener('first', true));
      spread.onPushed(c.listener('second'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'unsubscribed-listener',
    covers:
      '解除した購読者へは知らせない（残っている購読者にだけ知らせる）。解除を2回呼んでも害は無い',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')]);
      const off = spread.onPushed(c.listener('gone'));
      spread.onPushed(c.listener('kept'));
      off();
      off();
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'spread-twice',
    covers: '続けて2回撒く: 2回とも runner → クローンの順で、購読者へは回ごとに知らせる',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')]);
      spread.onPushed(c.listener('a'));
      const first = await settle(() => spread.spread(TOKEN));
      const second = await settle(() => spread.spread({ ...TOKEN, id: 'tok-b', generation: 3 }));
      return { first, second };
    },
  },
  {
    name: 'shadowed-runner-profile',
    covers:
      'runner へ渡るプロファイルが撒く鍵の名前を宣言している: onShadowed（runner）を呼び、結果に profile-shadow を足す。撒くのはやめない',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')], {
        profileEnvNames: c.names('profileEnvNames', ['CLAUDE_CODE_OAUTH_TOKEN', 'UNRELATED_NAME']),
        onShadowed: c.onShadowed(),
      });
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'shadowed-clone-profile',
    covers:
      'クローンのプロファイルが撒く鍵の名前を宣言している: onShadowed（clone）を呼び、結果に profile-shadow-clone を足す。runner 側の問い合わせの後に clone 側を問い合わせる',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')], {
        cloneProfileEnvNames: c.names('cloneProfileEnvNames', [
          'GH_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ]),
        onShadowed: c.onShadowed(),
      });
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'shadowed-both-no-callback',
    covers:
      '両方に影があり onShadowed が無い: 呼ばずに結果にだけ載せる（runner の影 → clone の影の順）',
    run: async (c) => {
      const spread = build(c, [], {
        profileEnvNames: c.names('profileEnvNames', ['CLAUDE_CODE_OAUTH_TOKEN']),
        cloneProfileEnvNames: c.names('cloneProfileEnvNames', ['CLAUDE_CODE_OAUTH_TOKEN']),
      });
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'profile-names-fail',
    covers:
      'プロファイルの名前の問い合わせが投げる（runner 側・clone 側とも）: 握って影なし扱い。撒く処理は続く',
    run: async (c) => {
      const spread = build(c, [c.runner('runner-a')], {
        profileEnvNames: c.names('profileEnvNames', new Error('読めない（test）')),
        cloneProfileEnvNames: c.names('cloneProfileEnvNames', new Error('読めない（test）')),
        onShadowed: c.onShadowed(),
      });
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
  {
    name: 'clone-box-set-throws',
    covers:
      'クローンの箱への置き込みが投げる: runner へは撒き済みで、購読者への知らせの前に spread が投げる（知らせない）',
    run: async (c) => {
      const clone = c.clone();
      const failing = {
        ...clone,
        set: () => {
          c.log('> clone.set (throws)');
          throw new Error('箱に置けない（test）');
        },
      };
      const spread = createTokenSpread({
        runners: c.registry([c.runner('runner-a')]),
        clone: failing,
        profileEnvNames: c.names('profileEnvNames', []),
      });
      spread.onPushed(c.listener('a'));
      return settle(() => spread.spread(TOKEN));
    },
  },
];

const ALL_KEYS = SCENARIOS.map((scenario) => scenario.name);

interface Pinned {
  out: unknown;
  events: string[];
  stderr: string[];
}

interface PinFile {
  counts: Record<string, number>;
  scenarios: Record<string, Pinned>;
}

function plain<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' && item.length > 100 ? `<str ${String(item.length)} chars>` : item,
    ),
  ) as T;
}

async function runScenario(scenario: Scenario): Promise<Pinned> {
  const c = new Ctx();
  const stderr: string[] = [];
  setStderrSinkForTesting((line) => {
    stderr.push(line);
  });
  // 自分を積み直すマイクロタスクを1本回して、await の世代を数える（上限を置く: 暴走で場面が止まらなくならないように）
  let spinning = true;
  const spin = (): void => {
    if (!spinning) return;
    c.tick += 1;
    if (c.tick < 100_000) queueMicrotask(spin);
  };
  queueMicrotask(spin);
  let out: unknown;
  try {
    out = await scenario.run(c);
  } finally {
    spinning = false;
    setStderrSinkForTesting(null);
  }
  return {
    out: plain(out),
    events: c.ev.map((entry) => `${String(entry.t)} ${entry.e}`),
    stderr,
  };
}

async function runAll(): Promise<Record<string, Pinned>> {
  const out: Record<string, Pinned> = {};
  for (const scenario of SCENARIOS) out[scenario.name] = await runScenario(scenario);
  return out;
}

describe('鍵を撒く処理（token-spread）の呼びの並び・返り値・知らせの固定（場面ごと）', () => {
  let actual: Record<string, Pinned> = {};
  let pinned: PinFile = { counts: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        counts: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.events.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 120_000);

  afterAll(() => {
    setStderrSinkForTesting(null);
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.events.length, `${key} が呼びを1つも記録していない`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの呼びの数の一覧が固定値と同じ', () => {
    const counts = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.events.length ?? -1]),
    );
    expect(counts).toEqual(pinned.counts);
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    const key = scenario.name;

    it(`返り値が固定値と同じ（${scenario.covers}）`, () => {
      expect(pinned.scenarios[key], `${key} が固定値に無い`).toBeDefined();
      expect(actual[key]?.out, `場面 ${key} の返り値が固定値からずれた`).toEqual(
        pinned.scenarios[key]?.out,
      );
    });

    it('呼びの並びと await の世代と知らせが固定値と同じ', () => {
      const want = pinned.scenarios[key];
      const got = actual[key];
      expect(want, `${key} が固定値に無い`).toBeDefined();
      expect(got?.events.length, `場面 ${key} の呼びの数が変わった`).toBe(want?.events.length);
      expect(
        got?.events,
        `場面 ${key} の呼びの並び（世代・口・引数・結果）が固定値からずれた`,
      ).toEqual(want?.events);
    });

    it('stderr に出た行が固定値と同じ', () => {
      const want = pinned.scenarios[key];
      expect(want, `${key} が固定値に無い`).toBeDefined();
      expect(actual[key]?.stderr, `場面 ${key} の stderr の行が変わった`).toEqual(want?.stderr);
    });
  });

  it('同じ入力で2回回すと、全場面で同じ記録になる（採番・順序・世代が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に本物らしい値と絶対パスが無い。値は作りものだけ', () => {
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toMatch(/\/tmp\/|\/home\//);
    expect(pinnedRaw).not.toMatch(/[A-Za-z0-9_./@-]{120,}/);
  });
});
