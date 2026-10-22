/* ============================================================
   资产台账 · 快速录入 —— popup 逻辑
   设计前提：完全不读页面内容、不注入 content script、不抓 DOM。
   唯一从浏览器拿的是「当前标签页 URL」，而且只在点按钮时读一次。
   ============================================================ */
(() => {
  "use strict";

  const L = window.Ledger;
  const { CAT, CYCLE, esc, hasExt } = L;
  const $ = (s) => document.querySelector(s);

  const S = { cfg: { baseUrl: "", password: "" }, accounts: [], meta: null, queue: [], lastAccountId: null, queueOpen: false };

  const state = () => ({ cfg: S.cfg, queue: S.queue, lastAccountId: S.lastAccountId });
  const save = () => L.withTimeout(L.write(state()), 2000, null);

  function tip(el, text, kind) {
    const node = typeof el === "string" ? $(el) : el;
    if (!node) return;
    node.textContent = text || "";
    node.className = "tip" + (kind ? " " + kind : "");
  }

  function setConn(st, text) {
    $("#connDot").className = "dot" + (st ? " " + st : "");
    $("#connHint").textContent = text || "";
    $("#connHint").title = text || "";
  }

  /* ------------------------------------------------ 连接 */
  async function connect() {
    setConn("", "连接中…");
    const meta = await L.api(S.cfg, "GET", "/api/meta");
    S.meta = meta;
    $("#dlPlatform").innerHTML = (meta.platforms || []).map((p) => `<option value="${esc(p)}">`).join("");

    const acc = await L.api(S.cfg, "GET", "/api/accounts");
    S.accounts = acc.items || [];
    fillAccounts();
    setConn("on", (S.cfg.baseUrl || "").replace(/^https?:\/\//, ""));
  }

  function fillAccounts() {
    const sel = $("#fAccount");
    const keep = sel.value || (S.lastAccountId ? String(S.lastAccountId) : "");
    sel.innerHTML = `<option value="">未归属（不挂账号）</option>`;

    const byPlat = new Map();
    for (const a of S.accounts) {
      const p = (a.platform || "未归类").trim() || "未归类";
      if (!byPlat.has(p)) byPlat.set(p, []);
      byPlat.get(p).push(a);
    }
    for (const p of [...byPlat.keys()].sort((x, y) => x.localeCompare(y, "zh"))) {
      const g = document.createElement("optgroup");
      g.label = p;
      for (const a of byPlat.get(p)) {
        const label = a.label ? `${a.name} · ${a.label}` : a.name;
        g.appendChild(new Option(`${label}（${a.asset_count || 0}）`, String(a.id)));
      }
      sel.appendChild(g);
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    else sel.value = "";
  }

  /* ------------------------------------------------ 配置 */
  async function saveCfg() {
    let base;
    try { base = L.normalizeBase($("#cfgUrl").value); }
    catch (e) { tip("#cfgMsg", e.message, "err"); return; }

    // popup 里不能弹权限对话框（会失焦关闭），只检查已有授权
    if (!(await L.hasHostPerm(base))) {
      tip("#cfgMsg", "扩展还没得到这个地址的访问授权", "err");
      $("#btnOpenOptions").hidden = false;
      $("#btnOpenOptions").dataset.base = base;
      return;
    }

    S.cfg = { baseUrl: base, password: $("#cfgPwd").value };
    await save();
    $("#btnOpenOptions").hidden = true;
    tip("#cfgMsg", "已保存，正在连接…");

    try {
      await connect();
      tip("#cfgMsg", "");
      $("#main").dataset.ready = "1";
      $("#setup").hidden = true;
      $("#main").hidden = false;
    } catch (e) {
      tip("#cfgMsg", e.message, "err");
      setConn("err", e.message);
    }
  }

  function openOptions(base) {
    if (!hasExt || !chrome.tabs) return;
    const q = base ? "?url=" + encodeURIComponent(base) : "";
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html" + q) });
  }

  /* ------------------------------------------------ 表单 */
  function applyExpiry(kind) {
    const el = $("#fExpires");
    if (kind === "clear") { el.value = ""; return; }
    const base = el.value ? new Date(el.value + "T00:00:00") : new Date();
    const d = new Date(base);
    if (kind === "+30d") {
      d.setDate(d.getDate() + 30);
    } else {
      const day = d.getDate();
      d.setDate(1);
      if (kind === "+1y") d.setFullYear(d.getFullYear() + 1);
      else d.setMonth(d.getMonth() + 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
    }
    el.value = L.fmtDate(d);
  }

  async function grabCurrentUrl() {
    if (!hasExt || !chrome.tabs) {
      tip("#formMsg", "当前环境读不到标签页地址，请手动粘贴", "err");
      return;
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
        tip("#formMsg", "这个标签页没有可用地址", "err");
        return;
      }
      $("#fUrl").value = tab.url;
      if (!$("#fName").value.trim()) {
        const host = new URL(tab.url).hostname.replace(/^www\./, "");
        const generic = /^(dash\.cloudflare\.com|github\.com|vercel\.com|dash\.|console\.|localhost$|127\.)/i;
        if (host && !generic.test(host)) $("#fName").value = host;
      }
      tip("#formMsg", "");
    } catch {
      tip("#formMsg", "读取地址失败，请手动粘贴", "err");
    }
  }

  function collect() {
    const name = $("#fName").value.trim();
    if (!name) throw new Error("资产名称不能为空");
    const accId = $("#fAccount").value ? Number($("#fAccount").value) : null;
    const acc = accId ? S.accounts.find((a) => a.id === accId) : null;

    return {
      uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name,
      category: $("#fCategory").value,
      account_id: accId,
      url: $("#fUrl").value.trim(),
      environment: $("#fEnv").value,
      status: $("#fStatus").value,
      expires_at: $("#fExpires").value || "",
      auto_renew: $("#fRenew").checked,
      cost: Number($("#fCost").value || 0) || 0,
      currency: $("#fCurrency").value,
      cycle: $("#fCycle").value,
      credential_hint: $("#fCred").value.trim(),
      tags: $("#fTags").value.trim(),
      notes: $("#fNotes").value.trim(),
      provider: $("#fProvider").value.trim(),
      provider_account: $("#fProviderAcc").value.trim(),
      pinned: false,
      _platform: acc ? acc.platform : "",
      _account: acc ? acc.name : "",
    };
  }

  function toPayload(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) if (!k.startsWith("_") && k !== "uid") out[k] = v;
    return out;
  }

  function resetForm() {
    ["#fName", "#fUrl", "#fExpires", "#fCost", "#fCred", "#fProvider", "#fProviderAcc", "#fTags", "#fNotes"]
      .forEach((sel) => { $(sel).value = ""; });
    // 费用/周期/币种是一组，必须一起复位，否则上一条的 USD 会悄悄带到下一条
    $("#fCycle").value = "none";
    $("#fCurrency").value = "CNY";
    $("#fRenew").checked = false;
    $("#fName").focus();
  }

  async function addToQueue() {
    let item;
    try { item = collect(); }
    catch (e) { tip("#formMsg", e.message, "err"); return; }

    S.queue.push(item);
    if (item.account_id) S.lastAccountId = item.account_id;
    await save();
    renderResults([]);
    renderQueue();
    bumpQueue();
    tip("#formMsg", `已加入队列：${item.name}`, "ok");
    resetForm();
  }

  /* ------------------------------------------------ 队列 */
  // 队列默认折叠在徽章后面：表单位置固定不动，需要时点徽章展开
  function updateQueueVisibility() {
    const n = S.queue.length;
    const hasResults = !$("#results").hidden;
    $("#queueItems").hidden = n === 0;
    $("#queueChip").hidden = n === 0 && !hasResults;
    $("#queueN").textContent = n;
    $("#queueBox").hidden = !(S.queueOpen && (n > 0 || hasResults));
  }

  function bumpQueue() {
    const chip = $("#queueChip");
    chip.classList.remove("bump");
    void chip.offsetWidth;
    chip.classList.add("bump");
    setTimeout(() => chip.classList.remove("bump"), 520);
  }

  function renderQueue() {
    const n = S.queue.length;
    $("#queueCount").textContent = n;

    $("#qlist").innerHTML = S.queue.map((it) => {
      const c = CAT[it.category] || CAT.other;
      const bits = [it._platform || it._account ? esc(`${it._platform}${it._account ? " › " + it._account : ""}`) : "未归属", c[0]];
      if (it.expires_at) bits.push("到期 " + esc(it.expires_at));
      if (it.cost) bits.push(esc(`${it.currency} ${it.cost} ${CYCLE[it.cycle] || ""}`.trim()));
      return `<li class="qitem" data-uid="${it.uid}">
        <span class="cat-dot" style="background:${c[1]}"></span>
        <span class="qmain">
          <span class="qname">${esc(it.name)}</span>
          <span class="qmeta">${bits.join(" · ")}</span>
        </span>
        <button class="qdel" data-del="${it.uid}" title="从队列移除">
          <svg class="ic"><use href="#i-trash"/></svg>
        </button>
      </li>`;
    }).join("");

    updateQueueVisibility();
  }

  function renderResults(list) {
    const box = $("#results");
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = "";
      updateQueueVisibility();
      return;
    }
    box.hidden = false;
    box.innerHTML = list.map((r) => {
      if (r.kind === "ok") {
        return `<li><svg class="ic ok"><use href="#i-check"/></svg>
          <span><span class="rname">${esc(r.name)}</span> 已入库 #${r.id}</span></li>`;
      }
      if (r.kind === "skip") {
        return `<li><svg class="ic r-skip"><use href="#i-check"/></svg>
          <span><span class="rname">${esc(r.name)}</span> 台账里已有同名，跳过</span></li>`;
      }
      return `<li><svg class="ic err"><use href="#i-warn"/></svg>
        <span><span class="rname">${esc(r.name)}</span> 失败：${esc(r.error)}</span></li>`;
    }).join("");
    updateQueueVisibility();
  }

  /* ------------------------------------------------ 导入 */
  const dupKey = (accId, name) => `${accId || 0}|${String(name || "").trim().toLowerCase()}`;

  async function importAll() {
    if (!S.queue.length) return;
    const btn = $("#btnImport");
    btn.disabled = true;
    tip("#formMsg", "");
    renderResults([]);

    let existing = null;
    if ($("#optDupSkip").checked) {
      try { existing = await L.api(S.cfg, "GET", "/api/assets"); } catch { existing = null; }
    }
    const seen = new Set();
    if (existing) for (const a of existing.items || []) seen.add(dupKey(a.account_id, a.name));

    const result = [];
    const remain = [];
    const pending = [...S.queue];

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      const key = dupKey(item.account_id, item.name);
      if (existing && seen.has(key)) {
        result.push({ kind: "skip", name: item.name });
        continue;
      }
      try {
        const created = await L.api(S.cfg, "POST", "/api/assets", toPayload(item));
        result.push({ kind: "ok", name: item.name, id: created.id });
        if (existing) seen.add(key);
      } catch (e) {
        result.push({ kind: "err", name: item.name, error: e.message });
        remain.push(item);
        // 密码/连接类错误后面每条都会失败，直接停，别刷一屏
        if (/密码|连不上/.test(e.message)) {
          remain.push(...pending.slice(i + 1));
          break;
        }
      }
    }

    S.queue = remain;
    await save();
    renderQueue();
    renderResults(result);

    const okN = result.filter((r) => r.kind === "ok").length;
    const skipN = result.filter((r) => r.kind === "skip").length;
    const errN = result.filter((r) => r.kind === "err").length;
    tip("#formMsg",
      errN === 0
        ? `导入完成：新增 ${okN} 条${skipN ? `，跳过重复 ${skipN} 条` : ""}`
        : `新增 ${okN} 条，失败 ${errN} 条（失败的还在队列里）`,
      errN === 0 ? "ok" : "err");
    btn.disabled = false;

    if (okN) {
      try {
        const acc = await L.api(S.cfg, "GET", "/api/accounts");
        S.accounts = acc.items || [];
        fillAccounts();
      } catch { /* 忽略 */ }
    }
  }

  /* ------------------------------------------------ 新建账号 */
  function showNewAcc(on) {
    $("#newAcc").hidden = !on;
    if (on) $("#naPlatform").focus();
  }

  async function createAccount() {
    const platform = $("#naPlatform").value.trim();
    const name = $("#naName").value.trim();
    if (!platform || !name) { tip("#newAccMsg", "平台和账号标识都要填", "err"); return; }
    try {
      const acc = await L.api(S.cfg, "POST", "/api/accounts", {
        platform, name, label: "", url: "", status: "active", credential_hint: "", notes: "",
      });
      const list = await L.api(S.cfg, "GET", "/api/accounts");
      S.accounts = list.items || [];
      fillAccounts();
      $("#fAccount").value = String(acc.id);
      S.lastAccountId = acc.id;
      await save();
      $("#naPlatform").value = "";
      $("#naName").value = "";
      tip("#newAccMsg", "");
      showNewAcc(false);
      tip("#formMsg", `账号已建立：${platform} › ${name}`, "ok");
    } catch (e) {
      tip("#newAccMsg", e.message, "err");
    }
  }

  /* ------------------------------------------------ 事件 */
  function bind() {
    $("#btnGear").innerHTML = `<svg class="ic"><use href="#i-gear"/></svg>`;
    $("#btnGear").addEventListener("click", () => {
      const opening = $("#setup").hidden;
      $("#cfgUrl").value = S.cfg.baseUrl || "";
      $("#cfgPwd").value = S.cfg.password || "";
      tip("#cfgMsg", "");
      $("#btnOpenOptions").hidden = true;
      // 设置与录入是两块互斥的视图，同时显示会把表单挤下去
      $("#setup").hidden = !opening;
      $("#main").hidden = opening;
      $("#btnCancelCfg").hidden = !(opening && $("#main").dataset.ready === "1");
      if (opening) $("#cfgUrl").focus();
    });

    $("#btnSaveCfg").addEventListener("click", saveCfg);
    $("#btnCancelCfg").addEventListener("click", () => {
      $("#setup").hidden = true;
      $("#main").hidden = false;
      tip("#cfgMsg", "");
    });
    $("#btnOpenOptions").addEventListener("click", (e) => openOptions(e.currentTarget.dataset.base));

    document.querySelectorAll("[data-exp]").forEach((b) => {
      b.addEventListener("click", () => applyExpiry(b.dataset.exp));
    });

    $("#btnGrabUrl").addEventListener("click", grabCurrentUrl);
    $("#btnAdd").addEventListener("click", addToQueue);
    $("#btnImport").addEventListener("click", importAll);

    $("#btnNewAcc").addEventListener("click", () => showNewAcc($("#newAcc").hidden));
    $("#btnCancelAcc").addEventListener("click", () => showNewAcc(false));
    $("#btnCreateAcc").addEventListener("click", createAccount);

    // 徽章：展开/收起队列面板
    $("#queueChip").addEventListener("click", () => {
      S.queueOpen = !S.queueOpen;
      updateQueueVisibility();
      if (S.queueOpen) $("#queueBox").scrollIntoView({ block: "nearest" });
    });

    $("#btnClearQueue").addEventListener("click", async () => {
      S.queue = [];
      await save();
      renderResults([]);
      renderQueue();
      tip("#formMsg", "队列已清空", "");
    });

    $("#qlist").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-del]");
      if (!btn) return;
      S.queue = S.queue.filter((it) => it.uid !== btn.dataset.del);
      await save();
      renderQueue();
    });

    $("#fAccount").addEventListener("change", async () => {
      S.lastAccountId = $("#fAccount").value ? Number($("#fAccount").value) : null;
      await save();
    });

    // 域名类自动展开「更多」，方便填申请商
    $("#fCategory").addEventListener("change", () => {
      const v = $("#fCategory").value;
      if (v === "domain" || v === "subdomain") $("#moreBox").open = true;
    });

    // 名称/链接里回车 = 加入队列
    ["#fName", "#fUrl"].forEach((sel) => {
      $(sel).addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addToQueue(); }
      });
    });
  }

  /* ------------------------------------------------ 启动 */
  async function init() {
    bind();

    // 先把界面立起来，绝不因为存储层慢/异常而白屏
    $("#setup").hidden = false;
    $("#main").hidden = true;
    setConn("", "读取配置…");

    const st = (await L.withTimeout(L.read(), 1500, null)) || {};
    S.cfg = (st.cfg && st.cfg.baseUrl)
      ? { baseUrl: st.cfg.baseUrl, password: st.cfg.password || "" }
      : { baseUrl: "", password: "" };
    S.queue = Array.isArray(st.queue) ? st.queue : [];
    S.lastAccountId = st.lastAccountId || null;

    $("#cfgUrl").value = S.cfg.baseUrl || "";
    $("#cfgPwd").value = S.cfg.password || "";
    renderQueue();

    if (!S.cfg.baseUrl) {
      $("#setup").hidden = false;
      $("#main").hidden = true;
      setConn("", "未配置");
      $("#cfgUrl").focus();
      return;
    }

    $("#setup").hidden = true;
    $("#main").hidden = false;
    $("#main").dataset.ready = "1";

    try {
      await connect();
    } catch (e) {
      setConn("err", e.message);
      tip("#formMsg", e.message + "（点右上角齿轮改地址或密码）", "err");
    }
  }

  init();
})();
