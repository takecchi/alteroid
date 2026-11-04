import { describe, expect, it } from 'vitest';

import { probeToolUseStall, probeTurnEnd, TURN_END_PROBE_CHARS } from './turn-end-probe.js';

// `probeTurnEnd` と `probeToolUseStall` は、生ログの末尾の窓（`TURN_END_PROBE_CHARS`）を切り、後ろから「本流の最後の assistant 行」を探す所が同じ形で書かれている。
// 2つの探りは同じ行を見て重ならない範囲を担当する（同時には立たない）。その行の探し方（窓の切り方・切った先頭行を捨てる・空行と JSON でない行を飛ばす・
// assistant 以外と sidechain を飛ばす・最初に当たった行で決める）を、同じ生ログを両方に通した結果で固定する。

const line = (value: unknown): string => JSON.stringify(value);

const assistant = (
  stopReason: string | undefined,
  content: unknown,
  extra: Record<string, unknown> = {},
): string =>
  line({
    type: 'assistant',
    timestamp: '2026-11-05T00:00:00.000Z',
    message: { content, ...(stopReason === undefined ? {} : { stop_reason: stopReason }) },
    ...extra,
  });

const toolResult = (id: string): string =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

const toolUses = (...ids: string[]): unknown[] =>
  ids.map((id) => ({ type: 'tool_use', id, name: `T-${id}` }));

const CASES: readonly [string, string][] = [
  ['空の生ログ', ''],
  ['assistant が無い', [line({ type: 'user', message: { content: 'やあ' } })].join('\n')],
  [
    '最後が end_turn の本文',
    [assistant('end_turn', [{ type: 'text', text: ' 終わり ' }])].join('\n'),
  ],
  [
    '後ろの user 行と空行と JSON でない行を飛ばして、本流の最後の assistant 行で決める',
    [
      assistant('tool_use', toolUses('a')),
      assistant('end_turn', '本文'),
      '',
      '{壊れた行',
      line({ type: 'user', message: { content: 'ok' } }),
      '   ',
    ].join('\n'),
  ],
  [
    'sidechain の assistant 行は飛ばす',
    [
      assistant('end_turn', '本流'),
      assistant('tool_use', toolUses('s'), { isSidechain: true }),
    ].join('\n'),
  ],
  [
    'stop_reason が無い（文字列でない）行で決まる',
    [assistant('end_turn', '前'), assistant(undefined, '後')].join('\n'),
  ],
  [
    '最後が tool_use で、後ろの tool_result が一部に答えている',
    [assistant('tool_use', toolUses('x', 'y', 'z')), toolResult('y'), '{壊れた行'].join('\n'),
  ],
  [
    '最後が tool_use で、すべてに答えている',
    [assistant('tool_use', toolUses('x')), toolResult('x')].join('\n'),
  ],
  [
    '最後が tool_use で、id の無い tool_use だけ',
    [assistant('tool_use', [{ type: 'tool_use', name: 'NoId' }])].join('\n'),
  ],
  [
    // 窓の先頭で切れた行（本流の assistant 行）は捨てる: 切れていない次の行（user 行）より前を見ないので、決まらない
    '窓より長い生ログで、窓の先頭で切れた行は捨てる',
    [
      assistant('end_turn', 'x'.repeat(TURN_END_PROBE_CHARS)),
      line({ type: 'user', message: { content: 'ok' } }),
    ].join('\n'),
  ],
  [
    // 窓の先頭で切れた行の残りが、たまたま読める JSON（本流の assistant 行）になっていても捨てる
    '窓の先頭で切れた行は、残りが読める JSON でも捨てる',
    (() => {
      const tail = `\n${line({ type: 'user', message: { content: 'ok' } })}`;
      const base = assistant('tool_use', toolUses('cut'), { pad: '' }).length;
      const kept = assistant('tool_use', toolUses('cut'), {
        pad: 'p'.repeat(TURN_END_PROBE_CHARS - base - tail.length),
      });
      const transcript = `CUT-HEAD${kept}${tail}`;
      if (transcript.slice(-TURN_END_PROBE_CHARS) !== `${kept}${tail}`) {
        throw new Error('窓の先頭が、読める JSON の行の頭に来ていない');
      }
      return transcript;
    })(),
  ],
  [
    '本流の tool_use の後ろに sidechain の行があっても、本流の行で決める',
    [assistant('tool_use', toolUses('q')), assistant('end_turn', '脇', { isSidechain: true })].join(
      '\n',
    ),
  ],
  [
    // 窓にちょうど収まる長さなら、先頭の行も捨てない
    '窓にちょうど収まる生ログでは、先頭の行も見る',
    (() => {
      const tail = `\n${line({ type: 'user', message: { content: 'ok' } })}`;
      const base = assistant('end_turn', '').length;
      const transcript =
        assistant('end_turn', 'p'.repeat(TURN_END_PROBE_CHARS - base - tail.length)) + tail;
      // 長さがちょうど窓と同じであることを、試験の前提として確かめる
      if (transcript.length !== TURN_END_PROBE_CHARS)
        throw new Error('組み立てた生ログの長さが窓と違う');
      return transcript;
    })(),
  ],
];

describe('turn-end-probe: 本流の最後の assistant 行の探し方を、2つの探りの結果で固定する', () => {
  it.each(CASES)('%s', (_name, transcript) => {
    expect({
      turnEnd: probeTurnEnd(transcript),
      toolUseStall: probeToolUseStall(transcript),
    }).toMatchSnapshot();
  });
});
