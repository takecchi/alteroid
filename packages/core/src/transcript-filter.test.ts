import { describe, expect, it } from 'vitest';

import { filterTranscriptLines } from './transcript-filter.js';

/**
 * `filterTranscriptLines` — `manager_transcript`（`tools.ts`）が呼ぶ純粋な
 * 絞り込み関数（issue #2188）。道具側の応答の形（見出し・続きの案内）は
 * `tools.test.ts` の「manager_transcript（生ログを絞る。#2188）」が測る。
 * ここで測るのは絞りの計算そのもの——窓の両端・時刻の無い行・読めない行・
 * type の複数・contains・組み合わせ・0件。
 */
describe('filterTranscriptLines（生ログの絞り込み。#2188）', () => {
  it('絞りを1つも渡さないと、本文は1文字も変わらず全行が当たる', () => {
    const body = ['{"type":"a"}', '{"type":"b","timestamp":"2026-01-01T00:00:00Z"}'].join('\n');

    const result = filterTranscriptLines(body, {});

    expect(result.body).toBe(body);
    expect(result.counts).toEqual({
      totalLines: 2,
      matchedLines: 2,
      noTimestampLines: 0,
      unparsableLines: 0,
    });
  });

  it('空の本文は0行として扱う', () => {
    const result = filterTranscriptLines('', {});
    expect(result.counts.totalLines).toBe(0);
    expect(result.body).toBe('');
  });

  describe('時刻の窓（since/until）', () => {
    const lineAt = (at: string) => `{"type":"x","timestamp":"${at}"}`;

    it('since は含む（境界そのものの行が残る）', () => {
      const body = [lineAt('2026-01-01T10:00:00.000Z'), lineAt('2026-01-01T09:59:59.999Z')].join(
        '\n',
      );

      const result = filterTranscriptLines(body, { since: '2026-01-01T10:00:00.000Z' });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.body).toBe(lineAt('2026-01-01T10:00:00.000Z'));
    });

    it('until は含まない（境界そのものの行は落ちる）', () => {
      const body = [lineAt('2026-01-01T10:00:00.000Z'), lineAt('2026-01-01T09:59:59.999Z')].join(
        '\n',
      );

      const result = filterTranscriptLines(body, { until: '2026-01-01T10:00:00.000Z' });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.body).toBe(lineAt('2026-01-01T09:59:59.999Z'));
    });

    it('since と until を組み合わせた窓（半開区間）', () => {
      const body = [
        lineAt('2026-01-01T09:00:00.000Z'), // 窓の前
        lineAt('2026-01-01T10:00:00.000Z'), // since 境界（含む）
        lineAt('2026-01-01T10:30:00.000Z'), // 窓の中
        lineAt('2026-01-01T11:00:00.000Z'), // until 境界（含まない）
        lineAt('2026-01-01T12:00:00.000Z'), // 窓の後
      ].join('\n');

      const result = filterTranscriptLines(body, {
        since: '2026-01-01T10:00:00.000Z',
        until: '2026-01-01T11:00:00.000Z',
      });

      expect(result.counts.totalLines).toBe(5);
      expect(result.counts.matchedLines).toBe(2);
      expect(result.body).toBe(
        [lineAt('2026-01-01T10:00:00.000Z'), lineAt('2026-01-01T10:30:00.000Z')].join('\n'),
      );
    });

    it('隣接する2つの窓を続けて読んでも、境界の行が重複も欠落もしない', () => {
      const body = [
        lineAt('2026-01-01T09:59:59.999Z'),
        lineAt('2026-01-01T10:00:00.000Z'),
        lineAt('2026-01-01T11:00:00.000Z'),
        lineAt('2026-01-01T11:00:00.001Z'),
      ].join('\n');

      const first = filterTranscriptLines(body, {
        since: '2026-01-01T10:00:00.000Z',
        until: '2026-01-01T11:00:00.000Z',
      });
      const second = filterTranscriptLines(body, {
        since: '2026-01-01T11:00:00.000Z',
        until: '2026-01-01T12:00:00.000Z',
      });

      expect(first.counts.matchedLines).toBe(1); // 10:00:00.000 だけ
      expect(second.counts.matchedLines).toBe(2); // 11:00:00.000 と 11:00:00.001
    });

    it('timestamp 欄が無い行は「時刻の無い行」として除く（窓に入れない）', () => {
      const body = ['{"type":"x"}', lineAt('2026-01-01T10:00:00.000Z')].join('\n');

      const result = filterTranscriptLines(body, { since: '2026-01-01T00:00:00.000Z' });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.counts.noTimestampLines).toBe(1);
      expect(result.counts.unparsableLines).toBe(0);
    });

    it('timestamp 欄はあるが日時として読めない値も「時刻の無い行」に畳む', () => {
      const body = [
        '{"type":"x","timestamp":"not-a-date"}',
        lineAt('2026-01-01T10:00:00.000Z'),
      ].join('\n');

      const result = filterTranscriptLines(body, { since: '2026-01-01T00:00:00.000Z' });

      expect(result.counts.noTimestampLines).toBe(1);
      expect(result.counts.matchedLines).toBe(1);
    });

    it('JSON として読めない行は「読めない行」として除く（窓の判定ができない）', () => {
      const body = ['not json at all', lineAt('2026-01-01T10:00:00.000Z')].join('\n');

      const result = filterTranscriptLines(body, { since: '2026-01-01T00:00:00.000Z' });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.counts.unparsableLines).toBe(1);
      expect(result.counts.noTimestampLines).toBe(0);
    });

    it('無効な since/until を直接渡すと（呼び出し側の検証漏れとして）例外を投げる', () => {
      expect(() => filterTranscriptLines('{}', { since: 'not-a-date' })).toThrow(RangeError);
      expect(() => filterTranscriptLines('{}', { until: 'not-a-date' })).toThrow(RangeError);
    });
  });

  describe('type（複数はOR）', () => {
    it('カンマ区切り相当の複数 type を渡すと、そのどれかに一致する行だけ残る', () => {
      const body = ['{"type":"assistant"}', '{"type":"result"}', '{"type":"user"}'].join('\n');

      const result = filterTranscriptLines(body, { types: ['assistant', 'result'] });

      expect(result.counts.matchedLines).toBe(2);
      expect(result.body).toBe(['{"type":"assistant"}', '{"type":"result"}'].join('\n'));
    });

    it('type だけを渡したとき、JSON として読めない行は type の判定ができないので除く', () => {
      const body = ['not json', '{"type":"assistant"}'].join('\n');

      const result = filterTranscriptLines(body, { types: ['assistant'] });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.counts.unparsableLines).toBe(1);
      // 窓を渡していないので noTimestampLines は無関係のまま0。
      expect(result.counts.noTimestampLines).toBe(0);
    });

    it('type だけを渡したときは、timestamp が無い行でも type が合えば残る（窓の判定は関係ない）', () => {
      const body = '{"type":"assistant"}';

      const result = filterTranscriptLines(body, { types: ['assistant'] });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.counts.noTimestampLines).toBe(0);
    });

    it('空配列・空文字列だけの types は「絞らない」と同じ扱い', () => {
      const body = ['{"type":"assistant"}', '{"type":"result"}'].join('\n');

      const result = filterTranscriptLines(body, { types: [] });
      expect(result.counts.matchedLines).toBe(2);

      const resultBlank = filterTranscriptLines(body, { types: ['', '  '] });
      expect(resultBlank.counts.matchedLines).toBe(2);
    });
  });

  describe('contains（部分文字列）', () => {
    it('生の行の文字列に対して見る——一致した行だけ残る', () => {
      const body = ['{"type":"assistant","stop_reason":"tool_use"}', '{"type":"user"}'].join('\n');

      const result = filterTranscriptLines(body, { contains: '"stop_reason":"tool_use"' });

      expect(result.counts.matchedLines).toBe(1);
      expect(result.body).toBe('{"type":"assistant","stop_reason":"tool_use"}');
    });

    it('JSON として読めない行にも contains は掛かる（parse せずに判定できる）', () => {
      const body = ['not valid json but has MARKER inside', '{"type":"x"}'].join('\n');

      const result = filterTranscriptLines(body, { contains: 'MARKER' });

      expect(result.counts.matchedLines).toBe(1);
      // contains だけのときは JSON を1行も parse しないので、読めない行が
      // あっても unparsableLines は増えない。
      expect(result.counts.unparsableLines).toBe(0);
      expect(result.body).toBe('not valid json but has MARKER inside');
    });

    it('空文字列の contains は「絞らない」と同じ（全行が当たる）', () => {
      const body = ['{"type":"a"}', '{"type":"b"}'].join('\n');
      const result = filterTranscriptLines(body, { contains: '' });
      expect(result.counts.matchedLines).toBe(2);
    });
  });

  describe('組み合わせ', () => {
    it('窓 + type + contains を同時に満たす行だけ残る', () => {
      const body = [
        '{"type":"assistant","timestamp":"2026-01-01T10:00:00.000Z","stop_reason":"tool_use"}',
        '{"type":"assistant","timestamp":"2026-01-01T10:00:00.000Z","stop_reason":"end_turn"}',
        '{"type":"user","timestamp":"2026-01-01T10:00:00.000Z","stop_reason":"tool_use"}',
        '{"type":"assistant","timestamp":"2026-01-01T08:00:00.000Z","stop_reason":"tool_use"}',
      ].join('\n');

      const result = filterTranscriptLines(body, {
        since: '2026-01-01T09:00:00.000Z',
        types: ['assistant'],
        contains: 'tool_use',
      });

      expect(result.counts.totalLines).toBe(4);
      expect(result.counts.matchedLines).toBe(1);
      expect(result.body).toBe(
        '{"type":"assistant","timestamp":"2026-01-01T10:00:00.000Z","stop_reason":"tool_use"}',
      );
    });

    it('組み合わせても1件も当たらないとき、0件のまま数え上げは正しく出す', () => {
      const body = ['{"type":"user","timestamp":"2026-01-01T10:00:00.000Z"}'].join('\n');

      const result = filterTranscriptLines(body, {
        types: ['assistant'],
        since: '2026-01-01T00:00:00.000Z',
      });

      expect(result.counts.totalLines).toBe(1);
      expect(result.counts.matchedLines).toBe(0);
      expect(result.body).toBe('');
    });
  });

  it('末尾の改行1つぶんは行として数えない', () => {
    const result = filterTranscriptLines('{"type":"a"}\n{"type":"b"}\n', { types: ['a', 'b'] });
    expect(result.counts.totalLines).toBe(2);
  });
});
