import { ThrowableValue } from "./values.js";

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

export function codepointLength(text: string): number {
	let length = 0;
	for (const character of text) {
		if (!scalar(character.codePointAt(0)!))
			throw new NativeRuntimeError("Invalid Unicode scalar string");
		length++;
	}
	return length;
}

export function codepointAt(
	text: string,
	index: number,
): number | ThrowableValue {
	if (!Number.isInteger(index) || index < 0)
		return new ThrowableValue("Codepoint index out of bounds");
	let position = 0;
	let result: number | undefined;
	for (const character of text) {
		const value = character.codePointAt(0)!;
		if (!scalar(value))
			return new ThrowableValue("Invalid Unicode scalar string");
		if (position === index) result = value;
		position++;
	}
	return result ?? new ThrowableValue("Codepoint index out of bounds");
}

export function fromCodepoint(codepoint: number): string | ThrowableValue {
	return scalar(codepoint)
		? String.fromCodePoint(codepoint)
		: new ThrowableValue("Invalid Unicode scalar value");
}

/** BigInt keeps multiplication exact even outside JavaScript's safe integer range. */
export function checkedInt32(
	op: "+" | "-" | "*",
	a: number,
	b: number,
): number | ThrowableValue {
	const left = BigInt(a),
		right = BigInt(b);
	const result =
		op === "+" ? left + right : op === "-" ? left - right : left * right;
	return result < -2147483648n || result > 2147483647n
		? new ThrowableValue("int32 arithmetic overflow")
		: Number(result);
}
