import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  redactImagesInEntries,
  redactImagesInSessionEntry,
  redactImagesInTranscript,
} from './transcript-image-redaction.js';

// 画像の中身として base64 に現れる固有の文字列（出力のどこにも残らないことを見る）
const BYTES = Buffer.from('PNG-BYTES-FOR-4127-REDACTION-TEST-'.repeat(4));
const B64 = BYTES.toString('base64');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function imageBlock(data = B64) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
}

function userEntry(content: unknown[]) {
  return { type: 'user', message: { role: 'user', content }, uuid: 'u1' };
}

describe('redactImagesInSessionEntry（#4127）', () => {
  it('user 行の最上位の base64 画像を text の控えへ置き換え、型・大きさ・sha256 を載せる', () => {
    const entry = userEntry([
      { type: 'text', text: '[添付] id=a name=x.png type=image/png size=1 sha256=zz' },
      imageBlock(),
    ]);
    const out = redactImagesInSessionEntry(entry) as typeof entry;
    const block = out.message.content[1] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(block.text).toContain('type=image/png');
    expect(block.text).toContain(`size=${BYTES.length}`);
    expect(block.text).toContain(`sha256=${SHA}`);
    expect(block.text).toContain('#4127');
    expect(JSON.stringify(out)).not.toContain(B64);
    expect(out.message.content[0]).toBe(entry.message.content[0]);
  });

  it('入力を変更しない', () => {
    const entry = userEntry([imageBlock()]);
    const before = JSON.stringify(entry);
    redactImagesInSessionEntry(entry);
    expect(JSON.stringify(entry)).toBe(before);
  });

  it('同じ入力は同じ出力で、2回当てても同じ', () => {
    const entry = userEntry([imageBlock()]);
    const once = redactImagesInSessionEntry(entry);
    expect(redactImagesInSessionEntry(entry)).toEqual(once);
    const twice = redactImagesInSessionEntry(once);
    expect(twice).toBe(once);
  });

  it('画像の無い user 行・text だけの行は同じ参照を返す', () => {
    const plain = userEntry([{ type: 'text', text: 'こんにちは' }]);
    expect(redactImagesInSessionEntry(plain)).toBe(plain);
    const stringContent = { type: 'user', message: { role: 'user', content: 'hi' } };
    expect(redactImagesInSessionEntry(stringContent)).toBe(stringContent);
  });

  it('tool_result の中の画像は触らない', () => {
    const entry = userEntry([{ type: 'tool_result', tool_use_id: 't1', content: [imageBlock()] }]);
    expect(redactImagesInSessionEntry(entry)).toBe(entry);
    expect(JSON.stringify(entry)).toContain(B64);
  });

  it('assistant 行は触らない', () => {
    const entry = {
      type: 'assistant',
      message: { role: 'assistant', content: [imageBlock()] },
    };
    expect(redactImagesInSessionEntry(entry)).toBe(entry);
  });

  it('base64 でない画像 source（url など）と object でない値は触らない', () => {
    const url = userEntry([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }]);
    expect(redactImagesInSessionEntry(url)).toBe(url);
    expect(redactImagesInSessionEntry(null)).toBeNull();
    expect(redactImagesInSessionEntry('x')).toBe('x');
  });

  it('redactImagesInEntries は配列の各要素へ当てる', () => {
    const plain = userEntry([{ type: 'text', text: 'a' }]);
    const [a, b] = redactImagesInEntries([plain, userEntry([imageBlock()])]);
    expect(a).toBe(plain);
    expect(JSON.stringify(b)).not.toContain(B64);
  });
});

describe('redactImagesInTranscript（#4127）', () => {
  const plainLine = JSON.stringify({ type: 'assistant', message: { content: [{ text: 'ok' }] } });
  // 空白・キー順が JSON.stringify と違う行: パースし直すとバイトが動く
  const oddLine = '{ "b": 1,  "a": "そのまま" }';
  const imageLine = JSON.stringify(userEntry([imageBlock()]));

  it('画像の行だけ置き換わり、base64 はどこにも残らない', () => {
    const out = redactImagesInTranscript([plainLine, imageLine].join('\n'));
    expect(out).not.toContain(B64);
    expect(out).toContain(`sha256=${SHA}`);
    expect(out.split('\n')[0]).toBe(plainLine);
  });

  it('画像の無い本文はバイト一致（改行・末尾の改行も保つ）', () => {
    const body = `${plainLine}\n${oddLine}\n\n${plainLine}\n`;
    expect(redactImagesInTranscript(body)).toBe(body);
  });

  it('触らない行のバイトを動かさない（画像行の前後・空行・末尾改行）', () => {
    const body = `${oddLine}\n${imageLine}\n\n${plainLine}\n`;
    const lines = redactImagesInTranscript(body).split('\n');
    expect(lines[0]).toBe(oddLine);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(plainLine);
    expect(lines[4]).toBe('');
  });

  it('パースできない行はバイト一致', () => {
    const broken = `{"type":"image", "source": {"type":"base64"`;
    const body = `${broken}\n${imageLine}`;
    const out = redactImagesInTranscript(body);
    expect(out.split('\n')[0]).toBe(broken);
  });

  it('画像を含むが置き換え対象でない行（tool_result 内）はバイト一致', () => {
    const line = JSON.stringify(userEntry([{ type: 'tool_result', content: [imageBlock()] }]));
    expect(redactImagesInTranscript(line)).toBe(line);
  });

  it('2回当てても同じ', () => {
    const once = redactImagesInTranscript(`${plainLine}\n${imageLine}\n`);
    expect(redactImagesInTranscript(once)).toBe(once);
  });

  it('空白入りの "type": "image" の行も置き換える', () => {
    const pretty = JSON.stringify(userEntry([imageBlock()]), null, 1).replace(/\n\s*/g, ' ');
    expect(pretty).toContain('"type": "image"');
    expect(redactImagesInTranscript(pretty)).not.toContain(B64);
  });
});
