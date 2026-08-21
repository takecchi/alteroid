/**
 * `railway/setup.sh` が置く変数の**割り振り**を固定する。
 *
 * ここで見ているのは「Railway に繋がるか」ではない（それは人間が一度やれば分かる）。
 * **役ごとにどの鍵が渡るか**である。ここが静かにずれると、3コンテナに割った意味が
 * 消えるのに、動作は正常に見える — つまり気づく場所が他に無い。
 *
 * 偽の `railway` を PATH の先に置いて、スクリプトが投げたはずの GraphQL の入力を
 * 拾って突き合わせる。ネットワークにも本物の Railway にも触らない。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { childEnv, makeFakeRailway } from './test-support.js';

const SETUP = join(dirname(fileURLToPath(import.meta.url)), 'setup.sh');

type Upsert = {
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Record<string, string>;
  replace: boolean;
  skipDeploys: boolean;
};

type Run = {
  vars: (serviceId: string) => Record<string, string>;
  upsert: (serviceId: string) => Upsert;
  calls: string[];
  apiLog: string;
  exitCode: number;
};

type Options = {
  /** `railway domain` をこけさせる */
  domainFails?: boolean;
  /** 新しい Service に既に繋がっているドメイン（JSON 文字列） */
  domainList?: string;
  /** 非0終了を期待する（既定では非0なら stderr 付きで落とす） */
  allowFailure?: boolean;
  /** 実行後の `.env` を読みたいとき */
  onEnvFile?: (path: string) => void;
  /** setup.sh へ足す引数（`--runners 2` など） */
  args?: string[];
};

/** `.env` を1つ書いて setup.sh を通し、投げられた入力と終了状態を返す。 */
function run(env: string, options: Options = {}): Run {
  const { dir, bin } = makeFakeRailway();

  const envFile = join(dir, '.env');
  writeFileSync(envFile, env);

  let exitCode = 0;
  try {
    execFileSync(
      'bash',
      [
        SETUP,
        '--yes',
        '--name',
        'test',
        '--repo',
        'takecchi/alteroid',
        '--branch',
        'main',
        ...(options.args ?? []),
      ],
      {
        env: childEnv(process.env, bin, {
          // **本物の .env を触らせない。** 既定は リポジトリ直下の .env である
          ALTEROID_ENV_FILE: envFile,
          FAKE_STATE: dir,
          ...(options.domainFails ? { FAKE_DOMAIN_FAILS: '1' } : {}),
          ...(options.domainList ? { FAKE_DOMAIN_LIST: options.domainList } : {}),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    options.onEnvFile?.(envFile);
  } catch (e) {
    options.onEnvFile?.(envFile);
    const err = e as { status?: number; stderr?: Buffer };
    exitCode = err.status ?? 1;
    if (!options.allowFailure) {
      // 落ちた理由（stderr）を握り潰すと、CI でだけ落ちたときに手掛かりが無くなる
      throw new Error(`setup.sh が ${exitCode} で終わった\n${err.stderr?.toString() ?? ''}`, {
        cause: e,
      });
    }
  }

  // **無いファイルを読んで落ちない。** 引数を弾いて何もせずに終わる場合（`--runners 0`）、
  // 記録そのものが1行も無い。ここで落ちると「何を投げたか」ではなく助手の都合で失敗する
  const readIfExists = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };

  const payloads = readIfExists('payloads.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { input: Upsert }).input);

  const upsert = (serviceId: string): Upsert => {
    const found = payloads.find((p) => p.serviceId === serviceId);
    if (!found) throw new Error(`${serviceId} への変数の投入が無い`);
    return found;
  };

  return {
    upsert,
    vars: (serviceId) => upsert(serviceId).variables,
    calls: readIfExists('calls.log').split('\n').filter(Boolean),
    apiLog: readIfExists('api.log'),
    exitCode,
  };
}

const MINIMAL = ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-test', 'ALTEROID_RUNNER_TOKEN=deadbeef', ''].join(
  '\n',
);

describe('シェルスクリプトの書き方', () => {
  // macOS の bash 3.2 は、変数参照の直後に全角文字が続くとそのバイトを**変数名に
  // 取り込む**（`"${ENV_FILE}（…"` を `ENV_FILE（` という名前として読む）。`set -u` の
  // 下では起動直後に unbound variable で死ぬ。日本語のメッセージを書き足すたびに
  // 踏むので、目で見張るのをやめてここで止める
  it.each(['setup.sh', 'add-runner.sh', 'verify.sh', 'lib.sh'])(
    '%s: 変数参照の直後に全角文字を置かない',
    (name) => {
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
      const offenders = source
        .split('\n')
        .map((line, i) => ({ line, no: i + 1 }))
        // eslint-disable-next-line no-control-regex
        .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
        .map(({ line, no }) => `${name}:${no}: ${line.trim()}`);
      // ${VAR} と書けば直る
      expect(offenders).toEqual([]);
    },
  );

  // **生の NUL を1バイトも置かない。** 入ると grep がそのファイルをバイナリと判定して
  // 中身を一切見なくなり、`grep -c` の出力が「0件」ではなく**空**になる（AGENTS.md
  // 「静かに失敗する道具」2-3。PR #92 で実害が出て #102 が撤去した）。シェルスクリプトは
  // NUL 区切りを扱うので `"\0"` と書きたくなり、エディタが素の NUL を落とす事故が起きる
  it.each(['setup.sh', 'add-runner.sh', 'verify.sh', 'lib.sh'])(
    '%s: 生の NUL を含まない',
    (name) => {
      const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name));
      expect(bytes.indexOf(0)).toBe(-1);
    },
  );
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

describe('setup.sh の順番', () => {
  let r: Run;
  beforeAll(() => {
    r = run(MINIMAL);
  });

  const index = (pred: (c: string) => boolean): number => r.calls.findIndex(pred);

  it('Config as Code を役ごとに指す', () => {
    expect(r.apiLog).toContain('/railway/daemon.json');
    expect(r.apiLog).toContain('/railway/runner.json');
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

describe('runner を2台で建てるとき（--runners 2）', () => {
  let r: Run;
  beforeAll(() => {
    r = run(MINIMAL, { args: ['--runners', '2'] });
  });

  it('runner_id は台ごとに違い、app には置かない', () => {
    // **同じ id を名乗る2台が並ぶと、RunnerRegistry#get は先に見つかった方を返す**
    // （線形一致。docs/roadmap.md M5、#106 の申し送り）。委譲した先とは別の器へ
    // manager_send が届き、しかも届いているように見える
    expect(r.vars('id-runner').ALTEROID_RUNNER_ID).toBe('runner-primary');
    expect(r.vars('id-runner-2').ALTEROID_RUNNER_ID).toBe('runner-2');
    // app は読まない。1つだけ置くと「2台居るのに id は1つ」という嘘が変数一覧に残る
    expect(r.vars('id-app')).not.toHaveProperty('ALTEROID_RUNNER_ID');
  });

  it('1台目の runner_id は runner-primary のまま（台帳の宛先を変えない）', () => {
    // ここを runner-1 に揃えると、台帳に残った runner-primary を誰も名乗らなくなり、
    // 走行中だった仕事の引き取り先が消える
    expect(r.vars('id-runner').ALTEROID_RUNNER_ID).toBe('runner-primary');
  });

  it('app の名簿に2台が並ぶ（参照のまま。固定 URL を埋めない）', () => {
    expect(r.vars('id-app').ALTEROID_RUNNER_URLS).toBe(
      'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518,http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518',
    );
    // **単数形を落とさない**（既に動いている構成が委譲先を失わないため。重複は
    // parseRunnerUrls が落とす）
    expect(r.vars('id-app').ALTEROID_RUNNER_URL).toBe(
      'http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518',
    );
  });

  it('境界の割り振りは台数が増えても変わらない', () => {
    for (const id of ['id-runner', 'id-runner-2']) {
      const v = r.vars(id);
      expect(v).not.toHaveProperty('ALTEROID_DATABASE_URL');
      expect(v.RAILWAY_RUN_UID).toBe('0');
      expect(v.ALTEROID_RUNNER_TOKEN).toBe('deadbeef');
      expect(v.ALTEROID_RUNNER_BIND).toBe('::');
    }
    expect(r.vars('id-app').ALTEROID_DATABASE_URL).toBe('${{Postgres.DATABASE_URL}}');
  });

  it('Config as Code は2台目にも指す（無いと役が決まらない）', () => {
    // **行で数えない。** GraphQL の本文に改行が入るので、1回の呼びが複数行になる
    // （行指向で探すと当たらない。AGENTS.md「静かに失敗する道具」grep 4）
    const configured = r.apiLog.match(/railwayConfigFile":"\/railway\/runner\.json/g) ?? [];
    expect(configured).toHaveLength(2);
    expect(r.apiLog.match(/railwayConfigFile":"\/railway\/daemon\.json/g) ?? []).toHaveLength(1);
  });

  it('runner を全部 app より先に繋ぐ', () => {
    // daemon は起動時に runner の /health へ名乗りを聞きに行く。1台でも後回しにすると、
    // その台だけが「上がっていない委譲先」として最初の2分を消費する
    const index = (pred: (c: string) => boolean): number => r.calls.findIndex(pred);
    const connect = (service: string): number =>
      index((c) => c.includes('source connect') && c.includes(`--service ${service}`));
    expect(connect('runner')).toBeGreaterThanOrEqual(0);
    expect(connect('runner-2')).toBeGreaterThan(connect('runner'));
    expect(connect('app')).toBeGreaterThan(connect('runner-2'));
  });

  it('同じ枝に繋ぐ（1台だけ main を見ていると、そこだけがマージのたびに畳まれる）', () => {
    const branches = r.calls
      .filter((c) => c.includes('source connect'))
      .map((c) => c.replace(/^.*--branch (\S+).*$/, '$1'));
    expect(branches).toEqual(['main', 'main', 'main']);
  });
});

describe('--runners に数でないものが来たとき', () => {
  // **何も作らずに止まる。** ここを通すと、for が1度も回らないまま
  // 「app だけ在って委譲先が無い」構成が 0 で終わる（頼まれたものと違うのに成功する）
  it.each([['0'], ['-1'], ['two'], ['']])('%s は非0で終わり、Service を作らない', (value) => {
    const r = run(MINIMAL, { args: ['--runners', value], allowFailure: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith('add'))).toBe(false);
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
