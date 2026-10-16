import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
test("CLI reports the language version", () => {
	const result = spawnSync(process.execPath, [cli, "--version"], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "Noma v0.0.2\n");
	assert.equal(result.stderr, "");
});
test("CLI executes raise/typing and checks new syntax without side effects", async (t) => {
	const file = await fixture(
		t,
		`use "std/typing" as typing; use "std/io" as io;
	fn f() -> int32 | throwable { raise "bad"; }
	fn main() -> int32 {
		let value: int32 = typing.trycast(int32, "123") otherwise e { 3 };
		return f() catch e { io.puts(e.message) catch err { return 1; }; return value; };
	}`,
	);
	const checked = spawnSync(process.execPath, [cli, "--check", file], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(checked.status, 0, checked.stderr);
	assert.equal(checked.stdout, "Type check passed\n");
	const executed = spawnSync(process.execPath, [cli, file], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(executed.status, 3, executed.stderr);
	assert.equal(executed.stdout, "bad\n");
});
test("CLI executes the UTF-8 hello example and returns main status", () => {
	const file = fileURLToPath(
		new URL("../../examples/hello.noma", import.meta.url),
	);
	const result = spawnSync(process.execPath, [cli, file], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "Hello, Noma! こんにちは 🌱\n");
	assert.equal(result.stderr, "");
});
test("CLI echo reads piped UTF-8 through real Node streams and terminates at EOF", () => {
	const file = fileURLToPath(
		new URL("../../examples/echo.noma", import.meta.url),
	);
	const result = spawnSync(process.execPath, [cli, file], {
		input: Buffer.from("こんにちは🌱\r\n\nlast"),
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "こんにちは🌱\n\nlast\n");
	assert.equal(result.stderr, "");
});
test("--check validates without running program effects", async (t) => {
	const file = await fixture(
		t,
		'use "std/io" as io; fn main() -> int32 { io.puts("must not run"); return 7; }',
	);
	const result = spawnSync(process.execPath, [cli, "--check", file], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "Type check passed\n");
	assert.equal(result.stderr, "");
	const executed = spawnSync(process.execPath, [cli, file], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(executed.status, 7);
	assert.equal(executed.stdout, "must not run\n");
});
test("invalid program produces a location and no user I/O", async (t) => {
	const file = await fixture(
		t,
		'use "std/io" as io; fn main() -> void { io.puts("must not run"); let x: string = 1; }',
	);
	const result = spawnSync(process.execPath, [cli, file], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /main.noma:1:\d+: Expected string, got int32/);
});
test("CLI reports usage and missing files with nonzero exit status", () => {
	const usage = spawnSync(process.execPath, [cli], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(usage.status, 2);
	assert.match(usage.stderr, /Usage: noma/);
	const missing = spawnSync(process.execPath, [cli, "missing.noma"], {
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /ENOENT/);
});
