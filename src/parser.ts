import { LanguageError } from "./ast.js";
import type {
	Block,
	Declaration,
	Expression,
	MatchArm,
	Module,
	Node,
	Parameter,
	TypeParameter,
	Statement,
	TypeNode,
} from "./ast.js";
import { lex } from "./lexer.js";
import type { Token } from "./lexer.js";

export const keywords = [
	"use",
	"as",
	"pub",
	"compilerOnly",
	"native",
	"type",
	"fn",
	"let",
	"mut",
	"return",
	"while",
	"break",
	"if",
	"else",
	"match",
	"case",
	"throw",
	"raise",
	"catch",
	"otherwise",
	"snapshot",
	"struct",
	"true",
	"false",
	"void",
	"intrinsic",
] as const;
const reserved = new Set<string>(keywords);
const precedence: Record<string, number> = {
	"||": 1,
	"&&": 2,
	"==": 3,
	"!=": 3,
	"<": 4,
	">": 4,
	"<=": 4,
	">=": 4,
	"+": 5,
	"-": 5,
	"*": 6,
	"/": 6,
	"%": 6,
};

export function parse(source: string, file = "<source>"): Module {
	try {
		return new Parser(lex(source, file)).module();
	} catch (error) {
		if (error instanceof LanguageError) error.phase = "syntax";
		throw error;
	}
}
/** Tolerant ASTs are used only for editor assistance, never executable compilation. */
export function parseForEditor(source: string, file = "<source>"): Module {
	return new Parser(lex(source, file), true).module();
}
class Parser {
	private offset = 0;
	private readonly splitTokens: { offset: number; token: Token }[] = [];
	private readonly incompleteBlocks = new WeakSet<Block>();
	private allowNamedStruct = true;
	private readonly typeNames: Set<string>;
	private readonly aliases: Set<string>;
	private readonly typingAliases = new Set<string>();
	constructor(
		private readonly tokens: Token[],
		private readonly recovering = false,
	) {
		for (let index = 0; index < tokens.length; index++) {
			if (
				tokens[index]!.kind === "identifier" &&
				tokens[index]!.text === "use" &&
				tokens[index + 1]?.kind === "string" &&
				tokens[index + 1]?.text === "std/typing" &&
				tokens[index + 2]?.text === "as" &&
				tokens[index + 3]?.kind === "identifier"
			)
				this.typingAliases.add(tokens[index + 3]!.text);
		}
		this.typeNames = new Set(
			tokens
				.filter((_, index) => tokens[index - 1]?.text === "type")
				.map((token) => token.text),
		);
		this.aliases = new Set(
			tokens
				.filter((_, index) => tokens[index - 1]?.text === "as")
				.map((token) => token.text),
		);
	}
	private get current(): Token {
		return this.tokens[this.offset]!;
	}
	private at(text: string): boolean {
		return this.current.text === text && this.current.kind !== "string";
	}
	private take(): Token {
		return this.tokens[this.offset++]!;
	}
	private accept(text: string): boolean {
		if (!this.at(text)) return false;
		this.take();
		return true;
	}
	private expect(text: string): Token {
		// A closing type delimiter may touch '=' without changing comparison tokens.
		if (text === ">" && this.at(">=")) {
			const token = this.current;
			this.splitTokens.push({ offset: this.offset, token });
			this.tokens.splice(
				this.offset,
				1,
				{
					...token,
					text: ">",
					range: { ...token.range, end: token.range.start + 1 },
				},
				{
					...token,
					text: "=",
					span: { ...token.span, column: token.span.column + 1 },
					range: { ...token.range, start: token.range.start + 1 },
				},
			);
		}
		if (!this.at(text))
			throw new LanguageError(
				this.current.span,
				`Expected '${text}', got '${this.current.text}'`,
				this.current.range,
			);
		return this.take();
	}
	private checkpoint(): { offset: number; splits: number } {
		return { offset: this.offset, splits: this.splitTokens.length };
	}
	private restore(checkpoint: { offset: number; splits: number }): void {
		this.offset = checkpoint.offset;
		while (this.splitTokens.length > checkpoint.splits) {
			const split = this.splitTokens.pop()!;
			this.tokens.splice(split.offset, 2, split.token);
		}
	}
	private identifier(): Token {
		if (
			this.current.kind !== "identifier" ||
			reserved.has(this.current.text)
		)
			throw new LanguageError(
				this.current.span,
				"Expected identifier",
				this.current.range,
			);
		return this.take();
	}
	private complete<T extends Node>(node: T, first: Token): T {
		node.range = {
			file: first.range.file,
			start: first.range.start,
			end: this.tokens[Math.max(0, this.offset - 1)]!.range.end,
		};
		return node;
	}
	private located<T extends Node>(read: () => T): T {
		const first = this.current;
		return this.complete(read(), first);
	}
	module(): Module {
		const span = this.current.span,
			declarations: Declaration[] = [];
		while (this.current.kind !== "eof") {
			const start = this.offset;
			try {
				declarations.push(this.declaration());
			} catch (error) {
				if (!this.recovering || !(error instanceof LanguageError))
					throw error;
				this.offset = start;
				this.recover(true);
			}
		}
		return {
			span,
			declarations,
			range: { file: span.file, start: 0, end: this.current.range.end },
		};
	}
	private declaration(): Declaration {
		return this.located(() => this.readDeclaration());
	}
	private readDeclaration(): Declaration {
		const span = this.current.span;
		if (this.accept("use")) {
			if (this.current.kind !== "string")
				throw new LanguageError(
					this.current.span,
					"Expected module path string",
				);
			const path = this.take().text;
			this.expect("as");
			const aliasToken = this.identifier(),
				alias = aliasToken.text;
			if (path === "std/typing") this.typingAliases.add(alias);
			this.expect(";");
			return {
				kind: "use",
				span,
				path,
				alias,
				nameRange: aliasToken.range,
			};
		}
		const isPublic = this.accept("pub"),
			compilerOnly = this.accept("compilerOnly");
		if (this.accept("type")) {
			const nameToken = this.identifier(),
				name = nameToken.text;
			const typeParams = this.typeParameters();
			this.expect("=");
			const type = this.type();
			this.expect(";");
			return {
				kind: "type",
				typeParams,
				span,
				name,
				type,
				public: isPublic,
				compilerOnly,
				nameRange: nameToken.range,
			};
		}
		if (compilerOnly)
			throw new LanguageError(
				span,
				"compilerOnly is allowed only on a type declaration",
			);
		const native = this.accept("native");
		this.expect("fn");
		const nameToken = this.identifier(),
			name = nameToken.text;
		const typeParams = this.typeParameters();
		this.expect("(");
		const params: Parameter[] = [];
		if (!this.at(")"))
			do {
				const paramSpan = this.current.span,
					mutable = this.accept("mut"),
					paramToken = this.identifier(),
					paramName = paramToken.text;
				this.expect(":");
				params.push({
					span: paramSpan,
					name: paramName,
					type: this.type(),
					mutable,
					nameRange: paramToken.range,
					range: {
						file: span.file,
						start: paramToken.range.start,
						end: this.tokens[this.offset - 1]!.range.end,
					},
				});
			} while (this.accept(",") && !this.at(")"));
		this.expect(")");
		this.expect("->");
		const result = this.type();
		const body = native
			? (this.expect(";"), null)
			: this.accept(";")
				? null
				: this.block();
		return {
			kind: "function",
			typeParams,
			span,
			name,
			params,
			nameRange: nameToken.range,
			result,
			body,
			public: isPublic,
			native,
		};
	}
	private typeParameters(): TypeParameter[] {
		if (!this.accept("<")) return [];
		const params: TypeParameter[] = [];
		do {
			const token = this.identifier();
			params.push({
				name: token.text,
				span: token.span,
				nameRange: token.range,
				range: token.range,
			});
		} while (this.accept(","));
		this.expect(">");
		return params;
	}
	private typeArguments(): TypeNode[] {
		this.expect("<");
		const args = [this.type()];
		while (this.accept(",")) args.push(this.type());
		this.expect(">");
		return args;
	}
	private type(): TypeNode {
		return this.located(() => this.readType());
	}
	private readType(): TypeNode {
		const first = this.typeAtom(),
			members = [first];
		while (this.accept("|")) members.push(this.typeAtom());
		return members.length === 1
			? first
			: { kind: "union", span: first.span, members };
	}
	private typeAtom(): TypeNode {
		return this.located(() => this.readTypeAtom());
	}
	private readTypeAtom(): TypeNode {
		const first = this.current;
		const span = this.current.span;
		let type: TypeNode;
		if (this.accept("struct")) {
			this.expect("{");
			const fields: { name: string; type: TypeNode }[] = [];
			while (!this.accept("}")) {
				const name = this.identifier().text;
				this.expect(":");
				fields.push({ name, type: this.type() });
				this.expect(";");
			}
			type = { kind: "struct", span, fields };
		} else if (this.accept("(")) {
			type = this.type();
			this.expect(")");
		} else if (this.accept("Array")) {
			this.expect("<");
			const element = this.type();
			this.expect(">");
			type = { kind: "array", span, element };
		} else {
			if (this.current.kind !== "identifier")
				throw new LanguageError(span, "Expected type annotation");
			let nameToken = this.take(),
				name = nameToken.text;
			let qualifier: Token | null = null;
			if (this.accept(".")) {
				qualifier = nameToken;
				nameToken = this.identifier();
				name += `.${nameToken.text}`;
			}
			type = {
				kind: "name",
				span,
				name,
				nameRange: nameToken.range,
				...(this.at("<") ? { typeArgs: this.typeArguments() } : {}),
				...(qualifier ? { qualifierRange: qualifier.range } : {}),
			};
		}
		while (true) {
			this.complete(type, first);
			if (!this.accept("[")) break;
			this.expect("]");
			type = { kind: "array", span, element: type };
		}
		return type;
	}
	private block(): Block {
		const block = this.located(() => this.readBlock());
		if (this.incompleteBlocks.has(block) && block.range)
			block.range.end = this.current.range.end + 1;
		return block;
	}
	private recover(declaration = false): void {
		let depth = 0;
		const start = this.offset;
		while (this.current.kind !== "eof") {
			if (depth === 0) {
				if (!declaration && this.at("}")) return;
				if (
					this.offset > start &&
					(declaration
						? ["pub", "fn", "type", "use"]
						: ["let", "return", "while"]
					).some((word) => this.at(word))
				)
					return;
				if (!declaration && this.accept(";")) return;
			}
			if (this.at("{")) depth++;
			if (this.at("}")) depth = Math.max(0, depth - 1);
			this.take();
		}
	}
	private readBlock(): Block {
		const span = this.expect("{").span,
			statements: Statement[] = [];
		let tail: Expression | null = null;
		while (
			!this.at("}") &&
			!(this.recovering && this.current.kind === "eof")
		) {
			const recoveryStart = this.offset;
			try {
				const first = this.current;
				const start = this.current.span;
				const append = (statement: Statement): void => {
					statements.push(this.complete(statement, first));
				};
				if (this.accept("let")) {
					const mutable = this.accept("mut"),
						nameToken = this.identifier(),
						name = nameToken.text;
					this.expect(":");
					const type = this.type();
					this.expect("=");
					const value = this.expression();
					this.expect(";");
					append({
						kind: "let",
						span: start,
						mutable,
						name,
						type,
						value,
						nameRange: nameToken.range,
					});
					continue;
				}
				if (this.accept("return")) {
					const value = this.at(";") ? null : this.expression();
					this.expect(";");
					append({ kind: "return", span: start, value });
					continue;
				}
				if (this.accept("break")) {
					this.expect(";");
					append({ kind: "break", span: start });
					continue;
				}
				if (this.accept("while")) {
					const condition = this.condition(),
						body = this.block();
					append({
						kind: "while",
						span: start,
						condition,
						body,
					});
					continue;
				}
				const expression = this.expression();
				if (this.accept("=")) {
					const value = this.expression();
					this.expect(";");
					append({
						kind: "assign",
						span: start,
						target: expression,
						value,
					});
				} else if (this.accept(";"))
					append({
						kind: "expression",
						span: start,
						expression,
					});
				else if (this.at("}")) {
					tail = expression;
					break;
				} else if (
					["if", "match", "block", "handle"].includes(expression.kind)
				)
					append({
						kind: "expression",
						span: start,
						expression,
					});
				else
					throw new LanguageError(
						this.current.span,
						"Expected ';' or block tail",
					);
			} catch (error) {
				if (!this.recovering || !(error instanceof LanguageError))
					throw error;
				this.offset = recoveryStart;
				this.recover();
			}
		}
		const block: Block = { kind: "block", span, statements, tail };
		if (this.recovering && this.current.kind === "eof")
			this.incompleteBlocks.add(block);
		else this.expect("}");
		return block;
	}
	private condition(): Expression {
		const previous = this.allowNamedStruct;
		this.allowNamedStruct = false;
		try {
			const condition = this.expression();
			if (this.at("{") && this.tokens[this.offset + 2]?.text === ":")
				throw new LanguageError(
					this.current.span,
					"Ambiguous struct literal in condition; add parentheses around the condition",
					this.current.range,
				);
			return condition;
		} finally {
			this.allowNamedStruct = previous;
		}
	}
	private expression(minimum = 0): Expression {
		const first = this.current;
		let left = this.prefix();
		while (true) {
			this.complete(left, first);
			const span = left.span;
			if (this.accept(".")) {
				const nameToken = this.identifier();
				left = {
					kind: "member",
					span,
					object: left,
					name: nameToken.text,
					nameRange: nameToken.range,
				};
				continue;
			}
			if (this.accept("[")) {
				const index = this.expression();
				this.expect("]");
				left = { kind: "index", span, object: left, index };
				continue;
			}
			if (this.accept("++")) {
				left = { kind: "update", span, target: left };
				continue;
			}
			let typeArgs: TypeNode[] | undefined;
			if (
				this.at("<") &&
				(left.kind === "identifier" || left.kind === "member")
			) {
				const saved = this.checkpoint();
				try {
					const candidate = this.typeArguments();
					if (this.at("(")) typeArgs = candidate;
					else this.restore(saved);
				} catch (error) {
					if (!(error instanceof LanguageError)) throw error;
					this.restore(saved);
				}
			}
			if (this.accept("(")) {
				const args: { value: Expression }[] = [];
				if (!this.at(")"))
					do {
						// trycast's first operand is type syntax, never a runtime value.
						const typeOperand =
							args.length === 0 &&
							left.kind === "member" &&
							left.name === "trycast" &&
							left.object.kind === "identifier" &&
							this.typingAliases.has(left.object.name);
						args.push({
							value: typeOperand
								? this.located(() => ({
										kind: "type-argument" as const,
										span: this.current.span,
										type: this.type(),
									}))
								: this.expression(),
						});
					} while (this.accept(",") && !this.at(")"));
				this.expect(")");
				left = {
					kind: "call",
					span,
					callee: left,
					args,
					...(typeArgs ? { typeArgs } : {}),
				};
				continue;
			}
			if (minimum === 0 && (this.at("catch") || this.at("otherwise"))) {
				const mode = this.take().text as "catch" | "otherwise",
					bindingToken = this.identifier(),
					binding = bindingToken.text,
					body = this.block();
				left = {
					kind: "handle",
					span,
					mode,
					value: left,
					binding,
					body,
					nameRange: bindingToken.range,
				};
				continue;
			}
			const op = this.current.text,
				priority = precedence[op];
			if (
				this.current.kind === "string" ||
				priority === undefined ||
				priority < minimum
			)
				break;
			this.take();
			const right = this.expression(priority + 1);
			left = { kind: "binary", span, op, left, right };
		}
		return left;
	}
	private prefix(): Expression {
		return this.located(() => this.readPrefix());
	}
	private readPrefix(): Expression {
		const token = this.current,
			span = token.span;
		if (this.accept("snapshot"))
			return { kind: "snapshot", span, value: this.expression(7) };
		if (this.accept("raise"))
			return { kind: "raise", span, value: this.expression() };
		if (this.at("!") || this.at("-")) {
			const op = this.take().text;
			return { kind: "unary", span, op, operand: this.expression(7) };
		}
		if (this.at("(")) {
			const saved = this.checkpoint();
			this.take();
			let target: TypeNode | undefined;
			try {
				const candidate = this.type();
				this.expect(")");
				target = candidate;
			} catch (error) {
				if (!(error instanceof LanguageError)) throw error;
			}
			const startsValue =
				this.current.kind === "string" ||
				this.current.kind === "number" ||
				this.at("(") ||
				this.at("[") ||
				(this.current.kind === "identifier" &&
					(!reserved.has(this.current.text) ||
						[
							"snapshot",
							"true",
							"false",
							"void",
							"struct",
						].includes(this.current.text)));
			const knownType =
				target &&
				(target.kind !== "name" ||
					this.typeNames.has(target.name) ||
					[
						"int32",
						"string",
						"bool",
						"void",
						"never",
						"throwable",
						"Type",
					].includes(target.name) ||
					(target.name.includes(".") &&
						this.aliases.has(target.name.split(".")[0]!)));
			if (
				target &&
				startsValue &&
				(knownType || (!this.at("(") && !this.at("[")))
			)
				return {
					kind: "cast",
					span,
					target,
					value: this.expression(7),
				};
			this.restore(saved);
			this.expect("(");
			const previous = this.allowNamedStruct;
			this.allowNamedStruct = true;
			try {
				const value = this.expression();
				this.expect(")");
				return value;
			} finally {
				this.allowNamedStruct = previous;
			}
		}
		if (this.at("{")) return this.block();
		if (this.accept("[")) {
			const elements: Expression[] = [];
			if (!this.at("]"))
				do {
					elements.push(this.expression());
				} while (this.accept(",") && !this.at("]"));
			this.expect("]");
			return { kind: "array", span, elements };
		}
		let structTarget: TypeNode | undefined;
		if (
			token.kind === "identifier" &&
			(this.typeNames.has(token.text) ||
				(this.aliases.has(token.text) &&
					this.tokens[this.offset + 1]?.text === "."))
		) {
			const saved = this.checkpoint();
			let candidate: TypeNode | undefined;
			try {
				candidate = this.typeAtom();
			} catch (error) {
				if (!(error instanceof LanguageError)) throw error;
				this.restore(saved);
			}
			if (candidate && this.at("{")) {
				if (this.allowNamedStruct) structTarget = candidate;
				else if (this.tokens[this.offset + 2]?.text === ":")
					throw new LanguageError(
						span,
						"Ambiguous struct literal in condition; add parentheses around the condition",
						token.range,
					);
				else this.restore(saved);
			} else this.restore(saved);
		}
		if (!this.allowNamedStruct && this.at("struct"))
			throw new LanguageError(
				span,
				"Struct literals in conditions require parentheses",
				token.range,
			);
		if (structTarget || this.accept("struct")) {
			this.expect("{");
			const fields: { name: string; value: Expression }[] = [];
			if (!this.at("}"))
				do {
					const name = this.identifier().text;
					this.expect(":");
					fields.push({ name, value: this.expression() });
				} while (this.accept(",") && !this.at("}"));
			this.expect("}");
			return {
				kind: "struct",
				span,
				fields,
				...(structTarget ? { target: structTarget } : {}),
			};
		}
		if (this.accept("if")) {
			const condition = this.condition(),
				then = this.block();
			let otherwise: Block | null = null;
			if (this.accept("else")) otherwise = this.block();
			return { kind: "if", span, condition, then, otherwise };
		}
		if (this.accept("match")) {
			const value = this.expression();
			this.expect("{");
			const arms: MatchArm[] = [];
			while (!this.accept("}")) {
				const armFirst = this.current;
				const armSpan = this.expect("case").span;
				let bindingToken: Token | null = null;
				let type: TypeNode | null = null,
					binding: string | null = null;
				if (!this.accept("_")) {
					this.expect("(");
					bindingToken = this.identifier();
					binding = bindingToken.text;
					this.expect(":");
					type = this.type();
					this.expect(")");
				}
				const body = this.block();
				arms.push(
					this.complete(
						{
							span: armSpan,
							type,
							binding,
							body,
							...(bindingToken
								? { nameRange: bindingToken.range }
								: {}),
						},
						armFirst,
					),
				);
			}
			return { kind: "match", span, value, arms };
		}
		if (token.kind === "string" || token.kind === "number") {
			this.take();
			return {
				kind: "literal",
				span,
				value:
					token.kind === "number" ? Number(token.text) : token.text,
			};
		}
		if (this.accept("true")) return { kind: "literal", span, value: true };
		if (this.accept("false"))
			return { kind: "literal", span, value: false };
		if (this.accept("void")) return { kind: "literal", span, value: null };
		const identifier = this.identifier();
		return {
			kind: "identifier",
			span,
			name: identifier.text,
			nameRange: identifier.range,
		};
	}
}
