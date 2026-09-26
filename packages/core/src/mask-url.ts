/**
 * MCP サーバの宛先 URL を、秘密が載りうる部分ごと伏せる（issue #1622）。
 *
 * **CLI（`apps/cli/src/mcp.ts`）と Web UI（`apps/web/app/routes/mcp-servers.tsx`）の
 * 唯一の正本である。** かつては両方が同じ1行の判定を別々に持っていて、
 * どちらも userinfo の `password` を見ていなかった —— `https://:<秘密>@host` の形
 * （`username` が空文字になる）は伏せられず、Web の一覧にも `alteroid mcp list` にも
 * 秘密がそのまま出た。**片方だけ直すと、同じ秘密がもう片方から出る**ので、
 * 判定をここへ寄せた（`@alteroid/core/mask-url`。軽い口にした理由は
 * `tsup.config.ts` の `entry` の doc）。
 *
 * **import を1つも持たない。** ブラウザのバンドルへ入るので、サーバ専用の
 * ドメイン層を引き込まないためである（`permission-rule.ts` と同じ形）。
 */

/** 伏せた部分の置き換え。CLI と Web で同じ字面を出す。 */
export const URL_MASK = '***';

/**
 * URL のクエリ・フラグメント・認証情報（userinfo の `username` と `password` の
 * **どちらか**が在れば）を伏せる。伏せたときは `origin + pathname + ?***` を返す。
 *
 * **読めない URL は丸ごと伏せる** —— 読めないものの中のどこに鍵があるかは
 * 判別できない。
 *
 * **`password` を必ず見ること。** `username` だけを見ると、password だけの
 * userinfo（`https://:<秘密>@host`）が素通りする（#1622 の穴そのもの）。
 */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return URL_MASK;
  }
  const hidden =
    parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '';
  return hidden ? `${parsed.origin}${parsed.pathname}?${URL_MASK}` : url;
}
