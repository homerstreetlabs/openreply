import { isGlobalReflectMethodCall } from "../shared/reflect-method.js";

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGet = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
		},
		schema: [],
		messages: {
			reflectGet:
				"Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "get")) {
					context.report({ node, messageId: "reflectGet" });
				}
			},
		};
	},
};
