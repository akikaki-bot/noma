# Noma エディタサポートとLSP対応の調査

調査日: 2026-10-15。言語設計の基準は `language-spec-v0.0.2.md`。この文書は現在の実装と今後のエディタ実装方針を記録するもので、未決定の言語仕様を確定するものではありません。

## 現在の処理系

| 対象 | 状況 | 実装・制限 |
| --- | --- | --- |
| Lexer / Parser / AST | 実装済み | `src/lexer.ts`、`src/parser.ts`、`src/ast.ts`。文字列を直接解析できる。コメントはネスト可能、数値リテラルは整数、識別子はASCII、文字列は二重引用符とJSONエスケープ |
| モジュール解決 | 実装済み | `src/modules.ts` の `loadProgram`。ファイル取得・stdlibルートの注入、未保存ソース、循環・パストラバーサル・信頼境界の検証 |
| シンボル解決 | API基盤を実装 | Checkerの解決に基づく `checked.semantic`。宣言ID、参照、スコープ、可変性、絞り込みを保持。構造的フィールドの定義IDは未定義 |
| 型検査 | 実装済みの範囲あり | `src/checker.ts` と `src/types.ts`。明示型、構造型、明示的射影、trycast、Union、配列、型付きmatchと網羅性、raise/catch/otherwise。再帰型エイリアス等には制限あり |
| 可変性検査 | 実装済みの範囲あり | Deep Readonly、snapshot要求、署名によるmut引数とReadonly引数へのsnapshot要求、可変引数の不変性、別名競合・借用値の脱出の保守的な検査。言語全体の寿命・並行性規則を確定するものではない |
| Native / stdlib | 実装済みの範囲あり | 信頼された `std/internal` の `native fn`、`compilerOnly type TSAny = intrinsic`、型付きNative Registry。`std/io` は実験的APIとしてEOF・エラーを区別 |
| ソース位置・診断 | 一部実装 | Spanの互換性を維持し、Token/ASTにUTF-16半開範囲・識別子範囲を追加。解析APIは最初の診断を返す。複数診断・Parser回復は未実装 |
| LSPサーバー・クライアント | 0.2.0で接続 | 既存解析APIを共有する診断・補完・Hover・定義・参照。通信・文書管理は処理系とは別ディレクトリ |

v0.0.2ではraise/catch、構造的cast、std/typingの型指定引数、Array<T>表記、名前付き構造体値、int32の後置++に対応しました。一般ジェネリクスやcontinueは未実装です。以下の0.2.0以前の件数は当時の検証記録です。

## 第二段階のLSP接続（0.2.0）

`docs/lsp-api.md` のAPIにLSPの通信層を接続しました。処理系の言語ルールをLSP側へ移植せず、処理系と通信層のソースを分離しています。

| 場所 | 責務 |
| --- | --- |
| `src/` | Parser・Resolver・Checker・解析API。LSPライブラリに依存しない |
| `extensions/vscode-noma/src/server/index.ts` | 初期化、LSPハンドラ、文書同期、ファイル監視の通知 |
| `extensions/vscode-noma/src/server/service.ts` | 解析API呼び出し、100msのdebounce、文書バージョン管理、診断の合成、参照の集約 |
| `extensions/vscode-noma/src/client/extension.ts` | VS CodeでLSPプロセスを起動、文書・ファイル変更を通知 |

`AnalysisWorkspace` / `AnalysisSnapshot` を通して診断・Hover・補完・定義・参照を提供します。`main` を要求しないライブラリ解析を使い、`file:` と `untitled:` に対応します。変更後は旧snapshotを破棄し、複数のrootが報告する同じ診断を重複排除して文書別に通知します。依存ファイルをcloseした場合はディスクの本文へ戻ります。

Ctrl＋クリック / F12は `textDocument/definition`、Shift＋F12は `textDocument/references`、Hoverは `textDocument/hover`、補完は `textDocument/completion` で実装しています。参照検索は開いているrootとその依存モジュールのsnapshotを集約します。未読の全プロジェクトファイルを走査するインデックスはまだありません。

サーバーには解析専用の依存だけをバンドルし、Interpreter・Native Registryは含めません。stdlibもVSIXに同梱して明示的な `stdlibRoot` を渡すため、利用者のNoma処理系インストールやリポジトリの配置に依存しません。信頼境界は既存ローダーに委ね、LSP経由の編集でnative権限を与えません。

**現在の制限:** 診断は各解析の最初の1件です。意味情報は全体の型検査成功時だけ利用できます。未完成の `io.` 等での補完、構造体フィールドの定義・参照、プロジェクト全体の未読ファイルの参照検索は未実装です。仮想文書・Web拡張ホストのLSPは対象外です。workspace folderは独立したパッケージルートとして扱い、入れ子のfolderは外側のrootを共有します。

検証は `npm run extension:test`（TextMateとスニペット、LSP通信とバンドル境界）、`npm run extension:test:host`（実際のVS Codeプロバイダー）、`npm test`（処理系）で行います。VSIX生成は `npm run extension:package`。利用方法は拡張のREADMEを参照してください。

0.2.0の確認結果: 処理系99件、拡張31件（既存21件＋LSP等10件）、TypeScript検査、整形検査が成功しました。独立したVS Code 1.141.2のExtension Hostでも言語認識・定義・Hover・補完・参照・未保存編集の診断と修正後の復帰を確認しました。生成したVSIXの13ファイルを検査し、テスト用VS Codeやnode_modulesが混入していないことと、独立した拡張ディレクトリへの0.2.0のインストールを確認しています。

## 第一段階（0.1.0の記録）

`extensions/vscode-noma/` に独立した宣言型拡張を配置しました。言語IDは `noma`、TextMateのscopeは `source.noma` です。実行コードを含まないため、処理系のNodeバージョンやstdlib配置に依存せずにハイライト・編集補助が動きます。

`npm run extension:install` で開発依存を準備し、`npm run extension:package` でテスト後にVSIXを生成します。インストール方法とスニペット一覧は拡張の `README.md` に記載しています。`.vscode/launch.json` から開発用Extension Hostを起動できます。

テストではVS Codeと同じ `vscode-textmate` / `vscode-oniguruma` でscopeと複数行状態を確認し、全スニペットを適切な文脈に埋め込んで既存のParser・Type Checkerに通します。宣言的なハイライトは型の正当性を保証しません。

今回の検証では、拡張テスト21件・既存処理系テスト76件・既存の整形検査が成功しました。生成したVSIXの収録内容を確認し、開発依存や処理系が含まれていないことを検証しています。さらにVS Code CLIを使い、`dist/verification/` 内の独立した拡張ディレクトリ・ユーザーデータへインストールし、`noma-local.noma-language@0.1.0` として認識されることを確認しました。通常のVS Codeプロファイルにはインストールしていません。GUIでの見た目・キー入力の手動確認は開発用Extension Hostで行えます。

## 第二段階のAPI整備

処理系側に `analyzeFile` / `AnalysisWorkspace` / `AnalysisSnapshot` を追加しました。未保存文書と依存の解析、main検査の分離、UTF-16診断、URI/versionの管理、修正・close時の失効、古い非同期結果の破棄に対応します。成功したsnapshotからHover、スコープ内の名前・公開moduleメンバー補完、定義・参照を問い合わせられます。

利用方法・型・信頼境界・制限は [lsp-api.md](lsp-api.md) を参照してください。Parser回復と未完成構文の補完、複数診断は未実装です。LSP通信層は拡張0.2.0で接続しました。以下はAPI整備前の調査時点の設計方針として残します。

API整備後の検証では、処理系99件（追加23件）、既存拡張21件、TypeScriptビルド、整形検査が成功しました。

## 第二段階の再利用方針（調査時点の記録）

LSPのために別のNoma文法や型検査器を作らず、`parse` → モジュール解決 → `checkProgram` を共有します。将来のクライアントは `vscode-languageclient`、サーバーは `vscode-languageserver` を使い、解析中にInterpreterやNative Registryを実行しない構成を想定します。[公式LSPガイド](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)も参照。

### 1. 未保存文書と解析API

`loadProgram` にファイル読み取り・stdlibルートを注入できる入口を設け、開いている文書はURIとバージョンで保持したメモリ上の本文、その他はディスクから取得します。新規未保存ファイルには `realpath` が使えないため、URIとディスクの正規化・存在確認を分離する必要があります。信頼判定は文書内容やフォルダ名から推定せず、既存ローダーの境界検証を共有します。特にユーザー編集の文書を `std/internal` として昇格させてはいけません。

stdlibの配置は現在 `import.meta.url` と `/dist/` を前提にしているため、サーバーへバンドルする場合は明示的なstdlibルートと同梱方法が必要です。CLIの解決結果を維持する回帰テストを付けます。

`CheckedProgram.check()` は全体の最後に `main` を要求するため、ライブラリ編集の解析ではエントリポイント検査を明示的に分離します。CLIは従来どおり `main` を検証します。ライブラリ編集時にダミー関数をソースへ挿入する方式は位置・意味を変えるため避けます。

### 2. 構文・型・可変性診断

まず既存 `LanguageError` をLSP Diagnosticに変換し、構文、型、mut/snapshotのエラーを文書変更時に更新します。エラーは一件ずつでも既存の検査結果をそのまま用い、最初から全件を返せると主張しません。次にParserの同期点による回復と診断収集APIを追加します。

TokenとASTには識別子の開始・終了位置を追加します。現行Spanは式全体の始点や `pub` の位置を指す場合があり、定義名そのものの範囲には不足します。LSPの既定UTF-16位置と現在のJS文字列走査を合わせ、0始まりへの変換、CRLF、絵文字、EOFをテストします。古い文書バージョンの結果を破棄し、修正後・close時に古い診断を消し、依存モジュール変更も再解析します。

### 3. 補完・Hover

`CheckedProgram.functions`、`types`、`expressionTypes`、`calls` と `describe` は再利用できます。ただし現行 `Scope` は内部専用で解析後に局所束縛を列挙できません。束縛の型・可変性・宣言範囲・スコープを保持する解析結果を追加し、カーソル位置からアクセス可能な名前だけを返します。インポート先は `pub` を守り、一般コードの候補に `TSAny` や内部nativeを漏らさないことが必要です。

未完成の文書では解析できた範囲の情報を使い、失敗時に古い型を現在の文書のものとして表示しない方針です。スニペットとシンボル補完は別機能として扱います。

### 4. 定義ジャンプ・参照検索

現在の名前→型Mapだけでは識別子と定義の対応を復元できません。Resolver/Checkerが実際に解決した定義IDを識別子・型参照・メンバー参照へ記録し、定義URI/範囲と参照範囲のインデックスを構築します。名前の一致だけによる検索はシャドーイングや同名モジュールを誤るため採用しません。

スコープ、case/handler束縛、import alias、公開/非公開、複数ファイル、削除・改名の回帰テストを用意します。構造的なフィールドの「定義」の扱いなど未確定の意味論が必要な範囲は、別途言語設計上の判断として扱います。

### 完了条件

最初のLSP縦切りは、未保存の `.noma` に対する既存Parser/Checkerの診断が編集・修正・closeに追従し、CLIの判定と一致することです。その後、補完とHover、定義、参照を順に追加します。各段階で実装済みのcapabilityだけをサーバーが返し、JSON-RPC経由の統合テストとVS Code Extension Hostでの確認を行います。
