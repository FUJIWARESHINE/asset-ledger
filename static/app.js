/* ============================================================
   资产统计 · 前端逻辑
   主视图：平台 → 账号 → 资产 三级分组
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* 折叠状态落 localStorage：刷新后平台 / 账号的折叠位置保持不变。
   值形如 { platforms: ["Cloudflare"], accounts: ["Cloudflare|3"] }。 */
const FOLD_KEY = "al-folded";
function loadFolded() {
  const empty = { plats: new Set(), accs: new Set() };
  try {
    const o = JSON.parse(localStorage.getItem(FOLD_KEY) || "null");
    if (!o || typeof o !== "object") return empty;
    return {
      plats: new Set(Array.isArray(o.platforms) ? o.platforms : []),
      accs: new Set(Array.isArray(o.accounts) ? o.accounts : []),
    };
  } catch (_) {
    return empty;
  }
}
function saveFolded() {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify({
      platforms: [...state.collapsedPlatforms],
      accounts: [...state.collapsedAccounts],
    }));
  } catch (_) {}
}

/* 滚动位置：记在 sessionStorage（每个标签页独立，刷新会保留、换标签不串）。
   数据是异步渲染出来的，所以恢复必须放在 refresh() 之后，否则页面还没高度，scrollTo 会被夹回 0。 */
const SCROLL_KEY = "al-scroll";
let scrollTick = 0;
let scrollReady = false; // 首次恢复完成前不要写入，否则会被浏览器自带的 0 位置覆盖掉存档
function rememberScroll() {
  if (!scrollReady || scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    try { sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY))); } catch (_) {}
  });
}
function restoreScroll() {
  let y = 0;
  try { y = Number(sessionStorage.getItem(SCROLL_KEY)) || 0; } catch (_) {}
  if (!(y > 0)) return;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo(0, Math.min(y, max));
}
function restoreScrollSoon() {
  restoreScroll();
  requestAnimationFrame(() => {
    restoreScroll();
    // 字体/图片晚一步撑高时再校一次
    setTimeout(restoreScroll, 160);
  });
  scrollReady = true;
}

const folded0 = loadFolded();

const state = {
  tree: [],
  assets: [],
  q: "",
  cat: "all",
  platform: "all",
  provider: "all",
  // 域名托管状态：all / hosted（申请商有 + Cloudflare 也有）/ unhosted（只在申请商那边）
  host: "all",
  hostIndex: new Set(),
  view: localStorage.getItem("al-view") || "group",
  sort: localStorage.getItem("al-sort") || "smart",
  password: sessionStorage.getItem("al-pwd") || "",
  editingId: null,
  editingAccountId: null,
  // 正在重命名的平台名（弹层打开时非 null）
  renamingPlatform: null,
  // 复制模式下的模板资产（浅拷贝）。非 null 表示当前弹层是"复制"，保存会新建而不是覆盖。
  copySource: null,
  deleteTarget: null,
  collapsedPlatforms: folded0.plats,
  collapsedAccounts: folded0.accs,
  onlyUrgent: false,
  quickForAsset: false,
  // 账号内类别筛选：accountKey -> categoryId。
  // 只作用于这一个账号的资产列表，不碰全局 state.cat，也不影响别的账号。
  accCat: new Map(),
};

const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

/* 大小写不敏感的全量替换（不走正则，省得域名里的点在正则里变成通配符） */
function replaceCI(hay, needle, repl) {
  const h = String(hay).toLowerCase();
  const n = String(needle).toLowerCase();
  if (!n) return hay;
  let out = "", i = 0;
  while (true) {
    const k = h.indexOf(n, i);
    if (k < 0) return out + hay.slice(i);
    out += hay.slice(i, k) + repl;
    i = k + n.length;
  }
}

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
  // 同一家换过招牌时沿用原来的绿色：名字里含 digitalplat 的品牌都命中这条
  digitalplat: ["#1C6E52", "#4ED9A8"],
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
  // 允许「Xxx One」这类复合名命中已知品牌（如 digitalplat / namecheap）
  for (const k in PROVIDER_COLOR) if (key.includes(k)) return PROVIDER_COLOR[k][isDark() ? 1 : 0];
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
  state.hostIndex = buildHostIndex();
}

function allAccounts() {
  const out = [];
  for (const p of state.tree) for (const acc of p.accounts) if (acc.id !== null) out.push(acc);
  return out;
}

/* ---------------------------------------------------------------- 域名托管判定
   用户口径：申请商（免费域名提供方）有的域名，Cloudflare 下也有 → 已托管；
   只在申请商那边、Cloudflare 下没有 → 未托管。
   - 挂在 Cloudflare 账号下的域名，本身就在 CF 里，直接算已托管；
   - 挂在申请商账号下的域名，要按名字去 CF 的域名集合里比对。
   名字归一：小写 + 去掉协议与路径，避免 https://X.com/ 这种写法漏匹配。 */
function hostKeyOf(asset) {
  return String(asset.name || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "");
}
const isCloudflareAsset = (a) => /cloudflare/i.test(a.platform || "");
const isDomainAsset = (a) => a.category === "domain" || a.category === "subdomain";

function buildHostIndex() {
  const set = new Set();
  for (const a of state.assets) {
    if (isDomainAsset(a) && isCloudflareAsset(a)) set.add(hostKeyOf(a));
  }
  return set;
}

function domainHostState(a) {
  if (!isDomainAsset(a)) return null;
  if (isCloudflareAsset(a)) return "hosted";
  return state.hostIndex.has(hostKeyOf(a)) ? "hosted" : "unhosted";
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
      if (state.host !== "all") assets = assets.filter((a) => domainHostState(a) === state.host);
      if (state.onlyUrgent) assets = assets.filter((a) => ["expired", "urgent", "soon"].includes(a.expiry_state));
      if (q && !accHit) assets = assets.filter((a) => assetText(a).includes(q));

      const filtering = !!q || state.cat !== "all" || state.onlyUrgent ||
        state.provider !== "all" || state.host !== "all";
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

  // 域名托管状态：申请商有 + Cloudflare 也有 = 已托管；只在申请商那边 = 未托管
  const hostWrap = $("#hostChips");
  if (hostWrap) {
    let hosted = 0, unhosted = 0;
    for (const a of state.assets) {
      const hs = domainHostState(a);
      if (hs === "hosted") hosted++;
      else if (hs === "unhosted") unhosted++;
    }
    const total = hosted + unhosted;
    hostWrap.hidden = !total;
    if (total) {
      hostWrap.innerHTML = [
        `<button class="chip sm ${state.host === "all" ? "active" : ""}" data-host="all">${icon("globe")}全部域名<span class="chip-n">${total}</span></button>`,
        `<button class="chip sm ${state.host === "hosted" ? "active" : ""}" data-host="hosted" style="--c:${catColor("domain")}">${icon("check")}已托管<span class="chip-n">${hosted}</span></button>`,
        `<button class="chip sm ${state.host === "unhosted" ? "active" : ""}" data-host="unhosted" style="--c:#E08600">${icon("alert")}未托管<span class="chip-n">${unhosted}</span></button>`,
      ].join("");
    }
  }

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
    row.push(`<button class="chip sm chip-ghost" data-prov-rename="1" title="批量改申请商的名字（平台改名后没跟上时用这里）">${icon("edit")}改名</button>`);
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
  const hs = domainHostState(a);
  const tip = [
    a.name,
    a.expires_at ? "到期 " + a.expires_at : "",
    a.provider ? `申请 ${a.provider}${a.provider_account ? " / " + a.provider_account : ""}` : "",
    a.platform ? `托管 ${a.platform}${a.account ? " / " + a.account : ""}` : "",
    hs === "unhosted" ? "未托管：Cloudflare 下没有这个域名" : hs === "hosted" ? "已托管" : "",
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

/* 平台顺序：只有在「没开任何筛选、分组视图」时才允许拖 / 上移下移。
   一开筛选 DOM 里就不是全部平台了，按 DOM 顺序存会把被筛掉的位置弄乱。 */
function canReorderPlatforms() {
  return state.view === "group" && !state.q.trim() && state.cat === "all" &&
    state.platform === "all" && state.provider === "all" && state.host === "all" && !state.onlyUrgent;
}

function platformBlock(p) {
  const folded = state.collapsedPlatforms.has(p.platform);
  const r = p.roll || roll(p.accounts.flatMap((a) => a.assets));
  const col = platformColor(p.platform);
  const stats = [`<span class="ps"><b>${r.count}</b>资产</span>`];
  if (r.cny) stats.push(`<span class="ps"><b>${money(r.cny)}</b>年化</span>`);
  if (r.expiring) stats.push(`<span class="ps warn"><b>${r.expiring}</b>临近</span>`);
  if (r.expired) stats.push(`<span class="ps danger"><b>${r.expired}</b>过期</span>`);
  const reorderable = canReorderPlatforms() && p.platform !== "未归类";
  const tools = reorderable
    ? `<span class="plat-move">
         <button class="mini-icon" data-act="plat-up" data-platform="${esc(p.platform)}" title="上移一位"><svg class="up"><use href="#i-chev"/></svg></button>
         <button class="mini-icon" data-act="plat-down" data-platform="${esc(p.platform)}" title="下移一位"><svg><use href="#i-chev"/></svg></button>
       </span>
       <button class="mini-icon plat-grip" data-grip="1" title="拖动调整平台顺序"><svg><use href="#i-grip"/></svg></button>`
    : "";

  return `<section class="plat glass ${folded ? "folded" : ""}" data-platform="${esc(p.platform)}" style="--p:${col}">
    <header class="plat-head" role="button" tabindex="0" aria-expanded="${!folded}">
      <span class="plat-mark">${icon(platformIcon(p.platform))}</span>
      <div class="plat-id">
        <h3>${esc(p.platform)}${p.kind === "registrar" ? `<span class="plat-kind" title="域名申请商：改名会把资产的申请商一起带走">申请商</span>` : ""}</h3>
        <p>${p.account_count} 个账号${p.accounts.some((a) => a.id === null) ? " · 含未归属" : ""} · ${esc(catSummary(r.byCat))}</p>
      </div>
      <div class="plat-stats">${stats.join("")}</div>
      ${tools}
      ${p.platform === "未归类" ? "" : `<button class="mini-icon" data-act="rename-platform" data-platform="${esc(p.platform)}" title="重命名平台（账号与资产一起改）">${icon("edit")}</button>`}
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
  if (state.host !== "all") list = list.filter((a) => domainHostState(a) === state.host);
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
  // 标题跟着当前最强的那条筛选走：搜索 > 紧急 > 托管状态 > 平台 > 申请商 > 视图
  let title = state.view === "group" ? "按平台分组" : state.cat === "all" ? "全部资产" : catMeta(state.cat).label;
  if (state.provider !== "all") title = `${state.provider} 申请的资产`;
  if (state.platform !== "all") title = state.platform;
  if (state.host === "hosted") title = "已托管域名";
  if (state.host === "unhosted") title = "未托管域名";
  if (state.onlyUrgent) title = "需要处理";
  if (state.q) title = "搜索结果";
  $("#boardTitle").textContent = title;

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
  // 顺序跟主区分组保持一致（用户拖过就按拖的顺序，否则按后端的默认顺序）
  const rows = state.tree.map((p) => ({ name: p.platform, accounts: p.account_count, assets: p.asset_count }));
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

/* openSheet(asset, presetAccountId, { copy: true })
   复制模式：字段全部照抄来源资产，但不带 id —— 保存走 POST 生成新资产；
   归属账号可以在下拉里换成任意平台的任意账号，所以跨账号复制不用额外流程。 */
function openSheet(asset = null, presetAccountId = null, opts = {}) {
  const copy = !!asset && !!opts.copy;
  state.copySource = copy ? { ...asset } : null;
  const src = state.copySource || asset;
  state.editingId = asset && !copy ? asset.id : null;

  $("#sheetTitle").textContent = copy ? "复制资产" : asset ? "编辑资产" : "新增资产";
  $("#sheetSub").textContent = copy
    ? `以「${asset.name}」为模板，改掉名称 / 链接，或换一个归属账号`
    : asset
      ? `最后更新 ${(asset.updated_at || "").replace("T", " ")}`
      : "选好归属账号，平台会自动带出";

  // 复制模式不带 id：保存走 POST 生成新记录，别把来源的 id 留在表单里
  $("#f-id").value = copy ? "" : src?.id ?? "";
  $("#f-name").value = src?.name ?? "";
  $("#f-url").value = src?.url ?? "";
  $("#f-expires").value = src?.expires_at ?? "";
  $("#f-cycle").value = src?.cycle ?? "none";
  $("#f-cost").value = src?.cost ? src.cost : "";
  $("#f-currency").value = src?.currency ?? "CNY";
  $("#f-env").value = src?.environment ?? "prod";
  $("#f-status").value = src?.status ?? "active";
  $("#f-renew").checked = !!src?.auto_renew;
  $("#f-pinned").checked = !!src?.pinned;
  $("#f-cred").value = src?.credential_hint ?? "";
  $("#f-tags").value = src?.tags ?? "";
  $("#f-notes").value = src?.notes ?? "";
  $("#f-provider").value = src?.provider ?? "";
  $("#f-provider-acc").value = src?.provider_account ?? "";
  fillProviderList();

  fillAccountSelect(src?.account_id ?? presetAccountId ?? (allAccounts()[0]?.id ?? null));
  $("#accountHint").textContent = allAccounts().length
    ? "平台的统计口径跟着账号走，改账号就会换平台"
    : "还没有账号，先点右侧「新建」创建第一个";

  $("#catPicker").innerHTML = catPickerHTML(src?.category ?? "domain");
  $("#deleteBtn").hidden = !asset || copy;
  $("#copyBtn").hidden = !asset || copy;
  $("#saveBtn span").textContent = copy ? "保存副本" : "保存";

  const openHref = asset && !copy ? safeUrl(asset.url) : "";
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
    // 复制时名字就是要改的那一项，进来直接选中，敲字即覆盖
    setTimeout(() => {
      const nameEl = $("#f-name");
      nameEl.focus({ preventScroll: true });
      if (copy) nameEl.select();
    }, 260);
  });
}

function closeSheet() {
  const layer = $("#sheetLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 340);
  state.editingId = null;
  state.copySource = null;
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
      toast(state.copySource ? "已复制为新的资产" : "资产已添加");
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

/* ---------------------------------------------------------- 平台排序 */
/* 顺序存后端 settings.platform_order（谁在前谁在后），build_tree 按它排；
   没登记的平台排后面，按资产数降序兜底。 */
async function savePlatformOrder() {
  const names = [...$$("#groupBoard .plat")].map((el) => el.dataset.platform);
  if (!names.length) return;
  const rank = new Map(names.map((n, i) => [n, i]));
  const fallback = names.length + 1;
  state.tree.sort((a, b) =>
    (rank.has(a.platform) ? rank.get(a.platform) : fallback) - (rank.has(b.platform) ? rank.get(b.platform) : fallback));
  try {
    await api("/api/platforms/order", {
      method: "PUT",
      body: JSON.stringify({ order: state.tree.map((p) => p.platform) }),
    });
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  }
}

function movePlatform(name, dir) {
  const i = state.tree.findIndex((p) => p.platform === name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.tree.length) return;
  [state.tree[i], state.tree[j]] = [state.tree[j], state.tree[i]];
  renderBoard();
  savePlatformOrder();
}

/* ---------------------------------------------------------- 表单：平台重命名 */
/* 平台是账号 platform 聚合出来的，没有独立表；改名 = 把这批账号的 platform 统一换掉。
   后端会把资产上的 platform 投影一起刷，前端只需把本地筛选 / 折叠引用跟着挪。
   平台还有「属性」：域名申请商 registrar / 服务 service —— 只有申请商改名才动资产的 provider，
   否则改 Cloudflare 这种服务平台时会把挂在它名下的域名申请商一起改掉（用户明确担心过这点）。 */
function platKind() {
  return $("#platKind .kind-opt.active")?.dataset.kind || "service";
}

function syncPlatSyncLine() {
  const p = state.tree.find((x) => x.platform === state.renamingPlatform);
  const name = state.renamingPlatform || "";
  const provSame = state.assets.filter((a) => (a.provider || "").toLowerCase() === name.toLowerCase());
  const provLabel = [...new Set(provSame.map((a) => (a.provider || "").trim()))][0] || name;
  const isRegistrar = platKind() === "registrar";
  $("#platSyncLine").hidden = !isRegistrar || !provSame.length;
  $("#platSyncText").textContent = `同时把这 ${provSame.length} 项资产的申请商「${provLabel}」改成新名字`;
  $("#platHint").textContent = isRegistrar
    ? "申请商改名：账号、资产、以及资产上的申请商标记会一起换成新名字。"
    : "服务改名：只换平台名，挂在这个平台下的域名申请商不受影响。";
  if (p) $("#platSub").textContent = `${p.account_count} 个账号 · ${p.asset_count} 项资产 · ${isRegistrar ? "域名申请商" : "服务"}`;
}

function openRenamePlatform(name) {
  const p = state.tree.find((x) => x.platform === name);
  if (!p) return;
  state.renamingPlatform = name;
  $("#platTitle").textContent = "重命名平台";
  $("#p-name").value = name;
  const kind = p.kind === "registrar" ? "registrar" : "service";
  $$("#platKind .kind-opt").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  $("#platSyncProv").checked = true;
  syncPlatSyncLine();
  const layer = $("#platLayer");
  layer.hidden = false;
  requestAnimationFrame(() => {
    layer.classList.add("open");
    setTimeout(() => {
      const el = $("#p-name");
      el.focus({ preventScroll: true });
      el.select();
    }, 240);
  });
}

function closePlatSheet() {
  const layer = $("#platLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 340);
  state.renamingPlatform = null;
}

async function savePlatformName() {
  const from = state.renamingPlatform;
  if (!from) return;
  const to = $("#p-name").value.trim();
  if (!to) {
    const el = $("#p-name");
    el.focus();
    el.style.borderColor = "var(--red)";
    setTimeout(() => (el.style.borderColor = ""), 1600);
    toast("平台名不能为空", true);
    return;
  }
  const kind = platKind();
  const prevKind = state.tree.find((x) => x.platform === from)?.kind || "service";
  const renamed = to !== from;
  const kindChanged = kind !== prevKind;
  const btn = $("#platSave");
  btn.disabled = true;
  try {
    if (renamed || kindChanged) {
      // 只有域名申请商平台才允许同步申请商，服务平台的这个勾选根本不显示
      const syncProvider = kind === "registrar" && !$("#platSyncLine").hidden && $("#platSyncProv").checked;
      const r = await api(`/api/platforms/${encodeURIComponent(from)}/rename`, {
        method: "POST",
        body: JSON.stringify({ to, kind, sync_provider: syncProvider }),
      });
      // 本地引用跟着改名，否则筛选 / 折叠 / 账号内筛选会指向已经不存在的旧平台名
      if (renamed) {
        if (state.platform === from) state.platform = to;
        if (state.collapsedPlatforms.has(from)) {
          state.collapsedPlatforms.delete(from);
          state.collapsedPlatforms.add(to);
          saveFolded();
        }
        for (const key of [...state.collapsedAccounts]) {
          const [pfx, ...rest] = key.split("|");
          if (pfx !== from) continue;
          state.collapsedAccounts.delete(key);
          state.collapsedAccounts.add([to, ...rest].join("|"));
        }
        saveFolded();
        state.accCat.clear();
      }
      if (r.providers && state.provider.toLowerCase() === from.toLowerCase()) state.provider = to;
      await refresh();
      const tail = [
        r.merged ? "已合并同名平台" : "",
        r.providers ? `${r.providers} 项申请商一起改了` : "",
      ].filter(Boolean).join("，");
      toast(renamed ? `已改名为「${to}」${tail ? "，" + tail : ""}` : `平台属性已设为${kind === "registrar" ? "域名申请商" : "服务"}`);
    }
    closePlatSheet();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------- 表单：申请商改名 */
/* 申请商只是资产上的一个文本标记（哪家给的域名），与平台 / 账号无关，
   所以这里只刷 provider。用于「平台改过名、申请商还留着旧词」的补救。 */
function providerCounts() {
  const out = new Map();
  for (const a of state.assets) {
    const p = (a.provider || "").trim();
    if (p) out.set(p, (out.get(p) || 0) + 1);
  }
  return out;
}

function openRenameProvider(prefer) {
  const counts = providerCounts();
  if (!counts.size) {
    toast("还没有资产登记申请商", true);
    return;
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const pick = names.includes(prefer) ? prefer : names[0];
  $("#pv-from").innerHTML = names
    .map((n) => `<option value="${esc(n)}" ${n === pick ? "selected" : ""}>${esc(n)}（${counts.get(n)} 项）</option>`)
    .join("");
  $("#pv-to").value = pick;
  $("#provHint").textContent = "只改这一个标记，平台、账号、到期与费用都不动。";
  $("#provSub").textContent = `${counts.size} 个申请商正在使用`;
  const layer = $("#provLayer");
  layer.hidden = false;
  requestAnimationFrame(() => {
    layer.classList.add("open");
    setTimeout(() => {
      const el = $("#pv-to");
      el.focus({ preventScroll: true });
      el.select();
    }, 240);
  });
}

function closeProviderSheet() {
  const layer = $("#provLayer");
  layer.classList.remove("open");
  setTimeout(() => { layer.hidden = true; }, 340);
}

async function saveProviderName() {
  const from = $("#pv-from").value;
  const to = $("#pv-to").value.trim();
  if (!from) return;
  if (!to) {
    const el = $("#pv-to");
    el.focus();
    el.style.borderColor = "var(--red)";
    setTimeout(() => (el.style.borderColor = ""), 1600);
    toast("申请商名不能为空", true);
    return;
  }
  const btn = $("#provSave");
  btn.disabled = true;
  try {
    if (to.toLowerCase() !== from.toLowerCase()) {
      const r = await api(`/api/providers/${encodeURIComponent(from)}/rename`, {
        method: "POST",
        body: JSON.stringify({ to }),
      });
      if (state.provider.toLowerCase() === from.toLowerCase()) state.provider = to;
      await refresh();
      toast(`申请商已改为「${to}」，${r.assets} 项资产${r.merged ? "，已并入同名的现有申请商" : ""}`);
    }
    closeProviderSheet();
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
    // 「改名」是操作按钮，不是筛选项 —— 少了这个分支会把 state.provider 设成 undefined
    if (chip.dataset.provRename !== undefined) {
      openRenameProvider(state.provider !== "all" ? state.provider : null);
      return;
    }
    state.provider = chip.dataset.prov;
    state.accCat.clear();
    renderChips();
    renderBoard();
  });
  // 已托管 / 未托管：只看域名，别的类别跟着被筛掉
  $("#hostChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.host = chip.dataset.host;
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
      if (act === "rename-platform") {
        openRenamePlatform(actBtn.dataset.platform);
      }
      if (act === "plat-up" || act === "plat-down") {
        movePlatform(actBtn.dataset.platform, act === "plat-up" ? -1 : 1);
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
      saveFolded();
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
      saveFolded();
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

  // 平台拖拽排序：只有从抓手按下时卡片才变成可拖，否则点卡片 / 选文字都会误触
  let dragPlat = null;
  board.addEventListener("mousedown", (e) => {
    const plat = e.target.closest(".plat");
    if (plat) plat.draggable = !!e.target.closest("[data-grip]");
  });
  board.addEventListener("dragstart", (e) => {
    const plat = e.target.closest(".plat");
    if (!plat || !plat.draggable) { e.preventDefault(); return; }
    dragPlat = plat;
    plat.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", plat.dataset.platform); } catch (_) {}
  });
  board.addEventListener("dragover", (e) => {
    if (!dragPlat) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const over = e.target.closest(".plat");
    if (!over || over === dragPlat) return;
    // 超过目标卡片一半高度就插到它后面，视觉上跟着鼠标走
    const rect = over.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    over.parentNode.insertBefore(dragPlat, after ? over.nextSibling : over);
  });
  board.addEventListener("drop", (e) => { if (dragPlat) e.preventDefault(); });
  board.addEventListener("dragend", () => {
    if (!dragPlat) return;
    dragPlat.classList.remove("dragging");
    dragPlat.draggable = false;
    dragPlat = null;
    savePlatformOrder();
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
  // 编辑弹层里点「复制」→ 同一个弹层切成复制模式（字段照抄、不带 id）
  $("#copyBtn").addEventListener("click", () => {
    const asset = state.assets.find((a) => a.id === state.editingId);
    if (asset) openSheet(asset, null, { copy: true });
  });
  // 复制模式下链接跟着名称走：把链接里的旧名称换成新名称（大小写不敏感，
  // 因为台账里常见「DemoApp」配 https://demoapp.example 这种大小写不一致的写法）。
  // 只在「链接还没被手动改过」时生效，改了别处的链接不会被覆盖。
  $("#f-name").addEventListener("input", () => {
    const src = state.copySource;
    const urlEl = $("#f-url");
    if (!src || !src.url) return;
    if (urlEl.value !== src.url) return;
    const from = String(src.name || "").trim();
    const to = $("#f-name").value.trim();
    if (!from || !to) return;
    if (!src.url.toLowerCase().includes(from.toLowerCase())) return;
    urlEl.value = replaceCI(src.url, from, to);
    src.url = urlEl.value;
  });
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

  // 平台改名
  $("#platClose").addEventListener("click", closePlatSheet);
  $("#platCancel").addEventListener("click", closePlatSheet);
  $("#platSave").addEventListener("click", savePlatformName);
  $("#platForm").addEventListener("submit", (e) => { e.preventDefault(); savePlatformName(); });
  $("#p-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); savePlatformName(); } });
  // 平台属性：切到「服务」时把「同步申请商」的勾选收起来
  $("#platKind").addEventListener("click", (e) => {
    const b = e.target.closest(".kind-opt");
    if (!b) return;
    $$("#platKind .kind-opt").forEach((el) => el.classList.toggle("active", el === b));
    syncPlatSyncLine();
  });
  $$('#platLayer [data-close="plat"]').forEach((el) => el.addEventListener("click", closePlatSheet));

  // 申请商改名
  $("#provClose").addEventListener("click", closeProviderSheet);
  $("#provCancel").addEventListener("click", closeProviderSheet);
  $("#provSave").addEventListener("click", saveProviderName);
  $("#provForm").addEventListener("submit", (e) => { e.preventDefault(); saveProviderName(); });
  $("#pv-to").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveProviderName(); } });
  $("#pv-from").addEventListener("change", (e) => {
    // 换一个申请商时，新名字默认跟着回填，避免忘了改
    const v = e.target.value;
    $("#pv-to").value = v;
    const n = providerCounts().get(v) || 0;
    $("#provHint").textContent = `这一改动会影响 ${n} 项资产；平台、账号、到期与费用都不动。`;
  });
  $$('#provLayer [data-close="prov"]').forEach((el) => el.addEventListener("click", closeProviderSheet));

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
      if (!$("#platLayer").hidden) return closePlatSheet();
      if (!$("#provLayer").hidden) return closeProviderSheet();
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
    rememberScroll();
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
  // 数据渲染完、页面有真实高度了，再把上次的滚动位置还回去
  restoreScrollSoon();
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
