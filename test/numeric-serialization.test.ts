import assert from "node:assert/strict";
import test from "node:test";
import { deserializeValue, serializeValue } from "../src/serialization.js";
import { equivalent } from "../src/types.js";
import type { Type } from "../src/types.js";
import {
	FutureValue,
	ThrowableValue,
	getMemberType,
	matches,
	setMemberType,
} from "../src/values.js";
import type { Value } from "../src/values.js";
import { getIntegerBounds, integerTypes } from "../src/numeric.js";

test("typed runtime serialization preserves all integer widths and exact decimal values", () => {
	for (const kind of integerTypes) {
		const type: Type = { kind };
		for (const value of Object.values(getIntegerBounds(kind))) {
			const json = serializeValue(value, type);
			assert.ok(json.includes(`"kind":"${kind}"`));
			assert.ok(json.includes(`"data":"${value}"`));
			const result = deserializeValue(json);
			assert.equal(result.value, value);
			assert.ok(equivalent(result.type, type));
		}
	}
	for (const value of [
		9007199254740991n,
		9007199254740992n,
		9007199254740993n,
	])
		assert.equal(
			deserializeValue(serializeValue(value, { kind: "int64" })).value,
			value,
		);
});

test("typed runtime serialization preserves IEEE values including negative zero", () => {
	for (const kind of ["float32", "float64"] as const)
		for (const value of [
			NaN,
			Infinity,
			-Infinity,
			0,
			-0,
			Math.fround(1.1),
		]) {
			const result = deserializeValue(serializeValue(value, { kind }));
			assert.ok(Object.is(result.value, value));
			assert.equal(result.type.kind, kind);
		}
});

test("typed runtime serialization restores nested union slot identities and Map fields", () => {
	const small: Type = { kind: "uint8" },
		large: Type = { kind: "uint64" };
	const numeric: Type = { kind: "union", members: [small, large] };
	const array: Value[] = [7n, 7n, 18446744073709551615n];
	setMemberType(array, 0, small);
	setMemberType(array, 1, large);
	setMemberType(array, 2, large);
	const value: Record<string, Value> = Object.assign(Object.create(null), {
		items: array,
		count: 7n,
	});
	setMemberType(value, "count", small);
	const type: Type = {
		kind: "struct",
		fields: new Map<string, Type>([
			["items", { kind: "array", element: numeric }],
			["count", numeric],
		]),
	};
	const result = deserializeValue(serializeValue(value, type));
	assert.deepEqual(result.value, value);
	assert.ok(equivalent(result.type, type));
	assert.ok(
		result.type.kind === "struct" && result.type.fields instanceof Map,
	);
	const decoded = result.value as Record<string, Value>;
	const items = decoded.items as Value[];
	assert.equal(getMemberType(decoded, "count")?.kind, "uint8");
	assert.equal(getMemberType(items, 0)?.kind, "uint8");
	assert.equal(getMemberType(items, 1)?.kind, "uint64");
	assert.equal(getMemberType(items, 2)?.kind, "uint64");
	assert.equal(matches(items[1], small, getMemberType(items, 1)), false);
	assert.equal(matches(items[1], large, getMemberType(items, 1)), true);
});

test("runtime serialization never guesses numeric union identity from magnitude", () => {
	const small: Type = { kind: "int8" },
		large: Type = { kind: "uint64" };
	const type: Type = { kind: "union", members: [small, large] };
	for (const value of [7n, 18446744073709551615n])
		assert.throws(() => serializeValue(value, type), /concrete type/);
	assert.throws(
		() =>
			serializeValue([18446744073709551615n], {
				kind: "array",
				element: type,
			}),
		/concrete type/,
	);
	const value: Value[] = [18446744073709551615n];
	setMemberType(value, 0, large);
	assert.equal(
		(
			deserializeValue(
				serializeValue(value, { kind: "array", element: type }),
			).value as Value[]
		)[0],
		value[0],
	);
	assert.equal(
		deserializeValue(serializeValue(value[0]!, large)).value,
		value[0],
	);
	assert.throws(
		() =>
			serializeValue(1.1, {
				kind: "union",
				members: [{ kind: "float32" }, { kind: "float64" }],
			}),
		/concrete type/,
	);
	const unique = deserializeValue(
		serializeValue(7n, {
			kind: "union",
			members: [small, { kind: "string" }],
		}),
	);
	assert.equal(unique.type.kind, "int8");
});

test("runtime serialization validates malformed payloads and refuses opaque Futures", () => {
	const integer = JSON.parse(serializeValue(1n, { kind: "uint8" })) as {
		value: { data: unknown; type: unknown };
	};
	for (const data of ["256", "-1", "1.5", 1, null]) {
		integer.value.data = data;
		assert.throws(
			() => deserializeValue(JSON.stringify(integer)),
			/range|serialization/,
		);
	}
	integer.value.data = "1";
	integer.value.type = { kind: "uint64" };
	assert.throws(
		() => deserializeValue(JSON.stringify(integer)),
		/concrete value type/,
	);
	assert.throws(
		() => deserializeValue('{"format":"noma.value","version":2}'),
		/version/,
	);
	assert.throws(
		() => serializeValue(1.1, { kind: "float32" }),
		/concrete type/,
	);
	const future = new FutureValue(
		async () => 1n,
		{ kind: "int32" },
		{ file: "test", line: 1, column: 1 },
	);
	assert.throws(
		() =>
			serializeValue(future, {
				kind: "future",
				result: { kind: "int32" },
			}),
		/opaque/,
	);
	const error = deserializeValue(
		serializeValue(new ThrowableValue("failure"), { kind: "throwable" }),
	).value;
	assert.ok(error instanceof ThrowableValue);
	assert.equal(error.message, "failure");
});
