import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import type { RecentDenial } from './denial-shape.js';
import type { PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `request_permission` の出力（全文と字数）と、呼んだあとの状態（承認の行・日誌へ足された行）・呼びの並び
// （context.recentDenials・conversationId・flushReply・jobs.putApproval・journal.append・context.noteQuestionAsked・context.emit など）を、
// 場面ごとにコミットした固定値（clone-tools-approval-request-permission-output-pin.json）と丸ごと比べる。
// `clone-tools-approval.ts` の `tool('request_permission', …)`（ハンドラ約 55 行の長い式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか。例外なら name と message）
//   - approvals: 呼んだあとの承認の全行（ストアから読んだ形のまま）
//   - journal: 呼んだあとに日誌へ足された行（書けなかった行は含まない）
//   - calls: 呼びの並び（context への読み・知らせ、ストアの書き込み。渡した引数と成否をそのまま）
//   - stderr: 記録を落としたときに stderr へ残る跡（noteDroppedRecord。時刻は固定した時計）
//   - wrote: 承認か日誌のどちらかが呼ぶ前から変わったか。断った場面・承認が書けない場面は false で、承認・日誌が呼ぶ前と同じであることも別に確かめる
//
// 固定値の作り直し（意図して出力・状態を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_REQUEST_PERMISSION_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-approval-request-permission-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-approval-request-permission-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたか、承認・日誌・呼びのどこが動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。呼びごとに基準時刻から 1 分ずつ進めて呼ぶ。
// 乱数: 承認の id は `randomUUID()` で作られるので、`node:crypto` の randomUUID を呼び順に
// 00000000-0000-4000-8000-000000000001, …02, … を返すものへ差し替える。番号は場面ごとに 1 から数え直す（場面の中では呼びをまたいで進む）。
// 日誌の id はインメモリの採番（id-1, id-2, …）で、場面ごとにストアを作り直すので毎回同じ。
// 同じ場面で続けて呼ぶと状態が積み上がる（`名前#1`・`名前#2` と呼びごとに固定する）。
//
// 直前の拒否の添えは context.recentDenials に渡す配列で作る（clone.ts の RecentDenialLog と同じ形の RecentDenial）。
// 承認の行の taskIds は context.currentTaskIds、会話の結び付きは context.workConversationId（無ければ conversationId）で作る。
//
// 作れない分岐（理由）:
//   - `describePermissionEvidence` の「規則から道具と先頭の語が取れない」のうち、道具が取れない場合: 検算を通る規則は必ず `Bash(` で始まるので、道具は常に Bash。
//     先頭の語が取れない場合（先頭が `.` の語・鍵らしい長い語）だけ作る。
//   - `validatePermissionRequest` の `parsePermissionRule` が `command.length === 0` 以外の理由で ok:false になる経路は、形の断り・空・メタ文字の3つで尽きる。
//   - zod の入力スキーマが断る型違い（rule が文字列でない等）は、ハンドラを直に呼ぶこの試験では通らない。reason が undefined の場面だけ、
//     ハンドラを直に呼んだときに起こる（reason-undefined。実際の呼びでは z.string() が先に断る）。

const uuidState = vi.hoisted(() => ({ drawn: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
      uuidState.drawn += 1;
      return `00000000-0000-4000-8000-${String(uuidState.drawn).padStart(12, '0')}`;
    },
  };
});

type Args = Record<string, unknown>;

/** 呼びが起こした書き込みの形。none は承認も日誌も変わらない。both は承認の行と日誌の両方。approval-only は承認の行だけ（日誌が書けない） */
type Writes = 'none' | 'both' | 'approval-only';

interface Hooks {
  /** jobs.putApproval が落ちる（行は書かれない） */
  putFails?: boolean;
  /** journal.append が落ちる */
  journalFails?: boolean;
  /** context.flushReply が落ちる */
  flushFails?: boolean;
}

interface Step {
  args: Args;
  writes: Writes;
  hooks?: Hooks;
}

interface Ctx {
  /** context.conversationId の値（既定は undefined） */
  conv?: string;
  /** context.workConversationId を渡す。string はその値、null は undefined を返す。省略は口ごと渡さない（conversationId へ倒れる） */
  work?: string | null;
  /** context.currentTaskIds を渡す。省略は口ごと渡さない */
  taskIds?: string[];
  /** context.recentDenials の中身。null は口ごと渡さない。既定は空の配列 */
  denials?: RecentDenial[] | null;
  /** context.flushReply を渡さない */
  noFlush?: boolean;
  /** context.noteQuestionAsked を渡さない */
  noNote?: boolean;
}

interface Scenario {
  name: string;
  /** 読み手のための整理。表に出す */
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  ctx?: Ctx;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const PIN_URL = new URL(
  './clone-tools-approval-request-permission-output-pin.json',
  import.meta.url,
);
const UPDATE = process.env.UPDATE_REQUEST_PERMISSION_PIN === '1';

/** 呼びの n 番目（0 始まり）の時刻。基準の 1 分後から 1 分ずつ進む */
function callTime(index: number): string {
  return new Date(Date.parse(BASE_ISO) + (index + 1) * 60_000).toISOString();
}

function u(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const OK_RULE = 'Bash(gh release edit:*)';
const OK_ALLOW = 'gh release edit v1 --draft';
const OK_DENY = 'gh release delete v1';
const OK_REASON = 'リリースの下書きを直したい';

function rq(overrides: Args = {}): Args {
  return {
    rule: OK_RULE,
    allows: [OK_ALLOW],
    denies: [OK_DENY],
    reason: OK_REASON,
    ...overrides,
  };
}

function denial(
  overrides: Partial<RecentDenial> & Pick<RecentDenial, 'at' | 'tool'>,
): RecentDenial {
  return overrides;
}

const D_FULL = denial({
  at: '2026-10-29T00:00:00.000Z',
  tool: 'Bash',
  headWord: 'gh',
  reasonType: 'classifier',
  reason: '外へ出す操作で、人間の確認が要る',
  message: 'Permission to use Bash has been denied.',
});

const LONG = 'あ'.repeat(450);

const SCENARIOS: Scenario[] = [
  // ---- 規則の形の断り ----
  {
    name: 'rule-invalid-shape',
    group: '規則の形の断り',
    covers:
      'Bash(…) の形でない規則（包みが無い・小文字・道具が違う・末尾に空白・閉じ括弧が無い・空文字・NUL を落とすと中身が空）: 形の断り。検算の前に断るので allows / denies は見ない。承認も日誌も context への知らせも無い',
    steps: [
      { args: rq({ rule: 'gh release edit' }), writes: 'none' },
      { args: rq({ rule: 'bash(gh release edit)' }), writes: 'none' },
      { args: rq({ rule: 'Read(gh release edit)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh release edit) ' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh release edit' }), writes: 'none' },
      { args: rq({ rule: '' }), writes: 'none' },
      { args: rq({ rule: 'Bash(\u0000)' }), writes: 'none' },
      { args: rq({ rule: 'Bash()', allows: [], denies: [] }), writes: 'none' },
    ],
  },
  {
    name: 'rule-invalid-empty',
    group: '規則の形の断り',
    covers:
      '包みはあるが中身が空（Bash(:*) と、NUL を落とすと Bash(:*) になる規則）: 「規則の中身が空である」の断り',
    steps: [
      { args: rq({ rule: 'Bash(:*)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(\u0000:*)' }), writes: 'none' },
    ],
  },
  {
    name: 'rule-invalid-metachar',
    group: '規則の形の断り',
    covers:
      '規則の中身にシェルの区切り・展開文字（; & | $ ` ( ) < > \\ 改行 復帰）: 「シェルの区切り・展開文字」の断り。前方一致の :* を外した中身を見る',
    steps: [
      { args: rq({ rule: 'Bash(gh release edit; rm -rf /:*)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh release edit && ls)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh release edit | cat)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh pr view$(whoami))' }), writes: 'none' },
      { args: rq({ rule: 'Bash(echo `id`)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(echo a > b)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh a\\ b)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh a\nb)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(gh a\rb:*)' }), writes: 'none' },
      { args: rq({ rule: 'Bash(f(x))' }), writes: 'none' },
    ],
  },
  // ---- allows / denies の検算の断り ----
  {
    name: 'lists-empty',
    group: 'allows / denies の検算の断り',
    covers:
      'allows が空・denies が空・両方空: 空の断り（allows が先）。規則が不正なら規則の断りが先。reason の検査より先',
    steps: [
      { args: rq({ allows: [] }), writes: 'none' },
      { args: rq({ denies: [] }), writes: 'none' },
      { args: rq({ allows: [], denies: [] }), writes: 'none' },
      { args: rq({ allows: [], reason: '' }), writes: 'none' },
    ],
  },
  {
    name: 'allow-mismatch',
    group: 'allows / denies の検算の断り',
    covers:
      'allows が規則に一致しない: 最初に一致しない1件だけを断りに載せる（2件目以降は見ない）。語境界（editfoo）・別のコマンド・空文字・コマンド側のメタ文字（; や改行）・閉じていない引用符は不一致。denies は見ない',
    steps: [
      { args: rq({ allows: ['gh release view v1'] }), writes: 'none' },
      { args: rq({ allows: [OK_ALLOW, 'gh release editfoo'] }), writes: 'none' },
      { args: rq({ allows: ['gh release edit; rm -rf /'] }), writes: 'none' },
      { args: rq({ allows: ['gh release edit v1\nrm x'] }), writes: 'none' },
      { args: rq({ allows: [''] }), writes: 'none' },
      { args: rq({ allows: ['gh release edit "v1'] }), writes: 'none' },
      { args: rq({ allows: ['gh release edit # x'] }), writes: 'none' },
      { args: rq({ allows: ['gh a', 'gh b'], denies: ['gh release edit x'] }), writes: 'none' },
    ],
  },
  {
    name: 'allow-mismatch-exact',
    group: 'allows / denies の検算の断り',
    covers:
      '完全一致の規則（:* なし）で allows が規則そのものでない（後ろに引数が付く）: 不一致の断り',
    steps: [
      {
        args: rq({ rule: 'Bash(gh pr view 12)', allows: ['gh pr view 12 --web'] }),
        writes: 'none',
      },
    ],
  },
  {
    name: 'deny-matches',
    group: 'allows / denies の検算の断り',
    covers:
      'denies が規則に一致してしまう: 最初に一致する1件だけを断りに載せる。規則そのもの（先頭の語まるごと）・語境界で続く引数は一致。allows の不一致が先に断られる',
    steps: [
      { args: rq({ denies: ['gh release edit v2'] }), writes: 'none' },
      { args: rq({ denies: [OK_DENY, 'gh release edit'] }), writes: 'none' },
      { args: rq({ denies: ['gh release edit'] }), writes: 'none' },
      { args: rq({ denies: ['gh release edit "a (b)"'] }), writes: 'none' },
      { args: rq({ allows: ['gh nope'], denies: ['gh release edit v2'] }), writes: 'none' },
    ],
  },
  {
    name: 'deny-matches-exact',
    group: 'allows / denies の検算の断り',
    covers: '完全一致の規則で denies が規則そのものと同じ: 一致してしまう断り',
    steps: [
      {
        args: rq({
          rule: 'Bash(gh pr view 12)',
          allows: ['gh pr view 12'],
          denies: ['gh pr view 12'],
        }),
        writes: 'none',
      },
    ],
  },
  // ---- reason の断り ----
  {
    name: 'reason-invalid',
    group: 'reason の断り',
    covers:
      'reason が空・NUL だけ・空白だけ・改行とタブと全角空白だけ・NUL と空白だけ: 検算を通ったあとの断り。長さの断り（空・NUL だけ）と空白だけの断りは文言が違う。承認も日誌も context への知らせも無い',
    steps: [
      { args: rq({ reason: '' }), writes: 'none' },
      { args: rq({ reason: '\u0000' }), writes: 'none' },
      { args: rq({ reason: '   ' }), writes: 'none' },
      { args: rq({ reason: '\n\t　' }), writes: 'none' },
      { args: rq({ reason: ' \u0000 ' }), writes: 'none' },
    ],
  },
  {
    name: 'reason-undefined',
    group: 'reason の断り',
    covers:
      'reason が undefined（ハンドラを直に呼んだときだけ。2つの検査は undefined を通す）・鍵ごと無い: 断らずに積み、質問文は「理由: undefined」になり、承認の行に context が付かない',
    steps: [
      { args: rq({ reason: undefined }), writes: 'both' },
      { args: { rule: OK_RULE, allows: [OK_ALLOW], denies: [OK_DENY] }, writes: 'both' },
    ],
  },
  // ---- 積めた（応答と承認の行・日誌・呼びの並び） ----
  {
    name: 'ok-prefix',
    group: '積めた',
    covers:
      '前方一致の規則で通る: 質問文（理由・通る例・通らない例・直前の拒否の添え・定型文）・承認の行（id・createdAt・question・context=reason・permissionRequest。会話・taskIds の欄は付かない）・日誌は escalation 1行・呼びは flushReply → putApproval → journal.append → noteQuestionAsked(undefined) → emit',
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'ok-exact',
    group: '積めた',
    covers:
      '完全一致の規則で通る（規則そのものが allows）。denies には引数違い・前方だけ同じ語（別コマンド）を挙げる',
    steps: [
      {
        args: rq({
          rule: 'Bash(gh pr view 12)',
          allows: ['gh pr view 12'],
          denies: ['gh pr view 13', 'gh pr view 12 --web', 'gh pr'],
        }),
        writes: 'both',
      },
    ],
  },
  {
    name: 'ok-lists',
    group: '積めた',
    covers:
      'allows / denies が複数: 質問文は " / " でつなぐ。承認の行の配列は渡した順のコピー。denies にコマンド側のメタ文字を含む例（; 付き・改行付き）は一致しない扱いなので denies として通る。allows に規則そのものと引用符つきの引数も通る',
    steps: [
      {
        args: rq({
          allows: [
            'gh release edit',
            OK_ALLOW,
            'gh release edit v1 --title "a (b)"',
            "gh release edit 'x;y'",
          ],
          denies: [
            OK_DENY,
            'gh release edit; rm -rf /',
            'gh release edit v1\nrm x',
            'ghx release edit',
          ],
        }),
        writes: 'both',
      },
    ],
  },
  {
    name: 'ok-reason-shapes',
    group: '積めた',
    covers:
      'reason の形: 前後の空白・複数行・長い文はそのまま質問文と context へ入る（整形も切り詰めもしない）',
    steps: [
      { args: rq({ reason: '  前後に空白  ' }), writes: 'both' },
      { args: rq({ reason: '一行目\n二行目\n\n四行目' }), writes: 'both' },
      { args: rq({ reason: LONG }), writes: 'both' },
    ],
  },
  {
    name: 'ok-twice',
    group: '積めた',
    covers:
      '同じ内容で続けて呼ぶ: 承認の id は呼ぶたびに新しく振られ（…01・…02）、行が2つ積まれる。createdAt は呼びの時刻。日誌も2行',
    steps: [
      { args: rq(), writes: 'both' },
      { args: rq(), writes: 'both' },
    ],
  },
  // ---- NUL ----
  {
    name: 'nul-stripped',
    group: 'NUL',
    covers:
      'rule・allows・denies・reason のすべてに NUL: 落とした値で検算し、落とした値が質問文・承認の行・日誌に残る。NUL を含まないのと同じ結果',
    steps: [
      {
        args: {
          rule: 'Bash(gh rel\u0000ease edit:*)',
          allows: ['gh release\u0000 edit v1 --draft'],
          denies: ['gh release\u0000 delete v1'],
          reason: 'リリース\u0000の下書きを直したい',
        },
        writes: 'both',
      },
    ],
  },
  {
    name: 'nul-rescues-allow',
    group: 'NUL',
    covers:
      '落とす前の値では allows が一致しない（語境界が NUL で割れる）が、落とした値では一致する: 通る（落とす前の値で検算すると通ったはずの要求が自己矛盾する）。承認の行の allows は落とした値',
    steps: [
      {
        args: rq({ allows: ['gh release edit\u0000 v1 --draft', 'gh release\u0000 edit v2'] }),
        writes: 'both',
      },
    ],
  },
  {
    name: 'nul-breaks-deny',
    group: 'NUL',
    covers:
      '落とす前の値では denies が一致しない（NUL で語が割れる）が、落とした値では一致する: 断る。断りに載るのは落とした値',
    steps: [{ args: rq({ denies: ['gh release\u0000 edit v2'] }), writes: 'none' }],
  },
  {
    name: 'nul-breaks-allow',
    group: 'NUL',
    covers:
      '落とす前の値では allows が一致するが、落とした値では一致しない（NUL が語の区切りの代わりだった）: 断る。断りに載るのは落とした値',
    steps: [{ args: rq({ allows: ['gh release edit\u0000v1'] }), writes: 'none' }],
  },
  // ---- 直前の拒否の添え ----
  {
    name: 'evidence-absent',
    group: '直前の拒否の添え',
    covers:
      'context.recentDenials が無い器: 「この層は拒否の記録を読む口を持たない」の1行。呼びに recentDenials の読みが出ない',
    ctx: { denials: null },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-none-found',
    group: '直前の拒否の添え',
    covers:
      '記録が空・記録はあるが道具が違う（Read）・先頭の語が違う（git）・先頭の語の欄が無い: 「照合できる直前の拒否は記録に無い」の1行',
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-other-tool',
    group: '直前の拒否の添え',
    covers: '記録に同じ先頭の語でも道具が Read の拒否だけある: 照合できない',
    ctx: { denials: [denial({ at: '2026-10-29T00:00:00.000Z', tool: 'Read', headWord: 'gh' })] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-other-head',
    group: '直前の拒否の添え',
    covers: '記録に道具は同じ（Bash）で先頭の語が違う（git）拒否だけある: 照合できない',
    ctx: { denials: [denial({ at: '2026-10-29T00:00:00.000Z', tool: 'Bash', headWord: 'git' })] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-no-headword-entry',
    group: '直前の拒否の添え',
    covers: '記録の先頭の語の欄が無い拒否（伏せられた入力）だけある: 照合できない',
    ctx: { denials: [denial({ at: '2026-10-29T00:00:00.000Z', tool: 'Bash', reason: '伏せた' })] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-found-full',
    group: '直前の拒否の添え',
    covers:
      '一致する拒否に分類・理由・拒否文が全部ある: 時刻・道具・先頭の語・分類・理由・拒否文を " / " でつなぐ。「器が返した原文」の見出し',
    ctx: { denials: [D_FULL] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-found-minimal',
    group: '直前の拒否の添え',
    covers: '一致する拒否が時刻・道具・先頭の語だけ（分類・理由・拒否文が無い）: その3つだけ',
    ctx: { denials: [denial({ at: '2026-10-29T00:00:00.000Z', tool: 'Bash', headWord: 'gh' })] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-found-partial',
    group: '直前の拒否の添え',
    covers:
      '分類だけある・理由だけある・拒否文だけある拒否: 在る欄だけが並ぶ（順は分類・理由・拒否文）',
    ctx: {
      denials: [
        denial({
          at: '2026-10-29T00:00:00.000Z',
          tool: 'Bash',
          headWord: 'gh',
          message: '拒否文だけ',
        }),
      ],
    },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-found-newest',
    group: '直前の拒否の添え',
    covers:
      '一致する拒否が複数ある: 最後（新しい側）の1件を使う。そのあとに一致しない拒否があっても飛ばす',
    ctx: {
      denials: [
        denial({
          at: '2026-10-29T00:00:01.000Z',
          tool: 'Bash',
          headWord: 'gh',
          reason: '古い拒否',
        }),
        denial({
          at: '2026-10-29T00:00:02.000Z',
          tool: 'Bash',
          headWord: 'gh',
          reason: '新しい拒否',
        }),
        denial({
          at: '2026-10-29T00:00:03.000Z',
          tool: 'Bash',
          headWord: 'git',
          reason: '別の語の拒否',
        }),
      ],
    },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-found-long',
    group: '直前の拒否の添え',
    covers: '分類・理由・拒否文が長い・複数行: 1行に潰して 400 字で切る（切ったことが出る）',
    ctx: {
      denials: [
        denial({
          at: '2026-10-29T00:00:00.000Z',
          tool: 'Bash',
          headWord: 'gh',
          reasonType: LONG,
          reason: `${LONG}\n次の行`,
          message: '一行目\n  二行目\t三行目',
        }),
      ],
    },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'evidence-exact-rule',
    group: '直前の拒否の添え',
    covers: '完全一致の規則（:* なし）でも先頭の語で照合する（中身の先頭の語 gh）',
    ctx: { denials: [D_FULL] },
    steps: [
      {
        args: rq({
          rule: 'Bash(gh pr view 12)',
          allows: ['gh pr view 12'],
          denies: ['gh pr view 13'],
        }),
        writes: 'both',
      },
    ],
  },
  {
    name: 'evidence-head-unusable',
    group: '直前の拒否の添え',
    covers:
      '規則の先頭の語が使えない（先頭が . の語・= を含む語・32 字を超える語・鍵らしい長い英数字の語）: 「規則から道具と先頭の語が取れないので照合していない」の1行。記録が在っても照合しない',
    ctx: { denials: [D_FULL] },
    steps: [
      {
        args: rq({
          rule: 'Bash(./deploy.sh:*)',
          allows: ['./deploy.sh prod'],
          denies: ['./other.sh'],
        }),
        writes: 'both',
      },
      {
        args: rq({ rule: 'Bash(FOO=bar make:*)', allows: ['FOO=bar make x'], denies: ['make x'] }),
        writes: 'both',
      },
      {
        args: rq({
          rule: `Bash(${'a'.repeat(33)} x:*)`,
          allows: [`${'a'.repeat(33)} x y`],
          denies: ['gh x'],
        }),
        writes: 'both',
      },
      {
        args: rq({
          rule: 'Bash(AKIAIOSFODNN7EXAMPLE x:*)',
          allows: ['AKIAIOSFODNN7EXAMPLE x y'],
          denies: ['gh x'],
        }),
        writes: 'both',
      },
    ],
  },
  // ---- 会話の結び付き ----
  {
    name: 'conv-none',
    group: '会話の結び付き',
    covers:
      '会話が無い（conversationId が undefined・workConversationId の口も無い）: 承認の行に conversationId の欄が付かず、noteQuestionAsked(undefined)。呼びは conversationId を1回読む',
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'conv-fallback',
    group: '会話の結び付き',
    covers:
      'workConversationId の口が無く conversationId だけが在る: conversationId の値が承認の行・noteQuestionAsked に入る',
    ctx: { conv: 'conv-1' },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'conv-work',
    group: '会話の結び付き',
    covers:
      'workConversationId の口が在る（conversationId とは別の値）: workConversationId の値が使われ、conversationId は読まない',
    ctx: { conv: 'conv-human', work: 'conv-origin' },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'conv-work-undefined',
    group: '会話の結び付き',
    covers:
      'workConversationId の口は在るが undefined を返す（conversationId には値）: conversationId へは倒れず、会話の無い承認になる',
    ctx: { conv: 'conv-human', work: null },
    steps: [{ args: rq(), writes: 'both' }],
  },
  // ---- task の結び付き ----
  {
    name: 'task-none',
    group: 'task の結び付き',
    covers:
      'currentTaskIds の口が無い: 承認の行に taskIds の欄が付かない。呼びに currentTaskIds の読みが出ない',
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'task-empty',
    group: 'task の結び付き',
    covers: 'currentTaskIds が空の配列を返す: 欄ごと付けない',
    ctx: { taskIds: [] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'task-ids',
    group: 'task の結び付き',
    covers:
      'currentTaskIds が2件を返す: 承認の行の taskIds に同じ並びのコピーが入る。会話の結び付きと同時でもよい',
    ctx: { conv: 'conv-1', taskIds: ['task-a', 'task-b'] },
    steps: [{ args: rq(), writes: 'both' }],
  },
  // ---- 器が口を持たない ----
  {
    name: 'no-flush',
    group: '器が口を持たない',
    covers:
      'flushReply が無い器: 呼びに flushReply が出ず、ほかは同じ（putApproval → journal.append → noteQuestionAsked → emit）',
    ctx: { noFlush: true },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'no-note',
    group: '器が口を持たない',
    covers: 'noteQuestionAsked が無い器: 呼びに noteQuestionAsked が出ず、emit は呼ばれる',
    ctx: { noNote: true },
    steps: [{ args: rq(), writes: 'both' }],
  },
  {
    name: 'no-optional-hooks',
    group: '器が口を持たない',
    covers:
      'flushReply・noteQuestionAsked・currentTaskIds・recentDenials のどれも無い最小の器: 呼びは conversationId の読み・putApproval・journal.append・emit だけ',
    ctx: { noFlush: true, noNote: true, denials: null },
    steps: [{ args: rq(), writes: 'both' }],
  },
  // ---- 書き込みが落ちる ----
  {
    name: 'flush-fails',
    group: '書き込みが落ちる',
    covers:
      'flushReply が落ちる: 例外がそのまま出る。承認の行を作る前なので putApproval を呼ばず、承認も日誌も context への知らせも無い（id も振らない）',
    steps: [{ args: rq(), writes: 'none', hooks: { flushFails: true } }],
  },
  {
    name: 'put-fails',
    group: '書き込みが落ちる',
    covers:
      'putApproval が落ちる: 「未記録・確認は人間へ届いていない・やり直してよい」の例外（ApprovalNotRecordedError）。stderr に落とした跡が残る。承認の行は無く、日誌も足さず、noteQuestionAsked も emit も呼ばない。flushReply は先に呼ばれている。id は消費される（次の呼びは …02）',
    ctx: { conv: 'conv-1', taskIds: ['task-a'] },
    steps: [
      { args: rq(), writes: 'none', hooks: { putFails: true } },
      { args: rq(), writes: 'both' },
    ],
  },
  {
    name: 'journal-fails',
    group: '書き込みが落ちる',
    covers:
      '日誌が書けない（act-completed）: 承認の行を書いた後なので行は残ったまま、「完了済み・未記録・やり直し禁止」の例外（JournalNotRecordedError）。noteQuestionAsked も emit も呼ばない。stderr に跡が残る。やり直すと行がもう1つ積まれる',
    ctx: { conv: 'conv-1' },
    steps: [
      { args: rq(), writes: 'approval-only', hooks: { journalFails: true } },
      { args: rq(), writes: 'both' },
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
  /** 例外の name（投げなかったときは null） */
  errorName: string | null;
}

interface PinnedCall {
  op: string;
  args?: unknown;
  outcome?: string;
}

interface PinnedStep {
  output: PinnedOutput;
  wrote: boolean;
  /** 呼んだあとの承認の全行（ストアから読んだ形のまま） */
  approvals: PendingApproval[];
  /** 呼んだあとに日誌へ足された行 */
  journal: Record<string, unknown>[];
  /** 呼びの並び */
  calls: PinnedCall[];
  /** noteDroppedRecord が stderr へ残した跡 */
  stderr: string[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function snapshot(
  stores: Stores,
): Promise<{ approvals: PendingApproval[]; journal: unknown[] }> {
  return {
    approvals: plain((await stores.jobs.listApprovals({ pendingOnly: false })).entries),
    journal: plain(await stores.journal.list({ order: 'asc' })) as unknown[],
  };
}

/** 道具の呼びだけを `calls` へ記録し、口（hooks）で失敗を起こす */
function withHooks(base: Stores, hooks: () => Hooks, calls: PinnedCall[]): Stores {
  return {
    ...base,
    jobs: {
      ...base.jobs,
      putApproval: async (approval) => {
        const args = plain(approval);
        if (hooks().putFails === true) {
          calls.push({
            op: 'jobs.putApproval',
            args,
            outcome: 'threw Error: ストアが落ちた（putApproval）',
          });
          throw new Error('ストアが落ちた（putApproval）');
        }
        await base.jobs.putApproval(approval);
        calls.push({ op: 'jobs.putApproval', args, outcome: 'ok' });
      },
    },
    journal: {
      ...base.journal,
      append: async (entry) => {
        const args = plain(entry);
        if (hooks().journalFails === true) {
          calls.push({ op: 'journal.append', args, outcome: 'threw Error: 日誌が落ちた' });
          throw new Error('日誌が落ちた');
        }
        const written = await base.journal.append(entry);
        calls.push({ op: 'journal.append', args, outcome: `ok ${written.id}` });
        return written;
      },
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  uuidState.drawn = 0;
  let hooks: Hooks = {};
  const calls: PinnedCall[] = [];
  const ctx = scenario.ctx ?? {};
  const denials = ctx.denials === undefined ? [] : ctx.denials;
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, calls),
    emit: (event) => {
      calls.push({ op: 'context.emit', args: plain(event) });
    },
    memoryCause: () => 'clone',
    conversationId: () => {
      calls.push({ op: 'context.conversationId' });
      return ctx.conv;
    },
    ...(ctx.work === undefined
      ? {}
      : {
          workConversationId: () => {
            calls.push({ op: 'context.workConversationId' });
            return ctx.work ?? undefined;
          },
        }),
    ...(denials === null
      ? {}
      : {
          recentDenials: () => {
            calls.push({ op: 'context.recentDenials' });
            return denials;
          },
        }),
    ...(ctx.taskIds === undefined
      ? {}
      : {
          currentTaskIds: () => {
            calls.push({ op: 'context.currentTaskIds' });
            return ctx.taskIds ?? [];
          },
        }),
    ...(ctx.noFlush === true
      ? {}
      : {
          flushReply: async () => {
            if (hooks.flushFails === true) {
              calls.push({ op: 'context.flushReply', outcome: 'threw Error: flush が落ちた' });
              throw new Error('flush が落ちた');
            }
            calls.push({ op: 'context.flushReply', outcome: 'ok' });
          },
        }),
    ...(ctx.noNote === true
      ? {}
      : {
          noteQuestionAsked: (conversationId: string | undefined) => {
            calls.push({
              op: 'context.noteQuestionAsked',
              args: conversationId === undefined ? '(undefined)' : conversationId,
            });
          },
        }),
  });
  const found = tools.find((entry) => entry.name === 'request_permission');
  if (!found) throw new Error('request_permission が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const before = await snapshot(base);
    hooks = step.hooks ?? {};
    calls.length = 0;
    const stderr: string[] = [];
    setStderrSinkForTesting((line) => {
      stderr.push(line);
    });
    vi.setSystemTime(new Date(callTime(index)));
    let output: PinnedOutput;
    try {
      const result = await found.handler(step.args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = {
        length: text.length,
        text,
        isError: result.isError === true,
        thrown: false,
        errorName: null,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = {
        length: text.length,
        text,
        isError: true,
        thrown: true,
        errorName: error instanceof Error ? error.name : typeof error,
      };
    } finally {
      setStderrSinkForTesting(null);
    }
    hooks = {};
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.approvals) !== JSON.stringify(after.approvals) ||
      before.journal.length !== after.journal.length;
    results.push({
      output,
      wrote,
      approvals: after.approvals,
      journal: after.journal.slice(before.journal.length) as Record<string, unknown>[],
      calls: plain(calls),
      stderr,
    });
    const key = stepKey(scenario, index);
    const ops = calls.map((entry) => entry.op);
    if (step.writes === 'none') {
      // 書き込みが起きなかった呼びは、承認の行も日誌も呼ぶ前と同じで、context への知らせも無い
      expect(
        after.approvals,
        `場面 ${key} は書き込みが起きないはずだが、承認の行が呼ぶ前から変わった`,
      ).toEqual(before.approvals);
      expect(
        after.journal,
        `場面 ${key} は書き込みが起きないはずだが、日誌が呼ぶ前から変わった`,
      ).toEqual(before.journal);
      expect(ops, `場面 ${key}: 書き込みが起きないのに context へ知らせた`).not.toContain(
        'context.noteQuestionAsked',
      );
      expect(ops, `場面 ${key}: 書き込みが起きないのに emit した`).not.toContain('context.emit');
      expect(ops, `場面 ${key}: 日誌の書き込みを呼んだ`).not.toContain('journal.append');
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

describe('request_permission の出力と呼んだあとの状態の固定（場面ごとの出力の全文・承認の行・日誌の行・呼びの並び）', () => {
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
  }, 60_000);

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

  it('書き込みの有無が宣言と同じ（承認の行・日誌の行・context への知らせの有無）', () => {
    for (const scenario of SCENARIOS) {
      for (const [index, step] of scenario.steps.entries()) {
        const key = stepKey(scenario, index);
        const got = actual[key];
        const ops = (got?.calls ?? []).map((entry) => entry.op);
        expect(got?.wrote, `${key}: 書き込みの有無が宣言と違う`).toBe(step.writes !== 'none');
        expect((got?.journal.length ?? -1) > 0, `${key}: 日誌の行の有無が宣言と違う`).toBe(
          step.writes === 'both',
        );
        // 知らせ（emit）は承認の行を積めた呼びすべて（日誌が書けなくても知らせる。#6490）。noteQuestionAsked は口が在るときだけ同じ条件で呼ばれる
        expect(ops.includes('context.emit'), `${key}: emit の有無が宣言と違う`).toBe(
          step.writes !== 'none',
        );
        const hasNote = scenario.ctx?.noNote !== true;
        expect(
          ops.includes('context.noteQuestionAsked'),
          `${key}: noteQuestionAsked の有無が宣言と違う`,
        ).toBe(step.writes !== 'none' && hasNote);
      }
    }
  });

  describe.each(SCENARIOS)('場面 $name（$group）', (scenario) => {
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
          {
            isError: got?.output.isError,
            thrown: got?.output.thrown,
            errorName: got?.output.errorName,
          },
          `場面 ${key} の出力の isError／例外で返ったか（名前）、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          errorName: want?.output.errorName,
        });
      });

      it(`${key} の呼んだあとの承認の行が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.approvals.map((row) => row.id),
          `場面 ${key} の承認: 行の並び（id）が変わった`,
        ).toEqual(want?.approvals.map((row) => row.id));
        for (const [row, wantRow] of (want?.approvals ?? []).entries()) {
          expect(
            got?.approvals[row],
            `場面 ${key} の承認 ${wantRow.id}（${String(row)} 行目）が固定値からずれた（質問文・context・permissionRequest・会話・taskIds など）`,
          ).toEqual(wantRow);
        }
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
          `場面 ${key} の日誌: 足された行（種類・本文・id・at）が固定値からずれた`,
        ).toEqual(want?.journal);
      });

      it(`${key} の呼びの並び（context への知らせ・ストアの書き込み）と stderr の跡が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.map((entry) => entry.op),
          `場面 ${key} の呼び: 並び（recentDenials・flushReply・putApproval・journal.append・noteQuestionAsked・emit など）が変わった`,
        ).toEqual(want?.calls.map((entry) => entry.op));
        expect(got?.calls, `場面 ${key} の呼び: 渡した行・イベント・引数か結果がずれた`).toEqual(
          want?.calls,
        );
        expect(got?.stderr, `場面 ${key} の stderr の跡がずれた`).toEqual(want?.stderr);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・承認・日誌・呼びになる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const ops = (key: string): string[] => (actual[key]?.calls ?? []).map((entry) => entry.op);
    const row = (key: string, n = 0): PendingApproval | undefined => actual[key]?.approvals[n];
    const REFUSE = 'request_permission を拒否した（キューに積んでいない）: ';
    const PHRASE = '許可します';
    const FULL_OPS = [
      'context.conversationId',
      'context.recentDenials',
      'context.flushReply',
      'jobs.putApproval',
      'journal.append',
      'context.noteQuestionAsked',
      'context.emit',
    ];
    // 規則の形の断り
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(text(`rule-invalid-shape#${String(n)}`)).toBe(
        `${REFUSE}規則は Bash(<コマンド>) または Bash(<コマンド>:*) の形である必要がある`,
      );
    }
    expect(text('rule-invalid-empty#1')).toBe(
      `${REFUSE}規則の中身が空である（Bash() / Bash(:*) は不正）`,
    );
    expect(text('rule-invalid-empty#2')).toBe(text('rule-invalid-empty#1'));
    for (let n = 1; n <= 10; n += 1) {
      expect(text(`rule-invalid-metachar#${String(n)}`)).toBe(
        `${REFUSE}規則の中身にシェルの区切り・展開文字が含まれている（規則として不正）`,
      );
    }
    // allows / denies の検算
    expect(text('lists-empty#1')).toContain('allows が空である');
    expect(text('lists-empty#2')).toContain('denies が空である');
    expect(text('lists-empty#3')).toContain('allows が空である');
    expect(text('lists-empty#4')).toContain('allows が空である');
    expect(text('allow-mismatch#1')).toBe(
      `${REFUSE}allows のうち規則に一致しない例がある: gh release view v1`,
    );
    expect(text('allow-mismatch#2')).toContain('一致しない例がある: gh release editfoo');
    expect(text('allow-mismatch#3')).toContain('一致しない例がある: gh release edit; rm -rf /');
    expect(text('allow-mismatch#5')).toBe(`${REFUSE}allows のうち規則に一致しない例がある: `);
    expect(text('allow-mismatch#8')).toContain('一致しない例がある: gh a');
    expect(text('allow-mismatch-exact')).toContain('一致しない例がある: gh pr view 12 --web');
    expect(text('deny-matches#1')).toBe(
      `${REFUSE}denies のうち規則に一致してしまう例がある: gh release edit v2`,
    );
    expect(text('deny-matches#2')).toContain('一致してしまう例がある: gh release edit');
    expect(text('deny-matches#5')).toContain('allows のうち規則に一致しない例がある: gh nope');
    expect(text('deny-matches-exact')).toContain('一致してしまう例がある: gh pr view 12');
    // reason の断り
    expect(text('reason-invalid#1')).toBe(`${REFUSE}reason は使えない（1文字以上のみ）。`);
    expect(text('reason-invalid#2')).toBe(text('reason-invalid#1'));
    expect(text('reason-invalid#3')).toContain('空白だけの値は空と同じ');
    expect(text('reason-invalid#5')).toContain('空白だけの値は空と同じ');
    expect(text('lists-empty#4')).not.toContain('reason');
    expect(row('reason-undefined#1')?.question).toContain('理由: undefined\n');
    expect(row('reason-undefined#1')).not.toHaveProperty('context');
    // 断る場面は呼びが context の読みだけ（recentDenials も flushReply も呼ばない）
    for (const key of [
      'rule-invalid-shape#1',
      'allow-mismatch#1',
      'deny-matches#1',
      'reason-invalid#1',
    ]) {
      expect(ops(key), `${key}: 断る場面で口を呼んだ`).toEqual([]);
    }
    // 積めた
    expect(ops('ok-prefix')).toEqual(FULL_OPS);
    expect(text('ok-prefix')).toBe(
      `承認待ちキューに積んだ（${u(1)}）。人間が「${PHRASE}」とちょうど答え、かつ許可されたアカウント経由の回答だった場合だけ、以降この規則に一致する Bash が自動で通る。`,
    );
    expect(row('ok-prefix')?.createdAt).toBe(callTime(0));
    expect(row('ok-prefix')?.context).toBe(OK_REASON);
    expect(row('ok-prefix')?.question).toContain(`許可するなら「${PHRASE}」とだけ答える`);
    expect(row('ok-prefix')).not.toHaveProperty('conversationId');
    expect(row('ok-prefix')).not.toHaveProperty('taskIds');
    expect(actual['ok-prefix']?.journal[0]).toMatchObject({
      type: 'escalation',
      approvalId: u(1),
    });
    expect(row('ok-lists')?.question).toContain('通る例: gh release edit / ');
    expect(row('ok-lists')?.permissionRequest?.denies).toHaveLength(4);
    expect(row('ok-reason-shapes#1')?.context).toBe('  前後に空白  ');
    expect(row('ok-reason-shapes#3', 2)?.context).toBe(LONG);
    expect(actual['ok-twice#2']?.approvals.map((entry) => entry.id)).toEqual([u(1), u(2)]);
    expect(row('ok-twice#2', 1)?.createdAt).toBe(callTime(1));
    // NUL
    expect(row('nul-stripped')?.permissionRequest).toEqual({
      rule: OK_RULE,
      allows: [OK_ALLOW],
      denies: [OK_DENY],
    });
    expect(row('nul-stripped')?.context).toBe(OK_REASON);
    expect(JSON.stringify(actual['nul-stripped'])).not.toContain('\\u0000');
    expect(row('nul-rescues-allow')?.permissionRequest?.allows).toEqual([
      'gh release edit v1 --draft',
      'gh release edit v2',
    ]);
    expect(text('nul-breaks-deny')).toBe(
      `${REFUSE}denies のうち規則に一致してしまう例がある: gh release edit v2`,
    );
    expect(text('nul-breaks-allow')).toBe(
      `${REFUSE}allows のうち規則に一致しない例がある: gh release editv1`,
    );
    // 直前の拒否の添え
    const evidence = (key: string): string =>
      (row(key, Number(/#(\d+)$/.exec(key)?.[1] ?? '1') - 1)?.question ?? '')
        .split('\n')
        .find((line) => line.startsWith('直前の拒否')) ?? '';
    expect(evidence('evidence-absent')).toBe(
      '直前の拒否: この層は拒否の記録を読む口を持たない（照合していない）。',
    );
    expect(ops('evidence-absent')).not.toContain('context.recentDenials');
    expect(evidence('evidence-none-found')).toContain('は、このセッションの記録に無い。');
    expect(evidence('evidence-other-tool')).toContain(
      '（Bash / 先頭の語 gh）は、このセッションの記録に無い。',
    );
    expect(evidence('evidence-other-head')).toContain('は、このセッションの記録に無い。');
    expect(evidence('evidence-no-headword-entry')).toContain('は、このセッションの記録に無い。');
    expect(evidence('evidence-found-full')).toContain(
      '分類 classifier / 理由 外へ出す操作で、人間の確認が要る / 拒否文 Permission',
    );
    expect(evidence('evidence-found-minimal')).toBe(
      '直前の拒否（器が返した原文。クローンの要約ではない。長い欄は 400 字で切る）: 時刻 2026-10-29T00:00:00.000Z / 道具 Bash / 先頭の語 gh',
    );
    expect(evidence('evidence-found-partial')).toContain('先頭の語 gh / 拒否文 拒否文だけ');
    expect(evidence('evidence-found-newest')).toContain('理由 新しい拒否');
    expect(evidence('evidence-found-newest')).not.toContain('古い拒否');
    expect(evidence('evidence-found-long')).toContain('…');
    expect(evidence('evidence-exact-rule')).toContain('先頭の語 gh');
    for (let n = 1; n <= 4; n += 1) {
      expect(evidence(`evidence-head-unusable#${String(n)}`)).toBe(
        '直前の拒否: 規則から道具と先頭の語が取れないので、照合していない。',
      );
    }
    // 会話
    expect(ops('conv-none')).toContain('context.conversationId');
    expect(actual['conv-none']?.calls.find((c) => c.op === 'context.noteQuestionAsked')?.args).toBe(
      '(undefined)',
    );
    expect(row('conv-fallback')?.conversationId).toBe('conv-1');
    expect(
      actual['conv-fallback']?.calls.find((c) => c.op === 'context.noteQuestionAsked')?.args,
    ).toBe('conv-1');
    expect(row('conv-work')?.conversationId).toBe('conv-origin');
    expect(ops('conv-work')).toContain('context.workConversationId');
    expect(ops('conv-work')).not.toContain('context.conversationId');
    expect(row('conv-work-undefined')).not.toHaveProperty('conversationId');
    // task
    expect(ops('task-none')).not.toContain('context.currentTaskIds');
    expect(row('task-none')).not.toHaveProperty('taskIds');
    expect(ops('task-empty')).toContain('context.currentTaskIds');
    expect(row('task-empty')).not.toHaveProperty('taskIds');
    expect(row('task-ids')?.taskIds).toEqual(['task-a', 'task-b']);
    // 口が無い
    expect(ops('no-flush')).not.toContain('context.flushReply');
    expect(ops('no-flush')).toContain('context.noteQuestionAsked');
    expect(ops('no-note')).not.toContain('context.noteQuestionAsked');
    expect(ops('no-note')).toContain('context.emit');
    expect(ops('no-optional-hooks')).toEqual([
      'context.conversationId',
      'jobs.putApproval',
      'journal.append',
      'context.emit',
    ]);
    // 書き込みが落ちる
    expect(actual['flush-fails']?.output.thrown).toBe(true);
    expect(text('flush-fails')).toBe('flush が落ちた');
    expect(ops('flush-fails')).toEqual([
      'context.conversationId',
      'context.recentDenials',
      'context.flushReply',
    ]);
    expect(actual['put-fails#1']?.output.thrown).toBe(true);
    expect(actual['put-fails#1']?.output.errorName).toBe('ApprovalNotRecordedError');
    expect(text('put-fails#1')).toContain('⚠⚠ 未記録・確認は人間へ届いていない・やり直してよい');
    expect(ops('put-fails#1')).toEqual([
      'context.conversationId',
      'context.recentDenials',
      'context.flushReply',
      'context.currentTaskIds',
      'jobs.putApproval',
    ]);
    expect(actual['put-fails#1']?.stderr.join('')).toContain('承認待ちを記録できませんでした');
    expect(actual['put-fails#1']?.approvals).toEqual([]);
    expect(actual['put-fails#2']?.approvals.map((entry) => entry.id)).toEqual([u(2)]);
    expect(actual['journal-fails#1']?.output.thrown).toBe(true);
    expect(actual['journal-fails#1']?.output.errorName).toBe('JournalNotRecordedError');
    expect(text('journal-fails#1')).toContain('⚠⚠ 完了済み・未記録・やり直し禁止');
    expect(text('journal-fails#1')).toContain('request_permission は完了した');
    expect(actual['journal-fails#1']?.journal).toEqual([]);
    expect(actual['journal-fails#1']?.approvals.map((entry) => entry.id)).toEqual([u(1)]);
    expect(ops('journal-fails#1').slice(-2)).toEqual(['jobs.putApproval', 'journal.append']);
    expect(actual['journal-fails#1']?.stderr.join('')).toContain('日誌を記録できませんでした');
    expect(actual['journal-fails#2']?.approvals.map((entry) => entry.id)).toEqual([u(1), u(2)]);
  });
});
