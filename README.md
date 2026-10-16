# Noma（のま）

高水準・静的型付けの自作言語を設計するための、TypeScript製ASTインタプリタです。変数・引数の型注釈、Deep Readonly、明示的な変更権限、標準ライブラリ経由のI/Oを軸にしています。言語名と拡張子 `.noma` は決定済みです。処理系・標準APIはまだ実験段階です。

設計の基準はユーザー提供の [言語仕様 v0.0.2](docs/language-spec-v0.0.2.md) です。[実装状況と試作上の制約](docs/implementation-status.md)、[開発計画](docs/development-plan.md)、[引き継ぎ記録・未決事項](docs/handoff.md)、[LSP向けAPI](docs/lsp-api.md) を併せて参照してください。

## 実行

Node.js 22.18以上とnpmが必要です。今回の動作確認環境はWindows / Node.js 26.7.0です。

```powershell
npm ci
npm test
npm run demo
npm start -- --version
npm start -- examples/echo.noma
npm start -- --check examples/snapshot.noma
```

`npm start` の前に `npm run build` が必要です。`npm test` と `npm run demo` はビルドも実行します。`--check` は全モジュールの静的検査とnative署名の照合だけを行い、Nomaコードを実行しません。

```noma
use "std/io" as io;

fn main() -> int32 {
	io.puts("Hello, Noma! こんにちは 🌱") catch error {
		return 1;
	};
	return 0;
}
```

CLIの入口は引数なしの `main() -> void` または `main() -> int32` です。整数の戻り値をプロセスの終了コードに渡します。診断はファイル・行・列を付けて標準エラーへ出力します。実行時の算術オーバーフローや配列範囲外アクセスは位置付き診断で停止します。

## 最初の縦切り

- Lexer / Parser / AST / 名前解決 / 静的型検査 / Interpreter / CLI
- `string`、`int32`、`bool`、`void`、`never`、構造体、配列、Union
- 関数、明示的な型注釈、`mut`、Deep Readonly、独立した `snapshot`
- `match` の型絞り込みと網羅性、`raise` / `catch` / `otherwise` の型と制御フローの検査
- alias必須の `use`、`pub`、自作言語で記述した `std/io`、コンパイラAPI `std/typing`
- 署名だけで決まるmut引数、暗黙の幅の部分型変換の禁止、独立した構造的キャストと `typing.trycast`
- 通常値として使えないコンパイル時メタ型 `Type`
- 制限された `TSAny` と型付きNative Registry、UTF-8 / EOF / I/O失敗の接続

これは仕様全体の完成を意味しません。構造型が重なる場合の分岐や、参照の寿命・別名規則などは制限付きの実装です。詳しくは [対応表](docs/implementation-status.md) を参照してください。

## VS Code拡張

[Noma Language](extensions/vscode-noma/README.md) は `.noma` の認識、ハイライト、編集補助、14種類のスニペットに加え、LSPによる診断・補完・Hover・定義ジャンプ・参照検索を提供します。

```powershell
npm run extension:install
npm run extension:package
code --install-extension extensions/vscode-noma/dist/noma-language-0.2.0.vsix
```

パッケージ生成前に処理系の開発依存を `npm ci` で準備してください。`extension:package` は拡張のテストも実行します。テストだけを実行する場合は `npm run extension:test` を使用できます。F5で **Noma: Extension Development Host** を起動して、開発中の拡張を確認できます。

LSPは既存の解析APIを共有します。処理系は `src/`、LSPサーバーは `extensions/vscode-noma/src/server/`、VS Codeクライアントは同 `src/client/` に分離しています。診断は最初の1件で、意味情報の機能は型検査成功時に利用できます。詳細と参照検索の範囲は [エディタサポート](docs/editor-support.md) を参照してください。実際のVS Codeで検証するには `npm run extension:test:host` を使用できます。

## ディレクトリ

| 場所 | 役割 |
| --- | --- |
| `src/lexer.ts`, `src/parser.ts`, `src/ast.ts` | ソースからASTへ |
| `src/types.ts`, `src/checker.ts` | 型の互換性、可変性、制御フロー |
| `src/modules.ts` | モジュール解決と信頼境界 |
| `src/interpreter.ts`, `src/values.ts` | 実行と値の独立性 |
| `src/native.ts` | Native RegistryとNode.js標準I/O |
| `stdlib/std/typing.noma` | trycastの公開するコンパイラ固有宣言 |
| `stdlib/std/io.noma` | 公開する実験的I/Oラッパー |
| `stdlib/std/internal/io.noma` | 非公開native宣言と型付きラッパー |
| `examples/` | hello / echo / snapshot |
| `test/` | 正常系・拒否すべきコード・I/O境界・CLI |
| `extensions/vscode-noma/` | VS Codeの言語定義・TextMate・スニペット・VSIX生成 |
| `docs/` | 仕様・実装状況・計画・未決事項 |

`npm run typecheck` でTypeScriptを検査し、`npm run format` / `npm run format:check` で整形・整形検査を実行できます。インデントはタブ文字、表示幅4です。実行時の外部パッケージ依存はありません。
