# Noma 実装状況 — 2026-10-16 / v0.0.2

設計上の決定は [language-spec-v0.0.2.md](language-spec-v0.0.2.md) を基準にする。この文書は現在の試作で受け付ける範囲を記録するもので、未確定の言語仕様を確定させるものではない。言語名 **Noma（のま）** と拡張子 **`.noma`** は、Work移行後にユーザーが決定した。

## 対応表

| 機能 | 状態 | 現在の範囲 |
| --- | --- | --- |
| Lexer / AST / Parser | 実装済み（試作文法） | 位置付き診断、文字列、整数、ネストしたコメント |
| 変数・引数の型注釈 | 実装済み | 型注釈を省略するとParserで拒否。式の型計算は行う |
| 関数・return | 実装済み（基本） | 戻り値注釈も必須、再帰呼出し可、関数値・クロージャなし |
| 構造的型付け・射影 | 実装済み（非再帰型） | 同一構造は互換。暗黙の幅の部分型変換は禁止し、明示キャストで独立した射影を生成 |
| 配列 | 一部実装 | `T[]` / `Array<T>`、添字、読み取り専用の `.length`。ジェネリクス・可変長操作なし |
| Union | 一部実装 | フラット化、同等型の重複除去、順序に依存しない互換性。完全な正規化は未実装 |
| Deep Readonly / snapshot | 実装済み（基本） | 静的な書き込み禁止と、再帰コピー・freezeによる独立性 |
| 可変引数 | 一部実装 | シグネチャのみの `mut` とReadonly引数へのsnapshot要求、変数・フィールド・配列要素への反映。競合は保守的に拒否 |
| match | 一部実装 | 型ケース、ワイルドカード、式・文、絞り込み、網羅性。重なる型の判別は拒否 |
| raise / catch / otherwise | 実装済み（基本） | throwableを返す関数からの送出、never検査、代替値の型検査、return/break |
| モジュール・公開制御 | 実装済み（基本） | alias必須、`pub`、関数と型の公開、循環importは拒否 |
| Native Bridge | 実装済み（実験ABI） | 特権型の封じ込め、署名照合、入出力検証、登録済み関数のみ呼出し |
| std/io | 実装済み（実験API） | stdout/stderrのwrite/puts、UTF-8 readLine、EOF、エラー値 |
| std/typing・Type | 実装済み | 型指定引数、実行時検査と独立した射影、Typeの通常利用を禁止 |
| CLI・テスト | 実装済み | 実行、静的検査のみのモード、ホスト差し替え、失敗系テスト |
| メモリ管理 | ホストに委譲 | JavaScript GC。手動メモリ管理は要求しない |
| VM・コード生成・セルフホスティング | 未実装 | 将来目標 |

## 試作で採用した表記

`fn` / `let` / `type` と、通常文末のセミコロンを使う。構造体値は `struct { ... }` または `User { ... }` / `module.User { ... }` で作る。配列は `T[]` と `Array<T>` を受け付ける。後者は配列専用の表記で、一般ジェネリクスではない。

```noma
type User = struct { name: string; scores: int32[]; };
let mut user: User = struct { name: "Alice", scores: [10, 20] };
let saved: User = snapshot user;
```

配列・構造体リテラルの型は式として計算する。空配列には宣言や戻り値などから期待配列型が必要。宣言自体の型注釈は省略できない。

`if` とブロックにも値があり、ブロック末尾のセミコロンなしの式が値になる。関数末尾のブロック値も戻り値として検査する。値が正常に返らない経路の型は `never`、通常完了して値がない経路は `void` とする。ループが必ず終了しないことの証明はまだ行わない。

```noma
fn classify(value: string | int32) -> int32 {
	return match (value) {
		case (text: string) { 1 }
		case (number: int32) { number + 1 }
	};
}
```

`case _ { ... }` は残りすべてを扱う試作用のワイルドカード。構造型ケース間に同じ値が入り得る場合、順序で意味を決めずコンパイルエラーにする。配列型同士は空配列で重なるため、異なる要素型の配列を型ケースだけで判別することも拒否する。完全な部分パターン、リテラルパターン、ネストしたパターンは未実装。

`snapshot array[0]` のASTは要素に対するsnapshot、`(snapshot array)[0]` のASTは配列に対するsnapshotの後の添字になる。どちらも対象の内部を再帰的に複製する。

## 可変性と別名の暫定制約

- `let mut` の初期化と代入では集約値を深くコピーする。元のimmutable値に書き込みが伝播しない。
- immutable束縛へmutable由来の値を直接保持するときは、スカラーも含めて `snapshot` が必要。配列・構造体リテラルに包んで回避することも禁止。
- 算術、文字列連結、比較などは新しい計算結果を作る。mutable値を通常読み取りして計算することは可能。
- 通常引数はreadonly。可変な実引数には明示的snapshotが必要。現ランタイムは安全のため引数値をコピーする。集約型readonly引数の保持・返却は、将来の借用実装に備えて検査器が保守的に `snapshot` を要求する。
- mutable引数の変更は呼び出し元のセルに反映する。mutable参照には同一の静的型を要求し、幅の部分型変換による書き込みを防ぐ。
- 一つの呼出しで同じ根の変数を複数回 `mut` に渡す、または読み取りと `mut` を併用する形は拒否する。異なる配列要素も同じ根なら拒否する。
- Union型の値全体を別の互換値へ代入することは可能。Unionのフィールド経由の書き込みは、フィールド間の型の関連を壊し得るので拒否する。
- match内で絞り込んだ名前はreadonlyとして扱う。

これは正式な所有権・寿命・借用規則ではない。クロージャ、ソース言語の非同期処理、並行実行、外部へ脱出する参照は提供しない。

## Native Bridgeの信頼境界

実験ABIの宣言は次の形とする。元仕様の `/* Native Bridge */` は例示用プレースホルダーなので、試作では `intrinsic` を予約語として認識する。

```noma
compilerOnly type TSAny = intrinsic;
native fn writeStdout(value: TSAny) -> void | throwable;
```

`TSAny` はバンドルされた `std/internal/` 内でのみ定義できる。privateなnative関数の直接の入力型にだけ使用でき、一般変数・通常関数・戻り値・公開署名・別名型には使えない。普通の値からTSAny引数への受け渡しはnative呼出しでのみ認め、Registry側の入力契約で検証する。一般コードに万能な代入可能性は導入しない。

モジュール識別子と関数名を組にして登録する（例: `std/internal/io#writeStdout`）。全native宣言を実行前に照合し、未登録・引数数不一致・戻り値型不一致を拒否する。呼出し時にも入力を登録型で検査し、ホスト戻り値を登録型と宣言型の両方で検査する。境界の値は独立したreadonly値として渡す。

`std/` の解決先は処理系に同梱したstdlib。`std/internal/` はアプリからimportできない。相対パスや同名ファイルは特権を得ない。realpathによるルート検査を行う。標準ライブラリのファイルとTypeScriptホスト実装は信頼基盤であり、この処理系は任意コードを安全に隔離するサンドボックスではない。

現時点の `throwable` はraiseとホストエラー用のopaqueな組込み型で、`.message: string` のみ公開する。内部ではブランドを持たせ、普通の `struct { message: ... }` と区別する。**throwableの正式な表現・ユーザー定義エラーの設計は未決定のまま**であり、この実験ABIを恒久仕様としない。

## 実験的 std/io API

| 関数・型 | 型 | 動作 |
| --- | --- | --- |
| `write` | `(text: string) -> void | throwable` | stdoutへUTF-8、改行を追加しない |
| `puts` | `(text: string) -> void | throwable` | 自作言語側でLFを付加してwrite |
| `writeError` | `(text: string) -> void | throwable` | stderrへUTF-8 |
| `putsError` | `(text: string) -> void | throwable` | stderrへLF付き出力 |
| `readLine` | `() -> string | EOF | throwable` | 一行、EOF、または失敗 |
| `EOF` | `struct { eof: bool; }` | native側は `{ eof: true }` を生成する |

readLineはLFを除去し、CRLFのCRも除去する。空行は `""`、空入力はEOF。最後に改行のない行も一度返し、それ以降はEOFを返す。単独の末尾CRは通常の文字として保持する。UTF-8はchunkをまたいで復号し、不正・途切れたUTF-8は `throwable` にする。BOMは文字として保持する。

入力は最初のreadLineまで読まない。Node.jsのwrite callback完了を待ち、出力失敗をエラー値へ変換する。writeの完了はディスクへの永続化を保証するものではない。I/O名・EOF表現・改行/BOMポリシーは実験APIとして変更できる。

## 実行上の制限

実行は逐次的なAST解釈であり、ソース言語にasync/Promiseはない。ホストI/Oの待機にTypeScriptのasyncを使う。デフォルト100万ステップで停止するガードを置き、埋め込みAPIの `maxSteps` で変更できる。再帰の深さ・入力行の長さ・メモリ消費の上限管理は未整備。再帰型、ジェネリクス、null、浮動小数点、数値の暗黙変換、ファイルI/O、文字列メソッド、`continue`、classは未実装。後置`++`は可変int32に対応し、エラー結果の送出は`raise`で行う。

## v0.0.2の判断と残る制約

raiseのpayload制限、Union射影の曖昧さ、コンパイラ固有API宣言、同期呼び出しに限定した借用検査の詳細は [現行仕様](language-spec-v0.0.2.md) を参照する。静的キャストとtrycastは新しい独立したReadonly値を生成する。Typeは通常の値の型ではなく、TSAnyも引き続きnative境界限定。精密な寿命解析やCopy-on-Writeは未実装。
