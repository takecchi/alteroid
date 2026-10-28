import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { DISTILL_GAP_NOTICE_HEAD } from './distill-gap.js';
import {
  BASELINE,
  addSizes,
  buildReport,
  measureAllKinds,
  measureKind,
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
  // 全種類 × SMALL は重いので1回だけ測って共有する
  let smallRuns: Awaited<ReturnType<typeof measureAllKinds>>;
  beforeAll(async () => {
    smallRuns = await measureAllKinds(SMALL);
  }, 120_000);

  it('本番の入口（tsup の entry）から静的 import を辿っても、測りの module に着かない（vitest を本番へ引かない）', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const config = readFileSync(join(srcDir, '..', 'tsup.config.ts'), 'utf8');
    const entries = [...config.matchAll(/'src\/([^']+)\.ts'/g)].map((match) => match[1]!);
    expect(entries).toContain('index');
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      let source: string;
      try {
        source = readFileSync(join(srcDir, `${name}.ts`), 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'\.\/([^']+)\.js'/g)) {
        queue.push(match[1]!);
      }
    }
    expect(seen.size).toBeGreaterThan(entries.length);
    expect([...seen].filter((name) => name.startsWith('context-size-'))).toEqual([]);
  });

  it('SDK へ渡った入力は、欄ごとの長さと後付けの合計に一致する（欄の取りこぼしが無い）', () => {
    const runs = smallRuns;

    expect(runs.map((run) => run.kind)).toEqual(['human', 'report', 'timer', 'initiative']);
    for (const run of runs) {
      expect(run.result.turns).toHaveLength(3);
      for (const turn of run.result.turns) {
        const parts = addSizes(...Object.values(turn.parts));
        expect(parts.chars + turn.extra.chars).toBe(turn.total.chars);
        expect(turn.total.bytes).toBeGreaterThan(0);
      }
    }
  });

  it('システムプロンプトは記憶の索引と自己認識をそのまま含み、残りがテンプレートで、道具の定義が取れる', () => {
    const human = smallRuns.find((run) => run.kind === 'human');
    const { session, tools } = human!.result;

    // 引き算で出したテンプレートの内訳は恒等式になるので、実在する部分文字列かどうかを確かめる
    expect(session.contains).toEqual({ memory: true, self: true });
    expect(session.template.chars).toBeGreaterThan(5_000);
    expect(session.memory.chars).toBeGreaterThan(0);
    expect(tools.count).toBeGreaterThan(30);
    // 名前だけの一覧は定義全体より小さい（ToolSearch が deferred にする意味がある）
    expect(tools.namesOnly.chars).toBeLessThan(tools.definitions.chars / 10);
    expect(renderSessionTable(session, tools)).toContain('道具の定義');
  }, 60_000);

  it('同じ条件を 2 回測ると同じ長さになる（決定的な組み立てを測っている）', async () => {
    const first = smallRuns.filter((run) => run.kind === 'human' || run.kind === 'initiative');
    const second = await measureAllKinds(SMALL, ['human', 'initiative']);

    expect(first).toHaveLength(2);
    for (const [index, run] of first.entries()) {
      expect(second[index]!.result.turns.map((turn) => turn.total.chars)).toEqual(
        run.result.turns.map((turn) => turn.total.chars),
      );
    }
  }, 60_000);

  // 2 回比べるだけでは、積んだ日誌の最終行と器の起動が同じミリ秒に重なる確率（1 測りあたり数 %）を踏まないことが多く、揺れが緑のまま見えない。
  // 重なると 1 本目の入力の蒸留の断り書き（約 600 字）が消える（全部が同じミリ秒）か、数える行が減って桁が変わる（一部が同じミリ秒）。何度も測って、毎回断り書きが出て長さが同じことを確かめる
  it('同じ条件を何度測っても、1 本目の入力に蒸留の断り書きが毎回載り、長さが揺れない', async () => {
    const lengths = new Set<string>();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const run = await measureKind('human', SMALL);
      expect(run.inputs[0], `${String(attempt + 1)} 回目`).toContain(DISTILL_GAP_NOTICE_HEAD);
      lengths.add(run.turns.map((turn) => turn.total.chars).join(','));
    }
    expect([...lengths]).toHaveLength(1);
  }, 120_000);

  it('固定文は同じ会話の 2 本目から畳まれ、発意の tick は 1 本目より 2 本目が小さい', () => {
    const runs = smallRuns.filter((run) => run.kind === 'human' || run.kind === 'initiative');

    for (const run of runs) {
      const [first, second] = run.result.turns;
      expect(second!.total.chars).toBeLessThan(first!.total.chars);
    }
    const initiative = runs[1]!.result.turns;
    expect(initiative[0]!.digestsBuilt.map((digest) => digest.shape)).toContain('full');
    expect(stateOf(initiative[0]!).chars).toBeGreaterThan(0);
  });

  it('表は種類 × 回の行を持ち、1 日あたりの表は合計の行で閉じる', () => {
    const runs = smallRuns;

    const table = renderTurnTable(runs);
    expect(table.split('\n')).toHaveLength(2 + 4 * 3);
    expect(renderDaily(runs)).toContain('| 合計 |');
    expect(renderSensitivity([{ variant: { label: 'x', config: SMALL }, runs }])).toContain(
      '| x |',
    );
    expect(sizeOf('あa').bytes).toBe(4);
  });

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
