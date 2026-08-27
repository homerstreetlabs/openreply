import { isGlobalReference } from "./scope.js";

/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(sourceCode, callee, methodName) {
	if (callee.type !== "MemberExpression") return false;
	if (callee.object.type !== "Identifier" || callee.object.name !== "Reflect") return false;
	if (!isGlobalReference(sourceCode, callee.object)) return false;
	const property = callee.property;
	return callee.computed
		? property.type === "Literal" && property.value === methodName
		: property.type === "Identifier" && property.name === methodName;
}
