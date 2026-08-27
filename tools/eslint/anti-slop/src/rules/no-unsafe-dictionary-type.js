import {
	classifyUnsafeDictionary,
	classifyUnsafeDictionaryValue,
	createTypeEnvironment,
} from "../shared/dictionary-types.js";
import { typeReferenceName } from "../shared/ast.js";

const TYPE_NODE_KINDS = new Set([
	"TSAnyKeyword",
	"TSArrayType",
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSConditionalType",
	"TSConstructorType",
	"TSFunctionType",
	"TSImportType",
	"TSIndexedAccessType",
	"TSInferType",
	"TSIntersectionType",
	"TSIntrinsicKeyword",
	"TSLiteralType",
	"TSMappedType",
	"TSNamedTupleMember",
	"TSNeverKeyword",
	"TSNullKeyword",
	"TSNumberKeyword",
	"TSObjectKeyword",
	"TSParenthesizedType",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSTemplateLiteralType",
	"TSThisType",
	"TSTupleType",
	"TSTypeLiteral",
	"TSTypeOperator",
	"TSTypePredicate",
	"TSTypeQuery",
	"TSTypeReference",
	"TSUndefinedKeyword",
	"TSUnionType",
	"TSUnknownKeyword",
	"TSVoidKeyword",
]);

function isTypeNode(node) {
	return TYPE_NODE_KINDS.has(node.type);
}

function isInsideTypeAliasDeclaration(node) {
	let current = node.parent;
	while (current !== undefined && current !== null && current.type !== "Program") {
		if (current.type === "TSTypeAliasDeclaration") return true;
		current = current.parent;
	}
	return false;
}

/** A bare use of a locally declared alias is the alias's problem, not the consumer's. */
function isPlainAliasConsumerUse(node, environment) {
	if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
	const name = typeReferenceName(node);
	return name !== null && environment.aliases.has(name) && !isInsideTypeAliasDeclaration(node);
}

/** Report the outermost unsafe dictionary in a nest, never each layer. */
function shouldReportType(node, environment) {
	if (isPlainAliasConsumerUse(node, environment)) return false;
	if (classifyUnsafeDictionary(node, environment) === null) return false;
	let current = node.parent;
	while (current !== undefined && current !== null && current.type !== "Program") {
		if (isTypeNode(current) && classifyUnsafeDictionary(current, environment) !== null) return false;
		current = current.parent;
	}
	return true;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryType = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
		},
		schema: [],
		messages: {
			unsafeDictionary:
				"This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
		},
	},
	create(context) {
		let environment = null;
		const report = (node, value) => {
			context.report({ node, messageId: "unsafeDictionary", data: { value } });
		};
		const reportIfUnsafe = (node) => {
			if (environment === null || !shouldReportType(node, environment)) return;
			const unsafe = classifyUnsafeDictionary(node, environment);
			if (unsafe === null) return;
			report(node, unsafe.unsafeValue);
		};

		return {
			Program(node) {
				environment = createTypeEnvironment(node);
			},
			TSTypeReference: reportIfUnsafe,
			TSTypeLiteral: reportIfUnsafe,
			TSMappedType: reportIfUnsafe,
			TSIndexSignature(node) {
				if (
					environment === null ||
					node.typeAnnotation === null ||
					node.typeAnnotation === undefined ||
					node.parent.type === "TSTypeLiteral"
				) {
					return;
				}
				const unsafe = classifyUnsafeDictionaryValue(
					node.typeAnnotation.typeAnnotation,
					environment,
				);
				if (unsafe !== null) report(node, unsafe.unsafeValue);
			},
		};
	},
};
