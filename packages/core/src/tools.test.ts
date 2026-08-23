import { describe, expect, it, vi } from 'vitest';

import type { ManagerDenial, ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import { renderMemoryDocuments } from './memory.js';
import { createProfileService } from './profile-service.js';
import { journalEntrySchema, type ChatStreamEvent } from './schema.js';
import type { CloneRuntimeFacts } from './self.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { buildCloneSystemPrompt } from './prompt.js';
import {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  createCloneTools,
  qualifiedToolName,
} from './tools.js';
import type { AccountUsageState } from './usage-snapshot.js';
import { usageDate } from './usage.js';

interface Harness {
  stores: Stores;
  emitted: ChatStreamEvent[];
  sent: { managerId: string; message: string; decision?: string; requestId?: string }[];
  started: { request: string; cwd?: string; runnerId?: string }[];
  /** 人間と同じ口（ManagerPool.abort）へ届いた停止。 */
  aborted: { managerId: string; reason?: string }[];
  /** runner へ降ろされたプロファイルの本文。 */
  distributed: string[];
  /** 走っていることになっているマネージャー（直接いじって状況を作る）。 */
  running: ManagerSummary[];
  /** 確認へ上がらず止められた道具（manager_id → 古い順）。 */
  denied: Map<string, ManagerDenial[]>;
  /**
   * `abort()` が返す outcome を差し替える（既定は `'stopped'`）。
   *
   * `manager_stop` の文言が outcome ごとに分かれることを見るためのもので、
   * `'not_stopped'` / `'unknown'` のときは「本物と同じところまで動かす」
   * （status を畳む・セッションを切る）を**しない**——それが outcome の意味である。
   */
  setAbortOutcome(outcome: 'stopped' | 'not_stopped' | 'unknown', sessionGone?: boolean): void;
  /**
   * `manager_start` の指名が無いとき、`Pool.start()` が返す `runnerId`
   * （自動配置が選んだ器）を差し替える。`undefined` にすると「未記録」の文言を
   * 見るための状態を作れる。
   */
  setAutoRunnerId(runnerId: string | undefined): void;
  /** `runner_list` が読む `ManagerPool.runners()` の返り値を差し替える。 */
  setRunnersOverview(overview: RunnerFleetOverview): void;
  /**
   * `manager_transcript` が読む `ManagerPool.transcript()` の返り値を差し替える。
   * 設定しなければ既定で `null`（3段のどこにも無い、を模している）。
   */
  setTranscript(managerId: string, body: string | null): void;
  /** `runners()` に渡された引数（`fingerprints` / `resources` を渡したかどうかの検査用）。 */
  runnersCalls: { fingerprints?: boolean; resources?: boolean }[];
  /**
   * この道具呼び出しが `memory_update.cause` でどう名乗るか（既定 `'clone'`）。
   *
   * **`ToolContext.memoryCause` の doc どおり、呼ぶたびに評価される値。** ここで
   * 差し替えれば、次の `call()` からその値になる（`createCloneTools` を呼び直す
   * 必要が無い ＝ 本番でセッション中に何度も呼ばれる形をそのまま模す）。
   */
  setMemoryCause(cause: 'distill' | 'clone'): void;
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

function harness(runtime?: () => CloneRuntimeFacts): Harness {
  const stores = createMemoryStores();
  const emitted: ChatStreamEvent[] = [];
  const sent: { managerId: string; message: string; decision?: string; requestId?: string }[] = [];
  const started: { request: string; cwd?: string; runnerId?: string }[] = [];
  const aborted: { managerId: string; reason?: string }[] = [];
  const running: ManagerSummary[] = [];
  const denied = new Map<string, ManagerDenial[]>();
  let abortOutcome: 'stopped' | 'not_stopped' | 'unknown' = 'stopped';
  let abortSessionGone: boolean | undefined = true;
  // **指名しなかったときに Pool.start() が返す runnerId。** 本物は資源で選んだ
  // 器の runnerId を返す——ここでは差し替え可能な既定値でそれを真似る。
  let autoRunnerId: string | undefined = 'runner-test';
  let runnersOverview: RunnerFleetOverview = {
    runners: [],
    unassigned: [],
    daemonRevision: { status: 'unknown' },
  };
  const runnersCalls: { fingerprints?: boolean; resources?: boolean }[] = [];
  const transcripts = new Map<string, string>();
  let memoryCause: 'distill' | 'clone' = 'clone';

  const managers: ManagerPool = {
    async start(input) {
      started.push(input);
      const summary: ManagerSummary = {
        managerId: `mgr-${started.length}`,
        status: 'running',
        live: true,
        cwd: input.cwd ?? '/work',
        request: input.request,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
        // **指名があればそれを、無ければ自動配置の代わりの既定値を返す。** 本物
        // （`Pool.start`）は常に実際に走った器の runnerId を返す——指名の有無を
        // 問わない、がここで固定したい形である。
        ...((input.runnerId ?? autoRunnerId) === undefined
          ? {}
          : { runnerId: input.runnerId ?? autoRunnerId }),
      };
      running.push(summary);
      return summary;
    },
    async send(managerId, message, options = {}) {
      sent.push({ managerId, message, ...options });
      return { outcome: 'answered', detail: '回答した。' };
    },
    async list() {
      // 本物の `list()` は毎回作り直した写しを返す（`summaryOf`）。同じ物を返すと、
      // 呼び手が控えた「前の状態」が後から書き換わってしまう。
      return running.map((manager) => ({ ...manager }));
    },
    denials(managerId: string) {
      return denied.get(managerId) ?? [];
    },
    async transcript(managerId: string) {
      return transcripts.get(managerId) ?? null;
    },
    async restore() {
      return [];
    },
    // クローンの道具はこの口を呼ばない（引き取りの契機はデーモン側にある）。
    async reattachRunner() {},
    async abort(managerId: string, reason?: string) {
      aborted.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      const found = running.find((manager) => manager.managerId === managerId);
      if (!found)
        return { outcome: 'absent' as const, detail: `${managerId} というマネージャーは居ない。` };
      if (abortOutcome === 'stopped') {
        // 本物と同じところまで動かす（status を畳み、セッションを切る）。ここを
        // 動かさないと「受理した」と「効いた」の差がテストに映らない。
        found.status = 'stopped';
        found.live = false;
      }
      // `not_stopped` / `unknown` は「台帳を1文字も書かない」が本物の挙動なので、
      // ここでも `found` を触らない。
      return {
        outcome: abortOutcome,
        detail:
          abortOutcome === 'stopped'
            ? '止めた'
            : abortOutcome === 'not_stopped'
              ? 'まだ止まっていない'
              : '止まったかは未確認',
        ...(abortSessionGone === undefined ? {} : { sessionGone: abortSessionGone }),
      };
    },
    async runners(options = {}) {
      runnersCalls.push(options);
      return runnersOverview;
    },
    async stop() {},
  };

  // 実行環境プロファイルの配布先。人間の口と同じ配線を通す。
  const distributed: string[] = [];
  const runners = {
    async list() {
      return [
        {
          runnerId: 'runner-test',
          async setProfile(script: string) {
            distributed.push(script);
            return { ok: true as const };
          },
        },
      ];
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;

  const tools = createCloneTools({
    stores,
    emit: (event) => emitted.push(event),
    managers,
    // **本番と同じ1本道を通す。** ここを偽物にすると、直列化も検査も
    // テストの外に出てしまう。
    profile: createProfileService({ stores, runners }),
    ...(runtime === undefined ? {} : { runtime }),
    memoryCause: () => memoryCause,
  });

  return {
    stores,
    emitted,
    sent,
    started,
    aborted,
    distributed,
    running,
    denied,
    setMemoryCause(cause) {
      memoryCause = cause;
    },
    setAbortOutcome(outcome, sessionGone) {
      abortOutcome = outcome;
      // 省略時は outcome から自然に決まる値を補う（`stopped` ⟺ `true`、
      // `not_stopped` ⟺ `false`、`unknown` ⟺ `undefined`）。
      abortSessionGone =
        sessionGone ??
        (outcome === 'stopped' ? true : outcome === 'not_stopped' ? false : undefined);
    },
    setAutoRunnerId(runnerId) {
      autoRunnerId = runnerId;
    },
    setRunnersOverview(overview) {
      runnersOverview = overview;
    },
    setTranscript(managerId, body) {
      if (body === null) transcripts.delete(managerId);
      else transcripts.set(managerId, body);
    },
    runnersCalls,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('クローンの道具', () => {
  it('モデルから見える名前は mcp__alteroid__* である', () => {
    expect(qualifiedToolName('ask_human')).toBe('mcp__alteroid__ask_human');
    expect(CLONE_ALLOWED_TOOLS).toContain('mcp__alteroid__memory_write');
  });

  it('memory_write は記憶を更新し、日誌に memory_update を残す', async () => {
    const h = harness();

    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n速さより正しさ\n',
      summary: '価値観を書いた',
    });

    expect((await h.stores.persona.read('values'))?.content).toContain('速さより正しさ');
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ type: 'memory_update', slug: 'values', cause: 'clone' });
  });

  it('memory_write の日誌には action: "write" が構造として載る（文言だけに頼らない）', async () => {
    const h = harness();

    await h.call('memory_write', { slug: 'values', content: '本文', summary: '書いた' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ action: 'write' });
  });

  // 監査に使う機械可読な面。summary の文言（人が読む要約）とは別の保証であり、
  // 片方が通ってももう片方の歯にはならない（`AGENTS.md`「一つの変異で複数の
  // 保証を確かめない」の裏側——ここでは逆に、別々の it() で別々に測る）。
  it('memory_write の日誌には bytesBefore / bytesAfter が数として記録される', async () => {
    const h = harness();
    await h.call('memory_write', { slug: 'values', content: '12345', summary: '最初' });
    await h.call('memory_write', { slug: 'values', content: '1234567890', summary: '書き換え' });

    // 新しい順に返るので、先頭が2回目の書き込み。
    const [second, first] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(first).toMatchObject({ bytesBefore: 0, bytesAfter: 5 });
    expect(second).toMatchObject({ bytesBefore: 5, bytesAfter: 10 });
  });

  /**
   * `memory_write` / `memory_append` の応答に添える差分の要約（#318 案 (d)）。
   *
   * **なぜ要るか**: クローンが `memory_write` で全文を再生成するとき、本文が
   * ツール呼び出しの中で途中で切れても、記憶には控えも履歴も無いので突き
   * 合わせる相手が存在しない。この要約は「そもそも切れない」ようにするもの
   * ではなく、**切れたことにその場で気づけるようにする**ものである——だから
   * ここで測るのは文言の一致ではなく、**減った文字数がそのまま出るか**
   * **消えた見出しが名指しされるか**という性質のほうである。
   *
   * 単位は文字数（`content.length`）で統一する。日誌の `bytesBefore` /
   * `bytesAfter`（バイト）は別の歯（直上）が既に守っているので、ここでは
   * 混ぜない。
   */
  describe('memory_write / memory_append の応答（差分の要約、#318 案 (d)）', () => {
    it('新規作成のときは「前」が無いので、増減ではなく新規作成と分かる形で返す', async () => {
      const h = harness();

      const reply = await h.call('memory_write', {
        slug: 'new-doc',
        content: '12345',
        summary: '新規',
      });

      expect(reply).toContain('新規作成');
      expect(reply).toContain('5 文字');
      // 「前」が無いので矢印（増減の表現）は出ない。
      expect(reply).not.toContain('→');
    });

    it('書き換えでは前後の文字数と増減が文字単位で出る（Issue #318 の例と同じ桁）', async () => {
      const h = harness();
      await h.call('memory_write', { slug: 'values', content: 'a'.repeat(12345), summary: '最初' });

      const reply = await h.call('memory_write', {
        slug: 'values',
        content: 'b'.repeat(4567),
        summary: '書き換え',
      });

      // 単位は文字（バイトではない）。全角を含まない ASCII なのでバイト数と
      // 文字数は一致するが、ここで測っているのは `content.length` が使われて
      // いること（`Buffer.byteLength` への取り違えでも同じ値になってしまう
      // 入力を避けるため、次のテストでは全角を使って区別する）。
      expect(reply).toContain('12,345 → 4,567 文字（-7,778）');
    });

    it('全角文字では文字数とバイト数が一致しない。応答は文字数（バイトではない）', async () => {
      const h = harness();
      // 全角1文字は UTF-8 で3バイト。文字数なら 4、バイト数なら 12 になる。
      await h.call('memory_write', { slug: 'values', content: '', summary: '空' });

      const reply = await h.call('memory_write', {
        slug: 'values',
        content: '価値観です',
        summary: '書いた',
      });

      // 「価値観です」は5文字・15バイト。バイト数（15）ではなく文字数（5）が出る。
      expect(reply).toContain('0 → 5 文字（+5）');
      expect(reply).not.toContain('15');
    });

    it('増える書き換えは + 付きで出る', async () => {
      const h = harness();
      await h.call('memory_write', { slug: 'values', content: '12345', summary: '最初' });

      const reply = await h.call('memory_write', {
        slug: 'values',
        content: '1234567890',
        summary: '増やした',
      });

      expect(reply).toContain('5 → 10 文字（+5）');
    });

    it('消えた見出しを名指しで列挙する', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論\n\n本文\n\n## 旧仕様\n\n消える節\n\n## 現行仕様\n\n残る節\n',
        summary: '最初',
      });

      const reply = await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論\n\n本文\n\n## 現行仕様\n\n残る節\n',
        summary: '旧仕様を削除',
      });

      expect(reply).toContain('## 旧仕様');
      expect(reply).not.toContain('## 現行仕様');
    });

    it('見出しがまったく消えていないときは「なし」と分かる形で返す', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論\n\n本文\n',
        summary: '最初',
      });

      const reply = await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論\n\n書き足した本文\n',
        summary: '本文だけ変えた',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('なし');
    });

    it('見出しの抽出は行頭の # に限る。行の途中の # は見出しとして数えない', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論\n\n価格は $100 くらい # メモ\n',
        summary: '最初',
      });

      // 見出しではない行（行頭が # でない）が消えても、消えた見出しには数えない。
      const reply = await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論\n',
        summary: '本文行を削った',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('なし');
    });

    it('消えた見出しが多いときは文字数の予算で締め、切ったと分かる形で言う', async () => {
      const h = harness();
      // 600 文字の予算に対して十分多い見出しを用意する（1件あたり十数文字）。
      const headings = Array.from({ length: 80 }, (_, i) => `## 見出し番号${i}`);
      await h.call('memory_write', {
        slug: 'doc',
        content: headings.join('\n\n'),
        summary: '最初',
      });

      const reply = await h.call('memory_write', {
        slug: 'doc',
        content: '# 総論だけ残す\n',
        summary: '全部消した',
      });

      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('80 件');
      // 全件は出ていない（予算で締められている）。
      expect(reply).toContain('省略');
      expect(reply).not.toContain('## 見出し番号79');
    });

    it('memory_append の応答にも同じ要約が付く（新規作成の形）', async () => {
      const h = harness();

      const reply = await h.call('memory_append', {
        slug: 'notes',
        content: '最初の1行',
        summary: '新規',
      });

      expect(reply).toContain('新規作成');
    });

    it('memory_append は既存を消さないので、消えた見出しは常に0件のはず（0でないなら異常）', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'notes',
        content: '# 総論\n\n## 節1\n\n本文\n',
        summary: '最初',
      });

      const reply = await h.call('memory_append', {
        slug: 'notes',
        content: '## 追記した節\n\n追記した本文',
        summary: '追記',
      });

      // append は末尾に足すだけなので、既存の見出しは1つも消えない。
      expect(reply).toContain('消えた見出し');
      expect(reply).toContain('なし');
      // 元の見出しは残っている。
      expect((await h.stores.persona.read('notes'))?.content).toContain('## 節1');
    });
  });

  /**
   * `memory_list`（#170「記憶の目次化」）。要旨・鮮度・区分・階層を出す。
   * `memory_write` が frontmatter を書けること自体はストア層の歯
   * （`memory.test.ts` / `storage-fs` / `storage-pg` のテスト）で確かめてあるので、
   * ここでは「道具として呼んだときに、その情報が出力に出るか」だけを見る。
   */
  describe('memory_list（要旨・鮮度・区分・階層を出す）', () => {
    it('区分と要旨が出る', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'runbook',
        content: '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
        summary: '定点観測を書いた',
      });

      const reply = await h.call('memory_list', {});

      expect(reply).toContain('[fact] runbook');
      expect(reply).toContain('費用の推移');
    });

    it('premise（既定）の文書も一覧には出る', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'about-me',
        content: '# 私\n\n前提の本文\n',
        summary: '前提を書いた',
      });

      const reply = await h.call('memory_list', {});

      expect(reply).toContain('[premise] about-me');
    });

    it('階層は parent から組み立てて、インデントで表す', async () => {
      const h = harness();
      await h.call('memory_write', {
        slug: 'parent-doc',
        content: '---\ndescription: 親\ntype: fact\n---\n# 親\n本文\n',
        summary: '親を書いた',
      });
      await h.call('memory_write', {
        slug: 'child-doc',
        content: '---\ndescription: 子\ntype: fact\nparent: parent-doc\n---\n# 子\n本文\n',
        summary: '子を書いた',
      });

      const reply = await h.call('memory_list', {});
      const lines = reply.split('\n');
      const parentLine = lines.find((line) => line.includes('parent-doc:'));
      const childLine = lines.find((line) => line.includes('child-doc:'));
      const indent = (line: string) => line.length - line.trimStart().length;
      expect(parentLine).toBeDefined();
      expect(childLine).toBeDefined();
      expect(indent(childLine ?? '')).toBeGreaterThan(indent(parentLine ?? ''));
    });

    it('記憶が空なら「空」と言う（0 件で終わらせない）', async () => {
      const h = harness();
      expect(await h.call('memory_list', {})).toContain('空');
    });
  });

  /**
   * 実行環境プロファイル。
   *
   * **クローンにも人間と同じ手を持たせる。** 人間は自分の `~/.zshenv` を開いて
   * 直せるのだから、その写像であるクローンにできないのは能力の削除である
   * （north_star 禁止2 は層を問わず効く）。
   *
   * 固定するのは「人間が言ったことを永続化できる」ことと、「置いたものが
   * ちゃんと配られる」ことの2つ。**人間の口（`PUT /profile`）と同じ経路を通る**
   * ので、片方だけ検査が緩いという状態を作らない。
   */
  it('profile_write は保存し、runner へも降ろす', async () => {
    const h = harness();

    const result = await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=abc123',
      summary: '人間から渡されたトークンを実行環境へ移した',
    });

    expect(result).toContain('更新した');
    expect((await h.stores.profile.read())?.script).toContain('SOME_API_TOKEN');
    // **置くだけで終わらせない。** 配られていなければマネージャーには効かない。
    expect(h.distributed).toHaveLength(1);
    expect(h.distributed[0]).toContain('SOME_API_TOKEN');
  });

  it('profile_read で今の本文を取れる（足すだけの更新ができる）', async () => {
    const h = harness();
    await h.call('profile_write', { script: 'export A=1', summary: 'A' });

    const body = await h.call('profile_read', {});

    expect(body).toContain('export A=1');
  });

  it('置けなかったら判断として記録せず、理由をその場で返す', async () => {
    const h = harness();
    // 器が「読めない」と答える状況。置けなかったのはシステムの結果であって、
    // クローンの判断ではない（日誌の decision を汚さない）。
    const tools = createCloneTools({
      stores: h.stores,
      emit: () => undefined,
      profile: createProfileService({
        stores: h.stores,
        applier: {
          vessel: {} as never,
          fingerprint: () => undefined,
          env: () => ({}),
          async apply() {
            return { ok: false, error: '構文が壊れている' };
          },
          async prepare() {
            return {
              ok: false,
              error: '構文が壊れている',
              commit: async () => undefined,
              discard: async () => undefined,
            };
          },
        },
      }),
    });
    const write = tools.find((entry) => entry.name === 'profile_write');
    const result = await write?.handler({ script: 'if [ ; then', summary: 'x' } as never, {});
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(body).toContain('置けなかった');
    expect(body).toContain('構文が壊れている');
    expect(await h.stores.profile.read()).toBeNull();
    expect(await h.stores.journal.list({ types: ['decision'] })).toHaveLength(0);
  });

  it('日誌に残すのは何を変えたかであって、値ではない', async () => {
    const h = harness();

    await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=super-secret',
      summary: 'Slack の鍵を置いた',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(JSON.stringify(entry)).not.toContain('super-secret');
    expect(JSON.stringify(entry)).toContain('Slack の鍵を置いた');
  });

  // --- 継続中の依頼 --------------------------------------------------------
  // 「定期的に〜しておいて」を、思い出せるかどうかの賭けにしないための器。

  it('schedule_create は継続中の依頼として残り、schedule_list で読める', async () => {
    const h = harness();

    const created = await h.call('schedule_create', {
      kind: 'issue-round',
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      dailyAt: '09:00',
    });
    expect(created).toContain('毎日 09:00');

    const plans = await h.stores.schedules.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
    });
    expect(await h.call('schedule_list', {})).toContain('open issue');

    // 聞かずに仕込んだことは日誌に残る
    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision' });
  });

  it('schedule_list の一覧は作成時刻と更新時刻を出す', async () => {
    const h = harness();
    await h.stores.schedules.put({
      kind: 'watch',
      spec: { type: 'daily', at: '09:00' },
      request: 'いつもの見回り',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z',
    });

    const reply = await h.call('schedule_list', {});

    expect(reply).toContain('作成: 2026-01-02T03:04:05.000Z');
    expect(reply).toContain('更新: 2026-03-04T05:06:07.000Z');
  });

  it('同じ kind で仕込み直すと置き換わる（前回動いた時刻は保つ）', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });
    const first = await h.stores.schedules.get('watch');
    await h.stores.schedules.claimRun(
      'watch',
      first?.updatedAt ?? '',
      '2026-08-12T00:00:00.000Z',
      'schedule',
    );
    await h.stores.schedules.completeRun('watch', '2026-08-12T00:00:00.000Z', 'schedule');

    await h.call('schedule_create', { kind: 'watch', request: '直した依頼', everyMinutes: 10 });

    const plans = await h.stores.schedules.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      request: '直した依頼',
      spec: { type: 'every', minutes: 10 },
      lastRunAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('cron 式でも仕込める（曜日の指定が要る依頼のため）', async () => {
    const h = harness();

    const created = await h.call('schedule_create', {
      kind: 'weekly-review',
      request: '週次で先週の日報を読み直して、抜けている決めごとを拾う',
      cron: '0 10 * * 1',
    });
    expect(created).toContain('cron: 0 10 * * 1');

    expect((await h.stores.schedules.list())[0]).toMatchObject({
      spec: { type: 'cron', expression: '0 10 * * 1' },
    });
  });

  it('読めない cron 式は仕込まない', async () => {
    const h = harness();

    const result = await h.call('schedule_create', {
      kind: 'weekly-review',
      request: 'x',
      cron: 'まいしゅう げつようび',
    });

    expect(result).toContain('cron 式として読めない');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('周期の指定は1つだけ。読めない指定は仕込まない', async () => {
    const h = harness();

    expect(await h.call('schedule_create', { kind: 'a', request: 'x' })).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', {
        kind: 'a',
        request: 'x',
        dailyAt: '09:00',
        everyMinutes: 30,
      }),
    ).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', {
        kind: 'a',
        request: 'x',
        dailyAt: '09:00',
        cron: '0 10 * * 1',
      }),
    ).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', { kind: 'a', request: 'x', dailyAt: '25:00' }),
    ).toContain('読めない');
    expect(
      await h.call('schedule_create', { kind: 'ダメな名前', request: 'x', dailyAt: '09:00' }),
    ).toContain('使えない');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('既定の定期ジョブの名前は奪えない（日報を潰せない）', async () => {
    const h = harness();
    const result = await h.call('schedule_create', {
      kind: 'daily_report',
      request: '日報を潰す',
      everyMinutes: 1,
    });
    expect(result).toContain('既定の定期ジョブ');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('schedule_remove は依頼を片付ける。無い依頼なら何もしない', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '見張る', everyMinutes: 30 });

    expect(await h.call('schedule_remove', { kind: 'しらない' })).toContain('無い');
    expect(await h.stores.schedules.list()).toHaveLength(1);

    expect(await h.call('schedule_remove', { kind: 'watch' })).toContain('外した');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('memory_append は既存の記述を消さない（人間の手書きを守る）', async () => {
    const h = harness();
    await h.stores.persona.write('values', '# 価値観\n\n人間が手で書いた\n');

    await h.call('memory_append', {
      slug: 'values',
      content: '- クローンが足した学び',
      summary: '学びを追記',
    });

    const content = (await h.stores.persona.read('values'))?.content ?? '';
    expect(content).toContain('人間が手で書いた');
    expect(content).toContain('クローンが足した学び');
  });

  it('memory_append の日誌には action: "append" が構造として載る', async () => {
    const h = harness();

    await h.call('memory_append', { slug: 'values', content: '追記', summary: '追記した' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ action: 'append' });
  });

  it('memory_append の日誌には bytesBefore / bytesAfter が数として記録される', async () => {
    const h = harness();
    await h.call('memory_write', { slug: 'values', content: '12345', summary: '最初' });
    await h.call('memory_append', { slug: 'values', content: '67890', summary: '追記' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'], limit: 1 });
    // append は改行を挟んで足す（testing.ts の append 実装）ので
    // 5（前の内容）+ 1（改行）+ 5（追記）= 11。
    expect(entry).toMatchObject({ action: 'append', bytesBefore: 5, bytesAfter: 11 });
  });

  /**
   * `memory_delete` — 記憶の文書ごと消す口。
   *
   * `schedule_remove` は在るのに削除だけが欠けていた非対称を塞ぐ
   * （north_star 禁止1）。保証ごとに `it()` を割る。
   */
  describe('memory_delete（記憶の文書を消す）', () => {
    it('文書ごと消える（memory_list から消える。本文が空になるだけではない）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '# 一時的なメモ\n\n本文');

      await h.call('memory_delete', { slug: 'temp-note', summary: 'もう要らない' });

      expect(await h.stores.persona.read('temp-note')).toBeNull();
      const list = await h.stores.persona.list();
      expect(list.some((doc) => doc.slug === 'temp-note')).toBe(false);
    });

    it('存在しないスラッグは黙って成功しない', async () => {
      const h = harness();

      const reply = await h.call('memory_delete', { slug: 'nope', summary: '消したつもり' });

      expect(reply).toContain('存在しない');
      // 消したつもりで何も消えていない、を作らない — 何も変わっていないと言い切る。
      expect(reply).toMatch(/消えない|変わっていない/);
    });

    it('削除が日誌に残る（slug と消す直前の文字数）', async () => {
      const h = harness();
      const body = '# メモ\n\n' + 'あ'.repeat(42);
      await h.stores.persona.write('temp-note', body);

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ type: 'memory_update', slug: 'temp-note' });
      expect((entry as { summary: string }).summary).toContain(String(body.length));
    });

    it('削除の日誌には bytesBefore / bytesAfter が数として記録される（bytesAfter は常に0）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '12345');

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ bytesBefore: 5, bytesAfter: 0 });
    });

    it('削除の日誌に本文が写っていない', async () => {
      const h = harness();
      const secretBody = '# メモ\n\n他人に見せたくない値: SECRET-XYZ-999';
      await h.stores.persona.write('temp-note', secretBody);

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect((entry as { summary: string }).summary).not.toContain('SECRET-XYZ-999');
    });

    it('action: "remove" が構造として載る（文言だけに頼らない）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '本文');

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ action: 'remove' });
    });
  });

  /**
   * `memory_frontmatter_set` — #318 案 (a)。frontmatter（description / type /
   * parent）のうち渡したキーだけを差し替える。**本文には一切触れない。**
   *
   * ここでの中心の保証は「本文がツール呼び出しの中に一度も現れないので、
   * 本文が途中で切れることが構造的に起こりえない」こと（長い・見出しを
   * 複数持つ本文で確かめる）と、「`guardFullReplace` を迂回していない」こと
   * （human guard と同じ4条件で確かめる）である。
   */
  describe('memory_frontmatter_set（frontmatter だけを直す。本文には触れない）', () => {
    async function markHuman(h: Harness, slug: string, content: string): Promise<void> {
      await h.stores.persona.write(slug, content);
      await h.stores.persona.markHumanTouched(slug, new Date().toISOString());
    }

    const longBody = [
      '# 価値観',
      '',
      '## 判断の基準',
      '',
      '本文1行目。',
      '本文2行目。',
      '',
      '## 好み',
      '',
      '- 箇条書き1',
      '- 箇条書き2',
      '',
      '### 細目',
      '',
      '最後の段落。',
    ].join('\n');

    it('存在しない slug には断り、作られていない', async () => {
      const h = harness();

      const reply = await h.call('memory_frontmatter_set', {
        slug: 'nope',
        description: '要旨',
        summary: '直したつもり',
      });

      expect(reply).toContain('存在しない');
      expect(await h.stores.persona.read('nope')).toBeNull();
    });

    it('キーを1つも渡さなければ断る（何も変わらない）', async () => {
      const h = harness();
      const original = `---\ndescription: 元の要旨\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      const reply = await h.call('memory_frontmatter_set', { slug: 'values', summary: '直す' });

      expect(reply).toMatch(/断|少なくとも1つ/);
      expect((await h.stores.persona.read('values'))?.content).toBe(original);
    });

    it('frontmatter が無い（none）文書に足せる。本文は無傷で、type を渡さなければ区分は premise のまま', async () => {
      const h = harness();
      await h.stores.persona.write('values', longBody);

      await h.call('memory_frontmatter_set', {
        slug: 'values',
        description: '新しい要旨',
        summary: '要旨を足した',
      });

      const doc = await h.stores.persona.read('values');
      expect(doc?.content.endsWith(longBody)).toBe(true);
      expect(doc?.content).toContain('description: 新しい要旨');
      expect(doc?.kind).toBe('premise');
    });

    it('本文は1バイトも変わらない（見出しを複数持つ長い本文で確かめる）', async () => {
      const h = harness();
      const original = `---\ndescription: 古い要旨\ntype: premise\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      await h.call('memory_frontmatter_set', {
        slug: 'values',
        type: 'fact',
        summary: '区分を変えた',
      });

      const content = (await h.stores.persona.read('values'))?.content ?? '';
      const bodyAfter = content.split('\n').slice(4).join('\n'); // --- desc type --- の4行の次から
      expect(bodyAfter).toBe(longBody);
    });

    /**
     * 本文が空（frontmatter だけ）の文書（#354 のコメント）。
     *
     * **道具を通した側にも歯を1本置く。** 単体（`memory.test.ts` の
     * `applyMemoryFrontmatterPatch`）は純粋関数の戻り値しか見ないので、
     * **ストアに実際に残った文書**が測れていない。ここが見るのは
     * `persona.read()` が返す `content` そのものである。
     */
    it('本文が空（frontmatter だけ）の文書でも、閉じの --- の後ろの改行が落ちない', async () => {
      const h = harness();
      await h.stores.persona.write('values', '---\ndescription: 元の要旨\n---\n');

      await h.call('memory_frontmatter_set', {
        slug: 'values',
        type: 'fact',
        summary: '区分を付けた',
      });

      const content = (await h.stores.persona.read('values'))?.content ?? '';
      expect(content).toBe('---\ndescription: 元の要旨\ntype: fact\n---\n');
      expect(content.endsWith('---\n')).toBe(true);
    });

    it('渡さなかったキーは既存の値のまま残る', async () => {
      const h = harness();
      const original = `---\ndescription: 元の要旨\ntype: fact\nparent: root\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      await h.call('memory_frontmatter_set', {
        slug: 'values',
        description: '新しい要旨',
        summary: '要旨だけ直した',
      });

      const doc = await h.stores.persona.read('values');
      expect(doc?.description).toBe('新しい要旨');
      expect(doc?.kind).toBe('fact');
      expect(doc?.parent).toBe('root');
    });

    it('description を変えると memory_list の ⚠古い要旨 が消える（describedAt が進む）', async () => {
      // **時刻を自分で固定する。** `updatedAt` / `describedAt` は実時計
      // （`new Date().toISOString()`）から来るので、2回の write が同じ
      // ミリ秒に収まると `describedAt >= updatedAt` が偶然 true になり
      // stale を作れない（AGENTS.md「時刻を assert するテストは自分で
      // TZ を固定する」と同じ理由——ここでは TZ ではなく時刻の進みそのもの
      // を固定する）。
      vi.useFakeTimers();
      try {
        const h = harness();
        await h.stores.persona.write('values', `---\ndescription: 古い要旨\n---\n${longBody}`);
        vi.advanceTimersByTime(1000);
        // 本文だけを更新 → description は据え置かれるので stale になる。
        await h.stores.persona.write(
          'values',
          `---\ndescription: 古い要旨\n---\n${longBody}\n\n追加の1文。`,
        );
        vi.advanceTimersByTime(1000);

        const staleListing = await h.call('memory_list', {});
        expect(staleListing).toContain('⚠古い要旨');

        await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: '本文に合わせた新しい要旨',
          summary: '要旨を直した',
        });

        const freshListing = await h.call('memory_list', {});
        expect(freshListing).not.toContain('⚠古い要旨');
        expect(freshListing).toContain('本文に合わせた新しい要旨');
      } finally {
        vi.useRealTimers();
      }
    });

    it('type を変えたら、載り方が変わったことが応答に出る（premise → fact）', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ntype: premise\n---\n${longBody}`);

      const reply = await h.call('memory_frontmatter_set', {
        slug: 'values',
        type: 'fact',
        summary: '区分を下げた',
      });

      expect(reply).toContain('premise');
      expect(reply).toContain('fact');
      expect(reply).toMatch(/目次の1行|全文には載らない/);
    });

    it('type を変えなければ、区分が変わったという文言は出ない', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ntype: premise\n---\n${longBody}`);

      const reply = await h.call('memory_frontmatter_set', {
        slug: 'values',
        description: '要旨だけ',
        summary: '要旨だけ',
      });

      expect(reply).not.toContain('区分が変わった');
    });

    /**
     * ⚠️ 差し戻しで見つかった欠陥の回帰確認。
     *
     * `type` を `z.string()` のまま自由文字列で受けていたとき、綴りを
     * 間違えた値（`'Fact'` 等）がそのまま frontmatter へ書かれていた。
     * `resolveMemoryDocKind`（読み出し側）は未知の値を `premise` へ倒すので
     * 区分は実際には変わらないのに、`priorKind === nextKind` になって
     * `kindChangeNote` が空文字のまま返り、**書き手は「変えたつもり」で
     * 次のターンへ進んでいた。** ここでは (1) frontmatter が1文字も
     * 変わっていないこと (2) 断り文に使える値（premise/fact）が出ることの
     * 両方を確かめる。
     */
    it('不正な type（綴り違い等）には断り、frontmatter が1文字も変わっていない', async () => {
      const h = harness();
      const original = `---\ndescription: 旧\ntype: premise\n---\n${longBody}`;
      await h.stores.persona.write('values', original);

      const reply = await h.call('memory_frontmatter_set', {
        slug: 'values',
        type: 'Fact', // 綴り違い（正しくは小文字の 'fact'）
        summary: '区分を変えたつもり',
      });

      expect(reply).toContain('premise');
      expect(reply).toContain('fact');
      expect(reply).toMatch(/断|何も変わっていない/);
      // 断り文が出たことだけでなく、frontmatter 込みで内容が1文字も
      // 変わっていないことも確かめる（malformed の歯・human guard の歯と同じ形）。
      expect((await h.stores.persona.read('values'))?.content).toBe(original);
    });

    /**
     * ⚠️ 差し戻しで見つかった欠陥の回帰確認（injection）。
     *
     * `description` / `parent` に改行を含む値を渡すと、
     * `serializeMemoryFrontmatter` が1キー1行で並べるため、値の続きが
     * frontmatter の別のキー・閉じの `---`・本文の1行目として紛れ込んで
     * いた。本文そのものは失われない（古い content から取るだけ）が、
     * 値から本文へ文字列が「混ざる」——これは「切れない」とは別の性質
     * である。ここでは (1) 断り文が出ること (2) frontmatter も本文も
     * 1文字も変わっていないこと（malformed・不正な type と同じ形）を
     * 両方測る——断ってから書いてしまう実装が生存しないように。
     */
    describe('改行を含む値は断る（description / type / parent に文字列が混ざるのを防ぐ）', () => {
      it('description に \\n を含む値は断り、frontmatter も本文も1文字も変わっていない', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: 'a\n---\nb',
          type: 'fact',
          summary: '混ぜようとした',
        });

        expect(reply).toContain('description');
        expect(reply).toMatch(/断|何も変わっていない/);
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      it('description に単独の \\r を含む値も断る（\\r\\n だけでなく）', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: 'a\rb',
          summary: '混ぜようとした',
        });

        expect(reply).toContain('description');
        expect(reply).toMatch(/断|何も変わっていない/);
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      it('parent に改行を含む値も断る（frontmatter も本文も1文字も変わっていない）', async () => {
        const h = harness();
        const original = `---\ndescription: 旧\nparent: root\n---\n${longBody}`;
        await h.stores.persona.write('values', original);

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          parent: 'root\ndescription: hijacked',
          summary: '混ぜようとした',
        });

        expect(reply).toContain('parent');
        expect(reply).toMatch(/断|何も変わっていない/);
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      it('改行が無ければ通る（--- を含む1行の値そのものは問題ない）', async () => {
        const h = harness();
        await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: 'a---b（1行のまま）',
          summary: '1行のまま直した',
        });

        expect(reply).toContain('更新した');
        expect((await h.stores.persona.read('values'))?.description).toBe('a---b（1行のまま）');
      });
    });

    it('malformed な frontmatter には断り、何も変わっていない', async () => {
      const h = harness();
      const malformed = '---\nno colon here\n---\n本文';
      await h.stores.persona.write('values', malformed);

      const reply = await h.call('memory_frontmatter_set', {
        slug: 'values',
        description: '直したい',
        summary: '直したつもり',
      });

      expect(reply).toContain('malformed');
      expect((await h.stores.persona.read('values'))?.content).toBe(malformed);
    });

    it('差分の要約（describeMemoryWriteDiff）が応答に付き、消えた見出しは無い', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

      const reply = await h.call('memory_frontmatter_set', {
        slug: 'values',
        description: '新',
        summary: '要旨を直した',
      });

      expect(reply).toContain('消えた見出し: なし。');
    });

    it('日誌には action: "describe" が構造として載る（bytesBefore/After も数として残る）', async () => {
      const h = harness();
      await h.stores.persona.write('values', `---\ndescription: 旧\n---\n${longBody}`);

      await h.call('memory_frontmatter_set', {
        slug: 'values',
        description: '新しい要旨（長め）',
        summary: '要旨を直した',
      });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ type: 'memory_update', slug: 'values', action: 'describe' });
      const withBytes = entry as { bytesBefore: number; bytesAfter: number };
      expect(typeof withBytes.bytesBefore).toBe('number');
      expect(typeof withBytes.bytesAfter).toBe('number');
    });

    describe('human guard — guardFullReplace をそのまま通す', () => {
      it('⚠️ 蒸留の走行からは human 文書を書き換えられない。断り文だけでなく frontmatter が1文字も変わっていないことも確かめる', async () => {
        const h = harness();
        const original = `---\ndescription: 人間が書いた要旨\ntype: premise\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('distill');

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: '蒸留が書き換えたい要旨',
          summary: '直したつもり',
        });

        expect(reply).toContain('断った');
        // 断り文が出たことだけでなく、frontmatter 込みで内容が1文字も変わっていないことを確かめる
        // （断ってから書いてしまう実装が生存しないように）。
        expect((await h.stores.persona.read('values'))?.content).toBe(original);
      });

      // **`unknown`（履歴が無い）は、この口ではテストできない。** `memory_write`
      // と違い `memory_frontmatter_set` は「既に在る文書にしか使えない」ので、
      // 保護状態を問う時点で必ず一度 `persona.write()` を通っている——
      // `createMemoryStores()`（インメモリの器）はそこで必ず `contentSha256` を
      // 立てるため、書き込み済みの文書が `unknown` になる経路が無い（`unknown`
      // は「索引を失った」ことを表す状態で、fs/pg の索引破損でしか作れない。
      // `memory_delete` の human guard テストも同じ理由で `unknown` を
      // テストしていない）。`human` と `unknown` は `denialMessage` の中で
      // 同じ分岐（`guardFullReplace` の switch）を通るので、`human` 側の
      // テスト（直上）が同じコードパスを検査している。

      it('断りの応答は4要素を持つ。ただし4つ目は memory_append を勧めない（要旨を直したい人には無意味）', async () => {
        const h = harness();
        const original = `---\ndescription: 人間の要旨\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('distill');

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: '書き換えたい',
          summary: '直したつもり',
        });

        // (1) なぜ断ったか
        expect(reply).toContain('人間の書き込みの履歴が在る');
        // (2) どうすれば通るか
        expect(reply).toContain('ask_human');
        expect(reply).toContain('values');
        // (3) いま何も失われていない
        expect(reply).toMatch(/変わっていない|残っている/);
        // (4) memory_append は代わりにならないと明言する（勧めない）。
        expect(reply).toContain('memory_append');
        expect(reply).toContain('代わりにならない');
      });

      it('clone の書き込みは通る（能力を消していない）', async () => {
        const h = harness();
        const original = `---\ndescription: 人間の要旨\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('clone');

        const reply = await h.call('memory_frontmatter_set', {
          slug: 'values',
          description: '会話の中で直した要旨',
          summary: '直した',
        });

        expect(reply).toContain('更新した');
        expect((await h.stores.persona.read('values'))?.description).toBe('会話の中で直した要旨');
      });

      it('対照 — clone-only の文書には distill からも通る（検出器が非0を出せること）', async () => {
        const h = harness();
        await h.call('memory_write', { slug: 'notes', content: longBody, summary: '作成' });
        expect(await h.stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });

        h.setMemoryCause('distill');
        const reply = await h.call('memory_frontmatter_set', {
          slug: 'notes',
          description: '蒸留が付けた要旨',
          summary: '蒸留で要旨を付けた',
        });

        expect(reply).toContain('更新した');
        expect((await h.stores.persona.read('notes'))?.description).toBe('蒸留が付けた要旨');
      });

      it('トグルを off にすると断らない（能力を消していない）', async () => {
        const h = harness();
        const original = `---\ndescription: 人間の要旨\n---\n${longBody}`;
        await markHuman(h, 'values', original);
        h.setMemoryCause('distill');

        const before = process.env.ALTEROID_MEMORY_GUARD;
        process.env.ALTEROID_MEMORY_GUARD = 'off';
        try {
          const reply = await h.call('memory_frontmatter_set', {
            slug: 'values',
            description: 'off にしたので通る',
            summary: '直した',
          });
          expect(reply).toContain('更新した');
        } finally {
          if (before === undefined) delete process.env.ALTEROID_MEMORY_GUARD;
          else process.env.ALTEROID_MEMORY_GUARD = before;
        }
      });
    });
  });

  /**
   * 記憶の human guard（PR「人間が一度でも書いた記憶を、統合の走行が黙って壊せない
   * ようにする」）。
   *
   * **判定軸は「保護状態 × 書き手」であって量ではない。** ここでは書き手
   * （`memoryCause`）の軸だけを動かす——保護状態そのものの正しさ（外部編集の検出・
   * ハッシュの更新箇所）は `packages/storage-fs` / `packages/storage-pg` の
   * `FsPersonaStore` / `PgPersonaStore` のテストが持つ（実ファイル・実 DB が要る）。
   */
  describe('記憶の human guard（人間が書いた記憶を distill が壊せない）', () => {
    async function markHuman(h: Harness, slug: string, content: string): Promise<void> {
      // app.ts の PUT /memory/:slug と同じ手順を模す（write してから印を立てる）。
      await h.stores.persona.write(slug, content);
      await h.stores.persona.markHumanTouched(slug, new Date().toISOString());
    }

    it('印は降りない — 人間が書いた後にクローンが何度書いても human のまま', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
      expect(await h.stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });

      h.setMemoryCause('clone');
      await h.call('memory_write', {
        slug: 'values',
        content: '# 価値観\n\nクローンが書いた1',
        summary: '1',
      });
      await h.call('memory_write', {
        slug: 'values',
        content: '# 価値観\n\nクローンが書いた2',
        summary: '2',
      });
      await h.call('memory_write', {
        slug: 'values',
        content: '# 価値観\n\nクローンが書いた3',
        summary: '3',
      });

      expect(await h.stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('unknown は守る側 — 履歴が無い文書に対して distill の memory_write が断られる', async () => {
      const h = harness();
      h.setMemoryCause('distill');

      const reply = await h.call('memory_write', {
        slug: 'fresh-doc',
        content: '# 新規\n\n本文',
        summary: '新規に書く',
      });

      expect(reply).toContain('断った');
      expect(await h.stores.persona.read('fresh-doc')).toBeNull();
    });

    /**
     * 断りの応答は「保護されています」だけで終わらせない。**次の手が書かれて
     * いること**を測る（文言の完全一致ではなく、要素の有無で測る）。
     */
    describe('断りの応答が次の手を示す', () => {
      it('unknown を理由に断るときは、その理由（履歴が確認できない）を言う', async () => {
        const h = harness();
        h.setMemoryCause('distill');

        const reply = await h.call('memory_write', {
          slug: 'fresh-doc',
          content: '# 新規\n\n本文',
          summary: '新規に書く',
        });

        // (1) なぜ断ったか — human と unknown を畳まない。unknown 側の理由が出る。
        expect(reply).toContain('unknown');
        expect(reply).not.toContain('human）');
        // (2) どうすれば通るか — ask_human に何を積めばよいかまで書いてある。
        expect(reply).toContain('ask_human');
        expect(reply).toContain('fresh-doc');
        // (3) いま何も失われていない。
        expect(reply).toMatch(/変わっていない|残っている/);
        // (4) memory_append は断られないことも書いてある。
        expect(reply).toContain('memory_append');
      });

      it('human を理由に断るときは、その理由（人間の書き込みの履歴が在る）を言う', async () => {
        const h = harness();
        await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_write', {
          slug: 'values',
          content: '# 価値観\n\ndistill が上書き',
          summary: '畳んだ',
        });

        // (1) unknown 側の理由文とは違う、human 側の理由が出る（畳んでいない）。
        expect(reply).toContain('人間の書き込みの履歴が在る');
        expect(reply).not.toContain('履歴が確認できない');
        // (2) どうすれば通るか。
        expect(reply).toContain('ask_human');
        expect(reply).toContain('values');
        // (3) いま何も失われていない。実際に本文がそのまま残っていることも確かめる。
        expect(reply).toMatch(/変わっていない|残っている/);
        expect((await h.stores.persona.read('values'))?.content).toContain('人間が書いた');
        // (4) memory_append は断られない。
        expect(reply).toContain('memory_append');
      });

      it('memory_delete の断りにも同じ4要素が出る', async () => {
        const h = harness();
        await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
        h.setMemoryCause('distill');

        const reply = await h.call('memory_delete', { slug: 'values', summary: '整理' });

        expect(reply).toContain('人間の書き込みの履歴が在る');
        expect(reply).toContain('ask_human');
        expect(reply).toMatch(/変わっていない|残っている/);
        expect(reply).toContain('memory_append');
      });
    });

    it('clone の書き込みは通る — 同じ文書に cause: clone で書けば通る（能力を消していない）', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');

      h.setMemoryCause('clone');
      const reply = await h.call('memory_write', {
        slug: 'values',
        content: '# 価値観\n\n会話の中で書き換えた',
        summary: '書き換え',
      });

      expect(reply).toContain('更新した');
      expect((await h.stores.persona.read('values'))?.content).toContain('会話の中で書き換えた');
    });

    it('memory_append は断られない（human 対象・distill でも）', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');

      h.setMemoryCause('distill');
      const reply = await h.call('memory_append', {
        slug: 'values',
        content: '- 追記',
        summary: '追記した',
      });

      expect(reply).toContain('追記した');
      expect((await h.stores.persona.read('values'))?.content).toContain('追記');
    });

    it('distill の memory_delete も human 対象なら断られる', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');

      h.setMemoryCause('distill');
      const reply = await h.call('memory_delete', { slug: 'values', summary: '整理' });

      expect(reply).toContain('断った');
      expect(await h.stores.persona.read('values')).not.toBeNull();
    });

    it('clone-only の文書には distill の全文置換・削除が通る（対照 — 検出器が非0を出せること）', async () => {
      const h = harness();
      // クローンが書いた文書（human 印なし）は clone-only になる。
      await h.call('memory_write', {
        slug: 'notes',
        content: '# ノート\n\n最初の版',
        summary: '1',
      });
      expect(await h.stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });

      h.setMemoryCause('distill');
      const reply = await h.call('memory_write', {
        slug: 'notes',
        content: '# ノート\n\n畳んだ版',
        summary: '畳んだ',
      });

      expect(reply).toContain('更新した');
      expect((await h.stores.persona.read('notes'))?.content).toContain('畳んだ版');
    });

    it('トグルを off にすると断らない（能力を消していない）', async () => {
      const h = harness();
      await markHuman(h, 'values', '# 価値観\n\n人間が書いた\n');
      h.setMemoryCause('distill');

      const before = process.env.ALTEROID_MEMORY_GUARD;
      process.env.ALTEROID_MEMORY_GUARD = 'off';
      try {
        const reply = await h.call('memory_write', {
          slug: 'values',
          content: '# 価値観\n\ndistill が上書き',
          summary: '畳んだ',
        });
        expect(reply).toContain('更新した');
      } finally {
        if (before === undefined) delete process.env.ALTEROID_MEMORY_GUARD;
        else process.env.ALTEROID_MEMORY_GUARD = before;
      }
    });
  });

  it('journal_write は判断を日誌に残す（聞かずに実行した判断の記録）', async () => {
    const h = harness();

    await h.call('journal_write', {
      decision: '人間に聞かずに設定を変えた',
      grounds: 'about-me.md に「設定変更は任せる」とある',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision', grounds: expect.stringContaining('about-me') });
  });

  it('ask_human は承認待ちに積み、日誌に残し、chat へ通知する（応答は待たない）', async () => {
    const h = harness();

    const reply = await h.call('ask_human', { question: 'これを送ってよいか' });

    const pending = await h.stores.jobs.listApprovals({ pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toBe('これを送ってよいか');

    const [escalation] = await h.stores.journal.list({ types: ['escalation'] });
    expect(escalation).toMatchObject({ type: 'escalation', question: 'これを送ってよいか' });

    expect(h.emitted).toEqual([
      { type: 'ask_human', approvalId: pending[0]?.id, question: 'これを送ってよいか' },
    ]);
    // 積むだけ。ここでブロックしない（止まるのはその仕事だけ）
    expect(reply).toContain('承認待ちキューに積んだ');
  });

  it('ask_human は manager_id を添えれば、どの仕事が止まっているか辿れる', async () => {
    const h = harness();

    await h.call('ask_human', { question: '本番に出してよいか', managerId: 'mgr-1' });

    const [pending] = await h.stores.jobs.listApprovals({ pendingOnly: true });
    expect(pending?.jobId).toBe('mgr-1');
  });

  it('approvals_list で、人間の回答待ちを自分で見られる（溜まった保留の運用）', async () => {
    const h = harness();
    expect(await h.call('approvals_list', {})).toContain('回答待ちは無い');

    await h.call('ask_human', {
      question: '本番に出してよいか',
      managerId: 'mgr-1',
      requestId: 'req-9',
    });
    await h.stores.jobs.putApproval({
      id: 'ap-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '済んだ質問',
      answeredAt: '2026-01-01T01:00:00.000Z',
      answer: 'よい',
    });

    const reply = await h.call('approvals_list', {});
    expect(reply).toContain('本番に出してよいか');
    expect(reply).toContain('req-9');
    // 回答済みは並べない（片付ける先がここだから）
    expect(reply).not.toContain('済んだ質問');
  });

  it('daily_report_write は指定された日付で日報を残す', async () => {
    const h = harness();

    await h.call('daily_report_write', { date: '2026-08-11', body: '# 日報\n\n直した' });

    const [entry] = await h.stores.journal.list({ types: ['daily_report'] });
    expect(entry).toMatchObject({ type: 'daily_report', date: '2026-08-11' });
  });

  it('日付が無い・壊れている・存在しない日なら今日として残す（読めない日報を作らない）', async () => {
    const h = harness();
    const today = new Date();
    const expected = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;

    await h.call('daily_report_write', { body: '本文' });
    await h.call('daily_report_write', { date: 'きのう', body: '本文' });
    // 形は合っているが存在しない日。ここを通すと書いた日と読める日がずれる
    await h.call('daily_report_write', { date: '2026-02-31', body: '本文' });

    const entries = (await h.stores.journal.list({ types: ['daily_report'] })) as {
      date: string;
    }[];
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(entry.date).toBe(expected);
  });

  // --- 自分自身 -------------------------------------------------------------

  it('self_read は正典を全文返す（クローンが自分の要件を読める）', async () => {
    const h = harness();

    const body = await h.call('self_read', { document: 'north_star' });

    expect(body).toContain('docs/north_star.md');
    expect(body).toContain('デグレード禁止');
    expect(body).toContain('追加制限禁止');
  });

  it('self_read は無い名前に、読める名前を添えて答える（黙って空を返さない）', async () => {
    const h = harness();

    const body = await h.call('self_read', { document: 'agents' });

    expect(body).toContain('north_star');
    expect(body).toContain('roadmap');
  });

  /**
   * 委譲できない内部ターン（蒸留）でも、自分が何者かは読めること。
   * ここが `managers` の有無に引きずられると、記憶へ移す判断だけが
   * 自己認識なしで行われる。
   */
  it('self_read は委譲できない場面でも使える', async () => {
    const tools = createCloneTools({ stores: createMemoryStores(), emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'self_read');

    const result = await found?.handler({ document: 'roadmap' } as never, {});
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(body).toContain('docs/roadmap.md');
  });

  it('manager_start は起こして即返り、委譲の判断が日誌に残る', async () => {
    const h = harness();

    const reply = await h.call('manager_start', {
      request: 'ログイン周りを直して',
      cwd: '/work/x',
    });

    expect(h.started).toEqual([{ request: 'ログイン周りを直して', cwd: '/work/x' }]);
    expect(reply).toContain('mgr-1');

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ decision: expect.stringContaining('mgr-1') });
  });

  /**
   * 置き先の指名（`runnerId`）。**これは配置の指名であって本数の制限ではない**
   * ——ここで固定したいのは、道具からプールへ指名がそのまま渡ることと、
   * 実際に走った器（`started.runnerId`）が指名の有無を問わず返り値へ載ること。
   * 指名そのものの成否判定（名簿に無い・使えない・重複）は `Registry#select`
   * の責務であって、ここでは配線だけを見る（`runner-select.test.ts` が本体）。
   */
  it('manager_start に runnerId を渡すと、そのまま ManagerPool.start へ指名として届く', async () => {
    const h = harness();

    const reply = await h.call('manager_start', {
      request: 'この器で頼む',
      runnerId: 'runner-b',
    });

    expect(h.started).toEqual([{ request: 'この器で頼む', runnerId: 'runner-b' }]);
    // **指名した名前がそのまま返る。** 指名が効いたかをクローンが確かめる材料。
    expect(reply).toContain('runner-b');
  });

  it('manager_start は runnerId を指名しなくても、実際に走った runner を返す', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-auto-placed');

    const reply = await h.call('manager_start', { request: '自動配置に任せる' });

    expect(reply).toContain('runner-auto-placed');
  });

  it('runnerId が取れないときは空欄にせず「未記録」と言う', async () => {
    const h = harness();
    h.setAutoRunnerId(undefined);

    const reply = await h.call('manager_start', { request: '記録が無い場合' });

    expect(reply).toContain('未記録');
  });

  it('manager_send は decision と requestId を添えて、宛先を指して答えられる', async () => {
    const h = harness();

    await h.call('manager_send', {
      managerId: 'mgr-1',
      message: 'よい',
      decision: 'allow',
      requestId: 'req-9',
    });

    expect(h.sent).toEqual([
      { managerId: 'mgr-1', message: 'よい', decision: 'allow', requestId: 'req-9' },
    ]);
  });

  /**
   * **人間に出来てクローンに出来ないことを作らない**（north_star 禁止1）。
   *
   * 停止は Web UI（`DELETE /managers/:id`）にも CLI にもあるのに、クローンの道具
   * だけに無かった。暴走したマネージャーも、報告を出したのに終わらないマネージャーも、
   * クローンからは**無応答のまま放置するしか手が無かった**（実際にそうなった）。
   *
   * 通す口は人間と同じ `ManagerPool.abort` である。クローン専用の停止を別に作ると、
   * 人間とクローンで見えている状態が食い違う。
   */
  it('manager_stop は人間と同じ口で止め、止まったことを確かめてから返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '暴走した' });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '暴走した' }]);
    // **「受理した」で終わらせない。** 止めたあとの実際の状態を読み直して返す。
    expect(reply).toContain('mgr-1');
    // **2026-08-21 に反転。** 直す前は `sessionGone === true`（止まったと確かめた）
    // でも台帳の `status` を `'done'`（＝終えて待機中）に書いていた（R2）。いまは
    // `'stopped'` という専用の終端状態を持つので、ここを反転する（PR「『止めた』を、
    // 止まったと確かめたときだけそう言う」の3点セット）。
    expect(reply).toContain('stopped');
  });

  it('manager_stop は not_stopped のとき「止めた」と言わない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setAbortOutcome('not_stopped');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '暴走した' });

    expect(reply).toContain('止まっていない');
    // 台帳は書いていないので、まだ running のまま見える。
    expect(reply).toContain('running');
  });

  it('manager_stop は unknown のとき「止めた」とも「止まっていない」とも言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setAbortOutcome('unknown');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '暴走した' });

    expect(reply).toContain('未確認');
  });

  it('manager_stop は absent のとき居ないと言う', async () => {
    const h = harness();

    const reply = await h.call('manager_stop', { managerId: 'mgr-nope' });

    expect(reply).toContain('居ない');
  });

  it('manager_list は状態と返事待ちを返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('running');
  });

  it('manager_list は返事待ちの種別と時刻を出す（kind/askedAt が揃っているとき）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.waiting = [
      {
        requestId: 'req-1',
        summary: 'これでよいか',
        kind: 'question',
        askedAt: '2026-08-20T00:00:00.000Z',
      },
    ];

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('質問');
    expect(reply).toContain('2026-08-20T00:00:00.000Z から');
    expect(reply).not.toContain('実行許可');
  });

  /**
   * **#334 が作りかけていた退行**（旧 runner とのバージョンのずれの窓では
   * `kind`/`askedAt` が届かない）に対する歯。`packages/core/src/runner-protocol.ts`
   * の `runnerWaitingSchema` は `kind`/`askedAt` を `.optional()` にしてある
   * ので、ここでは欠けた形をそのまま `ManagerSummary.waiting` へ渡せる
   * （`RunnerHttpClient.list()` 側の歯は `apps/daemon/src/runner-client.test.ts`）。
   *
   * **`manager_list`（`tools.ts`）は表示側で `kind`/`askedAt` を組み立て直す
   * 唯一の場所である** — `apps/web`（`manager-detail.tsx`）と `apps/cli`
   * （`chat.ts`）は既にこの形に対応済みで、対応していなかったのがここだった。
   * `item.kind === 'question' ? '質問' : '実行許可'` のままだと、`kind` が
   * 無いときに問答無用で「実行許可」と嘘をつく。
   */
  it('manager_list は kind/askedAt が無くても「実行許可」と決めつけない（#334 の追加コメント）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.waiting = [
      {
        requestId: 'req-legacy',
        summary: 'これでよいか',
        // **`kind` も `askedAt` も無い** — 版のずれの窓（旧 runner の応答）。
      },
    ];

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('req-legacy');
    // 種別が読めないまま「実行許可」と決めつけない。
    expect(reply).not.toContain('実行許可');
    expect(reply).toContain('種別不明');
    // 時刻が取れないのに `undefined` を出さない、` から` という空の断片も残さない。
    expect(reply).not.toContain('undefined');
    expect(reply).not.toMatch(/,\s*から/);
  });

  it('manager_list は runnerId を出す（未記録なら空欄にせずそう言う）', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-shown');
    await h.call('manager_start', { request: 'A' });
    h.setAutoRunnerId(undefined);
    await h.call('manager_start', { request: 'B' });

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('runner-shown');
    expect(reply).toContain('未記録');
  });

  it('manager_list は作成時刻と更新時刻を出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.startedAt = '2026-01-02T03:04:05.000Z';
    target.updatedAt = '2026-03-04T05:06:07.000Z';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('作成: 2026-01-02T03:04:05.000Z');
    expect(reply).toContain('更新: 2026-03-04T05:06:07.000Z');
  });

  it('委譲先が無い場面（蒸留の内部ターン）は、黙らずにそう返す', async () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({ stores, emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'manager_start');
    const result = await found?.handler({ request: 'x' } as never, {});

    expect(JSON.stringify(result)).toContain('委譲できない');
  });
});

/**
 * `runner_list`——「コンテナがいくつあって、どこで何をいくつ動かしているかを
 * クローンが把握できるようにする」の「見る」側。
 *
 * `ManagerPool.runners()` 自体の数え方（本数・unassigned への分離）の固定は
 * `manager.test.ts` に置く。ここで固定したいのは、その結果をクローンへ返す
 * **文言**の側——5値を畳んでいないか、既定で指紋を出していないか、1台のときに
 * 「分散していない」と読める1行があるか、である。
 */
describe('runner_list（器の一覧）', () => {
  it('登録が0台のときも「0台である」と言う（空の出力にしない）', async () => {
    const h = harness();
    h.setRunnersOverview({ runners: [], unassigned: [], daemonRevision: { status: 'unknown' } });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('0台');
  });

  /**
   * **デーモン自身の版は、runner が0台でも出す。**
   *
   * 0台は「まだ配線されていない」状態、つまり**版を確かめたい状態そのもの**である。
   * 早期 return の分岐に版を載せ忘れると、そこでだけ答えが消える——次のテスト
   * （1台以上）が通るので、落ちる場所がここにしか無い。
   */
  it('runner が0台でも、デーモン自身の版は出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [],
      unassigned: [],
      daemonRevision: {
        status: 'known',
        commit: 'e'.repeat(40),
        short: 'e'.repeat(12),
        source: 'build',
      },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('0台');
    expect(reply).toContain('e'.repeat(40));
  });

  /**
   * **デーモンと runner の版が同じ出力に並ぶ。**
   *
   * 別々の口に出すと突き合わせ忘れがそのまま見逃しになる
   * （`RunnerFleetOverview.daemonRevision` の doc）。2つの Service は別々に
   * デプロイされるので、ずれている窓が実際に在る。
   */
  it('デーモンの版と runner の版を、同じ出力に並べて出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: {
        status: 'known',
        commit: 'b'.repeat(40),
        short: 'b'.repeat(12),
        source: 'build',
      },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('a'.repeat(40));
    expect(reply).toContain('b'.repeat(40));
  });

  /**
   * **`unknown` と `unheard` を畳まない。** 疑う先が違う（前者は器の設定、後者は
   * 登録とネットワーク）ので、同じ言葉で出すとクローンは次の手を取り違える。
   */
  it('版の「不明」と「未確認」を、別の言葉で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-knows-nothing',
          revision: { status: 'unknown' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-knows-nothing',
          managers: [],
        },
        {
          label: 'runner-silent',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('不明');
    expect(reply).toContain('未確認');
  });

  it('器が1台のときは「分散していない」と読める1行が入る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-only',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-only',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('1台のみ');
    expect(reply).toContain('分散していない');
  });

  it('器が複数台のときも形が崩れない（分散していないとは言わない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [{ managerId: 'mgr-1', status: 'running' }],
        },
        {
          label: 'runner-b',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-b',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('runner-a');
    expect(reply).toContain('runner-b');
    expect(reply).not.toContain('分散していない');
  });

  it('state の5値をそのまま出す（connected へ畳まない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'a',
          revision: { status: 'unheard' },
          state: 'connecting',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'b',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'c',
          revision: { status: 'unheard' },
          state: 'unusable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'd',
          revision: { status: 'unheard' },
          state: 'lost',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-d',
          managers: [],
        },
        {
          label: 'e',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-e',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    for (const state of ['connecting', 'unreachable', 'unusable', 'lost', 'connected']) {
      expect(reply).toContain(`[${state}]`);
    }
  });

  it('器ごとのマネージャー本数を出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [
            { managerId: 'mgr-1', status: 'running' },
            { managerId: 'mgr-2', status: 'done' },
          ],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('mgr-1');
    expect(reply).toContain('mgr-2');
    expect(reply).toContain('(2)');
  });

  it('runnerId の無いマネージャーを、どの器にも混ぜず別枠で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [{ managerId: 'mgr-legacy', status: 'done' }],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    // **runner-a の内訳（マネージャー: 無し）に紛れ込んでいない。**
    expect(reply).toContain('どの器か分からない');
    expect(reply).toContain('mgr-legacy');
  });

  /**
   * 指紋（鍵・プロファイルの sha256）は**既定で出さない**。
   *
   * この歯は「出ない」ことの歯なので、まず検出器が非0を出せることを示す
   * （変異試験の要求：意図的に出す実装にしたら落ちる形になっていること）。
   * その確認は、次の「引数を渡せば指紋が出る」テストが兼ねる——同じ
   * `setRunnersOverview` の入力に対して、引数の有無だけで出力が変わることを
   * 2本のテストの対で示す。
   */
  it('引数を渡さなければ指紋を出さない（既定で文脈へ載せない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: [
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          profile: { sha256: 'cafef00dbabe', bytes: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('deadbeef0000');
    expect(reply).not.toContain('cafef00dbabe');
    // **道具からプールへは何も渡らない**（既定）。
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('fingerprints: true を渡すと指紋が出る（方針は設定で開けられる）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: [
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          profile: { sha256: 'cafef00dbabe', bytes: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('deadbeef0000');
    expect(reply).toContain('cafef00dbabe');
    expect(h.runnersCalls).toEqual([{ fingerprints: true }]);
  });

  /**
   * pids（#315 案1）。**既定では `resources: true` を渡さない。**
   *
   * `ManagerPool.runners()` へ渡す引数がそのまま「呼ぶかどうか」を決める
   * （`resourcesCalls` を直接数える歯は `manager.test.ts` 側に在る——ここで見るのは
   * 道具の側が黙って `resources: true` へ倒していないかである）。データ側に
   * `pids` が在っても、既定の呼び出しでは出てこないことも併せて確かめる
   * （fingerprints の「引数を渡さなければ指紋を出さない」と対になる歯）。
   */
  it('resources を渡さなければ既定では pids を出さない（往復を足さない側に倒す）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('872');
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('resources: true を渡すと、読めた器の pids（現在値/上限）が出る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('872');
    expect(reply).toContain('1000');
    expect(h.runnersCalls).toEqual([{ resources: true }]);
  });

  /**
   * **「言えないこと」は器ごとに繰り返さず、末尾に1度だけ出す。**
   *
   * 器の台数ぶん同じ断りを並べると、断りの長さが本体を上回って**読み飛ばされる
   * 側に倒れる**。かといって出さなければ、読む側は数字を「言える」と思い込む
   * （`.github/workflows/ci.yml` の「言えないことを書いていない計器は、読む側が
   * 言えると思い込む」）。**1度だけ出す**が、その両方を満たす形である。
   *
   * 器を3台にしてあるのは、**1台だと「繰り返していない」が測れない**ため
   * （1回しか出ないのが正しいのか、たまたま1台だからなのかを区別できない）。
   */
  it('pids の「言えないこと」は、器が何台でも末尾に1度だけ出る', async () => {
    const h = harness();
    const runner = (label: string, current: number) => ({
      label,
      revision: { status: 'unheard' } as const,
      state: 'connected' as const,
      since: '2026-01-01T00:00:00.000Z',
      runnerId: label,
      managers: [],
      resources: { pids: { current, max: 1000 } },
    });
    h.setRunnersOverview({
      runners: [runner('runner-a', 872), runner('runner-b', 120), runner('runner-c', 4)],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    // 3台ぶんの数字はそれぞれ出る（断りを1度にしたせいで数字まで減っていない）。
    expect(reply).toContain('872');
    expect(reply).toContain('120');
    expect(reply).toContain('4');
    // 断りは1度だけ。**「出る」ではなく「1度だけ出る」を数える。**
    expect(reply.split('器の合計であって内訳ではない')).toHaveLength(2);
  });

  /** 出さないと決めたときは、断りも出ない（既定の出力を断りで汚さない）。 */
  it('resources を渡さなければ、pids の「言えないこと」も出ない', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          resources: { pids: { current: 872, max: 1000 } },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('器の合計であって内訳ではない');
  });

  /**
   * **3つの状態を混ぜない。** 「読めた」は上のテストが押さえている。ここは
   * 残り2つ——「runner に訊けなかった」（`resources` 自体が `undefined`）と
   * 「訊けたが pids が読めなかった」（`resources` は在るが `pids` が無い）が
   * **別の文言**で出て、しかもどちらも「読めた」（`current`/`max` の数字）を
   * 出さないことを確かめる。0 や `unknown` へ潰していないかの歯である。
   */
  it('runner に訊けなかった器と、訊けたが pids が読めない器を、別の文言で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          // `resources` を持たない = 訊けなかった（器が開いていない・応答が無い）。
          label: 'runner-unreachable',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          // `resources` は在るが `pids` が無い = 訊けたが読めない（cgroup が無い器）。
          label: 'runner-no-cgroup',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-no-cgroup',
          managers: [],
          resources: {},
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { resources: true });

    expect(reply).toContain('runner に訊けなかった');
    expect(reply).toContain('読めない器だった');
    // **2つの文言が同じでないこと自体を確かめる**（潰れていないことの直接の歯）。
    expect(reply).not.toContain('undefined');
    expect(reply).not.toContain('pids: 0');
    expect(reply).not.toContain('pids: unknown');
  });
});

/**
 * 一覧は**件数が増えても読める**こと。
 *
 * 人間は Web UI でマネージャー一覧を見られる。クローンだけが件数の増加で
 * 見られなくなるなら、それは能力の削除（north_star 禁止1）である。しかも
 * MCP の出力上限を超えた応答はクローンに1文字も届かない（SDK がファイルへ
 * 落として「上限超過」だけを返す）ので、**溢れさせた時点で全滅**する。
 * 抜粋に留め、省いたことを明示し、全文は別の口で取れるようにする。
 */
describe('manager_list は件数が増えても壊れない', () => {
  async function crowded(count: number): Promise<Harness> {
    const h = harness();
    for (let index = 0; index < count; index += 1) {
      await h.call('manager_start', { request: `依頼${index}: ${'あ'.repeat(1500)}` });
    }
    for (const summary of h.running) summary.lastReport = `報告: ${'ほ'.repeat(3000)}`;
    return h;
  }

  it('マネージャーが増えても既定の出力は上限内に収まる', async () => {
    const few = await crowded(3);
    const many = await crowded(120);

    const small = await few.call('manager_list', {});
    const big = await many.call('manager_list', {});

    // 実測で溢れたのは 52,997 文字。件数に比例して伸びる作りだと、
    // 何件で壊れるかが運任せになる。
    expect(big.length).toBeLessThan(12_000);
    expect(small.length).toBeLessThan(12_000);
  });

  it('切ったことを黙らない（何文字省いたか・全部で何件かが出力に出る）', async () => {
    const h = await crowded(120);

    const reply = await h.call('manager_list', {});

    // 本文の抜粋には「省略した分量」が付く
    expect(reply).toMatch(/省略/);
    expect(reply).toMatch(/全\s*\d[\d,]*\s*文字/);
    // 一覧そのものを切ったなら、全体の件数が分かる
    expect(reply).toContain('120');
    // 全文への行き先が書いてある
    expect(reply).toContain('manager_report');
  });

  it('manager_report は報告の全文を返し、長ければ続きの取り方を示す', async () => {
    const h = await crowded(2);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('報告: ほ');
    // 全文が一度に返らないなら、どこで切れていて続きをどう取るかを必ず言う
    if (!reply.includes('ほ'.repeat(3000))) {
      expect(reply).toMatch(/省略|続き/);
      expect(reply).toMatch(/offset/);
    }
  });

  it('居ないマネージャーを聞かれたら黙らずにそう返す', async () => {
    const h = await crowded(1);

    const reply = await h.call('manager_report', { managerId: 'mgr-999' });

    expect(reply).toContain('mgr-999');
  });
});

/**
 * `manager_transcript` — 可観測性の最下段（セッションそのものの生ログ）。
 *
 * **`manager_report` に `part: 'transcript'` を足す形にしなかった理由**は
 * 実装側のコメントに書いた（`null` の意味が違う・大きさの桁が違う・契約が
 * 2つになる）。ここではその実物を保証ごとに1本ずつ確かめる。
 */
describe('manager_transcript（生ログへ降りる）', () => {
  it('生ログの全文へ降りられる（lastReport の抜粋ではなく transcript() の中身が返る）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    for (const summary of h.running)
      summary.lastReport = '要約された最終報告（これは生ログではない）';
    h.setTranscript('mgr-1', '{"type":"user","text":"生ログにしか無い中身"}');

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toContain('生ログにしか無い中身');
    expect(reply).not.toContain('要約された最終報告');
  });

  it('切ったことが呼び手に届く', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = 'x'.repeat(9_000);
    h.setTranscript('mgr-1', body);
    // **`lastReport` にも同じ内容を置いておく。** この保証（切ったら黙らない）は
    // 「本文がどこから来たか」（それは別の歯が守る）とは独立に測りたいので、
    // 本文の出所を差し替える変異が紛れ込んでも実害が出ないようにしてある。
    for (const summary of h.running) summary.lastReport = body;

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toMatch(/省略|文字目/);
    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
  });

  it('offset で続きが取れる', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    // **`offset` の指定は 8,000（`TRANSCRIPT_PAGE`）を直接使う。** 前の応答の
    // 「続きの取り方」の文言から offset を抜き出す形にすると、この保証が
    // tail の文言（テスト2が守る対象）に依存してしまい、2つの歯が分離しなく
    // なる（tail を黙らせる変異が offset のテストまで巻き込んで倒す）。
    const body = `${'a'.repeat(8_000)}TAIL-MARK`;
    h.setTranscript('mgr-1', body);
    // 同じ理由で lastReport にも同じ内容を置く（上のテストのコメント参照）。
    for (const summary of h.running) summary.lastReport = body;

    const first = await h.call('manager_transcript', { managerId: 'mgr-1' });
    expect(first).not.toContain('TAIL-MARK');

    const second = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      offset: 8_000,
    });
    expect(second).toContain('TAIL-MARK');
  });

  it('3段のどこにも無いとき「無い」と言う（黙って空を返さない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    // setTranscript しない＝走行中の runner・退避済みアーカイブ・預かった
    // セッションの生ログ、3段のどこにも無い状態を模す。

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toContain('無い');
    expect(reply).toMatch(/runner/);
    expect(reply).toMatch(/アーカイブ/);
  });

  it('manager_report の出力から生ログへの降り方が読める', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    for (const summary of h.running) summary.lastReport = '短い報告';

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('manager_transcript');
  });
});

/**
 * 状態の表示が、**観測していないことまで語らない**こと。
 *
 * ここで固定しているのは「何を言うか」ではなく「**何を言わないか**」である。
 * デーモンが観測できるのは限られている（セッションへ戻れたか / 拒否があったか /
 * マネージャーのターンが終わったか）のに、文言はその先まで — 仕事が失われた、
 * 走っている、走っている手は無い — と断定していた。断定は静かに間違う。
 */
describe('一覧の文言は、観測した分しか言わない', () => {
  /**
   * **実際に起きた誤りをそのまま置いてある。**
   *
   * 2026-08-16T03:15 に落ちたマネージャーは、その直前に PR #59 を出し、CI を
   * 通し、マージまで届いていた。1分半後に器が作り直されて `lost` になり、
   * 一覧は「この仕事は途中で失われている（完了ではない）」と言った。
   * デーモンは PR を見ていないのだから、これは観測ではなく推測だった。
   */
  it('lost に「完了ではない」と書かない（成果の有無は観測していない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'PR を出して' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'lost';
    target.live = false;

    const reply = await h.call('manager_list', {});

    // 断定へ戻したら、ここで落ちる。
    expect(reply).not.toContain('途中で失われている');
    expect(reply).not.toContain('完了ではない');
    // 観測した分（戻れなかった）は言い切る。
    expect(reply).toContain('戻れなかった');
    // **次の一手を渡す。** 「断定をやめる」だけだと、読んだ側は結局
    // 起こし直すか放置するかを勘で決めることになる。
    expect(reply).toMatch(/リモート|PR/);
    expect(reply).toContain('確かめ');
  });

  /**
   * **PR #42 の分け方は保つ。** 断定を外したせいで `lost` が `done`（終えて
   * 待っている）と同じ顔になったら、失われた仕事が黙って片付く方の欠陥へ戻る。
   */
  it('lost は done と混ざらない（起こし直す対象として見分けられる）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.call('manager_start', { request: 'B' });
    const [lost, done] = h.running;
    if (!lost || !done) throw new Error('準備に失敗');
    lost.status = 'lost';
    lost.live = false;
    done.status = 'done';

    const reply = await h.call('manager_list', {});
    const lostEntry = reply.slice(reply.indexOf('mgr-1'), reply.indexOf('mgr-2'));
    const doneEntry = reply.slice(reply.indexOf('mgr-2'));

    expect(lostEntry).toContain('⚠');
    expect(lostEntry).toContain('manager_start');
    // done 側には「起こし直せ」の案内が付かない（話しかければ続く）。
    expect(doneEntry).not.toContain('⚠');
  });

  /**
   * **`running` は「動いている」ではない。**
   *
   * 分類器か deny 規則がその場で拒否すると、その仕事は `running` のまま手が
   * 止まる。それが日誌と（繰り返したときだけ）受信箱にしか出ておらず、一覧を
   * 見ているクローンには「走っている」としか読めなかった。
   */
  it('拒否で手が止まっていることが、状態に添えて一覧に出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [
      { tool: 'Bash', count: 4 },
      { tool: 'Write', count: 1 },
    ]);

    const reply = await h.call('manager_list', {});

    // 状態の値そのものは動かさない（`openapi.json` の外向きの面を触らない）。
    expect(reply).toContain('[running]');
    expect(reply).toContain('Bash 4件');
    expect(reply).toContain('Write 1件');
    // **なぜ一覧に出す必要があったのか**まで書く（クローンには回っていない）。
    expect(reply).toContain('クローンには回ってきていない');
    expect(reply).toContain('journal_read');
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('止められた道具');
  });

  it('拒否の種類が多くても一覧を食い潰さず、切ったことを言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set(
      'mgr-1',
      Array.from({ length: 7 }, (_, index) => ({ tool: `tool-${index}`, count: index + 1 })),
    );

    const reply = await h.call('manager_list', {});

    // 新しい側（末尾）から3種。
    expect(reply).toContain('tool-6 7件');
    expect(reply).toContain('tool-4 5件');
    expect(reply).not.toContain('tool-3');
    // 黙って落とさない。
    expect(reply).toContain('ほか 4 種');
    expect(reply).toContain('全 28 件');
  });

  /**
   * **`done` は「マネージャー自身のターンが終わった」でしかない。**
   *
   * その下で作業者が走っているかは、デーモンには見えていない（作業者の生存も
   * worktree の更新時刻も、ここからは読めない）。「走っている手は無く」は
   * 観測ではなく推測だった。
   */
  it('done を畳んだときに「走っている手は無い」と断定しない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'done';

    const reply = await h.call('manager_stop', { managerId: 'mgr-1' });

    expect(reply).toContain('待機中（done）');
    // 断定へ戻したら、ここで落ちる。
    expect(reply).not.toContain('走っている手は無く');
    expect(reply).toContain('作業者');
    expect(reply).toContain('見えていない');
  });
});

describe('usage_read（人間が見られるものはクローンからも見られる）', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
    'claude-sonnet-5': {
      inputTokens: 5,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.0031,
    },
  };

  async function spent(h: Harness) {
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });
  }

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('usage_read'));
  });

  it('合計とモデル別を返し、但し書きを必ず添える', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('合計 $2.00');
    expect(reply).toContain('claude-opus-5');
    expect(reply).toContain('claude-sonnet-5');
    // **推定であることを落とさない。** 台帳の数字を確定として見せない。
    expect(reply).toContain('請求明細ではない');
  });

  it('$1 未満を丸めて 0 にしない（「使っていない」と読めてしまう）', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { managerId: 'mgr-1' });

    expect(reply).toContain('$0.0031');
    expect(reply).not.toContain('$0.00\n');
  });

  it('まだ1件も無ければ「$0」ではなく「記録が無い」と言う', async () => {
    const h = harness();

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('記録が無い');
    expect(reply).not.toContain('$0');
  });

  it('台帳の始点より前を聞かれたら「0」ではなく「記録が無い」と言う', async () => {
    // 過去分は掘り起こさないと決めた。だから始点を黙って隠さない — 台帳が無かった
    // 期間を「使っていない期間」に見せると、それは嘘になる。
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2020-01-01' });

    expect(reply).toContain('台帳の始点');
    expect(reply).toContain('記録が無い');
  });

  it('その範囲に記録が無いことと、台帳が空であることを混ぜない', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2026-09-01', to: '2026-09-30' });

    expect(reply).toContain('その範囲には記録が無い');
    // 台帳自体は始まっているので、その始点は分かる。
    expect(reply).toContain('台帳の始点: 2026-08-14');
  });
});

describe('usage_read の5軸と、打ち切りから続きへ辿る道', () => {
  const one = (costUsd: number) => ({
    'claude-opus-5': {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd,
    },
  });

  async function record(
    h: Harness,
    over: {
      layer: 'clone' | 'manager';
      site: 'session' | 'distill';
      managerId: string;
      costUsd: number;
      date?: string;
    },
  ) {
    await h.stores.usage.record({
      layer: over.layer,
      site: over.site,
      accumulation: over.site === 'distill' ? 'oneshot' : 'cumulative',
      managerId: over.managerId,
      date: over.date ?? '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models: one(over.costUsd) },
    });
  }

  it('層と場所の軸を出す（モデル名では層を見分けられない）', async () => {
    // 2件とも同じモデル id である。`ALTEROID_CLONE_MODEL` を置けば実際にこうなる。
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'distill', managerId: 'clone', costUsd: 0.5 });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('層別（誰が）:');
    expect(reply).toContain('場所別（どこで）:');
    expect(reply).toContain('manager: $2.00');
    expect(reply).toContain('clone: $0.5000');
    expect(reply).toContain('distill: $0.5000');
  });

  it('層で絞れる（4つの口に同じ絞り込みがある）', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'session', managerId: 'clone', costUsd: 0.5 });

    const onlyClone = await h.call('usage_read', { layer: 'clone' });

    expect(onlyClone).toContain('合計 $0.5000');
    expect(onlyClone).not.toContain('mgr-1');
  });

  it('場所で絞れる', async () => {
    const h = harness();
    await record(h, { layer: 'clone', site: 'session', managerId: 'clone', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'distill', managerId: 'clone', costUsd: 0.5 });

    const onlyDistill = await h.call('usage_read', { site: 'distill' });

    expect(onlyDistill).toContain('合計 $0.5000');
  });

  it('打ち切ったら、続きの取り方をその行に書く（「残り N 件」で終わらせない）', async () => {
    // **黙って切り捨てない**うえに、**続きへ辿れないことも作らない。**
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 20 - i,
      });
    }

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('残り 6 件は出していない');
    expect(reply).toContain('axis="manager", offset=14 で続きが出る');
  });

  it('axis を指定すると、その軸だけを offset から出す', async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 20 - i,
      });
    }

    const reply = await h.call('usage_read', { axis: 'manager', offset: 14 });

    // まとめ表示の先頭14件と続きが重ならない（同じ並びを1か所で決めている）。
    expect(reply).toContain('mgr-14');
    expect(reply).toContain('mgr-19');
    expect(reply).not.toContain('mgr-13');
    // 他の軸もアカウント全体の残りも出さない（続きを辿るたびに全体が返らない）。
    expect(reply).not.toContain('日別');
    expect(reply).not.toContain('アカウント全体の残り');
  });

  it('offset が範囲外でも黙って空を返さない', async () => {
    // 空の一覧だけでは「この軸には記録が無い」と「offset が範囲外」を区別できない。
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const reply = await h.call('usage_read', { axis: 'manager', offset: 99 });

    expect(reply).toContain('全 1 件で、offset=99 以降は無い');
  });

  it('層の軸の始点を台帳の始点と混ぜない', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const reply = await h.call('usage_read', { from: '2020-01-01' });

    expect(reply).toContain('層と場所の軸の始点: 2026-08-14');
    expect(reply).toContain('既定値であって観測ではない');
  });
});

describe('usage_read はアカウント全体の残りも返す（人間と同じものを見せる）', () => {
  function withAccount(accountUsage: () => AccountUsageState) {
    const stores = createMemoryStores();
    const tools = createCloneTools({ stores, emit: () => undefined, accountUsage });
    return async (args: Record<string, unknown> = {}) => {
      const found = tools.find((t) => t.name === 'usage_read');
      const result = await found!.handler(args as never, {} as never);
      return result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    };
  }

  it('まだ取っていないときは「0」ではなく「分からない」と言う', async () => {
    const call = withAccount(() => ({ state: 'unknown' }));
    const reply = await call();
    expect(reply).toContain('まだ取りに行っていない');
    expect(reply).toContain('0 ではなく');
  });

  it('取れなかったときは理由を出す（0% と描かない）', async () => {
    const call = withAccount(() => ({
      state: 'failed',
      at: '2026-08-14T10:00:00.000Z',
      reason: '2つの口のどちらも答えなかった',
    }));
    const reply = await call();
    expect(reply).toContain('取れなかった');
    expect(reply).toContain('0 ではなく');
    expect(reply).not.toContain('0%');
  });

  it('この構成では取れないときは、そう言う', async () => {
    const call = withAccount(() => ({
      state: 'unavailable',
      at: '2026-08-14T10:00:00.000Z',
      reason: 'claude.ai にログインしていない（鍵が届けば取れる）',
    }));
    expect(await call()).toContain('ログインしていない');
  });

  it('枠と支出上限を出す', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [
          { kind: 'five_hour', utilization: 42, resetsAt: Date.parse('2026-08-14T13:00:00.000Z') },
        ],
        extraUsage: {
          enabled: true,
          monthlyLimit: 100,
          usedCredits: 40,
          utilization: 40,
          currency: 'USD',
        },
      },
    }));
    const reply = await call();
    expect(reply).toContain('Claude Max');
    expect(reply).toContain('42% 使用');
    expect(reply).toContain('40 USD / 100 USD');
  });

  it('使用率が付かない枠を 0% と書かない', async () => {
    // `five_hour` には utilization が付かないことがある（実測）。
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Team',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', resetsAt: Date.parse('2026-08-14T13:00:00.000Z') }],
      },
    }));
    const reply = await call();
    expect(reply).toContain('使用率は取れなかった');
    expect(reply).not.toContain('0% 使用');
  });

  it('枠が来なかったら「0%」ではなく「取れなかった」', async () => {
    // `rate_limits_available: true` でも `rate_limits: null` があり得る（実測）。
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Team',
        limitsAvailable: true,
        windows: [],
      },
    }));
    const reply = await call();
    expect(reply).toContain('枠: 取れなかった');
    expect(reply).toContain('0% ではない');
  });

  it('支出上限が取れないことを黙らない（残額が分からないと言う）', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', utilization: 10 }],
      },
    }));
    const reply = await call();
    expect(reply).toContain('支出上限: 取れなかった');
    expect(reply).toContain('残額は分からない');
  });

  it('通貨が分からないときは金額として整形しない（嘘の単位を名乗らない）', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [],
        extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 40, utilization: 40 },
      },
    }));
    const reply = await call();
    expect(reply).toContain('単位不明');
    expect(reply).not.toContain('$40');
  });
});

/**
 * `self_status`（いま自分がどう走っているか）。
 *
 * **`CloneRuntimeFacts` の整形そのものは self.test.ts が確かめる。** ここで見るのは
 * tools.ts 側だけの仕事 — その場で読み直す記憶の大きさと、台帳との突き合わせが、
 * `stores` の実物と正しく噛み合っているか。
 */
describe('self_status（いま自分がどう走っているか）', () => {
  const RUNTIME: CloneRuntimeFacts = {
    revision: { commit: null, short: null, source: null },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: null,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    // **意図的に、以下で書き込む記憶の総文字数とは違う値にしてある。** 「いまの
    // 総文字数」と区別できることを見るための固定値であって、実際の構築時の値を
    // 模したものではない。
    injectedMemoryChars: 3,
    systemPromptChars: 999,
  };

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('self_status'));
  });

  it('runtime を渡していない場面（蒸留のサイドクエリを模した形）では、落ちずに読めないと返す', async () => {
    const tools = createCloneTools({ stores: createMemoryStores(), emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status が無い');
    const result = await found.handler({} as never, {});
    const body = (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
    expect(body).toContain('読めない場面');
  });

  it('記憶の文書数といまの総文字数が出る。焼き込んだ時点の文字数とは別々に出る', async () => {
    const h = harness(() => RUNTIME);
    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n人間が手で書いた方針',
      summary: '書いた',
    });
    await h.call('memory_write', {
      slug: 'habits',
      content: '# 習慣\n\n毎朝記憶を見直す',
      summary: '書いた',
    });
    const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());
    expect(totalMemory.length).not.toBe(RUNTIME.injectedMemoryChars);

    const reply = await h.call('self_status', {});

    expect(reply).toContain('2 文書');
    expect(reply).toContain(`${totalMemory.length.toLocaleString('en-US')} 文字`);
    // 焼き込んだ時点の文字数（固定値 3）が、いまの総文字数とは別の行として出る。
    expect(reply).toContain('焼き込んだ記憶の文字数（このセッションを組み立てた時点）: 3 文字');
  });

  it('記憶を書き換えたあとに呼んでも、いまの総文字数は読み直した値が出る', async () => {
    const h = harness(() => RUNTIME);
    await h.call('memory_write', { slug: 'values', content: '# 価値観\n\n最初の版', summary: '1' });
    await h.call('self_status', {}); // 1回目（内容は見ない。副作用が無いことの前提づくり）

    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n書き換えた後のもっと長い方針の本文',
      summary: '2',
    });
    const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());

    const reply = await h.call('self_status', {});

    expect(reply).toContain(`${totalMemory.length.toLocaleString('en-US')} 文字`);
    // 焼き込んだ時点（固定値 3）は書き換えても動かない — 別の軸であることの確認。
    expect(reply).toContain('組み立てた時点）: 3 文字');
  });

  it('鍵・トークンの値を出さない（profile_write で置いた値が self_status に出ない）', async () => {
    const h = harness(() => RUNTIME);
    await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=super-secret-value-000',
      summary: 'トークンを実行環境へ移した',
    });

    const reply = await h.call('self_status', {});

    expect(reply).not.toContain('super-secret-value-000');
  });

  it('SDK モデル id がまだ分からなければ、突き合わせをせずそう言う', async () => {
    const h = harness(() => RUNTIME); // sdkModel: null

    const reply = await h.call('self_status', {});

    expect(reply).toContain('まだ init を観測していない');
  });

  it('台帳に同じモデル id の行があれば、その managerId が出る（軸: 日 × マネージャー × モデル）', async () => {
    const models = {
      'claude-fable-9000': {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUsd: 1.5,
      },
    };
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-7',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });

    const reply = await h.call('self_status', {});

    expect(reply).toContain('claude-fable-9000');
    expect(reply).toContain('managerId: "mgr-7"');
    // 「載っている／いない」という断定ではなく、軸（managerId 付きの行）を出す。
    expect(reply).not.toMatch(/あなたの消費が(台帳に)?載って/);
  });

  it('同じモデル id の行が無ければ、そう言う（0 件と嘘をつかない）', async () => {
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-other-model': {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 1,
          },
        },
      },
    });

    const reply = await h.call('self_status', {});

    expect(reply).toContain('同じ行は無い');
  });
});

/**
 * `journalEntrySchema` の `memory_update.action` は **optional** で足した。
 *
 * 「書いた」と「消した」の区別がこれまで `summary` の自由文にしか無かった
 * （PR #144 で潰したのと同じ形の欠陥）ので機械可読な区別を足すが、optional に
 * したのは既存の日誌エントリを1件も壊さないためである。ここではその意味
 * そのもの——`action` の無いエントリが今も通ること——を固定する。
 */
describe('journalEntrySchema の memory_update（action の後方互換）', () => {
  it('action の無い既存エントリ（action 導入前の形）が今も通る', () => {
    const legacy = {
      type: 'memory_update' as const,
      id: 'j-1',
      at: '2026-08-01T00:00:00.000Z',
      slug: 'values',
      cause: 'human' as const,
      summary: '古い形式のエントリ（action フィールドが無い）',
    };

    const result = journalEntrySchema.safeParse(legacy);

    expect(result.success).toBe(true);
  });

  it('action を付けたエントリも通り、値がそのまま読める', () => {
    const withAction = {
      type: 'memory_update' as const,
      id: 'j-2',
      at: '2026-08-01T00:00:00.000Z',
      slug: 'values',
      cause: 'clone' as const,
      action: 'remove' as const,
      summary: '削除の記録',
    };

    const result = journalEntrySchema.safeParse(withAction);

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'memory_update') {
      expect(result.data.action).toBe('remove');
    }
  });
});

/**
 * `journal_read`（クローンが読む面）が `memory_update` の `action` /
 * `bytesBefore` / `bytesAfter` を出すこと（#339）。
 *
 * 記録側（`memory_write` 等）は既に action / バイト数を日誌へ書いているが
 * （上のテスト群）、読み出す面がそれを出していなかった。ここで測るのは
 * 読み出し側——`renderJournalEntry` の `memory_update` 分岐——である。
 */
describe('journal_read — memory_update の action / バイト数（#339）', () => {
  it('action と前後バイト数を出す（新形式のエントリ）', async () => {
    const h = harness();
    await h.call('memory_write', { slug: 'values', content: '12345', summary: '最初の書き込み' });
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    if (entry === undefined) throw new Error('memory_write が日誌へ記録していない');

    const reply = await h.call('journal_read', { id: entry.id });

    expect(reply).toContain('write');
    expect(reply).toContain('bytes=0→5');
  });

  it('action / バイト数を持たない古いエントリは「不明」と明示し、0 としては出さない', async () => {
    const h = harness();
    const legacy = await h.stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'human',
      summary: '古い形式のエントリ（action フィールドが無い）',
    });

    const reply = await h.call('journal_read', { id: legacy.id });

    expect(reply).not.toContain('bytes=0→0');
    expect(reply).not.toMatch(/bytes=0(?!→)/);
    expect(reply).toContain('不明');
  });

  it('head のバイト表示（bytes=）が、summary 由来の文字数（body の自由文）の側へ紛れ込まない', async () => {
    const h = harness();
    await h.stores.persona.write('temp-note', '12345');
    await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    if (entry === undefined) throw new Error('memory_delete が日誌へ記録していない');

    const reply = await h.call('journal_read', { id: entry.id });
    const separatorIndex = reply.indexOf('\n\n');
    const headLine = reply.slice(0, separatorIndex);
    const body = reply.slice(separatorIndex + 2);

    // head 行には機械可読なバイトの注記（`bytes=`）が載る。
    // （同じ head 行には `excerpt.ts` の `describePage` が付ける「全 N 文字」
    // という**ページングの都合の**文字数も載るが、それは memory_delete の
    // summary が埋め込む「削除直前の文字数」とは別物で、全 entry 型に
    // 共通する既存の仕組みである。ここで確かめたいのはその混在ではなく、
    // memory_update 固有の自由文（summary、削除直前の文字数を含む）へ
    // `bytes=` が紛れ込まないことである。）
    expect(headLine).toContain('bytes=5→0');
    // body（summary）には削除直前の文字数（「40 文字」等の自由文）が入るが、
    // 機械可読なバイトのラベル（`bytes=`）は出ない——単位の異なる2つの数値が
    // 同じ自由文へ混ざる経路を作らない。
    expect(body).toContain('文字');
    expect(body).not.toContain('bytes=');
  });
});

/**
 * **道具を足したら、システムプロンプトの道具一覧（`prompt.ts` の「# 道具」）にも載せる。**
 *
 * 関数呼び出しのスキーマ（`allowedTools`）に載っていれば呼べはするが、クローンが
 * 「そういう道具がある」と自分で気づく手がかりは一覧にしかない。載せ忘れると、
 * 能力はあるのに使われない道具ができる（`self_status` を足したときに実際に
 * 載せ忘れた）。ここは載せ忘れが**静かに通る**形の失敗なので、仕組みで塞ぐ。
 */
describe('システムプロンプトの道具一覧', () => {
  it('CLONE_TOOL_NAMES の全部が載っている（一覧に無い道具を作らない）', () => {
    const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });
    const section = prompt.split('# 道具')[1]?.split('# 委譲')[0];
    // 節そのものが見つからなければ、下の照合は全部「載っていない」に倒れる。
    // **その状態を「一覧が空だった」と読み替えないこと**（節の名前を変えたなら
    // ここも直す、が正しい振る舞いである）。
    expect(section).toBeDefined();
    const missing = CLONE_TOOL_NAMES.filter((name) => !(section ?? '').includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});

/**
 * **一覧の総当たり — 「予算を書き忘れても何も落ちない」形をやめる。**
 *
 * この repo は同じバグを3回踏んでいる。`manager_list` が件数で溢れ（実測
 * 52,997 文字）、`journal_read` が出力上限で丸ごと落ち、`digest` の6節が
 * 黙って切れた。3回とも「溢れた1本を後追いで塞ぐ」形で終わっていて、
 * その理由は `digest.ts` の冒頭が逐語で記録している:
 *
 * > 後から足した6節が黙って切れていたのは、**この行が各節の実装の側にあって
 * > 書き忘れても何も落ちなかったから**
 *
 * 道具の側も同じだった。`manager_list` にだけ「件数が増えても壊れない」歯が
 * 立っていて、`approvals_list` / `schedule_list` / `runner_list` は無上限のまま
 * 残っていた。**歯が1本ずつだと、次に足す一覧も無上限で入る。**
 *
 * だからここは**名前から機械的に集める**。`CLONE_TOOL_NAMES` に `_list` で
 * 終わる名前を足した人は、この試験に何も書き足さなくても捕まる。
 *
 * ⚠️ **この掃き方が拾えない範囲を明示しておく。** 集めているのは名前が
 * `_list` で終わるものだけで、`journal_read` / `usage_read` / `conversation_read` /
 * `self_status` は一覧を返すのにこの網に入らない（下で名指しして足してある）。
 * **別の名前で新しい一覧を足した人は、やはり自分で書き足す必要がある** —
 * 網が全部を覆っていると読まれるほうが、覆っていないと分かっているより悪い。
 *
 * **1つの道具が複数の一覧モードを持つなら、モードごとに名指しすること。**
 * `conversation_read` は積む向きの違う3モードを持つので4件に分けてある
 * （1つ測っても他のモードは何も測れていない）。
 */
describe('一覧は例外なく件数で壊れない（`*_list` の総当たり）', () => {
  /** 名前から集めた一覧。**ここに手で名前を書かない**（書けば数え上げが腐る）。 */
  const SWEPT = CLONE_TOOL_NAMES.filter((name) => name.endsWith('_list'));
  /**
   * 名前が `_list` で終わらないのに一覧を返すもの。**網の外なので名指しする。**
   * 引数は「既定の呼び方」（一覧モード）を選ぶためのもの。
   */
  const NAMED: { label: string; name: string; args: Record<string, unknown> }[] = [
    { label: 'journal_read（既定）', name: 'journal_read', args: {} },
    /*
     * **`journal_read` は既定の引数では予算に届かない。**
     *
     * 既定は 20 件で、1件の本文は 120 字に抜粋される（`JOURNAL_TEXT_EXCERPT`）
     * ので、既定の呼びは高々 3,000 字程度にしかならず `JOURNAL_BUDGET` は
     * 一度も拘束条件にならない。既定だけを測ると、この一覧については
     * 「予算が効いている」ことを何も確かめていない。
     *
     * だから**呼び手が広げられる上限まで広げた呼び**も測る。`limit` の最大は
     * 200 なので、これが「クローンが出せる最大の要求」である。
     */
    { label: 'journal_read（limit 最大）', name: 'journal_read', args: { limit: 200 } },
    { label: 'usage_read', name: 'usage_read', args: {} },
    /*
     * **`conversation_read` は3つの一覧モードを持ち、予算の切り口が別々である。**
     *
     * 引数なし＝会話の一覧、`conversationId`＝その会話の中身（末尾から積む）、
     * `q`＝語で探す（先頭から積む）。**積む向きが違うので、1つ測っても他の2つは
     * 何も測れていない**（中身モードだけが `renderListingFromEnd` を通る）。
     * `id` モードは一覧ではないので、下の「詳細側」の試験が持つ。
     */
    { label: 'conversation_read（会話の一覧）', name: 'conversation_read', args: {} },
    /*
     * 一覧の既定は 20 件なので、`limit` を広げた呼びも測る（`journal_read` と
     * 同じ理由 — 既定だけだと予算が拘束条件にならないことがある）。
     */
    {
      label: 'conversation_read（会話の一覧・limit 最大）',
      name: 'conversation_read',
      args: { limit: 200 },
    },
    {
      // **長く続いた会話を指す**（`conv-0000` のような2発言の会話では予算が
      // 拘束条件にならず、この一覧については何も測れない。`flooded()` を見ること）。
      label: 'conversation_read（会話の中身）',
      name: 'conversation_read',
      args: { conversationId: 'conv-long' },
    },
    { label: 'conversation_read（語で探す）', name: 'conversation_read', args: { q: '発言' } },
    /*
     * **`self_status` は名前が `_list` で終わらないが、「記憶の大きさ」の節に
     * 一覧（文書ごとの内訳）を持つ。** ここで測るのは節全体の出力（P1/P2 は
     * 下で別に、節だけを切り出して測る — `self_status` は道具全体が一覧では
     * ないので、この2本（OUTPUT_CAP 未満・切ったら合図）だけがこの一覧の
     * 存在をそのまま測れる）。
     *
     * `self_status` は `runtime`（`ToolContext.runtime`）が無いと「読めない
     * 場面である」という定型文だけを返し、記憶の内訳を含む本体を組み立てない
     * ——だから `flooded()` は `harness()` に runtime を渡す（下の
     * `LISTING_SWEEP_RUNTIME`）。他の道具は `context.runtime` を一切読まない
     * ので（`tools.ts` を grep して確認済み: `context.runtime` の参照は
     * `self_status` の1箇所だけ）、runtime を渡しても他のケースの挙動には
     * 影響しない。
     */
    { label: 'self_status', name: 'self_status', args: {} },
  ];

  /**
   * MCP の出力上限より十分小さい安全域。`manager_list` の既存の歯と同じ値を
   * 使う（実測で溢れたのは 52,997 文字）。
   */
  const OUTPUT_CAP = 12_000;

  /**
   * 「切った」と読める合図。**この形のどれかで言うことが一覧の契約である。**
   *
   * ⚠️ **語彙を増やすほど、この試験は「何か書いてある」しか測らなくなる。**
   * 新しい一覧を足すときは、まず既存の言い方に寄せること——ここへ1つ足すのは
   * 「その言い方も契約に入れる」という判断であって、通し方の調整ではない。
   *
   * いま入っているものの出どころ:
   * - `省略` — `manager_list` / `journal_read` / `approvals_list` /
   *   `schedule_list` / `runner_list` / `memory_list` / `commitment_list`
   * - `残り N` — `usage_read`（軸モードの続きの案内。既存の言い方）
   * - `文字目` — `describePage`（全文モードで何文字目までか）
   */
  const TRUNCATION_MARK = /省略|残り \d|文字目/;

  it('掃き出しが空にならない（検出器そのものが効いていることの確認）', () => {
    // 0件でも `it.each` は「通った」ように見える。数え上げが壊れたら落ちる。
    expect(SWEPT.length).toBeGreaterThanOrEqual(6);
    expect(SWEPT).toContain('approvals_list');
    expect(SWEPT).toContain('schedule_list');
    expect(SWEPT).toContain('runner_list');
    expect(SWEPT).toContain('memory_list');
    expect(SWEPT).toContain('commitment_list');
    expect(SWEPT).toContain('manager_list');
  });

  /**
   * `flooded()` が作る `harness()` へ渡す runtime。
   *
   * **`self_status` をこの掃き出しの対象に足すために要る。** runtime を
   * 渡さない既定の `harness()` では `self_status` は「いまは自分の実行時の
   * 事実を読めない場面である」という定型文だけを返し、記憶の内訳を含む
   * 本体を一切組み立てない——それでは OUTPUT_CAP も TRUNCATION_MARK も
   * 何も測れない。値そのものは `describe('self_status…')` の `RUNTIME` と
   * 同じ形（このテストが見るのは `stores` との噛み合わせであって
   * `CloneRuntimeFacts` の整形自体ではないので、値の中身に意味は無い）。
   *
   * **他の道具は `context.runtime` を読まないので、この定数を足しても他の
   * ケースの挙動は変わらない**（`tools.ts` を `grep -n 'context.runtime'` で
   * 確認済み——参照は `self_status` のハンドラ1箇所だけ）。
   */
  const LISTING_SWEEP_RUNTIME: CloneRuntimeFacts = {
    revision: { commit: null, short: null, source: null },
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: null,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    injectedMemoryChars: 0,
    systemPromptChars: 0,
  };

  /**
   * どの一覧も「溢れる手前」まで積んだ器を作る。
   *
   * **1つの器で全部の一覧を撃つ。** 一覧ごとに別の器を作ると、積み忘れた
   * ストアの一覧が「0件だから短い」で通ってしまう（それは上限の保証ではない）。
   */
  async function flooded(count: number): Promise<Harness> {
    const h = harness(() => LISTING_SWEEP_RUNTIME);
    const long = 'あ'.repeat(1_500);

    for (let index = 0; index < count; index += 1) {
      const pad = String(index).padStart(4, '0');
      // マネージャー（manager_list / runner_list の内訳）
      await h.call('manager_start', { request: `依頼${pad}: ${long}` });
      // 承認待ち（approvals_list）
      await h.stores.jobs.putApproval({
        id: `ap-${pad}`,
        createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        question: `質問${pad}: ${long}`,
        jobId: `mgr-${pad}`,
        requestId: `req-${pad}`,
      });
      // 継続中の依頼（schedule_list）
      await h.call('schedule_create', {
        kind: `watch-${pad}`,
        request: `仕込み${pad}: ${long}`,
        everyMinutes: 60,
      });
      // 引き受けた仕事（commitment_list）
      await h.call('commitment_open', { body: `約束${pad}: ${long}` });
      // 記憶（memory_list）
      await h.stores.persona.write(
        `doc-${pad}`,
        `---\ndescription: 要旨${pad} ${long}\ntype: fact\n---\n# 題${pad}\n\n${long}`,
      );
      // 日誌（journal_read）
      await h.call('journal_write', { type: 'decision', decision: `決めた${pad}: ${long}` });
      // 人間との会話（conversation_read の3モード）。
      // **ここを積み忘れると、`conversation_read` は「会話はまだ無い」で短く返り、
      // 上限の試験を「そもそも短かった」で通ってしまう**（この器を1つにしてある
      // 理由そのもの）。会話ごとに2発言積んで、一覧・中身・語検索の全部を太らせる。
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `人間の発言${pad}: ${long}`,
        conversationId: `conv-${pad}`,
      });
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'outbound',
        text: `クローンの返答${pad}: ${long}`,
        conversationId: `conv-${pad}`,
      });
      // **1本だけ、長く続いた会話を作る。** 会話ごとに2発言では「中身」モードの
      // 予算が一度も拘束条件にならず、`renderListingFromEnd` については何も
      // 測れていない状態で歯が通る（`runner_list` を 12 台から 120 台へ増やした
      // のと同じ形。変異を当てて確かめた — 2発言のままだと予算を外す変異が生き残る）。
      await h.stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `長い会話の発言${pad}: ${long}`,
        conversationId: 'conv-long',
      });
      // 使用量の台帳（usage_read）— 委譲別の軸が件数で伸びる
      await h.stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'cumulative',
        managerId: `mgr-${pad}`,
        date: usageDate(new Date(2026, 7, 14, 10, 0)),
        at: new Date(2026, 7, 14, 10, 0).toISOString(),
        snapshot: {
          models: {
            [`claude-model-${pad}`]: {
              inputTokens: 10,
              outputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: 1 + index,
            },
          },
        },
      });
    }
    for (const summary of h.running) {
      summary.lastReport = `報告: ${'ほ'.repeat(3_000)}`;
      summary.waiting = [
        {
          requestId: `req-${summary.managerId}`,
          summary: 'ま'.repeat(3_000),
          kind: 'permission',
          askedAt: '2026-08-01T00:00:00.000Z',
        },
      ];
    }
    // 器の一覧（runner_list）— 内訳に全マネージャーを載せる。
    // **台数は「予算が拘束条件になる」ところまで積む。** 12台で試したときは
    // `RUNNER_MANAGER_LIST_LIMIT`（内訳の件数）だけで上限内に収まってしまい、
    // ブロックの予算を外す変異が生き残った（＝この一覧については何も測れて
    // いなかった）。変異で確かめて決めた台数である。
    h.setRunnersOverview({
      runners: Array.from({ length: 120 }, (_, index) => ({
        label: `runner-${index}`,
        state: 'connected' as const,
        since: '2026-01-01T00:00:00.000Z',
        runnerId: `runner-${index}`,
        workspacePath: '/workspace',
        revision: { status: 'unknown' as const },
        managers: h.running.map((m) => ({ managerId: m.managerId, status: m.status })),
      })),
      unassigned: h.running.map((m) => ({ managerId: m.managerId, status: m.status })),
      daemonRevision: { status: 'unknown' as const },
    });
    return h;
  }

  const CASES = [
    ...SWEPT.map((name) => ({ label: name, name, args: {} as Record<string, unknown> })),
    ...NAMED,
  ];

  it.each(CASES)('$label — 件数が増えても出力は上限内に収まる', async ({ name, args }) => {
    const h = await flooded(60);

    const reply = await h.call(name, args);

    expect(reply.length).toBeLessThan(OUTPUT_CAP);
  });

  it.each(CASES)(
    '$label — 切ったなら黙らない（省いたことが出力に出る）',
    async ({ name, args }) => {
      const h = await flooded(60);

      const reply = await h.call(name, args);

      // **「切った」と読める合図が出ていること。** 何も出ていなければ、
      // 受け取った側は「これで全部だ」と読んで全体像を組み立てる。
      expect(reply).toMatch(TRUNCATION_MARK);
    },
  );

  /**
   * **P1 と P2 は別の性質であって、1つに畳まない。**
   *
   * 人間の依頼の逐語:「一覧系ツールは最低でも id + 名前 + 概要 + updated_at +
   * created_at が欲しい」。**これが P1 である。** #208 / #215 で手で揃えたが、
   * **手で書いている限り、次に一覧を足す人が落としても何も落ちない。**
   *
   * | | 中身 | 出所 |
   * | --- | --- | --- |
   * | **P1** | 5つの値（id / 名前 / 概要 / 作成 / 更新）が出ているか | 人間の依頼そのもの |
   * | **P2** | 4つの一覧（`renderListingEntry` を通るもの）と同じ3行ブロックの並びか | #231 が別に足した目標 |
   *
   * **旧版はこの2つを1つの `it.each` に畳んでいた**（`作成/更新は2行目・
   * 概要は3行目` という**位置固定**の正規表現で P1 を測っていた）。
   * `memory_list` は #220 で P1 の5項目を全部出すようになったが、
   * **P2 の形（階層をインデントで表す1行1件の木）ではない**ため、旧版の
   * 位置固定の歯では「5項目は出ているのに落ちる」という誤検出になっていた
   * （実測: `AssertionError: expected '- [fact] doc-0001: 題0001 (作成:
   * 2026-08…' to match /^ {2}…/ 更新: \d{4}-…/`）。**満たしているものを
   * 未達に見せる歯は、それ自体が欠陥である。**
   *
   * **この歯は「どの口を通ったか」を見ない。出力に5項目が在るかを見る。**
   * `renderListingEntry`（型で5つを必須にした口）は `renderListing` を塞がないので、
   * 低レベルの口を直接呼んで手で組めば型は素通りできる——**それでもこの歯は捕まる。**
   * 機構ではなく性質を測っているからである。
   *
   * 集合は `SWEPT`（`CLONE_TOOL_NAMES` から `_list` を機械的に集めたもの）を使う。
   * **表を手で書かない** — 名前の表を持つと、次の人がそこへ足し忘れる。
   */

  /**
   * **軸そのものが未決で、P1 を測ること自体ができないもの。**
   *
   * 散文の理由を書くのはここまでにする——下の自己測定の歯が、この除外が
   * まだ正しいこと（＝いまも P1 を満たしていないこと）を毎回測り直す。
   *
   * **「軸が未決」は、いまも経過ではなく結論であるものがある。** `runner_list`
   * はかつて「#211 待ち」（判断待ち）だったが、**人間が「出さない」と決めた**
   * （2026-08-23。理由は下のコメント）。それでも軸の意味そのもの（(a)/(b) の
   * どちらを作成時刻と呼ぶか）はいまも未定義のままである——決まったのは
   * 「未定義のまま出さない」が**最終形である**ことで、「いずれ決めて出す」の
   * 途中ではない。**だから変数名・doc の主張（軸が未決で P1 を測れない）は
   * そのまま正しく、変える必要が無い。**
   */
  const AXIS_UNDECIDED = new Map<string, string>([
    [
      'runner_list',
      // 器は永続化層を持たず（名簿は `runner-protocol.ts` の `Registry` が
      // 持つインメモリの Map で、デーモンを再起動すれば全部消える）、`since` は
      // 「この状態になった時刻」で**状態が変わるたびに更新される**（=
      // created_at ではない）。そして「作成時刻」が (a) 器の定義が置かれた時刻
      // (b) いまの接続が確立した時刻 のどちらを指すのかが**決まっていなかった。**
      //
      // **`unknown` で埋めないこと。** `unknown` は「在るはずだが根拠が無い」を
      // 表す値である。ここは**そもそも何を作成時刻と呼ぶかが未決**で、前者は
      // 決めれば答えが出るが後者は決めても出ない。**混ぜると、未決が不明に化ける。**
      //
      // **人間が決めた（2026-08-23）。** (a)/(b) のどちらかに決める／(c)
      // そもそも `runner_list` には作成時刻を出さない、の3案を諮ったところ、
      // 人間の回答は逐語で:「まぁ、無理に置く必要はありません。runner_list は
      // なくても良いこととします」——(c) を選んだ。他の一覧と揃わないことを
      // 人間が明示的に受け入れている。**実装しなかったのではなく、出さないと
      // 決まった。**
      '人間が出さないと決めた（2026-08-23。runner_list には作成時刻を置かない。unknown で埋めない）',
    ],
  ]);

  /**
   * **P1（5項目）は満たすが、P2（4一覧と同じ3行ブロック）の形は違うことが
   * 設計であるもの。**
   *
   * `memory_list` がこれである。5項目は出ている（#220 で着地済み。実測:
   * `- [fact] doc-a: 題A (作成: 2026-08-01T09:00:00.000Z / 更新:
   * 2026-08-20T10:00:00.000Z) — これは要旨である`）。**揃っていないのは
   * P2 の位置だけ**——`memory_list` は階層をインデントで表す1行1件の木で、
   * 共通の口（`renderListingEntry` の3行ブロック）へ寄せると親子関係を
   * 表す手段（インデント）が無くなる。揃えるのではなく能力を削ることに
   * なるので、寄せない。
   */
  const SHAPE_DIFFERENT = new Map<string, string>([
    [
      'memory_list',
      '形が違うことが設計（P1 は満たす）。階層をインデントで表す1行1件の木なので、' +
        '4つの一覧と同じ3行ブロックへ寄せると親子関係を表す手段が消える。' +
        '#220（記憶に createdAt を持たせ memory_list に出す）は既にマージ済みで、' +
        '「#220 待ち」という理由はもう書けない',
    ],
  ]);

  /** P1（5項目）を測る対象。軸が未決のものだけを外す——`memory_list` は含む。 */
  const FIVE_FIELD_SWEPT = SWEPT.filter((name) => !AXIS_UNDECIDED.has(name));
  /** P2（4一覧と同じ3行ブロック）を測る対象。形が違うことが設計のものも外す。 */
  const STRICT_SHAPE_SWEPT = FIVE_FIELD_SWEPT.filter((name) => !SHAPE_DIFFERENT.has(name));

  it('P1/P2 それぞれの網が空にならず、除外は実在する道具を指している', () => {
    // **除外の綴りが違えば、除外は効かないまま「除外したつもり」になる。**
    for (const name of AXIS_UNDECIDED.keys()) expect(SWEPT).toContain(name);
    for (const name of SHAPE_DIFFERENT.keys()) expect(SWEPT).toContain(name);
    // 掃き出しが空だと `it.each` は0件で「通った」ように見える。
    expect(FIVE_FIELD_SWEPT.length).toBeGreaterThanOrEqual(5);
    expect(FIVE_FIELD_SWEPT).toContain('approvals_list');
    expect(FIVE_FIELD_SWEPT).toContain('schedule_list');
    expect(FIVE_FIELD_SWEPT).toContain('commitment_list');
    expect(FIVE_FIELD_SWEPT).toContain('manager_list');
    // **`memory_list` は P1 の網に入る——除外していない。**
    expect(FIVE_FIELD_SWEPT).toContain('memory_list');
    expect(STRICT_SHAPE_SWEPT.length).toBeGreaterThanOrEqual(4);
    expect(STRICT_SHAPE_SWEPT).toContain('approvals_list');
    expect(STRICT_SHAPE_SWEPT).toContain('schedule_list');
    expect(STRICT_SHAPE_SWEPT).toContain('commitment_list');
    expect(STRICT_SHAPE_SWEPT).toContain('manager_list');
    expect(STRICT_SHAPE_SWEPT).not.toContain('memory_list');
    expect(STRICT_SHAPE_SWEPT).not.toContain('runner_list');
  });

  /**
   * **1件（entry）の切り出し方。** `- ` で始まる行（先頭の空白は許す——
   * `memory_list` の子は `  - ` とインデントされる）から、次の entry の
   * 直前までを1件とする。省略の断り書き（`…ほか N 件は省略`）は `- ` で
   * 始まらないので、entry には数えない（直前の最後の entry の末尾に付くだけ
   * で、判定には影響しない）。
   */
  function splitListingEntries(reply: string): string[] {
    const lines = reply.split('\n');
    const starts: number[] = [];
    lines.forEach((line, index) => {
      if (/^\s*-\s\S/.test(line)) starts.push(index);
    });
    return starts.map((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1]! : lines.length;
      return lines.slice(start, end).join('\n');
    });
  }

  const CREATED_AT_PATTERN = /作成: (?:\d{4}-\d{2}-\d{2}T[\d:.]+Z|不明)/;
  const UPDATED_AT_PATTERN = /更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z/;
  // id + 名前。位置は固定しない——P2（3行ブロック）は改行の直後、P1
  // （`memory_list`、1行1件の木）は同じ行の中に概要まで続く。どちらも
  // 「- 」の直後に、別々の非空テキストが2つ以上並ぶ、という点は共通。
  const ID_AND_NAME_PATTERN = /^\s*-\s+\S+\s+\S/;
  // `作成: … / 更新: …` を1つのまとまりとして取り除くための正規表現
  // （`renderListingEntry` と `renderMemoryListing` はどちらもこの1文の形で書く）。
  const TIMESTAMP_PAIR_PATTERN =
    /作成: (?:\d{4}-\d{2}-\d{2}T[\d:.]+Z|不明) \/ 更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z/;

  /**
   * **概要が在るか。** 作成/更新のペアを取り除いたうえで、
   * (a) 1行目より後ろに何か書いてある行が残っているか（P2: 3行目の概要）、
   * (b) 1行目の中に `—`（概要の区切り）に続く非空のテキストがあるか
   *     （P1: `memory_list` は同じ行に `— <概要>` で続ける）
   * のどちらかで判定する。**タイトルを取り除いていないので、この判定は
   * 「概要が丸ごと消えた」ことを両方の形で検出できる**——下の
   * 「`memory_list` で概要が無い記憶は、概要の不在として検出される」で、
   * frontmatter に `description` が無い記憶を実際に作って確かめてある
   * （`— …` が現れず正しく落ちる）。ただし片方の形の中で「タイトルの
   * 一部を残し概要だけ削る」ような変異までは分離できない（タイトルと
   * 概要が同じ行に同居する P1 の構造上の限界。詳細は PR 本文）。
   */
  function hasSummaryBeyondTimestamps(entry: string): boolean {
    const withoutTimestamps = entry.replace(TIMESTAMP_PAIR_PATTERN, '');
    const lines = withoutTimestamps.split('\n');
    const hasSummaryLine = lines.slice(1).some((line) => line.trim().length > 0);
    const hasInlineSummary = /—\s*\S/.test(lines[0] ?? '');
    return hasSummaryLine || hasInlineSummary;
  }

  /** P1（5項目）の違反を全部返す。空配列なら満たしている。 */
  function fiveFieldViolations(entry: string): string[] {
    const violations: string[] = [];
    const firstLine = entry.split('\n')[0] ?? '';
    if (!CREATED_AT_PATTERN.test(entry)) violations.push('作成 が無い');
    if (!UPDATED_AT_PATTERN.test(entry)) violations.push('更新 が無い');
    if (!ID_AND_NAME_PATTERN.test(firstLine)) violations.push('id + 名前 が先頭行に無い');
    if (!hasSummaryBeyondTimestamps(entry))
      violations.push('概要 が無い（作成/更新を除いても本文が残らない）');
    return violations;
  }

  /**
   * P2（4一覧と同じ3行ブロック）の厳密な形。**旧版の位置固定の正規表現を
   * そのまま残す**——弱めていない。
   */
  function matchesStrictBlockShape(entry: string): boolean {
    const lines = entry.split('\n');
    if (!/^- \S+ \S/.test(lines[0] ?? '')) return false;
    if (
      !/^ {2}作成: \d{4}-\d{2}-\d{2}T[\d:.]+Z \/ 更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(
        lines[1] ?? '',
      )
    )
      return false;
    if (!/^ {2}\S/.test(lines[2] ?? '')) return false;
    return true;
  }

  it.each(FIVE_FIELD_SWEPT)(
    '%s — どの1件も id + 名前 / 作成 + 更新 / 概要 を出す（形は問わない。P1）',
    async (name) => {
      const h = await flooded(60);

      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(fiveFieldViolations(entry)).toEqual([]);
      }
    },
  );

  /**
   * **`self_status` の P1 は `FIVE_FIELD_SWEPT` の `it.each` に混ぜない。**
   * `FIVE_FIELD_SWEPT` は `SWEPT`（`_list` で終わる名前の機械的な集合）から
   * 作られていて、`self_status` はそこに入らない（`_list` で終わらない）。
   * ここに手で名前を足すと、`SWEPT` の総当たりという性質が壊れる——だから
   * 別の名指しの `it()` として立てる。
   *
   * **`self_status` は道具全体が一覧ではない。** `describeCloneRuntime` の
   * 出力にも `- ` で始まる行がある（MCP サーバ一覧など）ので、
   * `splitListingEntries(reply)` を丸ごと当てると、一覧でない行まで P1 の
   * 違反として数えてしまう。だから「記憶の大きさ」の節（`## 記憶の大きさ`
   * から次の `## ` の直前まで）だけを切り出してから測る。節の先頭にある
   * `- 総文字数: …` の行は詳細を取りに行く鍵（id）を持たない集計行であって
   * 一覧の1件ではないので、切り出しの中で除く。
   *
   * **⚠️ この切り出しは、節の中身が「集計行1本＋文書1件ずつ」であることに
   * 依存している（#299）。** `self_status` は診断の出力なので節は育つ——
   * この節へ**文書一覧でない `- ` 始まりの行を足すなら、先にこの関数を直す
   * こと。** 足しただけだと、一覧でない行まで1件として数えられ、無関係な
   * 行が `fiveFieldViolations` にかけられて**偽の失敗**になる（黙って通る
   * のではなく、無関係な理由で赤くなる側である）。直し方の案まで #299 に
   * 書いてある。
   */
  function extractMemorySizeEntries(reply: string): string[] {
    const heading = '## 記憶の大きさ';
    const start = reply.indexOf(heading);
    if (start === -1) return [];
    const rest = reply.slice(start);
    // 見出し自身（0文字目）は無視して、次の `## ` を探す。
    const nextHeadingAt = rest.indexOf('\n## ', heading.length);
    const section = nextHeadingAt === -1 ? rest : rest.slice(0, nextHeadingAt);
    return splitListingEntries(section).filter(
      (entry) => !entry.trimStart().startsWith('- 総文字数'),
    );
  }

  it('self_status — 記憶の内訳のどの1件も id + 名前 / 作成 + 更新 / 概要 を出す（P1）', async () => {
    const h = await flooded(60);

    const reply = await h.call('self_status', {});
    const entries = extractMemorySizeEntries(reply);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(fiveFieldViolations(entry)).toEqual([]);
      // **`fiveFieldViolations` の id+名前チェックは形（2トークン在るか）しか
      // 見ない——値が本当に `title` かどうかまでは判定しない。** 変異試験で
      // 確かめた: `renderMemorySize` から `${doc.title}` を丸ごと落としても、
      // 直後の `(作成: …` が2つ目のトークンとして数えられ、上の
      // `fiveFieldViolations` だけでは検出できずに生存した。`flooded()` が
      // 書く記憶は `# 題<pad>` という見出しを持つ（`persona.write` の
      // タイトル抽出）ので、その文字列が実際に出ているかも確かめる——
      // これで `title` を落とす変異が検出できる。
      expect(entry).toMatch(/題\d{4}/);
    }
  });

  /**
   * **`self_status` の記憶内訳は、共通の `TRUNCATION_MARK`（CASES の
   * 「切ったなら黙らない」試験）だけでは、一覧の予算（`renderListing` の
   * `budget` / `omitted`）が効いていることを測れない。**
   *
   * 変異試験で確かめた: `renderMemorySize` の `omitted` を `() => ''` に
   * 差し替えて省略の断り書きを消しても、`flooded()` が書く記憶の
   * `description` は1件ごとに `SELF_STATUS_MEMORY_DESCRIPTION_LIMIT`
   * （120字）を超えるため、`excerptLine` が1件ごとに「…（N 文字省略。全
   * M 文字）」を出し続け、`TRUNCATION_MARK`（`/省略|残り \d|文字目/`）は
   * それだけで満たされてしまう——一覧の側の断り書きが消えたことは、共通の
   * 歯では検出できずに生存した。
   *
   * だから一覧レベルの断り書きの中身（件数と続きの取り方）を直接見る。
   */
  it('self_status — 記憶の内訳を切ったら、件数と続きの取り方（memory_list / memory_read）が出る', async () => {
    const h = await flooded(60);

    const reply = await h.call('self_status', {});

    expect(reply).toMatch(/…ほか \d+ 文書は省略（全 \d+ 文書のうち \d+ 文書だけ出した）。/);
    expect(reply).toContain('memory_list');
    expect(reply).toContain('memory_read slug=<slug>');
  });

  /**
   * **#284: `fiveFieldViolations` の id+名前チェックは「先頭行に非空トークンが
   * 2つ並ぶか」という形しか見ない——2つ目のトークンが本当に `title` かどうかは
   * 見ていない。** `self_status`（上）は #280 でこれを塞いだが、残る4つの
   * `_list`（approvals / schedule / commitment / manager）は塞いでいなかった。
   *
   * **変異試験で確かめた**（`packages/core/src/tools.ts` の呼び出し側、
   * `title:` に渡す式を、同じ `renderListingEntry` 呼び出しの中で既に使っている
   * 別の値——`entry.id` 相当——へ丸ごと差し替える変異）。2トークンの形は保たれる
   * ので、上の P1（id+名前チェック）・下の P2（`matchesStrictBlockShape`）の
   * どちらも生存した（4本とも）。**`title` を空文字へ落とす変異は、この4本では
   * 検出できる**（先頭行が `- <id> ` で終わり2つ目のトークンが無くなるため）。
   * 生存するのは「値の置き換え」のほうだけである。
   *
   * だから `self_status` の `題\d{4}`（#280）と同じ手当てを、値の置き換えで
   * 検出できる形で足す。**`flooded()` が積む値のうち、id 側には出ず title 側
   * にだけ出る文字列**を選ぶ:
   *
   * - `approvals_list`: 質問の1行目（`質問${pad}`）がそのまま `approvalTitle`
   *   の出力になる。id（`ap-${pad}`）には出ない
   * - `schedule_list`: `flooded()` は `everyMinutes: 60` で固定するので、
   *   `describeScheduleSpec` の出力は毎回 `60 分ごと`。id（`kind=watch-${pad}`）
   *   には出ない
   * - `commitment_list`: `flooded()` は `commitment_open({ body })` だけを呼ぶので
   *   `origin` は必ず `'self'`（`source` も無い）。`commitmentOriginBadge` の
   *   出力は毎回 `[自分で気づいた宿題]`。id（UUID）には出ない
   * - `manager_list`: `flooded()` は `manager_start` だけを呼ぶので、どの
   *   マネージャーも起動直後の `running`（セッション切断なし）。タイトルは
   *   毎回 `[running]`。id（managerId）には出ない
   *
   * **`memory_list` は別枠にする。** `title` を空へ落とす変異も置き換える変異も
   * どちらも生存した——`memory_list` の1行は `- [kind] slug: title (作成:…) —
   * 概要` という形で、`kindTag`（`[fact] ` 等）と `slug` だけで2トークンの
   * 判定を満たしてしまうため、`title` が空でも置き換わっても崩れない
   * （#264 が自己申告していた弱さと同じ形）。
   */
  const TITLE_IS_REAL_CONTENT_CASES: {
    name: string;
    check: (firstLine: string) => void;
  }[] = [
    {
      name: 'approvals_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に質問の1行目が無い: ${firstLine}`).toMatch(/^- \S+ 質問\d{4}/),
    },
    {
      name: 'schedule_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に周期の説明（60 分ごと）が無い: ${firstLine}`).toContain(
          '60 分ごと',
        ),
    },
    {
      name: 'commitment_list',
      check: (firstLine) =>
        expect(
          firstLine,
          `id の隣に出所の札（[自分で気づいた宿題]）が無い: ${firstLine}`,
        ).toContain('[自分で気づいた宿題]'),
    },
    {
      name: 'manager_list',
      check: (firstLine) =>
        expect(firstLine, `id の隣に状態の札（[running]）が無い: ${firstLine}`).toContain(
          '[running]',
        ),
    },
  ];

  it.each(TITLE_IS_REAL_CONTENT_CASES)(
    '$name — id の隣は id そのものではなく、その一覧固有のタイトルである（#284）',
    async ({ name, check }) => {
      const h = await flooded(60);
      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        check(entry.split('\n')[0] ?? '');
      }
    },
  );

  it('memory_list — タイトルは id や slug の繰り返しではなく、記憶の見出しである（#284）', async () => {
    const h = await flooded(60);

    const reply = await h.call('memory_list', {});
    const entries = splitListingEntries(reply);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      // flooded() が書く記憶は `# 題<pad>` という見出しを持つ（persona.write の
      // タイトル抽出）。self_status の同種の歯（#280、題\d{4}）と同じ実測を
      // memory_list 自身（renderMemoryListing）にも足す——self_status の歯は
      // renderMemorySize（tools.ts）を測るだけで、renderMemoryListing
      // （memory.ts）は測っていない。
      expect(entry, `記憶の見出し（題NNNN）が出ていない: ${entry}`).toMatch(/題\d{4}/);
    }
  });

  /**
   * **タイトルの歯（`TITLE_IS_REAL_CONTENT_CASES` と、直上の `memory_list`
   * 名指しの `it()`）が `FIVE_FIELD_SWEPT` を漏れなく覆っていることを測る歯。**
   *
   * 上の2つはどちらも手で書いた名前の表である——タイトルの実測（何を
   * `check` するか）そのものは一覧ごとに固有で、機械的には作れない。
   * けれど「表が抜けている」ことは測れる。`CLONE_TOOL_NAMES` に新しい
   * `_list` が足されたとき、件数の歯（`CASES`）や P1/P2 の歯
   * （`FIVE_FIELD_SWEPT` / `STRICT_SHAPE_SWEPT`）は `SWEPT` から機械的に
   * 作り直されるので新顔を自動的に捕まえるが、**タイトルの表だけは
   * 足し忘れても何も落ちない**まま静かに通ってしまう。
   *
   * 直上の「P1/P2 それぞれの網が空にならず、除外は実在する道具を指している」
   * （`AXIS_UNDECIDED` / `SHAPE_DIFFERENT` の自己測定）と同じ形にする——
   * 除外を作るなら理由の文字列を持たせ、その除外が実在する道具を指している
   * ことも測る。
   */
  const TITLE_CHECK_NAMES = new Set<string>([
    ...TITLE_IS_REAL_CONTENT_CASES.map((c) => c.name),
    'memory_list',
  ]);

  /**
   * タイトルの歯を意図的に足さないと決めたもの。**いまは空。**
   * `FIVE_FIELD_SWEPT` の全件が `TITLE_CHECK_NAMES` で覆われているため。
   * ここへ足すときは `AXIS_UNDECIDED` / `SHAPE_DIFFERENT` と同じく理由の
   * 文字列を添えること——散文の理由だけを書いて自己測定を伴わないと、
   * 「#220 待ち」がマージ後も残ったのと同じ形で嘘になる（直上のコメント）。
   */
  const TITLE_CHECK_EXCLUDED = new Map<string, string>([]);

  it('タイトルの歯が FIVE_FIELD_SWEPT を漏れなく覆っている（新しい _list の足し忘れを検出する）', () => {
    // 除外の綴りが違えば、除外は効かないまま「除外したつもり」になる。
    for (const name of TITLE_CHECK_EXCLUDED.keys()) {
      expect(SWEPT, `除外 ${name} が実在する道具を指していない`).toContain(name);
    }

    // FIVE_FIELD_SWEPT のうち、TITLE_CHECK_NAMES にも TITLE_CHECK_EXCLUDED
    // にも入っていない名前 = タイトルの歯が無いまま網の外へ落ちているもの。
    const uncovered = FIVE_FIELD_SWEPT.filter(
      (name) => !TITLE_CHECK_NAMES.has(name) && !TITLE_CHECK_EXCLUDED.has(name),
    );
    expect(
      uncovered,
      'タイトルの歯（TITLE_IS_REAL_CONTENT_CASES への追加 / memory_list のような ' +
        '名指しの it() / 理由つきの TITLE_CHECK_EXCLUDED のいずれか）が無い一覧: ' +
        `${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it.each(STRICT_SHAPE_SWEPT)(
    '%s — どの1件も id + 名前 / 作成 + 更新 / 概要 を決まった順で出す（P2）',
    async (name) => {
      const h = await flooded(60);

      const reply = await h.call(name, {});
      const lines = reply.split('\n');
      // 省略の断り書きは `- ` で始まらない（`renderListing` がそのまま積む）ので、
      // `- ` で始まる行は必ず1件の先頭行である。
      const heads = lines.filter((line) => line.startsWith('- '));
      expect(heads.length).toBeGreaterThan(0);

      for (const [index, line] of lines.entries()) {
        if (!line.startsWith('- ')) continue;
        // id と名前。**名前が空だと `- <id> ` で終わるので \\S を要求する。**
        expect(line).toMatch(/^- \S+ \S/);
        // 作成と更新は必ず2行目、必ずこの並び。**位置まで固定する** —
        // どこかに在ればよいことにすると、一覧ごとにばらばらな位置へ戻る。
        expect(lines[index + 1]).toMatch(
          /^ {2}作成: \d{4}-\d{2}-\d{2}T[\d:.]+Z \/ 更新: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
        );
        // 概要は3行目。空行でないこと。
        expect(lines[index + 2]).toMatch(/^ {2}\S/);
      }
    },
  );

  /**
   * **除外そのものを測る歯。** 散文の理由は書いた時点で凍る——実際に
   * 「#220 待ち」という `memory_list` の除外理由は、#220 がマージされた
   * 瞬間に嘘になり、何も落ちなかった。だから除外を自己測定にする:
   *
   * - `AXIS_UNDECIDED` の各件は、**いまも P1 を満たさないこと。** 満たす
   *   ようになったら、この歯が赤くなって「除外を外せ」と言う
   * - `SHAPE_DIFFERENT` の各件は、**P1 を満たし、かつ P2 を満たさないこと。**
   *   形を寄せたら P2 側の assert が赤くなって除外を外させる
   */
  it.each([...AXIS_UNDECIDED.keys()])(
    '%s は除外の理由どおり、いまも P1 を満たさない（満たしたら除外を外す番）',
    async (name) => {
      const h = await flooded(60);
      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      const anyViolation = entries.some((entry) => fiveFieldViolations(entry).length > 0);
      expect(anyViolation).toBe(true);
    },
  );

  it.each([...SHAPE_DIFFERENT.keys()])(
    '%s は P1 を満たし、P2 は満たさない（形が違うのは設計であることの実測）',
    async (name) => {
      const h = await flooded(60);
      const reply = await h.call(name, {});
      const entries = splitListingEntries(reply);
      expect(entries.length).toBeGreaterThan(0);

      // P1: 満たす。
      for (const entry of entries) {
        expect(fiveFieldViolations(entry)).toEqual([]);
      }
      // P2: 満たさない（少なくとも1件は厳密な3行ブロックの形にならない）。
      const anyShapeMismatch = entries.some((entry) => !matchesStrictBlockShape(entry));
      expect(anyShapeMismatch).toBe(true);
    },
  );

  it('積んだ器が本当に溢れる量を持っている（上限を外すと落ちること）', async () => {
    const h = await flooded(60);

    // **この試験の前提そのものを測る。** 積んだ量が上限より小さいと、
    // 上の2本は「上限が効いた」のではなく「そもそも短かった」で通る。
    // 生データの側が `OUTPUT_CAP` を大きく超えていることを、一覧を通さずに確かめる。
    const approvals = await h.stores.jobs.listApprovals({ pendingOnly: true });
    const raw = approvals.map((a) => a.question).join('\n');
    expect(raw.length).toBeGreaterThan(OUTPUT_CAP * 4);
  });

  /**
   * **概要の判定が「何か書いてあるか」だけの緩い歯になっていないことの確認。**
   *
   * `hasSummaryBeyondTimestamps` はタイトルを取り除かずに判定するので、
   * `memory_list` の1行1件という形の中で「タイトルの残り香」を概要と
   * 誤認しないかを、概要が本当に無い記憶（frontmatter に `description` が
   * 無い）で確かめる。
   */
  it('memory_list で概要が無い記憶は、概要の不在として検出される（歯が緩んでいないことの確認）', async () => {
    const h = harness();
    await h.stores.persona.write(
      'doc-a',
      '---\ndescription: これは要旨である\ntype: fact\n---\n# 題A\n\n本文A',
    );
    // frontmatter に description を持たない記憶。
    await h.stores.persona.write('doc-b', '---\ntype: premise\n---\n# 題B\n\n本文B');

    const reply = await h.call('memory_list', {});
    const entries = splitListingEntries(reply);
    expect(entries.length).toBe(2);

    const withDescription = entries.find((entry) => entry.includes('doc-a'))!;
    const withoutDescription = entries.find((entry) => entry.includes('doc-b'))!;
    expect(fiveFieldViolations(withDescription)).toEqual([]);
    expect(fiveFieldViolations(withoutDescription)).toContain(
      '概要 が無い（作成/更新を除いても本文が残らない）',
    );
  });
});

/**
 * **詳細側 — 一覧を抜粋にした以上、全文への行き先が要る。**
 *
 * 人間は Web UI で全部読める。クローンだけが「抜粋しか読めない」なら、
 * それは能力の削除である（north_star 禁止1）。だから一覧を締めるときは、
 * 必ず同じ PR で全文の口を用意する。
 *
 * そして全文の口は**分けて渡す**（切って捨てるのではない）。ここで測るのは
 * 「続きが取れること」と「切れていることが分かること」の2つで、
 * **別々の `it()` にしてある** — 片方が通ったらもう片方も通ったように
 * 見える形にすると、どちらが壊れたのか分からなくなる。
 */
describe('一覧を抜粋にしたものには、全文の行き先がある', () => {
  it('approvals_list id=<id> で質問の全文が取れる', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: `頭${'あ'.repeat(400)}尻`,
      context: '背景の説明',
    });

    const listing = await h.call('approvals_list', {});
    const full = await h.call('approvals_list', { id: 'ap-1' });

    // 一覧は抜粋（末尾まで出ない）
    expect(listing).not.toContain('尻');
    // 全文は末尾まで出る
    expect(full).toContain('尻');
    expect(full).toContain('背景の説明');
  });

  it('approvals_list は回答が付いた件も id で読める（一覧からは消えていても）', async () => {
    // 「もう答えが来た」と「その質問が何だったか」は別の問いで、
    // 後者は答えが付いた後にこそ要る。
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-done',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '本番に出してよいか',
      answeredAt: '2026-01-01T01:00:00.000Z',
      answer: 'よい',
    });

    expect(await h.call('approvals_list', {})).not.toContain('本番に出してよいか');

    const full = await h.call('approvals_list', { id: 'ap-done' });
    expect(full).toContain('本番に出してよいか');
    expect(full).toContain('よい');
    expect(full).toContain('回答済み');
  });

  it('approvals_list の全文が長ければ、続きの取り方が出力に出る', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-long',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: 'あ'.repeat(9_000),
    });

    const reply = await h.call('approvals_list', { id: 'ap-long' });

    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
    expect(reply).toMatch(/文字目/);
  });

  it('schedule_list kind=<kind> で依頼本文の全文が取れる', async () => {
    const h = harness();
    await h.call('schedule_create', {
      kind: 'watch',
      request: `頭${'あ'.repeat(400)}尻`,
      everyMinutes: 60,
    });

    const listing = await h.call('schedule_list', {});
    const full = await h.call('schedule_list', { kind: 'watch' });

    expect(listing).not.toContain('尻');
    expect(full).toContain('尻');
  });

  it('memory_read は長ければ切れて、続きの取り方が出力に出る', async () => {
    const h = harness();
    await h.stores.persona.write('big', `# 題\n\n${'あ'.repeat(9_000)}`);

    const reply = await h.call('memory_read', { slug: 'big' });

    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('memory_read');
    expect(reply).toContain('offset');
  });

  it('memory_read は offset で続きが取れる（分けて渡せば全部届く）', async () => {
    const h = harness();
    await h.stores.persona.write('big', `${'あ'.repeat(9_000)}しっぽ`);

    const first = await h.call('memory_read', { slug: 'big' });
    const second = await h.call('memory_read', { slug: 'big', offset: 8_000 });

    expect(first).not.toContain('しっぽ');
    expect(second).toContain('しっぽ');
  });

  it('memory_read は切れていないとき注記を出さない（目印を効かせるため）', async () => {
    const h = harness();
    await h.stores.persona.write('small', '# 題\n\n短い本文');

    const reply = await h.call('memory_read', { slug: 'small' });

    expect(reply).toBe('# 題\n\n短い本文');
  });

  it('self_read は長い正典を切って返し、続きの取り方を示す', async () => {
    const h = harness();

    // `docs/architecture.md` は着手時点で 48,856 バイトある。
    const reply = await h.call('self_read', { document: 'architecture' });

    expect(reply.length).toBeLessThan(12_000);
    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('self_read');
    expect(reply).toContain('offset');
  });

  it('self_read は offset で続きが取れる', async () => {
    const h = harness();

    const first = await h.call('self_read', { document: 'architecture' });
    const second = await h.call('self_read', { document: 'architecture', offset: 8_000 });

    expect(second).not.toBe(first);
    expect(second).toMatch(/文字目/);
  });

  it('profile_read が切れるときは、全文置換の危険まで言う', async () => {
    // `profile_write` は全文置換である。切れた本文をそのまま書き戻すと
    // 残りが黙って消える——しかも切れた shell も妥当に見えるので検証を通る。
    const h = harness();
    await h.call('profile_write', { script: `export A=1\n${'# 埋め草\n'.repeat(1_500)}` });

    const reply = await h.call('profile_read', {});

    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
    expect(reply).toContain('全文置換');
  });
});

describe('commitment_list を文字数の予算へ寄せる（潜在バグの修正）', () => {
  it('commitment_list は件数ではなく文字数の予算で切る（30件を下回っていても長い本文なら切れる）', async () => {
    // **回帰の歯。** かつては `COMMITMENT_LIST_LIMIT = 30` という件数の
    // 上限で切っていたので、30件を下回るここでは全件がそのまま出てしまい
    // 一覧レベルの「省略」の合図は出なかった。いまは `COMMITMENT_LIST_BUDGET`
    // （文字数）で切るので、件数が30を下回っていても長い本文が積み重なれば
    // 切れる。この歯は「件数の上限に戻す」変異を落とす。
    //
    // **足場は十分に大きくすること。** 薄い足場だと予算が拘束条件にならず、
    // 変異が生き残る（`.claude/skills/listing-and-detail/SKILL.md` の
    // `runner_list` の例と同じ形）。1件500字の本文を25件（かつての件数
    // 上限30を下回る数）積んでも、実測で切れることを確かめてある。
    const h = harness();
    const long = 'あ'.repeat(500);
    for (let index = 0; index < 25; index += 1) {
      await h.call('commitment_open', { body: `約束${String(index).padStart(3, '0')}: ${long}` });
    }

    const reply = await h.call('commitment_list', {});

    // **`/省略/` だけでは弱い。** 1件の本文（500字超）は `COMMITMENT_BODY_LIMIT`
    // （240字）の抜粋でも「…（270 文字省略。全 510 文字）」のように「省略」を
    // 含む——これは一覧レベルの打ち切りとは無関係に、本文が長いだけで
    // 毎回出る。予算で列自体が切れたことを見るには、一覧の断り書きの形
    // （`…ほか N 件は省略`）で狙う必要がある。実際にこの弱い形で変異試験を
    // 通したところ、予算判定そのものを外す変異（budget を巨大な値にする）が
    // 生き残った——「1件の本文が長い」ことと「一覧が予算で切れた」ことは
    // 別の観測で、前者だけを見ても後者は測れない。
    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    // 25件全部を対象に打ち切ったことも見る（一部だけを積んで拾えた偶然ではない）。
    expect(reply).toContain('未了は 25 件あり');
    // 25件ぶんの本文（1件あたり500字超）を全部出せば優に12,000字を超える。
    // 予算（8,000）＋断り書きぶんの余裕を見ても、それよりは十分小さい。
    expect(reply.length).toBeLessThan(9_000);
  });

  it('commitment_list は includeClosed:true でも、省略の断り書きで片付いた分を未了と偽らない', async () => {
    // **回帰の歯。** `total`（全件数）をそのまま「未了は N 件」と言うと、
    // `includeClosed: true` のときは片付いた分まで未了として数えた嘘に
    // なる（数が大きく出る方向の嘘）。open と closed を両方積み、予算で
    // 切れるところまで足場を大きくする（切れなければ `omitted` は呼ばれない
    // ので、何も測れない——実測で total=30・shown=23 まで切れることを
    // 確かめてある）。
    const h = harness();
    const long = 'あ'.repeat(500);
    const openCount = 15;
    const closedCount = 15;
    for (let index = 0; index < openCount; index += 1) {
      await h.stores.commitments.open({
        id: `open-${index}`,
        at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `未了${String(index).padStart(3, '0')}: ${long}`,
      });
    }
    for (let index = 0; index < closedCount; index += 1) {
      const id = `closed-${index}`;
      await h.stores.commitments.open({
        id,
        at: `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`,
        origin: 'self',
        body: `片付いた${String(index).padStart(3, '0')}: ${long}`,
      });
      await h.stores.commitments.close(
        id,
        `2026-01-03T00:00:${String(index).padStart(2, '0')}.000Z`,
        '対応済み',
        'clone',
      );
    }
    const total = openCount + closedCount;

    const reply = await h.call('commitment_list', { includeClosed: true });

    // 予算で実際に切れたこと（そうでなければ omitted は呼ばれておらず、
    // 下の2本の assert はどちらも何も測っていない）。
    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    // 片付いた分を含めた総数を「未了は」と偽らずに言う。
    expect(reply).toContain(`片付けた分を含めて ${total} 件あり`);
    expect(reply).not.toContain(`未了は ${total} 件あり`);
  });
});

/**
 * issue #296（SPEC 5節）。`CommitmentStore.list` の返りが `{ entries,
 * unreadable }` になったので、`commitment_list` ツールの一覧末尾に
 * 「読めない行が N 件」が必ず出ることを固定する——**ここが落ちると、
 * Issue の doc が守ろうとしたもの（クローンから読めない行の存在が
 * 見える）が守れない。**
 *
 * `createMemoryStores()` は読めない行を作れない（`testing.ts` の doc）ので、
 * `stores.commitments.list` を差し替えて模す（`commitment.test.ts` の
 * 「台帳が読めなくてもターンは進む」テストと同じ作法）。
 */
describe('commitment_list は読めない行を隠さない（issue #296）', () => {
  it('一覧の末尾に「読めない行が N 件」が id 付きで出る（読める行が0件でも「無い」とは誤読しない）', async () => {
    const stores = createMemoryStores();
    const withUnreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list(options) {
          const base = await stores.commitments.list(options);
          return {
            entries: base.entries,
            unreadable: [
              { id: 'c-broken-1', at: '2026-08-01T00:00:00.000Z', reason: '型が合わない' },
            ],
          };
        },
      },
    };
    const tools = createCloneTools({ stores: withUnreadable, emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'commitment_list');

    // 読める行が0件の状態でも、読めない行だけで断りが出ること
    // （「無い」＝空配列と誤読しない。`entries.length === 0 && unreadable.length
    // === 0` のときだけ早期リターンする、という分岐そのものを問う）。
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(reply).toContain('読めない行が 1 件ある');
    expect(reply).toContain('c-broken-1');
    expect(reply).toContain('片付いたのではない');

    // 読める行が1件も無いことも明言していること（`（引き受けたまま終わって
    // いない仕事は無い）` という「0件」の文言とは別の文言に倒れていること）。
    expect(reply).not.toBe('（引き受けたまま終わっていない仕事は無い）');
  });

  it('0件のときは断りを足さない', async () => {
    const tools = createCloneTools({ stores: createMemoryStores(), emit: () => undefined });
    const opened = tools.find((entry) => entry.name === 'commitment_open');
    await opened?.handler({ body: '健全な依頼' } as never, {});

    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(reply).not.toContain('読めない行');
  });

  it('id が取れない行は件数だけに数える（id: の並びに出ない）', async () => {
    const stores = createMemoryStores();
    const withUnreadable: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async list() {
          return {
            entries: [],
            unreadable: [
              { id: 'c-broken-1', reason: '型が合わない' },
              // id が取れない行（fs 版で本体が id を持たない生の値のとき）。
              { reason: 'id も取れない行' },
            ],
          };
        },
      },
    };
    const tools = createCloneTools({ stores: withUnreadable, emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    const result = await found?.handler({} as never, {});
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    // 件数は2件（id の有無に関わらず数える）。
    expect(reply).toContain('読めない行が 2 件ある');
    // id が取れた分だけが (id: ...) に出る。
    expect(reply).toContain('（id: c-broken-1）');
  });
});

/**
 * #215（一覧の第2弾）。人間の依頼の逐語は「一覧系ツールは最低でも
 * id + 名前 + 概要 + updated_at + created_at が欲しい」で、`manager_list` /
 * `schedule_list`（#208）に続いてこの2つへ同じ形を入れた。
 *
 * **札は「概要の先頭 n 文字」ではない。** 一覧を目で走らせるとき最初に知りたい
 * ものを置く——`commitment` は**出所と種別**（人間が頼んだ件か、自分で気づいた
 * 宿題か）、`approval` は**質問の1行目**である。
 *
 * **更新の定義は「この1件が最後に変わった時刻」。** まだ一度も変わっていない
 * レコードでは作成と一致するが、それは値を捏造しているのではなく観測そのもの
 * である（AGENTS.md「取れない軸に0の行を作らない」に触れないのはこのため——
 * 軸は在って、値がまだ動いていないだけである）。
 */
describe('commitment_list / approvals_list に札と作成・更新を足す（#215）', () => {
  it('commitment_list の札は origin 4種を撃ち分ける', async () => {
    // **1種類だけでは、写像が恒等でも定数でも通ってしまう。** 4種すべてを
    // 積んで、4つとも違う札が出ることを見る（`COMMITMENT_ORIGIN_LABEL` の
    // どの1行を書き換えても落ちる）。
    const h = harness();
    const origins = [
      { id: 'c-human', origin: 'human', label: '人間の依頼' },
      { id: 'c-manager', origin: 'manager', label: 'マネージャーの報告' },
      { id: 'c-external', origin: 'external', label: '外部イベント' },
      { id: 'c-self', origin: 'self', label: '自分で気づいた宿題' },
    ] as const;
    for (const [index, entry] of origins.entries()) {
      await h.stores.commitments.open({
        id: entry.id,
        at: `2026-01-0${index + 1}T00:00:00.000Z`,
        origin: entry.origin,
        body: `本文${entry.id}`,
      });
    }

    const reply = await h.call('commitment_list', {});
    const lines = reply.split('\n');

    for (const entry of origins) {
      // 札は先頭行の、id の隣。位置まで固定する（別の行へ落ちたら落とす）。
      expect(lines).toContain(`- ${entry.id} [${entry.label}]`);
    }
  });

  it('commitment_list の札は source が在れば添え、無ければ付けない', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-with-source',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-9',
      body: '報告が来た',
    });
    await h.stores.commitments.open({
      id: 'c-no-source',
      at: '2026-01-02T00:00:00.000Z',
      origin: 'manager',
      body: '出所の細目は無い',
    });

    const lines = (await h.call('commitment_list', {})).split('\n');

    // 同じ origin の2件を並べているので、違いは source の有無だけになる。
    expect(lines).toContain('- c-with-source [マネージャーの報告 / mgr-9]');
    expect(lines).toContain('- c-no-source [マネージャーの報告]');
  });

  it('commitment_list の作成は at・更新は closedAt ?? at（同じ行に並ぶので入れ替わりも落ちる）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-open',
      at: '2026-02-01T00:00:00.000Z',
      origin: 'external',
      body: '未了のまま',
    });
    await h.stores.commitments.open({
      id: 'c-closed',
      at: '2026-02-02T00:00:00.000Z',
      origin: 'manager',
      body: '片付いた',
    });
    await h.stores.commitments.close('c-closed', '2026-02-03T00:00:00.000Z', '対応済み', 'clone');

    const lines = (await h.call('commitment_list', { includeClosed: true })).split('\n');

    // 未了は「まだ一度も変わっていない」ので作成と更新が一致する。
    expect(lines).toContain('  作成: 2026-02-01T00:00:00.000Z / 更新: 2026-02-01T00:00:00.000Z');
    // 片付いた分は closedAt が更新になる。**3つの時刻を全部違う日付にしてある**
    // ので、作成と更新を取り違えても、片方をもう片方で埋めても落ちる。
    expect(lines).toContain('  作成: 2026-02-02T00:00:00.000Z / 更新: 2026-02-03T00:00:00.000Z');
  });

  it('approvals_list の札は質問の1行目だけで、2行目は混ざらない', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-multiline',
      createdAt: '2026-03-01T00:00:00.000Z',
      question: '本番へ出してよいか\n影響範囲: 全ユーザー',
    });

    const reply = await h.call('approvals_list', {});
    const titleLine = reply.split('\n').find((line) => line.startsWith('- ap-multiline'));

    expect(titleLine).toBe('- ap-multiline 本番へ出してよいか');
    // **2行目は落としていない。** 札に混ざらないだけで、概要の行には出る
    // （札を1行目で切るのが能力の削除にならないのはこのため）。
    expect(reply).toContain('影響範囲: 全ユーザー');
  });

  it('approvals_list の札は、質問が改行で始まっても空にならない', async () => {
    // 1行目が空だと札が消える。空欄は「名前が無い」のか「取り忘れ」なのか
    // 区別できないので、そのときだけ全体を潰した抜粋へ落とす。
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-leading-newline',
      createdAt: '2026-03-02T00:00:00.000Z',
      question: '\n先頭が改行の質問',
    });

    const titleLine = (await h.call('approvals_list', {}))
      .split('\n')
      .find((line) => line.startsWith('- ap-leading-newline'));

    expect(titleLine).toBe('- ap-leading-newline 先頭が改行の質問');
  });

  it('approvals_list は作成と更新を出す（回答待ちだけの一覧なので両方が一致する）', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-04-01T00:00:00.000Z',
      question: '続けてよいか',
    });

    const reply = await h.call('approvals_list', {});

    expect(reply.split('\n')).toContain(
      '  作成: 2026-04-01T00:00:00.000Z / 更新: 2026-04-01T00:00:00.000Z',
    );
    // **一致していることを「値が無い」と読ませない。** 欄の意味を出力自身が言う。
    expect(reply).toContain('更新＝この1件が最後に変わった時刻');
  });
});

/**
 * #218（`commitment_list` に詳細の口が無い）。
 *
 * **一覧を抜粋にしたなら、同じ PR で全文の口を用意すること**が
 * `.claude/skills/listing-and-detail/SKILL.md`「3. 詳細の口」の要求である。
 * 人間は Web UI（`apps/web/app/routes/commitments.tsx`）で `closedReason` を
 * 全文で読めるのに、クローンは一覧の120字抜粋で止まっていた——**同じものを
 * 人間だけが全部読める形は能力の削除である**（north_star 禁止1）。
 *
 * 形は「1つの道具＋引数でモード切替」（`approvals_list id=<id>` と同型）。
 * 道具を1本増やさないので `CLONE_TOOL_NAMES` と外向きの面は変わらない。
 */
describe('commitment_list id=<id> で1件の全文が取れる（#218）', () => {
  it('片付いた1件を id で読むと closedReason が全文で出る（一覧は120字で止まる）', async () => {
    // **これがこの PR の本体である。** `closedReason` の doc は逐語で
    // 「『閉じた』だけを残さない。人間が後から否定できることが最終承認の実体で
    // あり、何をもって終わりとしたのかが無いと否定のしようがない」と言う。
    // 抜粋しか読めないなら、その設計は抜粋の分しか生きていない。
    const h = harness();
    // 一覧側の抜粋（120字）より確実に長く、末尾に目印を置く。
    const reason = `頭${'り'.repeat(300)}尻`;
    await h.stores.commitments.open({
      id: 'c-closed',
      at: '2026-05-01T00:00:00.000Z',
      origin: 'human',
      source: 'conv-7',
      body: '本番リリースを確認する',
    });
    await h.stores.commitments.close('c-closed', '2026-05-02T00:00:00.000Z', reason, 'clone');

    const listing = await h.call('commitment_list', { includeClosed: true });
    const detail = await h.call('commitment_list', { id: 'c-closed' });

    // 一覧は抜粋（末尾まで出ない）。
    expect(listing).not.toContain('尻');
    // 詳細は末尾まで出る。
    expect(detail).toContain('尻');
    expect(detail).toContain(reason);
    expect(detail).toContain('2026-05-02T00:00:00.000Z');
  });

  it('未了の1件を id で読むと本文が全文で出る（一覧は240字で止まる）', async () => {
    const h = harness();
    const body = `頭${'ほ'.repeat(600)}尻`;
    await h.stores.commitments.open({
      id: 'c-open',
      at: '2026-05-03T00:00:00.000Z',
      origin: 'self',
      body,
    });

    const listing = await h.call('commitment_list', {});
    const detail = await h.call('commitment_list', { id: 'c-open' });

    expect(listing).not.toContain('尻');
    expect(detail).toContain(body);
    expect(detail).toContain('状態: 未了');
  });

  it('id で名指しすれば includeClosed 無しでも片付いた件が読める', async () => {
    // **追加の引数を要求しない。** id で名指ししている以上、その1件を見たい
    // ことは明らかである。`includeClosed` を要ると、いちばん読みたい側
    // （片付いた件の理由）が二段構えになる。
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-done',
      at: '2026-05-04T00:00:00.000Z',
      origin: 'manager',
      body: '報告を受けた件',
    });
    await h.stores.commitments.close(
      'c-done',
      '2026-05-05T00:00:00.000Z',
      '差し戻して直した',
      'clone',
    );

    // 一覧の既定（未了だけ）からは消えている。
    expect(await h.call('commitment_list', {})).not.toContain('c-done');
    // それでも id では読める。
    const detail = await h.call('commitment_list', { id: 'c-done' });
    expect(detail).toContain('差し戻して直した');
  });

  it('無い id は「無い」と分かる形で返る（黙って空を返さない）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-real',
      at: '2026-05-06T00:00:00.000Z',
      origin: 'self',
      body: '実在する件',
    });

    const reply = await h.call('commitment_list', { id: 'c-typo' });

    expect(reply).toContain('c-typo');
    expect(reply).toContain('無い');
    // 実在する件の本文を混ぜて返さない（一覧へフォールバックしていない）。
    expect(reply).not.toContain('実在する件');
  });

  it('片付けた理由は、本文が1ページを超えても最初の呼びで出る', async () => {
    // **`body` は要約を禁じられた欄なので構造的に長くなりうる。** 理由を本文の
    // 後ろに置くと `page()` の2ページ目へ落ちて、いちばん要る1行が最初の呼びで
    // 出てこない。**この歯は「読み順どおりに並べ替える」変更を落とす。**
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-huge',
      at: '2026-05-07T00:00:00.000Z',
      origin: 'external',
      body: 'ぬ'.repeat(20_000),
    });
    await h.stores.commitments.close(
      'c-huge',
      '2026-05-08T00:00:00.000Z',
      '外部側で解決した',
      'clone',
    );

    const first = await h.call('commitment_list', { id: 'c-huge' });

    // 1ページ目に理由が在る（offset を送らずに読める）。
    expect(first).toContain('外部側で解決した');
    // そして本文は切れていて、続きの取り方が出ている。
    expect(first).toContain('ここで切れている');
    expect(first).toContain('offset');
  });

  it('全文が長ければ offset で続きが取れる（切って捨てていない）', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-long',
      at: '2026-05-09T00:00:00.000Z',
      origin: 'self',
      body: `頭${'ら'.repeat(20_000)}尻`,
    });

    const first = await h.call('commitment_list', { id: 'c-long' });
    const offset = Number(/offset=(\d+)/.exec(first)?.[1]);
    expect(Number.isFinite(offset)).toBe(true);

    // **末尾へ到達できること。** 1回で届かないだけで、全部は届く。
    let reply = first;
    let cursor = offset;
    for (let guard = 0; guard < 10 && !reply.includes('尻'); guard += 1) {
      reply = await h.call('commitment_list', { id: 'c-long', offset: cursor });
      cursor = Number(/offset=(\d+)/.exec(reply)?.[1] ?? cursor);
    }
    expect(reply).toContain('尻');
  });

  it('一覧が案内する導線は空振りしない（案内どおり呼ぶと全文が返る）', async () => {
    // **無い口を案内するのと、案内した口が空振りするのは、同じだけ嘘である。**
    // 一覧に出ている id をそのまま案内どおりの形で渡して、実際に全文が返ること
    // を見る（別の PR で「日誌に残らない型に journal_read を案内する」形が
    // 入りかけた——案内の文字列だけを見る歯では捕まらない）。
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-guided',
      at: '2026-05-10T00:00:00.000Z',
      origin: 'human',
      source: 'conv-1',
      body: `頭${'わ'.repeat(600)}尻`,
    });

    const listing = await h.call('commitment_list', {});

    // 一覧が「commitment_list id=<id> で取れる」と案内していること。
    expect(listing).toContain('commitment_list id=<id>');
    // 一覧に出ている id を拾い、案内どおりに呼ぶ。
    const id = /^- (\S+) /m.exec(listing)?.[1];
    expect(id).toBe('c-guided');
    const detail = await h.call('commitment_list', { id: id as string });
    expect(detail).toContain('尻');
  });

  it('詳細の口ができても、一覧の既定は未了だけのまま', async () => {
    // 回帰の歯。モード切替を足したときに `list()` の既定を触っていないこと。
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-still-open',
      at: '2026-05-11T00:00:00.000Z',
      origin: 'self',
      body: '未了のまま',
    });
    await h.stores.commitments.open({
      id: 'c-already-closed',
      at: '2026-05-12T00:00:00.000Z',
      origin: 'self',
      body: '片付いた',
    });
    await h.stores.commitments.close(
      'c-already-closed',
      '2026-05-13T00:00:00.000Z',
      '済み',
      'clone',
    );

    const listing = await h.call('commitment_list', {});

    expect(listing).toContain('c-still-open');
    expect(listing).not.toContain('c-already-closed');
  });
});
