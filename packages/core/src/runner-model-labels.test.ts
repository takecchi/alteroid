import { describe, expect, it } from 'vitest';

import { CODEX_DEFAULT_MODEL_LABEL, CODEX_NO_WORKER_LABEL } from './agent-provider-selection.js';
import { runnerModelLabels, sessionModelLabels } from './runner-model-labels.js';
import { placedModelAppliesTo } from './runner.js';

describe('sessionModelLabels', () => {
  it('置かれていなければ claude は正典の帯、codex は既定のモデルと作業者なし', () => {
    expect(sessionModelLabels('claude', 'claude', {})).toEqual({
      manager: 'opus',
      worker: 'sonnet',
    });
    expect(sessionModelLabels('codex', 'codex', {})).toEqual({
      manager: CODEX_DEFAULT_MODEL_LABEL,
      worker: CODEX_NO_WORKER_LABEL,
    });
  });

  it('置かれたモデルは runner の既定の provider にだけ効き、指名された別の provider には効かない', () => {
    const env = { ALTEROID_MANAGER_MODEL: 'gpt-x', ALTEROID_WORKER_MODEL: 'haiku' };
    expect(sessionModelLabels('codex', 'codex', env)).toEqual({
      manager: 'gpt-x',
      worker: CODEX_NO_WORKER_LABEL,
    });
    expect(sessionModelLabels('claude', 'codex', env)).toEqual({
      manager: 'opus',
      worker: 'sonnet',
    });
    expect(sessionModelLabels('claude', 'claude', env)).toEqual({
      manager: 'gpt-x',
      worker: 'haiku',
    });
    expect(placedModelAppliesTo('codex', 'claude')).toBe(false);
    expect(placedModelAppliesTo(undefined, 'claude')).toBe(true);
  });

  it('runner が起こせる provider ごとに作る', () => {
    expect(Object.keys(runnerModelLabels('claude', {})).sort()).toEqual(['claude', 'codex']);
  });
});
