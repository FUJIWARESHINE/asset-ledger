"""灌入一套示例数据：多平台 · 每平台多账号 · 每账号多资产。

数据全是虚构的，只为演示界面效果，不含任何真实账号信息。

用法：
    python seed.py                       # 默认写本机 127.0.0.1:8787
    python seed.py --base http://<host>:8787
    python seed.py --replace             # 先清空再灌
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import urllib.error
import urllib.request

ACCOUNTS = [
    {"platform": "GitHub", "name": "acme-dev", "label": "主力号", "url": "https://github.com/acme-dev", "credential_hint": "Vaultwarden › GitHub 主力"},
    {"platform": "GitHub", "name": "acme-lab", "label": "实验号", "url": "https://github.com/acme-lab"},
    {"platform": "GitHub", "name": "acme-bot", "label": "CI 机器人", "url": "https://github.com/acme-bot"},
    {"platform": "Cloudflare", "name": "admin@example.com", "label": "主账号", "url": "https://dash.cloudflare.com", "credential_hint": "Vaultwarden › Cloudflare"},
    {"platform": "Cloudflare", "name": "ops@example.org", "label": "备用号", "url": "https://dash.cloudflare.com", "notes": "只放测试域名"},
    {"platform": "Vercel", "name": "acme-dev", "label": "Hobby 计划", "url": "https://vercel.com/dashboard"},
    {"platform": "搬瓦工", "name": "acme-vps", "label": "生产 VPS", "credential_hint": "Vaultwarden › 搬瓦工"},
    {"platform": "阿里云", "name": "acme-cn", "label": "域名注册", "url": "https://account.aliyun.com"},
]

TODAY = dt.date.today()


def day(offset: int) -> str:
    return (TODAY + dt.timedelta(days=offset)).isoformat()


ASSETS = [
    # GitHub 主力号
    {"platform": "GitHub", "account": "acme-dev", "name": "demo-web", "category": "repo", "url": "https://github.com/acme-dev/demo-web", "tags": "主力", "notes": "前端主站"},
    {"platform": "GitHub", "account": "acme-dev", "name": "infra-scripts", "category": "repo", "url": "https://github.com/acme-dev/infra-scripts", "tags": "自研", "notes": "部署与备份脚本"},
    {"platform": "GitHub", "account": "acme-dev", "name": "photo-tools", "category": "repo", "url": "https://github.com/acme-dev/photo-tools", "notes": "批量处理小工具"},
    {"platform": "GitHub", "account": "acme-dev", "name": "notes", "category": "repo", "url": "https://github.com/acme-dev/notes"},
    # GitHub 实验号
    {"platform": "GitHub", "account": "acme-lab", "name": "demo-app", "category": "repo", "url": "https://github.com/acme-lab/demo-app", "tags": "试验", "notes": "移动端 Demo"},
    {"platform": "GitHub", "account": "acme-lab", "name": "ocr-playground", "category": "repo", "notes": "临时试验，已停更"},
    # CI 机器人
    {"platform": "GitHub", "account": "acme-bot", "name": "release-bot", "category": "repo", "notes": "自动打 tag 用"},

    # Cloudflare 主账号
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "example.com", "category": "domain", "url": "https://example.com", "expires_at": day(23), "auto_renew": True, "cost": 68, "cycle": "yearly", "tags": "主力", "notes": "注册商 Namecheap，CF 托管 DNS", "pinned": True},
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "blog.example.com", "category": "subdomain", "url": "https://blog.example.com", "expires_at": day(23), "notes": "CNAME → Vercel"},
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "api.example.com", "category": "subdomain", "url": "https://api.example.com", "expires_at": day(23), "notes": "反代到 VPS"},
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "edge-proxy", "category": "worker", "url": "https://edge-proxy.demo.workers.dev", "notes": "轻量反代，免费额度 10 万次/天"},
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "docs-site", "category": "pages", "url": "https://docs-site.pages.dev", "notes": "GitHub 自动部署"},
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "对象存储桶", "category": "storage", "url": "https://img.example.com", "cost": 15, "cycle": "monthly", "tags": "图床"},
    {"platform": "Cloudflare", "account": "admin@example.com", "name": "CF 主账号本身", "category": "account", "expires_at": day(320), "credential_hint": "Vaultwarden › Cloudflare", "notes": "2FA 已开，恢复码也存 Vaultwarden", "tags": "核心账号"},
    # Cloudflare 备用号
    {"platform": "Cloudflare", "account": "ops@example.org", "name": "example.org", "category": "domain", "url": "https://example.org", "expires_at": day(4), "cost": 12.5, "currency": "USD", "cycle": "yearly", "tags": "备用", "provider": "dpdns", "provider_account": "ops@example.org"},
    {"platform": "Cloudflare", "account": "ops@example.org", "name": "img.example.org", "category": "subdomain", "url": "https://img.example.org", "notes": "图床入口", "provider": "dpdns", "provider_account": "ops@example.org"},
    {"platform": "Cloudflare", "account": "ops@example.org", "name": "shortlink", "category": "worker", "notes": "短链跳转"},
    {"platform": "Cloudflare", "account": "ops@example.org", "name": "status-page", "category": "pages", "notes": "状态页"},

    # Vercel
    {"platform": "Vercel", "account": "acme-dev", "name": "demo-web", "category": "vercel", "url": "https://demo-web.vercel.app", "notes": "关联 GitHub 仓库"},
    {"platform": "Vercel", "account": "acme-dev", "name": "docs-site", "category": "vercel", "url": "https://docs-site.vercel.app", "tags": "文档"},
    {"platform": "Vercel", "account": "acme-dev", "name": "asset-ledger", "category": "vercel", "url": "https://asset-ledger.vercel.app", "tags": "本项目", "notes": "资产统计面板"},

    # 服务器 / 域名
    {"platform": "搬瓦工", "account": "acme-vps", "name": "香港 CN2 VPS", "category": "server", "expires_at": day(-2), "cost": 49.99, "currency": "USD", "cycle": "yearly", "tags": "生产", "notes": "跑 docker 服务，续费前先备份"},
    {"platform": "阿里云", "account": "acme-cn", "name": "example.net", "category": "domain", "url": "https://example.net", "expires_at": day(-9), "cost": 55, "cycle": "yearly", "tags": "待处理", "notes": "已过期，需决定是否续费"},
    {"platform": "阿里云", "account": "acme-cn", "name": "备案信息", "category": "other", "notes": "到期前记得更新"},
]


def post(base: str, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()[:300]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8787")
    ap.add_argument("--replace", action="store_true")
    args = ap.parse_args()

    result = post(args.base, "/api/import", {
        "mode": "replace" if args.replace else "merge",
        "accounts": ACCOUNTS,
        "assets": ASSETS,
    })
    print("imported assets:", result["inserted"], "accounts created:", result["accounts_created"])

    with urllib.request.urlopen(args.base + "/api/tree", timeout=20) as resp:
        tree = json.loads(resp.read())

    print(f"\n{len(tree['platforms'])} 个平台 · {tree['account_count']} 个账号 · {tree['asset_count']} 项资产")
    for p in tree["platforms"]:
        print(f"  [{p['platform']}] {p['account_count']} 账号 / {p['asset_count']} 资产 / 年化 ¥{p['yearly_cost']:.0f}")
        for a in p["accounts"]:
            print(f"      · {a['name']:<22} {a['asset_count']:>2} 项")


if __name__ == "__main__":
    main()
