import { noServiceConstructorImports } from "./rules/no-service-constructor-imports.js";

/** Opt-in rules for Effect service and Layer architecture. */
export const rules = {
	"no-service-constructor-imports": noServiceConstructorImports,
};

const meta = { name: "eslint-plugin-anti-slop-effect", version: "0.1.0" };

const plugin = { meta, rules, configs: {} };

plugin.configs.recommended = {
	name: "anti-slop-effect/recommended",
	plugins: { "anti-slop-effect": plugin },
	rules: { "anti-slop-effect/no-service-constructor-imports": "error" },
};

export default plugin;
