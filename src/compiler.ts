import { checkProgram } from "./checker.js";
import { loadProgram } from "./modules.js";
import type { LoadProgramOptions } from "./modules.js";

/** Strict compilation for executable programs; analysis APIs default to library mode. */
export async function compile(file: string, options: LoadProgramOptions = {}) {
	return checkProgram(await loadProgram(file, options));
}
export { LanguageError } from "./ast.js";
export type {
	Span,
	Node,
	Module,
	Declaration,
	Statement,
	Expression,
	TypeNode,
	TypeParameter,
} from "./ast.js";
export { parse } from "./parser.js";
export { lex } from "./lexer.js";
export type { Token } from "./lexer.js";
export { checkProgram, CheckedProgram } from "./checker.js";
export type { CheckOptions, FunctionInfo } from "./checker.js";
export { loadProgram, canonicalPath, diskFileSystem } from "./modules.js";
export type {
	Program,
	SourceModule,
	LoadProgramOptions,
	SourceFileSystem,
} from "./modules.js";
export { SourceText } from "./source.js";
export type { SourceRange, Position, Range } from "./source.js";
export { describe } from "./types.js";
export type { Type } from "./types.js";
export type { SemanticSymbol, SymbolKind, Occurrence } from "./semantic.js";
