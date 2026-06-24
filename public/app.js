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
let treeNodes = [];
let sending = false;
let currentUser = null;

const LANE_W = 24;
const ROW_H = 32;
const DOT_R = 6;
const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

function laneColor(i) { return COLORS[i % COLORS.length]; }

// --- Session ---

async function checkSession() {
  try {
    const res = await fetch("/api/auth/me");
    const json = await res.json();
    if (json.em === "unauthorized") { window.location.href = "/login"; return; }
    currentUser = json.data;
    if (currentUser) document.getElementById("main-header-meta").textContent = currentUser.email;
  } catch { window.location.href = "/login"; return; }
  loadConversations();
}

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
      <div class="graph-wrap">${renderGraph()}</div>`;
  } else {
    tree.innerHTML = `<div class="conv-list">${convListHtml}</div>`;
  }
}

// --- SVG Graph ---

function renderGraph() {
  if (!treeNodes.length) return "";

  // Assign lanes
  const laneMap = new Map(); // idx -> lane
  let maxLane = 0;

  for (const node of treeNodes) {
    const idx = node.idx.toLowerCase();
    const prefix = (node.prefix_idx || "").toLowerCase();
    const scatterFrom = node.scatter_from ? node.scatter_from.toLowerCase() : null;

    if (scatterFrom) {
      // Branch: use parent's lane + 1
      const parentLane = laneMap.get(scatterFrom) ?? 0;
      laneMap.set(idx, parentLane + 1);
    } else if (prefix) {
      // Continuation: use last ancestor's lane
      const lastAncestor = prefix.slice(-4);
      laneMap.set(idx, laneMap.get(lastAncestor) ?? 0);
    } else {
      // Root
      laneMap.set(idx, 0);
    }
    maxLane = Math.max(maxLane, laneMap.get(idx));
  }

  const svgW = (maxLane + 2) * LANE_W + 260;
  const svgH = treeNodes.length * ROW_H + 16;

  let svg = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">`;

  const focusIdx = (localStorage.getItem(`focus_${activeConvId}`) || "").toLowerCase();

  for (let i = 0; i < treeNodes.length; i++) {
    const node = treeNodes[i];
    const idx = node.idx.toLowerCase();
    const prefix = (node.prefix_idx || "").toLowerCase();
    const scatterFrom = node.scatter_from ? node.scatter_from.toLowerCase() : null;
    const lane = laneMap.get(idx) ?? 0;
    const cx = 12 + lane * LANE_W;
    const cy = 12 + i * ROW_H;
    const color = laneColor(lane);
    const isFocus = idx === focusIdx;

    // Draw connection to parent
    if (prefix) {
      const lastAncestor = prefix.slice(-4);
      const parentLane = laneMap.get(lastAncestor) ?? 0;
      const parentRow = treeNodes.findIndex(n => n.idx.toLowerCase() === lastAncestor);
      if (parentRow >= 0) {
        const px = 12 + parentLane * LANE_W;
        const py = 12 + parentRow * ROW_H;
        if (lane !== parentLane) {
          // Branch: curved line
          svg += `<path d="M${px},${py + DOT_R} C${px},${py + ROW_H / 2} ${cx},${cy - ROW_H / 2} ${cx},${cy - DOT_R}" stroke="${color}" stroke-width="2" fill="none" opacity="0.7"/>`;
        } else {
          // Straight line
          svg += `<line x1="${px}" y1="${py + DOT_R}" x2="${cx}" y2="${cy - DOT_R}" stroke="${color}" stroke-width="2" opacity="0.5"/>`;
        }
      }
    }

    // Draw dot
    svg += `<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${isFocus ? color : "#fff"}" stroke="${color}" stroke-width="2" style="cursor:pointer" onclick="window._graphClick('${idx}')"/>`;

    // Label
    const label = node.title || (node.user_content ? node.user_content.slice(0, 40) : "");
    if (label) {
      const labelX = 12 + (maxLane + 1) * LANE_W + 8;
      svg += `<text x="${labelX}" y="${cy + 4}" font-size="12" fill="${isFocus ? '#1a1a1a' : '#666'}" font-family="system-ui" style="cursor:pointer" onclick="window._graphClick('${idx}')">${esc(label)}</text>`;
    }
  }

  svg += `</svg>`;
  return svg;
}

window._graphClick = function(idx) {
  localStorage.setItem(`focus_${activeConvId}`, idx);
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
  localStorage.setItem("activeConv", convId);
  await loadTree(convId);
  // Auto-focus latest if no focus set
  if (!localStorage.getItem(`focus_${convId}`) && treeNodes.length) {
    const withContent = treeNodes.filter(n => n.user_content);
    if (withContent.length) {
      localStorage.setItem(`focus_${convId}`, withContent[withContent.length - 1].idx.toLowerCase());
    }
  }
  renderSidebar();
  renderMessages();
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
    title.textContent = "Select a conversation";
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">&gt;_</div><div class="empty-state-text">Start a new conversation</div></div>`;
    return;
  }

  const focusIdx = (localStorage.getItem(`focus_${activeConvId}`) || "").toLowerCase();
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
    // Show all root nodes
    pathNodes = treeNodes.filter(n => !n.prefix_idx || n.prefix_idx === "");
  }

  // Filter to only nodes with content
  pathNodes = pathNodes.filter(n => n.user_content || n.assistant_content);

  title.textContent = treeNodes[0]?.title || "Chat";

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
  if (typeof marked === "undefined") return `<pre>${esc(text)}</pre>`;
  const html = marked.parse(text);
  return html.replace(
    /<h2>(.*?)<\/h2>/g,
    (_, heading) => `<h2 class="branch-heading" onclick="window._branch('${nodeIdx}', '${esc(heading).replace(/'/g, "\\'")}')">▸ ${heading}</h2>`
  );
}

window._branch = async function(nodeIdx, heading) {
  if (!activeConvId) return;
  const msg = prompt(`Branch to "${heading}" — enter your question:`);
  if (!msg) return;

  try {
    const container = document.getElementById("messages");
    container.innerHTML += `<div class="msg msg-user"><div class="msg-content"><div class="msg-label">You</div><div class="msg-body">${esc(msg)}</div></div></div>
      <div class="msg msg-assistant msg-loading"><div class="msg-content"><div class="msg-label">AI</div><div class="msg-body"><em>Thinking...</em></div></div></div>`;
    container.scrollTop = container.scrollHeight;

    const result = await post("/branch", { conv_id: activeConvId, node_idx: nodeIdx, heading, message: msg });
    if (result.idx) localStorage.setItem(`focus_${activeConvId}`, result.idx.toLowerCase());
    await loadTree(activeConvId);
    renderSidebar();
    renderMessages();
  } catch (err) {
    alert("Branch error: " + err.message);
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

async function sendMessage() {
  if (sending) return;
  const input = document.getElementById("input");
  const msg = input.value.trim();
  if (!msg) return;

  input.value = "";
  input.style.height = "auto";
  sending = true;

  const container = document.getElementById("messages");
  container.innerHTML += `<div class="msg msg-user"><div class="msg-content"><div class="msg-label">You</div><div class="msg-body">${esc(msg)}</div></div></div>
    <div class="msg msg-assistant msg-loading"><div class="msg-content"><div class="msg-label">AI</div><div class="msg-body"><em>Thinking...</em></div></div></div>`;
  container.scrollTop = container.scrollHeight;

  try {
    let result;
    if (!activeConvId) {
      // New conversation — creates root node with real content
      result = await post("/conversation", { message: msg });
      activeConvId = result.conv_id;
      localStorage.setItem("activeConv", result.conv_id);
    } else {
      const focusIdx = localStorage.getItem(`focus_${activeConvId}`);
      result = await post("/send", { conv_id: activeConvId, message: msg, node_idx: focusIdx || undefined });
    }

    if (result.idx) localStorage.setItem(`focus_${activeConvId}`, result.idx.toLowerCase());
    await loadConversations();
    await loadTree(activeConvId);
    renderSidebar();
    renderMessages();
  } catch (err) {
    container.innerHTML += `<div class="msg msg-error"><div class="msg-body">Error: ${esc(err.message)}</div></div>`;
  } finally {
    sending = false;
  }
}

// --- Sidebar toggle ---

document.getElementById("btn-toggle-sidebar").onclick = () => {
  document.getElementById("sidebar").classList.add("hidden");
  document.getElementById("btn-show-sidebar").style.display = "";
};

document.getElementById("btn-show-sidebar").onclick = () => {
  document.getElementById("sidebar").classList.remove("hidden");
  document.getElementById("btn-show-sidebar").style.display = "none";
};

// --- New Chat ---

document.getElementById("btn-new-chat").onclick = () => {
  activeConvId = null;
  treeNodes = [];
  localStorage.removeItem("activeConv");
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
  await checkSession();
  const saved = localStorage.getItem("activeConv");
  if (saved) {
    activeConvId = saved;
    await loadTree(saved);
    // Auto-focus latest
    if (!localStorage.getItem(`focus_${saved}`) && treeNodes.length) {
      const withContent = treeNodes.filter(n => n.user_content);
      if (withContent.length) localStorage.setItem(`focus_${saved}`, withContent[withContent.length - 1].idx.toLowerCase());
    }
    renderSidebar();
    renderMessages();
  }
}

init();
