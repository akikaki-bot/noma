import { LanguageError } from "./ast.js";
import type { CheckedProgram, FunctionInfo } from "./checker.js";
import { lex } from "./lexer.js";
import type { Token } from "./lexer.js";
import { keywords, parse } from "./parser.js";
import type { SemanticSymbol, SymbolKind } from "./semantic.js";
import type { Range, SourceText } from "./source.js";
import { builtins, describe, union, variants } from "./types.js";
import type { Type } from "./types.js";

export interface CompletionItem {
	label: string;
	detail: string;
	kind: SymbolKind | "keyword" | "field";
	insertText: string;
	range: Range;
}
export interface SignatureHelp {
	signatures: { label: string; parameters: { label: string }[] }[];
	activeSignature: number;
	activeParameter?: number;
}

/** Do not offer identifiers in strings or comments, including nested block comments. */
function inCode(text: string): boolean {
	let mode: "code" | "string" | "line" | "block" = "code",
		depth = 0;
	for (let i = 0; i < text.length; i++) {
		const pair = text.slice(i, i + 2),
			ch = text[i];
		if (mode === "string") {
			if (ch === "\\") i++;
			else if (ch === '"') mode = "code";
		} else if (mode === "line") {
			if (ch === "\n" || ch === "\r") mode = "code";
		} else if (mode === "block") {
			if (pair === "/*") {
				depth++;
				i++;
			} else if (pair === "*/") {
				if (--depth === 0) mode = "code";
				i++;
			}
		} else if (pair === "//") {
			mode = "line";
			i++;
		} else if (pair === "/*") {
			mode = "block";
			depth = 1;
			i++;
		} else if (ch === '"') mode = "string";
	}
	return mode === "code";
}
function prefixTokens(source: SourceText, offset: number): Token[] | undefined {
	const text = source.text.slice(0, offset);
	if (!inCode(text)) return undefined;
	try {
		return lex(text, source.file).filter((token) => token.kind !== "eof");
	} catch (error) {
		if (!(error instanceof LanguageError)) throw error;
		return undefined;
	}
}
function fields(type: Type): Map<string, Type> {
	const alternatives = variants(type);
	const members = alternatives.map((t) =>
		t.kind === "struct"
			? new Map(t.fields)
			: t.kind === "array"
				? new Map([["length", builtins.get("int32")!]])
				: t.kind === "throwable"
					? new Map([["message", builtins.get("string")!]])
					: new Map<string, Type>(),
	);
	const result = new Map<string, Type>();
	for (const name of members[0]?.keys() ?? []) {
		if (members.every((member) => member.has(name)))
			result.set(name, union(members.map((member) => member.get(name)!)));
	}
	return result;
}
function visible(
	checked: CheckedProgram,
	source: SourceText,
	offset: number,
): SemanticSymbol[] {
	return checked.semantic.visibleSymbols(source.file, offset, "value");
}
function genericContext(
	tokens: Token[],
	checked: CheckedProgram | undefined,
	source: SourceText,
	offset: number,
): boolean {
	let depth = 0;
	for (let i = tokens.length - 1; i >= 0; i--) {
		const token = tokens[i]!;
		if (token.kind !== "symbol") continue;
		if (token.text === ">") depth++;
		if (token.text === "<") {
			if (depth === 0) {
				const name = tokens[i - 1]?.text;
				if (name === "Array") return true;
				if (!checked || !name) return false;
				const alias =
					tokens[i - 2]?.text === "."
						? tokens[i - 3]?.text
						: undefined;
				if (resolveFunction(checked, source, offset, name, alias))
					return true;
				const types = alias
					? checked.semantic.moduleMembers(source.file, offset, alias)
					: checked.semantic.visibleSymbols(
							source.file,
							offset,
							true,
						);
				return types.some(
					(symbol) => symbol.name === name && symbol.kind === "type",
				);
			}
			depth--;
		}
		if (depth === 0 && [";", "{", "}", "(", "=", ")"].includes(token.text))
			return false;
	}
	return false;
}

export function completionItems(
	checked: CheckedProgram | undefined,
	source: SourceText,
	offset: number,
): CompletionItem[] {
	const tokens = prefixTokens(source, offset);
	if (!tokens) return [];
	const before = source.text.slice(0, offset);
	const word = /[A-Za-z_0-9]*$/.exec(before)![0];
	const start = offset - word.length;
	const suffix = /^[A-Za-z_0-9]*/.exec(source.text.slice(offset))![0];
	const range = source.range({
		file: source.file,
		start,
		end: offset + suffix.length,
	});
	const items = new Map<string, CompletionItem>();
	const add = (
		label: string,
		detail: string,
		kind: CompletionItem["kind"],
	): void => {
		if (label.startsWith(word) && !items.has(label))
			items.set(label, { label, detail, kind, range, insertText: label });
	};
	const context = tokens.filter((token) => token.range.start < start);
	if (context.at(-1)?.text === ".") {
		if (!checked) return [];
		// Resolve member/index chains from the same visible binding identities as Checker.
		let cursor = context.length - 2;
		const atomStart = (end: number): number => {
			while (context[end]?.text === "]") {
				let depth = 1;
				end--;
				while (end >= 0 && depth) {
					if (context[end]?.text === "]") depth++;
					if (context[end]?.text === "[") depth--;
					end--;
				}
			}
			return end;
		};
		cursor = atomStart(cursor);
		while (context[cursor - 1]?.text === ".")
			cursor = atomStart(cursor - 2);
		const chain = context.slice(cursor, -1);
		const root = chain[0];
		if (!root || root.kind !== "identifier") return [];
		const symbol = visible(checked, source, offset).find(
			(s) => s.name === root.text,
		);
		if (symbol?.kind === "module" && chain.length === 1) {
			for (const member of checked.semantic.moduleMembers(
				source.file,
				offset,
				root.text,
			))
				add(member.name, member.detail, member.kind);
			return [...items.values()];
		}
		let type = symbol?.type;
		for (let i = 1; type && i < chain.length; i++) {
			if (chain[i]?.text === ".")
				type = fields(type).get(chain[++i]?.text ?? "");
			else if (chain[i]?.text === "[") {
				while (i < chain.length && chain[i]?.text !== "]") i++;
				type = type.kind === "array" ? type.element : undefined;
			} else type = undefined;
		}
		if (type)
			for (const [name, field] of fields(type))
				add(name, `${name}: ${describe(field)}`, "field");
		return [...items.values()];
	}
	const typesOnly = genericContext(context, checked, source, offset);
	if (checked)
		for (const symbol of checked.semantic.visibleSymbols(
			source.file,
			offset,
			typesOnly,
		)) {
			add(symbol.name, symbol.detail, symbol.kind);
		}
	for (const [name, type] of builtins)
		if (name !== "Type") add(name, describe(type), "type");
	add("Array", "Array<T>", "type");
	if (!typesOnly)
		for (const keyword of keywords)
			if (keyword !== "throw") add(keyword, keyword, "keyword");
	return [...items.values()];
}

function resolveFunction(
	checked: CheckedProgram,
	source: SourceText,
	offset: number,
	name: string,
	alias?: string,
): FunctionInfo | undefined {
	const module = checked.program.modules.find((m) => m.file === source.file);
	if (!module) return undefined;
	const symbols = visible(checked, source, offset);
	if (alias) {
		const imported = symbols.find((s) => s.name === alias)?.targetModule;
		const fn = imported && checked.functions.get(imported)?.get(name);
		return fn?.declaration.public && !fn.declaration.native
			? fn
			: undefined;
	}
	const symbol = symbols.find((s) => s.name === name);
	return symbol?.kind === "function"
		? checked.functions.get(module)?.get(name)
		: undefined;
}

/** Locate an open call using token delimiters, ignoring strings and nested expressions. */
export function signatureHelp(
	checked: CheckedProgram,
	source: SourceText,
	offset: number,
): SignatureHelp | undefined {
	const tokens = prefixTokens(source, offset);
	if (!tokens) return undefined;
	const stack: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.kind !== "symbol") continue;
		if (["(", "[", "{"].includes(token.text)) stack.push(i);
		else if ([")", "]", "}"].includes(token.text)) stack.pop();
	}
	for (const open of stack.reverse()) {
		if (tokens[open]!.text !== "(") continue;
		let nameIndex = open - 1;
		let typeStart: number | undefined;
		if (tokens[nameIndex]?.text === ">") {
			let depth = 1;
			nameIndex--;
			while (nameIndex >= 0 && depth) {
				if (tokens[nameIndex]!.text === ">") depth++;
				if (tokens[nameIndex]!.text === "<") depth--;
				if (depth === 0) typeStart = nameIndex;
				nameIndex--;
			}
		}
		const name = tokens[nameIndex];
		if (name?.kind !== "identifier" || tokens[nameIndex - 1]?.text === "fn")
			continue;
		const alias =
			tokens[nameIndex - 1]?.text === "."
				? tokens[nameIndex - 2]?.text
				: undefined;
		const fn = resolveFunction(checked, source, offset, name.text, alias);
		if (!fn) continue;
		const module = checked.program.modules.find(
			(m) => m.file === source.file,
		)!;
		let instance: FunctionInfo,
			typeLabel = "";
		try {
			const args =
				typeStart === undefined
					? []
					: (() => {
							const text = source.text.slice(
								tokens[typeStart]!.range.start,
								tokens[open - 1]!.range.end,
							);
							const node = parse(
								`type __Signature = __Function${text};`,
							).declarations[0]!;
							// Probe nodes have no locations in the user's document. Do not index them.
							const unlocate = (value: unknown): void => {
								if (!value || typeof value !== "object") return;
								const object = value as Record<string, unknown>;
								for (const key of [
									"range",
									"nameRange",
									"qualifierRange",
								])
									delete object[key];
								for (const [key, child] of Object.entries(
									object,
								))
									if (key !== "span") unlocate(child);
							};
							unlocate(node);
							return node.kind === "type" &&
								node.type.kind === "name"
								? (node.type.typeArgs ?? [])
								: [];
						})();
			const parameters = new Map(
				checked.semantic
					.visibleSymbols(source.file, offset, true)
					.filter(
						(s) =>
							s.kind === "type" && s.type?.kind === "parameter",
					)
					.map((s) => [s.name, s.type!]),
			);
			instance = checked.instantiate(
				fn,
				args,
				module,
				fn.declaration,
				parameters,
			);
			if (args.length)
				typeLabel =
					"<" +
					args
						.map((arg) =>
							describe(
								checked.resolveType(module, arg, parameters),
							),
						)
						.join(", ") +
					">";
		} catch (error) {
			if (!(error instanceof LanguageError)) throw error;
			return undefined;
		}
		let active = 0,
			depth = 0;
		for (let i = open + 1; i < tokens.length; i++) {
			const token = tokens[i]!;
			if (token.kind !== "symbol") continue;
			if (["(", "[", "{"].includes(token.text)) depth++;
			else if ([")", "]", "}"].includes(token.text)) depth--;
			else if (token.text === "<") {
				// A complete explicit type list before a call/constructor shields its commas.
				let angle = 1,
					end = i + 1;
				for (; end < tokens.length && angle; end++) {
					if (tokens[end]!.text === "<") angle++;
					if (tokens[end]!.text === ">") angle--;
				}
				if (!angle && ["(", "{"].includes(tokens[end]?.text ?? ""))
					i = end - 1;
			} else if (token.text === "," && depth === 0) active++;
		}
		const parameters = fn.declaration.params.map((param, index) => ({
			label: `${param.mutable ? "mut " : ""}${param.name}: ${describe(instance.params[index]!)}`,
		}));
		if (parameters.length && active >= parameters.length) return undefined;
		return {
			signatures: [
				{
					label: `${alias ? alias + "." : ""}${name.text}${typeLabel}(${parameters.map((p) => p.label).join(", ")}) -> ${describe(instance.result)}`,
					parameters,
				},
			],
			activeSignature: 0,
			...(active < parameters.length ? { activeParameter: active } : {}),
		};
	}
	return undefined;
}
