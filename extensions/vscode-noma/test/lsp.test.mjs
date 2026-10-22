import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdtemp,
	readFile,
	writeFile,
	rm,
	rename,
	mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import lsp from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const extension = new URL("../", import.meta.url);
const server = fileURLToPath(new URL("dist/server.cjs", extension));
const uri = (file) => pathToFileURL(file).href;
const position = (text, search, delta = 0) =>
	TextDocument.create("", "noma", 1, text).positionAt(
		text.indexOf(search) + delta,
	);
function timeout(promise, ms = 8000) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Timed out waiting for LSP")),
				ms,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

async function start(
	t,
	files = {},
	extraFolders = [],
	capabilities = {
		general: { positionEncodings: ["utf-16"] },
		workspace: { workspaceFolders: true },
	},
) {
	const directory = await mkdtemp(path.join(tmpdir(), "noma-lsp-"));
	for (const [name, text] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(directory, name)), {
			recursive: true,
		});
		await writeFile(path.join(directory, name), text);
	}
	// Run outside the repository: stdlib and compiler must come from the server bundle.
	const child = spawn(process.execPath, [server, "--stdio"], {
		cwd: directory,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (value) => {
		stderr += value;
	});
	const connection = lsp.createMessageConnection(
		new lsp.StreamMessageReader(child.stdout),
		new lsp.StreamMessageWriter(child.stdin),
	);
	const notifications = [],
		logs = [],
		waiters = new Set();
	connection.onNotification("textDocument/publishDiagnostics", (value) => {
		notifications.push(value);
		for (const notify of waiters) notify();
	});
	connection.onNotification("window/logMessage", (value) => logs.push(value));
	connection.onRequest("client/registerCapability", () => null);
	connection.listen();
	t.after(async () => {
		try {
			if (child.exitCode === null) {
				await timeout(connection.sendRequest("shutdown"), 2000);
				await connection.sendNotification("exit");
				await timeout(
					new Promise((resolve) => {
						if (child.exitCode !== null) resolve();
						else child.once("exit", resolve);
					}),
					2000,
				);
			}
		} finally {
			if (child.exitCode === null) child.kill();
			connection.dispose();
			assert.equal(
				path.dirname(path.resolve(directory)),
				path.resolve(tmpdir()),
			);
			assert.ok(path.basename(directory).startsWith("noma-lsp-"));
			await rm(directory, { recursive: true, force: true });
		}
		assert.equal(stderr, "", stderr);
		assert.deepEqual(
			logs.filter((value) => value.type === 1),
			[],
		);
	});
	const initialization = await timeout(
		connection.sendRequest("initialize", {
			processId: null,
			rootUri: uri(directory),
			workspaceFolders: [
				{ uri: uri(directory), name: "test" },
				...extraFolders,
			],
			capabilities,
		}),
	);
	await connection.sendNotification("initialized", {});
	const opened = new Map();
	return {
		directory,
		initialization,
		connection,
		notifications,
		file: (name) => uri(path.join(directory, name)),
		async open(name, text, version = 1) {
			const target = name.includes(":")
				? name
				: uri(path.join(directory, name));
			opened.set(target, { version, text });
			await connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri: target,
					languageId: "noma",
					version,
					text,
				},
			});
			return target;
		},
		async change(target, text, changes) {
			const version = opened.get(target).version + 1;
			opened.set(target, { text, version });
			await connection.sendNotification("textDocument/didChange", {
				textDocument: { uri: target, version },
				contentChanges: changes ?? [{ text }],
			});
			return version;
		},
		async close(target) {
			opened.delete(target);
			await connection.sendNotification("textDocument/didClose", {
				textDocument: { uri: target },
			});
		},
		request(method, target, point, extra = {}) {
			return timeout(
				connection.sendRequest(`textDocument/${method}`, {
					textDocument: { uri: target },
					position: point,
					...extra,
				}),
			);
		},
		async diagnostics(target, predicate, after = 0) {
			let notify;
			const result = new Promise((resolve) => {
				notify = () => {
					const found = notifications
						.slice(after)
						.find((item) => item.uri === target && predicate(item));
					if (found) resolve(found);
				};
				waiters.add(notify);
				notify();
			});
			try {
				return await timeout(result);
			} finally {
				waiters.delete(notify);
			}
		},
	};
}

test("JSON-RPC preserves numeric diagnostics, uint64 hover and all concrete numeric completions", async (t) => {
	const host = await start(t);
	const text =
		"fn identity<T>(x:T)->T{return x;} fn f()->void{let maximum:uint64=identity<uint64>(18446744073709551615);}";
	const target = await host.open("numeric.noma", text);
	await host.diagnostics(
		target,
		(d) => d.version === 1 && d.diagnostics.length === 0,
	);
	const hover = await host.request(
		"hover",
		target,
		position(text, "maximum"),
	);
	assert.match(hover.contents.value, /uint64/);
	const items = await host.request(
		"completion",
		target,
		position(text, "let maximum"),
	);
	for (const name of [
		"int8",
		"int16",
		"int32",
		"int64",
		"uint8",
		"uint16",
		"uint32",
		"uint64",
		"float32",
		"float64",
	])
		assert.ok(
			items.some((item) => item.label === name),
			name,
		);
	let version = 1;
	for (const [source, message] of [
		["fn f()->void{let n:uint8=256;}", /uint8 range/],
		["fn f()->void{let n:uint64=-1;}", /range|overflow/],
		["fn f()->void{let n:uint8=255+1;}", /overflow/],
		[
			"fn f()->void{let a:uint8=1;let b:uint16=2;a+b;}",
			/Expected|matching/,
		],
		[
			"fn f()->void{let n:float64=(float64)(uint64)9007199254740993;}",
			/Lossy/,
		],
	]) {
		version = await host.change(target, source);
		const diagnostic = await host.diagnostics(
			target,
			(d) =>
				d.version === version &&
				message.test(d.diagnostics[0]?.message),
		);
		assert.equal(diagnostic.diagnostics[0].severity, 1);
	}
	version = await host.change(target, text);
	await host.diagnostics(
		target,
		(d) => d.version === version && d.diagnostics.length === 0,
	);
});

test("LSP advertises supported features and uses bundled stdlib without executing Noma", async (t) => {
	const host = await start(t);
	assert.equal(
		host.initialization.serverInfo.version,
		JSON.parse(await readFile(new URL("package.json", extension), "utf8"))
			.version,
	);
	const capabilities = host.initialization.capabilities;
	for (const key of [
		"hoverProvider",
		"definitionProvider",
		"referencesProvider",
	])
		assert.equal(capabilities[key], true);
	assert.equal(capabilities.positionEncoding, "utf-16");
	assert.equal(capabilities.textDocumentSync.change, 2);
	const text =
		'use "std/io" as io; fn main() -> void { while true { io.puts("SHOULD NEVER RUN"); } }';
	const target = await host.open("main.noma", text);
	const hover = await host.request(
		"hover",
		target,
		position(text, "io.puts", 3),
	);
	assert.match(hover.contents.value, /puts.*string/);
	await host.diagnostics(target, (item) => item.diagnostics.length === 0);
	const definition = await host.request(
		"definition",
		target,
		position(text, "io.puts", 3),
	);
	assert.equal(
		definition.uri,
		new URL("dist/stdlib/std/io.noma", extension).href,
	);
	const completions = await host.request(
		"completion",
		target,
		position(text, "io.puts", 4),
	);
	assert.ok(
		completions.some((item) => item.label === "puts" && item.kind === 3),
	);
	assert.ok(
		!completions.some((item) => /TSAny|writeStdout/.test(item.label)),
	);
});

test("JSON-RPC uses new borrowing/array/Future diagnostics on unsaved edits and recovers after fixes", async (t) => {
	const host = await start(t);
	const cases = [
		["fn main()->void{[1,2];}", /expected array type/],
		[
			"fn inspect(a:int32,mut b:int32)->void{} fn main()->void{let mut n:int32=1;inspect(read n,n);}",
			/mutate and read/,
		],
		[
			"fn main()->void{let mut n:int32=1;let retained:int32=read n;}",
			/borrowed value/,
		],
		[
			"async fn task()->int32{return 42;} fn main()->void{let mut pending:Future<int32>=task();}",
			/cannot be mutable/,
		],
		[
			"async fn task()->int32{return 42;} fn main()->void{let pending:Future<int32>=task();snapshot pending;}",
			/non-copyable/,
		],
		[
			"async fn task()->int32{return 42;} fn main()->int32{return await task();}",
			/async function/,
		],
		[
			"async fn task()->int32{return 42;} async fn main()->int32{let pending:Future<int32>=task();if true{await pending;}return await pending;}",
			/consumed or moved/,
		],
	];
	const fixed =
		'use "std/arr" as arr; async fn task()->int32{return 42;} pub async fn main()->int32{let mut values:Array<int32>=[1];let count:int32=arr.length<int32>(read values);return await task();}';
	const target = await host.open("new-diagnostics.noma", fixed);
	await host.diagnostics(
		target,
		(d) => d.version === 1 && d.diagnostics.length === 0,
	);
	let version = 1;
	for (const [text, message] of cases) {
		version = await host.change(target, text);
		const diagnostic = await host.diagnostics(
			target,
			(d) =>
				d.version === version &&
				message.test(d.diagnostics[0]?.message),
		);
		assert.equal(diagnostic.diagnostics[0].severity, 1);
		version = await host.change(target, fixed);
		await host.diagnostics(
			target,
			(d) => d.version === version && d.diagnostics.length === 0,
		);
	}
});

test("JSON-RPC provides array exports, async error result types and definitions/references", async (t) => {
	const host = await start(t);
	const source =
		'use "std/arr" as arr; async fn load()->string|throwable{return "ok";} pub async fn main()->int32{let pending:Future<string|throwable>=load();let text:string=await pending otherwise error{"fallback"};return 0;}';
	const target = await host.open("new-assistance.noma", source);
	await host.diagnostics(
		target,
		(d) => d.version === 1 && d.diagnostics.length === 0,
	);
	const hover = await host.request(
		"hover",
		target,
		position(source, "await pending"),
	);
	assert.equal(hover.contents.value, "string | throwable");
	const pending = await host.request(
		"hover",
		target,
		position(source, "pending:Future"),
	);
	assert.match(pending.contents.value, /Future<string \| throwable>/);
	const call = TextDocument.create("", "noma", 1, source).positionAt(
		source.lastIndexOf("load()"),
	);
	const definition = await host.request("definition", target, call);
	assert.equal(definition.uri, target);
	assert.deepEqual(definition.range.start, position(source, "load()->"));
	const references = await host.request("references", target, call, {
		context: { includeDeclaration: true },
	});
	assert.equal(references.length, 2);
	const help = await host.request(
		"signatureHelp",
		target,
		TextDocument.create("", "noma", 1, source).positionAt(
			source.lastIndexOf("load()") + 5,
		),
	);
	assert.equal(
		help.signatures[0].label,
		"load() -> Future<string | throwable>",
	);
	let text = 'use "std/arr" as arr; fn main()->void{arr. }';
	await host.change(target, text);
	let items = await host.request(
		"completion",
		target,
		position(text, "arr. }", 4),
	);
	assert.deepEqual(items.map((i) => i.label).sort(), [
		"create",
		"get",
		"length",
		"pop",
		"push",
		"remove",
		"set",
	]);
	assert.ok(
		items.every(
			(i) => !i.label.endsWith("Array") && !i.detail.includes("native"),
		),
	);
	text =
		"type Box=struct{length:int32;};fn main()->void{let box:Box=Box{length:2};box. }";
	await host.change(target, text);
	items = await host.request(
		"completion",
		target,
		position(text, "box. }", 4),
	);
	assert.ok(
		items.some((i) => i.label === "length" && i.detail === "length: int32"),
	);
	text = 'use "std/arr" as arr; fn main()->void{arr.get<Array<int32>>(';
	await host.change(target, text);
	const generic = await host.request(
		"signatureHelp",
		target,
		TextDocument.create("", "noma", 1, text).positionAt(text.length),
	);
	assert.equal(
		generic.signatures[0].label,
		"arr.get<(int32)[]>(array: ((int32)[])[], index: int32) -> (int32)[] | throwable",
	);
});

test("syntax, type and mut/snapshot diagnostics update incrementally and clear on fix/close", async (t) => {
	const host = await start(t);
	let text =
		'fn f() -> void {\r\n let s: string = "🌱"; let n: int32 = "bad";\r\n}';
	const target = await host.open("new.noma", text);
	const diagnostic = await host.diagnostics(
		target,
		(item) => item.diagnostics[0]?.code === "type",
	);
	assert.deepEqual(
		diagnostic.diagnostics[0].range.start,
		position(text, '"bad"'),
	);
	assert.equal(diagnostic.version, 1);
	let after = host.notifications.length;
	const badPosition = position(text, '"bad"');
	text = text.replace('"bad"', "1");
	await host.change(target, text, [
		{
			range: {
				start: badPosition,
				end: { ...badPosition, character: badPosition.character + 5 },
			},
			text: "1",
		},
	]);
	await host.request("hover", target, position(text, "n:"));
	await host.diagnostics(
		target,
		(item) => item.version === 2 && item.diagnostics.length === 0,
		after,
	);
	text =
		"fn f() -> void { let mut value: int32 = 1; let saved: int32 = value; }";
	await host.change(target, text);
	await host.diagnostics(
		target,
		(item) =>
			item.version === 3 &&
			/requires snapshot/.test(item.diagnostics[0]?.message),
	);
	assert.equal(
		await host.request("hover", target, position(text, "value")),
		null,
	);
	const recovered = await host.request(
		"completion",
		target,
		position(text, "saved"),
	);
	assert.ok(recovered.some((item) => item.label === "value"));
	assert.ok(!recovered.some((item) => item.label === "saved"));
	text = "fn f() -> void { let n: int32 =";
	await host.change(target, text);
	const syntax = await host.diagnostics(
		target,
		(item) => item.version === 4 && item.diagnostics[0]?.code === "syntax",
	);
	assert.deepEqual(
		syntax.diagnostics[0].range.start,
		syntax.diagnostics[0].range.end,
	);
	after = host.notifications.length;
	await host.close(target);
	await host.diagnostics(
		target,
		(item) => item.diagnostics.length === 0,
		after,
	);
});

test("definitions, hover, completion and references respect scopes and union narrowing", async (t) => {
	const host = await start(t);
	const text = `type Value = int32 | string;
fn f(value: Value) -> int32 {
    let result: int32 = 2;
    { let result: string = "inner"; result; };
    match (value) { case (n: int32) { value + result } case (s: string) { result } };
    return result;
}`;
	const target = await host.open("scopes.noma", text);
	const usage = position(text, "return result", 7);
	const definition = await host.request("definition", target, usage);
	assert.deepEqual(definition.range.start, position(text, "result: int32"));
	const inner = await host.request(
		"definition",
		target,
		position(text, "result; }"),
	);
	assert.deepEqual(inner.range.start, position(text, "result: string"));
	const hover = await host.request(
		"hover",
		target,
		position(text, "value +"),
	);
	assert.equal(hover.contents.kind, "plaintext");
	assert.match(hover.contents.value, /value: int32/);
	const completions = await host.request("completion", target, usage);
	assert.ok(
		completions.some(
			(item) => item.label === "result" && item.detail.includes("int32"),
		),
	);
	const refs = await host.request("references", target, usage, {
		context: { includeDeclaration: false },
	});
	assert.equal(refs.length, 3);
	assert.ok(!refs.some((item) => item.range.start.line === 3));
	const withDeclaration = await host.request("references", target, usage, {
		context: { includeDeclaration: true },
	});
	assert.equal(withDeclaration.length, 4);
});

test("unsaved dependency overlays, public module completion and references from multiple roots", async (t) => {
	const library =
		"pub fn answer() -> int32 { return 1; } fn secret() -> int32 { return 2; }";
	const host = await start(t, { "helper.noma": library });
	const helper = await host.open("helper.noma", library);
	const source =
		'use "helper" as h; pub fn first() -> int32 { return h.answer(); }';
	const first = await host.open("first.noma", source);
	const secondSource = source.replace("first", "second");
	const second = await host.open("second.noma", secondSource);
	const definition = await host.request(
		"definition",
		first,
		position(source, "h.answer", 3),
	);
	assert.equal(definition.uri, helper);
	const refs = await host.request(
		"references",
		helper,
		position(library, "answer"),
		{ context: { includeDeclaration: false } },
	);
	assert.deepEqual(
		new Set(refs.map((value) => value.uri)),
		new Set([first, second]),
	);
	const members = await host.request(
		"completion",
		first,
		position(source, "h.answer", 3),
	);
	assert.deepEqual(
		members.map((item) => item.label),
		["answer"],
	);
	await host.change(
		helper,
		library.replace("-> int32 { return 1", '-> string { return "text"'),
	);
	await host.request("hover", first, position(source, "first"));
	await host.diagnostics(
		helper,
		(item) => item.version === 2 && item.diagnostics.length === 0,
	);
	await host.diagnostics(first, (item) =>
		/Expected int32, got string/.test(item.diagnostics[0]?.message),
	);
	const after = host.notifications.length;
	await host.close(helper);
	await host.request("hover", first, position(source, "first"));
	await host.diagnostics(
		first,
		(item) => item.diagnostics.length === 0,
		after,
	);
});

test("diagnostics from a shared dependency are merged and survive closing one importer", async (t) => {
	const host = await start(t, {
		"broken.noma": "pub fn broken() -> int32 { return false; }",
	});
	const text =
		'use "broken" as b; pub fn f() -> int32 { return b.broken(); }';
	const first = await host.open("first.noma", text);
	const second = await host.open("second.noma", text);
	await host.request("hover", first, position(text, "f()"));
	await host.request("hover", second, position(text, "f()"));
	const broken = host.file("broken.noma");
	const diagnostic = await host.diagnostics(
		broken,
		(item) => item.diagnostics.length > 0,
	);
	assert.equal(diagnostic.diagnostics.length, 1);
	await host.close(first);
	await host.request("hover", second, position(text, "f()"));
	assert.equal(
		host.notifications.filter((item) => item.uri === broken).at(-1)
			.diagnostics.length,
		1,
	);
	const after = host.notifications.length;
	await host.close(second);
	await host.diagnostics(
		broken,
		(item) => item.diagnostics.length === 0,
		after,
	);
});

test("disk create/rename/delete notifications invalidate cached module resolution", async (t) => {
	const host = await start(t);
	const text = 'use "helper" as h; fn f() -> int32 { return h.answer(); }';
	const target = await host.open("main.noma", text);
	await host.diagnostics(
		target,
		(item) => item.diagnostics[0]?.code === "resolve",
	);
	await writeFile(
		path.join(host.directory, "helper.noma"),
		"pub fn answer() -> int32 { return 42; }",
	);
	await host.connection.sendNotification("workspace/didChangeWatchedFiles", {
		changes: [{ uri: host.file("helper.noma"), type: 1 }],
	});
	assert.ok(
		await host.request("definition", target, position(text, "answer")),
	);
	await rename(
		path.join(host.directory, "helper.noma"),
		path.join(host.directory, "renamed.noma"),
	);
	await host.connection.sendNotification("workspace/didChangeWatchedFiles", {
		changes: [
			{ uri: host.file("helper.noma"), type: 3 },
			{ uri: host.file("renamed.noma"), type: 1 },
		],
	});
	assert.equal(
		await host.request("definition", target, position(text, "answer")),
		null,
	);
	await host.diagnostics(
		target,
		(item) => item.diagnostics[0]?.code === "resolve",
	);
});

test("untitled documents preserve URI and rapid changes never restore old semantics", async (t) => {
	const host = await start(t);
	const text = "fn f(value: int32) -> int32 { return value; }";
	const target = await host.open("untitled:Untitled-1", text);
	const definition = await host.request(
		"definition",
		target,
		position(text, "return value", 7),
	);
	assert.equal(definition.uri, target);
	for (let index = 0; index < 10; index++)
		await host.change(target, text.replace("int32", "string"));
	await host.change(target, text);
	const hover = await host.request(
		"hover",
		target,
		position(text, "return value", 7),
	);
	assert.match(hover.contents.value, /int32/);
	const after = host.notifications.length;
	await host.change(target, "fn f(");
	assert.equal(
		await host.request("hover", target, { line: 0, character: 3 }),
		null,
	);
	await host.diagnostics(
		target,
		(item) => item.version === 13 && item.diagnostics[0]?.code === "syntax",
		after,
	);
});

test("multi-folder workspaces isolate package roots and react to folder changes", async (t) => {
	const host = await start(t, {
		"other/helper.noma": 'pub fn answer() -> string { return "other"; }',
	});
	const other = uri(path.join(host.directory, "other"));
	// Removing the outer root makes the nested folder its own package root.
	await host.connection.sendNotification(
		"workspace/didChangeWorkspaceFolders",
		{
			event: {
				removed: [{ uri: uri(host.directory), name: "test" }],
				added: [{ uri: other, name: "other" }],
			},
		},
	);
	const text = 'use "helper" as h; fn f() -> string { return h.answer(); }';
	const target = await host.open("other/main.noma", text);
	const hover = await host.request("hover", target, position(text, "answer"));
	assert.match(hover.contents.value, /string/);
});

test("clients without workspace-folder capability can still initialize and query", async (t) => {
	const host = await start(t, {}, [], {});
	assert.equal(host.initialization.capabilities.workspace, undefined);
	const text = "fn identity(value: int32) -> int32 { return value; }";
	const target = await host.open("library.noma", text);
	assert.ok(
		await host.request(
			"definition",
			target,
			position(text, "return value", 7),
		),
	);
});

test("build separates compiler and transport and bundles only the analysis dependency graph", async () => {
	const [client, serverMeta] = JSON.parse(
		await readFile(new URL("dist/build-meta.json", extension), "utf8"),
	);
	assert.ok(
		Object.keys(client.inputs).some((file) =>
			file.endsWith("src/client/extension.ts"),
		),
	);
	assert.ok(
		Object.keys(serverMeta.inputs).some((file) =>
			file.endsWith("src/server/service.ts"),
		),
	);
	assert.ok(
		Object.keys(serverMeta.inputs).some((file) =>
			file.endsWith("src/workspace.ts"),
		),
	);
	assert.ok(
		!Object.keys(serverMeta.inputs).some((file) =>
			/src\/(?:native|interpreter|values|index)\.ts$/.test(file),
		),
	);
	assert.ok(
		(
			await readFile(
				new URL("dist/THIRD_PARTY_NOTICES.txt", extension),
				"utf8",
			)
		).includes("vscode-jsonrpc"),
	);
});
test("v0.0.2 typing API exposes type references and rejects mutable inputs through LSP", async (t) => {
	const host = await start(t);
	const text = `use "std/typing" as typing;
type Animal = struct { name: string; };
type Dog = struct { name: string; breed: string; };
fn fail() -> int32 | throwable { raise "bad"; }
fn f() -> void {
    let mut dog: Dog = Dog { name: "P", breed: "S" };
    let a: Animal = (Animal)(snapshot dog);
    let b: Animal = typing.trycast(Animal, a) catch e { return; };
}`;
	const target = await host.open("typing.noma", text);
	await host.diagnostics(target, (item) => item.diagnostics.length === 0);
	for (const search of ["(Animal)(", "(Animal, a)"]) {
		const definition = await host.request(
			"definition",
			target,
			position(text, search, 1),
		);
		assert.equal(definition.uri, target);
		assert.deepEqual(definition.range.start, position(text, "Animal ="));
	}
	const hover = await host.request(
		"hover",
		target,
		position(text, "typing.trycast", 7),
	);
	assert.match(hover.contents.value, /T \| throwable/);
	const members = await host.request(
		"completion",
		target,
		position(text, "typing.trycast", 7),
	);
	assert.deepEqual(
		members.map((item) => item.label),
		["trycast"],
	);
	const definition = await host.request(
		"definition",
		target,
		position(text, "typing.trycast", 7),
	);
	assert.equal(
		definition.uri,
		new URL("dist/stdlib/std/typing.noma", extension).href,
	);
	const changed = text.replace("trycast(Animal, a)", "trycast(Animal, dog)");
	await host.change(target, changed);
	await host.diagnostics(
		target,
		(item) =>
			item.version === 2 &&
			/requires snapshot/.test(item.diagnostics[0]?.message),
	);
	await host.change(target, text);
	await host.diagnostics(
		target,
		(item) => item.version === 3 && item.diagnostics.length === 0,
	);
});

test("completion and signature capabilities include generic and argument triggers", async (t) => {
	const host = await start(t);
	assert.deepEqual(
		host.initialization.capabilities.completionProvider.triggerCharacters,
		[".", "<"],
	);
	assert.deepEqual(
		host.initialization.capabilities.signatureHelpProvider
			.triggerCharacters,
		["(", ","],
	);
});

test("JSON-RPC completion recovers module members, concrete generic fields and keyword edits", async (t) => {
	const host = await start(t, {
		"helper.noma":
			"pub fn identity<T>(v:T)->T{return v;} pub type Box<T>=struct{value:T;}; fn secret()->void{} type Private=int32;",
	});
	let text = 'use "helper" as h; fn f()->void { h. }';
	const target = await host.open("complete.noma", text);
	let items = await host.request(
		"completion",
		target,
		position(text, "h. }", 2),
	);
	assert.deepEqual(items.map((i) => i.label).sort(), ["Box", "identity"]);
	assert.equal(items.find((i) => i.label === "identity").kind, 3);
	await host.diagnostics(target, (d) => d.diagnostics[0]?.code === "syntax");
	text =
		"type Box<T>=struct{value:T;}; fn f()->void {let b:Box<int32>=Box<int32>{value:1}; b. }";
	await host.change(target, text);
	const point = position(text, "b. }", 2);
	items = await host.request("completion", target, point);
	assert.deepEqual(
		items.map((i) => i.label),
		["value"],
	);
	assert.equal(items[0].kind, 5);
	assert.equal(items[0].detail, "value: int32");
	assert.deepEqual(items[0].textEdit, {
		newText: "value",
		range: { start: point, end: point },
	});
	text = 'fn f()->void { let text:string="🌱"; ret }';
	await host.change(target, text);
	items = await host.request(
		"completion",
		target,
		position(text, "ret }", 3),
	);
	assert.deepEqual(
		items.map((i) => i.label),
		["return"],
	);
	assert.equal(items[0].kind, 14);
	assert.deepEqual(items[0].textEdit.range.start, position(text, "ret }"));
	assert.equal(items[0].insertText, "return");
});

test("JSON-RPC incomplete identifier/type completion respects scopes and shadowing", async (t) => {
	const host = await start(t);
	let text =
		'fn id<T>(v:T)->T{return v;} fn f(arg:bool)->void { let user:string="a"; {let sibling:int32=1;} {let user:int32=1; user } let later:int32=2;}';
	const target = await host.open("scopes-complete.noma", text);
	let items = await host.request(
		"completion",
		target,
		position(text, "user }", 4),
	);
	assert.deepEqual(
		items.map((i) => i.label),
		["user"],
	);
	assert.match(items[0].detail, /int32/);
	text = "fn id<T>(v:T)->T{return v;} fn f<U>(value:U)->void { id<";
	await host.change(target, text);
	items = await host.request(
		"completion",
		target,
		TextDocument.create("", "noma", 1, text).positionAt(
			text.lastIndexOf("id<") + 3,
		),
	);
	assert.ok(items.some((i) => i.label === "U"));
	assert.ok(items.some((i) => i.label === "int32"));
	assert.ok(
		!items.some((i) => ["value", "T", "id", "return"].includes(i.label)),
	);
});

test("JSON-RPC signature help highlights arguments and instantiates generics without clearing diagnostics", async (t) => {
	const host = await start(t);
	let text =
		"fn add(a:int32,b:int32)->int32{return a+b;} fn f()->int32{return add(1, );}";
	const target = await host.open("signature.noma", text);
	let help = await host.request(
		"signatureHelp",
		target,
		position(text, "1, ", 3),
	);
	assert.equal(help.signatures[0].label, "add(a: int32, b: int32) -> int32");
	assert.equal(help.activeParameter, 1);
	assert.deepEqual(
		help.signatures[0].parameters.map((p) => p.label),
		["a: int32", "b: int32"],
	);
	await host.diagnostics(target, (d) =>
		/Expected 2 arguments/.test(d.diagnostics[0]?.message),
	);
	text =
		"fn identity<T>(value:T)->T{return value;} fn f()->void {identity<string>(";
	await host.change(target, text);
	help = await host.request(
		"signatureHelp",
		target,
		position(text, "identity<string>(", 17),
	);
	assert.equal(
		help.signatures[0].label,
		"identity<string>(value: string) -> string",
	);
	assert.equal(help.activeParameter, 0);
	text =
		"fn identity<T>(value:T)->T{return value;} fn f()->void {identity<int32,string>();}";
	await host.change(target, text);
	help = await host.request(
		"signatureHelp",
		target,
		position(text, "string>(", 8),
	);
	assert.equal(help, null);
	await host.diagnostics(
		target,
		(d) =>
			d.version === 3 &&
			/explicit type arguments/.test(d.diagnostics[0]?.message),
	);
});

test("JSON-RPC diagnoses Future consumption and exposes async signatures and read/array assistance", async (t) => {
	const host = await start(t);
	const prefix =
		'use "std/arr" as arr; async fn calculate()->int32{return 42;} ';
	let text =
		prefix +
		"async fn main()->int32{let f:Future<int32>=calculate();await f;return await f;}";
	const target = await host.open("futures.noma", text);
	await host.diagnostics(target, (d) =>
		/consumed or moved/.test(d.diagnostics[0]?.message),
	);
	text =
		prefix +
		"async fn main()->int32{let f:Future<int32>=calculate();return await f;}";
	await host.change(target, text);
	await host.diagnostics(
		target,
		(d) => d.version === 2 && d.diagnostics.length === 0,
	);
	const hover = await host.request(
		"hover",
		target,
		position(text, "f:Future"),
	);
	assert.match(hover.contents.value, /Future<int32>/);
	text = prefix + "async fn main()->void{let f:Future<int32>=calculate(); }";
	await host.change(target, text);
	let items = await host.request(
		"completion",
		target,
		position(text, "; }", 2),
	);
	for (const name of ["read", "await", "async", "Future"])
		assert.ok(
			items.some((i) => i.label === name),
			name,
		);
	text = prefix + "async fn main()->void{calculate(";
	await host.change(target, text);
	const help = await host.request(
		"signatureHelp",
		target,
		TextDocument.create("", "noma", 1, text).positionAt(
			text.lastIndexOf("calculate(") + 10,
		),
	);
	assert.equal(help.signatures[0].label, "calculate() -> Future<int32>");
	text = 'use "std/arr" as arr; fn main()->void{let a:Array<int32>=[1]; a. }';
	await host.change(target, text);
	items = await host.request("completion", target, position(text, "a. }", 2));
	assert.ok(!items.some((i) => i.label === "length"));
	text =
		'use "std/arr" as arr; fn main()->void{let mut a:Array<int32>=[1]; arr.length<int32>(read a);}';
	await host.change(target, text);
	await host.diagnostics(
		target,
		(d) => d.version === 6 && d.diagnostics.length === 0,
	);
	text = "fn main()->void{let a:Array<int32>=[1];a.length;}";
	await host.change(target, text);
	await host.diagnostics(
		target,
		(d) =>
			d.version === 7 && /no properties/.test(d.diagnostics[0]?.message),
	);
});
