import { isGlobalReference, resolveVariable } from "../shared/scope.js";

const MODULE_MOCK_METHODS = new Set(["doMock", "mock", "unstable_mockModule"]);

function importedName(node) {
	if (node.type !== "ImportSpecifier") return null;
	return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

/** `vi` and `jest`, whether global or imported from vitest / @jest/globals. */
function isTestFrameworkObject(sourceCode, expression) {
	if (expression.type !== "Identifier") return false;
	const isFrameworkName = expression.name === "vi" || expression.name === "jest";
	if (isFrameworkName && isGlobalReference(sourceCode, expression)) return true;

	const variable = resolveVariable(sourceCode, expression);
	if (variable === null || variable.defs.length === 0) return isFrameworkName;
	return variable.defs.some((definition) => {
		if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
			return false;
		}
		const source = definition.parent.source.value;
		const name = importedName(definition.node);
		return (source === "vitest" && name === "vi") || (source === "@jest/globals" && name === "jest");
	});
}

function moduleMockCall(sourceCode, callee) {
	if (callee.type !== "MemberExpression") return false;
	if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
	const property = callee.property;
	const method = callee.computed
		? property.type === "Literal" && MODULE_MOCK_METHODS.has(property.value)
			? property.value
			: null
		: property.type === "Identifier"
			? property.name
			: null;
	return method !== null && MODULE_MOCK_METHODS.has(method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMocking = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
		},
		schema: [],
		messages: {
			moduleMock:
				"Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				if (moduleMockCall(context.sourceCode, node.callee)) {
					context.report({ node, messageId: "moduleMock" });
				}
			},
		};
	},
};
