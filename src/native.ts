import type { Writable, Readable } from "node:stream";
import { LanguageError } from "./ast.js";
import type { CheckedProgram, FunctionInfo } from "./checker.js";
import {
	EOF_TYPE,
	INT32,
	INT8,
	INT16,
	INT64,
	UINT8,
	UINT16,
	UINT32,
	UINT64,
	FLOAT32,
	FLOAT64,
	equivalent,
	substitute,
	STRING,
	THROWABLE,
	union,
	VOID,
	variants,
} from "./types.js";
import type { Type } from "./types.js";
import {
	clone,
	freezeOwned,
	hostError,
	matches,
	getMemberType,
	setMemberType,
} from "./values.js";
import type { Value } from "./values.js";
import {
	arrayNativeNames,
	arrayNativeOperation,
	arraySignature,
} from "./array-abi.js";
import type { ArrayOperation } from "./array-abi.js";
import { invokeArray } from "./array-runtime.js";
import { isIntegerType, isNumericType } from "./numeric.js";
import {
	checkedInt32,
	codepointAt,
	codepointLength,
	fromCodepoint,
	NativeRuntimeError,
} from "./stdlib-native.js";

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
/** Explicit concrete identity for native results with overlapping numeric types.
 * The integer itself remains a bigint; this carrier exists only at the ABI. */
export class NativeValue {
	constructor(
		readonly value: Value,
		readonly type: Type,
	) {}
}
export interface NativeResult {
	value: Value;
	type: Type;
}

function runtimeType(value: Value, contract: Type, hint?: Type): Type {
	const actual = hint?.kind === "union" ? undefined : hint;
	if (!matches(value, contract, actual))
		throw new Error("Value does not match its concrete runtime type");
	if (contract.kind === "union") {
		const numericCandidates = variants(contract).filter((type) =>
			typeof value === "bigint"
				? isIntegerType(type.kind)
				: typeof value === "number" &&
					isNumericType(type.kind) &&
					!isIntegerType(type.kind),
		);
		if (!actual && numericCandidates.length > 1)
			throw new Error(
				"Native value requires concrete type metadata for an ambiguous numeric union",
			);
		const candidates = variants(contract).filter((type) =>
			matches(value, type, actual),
		);
		if (candidates.length !== 1)
			throw new Error(
				"Native value requires concrete type metadata for an ambiguous union",
			);
		return runtimeType(value, candidates[0]!, actual);
	}
	if (contract.kind === "array") {
		const array = value as Value[];
		for (let index = 0; index < array.length; index++) {
			const type = runtimeType(
				array[index]!,
				contract.element,
				getMemberType(array, index) ??
					(actual?.kind === "array" ? actual.element : undefined),
			);
			setMemberType(array, index, type);
		}
	}
	if (contract.kind === "struct") {
		const record = value as Record<string, Value>;
		const fields = new Map<string, Type>();
		for (const [key, field] of contract.fields) {
			const type = runtimeType(
				record[key]!,
				field,
				getMemberType(record, key) ??
					(actual?.kind === "struct"
						? actual.fields.get(key)
						: undefined),
			);
			setMemberType(record, key, type);
			fields.set(key, type);
		}
		return { kind: "struct", fields };
	}
	return contract;
}
export interface NativeCell {
	get(): Value;
	set(value: Value): void;
}
type NativeEntry =
	| (NativeBinding & { kind: "copy" })
	| { kind: "array"; operation: ArrayOperation };
function isCell(value: Value | NativeCell): value is NativeCell {
	return (
		value !== null &&
		typeof value === "object" &&
		"get" in value &&
		typeof value.get === "function" &&
		"set" in value &&
		typeof value.set === "function"
	);
}
export class NativeRegistry {
	private readonly bindings = new Map<string, NativeEntry>();
	constructor() {
		for (const [name, operation] of arrayNativeNames)
			this.bindings.set(`std/internal/arr#${name}`, {
				kind: "array",
				operation,
			});
	}
	register(key: string, binding: NativeBinding): void {
		if (this.bindings.has(key))
			throw new Error(`Duplicate native binding: ${key}`);
		this.bindings.set(key, { ...binding, kind: "copy" });
	}
	private binding(fn: FunctionInfo): NativeEntry {
		const key = `${fn.module.id}#${fn.declaration.name}`,
			binding = this.bindings.get(key);
		if (!fn.module.trusted || !fn.declaration.native || !binding)
			throw new LanguageError(
				fn.declaration.span,
				`Unregistered native function: ${key}`,
			);
		return binding;
	}
	private arrayContract(fn: FunctionInfo, operation: ArrayOperation): void {
		const array = operation === "create" ? fn.result : fn.params[0];
		const signature =
			array?.kind === "array"
				? arraySignature(operation, array.element)
				: undefined;
		if (
			arrayNativeOperation(fn.module, fn.declaration.name) !==
				operation ||
			fn.intrinsic !== `array.${operation}` ||
			fn.declaration.public ||
			fn.declaration.async ||
			fn.declaration.body ||
			fn.declaration.typeParams?.length !== 1 ||
			!signature ||
			fn.params.length !== signature.params.length ||
			!equivalent(fn.result, signature.result) ||
			fn.params.some(
				(type, i) =>
					!equivalent(type, signature.params[i]!) ||
					fn.declaration.params[i]?.mutable !== signature.mutable[i],
			)
		)
			throw new LanguageError(
				fn.declaration.span,
				"Native declaration does not match the registered array ABI",
			);
	}
	link(program: CheckedProgram): void {
		for (const module of program.program.modules)
			for (const fn of program.functions.get(module)!.values()) {
				if (!fn.declaration.native) continue;
				const binding = this.binding(fn);
				if (binding.kind === "array") {
					this.arrayContract(fn, binding.operation);
					continue;
				}
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
	async call(
		fn: FunctionInfo,
		args: readonly (Value | NativeCell)[],
		callerTypes: ReadonlyMap<string, Type> = new Map(),
	): Promise<Value> {
		return (await this.callTyped(fn, args, callerTypes)).value;
	}
	async callTyped(
		fn: FunctionInfo,
		args: readonly (Value | NativeCell)[],
		callerTypes: ReadonlyMap<string, Type> = new Map(),
	): Promise<NativeResult> {
		const binding = this.binding(fn);
		if (binding.kind === "array") {
			this.arrayContract(fn, binding.operation);
			if (
				args.length !== fn.params.length ||
				args.some(
					(arg, i) =>
						isCell(arg) !== fn.declaration.params[i]!.mutable,
				)
			)
				throw new LanguageError(
					fn.declaration.span,
					"Native input contract violation: array borrow mode",
				);
			const values = args.map((arg) => (isCell(arg) ? arg.get() : arg));
			for (let i = 0; i < values.length; i++) {
				const type = getMemberType(args, i);
				if (type) setMemberType(values, i, type);
			}
			if (
				values.some(
					(value, i) =>
						!matches(
							value,
							substitute(fn.params[i]!, callerTypes),
							getMemberType(values, i),
						),
				)
			)
				throw new LanguageError(
					fn.declaration.span,
					"Native input contract violation",
				);
			try {
				for (let index = 0; index < values.length; index++)
					setMemberType(
						values,
						index,
						runtimeType(
							values[index]!,
							substitute(fn.params[index]!, callerTypes),
							getMemberType(values, index),
						),
					);
			} catch (error) {
				throw new LanguageError(
					fn.declaration.span,
					`Native input contract violation: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			let resultHint: Type | undefined;
			if (
				binding.operation === "get" ||
				binding.operation === "pop" ||
				binding.operation === "remove"
			) {
				const array = values[0] as Value[];
				const index =
					binding.operation === "pop"
						? array.length - 1
						: typeof values[1] === "bigint" &&
							  values[1] >= 0n &&
							  values[1] < BigInt(array.length)
							? Number(values[1])
							: -1;
				resultHint = getMemberType(array, index);
			}
			let result: Value;
			try {
				result = invokeArray(binding.operation, values);
			} catch (error) {
				throw new LanguageError(
					fn.declaration.span,
					`Array operation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!matches(result, substitute(fn.result, callerTypes)))
				throw new LanguageError(
					fn.declaration.span,
					"Native result contract violation",
				);
			try {
				return {
					value: freezeOwned(result),
					type: runtimeType(
						result,
						substitute(fn.result, callerTypes),
						resultHint,
					),
				};
			} catch (error) {
				throw new LanguageError(
					fn.declaration.span,
					`Native result contract violation: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (
			args.length !== binding.inputs.length ||
			args.some(
				(value, index) =>
					isCell(value) ||
					!matches(
						value,
						binding.inputs[index]!,
						getMemberType(args, index),
					),
			)
		)
			throw new LanguageError(
				fn.declaration.span,
				"Native input contract violation",
			);
		try {
			for (let index = 0; index < args.length; index++)
				runtimeType(
					args[index] as Value,
					binding.inputs[index]!,
					getMemberType(args, index),
				);
		} catch (error) {
			throw new LanguageError(
				fn.declaration.span,
				`Native input contract violation: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let result: unknown;
		try {
			const copied = args.map((value) => clone(value as Value, true));
			for (let i = 0; i < copied.length; i++) {
				const type = getMemberType(args, i);
				if (type) setMemberType(copied, i, type);
			}
			result = await binding.invoke(copied);
		} catch (error) {
			if (error instanceof NativeRuntimeError)
				throw new LanguageError(fn.declaration.span, error.message);
			if (matches(hostError(error), binding.result))
				result = hostError(error);
			else
				throw new LanguageError(
					fn.declaration.span,
					`Native execution failed: ${error instanceof Error ? error.message : String(error)}`,
				);
		}
		let resultType: Type | undefined;
		if (result instanceof NativeValue) {
			resultType = result.type;
			result = result.value;
		}
		if (
			!matches(result, binding.result, resultType) ||
			!matches(result, fn.result, resultType)
		)
			throw new LanguageError(
				fn.declaration.span,
				"Native result contract violation",
			);
		try {
			const type = runtimeType(result, binding.result, resultType);
			return { value: clone(result, true), type };
		} catch (error) {
			throw new LanguageError(
				fn.declaration.span,
				`Native result contract violation: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
export function createIORegistry(host: IOHost): NativeRegistry {
	const registry = new NativeRegistry(),
		outputResult = union([VOID, THROWABLE]);
	registerCoreNatives(registry);
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

/** Pure standard-library bindings also belong to the default I/O registry. */
export function registerCoreNatives(registry: NativeRegistry): void {
	registry.register("std/internal/number#numericToString", {
		inputs: [
			union([
				INT8,
				INT16,
				INT32,
				INT64,
				UINT8,
				UINT16,
				UINT32,
				UINT64,
				FLOAT32,
				FLOAT64,
			]),
		],
		result: STRING,
		invoke: async (args) =>
			Object.is(args[0], -0) ? "-0" : String(args[0]),
	});
	registry.register("std/internal/string#codepointLength", {
		inputs: [STRING],
		result: INT32,
		invoke: async (args) => codepointLength(args[0] as string),
	});
	registry.register("std/internal/string#codepointAt", {
		inputs: [STRING, INT32],
		result: union([INT32, THROWABLE]),
		invoke: async (args) =>
			codepointAt(args[0] as string, args[1] as bigint),
	});
	registry.register("std/internal/string#fromCodepoint", {
		inputs: [INT32],
		result: union([STRING, THROWABLE]),
		invoke: async (args) => fromCodepoint(args[0] as bigint),
	});
	for (const [name, op] of [
		["checkedAdd", "+"],
		["checkedSub", "-"],
		["checkedMul", "*"],
	] as const) {
		registry.register(`std/internal/number#${name}`, {
			inputs: [INT32, INT32],
			result: union([INT32, THROWABLE]),
			invoke: async (args) =>
				checkedInt32(op, args[0] as bigint, args[1] as bigint),
		});
	}
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
