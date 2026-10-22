# ---- 资产统计 · 单容器镜像 ----
FROM python:3.12-slim

# 国内构建默认走清华源，海外可用 --build-arg PIP_INDEX_URL=https://pypi.org/simple 覆盖
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DB_PATH=/data/assets.db \
    TZ=Asia/Shanghai

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -i "$PIP_INDEX_URL" -r requirements.txt

COPY app ./app
COPY static ./static

# 与常见 NAS 首个用户（uid 1001）对齐，避免挂载目录写入失败
RUN groupadd -g 1001 appuser 2>/dev/null || true \
 && useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin appuser 2>/dev/null || true \
 && mkdir -p /data && chown -R 1001:1001 /data /app

USER 1001:1001

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3).status==200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787", "--log-level", "warning"]
