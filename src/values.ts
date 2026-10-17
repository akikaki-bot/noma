import type { Type } from "./types.js";
import { projectionAlternative } from "./types.js";

// Host errors are opaque, branded values in this experimental ABI.
// Ordinary struct literals cannot manufacture a throwable.
export class ThrowableValue {
	constructor(readonly message: string) {
		Object.freeze(this);
	}
}
export type Value =
	| string
	| number
	| boolean
	| null
	| ThrowableValue
	| Value[]
	| { [key: string]: Value };
export function matches(value: unknown, type: Type): value is Value {
	switch (type.kind) {
		case "string":
			return typeof value === "string";
		case "int32":
			return (
				typeof value === "number" &&
				Number.isInteger(value) &&
				value >= -2147483648 &&
				value <= 2147483647
			);
		case "bool":
			return typeof value === "boolean";
		case "void":
			return value === null;
		case "never":
			return false;
		case "throwable":
			return value instanceof ThrowableValue;
		case "tsany":
		case "meta":
		case "intrinsic":
		case "parameter":
			return false;
		case "array":
			return (
				Array.isArray(value) &&
				value.every((element) => matches(element, type.element))
			);
		case "union":
			return type.members.some((member) => matches(value, member));
		case "struct": {
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				value instanceof ThrowableValue
			)
				return false;
			const prototype: unknown = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null)
				return false;
			return [...type.fields].every(
				([key, field]) =>
					Object.hasOwn(value, key) &&
					matches((value as Record<string, unknown>)[key], field),
			);
		}
	}
}
/** Snapshot semantics: an independent Deep Readonly value. Copying is an implementation choice. */
export function snapshot(value: Value): Value {
	return clone(value, true);
}
/** Validate first, then copy only target fields; never parse/coerce primitive values. */
export class ProjectionError extends Error {}
export function project(value: Value, target: Type): Value {
	if (!matches(value, target))
		throw new ProjectionError(
			"Value does not conform to projection target",
		);
	if (target.kind === "union") {
		const selected = projectionAlternative(
			target.members.filter((member) => matches(value, member)),
		);
		if (!selected)
			throw new ProjectionError("Ambiguous structural projection target");
		return project(value, selected);
	}
	if (target.kind === "array")
		return Object.freeze(
			(value as Value[]).map((element) =>
				project(element, target.element),
			),
		) as unknown as Value;
	if (target.kind === "struct") {
		const copy = Object.create(null) as Record<string, Value>;
		for (const [key, type] of target.fields)
			copy[key] = project((value as Record<string, Value>)[key]!, type);
		return Object.freeze(copy);
	}
	return snapshot(value);
}
export function clone(value: Value, readonly: boolean): Value {
	if (
		value === null ||
		typeof value !== "object" ||
		value instanceof ThrowableValue
	)
		return value;
	if (Array.isArray(value)) {
		const copy = value.map((element) => clone(element, readonly));
		if (readonly) Object.freeze(copy);
		return copy;
	}
	const copy: Record<string, Value> = Object.create(null) as Record<
		string,
		Value
	>;
	for (const [key, field] of Object.entries(value))
		copy[key] = clone(field, readonly);
	if (readonly) Object.freeze(copy);
	return copy;
}
export function hostError(error: unknown): ThrowableValue {
	return new ThrowableValue(
		error instanceof Error ? error.message : String(error),
	);
}
