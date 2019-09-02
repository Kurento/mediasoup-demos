/* Use the default ESLint recommended style.
 *
 * Only exception to this is allowing unused vars/args with a name that
 * starts with underscore, '_'. This is a common convention, to signal
 * that a variable should not bind or otherwise get a value but still exist.
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
    ]
  }
};
