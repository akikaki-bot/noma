import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import textmate from "vscode-textmate";
import oniguruma from "vscode-oniguruma";
import { parse } from "../../../dist/src/parser.js";
import { loadProgram } from "../../../dist/src/modules.js";
import { checkProgram } from "../../../dist/src/checker.js";

const root = new URL("../", import.meta.url);
const json = async (file) =>
	JSON.parse(await readFile(new URL(file, root), "utf8"));
const manifest = await json("package.json");
const config = await json("language-configuration.json");
const snippets = await json("snippets/noma.json");
const require = createRequire(import.meta.url);
await oniguruma.loadWASM(
	await readFile(require.resolve("vscode-oniguruma/release/onig.wasm")),
);
const registry = new textmate.Registry({
	onigLib: Promise.resolve({
		createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
		createOnigString: (value) => new oniguruma.OnigString(value),
	}),
	loadGrammar: async (scope) =>
		scope === "source.noma"
			? textmate.parseRawGrammar(
					await readFile(
						new URL("syntaxes/noma.tmLanguage.json", root),
						"utf8",
					),
					"noma.json",
				)
			: null,
});
const grammar = await registry.loadGrammar("source.noma");
assert.ok(grammar);

function tokenize(source) {
	let state = textmate.INITIAL;
	const lines = source.split(/\r?\n/).map((line) => {
		const result = grammar.tokenizeLine(line, state);
		state = result.ruleStack;
		return { line, tokens: result.tokens };
	});
	return { lines, state };
}
function hasScope(source, text, scope, occurrence = 0) {
	let count = 0;
	for (const { line, tokens } of tokenize(source).lines) {
		let offset = line.indexOf(text);
		while (offset !== -1) {
			if (
				(/\w/.test(text[0]) && /\w/.test(line[offset - 1] ?? "")) ||
				(/\w/.test(text.at(-1)) &&
					/\w/.test(line[offset + text.length] ?? ""))
			) {
				offset = line.indexOf(text, offset + text.length);
				continue;
			}
			if (count++ === occurrence) {
				const token = tokens.find(
					(value) =>
						value.startIndex <= offset && offset < value.endIndex,
				);
				assert.ok(
					token?.scopes.some((value) => value.startsWith(scope)),
					`${text}: expected ${scope}; got ${token?.scopes.join(", ")}`,
				);
				return;
			}
			offset = line.indexOf(text, offset + text.length);
		}
	}
	assert.fail(`Missing text: ${text}`);
}

test("read, async, await and Future receive their language scopes", () => {
	const source =
		"pub async fn main()->int32 {let f:Future<int32>=calculate(); inspect(read values[0]); return await f;}";
	hasScope(source, "async", "storage.modifier");
	hasScope(source, "await", "keyword.control");
	hasScope(source, "read", "keyword.operator");
	hasScope(source, "Future", "support.type.builtin");
});

test("manifest wires .noma to existing grammar, editing configuration and snippets", async () => {
	assert.deepEqual(manifest.contributes.languages[0].extensions, [".noma"]);
	assert.equal(manifest.contributes.languages[0].id, "noma");
	assert.equal(manifest.contributes.grammars[0].scopeName, "source.noma");
	for (const file of [
		manifest.contributes.languages[0].configuration,
		manifest.contributes.grammars[0].path,
		manifest.contributes.snippets[0].path,
	]) {
		await json(file);
	}
	assert.equal(manifest.main, "./dist/extension.cjs");
	assert.equal(manifest.dependencies, undefined);
});

test("keywords, builtins, declarations and qualified calls have conventional scopes", () => {
	const source = `use "std/io" as io;
pub fn increment(mut value: int32) -> void {
    let mut saved: int32 = snapshot value;
    match (saved) { case (n: int32) { io.puts("hello"); } }
    if true { return; } else { while false { break; } }
    fallible() catch e { return; };
    fallible() otherwise e { void };
    raise "failure";
}
compilerOnly type TSAny = intrinsic;
native fn bridge(value: TSAny) -> never;`;
	for (const keyword of [
		"use",
		"as",
		"pub",
		"mut",
		"fn",
		"let",
		"snapshot",
		"match",
		"case",
		"if",
		"return",
		"else",
		"while",
		"break",
		"raise",
		"catch",
		"otherwise",
		"compilerOnly",
		"type",
		"intrinsic",
		"native",
	]) {
		const scopes = tokenize(source).lines.flatMap(({ line, tokens }) =>
			tokens
				.filter(
					(token) =>
						line.slice(token.startIndex, token.endIndex) ===
						keyword,
				)
				.flatMap((token) => token.scopes),
		);
		assert.ok(
			scopes.some((scope) => /^(storage|keyword)\./.test(scope)),
			keyword,
		);
	}
	hasScope(source, "increment", "entity.name.function.noma");
	hasScope(source, "value", "variable.parameter.noma");
	hasScope(source, "puts", "entity.name.function.call.noma");
	hasScope(source, "true", "constant.language.boolean.noma");
	for (const name of ["int32", "void", "never"])
		hasScope(source, name, "support.type.builtin.noma");
	hasScope(source, "TSAny", "entity.name.type.noma");
	hasScope(source, "TSAny", "support.type.builtin.noma", 1);
});

test("type contexts support arbitrary names, qualified types, nested structs, unions and arrays", () => {
	const source = `type lower = struct { values: (models.item | string)[]; nested: struct { ok: bool; }; };
fn convert(
    mut x: lower,
    y: struct { inner: int32; }
) -> struct { field: lower; } {
    let value: lower | models.item[] = struct { field: x };
    match (x) { case (v: lower) { value } };
}`;
	parse(source);
	hasScope(source, "lower", "entity.name.type.noma", 1);
	hasScope(source, "item", "entity.name.type.noma");
	hasScope(source, "values", "variable.other.property.noma");
	hasScope(source, "nested", "variable.other.property.noma");
	hasScope(source, "field", "variable.other.property.noma");
	hasScope(source, "value", "variable.other.definition.noma");
	hasScope(source, "x", "variable.other.noma", 1);
	hasScope(source, "lower", "entity.name.type.noma", 4);
});

test("comments nest across lines and strings protect comment markers and keywords", () => {
	const source = `/* outer
/* inner */ still outer
*/ fn ready() -> void {
    // fn comment 42
    let text: string = "match // /* 123 \\"ok\\" \\n \\u3042";
}`;
	hasScope(source, "still outer", "comment.block.noma");
	hasScope(source, "ready", "entity.name.function.noma");
	hasScope(source, "comment", "comment.line.double-slash.noma");
	hasScope(source, "match", "string.quoted.double.noma");
	hasScope(source, "\\n", "constant.character.escape.noma");
	hasScope(source, "\\u3042", "constant.character.escape.noma");
	hasScope('"bad\\q"', "\\q", "invalid.illegal.escape.noma");
	hasScope(
		'"unfinished\nfn recovered() -> void {}',
		"recovered",
		"entity.name.function.noma",
	);
});

test("struct type bodies can start on the next line", () => {
	const source = `type data = struct
{
    value: int32;
};
fn create() -> struct
{
    value: data;
} {
    let result: data = struct { value: 1 };
    return result;
}`;
	parse(source);
	hasScope(source, "value", "variable.other.property.noma");
	hasScope(source, "data", "entity.name.type.noma", 1);
	hasScope(source, "result", "variable.other.definition.noma");
	hasScope(source, "return", "keyword.control.noma");
});

test("numbers and identifier boundaries follow the lexer", () => {
	const source = "let snapshotValue: int32 = -42; nativeThing(mutValue);";
	hasScope(source, "42", "constant.numeric.integer.noma");
	hasScope(source, "snapshotValue", "variable.other.definition.noma");
	hasScope(source, "mutValue", "variable.other.noma");
});
test("v0.0.2 casts and trycast type designators use type scopes", () => {
	const source = `type Animal = struct { name: string; };
fn f() -> void {
    let a: Animal = (Animal)dog;
    typing.trycast(Animal, snapshot dog);
    typing.trycast(Array<int32>, [1]);
}`;
	for (const occurrence of [1, 2, 3])
		hasScope(source, "Animal", "entity.name.type.noma", occurrence);
	hasScope(source, "Array", "support.type.builtin.noma");
	hasScope(source, "trycast", "entity.name.function.call.noma");
	hasScope(
		'raise "bad"; catch error { return; }',
		"raise",
		"keyword.control.noma",
	);
	hasScope(
		'raise "bad"; catch error { return; }',
		"catch",
		"keyword.control.noma",
	);
});

test("all example and stdlib files finish without a leaked grammar context", async () => {
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = new URL(
				entry.name + (entry.isDirectory() ? "/" : ""),
				directory,
			);
			if (entry.isDirectory()) await visit(file);
			else if (entry.name.endsWith(".noma")) {
				const { state } = tokenize(await readFile(file, "utf8"));
				assert.equal(state.depth, 1, file.href);
			}
		}
	}
	await visit(new URL("../../examples/", root));
	await visit(new URL("../../stdlib/", root));
});

test("bracket editing and indentation cover blocks, arrays and multiline arguments", () => {
	assert.deepEqual(config.brackets, [
		["{", "}"],
		["[", "]"],
		["(", ")"],
	]);
	assert.deepEqual(config.comments, {
		lineComment: "//",
		blockComment: ["/*", "*/"],
	});
	assert.deepEqual(
		config.autoClosingPairs.map((pair) => pair.open),
		["{", "[", "(", '"'],
	);
	for (const pair of config.autoClosingPairs)
		assert.deepEqual(pair.notIn, ["string", "comment"]);
	const increase = new RegExp(config.indentationRules.increaseIndentPattern);
	const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);
	for (const line of [
		"fn main() -> int32 {",
		"} else {",
		"let x: int32[] = [",
		"call(",
		"call(1, ",
		"if true { // comment",
		'if text == "{" {',
	])
		assert.ok(increase.test(line), line);
	for (const line of [
		"fn f() -> void {}",
		"// {",
		'let s: string = "{";',
		"let x: int32[] = [1];",
	])
		assert.ok(!increase.test(line), line);
	for (const line of ["}", "  ];", "\t)"])
		assert.ok(decrease.test(line), line);
});

// Expand the simple tabstops/defaults used here; intentionally no transforms or choices.
function expand(snippet) {
	const body = Array.isArray(snippet.body)
		? snippet.body.join("\n")
		: snippet.body;
	return body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\d+/g, "");
}
for (const [name, snippet] of Object.entries(snippets)) {
	test(`snippet parses and type-checks in context: ${snippet.prefix}`, async () => {
		const body = expand(snippet);
		assert.ok(!body.includes("$"), name);
		let source;
		if (["main", "asyncmain"].includes(snippet.prefix)) source = body;
		else if (
			["fn", "pubfn", "asyncfn", "type", "use"].includes(snippet.prefix)
		)
			source = `${body}\nfn main() -> int32 { return 0; }`;
		else if (snippet.prefix === "snapshot")
			source = `fn main() -> int32 { let mut value: int32 = 1; ${body} return saved; }`;
		else if (snippet.prefix === "match")
			source = `fn main() -> int32 { let value: int32 | string = 1; let result: int32 = ${body}; return result; }`;
		else if (["catch", "otherwise"].includes(snippet.prefix))
			source = `fn fallible() -> int32 | throwable { return 1; } fn main() -> int32 { let value: int32 = fallible() ${body}; return value; }`;
		else if (snippet.prefix === "raise")
			source = `fn f() -> int32 | throwable { ${body} } fn main() -> void {}`;
		else if (snippet.prefix === "read")
			source = `fn inspect(value:int32)->void{} fn main()->void{let mut value:int32=1;inspect(${body});}`;
		else if (snippet.prefix === "arrlen")
			source = `use "std/arr" as arr; fn main()->int32{let mut values:Array<int32>=[1];return ${body};}`;
		else if (snippet.prefix === "future")
			source = `async fn calculate()->int32{return 42;} fn main()->void{${body}}`;
		else if (snippet.prefix === "await")
			source = `async fn calculate()->int32{return 42;} async fn main()->int32{let pending:Future<int32>=calculate();${body} return result;}`;
		else source = `fn main() -> int32 { ${body}\nreturn 0; }`;
		parse(source);
		const directory = await mkdtemp(path.join(tmpdir(), "noma-snippet-"));
		try {
			const file = path.join(directory, "main.noma");
			await writeFile(file, source);
			checkProgram(await loadProgram(file));
		} finally {
			assert.equal(
				path.dirname(path.resolve(directory)),
				path.resolve(tmpdir()),
			);
			assert.ok(path.basename(directory).startsWith("noma-snippet-"));
			await rm(directory, { recursive: true, force: true });
		}
	});
}
