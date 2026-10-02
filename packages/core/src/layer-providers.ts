/**
 * 層ごとの既定 provider。
 *
 * PRD「要件を担う能力を欠く provider は、既定にできない」を固定する置き場
 * （`provider-gaps.test.ts` が、各層の既定について `missingRequirementCapabilities`
 * が空であることを測る）。**層ごとに選ぶ口（環境変数）ではない** — 選択は別の段の仕事で、
 * ここは「選ばれなかったときの既定」だけを1か所に集める。
 */
import type { LayerProviders } from './provider-gaps.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';

export const DEFAULT_LAYER_PROVIDERS: LayerProviders = {
  clone: CLAUDE_PROVIDER,
  manager: CLAUDE_PROVIDER,
  worker: CLAUDE_PROVIDER,
};
