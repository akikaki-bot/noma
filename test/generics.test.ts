import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "../src/parser.js";
import { runFile } from "../src/index.js";
import { check, run, MemoryIO } from "./helpers.js";

test("real Noma generics fixture: explicit calls, nested/union shapes, mut and independent snapshots", async () => {
	const file = fileURLToPath(
		new URL("../../test/fixtures/generics.noma", import.meta.url),
	);
	assert.equal(await runFile(file, new MemoryIO()), 42);
});

test("documented generics example executes with the existing std/io library", async () => {
	const io = new MemoryIO();
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL("../../examples/generics.noma", import.meta.url),
			),
			io,
		),
		0,
	);
	assert.equal(io.stdout, "Generics v0.1\n");
});

test("type parameters have declaration identity, shadow ordinary type aliases and resolve across public imports", async (t) => {
	assert.equal(
		await run(
			t,
			`use "helper" as h;
type T = string;
fn f<T>(v: T) -> T { let copy: T = v; return h.identity<T>(copy); }
pub fn main() -> int32 { let b: h.Box<int32> = h.Box<int32> { value: f<int32>(7) }; return b.value; }`,
			new MemoryIO(),
			{
				"helper.noma":
					"pub type Box<T> = struct { value: T; }; pub fn identity<T>(value: T) -> T { return value; }",
			},
		),
		7,
	);
});

test("runtime substitutes generic cast and trycast targets and recursive forwarding frames", async (t) => {
	assert.equal(
		await run(
			t,
			`use "std/typing" as typing;
fn cast<T>(value: T) -> T { return (T)value; }
fn checked<T>(value: int32 | string) -> T | throwable { return typing.trycast(T, value); }
fn recurse<T>(value: T, n: int32) -> T { if n > 0 { return recurse<T>(value, n - 1); } return cast<T>(value); }
pub fn main() -> int32 {
 let failed: string = checked<string>(1) otherwise e { "failed" };
 let value: int32 = checked<int32>(9) catch e { return 1; };
 return recurse<int32>(value, 3);
}`,
		),
		9,
	);
});

test("comparisons keep their meaning beside generic syntax and nested >> tokens", async (t) => {
	parse(
		"type Box<T> = struct { value: T; }; fn f(x: Box<Box<int32>>) -> void {}",
	);
	assert.equal(
		await run(
			t,
			"pub fn main() -> int32 { let a: int32 = 1; let b: int32 = 2; if a < b && b > a { return 3; } return 0; }",
		),
		3,
	);
});

const rejected: [string, string, RegExp][] = [
	[
		"omitted function arguments",
		"fn id<T>(x: T) -> T { return x; } pub fn main() -> int32 { return id(1); }",
		/explicit type arguments/,
	],
	[
		"omitted type use",
		"type Box<T> = struct { value: T; }; fn f(x: Box) -> void {}",
		/explicit type arguments/,
	],
	[
		"omitted construction despite annotation",
		'type Box<T> = struct { value: T; }; fn f() -> void { let b: Box<string> = Box { value: "x" }; }',
		/explicit type arguments/,
	],
	[
		"partial arguments",
		"fn f<T,U>(x:T,y:U)->T{return x;} fn g()->void { f<int32>(1,2); }",
		/explicit type arguments/,
	],
	[
		"extra type arguments",
		"type Box<T> = struct { value:T; }; fn f(x:Box<int32,string>)->void {}",
		/explicit type arguments/,
	],
	[
		"nongeneric arguments",
		"fn f(x:int32)->int32{return x;} fn g()->void { f<int32>(1); }",
		/explicit type arguments/,
	],
	[
		"value as type",
		"fn f<T>(x:T)->T{return x;} fn g()->void { let x:int32=1; f<x>(1); }",
		/Unknown type/,
	],
	[
		"invalid unused definition",
		"fn double<T>(x:T)->T{return x+x;}",
		/Expected int32/,
	],
	[
		"distinct type parameters",
		"fn wrong<T,U>(x:T)->U{return x;}",
		/Expected U, got T/,
	],
	[
		"unsafe abstract cast",
		"fn wrong<T,U>(x:T)->U{return (U)x;}",
		/Cannot prove safe/,
	],
	[
		"wrong structure",
		"type Box<T> = struct { value:T; }; fn f()->void { let a:Box<string>=Box<int32>{value:1}; }",
		/Expected|got/,
	],
	[
		"mutable readonly scalar",
		"fn id<T>(x:T)->T{return x;} fn f()->void { let mut x:int32=1; id<int32>(x); }",
		/snapshot/,
	],
	[
		"mutable readonly aggregate",
		"fn id<T>(x:T)->T{return x;} fn f()->void { let mut x:int32[]=[1]; id<int32[]>(x); }",
		/snapshot/,
	],
	["mutable return", "fn wrong<T>(mut x:T)->T{return x;}", /snapshot/],
	[
		"deep readonly",
		"type Box<T> = struct { value:T; }; fn wrong<T>(x:Box<T>,v:T)->void{x.value=v;}",
		/mutable|Readonly|readonly/,
	],
	[
		"overlapping mutable arguments",
		"fn f<T,U>(mut x:T,mut y:U)->void{} fn g()->void {let mut x:int32=1;f<int32,int32>(x,x);}",
		/Overlapping/,
	],
	[
		"invariant mutable arguments",
		"fn f<T>(mut x:T)->void{} fn g()->void {let mut x:int32=1;f<int32|string>(x);}",
		/invariant/,
	],
	[
		"duplicate parameters",
		"type Box<T,T> = struct {value:T;};",
		/Duplicate type parameter/,
	],
	[
		"parameter scope escape",
		"fn f<T>(x:T)->T{return x;} fn g(x:T)->void {}",
		/Unknown type/,
	],
	["recursive type", "type Bad<T> = struct { value:Bad<T>; };", /Recursive/],
	[
		"infinitely growing type",
		"type Bad<T> = struct { value:Bad<Bad<T>>; };",
		/Recursive/,
	],
	[
		"indirect recursive type",
		"type A<T> = B<T>; type B<U> = A<U>;",
		/Recursive/,
	],
	[
		"compiler type argument",
		"fn f<T>(x:T)->T{return x;} fn g()->void { f<Type>(void); }",
		/compile-time only/,
	],
	["generic main", "pub fn main<T>()->int32 {return 0;}", /Entry point/],
];
for (const [name, source, message] of rejected) {
	test(`generics reject: ${name}`, async (t) => {
		await assert.rejects(
			check(
				t,
				source +
					(source.includes("main")
						? ""
						: " pub fn main()->int32{return 0;}"),
			),
			message,
		);
	});
}
