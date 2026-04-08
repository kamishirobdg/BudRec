# kakeibo-app

## 概要
夫婦の家計簿Androidアプリ。レシート撮影・メール明細・SuicaCSVから支出を記録し、Google Sheetsに保存する。

## 技術スタック
- Expo (React Native) + TypeScript
- AI OCR: Claude / GPT-4o / Gemini（プロバイダー抽象化）
- Gmail API / Google Sheets API（直接呼び出し、サーバーなし）
- 認証: Google OAuth（expo-auth-session）

## ディレクトリ構成
app/screens / providers / services / utils

## 開発ステップ
1. プロジェクト作成 + Google OAuth ✓
2. Google Sheets API接続 ✓
3. AIProvider実装（Gemini→Claude→OpenAI） ← 今ここ（Geminiのみ実装済み、未テスト）
4. カメラ + レシート撮影
5. Gmail連携
6. SuicaCSVインポート
7. 可視化画面
