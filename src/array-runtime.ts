import type { ArrayOperation } from "./array-abi.js";
import {
	clone,
	snapshot,
	ThrowableValue,
	getMemberType,
	setMemberType,
	deleteMemberType,
} from "./values.js";
import type { Value } from "./values.js";
import { NativeRuntimeError } from "./stdlib-native.js";
import { assertIntegerRange, getIntegerBounds } from "./numeric.js";

/** Arguments have already been checked against the instantiated intrinsic ABI. */
export function invokeArray(operation: ArrayOperation, args: Value[]): Value {
	if (operation === "create") return [];
	const array = args[0] as Value[],
		rawIndex = args[1];
	const inBounds =
		typeof rawIndex === "bigint" &&
		rawIndex >= 0n &&
		rawIndex < BigInt(array.length);
	// Array length is a host safe integer, so this conversion is exact only after
	// the bounds check above. Never convert arbitrary language integers first.
	const index = inBounds ? Number(rawIndex) : -1;
	switch (operation) {
		case "length":
			return assertIntegerRange(BigInt(array.length), "int32");
		case "get":
			return inBounds
				? snapshot(array[index]!)
				: new ThrowableValue("Array index out of bounds");
		case "set":
			if (!inBounds)
				return new ThrowableValue("Array index out of bounds");
			array[index] = clone(args[2]!, false);
			deleteMemberType(array, index);
			const assignedType = getMemberType(args, 2);
			if (assignedType) setMemberType(array, index, assignedType);
			return null;
		case "push":
			if (BigInt(array.length) >= getIntegerBounds("int32").max)
				throw new NativeRuntimeError(
					"Array length exceeds int32 range",
				);
			array.push(clone(args[1]!, false));
			const pushedType = getMemberType(args, 1);
			if (pushedType) setMemberType(array, array.length - 1, pushedType);
			return null;
		case "pop": {
			if (!array.length)
				return new ThrowableValue("Cannot pop an empty array");
			deleteMemberType(array, array.length - 1);
			return array.pop()!;
		}
		case "remove": {
			if (!inBounds)
				return new ThrowableValue("Array index out of bounds");
			for (let i = index; i < array.length - 1; i++) {
				const type = getMemberType(array, i + 1);
				deleteMemberType(array, i);
				if (type) setMemberType(array, i, type);
			}
			deleteMemberType(array, array.length - 1);
			return array.splice(index, 1)[0]!;
		}
	}
}
