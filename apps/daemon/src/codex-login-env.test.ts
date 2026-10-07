import { describe, expect, it } from 'vitest';

import { codexLoginEnvOf } from './codex-login-env.js';

describe('Codex のログインの子の env（#3939）', () => {
  it('道具を探す PATH・外へ出る名前は渡し、記憶ストアの鍵・認証の鍵・API キーは渡さない', () => {
    const env = codexLoginEnvOf({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:8080',
      ALTEROID_DATABASE_URL: 'postgres://u:p@db/x',
      ALTEROID_RUNNER_TOKEN: 'runner-secret',
      ALTEROID_GOOGLE_CLIENT_SECRET: 'g-secret',
      CODEX_API_KEY: 'sk-fake',
      GH_TOKEN: 'gh-fake',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:8080' });
  });
});
