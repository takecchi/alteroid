// 実体は `packages/core/src/git-child-env.test-support.ts` の1か所だけ。ここは scripts/・.github/scripts/ のテストが
// 従来の import 先（`./git-child-env.js`）のまま使えるようにするための再 export で、実装を持たない。
// scripts/ から core の `*.test-support.ts` を相対 import する先例は `stderr-error-through-reasonof.test.ts`（build 不要）。
export { gitChildEnv } from '../packages/core/src/git-child-env.test-support.js';
