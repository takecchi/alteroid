import { describe, expect, it } from 'vitest';

import { fingerprintOf } from './credentials.js';
import { turnInputEntry, type TurnInput } from './turn-input.js';

describe('describeTurnInput の名簿（turnInputEntry 経由。schema に足した型・欄の足し忘れを赤くする。Issue #1397 c16-2）', () => {
  type FieldPlan =
    | { readonly emit: 'tag'; readonly token: string }
    | { readonly emit: 'raw'; readonly token: string; readonly literal: string }
    | { readonly emit: 'size'; readonly token: string }
    | {
        readonly emit: 'size-with-fingerprint';
        readonly sizeToken: string;
        readonly fingerprintToken: string;
      }
    | { readonly emit: 'full' };

  type ShapedFieldsOf<T extends TurnInput['type']> = Exclude<
    keyof Extract<TurnInput, { type: T }>,
    'type'
  >;

  const TURN_INPUT_SHAPE_PLAN = {
    distill: {
      reason: { emit: 'tag', token: 'reason' },
      prompt: { emit: 'size', token: 'prompt' },
    },
    pre_compact_distill: {
      transcriptTail: {
        emit: 'size-with-fingerprint',
        sizeToken: 'tail',
        fingerprintToken: 'tail.fp',
      },
    },
    human_answer: {
      approvalId: { emit: 'tag', token: 'approvalId' },
      text: { emit: 'full' },
    },
    timer: {
      kind: { emit: 'tag', token: 'kind' },
      cause: { emit: 'tag', token: 'cause' },
      target: { emit: 'tag', token: 'target' },
      request: { emit: 'raw', token: 'request', literal: 'yes' },
      digest: { emit: 'size', token: 'digest' },
    },
    self_initiative: {
      reason: { emit: 'tag', token: 'reason' },
      cause: { emit: 'tag', token: 'cause' },
      digest: { emit: 'size', token: 'digest' },
    },
    daily_report: {
      date: { emit: 'tag', token: 'date' },
      cause: { emit: 'tag', token: 'cause' },
      digest: { emit: 'size', token: 'digest' },
    },
  } satisfies { [T in TurnInput['type']]: Record<ShapedFieldsOf<T>, FieldPlan> };

  const SECRET = 'ghp_666666666666666666666666666666666666';

  const TURN_INPUT_TYPES = Object.keys(TURN_INPUT_SHAPE_PLAN) as TurnInput['type'][];

  const FULL_FIXTURES: { [T in TurnInput['type']]: Required<Extract<TurnInput, { type: T }>> } = {
    distill: { type: 'distill', reason: 'scheduled', prompt: SECRET },
    pre_compact_distill: { type: 'pre_compact_distill', transcriptTail: SECRET },
    human_answer: { type: 'human_answer', approvalId: 'ap-1', text: SECRET },
    timer: {
      type: 'timer',
      kind: 'daily_report',
      cause: 'manual',
      target: 'target-1',
      request: true,
      digest: SECRET,
    },
    self_initiative: {
      type: 'self_initiative',
      reason: 'manual-check',
      cause: 'manual',
      digest: SECRET,
    },
    daily_report: { type: 'daily_report', date: '2026-08-20', cause: 'manual', digest: SECRET },
  };

  function shapeOf(input: TurnInput): string {
    const entry = turnInputEntry(input);
    if (entry.type !== 'exchange') {
      throw new Error(`unreachable: turnInputEntry は常に exchange を返す（実際は ${entry.type}）`);
    }
    return entry.text;
  }

  it('名簿のキー集合は空でない（走査が空振りして0件のまま緑になる形を作らない）', () => {
    expect(TURN_INPUT_TYPES.length).toBeGreaterThan(0);
    expect(new Set(TURN_INPUT_TYPES).size).toBe(TURN_INPUT_TYPES.length);
  });

  it('名簿の各欄について describeTurnInput が plan どおりに振る舞う（tag/raw は目印・size は長さだけ・size-with-fingerprint は長さ+指紋のみ・full は全文）', () => {
    for (const type of TURN_INPUT_TYPES) {
      const shape = shapeOf(FULL_FIXTURES[type]);
      const plan: Record<string, FieldPlan> = TURN_INPUT_SHAPE_PLAN[type];

      for (const [field, fieldPlan] of Object.entries(plan)) {
        switch (fieldPlan.emit) {
          case 'tag': {
            const rawValue = String((FULL_FIXTURES[type] as Record<string, unknown>)[field]);
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=${rawValue}`);
            break;
          }
          case 'raw':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=${fieldPlan.literal}`);
            break;
          case 'size':
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.token}.chars=${SECRET.length}`,
            );
            break;
          case 'size-with-fingerprint':
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.sizeToken}.chars=${SECRET.length}`,
            );
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.fingerprintToken}=${fingerprintOf(SECRET)}`,
            );
            break;
          case 'full':
            expect(shape, `${type}.${field}`).toContain(SECRET);
            break;
        }
      }
    }
  });

  it('size/size-with-fingerprint の欄に置いた自由文は、full 欄を持たない型の跡には一切現れない', () => {
    for (const type of TURN_INPUT_TYPES) {
      const plan: Record<string, FieldPlan> = TURN_INPUT_SHAPE_PLAN[type];
      const hasFullField = Object.values(plan).some((fieldPlan) => fieldPlan.emit === 'full');
      if (hasFullField) continue;

      const shape = shapeOf(FULL_FIXTURES[type]);
      expect(shape, type).not.toContain(SECRET);
    }
  });
});
