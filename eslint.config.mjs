import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
export default tseslint.config(
  {ignores:["dist/**",".next/**",".vinext/**","node_modules/**",".wrangler/**","work/**","outputs/**"]},
  ...tseslint.configs.recommended,
  {files:["app/**/*.ts","app/**/*.tsx"],plugins:{"react-hooks":hooks},rules:hooks.configs.flat.recommended.rules},
);
