import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Generated output only. `build/` contains the checked-in Sites packaging
    // plugin, so it must remain inside the lint surface.
    ".next/**",
    "out/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
