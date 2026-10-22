import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
	analyzeFile,
	lex,
	parse,
	runFile,
	numericJsonReplacer,
	numericJsonReviver,
} from "../src/index.js";
import {
	getIntegerBounds,
	integerTypes,
	integerOperation,
	numericCast,
	safeHostInteger,
} from "../src/numeric.js";
import { check, fixture, MemoryIO, run } from "./helpers.js";

test("shared integer semantics enforce every fixed width without wrapping", () => {
	for (const type of integerTypes) {
		const { min, max } = getIntegerBounds(type);
		assert.equal(integerOperation("+", max, 0n, type), max);
		assert.equal(integerOperation("-", min, 0n, type), min);
		assert.throws(() => integerOperation("+", max, 1n, type), /overflow/);
		assert.throws(() => integerOperation("-", min, 1n, type), /overflow/);
		assert.throws(() => integerOperation("*", max, 2n, type), /overflow/);
		assert.throws(() => integerOperation("/", 1n, 0n, type), /zero/);
		assert.throws(() => integerOperation("%", 1n, 0n, type), /zero/);
		if (type.startsWith("int")) {
			assert.equal(integerOperation("/", -7n, 3n, type), -2n);
			assert.equal(integerOperation("%", -7n, 3n, type), -1n);
			assert.throws(
				() => integerOperation("/", min, -1n, type),
				/overflow/,
			);
		}
	}
});

for (const type of integerTypes) {
	const { min, max } = getIntegerBounds(type);
	test(`${type}: contextual declarations, parameters, return, generics and bounds`, async (t) => {
		assert.equal(
			await run(
				t,
				`
		fn identity<T>(x:T)->T{return x;}
		fn low()->${type}{return ${min};}
		fn high(x:${type})->${type}{return x;}
		fn main()->int32{
		 let lo:${type}=low();let hi:${type}=high(${max});
		 let copy:${type}=identity<${type}>(${max});
		 if lo==${min} && hi==${max} && copy==hi{return 0;}return 1;
		}`,
			),
			0n,
		);
		for (const value of [min - 1n, max + 1n])
			await assert.rejects(
				check(t, `fn main()->void{let x:${type}=${value};}`),
				/range|overflow/,
			);
	});
	test(`${type}: compile-time and runtime checked arithmetic agree`, async (t) => {
		await assert.rejects(
			check(t, `fn main()->void{let x:${type}=${max}+1;}`),
			/overflow/,
		);
		for (const op of ["++", "--"]) {
			const start = op === "++" ? max : min;
			await assert.rejects(
				run(t, `fn main()->void{let mut x:${type}=${start};x${op};}`),
				/overflow/,
			);
		}
		assert.equal(
			await run(
				t,
				`fn main()->int32{
		let mut a:${type}=10;a++;a--;let b:${type}=3;
		if a+b==13 && a-b==7 && a*b==30 && a/b==3 && a%b==1{return 0;}return 1;}`,
			),
			0n,
		);
	});
}

test("integer mismatch and floating point mixing never promote operands", async (t) => {
	for (const expression of [
		"let a:uint8=10;let b:uint16=20;let c:uint16=a+b;",
		"let a:int32=10;let b:float64=20.0;let c:float64=a+b;",
		"let a:uint8=-1;",
		"let a:uint64=-10;",
		"let a:int8=128;",
		"let a:int128=1;",
		"let a:usize=1;",
	])
		await assert.rejects(check(t, `fn main()->void{${expression}}`));
});

test("explicit casts check constants and dynamic values", async (t) => {
	assert.equal(
		await run(
			t,
			`fn main()->int32{
	let a:uint8=200;let b:uint16=(uint16)a;
	let c:float32=(float32)b;let d:int64=(int64)c;
	if d==200{return 0;}return 1;}`,
		),
		0n,
	);
	await assert.rejects(
		check(t, "fn main()->void{let x:uint8=(uint8)300;}"),
		/range|cast/,
	);
	await assert.rejects(
		run(
			t,
			"fn source()->int16{return 300;}fn main()->void{let x:uint8=(uint8)source();}",
		),
		/range|cast/,
	);
	for (const value of [NaN, Infinity, -Infinity, 1.5, 256])
		assert.throws(() => numericCast(value, "float64", "uint8"));
	assert.throws(
		() => numericCast(9007199254740993n, "int64", "float64"),
		/Lossy/,
	);
	assert.throws(() => safeHostInteger(18446744073709551615n), /safe integer/);
});

test("integer-float casts preserve the original integer across the 53-bit boundary", async (t) => {
	for (const [value, from] of [
		[9007199254740991n, "int64"],
		[9007199254740992n, "int64"],
		[-9223372036854775808n, "int64"],
		[9223372036854775808n, "uint64"],
	] as const) {
		const converted = numericCast(value, from, "float64");
		assert.equal(BigInt(converted), value);
	}
	for (const value of [
		9007199254740993n,
		9223372036854775807n,
		18446744073709551615n,
	]) {
		assert.throws(() => numericCast(value, "uint64", "float64"), /Lossy/);
		await assert.rejects(
			run(
				t,
				`fn source()->uint64{return ${value};}fn main()->void{let f:float64=(float64)source();}`,
			),
			/Lossy/,
		);
		await assert.rejects(
			check(
				t,
				`fn main()->void{let f:float64=(float64)(uint64)${value};}`,
			),
			/Lossy/,
		);
	}
	assert.equal(numericCast(16777216n, "int32", "float32"), 16777216);
	assert.equal(numericCast(16777218n, "int32", "float32"), 16777218);
	assert.throws(() => numericCast(16777217n, "int32", "float32"), /Lossy/);
	assert.equal(numericCast(-0, "float64", "uint64"), 0n);
	assert.equal(
		numericCast(-9223372036854775808, "float64", "int64"),
		-9223372036854775808n,
	);
	assert.throws(
		() => numericCast(9223372036854775808, "float64", "int64"),
		/range/,
	);
	assert.throws(
		() => numericCast(18446744073709551616, "float64", "uint64"),
		/range/,
	);
	assert.equal(
		await run(
			t,
			`fn main()->int32{
	 let i:int64=(int64)-9223372036854775808;
	 let f:float64=(float64)i;let back:int64=(int64)f;
	 if back==i{return 0;}return 1;}`,
		),
		0n,
	);
});

test("development and production execution retain identical checked numeric semantics", async (t) => {
	const file = await fixture(
		t,
		"fn bound()->uint8{return 255;}fn main()->void{let mut n:uint8=bound();n++;}",
	);
	const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
	const outputs = ["development", "production"].map((mode) =>
		spawnSync(process.execPath, [cli, file], {
			encoding: "utf8",
			env: { ...process.env, NODE_ENV: mode },
			windowsHide: true,
		}),
	);
	for (const result of outputs) {
		assert.equal(result.status, 1);
		assert.match(result.stderr, /uint8 arithmetic overflow/);
	}
	assert.equal(outputs[0]!.stderr, outputs[1]!.stderr);
});

test("minimum signed division and negation fail at compile time and runtime", async (t) => {
	for (const type of ["int8", "int64"] as const) {
		const { min } = getIntegerBounds(type);
		await assert.rejects(
			check(t, `fn main()->void{let x:${type}=${min}/-1;}`),
			/overflow/,
		);
		for (const expression of ["a/-1", "-a"])
			await assert.rejects(
				run(
					t,
					`fn low()->${type}{return ${min};}fn main()->void{let a:${type}=low();${expression};}`,
				),
				/overflow/,
			);
	}
	for (const op of ["/", "%"]) {
		await assert.rejects(check(t, `fn main()->void{1${op}0;}`), /zero/);
		await assert.rejects(
			run(t, `fn zero()->int32{return 0;}fn main()->void{1${op}zero();}`),
			/zero/,
		);
	}
});

test("real Noma fixture preserves 64-bit precision through lexer, native output and arrays", async () => {
	const io = new MemoryIO();
	assert.equal(
		await runFile(
			fileURLToPath(
				new URL("../../test/fixtures/numeric.noma", import.meta.url),
			),
			io,
		),
		0n,
	);
	assert.equal(
		io.stdout,
		"9007199254740991\n9007199254740992\n9007199254740993\n9223372036854775807\n-9223372036854775808\n18446744073709551615\n",
	);
});

test("floating point precision, IEEE values and comparisons coexist with integers", async (t) => {
	assert.equal(
		await run(
			t,
			`fn main()->int32{
	let a:float32=16777216.0;let b:float32=a+1.0;
	let c:float64=16777216.0;let d:float64=c+1.0;
	let inf:float64=1.0/0.0;let neg:float64=-inf;
	let nan:float64=0.0/0.0;let z:float64=-0.0;
	if a==b && c!=d && inf>c && neg<c && nan!=nan && 1.0/z==neg{return 0;}return 1;}`,
		),
		0n,
	);
	for (const expression of ["1.0/0.0", "-1.0/0.0", "0.0/0.0", "1.5"])
		await assert.rejects(
			run(
				t,
				`fn value()->float64{return ${expression};}fn main()->void{let x:int64=(int64)value();}`,
			),
			/cast|range|fractional/,
		);
});

test("numeric union identity survives snapshots, generic calls, arrays and Futures", async (t) => {
	assert.equal(
		await run(
			t,
			`use "std/typing" as typing;use "std/arr" as arr;
	fn id<T>(x:T)->T{return x;}
	async fn later(x:uint64)->uint64{return x;}
	async fn main()->int32{
	let small:uint8=7;let large:uint64=7;
	let a:Array<uint8|uint64>=[small,large];
	let first:uint8|uint64=arr.get<uint8|uint64>(a,0) catch e{return 1;};
	let f:Future<uint64>=later(large);let n:uint64=await f;
	let copy:uint8|uint64=id<uint8|uint64>(snapshot a[1]);
	typing.trycast(uint8,n) catch e{
	 return match(copy){case(v:uint8){2}case(v:uint64){match(first){case(w:uint8){0}case(w:uint64){3}}}};
	};return 4;}`,
		),
		0n,
	);
});

test("BigInt compiler/debug transport round trips without JSON precision loss", () => {
	const tokens = lex("18446744073709551615");
	assert.equal(tokens[0]!.text, "18446744073709551615");
	const ast = parse("fn main()->void{let n:uint64=18446744073709551615;}");
	const text = JSON.stringify(ast, numericJsonReplacer);
	assert.ok(text.includes("18446744073709551615"));
	assert.deepEqual(JSON.parse(text, numericJsonReviver), ast);
});

test("LSP numeric diagnostics and valid uint64 source serialize as ordinary JSON", async (t) => {
	const file = await fixture(t, "fn main()->void{let n:uint8=256;}");
	const result = await analyzeFile(file);
	assert.equal(result.status, "error");
	assert.match(result.diagnostics[0]!.message, /uint8/);
	assert.doesNotThrow(() => JSON.stringify(result.diagnostics));
	const valid = await fixture(
		t,
		"fn main()->void{let n:uint64=18446744073709551615;}",
	);
	assert.equal((await analyzeFile(valid)).status, "success");
});

test("numeric context flows through nested arithmetic without promoting variables", async (t) => {
	assert.equal(
		await run(
			t,
			`
	fn small(x:uint8)->uint8{return (1+2)*(x+1);}
	fn main()->int32{
	 let a:uint8=2;
	 let left:uint8=(1+2)*(a+1);
	 let right:uint8=(a+1)*(1+2);
	 let nested:uint8=((1+2)*(3+4))+small(1);
	 let low:int64=-(9223372036854775808);
	 let high:uint64=(uint64)18446744073709551615;
	 if left==9 && right==9 && nested==27 && low==-9223372036854775808 && high==18446744073709551615{return 0;}
	 return 1;
	}`,
		),
		0n,
	);
	for (const expression of ["a+1", "1+a", "a+(1+2)", "(1+2)+a", "-a"])
		await assert.rejects(
			check(
				t,
				`fn main()->void{let a:int8=1;let b:int16=${expression};}`,
			),
			/Expected int16/,
		);
	for (const expression of [
		"(uint8)(uint16)256",
		"(int8)((int16)127+1)",
		"(uint8)(int16)-1",
	])
		await assert.rejects(
			check(t, `fn main()->void{let value:uint8|int8=${expression};}`),
			/range/,
		);
});
