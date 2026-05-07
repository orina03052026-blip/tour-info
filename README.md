# Kana Sho Tours — Availability

GitHub Pages で配信される、今日・明日のツアー空き状況表示ページ。
WordPress に iframe で埋め込んで使用する。

- 公開URL: https://orina03052026-blip.github.io/tour-info/
- リポジトリ: https://github.com/orina03052026-blip/tour-info

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | エントリポイント（CSS・JSを読み込むだけの薄いシェル） |
| `style.css` | カードUIスタイル・モバイル対応 |
| `script.js` | CSV取得・パース・予約ロジック・描画 |
| `README.md` | このファイル |

ビルド不要・依存ライブラリなし（Vanilla JS）。

## データソース

Googleスプレッドシート（CSV直接読み込み）。

- スプレッドシート: https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/edit
- シート名: `Availability`
- CSV URL（`script.js` の `SHEET_CSV_URL`）:
  `https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/export?format=csv&gid=0`

`fetch()` 時に `&t=<timestamp>` を付与してキャッシュ回避。

スプレッドシート共有設定は **「リンクを知っている全員 → 閲覧者」** 必須。

## スプレッドシート列構成

1行目はヘッダー行（必須・名前完全一致）。

| 列 | 名前 | 内容 |
|---|---|---|
| A | `Date` | `YYYY-MM-DD` 形式（例: `2026-05-07`） |
| B | `Staff` | スタッフ名（`Kana` / `Sho` など。HPには非表示） |
| C | `Time Slot` | `AM` / `PM` |
| D | `Status` | `Available` / `Off` |
| E | `Tour` | 下記3コースのいずれか |
| F | `Booked` | 予約人数（数字のみ。空欄は0扱い） |
| G | `Capacity` | 定員（HP側ではツアー定義の値を使用） |
| H | `Notes` | 自由記入欄（HP非表示） |

### Status

- `Available`: 表示対象
- `Off`: 非表示（休み）
- 空欄や他の値はスキップ

### Tour（プルダウン推奨）

- `e-bike Ride around the Castle, Slurp Like a Local`（定員4）
- `e-bike Ride to the Sea, Slurp Like a Local`（定員4）
- `Himeji castle guide tour`（定員8）

### Date 形式について

**必ず `YYYY-MM-DD` 形式で入力すること。**
`5/7` のような形式の行はスキップされる（`console.warn`）。

## 表示ルール

- 表示対象は **今日・明日のみ**（日本時間で判定）
- 順序: 今日 → 明日 → AM → PM
- 同じ時間帯内: 予約済みツアー → 未予約ツアー
- スタッフ名は表示しない
- 同時間帯に複数スタッフがいる場合、ツアーカードを並列表示
- 当日の **9:30 以降は今日のAM枠を非表示**

## 予約ロジック

- `Booked = 0`: 未予約枠 → 3ツアーすべてを「予約可能」として表示
- `Booked > 0`:
  - そのスタッフ枠は最初に予約された Tour に固定
  - 該当ツアーのみ表示
  - `Tour` 空欄なら `console.error` を出力してスキップ
- 残席 = `Capacity - Booked`（Capacityはツアー定義の値）

### 残席表示

| 残席 | 表示 |
|---|---|
| 0以下 | `Fully booked`（カード半透明） |
| 1 | `Only 1 seat left` |
| 2 | `Only 2 seats left` |
| 3以上 | `Available` |

## 重複データ処理

`Date + Staff + Time Slot` の組み合わせが複数ある場合は最初の1件のみ採用、`console.warn` を出力。

## エラー処理

CSV取得失敗・ヘッダー不一致など致命的エラー時は `No tours available` を表示。
個別行の異常はスキップして他の正常データを表示。

## デプロイ

```bash
cd tour-info
git add .
git commit -m "..."
git push origin main
```

GitHub Pages に反映されるまで2〜3分かかる。

## ツアー詳細ページ

`script.js` の `TOURS` 配列で管理。

| ツアー | URL |
|---|---|
| e-bike Ride around the Castle, Slurp Like a Local | https://www.travel-network-act.co.jp/local/en/castle-town/ |
| e-bike Ride to the Sea, Slurp Like a Local | https://www.travel-network-act.co.jp/local/en/tour-from-the-shikama-kaido-to-the-sea/ |
| Himeji castle guide tour | https://www.travel-network-act.co.jp/local/en/himeji-castle-guide-personal-tour/ |
