import { register } from 'node:module';
import type { ResolveHook } from 'node:module';

// ERR_MODULE_NOT_FOUND 以外の失敗は投げ直す: 「見つからない」を握り潰して別の見つからなさへすり替えないため
// hook の実装を別ファイルに分けない: どのファイルが `--import` の対象でどれが hook 本体かを1ファイルに保つため
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const isRelativeJsImport =
    specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'));
  if (!isRelativeJsImport) {
    return nextResolve(specifier, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    const tsSpecifier = `${specifier.slice(0, -'.js'.length)}.ts`;
    return nextResolve(tsSpecifier, context);
  }
};

register(import.meta.url);
