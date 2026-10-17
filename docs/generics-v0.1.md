# Generics v0.1・条件式・LSP補完

2026-10-16。v0.0.2の型・可変性・構造的キャストを維持する拡張。

## 明示的なジェネリクス

```noma
fn identity<T>(value: T) -> T { return value; }
type Box<T> = struct { value: T; };
type Pair<T, U> = struct { first: T; second: U; };

let answer: int32 = identity<int32>(42);
let nested: Box<Box<int32>> = Box<Box<int32>> {
    value: Box<int32> { value: answer }
};
let mixed: Box<int32 | string> = Box<int32 | string> { value: "Hello" };
```

型引数は関数呼び出し・型注釈・名前付き構造体リテラルのすべてで完全明示。`identity(42)`、`Box { value: 42 }`、型注釈だけの `Box` はコンパイルエラー。部分省略・デフォルト・推論・制約・オーバーロードは提供しない。型引数の個数と名前の型としての有効性を検査する。`Array<T>` と `T[]` は従来の配列表記として維持する。ネストした `>>`、`Box<int32>=...` の隣接する記号にも対応する。

型パラメータは宣言内だけで有効な抽象型。同じ綴りでも別の宣言のパラメータとは異なる型で、一般の型エイリアスを内側で隠せる。組込み型名の再宣言は従来どおり禁止する。定義自体を抽象型のまま検査するので、未使用の `fn double<T>(x: T) -> T { return x + x; }` も拒否する。

具体化後は構造で型を比較する。`Box<int32>` と `struct { value: int32; }` は互換で、`Box<string>` とは互換でない。幅の異なる構造への暗黙変換は行わず、既存の明示的なキャストを使う。直接・間接の循環型と、型引数が増大する循環展開は拒否する。

```noma
fn replace<T>(mut target: T, value: T) -> void { target = value; }
let mut x: int32 = 10;
replace<int32>(x, 20);
let saved: int32 = identity<int32>(snapshot x);
```

`identity<int32>(x)` はReadonly引数への可変値なのでエラー。可変引数の不変な型一致・排他的借用・Deep Readonly・snapshotの独立性は維持する。抽象的なReadonly `T` は値として受け渡せるため `identity<T>` を許可し、現在のInterpreterは引数と戻り値を独立したDeep Readonly値としてコピーする。既知の構造体・配列型のReadonly引数からの保持や返却には、従来どおりsnapshotを要求する。

実行は検査済みの関数ASTを共有する。呼び出しフレームごとに型パラメータの代入表を持ち、引数・戻り値・キャスト・trycast・matchを具体化した型で検証する。未解決の抽象型をランタイムの万能型として扱わない。型パラメータを用いてmatchの保守的な重なり検査を緩和しない。

## 条件式

`if value > 0 { ... }` と `if (value > 0) { ... }`、`while i < 10 { ... }` と `while (i < 10) { ... }` を受け付ける。条件はbool、ブロックの波括弧は必須。構造体リテラルが条件ブロックと曖昧になる場合は、条件を丸括弧で囲む。

```noma
if (User { age: 20 }.age > 10) { /* ... */ }
```

`if (user == User { ... }) { ... }` は構文として解析できるが、構造体の値同士の等価比較は従来どおり未対応。今回の拡張で等価比較の規則は変更していない。

## エディタ補助

`textDocument/completion` はキーワード、スコープ内の変数・引数・関数・型・モジュール別名、公開モジュールメンバー、構造体フィールドを返す。シャドーイングと宣言順序を尊重し、native・非公開メンバー・TSAnyを公開しない。フィールドには具体化した型を表示し、連続するフィールドアクセスと配列添字にも対応する。

未完成の `str.`、`box.`、`identity<`、閉じていないブロックでも、現在の文書から構文回復・部分型検査した情報を利用する。前の文書バージョンの型を流用しない。補完項目の置換範囲はUTF-16で、カーソル前後の識別子を置換する。文字列・コメント内では候補を返さない。

`textDocument/signatureHelp` は引数位置と引数ごとのラベルを返す。`identity<string>(` では `identity<string>(value: string) -> string` を表示する。ネストした関数呼び出し・構造体・配列・型引数・文字列のカンマを引数区切りに数えない。不正な型引数の個数では具体化したヒントを返さず、通常の診断を維持する。余分な値引数の位置ではヒントを返さず、存在しないパラメータを強調しない。

診断は引き続き解析ごとの最初の1件。Hover・定義・参照は全体の型検査成功時のみ。補完用の回復済みASTと部分検査結果は実行禁止。破損した宣言自体の情報や、関数の戻り値に直接続くフィールド補完など、任意の不完全な式の型解決は保証しない。

例は [examples/generics.noma](../examples/generics.noma)、実ファイル統合テストは `test/fixtures/generics.noma` と `test/fixtures/conditions.noma`。`npm test` は処理系テスト、`npm run extension:test` はJSON-RPCを含む拡張テストを実行する。

## 変更ファイル

| 範囲 | ファイル |
| --- | --- |
| 構文・型・名前解決 | `src/ast.ts`、`src/parser.ts`、`src/types.ts`、`src/checker.ts`、`src/semantic.ts` |
| 実行・型の具体化 | `src/interpreter.ts`、`src/values.ts` |
| 回復解析・補完API | `src/modules.ts`、`src/workspace.ts`、`src/analysis.ts`、新規 `src/assistance.ts`、型の再公開 `src/compiler.ts`・`src/index.ts` |
| LSP通信 | `extensions/vscode-noma/src/server/index.ts`、同 `service.ts` |
| テスト | 新規 `test/generics.test.ts`、`test/conditions.test.ts`、`test/assistance.test.ts`、`test/fixtures/generics.noma`、`test/fixtures/conditions.noma`、更新 `extensions/vscode-noma/test/lsp.test.mjs` |
| 使用例 | 新規 `examples/generics.noma` |
| 文書 | `README.md`、`docs/implementation-status.md`、`docs/lsp-api.md`、`docs/editor-support.md`、`extensions/vscode-noma/README.md`、本書 |

作業開始前から存在した標準ライブラリ関連の未コミット変更を保持した。標準APIの追加・コミット・pushは本作業では行っていない。
