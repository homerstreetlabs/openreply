import { noChainedTypeAssertions } from "./src/rules/no-chained-type-assertions.js";
import { noConditionalEmptyObjectSpread } from "./src/rules/no-conditional-empty-object-spread.js";
import { noKnownValueWidening } from "./src/rules/no-known-value-widening.js";
import { noModuleMocking } from "./src/rules/no-module-mocking.js";
import { noObjectParameters } from "./src/rules/no-object-parameters.js";
import { noReflectApply } from "./src/rules/no-reflect-apply.js";
import { noReflectGet } from "./src/rules/no-reflect-get.js";
import { noRuntimeTypeof } from "./src/rules/no-runtime-typeof.js";
import { noShapeInSymbolNames } from "./src/rules/no-shape-in-symbol-names.js";
import { noUnknownParameters } from "./src/rules/no-unknown-parameters.js";
import { noUnknownReturns } from "./src/rules/no-unknown-returns.js";
import { noUnknownTypeAliases } from "./src/rules/no-unknown-type-aliases.js";
import { noUnsafeDictionaryType } from "./src/rules/no-unsafe-dictionary-type.js";
import { noWidenThenAssert } from "./src/rules/no-widen-then-assert.js";
import { requireSafetyCommentForTypeAssertion } from "./src/rules/require-safety-comment-for-type-assertion.js";

/** Generic rules that reject low-evidence and low-signal implementation patterns. */
export const rules = {
	"no-chained-type-assertions": noChainedTypeAssertions,
	"no-conditional-empty-object-spread": noConditionalEmptyObjectSpread,
	"no-known-value-widening": noKnownValueWidening,
	"no-module-mocking": noModuleMocking,
	"no-object-parameters": noObjectParameters,
	"no-reflect-apply": noReflectApply,
	"no-reflect-get": noReflectGet,
	"no-runtime-typeof": noRuntimeTypeof,
	"no-shape-in-symbol-names": noShapeInSymbolNames,
	"no-unknown-parameters": noUnknownParameters,
	"no-unknown-returns": noUnknownReturns,
	"no-unknown-type-aliases": noUnknownTypeAliases,
	"no-unsafe-dictionary-type": noUnsafeDictionaryType,
	"no-widen-then-assert": noWidenThenAssert,
	"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertion,
};

const meta = { name: "eslint-plugin-anti-slop", version: "0.1.0" };

const plugin = { meta, rules, configs: {} };

const allErrors = Object.fromEntries(
	Object.keys(rules).map((name) => [`anti-slop/${name}`, "error"]),
);

/**
 * Every generic rule at error. Flat config only.
 *
 * None of these rules need type information, so this config sets no parser. Spread it after
 * whichever config already points `.ts` files at @typescript-eslint/parser.
 */
plugin.configs.recommended = {
	name: "anti-slop/recommended",
	plugins: { "anti-slop": plugin },
	rules: allErrors,
};

/**
 * The same rules, minus the two that most often need a project-wide decision first.
 * `no-runtime-typeof` and `require-safety-comment-for-type-assertion` fire on a lot of
 * existing code, so a repository adopting anti-slop mid-life usually starts here.
 */
plugin.configs.starter = {
	name: "anti-slop/starter",
	plugins: { "anti-slop": plugin },
	rules: {
		...allErrors,
		"anti-slop/no-runtime-typeof": "off",
		"anti-slop/require-safety-comment-for-type-assertion": "warn",
	},
};

export default plugin;
