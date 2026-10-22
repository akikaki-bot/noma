# Noma Language for VS Code

Noma の `.noma` ファイル向けのエディタサポートです。VS Code 1.91 以降のNode拡張ホストに対応します。

## 第一段階で利用できる機能

- `.noma` の言語認識（言語ID: `noma`）。
- TextMate Grammar によるキーワード、型注釈・型宣言、関数宣言・呼び出し、変数、文字列、整数、真偽値、コメントのハイライト。
- `fn`、`pub`、`mut`、`read`、`snapshot`、`async`、`await`、`match`、`catch`、`otherwise`、`native`、`compilerOnly`、`intrinsic` など、現在のParserで使用するキーワード。組込み型 `Future<T>` の着色・補完にも対応する。
- ネストした `/* ... */` コメント、`//` コメント、JSON形式の文字列エスケープ。
- `{}`、`[]`、`()`、二重引用符の自動補完と選択範囲の囲み、括弧に応じたインデント、コメント切り替え。
- 明示的な型注釈を含む21種類のコードスニペット。

色は利用するテーマに依存します。型名は宣言や型注釈の文脈で識別します。TextMateのみでは名前解決を行いません。

## LSPで利用できる機能（0.3.0）

- 未保存文書の構文・静的型、readの借用競合・脱出、Futureの消費・Snapshot・可変化、期待型のない配列の診断。
- キーワード、関数・変数・引数・型・モジュール名、公開moduleメンバー、構造体フィールドの補完。ジェネリックフィールドは具体化した型を表示。
- 関数の引数ヒント。型引数を明示したジェネリック呼び出しは具体化した署名を表示。
- Hoverによる型・関数署名の表示。
- Ctrl＋クリック / F12による定義ジャンプ。
- Shift＋F12による参照検索。開いている解析対象とその依存モジュールの結果を集約します。
- 文書変更・close・ディスク上の作成／変更／削除／改名に応じた再解析、古い診断と意味情報の破棄。

既存の `AnalysisWorkspace` / `AnalysisSnapshot` を利用し、言語コードを実行せずに解析します。LSPの通信と文書管理は `src/server/`、VS Codeクライアントは `src/client/`、言語処理系はリポジトリルートの `src/` に分離しています。

**現在の解析APIの制限:** 診断は解析対象ごとに最初の1件です。Hover・定義・参照は、依存を含む型検査に成功した文書で利用できます。補完と引数ヒントは `io.`、`box.`、`identity<`、`identity<string>(` など未完成コードでも現在の文書から回復した情報を使い、以前の型情報は流用しません。構造体フィールドの定義・参照と、未読のプロジェクト全体を走査する参照検索は未対応です。

`file:` と `untitled:` に対応します。ワークスペース外のファイルはその親フォルダ、untitledはワークスペースのルートをimportの基準にします。入れ子のworkspace folderは外側のルートを共有します。仮想文書では基本の着色・スニペットが対象です。Web拡張ホストでの動作は対象外です。

## インストール

VS Code のコマンドパレットで **Extensions: Install from VSIX...** を実行し、生成した `noma-language-0.3.0.vsix` を選びます。CLIでもインストールできます（リポジトリルートから実行）。

```sh
code --install-extension extensions/vscode-noma/dist/noma-language-0.3.0.vsix
```

`.noma` を開き、右下の言語表示が Noma になることを確認してください。

## 開発・検証・パッケージ生成

Node.js 22.18 以降とnpmが必要です。リポジトリルートで実行します。

```sh
npm ci
npm run extension:install
npm run extension:test
npm run extension:package
```

`extension:package` はテストを実行してから、`extensions/vscode-noma/dist/noma-language-0.3.0.vsix` を生成します。バージョン変更時はファイル名も自動で変わります。VSIXにはクライアント・サーバーのバンドル、解析に必要なstdlib、依存ライセンス表記を含めます。`node_modules`、開発用テスト、Interpreter・Native Registryは同梱しません。利用者によるnpm installやNoma処理系の別途インストールは不要です。

通信テストは `extension:test` に含まれます。実際のVS Codeでの検証は `npm run extension:test:host` で実行します。通常のユーザープロファイルから独立したデータと拡張ディレクトリを使用します。Windowsでは既存のVS Codeを検出し、他環境ではテスト用VS Codeを取得します。`VSCODE_EXECUTABLE_PATH` で実行ファイルを指定でき、`NOMA_TEST_DOWNLOAD_VSCODE=1` で既存インストールの検出を省略し、`VSCODE_TEST_VERSION` でテストするバージョンを指定できます。

`publisher: noma-local` はローカルVSIX用の識別子です。Marketplaceの公開者登録や公開は行っていません。リポジトリで配布ライセンスが未設定のため `UNLICENSED` とし、パッケージング時にライセンスファイルの要求だけを省略しています。

リポジトリをVS Codeで開いて **Noma: Extension Development Host** を選び、F5でビルド後に開発用ウィンドウを起動できます。`examples/hello.noma` が開きます。文法確認には **Developer: Inspect Editor Tokens and Scopes**、解析のログには出力パネルの **Noma Language Server** を利用できます。

## スニペット

`.noma` で次のprefixを入力して候補を選ぶか、**Snippets: Insert Snippet** を使用してください。Tabでプレースホルダーを移動できます。

| Prefix | 内容 |
| --- | --- |
| `main`, `asyncmain` | 同期／非同期のエントリ関数 |
| `asyncfn` | 宣言上の戻り値Tを指定し、呼び出し時にFuture<T>を作る関数 |
| `read` | 同期Readonly呼び出し引数への一時借用（変数保存には使用不可） |
| `array` | 明示型付きの配列リテラル |
| `arrlen` | コピーなしのarr.length<T>(read values) |
| `future`, `await` | Lazy Futureの保存／async内での一度だけの消費 |
| `fn`, `pubfn` | 型注釈付きの関数・公開関数 |
| `let`, `letmut` | 不変・可変束縛 |
| `snapshot` | 独立した不変値の保存 |
| `use` | 必須の `as` を含むモジュール読み込み |
| `type` | `type Name = struct { ... };` |
| `if`, `while` | 条件分岐・ループ |
| `match` | 型付きcaseによる式 |
| `catch` | 脱出する後置エラーハンドラ |
| `raise` | throwableを含む関数からエラーを送出 |
| `otherwise` | 代替値を返す後置エラーハンドラ |

`arrlen` は `use "std/arr" as arr;` が必要です。`read` は同期関数のReadonly引数に直接挿入し、`await` はasync関数内で使用してください。

`catch` / `otherwise` は `T | throwable` を返す式の直後に挿入します。`catch` の `return` 値は関数の戻り値型に合わせ、`otherwise` の末尾式は成功側の型に合わせてください。`match` のcaseは対象Unionを網羅するよう調整してください。

現在の処理系では配列型を `int32[]`、構造体リテラルを `struct { value: 1 }` と書きます。`Array<T>` と `Name { ... }` にも対応します。Generics v0.1では `Box<T>` の宣言と `Box<int32> { value: 1 }`、`identity<int32>(1)` のような完全明示の型引数を使います。`native` / `compilerOnly` / `TSAny` の着色は、一般コードにその使用権限を与えるものではありません。

仕様と実装状況は、リポジトリの `docs/language-spec-v0.0.1.md`、`docs/lsp-api.md`、`docs/editor-support.md` を参照してください。

実装時の参照: [Syntax Highlight Guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)、[Language Configuration Guide](https://code.visualstudio.com/api/language-extensions/language-configuration-guide)、[Snippet Guide](https://code.visualstudio.com/api/language-extensions/snippet-guide)、[Packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。

### 言語v0.0.2

raise/catch/otherwise、構造的cast、typing.trycastの型指定引数をハイライトします。mutは関数宣言側のみで指定し、通常引数への可変値はreadまたはsnapshotが必要です。Futureの二重消費と借用競合を診断し、asyncの呼び出しヒントにFutureの型を表示します。配列の `.length` は補完せず、`std/arr`の `length<T>()` を使います。raiseとcatchのスニペットを提供します。診断・Hover・型参照は共有するParser/Checkerから得ます。
