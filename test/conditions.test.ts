import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "../src/parser.js";
import { runFile } from "../src/index.js";
import { check, MemoryIO, run } from "./helpers.js";

test("real Noma conditions fixture: grouped/ungrouped, comparisons, logic, nested branches and struct literals", async () => {
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL("../../test/fixtures/conditions.noma", import.meta.url),
			),
			new MemoryIO(),
		),
		4,
	);
});
test("parenthesized struct equality remains syntactically valid without extending equality semantics", () => {
	parse(
		'type User = struct { name: string; age: int32; }; fn f(user: User)->void { if (user == User { name: "Alice", age: 20 }) {} }',
	);
});
test("a local boolean shadowing a type name is a condition, not a struct constructor", async (t) => {
	assert.equal(
		await run(
			t,
			"type Flag = bool; pub fn main()->int32 { let Flag: bool = true; if Flag { return 1; } return 0; }",
		),
		1,
	);
});
for (const keyword of ["if", "while"]) {
	for (const literal of [
		"Box<bool> { value: true }",
		"struct { value: true }",
	]) {
		test(`${keyword}: ambiguous ${literal} suggests parentheses`, () => {
			assert.throws(
				() =>
					parse(
						`type Box<T> = struct { value:T; }; fn f()->void { ${keyword} ${literal}.value {} }`,
					),
				/parentheses/,
			);
		});
	}
	test(`${keyword}: ambiguous ungrouped struct literal suggests parentheses`, () => {
		assert.throws(
			() =>
				parse(
					`type User = struct { age:int32; }; fn f(user:User)->void { ${keyword} user == User { age: 20 } {} }`,
				),
			/parentheses/,
		);
	});
	test(`${keyword}: rejects non-bool conditions`, async (t) => {
		await assert.rejects(
			check(t, `pub fn main()->int32 { ${keyword} 1 {} return 0; }`),
			/Expected bool/,
		);
	});
	test(`${keyword}: braces remain mandatory`, () => {
		assert.throws(
			() => parse(`fn f()->void { ${keyword} (true) return; }`),
			/Expected '\{'/,
		);
	});
}
