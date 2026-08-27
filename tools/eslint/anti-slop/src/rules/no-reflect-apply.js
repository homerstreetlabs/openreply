import { isGlobalReflectMethodCall } from "../shared/reflect-method.js";

/** Ban Reflect.apply, which bypasses ordinary typed function calls. */
export const noReflectApply = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow Reflect.apply; call typed functions directly or model dynamic dispatch behind an interface.",
		},
		schema: [],
		messages: {
			reflectApply:
				"Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "apply")) {
					context.report({ node, messageId: "reflectApply" });
				}
			},
		};
	},
};
