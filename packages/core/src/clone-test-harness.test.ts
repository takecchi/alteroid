import { describe, expect, it } from 'vitest';

import { fakeSdk } from './clone-test-harness.js';

/** 偽の SDK に入力を流し、全メッセージを読み切る。 */
async function drive(contents: unknown[]) {
  const { fn, calls } = fakeSdk();
  const prompt = (async function* () {
    for (const content of contents) yield { message: { content } };
  })();
  for await (const message of fn({ prompt } as never)) void message;
  return calls;
}

describe('fakeSdk の入力の記録', () => {
  it('文字列の content は inputs へそのまま、inputBlocks へ生のまま残る', async () => {
    const [call] = await drive(['こんにちは']);
    expect(call?.inputs).toEqual(['こんにちは']);
    expect(call?.inputBlocks).toEqual(['こんにちは']);
  });

  it('配列の content は、inputs に text 部分だけ、inputBlocks に生の配列が残る', async () => {
    const blocks = [
      { type: 'text', text: '見て' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ];
    const [call] = await drive([blocks]);
    expect(call?.inputs).toEqual(['見て']);
    expect(call?.inputBlocks).toEqual([blocks]);
  });
});
