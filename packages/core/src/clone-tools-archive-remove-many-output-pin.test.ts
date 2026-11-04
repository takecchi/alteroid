import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores, seedFingerprintlessArchiveRow } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// `archive_remove_many` の出力（全文と字数）と、呼んだあとの状態（アーカイブの行・日誌へ足された行・墓標の列）を、
// 場面ごとにコミットした固定値（clone-tools-archive-remove-many-output-pin.json）と丸ごと比べる。
// `clone-tools-ops.ts` の `tool('archive_remove_many', …)`（約 249 行・入れ子 9 段の式）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・session id・本文・時刻）を固定して毎回同じにする。
// この道具はアーカイブの本文を消す（tombstone。行そのものは残る）ので、出力だけでなく「呼んだあとの状態」も固定する:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - archive: 呼んだあとのアーカイブの行（`stores.archive.list()` の形のまま。消された行は removedAt / removedBytes が付いて storedBytes が 0 になり、
//     残った行・最新行・墓標で守った行・含有が証明できない行・指紋の無い行も同じ並びに在る）。このストアに「読めない行」は無い（行の形は型で決まる）
//   - journal: 呼んだあとに日誌へ足された行（種類・本文・grounds・id・at をそのまま）。id は日誌のインメモリの採番（id-1, id-2, …）で場面ごとに作り直す
//   - graves: 呼んだあとの墓標の列（`stores.sessions.listTranscriptGraves()`。この道具は墓標を書き換えない。呼ぶ前と同じであることも別に確かめる）
//   - wrote: アーカイブか日誌のどちらかが呼ぶ前から変わったか。断った・当たらなかった・試算の場面は false で、アーカイブ・日誌・墓標が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_ARCHIVE_REMOVE_MANY_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-archive-remove-many-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-archive-remove-many-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、アーカイブ・日誌のどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// アーカイブの行は場面の頭に `stores.archive.archive()` で、基準の 2026-10-01 から分単位の時刻に時計を置いて積む
// （行の id は `<sessionId>-<時刻>.jsonl` なので毎回同じ。同じ分に同じセッションを積むと `-2.jsonl` の枝番）。
// 呼びごとに基準時刻 2026-10-29 から 1 分ずつ進めて呼ぶ（日誌の at・removedAt が呼び順に増える）。
// 同じ状態へ続けて呼ぶ場面は `名前#1`・`名前#2` と呼びごとに固定する。
// 塊（日誌の1行）の割り方は id の字数の予算（3,600 字）で決まるので、複数の塊を作る場面は id の長さを入力の側で選ぶ
// （1,200 字の id は 1 塊 2 件、300 字の id は 1 塊 11 件）。

type Args = Record<string, unknown>;

/** 呼びが起こした書き込み（アーカイブか日誌）が「無い」と「有る」。無いと言った呼びは、呼ぶ前と状態が同じであることを確かめる */
type Writes = 'none' | 'some';

/** 走行中のマネージャーの配線: 誰も使っていない / `runningManagerOwning` だけ / `runningManagerPinning` も持つ / `managers` が配線されていない */
type ManagersMode = 'idle' | 'owning' | 'pinning' | 'unwired';

interface SeedRow {
  /** 場面の中で行を指す名前（hooks・走行中の印・墓標に使う） */
  label: string;
  session: string;
  /** 積む時刻（基準の 2026-10-01 から何分後か） */
  minute: number;
  body: string;
  /** 指紋の無い行を `seedFingerprintlessArchiveRow` で直接積む（continuity が無い行の再現） */
  fingerprintless?: boolean;
  /** 積んだあとに tombstone する（時刻は積んだ分と同じ） */
  removed?: boolean;
  /** 墓標（まだ記憶へ蒸留していない区間）を立てる */
  grave?: boolean;
  /** `runningManagerOwning` が走行中のマネージャーを返す */
  owned?: boolean;
  /** `runningManagerPinning` が走行中のマネージャーを返す（`pinning` の配線のときだけ効く） */
  pinned?: boolean;
}

/** 場面の中で呼びごとに差し替える口（ストアの振る舞い。行は label で指す） */
interface Hooks {
  /** この行を道具が消す直前に、別の経路が先に消す（`remove` が already を返す競合。呼びごとに1度だけ） */
  raceFirst: string[];
  /** この行の `remove` が missing を返す（行が消えている形。消さない） */
  missingFirst: string[];
  /** `archive.remove` の何回目（呼びの中・1 から）を投げさせるか */
  removeFailsAt: number[];
  /** `archive.list` が落ちる */
  listFails: boolean;
  /** `sessions.listTranscriptGraves` が落ちる */
  gravesFail: boolean;
  done: Set<string>;
  removeCalls: number;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Partial<Omit<Hooks, 'done' | 'removeCalls'>>;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: SeedRow[];
  steps: Step[];
  /** journal.append の何回目（場面の通し・1 から。打ち消しの行も数える）を投げさせるか */
  journalFailsAt?: number[];
  managers?: ManagersMode;
  /** アーカイブに無い id の墓標を足す */
  danglingGraves?: string[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const ROW_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const PIN_URL = new URL('./clone-tools-archive-remove-many-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_ARCHIVE_REMOVE_MANY_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function minuteMs(minute: number): number {
  return ROW_BASE + minute * 60_000;
}

function row(
  label: string,
  session: string,
  minute: number,
  body: string,
  extra: Partial<SeedRow> = {},
): SeedRow {
  return { label, session, minute, body, ...extra };
}

/** 同じセッションに、前の本文を前方に含む行を n 本積む（本文は size 文字ずつ伸びる。最後の行が最新行） */
function chain(
  session: string,
  prefix: string,
  count: number,
  options: { start?: number; step?: number; size?: number; ch?: string } = {},
): SeedRow[] {
  const { start = 1, step = 1, size = 3, ch = 'a' } = options;
  return Array.from({ length: count }, (_, index) =>
    row(
      `${prefix}${String(index + 1)}`,
      session,
      start + index * step,
      ch.repeat(size * (index + 1)),
    ),
  );
}

/** 1,200 字の id になるセッション名（行の id は 1,200 字。日誌の1塊に2件） */
const LONG_SESSION = 'sess-long-'.padEnd(1_200 - 31, 'x');
/** 300 字の id になるセッション名（日誌の1塊に11件） */
const MID_SESSION = 'sess-mid-'.padEnd(300 - 31, 'y');

function longChain(count: number): SeedRow[] {
  return chain(LONG_SESSION, 'L', count);
}

function call(args: Args): Args {
  return { summary: '片付いた', dryRun: false, ...args };
}

/** dryRun を省いた呼び（既定は試算） */
function dry(args: Args): Args {
  return { summary: '試算', ...args };
}

const LONG_SUMMARY = `長い要約。${'あ'.repeat(1_999)}`;

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-errors',
    covers:
      '検査の順序と各文言（sessionIds の長さ・要素・before の長さ・summary の長さと空白・絞り込み無し・before の時差と日付・minStoredBytes の範囲）。どれも1件も消さない。先に当たった違反だけを返す',
    seed: chain('sess-a', 'a', 3),
    steps: [
      { args: call({ sessionIds: [] }), writes: 'none' },
      { args: call({ sessionIds: [''] }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a', ''] }), writes: 'none' },
      { args: call({ before: '' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], summary: '' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], summary: '   ' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], summary: '\u0000' }), writes: 'none' },
      { args: call({ summary: '' }), writes: 'none' },
      { args: call({}), writes: 'none' },
      { args: dry({}), writes: 'none' },
      { args: call({ before: 'not-a-date' }), writes: 'none' },
      { args: call({ before: '2026-10-02' }), writes: 'none' },
      { args: call({ before: '2026-10-02T00:00:00' }), writes: 'none' },
      { args: call({ before: '2026-02-30T00:00:00Z' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], minStoredBytes: -1 }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], minStoredBytes: 1.5 }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], minStoredBytes: Number.NaN }), writes: 'none' },
      {
        args: call({ sessionIds: ['sess-a'], minStoredBytes: Number.POSITIVE_INFINITY }),
        writes: 'none',
      },
      { args: call({ before: 'not-a-date', minStoredBytes: -1 }), writes: 'none' },
      { args: call({ sessionIds: [], summary: '' }), writes: 'none' },
      { args: call({ sessionIds: [''], before: '' }), writes: 'none' },
      { args: call({ before: '', summary: '' }), writes: 'none' },
      {
        args: call({ before: '2026-10-02', minStoredBytes: -1, summary: '  ' }),
        writes: 'none',
      },
      { args: dry({ sessionIds: ['sess-a'], minStoredBytes: -1 }), writes: 'none' },
    ],
  },
  // ---- 0件 ----
  {
    name: 'zero-empty',
    covers:
      'アーカイブそのものに行が無い: 「絞り込みの問題ではない」。試算でも実行でも同じ文言。絞り込みの軸（sessionIds・before・minStoredBytes）を渡しても同じ',
    seed: [],
    steps: [
      { args: dry({ sessionIds: ['sess-a'] }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'] }), writes: 'none' },
      {
        args: call({
          before: '2026-10-05T00:00:00Z',
          minStoredBytes: 0,
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-nomatch',
    covers:
      '行は在るが絞り込みに当たらない（0件）: 「絞り込みが外れている」。sessionIds の完全一致（部分一致は当たらない）・before は排他（ちょうどの行を含まない・+09:00 でも同じ瞬間）・minStoredBytes は以上・3つの AND',
    seed: [...chain('sess-a', 'a', 3), ...chain('sess-b', 'b', 3, { start: 10 })],
    steps: [
      { args: dry({ sessionIds: ['nope'] }), writes: 'none' },
      { args: call({ sessionIds: ['sess-'] }), writes: 'none' },
      {
        args: call({ sessionIds: ['sess-a'], before: '2026-10-01T00:01:00.000Z' }),
        writes: 'none',
      },
      { args: call({ before: '2026-10-01T09:01:00+09:00' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], minStoredBytes: 10 }), writes: 'none' },
      { args: dry({ minStoredBytes: 1_000 }), writes: 'none' },
      {
        args: call({
          sessionIds: ['sess-a', 'sess-b'],
          before: '2026-10-01T00:20:00.000Z',
          minStoredBytes: 10,
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'zero-targets-skipped',
    covers:
      '絞り込みには当たったが全部飛ばされて対象が0件: 最新行・tombstone 済み・墓標・含有が証明できない行（diverged）。試算も実行も「0 件を消す」で日誌は書かない（塊が無い）。skipped の内訳が数と合う',
    seed: [
      row('n1', 'sess-n', 1, 'aaa'),
      row('r1', 'sess-r', 2, 'aaa', { removed: true }),
      row('r2', 'sess-r', 3, 'aaabbb'),
      row('g1', 'sess-g', 4, 'aaa', { grave: true }),
      row('g2', 'sess-g', 5, 'aaabbb'),
      row('d1', 'sess-d', 6, 'aaa'),
      row('d2', 'sess-d', 7, 'zzzzzz'),
    ],
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ sessionIds: ['sess-d'] }), writes: 'none' },
      { args: dry({ sessionIds: ['sess-n'] }), writes: 'none' },
    ],
  },
  // ---- 飛ばす行の判定 ----
  {
    name: 'skip-kinds',
    covers:
      '墓標（消えた行・最新行にも立つ。墓標が先に数えられる・アーカイブに無い id の墓標は何もしない）・tombstone 済み・最新行・含有が証明できない行（first だけ・diverged・unknown・指紋の無い行）・消せる行。試算→実行→続けて呼ぶと tombstone 済みへ数え直す',
    seed: [
      row('m1', 'sess-m', 1, 'aaa', { grave: true }),
      row('m2', 'sess-m', 2, 'aaaaaa', { removed: true, grave: true }),
      row('m3', 'sess-m', 3, 'aaaaaaaaa'),
      row('m4', 'sess-m', 4, 'aaaaaaaaaaaa'),
      row('m5', 'sess-m', 5, 'aaaaaaaaaaaaaaa', { grave: true }),
      row('x1', 'sess-x', 6, 'aaa'),
      row('x2', 'sess-x', 7, 'zzzzzz'),
      row('u1', 'sess-u', 8, 'aaa', { fingerprintless: true }),
      row('u2', 'sess-u', 9, 'aaabbb'),
      row('f1', 'sess-f', 10, 'aaa', { fingerprintless: true }),
      row('f2', 'sess-f', 11, 'aaabbb', { fingerprintless: true }),
      row('o1', 'sess-o', 12, 'aaa'),
    ],
    danglingGraves: ['sess-none-2026-10-01T00-00-00-000Z.jsonl'],
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'some' },
      { args: call({ minStoredBytes: 0 }), writes: 'none' },
      { args: dry({ sessionIds: ['sess-x', 'sess-u'] }), writes: 'none' },
    ],
  },
  {
    name: 'anchor-rules',
    covers:
      '含有の証明の錨: 新しい行が continues で tombstone されていなければ古い行は守られる・tombstone 済みの行は錨にならず先の錨を引き継ぐ・diverged の行の1つ古い行は守られない・絞り込みの前に全行で決める（sessionIds で絞っても同じ）',
    seed: [
      row('k1', 'sess-k', 1, 'aaa'),
      row('k2', 'sess-k', 2, 'aaaaaa'),
      row('k3', 'sess-k', 3, 'zzzzzzzzz'),
      row('k4', 'sess-k', 4, 'zzzzzzzzzzzz'),
      row('k5', 'sess-k', 5, 'zzzzzzzzzzzzzzz', { removed: true }),
      row('k6', 'sess-k', 6, 'zzzzzzzzzzzzzzzzzz'),
    ],
    steps: [
      { args: dry({ sessionIds: ['sess-k'] }), writes: 'none' },
      {
        args: call({ sessionIds: ['sess-k'], before: '2026-10-01T00:04:00.000Z' }),
        writes: 'some',
      },
      { args: call({ sessionIds: ['sess-k'] }), writes: 'some' },
    ],
  },
  // ---- 走行中のマネージャー ----
  {
    name: 'inuse-idle',
    covers:
      '誰も使っていない（runningManagerOwning が常に undefined）: inUse は 0・走行中の案内行は付かない',
    seed: [...chain('sess-u', 'u', 4), ...chain('sess-v', 'v', 3, { start: 10 })],
    managers: 'idle',
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'some' },
    ],
  },
  {
    name: 'inuse-owning',
    covers:
      'runningManagerPinning を持たない配線は広い保護（runningManagerOwning）: 走行中が使う3行は全部飛ばして inUse に数え（targeted は飛ばした後の件数）、試算にも実行にも走行中の案内行が付く。飛ばされなかった別セッションは消える',
    seed: [
      row('u1', 'sess-u', 1, 'aaa', { owned: true }),
      row('u2', 'sess-u', 2, 'aaaaaa', { owned: true }),
      row('u3', 'sess-u', 3, 'aaaaaaaaa', { owned: true, pinned: true }),
      row('u4', 'sess-u', 4, 'aaaaaaaaaaaa'),
      ...chain('sess-v', 'v', 3, { start: 10 }),
    ],
    managers: 'owning',
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'some' },
      { args: call({ minStoredBytes: 0 }), writes: 'none' },
    ],
  },
  {
    name: 'inuse-pinning',
    covers:
      'runningManagerPinning を持つ配線は保護を末尾の1本へ狭める（requireContainment: true）: 走行中が抱える3行のうち pinned の1行だけを飛ばす（inUse 1）。過去に積んだ写しは消える',
    seed: [
      row('u1', 'sess-u', 1, 'aaa', { owned: true }),
      row('u2', 'sess-u', 2, 'aaaaaa', { owned: true }),
      row('u3', 'sess-u', 3, 'aaaaaaaaa', { owned: true, pinned: true }),
      row('u4', 'sess-u', 4, 'aaaaaaaaaaaa'),
      ...chain('sess-v', 'v', 3, { start: 10 }),
    ],
    managers: 'pinning',
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'some' },
      { args: call({ minStoredBytes: 0 }), writes: 'none' },
    ],
  },
  {
    name: 'inuse-unwired',
    covers:
      'managers が配線されていない: 安全側に倒して対象の全行を inUse に数え1件も消さない（実行でも日誌を書かない）。targeted は 0',
    seed: [...chain('sess-u', 'u', 4), ...chain('sess-v', 'v', 3, { start: 10 })],
    managers: 'unwired',
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'none' },
    ],
  },
  // ---- 試算（dryRun） ----
  {
    name: 'dry-run',
    covers:
      'dryRun を省くと試算（既定）・dryRun: true・絞り込みの各軸と3軸の組が「絞り込み」と漏斗に出る・対象の id は古い順で試算でも何も書かない。dryRun: false でないと消さない（undefined も試算）',
    seed: [...chain('sess-a', 'a', 4), ...chain('sess-b', 'b', 3, { start: 10, size: 5, ch: 'b' })],
    steps: [
      { args: { summary: '既定', sessionIds: ['sess-a'] }, writes: 'none' },
      { args: { summary: '明示', sessionIds: ['sess-b'], dryRun: true }, writes: 'none' },
      {
        args: { summary: 'undefined', before: '2026-10-01T00:12:00.000Z', dryRun: undefined },
        writes: 'none',
      },
      { args: dry({ minStoredBytes: 6 }), writes: 'none' },
      {
        args: dry({
          sessionIds: ['sess-a', 'sess-b'],
          before: '2026-10-01T00:12:00.000Z',
          minStoredBytes: 5,
        }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'show-boundary',
    covers:
      '対象 id の表示は先頭 20 件: ちょうど 20 件は省略が付かない・21 件は「ほか 1 件は省略」（試算）。20 件の実行は1塊で、消した id も 20 件で省略が付かない',
    seed: [
      ...chain('sess-p', 'p', 21, { size: 1 }),
      ...chain('sess-q', 'q', 22, { start: 100, size: 1 }),
    ],
    steps: [
      { args: dry({ sessionIds: ['sess-p'] }), writes: 'none' },
      { args: dry({ sessionIds: ['sess-q'] }), writes: 'none' },
      { args: call({ sessionIds: ['sess-p'] }), writes: 'some' },
      { args: call({ sessionIds: ['sess-q'] }), writes: 'some' },
    ],
  },
  {
    name: 'default-limit',
    covers:
      '消せる行が既定の上限（500 件）を超える（501 件）: 試算で対象は 500 件・remaining 1・省略の件数。実行は 500 件を複数の塊に割って消し（省略の件数・日誌の塊の数）、続けて呼ぶと最後の 1 件、さらに続けると0件',
    seed: chain('bulk', 'b', 502, { size: 1 }),
    steps: [
      { args: dry({ sessionIds: ['bulk'] }), writes: 'none' },
      { args: call({ sessionIds: ['bulk'] }), writes: 'some' },
      { args: call({ sessionIds: ['bulk'] }), writes: 'some' },
      { args: call({ sessionIds: ['bulk'] }), writes: 'none' },
    ],
  },
  {
    name: 'sort-order',
    covers:
      '対象は積んだ順ではなく at の古い側から（同じ時刻は別セッションなら id の字面・同じセッションなら枝番の順）。試算の id の並びと、日誌の塊の「消す id」の並びが同じ',
    seed: [
      row('s1a', 'sess-s1', 30, 'aaa'),
      row('s1b', 'sess-s1', 50, 'aaaaaa'),
      row('s1c', 'sess-s1', 60, 'aaaaaaaaa'),
      row('s2a', 'sess-s2', 10, 'aaa'),
      row('s2b', 'sess-s2', 30, 'aaaaaa'),
      row('s2c', 'sess-s2', 60, 'aaaaaaaaa'),
      row('s3a', 'sess-s3', 20, 'aaa'),
      row('s3b', 'sess-s3', 20, 'aaaaaa'),
      row('s3c', 'sess-s3', 20, 'aaaaaaaaa'),
      row('s3d', 'sess-s3', 70, 'aaaaaaaaaaaa'),
    ],
    steps: [
      { args: dry({ minStoredBytes: 0 }), writes: 'none' },
      { args: call({ minStoredBytes: 0 }), writes: 'some' },
    ],
  },
  // ---- 実行 ----
  {
    name: 'execute-basic',
    covers:
      'dryRun: false で当たった行だけを消し（tombstone。行は残る）、要約・絞り込み・消す id を日誌の1行に残す。最新行・他のセッションは無傷。続けて同じ呼びは対象0件（tombstone 済みへ数え直す）',
    seed: [...chain('sess-a', 'a', 4), ...chain('sess-b', 'b', 3, { start: 10 })],
    steps: [
      { args: call({ sessionIds: ['sess-a'], summary: 'やった' }), writes: 'some' },
      { args: call({ sessionIds: ['sess-a'], summary: 'やった' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-b'], summary: '別のセッション' }), writes: 'some' },
    ],
  },
  {
    name: 'execute-axes',
    covers:
      'sessionIds は完全一致・before は境界ちょうどを含まず（+09:00 でも同じ瞬間）・minStoredBytes は境界ちょうどを含む・3軸の組み合わせの漏斗と日誌の「絞り込み」',
    seed: [
      ...chain('sess-x', 'x', 8, { start: 10, step: 10 }),
      ...chain('sess-y', 'y', 5, { start: 5, step: 10, size: 4, ch: 'y' }),
    ],
    steps: [
      {
        args: call({
          sessionIds: ['sess-x', 'sess-none'],
          before: '2026-10-01T00:30:00.000Z',
          summary: 'sessionIds と before',
        }),
        writes: 'some',
      },
      {
        args: call({
          sessionIds: ['sess-x'],
          before: '2026-10-01T01:00:00.000Z',
          minStoredBytes: 12,
          summary: '3軸（minStoredBytes は 12 ちょうどを含み、before は 60 分ちょうどを含まない）',
        }),
        writes: 'some',
      },
      {
        args: call({
          before: '2026-10-01T09:36:00+09:00',
          minStoredBytes: 4,
          summary: '+09:00 の before と minStoredBytes',
        }),
        writes: 'some',
      },
      { args: call({ minStoredBytes: 0, summary: 'minStoredBytes だけ' }), writes: 'some' },
      { args: call({ minStoredBytes: 0, summary: '全部' }), writes: 'none' },
    ],
  },
  {
    name: 'bytes-format',
    covers:
      '消した本文の合計は UTF-8 のバイト数（storedBytes の文字数とは別）で、千の位に区切りが付く（ja-JP）。行ごとの removedBytes はアーカイブの行に残る',
    seed: [
      row('j1', 'sess-j', 1, 'あ'.repeat(500)),
      row('j2', 'sess-j', 2, `${'あ'.repeat(500)}${'い'.repeat(500)}`),
      row('j3', 'sess-j', 3, `${'あ'.repeat(500)}${'い'.repeat(500)}う`),
      row('e1', 'sess-e', 4, ''),
      row('e2', 'sess-e', 5, 'x'),
    ],
    steps: [
      { args: dry({ sessionIds: ['sess-j'] }), writes: 'none' },
      { args: call({ sessionIds: ['sess-j'] }), writes: 'some' },
      { args: call({ sessionIds: ['sess-e'] }), writes: 'some' },
    ],
  },
  {
    name: 'summary-forms',
    covers:
      '要約の形: 改行・NUL を含む・前後に空白・長い要約（上限は無い）・記号。出力・日誌にどう残るか（NUL は日誌で落ちる）',
    seed: chain('sess-a', 'a', 5),
    steps: [
      {
        args: call({
          sessionIds: ['sess-a'],
          before: '2026-10-01T00:02:00.000Z',
          summary: '一行目\n二行目\u0000です',
        }),
        writes: 'some',
      },
      {
        args: call({
          sessionIds: ['sess-a'],
          before: '2026-10-01T00:03:00.000Z',
          summary: '  前後に空白  ',
        }),
        writes: 'some',
      },
      {
        args: call({
          sessionIds: ['sess-a'],
          before: '2026-10-01T00:04:00.000Z',
          summary: LONG_SUMMARY,
        }),
        writes: 'some',
      },
      {
        args: call({
          sessionIds: ['sess-a'],
          before: '2026-10-01T00:05:00.000Z',
          summary: '**強調** `code` [x](y)',
        }),
        writes: 'some',
      },
    ],
  },
  // ---- 塊（日誌の1行）が複数 ----
  {
    name: 'many-ok',
    covers:
      '対象が複数の塊に割れる（300 字の id・11 件ずつ）・消した id が 20 件を超えて出力は省略・全 id は日誌に塊の数だけの行で残る・試算も同じ省略・続けて呼ぶと0件',
    seed: [...chain(MID_SESSION, 'M', 26), ...chain('sess-other', 'o', 2, { start: 100 })],
    steps: [
      { args: dry({ sessionIds: [MID_SESSION] }), writes: 'none' },
      { args: call({ sessionIds: [MID_SESSION], summary: '多数' }), writes: 'some' },
      { args: call({ sessionIds: [MID_SESSION], summary: '多数' }), writes: 'none' },
    ],
  },
  {
    name: 'race',
    covers:
      '選んだのに消せなかった: 1塊の途中の行を別の経路が先に消した（remove が already）・塊が丸ごと競合・「消せなかった」の注意と打ち消しの行（消せなかった id だけを名指しする）。次の呼びは対象0件',
    seed: longChain(9),
    steps: [
      {
        args: call({ sessionIds: [LONG_SESSION], summary: '競合' }),
        writes: 'some',
        hooks: { raceFirst: ['L2', 'L3', 'L4'] },
      },
      { args: call({ sessionIds: [LONG_SESSION], summary: '残り' }), writes: 'none' },
    ],
  },
  {
    name: 'race-missing',
    covers:
      'remove が missing を返す（行が無かった）: 競合と同じ扱いで消せなかったに数え、打ち消しの行を足す。消えていない行は次の呼びで消せる',
    seed: chain('sess-a', 'a', 4),
    steps: [
      {
        args: call({ sessionIds: ['sess-a'] }),
        writes: 'some',
        hooks: { missingFirst: ['a1'] },
      },
      { args: call({ sessionIds: ['sess-a'] }), writes: 'some' },
    ],
  },
  // ---- 消す側が落ちる ----
  {
    name: 'remove-fails',
    covers:
      '塊の中で remove が投げる: 日誌には先の行と「確かめられていない」行（消えた分を除いた id）・例外がそのまま出る。1回目は1本目で落ちる・2回目は塊の途中（消えた1件は確かめられている側）・3回目は2塊目の頭で落ちる（1塊目は消えて日誌に在る）→ 直して残りを消す',
    seed: longChain(5),
    steps: [
      {
        args: call({ sessionIds: [LONG_SESSION] }),
        writes: 'some',
        hooks: { removeFailsAt: [1] },
      },
      {
        args: call({ sessionIds: [LONG_SESSION] }),
        writes: 'some',
        hooks: { removeFailsAt: [2] },
      },
      {
        args: call({ sessionIds: [LONG_SESSION] }),
        writes: 'some',
        hooks: { removeFailsAt: [3] },
      },
      { args: call({ sessionIds: [LONG_SESSION] }), writes: 'some' },
    ],
  },
  // ---- 日誌が書けない ----
  {
    name: 'journal-fails-single',
    covers:
      '唯一の塊の先の日誌が書けない: 1件も消さずに投げる（行為は起きていない）。次の呼びで日誌が戻れば消える',
    seed: chain('sess-a', 'a', 4),
    journalFailsAt: [1],
    steps: [
      { args: call({ sessionIds: ['sess-a'], summary: '日誌が落ちる' }), writes: 'none' },
      { args: call({ sessionIds: ['sess-a'], summary: '日誌が戻った' }), writes: 'some' },
    ],
  },
  {
    name: 'journal-fails-first-of-many',
    covers: '複数の塊の1塊目の日誌が書けない（日誌の書き込みの1回目）: 後ろの塊も消さずに投げる',
    seed: longChain(9),
    journalFailsAt: [1],
    steps: [{ args: call({ sessionIds: [LONG_SESSION] }), writes: 'none' }],
  },
  {
    name: 'journal-fails-mid',
    covers:
      '途中の塊（2/4）の先の日誌が書けない: その塊と以降は消さずに止め、前の 1 塊は消えていて日誌に在る（投げず、どこまで消したかを返す）。日誌が戻ってから同じ絞り込みで続きを消す',
    seed: longChain(9),
    journalFailsAt: [2],
    steps: [
      { args: call({ sessionIds: [LONG_SESSION] }), writes: 'some' },
      { args: call({ sessionIds: [LONG_SESSION] }), writes: 'some' },
    ],
  },
  {
    name: 'journal-fails-after-race',
    covers:
      '1塊目が丸ごと競合（消した件数は 0・書いた塊は 1）のあと、2塊目の先の日誌が書けない（日誌の3回目）: 投げずに止めた案内を返す（書いた塊が在るので「行為は起きていない」ではない）',
    seed: longChain(5),
    journalFailsAt: [3],
    steps: [
      {
        args: call({ sessionIds: [LONG_SESSION] }),
        writes: 'some',
        hooks: { raceFirst: ['L1', 'L2'] },
      },
    ],
  },
  {
    name: 'journal-fails-retraction',
    covers:
      '打ち消しの行の日誌が書けない（先の行は書けて、競合で消せなかった id が在り、打ち消しの書き込み＝2回目が落ちる）: 打ち消しは黙って諦める（best effort）。出力は競合の注意を付けて普段どおり',
    seed: chain('sess-a', 'a', 3),
    journalFailsAt: [2],
    steps: [
      {
        args: call({ sessionIds: ['sess-a'] }),
        writes: 'some',
        hooks: { raceFirst: ['a1'] },
      },
    ],
  },
  {
    name: 'journal-fails-unconfirmed',
    covers:
      '消す操作が落ち、さらに「確かめられていない」行の日誌も書けない（2回目が落ちる）: 補いの行は黙って諦め、元の例外が出る',
    seed: chain('sess-a', 'a', 2),
    journalFailsAt: [2],
    steps: [
      {
        args: call({ sessionIds: ['sess-a'] }),
        writes: 'some',
        hooks: { removeFailsAt: [1] },
      },
    ],
  },
  // ---- ストアの読みが落ちる ----
  {
    name: 'store-read-fails',
    covers:
      '墓標の一覧が落ちる（先に読む）・アーカイブの一覧が落ちる: 例外がそのまま出る。試算でも実行でもアーカイブ・日誌・墓標は変わらない。墓標が落ちるときはアーカイブの一覧を読まない',
    seed: chain('sess-a', 'a', 3),
    steps: [
      { args: dry({ sessionIds: ['sess-a'] }), writes: 'none', hooks: { gravesFail: true } },
      { args: call({ sessionIds: ['sess-a'] }), writes: 'none', hooks: { gravesFail: true } },
      { args: dry({ sessionIds: ['sess-a'] }), writes: 'none', hooks: { listFails: true } },
      { args: call({ sessionIds: ['sess-a'] }), writes: 'none', hooks: { listFails: true } },
      {
        args: call({ sessionIds: ['sess-a'] }),
        writes: 'none',
        hooks: { listFails: true, gravesFail: true },
      },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

// ---- 記録の形 ----

interface PinnedOutput {
  length: number;
  text: string;
  isError: boolean;
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとのアーカイブの行（`archive.list()` のまま） */
  archive: Record<string, unknown>[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 呼んだあとの墓標の列 */
  graves: Record<string, unknown>[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Snapshot {
  archive: Record<string, unknown>[];
  journal: Record<string, unknown>[];
  graves: Record<string, unknown>[];
}

async function snapshot(base: Stores): Promise<Snapshot> {
  return {
    archive: plain(await base.archive.list()) as unknown as Record<string, unknown>[],
    journal: plain(await base.journal.list({ order: 'asc' })) as unknown as Record<
      string,
      unknown
    >[],
    graves: plain(await base.sessions.listTranscriptGraves()) as unknown as Record<
      string,
      unknown
    >[],
  };
}

function freshHooks(): Hooks {
  return {
    raceFirst: [],
    missingFirst: [],
    removeFailsAt: [],
    listFails: false,
    gravesFail: false,
    done: new Set(),
    removeCalls: 0,
  };
}

function withHooks(
  base: Stores,
  hooks: Hooks,
  failJournalAt: readonly number[],
  idOf: (label: string) => string,
): Stores {
  let journalCalls = 0;
  return {
    ...base,
    archive: {
      ...base.archive,
      list: () => {
        if (hooks.listFails) return Promise.reject(new Error('アーカイブの一覧が読めない'));
        return base.archive.list();
      },
      remove: async (id) => {
        hooks.removeCalls += 1;
        if (hooks.removeFailsAt.includes(hooks.removeCalls)) {
          throw new Error('アーカイブの削除が落ちた');
        }
        if (hooks.missingFirst.some((label) => idOf(label) === id)) return { kind: 'missing' };
        if (hooks.raceFirst.some((label) => idOf(label) === id) && !hooks.done.has(id)) {
          hooks.done.add(id);
          await base.archive.remove(id);
        }
        return base.archive.remove(id);
      },
    },
    sessions: {
      ...base.sessions,
      listTranscriptGraves: () => {
        if (hooks.gravesFail) return Promise.reject(new Error('墓標の一覧が読めない'));
        return base.sessions.listTranscriptGraves();
      },
    },
    journal: {
      ...base.journal,
      append: (entry) => {
        journalCalls += 1;
        if (failJournalAt.includes(journalCalls)) return Promise.reject(new Error('日誌が落ちた'));
        return base.journal.append(entry);
      },
    },
  };
}

async function seedRows(
  base: Stores,
  scenario: Scenario,
): Promise<{ ids: Map<string, string>; owned: Set<string>; pinned: Set<string> }> {
  const ids = new Map<string, string>();
  const owned = new Set<string>();
  const pinned = new Set<string>();
  for (const seed of scenario.seed) {
    vi.setSystemTime(new Date(minuteMs(seed.minute)));
    const id = seed.fingerprintless
      ? await seedFingerprintlessArchiveRow(base.archive, seed.session, seed.body)
      : (await base.archive.archive(seed.session, seed.body)).id;
    ids.set(seed.label, id);
    if (seed.removed) await base.archive.remove(id);
    if (seed.grave) await base.sessions.addTranscriptGrave({ archiveId: id });
    if (seed.owned) owned.add(id);
    if (seed.pinned) pinned.add(id);
  }
  for (const archiveId of scenario.danglingGraves ?? []) {
    await base.sessions.addTranscriptGrave({ archiveId });
  }
  return { ids, owned, pinned };
}

function buildManagers(
  mode: ManagersMode,
  owned: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): ManagerPool | undefined {
  switch (mode) {
    case 'unwired':
      return undefined;
    case 'idle':
      return { runningManagerOwning: () => undefined } as unknown as ManagerPool;
    case 'owning':
      return {
        runningManagerOwning: (id: string) => (owned.has(id) ? 'mgr-running' : undefined),
      } as unknown as ManagerPool;
    case 'pinning':
      return {
        runningManagerOwning: (id: string) => (owned.has(id) ? 'mgr-running' : undefined),
        runningManagerPinning: (id: string) => (pinned.has(id) ? 'mgr-running' : undefined),
      } as unknown as ManagerPool;
  }
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  const seeded = await seedRows(base, scenario);
  const idOf = (label: string): string => {
    const id = seeded.ids.get(label);
    if (id === undefined) throw new Error(`場面 ${scenario.name}: 行 ${label} が無い`);
    return id;
  };
  const hooks = freshHooks();
  const stores = withHooks(base, hooks, scenario.journalFailsAt ?? [], idOf);
  const managers = buildManagers(scenario.managers ?? 'idle', seeded.owned, seeded.pinned);
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(managers === undefined ? {} : { managers }),
  };
  const found = createCloneTools(context).find((entry) => entry.name === 'archive_remove_many');
  if (!found) throw new Error('archive_remove_many が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    Object.assign(hooks, freshHooks(), step.hooks ?? {});
    const before = await snapshot(base);
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(step.args as never, {} as never);
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = { length: text.length, text, isError: result.isError === true, thrown: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = { length: text.length, text, isError: true, thrown: true };
    }
    const after = await snapshot(base);
    // 次の呼びへ口を持ち越さない（この呼びの仕込みだけが効く）
    Object.assign(hooks, freshHooks());
    const wrote =
      JSON.stringify(before.archive) !== JSON.stringify(after.archive) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      archive: after.archive,
      journal: after.journal.slice(before.journal.length),
      graves: after.graves,
    });
    // この道具は墓標を書き換えない
    expect(
      after.graves,
      `場面 ${stepKey(scenario, index)}: 墓標の列が呼ぶ前から変わった（この道具は墓標を書き換えない）`,
    ).toEqual(before.graves);
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、アーカイブ・日誌・墓標が呼ぶ前と同じ（ここで確かめる。json にも「呼んだあと」が残る）
      expect(
        after.archive,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、アーカイブが呼ぶ前から変わった`,
      ).toEqual(before.archive);
      expect(
        after.journal.length,
        `場面 ${stepKey(scenario, index)} は書き込みが起きないはずだが、日誌に行が足された`,
      ).toBe(before.journal.length);
    }
  }
  return results;
}

async function runAll(): Promise<Record<string, PinnedStep>> {
  const out: Record<string, PinnedStep> = {};
  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    for (const [index, result] of results.entries()) out[stepKey(scenario, index)] = result;
  }
  return out;
}

describe('archive_remove_many の出力と呼んだあとの状態の固定（場面ごとの出力の全文・アーカイブの行・日誌の行）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  }, 120_000);

  afterAll(() => {
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
      expect(actual[key]?.output.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの出力の字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.output.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.output.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.output.length);
    }
  });

  it('書き込みが起きなかったと宣言した場面は、実際にも書き込みが起きていない（その逆も）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        expect(actual[key]?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(
          step.writes === 'some',
        );
      }
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);

      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
      });

      it(`${key} の呼んだあとのアーカイブの行と墓標の列が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.archive.map((entry) => entry.id),
          `場面 ${key} のアーカイブ: 行の並び（id）が変わった`,
        ).toEqual(want?.archive.map((entry) => entry.id));
        for (const [rowIndex, wantRow] of (want?.archive ?? []).entries()) {
          expect(
            got?.archive[rowIndex],
            `場面 ${key} のアーカイブの ${String(wantRow.id).slice(0, 40)}（${String(rowIndex)} 行目）が固定値からずれた（storedBytes・removedAt・removedBytes・continuity など）`,
          ).toEqual(wantRow);
        }
        expect(got?.graves, `場面 ${key} の墓標の列が変わった`).toEqual(want?.graves);
        expect(got?.wrote, `場面 ${key} の書き込みの有無が変わった`).toBe(want?.wrote);
      });

      it(`${key} の呼んだあとに日誌へ足された行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.journal.length,
          `場面 ${key} の日誌: 足された行の数が変わった: 固定値 ${String(want?.journal.length)} 行 → いま ${String(got?.journal.length)} 行`,
        ).toBe(want?.journal.length);
        expect(
          got?.journal,
          `場面 ${key} の日誌: 足された行（種類・本文・grounds・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・アーカイブ・日誌になる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const step = (key: string): PinnedStep | undefined => actual[key];
    const journal = (key: string): Record<string, unknown>[] => step(key)?.journal ?? [];
    const decisionOf = (key: string, at: number): string => {
      const entry = journal(key)[at];
      return typeof entry?.decision === 'string' ? entry.decision : '';
    };
    /** 呼んだあとに tombstone 済みの行の id（アーカイブの並びのまま） */
    const removedOf = (key: string): string[] =>
      (step(key)?.archive ?? [])
        .filter((entry) => entry.removedAt !== undefined)
        .map((entry) => String(entry.id));
    const skipped = (key: string): string => /skipped: .*/.exec(text(key))?.[0] ?? '';
    // 引数の検査
    expect(text('arg-errors#1')).toBe('sessionIds は使えない（1件以上）。');
    expect(text('arg-errors#2')).toContain('0 番目（0起点）が空文字');
    expect(text('arg-errors#5')).toBe('summary は使えない（1文字以上のみ）。');
    expect(text('arg-errors#6')).toContain('空白だけの値は空と同じ');
    expect(text('arg-errors#9')).toContain('どれも渡さない呼びは断る');
    expect(text('arg-errors#11')).toContain('日時として読めない、または時差が無い');
    expect(text('arg-errors#15')).toBe('minStoredBytes -1 は使えない（0以上の整数のみ）。');
    // 検査の順序（先に当たった違反だけ）
    expect(text('arg-errors#19')).toContain('before に渡された');
    expect(text('arg-errors#20')).toContain('sessionIds は使えない（1件以上）');
    expect(text('arg-errors#22')).toBe('before は使えない（1文字以上のみ）。');
    expect(text('arg-errors#23')).toContain('summary は使えない');
    // 0件
    expect(text('zero-empty#1')).toContain('アーカイブそのものに行が無い');
    expect(text('zero-nomatch#1')).toContain('絞り込みが外れている');
    expect(text('zero-nomatch#4')).toContain('アーカイブ全 6 行 → 絞り込みで 0 件');
    // 全部飛ばされて対象が0件（日誌も書かない）
    expect(text('zero-targets-skipped#1')).toContain('この呼びで消すのは 0 件（当たったのは 7 件');
    expect(skipped('zero-targets-skipped#2')).toBe(
      'skipped: protected(墓標) 1 / alreadyRemoved 1 / newest 4 / notContained 1 / inUse(走行中) 0',
    );
    expect(text('zero-targets-skipped#2')).toContain('**0 件の本文を tombstone した**');
    expect(journal('zero-targets-skipped#2')).toEqual([]);
    // 飛ばす行の判定
    expect(skipped('skip-kinds#1')).toBe(
      'skipped: protected(墓標) 3 / alreadyRemoved 0 / newest 4 / notContained 3 / inUse(走行中) 0',
    );
    expect(skipped('skip-kinds#3')).toContain('alreadyRemoved 2');
    expect(removedOf('skip-kinds#2')).toHaveLength(3);
    expect(removedOf('skip-kinds#2').filter((id) => id.startsWith('sess-m-'))).toHaveLength(3);
    expect(skipped('anchor-rules#1')).toBe(
      'skipped: protected(墓標) 0 / alreadyRemoved 1 / newest 1 / notContained 1 / inUse(走行中) 0',
    );
    expect(text('anchor-rules#2')).toContain('before=2026-10-01T00:04:00.000Z');
    // 走行中のマネージャー
    expect(skipped('inuse-idle#1')).toContain('inUse(走行中) 0');
    expect(text('inuse-idle#1')).not.toContain(
      '走行中のマネージャーが使っている行は一括では開けない',
    );
    expect(skipped('inuse-owning#1')).toContain('inUse(走行中) 3');
    expect(text('inuse-owning#1')).toContain('この呼びで消すのは 2 件（当たったのは 7 件');
    expect(text('inuse-owning#2')).toContain(
      '走行中のマネージャーが使っている行は一括では開けない',
    );
    expect(skipped('inuse-pinning#1')).toContain('inUse(走行中) 1');
    expect(text('inuse-pinning#2')).toContain('**4 件の本文を tombstone した**');
    expect(skipped('inuse-unwired#1')).toContain('inUse(走行中) 5');
    expect(text('inuse-unwired#2')).toContain('**0 件の本文を tombstone した**');
    expect(journal('inuse-unwired#2')).toEqual([]);
    // 試算
    expect(text('dry-run#1')).toContain('**試算（dryRun）。1件も消していない。**');
    expect(text('dry-run#3')).toContain('絞り込み: before=2026-10-01T00:12:00.000Z');
    expect(text('dry-run#5')).toContain(
      '絞り込み: sessionIds=[sess-a, sess-b] / before=2026-10-01T00:12:00.000Z / minStoredBytes=5',
    );
    expect(text('show-boundary#1')).not.toContain('省略');
    expect(text('show-boundary#2')).toContain('…ほか 1 件は省略');
    expect(text('show-boundary#4')).toContain(
      '…ほか 1 件は省略（**全 id は日誌に 1 件に分けて残してある**）',
    );
    expect(text('default-limit#1')).toContain(
      'この呼びで消すのは 500 件（当たったのは 502 件。1回の上限 500 件）',
    );
    expect(text('default-limit#1')).toContain(
      'remaining（limit に溢れて対象にすらならなかった件数）: 1',
    );
    expect(text('default-limit#2')).toContain('**500 件の本文を tombstone した**');
    expect(text('default-limit#2')).toContain('全 id は日誌に 5 件に分けて残してある');
    expect(journal('default-limit#2')).toHaveLength(5);
    expect(text('default-limit#3')).toContain('**1 件の本文を tombstone した**');
    expect(text('sort-order#1')).toContain(
      '対象の id（先頭 7 件）: sess-s2-2026-10-01T00-10-00-000Z.jsonl, sess-s3-2026-10-01T00-20-00-000Z.jsonl, sess-s3-2026-10-01T00-20-00-000Z-2.jsonl',
    );
    // 実行
    expect(text('execute-basic#1')).toContain('**3 件の本文を tombstone した**（理由: やった）');
    expect(journal('execute-basic#1')).toHaveLength(1);
    expect(journal('execute-basic#1')[0]?.type).toBe('decision');
    expect(decisionOf('execute-basic#1', 0)).toContain('（1/1 塊目、この塊は 3 件）: やった');
    expect(decisionOf('execute-basic#1', 0)).toContain('絞り込み: sessionIds=[sess-a]');
    expect(removedOf('execute-basic#1')).toHaveLength(3);
    expect(text('execute-basic#2')).toContain('alreadyRemoved 3');
    expect(text('execute-axes#2')).toContain('minStoredBytes=12');
    expect(text('execute-axes#2')).toContain('**2 件の本文を tombstone した**');
    expect(text('execute-axes#3')).toContain('**5 件の本文を tombstone した**');
    expect(text('bytes-format#2')).toContain('消した本文の合計: 4,500 バイト');
    expect(decisionOf('summary-forms#1', 0)).toContain('一行目\n二行目です');
    expect(text('summary-forms#3')).toContain(LONG_SUMMARY);
    // 複数の塊
    expect(text('many-ok#1')).toContain('この呼びで消すのは 25 件');
    expect(text('many-ok#1')).toContain('…ほか 5 件は省略');
    expect(text('many-ok#2')).toContain(
      '…ほか 5 件は省略（**全 id は日誌に 3 件に分けて残してある**）',
    );
    expect(journal('many-ok#2')).toHaveLength(3);
    expect(decisionOf('many-ok#2', 0)).toContain('（1/3 塊目、この塊は 11 件）');
    expect(decisionOf('many-ok#2', 2)).toContain('（3/3 塊目、この塊は 3 件）');
    // 競合
    expect(text('race#1')).toContain('⚠ 対象 8 件のうち 3 件は消せなかった');
    expect(text('race#1')).toContain('**5 件の本文を tombstone した**');
    expect(journal('race#1')).toHaveLength(6);
    expect(decisionOf('race#1', 1)).toContain('直前の行を一部打ち消す');
    expect(text('race-missing#1')).toContain('⚠ 対象 3 件のうち 1 件は消せなかった');
    expect(journal('race-missing#1')).toHaveLength(2);
    expect(text('race-missing#2')).toContain('**1 件の本文を tombstone した**');
    // 消す側が落ちる
    expect(text('remove-fails#1')).toBe('アーカイブの削除が落ちた');
    expect(step('remove-fails#1')?.output.thrown).toBe(true);
    expect(decisionOf('remove-fails#1', 1)).toContain('確かめられていない');
    expect(journal('remove-fails#2')).toHaveLength(2);
    expect(journal('remove-fails#3')).toHaveLength(3);
    expect(text('remove-fails#4')).toContain('**1 件の本文を tombstone した**');
    // 日誌が落ちる
    expect(text('journal-fails-single#1')).toContain(
      '⚠⚠ 未記録・行為は起きていない・やり直してよい',
    );
    expect(step('journal-fails-single#1')?.output.thrown).toBe(true);
    expect(removedOf('journal-fails-single#1')).toEqual([]);
    expect(text('journal-fails-first-of-many')).toContain('行為は起きていない');
    expect(text('journal-fails-mid#1').split('\n')[0]).toContain(
      '⚠⚠ 2/4 塊目の先の日誌が書けなかった',
    );
    expect(text('journal-fails-mid#1')).toContain('止める前の 1 塊は消えていて日誌にも残っている');
    expect(text('journal-fails-after-race')).toContain('2/2 塊目の先の日誌が書けなかった');
    expect(text('journal-fails-after-race')).toContain('⚠ 対象 4 件のうち 2 件は消せなかった');
    expect(text('journal-fails-retraction')).toContain('⚠ 対象 2 件のうち 1 件は消せなかった');
    expect(journal('journal-fails-retraction')).toHaveLength(1);
    expect(text('journal-fails-unconfirmed')).toBe('アーカイブの削除が落ちた');
    expect(journal('journal-fails-unconfirmed')).toHaveLength(1);
    // ストアの読みが落ちる（墓標が先）
    expect(text('store-read-fails#1')).toBe('墓標の一覧が読めない');
    expect(text('store-read-fails#3')).toBe('アーカイブの一覧が読めない');
    expect(text('store-read-fails#5')).toBe('墓標の一覧が読めない');
  });
});
