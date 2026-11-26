// Shared oxlint JS plugin (loaded by .oxlintrc.json "jsPlugins"): ESLint's no-dupe-args and
// no-octal, which oxlint has no native version of. Keep the copies in all six plugin repos the same.
//
// They only matter in sloppy-mode scripts (CommonJS without "use strict"): strict code, ES modules
// and TypeScript already reject duplicate parameters and legacy octal literals when parsing.

/** ESLint's no-dupe-args: `function f(a, a) {}`. */
const noDupeArgs = {
  meta: { type: 'problem', docs: { description: 'Disallow duplicate arguments in function definitions' } },
  create(context) {
    function check(node) {
      const seen = new Set();
      for (const param of node.params) {
        if (param.type === 'Identifier') {
          if (seen.has(param.name)) {
            context.report({ node: param, message: `Duplicate param '${param.name}'.` });
          }
          seen.add(param.name);
        }
      }
    }
    return { FunctionDeclaration: check, FunctionExpression: check };
  },
};

/** ESLint's no-octal: `010`, and like ESLint also `08` (a decimal that looks octal). */
const noOctal = {
  meta: { type: 'suggestion', docs: { description: 'Disallow octal literals' } },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'number' && /^0[0-9]/.test(node.raw)) {
          context.report({ node, message: 'Octal literals should not be used.' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'sloppy-mode' },
  rules: { 'no-dupe-args': noDupeArgs, 'no-octal': noOctal },
};
