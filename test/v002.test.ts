import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.js";
import type { Statement } from "../src/ast.js";
import { project, snapshot, ThrowableValue } from "../src/values.js";
import { INT32 } from "../src/types.js";
import { check, MemoryIO, run } from "./helpers.js";

const animals = `
type Animal = struct { name: string; };
type Dog = struct { name: string; breed: string; };
`;
const typing = 'use "std/typing" as typing;';
const fail = 'fn fail() -> int32 | throwable { raise "failure"; }';

test("v0.0.2 parser distinguishes raise, catch, otherwise and compile-time types", () => {
	const ast = parse(`${typing} ${fail}
	fn main() -> int32 {
		let a: int32 = fail() catch e { return -1; };
		let b: int32 = fail() otherwise e { 0 };
		let c: int32 = typing.trycast(int32, a) otherwise e { 0 };
		return b + c;
	}`);
	const f = ast.declarations[1]!;
	assert.equal(f.kind, "function");
	if (f.kind !== "function") return;
	const statement = f.body!.statements[0]!;
	assert.equal(statement.kind, "expression");
	if (statement.kind === "expression")
		assert.equal(statement.expression.kind, "raise");
	const main = ast.declarations[2]!;
	if (main.kind !== "function") return;
	for (const [index, mode] of ["catch", "otherwise"].entries()) {
		const binding: Statement = main.body!.statements[index]!;
		assert.equal(binding.kind, "let");
		if (binding.kind === "let" && binding.value.kind === "handle")
			assert.equal(binding.value.mode, mode);
		else assert.fail("Expected handler AST");
	}
});

test("raise has never type and becomes a branded error result", async (t) => {
	const checked = await check(
		t,
		`${fail} fn main() -> int32 { return fail() catch e { return 7; }; }`,
	);
	const fn = checked.program.entry.ast.declarations[0]!;
	if (fn.kind !== "function") return assert.fail("Expected function");
	const statement = fn.body!.statements[0]!;
	if (statement.kind !== "expression")
		return assert.fail("Expected expression");
	assert.equal(
		checked.expressionTypes.get(statement.expression)!.kind,
		"never",
	);
	assert.equal(
		await run(
			t,
			`${fail} fn main() -> int32 { return fail() catch e { if e.message == "failure" { return 7; } return 8; }; }`,
		),
		7n,
	);
});

test("raise unwinds only its function, can re-raise errors, and supports otherwise values", async (t) => {
	assert.equal(
		await run(
			t,
			`${fail}
	fn relay() -> int32 | throwable { return fail() catch e { raise e; }; }
	fn main() -> int32 { return relay() otherwise e { if e.message == "failure" { 11 } else { 12 } }; }`,
		),
		11n,
	);
});

test("catch skips its handler on success; otherwise may return from the enclosing function", async (t) => {
	assert.equal(
		await run(
			t,
			`${fail}
	fn good() -> int32 | throwable { return 8; }
	fn main() -> int32 {
		let x: int32 = good() catch e { return 9; };
		return fail() otherwise e { return x; };
	}`,
		),
		8n,
	);
});

test("void | throwable interoperates with raise and std/io", async (t) => {
	const host = new MemoryIO();
	assert.equal(
		await run(
			t,
			`use "std/io" as io;
	fn bad() -> void | throwable { raise "bad"; }
	fn main() -> int32 {
		bad() catch e { io.puts(e.message) catch err { return 2; }; return 4; };
		return 1;
	}`,
			host,
		),
		4n,
	);
	assert.equal(host.stdout, "bad\n");
});

test("mutability comes only from the signature, including forwarding and unused authority", async (t) => {
	assert.equal(
		await run(
			t,
			`
	fn inc(value: int32) -> int32 { return value + 1; }
	fn noop(mut value: int32) -> void {}
	fn change(mut value: int32) -> void { value++; }
	fn forward(mut value: int32) -> void { noop(value); change(value); }
	fn main() -> int32 {
		let a: int32 = 10; let mut b: int32 = 20;
		forward(b);
		return inc(a) + inc(snapshot b);
	}`,
		),
		33n,
	);
});

test("readonly aggregate parameters may forward readonly inputs but cannot mutate them", async (t) => {
	assert.equal(
		await run(
			t,
			`
	fn inspect(a: Array<int32>) -> int32 { return a[0] + 0; }
	fn forward(a: Array<int32>) -> int32 { return inspect(a); }
	fn main() -> int32 { let mut a: Array<int32> = [12]; return forward(snapshot a); }
	`,
		),
		12n,
	);
});

test("snapshots isolate nested arrays and structs through subsequent calls and assignments", async (t) => {
	assert.equal(
		await run(
			t,
			`
	type Inner = struct { n: int32; };
	type Outer = struct { items: Array<Inner>; };
	fn change(mut value: Outer) -> void { value.items[0].n = 99; }
	fn main() -> int32 {
		let mut original: Outer = Outer { items: [Inner { n: 10 }] };
		let copied: Outer = snapshot original;
		let element: Inner = snapshot original.items[0];
		let all: Inner = (snapshot original.items)[0];
		change(original);
		return copied.items[0].n + element.n + all.n;
	}`,
		),
		30n,
	);
});

test("explicit casts project nested fields, preserve structural equality and copy independently", async (t) => {
	assert.equal(
		await run(
			t,
			`${animals}
	type SameAnimal = struct { name: string; };
	type Source = struct { pet: Dog; history: Dog[]; extra: bool; };
	type Target = struct { pet: Animal; history: Animal[]; };
	fn main() -> int32 {
		let mut dog: Dog = Dog { name: "Pochi", breed: "Shiba" };
		let animal: Animal = (Animal)(snapshot dog);
		let same: SameAnimal = animal;
		let source: Source = Source { pet: snapshot dog, history: [snapshot dog], extra: true };
		let target: Target = (Target)source;
		let mut independent: Target = target;
		independent.pet.name = "Other";
		dog.name = "New";
		if animal.name == "Pochi" && same.name == "Pochi" && target.pet.name == "Pochi" && target.history[0].name == "Pochi" { return 0; }
		return 1;
	}`,
		),
		0n,
	);
});

test("static casts handle arrays, primitive identity and provable union projections", async (t) => {
	assert.equal(
		await run(
			t,
			`use "std/arr" as arr; ${animals}
	fn main() -> int32 {
		let dog: Dog = Dog { name: "P", breed: "S" };
		let dogs: Array<Dog> = [dog];
		let a: Array<Animal> = (Animal[])dogs;
		let u: Dog | Animal = dog;
		let one: Animal = (Animal)u;
		let empty: Animal[] = (Animal[])[];
		return (int32)1 + arr.length<Animal>(a) + arr.length<Animal>(empty);
	}`,
		),
		2n,
	);
});

test("trycast checks runtime types and projects only target fields without coercion", async (t) => {
	assert.equal(
		await run(
			t,
			`${typing} ${animals}
	fn main() -> int32 {
		let mut dog: Dog = Dog { name: "Pochi", breed: "Shiba" };
		let animal: Animal = typing.trycast(Animal, snapshot dog) catch e { return 1; };
		dog.name = "Changed";
		let cannotRecover: Dog = typing.trycast(Dog, animal) otherwise e { Dog { name: "fallback", breed: "none" } };
		let number: int32 = typing.trycast(int32, "123") otherwise e { 7 };
		if animal.name == "Pochi" && cannotRecover.name == "fallback" { return number; }
		return 2;
	}`,
		),
		7n,
	);
});

test("trycast supports runtime union narrowing, arrays, anonymous structures and imported types", async (t) => {
	assert.equal(
		await run(
			t,
			`${typing} use "helper" as h;
	fn main() -> int32 {
		let value: int32 | string = 13;
		let n: int32 = typing.trycast(int32, value) catch e { return 1; };
		let input: Array<int32> = [n];
		let a: Array<int32> = typing.trycast(Array<int32>, input) catch e { return 2; };
		let b: h.Box = typing.trycast(h.Box, struct { n: a[0], extra: true }) catch e { return 3; };
		let c: struct { n: int32; } = typing.trycast(struct { n: int32; }, b) catch e { return 4; };
		return c.n;
	}`,
			new MemoryIO(),
			{ "helper.noma": "pub type Box = struct { n: int32; };" },
		),
		13n,
	);
});

test("trycast failure is a catchable throwable and std/io loads alongside std/typing", async (t) => {
	const host = new MemoryIO();
	assert.equal(
		await run(
			t,
			`${typing} use "std/io" as io;
	fn main() -> int32 {
		let input: Array<string> = ["bad"];
		typing.trycast(int32[], input) catch e {
			io.puts(e.message) catch err { return 1; };
			return 6;
		}; return 2;
	}`,
			host,
		),
		6n,
	);
	assert.match(host.stdout, /trycast:/);
});

test("runtime projection and snapshot freeze deeply and cannot leak discarded fields", () => {
	const source = { n: [10n], extra: "hidden" };
	const target = {
		kind: "struct" as const,
		fields: new Map([["n", { kind: "array" as const, element: INT32 }]]),
	};
	const result = project(source, target) as Record<string, unknown>;
	const saved = snapshot(source) as Record<string, unknown>;
	source.n[0] = 99n;
	assert.deepEqual(Object.keys(result), ["n"]);
	assert.deepEqual(result.n, [10n]);
	assert.deepEqual(saved.n, [10n]);
	assert.ok(Object.isFrozen(result) && Object.isFrozen(result.n));
	assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.n));
	assert.throws(() => project("123", INT32), /does not conform/);
	assert.ok(Object.isFrozen(new ThrowableValue("error")));
});

test("Union projections choose the most specific target independently of declaration order", async (t) => {
	assert.equal(
		await run(
			t,
			`${typing} ${animals}
	fn main() -> int32 {
		let dog: Dog = Dog { name: "P", breed: "S" };
		let a: Animal | Dog = (Animal | Dog)dog;
		let b: Dog | Animal = typing.trycast(Dog | Animal, dog) catch e { return 1; };
		typing.trycast(Dog, a) catch e { return 2; };
		typing.trycast(Dog, b) catch e { return 3; };
		return 0;
	}`,
		),
		0n,
	);
});
test("trycast conservatively fails on incomparable overlapping Union projections", async (t) => {
	assert.equal(
		await run(
			t,
			`${typing}
	type A = struct { x: int32; }; type B = struct { y: int32; };
	fn main() -> int32 {
		typing.trycast(A | B, struct { x: 1, y: 2 }) catch e { return 7; };
		return 1;
	}`,
		),
		7n,
	);
});
test("grouped values still support indexing and direct function calls", async (t) => {
	assert.equal(
		await run(
			t,
			`fn f(x: int32) -> int32 { return x; }
	fn main() -> int32 { let a: int32[] = [3]; return (f)((a)[0]); }`,
		),
		3n,
	);
});
test("explicit struct contexts initialize Union fields without converting existing structures", async (t) => {
	assert.equal(
		await run(
			t,
			`type Box = struct { n: int32 | string; };
	fn main() -> int32 {
		let a: Box = Box { n: 12 };
		let b: Box = struct { n: "text" };
		return match(a.n) { case(n: int32) { n } case(s: string) { 0 } };
	}`,
		),
		12n,
	);
});
test("imported names can construct and explicitly project public struct types", async (t) => {
	assert.equal(
		await run(
			t,
			`use "helper" as h;
	fn main() -> int32 {
		let dog: h.Dog = h.Dog { name: "P", breed: "S" };
		let a: h.Animal = (h.Animal)dog;
		if a.name == "P" { return 0; } return 1;
	}`,
			new MemoryIO(),
			{
				"helper.noma": `pub type Animal = struct { name: string; }; pub type Dog = struct { name: string; breed: string; };`,
			},
		),
		0n,
	);
});
test("typing import resolution remains independent of module declaration order", async (t) => {
	assert.equal(
		await run(
			t,
			`fn main() -> int32 { return typing.trycast(int32, 9) otherwise e { 0 }; } use "std/typing" as typing;`,
		),
		9n,
	);
});
test("match still recognizes structural coverage without implicitly projecting values", async (t) => {
	assert.equal(
		await run(
			t,
			`${animals}
	fn f(dog: Dog) -> string { return match(dog) { case(a: Animal) { a.breed + "!" } }; }
	fn main() -> int32 { let dog: Dog = Dog { name: "P", breed: "S" }; if f(dog) == "S!" { return 0; } return 1; }`,
		),
		0n,
	);
});
test("eager aggregates propagate never from raise", async (t) => {
	const checked = await check(
		t,
		`fn f() -> Array<int32> | throwable { [raise "bad"] } fn main() -> void {}`,
	);
	const f = checked.program.entry.ast.declarations[0]!;
	if (f.kind !== "function") return assert.fail("Expected function");
	assert.equal(checked.expressionTypes.get(f.body!.tail!)!.kind, "never");
	assert.equal(
		await run(
			t,
			`fn f() -> int32 | throwable { struct { x: raise "bad" } } fn main() -> int32 { return f() otherwise e { 8 }; }`,
		),
		8n,
	);
});

const rejected: [string, string, RegExp][] = [
	[
		"raise without throwable",
		'fn f() -> int32 { raise "bad"; } fn main() -> void {}',
		/raise requires/,
	],
	[
		"raise inside main",
		'fn main() -> void { raise "bad"; }',
		/raise requires/,
	],
	[
		"raise unsupported payload",
		"fn f() -> int32 | throwable { raise 1; } fn main() -> void {}",
		/Expected string \| throwable/,
	],
	[
		"raise unreachable path",
		`${fail} fn f() -> int32 | throwable { raise "x"; return 1; } fn main() -> void {}`,
		/Unreachable/,
	],
	[
		"old throw statement",
		'fn f() -> int32 | throwable { throw "x"; } fn main() -> void {}',
		/Expected identifier/,
	],
	[
		"old throw handler",
		`${fail} fn main() -> void { fail() throw e { return; }; }`,
		/Expected ';'/,
	],
	[
		"catch normal void",
		`${fail} fn main() -> void { fail() catch e { void }; }`,
		/must have type never/,
	],
	[
		"catch mixed flow",
		`${fail} fn main() -> int32 { return fail() catch e { if true { return 1; } }; }`,
		/must have type never/,
	],
	[
		"otherwise missing value",
		`${fail} fn main() -> int32 { return fail() otherwise e {}; }`,
		/Expected int32, got void/,
	],
	[
		"otherwise wrong value",
		`${fail} fn main() -> int32 { return fail() otherwise e { "bad" }; }`,
		/Expected int32, got string/,
	],
	[
		"readonly mutable argument",
		"fn f(x: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(x); }",
		/requires snapshot/,
	],
	[
		"readonly mutable field",
		"fn f(x: int32) -> void {} fn main() -> void { let mut x: int32[] = [1]; f(x[0]); }",
		/requires snapshot/,
	],
	[
		"readonly mutable aggregate wrapper",
		"fn f(x: struct { n: int32; }) -> void {} fn main() -> void { let mut x: int32 = 1; f(struct { n: x }); }",
		/requires snapshot/,
	],
	[
		"readonly mutable length",
		"fn f(x: int32) -> void {} fn main() -> void { let mut x: int32[] = [1]; f(x.length); }",
		/Arrays have no properties/,
	],
	[
		"mut requires storage",
		"fn f(mut x: int32) -> void {} fn main() -> void { f(1); }",
		/mutable storage/,
	],
	[
		"mut rejects snapshot",
		"fn f(mut x: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(snapshot x); }",
		/mutable storage/,
	],
	[
		"mut cannot change static type",
		'fn f(mut x: int32) -> void { x = "bad"; } fn main() -> void {}',
		/Expected int32/,
	],
	[
		"duplicate mut borrow",
		"fn f(mut a: int32, mut b: int32) -> void {} fn main() -> void { let mut x: int32 = 1; f(x, x); }",
		/Overlapping/,
	],
	[
		"same array different elements",
		"fn f(mut a: int32, mut b: int32) -> void {} fn main() -> void { let mut x: int32[] = [1, 2]; f(x[0], x[1]); }",
		/Overlapping/,
	],
	[
		"nested mut call while borrowed",
		"fn f(mut a: int32, b: int32) -> void {} fn g(mut a: int32) -> int32 { a++; return 0; } fn main() -> void { let mut x: int32 = 1; f(x, g(x)); }",
		/both mutate and read/,
	],
	[
		"mut borrow address effects",
		"fn f(mut a: int32) -> void {} fn g(mut a: int32[]) -> int32 { a[0] = 2; return 0; } fn main() -> void { let mut x: int32[] = [1]; f(x[g(x)]); }",
		/address cannot access borrowed storage/,
	],
	[
		"snapshot array deep readonly",
		"fn main() -> void { let mut x: int32[][] = [[1]]; let saved: int32[][] = snapshot x; saved[0][0] = 2; }",
		/deep readonly/,
	],
	[
		"readonly nested parameter",
		"fn f(x: struct { n: int32[]; }) -> void { x.n[0] = 2; } fn main() -> void {}",
		/deep readonly/,
	],
	[
		"implicit width binding",
		`${animals} fn main() -> void { let dog: Dog = Dog { name: "P", breed: "S" }; let animal: Animal = dog; }`,
		/Expected struct/,
	],
	[
		"implicit width return",
		`${animals} fn f(dog: Dog) -> Animal { return snapshot dog; } fn main() -> void {}`,
		/Expected struct/,
	],
	[
		"implicit width argument",
		`${animals} fn f(a: Animal) -> void {} fn main() -> void { let dog: Dog = Dog { name: "P", breed: "S" }; f(dog); }`,
		/Expected struct/,
	],
	[
		"implicit nested field union widening",
		"type A = struct { n: int32; }; type B = struct { n: int32 | string; }; fn main() -> void { let a: A = struct { n: 1 }; let b: B = a; }",
		/Expected struct/,
	],
	[
		"implicit array widening",
		"fn main() -> void { let a: int32[] = [1]; let b: (int32 | string)[] = a; }",
		/Expected/,
	],
	[
		"mutable static projection",
		`${animals} fn main() -> void { let mut dog: Dog = Dog { name: "P", breed: "S" }; let animal: Animal = (Animal)dog; }`,
		/requires snapshot/,
	],
	[
		"unsafe static downcast",
		`${animals} fn main() -> void { let a: Animal = Animal { name: "P" }; let d: Dog = (Dog)a; }`,
		/Cannot prove safe/,
	],
	[
		"unsafe static primitive cast",
		'fn main() -> void { let n: int32 = (int32)"123"; }',
		/Cannot prove safe/,
	],
	[
		"unsafe static union cast",
		"fn main() -> void { let u: int32 | string = 1; let n: int32 = (int32)u; }",
		/Cannot prove safe/,
	],
	[
		"trycast mutable input",
		`${typing} fn main() -> void { let mut n: int32 = 1; typing.trycast(int32, n); }`,
		/requires snapshot/,
	],
	[
		"trycast mutable branch result",
		`${typing} fn main() -> void { let mut n: int32 = 1; typing.trycast(int32, if true { n } else { 2 }); }`,
		/requires snapshot/,
	],
	[
		"trycast mutable match alias",
		`${typing} fn main() -> void { let mut n: int32 | string = 1; match(n) { case(x: int32) { typing.trycast(int32, x); } case(s: string) { void } }; }`,
		/requires snapshot/,
	],
	[
		"trycast type variable",
		`${typing} fn main() -> void { let target: int32 = 1; typing.trycast(target, 1); }`,
		/Unknown type/,
	],
	[
		"trycast unknown type",
		`${typing} fn main() -> void { typing.trycast(Unknown, 1); }`,
		/Unknown type/,
	],
	[
		"trycast arity",
		`${typing} fn main() -> void { typing.trycast(int32); }`,
		/requires a compile-time/,
	],
	[
		"Type variable",
		"fn main() -> void { let target: Type = int32; }",
		/compile-time only/,
	],
	[
		"Type function parameter",
		"fn f(target: Type) -> void {} fn main() -> void {}",
		/compile-time only/,
	],
	[
		"Type array",
		"fn main() -> void { let target: Type[] = []; }",
		/compile-time only/,
	],
	[
		"Type union alias",
		"type Bad = int32 | Type; fn main() -> void {}",
		/compile-time only/,
	],
	[
		"Type target",
		`${typing} fn main() -> void { typing.trycast(Type, 1); }`,
		/compile-time only/,
	],
	["Type expression", "fn main() -> void { Type; }", /Unknown variable/],
	[
		"Type result",
		"fn f() -> Type { return 1; } fn main() -> void {}",
		/compile-time only/,
	],
	[
		"Type field",
		"type X = struct { target: Type; }; fn main() -> void {}",
		/compile-time only/,
	],
	[
		"readonly cast result",
		`${animals} fn main() -> void { let dog: Dog = Dog { name: "P", breed: "S" }; let a: Animal = (Animal)dog; a.name = "changed"; }`,
		/deep readonly/,
	],
	[
		"readonly trycast result",
		`${typing} ${animals} fn main() -> void { let dog: Dog = Dog { name: "P", breed: "S" }; let a: Animal = typing.trycast(Animal, dog) catch e { return; }; a.name = "changed"; }`,
		/deep readonly/,
	],
	[
		"named literal wrong fields",
		`${animals} fn main() -> void { let dog: Dog = Dog { name: "P" }; }`,
		/Expected struct/,
	],
	[
		"static cast missing nested field",
		"type A = struct { value: struct { x: int32; }; }; fn main() -> void { let a: A = (A)struct { value: struct { y: 1 } }; }",
		/Cannot prove safe/,
	],
	[
		"TSAny remains private",
		`${typing} fn main() -> void { typing.trycast(TSAny, 1); }`,
		/Unknown type/,
	],
	[
		"compilerOnly Type forgery",
		"compilerOnly type Type = intrinsic; fn main() -> void {}",
		/cannot be redeclared/,
	],
	[
		"intrinsic signature forgery",
		"pub fn trycast(target: Type, value: intrinsic) -> intrinsic; fn main() -> void {}",
		/Only compiler intrinsic/,
	],
	[
		"ambiguous static Union projection",
		"type A = struct { x: int32; }; type B = struct { y: int32; }; fn main() -> void { let v: A | B = (A | B)struct { x: 1, y: 2 }; }",
		/Cannot prove safe/,
	],
];
for (const [name, source, error] of rejected) {
	test(`v0.0.2 reject: ${name}`, async (t) => {
		await assert.rejects(check(t, source), error);
	});
}
