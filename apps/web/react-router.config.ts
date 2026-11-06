import type { Config } from '@react-router/dev/config';

// SSR にしない: 画面を動かすための実行系がもう一つ増え、置ける場所がその実行系を持てるところに縮むため
// ルートのモジュールを分割しない（v8 で既定の true になった。v7 と同じ出力に戻す）: `clientLoader` は URL の引数を返すだけでデータを取りに行かず、分割で得られる「loader の取得と部品の読み込みを並べる」利点が無く、小さなチャンクが増える重さだけが残るため
export default {
  ssr: false,
  splitRouteModules: false,
} satisfies Config;
