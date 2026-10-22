"""云资产统计 · 后端 (FastAPI + SQLite 单文件)

数据模型：平台 → 账号 → 资产（三级台账）

- **账号是唯一归属主体**：一个平台下可以有任意多个账号（GitHub 5-6 个、Cloudflare 多个）。
- 平台不做独立表，由账号的 platform 字段归一后聚合，避免同一份数据两处维护。
- 资产通过 `account_id` 挂在账号下；未归属的资产落到「未归类 / 未归属」分组。
- 资产表里冗余保存 platform / account 两个文本字段，仅作为导出与旧数据兼容用的投影，
  写入时始终由账号反推，保证不会出现两处不一致。
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = Path(os.environ.get("DB_PATH", BASE_DIR / "data" / "assets.db"))
APP_PASSWORD = os.environ.get("APP_PASSWORD", "").strip()
APP_TITLE = os.environ.get("APP_TITLE", "资产统计").strip() or "资产统计"

# 定时备份：快照落在库文件同级的 backups/ 目录（容器里就是挂载卷内的 data/backups）
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", DB_PATH.parent / "backups"))
BACKUP_NAME_RE = re.compile(r"^assets-\d{8}-\d{6}(?:-\d+)?\.db$")
BACKUP_INTERVALS = (6, 12, 24, 72, 168)  # 6 小时 / 12 小时 / 1 天 / 3 天 / 7 天
BACKUP_DEFAULTS: dict[str, Any] = {"enabled": True, "interval_hours": 24, "keep": 7, "last_at": ""}
BACKUP_TICK = 300  # 后台每 5 分钟看一次是否到期

CATEGORIES = [
    {"id": "domain",    "label": "域名",        "icon": "globe",   "color": "#0A84FF", "color_dark": "#4AA8FF"},
    {"id": "subdomain", "label": "二级域名",    "icon": "link",    "color": "#5E5CE6", "color_dark": "#8E8CF5"},
    {"id": "repo",      "label": "仓库 / 项目", "icon": "repo",    "color": "#3B4252", "color_dark": "#C9D1E0"},
    {"id": "vercel",    "label": "Vercel 项目", "icon": "tri",     "color": "#2C2C30", "color_dark": "#F2F2F7"},
    {"id": "worker",    "label": "Workers",     "icon": "bolt",    "color": "#E08600", "color_dark": "#FFB340"},
    {"id": "pages",     "label": "Pages",       "icon": "file",    "color": "#E07A00", "color_dark": "#FFA94D"},
    {"id": "server",    "label": "服务器 / VPS", "icon": "server",  "color": "#22A94A", "color_dark": "#30D158"},
    {"id": "storage",   "label": "存储 / 图床",  "icon": "box",     "color": "#1FA8D8", "color_dark": "#64D2FF"},
    {"id": "account",   "label": "账号 / 订阅",  "icon": "key",     "color": "#A63FDB", "color_dark": "#BF5AF2"},
    {"id": "other",     "label": "其他",        "icon": "dot",     "color": "#7A7F8E", "color_dark": "#9AA0B0"},
]
CATEGORY_IDS = {c["id"] for c in CATEGORIES}

STATUSES = [
    {"id": "active", "label": "运行中"},
    {"id": "paused", "label": "已暂停"},
    {"id": "archived", "label": "已归档"},
]

CYCLES = [
    {"id": "none", "label": "不计费"},
    {"id": "monthly", "label": "按月"},
    {"id": "yearly", "label": "按年"},
    {"id": "once", "label": "一次性"},
]

ENVIRONMENTS = [
    {"id": "prod", "label": "生产"},
    {"id": "staging", "label": "预发"},
    {"id": "dev", "label": "开发"},
    {"id": "none", "label": "未标注"},
]

PLATFORM_PRESETS = [
    "GitHub", "Gitee", "Cloudflare", "Vercel", "Netlify", "Docker Hub",
    "阿里云", "腾讯云", "华为云", "AWS", "Azure", "Namecheap", "Porkbun",
    "GoDaddy", "Namesilo", "搬瓦工", "Vultr", "DigitalOcean",
]

EXPIRY_ORDER = {"expired": 0, "urgent": 1, "soon": 2, "ok": 3, "none": 4}


# ---------------------------------------------------------------- database
def db_diagnosis(exc: BaseException) -> str:
    """把 sqlite 含糊的 "unable to open database file" 变成能直接定位的报错。"""
    where = DB_PATH.parent
    uid = os.getuid() if hasattr(os, "getuid") else "?"
    gid = os.getgid() if hasattr(os, "getgid") else "?"
    lines = [f"无法打开数据库 {DB_PATH}", f"  sqlite: {exc}", f"  进程 uid={uid} gid={gid}"]
    try:
        st = where.stat()
        lines.append(
            f"  目录 {where} 存在，属主 uid={st.st_uid} gid={st.st_gid} mode={oct(st.st_mode & 0o777)}"
        )
        if not os.access(where, os.W_OK):
            lines.append("  ✗ 该目录对当前进程不可写，宿主机上执行（把路径换成实际数据目录）：")
            lines.append(f"    sudo chown -R {uid}:{gid} <宿主机数据目录>")
    except OSError as err:
        lines.append(f"  目录 {where} 不可访问：{err}")
        lines.append("  ✗ 检查 compose 的 volumes 是否指向一个真实存在的目录（而不是同名文件）")
    if DB_PATH.exists() and not os.access(DB_PATH, os.W_OK):
        lines.append(f"  ✗ 库文件存在但不可写：{DB_PATH}")
    return "\n".join(lines)


@contextmanager
def db():
    conn = None
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
    except (sqlite3.Error, OSError) as exc:
        raise RuntimeError(db_diagnosis(exc)) from exc
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT    NOT NULL DEFAULT '',
    name            TEXT    NOT NULL DEFAULT '',
    label           TEXT    NOT NULL DEFAULT '',
    url             TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'active',
    credential_hint TEXT    NOT NULL DEFAULT '',
    notes           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform, name);

CREATE TABLE IF NOT EXISTS assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    category        TEXT    NOT NULL DEFAULT 'other',
    platform        TEXT    NOT NULL DEFAULT '',
    url             TEXT    NOT NULL DEFAULT '',
    account         TEXT    NOT NULL DEFAULT '',
    account_id      INTEGER,
    environment     TEXT    NOT NULL DEFAULT 'prod',
    status          TEXT    NOT NULL DEFAULT 'active',
    expires_at      TEXT    NOT NULL DEFAULT '',
    auto_renew      INTEGER NOT NULL DEFAULT 0,
    cost            REAL    NOT NULL DEFAULT 0,
    currency        TEXT    NOT NULL DEFAULT 'CNY',
    cycle           TEXT    NOT NULL DEFAULT 'none',
    credential_hint TEXT    NOT NULL DEFAULT '',
    tags            TEXT    NOT NULL DEFAULT '',
    notes           TEXT    NOT NULL DEFAULT '',
    pinned          INTEGER NOT NULL DEFAULT 0,
    provider        TEXT    NOT NULL DEFAULT '',
    provider_account TEXT   NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
CREATE INDEX IF NOT EXISTS idx_assets_expires  ON assets(expires_at);

-- 轻量配置表：目前只放定时备份的开关与保留策略
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
"""


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        migrate(conn)


def migrate(conn: sqlite3.Connection) -> None:
    """把「平台 + 账号纯文本」的旧数据升级成账号实体，并回填 account_id。"""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(assets)")}
    if "account_id" not in cols:
        conn.execute("ALTER TABLE assets ADD COLUMN account_id INTEGER")
    # 索引必须等列存在之后再建（旧库升级时 executescript 会先跑到这一句之前）
    conn.execute("CREATE INDEX IF NOT EXISTS idx_assets_account ON assets(account_id)")

    # v3：域名类资产要同时记住「申请商」与「申请商侧账号」，
    # 托管方则由 account_id 指向的 Cloudflare 账号表达，两个维度都落成结构化字段。
    for col, ddl in (
        ("provider", "ALTER TABLE assets ADD COLUMN provider TEXT NOT NULL DEFAULT ''"),
        ("provider_account", "ALTER TABLE assets ADD COLUMN provider_account TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in cols:
            conn.execute(ddl)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_assets_provider ON assets(provider)")

    rows = conn.execute(
        "SELECT DISTINCT ifnull(platform,'') AS p, ifnull(account,'') AS a "
        "FROM assets WHERE account_id IS NULL"
    ).fetchall()
    ts = now_iso()
    for row in rows:
        platform = (row["p"] or "").strip()
        name = (row["a"] or "").strip()
        if not name:
            continue  # 没有账号文本的资产保持「未归属」
        platform = platform or "未归类"
        found = conn.execute(
            "SELECT id FROM accounts WHERE lower(platform)=lower(?) AND lower(name)=lower(?)",
            (platform, name),
        ).fetchone()
        if found:
            aid = found["id"]
        else:
            aid = conn.execute(
                """INSERT INTO accounts (platform, name, label, url, status, credential_hint,
                        notes, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (platform, name, "", "", "active", "", "", ts, ts),
            ).lastrowid
        conn.execute(
            "UPDATE assets SET account_id=?, platform=? "
            "WHERE account_id IS NULL AND ifnull(platform,'')=? AND ifnull(account,'')=?",
            (aid, platform, row["p"], row["a"]),
        )


def now_iso() -> str:
    return dt.datetime.now().replace(microsecond=0).isoformat()


def today() -> dt.date:
    return dt.date.today()


def days_left(expires_at: str) -> int | None:
    """距离到期的天数；无日期返回 None，负数代表已过期。"""
    if not expires_at:
        return None
    try:
        return (dt.date.fromisoformat(expires_at[:10]) - today()).days
    except ValueError:
        return None


def row_out(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["auto_renew"] = bool(item["auto_renew"])
    item["pinned"] = bool(item["pinned"])
    left = days_left(item["expires_at"])
    item["days_left"] = left
    if left is None:
        item["expiry_state"] = "none"
    elif left < 0:
        item["expiry_state"] = "expired"
    elif left <= 7:
        item["expiry_state"] = "urgent"
    elif left <= 30:
        item["expiry_state"] = "soon"
    else:
        item["expiry_state"] = "ok"
    tags = item.get("tags") or ""
    item["tag_list"] = [t.strip() for t in tags.split(",") if t.strip()]
    return item


# ---------------------------------------------------------------- schemas
class AssetIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    category: str = "other"
    account_id: int | None = None
    url: str = ""
    environment: str = "prod"
    status: str = "active"
    expires_at: str = ""
    auto_renew: bool = False
    cost: float = 0
    currency: str = "CNY"
    cycle: str = "none"
    credential_hint: str = ""
    tags: str = ""
    notes: str = ""
    pinned: bool = False
    provider: str = ""
    provider_account: str = ""


class AccountIn(BaseModel):
    platform: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    label: str = ""
    url: str = ""
    status: str = "active"
    credential_hint: str = ""
    notes: str = ""


class ImportPayload(BaseModel):
    mode: Literal["merge", "replace"] = "merge"
    accounts: list[dict] = Field(default_factory=list)
    assets: list[dict] = Field(default_factory=list)


class PlatformRenameIn(BaseModel):
    to: str = Field(min_length=1, max_length=80)


# ---------------------------------------------------------------- 聚合
def yearly_of(item: dict) -> float:
    if item["cycle"] == "yearly":
        return float(item["cost"] or 0)
    if item["cycle"] == "monthly":
        return float(item["cost"] or 0) * 12
    return 0.0


def cost_map(items: list[dict]) -> dict[str, float]:
    out: dict[str, float] = {}
    for it in items:
        money = yearly_of(it)
        if money:
            cur = (it["currency"] or "CNY").upper()
            out[cur] = round(out.get(cur, 0.0) + money, 2)
    return out


def rollup(items: list[dict]) -> dict[str, Any]:
    by_cat: dict[str, int] = {}
    for it in items:
        by_cat[it["category"]] = by_cat.get(it["category"], 0) + 1
    costs = cost_map(items)
    return {
        "asset_count": len(items),
        "by_category": by_cat,
        "costs": costs,
        "yearly_cost": costs.get("CNY", 0.0),
        "expiring_30d": sum(1 for it in items if it["days_left"] is not None and 0 <= it["days_left"] <= 30),
        "expired": sum(1 for it in items if it["expiry_state"] == "expired"),
    }


def sort_assets(items: list[dict]) -> list[dict]:
    return sorted(
        items,
        key=lambda x: (not x["pinned"], EXPIRY_ORDER.get(x["expiry_state"], 9),
                       (x["name"] or "").lower()),
    )


def build_tree() -> list[dict[str, Any]]:
    with db() as conn:
        acc_rows = [dict(r) for r in conn.execute("SELECT * FROM accounts")]
        asset_rows = [row_out(r) for r in conn.execute("SELECT * FROM assets")]

    index: dict[int, dict] = {}
    grouped: dict[str, list[dict]] = {}
    for acc in acc_rows:
        acc["assets"] = []
        index[acc["id"]] = acc
        key = (acc["platform"] or "").strip() or "未归类"
        grouped.setdefault(key, []).append(acc)

    orphans: list[dict] = []
    for a in asset_rows:
        acc = index.get(a["account_id"]) if a["account_id"] else None
        if acc is None:
            orphans.append(a)
        else:
            acc["assets"].append(a)

    if orphans:
        grouped.setdefault("未归类", []).append({
            "id": None, "platform": "未归类", "name": "未归属", "label": "",
            "url": "", "status": "active", "credential_hint": "",
            "notes": "还没有挂到账号上的资产", "updated_at": "",
            "assets": orphans,
        })

    platforms: list[dict] = []
    for platform, accs in grouped.items():
        accounts_out = []
        all_items: list[dict] = []
        for acc in accs:
            items = sort_assets(acc["assets"])
            all_items += items
            accounts_out.append({
                "id": acc["id"],
                "platform": acc["platform"],
                "name": acc["name"],
                "label": acc["label"],
                "url": acc["url"],
                "status": acc["status"],
                "credential_hint": acc["credential_hint"],
                "notes": acc["notes"],
                "updated_at": acc["updated_at"],
                **rollup(items),
                "assets": items,
            })
        accounts_out.sort(key=lambda x: (-x["asset_count"], (x["name"] or "").lower()))
        platforms.append({
            "platform": platform,
            "account_count": len([a for a in accounts_out if a["id"] is not None]),
            **rollup(all_items),
            "accounts": accounts_out,
        })

    platforms.sort(key=lambda p: (-p["asset_count"], p["platform"].lower()))
    return platforms


def find_account_row(conn: sqlite3.Connection, account_id: int | None) -> sqlite3.Row | None:
    """查账号，找不到返回 None（不抛错），供导入回退逻辑使用。"""
    if not account_id:
        return None
    return conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()


def find_account(conn: sqlite3.Connection, account_id: int | None) -> sqlite3.Row | None:
    if not account_id:
        return None
    row = find_account_row(conn, account_id)
    if not row:
        raise HTTPException(status_code=400, detail="归属账号不存在")
    return row


def asset_params(data: dict, account: sqlite3.Row | None) -> dict:
    """账号是平台/账号字段的唯一来源，写入时反推。"""
    return {
        **data,
        "platform": (account["platform"] if account else ""),
        "account": (account["name"] if account else ""),
        "account_id": (account["id"] if account else None),
        "auto_renew": int(bool(data.get("auto_renew"))),
        "pinned": int(bool(data.get("pinned"))),
    }


INSERT_ASSET_SQL = """INSERT INTO assets (name, category, platform, url, account, account_id,
        environment, status, expires_at, auto_renew, cost, currency, cycle, credential_hint,
        tags, notes, pinned, provider, provider_account, created_at, updated_at)
   VALUES (:name,:category,:platform,:url,:account,:account_id,:environment,:status,
        :expires_at,:auto_renew,:cost,:currency,:cycle,:credential_hint,:tags,:notes,
        :pinned,:provider,:provider_account,:created_at,:updated_at)"""


# ---------------------------------------------------------------- app
@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    task = asyncio.create_task(backup_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    title=APP_TITLE,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


def guard(password: str | None) -> None:
    if not APP_PASSWORD:
        return
    if (password or "") != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="密码错误")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    """公开的元数据（不含任何资产信息），用于渲染分类与登录判断。"""
    return {
        "title": APP_TITLE,
        "requires_password": bool(APP_PASSWORD),
        "categories": CATEGORIES,
        "statuses": STATUSES,
        "cycles": CYCLES,
        "environments": ENVIRONMENTS,
        "platforms": PLATFORM_PRESETS,
    }


@app.get("/api/tree")
def tree(password: str | None = Header(default=None, alias="X-App-Password")) -> dict[str, Any]:
    """平台 → 账号 → 资产 的完整层级，前端主视图只依赖这一个接口。"""
    guard(password)
    platforms = build_tree()
    accounts = sum(p["account_count"] for p in platforms)
    assets = sum(p["asset_count"] for p in platforms)
    return {"platforms": platforms, "account_count": accounts, "asset_count": assets}


@app.get("/api/accounts")
def list_accounts(password: str | None = Header(default=None, alias="X-App-Password")) -> dict[str, Any]:
    guard(password)
    platforms = build_tree()
    flat = []
    for p in platforms:
        for a in p["accounts"]:
            if a["id"] is not None:
                flat.append(a)
    return {"items": flat, "total": len(flat)}


@app.post("/api/accounts")
def create_account(
    payload: AccountIn,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    ts = now_iso()
    data = {**payload.model_dump(), "platform": payload.platform.strip(), "name": payload.name.strip()}
    if not data["platform"] or not data["name"]:
        raise HTTPException(status_code=400, detail="平台与账号标识不能为空")
    with db() as conn:
        dup = conn.execute(
            "SELECT id FROM accounts WHERE lower(platform)=lower(?) AND lower(name)=lower(?)",
            (data["platform"], data["name"]),
        ).fetchone()
        if dup:
            raise HTTPException(status_code=409, detail="该平台下已有同名账号")
        new_id = conn.execute(
            """INSERT INTO accounts (platform, name, label, url, status, credential_hint,
                    notes, created_at, updated_at)
               VALUES (:platform,:name,:label,:url,:status,:credential_hint,:notes,:c,:u)""",
            {**data, "c": ts, "u": ts},
        ).lastrowid
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (new_id,)).fetchone()
    return {**dict(row), "asset_count": 0, "by_category": {}, "costs": {}, "yearly_cost": 0.0,
            "expiring_30d": 0, "expired": 0, "assets": []}


@app.put("/api/accounts/{account_id}")
def update_account(
    account_id: int,
    payload: AccountIn,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    data = {**payload.model_dump(), "platform": payload.platform.strip(), "name": payload.name.strip()}
    if not data["platform"] or not data["name"]:
        raise HTTPException(status_code=400, detail="平台与账号标识不能为空")
    with db() as conn:
        if not conn.execute("SELECT id FROM accounts WHERE id=?", (account_id,)).fetchone():
            raise HTTPException(status_code=404, detail="账号不存在")
        conn.execute(
            """UPDATE accounts SET platform=:platform, name=:name, label=:label, url=:url,
                    status=:status, credential_hint=:credential_hint, notes=:notes,
                    updated_at=:u WHERE id=:id""",
            {**data, "u": now_iso(), "id": account_id},
        )
        # 账号改平台/改名后，资产上的投影字段同步刷新
        conn.execute(
            "UPDATE assets SET platform=?, account=? WHERE account_id=?",
            (data["platform"], data["name"], account_id),
        )
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    return dict(row)


@app.post("/api/platforms/{name}/rename")
def rename_platform(
    name: str,
    payload: PlatformRenameIn,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    """平台重命名。

    平台不是独立的表 —— 它由 accounts.platform 归一后聚合出来，所以改名就是：
    把这批账号的 platform 一次性换成新名字，再把资产上的 platform 投影同步刷一遍。
    目标名字已经有账号时不会报错，等价于两个平台合并（同名账号会并存，需要自己去合并）。
    """
    guard(password)
    old = (name or "").strip()
    new = (payload.to or "").strip()
    if not old or not new:
        raise HTTPException(status_code=400, detail="平台名不能为空")
    if old == "未归类" or new == "未归类":
        raise HTTPException(status_code=400, detail="「未归类」是兜底分组，不能改名或改成它")
    if old == new:
        return {"from": old, "to": new, "accounts": 0, "assets": 0, "merged": False}

    ts = now_iso()
    with db() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM accounts WHERE ifnull(platform,'')=?", (old,)
        ).fetchall()]
        if not ids:
            raise HTTPException(status_code=404, detail="这个平台下没有账号")
        existed = conn.execute(
            "SELECT count(*) AS n FROM accounts WHERE ifnull(platform,'')=?", (new,)
        ).fetchone()["n"]
        conn.execute(
            "UPDATE accounts SET platform=?, updated_at=? WHERE ifnull(platform,'')=?",
            (new, ts, old),
        )
        # 投影字段跟着刷：账号下的资产统一改到新平台名
        marks = ",".join("?" * len(ids))
        changed = conn.execute(
            f"UPDATE assets SET platform=? WHERE account_id IN ({marks}) AND ifnull(platform,'')<>?",
            [new, *ids, new],
        ).rowcount
        # 没有归属账号、但文本上还写着旧平台名的孤儿资产也一起改
        changed += conn.execute(
            "UPDATE assets SET platform=? WHERE account_id IS NULL AND ifnull(platform,'')=?",
            (new, old),
        ).rowcount
    return {
        "from": old,
        "to": new,
        "accounts": len(ids),
        "assets": changed,
        "merged": bool(existed),
    }


@app.delete("/api/accounts/{account_id}")
def delete_account(
    account_id: int,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    with db() as conn:
        moved = conn.execute(
            "UPDATE assets SET account_id=NULL, platform='', account='' WHERE account_id=?",
            (account_id,),
        ).rowcount
        conn.execute("DELETE FROM accounts WHERE id=?", (account_id,))
    return {"ok": True, "detached_assets": moved}


@app.get("/api/assets")
def list_assets(
    q: str = Query(default=""),
    category: str = Query(default=""),
    status: str = Query(default=""),
    platform: str = Query(default=""),
    sort: str = Query(default="smart"),
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    sql = "SELECT * FROM assets WHERE 1=1"
    params: list[Any] = []
    if q:
        like = f"%{q.strip()}%"
        sql += " AND (name LIKE ? OR platform LIKE ? OR url LIKE ? OR account LIKE ? OR tags LIKE ? OR notes LIKE ? OR provider LIKE ? OR provider_account LIKE ?)"
        params += [like] * 8
    if category:
        sql += " AND category = ?"
        params.append(category)
    if status:
        sql += " AND status = ?"
        params.append(status)
    if platform:
        sql += " AND platform = ?"
        params.append(platform)

    if sort == "expiry":
        sql += " ORDER BY CASE WHEN expires_at = '' THEN 1 ELSE 0 END, expires_at ASC"
    elif sort == "name":
        sql += " ORDER BY name COLLATE NOCASE ASC"
    elif sort == "cost":
        sql += " ORDER BY cost DESC"
    elif sort == "updated":
        sql += " ORDER BY updated_at DESC"
    else:
        sql += " ORDER BY pinned DESC, updated_at DESC"

    with db() as conn:
        rows = [row_out(r) for r in conn.execute(sql, params).fetchall()]
        total = conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]

    if sort == "smart":
        rows.sort(key=lambda x: (not x["pinned"], EXPIRY_ORDER.get(x["expiry_state"], 9)))

    return {"items": rows, "total": total}


@app.get("/api/stats")
def stats(password: str | None = Header(default=None, alias="X-App-Password")) -> dict[str, Any]:
    guard(password)
    platforms = build_tree()
    assets = [a for p in platforms for acc in p["accounts"] for a in acc["assets"]]
    costs = cost_map(assets)
    upcoming = sorted(
        [a for a in assets if a["days_left"] is not None and 0 <= a["days_left"] <= 30],
        key=lambda x: x["days_left"],
    )
    expired = [a for a in assets if a["expiry_state"] == "expired"]
    by_cat: dict[str, int] = {}
    for a in assets:
        by_cat[a["category"]] = by_cat.get(a["category"], 0) + 1
    return {
        "total": len(assets),
        "active": sum(1 for a in assets if a["status"] == "active"),
        "platform_count": len([p for p in platforms if p["platform"] != "未归类"]),
        "account_count": sum(p["account_count"] for p in platforms),
        "by_category": by_cat,
        "by_platform": {p["platform"]: p["asset_count"] for p in platforms},
        "expiring_30d": len(upcoming),
        "expired": len(expired),
        "upcoming": [
            {k: a[k] for k in ("id", "name", "category", "platform", "expires_at", "days_left", "auto_renew")}
            for a in upcoming[:8]
        ],
        "expired_items": [
            {k: a[k] for k in ("id", "name", "category", "expires_at", "days_left")} for a in expired[:8]
        ],
        "costs": costs,
        "yearly_cost": costs.get("CNY", 0.0),
        "monthly_cost": round(costs.get("CNY", 0.0) / 12, 2),
    }


@app.post("/api/assets")
def create_asset(
    payload: AssetIn,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    data = payload.model_dump()
    data["category"] = data["category"] if data["category"] in CATEGORY_IDS else "other"
    ts = now_iso()
    with db() as conn:
        acc = find_account(conn, data.get("account_id"))
        params = asset_params(data, acc)
        new_id = conn.execute(INSERT_ASSET_SQL, {**params, "created_at": ts, "updated_at": ts}).lastrowid
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (new_id,)).fetchone()
    return row_out(row)


@app.put("/api/assets/{asset_id}")
def update_asset(
    asset_id: int,
    payload: AssetIn,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    data = payload.model_dump()
    data["category"] = data["category"] if data["category"] in CATEGORY_IDS else "other"
    with db() as conn:
        if not conn.execute("SELECT id FROM assets WHERE id = ?", (asset_id,)).fetchone():
            raise HTTPException(status_code=404, detail="资产不存在")
        acc = find_account(conn, data.get("account_id"))
        params = asset_params(data, acc)
        conn.execute(
            """UPDATE assets SET name=:name, category=:category, platform=:platform, url=:url,
                    account=:account, account_id=:account_id, environment=:environment,
                    status=:status, expires_at=:expires_at, auto_renew=:auto_renew, cost=:cost,
                    currency=:currency, cycle=:cycle, credential_hint=:credential_hint,
                    tags=:tags, notes=:notes, pinned=:pinned, provider=:provider,
                    provider_account=:provider_account, updated_at=:updated_at
               WHERE id=:id""",
            {**params, "updated_at": now_iso(), "id": asset_id},
        )
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    return row_out(row)


@app.delete("/api/assets/{asset_id}")
def delete_asset(
    asset_id: int,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, bool]:
    guard(password)
    with db() as conn:
        conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
    return {"ok": True}


@app.get("/api/export")
def export_all(password: str | None = Header(default=None, alias="X-App-Password")) -> JSONResponse:
    guard(password)
    with db() as conn:
        accounts = [dict(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")]
        rows = [row_out(r) for r in conn.execute("SELECT * FROM assets ORDER BY id").fetchall()]
    payload = {
        "app": "asset-ledger",
        "version": 2,
        "exported_at": now_iso(),
        "count": len(rows),
        "account_count": len(accounts),
        "accounts": accounts,
        "assets": rows,
    }
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    return JSONResponse(
        payload,
        headers={"Content-Disposition": f'attachment; filename="assets-{stamp}.json"'},
    )


@app.post("/api/import")
def import_all(
    payload: ImportPayload = Body(...),
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    ts = now_iso()
    inserted = 0
    created_accounts = 0
    with db() as conn:
        if payload.mode == "replace":
            conn.execute("DELETE FROM assets")
            conn.execute("DELETE FROM accounts")

        key_to_id: dict[tuple[str, str], int] = {}
        for r in conn.execute("SELECT id, platform, name FROM accounts"):
            key_to_id[(r["platform"].strip().lower(), r["name"].strip().lower())] = r["id"]

        # 导出文件里的 account_id 是导出方库里的 id，导入后 id 空间不同
        # （replace 清空后自增往往整体前移），必须按账号身份重映射，不能直接沿用。
        old_to_new: dict[int, int] = {}
        for raw in payload.accounts:
            platform = str(raw.get("platform") or "").strip()
            name = str(raw.get("name") or "").strip()
            if not platform or not name:
                continue
            key = (platform.lower(), name.lower())
            if key in key_to_id:
                new_id = key_to_id[key]
            else:
                new_id = conn.execute(
                    """INSERT INTO accounts (platform, name, label, url, status, credential_hint,
                            notes, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (platform, name, str(raw.get("label") or ""), str(raw.get("url") or ""),
                     str(raw.get("status") or "active"), str(raw.get("credential_hint") or ""),
                     str(raw.get("notes") or ""), ts, ts),
                ).lastrowid
                key_to_id[key] = new_id
                created_accounts += 1
            if isinstance(raw.get("id"), int):
                old_to_new[raw["id"]] = new_id

        for raw in payload.assets:
            try:
                item = AssetIn(**{k: raw.get(k) for k in AssetIn.model_fields if k in raw})
            except Exception:
                continue
            data = item.model_dump()
            data["category"] = data["category"] if data["category"] in CATEGORY_IDS else "other"

            # 先把导出方的旧 account_id 映射到本库的新 id
            raw_acc_id = data.get("account_id")
            if raw_acc_id is not None and raw_acc_id in old_to_new:
                data["account_id"] = old_to_new[raw_acc_id]

            # 允许旧格式（只有 platform + account 文本）的备份导入
            if not data.get("account_id") or find_account_row(conn, data["account_id"]) is None:
                p = str(raw.get("platform") or "").strip()
                a = str(raw.get("account") or "").strip()
                if p and a:
                    key = (p.lower(), a.lower())
                    if key not in key_to_id:
                        key_to_id[key] = conn.execute(
                            """INSERT INTO accounts (platform, name, label, url, status,
                                    credential_hint, notes, created_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?)""",
                            (p, a, "", "", "active", "", "", ts, ts),
                        ).lastrowid
                        created_accounts += 1
                    data["account_id"] = key_to_id[key]

            acc = find_account(conn, data.get("account_id"))
            params = asset_params(data, acc)
            conn.execute(INSERT_ASSET_SQL, {**params, "created_at": ts, "updated_at": ts})
            inserted += 1

    return {"ok": True, "inserted": inserted, "accounts_created": created_accounts}


# ---------------------------------------------------------------- 备份
def read_setting(key: str, default: Any = None) -> Any:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return default


def write_setting(key: str, value: Any) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )


def backup_config() -> dict[str, Any]:
    raw = read_setting("backup", {})
    cfg = {**BACKUP_DEFAULTS, **(raw if isinstance(raw, dict) else {})}
    if cfg.get("interval_hours") not in BACKUP_INTERVALS:
        cfg["interval_hours"] = 24
    try:
        cfg["keep"] = max(1, min(50, int(cfg.get("keep") or 7)))
    except (TypeError, ValueError):
        cfg["keep"] = 7
    cfg["enabled"] = bool(cfg.get("enabled"))
    return cfg


def list_backups() -> list[dict[str, Any]]:
    """备份列表，按时间从新到旧。"""
    if not BACKUP_DIR.exists():
        return []
    items: list[dict[str, Any]] = []
    for path in BACKUP_DIR.glob("assets-*.db"):
        if not BACKUP_NAME_RE.match(path.name):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        items.append({
            "name": path.name,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "created_at": dt.datetime.fromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat(),
        })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def create_backup() -> dict[str, Any]:
    """用 SQLite 的在线备份 API 落一份快照：读写并发下也是一致的，不会拷到半个事务。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stem = "assets-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = BACKUP_DIR / f"{stem}.db"
    seq = 1
    while path.exists():  # 同一秒连点两次也能各留一份
        seq += 1
        path = BACKUP_DIR / f"{stem}-{seq}.db"

    src = sqlite3.connect(DB_PATH)
    try:
        dst = sqlite3.connect(path)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()

    stamp = dt.datetime.now().replace(microsecond=0).isoformat()
    return {"name": path.name, "size": path.stat().st_size, "created_at": stamp}


def prune_backups(keep: int) -> list[str]:
    """只保留最新 keep 份，其余按时间从旧到新删掉。"""
    keep = max(1, keep)
    removed: list[str] = []
    for item in list_backups()[keep:]:
        try:
            (BACKUP_DIR / item["name"]).unlink()
            removed.append(item["name"])
        except OSError:
            pass
    return removed


def backup_dir_label() -> str:
    """给人看的目录路径，统一用 `/` 分隔，不暴露 Windows 的反斜杠风格。"""
    try:
        return BACKUP_DIR.resolve().relative_to(BASE_DIR).as_posix()
    except ValueError:
        return BACKUP_DIR.as_posix()


def backup_state() -> dict[str, Any]:
    cfg = backup_config()
    items = list_backups()
    next_at = ""
    if cfg["enabled"] and cfg.get("last_at"):
        try:
            nxt = dt.datetime.fromisoformat(str(cfg["last_at"])) + dt.timedelta(hours=cfg["interval_hours"])
            next_at = nxt.replace(microsecond=0).isoformat()
        except ValueError:
            next_at = ""
    return {
        "config": {k: cfg[k] for k in ("enabled", "interval_hours", "keep")},
        "last_at": cfg.get("last_at") or "",
        "next_at": next_at,
        "dir": backup_dir_label(),
        "total_size": sum(i["size"] for i in items),
        "items": items,
        "intervals": list(BACKUP_INTERVALS),
    }


def safe_backup_path(name: str) -> Path:
    if not BACKUP_NAME_RE.match(name or ""):
        raise HTTPException(status_code=400, detail="备份文件名不合法")
    path = (BACKUP_DIR / name).resolve()
    if BACKUP_DIR.resolve() not in path.parents:
        raise HTTPException(status_code=400, detail="备份路径不合法")
    return path


def backup_due(cfg: dict[str, Any]) -> bool:
    last = str(cfg.get("last_at") or "")
    if not last:
        return True
    try:
        return dt.datetime.now() - dt.datetime.fromisoformat(last) >= dt.timedelta(hours=cfg["interval_hours"])
    except ValueError:
        return True


async def backup_loop() -> None:
    """后台巡检：只在「已启用且到期」时才落快照，其余时间什么都不做。"""
    await asyncio.sleep(15)  # 让启动流程先跑完，别和建库抢 IO
    while True:
        try:
            cfg = backup_config()
            if cfg["enabled"] and backup_due(cfg):
                create_backup()
                prune_backups(cfg["keep"])
                cfg["last_at"] = now_iso()
                write_setting("backup", cfg)
        except Exception:  # 单次失败不影响下一次
            pass
        await asyncio.sleep(BACKUP_TICK)


class BackupIn(BaseModel):
    enabled: bool = False
    interval_hours: int = 24
    keep: int = 7


@app.get("/api/backup")
def get_backup(password: str | None = Header(default=None, alias="X-App-Password")) -> dict[str, Any]:
    guard(password)
    return backup_state()


@app.put("/api/backup")
def put_backup(
    payload: BackupIn,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    if payload.interval_hours not in BACKUP_INTERVALS:
        raise HTTPException(status_code=400, detail="不支持的备份频率")
    cfg = backup_config()
    cfg.update(
        enabled=bool(payload.enabled),
        interval_hours=int(payload.interval_hours),
        keep=max(1, min(50, int(payload.keep))),
    )
    write_setting("backup", cfg)
    # 改小保留份数时立刻生效，不用等到下次备份
    removed = prune_backups(cfg["keep"])
    return {**backup_state(), "removed": removed}


@app.post("/api/backup/run")
def run_backup(password: str | None = Header(default=None, alias="X-App-Password")) -> dict[str, Any]:
    guard(password)
    item = create_backup()
    cfg = backup_config()
    cfg["last_at"] = now_iso()  # 手动备份也算一次，避免刚备完定时任务又跑一遍
    write_setting("backup", cfg)
    removed = prune_backups(cfg["keep"])
    return {**backup_state(), "created": item, "removed": removed}


@app.get("/api/backup/download/{name}")
def download_backup(
    name: str,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> FileResponse:
    guard(password)
    path = safe_backup_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="备份不存在")
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@app.delete("/api/backup/{name}")
def delete_backup(
    name: str,
    password: str | None = Header(default=None, alias="X-App-Password"),
) -> dict[str, Any]:
    guard(password)
    path = safe_backup_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="备份不存在")
    path.unlink()
    return {"ok": True, **backup_state()}


# ---------------------------------------------------------------- static
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
