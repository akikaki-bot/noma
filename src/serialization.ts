import type { Type } from "./types.js";
import { assignable } from "./types.js";
import {
	FutureValue,
	ThrowableValue,
	getMemberType,
	matches,
	setMemberType,
} from "./values.js";
import type { Value } from "./values.js";
import { assertIntegerRange, isIntegerType, isNumericType } from "./numeric.js";

type WireType =
	| { kind: string }
	| { kind: "array"; element: WireType }
	| { kind: "struct"; fields: [string, WireType][] }
	| { kind: "union"; members: WireType[] };
interface WireValue {
	type: WireType;
	data:
		| string
		| number
		| boolean
		| null
		| WireValue[]
		| Record<string, WireValue>;
}
const primitiveKinds = new Set([
	"string",
	"bool",
	"void",
	"throwable",
	"int8",
	"int16",
	"int32",
	"int64",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"float32",
	"float64",
]);
const invalid = (message: string): never => {
	throw new TypeError(`Invalid Noma value serialization: ${message}`);
};
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function encodeType(type: Type): WireType {
	if (primitiveKinds.has(type.kind)) return { kind: type.kind };
	switch (type.kind) {
		case "array":
			return { kind: "array", element: encodeType(type.element) };
		case "struct":
			return {
				kind: "struct",
				fields: [...type.fields].map(([key, field]) => [
					key,
					encodeType(field),
				]),
			};
		case "union":
			return { kind: "union", members: type.members.map(encodeType) };
		default:
			return invalid(`opaque or unresolved type '${type.kind}'`);
	}
}
function decodeType(wire: unknown): Type {
	if (!record(wire) || typeof wire.kind !== "string")
		return invalid("missing type");
	if (primitiveKinds.has(wire.kind)) return { kind: wire.kind } as Type;
	if (wire.kind === "array")
		return { kind: "array", element: decodeType(wire.element) };
	if (wire.kind === "union") {
		if (!Array.isArray(wire.members) || !wire.members.length)
			return invalid("invalid union type");
		return { kind: "union", members: wire.members.map(decodeType) };
	}
	if (wire.kind === "struct") {
		if (!Array.isArray(wire.fields)) return invalid("invalid struct type");
		const fields = new Map<string, Type>();
		for (const field of wire.fields) {
			if (
				!Array.isArray(field) ||
				field.length !== 2 ||
				typeof field[0] !== "string" ||
				fields.has(field[0])
			)
				return invalid("invalid or duplicate struct field");
			fields.set(field[0], decodeType(field[1]));
		}
		return { kind: "struct", fields };
	}
	return invalid(`unsupported type '${wire.kind}'`);
}
/** Shape discrimination never uses an integer's magnitude to infer its width. */
function sameShape(value: Value, type: Type): boolean {
	if (isIntegerType(type.kind)) return typeof value === "bigint";
	if (isNumericType(type.kind)) return typeof value === "number";
	switch (type.kind) {
		case "union":
			return type.members.some((member) => sameShape(value, member));
		case "array":
			return (
				Array.isArray(value) &&
				value.every((item) => sameShape(item, type.element))
			);
		case "struct":
			return (
				record(value) &&
				!(value instanceof ThrowableValue) &&
				!(value instanceof FutureValue) &&
				[...type.fields].every(
					([key, field]) =>
						Object.hasOwn(value, key) &&
						sameShape(value[key]!, field),
				)
			);
		default:
			return matches(value, type);
	}
}
function concreteType(value: Value, expected: Type, actual?: Type): Type {
	if (actual && actual.kind !== "union") {
		if (!assignable(actual, expected))
			return invalid("slot type does not match its declared type");
		return actual;
	}
	if (expected.kind !== "union") return expected;
	const candidates = expected.members.filter((member) =>
		sameShape(value, member),
	);
	if (candidates.length !== 1)
		return invalid(
			"ambiguous union requires concrete type metadata or an explicit concrete root type",
		);
	return concreteType(value, candidates[0]!);
}
function encodeValue(
	value: Value,
	expected: Type,
	active: Set<object>,
	actual?: Type,
): WireValue {
	const type = concreteType(value, expected, actual);
	if (value instanceof FutureValue)
		return invalid("Future is opaque and non-copyable");
	if (!matches(value, type))
		return invalid("value does not match its concrete type");
	if (
		type.kind === "struct" &&
		Object.keys(value as object).length !== type.fields.size
	)
		return invalid("struct fields do not match its concrete type");
	const wireType = encodeType(type);
	if (isIntegerType(type.kind))
		return { type: wireType, data: (value as bigint).toString() };
	if (type.kind === "float32" || type.kind === "float64") {
		const number = value as number;
		return {
			type: wireType,
			data: Number.isNaN(number)
				? "NaN"
				: number === Infinity
					? "+Infinity"
					: number === -Infinity
						? "-Infinity"
						: Object.is(number, -0)
							? "-0"
							: number,
		};
	}
	if (type.kind === "throwable")
		return { type: wireType, data: (value as ThrowableValue).message };
	if (type.kind !== "array" && type.kind !== "struct")
		return { type: wireType, data: value as string | boolean | null };
	const object = value as object;
	if (active.has(object)) return invalid("cyclic aggregate");
	active.add(object);
	try {
		if (type.kind === "array") {
			const array = value as Value[];
			return {
				type: wireType,
				data: array.map((item, index) =>
					encodeValue(
						item,
						type.element,
						active,
						getMemberType(array, index),
					),
				),
			};
		}
		const fields: Record<string, WireValue> = Object.create(null) as Record<
			string,
			WireValue
		>;
		for (const [key, field] of type.fields)
			fields[key] = encodeValue(
				(value as Record<string, Value>)[key]!,
				field,
				active,
				getMemberType(object, key),
			);
		return { type: wireType, data: fields };
	} finally {
		active.delete(object);
	}
}
function decodeValue(
	wire: unknown,
	expected: Type,
): { value: Value; type: Type } {
	if (!record(wire)) return invalid("missing value node");
	const type = decodeType(wire.type);
	if (type.kind === "union" || !assignable(type, expected))
		return invalid("invalid concrete value type");
	const data = wire.data;
	let value: Value;
	if (isIntegerType(type.kind)) {
		if (typeof data !== "string" || !/^-?(0|[1-9]\d*)$/.test(data))
			return invalid("integer requires decimal text");
		value = assertIntegerRange(BigInt(data), type.kind);
	} else if (type.kind === "float32" || type.kind === "float64") {
		if (typeof data === "number" && Number.isFinite(data)) value = data;
		else if (data === "NaN") value = NaN;
		else if (data === "+Infinity") value = Infinity;
		else if (data === "-Infinity") value = -Infinity;
		else if (data === "-0") value = -0;
		else return invalid("invalid floating point representation");
	} else if (type.kind === "array") {
		if (!Array.isArray(data)) return invalid("array requires elements");
		const array: Value[] = [];
		for (let index = 0; index < data.length; index++) {
			const item = decodeValue(data[index], type.element);
			array.push(item.value);
			setMemberType(array, index, item.type);
		}
		value = array;
	} else if (type.kind === "struct") {
		if (!record(data) || Object.keys(data).length !== type.fields.size)
			return invalid("invalid struct fields");
		const fields: Record<string, Value> = Object.create(null) as Record<
			string,
			Value
		>;
		for (const [key, field] of type.fields) {
			if (!Object.hasOwn(data, key))
				return invalid("missing struct field");
			const item = decodeValue(data[key], field);
			fields[key] = item.value;
			setMemberType(fields, key, item.type);
		}
		value = fields;
	} else if (type.kind === "throwable") {
		if (typeof data !== "string")
			return invalid("throwable requires a message");
		value = new ThrowableValue(data);
	} else {
		if (
			data !== null &&
			typeof data !== "string" &&
			typeof data !== "boolean"
		)
			return invalid("invalid primitive value");
		value = data;
	}
	if (!matches(value, type, type))
		return invalid("decoded value violates its concrete type");
	return { value, type };
}
/** Runtime-value transport includes fixed-width identity; BigInt is never a public Noma type. */
export function serializeValue(value: Value, type: Type): string {
	return JSON.stringify({
		format: "noma.value",
		version: 1,
		type: encodeType(type),
		value: encodeValue(value, type, new Set()),
	});
}
export function deserializeValue(json: string): { value: Value; type: Type } {
	const envelope: unknown = JSON.parse(json);
	if (
		!record(envelope) ||
		envelope.format !== "noma.value" ||
		envelope.version !== 1
	)
		return invalid("unsupported format or version");
	const type = decodeType(envelope.type);
	const result = decodeValue(envelope.value, type);
	return result;
}
