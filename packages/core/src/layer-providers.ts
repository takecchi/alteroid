import type { LayerProviders } from './provider-gaps.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';

export const DEFAULT_LAYER_PROVIDERS: LayerProviders = {
  clone: CLAUDE_PROVIDER,
  manager: CLAUDE_PROVIDER,
  worker: CLAUDE_PROVIDER,
};
