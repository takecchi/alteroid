import { describe, expect, it } from 'vitest';
import {
  carriesFilesOf,
  foldedReportDecisionOf,
  foldedTurnOf,
  hasReportFileRefs,
  outwardReportDecisionOf,
  overtakenReportDecisionOf,
  quotaMarkArgsOf,
  reportEmitTextOf,
} from './manager-deliver-report.js';
import type { ManagerReportFiles } from './manager-outbox-fetch.js';
import { FAILED_REPORT_PARTIAL_MARKER } from './sdk-failure.js';
import { WITHHELD_REPORT_EXCERPT } from './withheld-reports.js';

/*
 * 切り出した純関数（`Pool#deliverReport` の同期の部分）を、入力 → 出力で縛る。
 * 期待値は切り出した後の出力を実際に確かめて書いたもの（仕様を先に書いたものではない）。
 * 呼び元（`Pool`）の側の縛り（呼び順・`await` の位置・時計の読み・周回数）は manager-deliver-report-pin.test.ts が持つ。
 */

const attachment = { id: 'a1' } as unknown as ManagerReportFiles['attachments'][number];

describe('hasReportFileRefs', () => {
  it('files・rejectedFiles のどちらかが 1 件以上なら真。欄が無い・空配列は偽', () => {
    expect(hasReportFileRefs({})).toBe(false);
    expect(hasReportFileRefs({ files: [], rejectedFiles: [] })).toBe(false);
    expect(hasReportFileRefs({ files: [1] })).toBe(true);
    expect(hasReportFileRefs({ rejectedFiles: [1] })).toBe(true);
    expect(hasReportFileRefs({ files: [], rejectedFiles: [1] })).toBe(true);
    expect(hasReportFileRefs({ files: [1], rejectedFiles: [] })).toBe(true);
  });
});

describe('carriesFilesOf', () => {
  it('取りに行かなかった（undefined）・両方空は偽。添付か断りが 1 件でも在れば真', () => {
    expect(carriesFilesOf(undefined)).toBe(false);
    expect(carriesFilesOf({ attachments: [], rejected: [] })).toBe(false);
    expect(carriesFilesOf({ attachments: [attachment], rejected: [] })).toBe(true);
    expect(carriesFilesOf({ attachments: [], rejected: [{ name: 'x', reason: 'r' }] })).toBe(true);
  });
});

describe('日誌の decision（3 本）', () => {
  it('outwardReportDecisionOf: 全文とキーの順（type, decision, grounds）。routine は無い', () => {
    const entry = outwardReportDecisionOf('m1', ['gh pr merge', 'git push'], { count: 2 });
    expect(entry).toEqual({
      type: 'decision',
      decision: '[m1] 背景処理の完了待ちのターンだが、外へ出した成果を含むので受信箱へ回す',
      grounds: 'managerId=m1 outwardActions=gh pr merge, git push awaitingBackground.count=2',
    });
    expect(Object.keys(entry)).toEqual(['type', 'decision', 'grounds']);
    expect('routine' in entry).toBe(false);
  });

  it('foldedReportDecisionOf: routine: true と本文冒頭（空白は 1 個に畳む）。キーの順', () => {
    const entry = foldedReportDecisionOf('m1', 'あ\n\n  い', { count: 3, breakdown: 'bg=3' });
    expect(entry).toEqual({
      type: 'decision',
      decision: '[m1] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない',
      grounds: 'managerId=m1 awaitingBackground.count=3 breakdown=bg=3 本文冒頭: あ い',
      routine: true,
    });
    expect(Object.keys(entry)).toEqual(['type', 'decision', 'grounds', 'routine']);
  });

  it('foldedReportDecisionOf: 本文冒頭は WITHHELD_REPORT_EXCERPT 字で切る', () => {
    const exact = 'x'.repeat(WITHHELD_REPORT_EXCERPT);
    const over = 'x'.repeat(WITHHELD_REPORT_EXCERPT + 1);
    const awaiting = { count: 1, breakdown: 'b' };
    expect(foldedReportDecisionOf('m1', exact, awaiting).grounds).toMatch(
      new RegExp(`本文冒頭: x{${String(WITHHELD_REPORT_EXCERPT)}}$`),
    );
    const cut = foldedReportDecisionOf('m1', over, awaiting).grounds;
    expect(cut).toContain('…（1 文字省略。全 241 文字）');
  });

  it('overtakenReportDecisionOf: 全文。breakdown は載せない。routine: true。キーの順', () => {
    const entry = overtakenReportDecisionOf('m1', '本文', { count: 4 });
    expect(entry).toEqual({
      type: 'decision',
      decision: '[m1] 同じ担当の closed に追い越されたので、畳まずに受信箱へ配った',
      grounds: 'managerId=m1 awaitingBackground.count=4 本文冒頭: 本文',
      routine: true,
    });
    expect(Object.keys(entry)).toEqual(['type', 'decision', 'grounds', 'routine']);
  });

  it('overtakenReportDecisionOf: 本文冒頭は WITHHELD_REPORT_EXCERPT 字で切る', () => {
    const exact = 'x'.repeat(WITHHELD_REPORT_EXCERPT);
    const over = 'x'.repeat(WITHHELD_REPORT_EXCERPT + 1);
    expect(overtakenReportDecisionOf('m1', exact, { count: 1 }).grounds).toMatch(
      new RegExp(`本文冒頭: x{${String(WITHHELD_REPORT_EXCERPT)}}$`),
    );
    expect(overtakenReportDecisionOf('m1', over, { count: 1 }).grounds).toContain(
      '…（1 文字省略。全 241 文字）',
    );
  });

  it('同期の関数が throw したら、そのまま呼び元へ伝わる（握り潰さない）', () => {
    expect(() =>
      outwardReportDecisionOf('m1', undefined as unknown as string[], { count: 1 }),
    ).toThrow(TypeError);
  });
});

describe('foldedTurnOf', () => {
  it('failure も unreported も無ければ偽。どちらか・両方在れば真。値が falsy でも「在る」', () => {
    expect(foldedTurnOf({})).toBe(false);
    expect(foldedTurnOf({ failure: undefined, unreported: undefined })).toBe(false);
    expect(foldedTurnOf({ failure: { code: 'x' } })).toBe(true);
    expect(foldedTurnOf({ unreported: { reason: 'r' } })).toBe(true);
    expect(foldedTurnOf({ failure: { code: 'x' }, unreported: { reason: 'r' } })).toBe(true);
    expect(foldedTurnOf({ failure: null })).toBe(true);
    expect(foldedTurnOf({ unreported: '' })).toBe(true);
  });
});

describe('quotaMarkArgsOf', () => {
  const head = 'ターンが失敗した';

  it('見出しだけ（改行が無い）なら source も extra も欄ごと無い', () => {
    expect(quotaMarkArgsOf(head)).toEqual({ source: {}, extra: {} });
    const args = quotaMarkArgsOf(head);
    expect(Object.keys(args.source)).toEqual([]);
    expect(Object.keys(args.extra)).toEqual([]);
  });

  it('SDK の本文が在れば text と sdkText に同じ値。said は無ければ欄ごと無い', () => {
    const args = quotaMarkArgsOf(`${head}\nYou hit your limit. resets 12:20am`);
    expect(args).toEqual({
      source: { text: 'You hit your limit. resets 12:20am' },
      extra: { sdkText: 'You hit your limit. resets 12:20am' },
    });
    expect('said' in args.extra).toBe(false);
  });

  it('失敗する前の本文が在れば said が付く。SDK の本文が無くても said だけ付く', () => {
    const both = quotaMarkArgsOf(
      `${head}\nlimit reached\n\n${FAILED_REPORT_PARTIAL_MARKER}\n途中の発言`,
    );
    expect(both).toEqual({
      source: { text: 'limit reached' },
      extra: { sdkText: 'limit reached', said: '途中の発言' },
    });
    const onlySaid = quotaMarkArgsOf(`${head}\n\n${FAILED_REPORT_PARTIAL_MARKER}\n途中の発言`);
    expect(onlySaid).toEqual({ source: {}, extra: { said: '途中の発言' } });
    expect('sdkText' in onlySaid.extra).toBe(false);
    expect(Object.keys(onlySaid.source)).toEqual([]);
  });

  it('extra のキーの順は sdkText, said', () => {
    const args = quotaMarkArgsOf(`${head}\nb\n\n${FAILED_REPORT_PARTIAL_MARKER}\ns`);
    expect(Object.keys(args.extra)).toEqual(['sdkText', 'said']);
  });
});

describe('reportEmitTextOf', () => {
  const base = { managerId: 'm1', text: '最後の発言' };
  const withFull = { ...base, fullText: '途中\n最後の発言' };

  it('節約が有効: 途中の発言が無ければ text のまま。在れば全文の在りかの行を添える', () => {
    expect(reportEmitTextOf(true, base)).toBe('最後の発言');
    expect(reportEmitTextOf(true, withFull)).toBe(
      '最後の発言\n\n' +
        '（途中の発言を含む全文 8 字は manager_report managerId=m1 で読める。' +
        'これはターンの最後の発言だけである）',
    );
  });

  it('節約が無効: fullText が在れば全文、無ければ text', () => {
    expect(reportEmitTextOf(false, withFull)).toBe('途中\n最後の発言');
    expect(reportEmitTextOf(false, base)).toBe('最後の発言');
  });
});
