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

# 公式AWS Emulatorも、接続先を替えて試せる

AWSが公開したローカルエミュレータです。AWS SDKのままAPIを呼び、リクエストは手元のEmulatorへ送ります。

今回は参加者専用Lambda MicroVMに同梱し、設定ファイルのエンドポイントを替えて同じテストを動かします。

IAMポリシーの検証や本番環境の代わりにはなりません。APIごとの再現度を確かめながら使います。

<p class="source-line">AWS公式：<a href="https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html">AWS Emulator</a> ・ <a href="https://docs.aws.amazon.com/emulator/latest/userguide/fidelity.html">Fidelity</a></p>

---
layout: workshop
---

# ローカルでは、Flociを起動してテストを回す

`config/aws-endpoint.json` の接続先をFlociのURLにしておけば、いつものテストコマンドで実行できます。

```json
{ "endpoint": "http://127.0.0.1:4566" }
```

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
exercise: basic
---

# エンドポイントを替えて、AWS Emulatorでも再実行

`config/aws-endpoint.json` のURLを `https://127.0.0.1:9297` に替え、同じテストを実行します。

```bash
sed -i 's#http://127.0.0.1:4566#https://127.0.0.1:9297#' config/aws-endpoint.json
npm run test:idempotency
```

次のテスト実行時にFlociを停止し、AWS Emulatorへ切り替えます。証明書と一時資格情報は自動設定され、同時起動はしません。

AWS Emulatorのリソースはメモリ上にあり、Flociへ戻すとEmulator側の状態は消えます。IAMなどの確認は実AWSで行います。

Flociへ戻すときはURLを `http://127.0.0.1:4566` に戻してから、同じコマンドを実行します。

---
layout: workshop
---

# 終了したら演習環境を停止

「演習を終了してVMを停止」を押して、専用のMicroVMを解放します。

<LeaveWorkshop />

<p class="supporting">持ち帰り：モックの先まで試す／重複実行を前提にする／実AWSでしか分からない条件も確かめる</p>
