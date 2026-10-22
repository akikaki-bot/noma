# Changelog

## 0.3.0 — 2026-10-18

- Support temporary `read` borrowing, lazy `Future<T>`, async/await and ownership diagnostics.
- Complete new keywords and Future types; show async call signatures as `Future<T>` and preserve definitions/references.
- Bundle `std/arr` and its typed private native boundary. Expose the seven public array operations in completion.
- Remove array `.length` completion and diagnose its use; retain ordinary struct fields named `length`.
- Require expected types for array literals and explicit generic arguments.
- Add seven snippets for async main/functions, read arguments, typed arrays, array length, Future bindings and await results.
- Extend JSON-RPC, snippet and Extension Host regression tests.

## 0.2.0 — 2026-10-15

- Separate VS Code client, LSP transport/service and compiler source directories.
- Reuse AnalysisWorkspace and AnalysisSnapshot for syntax/type/mutability diagnostics, completion, hover, definitions and references.
- Synchronize unsaved file and untitled documents, debounce analysis, merge diagnostics and discard stale results.
- Handle watched files and workspace folder changes; aggregate references across open analysis roots.
- Bundle analysis-only compiler code and stdlib, with third-party license notices.
- Add JSON-RPC integration tests and an isolated VS Code Extension Host test runner.
- Require VS Code 1.91 or later. Semantic queries currently require a successful compiler snapshot.

## 0.1.0 — 2026-10-15

- `.noma` recognition and TextMate syntax highlighting.
- Nested comments, explicit type annotations, function names and native bridge keywords.
- Bracket and quote editing, indentation and 13 basic snippets.
- Reproducible local VSIX packaging and grammar/snippet regression tests.
- Language Server features remain planned for the second phase.
# Language v0.0.2

- Replace throw with raise/catch; retain otherwise.
- Highlight structural casts and std/typing type designators; add raise/catch snippets.
- Share signature-based mut checks, snapshot requirements and structural projection diagnostics with the compiler.

