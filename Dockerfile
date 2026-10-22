# ---- 资产统计 · 单容器镜像 ----
FROM python:3.12-slim

# 国内构建默认走清华源，海外可用 --build-arg PIP_INDEX_URL=https://pypi.org/simple 覆盖
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DB_PATH=/data/assets.db \
    TZ=Asia/Shanghai \
    PUID=1001 \
    PGID=1001

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -i "$PIP_INDEX_URL" -r requirements.txt

COPY app ./app
COPY static ./static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# 入口脚本以 root 启动：修正 bind mount 目录属主后，用 setpriv 降权到 PUID:PGID 运行。
# 这样宿主上的 data 目录无论是谁建的（Docker 自动创建的通常是 root:root），
# 都不会再出现 "unable to open database file"。
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh ; \
    chmod +x /usr/local/bin/docker-entrypoint.sh ; \
    (groupadd -g 1001 appuser || true) ; \
    (useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin appuser || true) ; \
    mkdir -p /data && chown -R 1001:1001 /data /app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3).status==200 else 1)"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787", "--log-level", "warning"]
