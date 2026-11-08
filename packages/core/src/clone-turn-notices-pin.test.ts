import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeGatedSdk, fakeSdk, waitFor, type FakeCall } from './clone-test-harness.js';
import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { fakeManagerPool } from './manager-pool.test-support.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';

// 「ターン入口の断り書き」4 本（`CloneTurnNotices` の `situationFor`・`validityFor`・`quotaRecoveryFor`・`recoveredFoldFor`。
// 切り出す前は `Clone` の `#situationNoticeFor`・`#validityNoticeFor`・`#quotaRecoveryNoticeFor`・`#recoveredFoldNoticeFor`）を、
// `createClone` 経由で逐語に固定する。モデルへ渡る入力（`#runTurn` が `#pushInput` へ渡す文字列）と、畳んだ回の日誌の行を観測する。
// 切り出し（`clone-turn-notices.ts`）の前に置いた: 期待の文字列・件数は、仕様を先に書いたものではなく、
// 切り出し前の作りの出力を `vitest -u` で生成して目で読んで確かめた値である。「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 既存の試験（`clone-situation-notice`・`clone-quota-recovery-notice`・`clone-quota-recovered-fold`・`clone-recovered-notice-fold`・
// `clone-recovered-fold-pair-pin`）が `toContain` までしか縛っていない所（全文・閾値の境目・読み出しが投げたときの握り方・`list()` を引く回数・投げを握らないこと）を足す。
// 時刻の入る文面は `Date` だけを止めて固定する（タイマーは本物のまま。実時間の待ちは足さない）。

const FROZEN_AT = '2026-11-01T09:00:00.000Z';
const REPORTED_AT = '2026-11-01T08:00:00.000Z';
const SEPARATOR = '\n---\n';
const QUEUE_HEAD = '[system] 待ち行列（';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

function summary(overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: 'mgr-a',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: REPORTED_AT,
    updatedAt: REPORTED_AT,
    waiting: [],
    tokenGeneration: 3,
    activeTokenGeneration: 3,
    ...overrides,
  };
}

type ListFn = () => Promise<ManagerSummary[]>;

interface Rig {
  clone: CloneHost;
  calls: FakeCall[];
  stores: Stores;
  /** `ManagerPool.list()` を呼ばれた回数（全部の呼び元の合計） */
  listCalls(): number;
  /** 押さえておいたターンを進める（`gated` のときだけ） */
  release(): void;
  /** セッションへ渡った入力（古い順） */
  inputs(): string[];
}

interface RigOptions {
  list?: ListFn;
  runners?: ManagerPool['runners'];
  stores?: Stores;
  gated?: boolean;
  mergedBatchLimit?: number;
}

function rig(options: RigOptions = {}): Rig {
  const gated = options.gated === true ? fakeGatedSdk() : undefined;
  const sdk = gated ?? fakeSdk();
  const stores = options.stores ?? createMemoryStores();
  let listCalls = 0;
  const list = options.list ?? (() => Promise.resolve([summary()]));
  const managers = fakeManagerPool({
    list: () => {
      listCalls += 1;
      return list();
    },
    runners:
      options.runners ??
      (() =>
        Promise.resolve({
          runners: [
            {
              label: 'runner-0',
              state: 'connected' as const,
              since: REPORTED_AT,
              managers: [],
              revision: { status: 'unheard' as const },
            },
          ],
          unassigned: [],
          daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
        })),
  });
  const clone = createClone({
    reportSettleMs: 0,
    inboxSettleMs: 0,
    stores,
    queryFn: sdk.fn,
    env: {},
    managers,
    ...(options.mergedBatchLimit === undefined
      ? {}
      : { mergedBatchLimit: options.mergedBatchLimit }),
  });
  return {
    clone,
    calls: sdk.calls,
    stores,
    listCalls: () => listCalls,
    release: () => {
      gated?.release();
    },
    inputs: () => sdk.calls.flatMap((call) => (call.kind === 'session' ? call.inputs : [])),
  };
}

function report(id: string, managerId: string, extra: Record<string, unknown> = {}): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: REPORTED_AT,
    managerId,
    kind: 'report',
    text: `本文-${id}`,
    ...extra,
  } as InboxEvent;
}

/** 枠の知らせ 1 通（プール全体。`runner-registry` の external が担当を名指す形）。 */
function poolQuotaStop(id: string, managerIds: string[], extra: Record<string, unknown> = {}) {
  return {
    type: 'external',
    id,
    at: REPORTED_AT,
    source: 'runner-registry',
    identity: `quota-stop:${id}`,
    payload: { text: `枠に当たった ${id}`, quotaStopManagerIds: managerIds, ...extra },
  } as InboxEvent;
}

const firstInput = async (s: Rig): Promise<string> => {
  await waitFor(() => s.inputs().length >= 1, '最初のターンが投げられる');
  return s.inputs()[0] ?? '';
};

/** 先頭から、その後ろの最初の `---` の行（含む）まで。 */
function sectionAt(input: string, start: string): string {
  const from = input.indexOf(start);
  expect(from, `${start} が入力に無い`).toBeGreaterThanOrEqual(0);
  const end = input.indexOf(SEPARATOR, from);
  expect(end).toBeGreaterThan(from);
  return input.slice(from, end + SEPARATOR.length);
}

const situationOf = (input: string): string => sectionAt(input, '[system] いまの全体');

/** 待ち行列の節の手前（前提の断り・枠の回復の1節が並ぶ所）。 */
function prefixOf(input: string): string {
  const at = input.indexOf(QUEUE_HEAD);
  expect(at).toBeGreaterThanOrEqual(0);
  return input.slice(0, at);
}

const lineWith = (input: string, needle: string): string | null =>
  input.split('\n').find((line) => line.includes(needle)) ?? null;

async function putRows(stores: Stores, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const at = new Date(Date.parse(REPORTED_AT) - (count - i) * 1000).toISOString();
    await stores.inbox.put(
      {
        type: 'human_message',
        id: `evt-row-${i}`,
        at,
        text: `本文${i}`,
        conversationId: 'conv-row',
      },
      at,
    );
  }
}

describe('いまの全体の節（situationFor）の逐語固定', () => {
  it('全部入り: 鍵の行・受信箱の滞留（このターン自身は引く）・メモリの配達待ち行列', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'v-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'v-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: '2026-09-07T07:33:12.133Z',
    });
    // 束の上限を1にする: 別々の担当の報告が先頭の1件へまとまらず、待ち行列に2件残るため
    const s = rig({
      stores,
      mergedBatchLimit: 1,
      list: () =>
        Promise.resolve([
          summary({ managerId: 'mgr-a', status: 'running' }),
          summary({ managerId: 'mgr-b', status: 'done' }),
        ]),
    });
    s.clone.post(report('evt-a', 'mgr-a'));
    s.clone.post(report('evt-b', 'mgr-b'));
    s.clone.post(report('evt-c', 'mgr-c'));
    const input = await firstInput(s);
    await s.clone.stop();

    expect(situationOf(input)).toMatchInlineSnapshot(`
      "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
      委譲 全 2 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 1 / その他 0。話しかけられる 2 本。直近3時間に起こした 2 本（最後の起動は 1時間0分前）。
      器 1 台: connected 1。
      **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
      受信箱の未処理 2 件（最も古いものは 2026-11-01T08:00:00.000Z から）。
      メモリの配達待ち行列 2 件（配達を待ってプロセスのメモリに載っている分。器の行数（上）とは**同じ合図を別の数え方で見た値**で、ふつう両方に数えられている——**足しても引いても意味が無い。**食い違ったときだけ、器と配達がずれている印である。内訳を割る口は無い）。
      認証トークン: 現役は「second」（記録上は 使える）。プール 2 本: 使える 2 / 冷却中 0 / 人間が外している 0 / 失効 0。
      **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

      ---
      "
    `);
  });

  it('人間の発言のターンでは、list() は状況の 1 本だけ引く（前提・回復・畳みは引かない）', async () => {
    const s = rig();
    s.clone.post(humanMessage('やあ'));
    await firstInput(s);
    await s.clone.stop();

    expect(s.listCalls()).toBe(1);
  });

  describe('受信箱の滞留の件数は、このターンが処理している件数を引く', () => {
    const stubbed = async (pending: {
      count: number;
      oldestAt?: string;
    }): Promise<string | null> => {
      const stores = createMemoryStores();
      stores.inbox.pending = () => Promise.resolve(pending);
      const s = rig({ stores });
      s.clone.post(report('evt-1', 'mgr-a'));
      const input = await firstInput(s);
      await s.clone.stop();
      return lineWith(input, '受信箱の未処理');
    };

    it('件数 5・最古あり → 4 件（最古も載る）', async () => {
      expect(
        await stubbed({ count: 5, oldestAt: '2026-10-31T00:00:00.000Z' }),
      ).toMatchInlineSnapshot(
        `"受信箱の未処理 4 件（最も古いものは 2026-10-31T00:00:00.000Z から）。"`,
      );
    });

    it('件数 4・最古なし → 3 件（`（最も古いものは` の句が付かない）', async () => {
      expect(await stubbed({ count: 4 })).toMatchInlineSnapshot(`"受信箱の未処理 3 件。"`);
    });

    it('件数 1（このターン自身だけ）→ 行が出ない（最古があっても消える）', async () => {
      expect(
        await stubbed({ count: 1, oldestAt: '2026-10-31T00:00:00.000Z' }),
      ).toMatchInlineSnapshot(`null`);
    });

    it('件数 0（引くと負になる側）→ 行が出ない', async () => {
      expect(await stubbed({ count: 0 })).toMatchInlineSnapshot(`null`);
    });

    it('束が 2 件なら 2 件引く（件数 5 → 3 件）。1 件ではない', async () => {
      const stores = createMemoryStores();
      stores.inbox.pending = () =>
        Promise.resolve({ count: 5, oldestAt: '2026-10-31T00:00:00.000Z' });
      const s = rig({ stores, gated: true });
      s.clone.post(humanMessage('先客'));
      await waitFor(() => s.inputs().length === 1, '先客のターンが投げられる');
      s.clone.post(report('evt-a', 'mgr-a'));
      s.clone.post(report('evt-b', 'mgr-b'));
      s.release();
      await waitFor(() => s.inputs().length === 2, '束のターンが投げられる');
      const second = s.inputs()[1] ?? '';
      await s.clone.stop();

      expect(lineWith(second, 'マネージャー mgr-a')).not.toBeNull();
      expect(lineWith(second, '受信箱の未処理')).toMatchInlineSnapshot(
        `"受信箱の未処理 3 件（最も古いものは 2026-10-31T00:00:00.000Z から）。"`,
      );
    });
  });

  describe('閾値（50 件）を超えた回だけ peekPending() を引く', () => {
    async function backlogInput(
      count: number,
      peek?: (
        original: Stores['inbox']['peekPending'],
      ) => ReturnType<Stores['inbox']['peekPending']>,
    ): Promise<{ input: string; peeks: number }> {
      const stores = createMemoryStores();
      const s = rig({ stores });
      // 起動の後に直接ストアへ置く: 起動前だと起動時の拾い直しに乗って処理され、純粋な滞留を模せない（`peekPending` の呼び元も増える）
      await putRows(stores, count);
      let peeks = 0;
      const original = stores.inbox.peekPending.bind(stores.inbox);
      stores.inbox.peekPending = () => {
        peeks += 1;
        return peek === undefined ? original() : peek(original);
      };
      s.clone.post(report('evt-trigger', 'mgr-a'));
      const input = await firstInput(s);
      await s.clone.stop();
      return { input, peeks };
    }

    it('50 件 + このターン自身 → 滞留 50 件ちょうど: 引かない・内訳なし', async () => {
      const { input, peeks } = await backlogInput(50);
      expect(peeks).toBe(0);
      expect(situationOf(input)).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        受信箱の未処理 50 件（最も古いものは 2026-11-01T07:59:10.000Z から）。
        認証トークン: 現役の指名は**まだ一度も無い**（プールからまだ一度も回していないので、鍵は撒かれていない）。プール 0 本: 使える 0 / 冷却中 0 / 人間が外している 0 / 失効 0。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });

    it('51 件 + このターン自身 → 滞留 51 件: 引く・内訳あり', async () => {
      const { input, peeks } = await backlogInput(51);
      expect(peeks).toBe(1);
      expect(situationOf(input)).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        ⚠ 受信箱の未処理 51 件（最も古いものは 2026-11-01T07:59:09.000Z から）。種類: human_message 51 / manager_message 1（器の生の行 52 件を数えた——このターン自身の分は引いていないので、上の件数と1件前後ずれることがある。本文は載せない。残り（送信元 / 同一本文 / 器の入れ替え回数 / 齢）は \`manager_list\` で見る）。
        認証トークン: 現役の指名は**まだ一度も無い**（プールからまだ一度も回していないので、鍵は撒かれていない）。プール 0 本: 使える 0 / 冷却中 0 / 人間が外している 0 / 失効 0。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });

    it('引いた内訳が読めなくても、件数の行は消えない（内訳だけ落ちる）', async () => {
      const { input, peeks } = await backlogInput(51, () =>
        Promise.reject(new Error('内訳が読めない')),
      );
      expect(peeks).toBe(1);
      expect(situationOf(input)).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        ⚠ 受信箱の未処理 51 件（最も古いものは 2026-11-01T07:59:09.000Z から）。内訳（種類 / 同一本文 / 器の入れ替え回数 / 齢）は \`manager_list\` で割れる。
        認証トークン: 現役の指名は**まだ一度も無い**（プールからまだ一度も回していないので、鍵は撒かれていない）。プール 0 本: 使える 0 / 冷却中 0 / 人間が外している 0 / 失効 0。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });

    it('内訳に読めない行が在れば、その件数が内訳の注記に載る（peekPending の unreadable を渡す）', async () => {
      const { input } = await backlogInput(51, async (original) => ({
        ...(await original()),
        unreadable: [{ reason: '壊れた行 1' }, { id: 'evt-broken', reason: '壊れた行 2' }],
      }));
      expect(situationOf(input)).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        ⚠ 受信箱の未処理 51 件（最も古いものは 2026-11-01T07:59:09.000Z から）。種類: human_message 51 / manager_message 1（器の生の行 52 件を数えた（このほか読めない行が 2 件あり、この数にも種類にも入っていない。壊れた行であって、処理済みではない。\`manager_list\` で id が分かる）——このターン自身の分は引いていないので、上の件数と1件前後ずれることがある。本文は載せない。残り（送信元 / 同一本文 / 器の入れ替え回数 / 齢）は \`manager_list\` で見る）。
        認証トークン: 現役の指名は**まだ一度も無い**（プールからまだ一度も回していないので、鍵は撒かれていない）。プール 0 本: 使える 0 / 冷却中 0 / 人間が外している 0 / 失効 0。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });
  });

  describe('読み出しが投げたときの握り方', () => {
    const humanInput = async (s: Rig): Promise<string> => {
      s.clone.post(humanMessage('やあ'));
      const input = await firstInput(s);
      await s.clone.stop();
      return input;
    };

    it('list() が投げる → 状況ごと「数えられなかった」（時刻・理由付き）', async () => {
      const s = rig({ list: () => Promise.reject(new Error('list が壊れた')) });
      expect(situationOf(await humanInput(s))).toMatchInlineSnapshot(`
        "[system] いまの全体を数えられなかった（09:00:00Z 時点）: Error: list が壊れた
        これは「全部片付いている」ではなく「**数えられなかった**」である。本数が要るなら \`manager_list\` / \`runner_list\` を自分で呼ぶこと。

        ---
        "
      `);
    });

    it('runners() が投げる → 同じく「数えられなかった」', async () => {
      const s = rig({ runners: () => Promise.reject(new Error('runners が壊れた')) });
      expect(situationOf(await humanInput(s))).toMatchInlineSnapshot(`
        "[system] いまの全体を数えられなかった（09:00:00Z 時点）: Error: runners が壊れた
        これは「全部片付いている」ではなく「**数えられなかった**」である。本数が要るなら \`manager_list\` / \`runner_list\` を自分で呼ぶこと。

        ---
        "
      `);
    });

    it('鍵の一覧だけが読めない → 委譲・器は残り、鍵の行は「読めなかった」と名乗る', async () => {
      const stores = createMemoryStores();
      stores.tokens.list = () => Promise.reject(new Error('鍵の一覧が落ちた'));
      expect(situationOf(await humanInput(rig({ stores })))).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        認証トークン: **プールを読めなかった**（塞がっているかどうかは、ここからは言えない）。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });

    it('現役の鍵だけが読めない（一覧は読める）→ 鍵の行は「読めなかった」側へ倒れる', async () => {
      const stores = createMemoryStores();
      await stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'v-a', order: 0 }]);
      stores.tokens.readActive = () => Promise.reject(new Error('現役が読めない'));
      expect(situationOf(await humanInput(rig({ stores })))).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        認証トークン: **現役の指名を読めなかった**（プールの内訳は下のとおり読めている）。プール 1 本: 使える 1 / 冷却中 0 / 人間が外している 0 / 失効 0。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });

    it('受信箱の滞留だけが読めない → 「数えられなかった」の行が出て、他は残る', async () => {
      const stores = createMemoryStores();
      stores.inbox.pending = () => Promise.reject(new Error('受信箱が落ちた'));
      expect(situationOf(await humanInput(rig({ stores })))).toMatchInlineSnapshot(`
        "[system] いまの全体（09:00:00Z に数えた材料だけ。何をするかは決めない）。
        委譲 全 1 本: 走行中 1 / 返事待ち 0 / 背景処理待ち 0 / 手が空いている 0 / その他 0。話しかけられる 1 本。直近3時間に起こした 1 本（最後の起動は 1時間0分前）。
        器 1 台: connected 1。
        **「手が空いている」は「空き枠」ではない** — この器に定員は無いので、置けるかどうかはここでは答えていない。**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく失敗で終わった委譲も \`done\` のまま座る（セッションが生きているためで、仕様である）。その本数は1本以上あるときだけ上の行に出る。**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限そのもので止まった委譲も \`done\` のまま座る（鍵の回転を待っているだけで、セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、待っていても「手が空いている」側に数える。**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — \`status\` が \`running\` でも、背景処理待ちの印が立っていればそちらへ数える。**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと消えた宛先を持つ委譲も \`running\` のまま座る（\`isLive()\` は動かさない。仕様である）。その本数も1本以上あるときだけ上の行に出る。「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。個別の状態は \`manager_list\` / \`runner_list\` で見る。
        受信箱の未処理を数えられなかった（\`manager_list\` で自分で引くこと）。
        認証トークン: 現役の指名は**まだ一度も無い**（プールからまだ一度も回していないので、鍵は撒かれていない）。プール 0 本: 使える 0 / 冷却中 0 / 人間が外している 0 / 失効 0。
        **⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは1つも走らない（\`#usageBlocked\`）—— **いまあなたが書けているなら、枠は全面的には閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**（回っても文言は文脈に残る）—— 現役の状態は上の行か \`token_list\` で見る。**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**

        ---
        "
      `);
    });
  });
});

describe('前提の断り書き（validityFor）の逐語固定', () => {
  const firstPrefix = async (s: Rig, event: InboxEvent): Promise<string> => {
    s.clone.post(event);
    const input = await firstInput(s);
    await s.clone.stop();
    return prefixOf(input);
  };

  it('積んだ時点の状態と今が違う → 「報告が名乗った前提は動いています」（status が変わった）', async () => {
    const s = rig({ list: () => Promise.resolve([summary({ status: 'done' })]) });
    expect(
      await firstPrefix(s, report('evt-1', 'mgr-a', { statusAtDelivery: 'running' })),
    ).toMatchInlineSnapshot(
      `"⚠️ この報告が受信箱へ積まれた時点で mgr-a は \`running\` でしたが、この断り書きを組んだ時点では \`done\` です（報告が名乗った前提は動いています。中身が要らなくなったとは限りません）。"`,
    );
  });

  it('同じ → 何も言わない。名乗っていない回（statusAtDelivery 無し）も何も言わない。ただし list() は状況と前提で 2 本引く', async () => {
    const same = rig({ list: () => Promise.resolve([summary({ status: 'running' })]) });
    expect(await firstPrefix(same, report('evt-1', 'mgr-a', { statusAtDelivery: 'running' }))).toBe(
      '',
    );
    expect(same.listCalls()).toBe(2);

    const unclaimed = rig();
    expect(await firstPrefix(unclaimed, report('evt-2', 'mgr-a'))).toBe('');
    expect(unclaimed.listCalls()).toBe(2);
  });

  it('list() が投げる → 「確かめられなかった」（理由付き）。一覧に担当が居ない → 「一覧に居ない」', async () => {
    const throwing = rig({ list: () => Promise.reject(new Error('名簿が読めない')) });
    expect(
      await firstPrefix(throwing, report('evt-1', 'mgr-a', { statusAtDelivery: 'running' })),
    ).toMatchInlineSnapshot(
      `"⚠️ この報告が受信箱へ積まれた時点で mgr-a は \`running\` でしたが、この断り書きを組む時点の状態を引けませんでした（Error: 名簿が読めない）。**「変わっていない」ではなく「確かめられなかった」です。**"`,
    );

    const missing = rig({ list: () => Promise.resolve([summary({ managerId: 'mgr-other' })]) });
    expect(
      await firstPrefix(missing, report('evt-2', 'mgr-a', { statusAtDelivery: 'running' })),
    ).toMatchInlineSnapshot(
      `"⚠️ この報告が受信箱へ積まれた時点で mgr-a は \`running\` でしたが、この断り書きを組む時点の状態を引けませんでした（mgr-a が一覧に居ない）。**「変わっていない」ではなく「確かめられなかった」です。**"`,
    );
  });

  it('報告でない知らせ（質問）の束では、前提の断りのために list() を引き足さない（状況の 1 本 + 質問を組む側の 1 本。前提の断りは 0 本）', async () => {
    const s = rig();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-q',
      at: REPORTED_AT,
      managerId: 'mgr-a',
      kind: 'question',
      requestId: 'req-1',
      text: '聞きたい',
      statusAtDelivery: 'running',
    } as InboxEvent);
    const input = await firstInput(s);
    await s.clone.stop();

    expect(input).not.toContain('この報告が');
    expect(s.listCalls()).toBe(2);
  });

  it('起点の違う束: 担当ごとに最初の報告で見る（届いた順・同じ担当の 2 件目は見ない）', async () => {
    const s = rig({
      gated: true,
      list: () =>
        Promise.resolve([
          summary({ managerId: 'mgr-a', status: 'done' }),
          summary({ managerId: 'mgr-c', status: 'running' }),
        ]),
    });
    s.clone.post(humanMessage('先客'));
    await waitFor(() => s.inputs().length === 1, '先客のターンが投げられる');
    s.clone.post(report('evt-a1', 'mgr-a', { statusAtDelivery: 'running' }));
    s.clone.post(report('evt-a2', 'mgr-a', { statusAtDelivery: 'failed' }));
    s.clone.post(report('evt-b1', 'mgr-b', { statusAtDelivery: 'running' }));
    s.clone.post(report('evt-c1', 'mgr-c', { statusAtDelivery: 'running' }));
    s.release();
    await waitFor(() => s.inputs().length === 2, '束のターンが投げられる');
    const second = s.inputs()[1] ?? '';
    await s.clone.stop();

    expect(prefixOf(second)).toMatchInlineSnapshot(
      `"⚠️ この報告が受信箱へ積まれた時点で mgr-a は \`running\` でしたが、この断り書きを組んだ時点では \`done\` です（報告が名乗った前提は動いています。中身が要らなくなったとは限りません）。⚠️ この報告が受信箱へ積まれた時点で mgr-b は \`running\` でしたが、この断り書きを組む時点の状態を引けませんでした（mgr-b が一覧に居ない）。**「変わっていない」ではなく「確かめられなかった」です。**"`,
    );
  });
});

describe('枠の回復の1節（quotaRecoveryFor）の逐語固定', () => {
  const prefixFor = async (s: Rig, event: InboxEvent): Promise<string> => {
    s.clone.post(event);
    const input = await firstInput(s);
    await s.clone.stop();
    return prefixOf(input);
  };

  it('名指した担当が全員戻っている → 「すべて回復している」の1節（積まれてからの分数つき）', async () => {
    const s = rig({
      list: () =>
        Promise.resolve([
          summary({ managerId: 'mgr-a' }),
          summary({
            managerId: 'mgr-b',
            status: 'done',
            tokenGeneration: 4,
            activeTokenGeneration: 4,
          }),
        ]),
    });
    expect(await prefixFor(s, poolQuotaStop('evt-1', ['mgr-a', 'mgr-b']))).toMatchInlineSnapshot(`
      "✅ **配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 2 本はすべて回復している**: mgr-a（\`running\`・鍵の世代 3）、mgr-b（\`done\`・鍵の世代 4）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。**本文の「止まった」は積まれた時点の話で、いま止まっているとは読まないこと。** 回復を確かめ直すために \`manager_list\` / \`token_list\` を引く必要は無い。

      ---
      "
    `);
  });

  it('一部だけ戻っている → 戻った担当とまだの担当を分けて言う', async () => {
    const s = rig({
      list: () =>
        Promise.resolve([
          summary({ managerId: 'mgr-a' }),
          summary({ managerId: 'mgr-b', usageStoppedAt: REPORTED_AT }),
        ]),
    });
    expect(await prefixFor(s, poolQuotaStop('evt-1', ['mgr-a', 'mgr-b']))).toMatchInlineSnapshot(`
      "配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 2 本のうち **1 本は回復している**: mgr-a（\`running\`・鍵の世代 3）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること。
      まだ回復したと言えない 1 本: mgr-b（枠で止まった印が残っている。2026-11-01T08:00:00.000Z から）。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。本文の「止まった」は積まれた時点の話である。

      ---
      "
    `);
  });

  it('1本も戻っていない → 1節は出ない（list() は状況と回復の 2 本）', async () => {
    const s = rig({ list: () => Promise.resolve([summary({ live: false })]) });
    expect(await prefixFor(s, poolQuotaStop('evt-1', ['mgr-a']))).toBe('');
    expect(s.listCalls()).toBe(2);
  });

  it('list() が投げる → 「確かめられなかった」（理由付き）', async () => {
    const s = rig({ list: () => Promise.reject(new Error('名簿が読めない')) });
    expect(await prefixFor(s, poolQuotaStop('evt-1', ['mgr-a']))).toMatchInlineSnapshot(`
      "⚠ この「枠に当たって止まった」の知らせが名指す担当が、配る時点（2026-11-01T09:00:00.000Z）で回復しているかを確かめられなかった（Error: 名簿が読めない）。知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。

      ---
      "
    `);
  });

  it('枠の知らせの報告（quotaStop）に前提の断りも付くとき、回復の1節が先・前提の断りが後', async () => {
    const s = rig({
      list: () => Promise.resolve([summary({ status: 'done', lastReportAt: FROZEN_AT })]),
    });
    expect(
      await prefixFor(
        s,
        report('evt-1', 'mgr-a', {
          synthesized: true,
          quotaStop: true,
          statusAtDelivery: 'running',
        }),
      ),
    ).toMatchInlineSnapshot(`
      "✅ **配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 1 本はすべて回復している**: mgr-a（\`done\`・鍵の世代 3）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。**本文の「止まった」は積まれた時点の話で、いま止まっているとは読まないこと。** 回復を確かめ直すために \`manager_list\` / \`token_list\` を引く必要は無い。

      ---
      ⚠️ この報告が受信箱へ積まれた時点で mgr-a は \`running\` でしたが、この断り書きを組んだ時点では \`done\` です（報告が名乗った前提は動いています。中身が要らなくなったとは限りません）。"
    `);
    // 状況・前提・回復の 3 本（5 時間枠の印が無い報告は畳みの判定で list() を引かない）
    expect(s.listCalls()).toBe(3);
  });

  it('起点の違う束に枠の知らせが 2 通混ざる → 名指す担当は両方（束の全件から集める）。積まれた時刻は早い方', async () => {
    const s = rig({
      gated: true,
      list: () =>
        Promise.resolve([summary({ managerId: 'mgr-a' }), summary({ managerId: 'mgr-b' })]),
    });
    s.clone.post(humanMessage('先客'));
    await waitFor(() => s.inputs().length === 1, '先客のターンが投げられる');
    s.clone.post(report('evt-q1', 'mgr-a', { synthesized: true, quotaStop: true }));
    s.clone.post(
      report('evt-q2', 'mgr-b', {
        synthesized: true,
        quotaStop: true,
        at: '2026-11-01T07:30:00.000Z',
      }),
    );
    s.release();
    await waitFor(() => s.inputs().length === 2, '束のターンが投げられる');
    const second = s.inputs()[1] ?? '';
    await s.clone.stop();

    expect(prefixOf(second)).toMatchInlineSnapshot(`
      "✅ **配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 2 本はすべて回復している**: mgr-a（\`running\`・鍵の世代 3）、mgr-b（\`running\`・鍵の世代 3）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること。
      知らせが積まれたのは 2026-11-01T07:30:00.000Z（90 分前）。**本文の「止まった」は積まれた時点の話で、いま止まっているとは読まないこと。** 回復を確かめ直すために \`manager_list\` / \`token_list\` を引く必要は無い。

      ---
      "
    `);
  });

  it('枠の知らせでない報告・外部には list() を足さない（外部の枠の知らせは状況と回復の 2 本）', async () => {
    const plain = rig();
    plain.clone.post(report('evt-1', 'mgr-a'));
    await firstInput(plain);
    await plain.clone.stop();
    expect(plain.listCalls()).toBe(2);

    const external = rig();
    external.clone.post(poolQuotaStop('evt-2', ['mgr-a']));
    await firstInput(external);
    await external.clone.stop();
    expect(external.listCalls()).toBe(2);
  });
});

describe('戻っていた担当の知らせの畳み（recoveredFoldFor）の、畳んだ日誌の行の逐語固定', () => {
  const FOLD_LINE = 'ターンを起こさずに畳んだ';

  async function foldedLine(list: ListFn, event: InboxEvent): Promise<string> {
    const s = rig({ list });
    s.clone.post(event);
    const find = async (): Promise<string | undefined> =>
      ((await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[])
        .map((row) => row.text)
        .find((text) => text.includes(FOLD_LINE));
    await waitFor(async () => (await find()) !== undefined, '畳んだ行が日誌に書かれる');
    const text = (await find()) ?? '';
    // 畳んだ回はモデルへ1文字も渡さない
    expect(s.inputs()).toEqual([]);
    await s.clone.stop();
    return text;
  }

  it('枠の知らせ（5 時間枠の印）: 畳んだ行の全文', async () => {
    const text = await foldedLine(
      () => Promise.resolve([summary()]),
      report('evt-1', 'mgr-a', { synthesized: true, quotaStop: true, quotaSessionWindow: true }),
    );
    expect(text).toMatchInlineSnapshot(`
      "[間引き] 名指す担当がもう戻っていた枠の知らせなので、ターンを起こさずに畳んだ（モデルへは1文字も渡していない）: manager_message managerId=mgr-a kind=report chars=8

      5時間枠で止まった知らせだが、配る時点で名指す担当は全員いまの世代の鍵で戻っていた（\`running\`、または \`done\` で知らせより後のターンが成功している）。

      ✅ **配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 1 本はすべて回復している**: mgr-a（\`running\`・鍵の世代 3）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。**本文の「止まった」は積まれた時点の話で、いま止まっているとは読まないこと。** 回復を確かめ直すために \`manager_list\` / \`token_list\` を引く必要は無い。

      ---
      "
    `);
  });

  it('枠以外の知らせ（foldWhenBack）: 世代を移った場合の全文（積んだ時点の世代を名乗る）', async () => {
    const text = await foldedLine(
      () => Promise.resolve([summary({ tokenGeneration: 3, activeTokenGeneration: 3 })]),
      report('evt-1', 'mgr-a', { foldWhenBack: { movedFromGeneration: 2 } }),
    );
    expect(text).toMatchInlineSnapshot(`
      "[間引き] 名指す担当がもう戻っていた知らせなので、ターンを起こさずに畳んだ（モデルへは1文字も渡していない）: manager_message managerId=mgr-a kind=report chars=8

      ✅ 配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 mgr-a はいまの世代の鍵で戻っている（\`running\`・鍵の世代 3。知らせを積んだ時点の世代 2 から移った）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること・\`running\`、または \`done\` で知らせより後のターンが成功していること。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。

      ---
      "
    `);
  });

  it('枠以外の知らせ（foldWhenBack）: 世代を問わない束の全文', async () => {
    const text = await foldedLine(
      () => Promise.resolve([summary()]),
      report('evt-1', 'mgr-a', { foldWhenBack: {} }),
    );
    expect(text).toMatchInlineSnapshot(`
      "[間引き] 名指す担当がもう戻っていた知らせなので、ターンを起こさずに畳んだ（モデルへは1文字も渡していない）: manager_message managerId=mgr-a kind=report chars=8

      ✅ 配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、この知らせが名指す担当 mgr-a はいまの世代の鍵で戻っている（\`running\`・鍵の世代 3）。回復と読んだ根拠は、live であること・枠で止まった印が降りていること・鍵の世代が現役と一致すること・\`running\`、または \`done\` で知らせより後のターンが成功していること。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。

      ---
      "
    `);
  });

  it('枠以外の知らせ（引き取り直し attached）: 全文', async () => {
    const text = await foldedLine(
      () =>
        Promise.resolve([
          summary({ tokenGeneration: undefined, activeTokenGeneration: undefined }),
        ]),
      report('evt-1', 'mgr-a', { foldWhenBack: { attached: true } }),
    );
    expect(text).toMatchInlineSnapshot(`
      "[間引き] 名指す担当がもう戻っていた知らせなので、ターンを起こさずに畳んだ（モデルへは1文字も渡していない）: manager_message managerId=mgr-a kind=report chars=8

      ✅ 配る時点（2026-11-01T09:00:00.000Z）の担当一覧では、デーモン再起動で引き取り直したこの担当 mgr-a は live で \`running\`（枠で止まった印なし）。runner の中で走り続けていると読み、本文（最後の報告の抜粋）は日誌に全文で残してある。
      知らせが積まれたのは 2026-11-01T08:00:00.000Z（60 分前）。

      ---
      "
    `);
  });

  it('list() が投げたら畳まず届ける（どちらの印でも。日誌に畳んだ行は残らず、ターンが走る）', async () => {
    const flagsOf: Array<[string, Record<string, unknown>]> = [
      ['枠の知らせ', { synthesized: true, quotaStop: true, quotaSessionWindow: true }],
      ['枠以外の知らせ', { foldWhenBack: {} }],
    ];
    for (const [label, flags] of flagsOf) {
      const s = rig({ list: () => Promise.reject(new Error('名簿が読めない')) });
      s.clone.post(report('evt-1', 'mgr-a', flags));
      const input = await firstInput(s);
      const folded = (
        (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[]
      ).filter((row) => row.text.includes('ターンを起こさずに畳んだ'));
      await s.clone.stop();

      expect(input, label).toContain('本文-evt-1');
      expect(folded, label).toEqual([]);
    }
  });

  it('印の無い報告・人間の発言は一覧を畳みの判定のために引かない（状況の 1 本・前提を含めた本数だけ）', async () => {
    const human = rig();
    human.clone.post(humanMessage('やあ'));
    await firstInput(human);
    await human.clone.stop();
    expect(human.listCalls()).toBe(1);

    // 週の上限（5 時間枠の印が無い quotaStop）の報告: 印が無いので畳みの判定は一覧を引かない
    const week = rig();
    week.clone.post(report('evt-w', 'mgr-a', { synthesized: true, quotaStop: true }));
    await firstInput(week);
    await week.clone.stop();
    expect(week.listCalls()).toBe(3);
  });
});

describe('3 本は投げを握らない（受信箱のループが落ちる。`.catch` を足さない）', () => {
  /**
   * `list()` が `badAt` 番目の呼びで配列でない値を返す（`'detail' in managers` が投げる）。
   * 押さえた `list()` の最中に `stop()` を呼んでおく: 受信箱のループの落ちを `stop()` が待つ側に回し、
   * 握り手の無い rejection（vitest が落とす）にしないため。
   */
  async function loopDeath(
    event: InboxEvent,
    badAt: number,
  ): Promise<{ outcome: string; lines: string[]; inputs: string[]; pending: number }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const s = rig({
      list: async () => {
        const index = calls;
        calls += 1;
        if (index === badAt) {
          await gate;
          return undefined as never;
        }
        return [summary({ status: 'done' })];
      },
    });
    s.clone.post(event);
    await waitFor(() => calls >= badAt + 1, '投げさせる list() が呼ばれる');
    let outcome = '';
    const lines = await captureStderr(async () => {
      const stopped = s.clone.stop().then(
        () => 'resolved',
        (error: unknown) => `rejected: ${String(error)}`,
      );
      release();
      outcome = await stopped;
    });
    const pending = (await s.stores.inbox.claimPending()).length;
    return { outcome, lines, inputs: s.inputs(), pending };
  }

  const DEAD = "rejected: TypeError: Cannot use 'in' operator to search for 'detail' in undefined";

  it('validityFor（2 本目の list()）: 落ちたループは stop() が拒否で返す。モデルへは渡らず、行は未読のまま', async () => {
    const result = await loopDeath(report('evt-1', 'mgr-a', { statusAtDelivery: 'running' }), 1);
    expect(result.outcome).toBe(DEAD);
    expect(result.lines.join('')).toContain('クローンの受信箱のループが例外で終わりました');
    expect(result.inputs).toEqual([]);
    expect(result.pending).toBe(1);
  });

  it('quotaRecoveryFor（2 本目の list()）: 同じく落ちる', async () => {
    const result = await loopDeath(poolQuotaStop('evt-1', ['mgr-a']), 1);
    expect(result.outcome).toBe(DEAD);
    expect(result.lines.join('')).toContain('クローンの受信箱のループが例外で終わりました');
    expect(result.inputs).toEqual([]);
    expect(result.pending).toBe(1);
  });

  it('recoveredFoldFor（#pump の 1 本目の list()）: 同じく落ちる', async () => {
    const result = await loopDeath(
      report('evt-1', 'mgr-a', { synthesized: true, quotaStop: true, quotaSessionWindow: true }),
      0,
    );
    expect(result.outcome).toBe(DEAD);
    expect(result.lines.join('')).toContain('クローンの受信箱のループが例外で終わりました');
    expect(result.inputs).toEqual([]);
    expect(result.pending).toBe(1);
  });
});
