import { describe, expect, it } from 'vitest';

import { eachLine, jsonLinesYielding, runSteps } from './loop-yield.js';
import { filterTranscriptLines, filterTranscriptLinesYielding } from './transcript-filter.js';
import {
  redactImagesInTranscript,
  redactImagesInTranscriptYielding,
} from './transcript-image-redaction.js';

// 約束が返る前に、その間に積んだ setImmediate の仕事が回ったか（順番を返さなければ、約束の解決はマイクロタスクだけで済み、仕事は後になる）
async function yieldedBeforeDone(work: () => Promise<unknown>): Promise<boolean> {
  const order: string[] = [];
  const running = work().then(() => order.push('done'));
  setImmediate(() => order.push('immediate'));
  await running;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return order.indexOf('immediate') < order.indexOf('done');
}

const PNG = Buffer.from('fake-png-bytes').toString('base64');

function imageLine(i: number): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: `画像 ${String(i)} 🙂` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    },
  });
}

function textLine(i: number, size = 40): string {
  return JSON.stringify({
    type: i % 2 === 0 ? 'assistant' : 'user',
    timestamp: new Date(Date.UTC(2026, 9, 14, 0, 0, i)).toISOString(),
    message: { content: `本文 ${String(i)} ${'あ'.repeat(size)}` },
  });
}

describe('eachLine は split と同じ行を渡す（#4659）', () => {
  it.each(['', 'a', 'a\n', '\n', '\n\n', 'a\nb', 'a\n\nb\n'])('%j', (body) => {
    const lines: string[] = [];
    runSteps(eachLine(body, 1, (line) => lines.push(line)));
    expect(lines).toEqual(body.split('\n'));
  });
});

describe('生ログの全文の処理は、同期版と同じ結果を、区切りごとにループへ順番を返して作る（#4659）', () => {
  const mixed =
    [textLine(0), imageLine(1), textLine(2), imageLine(3), textLine(4)].join('\n') + '\n';

  it('画像の伏せ字: 同期版と同じ本文。画像が無ければ元の文字列のまま', async () => {
    for (const yieldChars of [1, 50, 1024 * 1024]) {
      expect(await redactImagesInTranscriptYielding(mixed, yieldChars)).toBe(
        redactImagesInTranscript(mixed),
      );
    }
    expect(redactImagesInTranscript(mixed)).not.toContain(PNG);
    const plain = [textLine(0), textLine(1)].join('\n');
    expect(await redactImagesInTranscriptYielding(plain, 1)).toBe(plain);
  });

  it('第1頁の絞り込み: 同期版と同じ本文と件数', async () => {
    const body = Array.from({ length: 30 }, (_, i) =>
      i % 7 === 3 ? 'not json' : textLine(i),
    ).join('\n');
    const filters = [
      { types: ['user'] },
      { since: '2026-10-14T00:00:05Z', until: '2026-10-14T00:00:20Z' },
      { contains: '本文 1' },
    ];
    for (const filter of filters) {
      expect(await filterTranscriptLinesYielding(body, filter, 1)).toEqual(
        filterTranscriptLines(body, filter),
      );
      expect(await filterTranscriptLinesYielding(`${body}\n`, filter, 1)).toEqual(
        filterTranscriptLines(`${body}\n`, filter),
      );
    }
    expect(await filterTranscriptLinesYielding('', { types: ['user'] }, 1)).toEqual(
      filterTranscriptLines('', { types: ['user'] }),
    );
  });

  it('預かりからの組み立て: map と join と同じ本文', async () => {
    const entries: unknown[] = [{ a: 1 }, { b: 'い' }, undefined, [1, 2]];
    expect(await jsonLinesYielding(entries, 1)).toBe(
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
  });

  it('⭐ 4MB 級の本文では、どれも処理し終える前に setImmediate の仕事が回る', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) =>
      i % 500 === 0 ? imageLine(i) : textLine(i, 1000),
    );
    const big = lines.join('\n');
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(await yieldedBeforeDone(() => redactImagesInTranscriptYielding(big))).toBe(true);
    expect(
      await yieldedBeforeDone(() => filterTranscriptLinesYielding(big, { types: ['user'] })),
    ).toBe(true);
    expect(
      await yieldedBeforeDone(() => jsonLinesYielding(lines.map((line) => JSON.parse(line)))),
    ).toBe(true);
  });
});

// 書き換える前の作り（#4659 の前）。同期版と順番を返す版は同じ手順を共有するので、両者を比べるだけでは書き換えの誤りを拾えない
function redactBefore(body: string): string {
  const mark = /"type"\s*:\s*"image"/;
  if (!mark.test(body)) return body;
  return body
    .split('\n')
    .map((line) => (mark.test(line) ? redactImagesInTranscript(line) : line))
    .join('\n');
}

describe('画像の伏せ字は、書き換える前の作りと同じ本文を作る（#4659）', () => {
  it.each([
    ['画像が先頭・途中・末尾', [imageLine(0), textLine(1), imageLine(2)].join('\n')],
    ['末尾に改行', `${[textLine(0), imageLine(1)].join('\n')}\n`],
    ['空行を挟む', [imageLine(0), '', '', textLine(1), imageLine(2), ''].join('\n')],
    ['読めない行に印', ['{"type":"image" 壊れた', imageLine(1)].join('\n')],
  ])('%s', async (_name, body) => {
    expect(redactImagesInTranscript(body)).toBe(redactBefore(body));
    expect(await redactImagesInTranscriptYielding(body, 1)).toBe(redactBefore(body));
  });
});
