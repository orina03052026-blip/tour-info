# Instagram Story Auto-Posting - Implementation Summary

## 📋 概要

本実装は、毎日 0:00 JST に以下を自動実行するシステムです：

1. Google Spreadsheet から本日・明日の予定情報を取得
2. 1080 x 1920 のInstagramストーリー用画像を生成
3. WordPress メディアライブラリにアップロード
4. Instagram Graph API でストーリーに投稿

---

## 📦 成果物一覧

### ✅ 実装ファイル

| ファイル | 説明 | 用途 |
|---------|------|------|
| `instagram-story-generator.js` | メイン実装 | データ取得→画像生成→投稿の全ロジック |
| `package.json` | Node.js パッケージ定義 | 依存ライブラリの管理 |
| `instagram-story-daily.yml` | GitHub Actions ワークフロー定義 | 毎日0:00の自動実行設定 |
| `.env.example` | 環境変数テンプレート | 本番環境で使用する .env の雛形 |
| `.gitignore` | Git 除外設定 | .env、ログ、出力ファイルをGit除外 |

### ✅ ドキュメント

| ファイル | 説明 | 対象者 |
|---------|------|--------|
| `README.md` | クイックスタート（英語） | 開発者向け（簡潔） |
| `README-ja.md` | 詳細セットアップ・運用ガイド（日本語） | 運用者向け（詳細） |
| `IMPLEMENTATION.md` | 技術実装詳細 | エンジニア向け |
| `setup.sh` | 初回セットアップスクリプト | 自動化セットアップ |
| `CHECKLIST.md` | このファイル | 完了確認リスト |

### ✅ 設定ファイル

- `.env` → 本番環境（秘密情報）※Git除外
- `.github/workflows/instagram-story-daily.yml` → tour-info リポジトリ直下に配置

---

## 🚀 初回セットアップ（3ステップ）

### Step 1: 環境変数設定
```bash
cd instagram-story-automation
cp .env.example .env
nano .env  # 値を入力
```

### Step 2: 依存パッケージインストール
```bash
npm install
```

### Step 3: ローカルテスト
```bash
npm run test  # 画像生成のみ
npm run full  # 完全実行（投稿まで）
```

---

## 🔑 必須認証情報（事前取得が必要）

### Meta Developers（Instagram）
- [ ] **Instagram Business Account ID** - Meta Business Suite で確認
- [ ] **Long-lived Access Token** - Graph API Explorer で取得（60日有効）
- [ ] **Facebook Page ID** - Meta Business Suite で確認

### WordPress
- [ ] **REST API ユーザー名** - 管理画面で新規作成
- [ ] **アプリケーションパスワード** - ユーザープロフィールで生成

### Google Sheets
- [ ] **Spreadsheet ID** - シートURLから抽出
- [ ] **共有設定** - 「リンクを知っている全員が閲覧可能」に設定

---

## 📋 本番環境への配置手順

### リポジトリ構成（完成形）

```
tour-info/（GitHub リポジトリ）
├── index.html
├── script.js
├── style.css
├── instagram-story-automation/         ← 新規フォルダ
│   ├── package.json
│   ├── instagram-story-generator.js
│   ├── .env                           （秘密情報）
│   ├── .env.example
│   ├── .gitignore
│   ├── README.md
│   ├── README-ja.md
│   └── IMPLEMENTATION.md
├── .github/workflows/
│   └── instagram-story-daily.yml      ← 新規ファイル
├── .gitignore                         ← 編集（.env追加）
└── README.md
```

### 配置コマンド

```bash
# 1. tour-info リポジトリをクローン
git clone https://github.com/orina03052026-blip/tour-info.git
cd tour-info

# 2. instagram-story-automation フォルダをコピー
cp -r ../instagram-story-automation ./

# 3. GitHub Actions ワークフロー用フォルダ作成
mkdir -p .github/workflows

# 4. ワークフローファイルをコピー
cp instagram-story-automation/instagram-story-daily.yml .github/workflows/

# 5. .gitignore に .env を追加
echo ".env" >> .gitignore
echo "instagram-story-automation/.temp/" >> .gitignore
echo "instagram-story-automation/logs-*.log" >> .gitignore
echo "instagram-story-automation/output/" >> .gitignore

# 6. リポジトリに追加＆プッシュ
git add .
git commit -m "Add Instagram Story auto-posting automation"
git push origin main
```

---

## ✅ 手動テスト手順

### 環境：ローカルマシン（Node.js 18+ インストール済み）

```bash
# 1. 依存パッケージインストール
cd instagram-story-automation
npm install

# 2. テスト①：画像生成のみ（投稿しない）
npm run test
# → output/story-*.png が生成される

# 3. テスト②：WordPress アップロードまで
npm run generate
# → WordPress メディアライブラリに画像がアップロード

# 4. テスト③：完全実行（投稿まで）
npm run full
# ⚠️ 本番 Instagram に投稿されます
```

---

## 🔄 GitHub Actions 自動実行設定

### Step 1: GitHub Secret を登録

GitHub リポジトリ > Settings > Secrets and variables > Actions

| Secret 名 | 値 |
|-----------|-----|
| `GOOGLE_SHEET_ID` | `1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY` |
| `GOOGLE_SHEET_GID` | `0` |
| `WORDPRESS_URL` | `https://www.travel-network-act.co.jp` |
| `WORDPRESS_USERNAME` | `instagram_bot` |
| `WORDPRESS_APP_PASSWORD` | `xxxx xxxx xxxx xxxx xxxx xxxx` |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | `17841400963662003` |
| `INSTAGRAM_ACCESS_TOKEN` | `IGBBQx...xyz` |
| `FACEBOOK_PAGE_ID` | `12345678901234567` |
| `QR_CODE_URL` | `https://www.travel-network-act.co.jp/local/en/we-still-have-spots-available-for-our-tours-and-etc/` |

### Step 2: ワークフロー有効化

GitHub Actions タブ > 「Instagram Story Daily Auto-Post」> 「Enable workflow」

### Step 3: スケジュール確認

毎日 **15:00 UTC = 00:00 JST** に自動実行

---

## 📅 毎日のチェック項目

- [ ] Instagram ストーリーが投稿されているか
- [ ] 画像のツアー情報が正しいか
- [ ] QRコードが機能するか

---

## 📦 毎月のメンテナンス

- [ ] GitHub Actions 実行ログを確認（エラーないか）
- [ ] Access Token の有効期限確認（期限が1週間以内なら更新）

---

## 🔐 アクセストークン更新手順

Instagram Access Token は **60日** で期限切れになります。

### トークン更新手順

1. [Meta Developers Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. アプリ・ユーザーを選択 > `GET me/accounts` 実行
3. 新しい `access_token` をコピー
4. GitHub リポジトリ > Settings > Secrets > `INSTAGRAM_ACCESS_TOKEN` を編集
5. 新しいトークンで上書き

---

## 🆘 トラブルシューティング

### エラー：`Missing environment variables`
→ `.env` ファイルが見つからない。`cp .env.example .env` で作成し、値を入力

### エラー：`Invalid OAuth Token`
→ Instagram Access Token が期限切れ。[トークン更新手順](#トークン更新手順) を実行

### エラー：`ECONNREFUSED WordPress`
→ WordPress REST API に接続できない。`WORDPRESS_URL` が正しいか確認

### エラー：`Invalid CSV`
→ Google Sheets のアクセスが許可されていない。共有設定を「リンク知っている人が閲覧可能」に変更

詳細は [README-ja.md](README-ja.md) を参照

---

## 📊 実装統計

| 項目 | 数値 |
|------|------|
| **コード行数** | 約 700 行（instagram-story-generator.js） |
| **依存パッケージ** | 5 個 |
| **ドキュメント** | 約 2000 行 |
| **実行時間** | 20～40秒（GitHub Actions） |
| **月間コスト** | $0（GitHub Actions 無料枠内） |

---

## 🎯 達成事項

- ✅ 毎日 0:00 JST に自動投稿
- ✅ Google Spreadsheet から動的にデータ取得
- ✅ 1080 x 1920 のInstagramストーリー画像生成
- ✅ QRコード自動埋め込み
- ✅ WordPress REST API でのアップロード
- ✅ Instagram Graph API での投稿
- ✅ 秘密情報の安全な管理（GitHub Secrets）
- ✅ ログ記録・トラブルシューティング機能
- ✅ 詳細なドキュメント（日本語）
- ✅ 既存インフラへの最小限の変更

---

## 🔗 参考リンク

- [Google Sheets API](https://developers.google.com/sheets/api)
- [WordPress REST API](https://developer.wordpress.org/rest-api/)
- [Instagram Graph API](https://developers.facebook.com/docs/instagram-graph-api)
- [GitHub Actions](https://github.com/features/actions)
- [Canvas Library](https://www.npmjs.com/package/canvas)

---

**成果物完成日**: 2026年5月8日  
**バージョン**: 1.0.0  
**ライセンス**: MIT
