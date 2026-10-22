# Integer Types & Numeric Runtime 実装報告

## 結果

8種類の固定幅整数を既存int32と同じ型・実行経路へ統合した。uint64最大値までソースから直接正確に解析し、TypeScript Runtimeの全整数をbigintで保持する。Nomaの公開型にBigIntは追加しない。値域、演算、キャストの規則を共通モジュールに集約し、将来の別バックエンドにも適用する仕様を[数値型仕様](numeric-types.md)に記述した。

## 調査した既存処理

- Lexerは10進整数のテキストを保持していたが、ParserがNumberへ変換していた。AST・Checker・Runtimeはint32のみで、float型と数値キャストは未実装だった。
- 名前解決はCheckerとbuiltinsを使用する構成で、独立したResolverファイルは存在しなかった。型注釈必須・完全明示の型引数・既存の構造射影を維持した。
- int32の定数式検査とRuntimeの範囲検査を拡張し、並行した別系統の整数実装を追加しなかった。
- std/ioは文字列出力、std/numberはint32のパース・文字列化・checked演算、std/stringとstd/arrはint32のindexを使っていた。既存APIを維持して内部値を移行した。
- Futureの状態は文字列で管理されており、変更対象は整数の結果値とその具体型の保持。LSPはRuntime値やASTを送らず、診断・文字列の型説明・位置を送信していた。

## 実装内容

- 整数リテラル・定数式・実行時演算を正確な整数で処理し、各段階で値域を検査する。signed最小値の単項マイナス構文、0方向への整数除算と対応する剰余、++/--、ゼロ除算を検証する。
- 文脈的リテラル検査を変数・引数・戻り値・算術式へ適用し、異なる具体型の暗黙変換を禁止する。
- 定数の不正な演算／キャストをコンパイル時に拒否し、動的な不正操作を位置付きRuntime Errorにする。checked int32 APIのthrowable契約を維持する。
- float32/64をnumberで表現し、float32にbinary32丸めを適用する。NaN・±Infinity・±0を保持する。
- ユーザー指定に従い、float→整数は有限・整数値・値域内の場合だけ許可する。整数→floatは元の数学的整数値を正確に保存する場合だけ許可する。通常のfloat演算のIEEE丸めとは区別する。
- Unionの数値幅を値域から推測せず、具体型をセルや集約要素に付随させて保持する。snapshot・read・構造射影・Generics・Future・Nativeの経路を検証した。
- Native Registryはbigint整数と型情報を検証する。ホストindexへの変換前に値域を確認し、数値UnionのNative結果にはNativeValueで具体型を指定できる。
- std/number.toStringを単一の全数値型APIとして追加した。既存parseInt32等を保持し、uint64最大値も文字列経由で出力できる。
- コンパイラ用JSON replacer/reviverと、具体型・整数精度・IEEE特殊値・集約要素の型情報を保存するRuntime値のserializationを追加した。
- 最終レビューで構造射影後に古い集約型情報が残る問題を修正し、回帰テストを追加した。

## この作業で変更・追加したファイル

既に作業ツリーにあったread・Array・Future等の変更を保持している。以下は今回の数値対応で触れたファイルであり、作業開始前から存在した他の未コミット変更は含まない。

| 対象 | ファイル |
| --- | --- |
| 数値仕様・型・解析 | `src/numeric.ts`（追加）、`src/types.ts`、`src/ast.ts`、`src/lexer.ts`、`src/parser.ts`、`src/checker.ts` |
| Runtime・公開ホストAPI | `src/interpreter.ts`、`src/values.ts`、`src/serialization.ts`（追加）、`src/cli.ts`、`src/index.ts` |
| Native・配列・標準関数 | `src/native.ts`、`src/stdlib-native.ts`、`src/array-runtime.ts`、`stdlib/std/number.noma`、`stdlib/std/internal/number.noma` |
| 数値テスト（追加） | `test/numeric.test.ts`、`test/numeric-runtime.test.ts`、`test/numeric-native-abi.test.ts`、`test/numeric-serialization.test.ts`、`test/numeric-review.test.ts` |
| 実際のNoma統合ケース（追加） | `test/fixtures/numeric.noma`、`test/fixtures/numeric-native.noma` |
| 既存回帰テストのbigint移行 | `test/language.test.ts`、`test/generics.test.ts`、`test/conditions.test.ts`、`test/safety.test.ts`、`test/v002.test.ts`、`test/io.test.ts`、`test/stdlib.test.ts`、`test/array-native.test.ts`、`test/borrowing-arrays-futures.test.ts` |
| LSP・ハイライト | `extensions/vscode-noma/test/lsp.test.mjs`、`extensions/vscode-noma/syntaxes/noma.tmLanguage.json` |
| ドキュメント | `README.md`、`docs/README.md`、`docs/numeric-types.md`（追加）、`docs/implementation-status.md`、`docs/language-spec-v0.0.2.md`、`docs/standard-library.md`、この報告書 |

## 最終検証結果

| コマンド | 結果 |
| --- | --- |
| `npm test`（buildを含む） | **391 / 391 成功** |
| `npm run extension:test`（処理系・拡張buildを含む） | **50 / 50 成功** |
| `npm run extension:test:host` | **成功**。実際のVS Codeでactivation・定義・Hover・補完・参照・診断・Future回帰等の5チェックを確認 |
| `npm run typecheck` | 成功 |
| `npm run format:check` | 成功 |
| `git diff --check` | 成功（既存の改行コードに関するGit警告のみ） |

初回は既存Genericsテストの旧診断メッセージ期待とsandboxの一時ファイルrename権限により失敗した。期待文言を更新し、権限による失敗は承認されたsandbox外実行で再検証して解消した。最終実行の失敗・skipは0件。

## 未解決事項・移行時の注意

今回の要求範囲で未解決の不具合はない。意図的な精度損失を許可する専用変換関数は、指示どおり将来のstd/number拡張とする。

TypeScriptの埋め込み側では、runFile／Interpreter.runの整数結果やNative整数引数・戻り値がnumberからbigintへ変わる。数値Unionのホスト値には具体型の付随情報が必要。配列・文字列のindex APIは既存仕様のint32を維持する。これはホストABIの変更であり、NomaにBigInt型を公開するものではない。

コミット・pushは実装完了後の追加ユーザー指示に従って行う。
