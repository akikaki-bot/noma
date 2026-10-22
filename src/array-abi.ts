import type { Type } from "./types.js";
import { INT32, THROWABLE, VOID, union } from "./types.js";

export const arrayOperations = [
	"create",
	"length",
	"get",
	"set",
	"push",
	"pop",
	"remove",
] as const;
export type ArrayOperation = (typeof arrayOperations)[number];
export type ArrayNative = `array.${ArrayOperation}`;

export const arrayNativeNames: ReadonlyMap<string, ArrayOperation> = new Map(
	arrayOperations.map((operation) => [`${operation}Array`, operation]),
);

export function arrayNativeOperation(
	module: { trusted: boolean; id: string },
	name: string,
): ArrayOperation | undefined {
	return module.trusted && module.id === "std/internal/arr"
		? arrayNativeNames.get(name)
		: undefined;
}

/** Shared static/runtime contracts for the private, borrowing array natives. */
export function arraySignature(
	operation: ArrayOperation,
	element: Type,
): {
	params: Type[];
	mutable: boolean[];
	result: Type;
} {
	const array: Type = { kind: "array", element };
	switch (operation) {
		case "create":
			return { params: [], mutable: [], result: array };
		case "length":
			return { params: [array], mutable: [false], result: INT32 };
		case "get":
			return {
				params: [array, INT32],
				mutable: [false, false],
				result: union([element, THROWABLE]),
			};
		case "set":
			return {
				params: [array, INT32, element],
				mutable: [true, false, false],
				result: union([VOID, THROWABLE]),
			};
		case "push":
			return {
				params: [array, element],
				mutable: [true, false],
				result: VOID,
			};
		case "pop":
			return {
				params: [array],
				mutable: [true],
				result: union([element, THROWABLE]),
			};
		case "remove":
			return {
				params: [array, INT32],
				mutable: [true, false],
				result: union([element, THROWABLE]),
			};
	}
}
