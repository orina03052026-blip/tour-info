# カレンダー同期スクリプト ガイド

## 問題
現在、Google Calendar では Kana が 5月11日に 09:30～15:00 で出勤予定なのに、スプレッドシートでは OFF と表示されている。

## 原因
Google Apps Script の同期ロジックに以下の問題がある可能性があります：
1. **カレンダーメールアドレスの設定が間違っている**
2. 時間帯判定ロジックのバグ
3. Kana の `calendarMode: 'availability'` が正しく実装されていない

## 修正方法

### ステップ 1: Kana と Sho のカレンダーメールアドレスを確認
1. Google Calendar を開く（https://calendar.google.com）
2. 左側メニューの「+ カレンダーを追加」の隣の設定アイコン → 「設定」
3. 「カレンダーの統合」セクションで、このカレンダーのメールアドレスを確認
4. または個人のメールアドレス（Gmail）を確認

**必要な情報：**
- Kana のメールアドレス（例: kanakeyboard7@gmail.com）
- Sho のメールアドレス（例: sho.sunak@gmail.com）

### ステップ 2: Google Apps Script を置き換える
1. Google スプレッドシート → Extensions > Apps Script
2. 既にあるコードをすべて削除
3. `calendar_sync_complete.gs` のコード全体をコピー＆ペースト
4. **重要**：以下の 2 か所を修正

```javascript
// Line ~23 - Kana のメールアドレスを修正
Kana: {
  aliases: ['Kana', '畑中'],
  calendarEmail: 'kanakeyboard7@gmail.com',  // ← ここを修正
  calendarMode: 'availability',
},
// Line ~28 - Sho のメールアドレスを修正
Sho: {
  aliases: ['Sho', '砂川'],
  calendarEmail: 'sho.sunak@gmail.com',     // ← ここを修正
  calendarMode: 'offOnly',
},
```

### ステップ 3: 権限を許可して実行
1. Save をクリック
2. 実行メニューから `onOpen` を選択（初回のみ）
3. 権限確認画面でアカウントを選択 → 許可
4. 実行完了後、Google Sheets のタブに戻る

### ステップ 4: 初回同期を実行
1. Google Sheets に戻る
2. 新しいメニュー「Sync」が表示されているはず
3. 「Sync Calendar Now」をクリック
4. スプレッドシート内の Status が更新される

### ステップ 5: 自動同期トリガーを設定（任意）
定期的に自動同期したい場合：
1. Google Apps Script エディタで左のメニュー「Triggers」をクリック
2. 右下の「Create new trigger」をクリック
3. 設定：
   - Function: `syncCalendarToSheet`
   - Event type: Time-driven
   - Type of time interval: Hour timer
   - Interval: Every hour（またはお好みで）
4. 保存

## 期待される結果
- Kana が Calendar に「09:30～15:00」のイベントを作成した日は、スプレッドシートに「Available」と表示される
- Sho が Calendar に「Off」と書いたイベントを作成した日は、スプレッドシートに「Off」と表示される
- Manual Lock が「TRUE」の行は更新されない

## トラブルシューティング

**Q: 権限エラーが出た**
- Google アカウントに十分な権限（オーナーまたはエディタ）があるか確認

**Q: "Cannot access calendar" というエラーが出た**
- Kana/Sho のメールアドレスが正しいか確認
- そのメールアドレスのカレンダーが共有されているか確認

**Q: Status が更新されない**
- Google Apps Script のエディタで「Execution log」を確認
- "Sync complete. Updated X rows." というメッセージが出ているか確認
- 該当の行の「Manual Lock」が「FALSE」になっているか確認

---

**重要**: Kana と Sho のカレンダーメールアドレスが必要です。これがわからない場合はお知らせください。
