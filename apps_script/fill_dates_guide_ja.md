> ⚠ **このガイドは廃止です（2026-05-09）**
>
> 真の原因は `syncAvailability` が「カレンダーに予定が無い日付の行を毎回消す」
> 設計だったこと。fill_missing_dates 側にバグは無く、追加直後に消されていた。
> 修正は `apps_script/sync_availability.gs` で完結。fill_missing_dates は不要。
>
> 詳細: `../notes/空き状況完成.txt`
>
> 以下は旧手順（参考）。

# Availability シートの日付自動補完ガイド

## このスクリプトの目的

Google スプレッドシート「今日の空き状況」（シート名: `Availability`）に、
**今日から 2027-01-31 までの全日付**が `Kana AM / Kana PM / Sho AM / Sho PM`
の 4 行ずつ確実に存在している状態を保つ。

実体は `apps_script/fill_missing_dates.gs`。

## なぜこのスクリプトが必要か（根本原因）

- HP 表示用の CSV (`gid=0` 直読み) は **既にある行** しか出さない。
- カレンダー同期スクリプト (`calendar_sync_complete.gs`) は
  「**既存行のステータスを更新するだけ**」で、日付行の追加はしない。
- つまり「行を作る人が誰もいない」状態で放置すると日付が虫食いになる。
- 例: 2026-05-15 の次が 2026-05-17 になっていて 5/16 が抜けている、など。

→ **行を作る役割をこのスクリプトに集約**し、毎日トリガーで自動実行する。

## 設置手順（初回のみ）

1. スプレッドシートを開く
   `https://docs.google.com/spreadsheets/d/1Lyl_tjTHza8Wfp2WiDepi_ZTY_Xo6Xqpuhgog-lufFY/edit`
2. メニュー `Extensions（拡張機能）` → `Apps Script`
3. 既存の中身（前のバージョン）をすべて削除し、
   このリポジトリの `apps_script/fill_missing_dates.gs` の中身を全文コピペ
4. `Save（保存）`

## 1 回だけ実行する場合（今すぐ穴を埋めたいとき）

1. 関数選択ドロップダウンから `fillMissingDates` を選ぶ
2. `Run（実行）` をクリック
3. 初回は権限確認ダイアログ → アカウント選択 → `Allow（許可）`
4. 実行ログに `added=XXX` などのレポートが出る
5. スプレッドシートに戻る → 日付列で並び替えられて、欠落日が埋まっている

実行直後は **新規行はすべて以下のデフォルト値**：

| Staff | デフォルト Status | 理由 |
|---|---|---|
| Kana | `Off` | `calendar_sync_complete.gs` の `availability` モードに合わせる |
| Sho | `Available` | `calendar_sync_complete.gs` の `offOnly` モードに合わせる |

その後 `syncCalendarToSheet` を実行すれば、Google Calendar の登録内容に応じて
正しい Status / Source（`Calendar`）に上書きされる。

## 毎日自動実行に切り替える（推奨）

1. Apps Script エディタの左メニュー `Triggers（トリガー）` を開く
2. 右下 `+ Add Trigger`
3. 設定:
   - Function: `fillMissingDatesDaily`
   - Deployment: `Head`
   - Event source: `Time-driven`
   - Type of time: `Day timer`
   - Time of day: `2am to 3am`（カレンダー同期トリガーより前に走らせる）
4. 保存

これで毎晩、今日 + 365 日のローリングウィンドウで欠落日が自動補完される。
`targetEndDate: '2027-01-31'` を超えても 365 日先まで常に埋まる作りなので、
固定の終端日が過ぎても穴は出ない。

## 触ってはいけないものの保証

- **既存行は一切上書きしない**。新規行を末尾に追加してから日付ソートするだけ。
- `Manual Lock = TRUE` の行は当然そのまま。
- ヘッダー行（A1〜J1 の `Date / Staff / Time Slot / Status / Tour / Booked /
  Capacity / Notes / Source / Manual Lock`）は読み取り専用扱い。
- 列の順序が変わると壊れるので、ヘッダー名 `Date` `Staff` `Time Slot`
  `Status` `Source` `Manual Lock` が見つからない場合は実行を中止する。

## 実行後の確認（手動チェック手順）

1. スプレッドシートで列 A を末尾までスクロール → `2027-01-31` まで日付が
   連続していることを確認（飛びがない）。
2. `syncCalendarToSheet` を 1 回手動実行 → ログで `Updated XX rows.` を確認。
3. HP `https://www.travel-network-act.co.jp/local/en/we-still-have-spots-available-for-our-tours-and-etc/`
   を開いて、Today / Tomorrow / Day After のカードがちゃんと出ることを確認。
4. 何か壊れているように見えたら、まず Apps Script のログを確認し、
   それから `apps_script/calendar_sync_complete.gs` 側のログも見る。

## トラブルシュート

| 症状 | 原因の見当 | 確認場所 |
|---|---|---|
| 実行しても `missing=0` のまま日付が増えない | 既に埋まっている / トリガー先関数を間違えた | Apps Script ログ |
| `Header column not found: ...` | スプレッドシートのヘッダーが書き換えられている | A1〜J1 のヘッダー名 |
| HP が「No schedule for the next 3 days」 | スプレッドシート共有設定が崩れている | スプレッドシートの「共有」→「リンクを知っている全員（閲覧者）」 |
| 日付が虫食いに戻る | トリガーが止まっている / 別アカウントで動いている | Apps Script の Triggers 一覧、Executions タブ |

---

最終確認したい挙動:

- 今日から 2027-01-31 まで日付が連続している
- 各日付に Kana AM / PM, Sho AM / PM の 4 行が必ずある
- Google Calendar 同期は今まで通り（`syncCalendarToSheet`）
- HP 側の表示は壊れていない（CSV 直読み・列構成・ヘッダー不変）
