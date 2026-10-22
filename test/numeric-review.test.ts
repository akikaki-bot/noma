import assert from "node:assert/strict";
import test from "node:test";
import { deserializeValue, serializeValue } from "../src/serialization.js";
import { equivalent, INT8, UINT64 } from "../src/types.js";
import type { Type } from "../src/types.js";
import {
	getMemberType,
	project,
	setMemberType,
	snapshot,
} from "../src/values.js";
import type { Value } from "../src/values.js";
import { run } from "./helpers.js";

test("nested structural projection records projected slot schemas and keeps integer identities", () => {
	const numeric: Type = { kind: "union", members: [INT8, UINT64] };
	const inner: Type = {
		kind: "struct",
		fields: new Map([["value", numeric]]),
	};
	const fullInner: Type = {
		kind: "struct",
		fields: new Map<string, Type>([
			["value", numeric],
			["extra", INT8],
		]),
	};
	const target: Type = {
		kind: "struct",
		fields: new Map([["nested", inner]]),
	};
	const source: Type = {
		kind: "struct",
		fields: new Map([["nested", fullInner]]),
	};
	const nested: Record<string, Value> = Object.assign(Object.create(null), {
		value: 7n,
		extra: 1n,
	});
	setMemberType(nested, "value", UINT64);
	setMemberType(nested, "extra", INT8);
	const original: Record<string, Value> = Object.assign(Object.create(null), {
		nested,
	});
	setMemberType(original, "nested", fullInner);
	const projected = project(original, target, source) as Record<
		string,
		Value
	>;
	assert.ok(equivalent(getMemberType(projected, "nested")!, inner));
	const roundTrip = deserializeValue(
		serializeValue(snapshot(projected), target),
	);
	const copied = (roundTrip.value as Record<string, Value>).nested as Record<
		string,
		Value
	>;
	assert.equal(getMemberType(copied, "value")?.kind, "uint64");
	assert.equal(Object.hasOwn(copied, "extra"), false);
	const array = [nested];
	setMemberType(array, 0, fullInner);
	const projectedArray = project(
		array,
		{ kind: "array", element: inner },
		{ kind: "array", element: fullInner },
	) as Value[];
	assert.ok(equivalent(getMemberType(projectedArray, 0)!, inner));
	assert.doesNotThrow(() =>
		serializeValue(projectedArray, { kind: "array", element: inner }),
	);
});

test("numeric unions retain widths across mutation forwarding and nested async projection", async (t) => {
	assert.equal(
		await run(
			t,
			`
	use "std/typing" as typing;
	type Small=struct{value:int8|uint64;};
	type Large=struct{value:int8|uint64;extra:int8;};
	type Outer=struct{nested:Small;};
	fn write(mut value:int8|uint64,next:int8|uint64)->void{value=next;}
	fn forward(mut value:int8|uint64,next:int8|uint64)->void{write(value,next);}
	fn choose(value:int8|uint64)->int32{return match(value){case(n:int8){1}case(n:uint64){2}};}
	async fn produce(value:Outer)->Outer{return snapshot value;}
	async fn main()->int32{
	 let n:uint64=7;let s:int8=7;
	 let original:struct{nested:Large;}=struct{nested:Large{value:n,extra:s}};
	 let mut projected:Outer=(Outer)original;
	 forward(projected.nested.value,s);
	 if choose(read projected.nested.value)!=1{return 1;}
	 forward(projected.nested.value,n);
	 let owned:Outer=snapshot projected;
	 let copied:Outer=await produce(owned);
	 if choose(copied.nested.value)!=2{return 2;}
	 typing.trycast(struct{nested:struct{value:int8;};},copied) catch e{return 0;};
	 return 3;
	}`,
		),
		0n,
	);
});
