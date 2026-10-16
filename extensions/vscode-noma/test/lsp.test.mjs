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

test("LSP advertises supported features and uses bundled stdlib without executing Noma", async (t) => {
	const host = await start(t);
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
	assert.deepEqual(
		await host.request("completion", target, position(text, "saved")),
		[],
	);
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
