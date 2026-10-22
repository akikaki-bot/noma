/** Noma numeric semantics. Host representations are private implementation details.
 * Keep bounds and checked operations shared by checking and execution. */
export const integerTypes = [
	"int8",
	"int16",
	"int32",
	"int64",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
] as const;
export type IntegerType = (typeof integerTypes)[number];
export type NumericType = IntegerType | "float32" | "float64";
const bounds = Object.fromEntries(
	integerTypes.map((type) => {
		const signed = type.startsWith("int");
		const bits = BigInt(type.replace(/\D/g, ""));
		return [
			type,
			Object.freeze({
				min: signed ? -(1n << (bits - 1n)) : 0n,
				max: (1n << (signed ? bits - 1n : bits)) - 1n,
			}),
		];
	}),
) as Record<IntegerType, { readonly min: bigint; readonly max: bigint }>;
export function isIntegerType(type: string): type is IntegerType {
	return (integerTypes as readonly string[]).includes(type);
}
export function isNumericType(type: string): type is NumericType {
	return isIntegerType(type) || type === "float32" || type === "float64";
}
export function getIntegerBounds(type: IntegerType) {
	return bounds[type];
}
export function assertIntegerRange(value: bigint, type: IntegerType): bigint {
	const { min, max } = getIntegerBounds(type);
	if (value < min || value > max)
		throw new RangeError(`Value outside ${type} range`);
	return value;
}
/** Parse source text directly, never via a host floating point value. */
export function integerLiteral(raw: string): bigint {
	return BigInt(raw);
}
/** Division truncates toward zero; remainder has the dividend's sign. */
export function integerOperation(
	op: string,
	a: bigint,
	b: bigint,
	type: IntegerType,
): bigint {
	let result: bigint;
	switch (op) {
		case "+":
			result = a + b;
			break;
		case "-":
			result = a - b;
			break;
		case "*":
			result = a * b;
			break;
		case "/":
		case "%":
			if (b === 0n) throw new RangeError("Division by zero");
			result = op === "/" ? a / b : a % b;
			break;
		case "negate":
			result = -a;
			break;
		case "++":
			result = a + 1n;
			break;
		case "--":
			result = a - 1n;
			break;
		default:
			throw new Error(`Unknown integer operation ${op}`);
	}
	try {
		return assertIntegerRange(result, type);
	} catch {
		throw new RangeError(`${type} arithmetic overflow`);
	}
}
export function roundFloat(value: number, type: "float32" | "float64"): number {
	return type === "float32" ? Math.fround(value) : value;
}
/** Integer casts preserve the exact mathematical value. Float-to-float casts
 * follow their defined IEEE representation. */
export function numericCast(
	value: bigint | number,
	from: NumericType,
	to: NumericType,
): bigint | number {
	if (isIntegerType(to)) {
		if (typeof value === "bigint") return assertIntegerRange(value, to);
		if (!Number.isFinite(value) || !Number.isInteger(value))
			throw new RangeError(
				`Cannot cast non-finite or fractional value to ${to}`,
			);
		return assertIntegerRange(BigInt(value), to);
	}
	if (typeof value === "number") return roundFloat(value, to);
	const converted = roundFloat(Number(value), to);
	if (!Number.isFinite(converted) || BigInt(converted) !== value)
		throw new RangeError(`Lossy ${from} to ${to} conversion`);
	return converted;
}
/** Use only after validating a Noma integer at a host API boundary. */
export function safeHostInteger(value: bigint): number {
	if (
		value < BigInt(Number.MIN_SAFE_INTEGER) ||
		value > BigInt(Number.MAX_SAFE_INTEGER)
	)
		throw new RangeError("Integer exceeds the host safe integer range");
	return Number(value);
}
/** JSON transport for compiler/debug data. Type nodes accompanying a value retain
 * the concrete Noma type; the tagged decimal representation retains every bit. */
export function numericJsonReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint"
		? { $nomaInteger: value.toString() }
		: value;
}
export function numericJsonReviver(_key: string, value: unknown): unknown {
	if (
		value &&
		typeof value === "object" &&
		Object.keys(value).length === 1 &&
		"$nomaInteger" in value &&
		typeof value.$nomaInteger === "string" &&
		/^-?\d+$/.test(value.$nomaInteger)
	)
		return BigInt(value.$nomaInteger);
	return value;
}
