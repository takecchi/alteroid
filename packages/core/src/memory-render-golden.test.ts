import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderMemoryDocuments } from './memory.js';
import { MEMORY_BAKE_FIXTURES } from './memory-bake.fixtures.test-support.js';

// `renderMemoryDocuments` の出力が1文字も変わっていないことの歯。固定値は、文書ごとに焼いた長さを取れる形へ切り出す前の main（e89f23dd）で、
// 同じ入力から出した出力の sha256 と文字数である。切り出しはこの出力を変えてはいけない（`GET /self/prompt` の `indexChars` は同じ関数が焼いた断片の長さを返す）。
const GOLDEN: Record<keyof typeof MEMORY_BAKE_FIXTURES, { chars: number; sha256: string }> = {
  mixed: {
    chars: 1507,
    sha256: '85582a43e9007c0d114299aa5fa04c0447ac0b02c5bf3db6362a43afe1cbadd3',
  },
  overCardBudget: {
    chars: 62759,
    sha256: '0a1e31b9101a383a098f939ec33a771e43f3f9364c4f9669e9c574655dcbdbac',
  },
  tocCutByCount: {
    chars: 12628,
    sha256: '86b1512d57526e7a7a7baffefafdcfa50bfd67a3d9cf36ee9b45c3188abc175c',
  },
  tocCutByChars: {
    chars: 12297,
    sha256: '8adf83ace5775c1f25429be2fd3bcc6d807dd18e63b5faf7ea6d7f46d2ba443d',
  },
};

describe('renderMemoryDocuments の出力は、焼いた長さを取れる形へ切り出す前と同じ', () => {
  for (const [name, build] of Object.entries(MEMORY_BAKE_FIXTURES)) {
    it(`${name}: 全体の出力が1文字も変わらない`, () => {
      const rendered = renderMemoryDocuments(build());
      const golden = GOLDEN[name as keyof typeof MEMORY_BAKE_FIXTURES];
      expect({
        chars: rendered.length,
        sha256: createHash('sha256').update(rendered).digest('hex'),
      }).toEqual(golden);
    });
  }
});
