import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DENIAL_ASK_AFTER_ANSWER_PARAGRAPH } from './classifier-denial-streak.js';
import {
  ORIGIN_NO_TASK_GUIDE,
  ORIGIN_TASK_GUIDE,
  REPORT_FOLLOW_UP_GUIDE,
  REPORT_FULL_TEXT_NOTE_MARK,
  REPORT_WITHHELD_NOTE_MARK,
} from './clone-batch-prompts.js';
import { parseJournalJsonl } from './diagnostics-analysis.js';
import {
  analyzeConversation,
  conversationDistOf,
  EXCHANGE_HEAD_CHARS,
  MANAGER_SIGNAL_KINDS,
  type ConversationAnalysis,
  type ConversationManifestInput,
  type ExchangesSection,
  type MeasuredSection,
} from './diagnostics-conversation-analysis.js';
import { EXCHANGE_STOP_MARK, classifyExchangeText } from './diagnostics-conversation-classify.js';
import {
  renderConversationAnalysis,
  renderConversationCoverage,
} from './diagnostics-conversation-format.js';
import { DENIAL_REPLY_ROUTE } from './denial-key.js';
import { EXCHANGE_KIND_RECORD_PREFIX } from './exchange-kind.js';
import type { InboxEvent } from './schema.js';
import { createSecretRedactor } from './secret-redaction.js';
import { READINGS_NOTICE, SITUATION_HEAD } from './situation.js';
import { buildTurnInputEntry } from './turn-input-observation.js';

// ダミーの鍵（どこの鍵でもない。繰り返しで作る）
const DUMMY_KEY = `ghp_${'a1B2'.repeat(9)}`;

const jsonl = (...rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const redactor = () => createSecretRedactor({ env: {} });

function run(
  over: {
    journal?: unknown[];
    exchanges?: unknown[];
    manifest?: ConversationManifestInput;
  },
  topN = 10,
): ConversationAnalysis {
  const redact = redactor();
  return analyzeConversation({
    journal: parseJournalJsonl(jsonl(...(over.journal ?? []))),
    exchanges:
      over.exchanges === undefined
        ? { state: 'none', reason: '渡されていない' }
        : { state: 'read', parsed: parseJournalJsonl(jsonl(...over.exchanges)) },
    manifest: over.manifest ?? { state: 'none', reason: '渡されていない' },
    topN,
    redact: (text) => redact.redact(text),
  });
}

const measuredOf = (a: ConversationAnalysis): MeasuredSection => {
  if (a.measured.state !== 'read') throw new Error('実測の節が無い');
  return a.measured;
};
const exchangesOf = (a: ConversationAnalysis): ExchangesSection => {
  if (a.exchanges.state !== 'read') throw new Error('会話の節が無い');
  return a.exchanges;
};

// ---- turn_input の固定のフィクスチャ（手計算できる。時刻は UTC） ----
const G = REPORT_FOLLOW_UP_GUIDE.length;
const R = DENIAL_REPLY_ROUTE.length;

const turnInput = (id: string, hhmm: string, extra: Record<string, unknown>) => ({
  type: 'turn_input',
  id,
  at: `2026-11-10T${hhmm}:00.000Z`,
  conversationId: 'c',
  attachments: 0,
  ...extra,
});

// T1: 1000 = notices(200+100) + human 0 + fresh 100 + body 600。situationParts の和は 200
const T1 = turnInput('t1', '01:00', {
  kind: 'normal',
  triggers: ['manager_message'],
  totalChars: 1000,
  bodyChars: 600,
  humanActionsChars: 0,
  freshMemoryChars: 100,
  notices: { situation: 200, redelivery: 100 },
  situationParts: { head: 20, delegation: 30, runners: 10, readings: 120, separator: 20 },
  signals: [
    { kind: 'manager_report', managerId: 'm1', chars: 9000 },
    { kind: 'denial_notice', managerId: 'm2', chars: 300 },
  ],
  templates: { REPORT_FOLLOW_UP_GUIDE: 2 * G, DENIAL_REPLY_ROUTE: R },
  framingChars: 100,
  attachments: 1,
});
// T2: 蒸留。notices は空（0 字が実測）
const T2 = turnInput('t2', '02:00', {
  kind: 'distill',
  triggers: ['distill'],
  totalChars: 500,
  bodyChars: 500,
  humanActionsChars: 0,
  freshMemoryChars: 0,
  notices: {},
  signals: [{ kind: 'distill', chars: 0 }],
  framingChars: 500,
});
// T3: 先頭 20 件より後を 5 件省いた
const T3 = turnInput('t3', '03:00', {
  kind: 'normal',
  triggers: ['manager_message', 'timer'],
  totalChars: 2000,
  bodyChars: 1800,
  humanActionsChars: 0,
  freshMemoryChars: 0,
  notices: { situation: 200 },
  signals: [{ kind: 'manager_question', managerId: 'm1', chars: 40 }],
  signalsOmitted: 5,
  framingChars: 1760,
});

describe('会話の分析: turn_input（実測）', () => {
  const a = run({ journal: [T1, T2, T3] });
  const m = measuredOf(a);

  it('ターンの総量: 件数・合計・中央値・p90・最大と、kind 別・起点別', () => {
    expect(m.rows).toBe(3);
    expect(m.total).toEqual({ count: 3, sum: 3500, median: 1000, p90: 2000, max: 2000 });
    expect(m.byKind.map((g) => [g.key, g.turns, g.total.sum])).toEqual([
      ['normal', 2, 3000],
      ['distill', 1, 500],
    ]);
    expect(m.bySingleTrigger.find((g) => g.key === 'manager_message')?.turns).toBe(2);
    expect(m.byBundle.map((g) => g.key).sort()).toEqual([
      'distill',
      'manager_message',
      'manager_message+timer',
    ]);
  });

  it('内訳の占有率: 「いまの全体」の注記・各 notices・body・framing の割合と1ターン中央値', () => {
    const o = m.occupancy;
    expect(o.totalCharsSum).toBe(3500);
    // situation: [200, 0, 200]。notices が空のターンの 0 字は実測の 0
    expect(o.situation.chars).toBe(400);
    expect(o.situation.share).toBeCloseTo(400 / 3500, 10);
    expect(o.situation.perTurnMedian).toBe(200);
    expect(o.situation.rows).toEqual({ obtained: 3, missing: 0 });
    const redelivery = o.notices.find((x) => x.key === 'redelivery');
    expect(redelivery?.chars).toBe(100);
    expect(redelivery?.share).toBeCloseTo(100 / 3500, 10);
    expect(o.freshMemory.chars).toBe(100);
    expect(o.body.chars).toBe(2900);
    // 実測の区分の和が totalChars に一致する（Σnotices + human + fresh + body）
    const noticeSum = o.notices.reduce((x, n) => x + n.chars, 0);
    expect(noticeSum + o.humanActions.chars + o.freshMemory.chars + o.body.chars).toBe(3500);
    expect(o.framing.chars).toBe(100 + 500 + 1760);
    expect(o.bodyInside.signals.chars).toBe(9000 + 300 + 0 + 40);
    expect(o.bodyInside.templates.chars).toBe(2 * G + R);
  });

  it('situationParts: 区分の読み方と delegation・runners の割合（内訳のあるターンの situation を分母にする）', () => {
    const sp = m.situationParts;
    expect(sp.turnsWithSituation).toBe(2);
    expect(sp.turnsWithParts).toBe(1);
    expect(sp.situationCharsWithParts).toBe(200);
    const readings = sp.parts.find((p) => p.key === 'readings');
    expect(readings?.chars).toBe(120);
    expect(readings?.shareOfSituation).toBeCloseTo(0.6, 10);
    expect(readings?.shareOfTotal).toBeCloseTo(120 / 3500, 10);
    expect(sp.parts.map((p) => p.key)).toEqual([
      'readings',
      'delegation',
      'head',
      'separator',
      'runners',
    ]);
  });

  it('templates: 名前ごとの回数（字数÷定数の長さ）・合計・割合。拒否の定型を含む', () => {
    const guide = m.templates.find((t) => t.name === 'REPORT_FOLLOW_UP_GUIDE');
    expect(guide).toMatchObject({ turns: 1, chars: 2 * G, occurrences: 2, divisible: true });
    const denial = m.templates.find((t) => t.name === 'DENIAL_REPLY_ROUTE');
    expect(denial).toMatchObject({ chars: R, occurrences: 1 });
    expect(denial?.shareOfTotal).toBeCloseTo(R / 3500, 10);
    const text = renderConversationAnalysis(a, 10);
    expect(text).toContain('★ DENIAL_REPLY_ROUTE');
  });

  it('signals: kind ごとの件数・chars、委譲ごと、8000 字超、取れなかった分（0 を置かない）', () => {
    const s = m.signals;
    expect(s.byKind.find((k) => k.kind === 'manager_report')).toMatchObject({
      count: 1,
      overLimit: 1,
      chars: { sum: 9000, max: 9000 },
    });
    expect(s.byKind.find((k) => k.kind === 'denial_notice')?.overLimit).toBe(0);
    // 本文を持たない種類は束で 0 が書かれ、取れない: 字数の集計は出さない
    expect(s.byKind.find((k) => k.kind === 'distill')).toMatchObject({ count: 1, chars: null });
    expect(s.overLimitTotal).toBe(1);
    expect(s.omitted).toEqual({ rows: 1, total: 5 });
    expect(s.byManager.totalManagers).toBe(2);
    expect(s.byManager.rows.map((r) => [r.managerId, r.count, r.chars])).toEqual([
      ['m1', 2, 9040],
      ['m2', 1, 300],
    ]);
    // coverage の警告に、先頭 20 件より後の取れなかった分が出る
    expect(a.coverage.warnings.join('\n')).toContain('先頭 20 件より後');
    expect(a.coverage.warnings.join('\n')).toContain('5 件');
  });

  it('redelivery の注記が出たターンの割合と、上位のターン（文字数だけ）', () => {
    expect(m.redelivery).toMatchObject({ turns: 3, withNotice: 1 });
    expect(m.redelivery.share).toBeCloseTo(1 / 3, 10);
    expect(m.attachments.sum).toBe(1);
    const top = run({ journal: [T1, T2, T3] }, 2);
    expect(measuredOf(top).top.map((t) => [t.id, t.kind, t.totalChars, t.situationChars])).toEqual([
      ['t3', 'normal', 2000, 200],
      ['t1', 'normal', 1000, 200],
    ]);
  });

  it('欄が欠けた行は読み飛ばさず「取れない」に数える（totalChars が無い行だけ除く）', () => {
    const sparse = run({
      journal: [
        T1,
        { type: 'turn_input', id: 'x', at: '2026-11-10T04:00:00.000Z', kind: 'normal' },
        // notices・signals が無い旧い形の行
        turnInput('t4', '05:00', { kind: 'normal', triggers: [], totalChars: 10 }),
      ],
    });
    const sm = measuredOf(sparse);
    expect(sm.rows).toBe(2);
    expect(sm.unreadableRows).toBe(1);
    // t4 は notices が読めない: 0 ではなく取れない側に数える
    expect(sm.occupancy.situation.rows).toEqual({ obtained: 1, missing: 1 });
    expect(sm.occupancy.body.rows).toEqual({ obtained: 1, missing: 1 });
  });

  it('turn_input が1行も無いと実測の節は出さず、理由を書く（0 の表にしない）', () => {
    const none = run({
      journal: [{ type: 'turn_timing', id: 'a', at: '2026-11-10T01:00:00.000Z' }],
    });
    expect(none.measured.state).toBe('none');
    const text = renderConversationAnalysis(none, 10);
    expect(text).toContain('## A. ターンの入力（実測');
    expect(text).toContain('turn_input の行が無い');
    expect(renderConversationCoverage(none)).toContain('turn_input の行が1つも無い');
  });
});

// ---- exchange のフィクスチャ ----
const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const at = (minute: number): string => new Date(T0 + minute * 60_000).toISOString();
const ex = (
  id: string,
  minute: number,
  role: 'inbound' | 'outbound',
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'exchange',
  id,
  at: at(minute),
  with: 'manager',
  role,
  text,
  ...extra,
});

const NOTE_REST =
  '300 字は manager_report managerId=m1 で読める。これはターンの最後の発言だけである）';
const MAIN = 'r'.repeat(100);
const FULL_NOTE = `${REPORT_FULL_TEXT_NOTE_MARK}${NOTE_REST}`;
const WITHHELD_NOTE = `${REPORT_WITHHELD_NOTE_MARK}3 本配っていない。\n）`;

const EXCHANGES = [
  ex('e1', 0, 'outbound', '[応答] [m1] 依頼本文です', { managerId: 'm1' }),
  // Pool 受領時の行: managerId 欄なし・途中の発言込みの全文（300 字）
  ex('e2', 5, 'inbound', `[応答] [m1] ${'p'.repeat(300)}`),
  // 配達時の行: 最後の発言（100 字）＋全文の在りかの注記
  ex('e3', 6, 'inbound', `[応答] [m1/report] ${MAIN}${FULL_NOTE}`, { managerId: 'm1' }),
  ex('e4', 7, 'inbound', `[応答] [m2/report] 拒否された${DENIAL_REPLY_ROUTE}`, { managerId: 'm2' }),
  ex('e5', 8, 'inbound', '[応答] [m1/question] 質問ですか', { managerId: 'm1' }),
  ex('e6', 9, 'outbound', '[応答] [m1] はい', { managerId: 'm1' }),
  ex('e7', 10, 'outbound', '[応答] [m1] 追加の指示', { managerId: 'm1' }),
  ex('e8', 11, 'inbound', `[応答] [m1/report] 完了${WITHHELD_NOTE}`, { managerId: 'm1' }),
  ex('e9', 12, 'outbound', `[応答] [m1] ${EXCHANGE_STOP_MARK}[outcome=stopped] 止めた`),
  ex('e10', 13, 'outbound', '[復旧] [m1] （再起動後の再開）再開'),
  ex('e11', 14, 'inbound', '[判断] [m1] 無視した'),
  ex('e12', 15, 'inbound', '[障害] [m1] 失敗した', { managerId: 'm1' }),
  ex('e13', 16, 'inbound', '接頭辞のない文'),
  ex('e14', 17, 'inbound', '[応答] [zz] 迷子'),
  // pull は保存しない行と、exchange でない行
  { ...ex('e15', 18, 'inbound', '人間との会話'), with: 'human' },
  { type: 'decision', id: 'd1', at: at(19), decision: 'x', grounds: 'y' },
];

describe('会話の分析: exchanges（本文から数えた）', () => {
  const a = run({ exchanges: EXCHANGES });
  const e = exchangesOf(a);
  const count = (kind: string) => e.byKind.find((k) => k.kind === kind)?.count;

  it('分類: 行ごとに1つの種類。Pool の全文行と配達行は別の種類で、同じ報告を二重に数えない', () => {
    expect(e.byKind.map((k) => [k.kind, k.count])).toEqual([
      ['report', 1],
      ['question', 1],
      ['permission', 0],
      ['denial_notice', 1],
      ['folded_bundle', 1],
      ['pool_full', 2],
      ['clone_request', 1],
      ['clone_followup', 1],
      ['clone_answer', 1],
      ['stop', 1],
      ['resume', 1],
      ['decision', 1],
      ['other', 2],
    ]);
    // 読めた行の数 = 種類の件数の合計（捨てた行は無い）
    expect(e.byKind.reduce((x, k) => x + k.count, 0)).toBe(14);
    // 同じ報告（e2 の全文と e3 の配達）はそれぞれ別の種類に1回ずつ。配達の合計に Pool 行は入らない
    expect(count('report')).toBe(1);
    expect(count('pool_full')).toBe(2);
    expect(e.delivered.count).toBe(4);
    expect(a.coverage.exchanges).toMatchObject({
      state: 'read',
      rows: 14,
      nonManagerRows: 1,
      notExchangeRows: 1,
    });
  });

  it('分類できない行は「その他」に件数と文字数で出る（捨てない）', () => {
    // 文字数の多い順
    expect(e.otherBreakdown).toEqual([
      { key: '接頭辞なし', count: 1, chars: '接頭辞のない文'.length },
      { key: 'failure の接頭辞', count: 1, chars: '失敗した'.length },
    ]);
    expect(e.byKind.find((k) => k.kind === 'other')?.chars.sum).toBe(
      '失敗した'.length + '接頭辞のない文'.length,
    );
  });

  it('種類ごとの文字数: 合計・中央値・p90・最大は本文（接頭辞と [id…] を除く）の字数', () => {
    const report = e.byKind.find((k) => k.kind === 'report');
    expect(report?.chars.sum).toBe(MAIN.length + FULL_NOTE.length);
    const pool = e.byKind.find((k) => k.kind === 'pool_full');
    // 300 字と '迷子' 2 字
    expect(pool?.chars).toEqual({ count: 2, sum: 302, median: 151, p90: 300, max: 300 });
  });

  it('追加指示・返事・依頼は順序からの判定で、そう印を付ける', () => {
    expect(e.byKind.find((k) => k.kind === 'clone_answer')?.basis).toBe('derived-from-order');
    expect(e.byKind.find((k) => k.kind === 'report')?.basis).toBe('text-derived');
    expect(renderConversationAnalysis(a, 10)).toContain('順序からの判定');
  });

  it('委譲ごと: managerId 欄が無い Pool 行・停止行は、欄を持つ行で見えた id と一致すれば引く。引けなければ managerId なし', () => {
    const m1 = e.byManager.rows.find((r) => r.managerId === 'm1');
    // e2（Pool・欄なし）と e9（停止・欄なし）と e10（再開）と e11（判断）が m1 に入る
    expect(m1?.byKind.find((k) => k.kind === 'pool_full')).toEqual({
      kind: 'pool_full',
      count: 1,
      chars: 300,
    });
    expect(m1?.byKind.find((k) => k.kind === 'stop')?.count).toBe(1);
    // e13（接頭辞なし）と e14（未知の id）は managerId なし
    expect(e.byManager.withoutManagerId).toEqual({
      count: 2,
      chars: '接頭辞のない文'.length + '迷子'.length,
    });
    expect(e.byManager.totalManagers).toBe(2);
  });

  it('本文に残る定型: 拒否の答え方・全文の注記・畳んだ報告の注記の占有（本文の字面から数えた）', () => {
    const t = e.templatesInText;
    expect(t.denialRoute).toMatchObject({ rows: 1, occurrences: 1, chars: R });
    expect(t.denialRoute.shareOfDelivered).toBeCloseTo(R / t.deliveredChars, 10);
    const full = t.notes.find((n) => n.key === 'fullText');
    expect(full).toMatchObject({ rows: 1, chars: FULL_NOTE.length });
    const withheld = t.notes.find((n) => n.key === 'withheld');
    expect(withheld).toMatchObject({ rows: 1, chars: WITHHELD_NOTE.length });
  });

  it('許可確認の拒否後の答え方（permission の本文に残る定型）を数える', () => {
    const b = exchangesOf(
      run({
        exchanges: [
          ex(
            'p1',
            0,
            'inbound',
            `[応答] [m1/permission] 確認 ${DENIAL_ASK_AFTER_ANSWER_PARAGRAPH}`,
            { managerId: 'm1' },
          ),
        ],
      }),
    );
    expect(b.byKind.find((k) => k.kind === 'permission')?.count).toBe(1);
    expect(b.templatesInText.denialAskAfterAnswer).toMatchObject({
      rows: 1,
      chars: DENIAL_ASK_AFTER_ANSWER_PARAGRAPH.length,
    });
  });

  it('上位の大きい文面: 先頭 80 字・改行は空白・伏せ字は切る前の全文へ掛ける（鍵の断片を残さない）', () => {
    const body = `${'あ'.repeat(78)}${DUMMY_KEY}\n続き${'い'.repeat(100)}`;
    const redact = redactor();
    const top = analyzeConversation({
      journal: parseJournalJsonl(''),
      exchanges: {
        state: 'read',
        parsed: parseJournalJsonl(
          jsonl(ex('s1', 0, 'inbound', `[応答] [m1/report] ${body}`, { managerId: 'm1' })),
        ),
      },
      manifest: { state: 'none', reason: 'x' },
      topN: 1,
      redact: (text) => redact.redact(text),
    });
    const [row] = exchangesOf(top).top;
    expect(row?.kind).toBe('report');
    expect(row?.chars).toBe(body.length);
    expect([...(row?.head ?? '')].length).toBeLessThanOrEqual(EXCHANGE_HEAD_CHARS);
    expect(row?.head).toContain('[r');
    expect(row?.head).not.toContain('ghp_');
    expect(row?.head).not.toContain('\n');
    // 当たった規則と件数は呼び手（標準エラー）へ出せる。値は含まない
    const hits = redact.hits();
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).not.toContain(DUMMY_KEY);
    expect(JSON.stringify(top)).not.toContain(DUMMY_KEY);
  });

  it('exchanges が無いとき、会話と混入の節は「入力が無い」と出す（落とさない・0 にしない）', () => {
    const none = run({ journal: [T1] });
    expect(none.exchanges).toEqual({ state: 'none', reason: '渡されていない' });
    const text = renderConversationAnalysis(none, 10);
    expect(text).toContain('## B. 会話');
    expect(text).toContain('入力が無い: 渡されていない');
    expect(text).toContain('## C. 作業途中の混入の目安');
    expect(renderConversationCoverage(none)).toContain('exchanges.jsonl: 入力が無い');
  });
});

describe('会話の分析: 作業途中の混入の目安', () => {
  const noisy = [
    '結論です',
    '```ts',
    'const a = 1;',
    '```',
    'src/foo/bar.ts',
    '    at run (/x/y.js:1:2)',
    'TypeError: boom',
    'tool_result: ok',
  ].join('\n');
  const a = run({
    exchanges: [
      ex('c4', 0, 'outbound', '[応答] [m1] 依頼', { managerId: 'm1' }),
      ex('c1', 1, 'inbound', `[応答] [m1] ${noisy}\n途中の発言です`),
      ex('c2', 2, 'inbound', `[応答] [m1/report] ${noisy}${FULL_NOTE}`, {
        managerId: 'm1',
        attachments: [{ id: 'a' }, { id: 'b' }],
      }),
      ex('c3', 3, 'inbound', `[応答] [m1/report] ${'x'.repeat(8001)}`, {
        managerId: 'm1',
        rejectedAttachments: [{ name: 'f' }],
      }),
    ],
  });
  const c = a.contamination;
  if (c.state !== 'read') throw new Error('混入の節が無い');

  it('Pool 行と配達行の長さ比・配達行の注記「全文 N 字」から読む途中の発言の量', () => {
    // c1（Pool）→ c2（配達）で対になり、c3 は Pool 行の無い配達行
    expect(c.poolVsDelivery).toMatchObject({ paired: 1, unpairedPool: 0, unpairedDelivery: 1 });
    expect(c.poolVsDelivery.ratio.count).toBe(1);
    const f = c.poolVsDelivery.fullTextNote;
    expect(f).toMatchObject({ reportRows: 2, rowsWithNote: 1, inconsistent: 0 });
    expect(f.fullChars.sum).toBe(300);
    expect(f.intermediateChars.sum).toBe(Math.max(0, 300 - noisy.length));
  });

  it('8000 字超の報告（切られる条件を満たす行）の件数と、報告1件の字数の分布', () => {
    expect(c.overLimit).toMatchObject({ limit: 8000, reportRows: 2, rowsOverLimit: 1, share: 0.5 });
    expect(c.overLimit.reportChars.max).toBe(8001);
  });

  it('コードブロック・パス風・スタックトレース風・Error:・tool_result 風を、注記を除いた主文で測る（行の割合は空行と囲みを除く）', () => {
    const p = c.patterns.delivery;
    // c2 の主文 6 行（囲みの2行・空行を除く）+ c3 の 1 行 = 7 行
    expect(p.rows).toBe(2);
    expect(p.rowsWithFence).toBe(1);
    expect(p.rowsWithPathLike).toBe(1);
    expect(p.rowsWithStack).toBe(1);
    expect(p.rowsWithError).toBe(1);
    expect(p.rowsWithToolResult).toBe(1);
    expect(p.lines).toBe(7);
    expect(p.pathLikeLineShare).toBeCloseTo(1 / 7, 10);
    expect(p.stackLineShare).toBeCloseTo(1 / 7, 10);
    expect(p.toolResultLineShare).toBeCloseTo(1 / 7, 10);
    expect(c.patterns.poolFull.rowsWithFence).toBe(1);
    const text = renderConversationAnalysis(a, 10);
    expect(text).toContain('使ったパターン');
    expect(text).toContain('tool_result の専用の欄は日誌に無い');
  });

  it('添付の件数、依頼文と報告の長さの比（委譲ごと）', () => {
    expect(c.attachments).toEqual({ rowsWithAttachments: 1, attachments: 2, rowsWithRejected: 1 });
    expect(c.requestVsReport.delegations).toBe(1);
    expect(c.requestVsReport.totalRequestChars).toBe('依頼'.length);
  });
});

describe('会話の分析: 見積り（turn_input が無い所だけ）と coverage', () => {
  const day = (d: string, hhmm: string) => `2026-11-${d}T${hhmm}:00.000Z`;
  const timing = (id: string, d: string, hhmm: string) => ({
    type: 'turn_timing',
    id,
    at: day(d, hhmm),
    triggers: ['manager_message'],
    batchSize: 1,
    kinds: ['normal'],
    succeeded: true,
    totalMs: 1,
    phases: {},
  });
  const delivery = (id: string, d: string, hhmm: string, body: string) => ({
    ...ex(id, 0, 'inbound', `[応答] [m1/report] ${body}`, { managerId: 'm1' }),
    at: day(d, hhmm),
  });
  const measuredTurn = (id: string, d: string, hhmm: string) => ({
    ...turnInput(id, '00:00', {
      kind: 'normal',
      triggers: ['manager_message'],
      totalChars: 100,
      bodyChars: 100,
      humanActionsChars: 0,
      freshMemoryChars: 0,
      notices: {},
      signals: [{ kind: 'manager_report', managerId: 'm1', chars: 10 }],
      framingChars: 90,
    }),
    at: day(d, hhmm),
  });
  const fixed = SITUATION_HEAD.length + READINGS_NOTICE.length;
  const guideMin = G + Math.min(ORIGIN_NO_TASK_GUIDE.length, ORIGIN_TASK_GUIDE.length);
  const guideMax = G + Math.max(ORIGIN_NO_TASK_GUIDE.length, ORIGIN_TASK_GUIDE.length);

  const a = run({
    journal: [
      // 10 日: 実測だけ（通常ターン 1 = turn_input 1）
      timing('a', '10', '01:00'),
      measuredTurn('ta', '10', '01:00'),
      // 11 日: 通常ターン 3 のうち turn_input は 1 → 2 を見積りに回す。配達 3 のうち合図で数えた 1 を引き、2 を見積りに回す
      timing('b1', '11', '01:00'),
      timing('b2', '11', '02:00'),
      timing('b3', '11', '03:00'),
      measuredTurn('tb', '11', '01:00'),
      // 12 日: turn_input が無い → 全部見積り
      timing('c1', '12', '01:00'),
      timing('c2', '12', '02:00'),
    ],
    exchanges: [
      delivery('x1', '11', '01:00', 'あああ'),
      delivery('x2', '11', '02:00', 'いいい'),
      delivery('x3', '11', '03:00', 'ううう'),
      delivery('y1', '12', '01:00', 'えええ'),
      delivery('y2', '12', '02:00', 'おおお'),
    ],
  });
  const days = Object.fromEntries(a.estimate.days.map((d) => [d.day, d]));

  it('実測できる日は見積りに回さない。混ざる日は実測できなかった分だけを見積もる（二重に数えない）', () => {
    expect(days['2026-11-10']).toMatchObject({
      basis: 'measured',
      estimatedNormalTurns: 0,
      remainderReportDeliveries: 0,
    });
    expect(days['2026-11-11']).toMatchObject({
      basis: 'mixed',
      timingNormalTurns: 3,
      measuredNormalTurns: 1,
      estimatedNormalTurns: 2,
      remainderReportDeliveries: 2,
      situationFixedChars: 2 * fixed,
      reportGuideChars: { min: 2 * guideMin, max: 2 * guideMax },
      // 混ざる日は本文の合計との対応が付かないので、割合は出さない（取れない）
      deliveryBodyChars: null,
      framingShare: null,
    });
    expect(days['2026-11-12']).toMatchObject({
      basis: 'estimated',
      estimatedNormalTurns: 2,
      remainderReportDeliveries: 2,
      situationFixedChars: 2 * fixed,
      deliveryBodyChars: 6,
    });
    expect(a.estimate.totals.estimatedNormalTurns).toBe(4);
    expect(a.estimate.totals.situationFixedChars).toBe(4 * fixed);
  });

  it('見積りだけの日の定型の占有率は、固定部＋案内 ÷（固定部＋案内＋本文）の幅で出す', () => {
    const d = days['2026-11-12'];
    const lo = (2 * fixed + 2 * guideMin) / (2 * fixed + 2 * guideMin + 6);
    const hi = (2 * fixed + 2 * guideMax) / (2 * fixed + 2 * guideMax + 6);
    expect(d?.framingShare?.min).toBeCloseTo(lo, 10);
    expect(d?.framingShare?.max).toBeCloseTo(hi, 10);
  });

  it('見積りの節に「見積り（実測ではない）」と書き、使った定数の長さと、見積りに入れていないものを出す', () => {
    const text = renderConversationAnalysis(a, 10);
    expect(text).toContain('## D. 見積り（実測ではない）');
    expect(text).toContain(`READINGS_NOTICE（区分の読み方）${READINGS_NOTICE.length}字`);
    expect(text).toContain('見積りに入れていない（取れない）もの');
    expect(text).toContain('実測のみ');
    expect(text).toContain('実測＋見積りが混ざる');
    expect(text).toContain('見積りのみ');
    const cov = renderConversationCoverage(a);
    expect(cov).toContain('[見積り（実測ではない）]');
    expect(cov).toContain('[取れない] クローンに実際に渡した最終の文面そのもの');
  });

  it('turn_timing も exchanges も無いときは見積りを出さず、取れない理由を書く', () => {
    const none = run({ journal: [T1] });
    expect(none.estimate.state).toBe('unavailable');
    expect(renderConversationAnalysis(none, 10)).toContain(
      '取れない: turn_timing も exchanges も無く',
    );
  });

  it('manifest の窓・truncated・failures・人間との会話の行数を coverage の先頭近くに出す（pull が切れていたら分かる）', () => {
    const withManifest = run({
      journal: [T1],
      exchanges: [ex('m', 0, 'inbound', '[応答] [m1] x')],
      manifest: {
        state: 'read',
        value: {
          version: 1,
          pulledAt: '2026-11-14T00:00:00.000Z',
          window: { since: '2026-11-13T00:00:00.000Z', until: '2026-11-14T00:00:00.000Z' },
          requested: { memory: true, exchanges: true },
          skippedNonManager: 7,
          truncated: [{ part: 'journal', reason: 'rows', limit: 200000, rows: 200000, bytes: 1 }],
          failures: [{ part: 'prompt', status: 500, reason: `失敗 ${DUMMY_KEY}` }],
        },
      },
    });
    const text = renderConversationCoverage(withManifest);
    expect(text).toContain('窓 2026-11-13T00:00:00.000Z 〜 2026-11-14T00:00:00.000Z');
    expect(text).toContain('上限で止めた 1 件 / 失敗 1 件');
    expect(text).toContain('pull が上限で止まった（journal: rows 上限 200000）');
    expect(text).toContain('pull の取得に失敗した（prompt status=500');
    expect(text).toContain('人間との会話の行（保存せず）7');
    expect(text).toContain('7 行は pull が保存しない');
    // 失敗の理由は自由文なので伏せ字を掛ける
    expect(text).not.toContain(DUMMY_KEY);
    // manifest が無いときは取れないと書く
    expect(renderConversationCoverage(run({ journal: [T1] }))).toContain(
      '窓・truncated・failures は取れない',
    );
  });
});

describe('会話の分析: 分類の鍵と書き手の突き合わせ', () => {
  it('MANAGER_SIGNAL_KINDS は、turn_input を書く側（buildTurnInputEntry）が合図に付ける kind と一致する', () => {
    const event = (kind: 'report' | 'question' | 'permission', text: string): InboxEvent =>
      ({ type: 'manager_message', id: 'i', at: at(0), managerId: 'm', kind, text }) as InboxEvent;
    const observe = (events: InboxEvent[]) =>
      buildTurnInputEntry({
        kind: 'normal',
        conversationId: null,
        batch: events,
        composed: {
          distillGap: '',
          contextWindowFold: '',
          droppedSignals: '',
          redelivery: '',
          validity: '',
          mergedBatchTruncation: '',
          commitment: '',
          situation: '',
          body: 'b',
        },
        lengths: { composed: 1, withHumanActions: 1, final: 1 },
        situationParts: undefined,
      }).signals.map((s) => s.kind);
    const kinds = observe([
      event('report', 'r'),
      event('question', 'q'),
      event('permission', 'p'),
      event('report', `x${DENIAL_REPLY_ROUTE}`),
    ]);
    expect(new Set(kinds)).toEqual(new Set(MANAGER_SIGNAL_KINDS));
  });

  it('EXCHANGE_STOP_MARK は、停止の行を書く manager.ts の字面と一致する', () => {
    const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');
    expect(source).toContain(`] ${EXCHANGE_STOP_MARK}[outcome=`);
  });

  it('注記の目印は書き手（reportDeliveryTextOf）が実際に付ける字面と一致する', async () => {
    const { reportDeliveryTextOf } = await import('./manager-notices.js');
    const text = reportDeliveryTextOf({ managerId: 'm1', text: '最後', fullText: '途中\n最後' });
    const c = classifyExchangeText(`[応答] [m1/report] ${text}`, 'inbound');
    expect(c.kind).toBe('report');
    expect(text).toContain(REPORT_FULL_TEXT_NOTE_MARK);
  });

  it('担当の note の行（`[記録] [id] …`）は Pool の全文行に数えず、その他（record の接頭辞）へ分ける', () => {
    const c = classifyExchangeText(
      `${EXCHANGE_KIND_RECORD_PREFIX}[m1] tool_use_failure: 道具=commandExecution`,
      'inbound',
    );
    expect(c).toEqual({
      kind: 'other',
      tagId: 'm1',
      body: 'tool_use_failure: 道具=commandExecution',
      otherKey: 'record の接頭辞',
    });
  });

  it('conversationDistOf: 1件も無ければ合計も null（0 にしない）。p90 は最近順位法', () => {
    expect(conversationDistOf([])).toEqual({
      count: 0,
      sum: null,
      median: null,
      p90: null,
      max: null,
    });
    expect(conversationDistOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p90).toBe(9);
  });
});
