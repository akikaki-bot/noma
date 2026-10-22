import type { Type } from "./types.js";
import { equivalent, projectionAlternative, variants } from "./types.js";
import { LanguageError } from "./ast.js";
import type { Span } from "./ast.js";
import { getIntegerBounds, isIntegerType, isNumericType } from "./numeric.js";

// Primitive integers remain bigint. Aggregate slots retain concrete type identity
// separately so numeric unions never guess an integer's width from its value.
const memberTypes = new WeakMap<object, Map<string | number, Type>>();
export function getMemberType(
	value: object,
	key: string | number,
): Type | undefined {
	return memberTypes.get(value)?.get(key);
}
export function setMemberType(
	value: object,
	key: string | number,
	type: Type,
): void {
	let types = memberTypes.get(value);
	if (!types) memberTypes.set(value, (types = new Map()));
	types.set(key, type);
}
export function deleteMemberType(value: object, key: string | number): void {
	memberTypes.get(value)?.delete(key);
}

/** No work and no host Promise is created until the executor consumes this value. */
export class FutureValue {
	private state: "pending" | "running" | "completed" | "failed" = "pending";
	private task: (() => Promise<Value>) | undefined;
	constructor(
		task: () => Promise<Value>,
		readonly resultType: Type,
		private readonly span: Span,
	) {
		this.task = task;
	}
	async take(): Promise<Value> {
		if (this.state !== "pending")
			throw new LanguageError(this.span, "Future was already consumed");
		this.state = "running";
		const task = this.task!;
		this.task = undefined;
		try {
			const result = await task();
			if (!matches(result, this.resultType))
				throw new LanguageError(
					this.span,
					"Future result violates its checked type",
				);
			this.state = "completed";
			return result;
		} catch (error) {
			this.state = "failed";
			if (error instanceof LanguageError) throw error;
			if (variants(this.resultType).some((t) => t.kind === "throwable"))
				return hostError(error);
			throw new LanguageError(
				this.span,
				`Future execution failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

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
	| bigint
	| boolean
	| null
	| ThrowableValue
	| FutureValue
	| Value[]
	| { [key: string]: Value };
export function matches(
	value: unknown,
	type: Type,
	actual?: Type,
): value is Value {
	if (isNumericType(type.kind) && actual && actual.kind !== type.kind)
		return false;
	if (isIntegerType(type.kind)) {
		const bounds = getIntegerBounds(type.kind);
		return (
			typeof value === "bigint" &&
			value >= bounds.min &&
			value <= bounds.max
		);
	}
	switch (type.kind) {
		case "string":
			return typeof value === "string";
		case "float32":
			return (
				typeof value === "number" &&
				(Number.isNaN(value) || Object.is(value, Math.fround(value)))
			);
		case "float64":
			return typeof value === "number";
		case "bool":
			return typeof value === "boolean";
		case "void":
			return value === null;
		case "never":
			return false;
		case "throwable":
			return value instanceof ThrowableValue;
		case "future":
			return (
				value instanceof FutureValue &&
				// The opaque object's result contract is invariant.
				equivalent(value.resultType, type.result)
			);
		case "tsany":
		case "meta":
		case "intrinsic":
		case "parameter":
			return false;
		case "array":
			return (
				Array.isArray(value) &&
				value.every((element, index) =>
					matches(
						element,
						type.element,
						getMemberType(value, index) ??
							(actual?.kind === "array"
								? actual.element
								: undefined),
					),
				)
			);
		case "union":
			return type.members.some((member) =>
				matches(value, member, actual),
			);
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
					matches(
						(value as Record<string, unknown>)[key],
						field,
						getMemberType(value, key) ??
							(actual?.kind === "struct"
								? actual.fields.get(key)
								: undefined),
					),
			);
		}
		default:
			return false;
	}
}
/** Snapshot semantics: an independent Deep Readonly value. Copying is an implementation choice. */
export function snapshot(value: Value): Value {
	return clone(value, true);
}
/** Validate first, then copy only target fields; never parse/coerce primitive values. */
export class ProjectionError extends Error {}
function projectionTarget(value: Value, target: Type, actual?: Type): Type {
	if (target.kind !== "union") return target;
	const selected = projectionAlternative(
		target.members.filter((member) => matches(value, member, actual)),
	);
	if (!selected)
		throw new ProjectionError("Ambiguous structural projection target");
	return projectionTarget(value, selected, actual);
}
export function project(value: Value, target: Type, actual?: Type): Value {
	if (!matches(value, target, actual))
		throw new ProjectionError(
			"Value does not conform to projection target",
		);
	if (target.kind === "union") {
		return project(value, projectionTarget(value, target, actual), actual);
	}
	if (target.kind === "array") {
		const original = value as Value[];
		const copy = original.map((element, index) =>
			project(
				element,
				target.element,
				getMemberType(original, index) ??
					(actual?.kind === "array" ? actual.element : undefined),
			),
		);
		for (let index = 0; index < copy.length; index++) {
			setMemberType(
				copy,
				index,
				projectionTarget(
					original[index]!,
					target.element,
					getMemberType(original, index) ??
						(actual?.kind === "array" ? actual.element : undefined),
				),
			);
		}
		return Object.freeze(copy) as unknown as Value;
	}
	if (target.kind === "struct") {
		const copy = Object.create(null) as Record<string, Value>;
		for (const [key, type] of target.fields) {
			copy[key] = project(
				(value as Record<string, Value>)[key]!,
				type,
				getMemberType(value as object, key) ??
					(actual?.kind === "struct"
						? actual.fields.get(key)
						: undefined),
			);
			setMemberType(
				copy,
				key,
				projectionTarget(
					(value as Record<string, Value>)[key]!,
					type,
					getMemberType(value as object, key) ??
						(actual?.kind === "struct"
							? actual.fields.get(key)
							: undefined),
				),
			);
		}
		return Object.freeze(copy);
	}
	return snapshot(value);
}
export function clone(value: Value, readonly: boolean): Value {
	if (value instanceof FutureValue) throw new Error("Future is non-copyable");
	if (
		value === null ||
		typeof value !== "object" ||
		value instanceof ThrowableValue
	)
		return value;
	if (Array.isArray(value)) {
		const copy = value.map((element) => clone(element, readonly));
		const types = memberTypes.get(value);
		if (types) memberTypes.set(copy, new Map(types));
		if (readonly) Object.freeze(copy);
		return copy;
	}
	const copy: Record<string, Value> = Object.create(null) as Record<
		string,
		Value
	>;
	for (const [key, field] of Object.entries(value))
		copy[key] = clone(field, readonly);
	const types = memberTypes.get(value);
	if (types) memberTypes.set(copy, new Map(types));
	if (readonly) Object.freeze(copy);
	return copy;
}
/** Freeze newly owned storage without copying a popped/removed value. */
export function freezeOwned(value: Value): Value {
	if (
		value === null ||
		typeof value !== "object" ||
		value instanceof FutureValue ||
		value instanceof ThrowableValue ||
		Object.isFrozen(value)
	)
		return value;
	for (const field of Object.values(value)) freezeOwned(field);
	return Object.freeze(value) as Value;
}
export function hostError(error: unknown): ThrowableValue {
	return new ThrowableValue(
		error instanceof Error ? error.message : String(error),
	);
}
