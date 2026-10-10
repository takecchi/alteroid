import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { approvalQuestionSchema } from './schema.js';
import {
  describeUnknownNestedKeys,
  describeUnknownToolArgs,
  strictToolInput,
} from './strict-tool-input.js';

describe('strictToolInput（知らない引数を黙って捨てない）', () => {
  const shape = {
    question: z.string(),
    context: z.string().optional(),
    questions: z.array(z.object({ id: z.string() })).optional(),
  };
  const schema = strictToolInput(shape) as unknown as z.ZodType;

  it('知らない引数があれば断り、その名前・近い名前・受け付ける引数を言う', () => {
    const result = schema.safeParse({ question: 'q', options: [{ id: 'a' }] });
    expect(result.success).toBe(false);
    const message = result.error?.issues.map((issue) => issue.message).join('\n') ?? '';
    expect(message).toContain('この道具に無い引数: options（近い名前: questions）');
    expect(message).toContain('受け付ける引数: question, context, questions');
  });

  it('知っている引数だけなら、そのまま通る（任意の引数を省いても通る）', () => {
    expect(schema.safeParse({ question: 'q', questions: [{ id: 'a' }] }).success).toBe(true);
    expect(schema.safeParse({ question: 'q' }).success).toBe(true);
  });

  it('知らない引数を捨てて通す形に戻っていない（strip ではない）', () => {
    const loose = z.object(shape).safeParse({ question: 'q', options: [] });
    expect(loose.success).toBe(true);
    expect(schema.safeParse({ question: 'q', options: [] }).success).toBe(false);
  });
});

describe('describeUnknownToolArgs の「近い名前」', () => {
  it('遠い名前は近いと言わない（誤った言い換えを促さない）', () => {
    expect(describeUnknownToolArgs(['zzz'], ['question', 'questions'])).toBe(
      'この道具に無い引数: zzz。黙って捨てずに断った（呼び出しは何もしていない）。受け付ける引数: question, questions',
    );
  });

  it('大文字小文字だけの違いは近い名前として挙げる', () => {
    expect(describeUnknownToolArgs(['managerID'], ['managerId', 'text'])).toContain(
      'managerID（近い名前: managerId）',
    );
  });
});

describe('strictToolInput の入れ子（#4426）', () => {
  it('道具の入力の写しだけを strict にし、共通のスキーマ（approvalQuestionSchema）は知らない鍵を今までどおり捨てる', () => {
    const schema = strictToolInput({
      questions: z.array(approvalQuestionSchema).optional(),
    }) as unknown as z.ZodType;
    const input = {
      questions: [{ id: 'q', prompt: 'p', options: [{ id: 'a', label: 'A' }], choices: [] }],
    };

    expect(schema.safeParse(input).success).toBe(false);
    const shared = approvalQuestionSchema.safeParse(input.questions[0]);
    expect(shared.success).toBe(true);
    expect(shared.data).not.toHaveProperty('choices');
  });

  it('catchall を持つ object は、知らない鍵を受けるまま変えない', () => {
    const schema = strictToolInput({
      extra: z.object({ id: z.string() }).catchall(z.string()),
    }) as unknown as z.ZodType;
    expect(schema.safeParse({ extra: { id: 'a', other: 'b' } }).success).toBe(true);
  });

  it('場所は questions[0].options[1] の形で言い、道具の直下と同じ形に揃える', () => {
    expect(
      describeUnknownNestedKeys(
        ['questions', 0, 'options', 1],
        ['recommend'],
        ['id', 'recommended'],
      ),
    ).toBe(
      'questions[0].options[1] に無い欄: recommend（近い名前: recommended）。黙って捨てずに断った（呼び出しは何もしていない）。受け付ける欄: id, recommended',
    );
  });
});
