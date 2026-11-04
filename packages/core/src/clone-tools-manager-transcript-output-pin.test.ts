import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ManagerPool, ManagerTranscript, RunnerBacklogSnapshot } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `TranscriptPageCache` を、同じ振る舞いのまま「何を呼ばれたか・いま覚えているか」が読める入れ物に差し替える。
// 製品コードは何も変えない（`opsTools` が `new TranscriptPageCache()` で作る1個を、場面ごとに外から観測するだけ）。
const spy = vi.hoisted(() => ({
  instances: [] as Array<{ ops: string[]; readonly holding: boolean; clear(): void }>,
}));

vi.mock('./transcript-page-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transcript-page-cache.js')>();
  class SpyCache extends actual.TranscriptPageCache {
    readonly ops: string[] = [];
    #inSet = false;
    constructor() {
      super();
      spy.instances.push(this);
    }
    override get(key: string): ReturnType<typeof actual.TranscriptPageCache.prototype.get> {
      const found = super.get(key);
      this.ops.push(found === undefined ? 'get:miss' : 'get:hit');
      return found;
    }
    override set(
      key: string,
      snapshot: Parameters<typeof actual.TranscriptPageCache.prototype.set>[1],
    ): void {
      this.ops.push('set');
      this.#inSet = true;
      try {
        super.set(key, snapshot);
      } finally {
        this.#inSet = false;
      }
    }
    override clear(): void {
      if (!this.#inSet) this.ops.push('clear');
      super.clear();
    }
  }
  return { ...actual, TranscriptPageCache: SpyCache };
});

// `manager_transcript` の出力（全文と字数）と、呼んだあとの状態（pool へ何を呼んだか・頁のキャッシュが何を覚えているか）を、
// 場面ごとにコミットした固定値（clone-tools-manager-transcript-output-pin.json）と丸ごと比べる。
// `clone-tools-ops.ts` の `tool('manager_transcript', …)`（約 175 行・入れ子 8 段の式）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・本文・時刻）を固定して毎回同じにする。
// この道具は生ログを読むだけで、書くのは道具の組み立て1回ごとに持つ頁のキャッシュ（`TranscriptPageCache`）だけ。だから出力に加えて次を固定する:
//   - output: 道具の出力の全文と字数（isError も）。読みが例外で落ちた呼びは `THREW: <message>` を全文として固定する
//   - calls: その呼びの間に pool へ呼ばれた口（`transcript(id)` / `runnerIdOf(id)` / `runnerBacklog()`。これ以外の口を呼ぶと偽の pool が例外にする）
//   - cache: その呼びの間のキャッシュの操作（`get:hit|miss`・`set`・`clear`）と、呼ぶ前後で覚えていたか（holding）
//   - writes: キャッシュが呼ぶ前から変わったか（`set` が呼ばれた、または覚えているかが変わった）。各呼びに期待を書き、
//     `none` と書いた呼び（引数の断り・見つからない・読めない・読みの失敗・全文を出した呼びなど）は、`set` が無く覚えているかが同じであることを確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MANAGER_TRANSCRIPT_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-manager-transcript-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-manager-transcript-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、pool・キャッシュの操作のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。呼びごとに `at`（基準からの ms）へ時計を置く
// （指定が無ければ前の呼びの1秒後）。キャッシュの期限（2分）の境目は `at` で作る。キャッシュの本物のタイマーは `unref` で、
// 場面の終わりに `clear()` して残さない。
// 頁の大きさ（`TRANSCRIPT_PAGE` = 8,000 字）は定数なので、頁をまたぐ場面は本文の長さを 7,999 / 8,000 / 8,001 / 16,001 字に作って境目を測る。

type Args = Record<string, unknown>;
type Writes = 'none' | 'some';
type Result = ManagerTranscript | { throws: string };

interface Leg {
  runnerId?: string;
  runnerIdThrows?: string;
  backlog?: RunnerBacklogSnapshot[];
  backlogThrows?: string;
}

interface Step {
  args: Args;
  /** この呼びの前に pool の答えを差し替える（id ごと。`'*'` は既定） */
  results?: Record<string, Result>;
  /** この呼びの前に runner・滞留の答えを差し替える */
  leg?: Leg;
  /** 基準からの ms。省略なら前の呼びの1秒後 */
  at?: number;
  /** 省略なら 'none' */
  writes?: Writes;
}

interface Scenario {
  name: string;
  /** 読み手のための整理。表に出す */
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  /** 偽の pool を付けない（記憶へ移すための内部ターン） */
  noPool?: boolean;
  results?: Record<string, Result>;
  leg?: Leg;
  steps: Step[];
}

const FROZEN = '2026-10-27T02:00:00.000Z';
const FROZEN_MS = Date.parse(FROZEN);
const PIN_URL = new URL('./clone-tools-manager-transcript-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MANAGER_TRANSCRIPT_PIN === '1';
const TTL_MS = 2 * 60_000;

const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');

function ts(minute: number): string {
  return new Date(BASE_MS + minute * 60_000).toISOString();
}

function jl(value: unknown): string {
  return JSON.stringify(value);
}

function a(extra: Args = {}): Args {
  return { managerId: 'mgr-1', ...extra };
}

function body(text: string, archiveId?: string): ManagerTranscript {
  return archiveId === undefined
    ? { kind: 'body', body: text }
    : { kind: 'body', body: text, archiveId };
}

function snap(extra: Partial<RunnerBacklogSnapshot> = {}): RunnerBacklogSnapshot {
  return { runnerId: 'rid-1', pendingEvents: 3, observedAt: '2026-10-01T00:10:00.000Z', ...extra };
}

/** 絞りの各軸を試す本文（14行・末尾に改行）。行ごとの役は下のコメントのとおり */
const FILTER_LINES: string[] = [
  jl({ type: 'system', timestamp: ts(0), subtype: 'init' }), // 1
  jl({ type: 'assistant', timestamp: ts(1), message: { stop_reason: 'tool_use' } }), // 2
  jl({ type: 'user', timestamp: ts(2), message: 'tool_result' }), // 3
  jl({ type: 'assistant', timestamp: ts(3), message: { stop_reason: 'end_turn' } }), // 4
  jl({ type: 'result', timestamp: ts(4) }), // 5
  jl({ type: 'assistant', timestamp: BASE_MS + 5 * 60_000 }), // 6 数値の timestamp（ms）
  jl({ type: 'user', n: 7 }), // 7 timestamp が無い
  jl({ type: 'assistant', timestamp: 'not-a-date' }), // 8 timestamp が日時として読めない
  'plain text line with "stop_reason":"tool_use" in it', // 9 JSON として読めない
  '', // 10 空行（途中の空行は1行として数える）
  '42', // 11 JSON だがオブジェクトでない
  'null', // 12 同上
  jl({ type: 42, timestamp: ts(6) }), // 13 type が文字列でない
  jl({ timestamp: ts(7) }), // 14 type が無い
];
const FILTER_BODY = `${FILTER_LINES.join('\n')}\n`;

/** 頁をまたぐ本文。assistant 40 行（約 10.8k 字）と user 2 行。type=assistant で 8,000 字を越える */
const BIG_BODY = `${Array.from({ length: 42 }, (_, i) =>
  jl({
    type: i < 40 ? 'assistant' : 'user',
    timestamp: ts(i),
    tag: i % 2 === 0 ? 'a' : 'b',
    pad: i < 40 ? 'xxxxxxxxx '.repeat(20) : 'xxxxxxxxx ',
  }),
).join('\n')}\n`;

// 固定値の json に長い `[A-Za-z0-9_./@-]` の連続を作らない: `scripts/agents-md-references.test.ts` の
// `path:行番号` 走査の正規表現（`[A-Za-z0-9_@.][A-Za-z0-9_./@-]*:(\d+)`）は、コロンの無い長い連続に当たると
// 開始位置ごとに末尾まで読み直して二乗の時間がかかる（8,000 字の連続1本で走査が約 1 秒延びる）。空白で 10 字ごとに切る。
const TEN = '012345678 ';
const BODY_8000 = TEN.repeat(800);
const BODY_8001 = `${BODY_8000}Z`;
const BODY_16001 = `${'abcdefghi '.repeat(1600)}!`;
// 7,999 字（'aaaaaaaaa ' を 799 回＝7,990 字 + 'aaaaaaaaa' の 9 字）のあとに補助面の文字
const BODY_ASTRAL = `${'aaaaaaaaa '.repeat(799)}aaaaaaaaa😀tail`;
const SMALL = 'abcdefghij';

/** 絞りを全部付けた引数（BIG_BODY の assistant は 0〜39 分。until=ts(40) は含まない） */
const ALL_AXES = { since: ts(0), until: ts(40), type: 'assistant,user', contains: '"pad"' };

/** 頁送りの前提: 1枚目の絞り込みは assistant 40 行で 8,000 字を越える */
const PAGER = a({ type: 'assistant' });

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-offset',
    group: '引数の検査',
    covers: 'offset の違反（負・小数・NaN・Infinity）。pool へは触らない',
    results: { '*': body(SMALL) },
    steps: [
      { args: a({ offset: -1 }) },
      { args: a({ offset: 1.5 }) },
      { args: a({ offset: Number.NaN }) },
      { args: a({ offset: Number.POSITIVE_INFINITY }) },
      { args: a({ offset: -0.5 }) },
    ],
  },
  {
    name: 'arg-since',
    group: '引数の検査',
    covers: 'since が読めない（言葉・実在しない日付・空・25時・月13）。pool へは触らない',
    results: { '*': body(SMALL) },
    steps: [
      { args: a({ since: 'yesterday' }) },
      { args: a({ since: '2026-02-31' }) },
      { args: a({ since: '' }) },
      { args: a({ since: '2026-10-06T25:00:00Z' }) },
      { args: a({ since: '2026-13-01' }) },
    ],
  },
  {
    name: 'arg-until',
    group: '引数の検査',
    covers: 'until が読めない（since と同じ書き出しで field 名だけ変わる）。pool へは触らない',
    results: { '*': body(SMALL) },
    steps: [{ args: a({ until: 'tomorrow' }) }, { args: a({ until: '2026-02-30T00:00:00Z' }) }],
  },
  {
    name: 'arg-order',
    group: '引数の検査',
    covers:
      '検査の順序: offset → since → until → NO_POOL。後ろが違反でも先の違反を言う。NO_POOL（pool 無し）より引数の断りが先',
    noPool: true,
    steps: [
      { args: a({ offset: -1, since: 'x', until: 'y' }) },
      { args: a({ since: 'x', until: 'y' }) },
      { args: a({ since: '2026-10-01', until: 'y' }) },
      { args: a({ since: '2026-10-01', until: '2026-10-02' }) },
      { args: a({ offset: 5 }) },
      { args: a({ type: 'assistant', contains: 'x' }) },
    ],
  },
  {
    name: 'arg-order-with-pool',
    group: '引数の検査',
    covers:
      'pool がある場合も、引数の断りは pool を呼ぶ前（calls が空）。時刻が読める形（日付・時差・Z）は通る',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a({ offset: -1, since: 'x' }) },
      { args: a({ since: '2026-10-01', until: 'y' }) },
      { args: a({ since: '2026-10-01', until: '2026-10-02' }) },
      { args: a({ since: '2026-10-01T09:01:00+09:00', until: '2026-10-01T00:03:00Z' }) },
    ],
  },
  {
    name: 'no-pool',
    group: '引数の検査',
    covers: 'pool が無い（NO_POOL）。絞りを付けても同じ。キャッシュにも触らない',
    noPool: true,
    steps: [{ args: a() }, { args: a({ type: 'assistant', offset: 10 }) }],
  },

  // ---- 見つからない・空・読めない ----
  {
    name: 'missing-no-runner',
    group: '見つからない・空',
    covers:
      'missing: 3段のどこにも無い。runner が割り当てられた記録が無い（runnerIdOf が undefined）',
    results: { '*': { kind: 'missing' } },
    steps: [
      { args: a() },
      { args: a({ offset: 5 }) },
      { args: a({ type: 'assistant', since: '2026-10-01' }) },
    ],
  },
  {
    name: 'missing-leg',
    group: '見つからない・空',
    covers:
      'missing: runner は在る。滞留の観測が無い／別の runner の分だけ／0件／あり（入れ替わった・脚が繋がっている（最後のバイトあり・なし）・down（詳細あり・なし）・一度も繋がっていない・脚の状態を報告しない）',
    results: { '*': { kind: 'missing' } },
    leg: { runnerId: 'rid-1', backlog: [] },
    steps: [
      { args: a() },
      { args: a(), leg: { runnerId: 'rid-1', backlog: [snap({ runnerId: 'rid-other' })] } },
      { args: a(), leg: { runnerId: 'rid-1', backlog: [snap({ pendingEvents: 0 })] } },
      {
        args: a(),
        leg: { runnerId: 'rid-1', backlog: [snap({ instanceSwapped: true, pendingEvents: 5 })] },
      },
      {
        args: a(),
        leg: {
          runnerId: 'rid-1',
          backlog: [
            snap({
              legState: { status: 'connected', since: ts(1), lastByteAt: ts(2) },
            }),
          ],
        },
      },
      {
        args: a(),
        leg: {
          runnerId: 'rid-1',
          backlog: [snap({ legState: { status: 'connected', since: ts(1) } })],
        },
      },
      {
        args: a(),
        leg: {
          runnerId: 'rid-1',
          backlog: [
            snap({
              legState: {
                status: 'down',
                since: ts(1),
                lastFailureReason: 'ECONNRESET',
                nextRetryAt: ts(5),
              },
            }),
          ],
        },
      },
      {
        args: a(),
        leg: { runnerId: 'rid-1', backlog: [snap({ legState: { status: 'down' } })] },
      },
      {
        args: a(),
        leg: {
          runnerId: 'rid-1',
          backlog: [snap({ legState: { status: 'never-connected' } })],
        },
      },
      {
        args: a(),
        leg: { runnerId: 'rid-1', backlog: [snap()] },
      },
    ],
  },
  {
    name: 'unreadable',
    group: '見つからない・空',
    covers: 'unreadable: 台帳の行が読めない。絞りも offset も出力に出ない（読みに降りていない）',
    results: {
      '*': { kind: 'unreadable', detail: '台帳の行が jobSchema に合わない（status が不明）。' },
    },
    steps: [{ args: a() }, { args: a({ offset: 100, type: 'assistant' }) }],
  },
  {
    name: 'removed',
    group: '見つからない・空',
    covers: 'removed: 退避はあったが本文は消されている（バイト数は 1,234,567 の桁区切り）',
    results: {
      '*': {
        kind: 'removed',
        archiveId: 'arch-1.jsonl',
        removedAt: '2026-10-20T00:00:00.000Z',
        bytes: 1_234_567,
      },
    },
    steps: [{ args: a() }, { args: a({ since: '2026-10-01', offset: 3 }) }],
  },
  {
    name: 'body-empty',
    group: '見つからない・空',
    covers: 'body が空文字（見つかったが0文字）。絞りを付けると「全 0 行のうち 0 行」',
    results: { '*': body('') },
    steps: [
      { args: a() },
      { args: a({ type: 'assistant' }) },
      { args: a({ since: '2026-10-01' }) },
      { args: a({ offset: 3 }) },
    ],
  },
  {
    name: 'body-archive-id',
    group: '見つからない・空',
    covers:
      '退避から読んだ本文は archive id の案内が付く（ない本文は付かない）。絞りがあっても付く',
    results: { '*': body(SMALL, 'arch-9.jsonl') },
    steps: [
      { args: a() },
      { args: a({ contains: 'abc' }) },
      { args: a(), results: { '*': body(SMALL) } },
    ],
  },
  {
    name: 'read-fails',
    group: '読みが失敗する',
    covers:
      'transcript() が例外／missing のときの runnerIdOf・runnerBacklog が例外。例外はそのまま出る（捕まえない）。キャッシュは動かない',
    results: { '*': { throws: 'transcript の読みが落ちた' } },
    leg: { runnerId: 'rid-1' },
    steps: [
      { args: a() },
      { args: a({ offset: 10 }) },
      {
        args: a(),
        results: { '*': { kind: 'missing' } },
        leg: { runnerIdThrows: 'runnerIdOf が落ちた' },
      },
      {
        args: a(),
        leg: { runnerId: 'rid-1', backlogThrows: 'runnerBacklog が落ちた' },
      },
    ],
  },
  {
    name: 'read-fails-keeps-cache',
    group: '読みが失敗する',
    covers:
      '覚えている最中に、別の id の読みが失敗しても、覚えている頁は残り、続きはまだ使い回せる',
    results: { '*': body(BIG_BODY) },
    steps: [
      { args: PAGER, writes: 'some' },
      { args: a({ managerId: 'mgr-2' }), results: { 'mgr-2': { throws: '読めない' } } },
      { args: a({ managerId: 'mgr-3' }), results: { 'mgr-3': { kind: 'missing' } } },
      {
        args: a({ managerId: 'mgr-4' }),
        results: { 'mgr-4': { kind: 'unreadable', detail: '壊れている。' } },
      },
      { args: { ...PAGER, offset: 8_000 }, writes: 'some' },
    ],
  },

  // ---- 頁送り ----
  {
    name: 'page-small',
    group: '頁送り',
    covers:
      '小さな本文: 全文（offset 0）／途中から（offset 3）／末尾ちょうど（offset=長さ）／末尾を越える。続きの案内は付かない',
    results: { '*': body(SMALL) },
    steps: [
      { args: a() },
      { args: a({ offset: 3 }) },
      { args: a({ offset: 9 }) },
      { args: a({ offset: 10 }) },
      { args: a({ offset: 11 }) },
      { args: a({ offset: 1_000_000 }) },
    ],
  },
  {
    name: 'page-edge-8000',
    group: '頁送り',
    covers:
      '本文がちょうど 8,000 字: 1頁で終わる（続きなし・キャッシュに覚えない）。offset 1 は 7,999 字で終わる',
    results: { '*': body(BODY_8000) },
    steps: [{ args: a() }, { args: a({ offset: 1 }) }],
  },
  {
    name: 'page-edge-8001',
    group: '頁送り',
    covers:
      '本文が 8,001 字: 1枚目で切れる（続きの offset=8000・覚える）→ 続き（使い回し・最後なので捨てる）→ 末尾ちょうど（取り直す）→ 末尾を越える',
    results: { '*': body(BODY_8001) },
    steps: [
      { args: a(), writes: 'some' },
      { args: a({ offset: 8_000 }), writes: 'some' },
      { args: a({ offset: 8_001 }) },
      { args: a({ offset: 8_002 }) },
    ],
  },
  {
    name: 'page-cold-offset-boundary',
    group: '頁送り',
    covers:
      '覚えていない状態で offset 1 を付ける境目（`more` の `<`）: 8,001 字なら 2〜8,001 で最後（続きなし）／8,002 字なら 2〜8,001 で切れる（続き offset=8001・覚える）→ offset 2 は覚えた頁を使い回して 3〜8,002 で最後（捨てる）',
    results: { '*': body(BODY_8001) },
    steps: [
      { args: a({ offset: 1 }) },
      {
        args: a({ offset: 1 }),
        results: { '*': body(`${BODY_8001}Y`) },
        writes: 'some',
      },
      { args: a({ offset: 2 }), writes: 'some' },
    ],
  },
  {
    name: 'page-three',
    group: '頁送り',
    covers:
      '本文 16,001 字を3頁で: 0→8000→16000（最後は 1 字）。2頁目は覚えた頁を使い回して、続きがあるので覚え直す（set）。最後の頁は使い回して捨てる',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), writes: 'some' },
      { args: a({ offset: 8_000 }), writes: 'some' },
      { args: a({ offset: 16_000 }), writes: 'some' },
    ],
  },
  {
    name: 'page-astral',
    group: '頁送り',
    covers:
      '8,000 字目が補助面の文字の途中: 1枚目は 7,999 字で切る（文字を割らない）。続きの offset は 7999',
    results: { '*': body(BODY_ASTRAL) },
    steps: [
      { args: a(), writes: 'some' },
      { args: a({ offset: 7_999 }), writes: 'some' },
    ],
  },
  {
    name: 'page-filtered-resume',
    group: '頁送り',
    covers:
      '絞った本文が 8,000 字を越える: 続きの案内に今回渡した絞りを全部付ける。2頁目も同じ絞り込みの断り書きを出す',
    results: { '*': body(BIG_BODY, 'arch-2.jsonl') },
    steps: [
      { args: a(ALL_AXES), writes: 'some' },
      { args: a({ ...ALL_AXES, offset: 8_000 }), writes: 'some' },
    ],
  },
  {
    name: 'page-resume-axes',
    group: '頁送り',
    covers:
      '続きの案内に付く絞りは渡した軸だけ（since のみ・until のみ・type のみ・contains のみ・組み合わせ）',
    results: { '*': body(BIG_BODY) },
    steps: [
      { args: a({ type: 'assistant', since: ts(0) }), writes: 'some' },
      { args: a({ type: 'assistant', until: ts(40) }), writes: 'some' },
      { args: a({ type: 'assistant,user' }), writes: 'some' },
      { args: a({ contains: '"pad"' }), writes: 'some' },
      { args: a({ type: '', contains: '"pad"' }), writes: 'some' },
      { args: a({ since: ts(0), contains: '"pad"' }), writes: 'some' },
    ],
  },

  // ---- キャッシュに当たる・外れる ----
  {
    name: 'cache-hit',
    group: 'キャッシュ',
    covers:
      '当たり: 1枚目のあと offset>0 で pool を呼ばず覚えた本文を使い回す（使い回しの断り書き・fetchedAt は1枚目の時刻）。pool が答えを変えても古いまま',
    results: { '*': body(BIG_BODY, 'arch-3.jsonl') },
    steps: [
      { args: PAGER, at: 0, writes: 'some' },
      {
        args: { ...PAGER, offset: 8_000 },
        at: 5_000,
        writes: 'some',
        results: { '*': { kind: 'missing' } },
      },
    ],
  },
  {
    name: 'cache-hit-stays',
    group: 'キャッシュ',
    covers:
      '最後の頁でなければ使い回したあとも覚え続ける（続けて別の offset で当たる。覚え直すので holding は変わらないが set は呼ばれる）。最後の頁で捨て、そのあとは取り直し',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), at: 0, writes: 'some' },
      { args: a({ offset: 4_000 }), at: 30_000, writes: 'some' },
      { args: a({ offset: 8_000 }), at: 60_000, writes: 'some' },
      { args: a({ offset: 16_000 }), at: 90_000, writes: 'some' },
      { args: a({ offset: 8_000 }), at: 100_000, writes: 'some' },
    ],
  },
  {
    name: 'cache-ttl-sliding',
    group: 'キャッシュ',
    covers:
      '期限は使い回すたびに延びる（続きがあるたび覚え直すため）: 1枚目から 100 秒後に当たり、そこから 100 秒後（1枚目からは 200 秒後）にも当たる。そのあと 120 秒放置すると外れる',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), at: 0, writes: 'some' },
      { args: a({ offset: 4_000 }), at: 100_000, writes: 'some' },
      { args: a({ offset: 8_000 }), at: 200_000, writes: 'some' },
      { args: a({ offset: 8_000 }), at: 200_000 + TTL_MS, writes: 'some' },
    ],
  },
  {
    name: 'cache-offset-zero-refetches',
    group: 'キャッシュ',
    covers:
      'offset 0 は覚えていても取り直す（get しない）。新しい fetchedAt で覚え直し、続きはその新しい本文を使う',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), at: 0, writes: 'some' },
      { args: a(), at: 10_000, writes: 'some', results: { '*': body(`${BODY_16001}?`) } },
      { args: a({ offset: 16_000 }), at: 20_000, writes: 'some' },
    ],
  },
  {
    name: 'cache-cold-offset',
    group: 'キャッシュ',
    covers:
      '覚えていない（道具を作ってすぐ）offset>0 は pool から取り寄せる（使い回しの断り書きは付かない）。続きがあれば覚える',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a({ offset: 8_000 }), writes: 'some' },
      { args: a({ offset: 16_000 }), writes: 'some' },
    ],
  },
  {
    name: 'cache-last-page-clears',
    group: 'キャッシュ',
    covers:
      '最後の頁を出すと捨てる: そのあとの offset>0 は取り直しになる（取り直した頁も最後なので、覚えるものは無いまま＝書き込み無し）',
    results: { '*': body(BODY_8001) },
    steps: [
      { args: a(), writes: 'some' },
      { args: a({ offset: 8_000 }), writes: 'some' },
      { args: a({ offset: 8_000 }) },
    ],
  },
  {
    name: 'cache-ttl-edge-hit',
    group: 'キャッシュ',
    covers: '期限の境目: 覚えた 119,999 ms 後はまだ当たる',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), at: 0, writes: 'some' },
      { args: a({ offset: 8_000 }), at: TTL_MS - 1, writes: 'some' },
    ],
  },
  {
    name: 'cache-ttl-edge-miss',
    group: 'キャッシュ',
    covers: '期限の境目: 覚えてちょうど 120,000 ms 後は外れる（捨てて取り直し、覚え直す）',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), at: 0, writes: 'some' },
      { args: a({ offset: 8_000 }), at: TTL_MS, writes: 'some' },
    ],
  },
  {
    name: 'cache-ttl-long',
    group: 'キャッシュ',
    covers: '期限を大きく越えた続き（放置したあと）も取り直し。使い回しの断り書きは無い',
    results: { '*': body(BODY_16001) },
    steps: [
      { args: a(), at: 0, writes: 'some' },
      { args: a({ offset: 8_000 }), at: 10 * TTL_MS, writes: 'some' },
    ],
  },
  {
    name: 'cache-key-manager',
    group: 'キャッシュ',
    covers:
      '鍵の軸 managerId: 別の担当の続きは外れ（取り直して置き換える）、覚えているのは新しい担当の1件だけ（元の担当の続きも外れる）',
    results: { '*': body(BIG_BODY) },
    steps: [
      { args: PAGER, writes: 'some' },
      { args: { ...PAGER, managerId: 'mgr-2', offset: 1 }, writes: 'some' },
      { args: { ...PAGER, offset: 8_000 }, writes: 'some' },
    ],
  },
  ...(['since', 'until', 'type', 'contains'] as const).map((axis): Scenario => ({
    name: `cache-key-${axis}`,
    group: 'キャッシュ',
    covers: `鍵の軸 ${axis}: 1枚目と違う値の続きは外れる（取り直して絞り直し、置き換える）。そのあと元の値の続きも外れる`,
    results: { '*': body(BIG_BODY) },
    steps: [
      { args: a(ALL_AXES), writes: 'some' },
      {
        args: a({
          ...ALL_AXES,
          [axis]: { since: ts(1), until: ts(41), type: 'assistant', contains: '"tag"' }[axis],
          offset: 1,
        }),
        writes: 'some',
      },
      { args: a({ ...ALL_AXES, offset: 8_000 }), writes: 'some' },
    ],
  })),
  {
    name: 'cache-key-filter-presence',
    group: 'キャッシュ',
    covers:
      '絞りの有無も鍵: 絞って1枚目を読んだあと、絞りなしの続きは外れる。空文字の絞り（type/contains が空）は渡した扱いで鍵が別',
    results: { '*': body(BIG_BODY) },
    steps: [
      { args: a({ type: 'assistant,user' }), writes: 'some' },
      { args: a({ offset: 8_000 }), writes: 'some' },
      { args: a({ contains: '' }), writes: 'some' },
      { args: a({ offset: 8_000 }), writes: 'some' },
    ],
  },

  // ---- 絞り込みの各軸 ----
  {
    name: 'filter-time',
    group: '絞り込み',
    covers:
      'since／until／窓。since は含む・until は含まない（境目の行）。時差付き・日付だけ・窓が逆（0件）。時刻の無い行・読めない行を除いた数が出る',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a({ since: ts(2) }) },
      { args: a({ until: ts(2) }) },
      { args: a({ since: ts(1), until: ts(4) }) },
      { args: a({ since: ts(3), until: ts(1) }) },
      { args: a({ since: '2026-10-01T09:01:00+09:00' }) },
      { args: a({ since: '2026-10-01' }) },
      { args: a({ until: '2026-10-01' }) },
      { args: a({ since: ts(5), until: ts(6) }) },
    ],
  },
  {
    name: 'filter-type',
    group: '絞り込み',
    covers:
      'type: 単独・カンマ区切り複数・空白つき・空要素・カンマだけ・空文字（種類の制限なしと同じ。ただし絞り込みの断り書きは出る）・当たらない型。JSON として読めない行の数が出る',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a({ type: 'assistant' }) },
      { args: a({ type: 'assistant,result' }) },
      { args: a({ type: ' assistant , result ' }) },
      { args: a({ type: 'assistant,,' }) },
      { args: a({ type: ',' }) },
      { args: a({ type: '' }) },
      { args: a({ type: 'nothing' }) },
      { args: a({ type: 'ASSISTANT' }) },
    ],
  },
  {
    name: 'filter-contains',
    group: '絞り込み',
    covers:
      'contains: 部分一致（JSON として読めない行にも掛かる）・空文字（絞らない）・当たらない・大文字小文字を区別。JSON として読めない行は contains だけでは数えない',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a({ contains: '"stop_reason":"tool_use"' }) },
      { args: a({ contains: '' }) },
      { args: a({ contains: 'no-such-text' }) },
      { args: a({ contains: 'TOOL_USE' }) },
      { args: a({ contains: 'not json' }) },
    ],
  },
  {
    name: 'filter-combined',
    group: '絞り込み',
    covers:
      '軸の組み合わせ（AND）: 窓＋type／窓＋contains／type＋contains／全部。窓があれば除いた数は窓の判定のぶんだけ出す',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a({ since: ts(0), type: 'assistant' }) },
      { args: a({ until: ts(4), contains: 'tool' }) },
      { args: a({ type: 'assistant', contains: 'tool_use' }) },
      { args: a({ since: ts(1), until: ts(6), type: 'assistant,user', contains: 'tool' }) },
      { args: a({ type: 'user', since: ts(2) }) },
    ],
  },
  {
    name: 'filter-line-count',
    group: '絞り込み',
    covers:
      '行の数え方: 末尾の改行の後ろは数えない／途中の空行は1行／改行だけ／末尾の改行なし／空文字',
    results: { '*': body('a\nb') },
    steps: [
      { args: a({ contains: '' }) },
      { args: a({ contains: '' }), results: { '*': body('a\n\nb\n') } },
      { args: a({ contains: '' }), results: { '*': body('\n') } },
      { args: a({ contains: '' }), results: { '*': body('\n\n') } },
      { args: a({ contains: '' }), results: { '*': body('single') } },
      { args: a({ contains: 'a' }), results: { '*': body('a\n\nb\n') } },
    ],
  },
  {
    name: 'filter-empty-result',
    group: '絞り込み',
    covers: '0件の絞り込み: 断り書きだけで本文は空（全 0 文字）。続きの案内は付かない',
    results: { '*': body(FILTER_BODY, 'arch-4.jsonl') },
    steps: [{ args: a({ contains: 'no-such-text' }) }, { args: a({ since: '2030-01-01' }) }],
  },
  {
    name: 'filter-no-filter-same',
    group: '絞り込み',
    covers: '絞りを1つも渡さなければ断り書きなし（絞りの軸が undefined のとき）',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a() },
      { args: a({ since: undefined, until: undefined, type: undefined, contains: undefined }) },
    ],
  },
  {
    name: 'filter-offset-cold',
    group: '絞り込み',
    covers:
      '覚えていない続き（offset>0）でも絞りは掛かり、断り書きが付く。絞った本文に対する offset で切る',
    results: { '*': body(FILTER_BODY) },
    steps: [
      { args: a({ type: 'assistant', offset: 20 }) },
      { args: a({ type: 'assistant', offset: 100_000 }) },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

interface StepState {
  pool: string[];
  cache: { ops: string[]; holdingBefore: boolean; holdingAfter: boolean };
  /** 呼んだあとキャッシュが変わったか（`set` が呼ばれた、または覚えているかが変わった） */
  wrote: boolean;
}

interface RunResult {
  outputs: { text: string; isError: boolean }[];
  states: StepState[];
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
  let results: Record<string, Result> = { ...scenario.results };
  let leg: Leg = { ...scenario.leg };
  const poolLog: string[] = [];
  const known = new Set(['transcript', 'runnerIdOf', 'runnerBacklog']);
  const pool = new Proxy(
    {
      async transcript(id: string): Promise<ManagerTranscript> {
        poolLog.push(`transcript(${id})`);
        const picked = results[id] ?? results['*'] ?? { kind: 'missing' as const };
        if ('throws' in picked) throw new Error(picked.throws);
        return picked;
      },
      async runnerIdOf(id: string): Promise<string | undefined> {
        poolLog.push(`runnerIdOf(${id})`);
        if (leg.runnerIdThrows !== undefined) throw new Error(leg.runnerIdThrows);
        return leg.runnerId;
      },
      runnerBacklog(): readonly RunnerBacklogSnapshot[] {
        poolLog.push('runnerBacklog()');
        if (leg.backlogThrows !== undefined) throw new Error(leg.backlogThrows);
        return leg.backlog ?? [];
      },
    },
    {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !known.has(prop) && prop !== 'then') {
          throw new Error(`偽の pool に無い口が呼ばれた: ${prop}`);
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    },
  ) as unknown as ManagerPool;

  spy.instances.length = 0;
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.noPool === true ? {} : { managers: pool }),
  });
  const found = tools.find((entry) => entry.name === 'manager_transcript');
  if (!found) throw new Error('manager_transcript が無い');
  const cache = spy.instances[0];
  if (cache === undefined || spy.instances.length !== 1) {
    throw new Error(`頁のキャッシュの個数が1でない: ${String(spy.instances.length)}`);
  }

  const outputs: RunResult['outputs'] = [];
  const states: StepState[] = [];
  let at = -1_000;
  for (const step of scenario.steps) {
    if (step.results !== undefined) results = { ...results, ...step.results };
    if (step.leg !== undefined) leg = step.leg;
    at = step.at ?? at + 1_000;
    vi.setSystemTime(new Date(FROZEN_MS + at));
    poolLog.length = 0;
    cache.ops.length = 0;
    const holdingBefore = cache.holding;
    let text: string;
    let isError = false;
    try {
      const result = await found.handler(step.args as never, {});
      text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      isError = result.isError === true;
    } catch (error) {
      text = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
    const holdingAfter = cache.holding;
    outputs.push({ text, isError });
    states.push({
      pool: [...poolLog],
      cache: { ops: [...cache.ops], holdingBefore, holdingAfter },
      wrote: cache.ops.includes('set') || holdingBefore !== holdingAfter,
    });
  }
  cache.clear();
  return { outputs, states };
}

interface PinnedOutput {
  length: number;
  isError: boolean;
  text: string;
}

interface PinnedState {
  pool: string[];
  cache: { ops: string[]; holdingBefore: boolean; holdingAfter: boolean };
  wrote: boolean;
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
  states: Record<string, PinnedState>;
}

interface Collected {
  outputs: Record<string, PinnedOutput>;
  states: Record<string, PinnedState>;
}

async function runAll(): Promise<Collected> {
  const outputs: Record<string, PinnedOutput> = {};
  const states: Record<string, PinnedState> = {};
  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    for (const [index, output] of result.outputs.entries()) {
      const key = stepKey(scenario, index);
      outputs[key] = { length: output.text.length, isError: output.isError, text: output.text };
      const state = result.states[index];
      if (state !== undefined) states[key] = state;
    }
  }
  return { outputs, states };
}

describe('manager_transcript の出力の固定（場面ごとの全文と字数・pool とキャッシュの操作）', () => {
  let actual: Collected = { outputs: {}, states: {} };
  let pinned: PinFile = { lengths: {}, scenarios: {}, states: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(
          ALL_KEYS.map((key) => [key, actual.outputs[key]?.length ?? -1]),
        ),
        scenarios: actual.outputs,
        states: actual.states,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  });

  afterAll(() => {
    for (const instance of spy.instances) instance.clear();
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual.outputs)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.states)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual.outputs[key]?.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual.outputs[key]?.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.length);
    }
  });

  describe.each(SCENARIOS)('場面 $name（$group）', (scenario) => {
    for (const [index, step] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);
      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual.outputs[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.text.length,
          `場面 ${key} の字数が変わった: 固定値 ${String(want?.length)} 字 → いま ${String(got?.text.length)} 字`,
        ).toBe(want?.length);
        expect(
          got?.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.text.length)} 字で同じ）`,
        ).toBe(want?.text);
        expect(got?.isError, `場面 ${key} の isError が変わった`).toBe(want?.isError);
      });

      it(`${key} の pool への呼びとキャッシュの操作が固定値と同じ（書き込み: ${step.writes ?? 'none'}）`, () => {
        const want = pinned.states[key];
        const got = actual.states[key];
        expect(want, `${key} の状態が固定値に無い`).toBeDefined();
        expect(got?.pool, `場面 ${key} の pool への呼びがずれた`).toEqual(want?.pool);
        expect(got?.cache, `場面 ${key} のキャッシュの操作がずれた`).toEqual(want?.cache);
        expect(got?.wrote, `場面 ${key} の書き込みの有無がずれた`).toBe(want?.wrote);
        // 期待した書き込みの有無。none の呼びは、set が無く、覚えているかも変わらない
        expect(
          got?.wrote ? 'some' : 'none',
          `場面 ${key}: 書き込みの期待（${step.writes ?? 'none'}）と実際が違う`,
        ).toBe(step.writes ?? 'none');
        if ((step.writes ?? 'none') === 'none') {
          expect(got?.cache.ops, `場面 ${key}: 書かない呼びが set した`).not.toContain('set');
          expect(
            got?.cache.holdingAfter,
            `場面 ${key}: 書かない呼びでキャッシュの中身が変わった`,
          ).toBe(got?.cache.holdingBefore);
        }
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・同じ状態になる（時計・並びが固定されている）', async () => {
    const again = await runAll();
    expect(again.outputs).toEqual(actual.outputs);
    expect(again.states).toEqual(actual.states);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual.outputs[key]?.text ?? '';
    const state = (key: string): StepState | undefined => actual.states[key];
    // 引数の検査
    for (const key of [
      'arg-offset#1',
      'arg-offset#2',
      'arg-offset#3',
      'arg-offset#4',
      'arg-offset#5',
    ]) {
      expect(text(key)).toContain('は使えない（0以上の整数のみ）');
      expect(state(key)?.pool).toEqual([]);
    }
    expect(text('arg-since#1')).toContain('since に渡された「yesterday」は日時として読めない');
    expect(text('arg-since#1')).toContain('生ログは絞れない。');
    expect(text('arg-since#3')).toContain('since に渡された「」');
    expect(text('arg-until#1')).toContain('until に渡された「tomorrow」は日時として読めない');
    expect(text('arg-order#1')).toContain('offset -1 は使えない');
    expect(text('arg-order#2')).toContain('since に渡された');
    expect(text('arg-order#3')).toContain('until に渡された');
    expect(text('arg-order#4')).toContain('いまは委譲できない場面である');
    expect(text('arg-order#5')).toContain('いまは委譲できない場面である');
    expect(text('arg-order-with-pool#1')).toContain('offset -1 は使えない');
    expect(state('arg-order-with-pool#2')?.pool).toEqual([]);
    expect(state('arg-order-with-pool#3')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('arg-order-with-pool#4')?.pool).toEqual(['transcript(mgr-1)']);
    expect(text('no-pool#1')).toContain('いまは委譲できない場面である');
    expect(text('no-pool#2')).toContain('いまは委譲できない場面である');
    expect(state('no-pool#2')?.cache.ops).toEqual([]);
    // 見つからない・空・読めない
    expect(text('missing-no-runner#1')).toContain('の生ログは無い。走行中の runner のディスク');
    expect(text('missing-no-runner#1')).toContain(
      '判定できない（この委譲に runner が割り当てられたことを',
    );
    expect(state('missing-no-runner#1')?.pool).toEqual(['transcript(mgr-1)', 'runnerIdOf(mgr-1)']);
    expect(text('missing-no-runner#3')).not.toContain('絞り込み:');
    expect(text('missing-leg#1')).toContain(
      'について、生ログが無い理由と結び付けられる未送出の滞留を観測できていない',
    );
    expect(text('missing-leg#2')).toContain(
      '生ログが無い理由と結び付けられる未送出の滞留を観測できていない',
    );
    expect(text('missing-leg#3')).toContain(
      '生ログが無い理由と結び付けられる未送出の滞留を観測できていない',
    );
    expect(text('missing-leg#4')).toContain('引き渡せずに消えた可能性が高い。');
    expect(text('missing-leg#4')).toContain('もう来ない（この滞留を観測した後に器が入れ替わった');
    expect(text('missing-leg#5')).toContain('まだ引き渡していない可能性がある');
    expect(text('missing-leg#5')).toContain(`最後にバイトを受け取ったのは ${ts(2)}`);
    expect(text('missing-leg#6')).toContain('開いてから1バイトも受け取っていない');
    expect(text('missing-leg#7')).toContain('直近の理由: ECONNRESET');
    expect(text('missing-leg#7')).toContain(`次の再試行: ${ts(5)}`);
    expect(text('missing-leg#8')).toContain('⚠ 再接続するまで1件も届かない');
    expect(text('missing-leg#8')).not.toContain('直近の理由');
    expect(text('missing-leg#9')).toContain('このデーモンが起きてから一度も繋がっていない');
    expect(text('missing-leg#10')).toContain('この runner は脚の状態を報告しない');
    expect(text('unreadable#1')).toContain(
      '台帳の行が jobSchema に合わない（status が不明）。生ログには降りていない。',
    );
    expect(text('unreadable#2')).not.toContain('offset');
    expect(text('removed#1')).toContain('生ログは退避されていたが、本文は消されている');
    expect(text('removed#1')).toContain('1,234,567 バイトを落とした');
    expect(text('removed#1')).toContain('archive id: arch-1.jsonl');
    expect(text('body-empty#1')).toContain('（全 0 文字）');
    expect(text('body-empty#2')).toContain('絞り込み: 全 0 行のうち 0 行が当たった。');
    // 空の本文では offset が長さ（0）へ丸められ、「末尾を越えている」ではなく「全 0 文字」になる
    expect(text('body-empty#4')).toContain('（全 0 文字）');
    expect(text('body-empty#4')).not.toContain('末尾を越えている');
    expect(text('body-archive-id#1')).toContain('archive_remove archiveId=arch-9.jsonl で消せる');
    expect(text('body-archive-id#2')).toContain('archive_remove archiveId=arch-9.jsonl で消せる');
    expect(text('body-archive-id#3')).not.toContain('archive id');
    // 読みが失敗する
    expect(text('read-fails#1')).toBe('THREW: transcript の読みが落ちた');
    expect(text('read-fails#3')).toBe('THREW: runnerIdOf が落ちた');
    expect(text('read-fails#4')).toBe('THREW: runnerBacklog が落ちた');
    expect(text('read-fails-keeps-cache#2')).toBe('THREW: 読めない');
    expect(state('read-fails-keeps-cache#5')?.cache.ops).toEqual(['get:hit', 'clear']);
    expect(text('read-fails-keeps-cache#5')).toContain('この頁は1枚目を読んだ時点');
    // 頁送り
    expect(text('page-small#1')).toContain('（全 10 文字）');
    expect(text('page-small#2')).toContain('4〜10 文字目 / 全 10 文字');
    expect(text('page-small#4')).toContain('全 10 文字の末尾を越えている');
    expect(text('page-small#1')).not.toContain('ここで切れている');
    expect(text('page-edge-8000#1')).toContain('（全 8,000 文字）');
    expect(text('page-edge-8000#1')).not.toContain('ここで切れている');
    expect(text('page-edge-8000#2')).toContain('2〜8,000 文字目 / 全 8,000 文字');
    expect(text('page-edge-8001#1')).toContain('1〜8,000 文字目 / 全 8,001 文字');
    expect(text('page-edge-8001#1')).toContain(
      '続きは manager_transcript managerId=mgr-1 offset=8000）',
    );
    expect(text('page-edge-8001#2')).toContain('8,001〜8,001 文字目 / 全 8,001 文字');
    expect(text('page-edge-8001#2')).not.toContain('ここで切れている');
    expect(text('page-edge-8001#3')).toContain('全 8,001 文字の末尾を越えている');
    expect(text('page-cold-offset-boundary#1')).toContain('2〜8,001 文字目 / 全 8,001 文字');
    expect(text('page-cold-offset-boundary#1')).not.toContain('ここで切れている');
    expect(text('page-cold-offset-boundary#2')).toContain('2〜8,001 文字目 / 全 8,002 文字');
    expect(text('page-cold-offset-boundary#2')).toContain('offset=8001）');
    expect(text('page-cold-offset-boundary#3')).toContain('3〜8,002 文字目 / 全 8,002 文字');
    expect(text('page-cold-offset-boundary#3')).toContain('この頁は1枚目を読んだ時点');
    expect(text('page-cold-offset-boundary#3')).not.toContain('ここで切れている');
    expect(text('page-three#3')).toContain('16,001〜16,001 文字目 / 全 16,001 文字');
    expect(text('page-astral#1')).toContain('1〜7,999 文字目 / 全 8,005 文字');
    expect(text('page-astral#1')).toContain('offset=7999）');
    expect(text('page-astral#2')).toContain('8,000〜8,005 文字目');
    expect(text('page-filtered-resume#1')).toContain(
      `offset=8000 since=${ts(0)} until=${ts(40)} type=assistant,user contains="pad"）`,
    );
    expect(text('page-filtered-resume#2')).toContain('絞り込み: 全 42 行のうち 40 行が当たった。');
    expect(text('page-filtered-resume#2')).toContain('この頁は1枚目を読んだ時点');
    expect(text('page-resume-axes#1')).toContain(`offset=8000 since=${ts(0)} type=assistant）`);
    expect(text('page-resume-axes#2')).toContain(`offset=8000 until=${ts(40)} type=assistant）`);
    expect(text('page-resume-axes#4')).toContain('offset=8000 contains="pad"）');
    expect(text('page-resume-axes#5')).toContain('offset=8000 type= contains="pad"）');
    // キャッシュ
    expect(state('cache-hit#1')?.cache.ops).toEqual(['set']);
    expect(state('cache-hit#2')?.cache.ops).toEqual(['get:hit', 'clear']);
    expect(state('cache-hit#1')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-hit#2')?.pool).toEqual([]);
    expect(text('cache-hit#2')).toContain(
      `1枚目を読んだ時点（${new Date(FROZEN_MS).toISOString()}）`,
    );
    expect(text('cache-hit#2')).toContain('archive_remove archiveId=arch-3.jsonl');
    expect(state('cache-hit-stays#2')?.pool).toEqual([]);
    expect(state('cache-hit-stays#3')?.pool).toEqual([]);
    expect(state('cache-hit-stays#4')?.pool).toEqual([]);
    expect(state('cache-hit-stays#4')?.cache.holdingAfter).toBe(false);
    expect(state('cache-hit-stays#5')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-hit-stays#2')?.cache.ops).toEqual(['get:hit', 'set']);
    expect(state('cache-ttl-sliding#2')?.pool).toEqual([]);
    expect(state('cache-ttl-sliding#3')?.pool).toEqual([]);
    expect(state('cache-ttl-sliding#4')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-offset-zero-refetches#2')?.cache.ops).toEqual(['set']);
    expect(text('cache-offset-zero-refetches#3')).toContain(
      `1枚目を読んだ時点（${new Date(FROZEN_MS + 10_000).toISOString()}）`,
    );
    expect(state('cache-cold-offset#1')?.pool).toEqual(['transcript(mgr-1)']);
    expect(text('cache-cold-offset#1')).not.toContain('使い回している');
    expect(text('cache-cold-offset#2')).toContain('この頁は1枚目を読んだ時点');
    expect(state('cache-last-page-clears#3')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-ttl-edge-hit#2')?.pool).toEqual([]);
    expect(state('cache-ttl-edge-miss#2')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-ttl-edge-miss#2')?.cache.ops).toEqual(['clear', 'get:miss', 'set']);
    expect(state('cache-ttl-long#2')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-key-manager#2')?.pool).toEqual(['transcript(mgr-2)']);
    expect(state('cache-key-manager#3')?.pool).toEqual(['transcript(mgr-1)']);
    for (const axis of ['since', 'until', 'type', 'contains']) {
      expect(state(`cache-key-${axis}#2`)?.pool, `${axis} の鍵が効いていない`).toEqual([
        'transcript(mgr-1)',
      ]);
      expect(state(`cache-key-${axis}#3`)?.pool, `${axis}: 取り直したあとの元の鍵`).toEqual([
        'transcript(mgr-1)',
      ]);
    }
    expect(state('cache-key-filter-presence#2')?.pool).toEqual(['transcript(mgr-1)']);
    expect(state('cache-key-filter-presence#4')?.pool).toEqual(['transcript(mgr-1)']);
    // 絞り込み
    expect(text('filter-time#1')).toContain('絞り込み: 全 14 行のうち');
    expect(text('filter-time#1')).toContain('（時刻の無い行 ');
    expect(text('filter-time#1')).toContain('は窓の判定ができないので除いた）');
    expect(text('filter-type#1')).toContain('（JSON として読めない行 ');
    expect(text('filter-type#6')).toContain('絞り込み: 全 14 行のうち');
    expect(text('filter-contains#1')).not.toContain('JSON として読めない行');
    expect(text('filter-contains#1')).not.toContain('時刻の無い行');
    expect(text('filter-empty-result#1')).toContain('全 14 行のうち 0 行が当たった');
    expect(text('filter-empty-result#1')).toContain('（全 0 文字）');
    expect(text('filter-no-filter-same#1')).not.toContain('絞り込み');
    expect(text('filter-no-filter-same#2')).toBe(text('filter-no-filter-same#1'));
    expect(text('filter-line-count#1')).toContain('全 2 行のうち 2 行が当たった');
    expect(text('filter-line-count#2')).toContain('全 3 行のうち 3 行が当たった');
    expect(text('filter-line-count#3')).toContain('全 1 行のうち 1 行が当たった');
    expect(text('filter-line-count#4')).toContain('全 2 行のうち 2 行が当たった');
    expect(text('filter-line-count#5')).toContain('全 1 行のうち 1 行が当たった');
    expect(text('filter-offset-cold#1')).toContain('絞り込み:');
  });
});
