import { LanguageError } from "./ast.js";
import type { Block, Expression, Node, Statement } from "./ast.js";
import type { CheckedProgram, FunctionInfo } from "./checker.js";
import type { NativeRegistry } from "./native.js";
import { substitute } from "./types.js";
import type { Type } from "./types.js";
import {
	clone,
	matches,
	project,
	ProjectionError,
	snapshot,
	ThrowableValue,
} from "./values.js";
import type { Value } from "./values.js";

interface Cell {
	get(): Value;
	set(value: Value): void;
}
class Environment {
	readonly cells = new Map<string, Cell>();
	readonly typeBindings: ReadonlyMap<string, Type>;
	constructor(
		readonly parent: Environment | null = null,
		bindings?: ReadonlyMap<string, Type>,
	) {
		this.typeBindings = bindings ?? parent?.typeBindings ?? new Map();
	}
	get(name: string): Cell {
		const cell = this.cells.get(name) ?? this.parent?.get(name);
		if (!cell) throw new Error(`Unresolved runtime binding: ${name}`);
		return cell;
	}
	bind(name: string, value: Value, mutable: boolean): void {
		let stored = clone(value, !mutable);
		this.cells.set(name, {
			get: () => stored,
			set: (next) => {
				if (!mutable) throw new Error("Readonly cell");
				stored = clone(next, false);
			},
		});
	}
}
class ReturnSignal {
	constructor(readonly value: Value) {}
}
class BreakSignal {}
export interface RunOptions {
	maxSteps?: number;
}
export class Interpreter {
	private steps = 0;
	private readonly maxSteps: number;
	constructor(
		readonly program: CheckedProgram,
		readonly native: NativeRegistry,
		options: RunOptions = {},
	) {
		if (program.editorOnly)
			throw new Error("Recovered editor programs cannot be executed");
		this.maxSteps = options.maxSteps ?? 1_000_000;
		native.link(program);
	}
	async run(): Promise<Value> {
		return this.call(
			this.program.functions
				.get(this.program.program.entry)!
				.get("main")!,
			[],
		);
	}
	private tick(node: Node): void {
		if (++this.steps > this.maxSteps)
			throw new LanguageError(node.span, "Execution step limit exceeded");
	}
	private async call(
		fn: FunctionInfo,
		args: (Value | Cell)[],
		callerTypes: ReadonlyMap<string, Type> = new Map(),
	): Promise<Value> {
		this.tick(fn.declaration);
		if (fn.declaration.native) return this.native.call(fn, args as Value[]);
		const bindings = new Map(
			[...(fn.typeBindings ?? [])].map(([id, type]) => [
				id,
				substitute(type, callerTypes),
			]),
		);
		const env = new Environment(null, bindings);
		fn.declaration.params.forEach((parameter, index) => {
			const value = parameter.mutable
				? (args[index] as Cell).get()
				: args[index];
			if (!matches(value, substitute(fn.params[index]!, callerTypes)))
				throw new LanguageError(
					parameter.span,
					"Function argument violates its checked type",
				);
			if (parameter.mutable)
				env.cells.set(parameter.name, args[index] as Cell);
			else env.bind(parameter.name, args[index] as Value, false);
		});
		let value: Value;
		try {
			value = await this.block(fn.declaration.body!, env);
		} catch (signal) {
			if (!(signal instanceof ReturnSignal)) throw signal;
			value = signal.value;
		}
		if (!matches(value, substitute(fn.result, callerTypes)))
			throw new LanguageError(
				fn.declaration.span,
				"Function result violates its checked type",
			);
		return clone(value, true);
	}
	private async block(block: Block, parent: Environment): Promise<Value> {
		const env = new Environment(parent);
		for (const statement of block.statements)
			await this.statement(statement, env);
		return block.tail ? this.expression(block.tail, env) : null;
	}
	private async statement(
		statement: Statement,
		env: Environment,
	): Promise<void> {
		this.tick(statement);
		switch (statement.kind) {
			case "let":
				env.bind(
					statement.name,
					await this.expression(statement.value, env),
					statement.mutable,
				);
				return;
			case "assign": {
				const cell = await this.lvalue(statement.target, env);
				cell.set(await this.expression(statement.value, env));
				return;
			}
			case "return":
				throw new ReturnSignal(
					statement.value
						? await this.expression(statement.value, env)
						: null,
				);
			case "expression":
				await this.expression(statement.expression, env);
				return;
			case "break":
				throw new BreakSignal();
			case "while":
				while (await this.expression(statement.condition, env)) {
					this.tick(statement);
					try {
						await this.block(statement.body, env);
					} catch (signal) {
						if (signal instanceof BreakSignal) break;
						throw signal;
					}
				}
				return;
		}
	}
	private record(value: Value, node: Node): Record<string, Value> {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			value instanceof ThrowableValue
		)
			throw new LanguageError(node.span, "Expected struct value");
		return value;
	}
	private array(value: Value, node: Node): Value[] {
		if (!Array.isArray(value))
			throw new LanguageError(node.span, "Expected array value");
		return value;
	}
	private index(value: Value, array: Value[], node: Node): number {
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < 0 ||
			value >= array.length
		)
			throw new LanguageError(node.span, "Array index out of bounds");
		return value;
	}
	private async lvalue(
		expression: Expression,
		env: Environment,
	): Promise<Cell> {
		if (expression.kind === "identifier") return env.get(expression.name);
		if (expression.kind === "member") {
			const object = this.record(
				await this.expression(expression.object, env),
				expression,
			);
			return {
				get: () => object[expression.name]!,
				set: (value) => {
					object[expression.name] = clone(value, false);
				},
			};
		}
		if (expression.kind === "index") {
			const object = this.array(
				await this.expression(expression.object, env),
				expression,
			);
			const index = this.index(
				await this.expression(expression.index, env),
				object,
				expression,
			);
			return {
				get: () => object[index]!,
				set: (value) => {
					object[index] = clone(value, false);
				},
			};
		}
		throw new LanguageError(expression.span, "Expected mutable storage");
	}
	private integer(value: number, node: Node): number {
		if (
			!Number.isInteger(value) ||
			value < -2147483648 ||
			value > 2147483647
		)
			throw new LanguageError(node.span, "int32 arithmetic overflow");
		// int32 has one zero; do not leak the host's floating-point negative zero.
		return value === 0 ? 0 : value;
	}
	private async expression(
		expression: Expression,
		env: Environment,
	): Promise<Value> {
		this.tick(expression);
		switch (expression.kind) {
			case "literal":
				return expression.value;
			case "identifier":
				return env.get(expression.name).get();
			case "snapshot":
				return snapshot(await this.expression(expression.value, env));
			case "raise": {
				const value = await this.expression(expression.value, env);
				throw new ReturnSignal(
					value instanceof ThrowableValue
						? value
						: new ThrowableValue(value as string),
				);
			}
			case "cast":
				return project(
					await this.expression(expression.value, env),
					substitute(
						this.program.projections.get(expression)!,
						env.typeBindings,
					),
				);
			case "type-argument":
				throw new LanguageError(
					expression.span,
					"Compile-time types cannot be evaluated",
				);
			case "update": {
				const cell = await this.lvalue(expression.target, env);
				const value = cell.get() as number;
				cell.set(this.integer(value + 1, expression));
				return value;
			}
			case "block":
				return this.block(expression, env);
			case "array": {
				const values: Value[] = [];
				for (const element of expression.elements)
					values.push(await this.expression(element, env));
				return values;
			}
			case "struct": {
				const value: Record<string, Value> = Object.create(
					null,
				) as Record<string, Value>;
				for (const field of expression.fields)
					value[field.name] = await this.expression(field.value, env);
				return value;
			}
			case "member": {
				const object = await this.expression(expression.object, env);
				if (Array.isArray(object) && expression.name === "length")
					return object.length;
				if (
					object instanceof ThrowableValue &&
					expression.name === "message"
				)
					return object.message;
				return this.record(object, expression)[expression.name]!;
			}
			case "index": {
				const object = this.array(
					await this.expression(expression.object, env),
					expression,
				);
				return object[
					this.index(
						await this.expression(expression.index, env),
						object,
						expression,
					)
				]!;
			}
			case "call": {
				const called = this.program.calls.get(expression)!;
				if (called.intrinsic === "trycast") {
					const value = await this.expression(
						expression.args[1]!.value,
						env,
					);
					const target = substitute(
						this.program.projections.get(expression)!,
						env.typeBindings,
					);
					try {
						return project(value, target);
					} catch (error) {
						if (!(error instanceof ProjectionError)) throw error;
						return new ThrowableValue(`trycast: ${error.message}`);
					}
				}
				const args: (Value | Cell)[] = [];
				for (const [index, arg] of expression.args.entries())
					args.push(
						called.declaration.params[index]!.mutable
							? await this.lvalue(arg.value, env)
							: await this.expression(arg.value, env),
					);
				return this.call(called, args, env.typeBindings);
			}
			case "unary": {
				const operand = await this.expression(expression.operand, env);
				return expression.op === "!"
					? !operand
					: this.integer(-(operand as number), expression);
			}
			case "binary": {
				const left = await this.expression(expression.left, env);
				if (expression.op === "&&" && left === false) return false;
				if (expression.op === "||" && left === true) return true;
				const right = await this.expression(expression.right, env),
					a = left as number,
					b = right as number;
				switch (expression.op) {
					case "+":
						return typeof left === "string"
							? left + (right as string)
							: this.integer(a + b, expression);
					case "-":
						return this.integer(a - b, expression);
					case "*":
						return this.integer(a * b, expression);
					case "/":
					case "%":
						if (b === 0)
							throw new LanguageError(
								expression.span,
								"Division by zero",
							);
						return this.integer(
							expression.op === "/" ? Math.trunc(a / b) : a % b,
							expression,
						);
					case "==":
						return left === right;
					case "!=":
						return left !== right;
					case "<":
						return a < b;
					case "<=":
						return a <= b;
					case ">":
						return a > b;
					case ">=":
						return a >= b;
					case "&&":
						return right;
					case "||":
						return right;
				}
				throw new LanguageError(expression.span, "Unknown operator");
			}
			case "if":
				return (await this.expression(expression.condition, env))
					? this.block(expression.then, env)
					: expression.otherwise
						? this.block(expression.otherwise, env)
						: null;
			case "match": {
				const value = await this.expression(expression.value, env);
				for (const arm of expression.arms) {
					if (
						arm.type &&
						!matches(
							value,
							substitute(
								this.program.matchTypes.get(arm.type)!,
								env.typeBindings,
							),
						)
					)
						continue;
					const branch = new Environment(env);
					if (expression.value.kind === "identifier")
						branch.bind(expression.value.name, value, false);
					if (arm.binding) branch.bind(arm.binding, value, false);
					return this.expression(arm.body, branch);
				}
				throw new LanguageError(
					expression.span,
					"No runtime match arm",
				);
			}
			case "handle": {
				const value = await this.expression(expression.value, env);
				if (!(value instanceof ThrowableValue)) return value;
				const handler = new Environment(env);
				handler.bind(expression.binding, value, false);
				return this.block(expression.body, handler);
			}
		}
	}
}
