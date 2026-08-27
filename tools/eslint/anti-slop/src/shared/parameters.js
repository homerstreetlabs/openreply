/** Node types that own a `params` list a rule should inspect. */
export const PARAMETER_OWNERS = [
	"ArrowFunctionExpression",
	"FunctionDeclaration",
	"FunctionExpression",
	"TSCallSignatureDeclaration",
	"TSConstructSignatureDeclaration",
	"TSConstructorType",
	"TSDeclareFunction",
	"TSEmptyBodyFunctionExpression",
	"TSFunctionType",
	"TSMethodSignature",
];

/** Build a visitor object that runs the same handler for every parameter owner. */
export function forEachParameterOwner(handler) {
	return Object.fromEntries(PARAMETER_OWNERS.map((type) => [type, handler]));
}

/** The type annotation on a parameter, seeing through parameter properties, rest, and defaults. */
export function parameterAnnotation(parameter) {
	if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter);
	if (parameter.type === "RestElement") {
		return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
	}
	return parameter.typeAnnotation;
}

/** A readable name for a parameter, falling back to its source text with the annotation trimmed. */
export function parameterName(parameter, sourceCode, annotationPattern) {
	if (parameter.type === "TSParameterProperty") {
		return parameterName(parameter.parameter, sourceCode, annotationPattern);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameterName(parameter.left, sourceCode, annotationPattern);
	}
	if (parameter.type === "RestElement") {
		return parameterName(parameter.argument, sourceCode, annotationPattern);
	}
	return parameter.type === "Identifier"
		? parameter.name
		: sourceCode.getText(parameter).replace(annotationPattern, "");
}
