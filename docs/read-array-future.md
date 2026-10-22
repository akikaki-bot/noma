# Read Borrowing・Array・Lazy Future v0.1

2026-10-18。既存のGenerics・Union・構造的型付け・`mut`・`snapshot`・`raise` / `catch` / `otherwise`を維持する拡張。配列の `.length` と、期待型のない配列リテラルを廃止する破壊的変更を含む。

## 既存実装の調査

`Array<T>` / `T[]`、配列リテラル、添字、要素への代入、再帰的なSnapshotは既存実装を拡張した。新しい通常のIntrinsic型宣言は公開していない。`read`、可変長配列API、ソース言語のFuture / async / await、消費状態検査は未実装だった。TypeScript製InterpreterとNative I/Oは既に非同期だったため、その待機機構をExecutorにも使用する。

## 一時的な `read`

```noma
use "std/arr" as arr;
fn inspect(a: int32, b: int32) -> void {}
pub fn main() -> int32 {
    let mut values: Array<int32> = [10, 20];
    inspect(read values[0], read values[1]);
    let size: int32 = arr.length<int32>(read values);
    values[0] = 30;
    return size;
}
```

`read expression` は同期関数のReadonly実引数に直接書く。変数、構造体フィールド、配列要素が対象。値をコピーせず、呼び出しの終了までReadonlyとして渡す。引数は左から右へ評価する。複数の読み取り借用は許可する。同じ根の変数に対する可変借用・直接代入・`++`・要素の削除などは、ネストした引数式でも拒否する。借用が有効な間の `await` も拒否する。

借用そのものの変数への保存・返却・コンテナへの格納・Futureへの捕捉は禁止する。借用元のフィールドや要素が異なっても同じ根なら競合として扱う。精密なフィールド分割や長寿命の参照は扱わない。

Readonly集約引数を引数や戻り値に保持する既存のSnapshot要求を維持する。抽象的な `T` は集約値を隠せるため、`read` でジェネリック引数へ渡す場合には、呼び出し先の本体と転送先も調べる。保持や暗黙コピーの可能性を除外できない呼び出し、再帰する借用の証明、一般のNative Bridgeへの集約値の借用は保守的に拒否する。明示的なSnapshotによる独立値の取得は可能。

`snapshot` は引き続き対象の内部を再帰コピーし、元から独立させる。Readonly引数の受け渡しではコピー・freezeをせず、Readonly権限を静的に検査する。新しい所有値をReadonlyにするときはその値をfreezeし、`let mut`や代入で既存値から可変ストレージを作るときは独立コピーする。

## `Array<T>` と `std/arr`

`Array<T>` はimport不要の組込み型。従来の `T[]` も同じ型として使える。配列はOpaqueで、内部ストレージ・要素数・容量のフィールドは公開しない。配列の `.length` は読み取りも書き込みも禁止。通常の構造体の `length` フィールドはそのまま使用できる。

配列リテラルは明示された静的な期待型が必須。変数・引数・戻り値・ブロック末尾・if / matchの枝・ネストした配列や構造体フィールドへ期待型を伝える。Unionに配列の候補が一つなら利用できるが、複数なら要素から選ばず拒否する。`[1, 2];` や `[1][0]` は型を独立推論しないため拒否する。

```noma
use "std/arr" as arr;
let mut values: Array<int32> = [];
arr.push<int32>(values, 10);
let count: int32 = arr.length<int32>(read values);
let saved: int32 = arr.get<int32>(read values, 0) otherwise e { -1 };
```

| API | 戻り値 | 動作 |
| --- | --- | --- |
| `create<T>()` | `Array<T>` | 空配列 |
| `length<T>(array: Array<T>)` | `int32` | コピーせず要素数を取得 |
| `get<T>(array: Array<T>, index: int32)` | `T \| throwable` | 要素の独立したDeep Readonly Snapshot |
| `set<T>(mut array: Array<T>, index: int32, value: T)` | `void \| throwable` | 既存要素を置換。不正な添字なら変更しない |
| `push<T>(mut array: Array<T>, value: T)` | `void` | 末尾へ追加 |
| `pop<T>(mut array: Array<T>)` | `T \| throwable` | 末尾要素を削除し、所有値として移動 |
| `remove<T>(mut array: Array<T>, index: int32)` | `T \| throwable` | 指定要素を削除し、後続要素を詰めて移動 |

`set` / `push` は格納値から独立した可変ストレージを作り、元の値へ変更を伝播させない。`pop` / `remove` は要素をSnapshotせず、旧配列からその要素への参照を除去する。空配列や不正な添字では `throwable` を返し、配列を変更しない。

添字は0始まり。`array[index]` はコピーを作らず、負数・範囲外なら位置付きRuntime Errorで停止する。`read array[index]` は借用、`snapshot array[index]` は対象要素の独立コピー。安全な取得には `get` を使う。

公開ラッパーは `stdlib/std/arr.noma` と `stdlib/std/internal/arr.noma` のNomaコードに記述した。ホスト操作は内部モジュールのprivateな `native fn createArray<T>` / `lengthArray<T>` / `getArray<T>` / `setArray<T>` / `pushArray<T>` / `popArray<T>` / `removeArray<T>` として宣言し、NativeRegistryで登録・実行する。

従来のNative Bridgeは引数のコピーを前提にし、ジェネリック・mut引数を禁止していた。配列に限って専用の借用ABIを設け、宣言元、型パラメータ数、非公開状態、引数型・mut、戻り値型を静的検査とRegistryのリンク検査で照合する。呼び出し時も具体型とreadonly／mutセルのモードを検証する。無制限のgeneric nativeやmut nativeは公開せず、通常nativeのコピー規則も維持する。実行コードと純粋なABI定義を分離し、LSPにランタイムを読み込ませない。

メモリ不足を回復可能なエラーとして保証する機構は既存処理系にもない。`create` / `push` は指定された戻り値型を維持し、ホストから捕捉できる確保失敗は位置付きRuntime Errorにする。ホスト自体の致命的なメモリ不足からの回復は保証しない。

## Lazy `Future<T>`

```noma
async fn calculate() -> int32 { return 42; }
pub async fn main() -> int32 {
    let pending: Future<int32> = calculate();
    let owned: Future<int32> = pending;
    return await owned;
}
```

宣言の戻り値 `T` と、呼び出し結果 `Future<T>` を区別する。引数式は生成時に通常どおり評価するが、関数本体とその処理を駆動するPromiseはawaitまで開始しない。未使用のFutureは実行されない。

`await` はasync関数内でFutureの所有権を消費し、単一タスクを開始する。内部のPromise待機で中断し、完了時に再開する。ビジーウェイトはしない。正常な結果や `T | throwable` をそのまま返し、`catch` / `otherwise` はawait後の結果に適用する。ホストの拒否は既存Native Bridgeのエラー規則を通し、回復可能な結果型では `throwable`、それ以外では位置付きRuntime Errorにする。

`async main()` はCLI / `runFile` が最後まで駆動し、int32の戻り値を終了コードへ渡す。同期mainの動作と `--check` の実行抑止を維持する。

### 所有権と現段階の制限

- FutureのSnapshot・キャストによる複製・可変束縛・可変引数を拒否する。コンテナ内部も再帰的に検査する。
- 通常の束縛、引数、戻り値でFutureを渡す操作はMove。移動元や消費済みの値の再使用を拒否する。一般的なMove構文は追加していない。
- 非消費を証明できる同期関数には `read future` で一時的に渡せる。複数借用も可能。借用が有効な間に同じFutureを移動したり消費したりする操作は拒否する。
- 分岐の続行経路を合成し、どれかの経路で消費されていればその後の使用を拒否する。returnで終了する経路は続行経路と区別する。short circuit、match、handlerも検査する。
- ループ外で作ったFutureのループ内での消費は保守的に拒否する。ループ内で毎回作るFutureは使用できる。break経由の消費も検査する。
- async関数の `mut` 引数、`read` の捕捉、借用中の集約引数の捕捉を拒否する。独立したSnapshotや所有値を渡す。
- 型制約がないため、Futureを含む型を一般の関数の型引数へ渡すことを拒否する。`snapshot T`、`get<T>`や型引数の転送を通じた複製を防ぐ。信頼済みの `arr.length` だけは非複製型の配列を `read` で参照できる。`Future<T>`を引数型に明記した関数は通常の消費検査を受ける。
- Futureを含む構造体・配列はReadonlyのまま構築し、全体を移動できる。現在はフィールド・要素の部分Moveと、Futureを含む可変コンテナを拒否する。そのためFuture要素のpush / pop / removeも未対応。
- 複製する従来のNative BridgeにFutureを渡すことも禁止。非同期のホスト処理は既存I/Oのawait機構を利用する。

spawn、並列スケジューリング、join、キャンセル、Stream、HTTP、長寿命Borrow、型制約・推論は導入していない。

## 検証と変更箇所

`test/fixtures/read-borrowing.noma`、`arrays.noma`、`futures.noma` に正常系の統合テストを置き、借用競合・二重await・分岐・ループの拒否例も実ファイルで検証する。`test/borrowing-arrays-futures.test.ts` はその他の失敗系、添字Runtime Error、Snapshotの独立性、Moveの参照同一性、Lazy副作用の順序、非同期I/Oの中断・再開、CLIの終了コード、解析APIを検証する。既存の配列テストを新仕様へ移行した。

LSPのJSON-RPCテストは消費エラー、修正後の診断消去、FutureのHover、async呼び出しの戻り値ヒント、read / async / await / Futureの補完、配列lengthの補完除去を検証する。TextMateの着色もテストする。

以下は変更した全ファイル（リポジトリルートからの相対パス）。作業前からのREADMEの編集も保持した。

| 範囲 | 変更ファイル |
| --- | --- |
| 構文・型・静的検査 | `src/ast.ts`、`src/parser.ts`、`src/types.ts`、`src/checker.ts`、`src/safety.ts` |
| 配列の信頼境界と実行 | `src/array-abi.ts`、`src/array-runtime.ts`、`stdlib/std/arr.noma`、`stdlib/std/internal/arr.noma` |
| Future・実行時の所有値 | `src/values.ts`、`src/interpreter.ts`、`src/native.ts` |
| 補完と着色 | `src/assistance.ts`、`extensions/vscode-noma/syntaxes/noma.tmLanguage.json` |
| 処理系テスト | `test/borrowing-arrays-futures.test.ts`、`test/array-native.test.ts`、`test/assistance.test.ts`、`test/language.test.ts`、`test/safety.test.ts`、`test/v002.test.ts` |
| 実ファイル統合テスト | `test/fixtures/read-borrowing.noma`、`test/fixtures/arrays.noma`、`test/fixtures/futures.noma`、`test/fixtures/borrow-conflict.noma`、`test/fixtures/future-double-await.noma`、`test/fixtures/future-branch-consumption.noma`、`test/fixtures/future-loop-consumption.noma` |
| 拡張・LSP・スニペット | `extensions/vscode-noma/package.json`、`extensions/vscode-noma/package-lock.json`、`extensions/vscode-noma/src/server/index.ts`、`extensions/vscode-noma/snippets/noma.json` |
| 拡張のテスト | `extensions/vscode-noma/test/editor.test.mjs`、`extensions/vscode-noma/test/lsp.test.mjs`、`extensions/vscode-noma/test/host/index.ts` |
| 使用例 | `examples/arrays-futures.noma` |
| 文書 | `README.md`、`docs/README.md`、`docs/read-array-future.md`、`docs/implementation-status.md`、`docs/language-spec-v0.0.2.md`、`docs/generics-v0.1.md`、`docs/standard-library.md`、`docs/lsp-api.md`、`docs/editor-support.md`、`docs/handoff.md`、`extensions/vscode-noma/README.md`、`extensions/vscode-noma/CHANGELOG.md` |

| 実行した検証 | 結果 |
| --- | --- |
| 変更前の `npm test` | 252件成功 |
| 最終の `npm test` | TypeScriptビルド成功、344件成功（92件追加）、失敗・skipなし |
| `npm run extension:test` | 処理系・拡張ビルド成功、49件成功、失敗・skipなし。解析専用バンドルに実行ランタイムを含めない検査も成功 |
| VS Code Extension Host | 成功。実エディタでread補完・FutureのHover・asyncの引数ヒント・消費／length診断の修正・未保存ファイルとスニペット展開を確認 |
| `npm run extension:package` | 0.3.0のVSIX生成成功。20ファイル・21スニペット・7つのprivate array nativeを検査し、実行ランタイムやテストファイルの混入なし |
| VS Codeインストール | インストール済みの0.2.0を0.3.0に更新し、CLIの拡張一覧で確認。既存ウィンドウは再読み込みで反映 |
| `npm run format:check` | 成功 |
| `git diff --check` | 成功 |
| `node dist/src/cli.js examples/arrays-futures.noma` | 終了コード0。生成時の出力、Future本体、Snapshot結果の順に出力 |

LSPは実プロセスへのJSON-RPC通信、着色はTextMate、VS Codeへの接続は独立したプロファイルのExtension Hostで検証した。拡張0.3.0はasync／read／Array／Futureの7スニペットを追加し、合計21種類を提供する。ここに書かれた対応範囲より広い意味で、完全な所有権・寿命解析や並行Executorが完成したとは扱わない。コミット・pushは行っていない。
