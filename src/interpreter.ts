import { LanguageError } from "./ast.js";
import type { Block, Expression, Node, Statement } from "./ast.js";
import type { CheckedProgram, FunctionInfo } from "./checker.js";
import type { NativeCell, NativeRegistry } from "./native.js";
import { substitute, variants, projectionAlternative, VOID } from "./types.js";
import type { Type } from "./types.js";
import {
	integerOperation,
	isIntegerType,
	isNumericType,
	numericCast,
	roundFloat,
	safeHostInteger,
} from "./numeric.js";
import {
	clone,
	freezeOwned,
	FutureValue,
	getMemberType,
	setMemberType,
	matches,
	project,
	ProjectionError,
	snapshot,
	ThrowableValue,
} from "./values.js";
import type { Value } from "./values.js";
type Cell = NativeCell & {
	getType?: () => Type;
	setType?: (type: Type) => void;
};
interface RuntimeResult {
	value: Value;
	type: Type;
}
class Environment {
	readonly cells = new Map<string, Cell>();
	readonly evaluatedTypes = new WeakMap<Expression, Type>();
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
	bind(name: string, value: Value, mutable: boolean, type: Type): void {
		let stored = mutable ? clone(value, false) : freezeOwned(value);
		let storedType = type;
		this.cells.set(name, {
			get: () => stored,
			set: (next) => {
				if (!mutable) throw new Error("Readonly cell");
				stored = clone(next, false);
			},
			getType: () => storedType,
			setType: (next) => {
				storedType = next;
			},
		});
	}
	view(name: string, value: Value, type: Type): void {
		this.cells.set(name, {
			get: () => value,
			getType: () => type,
			set: () => {
				throw new Error("Readonly view");
			},
		});
	}
}
class ReturnSignal {
	constructor(
		readonly value: Value,
		readonly type: Type,
	) {}
}
class BreakSignal {}
export interface RunOptions {
	maxSteps?: number;
}
export class Interpreter {
	private steps = 0;
	private readonly maxSteps: number;
	private readonly futureTypes = new WeakMap<FutureValue, Type>();
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
		const { value } = await this.call(
			this.program.functions
				.get(this.program.program.entry)!
				.get("main")!,
			[],
		);
		return value instanceof FutureValue ? value.take() : value;
	}
	private tick(node: Node): void {
		if (++this.steps > this.maxSteps)
			throw new LanguageError(node.span, "Execution step limit exceeded");
	}
	private async call(
		fn: FunctionInfo,
		args: (Value | Cell)[],
		callerTypes: ReadonlyMap<string, Type> = new Map(),
	): Promise<RuntimeResult> {
		if (fn.declaration.async) {
			const future = new FutureValue(
				async () => {
					const result = await this.execute(fn, args, callerTypes);
					this.futureTypes.set(future, result.type);
					return result.value;
				},
				substitute(fn.result, callerTypes),
				fn.declaration.span,
			);
			return {
				value: future,
				type: {
					kind: "future",
					result: substitute(fn.result, callerTypes),
				},
			};
		}
		return this.execute(fn, args, callerTypes);
	}
	private async execute(
		fn: FunctionInfo,
		args: (Value | Cell)[],
		callerTypes: ReadonlyMap<string, Type>,
	): Promise<RuntimeResult> {
		this.tick(fn.declaration);
		if (fn.declaration.native) {
			return this.native.callTyped(fn, args, callerTypes);
		}
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
			else
				env.view(
					parameter.name,
					args[index] as Value,
					getMemberType(args, index) ??
						substitute(fn.params[index]!, callerTypes),
				);
		});
		let value: Value;
		let type: Type;
		try {
			value = await this.block(fn.declaration.body!, env);
			type = this.dynamicType(fn.declaration.body!, env);
		} catch (signal) {
			if (!(signal instanceof ReturnSignal)) throw signal;
			value = signal.value;
			type = signal.type;
		}
		if (!matches(value, substitute(fn.result, callerTypes)))
			throw new LanguageError(
				fn.declaration.span,
				"Function result violates its checked type",
			);
		return { value: freezeOwned(value), type };
	}
	private async block(block: Block, parent: Environment): Promise<Value> {
		const env = new Environment(parent);
		for (const statement of block.statements)
			await this.statement(statement, env);
		const value = block.tail
			? await this.expression(block.tail, env)
			: null;
		parent.evaluatedTypes.set(
			block,
			block.tail ? this.dynamicType(block.tail, env) : VOID,
		);
		return value;
	}
	private async statement(
		statement: Statement,
		env: Environment,
	): Promise<void> {
		this.tick(statement);
		switch (statement.kind) {
			case "let": {
				const value = await this.expression(statement.value, env);
				env.bind(
					statement.name,
					value,
					statement.mutable,
					this.dynamicType(statement.value, env),
				);
				return;
			}
			case "assign": {
				const cell = await this.lvalue(statement.target, env);
				cell.set(await this.expression(statement.value, env));
				cell.setType?.(this.dynamicType(statement.value, env));
				return;
			}
			case "return":
				throw new ReturnSignal(
					statement.value
						? await this.expression(statement.value, env)
						: null,
					statement.value
						? this.dynamicType(statement.value, env)
						: VOID,
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
			value instanceof FutureValue ||
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
			typeof value !== "bigint" ||
			value < 0n ||
			value >= BigInt(array.length)
		)
			throw new LanguageError(node.span, "Array index out of bounds");
		return safeHostInteger(value);
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
				getType: () =>
					getMemberType(object, expression.name) ??
					this.staticType(expression, env),
				setType: (type) => setMemberType(object, expression.name, type),
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
				getType: () =>
					getMemberType(object, index) ??
					this.staticType(expression, env),
				setType: (type) => setMemberType(object, index, type),
				set: (value) => {
					object[index] = clone(value, false);
				},
			};
		}
		throw new LanguageError(expression.span, "Expected mutable storage");
	}
	private staticType(expression: Expression, env: Environment): Type {
		return substitute(
			this.program.expressionTypes.get(expression) ?? VOID,
			env.typeBindings,
		);
	}
	private dynamicType(expression: Expression, env: Environment): Type {
		return (
			env.evaluatedTypes.get(expression) ??
			this.staticType(expression, env)
		);
	}
	private selectType(value: Value, type: Type): Type {
		if (type.kind !== "union") return type;
		const numericCandidates = variants(type).filter((member) =>
			typeof value === "bigint"
				? isIntegerType(member.kind)
				: typeof value === "number" &&
					isNumericType(member.kind) &&
					!isIntegerType(member.kind),
		);
		if (numericCandidates.length > 1)
			throw new Error("Missing concrete numeric runtime type");
		const candidates = variants(type).filter((member) =>
			matches(value, member),
		);
		if (candidates.length === 1) return candidates[0]!;
		// A numeric union must be selected through its producing expression,
		// never from the magnitude of a bigint or the precision of a number.
		if (candidates.some((member) => isNumericType(member.kind)))
			throw new Error("Missing concrete numeric runtime type");
		return candidates[0] ?? type;
	}
	private projectedType(value: Value, target: Type, source: Type): Type {
		if (target.kind === "union") {
			const selected = projectionAlternative(
				target.members.filter((member) =>
					matches(value, member, source),
				),
			);
			return selected
				? this.projectedType(value, selected, source)
				: target;
		}
		return target;
	}
	private async expression(
		expression: Expression,
		env: Environment,
	): Promise<Value> {
		this.tick(expression);
		env.evaluatedTypes.delete(expression);
		try {
			const value = await this.evaluate(expression, env);
			if (!env.evaluatedTypes.has(expression))
				env.evaluatedTypes.set(
					expression,
					this.selectType(value, this.staticType(expression, env)),
				);
			return value;
		} catch (error) {
			if (error instanceof RangeError)
				throw new LanguageError(expression.span, error.message);
			throw error;
		}
	}
	private async evaluate(
		expression: Expression,
		env: Environment,
	): Promise<Value> {
		switch (expression.kind) {
			case "literal": {
				const type = this.staticType(expression, env);
				return typeof expression.value === "number" &&
					(type.kind === "float32" || type.kind === "float64")
					? roundFloat(expression.value, type.kind)
					: expression.value;
			}
			case "identifier": {
				const cell = env.get(expression.name);
				env.evaluatedTypes.set(
					expression,
					cell.getType?.() ?? this.staticType(expression, env),
				);
				return cell.get();
			}
			case "snapshot":
			case "read": {
				const value = await this.expression(expression.value, env);
				env.evaluatedTypes.set(
					expression,
					this.dynamicType(expression.value, env),
				);
				return expression.kind === "snapshot" ? snapshot(value) : value;
			}
			case "await": {
				const future = await this.expression(expression.value, env);
				if (!(future instanceof FutureValue))
					throw new LanguageError(
						expression.span,
						"await requires a Future",
					);
				const value = await future.take();
				env.evaluatedTypes.set(
					expression,
					this.futureTypes.get(future) ??
						this.selectType(
							value,
							this.staticType(expression, env),
						),
				);
				return value;
			}
			case "raise": {
				const value = await this.expression(expression.value, env);
				throw new ReturnSignal(
					value instanceof ThrowableValue
						? value
						: new ThrowableValue(value as string),
					{ kind: "throwable" },
				);
			}
			case "cast": {
				const value = await this.expression(expression.value, env);
				const target = substitute(
					this.program.projections.get(expression)!,
					env.typeBindings,
				);
				const source = this.dynamicType(expression.value, env);
				if (isNumericType(source.kind) && isNumericType(target.kind))
					return numericCast(
						value as bigint | number,
						source.kind,
						target.kind,
					);
				const projected = project(value, target, source);
				env.evaluatedTypes.set(
					expression,
					this.projectedType(projected, target, source),
				);
				return projected;
			}
			case "type-argument":
				throw new LanguageError(
					expression.span,
					"Compile-time types cannot be evaluated",
				);
			case "update": {
				const cell = await this.lvalue(expression.target, env);
				const value = cell.get();
				const type =
					cell.getType?.() ?? this.staticType(expression.target, env);
				if (isIntegerType(type.kind))
					cell.set(
						integerOperation(
							expression.op ?? "++",
							value as bigint,
							0n,
							type.kind,
						),
					);
				else if (type.kind === "float32" || type.kind === "float64")
					cell.set(
						roundFloat(
							(value as number) +
								(expression.op === "--" ? -1 : 1),
							type.kind,
						),
					);
				else
					throw new LanguageError(
						expression.span,
						"Update requires a numeric value",
					);
				env.evaluatedTypes.set(expression, type);
				return value;
			}
			case "block":
				return this.block(expression, env);
			case "array": {
				const values: Value[] = [];
				for (const element of expression.elements) {
					values.push(await this.expression(element, env));
					setMemberType(
						values,
						values.length - 1,
						this.dynamicType(element, env),
					);
				}
				return values;
			}
			case "struct": {
				const value: Record<string, Value> = Object.create(
					null,
				) as Record<string, Value>;
				for (const field of expression.fields) {
					value[field.name] = await this.expression(field.value, env);
					setMemberType(
						value,
						field.name,
						this.dynamicType(field.value, env),
					);
				}
				return value;
			}
			case "member": {
				const object = await this.expression(expression.object, env);
				if (
					object instanceof ThrowableValue &&
					expression.name === "message"
				)
					return object.message;
				const record = this.record(object, expression);
				const type = getMemberType(record, expression.name);
				if (type) env.evaluatedTypes.set(expression, type);
				return record[expression.name]!;
			}
			case "index": {
				const object = this.array(
					await this.expression(expression.object, env),
					expression,
				);
				const index = this.index(
					await this.expression(expression.index, env),
					object,
					expression,
				);
				const type = getMemberType(object, index);
				if (type) env.evaluatedTypes.set(expression, type);
				return object[index]!;
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
						const source = this.dynamicType(
							expression.args[1]!.value,
							env,
						);
						const result = project(value, target, source);
						env.evaluatedTypes.set(
							expression,
							this.projectedType(result, target, source),
						);
						return result;
					} catch (error) {
						if (!(error instanceof ProjectionError)) throw error;
						return new ThrowableValue(`trycast: ${error.message}`);
					}
				}
				const args: (Value | Cell)[] = [];
				for (const [index, arg] of expression.args.entries()) {
					args.push(
						called.declaration.params[index]!.mutable
							? await this.lvalue(arg.value, env)
							: await this.expression(arg.value, env),
					);
					setMemberType(
						args,
						index,
						called.declaration.params[index]!.mutable
							? ((args[index] as Cell).getType?.() ??
									this.staticType(arg.value, env))
							: this.dynamicType(arg.value, env),
					);
				}
				const result = await this.call(called, args, env.typeBindings);
				env.evaluatedTypes.set(expression, result.type);
				return result.value;
			}
			case "unary": {
				const operand = await this.expression(expression.operand, env);
				if (expression.op === "!") return !operand;
				const type = this.staticType(expression, env);
				if (isIntegerType(type.kind))
					return integerOperation(
						"negate",
						operand as bigint,
						0n,
						type.kind,
					);
				if (type.kind === "float32" || type.kind === "float64")
					return roundFloat(-(operand as number), type.kind);
				throw new LanguageError(
					expression.span,
					"Unary minus requires a numeric value",
				);
			}
			case "binary": {
				const left = await this.expression(expression.left, env);
				if (expression.op === "&&" && left === false) return false;
				if (expression.op === "||" && left === true) return true;
				const right = await this.expression(expression.right, env);
				if (["+", "-", "*", "/", "%"].includes(expression.op)) {
					if (expression.op === "+" && typeof left === "string")
						return left + (right as string);
					const type = this.staticType(expression, env);
					if (isIntegerType(type.kind))
						return integerOperation(
							expression.op,
							left as bigint,
							right as bigint,
							type.kind,
						);
					if (type.kind === "float32" || type.kind === "float64") {
						const a = left as number,
							b = right as number;
						const value =
							expression.op === "+"
								? a + b
								: expression.op === "-"
									? a - b
									: expression.op === "*"
										? a * b
										: expression.op === "/"
											? a / b
											: a % b;
						return roundFloat(value, type.kind);
					}
					throw new LanguageError(
						expression.span,
						"Arithmetic requires numeric values",
					);
				}
				const a = left as bigint | number,
					b = right as bigint | number;
				switch (expression.op) {
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
			case "if": {
				const branch = (await this.expression(
					expression.condition,
					env,
				))
					? expression.then
					: expression.otherwise;
				const value = branch ? await this.block(branch, env) : null;
				env.evaluatedTypes.set(
					expression,
					branch ? this.dynamicType(branch, env) : VOID,
				);
				return value;
			}
			case "match": {
				const value = await this.expression(expression.value, env);
				const actual = this.dynamicType(expression.value, env);
				for (const arm of expression.arms) {
					if (
						arm.type &&
						!matches(
							value,
							substitute(
								this.program.matchTypes.get(arm.type)!,
								env.typeBindings,
							),
							actual,
						)
					)
						continue;
					const branch = new Environment(env);
					if (expression.value.kind === "identifier")
						branch.view(expression.value.name, value, actual);
					if (arm.binding) branch.view(arm.binding, value, actual);
					const result = await this.expression(arm.body, branch);
					env.evaluatedTypes.set(
						expression,
						this.dynamicType(arm.body, branch),
					);
					return result;
				}
				throw new LanguageError(
					expression.span,
					"No runtime match arm",
				);
			}
			case "handle": {
				const value = await this.expression(expression.value, env);
				if (!(value instanceof ThrowableValue)) {
					env.evaluatedTypes.set(
						expression,
						this.dynamicType(expression.value, env),
					);
					return value;
				}
				const handler = new Environment(env);
				handler.bind(expression.binding, value, false, {
					kind: "throwable",
				});
				const result = await this.block(expression.body, handler);
				env.evaluatedTypes.set(
					expression,
					this.dynamicType(expression.body, handler),
				);
				return result;
			}
		}
	}
}
