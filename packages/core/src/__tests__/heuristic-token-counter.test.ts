import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { heuristicTokenCounter } from "../heuristic-token-counter.js";

/**
 * 実測の記録（js-tiktoken の o200k_base、121件のコーパス）。`resolveJsonModule` は
 * このパッケージの契約（core は実行時に zod だけに依存する。dependency-boundary.test.ts）
 * を曖昧にしたくないので使わず、`readFileSync` + `JSON.parse` で読む。
 */
const referencePath = new URL("./fixtures/token-count-reference.json", import.meta.url);

type ReferenceSample = {
  id: string;
  class: string;
  source: string;
  text: string;
  o200k_base: number;
  cl100k_base: number;
};

type ReferenceFixture = {
  samples: ReferenceSample[];
};

const reference: ReferenceFixture = JSON.parse(readFileSync(referencePath, "utf8"));

function samplesOfClass(className: string): ReferenceSample[] {
  return reference.samples.filter((s) => s.class === className);
}

/** クラス全体の 合計推定/合計実測(o200k_base) 比。件数の重みを揃えるため、比ではなく合計で測る。 */
function classRatio(className: string): number {
  const samples = samplesOfClass(className);
  const estimatedSum = samples.reduce(
    (sum, s) => sum + heuristicTokenCounter.count(s.text).tokens,
    0,
  );
  const actualSum = samples.reduce((sum, s) => sum + s.o200k_base, 0);
  return estimatedSum / actualSum;
}

describe("heuristicTokenCounter", () => {
  it("常に counter: 'heuristic' を返す", () => {
    expect(heuristicTokenCounter.count("hello").counter).toBe("heuristic");
  });

  it("空文字は 0 トークン", () => {
    expect(heuristicTokenCounter.count("").tokens).toBe(0);
  });

  it("非CJK かつ BMP 内の文字だけのテキストは従来どおり ceil(文字数/4) と一致する（互換性）", () => {
    // 非CJKの係数（0.25 = 5/20）は現行式と数値として同一なので、CJK が1文字も無く、かつ
    // サロゲートペア（非BMP）も無ければ常に一致するはずである。⚠ 非BMP を含むと
    // 従来（UTF-16 コード単位で2と数える）とは一致しない——そこは意図して変えた側である——これは Issue #108 が「壊れていない側は動かさない」と
    // 決めた帰結（純ASCIIテキストは下位互換）そのものを測る歯。
    expect(heuristicTokenCounter.count("abcdefgh").tokens).toBe(2);
    expect(heuristicTokenCounter.count("abcde").tokens).toBe(2);

    const enSamples = samplesOfClass("en");
    expect(enSamples.length).toBeGreaterThan(0);
    for (const sample of enSamples) {
      expect(heuristicTokenCounter.count(sample.text).tokens).toBe(
        Math.ceil(sample.text.length / 4),
      );
    }
  });

  it("同じ文字数なら日本語のほうが英語より重い", () => {
    // CJK 0.9 / 非CJK 0.25 = 3.6倍。同じコードポイント数で日本語が3倍以上重くなることを
    // 測る（3.6という係数比そのものより緩い帯にして、丸めの影響を吸収する）。
    const ja = "あ".repeat(20);
    const en = "a".repeat(20);
    const jaTokens = heuristicTokenCounter.count(ja).tokens;
    const enTokens = heuristicTokenCounter.count(en).tokens;
    expect(jaTokens).toBeGreaterThanOrEqual(enTokens * 3);
  });

  it("コードポイントで数える（UTF-16 のコード単位ではない）", () => {
    // U+20B9F 叱（CJK統合漢字拡張B、SIP）はサロゲートペア。"𠮟" x4 は
    // UTF-16 のコード単位では8単位になる。もし実装が text.length（UTF-16単位数）で
    // 数えていたら「非CJK8文字」と誤認し、ceil(8*5/20) = 2 トークンになってしまう。
    // コードポイントで正しく4文字のCJKと数えれば ceil(4*18/20) = ceil(3.6) = 4 になる。
    // ⟹ 4 なら正しく数えている、2 なら UTF-16 単位で数える壊れ方をしている、という区別が付く歯。
    const text = "𠮟".repeat(4);
    expect(heuristicTokenCounter.count(text).tokens).toBe(4);
  });

  it("対照コーパス全体で、推定は実測(o200k_base)の 0.95〜1.10 に収まる", () => {
    // 予算（RecallBudget.maxMemoryTokens）は多数の digest の合計に効くので、
    // 1件ごとの相対誤差より「合計としてどれだけ合っているか」が本命——1件ずつ大きく
    // ぶれても打ち消し合えば合計は合う、という理由でこの歯だけ全体合計を見る。
    // 実測（121件、係数 0.9/0.25 で計算した実値）: 0.991。
    const estimatedSum = reference.samples.reduce(
      (sum, s) => sum + heuristicTokenCounter.count(s.text).tokens,
      0,
    );
    const actualSum = reference.samples.reduce((sum, s) => sum + s.o200k_base, 0);
    const overallRatio = estimatedSum / actualSum;
    expect(overallRatio).toBeGreaterThanOrEqual(0.95);
    expect(overallRatio).toBeLessThanOrEqual(1.1);
  });

  it("日本語・中国語・韓国語の合計を過小評価しない", () => {
    // 実測値: ja 1.182 / zh 1.017 / ko 1.057。`zh` の余裕は下限 1.00 に対して 1.7%しか無い
    // ——中国語では 0.9 という係数はぎりぎり足りているだけであり、コーパスの中身が
    // 少し変われば反転しうる。帯は 1.00〜1.35（この帯はオーナーが決めたもので、
    // 実測がこの帯から外れたら帯ではなく係数を疑って報告すること）。
    for (const cls of ["ja", "zh", "ko"]) {
      const ratio = classRatio(cls);
      expect(ratio).toBeGreaterThanOrEqual(1.0);
      expect(ratio).toBeLessThanOrEqual(1.35);
    }
  });

  it("日本語は1件も過小評価しない", () => {
    const jaSamples = samplesOfClass("ja");
    expect(jaSamples.length).toBeGreaterThan(0);
    for (const sample of jaSamples) {
      expect(heuristicTokenCounter.count(sample.text).tokens).toBeGreaterThanOrEqual(
        sample.o200k_base,
      );
    }
  });

  it("⚠ 直っていない範囲: CJK 以外の非ラテン文字は依然として過小評価する（タイ語）", () => {
    // この歯は欠陥を固定する歯ではない。JSDoc の「タイ語は依然として過小評価する
    // （実測の合計比 0.564）」という断り書きが実態と一致していることを測る歯である。
    // タイ語の推定が直ったら（0.25 以外の係数をタイ文字に割り当てるようになったら）
    // この歯は赤くなる——そのときは実装のバグではなく、JSDoc の断り書きを
    // 書き直せ、という合図として読むこと。
    const ratio = classRatio("th");
    expect(ratio).toBeLessThan(1.0);
  });

  it("#108 が報告した穴の記録: 旧式は日本語を2.5倍以上過小評価していた", () => {
    // ⚠ この歯は heuristicTokenCounter を一切参照しない——実装をどう変えても、
    // どう壊しても赤くならない。ここに残す理由は「直す前は何が起きていたか」を
    // 数値で固定しておくことだけであり、回帰検知の歯ではない。
    const legacyCount = (text: string): number => Math.ceil(text.length / 4);
    const jaSamples = samplesOfClass("ja");
    const estimatedSum = jaSamples.reduce((sum, s) => sum + legacyCount(s.text), 0);
    const actualSum = jaSamples.reduce((sum, s) => sum + s.o200k_base, 0);
    const ratio = estimatedSum / actualSum;
    // 実測値: 0.353（≒ 1/2.83。Issue #108 の「実測の1/2.8〜1/3.8」の範囲内）。
    expect(ratio).toBeLessThan(0.4);
  });
});
