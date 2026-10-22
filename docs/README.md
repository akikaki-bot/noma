# Noma（のま）

高水準・静的型付けの自作言語を設計するための、TypeScript製ASTインタプリタです。変数・引数の型注釈、Deep Readonly、明示的な変更権限、標準ライブラリ経由のI/Oを軸にしています。言語名と拡張子 `.noma` は決定済みです。処理系・標準APIはまだ実験段階です。

設計の基準はユーザー提供の [言語仕様 v0.0.2](language-spec-v0.0.2.md) と [Read / Array / Future v0.1](read-array-future.md) です。[実装状況と試作上の制約](implementation-status.md)、[開発計画](development-plan.md)、[引き継ぎ記録・未決事項](handoff.md)、[Generics v0.1・条件式・補完](generics-v0.1.md)、[LSP向けAPI](lsp-api.md) を併せて参照してください。

## 実行

Node.js 22.18以上とnpmが必要です。今回の動作確認環境はWindows / Node.js 26.7.0です。

```powershell
npm ci
npm test
npm run demo
npm start -- --version
npm start -- examples/echo.noma
npm start -- --check examples/snapshot.noma
npm start -- examples/stdlib.noma
npm start -- examples/generics.noma
npm start -- examples/arrays-futures.noma
```

`npm start` の前に `npm run build` が必要です。`npm test` と `npm run demo` はビルドも実行します。`--check` は全モジュールの静的検査とnative署名の照合だけを行い、Nomaコードを実行しません。

```noma
use "std/io" as io;

fn main() -> int32 {
	io.puts("Hello, Noma🌱") catch error {
		return 1;
	};
	return 0;
}
```

CLIの入口は引数なしの `main() -> void` または `main() -> int32` です。`async main()` もLazy Futureを最後まで駆動し、整数の戻り値をプロセスの終了コードに渡します。診断はファイル・行・列を付けて標準エラーへ出力します。実行時の算術オーバーフローや配列範囲外アクセスは位置付き診断で停止します。

## 最初の縦切り

- Lexer / Parser / AST / 名前解決 / 静的型検査 / Interpreter / CLI
- `string`、8種類の固定幅整数、`float32` / `float64`、`bool`、`void`、`never`、構造体、配列、Union
- 関数、明示的な型注釈、`mut`、Deep Readonly、独立した `snapshot`
- `match` の型絞り込みと網羅性、`raise` / `catch` / `otherwise` の型と制御フローの検査
- alias必須の `use`、`pub`、自作言語で記述した `std/io` / `std/string` / `std/number`、コンパイラAPI `std/typing`
- 署名だけで決まるmut引数、暗黙の幅の部分型変換の禁止、独立した構造的キャストと `typing.trycast`
- 型引数を完全明示するジェネリック関数・型エイリアス、括弧あり／なしのif・while条件
- `read`による呼び出し中の借用、期待型必須の配列リテラル、`std/arr`の7操作（配列の `.length` は廃止）
- Lazy `Future<T>`、async / await、単一タスクの中断・再開、非複製型の所有権・消費状態検査
- 通常値として使えないコンパイル時メタ型 `Type`
- 制限された `TSAny` と型付きNative Registry、UTF-8 / EOF / I/O失敗の接続

これは仕様全体の完成を意味しません。構造型が重なる場合の分岐や、参照の寿命・別名規則などは制限付きの実装です。詳しくは [対応表](docs/implementation-status.md) を参照してください。

`std/string` はUnicodeコードポイント単位の長さ・検索・スライス・置換などを提供します。trimと大小文字変換は現時点ではASCII限定です。`std/number` は全数値型のtoString、int32のパース・文字列化・範囲操作・失敗値を返すchecked演算を提供します。公開APIはNomaで記述し、Unicode・checked演算・数値文字列化等のホスト依存部分を型付きNativeへ接続しています。境界条件の仕様・全署名・使用例は [標準ライブラリAPI](standard-library.md) を参照してください。

## VS Code拡張

数値型の範囲、暗黙変換の禁止、定数／実行時オーバーフロー、浮動小数点と正確なキャスト規則は [数値型仕様](numeric-types.md) を参照してください。整数のBigInt表現はTypeScript処理系の内部詳細です。

[Noma Language](../extensions/vscode-noma/README.md) は `.noma` の認識、ハイライト、編集補助、21種類のスニペットに加え、LSPによる診断・キーワード／識別子／フィールド補完・引数ヒント・Hover・定義ジャンプ・参照検索を提供します。

```powershell
npm run extension:install
npm run extension:package
code --install-extension extensions/vscode-noma/dist/noma-language-0.3.0.vsix
```

パッケージ生成前に処理系の開発依存を `npm ci` で準備してください。`extension:package` は拡張のテストも実行します。テストだけを実行する場合は `npm run extension:test` を使用できます。F5で **Noma: Extension Development Host** を起動して、開発中の拡張を確認できます。

LSPは既存の解析APIを共有します。処理系は `src/`、LSPサーバーは `extensions/vscode-noma/src/server/`、VS Codeクライアントは同 `src/client/` に分離しています。診断は最初の1件。補完と引数ヒントは未完成コードでも現在の文書から回復した情報を使用し、Hover・定義・参照は型検査成功時に利用できます。詳細と参照検索の範囲は [エディタサポート](docs/editor-support.md) を参照してください。実際のVS Codeで検証するには `npm run extension:test:host` を使用できます。

## ディレクトリ

| 場所                                                                 | 役割                                              |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| `src/lexer.ts`, `src/parser.ts`, `src/ast.ts`                        | ソースからASTへ                                   |
| `src/types.ts`, `src/checker.ts`, `src/safety.ts`                    | 型の互換性、可変性、借用と所有権の制御フロー      |
| `src/assistance.ts`                                                  | 未完成コードの補完コンテキストと引数ヒント        |
| `src/modules.ts`                                                     | モジュール解決と信頼境界                          |
| `src/interpreter.ts`, `src/values.ts`                                | 実行と値の独立性                                  |
| `src/native.ts`                                                      | Native RegistryとNode.js標準I/O                   |
| `stdlib/std/typing.noma`                                             | trycastの公開するコンパイラ固有宣言               |
| `stdlib/std/arr.noma`, `stdlib/std/internal/arr.noma`                | Nomaの配列APIと署名照合されるnative借用境界        |
| `stdlib/std/io.noma`                                                 | 公開する実験的I/Oラッパー                         |
| `stdlib/std/string.noma`, `stdlib/std/number.noma`                   | Noma製の文字列・int32標準API                      |
| `stdlib/std/internal/io.noma`                                        | 非公開native宣言と型付きラッパー                  |
| `stdlib/std/internal/string.noma`, `stdlib/std/internal/number.noma` | Unicodeとchecked演算の非公開native境界            |
| `src/stdlib-native.ts`                                               | Unicodeスカラー取得・生成と正確な整数範囲検査     |
| `examples/`                                                          | hello / echo / snapshot / stdlib / generics       |
| `test/`                                                              | 正常系・拒否すべきコード・I/O境界・CLI            |
| `extensions/vscode-noma/`                                            | VS Codeの言語定義・TextMate・スニペット・VSIX生成 |
| `docs/`                                                              | 仕様・実装状況・計画・未決事項                    |

`npm run typecheck` でTypeScriptを検査し、`npm run format` / `npm run format:check` で整形・整形検査を実行できます。インデントはタブ文字、表示幅4です。実行時の外部パッケージ依存はありません。
