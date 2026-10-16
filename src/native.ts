import type { Writable, Readable } from "node:stream";
import { LanguageError } from "./ast.js";
import type { CheckedProgram, FunctionInfo } from "./checker.js";
import {
	EOF_TYPE,
	equivalent,
	STRING,
	THROWABLE,
	union,
	VOID,
} from "./types.js";
import type { Type } from "./types.js";
import { clone, hostError, matches } from "./values.js";
import type { Value } from "./values.js";

export interface IOHost {
	writeStdout(text: string): Promise<void>;
	writeStderr(text: string): Promise<void>;
	readLine(): Promise<string | { eof: boolean }>;
}
interface NativeBinding {
	inputs: Type[];
	result: Type;
	invoke: (args: readonly Value[]) => Promise<unknown>;
}
export class NativeRegistry {
	private readonly bindings = new Map<string, NativeBinding>();
	register(key: string, binding: NativeBinding): void {
		if (this.bindings.has(key))
			throw new Error(`Duplicate native binding: ${key}`);
		this.bindings.set(key, binding);
	}
	private binding(fn: FunctionInfo): NativeBinding {
		const key = `${fn.module.id}#${fn.declaration.name}`,
			binding = this.bindings.get(key);
		if (!fn.module.trusted || !fn.declaration.native || !binding)
			throw new LanguageError(
				fn.declaration.span,
				`Unregistered native function: ${key}`,
			);
		return binding;
	}
	link(program: CheckedProgram): void {
		for (const module of program.program.modules)
			for (const fn of program.functions.get(module)!.values()) {
				if (!fn.declaration.native) continue;
				const binding = this.binding(fn);
				if (
					fn.params.length !== binding.inputs.length ||
					fn.params.some(
						(type, index) =>
							type.kind !== "tsany" &&
							!equivalent(type, binding.inputs[index]!),
					) ||
					!equivalent(fn.result, binding.result)
				) {
					throw new LanguageError(
						fn.declaration.span,
						"Native declaration does not match the registered ABI",
					);
				}
			}
	}
	async call(fn: FunctionInfo, args: readonly Value[]): Promise<Value> {
		const binding = this.binding(fn);
		if (
			args.length !== binding.inputs.length ||
			args.some((value, index) => !matches(value, binding.inputs[index]!))
		)
			throw new LanguageError(
				fn.declaration.span,
				"Native input contract violation",
			);
		const result = await binding.invoke(
			args.map((value) => clone(value, true)),
		);
		if (!matches(result, binding.result) || !matches(result, fn.result))
			throw new LanguageError(
				fn.declaration.span,
				"Native result contract violation",
			);
		return clone(result, true);
	}
}
export function createIORegistry(host: IOHost): NativeRegistry {
	const registry = new NativeRegistry(),
		outputResult = union([VOID, THROWABLE]);
	for (const [name, write] of [
		["writeStdout", host.writeStdout.bind(host)],
		["writeStderr", host.writeStderr.bind(host)],
	] as const) {
		registry.register(`std/internal/io#${name}`, {
			inputs: [STRING],
			result: outputResult,
			async invoke(args) {
				try {
					await write(args[0] as string);
					return null;
				} catch (error) {
					return hostError(error);
				}
			},
		});
	}
	registry.register("std/internal/io#readStdinLine", {
		inputs: [],
		result: union([STRING, EOF_TYPE, THROWABLE]),
		async invoke() {
			try {
				return await host.readLine();
			} catch (error) {
				return hostError(error);
			}
		},
	});
	return registry;
}

/** Lazy, incremental UTF-8 input: no read occurs until the first readLine call. */
export class NodeIOHost implements IOHost {
	private iterator: AsyncIterator<unknown> | null = null;
	private readonly decoder = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	});
	private buffer = "";
	private ended = false;
	private failure: unknown = null;
	private readonly outputFailures = new Map<Writable, Error>();
	private readonly listeners = new Map<Writable, (error: Error) => void>();
	constructor(
		private readonly input: Readable = process.stdin,
		private readonly output: Writable = process.stdout,
		private readonly errorOutput: Writable = process.stderr,
	) {
		for (const stream of new Set([output, errorOutput])) {
			const listener = (error: Error): void => {
				this.outputFailures.set(stream, error);
			};
			this.listeners.set(stream, listener);
			stream.on("error", listener);
		}
	}
	private async write(stream: Writable, text: string): Promise<void> {
		const previous = this.outputFailures.get(stream);
		if (previous) throw previous;
		await new Promise<void>((resolve, reject) => {
			stream.write(text, "utf8", (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}
	writeStdout(text: string): Promise<void> {
		return this.write(this.output, text);
	}
	writeStderr(text: string): Promise<void> {
		return this.write(this.errorOutput, text);
	}
	async readLine(): Promise<string | { eof: boolean }> {
		if (this.failure !== null) throw this.failure;
		try {
			while (true) {
				const newline = this.buffer.indexOf("\n");
				if (newline >= 0) {
					const line = this.buffer.slice(0, newline);
					this.buffer = this.buffer.slice(newline + 1);
					return line.endsWith("\r") ? line.slice(0, -1) : line;
				}
				if (this.ended) {
					if (this.buffer) {
						const tail = this.buffer;
						this.buffer = "";
						return tail;
					}
					return { eof: true };
				}
				this.iterator ??= this.input[Symbol.asyncIterator]();
				const next = await this.iterator.next();
				if (next.done) {
					this.buffer += this.decoder.decode();
					this.ended = true;
				} else if (next.value instanceof Uint8Array)
					this.buffer += this.decoder.decode(next.value, {
						stream: true,
					});
				else
					throw new Error(
						"stdin must provide bytes, not pre-decoded strings",
					);
			}
		} catch (error) {
			this.failure = error;
			throw error;
		}
	}
	async dispose(): Promise<void> {
		if (this.iterator?.return) await this.iterator.return();
		for (const [stream, listener] of this.listeners)
			stream.removeListener("error", listener);
	}
}
