# Noma v0.0.2 言語仕様

2026-10-16。現行のTypeScript / Node.js製処理系が実装する範囲と、今回の仕様変更の判断を記録する。旧版より本書を優先する。

2026-10-18追記: 配列・借用・所有権・非同期処理については [Read / Array / Future v0.1](read-array-future.md) を優先する。配列の `.length` と期待型のない配列リテラルを廃止し、read、std/arr、Lazy Futureを追加した。本書の関連箇所は拡張前の記録。

## 基本原則

Nomaは高水準・静的型付けの言語で、設計原則は **No Hidden Mutation**。変数・関数引数・戻り値には明示的な型注釈を要求し、宣言の型推論は行わない。式の型計算・matchによる絞り込みは型検査器が行う。

通常の値と関数引数はDeep Readonly。`let mut`と関数宣言の`mut`が変更権限を表す。権限は静的型の変更を許さない。構造体、配列、Union、型別名、`match`、alias必須の`use`、`pub`とデフォルト非公開を維持する。一般ジェネリクスやクラスは導入しない。

## エラー結果と制御フロー

```noma
fn divide(a: int32, b: int32) -> int32 | throwable {
	if (b == 0) {
		raise "Division by zero";
	}
	return a / b;
}

fn main() -> int32 {
	let result: int32 = divide(10, 0) otherwise e { 0 };
	return divide(result, 0) catch e { return -1; };
}
```

`raise expression`の型は`never`。現在の関数からエラー結果を返し、その関数の戻り値に`throwable`が必要。呼び出しをまたいで動的に例外を投げ続ける機能ではない。`raise`の引数は、既存のエラー表現に合わせて`string`または`throwable`（およびそのUnion）に限定する。文字列は`.message: string`を持つ不透明なエラー値にし、既存のthrowableはそのまま再送出する。任意の構造体や数値を暗黙にエラーへ変換しない。

`expression catch e { ... }`はthrowable側だけを捕捉する。ハンドラは正常終了せず`never`を保証する必要がある。`return`、許可された`raise`、ループ内の`break`で脱出できる。`void`を生成するだけでは脱出にならない。成功側ではハンドラを実行しない。

`expression otherwise e { ... }`はthrowable側で成功型と互換な代替値を生成するか、`return`等で脱出する。どちらのハンドラもthrowableを含まない式には使えない。ブロック末尾のセミコロンなしの式が値になる。`void`は正常完了して値がない型、`never`は正常な値が返らない経路の型であり、厳密に区別する。

旧`throw`による送出・後置ハンドラは受け付けない。`throwable`はコンパイラ内部のエラー結果型であり、`Throw<T>`等は実装しない。I/Oの`void | throwable`と互換。通常の`struct { message: ... }`でエラー値を偽造できない。

## mut引数

```noma
fn increase(value: int32) -> int32 { return value + 1; }
fn increaseInPlace(mut value: int32) -> void { value++; }

fn main() -> int32 {
	let a: int32 = 10;
	let mut b: int32 = 20;
	increase(a);
	increase(snapshot b);
	increaseInPlace(b);
	return snapshot b;
}
```

引数に必要な可変性は関数のシグネチャで決まる。呼び出し側の`f(mut x)`は構文エラー。通常引数に可変な変数・フィールド・配列要素を渡すにはsnapshotが必要。`mut`引数には型が同一の可変ストレージが必要で、不変値・snapshot・一時的な計算結果は渡せない。実際の変更は義務ではない。

| 実引数 | 通常引数 | mut引数 |
| --- | --- | --- |
| 不変変数 | 可 | 不可 |
| 可変変数 | 不可（snapshotが必要） | 可 |
| snapshotの結果 | 可 | 不可 |

可変引数は呼び出し元の変数・フィールド・配列要素を変更する。通常引数は内部まで変更不可。算術・比較・文字列連結は新しいReadonlyの計算結果を生成するので、可変値を使って計算できる。可変な値を構造体・配列・分岐・matchの別名に包んでもsnapshot要件を回避できない。

### 現在の借用範囲

借用は同期的な一回の関数呼び出しに限定する。同一ルート変数から複数のmut引数を作ることを拒否する。`f(array[0], array[1])`も、両引数がmutなら競合として拒否する。異なるフィールド・要素が非重複であることの証明は行わない。

mutに渡すルートを他の実引数式が参照する呼び出しも保守的に拒否する。ネストした関数での変更、同じルートのsnapshotを同時に作る場合も含む。先に別の変数へsnapshotを保存してから渡す。可変引数の添字式で借用対象を読む・変更することも拒否し、先に添字を計算させる。実引数の評価は左から右。

`let mut`の初期化・代入は集約値を独立してコピーし、隠れた可変エイリアスを作らない。不変束縛への可変由来の保持はスカラーでもsnapshotが必要。既存実装の保守的な規則として、集約型の通常引数を別の不変束縛へ保持したり返したりする場合もsnapshotを要求する。引数から得た借用を直接返すことはできない。

Union値の全体置換は可能だが、Unionのフィールドへの書き込みは型の相関を壊すため拒否する。matchの絞り込んだ名前はReadonly。一般的な寿命解析、脱出する参照、クロージャ、ソース言語の非同期処理・並行実行は未実装。これらの意味論は今回確定しない。

## snapshot

```noma
fn main() -> int32 {
	let mut original: Array<int32> = [10, 20];
	let copied: Array<int32> = snapshot original;
	original[0] = 999;
	return copied[0]; // 10
}
```

snapshotは元から独立したDeep Readonlyの値を取得する演算子。ネストした構造体や配列にも変更が伝播しない。

- `snapshot array[0]`: 選択した要素のsnapshot。
- `(snapshot array)[0]`: 配列全体のsnapshotを取得してから要素を選択。

意味論の入口はランタイムの`values.snapshot`。現在は再帰コピーとfreezeで実装し、将来のCopy-on-Write等に置き換えても観測される独立性を維持する。snapshotを`let mut`の初期値にすると、さらに独立した可変値を作る。

## 構造的型付けと明示的射影

```noma
type Animal = struct { name: string; };
type Dog = struct { name: string; breed: string; };

fn main() -> void {
	let dog: Dog = Dog { name: "Pochi", breed: "Shiba" };
	let animal: Animal = (Animal)dog;
	let mut editable: Dog = dog;
	let saved: Animal = (Animal)(snapshot editable);
}
```

同じフィールド名・型を持つ構造は、型名・フィールド宣言順序によらず同じ型。異なる構造の間で暗黙の幅の部分型変換を行わない。変数初期化・代入・関数引数・戻り値・配列要素などで適用する。Unionへの通常の値の包含は引き続き可能。構造体のフィールド型や配列の要素型を暗黙に拡大することはしない。

新しく構築する構造体・配列リテラルには明示された期待型を適用する。例えば`struct { n: int32 | string; }`のフィールドへint32の値を入れられる。既存の別構造の値を暗黙に変換する機能ではない。matchの型ケースは従来どおり構造的な包含を検査するだけで、値を射影せず、実際に選択した元の型へ絞り込む。

`(Type)value`は静的に安全性が証明できる構造的射影。必要なフィールドが存在し、型が適合することを再帰的に確認する。対象のフィールドだけを持つ新しい独立したReadonly値を作り、元の値を変更しない。mutable由来の入力には明示的snapshotが必要。

プリミティブは同じ型のままコピー可能。文字列から数値への変換、存在しないフィールドの追加、実行時の確認なしのUnionからの絞り込みは許可しない。構造体フィールドや配列要素についても安全性を再帰的に検査する。

Unionからの静的射影は全候補について安全な場合のみ許可。射影先Unionで複数の候補が適合する場合、他の適合候補すべてへ射影できる最も具体的な候補を選ぶ。候補が比較不能で一意な値表現を決められない場合は拒否する。この保守的な実装判断はUnionの宣言順序でフィールドが失われることを防ぐためのもの。

## std/typingとType

```noma
use "std/typing" as typing;

type Animal = struct { name: string; };
type Dog = struct { name: string; breed: string; };

fn main() -> void {
	let mut dog: Dog = Dog { name: "Pochi", breed: "Shiba" };
	let animal: Animal = typing.trycast(Animal, snapshot dog) catch e { return; };
	let n: int32 = typing.trycast(int32, "123") otherwise e { 0 }; // 0
}
```

`typing.trycast(TargetType, value)`の第一引数はコンパイル時の型指定で、通常の式ではない。組込み型、ローカル・公開import型、配列、構造体、Unionの型構文を受け付ける。第二引数はReadonlyを要求し、可変値にはsnapshotが必要。戻り値は対象型Tに対して`T | throwable`。

実行時に適合性を検査し、成功時は対象型の新しい独立した値へ再帰的に射影する。適合しない場合や曖昧なUnion射影はthrowableを返す。数値変換や文字列のパースは行わない。静的な入力型がUnionでも、その時の実際の値に適合すれば成功する。削除したフィールドを元の値から復元することはできない。

標準ライブラリには次のコンパイラ固有API宣言を置く。

```noma
compilerOnly type Type = intrinsic;
pub fn trycast(target: Type, value: intrinsic) -> intrinsic;
```

ここで`intrinsic`は依存する入力・戻り値契約をコンパイラが差し替える印。通常の値の型や万能型ではない。本文を省略したこの宣言は信頼された`std/typing`の正確な署名に限り許可し、通常の関数には必ず本文が必要。特権はモジュールローダーが与え、同名のユーザーファイル・関数には与えない。実装はchecker・interpreter・values内部に置き、一般ジェネリクスや実行時型オブジェクトは追加しない。

`Type`はすべての型を指定できるコンパイル時専用のメタ型であり、すべての値を受け入れる型ではない。通常の変数、引数、戻り値、構造体のフィールド、配列・Union・別名への組み込み、キャスト対象、実行時の値としての使用を拒否する。

`TSAny`は従来どおり信頼された`std/internal`のprivate native関数の直接の入力型だけに限定する。公開API・通常変数・通常関数・戻り値・型別名に使えず、trycastにも指定できない。

## 既存機能との整合

`T[]`を維持し、今回の指定にある`Array<T>`も同じ配列型の表記として受け付ける。これは一般ジェネリクスの導入ではない。`Name { ... }`によるローカル・公開import構造体型の値構築を受け付け、従来の`struct { ... }`も維持する。名前付き構築は全フィールドとその型を検査する。後置`value++`・`value--`は可変数値ストレージに対応し、更新前の値を返す。8種類の整数とfloat32/64、オーバーフロー、正確な数値キャストは追加の[数値型仕様](numeric-types.md)に従う。

`std/io`の公開署名とNative Registry契約は維持する。標準ライブラリのI/Oラッパーは引き続きNomaで実装する。`use "package/path" as alias;`と`pub`の規則、matchの網羅性検査と重なる構造型への保守的制限、UTF-8位置付き診断、CLIの`--check`を維持する。

## 未実装・未確定

一般ジェネリクス、クラス、Throw<T>、実行時Typeオブジェクト、Copy-on-Write、精密な所有権・寿命解析、非重複のフィールド借用の証明、脱出する参照、クロージャ、一般的なリテラル・ネストしたパターン、再帰型、VM・コード生成・セルフホスティングは未実装。ループが必ず発散することの証明も行わない。セルフホスティングは長期目標。

## 移行対象

| ファイル | 変更 |
| --- | --- |
| `src/ast.ts`, `src/lexer.ts`, `src/parser.ts` | raise/catch、cast、型指定引数、後置++、配列表記と名前付き構築 |
| `src/types.ts`, `src/checker.ts` | 構造同一性、静的射影の証明、never、署名による可変性、借用競合、compile-time Type |
| `src/values.ts`, `src/interpreter.ts` | 独立したsnapshot・射影、実行時適合性検査、エラー結果の送出 |
| `stdlib/std/typing.noma` | 公開するコンパイラ固有API |
| `examples/`, `test/` | 新構文への移行、正常・異常系の追加 |
| `extensions/vscode-noma/` | キーワード・cast・型指定引数のハイライト、スニペット、LSP検証 |
| README・実装状況 | 現行仕様と残る制約 |

既存のモジュールローダー、Native Bridge、CLI、解析・LSP基盤を再利用し、処理系を作り直してはいない。

## 検証結果（2026-10-16）

- `npm test`: 177件成功、失敗0件（変更前99件から78件追加）。
- `npm run extension:test`: 34件成功、失敗0件。ハイライト、スニペット、LSP通信とtyping APIを含む。
- `npm run extension:test:host`: 実際のVS Codeで起動・定義・Hover・補完・参照と、未保存編集の診断・復帰の両チェックが成功。
- `npm run typecheck` / `npm run format:check`: 成功。

初回の処理系・拡張テストでは、Windowsサンドボックスの一時ファイルrename権限により既存テストが各1件失敗した。通常の権限環境で再実行し、最終版ではすべて成功した。
