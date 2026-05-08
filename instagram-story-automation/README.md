# Instagram Story Auto-Posting - Quick Start Guide

日本語の詳細ガイドは [README-ja.md](README-ja.md) を参照してください。

---

## ⚡ 5分クイックスタート

### 1. 環境変数設定
```bash
cp .env.example .env
# .env を編集して以下を入力：
#  - GOOGLE_SHEET_ID
#  - WORDPRESS_URL / USERNAME / APP_PASSWORD
#  - INSTAGRAM_BUSINESS_ACCOUNT_ID / ACCESS_TOKEN
#  - FACEBOOK_PAGE_ID
```

### 2. 依存パッケージインストール
```bash
npm install
```

### 3. ローカルテスト
```bash
# 画像生成のみ（投稿しない）
npm run test

# output/ フォルダに PNG ファイルが生成される
```

### 4. 本番投稿テスト
```bash
# 完全実行（画像生成 → アップロード → 投稿）
npm run full
```

### 5. GitHub Actions 設定
```bash
# リポジトリの Settings > Secrets で上記の環境変数を登録
# .github/workflows/instagram-story-daily.yml が自動実行される
```

---

## 📋 使用コマンド

| コマンド | 説明 |
|---------|------|
| `npm run test` | 画像生成のみ（ローカル保存） |
| `npm run generate` | 画像生成 + WordPress アップロード |
| `npm run post` | Instagram に投稿（既存画像から） |
| `npm run full` | 完全実行 |

---

## 🔑 必須情報

### Meta Developers
- [ ] Instagram Business Account ID
- [ ] Long-lived Access Token
- [ ] Facebook Page ID

### WordPress
- [ ] REST API ユーザー名
- [ ] アプリケーションパスワード

### Google Sheets
- [ ] Spreadsheet ID
- [ ] 共有設定が「リンク知っている人が閲覧可能」

---

## 📱 スケジュール実行

**毎日 0:00 JST** に自動実行（GitHub Actions）

手動実行：
```
GitHub リポジトリ > Actions > "Instagram Story Daily Auto-Post"
> "Run workflow" > mode選択 > "Run workflow"
```

---

## ⚠️ トラブル

### トークン期限切れ
```
Error: Invalid OAuth Token (190)
```
→ Meta Developers で新しいトークンを取得し、GitHub Secret を更新

### WordPress 接続失敗
```
Error: ECONNREFUSED
```
→ `WORDPRESS_URL` が正しいか確認  
→ REST API が有効か確認（`curl https://site/wp-json/`）

### Google Sheet 読み込み失敗
```
Error: Invalid CSV
```
→ Google Sheets の共有設定を確認  
→ `GOOGLE_SHEET_ID` が正しいか確認

---

## 📖 詳細ガイド

- [README-ja.md](README-ja.md) - セットアップ・運用ガイド（日本語）
- [IMPLEMENTATION.md](IMPLEMENTATION.md) - 技術詳細

---

## 🚀 更新・メンテナンス

毎月実行：
- [ ] Access Token 有効期限確認
- [ ] ログファイル確認（エラーないか）

毎年実行：
- [ ] GitHub Secret 監査
- [ ] WordPress ユーザーアカウント確認

---

**Author**: Travel Network Act  
**Version**: 1.0.0  
**License**: MIT
