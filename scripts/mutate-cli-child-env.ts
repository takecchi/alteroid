// `PATH` だけを渡す: 子が必要とするのは `node` と、子が起こす `git` を見つけるための `PATH` だけで、親の環境を丸ごと継承させないため。
export function mutateCliChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '' };
}
