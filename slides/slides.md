---
theme: default
title: AWSなしでAWSを統合テスト!? Flociを触ってみよう
aspectRatio: 16/9
monaco: true
layout: workshop
---

# AWSなしでAWSを統合テスト!?

## Flociで重複実行に強いテストを書く

JAWS-UG名古屋 / Demo-1グランプリ

<small>ローカルテストの悩み → Floci → AWS構成 → テストを書く</small>

---
layout: workshop
---

# ローカルのテスト、どう回していますか？

SDKをモックすれば関数単体の動きは確認できます。でも、S3イベントからSQS、DynamoDB、SNSまでつながったときの振る舞いは、モックだけでは分かりません。

毎回AWSへ接続するテストは、費用・待ち時間・共有環境の片付けも気になります。

---
layout: workshop
---

# FlociはAWS互換APIをローカルで動かすエミュレータ

アプリは普段のAWS SDKを使い、接続先だけFlociに向けます。AWSアカウントを使わず、AWSサービス間のつながりをローカルで試せます。

FlociはAWSの完全な複製ではありません。IAM、クォータ、実AWS固有の挙動は、別の確認が必要です。

<p class="source-line">公式情報：<a href="https://github.com/floci-io/floci">Floci GitHub</a> ・ <a href="https://floci.io/">floci.io</a></p>

---
layout: workshop
---

# ローカルでは、Flociを起動してテストを回す

<div class="command-flow">
  <code>floci start</code>
  <span>→</span>
  <code>FLOCI_URL=http://localhost:4566 npm test</code>
</div>

AWS SDKとアプリの処理はそのまま。テスト用のAWSサービスをFlociに向けて、開発機やCIで同じ統合テストを実行します。

---
layout: workshop
---

# 今回のデモで使うAWS構成

<div class="architecture">
  <div class="architecture-main">
    <span class="service">S3<br><small>請求CSV</small></span>
    <span class="arrow">→</span>
    <span class="service">SQS<br><small>取込キュー</small></span>
    <span class="arrow">→</span>
    <span class="service">バッチワーカー<br><small>最大10件</small></span>
    <span class="arrow">→</span>
    <span class="service">DynamoDB<br><small>請求書</small></span>
    <span class="arrow">→</span>
    <span class="service">SNS<br><small>結果通知</small></span>
  </div>
  <div class="architecture-note">処理に失敗したSQSメッセージは再試行され、上限を超えるとDLQへ</div>
</div>

この一連の経路をFloci上に作り、実際のAWS SDKを使うテストで確かめます。

---
layout: workshop
---

# 同じメッセージがもう一度届くことがある

SQS標準キューは少なくとも1回の配信です。処理後に削除できなかった場合など、同じメッセージが再配信され、ワーカーがもう一度動くことがあります。

請求の二重計上、通知の二重送信、同じレコードの意図しない上書きにつながります。

<p class="source-line">AWS公式：<a href="https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html">SQS at-least-once delivery</a></p>

---
layout: workshop
---

# 1つの取り込みから、結果通知は1つ

今回の約束は「同じS3イベントがSQSから2回来ても、請求CSVの処理結果を二重に通知しない」です。

Flociに同じSQSイベントを2回渡し、SNS通知が重複する問題をテストで見つけます。

<JoinWorkshop />

---
layout: workshop
exercise: basic
---

# ここから、Flociのテストコードを書きます

`tests/idempotency.spec.ts` のTODOと `throw` を `expect(summaries).toHaveLength(1)` に置き換えてください。

右のBashで `npm run test:idempotency` を実行します。`Expected 1 / Received 2` が二重通知の検知です。

---
layout: workshop
exercise: advanced
---

# 同じ請求書IDが再登場したら？

同じ請求書IDのCSVを再投入し、保存済み金額が変わらないことをテストします。

`tests/advanced.spec.ts` のTODOを `expect(saved?.amountCents).toBe(1200)` に置き換え、`npm run test:advanced` を実行。9999円なら後続処理の上書きです。

---
layout: workshop
---

# テストが教えるのは、二重実行を前提にすること

実務では、何を重複させたくないかに応じて冪等キー、条件付き書き込み、重複排除、Outboxなどを選びます。

Flociで速く確かめ、IAM・ネットワーク・クォータなどFlociが再現しない条件はAWSでも確認します。

---
layout: workshop
---

# 終了したら演習環境を停止

「演習を終了してVMを停止」を押して、専用のMicroVMを解放します。

<LeaveWorkshop />

<p class="supporting">持ち帰り：モックの先まで試す／重複実行を前提にする／実AWSでしか分からない条件も確かめる</p>
