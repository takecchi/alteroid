import { describe, expect, it } from 'vitest';

import { distillTailOf, formatTranscriptForDistill } from './distill-transcript-tail.js';

const CAP = 60_000;

// 実際の SDK の生ログ（~/.claude/projects/.../*.jsonl）に近い形: 外枠・メタ情報つき
function meta(uuid: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/workspace/clone/repo',
    sessionId: '11111111-2222-3333-4444-555555555555',
    version: '2.1.0',
    gitBranch: 'main',
    uuid,
    timestamp: '2026-10-27T01:02:03.456Z',
  };
}

function userText(uuid: string, text: string): string {
  return JSON.stringify({ ...meta(uuid), type: 'user', message: { role: 'user', content: text } });
}

function assistant(uuid: string, content: unknown[]): string {
  return JSON.stringify({
    ...meta(uuid),
    type: 'assistant',
    requestId: 'req_01ABC',
    message: {
      id: 'msg_01ABC',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content,
      stop_reason: 'tool_use',
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 90000 },
    },
  });
}

function toolResult(uuid: string, toolUseId: string, content: unknown, isError = false): string {
  return JSON.stringify({
    ...meta(uuid),
    type: 'user',
    toolUseResult: { stdout: 'duplicated copy of the result' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  });
}

const HUMAN = '来週の定例は金曜の午後に動かしておいて。理由は、午前は集中したいから。';
const REPLY = '金曜 14:00 に移します。午前は空けたままにします。';

function session(): string {
  return [
    userText('u1', HUMAN),
    assistant('a1', [
      { type: 'text', text: REPLY },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'calendar_move',
        input: { event: 'weekly', to: '2026-10-30T14:00' },
      },
    ]),
    toolResult('r1', 'toolu_1', [{ type: 'text', text: `moved\n${'x'.repeat(5000)}` }]),
    assistant('a2', [{ type: 'text', text: '移しました。' }]),
  ].join('\n');
}

describe('formatTranscriptForDistill', () => {
  it('整形後の字数は生より小さい', () => {
    const raw = session();
    const formatted = formatTranscriptForDistill(raw, { startsMidLine: false });
    expect(formatted.length).toBeLessThan(raw.length);
    expect(formatted).toContain('[tool_use] calendar_move');
    expect(formatted).toContain('以降');
    expect(formatted).not.toContain('parentUuid');
    expect(formatted).not.toContain('cache_read_input_tokens');
  });

  it('人間の発言と assistant のテキストは1文字も落ちない', () => {
    const formatted = formatTranscriptForDistill(session(), { startsMidLine: false });
    expect(formatted).toContain(`user: ${HUMAN}`);
    expect(formatted).toContain(`assistant: ${REPLY}`);
    expect(formatted).toContain('assistant: 移しました。');
  });

  it('長い user / assistant のテキストは切らない（切るのは tool_result・tool_use の入力だけ）', () => {
    const long = '長い発言。'.repeat(2000);
    const formatted = formatTranscriptForDistill(
      [userText('u', long), assistant('a', [{ type: 'text', text: long }])].join('\n'),
      { startsMidLine: false },
    );
    expect(formatted).toBe(`user: ${long}\nassistant: ${long}`);
  });

  it('tool_result は先頭だけを1行にして残し、エラーの印を落とさない', () => {
    const formatted = formatTranscriptForDistill(
      toolResult('r', 't', 'line1\nline2\n' + 'y'.repeat(2000), true),
      { startsMidLine: false },
    );
    expect(formatted.split('\n')).toHaveLength(1);
    expect(formatted).toContain('[tool_result error] line1 line2 yyy');
    expect(formatted.length).toBeLessThan(450);
  });

  it('JSON として読めない行と、形が想定外の行はそのまま残る', () => {
    const broken = '{"type":"user","message":{"role":"user","content":"途中で切れ';
    const plain = 'これは JSONL ではない行';
    const unknownShape = JSON.stringify({ type: 'summary', summary: '要約', leafUuid: 'x' });
    const weirdMessage = JSON.stringify({ type: 'user', message: 42 });
    const raw = [plain, userText('u', HUMAN), broken, unknownShape, weirdMessage].join('\n');
    const lines = formatTranscriptForDistill(raw, { startsMidLine: false }).split('\n');
    expect(lines).toEqual([plain, `user: ${HUMAN}`, broken, unknownShape, weirdMessage]);
  });

  it('想定外の block はそのまま残し、画像の中身は出さない', () => {
    const odd = { type: 'server_tool_use', id: 's', name: 'web_search', input: { q: 'a' } };
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) },
    };
    const formatted = formatTranscriptForDistill(
      assistant('a', [{ type: 'text', text: 'どうぞ' }, odd, image]),
      { startsMidLine: false },
    );
    expect(formatted).toContain(JSON.stringify(odd));
    expect(formatted).toContain('[画像]');
    expect(formatted).not.toContain('AAAAA');
  });

  it('窓の先頭が行の途中で切れているときだけ、先頭の断片を捨てる', () => {
    const fragment = 'ssage":{"role":"user","content":"途中"}}';
    const raw = `${fragment}\n${userText('u', HUMAN)}`;
    expect(formatTranscriptForDistill(raw, { startsMidLine: true })).toBe(`user: ${HUMAN}`);
    expect(formatTranscriptForDistill(raw, { startsMidLine: false })).toBe(
      `${fragment}\nuser: ${HUMAN}`,
    );
  });
});

describe('distillTailOf', () => {
  it('整形が例外で落ちたら、生の末尾へ戻る', () => {
    const raw = session();
    const result = distillTailOf(raw, CAP, () => {
      throw new Error('boom');
    });
    expect(result).toBe(raw);
  });

  it('整形が落ちたときも、生の末尾は従来どおり上限で切り、行の途中から始めない', () => {
    const lines = Array.from({ length: 120 }, (_, i) =>
      userText(`u${String(i)}`, `発言${String(i)} `.repeat(100)),
    );
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(CAP);
    const result = distillTailOf(raw, CAP, () => {
      throw new Error('boom');
    });
    expect(result.length).toBeLessThanOrEqual(CAP);
    expect(lines.some((l) => result.startsWith(l))).toBe(true);
    expect(result.endsWith(lines[119] ?? '')).toBe(true);
  });

  it('整形後も 60,000 字を超えず、新しい側を残して行の途中から始めない', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      userText(`u${String(i)}`, `${String(i).padStart(3, '0')}:${'あ'.repeat(997)}`),
    );
    const result = distillTailOf(lines.join('\n'), CAP);
    expect([...result].length).toBeLessThanOrEqual(CAP);
    expect(result.endsWith(`user: 199:${'あ'.repeat(997)}`)).toBe(true);
    expect(result.startsWith('user: ')).toBe(true);
    expect(result).not.toContain('user: 000:');
  });

  it('同じ字数で、生より長い区間（古い発言）まで届く', () => {
    const bulky = Array.from({ length: 60 }, (_, i) => [
      userText(`h${String(i)}`, `人間の発言 ${String(i)}`),
      toolResult(`r${String(i)}`, `t${String(i)}`, 'z'.repeat(3000)),
    ]).flat();
    const raw = bulky.join('\n');
    const rawTail = raw.slice(-CAP);
    expect(rawTail).not.toContain('人間の発言 0');
    expect(distillTailOf(raw, CAP)).toContain('user: 人間の発言 0');
  });

  it('蓋に届かない短い入力は、読めない先頭行を含めて何も捨てない', () => {
    const raw = ['{"途中', userText('u', HUMAN)].join('\n');
    expect(distillTailOf(raw, CAP)).toBe(`{"途中\nuser: ${HUMAN}`);
  });
});
