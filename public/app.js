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
let treeData = { conversation: null, nodes: [] };
let sending = false;

// --- Sidebar: conversation list ---

async function loadConversations() {
  conversations = await get("/list");
  renderConvList();
}

function renderConvList() {
  const tree = document.getElementById("tree");
  if (!conversations.length) {
    tree.innerHTML = '<div class="tree-empty">No conversations yet</div>';
    return;
  }
  tree.innerHTML = `
    <div class="conv-list">
      ${conversations.map(c => `
        <div class="tree-item ${c.id === activeConvId ? "active" : ""}" onclick="selectConv('${c.id}')">
          <span class="tree-item-label">${esc(c.title)}</span>
        </div>
      `).join("")}
    </div>
    ${activeConvId ? '<div class="tree-divider"></div><div id="node-tree"></div>' : ""}
  `;

  if (activeConvId) {
    renderNodeTree();
  }
}

function renderNodeTree() {
  const container = document.getElementById("node-tree");
  if (!container || !treeData.nodes.length) return;

  const focusId = treeData.conversation?.focus_id;
  const focusHex = focusId ? focusId.toLowerCase() : null;

  container.innerHTML = `<div class="node-tree-inner">${renderNodes("", focusHex)}</div>`;
}

function renderNodes(parentPath, focusHex) {
  const children = treeData.nodes.filter(n => {
    const np = n.parents || "";
    return np === parentPath;
  });

  if (!children.length) return "";

  return children.map(n => {
    const nodeId = n.id.toLowerCase();
    const isFocus = nodeId === focusHex;
    const fullPath = n.parents ? `${n.parents}.${nodeId}` : nodeId;
    const hasChildren = treeData.nodes.some(c => c.parents === fullPath);
    const label = n.user_content.length > 30 ? n.user_content.slice(0, 30) + "..." : n.user_content;

    return `
      <div class="node-item ${isFocus ? "focus" : ""}" onclick="window._scrollToNode('${nodeId}')">
        <span class="node-arrow">${hasChildren ? "▸" : "·"}</span>
        <span class="node-label">${esc(label)}</span>
      </div>
      ${hasChildren ? `<div class="node-children">${renderNodes(fullPath, focusHex)}</div>` : ""}
    `;
  }).join("");
}

// --- Actions ---

window.selectConv = async function(id) {
  activeConvId = id;
  await loadTree(id);
  renderConvList();
  renderMessages();
};

window._focusNode = async function(nodeId) {
  if (!activeConvId) return;
  await post("/focus", { conversation_id: activeConvId, node_id: nodeId });
  await loadTree(activeConvId);
  renderConvList();
  renderMessages();
};

window._scrollToNode = function(nodeId) {
  const el = document.getElementById("msg-" + nodeId);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("highlight-flash");
    setTimeout(() => el.classList.remove("highlight-flash"), 1200);
  }
};

window.toggleFold = function(nodeId) {
  const body = document.getElementById("ai-body-" + nodeId);
  const btn = body?.nextElementSibling;
  if (!body) return;
  body.classList.toggle("folded");
  if (btn) btn.textContent = body.classList.contains("folded") ? "展开" : "收起";
};

async function loadTree(convId) {
  treeData = await get(`/tree?conversation_id=${convId}`);
}

// --- Messages rendering ---

function renderMessages() {
  const container = document.getElementById("messages");
  const title = document.getElementById("main-header-title");

  if (!activeConvId || !treeData.nodes.length) {
    title.textContent = treeData.conversation?.title || "Select a conversation";
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&gt;_</div>
        <div class="empty-state-text">Start a new conversation</div>
      </div>
    `;
    return;
  }

  title.textContent = treeData.conversation.title;

  const focusId = treeData.conversation?.focus_id;
  const focusHex = focusId ? focusId.toLowerCase() : null;

  let pathNodes = [];
  if (focusHex) {
    const focusNode = treeData.nodes.find(n => n.id.toLowerCase() === focusHex);
    if (focusNode) {
      const pathParts = focusNode.parents ? focusNode.parents.split(".") : [];
      pathParts.push(focusHex);
      pathNodes = pathParts.map(hex => treeData.nodes.find(n => n.id.toLowerCase() === hex)).filter(Boolean);
    }
  } else {
    pathNodes = treeData.nodes.filter(n => !n.parents);
  }

  let html = "";
  for (const node of pathNodes) {
    html += renderNodeMessage(node);
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderNodeMessage(node) {
  const nodeId = node.id.toLowerCase();
  let html = "";

  html += `
    <div class="msg msg-user" id="msg-${nodeId}">
      <div class="msg-content">
        <div class="msg-label">You</div>
        <div class="msg-body">${esc(node.user_content)}</div>
      </div>
    </div>
  `;

  if (node.assistant_content) {
    const rendered = renderMarkdown(node.assistant_content, nodeId);
    html += `
      <div class="msg msg-assistant" id="msg-ai-${nodeId}">
        <div class="msg-content">
          <div class="msg-label">AI</div>
          <div class="msg-body" id="ai-body-${nodeId}">${rendered}</div>
          <span class="msg-fold-btn" onclick="toggleFold('${nodeId}')">收起</span>
        </div>
      </div>
    `;
  }

  return html;
}

function renderMarkdown(text, nodeId) {
  if (typeof marked === "undefined") return `<pre>${esc(text)}</pre>`;

  const html = marked.parse(text);

  return html.replace(
    /<h2>(.*?)<\/h2>/g,
    (_, heading) => `<h2 class="branch-heading" onclick="window._branch('${nodeId}', '${esc(heading).replace(/'/g, "\\'")}')">▸ ${heading}</h2>`
  );
}

window._branch = async function(nodeId, heading) {
  if (!activeConvId) return;
  try {
    await post("/branch", {
      conversation_id: activeConvId,
      node_id: nodeId,
      heading,
    });
    await loadTree(activeConvId);
    renderConvList();
    renderMessages();
  } catch (err) {
    alert("Branch error: " + err.message);
  }
};

// --- Send ---

document.getElementById("send").onclick = sendMessage;
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
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

  if (!activeConvId) {
    const conv = await post("/conversation", { title: msg.slice(0, 50) });
    activeConvId = conv.id;
    await loadConversations();
  }

  input.value = "";
  input.style.height = "auto";
  sending = true;

  const container = document.getElementById("messages");
  const focusId = treeData.conversation?.focus_id;
  const focusHex = focusId ? focusId.toLowerCase() : null;

  container.innerHTML += `
    <div class="msg msg-user">
      <div class="msg-label">You</div>
      <div class="msg-body">${esc(msg)}</div>
    </div>
    <div class="msg msg-assistant msg-loading">
      <div class="msg-label">AI</div>
      <div class="msg-body"><em>Thinking...</em></div>
    </div>
  `;
  container.scrollTop = container.scrollHeight;

  try {
    const result = await post("/send", {
      conversation_id: activeConvId,
      message: msg,
      node_id: focusHex || undefined,
    });

    await loadTree(activeConvId);
    renderConvList();
    renderMessages();
  } catch (err) {
    container.innerHTML += `
      <div class="msg msg-error">
        <div class="msg-body">Error: ${esc(err.message)}</div>
      </div>
    `;
  } finally {
    sending = false;
  }
}

// --- New Chat ---

document.getElementById("btn-new-chat").onclick = async () => {
  activeConvId = null;
  treeData = { conversation: null, nodes: [] };
  renderConvList();
  renderMessages();
};

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

async function checkSession() {
  try {
    const res = await fetch("/api/auth/me");
    const json = await res.json();
    if (json.em === "unauthorized") {
      window.location.href = "/login";
      return;
    }
    if (json.data) {
      document.getElementById("main-header-meta").textContent = json.data.email;
    }
  } catch {
    window.location.href = "/login";
    return;
  }
  loadConversations();
}

checkSession();
