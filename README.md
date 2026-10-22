# Noma

## Features

- No Hidden Mutation.
- Simple JavaScript-like syntax. but Rust-like Safety.
- Easy Error handle.

## Examples

```noma
use "std/io" as io;

fn main() -> int32 {
    let mut inputValue: string = "";
	while true {
		let input: string | io.EOF = io.readLine() catch error {
			io.putsError(error.message) otherwise outputError { void };
			return 1;
		};
		match (input) {
			case (line: string) {
				inputValue = line;
				break;
			}
			case (end: io.EOF) { break; }
		};
	}

    io.puts(inputValue+" from Noma!");
	return 0;
}
```

## Basic Syntax

### Mutability

In Noma, values can be either mutable or readonly.

- **Mutable values** can be modified, but cannot be passed directly to readonly parameters.
- **Readonly values** cannot be modified after initialization.

### Safe Access to Mutable Values

Noma provides two ways to safely access mutable values:

- **`snapshot`** creates an independent, readonly copy of a value. Changes to the original value do not affect the snapshot.
- **`read`** creates a temporary, readonly borrow of a value without copying it. The original value cannot be modified while the borrow is active.

Multiple readonly borrows are allowed, but a mutable borrow cannot coexist with a readonly borrow of the same value.

### Arrays and Lazy Futures

Array literals require an explicit expected type. Use `arr.length<T>()` to read the size; arrays have no `.length` property.

```noma
use "std/arr" as arr;

async fn calculate() -> int32 { return 42; }

pub async fn main() -> int32 {
    let mut values: Array<int32> = [10, 20];
    arr.push<int32>(values, 30);
    let count: int32 = arr.length<int32>(read values);
    let pending: Future<int32> = calculate();
    let answer: int32 = await pending;
    return answer - count;
}
```

Calling an async function creates a lazy, readonly Future. `await` runs and consumes it once. Futures cannot be snapshotted or reused after a move. See [the implementation and current limits](docs/read-array-future.md) and [the runnable example](examples/arrays-futures.noma).

### Error Handling

Noma provides two ways to handle raised errors:

- **`catch`** handles a raised error. Its handler must terminate the current control flow, for example by using `return` or `raise`.
- **`otherwise`** handles a raised error by providing a fallback value, or by terminating the current control flow.

### Numeric Types

Noma supports `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`, `float32`, and `float64`. Integer arithmetic is exact and checked: overflow and division by zero fail at compile time for constant expressions, or stop execution with a Runtime Error. Operands must have the same concrete type; conversions require an explicit cast.

```noma
let maximum: uint64 = 18446744073709551615;
let small: uint8 = 200;
let wide: uint16 = (uint16)small;
```

TypeScript uses BigInt internally for integers. It is not a Noma type. Numeric casts must preserve integer values exactly. See [numeric semantics](docs/numeric-types.md) for ranges, floating point behavior, and Native migration details.
