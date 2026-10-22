/* __ccpp_push v4 — 侧边栏"推送到 Agent"
 * v4 修复：锚点定位失败（一直悬浮遮挡工具栏）
 *   原因："教学 Claude"是 icon-only 按钮（h-7 w-7 只有 SVG 图标），textContent 为空，
 *         v2/v3 按文本"教学"匹配永远落空 → 永远走悬浮兜底。
 *   修复：改用 aria-label 匹配（button[aria-label*="Teach"/"教学"]，与语言无关），
 *         内嵌时复用原按钮的 className（同款 h-7 w-7 图标样式），徽标显示暂存数；
 *         悬浮兜底改为可拖动（位置存 localStorage），不再固定遮挡底部按钮。
 * 保留 v3 的防循环四重保护：150ms 去抖 / disconnect 包裹 / 变更检测 / 熔断停火。
 */
(() => {
  "use strict";
  const WS_URL = "ws://127.0.0.1:19288";
  const OUTBOX_KEY = "ccpp_outbox";
  const POS_KEY = "ccpp_btn_pos";
  const OUTBOX_MAX = 20;
  const BTN_ID = "ccpp-push-btn";
  let ws = null, retryTimer = null;

  // ---------------- 离线暂存 ----------------
  function loadOutbox() {
    try { const a = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function saveOutbox(a) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(a.slice(-OUTBOX_MAX))); } catch { }
    updateBadge();
  }
  function queuePayload(p) {
    const a = loadOutbox();
    a.push(p);
    saveOutbox(a);
    return a.length;
  }
  function flushOutbox() {
    if (!ws || ws.readyState !== 1) return;
    const a = loadOutbox();
    let sent = 0;
    while (a.length) {
      try { ws.send(JSON.stringify({ type: "inbox_push", payload: a[0] })); a.shift(); sent++; }
      catch { break; }
    }
    if (sent) { saveOutbox(a); toast(`已补发 ${sent} 条暂存内容到 Agent 收件箱`); }
    updateBadge();
  }
  function pendingCount() { return loadOutbox().length; }

  // ---------------- WebSocket（指数退避重连，零轮询） ----------------
  let backoff = 5000;
  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket(WS_URL); } catch { return schedule(); }
    ws.onopen = () => { backoff = 5000; updateBadge(); flushOutbox(); };
    ws.onclose = () => { ws = null; updateBadge(); schedule(); };
    ws.onerror = () => { try { ws.close(); } catch { } };
  }
  function schedule() {
    if (retryTimer) return;
    const d = backoff; // 5s→10s→20s→…封顶 60s，每次仅一次 TCP 握手尝试
    backoff = Math.min(backoff * 2, 60000);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, d);
  }
  try { connect(); } catch { }

  // ---------------- 对话提取（启发式） ----------------
  function extractConversation() {
    const candidates = document.querySelectorAll(
      '[class*="message"], [class*="Message"], [data-message], [class*="chat-item"]'
    );
    const parts = [];
    candidates.forEach((el) => {
      const t = (el.innerText || "").trim();
      if (t && t.length > 1 && !parts.includes(t)) parts.push(t);
    });
    if (parts.length < 2) {
      let best = null, bestLen = 0;
      document.querySelectorAll("main, [class*='chat'], [class*='conversation'], [class*='scroll'], div").forEach((el) => {
        const t = (el.innerText || "").trim();
        if (t.length > bestLen && el.scrollHeight > el.clientHeight + 50) { best = t; bestLen = t.length; }
      });
      if (best) return best;
      return (document.body.innerText || "").trim();
    }
    return parts.join("\n\n---\n\n");
  }

  // ---------------- UI ----------------
  function toast(text, ok = true) {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText =
      "position:fixed;right:16px;bottom:64px;z-index:99999;padding:8px 12px;border-radius:10px;" +
      `background:${ok ? "#141413" : "#b91c1c"};color:#fff;font:13px/1.3 sans-serif;max-width:280px;` +
      "box-shadow:0 2px 10px rgba(0,0,0,.2);transition:opacity .4s";
    document.body.appendChild(d);
    setTimeout(() => { d.style.opacity = "0"; setTimeout(() => d.remove(), 500); }, 2400);
  }

  // 变更检测：状态没变就不碰 DOM（写 DOM 会触发 MutationObserver，v2 死循环的教训）
  let lastState = null;
  function resetBadgeCache() { lastState = null; }
  function updateBadge() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const n = pendingCount();
    const online = !!(ws && ws.readyState === 1);
    if (lastState && lastState.n === n && lastState.online === online) return;
    lastState = { n, online };
    const badge = btn.querySelector("[data-badge]");
    if (badge) {
      badge.style.display = n > 0 ? "block" : "none";
      if (n > 0) badge.textContent = String(n);
    }
    btn.style.opacity = online ? "" : ".55";
    btn.title =
      (online ? "推送当前对话到 Agent 收件箱" : "桥未连接（Agent 未启动）——点击先暂存，连上自动补发") +
      (n ? `（已存 ${n} 条）` : "");
  }

  function doPush() {
    const text = extractConversation();
    if (!text || text.length < 2) return toast("没有可推送的对话内容", false);
    const payload = {
      title: document.title || "侧边栏对话",
      url: "sidepanel://chat",
      text: text.slice(0, 400 * 1024),
      source: "sidepanel",
      ts: Date.now(),
    };
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "inbox_push", payload }));
        return toast(`已推送对话到 Agent 收件箱（${text.length} 字）`);
      } catch { /* 落入暂存 */ }
    }
    const n = queuePayload(payload);
    toast(`Agent 桥未连接——已暂存（${n} 条），连上后自动补发`, true);
    updateBadge();
  }

  // ---------------- 悬浮球拖动 ----------------
  function restorePos(btn) {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch { }
    if (p && typeof p.left === "number" && typeof p.top === "number") {
      btn.style.left = p.left + "px";
      btn.style.top = p.top + "px";
    } else {
      btn.style.right = "12px"; // 默认右缘垂直居中，不遮挡底部工具栏
      btn.style.top = "45%";
    }
  }
  function attachDrag(btn) {
    btn.addEventListener("pointerdown", (e) => {
      if (!btn.dataset.floating) return;
      const r = btn.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
        moved = true;
        btn.dataset.dragged = "1";
        btn.style.left = (ev.clientX - ox) + "px";
        btn.style.top = (ev.clientY - oy) + "px";
        btn.style.right = "auto";
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (moved) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({
              left: parseInt(btn.style.left, 10) || 0,
              top: parseInt(btn.style.top, 10) || 0,
            }));
          } catch { }
        }
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      e.preventDefault();
    });
  }

  function makeButton(embedded, className) {
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    const icon = document.createElement("span");
    icon.textContent = "⤴";
    icon.style.cssText = "pointer-events:none;font-size:13px";
    const badge = document.createElement("span");
    badge.setAttribute("data-badge", "1");
    badge.style.cssText =
      "display:none;position:absolute;top:-5px;right:-5px;background:#dc2626;color:#fff;" +
      "border-radius:9999px;font:600 9px/12px sans-serif;min-width:12px;height:12px;" +
      "text-align:center;padding:0 2px;pointer-events:none;z-index:1";
    btn.appendChild(icon);
    btn.appendChild(badge);
    if (embedded) {
      btn.className = className || ""; // 复用"教学 Claude"按钮同款样式（h-7 w-7 relative …）
      btn.style.marginRight = "4px";
    } else {
      btn.dataset.floating = "1";
      btn.style.cssText =
        "position:fixed;z-index:99999;width:34px;height:34px;border-radius:50%;" +
        "border:1px solid #d4d4d0;background:#fff;color:#141413;font:600 15px/1 sans-serif;" +
        "box-shadow:0 2px 10px rgba(0,0,0,.15);cursor:grab;opacity:.9;" +
        "display:flex;align-items:center;justify-content:center;";
      restorePos(btn);
      attachDrag(btn);
    }
    btn.addEventListener("click", () => {
      if (btn.dataset.dragged) { delete btn.dataset.dragged; return; } // 拖拽落下的那次 click 不算
      doPush();
    });
    return btn;
  }

  // ---------------- 锚点定位（aria-label，与语言无关） ----------------
  // "教学 Claude"是 icon-only 按钮（textContent 为空，只有 aria-label），这是 v3 找不到它的原因
  const TEACH_SEL = 'button[aria-label*="Teach" i], button[aria-label*="教学"]';
  const ACTIONS_SEL = 'button[aria-label*="Actions" i], button[aria-label*="操作"]';
  function findAnchor() {
    const btnEl = document.querySelector(TEACH_SEL) || document.querySelector(ACTIONS_SEL);
    if (!btnEl) return null;
    // 若按钮被 Tooltip 的 SPAN 单层包住，锚定包装层：插在它左边，而不是挤进包装里
    let anchor = btnEl, hops = 0;
    while (
      hops < 2 &&
      anchor.parentElement &&
      anchor.parentElement.tagName === "SPAN" &&
      anchor.parentElement.childElementCount === 1
    ) {
      anchor = anchor.parentElement;
      hops++;
    }
    return { anchor, btnEl };
  }

  // ---------------- 注入（全套防循环保护） ----------------
  let mo = null, injecting = false, debounceTimer = null;
  let injectTimes = [];    // 熔断统计
  let mutedUntil = 0;

  function circuitOpen() {
    const now = Date.now();
    if (now < mutedUntil) return true;
    injectTimes = injectTimes.filter((t) => now - t < 15000);
    if (injectTimes.length >= 20) { // 宿主页面在反复移除我们的按钮：停火 60s，绝不打架
      mutedUntil = now + 60000;
      injectTimes = [];
      console.warn("[ccpp-push] 宿主页面频繁重绘工具栏，暂停重插 60s（不影响页面）");
      return true;
    }
    return false;
  }

  function embedButton(found) {
    const btn = makeButton(true, found.btnEl.className);
    found.anchor.parentElement.insertBefore(btn, found.anchor);
    return btn;
  }

  function inject() {
    if (circuitOpen() || !document.body) return;
    const existing = document.getElementById(BTN_ID);
    const found = findAnchor();
    if (existing) {
      // 已存在：若仍是悬浮态且工具栏锚点已出现，升级为工具栏内嵌
      if (existing.dataset.floating && found && found.anchor.parentElement) {
        existing.remove();
        embedButton(found);
        injectTimes.push(Date.now());
        resetBadgeCache();
        updateBadge();
      } else {
        updateBadge();
      }
      return;
    }
    if (found && found.anchor.parentElement) {
      embedButton(found);
    } else {
      document.body.appendChild(makeButton(false)); // 找不到工具栏：可拖动悬浮球兜底
    }
    injectTimes.push(Date.now());
    resetBadgeCache();
    updateBadge();
  }

  function onMutation() {
    if (debounceTimer) return; // 去抖：React 一次重渲染产生的大量突变只处理一回
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (injecting) return;
      const btn = document.getElementById(BTN_ID);
      if (btn && !btn.dataset.floating) return; // 稳定内嵌态：什么都不做（关键：别碰 DOM）
      injecting = true;
      try {
        if (mo) mo.disconnect(); // 先断开：接下来的 DOM 修改绝不会再触发自己
        inject();
      } catch { }
      finally {
        injecting = false;
        try { if (mo && document.body) mo.observe(document.body, { childList: true, subtree: true }); } catch { }
      }
    }, 150);
  }

  function start() {
    try { inject(); } catch { }
    if (!document.body) return;
    mo = new MutationObserver(onMutation);
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch { }
  }

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  } catch (e) {
    console.warn("[ccpp-push] 初始化失败（不影响页面）:", e);
  }
})();
