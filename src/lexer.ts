import { LanguageError } from "./ast.js";
import type { Span } from "./ast.js";
import type { SourceRange } from "./source.js";
export interface Token {
	kind: "identifier" | "number" | "string" | "symbol" | "eof";
	text: string;
	span: Span;
	range: SourceRange;
}
export function lex(source: string, file = "<source>"): Token[] {
	const tokens: Token[] = [];
	let offset = 0,
		line = 1,
		column = 1;
	const take = (): string => {
		const ch = source[offset++]!;
		if (ch === "\r" || ch === "\n") {
			if (ch !== "\n" || source[offset - 2] !== "\r") line++;
			column = 1;
		} else column++;
		return ch;
	};
	while (offset < source.length) {
		const ch = source[offset]!;
		if (/\s/u.test(ch)) {
			take();
			continue;
		}
		const span = { file, line, column };
		const start = offset;
		const range = (): SourceRange => ({ file, start, end: offset });
		if (source.startsWith("//", offset)) {
			while (offset < source.length && source[offset] !== "\n") take();
			continue;
		}
		if (source.startsWith("/*", offset)) {
			take();
			take();
			let depth = 1;
			while (offset < source.length && depth > 0) {
				if (source.startsWith("/*", offset)) {
					take();
					take();
					depth++;
				} else if (source.startsWith("*/", offset)) {
					take();
					take();
					depth--;
				} else take();
			}
			if (depth)
				throw new LanguageError(span, "Unterminated comment", range());
			continue;
		}
		if (/[A-Za-z_]/u.test(ch)) {
			let text = take();
			while (
				offset < source.length &&
				/[A-Za-z_0-9]/u.test(source[offset]!)
			)
				text += take();
			tokens.push({ kind: "identifier", text, span, range: range() });
			continue;
		}
		if (/[0-9]/u.test(ch)) {
			let text = take();
			while (offset < source.length && /[0-9]/u.test(source[offset]!))
				text += take();
			if (
				source[offset] === "." &&
				/[0-9]/u.test(source[offset + 1] ?? "")
			) {
				text += take();
				while (offset < source.length && /[0-9]/u.test(source[offset]!))
					text += take();
			}
			if (/[eE]/u.test(source[offset] ?? "")) {
				text += take();
				if (/[+-]/u.test(source[offset] ?? "")) text += take();
				if (!/[0-9]/u.test(source[offset] ?? ""))
					throw new LanguageError(
						span,
						"Expected exponent digits",
						range(),
					);
				while (offset < source.length && /[0-9]/u.test(source[offset]!))
					text += take();
			}
			tokens.push({ kind: "number", text, span, range: range() });
			continue;
		}
		if (ch === '"') {
			let text = take(),
				closed = false;
			while (offset < source.length) {
				const next = take();
				text += next;
				if (next === '"') {
					closed = true;
					break;
				}
				if (next === "\\" && offset < source.length) text += take();
				else if (next === "\n" || next === "\r")
					throw new LanguageError(
						span,
						"Newline in string literal",
						range(),
					);
			}
			if (!closed)
				throw new LanguageError(span, "Unterminated string", range());
			try {
				text = JSON.parse(text) as string;
			} catch {
				throw new LanguageError(span, "Invalid string escape", range());
			}
			tokens.push({ kind: "string", text, span, range: range() });
			continue;
		}
		const pair = source.slice(offset, offset + 2);
		if (
			[
				"->",
				"=>",
				"==",
				"!=",
				"<=",
				">=",
				"&&",
				"||",
				"++",
				"--",
			].includes(pair)
		) {
			take();
			take();
			tokens.push({ kind: "symbol", text: pair, span, range: range() });
			continue;
		}
		if ("{}()[];:,.|=+-*/%!<>".includes(ch)) {
			tokens.push({ kind: "symbol", text: take(), span, range: range() });
			continue;
		}
		throw new LanguageError(
			span,
			`Unexpected character ${JSON.stringify(ch)}`,
			{
				file,
				start,
				end: start + (source.codePointAt(start)! > 0xffff ? 2 : 1),
			},
		);
	}
	tokens.push({
		kind: "eof",
		text: "<eof>",
		span: { file, line, column },
		range: { file, start: offset, end: offset },
	});
	return tokens;
}
