---
theme: default
title: AWS統合テストをローカルで高速化する
aspectRatio: 16/9
monaco: true
layout: workshop
---

# AWS統合テストをローカルで高速化する

## FlociとAWS Emulatorで、重複実行に備える

JAWS-UG名古屋 / Demo-1グランプリ

<small>ローカルテストの課題 / エミュレータの選択 / 重複実行の検証</small>

---
layout: workshop
---

# モックだけでは、AWSサービス間の契約を検証できない

SDKをモックすれば、関数単体の分岐は確認できます。一方、S3イベントからSQS、DynamoDB、SNSまでつながったときの振る舞いは、モックだけでは分かりません。

AWSへ毎回デプロイするテストは、待ち時間、共有環境の準備と片付けが必要です。

---
layout: workshop
---

# FlociはAWS互換APIをローカルに提供する

Flociは、AWS互換APIをローカルで提供するオープンソースのエミュレータです。AWS SDKやCLIの接続先をFlociに向け、S3・SQS・DynamoDB・SNSの連携を手元で試せます。

AWSアカウントや認証トークンを使わずに起動できます。サービスごとに再現範囲が異なるため、IAM・クォータ・AWS固有の挙動は実AWSでも確認します。

<p class="source-line">Floci公式：<a href="https://github.com/floci-io/floci">GitHub</a> ・ <a href="https://floci.io/floci/">概要と利用方法</a></p>

---
layout: workshop
---

# AWS EmulatorはAWS公式のローカル検証環境

2026年11月11日に提供が始まりました。AWS CLIやAWS SDKの呼び出しを、ローカルのHTTPSエンドポイントへ送ります。

起動時に認証情報と証明書が発行され、リソース状態は停止するまでメモリ上に保持されます。未対応APIは `501 NotImplemented` を返します。

サービスごとの再現度は公開Fidelityで確認できます。IAMポリシー、リソースポリシー、クロスアカウント、クロスリージョンなどのセキュリティ検証は実AWSで行います。

<p class="source-line">AWS公式：<a href="https://aws.amazon.com/about-aws/whats-new/2026/11/aws-emulator-now-available/">提供開始</a> ・ <a href="https://docs.aws.amazon.com/emulator/latest/userguide/fidelity.html">Fidelity</a></p>

---
layout: workshop
---

# FlociとAWS Emulatorは、再現方式が異なる

<div class="comparison-grid">
  <section class="comparison-card">
    <h3>Floci</h3>
    <p><strong>立ち位置</strong>　コミュニティのOSS（MIT）</p>
    <p><strong>接続先</strong>　HTTP · <code>localhost:4566</code></p>
    <p><strong>特徴</strong>　複数サービスをまとめてローカルで動かし、保存方式も選べる</p>
    <p class="comparison-note">APIやサービスごとに再現範囲を確認</p>
  </section>
  <section class="comparison-card">
    <h3>AWS Emulator</h3>
    <p><strong>立ち位置</strong>　AWS公式 · CC0</p>
    <p><strong>接続先</strong>　HTTPS · <code>localhost:9297</code></p>
    <p><strong>特徴</strong>　AWS APIモデルを基に実装し、Fidelityを公開</p>
    <p class="comparison-note">未対応APIは501。状態はメモリ上に保持</p>
  </section>
</div>

用途とAPIの再現範囲に合わせて選びます。AWS EmulatorはAPIごとに再現度が異なり、セキュリティ検証は実AWSで行います。

<p class="source-line"><a href="https://github.com/floci-io/floci">Floci公式リポジトリ</a> ・ <a href="https://docs.aws.amazon.com/emulator/latest/userguide/fidelity.html">AWS Emulator Fidelity</a></p>

---
layout: workshop
---

# ローカルFlociで、AWS統合テストを速く回す

アプリのコードとAWS SDKはそのまま使い、接続先だけを `config/aws-endpoint.json` で切り替えます。

```json
{ "endpoint": "http://127.0.0.1:4566" }
```

AWSアカウントやクラウド上のテスト資源を用意せず、開発機やCIで同じ経路を繰り返し検証できます。イベントの変換、サービス間連携、再試行、二重通知などの不具合を、デプロイ前に素早く見つけられます。

<p class="supporting">IAM・クォータ・AWS固有の挙動は、実AWSで別に確認します。</p>

---
layout: workshop
---

# 請求CSVの取り込みを、AWSサービス間の経路で検証する

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

<p class="source-line">アイコン：<a href="https://aws.amazon.com/architecture/icons/">AWS Architecture Icons · Q3 2026</a></p>

---
layout: workshop
---

# SQS標準キューは、同じメッセージを複数回届ける

標準キューは少なくとも1回の配信です。処理後に削除されなかった場合など、同じメッセージが再配信されます。

<ol class="challenge-list">
  <li><strong>再配信</strong>　同じメッセージがもう一度届く</li>
  <li><strong>並行実行</strong>　2つのワーカーが同じイベントを処理しても、副作用は1回にする</li>
  <li><strong>追加課題</strong>　請求書の上書きやバッチの部分失敗を検証する</li>
</ol>

<p class="source-line">AWS公式：<a href="https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html">SQS at-least-once delivery</a></p>

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

# 再配信と並行実行で、通知の重複を検出する

`tests/idempotency.spec.ts` の2つのTODOを `expect(summaries).toHaveLength(1)` に置き換えます。片方は再配信、もう片方は2つのワーカーによる同時処理です。

右のBashで `npm run test:idempotency` を実行します。`Expected 1 / Received 2` は二重通知を示します。

---
layout: workshop
exercise: advanced
---

# 同じ請求書IDの再取り込みが、保存済み金額を上書きする

同じ請求書IDのCSVを再投入し、保存済み金額が変わらないことをテストします。

`tests/advanced.spec.ts` のTODOを `expect(saved?.amountCents).toBe(1200)` に置き換え、`npm run test:advanced` を実行。9999円なら後続処理の上書きです。

---
layout: workshop
exercise: advanced
---

# バッチの部分失敗でも、成功分の処理を継続する

正常CSVと不正CSVを同じSQSバッチで処理し、成功分は保存・通知され、失敗分だけが再試行されるかを確認します。

`npm run test:advanced` を続けて実行し、最初の上書き検知と部分失敗時の挙動を見比べてください。

---
layout: workshop
---

# 冪等性は、業務キーと副作用の境界で設計する

実務では、何を重複させたくないかに応じて冪等キー、条件付き書き込み、重複排除、Outboxなどを選びます。

Flociで速く確かめ、IAM・ネットワーク・クォータなどFlociが再現しない条件はAWSでも確認します。

---
layout: workshop
exercise: basic
---

# AWS Emulatorでは、APIごとの再現度を確認する

`config/aws-endpoint.json` のURLを `https://127.0.0.1:9297` に替え、同じテストを実行します。未対応APIは `501 NotImplemented` になるため、対象サービスのFidelityも確認します。

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

# 演習環境を終了し、MicroVMを解放する

「演習を終了してVMを停止」を押して、専用のMicroVMを解放します。

<LeaveWorkshop />

<p class="supporting">持ち帰り：モックの先まで試す／重複実行を前提にする／実AWSでしか分からない条件も確かめる</p>
