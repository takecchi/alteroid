/**
 * `railway/setup.sh` が置く変数の**割り振り**を固定する。
 *
 * ここで見ているのは「Railway に繋がるか」ではない（それは人間が一度やれば分かる）。
 * **役ごとにどの鍵が渡るか**である。ここが静かにずれると、コンテナに割った意味が
 * 消えるのに、動作は正常に見える — つまり気づく場所が他に無い。
 *
 * 偽の `railway` を PATH の先に置いて、スクリプトが投げたはずの GraphQL の入力を
 * 拾って突き合わせる。ネットワークにも本物の Railway にも触らない
 * （偽 CLI と足場は `railway/cli-stub.ts`。**`scale-runners.sh` のテストと共有する**）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { childEnv, RAILWAY_DIR, type Run, runScript } from './cli-stub.js';

type Options = {
  /** `railway domain` をこけさせる */
  domainFails?: boolean;
  /** 新しい Service に既に繋がっているドメイン（JSON 文字列） */
  domainList?: string;
  /** 非0終了を期待する（既定では非0なら stderr 付きで落とす） */
  allowFailure?: boolean;
  /** 実行後の `.env` を読みたいとき */
  onEnvFile?: (path: string) => void;
  /** runner の台数（`-c`）。既定は渡さない＝1台 */
  runners?: number;
};

/** `.env` を1つ書いて setup.sh を通し、投げられた入力と終了状態を返す。 */
function run(env: string, options: Options = {}): Run {
  return runScript({
    script: 'setup.sh',
    args: [
      '--yes',
      '--name',
      'test',
      '--repo',
      'takecchi/alteroid',
      '--branch',
      'main',
      ...(options.runners === undefined ? [] : ['--runners', String(options.runners)]),
    ],
    envFile: env,
    extraEnv: {
      ...(options.domainFails ? { FAKE_DOMAIN_FAILS: '1' } : {}),
      ...(options.domainList ? { FAKE_DOMAIN_LIST: options.domainList } : {}),
    },
    allowFailure: options.allowFailure,
    onEnvFile: options.onEnvFile,
  });
}

const MINIMAL = ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-test', 'ALTEROID_RUNNER_TOKEN=deadbeef', ''].join(
  '\n',
);

describe('シェルスクリプトの書き方', () => {
  // **数え上げの持ち主は `railway/` そのものである。** 名前を書き並べると、
  // スクリプトを1つ足した回だけ静かに素通りする（実際 lib.sh と scale-runners.sh を
  // 足したとき、この行を直さなければ2本が見張りの外に出ていた）
  const scripts = readdirSync(RAILWAY_DIR).filter((f) => f.endsWith('.sh'));

  it('数えるスクリプトが1本も無い、にならない', () => {
    // 上の filter が空を返しても `it.each` は「0件成功」で緑になる（空振りの合格）
    expect(scripts.length).toBeGreaterThanOrEqual(4);
  });

  // macOS の bash 3.2 は、変数参照の直後に全角文字が続くとそのバイトを**変数名に
  // 取り込む**（`"${ENV_FILE}（…"` を `ENV_FILE（` という名前として読む）。`set -u` の
  // 下では起動直後に unbound variable で死ぬ。日本語のメッセージを書き足すたびに
  // 踏むので、目で見張るのをやめてここで止める
  it.each(scripts)('%s: 変数参照の直後に全角文字を置かない', (name) => {
    const source = readFileSync(join(RAILWAY_DIR, name), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      // eslint-disable-next-line no-control-regex
      .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
      .map(({ line, no }) => `${name}:${no}: ${line.trim()}`);
    // ${VAR} と書けば直る
    expect(offenders).toEqual([]);
  });
});

describe('テスト自身が setup.sh に渡す環境', () => {
  // ここが緩むと、下の全部が「走らせた人のシェル次第」になる。しかも緩んだことは
  // **落ちたときの差分に本物の鍵が出る**か、**空振りで緑になる**かでしか現れない
  it('親のシェルからは PATH しか渡さない', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        // 以下はすべて偽物である（本物を書かないこと。落ちれば出力に出る）
        GH_TOKEN: 'inherited-must-not-reach-setup',
        CLAUDE_CODE_OAUTH_TOKEN: 'inherited-must-not-reach-setup',
        ALTEROID_RUNNER_TOKEN: 'inherited-must-not-reach-setup',
        // 鍵でなくても、これらは投入先の Service 名や偽 CLI の挙動を書き換える
        ALTEROID_APP_SERVICE: 'renamed',
        ALTEROID_ENV_FILE: '/somewhere/else/.env',
        FAKE_DOMAIN_FAILS: '1',
      },
      '/tmp/bin',
      { FAKE_STATE: '/tmp/state' },
    );
    expect(Object.keys(env).sort()).toEqual(['FAKE_STATE', 'PATH']);
    expect(env.PATH).toBe('/tmp/bin:/usr/bin');
  });
});

describe('setup.sh が置く変数の割り振り', () => {
  let r: Run;
  beforeAll(() => {
    r = run(
      [
        MINIMAL,
        'GH_TOKEN=github_pat_test',
        'GIT_AUTHOR_NAME=tester',
        'GIT_AUTHOR_EMAIL=t@example.com',
        '',
      ].join('\n'),
    );
  });

  it('記憶ストアの鍵は app にだけ渡る', () => {
    // 渡した瞬間、runner の中の子プロセス（＝マネージャー）が /proc/1/environ から
    // 鍵を取れる状態に戻り、器を分けた意味が消える
    expect(r.vars('id-app').ALTEROID_DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
    expect(r.vars('id-runner')).not.toHaveProperty('ALTEROID_DATABASE_URL');
  });

  it('RAILWAY_RUN_UID=0 は runner にだけ渡る', () => {
    // runner は子プロセスを uid 1001 へ降ろすのに特権が要る。app は root で起きても
    // 自分で node へ降りるので、渡す理由が無い
    expect(r.vars('id-runner').RAILWAY_RUN_UID).toBe('0');
    expect(r.vars('id-app')).not.toHaveProperty('RAILWAY_RUN_UID');
  });

  it('ブラウザから叩いてよいオリジンは app にだけ渡る', () => {
    // 読むのはデーモンだけである（apps/daemon/src/index.ts）。runner は1度も見ない。
    // **デーモンのコードの既定は閉じたままで**（docs/architecture.md「CORS は既定で
    // 閉じている」）、開けたことは Service 変数と .env の両方に残る
    expect(r.vars('id-app').ALTEROID_ALLOWED_ORIGINS).toBe('https://alteroid.vercel.app');
    expect(r.vars('id-runner')).not.toHaveProperty('ALTEROID_ALLOWED_ORIGINS');
  });

  it('答えは .env に書き留める（次の実行で尋ね直さない）', () => {
    let written = '';
    run(MINIMAL, { onEnvFile: (path) => (written = readFileSync(path, 'utf8')) });

    expect(written).toContain('ALTEROID_ALLOWED_ORIGINS=https://alteroid.vercel.app');
  });

  it('.env に在ればそれを使う（既定で上書きしない）', () => {
    const mine = run([MINIMAL, 'ALTEROID_ALLOWED_ORIGINS=https://mine.example', ''].join('\n'));

    expect(mine.vars('id-app').ALTEROID_ALLOWED_ORIGINS).toBe('https://mine.example');
    // 既定を足さない。足すと、置いた列挙から公式のオリジンを消せなくなる
    expect(mine.vars('id-app').ALTEROID_ALLOWED_ORIGINS).not.toContain('vercel.app');
  });

  it('公式のオリジンを書き写さない（lib.sh の1か所だけが持つ）', () => {
    // 書き写すと、ホスト名が変わったときに片方だけが古びる。**気づく場所が他に無い**
    const holders = readdirSync(RAILWAY_DIR)
      .filter((f) => f.endsWith('.sh'))
      .filter((f) =>
        readFileSync(join(RAILWAY_DIR, f), 'utf8').includes('https://alteroid.vercel.app'),
      );

    expect(holders).toEqual(['lib.sh']);
  });

  it('合鍵は同じ値が両方へ渡り、sha256 は人間に置かせない', () => {
    const app = r.vars('id-app');
    const runner = r.vars('id-runner');
    expect(runner.ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
    expect(app.ALTEROID_RUNNER_TOKEN).toBe(runner.ALTEROID_RUNNER_TOKEN);
    // 畳むのは器の仕事（docker/alteroid-runner）。人間に二重管理をさせない
    expect(runner).not.toHaveProperty('ALTEROID_RUNNER_TOKEN_SHA256');
  });

  it('GH_TOKEN と身元は両方へ渡る（下へ手を伸ばす鍵は伏せない）', () => {
    // 伏せるのは上＝記憶へ到達する鍵だけである。これを伏せると、人間が Claude Code で
    // できる gh pr create が層を下りた瞬間に消える＝デグレード
    for (const id of ['id-app', 'id-runner']) {
      const v = r.vars(id);
      expect(v.GH_TOKEN).toBe('github_pat_test');
      expect(v.GIT_AUTHOR_NAME).toBe('tester');
      expect(v.GIT_COMMITTER_EMAIL).toBe('t@example.com');
    }
  });

  it('委譲の宛先は literal の参照のまま届く（シェルに展開させない）', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URL).toBe(
      'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
    );
    // Railway の private network は IPv6。既定の 127.0.0.1 のままだと daemon から届かない
    expect(r.vars('id-runner').ALTEROID_RUNNER_BIND).toBe('::');
  });

  it('待ち受けを開けない（叩けばクローンのターンが起きる口を無認証で外に出さない）', () => {
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_BIND');
    expect(r.calls.some((c) => c.startsWith('domain'))).toBe(false);
  });

  it('変数名に空白が混ざらない（ダッシュボード貼り付けの罠）', () => {
    const names = [...Object.keys(r.vars('id-app')), ...Object.keys(r.vars('id-runner'))];
    expect(names.filter((n) => n !== n.trim())).toEqual([]);
  });

  it('追記であって置き換えではなく、デプロイは自分で起こす', () => {
    for (const id of ['id-app', 'id-runner']) {
      expect(r.upsert(id).replace).toBe(false);
      expect(r.upsert(id).skipDeploys).toBe(true);
    }
  });

  it('秘密を引数で渡さない（プロセス一覧に出る）', () => {
    expect(r.apiLog).not.toContain('sk-ant-test');
    expect(r.apiLog).not.toContain('github_pat_test');
  });
});

describe('runner を3台で作るとき（-c 3）', () => {
  let r: Run;
  beforeAll(() => {
    r = run([MINIMAL, 'GH_TOKEN=github_pat_test', ''].join('\n'), { runners: 3 });
  });

  it('runner_id が台ごとに違う', () => {
    // **同じ id が2台に載ると sticky routing が黙って壊れる。**
    // 台帳の `manager_id → runner_id` を引く `RunnerRegistry#get` は線形一致で
    // 先に見つかった方を返すので、`manager_send` が別の器へ届く（`select({runnerId})`
    // だけは「一意でない」と拒むが、send / abort / transcript / restore は get を通る）。
    // 名簿は重複を検出しないので、症状は「たまに噛み合わない」だけになる
    const ids = ['id-runner', 'id-runner-2', 'id-runner-3'].map(
      (id) => r.vars(id).ALTEROID_RUNNER_ID,
    );
    expect(ids).toEqual(['runner-primary', 'runner-2', 'runner-3']);
    expect(new Set(ids).size).toBe(3);
  });

  it('1台目の名前は変えない（台帳が指しているのはこれである）', () => {
    // Service 名 `runner` / runner_id `runner-primary` は既に動いているものの名前で、
    // 変えると走行中のマネージャーへの経路が切れる
    expect(r.vars('id-runner').ALTEROID_RUNNER_ID).toBe('runner-primary');
  });

  it('委譲の宛先は3台ぶん並び、単数形は置かない', () => {
    const app = r.vars('id-app');
    expect(app.ALTEROID_RUNNER_URLS).toBe(
      [
        'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
        'http://${{runner-3.RAILWAY_PRIVATE_DOMAIN}}:4518',
      ].join(','),
    );
    // 同じことを言う変数を2つ置かない（デーモンは両方読むので害は無いが、
    // 2か所あると片方だけ直した回に食い違う）
    expect(app).not.toHaveProperty('ALTEROID_RUNNER_URL');
  });

  it('app には runner_id を置かない（どの1台か書けない）', () => {
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_RUNNER_ID');
  });

  it('境界の割り振りは台数が増えても変わらない', () => {
    for (const id of ['id-runner', 'id-runner-2', 'id-runner-3']) {
      // 記憶ストアの鍵は1台にも渡らない
      expect(r.vars(id)).not.toHaveProperty('ALTEROID_DATABASE_URL');
      // 子プロセスを uid 1001 へ降ろすのに特権が要る
      expect(r.vars(id).RAILWAY_RUN_UID).toBe('0');
      // 合鍵は全台で同じ（食い違うと 401 で unusable になる）
      expect(r.vars(id).ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
      // 下＝外の世界へ手を伸ばす鍵は伏せない
      expect(r.vars(id).GH_TOKEN).toBe('github_pat_test');
    }
    expect(r.vars('id-app')).not.toHaveProperty('RAILWAY_RUN_UID');
  });

  it('3台とも Config as Code を指す（指さないと役が決まらない）', () => {
    // 同じイメージから2役を出しているので、これが無い Service は startCommand を持たない
    const configured = r.calls.filter((c) => c.startsWith('api mutation($serviceId'));
    expect(configured).toHaveLength(4); // app + runner × 3
  });

  it('3台とも app より先に繋ぐ', () => {
    // 1台でも後回しにすると、デーモンが起きたときその宛先だけ不在から始まる
    const at = (name: string): number =>
      r.calls.findIndex((c) => c.includes('source connect') && c.includes(`--service ${name}`));
    const app = at('app');
    for (const name of ['runner', 'runner-2', 'runner-3']) {
      expect(at(name)).toBeGreaterThanOrEqual(0);
      expect(at(name)).toBeLessThan(app);
    }
  });

  it('台数が0や文字では作らない', () => {
    for (const bad of ['0', 'two', '-1']) {
      const bogus = run(MINIMAL, { runners: bad as unknown as number, allowFailure: true });
      expect(bogus.exitCode).not.toBe(0);
    }
  });
});

describe('setup.sh の順番', () => {
  let r: Run;
  beforeAll(() => {
    r = run(MINIMAL);
  });

  const index = (pred: (c: string) => boolean): number => r.calls.findIndex(pred);

  it('役の設定を役ごとに写す', () => {
    // **かつては「ファイルのパスを指す」だけだった**（Config as Code）。Railway が
    // サーバ側で廃止したので、いまは中身を写す（lib.sh の `set_config_file`）。
    // だから固定するのも「daemon.json を指したか」ではなく「役が決まったか」である —
    // 同じイメージから2役を出しているので、`startCommand` が役そのものである
    expect(r.apiLog).toContain('"startCommand":"alteroidd"');
    expect(r.apiLog).toContain('"startCommand":"alteroid-runner"');
    // パスを渡すと mutation ごと落ちる（INTERNAL_SERVER_ERROR / deprecated）
    expect(r.apiLog).not.toContain('railwayConfigFile');
  });

  it('変数と Config as Code は source を繋ぐ前に置く', () => {
    // 繋いだ瞬間にデプロイが走りうるので、後から置くと初回が必ず失敗する
    const connect = index((c) => c.includes('source connect'));
    expect(index((c) => c.startsWith('api mutation($serviceId'))).toBeLessThan(connect);
    expect(index((c) => c.includes('VariableCollectionUpsert'))).toBeLessThan(connect);
  });

  it('runner を app より先に繋ぐ', () => {
    // daemon は起動時に runner の /health へ名乗りを聞きに行く
    const runner = index((c) => c.includes('source connect') && c.includes('--service runner'));
    const app = index((c) => c.includes('source connect') && c.includes('--service app'));
    expect(runner).toBeGreaterThanOrEqual(0);
    expect(runner).toBeLessThan(app);
  });

  it('ボリュームを作らない（記憶は PostgreSQL、workspace は Git 再構築）', () => {
    expect(r.calls.some((c) => c.includes('volume'))).toBe(false);
  });

  it('Service の指定を省かない（省くと最後に作ったものへ黙って向く）', () => {
    const risky = r.calls.filter(
      (c) => /^(variable|up|deployment|domain)\b/.test(c) && !c.includes('--service'),
    );
    expect(risky).toEqual([]);
  });
});

describe('Google ログインを有効にしたとき', () => {
  let r: Run;
  beforeAll(() => {
    r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        '',
      ].join('\n'),
    );
  });

  it('鍵とドメインは app にだけ渡り、待ち受けが開く', () => {
    const app = r.vars('id-app');
    expect(app.ALTEROID_GOOGLE_CLIENT_ID).toBe('xxx.apps.googleusercontent.com');
    expect(app.ALTEROID_PUBLIC_URL).toBe('https://test-app.up.railway.app');
    // 手前に境界（ログイン）が立ってから開ける
    expect(app.ALTEROID_BIND).toBe('::');
    expect(app.ALTEROID_PORT).toBe('4517');
  });

  it('runner には入口の認証の鍵を渡さない', () => {
    // 渡すと、その中のマネージャーが自分でアクセストークンを発行して記憶へ届く
    const runner = r.vars('id-runner');
    expect(runner).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(runner).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    expect(runner).not.toHaveProperty('ALTEROID_PUBLIC_URL');
  });

  it('境界の割り振りは Google を有効にしても変わらない', () => {
    expect(r.vars('id-runner')).not.toHaveProperty('ALTEROID_DATABASE_URL');
    expect(r.vars('id-runner').RAILWAY_RUN_UID).toBe('0');
  });

  it('成功したら 0 で終わる', () => {
    expect(r.exitCode).toBe(0);
  });
});

describe('Google ログインを選んだのにドメインが作れなかったとき', () => {
  // **黙って「外から叩けない構成」に化けさせない。**
  // 鍵と待ち受けを置かないのは正しい（境界の無い口を外に出さない）が、正しいがゆえに
  // 頼まれたものとは別物になる。ここで 0 を返すと、呼んだ側は完了と読み、人間は
  // 叩けない理由を Google 側の設定に探しに行く
  let r: Run;
  beforeAll(() => {
    r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        '',
      ].join('\n'),
      { domainFails: true, allowFailure: true },
    );
  });

  it('非0で終わる', () => {
    expect(r.exitCode).not.toBe(0);
  });

  it('境界の無い口を外に出さない（鍵も待ち受けも置かない）', () => {
    const app = r.vars('id-app');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    expect(app).not.toHaveProperty('ALTEROID_PUBLIC_URL');
    expect(app).not.toHaveProperty('ALTEROID_BIND');
  });

  it('ここまでに作ったものは壊さない（残りを手で足せる状態で終わる）', () => {
    // 途中で投げ出すと Service だけ在ってデプロイされていない状態になり、かえって困る
    expect(r.vars('id-app').ALTEROID_DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
    expect(r.vars('id-runner').RAILWAY_RUN_UID).toBe('0');
    expect(r.calls.some((c) => c.includes('source connect') && c.includes('--service app'))).toBe(
      true,
    );
  });
});

describe('.env に前の器の ALTEROID_PUBLIC_URL が残っているとき', () => {
  // 毎回新しいプロジェクトを作るので、前回書き留めた生成ドメインは別の器のものである。
  // そのまま信じると、死んだドメインを指す設定と Redirect URI ができる
  let r: Run;
  let envAfter = '';
  beforeAll(() => {
    r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://old-project.up.railway.app',
        '',
      ].join('\n'),
      { onEnvFile: (p) => (envAfter = readFileSync(p, 'utf8')) },
    );
  });

  it('前の生成ドメインは使わず、作り直した値を置く', () => {
    expect(r.vars('id-app').ALTEROID_PUBLIC_URL).toBe('https://test-app.up.railway.app');
    expect(r.calls.some((c) => c.startsWith('domain --service'))).toBe(true);
  });

  it('.env の古い値も置き直す（次の実行と compose に嘘を残さない）', () => {
    expect(envAfter).toContain('ALTEROID_PUBLIC_URL=https://test-app.up.railway.app');
    expect(envAfter).not.toContain('old-project.up.railway.app');
  });

  it('.env の他の値は壊さない', () => {
    expect(envAfter).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-test');
    expect(envAfter).toContain('ALTEROID_RUNNER_TOKEN=deadbeef');
    expect(envAfter).toContain('ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret');
  });
});

describe('.env に持ち込みのドメインがあるとき', () => {
  it('新しい Service に繋がっていなければ非0で終わり、鍵を置かない', () => {
    const r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { allowFailure: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_BIND');
    // 持ち込みのドメインを勝手に作らない（DNS を向けるのは人間の作業）
    expect(r.calls.some((c) => c.startsWith('domain alteroid.example'))).toBe(false);
  });

  it('繋がっていればそれを使う（生成し直さない）', () => {
    const r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { domainList: JSON.stringify([{ domain: 'alteroid.example' }]) },
    );
    expect(r.exitCode).toBe(0);
    expect(r.vars('id-app').ALTEROID_PUBLIC_URL).toBe('https://alteroid.example');
    expect(r.vars('id-app').ALTEROID_BIND).toBe('::');
    expect(r.calls.some((c) => c.startsWith('domain --service'))).toBe(false);
  });

  // **似た名前を「在る」と読まない。** JSON を素通しに `grep -F` で探すと
  // `alteroid.example` が `my-alteroid.example` に当たり、届かない口に対して
  // 公開 URL と Google の鍵と待ち受けを置いて 0 で終わる
  it.each([
    ['前に何か付いている', 'my-alteroid.example'],
    ['後ろに何か付いている', 'alteroid.example.invalid'],
  ])('似た名前だけが繋がっているとき（%s）は非0で終わり、鍵を置かない', (_name, attached) => {
    const r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { domainList: JSON.stringify([{ domain: attached }]), allowFailure: true },
    );
    expect(r.exitCode).not.toBe(0);
    const app = r.vars('id-app');
    expect(app).not.toHaveProperty('ALTEROID_PUBLIC_URL');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_ID');
    expect(app).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    expect(app).not.toHaveProperty('ALTEROID_BIND');
  });

  it('応答が読めないときは「繋がっていない」に倒す', () => {
    // 開ける側の判断なので、分からないなら閉じたままにする
    const r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      { domainList: 'not json', allowFailure: true },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_BIND');
  });

  it('入れ子の応答でも完全一致なら使う（Railway の形が変わっても拾う）', () => {
    const r = run(
      [
        MINIMAL,
        'ALTEROID_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com',
        'ALTEROID_GOOGLE_CLIENT_SECRET=goog-secret',
        'ALTEROID_PUBLIC_URL=https://alteroid.example',
        '',
      ].join('\n'),
      {
        domainList: JSON.stringify({
          serviceDomains: [{ domain: 'test-app.up.railway.app' }],
          customDomains: [{ domain: 'alteroid.example', id: 'd1' }],
        }),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.vars('id-app').ALTEROID_PUBLIC_URL).toBe('https://alteroid.example');
  });
});

describe('railway/*.json を Service の設定へ写す', () => {
  // Config as Code（ファイルのパスを指す）を Railway がサーバ側で廃止したので、
  // **中身をこちらで写す**ようになった（lib.sh の `config_input`）。ここで固定するのは
  // 写し方ではなく**写せなかったときに止まること**である — 黙って落とすと、json に
  // 足した設定が「書いたのに効かない」形で消え、ダッシュボードは既定値のままなので
  // 気づく場所が他に無い
  const configInput = (config: unknown): { status: number; stdout: string; stderr: string } => {
    const file = join(mkdtempSync(join(tmpdir(), 'alteroid-config-')), 'config.json');
    writeFileSync(file, JSON.stringify(config));
    const r = spawnSync(
      'bash',
      ['-c', 'source "$0"; config_input "$1"', join(RAILWAY_DIR, 'lib.sh'), file],
      { encoding: 'utf8' },
    );
    return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };

  it('現物の2つを写せる（役が startCommand で決まる）', () => {
    // **数え上げの持ち主は railway/ そのものである。** 名前を並べると、役を足した回だけ
    // 静かに素通りする
    const configs = readdirSync(RAILWAY_DIR).filter((f) => f.endsWith('.json'));
    expect(configs.length).toBeGreaterThanOrEqual(2);
    for (const name of configs) {
      const r = configInput(JSON.parse(readFileSync(join(RAILWAY_DIR, name), 'utf8')));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const input = JSON.parse(r.stdout);
      expect(typeof input.startCommand).toBe('string');
      // Builder enum から DOCKERFILE が消えた（HEROKU / NIXPACKS / PAKETO / RAILPACK）。
      // Dockerfile で焼くかを決めるのは dockerfilePath である
      expect(input.builder).toBeUndefined();
      expect(input.dockerfilePath).toBe('Dockerfile');
    }
  });

  it('知らない鍵は黙って落とさず止まる', () => {
    const r = configInput({ build: { zzz: 1 }, deploy: { startCommand: 'x' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('build.zzz');
  });

  it('知らない節も止まる', () => {
    const r = configInput({ zzz: {}, deploy: { startCommand: 'x' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('zzz');
  });

  it('DOCKERFILE 以外の builder は止まる（黙って捨てると別のもので焼かれる）', () => {
    const r = configInput({ build: { builder: 'NIXPACKS' }, deploy: { startCommand: 'x' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NIXPACKS');
  });

  it('startCommand が無ければ止まる（役が決まらないまま上げない）', () => {
    const r = configInput({ build: { dockerfilePath: 'Dockerfile' }, deploy: {} });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('startCommand');
  });
});
