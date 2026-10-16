import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createIORegistry, NativeRegistry, NodeIOHost } from "../src/native.js";
import { Interpreter } from "../src/interpreter.js";
import { STRING, VOID } from "../src/types.js";
import { check, MemoryIO, run } from "./helpers.js";

test("stdlib writes UTF-8, newline wrappers and stderr through language code", async (t) => {
	const host = new MemoryIO();
	await run(
		t,
		`use "std/io" as io; fn main() -> void {
		io.write("日本語🌱"); io.puts("!"); io.writeError("error"); io.putsError("!");
	}`,
		host,
	);
	assert.equal(host.stdout, "日本語🌱!\n");
	assert.equal(host.stderr, "error!\n");
});
test("echo integrates readLine, match, EOF, handlers and repeated input", async (t) => {
	const source = await readFile(
		fileURLToPath(new URL("../../examples/echo.noma", import.meta.url)),
		"utf8",
	);
	const host = new MemoryIO(["こんにちは🌱", "", "last"]);
	assert.equal(await run(t, source, host), 0);
	assert.equal(host.stdout, "こんにちは🌱\n\nlast\n");
});
test("otherwise replaces an I/O failure and catch exits only on failure", async (t) => {
	const host = new MemoryIO();
	host.readLine = async () => {
		throw new Error("input failed");
	};
	assert.equal(
		await run(
			t,
			`use "std/io" as io; fn main() -> int32 {
		let line: string | io.EOF = io.readLine() otherwise error { "fallback" };
		return match (line) { case (text: string) { if text == "fallback" { 0 } else { 1 } } case (end: io.EOF) { 2 } };
	}`,
			host,
		),
		0,
	);
	assert.equal(
		await run(
			t,
			`use "std/io" as io; fn main() -> int32 {
		io.readLine() catch error { io.putsError(error.message); return 7; };
		return 0;
	}`,
			host,
		),
		7,
	);
	assert.equal(host.stderr, "input failed\n");
});
test("output failure becomes throwable, not success or an uncaught host exception", async (t) => {
	const host = new MemoryIO();
	host.writeStdout = async () => {
		throw new Error("EPIPE");
	};
	assert.equal(
		await run(
			t,
			`use "std/io" as io; fn main() -> int32 {
		io.puts("hello") catch error { if error.message == "EPIPE" { return 8; } return 9; }; return 0;
	}`,
			host,
		),
		8,
	);
});
test("handler static control flow and replacement types are enforced", async (t) => {
	await assert.rejects(
		check(
			t,
			'use "std/io" as io; fn main() -> void { io.puts("x") catch error { void }; }',
		),
		/must have type never/,
	);
	await assert.rejects(
		check(
			t,
			'use "std/io" as io; fn main() -> void { io.puts("x") otherwise error { 42 }; }',
		),
		/Expected void, got int32/,
	);
	await assert.rejects(
		check(t, "fn main() -> void { 1 otherwise error { 0 }; }"),
		/requires a throwable/,
	);
	await assert.rejects(
		check(
			t,
			'use "std/io" as io; fn main() -> void { io.puts("x") catch error { break; }; }',
		),
		/enclosing loop/,
	);
});
test("break in an error handler exits the enclosing loop normally", async (t) => {
	const host = new MemoryIO();
	host.writeStdout = async () => {
		throw new Error("failure");
	};
	assert.equal(
		await run(
			t,
			'use "std/io" as io; fn main() -> int32 { while true { io.puts("x") catch error { break; }; } return 12; }',
			host,
		),
		12,
	);
});
test("otherwise can have a return-only branch", async (t) => {
	const host = new MemoryIO();
	host.readLine = async () => {
		throw new Error("failure");
	};
	assert.equal(
		await run(
			t,
			'use "std/io" as io; fn main() -> int32 { let x: string | io.EOF = io.readLine() otherwise error { return 13; }; return 0; }',
			host,
		),
		13,
	);
});
test("native result validation prevents a malformed host result escaping", async (t) => {
	const host = new MemoryIO();
	// Deliberately violate the TypeScript host interface to test the runtime boundary.
	host.readLine = async () => 42 as unknown as string;
	await assert.rejects(
		run(
			t,
			'use "std/io" as io; fn main() -> void { io.readLine(); }',
			host,
		),
		/Native result contract violation/,
	);
});
test("native link rejects missing or incompatible registrations before execution", async (t) => {
	const program = await check(t, 'use "std/io" as io; fn main() -> void {}');
	assert.throws(
		() => new Interpreter(program, new NativeRegistry()),
		/Unregistered native/,
	);
	const registry = new NativeRegistry();
	registry.register("std/internal/io#writeStdout", {
		inputs: [STRING],
		result: VOID,
		invoke: async () => null,
	});
	assert.throws(() => new Interpreter(program, registry), /registered ABI/);
	assert.throws(
		() =>
			registry.register("std/internal/io#writeStdout", {
				inputs: [],
				result: VOID,
				invoke: async () => null,
			}),
		/Duplicate native/,
	);
});
test("opaque throwable cannot be forged from an ordinary struct", async (t) => {
	await assert.rejects(
		check(
			t,
			'fn main() -> void { let e: throwable = struct { message: "fake" }; }',
		),
		/Expected throwable/,
	);
});
function sink(): Writable {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
}
test("Node host incrementally decodes split UTF-8, CRLF, blank lines and final unterminated input", async () => {
	const bytes = Buffer.from("日本🌱\r\n\ntail", "utf8");
	const input = Readable.from([...bytes].map((byte) => Buffer.from([byte])));
	const host = new NodeIOHost(input, sink(), sink());
	try {
		assert.equal(await host.readLine(), "日本🌱");
		assert.equal(await host.readLine(), "");
		assert.equal(await host.readLine(), "tail");
		assert.deepEqual(await host.readLine(), { eof: true });
		assert.deepEqual(await host.readLine(), { eof: true });
	} finally {
		await host.dispose();
	}
});
test("Node host distinguishes empty input from an empty line", async () => {
	for (const [input, expected] of [
		[[], { eof: true }],
		[[Buffer.from("\n")], ""],
	] as const) {
		const host = new NodeIOHost(Readable.from(input), sink(), sink());
		try {
			assert.deepEqual(await host.readLine(), expected);
			assert.deepEqual(await host.readLine(), { eof: true });
		} finally {
			await host.dispose();
		}
	}
});
test("Node host rejects invalid and truncated UTF-8 as errors, not EOF", async () => {
	for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe3, 0x81])]) {
		const host = new NodeIOHost(Readable.from([bytes]), sink(), sink());
		try {
			await assert.rejects(host.readLine(), /encoded data/);
			await assert.rejects(host.readLine(), /encoded data/);
		} finally {
			await host.dispose();
		}
	}
});
test("Node host input OS failures become throwable through the native registry", async (t) => {
	const input = new Readable({
		read() {
			this.destroy(new Error("stdin broken"));
		},
	});
	const host = new NodeIOHost(input, sink(), sink());
	try {
		assert.equal(
			await run(
				t,
				'use "std/io" as io; fn main() -> int32 { io.readLine() catch e { if e.message == "stdin broken" { return 4; } return 5; }; return 0; }',
				host,
			),
			4,
		);
	} finally {
		await host.dispose();
	}
});
test("Node host writes exact UTF-8 bytes and reports asynchronous write failures", async () => {
	const chunks: Buffer[] = [];
	const output = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			chunks.push(chunk);
			callback();
		},
	});
	const failure = new Writable({
		write(_chunk, _encoding, callback) {
			callback(new Error("EPIPE"));
		},
	});
	const host = new NodeIOHost(Readable.from([]), output, failure);
	try {
		await host.writeStdout("こんにちは🌱");
		assert.equal(Buffer.concat(chunks).toString("utf8"), "こんにちは🌱");
		await assert.rejects(host.writeStderr("fail"), /EPIPE/);
		await assert.rejects(host.writeStderr("again"), /EPIPE/);
	} finally {
		await host.dispose();
	}
});
