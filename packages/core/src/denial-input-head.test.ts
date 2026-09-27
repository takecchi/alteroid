import { describe, expect, it } from 'vitest';

import {
  buildDenialInputHead,
  DENIAL_INPUT_HEAD_LIMIT,
  matchInputOf,
} from './denial-input-head.js';

/**
 * `buildDenialInputHead`（拒否より前に見た入力の先頭。issue #1105）。
 *
 * **ここで使うトークンはすべてダミーである。** 本物の値では試さない
 * （AGENTS.md「秘密の扱い」）——`ghp_` 等の接頭辞は本物と同じ形だが、
 * 続く文字列は乱数でも実在のトークンでもない。
 */

const DUMMY_GHP_TOKEN = `ghp_${'1234567890abcdef1234567890abcdef1234'}`; // ghp_ + 36文字

describe('buildDenialInputHead / 入力を1行にする（command 優先・JSON へのフォールバック）', () => {
  it('command 欄が文字列ならそれを使う', () => {
    expect(buildDenialInputHead({ command: 'git status' }, undefined)).toBe('git status');
  });

  it('command 欄が無ければ JSON.stringify した1行にする（Edit 等）', () => {
    const head = buildDenialInputHead(
      { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      undefined,
    );
    expect(head).toBe('{"file_path":"a.ts","old_string":"x","new_string":"y"}');
  });

  it('入力が素の文字列でもそのまま使う', () => {
    expect(buildDenialInputHead('plain text input', undefined)).toBe('plain text input');
  });

  it('入力そのものが無い（undefined）→ undefined を返す', () => {
    expect(buildDenialInputHead(undefined, undefined)).toBe(undefined);
  });

  it('循環参照など JSON.stringify が例外を投げる形 → undefined を返す（測れなかった扱い）', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(buildDenialInputHead(circular, undefined)).toBe(undefined);
  });

  it('空のコマンドは「無い」ではなく空文字として返す', () => {
    expect(buildDenialInputHead({ command: '' }, undefined)).toBe('');
  });
});

describe('buildDenialInputHead / 既知のトークンの形を伏せる', () => {
  it('GitHub のトークン（ghp_ + 36文字のダミー）を伏せる', () => {
    const head = buildDenialInputHead(
      { command: `curl -H "Authorization: token ${DUMMY_GHP_TOKEN}" https://api.github.com` },
      undefined,
    );
    expect(head).not.toContain(DUMMY_GHP_TOKEN);
    expect(head).not.toContain('1234567890abcdef');
    expect(head).toContain('[REDACTED]');
  });

  it('github_pat_ 形式も伏せる', () => {
    const token = `github_pat_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
    const head = buildDenialInputHead({ command: `gh api -H "auth: ${token}"` }, undefined);
    expect(head).not.toContain(token);
    expect(head).toContain('[REDACTED]');
  });

  it('Anthropic の API 鍵の形（sk-ant-）を伏せる', () => {
    const token = `sk-ant-${'ab12cd34ef56'}`;
    const head = buildDenialInputHead({ command: `export KEY=${token}` }, undefined);
    expect(head).not.toContain('ab12cd34ef56');
    expect(head).toContain('[REDACTED]');
  });

  it('AWS のアクセスキー id（AKIA + 16桁）を伏せる', () => {
    const token = 'AKIAABCDEFGHIJKLMNOP'; // AKIA + 16桁の英大文字ダミー
    const head = buildDenialInputHead({ command: `aws configure set key ${token}` }, undefined);
    expect(head).not.toContain(token);
    expect(head).toContain('[REDACTED]');
  });

  it('Bearer トークンを伏せる', () => {
    const head = buildDenialInputHead(
      { command: 'curl -H "Authorization: Bearer abcdefghijklmnop0123456789"' },
      undefined,
    );
    expect(head).not.toContain('abcdefghijklmnop0123456789');
    expect(head).toContain('Bearer [REDACTED]');
  });

  it('git の SHA（40桁 hex）を伏せる（取りこぼしより誤伏せを選ぶ）', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'.slice(0, 40);
    const head = buildDenialInputHead({ command: `git show ${sha}` }, undefined);
    expect(head).not.toContain(sha);
    expect(head).toContain('[REDACTED]');
  });

  it('英数字混在24文字以上の塊は、既知の接頭辞が無くても伏せる', () => {
    const blob = 'aB3dE6fG9hJ2kL5mN8pQ1rS4t'; // 25文字、英数字混在
    const head = buildDenialInputHead({ command: `curl --data ${blob}` }, undefined);
    expect(head).not.toContain(blob);
    expect(head).toContain('[REDACTED]');
  });

  it('数字だけ・英字だけの短い塊は伏せない（塞げていないと doc に書いたとおり）', () => {
    const head = buildDenialInputHead({ command: 'echo hunter2' }, undefined);
    expect(head).toBe('echo hunter2');
  });
});

describe('buildDenialInputHead / 代入の形（NAME=value・JSON の "NAME":"value"）', () => {
  it('FOO_TOKEN=... 代入の値を伏せ、NAME= は残す', () => {
    const head = buildDenialInputHead(
      { command: 'FOO_TOKEN=abcdef0123456789 some-command --flag' },
      undefined,
    );
    expect(head).toContain('FOO_TOKEN=[REDACTED]');
    expect(head).not.toContain('abcdef0123456789');
    expect(head).toContain('some-command --flag');
  });

  it('秘密らしくない名前の代入は伏せない', () => {
    const head = buildDenialInputHead({ command: 'COUNT=42 echo done' }, undefined);
    expect(head).toBe('COUNT=42 echo done');
  });

  it('JSON の "NAME":"value" 形（command 以外の欄経由）も伏せる', () => {
    const head = buildDenialInputHead(
      { env_dump: { MY_SECRET_TOKEN: 'abcdef0123456789zzzz' } },
      undefined,
    );
    expect(head).not.toContain('abcdef0123456789zzzz');
    expect(head).toContain('[REDACTED]');
  });
});

describe('buildDenialInputHead / 環境変数の値による伏せ字', () => {
  it('秘密らしい名前・8文字以上の env の値を伏せる', () => {
    const head = buildDenialInputHead(
      { command: 'echo my-actual-secret-value' },
      { MY_APP_TOKEN: 'my-actual-secret-value' },
    );
    expect(head).not.toContain('my-actual-secret-value');
    expect(head).toContain('[REDACTED]');
  });

  it('秘密らしい名前でも8文字未満の値は伏せない（`redactEnvSecrets` の事故を避けるための下限）', () => {
    const head = buildDenialInputHead({ command: 'echo shortval' }, { MY_APP_TOKEN: 'short' });
    expect(head).toBe('echo shortval');
  });

  it('秘密らしくない名前の env は、値が長くても伏せない', () => {
    const head = buildDenialInputHead(
      { command: 'echo some-long-benign-value' },
      { MY_APP_NAME: 'some-long-benign-value' },
    );
    expect(head).toBe('echo some-long-benign-value');
  });

  it('env が undefined でも例外を投げない', () => {
    expect(() => buildDenialInputHead({ command: 'echo x' }, undefined)).not.toThrow();
  });

  it('process.env を丸ごと渡していない前提で、短い一般的な値（LANG=C 相当）は伏せない', () => {
    const head = buildDenialInputHead({ command: 'echo C' }, { LANG: 'C' });
    expect(head).toBe('echo C');
  });
});

describe('buildDenialInputHead / 伏せてから切る（境界にトークンが跨る例）', () => {
  it('160字の境界にトークンが跨っていても、断片が漏れない', () => {
    // トークンの一部（先頭 10 文字）がちょうど160字目の手前に来るように
    // 組む。**先に160字で切ってから伏せ字を当てると、切り取られた
    // 断片（`ghp_123456` のような20文字未満の残骸）は `gh[oprsu]_` の
    // 最小長条件（20文字以上）に届かず、そのまま出力へ漏れる。**
    // 「伏せてから切る」実装であれば、フルの入力に対して伏せ字が先に
    // 掛かるので、この断片は最初から存在しない。
    // **末尾は空白にする。** `\b`（正規表現の語境界）は「英数字/アンダース
    // コア」と「それ以外」の切り替わりでしか成立しない —— 直前の文字が
    // 英字の `a` のままだと `ghp_` の手前に境界が無く、伏せ字の正規表現が
    // 一度も一致しないまま素通りしてしまう（この落とし穴自体を踏まないよう、
    // 空白を1文字挟んで境界を作る）。
    const prefix = `${'a'.repeat(149)} `;
    const raw = `${prefix}${DUMMY_GHP_TOKEN}`;
    expect(prefix.length).toBe(150);
    expect(raw.length).toBeGreaterThan(DENIAL_INPUT_HEAD_LIMIT);

    const head = buildDenialInputHead({ command: raw }, undefined);

    expect(head).not.toContain('ghp_123456');
    expect(head).not.toContain('1234567890abcdef');
    expect(head).toContain('[REDACTED]');
    expect(head!.length).toBeLessThanOrEqual(DENIAL_INPUT_HEAD_LIMIT);
  });

  it('161字以上の、伏せ字を含まない入力は160字で切って印を付ける', () => {
    const raw = 'x'.repeat(200);
    const head = buildDenialInputHead({ command: raw }, undefined);
    expect(head).toBe(`${'x'.repeat(DENIAL_INPUT_HEAD_LIMIT)}…`);
  });

  /**
   * **絵文字の途中で切らない（#1606）。** 補助面の文字が160コード単位目をまたぐと、
   * `slice` のままでは高サロゲートだけが残る。切り口は1つ手前（159）へ寄る。
   */
  it('絵文字が160字目をまたいでも孤立サロゲートを残さない', () => {
    const head = buildDenialInputHead(
      { command: `${'a'.repeat(DENIAL_INPUT_HEAD_LIMIT - 1)}\u{1F600}${'b'.repeat(50)}` },
      undefined,
    );
    // `isWellFormed()` は tsconfig の lib（es2024 未満）に無いので、孤立サロゲートを直接探す。
    expect(head).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(head).toBe(`${'a'.repeat(DENIAL_INPUT_HEAD_LIMIT - 1)}…`);
  });

  it('160字ちょうどの入力は切らない（印を付けない）', () => {
    const raw = 'x'.repeat(DENIAL_INPUT_HEAD_LIMIT);
    const head = buildDenialInputHead({ command: raw }, undefined);
    expect(head).toBe(raw);
    expect(head).not.toContain('…');
  });
});

/**
 * `matchInputOf`（1回だけの許可の一致鍵。issue #1768）。
 *
 * **`rawLineOf` / `buildDenialInputHead` と違い、`command` だけを特別扱い
 * しない。** `command` を持つオブジェクトでも、`command` 以外の欄が一致鍵に
 * 反映されることが本体（issue #1768 が見つけた穴そのものの裏返し）。
 */
describe('matchInputOf / 一致鍵は入力全体を見る（issue #1768）', () => {
  it('command 欄だけの入力と、command 以外の欄も持つ入力は別の鍵になる', () => {
    const commandOnly = matchInputOf({ command: 'echo x' });
    const withExtra = matchInputOf({ command: 'echo x', run_in_background: true });
    expect(commandOnly).not.toEqual(withExtra);
  });

  it('run_in_background だけが違う入力は別の鍵になる（issue #1768 の「赤を取った例」）', () => {
    const foreground = matchInputOf({ command: 'echo x', run_in_background: false });
    const background = matchInputOf({ command: 'echo x', run_in_background: true });
    expect(foreground).not.toEqual(background);
  });

  it('dangerouslyDisableSandbox だけが違う入力は別の鍵になる（issue #1768 の「測っていないが同じ形」）', () => {
    const sandboxed = matchInputOf({ command: 'echo x', dangerouslyDisableSandbox: false });
    const unsandboxed = matchInputOf({ command: 'echo x', dangerouslyDisableSandbox: true });
    expect(sandboxed).not.toEqual(unsandboxed);
  });

  it('欄の並び順だけが違う、内容が同一の入力は同じ鍵になる（キー順に依らない）', () => {
    const a = matchInputOf({ command: 'echo x', run_in_background: false, timeout: 5000 });
    const b = matchInputOf({ timeout: 5000, command: 'echo x', run_in_background: false });
    expect(a).toEqual(b);
  });

  it('ネストしたオブジェクトのキー順も無視する', () => {
    const a = matchInputOf({ command: 'echo x', nested: { z: 1, a: 2 } });
    const b = matchInputOf({ nested: { a: 2, z: 1 }, command: 'echo x' });
    expect(a).toEqual(b);
  });

  it('配列の要素順序は変えない（順序を持つ値として扱う）', () => {
    const a = matchInputOf({ command: 'echo x', items: [1, 2] });
    const b = matchInputOf({ command: 'echo x', items: [2, 1] });
    expect(a).not.toEqual(b);
  });

  it('入力そのものが無い（undefined）→ undefined を返す', () => {
    expect(matchInputOf(undefined)).toBe(undefined);
  });

  it('循環参照など JSON.stringify が例外を投げる形 → undefined を返す（測れなかった扱い）', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(matchInputOf(circular)).toBe(undefined);
  });

  it('素の文字列はそのままキーの材料になる', () => {
    expect(matchInputOf('plain text input')).toBe(JSON.stringify('plain text input'));
  });

  it('同じ内容を2回渡すと同じ鍵になる（安定性）', () => {
    const input = { command: 'echo x', run_in_background: false };
    expect(matchInputOf(input)).toEqual(matchInputOf({ ...input }));
  });
});

/**
 * `__proto__` という名前の欄も、一致鍵に入れる（issue #1787）。
 *
 * `tool_input` は JSON から作られるので、`JSON.parse` が `__proto__` を
 * **自前の欄**として持たせうる。並べ替えの器へ普通の代入で詰めると、その欄は
 * 器のプロトタイプの書き換えに化けて `JSON.stringify` から消え、欄の有無も
 * 中身も鍵に反映されない（許しすぎる側）。
 */
describe('matchInputOf / __proto__ という名前の欄も鍵に入れる（issue #1787）', () => {
  const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;

  it('__proto__ 欄の有無だけが違う入力は別の鍵になる', () => {
    const bare = parse('{"command":"echo x"}');
    const withProto = parse('{"command":"echo x","__proto__":{"dangerouslyDisableSandbox":true}}');
    expect(Object.keys(withProto)).toContain('__proto__');
    expect(matchInputOf(bare)).not.toEqual(matchInputOf(withProto));
  });

  it('__proto__ の中身だけが違う入力は別の鍵になる', () => {
    const a = parse('{"command":"echo x","__proto__":{"dangerouslyDisableSandbox":true}}');
    const b = parse('{"command":"echo x","__proto__":{"run_in_background":true}}');
    expect(matchInputOf(a)).not.toEqual(matchInputOf(b));
  });

  it('ネストした __proto__ 欄も鍵に入る', () => {
    const a = parse('{"command":"echo x","nested":{"__proto__":{"x":1}}}');
    const b = parse('{"command":"echo x","nested":{}}');
    expect(matchInputOf(a)).not.toEqual(matchInputOf(b));
  });

  it('対照: __proto__ 欄を含めて同一の入力は、キー順が違っても同じ鍵になる', () => {
    const a = parse('{"command":"echo x","__proto__":{"b":1,"a":2}}');
    const b = parse('{"__proto__":{"a":2,"b":1},"command":"echo x"}');
    expect(matchInputOf(a)).toEqual(matchInputOf(b));
  });
});
