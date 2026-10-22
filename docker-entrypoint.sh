#!/bin/sh
# 容器入口：先以 root 修正数据目录属主，再降权到 PUID:PGID 运行应用。
#
# 为什么需要这一步：宿主机上的数据目录可能是 root 或其它 uid 建的
# （Docker 自动创建 bind mount 目录时就是 root:root 755），而容器里的进程
# 不是 root，于是 SQLite 报 "unable to open database file"、容器起不来。
# 由 root 在启动瞬间修一次属主，用户就不用去 NAS 上手动 chown。
set -e

DATA_DIR="$(dirname "${DB_PATH:-/data/assets.db}")"
PUID="${PUID:-1001}"
PGID="${PGID:-1001}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true

  if chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null; then
    # -R 会连带子目录（backups/），避免备份写入失败
    if ! setpriv --reuid "$PUID" --regid "$PGID" --clear-groups test -w "$DATA_DIR" 2>/dev/null; then
      echo "[entrypoint] 数据目录 $DATA_DIR 对 uid=$PUID 仍不可写，尝试放宽权限" >&2
      chmod -R u+rwX "$DATA_DIR" 2>/dev/null || true
    fi
    exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups "$@"
  fi

  echo "[entrypoint] 警告：无法修改 $DATA_DIR 的属主（可能是只读挂载或网络盘），改为以 root 运行" >&2
  exec "$@"
fi

# 已经是非 root（例如 compose 里指定了 user:），直接运行，权限问题交给日志暴露
exec "$@"
