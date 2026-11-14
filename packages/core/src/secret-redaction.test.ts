import { describe, expect, it } from 'vitest';

import { buildCloneSystemPrompt } from './prompt.js';
import { createSecretRedactor } from './secret-redaction.js';

// ダミーの鍵。本物の鍵の形に似せるが、どこの鍵でもない（繰り返しで作る）
const GITHUB = `ghp_${'a1B2'.repeat(9)}`;
const INTEGRATION = `altk_${'x9Y8'.repeat(8)}`;
const ANTHROPIC = `sk-ant-api03-${'Zz9_-'.repeat(8)}`;
const OPENAI_ALNUM = `sk-${'q1W2e3R4'.repeat(6)}`;
// 既存の規則（英数40字以上）に当たらない形（`-` `_` を含む）。`sk-key` が拾う
const SK_WITH_SEPARATORS = `sk-${'q1W2-e3R_'.repeat(4)}`;
const AWS = 'AKIA' + 'ABCDEFGH12345678';
const BEARER = `Bearer ${'tok3n-'.repeat(6)}`;
const JWT = `eyJ${'hGciOiJI'.repeat(2)}.eyJ${'zdWIiOiIx'.repeat(2)}.${'sig-nature_'.repeat(2)}`;
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const redactorOf = (env: NodeJS.ProcessEnv = {}, known: readonly string[] = []) =>
  createSecretRedactor({ env, knownSecretEnvNames: known });

describe('秘密走査（createSecretRedactor）— 規則ごとに伏せて、名前と件数だけを控える', () => {
  const cases: readonly (readonly [rule: string, secret: string])[] = [
    ['github-token', GITHUB],
    ['integration-key', INTEGRATION],
    ['anthropic-key', ANTHROPIC],
    ['openai-key', OPENAI_ALNUM],
    ['sk-key', SK_WITH_SEPARATORS],
    ['aws-access-key', AWS],
    ['bearer-token', BEARER],
    ['jwt', JWT],
    ['private-key-pem', PEM],
  ];

  for (const [rule, secret] of cases) {
    it(`${rule}: 値が消え、[redacted:${rule}] が入り、件数だけが残る`, () => {
      const redactor = redactorOf();
      const out = redactor.redact(`前の文 ${secret} 後ろの文`);
      expect(out).not.toContain(secret);
      expect(out).toContain(`[redacted:${rule}]`);
      expect(out.startsWith('前の文 ')).toBe(true);
      expect(out.endsWith(' 後ろの文')).toBe(true);
      expect(redactor.hits()).toEqual([{ rule, count: 1 }]);
      expect(JSON.stringify(redactor.hits())).not.toContain(secret);
    });
  }

  it('GitHub のトークンは ghp_・gho_・ghs_・github_pat_ のどれも伏せる', () => {
    const redactor = redactorOf();
    const out = redactor.redact(
      [`gho_${'k'.repeat(36)}`, `ghs_${'m'.repeat(36)}`, `github_pat_${'n'.repeat(40)}`].join(' '),
    );
    expect(out).not.toMatch(/gho_k|ghs_m|github_pat_n/);
    expect(redactor.hits()).toEqual([
      { rule: 'github-pat', count: 1 },
      { rule: 'github-token', count: 2 },
    ]);
  });

  it('同じ規則の複数の当たりは件数に数える', () => {
    const redactor = redactorOf();
    redactor.redact(`${GITHUB} と ${GITHUB}`);
    redactor.redact(GITHUB);
    expect(redactor.hits()).toEqual([{ rule: 'github-token', count: 3 }]);
  });

  it('当たりが無ければ空（走査したが当たり0件。走査していないこととは呼び手が区別する）', () => {
    const redactor = redactorOf();
    expect(redactor.redact('ただの文章')).toBe('ただの文章');
    expect(redactor.hits()).toEqual([]);
  });
});

describe('秘密走査 — デーモン自身の秘密の環境変数の値（完全一致）', () => {
  const VALUE = 'dummy-secret-value-0123456789';

  it('名前に SECRET・TOKEN・KEY などが入る変数の値を伏せ、規則名は変数名だけになる', () => {
    const redactor = redactorOf({ ALTEROID_TEST_SECRET: VALUE });
    const out = redactor.redact(`値は ${VALUE} です`);
    expect(out).toBe('値は [redacted:env:ALTEROID_TEST_SECRET] です');
    expect(redactor.hits()).toEqual([{ rule: 'env:ALTEROID_TEST_SECRET', count: 1 }]);
    expect(JSON.stringify(redactor.hits())).not.toContain(VALUE);
  });

  it('名前が秘密らしくなくても、既知の秘密名（既存の一覧を呼び手が渡す）の値は伏せる', () => {
    const redactor = redactorOf({ ALTEROID_DATABASE_URL: VALUE }, ['ALTEROID_DATABASE_URL']);
    expect(redactor.redact(VALUE)).toBe('[redacted:env:ALTEROID_DATABASE_URL]');
  });

  it('秘密らしくない名前の変数の値は伏せない（環境を総なめにしない）', () => {
    const redactor = redactorOf({ SOME_PLAIN_SETTING: VALUE });
    expect(redactor.redact(VALUE)).toBe(VALUE);
    expect(redactor.hits()).toEqual([]);
  });

  it('短い値は走査しない（`on` や `3000` のような値が通常の文章を壊さない）', () => {
    const redactor = redactorOf({ ALTEROID_TEST_SECRET: 'short-value' });
    expect(redactor.redact('short-value')).toBe('short-value');
  });

  it('値の一部だけの一致は伏せない（完全一致の部分文字列だけを置き換える）', () => {
    const redactor = redactorOf({ ALTEROID_TEST_SECRET: VALUE });
    expect(redactor.redact(VALUE.slice(0, -4))).toBe(VALUE.slice(0, -4));
  });

  it('同じ値を持つ別の名前は先に見つけた名前で1回だけ数える', () => {
    const redactor = redactorOf({ A_SECRET: VALUE, B_TOKEN: VALUE });
    redactor.redact(VALUE);
    expect(redactor.hits()).toEqual([{ rule: 'env:A_SECRET', count: 1 }]);
  });

  it('別の値を含む値は長いほうから伏せて、断片を残さない', () => {
    const longer = `${VALUE}-with-a-tail`;
    const redactor = redactorOf({ A_SECRET: VALUE, B_SECRET: longer });
    const out = redactor.redact(longer);
    expect(out).toBe('[redacted:env:B_SECRET]');
  });
});

describe('秘密走査 — 通常の文章を壊さない', () => {
  const prose = [
    'Bearer authentication という言い方の説明',
    'task-based で risk-aware な進め方（sk- で始まる鍵の説明）',
    'integration key は altk_ ＋ 英数 の形（説明だけで値は無い）',
    '記憶の文書 premise / indexed / fact と、節の目次',
    'commit 0123456789abcdef0123456789abcdef01234567 は伏せない',
  ];

  for (const text of prose) {
    it(`変えない: ${text.slice(0, 24)}`, () => {
      const redactor = redactorOf();
      expect(redactor.redact(text)).toBe(text);
      expect(redactor.hits()).toEqual([]);
    });
  }

  it('クローンの既定のシステムプロンプトは1文字も変わらず、当たりも0件', () => {
    const prompt = buildCloneSystemPrompt({ memory: '' as never });
    const redactor = redactorOf({});
    expect(redactor.redact(prompt)).toBe(prompt);
    expect(redactor.hits()).toEqual([]);
  });
});

describe('秘密走査 — 入れ子の値を丸ごと走査する', () => {
  it('配列・オブジェクトの文字列とキーを走査し、文字列以外は変えない', () => {
    const redactor = redactorOf();
    const input = {
      name: 'tool',
      schema: { properties: { [GITHUB]: { description: `例: ${INTEGRATION}` } }, required: [1, true, null] },
      list: [ANTHROPIC, 3],
    };
    const out = redactor.redactDeep(input);
    const json = JSON.stringify(out);
    for (const secret of [GITHUB, INTEGRATION, ANTHROPIC]) expect(json).not.toContain(secret);
    expect(out.schema.required).toEqual([1, true, null]);
    expect(json).toContain('[redacted:github-token]');
    expect(json).toContain('[redacted:integration-key]');
    expect(json).toContain('[redacted:anthropic-key]');
    // 元の値は書き換えない
    expect(JSON.stringify(input)).toContain(GITHUB);
  });

  it('__proto__ という名前のキーを持つ値でも、プロトタイプを書き換えない', () => {
    const redactor = redactorOf();
    const parsed = JSON.parse('{"__proto__": {"polluted": "yes"}}') as unknown;
    const out = redactor.redactDeep(parsed) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(['__proto__']);
  });
});
