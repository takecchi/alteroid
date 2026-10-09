// 数え上げて通す（捨てる形にしない）: デーモンの env には記憶ストアの鍵・認証の鍵があり、捨てる形では名前が増えたときに黙って漏れるため。
const CODEX_LOGIN_ENV_NAMES = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function codexLoginEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of CODEX_LOGIN_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
