const API = "/api/chat";

async function post(path, data) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (json.em) throw new Error(json.em);
  return json.data;
}

async function get(path) {
  const res = await fetch(`${API}${path}`);
  const json = await res.json();
  if (json.em) throw new Error(json.em);
  return json.data;
}

let conversations = [];
let activeConvId = null;
let activeNodeIdx = null;
let treeNodes = [];
let sending = false;
let currentUser = null;
let availableModels = [];
let selectedModelId = localStorage.getItem("selectedModel") || "";

const LANE_W = 24;
const ROW_H = 32;
const DOT_R = 6;
const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

function laneColor(i) { return COLORS[i % COLORS.length]; }

// --- Routing ---

function parseRoute() {
  const path = location.pathname;
  const convMatch = path.match(/^\/conv\/([^/]+)(?:\/([^/]+))?$/);
  if (convMatch) {
    return { page: "chat", convId: convMatch[1], nodeIdx: convMatch[2] || null };
  }
  if (path === "/settings") return { page: "settings" };
  return { page: "chat", convId: null, nodeIdx: null };
}

function navigateTo(path) {
  history.pushState(null, "", path);
  applyRoute();
}

async function applyRoute() {
  const route = parseRoute();

  if (route.page === "settings") {
    window.location.href = "/providers.html";
    return;
  }

  if (route.convId && route.convId !== activeConvId) {
    activeConvId = route.convId;
    activeNodeIdx = route.nodeIdx;
    await loadTree(activeConvId);
    if (!activeNodeIdx) {
      const withContent = treeNodes.filter(n => n.user_content);
      if (withContent.length) activeNodeIdx = withContent[withContent.length - 1].idx.toLowerCase();
    }
    if (activeNodeIdx) localStorage.setItem(`focus_${activeConvId}`, activeNodeIdx);
    renderSidebar();
    renderMessages();
  } else if (!route.convId && activeConvId) {
    activeConvId = null;
    activeNodeIdx = null;
    treeNodes = [];
    renderSidebar();
    renderMessages();
  }
}

window.addEventListener("popstate", () => applyRoute());

// --- Session ---

async function checkSession() {
  try {
    const res = await fetch("/api/auth/me");
    const json = await res.json();
    if (json.em === "unauthorized") { location.href = "/login"; return false; }
    currentUser = json.data;
    if (currentUser) document.getElementById("main-header-meta").textContent = currentUser.email;
    return true;
  } catch { location.href = "/login"; return false; }
}

// --- Models ---

async function loadModels() {
  try {
    const res = await fetch("/api/chat/models");
    const json = await res.json();
    if (json.em) return;
    availableModels = json.data || [];
    renderModelSelect();
  } catch {}
}

function renderModelSelect() {
  const select = document.getElementById("model-select");
  if (!availableModels.length) {
    select.innerHTML = '<option value="">No models</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = availableModels.map(m => {
    const label = m.display_name || m.model_id;
    const provider = m.provider_name ? ` (${m.provider_name})` : '';
    const defaultMark = m.is_default ? ' ★' : '';
    return `<option value="${m.model_id}" ${m.model_id === selectedModelId ? 'selected' : ''}>${label}${provider}${defaultMark}</option>`;
  }).join('');

  if (!selectedModelId && availableModels.length) {
    const defaultModel = availableModels.find(m => m.is_default) || availableModels[0];
    selectedModelId = defaultModel.model_id;
    select.value = selectedModelId;
  }
}

document.getElementById("model-select").onchange = (e) => {
  selectedModelId = e.target.value;
  localStorage.setItem("selectedModel", selectedModelId);
};

// --- Conversations ---

async function loadConversations() {
  conversations = await get("/list");
  renderSidebar();
}

function renderSidebar() {
  const tree = document.getElementById("tree");
  if (!conversations.length) {
    tree.innerHTML = '<div class="tree-empty">No conversations yet</div>';
    return;
  }

  const convListHtml = conversations.map(c =>
    `<div class="tree-item ${c.conv_id === activeConvId ? "active" : ""}" onclick="selectConv('${c.conv_id}')">
      <span class="tree-item-label">${esc(c.title || c.user_content || "Untitled")}</span>
    </div>`
  ).join("");

  if (activeConvId && treeNodes.length) {
    tree.innerHTML = `<div class="conv-list">${convListHtml}</div>
      <div class="tree-divider"></div>
      <div class="graph-wrap" id="graph-wrap">${renderGraph()}</div>`;
    scrollGraphToFocus();
  } else {
    tree.innerHTML = `<div class="conv-list">${convListHtml}</div>`;
  }
}

// --- SVG Graph ---

function renderGraph() {
  if (!treeNodes.length) return "";

  const laneMap = new Map();
  let maxLane = 0;

  // Build parent -> children map
  const childrenOf = new Map();
  for (const node of treeNodes) {
    const idx = node.idx.toLowerCase();
    const prefix = (node.prefix_idx || "").toLowerCase();
    const scatterFrom = node.scatter_from ? node.scatter_from.toLowerCase() : null;
    
    let parentId = null;
    if (scatterFrom) {
      parentId = scatterFrom;
    } else if (prefix) {
      parentId = prefix.slice(-4);
    }
    
    if (parentId) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(idx);
    }
  }

  // Assign lanes: first child inherits parent lane, subsequent children get new lanes
  const childIndex = new Map(); // track which child number we're on for each parent

  for (const node of treeNodes) {
    const idx = node.idx.toLowerCase();
    const prefix = (node.prefix_idx || "").toLowerCase();
    const scatterFrom = node.scatter_from ? node.scatter_from.toLowerCase() : null;

    if (scatterFrom) {
      const parentLane = laneMap.get(scatterFrom) ?? 0;
      const siblings = childrenOf.get(scatterFrom) || [];
      const myIndex = siblings.indexOf(idx);
      laneMap.set(idx, parentLane + 1 + (myIndex > 0 ? myIndex : 0));
    } else if (prefix) {
      const lastAncestor = prefix.slice(-4);
      const parentLane = laneMap.get(lastAncestor) ?? 0;
      const siblings = childrenOf.get(lastAncestor) || [];
      const myIndex = siblings.indexOf(idx);
      
      if (myIndex <= 0) {
        // First child: inherit parent lane
        laneMap.set(idx, parentLane);
      } else {
        // Subsequent children: offset to new lane
        laneMap.set(idx, parentLane + myIndex);
      }
    } else {
      laneMap.set(idx, 0);
    }
    maxLane = Math.max(maxLane, laneMap.get(idx));
  }

  const svgW = (maxLane + 2) * LANE_W + 280;
  const svgH = treeNodes.length * ROW_H + 16;

  let svg = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">`;

  const focusIdx = (activeNodeIdx || "").toLowerCase();

  for (let i = 0; i < treeNodes.length; i++) {
    const node = treeNodes[i];
    const idx = node.idx.toLowerCase();
    const prefix = (node.prefix_idx || "").toLowerCase();
    const scatterFrom = node.scatter_from ? node.scatter_from.toLowerCase() : null;
    const lane = laneMap.get(idx) ?? 0;
    const cx = 14 + lane * LANE_W;
    const cy = 14 + i * ROW_H;
    const color = laneColor(lane);
    const isFocus = idx === focusIdx;

    if (prefix) {
      const lastAncestor = prefix.slice(-4);
      const parentLane = laneMap.get(lastAncestor) ?? 0;
      const parentRow = treeNodes.findIndex(n => n.idx.toLowerCase() === lastAncestor);
      if (parentRow >= 0) {
        const px = 14 + parentLane * LANE_W;
        const py = 14 + parentRow * ROW_H;
        if (lane !== parentLane) {
          svg += `<path d="M${px},${py + DOT_R} C${px},${py + ROW_H / 2} ${cx},${cy - ROW_H / 2} ${cx},${cy - DOT_R}" stroke="${color}" stroke-width="2" fill="none" opacity="0.6"/>`;
        } else {
          svg += `<line x1="${px}" y1="${py + DOT_R}" x2="${cx}" y2="${cy - DOT_R}" stroke="${color}" stroke-width="2" opacity="0.4"/>`;
        }
      }
    }

    svg += `<circle cx="${cx}" cy="${cy}" r="${isFocus ? DOT_R + 1 : DOT_R}" fill="${isFocus ? color : "#fff"}" stroke="${color}" stroke-width="${isFocus ? 2.5 : 2}" style="cursor:pointer" onclick="window._graphClick('${idx}')"/>`;

    const label = node.title || (node.user_content ? node.user_content.slice(0, 50) : "");
    if (label) {
      const labelX = 14 + (maxLane + 1) * LANE_W + 10;
      svg += `<text x="${labelX}" y="${cy + 4}" font-size="12" fill="${isFocus ? '#1a1a1a' : '#888'}" font-weight="${isFocus ? '600' : '400'}" font-family="system-ui" style="cursor:pointer" onclick="window._graphClick('${idx}')">${esc(label)}</text>`;
    }
  }

  svg += `</svg>`;
  return svg;
}

function scrollGraphToFocus() {
  const wrap = document.getElementById("graph-wrap");
  if (!wrap) return;
  const focusIdx = (activeNodeIdx || "").toLowerCase();
  const focusNode = treeNodes.find(n => n.idx.toLowerCase() === focusIdx);
  if (!focusNode) return;
  const row = treeNodes.indexOf(focusNode);
  const targetY = row * ROW_H;
  wrap.scrollTop = Math.max(0, targetY - wrap.clientHeight / 2);
}

window._graphClick = function(idx) {
  activeNodeIdx = idx;
  localStorage.setItem(`focus_${activeConvId}`, idx);
  navigateTo(`/conv/${activeConvId}/${idx}`);
  renderSidebar();
  renderMessages();
  const el = document.getElementById("msg-" + idx);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("highlight-flash");
    setTimeout(() => el.classList.remove("highlight-flash"), 1200);
  }
};

// --- Actions ---

window.selectConv = async function(convId) {
  activeConvId = convId;
  await loadTree(convId);
  const withContent = treeNodes.filter(n => n.user_content);
  activeNodeIdx = withContent.length ? withContent[withContent.length - 1].idx.toLowerCase() : null;
  if (activeNodeIdx) localStorage.setItem(`focus_${convId}`, activeNodeIdx);
  navigateTo(`/conv/${convId}${activeNodeIdx ? "/" + activeNodeIdx : ""}`);
  renderSidebar();
  renderMessages();
  if (isMobile()) {
    document.getElementById("sidebar").classList.remove("visible");
    document.getElementById("sidebar-overlay").classList.remove("visible");
  }
};

window.toggleFold = function(idx) {
  const body = document.getElementById("ai-body-" + idx);
  if (!body) return;
  body.classList.toggle("folded");
  const btn = body.parentElement.querySelector(".msg-fold-btn");
  if (btn) btn.textContent = body.classList.contains("folded") ? "展开" : "收起";
};

async function loadTree(convId) {
  treeNodes = await get(`/tree?conv_id=${convId}`);
}

// --- Messages ---

function renderMessages() {
  const container = document.getElementById("messages");
  const title = document.getElementById("main-header-title");

  if (!activeConvId || !treeNodes.length) {
    title.innerHTML = isMobile() ? '<span class="brand">ToT 🌲</span> 新对话' : "Select a conversation";
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">&gt;_</div><div class="empty-state-text">Start a new conversation</div></div>`;
    return;
  }

  const focusIdx = (activeNodeIdx || "").toLowerCase();
  let pathNodes = [];

  if (focusIdx) {
    const focusNode = treeNodes.find(n => n.idx.toLowerCase() === focusIdx);
    if (focusNode) {
      const prefix = (focusNode.prefix_idx || "").toLowerCase();
      const ancestorIdxes = prefix.match(/.{4}/g) || [];
      pathNodes = ancestorIdxes
        .map(hex => treeNodes.find(n => n.idx.toLowerCase() === hex))
        .filter(Boolean);
      pathNodes.push(focusNode);
    }
  } else {
    pathNodes = treeNodes.filter(n => !n.prefix_idx || n.prefix_idx === "");
  }

  pathNodes = pathNodes.filter(n => n.user_content || n.assistant_content);
  const convTitle = treeNodes[0]?.title || "Chat";
  title.innerHTML = isMobile() ? `<span class="brand">ToT 🌲</span> ${esc(convTitle)}` : esc(convTitle);

  if (!pathNodes.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-text">No messages yet</div></div>`;
    return;
  }

  let html = "";
  for (const node of pathNodes) {
    html += renderNodeMessage(node);
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderNodeMessage(node) {
  const idx = node.idx.toLowerCase();
  let html = "";

  html += `<div class="msg msg-user" id="msg-${idx}">
    <div class="msg-content">
      <div class="msg-label">You</div>
      <div class="msg-body">${esc(node.user_content)}</div>
    </div>
  </div>`;

  if (node.assistant_content) {
    const rendered = renderMarkdown(node.assistant_content, idx);
    html += `<div class="msg msg-assistant">
      <div class="msg-content">
        <div class="msg-label">AI</div>
        <div class="msg-body" id="ai-body-${idx}">${rendered}</div>
        <span class="msg-fold-btn" onclick="toggleFold('${idx}')">收起</span>
      </div>
    </div>`;
  }

  return html;
}

function renderMarkdown(text, nodeIdx) {
  let html;
  if (typeof marked !== "undefined") {
    html = marked.parse(text);
  } else {
    html = `<pre style="white-space:pre-wrap">${esc(text)}</pre>`;
  }
  return html.replace(
    /<h2>(.*?)<\/h2>/g,
    (_, heading) => `<h2 class="branch-heading" onclick="window._branch('${nodeIdx}', '${esc(heading).replace(/'/g, "\\'")}')">▸ ${heading}</h2>`
  );
}

window._branch = async function(nodeIdx, heading) {
  if (!activeConvId) return;
  const msg = prompt(`Branch to "${heading}" — enter your question:`);
  if (!msg) return;

  const container = document.getElementById("messages");
  container.innerHTML += `<div class="msg msg-user"><div class="msg-content"><div class="msg-label">You</div><div class="msg-body">${esc(msg)}</div></div></div>
    <div class="msg msg-assistant msg-loading"><div class="msg-content"><div class="msg-label">AI</div><div class="msg-body"><em>Thinking...</em></div></div></div>`;
  container.scrollTop = container.scrollHeight;

  try {
    const result = await post("/branch", { conv_id: activeConvId, node_idx: nodeIdx, heading, message: msg, model_id: selectedModelId || undefined });
    if (result.idx) {
      activeNodeIdx = result.idx.toLowerCase();
      localStorage.setItem(`focus_${activeConvId}`, activeNodeIdx);
      navigateTo(`/conv/${activeConvId}/${activeNodeIdx}`);
    }
    await loadTree(activeConvId);
    renderSidebar();
    renderMessages();
  } catch (err) {
    removeLoadingPlaceholder();
    container.innerHTML += `<div class="msg msg-error"><div class="msg-body">Error: ${esc(err.message)}</div></div>`;
  }
};

// --- Send ---

document.getElementById("send").onclick = sendMessage;
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById("input").addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

function removeLoadingPlaceholder() {
  const loading = document.querySelector(".msg-loading");
  if (loading) loading.remove();
}

async function sendMessage() {
  if (sending) return;
  const input = document.getElementById("input");
  const msg = input.value.trim();
  if (!msg) return;

  input.value = "";
  input.style.height = "auto";
  sending = true;

  const container = document.getElementById("messages");
  const msgId = `msg-${Date.now()}`;
  container.innerHTML += `<div class="msg msg-user"><div class="msg-content"><div class="msg-label">You</div><div class="msg-body">${esc(msg)}</div></div></div>
    <div class="msg msg-assistant" id="${msgId}"><div class="msg-content"><div class="msg-label">AI</div><div class="msg-body"></div></div></div>`;
  container.scrollTop = container.scrollHeight;

  try {
    let nodeIdx, prefixHex;
    let fullContent = "";

    if (!activeConvId) {
      // New conversation: /conversation handles both user message and AI response
      const result = await post("/conversation", { message: msg, model_id: selectedModelId || undefined });
      activeConvId = result.conv_id;
      nodeIdx = result.idx;
      fullContent = result.assistant_content;
    } else {
      // Existing conversation: use streaming endpoint
      const response = await fetch("/api/chat/send/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            conv_id: activeConvId,
            message: msg,
            node_idx: activeNodeIdx || undefined,
            model_id: selectedModelId || undefined,
          },
        }),
      });

      nodeIdx = response.headers.get("X-Node-Idx") || nodeIdx;
      prefixHex = response.headers.get("X-Prefix-Hex") || "";

      if (nodeIdx) {
        activeNodeIdx = nodeIdx.toLowerCase();
        localStorage.setItem(`focus_${activeConvId}`, activeNodeIdx);
        navigateTo(`/conv/${activeConvId}/${activeNodeIdx}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Keep the last incomplete line in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            // Handle replay (existing content when reconnecting)
            if (parsed.replay) {
              fullContent = parsed.replay;
              const msgBody = document.querySelector(`#${msgId} .msg-body`);
              if (msgBody) {
                msgBody.innerHTML = renderMarkdown(fullContent, nodeIdx || "");
                container.scrollTop = container.scrollHeight;
              }
            }
            // Handle new content
            if (parsed.content) {
              fullContent += parsed.content;
              const msgBody = document.querySelector(`#${msgId} .msg-body`);
              if (msgBody) {
                msgBody.innerHTML = renderMarkdown(fullContent, nodeIdx || "");
                container.scrollTop = container.scrollHeight;
              }
            }
          } catch {}
        }
      }

      // Process any remaining buffer
      if (buffer.trim().startsWith("data: ")) {
        const data = buffer.trim().slice(6);
        if (data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.replay) {
              fullContent = parsed.replay;
            }
            if (parsed.content) {
              fullContent += parsed.content;
            }
            const msgBody = document.querySelector(`#${msgId} .msg-body`);
            if (msgBody) {
              msgBody.innerHTML = renderMarkdown(fullContent, nodeIdx || "");
            }
          } catch {}
        }
      }
    }

    // Render final content for new conversations
    if (!fullContent && nodeIdx) {
      const msgBody = document.querySelector(`#${msgId} .msg-body`);
      if (msgBody) {
        msgBody.innerHTML = renderMarkdown(fullContent, nodeIdx || "");
      }
    }

    await loadConversations();
    await loadTree(activeConvId);
    renderSidebar();
    renderMessages();
  } catch (err) {
    const msgBody = document.querySelector(`#${msgId} .msg-body`);
    if (msgBody) {
      msgBody.innerHTML = `<span class="error">Error: ${esc(err.message)}</span>`;
    }
  } finally {
    sending = false;
    input.focus();
  }
}

async function reconnectToStream(convId, nodeIdx) {
  const result = await get(`/stream/result?conv_id=${convId}&node_idx=${nodeIdx}`);
  if (result && result.status === "complete") {
    return result.content;
  }

  const response = await fetch(`/api/chat/send/stream?conv_id=${convId}&node_idx=${nodeIdx}`, {
    method: "GET",
  });

  if (!response.ok) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");

    // Keep the last incomplete line in buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") break;

      try {
        const parsed = JSON.parse(data);
        if (parsed.content) {
          content += parsed.content;
        }
      } catch {}
    }
  }

  // Process any remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    const data = buffer.trim().slice(6);
    if (data !== "[DONE]") {
      try {
        const parsed = JSON.parse(data);
        if (parsed.content) {
          content += parsed.content;
        }
      } catch {}
    }
  }

  return content;
}

// --- Sidebar toggle ---

const isMobile = () => window.innerWidth <= 768;

function setupMobileUI() {
  const mobileBtn = document.getElementById("btn-mobile-menu");
  if (isMobile()) {
    mobileBtn.style.display = "";
    document.getElementById("sidebar").classList.remove("visible");
  } else {
    mobileBtn.style.display = "none";
    document.getElementById("sidebar").classList.remove("visible");
    document.getElementById("sidebar-overlay").classList.remove("visible");
  }
}

document.getElementById("btn-mobile-menu").onclick = () => {
  document.getElementById("sidebar").classList.add("visible");
  document.getElementById("sidebar-overlay").classList.add("visible");
};

document.getElementById("sidebar-overlay").onclick = () => {
  document.getElementById("sidebar").classList.remove("visible");
  document.getElementById("sidebar-overlay").classList.remove("visible");
};

document.getElementById("btn-toggle-sidebar").onclick = () => {
  if (isMobile()) {
    document.getElementById("sidebar").classList.remove("visible");
    document.getElementById("sidebar-overlay").classList.remove("visible");
  }
};

window.addEventListener("resize", setupMobileUI);

// --- New Chat ---

document.getElementById("btn-new-chat").onclick = () => {
  activeConvId = null;
  activeNodeIdx = null;
  treeNodes = [];
  navigateTo("/");
  renderSidebar();
  renderMessages();
};

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

// --- Init ---

async function init() {
  if (!await checkSession()) return;
  setupMobileUI();
  await Promise.all([loadConversations(), loadModels()]);

  const route = parseRoute();
  if (route.convId) {
    activeConvId = route.convId;
    await loadTree(activeConvId);
    activeNodeIdx = route.nodeIdx;
    if (!activeNodeIdx) {
      const withContent = treeNodes.filter(n => n.user_content);
      if (withContent.length) activeNodeIdx = withContent[withContent.length - 1].idx.toLowerCase();
    }
    if (activeNodeIdx) localStorage.setItem(`focus_${activeConvId}`, activeNodeIdx);
  } else {
    const saved = localStorage.getItem("activeConv");
    if (saved) {
      activeConvId = saved;
      await loadTree(saved);
      const withContent = treeNodes.filter(n => n.user_content);
      activeNodeIdx = withContent.length ? withContent[withContent.length - 1].idx.toLowerCase() : null;
      if (activeNodeIdx) {
        localStorage.setItem(`focus_${saved}`, activeNodeIdx);
        navigateTo(`/conv/${saved}/${activeNodeIdx}`);
      }
    }
  }

  renderSidebar();
  renderMessages();
}

init();
