// mutate-core.mjs — 変異試験ハーネスの「純粋な層」。
//
// ここにあるのは手順を組み立てる関数だけである。CLI の argv 解析・exit code・
// `--help` の類は `mutate.mjs`（薄い CLI 層）に置く。自己検証（`mutate-selftest.mjs`）
// はここの関数を直接呼ぶ — サブプロセスを起こしたり、まして殺したりしない。
//
// **ここにテスト用の抜け道（環境変数で分岐する類）を作らない。** 抜け道自体が
// 次の穴になる。自己検証で「途中で終わった状態」が要るときは、この層の関数を
// 順番どおり呼んで、その先を単に呼ばないことで表現する（呼び出す側の話であって、
// この層の中に条件分岐を足す話ではない）。
//
// 依存なし・ビルド不要（node の組み込みモジュールだけを使う）。単一ファイルという
// 制約は、CLI 層・自己検証層と分けたことで崩れているが、それらは同じディレクトリの
// 素の `import` で足しているだけで、node_modules には一切依存しない。

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, '..', '..', '..');

export const MARKER_PATH = path.join(ROOT, 'MUTATION-IN-PROGRESS.json');
export const BACKUP_DIR = path.join(ROOT, '.mutation-testing', 'backups');

// **印も控えディレクトリも .gitignore に入れない。** git status と ls の両方に
// 出るのが狙いである。`git add -A` で誤って混入するリスクはあるが、混入は
// 「知らないファイルがステージに乗る」という騒がしい失敗で気づける。印が無い
// ことは、何も出ないという静かな失敗なので、そもそも気づく機会が無い。
// うるさい失敗のほうを選ぶ。

export class HarnessError extends Error {}

export function log(line = '') {
  process.stdout.write(`${line}\n`);
}

export function section(title) {
  log('');
  log(`── ${title} ──`);
}

export function md5(content) {
  return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function absPath(relFile) {
  return path.join(ROOT, relFile);
}

export function readRepoFile(relFile) {
  return fs.readFileSync(absPath(relFile), 'utf8');
}

export function writeRepoFile(relFile, content) {
  fs.writeFileSync(absPath(relFile), content);
}

export function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function gitStatusPorcelainFor(relFile) {
  return execFileSync('git', ['status', '--porcelain', '--', relFile], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

/** `from`/`to` を単純な文字列置換で数える・置換する。正規表現は使わない
 * （`from` に正規表現のメタ文字が入っていると意図しない一致をするため）。
 * `String.prototype.replaceAll` と同じ非重複・左から右の意味論。
 */
export function countOccurrences(haystack, needle) {
  if (needle === '') return Infinity; // 歯2: 空パターンは呼び出し側で先に弾く
  return haystack.split(needle).length - 1;
}

export function replaceAllLiteral(haystack, from, to) {
  return haystack.split(from).join(to);
}

// ── 判定の語彙 ──────────────────────────────────────────────────────
//
// **歯7の裏面**: 判定行（検出/生存/不明）と生ログ（vitest の生出力）は別区画に
// 出す。生ログには当然 `Tests N passed` のような文言が乗るが、それは加工前の
// 証跡であって判定ではない。禁止語チェックは判定行の側にだけ掛ける。
//
// **判定行に固定の `M1:`/`M2:`/`M3:` を焼き込まない。** かつてはこの3つを
// 判定の種別そのものとして固定文字列に埋め込んでいたが、変異の spec 自身が
// `id: 'M4'` のような名前を持てる（`SKILL.md` の解説表が `M1..M6` を変異の
// 名前として使っている）ため、「種別としての M2」と「変異としての M4」が
// 衝突し、判定行が実際の変異と無関係な番号を名乗る欠陥があった
// （実測で確認・修正。マネージャーからの差し戻し）。判定行には常に
// `spec.id` を差し込み、種別は日本語の語（検出/生存/不明）そのもので表す。
export const FORBIDDEN_IN_JUDGEMENT = [
  '合格',
  'OK',
  'ok',
  'pass',
  'passed',
  '成功',
  '問題なし',
  '緑',
  '✓',
];

/** 判定の種別ごとの文面テンプレート。`mutationId` を差し込んで完成させる。 */
const JUDGEMENT_TEMPLATES = {
  検出: (mutationId) => `変異 ${mutationId}: 検出 — この歯はこの変異を捕まえた`,
  生存: (mutationId) =>
    `変異 ${mutationId}: 生存 — この歯はこの変異を検出できない\n次にやること: 歯を強める。緩めるのではない`,
  不明: (mutationId) => `変異 ${mutationId}: 不明 — 変異が成果物へ届いていない（生存ではない）`,
};

function assertNoForbiddenWords(text, contextLabel) {
  for (const word of FORBIDDEN_IN_JUDGEMENT) {
    if (text.includes(word)) {
      throw new HarnessError(`${contextLabel} に禁止語 "${word}" が混ざっている: ${text}`);
    }
  }
}

// ── id の禁止語検査（#348） ─────────────────────────────────────────
//
// **禁止語検査そのものは判定行の語彙を守るために在り、外してはいけない**
// （Issue #348 に明記）。ただし `spec.id` は判定行へ差し込まれるため、
// 部分文字列で見ると `bypass`（`pass` を含む）・`broken`（`ok` を含む）・
// `lookup`（`ok` を含む）のような、変異の名前として自然に出てくる語が
// 誤って拒否される。ここは「判定の語彙にだけ掛け、id には掛けない」の
// うち id 側を担当する — id は掛けるが、部分文字列ではなく**語の境界**で見る。
//
// ASCII の語（OK / ok / pass / passed）は、英数字に挟まれていたら当てない
// （`lookup-drop` の `ok` は `lo` と `up` に挟まれているので当てない）。
// `-` や文字列の端で区切られていれば当てる（`token-ok` / `m1-ok`）。
// 非 ASCII の語（合格 / 成功 / 問題なし / 緑 / ✓）は、変異 id の語彙
// （英数字とハイフン）に紛れ込みようが無いので部分一致のままでよい —
// この判断は id の命名規約（`validateSpec` はパス区切りと `..` しか
// 禁じておらず、非 ASCII 文字自体は形式上は禁止していない）を前提にした
// 推測であり、確認はしていない。

function isAsciiForbiddenWord(word) {
  return /^[A-Za-z0-9]+$/.test(word);
}

/** ASCII の禁止語が、id の中に「単独の語」として現れるかを見る。
 * 英数字に挟まれた出現（複合語の一部）は無視し、他の出現が無いか探し続ける。
 */
function forbiddenWordHitsIdentifier(id, word) {
  if (!isAsciiForbiddenWord(word)) {
    return id.includes(word);
  }
  let searchFrom = 0;
  for (;;) {
    const idx = id.indexOf(word, searchFrom);
    if (idx === -1) return false;
    const before = idx > 0 ? id[idx - 1] : null;
    const after = idx + word.length < id.length ? id[idx + word.length] : null;
    const leftIsBoundary = before === null || !/[A-Za-z0-9]/.test(before);
    const rightIsBoundary = after === null || !/[A-Za-z0-9]/.test(after);
    if (leftIsBoundary && rightIsBoundary) return true;
    searchFrom = idx + 1;
  }
}

/** id 自体を検査する。落ちたときは「id 由来」と分かるメッセージにする
 * （テンプレートが汚れている場合と同じ文言になっていた #348 の欠陥の修正）。
 */
function assertNoForbiddenWordsInIdentifier(id, contextLabel) {
  for (const word of FORBIDDEN_IN_JUDGEMENT) {
    if (forbiddenWordHitsIdentifier(id, word)) {
      throw new HarnessError(
        `${contextLabel}: 変異 id "${id}" そのものが禁止語 "${word}" に単独の語として一致した` +
          '（判定テンプレートの語彙が汚れているのではなく、id 由来）。' +
          'id の部分文字列に当たっただけなら語の境界を見直すこと。',
      );
    }
  }
}

/**
 * ハーネス自身の判定語彙に禁止語が混ざっていないかを検査する口。
 *
 * ここで検査するのはテンプレートそのもの（サンプル id `<id>` で埋めたもの）。
 * **これは起動時の安い自己検査であって、実際に判定を出すときの検査ではない。**
 * 変異の id 自体に禁止語が混ざっている可能性は、id を差し込んだ「後」の文言を
 * 検査する `formatJudgement` の側が見る（`judge` を呼ぶたびに毎回効く）。
 * 定義（テンプレート）だけ検査して整形後を素通りする形にしない。
 */
export function checkJudgementVocabulary() {
  const problems = [];
  for (const [name, template] of Object.entries(JUDGEMENT_TEMPLATES)) {
    const sample = template('<id>');
    try {
      assertNoForbiddenWords(sample, `JUDGEMENT_TEMPLATES.${name}`);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (problems.length > 0) {
    throw new HarnessError(`判定語彙の自己検査に失敗:\n${problems.join('\n')}`);
  }
  return { ok: true, checked: Object.keys(JUDGEMENT_TEMPLATES) };
}

/**
 * 種別 + 変異 id から判定行を組み立てる。
 *
 * **禁止語検査は2段に分ける（#348）**: (1) id そのものを、部分文字列ではなく
 * 語の境界で検査する（`assertNoForbiddenWordsInIdentifier`） (2) テンプレート
 * 由来の語彙を、id を差し込む「前」の状態で検査する（プレースホルダで埋め、
 * id を混ぜない）。以前は id を差し込んだ「後」の完成文を丸ごと部分文字列で
 * 検査していたため、id の部分文字列（`bypass` の中の `pass` 等）が誤って
 * 拒否されていた。禁止語検査そのものは判定の語彙を守るために在り続ける —
 * 外したのではなく、掛ける対象を「判定の語彙」と「id」に分けて、それぞれに
 * 合った基準（部分文字列 / 語の境界）を使うようにした。
 */
export function formatJudgement(category, mutationId) {
  const template = JUDGEMENT_TEMPLATES[category];
  if (!template) throw new HarnessError(`未知の判定種別: ${category}`);

  assertNoForbiddenWordsInIdentifier(String(mutationId), `judge(${mutationId})`);

  const templateOnly = template('␀id-placeholder␀');
  assertNoForbiddenWords(templateOnly, `JUDGEMENT_TEMPLATES.${category}（id 差し込み前）`);

  return template(mutationId);
}

/** 生存/検出/不明のどれかを、成果物検査とテスト結果から決める（id とは無関係）。 */
export function decideJudgementCategory(artifactResult, testResult) {
  if (artifactResult.artifactState === 'undelivered') {
    return '不明';
  }
  if (!testsRanCleanly(testResult)) {
    throw new HarnessError(
      'テストの集計行（Test Files / Tests）が見つからない。' +
        '「落ちた」のか「1本も走らなかった」のか区別できないので判定を出さない。',
    );
  }
  const allPassed = testsAllPassed(testResult);
  return allPassed ? '生存' : '検出';
}

// ── 印 ──────────────────────────────────────────────────────────────

export function markerExists() {
  return fs.existsSync(MARKER_PATH);
}

export function writeMarkerFile(marker) {
  fs.writeFileSync(MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`);
}

export function clearMarker() {
  fs.rmSync(MARKER_PATH, { force: true });
}

/**
 * 印を読み、自己整合性を検査する。
 *
 * **印の中に原文そのもの（`originalContent`）を持たせてある。** 控え
 * （`.mutation-testing/backups/`）が汚染されている場合、復元の材料が控え側に
 * ゼロになる。「落ちた本人でなくても復元できる」という条件は、原文が印の
 * 側にもあって初めて満たせる。ここではその原文自身の md5 を計算し直し、
 * 印が記録している `md5Pre` と一致するかを返す（印そのものが壊れている場合を
 * 素通ししないため）。
 */
export function readMarkerVerified() {
  if (!markerExists()) {
    throw new HarnessError('印が無い。');
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
  } catch (err) {
    throw new HarnessError(`印(JSON)が壊れていて読めない: ${err.message}`);
  }
  const required = ['file', 'md5Pre', 'originalContent', 'backupPath', 'headBefore'];
  for (const key of required) {
    if (!(key in marker)) {
      throw new HarnessError(`印に必須フィールド "${key}" が無い。印そのものが壊れている。`);
    }
  }
  const originalContentMd5 = md5(marker.originalContent);
  const selfConsistent = originalContentMd5 === marker.md5Pre;
  return { marker, originalContentMd5, selfConsistent };
}

// ── spec の形の検査（#301） ─────────────────────────────────────────
//
// **書く前に検査し、不正なら1バイトも書かずに落とす。** 歯6（書く前にパターンの
// 一意性を検査する）と同じ位置・同じ理由——書いてから気づくと、ファイルが
// 変異したまま残る。`applyMutation` の先頭（手順1より前）で呼ぶことで、
// 控え（手順3）・印（手順6）・変異（手順7）のどれにも到達させない。
//
// **`id` はただの表示名ではない。** `${spec.id}.bak`（このファイル内
// `buildMarker` の少し下、控えのファイル名）としてファイル名の一部になる
// ため、パス区切り（`/` `\`）や `..` を許すと BACKUP_DIR の外へ書ける形に
// なる。型検査だけでは塞げない穴なので、ここで明示的に弾く。
export function validateSpec(spec) {
  const problems = [];

  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new HarnessError(
      `[0] spec 検査で拒否した。何も書き込んでいない。spec はオブジェクトでなければならない` +
        `（実際: ${Array.isArray(spec) ? '配列' : typeof spec}）。`,
    );
  }

  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    problems.push(`id は必須の非空文字列である（実際: ${JSON.stringify(spec.id)}）`);
  } else if (spec.id.includes('/') || spec.id.includes('\\') || spec.id.includes('..')) {
    problems.push(
      `id にパス区切り（/ または \\）や .. を含めることはできない（控えのファイル名 ` +
        `\${spec.id}.bak に直接使われるため、BACKUP_DIR の外へ書ける形になる）。実際: ` +
        `${JSON.stringify(spec.id)}`,
    );
  }

  if (typeof spec.file !== 'string' || spec.file.length === 0) {
    problems.push(`file は必須の非空文字列である（実際: ${JSON.stringify(spec.file)}）`);
  }

  // from の空文字は歯2（手順5）が既に見ているが、キーそのものの不在・
  // 非文字列は誰も見ていなかった（#301）。歯2 はそのまま残し、ここでは
  // 「無い／文字列でない／空文字」の3つをまとめて見る。
  if (typeof spec.from !== 'string' || spec.from.length === 0) {
    problems.push(`from は必須の非空文字列である（実際: ${JSON.stringify(spec.from)}）`);
  }

  // to は空文字を許す — 文言を消す変異は正当である。型だけを見る。
  if (typeof spec.to !== 'string') {
    problems.push(`to は必須の文字列である（空文字は許容する。実際: ${JSON.stringify(spec.to)}）`);
  }

  if (!Number.isInteger(spec.expect) || spec.expect < 1) {
    problems.push(`expect は1以上の整数でなければならない（実際: ${JSON.stringify(spec.expect)}）`);
  }

  if (problems.length > 0) {
    throw new HarnessError(
      '[0] spec 検査で拒否した。何も書き込んでいない（控え・印・変異のいずれも0バイト）:\n' +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

/** 印の中身を組み立てる。落ちた本人でなくても復元できることが条件。 */
function buildMarker(spec, ctx) {
  return {
    mutationId: spec.id,
    file: spec.file,
    from: spec.from,
    to: spec.to,
    // 復元後の後始末（dist の再 build と、その検証）に要る。`target` が無ければ
    // 後始末も無い。`artifact` が無ければ build 成功しか確認できない
    // （内容までは確認できないことを後始末の側で明示する）。
    target: spec.target ?? null,
    artifact: spec.artifact ?? null,
    // 印がどの段階で止まったかを持つ。「ソースが変異したまま」と「ソースは
    // 復元済みで dist の確認が取れていない」は別の状態であり、status は
    // これに応じて違う説明を出す（同じ「印が残っている」でも次にやることが
    // 違う）。旧い印（このフィールドが無い）は 'source-mutated' とみなす
    // （後方互換。status 側で `marker.stage ?? 'source-mutated'` にする）。
    stage: 'source-mutated',
    startedAt: nowIso(),
    sessionId: process.env.CLAUDE_SESSION_ID ?? process.env.ALTEROID_SESSION_ID ?? null,
    pid: process.pid,
    headBefore: ctx.headBefore,
    // 変異を当てる前の `git status --porcelain -- <file>`（#321）。12c が
    // 比較する相手はこれであって、HEAD（porcelain が空であること）ではない。
    // 旧い印にはこのフィールドが無い — restoreMutation 側で
    // `marker.statusBefore === undefined` のときは比較しない（判定できない、
    // という3つ目の状態。空文字と比べる形に倒すと #321 の欠陥が戻る）。
    statusBefore: ctx.statusBefore,
    md5Pre: ctx.md5Pre,
    // **原文そのもの。** 控えが汚染・消失していても、これがあれば戻せる。
    originalContent: ctx.original,
    backupPath: path.relative(ROOT, ctx.backupPath),
    manualRestore: {
      note: 'ハーネスを使わない復元手順。控えをそのまま書き戻し、md5 を照合する。',
      command: `cp '${path.relative(ROOT, ctx.backupPath)}' '${spec.file}'`,
      verifyMd5Command: `md5sum '${spec.file}'`,
      expectedMd5: ctx.md5Pre,
    },
    alternativeWithCaveat:
      `git show HEAD:${spec.file} > ${spec.file} でも戻せるが、これは HEAD に正解が在る状況でのみ` +
      '当たる。未コミットの修正を持っているときは当たらない。',
  };
}

// ── 変異1本ぶんの手順 ───────────────────────────────────────────────
//
// 順序がそのまま歯である。入れ替えない。

/**
 * 手順1〜7。印を「変異を書き込む前」に置く（手順6が手順7より前）。
 * ここを入れ替えると、書いてから死んだときに印の無いまま変異が残る
 * （自己検証「中断」参照。この対比自体はこの関数の中には無い —
 * 本体に抜け道を作らないため、対比は selftest 側が別の直線的な関数として持つ）。
 */
export function applyMutation(spec) {
  // 0. spec の形を検査する。ここで拒否すれば、控え・印・変異のどれも
  //    まだ何も書いていない（このチェックはファイルにもマーカーにも触れない）。
  validateSpec(spec);

  if (markerExists()) {
    throw new HarnessError(
      '印が既にある。前回の変異が復元されていない可能性がある。`status` で確認すること。',
    );
  }

  // 1. HEAD を記録する（同じツリーで HEAD を動かすのも汚染に見えるため）。
  const headBefore = gitHead();
  log(`[1] HEAD (適用前): ${headBefore}`);

  // 1b. 対象ファイルの git status --porcelain を、変異を当てる前に記録する
  //     （#321）。復元後の 12c はこれと比較する — 「HEAD と同じか」ではなく
  //     「変異の前後で変わっていないか」を見る。対象ファイル自身に正当な
  //     未コミット変更が在るのは、変異試験では異常ではなく通常である。
  const statusBefore = gitStatusPorcelainFor(spec.file);
  log(`[1b] 対象ファイルの git status --porcelain（変異前）: ${JSON.stringify(statusBefore)}`);

  // 2. 原文を読み、読んだ中身から md5Pre を計算する（ファイルを2回読まない）。
  const original = readRepoFile(spec.file);
  const md5Pre = md5(original);
  log(`[2] 原文を読んだ。md5Pre=${md5Pre} (${spec.file}, ${original.length} 文字)`);

  // 3. 控えを書く。
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `${spec.id}.bak`);
  fs.writeFileSync(backupPath, original);
  log(`[3] 控えを書いた: ${path.relative(ROOT, backupPath)}`);

  // 4. 照合1: 控えをディスクから読み直して md5 が一致することを要求する。
  //    不一致なら変異を当てずに中止する。
  const rereadBackup = fs.readFileSync(backupPath, 'utf8');
  const md5Backup1 = md5(rereadBackup);
  if (md5Backup1 !== md5Pre) {
    throw new HarnessError(
      `[4] 照合1 失敗: 控えを読み直した md5 (${md5Backup1}) が原文の md5 (${md5Pre}) と` +
        '一致しない。変異を当てずに中止する。',
    );
  }
  log(`[4] 照合1: 控えの md5 が原文と一致 (${md5Backup1})`);

  // 5. 書く前にパターンを検査する。from が空でないこと（歯2）。
  //    一致件数が expect と厳密一致すること（歯3・歯6: 書いてから数えると
  //    落ちたときにファイルが変異したまま残るので、書く前に数える）。
  if (spec.from === '') {
    throw new HarnessError('[5] 歯2 違反: from が空文字である。空パターンは全箇所へ振り切れる。');
  }
  const occurrences = countOccurrences(original, spec.from);
  if (occurrences !== spec.expect) {
    throw new HarnessError(
      `[5] 歯3/6 違反: 一致件数が期待と不一致（実際 ${occurrences} / 期待 ${spec.expect}）。` +
        '書き込みは行わない。',
    );
  }
  log(`[5] パターン検査: 一致件数 ${occurrences} が期待 ${spec.expect} と一致`);

  // 6. 印を置く。**変異を書き込む前である。** ここが手順の要点で、7と入れ替えない。
  const marker = buildMarker(spec, { headBefore, statusBefore, md5Pre, backupPath, original });
  writeMarkerFile(marker);
  log(
    `[6] 印を設置した: ${path.relative(ROOT, MARKER_PATH)}（原文 ${original.length} 文字を埋め込み済み）`,
  );

  // 7. 変異を書き込む。md5Post !== md5Pre を要求する（歯5: 当て忘れの検出）。
  const mutated = replaceAllLiteral(original, spec.from, spec.to);
  writeRepoFile(spec.file, mutated);
  const md5Post = md5(mutated);
  if (md5Post === md5Pre) {
    throw new HarnessError(
      `[7] 歯5 違反: 変異前後の md5 が同一 (${md5Post})。当て忘れの疑いがある。`,
    );
  }
  log(`[7] 変異を書き込んだ: md5Post=${md5Post}（md5Pre と異なる: 確認済み）`);

  return { headBefore, md5Pre, backupPath, marker };
}

/** 手順8〜9: 対象パッケージを build し、成果物を検査する。
 * spec.target が null なら「build 境界を跨がない」と明示して build/artifact を
 * 両方スキップする（この判断は spec を書く側の責任。理由をログへ残す）。
 */
export function buildAndCheckArtifact(spec) {
  if (spec.target === null || spec.target === undefined) {
    log('[8] build: 対象外（この変異は dist 経由で消費されないと spec が明示している）');
    log('[9] 成果物検査: 対象外（8と同じ理由。9は8の続きなので、8を飛ばすなら9も飛ばす）');
    return { buildSkipped: true, artifactState: 'not-applicable' };
  }

  // #246: pnpm-workspace.yaml に failIfNoMatch: true があるので、spec.target の打ち間違い
  // （実在しないパッケージ名）は「一致するプロジェクトが無い」として exit 非0 で落ちる。
  // 以前はここが exit 0（何もビルドされないまま「成功」）に化けていた。
  const result = spawnSync('pnpm', ['--filter', spec.target, 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  log(`[8] build (--filter ${spec.target}): exit=${result.status}`);
  log('--- build 生ログ ここから ---');
  log((result.stdout ?? '') + (result.stderr ?? ''));
  log('--- build 生ログ ここまで ---');

  if (!spec.artifact) {
    log(
      '[9] 成果物検査: 対象外（spec に artifact 検査が設定されていない）。' +
        '**build の終了コードでは判定しない** — これは「build が走ったか」しか答えない。',
    );
    return { buildSkipped: false, buildExitCode: result.status, artifactState: 'not-checked' };
  }

  const artifactAbs = absPath(spec.artifact.file);
  let delivered = false;
  if (fs.existsSync(artifactAbs)) {
    const artifactContent = fs.readFileSync(artifactAbs, 'utf8');
    delivered = artifactContent.includes(spec.artifact.contains);
  }
  log(
    `[9] 成果物検査: ${spec.artifact.file} を実際に読んで "${spec.artifact.contains}" を探した ` +
      `→ ${delivered ? '見つかった（届いている）' : '見つからなかった（届いていない）'}`,
  );

  return {
    buildSkipped: false,
    buildExitCode: result.status,
    artifactState: delivered ? 'delivered' : 'undelivered',
  };
}

// **既定の並列度。この器の狭さに合わせた値であって、変異試験の性質が決めた値
// ではない。** #331: `baseline` / `run --plan` からも並列度を外から渡せるように
// したが、呼び出し側が何も渡さなければこれまでどおり `--maxWorkers=4` で走ること
// を歯として固定する（`mutate.mjs` の `--max-workers` を渡さなければここへ落ちる）。
// 既定を消すと、渡し忘れた回だけ vitest の既定（`nproc` 相当）へ跳ね上がる。
export const DEFAULT_MAX_WORKERS = 4;

/**
 * `runTests` が `spawnSync` へ渡す args 配列そのものを組み立てる。
 *
 * **`runTests` から切り出した理由**: `spawnSync` を実際に起こさずに「引数を
 * 渡さなければ `--maxWorkers=4` になること」「渡した値がそのまま使われること」
 * を確かめる歯を書けるようにするため（AGENTS.md「テストが書けない構造は、
 * テストが無いのと同じ」）。切り出しただけで、`runTests` の出力・挙動は
 * 1文字も変えていない — 元々ここでインライン配列として組み立てていたものを
 * 関数の戻り値に変えただけである。
 */
export function buildTestSpawnArgs(extraArgs = [], maxWorkers = DEFAULT_MAX_WORKERS) {
  return ['test', `--maxWorkers=${maxWorkers}`, ...extraArgs];
}

/**
 * `--max-workers <n>` / `--max-workers=<n>` の両方の形を読む。省略なら
 * `undefined`（＝呼び出し側の既定に委ねる）。値が1以上の整数でなければ落ちる。
 *
 * **`mutate.mjs`（CLI 層）ではなくここ（純粋な層）に置く理由**: `mutate.mjs`
 * はモジュールの末尾で無条件に `main()` を呼ぶため、そこから関数だけを
 * `import` すると `main()` が副作用として実行され、`process.argv` 次第で
 * `process.exit()` が起きる（テストプロセスを巻き込んで落ちる）。`import`
 * だけでは安全に取り出せない。ここは他の純粋関数と同じく `import` するだけで
 * 副作用が起きない層なので、テストから直接呼べる（マネージャーの指摘: `=` の
 * 形が静かに無視される欠陥を、テストで歯として固定するため）。
 *
 * **`=` の形を見落としていた理由**: 元は `args.indexOf('--max-workers')` の
 * 完全一致だけを見ていた。`--max-workers=2` は要素そのものが
 * `'--max-workers=2'` という1つの文字列なので `indexOf('--max-workers')` に
 * 一致せず、`-1` → `undefined` → 呼び出し側の既定（`DEFAULT_MAX_WORKERS`）へ
 * 静かに落ちていた。vitest 本体のフラグが `--maxWorkers=4` という `=` の形
 * そのものなので、その形を知っている人ほどこの穴を踏む。
 */
export function readMaxWorkers(args) {
  const EQ_PREFIX = '--max-workers=';
  const eqArg = args.find((a) => a.startsWith(EQ_PREFIX));
  let raw;
  if (eqArg !== undefined) {
    raw = eqArg.slice(EQ_PREFIX.length);
  } else {
    const idx = args.indexOf('--max-workers');
    if (idx === -1) return undefined;
    raw = args[idx + 1];
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new HarnessError(
      `--max-workers には1以上の整数を渡すこと（--max-workers <n> または ` +
        `--max-workers=<n> の形。実際: ${JSON.stringify(raw)}）`,
    );
  }
  return n;
}

/**
 * ANSI エスケープシーケンス（色付け）を取り除く。
 *
 * **なぜ剥がすか。** vitest は `Test Files` / `Tests` の集計行を色付きで出すことが
 * ある（`\x1b[2m Test Files \x1b[22m …` のように、ラベルの前後をエスケープ
 * シーケンスで挟む）。`^\s*Test Files` の `^\s*` は**エスケープシーケンスを空白
 * として読まない**ので、色が付いた回だけ集計行が `null` になり、
 * `testsRanCleanly` が false → `decideJudgementCategory` が `HarnessError` を
 * 投げる。**`decideJudgementCategory` は `exitCode` を1文字も見ていない**ので、
 * テストが完走して緑でも判定は出ず、しかも落ちる位置が「測り終えた後」なので
 * **変異を当てたままハーネスが停止する。**
 *
 * **⚠️ この欠陥をここ（ハーネス側）で実際に踏んだ観測は無い。** `spawnSync` は
 * TTY を作らないので、多くの場合 vitest は色を落とす。根拠は2つだけである:
 *
 * 1. **静的な読み** — 同じ正規表現・ANSI 除去なし（Issue #372。Issue 自身が
 *    「`mutate-core.mjs` が実際に色付きの出力を受け取る場面が在るかは確認して
 *    いない」「根拠は静的な読みだけである」と断っている）
 * 2. **伝聞の実測** — **同じ正規表現を書いた `scripts/test-guard-core.mjs`
 *    （#311 / PR #355）が CI で実際に踏んだ、と報告されている。** そちらの doc の
 *    逐語によれば CI run `32665717865`、head sha `d26f5a4`、vitest 自身は
 *    `Test Files 130 passed (130)` / `Tests 2493 passed (2493)` を出していたのに
 *    集計行を見つけられず `EXIT_UNKNOWN` になった、とのことである。**この観測は
 *    この修正の書き手が自分で取ったものではなく、PR #355 の記述からの引用である。**
 *    ローカルではパイプ経由で色が付かないため再現しなかった、とも書かれている
 *
 * **だから「直った」とは書けない。** 言えるのは「色が付いても倒れない形にした」
 * までである。
 *
 * **⚠️ ただし「色が付く条件」は1つ特定できた —— GitHub Actions の CI である。**
 * 実測（**この PR の CI**。run `32671276901` と `32672700282` の2回で再現した。
 * **⚠️ head sha ではなく run id で書いてある** —— sha は rebase で動くが run は動かない。job `ci` の
 * step `Run pnpm test` の raw log archive を展開して取った生バイト。`gh run view --log`
 * は ESC を `^[` へ均してしまうので、archive のバイトで数えた）: 集計行2本に
 * **ESC(0x1B) が16個**入っており、形は `scripts/mutate-core-strip-ansi.test.ts` の
 * フィクスチャと同型である。**その生バイトを、この修正の前の形（ANSI を剥がさない）へ
 * 通すと `filesLine` / `testsLine` が両方 `null` になる** —— **欠陥は本物の出力で
 * 再現する。**
 *
 * **⚠️ それでも「ハーネスが踏んだ」ではない。** ハーネスは器の中で `spawnSync` から
 * `pnpm test` を起こすのであって、GitHub Actions の中では走らない。**測れたのは
 * 「色が付く経路が実在する」までで、「ハーネスがその経路に乗る」は測れていない。**
 *
 * **形は `scripts/test-guard-core.mjs` の `stripAnsi` / `parseAggregateLines` に
 * 揃えてある**（同じ正規表現・同じ関数名・「剥がしてから match する」同じ順序）。
 * **共有の出所を作らない**のは、このハーネスが「依存なし・ビルド不要（node の
 * 組み込みモジュールだけで動く。壊れた `pnpm build` の下でも使える必要があるため）」
 * 「同じディレクトリの素の `import` で足しているだけで、`node_modules` には一切
 * 依存しない」を要件として持っている（`SKILL.md` 逐語）ため。`scripts/` を
 * `import` すると、**リポジトリが壊れているときにこそ使う道具**がリポジトリの
 * 配置に結びつく。**代わりに、2箇所が食い違わないことを歯で見張る**
 * （`scripts/mutate-core-strip-ansi.test.ts`）。
 */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- ANSI エスケープの検出そのものが目的
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * vitest の生出力（stdout + stderr）から `Test Files` / `Tests` の集計行を取り出す。
 * どちらかが無ければ `null`（＝「判定できない」の材料。`testsRanCleanly`）。
 *
 * **⚠️ 剥がしても「集計行が無い」は `null` のままであること。** ここが「剥がせば
 * 何でも読める」に緩むと、**「1本も走っていない」を検出する仕組みそのものが
 * 壊れる**（#311 の歯A・`AGENTS.md`「『判定できない』という3つ目の状態を持つ」）。
 * ANSI を剥がすのは行頭の空白判定を助けるためだけで、探す語（`Test Files` /
 * `Tests`）は1文字も緩めていない。
 */
export function parseAggregateLines(rawOutput) {
  const plain = stripAnsi(rawOutput);
  const filesLine = plain.match(/^\s*Test Files\s+.+$/m)?.[0]?.trim() ?? null;
  const testsLine = plain.match(/^\s*Tests\s+.+$/m)?.[0]?.trim() ?? null;
  return { filesLine, testsLine };
}

/** 手順10: テストを走らせ、`Test Files ... passed` と `Tests ... passed` の
 * 両方の行を読む。行の不在は「走っていない」であって「通った/落ちた」ではない。
 * `maxWorkers` を渡さなければ `DEFAULT_MAX_WORKERS`（＝これまでどおり `4`）で走る。
 *
 * **`raw` は加工前のまま返す（ANSI を剥がさない）。** 歯7が「併せて
 * `Tests N passed (N)` のような加工前の証跡もログへ残す — フラグが壊れても事後に
 * derive し直せる」を要求している（`SKILL.md`）。**剥がすのは判定に使う側
 * （`filesLine` / `testsLine`）だけである。**
 */
export function runTests(extraArgs = [], maxWorkers = DEFAULT_MAX_WORKERS) {
  const result = spawnSync('pnpm', buildTestSpawnArgs(extraArgs, maxWorkers), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  const { filesLine, testsLine } = parseAggregateLines(combined);
  return { exitCode: result.status, raw: combined, filesLine, testsLine };
}

export function testsRanCleanly(testResult) {
  return testResult.filesLine !== null && testResult.testsLine !== null;
}

export function testsAllPassed(testResult) {
  if (!testsRanCleanly(testResult)) return null; // 判定できない
  const noFailures = !/failed/i.test(testResult.filesLine) && !/failed/i.test(testResult.testsLine);
  const hasPassed = /passed/.test(testResult.filesLine) && /passed/.test(testResult.testsLine);
  return noFailures && hasPassed;
}

/**
 * 手順11: 判定を出す。生存を「合格」と読める語で書かない。
 *
 * **`spec` を受け取り、`spec.id` を判定行へ差し込む。** 種別の決定
 * （`decideJudgementCategory`）と id の差し込み（`formatJudgement`）を分けて
 * あるのは、`cmdRun` のまとめが「種別」だけを欲しがる場面と、人間が読む
 * 判定行が「id + 種別」を欲しがる場面の両方があるため。戻り値は
 * `{ category, text }` — `category` は `'検出' | '生存' | '不明'`。
 */
export function judge(spec, artifactResult, testResult) {
  const category = decideJudgementCategory(artifactResult, testResult);
  const text = formatJudgement(category, spec.id);
  return { category, text };
}

/**
 * 手順12〜13: 復元する。
 *
 * **控えと印が食い違ったとき、自動で勝者を選ばない。** 両方の md5 と、どちらが
 * `md5Pre` に一致するかを出す。片方だけ一致するなら「そちらから戻せる」と
 * 明示するが、その復元は `{ fromMarker: true }`（CLI では `--restore-from-marker`）
 * を明示したときにしか走らない。既定（`fromMarker` 省略）は控えから戻す
 * 通常経路であり、控えが `md5Pre` と一致しないなら**復元しない**。
 */
export function restoreMutation(opts = {}) {
  const fromMarker = opts.fromMarker === true;
  const { marker, originalContentMd5, selfConsistent: markerSelfConsistent } = readMarkerVerified();

  const backupAbs = absPath(marker.backupPath);
  let backupContent = null;
  let backupReadable = true;
  try {
    backupContent = fs.readFileSync(backupAbs, 'utf8');
  } catch {
    backupReadable = false;
  }
  const backupMd5 = backupReadable ? md5(backupContent) : null;
  const backupMatches = backupReadable && backupMd5 === marker.md5Pre;

  log(
    `[12a] 照合2: 控え md5=${backupMd5 ?? '(読めない)'} / 印内の原文 md5=${originalContentMd5} / md5Pre=${marker.md5Pre}`,
  );
  log(
    `      控えは md5Pre と一致: ${backupMatches} / 印内の原文は md5Pre と一致: ${markerSelfConsistent}`,
  );

  let sourceContent;
  let restoredFrom;
  if (fromMarker) {
    if (!markerSelfConsistent) {
      throw new HarnessError(
        '--restore-from-marker が指定されたが、印内の原文の md5 が md5Pre と一致しない。' +
          '印そのものが壊れている。復元しない。印は残す。',
      );
    }
    sourceContent = marker.originalContent;
    restoredFrom = 'marker';
    log('[12b] 復元元: 印に埋め込まれた原文（--restore-from-marker が明示された）');
  } else {
    if (!backupMatches) {
      if (markerSelfConsistent) {
        throw new HarnessError(
          '控えの md5 が md5Pre と一致しない（控えが汚染されている疑い。原因は不明。ハーネスは' +
            '原因を問わずこの二重照合で検出する）。印内の原文は md5Pre と一致しており、そちらからは' +
            '復元できる。自動では選ばない — 復元するなら `restore --restore-from-marker` を明示すること。' +
            '復元しない。印は残す。',
        );
      }
      throw new HarnessError(
        '控えの md5 も、印内の原文の md5 も、どちらも md5Pre と一致しない。自動で復元できる材料が' +
          '無い。手で確認すること。印は残す。',
      );
    }
    sourceContent = backupContent;
    restoredFrom = 'backup';
    log('[12b] 復元元: 控え（通常経路）');
  }

  writeRepoFile(marker.file, sourceContent);
  const md5After = md5(readRepoFile(marker.file));
  if (md5After !== marker.md5Pre) {
    throw new HarnessError(
      `[12b] 歯4 違反: 書き戻し後の md5 (${md5After}) が md5Pre (${marker.md5Pre}) と一致しない。`,
    );
  }
  log(`[12b] 書き戻し完了。md5 が md5Pre と一致 (${md5After})`);

  // **ソース側の復元がここまでで完了した。** ここが手順の要点（#321）——
  // 以前はこの書き換えを 12c・12d の「後」に置いていたため、12c が
  // （下で直した比較に直しても、直す前の比較でも）落ちると、ソースの
  // 復元自体は成功しているのに印が `stage: 'source-mutated'` のまま
  // 残っていた。次に来た人はそれを「変異が当たったままのツリーだ」と読み、
  // 印を信じて `md5Pre` へ書き戻すと、**その人の正当な未コミット変更が
  // 消える。** md5（12b）で復元の正しさが確認できた時点で、印を
  // 先に進めておく——これ以降 12c・12d・後始末（dist）のどれが失敗しても、
  // 次に来た人へは「ソースが変異したまま」ではなく「ソースは復元済みで
  // dist の確認が取れていない」と伝わる。12b/12c/12d の落ちる条件は
  // 1つも変えていない——落ちたときに印が何を名乗るかだけを直した。
  writeMarkerFile({ ...marker, stage: 'dist-unverified' });

  // 12c. git status --porcelain が「変異を当てる前」と変わっていないこと
  //   （#321）。旧い実装は「porcelain が空か」＝「HEAD と同じか」を見ていたが、
  //   これは別の質問だった。変異試験は「いま手元で書いているコードに歯が
  //   効くか」を測る道具なので、対象ファイルに未コミットの変更が在るのは
  //   異常ではなく通常である——それがある状態を「復元できていない」と
  //   誤判定していた。「前後で変わっていないこと」は意味のある保証なので、
  //   この検査自体は残す。比較対象を「変異前の porcelain」に変える。
  const statusAfter = gitStatusPorcelainFor(marker.file);
  if (marker.statusBefore === undefined) {
    // 旧い印（このフィールドを持たない）。空文字と比べる形に倒すと #321 の
    // 欠陥が戻る（未コミット変更が在る対象ファイルで必ず落ちる）ので、
    // 判定できないという3つ目の状態のまま先へ進む。
    log(
      '[12c] 変異前の git status を印が持っていない（旧い印）ので比較しない。' +
        `復元後の git status --porcelain: ${JSON.stringify(statusAfter)}`,
    );
  } else if (statusAfter !== marker.statusBefore) {
    throw new HarnessError(
      `[12c] git status --porcelain が変異前と変わっている。\n` +
        `変異前: ${JSON.stringify(marker.statusBefore)}\n` +
        `復元後: ${JSON.stringify(statusAfter)}`,
    );
  } else {
    log(`[12c] git status --porcelain: 変異前と一致（変化なし） ${JSON.stringify(statusAfter)}`);
  }

  // 12d. git rev-parse HEAD が手順1と同じであること。
  const headAfter = gitHead();
  if (headAfter !== marker.headBefore) {
    throw new HarnessError(`[12d] HEAD が変わっている (${marker.headBefore} → ${headAfter})`);
  }
  log(`[12d] HEAD 一致: ${headAfter}`);

  // **後始末（手順1〜13には無い工程。番号は振らない）。** 手順8〜9は build 済みの
  // `dist` を検査するが、この時点まではソースだけを書き戻した状態なので、
  // ここで再 build して確かめない限り `dist` に変異が残ったまま次の作業者へ
  // 渡る——このハーネスが潰そうとしている「静かに壊れたツリー」そのものである。
  // `SKILL.md` に理由を残してある。
  //
  // **入り（手順9）と同じ基準を、逆向きに使う。** 「build の終了コードでは
  // 判定しない」を後始末にも適用する — build が exit 0 でも `dist` を実際に
  // 読み直し、`artifact.contains` が消えていることを確認する。
  //
  // **確認が取れなければ印を消さない。** ソース（git 管理下）の復元はここまでで
  // 完了・検査済みだが、`dist`（untracked）の整合性は別の保証であり、それが
  // 取れない限り「このツリーは触ったままではない」と言い切れない。だから
  // `clearMarker()` をこの検証の後に置く——「復元は成功したのに印が残る」形に
  // なるが、「静かに壊れた dist を伴ったまま印だけ消える」よりましだという
  // 判断である。印が残っていれば `status`/`baseline`/`run` が知らせ続ける。
  // 次に `restore` を呼べば、ソース側は既に一致しているので歯4・12a〜12dは
  // 素通りし、ここ（後始末）だけをやり直せる（べき等）。
  const rebuildCheck = rebuildAndVerify(marker);
  if (!rebuildCheck.ok) {
    throw new HarnessError(
      `[後始末] 失敗: ${rebuildCheck.reason}。ソース（git 管理下）の復元は完了しているが、` +
        'dist の整合性が確認できないため印を残す。`status` はこの印を報告し続ける。' +
        '再度 `restore` を呼べば、ここだけをやり直せる。',
    );
  }

  // 13. 12と後始末の検証が全部通ってから印を消す。
  clearMarker();
  log('[13] 印を解除した');

  // 復元が成功した後は控えも消す（読めていた場合のみ）。残すと
  // `.mutation-testing/backups/` がハーネスを回すたびに積み上がり、素の
  // `git status` が毎回汚れる。復元が失敗したときはここへ到達しない＝控えは
  // 残る（手動復元・`--restore-from-marker` に要る）。
  if (backupReadable) fs.rmSync(backupAbs, { force: true });

  return { marker, restoredFrom, rebuildCheck };
}

/**
 * 後始末: `target` が設定されていたら dist を再 build し、実際に読み直して
 * 変異が消えていることを確認する。`target` が無ければ後始末そのものが不要
 * （build 境界を跨がない変異にこれを課さない）。
 */
function rebuildAndVerify(marker) {
  if (!marker.target) {
    return {
      checked: false,
      ok: true,
      reason: 'target が無いので後始末は不要',
      buildExitCode: null,
    };
  }

  log(`[後始末] dist を再 build する（--filter ${marker.target}）`);
  const result = spawnSync('pnpm', ['--filter', marker.target, 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  log(`[後始末] build exit=${result.status}`);
  if (result.status !== 0) {
    log('--- 後始末 build 生ログ ここから ---');
    log((result.stdout ?? '') + (result.stderr ?? ''));
    log('--- 後始末 build 生ログ ここまで ---');
    return {
      checked: true,
      ok: false,
      reason: `再 build が exit ${result.status} で失敗した。dist が現物（復元後のソース）と一致している保証が無い`,
      buildExitCode: result.status,
    };
  }

  if (!marker.artifact) {
    log(
      '[後始末] artifact 情報が無いため、build の成功だけを根拠にする' +
        '（内容までは確認できない。以後の生存にはこの限界がある）',
    );
    return {
      checked: true,
      ok: true,
      reason: 'artifact 情報が無く、build 成功のみで判定した（内容未確認）',
      buildExitCode: 0,
    };
  }

  const artifactAbs = absPath(marker.artifact.file);
  const content = fs.existsSync(artifactAbs) ? fs.readFileSync(artifactAbs, 'utf8') : '';
  const stillContainsMutation = content.includes(marker.artifact.contains);
  log(
    `[後始末] ${marker.artifact.file} を読み直し、"${marker.artifact.contains}" が消えているか確認 → ` +
      `${stillContainsMutation ? '消えていない（失敗）' : '消えている（成功）'}`,
  );
  return {
    checked: true,
    ok: !stillContainsMutation,
    reason: stillContainsMutation
      ? 'build は成功したが、dist にまだ変異の痕跡が残っている'
      : 'dist から変異の痕跡が消えたことを確認した',
    buildExitCode: 0,
  };
}
