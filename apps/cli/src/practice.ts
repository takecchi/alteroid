import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { createClient, type DaemonClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { describeEditorFailure, readInputFile } from './input-errors.js';

/**
 * `alteroid practice` — 仕事のやり方を読む・書き換える・消す（#1055 段3③）。
 *
 * **`alteroid memory`（`memory.ts`）が型紙である。** サブコマンドの構成
 * （`list` / `show` / `edit` / `set` / `remove`）はそちらに揃えてある。
 *
 * **やり方に無い概念は写さない。**
 * - `PracticeStore` は human guard（`memory` の `markHumanTouched` に当たる
 *   保護状態）を持たない（`packages/core/src/store.ts` の `PracticeStore` の
 *   doc）。ここには対応する概念が無い
 * - `kind`（frontmatter の種別 `premise`/`fact`/`indexed` に相当するもの）は
 *   `practiceKindSchema` が自由文字列で、列挙ではない（`practiceKindSchema`
 *   の doc「⛔ ここを `z.enum` にしないこと」）。CLI でも固定の選択肢にしない
 *   — Web UI（`apps/web/app/routes/practice-detail.tsx`）で `<select>` を
 *   置かなかったのと同じ理由
 * - **`kind` / `title` はやり方の本体（`content`）とは別の必須フィールドで
 *   ある。** `PracticeStore.write` は `slug`/`kind`/`title`/`content` の
 *   全文置換で、`content` だけの部分更新は無い（`memory` の `PUT` が
 *   `{content}` だけで足りるのとの違い）。`set`/`edit` は `--kind`/`--title`
 *   を受け、既存のやり方を編集するときは省略すると現在の値を引き継ぐ
 *
 * **`apply` / `enforce` に当たるサブコマンドは無い。** やり方は読む素材で
 * あって実行される定義ではない（`docs/north_star.md`、段3②・#1316 と同じ
 * 設計）。
 *
 * **CLI 専用の HTTP 経路は無い。** #1316 で足した `GET`/`PUT`/`DELETE
 * /practices(/:slug)` にそのまま乗る（`docs/PRD.md`「Web UI は API の
 * 特権的な消費者ではない」と同じ理由が CLI にも効く——CLI もデーモンの
 * HTTP API の薄いクライアントに徹する）。
 *
 * **版の履歴（#1309）も同じ形。** `GET /practices/:slug/versions(/:version)`
 * にそのまま乗る——`history` サブコマンドと、`show --version` オプションで出す。
 */

/** 一覧に出す1件（`GET /practices` の要素）。 */
export interface PracticeSummary {
  slug: string;
  kind: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 本文の文字数（コードポイント数。保存された値ではなく本文から導出——#1340）。 */
  chars: number;
}

export async function practiceListCommand(): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client } = conn;
  const response = await client.practices.$get();
  if (!response.ok) {
    stdout.write(
      `${await withErrorReason(`やり方の一覧を読めませんでした（HTTP ${String(response.status)}）`, response)}\n`,
    );
    return;
  }
  const { practices, unreadable = [] } = (await response.json()) as {
    practices: PracticeSummary[];
    /** 読めなかった行（issue #2346）。1件でも在るときだけ載る。 */
    unreadable?: { slug?: string; reason: string }[];
  };
  if (practices.length === 0 && unreadable.length === 0) {
    // **「0 件」で終わらせない。** `memory list` と同じ理由——空なのか
    // 読めていないのかを、次の一手が無いと人間の側から区別できない。
    // **ただしここは異常ではない。** やり方が1件も無いのは正常な状態
    // （`practice_list` クローンの道具の文言と同じ語彙）。**「正常」と言えるのは、
    // 読めない行が0件のときだけ**（issue #2346。下の断りを見よ）。
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
  // **読めない行は末尾で言う**（issue #2346）。0件なら何も出さない。題・本文は出ない
  // （デーモンが返さない）。slug が取れた行は書き直す（`practice edit`）か消せる。
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
  // **一覧から次の一手へつなぐ。** `memory list` と同じ（`memoryListCommand` の doc）。
  if (practices.length > 0) stdout.write('本文を読むには: alteroid practice show <slug>\n');
}

export async function practiceShowCommand(
  slug: string,
  options: { version?: number } = {},
): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client } = conn;

  if (options.version !== undefined) {
    const response = await client.practices[':slug'].versions[':version'].$get({
      param: { slug, version: String(options.version) },
    });
    if (!response.ok) {
      // 「無い」は 404 だけ。5xx 等を「そんな版はありません」と言わない。
      stdout.write(
        `${
          response.status === 400
            ? `版番号として成立しません: ${String(options.version)}`
            : response.status === 404
              ? `そんな版はありません: ${slug} 版${String(options.version)}`
              : await withErrorReason(
                  `版を読めませんでした: ${slug} 版${String(options.version)}（HTTP ${String(response.status)}）`,
                  response,
                )
        }\n`,
      );
      return;
    }
    const body = await response.json();
    const content = 'version' in body ? body.version.content : '';
    stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  const found = await read(client, conn.target, slug);
  if (found === null) {
    throw new Error(`そんなやり方はありません: ${slug}`);
  }
  const content = found.content;
  stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

/**
 * やり方の版の履歴を出す（#1309）。**メタだけ**——本文は
 * `alteroid practice show <slug> --version <n>` で読む。
 */
export async function practiceHistoryCommand(slug: string): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client } = conn;
  const response = await client.practices[':slug'].versions.$get({ param: { slug } });
  if (!response.ok) {
    stdout.write(
      `${await withErrorReason(`版の履歴を読めませんでした（HTTP ${String(response.status)}）`, response)}\n`,
    );
    return;
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

/**
 * `$EDITOR` で本文を開いて、閉じたら反映する。
 *
 * **無い slug でも開ける**（`memory edit` と同じ——`PUT` は全文置換で、
 * 存在しない slug でも作られる）。**`--kind`/`--title` は省略できる**が、
 * 意味は状況で変わる——既存のやり方なら現在の値を引き継ぎ、新しいやり方
 * なら両方とも必須（`practiceKindSchema` が `kind` に `min(1)` を課す
 * ので、省略したまま新規作成しようとすると人間に分かる形で断る）。
 */
export async function practiceEditCommand(
  slug: string,
  options: { kind?: string; title?: string } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const current = await read(client, target, slug);

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    stdout.write(
      '新しいやり方には --kind と --title が両方必要です: ' +
        'alteroid practice edit <slug> --kind <種類> --title <題>\n',
    );
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-practice-'));
  const path = join(dir, `${slug}.md`);
  try {
    await writeFile(path, current?.content ?? template(slug), 'utf8');
    await openEditor(path);
    const edited = await readFile(path, 'utf8');

    if (
      current !== null &&
      edited === current.content &&
      kind === current.kind &&
      title === current.title
    ) {
      // **書き換えていないなら書き込まない**（`memory edit` と同じ理由——
      // 同じ内容でも `PUT` は日誌へ `decision` を積むので、押し戻すたびに
      // 「人間が書き換えた」という跡が実際には無かった変更ぶん増える）。
      stdout.write('変更はありません。\n');
      return;
    }
    await write(client, target, slug, kind, title, edited);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * ファイル（または標準入力）の内容で丸ごと置き換える。
 *
 * **`--kind`/`--title` の省略時は既存の値を引き継ぐ**（`edit` と同じ規則）。
 * 新規作成では両方必須。
 */
export async function practiceSetCommand(
  slug: string,
  options: { file?: string; kind?: string; title?: string } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const current = await read(client, target, slug);

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    stdout.write(
      '新しいやり方には --kind と --title が両方必要です: ' +
        'alteroid practice set <slug> --kind <種類> --title <題>\n',
    );
    return;
  }

  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  await write(client, target, slug, kind, title, content);
}

/**
 * やり方を1つ消す。
 *
 * **確認を求めない**（`memory remove` と同じ理由——Web UI に確認の段が
 * 無く、CLI にだけ `--yes` を要求すると「CLI だけができないこと」を作る）。
 * 消した事実は日誌に残る。
 *
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** `memory.ts` の
 * `memoryRemoveCommand` と同じ理由（#1621 / #1641）。
 *
 * **「無い」と「名前として不正」は、サーバが 404 と 400 で分けているものを
 * そのまま伝える。それ以外（401/403/5xx）を、この2つのどちらかだと取り違え
 * ない**——以前はここが「400 以外は全部『無い』」という形をしていたため、
 * 認証切れやサーバの内部エラーでも「そんなやり方はありません」と誤案内して
 * いた。
 */
export async function practiceRemoveCommand(slug: string): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.practices[':slug'].$delete({ param: { slug } });
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

/**
 * **`target` も一緒に返す。** 書き込み系（`write` / `practiceRemoveCommand`）
 * が HTTP の失敗を `describeAuthFailure` で判定するのに要る（#1641。
 * `memory.ts` の `connect` と同じ理由）。
 *
 * **`access: 'write'` のときは、未ログインの note を例外にする**（#2456、クローン
 * teto の判断 2026-09-30。`memory.ts` の `connect` と同じ）。読み取り系（`'read'`）は
 * 今のまま、note を stdout に出して `null` を返す。
 */
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

/**
 * 無ければ `null`。**`null` は「無い」（404）と「名前が成立しない」（400）だけである。**
 * それ以外の失敗（401/403/5xx）を `null` にすると、`show` は「そんなやり方はありません」と
 * 嘘を言い、`edit` / `set` は**読めていないだけの既存のやり方を無いものとして**扱う
 * （`memory.ts` の `read` と同じ理由）。読めなかった理由は例外で上へ通す。
 */
async function read(
  client: DaemonClient,
  target: Target,
  slug: string,
): Promise<{ kind: string; title: string; content: string } | null> {
  const response = await client.practices[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400) return null;
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
  return 'practice' in body
    ? { kind: body.practice.kind, title: body.practice.title, content: body.practice.content }
    : null;
}

/**
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** `memory.ts` の
 * `write` と同じ理由（#1641）。
 *
 * **400 は「種類・題・スラッグのどれかが不正」の意味を保つ**（サーバの
 * `practiceSlugSchema` / `practiceKindSchema` 検証。`PUT /practices/:slug`
 * が返す唯一の明示的な失敗コード）。**それ以外（401/403/5xx）を、それだと
 * 取り違えない。**
 */
async function write(
  client: DaemonClient,
  target: Target,
  slug: string,
  kind: string,
  title: string,
  content: string,
): Promise<void> {
  const response = await client.practices[':slug'].$put({
    param: { slug },
    json: { kind, title, content },
  });
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

async function openEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', (error) =>
      reject(
        describeEditorFailure(editor, { error }, 'alteroid practice set <slug> --file <path>'),
      ),
    );
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          describeEditorFailure(
            editor,
            { code, signal },
            'alteroid practice set <slug> --file <path>',
          ),
        );
    });
  });
}

/**
 * 空から始めるときの雛形。
 *
 * **「何をしてよいかの表」を書かせない**（`memory` の `template` と同じ
 * 理由——`permissions.yaml` 的な一覧にしない、AGENTS.md 地雷表3行目）。
 */
function template(slug: string): string {
  return `# ${slug}

（ここに仕事のやり方を書きます。これは実行される定義ではなく、読んで
従うかどうかはそのときのクローンが決めます）
`;
}
