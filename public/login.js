const API = "/api/auth";

async function post(path, data) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  return res.json();
}

function showStatus(text, showRetry = false) {
  document.getElementById("step-email").style.display = "none";
  document.getElementById("step-status").style.display = "";
  document.getElementById("status-text").textContent = text;
  document.getElementById("btn-retry").style.display = showRetry ? "" : "none";
}

function startBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBuffer(base64) {
  // Handle base64url (WebAuthn uses this)
  let b64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

document.getElementById("btn-register").onclick = async () => {
  const email = document.getElementById("email").value.trim();
  if (!email) return;

  try {
    showStatus("请求注册...");

    const optRes = await post("/register/options", { email });
    if (optRes.em) { showStatus(optRes.em, true); return; }

    const options = optRes.data;
    options.challenge = base64ToBuffer(options.challenge);
    options.user.id = base64ToBuffer(options.user.id);

    if (options.excludeCredentials) {
      for (const cred of options.excludeCredentials) {
        cred.id = base64ToBuffer(cred.id);
      }
    }

    showStatus("请完成 Passkey 验证...");
    const credential = await navigator.credentials.create({ publicKey: options });

    const attResp = {
      id: credential.id,
      rawId: startBufferToBase64(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: startBufferToBase64(credential.response.attestationObject),
        clientDataJSON: startBufferToBase64(credential.response.clientDataJSON),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };

    showStatus("验证中...");
    const verifyRes = await post("/register/verify", { email, response: attResp });
    if (verifyRes.em) { showStatus(verifyRes.em, true); return; }

    window.location.href = "/";
  } catch (err) {
    showStatus("注册失败: " + err.message, true);
  }
};

document.getElementById("btn-login").onclick = async () => {
  const email = document.getElementById("email").value.trim();
  if (!email) return;

  try {
    showStatus("请求登录...");

    const optRes = await post("/login/options", { email });
    if (optRes.em) { showStatus(optRes.em, true); return; }

    const options = optRes.data;
    options.challenge = base64ToBuffer(options.challenge);

    if (options.allowCredentials) {
      for (const cred of options.allowCredentials) {
        cred.id = base64ToBuffer(cred.id);
      }
    }

    showStatus("请完成 Passkey 验证...");
    const assertion = await navigator.credentials.get({ publicKey: options });

    const authResp = {
      id: assertion.id,
      rawId: startBufferToBase64(assertion.rawId),
      type: assertion.type,
      response: {
        authenticatorData: startBufferToBase64(assertion.response.authenticatorData),
        clientDataJSON: startBufferToBase64(assertion.response.clientDataJSON),
        signature: startBufferToBase64(assertion.response.signature),
        userHandle: assertion.response.userHandle ? startBufferToBase64(assertion.response.userHandle) : null,
      },
      clientExtensionResults: assertion.getClientExtensionResults(),
    };

    showStatus("验证中...");
    const verifyRes = await post("/login/verify", { email, response: authResp });
    if (verifyRes.em) { showStatus(verifyRes.em, true); return; }

    window.location.href = "/";
  } catch (err) {
    showStatus("登录失败: " + err.message, true);
  }
};

document.getElementById("btn-retry").onclick = () => {
  document.getElementById("step-email").style.display = "";
  document.getElementById("step-status").style.display = "none";
};

document.getElementById("email").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});
