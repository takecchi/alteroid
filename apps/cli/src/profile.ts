import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

import { redactedExcerpt } from '@alteroid/core/redact';
import {
  hasRunnerPushFailure,
  LEGACY_PROFILE_NOTICE,
  normalizeProfile,
  type NormalizedProfile,
  type ProfileState,
} from '@alteroid/logic';

import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { describeScope } from './credential.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { keepDraftOnFailure, openEditorKeepingEdits, readInputFile } from './input-errors.js';
import { shellQuote } from './shell-quote.js';

/**
 * `alteroid profile` — 実行環境プロファイル（人間の `.zprofile` に当たるもの）。
 *
 * **これは「環境変数を器に増やす」の代わりである。** 道具の鍵を1つ足すたびに
 * `compose.yaml` を直して器を焼き直すのは、人間が自分の端末で `~/.zshenv` に
 * 1行足せば済ませていることを実装作業に変えてしまっている、ということである。
 * それはデグレードなので、口をここに開けてある。
 *
 * **プロファイルは名前付きの行の集まりである**（`/etc/profile.d` と同じ。名前を省くと
 * `default`）。行ごとに本文（何行でもよい）と撒く先を持ち、名前のコード単位順につなげて効く。
 * 置いたものは既定ではクローンにもマネージャーにも作業者にも効き（撒く先 `--scope`
 * で `app`＝クローンだけ / `runner`＝マネージャー・作業者だけに絞れる。環境変数
 * （`alteroid credential set --scope`）と同じ3値）、**器を作り直さずに
 * 差し替えられる**（これから起こす仕事には即座に。走行中の仕事は `gh` / `git` が
 * 次の呼び出しから拾う）。
 */

/** 失敗の応答の `error` / `detail` を画面に出す長さの上限（伏せた後に切る）。 */
const ERROR_LIMIT = 512;
const DETAIL_LIMIT = 2000;

/**
 * 行の名前の形。**`packages/core/src/store.ts` の `PROFILE_ENTRY_NAME` と揃える**
 * （CLI は core 本体を import せず、軽い subpath だけを使う。ずれてもデーモンが 400 で
 * 弾くので、ここは**通信の前に分かりやすく落とす**ためのもの）。
 */
const PROFILE_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const EMPTY_BODY_MESSAGE =
  '本文が空では行を置けない。外すなら alteroid profile rm <名前>（全部外すなら clear）。';

/** 名前を省略したときの行（旧来の「1本のプロファイル」がここへ載る）。 */
const DEFAULT_ENTRY = 'default';

type ProfileScope = 'all' | 'app' | 'runner';

interface ProfileEntryView {
  name: string;
  script: string;
  scope: ProfileScope;
  updatedAt: string;
  sha256: string;
  bytes: number;
}

type ProfileView = NormalizedProfile;

interface ApplyResult {
  ok: boolean;
  error?: string;
  output?: string;
  names?: string[];
}

interface UpdateView {
  updatedAt: string;
  /** 古いデーモン（旧 `PUT /profile`）の応答には無い。 */
  entries?: ProfileEntryView[];
  composed?: { clone: ProfileView['clone']; runner: ProfileView['runner'] };
  clone: ApplyResult;
  runners: (ApplyResult & { runnerId: string })[];
}

/** `--scope` を検査する。省略は undefined（＝既存の行の撒く先を保つ）。 */
function parseScope(raw: string | undefined): ProfileScope | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'all' || raw === 'app' || raw === 'runner') return raw;
  throw new Error(`--scope は all / app / runner のいずれかである（渡されたのは ${raw}）`);
}

/** 名前を検査する。省略は `default`。**通信の前に落とす。** */
function parseName(raw: string | undefined): string {
  const name = raw ?? DEFAULT_ENTRY;
  if (!PROFILE_ENTRY_NAME.test(name)) {
    throw new Error(
      `行の名前の形が不正である（${PROFILE_ENTRY_NAME.source}。渡されたのは ${name}）`,
    );
  }
  return name;
}

/**
 * `GET /profile` を読み、**古いデーモンの形（`entries` 無し）も `default` 1行として**
 * 読める形にする（`@alteroid/logic` の `normalizeProfile`）。新しい CLI から古い
 * デーモンを叩く窓（デーモンは1日1回夜に入る）で落ちないための実行時の倒れ先である。
 */
async function fetchProfile(target: Target): Promise<ProfileView> {
  return normalizeProfile((await request(target, '/profile')) as ProfileState);
}

/** 旧形式のとき、行ごとの操作ができない旨を出す。 */
function noteLegacy(profile: ProfileView): void {
  if (profile.legacy) stdout.write(`（${LEGACY_PROFILE_NOTICE}）\n`);
}

/**
 * 古いデーモンで行ごとの操作（名前が default でない・撒く先を指定する）をしようとしたとき、
 * 生の 404 / 400 にせず「サーバが古い」と分かる文言で落とす。
 */
function assertLegacySupports(profile: ProfileView, name: string, scope?: ProfileScope): void {
  if (!profile.legacy) return;
  if (name !== 'default' || (scope !== undefined && scope !== 'all')) {
    throw new Error(LEGACY_PROFILE_NOTICE);
  }
}

function describeEntry(entry: ProfileEntryView): string {
  return (
    `${entry.name}  ${describeScope(entry.scope)}  ${String(entry.bytes)} バイト` +
    `  更新 ${entry.updatedAt}`
  );
}

/** 置かれている行の一覧（**本文は出さない**）。 */
export async function profileListCommand(): Promise<void> {
  const target = await resolveTarget();
  const profile = await fetchProfile(target);

  if (profile.entries.length === 0) {
    stdout.write('プロファイルは置かれていません。\n');
    stdout.write('置くには: alteroid profile set [名前] --scope <all|app|runner>\n');
    return;
  }
  for (const entry of profile.entries) stdout.write(`${describeEntry(entry)}\n`);
  noteLegacy(profile);
  stdout.write('（名前のコード単位順につなげて効きます。本文は alteroid profile show <名前>）\n');
}

/**
 * 1行の本文を出す。**標準出力は本文だけ**（パイプで `set` へ戻せる。撒く先は
 * `list` / `status` で見る）。
 */
export async function profileShowCommand(name?: string): Promise<void> {
  const wanted = parseName(name);
  const target = await resolveTarget();
  const profile = await fetchProfile(target);

  if (profile.entries.length === 0) {
    stdout.write('プロファイルは置かれていません。\n');
    stdout.write('置くには: alteroid profile edit\n');
    return;
  }
  const entry = profile.entries.find((row) => row.name === wanted);
  if (entry === undefined) {
    throw new Error(
      `プロファイルに行 ${wanted} は無い。行の一覧は alteroid profile list で見られる。`,
    );
  }
  stdout.write(entry.script.endsWith('\n') ? entry.script : `${entry.script}\n`);
}

export async function profileStatusCommand(): Promise<void> {
  const target = await resolveTarget();
  const profile = await fetchProfile(target);

  if (profile.entries.length === 0) {
    stdout.write('プロファイル: 置かれていません\n');
  } else {
    stdout.write(`プロファイル: ${String(profile.entries.length)} 行\n`);
    for (const entry of profile.entries) {
      stdout.write(`  ${describeEntry(entry)} (sha256 ${entry.sha256})\n`);
    }
    // **つないだあとの指紋を、掛かる側ごとに出す。** 届いた先の指紋はこれと見比べる。
    if (!profile.legacy)
      stdout.write(
        `クローン用（合成後）: ${profile.clone.sha256 === undefined ? '掛かる行なし' : `${String(profile.clone.bytes ?? 0)} バイト (sha256 ${profile.clone.sha256})`}\n`,
      );
    if (!profile.legacy)
      stdout.write(
        `runner 用（合成後）: ${profile.runner.sha256 === undefined ? '掛かる行なし' : `${String(profile.runner.bytes ?? 0)} バイト (sha256 ${profile.runner.sha256})`}\n`,
      );
  }

  noteLegacy(profile);

  // **どの runner に何が届いているかを見せる。** 見えないと「置いた」「効いて
  // いない」のすれ違いが起きて、鍵の権限の問題なのか配布の問題なのかを誰も
  // 切り分けられない（鍵の指紋を出しているのと同じ理由）。
  const { runners } = (await request(target, '/runners')) as {
    runners: {
      label: string;
      state: string;
      runnerId?: string;
      profile?: { sha256: string; updatedAt: string };
    }[];
  };
  // 旧形式では合成後の指紋が無い。古いデーモンは全文を runner へ降ろすので、本文の指紋と見る。
  const expected = profile.legacy ? profile.sha256 : profile.runner.sha256;
  for (const runner of runners) {
    // 繋がるまで runner_id は分からない。宛先（label）なら登録した時点で言える。
    const name = runner.runnerId ?? runner.label;
    // **runner に掛かる行が0なら、載っていないのが正しい。** 食い違いとして見せると、
    // 直せない（直すと撒く先の意味が消える）ものを直させる。逆に載っているなら、
    // 外しの降ろしが済んでいないので、それは言う。
    if (runner.profile === undefined) {
      stdout.write(
        profile.entries.length > 0 && expected === undefined
          ? `  ${name}: プロファイル無し（runner に掛かる行が無いので、載っていないのが正しい。${runner.state}）\n`
          : `  ${name}: プロファイル無し（${runner.state}）\n`,
      );
      continue;
    }
    const note =
      expected === undefined
        ? '（runner に掛かる行が無いので載っているはずがない — 外しの降ろしが済んでいない）'
        : runner.profile.sha256 === expected
          ? '（runner 用の合成と一致）'
          : `（runner 用の合成 ${expected} と食い違う — 降ろし直しが済んでいない）`;
    stdout.write(
      `  ${name}: sha256 ${runner.profile.sha256} (${runner.profile.updatedAt})${note}\n`,
    );
  }
}

/**
 * ファイルか標準入力から、1行を丸ごと置き換える。
 *
 * **既に在る行を置き換えるときだけ確認する**（Issue #3201。`confirm.ts`）。在るかは、この
 * コマンドが元から読んでいた `GET /profile`（`fetchProfile`）の行一覧で決める（新しい呼び出しは
 * 足していない）。置き換えると前の本文は残らない（控えるなら `profile show`）。確認は入力を
 * 読む前に出す（標準入力を読み切ると、端末の `yes` を聞けない）。
 */
export async function profileSetCommand(
  nameArg: string | undefined,
  options: { file?: string; scope?: string; yes?: boolean },
  io?: ConfirmIo,
): Promise<void> {
  // 先に検査する（標準入力を読み終えてから「綴りが違う」で落とさない）。
  const name = parseName(nameArg);
  const scope = parseScope(options.scope);
  const target = await resolveTarget();
  const profile = await fetchProfile(target);
  assertLegacySupports(profile, name, scope);
  if (profile.entries.some((row) => row.name === name)) {
    await confirmIrreversible(
      `プロファイルの行 ${name} を置き換えます。前の本文は残りません（控えるなら alteroid profile show ${name}）。`,
      options,
      io,
    );
  }
  const script =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  // 空の本文は通信の前に断る（`put` も同じ検査を持つ）。
  if (script.trim().length === 0) throw new Error(EMPTY_BODY_MESSAGE);
  await put(name, script, target, scope, profile.legacy);
}

/** いま置いてある行を `$EDITOR` で開いて、閉じたら反映する。 */
export async function profileEditCommand(
  nameArg?: string,
  options: { scope?: string } = {},
): Promise<void> {
  const name = parseName(nameArg);
  const scope = parseScope(options.scope);
  const target = await resolveTarget();
  const profile = await fetchProfile(target);
  assertLegacySupports(profile, name, scope);
  const current = profile.entries.find((row) => row.name === name);

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-profile-'));
  const path = join(dir, `${name}.sh`);
  const resume = `alteroid profile set ${name} --file ${shellQuote(path)}${scope === undefined ? '' : ` --scope ${scope}`}`;
  await openEditorKeepingEdits({
    dir,
    path,
    initial: current !== undefined ? current.script : TEMPLATE,
    // 中身は人間が置いた鍵そのものになりうる。一時ファイルでも絞る。
    mode: 0o600,
    resume,
    alternative: 'alteroid profile set <name> --file <path>',
  });
  // **成功したときと「変更なし」のときだけ、一時ディレクトリを消す。** 失敗（保存・空の本文の断り）は
  // 人間が書いた内容を 0600 のまま残し、場所と続きのやり方を言う（#3453）。
  await keepDraftOnFailure(dir, path, resume, async () => {
    const edited = await readFile(path, 'utf8');

    // 撒く先だけを変えるのも更新である（本文が同じでも、外れる側が出る）。
    const scopeChanged = current !== undefined && scope !== undefined && scope !== current.scope;
    // **新しく作る行は、雛形のまま閉じたら「何も書かなかった」である**（雛形は案内文）。
    if (current === undefined ? edited === TEMPLATE : edited === current.script && !scopeChanged) {
      stdout.write('変更はありません。\n');
      return;
    }
    await put(name, edited, target, scope, profile.legacy);
  });
}

/**
 * 1行を外す。他の行は変えない。**戻せない操作なので確認する**（Issue #3141。`confirm.ts`）。
 * 行の本文（スクリプト）は外すと残らない。外す前に `profile show <名前>` で控えられる。
 */
export async function profileRemoveCommand(
  nameArg: string,
  options: { yes?: boolean } = {},
  io?: ConfirmIo,
): Promise<void> {
  const name = parseName(nameArg);
  const target = await resolveTarget();
  const profile = await fetchProfile(target);
  assertLegacySupports(profile, name);
  // **確認の前に、在るかを見る**（Issue #3838）。上で元から読んでいる行の一覧を使う（新しい呼び出しは
  // 足していない）。無い名前には確認も DELETE も出さず、DELETE の 404 と同じ文言で失敗する。
  // **古いデーモン（`legacy`）は見ない**——行の一覧が旧形式の合成で、空の PUT へ倒す既存の挙動のまま。
  if (!profile.legacy && !profile.entries.some((row) => row.name === name)) {
    throw new Error(`プロファイルに行 ${name} は無い`);
  }
  await confirmIrreversible(
    `プロファイルの行 ${name} を外します。行の本文は残りません（控えるなら alteroid profile show ${name}）。`,
    options,
    io,
  );
  // 古いデーモンには DELETE /profile/:name が無い。default の行は全部外す口（空の PUT）へ倒す。
  const result = (await (profile.legacy
    ? request(target, '/profile', { method: 'PUT', body: JSON.stringify({ script: '' }) })
    : request(target, `/profile/${encodeURIComponent(name)}`, { method: 'DELETE' }))) as UpdateView;
  stdout.write(
    hasRunnerPushFailure(result)
      ? `警告: プロファイルの行 ${name} は外しましたが、一部の runner へ反映できていません。\n`
      : `プロファイルの行 ${name} を外しました。\n`,
  );
  describeComposed(result);
  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);
  failOnPartialPush(result);
}

/**
 * 全行を外す（旧来の `clear` の意味）。**旧来の全文置換の口（`PUT /profile`、空）を
 * 1回で叩く** — 行ごとに `DELETE` を並べると、途中で落ちたとき半端に残る。
 */
export async function profileClearCommand(options: { yes?: boolean } = {}): Promise<void> {
  const target = await resolveTarget();
  // 未ログインなら確認を出す前に断る（Issue #3214）。
  if (target.note !== null) throw new Error(target.note);
  // **戻せない操作なので確認する**（Issue #3141。`confirm.ts`）。全行の本文が残らない。
  await confirmIrreversible(
    'プロファイルの全行を外します。行の本文は残りません（控えるなら alteroid profile show）。',
    options,
  );
  const result = (await request(target, '/profile', {
    method: 'PUT',
    body: JSON.stringify({ script: '' }),
  })) as UpdateView;
  stdout.write(
    hasRunnerPushFailure(result)
      ? '警告: プロファイルを全部外しましたが、一部の runner へ反映できていません。\n'
      : 'プロファイルを全部外しました。\n',
  );
  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);
  failOnPartialPush(result);
}

/**
 * 一部の runner へ反映できていなければ、見出しと台ごとの結果を出した**後で**例外にする
 * （`index.ts` が stderr へ出して終了コード 1。保存は済んでいる）。
 */
function failOnPartialPush(result: UpdateView): void {
  if (!hasRunnerPushFailure(result)) return;
  throw new Error(
    'runner への反映が一部失敗しました（プロファイルの保存は済んでいます。失敗した runner へは次に名乗ったときに降ろし直します）',
  );
}

function describeComposed(result: UpdateView): void {
  // 古いデーモンの応答には無い。
  if (result.composed === undefined) return;
  const { clone, runner } = result.composed;
  stdout.write(
    `  合成後の指紋: クローン用 ${clone.sha256 ?? '掛かる行なし'} / runner 用 ${runner.sha256 ?? '掛かる行なし'}\n`,
  );
}

async function put(
  name: string,
  script: string,
  known?: Target,
  scope?: ProfileScope,
  legacy = false,
): Promise<void> {
  if (script.trim().length === 0) {
    throw new Error(EMPTY_BODY_MESSAGE);
  }
  const target = known ?? (await resolveTarget());
  // 古いデーモン（行ごとの口が無い）へは、従来の全文置換 PUT /profile {script} へ倒す。
  const result = (await (legacy
    ? request(target, '/profile', { method: 'PUT', body: JSON.stringify({ script }) })
    : request(target, `/profile/${encodeURIComponent(name)}`, {
        method: 'PUT',
        // 省略は「既存の行の撒く先を保つ」（デーモン側の約束）。
        body: JSON.stringify({ script, ...(scope === undefined ? {} : { scope }) }),
      }))) as UpdateView;

  const row = result.entries?.find((entry) => entry.name === name);
  const sha = row?.sha256 ?? (result as { sha256?: string }).sha256 ?? '?';
  stdout.write(
    hasRunnerPushFailure(result)
      ? `警告: プロファイルの行 ${name} は保存しましたが、一部の runner へ反映できていません (sha256 ${sha})\n`
      : `プロファイルの行 ${name} を更新しました (sha256 ${sha})\n`,
  );
  stdout.write(`  撒く先: ${describeScope(row?.scope ?? 'all')}\n`);
  if (legacy) stdout.write(`（${LEGACY_PROFILE_NOTICE}）\n`);
  describeComposed(result);

  report('クローン', result.clone);
  for (const runner of result.runners) report(runner.runnerId, runner);

  // **どこまで届いたかを正直に言う。** 器を焼き直す手順を探させないために
  // 「即座に効く」ことは言うが、走行中の仕事に全部届くとは言わない — `BASH_ENV`
  // は非対話の bash なら `bash -c` でも読まれるものの、実測では届く相手と届かない
  // 相手が混在する（`packages/core/src/profile.ts` のモジュール doc）。
  // ここを大きく書くと、効いていない相手が居ることに誰も気づけなくなる。
  stdout.write('（これから起こす仕事には即座に効きます。走行中の仕事は gh / git だけが\n');
  stdout.write('  次の呼び出しから拾います — それ以外は次の仕事から）\n');
  failOnPartialPush(result);
}

function report(label: string, result: ApplyResult): void {
  if (result.ok) {
    const names = result.names ?? [];
    stdout.write(
      names.length === 0
        ? `  ${label}: 反映しました\n`
        : `  ${label}: 反映しました（${names.join(' ')}）\n`,
    );
  } else {
    // 失敗を小さく出さない。ここを見落とすと、以後ずっと古い環境で走り続ける。
    stdout.write(`  ${label}: 反映できませんでした — ${result.error ?? '理由不明'}\n`);
  }
  const output = result.output ?? '';
  if (output.trim().length > 0) {
    for (const line of output.trimEnd().split('\n')) stdout.write(`    | ${line}\n`);
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    // **403 の意味が `access` とは違うことがある。** ここは基本「実行環境の
    // 持ち主か」を見ているが、**403 はそれ以外の理由でも返る**——ログイン済み
    // だが未 grant のとき、デーモンの `authenticate` が別の本文で 403 を返す。
    // 本文を見ずに固定の文言を出すと、未 grant の人にまで「持ち主だけです」と
    // 案内してしまい、`access grant` で直る状況で直らない手順を勧めることに
    // なる（許可が持っているのは「使ってよい」の2値だけで、実行環境そのものを
    // 差し替える資格はそこに含まれない、という線引きは変えていない——本文で
    // 出し分けるようにしただけである）。
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      // **2026-09-24（#1122）に `/profile` の門は `requireOwner` へ移った** ⟹ 宣言して
      // いないアカウントの 403 はこの本文で返る。案内は `credential.ts` と同じ
      // （`alteroid access owner <id>`）。下の `not_operator` の枝は、移す前の
      // デーモンと繋いだときのために残してある。
      if (kind === 'not_declared_owner') {
        throw new Error(
          describeAuthFailure(403, target, kind) ??
            '実行環境の持ち主として宣言されたアカウントだけが操作できます。',
        );
      }
      if (kind === 'not_operator') {
        throw new Error(
          '実行環境プロファイルを触れるのは、その実行環境の持ち主だけです。\n' +
            'デーモンが動いているのと同じ環境で実行してください:\n' +
            '  docker compose exec app alteroid profile edit\n' +
            '（人間が ~/.zshenv を直すのも、その人が持っている箱の上である、という線引きです）',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // **⭐ `kind === 'unknown'`——本文からはどちらの理由かが判別できない。**
      // 「器の中で実行しろ」と「access grant しろ」は意味も解決策も正反対で、
      // どちらかを当てずっぽうで出せば半分の状況では必ず嘘になる。分からない
      // ときは、解決策を書かずに止める。
      throw new Error(
        '実行環境プロファイルへのアクセスが拒否されました（403）。理由を判別でき' +
          'なかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      detail?: unknown;
    };
    if (typeof body.error === 'string') {
      // **伏せてから切る**（issue #2418）。`detail` はデーモンが評価したシェルの
      // stderr で、bash は構文エラーで入力の行そのもの（`export GH_TOKEN=…`）を
      // 引用する。message は画面に出る。
      const error = redactedExcerpt(body.error, ERROR_LIMIT, process.env);
      throw new Error(
        typeof body.detail === 'string' && body.detail.length > 0
          ? `${error}\n${redactedExcerpt(body.detail, DETAIL_LIMIT, process.env)}`
          : error,
      );
    }
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}

/**
 * 空から始めるときの案内。
 *
 * **「確認が要る行為の一覧」を書かせない。** ここは実行環境の宣言であって、
 * 何をしてよいかの表ではない（それはクローンが記憶で判断する）。
 */
const TEMPLATE = `# alteroid 実行環境プロファイル（人間の ~/.zprofile に当たるもの）
#
# ここに書いたものは、既定ではクローン・マネージャー・作業者のすべてに効きます
# （プロファイルは名前付きの行の集まりで、名前のコード単位順につなげて効きます）
# （alteroid profile edit --scope runner のように撒く先を絞れます。
#  all=両方 / app=クローンだけ / runner=マネージャー・作業者だけ）。
# 器（コンテナ）を作り直す必要はありません。
#
# 例:
#   export SOME_API_TOKEN=xxxx
#   export PATH="$HOME/.local/bin:$PATH"
#   eval "$(some-tool env)"
#
# 注意:
# - 重い処理や、返ってこないコマンドを書かないでください（仕事を起こすたびに
#   1度評価されるので、そのぶん遅くなります）
# - 差し替えは**これから起こす仕事**に効きます。既に走っている仕事のうち、
#   次の呼び出しから拾うのは gh / git だけです
# - 記憶（人格）ではありません。価値観や「何を任せてよいか」は alteroid chat で
#   伝えてください
`;
