#!/usr/bin/env bash
# Oracle Cloud（Always Free の Ampere A1 / Ubuntu 22.04・24.04）にエッジ分析サーバーを構築する。
# 使い方: EDGE_DOMAIN=edge.example.com ALLOWED_ORIGIN=https://lotsizings.netlify.app sudo -E bash setup.sh
set -euo pipefail

: "${EDGE_DOMAIN:?EDGE_DOMAIN を指定してください（例 141-147-1-2.sslip.io）}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-*}"
REPO_URL="${REPO_URL:-https://github.com/ozawakota/lotSizing-app.git}"
APP_DIR=/opt/lotsizing-app

# Node.js 22 と Caddy
apt-get update
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# ソース取得と依存インストール
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO_URL" "$APP_DIR"; fi
chown -R ubuntu:ubuntu "$APP_DIR"
sudo -u ubuntu bash -c "cd $APP_DIR/edge-server && npm install --omit=dev"

# 環境変数・systemd・Caddy
cat > /etc/edge-server.env <<ENV
PORT=8787
HOST=127.0.0.1
DATA_DIR=$APP_DIR/edge-server/data
ALLOWED_ORIGIN=$ALLOWED_ORIGIN
ENV
cp "$APP_DIR/edge-server/deploy/edge-server.service" /etc/systemd/system/
cp "$APP_DIR/edge-server/deploy/Caddyfile" /etc/caddy/Caddyfile
echo "EDGE_DOMAIN=$EDGE_DOMAIN" > /etc/default/caddy
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' > /etc/systemd/system/caddy.service.d/env.conf

# OCI の Ubuntu イメージは iptables で 80/443 を塞いでいるので開ける（VCN のセキュリティリストも別途開放が必要）
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
netfilter-persistent save

systemctl daemon-reload
systemctl enable --now edge-server
systemctl restart caddy
echo "完了: https://$EDGE_DOMAIN/health を確認してください（初回の過去データ取得に数十分かかります）"
