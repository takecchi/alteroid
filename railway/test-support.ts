/**
 * `railway/*.sh` のテストが共有する足場。
 *
 * **偽の `railway` を PATH の先に置いて、投げられたはずの GraphQL の入力を拾う。**
 * ネットワークにも本物の Railway にも触らない。見ているのは「Railway に繋がるか」
 * ではなく（それは人間が一度やれば分かる）、**役ごとにどの鍵が渡るか**である。
 *
 * `setup.sh` と `add-runner.sh` で偽物を別々に持つと、片方だけが Railway の応答の形に
 * 追いつく形になる（そして古びた側は緑のまま嘘をつく）。**持ち主は1か所にする。**
 *
 * ## 偽物が state.json で覚えていること
 *
 * `add-runner.sh` は「既に在るもの」から名前・runner_id・変数・繋ぐ枝を決めるので、
 * **在る状態を作れないとテストが書けない。** だから偽 CLI は状態を持つ:
 *
 *   { services: [{ id, name, config, source: {repo, branch}, vars: {…} }] }
 *
 * `add`（Service を作る）・`variableCollectionUpsert`（変数を置く）・
 * `serviceInstanceUpdate`（Config as Code を指す）・`service source connect` は、
 * この state を実際に書き換える。読む側（`service list` / `variable list` /
 * `environment { serviceInstances }` / `service { repoTriggers }`）は state を返す。
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 偽 CLI が state.json で覚える Service の形。 */
export type FakeService = {
  id: string;
  name: string;
  /** Config as Code のパス（役の持ち主）。未設定なら null */
  config?: string | null;
  /** GitHub 連携（`repoTriggers` として返る）。未設定なら null */
  source?: { repo: string; branch: string } | null;
  /** イメージ由来の Service（PostgreSQL）を作るときだけ */
  image?: string | null;
  vars?: Record<string, string>;
  /**
   * `railway ssh` が返す probe の出力（`key=value` の行）。
   *
   * **中で走らせる本物の probe は再現しない**（`/proc/1/environ` も `su` も無い）。
   * ここで固定するのは `verify.sh` の**判定**であって、probe が正しく取れるかではない
   * — そちらは器の中でしか確かめられない。未設定なら「入れなかった」になる
   */
  probe?: string;
};

export type FakeState = { services: FakeService[] };

/**
 * 偽の railway CLI。呼ばれ方を記録し、state.json を読み書きして返す。
 *
 * **`api` に来た `--variables @path` の中身を保存する**のが本題で、そこに
 * 「どの Service へ何を置こうとしたか」が全部入っている。
 */
export const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const T = process.env.FAKE_STATE;
const args = process.argv.slice(2);
const at = (f) => path.join(T, f);
fs.appendFileSync(at('calls.log'), args.join(' ') + '\\n');

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(at('state.json'), 'utf8'));
  } catch {
    return { services: [] };
  }
};
const writeState = (s) => fs.writeFileSync(at('state.json'), JSON.stringify(s));
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
// \`--raw-var k=v\` / \`--var k=v\` を集める（同じ名前が複数来ることは無い）
const vars = () => {
  const o = {};
  args.forEach((a, i) => {
    if (a === '--raw-var' || a === '--var') {
      const kv = args[i + 1] ?? '';
      const eq = kv.indexOf('=');
      if (eq > 0) o[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
  });
  return o;
};
const ENV_ID = 'env-1';

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
    out({ environments: [{ id: ENV_ID, name: 'production', isLinked: true }] });
    break;
  case 'add': {
    const s = readState();
    if (args.includes('--database')) {
      // Railway はテンプレート由来の名前を付ける（--service を見ない）
      s.services.push({
        id: 'id-Postgres',
        name: 'Postgres',
        source: null,
        image: 'postgres-ssl:18',
        vars: {},
      });
    } else if (args.includes('--service')) {
      const n = flag('--service');
      s.services.push({ id: 'id-' + n, name: n, source: null, vars: {} });
    }
    writeState(s);
    break;
  }
  case 'variable': {
    if (args[1] === 'list') {
      const s = readState();
      const found = s.services.find((x) => x.name === flag('--service'));
      out((found && found.vars) || {});
    }
    break;
  }
  case 'service':
    if (args[1] === 'list') {
      out(
        readState().services.map((x) => ({
          id: x.id,
          name: x.name,
          source: { repo: (x.source && x.source.repo) || null, image: x.image || null },
        })),
      );
    } else if (args[1] === 'source' && args[2] === 'connect') {
      const s = readState();
      const found = s.services.find((x) => x.name === flag('--service'));
      if (!found) process.exit(1);
      if (process.env.FAKE_CONNECT_FAILS) process.exit(1);
      found.source = { repo: flag('--repo'), branch: flag('--branch') };
      writeState(s);
    } else if (args[1] === 'redeploy') {
      if (process.env.FAKE_REDEPLOY_FAILS) process.exit(1);
      fs.appendFileSync(at('redeploys.log'), (flag('--service') ?? '') + '\\n');
    }
    break;
  case 'redeploy':
    if (process.env.FAKE_REDEPLOY_FAILS) process.exit(1);
    fs.appendFileSync(at('redeploys.log'), (flag('--service') ?? '') + '\\n');
    break;
  case 'up':
    break;
  case 'ssh': {
    // probe を持たない Service は「入れなかった」（上がっていない / 再起動中）
    const found = readState().services.find((x) => x.name === flag('--service'));
    if (!found || !found.probe) process.exit(1);
    out(found.probe);
    break;
  }
  case 'deployment':
    out([{ id: 'dep-1', status: process.env.FAKE_DEPLOY_STATUS ?? 'SUCCESS' }]);
    break;
  case 'api': {
    const query = args[1] ?? '';
    const v = args.find((a) => a.startsWith('@'));
    if (v) fs.appendFileSync(at('payloads.jsonl'), fs.readFileSync(v.slice(1), 'utf8') + '\\n');
    fs.appendFileSync(at('api.log'), args.join(' ') + '\\n');

    if (query.includes('serviceInstances')) {
      const s = readState();
      out({
        data: {
          environment: {
            serviceInstances: {
              edges: s.services.map((x) => ({
                node: { serviceName: x.name, railwayConfigFile: x.config ?? null },
              })),
            },
          },
        },
      });
      break;
    }
    if (query.includes('repoTriggers')) {
      const s = readState();
      const found = s.services.find((x) => x.id === vars().id);
      out({
        data: {
          service: {
            repoTriggers: {
              edges:
                found && found.source
                  ? [
                      {
                        node: {
                          repository: found.source.repo,
                          branch: found.source.branch,
                          environmentId: ENV_ID,
                        },
                      },
                    ]
                  : [],
            },
          },
        },
      });
      break;
    }
    if (query.includes('serviceInstanceUpdate')) {
      const s = readState();
      const found = s.services.find((x) => x.id === vars().serviceId);
      let input = {};
      try {
        input = JSON.parse(vars().input ?? '{}');
      } catch {}
      if (found && input.railwayConfigFile) found.config = input.railwayConfigFile;
      writeState(s);
      out({ data: { ok: true } });
      break;
    }
    if (query.includes('variableCollectionUpsert') && v) {
      // 追記であって置き換えではない（replace: false）ので、state 側もマージする
      const s = readState();
      let payload = {};
      try {
        payload = JSON.parse(fs.readFileSync(v.slice(1), 'utf8'));
      } catch {}
      const input = payload.input ?? {};
      const found = s.services.find((x) => x.id === input.serviceId);
      if (found) found.vars = { ...(found.vars ?? {}), ...(input.variables ?? {}) };
      writeState(s);
      out({ data: { ok: true } });
      break;
    }
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
export function childEnv(
  parent: NodeJS.ProcessEnv,
  bin: string,
  extra: Record<string, string>,
): Record<string, string> {
  return { PATH: `${bin}:${parent.PATH ?? ''}`, ...extra };
}

/** 偽 CLI を PATH の先に置いた作業ディレクトリを1つ作る。 */
export function makeFakeRailway(state?: FakeState): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'alteroid-railway-test.'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const cli = join(bin, 'railway');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  if (state) writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return { dir, bin };
}
