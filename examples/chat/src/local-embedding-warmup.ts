import type { EmbeddingProvider } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";

/**
 * 「重みを取得できなかった」と「測ったが値が悪かった」を区別するための preflight
 * (Issue #109)。
 *
 * オーナー代理の言葉: 「私が怖いのはジョブが落ちることではありません。『HF から
 * 取れなかった』が『想起の質が下がった』に見えることです。」
 *
 * `@mnemora/local-embedding` はモデルの重みを**最初の `embed()` まで遅延ロードする**
 * (`LocalEmbeddingProvider` の README「モデルは最初の `embed()` まで読み込まれない」)。
 * ⟹ 何も対策しなければ、取得失敗は probe 群を ingest している最中の、ある1回の
 * `embed()` 呼び出しの中で初めて起きる——そこまでに他の probe の一部が既に
 * `recall()` されていれば、**一部だけ数字が出て一部だけ欠ける**、区別しづらい
 * 壊れ方になりかねない。
 *
 * ⟹ **arm を走らせる前に、この関数で明示的に `warmup()` を呼ぶ。** `ok: false` なら、
 * 呼び出し側は **一件もメトリクスを出さずに** 打ち切らなければならない
 * (`cli.ts` の `runIdentifierProbes` を見よ——`ok: false` のとき `runRetrievalQualityArm`/
 * `runIdentifierProbeArm` を1回も呼ばない)。
 *
 * **`LocalEmbeddingProvider` のインスタンスでなければ、何もせず `ok: true` を返す。**
 * `warmup()` はこのパッケージが契約(`EmbeddingProvider`)に無い形で追加した
 * メソッドである(README「先に読み込ませたいときは `warmup()`」)。他の provider
 * (擬似物・`recorded`・本物の OpenAI)には「重みを取得する」という失敗モード自体が
 * 無いため、この preflight の対象外として扱う——**対象外であることを `ok: false` の
 * 側に混ぜない**(そうすると「重みを取得できなかった」という文言が、重みを取得する
 * 概念すら無い provider にまで出てしまう)。
 */
export interface WarmupOutcome {
  ok: boolean;
  detail: string;
}

/** 出力(人間向け・機械可読の両方)に必ずこの文言を含める(オーナー代理の指定)。 */
export const WEIGHTS_UNAVAILABLE_PREFIX = "重みを取得できなかったので、値は測っていない";

export async function warmupLocalEmbedding(provider: EmbeddingProvider): Promise<WarmupOutcome> {
  if (!(provider instanceof LocalEmbeddingProvider)) {
    return {
      ok: true,
      detail:
        "(LocalEmbeddingProvider ではないため warmup 対象外——このモードに重み取得の失敗モードは無い)",
    };
  }
  try {
    await provider.warmup();
    return { ok: true, detail: "モデルの読み込みに成功した(warmup() 完了)" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `LocalEmbeddingProvider` は失敗を包んで投げる(`describeLoadFailure`)——
    // 「次に何ができるか」は `message` に、「何が実際に起きたか」は `cause` に分けて
    // 持たせている(local-embedding-provider.ts の docstring 参照)。ここで `cause` を
    // 捨てると、包んだ文面だけが残り、ネットワーク断・repo 消滅・dtype 名の誤りを
    // 区別する材料が消える。
    const cause = error instanceof Error ? error.cause : undefined;
    const causeMessage = cause instanceof Error ? ` cause: ${cause.message}` : "";
    return {
      ok: false,
      detail: `${WEIGHTS_UNAVAILABLE_PREFIX}: ${message}${causeMessage}`,
    };
  }
}
