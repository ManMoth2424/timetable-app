# 時間割共有サービス

2-1〜2-9のクラスごとに時間割を共有・編集できるWebアプリです。
Node.js + Express + PostgreSQL(Render)で動作します。

## 権限モデル

- `admin`: 全クラスの閲覧・編集、ユーザー管理が可能
- `editor`: 割り当てられたクラスのみ閲覧・編集可能
- `viewer`: 割り当てられたクラスのみ閲覧可能

ログインしていない人はどのページも見られません。

## ローカルでの動作確認

1. Node.js(18以上推奨)をインストール
2. 依存パッケージをインストール
   ```
   npm install
   ```
3. `.env.example` をコピーして `.env` を作成し、値を編集
   ```
   cp .env.example .env
   ```
   `DATABASE_URL` はローカルのPostgreSQL、またはRenderのPostgreSQLの接続文字列を指定します。
4. データベースを初期化(テーブル作成+管理者アカウント作成)
   ```
   npm run init-db
   ```
   `ADMIN_USERNAME` / `ADMIN_PASSWORD` で指定した管理者アカウントが作成されます。
5. サーバーを起動
   ```
   npm start
   ```
6. ブラウザで `http://localhost:3000` を開き、管理者アカウントでログイン

## Renderへのデプロイ手順

### 方法A: render.yaml を使う(おすすめ・自動)

1. このフォルダの中身をGitHubリポジトリにpush
2. Renderにログイン → 「New +」→「Blueprint」
3. リポジトリを選択すると `render.yaml` が自動検出され、
   Webサービスとデータベースがまとめて作成される
4. `ADMIN_PASSWORD` を要求されるので、初期管理者パスワードを入力
5. デプロイ完了後、Renderの「Shell」タブ(または一時的にStart CommandをinitDBに変更)から
   ```
   npm run init-db
   ```
   を1回実行してテーブル作成・管理者作成を行う

### 方法B: 手動で作成する

1. Renderで「New +」→「PostgreSQL」を作成し、`Internal Database URL` を控える
2. 「New +」→「Web Service」を作成し、このリポジトリを接続
   - Build Command: `npm install`
   - Start Command: `npm start`
3. 環境変数(Environment)に以下を設定
   - `DATABASE_URL`: 手順1で控えた接続文字列
   - `PGSSL`: `true`
   - `SESSION_SECRET`: 適当なランダム文字列
   - `ADMIN_USERNAME`: 任意の管理者ID
   - `ADMIN_PASSWORD`: 任意の初期パスワード
4. デプロイ後、Renderの「Shell」タブで `npm run init-db` を実行

## 運用の流れ

1. 管理者アカウントでログイン
2. 「ユーザー管理」画面で、担当者(editor)・閲覧者(viewer)のアカウントを作成
   - 1人に複数クラスを割り当て可能
3. 各担当者は自分のアカウントでログインし、担当クラスの時間割を編集
4. 閲覧者は割り当てられたクラスの時間割を閲覧のみ可能

## セキュリティ上の注意

- 初期パスワードは必ず個別に伝え、使い回さないようにしてください
- 本番運用では `SESSION_SECRET` を推測されにくい値にしてください
- 必要に応じて、ユーザーが自分でパスワードを変更できる機能を追加することをおすすめします(現状は管理者のみが再設定可能)
