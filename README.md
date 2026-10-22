# 资产统计 · Cloud Asset Ledger

一个单容器、零外部依赖的个人云资产台账。

按 **平台 → 账号 → 资产** 三级组织：GitHub 下 5 个账号、每个账号十几个仓库；Cloudflare 下 3 个账号、每个账号若干域名 / Workers / Pages —— 全部按归属清晰归位，一眼看清「哪个平台、哪个账号、有哪些东西、各多少、什么时候到期、一年花多少」。

> 和 Dashy / Homepage 的区别：那些是「服务书签」，只有名字和链接。
> 和 Domain Locker 的区别：那个只管域名，且需要 Postgres + 外部 WHOIS 查询。
> 和 Wallos 的区别：那个只管订阅账单。
>
> 这个项目只做一件事：**跨平台资产的统一台账**。

## 边界（重要）

**本项目不存储任何密码、密钥或平台 API token，也不接入平台自动同步。**

密码统一由自建的 **Vaultwarden** 保管，这里只记录「对应 Vaultwarden 里的哪个条目」——
是一张记账表，不是密码库，也不是凭据代理。数据库里没有任何可用来登录你账号的东西，
所以 `data/assets.db` 即使泄露，也只是泄露「你有哪些资产」，不泄露「怎么进这些资产」。

唯一涉及密码的是可选的**访问密码**（`APP_PASSWORD`），它只作为环境变量做本实例的门禁，
不写入数据库。

## 功能

| 能力 | 说明 |
|---|---|
| 三级归属 | 平台 → 账号 → 资产。同一平台可挂任意多个账号，每个账号下资产数量不限 |
| 分组视图 | 平台卡片按资产数排序，卡头直接给出「N 个账号 · 各类资产数量 · 年化成本 · 临近到期数」；账号行给出资产数、类型分布、到期告警；点标题可逐级折叠 |
| 账号内分段 | 同一个账号下有多种资产时，按类别自动切片，每段一行小标题（`域名 21` / `Workers 9` / `Pages 4`） |
| 账号内筛选 | 账号行右侧的类别徽章（`域名 5` / `Workers 3`）**可以点**：点一下只筛这一个账号的资产，头部变成 `5 / 8 项资产`，再点一次恢复。作用域严格限在该账号内，不动别的账号，也不动顶部 chips 的全局筛选 |
| 资产台账 | 10 类资产：域名 / 二级域名 / 仓库·项目 / Vercel / Workers / Pages / 服务器 / 存储 / 账号·订阅 / 其他 |
| 元数据 | 平台、归属账号、环境（生产/预发/开发）、状态、到期日、自动续费、费用与周期、**密码存放位置**（只记 Vaultwarden 条目名，不存密码）、标签、备注 |
| 双维度归属 | 域名可以同时记「申请商 + 申请账号」与「托管方 + 托管账号」：托管方是归属主体（`account_id`），申请商落成资产上的 `provider` / `provider_account`，磁贴与卡片上以彩色徽章显示，筛选栏另有「申请商」一组 chips，点 dpdns 就能看到散落在各个 CF 账号下的全部 dpdns 域名 |
| 到期看板 | 已过期 / 7 天内 / 30 天内分级高亮，右侧续费时间线 |
| 成本统计 | 年化成本、月均成本，多币种分开展示不混算 |
| 检索 | 一次搜索同时匹配平台名、账号名、资产名、链接、标签、备注、申请商；类别 chips + 平台 chips + 申请商 chips 三层筛选 |
| 归属速览 | 搜索命中域名时，结果区上方会插入一条速览：一行说清「在哪个平台申请 · 属于哪个账号 → 托管在哪个 Cloudflare 账号 · 什么时候到期」，点任意一行直接打开该域名的详情 |
| 视图 | 分组视图（默认）/ 卡片平铺 / 紧凑列表，浏览器记住偏好 |
| 快速跳转 | 填了访问链接的资产，卡片右侧悬停即浮出 ↗（触屏设备常驻），点它在新标签打开站点；点卡片其余位置仍是编辑。编辑面板里也有「打开链接」兜底。热区绝对定位，不改变卡片宽高 |
| 账号管理 | 独立账号实体：备注名、控制台链接、状态、密码存放位置、备注；改名或换平台时，名下资产自动跟着迁移。账号行右侧会把**备注**压成一行虚线徽章（全文在悬停提示里），和实心的类别徽章区分开 |
| 数据 | SQLite 单文件，JSON 一键导出/导入，可选访问密码 |
| 主题 | 明亮 / 黑暗双主题，**默认明亮**，液态玻璃 + iOS 弹性动画 |
| 定时备份 | 右上角「更多 → 定时备份」：可开关、选频率（6 小时 ~ 每周）、设保留份数（默认 7 份），超出后自动删最早的一份。面板里能看上次/下次时间、占用体积，支持立即备份、单份下载与删除 |

## 快速开始

直接用打好的镜像（x86_64 / arm64 双架构）：

```bash
docker run -d --name asset-ledger \
  -p 8787:8787 \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  ghcr.io/fujiwareshine/asset-ledger:latest
```

国内拉 GHCR 慢的话换 Docker Hub：

```bash
docker run -d --name asset-ledger \
  -p 8787:8787 \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  xuthsand/asset-ledger:latest
```

打开 `http://<host>:8787`。

想在本地改代码并构建：

```bash
docker compose up -d --build
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_PATH` | `/data/assets.db` | SQLite 路径，挂载 `/data` 即可持久化 |
| `BACKUP_DIR` | 库文件同级的 `backups/` | 定时备份落在哪，默认 `/data/backups`，跟着数据卷走 |
| `APP_TITLE` | `资产统计` | 页面标题 |
| `APP_PASSWORD` | 空 | 设置后前后端都要求密码，留空则不校验 |
| `TZ` | `Asia/Shanghai` | 时区，影响「剩余天数」计算 |

### 数据备份

页面右上角「更多 → 定时备份」里可以开关自动快照：默认**开启、每天一次、保留 7 份**，
超过份数自动删掉时间最早的那份，不会一直堆文件。同一面板里能改频率（6 小时 ~ 每周）、
改保留份数、立即备份一次、下载或删除某一份。

快照落在 `data/backups/`（容器里是挂载卷内的 `data/backups`），文件名 `assets-YYYYmmdd-HHMMSS.db`，
用 SQLite 在线备份 API 生成，读写并发下也是一致快照。想恢复就把某份拷成 `data/assets.db` 再重启。

```bash
# 手动导出 JSON（也可在页面右上角「更多 → 导出 JSON 备份」）
curl http://localhost:8787/api/export > backup.json

# 直接拷数据库文件（停机状态下最稳）
cp data/assets.db data/backups/manual-$(date +%F).db
```

## 使用

- **建账号**：右上角「账号」，或按 `A`；也可以先建资产时点「新建」就地创建
- **新增资产**：右上角「新增资产」，或按 `N`；在某个账号行右侧点「+ 新增」会自动带上该账号
- **搜索**：按 `/` 聚焦搜索框
- **编辑**：点任意资产；点账号行右侧铅笔编辑账号
- **访问站点**：鼠标移到资产卡片上，点右侧浮出的 ↗；触屏设备直接点常驻的 ↗
- **直达表单**：`/#new`、`/#account`
- **直达某条资产**：`/#id=3`
- **固定深色主题链接**：`/?theme=dark`

首次打开是空库。想先灌一批示例数据看效果，在 NAS 上跑 `python seed.py --replace --base http://127.0.0.1:8787`（9 个账号、26 项资产），确认后逐条删掉即可 —— 页面上不再提供这个入口。

## 技术栈

- 后端：FastAPI + SQLite（标准库 `sqlite3`，无 ORM）
- 前端：原生 HTML/CSS/JS，无框架、无构建步骤
- 镜像：`python:3.12-slim`，非 root 运行（uid 1001），内置健康检查

## 目录

```
app/main.py          # 全部后端逻辑：账号/资产模型、层级聚合、CRUD、导入导出、定时备份
static/index.html    # 页面骨架 + SVG 图标库
static/style.css     # 液态玻璃设计系统（CSS 变量 + 明暗主题）
static/app.js        # 状态、渲染、交互
seed.py              # 命令行灌示例数据（可选，页面上没有这个入口了）
tools/import_excel.py # 把「虚拟资产.xlsx」转成导入 JSON（合并单元格会按语义展开）
data/assets.db       # 主库；data/backups/ 是定时备份的快照
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（Docker healthcheck 用） |
| GET | `/api/meta` | 分类/状态/周期枚举（公开，不含资产数据） |
| GET | `/api/tree` | **平台 → 账号 → 资产** 完整层级（前端主视图只依赖它） |
| GET | `/api/accounts` | 账号列表（带统计） |
| POST | `/api/accounts` | 新建账号（同平台同名会 409） |
| PUT | `/api/accounts/{id}` | 更新账号，名下资产同步换平台/账号名 |
| DELETE | `/api/accounts/{id}` | 删除账号，名下资产转为「未归属」而非一起删掉 |
| GET | `/api/assets?q=&category=&sort=` | 扁平资产列表 |
| POST | `/api/assets` | 新建（`account_id` 决定归属，平台自动反推） |
| PUT | `/api/assets/{id}` | 更新 |
| DELETE | `/api/assets/{id}` | 删除 |
| GET | `/api/stats` | 汇总统计 |
| GET | `/api/export` | 导出 JSON |
| POST | `/api/import` | 导入，`mode=merge\|replace` |
| GET | `/api/backup` | 备份配置 + 现有快照列表（含体积、上次/下次时间） |
| PUT | `/api/backup` | 改开关 / 频率 / 保留份数，改小份数会立即清理旧快照 |
| POST | `/api/backup/run` | 立刻做一份快照 |
| GET | `/api/backup/download/{name}` | 下载某份快照 |
| DELETE | `/api/backup/{name}` | 删除某份快照（文件名白名单校验，挡路径穿越） |

启用密码时带请求头 `X-App-Password`。

## 安全提示

默认不做鉴权，适合内网 / 反代后面跑。资产表里有账号邮箱这类信息，**要暴露到公网请务必设 `APP_PASSWORD`**，并在反代上加 HTTPS。
