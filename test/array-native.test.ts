import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compile } from "../src/compiler.js";
import type { TypeNode } from "../src/ast.js";
import { NativeRegistry } from "../src/native.js";
import { INT32, VOID } from "../src/types.js";
import { FutureValue } from "../src/values.js";
import { check, fixture } from "./helpers.js";

test("array storage uses seven private native declarations and Noma public wrappers", async (t) => {
	const checked = await check(t, 'use "std/arr" as arr; fn main()->void{}');
	const module = checked.program.modules.find(
		(m) => m.id === "std/internal/arr",
	)!;
	const functions = [...checked.functions.get(module)!.values()];
	const natives = functions.filter((fn) => fn.declaration.native);
	assert.equal(natives.length, 7);
	for (const fn of natives) {
		assert.equal(fn.declaration.public, false);
		assert.equal(fn.declaration.typeParams?.length, 1);
		assert.equal(fn.declaration.body, null);
		assert.match(fn.intrinsic!, /^array\./);
	}
	for (const fn of functions.filter((fn) => fn.declaration.public)) {
		assert.equal(fn.declaration.native, false);
		assert.ok(fn.declaration.body);
	}
	new NativeRegistry().link(checked);
});

test("registered array ABI preserves zero-copy reads, invariant mut cells and moved results", async (t) => {
	const checked = await check(t, 'use "std/arr" as arr; fn main()->void{}');
	const module = checked.program.modules.find(
		(m) => m.id === "std/internal/arr",
	)!;
	const registry = new NativeRegistry();
	registry.link(checked);
	const span = checked.program.entry.ast.span;
	const int: TypeNode = { kind: "name", name: "int32", span };
	const instance = (name: string, type: TypeNode) =>
		checked.instantiate(
			checked.functions.get(module)!.get(name)!,
			[type],
			checked.program.entry,
			{ span },
		);
	const future = new FutureValue(async () => 42n, INT32, span);
	const length = instance("lengthArray", {
		kind: "name",
		name: "Future",
		typeArgs: [int],
		span,
	});
	assert.equal(await registry.call(length, [[future]]), 1n);
	assert.equal(await registry.call(length, [[future]]), 1n);
	assert.equal(await future.take(), 42n);
	const type: TypeNode = { kind: "array", element: int, span };
	const first = [1n],
		last = [2n],
		storage = [first, last];
	const cell = {
		get: () => storage,
		set: () => {
			throw new Error("Unnecessary replacement");
		},
	};
	const get = instance("getArray", type),
		pop = instance("popArray", type);
	assert.notEqual(await registry.call(get, [storage, 0n]), first);
	await assert.rejects(
		registry.call(get, [storage, 0]),
		/Native input contract violation/,
	);
	assert.equal(await registry.call(pop, [cell]), last);
	assert.deepEqual(storage, [first]);
	await assert.rejects(registry.call(pop, [storage]), /borrow mode/);
	await assert.rejects(
		registry.call(pop, [{ get: () => ["bad"], set: () => {} }]),
		/Native input contract violation/,
	);
	await assert.rejects(
		registry.call(pop, [{ ...cell, get: () => [["bad"]] }]),
		/Native input contract violation/,
	);
	assert.throws(
		() =>
			registry.register("std/internal/arr#popArray", {
				inputs: [],
				result: VOID,
				invoke: async () => null,
			}),
		/Duplicate native binding/,
	);
});

for (const [name, from, to] of [
	["missing mut", "setArray<T>(mut array", "setArray<T>(array"],
	[
		"wrong result",
		"lengthArray<T>(array: Array<T>) -> int32;",
		"lengthArray<T>(array: Array<T>) -> bool;",
	],
	["extra type parameter", "createArray<T>()", "createArray<T, U>()"],
	["public native", "native fn getArray", "pub native fn getArray"],
	["missing native flag", "native fn removeArray", "fn removeArray"],
] as const) {
	test(`checker rejects a malformed trusted array native: ${name}`, async (t) => {
		const file = await fixture(
			t,
			'use "std/arr" as arr; fn main()->void{}',
		);
		await assert.rejects(
			compile(file, {
				fileSystem: {
					realpath,
					async readFile(file) {
						const source = await readFile(file, "utf8");
						if (
							file.endsWith(
								path.join("std", "internal", "arr.noma"),
							)
						) {
							assert.ok(source.includes(from));
							return source.replace(from, to);
						}
						return source;
					},
				},
			}),
			/Invalid array native signature/,
		);
	});
}

test("other native declarations gain neither generic nor mut privileges", async (t) => {
	await assert.rejects(
		check(t, "native fn createArray<T>()->Array<T>; fn main()->void{}"),
		/native declarations cannot be generic/,
	);
	await assert.rejects(
		check(t, "native fn modify(mut value:int32)->void; fn main()->void{}"),
		/trusted std\/internal module/,
	);
});
