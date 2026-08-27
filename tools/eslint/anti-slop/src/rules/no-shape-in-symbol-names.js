const FORBIDDEN_SYMBOL_NAME = "shape";

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noShapeInSymbolNames = {
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
		},
		schema: [],
		messages: {
			forbiddenSymbolName:
				'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
		},
	},
	create(context) {
		const report = (node) => {
			if (!node.name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME)) return;
			context.report({ node, messageId: "forbiddenSymbolName", data: { name: node.name } });
		};

		return {
			Identifier: report,
			PrivateIdentifier: report,
			JSXIdentifier: report,
		};
	},
};
