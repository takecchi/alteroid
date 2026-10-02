import { describe, expect, it } from 'vitest';

import {
  buildDenialInputHead,
  DENIAL_INPUT_HEAD_LIMIT,
  matchInputOf,
  redactErrorText,
  redactSecretsInText,
} from './denial-input-head.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

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

describe('buildDenialInputHead / URL の userinfo に入った資格を伏せる（issue #2375）', () => {
  // 値はすべて偽である。
  it('postgres://user:pass@host の pass を伏せ、user と host は残す', () => {
    const head = buildDenialInputHead(
      { command: 'psql postgres://app:FAKEPASS@db.internal:5432/app' },
      undefined,
    );
    expect(head).not.toContain('FAKEPASS');
    expect(head).toBe('psql postgres://app:[REDACTED]@db.internal:5432/app');
  });

  it('user が空（redis://:pass@host）でも pass を伏せる', () => {
    const head = buildDenialInputHead(
      { command: 'redis-cli -u redis://:FAKEPASS@host' },
      undefined,
    );
    expect(head).not.toContain('FAKEPASS');
    expect(head).toBe('redis-cli -u redis://:[REDACTED]@host');
  });

  it('パスワードの無い scheme://token@host の token を伏せる', () => {
    const head = buildDenialInputHead(
      { command: 'git clone https://FAKETOKEN@github.com/o/r.git' },
      undefined,
    );
    expect(head).not.toContain('FAKETOKEN');
    expect(head).toBe('git clone https://[REDACTED]@github.com/o/r.git');
  });

  it('パーセント符号化されたパスワード（amqp://u:p%40ss@h）を伏せる', () => {
    const head = buildDenialInputHead({ command: 'x amqp://u:p%40ss@h' }, undefined);
    expect(head).not.toContain('p%40ss');
    expect(head).toBe('x amqp://u:[REDACTED]@h');
  });

  it('パスワードに生の @ が入っていても、最後の @ までを伏せる', () => {
    const head = buildDenialInputHead({ command: 'x postgres://u:FAKE@PASS@h/db' }, undefined);
    expect(head).not.toContain('FAKE');
    expect(head).not.toContain('PASS@');
    expect(head).toBe('x postgres://u:[REDACTED]@h/db');
  });

  it('JSON の1行に埋まった URL も伏せる', () => {
    const head = buildDenialInputHead({ url: 'postgres://app:FAKEPASS@db/app' }, undefined);
    expect(head).not.toContain('FAKEPASS');
  });

  it('対照: 資格の無い URL はそのまま残す', () => {
    for (const command of [
      'curl https://example.com/path',
      'curl http://localhost:3000',
      'curl http://localhost:3000/a?page=2',
      'curl https://example.com/a@b',
    ]) {
      expect(buildDenialInputHead({ command }, undefined)).toBe(command);
    }
  });

  it('対照: ssh://git@host の git は秘密ではないので残す（scp 形式も同じ）', () => {
    for (const command of [
      'git clone ssh://git@example.com/repo.git',
      'git clone git@example.com:o/r.git',
    ]) {
      expect(buildDenialInputHead({ command }, undefined)).toBe(command);
    }
  });

  it('対照: 既存の伏せ字（代入・Bearer）は今までどおり効く', () => {
    const head = buildDenialInputHead(
      { command: 'FOO_TOKEN=abcdef0123456789 curl -H "Authorization: Bearer abcdefgh12345678"' },
      undefined,
    );
    expect(head).toContain('FOO_TOKEN=[REDACTED]');
    expect(head).toContain('Bearer [REDACTED]');
  });

  it('境界: 160字目がパスワードの途中で切れても、切れ端が出ない（伏せてから切る）', () => {
    // `postgres://app:` は15字。URL を140字目から始めると、160字目は
    // パスワード `FAKEPASS` の5字目（`FAKEP`）の直後に当たる。
    // 先に切ってから伏せると、切れ端 `FAKEP` は userinfo の形を失い残る。
    const prefix = `${'a'.repeat(139)} `;
    const raw = `${prefix}postgres://app:FAKEPASS@db.internal:5432/app`;
    expect(prefix.length).toBe(140);
    expect(raw.slice(0, DENIAL_INPUT_HEAD_LIMIT).endsWith('postgres://app:FAKEP')).toBe(true);

    const head = buildDenialInputHead({ command: raw }, undefined);

    expect(head).not.toContain('FAKEP');
    // 伏せた後の文字列を160字で切るので、切り口は `[REDACTED]` の途中に来る。
    expect(head).toContain('postgres://app:[REDA');
    expect(head).not.toContain('PASS');
    expect(head!.length).toBeLessThanOrEqual(DENIAL_INPUT_HEAD_LIMIT + 1);
  });

  // 伏せ字は切る前の全文にかかる。`.` `-` で区切られた長い連なり（ミニファイされた
  // コード等）で、scheme の走査が語の境目ごとに末尾まで読むと2乗になる。
  it('`.` で区切られた長い連なりでも、入力の長さに比例して終わる', () => {
    expectNotSuperlinear(
      (command: string) => buildDenialInputHead({ command }, undefined),
      (n) => `x ${'a.'.repeat(n)}b`,
      { n: 2000 },
    );
  });
});

describe('buildDenialInputHead / scheme の無い形の資格を伏せる（issue #2383）', () => {
  // 値はすべて偽である。
  it('user:pass@host:port（接続文字列の一部）の pass を伏せ、user と host は残す', () => {
    const head = buildDenialInputHead({ command: 'user:FAKEPASS@db.internal:5432' }, undefined);
    expect(head).not.toContain('FAKEPASS');
    expect(head).toBe('user:[REDACTED]@db.internal:5432');
  });

  it('//user:pass@host（scheme を省いた URL）の pass を伏せる', () => {
    const head = buildDenialInputHead({ command: 'curl //user:FAKEPASS@host/path' }, undefined);
    expect(head).not.toContain('FAKEPASS');
    expect(head).toBe('curl //user:[REDACTED]@host/path');
  });

  it('コマンドに埋まった形（引用符の中・= の右・JSON の1行）も伏せる', () => {
    for (const command of [
      'psql "host=x user:FAKEPASS@db.internal:5432"',
      "mysql --uri='app:FAKEPASS@db.internal:3306'",
      'DB=app:FAKEPASS@db.internal:3306 run',
    ]) {
      expect(buildDenialInputHead({ command }, undefined)).not.toContain('FAKEPASS');
    }
    expect(buildDenialInputHead({ dsn: 'app:FAKEPASS@db.internal:3306' }, undefined)).not.toContain(
      'FAKEPASS',
    );
  });

  it('scheme のある形を伏せた結果と、二重に伏せても変わらない', () => {
    const head = buildDenialInputHead({ command: 'x postgres://app:FAKEPASS@db/app' }, undefined);
    expect(head).toBe('x postgres://app:[REDACTED]@db/app');
  });

  it('対照: scp 形式・ssh の宛先・メールアドレスは残す', () => {
    for (const command of [
      'git clone git@github.com:o/r.git',
      'ssh user@host',
      'ssh -p 22 deploy@host.example.com uptime',
      'mail alice@example.com',
      'git remote add origin git@github.com:o/r.git',
    ]) {
      expect(buildDenialInputHead({ command }, undefined)).toBe(command);
    }
  });

  it('対照: host:port・時刻・mailto・ホスト名が1文字の a:b@c は残す', () => {
    for (const command of [
      'curl localhost:5432',
      'nc db.internal:5432',
      'date -d 12:34',
      'at 12:34@home',
      'echo 12:34:56@host',
      'open mailto:alice@example.com',
      'echo a:b@c',
      'echo a:b@',
      'echo :@host',
    ]) {
      expect(buildDenialInputHead({ command }, undefined)).toBe(command);
    }
  });

  // 伏せ字は切る前の全文にかかる。scheme が無いのでどこからでも走り出しうる。
  // 以下は、走り出す位置の絞り（手前が語の頭）と長さの上限が無いと2乗になる形。
  const linear = (make: (n: number) => string) =>
    expectNotSuperlinear((command: string) => buildDenialInputHead({ command }, undefined), make, {
      n: 2000,
    });

  it('`a:` の長い繰り返しでも、入力の長さに比例して終わる', () => {
    linear((n) => `x ${'a:'.repeat(n)}b`);
  });

  it('`pass` に使える記号で区切られた `a:` の連なり（語の頭が続く形）でも、入力の長さに比例して終わる', () => {
    // `a:,a:,a:,…`: どの `a` も語の頭なので走り出せ、`pass` は `,` も `:` も読める。
    linear((n) => `${'a:,'.repeat(n)}b`);
    linear((n) => `${'a:!'.repeat(n)}b`);
  });

  it('`@` の多い長い文字列でも、入力の長さに比例して終わる', () => {
    linear((n) => `u:p${'@'.repeat(n)}`);
    linear((n) => `${'a@'.repeat(n)}b`);
    // どの `@` の後ろもホスト名が続かない形（`a:@a:@…`）。
    linear((n) => `${'a:@'.repeat(n)}`);
  });

  it('`:` と `@` が交互に来る長い文字列でも、入力の長さに比例して終わる', () => {
    linear((n) => `${'a:b@'.repeat(n)}c`);
    linear((n) => `${':@'.repeat(n)}`);
  });

  it('`.` で区切られた長い連なり（ユーザー名の位置）でも、入力の長さに比例して終わる', () => {
    linear((n) => `x ${'a.'.repeat(n)}:b`);
    linear((n) => `x ${'a.'.repeat(n)}:${'p'.repeat(n)}`);
  });
});

// 値はすべて偽である。
describe('redactSecretsInText / redactErrorText（issue #2415）', () => {
  it('redactSecretsInText は buildDenialInputHead と同じ伏せ字（切らない）', () => {
    const text = `x postgres://app:FAKE_SECRET_VALUE_2415B@db.internal/app ${'y'.repeat(300)}`;
    const out = redactSecretsInText(text, undefined);
    expect(out).toBe(`x postgres://app:[REDACTED]@db.internal/app ${'y'.repeat(300)}`);
  });

  it('redactSecretsInText は params: を落とさない（道具の入力の契約を変えない）', () => {
    expect(redactSecretsInText('params: a,b', undefined)).toBe('params: a,b');
  });

  it('env の秘密らしい名前の値を伏せる', () => {
    const env = { MY_API_TOKEN: 'FAKE_SECRET_VALUE_2415B', LANG: 'C.UTF-8' };
    expect(redactErrorText('failed with FAKE_SECRET_VALUE_2415B', env)).toBe(
      'failed with [REDACTED]',
    );
  });

  it('drizzle の形: params: 以降を落とし、SQL 文は残し、落とした印を残す', () => {
    const text =
      'Failed query: insert into "t" ("a") values ($1)\nparams: hunter2,FAKE_SECRET_VALUE_2415B';
    expect(redactErrorText(text, undefined)).toBe(
      'Failed query: insert into "t" ("a") values ($1)\nparams: [REDACTED]',
    );
  });

  it('params: が同じ行に続く形も落とす', () => {
    const out = redactErrorText(
      'Failed query: select 1 params: FAKE_SECRET_VALUE_2415B',
      undefined,
    );
    expect(out).toBe('Failed query: select 1 params: [REDACTED]');
  });

  it('params: の無い文は、伏せ字以外を変えない', () => {
    expect(redactErrorText('connect ECONNREFUSED 127.0.0.1:5432', undefined)).toBe(
      'connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('URL の資格と Bearer は伏せ、host は残す', () => {
    const out = redactErrorText(
      'connect postgres://u:FAKE_SECRET_VALUE_2415B@db.internal:5432/x; Authorization: Bearer FAKE_SECRET_VALUE_2415B',
      undefined,
    );
    expect(out).not.toContain('FAKE_SECRET_VALUE_2415B');
    expect(out).toContain('db.internal:5432');
  });

  // 伏せ字は長い入力の全文にかかる。`params:` の規則も2乗にしない。
  const linear = (make: (n: number) => string) =>
    expectNotSuperlinear((text: string) => redactErrorText(text, undefined), make, { n: 2000 });

  it('`params:` の長い繰り返しでも、入力の長さに比例して終わる', () => {
    linear((n) => `x ${'params:'.repeat(n)}`);
    linear((n) => `${'params: a\n'.repeat(n)}`);
    linear((n) => `${'params'.repeat(n)}`);
    linear((n) => `${'xparams:'.repeat(n)}`);
  });

  it('`params:` の後ろが長い・改行が多い入力でも、入力の長さに比例して終わる', () => {
    linear((n) => `Failed query: select 1\nparams: ${'a,'.repeat(n)}`);
    linear((n) => `params:${'\n'.repeat(n)}`);
  });

  it('URL の資格・トークンの規則を通る長い入力でも、入力の長さに比例して終わる', () => {
    linear((n) => `x ${'a.'.repeat(n)}b`);
    linear((n) => `${'a:b@'.repeat(n)}c`);
    linear((n) => `${'Bearer '.repeat(n)}`);
  });
});

describe('CODEX_API_KEY の伏せ字（Issue #486 M7 段 S5。名前の規則は広げていない）', () => {
  const key = 'FAKE_CODEX_KEY_VALUE_486S5';

  it('器の env の CODEX_API_KEY の値は、既存の名前の規則（KEY）で伏せられる', () => {
    expect(redactErrorText(`401 with ${key}`, { CODEX_API_KEY: key })).toBe('401 with [REDACTED]');
  });

  it('CODEX_API_KEY=... の代入の形も、既存の規則で伏せられる', () => {
    const out = redactErrorText(`CODEX_API_KEY=${key} codex exec`, undefined);
    expect(out).not.toContain(key);
    expect(out).toContain('CODEX_API_KEY=[REDACTED]');
  });

  it('規則は広がっていない: 秘密らしい語を含まない Codex 関連の名前（CODEX_HOME）は伏せない', () => {
    const home = '/home/worker/.codex-state';
    expect(redactErrorText(`using ${home}`, { CODEX_HOME: home })).toBe(`using ${home}`);
  });
});
