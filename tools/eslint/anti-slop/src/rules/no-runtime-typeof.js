import { isRuntimeFunction } from "../shared/ast.js";

/** A `typeof` inside a function whose return type is a type predicate is the guard itself. */
function isInsideTypeGuard(node) {
	let current = node.parent;
	while (current !== undefined && current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeof = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: { allowInTypeGuards: { type: "boolean" } },
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const allowInTypeGuards = context.options?.[0]?.allowInTypeGuards === true;
		return {
			UnaryExpression(node) {
				if (node.operator !== "typeof") return;
				if (allowInTypeGuards && isInsideTypeGuard(node)) return;
				context.report({ node, messageId: "runtimeTypeof" });
			},
		};
	},
};
