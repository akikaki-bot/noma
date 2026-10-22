import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compile, runFile } from "../src/index.js";
import { Interpreter } from "../src/interpreter.js";
import {
	createIORegistry,
	NativeRegistry,
	registerCoreNatives,
} from "../src/native.js";
import {
	checkedInt32,
	codepointAt,
	codepointLength,
	fromCodepoint,
	NativeRuntimeError,
} from "../src/stdlib-native.js";
import { containsTSAny } from "../src/types.js";
import { ThrowableValue } from "../src/values.js";
import { check, MemoryIO, run } from "./helpers.js";

test("Unicode native operations use scalar values, including supplementary planes", () => {
	assert.equal(codepointLength("A😀B"), 3n);
	assert.equal(codepointLength(""), 0n);
	assert.equal(codepointLength("e\u0301"), 2n);
	assert.equal(codepointAt("A😀B", 1n), 0x1f600n);
	for (const value of [0n, 0xd7ffn, 0xe000n, 0xffffn, 0x10000n, 0x10ffffn]) {
		const text = fromCodepoint(value);
		assert.equal(typeof text, "string");
		assert.equal(codepointLength(text as string), 1n);
		assert.equal(codepointAt(text as string, 0n), value);
	}
	for (const index of [-1n, 3n, 2147483647n, 9007199254740993n, 0.5])
		assert.ok(
			codepointAt("A😀B", index as bigint) instanceof ThrowableValue,
		);
	assert.ok(codepointAt("", 0n) instanceof ThrowableValue);
});

test("Unicode native operations reject lone surrogates and non-scalar codepoints", () => {
	for (const text of ["\ud800", "\udfff", "A\ud800", "\udc00A", "😀\ud800"]) {
		assert.throws(() => codepointLength(text), NativeRuntimeError);
		// An invalid suffix is rejected even when index zero would otherwise be valid.
		assert.ok(codepointAt(text, 0n) instanceof ThrowableValue);
	}
	for (const value of [
		-1n,
		0xd800n,
		0xdbffn,
		0xdc00n,
		0xdfffn,
		0x110000n,
		18446744073709551615n,
		1.5,
	])
		assert.ok(fromCodepoint(value as bigint) instanceof ThrowableValue);
});

test("checked native arithmetic agrees with exact BigInt at both int32 boundaries", () => {
	const operands = [
		-2147483648, -2147483647, -1073741824, -46341, -46340, -2, -1, 0, 1, 2,
		46340, 46341, 1073741824, 2147483646, 2147483647,
	];
	for (const a of operands)
		for (const b of operands)
			for (const op of ["+", "-", "*"] as const) {
				const left = BigInt(a),
					right = BigInt(b);
				const exact =
					op === "+"
						? left + right
						: op === "-"
							? left - right
							: left * right;
				const result = checkedInt32(op, left, right);
				if (exact < -2147483648n || exact > 2147483647n)
					assert.ok(
						result instanceof ThrowableValue,
						`${a} ${op} ${b}`,
					);
				else assert.equal(result, exact, `${a} ${op} ${b}`);
			}
});

test("real Noma stdlib fixture covers public APIs, immutability, recovery and I/O", async () => {
	const host = new MemoryIO();
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL("../../test/fixtures/stdlib.noma", import.meta.url),
			),
			host,
		),
		0n,
	);
	assert.equal(host.stdout, "😀 5");
});

test("documented stdlib example loads string, number and io together", async () => {
	const host = new MemoryIO();
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL("../../examples/stdlib.noma", import.meta.url),
			),
			host,
		),
		0n,
	);
	assert.equal(host.stdout, "😀 3 30");
});

test("real Noma native fixture formats all integer widths and preserves uint64 array values", async () => {
	const host = new MemoryIO();
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL(
					"../../test/fixtures/numeric-native.noma",
					import.meta.url,
				),
			),
			host,
		),
		0n,
	);
	assert.equal(
		host.stdout,
		"-128\n-32768\n-2147483648\n-9223372036854775808\n255\n65535\n4294967295\n18446744073709551615\n",
	);
});

test("public APIs have Noma bodies and typed contracts without TSAny", async () => {
	const program = await compile(
		fileURLToPath(
			new URL("../../test/fixtures/stdlib.noma", import.meta.url),
		),
	);
	const expected: Record<string, string[]> = {
		"std/string": [
			"length",
			"isEmpty",
			"contains",
			"startsWith",
			"endsWith",
			"indexOf",
			"slice",
			"replace",
			"replaceAll",
			"trim",
			"toUpperCase",
			"toLowerCase",
			"repeat",
		],
		"std/number": [
			"toString",
			"absInt32",
			"minInt32",
			"maxInt32",
			"clampInt32",
			"int32ToString",
			"parseInt32",
			"checkedAddInt32",
			"checkedSubInt32",
			"checkedMulInt32",
		],
	};
	for (const [id, names] of Object.entries(expected)) {
		const module = program.program.modules.find(
			(value) => value.id === id,
		)!;
		const functions = [...program.functions.get(module)!.values()].filter(
			(fn) => fn.declaration.public,
		);
		assert.deepEqual(
			functions.map((fn) => fn.declaration.name).sort(),
			names.sort(),
		);
		for (const fn of functions) {
			assert.ok(fn.declaration.body);
			assert.equal(fn.declaration.native, false);
			assert.ok(
				!containsTSAny(fn.result) &&
					fn.params.every((type) => !containsTSAny(type)),
			);
			assert.ok(
				fn.declaration.params.every((parameter) => !parameter.mutable),
			);
		}
	}
});

test("core natives link through existing ABI and reject malformed inputs", async (t) => {
	const program = await check(
		t,
		'use "std/string" as str; use "std/number" as num; fn main() -> void {}',
	);
	const registry = new NativeRegistry();
	registerCoreNatives(registry);
	registry.link(program);
	for (const module of program.program.modules) {
		for (const fn of program.functions.get(module)!.values()) {
			if (!fn.declaration.native) continue;
			const args = fn.params.map(() => "wrong");
			if (fn.declaration.name === "codepointLength")
				args[0] = 42 as unknown as string;
			await assert.rejects(
				registry.call(fn, args),
				/Native input contract violation/,
			);
		}
	}
	const internal = program.program.modules.find(
		(module) => module.id === "std/internal/string",
	)!;
	const at = program.functions.get(internal)!.get("codepointAt")!;
	assert.ok((await registry.call(at, ["x", 1n])) instanceof ThrowableValue);
	const from = program.functions.get(internal)!.get("fromCodepoint")!;
	assert.ok((await registry.call(from, [0xd800n])) instanceof ThrowableValue);
	assert.equal(await registry.call(from, [0x1f600n]), "😀");
	await assert.rejects(
		registry.call(from, [0x1f600]),
		/Native input contract violation/,
	);
	await assert.rejects(
		registry.call(from, [18446744073709551615n]),
		/Native input contract violation/,
	);
	assert.throws(
		() => new Interpreter(program, new NativeRegistry()),
		/Unregistered native/,
	);
});

test("malformed scalar strings fail explicitly rather than exposing UTF-16 indexes", async (t) => {
	for (const expression of [
		'str.slice("A\\ud800", 0, 1)',
		'str.repeat("\\udfff", 2)',
	])
		assert.equal(
			await run(
				t,
				`use "std/string" as str; fn main() -> int32 { ${expression} catch e { return 7; }; return 0; }`,
			),
			7n,
		);
	await assert.rejects(
		run(
			t,
			'use "std/string" as str; fn main() -> int32 { return str.length("\\ud800"); }',
		),
		/Invalid Unicode scalar string/,
	);
});

test("mutable stdlib arguments still require snapshot, including primitive numbers", async (t) => {
	for (const source of [
		'use "std/string" as str; fn main() -> int32 { let mut text: string = "Hello"; return str.length(text); }',
		'use "std/string" as str; fn main() -> void { let mut index: int32 = 0; str.slice("a", index, 1); }',
		'use "std/number" as num; fn main() -> void { let mut value: int32 = 1; num.checkedAddInt32(value, 2); }',
	])
		await assert.rejects(
			check(t, source),
			/Readonly parameter .* requires snapshot/,
		);
	assert.equal(
		await run(
			t,
			'use "std/number" as num; fn main() -> int32 { let mut value: int32 = 1; return num.checkedAddInt32(snapshot value, 2) otherwise e { 0 }; }',
		),
		3n,
	);
});

test("stdlib helpers and low-level native modules remain inaccessible to applications", async (t) => {
	for (const source of [
		'use "std/internal/string" as unicode; fn main() -> void {}',
		'use "std/internal/number" as arithmetic; fn main() -> void {}',
	])
		await assert.rejects(check(t, source), /trusted native boundary/);
	await assert.rejects(
		check(
			t,
			'use "std/string" as str; fn main() -> void { str.point("x", 0); }',
		),
		/Unknown or private function/,
	);
});

test("strict decimal parsing accepts signs/zeros and rejects nondecimal or spaced text", async (t) => {
	for (const [text, expected] of [
		["0", 0n],
		["+0", 0n],
		["-0", 0n],
		["00000000000000000000000000000000000000000001", 1n],
		["-42", -42n],
		["2147483647", 2147483647n],
		["-2147483648", -2147483648n],
	] as const)
		assert.equal(
			await run(
				t,
				`use "std/number" as num; fn main() -> int32 { return num.parseInt32(${JSON.stringify(text)}) otherwise e { 99 }; }`,
			),
			expected,
		);
	for (const text of [
		"-",
		"++1",
		"+-1",
		"--1",
		"0x10",
		"1e2",
		"1_000",
		"1\n",
		"\t1",
		"1\u00a0",
		"١",
		"😀",
		"999999999999999999999999999999999999",
		"-99999999999999999999999999",
	])
		assert.equal(
			await run(
				t,
				`use "std/number" as num; fn main() -> int32 { num.parseInt32(${JSON.stringify(text)}) catch e { return 7; }; return 0; }`,
			),
			7n,
			text,
		);
});

test("checked failures can be raised and recovered through Noma functions", async (t) => {
	assert.equal(
		await run(
			t,
			`use "std/number" as num;
	fn add(a: int32, b: int32) -> int32 | throwable { return num.checkedAddInt32(a, b) catch e { raise e; }; }
	fn main() -> int32 { add(-2147483648, -1) catch e { if e.message == "int32 arithmetic overflow" { return 7; } return 8; }; return 0; }`,
		),
		7n,
	);
});

test("overflowing literal arithmetic is a compile error before any execution", async (t) => {
	for (const expression of [
		"2147483647 + 1",
		"-2147483648 - 1",
		"46341 * 46341",
		"-2147483648 / -1",
		"-(-2147483648)",
		"(2147483647 + 1) - 1",
		"(snapshot 2147483647) + 1",
	])
		await assert.rejects(
			check(t, `fn main() -> int32 { return ${expression}; }`),
			/int32 arithmetic overflow in constant expression/,
			expression,
		);
	assert.equal(
		await run(t, "fn main() -> int32 { return -2147483648 / 1; }"),
		-2147483648n,
	);
	assert.equal(
		await run(t, "fn main() -> int32 { return -2147483648 % -1; }"),
		0n,
	);
});

test("ordinary nonconstant arithmetic overflow stops runtime instead of becoming throwable", async (t) => {
	for (const [a, b, expression] of [
		[2147483647, 1, "a + b"],
		[-2147483648, -1, "a + b"],
		[-2147483648, 1, "a - b"],
		[2147483647, -1, "a - b"],
		[46341, 46341, "a * b"],
		[-2147483648, -1, "a * b"],
		[-2147483648, -1, "a / b"],
		[-2147483648, 0, "-a"],
	] as const) {
		const program = await check(
			t,
			`fn main() -> int32 { let a: int32 = ${a}; let b: int32 = ${b}; return ${expression}; }`,
		);
		await assert.rejects(
			new Interpreter(program, createIORegistry(new MemoryIO())).run(),
			/int32 arithmetic overflow/,
			expression,
		);
	}
});
