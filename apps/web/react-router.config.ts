import type { Config } from '@react-router/dev/config';

// SSR にしない: 画面を動かすための実行系がもう一つ増え、置ける場所がその実行系を持てるところに縮むため
export default {
  ssr: false,
} satisfies Config;
