import type { Config } from '@react-router/dev/config';

/**
 * SPA モード（`ssr: false`）。
 *
 * **サーバを持たないことが要件である。** デーモンと画面の置き場所は人によって違う
 * （同じホスト / `api.example.com` と `www.example.com` / API は自宅で画面は静的
 * ホスティング）。SSR にすると「画面を動かすための実行系」がもう一つ増え、置ける
 * 場所がその実行系を持てるところに縮む。静的成果物なら、どの配置でも同じものを置ける。
 *
 * この判断は接続先の決め方（`app/lib/config.ts`）と対になっている。ビルド時に
 * 接続先を焼き込まないので、同じ成果物のまま別のデーモンへ向けられる。
 */
export default {
  ssr: false,
} satisfies Config;
