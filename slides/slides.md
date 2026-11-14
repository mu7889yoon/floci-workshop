---
theme: default
title: 統合テストをAWSなしで実行してみよう
aspectRatio: 16/9
monaco: true
layout: workshop
---

### JAWS-UG名古屋 / Demo-1グランプリ

# 統合テストをAWSなしで実行してみよう

### Yuta Nakamura / よ〜ん

---
layout: workshop
---

# ローカルテストのありがたみ

SDKをモックすれば、関数単体の分岐は確認できます。一方、S3イベントからSQS、DynamoDB、SNSまでつながったときの振る舞いは、モックだけでは分かりません。

AWSへ毎回デプロイするテストは、待ち時間、共有環境の準備と片付けが必要です。

---
layout: workshop
---

# Floci とは

- AWS互換APIをローカルで提供するOSSのエミュレータ
  - AWS SDKやCLIの接続先をFlociに向けることでエミュレート可能
- AWSアカウントや認証トークン不要
  - IAM・クォータなどの挙動は実環境で確認

---
layout: workshop
---

# AWS Emulator とは

- 2026年11月11日リリース
  - AWS CLIやAWS SDKの接続先をAWS Emulatorに向けることでエミュレート可能
- 起動時に認証情報と証明書が発行され、リソース状態は停止するまでメモリ上に保持
  - 未対応APIは `501 NotImplemented` を返す

- IAMポリシー、リソースポリシー、クロスアカウント、クロスリージョンなどのセキュリティ検証は実環境で確認

---
layout: workshop
---

# Floci と AWS Emulator

<div class="comparison-grid">
  <section class="comparison-card">
    <h3>Floci</h3>
    <p><strong>開発元</strong>　Community MIT license</p>
    <p><strong>接続先</strong>　HTTP</p>
    <p><strong>特徴</strong>　複数サービスをまとめてローカルで動かし、保存方式も選べる</p>
    <p class="comparison-note">APIやサービスごとに再現範囲を確認</p>
  </section>
  <section class="comparison-card">
    <h3>AWS Emulator</h3>
    <p><strong>開発元</strong>　AWS CC0</p>
    <p><strong>接続先</strong>　HTTPS</p>
    <p><strong>特徴</strong>　AWS APIモデルを基に実装し、Fidelityを公開</p>
    <p class="comparison-note">未対応APIは501。状態はメモリ上に保持</p>
  </section>
</div>

---
layout: workshop
---

# テストする構成

<div class="architecture">
  <div class="architecture-main">
    <div class="architecture-service"><img src="/aws-icons/s3.svg" alt="Amazon S3" /><strong>Amazon S3</strong><small>請求CSV</small></div>
    <span class="arrow">→</span>
    <div class="architecture-service"><img src="/aws-icons/sqs.svg" alt="Amazon SQS" /><strong>Amazon SQS</strong><small>取込イベント</small></div>
    <span class="arrow">→</span>
    <div class="architecture-service"><img src="/aws-icons/lambda.svg" alt="AWS Lambda" /><strong>AWS Lambda</strong><small>最大10件を処理</small></div>
    <span class="arrow">→</span>
    <div class="architecture-service"><img src="/aws-icons/dynamodb.svg" alt="Amazon DynamoDB" /><strong>Amazon DynamoDB</strong><small>請求書</small></div>
    <span class="arrow">→</span>
    <div class="architecture-service"><img src="/aws-icons/sns.svg" alt="Amazon SNS" /><strong>Amazon SNS</strong><small>結果通知</small></div>
  </div>
  <div class="architecture-note">失敗メッセージは再試行し、上限を超えるとDLQへ</div>
</div>

この一連の経路をFloci上で動かし、AWS SDKを使った統合テストで確かめます。

---
layout: workshop
---

# テストしたい機能

SQS標準キューは**少なくとも1回の配信**、処理後に削除されなかった場合など、同じメッセージが再配信されます。

- 再配信
  - 同じメッセージがもう一度受信した時の処理
- 重複実行
  - 同じイベントを同時に処理しても、副作用は1回になっているか
- 例外処理
  - 上書きやバッチの失敗を検証する

---
layout: workshop
---

# 同じ取り込みから出す結果通知を1件に保つ

同じS3イベントがSQSから再配信されても、請求CSVの処理結果を二重に通知しません。

逐次再配信と同時実行の両方で、SNS通知が1件に保たれることをテストします。

<JoinWorkshop />

---
layout: workshop
exercise: basic
---

# 再配信と重複実行

2つのTODOを `expect(summaries).toHaveLength(1)` に置き換えます。1つは再配信、もう1つは同時処理です。

`npm run test:idempotency` を実行し、`Expected 1 / Received 2` は二重通知を示します。

---
layout: workshop
exercise: advanced
---

# 上書き

同じIDのCSVを再投入し、保存済み金額が変わらないことをテストします。

TODOを `expect(saved?.amountCents).toBe(1200)` に置き換え、`npm run test:advanced` を実行。9999円なら後続処理の上書きです。

---
layout: workshop
exercise: advanced
---

# 例外処理

正常CSVと不正CSVを処理し、成功分は保存・通知され、失敗分だけが再試行されるかを確認します。

`npm run test:advanced` を続けて実行し、最初の上書き検知と部分失敗時の挙動を見比べてください。

---
layout: workshop
exercise: basic
---

# AWS Emulatorでもやってみる


```bash
sed -i 's#http://127.0.0.1:4566#https://127.0.0.1:9297#' config/aws-endpoint.json
```
を実行し、エンドポイントをFlociからAWS Emulatorへ切り替えます

`npm run test:idempotency`

---
layout: workshop
---

# 演習環境を終了し、MicroVMを解放する

「演習を終了してVMを停止」を押して、専用のMicroVMを解放します。

<LeaveWorkshop />
