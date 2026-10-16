> v0.0.2移行は完了。現在の実装と制約は [現行仕様](language-spec-v0.0.2.md) と [実装状況](implementation-status.md) を優先する。以下は初期開発計画の記録。

# Noma 開発計画

## 今回の到達点

空の作業ディレクトリ `E:\VibeCodingProjects\newLanguage` からGitリポジトリを初期化し、仕様書を基準にStage 0の基盤とStage 1の実験的なI/Oをつないだ。コミット・リモート設定・公開はまだ行っていない。

Stageの完了を言語全体の完成と同一視しない。現在の対応範囲は [implementation-status.md](implementation-status.md) に記録する。

## Stage 0 — 最小処理系の縦切り

今回実装したもの:

- ソース位置付きLexer、Parser、AST
- 型注釈を必須とする宣言、名前解決、互換性検査
- 基本演算、関数、return、if、while、break
- Deep Readonly、mutable引数、snapshotの基本検査と実行
- 基本的な構造型、配列、Union、match、エラーハンドラ
- CLI、チェック専用モード、成功例と拒否例のテスト

次の作業では診断の質を改善し、型互換性・制御フローの検査を小さな単位へ分割する。新しい構文は仕様の未決事項と照合してから導入する。

## Stage 1 — Native Bridgeとstd/io

今回実装したもの:

- 信頼された標準ライブラリのロードと内部モジュールへの制限
- privateなnative宣言と入力専用のTSAny
- 入出力型を検証するNative Registry
- 自作言語で記述したstdout/stderr write/putsとreadLineラッパー
- Union、opaqueなホストエラー、EOFを通した成功・失敗経路
- UTF-8の境界分割、CRLF、空行、末尾行、EOF、入出力失敗のテスト

次の受け入れ条件:

1. throwable・EOF・native署名の案をユーザーとレビューし、採用する表現を決める。
2. 選んだABIに合わせて実験API・診断・テストを更新する。
3. 入力行長・出力待機・処理中断・リソース解放を設計する。
4. 標準ライブラリ配置とパッケージ配布時の信頼の決め方を整理する。

## Stage 2 — 型と変更権限の形式化

優先する設計課題:

1. readonly引数が保持できる値、mutable引数の競合、参照の脱出、寿命。
2. mutableフィールド・配列を含む部分型付けと不変性の規則。
3. Union正規化、構造型の重なり、実行時の判別とmatchの網羅性。
4. never / void、ブロック値、ループの終了、エラーハンドラの制御フロー。
5. 正式文法・数値型・配列表記・文字列API。

未決事項を安全に表現できるまで、対応しない形は明示的に拒否する。新機能ごとに動作例と拒否すべき例を追加する。

## 将来 — 標準ライブラリとセルフホスティング

文字列・コレクション・ファイル等を必要に応じて拡張する。性能を計測してからVMやコード生成を検討する。セルフホスティングには、コンパイラ自身を書くためのデータ構造・モジュール・I/Oが揃い、TypeScript版との比較検証が可能であることが必要。方式・順番・期限は未決定。

## 変更ごとの検証

```powershell
npm run typecheck
npm run format:check
npm test
npm run demo
```

`npm test` はTypeScriptのビルド、静的検査の拒否例、実行時の値の独立性、Native Registry境界、Node.jsストリーム、実プロセスのCLIを含む。言語仕様の変更時は、対応表とサンプルも同時に更新する。

2026-10-15の確認結果: Windows / Node.js 26.7.0でビルド成功、76件すべて合格、Prettier整形検査合格。hello・snapshotのCLI実行とechoの静的検査を手動確認し、実プロセスのUTF-8 echo・EOF処理・終了コード・静的エラーによる実行抑止を自動テストでも確認した。
