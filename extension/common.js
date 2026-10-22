/* ============================================================
   公共层：存储 / 台账 API / 常量
   popup.html 与 options.html 共用
   ============================================================ */
(() => {
  "use strict";

  const KEY = "assetLedger";
  const hasExt = typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;

  const CAT = {
    domain: ["域名", "#0a84ff"], subdomain: ["二级域名", "#5e5ce6"],
    repo: ["仓库 / 项目", "#5b6373"], vercel: ["Vercel", "#2c2c30"],
    worker: ["Workers", "#e08600"], pages: ["Pages", "#e07a00"],
    server: ["服务器", "#22a94a"], storage: ["存储 / 图床", "#1fa8d8"],
    account: ["账号 / 订阅", "#a63fdb"], other: ["其他", "#7a7f8e"],
  };
  const CYCLE = { none: "不计费", monthly: "按月", yearly: "按年", once: "一次性" };

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* ---------------------------------------------- 存储 */
  // 扩展首次加载时 storage 后端就绪有竞态，get() 可能长时间不 resolve；
  // 兜一层超时，保证界面永远能出来，而不是白屏
  function withTimeout(p, ms, fallback) {
    return Promise.race([
      p,
      new Promise((res) => setTimeout(() => res(fallback), ms)),
    ]);
  }

  async function read() {
    if (hasExt) {
      const got = await chrome.storage.local.get(KEY);
      return got[KEY] || {};
    }
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
  }

  async function write(state) {
    if (hasExt) return chrome.storage.local.set({ [KEY]: state });
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  /* ---------------------------------------------- 地址规范化 */
  function normalizeBase(raw) {
    let v = String(raw || "").trim();
    if (!v) throw new Error("请填台账地址");
    if (!/^https?:\/\//i.test(v)) v = "http://" + v;
    let u;
    try { u = new URL(v); } catch { throw new Error("地址格式不对"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http / https");
    const path = u.pathname.replace(/\/+$/, "");
    return u.origin + (path === "" ? "" : path);
  }

  /* ---------------------------------------------- 权限 */
  // match pattern 不支持端口，必须按 origin 的 scheme+host 授权（会覆盖该主机的所有端口）
  function originPattern(base) {
    const u = new URL(base);
    return `${u.protocol}//${u.hostname}/*`;
  }

  async function hasHostPerm(base) {
    if (!hasExt || !chrome.permissions) return true;
    try {
      // 同样可能有就绪竞态：超时按「已授权」乐观处理，
      // 真没权限时 fetch 会明确失败并提示，比卡住整条流程好
      const ok = await withTimeout(
        chrome.permissions.contains({ origins: [originPattern(base)] }), 1200, true);
      return ok !== false;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------- API */
  async function api(cfg, method, path, body) {
    const base = String((cfg && cfg.baseUrl) || "").replace(/\/+$/, "");
    if (!base) throw new Error("还没配置台账地址");

    const opt = { method, headers: {} };
    if (cfg.password) opt.headers["X-App-Password"] = cfg.password;
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(base + path, opt);
    } catch {
      throw new Error("连不上台账：地址不对、不同网段，或没授权该地址");
    }
    if (res.status === 401) throw new Error("访问密码不对");

    let data = null;
    try { data = await res.json(); } catch { /* 空响应 */ }
    if (!res.ok) {
      const d = data && data.detail;
      throw new Error(typeof d === "string" ? d : `HTTP ${res.status}`);
    }
    return data;
  }

  window.Ledger = {
    KEY, hasExt, CAT, CYCLE,
    esc, pad, fmtDate,
    read, write, withTimeout, normalizeBase, originPattern, hasHostPerm, api,
  };
})();
