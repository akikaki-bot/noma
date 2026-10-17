import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { AnalysisWorkspace } from "../src/workspace.js";
import { SourceText } from "../src/source.js";
import { Interpreter } from "../src/interpreter.js";
import { NativeRegistry } from "../src/native.js";
import { checkProgram } from "../src/checker.js";
import { loadProgram } from "../src/modules.js";
import { fixture } from "./helpers.js";

async function assist(
	t: TestContext,
	marked: string,
	files: Record<string, string> = {},
) {
	const offset = marked.indexOf("§");
	assert.ok(offset >= 0);
	const text = marked.replace("§", ""),
		file = await fixture(t, text, files),
		uri = pathToFileURL(file).href;
	const source = new SourceText(file, text),
		position = source.positionAt(offset);
	const workspace = new AnalysisWorkspace();
	workspace.updateDocument({ uri, text, version: 1 });
	const snapshot = (await workspace.analyze(uri))!;
	return {
		snapshot,
		uri,
		position,
		source,
		workspace,
		items: snapshot.completionItems(uri, position),
		help: snapshot.signatureHelp(uri, position),
	};
}

test("completion supplies real keywords and UTF-16 replacement ranges for a partial word", async (t) => {
	const { items, source } = await assist(
		t,
		'fn f()->void { let text:string="🌱"; ret§urn; }',
	);
	assert.deepEqual(
		items.map((i) => i.label),
		["return"],
	);
	assert.equal(items[0]!.kind, "keyword");
	assert.equal(items[0]!.insertText, "return");
	assert.equal(
		source.text.slice(
			source.offsetAt(items[0]!.range.start),
			source.offsetAt(items[0]!.range.end),
		),
		"return",
	);
	const all = (await assist(t, "fn f()->void { § }")).items;
	for (const name of [
		"let",
		"mut",
		"fn",
		"pub",
		"type",
		"struct",
		"return",
		"if",
		"else",
		"while",
		"match",
		"case",
		"raise",
		"catch",
		"otherwise",
		"snapshot",
		"use",
		"as",
	])
		assert.ok(
			all.some((i) => i.label === name),
			name,
		);
	for (const name of ["async", "await", "throw", "class"])
		assert.ok(!all.some((i) => i.label === name), name);
});

test("completion respects declaration order, lexical scope and shadowing during type errors", async (t) => {
	const { items, snapshot } = await assist(
		t,
		`type User=struct{name:string;};
fn other()->void {let outside:int32=0;}
fn f(arg:bool)->void {
 let thing:string="outer";
 { let sibling:int32=1; }
 { let thing:int32=2; § unknown;
   let later:int32=3;
 }
}`,
	);
	assert.equal(snapshot.result.status, "error");
	assert.equal(items.filter((i) => i.label === "thing").length, 1);
	assert.match(items.find((i) => i.label === "thing")!.detail, /int32/);
	for (const name of ["arg", "other", "f", "User"])
		assert.ok(
			items.some((i) => i.label === name),
			name,
		);
	for (const name of ["outside", "sibling", "later", "unknown"])
		assert.ok(!items.some((i) => i.label === name), name);
});

test("incomplete module access resolves public exports and hides implementation details", async (t) => {
	const { items, snapshot } = await assist(
		t,
		'use "helper" as h; fn f()->void { h.§ }',
		{
			"helper.noma":
				"pub type Box<T> = struct{value:T;}; type Secret=int32; pub fn identity<T>(x:T)->T{return x;} fn hidden()->void{}",
		},
	);
	assert.equal(snapshot.diagnostics[0]!.code, "syntax");
	assert.deepEqual(items.map((i) => i.label).sort(), ["Box", "identity"]);
	const std = await assist(
		t,
		'use "std/string" as str; fn f()->void { str.§ }',
	);
	assert.ok(std.items.some((i) => i.label === "length"));
	assert.ok(!std.items.some((i) => /native|TSAny|internal/.test(i.detail)));
});

test("struct and nested generic/indexed field completion shows concrete field types", async (t) => {
	for (const [receiver, expected] of [
		["box", "struct"],
		["box.value", "int32"],
		["boxes[0].value", "int32"],
	]) {
		const { items } = await assist(
			t,
			`type Box<T> = struct{value:T;}; fn f()->void {
 let box:Box<Box<int32>> = Box<Box<int32>>{value:Box<int32>{value:1}};
 let boxes:Box<Box<int32>>[]=[box];
 ${receiver}.§ }`,
		);
		assert.deepEqual(
			items.map((i) => i.label),
			["value"],
		);
		assert.match(items[0]!.detail, new RegExp(expected!));
		assert.equal(items[0]!.kind, "field");
	}
});

test("local variables shadow module aliases for field completion", async (t) => {
	const { items } = await assist(
		t,
		'use "std/io" as io; fn f()->void {let io:struct{local:int32;}=struct{local:1}; io.§ }',
	);
	assert.deepEqual(
		items.map((i) => i.label),
		["local"],
	);
});

test("unfinished type argument lists and unclosed blocks retain type parameter scope", async (t) => {
	const { items } = await assist(
		t,
		"type Box<T> = struct{value:T;}; fn identity<T>(value:T)->T{return value;} fn f<U>(value:U)->void { identity<§",
	);
	for (const name of ["Box", "U", "int32", "string"])
		assert.ok(
			items.some((i) => i.label === name),
			name,
		);
	for (const name of ["value", "identity", "T", "return"])
		assert.ok(!items.some((i) => i.label === name), name);
});

test("type argument assistance keeps the type namespace when a value has the same spelling", async (t) => {
	const prefix =
		"fn identity<T>(value:T)->T{return value;} fn f<U>(U:U)->void { ";
	const { items } = await assist(t, prefix + "identity<§");
	assert.equal(items.find((item) => item.label === "U")!.kind, "type");
	const { help } = await assist(t, prefix + "identity<U>(§");
	assert.equal(help!.signatures[0]!.label, "identity<U>(value: U) -> U");
});

test("type parameters do not shadow value-namespace module aliases", async (t) => {
	const prefix = 'use "std/io" as io; fn f<io>(value:io)->void { ';
	assert.ok(
		(await assist(t, prefix + "io.§")).items.some(
			(item) => item.label === "puts",
		),
	);
	assert.match(
		(await assist(t, prefix + "io.puts(§")).help!.signatures[0]!.label,
		/io.puts\(text: string\)/,
	);
});

test("comparison operators do not turn variable completion into type-argument completion", async (t) => {
	const { items } = await assist(
		t,
		"fn f(value:int32,user:int32)->void { if value < us§er {} }",
	);
	assert.ok(
		items.some(
			(item) => item.label === "user" && item.kind === "parameter",
		),
	);
});

test("signature probes preserve canonical definitions and references", async (t) => {
	const { snapshot, uri, source, position } = await assist(
		t,
		"type Num=int32; fn id<T>(value:T)->T{return value;} fn f()->int32{return id<Num>(§1);}",
	);
	const name = source.positionAt(source.text.indexOf("Num="));
	const before = snapshot.references(uri, name, true);
	for (let i = 0; i < 3; i++) snapshot.signatureHelp(uri, position);
	assert.deepEqual(snapshot.references(uri, name, true), before);
	assert.equal(before.length, 2);
});

test("completion recovers earlier unfinished statements without leaking out-of-scope names", async (t) => {
	const { items } = await assist(
		t,
		'fn broken()->void { missing.; } fn f()->void {let username:string="Alice"; username. ; user§ }',
	);
	assert.deepEqual(
		items.map((i) => i.label),
		["username"],
	);
});

test("completion avoids strings and nested/line comments", async (t) => {
	for (const suffix of [
		'"hello §',
		"// hello §",
		"/* outer /* inner */ hello §",
	]) {
		assert.deepEqual(
			(await assist(t, "fn f()->void { " + suffix)).items,
			[],
		);
	}
});

test("signature help identifies the active parameter in incomplete calls", async (t) => {
	const { help, snapshot } = await assist(
		t,
		"fn add(a:int32,b:int32)->int32{return a+b;} fn f()->int32 { return add(1, §); }",
	);
	assert.equal(
		help!.signatures[0]!.label,
		"add(a: int32, b: int32) -> int32",
	);
	assert.equal(help!.activeParameter, 1);
	assert.match(snapshot.diagnostics[0]!.message, /Expected 2 arguments/);
});

test("extra value arguments keep diagnostics and do not highlight a nonexistent parameter", async (t) => {
	const { help, snapshot } = await assist(
		t,
		"fn add(a:int32,b:int32)->int32{return a+b;} fn f()->int32{return add(1,2,§3);}",
	);
	assert.equal(help, undefined);
	assert.match(snapshot.diagnostics[0]!.message, /Expected 2 arguments/);
});

test("generic signature help instantiates explicit primitive, union and nested type arguments", async (t) => {
	for (const type of ["string", "int32 | string", "Box<int32>"]) {
		const { help } = await assist(
			t,
			`type Box<T>=struct{value:T;}; fn identity<T>(value:T)->T{return value;} fn f()->void { identity<${type}>(§`,
		);
		assert.ok(help);
		assert.match(
			help.signatures[0]!.label,
			type === "Box<int32>"
				? /value: struct \{ value: int32;/
				: new RegExp(`value: ${type.replaceAll("|", "\\|")}`),
		);
		assert.equal(help.activeParameter, 0);
	}
});

test("signature help ignores commas in strings, nested calls, struct literals and generic type lists", async (t) => {
	const base =
		"type Pair<T,U>=struct{a:T;b:U;}; fn select<T,U>(a:T,b:U)->U{return b;} fn add(a:int32,b:int32)->int32{return a+b;} fn f()->void {";
	for (const call of [
		'add(select<string,int32>("(,)", 1), §',
		"add(Pair<int32,int32>{a:1,b:2}.a, §",
		"add(1 < 2, §",
	]) {
		const { help } = await assist(t, base + call);
		assert.equal(help!.activeParameter, 1);
		assert.match(help!.signatures[0]!.label, /^add\(/);
	}
	const inner = await assist(t, base + 'add(1, select<string,int32>("a", §');
	assert.match(inner.help!.signatures[0]!.label, /^select<string, int32>/);
	assert.equal(inner.help!.activeParameter, 1);
});

test("signature help honors module visibility, shadowing and explicit type arity diagnostics", async (t) => {
	const files = {
		"helper.noma":
			"pub fn id<T>(v:T)->T{return v;} fn secret(x:int32)->void{}",
	};
	assert.match(
		(
			await assist(
				t,
				'use "helper" as h; fn f()->void{h.id<string>(§',
				files,
			)
		).help!.signatures[0]!.label,
		/^h.id<string>/,
	);
	assert.equal(
		(await assist(t, 'use "helper" as h; fn f()->void{h.secret(§', files))
			.help,
		undefined,
	);
	assert.equal(
		(
			await assist(
				t,
				'use "helper" as h; fn f()->void{let h:int32=1;h.id<string>(§',
				files,
			)
		).help,
		undefined,
	);
	const wrong = await assist(
		t,
		"fn id<T>(v:T)->T{return v;} fn f()->void{id<int32,string>(§); }",
	);
	assert.equal(wrong.help, undefined);
	assert.match(
		wrong.snapshot.diagnostics[0]!.message,
		/explicit type arguments/,
	);
});

test("completion uses current document after edits and close discards recovered semantics", async (t) => {
	const { workspace, uri, position, items } = await assist(
		t,
		"type Box<T>=struct{value:T;}; fn f()->void{let b:Box<int32>=Box<int32>{value:1};b.§}",
	);
	assert.match(items[0]!.detail, /int32/);
	const changed =
		'type Box<T>=struct{value:T;}; fn f()->void{let b:Box<string>=Box<string>{value:"x"};b.}';
	workspace.updateDocument({ uri, version: 2, text: changed });
	assert.equal(workspace.getSnapshot(uri), undefined);
	const snapshot = (await workspace.analyze(uri))!;
	const point = new SourceText("", changed).positionAt(
		changed.lastIndexOf(".") + 1,
	);
	assert.match(snapshot.completionItems(uri, point)[0]!.detail, /string/);
	workspace.closeDocument(uri);
	assert.equal(workspace.getSnapshot(uri), undefined);
});

test("recovered editor ASTs and partial check results cannot be executed", async (t) => {
	const file = await fixture(
		t,
		"pub fn main()->int32 { broken.; return 0; }",
	);
	const program = await loadProgram(file, { editorRecovery: true });
	assert.throws(() => checkProgram(program), /cannot be compiled/);
	const checked = checkProgram(program, { editorRecovery: true });
	assert.throws(
		() => new Interpreter(checked, new NativeRegistry()),
		/cannot be executed/,
	);
});
