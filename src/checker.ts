import { LanguageError } from "./ast.js";
import type {
	Block,
	Declaration,
	Expression,
	Node,
	Statement,
	TypeNode,
} from "./ast.js";
import type { Program, SourceModule } from "./modules.js";
import { declarations } from "./modules.js";
import {
	assignable,
	substitute,
	BOOL,
	builtins,
	containsTSAny,
	containsFuture,
	describe,
	equivalent,
	INT32,
	NEVER,
	overlaps,
	STRING,
	THROWABLE,
	TSANY,
	TYPE,
	INTRINSIC,
	projectable,
	patternCovers,
	union,
	variants,
	VOID,
} from "./types.js";
import type { Type } from "./types.js";
import { SemanticIndex } from "./semantic.js";
import type { SemanticSymbol, SymbolKind } from "./semantic.js";
import type { SourceRange } from "./source.js";
import { arrayNativeOperation, arraySignature } from "./array-abi.js";
import type { ArrayNative } from "./array-abi.js";
import { checkSafety } from "./safety.js";
import {
	assertIntegerRange,
	integerOperation,
	isIntegerType,
	isNumericType,
	numericCast,
} from "./numeric.js";
import type { IntegerType, NumericType } from "./numeric.js";

export type FunctionDeclaration = Extract<Declaration, { kind: "function" }>;
export interface FunctionInfo {
	declaration: FunctionDeclaration;
	module: SourceModule;
	params: Type[];
	result: Type;
	intrinsic?: "trycast" | ArrayNative;
	typeBindings?: ReadonlyMap<string, Type>;
}
interface Binding {
	type: Type;
	mutable: boolean;
	borrowed: boolean;
	sourceMutable?: boolean;
	symbol?: SemanticSymbol;
}
type Exit = "return" | "break";
interface Info {
	type: Type;
	borrowed: boolean;
	mutable: boolean;
	exits: Set<Exit>;
}
const info = (
	type: Type,
	borrowed = false,
	exits: Iterable<Exit> = [],
	mutable = borrowed,
): Info => ({
	type,
	borrowed: type.kind !== "never" && borrowed,
	mutable: type.kind !== "never" && mutable,
	exits: new Set(exits),
});
const exits = (...values: Info[]): Set<Exit> =>
	new Set(values.flatMap((value) => [...value.exits]));
class Scope {
	readonly bindings = new Map<string, Binding>();
	readonly index: SemanticIndex | undefined;
	constructor(
		readonly parent: Scope | null = null,
		index?: SemanticIndex,
		readonly range?: SourceRange,
	) {
		this.index = index ?? parent?.index;
	}
	get(name: string): Binding | undefined {
		return this.bindings.get(name) ?? this.parent?.get(name);
	}
	add(
		name: string,
		binding: Binding,
		node: Node,
		kind: SymbolKind = "variable",
	): void {
		if (this.bindings.has(name))
			throw new LanguageError(
				node.span,
				`Duplicate binding '${name}'`,
				node.nameRange ?? node.range,
			);
		this.bindings.set(name, binding);
		const symbol = this.index?.define(node, name, kind, this.range, {
			type: binding.type,
			mutable: binding.mutable,
			visibleFrom:
				kind === "variable"
					? (node.range?.end ?? node.nameRange?.end ?? 0)
					: (this.range?.start ?? 0),
			detail: `${binding.mutable ? "mut " : ""}${name}: ${describe(binding.type)}`,
		});
		if (symbol) binding.symbol = symbol;
	}
}
export class CheckedProgram {
	readonly semantic: SemanticIndex;
	readonly functions = new Map<SourceModule, Map<string, FunctionInfo>>();
	readonly types = new Map<SourceModule, Map<string, Type>>();
	readonly expressionTypes = new WeakMap<Expression, Type>();
	private readonly constantNumbers = new WeakMap<
		Expression,
		bigint | number
	>();
	readonly matchTypes = new WeakMap<TypeNode, Type>();
	readonly calls = new WeakMap<Expression, FunctionInfo>();
	readonly projections = new WeakMap<Expression, Type>();
	private readonly symbols = new Map<
		SourceModule,
		ReturnType<typeof declarations>
	>();
	private readonly resolving = new Set<Declaration>();
	private readonly parameterScopes = new WeakMap<
		Declaration,
		Map<string, Type>
	>();
	private readonly parameterSymbols = new Map<string, SemanticSymbol>();
	private recovering = false;
	private activeTypeParameters: ReadonlyMap<string, Type> = new Map();
	constructor(readonly program: Program) {
		this.semantic = new SemanticIndex(program);
	}
	get editorOnly(): boolean {
		return this.recovering || this.program.editorOnly === true;
	}
	check(options: CheckOptions = {}): this {
		if (this.program.editorOnly && !options.editorRecovery)
			throw new Error(
				"Recovered editor ASTs cannot be compiled for execution",
			);
		this.recovering = options.editorRecovery ?? false;
		for (const module of this.program.modules) {
			this.symbols.set(module, declarations(module));
			this.types.set(module, new Map());
			this.functions.set(module, new Map());
			for (const declaration of module.ast.declarations) {
				if (declaration.kind !== "use")
					this.defineTypeParameters(declaration, module);
				this.semantic.define(
					declaration,
					declaration.kind === "use"
						? declaration.alias
						: declaration.name,
					declaration.kind === "use" ? "module" : declaration.kind,
					module.ast.range,
					declaration.kind === "use"
						? {
								targetModule: module.imports.get(
									declaration.alias,
								)!,
								detail: `use "${declaration.path}" as ${declaration.alias}`,
							}
						: {
								public: declaration.public,
								hidden:
									declaration.kind === "function"
										? declaration.native
										: declaration.compilerOnly,
							},
				);
				if (
					declaration.kind !== "use" &&
					(builtins.has(declaration.name) ||
						["Array", "Future"].includes(declaration.name)) &&
					!(
						declaration.kind === "type" &&
						declaration.name === "Type" &&
						declaration.compilerOnly &&
						module.trusted &&
						module.id === "std/typing"
					)
				)
					this.fail(
						declaration,
						"Builtin type names cannot be redeclared",
					);
			}
		}
		for (const module of this.program.modules) {
			for (const declaration of module.ast.declarations) {
				if (declaration.kind === "type") {
					try {
						this.namedType(module, declaration.name, declaration, [
							...this.parameterScopes.get(declaration)!.values(),
						]);
					} catch (error) {
						this.recoverError(error);
					}
				}
			}
			for (const declaration of module.ast.declarations) {
				if (declaration.kind !== "function") continue;
				this.activeTypeParameters =
					this.parameterScopes.get(declaration)!;
				try {
					if (
						module.trusted &&
						module.id === "std/typing" &&
						declaration.name === "trycast"
					) {
						if (
							!declaration.public ||
							declaration.native ||
							declaration.async ||
							declaration.body ||
							declaration.params.length !== 2 ||
							declaration.params.some((param) => param.mutable) ||
							declaration.params[0]!.type.kind !== "name" ||
							declaration.params[0]!.type.name !== "Type" ||
							declaration.params[1]!.type.kind !== "name" ||
							declaration.params[1]!.type.name !== "intrinsic" ||
							declaration.result.kind !== "name" ||
							declaration.result.name !== "intrinsic"
						)
							this.fail(
								declaration,
								"Invalid compiler intrinsic trycast signature",
							);
						this.functions.get(module)!.set(declaration.name, {
							declaration,
							module,
							params: [TYPE, INTRINSIC],
							result: INTRINSIC,
							intrinsic: "trycast",
						});
						this.semantic.update(
							declaration,
							undefined,
							"fn trycast(target: Type, value: readonly value) -> T | throwable (T = target)",
						);
						continue;
					}
					const arrayAPI = arrayNativeOperation(
						module,
						declaration.name,
					);
					if (!declaration.native && !declaration.body && !arrayAPI)
						this.fail(
							declaration,
							"Only compiler intrinsic APIs may omit a function body",
						);
					const params = declaration.params.map((param) =>
							this.resolveType(module, param.type),
						),
						result = this.resolveType(module, declaration.result);
					if (
						declaration.params.some(
							(p, i) => p.mutable && containsFuture(params[i]!),
						)
					)
						this.fail(
							declaration,
							"Future and containers holding Future cannot be mutable",
						);
					if (
						declaration.async &&
						(declaration.native ||
							declaration.params.some((p) => p.mutable))
					)
						this.fail(
							declaration,
							"Async functions cannot retain mutable borrows or be native",
						);
					if (
						declaration.native &&
						(params.some(containsFuture) || containsFuture(result))
					)
						this.fail(
							declaration,
							"The copying Native Bridge cannot accept or return Future-containing types",
						);
					if (arrayAPI) {
						const formal = [...this.activeTypeParameters.values()];
						const signature = arraySignature(
							arrayAPI,
							formal[0] ?? NEVER,
						);
						if (
							formal.length !== 1 ||
							declaration.public ||
							!declaration.native ||
							declaration.async ||
							declaration.body ||
							params.length !== signature.params.length ||
							!equivalent(result, signature.result) ||
							params.some(
								(p, i) =>
									!equivalent(p, signature.params[i]!) ||
									declaration.params[i]!.mutable !==
										signature.mutable[i],
							)
						)
							this.fail(
								declaration,
								"Invalid array native signature",
							);
						this.functions.get(module)!.set(declaration.name, {
							declaration,
							module,
							params,
							result,
							intrinsic: `array.${arrayAPI}`,
						});
						this.semantic.update(
							declaration,
							undefined,
							`fn ${declaration.name}<T>(${declaration.params.map((p, i) => `${p.mutable ? "mut " : ""}${p.name}: ${describe(params[i]!)}`).join(", ")}) -> ${describe(result)}`,
						);
						continue;
					}
					if (
						containsTSAny(result) ||
						(params.some((type) => containsTSAny(type)) &&
							(!declaration.native ||
								params.some(
									(type) =>
										containsTSAny(type) &&
										type.kind !== "tsany",
								)))
					) {
						this.fail(
							declaration,
							"TSAny is allowed only as a direct private native input parameter",
						);
					}
					if (
						declaration.native &&
						(!module.trusted ||
							!module.id.startsWith("std/internal/") ||
							declaration.public)
					)
						this.fail(
							declaration,
							"native fn must be private in a trusted std/internal module",
						);
					if (
						declaration.native &&
						declaration.params.some((param) => param.mutable)
					)
						this.fail(
							declaration,
							"Native mutable parameters are not supported",
						);
					if (declaration.public && containsTSAny(result))
						this.fail(
							declaration,
							"Public signatures cannot expose TSAny",
						);
					this.functions.get(module)!.set(declaration.name, {
						declaration,
						module,
						params,
						result,
					});
					this.semantic.update(
						declaration,
						undefined,
						`${declaration.async ? "async " : ""}fn ${declaration.name}${this.parameterLabel(declaration)}(${declaration.params.map((parameter, index) => `${parameter.mutable ? "mut " : ""}${parameter.name}: ${describe(params[index]!)}`).join(", ")}) -> ${describe(result)}`,
					);
				} catch (error) {
					this.recoverError(error);
				}
			}
		}
		for (const module of this.program.modules)
			for (const fn of this.functions.get(module)!.values()) {
				if (!fn.declaration.body) continue;
				this.activeTypeParameters = this.parameterScopes.get(
					fn.declaration,
				)!;
				try {
					const scope = new Scope(
						null,
						this.semantic,
						fn.declaration.body.range,
					);
					fn.declaration.params.forEach((param, index) =>
						scope.add(
							param.name,
							{
								type: fn.params[index]!,
								mutable: param.mutable,
								borrowed:
									param.mutable ||
									(!containsFuture(fn.params[index]!) &&
										variants(fn.params[index]!).some(
											(type) =>
												type.kind === "struct" ||
												type.kind === "array",
										)),
							},
							param,
							"parameter",
						),
					);
					const body = this.block(
						fn.declaration.body,
						scope,
						module,
						fn,
						0,
						fn.result,
					);
					this.require(body.type, fn.result, fn.declaration.body);
					if (body.borrowed && body.type.kind !== "never")
						this.fail(
							fn.declaration.body,
							"Returning borrowed storage requires snapshot",
						);
				} catch (error) {
					this.recoverError(error);
				}
			}
		this.activeTypeParameters = new Map();
		if (!this.recovering) checkSafety(this);
		if (options.requireEntryPoint ?? true) this.checkEntryPoint();
		return this;
	}
	checkEntryPoint(): void {
		const main = this.functions.get(this.program.entry)!.get("main");
		if (
			!main ||
			(main.declaration.typeParams?.length ?? 0) > 0 ||
			main.params.length ||
			!["void", "int32"].includes(main.result.kind)
		)
			this.fail(
				this.program.entry.ast,
				"Entry point must be fn main() -> void or int32",
			);
	}
	private recoverError(error: unknown): void {
		if (!this.recovering || !(error instanceof LanguageError)) throw error;
		this.resolving.clear();
	}
	private fail(node: Node, message: string): never {
		throw new LanguageError(
			node.span,
			message,
			node.nameRange ?? node.range,
		);
	}
	private require(actual: Type, expected: Type, node: Node): void {
		if (!assignable(actual, expected))
			this.fail(
				node,
				`Expected ${describe(expected)}, got ${describe(actual)}`,
			);
	}
	private parameterLabel(
		declaration: Exclude<Declaration, { kind: "use" }>,
	): string {
		return declaration.typeParams?.length
			? "<" + declaration.typeParams.map((p) => p.name).join(", ") + ">"
			: "";
	}
	private defineTypeParameters(
		declaration: Exclude<Declaration, { kind: "use" }>,
		module: SourceModule,
	): void {
		const scope = new Map<string, Type>();
		for (const parameter of declaration.typeParams ?? []) {
			if (scope.has(parameter.name))
				this.fail(
					parameter,
					"Duplicate type parameter '" + parameter.name + "'",
				);
			if (
				builtins.has(parameter.name) ||
				["Array", "Future", "TSAny", "intrinsic"].includes(
					parameter.name,
				)
			)
				this.fail(
					parameter,
					"Builtin type names cannot be redeclared as type parameters",
				);
			const id =
				parameter.span.file +
				":" +
				(parameter.nameRange?.start ??
					parameter.span.line + ":" + parameter.span.column);
			const type: Type = { kind: "parameter", id, name: parameter.name };
			scope.set(parameter.name, type);
			const symbol = this.semantic.define(
				parameter,
				parameter.name,
				"type",
				declaration.range,
				{ type, detail: "type parameter " + parameter.name },
			);
			if (symbol) this.parameterSymbols.set(id, symbol);
		}
		if (
			scope.size &&
			((declaration.kind === "type" && declaration.compilerOnly) ||
				(declaration.kind === "function" &&
					declaration.native &&
					!arrayNativeOperation(module, declaration.name)))
		)
			this.fail(
				declaration,
				"Compiler-only and native declarations cannot be generic",
			);
		this.parameterScopes.set(declaration, scope);
	}
	/** Explicit instantiation is shared by calls and editor signature help. */
	instantiate(
		fn: FunctionInfo,
		args: TypeNode[],
		module: SourceModule,
		node: Node,
		parameters = this.activeTypeParameters,
	): FunctionInfo {
		const formal = [...this.parameterScopes.get(fn.declaration)!.values()];
		if (args.length !== formal.length)
			this.fail(
				node,
				"Expected " +
					formal.length +
					" explicit type arguments, got " +
					args.length,
			);
		const concrete = args.map((arg) =>
			this.resolveType(module, arg, parameters),
		);
		if (concrete.some(containsTSAny))
			this.fail(node, "TSAny cannot be a generic type argument");
		if (
			concrete.some(containsFuture) &&
			!(
				fn.intrinsic === "array.length" ||
				(fn.module.trusted &&
					["std/arr", "std/internal/arr"].includes(fn.module.id) &&
					fn.declaration.name === "length")
			)
		)
			this.fail(
				node,
				"Future is non-copyable; generic operations on Future-containing types are not supported",
			);
		const bindings = new Map(
			formal.map((parameter, index) => [
				(parameter as Extract<Type, { kind: "parameter" }>).id,
				concrete[index]!,
			]),
		);
		return {
			...fn,
			params: fn.params.map((type) => substitute(type, bindings)),
			result: substitute(fn.result, bindings),
			typeBindings: bindings,
		};
	}
	private namedType(
		module: SourceModule,
		name: string,
		node: Node,
		args: Type[] = [],
	): Type {
		const builtin = builtins.get(name);
		if (
			builtin &&
			!(name === "Type" && this.symbols.get(module)!.has(name))
		) {
			if (args.length)
				this.fail(node, "Builtin type does not accept type arguments");
			return builtin;
		}
		const cached = this.types.get(module)!.get(name);
		if (cached && !args.length) return cached;
		const declaration = this.symbols.get(module)!.get(name);
		if (!declaration || declaration.kind !== "type")
			return this.fail(node, `Unknown type '${name}'`);
		const parameters = this.parameterScopes.get(declaration)!;
		if (args.length !== parameters.size)
			this.fail(
				node,
				"Expected " +
					parameters.size +
					" explicit type arguments for " +
					name +
					", got " +
					args.length,
			);
		if (args.some(containsTSAny))
			this.fail(node, "TSAny cannot be a generic type argument");
		if (
			builtins.has(declaration.name) &&
			!(
				name === "Type" &&
				declaration.compilerOnly &&
				module.trusted &&
				module.id === "std/typing"
			)
		)
			this.fail(declaration, "Builtin type names cannot be redeclared");
		if (this.resolving.has(declaration))
			this.fail(
				declaration,
				"Recursive type aliases are not supported yet",
			);
		this.resolving.add(declaration);
		let resolved: Type;
		if (declaration.compilerOnly) {
			if (
				!module.trusted ||
				!(
					module.id.startsWith("std/internal/") ||
					(module.id === "std/typing" && name === "Type")
				) ||
				declaration.public ||
				!["TSAny", "Type"].includes(name) ||
				declaration.type.kind !== "name" ||
				declaration.type.name !== "intrinsic"
			)
				this.fail(
					declaration,
					"compilerOnly TSAny / Type = intrinsic is reserved for trusted compiler APIs",
				);
			resolved = name === "Type" ? TYPE : TSANY;
		} else {
			resolved = this.resolveType(
				module,
				declaration.type,
				new Map(
					[...parameters.keys()].map((key, index) => [
						key,
						args[index]!,
					]),
				),
			);
			if (containsTSAny(resolved))
				this.fail(
					declaration,
					"TSAny cannot be aliased into ordinary language types",
				);
		}
		this.resolving.delete(declaration);
		if (!parameters.size) this.types.get(module)!.set(name, resolved);
		if (
			!parameters.size ||
			args.every((arg, index) => arg === [...parameters.values()][index])
		)
			this.semantic.update(
				declaration,
				resolved,
				`type ${name}${this.parameterLabel(declaration)} = ${describe(resolved)}`,
			);
		return resolved;
	}
	resolveType(
		module: SourceModule,
		node: TypeNode,
		parameters = this.activeTypeParameters,
	): Type {
		switch (node.kind) {
			case "name": {
				const parameter = parameters.get(node.name);
				if (parameter) {
					if (node.typeArgs?.length)
						this.fail(
							node,
							"Type parameters do not accept type arguments",
						);
					if (parameter.kind === "parameter")
						this.semantic.reference(
							node,
							this.parameterSymbols.get(parameter.id),
							parameter,
						);
					return parameter;
				}
				const args = (node.typeArgs ?? []).map((arg) =>
					this.resolveType(module, arg, parameters),
				);
				if (node.name === "Future") {
					if (args.length !== 1)
						this.fail(
							node,
							"Future requires one explicit type argument",
						);
					const type: Type = { kind: "future", result: args[0]! };
					this.semantic.builtin(node, type);
					return type;
				}
				if (node.name === "Type" || node.name === "intrinsic")
					this.fail(
						node,
						"Type and intrinsic are compile-time only and cannot be used as runtime types",
					);
				const parts = node.name.split(".");
				if (parts.length === 1) {
					const type = this.namedType(module, node.name, node, args);
					const declaration = this.symbols
						.get(module)!
						.get(node.name);
					if (declaration)
						this.semantic.reference(
							node,
							this.semantic.definition(declaration),
							type,
						);
					else this.semantic.builtin(node, type);
					return type;
				}
				const imported = module.imports.get(parts[0]!);
				const declaration =
					imported && this.symbols.get(imported)!.get(parts[1]!);
				if (
					!imported ||
					!declaration ||
					declaration.kind !== "type" ||
					!declaration.public
				)
					return this.fail(
						node,
						`Unknown or private type '${node.name}'`,
					);
				const type = this.namedType(imported, parts[1]!, node, args);
				this.semantic.reference(
					node,
					this.semantic.definition(declaration),
					type,
				);
				const alias = module.ast.declarations.find(
					(item) => item.kind === "use" && item.alias === parts[0],
				);
				if (alias && node.qualifierRange)
					this.semantic.reference(
						node,
						this.semantic.definition(alias),
						undefined,
						node.qualifierRange,
					);
				return type;
			}
			case "array":
				return {
					kind: "array",
					element: this.resolveType(module, node.element, parameters),
				};
			case "union":
				return union(
					node.members.map((member) =>
						this.resolveType(module, member, parameters),
					),
				);
			case "struct": {
				const fields = new Map<string, Type>();
				for (const field of node.fields) {
					if (fields.has(field.name))
						this.fail(node, `Duplicate field '${field.name}'`);
					fields.set(
						field.name,
						this.resolveType(module, field.type, parameters),
					);
				}
				return { kind: "struct", fields };
			}
		}
	}
	private block(
		block: Block,
		parent: Scope,
		module: SourceModule,
		fn: FunctionInfo,
		loops: number,
		expected?: Type,
	): Info {
		const scope = new Scope(parent, this.semantic, block.range);
		let result = info(VOID);
		const accumulated = new Set<Exit>();
		for (const statement of block.statements) {
			try {
				if (result.type.kind === "never")
					this.fail(statement, "Unreachable statement");
				result = this.statement(statement, scope, module, fn, loops);
				result.exits.forEach((exit) => accumulated.add(exit));
			} catch (error) {
				this.recoverError(error);
			}
		}
		if (block.tail) {
			try {
				if (result.type.kind === "never")
					this.fail(block.tail, "Unreachable block tail");
				result = this.expression(
					block.tail,
					scope,
					module,
					fn,
					loops,
					expected,
				);
				result.exits.forEach((exit) => accumulated.add(exit));
			} catch (error) {
				this.recoverError(error);
			}
		}
		this.expressionTypes.set(block, result.type);
		return info(result.type, result.borrowed, accumulated, result.mutable);
	}
	private statement(
		statement: Statement,
		scope: Scope,
		module: SourceModule,
		fn: FunctionInfo,
		loops: number,
	): Info {
		switch (statement.kind) {
			case "let": {
				const expected = this.resolveType(module, statement.type);
				if (statement.mutable && containsFuture(expected))
					this.fail(
						statement,
						"Future and containers holding Future cannot be mutable",
					);
				if (containsTSAny(expected))
					this.fail(
						statement,
						"TSAny cannot be used for a language variable",
					);
				const value = this.expression(
					statement.value,
					scope,
					module,
					fn,
					loops,
					expected,
				);
				this.require(value.type, expected, statement.value);
				if (!statement.mutable && value.borrowed)
					this.fail(
						statement,
						"Retaining a mutable or borrowed value in an immutable binding requires snapshot",
					);
				scope.add(
					statement.name,
					{
						type: expected,
						mutable: statement.mutable,
						borrowed: statement.mutable,
					},
					statement,
				);
				return info(
					value.type.kind === "never" ? NEVER : VOID,
					false,
					value.exits,
				);
			}
			case "assign": {
				const target = this.lvalue(
						statement.target,
						scope,
						module,
						fn,
						loops,
					),
					value = this.expression(
						statement.value,
						scope,
						module,
						fn,
						loops,
						target.type,
					);
				this.require(value.type, target.type, statement.value);
				return info(
					value.type.kind === "never" ? NEVER : VOID,
					false,
					exits(target, value),
				);
			}
			case "return": {
				const value = statement.value
					? this.expression(
							statement.value,
							scope,
							module,
							fn,
							loops,
							fn.result,
						)
					: info(VOID);
				this.require(value.type, fn.result, statement);
				if (value.borrowed)
					this.fail(
						statement,
						"Returning borrowed storage requires snapshot",
					);
				return info(NEVER, false, [...value.exits, "return"]);
			}
			case "expression": {
				const value = this.expression(
					statement.expression,
					scope,
					module,
					fn,
					loops,
				);
				return info(
					value.type.kind === "never" ? NEVER : VOID,
					false,
					value.exits,
				);
			}
			case "break":
				if (!loops)
					return this.fail(
						statement,
						"break requires an enclosing loop",
					);
				else return info(NEVER, false, ["break"]);
			case "while": {
				const condition = this.expression(
					statement.condition,
					scope,
					module,
					fn,
					loops,
				);
				this.require(condition.type, BOOL, statement.condition);
				const body = this.block(
					statement.body,
					scope,
					module,
					fn,
					loops + 1,
				);
				const flow = exits(condition, body);
				flow.delete("break");
				return info(
					condition.type.kind === "never" ? NEVER : VOID,
					false,
					flow,
				);
			}
		}
	}
	private root(expression: Expression): string | null {
		if (expression.kind === "identifier") return expression.name;
		if (expression.kind === "member" || expression.kind === "index")
			return this.root(expression.object);
		return null;
	}
	private lvalue(
		expression: Expression,
		scope: Scope,
		module: SourceModule,
		fn: FunctionInfo,
		loops: number,
	): Info {
		const root = this.root(expression),
			binding = root && scope.get(root);
		if (!binding || !binding.mutable)
			return this.fail(
				expression,
				"Assignment or mut argument requires mutable storage (deep readonly)",
			);
		if (!["identifier", "member", "index"].includes(expression.kind))
			return this.fail(expression, "Expected assignable storage");
		// Array storage is opaque; normal struct members remain writable.
		if (expression.kind === "member") {
			const object = this.expression(
				expression.object,
				scope,
				module,
				fn,
				loops,
			);
			if (object.type.kind === "array")
				return this.fail(
					expression,
					"Arrays have no properties; use std/arr",
				);
			if (object.type.kind === "union")
				return this.fail(
					expression,
					"Writes through union members are not supported; replace the whole union value",
				);
		}
		return this.expression(expression, scope, module, fn, loops);
	}
	private function(
		expression: Expression,
		scope: Scope,
		module: SourceModule,
	): FunctionInfo {
		if (expression.kind === "identifier") {
			if (scope.get(expression.name))
				return this.fail(expression, "A value is not callable");
			const fn = this.functions.get(module)!.get(expression.name);
			if (fn) {
				this.semantic.reference(
					expression,
					this.semantic.definition(fn.declaration),
				);
				return fn;
			}
		}
		if (
			expression.kind === "member" &&
			expression.object.kind === "identifier" &&
			!scope.get(expression.object.name)
		) {
			const imported = module.imports.get(expression.object.name),
				fn =
					imported &&
					this.functions.get(imported)!.get(expression.name);
			if (fn?.declaration.public) {
				this.semantic.reference(
					expression,
					this.semantic.definition(fn.declaration),
				);
				const aliasName = expression.object.name;
				const alias = module.ast.declarations.find(
					(item) => item.kind === "use" && item.alias === aliasName,
				);
				if (alias)
					this.semantic.reference(
						expression.object,
						this.semantic.definition(alias),
					);
				return fn;
			}
		}
		return this.fail(expression, "Unknown or private function");
	}
	private expression(
		expression: Expression,
		scope: Scope,
		module: SourceModule,
		fn: FunctionInfo,
		loops: number,
		expected?: Type,
	): Info {
		const check = (value: Expression, target?: Type): Info =>
			this.expression(value, scope, module, fn, loops, target);
		let result: Info;
		switch (expression.kind) {
			case "literal": {
				const value = expression.value;
				const numeric = this.numericContext(expected);
				result = info(
					value === null
						? VOID
						: typeof value === "string"
							? STRING
							: typeof value === "boolean"
								? BOOL
								: typeof value === "bigint"
									? numeric && isIntegerType(numeric.kind)
										? numeric
										: INT32
									: numeric &&
										  ["float32", "float64"].includes(
												numeric.kind,
										  )
										? numeric
										: builtins.get("float64")!,
				);
				break;
			}
			case "identifier": {
				const binding = scope.get(expression.name);
				if (!binding)
					return this.fail(
						expression,
						`Unknown variable '${expression.name}'`,
					);
				result = info(
					binding.type,
					binding.borrowed,
					[],
					binding.mutable || binding.sourceMutable === true,
				);
				this.semantic.reference(
					expression,
					binding.symbol,
					binding.type,
					undefined,
					binding.mutable,
				);
				break;
			}
			case "snapshot": {
				const value = check(expression.value, expected);
				if (containsFuture(value.type))
					this.fail(
						expression,
						"Future is non-copyable and cannot be snapshotted",
					);
				result = info(value.type, false, value.exits);
				break;
			}
			case "read": {
				const value = check(expression.value, expected);
				if (!this.root(expression.value))
					this.fail(expression, "read requires addressable storage");
				result = info(value.type, true, value.exits, false);
				break;
			}
			case "await": {
				if (!fn.declaration.async)
					this.fail(expression, "await requires an async function");
				if (expression.value.kind === "read")
					this.fail(
						expression,
						"await requires ownership, not a read borrow",
					);
				const value = check(expression.value);
				if (value.type.kind !== "future")
					this.fail(expression, "await requires Future<T>");
				result = info(value.type.result, false, value.exits);
				break;
			}
			case "raise": {
				if (
					!variants(fn.result).some(
						(type) => type.kind === "throwable",
					)
				)
					this.fail(
						expression,
						"raise requires a function result containing throwable",
					);
				const value = check(expression.value);
				this.require(
					value.type,
					union([STRING, THROWABLE]),
					expression.value,
				);
				result = info(NEVER, false, [...value.exits, "return"]);
				break;
			}
			case "type-argument":
				return this.fail(
					expression,
					"A type designator is allowed only as the first argument of std/typing.trycast",
				);
			case "update": {
				const target = this.lvalue(
					expression.target,
					scope,
					module,
					fn,
					loops,
				);
				if (
					target.type.kind !== "never" &&
					!isNumericType(target.type.kind)
				)
					this.fail(
						expression.target,
						"Increment and decrement require a numeric type",
					);
				result = info(target.type, false, target.exits);
				break;
			}
			case "cast": {
				const target = this.resolveType(module, expression.target);
				const value = check(
					expression.value,
					expression.value.kind === "array" ||
						(isIntegerType(target.kind) &&
							this.contextualNumeric(expression.value))
						? target
						: undefined,
				);
				if (value.mutable)
					this.fail(
						expression.value,
						"Casting mutable values requires snapshot",
					);
				if (
					!(
						isNumericType(value.type.kind) &&
						isNumericType(target.kind)
					) &&
					!projectable(value.type, target)
				)
					this.fail(
						expression,
						`Cannot prove safe structural cast from ${describe(value.type)} to ${describe(target)}`,
					);
				this.projections.set(expression, target);
				result = info(
					value.type.kind === "never" ? NEVER : target,
					false,
					value.exits,
				);
				break;
			}
			case "array": {
				const alternatives = expected
					? variants(expected).filter((t) => t.kind === "array")
					: [];
				const context =
					alternatives.length === 1 &&
					alternatives[0]!.kind === "array"
						? alternatives[0]!.element
						: undefined;
				if (!context)
					this.fail(
						expression,
						"Array literals require an unambiguous expected array type",
					);
				const elements = expression.elements.map((element) =>
					check(element, context),
				);
				if (context)
					for (let index = 0; index < elements.length; index++)
						this.require(
							elements[index]!.type,
							context,
							expression.elements[index]!,
						);
				result = info(
					elements.some((element) => element.type.kind === "never")
						? NEVER
						: {
								kind: "array",
								element: context,
							},
					elements.some((element) => element.borrowed),
					exits(...elements),
					elements.some((element) => element.mutable),
				);
				break;
			}
			case "struct": {
				const declared = expression.target
					? this.resolveType(module, expression.target)
					: undefined;
				if (declared && declared.kind !== "struct")
					this.fail(
						expression,
						"Named struct literals require a struct type",
					);
				const structures = expected
					? variants(expected).filter((t) => t.kind === "struct")
					: [];
				const context =
					declared ??
					(structures.length === 1 ? structures[0] : expected);
				const fields = new Map<string, Type>(),
					values: Info[] = [];
				for (const field of expression.fields) {
					if (fields.has(field.name))
						this.fail(
							expression,
							`Duplicate field '${field.name}'`,
						);
					const value = check(
						field.value,
						context?.kind === "struct"
							? context.fields.get(field.name)
							: undefined,
					);
					const fieldContext =
						context?.kind === "struct"
							? context.fields.get(field.name)
							: undefined;
					if (fieldContext)
						this.require(value.type, fieldContext, field.value);
					values.push(value);
					fields.set(field.name, fieldContext ?? value.type);
				}
				result = info(
					values.some((value) => value.type.kind === "never")
						? NEVER
						: { kind: "struct", fields },
					values.some((value) => value.borrowed),
					exits(...values),
					values.some((value) => value.mutable),
				);
				if (declared) this.require(result.type, declared, expression);
				break;
			}
			case "member": {
				const object = check(expression.object);
				if (object.type.kind === "never") {
					result = info(NEVER, false, object.exits);
					break;
				}
				if (
					object.type.kind === "throwable" &&
					expression.name === "message"
				) {
					result = info(
						STRING,
						object.borrowed,
						object.exits,
						object.mutable,
					);
					break;
				}
				if (object.type.kind === "array")
					this.fail(
						expression,
						"Arrays have no properties; use std/arr",
					);
				const fields = variants(object.type).map((type) =>
					type.kind === "struct"
						? type.fields.get(expression.name)
						: undefined,
				);
				if (!fields.length || fields.some((field) => !field))
					return this.fail(
						expression,
						`Unknown field '${expression.name}'; narrow unions with match`,
					);
				result = info(
					union(fields as Type[]),
					object.borrowed,
					object.exits,
					object.mutable,
				);
				break;
			}
			case "index": {
				const object = check(expression.object),
					index = check(expression.index);
				this.require(index.type, INT32, expression.index);
				if (
					object.type.kind === "never" ||
					index.type.kind === "never"
				) {
					result = info(NEVER, false, exits(object, index));
					break;
				}
				if (object.type.kind !== "array")
					return this.fail(expression, "Indexing requires an array");
				result = info(
					object.type.element,
					object.borrowed,
					exits(object, index),
					object.mutable,
				);
				break;
			}
			case "call": {
				const called = this.instantiate(
					this.function(expression.callee, scope, module),
					expression.typeArgs ?? [],
					module,
					expression,
				);
				this.calls.set(expression, called);
				if (called.intrinsic === "trycast") {
					if (
						expression.args.length !== 2 ||
						expression.args[0]!.value.kind !== "type-argument"
					)
						this.fail(
							expression,
							"trycast requires a compile-time target type and one readonly value",
						);
					const target = this.resolveType(
						module,
						expression.args[0]!.value.type,
					);
					const value = check(expression.args[1]!.value);
					if (containsFuture(value.type) || containsFuture(target))
						this.fail(
							expression,
							"trycast cannot copy Future-containing types",
						);
					if (value.mutable)
						this.fail(
							expression.args[1]!.value,
							"trycast readonly input requires snapshot of mutable values",
						);
					this.projections.set(expression, target);
					result = info(
						value.type.kind === "never"
							? NEVER
							: union([target, THROWABLE]),
						false,
						value.exits,
					);
					break;
				}
				if (expression.args.length !== called.params.length)
					this.fail(
						expression,
						`Expected ${called.params.length} arguments`,
					);
				const values: Info[] = [],
					mutableRoots = new Set<string>();
				expression.args.forEach((arg, index) => {
					const parameter = called.declaration.params[index]!,
						target = called.params[index]!;
					const value = parameter.mutable
						? this.lvalue(arg.value, scope, module, fn, loops)
						: check(arg.value, target);
					if (parameter.mutable && !equivalent(value.type, target))
						this.fail(
							arg.value,
							"Mutable arguments require invariant types",
						);
					if (!parameter.mutable && value.mutable)
						this.fail(
							arg.value,
							`Readonly parameter '${parameter.name}' requires snapshot of mutable values`,
						);
					if (called.declaration.async && value.borrowed)
						this.fail(
							arg.value,
							"Async arguments require owned values; snapshot borrowed storage",
						);
					if (
						called.declaration.native &&
						!called.intrinsic?.startsWith("array.") &&
						containsFuture(value.type)
					)
						this.fail(
							arg.value,
							"The copying Native Bridge cannot accept Future-containing values",
						);
					if (target.kind !== "tsany")
						this.require(value.type, target, arg.value);
					if (parameter.mutable) {
						const root = this.root(arg.value)!;
						if (mutableRoots.has(root))
							this.fail(
								arg.value,
								"Overlapping mutable arguments are not supported",
							);
						mutableRoots.add(root);
					}
					values.push(value);
				});
				// Conservative alias policy until lifetimes and borrow scopes are designed.
				expression.args.forEach((arg, index) => {
					if (
						!called.declaration.params[index]!.mutable &&
						this.referencesRoots(arg.value, mutableRoots)
					)
						this.fail(
							arg.value,
							"A call cannot both mutate and read the same storage",
						);
					if (called.declaration.params[index]!.mutable) {
						let address = arg.value;
						while (
							address.kind === "member" ||
							address.kind === "index"
						) {
							if (
								address.kind === "index" &&
								this.referencesRoots(
									address.index,
									mutableRoots,
								)
							)
								this.fail(
									address.index,
									"Mutable argument address cannot access borrowed storage; compute the index before the call",
								);
							address = address.object;
						}
					}
				});
				result = info(
					values.some((value) => value.type.kind === "never")
						? NEVER
						: called.declaration.async
							? { kind: "future", result: called.result }
							: called.result,
					false,
					exits(...values),
				);
				break;
			}
			case "unary": {
				if (
					expression.op === "-" &&
					expression.operand.kind === "literal" &&
					typeof expression.operand.value === "bigint"
				) {
					const context = this.numericContext(expected);
					const type =
						context && isIntegerType(context.kind)
							? context
							: INT32;
					// The positive magnitude of a signed minimum is not itself a value
					// in the target type. Check the complete negative literal instead.
					this.expressionTypes.set(expression.operand, type);
					this.constantNumbers.set(
						expression.operand,
						expression.operand.value,
					);
					result = info(type);
					break;
				}
				const operand = check(
					expression.operand,
					expression.op === "!" ? BOOL : expected,
				);
				if (expression.op === "!")
					this.require(operand.type, BOOL, expression);
				else if (
					operand.type.kind !== "never" &&
					!isNumericType(operand.type.kind)
				)
					this.fail(
						expression,
						"Unary arithmetic requires a numeric type",
					);
				result = info(
					operand.type.kind === "never"
						? NEVER
						: expression.op === "!"
							? BOOL
							: operand.type,
					false,
					operand.exits,
				);
				break;
			}
			case "binary": {
				const op = expression.op;
				const context = this.numericContext(expected);
				// A concrete operand can contextualize literal arithmetic on either
				// side, but never changes the type of another concrete operand.
				let left: Info, right: Info;
				if (
					this.contextualNumeric(expression.left) &&
					!this.contextualNumeric(expression.right)
				) {
					right = check(expression.right);
					left = check(
						expression.left,
						this.numericContext(right.type) ?? context,
					);
				} else {
					left = check(expression.left, context);
					right = check(
						expression.right,
						this.numericContext(left.type) ?? context,
					);
				}
				let type: Type;
				if (
					left.type.kind === "never" ||
					(right.type.kind === "never" && !["&&", "||"].includes(op))
				) {
					result = info(NEVER, false, exits(left, right));
					break;
				}
				if (op === "+" && left.type.kind === "string") {
					this.require(right.type, STRING, expression.right);
					type = STRING;
				} else if (["&&", "||"].includes(op)) {
					this.require(left.type, BOOL, expression.left);
					this.require(right.type, BOOL, expression.right);
					type = BOOL;
				} else if (["==", "!="].includes(op)) {
					if (
						!(
							isNumericType(left.type.kind) ||
							["string", "bool", "void"].includes(left.type.kind)
						) ||
						!equivalent(left.type, right.type)
					)
						this.fail(
							expression,
							"Equality requires matching primitive types",
						);
					type = BOOL;
				} else {
					if (
						!isNumericType(left.type.kind) ||
						!equivalent(left.type, right.type)
					)
						this.fail(
							expression,
							"Numeric operators require matching concrete numeric types",
						);
					type = ["<", "<=", ">", ">="].includes(op)
						? BOOL
						: left.type;
				}
				result = info(type, false, exits(left, right));
				break;
			}
			case "block":
				result = this.block(
					expression,
					scope,
					module,
					fn,
					loops,
					expected,
				);
				break;
			case "if": {
				const condition = check(expression.condition);
				this.require(condition.type, BOOL, expression.condition);
				const then = this.block(
						expression.then,
						scope,
						module,
						fn,
						loops,
						expected,
					),
					otherwise = expression.otherwise
						? this.block(
								expression.otherwise,
								scope,
								module,
								fn,
								loops,
								expected,
							)
						: info(VOID);
				result = info(
					condition.type.kind === "never"
						? NEVER
						: union([then.type, otherwise.type]),
					then.borrowed || otherwise.borrowed,
					exits(condition, then, otherwise),
					then.mutable || otherwise.mutable,
				);
				break;
			}
			case "match": {
				const value = check(expression.value);
				let remaining = variants(value.type);
				const branches: Info[] = [];
				for (const arm of expression.arms) {
					const pattern = arm.type
						? this.resolveType(module, arm.type)
						: null;
					if (pattern && containsTSAny(pattern))
						this.fail(arm, "TSAny cannot be used in match");
					if (arm.type && pattern)
						this.matchTypes.set(arm.type, pattern);
					const matched = pattern
						? remaining.filter((type) =>
								patternCovers(type, pattern),
							)
						: remaining;
					if (
						matched.some((selected) =>
							remaining.some(
								(other) =>
									!matched.includes(other) &&
									overlaps(selected, other),
							),
						)
					) {
						this.fail(
							arm,
							"Overlapping structural alternatives cannot be discriminated yet; use a common or wildcard arm",
						);
					}
					if (!matched.length)
						this.fail(
							arm,
							"Unreachable or unsupported partial match arm",
						);
					const narrowed = union(matched),
						branch = new Scope(
							scope,
							this.semantic,
							arm.body.range,
						);
					if (expression.value.kind === "identifier")
						branch.bindings.set(expression.value.name, {
							...scope.get(expression.value.name),
							type: narrowed,
							mutable: false,
							borrowed: value.borrowed,
							sourceMutable: value.mutable,
						});
					if (expression.value.kind === "identifier")
						this.semantic.narrow(
							scope.get(expression.value.name)?.symbol,
							narrowed,
							arm.body.range,
						);
					if (arm.binding)
						branch.add(
							arm.binding,
							{
								type: narrowed,
								mutable: false,
								borrowed: value.borrowed,
								sourceMutable: value.mutable,
							},
							arm,
							"case",
						);
					branches.push(
						this.expression(
							arm.body,
							branch,
							module,
							fn,
							loops,
							expected,
						),
					);
					remaining = remaining.filter(
						(type) => !matched.includes(type),
					);
				}
				if (remaining.length)
					this.fail(
						expression,
						`Non-exhaustive match: missing ${describe(union(remaining))}`,
					);
				result = info(
					value.type.kind === "never"
						? NEVER
						: union(branches.map((branch) => branch.type)),
					branches.some((branch) => branch.borrowed),
					exits(value, ...branches),
					branches.some((branch) => branch.mutable),
				);
				break;
			}
			case "handle": {
				const value = check(expression.value),
					alternatives = variants(value.type);
				const errors = alternatives.filter((type) =>
						assignable(type, THROWABLE),
					),
					success = union(
						alternatives.filter(
							(type) => !assignable(type, THROWABLE),
						),
					);
				if (!errors.length)
					this.fail(
						expression,
						"Handler requires a throwable alternative",
					);
				const handlerScope = new Scope(
					scope,
					this.semantic,
					expression.body.range,
				);
				handlerScope.add(
					expression.binding,
					{
						type: union(errors),
						mutable: false,
						borrowed: value.borrowed,
					},
					expression,
					"handler",
				);
				const body = this.block(
					expression.body,
					handlerScope,
					module,
					fn,
					loops,
					success,
				);
				if (expression.mode === "catch" && body.type.kind !== "never")
					this.fail(
						expression.body,
						"catch handler must have type never (exit control flow)",
					);
				if (expression.mode === "otherwise")
					this.require(body.type, success, expression.body);
				result = info(
					success,
					value.borrowed || body.borrowed,
					exits(value, body),
					value.mutable || body.mutable,
				);
				break;
			}
		}
		if (isNumericType(result.type.kind))
			this.checkConstantNumber(expression, result.type.kind);
		this.expressionTypes.set(expression, result.type);
		return result;
	}
	/** A unique expected numeric alternative contextualizes literals, never variables. */
	private numericContext(expected?: Type): Type | undefined {
		const candidates = expected
			? variants(expected).filter((type) => isNumericType(type.kind))
			: [];
		return candidates.length === 1 ? candidates[0] : undefined;
	}
	private contextualNumeric(expression: Expression): boolean {
		switch (expression.kind) {
			case "literal":
				return (
					typeof expression.value === "bigint" ||
					typeof expression.value === "number"
				);
			case "unary":
				return (
					expression.op === "-" &&
					this.contextualNumeric(expression.operand)
				);
			case "snapshot":
				return this.contextualNumeric(expression.value);
			case "binary":
				return (
					["+", "-", "*", "/", "%"].includes(expression.op) &&
					this.contextualNumeric(expression.left) &&
					this.contextualNumeric(expression.right)
				);
			default:
				return false;
		}
	}
	/** Only literal expressions are evaluated; mutable storage and calls stay dynamic. */
	private checkConstantNumber(
		expression: Expression,
		type: NumericType,
	): void {
		let value: bigint | number | undefined;
		try {
			if (
				expression.kind === "literal" &&
				(typeof expression.value === "bigint" ||
					typeof expression.value === "number")
			)
				value = expression.value;
			else if (expression.kind === "snapshot")
				value = this.constantNumbers.get(expression.value);
			else if (expression.kind === "unary" && expression.op === "-") {
				const operand = this.constantNumbers.get(expression.operand);
				if (operand !== undefined)
					value =
						typeof operand === "bigint"
							? integerOperation(
									"negate",
									operand,
									0n,
									type as IntegerType,
								)
							: -operand;
			} else if (expression.kind === "cast") {
				const operand = this.constantNumbers.get(expression.value);
				const source = this.expressionTypes.get(expression.value);
				if (
					operand !== undefined &&
					source &&
					isNumericType(source.kind)
				)
					value = numericCast(operand, source.kind, type);
			} else if (expression.kind === "binary") {
				const left = this.constantNumbers.get(expression.left);
				const right = this.constantNumbers.get(expression.right);
				if (left !== undefined && right !== undefined) {
					if (typeof left === "bigint" && typeof right === "bigint")
						value = integerOperation(
							expression.op,
							left,
							right,
							type as IntegerType,
						);
					else if (
						typeof left === "number" &&
						typeof right === "number"
					) {
						switch (expression.op) {
							case "+":
								value = left + right;
								break;
							case "-":
								value = left - right;
								break;
							case "*":
								value = left * right;
								break;
							case "/":
								value = left / right;
								break;
							case "%":
								value = left % right;
								break;
						}
					}
				}
			}
			if (value === undefined) return;
			if (typeof value === "bigint" && isIntegerType(type))
				assertIntegerRange(value, type);
			else if (typeof value === "number" && type === "float32")
				value = Math.fround(value);
		} catch (error) {
			this.fail(
				expression,
				`${error instanceof Error ? error.message : String(error)} in constant expression`,
			);
		}
		this.constantNumbers.set(expression, value);
	}
	private referencesRoots(
		expression: Expression,
		roots: Set<string>,
	): boolean {
		const visit = (value: unknown): boolean => {
			if (value === null || typeof value !== "object") return false;
			if (
				"kind" in value &&
				value.kind === "identifier" &&
				"name" in value &&
				typeof value.name === "string"
			)
				return roots.has(value.name);
			return Object.entries(value).some(
				([key, child]) => key !== "span" && visit(child),
			);
		};
		return visit(expression);
	}
}
export interface CheckOptions {
	requireEntryPoint?: boolean;
	/** Produces partial information only; do not execute this program. */
	editorRecovery?: boolean;
}
export function checkProgram(
	program: Program,
	options: CheckOptions = {},
): CheckedProgram {
	return new CheckedProgram(program).check(options);
}
