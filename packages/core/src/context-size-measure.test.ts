import { writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  BASELINE,
  addSizes,
  buildReport,
  measureAllKinds,
  renderDaily,
  renderSensitivity,
  renderSessionTable,
  renderTurnTable,
  sizeOf,
  stateOf,
  type FixtureConfig,
} from './context-size-measure.js';

// 包みは本物を呼んだ結果を控えるだけで、返す値は変えない。控えの置き場は何も import しない別 module に置く（`vi.mock` の factory が `clone.ts` を引く module を経由すると、factory 同士が待ち合って止まる）
vi.mock('./turn-input.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./turn-input.js')>();
  const { contextSizeRecorder: recorder } = await import('./context-size-recorder.js');
  return {
    ...original,
    composeTurnInputText: (input: Parameters<typeof original.composeTurnInputText>[0]) => {
      const composed = original.composeTurnInputText(input);
      recorder.composed.push({
        parts: { ...input },
        composed,
        digestsBefore: recorder.digests.length,
      });
      return composed;
    },
  };
});

vi.mock('./digest.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./digest.js')>();
  const { contextSizeRecorder: recorder } = await import('./context-size-recorder.js');
  return {
    ...original,
    buildActivityDigest: async (...args: Parameters<typeof original.buildActivityDigest>) => {
      const text = await original.buildActivityDigest(...args);
      const shape = (args[4] as { shape?: string } | undefined)?.shape ?? 'full';
      recorder.digests.push({ shape, text });
      return text;
    },
  };
});

const SMALL: FixtureConfig = {
  memory: 'small',
  commitments: 20,
  jobs: 6,
  journalRows: 20,
  humanChars: 80,
  reportChars: 1_500,
};

describe('文脈量の測り（#5469 P0）', () => {
  it('SDK へ渡った入力は、欄ごとの長さと後付けの合計に一致する（欄の取りこぼしが無い）', async () => {
    const runs = await measureAllKinds(SMALL);

    expect(runs.map((run) => run.kind)).toEqual(['human', 'report', 'timer', 'initiative']);
    for (const run of runs) {
      expect(run.result.turns).toHaveLength(3);
      for (const turn of run.result.turns) {
        const parts = addSizes(...Object.values(turn.parts));
        expect(parts.chars + turn.extra.chars).toBe(turn.total.chars);
        expect(turn.total.bytes).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('システムプロンプトは「テンプレート + 記憶の索引 + 自己認識」に分けられ、道具の定義が取れる', async () => {
    const [human] = await measureAllKinds(SMALL, ['human']);
    const { session, tools } = human!.result;

    expect(session.template.chars + session.memory.chars + session.self.chars).toBe(
      session.systemPrompt.chars,
    );
    expect(session.template.chars).toBeGreaterThan(5_000);
    expect(session.memory.chars).toBeGreaterThan(0);
    expect(tools.count).toBeGreaterThan(30);
    // 名前だけの一覧は定義全体より小さい（ToolSearch が deferred にする意味がある）
    expect(tools.namesOnly.chars).toBeLessThan(tools.definitions.chars / 10);
    expect(renderSessionTable(session, tools)).toContain('道具の定義');
  }, 60_000);

  it('同じ条件を 2 回測ると同じ長さになる（決定的な組み立てを測っている）', async () => {
    const first = await measureAllKinds(SMALL, ['human', 'initiative']);
    const second = await measureAllKinds(SMALL, ['human', 'initiative']);

    for (const [index, run] of first.entries()) {
      expect(second[index]!.result.turns.map((turn) => turn.total.chars)).toEqual(
        run.result.turns.map((turn) => turn.total.chars),
      );
    }
  }, 60_000);

  it('固定文は同じ会話の 2 本目から畳まれ、発意の tick は 1 本目より 2 本目が小さい', async () => {
    const runs = await measureAllKinds(SMALL, ['human', 'initiative']);

    for (const run of runs) {
      const [first, second] = run.result.turns;
      expect(second!.total.chars).toBeLessThan(first!.total.chars);
    }
    const initiative = runs[1]!.result.turns;
    expect(initiative[0]!.digestsBuilt.map((digest) => digest.shape)).toContain('full');
    expect(stateOf(initiative[0]!).chars).toBeGreaterThan(0);
  }, 60_000);

  it('表は種類 × 回の行を持ち、1 日あたりの表は合計の行で閉じる', async () => {
    const runs = await measureAllKinds(SMALL);

    const table = renderTurnTable(runs);
    expect(table.split('\n')).toHaveLength(2 + 4 * 3);
    expect(renderDaily(runs)).toContain('| 合計 |');
    expect(renderSensitivity([{ variant: { label: 'x', config: SMALL }, runs }])).toContain(
      '| x |',
    );
    expect(sizeOf('あa').bytes).toBe(4);
  }, 60_000);

  // 全部の表を作って書き出す（時間がかかるので、書き出し先が指定されたときだけ）: CONTEXT_SIZE_OUT=<絶対パス> pnpm exec vitest run packages/core/src/context-size-measure.test.ts
  it.skipIf(process.env['CONTEXT_SIZE_OUT'] === undefined)(
    '全部の表を CONTEXT_SIZE_OUT へ書き出す',
    async () => {
      const report = await buildReport();
      writeFileSync(process.env['CONTEXT_SIZE_OUT']!, report);
      expect(report).toContain('## データ量への感度');
      expect(BASELINE.commitments).toBe(327);
    },
    300_000,
  );
});
