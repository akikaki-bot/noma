import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { compile, runFile } from "../src/index.js";
import type { IOHost } from "../src/native.js";

export async function fixture(
	t: TestContext,
	source: string,
	files: Record<string, string> = {},
): Promise<string> {
	const root = await realpath(os.tmpdir()),
		folder = await mkdtemp(path.join(root, "noma-test-"));
	t.after(async () => {
		const resolved = await realpath(folder);
		if (
			path.dirname(resolved) !== root ||
			!path.basename(resolved).startsWith("noma-test-")
		)
			throw new Error("Unexpected fixture cleanup path");
		await rm(resolved, { recursive: true, force: true });
	});
	for (const [name, contents] of Object.entries({
		"main.noma": source,
		...files,
	})) {
		await writeFile(path.join(folder, name), contents, "utf8");
	}
	return path.join(folder, "main.noma");
}
export class MemoryIO implements IOHost {
	stdout = "";
	stderr = "";
	constructor(private readonly lines: string[] = []) {}
	async writeStdout(text: string): Promise<void> {
		this.stdout += text;
	}
	async writeStderr(text: string): Promise<void> {
		this.stderr += text;
	}
	async readLine(): Promise<string | { eof: boolean }> {
		return this.lines.length ? this.lines.shift()! : { eof: true };
	}
}
export async function run(
	t: TestContext,
	source: string,
	host: IOHost = new MemoryIO(),
	files: Record<string, string> = {},
) {
	return runFile(await fixture(t, source, files), host);
}
export async function check(
	t: TestContext,
	source: string,
	files: Record<string, string> = {},
) {
	return compile(await fixture(t, source, files));
}
