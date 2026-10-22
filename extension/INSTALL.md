# 资产台账 · 快速录入 —— 安装说明

版本 **{{VERSION}}** ｜ 扩展 ID `{{EXT_ID}}`

本页的下载都在同一个 Release 里：

| 文件 | 用途 |
|---|---|
| `asset-ledger-extension-{{VERSION}}.zip` | 解压后「加载解压缩的扩展」，最稳，不需要动注册表 |
| `asset-ledger-extension-{{VERSION}}.crx` | 已签名安装包，配策略使用（见方式 B） |
| `update.xml` | 扩展的自动更新清单，配策略时由浏览器定期拉取 |
| `install.ps1` / `uninstall.ps1` | 写/删注册表策略的小脚本，免管理员 |

## 先说清楚一件事

**双击或拖拽 `.crx` 到扩展页面会失败**，报 `CRX_REQUIRED_PROOF_MISSING`。
这是 Chromium 从 75 版起的硬限制：非商店来源的 crx 一律拒装。所以下面只有两条真正可行的路。

## 方式 A：加载解压缩（零风险，推荐先用这个）

1. 下载 `.zip`，解压到固定目录（例如 `D:\Apps\asset-ledger-extension`，别放临时目录，删了就失效）
2. 打开 `edge://extensions`（Chrome 是 `chrome://extensions`）
3. 打开「开发人员模式」
4. 点「加载解压缩的扩展」，选第 1 步解压出来的目录

装好后点工具栏图标，填台账地址（如 `http://192.168.1.100:8787`），有密码就一并填上。

> 代价：Edge 每次启动可能提示「请关闭开发者模式扩展」，偶尔会把扩展标记为损坏需要重新加载。

## 方式 B：crx + 策略（正式安装，无开发者模式提示，且能自动更新）

原理：把扩展 ID 和更新地址写进当前用户的 Edge 策略，浏览器启动时自己下载安装并持续更新。
写的是 `HKCU`，**不需要管理员权限**。

**一键脚本**：下载 `install.ps1`，右键 →「使用 PowerShell 运行」。等价于执行：

```powershell
$k = 'HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name 1 `
  -Value '{{EXT_ID}};https://github.com/FUJIWARESHINE/asset-ledger/releases/latest/download/update.xml'
```

然后**完全退出 Edge 再打开**（任务栏右键退出，不是只关窗口），扩展会自己装上。

要点：

- 装好后扩展页会显示「由你的组织管理」，这是策略安装的正常表现
- **crx 不用手动下载**：浏览器按 `update.xml` 里的地址去 Release 里取，所以以后发新版本你不用做任何事
- 卸载：右键「使用 PowerShell 运行」`uninstall.ps1`，或手动删掉
  `HKCU\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist` 下的对应值，重启浏览器即卸载
- 想要 Chrome 也装，把路径里的 `Microsoft\Edge` 换成 `Google\Chrome`（`install.ps1` 两个都写了）

## 连不上台账

| 现象 | 处理 |
|---|---|
| 标题旁红点、提示「连不上台账」 | 地址错 / 不在同一网段 / 容器没起 |
| 「访问密码不对」 | `APP_PASSWORD` 填错，或台账设了密码但扩展里空着 |
| 换了域名或别的网段 | 打开扩展设置页，点一次「授权并保存」，浏览器会弹确认框 |

## 版本历史

- `{{VERSION}}`：首个可安装版本，支持手动录入 + 批量导入、重复检测、密码保护台账
