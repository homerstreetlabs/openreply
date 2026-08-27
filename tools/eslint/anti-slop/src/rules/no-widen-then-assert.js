import {
	end,
	start,
	typeReferenceName,
	unwrapParentheses,
	unwrapTypeParentheses,
} from "../shared/ast.js";
import { anyVariableDeclarator } from "../shared/scope.js";

const FUNCTION_BOUNDARY_TYPES = new Set([
	"ArrowFunctionExpression",
	"FunctionDeclaration",
	"FunctionExpression",
	"TSDeclareFunction",
	"TSEmptyBodyFunctionExpression",
]);

function isUnknownOrAnyType(type) {
	const unwrapped = unwrapTypeParentheses(type);
	return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

function isBroadRecordKeyType(type) {
	const unwrapped = unwrapTypeParentheses(type);
	if (
		unwrapped.type === "TSStringKeyword" ||
		unwrapped.type === "TSNumberKeyword" ||
		unwrapped.type === "TSSymbolKeyword"
	) {
		return true;
	}
	if (unwrapped.type === "TSUnionType") return unwrapped.types.every(isBroadRecordKeyType);
	return unwrapped.type === "TSTypeReference" && typeReferenceName(unwrapped) === "PropertyKey";
}

function isBroadRecordType(type) {
	const unwrapped = unwrapTypeParentheses(type);

	if (unwrapped.type === "TSTypeReference") {
		if (typeReferenceName(unwrapped) === "Readonly") {
			const [inner] = unwrapped.typeArguments?.params ?? [];
			return inner !== undefined && isBroadRecordType(inner);
		}

		if (typeReferenceName(unwrapped) !== "Record") return false;
		const parameters = unwrapped.typeArguments?.params ?? [];
		return (
			parameters.length === 2 &&
			parameters[0] !== undefined &&
			parameters[1] !== undefined &&
			isBroadRecordKeyType(parameters[0]) &&
			isUnknownOrAnyType(parameters[1])
		);
	}

	if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) return false;
	const [member] = unwrapped.members;
	if (member?.type !== "TSIndexSignature" || member.parameters.length !== 1) return false;
	const [parameter] = member.parameters;
	return (
		parameter !== undefined &&
		isBroadRecordKeyType(parameter.typeAnnotation.typeAnnotation) &&
		isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
	);
}

function broadTypeKind(type) {
	const unwrapped = unwrapTypeParentheses(type);
	if (unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword") return "top";
	if (unwrapped.type === "TSObjectKeyword") return "object";
	return isBroadRecordType(unwrapped) ? "record" : null;
}

function assertedExpression(node) {
	return unwrapParentheses(node.expression);
}

function assertionFromExpression(expression) {
	const unwrapped = unwrapParentheses(expression);
	return unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion"
		? unwrapped
		: null;
}

function normalizedTypeText(sourceText, type) {
	return sourceText.slice(start(type), end(type)).replaceAll(/\s+/gu, "");
}

function typesHaveSameSyntax(sourceText, left, right) {
	return (
		left !== null &&
		normalizedTypeText(sourceText, unwrapTypeParentheses(left)) ===
			normalizedTypeText(sourceText, unwrapTypeParentheses(right))
	);
}

function isDefinitelyObjectType(type) {
	const unwrapped = unwrapTypeParentheses(type);
	switch (unwrapped.type) {
		case "TSArrayType":
		case "TSConstructorType":
		case "TSFunctionType":
		case "TSMappedType":
		case "TSObjectKeyword":
		case "TSTupleType":
			return true;
		case "TSTypeLiteral":
			return unwrapped.members.length > 0;
		case "TSIntersectionType":
			return unwrapped.types.every(isDefinitelyObjectType);
		case "TSTypeOperator":
			return unwrapped.operator === "readonly" && isDefinitelyObjectType(unwrapped.typeAnnotation);
		default:
			return false;
	}
}

function isDefinitelyNarrowerRecordType(type) {
	const unwrapped = unwrapTypeParentheses(type);
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type !== "TSIndexSignature");
	}

	if (unwrapped.type !== "TSTypeReference") return false;
	if (typeReferenceName(unwrapped) === "Readonly") {
		const [inner] = unwrapped.typeArguments?.params ?? [];
		return inner !== undefined && isDefinitelyNarrowerRecordType(inner);
	}
	if (typeReferenceName(unwrapped) !== "Record") return false;

	const parameters = unwrapped.typeArguments?.params ?? [];
	return parameters.length === 2 && parameters[1] !== undefined && !isUnknownOrAnyType(parameters[1]);
}

function functionBoundary(node) {
	let current = node.parent;
	while (current !== undefined && current !== null && current.type !== "Program") {
		if (FUNCTION_BOUNDARY_TYPES.has(current.type)) return current;
		current = current.parent;
	}
	return null;
}

/**
 * Find the scope-analysis reference for this exact identifier and take what it resolved to.
 * Matching on range rather than object identity keeps this working when a rule sees a node
 * the scope manager recorded from a different traversal.
 */
function resolvedVariableForIdentifier(scopes, identifier) {
	for (const scope of scopes) {
		const reference = scope.references.find(
			(candidate) =>
				start(candidate.identifier) === start(identifier) &&
				end(candidate.identifier) === end(identifier),
		);
		if (reference !== undefined) return reference.resolved;
	}
	return null;
}

function knownValueEvidence(expression, scopes, boundary, visitedVariables) {
	const unwrapped = unwrapParentheses(expression);

	if (unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion") {
		if (broadTypeKind(unwrapped.typeAnnotation) !== null) return null;
		return { type: unwrapped.typeAnnotation };
	}

	if (
		unwrapped.type === "Literal" ||
		unwrapped.type === "TemplateLiteral" ||
		unwrapped.type === "ArrayExpression" ||
		unwrapped.type === "ArrowFunctionExpression" ||
		unwrapped.type === "ClassExpression" ||
		unwrapped.type === "FunctionExpression" ||
		unwrapped.type === "NewExpression" ||
		unwrapped.type === "ObjectExpression"
	) {
		return { type: null };
	}

	if (unwrapped.type !== "Identifier") return null;
	const variable = resolvedVariableForIdentifier(scopes, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return null;

	const annotatedIdentifier = variable.identifiers.find(
		(identifier) => identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined,
	);
	const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
	if (annotation !== undefined && annotatedIdentifier !== undefined) {
		if (functionBoundary(annotatedIdentifier) !== boundary || broadTypeKind(annotation) !== null) {
			return null;
		}
		return { type: annotation };
	}

	const declarator = anyVariableDeclarator(variable);
	if (
		declarator === null ||
		declarator.parent.type !== "VariableDeclaration" ||
		declarator.parent.kind !== "const" ||
		declarator.init === null ||
		declarator.init === undefined ||
		variable.references.some((reference) => reference.isWrite() && !reference.init) ||
		functionBoundary(declarator) !== boundary
	) {
		return null;
	}

	return knownValueEvidence(
		declarator.init,
		scopes,
		boundary,
		new Set([...visitedVariables, variable]),
	);
}

function widenedBinding(variable, scopes) {
	const declarator = anyVariableDeclarator(variable);
	if (
		declarator === null ||
		declarator.parent.type !== "VariableDeclaration" ||
		declarator.parent.kind !== "const" ||
		declarator.id.type !== "Identifier" ||
		declarator.init === null ||
		declarator.init === undefined ||
		variable.references.some((reference) => reference.isWrite() && !reference.init)
	) {
		return null;
	}

	const boundary = functionBoundary(declarator);
	const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
	const initializerAssertion = assertionFromExpression(declarator.init);
	const initializerBroadKind =
		initializerAssertion === null ? null : broadTypeKind(initializerAssertion.typeAnnotation);
	const declaredBroadKind = declaredType === undefined ? null : broadTypeKind(declaredType);
	const broadKind = declaredBroadKind ?? initializerBroadKind;
	if (broadKind === null) return null;

	const originalExpression =
		initializerAssertion !== null && initializerBroadKind !== null
			? assertedExpression(initializerAssertion)
			: declarator.init;
	const evidence = knownValueEvidence(originalExpression, scopes, boundary, new Set([variable]));
	return evidence === null
		? null
		: { broadKind, evidence, declaredAt: end(declarator), boundary };
}

function assertionIsNarrower(sourceText, broadKind, evidence, assertedType) {
	if (broadTypeKind(assertedType) !== null) return false;
	if (broadKind === "top") return true;
	if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
	if (broadKind === "object") return isDefinitelyObjectType(assertedType);
	return isDefinitelyNarrowerRecordType(assertedType);
}

/** Detect immutable local bindings that erase a known type and are later asserted back. */
export const noWidenThenAssert = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
		},
		schema: [],
		messages: {
			widenThenAssert:
				'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
		},
	},
	create(context) {
		let scopes = [];

		const checkAssertion = (node) => {
			const expression = assertedExpression(node);
			if (expression.type !== "Identifier") return;

			const variable = resolvedVariableForIdentifier(scopes, expression);
			if (variable === null) return;
			const widened = widenedBinding(variable, scopes);
			if (
				widened === null ||
				start(node) <= widened.declaredAt ||
				functionBoundary(node) !== widened.boundary ||
				!assertionIsNarrower(
					context.sourceCode.text,
					widened.broadKind,
					widened.evidence,
					node.typeAnnotation,
				)
			) {
				return;
			}

			context.report({ node, messageId: "widenThenAssert", data: { name: expression.name } });
		};

		return {
			Program() {
				scopes = context.sourceCode.scopeManager.scopes;
			},
			TSAsExpression: checkAssertion,
			TSTypeAssertion: checkAssertion,
		};
	},
};
