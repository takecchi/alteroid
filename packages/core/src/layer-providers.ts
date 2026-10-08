/**
 * 層ごとの provider。**層は常に Claude で動く**（2026-10-07 のオーナー決定。層の provider を
 * 選ぶ環境変数は撤去した）。
 *
 * PRD「要件を担う能力を欠く provider は、既定にできない」を固定する置き場
 * （`provider-gaps.test.ts` が、各層について `missingRequirementCapabilities`
 * が空であることを測る）。
 */
import type { LayerProviders } from './provider-gaps.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';

export const DEFAULT_LAYER_PROVIDERS: LayerProviders = {
  clone: CLAUDE_PROVIDER,
  manager: CLAUDE_PROVIDER,
  worker: CLAUDE_PROVIDER,
};
