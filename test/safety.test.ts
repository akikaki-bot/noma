import assert from "node:assert/strict";
import test from "node:test";
import { Interpreter } from "../src/interpreter.js";
import { createIORegistry } from "../src/native.js";
import { check, MemoryIO, run } from "./helpers.js";

test("potentially overlapping structural alternatives are conservatively rejected", async (t) => {
	await assert.rejects(
		check(
			t,
			`
		type A = struct { x: int32; };
		type B = struct { y: string; };
		fn f(value: A | B) -> int32 {
			return match (value) { case (a: A) { 1 } case (b: B) { 2 } };
		}
		fn main() -> void {}
	`,
		),
		/Overlapping structural alternatives/,
	);
});
test("empty arrays make distinct array types overlap", async (t) => {
	await assert.rejects(
		check(
			t,
			`
		fn f(value: string[] | int32[]) -> void {
			match (value) { case (a: string[]) { void } case (b: int32[]) { void } };
		} fn main() -> void {}
	`,
		),
		/Overlapping structural alternatives/,
	);
});
test("disjoint structural alternatives and a shared wildcard arm are accepted", async (t) => {
	assert.equal(
		await run(
			t,
			`
		type A = struct { x: int32; };
		type B = struct { x: string; };
		fn f(value: A | B) -> int32 {
			return match (value) { case (a: A) { a.x + 1 } case (b: B) { 0 } };
		} fn main() -> int32 { return f(struct { x: 9 }); }
	`,
		),
		10,
	);
	assert.equal(
		await run(
			t,
			`
		fn f(value: struct { x: int32; } | struct { y: string; }) -> int32 {
			return match (value) { case _ { 4 } };
		} fn main() -> int32 { return f(struct { x: 9 }); }
	`,
		),
		4,
	);
});
test("union mutation cannot break correlations between fields", async (t) => {
	await assert.rejects(
		check(
			t,
			`
		type A = struct { x: int32; y: string; };
		type B = struct { x: string; y: int32; };
		fn main() -> void {
			let mut value: A | B = struct { x: "a", y: 1 };
			value.x = 2;
		}
	`,
		),
		/Writes through union members/,
	);
});
test("expected array types reach branch and function tails without inferring a declaration", async (t) => {
	assert.equal(
		await run(
			t,
			`
		fn empty() -> int32[] { [] }
		fn main() -> int32 {
			let a: int32[] = if true { [] } else { empty() };
			let b: int32[] = match (true) { case (flag: bool) { [] } };
			return a.length + b.length;
		}
	`,
		),
		0,
	);
});
test("native validates TSAny input at the typed registry boundary", async (t) => {
	const checked = await check(t, 'use "std/io" as io; fn main() -> void {}');
	const module = checked.program.modules.find(
		(module) => module.id === "std/internal/io",
	)!;
	const fn = checked.functions.get(module)!.get("writeStdout")!;
	const host = new MemoryIO(),
		registry = createIORegistry(host);
	registry.link(checked);
	await assert.rejects(
		registry.call(fn, [42]),
		/Native input contract violation/,
	);
	assert.equal(host.stdout, "");
});
test("step limits stop nonterminating language loops", async (t) => {
	const checked = await check(t, "fn main() -> void { while true {} }");
	const interpreter = new Interpreter(
		checked,
		createIORegistry(new MemoryIO()),
		{ maxSteps: 100 },
	);
	await assert.rejects(interpreter.run(), /Execution step limit/);
});
