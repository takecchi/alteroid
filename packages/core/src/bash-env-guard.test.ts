import { describe, expect, it } from 'vitest';

import {
  BASH_ENV_GUARD_ENV,
  bashEnvPromptLines,
  inspectBashEnvDump,
  resolveEffectiveBashEnvGuard,
} from './bash-env-guard.js';

function formOf(command: string): string | undefined {
  const v = inspectBashEnvDump(command);
  return v.blocked ? v.form : undefined;
}

describe('inspectBashEnvDump: 環境変数の値を出す形を断る（#6864）', () => {
  const cases: [string, string][] = [
    ['env', 'env'],
    ['/usr/bin/env', 'env'],
    ['env -0', 'env'],
    ['env -u PATH', 'env'],
    ['env | sort', 'env'],
    ['env | grep -i token', 'env'],
    ['env > /tmp/mgr-1/env.txt', 'env'],
    ['sudo env', 'env'],
    ['timeout 5 env', 'env'],
    ['FOO=1 env', 'env'],
    ['git status && env', 'env'],
    ['echo start; env', 'env'],
    ["bash -c 'env'", 'env'],
    ['sh -lc "env | sort"', 'env'],
    ['echo "$(env)"', 'env'],
    ['echo $(env)', 'env'],
    ['printenv', 'printenv'],
    ['printenv -0', 'printenv'],
    ['env FOO=1 printenv', 'printenv'],
    ['printenv GH_TOKEN', 'printenv-secret'],
    ['printenv PATH GITHUB_TOKEN', 'printenv-secret'],
    ['printenv CLAUDE_CODE_OAUTH_TOKEN', 'printenv-secret'],
    ['export', 'export'],
    ['export -p', 'export'],
    ['declare', 'declare'],
    ['declare -p', 'declare'],
    ['declare -x', 'declare'],
    ['typeset -px', 'declare'],
    ['set', 'set'],
    ['set | grep TOKEN', 'set'],
    ['cat /proc/1/environ', 'proc-environ'],
    ['cat /proc/self/environ', 'proc-environ'],
    ["tr '\\0' '\\n' < /proc/1/environ", 'proc-environ'],
    ['tr "\\0" "\\n" </proc/$$/environ', 'proc-environ'],
    ['strings /proc/*/environ', 'proc-environ'],
    ['xxd /proc/self/task/12/environ', 'proc-environ'],
  ];
  it.each(cases)('%s → %s', (command, form) => {
    expect(formOf(command)).toBe(form);
  });

  it('理由は代わりの書き方を返し、止めたのがこの1回だけだと言う', () => {
    const v = inspectBashEnvDump('env');
    if (!v.blocked) throw new Error('断っていない');
    expect(v.reason).toContain('compgen -e');
    expect(v.reason).toContain('test -n "${名前+x}"');
    expect(v.reason).toContain('この1回の呼び出しだけ');
  });
});

describe('inspectBashEnvDump: 値を出さない形は通す', () => {
  const allowed = [
    'compgen -e',
    'test -n "${GH_TOKEN+x}"',
    '[ -n "${GH_TOKEN:-}" ]',
    'printenv PATH',
    'printenv HOME LANG',
    'env FOO=1 pnpm test',
    'env -u GH_TOKEN pnpm test',
    'env -i PATH=/usr/bin ls',
    'env -i',
    'export FOO=1',
    'export PATH="$PATH:/x"',
    'declare -A map',
    'declare -i n=1',
    'declare -f',
    'declare -F',
    'set -e',
    'set -euo pipefail',
    'set -- a b',
    'command -v env',
    'type env',
    'which printenv',
    'echo env',
    'echo "printenv; set"',
    "git commit -m 'set env'",
    'gh secret set FOO',
    'pnpm env use 22',
    'git config --get user.name',
    'ls /proc/1',
    'cat /proc/1/status',
    '# env',
    'echo hi # env',
    'cat <<EOF > notes.txt\nenv\nset\nEOF',
    '',
  ];
  it.each(allowed)('%s', (command) => {
    expect(formOf(command)).toBeUndefined();
  });
});

describe('resolveEffectiveBashEnvGuard', () => {
  it('既定は on', () => {
    expect(resolveEffectiveBashEnvGuard({}, {})).toBe('on');
  });
  it('runner の env の off で開く', () => {
    expect(resolveEffectiveBashEnvGuard({ [BASH_ENV_GUARD_ENV]: 'off' }, {})).toBe('off');
  });
  it('プロファイルの値が runner の env より優先される', () => {
    expect(
      resolveEffectiveBashEnvGuard({ [BASH_ENV_GUARD_ENV]: 'off' }, { [BASH_ENV_GUARD_ENV]: 'on' }),
    ).toBe('on');
    expect(
      resolveEffectiveBashEnvGuard({ [BASH_ENV_GUARD_ENV]: 'on' }, { [BASH_ENV_GUARD_ENV]: 'off' }),
    ).toBe('off');
  });
  it('綴り違いは既定へ倒さず投げる', () => {
    expect(() => resolveEffectiveBashEnvGuard({ [BASH_ENV_GUARD_ENV]: 'deny' }, {})).toThrow(
      BASH_ENV_GUARD_ENV,
    );
  });
});

describe('bashEnvPromptLines', () => {
  it('通る書き方を含む', () => {
    const lines = bashEnvPromptLines();
    expect(lines).toContain('compgen -e');
    expect(lines).toContain('test -n "${名前+x}"');
    expect(lines).toContain('/proc/*/environ');
  });
});
