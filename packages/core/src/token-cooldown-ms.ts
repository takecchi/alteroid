import { z } from 'zod';

// 休止の既定（ミリ秒）の形。デーモンの `PUT /tokens/policy`・保存する設定の読み取り・web の保存前の検査が同じものを使う
// zod だけを import する小さな入口に切る: token-pool.ts は node:crypto を引くので、ブラウザの束へ入れられないため
export const tokenCooldownMsSchema = z.number().int().positive();
