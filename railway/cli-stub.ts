/**
 * 偽の `railway` CLI と、それを PATH の先に置いて `railway/*.sh` を1回走らせる足場。
 *
 * ここで見ているのは「Railway に繋がるか」ではない（それは人間が一度やれば分かる）。
 * **役ごとにどの鍵が渡るか**である。ここが静かにずれると、コンテナに割った意味が
 * 消えるのに、動作は正常に見える — つまり気づく場所が他に無い。
 *
 * **偽 CLI を1つにしてある理由。** `setup.sh`（新しく作る）と `scale-runners.sh`
 * （既存に足す）は同じ `railway` を叩くので、偽物を2つ持つと片方だけが本物の
 * 応答の形に追いつく。追いつけていない側は**緑のまま嘘を確かめる**。
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `railway/` の絶対パス。 */
export const RAILWAY_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 偽 railway CLI。呼ばれ方を記録し、もっともらしい JSON を返すだけ。
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
    // 「railway ssh --service X -- alteroid credential set NAME」の形だけを
    // 解釈する。setup.sh がこの形でしか呼ばないため、他の形（対話シェル等）は
    // 実装しない
    const svc = flag('--service');
    const dashdash = args.indexOf('--');
    const cmd = dashdash >= 0 ? args.slice(dashdash + 1) : [];
    if (cmd[0] === 'alteroid' && cmd[1] === 'credential' && cmd[2] === 'set') {
      // 正本（DB）へ置くのが一時的にこける、を再現する
      if (process.env.FAKE_SSH_CREDENTIAL_FAILS) process.exit(1);
      let value = '';
      try {
        value = fs.readFileSync(0, 'utf8');
      } catch {
        // 何もパイプされていなければ空のまま（credential.ts 側の「値が空」判定と
        // 同じ状況だが、偽 CLI 側では確かめない——確かめるのは setup.sh の側）
      }
      fs.appendFileSync(
        at('credentials.jsonl'),
        JSON.stringify({ service: svc, name: cmd[3], value }) + '\\n',
      );
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
  /** その Service への**最初の**投入。 */
  vars: (serviceId: string) => Record<string, string>;
  upsert: (serviceId: string) => Upsert;
  /** その Service への投入が1度もあったか（「触っていない」を確かめる側）。 */
  touched: (serviceId: string) => boolean;
  /** 投入された順の Service id（同じ id が複数回あればその回数だけ並ぶ）。 */
  upsertedServices: string[];
  /** `railway ssh -- alteroid credential set` で置かれた順（`set_credential`）。 */
  credentials: { service: string | undefined; name: string | undefined; value: string }[];
  /**
   * 呼び出しごとに1要素（`args.join(' ')`）。**1要素＝1回の CLI 起動**で、
   * 引数にリテラルな改行が入っていても割れない。
   *
   * ⚠️ **かつては違った（#1101）。** 偽 CLI が `calls.log` を `args.join(' ') + '\n'`
   * で書き、読む側が `split('\n')` するだけだったため、`railway api '<GraphQL>'` の
   * ように引数の中に改行を含む呼び出し（`lib.sh` の `set_config_file`）が複数行に
   * 割れ、`calls` の件数が実際の起動回数より多く出ていた（実測: 32行 / 実際28回）。
   * いまは偽 CLI 側が JSONL（`JSON.stringify(args) + '\n'`）で書き、ここで1行＝1回
   * として読み直すので、要素の文字列自体は以前と1バイトも変わらない
   * （`args.join(' ')`）まま、割れなくなった。
   */
  calls: string[];
  apiLog: string;
  stderr: string;
  exitCode: number;
};

export type RunOptions = {
  /** 走らせるスクリプト（`railway/` からの相対名）。 */
  script: string;
  /** スクリプトへ渡す引数。 */
  args: string[];
  /** `.env` の中身（省略すると `.env` を置かない）。 */
  envFile?: string;
  /** 実行前から在る Service（`scale-runners.sh` は既存を数える）。 */
  services?: { id: string; name: string; source?: { repo: string | null; image: string | null } }[];
  /** 走っている Service が持っている変数（`railway variable list` が返す）。 */
  serviceVars?: Record<string, Record<string, string>>;
  /** 偽 CLI と スクリプトへ足す環境変数。 */
  extraEnv?: Record<string, string>;
  /** 非0終了を期待する（既定では非0なら stderr 付きで落とす）。 */
  allowFailure?: boolean;
  /** 実行後の `.env` を読みたいとき。 */
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
 * 個別に `unset` するのではなく allowlist にしてあるのは、スクリプトが `printenv` を
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

type Prepared = {
  dir: string;
  bin: string;
  envFile: string;
  env: Record<string, string>;
};

/**
 * `runScriptAsync` の下ごしらえ（一時ディレクトリ・偽 CLI・`.env`・引き継ぐ環境）。
 * ⚠️ **かつては同期版 `runScript`（`spawnSync`）ともここを共有していた**——
 * プロセスをどう起こすかだけが両者で違う形にしてあったが、同期版は #1100 の後で
 * 呼ぶ場所が無くなり削った（`runScriptAsync` の直前のコメントに詳しい）。
 * `finish`（下）と合わせて、いまは1つの呼び出し元しか無い。
 */
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
    // **本物の .env を触らせない。** 既定は リポジトリ直下の .env である
    ALTEROID_ENV_FILE: envFile,
    FAKE_STATE: dir,
    ...(options.extraEnv ?? {}),
  });

  return { dir, bin, envFile, env };
}

/**
 * 子プロセスが終わった後、投げられた入力と終了状態を `Run` へ組み立てる。
 * ⚠️ かつては `runScript`（同期版）とも共有していたが、その関数自体を
 * 削った（`runScriptAsync` の直前のコメント）ので、いまの呼び出し元は
 * `runScriptAsync` だけである。
 */
function finish(options: RunOptions, prepared: Prepared, exitCode: number, stderr: string): Run {
  options.onEnvFile?.(prepared.envFile);

  if (exitCode !== 0 && !options.allowFailure) {
    // 落ちた理由（stderr）を握り潰すと、CI でだけ落ちたときに手掛かりが無くなる
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
        JSON.parse(l) as { service: string | undefined; name: string | undefined; value: string },
    );

  return {
    upsert,
    vars: (serviceId) => upsert(serviceId).variables,
    touched: (serviceId) => payloads.some((p) => p.serviceId === serviceId),
    upsertedServices: payloads.map((p) => p.serviceId),
    credentials,
    // JSONL（1行1呼び出し）を読み戻す。各要素の文字列は旧形式（`args.join(' ')`）と
    // 1バイトも変わらない——変わるのは「改行を含む呼び出しでも割れない」ことだけ
    // （上の `calls` の doc コメント、#1101）。
    calls: read('calls.log')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as string[]).join(' ')),
    // `apiLog` は `toContain` / `match` で丸ごと1つの文字列として使われているので、
    // 復元した中身は旧形式（各呼び出しを `args.join(' ')` にして `\n` で繋ぎ、
    // 空でなければ末尾に `\n`）と1バイトも変わらないようにする。
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

/**
 * スクリプトを1回走らせ、投げられた入力と終了状態を返す（非同期、`spawn`）。
 *
 * **足した理由は `setup.test.ts` の準備段（28回ぶんの `setup.sh` 実行）を
 * 直列ではなく並行に走らせるため**である（#1093 — 直列に起こすと、器が
 * 混んでいる時間だけ `it` の所要時間が伸びて `testTimeout` を超える）。
 *
 * ⚠️ **かつては同期版（旧 `runScript`、`spawnSync` を使うもの）も在った。**
 * `scale-runners.test.ts` が `it` の中で直接スクリプトを起こしていた間は
 * そちらを使い続けていたが、#1100 でその呼び出しを全部 `prepareScenarios`
 * （`runLimited` による並行実行）へ寄せたことで、**同期版を呼ぶ箇所が
 * リポジトリ全体から無くなった**（削る直前の実測 2026-09-16: 呼び出し側の
 * 検索は0件、当たったのは定義行そのものだけだった）。使う側が無いまま残すと
 * 「使われている」という嘘の手がかりを次に読む人へ渡すことになるので、ここで
 * 削った。**下ごしらえ（`prepare`）と結果の組み立て（`finish`）は元から同期版と
 * 非同期版で共有していたヘルパーで、削ったのは `spawnSync` を呼ぶ薄い皮だけ
 * である**——挙動の変更は無い。
 */
export function runScriptAsync(options: RunOptions): Promise<Run> {
  const prepared = prepare(options);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(RAILWAY_DIR, options.script), ...options.args], {
      env: prepared.env,
      // stdout は誰も読まない（同期版でも `result.stdout` は使っていない）ので
      // 'ignore' で捨てる——'pipe' のまま誰も drain しないと、OS のパイプが
      // 埋まって子プロセスを止めてしまう
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
      }
    });
  });
}

/**
 * 並行数を `limit` で頭打ちにして非同期タスクを走らせる小さなプール。
 * 無制限に並べると器の CPU を使い切る（`setup.test.ts` の準備段が
 * `runScriptAsync` を28回ぶん投げるのに使う）。
 */
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
        // noUncheckedIndexedAccess は添字アクセスそのものからは境界を証明できないが、
        // 直上のループ条件 `i < items.length` が範囲を保証している。
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

/**
 * **準備段のシナリオを集める足場。1つが死んでも他を道連れにしない（#1150）。**
 *
 * `setup.test.ts` / `scale-runners.test.ts` は `it` から起動コストを追い出すため、
 * 全シナリオを1つの `beforeAll`（`prepareScenarios`）へ寄せてある（#1093 / #1100）。
 * ⚠️ **素直に書くとその `beforeAll` が「1つでも死んだら全部落ちる」形になる** ——
 * `allowFailure` を付けていないシナリオが想定外に非0で終わると `finish()` が投げ、
 * `beforeAll` 全体が reject し、**ファイル内の全テストが一括で skip になる。**
 * CI は赤くなるので見逃しは起きないが、**「どの保証が壊れたか」がテスト名から
 * 一切読めなくなる**（実測 2026-09-17: `scale-runners` で26本中0本が個別名で赤、
 * `setup` で64本中0本。どちらも `Failed Suites 1` と skip 件数しか出なかった）。
 *
 * だからここでは**失敗を握り潰さず、引いた時点まで遅らせる**:
 *
 * - `task(name, fn)` は `fn` の例外を捕まえて `name` の下に**しまう**（他のタスクは走り続ける）
 * - `settle()` が返す表は、**しまった例外を持つ名前を引いた瞬間にそれを投げる**
 *
 * ⟹ 死んだシナリオを引く `it`（や describe の `beforeAll`）だけが赤くなり、
 * **他のシナリオを引く `it` は自分の保証を測り続ける。**
 *
 * ⚠️ **握り潰しではない。** 引かれない例外は消えるように見えるが、シナリオは
 * 必ずどこかの `it` が引くために作られている（引かないシナリオは作る意味が無い）。
 * 引く側が消えたときに黙るのが嫌なら、それは「使われていないシナリオを検出する」
 * 別の歯の仕事であって、この足場の役目ではない。
 */
export function scenarioCollector<S extends object>() {
  const value = {} as S;
  const failures = new Map<PropertyKey, unknown>();
  const tasks: Array<() => Promise<void>> = [];

  /** 1シナリオぶんの準備を登録する。`fn` が投げたら `name` の下へしまう。 */
  const task = (name: keyof S, fn: () => Promise<void>): void => {
    tasks.push(async () => {
      try {
        await fn();
      } catch (error) {
        failures.set(name, error);
      }
    });
  };

  /** 全タスクを `limit` 本まで並行に走らせ、引いた時点で投げる表を返す。 */
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
