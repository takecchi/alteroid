// heredoc・`# syntax=` 行・`COPY --link` を禁止しない: Railway の対応が公開情報で分からず、根拠の無い規則は本当に通る書き方まで止めるため。
// heredoc の本文は専用の解析をしない: 読み飛ばす解析の誤りで見逃すより、まれな誤検知のほうが安いため。

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

export const REASON =
  'Railway は RUN --mount を受け付けない（Railway のビルドが約13秒で落ちる。#2678 → #2683。' +
  'https://station.railway.com/questions/cache-mounts-must-be-in-the-format-mou-b5bbf3a2 、' +
  'https://docs.railway.com/builds/dockerfiles ）。' +
  '#2683 では COPY で入れて、同じ RUN の中で消した';

const DEFAULT_ESCAPE = '\\';

function readEscapeDirective(lines) {
  for (const line of lines) {
    const m = /^\s*#\s*([A-Za-z][\w-]*)\s*=\s*(\S+)\s*$/.exec(line);
    if (m === null) break;
    if (m[1].toLowerCase() === 'escape' && (m[2] === '\\' || m[2] === '`')) return m[2];
  }
  return DEFAULT_ESCAPE;
}

export function splitInstructions(content) {
  const lines = content.split(/\r?\n/);
  const escape = readEscapeDirective(lines);
  const instructions = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed === '') continue;

    const continues = trimmed.endsWith(escape);
    const text = continues ? trimmed.slice(0, -1) : trimmed;
    if (current === null) current = { pieces: [] };
    current.pieces.push({ line: i + 1, text });
    if (!continues) {
      instructions.push(current);
      current = null;
    }
  }
  if (current !== null) instructions.push(current);
  return { instructions, escape };
}

export function findRunMounts(content) {
  const lines = content.split(/\r?\n/);
  const { instructions } = splitInstructions(content);
  const hits = [];

  for (const ins of instructions) {
    const tokens = [];
    for (const piece of ins.pieces) {
      for (const word of piece.text.split(/\s+/)) {
        if (word !== '') tokens.push({ word, line: piece.line });
      }
    }
    let at = 0;
    if (tokens[at]?.word.toLowerCase() === 'onbuild') at++;
    if (tokens[at]?.word.toLowerCase() !== 'run') continue;
    at++;
    for (; at < tokens.length; at++) {
      const { word, line } = tokens[at];
      if (!word.startsWith('--')) break;
      if (/^--mount(=|$)/i.test(word)) {
        hits.push({ line, text: lines[line - 1], flag: word });
      }
    }
  }
  return hits;
}

export function isDockerfileName(path) {
  const base = path.split('/').pop() ?? '';
  return /^dockerfile(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base);
}

export function readDockerfilePath(jsonText) {
  const parsed = JSON.parse(jsonText);
  const p = parsed?.build?.dockerfilePath;
  return typeof p === 'string' && p !== '' ? p.replace(/^\.\//, '') : null;
}

export function collectTargets(root, io) {
  const tracked = listGitScannableFiles({ cwd: root });
  const targets = new Map();
  const problems = [];

  for (const path of tracked.filter(isDockerfileName)) {
    if (io.exists(path)) targets.set(path, 'git が追跡している Dockerfile');
  }

  for (const path of tracked.filter((p) => /^railway\/.*\.json$/.test(p))) {
    if (!io.exists(path)) continue;
    let dockerfilePath;
    try {
      dockerfilePath = readDockerfilePath(io.readFile(path));
    } catch (error) {
      problems.push({ path, message: `JSON として読めない: ${error}` });
      continue;
    }
    if (dockerfilePath === null) continue;
    if (!io.exists(dockerfilePath)) {
      problems.push({
        path,
        message: `build.dockerfilePath が指す ${dockerfilePath} が無い`,
      });
      continue;
    }
    if (!targets.has(dockerfilePath))
      targets.set(dockerfilePath, `${path} の build.dockerfilePath`);
  }
  return { targets, problems };
}

export function evaluateFiles(files) {
  const violations = [];
  for (const { path, content } of files) {
    for (const hit of findRunMounts(content)) violations.push({ path, ...hit });
  }
  return violations;
}

export function formatViolations(violations) {
  const out = [`check-dockerfile-railway: NG — RUN --mount が ${violations.length}件ある:`];
  for (const v of violations) {
    out.push(`  ${v.path}:${v.line}: ${v.text.trim()}`);
  }
  out.push(`理由: ${REASON}`);
  return out.join('\n');
}
