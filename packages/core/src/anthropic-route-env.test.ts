import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_ROUTE_NONE_LINE,
  describeAnthropicRoute,
  inspectAnthropicRoute,
} from './anthropic-route-env.js';

const FAKE_AUTH = 'sk-fake-auth-token-0001';
const FAKE_API = 'sk-fake-api-key-0002';
const FAKE_OAUTH = 'sk-fake-oauth-0003';

function lines(...layers: { source: string; env: NodeJS.ProcessEnv }[]): string[] {
  return describeAnthropicRoute(inspectAnthropicRoute(layers));
}

const warning = (out: string[]): string | undefined => out.find((l) => l.startsWith('⚠️'));

describe('#4263 警告の条件', () => {
  it('BASE_URL だけなら警告が出る', () => {
    const out = lines({ source: '器', env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } });
    expect(warning(out)).toContain('https://gw.example.com');
    expect(warning(out)).toContain('いまは置かれていないが、置かれれば送られる');
  });

  it('OAuth が在れば「いま置かれている」と言う', () => {
    const out = lines({
      source: '器',
      env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH },
    });
    expect(warning(out)).toContain('いま置かれている');
  });

  it('AUTH_TOKEN があれば警告は出ない（接続先の事実の行は出る）', () => {
    const out = lines({
      source: '袋',
      env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: FAKE_AUTH },
    });
    expect(warning(out)).toBeUndefined();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('送り先が変わっている');
  });

  it('API_KEY があれば警告は出ない', () => {
    const out = lines({
      source: '袋',
      env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_API_KEY: FAKE_API },
    });
    expect(warning(out)).toBeUndefined();
  });

  it('空白だけの AUTH_TOKEN は置かれていない扱いで、警告が出る', () => {
    const out = lines({
      source: '袋',
      env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: '   ' },
    });
    expect(warning(out)).toBeDefined();
  });

  it('BASE_URL が空白だけなら何も出ない', () => {
    expect(lines({ source: '器', env: { ANTHROPIC_BASE_URL: '  ' } })).toEqual([]);
  });

  it('何も無ければ空配列', () => {
    expect(lines({ source: '器', env: { PATH: '/bin' } })).toEqual([]);
    expect(ANTHROPIC_ROUTE_NONE_LINE).toContain('どれも置かれていない');
  });

  it('解析できない BASE_URL はその旨だけを出す', () => {
    const out = lines({ source: '器', env: { ANTHROPIC_BASE_URL: 'not a url sk-fake-leak' } });
    expect(warning(out)).toContain('解析できない値');
    expect(out.join('\n')).not.toContain('sk-fake-leak');
  });
});

describe('出所（後ろの層が勝つ）', () => {
  it('プロファイルが器を上書きしたら出所はプロファイル', () => {
    const inspection = inspectAnthropicRoute([
      { source: '器', env: { ANTHROPIC_BASE_URL: 'https://a.example.com' } },
      { source: 'プロファイル', env: { ANTHROPIC_BASE_URL: 'https://b.example.com' } },
    ]);
    expect(inspection.baseUrl).toEqual({ origin: 'https://b.example.com', source: 'プロファイル' });
  });

  it('後ろの層が空文字を置いたら前の値へ戻らない', () => {
    const inspection = inspectAnthropicRoute([
      { source: '器', env: { ANTHROPIC_BASE_URL: 'https://a.example.com' } },
      { source: '袋', env: { ANTHROPIC_BASE_URL: '' } },
    ]);
    expect(inspection.baseUrl).toBeUndefined();
  });

  it('鍵の出所は袋、後ろの層が勝つ', () => {
    const inspection = inspectAnthropicRoute([
      { source: '器', env: { ANTHROPIC_API_KEY: FAKE_API } },
      { source: '袋', env: { ANTHROPIC_API_KEY: FAKE_API } },
    ]);
    expect(inspection.endpointKeys).toEqual([{ name: 'ANTHROPIC_API_KEY', source: '袋' }]);
  });
});

describe('origin だけを出す', () => {
  it('userinfo・パス・クエリは出さない', () => {
    const out = lines({
      source: '器',
      env: {
        ANTHROPIC_BASE_URL:
          'https://user:sk-fake-pw@gw.example.com:8443/v1/path?key=sk-fake-q#frag',
      },
    });
    const text = out.join('\n');
    expect(text).toContain('https://gw.example.com:8443');
    for (const secret of ['user', 'sk-fake-pw', '/v1/path', 'sk-fake-q', 'frag']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('#4261 モデルの別名', () => {
  it('DEFAULT_*_MODEL を検出し、別名を小文字で出す', () => {
    const out = lines({
      source: 'プロファイル',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-x', ANTHROPIC_DEFAULT_SONNET_MODEL: ' ' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-x（出所: プロファイル）');
    expect(out[0]).toContain('別名 opus の行き先が変わっている');
    expect(out[0]).toContain('ALTEROID_*_MODEL の承認を通っていない');
  });

  it('ANTHROPIC_MODEL は既定モデルが変わる旨', () => {
    const out = lines({ source: '袋', env: { ANTHROPIC_MODEL: 'foo' } });
    expect(out[0]).toContain('Claude Code の既定モデルが変わっている');
  });

  it('DEFAULT_*_MODEL に合わない名前は拾わない', () => {
    const out = lines({
      source: '器',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'x',
        ANTHROPIC_DEFAULT_opus_MODEL: 'y',
        ALTEROID_CLONE_MODEL: 'z',
      },
    });
    expect(out).toEqual([]);
  });

  it('層をまたいで名前を集め、勝った層の値と出所を出す', () => {
    const inspection = inspectAnthropicRoute([
      { source: '器', env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'a' } },
      {
        source: '袋',
        env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'b', ANTHROPIC_DEFAULT_OPUS_MODEL: 'c' },
      },
    ]);
    expect(inspection.modelAliases).toEqual([
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'b', source: '袋' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'c', source: '袋' },
    ]);
  });
});

describe('秘密の値は出力にも検査結果にも無い', () => {
  it('鍵の値は行にも inspection にも載らない', () => {
    const layers = [
      {
        source: '器',
        env: {
          ANTHROPIC_BASE_URL: 'https://gw.example.com',
          ANTHROPIC_AUTH_TOKEN: FAKE_AUTH,
          ANTHROPIC_API_KEY: FAKE_API,
          CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'm',
        },
      },
    ];
    const inspection = inspectAnthropicRoute(layers);
    const noKey = inspectAnthropicRoute([
      { source: '器', env: { ...layers[0]?.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } },
    ]);
    const all = [
      JSON.stringify(inspection),
      JSON.stringify(noKey),
      ...describeAnthropicRoute(inspection),
      ...describeAnthropicRoute(noKey),
    ].join('\n');
    for (const secret of [FAKE_AUTH, FAKE_API, FAKE_OAUTH]) expect(all).not.toContain(secret);
    expect(warning(describeAnthropicRoute(noKey))).toContain('いま置かれている');
  });
});
