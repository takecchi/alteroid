import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createTokenRotator,
  type TokenReconsiderReason,
  type TokenRotationOutcome,
  type TokenVerdictOrigin,
} from './token-rotator.js';
import { UnreadableActiveTokenError, UnreadableTokenSettingsError, type Stores } from './store.js';
import type { ActiveAgentToken, AgentToken } from './token-pool.js';
import type { TokenCandidateVerdict } from './token-candidate.js';

// `createTokenRotator` の中の `reconsiderLocked` の前半（`sweepCandidates` / `finishSweep` を呼ぶ**前**に、早い `return` で `ignored` などを返す判定）を、
// 外から見える結果だけで縛る。入口は `reconsider`（`reconsiderLocked` は内側の関数で、直接は呼べない）。`restore` は撒き直しの印（`spreadMark`）を作るためだけに使う。
// 縛るもの:
//   - 早い `return` の全枝の戻り値の全欄（欄が `undefined` のとき欄ごと無いこと）と `why` の全文
//   - `pool_changed` の撒き直しの全条件を 1 つずつ外した回が撒き直さないこと（と、撒き直す回の `generation` ・撒いた値・副作用の順序）
//   - 世代の門（`turn_success` / `trial` × current / stale）、身元の有る stale な `account_probe`（身元が無いときは掛けない）
//   - 副作用の順序と `await` の位置: 呼び出しの記録（`list` / `readSettings` / `readActive` / `now` / `replace` / `writeActive` / `spread`）に、
//     呼ばれたマイクロタスクの周回（`t<n>`）と、戻るまでの周回数（`settledAtTick`）を付ける
// 期待の文字列・欄・順序・周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（待つのはマイクロタスクの周回だけで、上限を持つ。時計は注入）。
//
// 作ってみて分かった、公開の入口からは通れない（縛れていない）枝・項:
//   - 撒き直しの条件の `active !== null`: `currentId`（= `active?.tokenId`）が `undefined` のときは先の「指名なし」の枝で返るので、ここへ来たときは常に非 null
//   - 世代の門・probe の stale の `observationFreshness` が `unknown` を返す形: origin の `observedBy` は `tokenId` / `generation` を必ず持ち、`active` が null の回は先に返る
//   - `reopened` の枝で `row?.label ?? currentId` の `currentId` 側: `row` が undefined なら `availability` は `dangling` で `ready` の枝に入らない

const AT = '2026-08-25T03:00:00.000Z';
const NOW = Date.parse(AT);
const HOUR = 3_600_000;

type Verdict = TokenCandidateVerdict;

interface Rig {
  stores: Stores;
  rotator: ReturnType<typeof createTokenRotator>;
  trace: string[];
  clock: { tick: number };
  broken: { settings?: string; active?: string };
  // 呼び出しの記録と周回を空にする（準備の中の呼び出しを数えないため）
  mark: () => void;
  count: (what: string) => number;
  raw: { list: () => Promise<AgentToken[]>; readActive: () => Promise<ActiveAgentToken | null> };
}

function makeRig(): Rig {
  const stores = createMemoryStores();
  const trace: string[] = [];
  const clock = { tick: 0 };
  const broken: Rig['broken'] = {};
  const note = (what: string): void => {
    trace.push(`t${String(clock.tick)} ${what}`);
  };

  const raw = {
    list: stores.tokens.list.bind(stores.tokens),
    readSettings: stores.tokens.readSettings.bind(stores.tokens),
    readActive: stores.tokens.readActive.bind(stores.tokens),
    replace: stores.tokens.replace.bind(stores.tokens),
    writeActive: stores.tokens.writeActive.bind(stores.tokens),
  };
  stores.tokens.list = async () => {
    note('list');
    return await raw.list();
  };
  stores.tokens.readSettings = async () => {
    note('readSettings');
    if (broken.settings !== undefined) throw new UnreadableTokenSettingsError(broken.settings);
    return await raw.readSettings();
  };
  stores.tokens.readActive = async () => {
    note('readActive');
    if (broken.active !== undefined) throw new UnreadableActiveTokenError(broken.active);
    return await raw.readActive();
  };
  stores.tokens.replace = async (rows) => {
    note(
      `replace ${rows
        .map((one) => one.id + (one.cooldownUntil === undefined ? '' : '*'))
        .join(',')}`,
    );
    return await raw.replace(rows);
  };
  stores.tokens.writeActive = async (active) => {
    note(`writeActive ${active.tokenId}#${String(active.generation)}`);
    return await raw.writeActive(active);
  };

  const rotator = createTokenRotator({
    stores,
    probe: {
      async probe(token) {
        note(`probe ${token.id}`);
        return { verdict: 'usable' };
      },
    },
    spread: {
      async spread(token) {
        note(`spread ${token.id}#${String(token.generation)} ${token.value}`);
        return [{ target: 'runner-primary', ok: true }];
      },
    },
    now: () => {
      note('now');
      return new Date(NOW);
    },
  });

  return {
    stores,
    rotator,
    trace,
    clock,
    broken,
    mark: () => {
      trace.length = 0;
      clock.tick = 0;
    },
    count: (what) =>
      trace.filter((line) => line.slice(line.indexOf(' ') + 1).startsWith(what)).length,
    raw: { list: raw.list, readActive: raw.readActive },
  };
}

function row(id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken {
  const labels: Record<string, string> = { 'tok-a': 'first', 'tok-b': 'second' };
  return { id, label: labels[id] ?? id, value: `value-${id.slice(4)}`, order, ...extra };
}

const two = (): AgentToken[] => [row('tok-a', 0), row('tok-b', 1)];
const activeA = (generation = 1): ActiveAgentToken => ({
  tokenId: 'tok-a',
  generation,
  rotatedAt: AT,
});
const activeB = (generation = 1): ActiveAgentToken => ({
  tokenId: 'tok-b',
  generation,
  rotatedAt: AT,
});

function without(token: AgentToken, key: 'value' | 'cooldownUntil'): AgentToken {
  const copy: AgentToken = { ...token };
  delete copy[key];
  return copy;
}

async function seeded(
  rows: AgentToken[],
  active: ActiveAgentToken | null,
  options: { off?: boolean } = {},
): Promise<Rig> {
  const rig = makeRig();
  await rig.stores.tokens.replace(rows);
  if (active !== null) await rig.stores.tokens.writeActive(active);
  if (options.off === true) {
    await rig.stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 1_000 });
  }
  return rig;
}

// restore で撒かせて `spreadMark`（tok-a の世代 1・value-a の指紋）を作る
async function primed(rows: AgentToken[] = two(), options: { off?: boolean } = {}): Promise<Rig> {
  const rig = await seeded(rows, activeA(), options);
  const restored = await rig.rotator.restore();
  expect(restored.kind).toBe('restored');
  return rig;
}

async function patchRows(rig: Rig, mutate: (rows: AgentToken[]) => AgentToken[]): Promise<void> {
  await rig.stores.tokens.replace(mutate(await rig.raw.list()));
}

function patchRow(rig: Rig, id: string, change: (token: AgentToken) => AgentToken): Promise<void> {
  return patchRows(rig, (rows) => rows.map((one) => (one.id === id ? change(one) : one)));
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

interface Scene {
  rig: Rig;
  start: () => Promise<TokenRotationOutcome>;
}

const reconsider = (
  rig: Rig,
  reason: TokenReconsiderReason,
  current?: { verdict: Verdict; origin: TokenVerdictOrigin },
): Scene => ({
  rig,
  start: () => rig.rotator.reconsider(current === undefined ? { reason } : { reason, current }),
});

// 1 つの場面を流して、戻り値・戻るまでの周回数・呼び出しの記録・行と現役の指名が変わったかを返す
async function runScene(build: () => Promise<Scene>): Promise<{
  outcome: TokenRotationOutcome;
  settledAtTick: number;
  trace: string[];
  rowsChanged: boolean;
  activeAfter: ActiveAgentToken | null;
}> {
  const { rig, start } = await build();
  const before = await rig.raw.list();
  rig.mark();
  const { outcome, settledAtTick } = await settle(rig, start);
  const trace = [...rig.trace];
  const after = await rig.raw.list();
  return {
    outcome,
    settledAtTick,
    trace,
    rowsChanged: !isDeepStrictEqual(before, after),
    activeAfter: await rig.raw.readActive(),
  };
}

async function gallery(
  builds: Record<string, () => Promise<Scene>>,
): Promise<Record<string, Awaited<ReturnType<typeof runScene>>>> {
  const result: Record<string, Awaited<ReturnType<typeof runScene>>> = {};
  for (const [name, build] of Object.entries(builds)) result[name] = await runScene(build);
  return result;
}

const turnSuccess = (generation = 1, tokenId = 'tok-a'): TokenVerdictOrigin => ({
  source: 'turn_success',
  observedBy: { tokenId, generation },
});
const trial = (generation = 1, tokenId = 'tok-a'): TokenVerdictOrigin => ({
  source: 'trial',
  observedBy: { tokenId, generation },
});
const usable: Verdict = { verdict: 'usable' };

describe('早い return: プールが空・指名なし（指名の前の 4 枝）', () => {
  it('戻り値の全欄・why の全文・周回数・呼び出しの記録', async () => {
    const result = await gallery({
      プールが空: async () => reconsider(await seeded([], null), 'tick'),
      プールが空_指名と設定が読めなくても空が先: async () => {
        const rig = await seeded([], activeA());
        rig.broken.settings = '設定が壊れている';
        rig.broken.active = '指名が壊れている';
        return reconsider(rig, 'startup', { verdict: usable, origin: turnSuccess() });
      },
      指名なし_turn_succeeded: async () => reconsider(await seeded(two(), null), 'turn_succeeded'),
      指名なし_turn_succeeded_は設定が読めなくても成功の枝が先: async () => {
        const rig = await seeded(two(), null);
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'turn_succeeded');
      },
      指名なし_turn_succeeded_は_off_でも成功の枝が先: async () =>
        reconsider(await seeded(two(), null, { off: true }), 'turn_succeeded'),
      指名なし_設定が読めない: async () => {
        const rig = await seeded(two(), null);
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'startup');
      },
      指名なし_off: async () => reconsider(await seeded(two(), null, { off: true }), 'startup'),
      指名が読めない_off_は指名なしと同じ枝: async () => {
        const rig = await seeded(two(), activeA(), { off: true });
        rig.broken.active = '指名が壊れている';
        return reconsider(rig, 'tick');
      },
      指名が読めない_turn_succeeded_は指名なしと同じ枝: async () => {
        const rig = await seeded(two(), activeA());
        rig.broken.active = '指名が壊れている';
        return reconsider(rig, 'turn_succeeded');
      },
      指名なし_trial_succeeded_は成功の枝ではなく先の枝へ進む: async () =>
        reconsider(await seeded(two(), null, { off: true }), 'trial_succeeded'),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "プールが空": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "none",
            "why": "プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "プールが空_指名と設定が読めなくても空が先": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "startup",
            "signal": "none",
            "why": "プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 5,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名が読めない_off_は指名なしと同じ枝": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "stranded",
            "why": "まだ一度も指名していない。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名が読めない_turn_succeeded_は指名なしと同じ枝": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_off": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "startup",
            "signal": "stranded",
            "why": "まだ一度も指名していない。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_trial_succeeded_は成功の枝ではなく先の枝へ進む": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "signal": "stranded",
            "why": "まだ一度も指名していない。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_turn_succeeded": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_turn_succeeded_は_off_でも成功の枝が先": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_turn_succeeded_は設定が読めなくても成功の枝が先": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_設定が読めない": {
          "activeAfter": null,
          "outcome": {
            "kind": "ignored",
            "reason": "startup",
            "signal": "settings_unreadable",
            "why": "まだ一度も指名していない。回転の設定が読めなかった（設定が壊れている）ので、この回は回さない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
      }
    `);
  });
});

describe('pool_changed の撒き直し', () => {
  it('全条件が揃った回: 戻り値の全欄・撒いた値・世代・副作用の順序と周回数', async () => {
    const result = await gallery({
      撒き直す: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
        return reconsider(rig, 'pool_changed');
      },
      現役の世代が_2_なら撒くのは_3: async () => {
        const rig = await seeded(two(), activeA(2));
        expect((await rig.rotator.restore()).kind).toBe('restored');
        await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
        return reconsider(rig, 'pool_changed');
      },
      冷却が明けた行は撒き直す_期限が過去: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({
          ...token,
          value: 'value-a2',
          cooldownUntil: NOW - HOUR,
        }));
        return reconsider(rig, 'pool_changed');
      },
      冷却の期限がちょうど_now_でも撒き直す_ready: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({
          ...token,
          value: 'value-a2',
          cooldownUntil: NOW,
        }));
        return reconsider(rig, 'pool_changed');
      },
      判定を持ち込んでも撒き直しが先_stale_な成功: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
        return reconsider(rig, 'pool_changed', { verdict: usable, origin: turnSuccess(0) });
      },
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "冷却が明けた行は撒き直す_期限が過去": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "fromTokenId": "tok-a",
            "generation": 2,
            "kind": "rotated",
            "reason": "pool_changed",
            "signal": "none",
            "spread": [
              {
                "ok": true,
                "target": "runner-primary",
              },
            ],
            "toLabel": "first",
            "toTokenId": "tok-a",
            "why": "現役「first」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した",
          },
          "rowsChanged": false,
          "settledAtTick": 10,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t4 writeActive tok-a#2",
            "t6 spread tok-a#2 value-a2",
          ],
        },
        "冷却の期限がちょうど_now_でも撒き直す_ready": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "fromTokenId": "tok-a",
            "generation": 2,
            "kind": "rotated",
            "reason": "pool_changed",
            "signal": "none",
            "spread": [
              {
                "ok": true,
                "target": "runner-primary",
              },
            ],
            "toLabel": "first",
            "toTokenId": "tok-a",
            "why": "現役「first」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した",
          },
          "rowsChanged": false,
          "settledAtTick": 10,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t4 writeActive tok-a#2",
            "t6 spread tok-a#2 value-a2",
          ],
        },
        "判定を持ち込んでも撒き直しが先_stale_な成功": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "fromTokenId": "tok-a",
            "generation": 2,
            "kind": "rotated",
            "reason": "pool_changed",
            "signal": "none",
            "spread": [
              {
                "ok": true,
                "target": "runner-primary",
              },
            ],
            "toLabel": "first",
            "toTokenId": "tok-a",
            "why": "現役「first」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した",
          },
          "rowsChanged": false,
          "settledAtTick": 10,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t4 writeActive tok-a#2",
            "t6 spread tok-a#2 value-a2",
          ],
        },
        "撒き直す": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "fromTokenId": "tok-a",
            "generation": 2,
            "kind": "rotated",
            "reason": "pool_changed",
            "signal": "none",
            "spread": [
              {
                "ok": true,
                "target": "runner-primary",
              },
            ],
            "toLabel": "first",
            "toTokenId": "tok-a",
            "why": "現役「first」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した",
          },
          "rowsChanged": false,
          "settledAtTick": 10,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t4 writeActive tok-a#2",
            "t6 spread tok-a#2 value-a2",
          ],
        },
        "現役の世代が_2_なら撒くのは_3": {
          "activeAfter": {
            "generation": 3,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "fromTokenId": "tok-a",
            "generation": 3,
            "kind": "rotated",
            "reason": "pool_changed",
            "signal": "none",
            "spread": [
              {
                "ok": true,
                "target": "runner-primary",
              },
            ],
            "toLabel": "first",
            "toTokenId": "tok-a",
            "why": "現役「first」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した",
          },
          "rowsChanged": false,
          "settledAtTick": 10,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t4 writeActive tok-a#3",
            "t6 spread tok-a#3 value-a2",
          ],
        },
      }
    `);
  });

  it('撒き直しの後は印が新しい値になるので、続けて来ても撒き直さない（世代は 1 回だけ上がる）', async () => {
    const rig = await primed();
    await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
    const first = await rig.rotator.reconsider({ reason: 'pool_changed' });
    const second = await rig.rotator.reconsider({ reason: 'pool_changed' });
    expect([first.kind, second.kind]).toEqual(['rotated', 'ignored']);
    expect(await rig.raw.readActive()).toEqual({
      tokenId: 'tok-a',
      generation: 2,
      rotatedAt: AT,
    });
  });

  it('条件を 1 つずつ外した回は撒き直さない（nominated は writeActive と spread の回数）', async () => {
    type Case = { rig: Rig; reason?: TokenReconsiderReason };
    const changed = (token: AgentToken): AgentToken => ({ ...token, value: 'value-a2' });
    const cases: Record<string, () => Promise<Case>> = {
      理由が_pool_changed_ではない_tick: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', changed);
        return { rig, reason: 'tick' };
      },
      理由が_pool_changed_ではない_settings_changed: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', changed);
        return { rig, reason: 'settings_changed' };
      },
      理由が_pool_changed_ではない_startup: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', changed);
        return { rig, reason: 'startup' };
      },
      行が無い: async () => {
        const rig = await primed(two(), { off: true });
        await patchRows(rig, (rows) => rows.filter((token) => token.id !== 'tok-a'));
        return { rig };
      },
      value_が_undefined: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => without(token, 'value'));
        return { rig };
      },
      value_が空文字: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({ ...token, value: '' }));
        return { rig };
      },
      撒いた印が無い_restore_していない: async () => {
        const rig = await seeded(two(), activeA());
        await patchRow(rig, 'tok-a', changed);
        return { rig };
      },
      印の_tokenId_が違う_現役は_tok_b: async () => {
        const rig = await primed();
        await rig.stores.tokens.writeActive(activeB());
        await patchRow(rig, 'tok-b', (token) => ({ ...token, value: 'value-b2' }));
        return { rig };
      },
      印の_generation_が違う_現役は世代_2: async () => {
        const rig = await primed();
        await rig.stores.tokens.writeActive(activeA(2));
        await patchRow(rig, 'tok-a', changed);
        return { rig };
      },
      指紋が同じ_ラベルだけ変えた: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({ ...token, label: 'renamed' }));
        return { rig };
      },
      指紋が同じ_何も変えていない: async () => ({ rig: await primed() }),
      ready_ではない_cooling: async () => {
        const rig = await primed(two(), { off: true });
        await patchRow(rig, 'tok-a', (token) => ({
          ...changed(token),
          cooldownUntil: NOW + HOUR,
        }));
        return { rig };
      },
      ready_ではない_disabled: async () => {
        const rig = await primed(two(), { off: true });
        await patchRow(rig, 'tok-a', (token) => ({ ...changed(token), disabledAt: AT }));
        return { rig };
      },
      ready_ではない_invalidated: async () => {
        const rig = await primed(two(), { off: true });
        await patchRow(rig, 'tok-a', (token) => ({ ...changed(token), invalidatedAt: AT }));
        return { rig };
      },
    };
    const result: Record<string, unknown> = {};
    for (const [name, build] of Object.entries(cases)) {
      const { rig, reason } = await build();
      rig.mark();
      const outcome = await rig.rotator.reconsider({ reason: reason ?? 'pool_changed' });
      result[name] = {
        outcome,
        nominated: { writeActive: rig.count('writeActive'), spread: rig.count('spread') },
      };
    }
    expect(result).toMatchInlineSnapshot(`
      {
        "ready_ではない_cooling": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "stranded",
            "why": "記録の上でいまの現役「first」は通らない（cooling）。回す契機の設定が off なので回さない（記録だけする）",
          },
        },
        "ready_ではない_disabled": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "stranded",
            "why": "記録の上でいまの現役「first」は通らない（disabled）。回す契機の設定が off なので回さない（記録だけする）",
          },
        },
        "ready_ではない_invalidated": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "stranded",
            "why": "記録の上でいまの現役「first」は通らない（invalidated）。回す契機の設定が off なので回さない（記録だけする）",
          },
        },
        "value_が_undefined": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "value_が空文字": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "印の_generation_が違う_現役は世代_2": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "印の_tokenId_が違う_現役は_tok_b": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「second」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "指紋が同じ_ラベルだけ変えた": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「renamed」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "指紋が同じ_何も変えていない": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "撒いた印が無い_restore_していない": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "理由が_pool_changed_ではない_settings_changed": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "settings_changed",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "理由が_pool_changed_ではない_startup": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "startup",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "理由が_pool_changed_ではない_tick": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
        },
        "行が無い": {
          "nominated": {
            "spread": 0,
            "writeActive": 0,
          },
          "outcome": {
            "kind": "ignored",
            "reason": "pool_changed",
            "signal": "stranded",
            "why": "現役として記録された id（tok-a）の行がプールに無い。回す契機の設定が off なので回さない（記録だけする）",
          },
        },
      }
    `);
  });

  it('value が無い行・空文字の行へ、撒き直しで credentialOf を投げさせない（reject しない）', async () => {
    for (const mutate of [
      (token: AgentToken) => without(token, 'value'),
      (token: AgentToken) => ({ ...token, value: '' }),
    ]) {
      const rig = await primed();
      await patchRow(rig, 'tok-a', mutate);
      await expect(rig.rotator.reconsider({ reason: 'pool_changed' })).resolves.toMatchObject({
        kind: 'ignored',
      });
    }
  });
});

describe('世代の門と身元の有る stale な probe', () => {
  it('turn_success / trial × 世代・id の合う合わない（捨てるときの why の全文）', async () => {
    const result = await gallery({
      turn_success_世代が古い: async () =>
        reconsider(await seeded(two(), activeA(2)), 'turn_succeeded', {
          verdict: usable,
          origin: turnSuccess(1),
        }),
      turn_success_世代が先: async () =>
        reconsider(await seeded(two(), activeA(1)), 'turn_succeeded', {
          verdict: usable,
          origin: turnSuccess(2),
        }),
      turn_success_id_が違う: async () =>
        reconsider(await seeded(two(), activeA(1)), 'turn_succeeded', {
          verdict: usable,
          origin: turnSuccess(1, 'tok-b'),
        }),
      turn_success_stale_で判定が_unusable_でも捨てる_行へ書かない: async () =>
        reconsider(await seeded(two(), activeA(2)), 'turn_succeeded', {
          verdict: { verdict: 'unusable', reason: 'limit', retryAt: NOW + HOUR },
          origin: turnSuccess(1),
        }),
      trial_世代が古い: async () =>
        reconsider(await seeded(two(), activeA(2)), 'trial_succeeded', {
          verdict: usable,
          origin: trial(1),
        }),
      trial_id_が違う: async () =>
        reconsider(await seeded(two(), activeA(1)), 'trial_succeeded', {
          verdict: usable,
          origin: trial(1, 'tok-b'),
        }),
      stale_でも_reason_が_tick_なら門の_why_は同じ: async () =>
        reconsider(await seeded(two(), activeA(2)), 'tick', {
          verdict: usable,
          origin: turnSuccess(1),
        }),
      turn_success_current_は門を通って現役の記録へ: async () =>
        reconsider(await seeded(two(), activeA(1)), 'turn_succeeded', {
          verdict: usable,
          origin: turnSuccess(1),
        }),
      trial_current_は門を通って現役の記録へ: async () =>
        reconsider(await seeded(two(), activeA(1)), 'trial_succeeded', {
          verdict: usable,
          origin: trial(1),
        }),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "stale_でも_reason_が_tick_なら門の_why_は同じ": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "none",
            "why": "ターンの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "trial_current_は門を通って現役の記録へ": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "signal": "none",
            "why": "現役「first」は試しで通ることを観測した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "trial_id_が違う": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "signal": "none",
            "why": "試しの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "trial_世代が古い": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "signal": "none",
            "why": "試しの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_success_current_は門を通って現役の記録へ": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "turn_success_id_が違う": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_success_stale_で判定が_unusable_でも捨てる_行へ書かない": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_success_世代が先": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_success_世代が古い": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、世代が合わない（もう回した後、あるいはまだ一度も試していない現役についての成功なので、捨てる）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
      }
    `);
  });

  it('account_probe は身元が有って stale のときだけ捨てる（世代違い・id 違いは捨てる、身元が無いときと current は掛けない）', async () => {
    const probe = (
      observedBy?: { tokenId: string; generation: number },
      verdict: Verdict = usable,
    ): { verdict: Verdict; origin: TokenVerdictOrigin } => ({
      verdict,
      origin:
        observedBy === undefined
          ? { source: 'account_probe' }
          : { source: 'account_probe', observedBy },
    });
    const result = await gallery({
      probe_世代が古い: async () =>
        reconsider(
          await seeded(two(), activeA(2)),
          'account_probe',
          probe({ tokenId: 'tok-a', generation: 1 }),
        ),
      probe_id_が違う: async () =>
        reconsider(
          await seeded(two(), activeA(1)),
          'account_probe',
          probe({ tokenId: 'tok-b', generation: 1 }),
        ),
      probe_stale_で判定が_unusable_でも捨てる_行へ書かない: async () =>
        reconsider(
          await seeded(two(), activeA(2)),
          'account_probe',
          probe(
            { tokenId: 'tok-a', generation: 1 },
            { verdict: 'unusable', reason: 'limit', retryAt: NOW + HOUR },
          ),
        ),
      probe_身元が無いなら世代が合わなくても掛けない: async () =>
        reconsider(await seeded(two(), activeA(2)), 'account_probe', probe()),
      probe_current_は掛けない: async () =>
        reconsider(
          await seeded(two(), activeA(1)),
          'account_probe',
          probe({ tokenId: 'tok-a', generation: 1 }),
        ),
      判定を持たない_account_probe_の契機は掛けない: async () =>
        reconsider(await seeded(two(), activeA(2)), 'account_probe'),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "probe_current_は掛けない": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "現役「first」はprobe で通ることを観測した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "probe_id_が違う": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "枠の probe を観測したが、測った鍵がもう現役ではない（測っている間に回った）ので、その判定は現役へ当てずに捨てる",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "probe_stale_で判定が_unusable_でも捨てる_行へ書かない": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "枠の probe を観測したが、測った鍵がもう現役ではない（測っている間に回った）ので、その判定は現役へ当てずに捨てる",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "probe_世代が古い": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "枠の probe を観測したが、測った鍵がもう現役ではない（測っている間に回った）ので、その判定は現役へ当てずに捨てる",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "probe_身元が無いなら世代が合わなくても掛けない": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "現役「first」はprobe で通ることを観測した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "判定を持たない_account_probe_の契機は掛けない": {
          "activeAfter": {
            "generation": 2,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
      }
    `);
  });
});

describe('現役が通る（usable の判定）と、判定が反映できなかった成功', () => {
  it('回す契機が無い（3 つの出所の why）・止まった記録を消す recovered・人間の判断には触らない', async () => {
    const rejected = (extra: Partial<AgentToken> = {}): Partial<AgentToken> => ({
      lastRejectedAt: '2026-08-25T02:00:00.000Z',
      lastRejectedReason: 'limit reached',
      cooldownUntil: NOW + HOUR,
      cooldownSource: 'quota_reset',
      ...extra,
    });
    const result = await gallery({
      turn_success_健全: async () =>
        reconsider(await seeded(two(), activeA()), 'turn_succeeded', {
          verdict: usable,
          origin: turnSuccess(),
        }),
      trial_健全: async () =>
        reconsider(await seeded(two(), activeA()), 'trial_succeeded', {
          verdict: usable,
          origin: trial(),
        }),
      probe_健全_身元あり: async () =>
        reconsider(await seeded(two(), activeA()), 'account_probe', {
          verdict: usable,
          origin: { source: 'account_probe', observedBy: { tokenId: 'tok-a', generation: 1 } },
        }),
      probe_健全_身元なし: async () =>
        reconsider(await seeded(two(), activeA()), 'account_probe', {
          verdict: usable,
          origin: { source: 'account_probe' },
        }),
      turn_success_止まった記録を消す_recovered: async () =>
        reconsider(
          await seeded([row('tok-a', 0, rejected()), row('tok-b', 1)], activeA()),
          'turn_succeeded',
          {
            verdict: usable,
            origin: turnSuccess(),
          },
        ),
      trial_止まった記録を消す_recovered: async () =>
        reconsider(
          await seeded([row('tok-a', 0, rejected()), row('tok-b', 1)], activeA()),
          'trial_succeeded',
          {
            verdict: usable,
            origin: trial(),
          },
        ),
      probe_止まった記録を消す_recovered: async () =>
        reconsider(
          await seeded([row('tok-a', 0, rejected()), row('tok-b', 1)], activeA()),
          'account_probe',
          {
            verdict: usable,
            origin: { source: 'account_probe' },
          },
        ),
      lastRejectedAt_だけでも消す: async () =>
        reconsider(
          await seeded(
            [row('tok-a', 0, { lastRejectedAt: '2026-08-25T02:00:00.000Z' }), row('tok-b', 1)],
            activeA(),
          ),
          'turn_succeeded',
          { verdict: usable, origin: turnSuccess() },
        ),
      cooldownUntil_だけでも消す_期限が過去: async () =>
        reconsider(
          await seeded(
            [row('tok-a', 0, { cooldownUntil: NOW - HOUR }), row('tok-b', 1)],
            activeA(),
          ),
          'turn_succeeded',
          { verdict: usable, origin: turnSuccess() },
        ),
      disabled_は消さない: async () =>
        reconsider(
          await seeded([row('tok-a', 0, rejected({ disabledAt: AT })), row('tok-b', 1)], activeA()),
          'turn_succeeded',
          { verdict: usable, origin: turnSuccess() },
        ),
      invalidated_は消さない: async () =>
        reconsider(
          await seeded(
            [
              row('tok-a', 0, rejected({ invalidatedAt: AT, invalidatedReason: 'revoked' })),
              row('tok-b', 1),
            ],
            activeA(),
          ),
          'turn_succeeded',
          { verdict: usable, origin: turnSuccess() },
        ),
      止まった記録が無い_disabled_だけ: async () =>
        reconsider(
          await seeded([row('tok-a', 0, { disabledAt: AT }), row('tok-b', 1)], activeA()),
          'turn_succeeded',
          { verdict: usable, origin: turnSuccess() },
        ),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "cooldownUntil_だけでも消す_期限が過去": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "recovered": {
              "label": "first",
              "source": "turn_success",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t5 list",
            "t7 replace tok-a,tok-b",
            "t7 list",
          ],
        },
        "disabled_は消さない": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "invalidated_は消さない": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "lastRejectedAt_だけでも消す": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "recovered": {
              "label": "first",
              "source": "turn_success",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t5 list",
            "t7 replace tok-a,tok-b",
            "t7 list",
          ],
        },
        "probe_健全_身元あり": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "現役「first」はprobe で通ることを観測した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "probe_健全_身元なし": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "現役「first」はprobe で通ることを観測した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "probe_止まった記録を消す_recovered": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "recovered": {
              "label": "first",
              "source": "account_probe",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」はprobe で通ることを観測した（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t5 list",
            "t7 replace tok-a,tok-b",
            "t7 list",
          ],
        },
        "trial_健全": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "signal": "none",
            "why": "現役「first」は試しで通ることを観測した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "trial_止まった記録を消す_recovered": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "recovered": {
              "label": "first",
              "source": "trial",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」は試しで通ることを観測した（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t5 list",
            "t7 replace tok-a,tok-b",
            "t7 list",
          ],
        },
        "turn_success_健全": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "turn_success_止まった記録を消す_recovered": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "recovered": {
              "label": "first",
              "source": "turn_success",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t4 now",
            "t5 list",
            "t7 replace tok-a,tok-b",
            "t7 list",
          ],
        },
        "止まった記録が無い_disabled_だけ": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "現役「first」はターンが実際に成功した（回す契機が無い）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
      }
    `);
  });

  it('recovered で行に書くのは markTokenUsable の結果（updatedAt は now の時刻・止まった欄は欄ごと無い・他の行は触らない）', async () => {
    const rig = await seeded(
      [
        row('tok-a', 0, {
          lastRejectedAt: '2026-08-25T02:00:00.000Z',
          lastRejectedReason: 'limit reached',
          cooldownUntil: NOW + HOUR,
          cooldownSource: 'quota_reset',
        }),
        row('tok-b', 1, { cooldownUntil: NOW + 2 * HOUR }),
      ],
      activeA(),
    );
    await rig.rotator.reconsider({
      reason: 'turn_succeeded',
      current: { verdict: usable, origin: turnSuccess() },
    });
    expect(await rig.raw.list()).toMatchInlineSnapshot(`
      [
        {
          "id": "tok-a",
          "label": "first",
          "order": 0,
          "updatedAt": "2026-08-25T03:00:00.000Z",
          "value": "value-a",
        },
        {
          "cooldownUntil": 1787634000000,
          "id": "tok-b",
          "label": "second",
          "order": 1,
          "value": "value-b",
        },
      ]
    `);
  });

  it('現役の記録に反映できなかった成功（行が無い等）と、行が無いままの probe の判定', async () => {
    const dangling = async (): Promise<Rig> => {
      const rig = await seeded([row('tok-b', 1)], activeA(), { off: true });
      return rig;
    };
    const result = await gallery({
      turn_succeeded_判定なし_現役あり: async () =>
        reconsider(await seeded(two(), activeA()), 'turn_succeeded'),
      turn_succeeded_判定が_unusable: async () =>
        reconsider(await seeded(two(), activeA()), 'turn_succeeded', {
          verdict: { verdict: 'unusable', reason: 'limit', retryAt: NOW + HOUR },
          origin: turnSuccess(),
        }),
      turn_succeeded_行が無い_turn_success: async () =>
        reconsider(await dangling(), 'turn_succeeded', { verdict: usable, origin: turnSuccess() }),
      trial_の判定が_unusable_reason_は_tick: async () =>
        reconsider(await seeded(two(), activeA()), 'tick', {
          verdict: { verdict: 'unusable', reason: 'limit' },
          origin: trial(),
        }),
      trial_行が無い_reason_は_trial_succeeded: async () =>
        reconsider(await dangling(), 'trial_succeeded', { verdict: usable, origin: trial() }),
      trial_行が無い_reason_は_tick: async () =>
        reconsider(await dangling(), 'tick', { verdict: usable, origin: trial() }),
      turn_succeeded_で_trial_の判定_なら試しの文言: async () =>
        reconsider(await seeded(two(), activeA()), 'turn_succeeded', {
          verdict: { verdict: 'unusable', reason: 'limit' },
          origin: trial(),
        }),
      probe_行が無い_は成功の枝へ入らず_dangling_として先へ: async () =>
        reconsider(await dangling(), 'account_probe', {
          verdict: usable,
          origin: { source: 'account_probe' },
        }),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "probe_行が無い_は成功の枝へ入らず_dangling_として先へ": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "stranded",
            "why": "現役として記録された id（tok-a）の行がプールに無い。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "trial_の判定が_unusable_reason_は_tick": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "none",
            "why": "試しの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "trial_行が無い_reason_は_tick": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "none",
            "why": "試しの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "trial_行が無い_reason_は_trial_succeeded": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "trial_succeeded",
            "signal": "none",
            "why": "試しの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_succeeded_で_trial_の判定_なら試しの文言": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "試しの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_succeeded_判定が_unusable": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_succeeded_判定なし_現役あり": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "turn_succeeded_行が無い_turn_success": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "turn_succeeded",
            "signal": "none",
            "why": "ターンの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
      }
    `);
  });

  it('usable の判定でも、行に止まった記録が無い回は覚えている拒否を忘れる（無条件に忘れる）', async () => {
    // 覚えさせる: rotateOn が rejected でも回らない形（transition なし）で facts + statusNow だけ渡す
    const resetsAt = NOW + 90 * 60_000;
    const guess = NOW + 5 * HOUR;
    const run = async (forget: boolean): Promise<number | undefined> => {
      const rig = await seeded(two(), activeA());
      await rig.rotator.observe({
        facts: { kind: 'five_hour', status: 'rejected', resetsAt },
        statusNow: 'rejected',
      });
      if (forget) {
        await rig.rotator.reconsider({
          reason: 'turn_succeeded',
          current: { verdict: usable, origin: turnSuccess() },
        });
      }
      await rig.rotator.observe({
        notice: { kind: 'reached', text: "You've hit your org's monthly spend limit" },
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });
      return (await rig.raw.list()).find((token) => token.id === 'tok-a')?.cooldownUntil;
    };
    expect(await run(false)).toBe(resetsAt);
    expect(await run(true)).toBe(guess);
  });
});

describe('判定が unusable（probe）の回: 冷却を書いてから、記録の上の現役の状態で返る', () => {
  const unusable = (retryAt?: number): Verdict =>
    retryAt === undefined
      ? { verdict: 'unusable', reason: 'probe: limit reached' }
      : { verdict: 'unusable', reason: 'probe: limit reached', retryAt };
  const probe = (verdict: Verdict) => ({
    verdict,
    origin: { source: 'account_probe' } as const,
  });

  it('書いた行の全欄（message は判定の reason・resets は retryAt・期限が無ければ設定の cooldownMs）', async () => {
    const withResets = await seeded(two(), activeA(), { off: true });
    await withResets.rotator.reconsider({
      reason: 'account_probe',
      current: probe(unusable(NOW + HOUR)),
    });
    const withoutResets = await seeded(two(), activeA(), { off: true });
    await withoutResets.rotator.reconsider({
      reason: 'account_probe',
      current: probe(unusable()),
    });
    expect({
      retryAt_有り: await withResets.raw.list(),
      retryAt_無し: await withoutResets.raw.list(),
    }).toMatchInlineSnapshot(`
      {
        "retryAt_有り": [
          {
            "cooldownSource": "quota_reset",
            "cooldownUntil": 1787630400000,
            "id": "tok-a",
            "label": "first",
            "lastRejectedAt": "2026-08-25T03:00:00.000Z",
            "lastRejectedReason": "probe: limit reached",
            "order": 0,
            "updatedAt": "2026-08-25T03:00:00.000Z",
            "value": "value-a",
          },
          {
            "id": "tok-b",
            "label": "second",
            "order": 1,
            "value": "value-b",
          },
        ],
        "retryAt_無し": [
          {
            "cooldownSource": "default",
            "cooldownUntil": 1787626801000,
            "id": "tok-a",
            "label": "first",
            "lastRejectedAt": "2026-08-25T03:00:00.000Z",
            "lastRejectedReason": "probe: limit reached",
            "order": 0,
            "updatedAt": "2026-08-25T03:00:00.000Z",
            "value": "value-a",
          },
          {
            "id": "tok-b",
            "label": "second",
            "order": 1,
            "value": "value-b",
          },
        ],
      }
    `);
  });

  it('設定が読めない・off・冷却を書けない回の戻り値の全欄と why の全文', async () => {
    const result = await gallery({
      設定が読めない_retryAt_有り_冷却は書いて_settings_unreadable: async () => {
        const rig = await seeded(two(), activeA());
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'account_probe', probe(unusable(NOW + HOUR)));
      },
      設定が読めない_retryAt_無し_冷却を書けず_ready_のまま_settings_unreadable: async () => {
        const rig = await seeded(two(), activeA());
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'account_probe', probe(unusable()));
      },
      off_retryAt_無し_設定は読めるので冷却を書いて_stranded: async () =>
        reconsider(
          await seeded(two(), activeA(), { off: true }),
          'account_probe',
          probe(unusable()),
        ),
      off_retryAt_有り: async () =>
        reconsider(
          await seeded(two(), activeA(), { off: true }),
          'account_probe',
          probe(unusable(NOW + HOUR)),
        ),
      off_retryAt_が過去なら_ready_のまま_冷却は書いてあるが回す契機が無い: async () =>
        reconsider(
          await seeded(two(), activeA(), { off: true }),
          'account_probe',
          probe(unusable(NOW - HOUR)),
        ),
      undecidable_は何も書かず_現役が通る記録のまま: async () =>
        reconsider(await seeded(two(), activeA(), { off: true }), 'account_probe', {
          verdict: { verdict: 'undecidable', reason: '決められない' },
          origin: { source: 'account_probe' },
        }),
      行が無い_unusable_は書けず_dangling: async () =>
        reconsider(
          await seeded([row('tok-b', 1)], activeA(), { off: true }),
          'account_probe',
          probe(unusable(NOW + HOUR)),
        ),
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "off_retryAt_が過去なら_ready_のまま_冷却は書いてあるが回す契機が無い": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "reopened": {
              "cooldownUntil": "2026-08-25T02:00:00.000Z",
              "label": "first",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」の冷却が明けた（2026-08-25T02:00:00.000Z）。**時計で明けたのであって、通ることを観測したわけではない**",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t5 list",
            "t7 replace tok-a*,tok-b",
            "t7 list",
            "t14 now",
          ],
        },
        "off_retryAt_有り": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "stranded",
            "why": "現役「first」は probe で通らないことを観測した（probe: limit reached）。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t5 list",
            "t7 replace tok-a*,tok-b",
            "t7 list",
            "t14 now",
          ],
        },
        "off_retryAt_無し_設定は読めるので冷却を書いて_stranded": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "stranded",
            "why": "現役「first」は probe で通らないことを観測した（probe: limit reached）。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t5 list",
            "t7 replace tok-a*,tok-b",
            "t7 list",
            "t14 now",
          ],
        },
        "undecidable_は何も書かず_現役が通る記録のまま": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "行が無い_unusable_は書けず_dangling": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "stranded",
            "why": "現役として記録された id（tok-a）の行がプールに無い。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "設定が読めない_retryAt_有り_冷却は書いて_settings_unreadable": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "settings_unreadable",
            "why": "現役「first」は probe で通らないことを観測した（probe: limit reached）。回転の設定が読めなかった（設定が壊れている）ので、この回は回さない",
          },
          "rowsChanged": true,
          "settledAtTick": 16,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
            "t5 list",
            "t7 replace tok-a*,tok-b",
            "t7 list",
            "t14 now",
          ],
        },
        "設定が読めない_retryAt_無し_冷却を書けず_ready_のまま_settings_unreadable": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "account_probe",
            "signal": "settings_unreadable",
            "why": "現役「first」は probe で通らないことを観測した（probe: limit reached）。回転の設定が読めなかったので冷却を書けず、この回は回さない（設定が壊れている）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
      }
    `);
  });
});

describe('現役が通る・冷却が明けた・通らない（ready / reopened / stranded の見送り）', () => {
  it('戻り値の全欄と why の全文（reopened は 1 回だけ。同じ期限は繰り返さない）', async () => {
    const reopenedRig = async (extra: Partial<AgentToken>, off = false): Promise<Rig> =>
      seeded(
        [row('tok-a', 0, { cooldownUntil: NOW - HOUR, ...extra }), row('tok-b', 1)],
        activeA(),
        {
          off,
        },
      );
    const result = await gallery({
      健全な現役: async () => reconsider(await seeded(two(), activeA()), 'tick'),
      冷却が明けた_reopened: async () => reconsider(await reopenedRig({}), 'tick'),
      冷却が明けた_off_でも出す: async () => reconsider(await reopenedRig({}, true), 'tick'),
      冷却がちょうど今明けた_reopened: async () =>
        reconsider(await reopenedRig({ cooldownUntil: NOW }), 'tick'),
      現役が_cooling_off: async () =>
        reconsider(
          await seeded(
            [row('tok-a', 0, { cooldownUntil: NOW + HOUR }), row('tok-b', 1)],
            activeA(),
            {
              off: true,
            },
          ),
          'tick',
        ),
      現役が_disabled_off: async () =>
        reconsider(
          await seeded([row('tok-a', 0, { disabledAt: AT }), row('tok-b', 1)], activeA(), {
            off: true,
          }),
          'tick',
        ),
      現役が_invalidated_off: async () =>
        reconsider(
          await seeded([row('tok-a', 0, { invalidatedAt: AT }), row('tok-b', 1)], activeA(), {
            off: true,
          }),
          'tick',
        ),
      現役の行が無い_dangling_off: async () =>
        reconsider(await seeded([row('tok-b', 1)], activeA(), { off: true }), 'tick'),
      現役が_cooling_設定が読めない: async () => {
        const rig = await seeded(
          [row('tok-a', 0, { cooldownUntil: NOW + HOUR }), row('tok-b', 1)],
          activeA(),
        );
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'tick');
      },
      現役の行が無い_設定が読めない: async () => {
        const rig = await seeded([row('tok-b', 1)], activeA());
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'tick');
      },
      現役が_disabled_設定が読めない: async () => {
        const rig = await seeded([row('tok-a', 0, { disabledAt: AT }), row('tok-b', 1)], activeA());
        rig.broken.settings = '設定が壊れている';
        return reconsider(rig, 'tick');
      },
    });
    expect(result).toMatchInlineSnapshot(`
      {
        "健全な現役": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "none",
            "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "冷却がちょうど今明けた_reopened": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "reopened": {
              "cooldownUntil": "2026-08-25T03:00:00.000Z",
              "label": "first",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」の冷却が明けた（2026-08-25T03:00:00.000Z）。**時計で明けたのであって、通ることを観測したわけではない**",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "冷却が明けた_off_でも出す": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "reopened": {
              "cooldownUntil": "2026-08-25T02:00:00.000Z",
              "label": "first",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」の冷却が明けた（2026-08-25T02:00:00.000Z）。**時計で明けたのであって、通ることを観測したわけではない**",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "冷却が明けた_reopened": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "reopened": {
              "cooldownUntil": "2026-08-25T02:00:00.000Z",
              "label": "first",
              "tokenId": "tok-a",
            },
            "signal": "none",
            "why": "現役「first」の冷却が明けた（2026-08-25T02:00:00.000Z）。**時計で明けたのであって、通ることを観測したわけではない**",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "現役が_cooling_off": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "stranded",
            "why": "記録の上でいまの現役「first」は通らない（cooling）。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "現役が_cooling_設定が読めない": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "settings_unreadable",
            "why": "記録の上でいまの現役「first」は通らない（cooling）。回転の設定が読めなかった（設定が壊れている）ので、この回は回さない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "現役が_disabled_off": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "stranded",
            "why": "記録の上でいまの現役「first」は通らない（disabled）。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "現役が_disabled_設定が読めない": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "settings_unreadable",
            "why": "記録の上でいまの現役「first」は通らない（disabled）。回転の設定が読めなかった（設定が壊れている）ので、この回は回さない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "現役が_invalidated_off": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "stranded",
            "why": "記録の上でいまの現役「first」は通らない（invalidated）。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t4 now",
          ],
        },
        "現役の行が無い_dangling_off": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "stranded",
            "why": "現役として記録された id（tok-a）の行がプールに無い。回す契機の設定が off なので回さない（記録だけする）",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "現役の行が無い_設定が読めない": {
          "activeAfter": {
            "generation": 1,
            "rotatedAt": "2026-08-25T03:00:00.000Z",
            "tokenId": "tok-a",
          },
          "outcome": {
            "kind": "ignored",
            "reason": "tick",
            "signal": "settings_unreadable",
            "why": "現役として記録された id（tok-a）の行がプールに無い。回転の設定が読めなかった（設定が壊れている）ので、この回は回さない",
          },
          "rowsChanged": false,
          "settledAtTick": 6,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
      }
    `);
  });

  it('reopened は同じ期限を 2 回出さず、期限が変われば出し直す。off でも同じ', async () => {
    const rig = await seeded(
      [row('tok-a', 0, { cooldownUntil: NOW - HOUR }), row('tok-b', 1)],
      activeA(),
      { off: true },
    );
    const first = await rig.rotator.reconsider({ reason: 'tick' });
    const second = await rig.rotator.reconsider({ reason: 'tick' });
    await patchRow(rig, 'tok-a', (token) => ({ ...token, cooldownUntil: NOW - 2 * HOUR }));
    const third = await rig.rotator.reconsider({ reason: 'tick' });
    // 期限が消えた後は、覚えている期限が残っていても reopened にならない（cooldownUntil が無い行を日付にしない）
    await patchRow(rig, 'tok-a', (token) => without(token, 'cooldownUntil'));
    const fourth = await rig.rotator.reconsider({ reason: 'tick' });
    expect([first, second, third, fourth]).toMatchInlineSnapshot(`
      [
        {
          "kind": "ignored",
          "reason": "tick",
          "reopened": {
            "cooldownUntil": "2026-08-25T02:00:00.000Z",
            "label": "first",
            "tokenId": "tok-a",
          },
          "signal": "none",
          "why": "現役「first」の冷却が明けた（2026-08-25T02:00:00.000Z）。**時計で明けたのであって、通ることを観測したわけではない**",
        },
        {
          "kind": "ignored",
          "reason": "tick",
          "signal": "none",
          "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
        },
        {
          "kind": "ignored",
          "reason": "tick",
          "reopened": {
            "cooldownUntil": "2026-08-25T01:00:00.000Z",
            "label": "first",
            "tokenId": "tok-a",
          },
          "signal": "none",
          "why": "現役「first」の冷却が明けた（2026-08-25T01:00:00.000Z）。**時計で明けたのであって、通ることを観測したわけではない**",
        },
        {
          "kind": "ignored",
          "reason": "tick",
          "signal": "none",
          "why": "記録の上ではいまの現役「first」が通る（回す契機が無い。健全な鍵から勝手に移らない）",
        },
      ]
    `);
  });
});

describe('副作用の順序・now() を読む回数・await の位置', () => {
  it('Promise.all の 3 本は同じ周回に、list → readSettings → readActive の順で起きる（逐次にしない）', async () => {
    const rig = await seeded(two(), activeA());
    rig.mark();
    const { settledAtTick } = await settle(rig, () => rig.rotator.reconsider({ reason: 'tick' }));
    const head = rig.trace.slice(0, 3);
    expect({ head, settledAtTick, trace: rig.trace }).toMatchInlineSnapshot(`
      {
        "head": [
          "t0 list",
          "t0 readSettings",
          "t0 readActive",
        ],
        "settledAtTick": 6,
        "trace": [
          "t0 list",
          "t0 readSettings",
          "t0 readActive",
          "t4 now",
        ],
      }
    `);
  });

  it('now() を読む回数: 条件が揃った回だけ撒き直しの可否で読む（先に落ちる条件の回は読まない）', async () => {
    const result: Record<string, { nowReads: number; trace: string[] }> = {};
    const note = (name: string, rig: Rig): void => {
      result[name] = { nowReads: rig.count('now'), trace: [...rig.trace] };
    };
    {
      const rig = await seeded([], null);
      rig.mark();
      await rig.rotator.reconsider({ reason: 'pool_changed' });
      note('プールが空', rig);
    }
    {
      const rig = await seeded(two(), null, { off: true });
      rig.mark();
      await rig.rotator.reconsider({ reason: 'pool_changed' });
      note('指名なし_off', rig);
    }
    {
      const rig = await primed();
      rig.mark();
      await rig.rotator.reconsider({ reason: 'tick' });
      note('撒き直さない_理由が違う_健全な現役（読むのは最後の 1 回だけ）', rig);
    }
    {
      const rig = await primed();
      rig.mark();
      await rig.rotator.reconsider({ reason: 'pool_changed' });
      note('撒き直さない_指紋が同じ_健全な現役（読むのは最後の 1 回だけ）', rig);
    }
    {
      const rig = await primed();
      await patchRow(rig, 'tok-a', (token) => without(token, 'value'));
      rig.mark();
      await rig.rotator.reconsider({ reason: 'pool_changed' });
      note('撒き直さない_value_が無い', rig);
    }
    {
      const rig = await seeded(two(), activeA());
      await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
      rig.mark();
      await rig.rotator.reconsider({ reason: 'pool_changed' });
      note('撒き直さない_印が無い', rig);
    }
    {
      const rig = await primed();
      await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
      rig.mark();
      await rig.rotator.reconsider({ reason: 'pool_changed' });
      note('撒き直す（条件の判定で 1 回・nominate の rotatedAt で 1 回）', rig);
    }
    {
      const rig = await seeded(two(), activeA(2));
      rig.mark();
      await rig.rotator.reconsider({
        reason: 'turn_succeeded',
        current: { verdict: usable, origin: turnSuccess(1) },
      });
      note('世代の門で捨てる', rig);
    }
    {
      const rig = await seeded(
        [row('tok-a', 0, { lastRejectedAt: '2026-08-25T02:00:00.000Z' }), row('tok-b', 1)],
        activeA(),
      );
      rig.mark();
      await rig.rotator.reconsider({
        reason: 'turn_succeeded',
        current: { verdict: usable, origin: turnSuccess() },
      });
      note('recovered（availability の判定で 1 回・recoveredAt で 1 回）', rig);
    }
    expect(result).toMatchInlineSnapshot(`
      {
        "recovered（availability の判定で 1 回・recoveredAt で 1 回）": {
          "nowReads": 2,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t0 now",
            "t0 now",
            "t0 list",
            "t0 replace tok-a,tok-b",
            "t0 list",
          ],
        },
        "プールが空": {
          "nowReads": 0,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "世代の門で捨てる": {
          "nowReads": 0,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "指名なし_off": {
          "nowReads": 0,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
          ],
        },
        "撒き直さない_value_が無い": {
          "nowReads": 1,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t0 now",
          ],
        },
        "撒き直さない_印が無い": {
          "nowReads": 1,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t0 now",
          ],
        },
        "撒き直さない_指紋が同じ_健全な現役（読むのは最後の 1 回だけ）": {
          "nowReads": 1,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t0 now",
          ],
        },
        "撒き直さない_理由が違う_健全な現役（読むのは最後の 1 回だけ）": {
          "nowReads": 1,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t0 now",
          ],
        },
        "撒き直す（条件の判定で 1 回・nominate の rotatedAt で 1 回）": {
          "nowReads": 2,
          "trace": [
            "t0 list",
            "t0 readSettings",
            "t0 readActive",
            "t0 now",
            "t0 now",
            "t0 writeActive tok-a#2",
            "t0 spread tok-a#2 value-a2",
          ],
        },
      }
    `);
  });

  it('入口ごとの await 位置: 周回数・呼び出しの周回（早い return の代表）', async () => {
    const result = await gallery({
      プールが空: async () => reconsider(await seeded([], null), 'tick'),
      指名なし_成功: async () => reconsider(await seeded(two(), null), 'turn_succeeded'),
      撒き直し: async () => {
        const rig = await primed();
        await patchRow(rig, 'tok-a', (token) => ({ ...token, value: 'value-a2' }));
        return reconsider(rig, 'pool_changed');
      },
      世代の門: async () =>
        reconsider(await seeded(two(), activeA(2)), 'turn_succeeded', {
          verdict: usable,
          origin: turnSuccess(1),
        }),
      recovered: async () =>
        reconsider(
          await seeded(
            [row('tok-a', 0, { cooldownUntil: NOW + HOUR }), row('tok-b', 1)],
            activeA(),
          ),
          'turn_succeeded',
          { verdict: usable, origin: turnSuccess() },
        ),
      probe_unusable_off: async () =>
        reconsider(await seeded(two(), activeA(), { off: true }), 'account_probe', {
          verdict: { verdict: 'unusable', reason: 'limit', retryAt: NOW + HOUR },
          origin: { source: 'account_probe' },
        }),
    });
    const ticks = Object.fromEntries(
      Object.entries(result).map(([name, one]) => [name, one.settledAtTick]),
    );
    expect(ticks).toMatchInlineSnapshot(`
      {
        "probe_unusable_off": 16,
        "recovered": 16,
        "プールが空": 6,
        "世代の門": 6,
        "指名なし_成功": 6,
        "撒き直し": 10,
      }
    `);
  });
});
