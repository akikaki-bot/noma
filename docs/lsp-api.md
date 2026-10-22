# LSP向け処理系API

2026-10-16更新。`editor-support.md`の第二段階に向けた、通信層に依存しないAPI。既存のLexer / Parser / Checkerを共有し、解析経路でInterpreter・Native Registry・NomaのI/Oを実行しない。通信層は `extensions/vscode-noma/src/server/` に分離し、JSON-RPCテストを提供する。

ビルド後はESMの `noma/compiler`、`noma/analysis`、`noma/workspace`、`noma/source` から利用できる。処理系とサーバーを一緒にバンドルする場合も、解析専用の入口を使い、`stdlibRoot`を明示する。`noma`本体からも再公開するが、本体には実行器のAPIも含む。

## 入口と返り値

| API | 用途 |
| --- | --- |
| `compile(file, loadOptions?)` | 実行用の静的検査。従来どおりmain必須 |
| `loadProgram(file, loadOptions?)` | メモリ上の本文とディスクのモジュール解決 |
| `checkProgram(program, { requireEntryPoint? })` | 既定はmain必須。falseでライブラリ検査 |
| `checked.checkEntryPoint()` | mainの検査を別途実行 |
| `analyzeFile(file, analysisOptions?)` | 既定はライブラリ解析。最初の診断と有効な解析結果を返す |
| `AnalysisWorkspace` | URI・バージョン・本文を保持し、変更とcloseで結果を失効させる |
| `AnalysisSnapshot` | 特定バージョンの診断・Hover・補完・定義・参照 |
| `SourceText` | UTF-16 offsetと0始まりPositionの変換 |

`analyzeFile`は `status: "success" | "error"`、`diagnostics`、読み取った `sources` を返す。ロード完了時は `program` も返す。**全体の検査に成功したときだけ `checked` を返す**。構文エラー・型エラーの文書に以前の型を流用しない。通常のファイル不存在・権限エラーは診断にするが、処理系内部やホストコールバックの予期しない例外はそのまま送出する。

診断は `{ uri, range, message, severity: 1, source: "noma", code }`。codeはsyntax / resolve / type / io。これはLSPで使いやすいデータ形状だが、このAPIが診断の送信を行うわけではない。

```ts
import { analyzeFile } from "noma/analysis";

const result = await analyzeFile("/project/library.noma", {
	projectRoot: "/project",
	stdlibRoot: "/server/bundled/stdlib",
	sources: new Map([
		["/project/library.noma", unsavedText],
		["/project/helper.noma", unsavedHelperText],
	]),
});

// result.diagnosticsを文書別にまとめてLSP側から通知する。
// result.checkedは成功時のみ存在する。
```

## ソース取得・信頼境界

`LoadProgramOptions`は `sources?: ReadonlyMap<absoluteFilePath, text>`、`fileSystem?: { readFile, realpath }`、`projectRoot?`、`stdlibRoot?`、`onSource?` を持つ。`AnalysisOptions`はさらに `requireEntryPoint?` を受け付ける。省略時は実ファイルと同梱stdlibを使う。

sourcesを優先するため、未保存の新規ファイル・依存ファイルにも対応する。未作成パスは、存在する祖先をrealpathで解決してから正規化し、symlink経由でもパッケージ外へ出られないようにする。URIとファイルパスの変換はWorkspace層で行い、ローダーはファイルパスを扱う。

fileSystemとstdlibRootは**処理系を組み込むホストの設定**であり、Noma文書から指定する権限ではない。stdlibとしてロードするファイルの本文をeditor overlayで置き換えることは禁止する。stdlibのファイルを編集対象のentryとして解析するときも一般コードとして扱い、native / compilerOnly権限を与えない。標準ライブラリ自身を特権付きでライブ編集するモードは提供しない。

`onSource`は解析前の本文を通知するホスト用コールバック。解析はソースの型規則を検査するが、Registryの実行時ABIリンクやホスト関数の実在確認は行わない。

## 文書のライフサイクル

```ts
import { AnalysisWorkspace } from "noma/workspace";

const workspace = new AnalysisWorkspace({
	projectRoot: projectPath,
	stdlibRoot: bundledStdlibPath,
});

// didOpen / didChange: 同じURIのversionは必ず増やす。
const change = workspace.updateDocument({ uri, version, text });
// change.clearDiagnosticsUrisに空診断を送り、reanalyzeUrisを解析し直す。
const snapshot = await workspace.analyze(uri);
if (snapshot) {
	// undefinedなら途中で文書・依存・close等が変わり、結果は破棄済み。
	// snapshot.versionとsnapshot.diagnosticsを通知に使用する。
}

// didClose: overlayを外す。依存モジュールなら次回はディスクへ戻る。
const closed = workspace.closeDocument(uri);
// closed.clearDiagnosticsUrisに空診断を送り、closed.reanalyzeUrisを再解析。

// ファイル作成・変更・削除・改名の通知時。
const diskChange = workspace.invalidate();
```

現在は安全な初期実装として、変更時に**すべての開いたroot**を失効させて再解析対象にする。依存グラフの部分再検査やdebounce・ジョブのキャンセル・診断通知の複数root間の合成は、将来のサーバー層の課題。解析中の変更・close・後発の解析リクエストを検知し、古い結果をキャッシュに戻さない。`getSnapshot(uri)`は失効後undefinedになる。保持済みsnapshotは特定versionの値なので、クライアント側でも変更後に流用しない。

`file:` URIと `untitled:` URIに対応する。untitledの保存予定位置は `filePath` で指定できる。未指定ならprojectRoot直下の一意な仮パスとして扱い、ファイルを作らずURIを維持する。相対importの基準を保存予定位置に合わせたいときはfilePathを指定する。`file:`にfilePathを併用したり、他のURI schemeを渡すと拒否する。

## 位置と意味情報

既存 `Span { file, line, column }` は互換性のため1始まりのまま維持する。Tokenには必須の `range`、Parserが作るASTノードには `range`、宣言名・変数名・メンバー名には `nameRange` を追加した。修飾型 `io.EOF` は `qualifierRange` も持つ。手作業でASTを作る既存コードを壊さないため、ASTの追加プロパティは型定義上optional。

`SourceRange { file, start, end }` はUTF-16 code unitによる半開区間 `[start, end)`。`SourceText.positionAt` / `offsetAt` / `range` がLSP用の0始まり位置へ変換する。CRLFは一つの改行、単独CRも改行として扱い、EOF診断は長さ0の区間になり得る。タブは表示幅にかかわらず1 code unit、絵文字は通常2 code units。

`checked.semantic`はCheckerが実際に解決した宣言ID・参照・スコープを持つ。名前の文字列一致による参照検索をしない。ローカル宣言の可視開始位置、シャドーイング、引数、case / handler束縛、import alias、公開関数・型、match内の絞り込みを記録する。

```ts
const hover = snapshot.hover(uri, position);
const location = snapshot.definition(uri, position);
const references = snapshot.references(uri, position, true); // 宣言も含める
const localNames = snapshot.completions(uri, position);
const ioMembers = snapshot.completions(uri, position, "io");
const items = snapshot.completionItems(uri, position); // キーワード・フィールド・回復情報を含む
const signature = snapshot.signatureHelp(uri, position);
```

Hoverはプレーンテキストの `contents` とRange。定義・参照はURIとRange。補完はlabel / detail / kind / mutable / definitionを返す。サーバー側でLSPのCompletionItemKindやMarkupContentへ変換する。moduleの候補はpubに限定し、内部nativeや特権TSAnyを候補から除く。一般値によりaliasが隠れている場合、そのaliasのメンバー候補も返さない。

## 現時点の制限と検証

- 診断は最初の1件。補完専用にParserの回復と部分型検査を行う。複数診断は未実装。
- Hover・従来の `completions`・定義・参照は**全体の型検査に成功したsnapshot用**。新しい `completionItems` と `signatureHelp` は、Workspaceが同じ文書バージョンから回復した情報も使用する。回復済みAST・部分検査結果は実行禁止で、厳密な診断や `result.checked` に混ぜない。
- 型の参照、関数、ローカル束縛、aliasの定義・参照に対応する。構造的なフィールドの定義IDは、言語上の意味が未確定なので作らない。フィールドの型Hoverは可能。
- `completionItems` はlabel / detail / kind / insertText / rangeを返す。read / async / await / Future、公開moduleメンバー、スコープ内識別子、構造体のフィールド、未完成の型引数に対応する。配列の `.length` は提供しない。asyncの呼び出しヒントは具体化した `Future<T>` を返す。Futureの消費・借用競合も通常の型診断として通知する。
- LSPサーバーが補完・引数ヒントのcapabilityを広告し、JSON-RPCテストで挿入範囲・可視性・未完成コード・引数位置を検証する。

テストは未保存entry・依存、完全メモリFS、明示stdlibRoot、CLIのmain検査、UTF-16 / CRLF / 絵文字 / EOF、シャドーイング、公開制御、case / handler、複数ファイル、削除・改名、診断消去、古い解析の破棄、stdlib overlayの拒否、symlink祖先のパス境界を含む。

現行機能と制限は [Generics v0.1・条件式・LSP補完](generics-v0.1.md) を参照。検証コマンドは `npm test`、`npm run extension:test`、`npm run format:check`。
