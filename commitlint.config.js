/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // The scopes this repo uses. Keeping the list closed means a typo in a
    // scope fails the commit rather than quietly inventing a new one.
    "scope-enum": [
      2,
      "always",
      ["engine", "napi", "core", "fonts", "resolver", "ci", "deps", "docs", "repo"],
    ],
  },
};
