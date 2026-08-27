import {
	forEachParameterOwner,
	parameterAnnotation,
	parameterName,
} from "../shared/parameters.js";

const UNKNOWN_ANNOTATION = /\s*:\s*unknown\s*$/u;

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParameters = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
		},
		schema: [],
		messages: {
			unknownParameter:
				"Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
		},
	},
	create(context) {
		return forEachParameterOwner((node) => {
			for (const parameter of node.params) {
				const annotation = parameterAnnotation(parameter);
				if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
				const name = parameterName(parameter, context.sourceCode, UNKNOWN_ANNOTATION);
				if (name === "cause") continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "unknownParameter",
					data: { parameter: name },
				});
			}
		});
	},
};
