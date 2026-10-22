import { LanguageError } from "./ast.js";
import type { Block, Expression, Node, Statement } from "./ast.js";
import type { CheckedProgram, FunctionInfo } from "./checker.js";
import { containsFuture, variants, THROWABLE } from "./types.js";
import type { Type } from "./types.js";

interface Local {
	id: Node;
	type: Type;
}
type Locals = Map<string, Local>;
type Lock = { id: Node; mutable: boolean };

/** Separate from shape checking: identities, temporary loans and affine flow. */
export function checkSafety(program: CheckedProgram): void {
	for (const functions of program.functions.values())
		for (const fn of functions.values())
			if (fn.declaration.body) new Safety(program).check(fn);
}

class Safety {
	private consumed = new Set<Node>();
	private readonly locks: Lock[] = [];
	private readonly loopBreaks: Set<Node>[] = [];
	constructor(private readonly program: CheckedProgram) {}
	private fail(node: Node, message: string): never {
		throw new LanguageError(
			node.span,
			message,
			node.nameRange ?? node.range,
		);
	}
	private type(expr: Expression): Type {
		return this.program.expressionTypes.get(expr)!;
	}
	check(fn: FunctionInfo): void {
		const locals: Locals = new Map(
			fn.declaration.params.map((p, i) => [
				p.name,
				{ id: p, type: fn.params[i]! },
			]),
		);
		this.block(fn.declaration.body!, locals);
	}
	private root(expr: Expression, locals: Locals): Local | undefined {
		if (expr.kind === "identifier") return locals.get(expr.name);
		if (expr.kind === "member" || expr.kind === "index")
			return this.root(expr.object, locals);
		return undefined;
	}
	private write(expr: Expression, locals: Locals): void {
		const root = this.root(expr, locals);
		if (root && this.locks.some((lock) => lock.id === root.id))
			this.fail(expr, "Cannot modify storage while it is borrowed");
		this.expr(expr, locals, false);
	}
	private block(block: Block, parent: Locals): void {
		const locals = new Map(parent);
		for (const stmt of block.statements) this.statement(stmt, locals);
		if (block.tail) this.expr(block.tail, locals);
	}
	private statement(stmt: Statement, locals: Locals): void {
		switch (stmt.kind) {
			case "let":
				this.expr(stmt.value, locals);
				locals.set(stmt.name, {
					id: stmt,
					type:
						this.program.semantic.definition(stmt)?.type ??
						this.type(stmt.value),
				});
				break;
			case "assign":
				this.write(stmt.target, locals);
				this.expr(stmt.value, locals);
				break;
			case "return":
				if (stmt.value) this.expr(stmt.value, locals);
				break;
			case "expression":
				this.expr(stmt.expression, locals);
				break;
			case "break":
				for (const id of this.consumed) this.loopBreaks.at(-1)?.add(id);
				break;
			case "while": {
				const before = new Set(this.consumed);
				const outer = new Set(
					[...locals.values()].map((local) => local.id),
				);
				this.loopBreaks.push(new Set());
				this.expr(stmt.condition, locals);
				this.block(stmt.body, locals);
				for (const id of this.loopBreaks.pop()!) this.consumed.add(id);
				if (
					[...this.consumed].some(
						(id) => outer.has(id) && !before.has(id),
					)
				)
					this.fail(
						stmt,
						"A loop cannot consume an outer Future; create it inside the loop",
					);
				break;
			}
		}
	}
	private branches(branches: (() => void)[], reachable: boolean[]): void {
		const before = new Set(this.consumed),
			after = new Set<Node>();
		branches.forEach((branch, i) => {
			this.consumed = new Set(before);
			branch();
			if (reachable[i]) for (const id of this.consumed) after.add(id);
		});
		this.consumed = after;
	}
	private expr(expr: Expression, locals: Locals, consume = true): void {
		switch (expr.kind) {
			case "literal":
			case "type-argument":
				break;
			case "identifier": {
				const local = locals.get(expr.name);
				if (!local) break;
				if (this.consumed.has(local.id))
					this.fail(
						expr,
						`Future '${expr.name}' was already consumed or moved`,
					);
				if (
					this.locks.some(
						(lock) => lock.id === local.id && lock.mutable,
					)
				)
					this.fail(
						expr,
						"Cannot access exclusively borrowed storage",
					);
				if (consume && containsFuture(this.type(expr))) {
					if (this.locks.some((lock) => lock.id === local.id))
						this.fail(
							expr,
							"Cannot move or consume borrowed Future storage",
						);
					this.consumed.add(local.id);
				}
				break;
			}
			case "read":
				this.fail(
					expr,
					"read is a temporary borrow allowed only as a direct synchronous readonly call argument",
				);
			case "snapshot":
			case "cast":
				this.expr(expr.value, locals, false);
				break;
			case "raise":
				this.expr(expr.value, locals);
				break;
			case "await":
				if (this.locks.length)
					this.fail(expr, "Cannot hold a borrow across await");
				this.expr(expr.value, locals);
				break;
			case "update":
				this.write(expr.target, locals);
				break;
			case "member":
			case "index":
				this.expr(expr.object, locals, false);
				if (expr.kind === "index") this.expr(expr.index, locals);
				if (containsFuture(this.type(expr)))
					this.fail(
						expr,
						"Partial moves of Future-containing fields or elements are not supported; move the whole value",
					);
				break;
			case "array":
				for (const value of expr.elements) this.expr(value, locals);
				break;
			case "struct":
				for (const field of expr.fields) this.expr(field.value, locals);
				break;
			case "unary":
				this.expr(expr.operand, locals);
				break;
			case "binary":
				this.expr(expr.left, locals);
				if (["&&", "||"].includes(expr.op))
					this.branches(
						[() => this.expr(expr.right, locals), () => {}],
						[true, true],
					);
				else this.expr(expr.right, locals);
				break;
			case "block":
				this.block(expr, locals);
				break;
			case "if":
				this.expr(expr.condition, locals);
				this.branches(
					[
						() => this.block(expr.then, locals),
						() => {
							if (expr.otherwise)
								this.block(expr.otherwise, locals);
						},
					],
					[
						this.type(expr.then)?.kind !== "never",
						!expr.otherwise ||
							this.type(expr.otherwise)?.kind !== "never",
					],
				);
				break;
			case "match": {
				this.expr(expr.value, locals);
				this.branches(
					expr.arms.map((arm) => () => {
						const branch = new Map(locals);
						if (arm.binding && arm.type) {
							const local = {
								id: arm,
								type: this.program.matchTypes.get(arm.type)!,
							};
							branch.set(arm.binding, local);
							if (
								expr.value.kind === "identifier" &&
								containsFuture(this.type(expr.value))
							)
								branch.set(expr.value.name, local);
						}
						this.expr(arm.body, branch);
					}),
					expr.arms.map(
						(arm) => this.type(arm.body).kind !== "never",
					),
				);
				break;
			}
			case "handle": {
				this.expr(expr.value, locals);
				const handler = new Map(locals);
				handler.set(expr.binding, { id: expr, type: THROWABLE });
				this.branches(
					[() => {}, () => this.block(expr.body, handler)],
					[true, this.type(expr.body)?.kind !== "never"],
				);
				break;
			}
			case "call": {
				const fn = this.program.calls.get(expr)!;
				const previous = this.locks.length;
				for (const [i, arg] of expr.args.entries()) {
					const value = arg.value,
						mutable = fn.declaration.params[i]!.mutable;
					if (fn.intrinsic === "trycast" && i === 0) continue;
					if (value.kind === "read") {
						if (mutable || fn.declaration.async)
							this.fail(
								value,
								"A read borrow cannot be consumed, mutated or retained by an async Future",
							);
						this.expr(value.value, locals, false);
						const root = this.root(value.value, locals);
						if (!root)
							this.fail(
								value,
								"read requires addressable storage",
							);
						if (
							(containsFuture(this.type(value)) ||
								variants(this.type(value)).some((t) =>
									["array", "struct", "parameter"].includes(
										t.kind,
									),
								)) &&
							!this.borrowSafe(fn, i)
						)
							this.fail(
								value,
								"This parameter may retain or copy borrowed storage; pass an explicit snapshot",
							);
						this.locks.push({ id: root.id, mutable: false });
					} else if (mutable) {
						this.write(value, locals);
						const root = this.root(value, locals)!;
						this.locks.push({ id: root.id, mutable: true });
					} else this.expr(value, locals);
				}
				this.locks.length = previous;
				break;
			}
		}
	}

	/** Abstract T can hide aggregate storage. Prove a borrowing call never
	 * retains that argument, even when the ordinary generic call may copy it.
	 * Recursive/unknown summaries are deliberately rejected in v0.1. */
	private borrowSafe(
		fn: FunctionInfo,
		index: number,
		visiting = new Set<Node>(),
	): boolean {
		if (fn.intrinsic)
			return ["array.length", "array.get", "trycast"].includes(
				fn.intrinsic,
			);
		if (
			fn.declaration.native ||
			fn.declaration.async ||
			!fn.declaration.body ||
			visiting.has(fn.declaration)
		)
			return false;
		const next = new Set(visiting).add(fn.declaration),
			name = fn.declaration.params[index]!.name;
		let safe = true;
		const value = (expr: Expression): boolean => {
			switch (expr.kind) {
				case "identifier":
					return expr.name === name;
				case "snapshot":
				case "cast":
					value(expr.value);
					return false;
				case "read":
					return value(expr.value);
				case "member":
					return value(expr.object);
				case "index": {
					const tainted = value(expr.object);
					value(expr.index);
					return tainted;
				}
				case "array":
					return expr.elements.map(value).some(Boolean);
				case "struct":
					return expr.fields.map((f) => value(f.value)).some(Boolean);
				case "call": {
					const callee = this.program.calls.get(expr)!;
					expr.args.forEach((arg, i) => {
						if (
							value(arg.value) &&
							!this.borrowSafe(callee, i, next)
						)
							safe = false;
					});
					return false;
				}
				case "binary":
					value(expr.left);
					value(expr.right);
					return false;
				case "unary":
					value(expr.operand);
					return false;
				case "raise":
					value(expr.value);
					return false;
				case "await":
					if (value(expr.value)) safe = false;
					return false;
				case "update":
					if (value(expr.target)) safe = false;
					return false;
				case "block":
					return block(expr);
				case "if": {
					value(expr.condition);
					const a = block(expr.then),
						b = expr.otherwise ? block(expr.otherwise) : false;
					return a || b;
				}
				case "match":
					if (value(expr.value)) safe = false;
					return expr.arms.map((a) => value(a.body)).some(Boolean);
				case "handle": {
					const a = value(expr.value),
						b = block(expr.body);
					return a || b;
				}
				default:
					return false;
			}
		};
		const block = (body: Block): boolean => {
			for (const stmt of body.statements) {
				if (
					stmt.kind === "let" ||
					stmt.kind === "assign" ||
					stmt.kind === "return"
				) {
					if (stmt.value && value(stmt.value)) safe = false;
				} else if (stmt.kind === "expression") value(stmt.expression);
				else if (stmt.kind === "while") {
					value(stmt.condition);
					if (block(stmt.body)) safe = false;
				}
			}
			return body.tail ? value(body.tail) : false;
		};
		if (block(fn.declaration.body)) safe = false;
		return safe;
	}
}
