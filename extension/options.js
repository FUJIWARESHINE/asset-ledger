/* 设置页：地址 / 密码 / 权限申请 / 连通性测试
   权限对话框必须在标签页里弹（popup 会因失焦被关掉），所以授权逻辑只放在这里 */
(() => {
  "use strict";

  const L = window.Ledger;
  const { esc, hasExt } = L;
  const $ = (s) => document.querySelector(s);

  const S = { cfg: { baseUrl: "", password: "" }, queue: [], lastAccountId: null };

  function tip(text, kind) {
    const node = $("#msg");
    node.textContent = text || "";
    node.className = "tip" + (kind ? " " + kind : "");
  }

  async function refreshPerm() {
    const row = $("#permRow");
    const text = $("#permText");
    let base = "";
    try { base = L.normalizeBase($("#cfgUrl").value); } catch { /* 还没填完 */ }

    if (!base) {
      row.className = "perm";
      text.textContent = "填上地址后这里会显示授权状态";
      return;
    }
    const ok = await L.hasHostPerm(base);
    row.className = "perm " + (ok ? "ok" : "no");
    row.querySelector(".ic").innerHTML = ok ? `<use href="#i-check"/>` : `<use href="#i-warn"/>`;
    text.textContent = ok
      ? `已授权访问 ${new URL(base).origin}`
      : `还没授权 ${new URL(base).origin} — 点「授权并保存」会弹一次确认`;
  }

  async function save() {
    let base;
    try { base = L.normalizeBase($("#cfgUrl").value); }
    catch (e) { tip(e.message, "err"); return; }

    if (hasExt && chrome.permissions) {
      const origin = L.originPattern(base);
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ origins: [origin] });
        if (!granted) granted = await chrome.permissions.request({ origins: [origin] });
      } catch (e) {
        granted = false;
      }
      if (!granted) {
        tip("没拿到该地址的访问授权，扩展发不出请求。可以再点一次，或在扩展详情里手动勾选站点访问权限。", "err");
        await refreshPerm();
        return;
      }
    }

    S.cfg = { baseUrl: base, password: $("#cfgPwd").value };
    await L.withTimeout(L.write(S), 2000, null);
    await refreshPerm();

    // 存完顺手测一下，省得回 popup 才发现连不上
    tip("已保存，正在测试连接…");
    try {
      const meta = await L.api(S.cfg, "GET", "/api/meta");
      const acc = await L.api(S.cfg, "GET", "/api/accounts");
      const n = (acc.items || []).length;
      tip(`连接正常：${meta.title || "台账"}，${n} 个账号可用`, "ok");
    } catch (e) {
      tip("已保存，但连不上：" + e.message, "err");
    }
  }

  async function test() {
    let base;
    try { base = L.normalizeBase($("#cfgUrl").value); }
    catch (e) { tip(e.message, "err"); return; }
    const cfg = { baseUrl: base, password: $("#cfgPwd").value };
    tip("正在测试…");
    try {
      const meta = await L.api(cfg, "GET", "/api/meta");
      const acc = await L.api(cfg, "GET", "/api/accounts");
      tip(`连接正常：${meta.title || "台账"}，${(acc.items || []).length} 个账号可用`, "ok");
    } catch (e) {
      tip("连不上：" + e.message, "err");
    }
  }

  async function init() {
    const st = (await L.withTimeout(L.read(), 1500, null)) || {};
    S.cfg = (st.cfg && st.cfg.baseUrl)
      ? { baseUrl: st.cfg.baseUrl, password: st.cfg.password || "" }
      : { baseUrl: "", password: "" };
    S.queue = Array.isArray(st.queue) ? st.queue : [];
    S.lastAccountId = st.lastAccountId || null;

    const pre = new URLSearchParams(location.search).get("url");
    $("#cfgUrl").value = pre || S.cfg.baseUrl || "";
    $("#cfgPwd").value = S.cfg.password || "";

    $("#btnSave").addEventListener("click", save);
    $("#btnTest").addEventListener("click", test);
    $("#cfgUrl").addEventListener("change", refreshPerm);
    $("#cfgUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    $("#cfgPwd").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });

    await refreshPerm();
    if (pre) tip("地址已带入，确认无误后点「授权并保存」", "");
  }

  init();
})();
