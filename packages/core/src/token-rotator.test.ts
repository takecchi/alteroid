import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createTokenRotator,
  describeTokenRestore,
  describeTokenRotation,
  tokenRestoreEntry,
  tokenRotationEntry,
  type TokenProbePort,
  type TokenSpreadPort,
  type TokenSpreadResult,
} from './token-rotator.js';
import type { Stores } from './store.js';
import type { UsageLimitNotice } from './usage-limits.js';
import type { TokenCredential } from './token-pool.js';

/**
 * 回し手（Issue #393 PR3）。**受け入れ基準を直接固定する場所である。**
 *
 * 1. 2本以上登録して1本目が止まったら、**クローンのターンを1つも使わずに**2本目へ回る
 * 4. 全部が冷却中のとき**先頭へ黙って戻らない**。いちばん早く戻る時刻が見える
 * 5. トークンの値が結果のどこにも出ない
 * 7. **プールが空の既定の構成が1文字も変わらない**
 */

const AT = '2026-08-25T03:00:00.000Z';
const reached: UsageLimitNotice = {
  kind: 'reached',
  text: "You've hit your org's monthly spend limit",
};

interface Harness {
  stores: Stores;
  spreadCalls: ({ id: string; generation: number } & TokenCredential)[];
  probeCalls: ({ id: string } & TokenCredential)[];
  /** `tokens.replace` を呼んだ回数。**まとめて1回**を固定するために数える。 */
  replaceCalls: () => number;
  rotator: ReturnType<typeof createTokenRotator>;
}

type Verdict = TokenProbePort['probe'] extends (t: never) => Promise<infer V> ? V : never;

function harness(
  options: {
    verdict?: Verdict;
    /** 候補ごとに違う判定を返す口。**`verdict` より優先する。** */
    verdictOf?: (id: string) => Verdict;
    /** probe 1本ぶんの見かけの所要時間（ミリ秒）。持ち時間の検査で使う。 */
    probeTakesMs?: number;
    spreadResults?: TokenSpreadResult[];
  } = {},
): Harness {
  const stores = createMemoryStores();
  const spreadCalls: ({ id: string; generation: number } & TokenCredential)[] = [];
  const probeCalls: ({ id: string } & TokenCredential)[] = [];

  // **時計は動かせる形にしておく。** 持ち時間は壁時計で切るので、止まった時計では
  // 「使い切った」を1回も作れない。
  let nowMs = Date.parse(AT);

  let replaceCount = 0;
  const realReplace = stores.tokens.replace.bind(stores.tokens);
  stores.tokens.replace = async (tokens) => {
    replaceCount += 1;
    return await realReplace(tokens);
  };

  const probe: TokenProbePort = {
    async probe(token) {
      probeCalls.push(token);
      nowMs += options.probeTakesMs ?? 0;
      return options.verdictOf?.(token.id) ?? options.verdict ?? { verdict: 'usable' };
    },
  };
  const spread: TokenSpreadPort = {
    async spread(token) {
      spreadCalls.push(token);
      return options.spreadResults ?? [{ target: 'runner-primary', ok: true }];
    },
  };

  const rotator = createTokenRotator({
    stores,
    probe,
    spread,
    now: () => new Date(nowMs),
  });
  return { stores, spreadCalls, probeCalls, replaceCalls: () => replaceCount, rotator };
}

/** プールに4本置いて、1本目を現役に指名する（候補は3本残る）。 */
async function seedFour(h: Harness): Promise<void> {
  await h.stores.tokens.replace([
    { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
    { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    { id: 'tok-c', label: 'third', value: 'value-c', order: 2 },
    { id: 'tok-d', label: 'fourth', value: 'value-d', order: 3 },
  ]);
  await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
}

/** その id の行が冷却へ入っているか（記録から読める範囲）。 */
async function isCooling(h: Harness, id: string): Promise<boolean> {
  const row = (await h.stores.tokens.list()).find((token) => token.id === id);
  return row?.cooldownUntil !== undefined;
}

/** プールに2本置いて、1本目を現役に指名する。 */
async function seedTwo(h: Harness): Promise<void> {
  await h.stores.tokens.replace([
    { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
    { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
  ]);
  await h.stores.tokens.writeActive({
    tokenId: 'tok-a',
    generation: 1,
    rotatedAt: '2026-08-25T00:00:00.000Z',
  });
}

describe('受け入れ基準7: プールが空の既定の構成を1文字も変えない', () => {
  it('プールが空なら、止まった文言が来ても何も書かず何も撒かない', async () => {
    const h = harness();

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(h.probeCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toBeNull();
    expect(await h.stores.tokens.list()).toEqual([]);
  });
});

/**
 * **#668 / #667**: 遷移の取れなかった `rejected` が回し手に届いたときの端から端まで。
 *
 * **測るのは2つの向きである** —— (a) いまの世代を名乗る観測なら**冷却が書かれて
 * 回る**（#667 の「記録は `ready`、実際は 429」がここで閉じる） (b) 世代の合わない
 * 観測は**1文字も書かない**（#667 の候補1を採らないという決定そのもの）。
 */
describe('#668 / #667: 状態だけを運ぶ観測', () => {
  it('いまの世代を名乗る観測なら、遷移が無くても冷却を書いて回る', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    // **記録が `ready` のまま残らない**（#667 が心配していた帰結）。
    expect(await isCooling(h, 'tok-a')).toBe(true);
    expect(await h.stores.tokens.readActive()).toEqual({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: AT,
    });
  });

  it('回した後は自動で黙る（世代が上がるので、同じセッションの続きは stale になる）', async () => {
    // **これが「毎ターン回さない」を保証している歯である**（遷移ではなく世代）。
    // 同じ観測をもう一度渡しても、2本目のトークンは冷却へ入らない。
    const h = harness();
    await seedTwo(h);
    const observation = {
      facts: { kind: 'five_hour', status: 'rejected' },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    } as const;

    await h.rotator.observe(observation);
    const again = await h.rotator.observe(observation);

    expect(again.kind).toBe('ignored');
    if (again.kind === 'ignored') expect(again.freshness).toBe('stale');
    expect(await isCooling(h, 'tok-b')).toBe(false);
    // 撒いたのは1回だけ（プールを食い潰していない）。
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('⚠️ 世代の合わない観測では、降りる鍵の冷却も書かない（#667 の候補1を採らない）', async () => {
    // **`markTokenUnusable` は `cooldownUntil` を上書きする（延長しない）** ので、
    // 遅れて届いた観測が `resetsAt` を運んでいなければ `now + 既定` が書かれ、
    // **本物の期限が未来に在る鍵を早く `ready` に見せる。** 記録を腐らせない
    // つもりの書き込みが、記録をもっと嘘にする側へ倒れる。
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected' },
      statusNow: 'rejected',
      // 現役は generation 1。これは前の世代の通知である。
      observedBy: { tokenId: 'tok-a', generation: 0 },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind === 'ignored') expect(outcome.freshness).toBe('stale');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls).toEqual([]);
    // **日誌には残る**（トークンの記録に残らないだけである）。
    if (outcome.kind === 'ignored') expect(outcome.staleRun).toBe(1);
  });

  it('身元を運ばない観測では、状態だけでは回らない', async () => {
    // 回し手は `unknown` を `current` として扱うが、**状態で回す判断はその規則を
    // 使わない** —— 世代を照合できない器では「回した後は自動で黙る」が
    // 成立しないので、毎ターン回してプールを食い潰す。
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected' },
      statusNow: 'rejected',
    });

    expect(outcome.kind).toBe('ignored');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls).toEqual([]);
  });
});

/**
 * **#680**: 文言で検知した拒否（`signal: 'reached'`）が枠の事実を1つも運ばないので、
 * 冷却が設定の既定（5時間）へ倒れていた。
 *
 * **測るのは「どこから期限を採ったか」である** —— 冷却の期限が `resetsAt` と一致
 * するか、`now + 既定` と一致するか。本番でこの2つを見分けたのも同じやり方だった
 * （ミリ秒が `.000` で分も丸い ⟹ `resetsAt` / ミリ秒まで `last_rejected_at + 5h`
 * と一致 ⟹ 既定）。
 */
describe('#680: 文言だけの拒否でも、覚えている枠の事実から期限を採る', () => {
  /** 既定の冷却（5時間）を足しただけの期限。**これが倒れ先である。** */
  const GUESS = Date.parse(AT) + 5 * 60 * 60_000;
  /** 覚えさせる `resetsAt`（既定より早い、まだ先の時刻）。 */
  const RESETS_AT = Date.parse(AT) + 90 * 60_000;

  /**
   * 事実を1件覚えさせる。**回らない形で渡す**（身元を運ばない観測は状態だけでは
   * 回らない —— `decideTokenRotation` の doc）。⟹ 世代が上がらないので、この後の
   * 文言だけの観測は同じ鍵についてのものになる。
   */
  async function remember(h: Harness, facts: Parameters<typeof h.rotator.observe>[0]['facts']) {
    const outcome = await h.rotator.observe({ facts, statusNow: 'rejected' });
    // **前提を固定する。** ここが `rotated` になっていたら、この後のテストは
    // 「覚えた事実が効いた」ではなく別のものを測っている。
    expect(outcome.kind).toBe('ignored');
    expect(await isCooling(h, 'tok-a')).toBe(false);
  }

  async function cooldownOf(h: Harness, id: string): Promise<number | undefined> {
    return (await h.stores.tokens.list()).find((token) => token.id === id)?.cooldownUntil;
  }

  it('覚えている resetsAt を使う（5時間の推測へ倒れない）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    // **これが直した穴そのものである。**
    expect(await cooldownOf(h, 'tok-a')).toBe(RESETS_AT);
    expect(await cooldownOf(h, 'tok-a')).not.toBe(GUESS);
  });

  it('この回の観測が事実を運んでいれば、そちらが勝つ（覚えている側は古い）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT });

    const fresh = Date.parse(AT) + 30 * 60_000;
    const outcome = await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: fresh },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await cooldownOf(h, 'tok-a')).toBe(fresh);
  });

  it('別のトークンについて覚えた事実は使わない', async () => {
    // **一致を見ないと、回した後の新しい鍵に前の鍵の枠のリセット時刻を当てる。**
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 1, rotatedAt: AT });
    await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT },
      statusNow: 'rejected',
    });
    // 現役を tok-a へ戻す（tok-b について覚えた事実が残っている状態）。
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 2 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('拒否を名乗っていない事実は覚えない（重ねた形の status を見ない）', async () => {
    // `facts.status` は重ねた形なので、一度書かれた `rejected` が残り続ける。
    // ⟹ 見るのは `statusNow`（この1件が運んできた生の観測）だけである。
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT },
      // **`statusNow` を渡さない** ＝ この1件は拒否を名乗っていない。
    });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('覚えている期限が過ぎていたら使わない（既定へ倒れる）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, {
      kind: 'five_hour',
      status: 'rejected',
      resetsAt: Date.parse(AT) - 60_000,
    });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  /**
   * **⚠️ レビューで見つかった穴。** `rejected` を覚えるだけで**忘れる道が無かった**
   * ので、**先に開いた枠の遠い期限が居座って、後から来た別の拒否を3日冷やした。**
   *
   * `mergeRateLimitFacts` の doc が同じ規律を逐語で書いている（「記憶が消える道は
   * 塞がない。`status` が `'allowed'` で届けば `rejected` の記憶はそこで上書き
   * される」）—— あちらと同じ側へ倒す。
   */
  it('⚠️ 開いたと言う観測が届いたら、その枠の記憶を消す', async () => {
    const h = harness();
    await seedTwo(h);
    const threeDays = Date.parse(AT) + 72 * 60 * 60_000;
    // 1. 週の枠が拒否された（3日先）。覚える。
    await remember(h, { kind: 'seven_day', status: 'rejected', resetsAt: threeDays });
    // 2. その枠が**先に開いた**（管理者が枠を足した等）。
    await h.rotator.observe({
      facts: { kind: 'seven_day', status: 'allowed', resetsAt: threeDays },
      statusNow: 'allowed',
    });

    // 3. その後、文言だけの拒否が届く（5時間の枠 / セッション上限の側）。
    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **3日ではなく既定へ倒れる。** 開いた枠の期限は、いまの拒否を説明しない。
    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  /**
   * **同じ穴の別の入口。** probe が「通る」と観測したら、覚えていた拒否も落とす
   * —— `judgeTokenCandidate` の `usable` は「取れた枠のどれも使い切っていない」
   * なので、**覚えていた「その枠は拒否した」はもう真ではない。**
   */
  it('⚠️ probe が通ると観測したら、覚えている拒否も忘れる', async () => {
    const h = harness({ verdict: { verdict: 'usable' } });
    await seedTwo(h);
    const threeDays = Date.parse(AT) + 72 * 60 * 60_000;
    await remember(h, { kind: 'seven_day', status: 'rejected', resetsAt: threeDays });
    // 現役の行に止まった記録を入れて、`recovered` の道を通す。
    const rows = await h.stores.tokens.list();
    await h.stores.tokens.replace(
      rows.map((token) =>
        token.id === 'tok-a' ? { ...token, cooldownUntil: Date.parse(AT) + 60_000 } : token,
      ),
    );
    const recovered = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });
    expect(recovered.kind).toBe('ignored');

    // その後の文言だけの拒否は、**3日ではなく既定へ倒れる。**
    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('status を運んでいない観測では記憶を消さない（省略は「何も言っていない」）', async () => {
    // **`undefined` で消すと、`rate_limit_event` が `status` を省いた回に
    // 覚えたものが全部落ちる**（あの欄は普通に省略される）。
    const h = harness();
    await seedTwo(h);
    await remember(h, { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT });
    await h.rotator.observe({ facts: { kind: 'five_hour', utilization: 90 } });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(RESETS_AT);
  });

  /**
   * **既定より後ろの期限を書くのは正しい**（レビューで聞かれた点）。
   *
   * 覚えているのは**その枠自身が拒否した回**の事実で、しかも**まだ先の期限しか
   * 使わない** ⟹ その窓はいまも閉じている。週の枠が尽きているなら3日冷やすのが
   * 正しく、`min` を入れると「もう開いた」と主張することになる（#678）。
   */
  it('週の枠が閉じたままなら、既定（5時間）より後ろの期限を書く', async () => {
    const h = harness();
    await seedTwo(h);
    const threeDays = Date.parse(AT) + 72 * 60 * 60_000;
    await remember(h, { kind: 'seven_day', status: 'rejected', resetsAt: threeDays });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(threeDays);
    // **推測ではない**ので、出所も権威ある側を名乗る。
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.cooldownSource).toBe('quota_reset');
  });

  it('⚠️ 覚えた事実を判定へ混ぜない（signal も倒れ先も動かさない）', async () => {
    // **混ぜると `overageClosed(facts)` が古い記憶で立つ** ⟹ `signal` が
    // `quota_rejected` → `overage_closed` に化け、設定が `overage_exhausted` の
    // 器では**回らないはずの回が回る。**
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'overage_exhausted', cooldownMs: 18_000_000 });
    // 課金枠も閉じている事実を覚えさせる（身元を運ばないので回らない）。
    await remember(h, {
      kind: 'five_hour',
      status: 'rejected',
      overageStatus: 'rejected',
      resetsAt: RESETS_AT,
    });

    // いまの世代を名乗るが、**この回は事実を運んでいない**観測。
    const outcome = await h.rotator.observe({
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // 混ざっていたら `overage_closed` で回る。混ざっていなければ回らない。
    expect(outcome.kind).toBe('ignored');
    expect(outcome.signal).not.toBe('overage_closed');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls).toEqual([]);
  });
});

/**
 * **#682**: 覚えている事実も無い回に、文言に書かれている時刻を使う。
 *
 * **#680 の残りがここである** —— その鍵について `rate_limit_event` が1件も
 * 届いていなければ覚えるものが無く、いまも既定へ倒れる。
 */
describe('#682: 文言に書かれている時刻を使う', () => {
  /** 本番の実測の形（#682 の本文の逐語）。`10:10pm (Asia/Tokyo)` = `13:10Z`。 */
  const OBSERVED = "You've hit your session limit · resets 10:10pm (Asia/Tokyo)";

  /** 時計を本番の実測の瞬間に合わせた足場（`AT` は 03:00Z で、窓に入らない）。 */
  function harnessAt(at: string): Harness {
    const h = harness();
    // `harness()` の時計は `AT` 固定なので、この試験だけ差し替える。
    const stores = h.stores;
    const rotator = createTokenRotator({
      stores,
      probe: { probe: async () => ({ verdict: 'usable' }) },
      spread: { spread: async () => [{ target: 'runner-primary', ok: true }] },
      now: () => new Date(Date.parse(at)),
    });
    return { ...h, rotator };
  }

  async function seedAt(h: Harness, at: string): Promise<void> {
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: at });
  }

  async function cooldownOf(h: Harness, id: string) {
    const row = (await h.stores.tokens.list()).find((token) => token.id === id);
    return { until: row?.cooldownUntil, source: row?.cooldownSource };
  }

  it('文言の時刻を採り、出所を notice_text と記録する', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);

    const outcome = await h.rotator.observe({
      notice: { kind: 'reached', text: OBSERVED },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await cooldownOf(h, 'tok-a')).toEqual({
      until: Date.parse('2026-09-07T13:10:00.000Z'),
      source: 'notice_text',
    });
  });

  it('文言に時刻が無ければ既定へ倒れる（今日の振る舞い）', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);

    await h.rotator.observe({
      notice: { kind: 'reached', text: "You've hit your usage limit" },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toEqual({
      until: Date.parse(at) + 5 * 60 * 60_000,
      source: 'default',
    });
  });

  it('覚えている枠の事実が在れば、そちらが勝つ（#680 が先）', async () => {
    // **順序の固定である。** 文字列から読んだ値が構造化された事実を上書きしたら
    // 逆転している。
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);
    const remembered = Date.parse('2026-09-07T12:30:00.000Z');
    await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: remembered },
      statusNow: 'rejected',
    });

    await h.rotator.observe({
      notice: { kind: 'reached', text: OBSERVED },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toEqual({ until: remembered, source: 'quota_reset' });
  });

  it('文言（原文）は1文字も書き換えない（受け入れ基準8）', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);

    await h.rotator.observe({
      notice: { kind: 'reached', text: OBSERVED },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.lastRejectedReason).toBe(OBSERVED);
  });
});

describe('受け入れ基準1: 1本目が止まったら2本目へ回る', () => {
  it('回して、正本を書き換えて、撒く', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.fromTokenId).toBe('tok-a');
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.generation).toBe(2);

    // 正本が書き換わっている。
    expect(await h.stores.tokens.readActive()).toEqual({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: AT,
    });
    // 撒いたのは新しいほうの値。
    expect(h.spreadCalls).toEqual([
      { id: 'tok-b', generation: 2, kind: 'stored', value: 'value-b' },
    ]);
  });

  it('降りたトークンに、止まった文言と冷却の期限が記録される', async () => {
    const h = harness();
    await seedTwo(h);

    await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    // **文言をそのまま残す**（人間が claude.ai と突き合わせられる形）。
    expect(outgoing?.lastRejectedReason).toBe("You've hit your org's monthly spend limit");
    expect(outgoing?.lastRejectedAt).toBe(AT);
    // `resetsAt` が権威ある期限。
    expect(outgoing?.cooldownUntil).toBe(1_800_000_000_000);
  });

  it('resetsAt が取れなければ設定の既定で冷やす（関数の中に既定を持たない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'free_exhausted', cooldownMs: 60_000 });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing?.cooldownUntil).toBe(Date.parse(AT) + 60_000);
  });

  it('⚠️ 既定へ倒した回が、前に入っていた権威ある期限を後ろへ動かさない', async () => {
    // **本番で起きた形**（実測 2026-09-07、Railway）。同じ鍵が2回止まり、1回目は
    // `rate_limit_event` を伴っていて（`resetsAt` が入った）2回目は文言だけだった
    // ⟹ 2回目が `now + 5時間` を書いて1回目の本物の期限を捨て、プールの3本すべてが
    // 余分に寝た（いちばん重い1本で3時間32分。数と内訳は `nextCooldownUntil` の doc）。
    //
    // **ここは回し手の側から測っている。** 期限を決める規律は `token-pool.ts` に
    // 在るが、それを呼ぶ経路が3つあるので（`coolDown` / 飛ばした候補 / probe の
    // `unusable`）、いちばんよく通る経路が実際にそう振る舞うことを別に固定する。
    const h = harness();
    // 1回目に入った本物の期限（`five_hour` の `resetsAt`）。既定の5時間より前である。
    const authoritative = Date.parse(AT) + 90 * 60 * 1000;
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, cooldownUntil: authoritative },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    // 2回目（文言だけ。`facts` を運んでいないので `resetsAt` が無い）。
    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing?.cooldownUntil).toBe(authoritative);
    // **止まった事実そのものは新しくなる。** 動かさないのは期限だけである。
    expect(outgoing?.lastRejectedAt).toBe(AT);
  });

  it('撒く前に正本を書く（保存が落ちたら撒かない）', async () => {
    // **撒いてから保存する順にすると、保存が落ちたときに「誰も成功と言っていない
    // 版を1層だけが使う」が残る。** 保存の失敗を注入して、撒いていないことを見る。
    const h = harness();
    await seedTwo(h);
    h.stores.tokens.writeActive = () => Promise.reject(new Error('保存できない'));

    await expect(
      h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } }),
    ).rejects.toThrow('保存できない');
    expect(h.spreadCalls).toEqual([]);
  });
});

/**
 * **候補を1本ずつ試し切る（Issue #393「回し方」の 2〜4 の繰り返し）。**
 *
 * Issue 本文の逐語は「`使えない` → **2 へ戻って次の候補**」。ここが1本で打ち切って
 * いたので、**候補が残っていても `exhausted`（＝全層が止まる、の顔）**になっていた。
 */
describe('候補を試し切る', () => {
  it('1本目が使えなければ次の候補へ進む（1本で打ち切らない）', async () => {
    const h = harness({
      verdictOf: (id) =>
        id === 'tok-b' ? { verdict: 'unusable', reason: '枠が尽きている' } : { verdict: 'usable' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-c' });
    // **order 昇順に、飛ばしながら進んでいる。**
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    // 飛ばした候補は冷却へ入る（次の観測で probe を焼き直さない）。
    expect(await isCooling(h, 'tok-b')).toBe(true);
    // まだ試していない候補には触っていない。
    expect(await isCooling(h, 'tok-d')).toBe(false);
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('全部使えなければ exhausted。**試した分だけ**冷却へ入り、保存は1回きり', async () => {
    const h = harness({ verdict: { verdict: 'unusable', reason: '枠が尽きている' } });
    await seedFour(h);
    // **種を置くのも `replace` である。** 差で数えないと、置き方を変えた回に
    // この数だけが黙ってずれる。
    const beforeObserve = h.replaceCalls();

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    // **打ち切りではないので `stoppedBy` は付かない**（「試し切って全部だめ」である）。
    expect(outcome).not.toHaveProperty('stoppedBy');
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c', 'tok-d']);
    for (const id of ['tok-b', 'tok-c', 'tok-d']) expect(await isCooling(h, id)).toBe(true);
    expect(h.spreadCalls).toEqual([]);
    // **「プールが空」と読める行を出さない。** 候補は4本在った。
    expect(outcome.why).not.toContain('プールが空');
    expect(outcome.why).toContain('試した候補「second」「third」「fourth」');
    // **周ごとに保存しない。** 3本を `unusable` と判定しても保存は
    // **降りる側の `coolDown` で1回 ＋ 試した分をまとめて1回 ＝ 2回**きりである。
    // 途中で落ちたときに「一部だけ冷却が付いて結果は届かない」版を残さないための形。
    expect(h.replaceCalls() - beforeObserve).toBe(2);
  });

  it('持ち時間を使い切ったら打ち切り、その事実を出力に残す', async () => {
    // probe 1本が 40 秒かかる見かけにする ⟹ 2本目までは通り、3本目の手前で
    // 経過が持ち時間（60 秒）を越える。
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠が尽きている' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'exhausted', stoppedBy: 'budget' });
    // **1本目は必ず試している**（経過 0 で止まらない）。
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    // **試していない候補を冷却へ入れない**（試したことにしない）。
    expect(await isCooling(h, 'tok-d')).toBe(false);
    // **黙って打ち切らない。**
    expect(outcome.why).toContain('持ち時間');
  });

  it('打ち切った回に「戻る見込みが1本も無い」と言わない', async () => {
    // **既定の文言は「試し切って、どれも戻る見込みが無かった」を意味する。**
    // 打ち切った回にそれを出すと、まだ試していない候補が在るのに嘘になる。
    const line = describeTokenRotation({
      kind: 'exhausted',
      stoppedBy: 'budget',
      signal: 'reached',
      freshness: 'current',
      why: '候補を試す持ち時間（60000ms）を使い切った',
    });
    expect(line).toContain('まだ試していない候補が残っている');
    expect(line).not.toContain('戻る見込みの立っている候補が1本も無い');
  });

  it('試し切ったときは、いちばん早く戻る候補が出る（撒いて待つ）', async () => {
    // 1本しか候補が無く、それが冷却中 ⟹ `selectNextToken` の `none` へ合流する。
    //
    // **⚠️ 2026-09-07 に期待値を反転した（`exhausted` → `parked`）。**
    // 元の期待値は `{ kind: 'exhausted', earliest: { tokenId: 'tok-b' } }` で、
    // **何も撒かずに返るのが仕様だった。** それは「全コンテナが降りた鍵を持った
    // まま待つ」ことなので、冷却が明けても**誰かがもう一度本番で失敗して観測を
    // 上げるまで回らなかった**（人間の決定 2026-09-07: 最速回復の鍵を配って待つ）。
    //
    // **保証は弱くなっていない。** この歯が測っているのは受け入れ基準4
    // 「先頭へ黙って戻らない」で、それは3つとも保たれている ——
    // (1) 選んだのは先頭（order 0 = 降りた `tok-a`）ではなく**いちばん早く戻る
    // `tok-b`** (2) その時刻が出力に在る (3) probe を1本も焼いていない。
    // **足したのは「撒いた」ことの確認だけである。**
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      {
        id: 'tok-b',
        label: 'second',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 60 * 60 * 1000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({
      kind: 'parked',
      tokenId: 'tok-b',
      cooldownUntil: Date.parse(AT) + 60 * 60 * 1000,
      // **降りた側も残す。** どこから来たかが消えると、日誌から辿れなくなる。
      fromTokenId: 'tok-a',
    });
    // **先頭（降りた `tok-a`）へは戻っていない。** ここが受け入れ基準4の本体である。
    expect(h.probeCalls).toEqual([]);
    // **撒いてある。** これが `exhausted` との唯一の実質的な違いで、
    // 「冷却が明けた瞬間にそのまま通る」はここに乗っている。
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
    // **世代は増える。** 指名が変わったので、前の鍵で走っている観測は `stale` である。
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-b',
      generation: 2,
    });
  });
});

/**
 * **確かめられた候補を、判定できなかった候補より先に選ぶ。**
 *
 * 2026-08-25 の回転はこの形で外れた —— order -1 の行が `undecidable` を返し、
 * **そこで確定した**ので、後ろに居た未使用の候補は評価すらされなかった。
 *
 * **⚠️ `undecidable` を捨てるのではない。順位を下げるだけである**
 * （`judgeTokenCandidate` の「迷ったら `unusable` にしない」）。
 */
describe('usable を undecidable より先に選ぶ', () => {
  it('先頭が判定できなくても、後ろの確かめられた候補を選ぶ', async () => {
    const h = harness({
      verdictOf: (id) =>
        id === 'tok-b'
          ? { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' }
          : { verdict: 'usable' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **tok-b で確定しない。** 確かめられた tok-c が勝つ。
    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-c' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    // **順位を下げただけなので、冷却へは入れない**（捨てていない）。
    expect(await isCooling(h, 'tok-b')).toBe(false);
    expect(outcome.why).toContain('観測できた');
  });

  it('全部が判定できなければ、order のいちばん小さいものを撒く（前と同じ結果）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **捨てていない。** 順位を下げた先で、いちばん order の小さい tok-b へ倒る。
    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-b' });
    // 全部試してから倒している（`usable` が居ないことを確かめたうえで）。
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c', 'tok-d']);
    for (const id of ['tok-b', 'tok-c', 'tok-d']) expect(await isCooling(h, id)).toBe(false);
  });

  it('倒したことを言い分ける（「選んだ」と「妥協した」を同じ顔にしない）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.why).toContain('確かめられた候補は見つからなかった');
    expect(outcome.why).toContain('へ倒した');
    // **「観測できた」とは言わない。**
    expect(outcome.why).not.toContain('は観測できた');
  });

  it('持ち時間を使い切っても、見つけてあった候補へ倒す（手元に在るのに何もしない、を作らない）', async () => {
    // probe 1本が 40 秒かかる見かけ ⟹ 2本目までで持ち時間（60秒）を越える。
    // **1本目が `undecidable` なので、倒せる先が手元に在る。**
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    // **`sweep_stopped` にしない。** 倒せる先が在るなら倒す。
    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-b' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    // **打ち切ったことも言う**（倒した理由が「探し切った」ではないので）。
    expect(outcome.why).toContain('持ち時間');
    expect(tokenRotationEntry(outcome)?.event).toBe('rotated');
  });

  it('倒せる先が1本も無ければ、これまでどおり打ち切りとして残る', async () => {
    // 全部 `unusable` ＝ 順位を下げる先が無い。
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠が尽きている' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'exhausted', stoppedBy: 'budget' });
    expect(tokenRotationEntry(outcome)?.event).toBe('sweep_stopped');
  });
});

describe('世代の照合（受け入れ基準: 同時に届いても回るのは1回だけ）', () => {
  it('捨てた回数を数え、日誌へ出す側へ渡す（0件では届かなかったのと見分けが付かない）', async () => {
    const h = harness();
    await seedTwo(h);

    const first = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(first.kind).toBe('rotated');

    // 同じ当たりで遅れて届いた分。**捨てる判断は変わらない**（撒きは増えない）。
    const stale1 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const stale2 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(stale1).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    expect(stale2).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 2 });
    // **挙動は変わっていない。** 数えているだけで、撒いたのは最初の1回だけである。
    expect(h.spreadCalls).toHaveLength(1);

    // 初出は日誌に出る。2件目は間引かれる。
    expect(tokenRotationEntry(stale1)?.event).toBe('not_rotated');
    expect(tokenRotationEntry(stale2)).toBeNull();
  });

  it('もう回した後の通知は捨てる', async () => {
    const h = harness();
    await seedTwo(h);

    // 1本目の通知で回る（世代 1 → 2）。
    const first = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(first.kind).toBe('rotated');

    // 同じ当たりで別のマネージャーから届いた2本目。**世代が古い。**
    const second = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(second.kind).toBe('ignored');
    expect(second.freshness).toBe('stale');
    // 撒いたのは1回だけ（プールを2個消費していない）。
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('身元の無い観測は効かせる側へ倒し、その事実を結果に残す', async () => {
    // **飲み込むほうが悪い**（`observationFreshness` の doc）。ただし倒した事実が
    // 出力に残ることが、3値にしてある目的である。
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('rotated');
    expect(outcome.freshness).toBe('unknown');
  });
});

describe('受け入れ基準4: 全部冷却中なら先頭へ黙って戻らない', () => {
  it('いちばん早く戻るものとその時刻を出す（そしてそれを撒いて待つ）', async () => {
    // **⚠️ 2026-09-07 に期待値を反転した（`exhausted` → `parked`）。**
    // 元はこう書いてあった —— 「先頭へ戻っていない（現役は変わらず、撒いても
    // いない）」として `readActive()` が `tok-a` / `generation: 1` のままである
    // ことと `spreadCalls` が空であることを固定していた。
    //
    // **その2つは「先頭へ戻らない」の証明にはなっていなかった。** 何も撒かない
    // ことは、`tok-a`（先頭であり、いま止まっている鍵）を全コンテナが持ったまま
    // 待つことでもある —— **冷却が明けても、いちばん早く戻る鍵はどこにも置かれて
    // いない。** 人間の決定（2026-09-07）で、そこは撒いて待つ側へ倒した。
    //
    // **保証は弱くなっていない。強くなっている。** 反転した2行の代わりに、
    // **選んだのが「いちばん早く戻る `tok-b`」であって「先頭の `tok-a`」ではない**
    // ことを直接固定している（前の版は「何も選んでいない」ことしか言えなかった）。
    // いちばん早く戻る時刻を出す、という元の主張はそのまま残してある。
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      {
        id: 'tok-b',
        label: 'second',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 5_000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    // いちばん早く戻るものとその時刻（元の主張）。
    expect(outcome.tokenId).toBe('tok-b');
    expect(outcome.label).toBe('second');
    expect(outcome.cooldownUntil).toBe(Date.parse(AT) + 5_000);
    // **先頭（`tok-a`）へは戻っていない。** 撒いた先も指名も `tok-b` である。
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-b',
      generation: 2,
    });
    // **「回った」と読ませない。** 撒いた鍵はまだ通らない。
    expect(describeTokenRotation(outcome)).toContain('まで通らない');
  });

  it('1本しか無くてそれが現役なら、同じ出口へ倒れる（自分自身へ回さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'only', value: 'value-a', order: 0 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    // 世代は増えていない（回っていないので）。
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 1 });
  });
});

describe('候補を本番の仕事で試さない（probe の3値）', () => {
  it('usable なら撒く', async () => {
    const h = harness({ verdict: { verdict: 'usable' } });
    await seedTwo(h);
    await h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } });
    expect(h.probeCalls).toEqual([{ id: 'tok-b', kind: 'stored', value: 'value-b' }]);
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('unusable なら撒かず、その候補も冷却へ入れる（probe を毎回焼かない）', async () => {
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠を使い切っている', retryAt: 1_800_000_000_000 },
    });
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    const candidate = (await h.stores.tokens.list()).find((t) => t.id === 'tok-b');
    expect(candidate?.cooldownUntil).toBe(1_800_000_000_000);
    expect(candidate?.lastRejectedReason).toBe('枠を使い切っている');
  });

  it('undecidable なら撒く側へ倒す（判定できないことを理由に候補を捨てない）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'rate_limits が埋まらない構成' },
    });
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(h.spreadCalls).toHaveLength(1);
    // **「本番で確かめる」ことを結果の文面に残す**（撒いた＝回った、と読ませない）。
    if (outcome.kind === 'rotated') {
      expect(outcome.why).toContain('本番で確かめる');
    }
  });
});

describe('設定を読むのは判定側だけ（off なら1本も回らない）', () => {
  it('off なら回さず、撒かず、冷却も入れない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 1_000 });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing).not.toHaveProperty('cooldownUntil');
  });

  it('overage_exhausted は rejected だけでは回らない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'overage_exhausted', cooldownMs: 1_000 });

    const outcome = await h.rotator.observe({
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected' },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
  });
});

describe('受け入れ基準5: 値がどこにも出ない', () => {
  it('結果を JSON 化してもトークンの値が現れない', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('value-a');
    expect(serialized).not.toContain('value-b');
  });

  it('撒くのに失敗した理由も結果に載るが、値は載らない', async () => {
    const h = harness({
      spreadResults: [{ target: 'runner-primary', ok: false, error: 'runner が応答しない' }],
    });
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    // **撒けなかったことを隠さない。** ただし「回した」ことは正本に残っている。
    expect(outcome.spread).toEqual([
      { target: 'runner-primary', ok: false, error: 'runner が応答しない' },
    ]);
    expect(JSON.stringify(outcome)).not.toContain('value-b');
  });
});

describe('直列化（同時に2本来てもプールを食い潰さない）', () => {
  it('身元の無い観測が2本同時に来ても、2本目は世代で捨てられる', async () => {
    // **列が無いと、2本が同じ `readActive()` を読んで両方回る。** 世代の照合は
    // 「読んでから書くまで」の隙間を塞げないので、列と合わせて二重にしてある。
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
      { id: 'tok-c', label: 'third', value: 'value-c', order: 2 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const [first, second] = await Promise.all([
      h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } }),
      h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } }),
    ]);

    expect(first.kind).toBe('rotated');
    expect(second.kind).toBe('ignored');
    expect(second.freshness).toBe('stale');
    // **プールを1個しか消費していない。**
    expect(h.spreadCalls).toHaveLength(1);
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-b', generation: 2 });
  });
});

describe('降りた本人へ「回す」を作らない（resetsAt が過去で来る形）', () => {
  /**
   * **変異試験でこの歯の必要性が判った。** `exclude` を渡すのをやめる変異を当てても
   * 17本すべて緑だった——降りた本人は `coolDown` で冷却へ入るので、**普通の場合は
   * `exclude` が無くても飛ばされる。**
   *
   * ⟹ `exclude` が実際に効くのは **`resetsAt` が既に過ぎている値で来たとき**だけ
   * である（過去の値を未来へ丸めないので、冷却へ入れた直後から `ready` になる）。
   * その場合、降りた本人が最初の候補として選び直され、**日誌には「回した」と残るのに
   * 撒いた先は1文字も変わらない。** ここを測る歯が無いと、`exclude` は誰にも
   * 守られていないことになる。
   */
  it('resetsAt が過去でも、降りた本人は選ばれない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      // **既に過ぎている期限。** 冷却へ入れた直後から ready になる。
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: Date.parse(AT) - 1 },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    // **自分自身ではない。**
    expect(outcome.toTokenId).toBe('tok-b');
    expect(h.spreadCalls).toEqual([
      { id: 'tok-b', generation: 2, kind: 'stored', value: 'value-b' },
    ]);
  });

  it('resetsAt が過去で、他に候補が無ければ「候補が無い」へ倒れる（自分へ戻らない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'only', value: 'value-a', order: 0 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: Date.parse(AT) - 1 },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    // 世代が増えていない＝「回した」という嘘を残していない。
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 1 });
  });
});

/**
 * 起動時の引き取り（Issue #393 PR3）。
 *
 * **これが無いと何が起きるか** — 撒いた先はプロセスと一緒に消えるが、現役の指名は
 * 記憶ストアに残る。デーモンを再起動すると、**器の環境変数のトークンが走っているのに
 * 記憶ストアは別のトークンを現役だと思っている**という食い違いが残り、次に枠へ
 * 当たったとき**走ってもいないトークンを冷却へ入れて**候補を1本無駄に飛ばす。
 */
describe('restore（起動時の引き取り）', () => {
  it('一度も回していなければ none（器の環境変数がそのまま効く）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('none');
    // **撒かない。** 指名されていないものを起動時に撒くのは、回していないのに
    // 回したことにする操作である。
    expect(h.spreadCalls).toEqual([]);
  });

  it('現役として記録された行を撒き直す', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') return;
    expect(outcome.tokenId).toBe('tok-b');
    expect(outcome.cooling).toBe(false);
    expect(h.spreadCalls).toEqual([
      { id: 'tok-b', generation: 5, kind: 'stored', value: 'value-b' },
    ]);
  });

  it('世代を増やさない（引き取りは回転ではない）', async () => {
    // **増やすと、まだ有効な観測が stale として捨てられる。**
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });

    await h.rotator.restore();

    expect(h.spreadCalls[0]?.generation).toBe(5);
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 5 });
  });

  it('記憶ストアへ書かない（updatedAt を動かさない）', async () => {
    // 起動しただけで「変わった」ことにすると、どの行がいつ変わったかが取れなくなる。
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });
    const before = await h.stores.tokens.list();

    await h.rotator.restore();

    expect(await h.stores.tokens.list()).toEqual(before);
  });

  it('冷却中でも撒き直す。ただし冷却中だったことを返す', async () => {
    // **候補を選び直さない** — 選び直すのは枠に当たったときだけであり、起動を
    // 新しい契機にしない。
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 5_000,
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') return;
    expect(outcome.cooling).toBe(true);
    // 冷却中の tok-a を撒いている（tok-b へ勝手に移らない）。
    expect(h.spreadCalls).toEqual([
      { id: 'tok-a', generation: 2, kind: 'stored', value: 'value-a' },
    ]);
    expect(outcome.why).toContain('冷却中');
  });

  it('指名の先の行が消えていたら dangling。撒かない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'ghost', generation: 3, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('dangling');
    expect(h.spreadCalls).toEqual([]);
    // **記憶ストアへ書いて直さない**（次の当たりで回し手が正しい候補へ移る）。
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'ghost' });
  });

  it('人間が外した行なら withheld。撒かない（人間の判断を実装が覆さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, disabledAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('withheld');
    expect(h.spreadCalls).toEqual([]);
  });

  it('失効している行も withheld', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, invalidatedAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    expect((await h.rotator.restore()).kind).toBe('withheld');
    expect(h.spreadCalls).toEqual([]);
  });

  it('値が結果のどこにも出ない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(JSON.stringify(outcome)).not.toContain('value-b');
  });

  /**
   * **これがこの修正の本体である。** 引き取りが無い場合の食い違いを、
   * 「引き取った後は起きない」という形で測る。
   */
  it('引き取った後は、走ってもいないトークンを冷却へ入れない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
      { id: 'tok-c', label: 'third', value: 'value-c', order: 2 },
    ]);
    // 前回の稼働で tok-b まで回っていた、という状態。
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 2, rotatedAt: AT });

    await h.rotator.restore();
    // 引き取った後に枠へ当たる。
    await h.rotator.observe({
      notice: { kind: 'reached', text: "You've hit your org's monthly spend limit" },
      observedBy: { tokenId: 'tok-b', generation: 2 },
    });

    const tokens = await h.stores.tokens.list();
    // **冷却に入るのは、実際に走っていた tok-b だけである。**
    expect(tokens.find((t) => t.id === 'tok-b')?.cooldownUntil).toBeDefined();
    expect(tokens.find((t) => t.id === 'tok-a')).not.toHaveProperty('cooldownUntil');
    // 次は tok-c（tok-a へ戻らない。order 順で tok-b の後ろ…ではなく ready の先頭）。
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 3 });
  });
});

/**
 * 器の環境変数を指す行（Issue #393）。
 *
 * **これが無いと、環境変数のトークンが止まっても記録が残らない** — 回し手は現役の
 * 行を冷却へ入れるが、環境変数は行を持たないので入れる先が無い。**最初に止まった
 * 1本だけが台帳から消える。**
 */
describe('ensureEnvToken（環境変数の行）', () => {
  function withEnv(present: boolean) {
    const stores = createMemoryStores();
    let seq = 0;
    const rotator = createTokenRotator({
      stores,
      probe: { probe: async () => ({ verdict: 'usable' }) },
      spread: { spread: async () => [] },
      now: () => new Date(AT),
      hasEnvToken: () => present,
      newId: () => `env-${String(++seq)}`,
    });
    return { stores, rotator };
  }

  it('⚠️ プールが空なら足さない（受け入れ基準7 を字義どおり守る）', async () => {
    const { stores, rotator } = withEnv(true);

    const outcome = await rotator.ensureEnvToken();

    expect(outcome.kind).toBe('skipped');
    // **記憶ストアに1行も生えない。**
    expect(await stores.tokens.list()).toEqual([]);
  });

  it('人間が1本でも登録していれば足す', async () => {
    const { stores, rotator } = withEnv(true);
    await stores.tokens.replace([{ id: 'tok-a', label: 'spare', value: 'value-a', order: 0 }]);

    const outcome = await rotator.ensureEnvToken();

    expect(outcome.kind).toBe('added');
    const tokens = await stores.tokens.list();
    const env = tokens.find((t) => t.source === 'env');
    expect(env).toBeDefined();
    // **値を持たない**（器の環境変数を指すだけ）。
    expect(env).not.toHaveProperty('value');
  });

  it('環境変数の行は既存のどれよりも先に試される', async () => {
    // 環境変数のトークンは*いま走っている*ものなので、その残枠を使い切ってから
    // 予備へ回るのが自然な順序である。
    const { stores, rotator } = withEnv(true);
    await stores.tokens.replace([{ id: 'tok-a', label: 'spare', value: 'value-a', order: 0 }]);

    await rotator.ensureEnvToken();

    const tokens = await stores.tokens.list();
    expect(tokens[0]?.source).toBe('env');
    expect(tokens[1]?.id).toBe('tok-a');
  });

  it('既存の行の order を振り直さない（updatedAt を一斉に動かさない）', async () => {
    const { stores, rotator } = withEnv(true);
    await stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'a',
        value: 'value-a',
        order: 0,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'tok-b',
        label: 'b',
        value: 'value-b',
        order: 1,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    await rotator.ensureEnvToken();

    const tokens = await stores.tokens.list();
    expect(tokens.find((t) => t.id === 'tok-a')?.order).toBe(0);
    expect(tokens.find((t) => t.id === 'tok-a')?.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(tokens.find((t) => t.id === 'tok-b')?.updatedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('環境変数が置かれていなければ足さない（指す先が無い）', async () => {
    const { stores, rotator } = withEnv(false);
    await stores.tokens.replace([{ id: 'tok-a', label: 'spare', value: 'value-a', order: 0 }]);

    expect((await rotator.ensureEnvToken()).kind).toBe('skipped');
    expect((await stores.tokens.list()).some((t) => t.source === 'env')).toBe(false);
  });

  it('2回呼んでも増えない（起動のたびに行が増えない）', async () => {
    const { stores, rotator } = withEnv(true);
    await stores.tokens.replace([{ id: 'tok-a', label: 'spare', value: 'value-a', order: 0 }]);

    await rotator.ensureEnvToken();
    const second = await rotator.ensureEnvToken();

    expect(second.kind).toBe('exists');
    expect((await stores.tokens.list()).filter((t) => t.source === 'env')).toHaveLength(1);
  });

  it('人間が外した行でも「在る」として扱う（外した判断を無視して足し直さない）', async () => {
    const { stores, rotator } = withEnv(true);
    await stores.tokens.replace([
      { id: 'tok-a', label: 'spare', value: 'value-a', order: 0 },
      { id: 'env-old', label: '器の環境変数', source: 'env', order: -1, disabledAt: AT },
    ]);

    const outcome = await rotator.ensureEnvToken();

    expect(outcome.kind).toBe('exists');
    expect((await stores.tokens.list()).filter((t) => t.source === 'env')).toHaveLength(1);
  });

  /** **この修正の本体** — 環境変数のトークンが止まったことが記録に残る。 */
  it('環境変数の行が止まったら、文言と復帰予定時刻が残る', async () => {
    const stores = createMemoryStores();
    const spreadCalls: unknown[] = [];
    const rotator = createTokenRotator({
      stores,
      probe: { probe: async () => ({ verdict: 'usable' }) },
      spread: {
        spread: async (t) => {
          spreadCalls.push(t);
          return [];
        },
      },
      now: () => new Date(AT),
      hasEnvToken: () => true,
      newId: () => 'env-1',
    });
    await stores.tokens.replace([{ id: 'tok-a', label: 'spare', value: 'value-a', order: 0 }]);
    await rotator.ensureEnvToken();
    // 環境変数の行が現役だとして始める（起動時の撒き直しが指名した状態）。
    await stores.tokens.writeActive({ tokenId: 'env-1', generation: 1, rotatedAt: AT });

    await rotator.observe({
      notice: { kind: 'reached', text: "You've hit your org's monthly spend limit" },
      observedBy: { tokenId: 'env-1', generation: 1 },
    });

    const env = (await stores.tokens.list()).find((t) => t.id === 'env-1');
    // **止まった事実が残る。これが行を作った理由そのものである。**
    expect(env?.lastRejectedReason).toBe("You've hit your org's monthly spend limit");
    expect(env?.cooldownUntil).toBeDefined();
    // 予備へ回っている。
    expect(await stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-a', generation: 2 });
  });
});

/**
 * 日誌へ出す1行（Issue #393 PR5、受け入れ基準8）。
 *
 * **回した事実・回せなかった事実が残り、当たった文言がそのまま残ること。**
 */
describe('describeTokenRotation', () => {
  const spread = [
    { target: 'runner-primary', ok: true },
    { target: 'clone', ok: true },
  ];

  it('回したら、どこからどこへ・何を根拠に・撒いた先を出す', () => {
    const line = describeTokenRotation({
      kind: 'rotated',
      fromTokenId: 'env-1',
      toTokenId: 'tok-b',
      toLabel: 'spare1',
      generation: 2,
      signal: 'reached',
      freshness: 'current',
      spread,
      why: '仕事が止まった文言が出た（設定に関わらず回す）',
    });

    expect(line).toContain('回した');
    expect(line).toContain('env-1 → 「spare1」');
    expect(line).toContain('世代 2');
    expect(line).toContain('置けた: runner-primary, clone');
  });

  it('⚠️「撒いた」を「回った」と読ませない断りが入る', () => {
    // 走行中のセッションには届かないので、撒いた時点では回っていない。
    const line = describeTokenRotation({
      kind: 'rotated',
      toTokenId: 'tok-b',
      toLabel: 'spare1',
      generation: 2,
      signal: 'reached',
      freshness: 'current',
      spread,
      why: 'x',
    });
    expect(line).toContain('撒いたのであって、回ったのではない');
  });

  it('当たった文言をそのまま添える（言い換えない）', () => {
    const text = "You've hit your org's monthly spend limit";
    const line = describeTokenRotation(
      {
        kind: 'rotated',
        toTokenId: 'tok-b',
        toLabel: 'spare1',
        generation: 2,
        signal: 'reached',
        freshness: 'current',
        spread,
        why: 'x',
      },
      { noticeText: text },
    );
    expect(line).toContain(text);
  });

  it('撒けなかった先を落とさない（成功だけ数えて 2/3 と書かない）', () => {
    // 「2台のうち1台だけ落ちた」を消すと、どれが落ちたのかが読めなくなる。
    const line = describeTokenRotation({
      kind: 'rotated',
      toTokenId: 'tok-b',
      toLabel: 'spare1',
      generation: 2,
      signal: 'reached',
      freshness: 'current',
      spread: [
        { target: 'runner-primary', ok: true },
        { target: 'runner-2', ok: false, error: 'runner が応答しない' },
      ],
      why: 'x',
    });
    expect(line).toContain('置けなかった: runner-2');
    expect(line).toContain('runner が応答しない');
  });

  it('回せなかったら、いちばん早く戻る時刻を出す', () => {
    const line = describeTokenRotation({
      kind: 'exhausted',
      earliest: { tokenId: 'tok-b', label: 'spare1', cooldownUntil: Date.parse(AT) },
      signal: 'reached',
      freshness: 'current',
      why: '候補が全部冷却中である',
    });
    expect(line).toContain('回せなかった');
    expect(line).toContain('spare1');
    expect(line).toContain(AT);
  });

  it('戻る見込みが取れないときは、それを言う（時刻を作らない）', () => {
    const line = describeTokenRotation({
      kind: 'exhausted',
      signal: 'reached',
      freshness: 'current',
      why: '試せる候補が1本も無い',
    });
    expect(line).toContain('戻る見込みの立っている候補が1本も無い');
  });

  it('回さないと決めたことも記録する（受け入れ基準8）', () => {
    // 設定が off のあいだに何回止まったかは、後から効いてくる。
    const line = describeTokenRotation({
      kind: 'ignored',
      signal: 'reached',
      freshness: 'current',
      why: '回す契機の設定が off（記録だけする）',
    });
    expect(line).toContain('回さなかった');
    expect(line).toContain('off');
  });

  it('世代の合わない通知は、数を持たなければ出さない', () => {
    // **数を 1 で埋めない。** 埋めると、数を運べない呼び方の1件が「初出」に化ける。
    expect(
      describeTokenRotation({
        kind: 'ignored',
        signal: 'reached',
        freshness: 'stale',
        why: 'もう回した後の通知',
      }),
    ).toBeNull();
  });

  it('世代の合わない通知は、初出と10の冪だけ出す（全件でも0件でもない）', () => {
    // **0件にすると「届かなかった」と見分けが付かない**（2026-08-25 の2時間40分が
    // まさにその形だった）。**全件出すと1回の当たりで日誌が埋まる。**
    const at = (staleRun: number): string | null =>
      describeTokenRotation({
        kind: 'ignored',
        signal: 'reached',
        freshness: 'stale',
        staleRun,
        why: 'もう回した後の通知',
      });

    expect(at(1)).toContain('1件目');
    for (const quiet of [2, 3, 9, 11, 99, 101]) expect(at(quiet)).toBeNull();
    expect(at(10)).toContain('10件目');
    expect(at(100)).toContain('100件目');
    expect(at(1000)).toContain('1000件目');
  });

  it('間引いていることを出力に書く（連番だと読ませない）', () => {
    // **黙って間引くと、読み手には全件出ているように見える。**
    const line = describeTokenRotation({
      kind: 'ignored',
      signal: 'reached',
      freshness: 'stale',
      staleRun: 10,
      why: 'もう回した後の通知',
    });
    expect(line).toContain('連番ではない');
  });

  it('材料が何も無い観測は出さない（毎ターン届くので日誌が埋まる）', () => {
    expect(
      describeTokenRotation({
        kind: 'ignored',
        signal: 'none',
        freshness: 'unknown',
        why: '回す契機に当たる観測が無い',
      }),
    ).toBeNull();
  });
});

describe('describeTokenRestore', () => {
  it('一度も回していなければ出さない（毎回の起動で出ると意味のある行が埋もれる）', () => {
    expect(describeTokenRestore({ kind: 'none', why: 'x' })).toBeNull();
  });

  it('撒き直したら、世代を増やしていないことを明記する', () => {
    const line = describeTokenRestore({
      kind: 'restored',
      tokenId: 'tok-b',
      label: 'spare1',
      generation: 5,
      cooling: false,
      spread: [{ target: 'clone', ok: true }],
      why: 'x',
    });
    expect(line).toContain('世代 5、増やしていない');
    expect(line).toContain('spare1');
  });

  it('冷却中だったことを出す', () => {
    const line = describeTokenRestore({
      kind: 'restored',
      tokenId: 'tok-b',
      label: 'spare1',
      generation: 5,
      cooling: true,
      spread: [],
      why: 'x',
    });
    expect(line).toContain('冷却中である');
  });

  it('撒き直さなかった理由を出す（dangling / withheld）', () => {
    expect(describeTokenRestore({ kind: 'dangling', tokenId: 'ghost', why: '行が無い' })).toContain(
      '行が無い',
    );
    expect(
      describeTokenRestore({ kind: 'withheld', tokenId: 'x', label: 'y', why: '人間が外している' }),
    ).toContain('人間が外している');
  });
});

/**
 * 日誌の1件にする側（`tokenRotationEntry` / `tokenRestoreEntry`）。
 *
 * **ここが固定するのは「専用の種別に何が載るか」だけである。** 文言そのものは
 * 上の describe が持ち、種別が `exchange` と分かれていることの意味（絞れる）は
 * `schema.ts` の doc に在る。
 */
describe('tokenRotationEntry / tokenRestoreEntry', () => {
  it('出す・出さないの判定を二重に持たない（describe が null なら null）', () => {
    // **これが要点である。** 判定をここでもう一度書くと、stderr には出るのに
    // 日誌には出ない（あるいは逆）という食い違いが静かに生まれる。
    const stale = {
      kind: 'ignored' as const,
      signal: 'reached' as const,
      freshness: 'stale' as const,
      why: '前のトークンの通知',
    };
    expect(describeTokenRotation(stale)).toBeNull();
    expect(tokenRotationEntry(stale)).toBeNull();

    const none = { kind: 'none' as const, why: '一度も回していない' };
    expect(describeTokenRestore(none)).toBeNull();
    expect(tokenRestoreEntry(none)).toBeNull();
  });

  it('打ち切りは exhausted ではなく sweep_stopped として載る', () => {
    // **潰すと「候補が無い」と「まだ試していない候補が在る」が同じ顔になる。**
    // 読む側は前者だと思って待つが、実際には次の観測で回りうる。
    const stopped = tokenRotationEntry({
      kind: 'exhausted',
      stoppedBy: 'budget',
      signal: 'reached',
      freshness: 'current',
      why: '候補を試す持ち時間（60000ms）を使い切った',
    });
    expect(stopped?.event).toBe('sweep_stopped');
    // **打ち切りに `earliestAt` を付けない**（戻る見込みを測っていない）。
    expect(stopped).not.toHaveProperty('earliestAt');

    // 試し切ったほうは今までどおり `exhausted`。
    const exhausted = tokenRotationEntry({
      kind: 'exhausted',
      signal: 'reached',
      freshness: 'current',
      why: '試せる候補を使い切った',
    });
    expect(exhausted?.event).toBe('exhausted');
  });

  it('回ったら rotated として、移った先と世代と契機が載る', () => {
    const entry = tokenRotationEntry(
      {
        kind: 'rotated',
        fromTokenId: 'tok-a',
        toTokenId: 'tok-b',
        toLabel: '予備1',
        generation: 4,
        signal: 'quota_rejected',
        freshness: 'current',
        spread: [],
        why: '枠に当たった',
      },
      { noticeText: "You've hit your usage limit" },
    );

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('token_rotation');
    expect(entry?.event).toBe('rotated');
    expect(entry?.fromTokenId).toBe('tok-a');
    expect(entry?.tokenId).toBe('tok-b');
    expect(entry?.label).toBe('予備1');
    expect(entry?.generation).toBe(4);
    expect(entry?.signal).toBe('quota_rejected');
    expect(entry?.freshness).toBe('current');
    // **当たった文言が構造の側にも残る**（受け入れ基準8）。整形の言い方が
    // 変わっても、原文は `text` の中だけに居ないようにしてある。
    expect(entry?.noticeText).toBe("You've hit your usage limit");
    expect(entry?.text).toContain("You've hit your usage limit");
  });

  it('回さなかった（not_rotated）と回せなかった（exhausted）を潰さない', () => {
    // **2値へ潰すと、いちばん重い状態がいちばん普通の状態と同じ顔になる。**
    const notRotated = tokenRotationEntry({
      kind: 'ignored',
      signal: 'warning',
      freshness: 'current',
      why: '警告は契機ではない',
    });
    const exhausted = tokenRotationEntry({
      kind: 'exhausted',
      earliest: { tokenId: 'tok-a', label: '予備1', cooldownUntil: 1_800_000_000_000 },
      signal: 'reached',
      freshness: 'current',
      why: '全部冷却中',
    });

    expect(notRotated?.event).toBe('not_rotated');
    expect(exhausted?.event).toBe('exhausted');
    expect(exhausted?.earliestAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  /**
   * **#683**: `earliestAt` の出所を日誌が覚える。
   *
   * 日誌には既に `earliestAt` が在ったが**出所は無かった** ⟹ 行を見ても
   * 「その時刻が本物か、5時間足しただけか」が言えなかった。
   */
  describe('#683: earliestAt の出所', () => {
    it('parked の行に出所が載る', () => {
      const entry = tokenRotationEntry({
        kind: 'parked',
        fromTokenId: 'tok-a',
        tokenId: 'tok-b',
        label: '予備1',
        generation: 5,
        cooldownUntil: 1_800_000_000_000,
        cooldownSource: 'quota_reset',
        signal: 'reached',
        freshness: 'current',
        spread: [{ target: 'runner-primary', ok: true }],
        why: 'いま通る鍵が無い',
      });

      expect(entry?.event).toBe('parked');
      expect(entry?.cooldownSource).toBe('quota_reset');
      // **人間が読む1行にも出す**（構造だけだと画面と CLI で言い方が割れる）。
      expect(entry?.text).toContain('出所は枠の resetsAt');
    });

    it('exhausted の earliest にも載る', () => {
      const entry = tokenRotationEntry({
        kind: 'exhausted',
        earliest: {
          tokenId: 'tok-a',
          label: '予備1',
          cooldownUntil: 1_800_000_000_000,
          cooldownSource: 'default',
        },
        signal: 'reached',
        freshness: 'current',
        why: '全部冷却中',
      });

      expect(entry?.cooldownSource).toBe('default');
      // **推測であることを、推測の回にだけ黙らない形で言う。**
      expect(entry?.text).toContain('ただの推測');
    });

    it('⚠️ 出所を持たない行では欄を作らない（既定で埋めない）', () => {
      // **無いのは「言えなかった」である。** `default` で埋めると「推測だと
      // 観測した」という嘘になり、読む側は本物の値を推測として捨てうる。
      const entry = tokenRotationEntry({
        kind: 'parked',
        tokenId: 'tok-b',
        label: '予備1',
        generation: 5,
        cooldownUntil: 1_800_000_000_000,
        signal: 'reached',
        freshness: 'current',
        spread: [{ target: 'runner-primary', ok: true }],
        why: 'いま通る鍵が無い',
      });

      expect(entry?.event).toBe('parked');
      expect(entry).not.toHaveProperty('cooldownSource');
      expect(entry?.text).not.toContain('出所は');
    });
  });

  it('戻る見込みの候補が1本も無いとき earliestAt を埋めない（「すぐ戻る」と混ぜない）', () => {
    const entry = tokenRotationEntry({
      kind: 'exhausted',
      signal: 'reached',
      freshness: 'current',
      why: 'プールが空',
    });

    expect(entry?.event).toBe('exhausted');
    // **無いことを作らない。** 埋めると「その時刻に戻る」と読める。
    expect(entry?.earliestAt).toBeUndefined();
    expect(entry?.tokenId).toBeUndefined();
  });

  it('起動時の撒き直しは restored（世代を増やさない）', () => {
    const entry = tokenRestoreEntry({
      kind: 'restored',
      tokenId: 'tok-a',
      label: '予備1',
      generation: 7,
      cooling: false,
      spread: [],
      why: '起動時',
    });

    expect(entry?.event).toBe('restored');
    expect(entry?.tokenId).toBe('tok-a');
    expect(entry?.generation).toBe(7);
    // 契機は無い（撒き直しは枠の観測ではない）。
    expect(entry?.signal).toBeUndefined();
  });

  it('撒き直せなかったときも、どの指名だったかは載せる', () => {
    const dangling = tokenRestoreEntry({
      kind: 'dangling',
      tokenId: 'tok-gone',
      why: '指名された行がもう無い',
    });
    expect(dangling?.event).toBe('restore_failed');
    expect(dangling?.tokenId).toBe('tok-gone');
    // `dangling` は label を持たない。**無いものを埋めない。**
    expect(dangling?.label).toBeUndefined();

    const withheld = tokenRestoreEntry({
      kind: 'withheld',
      tokenId: 'tok-off',
      label: '外した分',
      why: '人間が外している',
    });
    expect(withheld?.event).toBe('restore_failed');
    expect(withheld?.label).toBe('外した分');
  });

  it('トークンの値をどのフィールドにも載せない（受け入れ基準5）', () => {
    // **値が載る経路がそもそも無いことを、型ではなく実物で確かめる。**
    // `TokenRotationOutcome` は値を持たないが、将来ここへ何かを足すときに
    // 「値を混ぜた」が黙って通らないようにする歯である。
    const entry = tokenRotationEntry(
      {
        kind: 'rotated',
        toTokenId: 'tok-b',
        toLabel: '予備1',
        generation: 1,
        signal: 'reached',
        freshness: 'current',
        spread: [],
        why: '枠',
      },
      { noticeText: '上限です' },
    );

    expect(JSON.stringify(entry)).not.toContain('sk-ant');
    expect(Object.keys(entry ?? {})).not.toContain('value');
  });
});

/**
 * **観測を待たずに、記録の状態だけを見て回す**（`reconsider`。人間の決定 2026-09-07）。
 *
 * ## この歯の集合が固定している穴
 *
 * `observe` の6つの検知点は**すべてセッション由来**である ⟹ **全層が枠で止まった
 * 状態は、観測を上げる主体が1つも居ない状態でもある。** そこから抜けるには誰かが
 * もう一度本番で失敗して観測を上げるしかなく、**プールに通る鍵が残っていても
 * 何も起きない**時間ができた（人間の報告: 「枠塞がってないトークンがあるのに
 * 何故何もしてないことがある」）。
 *
 * **⚠️ ここは「回るようになった」を測る歯であって、「本番で通った」を測る歯では
 * ない。** 本物のトークンを扱わない枷があるので、そちらは実装側からは測れない。
 */
describe('reconsider: 動く鍵が残っているのに諦めない', () => {
  it('記録の上で現役が冷却中で、通る候補が在れば回す（観測は1つも無い）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        // 既に冷却へ入っている＝「止まった」ことは記録済み。
        cooldownUntil: Date.parse(AT) + 5 * 60 * 60 * 1000,
        lastRejectedAt: AT,
        lastRejectedReason: "You've hit your org's monthly spend limit",
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 3, rotatedAt: AT });

    // **観測を1つも渡さない。** これが `observe` との違いそのものである。
    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.fromTokenId).toBe('tok-a');
    expect(outcome.generation).toBe(4);
    // **印は `stranded`。** 枠の観測ではなく記録からそう言っている。
    expect(outcome.signal).toBe('stranded');
    expect(outcome.reason).toBe('tick');
    // **`freshness` は付かない。** 照合する観測が無いので、`unknown` で埋めない。
    expect(outcome.freshness).toBeUndefined();
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
  });

  it('現役が記録の上で通るなら、健全な鍵から勝手に移らない', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('ignored');
    expect(outcome.signal).toBe('none');
    // **probe を1本も焼いていない。** ふつうの状態の目盛りが安いことの本体である。
    expect(h.probeCalls).toEqual([]);
    expect(h.spreadCalls).toEqual([]);
  });

  it('候補が全部冷却中なら probe を1本も焼かない（目盛りで回しても安い）', async () => {
    const h = harness();
    const cooling = Date.parse(AT) + 60 * 60 * 1000;
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, cooldownUntil: cooling },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1, cooldownUntil: cooling },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    // **これがこの歯の本体である。** 候補選び（`selectNextToken`）は記録だけを
    // 見る純粋関数なので、`ready` な行が1本も無ければ probe の前に打ち切る ⟹
    // 目盛りで何度呼んでもサブプロセスは起きない。
    expect(h.probeCalls).toEqual([]);
    // **同着なので撒き直さない**（`parkImprovesOn`。同じ時刻に戻る鍵へ移すのは
    // 改善ではなく、増えた世代が走行中の観測を `stale` にするだけである）。
    // 撒く側の判定そのものは下の describe（「park し直すのは…」）が測る。
    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
  });

  it('プールが空なら1文字も変えない（受け入れ基準7）', async () => {
    const h = harness();

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(h.probeCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toBeNull();
    // **日誌にも出さない。** 既定の構成で目盛りごとに1行増えると、意味のある行が埋もれる。
    expect(tokenRotationEntry(outcome)).toBeNull();
  });

  it('設定が off なら回さない（記録はする）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 1,
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
    await h.stores.tokens.writeSettings({
      rotateOn: 'off',
      cooldownMs: 18_000_000,
      updatedAt: AT,
    });

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('ignored');
    // **`none` へ潰さない。** 「止まっていることは分かっていた」が記録に残る。
    expect(outcome.signal).toBe('stranded');
    expect(h.spreadCalls).toEqual([]);
    // `stranded` は日誌に出る（`signal: 'none'` の目盛りだけが黙る）。
    expect(tokenRotationEntry(outcome)?.event).toBe('not_rotated');
  });

  it('指名の先の行が消えていたら（dangling）、通る候補へ移す', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 1 }]);
    // 人間が `tok-a` を消した後の状態。
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.why).toContain('プールに無い');
  });

  it('指名が無い器では、環境変数の行を現役として見る', async () => {
    // **既定の構成から1度も回っていない器**（`active` が `null`）。ここを
    // 「現役が居ない」と読むと、環境変数のトークンが冷却へ入っていても
    // 永久に何も起きない。
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-env',
        label: '器の環境変数',
        source: 'env',
        order: -1,
        cooldownUntil: Date.parse(AT) + 60 * 60 * 1000,
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 0 },
    ]);

    const outcome = await h.rotator.reconsider({ reason: 'account_probe' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    // **`fromTokenId` を名乗らない。** 指名が無いので、回したことのある鍵が無い。
    expect(outcome.fromTokenId).toBeUndefined();
  });
});

/**
 * **セッションを1本も使わない観測（`current.verdict` / `origin: { source: 'account_probe' }`）で回す / 戻す。**
 *
 * `apps/daemon/src/usage-poller.ts` が5分ごとに取っているものを
 * `judgeTokenCandidate` へ通した値がここへ来る。**全層が止まっていても届く
 * 唯一の観測である。**
 */
describe('reconsider: 現役の probe 結果を効かせる', () => {
  it('記録が ready でも、probe が unusable なら冷却へ入れて回す', async () => {
    const h = harness();
    await seedTwo(h); // tok-a が現役、どちらも `ready`

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: {
          verdict: 'unusable',
          reason: '取れた枠がすべて使い切られており、課金枠も使えない',
        },
        origin: { source: 'account_probe' },
      },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    // **文言をそのまま残す**（言い換えない）。
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.lastRejectedReason).toBe('取れた枠がすべて使い切られており、課金枠も使えない');
    expect(await isCooling(h, 'tok-a')).toBe(true);
  });

  it('probe が usable なら、止まった記録を消して「いつ開いたか」を残す', async () => {
    // **冷却が既定の5時間で入っていて、実際には枠がもっと早く開いていた回。**
    // 消さないと、その鍵は「使えるのに候補から外れている」状態で残り続ける。
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 4 * 60 * 60 * 1000,
        lastRejectedAt: AT,
        lastRejectedReason: "You've hit your usage limit",
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    // **回していない。** 鍵は1文字も変わっていない。
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 1 });
    // **止まった記録は消えている。**
    expect(await isCooling(h, 'tok-a')).toBe(false);
    // **「いつ開いたか」を残す材料が返る**（受信箱へは入れない。理由は
    // `settleTokenOutcome` の逐語）。**`source` は出所をそのまま引き継ぐ**（#681 (1)）。
    expect(outcome.recovered).toEqual({
      tokenId: 'tok-a',
      label: 'first',
      source: 'account_probe',
    });
    // **日誌に出る（`signal: 'none'` でも黙らない）。** 止まった側と対になる唯一の行。
    expect(tokenRotationEntry(outcome)?.event).toBe('recovered');
    // **`recoveredSource` も潰さず出る**（#681 (1)。`account_probe` と区別できる）。
    expect(tokenRotationEntry(outcome)?.recoveredSource).toBe('account_probe');
  });

  it('人間が外した行には触らない（probe が通っても戻さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        disabledAt: AT,
        lastRejectedAt: AT,
        lastRejectedReason: '上限',
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });

    // 記録は消していない（人間の判断を実装が黙って覆さない）。
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.disabledAt).toBe(AT);
    expect(row?.lastRejectedAt).toBe(AT);
    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.recovered).toBeUndefined();
  });

  it('probe が undecidable なら記録だけで判定する（unusable へ丸めない）', async () => {
    const h = harness();
    await seedTwo(h); // どちらも `ready`

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'undecidable', reason: 'probe が失敗した' },
        origin: { source: 'account_probe' },
      },
    });

    // 記録の上では現役が通るので、回さない。
    expect(outcome.kind).toBe('ignored');
    expect(outcome.signal).toBe('none');
    expect(h.spreadCalls).toEqual([]);
    expect(await isCooling(h, 'tok-a')).toBe(false);
  });
});

/**
 * **`usable` の2本目の生産者（#681 (1)）——あるトークンで層のターンが実際に
 * 成功した、という観測。** `account_probe` が見ていないセッション単位の上限に
 * 効く。マネージャーが下した3つの設計判断をそれぞれ固定する。
 */
describe('reconsider: ターンの成功（#681 (1)。usable の2本目の生産者）', () => {
  it('冷却中の記録が、ターンの成功で消える（recovered が turn_success で出る。本筋）', async () => {
    const h = harness();
    await seedTwo(h); // tok-a が現役、generation 1
    await h.stores.tokens.replace(
      (await h.stores.tokens.list()).map((token) =>
        token.id === 'tok-a'
          ? {
              ...token,
              cooldownUntil: Date.parse(AT) + 60 * 60_000,
              lastRejectedAt: AT,
              lastRejectedReason: '上限',
            }
          : token,
      ),
    );

    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-a', generation: 1 } },
      },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    // **回していない。** 消したのは止まった記録だけである。
    expect(h.spreadCalls).toEqual([]);
    expect(await isCooling(h, 'tok-a')).toBe(false);
    // **`account_probe` とは区別できる出所を持つ。**
    expect(outcome.recovered).toEqual({ tokenId: 'tok-a', label: 'first', source: 'turn_success' });
    expect(tokenRotationEntry(outcome)?.event).toBe('recovered');
    expect(tokenRotationEntry(outcome)?.recoveredSource).toBe('turn_success');
  });

  it('⚠️ 判断1の歯: 世代がずれた成功は捨てる（markTokenUsable を呼ばない）', async () => {
    const h = harness();
    await seedTwo(h); // tok-a が現役、generation 1
    await h.stores.tokens.replace(
      (await h.stores.tokens.list()).map((token) =>
        token.id === 'tok-a' ? { ...token, cooldownUntil: Date.parse(AT) + 60 * 60_000 } : token,
      ),
    );

    // **現役の世代は 1 だが、観測は世代 2 を名乗る**（もう回した後、あるいは
    // まだ試していない現役についての、遅れて届いた成功）。
    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-a', generation: 2 } },
      },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.recovered).toBeUndefined();
    // **記録は1文字も動いていない。** `markTokenUsable` は呼ばれていない。
    expect(await isCooling(h, 'tok-a')).toBe(true);
  });

  it('⚠️ 判断3の歯: 通る候補が在ってもターンの成功では回さない（usable 分岐に入れなかった場合も含む）', async () => {
    const h = harness();
    // **`tok-b` は通る候補として存在する**（`ready`）。記録の上でも現役
    // （`tok-missing`）はプールに行が無いので「通らない」——`account_probe` /
    // `tick` ならここから `stranded` 経由で `tok-b` へ回りうる状態である。
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 1 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-missing', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-missing', generation: 1 } },
      },
    });

    // **回っていない。** 成功は「いまの現役が通る」証拠であって「回すべき」
    // 証拠ではないので、通常の回転判定（`stranded` 経由の `sweepCandidates`）
    // へは絶対に落ちない。
    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-missing',
      generation: 1,
    });
  });

  it('⚠️ 判定の落ちた turn_succeeded（current 無し）でも回さない —— 見るのは reason である', async () => {
    // **`apps/daemon/src/token-watch.ts` の `pending` は
    // `TokenReconsiderReason` しか運べない。** ⟹ 契機だけを溜める形にすると、
    // `current` の落ちた `'turn_succeeded'` が実在しうる（実際に一度そう
    // 書いてあった）。あちら側でも溜めないようにしてあるが、**この関数が
    // `reason` を見ておけば、呼ぶ側が何をしても「成功では回らない」が成り立つ。**
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 1 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-missing', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'turn_succeeded' });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-missing',
      generation: 1,
    });
  });

  it('account_probe の既存の挙動は1ミリも変わっていない（回帰）', async () => {
    // **世代の門は `turn_success` にだけ掛かる。** `account_probe` は身元を
    // 運ばない観測なので、世代がずれていても（というより、そもそも
    // `observedBy` を持たないので）従来どおり効く。
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.replace(
      (await h.stores.tokens.list()).map((token) =>
        token.id === 'tok-a' ? { ...token, cooldownUntil: Date.parse(AT) + 60 * 60_000 } : token,
      ),
    );

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.recovered).toEqual({
      tokenId: 'tok-a',
      label: 'first',
      source: 'account_probe',
    });
    expect(await isCooling(h, 'tok-a')).toBe(false);
  });
});

/**
 * **park し直すのは改善のときだけ**（`parkImprovesOn`）。
 *
 * ここが無いと、**待っているあいだに世代が延々と増える** —— 見張りは目盛り
 * （60秒）ごとに同じ状態を見るので、現役（前に park した鍵）が冷却中である
 * かぎり毎回「通らない」と判定され、候補の中でいちばん早いものがもっと遅い鍵
 * でもそちらへ移してしまう。**増えた世代は走行中の観測を全部 `stale` にする** ⟹
 * 待っているだけで、本物の当たりを飲み込む側が強くなる。
 */
describe('park し直すのは、より早く戻る鍵のときだけ', () => {
  /** 現役 `tok-a` が `activeUntil` まで、候補 `tok-b` が `candidateUntil` まで冷却中。 */
  async function parked(h: Harness, activeUntil: number, candidateUntil: number): Promise<void> {
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'parked-key', value: 'value-a', order: 0, cooldownUntil: activeUntil },
      {
        id: 'tok-b',
        label: 'later-key',
        value: 'value-b',
        order: 1,
        cooldownUntil: candidateUntil,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 7, rotatedAt: AT });
  }

  it('候補のほうが遅いなら撒き直さない（世代を増やさない）', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 10 * 60_000, Date.parse(AT) + 60 * 60_000);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-a',
      generation: 7,
    });
    // **「候補が無い」と書かない。** 読む側が次に確かめるものが違う。
    if (outcome.kind !== 'exhausted') return;
    expect(outcome.why).toContain('遅い鍵へ移すのは改善ではない');
  });

  it('目盛りを何回回しても世代は動かない（延々と増える形が塞がっている）', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 10 * 60_000, Date.parse(AT) + 60 * 60_000);

    for (let i = 0; i < 5; i++) await h.rotator.reconsider({ reason: 'tick' });

    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 7 });
    expect(h.spreadCalls).toEqual([]);
  });

  it('候補のほうが早いなら撒き直す（改善なので移す）', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 60 * 60_000, Date.parse(AT) + 10 * 60_000);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-b');
    expect(outcome.generation).toBe(8);
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
  });

  it('現役が冷却中ではない（人間が外した）なら、戻る見込みの立つ鍵へ移す', async () => {
    // **待っても戻らない側に居る**ので、冷却中の候補でも改善である。
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'disabled-key', value: 'value-a', order: 0, disabledAt: AT },
      {
        id: 'tok-b',
        label: 'cooling-key',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 60 * 60_000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-b');
  });
});

/**
 * **文言が届かなかった回の冷却の記録に、観測できた事実を残す**
 * （人間の決定 2026-09-07）。
 *
 * ## なぜ要るか —— 「なぜ1日冷えているのか」が誰にも言えなかった
 *
 * 本番のプール（2026-09-07 の実測）は4本すべてが固定文言
 * `枠から追い返された（文言は届いていない）` を持ち、**うち1本だけ冷却が +34時間**
 * だった（他は1〜3時間）。⟹ `five_hour` で止まったのに長い枠のリセットを拾ったのか、
 * 本当に週の枠が尽きたのかを**判定する材料が記録の側に1つも無い。**
 *
 * **⚠️ 冷却の長さは変えていない。** `cooldownUntilFrom` の優先順は1文字も触って
 * いない —— 週の枠が尽きているなら1日冷やすのは正しく、どちらだったかは記録に
 * 無かった。**先に「言えるようにする」だけを入れる。**
 */
describe('冷却の記録に、期限の出所を残す', () => {
  async function coolWith(facts: Record<string, unknown> | undefined) {
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({
      // **文言を渡さない。** 渡した回はこの経路を通らない（SDK の文言をそのまま残す）。
      ...(facts === undefined ? {} : { facts: facts as never }),
      transition: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    return { row, h };
  }

  it('枠の resetsAt から採ったなら、そう書く', async () => {
    const at = Date.parse('2026-09-08T09:00:00.000Z');
    const { row } = await coolWith({ kind: 'seven_day_opus', status: 'rejected', resetsAt: at });

    expect(row?.cooldownUntil).toBe(at);
    // **どの枠で止まったか。** これが無いと +34時間が長すぎるのか判定できない。
    expect(row?.lastRejectedReason).toContain('枠: seven_day_opus');
    expect(row?.lastRejectedReason).toContain('status: rejected');
    expect(row?.lastRejectedReason).toContain('冷却の期限は枠の resetsAt から');
    expect(row?.lastRejectedReason).toContain('2026-09-08T09:00:00.000Z');
  });

  it('課金枠の overageResetsAt から採ったなら、そう書く', async () => {
    const at = Date.parse('2026-09-07T12:00:00.000Z');
    const { row } = await coolWith({ kind: 'five_hour', overageResetsAt: at });

    expect(row?.cooldownUntil).toBe(at);
    expect(row?.lastRejectedReason).toContain('冷却の期限は課金枠の overageResetsAt から');
  });

  it('どちらも届いていないなら「設定の既定から」と書く', async () => {
    // **「取れなかった」を値で埋めない。** 既定へ倒したこと自体を書く。
    const { row } = await coolWith({ kind: 'five_hour', status: 'rejected' });

    expect(row?.lastRejectedReason).toContain('冷却の期限は設定の既定から');
    expect(row?.lastRejectedReason).not.toContain('resetsAt から');
  });

  it('事実そのものが届いていないなら、そう書く', async () => {
    const { row } = await coolWith(undefined);

    expect(row?.lastRejectedReason).toContain('枠の事実も届いていない');
  });

  it('取れなかった欄は書かない（「不明」で埋めない）', async () => {
    // 埋めると、取れなかったことと「そういう値だった」が同じ顔になる。
    const { row } = await coolWith({ status: 'rejected' });

    expect(row?.lastRejectedReason).not.toContain('枠: ');
    expect(row?.lastRejectedReason).toContain('status: rejected');
  });

  it('文言が届いた回は、この経路を通らない（言い換えない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected' } as never,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');

    // **SDK が出した文言そのまま。** 事実の写しを混ぜない。
    expect(row?.lastRejectedReason).toBe(reached.text);
    expect(row?.lastRejectedReason).not.toContain('枠: five_hour');
  });
});
