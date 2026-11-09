// src/main/store.ts
var DB = "roam-vaults";
var STORE = "handles";
var KEY = "vaults";
var OLD_KEY = "vault";
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function run(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      res(req?.result);
    };
    tx.onerror = () => {
      db.close();
      rej(tx.error);
    };
  });
}
async function loadVaults() {
  const list = await run("readonly", (s) => s.get(KEY));
  if (list) return list;
  const old = await run("readonly", (s) => s.get(OLD_KEY));
  return old ? [{ id: old.name, handle: old }] : [];
}
var saveVaults = (list) => run("readwrite", (s) => {
  s.delete(OLD_KEY);
  return s.put(list, KEY);
});

// src/core/frontmatter.ts
var NO_FM = { bodyStart: 0, bodyStartLine: 0, raw: null, props: null, error: null };
function splitFrontmatter(text) {
  let i = text.charCodeAt(0) === 65279 ? 1 : 0;
  if (!text.startsWith("---", i)) return { ...NO_FM, bodyStart: i };
  let j = i + 3;
  while (text[j] === " " || text[j] === "	") j++;
  if (text[j] === "\r") j++;
  if (text[j] !== "\n") return { ...NO_FM, bodyStart: i };
  const yamlStart = j + 1;
  let p = yamlStart, line = 1;
  while (p <= text.length) {
    let e = text.indexOf("\n", p);
    if (e < 0) e = text.length;
    const l = text.slice(p, e).replace(/\r$/, "");
    if (/^---\s*$/.test(l)) {
      const raw = text.slice(yamlStart, p);
      const { props, error } = parseYamlLite(raw);
      return { bodyStart: Math.min(e + 1, text.length), bodyStartLine: line + 1, raw, props, error };
    }
    if (e >= text.length) break;
    p = e + 1;
    line++;
  }
  return { ...NO_FM, bodyStart: i, error: "unclosed-frontmatter" };
}
function unquote(s) {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\\/nt])/g, (_, c) => c === "n" ? "\n" : c === "t" ? "	" : c);
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
function stripComment(s) {
  let q = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (k === 0 || /[\s,\[]/.test(s[k - 1])) q = c;
      continue;
    }
    if (c === "#" && (k === 0 || s[k - 1] === " " || s[k - 1] === "	")) return s.slice(0, k).trimEnd();
  }
  return s;
}
function splitFlow(inner) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (const c of inner) {
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x !== "");
}
function scalarOrFlow(v) {
  v = stripComment(v).trim();
  if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1));
  return unquote(v);
}
var detach = (s) => s.length < 13 ? s : (" " + s).slice(1);
function parseYamlLite(raw) {
  const r = parseYamlLiteInner(raw);
  const props = {};
  for (const k of Object.keys(r.props)) {
    const v = r.props[k];
    props[detach(k)] = Array.isArray(v) ? v.map(detach) : detach(v);
  }
  return { props, error: r.error };
}
function parseYamlLiteInner(raw) {
  const props = {};
  const lines = raw.split(/\r?\n/);
  let error = null;
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (/^\s*(#.*)?$/.test(l)) {
      k++;
      continue;
    }
    const m = /^("[^"]*"|'[^']*'|[^\s:#][^:]*?)\s*:(?:[ \t]+(.*?))?\s*$/.exec(l);
    if (!m || /^\s/.test(l)) {
      if (!error) error = `unparsed line ${k + 1}`;
      k++;
      continue;
    }
    const key = unquote(m[1]);
    const v = m[2] ?? "";
    k++;
    if (v === "" || /^[|>][+-]?\d*$/.test(v)) {
      const block = /^[|>]/.test(v);
      const items = [];
      const textLines = [];
      while (k < lines.length) {
        const n = lines[k];
        if (/^\s*$/.test(n)) {
          k++;
          continue;
        }
        const li = /^(\s*)-(?:\s+(.*))?$/.exec(n);
        if (!block && li) {
          items.push(unquote(stripComment(li[2] ?? "")));
          k++;
          continue;
        }
        if (/^\s/.test(n)) {
          textLines.push(n.trim());
          k++;
          continue;
        }
        break;
      }
      if (block) props[key] = textLines.join(v.startsWith(">") ? " " : "\n");
      else if (items.length) props[key] = items.filter((x) => x !== "");
      else if (textLines.length) props[key] = "[object]";
      else props[key] = "";
    } else {
      props[key] = scalarOrFlow(v);
    }
  }
  return { props, error };
}

// src/main/markdown.ts
function renderMarkdown(text, highlightLine) {
  const frag = document.createDocumentFragment();
  const fm = splitFrontmatter(text);
  const lines = text.split("\n");
  let i = 0;
  if (fm.raw !== null) {
    const end = fm.bodyStartLine;
    const props = document.createElement("div");
    props.className = "rv-props";
    props.textContent = lines.slice(1, end - 1).join("\n");
    props.style.whiteSpace = "pre-wrap";
    if (highlightLine !== void 0 && highlightLine < end) props.classList.add("rv-hl");
    frag.append(props);
    i = end;
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const start = i;
      const code = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
      const pre = document.createElement("pre");
      pre.textContent = code.join("\n");
      if (highlightLine !== void 0 && highlightLine >= start && highlightLine <= i) pre.classList.add("rv-hl");
      frag.append(pre);
      continue;
    }
    let el;
    let m;
    if (m = /^(#{1,6})\s+(.*)$/.exec(line)) {
      el = document.createElement(`h${Math.min(m[1].length + 1, 6)}`);
      inline(el, m[2]);
    } else if (m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line)) {
      el = document.createElement("div");
      el.className = "rv-li";
      el.style.setProperty("--d", String(Math.floor(m[1].replace(/\t/g, "    ").length / 2)));
      if (m[2]) el.append(m[2] === " " ? "\u2610 " : "\u2611 ");
      inline(el, m[3]);
    } else if (m = /^>\s?(.*)$/.exec(line)) {
      el = document.createElement("blockquote");
      inline(el, m[1].replace(/^\[!(\w+)\][+-]?\s*/, (_, k) => `${k}: `));
    } else if (!line.trim()) {
      continue;
    } else {
      el = document.createElement("p");
      inline(el, line);
    }
    if (i === highlightLine) el.classList.add("rv-hl");
    frag.append(el);
  }
  return frag;
}
var INLINE = /(!?)\[\[([^\]\n]+?)\]\]|!?\[([^\]\n]*)\]\(([^)\n]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w&/])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
function inline(parent, s) {
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) parent.append(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== void 0) {
      const [targetPart, alias] = splitPipe(m[2]);
      const target = targetPart.replace(/#.*$/, "").trim();
      const a = document.createElement("span");
      a.className = "rv-wl";
      a.dataset.target = target || "";
      a.textContent = (m[1] ? "\u{1F4CE} " : "") + (alias ?? targetPart);
      if (alias === null) parent.append(bracket("[["), a, bracket("]]"));
      else parent.append(a);
    } else if (m[4] !== void 0) {
      const href = m[4].trim().replace(/^<|>$/g, "");
      if (/^https?:\/\//i.test(href)) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = m[3] || href;
        parent.append(a);
      } else {
        const a = document.createElement("span");
        a.className = "rv-wl";
        let t = href;
        try {
          t = decodeURIComponent(href);
        } catch {
        }
        a.dataset.target = t.replace(/#.*$/, "");
        a.textContent = m[3] || t;
        parent.append(a);
      }
    } else if (m[5] !== void 0) {
      const c = document.createElement("code");
      c.textContent = m[5];
      parent.append(c);
    } else if (m[6] !== void 0) {
      const b = document.createElement("strong");
      b.textContent = m[6];
      parent.append(b);
    } else if (m[7] !== void 0) {
      const e = document.createElement("em");
      e.textContent = m[7];
      parent.append(e);
    } else if (m[8] !== void 0) {
      const t = document.createElement("span");
      t.className = "rv-tag";
      t.textContent = "#" + m[8];
      parent.append(t);
    }
  }
  if (last < s.length) parent.append(s.slice(last));
}
function bracket(t) {
  const b = document.createElement("span");
  b.className = "rv-br";
  b.textContent = t;
  return b;
}
function splitPipe(inner) {
  const i = inner.search(/\\?\|/);
  if (i < 0) return [inner, null];
  const sep = inner[i] === "\\" ? 2 : 1;
  return [inner.slice(0, i), inner.slice(i + sep) || null];
}

// src/main/ui.ts
var ATTR = "data-roam-vaults";
var STYLES = `
.rv-panel{padding-top:12px;margin:0 -4px 0 -16px}
.rv-sec{margin-bottom:12px}
.rv-sec-head{display:flex;align-items:center;height:24px;gap:2px;cursor:pointer;user-select:none}
.rv-sec-head strong{color:rgb(206,217,224)}
.rv-sec-head .rv-head-caret{visibility:hidden}
.rv-sec-head:hover .rv-head-caret{visibility:visible;opacity:1}
.rv-meta{color:rgb(206,217,224);font-size:12px;margin-left:8px}
.rv-spacer{flex:1}
.rv-tool{visibility:hidden;color:#8a9ba8 !important;font-size:12px}
.rv-sec-head:hover .rv-tool{visibility:visible}
.rv-sec.rv-collapsed .rv-sec-body{display:none}
.rv-sec-body{margin-top:4px}
.rv-empty{color:#8a9ba8;font-size:13px;padding:2px 0 2px 16px}
.rv-group{margin-bottom:10px}
.rv-group-head{align-items:center;gap:2px;flex-wrap:wrap}
.rv-group-caret{cursor:pointer}
.rv-group-title{margin-right:8px}
.rv-note{cursor:pointer;color:rgb(51,122,183);font-size:16px;line-height:24px}
.rv-note:hover{text-decoration:underline}
.rv-panel .rv-wl,.rv-viewer .rv-wl{color:rgb(16,107,163);cursor:pointer}
.rv-panel .rv-wl:hover,.rv-viewer .rv-wl:hover,.rv-panel .rv-tag:hover,.rv-viewer .rv-tag:hover{text-decoration:underline}
.rv-br{color:rgb(167,182,194)}
.rv-panel .rv-tag,.rv-viewer .rv-tag,.rv-tagref{color:rgb(167,182,194);cursor:pointer}
.rv-tagref{font-size:14px;margin-right:8px}
.bp3-dark .rv-panel .rv-wl,.bp3-dark .rv-viewer .rv-wl{color:rgb(72,175,240)}
.rv-path{color:#a7b6c2;font-size:12px;margin-right:8px}
.rv-badge{font-size:11px;border-radius:3px;padding:0 5px;margin-right:8px;background:#ebf1f5;color:#5c7080}
.rv-badge.rv-warn{background:#fdf0d5;color:#8a5a00}
.rv-link{font-size:12px;color:#a7b6c2;cursor:pointer;visibility:hidden}
.rv-group-head:hover .rv-link{visibility:visible}
.rv-link:hover{color:#106ba3;text-decoration:underline}
.rv-content{margin-left:20px}
.rv-block{display:flex;align-items:flex-start;padding:2px 0;cursor:pointer;border-radius:3px}
.rv-block:hover{background:rgba(16,107,163,.05)}
.rv-bullet{flex:0 0 auto;width:20px;height:28px;display:flex;align-items:center;justify-content:center}
.rv-bullet::before{content:'';width:6px;height:6px;border-radius:50%;background:#5c7080}
.rv-block-text{flex:1;font-size:14px;line-height:21px;padding:4px 0;margin-top:-1px;color:rgb(32,43,51);white-space:pre-wrap;word-break:break-word}
.bp3-dark .rv-block-text{color:inherit}
.rv-block-text code{font-size:12px}
.rv-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:30000;max-width:560px;padding:10px 14px;border-radius:6px;background:#30404d;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.rv-toast.rv-error{background:#a82a2a}
.rv-overlay{position:fixed;inset:0;z-index:20000;background:rgba(16,22,26,.45);display:flex;align-items:center;justify-content:center}
.rv-viewer{background:#fff;color:#182026;width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.rv-viewer-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #e5e5ea}
.rv-viewer-head h3{margin:0;font-size:18px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-viewer-path{padding:4px 16px 0;color:#8a8a99;font-size:12px}
.rv-viewer-body{padding:8px 20px 20px;overflow:auto;font-size:14px;line-height:1.55}
.rv-viewer-body h1,.rv-viewer-body h2,.rv-viewer-body h3,.rv-viewer-body h4{margin:14px 0 6px}
.rv-viewer-body p{margin:4px 0}
.rv-viewer-body pre{background:#f5f8fa;padding:8px;border-radius:4px;overflow:auto;font-size:12px}
.rv-viewer-body code{background:#f5f8fa;padding:0 3px;border-radius:3px;font-size:12px}
.rv-viewer-body .rv-li{padding-left:calc(var(--d,0) * 18px + 14px);position:relative}
.rv-viewer-body .rv-li::before{content:'\u2022';position:absolute;left:calc(var(--d,0) * 18px + 2px);color:#8a8a99}
.rv-viewer-body .rv-wl.rv-missing{color:#8a8a99;cursor:default}
.rv-viewer-body .rv-props{font-size:12px;color:#5c7080;background:#f5f8fa;border-radius:4px;padding:6px 10px;margin:8px 0}
.rv-viewer-body .rv-hl{background:#fff3b0;border-radius:3px}
.rv-viewer-body blockquote{border-left:3px solid #d8e1e8;margin:4px 0;padding-left:10px;color:#5c7080}
.rv-viewer-body.rv-preview{margin:2px 0 4px;padding:2px 12px 4px;border-left:1px solid #e1e8ed;max-height:480px;overflow:auto}
.rv-viewer-body h2{font-size:20px}.rv-viewer-body h3{font-size:17px}.rv-viewer-body h4,.rv-viewer-body h5,.rv-viewer-body h6{font-size:15px}
.rv-preview h2,.rv-preview h3,.rv-preview h4{margin:8px 0 4px;font-weight:600}
.bp3-dark .rv-viewer-body.rv-preview{background:transparent;color:#ddd}
.bp3-dark .rv-sec-head strong,.bp3-dark .rv-meta{color:#5c7080}
`;
function installStyles() {
  const el = document.createElement("style");
  el.setAttribute(ATTR, "style");
  el.textContent = STYLES;
  document.head.append(el);
  return () => el.remove();
}
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}
var toastEl = null;
var toastTimer;
function notify(text, kind = "info", ms = 5e3) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = h("div", { class: `rv-toast${kind === "error" ? " rv-error" : ""}`, [ATTR]: "toast", onclick: () => toastEl?.remove() }, text);
  document.body.append(toastEl);
  toastTimer = setTimeout(() => toastEl?.remove(), ms);
}
function removeToast() {
  toastEl?.remove();
  clearTimeout(toastTimer);
}
var COLLAPSE_KEY = "roam-vaults:collapsed:";
var isCollapsed = (id) => {
  try {
    return localStorage.getItem(COLLAPSE_KEY + id) === "1";
  } catch {
    return false;
  }
};
var groupOpen = /* @__PURE__ */ new Map();
var caret = (open2, extra = "") => h("span", { class: `bp3-icon-standard bp3-icon-caret-down rm-caret ${open2 ? "rm-caret-open" : "rm-caret-closed"} ${extra}` });
function renderPanel(el, vaults2, choose) {
  el.className = "rv-panel";
  if (!vaults2.length) {
    el.replaceChildren(h(
      "div",
      { class: "rv-sec" },
      sectionHead(null, "External Vault References", ""),
      h(
        "div",
        { class: "rv-empty" },
        "Add a folder of Markdown notes, such as an Obsidian vault, to see its notes about this page. ",
        h("button", { class: "bp3-button bp3-small", onclick: choose }, "Add vault folder")
      )
    ));
    return;
  }
  el.replaceChildren(...vaults2.map((v) => section(v)));
}
function sectionHead(v, label, meta, open2 = true, tools = []) {
  const head = h(
    "div",
    { class: "rv-sec-head" },
    caret(open2, "rv-head-caret"),
    h("strong", {}, label),
    meta ? h("span", { class: "rv-meta" }, meta) : null,
    h("span", { class: "rv-spacer" }),
    ...tools
  );
  if (v) head.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const now = !isCollapsed(v.id);
    try {
      localStorage.setItem(COLLAPSE_KEY + v.id, now ? "1" : "0");
    } catch {
    }
    document.querySelectorAll(`.rv-sec[data-vault="${CSS.escape(v.id)}"]`).forEach((s) => {
      s.classList.toggle("rv-collapsed", now);
      s.querySelector(".rv-head-caret")?.classList.replace(now ? "rm-caret-open" : "rm-caret-closed", now ? "rm-caret-closed" : "rm-caret-open");
    });
  });
  return head;
}
function section(v) {
  const s = v.state, act = v.act;
  const tool = (label, title, fn) => h("button", { class: "bp3-button bp3-minimal bp3-small rv-tool", title, onclick: (e) => {
    e.stopPropagation();
    fn();
  } }, label);
  let count = "", meta = v.name, body;
  if (s.kind === "permission") {
    body = h(
      "div",
      { class: "rv-empty" },
      `Roam needs permission to read "${v.name}" again. `,
      h("button", { class: "bp3-button bp3-small", onclick: act.reconnect }, "Reconnect")
    );
  } else if (s.kind === "indexing") {
    meta += ` \xB7 indexing ${s.detail}`;
    body = h("div", { class: "rv-empty" }, "Reading the vault\u2026");
  } else if (s.kind === "error") {
    body = h("div", { class: "rv-empty" }, `Couldn't read this vault: ${s.detail}`);
  } else {
    const r = s.result;
    const n = r ? new Set([...r.counterparts, ...r.backlinks, ...r.tagged].map((x) => x.path)).size : 0;
    count = `${n} `;
    if (!s.live) meta += " \xB7 not live";
    body = r && n ? resultBody(v.id, r, act) : h("div", { class: "rv-empty" }, "No notes in this vault match or link to this page.");
  }
  const collapsed = isCollapsed(v.id);
  return h(
    "div",
    { class: "rv-sec" + (collapsed ? " rv-collapsed" : ""), "data-vault": v.id },
    sectionHead(
      v,
      `${count}External Vault References`,
      meta,
      !collapsed,
      [tool("Remove", `Stop showing "${v.name}" in this graph on this device`, act.remove)]
    ),
    h("div", { class: "rv-sec-body" }, body)
  );
}
function resultBody(vid, r, act) {
  const out = h("div", { class: "rv-groups" });
  const folder = (path) => {
    const i = path.lastIndexOf("/");
    return i < 0 ? null : h("span", { class: "rv-path" }, path.slice(0, i));
  };
  const group = (key, path, title, defOpen, extras, content) => {
    const k = `${vid}
${key}
${path}`;
    const box = h("div", { class: "rv-content" });
    const c = caret(false, "rm-caret-showing rv-group-caret");
    const set = (open2) => {
      c.classList.toggle("rm-caret-open", open2);
      c.classList.toggle("rm-caret-closed", !open2);
      box.hidden = !open2;
      if (open2 && !box.childNodes.length) box.append(content());
    };
    c.addEventListener("click", () => {
      const open2 = box.hidden;
      groupOpen.set(k, open2);
      set(open2);
    });
    set(groupOpen.get(k) ?? defOpen);
    return h(
      "div",
      { class: "rv-group" },
      h(
        "div",
        { class: "flex-h-box rv-group-head" },
        c,
        h(
          "div",
          { class: "rm-ref-page-view-title rv-group-title" },
          h("span", { class: "rv-note", title: path, onclick: () => act.view(path) }, title)
        ),
        folder(path),
        ...extras,
        h("span", { class: "rv-link", title: "Open this note in Obsidian", onclick: () => act.openInObsidian(path) }, "Open in Obsidian")
      ),
      box
    );
  };
  const preview = (path) => () => {
    const el = h("div", { class: "rv-viewer-body rv-preview" });
    loadPreview(el, path, act);
    return el;
  };
  const tags = new Map(r.tagged.map((t) => [t.path, t.tag]));
  const tagBadge = (path) => {
    const t = tags.get(path);
    tags.delete(path);
    return t ? h("span", { class: "rv-tagref", title: "Tagged with this page" }, `#${t}`) : null;
  };
  for (const c of r.counterparts)
    out.append(group(
      "page",
      c.path,
      c.title,
      false,
      [h("span", { class: "rv-badge" + (c.how === "case" ? " rv-warn" : ""), title: "This note is this page" }, `this page \xB7 ${c.label}`), tagBadge(c.path)],
      preview(c.path)
    ));
  for (const b of r.backlinks)
    out.append(group(
      "links",
      b.path,
      b.title,
      true,
      [tagBadge(b.path)],
      () => h("div", {}, ...b.lines.map((l) => blockEl(l.text, () => act.view(b.path, l.line), l.line)))
    ));
  for (const t of r.tagged) if (tags.has(t.path))
    out.append(group("tag", t.path, t.title, false, [tagBadge(t.path)], preview(t.path)));
  return out;
}
function blockEl(text, onclick, line) {
  const t = h("div", { class: "rv-block-text" });
  if (text) inline(t, text);
  else t.append("(link)");
  return h("div", { class: "rv-block", title: `Line ${line + 1}`, onclick }, h("span", { class: "rv-bullet" }), t);
}
async function loadPreview(el, path, act) {
  el.append("Loading\u2026");
  try {
    el.replaceChildren(renderMarkdown(await act.read(path)));
    wireLinks(el, path, (to) => act.view(to), act.resolve);
  } catch (e) {
    el.replaceChildren(`Couldn't read this note: ${e.message}`);
  }
}
function wireLinks(el, from, open2, resolve) {
  el.querySelectorAll(".rv-wl[data-target]").forEach((a) => {
    a.addEventListener("click", async (e) => {
      e.stopPropagation();
      const to = await resolve(a.dataset.target, from);
      if (to) open2(to);
      else {
        a.classList.add("rv-missing");
        a.title = "No such note in the vault";
      }
    });
  });
}
var overlay = null;
var onKey = (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeViewer();
  }
};
function closeViewer() {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey, true);
}
async function openViewer(path, line, act) {
  closeViewer();
  const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const body = h("div", { class: "rv-viewer-body" }, "Loading\u2026");
  overlay = h(
    "div",
    { class: "rv-overlay", [ATTR]: "viewer", onclick: (e) => {
      if (e.target === overlay) closeViewer();
    } },
    h(
      "div",
      { class: "rv-viewer", role: "dialog", "aria-label": title },
      h(
        "div",
        { class: "rv-viewer-head" },
        h("h3", {}, title),
        h("button", { class: "bp3-button bp3-small", onclick: () => act.openInObsidian(path) }, "Open in Obsidian"),
        h("button", { class: "bp3-button bp3-small bp3-minimal", "aria-label": "Close", onclick: closeViewer }, "\u2715")
      ),
      h("div", { class: "rv-viewer-path" }, path),
      body
    )
  );
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  try {
    const text = await act.read(path);
    body.replaceChildren(renderMarkdown(text, line));
    wireLinks(body, path, (to) => openViewer(to, void 0, act), act.resolve);
    body.querySelector(".rv-hl")?.scrollIntoView({ block: "center" });
  } catch (e) {
    body.replaceChildren(`Couldn't read this note: ${e.message}`);
  }
}

// src/main/picker.ts
var STUCK_MSG = "Roam couldn't open that folder. macOS protects folders like Documents, Desktop and your home folder, and Roam gives no error when you pick one. Quit Roam (Cmd+Q), reopen it, and choose the vault folder inside instead, for example Documents/My Vault.";
var pending = null;
var stuck = false;
async function pickVaultFolder() {
  const w = window;
  if (!w.showDirectoryPicker) {
    notify("This version of Roam can't open local folders.", "error");
    return null;
  }
  if (stuck || pending) {
    notify(STUCK_MSG, "error", 15e3);
    return null;
  }
  let settled = false;
  const started = Date.now();
  const watchdog = () => {
    if (settled || Date.now() - started < 400) return;
    setTimeout(() => {
      if (!settled) {
        stuck = true;
        notify(STUCK_MSG, "error", 15e3);
      }
    }, 1e3);
    stopWatch();
  };
  const stopWatch = () => {
    document.removeEventListener("pointerdown", watchdog, true);
    document.removeEventListener("keydown", watchdog, true);
    window.removeEventListener("focus", watchdog);
  };
  document.addEventListener("pointerdown", watchdog, true);
  document.addEventListener("keydown", watchdog, true);
  window.addEventListener("focus", watchdog);
  pending = (async () => {
    try {
      return await w.showDirectoryPicker({ id: "roam-vaults", mode: "read" });
    } catch (e) {
      const err = e;
      if (err.name === "AbortError") return null;
      if (/already active/i.test(err.message)) {
        stuck = true;
        notify(STUCK_MSG, "error", 15e3);
        return null;
      }
      notify(`Couldn't open the folder: ${err.message}`, "error");
      return null;
    } finally {
      settled = true;
      stuck = false;
      pending = null;
      stopWatch();
    }
  })();
  return pending;
}
async function ensurePermission(h2, ask) {
  const hh = h2;
  if (await hh.queryPermission({ mode: "read" }) === "granted") return true;
  if (!ask) return false;
  return await hh.requestPermission({ mode: "read" }) === "granted";
}

// src/main/index.ts
var workerUrl = "";
var Vault = class {
  id;
  handle;
  name;
  state = { kind: "indexing", detail: "" };
  results = /* @__PURE__ */ new Map();
  act;
  worker;
  seq = 0;
  waiting = /* @__PURE__ */ new Map();
  constructor(id, handle) {
    this.id = id;
    this.handle = handle;
    this.name = handle.name;
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = ({ data }) => {
      if (data.id !== void 0) {
        const w = this.waiting.get(data.id);
        this.waiting.delete(data.id);
        if (data.ok) w?.res(data.result);
        else w?.rej(new Error(data.error));
      } else if (data.type === "status") this.onStatus(data.state, data.detail);
      else if (data.type === "changed") {
        this.results.clear();
        refreshAll();
      }
    };
    this.worker.onerror = (e) => this.set({ kind: "error", detail: e.message || "indexer crashed" });
    const viewer = {
      read: (path) => this.call("read", { path }),
      resolve: (target, from) => this.call("resolve", { target, from }),
      openInObsidian: (path) => this.openInObsidian(path)
    };
    this.act = {
      ...viewer,
      reconnect: () => this.connect(true),
      remove: () => removeVault(this),
      view: (path, line) => openViewer(path, line, viewer)
    };
  }
  call(cmd, args) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.worker.postMessage({ id, cmd, args });
    });
  }
  set(s) {
    this.state = s;
    this.results.clear();
    refreshAll();
  }
  onStatus(s, detail) {
    if (s === "indexing") this.set({ kind: "indexing", detail });
    else if (s === "ready") {
      const live = !detail.startsWith("no live updates");
      if (!live) console.warn("[roam-vaults]", this.name, detail);
      this.set({ kind: "ready", result: null, live });
    }
  }
  async connect(ask) {
    if (!await ensurePermission(this.handle, ask)) {
      this.set({ kind: "permission" });
      return;
    }
    this.set({ kind: "indexing", detail: "" });
    try {
      const stats = await this.call("open", { handle: this.handle, key: this.id });
      if (stats.errors?.length) console.warn("[roam-vaults] unreadable files in", this.name, stats.errors);
    } catch (e) {
      this.set({ kind: "error", detail: e.message });
    }
  }
  async query(title) {
    if (this.state.kind !== "ready") return null;
    let r = this.results.get(title);
    if (r === void 0) {
      r = await this.call("query", { title }).catch(() => null);
      this.results.set(title, r);
    }
    return r;
  }
  openInObsidian(path) {
    const a = document.createElement("a");
    a.href = `obsidian://open?vault=${encodeURIComponent(this.name)}&file=${encodeURIComponent(path.replace(/\.md$/i, ""))}`;
    a.rel = "noopener";
    a.click();
  }
  stop() {
    this.worker.terminate();
    this.waiting.clear();
  }
};
var vaults = [];
var save = () => saveVaults(vaults.map((v) => ({ id: v.id, handle: v.handle }))).catch((e) => console.warn("[roam-vaults]", e));
async function addVault() {
  const h2 = await pickVaultFolder();
  if (!h2) return;
  for (const v2 of vaults) if (await v2.handle.isSameEntry(h2)) {
    notify(`"${h2.name}" is already added.`);
    return;
  }
  let id = h2.name, n = 2;
  while (vaults.some((v2) => v2.id === id)) id = `${h2.name} (${n++})`;
  const v = new Vault(id, h2);
  vaults.push(v);
  await save();
  await v.connect(false);
  notify(`Added external vault "${h2.name}".`);
}
async function removeVault(v) {
  v.stop();
  vaults = vaults.filter((x) => x !== v);
  await save();
  refreshAll();
  notify(`Removed external vault "${v.name}". The folder itself is untouched.`);
}
async function removeAll() {
  vaults.forEach((v) => v.stop());
  vaults = [];
  await save();
  refreshAll();
  notify("Removed all external vaults.");
}
async function openPageTitle() {
  const api = window.roamAlphaAPI;
  const uid = await api?.ui?.mainWindow?.getOpenPageOrBlockUid?.();
  if (!uid) return null;
  const r = api.pull("[:node/title {:block/page [:node/title]}]", [":block/uid", uid]);
  return r?.[":node/title"] ?? r?.[":block/page"]?.[":node/title"] ?? null;
}
async function titleFor(refs) {
  const logPage = refs.closest(".roam-log-page");
  if (logPage) return logPage.querySelector(".rm-title-display")?.textContent?.trim() || null;
  return openPageTitle();
}
async function fill(panel) {
  const title = panel.dataset.title;
  const snapshot = vaults.slice();
  const states = await Promise.all(snapshot.map(async (v) => v.state.kind === "ready" ? { id: v.id, name: v.name, act: v.act, state: { ...v.state, result: await v.query(title) } } : v));
  if (panel.dataset.title !== title || !panel.isConnected) return;
  renderPanel(panel, states, addVault);
}
function refreshAll() {
  document.querySelectorAll(`.rv-panel[${ATTR}]`).forEach(fill);
}
var scanning = false;
async function inject() {
  if (scanning) return;
  scanning = true;
  try {
    const refsEls = document.querySelectorAll(".roam-article .rm-reference-main");
    for (const refs of refsEls) {
      const parent = refs.parentElement;
      if (!parent) continue;
      const title = await titleFor(refs);
      if (!title) continue;
      let panel = parent.querySelector(`:scope > .rv-panel[${ATTR}]`);
      if (panel && panel.dataset.title === title) continue;
      if (!panel) {
        panel = document.createElement("div");
        panel.setAttribute(ATTR, "panel");
        panel.className = "rv-panel";
        parent.insertBefore(panel, refs.nextSibling);
      }
      panel.dataset.title = title;
      fill(panel);
    }
  } finally {
    scanning = false;
  }
}
var cleanups = [];
async function onload({ extensionAPI }) {
  cleanups.push(installStyles());
  workerUrl = URL.createObjectURL(new Blob(['"use strict";\n(() => {\n  // src/core/types.ts\n  var F_TRIMMED = 1;\n  var F_ESCAPED_PIPE = 2;\n  var F_RELATIVE = 4;\n  var F_ABSOLUTE = 8;\n  var F_DECODE_FAIL = 16;\n  var F_UNQUOTED_YAML = 32;\n  var F_HAS_MD_EXT = 64;\n  var F_EMPTY_ALIAS = 128;\n  var F_ANGLE = 256;\n\n  // src/core/frontmatter.ts\n  var NO_FM = { bodyStart: 0, bodyStartLine: 0, raw: null, props: null, error: null };\n  function splitFrontmatter(text) {\n    let i = text.charCodeAt(0) === 65279 ? 1 : 0;\n    if (!text.startsWith("---", i)) return { ...NO_FM, bodyStart: i };\n    let j = i + 3;\n    while (text[j] === " " || text[j] === "	") j++;\n    if (text[j] === "\\r") j++;\n    if (text[j] !== "\\n") return { ...NO_FM, bodyStart: i };\n    const yamlStart = j + 1;\n    let p = yamlStart, line = 1;\n    while (p <= text.length) {\n      let e = text.indexOf("\\n", p);\n      if (e < 0) e = text.length;\n      const l = text.slice(p, e).replace(/\\r$/, "");\n      if (/^---\\s*$/.test(l)) {\n        const raw = text.slice(yamlStart, p);\n        const { props, error } = parseYamlLite(raw);\n        return { bodyStart: Math.min(e + 1, text.length), bodyStartLine: line + 1, raw, props, error };\n      }\n      if (e >= text.length) break;\n      p = e + 1;\n      line++;\n    }\n    return { ...NO_FM, bodyStart: i, error: "unclosed-frontmatter" };\n  }\n  function unquote(s) {\n    s = s.trim();\n    if (s.length >= 2 && s[0] === \'"\' && s[s.length - 1] === \'"\') {\n      return s.slice(1, -1).replace(/\\\\(["\\\\\\/nt])/g, (_, c) => c === "n" ? "\\n" : c === "t" ? "	" : c);\n    }\n    if (s.length >= 2 && s[0] === "\'" && s[s.length - 1] === "\'") return s.slice(1, -1).replace(/\'\'/g, "\'");\n    return s;\n  }\n  function stripComment(s) {\n    let q = null;\n    for (let k = 0; k < s.length; k++) {\n      const c = s[k];\n      if (q) {\n        if (c === q) q = null;\n        continue;\n      }\n      if (c === \'"\' || c === "\'") {\n        if (k === 0 || /[\\s,\\[]/.test(s[k - 1])) q = c;\n        continue;\n      }\n      if (c === "#" && (k === 0 || s[k - 1] === " " || s[k - 1] === "	")) return s.slice(0, k).trimEnd();\n    }\n    return s;\n  }\n  function splitFlow(inner) {\n    const out = [];\n    let depth = 0, q = null, cur = "";\n    for (const c of inner) {\n      if (q) {\n        cur += c;\n        if (c === q) q = null;\n        continue;\n      }\n      if (c === \'"\' || c === "\'") {\n        q = c;\n        cur += c;\n        continue;\n      }\n      if (c === "[" || c === "{") depth++;\n      if (c === "]" || c === "}") depth--;\n      if (c === "," && depth === 0) {\n        out.push(cur);\n        cur = "";\n        continue;\n      }\n      cur += c;\n    }\n    if (cur.trim() !== "") out.push(cur);\n    return out.map((x) => unquote(x)).filter((x) => x !== "");\n  }\n  function scalarOrFlow(v) {\n    v = stripComment(v).trim();\n    if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1));\n    return unquote(v);\n  }\n  var detach = (s) => s.length < 13 ? s : (" " + s).slice(1);\n  function parseYamlLite(raw) {\n    const r = parseYamlLiteInner(raw);\n    const props = {};\n    for (const k of Object.keys(r.props)) {\n      const v = r.props[k];\n      props[detach(k)] = Array.isArray(v) ? v.map(detach) : detach(v);\n    }\n    return { props, error: r.error };\n  }\n  function parseYamlLiteInner(raw) {\n    const props = {};\n    const lines = raw.split(/\\r?\\n/);\n    let error = null;\n    let k = 0;\n    while (k < lines.length) {\n      const l = lines[k];\n      if (/^\\s*(#.*)?$/.test(l)) {\n        k++;\n        continue;\n      }\n      const m = /^("[^"]*"|\'[^\']*\'|[^\\s:#][^:]*?)\\s*:(?:[ \\t]+(.*?))?\\s*$/.exec(l);\n      if (!m || /^\\s/.test(l)) {\n        if (!error) error = `unparsed line ${k + 1}`;\n        k++;\n        continue;\n      }\n      const key = unquote(m[1]);\n      const v = m[2] ?? "";\n      k++;\n      if (v === "" || /^[|>][+-]?\\d*$/.test(v)) {\n        const block = /^[|>]/.test(v);\n        const items = [];\n        const textLines = [];\n        while (k < lines.length) {\n          const n = lines[k];\n          if (/^\\s*$/.test(n)) {\n            k++;\n            continue;\n          }\n          const li = /^(\\s*)-(?:\\s+(.*))?$/.exec(n);\n          if (!block && li) {\n            items.push(unquote(stripComment(li[2] ?? "")));\n            k++;\n            continue;\n          }\n          if (/^\\s/.test(n)) {\n            textLines.push(n.trim());\n            k++;\n            continue;\n          }\n          break;\n        }\n        if (block) props[key] = textLines.join(v.startsWith(">") ? " " : "\\n");\n        else if (items.length) props[key] = items.filter((x) => x !== "");\n        else if (textLines.length) props[key] = "[object]";\n        else props[key] = "";\n      } else {\n        props[key] = scalarOrFlow(v);\n      }\n    }\n    return { props, error };\n  }\n  function extractAliases(props) {\n    if (!props) return [];\n    const out = [];\n    for (const key of Object.keys(props)) {\n      if (!/^aliases?$/i.test(key)) continue;\n      const v = props[key];\n      const arr = Array.isArray(v) ? v : v.split(",");\n      for (const a of arr) {\n        const t = a.trim();\n        if (t && t !== "[object]") out.push(t.normalize("NFC"));\n      }\n    }\n    return out;\n  }\n  function extractFmTags(props) {\n    if (!props) return [];\n    const out = [];\n    for (const key of Object.keys(props)) {\n      if (!/^tags?$/i.test(key)) continue;\n      const v = props[key];\n      const arr = Array.isArray(v) ? v : v.split(/[,\\s]+/);\n      for (const a of arr) {\n        const t = a.trim().replace(/^#/, "");\n        if (t && t !== "[object]") out.push(t.normalize("NFC"));\n      }\n    }\n    return out;\n  }\n\n  // src/core/parser.ts\n  var NL = 10;\n  var BS = 92;\n  var BT = 96;\n  var PCT = 37;\n  var LT = 60;\n  var DOL = 36;\n  var TILDE = 126;\n  var RE_SPECIAL = /[\\n\\\\`%<$]/g;\n  function deadRanges(text, from) {\n    const dead = [];\n    const n = text.length;\n    let i = from;\n    let lineStart = true;\n    while (i < n) {\n      if (lineStart) {\n        lineStart = false;\n        let p = i;\n        while (p < n) {\n          const c2 = text.charCodeAt(p);\n          if (c2 === 32 || c2 === 9 || c2 === 62) p++;\n          else break;\n        }\n        const fc = text.charCodeAt(p);\n        if (fc === BT || fc === TILDE) {\n          let q = p;\n          while (q < n && text.charCodeAt(q) === fc) q++;\n          const len = q - p;\n          if (len >= 3) {\n            let eol = text.indexOf("\\n", q);\n            if (eol < 0) eol = n;\n            if (fc !== BT || text.indexOf("`", q) < 0 || text.indexOf("`", q) >= eol) {\n              const end = findFenceClose(text, eol + 1, fc, len);\n              dead.push(i, end);\n              i = end;\n              lineStart = true;\n              continue;\n            }\n          }\n        }\n      }\n      RE_SPECIAL.lastIndex = i;\n      const sm = RE_SPECIAL.exec(text);\n      if (!sm) break;\n      i = sm.index;\n      const c = text.charCodeAt(i);\n      if (c === NL) {\n        i++;\n        lineStart = true;\n        continue;\n      }\n      if (c === BS) {\n        i += text.charCodeAt(i + 1) === NL ? 1 : 2;\n        continue;\n      }\n      if (c === BT) {\n        let q = i;\n        while (q < n && text.charCodeAt(q) === BT) q++;\n        const run = q - i;\n        const close = findBacktickClose(text, q, run);\n        if (close >= 0) {\n          dead.push(i, close + run);\n          i = close + run;\n        } else i = q;\n        continue;\n      }\n      if (c === PCT && text.charCodeAt(i + 1) === PCT) {\n        const e = text.indexOf("%%", i + 2);\n        const end = e < 0 ? n : e + 2;\n        dead.push(i, end);\n        i = end;\n        continue;\n      }\n      if (c === LT && text.startsWith("<!--", i)) {\n        const e = text.indexOf("-->", i + 4);\n        if (e >= 0) {\n          dead.push(i, e + 3);\n          i = e + 3;\n          continue;\n        }\n        if (i === 0 || text.charCodeAt(i - 1) === NL) {\n          dead.push(i, n);\n          i = n;\n          continue;\n        }\n      }\n      if (c === DOL && text.charCodeAt(i + 1) === DOL) {\n        const e = text.indexOf("$$", i + 2);\n        if (e >= 0) {\n          dead.push(i, e + 2);\n          i = e + 2;\n          continue;\n        }\n      }\n      i++;\n    }\n    return dead;\n  }\n  function findFenceClose(text, p, fc, len) {\n    const n = text.length;\n    while (p < n) {\n      let eol = text.indexOf("\\n", p);\n      if (eol < 0) eol = n;\n      let q = p;\n      while (q < eol) {\n        const c = text.charCodeAt(q);\n        if (c === 32 || c === 9 || c === 62) q++;\n        else break;\n      }\n      let r = q;\n      while (r < eol && text.charCodeAt(r) === fc) r++;\n      if (r - q >= len) {\n        let s = r;\n        while (s < eol && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9 || text.charCodeAt(s) === 13)) s++;\n        if (s === eol) return eol;\n      }\n      p = eol + 1;\n    }\n    return n;\n  }\n  function findBacktickClose(text, p, run) {\n    const n = text.length;\n    while (p < n) {\n      const c = text.charCodeAt(p);\n      if (c === NL) {\n        let q = p + 1;\n        while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9 || text.charCodeAt(q) === 13)) q++;\n        if (q >= n || text.charCodeAt(q) === NL) return -1;\n        p++;\n        continue;\n      }\n      if (c === BT) {\n        let q = p;\n        while (q < n && text.charCodeAt(q) === BT) q++;\n        if (q - p === run) return p;\n        p = q;\n        continue;\n      }\n      p++;\n    }\n    return -1;\n  }\n  function mask(text, dead) {\n    if (dead.length === 0) return text;\n    const parts = [];\n    let last = 0;\n    for (let k = 0; k < dead.length; k += 2) {\n      const s = dead[k], e = dead[k + 1];\n      parts.push(text.slice(last, s));\n      parts.push(text.slice(s, e).replace(/[^\\n]/g, "\\0"));\n      last = e;\n    }\n    parts.push(text.slice(last));\n    return parts.join("");\n  }\n  var RE_WIKI = /(!?)\\[\\[([^\\[\\]\\n\\u0000]*)\\]\\]/g;\n  var RE_MD = /(!?)\\[((?:[^\\[\\]\\n\\u0000]|\\[[^\\[\\]\\n\\u0000]*\\])*)\\]\\(\\s*(<[^<>\\n\\u0000]*>|(?:[^\\s()\\u0000]|\\([^\\s()\\u0000]*\\))*)(?:\\s+(?:"[^"\\n]*"|\'[^\'\\n]*\'|\\([^()\\n]*\\)))?\\s*\\)/g;\n  var RE_TAG = /#([^\\s!"#$%&\'()*+,.:;<=>?@\\[\\]^`{|}~\\\\\\u0000]+)/g;\n  var RE_BLOCKID = /\\^([A-Za-z0-9-]+)[ \\t]*\\r?$/gm;\n  var RE_HEADING = /^[ \\t]{0,3}(#{1,6})[ \\t]+([^\\n]*)/gm;\n  var isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 160 || c === 12288;\n  var RE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;\n  function detach2(s) {\n    return s.length < 13 ? s : (" " + s).slice(1);\n  }\n  var INTERN = /* @__PURE__ */ new Map();\n  function intern(s) {\n    let v = INTERN.get(s);\n    if (v === void 0) {\n      v = detach2(s);\n      if (INTERN.size > 5e5) INTERN.clear();\n      INTERN.set(v, v);\n    }\n    return v;\n  }\n  function lineIndex(text) {\n    const starts = [0];\n    for (let i = text.indexOf("\\n"); i >= 0; i = text.indexOf("\\n", i + 1)) starts.push(i + 1);\n    return starts;\n  }\n  function lineOf(starts, off) {\n    let lo = 0, hi = starts.length - 1;\n    while (lo < hi) {\n      const mid = lo + hi + 1 >> 1;\n      if (starts[mid] <= off) lo = mid;\n      else hi = mid - 1;\n    }\n    return lo;\n  }\n  function snippetAt(text, starts, line, col) {\n    const s = starts[line], e = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;\n    const lineText = text.slice(s, e).replace(/\\r$/, "");\n    if (lineText.length <= 100) return lineText.trim();\n    const a = Math.max(0, col - 40);\n    return (a > 0 ? "\\u2026" : "") + lineText.slice(a, a + 100).trim() + (a + 100 < lineText.length ? "\\u2026" : "");\n  }\n  function parseWikiInner(inner) {\n    let flags = 0;\n    const pipe = inner.indexOf("|");\n    let tp = pipe < 0 ? inner : inner.slice(0, pipe);\n    let display = pipe < 0 ? null : inner.slice(pipe + 1);\n    if (tp.endsWith("\\\\")) {\n      tp = tp.slice(0, -1);\n      flags |= F_ESCAPED_PIPE;\n    }\n    if (display !== null && display.trim() === "") {\n      flags |= F_EMPTY_ALIAS;\n      display = null;\n    }\n    const hash = tp.indexOf("#");\n    let target = hash < 0 ? tp : tp.slice(0, hash);\n    const subpath = hash < 0 ? "" : tp.slice(hash).trim();\n    const t = target.trim();\n    if (t !== target) flags |= F_TRIMMED;\n    target = t.normalize("NFC");\n    if (target.startsWith("/")) flags |= F_ABSOLUTE;\n    if (/\\.md$/i.test(target)) flags |= F_HAS_MD_EXT;\n    return { target: intern(target), subpath: subpath && intern(subpath), display: display && detach2(display), flags };\n  }\n  function parseMdDest(dest) {\n    let flags = 0;\n    if (dest.startsWith("<")) {\n      dest = dest.slice(1, -1);\n      flags |= F_ANGLE;\n    }\n    dest = dest.trim();\n    if (dest === "" || RE_SCHEME.test(dest) || /^\\(+[a-z][a-z0-9+.-]*:/i.test(dest)) return null;\n    const hash = dest.indexOf("#");\n    let path = hash < 0 ? dest : dest.slice(0, hash);\n    let subpath = hash < 0 ? "" : dest.slice(hash);\n    try {\n      path = decodeURIComponent(path);\n      subpath = decodeURIComponent(subpath);\n    } catch {\n      flags |= F_DECODE_FAIL;\n    }\n    if (path.startsWith("./") || path.startsWith("../")) flags |= F_RELATIVE;\n    if (path.startsWith("/")) flags |= F_ABSOLUTE;\n    if (/\\.md$/i.test(path)) flags |= F_HAS_MD_EXT;\n    return { target: intern(path.normalize("NFC")), subpath: subpath && intern(subpath), flags };\n  }\n  function basenameNoMd(path) {\n    const slash = path.lastIndexOf("/");\n    const b = slash < 0 ? path : path.slice(slash + 1);\n    return /\\.md$/i.test(b) ? b.slice(0, -3) : b;\n  }\n  function parseNote(path, text, opts = {}) {\n    path = path.normalize("NFC");\n    const fm = splitFrontmatter(text);\n    const starts = lineIndex(text);\n    const links = [];\n    if (fm.raw !== null) {\n      const fmLines = fm.raw.split("\\n");\n      let curKey = "";\n      for (let li = 0; li < fmLines.length; li++) {\n        const l = fmLines[li];\n        const km = /^("[^"]*"|\'[^\']*\'|[^\\s:#-][^:]*?)\\s*:/.exec(l);\n        if (km) curKey = km[1].replace(/^["\']|["\']$/g, "");\n        const lineNo = li + 1;\n        RE_WIKI.lastIndex = 0;\n        let m2;\n        while (m2 = RE_WIKI.exec(l)) {\n          const before = l.slice(0, m2.index);\n          if (/(^|\\s)#/.test(before.replace(/"[^"]*"|\'[^\']*\'/g, ""))) break;\n          const w = parseWikiInner(m2[2]);\n          const prevCh = l[m2.index - 1];\n          let flags = w.flags;\n          if (prevCh !== \'"\' && prevCh !== "\'" && !/["\'][^"\']*$/.test(before)) flags |= F_UNQUOTED_YAML;\n          links.push({\n            kind: "prop",\n            embed: m2[1] === "!",\n            target: w.target,\n            subpath: w.subpath,\n            display: w.display,\n            line: lineNo,\n            col: m2.index,\n            flags,\n            prop: intern(curKey),\n            ...opts.snippets ? { snippet: detach2(l.trim().slice(0, 100)) } : {}\n          });\n        }\n      }\n    }\n    const dead = deadRanges(text, fm.bodyStart);\n    const masked = mask(text, dead);\n    const push = (l, off) => {\n      l.line = lineOf(starts, off);\n      l.col = off - starts[l.line];\n      if (opts.snippets) l.snippet = detach2(snippetAt(text, starts, l.line, l.col));\n      links.push(l);\n    };\n    let m;\n    RE_WIKI.lastIndex = fm.bodyStart;\n    while (m = RE_WIKI.exec(masked)) {\n      if (m[2].trim() === "") continue;\n      const w = parseWikiInner(m[2]);\n      push({ kind: "wiki", embed: m[1] === "!", target: w.target, subpath: w.subpath, display: w.display, line: 0, col: 0, flags: w.flags }, m.index);\n    }\n    RE_MD.lastIndex = fm.bodyStart;\n    while (m = RE_MD.exec(masked)) {\n      if (m.index > 0 && masked.charCodeAt(m.index - 1) === 91) continue;\n      const d = parseMdDest(m[3]);\n      if (!d) continue;\n      push({ kind: "md", embed: m[1] === "!", target: d.target, subpath: d.subpath, display: detach2(m[2]), line: 0, col: 0, flags: d.flags }, m.index);\n    }\n    const tagSet = /* @__PURE__ */ new Set();\n    for (const t of extractFmTags(fm.props)) tagSet.add(t);\n    RE_TAG.lastIndex = fm.bodyStart;\n    while (m = RE_TAG.exec(masked)) {\n      if (m.index > 0 && !isWs(masked.charCodeAt(m.index - 1))) continue;\n      const t = m[1].replace(/\\/+$/, "");\n      if (/^[0-9]+$/.test(t) || t === "") continue;\n      tagSet.add(intern(t.normalize("NFC")));\n    }\n    const headings = [];\n    RE_HEADING.lastIndex = fm.bodyStart;\n    while (m = RE_HEADING.exec(masked)) {\n      const raw = text.slice(m.index + m[0].length - m[2].length, m.index + m[0].length);\n      headings.push({ level: m[1].length, text: detach2(raw.replace(/\\r$/, "").replace(/[ \\t]+#+[ \\t]*$/, "").trim()), line: lineOf(starts, m.index) });\n    }\n    const blockIds = [];\n    RE_BLOCKID.lastIndex = fm.bodyStart;\n    while (m = RE_BLOCKID.exec(masked)) {\n      if (m.index > 0 && !isWs(masked.charCodeAt(m.index - 1))) continue;\n      blockIds.push(detach2(m[1]));\n    }\n    return {\n      path,\n      title: basenameNoMd(path),\n      aliases: extractAliases(fm.props),\n      tags: [...tagSet],\n      links,\n      headings,\n      blockIds,\n      props: fm.props,\n      fmError: fm.error,\n      stats: { bytes: text.length, lines: starts.length, deadRanges: dead.length / 2 }\n    };\n  }\n\n  // src/core/vault-index.ts\n  var MD = /\\.md$/i;\n  var nfcLower = (s) => s.normalize("NFC").toLowerCase();\n  var dirOf = (p) => {\n    const i = p.lastIndexOf("/");\n    return i < 0 ? "" : p.slice(0, i);\n  };\n  var baseOf = (p) => {\n    const i = p.lastIndexOf("/");\n    return i < 0 ? p : p.slice(i + 1);\n  };\n  function linkKey(target) {\n    let t = nfcLower(target).replace(/^\\/+/, "");\n    if (MD.test(t)) t = t.slice(0, -3);\n    return t;\n  }\n  function fileKeyPath(path) {\n    const t = nfcLower(path);\n    return MD.test(t) ? t.slice(0, -3) : t;\n  }\n  function joinRel(dir, rel) {\n    const out = dir ? dir.split("/") : [];\n    for (const seg of rel.split("/")) {\n      if (seg === "" || seg === ".") continue;\n      if (seg === "..") {\n        if (!out.length) return null;\n        out.pop();\n      } else out.push(seg);\n    }\n    return out.join("/");\n  }\n  var VaultIndex = class _VaultIndex {\n    files = /* @__PURE__ */ new Map();\n    notes = /* @__PURE__ */ new Map();\n    byName = /* @__PURE__ */ new Map();\n    // nameKey -> paths\n    outgoing = /* @__PURE__ */ new Map();\n    // src -> recs\n    backlinks = /* @__PURE__ */ new Map();\n    // resolved target path -> recs\n    unresolved = /* @__PURE__ */ new Map();\n    // link key -> recs\n    byLinkName = /* @__PURE__ */ new Map();\n    // nameKey -> recs (resolved or not)\n    aliasIdx = /* @__PURE__ */ new Map();\n    // nfcLower(alias) -> paths\n    tagIdx = /* @__PURE__ */ new Map();\n    // nfcLower(tag) -> paths (incl. parent tags)\n    listeners = [];\n    /** Tie-break duplicates by shared folder prefix with the linking note (not Obsidian behaviour; see report). */\n    preferNearby = false;\n    // ---------- file registry ----------\n    register(path) {\n      path = path.normalize("NFC");\n      const keyPath = fileKeyPath(path);\n      const e = { path, keyPath, nameKey: baseOf(keyPath), isMd: MD.test(path), depth: path.split("/").length };\n      this.files.set(path, e);\n      const arr = this.byName.get(e.nameKey);\n      if (arr) arr.push(path);\n      else this.byName.set(e.nameKey, [path]);\n      return e;\n    }\n    unregister(path) {\n      const e = this.files.get(path);\n      if (!e) return;\n      this.files.delete(path);\n      const arr = this.byName.get(e.nameKey);\n      arr.splice(arr.indexOf(path), 1);\n      if (!arr.length) this.byName.delete(e.nameKey);\n      return e;\n    }\n    // ---------- resolution ----------\n    /** All files a link target could mean, best first. */\n    candidates(target, src) {\n      if (target === "") return [src];\n      let t = target.normalize("NFC");\n      if (t.startsWith("./") || t.startsWith("../")) {\n        const j = joinRel(dirOf(src), t);\n        if (j === null) return [];\n        t = j;\n      }\n      const key = linkKey(t);\n      const nameKey = baseOf(key);\n      let cands = this.byName.get(nameKey);\n      if (!cands || !cands.length) return [];\n      if (key.includes("/")) {\n        const exact = cands.filter((p) => this.files.get(p).keyPath === key);\n        if (exact.length) return exact;\n        const rel = joinRel(nfcLower(dirOf(src)), key);\n        const relHit = rel ? cands.filter((p) => this.files.get(p).keyPath === rel) : [];\n        if (relHit.length) return relHit;\n        cands = cands.filter((p) => this.files.get(p).keyPath.endsWith("/" + key));\n        if (!cands.length) return [];\n      }\n      if (cands.length === 1) return cands.slice();\n      const wantBase = baseOf(t.replace(/^\\/+/, "")).replace(MD, "");\n      const srcDir = dirOf(src);\n      return cands.slice().sort((a, b) => {\n        const ea = this.files.get(a), eb = this.files.get(b);\n        const ca = baseOf(a).replace(MD, "") === wantBase ? 0 : 1, cb = baseOf(b).replace(MD, "") === wantBase ? 0 : 1;\n        if (ca !== cb) return ca - cb;\n        const sa = dirOf(a) === srcDir ? 0 : 1, sb = dirOf(b) === srcDir ? 0 : 1;\n        if (sa !== sb) return sa - sb;\n        if (this.preferNearby) {\n          const pa = commonDirs(a, src), pb = commonDirs(b, src);\n          if (pa !== pb) return pb - pa;\n        }\n        if (ea.depth !== eb.depth) return ea.depth - eb.depth;\n        if (a.length !== b.length) return a.length - b.length;\n        return a < b ? -1 : 1;\n      });\n    }\n    resolveRec(r) {\n      const c = this.candidates(r.link.target, r.src);\n      r.resolved = c.length ? c[0] : null;\n      r.candidates = c.length;\n      if (r.resolved !== null) add(this.backlinks, r.resolved, r);\n      else add(this.unresolved, r.key, r);\n    }\n    unresolveRec(r) {\n      if (r.resolved !== null) del(this.backlinks, r.resolved, r);\n      else del(this.unresolved, r.key, r);\n    }\n    reresolveBucket(nameKey) {\n      const bucket = this.byLinkName.get(nameKey);\n      if (!bucket) return 0;\n      for (const r of bucket) {\n        this.unresolveRec(r);\n        this.resolveRec(r);\n      }\n      return bucket.size;\n    }\n    // ---------- note contributions ----------\n    addContrib(note) {\n      const recs = [];\n      for (const link of note.links) {\n        const key = link.target === "" ? "" : linkKey(/^\\.\\.?\\//.test(link.target) ? joinRel(dirOf(note.path), link.target) ?? link.target : link.target);\n        const r = { src: note.path, link, key: intern(key), nameKey: intern(baseOf(key)), resolved: null, candidates: 0 };\n        recs.push(r);\n        if (key !== "") add(this.byLinkName, r.nameKey, r);\n        this.resolveRec(r);\n      }\n      this.outgoing.set(note.path, recs);\n      for (const a of note.aliases) add(this.aliasIdx, nfcLower(a), note.path);\n      for (const t of note.tags) for (const k of tagKeys(t)) add(this.tagIdx, k, note.path);\n    }\n    removeContrib(path) {\n      const recs = this.outgoing.get(path);\n      if (recs) for (const r of recs) {\n        this.unresolveRec(r);\n        if (r.key !== "") del(this.byLinkName, r.nameKey, r);\n      }\n      this.outgoing.delete(path);\n      const note = this.notes.get(path);\n      if (note) {\n        for (const a of note.aliases) del(this.aliasIdx, nfcLower(a), path);\n        for (const t of note.tags) for (const k of tagKeys(t)) del(this.tagIdx, k, path);\n      }\n    }\n    // ---------- public API ----------\n    /** Bulk build: register every name first so no re-resolution churn. */\n    build(notes, attachments) {\n      for (const p of attachments) this.register(p);\n      for (const n of notes) {\n        this.register(n.path);\n        this.notes.set(n.path, n);\n      }\n      for (const n of notes) this.addContrib(n);\n    }\n    /** Add or update a note. Returns number of other links re-resolved. */\n    upsertNote(note) {\n      let rer = 0;\n      const isNew = !this.files.has(note.path);\n      if (isNew) {\n        const e = this.register(note.path);\n        rer = this.reresolveBucket(e.nameKey);\n      } else this.removeContrib(note.path);\n      this.notes.set(note.path, note);\n      this.addContrib(note);\n      for (const l of this.listeners) l(note.path, isNew ? "add" : "update");\n      return rer;\n    }\n    addAttachment(path) {\n      if (this.files.has(path)) return 0;\n      const e = this.register(path);\n      for (const l of this.listeners) l(path, "add");\n      return this.reresolveBucket(e.nameKey);\n    }\n    removeFile(path) {\n      this.removeContrib(path);\n      for (const l of this.listeners) l(path, "remove");\n      this.notes.delete(path);\n      const e = this.unregister(path);\n      return e ? this.reresolveBucket(e.nameKey) : 0;\n    }\n    /** Compact, JSON-serializable form (parsed notes only; maps are rebuilt on load). */\n    toJSON() {\n      return { v: 1, attachments: [...this.files.values()].filter((e) => !e.isMd).map((e) => e.path), notes: [...this.notes.values()] };\n    }\n    static fromJSON(j) {\n      const idx = new _VaultIndex();\n      idx.build(j.notes, j.attachments);\n      return idx;\n    }\n  };\n  function commonDirs(a, b) {\n    const x = a.split("/"), y = b.split("/");\n    let n = 0;\n    while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;\n    return n;\n  }\n  function tagKeys(tag) {\n    const k = nfcLower(tag);\n    const out = [k];\n    for (let i = k.lastIndexOf("/"); i > 0; i = k.lastIndexOf("/", i - 1)) out.push(k.slice(0, i));\n    return out;\n  }\n  function add(m, k, v) {\n    const s = m.get(k);\n    if (s) s.add(v);\n    else m.set(k, /* @__PURE__ */ new Set([v]));\n  }\n  function del(m, k, v) {\n    const s = m.get(k);\n    if (!s) return;\n    s.delete(v);\n    if (!s.size) m.delete(k);\n  }\n\n  // src/core/dates.ts\n  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];\n  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];\n  var pad = (n) => (n < 10 ? "0" : "") + n;\n  var ord = (d) => d + (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");\n  var RE_ROAM = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\\d{1,2})(?:st|nd|rd|th), (\\d{4})$/;\n  function roamDailyToIso(title) {\n    const m = RE_ROAM.exec(title.trim());\n    if (!m) return null;\n    const mo = MONTHS.indexOf(m[1]) + 1, d = +m[2], y = +m[3];\n    return validIso(y, mo, d);\n  }\n  function validIso(y, mo, d) {\n    const dt = new Date(Date.UTC(y, mo - 1, d));\n    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;\n    return `${y}-${pad(mo)}-${pad(d)}`;\n  }\n  var TOKENS = [\n    ["YYYY", { re: "(\\\\d{4})", set: "y" }],\n    ["YY", { re: "(\\\\d{2})", set: "yy" }],\n    ["MMMM", { re: `(${MONTHS.join("|")})`, set: "m", map: (s) => MONTHS.findIndex((x) => x.toLowerCase() === s.toLowerCase()) + 1 }],\n    ["MMM", { re: `(${MONTHS.map((x) => x.slice(0, 3)).join("|")})`, set: "m", map: (s) => MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === s.toLowerCase()) + 1 }],\n    ["MM", { re: "(\\\\d{2})", set: "m" }],\n    ["M", { re: "(\\\\d{1,2})", set: "m" }],\n    ["Do", { re: "(\\\\d{1,2})(?:st|nd|rd|th)", set: "d" }],\n    ["DD", { re: "(\\\\d{2})", set: "d" }],\n    ["D", { re: "(\\\\d{1,2})", set: "d" }],\n    ["dddd", { re: `(?:${DAYS.join("|")})` }],\n    ["ddd", { re: `(?:${DAYS.map((x) => x.slice(0, 3)).join("|")})` }]\n  ];\n  function compileFormat(fmt) {\n    let re = "", i = 0;\n    const groups = [];\n    outer: while (i < fmt.length) {\n      if (fmt[i] === "[") {\n        const e = fmt.indexOf("]", i);\n        re += esc(fmt.slice(i + 1, e));\n        i = e + 1;\n        continue;\n      }\n      for (const [t, tok] of TOKENS) if (fmt.startsWith(t, i)) {\n        re += tok.re;\n        if (tok.set) groups.push(tok);\n        i += t.length;\n        continue outer;\n      }\n      re += esc(fmt[i]);\n      i++;\n    }\n    return { fmt, re: new RegExp(`(?:^|/)${re}$`, "i"), groups, hasSlash: fmt.includes("/") };\n  }\n  var esc = (s) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");\n  function parseWithFormat(pathNoExt, f) {\n    const m = f.re.exec(pathNoExt);\n    if (!m) return null;\n    let y = NaN, mo = NaN, d = NaN;\n    f.groups.forEach((g, k) => {\n      const raw = m[k + 1];\n      const v = g.map ? g.map(raw) : +raw;\n      if (g.set === "y") y = v;\n      else if (g.set === "yy") y = 2e3 + v;\n      else if (g.set === "m") mo = v;\n      else if (g.set === "d") d = v;\n    });\n    return validIso(y, mo, d);\n  }\n  function formatIso(iso, fmt) {\n    const [y, mo, d] = iso.split("-").map(Number);\n    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();\n    const vals = {\n      YYYY: String(y),\n      YY: String(y).slice(2),\n      MMMM: MONTHS[mo - 1],\n      MMM: MONTHS[mo - 1].slice(0, 3),\n      MM: pad(mo),\n      M: String(mo),\n      Do: ord(d),\n      DD: pad(d),\n      D: String(d),\n      dddd: DAYS[dow],\n      ddd: DAYS[dow].slice(0, 3)\n    };\n    let out = "", i = 0;\n    outer: while (i < fmt.length) {\n      if (fmt[i] === "[") {\n        const e = fmt.indexOf("]", i);\n        out += fmt.slice(i + 1, e);\n        i = e + 1;\n        continue;\n      }\n      for (const [t] of TOKENS) if (fmt.startsWith(t, i)) {\n        out += vals[t];\n        i += t.length;\n        continue outer;\n      }\n      out += fmt[i];\n      i++;\n    }\n    return out;\n  }\n\n  // src/core/matcher.ts\n  var ILLEGAL = /[\\\\/:*?"<>|#^\\[\\]]/g;\n  var sanitizedKey = (s) => nfcLower(s).replace(ILLEGAL, " ").replace(/\\s+/g, " ").trim();\n  var looseKey = (s) => nfcLower(s).replace(/[^\\p{L}\\p{N}]+/gu, "");\n  var RoamMatcher = class {\n    idx;\n    opts;\n    formats;\n    sanitized = /* @__PURE__ */ new Map();\n    loose = /* @__PURE__ */ new Map();\n    daily = /* @__PURE__ */ new Map();\n    // iso -> paths\n    nsSeps;\n    constructor(idx, opts) {\n      this.idx = idx;\n      this.opts = opts;\n      this.formats = opts.dailyFormats.map(compileFormat);\n      this.nsSeps = opts.nsSeparators ?? ["-", "_", " - ", "\\u2215", "\\uFF0F", ".", " "];\n      for (const p of idx.notes.keys()) this.addPath(p);\n      idx.listeners.push((p, kind) => {\n        if (kind === "add") this.addPath(p);\n        else if (kind === "remove") this.removePath(p);\n      });\n    }\n    keysFor(path) {\n      const kp = fileKeyPath(path);\n      const base = kp.slice(kp.lastIndexOf("/") + 1);\n      const isos = [];\n      for (const f of this.formats) {\n        const iso = parseWithFormat(path.replace(/\\.md$/i, ""), f);\n        if (iso) isos.push(iso);\n      }\n      return { s: sanitizedKey(base), l: looseKey(base), isos };\n    }\n    addPath(p) {\n      if (!/\\.md$/i.test(p)) return;\n      const k = this.keysFor(p);\n      add2(this.sanitized, k.s, p);\n      if (this.opts.loose) add2(this.loose, k.l, p);\n      for (const iso of k.isos) add2(this.daily, iso, p);\n    }\n    removePath(p) {\n      if (!/\\.md$/i.test(p)) return;\n      const k = this.keysFor(p);\n      del2(this.sanitized, k.s, p);\n      del2(this.loose, k.l, p);\n      for (const iso of k.isos) del2(this.daily, iso, p);\n    }\n    associations(title) {\n      const idx = this.idx;\n      const t = title.normalize("NFC").trim();\n      const notes = /* @__PURE__ */ new Map();\n      const put = (p, how) => {\n        if (!notes.has(p)) notes.set(p, how);\n      };\n      if (!/[\\[\\]|#^]/.test(t)) {\n        for (const p of idx.candidates(t, "")) {\n          if (!/\\.md$/i.test(p)) continue;\n          const base = p.slice(p.lastIndexOf("/") + 1, -3);\n          put(p, t.includes("/") ? "path" : base === t ? "exact" : "case");\n        }\n      }\n      for (const p of idx.aliasIdx.get(nfcLower(t)) ?? []) put(p, "alias");\n      const iso = roamDailyToIso(t);\n      if (iso) for (const p of this.daily.get(iso) ?? []) put(p, "daily");\n      if (t.includes("/")) for (const sep of this.nsSeps) {\n        for (const p of idx.byName.get(nfcLower(t.split("/").join(sep))) ?? []) if (/\\.md$/i.test(p)) put(p, "ns-flat");\n      }\n      for (const p of this.sanitized.get(sanitizedKey(t)) ?? []) put(p, "sanitized");\n      if (this.opts.loose) for (const p of this.loose.get(looseKey(t)) ?? []) put(p, "loose");\n      const seen = /* @__PURE__ */ new Set();\n      const links = [];\n      const emit = (r, via) => {\n        if (seen.has(r) || r.src === r.resolved && r.link.target === "") return;\n        seen.add(r);\n        links.push({\n          src: r.src,\n          line: r.link.line,\n          col: r.link.col,\n          kind: r.link.kind,\n          embed: r.link.embed,\n          target: r.link.target,\n          subpath: r.link.subpath,\n          snippet: r.link.snippet,\n          resolvedTo: r.resolved,\n          via\n        });\n      };\n      for (const p of notes.keys()) for (const r of idx.backlinks.get(p) ?? []) if (r.src !== p) emit(r, "backlink");\n      for (const r of idx.unresolved.get(linkKey(t)) ?? []) emit(r, "unresolved");\n      if (iso) for (const f of this.opts.dailyFormats) for (const r of idx.unresolved.get(linkKey(formatIso(iso, f))) ?? []) emit(r, "daily-unresolved");\n      const tagged = [];\n      const tk = nfcLower(t);\n      const tagVariants = t.includes(" ") ? [tk, tk.replace(/ /g, "-"), tk.replace(/ /g, "_")] : [tk];\n      for (const v of tagVariants) for (const p of idx.tagIdx.get(v) ?? []) tagged.push({ path: p, tag: v });\n      return { title, notes: [...notes].map(([path, how]) => ({ path, how })), links, tagged };\n    }\n  };\n  function add2(m, k, v) {\n    const s = m.get(k);\n    if (s) s.add(v);\n    else m.set(k, /* @__PURE__ */ new Set([v]));\n  }\n  function del2(m, k, v) {\n    const s = m.get(k);\n    if (!s) return;\n    s.delete(v);\n    if (!s.size) m.delete(k);\n  }\n\n  // src/engine.ts\n  var TIER_LABEL = {\n    exact: "same name",\n    case: "same name, different case",\n    alias: "alias",\n    path: "folder path",\n    daily: "daily note"\n  };\n  var TIER_ORDER = ["exact", "case", "alias", "path", "daily"];\n  var MD2 = /\\.md$/i;\n  var noteTitle = (path) => path.slice(path.lastIndexOf("/") + 1).replace(MD2, "");\n  var MAX_LINE = 240;\n  var MAX_BACKLINK_NOTES = 200;\n  var VaultEngine = class {\n    idx = new VaultIndex();\n    matcher;\n    cache = /* @__PURE__ */ new Map();\n    lines = /* @__PURE__ */ new Map();\n    // small LRU of split file texts, for snippets\n    fs;\n    dailyFormats;\n    constructor(fs, dailyFormats2 = ["YYYY-MM-DD"]) {\n      this.fs = fs;\n      this.dailyFormats = dailyFormats2;\n    }\n    /** Full scan. Files whose size and mtime match the cache are not re-read. */\n    async build(cache = /* @__PURE__ */ new Map(), onProgress, concurrency = 32) {\n      const t0 = Date.now();\n      const all = await this.fs.list();\n      const md = all.filter((f) => MD2.test(f.path));\n      const other = all.filter((f) => !MD2.test(f.path)).map((f) => f.path);\n      const notes = new Array(md.length);\n      const errors = [];\n      const next = /* @__PURE__ */ new Map();\n      let reread = 0, done = 0, i = 0;\n      const work = async () => {\n        while (i < md.length) {\n          const k = i++, f = md[k];\n          const c = cache.get(f.path);\n          if (c && c.size === f.size && c.mtime === f.mtime) notes[k] = c.note;\n          else {\n            try {\n              notes[k] = parseNote(f.path, await this.fs.readText(f.path));\n              reread++;\n            } catch (e) {\n              errors.push(`${f.path}: ${e.name}`);\n            }\n          }\n          if (notes[k]) next.set(f.path, { size: f.size, mtime: f.mtime, note: notes[k] });\n          if (++done % 50 === 0) onProgress?.(done, md.length);\n        }\n      };\n      await Promise.all(Array.from({ length: Math.min(concurrency, md.length || 1) }, work));\n      const ok = notes.filter(Boolean);\n      this.idx = new VaultIndex();\n      this.idx.preferNearby = true;\n      this.idx.build(ok, other);\n      this.matcher = new RoamMatcher(this.idx, { dailyFormats: this.dailyFormats });\n      this.cache = next;\n      this.lines.clear();\n      onProgress?.(md.length, md.length);\n      return { notes: ok.length, files: all.length, reread, cached: ok.length - reread, errors, ms: Date.now() - t0 };\n    }\n    /** Re-check specific paths after a watcher event. Returns true if anything changed. */\n    async refresh(paths) {\n      let changed = false;\n      for (const path of new Set(paths)) {\n        this.lines.delete(path);\n        const meta = await this.fs.stat(path).catch(() => null);\n        const known = this.idx.files.has(path);\n        if (!meta) {\n          if (known) {\n            this.idx.removeFile(path);\n            this.cache.delete(path);\n            changed = true;\n          }\n          continue;\n        }\n        if (!MD2.test(path)) {\n          if (!known) {\n            this.idx.addAttachment(path);\n            changed = true;\n          }\n          continue;\n        }\n        const c = this.cache.get(path);\n        if (known && c && c.size === meta.size && c.mtime === meta.mtime) continue;\n        try {\n          const note = parseNote(path, await this.fs.readText(path));\n          this.idx.upsertNote(note);\n          this.cache.set(path, { size: meta.size, mtime: meta.mtime, note });\n          changed = true;\n        } catch {\n        }\n      }\n      return changed;\n    }\n    /** Everything the vault knows about one Roam page title. */\n    async query(title) {\n      const a = this.matcher.associations(title);\n      const counterparts = a.notes.filter((n) => TIER_LABEL[n.how]).sort((x, y) => TIER_ORDER.indexOf(x.how) - TIER_ORDER.indexOf(y.how) || x.path.localeCompare(y.path)).map((n) => ({ path: n.path, title: noteTitle(n.path), how: n.how, label: TIER_LABEL[n.how] }));\n      const strong = new Set(counterparts.map((c) => c.path));\n      const bySrc = /* @__PURE__ */ new Map();\n      for (const l of a.links) {\n        if (l.via === "backlink" && (!l.resolvedTo || !strong.has(l.resolvedTo))) continue;\n        const arr = bySrc.get(l.src) ?? [];\n        if (!bySrc.has(l.src)) bySrc.set(l.src, arr);\n        if (arr.some((x) => x.line === l.line)) continue;\n        arr.push({ line: l.line, text: "", embed: l.embed, unresolved: l.via !== "backlink" });\n      }\n      const srcs = [...bySrc.keys()].sort((x, y) => noteTitle(x).localeCompare(noteTitle(y))).slice(0, MAX_BACKLINK_NOTES);\n      const backlinks = [];\n      for (const src of srcs) {\n        const lines = bySrc.get(src).sort((x, y) => x.line - y.line);\n        const text = await this.fileLines(src);\n        for (const l of lines) l.text = snippet(text?.[l.line] ?? "");\n        backlinks.push({ path: src, title: noteTitle(src), lines });\n      }\n      const seenTag = /* @__PURE__ */ new Set();\n      const tagged = [];\n      for (const t of a.tagged) if (!seenTag.has(t.path)) {\n        seenTag.add(t.path);\n        tagged.push({ path: t.path, title: noteTitle(t.path), tag: t.tag });\n      }\n      tagged.sort((x, y) => x.title.localeCompare(y.title));\n      return { title, counterparts, backlinks, tagged };\n    }\n    async read(path) {\n      return this.fs.readText(path);\n    }\n    /** Resolve a [[link]] target as Obsidian would, from a given source note. */\n    resolve(target, from) {\n      return this.idx.candidates(target, from).find((p) => MD2.test(p)) ?? null;\n    }\n    async fileLines(path) {\n      let l = this.lines.get(path);\n      if (l) {\n        this.lines.delete(path);\n        this.lines.set(path, l);\n        return l;\n      }\n      try {\n        l = (await this.fs.readText(path)).split("\\n");\n      } catch {\n        return null;\n      }\n      this.lines.set(path, l);\n      if (this.lines.size > 300) this.lines.delete(this.lines.keys().next().value);\n      return l;\n    }\n  };\n  function snippet(line) {\n    const s = line.replace(/^\\s*(?:[-*+]|\\d+\\.)\\s+(?:\\[.\\]\\s+)?/, "").replace(/^#+\\s+/, "").trim();\n    return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + "\\u2026" : s;\n  }\n\n  // src/worker.ts\n  var CACHE_DB = "roam-vaults-cache";\n  var CACHE_STORE = "vaults";\n  var CACHE_VERSION = 1;\n  var root = null;\n  var engine = null;\n  var vaultKey = "";\n  var observer = null;\n  var fileHandles = /* @__PURE__ */ new Map();\n  var post = (msg) => self.postMessage(msg);\n  var status = (state, detail = "") => post({ type: "status", state, detail });\n  async function getFileHandle(path) {\n    const known = fileHandles.get(path);\n    if (known) return known;\n    if (!root) return null;\n    try {\n      const parts = path.split("/");\n      let dir = root;\n      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);\n      const h = await dir.getFileHandle(parts[parts.length - 1]);\n      fileHandles.set(path, h);\n      return h;\n    } catch {\n      return null;\n    }\n  }\n  var handleFS = {\n    async list() {\n      const out = [];\n      const handles = /* @__PURE__ */ new Map();\n      const pending = [];\n      async function walk(dir, prefix) {\n        for await (const [name, h] of dir.entries()) {\n          if (name.startsWith(".")) continue;\n          const rel = (prefix ? `${prefix}/${name}` : name).normalize("NFC");\n          if (h.kind === "directory") await walk(h, rel);\n          else {\n            handles.set(rel, h);\n            pending.push(h.getFile().then(\n              (f) => {\n                out.push({ path: rel, size: f.size, mtime: f.lastModified });\n              },\n              () => {\n                out.push({ path: rel, size: -1, mtime: -1 });\n              }\n            ));\n            if (pending.length >= 64) await Promise.all(pending.splice(0));\n          }\n        }\n      }\n      await walk(root, "");\n      await Promise.all(pending);\n      fileHandles = handles;\n      return out;\n    },\n    async readText(path) {\n      const h = await getFileHandle(path);\n      if (!h) throw new DOMException("missing", "NotFoundError");\n      return (await h.getFile()).text();\n    },\n    async stat(path) {\n      fileHandles.delete(path);\n      const h = await getFileHandle(path);\n      if (!h) return null;\n      try {\n        const f = await h.getFile();\n        return { path, size: f.size, mtime: f.lastModified };\n      } catch {\n        fileHandles.delete(path);\n        return null;\n      }\n    }\n  };\n  function openDb() {\n    return new Promise((res, rej) => {\n      const r = indexedDB.open(CACHE_DB, 1);\n      r.onupgradeneeded = () => r.result.createObjectStore(CACHE_STORE);\n      r.onsuccess = () => res(r.result);\n      r.onerror = () => rej(r.error);\n    });\n  }\n  async function loadCache(key) {\n    try {\n      const db = await openDb();\n      const rec = await new Promise((res, rej) => {\n        const q = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(key);\n        q.onsuccess = () => res(q.result);\n        q.onerror = () => rej(q.error);\n      });\n      db.close();\n      if (!rec || rec.v !== CACHE_VERSION) return /* @__PURE__ */ new Map();\n      return new Map(rec.entries);\n    } catch {\n      return /* @__PURE__ */ new Map();\n    }\n  }\n  var saveTimer;\n  function saveCacheSoon() {\n    clearTimeout(saveTimer);\n    saveTimer = setTimeout(async () => {\n      if (!engine) return;\n      try {\n        const db = await openDb();\n        await new Promise((res, rej) => {\n          const tx = db.transaction(CACHE_STORE, "readwrite");\n          tx.objectStore(CACHE_STORE).put({ v: CACHE_VERSION, entries: [...engine.cache] }, vaultKey);\n          tx.oncomplete = () => res();\n          tx.onerror = () => rej(tx.error);\n        });\n        db.close();\n      } catch {\n      }\n    }, 2e3);\n  }\n  async function dailyFormats() {\n    const fmts = ["YYYY-MM-DD"];\n    try {\n      const cfg = await root.getDirectoryHandle(".obsidian");\n      const f = await (await cfg.getFileHandle("daily-notes.json")).getFile();\n      const j = JSON.parse(await f.text());\n      if (typeof j.format === "string" && j.format.trim()) fmts.unshift(j.format.trim());\n    } catch {\n    }\n    return [...new Set(fmts)];\n  }\n  var pendingPaths = /* @__PURE__ */ new Set();\n  var needRescan = false;\n  var flushTimer;\n  function onRecords(records) {\n    for (const r of records) {\n      const path = (r.relativePathComponents ?? []).join("/").normalize("NFC");\n      if (r.type === "unknown" || r.type === "errored") {\n        needRescan = true;\n        continue;\n      }\n      if (!path || path.split("/").some((s) => s.startsWith("."))) continue;\n      if (r.type === "moved" && r.relativePathMovedFrom) pendingPaths.add(r.relativePathMovedFrom.join("/").normalize("NFC"));\n      if (r.changedHandle?.kind === "directory" || !/\\.[^/]+$/.test(path)) {\n        needRescan = true;\n        continue;\n      }\n      pendingPaths.add(path);\n    }\n    clearTimeout(flushTimer);\n    flushTimer = setTimeout(flush, 300);\n  }\n  async function flush() {\n    if (!engine) return;\n    const paths = [...pendingPaths];\n    pendingPaths = /* @__PURE__ */ new Set();\n    let changed = false;\n    if (needRescan) {\n      needRescan = false;\n      await build();\n      return;\n    }\n    changed = await engine.refresh(paths);\n    if (changed) {\n      saveCacheSoon();\n      post({ type: "changed", paths });\n    }\n  }\n  async function watch() {\n    observer?.disconnect();\n    observer = null;\n    if (typeof FileSystemObserver === "undefined") {\n      status("ready", "no live updates: FileSystemObserver unavailable");\n      return;\n    }\n    try {\n      observer = new FileSystemObserver(onRecords);\n      await observer.observe(root, { recursive: true });\n    } catch (e) {\n      observer = null;\n      status("ready", `no live updates: ${e.message}`);\n    }\n  }\n  async function build() {\n    status("indexing", "reading files");\n    engine = new VaultEngine(handleFS, await dailyFormats());\n    const stats = await engine.build(await loadCache(vaultKey), (done, total) => status("indexing", `${done} of ${total} notes`));\n    saveCacheSoon();\n    status("ready", `${stats.notes} notes`);\n    post({ type: "changed", paths: [] });\n    return stats;\n  }\n  var commands = {\n    async open({ handle, key }) {\n      root = handle;\n      vaultKey = key;\n      fileHandles = /* @__PURE__ */ new Map();\n      const stats = await build();\n      await watch();\n      return stats;\n    },\n    rescan: () => build(),\n    query: ({ title }) => engine ? engine.query(title) : null,\n    read: ({ path }) => engine.read(path),\n    resolve: ({ target, from }) => engine?.resolve(target, from) ?? null,\n    close() {\n      observer?.disconnect();\n      observer = null;\n      engine = null;\n      root = null;\n      return true;\n    }\n  };\n  self.onmessage = async ({ data }) => {\n    const { id, cmd, args } = data;\n    try {\n      post({ id, ok: true, result: await commands[cmd](args ?? {}) });\n    } catch (e) {\n      post({ id, ok: false, error: `${e.name}: ${e.message}` });\n    }\n  };\n})();\n'], { type: "text/javascript" }));
  const cmds = [
    ["External Vault References: Add vault folder", addVault],
    ["External Vault References: Rescan vaults", () => vaults.forEach((v) => v.call("rescan").catch((e) => notify(e.message, "error")))],
    ["External Vault References: Remove all vaults", removeAll]
  ];
  for (const [label, callback] of cmds) {
    extensionAPI.ui.commandPalette.addCommand({ label, callback });
    cleanups.push(() => extensionAPI.ui.commandPalette.removeCommand({ label }));
  }
  let frame = 0;
  const mo = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(inject);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => {
    mo.disconnect();
    cancelAnimationFrame(frame);
  });
  const onHash = () => requestAnimationFrame(inject);
  window.addEventListener("hashchange", onHash);
  cleanups.push(() => window.removeEventListener("hashchange", onHash));
  const saved = await loadVaults().catch(() => []);
  vaults = saved.map((x) => new Vault(x.id, x.handle));
  inject();
  await Promise.all(vaults.map((v) => v.connect(false)));
}
function onunload() {
  cleanups.splice(0).forEach((f) => f());
  vaults.forEach((v) => v.stop());
  vaults = [];
  URL.revokeObjectURL(workerUrl);
  closeViewer();
  removeToast();
  document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
}
var main_default = { onload, onunload };
export {
  main_default as default
};
