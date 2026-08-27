import { end, start } from "../shared/ast.js";

const COMMENT_OWNER_KINDS = new Set([
	"ExpressionStatement",
	"PropertyDefinition",
	"ReturnStatement",
	"ThrowStatement",
	"VariableDeclaration",
]);

function isConstAssertion(node) {
	return (
		node.typeAnnotation.type === "TSTypeReference" &&
		node.typeAnnotation.typeName.type === "Identifier" &&
		node.typeAnnotation.typeName.name === "const"
	);
}

/**
 * Walk out from the assertion to its owning statement, looking for a `SAFETY:` comment
 * attached at any level. The comment has to sit before the assertion itself, so a trailing
 * one on a later line cannot launder it.
 */
function hasSafetyComment(sourceCode, node) {
	let current = node;
	for (;;) {
		const comments = sourceCode.getCommentsBefore(current);
		if (comments.some((comment) => end(comment) <= start(node) && /\bSAFETY\s*:/u.test(comment.value))) {
			return true;
		}
		if (COMMENT_OWNER_KINDS.has(current.type)) return false;
		const parent = current.parent;
		if (parent === undefined || parent === null || parent.type === "Program") return false;
		current = parent;
	}
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertion = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
		},
		schema: [],
		messages: {
			missingSafetyComment:
				"This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
		},
	},
	create(context) {
		const checkAssertion = (node) => {
			if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node)) return;
			context.report({ node, messageId: "missingSafetyComment" });
		};

		return { TSAsExpression: checkAssertion, TSTypeAssertion: checkAssertion };
	},
};
