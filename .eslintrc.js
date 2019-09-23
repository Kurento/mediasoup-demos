/* Use the default ESLint recommended style.
 *
 * Exceptions:
 *
 * - Allow unused vars/args with a name that starts with underscore, '_'.
 *   This is a useful convention in other programming languages, to signal that
 *   a variable should not bind or otherwise get a value but still be declared.
 *
 * - Disable "require-atomic-updates" due to low quality of that rule, causing
 *   lots of false positives. See https://github.com/eslint/eslint/issues/11899
 */

module.exports = {
  env: {
    browser: true,
    commonjs: true,
    es6: true,
    node: true
  },
  extends: "eslint:recommended",
  globals: {
    Atomics: "readonly",
    SharedArrayBuffer: "readonly"
  },
  parserOptions: {
    ecmaVersion: 2018
  },
  rules: {
    "no-unused-vars": [
      "error",
      { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }
    ],
    "require-atomic-updates": "off"
  }
};
