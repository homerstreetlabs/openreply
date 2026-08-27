/** Scope resolution helpers. ESLint has no `isGlobalReference`, so it is rebuilt here. */

/**
 * Walk out from the identifier's scope until a binding with that name appears.
 * @returns {any | null}
 */
export function resolveVariable(sourceCode, identifier) {
	let scope = sourceCode.getScope(identifier);
	while (scope !== null && scope !== undefined) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

/**
 * Report whether an identifier resolves to a global rather than a local binding.
 * A name with no resolvable binding, or one whose only binding has no definition site
 * (how eslint-scope models `globals`), is global.
 */
export function isGlobalReference(sourceCode, identifier) {
	if (identifier.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, identifier);
	return variable === null || variable.defs.length === 0;
}

/** The single `const`/`let`/`var` declarator that introduced a variable, if there is exactly one. */
export function singleVariableDeclarator(variable) {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
		? definition.node
		: null;
}

/** Any declarator that introduced a variable, taking the first. */
export function anyVariableDeclarator(variable) {
	for (const definition of variable.defs) {
		if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
			return definition.node;
		}
	}
	return null;
}
