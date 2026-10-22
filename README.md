# 资产统计 · Cloud Asset Ledger

单容器、零外部依赖的个人云资产台账。按 **平台 → 账号 → 资产** 三级组织，
把散落在各家平台的东西（域名、仓库、Workers、Pages、VPS、订阅……）归到一处，
一眼看清「哪个账号下有什么、什么时候到期、一年花多少」。

和书签面板（Dashy / Homepage）不同，那些只有名字和链接；
和账单工具（Wallos）、域名工具（Domain Locker）也不同，那些只覆盖单一维度。
这里做的是**跨平台的资产归属台账**。

## 边界

**不存储任何密码、密钥或平台 API token，也不接入平台自动同步。**

密码由自建的 Vaultwarden 保管，这里只记「对应哪个条目」。数据库里没有任何能用来登录账号的东西，
`data/assets.db` 即便泄露，泄露的也只是「有哪些资产」，不是「怎么进这些资产」。

唯一的密码是可选的访问密码 `APP_PASSWORD`，只作为环境变量做本实例门禁，不写入数据库。

## 功能

| 能力 | 说明 |
|---|---|
| 三级归属 | 平台 → 账号 → 资产。同一平台可挂任意多个账号，账号下资产数量不限；账号改名或换平台时，名下资产自动跟着迁移 |
| 资产类型 | 10 类：域名 / 二级域名 / 仓库·项目 / Vercel / Workers / Pages / 服务器 / 存储·图床 / 账号·订阅 / 其他 |
| 资产字段 | 归属账号、环境、状态、到期日、自动续费、费用与周期、标签、备注，以及**密码存放位置**（只记 Vaultwarden 条目名） |
| 双维度归属 | 域名可同时记「申请商 + 申请账号」和「托管方 + 托管账号」。托管方是归属主体，申请商作为彩色徽章挂在资产上，筛选栏另有「申请商」一组 chips，可跨账号查看同一家申请商的全部域名 |
| 分组视图 | 平台卡片写明账号数、各类资产数量、年化成本、临近到期数；账号行给出资产数、类别分布与到期告警，点标题逐级折叠 |
| 账号内筛选 | 账号行右侧的类别徽章可点击：只筛这一个账号，头部变成 `5 / 8 项资产`，再点一次恢复。作用域严格限在该账号内，不影响其他账号，也不影响顶部全局筛选 |
| 账号内分段 | 一个账号混有多种资产时按类别自动分段，每段一行小标题 |
| 到期看板 | 已过期 / 7 天内 / 30 天内分级高亮，配续费时间线 |
| 成本统计 | 年化与月均成本；多币种分开展示，不混算 |
| 检索 | 一次搜索同时匹配平台、账号、资产名、链接、标签、备注、申请商；类别 / 平台 / 申请商三组 chips 可叠加 |
| 归属速览 | 搜索命中域名时，结果区上方插一条速览，一行说清「在哪申请 · 属于哪个账号 → 托管在哪个账号 · 何时到期」，点任意一行直接打开该资产 |
| 三种视图 | 分组视图（默认）/ 卡片平铺 / 紧凑列表，偏好记在浏览器里 |
| 快速跳转 | 卡片右侧悬停浮出 ↗（触屏常驻）直接打开站点，点卡片其余位置仍是编辑 |
| 定时备份 | 可开关、选频率（6 小时 ~ 每周）、设保留份数（默认 7 份），超出自动删最早的一份；面板内可看上次/下次时间与占用体积，支持立即备份、单份下载与删除 |
| 数据 | SQLite 单文件，JSON 一键导出 / 导入，可选访问密码 |
| 外观 | 明亮 / 黑暗双主题，默认明亮；液态玻璃 + iOS 弹性动画，适配移动端 |

## 快速开始

镜像已发布到两个 registry，多架构（`linux/amd64` / `linux/arm64`）：

| registry | 地址 |
|---|---|
| GHCR | `ghcr.io/fujiwareshine/asset-ledger:latest` |
| Docker Hub | `xuthsand/asset-ledger:latest` |

### Docker Compose（推荐）

```bash
mkdir -p asset-ledger && cd asset-ledger
curl -O https://raw.githubusercontent.com/FUJIWARESHINE/asset-ledger/main/docker-compose.yml
docker compose up -d
```

`docker-compose.yml` 里已经是拉取模式（`image:` 指向发布好的镜像），不会在本地构建。
国内拉 GHCR 慢的话，把 `image:` 换成 Docker Hub 那一行即可。

更新到新版本：

```bash
docker compose pull && docker compose up -d
```

### Docker CLI

```bash
docker run -d --name asset-ledger \
  -p 8787:8787 \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  ghcr.io/fujiwareshine/asset-ledger:latest
```

把镜像换成 `xuthsand/asset-ledger:latest` 就走 Docker Hub。

打开 `http://<host>:8787`。数据落在挂载出来的 `./data`，删容器不丢。

### 自己构建（可选）

```bash
git clone https://github.com/FUJIWARESHINE/asset-ledger.git
cd asset-ledger
docker build -t ghcr.io/fujiwareshine/asset-ledger:latest .
docker compose up -d
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_PASSWORD` | 空 | 设置后前后端都要求密码，留空则不校验 |
| `APP_TITLE` | `资产统计` | 页面标题 |
| `DB_PATH` | `/data/assets.db` | SQLite 路径，挂载 `/data` 即可持久化 |
| `BACKUP_DIR` | 库文件同级的 `backups/` | 定时备份目录，默认 `/data/backups`，跟数据卷走 |
| `TZ` | `Asia/Shanghai` | 时区，影响「剩余天数」计算 |

## 数据与备份

页面右上角「更多 → 定时备份」：默认**开启、每天一次、保留 7 份**，超过份数自动删最早的，
不会一直堆文件。快照用 SQLite 在线备份 API 生成，读写并发下也是一致快照，
文件名 `assets-YYYYmmdd-HHMMSS.db`。想恢复就把某份拷成 `data/assets.db` 再重启容器。

```bash
# 导出 JSON（也可在页面里点「更多 → 导出 JSON 备份」）
curl http://localhost:8787/api/export > backup.json

# 停机状态下直接拷库
cp data/assets.db data/backups/manual-$(date +%F).db
```

## 使用

- **建账号**：右上角「账号」，或按 `A`
- **新增资产**：右上角「新增资产」，或按 `N`；在账号行右侧点「+ 新增」会自动带上该账号
- **搜索**：按 `/` 聚焦搜索框
- **编辑**：点资产卡片；账号行右侧铅笔编辑账号
- **直达**：`/#new` 新建资产、`/#account` 新建账号、`/#id=3` 打开某条资产、`/?theme=dark` 固定深色

首次打开是空库。想先看效果可以灌一批虚构示例数据（`seed.py`，覆盖全部类别）：

```bash
python seed.py --replace --base http://127.0.0.1:8787
```

## 浏览器扩展（快速录入）

在平台上浏览时随手把资产填进浏览器弹窗，攒成一批后一次提交到台账，
不用来回切标签页开新增弹窗。Edge / Chrome 通用（MV3）。

- **纯手动**：不抓页面、不读 DOM、不接平台 API，不在平台上产生任何额外请求
- **不改后端**：走已发布的 `POST /api/assets`，老版本台账也能直接连
- **有队列和去重**：填完先进本地队列，确认后批量导入；account + 名称重复的自动跳过

装法：`edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `extension/` 目录。
详见 [`extension/README.md`](extension/README.md)。

## 技术栈

- 后端：FastAPI + SQLite（标准库 `sqlite3`，无 ORM）
- 前端：原生 HTML / CSS / JS，无框架、无构建步骤
- 镜像：`python:3.12-slim`，非 root（uid 1001），内置 healthcheck

## 目录

```
app/main.py           # 全部后端：模型、层级聚合、CRUD、导入导出、定时备份
static/index.html     # 页面骨架 + SVG 图标库
static/style.css      # 液态玻璃设计系统（明暗主题）
static/app.js         # 状态、渲染、交互
extension/            # 浏览器扩展「快速录入」，纯客户端，不依赖后端改动
seed.py               # 命令行灌示例数据
tools/import_excel.py # Excel 转导入 JSON 的小工具
tools/make_icons.py   # 生成扩展图标（纯标准库，不依赖 Pillow）
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/meta` | 分类 / 状态 / 周期枚举 |
| GET | `/api/tree` | 平台 → 账号 → 资产完整层级 |
| GET POST | `/api/accounts` | 账号列表 / 新建 |
| PUT DELETE | `/api/accounts/{id}` | 更新（资产同步换归属）/ 删除（资产转未归属） |
| GET POST | `/api/assets` | 资产列表（`?q=&category=&sort=`）/ 新建 |
| PUT DELETE | `/api/assets/{id}` | 更新 / 删除 |
| GET | `/api/stats` | 汇总统计 |
| GET POST | `/api/export` `/api/import` | 导出 / 导入（`mode=merge\|replace`） |
| GET PUT | `/api/backup` | 备份配置与快照列表 / 修改配置 |
| POST | `/api/backup/run` | 立即备份 |
| GET DELETE | `/api/backup/{name}` | 下载 / 删除某份快照 |

启用密码时请求头带 `X-App-Password`。

## 安全提示

默认不做鉴权，适合内网或反代后面自用。要暴露到公网，请设 `APP_PASSWORD` 并在反代上加 HTTPS。
