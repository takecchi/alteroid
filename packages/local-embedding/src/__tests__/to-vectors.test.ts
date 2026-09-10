import { describe, expect, it } from "vitest";
import { toVectors } from "../pipeline.js";

/**
 * `toVectors` の歯。
 *
 * **なぜ `output.tolist() as number[][]` で済ませないか**を固定する。
 * pooling を指定し忘れると `tolist()` は `[batch][tokens][dim]` の3階を返す。
 * `as` で黙らせると、**トークン列がベクトルとして DB に入る**——
 * 実行時まで、いや DB に入ってからも気づけない壊れ方をする。
 */

/** transformers.js の `Tensor` の、この関数が使う部分だけを真似たもの。 */
function tensor(value: unknown): { tolist: () => unknown } {
  return { tolist: () => value };
}

describe("toVectors", () => {
  it("Tensor 風のオブジェクトから number[][] を取り出す", () => {
    expect(
      toVectors(
        tensor([
          [0.1, 0.2],
          [0.3, 0.4],
        ]),
      ),
    ).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("既に number[][] ならそのまま返す（tolist を持たない実装も通す）", () => {
    expect(toVectors([[1, 2, 3]])).toEqual([[1, 2, 3]]);
  });

  it("空の batch は空の配列", () => {
    expect(toVectors(tensor([]))).toEqual([]);
  });

  it("3階（pooling が効いていない）なら例外になる", () => {
    expect(() =>
      toVectors(
        tensor([
          [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
        ]),
      ),
    ).toThrow(/pooling/);
  });

  it("配列ですらないものは例外になる", () => {
    expect(() => toVectors(tensor("not a tensor"))).toThrow(/配列ではない/);
    expect(() => toVectors(undefined)).toThrow(/配列ではない/);
  });

  it("数値以外が混ざった行は例外になる", () => {
    expect(() => toVectors(tensor([[0.1, "0.2"]]))).toThrow(/number\[\] ではない/);
  });

  it("例外のメッセージは何番目の行かを言う", () => {
    expect(() => toVectors(tensor([[0.1], "壊れた行"]))).toThrow(/1 番目/);
  });
});
