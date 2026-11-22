# Web regression — Gitea milestone
WSL Ubuntu で Docker Desktop の WSL integration を有効にし、bash run.sh を実行してください。
初回は公式イメージと npm パッケージのダウンロードが必要です。ブラウザと Node はテスト用コンテナに含まれます。
実行専用の Compose project を作り、終了時にそのコンテナとボリュームを削除します。ホストにポートを公開しません。
HTML は reports/<実行日時-PID>/html/index.html に残ります。初回成功の目安は 1 passed です。
この版は Gitea の日本語Issue登録とAPI照合のみ。Vikunja、権限テスト、CIは次段階です。
