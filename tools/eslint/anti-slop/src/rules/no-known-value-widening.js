import { enclosingFunction, unwrapAssertions } from "../shared/ast.js";
import {
	classifyWideningTarget,
	createTypeEnvironment,
	isKnownEvidenceExpression,
} from "../shared/dictionary-types.js";
import { resolveVariable, singleVariableDeclarator } from "../shared/scope.js";

function isStableConstVariable(variable, declarator) {
	return (
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		variable.references.every((reference) => reference.init || !reference.isWrite())
	);
}

/** Follow const bindings back to the expression that gave the value its known type. */
function hasKnownEvidence(sourceCode, expression, visitedVariables = new Set()) {
	if (isKnownEvidenceExpression(expression)) return true;
	const unwrapped = unwrapAssertions(expression);
	if (unwrapped.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return false;
	const declarator = singleVariableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		declarator.init === undefined ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	visitedVariables.add(variable);
	return hasKnownEvidence(sourceCode, declarator.init, visitedVariables);
}

function sourceKeyName(sourceCode, key) {
	if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
	if (key.type === "Literal") return String(key.value);
	return sourceCode.getText(key);
}

function functionName(sourceCode, owner) {
	if (owner === null) return "anonymous function";
	if (owner.id !== null && owner.id !== undefined) return owner.id.name;
	const parent = owner.parent;
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
	if (parent?.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
	return "anonymous function";
}

function isEmptyObjectExpression(expression) {
	const unwrapped = unwrapAssertions(expression);
	return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}

/** `const acc: Record<string, X> = {}` is an accumulator seed, not lost evidence. */
function isDictionaryAccumulatorTarget(destination) {
	return destination.kind === "open dictionary" || destination.kind === "generic container";
}

function hasParentAssertion(node) {
	return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}

/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWidening = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
		},
		schema: [],
		messages: {
			widening:
				"The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
		},
	},
	create(context) {
		let environment = null;

		const reportFlow = (expression, destination, subject) => {
			if (destination === null) return;
			if (isDictionaryAccumulatorTarget(destination) && isEmptyObjectExpression(expression)) return;
			if (!hasKnownEvidence(context.sourceCode, expression)) return;
			context.report({
				node: expression,
				messageId: "widening",
				data: { subject, target: destination.kind },
			});
		};

		const targetFromAnnotation = (annotation) =>
			environment === null || annotation === null || annotation === undefined
				? null
				: classifyWideningTarget(annotation.typeAnnotation, environment);

		const reportProperty = (node) => {
			if (node.value === null || node.value === undefined) return;
			reportFlow(
				node.value,
				targetFromAnnotation(node.typeAnnotation),
				`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
			);
		};

		return {
			Program(node) {
				environment = createTypeEnvironment(node);
			},
			VariableDeclarator(node) {
				if (node.init === null || node.init === undefined || node.id.type !== "Identifier") return;
				reportFlow(
					node.init,
					targetFromAnnotation(node.id.typeAnnotation),
					`binding \`${node.id.name}\``,
				);
			},
			PropertyDefinition: reportProperty,
			AccessorProperty: reportProperty,
			AssignmentExpression(node) {
				if (node.operator !== "=" || node.left.type !== "Identifier") return;
				const variable = resolveVariable(context.sourceCode, node.left);
				if (variable === null) return;
				const declarator = singleVariableDeclarator(variable);
				if (declarator === null || declarator.id.type !== "Identifier") return;
				reportFlow(
					node.right,
					targetFromAnnotation(declarator.id.typeAnnotation),
					`binding \`${declarator.id.name}\``,
				);
			},
			ReturnStatement(node) {
				if (node.argument === null || node.argument === undefined) return;
				const owner = enclosingFunction(node);
				reportFlow(
					node.argument,
					targetFromAnnotation(owner?.returnType),
					`return value of \`${functionName(context.sourceCode, owner)}\``,
				);
			},
			ArrowFunctionExpression(node) {
				if (node.body.type === "BlockStatement") return;
				reportFlow(
					node.body,
					targetFromAnnotation(node.returnType),
					`return value of \`${functionName(context.sourceCode, node)}\``,
				);
			},
			TSAsExpression(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					classifyWideningTarget(node.typeAnnotation, environment),
					"assertion",
				);
			},
			TSTypeAssertion(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					classifyWideningTarget(node.typeAnnotation, environment),
					"assertion",
				);
			},
		};
	},
};
