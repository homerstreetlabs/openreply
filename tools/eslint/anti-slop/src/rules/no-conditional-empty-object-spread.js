import { unwrapParentheses } from "../shared/ast.js";

function isEmptyObjectExpression(node) {
	return node.type === "ObjectExpression" && node.properties.length === 0;
}

function isConditionalEmptyObjectSpread(node) {
	const conditional = unwrapParentheses(node);
	return (
		conditional.type === "ConditionalExpression" &&
		(isEmptyObjectExpression(conditional.consequent) ||
			isEmptyObjectExpression(conditional.alternate))
	);
}

/** Ban conditional empty-object spreads without changing their omission semantics. */
export const noConditionalEmptyObjectSpread = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Disallow object spreads that conditionally spread an empty object to omit fields.",
		},
		schema: [],
		messages: {
			avoid:
				"This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present.",
		},
	},
	create(context) {
		return {
			SpreadElement(node) {
				if (node.parent.type !== "ObjectExpression") return;
				if (isConditionalEmptyObjectSpread(node.argument)) {
					context.report({ node, messageId: "avoid" });
				}
			},
		};
	},
};
