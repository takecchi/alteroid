import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';

// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { collectTargets, evaluateFiles, findRunMounts, formatViolations, isDockerfileName, readDockerfilePath, REASON } from './check-dockerfile-railway-core.mjs';

const ROOT = join(import.meta.dirname, '..');

interface Hit {
  line: number;
  text: string;
  flag: string;
}

const mounts = (content: string): Hit[] => findRunMounts(content);
const mountLines = (content: string): number[] => mounts(content).map((h) => h.line);

/**
 * `check-dockerfile-railway`（Issue #2685）の歯。
 *
 * 1. **#2678 の実際の書き方で落ちること。** `gh pr diff 2678` の Dockerfile の追加行を
 *    逐語で持つ。Railway の3環境を約13秒で落とした書き方そのものである。
 * 2. **命令の単位で読めること**（行継続・大小文字・`# escape=`・コメント・本文の字面）。
 * 3. **対象の列挙**（`railway/*.json` の `dockerfilePath`、fail-closed）。
 * 4. **いまの repo の Dockerfile が通ること**（実物に当てる）。
 *
 * この歯は fixture として `--mount` を含む Dockerfile を持つが、検査は repo の
 * Dockerfile だけを読む（`*.test.ts` は対象外）ので、自己参照は起きない。
 */

/** `gh pr diff 2678` の `Dockerfile` の追加行（逐語。先頭の `+` だけ落とした）。 */
const DOCKERFILE_ADDED_BY_2678 = [
  '',
  '# 使う人ごとの道具を足す、ビルド時の追加層（#2534 段1）。**最終ステージはここ**',
  '# （Railway は `target` を指定しないので最後のステージを焼き、compose の `build` にも',
  '# `target` は無い）。上の「同じ像から2つの役」は、この `final` から起こす。',
  '#',
  '# 入力は build arg 2つ（Railway では Service 変数として渡る）:',
  '#   ALTEROID_EXTRA_APT_PACKAGES  apt のパッケージ名（空白・改行区切り）',
  '#   ALTEROID_EXTRA_SETUP         root で走らせる sh スクリプトの本文',
  '# **どちらも空（既定）なら `docker/runner-extra` は何もせず、ファイル系は `runtime` と',
  '# 変わらない**（CI の `image` が両者の差が無いことを見る）。ただし `RUN` の層は1枚増える',
  '# ので image の digest は変わる。実行時の主体（uid 1001 の worker）の境界は変えない。',
  '#',
  '# **スクリプトは bind mount で渡し、image に残さない**（`COPY` だと中身が層に残る）。',
  '# BuildKit 前提（Railway の Dockerfile ビルドも compose v2 も既定で BuildKit）。',
  'FROM runtime AS final',
  'ARG ALTEROID_EXTRA_APT_PACKAGES=""',
  'ARG ALTEROID_EXTRA_SETUP=""',
  'USER root',
  'RUN --mount=type=bind,source=docker/runner-extra,target=/tmp/runner-extra \\',
  '  sh /tmp/runner-extra',
  'USER node',
  '# `CMD` は `runtime` から継ぐ（`alteroidd`。runner は command で選ぶ）。',
].join('\n');

describe('#2678 の書き方', () => {
  it('RUN --mount=type=bind（行継続つき）を、フラグが在る1行目の行番号で当てる', () => {
    const hits = mounts(DOCKERFILE_ADDED_BY_2678);
    expect(hits).toHaveLength(1);
    const hit = hits[0] as Hit;
    expect(hit.text).toBe(
      'RUN --mount=type=bind,source=docker/runner-extra,target=/tmp/runner-extra \\',
    );
    expect(hit.flag).toBe('--mount=type=bind,source=docker/runner-extra,target=/tmp/runner-extra');
    // 追加行の中での行番号（空行・コメントを数える）。
    expect(DOCKERFILE_ADDED_BY_2678.split('\n')[hit.line - 1]).toBe(hit.text);
  });

  it('失敗時の出力にファイル名・行番号・該当行・理由（出典 URL・#2683）が出る', () => {
    const violations: { line: number }[] = evaluateFiles([
      { path: 'Dockerfile', content: DOCKERFILE_ADDED_BY_2678 },
    ]);
    const text = formatViolations(violations);
    expect(text).toContain(`Dockerfile:${violations[0]?.line}: RUN --mount=type=bind,`);
    expect(text).toContain('Railway は RUN --mount を受け付けない');
    expect(text).toContain(
      'station.railway.com/questions/cache-mounts-must-be-in-the-format-mou-b5bbf3a2',
    );
    expect(text).toContain('docs.railway.com/builds/dockerfiles');
    expect(text).toContain('#2683');
    expect(text).toContain('COPY');
    expect(REASON).toContain('同じ RUN の中で消した');
  });
});

describe('findRunMounts: 命令の単位', () => {
  it('type を問わない（bind / cache / secret / ssh / tmpfs）', () => {
    for (const type of ['bind', 'cache', 'secret', 'ssh', 'tmpfs']) {
      expect(mountLines(`FROM x\nRUN --mount=type=${type},target=/t true\n`)).toEqual([2]);
    }
  });

  it('小文字の run も当てる', () => {
    expect(mountLines('run --mount=type=cache,target=/c true')).toEqual([1]);
  });

  it('継続行にある --mount を、その物理行の番号で当てる', () => {
    const df = 'FROM x\nRUN \\\n  --network=none \\\n  --mount=type=bind,target=/t \\\n  true\n';
    expect(mountLines(df)).toEqual([4]);
  });

  it('継続の途中のコメント行・空行を飛ばして読む', () => {
    const df = 'RUN --network=none \\\n# コメント\n\n  --mount=type=cache,target=/c \\\n  true\n';
    expect(mountLines(df)).toEqual([4]);
  });

  it('# escape=` の指定で、バッククォートの継続も読む', () => {
    const df =
      '# escape=`\nFROM x\nRUN --network=none `\n  --mount=type=cache,target=/c `\n  true\n';
    expect(mountLines(df)).toEqual([4]);
  });

  it('# escape=` のとき、`\\` では継続しない（次の行は別の命令）', () => {
    const df = '# escape=`\nRUN true \\\n--mount=type=cache,target=/c\n';
    expect(mountLines(df)).toEqual([]);
  });

  it('継続文字のあとの行末の空白を許す', () => {
    expect(mountLines('RUN --network=none \\   \n  --mount=type=cache,target=/c true\n')).toEqual([
      2,
    ]);
  });

  it('ONBUILD RUN も当てる', () => {
    expect(mountLines('ONBUILD RUN --mount=type=cache,target=/c true')).toEqual([1]);
  });

  it('フラグ名の大小文字・値が次の語の形も当てる（安全側）', () => {
    expect(mountLines('RUN --MOUNT=type=cache,target=/c true')).toEqual([1]);
    expect(mountLines('RUN --mount type=cache,target=/c true')).toEqual([1]);
  });

  it('1つの RUN に --mount が複数在れば、それぞれ当てる', () => {
    expect(
      mountLines('RUN --mount=type=cache,target=/a \\\n  --mount=type=secret,id=x \\\n  true'),
    ).toEqual([1, 2]);
  });
});

describe('findRunMounts: 誤検知しない', () => {
  it('コメント行の --mount', () => {
    expect(mountLines('# RUN --mount=type=bind を使わないこと\nFROM x\n')).toEqual([]);
    expect(mountLines('  # RUN --mount=type=bind\nFROM x\n')).toEqual([]);
  });

  it('RUN のシェル本文に字面があるだけ', () => {
    expect(mountLines('RUN echo --mount=type=bind')).toEqual([]);
    expect(mountLines('RUN mount --bind /a /b && echo "--mount"')).toEqual([]);
    expect(mountLines('RUN --network=none echo \\\n  --mount=type=bind')).toEqual([]);
  });

  it('RUN 以外の命令の字面', () => {
    expect(mountLines('ENV X="--mount"\nLABEL a="RUN --mount=type=bind"\nCOPY --link a b')).toEqual(
      [],
    );
    expect(mountLines('COPY --from=x --chown=1:1 a b')).toEqual([]);
  });

  it('JSON 形式の RUN の引数', () => {
    expect(mountLines('RUN ["sh", "-c", "--mount"]')).toEqual([]);
  });

  it('禁止していない書き方（不明なので入れていない）: heredoc・# syntax=・COPY --link', () => {
    const df = [
      '# syntax=docker/dockerfile:1',
      'FROM x',
      'COPY --link a b',
      'RUN <<EOF',
      'echo hello',
      'EOF',
      'RUN --network=none true',
    ].join('\n');
    expect(mountLines(df)).toEqual([]);
  });
});

describe('対象の決め方', () => {
  it('Dockerfile らしい名前', () => {
    for (const p of [
      'Dockerfile',
      'docker/db.Dockerfile',
      'Dockerfile.dev',
      'a/b/Dockerfile.prod',
      'x.dockerfile',
      'dockerfile',
    ]) {
      expect(isDockerfileName(p)).toBe(true);
    }
    for (const p of [
      'docker/runner-extra',
      'Dockerfiles.md',
      'notes/dockerfile-notes.md',
      'a.json',
    ]) {
      expect(isDockerfileName(p)).toBe(false);
    }
  });

  it('readDockerfilePath: dockerfilePath を取る / 無ければ null / 壊れていれば投げる', () => {
    expect(readDockerfilePath('{"build":{"dockerfilePath":"docker/db.Dockerfile"}}')).toBe(
      'docker/db.Dockerfile',
    );
    expect(readDockerfilePath('{"build":{"dockerfilePath":"./Dockerfile"}}')).toBe('Dockerfile');
    expect(readDockerfilePath('{"build":{}}')).toBeNull();
    expect(() => readDockerfilePath('{')).toThrow();
  });

  /** 一時 git repo。`git ls-files` を本物で通す。 */
  function makeRepo(files: Record<string, string>): string {
    const dir = makeTempDirSync('check-dockerfile-railway-');
    execFileSync('git', ['init', '-q'], { cwd: dir, env: gitChildEnv() });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    return dir;
  }
  const io = (dir: string) => ({
    readFile: (p: string) => readFileSync(join(dir, p), 'utf8'),
    exists: (p: string) => existsSync(join(dir, p)),
  });

  it('railway/*.json の dockerfilePath が指す、名前が Dockerfile らしくないファイルも対象にする', () => {
    const dir = makeRepo({
      Dockerfile: 'FROM x\n',
      'deploy/build.txt': 'FROM y\n',
      'railway/a.json': '{"build":{"dockerfilePath":"deploy/build.txt"}}',
    });
    const { targets, problems } = collectTargets(dir, io(dir));
    expect([...targets.keys()].sort()).toEqual(['Dockerfile', 'deploy/build.txt']);
    expect(problems).toEqual([]);
  });

  it('dockerfilePath の先が無い・JSON が壊れている ⟹ problems に出す（黙って通さない）', () => {
    const dir = makeRepo({
      Dockerfile: 'FROM x\n',
      'railway/a.json': '{"build":{"dockerfilePath":"missing/Dockerfile.x"}}',
      'railway/b.json': '{',
    });
    const { problems } = collectTargets(dir, io(dir));
    expect(problems.map((p: { path: string }) => p.path).sort()).toEqual([
      'railway/a.json',
      'railway/b.json',
    ]);
  });
});

describe('実際の repo', () => {
  it('いまの Dockerfile 群（railway/*.json の dockerfilePath を含む）に RUN --mount は無い', () => {
    const { targets, problems } = collectTargets(ROOT, {
      readFile: (p: string) => readFileSync(join(ROOT, p), 'utf8'),
      exists: (p: string) => existsSync(join(ROOT, p)),
    });
    expect(problems).toEqual([]);
    // 少なくともルートの Dockerfile と railway/ が指すものが入っている（0件で緑になる形を許さない）。
    expect([...targets.keys()]).toContain('Dockerfile');
    expect([...targets.keys()]).toContain('docker/db.Dockerfile');
    const files = [...targets.keys()].map((path) => ({
      path,
      content: readFileSync(join(ROOT, path), 'utf8'),
    }));
    expect(evaluateFiles(files)).toEqual([]);
  });

  it('CLI を実際に走らせて 0 で終わり、1行出す', () => {
    const out = execFileSync('node', [join(ROOT, 'scripts/check-dockerfile-railway.mjs')], {
      env: gitChildEnv(),
      encoding: 'utf8',
    });
    expect(out).toContain('check-dockerfile-railway: OK');
  });
});
