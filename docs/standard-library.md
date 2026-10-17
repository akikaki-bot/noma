# Noma 標準ライブラリAPI（実験版）

公開関数は `stdlib/std/*.noma` に実装する。通常引数はすべてReadonlyで、元の値を変更しない。可変値を渡す場合はスカラーも含めて `snapshot` が必要。型推論・暗黙の数値変換・関数オーバーロードは導入していない。

```noma
use "std/string" as str;
use "std/number" as num;
use "std/io" as io;

pub fn main() -> int32 {
	let mut text: string = "A😀B";
	let size: int32 = str.length(snapshot text);
	let emoji: string = str.slice(snapshot text, 1, 2) catch e { return 1; };
	let total: int32 = num.checkedAddInt32(10, 20) otherwise e { 0 };
	io.stdoutWrite(emoji + " " + num.int32ToString(size) + " " + num.int32ToString(total)) catch e { return 1; };
	return 0;
}
```

実行可能な例は [examples/stdlib.noma](../examples/stdlib.noma)。失敗値は既存のopaqueな `throwable` と `.message: string` を使い、`raise` / `catch` / `otherwise` で扱う。

## std/string

インデックスと長さの単位はUnicodeコードポイント。0始まりで、UTF-16コードユニットや書記素クラスタではない。`length("A😀B") == 3`、`slice("A😀B", 1, 2)` は `"😀"`。結合文字を分離するため、`length("e\u0301") == 2`。正規化・ロケール処理は行わない。

| 関数 | 戻り値 | 動作 |
| --- | --- | --- |
| `length(text: string)` | `int32` | コードポイント数 |
| `isEmpty(text: string)` | `bool` | 長さが0か |
| `contains(text: string, search: string)` | `bool` | 完全一致の部分文字列があるか |
| `startsWith(text: string, prefix: string)` | `bool` | 先頭の完全一致 |
| `endsWith(text: string, suffix: string)` | `bool` | 末尾の完全一致 |
| `indexOf(text: string, search: string)` | `int32` | 最初の一致のコードポイント位置。未発見は `-1` |
| `slice(text: string, start: int32, end: int32)` | `string \| throwable` | `[start, end)`。`0 <= start <= end <= length(text)` が必要 |
| `replace(text: string, search: string, replacement: string)` | `string` | 最初の一致を置換 |
| `replaceAll(text: string, search: string, replacement: string)` | `string` | 左から重ならない一致をすべて置換 |
| `trim(text: string)` | `string` | **ASCII限定**。両端のU+0009〜U+000DとU+0020だけを除去 |
| `toUpperCase(text: string)` | `string` | **ASCII限定**。a〜zをA〜Zへ。他のスカラー値は保存 |
| `toLowerCase(text: string)` | `string` | **ASCII限定**。A〜Zをa〜zへ。他のスカラー値は保存 |
| `repeat(text: string, count: int32)` | `string \| throwable` | 非負回数の繰り返し。負数・結果のコードポイント数がINT32_MAXを超える場合は失敗 |

`slice` は負の添字や逆転区間を許可せず、自動補正もしない。空文字列の `(0, 0)`、末尾の `(length, length)` は空文字列。`repeat(text, 0)` と、非負回数の `repeat("", count)` は空文字列。

`trim` はNBSP（U+00A0）や全角空白を保持する。大小文字変換は `é`、`É`、`ß`、トルコ語等を変換しない。Unicode全域の空白判定・ケースマッピングは未実装で、将来のUnicodeデータ表によるNoma実装の対象。現在のASCII処理をUnicode全域対応とは扱わない。

文字列操作の入力にはUnicodeスカラー値のみを認める。U+D800〜U+DFFFの単独サロゲートは無効。`slice` / `repeat` は不正な文字列を `throwable` にする。失敗を戻り値に持たないAPIは、不正な文字列に対して位置付きRuntime Errorで停止する。通常の文字列リテラル構文やI/Oの型そのものは変更していないため、ホスト・エスケープから不正な文字列が入った場合にもここで検査する。

### 未定義だった境界条件の仕様案と現在の実装

既存の言語仕様には以下の規則がない。今回の実験APIは次の案を実装・テストするが、言語仕様の確定事項には追加しない。

- 空検索の `contains` / `startsWith` / `endsWith` は `true`、`indexOf` は `0`。
- `replace(text, "", replacement)` は先頭に一度挿入する。
- `replaceAll(text, "", replacement)` は各コードポイント境界に挿入する。`replaceAll("😀", "", "-") == "-😀-"`、空入力でも一度挿入する。
- 置換文字列を文字通りに扱い、`$&` 等のホスト固有の置換記法は解釈しない。
- 重なる一致は再利用せず、生成した置換部分を再検索しない。`replaceAll("aaa", "aa", "x") == "xa"`。
- `parseInt32` の空白・符号・先頭ゼロの扱いは下記の厳密な10進形式とする。

## std/number

対象は `int32`（-2147483648〜2147483647）。文字列化・パースはNomaコードで実装し、Node.jsの数値パースや文字列変換に委譲しない。

| 関数 | 戻り値 | 動作 |
| --- | --- | --- |
| `absInt32(value: int32)` | `int32 \| throwable` | 絶対値。INT32_MINは失敗 |
| `minInt32(a: int32, b: int32)` | `int32` | 小さい値 |
| `maxInt32(a: int32, b: int32)` | `int32` | 大きい値 |
| `clampInt32(value: int32, min: int32, max: int32)` | `int32 \| throwable` | 閉区間へ制限。min > maxは失敗 |
| `int32ToString(value: int32)` | `string` | ASCIIの符号付き10進表記。正数に `+` は付けず、0は `"0"` |
| `parseInt32(text: string)` | `int32 \| throwable` | 厳密な10進パース。不正入力・範囲外は失敗 |
| `checkedAddInt32(a: int32, b: int32)` | `int32 \| throwable` | 加算。範囲外を失敗値にする |
| `checkedSubInt32(a: int32, b: int32)` | `int32 \| throwable` | 減算。範囲外を失敗値にする |
| `checkedMulInt32(a: int32, b: int32)` | `int32 \| throwable` | 乗算。範囲外を失敗値にする |

`parseInt32` の形式はASCIIの `[+-]?[0-9]+`。前後・途中の空白は一切許可しない。空文字列、符号のみ、小数点、指数、基数プレフィックス、区切り記号、非ASCII数字は拒否する。先頭ゼロと `+` を許可し、`-0` / `+0` は0。負側に蓄積してINT32_MINを安全に扱い、各桁の更新にchecked演算を使う。例: `"+0012"` は12、`" 12"` / `"2147483648"` は失敗。

整数リテラル・単項マイナス・算術演算・snapshotからなる定数式のオーバーフローは、BigIntで正確に検査してコンパイルエラーにする。これは定数式の検査であり、識別子や関数呼出しを評価する定数伝播は行わない。通常演算の実行時オーバーフロー（加減乗除、単項マイナス、`++`）は従来どおりRuntime Errorで停止する。0除算もRuntime Error。除算は0方向への切捨て、剰余は既存の規則に従い、int32の0がホストの `-0` として漏れないようにする。

checked演算は通常のNoma演算を先に実行せず、内部nativeでBigIntによる正確な計算と範囲検査を行う。失敗時はRuntime Errorで停止せず、既存の `throwable` を返す。定数の引数でも `checkedAddInt32(2147483647, 1)` は呼出しとしてコンパイルできる。除算のchecked APIは今回追加していない。

## std/ioとの接続

既存の `write` / `puts` / `writeError` / `putsError` / `readLine` / `EOF` に加え、指定された使用例の `stdoutWrite(text: string) -> void | throwable` を `write` と同じ動作のNomaラッパーとして公開する。

## ホスト実装と信頼境界

追加したホスト処理は以下の6関数。宣言はprivateな `native fn`、他モジュールへの公開は既存方式のNomaラッパー経由。TSAnyは使わない。

| 内部モジュール | native宣言 |
| --- | --- |
| `std/internal/string` | `codepointLength(string) -> int32` |
| 同上 | `codepointAt(string, int32) -> int32 \| throwable` |
| 同上 | `fromCodepoint(int32) -> string \| throwable` |
| `std/internal/number` | `checkedAdd(int32, int32) -> int32 \| throwable` |
| 同上 | `checkedSub(int32, int32) -> int32 \| throwable` |
| 同上 | `checkedMul(int32, int32) -> int32 \| throwable` |

`codepointAt` は負・末尾以降の添字と不正スカラー文字列で失敗する。`fromCodepoint` は0〜0x10FFFFのうちサロゲート範囲を除く値だけを受け付ける。`codepointLength` は戻り値にthrowableを持たないため、不正文字列でRuntime Errorとなる。公開の非失敗API内では、長さと範囲を検証した後にのみ内部取得・生成を使う。

`createIORegistry(host)` はこれらの登録も行い、CLI / `runFile` は変更なしで全モジュールを読み込める。I/Oを使わない埋込みでは、空の `NativeRegistry` に `registerCoreNatives(registry)` を呼べる。native署名の照合・入出力の型検証・Readonlyコピー・`std/internal` のimport制限は既存の共通機構を使う。

現在の実装はASTインタプリタ上の正しさを優先する。コードポイント位置へのアクセスは線形走査であり、検索・連結は大入力向けに最適化していない。既存の実行ステップ上限とホストのメモリ・文字列サイズ上限は引き続き適用され、メモリ不足をthrowableへ変換する保証はない。

## 検証

`npm test` はTypeScriptビルド、nativeのUnicodeスカラー検査・BigInt比較テスト、実際の [stdlib.noma](../test/fixtures/stdlib.noma) と例の実行、Readonly拒否、native ABI・非公開境界、定数式のコンパイルエラーと通常演算のRuntime Errorを検証する。
