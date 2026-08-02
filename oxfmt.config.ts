import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "target/**",
    "dist/**",
    "pnpm-lock.yaml",
    // Generated: by cargo-about, and by napi-rs respectively.
    "THIRD-PARTY-NOTICES.md",
    "packages/binding/index.js",
    "packages/binding/index.d.ts",
    // The documents under `.claude/` are hand-wrapped prose with hand-aligned
    // tables; reformatting them buries real changes in churn.
    "**/*.md",
    "**/*.yml",
    "**/*.yaml",
    // Handlebars. oxfmt reflows these as markup and corrupts the template —
    // it silently broke THIRD-PARTY-NOTICES.md once already.
    "**/*.hbs",
  ],
});
