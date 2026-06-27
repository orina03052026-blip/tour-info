# 統一予約システム セットアップ手順（Algueblue＋サイクリング＋姫路城）

このガイドは、新しく追加した **予約 Web App**（`booking_webapp.gs`）と
**予約フォーム**（`booking.html` / `booking.js` / `booking.css`）、および
**今日・明日ページの Algueblue カード**（`script.js`）を稼働させる手順です。

---

## 0. 全体像

```
[booking.html フォーム]  ← GitHub Pages
   │  GET ?action=availability       （空き状況を取得）
   │  POST text/plain でJSON          （予約を確定）
   ▼
[Apps Script Web App  booking_webapp.gs]
   ├─ doGet : Availabilityシート＋カレンダーから空きを計算してJSON返却
   └─ doPost: LockServiceで直列化 → カレンダー再チェック →
              施術＋送迎2件のカレンダー予定を作成 → Bookingsシートに1行追加
                    ▲
[今日・明日ページ script.js] ── GET ?action=availability で Algueblue カードを表示
```

- 既存の `syncAvailability()`（カレンダー→Availabilityシート）は **そのまま**。
  Algueblue 予約が作る「送迎予定（スタッフ名入り）」を sync が拾い、ツアー枠との
  スタッフ取り合いが自動で効きます。

---

## 1. スクリプトを追加する

1. 対象スプレッドシート（`1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY`）を開く
2. 拡張機能 ▸ Apps Script
3. `booking_webapp.gs` を新規ファイルとして追加し、リポジトリの内容を貼り付け
   - ※ `sync_availability.gs` と同じプロジェクトに置くこと（`CONFIG` などを共有しているため）

## 2. Bookings シートを作る

エディタで関数 **`setupBookingSheet_`** を一度実行（▶ 実行）。
`Bookings` シートが作られ、ヘッダ行が入ります。

## 3. Web App としてデプロイ

1. 右上 **デプロイ ▸ 新しいデプロイ**
2. 種類 = **ウェブアプリ**
3. 説明 = 任意（例: booking v1）
4. **次のユーザーとして実行 = 自分**
5. **アクセスできるユーザー = 全員**（匿名のお客様が予約するため）
6. デプロイ → 表示される **ウェブアプリ URL（…/exec）** をコピー

> 以後コードを更新したら「デプロイを管理 ▸ 編集（鉛筆）▸ 新バージョン」で再デプロイ。
> URL は変わりません。

## 4. URL をフロントに貼る

`/exec` URL を次の **2 か所** の `WEBAPP_URL` に貼る：

- `booking.js` 冒頭 `const WEBAPP_URL = '...';`
- `script.js` 冒頭 `const WEBAPP_URL = '...';`（今日・明日ページの Algueblue カード用）

貼らない場合：フォームは空きを取得できず、今日・明日ページの **Algueblue カードは出ません**
（ツアー表示は従来どおり動きます）。

## 5. 同期トリガーを 60 分間隔にする

エディタで関数 **`setupTrigger`** を一度実行。
既存の syncAvailability トリガーを消し、**毎時（60分間隔）**で作り直します。

---

## 6. Algueblue のカレンダー運用ルール（重要）

すべて既存の `comecomehimeji@gmail.com` カレンダー内で運用します。Algueblue の予定は
**作成者 = `algue.blue@gmail.com`** で見分けます。

| 入れ方 | 意味 |
|---|---|
| **algue.blue が作成した「終日」予定** | その日は **休業** → カード非表示・予約不可 |
| **algue.blue が作成した「時間つき」予定** | その時間、**施術室が埋まっている**（予約不可帯） |
| 本システムが作る `[Algueblue] …`（`#ALGUEBLUE` 付き） | 同上（施術室占有として計算に算入） |
| 本システムが作る `[Algueblue送迎/…]`（スタッフ名入り） | Kana/Sho の送迎拘束。sync がその枠を Off 化 |

予約成立の条件（開始 T・施術 D 分）:
1. T が **10:00〜16:00**（当日は現在時刻以降）
2. 施術室 `[T, T+D]` が空き
3. **Kana か Sho** のどちらかが `[T−30, T]`（行き）と `[T+D, T+D+30]`（帰り）の両方空き
4. その日が休業（終日予定）でない

プラン別の施術時間（施術室ブロック）:
- Plan 01 Luxury Thalasso Foot Spa … **90 分**（当日可）
- Plan 02 Premium Japanese Spa（Facial/Body）… **120 分**（当日可）
- Plan 03 Ultimate J-Spa Retreat … **200 分**・**前日まで（当日不可）**

---

## 7. 動作テスト

1. ブラウザで `…/exec?action=availability` を開き、JSON が返るか確認
   - `days` に今日・明日、`algueblue.plans` と `tours` が入っていれば OK
2. `booking.html` を開く → アクティビティ→日付→（プラン/時刻 or AM/PM）→人数→連絡先
   → Confirm。Booking ID が表示されれば成功
3. スプレッドシートの `Bookings` に行が増え、カレンダーに
   `[Algueblue] …`＋`[Algueblue送迎/pickup]`＋`[Algueblue送迎/dropoff]` の3予定ができることを確認
4. 今日・明日ページを再読込し、**Thalassotherapy Spa カード**が出るか確認

### テスト予約の消し方
カレンダーの3予定を削除し、`Bookings` の該当行を削除。次回 sync で枠が戻ります。

---

## 8. 既知の制限・確認したい点

- **スタッフ空きの粒度（Algueblue送迎）**：送迎の可否は Availability シートの **AM/PM 単位**で判定しています
  （30分の送迎枠を AM/PM に丸め）。分単位の厳密判定が必要になったら拡張可能です。
- **サイクリング/城の予約（30分単位）**：全ツアー **所要3時間**。**9:30〜15:00 の30分刻み**で開始でき、
  **Kana/Sho の勤務時間に [開始, 開始+3時間] が収まる**ときだけ受付可（在席は Availability シートの
  AM/PM を勤務窓に変換：両方在席→9:30〜18:00／AMのみ→9:30〜12:30／PMのみ→13:30〜18:00）。
  当日は現在時刻以降のみ。e-bike は雨天中止の半日を除外。確定時はカレンダーを直読みして担当者
  （Kana/Sho）の空きを再チェックし1名割り当てて 180分の予定を作成します。
  ※ スタッフ在席の半日粒度はシート由来のため、30分の送迎などで半日まるごと塞がる場合があります
  （安全側＝二重予約はしない）。もう1名が空いていればそちらで受付されます。
- **決済なし**：フォームは申込受付のみ。確定＝即カレンダー反映（自動確定）。
- **確認メール**：現状は送っていません（必要なら doPost に `MailApp.sendEmail` を追加可能）。
- **タイムゾーン**：Apps Script プロジェクトのタイムゾーンが **Asia/Tokyo** である前提です
  （プロジェクトの設定 ▸ タイムゾーンを確認）。

## 9. 今日・明日ページ（WordPress 本文）の更新

今日・明日ページ
（`/local/en/we-still-have-spots-available-for-our-tours-and-etc/`）は
**上部 = iframe ウィジェット（script.js）** ＋ **下部 = WordPress 固定本文** の2部構成です。

- iframe 内の **全カードの「Book Now!」が booking.html（統一予約フォーム）に飛ぶ**よう変更済み
  （ツアーは `?activity=ebike-castle` などで事前選択、Algueblue は `?activity=algueblue`）。
- 下部固定本文の
  **「It's not possible to book through the reservation site … Please feel free to contact us.」**
  は、フォーム稼働後は実態と合わなくなります。
  → 「Book online from the cards above（上のカードからオンライン予約できます）」等へ文言修正を推奨。
