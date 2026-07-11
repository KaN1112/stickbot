# Stickbot GitHub Render

Discord のチャンネルで、指定したメッセージを常に一番下へ置き直す sticky message bot です。
GitHub に置いて Render へデプロイし、招待 URL から複数の Discord サーバーへ導入できます。

## できること

- `/sticky` のスラッシュコマンドで設定できます
- 複数サーバーで利用できます
- チャンネルごとに別々の sticky message を保存できます
- 誰かが投稿したあと、古い sticky message を削除して一番下へ再投稿します
- Render の Web Service として動きます
- `/invite` にアクセスすると bot 招待 URL へ移動します

## Discord 側の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作成します。
2. `Bot` 画面で bot を追加し、token を控えます。
3. `General Information` 画面で `Application ID` を控えます。これを `CLIENT_ID` に使います。

必要な OAuth2 scopes:

- `bot`
- `applications.commands`

必要な bot 権限:

- `View Channels`
- `Send Messages`
- `Manage Messages`
- `Read Message History`

この bot は通常メッセージの中身を読まないため、`Message Content Intent` は不要です。

## ローカル実行

`.env.example` を参考に `.env` を作成します。

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_client_id
MOVE_DELAY_MS=3500
DATA_FILE=data/sticky-messages.json
```

起動します。

```bash
npm install
npm run dev
```

起動したら、ブラウザで以下にアクセスすると招待 URL へ移動します。

```text
http://localhost:3000/invite
```

## Render へデプロイ

1. このフォルダを GitHub リポジトリに push します。
2. Render で `New > Blueprint` を選び、この GitHub リポジトリを接続します。
3. `render.yaml` が読み込まれたら、環境変数を設定します。

必須の環境変数:

- `DISCORD_TOKEN`
- `CLIENT_ID`

Render のサービス URL にアクセスして `{"ok":true,...}` が返れば起動しています。
他サーバーに導入するときは、Render のサービス URL に `/invite` を付けて開いてください。

```text
https://your-service.onrender.com/invite
```

## Discord での使い方

サーバー管理権限を持つ人だけが設定できます。

```text
/sticky set message:表示したい文章
```

今いるチャンネルに sticky message を設定します。設定後、bot がその文章を一番下へ投稿します。

```text
/sticky unset
```

今いるチャンネルの sticky message を解除します。

```text
/sticky move
```

今いるチャンネルの sticky message を手動で一番下へ置き直します。

```text
/sticky preview
```

今いるチャンネルに設定されている sticky message を確認します。

```text
/sticky list
```

そのサーバーで sticky message が設定されているチャンネルを一覧表示します。

## 複数サーバーで使う流れ

1. bot の `/invite` URL を相手サーバーの管理者へ渡します。
2. 管理者が自分のサーバーへ bot を招待します。
3. sticky message を置きたいチャンネルで `/sticky set` を実行します。
4. 以後、そのチャンネルで投稿があるたびに sticky message が一番下へ戻ります。

## スラッシュコマンドが出ないとき

グローバルのスラッシュコマンドは Discord 側に反映されるまで少し時間がかかることがあります。
また、古い招待 URL で導入した場合は `applications.commands` scope が付いていない可能性があります。その場合は `/invite` から招待し直してください。

## 保存について

設定は `DATA_FILE` で指定した JSON ファイルに保存されます。標準では `data/sticky-messages.json` です。

Render の無料 Web Service はファイル保存が永続ではない場合があります。再デプロイや再起動後も確実に設定を残したい場合は、Render Disk を使って `DATA_FILE` をディスク内のパスにするか、データベース保存に変更してください。

## 注意

Render の無料 Web Service は一定時間アクセスがないとスリープする場合があります。スリープ中は Discord の投稿を処理できません。常時稼働が必要な場合は、有料プランや外部監視による定期アクセスを検討してください。
