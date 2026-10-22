/* ============================================================
   资产统计 · 前端逻辑
   主视图：平台 → 账号 → 资产 三级分组
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  tree: [],
  assets: [],
  q: "",
  cat: "all",
  platform: "all",
  provider: "all",
  view: localStorage.getItem("al-view") || "group",
  sort: localStorage.getItem("al-sort") || "smart",
  password: sessionStorage.getItem("al-pwd") || "",
  editingId: null,
  editingAccountId: null,
  deleteTarget: null,
  collapsedPlatforms: new Set(),
  collapsedAccounts: new Set(),
  onlyUrgent: false,
  quickForAsset: false,
  // 账号内类别筛选：accountKey -> categoryId。
  // 只作用于这一个账号的资产列表，不碰全局 state.cat，也不影响别的账号。
  accCat: new Map(),
};

const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const moneyFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const money = (n) => "¥" + moneyFmt.format(Math.round(n || 0));

function hexToRgba(hex, a) {
  const h = (hex || "#0A84FF").replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ---------------------------------------------------------- API */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.password) headers["X-App-Password"] = state.password;
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    showLock();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/* ---------------------------------------------------------- 工具 */
const cat = (id) =>
  state.meta.categories?.find((c) => c.id === id) ||
  { id: "other", label: "其他", icon: "dot", color: "#8E8E93", color_dark: "#9AA0B0" };
const isDark = () => document.documentElement.dataset.theme === "dark";
const catColor = (id) => {
  const c = cat(id);
  return isDark() ? c.color_dark || c.color : c.color;
};
const catMeta = (id) => cat(id);

const PLATFORM_ICONS = [
  ["github", "github"], ["gitee", "repo"], ["gitlab", "repo"],
  ["cloudflare", "cloud"], ["vercel", "tri"], ["netlify", "tri"],
  ["docker", "box"], ["阿里云", "cloud"], ["腾讯云", "cloud"], ["华为云", "cloud"],
  ["aws", "cloud"], ["azure", "cloud"], ["amazon", "cloud"],
  ["搬瓦工", "server"], ["vultr", "server"], ["digitalocean", "server"],
  ["namecheap", "globe"], ["porkbun", "globe"], ["godaddy", "globe"], ["namesilo", "globe"],
];
function platformIcon(name) {
  const n = (name || "").toLowerCase();
  for (const [key, ico] of PLATFORM_ICONS) if (n.includes(key)) return ico;
  return "cloud";
}

// 品牌色：固定映射比名字哈希更可预期（哈希会把 GitHub 变成粉色）
const BRAND_COLOR = {
  github: ["#24292F", "#D5DCE4"],
  gitee: ["#C0231F", "#FF7A75"],
  gitlab: ["#C2431E", "#FF8A5C"],
  cloudflare: ["#C8620A", "#FFA23D"],
  vercel: ["#22232A", "#E6E8EF"],
  netlify: ["#00786F", "#3AD9C6"],
  docker: ["#1B6FBF", "#5AB0F5"],
  "阿里云": ["#C85400", "#FF9350"],
  "腾讯云": ["#0059BE", "#59A3FF"],
  "华为云": ["#B00A22", "#FF7080"],
  aws: ["#B96B00", "#FFB84D"],
  azure: ["#0069BF", "#59B4FF"],
  "搬瓦工": ["#1A7C3F", "#45D07F"],
  vultr: ["#0F4F9E", "#66AEFF"],
  digitalocean: ["#0060E0", "#6BA8FF"],
  namecheap: ["#B32A1B", "#FF8270"],
  porkbun: ["#A63F26", "#FF9E7C"],
  godaddy: ["#0B7A60", "#41D2AE"],
  namesilo: ["#186296", "#66B8EC"],
};
function hashHue(str) {
  let h = 0;
  for (const ch of String(str || "x")) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function platformColor(name) {
  const key = String(name || "").toLowerCase();
  for (const k in BRAND_COLOR) {
    if (key.includes(k)) return BRAND_COLOR[k][isDark() ? 1 : 0];
  }
  return `hsl(${hashHue(name)} 60% ${isDark() ? 60 : 46}%)`;
}

/* 申请商配色：只给已知的几个固定色，不做名称哈希 */
const PROVIDER_COLOR = {
  dpdns: ["#1C6E52", "#4ED9A8"],
  dnshe: ["#6B3FC4", "#B18CFF"],
  "eu.org": ["#5A6072", "#A8AFC0"],
  cloudflare: ["#C8620A", "#FFA23D"],
  namecheap: ["#B32A1B", "#FF8270"],
  porkbun: ["#A63F26", "#FF9E7C"],
  namesilo: ["#186296", "#66B8EC"],
  "阿里云": ["#C85400", "#FF9350"],
  "腾讯云": ["#0059BE", "#59A3FF"],
};
function providerColor(name) {
  const key = String(name || "").toLowerCase();
  if (PROVIDER_COLOR[key]) return PROVIDER_COLOR[key][isDark() ? 1 : 0];
  return isDark() ? "#A8AFC0" : "#5A6072";
}

const hostOf = (url) => {
  if (!url) return "";
  try { return new URL(url).host.replace(/^www\./, ""); }
  catch (_) { return url.replace(/^https?:\/\//, "").replace(/\/$/, ""); }
};

// 只放行 http(s)：导入的备份里可能混进 javascript: / data: 这类协议
function safeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : "https://" + raw;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch (_) {
    return "";
  }
}

function openExternal(id) {
  const a = state.assets.find((x) => x.id === Number(id));
  const u = a ? safeUrl(a.url) : "";
  if (!u) { toast("这个资产还没填访问链接"); return; }
  window.open(u, "_blank", "noopener,noreferrer");
}

function expiryText(a) {
  if (a.days_left === null || a.days_left === undefined) return "无到期日";
  const d = a.days_left;
  if (d < 0) return `已过期 ${-d} 天`;
  if (d === 0) return "今天到期";
  if (d === 1) return "明天到期";
  return `${d} 天后到期`;
}
function expiryShort(a) {
  const d = a.days_left;
  if (d === null || d === undefined) return "";
  if (d < 0) return `过期 ${-d} 天`;
  if (d === 0) return "今天";
  return `${d} 天`;
}

function assetText(a) {
  return [a.name, a.url, a.tags, a.notes, a.credential_hint, a.platform, a.account,
    a.provider, a.provider_account]
    .join(" ").toLowerCase();
}

const EXPIRY_ORDER = { expired: 0, urgent: 1, soon: 2, ok: 3, none: 4 };
function sortAssets(list) {
  const key = {
    smart: (a, b) => (b.pinned - a.pinned) || (EXPIRY_ORDER[a.expiry_state] - EXPIRY_ORDER[b.expiry_state]) ||
      a.name.localeCompare(b.name, "zh-CN"),
    expiry: (a, b) => (a.days_left === null ? 1e9 : a.days_left) - (b.days_left === null ? 1e9 : b.days_left),
    name: (a, b) => a.name.localeCompare(b.name, "zh-CN"),
    cost: (a, b) => b.cost - a.cost,
  };
  return [...list].sort(key[state.sort] || key.smart);
}

function roll(assets) {
  const byCat = {};
  const costs = {};
  let expiring = 0, expired = 0;
  for (const a of assets) {
    byCat[a.category] = (byCat[a.category] || 0) + 1;
    if (a.days_left !== null && a.days_left >= 0 && a.days_left <= 30) expiring++;
    if (a.expiry_state === "expired") expired++;
    const y = a.cycle === "yearly" ? a.cost : a.cycle === "monthly" ? a.cost * 12 : 0;
    if (y) {
      const cur = (a.currency || "CNY").toUpperCase();
      costs[cur] = (costs[cur] || 0) + y;
    }
  }
  return { count: assets.length, byCat, costs, cny: costs.CNY || 0, expiring, expired };
}

/* ---------------------------------------------------------- 数据整理 */
function applyTree(data) {
  state.tree = data.platforms || [];
  state.assets = [];
  for (const p of state.tree) for (const acc of p.accounts) state.assets.push(...acc.assets);
}

function allAccounts() {
  const out = [];
  for (const p of state.tree) for (const acc of p.accounts) if (acc.id !== null) out.push(acc);
  return out;
}

/* ---------------------------------------------------------- 过滤 */
function filteredTree() {
  const q = state.q.trim().toLowerCase();
  const out = [];
  for (const p of state.tree) {
    if (state.platform !== "all" && p.platform !== state.platform) continue;
    const accounts = [];
    for (const acc of p.accounts) {
      const accText = [acc.name, acc.label, acc.notes, acc.url, acc.platform].join(" ").toLowerCase();
      const accHit = !!q && accText.includes(q);

      let assets = acc.assets;
      if (state.cat !== "all") assets = assets.filter((a) => a.category === state.cat);
      if (state.provider !== "all") assets = assets.filter((a) => (a.provider || "") === state.provider);
      if (state.onlyUrgent) assets = assets.filter((a) => ["expired", "urgent", "soon"].includes(a.expiry_state));
      if (q && !accHit) assets = assets.filter((a) => assetText(a).includes(q));

      const filtering = !!q || state.cat !== "all" || state.onlyUrgent || state.provider !== "all";
      if (!assets.length && filtering) continue;
      accounts.push({ ...acc, assets: sortAssets(assets), shown: assets.length });
    }
    if (!accounts.length) continue;
    const all = accounts.flatMap((a) => a.assets);
    out.push({ ...p, accounts, roll: roll(all) });
  }
  return out;
}

/* ---------------------------------------------------------- 渲染：统计 */
function animateNumber(el, to, isMoney = false) {
  if (!el) return;
  const from = Number(el.dataset.val || 0);
  el.dataset.val = to;
  const fmt = (n) => (isMoney ? money(n) : moneyFmt.format(Math.round(n)));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || Math.abs(from - to) < 0.5) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 720;
  setTimeout(() => { el.textContent = fmt(to); }, dur + 80);
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderStats() {
  const r = roll(state.assets);
  const platforms = state.tree.filter((p) => p.platform !== "未归类").length;
  const accounts = allAccounts().length;

  $$(".stat").forEach((card, i) => card.style.setProperty("--i", i));

  animateNumber($('[data-key="platforms"] .stat-value'), platforms);
  animateNumber($('[data-key="accounts"] .stat-value'), accounts);
  animateNumber($('[data-key="total"] .stat-value'), r.count);
  animateNumber($('[data-key="cost"] .stat-value'), r.cny, true);

  const top = state.tree.filter((p) => p.platform !== "未归类").sort((a, b) => b.asset_count - a.asset_count)[0];
  $('[data-key="platforms"] .stat-foot').textContent = top
    ? `最大：${top.platform} · ${top.asset_count} 项`
    : "还没有平台";
  $('[data-key="accounts"] .stat-foot').textContent =
    accounts ? `平均 ${(r.count / accounts).toFixed(1)} 项资产 / 账号` : "还没有账号";

  const foot = $('[data-key="total"] .stat-foot');
  const bits = [];
  if (r.expiring) bits.push(`${r.expiring} 项 30 天内到期`);
  if (r.expired) bits.push(`${r.expired} 项已过期`);
  foot.textContent = bits.length ? bits.join(" · ") : "全部在安全期内";
  foot.classList.toggle("warn", r.expired > 0);

  const others = Object.entries(r.costs).filter(([c]) => c !== "CNY");
  const sym = { USD: "$", EUR: "€", HKD: "HK$", JPY: "¥" };
  $('[data-key="cost"] .stat-foot').textContent = `月均 ${money(r.cny / 12)}` +
    (others.length ? ` · 另 ${others.map(([c, v]) => `${sym[c] || c}${moneyFmt.format(Math.round(v))}`).join(" / ")}` : "");
}

/* ---------------------------------------------------------- 渲染：筛选 */
function renderChips() {
  const counts = {};
  for (const a of state.assets) counts[a.category] = (counts[a.category] || 0) + 1;

  const items = [
    `<button class="chip ${state.cat === "all" ? "active" : ""}" data-cat="all">${icon("layers")}全部<span class="chip-n">${state.assets.length}</span></button>`,
  ];
  for (const c of state.meta.categories || []) {
    if (!counts[c.id]) continue;
    const col = isDark() ? c.color_dark || c.color : c.color;
    items.push(
      `<button class="chip ${state.cat === c.id ? "active" : ""}" data-cat="${c.id}" style="--c:${col}">${icon(c.icon)}${esc(c.label)}<span class="chip-n">${counts[c.id]}</span></button>`
    );
  }
  $("#categoryChips").innerHTML = items.join("");

  const plats = state.tree.filter((p) => p.platform !== "未归类");
  const sub = [`<button class="chip sm ${state.platform === "all" ? "active" : ""}" data-platform="all">${icon("cloud")}全部平台<span class="chip-n">${plats.length}</span></button>`];
  for (const p of plats) {
    const col = platformColor(p.platform);
    sub.push(
      `<button class="chip sm ${state.platform === p.platform ? "active" : ""}" data-platform="${esc(p.platform)}" style="--c:${col}">${icon(platformIcon(p.platform))}${esc(p.platform)}<span class="chip-n">${p.account_count}</span></button>`
    );
  }
  $("#platformChips").innerHTML = sub.join("");

  // 申请商是域名的第二个归属维度：点 dpdns 能看到挂在各个 CF 账号下的全部 dpdns 域名
  const provCounts = {};
  for (const a of state.assets) {
    const p = (a.provider || "").trim();
    if (p) provCounts[p] = (provCounts[p] || 0) + 1;
  }
  const provWrap = $("#providerChips");
  if (!provWrap) return;
  const provs = Object.keys(provCounts).sort();
  provWrap.hidden = !provs.length;
  if (provs.length) {
    const row = [`<button class="chip sm ${state.provider === "all" ? "active" : ""}" data-prov="all">${icon("key")}全部申请商<span class="chip-n">${provs.length}</span></button>`];
    for (const p of provs) {
      row.push(
        `<button class="chip sm ${state.provider === p ? "active" : ""}" data-prov="${esc(p)}" style="--c:${providerColor(p)}">${esc(p)}<span class="chip-n">${provCounts[p]}</span></button>`
      );
    }
    provWrap.innerHTML = row.join("");
  }
}

function renderAlertBar() {
  const r = roll(state.assets);
  const bar = $("#alertBar");
  if (!r.expiring && !r.expired) { bar.hidden = true; return; }
  bar.hidden = false;
  const parts = [];
  if (r.expired) parts.push(`${r.expired} 项已过期`);
  if (r.expiring) parts.push(`${r.expiring} 项 30 天内到期`);
  $("#alertText").textContent = parts.join("，");
  $("#alertAction").textContent = state.onlyUrgent ? "显示全部" : "只看这些";
  bar.classList.toggle("on", state.onlyUrgent);
}

/* ---------------------------------------------------------- 渲染：分组视图 */
function catSummary(byCat, limit = 3) {
  const entries = Object.entries(byCat || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "还没有资产";
  const head = entries.slice(0, limit).map(([id, n]) => `${catMeta(id).label} ${n}`).join(" · ");
  return entries.length > limit ? `${head} 等 ${entries.length} 类` : head;
}

/* 账号头右侧的类别徽章。点一下只筛这个账号自己，跟顶部 chips 的全局筛选是两回事：
   全局一点，别的账号也跟着少；这里只动当前账号的资产列表。 */
function catPills(byCat, accKey, activeCat, max = 4) {
  const entries = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  return entries
    .map(([id, n]) => {
      const c = catMeta(id);
      const on = activeCat === id;
      const tip = on ? "取消筛选，显示该账号下全部资产" : `只看该账号下的${c.label}（${n} 项）`;
      return `<button class="cat-pill ${on ? "is-on" : ""}" data-acc-cat="${id}"
          style="--c:${catColor(id)}" title="${esc(tip)}" aria-pressed="${on}">
          ${icon(c.icon)}<b>${n}</b>
          ${on ? `<svg class="cp-x"><use href="#i-close"/></svg>` : ""}
        </button>`;
    })
    .join("");
}

function assetTile(a) {
  const c = catMeta(a.category);
  const col = catColor(a.category);
  const bad = a.expiry_state === "expired";
  const soon = a.expiry_state === "urgent" || a.expiry_state === "soon";
  const go = safeUrl(a.url);
  const tip = [
    a.name,
    a.expires_at ? "到期 " + a.expires_at : "",
    a.provider ? `申请 ${a.provider}${a.provider_account ? " / " + a.provider_account : ""}` : "",
    a.platform ? `托管 ${a.platform}${a.account ? " / " + a.account : ""}` : "",
  ].filter(Boolean).join(" · ");
  return `<button class="ac ${bad ? "is-expired" : soon ? "is-soon" : ""}" data-asset="${a.id}"
      title="${esc(tip)}"
      style="--c:${col};--c-soft:${hexToRgba(col, 0.12)};--c-line:${hexToRgba(col, 0.2)}">
      <span class="ac-ico">${icon(c.icon)}</span>
      <span class="ac-name">${a.pinned ? `<svg class="pin"><use href="#i-pin"/></svg>` : ""}${esc(a.name)}</span>
      ${provChip(a, "tiny")}
      ${a.days_left !== null && a.days_left !== undefined
        ? `<span class="ac-day ${a.expiry_state}">${esc(expiryShort(a))}</span>` : ""}
      ${go ? `<span class="ac-go" data-go="${a.id}" title="打开 ${esc(hostOf(go))}"><svg><use href="#i-external"/></svg></span>` : ""}
    </button>`;
}

/* 账号备注压成一行短徽章：抹掉换行与重复空格，超出 max 字截断（全文留在 title）。 */
function noteBadge(text, max = 22) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/* 把账号下的资产按类别切片。顺序跟着 CATEGORIES 走（域名 → 二级域名 → 仓库 →
   Vercel → Workers → Pages …），这样同一个账号在每次刷新后分段位置都一致。 */
function categoryRank(id) {
  const list = state.meta.categories || [];
  const i = list.findIndex((c) => c.id === id);
  return i < 0 ? 999 : i;
}

function groupByCategory(assets) {
  const map = new Map();
  for (const a of assets) {
    if (!map.has(a.category)) map.set(a.category, []);
    map.get(a.category).push(a);
  }
  return [...map.entries()]
    .sort((x, y) => categoryRank(x[0]) - categoryRank(y[0]))
    .map(([id, items]) => ({ id, items }));
}

function accountBlock(acc, platform) {
  const key = acc.id === null ? `${platform}|orphan` : `${platform}|${acc.id}`;
  const folded = state.collapsedAccounts.has(key);
  const r = roll(acc.assets);
  // 账号备注压成一行短徽章放在右侧；全文留在 title 里
  const noteText = noteBadge(acc.notes);
  // 账号内的类别筛选：目标类别若已被全局筛选 / 搜索筛掉了，就当没选，避免出现空列表
  let activeCat = state.accCat.get(key) || null;
  if (activeCat && !acc.assets.some((a) => a.category === activeCat)) activeCat = null;
  const shown = activeCat ? acc.assets.filter((a) => a.category === activeCat) : acc.assets;

  const initial = (acc.label || acc.name || "?").trim().slice(0, 1).toUpperCase();
  const sub = [];
  sub.push(activeCat
    ? `<b>${shown.length}</b><span class="sub-of"> / ${r.count}</span> 项资产`
    : `<b>${r.count}</b> 项资产`);
  if (r.cny) sub.push(`年化 ${money(r.cny)}`);
  if (r.expiring) sub.push(`<span class="warn">${r.expiring} 项临近</span>`);
  if (r.expired) sub.push(`<span class="danger">${r.expired} 项过期</span>`);
  if (!acc.assets.length) sub.push(`<span class="muted">暂无资产</span>`);

  const addBtn = acc.id !== null
    ? `<button class="ac ac-add" data-act="add-asset" data-account="${acc.id}" title="在该账号下新增资产">${icon("plus")}<span>新增</span></button>`
    : "";

  // 多种类别混在一个账号里时按类别分段，每段前面一行小标题（本身就是类别切换按钮）。
  // 段头跨整行、磁贴共享同一个 grid，列宽才不会因为分段而错位。
  // 账号内筛选生效时只剩一类，就不再分段 —— 取消筛选的出口是账号头的类别徽章。
  const groups = groupByCategory(shown);
  let tiles;
  if (groups.length > 1) {
    const parts = [];
    groups.forEach((g, i) => {
      const meta = catMeta(g.id);
      const on = activeCat === g.id;
      parts.push(`<button class="ac-seg-head ${i ? "sep" : ""} ${on ? "is-on" : ""}" data-acc-cat="${g.id}"
          style="--c:${catColor(g.id)}"
          title="${on ? "取消筛选，显示该账号下全部资产" : `只看该账号下的${esc(meta.label)}（${g.items.length} 项）`}">
          <span class="ac-seg-ico">${icon(meta.icon)}</span>
          <span class="ac-seg-name">${esc(meta.label)}</span>
          <span class="ac-seg-n">${g.items.length}</span>
          ${on
            ? `<svg class="ac-seg-arrow is-x"><use href="#i-close"/></svg>`
            : `<svg class="ac-seg-arrow"><use href="#i-chev-right"/></svg>`}
        </button>`);
      parts.push(...g.items.map(assetTile));
    });
    parts.push(addBtn);
    tiles = parts.join("");
  } else {
    tiles = shown.map(assetTile).join("") + addBtn;
  }

  return `<div class="acc ${folded ? "folded" : ""}" data-acc="${esc(key)}">
    <div class="acc-head" role="button" tabindex="0" aria-expanded="${!folded}">
      <span class="acc-avatar" style="--p:${platformColor(platform)}">${esc(initial)}</span>
      <div class="acc-id">
        <div class="acc-line">
          <span class="acc-name" title="${esc(acc.name)}">${esc(acc.name)}</span>
          ${acc.label ? `<span class="acc-tag">${esc(acc.label)}</span>` : ""}
          ${acc.status !== "active" ? `<span class="acc-tag dim">${acc.status === "archived" ? "已归档" : "已停用"}</span>` : ""}
        </div>
        <div class="acc-sub">${sub.join('<i class="dot-sep"></i>')}</div>
      </div>
      <div class="acc-cats">
        ${noteText ? `<span class="acc-note" title="${esc(acc.notes)}">${esc(noteText)}</span>` : ""}
        ${catPills(r.byCat, key, activeCat)}
      </div>
      <div class="acc-tools">
        ${acc.id !== null ? `<button class="mini-icon" data-act="edit-account" data-account="${acc.id}" title="编辑账号">${icon("edit")}</button>` : ""}
        <button class="mini-icon acc-fold" tabindex="-1" aria-hidden="true">${icon("chev")}</button>
      </div>
    </div>
    <div class="acc-body"><div class="ac-grid">${tiles || `<div class="acc-empty">这个账号下还没有登记资产</div>`}</div></div>
  </div>`;
}

function platformBlock(p) {
  const folded = state.collapsedPlatforms.has(p.platform);
  const r = p.roll || roll(p.accounts.flatMap((a) => a.assets));
  const col = platformColor(p.platform);
  const stats = [`<span class="ps"><b>${r.count}</b>资产</span>`];
  if (r.cny) stats.push(`<span class="ps"><b>${money(r.cny)}</b>年化</span>`);
  if (r.expiring) stats.push(`<span class="ps warn"><b>${r.expiring}</b>临近</span>`);
  if (r.expired) stats.push(`<span class="ps danger"><b>${r.expired}</b>过期</span>`);

  return `<section class="plat glass ${folded ? "folded" : ""}" data-platform="${esc(p.platform)}" style="--p:${col}">
    <header class="plat-head" role="button" tabindex="0" aria-expanded="${!folded}">
      <span class="plat-mark">${icon(platformIcon(p.platform))}</span>
      <div class="plat-id">
        <h3>${esc(p.platform)}</h3>
        <p>${p.account_count} 个账号${p.accounts.some((a) => a.id === null) ? " · 含未归属" : ""} · ${esc(catSummary(r.byCat))}</p>
      </div>
      <div class="plat-stats">${stats.join("")}</div>
      <button class="plat-fold" tabindex="-1" aria-hidden="true">${icon("chev")}</button>
    </header>
    <div class="plat-body">${p.accounts.map((a) => accountBlock(a, p.platform)).join("")}</div>
  </section>`;
}

function renderGroupBoard(list) {
  $("#groupBoard").innerHTML = list.map(platformBlock).join("");
}

/* ---------------------------------------------------------- 渲染：平铺 */
function badgeFor(a) {
  if (a.expiry_state === "none") {
    return `<span class="badge none">${a.auto_renew ? "循环服务" : "无到期"}</span>`;
  }
  return `<span class="badge ${a.expiry_state}"><i class="bdot"></i>${expiryText(a)}</span>`;
}

function provChip(a, extra = "") {
  if (!a.provider) return "";
  const tip = `申请商：${a.provider}${a.provider_account ? "（" + a.provider_account + "）" : ""}`;
  const col = providerColor(a.provider);
  return `<span class="prov-chip ${extra}" title="${esc(tip)}" style="--pc:${col}">${esc(a.provider)}</span>`;
}

function assetCard(a, i) {
  const c = catMeta(a.category);
  const col = catColor(a.category);
  const tags = (a.tag_list || []).slice(0, 2).map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("");
  const host = hostOf(a.url);
  const go = safeUrl(a.url);
  const acc = a.provider_account ? `<span class="prov-sub">${esc(a.provider_account)}</span>` : "";
  return `<article class="asset" data-id="${a.id}" style="--i:${i};--c:${col};--c-soft:${hexToRgba(col, 0.13)};--c-line:${hexToRgba(col, 0.22)}" tabindex="0" role="button" aria-label="${esc(a.name)}">
    <div class="asset-icon">${icon(c.icon)}</div>
    <div class="asset-main">
      <div class="asset-name">${a.pinned ? `<svg class="pin"><use href="#i-pin"/></svg>` : ""}${esc(a.name)}</div>
      <div class="asset-meta"><span>${esc(a.platform || "未归类")}</span><i class="dot-sep"></i><span>${esc(a.account || "未归属")}</span></div>
      ${host ? `<div class="asset-sub">${esc(host)}</div>` : ""}
      ${a.provider ? `<div class="asset-prov">${provChip(a)}${acc}</div>` : ""}
    </div>
    <div class="asset-side">${badgeFor(a)}${tags ? `<div class="asset-tags">${tags}</div>` : ""}</div>
    ${go ? `<span class="asset-go" data-go="${a.id}" title="打开 ${esc(host)}"><svg><use href="#i-external"/></svg></span>` : ""}
  </article>`;
}

function flatAssets() {
  const q = state.q.trim().toLowerCase();
  let list = [...state.assets];
  if (state.cat !== "all") list = list.filter((a) => a.category === state.cat);
  if (state.platform !== "all") list = list.filter((a) => a.platform === state.platform);
  if (state.provider !== "all") list = list.filter((a) => (a.provider || "") === state.provider);
  if (state.onlyUrgent) list = list.filter((a) => ["expired", "urgent", "soon"].includes(a.expiry_state));
  if (q) {
    list = list.filter((a) => assetText(a).includes(q) ||
      [a.account, a.account].join(" ").toLowerCase().includes(q));
  }
  return sortAssets(list);
}

/* ---------------------------------------------------------- 渲染：搜索结果归属速览
   搜到一个域名，一行给出完整链路：申请商 / 申请账号 → 托管平台 / 托管账号 · 到期。
   托管方来自 account_id 反推的 platform/account，申请商是资产自身的 provider 字段。 */
function expiryHuman(a) {
  if (a.expires_at) return `${a.expires_at} · ${expiryText(a)}`;
  if ((a.notes || "").includes("永久")) return "永久有效";
  return "未设到期";
}

function renderProvenance() {
  const box = $("#provStrip");
  if (!box) return;
  const q = state.q.trim().toLowerCase();
  const hits = q ? state.assets.filter((a) => a.category === "domain" && assetText(a).includes(q)) : [];
  if (!hits.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const shown = hits.slice(0, 6);
  box.hidden = false;
  box.innerHTML = `
    <div class="prov-strip-head">
      ${icon("globe")}
      <span><b>${hits.length}</b> 个域名命中「${esc(state.q.trim())}」</span>
      <span class="prov-strip-hint">申请方 → 托管方 · 点一行看详情</span>
    </div>
    ${shown.map((a) => {
      const prov = a.provider || "未记申请商";
      return `<button class="prov-row" data-asset="${a.id}" tabindex="0">
        <span class="prov-domain">${esc(a.name)}</span>
        <span class="prov-chain">
          <span class="prov-step" title="申请商 / 申请商平台上的账号">
            <i>申请</i><b style="color:${providerColor(a.provider || "")}">${esc(prov)}</b><em>${esc(a.provider_account || "—")}</em>
          </span>
          <span class="prov-arrow">→</span>
          <span class="prov-step" title="托管平台 / 托管账号">
            <i>托管</i><b style="color:${platformColor(a.platform || "")}">${esc(a.platform || "未托管")}</b><em>${esc(a.account || "—")}</em>
          </span>
        </span>
        <span class="prov-exp">${esc(expiryHuman(a))}</span>
      </button>`;
    }).join("")}
    ${hits.length > shown.length ? `<div class="prov-more">还有 ${hits.length - shown.length} 个，缩小关键词继续找</div>` : ""}`;
}

/* ---------------------------------------------------------- 渲染：主视图 */
function renderBoard() {
  renderProvenance();
  const group = filteredTree();
  const count = group.reduce((n, p) => n + p.roll.count, 0);
  $("#boardCount").textContent = state.view === "group" ? count : flatAssets().length;
  $("#boardTitle").textContent = state.q
    ? "搜索结果"
    : state.onlyUrgent
      ? "需要处理"
      : state.platform !== "all"
        ? state.platform
        : state.provider !== "all"
          ? `${state.provider} 申请的资产`
          : state.view === "group"
            ? "按平台分组"
            : state.cat === "all" ? "全部资产" : catMeta(state.cat).label;

  // 分组视图下类别状态做成标题旁的可清除胶囊，避免筛选开着却看不出来
  const catPill = $("#catFilterPill");
  if (catPill) {
    const on = state.cat !== "all" && state.view === "group";
    catPill.hidden = !on;
    if (on) {
      const meta = catMeta(state.cat);
      catPill.style.setProperty("--c", catColor(state.cat));
      catPill.innerHTML = `${icon(meta.icon)}只看 ${esc(meta.label)}<svg class="cfp-x"><use href="#i-close"/></svg>`;
      catPill.title = "清除类别筛选";
    }
  }

  const groupBoard = $("#groupBoard");
  const grid = $("#assetGrid");
  const empty = $("#emptyState");

  if (state.view === "group") {
    groupBoard.hidden = false;
    grid.hidden = true;
    grid.innerHTML = "";
    if (!count) { groupBoard.innerHTML = ""; showEmpty(empty); return; }
    empty.hidden = true;
    renderGroupBoard(group);
    return;
  }

  const list = flatAssets();
  groupBoard.hidden = true;
  groupBoard.innerHTML = "";
  grid.hidden = false;
  grid.className = `asset-grid ${state.view === "list" ? "list" : ""}`;
  if (!list.length) { grid.innerHTML = ""; showEmpty(empty); return; }
  empty.hidden = true;
  grid.innerHTML = list.map(assetCard).join("");
}

function showEmpty(empty) {
  empty.hidden = false;
  const noData = state.assets.length === 0;
  empty.querySelector("h3").textContent = noData ? "还没有资产" : "没有匹配的结果";
  empty.querySelector("p").textContent = noData
    ? "先建平台账号，再把域名、仓库、Workers、Pages 挂到对应账号下，一个面板看清全部。"
    : "换个关键词、类别或平台试试，也可以直接新增。";
  $("#emptyAccountBtn").style.display = noData ? "" : "none";
}

/* ---------------------------------------------------------- 渲染：侧栏 */
function renderPlatformBars() {
  const rows = state.tree
    .map((p) => ({ name: p.platform, accounts: p.account_count, assets: p.asset_count }))
    .sort((a, b) => b.assets - a.assets);
  const max = Math.max(1, ...rows.map((r) => r.assets));

  $("#platformBars").innerHTML = rows.length
    ? rows.map((r, i) => `<div class="pb-row" data-platform="${esc(r.name)}" role="button" tabindex="0" title="${esc(r.name)}：${r.accounts} 个账号，${r.assets} 项资产">
        <span class="pb-ico" style="--p:${platformColor(r.name)}">${icon(platformIcon(r.name))}</span>
        <span class="pb-name">${esc(r.name)}<span class="pb-sub">${r.accounts} 账号</span></span>
        <span class="pb-track"><i class="pb-fill" style="width:${(r.assets / max) * 100}%;transition-delay:${i * 50}ms"></i></span>
        <span class="pb-n">${r.assets}</span>
      </div>`).join("")
    : `<div class="rail-empty">还没有平台数据</div>`;

  const totalAcc = allAccounts().length;
  $("#platformFoot").innerHTML =
    `<span>${rows.length} 个平台</span><span>${totalAcc} 个账号 · ${state.assets.length} 项资产</span>`;
}

function renderTimeline() {
  const soon = state.assets
    .filter((a) => a.days_left !== null && a.days_left <= 90)
    .sort((a, b) => a.days_left - b.days_left)
    .slice(0, 7);

  const box = $("#timeline");
  if (!soon.length) {
    box.innerHTML = `<div class="rail-empty">未来 90 天没有到期项目<br/>补上到期日就能在这里看到提醒</div>`;
    return;
  }
  box.innerHTML = soon.map((a) => {
    const st = a.expiry_state;
    const sub = st === "expired" ? "已过期" : a.expires_at;
    const days = a.days_left < 0 ? `+${-a.days_left}天` : a.days_left === 0 ? "今天" : `${a.days_left}天`;
    return `<div class="tl-item" data-id="${a.id}" data-state="${st}" role="button" tabindex="0">
      <div class="tl-body">
        <div class="tl-name">${esc(a.name)}</div>
        <div class="tl-sub">${esc(a.platform || "未归类")} · ${esc(sub)}</div>
      </div>
      <div class="tl-days ${st}">${st === "expired" ? "" : "剩 "}${days}</div>
    </div>`;
  }).join("");
}

/* ---------------------------------------------------------- 总渲染 */
function renderAll() {
  renderStats();
  renderChips();
  renderAlertBar();
  renderBoard();
  renderPlatformBars();
  renderTimeline();
  $("#footStats").textContent =
    `${state.tree.length} 个平台 · ${allAccounts().length} 个账号 · ${state.assets.length} 条资产`;
}

async function refresh() {
  try {
    const data = await api("/api/tree");
    applyTree(data);
    renderAll();
    fillDatalists();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  }
}

/* ---------------------------------------------------------- 表单：资产 */
function catPickerHTML(selected) {
  return (state.meta.categories || []).map((c) => {
    const col = catColor(c.id);
    return `<button type="button" class="cat-opt ${c.id === selected ? "active" : ""}" data-cat="${c.id}"
      style="--c:${col};--c-soft:${hexToRgba(col, 0.12)};--c-ring:${hexToRgba(col, 0.14)}">${icon(c.icon)}${esc(c.label)}</button>`;
  }).join("");
}

function fillDatalists() {
  const used = state.tree.map((p) => p.platform).filter((p) => p !== "未归类");
  const platforms = [...new Set([...(state.meta.platforms || []), ...used])].sort();
  $("#platformList").innerHTML = platforms.map((p) => `<option value="${esc(p)}">`).join("");

  const tags = [...new Set(state.assets.flatMap((a) => a.tag_list || []))].slice(0, 12);
  $("#tagSuggest").innerHTML = tags.map((t) => `<button type="button" class="tag-sug" data-tag="${esc(t)}">${esc(t)}</button>`).join("");
}

function fillAccountSelect(selectedId) {
  const groups = {};
  for (const p of state.tree) {
    for (const acc of p.accounts) {
      if (acc.id === null) continue;
      (groups[p.platform] = groups[p.platform] || []).push(acc);
    }
  }
  const opts = [];
  for (const platform of Object.keys(groups).sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    const accounts = groups[platform].sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name, "zh-CN"));
    opts.push(`<optgroup label="${esc(platform)}">`);
    for (const acc of accounts) {
      const label = `${acc.name}${acc.label ? " · " + acc.label : ""}（${acc.asset_count}）`;
      opts.push(`<option value="${acc.id}" ${acc.id === selectedId ? "selected" : ""}>${esc(label)}</option>`);
    }
    opts.push("</optgroup>");
  }
  opts.push(`<option value="" ${selectedId ? "" : "selected"}>未归属（不推荐）</option>`);
  $("#f-account").innerHTML = opts.join("");
}

function openSheet(asset = null, presetAccountId = null) {
  state.editingId = asset ? asset.id : null;
  $("#sheetTitle").textContent = asset ? "编辑资产" : "新增资产";
  $("#sheetSub").textContent = asset
    ? `最后更新 ${(asset.updated_at || "").replace("T", " ")}`
    : "选好归属账号，平台会自动带出";

  $("#f-id").value = asset?.id ?? "";
  $("#f-name").value = asset?.name ?? "";
  $("#f-url").value = asset?.url ?? "";
  $("#f-expires").value = asset?.expires_at ?? "";
  $("#f-cycle").value = asset?.cycle ?? "none";
  $("#f-cost").value = asset?.cost ? asset.cost : "";
  $("#f-currency").value = asset?.currency ?? "CNY";
  $("#f-env").value = asset?.environment ?? "prod";
  $("#f-status").value = asset?.status ?? "active";
  $("#f-renew").checked = !!asset?.auto_renew;
  $("#f-pinned").checked = !!asset?.pinned;
  $("#f-cred").value = asset?.credential_hint ?? "";
  $("#f-tags").value = asset?.tags ?? "";
  $("#f-notes").value = asset?.notes ?? "";
  $("#f-provider").value = asset?.provider ?? "";
  $("#f-provider-acc").value = asset?.provider_account ?? "";
  fillProviderList();

  fillAccountSelect(asset?.account_id ?? presetAccountId ?? (allAccounts()[0]?.id ?? null));
  $("#accountHint").textContent = allAccounts().length
    ? "平台的统计口径跟着账号走，改账号就会换平台"
    : "还没有账号，先点右侧「新建」创建第一个";

  $("#catPicker").innerHTML = catPickerHTML(asset?.category ?? "domain");
  $("#deleteBtn").hidden = !asset;

  const openHref = asset ? safeUrl(asset.url) : "";
  const openBtn = $("#openBtn");
  openBtn.hidden = !openHref;
  if (openHref) {
    openBtn.dataset.url = openHref;
    openBtn.title = openHref;
  }

  const layer = $("#sheetLayer");
  layer.hidden = false;
  requestAnimationFrame(() => {
    layer.classList.add("open");
    setTimeout(() => $("#f-name").focus({ preventScroll: true }), 260);
  });
}

function closeSheet() {
  const layer = $("#sheetLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 340);
  state.editingId = null;
}

function fillProviderList() {
  const list = $("#providerList");
  if (!list) return;
  const names = [...new Set(state.assets.map((a) => (a.provider || "").trim()).filter(Boolean))].sort();
  list.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}

function formPayload() {
  const name = $("#f-name").value.trim();
  if (!name) {
    $("#f-name").focus();
    $("#f-name").style.borderColor = "var(--red)";
    setTimeout(() => ($("#f-name").style.borderColor = ""), 1600);
    return null;
  }
  const selected = $("#catPicker .cat-opt.active");
  const accountVal = $("#f-account").value;
  return {
    name,
    category: selected?.dataset.cat || "other",
    account_id: accountVal ? Number(accountVal) : null,
    url: $("#f-url").value.trim(),
    environment: $("#f-env").value,
    status: $("#f-status").value,
    expires_at: $("#f-expires").value || "",
    auto_renew: $("#f-renew").checked,
    cost: Number($("#f-cost").value || 0),
    currency: $("#f-currency").value,
    cycle: $("#f-cycle").value,
    credential_hint: $("#f-cred").value.trim(),
    tags: $("#f-tags").value.trim(),
    notes: $("#f-notes").value.trim(),
    pinned: $("#f-pinned").checked,
    provider: $("#f-provider").value.trim(),
    provider_account: $("#f-provider-acc").value.trim(),
  };
}

async function saveAsset() {
  const payload = formPayload();
  if (!payload) return;
  const btn = $("#saveBtn");
  btn.disabled = true;
  try {
    if (state.editingId) {
      await api(`/api/assets/${state.editingId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("已保存修改");
    } else {
      await api("/api/assets", { method: "POST", body: JSON.stringify(payload) });
      toast("资产已添加");
    }
    closeSheet();
    await refresh();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------- 表单：账号 */
function openAccountSheet(account = null, forAsset = false) {
  state.editingAccountId = account ? account.id : null;
  state.quickForAsset = forAsset;
  $("#accTitle").textContent = account ? "编辑账号" : "新增账号";
  $("#accSub").textContent = account
    ? `${account.platform} · ${account.asset_count} 项资产`
    : "一个平台下可以有任意多个账号";
  $("#a-platform").value = account?.platform ?? (state.platform !== "all" ? state.platform : "");
  $("#a-name").value = account?.name ?? "";
  $("#a-label").value = account?.label ?? "";
  $("#a-url").value = account?.url ?? "";
  $("#a-status").value = account?.status ?? "active";
  $("#a-cred").value = account?.credential_hint ?? "";
  $("#a-notes").value = account?.notes ?? "";
  $("#accDelete").hidden = !account;

  const layer = $("#accLayer");
  layer.hidden = false;
  requestAnimationFrame(() => {
    layer.classList.add("open");
    setTimeout(() => $("#a-name").focus({ preventScroll: true }), 240);
  });
}

function closeAccountSheet() {
  const layer = $("#accLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 330);
  state.editingAccountId = null;
  state.quickForAsset = false;
}

async function saveAccount() {
  const platform = $("#a-platform").value.trim();
  const name = $("#a-name").value.trim();
  if (!platform || !name) {
    const bad = !platform ? $("#a-platform") : $("#a-name");
    bad.focus();
    bad.style.borderColor = "var(--red)";
    setTimeout(() => (bad.style.borderColor = ""), 1600);
    return;
  }
  const payload = {
    platform,
    name,
    label: $("#a-label").value.trim(),
    url: $("#a-url").value.trim(),
    status: $("#a-status").value,
    credential_hint: $("#a-cred").value.trim(),
    notes: $("#a-notes").value.trim(),
  };
  const btn = $("#accSave");
  btn.disabled = true;
  try {
    if (state.editingAccountId) {
      await api(`/api/accounts/${state.editingAccountId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("账号已更新");
    } else {
      const created = await api("/api/accounts", { method: "POST", body: JSON.stringify(payload) });
      toast("账号已创建");
      await refresh();
      if (state.quickForAsset) {
        fillAccountSelect(created.id);
        closeAccountSheet();
        return;
      }
    }
    closeAccountSheet();
    await refresh();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------- 删除确认 */
function askDelete(kind, target) {
  state.deleteTarget = { kind, target };
  if (kind === "backup") {
    $("#confirmTitle").textContent = `删除备份「${target.name}」？`;
    $("#confirmText").textContent = "这份快照会从磁盘上删掉，无法恢复。";
  } else if (kind === "account") {
    $("#confirmTitle").textContent = `删除账号「${target.name}」？`;
    $("#confirmText").textContent = target.asset_count
      ? `这个账号下的 ${target.asset_count} 项资产不会被删除，会变成「未归属」。`
      : "账号本身没有资产，可以放心删除。";
  } else {
    $("#confirmTitle").textContent = `删除「${target.name}」？`;
    $("#confirmText").textContent = "这条记录会从本机数据库永久移除，无法恢复。";
  }
  const layer = $("#confirmLayer");
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add("open"));
}

async function doDelete() {
  const t = state.deleteTarget;
  if (!t) return;
  try {
    if (t.kind === "backup") {
      const r = await api(`/api/backup/${encodeURIComponent(t.target.name)}`, { method: "DELETE" });
      renderBackupState(r);
      closeConfirm();
      toast("备份已删除");
      return;
    }
    if (t.kind === "account") {
      const r = await api(`/api/accounts/${t.target.id}`, { method: "DELETE" });
      toast(r.detached_assets ? `账号已删除，${r.detached_assets} 项资产转为未归属` : "账号已删除");
      closeAccountSheet();
    } else {
      await api(`/api/assets/${t.target.id}`, { method: "DELETE" });
      closeSheet();
      toast("已删除");
    }
    closeConfirm();
    await refresh();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  }
}

function closeConfirm() {
  const layer = $("#confirmLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 300);
  state.deleteTarget = null;
}

/* ---------------------------------------------------------- Toast */
function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${isError ? icon("close") : icon("check")}<span>${esc(msg)}</span>`;
  if (isError) el.querySelector("svg").style.color = "var(--red)";
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, 2400);
}

/* ---------------------------------------------------------- 主题 */
function setTheme(next) {
  document.documentElement.dataset.theme = next;
  localStorage.setItem("al-theme", next);
  $('meta[name="theme-color"]').setAttribute("content", next === "dark" ? "#06070b" : "#eef1f7");
  renderAll();
}

/* ---------------------------------------------------------- 密码 */
function showLock() {
  $("#lockLayer").hidden = false;
  setTimeout(() => $("#lockInput").focus(), 120);
}

async function tryUnlock() {
  const pwd = $("#lockInput").value;
  if (!pwd) return;
  $("#lockErr").textContent = "";
  state.password = pwd;
  try {
    await api("/api/tree");
    sessionStorage.setItem("al-pwd", pwd);
    $("#lockLayer").hidden = true;
    $("#lockInput").value = "";
    await boot(true);
  } catch (e) {
    state.password = "";
    $("#lockErr").textContent = "密码不正确";
    $("#lockInput").select();
  }
}

/* ---------------------------------------------------------- 导入导出 */
async function exportData() {
  try {
    const headers = state.password ? { "X-App-Password": state.password } : {};
    const res = await fetch("/api/export", { headers });
    if (!res.ok) throw new Error("导出失败");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `assets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("备份已下载");
  } catch (e) {
    toast(e.message, true);
  }
}

async function importData(file) {
  try {
    const json = JSON.parse(await file.text());
    const assets = Array.isArray(json) ? json : json.assets;
    const accounts = Array.isArray(json?.accounts) ? json.accounts : [];
    if (!Array.isArray(assets)) throw new Error("文件里没有 assets 数组");
    const r = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({ mode: "merge", accounts, assets }),
    });
    toast(`已导入 ${r.inserted} 条资产${r.accounts_created ? ` · 新建 ${r.accounts_created} 个账号` : ""}`);
    await refresh();
  } catch (e) {
    toast(e.message === "unauthorized" ? "请先解锁" : e.message, true);
  }
}

/* ---------------------------------------------------------- 示例数据 */
/* ---------------------------------------------------------- 定时备份 */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtStamp(iso) {
  return iso ? String(iso).replace("T", " ").slice(0, 16) : "—";
}

function renderBackupState(d) {
  const cfg = d.config || {};
  $("#bkEnabled").checked = !!cfg.enabled;
  $("#bkInterval").value = String(cfg.interval_hours);
  $("#bkKeep").value = cfg.keep;

  const items = d.items || [];
  const status = [`<span>上次 <b>${esc(fmtStamp(d.last_at))}</b></span>`];
  if (cfg.enabled) {
    status.push(d.next_at
      ? `<span>下次 <b>${esc(fmtStamp(d.next_at))}</b></span>`
      : `<span class="warn">等第一次跑完就有下次时间</span>`);
  } else {
    status.push(`<span class="warn">已关闭，不会自动备份</span>`);
  }
  status.push(`<span>共 <b>${items.length}</b> 份 · <b>${fmtSize(d.total_size)}</b></span>`);
  $("#bkStatus").innerHTML = status.join("");
  $("#bkDir").textContent = d.dir || "";
  $("#bkDir").title = d.dir || "";

  $("#bkList").innerHTML = items.length
    ? items.map((it) => `<div class="bk-row">
        <span class="bk-name" title="${esc(it.name)}">${esc(it.name)}</span>
        <span class="bk-meta">${esc(fmtStamp(it.created_at))} · ${fmtSize(it.size)}</span>
        <span class="bk-actions">
          <button class="mini-icon" data-bk-dl="${esc(it.name)}" title="下载这份备份">${icon("download")}</button>
          <button class="mini-icon" data-bk-del="${esc(it.name)}" title="删除这份备份">${icon("trash")}</button>
        </span>
      </div>`).join("")
    : `<div class="bk-empty">还没有备份，点左下角「立即备份」生成一份。</div>`;
}

async function openBackupSheet() {
  const layer = $("#backupLayer");
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add("open"));
  try {
    renderBackupState(await api("/api/backup"));
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  }
}

function closeBackupSheet() {
  const layer = $("#backupLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 300);
}

async function saveBackupConfig() {
  const keep = Math.max(1, Math.min(50, Number($("#bkKeep").value) || 7));
  $("#bkKeep").value = keep;
  try {
    const d = await api("/api/backup", {
      method: "PUT",
      body: JSON.stringify({
        enabled: $("#bkEnabled").checked,
        interval_hours: Number($("#bkInterval").value),
        keep,
      }),
    });
    renderBackupState(d);
    toast(d.removed && d.removed.length ? `已保存，顺手清理了 ${d.removed.length} 份旧备份` : "备份设置已保存");
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  }
}

async function runBackupNow() {
  const btn = $("#bkRun");
  btn.disabled = true;
  try {
    const d = await api("/api/backup/run", { method: "POST" });
    renderBackupState(d);
    toast(`已生成 ${d.created ? d.created.name : "备份"}`);
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function downloadBackup(name) {
  const headers = {};
  if (state.password) headers["X-App-Password"] = state.password;
  const res = await fetch(`/api/backup/download/${encodeURIComponent(name)}`, { headers });
  if (!res.ok) throw new Error("下载失败");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

/* ---------------------------------------------------------- 事件 */
function bind() {
  $("#themeBtn").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));
  $("#addBtn").addEventListener("click", () => openSheet());
  $("#addAccountBtn").addEventListener("click", () => openAccountSheet());
  $("#railAddAccount").addEventListener("click", () => openAccountSheet());
  $("#emptyAddBtn").addEventListener("click", () => openSheet());
  $("#emptyAccountBtn").addEventListener("click", () => openAccountSheet());

  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  document.addEventListener("click", () => (moreMenu.hidden = true));
  moreMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    moreMenu.hidden = true;
    if (btn.dataset.act === "export") exportData();
    if (btn.dataset.act === "import") $("#importFile").click();
    if (btn.dataset.act === "backup") openBackupSheet();
  });

  let timer;
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(timer);
    const v = e.target.value;
    timer = setTimeout(() => { state.q = v; renderBoard(); }, 110);
  });

  $("#categoryChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.cat = chip.dataset.cat;
    state.accCat.clear(); // 换全局视角时，账号内的局部筛选一并作废，免得「清了还在筛」
    renderChips();
    renderBoard();
  });
  const clearCat = () => {
    state.cat = "all";
    state.accCat.clear();
    renderChips();
    renderBoard();
  };
  $("#catFilterPill").addEventListener("click", clearCat);

  $("#platformChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.platform = chip.dataset.platform;
    state.accCat.clear();
    renderChips();
    renderBoard();
    $("#boardTitle").textContent = state.platform === "all" ? "按平台分组" : state.platform;
  });
  $("#providerChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.provider = chip.dataset.prov;
    state.accCat.clear();
    renderChips();
    renderBoard();
  });

  // 搜索结果里的归属速览：点一行打开该域名的详情
  $("#provStrip").addEventListener("click", (e) => {
    const row = e.target.closest(".prov-row[data-asset]");
    if (!row) return;
    const asset = state.assets.find((a) => a.id === Number(row.dataset.asset));
    if (asset) openSheet(asset);
  });

  $("#alertAction").addEventListener("click", () => {
    state.onlyUrgent = !state.onlyUrgent;
    state.accCat.clear();
    renderAlertBar();
    renderBoard();
  });

  $("#viewToggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    state.view = b.dataset.view;
    localStorage.setItem("al-view", state.view);
    syncViewButtons();
    renderBoard();
  });
  $("#sortSelect").addEventListener("change", (e) => {
    state.sort = e.target.value;
    localStorage.setItem("al-sort", state.sort);
    renderBoard();
  });

  // 分组区：平台折叠 / 账号折叠 / 资产与账号操作
  const board = $("#groupBoard");
  board.addEventListener("click", (e) => {
    const actBtn = e.target.closest("button[data-act]");
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === "edit-account") {
        const acc = allAccounts().find((a) => a.id === Number(actBtn.dataset.account));
        if (acc) openAccountSheet(acc);
      }
      if (act === "add-asset") {
        openSheet(null, Number(actBtn.dataset.account));
      }
      return;
    }
    // 账号头右侧的类别徽章 / 账号内段头：只筛「这一个账号」的资产列表。
    // 不能写成 state.cat —— 那是全局筛选，会把别的账号一起筛掉。
    const accCatHit = e.target.closest("[data-acc-cat]");
    if (accCatHit) {
      e.preventDefault();
      e.stopPropagation();
      const accEl = accCatHit.closest(".acc");
      const key = accEl && accEl.dataset.acc;
      if (key) {
        const id = accCatHit.dataset.accCat;
        if (state.accCat.get(key) === id) state.accCat.delete(key);
        else state.accCat.set(key, id);
        renderBoard();
      }
      return;
    }
    // 卡片右上/右侧的跳转热区：优先于「打开编辑」处理
    const goHit = e.target.closest("[data-go]");
    if (goHit) {
      e.preventDefault();
      e.stopPropagation();
      openExternal(goHit.dataset.go);
      return;
    }
    const tile = e.target.closest(".ac[data-asset]");
    if (tile) {
      const asset = state.assets.find((a) => a.id === Number(tile.dataset.asset));
      if (asset) openSheet(asset);
      return;
    }
    const accHead = e.target.closest(".acc-head");
    if (accHead) {
      const accEl = accHead.closest(".acc");
      const key = accEl.dataset.acc;
      if (state.collapsedAccounts.has(key)) state.collapsedAccounts.delete(key);
      else state.collapsedAccounts.add(key);
      accEl.classList.toggle("folded");
      accHead.setAttribute("aria-expanded", String(!accEl.classList.contains("folded")));
      return;
    }
    const platHead = e.target.closest(".plat-head");
    if (platHead) {
      const el = platHead.closest(".plat");
      const name = el.dataset.platform;
      if (state.collapsedPlatforms.has(name)) state.collapsedPlatforms.delete(name);
      else state.collapsedPlatforms.add(name);
      el.classList.toggle("folded");
      platHead.setAttribute("aria-expanded", String(!el.classList.contains("folded")));
    }
  });

  board.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest(".ac[data-asset]")) return;
    const head = e.target.closest(".acc-head, .plat-head");
    if (!head) return;
    e.preventDefault();
    head.click();
  });

  // 平铺视图
  $("#assetGrid").addEventListener("click", (e) => {
    const goHit = e.target.closest("[data-go]");
    if (goHit) {
      e.stopPropagation();
      openExternal(goHit.dataset.go);
      return;
    }
    const card = e.target.closest(".asset");
    if (!card) return;
    const asset = state.assets.find((a) => a.id === Number(card.dataset.id));
    if (asset) openSheet(asset);
  });

  // 侧栏平台筛选
  $("#platformBars").addEventListener("click", (e) => {
    const row = e.target.closest(".pb-row");
    if (!row) return;
    state.platform = state.platform === row.dataset.platform ? "all" : row.dataset.platform;
    renderChips();
    renderBoard();
  });

  // 时间线
  $("#timeline").addEventListener("click", (e) => {
    const item = e.target.closest(".tl-item");
    if (!item) return;
    const asset = state.assets.find((a) => a.id === Number(item.dataset.id));
    if (asset) openSheet(asset);
  });

  // 资产弹层
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#cancelBtn").addEventListener("click", closeSheet);
  $("#openBtn").addEventListener("click", () => {
    const u = $("#openBtn").dataset.url;
    if (u) window.open(u, "_blank", "noopener,noreferrer");
  });
  $("#saveBtn").addEventListener("click", saveAsset);
  $("#sheetBackdrop").addEventListener("click", closeSheet);
  $("#deleteBtn").addEventListener("click", () => {
    const asset = state.assets.find((a) => a.id === state.editingId);
    if (asset) askDelete("asset", asset);
  });
  $("#catPicker").addEventListener("click", (e) => {
    const opt = e.target.closest(".cat-opt");
    if (!opt) return;
    $$("#catPicker .cat-opt").forEach((o) => o.classList.toggle("active", o === opt));
  });
  $("#tagSuggest").addEventListener("click", (e) => {
    const b = e.target.closest(".tag-sug");
    if (!b) return;
    const input = $("#f-tags");
    const cur = input.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!cur.includes(b.dataset.tag)) cur.push(b.dataset.tag);
    input.value = cur.join(", ");
    input.focus();
  });
  $("#assetForm").addEventListener("submit", (e) => { e.preventDefault(); saveAsset(); });
  $("#quickAccount").addEventListener("click", () => openAccountSheet(null, true));

  // 账号弹层
  $("#accClose").addEventListener("click", closeAccountSheet);
  $("#accCancel").addEventListener("click", closeAccountSheet);
  $("#accSave").addEventListener("click", saveAccount);
  $("#accForm").addEventListener("submit", (e) => { e.preventDefault(); saveAccount(); });
  $$('#accLayer [data-close="acc"]').forEach((el) => el.addEventListener("click", closeAccountSheet));

  // 定时备份
  $("#bkClose").addEventListener("click", closeBackupSheet);
  $("#bkCancel").addEventListener("click", closeBackupSheet);
  $("#bkSave").addEventListener("click", saveBackupConfig);
  $("#bkRun").addEventListener("click", runBackupNow);
  $$('#backupLayer [data-close="backup"]').forEach((el) => el.addEventListener("click", closeBackupSheet));
  $("#bkList").addEventListener("click", (e) => {
    const dl = e.target.closest("[data-bk-dl]");
    if (dl) { downloadBackup(dl.dataset.bkDl).catch(() => toast("下载失败", true)); return; }
    const del = e.target.closest("[data-bk-del]");
    if (del) askDelete("backup", { name: del.dataset.bkDel });
  });
  $("#accDelete").addEventListener("click", () => {
    const acc = allAccounts().find((a) => a.id === state.editingAccountId);
    if (acc) askDelete("account", acc);
  });

  // 确认
  $("#confirmCancel").addEventListener("click", closeConfirm);
  $("#confirmOk").addEventListener("click", doDelete);
  $("#confirmLayer").querySelector(".confirm-backdrop").addEventListener("click", closeConfirm);

  // 锁
  $("#lockBtn").addEventListener("click", tryUnlock);
  $("#lockInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

  // 导入
  $("#importFile").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importData(f);
    e.target.value = "";
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === "Escape") {
      if (!$("#confirmLayer").hidden) return closeConfirm();
      if (!$("#backupLayer").hidden) return closeBackupSheet();
      if (!$("#accLayer").hidden) return closeAccountSheet();
      if (!$("#sheetLayer").hidden) return closeSheet();
      if (!moreMenu.hidden) moreMenu.hidden = true;
    }
    if (typing) return;
    if (e.key === "/") { e.preventDefault(); $("#searchInput").focus(); }
    if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openSheet(); }
    if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openAccountSheet(); }
  });

  window.addEventListener("scroll", () => {
    $("#topbar").classList.toggle("scrolled", window.scrollY > 8);
  }, { passive: true });
}

function syncViewButtons() {
  $$("#viewToggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
}

/* ---------------------------------------------------------- 启动 */
async function boot(afterUnlock = false) {
  try {
    const meta = await api("/api/meta");
    state.meta = meta;
    document.title = `${meta.title} · Cloud Asset Ledger`;
  } catch (e) {
    if (e.message === "unauthorized") return;
  }

  if (state.meta.requires_password && !state.password) {
    showLock();
    return;
  }

  $("#lockLayer").hidden = true;
  $("#appTitle").textContent = state.meta.title || "资产统计";
  syncViewButtons();
  $("#sortSelect").value = state.sort;
  await refresh();
}

bind();
boot().then(() => {
  if (location.hash === "#new") setTimeout(() => openSheet(), 380);
  else if (location.hash === "#account") setTimeout(() => openAccountSheet(), 380);
  else if (location.hash.startsWith("#id=")) {
    const id = Number(location.hash.slice(4));
    const asset = state.assets.find((a) => a.id === id);
    if (asset) setTimeout(() => openSheet(asset), 380);
  }
});
