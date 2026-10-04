import { expect, it } from 'vitest';

it('陰性対照(a): 一部のシャードにしか入らないテストをわざと落とす', () => {
  expect(1).toBe(2);
});
