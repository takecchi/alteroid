import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createTokenRotator,
  type TokenProbePort,
  type TokenRotationOutcome,
  type TokenSpreadResult,
} from './token-rotator.js';
import { createTokenPoolWriteLock } from './token-pool-write-lock.js';
import { UnreadableActiveTokenError, type Stores } from './store.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';
import type { UsageLimitNotice } from './usage-limits.js';

// `createTokenRotator` の中の `finishSweep`（候補を試し終えた後に、結果 `TokenRotationOutcome` を組み立てる所）を、外から見える結果だけで縛る。
// 入口は `observe` と `reconsider`（`finishSweep` は両方から呼ばれる内側の関数で、直接は呼べない）。
// `token-rotator.test.ts` が `toMatchObject` / `toContain` で縛っていない所を足す:
//   rotated / parked / exhausted / 見送り（ignored・stranded）の戻り値の全欄（`freshness`・`reason`・`fromTokenId`・`cooldownSource`・`current`・`earliest`・
//   `stoppedBy` が無いときは欄ごと無いこと）と `why` の全文、`skipped`（試した候補の列挙）・`unreadableTail`・`describeStaleRunEnd` の `tail`、
//   保存（`writeLock.run` の中で最新の行へ観測を当てる・`sweep.tokens` を書き戻さない）→ nominate（最新の行を読み直す）の順序、
//   `staleRun = null` の時機（見送りのときは触らない）、`await` の位置（マイクロタスクの周回数と、各呼び出しが起きる周回）。
// 期待の文字列・欄・順序・周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（待つのはマイクロタスクの周回だけで、上限を持つ）。
//
// 作ってみて分かった、公開の入口からは通れない枝（縛れていない）:
//   - rotated の `why` の「判定できなかったので撒いて本番で確かめる」の枝: chosen が usable 以外になるのは `fellBackToUndecided` のときだけで、その枝が先に取る
//   - exhausted の `why` の「いちばん早く戻る候補が現役自身だった」の枝: 現役は outgoing / currentId として探索から外れるので earliest が現役になる回が無い
//   - exhausted の `why` の末尾 `'候補が無い'`: `stoppedByBudget` でなければ `ranOut` が必ず在る
//   - `describeStaleRunEnd` の「(現役が未指名のあいだ)」: stale は active が在るときにしか起きない（active が null なら freshness は unknown）

const AT = '2026-08-25T03:00:00.000Z';
const NOW = Date.parse(AT);
const HOUR = 3_600_000;
const reached: UsageLimitNotice = {
  kind: 'reached',
  text: "You've hit your org's monthly spend limit",
};

type Verdict = Awaited<ReturnType<TokenProbePort['probe']>>;

interface RigOptions {
  verdictOf?: (id: string) => Verdict;
  probeTakesMs?: number;
  onProbe?: (id: string, stores: Stores) => Promise<void>;
  // n 回目の `stores.tokens.list()`（seed を除く）の直前に走る
  onList?: (callNumber: number, stores: Stores) => Promise<void>;
  spreadResults?: TokenSpreadResult[];
  traced?: boolean;
}

interface Rig {
  stores: Stores;
  rotator: ReturnType<typeof createTokenRotator>;
  trace: string[];
  clock: { tick: number };
  seed: (rows: AgentToken[], active: ActiveAgentToken | null) => Promise<void>;
}

function makeRig(options: RigOptions = {}): Rig {
  const stores = createMemoryStores();
  const trace: string[] = [];
  const clock = { tick: 0 };
  let nowMs = NOW;
  let quiet = false;
  let listCount = 0;
  const note = (what: string): void => {
    if (options.traced === true && !quiet) trace.push(`t${String(clock.tick)} ${what}`);
  };

  const rawList = stores.tokens.list.bind(stores.tokens);
  const rawReplace = stores.tokens.replace.bind(stores.tokens);
  const rawWriteActive = stores.tokens.writeActive.bind(stores.tokens);
  stores.tokens.list = async () => {
    if (quiet) return await rawList();
    listCount += 1;
    note('list');
    if (options.onList !== undefined) {
      quiet = true;
      try {
        await options.onList(listCount, stores);
      } finally {
        quiet = false;
      }
    }
    return await rawList();
  };
  stores.tokens.replace = async (rows) => {
    note(
      `replace ${rows.map((row) => row.id + (row.cooldownUntil === undefined ? '' : '*')).join(',')}`,
    );
    return await rawReplace(rows);
  };
  stores.tokens.writeActive = async (active) => {
    note(`writeActive ${active.tokenId}#${String(active.generation)}`);
    return await rawWriteActive(active);
  };

  const probe: TokenProbePort = {
    async probe(token) {
      note(`probe ${token.id}`);
      nowMs += options.probeTakesMs ?? 0;
      if (options.onProbe !== undefined) {
        quiet = true;
        try {
          await options.onProbe(token.id, stores);
        } finally {
          quiet = false;
        }
      }
      return options.verdictOf?.(token.id) ?? { verdict: 'usable' };
    },
  };

  const inner = createTokenPoolWriteLock();
  const writeLock =
    options.traced === true
      ? {
          run: <T>(work: () => Promise<T>): Promise<T> => {
            note('lock:queued');
            return inner.run(async () => {
              note('lock:enter');
              try {
                return await work();
              } finally {
                note('lock:exit');
              }
            });
          },
        }
      : inner;

  const rotator = createTokenRotator({
    stores,
    probe,
    spread: {
      async spread(token) {
        note(`spread ${token.id}#${String(token.generation)} ${token.value}`);
        return options.spreadResults ?? [{ target: 'runner-primary', ok: true }];
      },
    },
    now: () => new Date(nowMs),
    writeLock,
  });

  return {
    stores,
    rotator,
    trace,
    clock,
    seed: async (rows, active) => {
      quiet = true;
      try {
        await rawReplace(rows);
        if (active !== null) await rawWriteActive(active);
      } finally {
        quiet = false;
      }
    },
  };
}

function row(id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken {
  const labels: Record<string, string> = {
    'tok-a': 'first',
    'tok-b': 'second',
    'tok-c': 'third',
    'tok-d': 'fourth',
  };
  return { id, label: labels[id] ?? id, value: `value-${id.slice(4)}`, order, ...extra };
}

const four = (): AgentToken[] => [
  row('tok-a', 0),
  row('tok-b', 1),
  row('tok-c', 2),
  row('tok-d', 3),
];
const two = (): AgentToken[] => [row('tok-a', 0), row('tok-b', 1)];
const activeA = (generation = 1): ActiveAgentToken => ({
  tokenId: 'tok-a',
  generation,
  rotatedAt: AT,
});

const currentObservation = {
  notice: reached,
  observedBy: { tokenId: 'tok-a', generation: 1 },
} as const;
const staleObservation = {
  notice: reached,
  observedBy: { tokenId: 'tok-a', generation: 0 },
} as const;

function breakActiveToken(rig: Rig, reason = 'active.generation が数値ではない'): void {
  const store = rig.stores.tokens;
  const realReadActive = store.readActive.bind(store);
  const realWriteActive = store.writeActive.bind(store);
  let broken = true;
  store.readActive = async () => {
    if (broken) throw new UnreadableActiveTokenError(reason);
    return await realReadActive();
  };
  store.writeActive = async (active) => {
    broken = false;
    return await realWriteActive(active);
  };
}

async function patchRows(
  stores: Stores,
  mutate: (rows: AgentToken[]) => AgentToken[],
): Promise<void> {
  await stores.tokens.replace(mutate(await stores.tokens.list()));
}

// マイクロタスクを 1 周ずつ流して、戻りまでの周回数を測る（上限つき）
async function settle<T>(
  rig: Rig,
  start: () => Promise<T>,
): Promise<{ outcome: T; settledAtTick: number }> {
  const promise = start();
  let settledAtTick = -1;
  const box: { value?: { outcome: T } } = {};
  void promise.then(
    (outcome) => {
      box.value = { outcome };
      settledAtTick = rig.clock.tick;
    },
    () => {
      settledAtTick = rig.clock.tick;
    },
  );
  while (settledAtTick < 0 && rig.clock.tick < 300) {
    await Promise.resolve();
    rig.clock.tick += 1;
  }
  if (box.value === undefined) throw new Error('戻らなかった（または reject した）');
  return { outcome: box.value.outcome, settledAtTick };
}

function without(token: AgentToken, key: 'value' | 'cooldownUntil'): AgentToken {
  const copy: AgentToken = { ...token };
  delete copy[key];
  return copy;
}

function unusable(retryAt?: number): Verdict {
  return retryAt === undefined
    ? { verdict: 'unusable', reason: 'probe: limit reached' }
    : { verdict: 'unusable', reason: 'probe: limit reached', retryAt };
}

describe('rotated: 戻り値の全欄と why の全文', () => {
  it('observe で usable の候補へ回る: fromTokenId・freshness を持ち、reason は欄ごと無い', async () => {
    const rig = makeRig();
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "second",
        "toTokenId": "tok-b",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。候補「second」は観測できた",
      }
    `);
  });

  it('撒いた先の結果はそのまま載る（失敗した先も落とさない）', async () => {
    const rig = makeRig({
      spreadResults: [
        { target: 'runner-primary', ok: true },
        { target: 'runner-peer', ok: false, error: 'peer is gone', selfHealing: true },
      ],
    });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    if (outcome.kind !== 'rotated') throw new Error('rotated のはず');
    expect(outcome.spread).toMatchInlineSnapshot(`
      [
        {
          "ok": true,
          "target": "runner-primary",
        },
        {
          "error": "peer is gone",
          "ok": false,
          "selfHealing": true,
          "target": "runner-peer",
        },
      ]
    `);
  });

  it('reconsider で回る: freshness は欄ごと無く、reason が載る（signal は stranded）', async () => {
    const rig = makeRig();
    await rig.seed([row('tok-a', 0, { cooldownUntil: NOW + HOUR }), row('tok-b', 1)], activeA());
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "reason": "tick",
        "signal": "stranded",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "second",
        "toTokenId": "tok-b",
        "why": "記録の上でいまの現役「first」は通らない（cooling）。候補「second」は観測できた",
      }
    `);
  });

  it('指名が無いときの reconsider: fromTokenId は欄ごと無い', async () => {
    const rig = makeRig();
    await rig.seed(two(), null);
    const outcome = await rig.rotator.reconsider({ reason: 'startup' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "generation": 1,
        "kind": "rotated",
        "reason": "startup",
        "signal": "stranded",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "first",
        "toTokenId": "tok-a",
        "why": "まだ一度も指名していない。候補「first」は観測できた",
      }
    `);
  });

  it('判定できなかった候補へ倒す（持ち時間は切れていない）', async () => {
    const rig = makeRig({
      verdictOf: (id) => ({ verdict: 'undecidable', reason: `probe timed out (${id})` }),
    });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "second",
        "toTokenId": "tok-b",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。**\`usable\` と確かめられた候補は見つからなかった**ので、判定できなかった候補「second」へ倒した——撒いて本番で確かめる（probe timed out (tok-b)）",
      }
    `);
  });

  it('判定できなかった候補へ倒す（持ち時間を使い切ったところで倒した）', async () => {
    const rig = makeRig({
      probeTakesMs: 30_000,
      verdictOf: (id) => ({ verdict: 'undecidable', reason: `probe timed out (${id})` }),
    });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "second",
        "toTokenId": "tok-b",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。**\`usable\` と確かめられた候補は見つからなかった**ので、判定できなかった候補「second」へ倒した（候補を試す持ち時間（60000ms）を使い切ったところで倒した）——撒いて本番で確かめる（probe timed out (tok-b)）",
      }
    `);
  });

  it('usable と判定された後ろの候補を選ぶとき、先に使えなかった候補は why に出ない（skipped は rotated に付けない）', async () => {
    const rig = makeRig({
      verdictOf: (id) => (id === 'tok-b' ? unusable(NOW + HOUR) : { verdict: 'usable' }),
    });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "third",
        "toTokenId": "tok-c",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。候補「third」は観測できた",
      }
    `);
  });

  it('現役の指名が読めなかった: 世代は時刻から作り、why の末尾に撒き直した旨が付く（usable）', async () => {
    const rig = makeRig();
    await rig.seed(two(), null);
    breakActiveToken(rig);
    const outcome = await rig.rotator.reconsider({ reason: 'startup' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "generation": 1787626800000,
        "kind": "rotated",
        "reason": "startup",
        "signal": "stranded",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "first",
        "toTokenId": "tok-a",
        "why": "まだ一度も指名していない。候補「first」は観測できた
      **現役の指名が読めなかったので、世代 1787626800000 で撒き直した**（active.generation が数値ではない）",
      }
    `);
  });

  it('現役の指名が読めなかった: why の末尾に撒き直した旨が付く（判定できなかった候補へ倒した）', async () => {
    const rig = makeRig({
      probeTakesMs: 30_000,
      verdictOf: (id) => ({ verdict: 'undecidable', reason: `probe timed out (${id})` }),
    });
    await rig.seed(four(), null);
    breakActiveToken(rig);
    const outcome = await rig.rotator.reconsider({ reason: 'startup' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "generation": 1787626860000,
        "kind": "rotated",
        "reason": "startup",
        "signal": "stranded",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "first",
        "toTokenId": "tok-a",
        "why": "まだ一度も指名していない。**\`usable\` と確かめられた候補は見つからなかった**ので、判定できなかった候補「first」へ倒した（候補を試す持ち時間（60000ms）を使い切ったところで倒した）——撒いて本番で確かめる（probe timed out (tok-a)）
      **現役の指名が読めなかったので、世代 1787626860000 で撒き直した**（active.generation が数値ではない）",
      }
    `);
  });
});

describe('parked: 戻り値の全欄と why の全文', () => {
  it('候補が全部冷却中: 出所の無い冷却は cooldownSource が欄ごと無く、fromTokenId・freshness が載る', async () => {
    const rig = makeRig();
    await rig.seed([row('tok-a', 0), row('tok-b', 1, { cooldownUntil: NOW + HOUR })], activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "cooldownUntil": 1787630400000,
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "parked",
        "label": "second",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "tokenId": "tok-b",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。**いま通る候補は1本も無い**。いちばん早く戻る「second」を撒いて待つ（2026-08-25T04:00:00.000Z まで通らない）",
      }
    `);
  });

  it('試した候補が全部使えなかった後、いちばん早く戻る鍵へ移す: skipped の列挙と cooldownSource', async () => {
    const rig = makeRig({
      verdictOf: (id) => {
        if (id === 'tok-b') return unusable(NOW + 600_000);
        if (id === 'tok-c') return unusable(NOW + 300_000);
        return { verdict: 'usable' };
      },
    });
    await rig.seed(
      [
        row('tok-a', 0),
        row('tok-b', 1),
        row('tok-c', 2),
        row('tok-d', 3, { cooldownUntil: NOW + 2 * HOUR, cooldownSource: 'default' }),
      ],
      activeA(),
    );
    // b・c は試した（tried）ので探索から外れ、冷却中で残っている d が earliest になる
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "cooldownSource": "default",
        "cooldownUntil": 1787634000000,
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "parked",
        "label": "fourth",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "tokenId": "tok-d",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。**いま通る候補は1本も無い**。試した候補「second」「third」はどれも使えなかった。いちばん早く戻る「fourth」を撒いて待つ（2026-08-25T05:00:00.000Z まで通らない）",
      }
    `);
  });

  it('現役の指名が読めなかった: parked の why の末尾にも撒き直した旨が付く（fromTokenId は無い）', async () => {
    const rig = makeRig();
    await rig.seed(
      [
        row('tok-a', 0, { cooldownUntil: NOW + 2 * HOUR }),
        row('tok-b', 1, { cooldownUntil: NOW + HOUR, cooldownSource: 'quota_reset' }),
      ],
      null,
    );
    breakActiveToken(rig);
    const outcome = await rig.rotator.reconsider({ reason: 'startup' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "cooldownSource": "quota_reset",
        "cooldownUntil": 1787630400000,
        "generation": 1787626800000,
        "kind": "parked",
        "label": "second",
        "reason": "startup",
        "signal": "stranded",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "tokenId": "tok-b",
        "why": "まだ一度も指名していない。**いま通る候補は1本も無い**。いちばん早く戻る「second」を撒いて待つ（2026-08-25T04:00:00.000Z まで通らない）
      **現役の指名が読めなかったので、世代 1787626800000 で撒き直した**（active.generation が数値ではない）",
      }
    `);
  });

  it('pool は保存した最新の行から引く: probe の間に現役の冷却が人間に消されたら、sweep.tokens ではなくそちらで「改善か」を決める', async () => {
    const rig = makeRig({
      verdictOf: () => unusable(),
      onProbe: async (id, stores) => {
        if (id !== 'tok-b') return;
        await patchRows(stores, (rows) =>
          rows.map((r) => (r.id === 'tok-a' ? without(r, 'cooldownUntil') : r)),
        );
      },
    });
    await rig.seed(
      [
        row('tok-a', 0, { cooldownUntil: NOW + HOUR }),
        row('tok-b', 1),
        row('tok-c', 2, { cooldownUntil: NOW + 2 * HOUR }),
      ],
      activeA(),
    );
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "cooldownUntil": 1787634000000,
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "parked",
        "label": "third",
        "reason": "tick",
        "signal": "stranded",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "tokenId": "tok-c",
        "why": "記録の上でいまの現役「first」は通らない（cooling）。**いま通る候補は1本も無い**。試した候補「second」はどれも使えなかった。いちばん早く戻る「third」を撒いて待つ（2026-08-25T05:00:00.000Z まで通らない）",
      }
    `);
  });
});

describe('exhausted: 戻り値の全欄と why の全文', () => {
  it('降りた1本しか無い: earliest・current・stoppedBy は欄ごと無く、ranOut の why が出る', async () => {
    const rig = makeRig();
    await rig.seed([row('tok-a', 0)], activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "kind": "exhausted",
        "signal": "reached",
        "why": "試せる候補が1本も無い（プールが空、または降りた1本しか無い）",
      }
    `);
  });

  it('残りが全部人間に外されている: ranOut の why（待っても戻らない）が出る', async () => {
    const rig = makeRig();
    await rig.seed([row('tok-a', 0), row('tok-b', 1, { disabledAt: AT })], activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "kind": "exhausted",
        "signal": "reached",
        "why": "試せる候補が1本も無い（すべて人間が外したか失効している。冷却中のものは無いので、待っても戻らない）",
      }
    `);
  });

  it('試せる候補を全部試して使えなかった: skipped の列挙（「」区切り）', async () => {
    const rig = makeRig({ verdictOf: () => unusable() });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "kind": "exhausted",
        "signal": "reached",
        "why": "試せる候補を使い切った。試した候補「second」「third」「fourth」はどれも使えなかった",
      }
    `);
  });

  it('持ち時間で打ち切った: stoppedBy は budget、earliest は出さず、skipped が付く', async () => {
    const rig = makeRig({ probeTakesMs: 30_000, verdictOf: () => unusable() });
    await rig.seed([...four(), row('tok-e', 4)], activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "kind": "exhausted",
        "signal": "reached",
        "stoppedBy": "budget",
        "why": "候補を試す持ち時間（60000ms）を使い切った。試した候補「second」「third」はどれも使えなかった",
      }
    `);
  });

  it('いま撒いてある鍵のほうが早く戻る（current は cooldownSource を欄ごと持たず、earliest は持つ）', async () => {
    const rig = makeRig();
    await rig.seed(
      [
        row('tok-a', 0, { cooldownUntil: NOW + HOUR }),
        row('tok-b', 1, { cooldownUntil: NOW + 2 * HOUR, cooldownSource: 'overage_reset' }),
      ],
      activeA(),
    );
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "current": {
          "cooldownUntil": 1787630400000,
          "label": "first",
          "tokenId": "tok-a",
        },
        "earliest": {
          "cooldownSource": "overage_reset",
          "cooldownUntil": 1787634000000,
          "label": "second",
          "tokenId": "tok-b",
        },
        "kind": "exhausted",
        "reason": "tick",
        "signal": "stranded",
        "why": "いま撒いてある「first」のほうが早く戻る（現役を除いた候補の中でいちばん早い「second」は 2026-08-25T05:00:00.000Z）。遅い鍵へ移すのは改善ではないので撒き直さない",
      }
    `);
  });

  it('いま撒いてある鍵のほうが早く戻る（current は cooldownSource を持ち、earliest は欄ごと持たない）', async () => {
    const rig = makeRig();
    await rig.seed(
      [
        row('tok-a', 0, { cooldownUntil: NOW + HOUR, cooldownSource: 'quota_reset' }),
        row('tok-b', 1, { cooldownUntil: NOW + 2 * HOUR }),
      ],
      activeA(),
    );
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "current": {
          "cooldownSource": "quota_reset",
          "cooldownUntil": 1787630400000,
          "label": "first",
          "tokenId": "tok-a",
        },
        "earliest": {
          "cooldownUntil": 1787634000000,
          "label": "second",
          "tokenId": "tok-b",
        },
        "kind": "exhausted",
        "reason": "tick",
        "signal": "stranded",
        "why": "いま撒いてある「first」のほうが早く戻る（現役を除いた候補の中でいちばん早い「second」は 2026-08-25T05:00:00.000Z）。遅い鍵へ移すのは改善ではないので撒き直さない",
      }
    `);
  });

  it('いま撒いてある鍵のほうが早く戻る（試した候補の skipped が付く）', async () => {
    const rig = makeRig({ verdictOf: () => unusable() });
    await rig.seed(
      [
        row('tok-a', 0, { cooldownUntil: NOW + HOUR }),
        row('tok-b', 1),
        row('tok-c', 2, { cooldownUntil: NOW + 2 * HOUR }),
      ],
      activeA(),
    );
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "current": {
          "cooldownUntil": 1787630400000,
          "label": "first",
          "tokenId": "tok-a",
        },
        "earliest": {
          "cooldownUntil": 1787634000000,
          "label": "third",
          "tokenId": "tok-c",
        },
        "kind": "exhausted",
        "reason": "tick",
        "signal": "stranded",
        "why": "いま撒いてある「first」のほうが早く戻る（現役を除いた候補の中でいちばん早い「third」は 2026-08-25T05:00:00.000Z）。遅い鍵へ移すのは改善ではないので撒き直さない。試した候補「second」はどれも使えなかった",
      }
    `);
  });

  it('earliest の行が probe の間に消えた: park せず、current が無ければ「いま撒いてある鍵」と書く', async () => {
    const rig = makeRig({
      verdictOf: () => unusable(),
      onProbe: async (id, stores) => {
        if (id !== 'tok-b') return;
        await patchRows(stores, (rows) => rows.filter((r) => r.id !== 'tok-c'));
      },
    });
    await rig.seed(
      [
        row('tok-a', 0, { disabledAt: AT }),
        row('tok-b', 1),
        row('tok-c', 2, { cooldownUntil: NOW + HOUR }),
      ],
      activeA(),
    );
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "earliest": {
          "cooldownUntil": 1787630400000,
          "label": "third",
          "tokenId": "tok-c",
        },
        "kind": "exhausted",
        "reason": "tick",
        "signal": "stranded",
        "why": "いま撒いてある鍵のほうが早く戻る（現役を除いた候補の中でいちばん早い「third」は 2026-08-25T04:00:00.000Z）。遅い鍵へ移すのは改善ではないので撒き直さない。試した候補「second」はどれも使えなかった",
      }
    `);
  });

  it('プールが空: finishSweep を通らない（対照）', async () => {
    const rig = makeRig();
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "unknown",
        "kind": "exhausted",
        "signal": "reached",
        "why": "プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）",
      }
    `);
  });
});

describe('見送り（ignored・stranded）: 撒く直前に選んだ行が使えなくなった', () => {
  const replaceB =
    (mutate: (r: AgentToken) => AgentToken | null) =>
    async (id: string, stores: Stores): Promise<void> => {
      if (id !== 'tok-b') return;
      await patchRows(stores, (rows) =>
        rows.flatMap((r) => {
          if (r.id !== 'tok-b') return [r];
          const next = mutate(r);
          return next === null ? [] : [next];
        }),
      );
    };

  it('observe: 行が消えた（freshness が載り、reason は欄ごと無い）', async () => {
    const rig = makeRig({ traced: true, onProbe: replaceB(() => null) });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "kind": "ignored",
        "signal": "stranded",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。選んだ候補「second」は撒く直前に行が消えた・外された・失効した（probe の間に差し替わった）ので撒かない。次の判定で選び直す",
      }
    `);
    expect(await rig.stores.tokens.readActive()).toEqual(activeA());
    expect(rig.trace.filter((entry) => entry.includes('spread'))).toEqual([]);
  });

  it('reconsider: 行が消えた（reason が載り、freshness は欄ごと無い）', async () => {
    const rig = makeRig({ onProbe: replaceB(() => null) });
    await rig.seed([row('tok-a', 0, { cooldownUntil: NOW + HOUR }), ...four().slice(1)], activeA());
    const outcome = await rig.rotator.reconsider({ reason: 'pool_changed' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "kind": "ignored",
        "reason": "pool_changed",
        "signal": "stranded",
        "why": "記録の上でいまの現役「first」は通らない（cooling）。選んだ候補「second」は撒く直前に行が消えた・外された・失効した（probe の間に差し替わった）ので撒かない。次の判定で選び直す",
      }
    `);
    expect(await rig.stores.tokens.readActive()).toEqual(activeA());
  });

  it.each([
    ['人間が外した（disabledAt）', (r: AgentToken) => ({ ...r, disabledAt: AT })],
    ['失効した（invalidatedAt）', (r: AgentToken) => ({ ...r, invalidatedAt: AT })],
    ['値が空になった', (r: AgentToken) => ({ ...r, value: '' })],
    ['値が無くなった', (r: AgentToken) => without(r, 'value')],
  ] as const)('observe: 選んだ行が%s: 撒かず、現役の指名も書かない', async (_name, mutate) => {
    const rig = makeRig({ traced: true, onProbe: replaceB(mutate) });
    await rig.seed(four(), activeA());
    const outcome = await rig.rotator.observe(currentObservation);
    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.signal).toBe('stranded');
    expect(outcome.freshness).toBe('current');
    expect('reason' in outcome).toBe(false);
    expect('staleRun' in outcome).toBe(false);
    expect(outcome.why.endsWith('次の判定で選び直す')).toBe(true);
    expect(await rig.stores.tokens.readActive()).toEqual(activeA());
    expect(rig.trace.filter((entry) => entry.includes('spread'))).toEqual([]);
  });

  it('park しようとした行が撒く直前に消えた: parked ではなく見送り（whyHead は stranded の文）', async () => {
    const rig = makeRig({
      onList: async (n, stores) => {
        // reconsider の先頭の読みが 1 回目、nominate の読み直しが 2 回目（候補を試さないので保存の読みは無い）
        if (n !== 2) return;
        await patchRows(stores, (rows) => rows.filter((r) => r.id !== 'tok-b'));
      },
    });
    await rig.seed(
      [
        row('tok-a', 0, { cooldownUntil: NOW + 2 * HOUR }),
        row('tok-b', 1, { cooldownUntil: NOW + HOUR }),
      ],
      activeA(),
    );
    const outcome = await rig.rotator.reconsider({ reason: 'tick' });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "kind": "ignored",
        "reason": "tick",
        "signal": "stranded",
        "why": "記録の上でいまの現役「first」は通らない（cooling）。選んだ候補「second」は撒く直前に行が消えた・外された・失効した（probe の間に差し替わった）ので撒かない。次の判定で選び直す",
      }
    `);
    expect(await rig.stores.tokens.readActive()).toEqual(activeA());
  });
});

describe('副作用の順序（保存 → nominate → staleRun の終了）', () => {
  it('保存は writeLock の中で最新の行へ観測を当てる: probe の間の人間の編集・追加を踏み消さず、nominate は最新の行を読み直す', async () => {
    const rig = makeRig({
      traced: true,
      verdictOf: (id) => (id === 'tok-b' ? unusable(NOW + HOUR) : { verdict: 'usable' }),
      onProbe: async (id, stores) => {
        if (id !== 'tok-c') return;
        await patchRows(stores, (rows) => [
          ...rows.map((r) =>
            r.id === 'tok-d'
              ? { ...r, label: 'fourth-edited' }
              : r.id === 'tok-c'
                ? { ...r, value: 'value-c2' }
                : r,
          ),
          row('tok-e', 4, { label: 'added-by-human' }),
        ]);
      },
    });
    await rig.seed(four(), activeA());
    const { outcome, settledAtTick } = await settle(rig, () =>
      rig.rotator.observe(currentObservation),
    );
    expect(outcome).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "third",
        "toTokenId": "tok-c",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。候補「third」は観測できた",
      }
    `);
    expect(settledAtTick).toMatchInlineSnapshot(`47`);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "t0 list",
        "t3 lock:queued",
        "t4 lock:enter",
        "t4 list",
        "t6 replace tok-a*,tok-b,tok-c,tok-d",
        "t6 list",
        "t11 lock:exit",
        "t15 probe tok-b",
        "t17 probe tok-c",
        "t27 lock:queued",
        "t28 lock:enter",
        "t28 list",
        "t30 replace tok-a*,tok-b*,tok-c,tok-d,tok-e",
        "t30 list",
        "t35 lock:exit",
        "t37 list",
        "t39 writeActive tok-c#2",
        "t41 spread tok-c#2 value-c2",
      ]
    `);
    const stored = (await rig.stores.tokens.list()).map((r) => ({
      id: r.id,
      label: r.label,
      value: r.value,
      cooling: r.cooldownUntil !== undefined,
      rejected: r.lastRejectedReason,
    }));
    expect(stored).toMatchInlineSnapshot(`
      [
        {
          "cooling": true,
          "id": "tok-a",
          "label": "first",
          "rejected": "You've hit your org's monthly spend limit",
          "value": "value-a",
        },
        {
          "cooling": true,
          "id": "tok-b",
          "label": "second",
          "rejected": "probe: limit reached",
          "value": "value-b",
        },
        {
          "cooling": false,
          "id": "tok-c",
          "label": "third",
          "rejected": undefined,
          "value": "value-c2",
        },
        {
          "cooling": false,
          "id": "tok-d",
          "label": "fourth-edited",
          "rejected": undefined,
          "value": "value-d",
        },
        {
          "cooling": false,
          "id": "tok-e",
          "label": "added-by-human",
          "rejected": undefined,
          "value": "value-e",
        },
      ]
    `);
  });

  it('使えなかった候補が無ければ保存しない（replace は coolDown の 1 回だけ）。nominate の読み直しは list 1 回', async () => {
    const rig = makeRig({ traced: true });
    await rig.seed(four(), activeA());
    const { outcome, settledAtTick } = await settle(rig, () =>
      rig.rotator.observe(currentObservation),
    );
    expect(outcome.kind).toBe('rotated');
    expect(settledAtTick).toMatchInlineSnapshot(`27`);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "t0 list",
        "t3 lock:queued",
        "t4 lock:enter",
        "t4 list",
        "t6 replace tok-a*,tok-b,tok-c,tok-d",
        "t6 list",
        "t11 lock:exit",
        "t15 probe tok-b",
        "t17 list",
        "t19 writeActive tok-b#2",
        "t21 spread tok-b#2 value-b",
      ]
    `);
  });

  it('exhausted は保存だけして撒かない（nominate も writeActive も無い）', async () => {
    const rig = makeRig({ traced: true, verdictOf: () => unusable() });
    await rig.seed(two(), activeA());
    const { outcome, settledAtTick } = await settle(rig, () =>
      rig.rotator.observe(currentObservation),
    );
    expect(outcome.kind).toBe('exhausted');
    expect(settledAtTick).toMatchInlineSnapshot(`30`);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "t0 list",
        "t3 lock:queued",
        "t4 lock:enter",
        "t4 list",
        "t6 replace tok-a*,tok-b",
        "t6 list",
        "t11 lock:exit",
        "t15 probe tok-b",
        "t17 lock:queued",
        "t18 lock:enter",
        "t18 list",
        "t20 replace tok-a*,tok-b*",
        "t20 list",
        "t25 lock:exit",
      ]
    `);
  });

  it('parked は保存 → nominate（list）→ writeActive → spread の順', async () => {
    const rig = makeRig({
      traced: true,
      verdictOf: (id) => (id === 'tok-b' ? unusable(NOW + 600_000) : unusable(NOW + 300_000)),
    });
    await rig.seed(
      [...four().slice(0, 3), row('tok-d', 3, { cooldownUntil: NOW + 2 * HOUR })],
      activeA(),
    );
    const { outcome, settledAtTick } = await settle(rig, () =>
      rig.rotator.observe(currentObservation),
    );
    expect(outcome.kind).toBe('parked');
    expect(settledAtTick).toMatchInlineSnapshot(`38`);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "t0 list",
        "t3 lock:queued",
        "t4 lock:enter",
        "t4 list",
        "t6 replace tok-a*,tok-b,tok-c,tok-d*",
        "t6 list",
        "t11 lock:exit",
        "t15 probe tok-b",
        "t16 probe tok-c",
        "t18 lock:queued",
        "t19 lock:enter",
        "t19 list",
        "t21 replace tok-a*,tok-b*,tok-c*,tok-d*",
        "t21 list",
        "t26 lock:exit",
        "t28 list",
        "t30 writeActive tok-d#2",
        "t32 spread tok-d#2 value-d",
      ]
    `);
  });

  it('見送りでは writeActive も spread も無い（保存と読み直しだけ）', async () => {
    const rig = makeRig({
      traced: true,
      verdictOf: (id) => (id === 'tok-b' ? unusable(NOW + HOUR) : { verdict: 'usable' }),
      onProbe: async (id, stores) => {
        if (id !== 'tok-c') return;
        await patchRows(stores, (rows) => rows.filter((r) => r.id !== 'tok-c'));
      },
    });
    await rig.seed(four(), activeA());
    const { outcome, settledAtTick } = await settle(rig, () =>
      rig.rotator.observe(currentObservation),
    );
    expect(outcome.kind).toBe('ignored');
    expect(settledAtTick).toMatchInlineSnapshot(`43`);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "t0 list",
        "t3 lock:queued",
        "t4 lock:enter",
        "t4 list",
        "t6 replace tok-a*,tok-b,tok-c,tok-d",
        "t6 list",
        "t11 lock:exit",
        "t15 probe tok-b",
        "t17 probe tok-c",
        "t27 lock:queued",
        "t28 lock:enter",
        "t28 list",
        "t30 replace tok-a*,tok-b*,tok-d",
        "t30 list",
        "t35 lock:exit",
        "t37 list",
      ]
    `);
  });
});

describe('staleRun の終わり（describeStaleRunEnd の tail と、staleRun = null の時機）', () => {
  async function feedStale(rig: Rig, count: number): Promise<TokenRotationOutcome[]> {
    const outcomes: TokenRotationOutcome[] = [];
    for (let i = 0; i < count; i += 1) outcomes.push(await rig.rotator.observe(staleObservation));
    return outcomes;
  }

  it('rotated: 見送りでは連なりを終えず（数え続ける）、回った後に tail が付き、その次の stale は新しい連なり。tail の label は保存した最新の行から引く', async () => {
    const rig = makeRig({
      verdictOf: (id) => {
        if (id === 'tok-b') return unusable(NOW + HOUR);
        if (id === 'tok-d') return unusable();
        return { verdict: 'usable' };
      },
      onProbe: async (id, stores) => {
        // 1 回目の回転: 選ばれた c が撒く直前に消える（見送り）。2 回目の回転: e を測っている間に現役 a の label が変わる
        if (id === 'tok-c') await patchRows(stores, (rows) => rows.filter((r) => r.id !== 'tok-c'));
        if (id === 'tok-e') {
          await patchRows(stores, (rows) =>
            rows.map((r) => (r.id === 'tok-a' ? { ...r, label: 'first-renamed' } : r)),
          );
        }
      },
    });
    await rig.seed([...four(), row('tok-e', 4)], activeA());
    const firstRun = await feedStale(rig, 5);
    expect(firstRun.map((o) => (o.kind === 'ignored' ? o.staleRun : null))).toEqual([
      1, 2, 3, 4, 5,
    ]);

    const withheld = await rig.rotator.observe(currentObservation);
    expect(withheld).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "kind": "ignored",
        "signal": "stranded",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。選んだ候補「third」は撒く直前に行が消えた・外された・失効した（probe の間に差し替わった）ので撒かない。次の判定で選び直す",
      }
    `);

    // 見送りでは staleRun を触らない: 数え続けて 6 件目になる
    const afterWithheld = await rig.rotator.observe(staleObservation);
    expect(afterWithheld).toMatchInlineSnapshot(`
      {
        "freshness": "stale",
        "kind": "ignored",
        "signal": "reached",
        "staleRun": 6,
        "why": "もう回した後の通知（世代が合わない）",
      }
    `);

    const rotated = await rig.rotator.observe(currentObservation);
    expect(rotated).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "tok-e",
        "toTokenId": "tok-e",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。候補「tok-e」は観測できた
      前の現役「first-renamed」（id tok-a）に対して、もう回した後の通知を計6件捨てて、この連なりは終わった（**間引きで出していない件も含めた総数**。**プロセスが落ちた（デーモンが入れ替わった）ときは、この連なりの総数は出ない**——この計器はプロセスの寿命でしか持たないためである）",
      }
    `);

    // 回った瞬間に staleRun を終えている: 前の連なりの終わりを、この stale が二重に出さない
    const afterRotated = await rig.rotator.observe(currentObservation);
    expect(afterRotated).toMatchInlineSnapshot(`
      {
        "freshness": "stale",
        "kind": "ignored",
        "signal": "reached",
        "staleRun": 1,
        "why": "もう回した後の通知（世代が合わない）",
      }
    `);
  });

  it('parked: 回した後に tail が付き、tail の label は保存した最新の行から引く。その次の stale は新しい連なり', async () => {
    const rig = makeRig({
      verdictOf: (id) => (id === 'tok-b' ? unusable(NOW + 600_000) : unusable(NOW + 300_000)),
      onProbe: async (id, stores) => {
        if (id !== 'tok-c') return;
        await patchRows(stores, (rows) =>
          rows.map((r) => (r.id === 'tok-a' ? { ...r, label: 'first-renamed' } : r)),
        );
      },
    });
    await rig.seed(
      [...four().slice(0, 3), row('tok-d', 3, { cooldownUntil: NOW + 2 * HOUR })],
      activeA(),
    );
    await feedStale(rig, 3);
    const parked = await rig.rotator.observe(currentObservation);
    expect(parked).toMatchInlineSnapshot(`
      {
        "cooldownUntil": 1787634000000,
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "parked",
        "label": "fourth",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "tokenId": "tok-d",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。**いま通る候補は1本も無い**。試した候補「second」「third」はどれも使えなかった。いちばん早く戻る「fourth」を撒いて待つ（2026-08-25T05:00:00.000Z まで通らない）
      前の現役「first-renamed」（id tok-a）に対して、もう回した後の通知を計3件捨てて、この連なりは終わった（**間引きで出していない件も含めた総数**。**プロセスが落ちた（デーモンが入れ替わった）ときは、この連なりの総数は出ない**——この計器はプロセスの寿命でしか持たないためである）",
      }
    `);
    const afterParked = await rig.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(afterParked).toMatchInlineSnapshot(`
      {
        "freshness": "stale",
        "kind": "ignored",
        "signal": "reached",
        "staleRun": 1,
        "why": "もう回した後の通知（世代が合わない）",
      }
    `);
  });

  it('判定できなかった候補へ倒した回にも tail が付く（持ち時間は切れていない）', async () => {
    const rig = makeRig({
      verdictOf: (id) => ({ verdict: 'undecidable', reason: `probe timed out (${id})` }),
    });
    await rig.seed(two(), activeA());
    await feedStale(rig, 2);
    const rotated = await rig.rotator.observe(currentObservation);
    expect(rotated).toMatchInlineSnapshot(`
      {
        "freshness": "current",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "second",
        "toTokenId": "tok-b",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。**\`usable\` と確かめられた候補は見つからなかった**ので、判定できなかった候補「second」へ倒した——撒いて本番で確かめる（probe timed out (tok-b)）
      前の現役「first」（id tok-a）に対して、もう回した後の通知を計2件捨てて、この連なりは終わった（**間引きで出していない件も含めた総数**。**プロセスが落ちた（デーモンが入れ替わった）ときは、この連なりの総数は出ない**——この計器はプロセスの寿命でしか持たないためである）",
      }
    `);
  });

  it('指名が無い回に連なりは無い（stale は active が在るときにしか起きないので、終わりの一文は付かない）', async () => {
    const rig = makeRig();
    await rig.seed(two(), null);
    const first = await rig.rotator.observe({ notice: reached });
    const second = await rig.rotator.observe({ notice: reached });
    expect(first).toMatchInlineSnapshot(`
      {
        "freshness": "unknown",
        "generation": 1,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "first",
        "toTokenId": "tok-a",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。候補「first」は観測できた",
      }
    `);
    expect(second).toMatchInlineSnapshot(`
      {
        "freshness": "unknown",
        "fromTokenId": "tok-a",
        "generation": 2,
        "kind": "rotated",
        "signal": "reached",
        "spread": [
          {
            "ok": true,
            "target": "runner-primary",
          },
        ],
        "toLabel": "second",
        "toTokenId": "tok-b",
        "why": "仕事が止まった文言が出た（設定に関わらず回す）。候補「second」は観測できた",
      }
    `);
  });
});

describe('周回（await を足さない・外さない）', () => {
  async function ticksFor(
    options: RigOptions,
    rows: AgentToken[],
    active: ActiveAgentToken | null,
    run: (rig: Rig) => Promise<TokenRotationOutcome>,
  ): Promise<{ kind: string; settledAtTick: number }> {
    const rig = makeRig(options);
    await rig.seed(rows, active);
    const { outcome, settledAtTick } = await settle(rig, () => run(rig));
    return { kind: outcome.kind, settledAtTick };
  }

  it('各枝が戻るまでの周回数', async () => {
    const observe = (rig: Rig): Promise<TokenRotationOutcome> =>
      rig.rotator.observe(currentObservation);
    const reconsider = (rig: Rig): Promise<TokenRotationOutcome> =>
      rig.rotator.reconsider({ reason: 'tick' });
    const results = {
      rotatedNoPatch: await ticksFor({}, four(), activeA(), observe),
      rotatedWithPatch: await ticksFor(
        { verdictOf: (id) => (id === 'tok-b' ? unusable(NOW + HOUR) : { verdict: 'usable' }) },
        four(),
        activeA(),
        observe,
      ),
      parkedNoProbe: await ticksFor(
        {},
        [row('tok-a', 0), row('tok-b', 1, { cooldownUntil: NOW + HOUR })],
        activeA(),
        observe,
      ),
      exhaustedNoCandidate: await ticksFor({}, [row('tok-a', 0)], activeA(), observe),
      exhaustedWithPatch: await ticksFor(
        { verdictOf: () => unusable() },
        two(),
        activeA(),
        observe,
      ),
      withheld: await ticksFor(
        {
          onProbe: async (_id, stores) => {
            await patchRows(stores, (rows) => rows.filter((r) => r.id !== 'tok-b'));
          },
        },
        two(),
        activeA(),
        observe,
      ),
      reconsiderRotated: await ticksFor(
        {},
        [row('tok-a', 0, { cooldownUntil: NOW + HOUR }), row('tok-b', 1)],
        activeA(),
        reconsider,
      ),
    };
    expect(results).toMatchInlineSnapshot(`
      {
        "exhaustedNoCandidate": {
          "kind": "exhausted",
          "settledAtTick": 19,
        },
        "exhaustedWithPatch": {
          "kind": "exhausted",
          "settledAtTick": 28,
        },
        "parkedNoProbe": {
          "kind": "parked",
          "settledAtTick": 25,
        },
        "reconsiderRotated": {
          "kind": "rotated",
          "settledAtTick": 15,
        },
        "rotatedNoPatch": {
          "kind": "rotated",
          "settledAtTick": 26,
        },
        "rotatedWithPatch": {
          "kind": "rotated",
          "settledAtTick": 36,
        },
        "withheld": {
          "kind": "ignored",
          "settledAtTick": 30,
        },
      }
    `);
  });
});
