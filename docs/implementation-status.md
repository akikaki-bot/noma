# Noma 実装状況 — 2026-10-18 / v0.0.2 + Read / Array / Future v0.1

設計上の決定は [language-spec-v0.0.2.md](language-spec-v0.0.2.md) と、配列・借用・非同期処理を更新する [Read / Array / Future v0.1](read-array-future.md) を基準にする。この文書は現在の試作で受け付ける範囲を記録するもので、未確定の言語仕様を確定させるものではない。言語名 **Noma（のま）** と拡張子 **`.noma`** は、Work移行後にユーザーが決定した。

## 対応表

| 機能 | 状態 | 現在の範囲 |
| --- | --- | --- |
| Lexer / AST / Parser | 実装済み（試作文法） | 位置付き診断、文字列、整数、ネストしたコメント |
| 変数・引数の型注釈 | 実装済み | 型注釈を省略するとParserで拒否。式の型計算は行う |
| 関数・return | 実装済み（基本） | 戻り値注釈も必須、再帰呼出し可、関数値・クロージャなし |
| 構造的型付け・射影 | 実装済み（非再帰型） | 同一構造は互換。暗黙の幅の部分型変換は禁止し、明示キャストで独立した射影を生成 |
| 配列 | 実装済み（v0.1） | `T[]` / `Array<T>`、期待型必須のリテラル、添字、`std/arr`の7操作。`.length`は廃止 |
| `read` | 実装済み（保守的な検査） | 同期呼び出し中だけのコピーなし借用、ネストした借用競合と脱出の拒否 |
| Future / async / await | 実装済み（単一タスク） | Lazy実行、所有権移動、消費状態のフロー検査、async main、既存エラー処理との接続 |
| Generics v0.1 | 実装済み | 完全明示の関数・型エイリアス、抽象型検査、ネスト・Union・構造的具体化、フレーム単位の実行時代入 |
| 条件式の括弧省略 | 実装済み | if・whileの両表記、bool必須、曖昧な構造体リテラルに括弧を提案 |
| LSP補完・引数ヒント | 実装済み | スコープ・公開制御・具体化したフィールド型、未完成コードの回復、JSON-RPCテスト |
| Union | 一部実装 | フラット化、同等型の重複除去、順序に依存しない互換性。完全な正規化は未実装 |
| Deep Readonly / snapshot | 実装済み（基本） | 静的な書き込み禁止と、再帰コピー・freezeによる独立性 |
| 可変引数 | 一部実装 | シグネチャのみの `mut` とReadonly引数へのread / snapshot要求、変数・フィールド・配列要素への反映。競合は保守的に拒否 |
| match | 一部実装 | 型ケース、ワイルドカード、式・文、絞り込み、網羅性。重なる型の判別は拒否 |
| raise / catch / otherwise | 実装済み（基本） | throwableを返す関数からの送出、never検査、代替値の型検査、return/break |
| モジュール・公開制御 | 実装済み（基本） | alias必須、`pub`、関数と型の公開、循環importは拒否 |
| Native Bridge | 実装済み（実験ABI） | 特権型の封じ込め、署名照合、入出力検証、登録済み関数のみ呼出し |
| std/io | 実装済み（実験API） | stdout/stderrのwrite/puts、UTF-8 readLine、EOF、エラー値 |
| std/typing・Type | 実装済み | 型指定引数、実行時検査と独立した射影、Typeの通常利用を禁止 |
| std/string | 実装済み（実験API） | コードポイント単位の操作。trim・大小文字変換はASCII限定。境界条件案は標準API文書に記録 |
| std/number | 実装済み | 全数値型のtoString、Noma製のint32パース・範囲操作、正確なnative checked int32演算 |
| 固定幅整数・浮動小数点 | 実装済み | int8/16/32/64、uint8/16/32/64、float32/64。正確な数値キャストと同型演算。[数値仕様](numeric-types.md)参照 |
| 整数オーバーフロー | 実装済み | 全8型で定数式はコンパイルエラー、通常演算はRuntime Error、既存checked int32演算はthrowable |
| CLI・テスト | 実装済み | 実行、静的検査のみのモード、ホスト差し替え、失敗系テスト |
| メモリ管理 | ホストに委譲 | JavaScript GC。手動メモリ管理は要求しない |
| VM・コード生成・セルフホスティング | 未実装 | 将来目標 |

## 試作で採用した表記

`fn` / `let` / `type` と、通常文末のセミコロンを使う。構造体値は `struct { ... }` または `User { ... }` / `module.User { ... }` で作る。配列は `T[]` と `Array<T>` を受け付ける。関数・型エイリアスのジェネリクスは [Generics v0.1](generics-v0.1.md) を参照。

```noma
type User = struct { name: string; scores: int32[]; };
let mut user: User = struct { name: "Alice", scores: [10, 20] };
let saved: User = snapshot user;
```

配列リテラルは空・非空とも宣言・引数・戻り値などの期待配列型が必須。要素からの独立した型推論はしない。構造体リテラルにも明示されたフィールドの期待型を伝える。宣言自体の型注釈は省略できない。

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
- 通常引数はreadonly。可変な実引数には `read` または `snapshot` が必要。通常の引数受け渡しではコピーせず、集約型readonly引数の保持・返却には保守的に `snapshot` を要求する。非複製のFutureは所有権を移動する。
- mutable引数の変更は呼び出し元のセルに反映する。mutable参照には同一の静的型を要求し、幅の部分型変換による書き込みを防ぐ。
- 一つの呼出しで同じ根の変数を複数回 `mut` に渡す、または読み取りと `mut` を併用する形は拒否する。異なる配列要素も同じ根なら拒否する。
- Union型の値全体を別の互換値へ代入することは可能。Unionのフィールド経由の書き込みは、フィールド間の型の関連を壊し得るので拒否する。
- match内で絞り込んだ名前はreadonlyとして扱う。

所有権・借用・非同期処理は [Read / Array / Future v0.1](read-array-future.md) の範囲に対応する。クロージャ、並行実行、外部へ脱出する参照は提供しない。Futureを含む型の部分Move・可変コンテナ・一般の型引数への受け渡しは保守的に拒否する。

## Native Bridgeの信頼境界

実験ABIの宣言は次の形とする。元仕様の `/* Native Bridge */` は例示用プレースホルダーなので、試作では `intrinsic` を予約語として認識する。

```noma
compilerOnly type TSAny = intrinsic;
native fn writeStdout(value: TSAny) -> void | throwable;
```

`TSAny` はバンドルされた `std/internal/` 内でのみ定義できる。privateなnative関数の直接の入力型にだけ使用でき、一般変数・通常関数・戻り値・公開署名・別名型には使えない。普通の値からTSAny引数への受け渡しはnative呼出しでのみ認め、Registry側の入力契約で検証する。一般コードに万能な代入可能性は導入しない。

モジュール識別子と関数名を組にして登録する（例: `std/internal/io#writeStdout`）。全native宣言を実行前に照合し、未登録・引数数不一致・戻り値型不一致を拒否する。呼出し時にも入力を登録型で検査し、ホスト戻り値を登録型と宣言型の両方で検査する。通常nativeの境界値は独立したreadonlyコピー。`std/internal/arr` の7つのprivate nativeだけは、具体型とreadonly／mutのモードを検査する専用の借用ABIを使い、配列をコピーしない。generic / mut nativeの無制限な許可ではない。

`std/` の解決先は処理系に同梱したstdlib。`std/internal/` はアプリからimportできない。相対パスや同名ファイルは特権を得ない。realpathによるルート検査を行う。標準ライブラリのファイルとTypeScriptホスト実装は信頼基盤であり、この処理系は任意コードを安全に隔離するサンドボックスではない。

現時点の `throwable` はraiseとホストエラー用のopaqueな組込み型で、`.message: string` のみ公開する。内部ではブランドを持たせ、普通の `struct { message: ... }` と区別する。**throwableの正式な表現・ユーザー定義エラーの設計は未決定のまま**であり、この実験ABIを恒久仕様としない。

## 実験的 std/io API

文字列・数値APIと内部nativeの範囲は [標準ライブラリAPI](standard-library.md) を参照する。`std/io.stdoutWrite` は既存の `write` と同じ動作で追加した。

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

実行は逐次的なAST解釈。ソース言語のLazy FutureとホストI/Oの待機にTypeScriptのasyncを使う。公開APIにPromiseは導入しない。デフォルト100万ステップで停止するガードを置き、埋め込みAPIの `maxSteps` で変更できる。再帰の深さ・入力行の長さ・メモリ消費の上限管理は未整備。再帰型、null、ファイルI/O、文字列メソッド、`continue`、classは未実装。数値の暗黙変換は仕様として禁止する。後置`++`・`--`は可変数値に対応し、回復可能なエラー結果の送出は`raise`で行う。

## v0.0.2の判断と残る制約

raiseのpayload制限、Union射影の曖昧さ、コンパイラ固有API宣言、同期呼び出しに限定した借用検査の詳細は [現行仕様](language-spec-v0.0.2.md) を参照する。静的キャストとtrycastは新しい独立したReadonly値を生成する。Typeは通常の値の型ではなく、TSAnyも引き続きnative境界限定。精密な寿命解析やCopy-on-Writeは未実装。
