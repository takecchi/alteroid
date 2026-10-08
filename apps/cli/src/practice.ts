import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { PRACTICE_SLUG_RULE, describeSlugViolation } from '@alteroid/core/cli-light';
import { stderr, stdout, writeShownBody } from './terminal-out.js';

import { createClient, type DaemonClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { keepDraftOnFailure, openEditorKeepingEdits, readInputFile } from './input-errors.js';
import { shellQuote } from './shell-quote.js';

// `kind` を固定の選択肢にしない: `practiceKindSchema` が自由文字列で、列挙ではないため
export interface PracticeSummary {
  slug: string;
  kind: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  chars: number;
}

export async function practiceListCommand(): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.practices.$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方の一覧を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const { practices, unreadable = [] } = (await response.json()) as {
    practices: PracticeSummary[];
    unreadable?: { slug?: string; reason: string }[];
  };
  if (practices.length === 0 && unreadable.length === 0) {
    // 「正常」と言うのは読めない行が0件のときだけにする: 空なのか読めていないのかを区別できないため
    stdout.write('やり方はまだ1件も無い（これは正常な状態）。\n');
    stdout.write('置くには: alteroid practice edit <slug> --kind <種類> --title <題>\n');
    return;
  }
  if (practices.length === 0) {
    stdout.write('読めたやり方は無い（無いとも、正常だとも言えない。読めない行が在る——下）。\n');
  }
  for (const p of practices) {
    stdout.write(
      `  [${p.kind}] ${p.slug}  — ${p.title}` +
        ` (作成: ${p.createdAt} / 更新: ${p.updatedAt} / ${String(p.chars)} 文字)\n`,
    );
  }
  if (unreadable.length > 0) {
    stdout.write(
      `読めないやり方が ${String(unreadable.length)} 件ある（消えたのではなく、読めない形で入っている）。` +
        'この一覧には載っていない:\n',
    );
    for (const row of unreadable) {
      stdout.write(`  ${row.slug ?? '（slug も取れない）'}  ${row.reason}\n`);
    }
    stdout.write(
      'slug が分かる行は、alteroid practice edit <slug> で書き直すか、' +
        'alteroid practice remove <slug> で外せる。\n',
    );
  }
  if (practices.length > 0) stdout.write('本文を読むには: alteroid practice show <slug>\n');
}

export async function practiceShowCommand(
  slug: string,
  options: { version?: number | string } = {},
): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;

  if (options.version !== undefined) {
    const response = await client.practices[':slug'].versions[':version'].$get({
      param: { slug, version: String(options.version) },
    });
    if (!response.ok) {
      // 404 以外を「そんな版はありません」と言わない: 5xx 等を無いことにしてしまうため
      if (response.status === 400) {
        throw new Error(`版番号として成立しません: ${String(options.version)}`);
      }
      if (response.status === 404) {
        throw new Error(`そんな版はありません: ${slug} 版${String(options.version)}`);
      }
      const described = describeAuthFailure(response.status, target);
      if (described !== null) throw new Error(described);
      throw new Error(
        await withErrorReason(
          `版を読めませんでした: ${slug} 版${String(options.version)}（HTTP ${String(response.status)}）`,
          response,
        ),
      );
    }
    const body = await response.json();
    const content = 'version' in body ? body.version.content : '';
    writeShownBody(stdout, content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  const found = await read(client, conn.target, slug);
  if (found === null) {
    throw new Error(`そんなやり方はありません: ${slug}`);
  }
  const content = found.content;
  writeShownBody(stdout, content.endsWith('\n') ? content : `${content}\n`);
  // 版を stdout に混ぜない: 本文をそのまま出す口で、パイプやリダイレクトで本文が壊れるため
  if (found.version !== undefined) {
    stderr.write(
      `版: ${found.version}（読んだ版を前提に消すなら: alteroid practice remove ${slug} --if-match ${found.version}）\n`,
    );
  }
}

export async function practiceHistoryCommand(slug: string): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.practices[':slug'].versions.$get({ param: { slug } });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `版の履歴を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const { versions } = (await response.json()) as {
    versions: Array<{ version: number; kind: string; title: string; at: string; chars: number }>;
  };
  if (versions.length === 0) {
    stdout.write(`やり方 ${slug} の版はまだ無い（一度も書かれていないか、打ち間違い）。\n`);
    return;
  }
  for (const v of versions) {
    stdout.write(
      `  版${String(v.version)} [${v.kind}] ${v.title} (${v.at} / ${String(v.chars)} 文字)\n`,
    );
  }
  stdout.write(`本文は: alteroid practice show ${slug} --version <版番号>\n`);
}

export async function practiceEditCommand(
  slug: string,
  options: { kind?: string; title?: string } = {},
): Promise<void> {
  const violation = describeSlugViolation(slug, PRACTICE_SLUG_RULE);
  if (violation !== null) throw new Error(`やり方の名前が不正です: ${violation}`);
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const found = await read(client, target, slug, { acceptUnreadable: true });
  const unreadable = found === 'unreadable';
  const current = unreadable ? null : found;

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    throw new Error(missingKindTitleMessage('edit', slug, unreadable));
  }

  // 黙って上書きしない: エディタを開いている間にクローンが書くと、読んだ時の版が変わっていて 409 になる
  const ifMatch = expectedVersion(found);
  if (unreadable) {
    stdout.write(
      `${slug} は読めない形で入っているので、いまの本文は開けません。雛形から書き直します（保存すると読めない前の内容は置き換わります）。\n`,
    );
  }
  const initial = template(slug);
  const dir = await mkdtemp(join(tmpdir(), 'alteroid-practice-'));
  const path = join(dir, `${slug}.md`);
  const resume = [
    `alteroid practice set ${slug} --file ${shellQuote(path)}`,
    ...(kind === current?.kind ? [] : [`--kind ${shellQuote(kind)}`]),
    ...(title === current?.title ? [] : [`--title ${shellQuote(title)}`]),
  ].join(' ');
  await openEditorKeepingEdits({
    dir,
    path,
    initial: current?.content ?? initial,
    resume,
    alternative: 'alteroid practice set <slug> --file <path>',
  });
  await keepDraftOnFailure(dir, path, resume, async (keep) => {
    const edited = await readFile(path, 'utf8');

    // 雛形のまま閉じたら書かない: 雛形は案内文で、そのまま書くとやり方として保存されるため
    if (
      current === null
        ? edited === initial
        : edited === current.content && kind === current.kind && title === current.title
    ) {
      // 書き換えていないなら書き込まない: 同じ内容でも `PUT` は日誌へ `decision` を積むため
      stdout.write('変更はありません。\n');
      return;
    }
    if (edited.trim().length === 0) throw new Error(emptyBodyMessage(slug));
    try {
      await write(client, target, slug, kind, title, edited, ifMatch);
    } catch (error) {
      if (!(error instanceof PracticeConflictCliError)) throw error;
      keep();
      const theirs = join(dir, `${slug}.current.md`);
      if (error.current !== null) await writeFile(theirs, error.current.content, 'utf8');
      stdout.write(
        [
          `書き換えていません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、消されました）。`,
          `  あなたの編集（残してあります）: ${path}`,
          error.current === null
            ? '  いまのやり方: 無い（消されています）'
            : `  いまのやり方: ${theirs}`,
          ...(error.current === null ? [] : [`  見比べる: diff -u ${theirs} ${path}`]),
          `  取り込んだら \`alteroid practice edit ${slug}\` で開き直して直してください。`,
          `  そのまま置き換えてよいなら \`alteroid practice set ${slug} --file ${path}\`（先の書き込みを消します）。`,
          '',
        ].join('\n'),
      );
      throw new Error(`やり方が読んだ後に変わっていたので書き換えませんでした: ${slug}`, {
        cause: error,
      });
    }
  });
}

function emptyBodyMessage(slug: string): string {
  return (
    `やり方 ${slug}: 本文が空なので置き換えません（既存の本文は変えていません）。` +
    '空にしたいときだけ --allow-empty を付けてください。'
  );
}

export async function practiceSetCommand(
  slug: string,
  options: { file?: string; kind?: string; title?: string; allowEmpty?: boolean } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const found = await read(client, target, slug, { acceptUnreadable: true });
  const unreadable = found === 'unreadable';
  const current = unreadable ? null : found;

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    throw new Error(missingKindTitleMessage('set', slug, unreadable));
  }

  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  if (options.allowEmpty !== true && content.trim().length === 0) {
    throw new Error(emptyBodyMessage(slug));
  }
  await write(client, target, slug, kind, title, content);
}

// 確認を求めない: 版の履歴が消した後も残り、`practice set` で作り直せるため
// 読めない形の行（GET が 409）も版なしで DELETE を打つ: ここで止めると壊れた行を外す回復手段が塞がるため
export async function practiceRemoveCommand(
  slug: string,
  options: { ifMatch?: string } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  // `--if-match` があれば読み直した版へ差し替えない: 人間が判断の根拠にしたのは `practice show` で読んだ内容のため
  const ifMatch = options.ifMatch ?? (await readVersionForRemove(client, target, slug));
  const response = await client.practices[':slug'].$delete({
    param: { slug },
    query: ifMatch === undefined ? {} : { ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { practice?: { content?: string }; version?: string } | null;
    };
    const current = body.current ?? null;
    stdout.write(
      [
        `消していません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、すでに消されました）。`,
        current === null
          ? '  いまのやり方: 無い（すでに消されています）'
          : `  いまのやり方の版: ${current.version ?? '（不明）'}（${String(current.practice?.content?.length ?? 0)} 文字）`,
        ...(current === null
          ? []
          : [
              `  いまの内容を読み直す: \`alteroid practice show ${slug}\`（版そのものは GET /practices/${slug} の version）`,
              `  確かめたうえで消してよければ、もう一度 \`alteroid practice remove ${slug}\`（いまの版を読み直して消します）。`,
            ]),
        '',
      ].join('\n'),
    );
    throw new Error(`やり方が読んだ後に変わっていたので消しませんでした: ${slug}`);
  }
  if (response.status === 428) {
    throw new Error(
      await withErrorReason(
        `消していません: ${slug}（HTTP 428。このデーモンは削除に読んだ版を必須としています。` +
          `\`alteroid practice show ${slug}\` で版を確かめ、\`alteroid practice remove ${slug} --if-match <版>\` で打ち直してください）`,
        response,
      ),
    );
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`やり方の名前として成立しません: ${slug}`);
    }
    if (response.status === 404) {
      throw new Error(`そんなやり方はありません: ${slug}`);
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方を消せませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`消しました: ${slug}\n`);
}

async function readVersionForRemove(
  client: DaemonClient,
  target: Target,
  slug: string,
): Promise<string | undefined> {
  const response = await client.practices[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400 || response.status === 409) {
    return undefined;
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方を読めませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const body = await response.json();
  return 'version' in body && typeof body.version === 'string' ? body.version : undefined;
}

async function connect(
  access: 'read' | 'write',
): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    if (access === 'write') throw new Error(target.note);
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}

// `null` は 404 と 400 だけにする: 他の失敗を `null` にすると、読めていないだけの既存のやり方を無いものとして扱うため
async function read(
  client: DaemonClient,
  target: Target,
  slug: string,
): Promise<PracticeRead | null>;
// `show` は本文を出せないので 409 を失敗のままにする。書き直す口だけが受け入れる。
async function read(
  client: DaemonClient,
  target: Target,
  slug: string,
  options: { acceptUnreadable: true },
): Promise<PracticeRead | null | 'unreadable'>;
async function read(
  client: DaemonClient,
  target: Target,
  slug: string,
  options?: { acceptUnreadable: true },
): Promise<PracticeRead | null | 'unreadable'> {
  const response = await client.practices[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400) return null;
  if (response.status === 409 && options?.acceptUnreadable === true) return 'unreadable';
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方を読めませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const body = await response.json();
  if (!('practice' in body)) return null;
  return {
    kind: body.practice.kind,
    title: body.practice.title,
    content: body.practice.content,
    ...('version' in body && typeof body.version === 'string' ? { version: body.version } : {}),
  };
}

type PracticeRead = { kind: string; title: string; content: string; version?: string };

function missingKindTitleMessage(
  command: 'edit' | 'set',
  slug: string,
  unreadable: boolean,
): string {
  const usage = `alteroid practice ${command} <slug> --kind <種類> --title <題>`;
  return unreadable
    ? `やり方 ${slug} は読めない形で入っていて、いまの種類と題を引き継げません。` +
        `書き直すには --kind と --title を両方指定してください（読めない前の内容は残りません）: ${usage}`
    : `新しいやり方には --kind と --title が両方必要です: ${usage}`;
}

// 読めない形の行へ `null`（「無かった」）を送らない: pg の実装は行の存在を衝突として 409 にする（fs は通す）。
function expectedVersion(current: PracticeRead | null | 'unreadable'): string | null | undefined {
  if (current === 'unreadable') return undefined;
  return current === null ? null : current.version;
}

class PracticeConflictCliError extends Error {
  readonly current: { kind: string; title: string; content: string } | null;
  constructor(slug: string, current: { kind: string; title: string; content: string } | null) {
    super(`やり方が読んだ後に変わっています: ${slug}`);
    this.current = current;
  }
}

async function write(
  client: DaemonClient,
  target: Target,
  slug: string,
  kind: string,
  title: string,
  content: string,
  ifMatch?: string | null,
): Promise<void> {
  const response = await client.practices[':slug'].$put({
    param: { slug },
    json: ifMatch === undefined ? { kind, title, content } : { kind, title, content, ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { practice?: { kind?: string; title?: string; content?: string } } | null;
    };
    const now = body.current?.practice;
    throw new PracticeConflictCliError(
      slug,
      now === undefined
        ? null
        : { kind: now.kind ?? '', title: now.title ?? '', content: now.content ?? '' },
    );
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(
        `書き換えられませんでした: ${slug}（種類・題・スラッグのどれかが不正かもしれません）`,
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `書き換えられませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`書き換えました: ${slug}\n`);
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// 雛形に「何をしてよいかの表」を書かせない: `permissions.yaml` 的な一覧にしないため
function template(slug: string): string {
  return `# ${slug}

（ここに仕事のやり方を書きます。これは実行される定義ではなく、読んで
従うかどうかはそのときのクローンが決めます）
`;
}
