import { compile } from "./index.js";
import { Interpreter } from "./interpreter.js";
import { createIORegistry, NodeIOHost } from "./native.js";

async function main(): Promise<void> {
	const args = process.argv.slice(2),
		checkOnly = args[0] === "--check";
	if (args.length === 1 && args[0] === "--version") {
		process.stdout.write("Noma v0.0.2\n");
		return;
	}
	if (checkOnly) args.shift();
	if (args.length !== 1 || args[0]!.startsWith("-")) {
		process.stderr.write(
			"Usage: noma [--check] <file.noma> | noma --version\n",
		);
		process.exitCode = 2;
		return;
	}
	const program = await compile(args[0]!);
	const host = new NodeIOHost(),
		registry = createIORegistry(host);
	try {
		registry.link(program);
		if (checkOnly) {
			process.stdout.write("Type check passed\n");
			return;
		}
		const result = await new Interpreter(program, registry).run();
		if (typeof result === "number") process.exitCode = result;
	} finally {
		await host.dispose();
	}
}
try {
	await main();
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
