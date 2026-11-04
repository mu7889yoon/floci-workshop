---
marp: true
theme: mu7889yoon
paginate: true
size: 16:9
---

<!-- _class: title -->

# テストが緑でも、二重通知してない？

## Flociで見つける、請求CSVバッチの重複実行

JAWS-UG名古屋 / Demo-1グランプリ

---

<!-- _class: column-layout -->

# モックだけで、サービス間のつながりまで試せる？

<div class="column">

### SDKモック

- 関数の分岐と入力を確認
- 外部APIを置き換えやすい
- 連携先との契約は別に確認

</div>

<div class="column">

### 統合テスト

- S3からSNSまで実際につなぐ
- シリアライズや通知も確認
- 再試行で起きる副作用を発見

</div>

---

# Flociなら、AWS SDKはそのまま使える

```text
アプリ ── AWS SDK ──▶ FlociのAWS互換API
```

テスト用の接続先をFlociに向ければ、AWSアカウントを使わずにサービス間の処理を試せます。

---

# 今回追うのは、請求CSVの取り込み経路

```text
S3 ──▶ SQS ──▶ バッチワーカー ──▶ DynamoDB ──▶ SNS
 CSV     取込イベント     最大10件       請求書保存     結果通知
```

失敗したメッセージは再試行し、上限を超えるとDLQへ送ります。

---

# ローカルでは、Flociを起動してテストする

```bash
floci start
FLOCI_URL=http://localhost:4566 npm test
```

アプリのAWS SDKと処理はそのまま。接続先だけをFlociに切り替えます。

---

# SQS標準キューは、同じメッセージを再配信する

```text
同じS3イベント → SQS → ワーカー
                    └── 再配信 → ワーカーがもう一度実行
```

標準キューは少なくとも1回の配信です。処理が完了しても削除できなければ、同じメッセージが再び届くことがあります。

<small>出典：[AWS: SQS標準キューの配信](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)</small>

---

<!-- _class: column-layout -->

# 今回の約束は「取り込み1回から通知1つ」

<div class="column">

### テストに渡すもの

同じS3イベントを、SQSへ2回投入。

ワーカーを実際に動かし、SNSの結果通知を数えます。

</div>

<div class="column">

### 守りたいこと

同じイベントが再配信されても、請求CSVの処理結果を二重に通知しない。

期待する通知数は1件です。

</div>

---

# ここから、Flociのテストを書いてみる

1. [演習ページを開き](https://d5rqyj2cgjt99.cloudfront.net/7)、環境を起動
2. `tests/idempotency.spec.ts` のTODOと `throw` を期待値に置き換える
3. Bashで `npm run test:idempotency` を実行

```ts
expect(summaries).toHaveLength(1)
```

---

# テストは「通知が2件」をつかまえた

```diff
- Expected 1
+ Received 2
```

2026年11月4日の演習環境でも、この結果を確認しました。テスト基盤が壊れたのではなく、同じSQSイベントから通知が二重に送られています。

---

# 同じ請求書IDなら、後から来た金額が残った

```text
1回目のCSV: INV-SAME = 1200
2回目のCSV: INV-SAME = 9999
```

```diff
- Expected 1200
+ Received 9999
```

発展編では、同じIDを持つCSVを続けて取り込み、先に保存した金額が上書きされることを確かめます。

---

<!-- _class: column-layout -->

# 冪等性は、副作用に合わせて守る

<div class="column">

### イベント

イベントIDや業務キーで、処理済みか判定する。

</div>

<div class="column">

### データと通知

DynamoDBの条件付き書き込み、重複排除、Outboxなどを選ぶ。

<p><small>どこで重複を止めるかは、再試行の境界と守りたい副作用で決まります。</small></p>

</div>

---

# モックの先はFlociで、AWS固有の挙動はAWSで確かめる

- モックで関数の分岐を速く確認
- FlociでAWS SDKを使うサービス連携を検証
- IAM、クォータ、AWS固有の配信挙動は実AWSでも確認

FlociはAWSの完全な複製ではありません。ローカルで見つけた問題を、実AWSでの確認につなげます。

<small>参考：[Floci GitHub](https://github.com/floci-io/floci) ・ [Floci公式サイト](https://floci.io/)</small>
