# 実装概要

## ファイル構成

```
instagram-story-automation/
├── instagram-story-generator.js   # メイン実装（データ取得 → 画像生成 → 投稿）
├── instagram-story-daily.yml      # GitHub Actions ワークフロー定義
├── package.json                   # Node.js 依存パッケージ
├── .env.example                   # 環境変数テンプレート
├── .env                           # 実際の環境変数（秘密情報）
├── .gitignore                     # Git 除外設定
├── README-ja.md                   # 詳細なセットアップ・運用ガイド
└── IMPLEMENTATION.md              # このファイル

.github/workflows/
└── instagram-story-daily.yml      # GitHub Actions ワークフロー（リポジトリ直下）
```

## 技術スタック

| 要素 | 選択肢 | 理由 |
|------|--------|------|
| **実行環境** | Node.js 18+ | GitHub Actions 標準環境 |
| **スケジューリング** | GitHub Actions | 無料、セットアップ簡単 |
| **画像生成** | canvas + qrcode | ネイティブバイナリ必要なし（快適） |
| **データ取得** | Google Sheets CSV | 既存フロー継続 |
| **アップロード** | WordPress REST API | 既存インフラ活用 |
| **投稿** | Instagram Graph API | 公式 API |
| **時刻制御** | Cron（UTC 15:00） | 0:00 JST ±10分 |

## 処理フロー

```
[00:00 JST]
    ↓
[GitHub Actions 起動（±10分）]
    ↓
1. Google Spreadsheet から CSV を取得
    ├─ URL: https://docs.google.com/spreadsheets/d/{ID}/export?format=csv
    └─ 本日・明日の予定抽出
    ↓
2. Instagram ストーリー画像生成（1080 x 1920）
    ├─ Canvas でテキスト・グラデーション描画
    ├─ QRコード埋め込み
    └─ PNG 出力
    ↓
3. WordPress REST API でアップロード
    ├─ 認証: Basic 認証（ユーザー名 + アプリケーションパスワード）
    └─ 公開 URL 取得
    ↓
4. Instagram Graph API でストーリー投稿
    ├─ Media Container 作成
    ├─ 0:00 JST 投稿スケジュール（オプション）
    └─ Post ID 返却
    ↓
[✅ 完了]
```

## 依存ライブラリ

```json
{
  "canvas": "^2.11.2",        // 画像生成
  "qrcode": "^1.5.3",         // QRコード生成
  "dotenv": "^16.3.1",        // 環境変数読み込み
  "axios": "^1.6.2",          // HTTP クライアント
  "node-fetch": "^3.3.2"      // Fetch API（node-fetch）
}
```

## セキュリティ考慮事項

### 秘密情報の保護

| 情報 | 保存場所 | アクセス |
|------|---------|---------|
| `.env` 本体 | ローカル・サーバー | `.gitignore` で Git 除外 |
| GitHub Secret | GitHub | リポジトリ管理者のみ |
| WordPress パスワード | GitHub Secret | 最小権限ユーザー（instagram_bot） |
| Instagram Token | GitHub Secret | Read-only or限定スコープ |

### ベストプラクティス

1. **アクセストークンのローテーション**
   - 60日ごとに更新（自動で失敗検知）
   - または長期トークン化（1年）

2. **WordPress 権限の最小化**
   - instagram_bot: 「編集者」役割のみ
   - メディアアップロード権限のみ
   - 投稿・削除権限なし

3. **ログ保持**
   - 実行ログは GitHub Artifacts で30日保持
   - 失敗ケースをトレース可能

4. **GitHub Secrets の監査**
   - 月1回、Secrets 一覧を確認
   - 不要な Secret は削除

## トラブル対応フロー

```
投稿失敗
    ↓
1. ログを確認（ローカルまたは GitHub Artifacts）
    ├─ [INFO] で進行状況を追跡
    └─ [ERROR] でエラー原因を特定
    ↓
2. エラーの種類で対応
    ├─ Google Sheet エラー → CSV 公開設定確認
    ├─ WordPress エラー → REST API 認証確認
    ├─ Instagram エラー → Token 期限確認
    └─ 画像生成エラー → Canvas インストール確認
    ↓
3. ローカルでテスト実行
    ├─ npm run test       (画像生成のみ)
    ├─ npm run generate   (アップロード込み)
    └─ npm run full       (完全実行)
    ↓
4. 本番実行
    └─ GitHub Actions 手動トリガー
```

## 拡張・カスタマイズ

### 画像デザイン変更

`instagram-story-generator.js` の `generateStoryImage()` 関数を編集：

```javascript
// 背景色・グラデーション
const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
gradient.addColorStop(0, '#1a4d7a');  // ← 色コード変更

// フォント・テキスト
ctx.font = 'bold 52px "Arial", sans-serif';  // ← フォント・サイズ変更
ctx.fillText('Travel Network Act', x, y);     // ← テキスト変更
```

### 投稿時刻の変更

`.github/workflows/instagram-story-daily.yml`:

```yaml
schedule:
  - cron: '0 15 * * *'  # ← Cron 式を変更（UTC）
```

例：
- `0 9 * * *` = 18:00 JST
- `0 23 * * *` = 08:00 JST（翌日）

### Slack 通知追加

GitHub Actions ワークフローに Slack Action を追加：

```yaml
- name: Notify Slack on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
    payload: |
      {
        "text": "Instagram Story posting failed!",
        "blocks": [...]
      }
```

---

## パフォーマンス・コスト

### GitHub Actions 実行時間

- 依存パッケージインストール: 15〜30秒
- データ取得: 1秒
- 画像生成: 3〜5秒
- WordPress アップロード: 2〜3秒
- Instagram 投稿: 1〜2秒
- **合計**: 20〜40秒

### GitHub Actions コスト

- 実行時間: 20〜40秒 ≈ 1分（4000分 = 月額コスト $20）
- **無料枠**: 月 3000分 > 月 30分（毎日1回） → **完全無料**

### データ転送量

- Google Sheets CSV: 50KB
- 画像生成・アップロード: 500KB～1MB
- **月間**: 30日 × 1.5MB ≈ 45MB → **GitHub 限度内**

---

## サポート対象外

以下はこのスクリプトの対象外です：

- Instagram Stories へのテキストスタンプ・リンク埋め込み（API 非対応）
  → **QRコード で代替**
- リアルタイム更新（スケジュール実行のため）
  → GitHub Actions 制限
- 複数言語対応（日本語表示のみ）
  → `instagram-story-generator.js` を拡張

---

## ライセンス

MIT License - 自由に改変・配布・商用利用可能

---

**バージョン**: 1.0.0  
**最終更新**: 2026年5月8日
