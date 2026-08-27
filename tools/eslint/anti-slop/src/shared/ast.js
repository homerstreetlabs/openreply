/**
 * AST helpers shared across rules.
 *
 * typescript-eslint drops `ParenthesizedExpression` and `TSParenthesizedType` from the tree,
 * so the unwrap loops below are no-ops on the default parser. They stay because a parser
 * configured with `preserveParens`, or a future one, can reintroduce those nodes, and a rule
 * that silently stops firing is worse than three cheap comparisons.
 */

/** @param {any} node */
export const start = (node) => node.range[0];

/** @param {any} node */
export const end = (node) => node.range[1];

/** @param {any} expression */
export function unwrapParentheses(expression) {
	let current = expression;
	while (current.type === "ParenthesizedExpression") current = current.expression;
	return current;
}

/** @param {any} type */
export function unwrapTypeParentheses(type) {
	let current = type;
	while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
	return current;
}

/** Strip parens, assertions, and non-null operators to reach the underlying expression. */
export function unwrapAssertions(expression) {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

/** @param {any} type */
export function typeReferenceName(type) {
	return type.typeName?.type === "Identifier" ? type.typeName.name : null;
}

/** A TSTypeReference with no type arguments applied. */
export function isUnappliedTypeReference(type) {
	return (
		type.type === "TSTypeReference" &&
		(type.typeArguments === null ||
			type.typeArguments === undefined ||
			type.typeArguments.params.length === 0)
	);
}

/** The declaration a top-level statement introduces, seeing through `export`. */
export function declaredStatement(statement) {
	return statement.type === "ExportNamedDeclaration" ||
		statement.type === "ExportDefaultDeclaration"
		? (statement.declaration ?? null)
		: statement;
}

const FUNCTION_TYPES = new Set([
	"ArrowFunctionExpression",
	"FunctionDeclaration",
	"FunctionExpression",
]);

/** @param {any} node */
export function isRuntimeFunction(node) {
	return FUNCTION_TYPES.has(node.type);
}

/** Nearest enclosing function, or null at module scope. */
export function enclosingFunction(node) {
	let current = node.parent;
	while (current !== undefined && current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) return current;
		current = current.parent;
	}
	return null;
}

/**
 * typescript-eslint v8 flattened `TSMappedType.typeParameter` into `key` + `constraint`.
 * These two helpers read either shape so the plugin works on v7 and v8 alike.
 */
export function mappedTypeKey(node) {
	return node.key ?? node.typeParameter?.name ?? null;
}

export function mappedTypeConstraint(node) {
	return node.constraint ?? node.typeParameter?.constraint ?? null;
}
