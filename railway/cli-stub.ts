// 偽 CLI は1つにする: `setup.sh` と `scale-runners.sh` は同じ `railway` を叩くので、偽物を2つ持つと片方だけが本物の応答の形に追いつき、追いつけていない側が緑のまま嘘を確かめるため。
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAILWAY_DIR = dirname(fileURLToPath(import.meta.url));

export const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const T = process.env.FAKE_STATE;
const args = process.argv.slice(2);
const at = (f) => path.join(T, f);
// **1行1呼び出しの JSONL で書く（argv をそのまま）。** かつては
// \`args.join(' ') + '\\n'\` で書いていたが、引数にリテラルな改行が入ると
// （\`railway api '<複数行の GraphQL>'\` がそれである）1回の呼び出しが複数行に
// 割れ、読む側の \`split('\\n')\` が呼び出し回数を実際より多く数えていた（#1101）。
// JSON.stringify は改行を \`\\n\`（2文字）へエスケープするので、1呼び出しは
// 必ず1行になる。
fs.appendFileSync(at('calls.log'), JSON.stringify(args) + '\\n');

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
  case 'variable':
    // **走っている Service が実際に持っている値**（scale-runners.sh はここから写す）。
    // テストが vars-<service>.json を置く。無ければ空
    if (args[1] === 'list') {
      const n = flag('--service');
      try {
        out(fs.readFileSync(at('vars-' + n + '.json'), 'utf8'));
      } catch {
        out({});
      }
    }
    break;
  case 'deployment':
    out([{ id: 'dep-1', status: 'SUCCESS' }]);
    break;
  case 'api': {
    const v = args.find((a) => a.startsWith('@'));
    if (v) fs.appendFileSync(at('payloads.jsonl'), fs.readFileSync(v.slice(1), 'utf8') + '\\n');
    // api.log も calls.log と同じ理由・同じ形で JSONL にする（#1101 —
    // \`args.join(' ') + '\\n'\` のままでは、ここに来る GraphQL の埋め込み改行が
    // 同じように行を割る）。
    fs.appendFileSync(at('api.log'), JSON.stringify(args) + '\\n');
    // ワークスペース一覧の問い合わせ。**既定は1つ**（テストが明示しない限り、
    // 複数ワークスペースの分岐に無関係なテストを巻き込まない）
    if (args.some((a) => a.includes('workspaces'))) {
      let names;
      try {
        names = JSON.parse(process.env.FAKE_WORKSPACES || '["test"]');
      } catch {
        names = ['test'];
      }
      out({ data: { me: { workspaces: names.map((name) => ({ name })) } } });
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
  case 'ssh': {
    // 「railway ssh --service X -- alteroid credential set NAME」と
    // 「railway ssh --service X -- node - <引数…>」の2形だけを解釈する。
    // setup.sh / scale-runners.sh がこの2形でしか呼ばないため、他の形
    // （対話シェル等）は実装しない
    const svc = flag('--service');
    const dashdash = args.indexOf('--');
    const cmd = dashdash >= 0 ? args.slice(dashdash + 1) : [];
    if (cmd[0] === 'alteroid' && cmd[1] === 'credential' && cmd[2] === 'set') {
      // 正本（DB）へ置くのが一時的にこける、を再現する
      if (process.env.FAKE_SSH_CREDENTIAL_FAILS) process.exit(1);
      // 古い CLI（#3201 より前）は --yes を知らない。--help の出力に載せず、渡されれば落ちる
      const oldCli = Boolean(process.env.FAKE_OLD_CLI);
      if (cmd.includes('--help')) {
        process.stdout.write(
          'Usage: alteroid credential set [options] <名前>\\nOptions:\\n  -f, --file <path>\\n' +
            (oldCli ? '' : '  --yes  確認を飛ばす\\n'),
        );
        process.exit(0);
      }
      if (oldCli && cmd.includes('--yes')) {
        process.stderr.write("error: unknown option '--yes'\\n");
        process.exit(1);
      }
      let value = '';
      try {
        value = fs.readFileSync(0, 'utf8');
      } catch {
        // 何もパイプされていなければ空のまま（credential.ts 側の「値が空」判定と
        // 同じ状況だが、偽 CLI 側では確かめない——確かめるのは setup.sh の側）
      }
      fs.appendFileSync(
        at('credentials.jsonl'),
        JSON.stringify({ service: svc, name: cmd[3], value, yes: cmd.includes('--yes') }) + '\\n',
      );
    } else if (cmd[0] === 'node' && cmd[1] === '-') {
      // scale-runners.sh の vacate 経路（#1377）。標準入力に流れてきた
      // node スクリプトの本文をそのまま実行する——「railway ssh の中で
      // 127.0.0.1:$ALTEROID_PORT を叩く」を、実際にこのスクリプトごと
      // 走らせて検分するため（呼び出し引数だけを記録して中身を検分しない
      // 形にすると、待ち方・資格の読み方・出力に何を出さないかという、
      // この機能でいちばん問われている部分がテストから抜け落ちる）。
      // ALTEROID_HOME はテストが用意した偽コンテナの状態ディレクトリを
      // 指すよう、呼び出し側が env で渡す（この偽 CLI 自身の env をそのまま
      // 継承させるだけで、ここでは何も足さない）。
      const cp = require('child_process');
      let script = '';
      try {
        script = fs.readFileSync(0, 'utf8');
      } catch {
        // 何もパイプされていなければ空のまま（下の node が読めずに落ちる）
      }
      const scriptPath = at('vacate-script.js');
      fs.writeFileSync(scriptPath, script);
      const result = cp.spawnSync(process.execPath, [scriptPath].concat(cmd.slice(2)), {
        env: process.env,
        encoding: 'utf8',
        timeout: 30000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.status === null || result.status === undefined ? 1 : result.status);
    }
    out({});
    break;
  }
  default:
    out({});
}
`;

export type Upsert = {
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Record<string, string>;
  replace: boolean;
  skipDeploys: boolean;
};

export type Run = {
  vars: (serviceId: string) => Record<string, string>;
  upsert: (serviceId: string) => Upsert;
  touched: (serviceId: string) => boolean;
  upsertedServices: string[];
  credentials: {
    service: string | undefined;
    name: string | undefined;
    value: string;
    yes: boolean;
  }[];
  calls: string[];
  apiLog: string;
  stderr: string;
  exitCode: number;
};

export type RunOptions = {
  script: string;
  args: string[];
  envFile?: string;
  services?: { id: string; name: string; source?: { repo: string | null; image: string | null } }[];
  serviceVars?: Record<string, Record<string, string>>;
  extraEnv?: Record<string, string>;
  allowFailure?: boolean;
  onEnvFile?: (path: string) => void;
};

// 子プロセスへ渡す環境変数は allowlist（`PATH` だけ）にする: `setup.sh` は `CLAUDE_CODE_OAUTH_TOKEN` / `ALTEROID_RUNNER_TOKEN` / `GH_TOKEN` を `printenv` で読んで `.env` より優先するため、走らせた人のシェルに入っていると本物の鍵がスクリプトへ入り、差分表示に本物の値が出たり、何も確かめないまま緑になったりする。個別に `unset` しない: スクリプトが `printenv` を増やしたときに穴が開くため。
// `GIT_CONFIG_NOSYSTEM=1` は常に足す: `git config` は環境変数だけでなくシステム設定（`/etc/gitconfig`）も読み、器のシステム設定に本物の身元が乗っていると、`.env` に書いていないのに身元が「在る」ことになるため。
export function childEnv(
  parent: NodeJS.ProcessEnv,
  bin: string,
  extra: Record<string, string>,
): Record<string, string> {
  return { PATH: `${bin}:${parent.PATH ?? ''}`, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

type Prepared = {
  dir: string;
  bin: string;
  envFile: string;
  env: Record<string, string>;
};

function prepare(options: RunOptions): Prepared {
  const dir = mkdtempSync(join(tmpdir(), 'alteroid-railway-test.'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const cli = join(bin, 'railway');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);

  if (options.services) {
    writeFileSync(join(dir, 'services.json'), JSON.stringify(options.services));
  }
  for (const [name, vars] of Object.entries(options.serviceVars ?? {})) {
    writeFileSync(join(dir, `vars-${name}.json`), JSON.stringify(vars));
  }

  const envFile = join(dir, '.env');
  if (options.envFile !== undefined) writeFileSync(envFile, options.envFile);

  const env = childEnv(process.env, bin, {
    // `ALTEROID_ENV_FILE` を必ず渡す: 渡さないと既定の repo 直下の本物の `.env` を触るため。
    ALTEROID_ENV_FILE: envFile,
    FAKE_STATE: dir,
    ...(options.extraEnv ?? {}),
  });

  return { dir, bin, envFile, env };
}

function finish(options: RunOptions, prepared: Prepared, exitCode: number, stderr: string): Run {
  options.onEnvFile?.(prepared.envFile);

  if (exitCode !== 0 && !options.allowFailure) {
    // 落ちた理由（stderr）を握り潰さない: CI でだけ落ちたときに手掛かりが無くなるため。
    throw new Error(`${options.script} が ${exitCode} で終わった\n${stderr}`);
  }

  const read = (name: string): string => {
    try {
      return readFileSync(join(prepared.dir, name), 'utf8');
    } catch {
      return '';
    }
  };

  const payloads = read('payloads.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { input: Upsert }).input);

  const upsert = (serviceId: string): Upsert => {
    const found = payloads.find((p) => p.serviceId === serviceId);
    if (!found) throw new Error(`${serviceId} への変数の投入が無い`);
    return found;
  };

  const credentials = read('credentials.jsonl')
    .split('\n')
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          service: string | undefined;
          name: string | undefined;
          value: string;
          yes: boolean;
        },
    );

  return {
    upsert,
    vars: (serviceId) => upsert(serviceId).variables,
    touched: (serviceId) => payloads.some((p) => p.serviceId === serviceId),
    upsertedServices: payloads.map((p) => p.serviceId),
    credentials,
    calls: read('calls.log')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as string[]).join(' ')),
    apiLog: (() => {
      const records = read('api.log')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as string[]).join(' '));
      return records.length > 0 ? records.join('\n') + '\n' : '';
    })(),
    stderr,
    exitCode,
  };
}

export function runScriptAsync(options: RunOptions): Promise<Run> {
  const prepared = prepare(options);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(RAILWAY_DIR, options.script), ...options.args], {
      env: prepared.env,
      // cwd を呼び出し元（本物のリポジトリ）から切り離す: 既定の cwd のままだと、`setup.sh` が呼ぶ `git config user.name` が上向きに `.git` を探し、本物のリポジトリのローカル設定を拾うため。
      cwd: prepared.dir,
      // stdout は 'ignore' で捨てる: 'pipe' のまま誰も drain しないと、OS のパイプが埋まって子プロセスを止めるため。
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve(finish(options, prepared, code ?? 1, stderr));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        rmSync(prepared.dir, { recursive: true, force: true });
      }
    });
  });
}

// 並行数を `limit` で頭打ちにする: 無制限に並べると器の CPU を使い切るため。
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

// 失敗は握り潰さず引いた時点まで遅らせる: 1つのシナリオが想定外に死ぬと `beforeAll` 全体が reject し、ファイル内の全テストが一括で skip になって、どの保証が壊れたかがテスト名から読めなくなるため。
export function scenarioCollector<S extends object>() {
  const value = {} as S;
  const failures = new Map<PropertyKey, unknown>();
  const tasks: Array<() => Promise<void>> = [];

  const task = (name: keyof S, fn: () => Promise<void>): void => {
    tasks.push(async () => {
      try {
        await fn();
      } catch (error) {
        failures.set(name, error);
      }
    });
  };

  const settle = async (limit: number): Promise<S> => {
    await runLimited(tasks, limit, (t) => t());
    return new Proxy(value, {
      get(target, prop, receiver) {
        if (failures.has(prop)) throw failures.get(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  return { value, task, settle };
}
