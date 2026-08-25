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
  rotator: ReturnType<typeof createTokenRotator>;
}

function harness(
  options: {
    verdict?: TokenProbePort['probe'] extends (t: never) => Promise<infer V> ? V : never;
    spreadResults?: TokenSpreadResult[];
  } = {},
): Harness {
  const stores = createMemoryStores();
  const spreadCalls: ({ id: string; generation: number } & TokenCredential)[] = [];
  const probeCalls: ({ id: string } & TokenCredential)[] = [];

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

  it('世代の合わない通知は出さない（1回の当たりで日誌を埋めない）', () => {
    // 同じ当たりでマネージャーの数だけ届く。
    expect(
      describeTokenRotation({
        kind: 'ignored',
        signal: 'reached',
        freshness: 'stale',
        why: 'もう回した後の通知',
      }),
    ).toBeNull();
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
