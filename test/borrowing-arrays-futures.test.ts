import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { compile, runFile } from "../src/index.js";
import { analyzeFile } from "../src/analysis.js";
import { AnalysisWorkspace } from "../src/workspace.js";
import { FutureValue, clone, snapshot } from "../src/values.js";
import { INT32, STRING, VOID, THROWABLE, union } from "../src/types.js";
import { NativeRegistry } from "../src/native.js";
import { invokeArray } from "../src/array-runtime.js";
import { ThrowableValue } from "../src/values.js";
import { check, fixture, MemoryIO, run } from "./helpers.js";

const fixtureFile = (name: string) =>
	fileURLToPath(new URL(`../../test/fixtures/${name}.noma`, import.meta.url));
for (const name of ["read-borrowing", "arrays"])
	test(`real .noma fixture: ${name}`, async () =>
		assert.equal(await runFile(fixtureFile(name), new MemoryIO()), 0n));

test("real Future fixture is lazy, transfers ownership and handles nested futures/errors", async () => {
	const io = new MemoryIO();
	assert.equal(await runFile(fixtureFile("futures"), io), 0n);
	assert.equal(io.stdout, "created\nbody\nbody\ncaught\n");
});

for (const [name, error] of [
	["borrow-conflict", /borrow|mutate and read/],
	["future-double-await", /consumed or moved/],
	["future-branch-consumption", /consumed or moved/],
	["future-loop-consumption", /loop cannot consume/],
] as const)
	test(`real rejected .noma fixture: ${name}`, async () =>
		assert.rejects(compile(fixtureFile(name)), error));

const prefix = "async fn calculate() -> int32 { return 42; } ";
const rejected: [string, string, RegExp][] = [
	[
		"read is not an immutable binding",
		"fn main()->void { let mut n:int32=1; let a:int32=read n; }",
		/borrow|snapshot/,
	],
	[
		"read is not a mutable binding",
		"fn main()->void { let mut n:int32=1; let mut a:int32=read n; }",
		/temporary borrow/,
	],
	[
		"read cannot be returned",
		"fn f(n:int32)->int32 { return read n; } fn main()->void {}",
		/borrow/,
	],
	[
		"read cannot be placed in a struct",
		"fn f(x:struct{n:int32;})->void{} fn main()->void { let mut n:int32=1; f(struct{n:read n}); }",
		/temporary borrow/,
	],
	[
		"read cannot be placed in an array",
		"fn f(x:Array<int32>)->void{} fn main()->void { let mut n:int32=1; f([read n]); }",
		/temporary borrow/,
	],
	[
		"read cannot be snapshotted into an escaping loan",
		"fn main()->void {let n:int32=1; let a:int32=snapshot (read n);}",
		/temporary borrow/,
	],
	[
		"read requires an address",
		"fn f(x:int32)->void{} fn main()->void { f(read 1); }",
		/addressable/,
	],
	[
		"read does not grant mutability",
		"fn f(mut x:int32)->void{} fn main()->void { let mut n:int32=1; f(read n); }",
		/mutable storage/,
	],
	[
		"read and mut conflict",
		"fn f(a:int32,mut b:int32)->void{} fn main()->void {let mut n:int32=1; f(read n,n);}",
		/mutate and read/,
	],
	[
		"mut and read conflict",
		"fn f(mut a:int32,b:int32)->void{} fn main()->void {let mut n:int32=1; f(n,read n);}",
		/mutate and read/,
	],
	[
		"nested writes cannot invalidate element loans",
		'use "std/arr" as arr; fn f(a:int32,b:int32)->void{} fn main()->void {let mut n:Array<int32>=[1]; f(read n[0],arr.pop<int32>(n) otherwise e {0});}',
		/borrow/,
	],
	[
		"direct assignment cannot invalidate loans",
		"fn f(a:int32,b:int32)->void{} fn main()->void {let mut n:int32=1; f(read n,{n=2; 0});}",
		/borrow/,
	],
	[
		"updates cannot invalidate loans",
		"fn f(a:int32,b:int32)->void{} fn main()->void {let mut n:int32=1; f(read n,n++);}",
		/borrow/,
	],
	[
		"struct parent alias is conservative",
		"type S=struct{x:int32;y:int32;}; fn f(a:int32,mut b:int32)->void{} fn main()->void{let mut s:S=S{x:1,y:2}; f(read s.x,s.y);}",
		/mutate and read/,
	],
	[
		"generic identity cannot retain a read array",
		"fn id<T>(v:T)->T{return v;} fn main()->void{let mut n:Array<int32>=[1]; id<Array<int32>>(read n);}",
		/retain or copy/,
	],
	[
		"generic mutable retention is rejected for read arguments",
		"fn retain<T>(v:T)->void{let mut copy:T=v;} fn main()->void{let mut n:Array<int32>=[1]; retain<Array<int32>>(read n);}",
		/retain or copy/,
	],
	[
		"arrays have no length property",
		"fn main()->void{let n:Array<int32>=[1]; n.length;}",
		/no properties/,
	],
	[
		"nonempty literals need context",
		"fn main()->void{[1,2,3];}",
		/expected array type/,
	],
	[
		"empty literals need context",
		"fn main()->void{[];}",
		/expected array type/,
	],
	[
		"indexing cannot infer a literal type",
		"fn main()->int32{return [1][0];}",
		/expected array type/,
	],
	[
		"literal elements obey the declared type",
		'fn main()->void{let n:Array<int32>=[1,"bad"];}',
		/Expected int32/,
	],
	[
		"array union context must be unambiguous",
		"fn main()->void{let n:Array<int32>|Array<string>=[];}",
		/unambiguous/,
	],
	[
		"array create requires explicit type arguments",
		'use "std/arr" as arr; fn main()->void {let n:Array<int32>=arr.create();}',
		/explicit type arguments/,
	],
	[
		"intrinsics cannot be forged",
		"pub fn length<T>(v:Array<T>)->int32; fn main()->void{}",
		/Only compiler intrinsic/,
	],
	[
		"internal array operations are private to the stdlib",
		'use "std/internal/arr" as arr; fn main()->void{}',
		/trusted native boundary/,
	],
	[
		"mutable Future",
		prefix + "fn main()->void{let mut f:Future<int32>=calculate();}",
		/cannot be mutable/,
	],
	[
		"Future snapshot",
		prefix +
			"fn main()->void{let f:Future<int32>=calculate(); snapshot f;}",
		/non-copyable/,
	],
	[
		"snapshot struct containing Future",
		prefix +
			"fn main()->void{let s:struct{f:Future<int32>;}=struct{f:calculate()}; snapshot s;}",
		/non-copyable/,
	],
	[
		"snapshot array containing Future",
		prefix +
			"fn main()->void{let s:Array<Future<int32>>=[calculate()]; snapshot s;}",
		/non-copyable/,
	],
	[
		"mutable container containing Future",
		prefix +
			"fn main()->void{let mut s:Array<Future<int32>>=[calculate()];}",
		/cannot be mutable/,
	],
	[
		"await read Future",
		prefix +
			"async fn main()->int32{let f:Future<int32>=calculate(); return await (read f);}",
		/ownership/,
	],
	[
		"await outside async",
		prefix + "fn main()->int32{return await calculate();}",
		/async function/,
	],
	[
		"await a plain value",
		"async fn main()->int32{return await 42;}",
		/requires Future/,
	],
	[
		"moved Future cannot be used",
		prefix +
			"async fn main()->int32{let f:Future<int32>=calculate(); let g:Future<int32>=f; await g; return await f;}",
		/consumed or moved/,
	],
	[
		"passing transfers ownership",
		prefix +
			"fn take(f:Future<int32>)->void{} fn main()->void{let f:Future<int32>=calculate(); take(f); take(f);}",
		/consumed or moved/,
	],
	[
		"two arguments cannot own the same Future",
		prefix +
			"fn take(a:Future<int32>,b:Future<int32>)->void{} fn main()->void{let f:Future<int32>=calculate(); take(f,f);}",
		/consumed or moved/,
	],
	[
		"one container cannot own a Future twice",
		prefix +
			"fn main()->void{let f:Future<int32>=calculate(); let a:Array<Future<int32>>=[f,f];}",
		/consumed or moved/,
	],
	[
		"consuming a container prevents its reuse",
		prefix +
			"fn main()->void{let a:Array<Future<int32>>=[calculate()];let b:Array<Future<int32>>=a;let c:Array<Future<int32>>=a;}",
		/consumed or moved/,
	],
	[
		"Future generic snapshot loophole",
		prefix +
			"fn copy<T>(v:T)->T{return snapshot v;} fn main()->void{copy<Future<int32>>(calculate());}",
		/non-copyable/,
	],
	[
		"Future generic identity loophole",
		prefix +
			"fn id<T>(v:T)->T{return v;} fn main()->void{id<Future<int32>>(calculate());}",
		/non-copyable/,
	],
	[
		"nested non-copyable generic argument",
		prefix +
			"fn id<T>(v:T)->T{return v;} fn main()->void{id<Array<Future<int32>>>([calculate()]);}",
		/non-copyable/,
	],
	[
		"get cannot snapshot Future elements",
		prefix +
			'use "std/arr" as arr; fn main()->void{let a:Array<Future<int32>>=[calculate()];arr.get<Future<int32>>(read a,0);}',
		/non-copyable/,
	],
	[
		"static cast cannot clone Future",
		prefix +
			"fn main()->void{let f:Future<int32>=calculate(); (Future<int32>)f;}",
		/Cannot prove/,
	],
	[
		"trycast cannot clone Future",
		prefix +
			'use "std/typing" as typing; fn main()->void{let f:Future<int32>=calculate(); typing.trycast(Future<int32>,f);}',
		/cannot copy/,
	],
	[
		"async functions cannot take mut borrows",
		"async fn bad(mut n:int32)->int32{return 1;} fn main()->void{}",
		/mutable borrows/,
	],
	[
		"async calls cannot capture read borrows",
		"async fn load(n:int32)->int32{return n;} fn main()->void{let n:int32=1; load(read n);}",
		/owned values/,
	],
	[
		"async cannot capture forwarded aggregate borrows",
		"async fn load(a:Array<int32>)->int32{return 1;} fn forward(a:Array<int32>)->Future<int32>{return load(a);} fn main()->void{}",
		/owned values/,
	],
	[
		"borrow cannot cross await in later argument",
		prefix +
			"fn inspect(a:int32,b:int32)->void{} async fn main()->void{let n:int32=1;inspect(read n,await calculate());}",
		/borrow across await/,
	],
	[
		"short circuit consumption is joined",
		prefix +
			"async fn main()->int32{let f:Future<int32>=calculate();let b:bool=false && await f == 42;return await f;}",
		/consumed or moved/,
	],
	[
		"handler consumption is joined",
		prefix +
			'fn fail()->int32|throwable{raise "bad";} async fn main()->int32{let f:Future<int32>=calculate(); let n:int32=fail() otherwise e {await f}; return await f;}',
		/consumed or moved/,
	],
	[
		"match aliases have a single owner",
		prefix +
			"async fn main()->int32{let f:Future<int32>=calculate(); return match(f){case(g:Future<int32>){await g; await f}};}",
		/consumed or moved/,
	],
	[
		"Future type arguments are explicit",
		"fn main()->void{let f:Future=void;}",
		/one explicit type argument/,
	],
	[
		"Future cannot be redeclared",
		"type Future<T>=struct{value:T;};fn main()->void{}",
		/Builtin type names/,
	],
];
for (const [name, source, error] of rejected)
	test(`static safety rejects: ${name}`, async (t) =>
		assert.rejects(check(t, source), error));

for (const index of [-1, 1, 20])
	test(`ordinary indexing reports Runtime Error for index ${index}`, async (t) =>
		assert.rejects(
			run(
				t,
				`fn main()->int32{let a:Array<int32>=[1];return a[${index}];}`,
			),
			/Array index out of bounds/,
		));

test("both branches may consume a Future and locally created loop Futures are independent", async (t) => {
	assert.equal(
		await run(
			t,
			prefix +
				`async fn main()->int32{
	 let f:Future<int32>=calculate(); let result:int32=if true {await f} else {await f};
	 let mut count:int32=0; while count<2 {let local:Future<int32>=calculate(); await local;count++;}
	 return result;
	}`,
		),
		42n,
	);
});

test("a returning branch does not consume a Future on the continuing path", async (t) => {
	assert.equal(
		await run(
			t,
			prefix +
				"async fn main()->int32{let f:Future<int32>=calculate();if false{await f;return 1;}return await f;}",
		),
		42n,
	);
});

test("owned Future structs can be moved through functions without copying", async (t) => {
	assert.equal(
		await run(
			t,
			prefix +
				`type Box=struct{f:Future<int32>;};
	fn transfer(box:Box)->Box{return box;}
	fn make()->Box{return Box{f:calculate()};}
	fn main()->int32{let first:Box=make();let second:Box=transfer(first);return 0;}`,
		),
		0n,
	);
});

test("Future creation evaluates arguments immediately and runs the body lazily", async (t) => {
	const io = new MemoryIO();
	assert.equal(
		await run(
			t,
			`use "std/io" as io;
	fn argument()->int32{io.puts("argument") catch e {return 1;};return 42;}
	async fn task(n:int32)->int32{io.puts("body") catch e {return 1;};return n;}
	async fn main()->int32{let f:Future<int32>=task(argument());io.puts("created") catch e {return 1;};return await f;}`,
			io,
		),
		42n,
	);
	assert.equal(io.stdout, "argument\ncreated\nbody\n");
});

test("async capture uses an independent explicit snapshot", async (t) => {
	assert.equal(
		await run(
			t,
			`async fn first(a:Array<int32>)->int32{return a[0]+0;}
	async fn main()->int32{let mut a:Array<int32>=[42];let f:Future<int32>=first(snapshot a);a[0]=99;return await f;}`,
		),
		42n,
	);
});

test("executor suspends for host I/O and resumes without blocking the event loop", async (t) => {
	let enter!: () => void, release!: (value: string) => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const input = new Promise<string>((resolve) => {
		release = resolve;
	});
	const io = new MemoryIO();
	io.readLine = async () => {
		enter();
		return input;
	};
	const file = await fixture(
		t,
		`use "std/io" as io;
	async fn load()->string|throwable {let input:string|io.EOF=io.readLine() catch e {return e;};return match(input){case(s:string){s} case(e:io.EOF){"end"}};}
	async fn main()->int32{let pending:Future<string|throwable>=load();let text:string=await pending catch e {return 1;};if text=="resumed"{return 42;}return 2;}`,
	);
	let completed = false;
	const running = runFile(file, io).then((value) => {
		completed = true;
		return value;
	});
	await entered;
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(completed, false);
	release("resumed");
	assert.equal(await running, 42n);
});

test("host rejection becomes a catchable error after awaiting", async (t) => {
	const io = new MemoryIO();
	io.readLine = async () => {
		throw new Error("host failure");
	};
	assert.equal(
		await run(
			t,
			`use "std/io" as io;
	async fn load()->string|io.EOF|throwable{return io.readLine();}
	async fn main()->int32{let input:string|io.EOF=await load() catch e {if e.message=="host failure"{return 42;}return 1;};return 2;}`,
			io,
		),
		42n,
	);
});

test("runtime Future guard is lazy and rejects both copying and repeated consumption", async () => {
	let calls = 0;
	const value = new FutureValue(
		async () => {
			calls++;
			return 42n;
		},
		INT32,
		{ file: "unit.noma", line: 1, column: 1 },
	);
	assert.equal(calls, 0);
	assert.throws(() => snapshot({ nested: [value] }), /non-copyable/);
	assert.throws(() => clone(value, false), /non-copyable/);
	assert.equal(await value.take(), 42n);
	assert.equal(calls, 1);
	await assert.rejects(value.take(), /already consumed/);
});

test("array get copies deeply while pop/remove move the original storage", () => {
	const first = { values: [1n] },
		second = { values: [2n] };
	const array = [first, second];
	assert.equal(invokeArray("length", [array]), 2n);
	const saved = invokeArray("get", [array, 0n]) as { values: bigint[] };
	assert.notEqual(saved, first);
	assert.notEqual(saved.values, first.values);
	first.values[0] = 9n;
	assert.equal(saved.values[0], 1n);
	assert.equal(invokeArray("pop", [array]), second);
	assert.equal(invokeArray("remove", [array, 0n]), first);
	assert.deepEqual(array, []);
	assert.ok(invokeArray("pop", [array]) instanceof ThrowableValue);
	assert.ok(invokeArray("remove", [array, -1n]) instanceof ThrowableValue);
	assert.deepEqual(array, []);
});

test("generic async frames substitute nested result types and preserve ownership", async (t) => {
	assert.equal(
		await run(
			t,
			`async fn task<T>(value:T)->T{return value;}
	fn forward<U>(value:U)->Future<U>{return task<U>(value);}
	async fn main()->int32{let f:Future<Array<int32>>=forward<Array<int32>>([42]);let a:Array<int32>=await f;return a[0];}`,
		),
		42n,
	);
});

test("read and length never copy even arrays of non-copyable Futures", async (t) => {
	const io = new MemoryIO();
	assert.equal(
		await run(
			t,
			`use "std/arr" as arr; use "std/io" as io;
	async fn task()->int32{io.puts("unexpected") catch e {return 1;};return 42;}
	fn main()->int32{let items:Array<Future<int32>>=[task(),task()];
	 let a:int32=arr.length<Future<int32>>(read items);
	 let b:int32=arr.length<Future<int32>>(read items);
	 let moved:Array<Future<int32>>=items;return a+b;}`,
			io,
		),
		4n,
	);
	assert.equal(io.stdout, "");
});

test("Future inspection may borrow repeatedly without consuming ownership", async (t) => {
	assert.equal(
		await run(
			t,
			prefix +
				`fn inspect(a:Future<int32>,b:Future<int32>)->void{}
	async fn main()->int32{let f:Future<int32>=calculate();inspect(read f,read f);return await f;}`,
		),
		42n,
	);
});

test("a Future cannot move while an earlier argument borrows it", async (t) => {
	await assert.rejects(
		check(
			t,
			prefix +
				`fn inspect(a:Future<int32>,b:Future<int32>)->void{}
	fn main()->void{let f:Future<int32>=calculate();inspect(read f,f);}`,
		),
		/move or consume borrowed/,
	);
});

test("a read Future cannot be returned or captured by a forwarding function", async (t) => {
	await assert.rejects(
		check(
			t,
			prefix +
				`fn forward(a:Future<int32>)->Future<int32>{return a;}
	fn main()->void{let f:Future<int32>=calculate();forward(read f);}`,
		),
		/retain or copy/,
	);
});

test("match views preserve mutable caller storage without freezing it", async (t) => {
	assert.equal(
		await run(
			t,
			`type Box=struct{values:Array<int32>;};
	fn main()->int32{let mut box:Box=Box{values:[1]};match(box){case(b:Box){b.values[0]+0}};box.values[0]=2;return box.values[0]+0;}`,
		),
		2n,
	);
});

test("Native Promise rejection follows fallible and infallible ABI contracts", async (t) => {
	const checked = await check(
		t,
		'use "std/io" as io; use "std/string" as str; fn main()->void{}',
	);
	const ioModule = checked.program.modules.find(
		(m) => m.id === "std/internal/io",
	)!;
	const strModule = checked.program.modules.find(
		(m) => m.id === "std/internal/string",
	)!;
	const registry = new NativeRegistry();
	registry.register("std/internal/io#writeStdout", {
		inputs: [STRING],
		result: union([VOID, THROWABLE]),
		invoke: async () => {
			throw new Error("rejected write");
		},
	});
	const failed = await registry.call(
		checked.functions.get(ioModule)!.get("writeStdout")!,
		["test"],
	);
	assert.ok(failed instanceof ThrowableValue);
	assert.equal(failed.message, "rejected write");
	registry.register("std/internal/string#codepointLength", {
		inputs: [STRING],
		result: INT32,
		invoke: async () => {
			throw new Error("rejected length");
		},
	});
	await assert.rejects(
		registry.call(
			checked.functions.get(strModule)!.get("codepointLength")!,
			["test"],
		),
		/Native execution failed: rejected length/,
	);
});

test("the arrays/Future example executes with the documented side-effect order", async () => {
	const io = new MemoryIO();
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL("../../examples/arrays-futures.noma", import.meta.url),
			),
			io,
		),
		0n,
	);
	assert.equal(
		io.stdout,
		"Created 3 elements\nFuture started\nSnapshot result: 10\n",
	);
});

test("Future error handlers respect binding shadowing and owned return values", async (t) => {
	assert.equal(
		await run(
			t,
			prefix +
				`fn fail()->int32|throwable{raise "bad";}
	async fn main()->int32{let e:Future<int32>=calculate();let answer:int32=await e;let recovered:int32=fail() otherwise e {if e.message=="bad"{42}else{1}};return recovered;}`,
		),
		42n,
	);
});

test("a unique structural Union alternative provides nested array context", async (t) => {
	assert.equal(
		await run(
			t,
			`fn source()->struct{values:Array<int32>;}|throwable{return struct{values:[42]};}
	fn main()->int32{let item:struct{values:Array<int32>;}=source() catch e {return 1;};return item.values[0];}`,
		),
		42n,
	);
});

test("CLI drives async main, preserves its exit status, and --check is lazy", async (t) => {
	const file = await fixture(
		t,
		'use "std/io" as io; async fn main()->int32{io.puts("executed") catch e {return 1;};return 7;}',
	);
	const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
	const exec = promisify(execFile);
	const checked = await exec(process.execPath, [cli, "--check", file]);
	assert.equal(checked.stdout, "Type check passed\n");
	await assert.rejects(
		exec(process.execPath, [cli, file]),
		(error: unknown) => {
			const result = error as {
				code: number;
				stdout: string;
				stderr: string;
			};
			assert.equal(result.code, 7);
			assert.equal(result.stdout, "executed\n");
			assert.equal(result.stderr, "");
			return true;
		},
	);
});

test("LSP analysis diagnoses consumption errors and offers Future/read/async/await", async (t) => {
	const file = await fixture(
		t,
		prefix +
			"async fn main()->void{let f:Future<int32>=calculate();await f;await f;}",
	);
	const result = await analyzeFile(file);
	assert.equal(result.status, "error");
	assert.match(result.diagnostics[0]!.message, /consumed or moved/);
	const text =
		prefix + "async fn main()->void{let f:Future<int32>=calculate(); }";
	const uri = pathToFileURL(file).href,
		workspace = new AnalysisWorkspace();
	workspace.updateDocument({ uri, version: 2, text });
	const view = (await workspace.analyze(uri))!;
	assert.equal(view.diagnostics.length, 0);
	const items = view.completionItems(uri, {
		line: 0,
		character: text.length - 1,
	});
	for (const name of ["Future", "read", "async", "await"])
		assert.ok(
			items.some((item) => item.label === name),
			name,
		);
	assert.ok(
		items.some(
			(item) =>
				item.label === "f" && item.detail.includes("Future<int32>"),
		),
	);
});
