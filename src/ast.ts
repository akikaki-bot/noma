import type { SourceRange } from "./source.js";
export interface Span {
	file: string;
	line: number;
	column: number;
}
export class LanguageError extends Error {
	readonly detail: string;
	phase?: "syntax";
	constructor(
		public readonly span: Span,
		message: string,
		public readonly range?: SourceRange,
	) {
		super(`${span.file}:${span.line}:${span.column}: ${message}`);
		this.name = "LanguageError";
		this.detail = message;
	}
}
export interface Node {
	span: Span;
	/** Half-open UTF-16 ranges. Optional for manually constructed ASTs. */
	range?: SourceRange;
	nameRange?: SourceRange;
	qualifierRange?: SourceRange;
}
export type TypeNode = Node &
	(
		| { kind: "name"; name: string }
		| { kind: "union"; members: TypeNode[] }
		| { kind: "struct"; fields: { name: string; type: TypeNode }[] }
		| { kind: "array"; element: TypeNode }
	);
export interface Parameter extends Node {
	name: string;
	type: TypeNode;
	mutable: boolean;
}
export type Declaration = Node &
	(
		| { kind: "use"; path: string; alias: string }
		| {
				kind: "type";
				name: string;
				type: TypeNode;
				public: boolean;
				compilerOnly: boolean;
		  }
		| {
				kind: "function";
				name: string;
				params: Parameter[];
				result: TypeNode;
				body: Block | null;
				public: boolean;
				native: boolean;
		  }
	);
export interface Module extends Node {
	declarations: Declaration[];
}
export interface Block extends Node {
	kind: "block";
	statements: Statement[];
	tail: Expression | null;
}
export type Statement = Node &
	(
		| {
				kind: "let";
				name: string;
				type: TypeNode;
				mutable: boolean;
				value: Expression;
		  }
		| { kind: "assign"; target: Expression; value: Expression }
		| { kind: "return"; value: Expression | null }
		| { kind: "expression"; expression: Expression }
		| { kind: "while"; condition: Expression; body: Block }
		| { kind: "break" }
	);
export interface Argument {
	value: Expression;
}
export interface MatchArm extends Node {
	type: TypeNode | null;
	binding: string | null;
	body: Expression;
}
export type Expression = Node &
	(
		| { kind: "literal"; value: string | number | boolean | null }
		| { kind: "identifier"; name: string }
		| { kind: "member"; object: Expression; name: string }
		| { kind: "index"; object: Expression; index: Expression }
		| { kind: "call"; callee: Expression; args: Argument[] }
		| { kind: "binary"; op: string; left: Expression; right: Expression }
		| { kind: "unary"; op: string; operand: Expression }
		| { kind: "snapshot"; value: Expression }
		| { kind: "raise"; value: Expression }
		| { kind: "cast"; target: TypeNode; value: Expression }
		| { kind: "type-argument"; type: TypeNode }
		| { kind: "update"; target: Expression }
		| { kind: "array"; elements: Expression[] }
		| {
				kind: "struct";
				fields: { name: string; value: Expression }[];
				target?: TypeNode;
		  }
		| {
				kind: "if";
				condition: Expression;
				then: Block;
				otherwise: Block | null;
		  }
		| { kind: "match"; value: Expression; arms: MatchArm[] }
		| {
				kind: "handle";
				mode: "catch" | "otherwise";
				value: Expression;
				binding: string;
				body: Block;
		  }
		| Block
	);
