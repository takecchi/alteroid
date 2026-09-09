import { describe, expect, it } from "vitest";
import {
  VERIFIED_MAJOR_VERSIONS,
  formatServerLines,
  majorVersionOf,
} from "../db-server-description.mjs";

/**
 * `scripts/db-server-description.mjs` の歯。
 *
 * **この歯が守っているもの**: 門が接続先について**黙らない**こと。
 * 「取れた」「取れなかった」「取れたが検証されていない版だった」は**どれも情報**であり、
 * どれか1つでも出力から落ちると、赤くなった人が「自分の変更のせいか」を切り分けられない。
 *
 * DB には触らない（純関数だけを測る）。**実接続で実際に版が取れること**は
 * `.github/workflows/ci.yml` の `root-gate-db-stage` ジョブが `grep` で押さえている
 * ——ADR 0015 が「実行していません」の文言を CI 側で検査しているのと同じ形。
 */
describe("formatServerLines", () => {
  it("取れなかったときに黙らない（理由を出す）", () => {
    const lines = formatServerLines({ ok: false, reason: "connect ECONNREFUSED 127.0.0.1:1" });
    const text = lines.join("\n");

    expect(text).toContain("版を取得できませんでした");
    // **芯**: 何が起きたかが出ること。理由を落とすと「取れなかった」しか残らない。
    expect(text).toContain("ECONNREFUSED");
    // 取れたときの顔をしないこと——ここが潰してはいけない区別そのもの。
    expect(text).not.toMatch(/接続先: PostgreSQL \d/);
  });

  it("検証済みの版では、版を出すだけで警告は出さない", () => {
    const major = VERIFIED_MAJOR_VERSIONS[0];
    const lines = formatServerLines({
      ok: true,
      serverVersion: `${major}.4 (Debian)`,
      vectorVersion: "0.8.2",
    });
    const text = lines.join("\n");

    expect(text).toContain(`接続先: PostgreSQL ${major}.4 (Debian) / pgvector 0.8.2`);
    // 検証済みなのに警告を出すと、警告そのものが読み飛ばされるようになる。
    expect(text).not.toContain("検証されていない版です");
  });

  it("検証されていない版では、版・警告・次の一手をすべて出す", () => {
    const unverified = 16;
    expect(VERIFIED_MAJOR_VERSIONS).not.toContain(unverified);

    const lines = formatServerLines({
      ok: true,
      serverVersion: `${unverified}.15 (Debian ${unverified}.15-1.pgdg12+2)`,
      vectorVersion: "0.8.6",
    });
    const text = lines.join("\n");

    expect(text).toContain(`接続先: PostgreSQL ${unverified}.15`);
    expect(text).toContain(`PostgreSQL ${unverified} は、この repo で検証されていない版です`);
    // **芯**: 警告だけでは動けない。次に何をするかまで出ること。
    expect(text).toContain("origin/main で対照を取る");
  });

  it("pgvector が入っていないことを、版が取れなかったことと混ぜない", () => {
    const text = formatServerLines({
      ok: true,
      serverVersion: `${VERIFIED_MAJOR_VERSIONS[0]}.4`,
      vectorVersion: null,
    }).join("\n");

    expect(text).toContain("pgvector（拡張が入っていません）");
    expect(text).not.toContain("版を取得できませんでした");
  });

  it("メジャー版を読み取れないときは、検証済みだと言い張らない", () => {
    const text = formatServerLines({
      ok: true,
      serverVersion: "（不明な形式）",
      vectorVersion: "0.8.6",
    }).join("\n");

    expect(text).toContain("メジャー版を読み取れませんでした");
    expect(text).not.toContain("検証されていない版です");
  });
});

describe("majorVersionOf", () => {
  it("先頭の数値をメジャー版として読む", () => {
    expect(majorVersionOf("16.15 (Debian 16.15-1.pgdg12+2)")).toBe(16);
    expect(majorVersionOf("17.4")).toBe(17);
    expect(majorVersionOf("18.6 (Homebrew)")).toBe(18);
  });

  it("読み取れない形は推測せず null を返す", () => {
    expect(majorVersionOf("（不明な形式）")).toBeNull();
    expect(majorVersionOf("")).toBeNull();
  });
});
