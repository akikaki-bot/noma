import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
	analyzeFile,
	AnalysisSnapshot,
	AnalysisWorkspace,
	compile,
	loadProgram,
	SourceText,
	lex,
	parse,
} from "../src/index.js";
import type { SourceFileSystem } from "../src/index.js";
import { fixture } from "./helpers.js";

const uri = (file: string): string => pathToFileURL(file).href;
const position = (text: string, search: string, delta = 0) =>
	new SourceText("", text).positionAt(text.indexOf(search) + delta);

test("UTF-16 positions round trip CRLF, standalone CR, emoji and EOF", () => {
	const source = new SourceText("file", "🌱x\r\ny\rz\n");
	assert.deepEqual(source.positionAt(2), { line: 0, character: 2 });
	assert.deepEqual(source.positionAt(5), { line: 1, character: 0 });
	assert.deepEqual(source.positionAt(7), { line: 2, character: 0 });
	assert.deepEqual(source.positionAt(9), { line: 3, character: 0 });
	assert.equal(source.offsetAt({ line: 0, character: 200 }), 3);
	assert.equal(source.offsetAt({ line: 100, character: 0 }), 9);
	for (const offset of [0, 1, 2, 3, 5, 6, 7, 8, 9])
		assert.equal(source.offsetAt(source.positionAt(offset)), offset);
	const token = lex('"🌱"\r\nname\rother').filter(
		(token) => token.kind === "identifier",
	);
	assert.deepEqual(
		token.map((token) => [token.span.line, token.span.column]),
		[
			[2, 1],
			[3, 1],
		],
	);
});
test("tokens and AST names have precise half-open ranges including pub and qualified types", () => {
	const text = "pub fn answer(value: io.EOF) -> int32 { return 42; }";
	const ast = parse(text, "sample.noma"),
		fn = ast.declarations[0]!;
	assert.equal(text.slice(fn.nameRange!.start, fn.nameRange!.end), "answer");
	assert.equal(text.slice(fn.range!.start, fn.range!.end), text);
	if (fn.kind !== "function") return assert.fail();
	const type = fn.params[0]!.type;
	assert.equal(text.slice(type.nameRange!.start, type.nameRange!.end), "EOF");
	assert.equal(
		text.slice(type.qualifierRange!.start, type.qualifierRange!.end),
		"io",
	);
	assert.equal(
		text.slice(fn.body!.range!.start, fn.body!.range!.end),
		"{ return 42; }",
	);
});
test("library analysis is explicit and CLI compile still requires main", async (t) => {
	const file = await fixture(t, "pub fn answer() -> int32 { return 42; }");
	assert.equal((await analyzeFile(file)).status, "success");
	assert.equal(
		(await analyzeFile(file, { requireEntryPoint: true })).status,
		"error",
	);
	await assert.rejects(compile(file), /Entry point/);
});
test("analysis returns syntax/type/mut diagnostics without executing source effects", async (t) => {
	const file = await fixture(
		t,
		'use "std/io" as io; fn main() -> void { io.puts("never runs"); }',
	);
	const overlay = new Map([
		[file, "fn main() -> void { let x: string = 42; }"],
	]);
	const type = await analyzeFile(file, { sources: overlay });
	assert.equal(type.status, "error");
	assert.equal(type.checked, undefined);
	assert.equal(type.diagnostics[0]!.code, "type");
	assert.deepEqual(type.diagnostics[0]!.range, {
		start: { line: 0, character: 36 },
		end: { line: 0, character: 38 },
	});
	const syntax = await analyzeFile(file, {
		sources: new Map([[file, "fn main() -> void { let x: int32 ="]]),
	});
	assert.equal(syntax.diagnostics[0]!.code, "syntax");
	assert.deepEqual(
		syntax.diagnostics[0]!.range.start,
		syntax.diagnostics[0]!.range.end,
	);
	const mut = await analyzeFile(file, {
		sources: new Map([
			[
				file,
				"fn main() -> void { let mut x: int32 = 1; let y: int32 = x; }",
			],
		]),
	});
	assert.match(mut.diagnostics[0]!.message, /requires snapshot/);
	const snapshot = new AnalysisSnapshot(uri(file), 1, type);
	assert.equal(
		snapshot.hover(uri(file), { line: 0, character: 35 }),
		undefined,
	);
	assert.deepEqual(
		snapshot.completions(uri(file), { line: 0, character: 35 }),
		[],
	);
});
test("syntax diagnostics use UTF-16 columns after emoji and CRLF", async (t) => {
	const file = await fixture(t, "fn main() -> void {}");
	const text =
		'fn main() -> void {\r\n\tlet text: string = "🌱"; let n: int32 = "bad";\r\n}';
	const result = await analyzeFile(file, {
		sources: new Map([[file, text]]),
	});
	assert.equal(result.diagnostics[0]!.code, "type");
	assert.deepEqual(
		result.diagnostics[0]!.range.start,
		position(text, '"bad"'),
	);
	assert.deepEqual(
		result.diagnostics[0]!.range.end,
		position(text, '"bad"', 5),
	);
});
test("new unsaved entry and dependency load from overlays without disk writes", async (t) => {
	const existing = await fixture(t, "fn main() -> void {}"),
		root = path.dirname(existing);
	const entry = path.join(root, "new.noma"),
		helper = path.join(root, "helper.noma");
	const reads: string[] = [];
	const result = await analyzeFile(entry, {
		sources: new Map([
			[
				entry,
				'use "./helper" as h; pub fn answer() -> int32 { return h.answer(); }',
			],
			[helper, "pub fn answer() -> int32 { return 42; }"],
		]),
		fileSystem: {
			realpath,
			async readFile(file) {
				reads.push(file);
				return readFile(file, "utf8");
			},
		},
	});
	assert.equal(result.status, "success");
	assert.deepEqual(reads, []);
	assert.equal(result.program!.modules.length, 2);
});
test("read/realpath and stdlib root are injectable without dist path assumptions", async (t) => {
	const file = await fixture(t, 'use "std/io" as io; fn main() -> void {}'),
		reads: string[] = [];
	const result = await analyzeFile(file, {
		stdlibRoot: path.resolve("stdlib"),
		fileSystem: {
			realpath,
			async readFile(file) {
				reads.push(file);
				return readFile(file, "utf8");
			},
		},
	});
	assert.equal(result.status, "success");
	assert.equal(reads.length, 3);
	assert.equal(
		result.program!.modules.filter((module) => module.trusted).length,
		2,
	);
});
test("overlayed trusted modules cannot grant native or compilerOnly privileges", async (t) => {
	const file = await fixture(t, 'use "std/io" as io; fn main() -> void {}');
	const internal = path.resolve("stdlib/std/internal/io.noma");
	const result = await analyzeFile(file, {
		sources: new Map([[internal, "compilerOnly type TSAny = intrinsic;"]]),
	});
	assert.equal(result.status, "error");
	assert.match(result.diagnostics[0]!.message, /cannot replace trusted/);
	const standalone = await analyzeFile(internal, {
		sources: new Map([[internal, "compilerOnly type TSAny = intrinsic;"]]),
	});
	assert.match(standalone.diagnostics[0]!.message, /reserved/);
});
test("missing files are diagnostics but compiler/host programming errors propagate", async (t) => {
	const file = await fixture(t, 'use "missing" as m;');
	const result = await analyzeFile(file);
	assert.equal(result.diagnostics[0]!.code, "resolve");
	const missing = await analyzeFile(
		path.join(path.dirname(file), "missing.noma"),
	);
	assert.equal(missing.diagnostics[0]!.code, "io");
	await assert.rejects(
		analyzeFile(file, {
			onSource() {
				throw new Error("host bug");
			},
		}),
		/host bug/,
	);
});
test("scope-aware definition/reference queries distinguish shadowing and declaration order", async (t) => {
	const text = `pub fn answer(x: int32) -> int32 {
		let a: int32 = x;
		{ let x: string = "inner"; let text: string = x; };
		let later: int32 = a;
		return x;
	}`;
	const file = await fixture(t, text),
		result = await analyzeFile(file),
		snapshot = new AnalysisSnapshot(uri(file), 1, result);
	assert.equal(result.status, "success");
	const innerPosition = position(text, "string = x", 9),
		outerPosition = position(text, "return x", 7);
	assert.deepEqual(
		snapshot.definition(uri(file), innerPosition)!.range.start,
		position(text, "x: string"),
	);
	assert.deepEqual(
		snapshot.definition(uri(file), outerPosition)!.range.start,
		position(text, "x: int32"),
	);
	assert.equal(snapshot.references(uri(file), outerPosition).length, 2);
	assert.equal(snapshot.references(uri(file), innerPosition).length, 1);
	assert.equal(snapshot.references(uri(file), outerPosition, true).length, 3);
	const inner = snapshot.completions(uri(file), innerPosition);
	assert.equal(inner.find((item) => item.label === "x")!.detail, "x: string");
	assert.equal(
		inner.some((item) => item.label === "later"),
		false,
	);
	assert.equal(
		snapshot.hover(uri(file), outerPosition)!.contents,
		"x: int32",
	);
});
test("imports, functions and qualified type references resolve across files and obey pub", async (t) => {
	const text =
		'use "helper" as h; pub fn call() -> h.Number { return h.answer(); }';
	const file = await fixture(t, text, {
		"helper.noma":
			"pub type Number = int32; type Secret = bool; pub fn answer() -> Number { return 42; } fn hidden() -> void {}",
	});
	const result = await analyzeFile(file),
		snapshot = new AnalysisSnapshot(uri(file), 1, result);
	assert.equal(result.status, "success");
	const members = snapshot.completions(
		uri(file),
		position(text, "return"),
		"h",
	);
	assert.deepEqual(members.map((item) => item.label).sort(), [
		"Number",
		"answer",
	]);
	const target = snapshot.definition(
		uri(file),
		position(text, "h.answer", 2),
	)!;
	assert.equal(target.uri, uri(path.join(path.dirname(file), "helper.noma")));
	assert.equal(snapshot.references(target.uri, target.range.start).length, 1);
	assert.match(
		snapshot.hover(uri(file), position(text, "h.answer", 2))!.contents,
		/fn answer/,
	);
	assert.equal(
		snapshot.references(uri(file), position(text, "as h", 3)).length,
		2,
	);
	assert.equal(
		snapshot.definition(uri(file), position(text, "h.Number", 2))!.uri,
		target.uri,
	);
});
test("case and handler bindings have their own scopes and definitions", async (t) => {
	const text = `use "std/io" as io;
		pub fn classify(value: int32 | string) -> int32 {
			return match(value) { case(n: int32) { n + 1 } case(s: string) { 0 } };
		}
		pub fn output() -> void {
			io.puts("test") otherwise error { let message: string = error.message; void };
		}`;
	const file = await fixture(t, text),
		result = await analyzeFile(file),
		snapshot = new AnalysisSnapshot(uri(file), 1, result);
	assert.equal(result.status, "success");
	assert.deepEqual(
		snapshot.definition(uri(file), position(text, "n + 1"))!.range.start,
		position(text, "n: int32"),
	);
	assert.deepEqual(
		snapshot.definition(uri(file), position(text, "error.message"))!.range
			.start,
		position(text, "otherwise error", 10),
	);
	assert.equal(
		snapshot
			.completions(uri(file), position(text, "case(s"), "io")
			.some((item) => item.label === "TSAny"),
		false,
	);
	assert.equal(
		snapshot
			.completions(uri(file), position(text, "case(s"))
			.some((item) => item.label === "n"),
		false,
	);
	assert.equal(
		snapshot
			.completions(uri(file), position(text, "n + 1"))
			.find((item) => item.label === "value")!.detail,
		"value: int32",
	);
});
test("workspace fixes clear diagnostics and invalidate old semantic snapshots", async (t) => {
	const file = await fixture(t, "pub fn answer() -> int32 { return 1; }"),
		workspace = new AnalysisWorkspace();
	workspace.updateDocument({
		uri: uri(file),
		text: 'pub fn answer() -> int32 { return "bad"; }',
		version: 1,
	});
	const bad = await workspace.analyze(uri(file));
	assert.equal(bad!.diagnostics.length, 1);
	const change = workspace.updateDocument({
		uri: uri(file),
		text: "pub fn answer() -> int32 { return 2; }",
		version: 2,
	});
	assert.ok(change.clearDiagnosticsUris.includes(uri(file)));
	assert.equal(workspace.getSnapshot(uri(file)), undefined);
	const good = await workspace.analyze(uri(file));
	assert.deepEqual(good!.diagnostics, []);
	assert.equal(good!.version, 2);
	assert.throws(
		() =>
			workspace.updateDocument({ uri: uri(file), text: "", version: 2 }),
		/versions must increase/,
	);
	const closed = workspace.closeDocument(uri(file));
	assert.ok(closed.clearDiagnosticsUris.includes(uri(file)));
	assert.equal(await workspace.analyze(uri(file)), undefined);
});
test("unsaved dependencies reanalyze; close restores disk source and file events invalidate", async (t) => {
	const text =
		'use "helper" as h; pub fn answer() -> int32 { return h.answer(); }';
	const file = await fixture(t, text, {
			"helper.noma": "pub fn answer() -> int32 { return 1; }",
		}),
		helper = path.join(path.dirname(file), "helper.noma");
	const workspace = new AnalysisWorkspace();
	workspace.updateDocument({ uri: uri(file), text, version: 1 });
	workspace.updateDocument({
		uri: uri(helper),
		text: 'pub fn answer() -> string { return "bad"; }',
		version: 1,
	});
	assert.equal((await workspace.analyze(uri(file)))!.result.status, "error");
	const closed = workspace.closeDocument(uri(helper));
	assert.ok(closed.reanalyzeUris.includes(uri(file)));
	assert.equal(
		(await workspace.analyze(uri(file)))!.result.status,
		"success",
	);
	const changed = workspace.invalidate();
	assert.ok(changed.reanalyzeUris.includes(uri(file)));
	assert.equal(workspace.getSnapshot(uri(file)), undefined);
});
test("untitled documents preserve URI and version without touching disk", async (t) => {
	const file = await fixture(t, "fn main() -> void {}"),
		workspace = new AnalysisWorkspace({ projectRoot: path.dirname(file) });
	const documentUri = "untitled:Noma-1",
		text = "pub fn answer(x: int32) -> int32 { return x; }";
	workspace.updateDocument({ uri: documentUri, version: 5, text });
	const snapshot = await workspace.analyze(documentUri);
	assert.equal(snapshot!.result.status, "success");
	assert.equal(
		snapshot!.definition(documentUri, position(text, "return x", 7))!.uri,
		documentUri,
	);
	workspace.updateDocument({
		uri: documentUri,
		version: 6,
		text: 'pub fn answer() -> int32 { return "bad"; }',
	});
	assert.equal(
		(await workspace.analyze(documentUri))!.diagnostics[0]!.uri,
		documentUri,
	);
});
test("concurrent document updates and close discard old async analysis results", async (t) => {
	const text =
		'use "helper" as h; pub fn answer() -> int32 { return h.answer(); }';
	const file = await fixture(t, text, {
		"helper.noma": "pub fn answer() -> int32 { return 1; }",
	});
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
			release = resolve;
		}),
		ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
	const fs: SourceFileSystem = {
		realpath,
		async readFile(file) {
			entered();
			await gate;
			return readFile(file, "utf8");
		},
	};
	const workspace = new AnalysisWorkspace({ fileSystem: fs });
	workspace.updateDocument({ uri: uri(file), text, version: 1 });
	const pending = workspace.analyze(uri(file));
	await ready;
	workspace.updateDocument({
		uri: uri(file),
		text: "pub fn answer() -> int32 { return 2; }",
		version: 2,
	});
	release();
	assert.equal(await pending, undefined);
	assert.equal(workspace.getSnapshot(uri(file)), undefined);
	assert.equal((await workspace.analyze(uri(file)))!.version, 2);
	const afterClose = workspace.analyze(uri(file));
	workspace.closeDocument(uri(file));
	assert.equal(await afterClose, undefined);
});
test("structural field definition is deliberately unspecified", async (t) => {
	const text =
		"pub fn f(x: struct { field: int32; }) -> int32 { return x.field + 1; }";
	const file = await fixture(t, text),
		snapshot = new AnalysisSnapshot(uri(file), 1, await analyzeFile(file));
	assert.equal(
		snapshot.definition(uri(file), position(text, "x.field", 2)),
		undefined,
	);
	assert.equal(
		snapshot.hover(uri(file), position(text, "x.field", 2))!.contents,
		"int32",
	);
});
test("completion at EOF includes module names; narrowed mutable bindings are readonly", async (t) => {
	const text =
		"pub fn f(mut value: int32 | string) -> int32 { return match(value) { case(n: int32) { value + 1 } case(s: string) { 0 } }; }";
	const file = await fixture(t, text),
		snapshot = new AnalysisSnapshot(uri(file), 1, await analyzeFile(file));
	assert.ok(
		snapshot
			.completions(
				uri(file),
				new SourceText(file, text).positionAt(text.length),
			)
			.some((item) => item.label === "f"),
	);
	const at = position(text, "value + 1");
	assert.equal(snapshot.hover(uri(file), at)!.contents, "value: int32");
	assert.equal(
		snapshot
			.completions(uri(file), at)
			.find((item) => item.label === "value")!.mutable,
		false,
	);
});
test("local values shadow import aliases for module-member completion", async (t) => {
	const text =
		'use "helper" as h; pub fn f() -> int32 { let h: int32 = 1; return h + 1; }';
	const file = await fixture(t, text, {
		"helper.noma": "pub fn answer() -> int32 { return 42; }",
	});
	const snapshot = new AnalysisSnapshot(
		uri(file),
		1,
		await analyzeFile(file),
	);
	assert.deepEqual(
		snapshot.completions(uri(file), position(text, "return"), "h"),
		[],
	);
	assert.deepEqual(
		snapshot.definition(uri(file), position(text, "return h", 7))!.range
			.start,
		position(text, "h: int32"),
	);
});
test("same-named definitions in different modules have distinct reference identities", async (t) => {
	const text =
		'use "first" as a; use "second" as b; pub fn f() -> int32 { return a.answer() + b.answer(); }';
	const file = await fixture(t, text, {
		"first.noma": "pub fn answer() -> int32 { return 1; }",
		"second.noma": "pub fn answer() -> int32 { return 2; }",
	});
	const snapshot = new AnalysisSnapshot(
		uri(file),
		1,
		await analyzeFile(file),
	);
	const a = snapshot.definition(uri(file), position(text, "a.answer", 2))!,
		b = snapshot.definition(uri(file), position(text, "b.answer", 2))!;
	assert.notEqual(a.uri, b.uri);
	assert.equal(snapshot.references(a.uri, a.range.start).length, 1);
	assert.equal(snapshot.references(b.uri, b.range.start).length, 1);
});
test("deleted and renamed dependencies invalidate earlier definitions", async (t) => {
	const { rename, unlink } = await import("node:fs/promises");
	const text =
		'use "helper" as h; pub fn f() -> int32 { return h.answer(); }';
	const file = await fixture(t, text, {
		"helper.noma": "pub fn answer() -> int32 { return 1; }",
	});
	const root = path.dirname(file),
		workspace = new AnalysisWorkspace();
	workspace.updateDocument({ uri: uri(file), version: 1, text });
	assert.equal(
		(await workspace.analyze(uri(file)))!.result.status,
		"success",
	);
	await rename(
		path.join(root, "helper.noma"),
		path.join(root, "renamed.noma"),
	);
	workspace.invalidate();
	assert.equal((await workspace.analyze(uri(file)))!.result.status, "error");
	workspace.updateDocument({
		uri: uri(file),
		version: 2,
		text: text.replace('"helper"', '"renamed"'),
	});
	assert.equal(
		(await workspace.analyze(uri(file)))!.result.status,
		"success",
	);
	await unlink(path.join(root, "renamed.noma"));
	workspace.invalidate();
	const deleted = (await workspace.analyze(uri(file)))!;
	assert.equal(deleted.result.status, "error");
	assert.equal(
		deleted.definition(uri(file), position(text, "h.answer", 2)),
		undefined,
	);
});
test("in-memory filesystem supports an explicitly configured bundled stdlib", async () => {
	const root = path.resolve("virtual-noma-project"),
		std = path.join(root, "bundled"),
		entry = path.join(root, "main.noma");
	const files = new Map([
		[
			entry,
			'use "std/math" as math; pub fn f() -> int32 { return math.one(); }',
		],
		[
			path.join(std, "std/math.noma"),
			"pub fn one() -> int32 { return 1; }",
		],
	]);
	const directories = new Set<string>();
	for (const file of files.keys()) {
		let folder = path.dirname(file);
		while (true) {
			directories.add(folder);
			const parent = path.dirname(folder);
			if (folder === parent) break;
			folder = parent;
		}
	}
	const fs: SourceFileSystem = {
		async realpath(file) {
			if (files.has(file) || directories.has(file)) return file;
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		},
		async readFile(file) {
			const text = files.get(file);
			if (text === undefined)
				throw Object.assign(new Error("missing"), {
					code: "ENOENT",
					path: file,
				});
			return text;
		},
	};
	const result = await analyzeFile(entry, {
		fileSystem: fs,
		stdlibRoot: std,
	});
	assert.equal(result.status, "success");
	assert.equal(
		result.program!.modules.find((module) => module.id === "std/math")!
			.trusted,
		true,
	);
});
test("new overlays beneath symlink ancestors cannot escape the project root", async (t) => {
	const file = await fixture(t, 'use "link/new" as escaped;'),
		root = path.dirname(file),
		outside = path.join(path.dirname(root), "outside-package");
	const link = path.join(root, "link"),
		overlay = path.join(link, "new.noma");
	const fs: SourceFileSystem = {
		async realpath(file) {
			if (file === link) return outside;
			if (file === overlay || file === path.join(outside, "new.noma"))
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return realpath(file);
		},
		readFile: (file) => readFile(file, "utf8"),
	};
	const result = await analyzeFile(file, {
		fileSystem: fs,
		sources: new Map([[overlay, "pub fn f() -> void {}"]]),
	});
	assert.equal(result.status, "error");
	assert.match(result.diagnostics[0]!.message, /escapes its package root/);
});
