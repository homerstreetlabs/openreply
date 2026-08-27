const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function isProjectLocalImport(source) {
	return source.startsWith("./") || source.startsWith("../");
}

function importedName(specifier) {
	return specifier.imported.type === "Identifier"
		? specifier.imported.name
		: specifier.imported.value;
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImports = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow project-local make<CapabilityName> imports outside test and spec files.",
		},
		schema: [],
		messages: {
			serviceConstructorImport:
				'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
		},
	},
	create(context) {
		const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));

		return {
			ImportDeclaration(node) {
				if (isTestFile || !isProjectLocalImport(node.source.value)) return;

				for (const specifier of node.specifiers) {
					if (specifier.type !== "ImportSpecifier") continue;

					const name = importedName(specifier);
					if (!SERVICE_CONSTRUCTOR_NAME.test(name)) continue;

					context.report({
						node: specifier,
						messageId: "serviceConstructorImport",
						data: { name },
					});
				}
			},
		};
	},
};
