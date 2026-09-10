import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * 「SDK が『これは応答ではない』と言っている」印を読む。
 *
 * ## なぜこれが要るのか
 *
 * 実際に起きた壊れ方は、日報の本文が丸ごと
 * `You've hit your org's monthly spend limit · ask your admin to raise it at …`
 * になっていた、というものである。**エラーが返答として扱われた。**
 *
 * 経路はこうだった — 上限の文言は `assistant` メッセージの text ブロックとして
 * 届き、`clone.ts` はそれを無条件に `turn.text`（＝応答の本文）へ足していた。
 * ターンの戻り値は `string` 一本で成否を運ばないので、日報を作る側はそれが
 * 応答なのか失敗なのかを判別できず、そのまま日報の本文として書いた。
 *
 * ## 検知は構造化された印だけで行う（文言で検知しない）
 *
 * **ここに文言の判定を置かないこと。** 分類は `usage-limits.ts` が SDK の定数で
 * 行うが、あれを「応答かどうか」の判定に使ってはならない — `classifyUsageNotice`
 * は部分一致（`includes`）なので、**クローンが「上限に当たった」と日報に書いた
 * 瞬間に上限と誤判定する**（自家中毒）。
 *
 * 順序はこう固定する。
 *
 * 1. **構造化された印**（このファイル）で「応答ではない」を確定させる
 * 2. 確定した後にだけ、その文言を `classifyUsageNotice` へ通して
 *    「待つ（`reached`）」か「待たない」かを決める
 *
 * こうすると、分類にかける文字列は必ず「SDK 自身が失敗として出したもの」に
 * 限られるので、クローンの書いた本文が分類器に触れることが構造上なくなる。
 */

/** 応答ではないと分かった印の出どころ。 */
export type SdkFailureVia =
  /** `assistant.error`（SDK が assistant メッセージ自身に付ける印）。 */
  | 'assistant_error'
  /** `result.subtype` が `success` 以外（`error_during_execution` など）。 */
  | 'result_subtype'
  /** `result.subtype` は `success` だが `is_error` が真。 */
  | 'result_is_error';

export interface SdkFailure {
  via: SdkFailureVia;
  /**
   * 印そのもの（`billing_error` / `error_during_execution` / `api_error_status`）。
   * **言い換えない** — 人間が SDK の型定義で引ける語のまま残す。
   */
  code: string;
  /**
   * SDK が出した文言そのまま。無ければ空文字。
   *
   * これが `classifyUsageNotice` へ渡る唯一の材料である（上の doc の順序2）。
   */
  text: string;
}

/** 空でない文字列だけを通す。 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * `assistant` メッセージに付いた失敗の印。無ければ `undefined`。
 *
 * SDK の `SDKAssistantMessage.error` は
 * `'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'billing_error' |
 * 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' |
 * 'unknown' | 'max_output_tokens' | 'cloud_credential_error'` である。**支出上限は
 * このうち `billing_error` として来る側**で、つまり SDK は「これはモデルの発言では
 * ない」と最初から言っている。
 *
 * ## `cloud_credential_error`（0.3.267 で増えた）を分類していない理由
 *
 * **この語は「Anthropic の API が断った」ではなく「API へ届く前に、AWS / Google
 * Cloud のローカルな資格情報の解決に失敗した」を指す。** 立つ条件は次のどちらか
 * だけである（実測 2026-09-10、`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.267`
 * の `claude` を `grep -a` して読んだ逐語。**npm パッケージ側にはこの語の doc も
 * 組み立ても無い** — `sdk.d.ts` の union に現れるだけで `.mjs` には0件だった）:
 *
 * > `function eJ(e){if(e instanceof Ht&&e.status!==void 0)return null;if(zxt(e))return"AWS";if(ZOn()&&JOn(e,QOn))return"Google Cloud";return null}`
 *
 * 先頭の1行が効いている——**HTTP の状態番号を持つ応答はここで先に外れる。**
 * ⟹ 資格情報は取れたが API が 401/403 を返した回は `authentication_failed` の側
 * であって、この語には来ない。**`authentication_failed` / `billing_error` /
 * `account_on_hold` / `rate_limit` はどれも「向こうが断った」側で、この語だけが
 * 「こちらが名乗れなかった」側である。⟹ 同じ箱に入れない。**
 *
 * **⚠️ そのうえで「待てば開くか」は SDK からは決まらない。SDK 自身の印が割れて
 * いる**（同じ実測から、いずれも逐語）:
 *
 * - 立てる側は**一時的だと言っている**:
 *   `error:"cloud_credential_error",apiErrorIsTransient:!0`
 * - 人へ見せる側は**人が動けと言っている**:
 *   `case"cloud_credential_error":return{state:"blocked",needs:"cloud credentials unavailable — check or refresh them"}`
 * - 詰まりを上げるかの分岐では、**`authentication_failed` の側ではなく
 *   `overloaded` / `rate_limit` / `unknown` と同じ「上げない」側に置かれている**:
 *   `case"cloud_credential_error":case"unknown":case void 0:return null`
 *
 * ⟹ **どちらとも名乗らせない。** 実際いまそうなっている——この語に付く文言
 * （`API Error: Could not load AWS credentials · … Check or refresh your AWS
 * credentials and try again.`）は `USAGE_LIMIT_ERROR_PREFIXES` のどれにも当たらず、
 * `limitRecoveryOf` は `'unknown'` を返し、`withRecoveryNote` は行を足さない。
 * **ただしそれは「当たらなかった」から出ている値であって、誰かが決めた値ではない。**
 * 接頭辞が1本増えるだけで黙って `time` を名乗りうるので、**名乗らないことのほうを
 * 歯で留めてある**（`sdk-failure.test.ts` の describe
 * 「`cloud_credential_error` — 回復の見込みを名乗らない」）。
 *
 * **この写しは数え上げなので腐る。** 腐ったことを `tsc` に言わせる歯は
 * `sdk-failure.test.ts` の `SDK_ASSISTANT_ERROR_CODES` にあり、SDK が語を増やすと
 * そこが落ちる。**落ちたら、増えた語をあちらの表とこの写しの両方へ足すこと**
 * （片方だけ直すと、次に読む人には写しのほうが正しく見える）。
 *
 * **⚠️ ここを読み落としても、`assistantFailureOf` は語を取りこぼさない。** 下の実装は
 * 語を列挙せず「空でない文字列」を印として通すので、**知らない語も印になる。**
 * 数え上げているのはこの写しと歯だけである。
 *
 * **印も本文も呼び出し側が渡す。** メッセージそのものを受け取らないのは、
 * SDK の綴り（`error` という欄に印が載ること）を読むのが
 * `claude-provider.ts` の `foldClaudeMessage` の仕事だからである（#486
 * 「読み側の中立化」）。本文のほうは層によって取り出し方が違う
 * （`clone.ts` はブロックをそのまま繋ぎ、`runner.ts` は改行で繋いで trim する）
 * ので、ここで3つ目の写しを作ると綴りの取り違えが片方だけで起きる。
 */
export function assistantFailureOf(error: unknown, text: string): SdkFailure | undefined {
  const code = nonEmpty(error);
  return code === undefined ? undefined : { via: 'assistant_error', code, text };
}

/**
 * `result` を「応答として扱ってよい」か。
 *
 * **`usage.ts` の `isSuccessResult` とは問いが違うので、別の関数にしてある。**
 *
 * | 関数 | 問い | 判定 |
 * | --- | --- | --- |
 * | `isSuccessResult` | この累積を**台帳へ通してよいか** | `subtype === 'success'` |
 * | `isAnsweredResult` | このターンを**応答として扱ってよいか** | 上記 ＋ `is_error !== true` |
 *
 * **一方に寄せないこと。** 台帳側を厳しくすると、`is_error` が立った回の累積が
 * 台帳に載らなくなる（値は累積なので次の成功が運んでくるが、そこで打ち切られた
 * セッションの分は落ちる）。応答側を緩くすると、**まさにこの穴に戻る** —
 * `subtype: 'success'` かつ `is_error: true` の result が「答えが返った」ことに
 * なる。`is_error` は `SDKResultSuccess` が持つフィールドであって、
 * `SDKResultError` 専用の印ではない。
 */
export function isAnsweredResult(message: unknown): boolean {
  const candidate = message as { subtype?: unknown; is_error?: unknown };
  return candidate.subtype === 'success' && candidate.is_error !== true;
}

/**
 * `result` に付いた失敗の印。応答として扱える result なら `undefined`。
 *
 * `code` は `subtype`（`success` なら `is_error` 側であることを示す語）に
 * `api_error_status` が読めれば添える。**HTTP の状態番号を落とさない** —
 * 429 と 402 と 500 は待ち方が違う。
 */
export function resultFailureOf(message: SDKMessage): SdkFailure | undefined {
  if (isAnsweredResult(message)) return undefined;
  const candidate = message as {
    subtype?: unknown;
    result?: unknown;
    api_error_status?: unknown;
  };
  const subtype = nonEmpty(candidate.subtype);
  const status =
    typeof candidate.api_error_status === 'number' && Number.isFinite(candidate.api_error_status)
      ? `/${String(candidate.api_error_status)}`
      : '';
  return {
    via: subtype === 'success' ? 'result_is_error' : 'result_subtype',
    code: `${subtype ?? '(不明)'}${status}`,
    text: nonEmpty(candidate.result) ?? '',
  };
}

/**
 * `result.errors[]`（構造を持たない失敗の行）。無ければ空。
 *
 * **クローンとマネージャーが同じこれを呼ぶ。** 直す前は `runner.ts` にだけあり、
 * `clone.ts` は読んでいなかった（0件）ので、上限の文言が `errors[]` にだけ乗った
 * 場合はクローン側だけが検知できないという非対称になっていた。
 */
export function resultErrorLines(message: SDKMessage): string[] {
  const errors = (message as { errors?: unknown }).errors;
  return Array.isArray(errors)
    ? errors.filter((line): line is string => typeof line === 'string')
    : [];
}
