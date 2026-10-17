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

### Error Handling

Noma provides two ways to handle raised errors:

- **`catch`** handles a raised error. Its handler must terminate the current control flow, for example by using `return` or `raise`.
- **`otherwise`** handles a raised error by providing a fallback value, or by terminating the current control flow.
