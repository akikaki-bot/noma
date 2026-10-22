import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { FunctionInfo } from "../src/checker.js";
import { NativeRegistry, NativeValue } from "../src/native.js";
import { FLOAT32, FLOAT64, INT8, INT16, UINT64, union } from "../src/types.js";
import type { Type } from "../src/types.js";
import { getMemberType, setMemberType } from "../src/values.js";
import { check } from "./helpers.js";

async function nativeFunction(
	t: TestContext,
	result: Type,
	inputs: Type[] = [],
): Promise<FunctionInfo> {
	const checked = await check(
		t,
		'use "std/number" as num; fn main()->void{}',
	);
	const module = checked.program.modules.find(
		(value) => value.id === "std/internal/number",
	)!;
	const original = checked.functions.get(module)!.get("numericToString")!;
	return {
		...original,
		params: inputs,
		result,
		declaration: {
			...original.declaration,
			name: "abiProbe",
			params: original.declaration.params.slice(0, inputs.length),
		},
	};
}

test("native results require concrete identity for overlapping numeric unions", async (t) => {
	const type = union([INT8, UINT64]);
	const fn = await nativeFunction(t, type);
	for (const value of [
		1n,
		18446744073709551615n,
		new NativeValue(1n, INT16),
		new NativeValue(1n, FLOAT64),
	]) {
		const registry = new NativeRegistry();
		registry.register("std/internal/number#abiProbe", {
			inputs: [],
			result: type,
			invoke: async () => value,
		});
		await assert.rejects(
			registry.call(fn, []),
			/Native result contract violation/,
		);
	}
	const registry = new NativeRegistry();
	registry.register("std/internal/number#abiProbe", {
		inputs: [],
		result: type,
		invoke: async () => new NativeValue(1n, UINT64),
	});
	assert.deepEqual(await registry.callTyped(fn, []), {
		value: 1n,
		type: UINT64,
	});
	assert.equal(await registry.call(fn, []), 1n);
});

test("native aggregate results validate and retain concrete numeric slot metadata", async (t) => {
	const type: Type = {
		kind: "struct",
		fields: new Map([["n", union([INT8, UINT64])]]),
	};
	const fn = await nativeFunction(t, type);
	const missing = new NativeRegistry();
	missing.register("std/internal/number#abiProbe", {
		inputs: [],
		result: type,
		invoke: async () => ({ n: 1n }),
	});
	await assert.rejects(missing.call(fn, []), /concrete type metadata/);
	const actual: Type = { kind: "struct", fields: new Map([["n", UINT64]]) };
	const registry = new NativeRegistry();
	registry.register("std/internal/number#abiProbe", {
		inputs: [],
		result: type,
		invoke: async () => new NativeValue({ n: 1n }, actual),
	});
	const result = await registry.call(fn, []);
	assert.deepEqual(getMemberType(result as object, "n"), UINT64);
	assert.equal((result as Record<string, bigint>).n, 1n);
});

test("native float32 values must already satisfy binary32 precision", async (t) => {
	const fn = await nativeFunction(t, FLOAT32);
	for (const value of [0.1, 1n, "0.1"]) {
		const registry = new NativeRegistry();
		registry.register("std/internal/number#abiProbe", {
			inputs: [],
			result: FLOAT32,
			invoke: async () => value,
		});
		await assert.rejects(
			registry.call(fn, []),
			/Native result contract violation/,
		);
	}
	for (const value of [Math.fround(0.1), NaN, Infinity, -Infinity, 0, -0]) {
		const registry = new NativeRegistry();
		registry.register("std/internal/number#abiProbe", {
			inputs: [],
			result: FLOAT32,
			invoke: async () => value,
		});
		assert.ok(Object.is(await registry.call(fn, []), value));
	}
});

test("native float unions require concrete precision metadata even for binary64-only values", async (t) => {
	const type = union([FLOAT32, FLOAT64]);
	const fn = await nativeFunction(t, type);
	const untyped = new NativeRegistry();
	untyped.register("std/internal/number#abiProbe", {
		inputs: [],
		result: type,
		invoke: async () => 0.1,
	});
	await assert.rejects(untyped.call(fn, []), /concrete type metadata/);
	const typed = new NativeRegistry();
	typed.register("std/internal/number#abiProbe", {
		inputs: [],
		result: type,
		invoke: async () => new NativeValue(0.1, FLOAT64),
	});
	assert.deepEqual(await typed.callTyped(fn, []), {
		value: 0.1,
		type: FLOAT64,
	});
});

test("native input validation rejects numeric width mismatch and number-backed integers", async (t) => {
	const fn = await nativeFunction(t, INT8, [INT8]);
	const registry = new NativeRegistry();
	registry.register("std/internal/number#abiProbe", {
		inputs: [INT8],
		result: INT8,
		invoke: async (args) => args[0],
	});
	const wrong = [1n];
	setMemberType(wrong, 0, UINT64);
	for (const args of [wrong, [1], [128n]])
		await assert.rejects(
			registry.call(fn, args),
			/Native input contract violation/,
		);
	assert.equal(await registry.call(fn, [1n]), 1n);
});
