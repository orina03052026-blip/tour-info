# Instagram Story Auto-Posting システム
## 初回セットアップ・運用ガイド

---

## 📋 目次

1. [概要](#概要)
2. [前提条件](#前提条件)
3. [Meta Developers セットアップ](#meta-developers-セットアップ)
4. [WordPress REST API セットアップ](#wordpress-rest-api-セットアップ)
5. [実装ファイルの配置](#実装ファイルの配置)
6. [環境変数設定](#環境変数設定)
7. [手動テスト手順](#手動テスト手順)
8. [GitHub Actions 設定](#github-actions-設定)
9. [トークン更新・期限切れ対応](#トークン更新期限切れ対応)
10. [トラブルシューティング](#トラブルシューティング)

---

## 概要

このシステムは、毎日 0:00 JST に以下を自動実行します：

1. **Google Spreadsheet** から本日・明日のツアー予約情報を取得
2. **1080 x 1920** のInstagramストーリー画像を生成
3. **WordPress** にアップロード
4. **Instagram Graph API** でストーリーに投稿

---

## 前提条件

- ✅ Instagram プロアカウント（ビジネスアカウント）
- ✅ Facebookページと連携済み
- ✅ WordPress REST API が有効
- ✅ Google Spreadsheet が共有設定済み（リンク知っている人が閲覧可能）
- ✅ GitHub リポジトリにアクセス可能（tour-info リポジトリ）

---

## Meta Developers セットアップ

### Step 1: Meta Developers アカウント確認

1. [Meta Developers](https://developers.facebook.com/) にアクセス
2. 右上のメニューから「My Apps」をクリック
3. 既存のアプリがあれば選択、なければ「Create App」で新規作成
4. アプリの種類：「Business」を選択

### Step 2: Instagram Graph API を有効化

1. アプリダッシュボードで「Add Product」をクリック
2. 「Instagram Graph API」を検索して「Set Up」
3. プロダクトが有効化される

### Step 3: Business Account ID を確認

1. **Meta Business Suite** にアクセス
   - https://business.facebook.com/
2. 左メニュー「設定」 > 「ビジネス設定」
3. 左パネル「アカウント」 > 「Instagram アカウント」
4. 対象のInstagramアカウント（travel_network_act）をクリック
5. **「Instagram ビジネス アカウント ID」** をコピー（17841400963662003 など）

### Step 4: Facebook Page ID を確認

1. Meta Business Suite で左メニュー「アカウント」 > 「ページ」
2. 連携済みの Facebook Page をクリック
3. **「ページID」** をコピー（12345678901234567 など）

### Step 5: Long-lived Access Token を生成

#### 方法1：Graph API Explorer（簡易、期限60日）

1. [Graph API Explorer](https://developers.facebook.com/tools/explorer/) にアクセス
2. 右上アプリ選択で、作成したアプリを選択
3. ユーザー選択で、Instagram連携済みのFacebookユーザーを選択
4. 左側のクエリビルダーで：
   - 「GET」を選択
   - テキストフィールドに `me/accounts` と入力
   - 「Submit」をクリック
5. 結果に Facebook Page が表示される
6. 対象の Page ID をクリックして詳細を確認
7. 上部の「Access Token」をコピー

**⚠️ 重要：このトークンは 60日 で期限切れになります**

#### 方法2：永続トークン化（期限1年）

期限を1年に延長するには、以下の API を実行：

```bash
curl -X GET "https://graph.instagram.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=YOUR_APP_ID&client_secret=YOUR_APP_SECRET&access_token=SHORT_LIVED_TOKEN"
```

または、アプリ設定から「App Secret」を確認し、以下を実行：

```bash
# Access Token を延長（60日 → 60日または以上に延長可能）
curl -X GET \
  "https://graph.instagram.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=YOUR_APP_ID&client_secret=YOUR_APP_SECRET&access_token=SHORT_LIVED_TOKEN"
```

---

## WordPress REST API セットアップ

### Step 1: REST API ユーザーを作成

1. WordPress 管理画面 にログイン
2. 左メニュー「ユーザー」 > 「新規追加」
3. 以下を入力：
   - **ユーザー名**: `instagram_bot`
   - **メールアドレス**: `bot@travel-network-act.co.jp`
   - **パスワード**: 自動生成（保存すること）
   - **役割**: `編集者`（メディアアップロード権限が必要）
4. 「新規ユーザーを追加」をクリック

### Step 2: アプリケーションパスワードを生成

1. WordPress 管理画面「ユーザー」 > 「プロフィール」
2. 自分のプロフィール画面を開く（instagram_bot ユーザーではなく、自分のアカウント）
3. ページを下にスクロール「アプリケーションパスワード」セクション
4. アプリケーション名：`instagram-story-automation`
5. 「新しいアプリケーションパスワードを生成」をクリック
6. 表示されたパスワードをコピー
   - 形式：`xxxx xxxx xxxx xxxx xxxx xxxx`（スペース含む）

**⚠️ 重要：ページを離れると再表示できないため、必ずコピーして保存してください**

### Step 3: REST API テスト

以下のコマンドでテストしてください：

```bash
curl -u instagram_bot:xxxx\ xxxx\ xxxx\ xxxx\ xxxx\ xxxx \
  https://www.travel-network-act.co.jp/wp-json/wp/v2/media
```

成功例：
```json
[
  { "id": 1234, "source_url": "https://...", ... }
]
```

---

## 実装ファイルの配置

### GitHub Pages + GitHub Actions の場合

```bash
# tour-info リポジトリをクローン（既にある場合はスキップ）
git clone https://github.com/orina03052026-blip/tour-info.git
cd tour-info

# instagram-story-automation フォルダをコピー
cp -r ../instagram-story-automation ./

# GitHub Actions ワークフローをコピー
mkdir -p .github/workflows
cp instagram-story-automation/instagram-story-daily.yml .github/workflows/

# .gitignore に .env を追加
echo ".env" >> .gitignore
echo "instagram-story-automation/output/" >> .gitignore
echo "instagram-story-automation/.temp/" >> .gitignore
echo "instagram-story-automation/logs-*.log" >> .gitignore

# リポジトリに追加（.env は除外される）
git add .
git commit -m "Add Instagram Story auto-posting automation"
git push origin main
```

### ディレクトリ構成（完成形）

```
tour-info/
├── index.html
├── script.js
├── style.css
├── instagram-story-automation/
│   ├── package.json
│   ├── instagram-story-generator.js
│   ├── .env                    ← 本番環境
│   ├── .env.example            ← テンプレート
│   ├── output/                 ← 生成画像（テスト用）
│   ├── logs-2026-05-08.log    ← 実行ログ
│   └── README.md
├── .github/
│   └── workflows/
│       └── instagram-story-daily.yml
├── .gitignore
└── README.md
```

---

## 環境変数設定

### Step 1: .env ファイルを作成

```bash
cd instagram-story-automation
cp .env.example .env
```

### Step 2: .env を編集

```bash
# テキストエディタで開く
nano .env
```

以下の値を入力：

```env
# Google Spreadsheet
GOOGLE_SHEET_ID=1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY
GOOGLE_SHEET_GID=0

# WordPress
WORDPRESS_URL=https://www.travel-network-act.co.jp
WORDPRESS_USERNAME=instagram_bot
WORDPRESS_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# Instagram
INSTAGRAM_BUSINESS_ACCOUNT_ID=17841400963662003
INSTAGRAM_ACCESS_TOKEN=IGBBQx...（長いトークン）...xyz
FACEBOOK_PAGE_ID=12345678901234567

# QR Code
QR_CODE_URL=https://www.travel-network-act.co.jp/local/en/we-still-have-spots-available-for-our-tours-and-etc/
```

### Step 3: .env の権限を制限（セキュリティ）

```bash
chmod 600 .env
```

---

## 手動テスト手順

### 前提：Node.js 18+ インストール

```bash
# バージョン確認
node --version  # v18.0.0 以上であることを確認
npm --version   # v9.0.0 以上
```

### Step 1: 依存パッケージインストール

```bash
cd instagram-story-automation
npm install
```

### Step 2: テスト実行（画像生成のみ、投稿しない）

```bash
npm run test
```

**出力例：**
```
[2026-05-08T00:00:00.000Z] [INFO] Starting Instagram Story Auto-Posting (Mode: test)
[2026-05-08T00:00:00.100Z] [INFO] Environment validation passed
[2026-05-08T00:00:01.234Z] [INFO] Successfully fetched CSV data
[2026-05-08T00:00:01.567Z] [INFO] Story image saved: ./output/story-2026-05-08T00-00-01-234Z.png
[2026-05-08T00:00:01.890Z] [INFO] Test mode: image saved locally. Not uploading or posting.
```

**確認：** `output/` フォルダに PNG ファイルが生成されているか確認

### Step 3: 生成画像を確認

```bash
# Linux/Mac
open output/story-*.png

# Windows
start output/story-*.png
```

画像にはツアー情報とQRコードが含まれているか確認

### Step 4: WordPress アップロードテスト

```bash
npm run generate
```

その後、WordPress 管理画面 > メディア で、新しい画像がアップロードされているか確認

### Step 5: 完全なテスト（投稿まで）

**⚠️ 本番 Instagram アカウントに投稿されます。確認してから実行してください！**

```bash
npm run full
```

成功例：
```
[2026-05-08T00:00:00.000Z] [INFO] Starting Instagram Story Auto-Posting (Mode: full)
[2026-05-08T00:00:00.100Z] [INFO] Environment validation passed
[2026-05-08T00:00:01.234Z] [INFO] Successfully fetched CSV data
[2026-05-08T00:00:02.567Z] [INFO] Story image saved: ./output/story-2026-05-08T00-00-01-234Z.png
[2026-05-08T00:00:03.890Z] [INFO] Image uploaded successfully. Media ID: 12345, URL: https://www...
[2026-05-08T00:00:05.123Z] [INFO] Media container created: 12345678901234567
[2026-05-08T00:00:06.456Z] [INFO] Story posted successfully. Post ID: 98765432109876543
[2026-05-08T00:00:06.789Z] [INFO] ✅ Story posted successfully!
[2026-05-08T00:00:06.800Z] [INFO] All processes completed successfully
```

---

## GitHub Actions 設定

### Step 1: GitHub Secret を設定

GitHub リポジトリ（tour-info）で設定：

1. Settings > Secrets and variables > Actions
2. 「New repository secret」をクリック
3. 以下を追加：

| 名前 | 値 |
|------|-----|
| `GOOGLE_SHEET_ID` | `1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY` |
| `GOOGLE_SHEET_GID` | `0` |
| `WORDPRESS_URL` | `https://www.travel-network-act.co.jp` |
| `WORDPRESS_USERNAME` | `instagram_bot` |
| `WORDPRESS_APP_PASSWORD` | `xxxx xxxx xxxx xxxx xxxx xxxx` |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | `17841400963662003` |
| `INSTAGRAM_ACCESS_TOKEN` | `IGBBQx...xyz` |
| `FACEBOOK_PAGE_ID` | `12345678901234567` |
| `QR_CODE_URL` | `https://www.travel-network-act.co.jp/local/en/we-still-have-spots-available-for-our-tours-and-etc/` |

### Step 2: ワークフロー有効化確認

1. GitHub リポジトリで「Actions」タブをクリック
2. 「Instagram Story Daily Auto-Post」ワークフローが表示されるか確認
3. 右上「Enable workflow」をクリック（無効化されている場合）

### Step 3: 手動トリガーでテスト

1. Actions タブ > 「Instagram Story Daily Auto-Post」
2. 「Run workflow」をクリック
3. `mode` に `test` を選択
4. 「Run workflow」をクリック
5. ワークフローの実行を監視
6. 成功したら、ログを確認（Artifacts にログが保存される）

### Step 4: 定期スケジュール確認

`.github/workflows/instagram-story-daily.yml` に以下が含まれているか確認：

```yaml
schedule:
  - cron: '0 15 * * *'  # 毎日 15:00 UTC = 0:00 JST
```

---

## トークン更新・期限切れ対応

### Instagram Access Token の有効期限

- **短期トークン（デフォルト）**: 60日
- **長期トークン**: 1年

### トークン更新手順

#### 警告：トークン期限が近い場合

ログに以下のエラーが表示される：
```
[ERROR] (#190) The time period specified in the request is invalid
[ERROR] Invalid OAuth Token
```

#### 新規トークン取得手順

1. [Meta Developers Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. アプリを選択 > ユーザーを選択
3. `GET me/accounts` を実行
4. 結果の Facebook Page にある **access_token** をコピー
5. GitHub リポジトリの Secrets を更新
   - Settings > Secrets > `INSTAGRAM_ACCESS_TOKEN` を編集
   - 新しいトークンを貼り付け

#### 永続トークン化（推奨）

60日ごとに更新するのは面倒です。永続トークン化するには：

1. [Meta Developers](https://developers.facebook.com/)
2. アプリダッシュボード > 「App Secret」をコピー
3. 以下を実行：

```bash
# 短期トークンを長期トークンに交換
curl -X GET "https://graph.instagram.com/v18.0/oauth/access_token" \
  -d "grant_type=fb_exchange_token" \
  -d "client_id=YOUR_APP_ID" \
  -d "client_secret=YOUR_APP_SECRET" \
  -d "access_token=SHORT_LIVED_TOKEN"
```

取得した長期トークンで GitHub Secret を更新

### トークン有効期限の自動確認

```bash
# 現在のトークン有効期限を確認
curl -X GET "https://graph.instagram.com/debug_token?input_token=INSTAGRAM_ACCESS_TOKEN&access_token=INSTAGRAM_ACCESS_TOKEN"
```

出力例：
```json
{
  "data": {
    "is_valid": true,
    "expires_at": 1234567890
  }
}
```

---

## トラブルシューティング

### エラー：`Missing environment variables`

**原因**: .env ファイルが見つからない、または必須変数が未設定

**対策**:
```bash
cp .env.example .env
# .env を編集して全ての値を入力
```

### エラー：`ECONNREFUSED WordPress`

**原因**: WordPress へのアクセスができない

**対策**:
1. `WORDPRESS_URL` が正しいか確認
2. REST API が有効か確認：
   ```bash
   curl https://www.travel-network-act.co.jp/wp-json/
   ```
3. ファイアウォール/プロキシの設定を確認

### エラー：`Invalid OAuth Token (190)`

**原因**: Instagram Access Token が無効または期限切れ

**対策**:
1. [トークン更新手順](#トークン更新期限切れ対応) を実行
2. GitHub Secret を更新

### エラー：`Google Sheet data is empty`

**原因**: Google Spreadsheet にアクセスできない

**対策**:
1. [Google Sheet 共有設定確認](https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/edit?gid=0#gid=0)
   - 「共有」をクリック
   - 「リンクを知っている全員が閲覧可能」になっているか確認

### ログファイルが見つからない

**ログの場所**:
- **ローカル実行**: `instagram-story-automation/logs-YYYY-MM-DD.log`
- **GitHub Actions**: Actions > ワークフロー実行 > Artifacts > `execution-logs-*`

### QRコードが生成されない

**原因**: Canvas モジュールのインストール失敗

**対策**:
```bash
# 再インストール
npm install --force

# または rebuild
npm rebuild canvas
```

---

## 運用上の注意点

### 毎日チェック項目

1. **GitHub Actions ログの確認**
   - Actions タブで最新の実行が成功しているか確認
   - 失敗している場合はログを確認

2. **Instagram ストーリーの確認**
   - travel_network_act アカウントで投稿されているか確認
   - 画像の表示が正しいか確認

3. **Google Spreadsheet の更新**
   - CSV が正しく取得されているか確認
   - 本日・明日の予定が正しいか確認

### 月1回チェック項目

1. **Access Token の有効期限確認**
   - [トークン有効期限確認](#トークン有効期限の自動確認) を実行
   - 期限が1週間以内の場合は [トークン更新](#トークン更新期限切れ対応)

2. **ログファイルの整理**
   - 古いログを削除（30日以上前）

### 年1回チェック項目

1. **WordPress ユーザーアカウントの確認**
   - instagram_bot ユーザーが存在するか確認
   - 必要に応じて再設定

2. **GitHub Secret の監査**
   - 不要な Secret を削除
   - トークンローテーション

---

## サポート・問い合わせ

問題が発生した場合：

1. ログを確認（上記のトラブルシューティング参照）
2. GitHub Issues で報告
3. Meta Developer サポートに問い合わせ（API エラーの場合）
4. WordPress サポートに問い合わせ（REST API エラーの場合）

---

**最終更新**: 2026年5月8日
