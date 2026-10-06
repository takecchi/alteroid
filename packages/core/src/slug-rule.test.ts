import { describe, expect, it } from 'vitest';

import { describeSlugViolation, MEMORY_SLUG_RULE, PRACTICE_SLUG_RULE } from './slug-rule.js';
import { memorySlugSchema, practiceSlugSchema } from './schema.js';

describe('slug の規則（#3728）', () => {
  const samples = [
    'values',
    'a.b_c-1',
    '../x',
    'my note',
    'a;b',
    'Upper',
    '.x',
    '',
    'a'.repeat(128),
    'a'.repeat(129),
  ];

  it.each(samples)('%j は、schema と describeSlugViolation で同じ判定になる', (slug) => {
    expect(describeSlugViolation(slug, MEMORY_SLUG_RULE) === null).toBe(
      memorySlugSchema.safeParse(slug).success,
    );
    expect(describeSlugViolation(slug, PRACTICE_SLUG_RULE) === null).toBe(
      practiceSlugSchema.safeParse(slug).success,
    );
  });
});
