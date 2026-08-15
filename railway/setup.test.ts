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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const SETUP = join(dirname(fileURLToPath(import.meta.url)), 'setup.sh');

/**
 * 偽の railway CLI。呼ばれ方を記録し、もっともらしい JSON を返すだけ。
 *
 * **`api` に来た `--variables @path` の中身を保存する**のが本題で、そこに
 * 「どの Service へ何を置こうとしたか」が全部入っている。
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const T = process.env.FAKE_STATE;
const args = process.argv.slice(2);
const at = (f) => path.join(T, f);
fs.appendFileSync(at('calls.log'), args.join(' ') + '\\n');

const services = () => {
  try {
    return JSON.parse(fs.readFileSync(at('services.json'), 'utf8'));
  } catch {
    return [];
  }
};
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

switch (args[0]) {
  case '--version':
    out('railway 5.38.0\\n');
    break;
  case 'whoami':
    out('tester\\n');
    break;
  case 'init':
    break;
  case 'status':
    out({ id: 'proj-1', name: 'test' });
    break;
  case 'environment':
    out({ environments: [{ id: 'env-1', name: 'production', isLinked: true }] });
    break;
  case 'add': {
    const s = services();
    if (args.includes('--database')) {
      // Railway はテンプレート由来の名前を付ける（--service を見ない）
      s.push({ id: 'id-Postgres', name: 'Postgres', source: { repo: null, image: 'postgres-ssl:18' } });
    } else if (args.includes('--service')) {
      const n = flag('--service');
      s.push({ id: 'id-' + n, name: n, source: { repo: null, image: null } });
    }
    fs.writeFileSync(at('services.json'), JSON.stringify(s));
    break;
  }
  case 'service':
    if (args[1] === 'list') out(services());
    break;
  case 'deployment':
    out([{ id: 'dep-1', status: 'SUCCESS' }]);
    break;
  case 'api': {
    const v = args.find((a) => a.startsWith('@'));
    if (v) fs.appendFileSync(at('payloads.jsonl'), fs.readFileSync(v.slice(1), 'utf8') + '\\n');
    fs.appendFileSync(at('api.log'), args.join(' ') + '\\n');
    out({ data: { ok: true } });
    break;
  }
  case 'domain':
    // 新しい Service に繋がっているドメイン（既定は「1つも無い」）
    if (args[1] === 'list') {
      out(process.env.FAKE_DOMAIN_LIST ?? '[]');
      break;
    }
    // ドメイン生成が一時的にこける／応答の形が変わる、を再現する
    if (process.env.FAKE_DOMAIN_FAILS) process.exit(1);
    out({ domain: 'test-app.up.railway.app' });
    break;
  default:
    out({});
}
`;

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
};

/**
 * 子プロセスへ渡す環境変数を**明示的に組み立てる**（呼び出した側のシェルから
 * 引き継ぐのは `PATH` だけ。bash / node / git / openssl を見つけるため）。
 *
 * かつてここは `...process.env` を丸ごと渡していた。setup.sh は
 * `CLAUDE_CODE_OAUTH_TOKEN` / `ALTEROID_RUNNER_TOKEN` / `GH_TOKEN` を `printenv` で
 * 読み、`.env` より**優先する**（人間が回すぶんにはこの順序が正しい）。だから
 * 走らせた人のシェルにその名前が入っていると、`.env` に書いた作り物ではなく
 * **本物の鍵**がスクリプトへ入り、症状が3つとも違う形で出ていた:
 *
 *   1. `GH_TOKEN` — `github_pat_test` と比較して落ち、**差分表示に本物の値が丸ごと出る**。
 *      テスト出力が残る場所（報告・日誌・CI ログ）で走らせれば、そこに写る
 *   2. `ALTEROID_RUNNER_TOKEN` — 同じく落ちて、同じく値が出る
 *   3. `CLAUDE_CODE_OAUTH_TOKEN` — **落ちない。これがいちばん悪い。**「秘密を引数で
 *      渡さない」が `sk-ant-test` を探すのに、実際に流れたのは本物の値なので、
 *      何も確かめないまま緑になる（空振りの合格）
 *
 * 個別に `unset` するのではなく allowlist にしてあるのは、setup.sh が `printenv` を
 * 1つ増やしたときに**ここを直さなくても穴が開かない**ようにするためである。
 * 引き継ぐ名前を足したくなったら、それが `.env` の作り物より強い入力にならないか
 * （＝走らせる場所で結論が変わらないか）を先に考えること。
 */
function childEnv(
  parent: NodeJS.ProcessEnv,
  bin: string,
  extra: Record<string, string>,
): Record<string, string> {
  return { PATH: `${bin}:${parent.PATH ?? ''}`, ...extra };
}

/** `.env` を1つ書いて setup.sh を通し、投げられた入力と終了状態を返す。 */
function run(env: string, options: Options = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'alteroid-setup-test.'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const cli = join(bin, 'railway');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);

  const envFile = join(dir, '.env');
  writeFileSync(envFile, env);

  let exitCode = 0;
  try {
    execFileSync(
      'bash',
      [SETUP, '--yes', '--name', 'test', '--repo', 'takecchi/alteroid', '--branch', 'main'],
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

  const payloads = readFileSync(join(dir, 'payloads.jsonl'), 'utf8')
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
    calls: readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean),
    apiLog: readFileSync(join(dir, 'api.log'), 'utf8'),
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
  it.each(['setup.sh', 'verify.sh'])('%s: 変数参照の直後に全角文字を置かない', (name) => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
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
