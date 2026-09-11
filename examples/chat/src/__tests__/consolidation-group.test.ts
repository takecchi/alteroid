import { describe, expect, it } from "vitest";
import { splitIntoConsolidationGroups } from "../consolidation-group.js";

describe("splitIntoConsolidationGroups", () => {
  it("ちょうど割り切れるときは全部が群になり、leftover は空", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const result = splitIntoConsolidationGroups(ids, 5);
    expect(result.groups).toEqual([
      ["m0", "m1", "m2", "m3", "m4"],
      ["m5", "m6", "m7", "m8", "m9"],
    ]);
    expect(result.leftover).toEqual([]);
  });

  it("余りが2件以上ならそれ自体が最後の群になる", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const result = splitIntoConsolidationGroups(ids, 5);
    expect(result.groups).toEqual([
      ["m0", "m1", "m2", "m3", "m4"],
      ["m5", "m6", "m7", "m8", "m9"],
      ["m10", "m11"],
    ]);
    expect(result.leftover).toEqual([]);
  });

  it("余りが1件なら群にせず leftover へ回す", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    const result = splitIntoConsolidationGroups(ids, 5);
    expect(result.groups).toEqual([
      ["m0", "m1", "m2", "m3", "m4"],
      ["m5", "m6", "m7", "m8", "m9"],
    ]);
    expect(result.leftover).toEqual(["m10"]);
  });

  it("全体が groupSize 未満でも2件以上あれば1つの群になる", () => {
    const result = splitIntoConsolidationGroups(["a", "b", "c"], 5);
    expect(result.groups).toEqual([["a", "b", "c"]]);
    expect(result.leftover).toEqual([]);
  });

  it("1件しか無ければ群にせず leftover に置く", () => {
    const result = splitIntoConsolidationGroups(["a"], 5);
    expect(result.groups).toEqual([]);
    expect(result.leftover).toEqual(["a"]);
  });

  it("0件なら群も leftover も空", () => {
    const result = splitIntoConsolidationGroups([], 5);
    expect(result.groups).toEqual([]);
    expect(result.leftover).toEqual([]);
  });

  it("並べ替えない(入力順をそのまま保つ)", () => {
    const result = splitIntoConsolidationGroups(["z", "a", "m"], 2);
    expect(result.groups).toEqual([["z", "a"]]);
    expect(result.leftover).toEqual(["m"]);
  });

  it("groupSize が2未満なら例外を投げる", () => {
    expect(() => splitIntoConsolidationGroups(["a", "b"], 1)).toThrow(/groupSize/);
    expect(() => splitIntoConsolidationGroups(["a", "b"], 0)).toThrow(/groupSize/);
  });
});
