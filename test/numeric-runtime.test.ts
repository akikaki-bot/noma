import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./helpers.js";

test("numeric runtime retains concrete integer identities through unions and calls", async (t) => {
	assert.equal(
		await run(
			t,
			`
use "std/typing" as typing;
fn id<T>(value:T)->T{return value;}
fn choose(value:uint64|int8)->int32 {
 return match(value) {case(n:int8){1} case(n:uint64){2}};
}
fn main()->int32 {
 let n:uint64=1;
 let u:uint64|int8=id<uint64>(n);
 if choose(u)!=2{return 10;}
 typing.trycast(int8,u) catch e {return 0;};
 return 11;
}`,
		),
		0n,
	);
});

test("numeric runtime keeps slot identities through arrays, snapshots and array natives", async (t) => {
	assert.equal(
		await run(
			t,
			`
use "std/arr" as arr;
fn choose(value:int8|uint64)->int32 {
 return match(value) {case(n:int8){1} case(n:uint64){2}};
}
fn main()->int32 {
 let big:uint64=1; let small:int8=1;
 let mut a:Array<int8|uint64>=[big,small];
 if choose(read a[0])!=2{return 10;}
 if choose(arr.get<int8|uint64>(read a,0) otherwise e {small})!=2{return 11;}
 arr.push<int8|uint64>(a,big);
 if choose(arr.pop<int8|uint64>(a) otherwise e {small})!=2{return 12;}
 arr.set<int8|uint64>(a,1,big) catch e {return 13;};
 let copy:Array<int8|uint64>=snapshot a;
 if choose(copy[1])!=2{return 14;}
 if choose(arr.remove<int8|uint64>(a,0) otherwise e {small})!=2{return 15;}
 if choose(read a[0])!=2{return 16;}
 return 0;
}`,
		),
		0n,
	);
});

test("numeric runtime keeps numeric identities through struct projection and Futures", async (t) => {
	assert.equal(
		await run(
			t,
			`
use "std/typing" as typing;
type Box=struct{value:int8|uint64;};
async fn produce()->int8|uint64{let n:uint64=1;return n;}
fn choose(value:int8|uint64)->int32 {
 return match(value) {case(n:int8){1} case(n:uint64){2}};
}
async fn main()->int32 {
 let n:uint64=1;
 let b:Box=Box{value:n};
 let copy:Box=(Box)b;
 if choose(copy.value)!=2{return 10;}
 if choose(await produce())!=2{return 11;}
 typing.trycast(struct{value:int8;},b) catch e {return 0;};
 return 12;
}`,
		),
		0n,
	);
});

test("float unions retain precision type instead of inferring it from their value", async (t) => {
	assert.equal(
		await run(
			t,
			`
use "std/typing" as typing;
fn choose(value:float32|float64)->int32 {
 return match(value) {case(n:float32){1} case(n:float64){2}};
}
fn main()->int32 {
 let wide:float64=1.0; let narrow:float32=1.0;
 let values:Array<float32|float64>=[wide,narrow];
 if choose(values[0])!=2{return 10;}
 if choose(values[1])!=1{return 11;}
 typing.trycast(float32,wide) catch e {return 0;};
 return 12;
}`,
		),
		0n,
	);
});

test("runtime checks all integer widths and preserves exact large integers", async (t) => {
	assert.equal(
		await run(
			t,
			`fn main()->int32 {
 let x:uint64=18446744073709551615; let y:uint64=9007199254740993;
 if x-y!=18437736874454810622{return 1;}
 let a:int64=-9223372036854775808;
 if a/1!=-9223372036854775808{return 2;}
 let mut n:uint8=254; n++; n--; if n!=254{return 3;}
 return 0;
}`,
		),
		0n,
	);
	for (const source of [
		"let mut n:uint8=255;n++;",
		"let mut n:uint64=0;n--;",
		"let n:int64=-9223372036854775808;let d:int64=-1;n/d;",
		"let n:int8=-128;-n;",
		"let n:uint8=0;let d:uint8=1;n-d;",
		"let n:int16=1;let d:int16=0;n/d;",
		"let n:int16=300;let cast:uint8=(uint8)n;",
	])
		await assert.rejects(
			run(t, `fn main()->void{${source}}`),
			/overflow|zero|range/,
		);
});

test("float32 rounding and IEEE special values coexist with bigint", async (t) => {
	assert.equal(
		await run(
			t,
			`fn main()->int32 {
 let a:float32=16777216.0; let b:float32=1.0;
 if a+b!=a{return 1;}
 let z:float64=0.0; let one:float64=1.0;
 let inf:float64=one/z; let nan:float64=z/z;
 if inf<=one{return 2;} if nan==nan{return 3;}
 let nz:float64=-0.0; if one/nz>=z{return 4;}
 let n:int64=9007199254740993;
 if n+1!=9007199254740994{return 5;}
 return 0;
}`,
		),
		0n,
	);
});
