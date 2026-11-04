import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runnerEventSchema } from './runner-protocol.js';
import { journalEntrySchema } from './schema.js';

// 作業者を待つ区間の計測（`worker_wait`）は、runner から daemon へ送る出来事（`runner-protocol.ts`）と、日誌の行（`schema.ts`）の2か所に、同じ計測の欄の型がある。
// 欄の定義を1か所にまとめる前後で変わらないことを、2つの型を JSON Schema へ写した形（`openapi.json` もこの型から作る）と、読み込みの振る舞いで固定する。

function workerWaitOption(union: z.ZodDiscriminatedUnion): z.ZodType {
  const found = union.options.find(
    (option) =>
      option instanceof z.ZodObject &&
      option.shape.type instanceof z.ZodLiteral &&
      option.shape.type.value === 'worker_wait',
  );
  if (found === undefined) throw new Error('worker_wait の型が見つからない');
  return found as z.ZodType;
}

const MEASURES = {
  openedAt: '2026-11-05T00:00:00.000Z',
  tasks: 2,
  turns: 5,
  byCause: { input: 1, notification: 3, continuation: 1 },
  toolless: 1,
  notifications: 4,
  submits: 5,
  sources: { user: 1, system: 4 },
  settled: true,
};

const HEADS = {
  runner: { type: 'worker_wait', managerId: 'mgr-1' },
  journal: { type: 'worker_wait', id: 'j-1', at: '2026-11-05T00:01:00.000Z' },
} as const;

/** 欄を1つ外した写し */
function without(values: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...values };
  delete copy[key];
  return copy;
}

const SAMPLES: readonly [string, Record<string, unknown>][] = [
  ['全部の欄', MEASURES],
  ['sources が無い', without(MEASURES, 'sources')],
  ['知らない欄が混ざる', { ...MEASURES, extra: 'x' }],
  ['負の数', { ...MEASURES, tasks: -1 }],
  ['整数でない数', { ...MEASURES, byCause: { ...MEASURES.byCause, input: 0.5 } }],
  ['sources の値が負', { ...MEASURES, sources: { user: -1 } }],
  ['settled が無い', without(MEASURES, 'settled')],
  ['openedAt が時刻でない', { ...MEASURES, openedAt: 'きのう' }],
];

describe('worker_wait の計測の欄（runner の出来事と日誌の行）の形と読み込みを固定する', () => {
  // 文字列にしてから縛る: スナップショットの書き出しはオブジェクトの欄を名前の順に並べ替えるので、欄の並び（`openapi.json` に出る順）を縛れないため
  it('runner の出来事の型を JSON Schema へ写した形（欄の並びを含む）', () => {
    expect(
      JSON.stringify(z.toJSONSchema(workerWaitOption(runnerEventSchema)), null, 2),
    ).toMatchSnapshot();
  });

  it('日誌の行の型を JSON Schema へ写した形（欄の並びを含む）', () => {
    expect(
      JSON.stringify(z.toJSONSchema(workerWaitOption(journalEntrySchema)), null, 2),
    ).toMatchSnapshot();
  });

  for (const [layer, schema] of [
    ['runner', runnerEventSchema],
    ['journal', journalEntrySchema],
  ] as const) {
    it.each(SAMPLES)(`${layer}: %s`, (_name, measures) => {
      const parsed = schema.safeParse({ ...HEADS[layer], ...measures });
      expect(
        parsed.success
          ? { success: true, data: parsed.data }
          : {
              success: false,
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path,
              })),
            },
      ).toMatchSnapshot();
    });
  }
});
