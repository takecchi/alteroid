import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { summarizeQuestions } from './approval-choices.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import { excerpt, excerptLine, renderListingEntry } from './excerpt.js';
import { PERMISSION_GRANT_CONSENT_PHRASE } from './schema.js';
import type { ApprovalQuestion, PendingApproval } from './schema.js';
import { UnreadableApprovalError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, TOOL_USE_ID_META_KEY } from './tools.js';

// `approvals_list` の出力（全文と字数）と、呼んだあとの状態（承認のストア・委譲・日誌の行・書き込み口が呼ばれたか）を、
// 場面ごとにコミットした固定値（clone-tools-approvals-list-output-pin.json）と丸ごと比べる。
// `clone-tools-approval.ts` の `tool('approvals_list', …)`（約 141 行・入れ子 6 段の式）を段ごと・部分ごとの小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・本文）を固定して毎回同じにする。
// この道具は読むだけ（ask_human / approval_withdraw と違って書かない）。だから出力に加えて、次を場面ごとに確かめる:
//   - output: 道具の出力の全文と字数（isError・例外で返ったか）
//   - wrote: 呼ぶ前後で承認の行（回答済み・取り下げ済みを含む全件）・委譲の行・日誌の行数が変わったか。全場面で false でなければならない
//   - writeCalls: 呼びの間にストアの書き込み口（putApproval / updateApproval / putJob / updateJob / jobs.clear・日誌の append）が呼ばれた記録。全場面で空
//   - readCalls: 呼びの間にストアの読む口（listApprovals の引数・getApproval の id）が呼ばれた記録（pendingOnly: true で読むことも固定する）
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_APPROVALS_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-approvals-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-approvals-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。approvals_list は時刻を作らない（承認の行の時刻をそのまま出す）。
// 承認はストアへ直接積む（ask_human / request_permission 経由にしない: id が randomUUID・時刻が実時間で、固定値にならないため）。
// 問いの形は両道具が積む行と同じ形を手で作る（request_permission の問いは質問文・背景・permissionRequest を持つ）。
// 一覧の予算（APPROVAL_LIST_BUDGET = 8,000）・索引の予算（4,000）・詳細の予算（8,000 − 索引の字数）・頁の大きさ（8,000）・
// 抜粋（問い 200・件名 60・索引の件名 30）の境目は、1件ぶんの字数をその場で測って（`renderListingEntry` と同じ組み立て）宛先の長さや id の長さで合わせて作る。
// 固定値に長い `[A-Za-z0-9_./@-]` の連続を作らない（走査が重くならないよう）: 長い文字列は 10 字ごとに空白を挟む（`spaced`）。

type Args = Record<string, unknown>;

interface Hooks {
  /** 一覧が返す「読めない行」（id が無い行も作れる） */
  unreadable?: { id?: string; reason: string }[];
  /** この id の `getApproval` が読めない行の例外（UnreadableApprovalError）で落ちる */
  getUnreadable?: string[];
  /** この id の `getApproval` が器の障害（普通の Error）で落ちる */
  getThrows?: string[];
  /** 一覧そのものが落ちる */
  listFails?: boolean;
}

interface Step {
  args?: Args;
  hooks?: Hooks;
  /** 'subagent' ならサブエージェントの呼び（畳まない・控えない）。省略は main */
  caller?: 'main' | 'subagent';
  /** 道具の説明文（description）を出力として固定する */
  desc?: boolean;
  /** この呼びの直前に、別の経路が承認を動かす（呼ぶ前の状態を作る。道具の書き込みではない） */
  before?: (base: Stores) => Promise<void>;
}

interface Scenario {
  name: string;
  /** 読み手のための整理。表に出す */
  group: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  seed: PendingApproval[];
  hooks?: Hooks;
  /** true なら foldFixed（同じ会話の2回目から札にする）を有効にする */
  fold?: boolean;
  steps: Step[];
}

const BASE_ISO = '2026-10-29T00:00:00.000Z';
const APPROVAL_BASE = Date.parse('2026-10-01T00:00:00.000Z');
const PIN_URL = new URL('./clone-tools-approvals-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_APPROVALS_LIST_PIN === '1';

const LIST_BUDGET = 8_000;
const INDEX_BUDGET = 4_000;
const PAGE = 8_000;
const QUESTION_EXCERPT = 200;
const TITLE_EXCERPT = 60;
const INDEX_TITLE_EXCERPT = 30;
/** 全文読みの本文の先頭に付く見出し（`質問: `） */
const QUESTION_HEADING = '質問: ';

function minuteIso(minute: number): string {
  return new Date(APPROVAL_BASE + minute * 60_000).toISOString();
}

function ap(id: string, minute: number, extra: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: minuteIso(minute), question: `質問 ${id}`, ...extra };
}

/** 長さ len の、10 字ごとに空白を挟んだ文字列（末尾は空白にしない） */
function spaced(len: number, word = 'abcdefghi'): string {
  let out = '';
  while (out.length < len) out += `${word} `;
  out = out.slice(0, len);
  return out.endsWith(' ') ? `${out.slice(0, -1)}x` : out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ---- 1件ぶんの字数を道具の実装と独立に測る（予算の境目の作成用。ずれたら calibrated が投げる）----

function titleOf(question: string): string {
  const firstLine = (question.split('\n', 1)[0] ?? '').trim();
  return excerpt(
    firstLine === '' ? question.replace(/\s+/g, ' ').trim() : firstLine,
    TITLE_EXCERPT,
  );
}

function entryLen(a: PendingApproval): number {
  return renderListingEntry({
    id: a.id,
    title: titleOf(a.question),
    createdAt: a.createdAt,
    summary: excerptLine(a.question, QUESTION_EXCERPT),
    extra: [
      a.questions === undefined || a.questions.length === 0
        ? null
        : `  ${summarizeQuestions(a.questions)}（詳細は approvals_list id=<id>）`,
      a.jobId === undefined
        ? null
        : `  宛先: managerId: "${a.jobId}"` +
          (a.requestId === undefined ? '' : `, requestId: "${a.requestId}"`),
    ],
  }).length;
}

function indexLine(a: PendingApproval): string {
  return `・${a.id}（${a.createdAt}）${excerpt(titleOf(a.question), INDEX_TITLE_EXCERPT)}`;
}

function sumEntries(specs: readonly PendingApproval[]): number {
  return specs.reduce((total, a) => total + entryLen(a), 0);
}

function standard(count: number, prefix = 'b'): PendingApproval[] {
  return Array.from({ length: count }, (_, index) =>
    ap(`${prefix}-${pad2(index + 1)}`, index + 1, { question: spaced(200, 'quest') }),
  );
}

/** 宛先（jobId）の長さを調節して、spec の1件ぶんの字数をちょうど length にする */
function tuneJobId(spec: PendingApproval, length: number, others: number): void {
  const base = entryLen({ ...spec, jobId: '' });
  const n = length - others - base;
  if (n < 0) throw new Error(`宛先の長さが合わせられない: ${String(n)}`);
  spec.jobId = spaced(n, 'job');
  const total = others + entryLen(spec);
  if (total !== length) throw new Error(`合計が目標と違う: ${String(total)} / ${String(length)}`);
}

/** count 件の詳細の合計がちょうど target 字（最後の1件の宛先で合わせる）。後ろに extras を足す */
function fullTuned(
  count: number,
  target: number,
  extras: PendingApproval[] = [],
): PendingApproval[] {
  const specs = standard(count);
  const last = specs[count - 1];
  if (last === undefined) throw new Error('count が 0');
  tuneJobId(last, target, sumEntries(specs.slice(0, -1)));
  return [...specs, ...extras];
}

/** 1件だけで詳細の字数がちょうど length 字 */
function single(id: string, minute: number, length: number): PendingApproval {
  const spec = ap(id, minute, { question: '短い問い' });
  tuneJobId(spec, length, 0);
  return spec;
}

/** 索引の行の字数の合計がちょうど target（いちばん古い件の id の長さで合わせる）。詳細は予算に入りきらない件数 */
function indexTuned(count: number, target: number): PendingApproval[] {
  const specs = standard(count, 'ix');
  const oldest = specs[0];
  if (oldest === undefined) throw new Error('count が 0');
  const others = specs.slice(1).reduce((total, a) => total + indexLine(a).length, 0);
  const want = target - others;
  const probe = indexLine({ ...oldest, id: 'x' }).length;
  const idLen = want - probe + 1;
  if (idLen < 1) throw new Error(`id の長さが合わせられない: ${String(idLen)}`);
  oldest.id = spaced(idLen, 'ix-01');
  const total = others + indexLine(oldest).length;
  if (total !== target)
    throw new Error(`索引の合計が目標と違う: ${String(total)} / ${String(target)}`);
  return specs;
}

/**
 * 索引が収まる count 件で、詳細（新しい順）の先頭 k 件の字数の合計が「詳細の予算 + delta」になるようにする
 * （詳細の予算 = 8,000 − 索引の文字列の長さ）。delta=0 なら k 件が出て、1 なら k−1 件で止まる。
 */
function detailTuned(count: number, k: number, delta: number): PendingApproval[] {
  const specs = standard(count, 'dt');
  const lines = specs.map(indexLine);
  const used = lines.reduce((total, line) => total + line.length, 0);
  if (used > INDEX_BUDGET) throw new Error('索引が予算を超える');
  const budget = Math.max(2_000, LIST_BUDGET - lines.join('\n').length);
  const newestFirst = [...specs].reverse();
  const kth = newestFirst[k - 1];
  if (kth === undefined) throw new Error('k が大きすぎる');
  tuneJobId(kth, budget + delta, sumEntries(newestFirst.slice(0, k - 1)));
  return specs;
}

const Q_SINGLE: ApprovalQuestion = {
  id: 'target',
  prompt: 'デプロイ先は？',
  options: [
    { id: 'railway', label: 'Railway', recommended: true },
    { id: 'fly', label: 'Fly.io', description: '東京リージョン' },
  ],
};
const Q_MULTI: ApprovalQuestion = {
  id: 'notify',
  prompt: '通知する先（複数可）',
  multiple: true,
  allowOther: false,
  options: [
    { id: 'slack', label: 'Slack' },
    { id: 'mail', label: 'メール' },
  ],
};

const PERMISSION_QUESTION =
  `以降 Bash(pnpm test:*) を聞かずに通してよいか。理由: テストを回すため\n` +
  `通る例: pnpm test / pnpm test --run\n通らない例: pnpm publish\n` +
  `直前の拒否: この層は拒否の記録を読む口を持たない（照合していない）。\n` +
  `許可するなら「${PERMISSION_GRANT_CONSENT_PHRASE}」とだけ答える（句点や言い換えがあると記録しない）。`;

const PERMISSION_APPROVAL = (id: string, minute: number): PendingApproval =>
  ap(id, minute, {
    question: PERMISSION_QUESTION,
    context: 'テストを回すため',
    conversationId: 'conv-1',
    permissionRequest: {
      rule: 'Bash(pnpm test:*)',
      allows: ['pnpm test', 'pnpm test --run'],
      denies: ['pnpm publish'],
    },
  });

/** 標準の一式: 待ち（問いの種類ごと）3 件・回答済み 2 件・取り下げ 2 件 */
const MIX: PendingApproval[] = [
  ap('ask-1', 1, { question: '本番に出してよいか', context: '金曜の夕方だが急ぎ' }),
  ap('ask-2', 2, {
    question: 'デプロイ先を決めたい',
    questions: [Q_SINGLE, Q_MULTI],
    jobId: 'mgr-77',
    requestId: 'req-5',
  }),
  PERMISSION_APPROVAL('perm-1', 3),
  ap('done-1', 4, { answeredAt: minuteIso(40), answer: 'はい' }),
  ap('done-2', 5, { answeredAt: minuteIso(41) }),
  ap('wd-1', 6, { withdrawnAt: minuteIso(50), withdrawnReason: '自分で答えが見つかった' }),
  ap('wd-2', 7, { withdrawnAt: minuteIso(51) }),
];

/** body = `質問: ` + question だけの承認で、本文がちょうど length 字になるもの */
function bodyOf(id: string, minute: number, length: number): PendingApproval {
  return ap(id, minute, { question: spaced(length - QUESTION_HEADING.length) });
}

/** fold-switch-shape の2回目の前に足す承認（全件の詳細が入りきらなくなる量） */
const SWITCH_EXTRA = fullTuned(22, LIST_BUDGET + 1).map((a) => ({ ...a, id: `sw-${a.id}` }));

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査・説明文 ----
  {
    name: 'tool-description',
    group: '説明文',
    covers:
      '道具の説明文（description）の全文。更新が出ない理由（作成と同じ）・id で全文を取ること',
    seed: [],
    steps: [{ desc: true }],
  },
  {
    name: 'arg-offset',
    group: '引数の検査',
    covers:
      'offset の違反（負・小数・NaN・Infinity）。id があってもなくても、モードに入る前に断る（ストアは読まない）。違反でない 0・大きい値は通る（一覧では offset は使われない）',
    seed: [ap('a-1', 1)],
    steps: [
      { args: { id: 'a-1', offset: -1 } },
      { args: { id: 'a-1', offset: 1.5 } },
      { args: { id: 'a-1', offset: Number.NaN } },
      { args: { id: 'a-1', offset: Number.POSITIVE_INFINITY } },
      { args: { id: 'a-1', offset: -0.5 } },
      { args: { offset: -1 } },
      { args: { id: 'no-such', offset: -3 } },
      { args: { id: 'a-1', offset: 0 } },
      { args: { offset: 5 } },
    ],
  },

  // ---- id の全文読み: 無い・読めない ----
  {
    name: 'id-missing',
    group: 'id の全文読み',
    covers:
      '無い id（空文字・大文字小文字違い・前に空白も別の id）。一覧用ではない余分な引数は id があると無視される',
    seed: MIX,
    steps: [
      { args: { id: 'no-such' } },
      { args: { id: '' } },
      { args: { id: 'ASK-1' } },
      { args: { id: ' ask-1' } },
      { args: { id: 'no-such', cursor: 'garbage', includeClosed: true } },
    ],
  },
  {
    name: 'id-unreadable',
    group: 'id の全文読み',
    covers:
      '読めない形で入っている行（getApproval が UnreadableApprovalError）: 「無い」とは別の文言。別の id は読める',
    seed: MIX,
    hooks: { getUnreadable: ['bad-1'] },
    steps: [
      { args: { id: 'bad-1' } },
      { args: { id: 'bad-1', offset: 100 } },
      { args: { id: 'ask-1' } },
    ],
  },
  {
    name: 'id-store-error',
    group: 'id の全文読み',
    covers: '器の障害（普通の Error）は飲み込まず例外のまま出る（THREW）。読めない行とは区別される',
    seed: MIX,
    hooks: { getThrows: ['boom'], getUnreadable: ['bad-1'] },
    steps: [{ args: { id: 'boom' } }, { args: { id: 'bad-1' } }, { args: { id: 'ask-2' } }],
  },

  // ---- id の全文読み: 状態・宛先・問いの種類 ----
  {
    name: 'id-each-state',
    group: 'id の全文読み',
    covers:
      '標準の7件を1件ずつ全文で: 待ち（回答待ち）・回答済み（回答あり／回答の本文なし）・取り下げ（理由あり／なし）。宛先（jobId・requestId）の有り無し。問いの種類: 質問だけ＋背景・設問つき（ask_human）・request_permission',
    seed: MIX,
    steps: MIX.map((spec) => ({ args: { id: spec.id } })),
  },
  {
    name: 'id-dest-variants',
    group: 'id の全文読み',
    covers:
      '宛先の出方: jobId だけ・jobId と requestId・requestId だけ（jobId が無いと宛先は出ない）・空文字の jobId',
    seed: [
      ap('d-job', 1, { jobId: 'mgr-1' }),
      ap('d-both', 2, { jobId: 'mgr-2', requestId: 'req-2' }),
      ap('d-req', 3, { requestId: 'req-3' }),
      ap('d-empty', 4, { jobId: '' }),
      ap('d-empty-both', 5, { jobId: '', requestId: '' }),
    ],
    steps: ['d-job', 'd-both', 'd-req', 'd-empty', 'd-empty-both'].map((id) => ({ args: { id } })),
  },
  {
    name: 'id-status-priority',
    group: 'id の全文読み',
    covers:
      '状態の語は回答・取り下げの中身も見て決める: 両方立つ行は「回答済み（取り下げも記録されている）」と両方言い、回答の行も理由の行も出る。時刻が無く取り下げの理由だけ・回答だけの行は「取り下げ（時刻の記録が無い）」「回答済み（時刻の記録が無い）」',
    seed: [
      ap('s-both', 1, {
        answeredAt: minuteIso(10),
        answer: '遅れて届いた回答',
        withdrawnAt: minuteIso(11),
        withdrawnReason: '先に取り下げた',
      }),
      ap('s-reason-only', 2, { withdrawnReason: '日時が無いのに理由だけ' }),
      ap('s-answer-only', 3, { answer: '日時が無いのに回答だけ' }),
    ],
    steps: ['s-both', 's-reason-only', 's-answer-only'].map((id) => ({ args: { id } })),
  },
  {
    name: 'id-status-times-only',
    group: 'id の全文読み',
    covers:
      '時刻だけあって中身が無い行: 回答の時刻だけ（answer なし）は「… に回答済み」、取り下げの時刻だけ（理由なし）は「… に取り下げ」。どちらも本文に回答・理由の行は出ない。両方の時刻だけが立つ行は両方言う',
    seed: [
      ap('t-answered', 1, { answeredAt: minuteIso(10) }),
      ap('t-withdrawn', 2, { withdrawnAt: minuteIso(11) }),
      ap('t-both', 3, { answeredAt: minuteIso(10), withdrawnAt: minuteIso(11) }),
    ],
    steps: ['t-answered', 't-withdrawn', 't-both'].map((id) => ({ args: { id } })),
  },
  {
    name: 'id-question-kinds',
    group: 'id の全文読み',
    covers:
      '設問の出方: 設問が 0 件の配列（`設問:` の見出しだけが空で出る）・設問が単一／複数／その他不可・推奨・選択肢の説明・27 個目以降の選択肢の印（(27)）。permissionRequest は全文読みに別の欄として出ない（問いの本文の中だけ）',
    seed: [
      ap('k-empty', 1, { question: '空の設問配列', questions: [] }),
      ap('k-two', 2, { question: '設問が2つ', questions: [Q_SINGLE, Q_MULTI] }),
      ap('k-many', 3, {
        question: '選択肢が多い',
        questions: [
          {
            id: 'big',
            prompt: '27 個ある',
            options: Array.from({ length: 27 }, (_, index) => ({
              id: `o${String(index + 1)}`,
              label: `案${String(index + 1)}`,
            })),
          },
        ],
      }),
      PERMISSION_APPROVAL('k-perm', 4),
    ],
    steps: ['k-empty', 'k-two', 'k-many', 'k-perm'].map((id) => ({ args: { id } })),
  },
  {
    name: 'id-text-shape',
    group: 'id の全文読み',
    covers:
      '全文は本文をそのまま出す（改行・連続した空白をたたまない）。空の問い・空の背景・空の回答（空でも欄の行は出る）。一覧の抜粋とは違い切らない',
    seed: [
      ap('t-multi', 1, { question: '一行目\n\n  二行目\t三行目\n', context: '背景\n二行' }),
      ap('t-empty', 2, { question: '', context: '', answer: '', answeredAt: minuteIso(5) }),
      ap('t-long', 3, { question: spaced(500) }),
    ],
    steps: ['t-multi', 't-empty', 't-long'].map((id) => ({ args: { id } })),
  },

  // ---- id の全文読み: 頁の境目 ----
  {
    name: 'id-offset-small',
    group: 'id の全文読み（頁・offset）',
    covers:
      '小さな本文（「質問: 」+ 10 字 = 14 字）の offset: 先頭（全文の言い方）・途中・末尾の1字手前・末尾ちょうど・末尾を越える・巨大な値。続きの案内は付かない。offset 0 を明示しても同じ',
    seed: [ap('o-small', 1, { question: 'abcdefghij' })],
    steps: [0, 3, 13, 14, 15, 1_000_000].map((offset) => ({ args: { id: 'o-small', offset } })),
  },
  {
    name: 'id-page-edge',
    group: 'id の全文読み（頁・offset）',
    covers:
      '本文 7,999 / 8,000 / 8,001 字: 8,000 字ちょうどは1頁で終わる（続きなし）、8,001 字は 8,000 字目で切れて続きの offset=8000。offset 1 は境目をまたいでも 2〜8,001 で最後（続きなし）',
    seed: [bodyOf('e-7999', 1, 7_999), bodyOf('e-8000', 2, 8_000), bodyOf('e-8001', 3, 8_001)],
    steps: [
      { args: { id: 'e-7999' } },
      { args: { id: 'e-8000' } },
      { args: { id: 'e-8000', offset: 1 } },
      { args: { id: 'e-8001' } },
      { args: { id: 'e-8001', offset: 1 } },
      { args: { id: 'e-8001', offset: 2 } },
      { args: { id: 'e-8001', offset: 8_000 } },
      { args: { id: 'e-8001', offset: 8_001 } },
      { args: { id: 'e-8001', offset: 8_002 } },
    ],
  },
  {
    name: 'id-page-three',
    group: 'id の全文読み（頁・offset）',
    covers:
      '本文が 16,001 字: 0 → 8000 → 16000（最後は1字）→ 16001（末尾ちょうど）。続きの offset を案内どおりに渡す',
    seed: [bodyOf('p-3', 1, 16_001)],
    steps: [
      { args: { id: 'p-3' } },
      { args: { id: 'p-3', offset: PAGE } },
      { args: { id: 'p-3', offset: 2 * PAGE } },
      { args: { id: 'p-3', offset: 16_001 } },
    ],
  },
  {
    name: 'id-page-astral',
    group: 'id の全文読み（頁・offset）',
    covers:
      '8,000 字目が補助面の文字の途中: 1頁目は 7,999 字で切る（文字を割らない）。続きの offset は 7999。7,999 字目から読むと補助面の文字から始まる',
    seed: [ap('a-1', 1, { question: `${spaced(7_995)}😀tail` })],
    steps: [
      { args: { id: 'a-1' } },
      { args: { id: 'a-1', offset: 7_999 } },
      { args: { id: 'a-1', offset: 8_000 } },
    ],
  },
  {
    name: 'id-page-sections',
    group: 'id の全文読み（頁・offset）',
    covers:
      '本文が 質問・背景・設問・回答・取り下げ理由 の順に `\\n\\n` で並ぶ長い行: 頁の切れ目が欄をまたぐ。回答済みの長い行・取り下げた長い行も同じ頁の扱い',
    seed: [
      ap('z-1', 1, {
        question: spaced(3_000, 'q'),
        context: spaced(3_000, 'c'),
        questions: [Q_SINGLE],
        answer: spaced(3_000, 'a'),
        answeredAt: minuteIso(9),
      }),
      ap('z-2', 2, {
        question: spaced(4_000, 'q'),
        withdrawnAt: minuteIso(9),
        withdrawnReason: spaced(4_500, 'r'),
      }),
    ],
    steps: [
      { args: { id: 'z-1' } },
      { args: { id: 'z-1', offset: PAGE } },
      { args: { id: 'z-2' } },
      { args: { id: 'z-2', offset: PAGE } },
    ],
  },

  // ---- 一覧: 空・読めない行 ----
  {
    name: 'list-empty',
    group: '一覧（空・読めない行）',
    covers:
      '承認が1件も無く読めない行も無い: 「（人間の回答待ちは無い）」。offset・一覧に関係ない引数を付けても同じ',
    seed: [],
    steps: [
      { args: {} },
      { args: { offset: 5 } },
      { args: { cursor: 'garbage', includeClosed: true } },
      { args: { id: undefined, offset: undefined } },
    ],
  },
  {
    name: 'list-settled-only',
    group: '一覧（空・読めない行）',
    covers:
      '回答済み・取り下げ済みだけが在る: 回答待ちだけを読むので「（人間の回答待ちは無い）」に落ちる（承認の行は在るのに）。全文読みでは同じ id が読める',
    seed: [MIX[3]!, MIX[4]!, MIX[5]!, MIX[6]!],
    steps: [{ args: {} }, { args: { id: 'done-1' } }],
  },
  {
    name: 'list-unreadable-only',
    group: '一覧（空・読めない行）',
    covers:
      '読める承認が無く読めない行だけ: 「（読めた回答待ちは無い）」＋読めない行の注（id の並び）',
    seed: [],
    hooks: {
      unreadable: [
        { id: 'bad-1', reason: '壊れた行（テスト用）' },
        { id: 'bad-2', reason: '壊れた行（テスト用）' },
      ],
    },
    steps: [{ args: {} }],
  },
  {
    name: 'list-unreadable-no-id',
    group: '一覧（空・読めない行）',
    covers:
      '読めない行に id が無い: 件数だけ出て「（id も取れない）」。id の有る行・無い行の混在は、有るものだけ並べて「id が取れない行が n 件」。全部 id 有り',
    seed: [],
    steps: [
      { hooks: { unreadable: [{ reason: 'id 無し' }, { reason: 'id 無し 2' }] } },
      { hooks: { unreadable: [{ reason: 'id 無し' }, { id: 'bad-9', reason: 'id 有り' }] } },
      { hooks: { unreadable: [{ id: 'bad-1', reason: 'id 有り' }] } },
    ],
  },
  {
    name: 'list-unreadable-ids-shown',
    group: '一覧（空・読めない行）',
    covers:
      '読めない行の id は 10 件まで: 9・10 件は全部並べ、11 件目から「ほか n 件」。id の無い行は件数に数えるが並びには出ない（12 件のうち 2 件が id 無しなら 10 件並べて省略なし、13 件のうち 2 件が id 無しなら 10 件並べて「ほか 1 件」と「id が取れない行が 2 件」）',
    seed: [],
    steps: [
      ...[9, 10, 11, 15].map((n) => ({
        hooks: {
          unreadable: Array.from({ length: n }, (_, i) => ({
            id: `bad-${pad2(i + 1)}`,
            reason: '壊れ',
          })),
        },
      })),
      {
        hooks: {
          unreadable: [
            ...Array.from({ length: 10 }, (_, i) => ({ id: `bad-${pad2(i + 1)}`, reason: '壊れ' })),
            { reason: 'id 無し' },
            { reason: 'id 無し' },
          ],
        },
      },
      {
        hooks: {
          unreadable: [
            ...Array.from({ length: 11 }, (_, i) => ({ id: `bad-${pad2(i + 1)}`, reason: '壊れ' })),
            { reason: 'id 無し' },
            { reason: 'id 無し' },
          ],
        },
      },
    ],
  },
  {
    name: 'list-with-unreadable',
    group: '一覧（空・読めない行）',
    covers:
      '読める承認と読めない行が両方在る（全件が入る一覧・索引つきの一覧のどちらにも）: 注の並び（抜粋の注 → 読めない行の注 → 並びの注）。読める承認が在れば「（読めた回答待ちは無い）」は出ない',
    seed: MIX,
    hooks: {
      unreadable: [
        { id: 'bad-1', reason: '壊れ' },
        { id: 'bad-2', reason: '壊れ' },
      ],
    },
    steps: [{ args: {} }],
  },
  {
    name: 'list-with-unreadable-indexed',
    group: '一覧（空・読めない行）',
    covers:
      '索引つきの一覧（詳細が予算に入りきらない）に読めない行の注が付く。注は索引・詳細の後ろ・並びの注の前',
    seed: fullTuned(22, LIST_BUDGET + 1),
    hooks: { unreadable: [{ id: 'bad-1', reason: '壊れ' }, { reason: 'id 無し' }] },
    steps: [{ args: {} }],
  },
  {
    name: 'list-fails',
    group: '一覧（空・読めない行）',
    covers:
      '一覧そのものが落ちる（器の障害）: 飲み込まず例外のまま出る（THREW）。全文読みは一覧を呼ばない',
    seed: MIX,
    hooks: { listFails: true },
    steps: [{ args: {} }, { args: { id: 'ask-1' } }],
  },

  // ---- 一覧: 状態・問いの種類・宛先・並び ----
  {
    name: 'list-mix',
    group: '一覧（状態・問いの種類）',
    covers:
      '標準の7件（待ち3・回答済み2・取り下げ2）: 待ちの3件だけが作成の古い順に出る（回答済み・取り下げ済みは出ない）。問いの種類: 質問だけ・設問つき（設問の要約と宛先の行）・request_permission（長い問いを1行に潰した抜粋）。ストアは pendingOnly: true で読む',
    seed: MIX,
    steps: [{ args: {} }, { args: { id: undefined, offset: undefined } }],
  },
  {
    name: 'list-questions-summary',
    group: '一覧（状態・問いの種類）',
    covers:
      '設問の要約: 1 件（単一）・2 件のうち複数選択 1・全部複数選択・設問 0 件の配列（行を出さない）・設問ありと宛先の組み合わせ',
    seed: [
      ap('q-one', 1, { questions: [Q_SINGLE] }),
      ap('q-two', 2, { questions: [Q_SINGLE, Q_MULTI] }),
      ap('q-multi', 3, { questions: [Q_MULTI, { ...Q_MULTI, id: 'notify2' }] }),
      ap('q-zero', 4, { questions: [] }),
      ap('q-dest', 5, { questions: [Q_SINGLE], jobId: 'mgr-1', requestId: 'req-1' }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-dest-variants',
    group: '一覧（状態・問いの種類）',
    covers:
      '宛先の出方: jobId だけ・jobId と requestId・requestId だけ（jobId が無いと出ない）・空文字の jobId（出る）',
    seed: [
      ap('d-job', 1, { jobId: 'mgr-1' }),
      ap('d-both', 2, { jobId: 'mgr-2', requestId: 'req-2' }),
      ap('d-req', 3, { requestId: 'req-3' }),
      ap('d-empty', 4, { jobId: '' }),
      ap('d-empty-both', 5, { jobId: '', requestId: '' }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-order',
    group: '一覧（並び）',
    covers:
      '並びは作成時刻の昇順・同着は id の昇順（積んだ順に依らない）。同着の id は localeCompare（大文字小文字・数字の桁）で比べる',
    seed: [ap('c', 3), ap('a-10', 2), ap('a-2', 2), ap('B', 2), ap('a', 2), ap('z', 1), ap('A', 2)],
    steps: [{ args: {} }],
  },
  {
    name: 'list-order-offset',
    group: '一覧（並び）',
    covers:
      '作成時刻の書き方が違う行（Z と +09:00）の並び: 実時刻の順（+09:00 の 09:00 が最初）。同じ実時刻で表記だけが違う行は id の昇順',
    seed: [
      {
        id: 'tz-z',
        createdAt: '2026-10-01T00:30:00.000Z',
        question: 'Z の 00:30（実時刻は 2 番目、tz-ms と同時刻）',
      },
      {
        id: 'tz-jst',
        createdAt: '2026-10-01T09:00:00+09:00',
        question: '+09:00 の 09:00（実時刻は 1 番目）',
      },
      { id: 'tz-ms', createdAt: '2026-10-01T00:30:00Z', question: '秒の小数なしの Z' },
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-order-same-instant',
    group: '一覧（並び）',
    covers:
      '同じ実時刻で表記だけが違う行（Z・小数つき Z・+09:00）は id の昇順。積んだ順に依らない',
    seed: [
      { id: 'si-c', createdAt: '2026-10-01T09:00:00+09:00', question: '+09:00 表記（si-c）' },
      { id: 'si-a', createdAt: '2026-10-01T00:00:00Z', question: 'Z 表記（si-a）' },
      { id: 'si-b', createdAt: '2026-10-01T00:00:00.000Z', question: '小数つき Z 表記（si-b）' },
    ],
    steps: [{ args: {} }],
  },

  // ---- 件名・問いの抜粋 ----
  {
    name: 'list-title-shape',
    group: '件名・抜粋',
    covers:
      '件名は問いの1行目（前後の空白を落とす）。1行目が空・空白だけなら全体を1行に潰した抜粋。問いが空文字。1行目が複数行の問いの2行目以降は件名に出ず、概要には潰して出る',
    seed: [
      ap('h-multi', 1, { question: '  一行目の題  \n二行目の本文\n三行目' }),
      ap('h-lead-blank', 2, { question: '\n\n本文だけ\nの問い' }),
      ap('h-lead-space', 3, { question: '   \n   次の行\n' }),
      ap('h-empty', 4, { question: '' }),
      ap('h-blank', 5, { question: ' \n\t ' }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-title-limit',
    group: '件名・抜粋',
    covers:
      '件名（60 字）の境目: 問いが 59 / 60 / 61 字: 60 字までは抜粋しない・61 字は 60 字で切って「…（1 文字省略。全 61 文字）」。概要は 200 字の抜粋で別。補助面の文字が 60 字目をまたぐなら 59 字で切る',
    seed: [
      ap('l-59', 1, { question: spaced(59) }),
      ap('l-60', 2, { question: spaced(60) }),
      ap('l-61', 3, { question: spaced(61) }),
      ap('l-astral', 4, { question: `${spaced(59)}😀tail` }),
    ],
    steps: [{ args: {} }],
  },
  {
    name: 'list-summary-limit',
    group: '件名・抜粋',
    covers:
      '概要（問いの抜粋 200 字）の境目: 問いが 199 / 200 / 201 字: 200 字までは抜粋しない（注記なし）・201 字は「…（1 文字省略。全 201 文字）」。空白・改行は潰してから測る（潰す前が 200 字超でも潰した後が収まれば切らない）。補助面の文字が 200 字目をまたぐなら 199 字で切る。長い問いは省略した字数と全体の字数が出る',
    seed: [
      ap('s-199', 1, { question: spaced(199) }),
      ap('s-200', 2, { question: spaced(200) }),
      ap('s-201', 3, { question: spaced(201) }),
      ap('s-1000', 4, { question: spaced(1_000) }),
      ap('s-astral', 5, { question: `${spaced(199)}😀x` }),
      ap('s-ws-short', 6, { question: 'abcdefghi\n\n   '.repeat(15) }),
      ap('s-ws-long', 7, { question: 'abcdefghi\n\n   '.repeat(25) }),
    ],
    steps: [{ args: {} }],
  },

  // ---- 予算: 全件の詳細（8,000）----
  {
    name: 'budget-exact-fit',
    group: '予算（詳細 8,000）',
    covers:
      '22 件の詳細の字数の合計がちょうど 8,000 / 7,999 字: 全部が古い順に出る（索引なし・省略の断り書きなし）。比較は「予算を超えたら切る」（8,000 字ちょうどは超えない）',
    seed: fullTuned(22, LIST_BUDGET),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-under-by-one',
    group: '予算（詳細 8,000）',
    covers: '22 件の詳細の合計が 7,999 字: 全部が古い順に出る（索引なし）',
    seed: fullTuned(22, LIST_BUDGET - 1),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-over-by-one',
    group: '予算（詳細 8,000）',
    covers:
      '22 件の詳細の合計が 8,001 字: 全件の詳細が入りきらないので索引つき（索引は古い順・詳細は新しい順）。詳細は索引の字数を引いた残りで、いちばん古い件が詳細から落ちる',
    seed: fullTuned(22, LIST_BUDGET + 1),
    steps: [{ args: {} }],
  },
  {
    name: 'budget-single-7999',
    group: '予算（詳細 8,000）',
    covers: '1 件だけで 7,999 字: 抜粋せずそのまま・索引なし',
    seed: [single('one-1', 1, LIST_BUDGET - 1)],
    steps: [{ args: {} }],
  },
  {
    name: 'budget-single-8000',
    group: '予算（詳細 8,000）',
    covers: '1 件だけでちょうど 8,000 字: 抜粋せずそのまま・索引なし',
    seed: [single('one-1', 1, LIST_BUDGET)],
    steps: [{ args: {} }],
  },
  {
    name: 'budget-single-8001',
    group: '予算（詳細 8,000）',
    covers:
      '1 件だけで 8,001 字: 先頭の例外で 8,000 字に抜粋される（1 文字省略）・索引なし（残りが 0）',
    seed: [single('one-1', 1, LIST_BUDGET + 1)],
    steps: [{ args: {} }],
  },
  {
    name: 'budget-first-item-over',
    group: '予算（詳細 8,000）',
    covers:
      '索引つきの詳細（新しい順）の先頭の1件だけで詳細の予算を超える: その1件を抜粋して出す（…（n 文字省略。全 m 文字））。最も新しい件が大きい場合',
    seed: [ap('f-old-1', 1), ap('f-old-2', 2), single('f-new-big', 3, 9_000)],
    steps: [{ args: {} }],
  },
  {
    name: 'budget-oldest-over',
    group: '予算（詳細 8,000）',
    covers:
      '大きい件が最も古い（全件の詳細は古い順に先頭から数えるので、先頭が抜粋され後ろが入りきらず索引つきになる）。詳細は新しい順なので、小さい新しい件が先に出て、大きい古い件は残りに入らず省略される',
    seed: [single('g-old-big', 1, 9_000), ap('g-new-1', 2), ap('g-new-2', 3)],
    steps: [{ args: {} }],
  },
  {
    name: 'budget-single-8000-with-after',
    group: '予算（詳細 8,000）',
    covers:
      '先頭の1件がちょうど 8,000 字で後ろに小さな件が続く: 全件の詳細は入りきらないので索引つき。詳細は新しい順なので小さい件が先に出て、8,000 字の古い件は残りに入らず省略される',
    seed: [single('h-big', 1, LIST_BUDGET), ap('h-after', 2)],
    steps: [{ args: {} }],
  },

  // ---- 予算: 詳細の予算（8,000 − 索引の字数）----
  {
    name: 'detail-budget-exact',
    group: '予算（索引つきの詳細）',
    covers:
      '40 件・索引が収まる: 詳細（新しい順）の先頭 12 件の合計がちょうど詳細の予算（8,000 − 索引の字数）: 12 件が出て「ほか 28 件は詳細を省略（新しい順に先頭から 12 件だけ出した…）」',
    seed: detailTuned(40, 12, 0),
    steps: [{ args: {} }],
  },
  {
    name: 'detail-budget-over-by-one',
    group: '予算（索引つきの詳細）',
    covers: '40 件: 先頭 12 件の合計が詳細の予算より 1 字多い: 11 件で止まる（ほか 29 件）',
    seed: detailTuned(40, 12, 1),
    steps: [{ args: {} }],
  },

  // ---- 予算: 索引（4,000）----
  {
    name: 'index-budget-under',
    group: '予算（索引 4,000）',
    covers: '45 件・索引の行の合計が 3,999 字: 全件が索引に出る（省略の断り書きなし）',
    seed: indexTuned(45, INDEX_BUDGET - 1),
    steps: [{ args: {} }],
  },
  {
    name: 'index-budget-exact',
    group: '予算（索引 4,000）',
    covers:
      '45 件・索引の行の合計がちょうど 4,000 字: 全件が索引に出る（省略なし）。比較は「予算を超えたら切る」',
    seed: indexTuned(45, INDEX_BUDGET),
    steps: [{ args: {} }],
  },
  {
    name: 'index-budget-over',
    group: '予算（索引 4,000）',
    covers:
      '45 件・索引の行の合計が 4,001 字: 古い側の 1 件が索引から落ちる（頭に「…索引も古い側の 1 件を省いた（id で開ける）。」）。詳細は新しい順で入る分だけ',
    seed: indexTuned(45, INDEX_BUDGET + 1),
    steps: [{ args: {} }],
  },
  {
    name: 'index-many',
    group: '予算（索引 4,000）',
    covers:
      '150 件: 索引は新しい側から 4,000 字ぶんだけ（古い側の n 件を省いた）。詳細は索引を引いた残り。件数は「回答待ちは 150 件ある」',
    seed: standard(150, 'mm'),
    steps: [{ args: {} }],
  },
  {
    name: 'index-newest-over',
    group: '予算（索引 4,000）',
    covers:
      '最も新しい件の id が 4,500 字で、索引の先頭の1行だけで索引の予算を超える: その行を抜粋して出し、残りの件は索引から省く。詳細も先頭の1件が詳細の予算を超えるので抜粋される',
    seed: [
      ...standard(29, 'nn'),
      { ...ap('x', 100, { question: spaced(200, 'quest') }), id: spaced(4_500, 'newest') },
    ],
    steps: [{ args: {} }],
  },

  // ---- 畳み（同じ会話の2回目から札にする）----
  {
    name: 'fold-full',
    group: '固定の注記の畳み',
    covers:
      '全件の詳細が入る一覧を 1 回目（全文）→ 2 回目（札: 注と並びの注が短くなる）→ サブエージェントの呼び（畳まず全文・控えない）→ 全文読み（畳みの対象外）→ 本体の 3 回目（まだ札）',
    seed: MIX,
    fold: true,
    steps: [
      { args: {} },
      { args: {} },
      { args: {}, caller: 'subagent' },
      { args: { id: 'ask-1' } },
      { args: {} },
    ],
  },
  {
    name: 'fold-index',
    group: '固定の注記の畳み',
    covers:
      '索引つきの一覧を 1 回目（全文）→ 2 回目（札）。索引の並びの注も札になる。全件の一覧と索引つきの一覧は別の控え（全件の一覧の札は別に出る）。読めない行の注は畳まない',
    seed: fullTuned(22, LIST_BUDGET + 1),
    hooks: { unreadable: [{ id: 'bad-1', reason: '壊れ' }] },
    fold: true,
    steps: [{ args: {} }, { args: {} }, { args: {}, caller: 'subagent' }],
  },
  {
    name: 'fold-switch-shape',
    group: '固定の注記の畳み',
    covers:
      '同じ会話で全件の一覧（1 回目）→ 件が増えて索引つき（2 回目: 抜粋の注は札・索引の並びの注は全文）→ 索引つきの2回目（札）。注の控えは形をまたいで共有される',
    seed: MIX,
    fold: true,
    steps: [
      { args: {} },
      {
        args: {},
        // 別の経路が承認を足す（呼ぶ前の状態を作る。道具の書き込みではない）
        before: async (base) => {
          for (const spec of SWITCH_EXTRA) await base.jobs.putApproval(spec);
        },
      },
      { args: {} },
    ],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

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
  /** 承認・委譲・日誌が呼ぶ前から変わったか（読むだけの道具なので全場面で false） */
  wrote: boolean;
  /** 呼びの間に呼ばれたストアの書き込み口（全場面で空） */
  writeCalls: string[];
  /** 呼びの間に呼ばれたストアの読む口（引数つき） */
  readCalls: string[];
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
): Promise<{ approvals: PendingApproval[]; jobs: unknown; journalCount: number }> {
  return {
    approvals: plain((await stores.jobs.listApprovals({ pendingOnly: false })).entries),
    jobs: plain(await stores.jobs.listJobs()),
    journalCount: (await stores.journal.list({ order: 'asc' })).length,
  };
}

function recorded<A extends unknown[], R>(
  calls: string[],
  name: string,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    calls.push(name);
    return fn(...args);
  };
}

function withHooks(
  base: Stores,
  hooks: () => Hooks,
  writeCalls: string[],
  readCalls: string[],
): Stores {
  const jobs: Stores['jobs'] = {
    ...base.jobs,
    listApprovals: async (options) => {
      readCalls.push(`listApprovals ${JSON.stringify(options ?? null)}`);
      const now = hooks();
      if (now.listFails === true) throw new Error('承認待ちの一覧が読めない');
      const listed = await base.jobs.listApprovals(options);
      if (now.unreadable === undefined) return listed;
      return { entries: listed.entries, unreadable: now.unreadable };
    },
    getApproval: async (id) => {
      readCalls.push(`getApproval ${id}`);
      const now = hooks();
      if (now.getUnreadable?.includes(id) === true) {
        throw new UnreadableApprovalError({ id, reason: '読めない行（テスト用）' });
      }
      if (now.getThrows?.includes(id) === true) throw new Error('ストアが落ちた');
      return base.jobs.getApproval(id);
    },
    putApproval: recorded(writeCalls, 'jobs.putApproval', base.jobs.putApproval),
    updateApproval: recorded(writeCalls, 'jobs.updateApproval', base.jobs.updateApproval),
    putJob: recorded(writeCalls, 'jobs.putJob', base.jobs.putJob),
    updateJob: recorded(writeCalls, 'jobs.updateJob', base.jobs.updateJob),
    clear: recorded(writeCalls, 'jobs.clear', base.jobs.clear),
  };
  return {
    ...base,
    jobs,
    journal: {
      ...base.journal,
      append: recorded(writeCalls, 'journal.append', base.journal.append),
    },
  };
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  for (const spec of scenario.seed) await base.jobs.putApproval(spec);
  let hooks: Hooks = {};
  const writeCalls: string[] = [];
  const readCalls: string[] = [];
  const delta = scenario.fold === true ? new DigestSessionDelta() : null;
  const subagentId = 'toolu-from-subagent';
  const tools = createCloneTools({
    stores: withHooks(base, () => hooks, writeCalls, readCalls),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(delta === null
      ? {}
      : {
          foldFixed: (id: string, full: string, ref: string) => delta.fixedInTurn(id, full, ref),
          isSubagentCall: (toolUseId: string | undefined) => toolUseId === subagentId,
        }),
  });
  const found = tools.find((entry) => entry.name === 'approvals_list');
  if (!found) throw new Error('approvals_list が無い');

  const results: PinnedStep[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (step.before !== undefined) await step.before(base);
    hooks = { ...scenario.hooks, ...step.hooks };
    const before = await snapshot(base);
    writeCalls.length = 0;
    readCalls.length = 0;
    const extra = {
      _meta: {
        [TOOL_USE_ID_META_KEY]: step.caller === 'subagent' ? subagentId : 'toolu-main',
      },
    };
    let output: PinnedOutput;
    if (step.desc === true) {
      const text = found.description;
      output = { length: text.length, text, isError: false, thrown: false };
    } else {
      try {
        const result = await found.handler((step.args ?? {}) as never, extra);
        const text = (result.content ?? [])
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        output = { length: text.length, text, isError: result.isError === true, thrown: false };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        output = { length: text.length, text, isError: true, thrown: true };
      }
    }
    const after = await snapshot(base);
    const wrote =
      JSON.stringify(before.approvals) !== JSON.stringify(after.approvals) ||
      JSON.stringify(before.jobs) !== JSON.stringify(after.jobs) ||
      before.journalCount !== after.journalCount;
    // 読むだけの道具: 承認・委譲・日誌が呼ぶ前と同じで、書き込み口も呼ばれていない
    const label = stepKey(scenario, index);
    expect(
      after.approvals,
      `場面 ${label} は読むだけのはずだが、承認の行が呼ぶ前から変わった`,
    ).toEqual(before.approvals);
    expect(after.jobs, `場面 ${label} は読むだけのはずだが、委譲の行が変わった`).toEqual(
      before.jobs,
    );
    expect(after.journalCount, `場面 ${label} は読むだけのはずだが、日誌に行が足された`).toBe(
      before.journalCount,
    );
    expect(writeCalls, `場面 ${label} は読むだけのはずだが、書き込み口が呼ばれた`).toEqual([]);
    results.push({ output, wrote, writeCalls: [...writeCalls], readCalls: [...readCalls] });
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

describe('approvals_list の出力の固定（場面ごとの全文と字数・読むだけで書かないこと）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(
          Object.keys(actual).map((key) => [key, actual[key]?.output.length ?? -1]),
        ),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  }, 120_000);

  afterAll(() => {
    vi.useRealTimers();
  });

  const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
    scenario.steps.map((_, index) => stepKey(scenario, index)),
  );

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

  it('読むだけの道具: 全場面で承認・委譲・日誌が変わらず、書き込み口も呼ばれていない', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 書き込みが起きた`).toBe(false);
      expect(actual[key]?.writeCalls, `${key}: 書き込み口が呼ばれた`).toEqual([]);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote`).toBe(false);
      expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
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
          { isError: got?.output.isError, thrown: got?.output.thrown },
          `場面 ${key} の出力の isError／例外で返ったか、が変わった`,
        ).toEqual({ isError: want?.output.isError, thrown: want?.output.thrown });
        expect(
          got?.readCalls,
          `場面 ${key} の読む口の呼びが変わった（pendingOnly で読むこと・id で引くこと）`,
        ).toEqual(want?.readCalls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.output.text ?? '';
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const before = (key: string, first: string, second: string): boolean =>
      text(key).indexOf(first) >= 0 && text(key).indexOf(first) < text(key).indexOf(second);
    const NO_PENDING = '（人間の回答待ちは無い）';
    const NO_READABLE = '（読めた回答待ちは無い）';
    const NOTE_FULL = '（質問は抜粋。全文は approvals_list id=<id> で取れる。';
    const NOTE_REF = '（質問は抜粋。全文は id=<id> で取れる）';
    const ORDER_FULL = '（並び順: 作成時刻の昇順。';
    const ORDER_REF = '（並び: 作成時刻の昇順、同着は id の昇順）';
    const INDEX_ORDER = '（索引の並び: 作成時刻の昇順。';
    const INDEX_ORDER_REF = '（索引は作成時刻の昇順、同着は id の昇順。詳細はその逆順）';
    const INDEX_HEAD = 'まず索引（id・作成時刻・件名。作成の古い順）:';
    const OMIT_INDEX = '…索引も古い側の ';
    const OMIT_DETAIL = '件は詳細を省略（新しい順に先頭から ';
    const isIndexed = (key: string): boolean => text(key).includes(INDEX_HEAD);
    // 説明文・引数の検査
    expect(text('tool-description')).toContain('更新はいつも作成と同じ');
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(text(`arg-offset#${String(n)}`)).toContain('は使えない（0以上の整数のみ）。');
      expect(actual[`arg-offset#${String(n)}`]?.readCalls).toEqual([]);
    }
    expect(text('arg-offset#8')).toContain('a-1（');
    expect(text('arg-offset#9')).toContain('- a-1 ');
    // id: 無い・読めない
    expect(text('id-missing#1')).toBe('承認待ち no-such は無い（id が違う）。');
    expect(text('id-missing#5')).toBe(text('id-missing#1'));
    expect(text('id-unreadable#1')).toContain('は在るが読めない（壊れた行。');
    expect(text('id-unreadable#3')).toContain('ask-1（');
    expect(text('id-store-error#1')).toBe('ストアが落ちた');
    expect(actual['id-store-error#1']?.output.thrown).toBe(true);
    expect(actual['id-store-error#2']?.output.thrown).toBe(false);
    // id: 状態・宛先・問いの種類
    expect(text('id-each-state#1')).toContain('）回答待ち（');
    expect(text('id-each-state#1')).toContain('背景: 金曜の夕方だが急ぎ');
    expect(text('id-each-state#2')).toContain(' / 宛先 managerId: "mgr-77", requestId: "req-5"');
    expect(text('id-each-state#2')).toContain('設問:\nQ1 [id=target]');
    expect(text('id-each-state#3')).toContain('通る例: pnpm test / pnpm test --run');
    expect(text('id-each-state#4')).toContain('に回答済み（');
    expect(text('id-each-state#4')).toContain('回答: はい');
    expect(text('id-each-state#5')).toContain('に回答済み（');
    expect(text('id-each-state#5')).not.toContain('回答:');
    expect(text('id-each-state#6')).toContain('に取り下げ（');
    expect(text('id-each-state#6')).toContain('取り下げた理由: 自分で答えが見つかった');
    expect(text('id-each-state#7')).not.toContain('取り下げた理由');
    expect(text('id-dest-variants#1')).toContain(' / 宛先 managerId: "mgr-1"');
    expect(text('id-dest-variants#1')).not.toContain('requestId');
    expect(text('id-dest-variants#3')).not.toContain('宛先');
    expect(text('id-dest-variants#4')).toContain('宛先 managerId: ""');
    expect(text('id-status-priority#1')).toContain('に回答済み（');
    expect(text('id-status-priority#1')).toContain('に取り下げも記録されている）');
    expect(text('id-status-priority#1')).toContain('回答: 遅れて届いた回答');
    expect(text('id-status-priority#1')).toContain('取り下げた理由: 先に取り下げた');
    expect(text('id-status-priority#2')).toContain('）取り下げ（時刻の記録が無い）（');
    expect(text('id-status-priority#2')).toContain('取り下げた理由: ');
    expect(text('id-status-priority#3')).toContain('）回答済み（時刻の記録が無い）（');
    expect(text('id-status-priority#3')).toContain('回答: ');
    expect(text('id-status-times-only#1')).toContain('に回答済み（');
    expect(text('id-status-times-only#1')).not.toContain('回答:');
    expect(text('id-status-times-only#2')).toContain('に取り下げ（');
    expect(text('id-status-times-only#2')).not.toContain('取り下げた理由');
    expect(text('id-status-times-only#3')).toContain('に回答済み（');
    expect(text('id-status-times-only#3')).toContain('に取り下げも記録されている）');
    expect(text('id-question-kinds#1')).toMatch(/設問:\n$/);
    expect(text('id-question-kinds#3')).toContain('(27) [id=o27] 案27');
    expect(text('id-question-kinds#4')).not.toContain('permissionRequest');
    expect(text('id-text-shape#1')).toContain(
      '質問: 一行目\n\n  二行目\t三行目\n\n\n背景: 背景\n二行',
    );
    expect(text('id-text-shape#2')).toContain('質問: \n\n背景: \n\n回答: ');
    expect(text('id-text-shape#3')).not.toContain('省略');
    // id: 頁
    expect(text('id-offset-small#1')).toContain('（全 14 文字）');
    expect(text('id-offset-small#2')).toContain('4〜14 文字目 / 全 14 文字');
    expect(text('id-offset-small#3')).toContain('14〜14 文字目 / 全 14 文字');
    expect(text('id-offset-small#4')).toContain('全 14 文字の末尾を越えている');
    expect(text('id-offset-small#5')).toContain('全 14 文字の末尾を越えている');
    expect(text('id-offset-small#6')).toContain('全 14 文字の末尾を越えている');
    expect(text('id-offset-small#1')).not.toContain('ここで切れている');
    expect(text('id-page-edge#1')).toContain('（全 7,999 文字）');
    expect(text('id-page-edge#2')).toContain('（全 8,000 文字）');
    expect(text('id-page-edge#2')).not.toContain('ここで切れている');
    expect(text('id-page-edge#3')).toContain('2〜8,000 文字目 / 全 8,000 文字');
    expect(text('id-page-edge#4')).toContain('1〜8,000 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#4')).toContain('続きは approvals_list id=e-8001 offset=8000）');
    expect(text('id-page-edge#5')).toContain('2〜8,001 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#5')).not.toContain('ここで切れている');
    expect(text('id-page-edge#7')).toContain('8,001〜8,001 文字目 / 全 8,001 文字');
    expect(text('id-page-edge#8')).toContain('全 8,001 文字の末尾を越えている');
    expect(text('id-page-three#1')).toContain('offset=8000）');
    expect(text('id-page-three#2')).toContain('8,001〜16,000 文字目 / 全 16,001 文字');
    expect(text('id-page-three#2')).toContain('offset=16000）');
    expect(text('id-page-three#3')).toContain('16,001〜16,001 文字目 / 全 16,001 文字');
    expect(text('id-page-astral#1')).toContain('1〜7,999 文字目 / 全 8,005 文字');
    expect(text('id-page-astral#1')).toContain('offset=7999）');
    expect(text('id-page-astral#2')).toContain('😀tail');
    expect(text('id-page-sections#1')).toContain('offset=8000）');
    expect(text('id-page-sections#2')).toContain('8,001〜9,121 文字目 / 全 9,121 文字');
    expect(text('id-page-sections#2')).not.toContain('ここで切れている');
    expect(text('id-page-sections#3')).toContain('に取り下げ（1〜8,000 文字目 / 全 ');
    expect(text('id-page-sections#3')).toContain('offset=8000）');
    expect(text('id-page-sections#4')).not.toContain('ここで切れている');
    // 一覧: 空・読めない行
    for (const n of [1, 2, 3, 4]) expect(text(`list-empty#${String(n)}`)).toBe(NO_PENDING);
    expect(text('list-settled-only#1')).toBe(NO_PENDING);
    expect(text('list-settled-only#2')).toContain('に回答済み（');
    expect(text('list-unreadable-only')).toContain(`${NO_READABLE}\n`);
    expect(text('list-unreadable-only')).toContain('（id: bad-1, bad-2）');
    expect(text('list-unreadable-no-id#1')).toContain('（id も取れない）');
    expect(text('list-unreadable-no-id#2')).toContain('（id: bad-9。id が取れない行が 1 件）');
    expect(text('list-unreadable-ids-shown#1')).toContain('bad-09）');
    expect(text('list-unreadable-ids-shown#1')).not.toContain('ほか');
    expect(text('list-unreadable-ids-shown#2')).toContain('bad-10）');
    expect(text('list-unreadable-ids-shown#2')).not.toContain('ほか');
    expect(text('list-unreadable-ids-shown#3')).toContain('bad-10 ほか 1 件）');
    expect(text('list-unreadable-ids-shown#4')).toContain('ほか 5 件）');
    expect(text('list-unreadable-ids-shown#5')).toContain('id が取れない行が 2 件）');
    expect(text('list-unreadable-ids-shown#5')).not.toContain('ほか');
    expect(text('list-unreadable-ids-shown#6')).toContain('ほか 1 件。id が取れない行が 2 件）');
    expect(before('list-with-unreadable', NOTE_FULL, '読めない承認待ちが 2 件')).toBe(true);
    expect(before('list-with-unreadable', '読めない承認待ちが 2 件', ORDER_FULL)).toBe(true);
    expect(text('list-with-unreadable')).not.toContain(NO_READABLE);
    expect(isIndexed('list-with-unreadable')).toBe(false);
    expect(isIndexed('list-with-unreadable-indexed')).toBe(true);
    expect(before('list-with-unreadable-indexed', '読めない承認待ちが 2 件', INDEX_ORDER)).toBe(
      true,
    );
    expect(text('list-fails#1')).toBe('承認待ちの一覧が読めない');
    expect(actual['list-fails#1']?.output.thrown).toBe(true);
    expect(text('list-fails#2')).toContain('ask-1（');
    expect(actual['list-fails#2']?.readCalls).toEqual(['getApproval ask-1']);
    // 一覧: 状態・問いの種類
    expect(actual['list-mix#1']?.readCalls).toEqual(['listApprovals {"pendingOnly":true}']);
    expect(text('list-mix#1')).toContain('- ask-1 ');
    expect(text('list-mix#1')).toContain('- perm-1 ');
    for (const id of ['done-1', 'done-2', 'wd-1', 'wd-2']) {
      expect(text('list-mix#1')).not.toContain(id);
    }
    expect(text('list-mix#2')).toBe(text('list-mix#1'));
    expect(text('list-mix#1')).toContain('設問 2 件（うち複数選択 1）（選択肢つき）');
    expect(text('list-mix#1')).toContain('宛先: managerId: "mgr-77", requestId: "req-5"');
    expect(text('list-questions-summary')).toContain('設問 1 件（選択肢つき）');
    expect(text('list-questions-summary')).toContain('（うち複数選択 2）');
    expect(text('list-questions-summary')).toContain('- q-zero 質問 q-zero\n  作成: ');
    expect(count(text('list-questions-summary'), '（詳細は approvals_list id=<id>）')).toBe(4);
    expect(text('list-dest-variants')).toContain('宛先: managerId: ""\n');
    expect(text('list-dest-variants')).toContain('宛先: managerId: "", requestId: ""');
    expect(count(text('list-dest-variants'), '宛先:')).toBe(4);
    for (const [a, b] of [
      ['- z ', '- a '],
      ['- a ', '- A '],
      ['- A ', '- a-10 '],
      ['- a-10 ', '- a-2 '],
      ['- a-2 ', '- B '],
      ['- B ', '- c '],
    ] as const) {
      expect(before('list-order', a, b)).toBe(true);
    }
    expect(before('list-order-offset', '- tz-jst ', '- tz-ms ')).toBe(true);
    expect(before('list-order-offset', '- tz-ms ', '- tz-z ')).toBe(true);
    expect(before('list-order-same-instant', '- si-a ', '- si-b ')).toBe(true);
    expect(before('list-order-same-instant', '- si-b ', '- si-c ')).toBe(true);
    // 件名・抜粋
    expect(text('list-title-shape')).toContain('- h-multi 一行目の題\n');
    expect(text('list-title-shape')).toContain('- h-lead-blank 本文だけ の問い\n');
    expect(text('list-title-shape')).toContain('- h-empty \n');
    expect(count(text('list-title-limit'), '文字省略。全 ')).toBe(2);
    expect(text('list-title-limit')).toContain('…（1 文字省略。全 61 文字）');
    expect(text('list-title-limit')).not.toContain('全 59 文字');
    expect(text('list-title-limit')).not.toContain('全 60 文字');
    expect(text('list-title-limit')).toContain('…（6 文字省略。全 65 文字）');
    expect(text('list-summary-limit')).toContain('…（1 文字省略。全 201 文字）');
    expect(text('list-summary-limit')).toContain('全 1,000 文字）');
    expect(text('list-summary-limit')).toContain('…（3 文字省略。全 202 文字）');
    expect(text('list-summary-limit')).toContain('abcdefghix\n- s-201 ');
    expect(text('list-summary-limit')).toContain('全 249 文字）\n');
    expect(text('list-summary-limit')).toContain('- s-ws-short abcdefghi\n');
    // 予算（全件の詳細）
    for (const key of ['budget-exact-fit', 'budget-under-by-one']) {
      expect(isIndexed(key)).toBe(false);
      expect(text(key)).not.toContain('件は詳細を省略');
      expect(text(key)).toContain('- b-22 ');
      expect(text(key)).toContain(ORDER_FULL);
    }
    expect(isIndexed('budget-over-by-one')).toBe(true);
    expect(text('budget-over-by-one')).toContain('回答待ちは 22 件ある。');
    expect(text('budget-over-by-one')).toContain(INDEX_ORDER);
    expect(text('budget-over-by-one')).toContain(`${OMIT_DETAIL}16 件だけ出した`);
    expect(before('budget-over-by-one', '詳細（新しい順）:', '- b-22 ')).toBe(true);
    expect(before('budget-over-by-one', '- b-22 ', '- b-21 ')).toBe(true);
    for (const key of ['budget-single-7999', 'budget-single-8000']) {
      expect(isIndexed(key)).toBe(false);
      expect(text(key)).not.toContain('文字省略');
    }
    expect(isIndexed('budget-single-8001')).toBe(false);
    expect(text('budget-single-8001')).toContain('…（1 文字省略。全 8,001 文字）');
    expect(isIndexed('budget-first-item-over')).toBe(true);
    expect(text('budget-first-item-over')).toContain('文字省略。全 9,');
    expect(isIndexed('budget-oldest-over')).toBe(true);
    expect(text('budget-oldest-over')).toContain(`${OMIT_DETAIL}2 件だけ出した`);
    expect(isIndexed('budget-single-8000-with-after')).toBe(true);
    expect(text('budget-single-8000-with-after')).toContain(`${OMIT_DETAIL}1 件だけ出した`);
    // 予算（詳細の予算）
    expect(text('detail-budget-exact')).toContain(`${OMIT_DETAIL}12 件だけ出した`);
    expect(text('detail-budget-over-by-one')).toContain(`${OMIT_DETAIL}11 件だけ出した`);
    // 予算（索引）
    for (const key of ['index-budget-under', 'index-budget-exact']) {
      expect(isIndexed(key)).toBe(true);
      expect(text(key)).not.toContain(OMIT_INDEX);
      expect(text(key)).toContain('・ix-02（');
    }
    expect(text('index-budget-over')).toContain(`${OMIT_INDEX}1 件を省いた（id で開ける）。`);
    expect(text('index-many')).toContain('回答待ちは 150 件ある');
    expect(text('index-many')).toContain(`${OMIT_INDEX}101 件を省いた`);
    expect(text('index-newest-over')).toContain(`${OMIT_INDEX}29 件を省いた`);
    expect(text('index-newest-over')).toContain('文字省略。全 ');
    // 畳み
    expect(text('fold-full#1')).toContain(NOTE_FULL);
    expect(text('fold-full#1')).toContain(ORDER_FULL);
    expect(text('fold-full#2')).toContain(NOTE_REF);
    expect(text('fold-full#2')).toContain(ORDER_REF);
    expect(text('fold-full#3')).toBe(text('fold-full#1'));
    expect(text('fold-full#4')).toContain('ask-1（');
    expect(text('fold-full#5')).toBe(text('fold-full#2'));
    expect(text('fold-index#1')).toContain(INDEX_ORDER);
    expect(text('fold-index#2')).toContain(NOTE_REF);
    expect(text('fold-index#2')).toContain(INDEX_ORDER_REF);
    expect(text('fold-index#2')).toContain('読めない承認待ちが 1 件ある（id: bad-1）');
    expect(text('fold-index#3')).toBe(text('fold-index#1'));
    expect(text('fold-switch-shape#1')).toContain(ORDER_FULL);
    expect(text('fold-switch-shape#2')).toContain(NOTE_REF);
    expect(text('fold-switch-shape#2')).toContain(INDEX_ORDER);
    expect(text('fold-switch-shape#3')).toContain(INDEX_ORDER_REF);
  });
});
