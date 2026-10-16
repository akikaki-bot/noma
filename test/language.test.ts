import assert from "node:assert/strict";
import test from "node:test";
import { lex, parse } from "../src/index.js";
import { check, MemoryIO, run } from "./helpers.js";

test("lexer preserves source positions, escaped Unicode and nested comments", () => {
	const tokens = lex(
		'/* outer /* inner */ */\n"こんにちは\\n🌱" // end',
		"sample.noma",
	);
	assert.equal(tokens[0]!.text, "こんにちは\n🌱");
	assert.deepEqual(tokens[0]!.span, {
		file: "sample.noma",
		line: 2,
		column: 1,
	});
	assert.throws(() => lex("/* missing"), /Unterminated comment/);
	assert.throws(() => lex('"\\q"'), /Invalid string escape/);
	assert.throws(() => lex('"missing'), /Unterminated string/);
});
test("explicit annotations and import aliases are mandatory", () => {
	assert.throws(
		() => parse("fn main() -> void { let x = 1; }"),
		/Expected ':'/,
	);
	assert.throws(() => parse("fn f(x) -> void {}"), /Expected ':'/);
	assert.throws(() => parse('use "std/io";'), /Expected 'as'/);
	assert.throws(() => parse('use "std/io" as;'), /Expected identifier/);
});
test("arithmetic, functions, loop, ordinary break and explicit mut", async (t) => {
	const value = await run(
		t,
		`
		fn increment(mut x: int32) -> void { x = x + 1; }
		fn main() -> int32 {
			let mut x: int32 = 0;
			while x < 10 { increment(x); if x == 4 { break; } }
			return x * 3 + 8 / 3;
		}`,
	);
	assert.equal(value, 14);
});
test("structural equality of types, union order and explicit projection", async (t) => {
	assert.equal(
		await run(
			t,
			`
		type A = struct { x: int32; };
		type B = struct { x: int32; y: string; };
		type C = struct { x: int32; };
		fn get(a: C) -> int32 { return snapshot a.x; }
		fn main() -> int32 {
			let b: B = struct { x: 42, y: "extra" };
			let a: A = (A)b;
			let u: bool | int32 | int32 = get(a);
			let v: int32 | bool = u;
			return match (v) { case (n: int32) { n } case (b: bool) { 0 } };
		}`,
		),
		42,
	);
});
test("snapshot isolates nested structs and arrays; mutation reaches caller fields", async (t) => {
	assert.equal(
		await run(
			t,
			`
		type User = struct { name: string; scores: int32[]; };
		fn increment(mut x: int32) -> void { x = x + 1; }
		fn main() -> int32 {
			let mut user: User = struct { name: "Alice", scores: [10, 20] };
			let saved: User = snapshot user;
			let element: int32 = snapshot user.scores[0];
			let all: int32 = (snapshot user.scores)[0];
			increment(user.scores[0]); user.name = "Bob";
			if saved.name == "Alice" && saved.scores[0] == 10 && element == 10 && all == 10 && user.scores[0] == 11 { return 0; }
			return 1;
		}`,
		),
		0,
	);
});
test("a new mutable binding and assignment copy aggregates independently", async (t) => {
	assert.equal(
		await run(
			t,
			`
		type Box = struct { values: int32[]; };
		fn main() -> int32 {
			let original: Box = struct { values: [1] };
			let mut a: Box = original;
			let mut b: Box = snapshot a;
			b.values[0] = 2;
			a = b; b.values[0] = 3;
			return original.values[0] + a.values[0] + b.values[0];
		}`,
		),
		6,
	);
});
test("readonly arguments receive a snapshot of mutable input", async (t) => {
	assert.equal(
		await run(
			t,
			`
		fn read(x: int32) -> int32 { return x + 1; }
		fn main() -> int32 { let mut x: int32 = 2; return read(snapshot x); }
	`,
		),
		3,
	);
});
test("match narrows both binding and original identifier; also works as a statement", async (t) => {
	assert.equal(
		await run(
			t,
			`
		fn classify(value: string | int32) -> int32 {
			match (value) {
				case (v: string) { let text: string = value; }
				case (v: int32) { return value + 1; }
			};
			return 0;
		}
		fn main() -> int32 { return classify(9); }
	`,
		),
		10,
	);
});
test("module access requires alias and pub for functions and types", async (t) => {
	const io = new MemoryIO();
	assert.equal(
		await run(
			t,
			`
		use "./helper" as helper;
		fn main() -> int32 { let value: helper.Number = helper.answer(); return value; }
	`,
			io,
			{
				"helper.noma":
					"pub type Number = int32; pub fn answer() -> Number { return 42; }",
			},
		),
		42,
	);
});

const rejected: [string, string, RegExp][] = [
	[
		"initializer type",
		"fn main() -> void { let x: string = 1; }",
		/Expected string, got int32/,
	],
	[
		"immutable scalar",
		"fn main() -> void { let x: int32 = 1; x = 2; }",
		/mutable storage/,
	],
	[
		"deep readonly array",
		"fn main() -> void { let a: int32[] = [1]; a[0] = 2; }",
		/deep readonly/,
	],
	[
		"deep readonly struct",
		"fn main() -> void { let a: struct { x: int32[]; } = struct { x: [1] }; a.x[0] = 2; }",
		/deep readonly/,
	],
	[
		"mutable retention",
		"fn main() -> void { let mut x: int32 = 1; let y: int32 = x; }",
		/requires snapshot/,
	],
	[
		"nested mutable retention",
		"fn main() -> void { let mut x: int32[] = [1]; let y: int32 = x[0]; }",
		/requires snapshot/,
	],
	[
		"aggregate hides borrowing",
		"fn main() -> void { let mut x: int32[] = [1]; let y: struct { a: int32[]; } = struct { a: x }; }",
		/requires snapshot/,
	],
	[
		"mutable input to readonly parameter",
		"fn f(x: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(x); }",
		/requires snapshot/,
	],
	[
		"unexpected mut call",
		"fn f(x: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(mut x); }",
		/Expected identifier/,
	],
	[
		"mut immutable argument",
		"fn f(mut x: int32) -> void {} fn main() -> void { let x: int32 = 1; f(x); }",
		/mutable storage/,
	],
	[
		"mutable reference covariance",
		"type A = struct { x: int32; }; type B = struct { x: int32; y: int32; }; fn f(mut a: A) -> void {} fn main() -> void { let mut b: B = struct { x: 1, y: 2 }; f(b); }",
		/invariant/,
	],
	[
		"overlapping mutable arguments",
		"fn f(mut a: int32, mut b: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(x, x); }",
		/Overlapping/,
	],
	[
		"read and mutable alias",
		"fn f(mut a: int32, b: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(x, x); }",
		/requires snapshot/,
	],
	[
		"readonly parameter mutation",
		"fn f(x: int32[]) -> void { x[0] = 1; } fn main() -> void {}",
		/deep readonly/,
	],
	[
		"borrowed return",
		"fn f(mut x: int32) -> int32 { return x; } fn main() -> void {}",
		/Returning borrowed/,
	],
	[
		"readonly aggregate escape",
		"fn f(x: int32[]) -> int32[] { return x; } fn main() -> void {}",
		/Returning borrowed/,
	],
	[
		"match exhaustiveness",
		"fn f(x: int32 | string) -> void { match (x) { case (n: int32) { void } }; } fn main() -> void {}",
		/Non-exhaustive/,
	],
	[
		"match result compatibility",
		'fn main() -> void { let x: int32 = match (true) { case (b: bool) { "wrong" } }; }',
		/Expected int32, got string/,
	],
	[
		"unreachable arm",
		"fn main() -> void { match (1) { case (n: int32) { void } case (m: int32) { void } }; }",
		/Unreachable/,
	],
	["break outside loop", "fn main() -> void { break; }", /enclosing loop/],
	[
		"missing return path",
		"fn main() -> int32 { if true { return 1; } }",
		/Expected int32/,
	],
	[
		"void differs from never",
		"fn bad() -> never { void } fn main() -> void {}",
		/Expected never, got void/,
	],
	[
		"builtin print absent",
		'fn main() -> void { print("hello"); }',
		/Unknown or private function/,
	],
	[
		"missing global expansion",
		'use "std/io" as io; fn main() -> void { puts("hello"); }',
		/Unknown or private function/,
	],
	[
		"native user declaration",
		"native fn bad(x: string) -> void; fn main() -> void {}",
		/trusted/,
	],
	[
		"compilerOnly forgery",
		"compilerOnly type TSAny = intrinsic; fn main() -> void {}",
		/reserved/,
	],
	[
		"unknown TSAny",
		"fn main() -> void { let x: TSAny = 1; }",
		/Unknown type/,
	],
	[
		"internal import",
		'use "std/internal/io" as raw; fn main() -> void {}',
		/trusted native boundary/,
	],
	[
		"module traversal",
		'use "../secret" as raw; fn main() -> void {}',
		/without parent traversal/,
	],
	[
		"duplicate declarations",
		"fn main() -> void {} fn main() -> void {}",
		/Duplicate declaration/,
	],
	[
		"duplicate fields",
		"fn main() -> void { let x: struct { a: int32; } = struct { a: 1, a: 2 }; }",
		/Duplicate field/,
	],
	[
		"builtin redeclaration",
		"type int32 = string; fn main() -> void {}",
		/cannot be redeclared/,
	],
	[
		"recursive aliases pending",
		"type A = A; fn main() -> void {}",
		/Recursive/,
	],
	[
		"array length readonly",
		"fn main() -> void { let mut a: int32[] = [1]; a.length = 2; }",
		/length is readonly/,
	],
	[
		"number overflow literal",
		"fn main() -> int32 { return 2147483648; }",
		/int32 range/,
	],
];
for (const [name, source, error] of rejected)
	test(`reject: ${name}`, async (t) => {
		await assert.rejects(check(t, source), error);
	});
test("private function and type remain inaccessible", async (t) => {
	await assert.rejects(
		check(
			t,
			'use "helper" as h; fn main() -> int32 { return h.secret(); }',
			{ "helper.noma": "fn secret() -> int32 { return 1; }" },
		),
		/private function/,
	);
	await assert.rejects(
		check(
			t,
			'use "helper" as h; fn main() -> void { let x: h.Secret = 1; }',
			{ "helper.noma": "type Secret = int32;" },
		),
		/private type/,
	);
});
test("cyclic modules report a diagnostic", async (t) => {
	await assert.rejects(
		check(t, 'use "helper" as h; fn main() -> void {}', {
			"helper.noma": 'use "./main" as m;',
		}),
		/Cyclic imports/,
	);
});
test("int32 arithmetic range and index errors have source locations", async (t) => {
	assert.equal(
		await run(t, "fn main() -> int32 { return -2147483648; }"),
		-2147483648,
	);
	await assert.rejects(
		run(t, "fn main() -> int32 { return 2147483647 + 1; }"),
		/main.noma:1:\d+: int32 arithmetic overflow/,
	);
	await assert.rejects(
		run(t, "fn main() -> int32 { return 1 / 0; }"),
		/Division by zero/,
	);
	await assert.rejects(
		run(t, "fn main() -> int32 { let a: int32[] = []; return a[0]; }"),
		/out of bounds/,
	);
});
test("boolean operators short circuit", async (t) => {
	assert.equal(
		await run(
			t,
			"fn main() -> int32 { if false && 1 / 0 == 0 { return 1; } if true || 1 / 0 == 0 { return 0; } return 2; }",
		),
		0,
	);
});
test("snapshot binds to the selected element unless the snapshot is parenthesized", () => {
	const ast = parse(
		"fn main() -> void { snapshot array[0]; (snapshot array)[0]; }",
	);
	const fn = ast.declarations[0]!;
	assert.equal(fn.kind, "function");
	if (fn.kind !== "function") return;
	const first = fn.body!.statements[0]!,
		second = fn.body!.statements[1]!;
	assert.equal(first.kind, "expression");
	assert.equal(second.kind, "expression");
	if (first.kind !== "expression" || second.kind !== "expression") return;
	assert.equal(first.expression.kind, "snapshot");
	assert.equal(second.expression.kind, "index");
	if (first.expression.kind === "snapshot")
		assert.equal(first.expression.value.kind, "index");
	if (second.expression.kind === "index")
		assert.equal(second.expression.object.kind, "snapshot");
});
