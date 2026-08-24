import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createTokenRotator,
  type TokenProbePort,
  type TokenSpreadPort,
  type TokenSpreadResult,
} from './token-rotator.js';
import type { Stores } from './store.js';
import type { UsageLimitNotice } from './usage-limits.js';

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
  spreadCalls: { id: string; value: string }[];
  probeCalls: { id: string; value: string }[];
  rotator: ReturnType<typeof createTokenRotator>;
}

function harness(
  options: {
    verdict?: TokenProbePort['probe'] extends (t: never) => Promise<infer V> ? V : never;
    spreadResults?: TokenSpreadResult[];
  } = {},
): Harness {
  const stores = createMemoryStores();
  const spreadCalls: { id: string; value: string }[] = [];
  const probeCalls: { id: string; value: string }[] = [];

  const probe: TokenProbePort = {
    async probe(token) {
      probeCalls.push(token);
      return options.verdict ?? { verdict: 'usable' };
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
    now: () => new Date(AT),
  });
  return { stores, spreadCalls, probeCalls, rotator };
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
    expect(h.spreadCalls).toEqual([{ id: 'tok-b', value: 'value-b' }]);
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

describe('世代の照合（受け入れ基準: 同時に届いても回るのは1回だけ）', () => {
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
  it('いちばん早く戻るものとその時刻を出す', async () => {
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

    expect(outcome.kind).toBe('exhausted');
    if (outcome.kind !== 'exhausted') return;
    expect(outcome.earliest).toEqual({
      tokenId: 'tok-b',
      label: 'second',
      cooldownUntil: Date.parse(AT) + 5_000,
    });
    // 先頭へ戻っていない（現役は変わらず、撒いてもいない）。
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-a', generation: 1 });
    expect(h.spreadCalls).toEqual([]);
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
    expect(h.probeCalls).toEqual([{ id: 'tok-b', value: 'value-b' }]);
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
