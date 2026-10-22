import { ThrowableValue } from "./values.js";
import { assertIntegerRange, getIntegerBounds } from "./numeric.js";

/** Non-fallible native contracts stop execution on malformed host strings. */
export class NativeRuntimeError extends Error {}

function scalar(codepoint: number): boolean {
	return (
		Number.isInteger(codepoint) &&
		codepoint >= 0 &&
		codepoint <= 0x10ffff &&
		!(codepoint >= 0xd800 && codepoint <= 0xdfff)
	);
}

export function codepointLength(text: string): bigint {
	let length = 0n;
	for (const character of text) {
		if (!scalar(character.codePointAt(0)!))
			throw new NativeRuntimeError("Invalid Unicode scalar string");
		length++;
	}
	return assertIntegerRange(length, "int32");
}

export function codepointAt(
	text: string,
	index: bigint,
): bigint | ThrowableValue {
	if (typeof index !== "bigint" || index < 0n)
		return new ThrowableValue("Codepoint index out of bounds");
	let position = 0n;
	let result: bigint | undefined;
	for (const character of text) {
		const value = character.codePointAt(0)!;
		if (!scalar(value))
			return new ThrowableValue("Invalid Unicode scalar string");
		if (position === index) result = BigInt(value);
		position++;
	}
	return result ?? new ThrowableValue("Codepoint index out of bounds");
}

export function fromCodepoint(codepoint: bigint): string | ThrowableValue {
	// Validate in the language representation before entering the host API.
	return typeof codepoint === "bigint" &&
		codepoint >= 0n &&
		codepoint <= 0x10ffffn &&
		!(codepoint >= 0xd800n && codepoint <= 0xdfffn)
		? String.fromCodePoint(Number(codepoint))
		: new ThrowableValue("Invalid Unicode scalar value");
}

/** BigInt keeps multiplication exact even outside JavaScript's safe integer range. */
export function checkedInt32(
	op: "+" | "-" | "*",
	a: bigint,
	b: bigint,
): bigint | ThrowableValue {
	const left = a,
		right = b;
	const result =
		op === "+" ? left + right : op === "-" ? left - right : left * right;
	const { min, max } = getIntegerBounds("int32");
	return result < min || result > max
		? new ThrowableValue("int32 arithmetic overflow")
		: result;
}
