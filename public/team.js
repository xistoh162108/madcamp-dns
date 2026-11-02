(function () {
  if (UI.blockMobile()) return;
  var $ = UI.$, msg = UI.msg, cell = UI.cell, button = UI.button;
  var KEY = "dns_session";
  var token = null;
  var me = null;
  var subs = [];        // [{ subdomain, fqdn, primary, id?, createdAt? }]
  var loadSeq = 0;

  try {
    var saved = JSON.parse(UI.read(KEY) || "null");
    if (saved && saved.token && new Date(saved.expiresAt) > new Date()) token = saved.token;
  } catch (e) {}

  function setSession(s) {
    token = s ? s.token : null;
    UI.store(KEY, s ? JSON.stringify(s) : null);
  }

  var api = UI.client(function () { return token; }, function () {
    setSession(null);
    msg("login-msg", "로그인이 만료되었습니다. 다시 로그인해 주세요.");
    show();
  });

  function show() {
    UI.show("login-view", !token);
    UI.show("app-view", !!token);
    hideInstall();
    if (token) load();
    else {
      me = null;
      ["records", "tunnels", "subdomains"].forEach(function (id) { $(id).textContent = ""; });
    }
  }

  UI.onSubmit($("login-form"), async function (f) {
    msg("login-msg", "");
    try {
      var d = await api("POST", "/auth/login", { id: f.user.value.trim(), password: f.password.value });
      setSession({ token: d.token, expiresAt: d.expiresAt });
      f.reset();
      show();
    } catch (e) { msg("login-msg", e.message); }
  });

  $("logout").onclick = async function () {
    try { await api("POST", "/auth/logout"); } catch (e) {}
    setSession(null);
    show();
  };
  $("reload").onclick = function () {
    clearErrors(["list-msg", "tunnel-msg", "sub-msg", "add-msg", "pw-msg"]);
    load();
  };

  // ── Load everything ────────────────────────────────────────────────
  function clearErrors(ids) { ids.forEach(function (id) { if ($(id).className === "err") msg(id, ""); }); }

  async function load() {
    var seq = ++loadSeq;
    var r;
    try {
      r = await Promise.all([api("GET", "/v1/me"), api("GET", "/v1/subdomains"), api("GET", "/v1/records")]);
    } catch (e) { if (seq === loadSeq) msg("list-msg", e.message); return; }
    if (seq !== loadSeq || !token) return;

    me = r[0].student;
    $("domain").textContent = me.subdomain;
    renderSubdomains(r[1]);
    renderRecords(r[2].records);

    var hostCount = await loadTunnel(seq);
    if (seq !== loadSeq) return;
    $("usage").textContent = (me.name ? me.name + " · " : "") + "레코드 " + r[2].records.length +
      (hostCount ? " + 터널 주소 " + hostCount : "") + " / 한도 " + me.recordLimit;
  }

  // ── Subdomains ─────────────────────────────────────────────────────
  function renderSubdomains(d) {
    subs = [{ subdomain: d.primary.subdomain, fqdn: d.primary.fqdn, primary: true }].concat(
      d.additional.map(function (a) { return { id: a.id, subdomain: a.subdomain, fqdn: a.fqdn, createdAt: a.createdAt }; })
    );
    var tbody = $("subdomains");
    tbody.textContent = "";
    subs.forEach(function (s) {
      var tr = tbody.insertRow();
      cell(tr, s.fqdn);
      cell(tr, s.primary ? "기본" : "추가");
      cell(tr, UI.date(s.createdAt));
      var a = cell(tr, null, "act");
      if (!s.primary) {
        a.append(button("반납", async function () {
          if (!confirm(s.fqdn + " 을(를) 반납할까요? 이 아래에 레코드나 터널 주소가 있으면 먼저 지워야 합니다.")) return;
          try { await api("DELETE", "/v1/subdomains/" + encodeURIComponent(s.id)); msg("sub-msg", "반납했습니다.", true); }
          catch (e) { msg("sub-msg", e.message); }
          load();
        }));
      }
    });
    $("claim-count").textContent = "추가 " + d.additionalUsed + " / " + d.additionalLimit + "개";
    var opts = subs.map(function (s) { return [s.subdomain, s.fqdn]; });
    UI.fillSelect($("add-form").sub, opts);
    UI.fillSelect($("host-form").sub, opts);
    preview();
    hostPreview();
  }

  UI.onSubmit($("claim-form"), async function (cf) {
    msg("sub-msg", "");
    try {
      var d = await api("POST", "/v1/subdomains", { subdomain: cf.sub.value.trim().toLowerCase() });
      cf.reset();
      msg("sub-msg", d.subdomain.fqdn + " 을(를) 추가했습니다.", true);
      load();
    } catch (e) { msg("sub-msg", e.message); }
  });

  // ── Records ────────────────────────────────────────────────────────
  function baseOf(rec) { return rec.name === "@" ? rec.fqdn : rec.fqdn.slice(rec.name.length + 1); }
  function fqdnFor(name, base) {
    var n = name.trim().toLowerCase();
    return !n ? "" : n === "@" ? base : n + "." + base;
  }
  function target(type, content) {
    if (!content) return "";
    if (type === "TXT") return "텍스트 \"" + content + "\"";
    if (type === "CNAME") return "→ " + content;
    return "→ " + content + " (서버 IP)";
  }
  function addressCell(tr, fqdn, linkable) {
    var td = cell(tr);
    if (!linkable) { td.textContent = fqdn; return; }
    var a = document.createElement("a");
    a.href = "http://" + fqdn + "/";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = fqdn;
    td.append(a);
  }
  function rootDomain() { return me ? me.subdomain.slice(me.subdomain.indexOf(".") + 1) : ""; }

  function renderRecords(records) {
    var tbody = $("records");
    tbody.textContent = "";
    records.forEach(function (rec) { tbody.appendChild(viewRow(rec)); });
    if (!records.length) UI.emptyRow(tbody, 6, "레코드가 없습니다.");
  }

  function viewRow(rec) {
    var tr = document.createElement("tr");
    addressCell(tr, rec.fqdn, rec.type !== "TXT");
    cell(tr, rec.type);
    var tgt = target(rec.type, rec.content);
    cell(tr, tgt, UI.valueClass(tgt));
    cell(tr, rec.ttl === 1 ? "auto" : rec.ttl);
    cell(tr, rec.proxied ? "on" : "off");
    cell(tr, null, "act").append(
      button("수정", function () { tr.replaceWith(editRow(rec)); }),
      " ",
      button("삭제", async function () {
        if (!confirm(rec.fqdn + " (" + rec.type + ") 레코드를 삭제할까요?")) return;
        try { await api("DELETE", "/v1/records/" + encodeURIComponent(rec.id)); msg("list-msg", "삭제했습니다.", true); }
        catch (e) { msg("list-msg", e.message); }
        load();
      })
    );
    return tr;
  }

  function input(value, size, max) {
    var i = document.createElement("input");
    i.value = value;
    i.size = size;
    i.maxLength = max;
    return i;
  }

  function editRow(rec) {
    var tr = document.createElement("tr");
    tr.className = "editing";
    var name = input(rec.name, 10, 128);
    var content = input(rec.content, 26, 2048);
    var ttl = document.createElement("select");
    [[1, "auto"], [300, "300"], [3600, "3600"]].forEach(function (o) { ttl.add(new Option(o[1], o[0], false, o[0] === rec.ttl)); });
    if ([1, 300, 3600].indexOf(rec.ttl) < 0) ttl.add(new Option(String(rec.ttl), rec.ttl, false, true));
    var px = document.createElement("input");
    px.type = "checkbox";
    px.checked = rec.proxied;
    px.disabled = rec.type === "TXT";

    var base = baseOf(rec);
    var hint = document.createElement("div");
    hint.className = "small";
    function update() { hint.textContent = (fqdnFor(name.value, base) || "(이름 없음)") + " " + target(rec.type, content.value.trim()); }
    name.addEventListener("input", update);
    content.addEventListener("input", update);
    update();

    cell(tr).append(name, hint);
    cell(tr, rec.type);
    cell(tr).append(content);
    cell(tr).append(ttl);
    cell(tr).append(px);
    cell(tr, null, "act").append(
      button("저장", async function () {
        var p = {};
        var n = name.value.trim(), c = content.value.trim();
        if (!n || !c) { msg("list-msg", "이름과 값을 비울 수 없습니다."); return; }
        if (n !== rec.name) p.name = n;
        if (c !== rec.content) p.content = c;
        if (Number(ttl.value) !== rec.ttl) p.ttl = Number(ttl.value);
        if (px.checked !== rec.proxied) p.proxied = px.checked;
        if (!Object.keys(p).length) { tr.replaceWith(viewRow(rec)); return; }
        try {
          await api("PATCH", "/v1/records/" + encodeURIComponent(rec.id), p);
          msg("list-msg", "저장했습니다.", true);
          load();
        } catch (e) { msg("list-msg", e.message); }
      }),
      " ",
      button("취소", function () { msg("list-msg", ""); tr.replaceWith(viewRow(rec)); })
    );
    return tr;
  }

  var f = $("add-form");
  function preview() {
    var base = me && f.sub.value ? f.sub.value + "." + rootDomain() : "";
    var host = base ? fqdnFor(f.name.value, base) : "";
    $("fqdn-preview").textContent = host ? "미리보기: " + host + " " + target(f.type.value, f.content.value.trim()) : "";
  }
  f.name.addEventListener("input", preview);
  f.content.addEventListener("input", preview);
  f.sub.addEventListener("change", preview);
  f.type.addEventListener("change", function () {
    var t = f.type.value;
    f.content.placeholder = { CNAME: "cname.vercel-dns.com", A: "203.0.113.10", AAAA: "2001:db8::1", TXT: "verification=..." }[t];
    f.proxied.disabled = t === "TXT";
    if (f.proxied.disabled) f.proxied.checked = false;
    preview();
  });

  UI.onSubmit(f, async function () {
    msg("add-msg", "");
    var body = {
      name: f.name.value.trim(),
      type: f.type.value,
      content: f.content.value.trim(),
      ttl: Number(f.ttl.value),
      proxied: f.proxied.checked
    };
    if (f.sub.value && subs.length && f.sub.value !== subs[0].subdomain) body.subdomain = f.sub.value;
    try {
      await api("POST", "/v1/records", body);
      f.name.value = "";
      f.content.value = "";
      preview();
      msg("add-msg", "추가했습니다. 반영까지 몇 분 걸릴 수 있습니다.", true);
      load();
    } catch (e) { msg("add-msg", e.message); }
  });

  // ── Tunnel ─────────────────────────────────────────────────────────
  async function loadTunnel(seq) {
    var d;
    try { d = await api("GET", "/v1/tunnels"); }
    catch (e) { if (seq === loadSeq) msg("tunnel-msg", e.message); return 0; }
    if (seq !== loadSeq || !token) return 0;
    var t = d.tunnel || {};
    UI.show("tunnel-none", !t.exists);
    UI.show("tunnel-exists", !!t.exists);
    var tbody = $("tunnels");
    tbody.textContent = "";
    if (!t.exists) return 0;
    $("tunnel-name").textContent = "터널 이름: " + t.name;
    var hosts = t.hostnames || [];
    hosts.forEach(function (h) {
      var tr = tbody.insertRow();
      addressCell(tr, h.fqdn, true);
      cell(tr, h.localPort);
      cell(tr, h.protocol);
      cell(tr, UI.date(h.createdAt));
      cell(tr, null, "act").append(button("삭제", async function () {
        if (!confirm(h.fqdn + " 터널 주소를 삭제할까요?")) return;
        try { await api("DELETE", "/v1/tunnels/hostnames/" + encodeURIComponent(h.id)); msg("tunnel-msg", "삭제했습니다.", true); }
        catch (e) { msg("tunnel-msg", e.message); }
        load();
      }));
    });
    if (!hosts.length) UI.emptyRow(tbody, 5, "연결된 주소가 없습니다.");
    return hosts.length;
  }

  function showInstall(cmd) {
    $("install-cmd").textContent = cmd;
    UI.show("install-box", true);
  }
  function hideInstall() {
    $("install-cmd").textContent = "";
    UI.show("install-box", false);
  }
  $("install-hide").onclick = hideInstall;

  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  $("tunnel-create").onclick = function () {
    return busy(this, async function () {
      msg("tunnel-msg", "");
      try {
        var d = await api("POST", "/v1/tunnels");
        showInstall(d.installCommand);
        msg("tunnel-msg", "터널을 만들었습니다.", true);
        load();
      } catch (e) { msg("tunnel-msg", e.message); }
    });
  };

  $("tunnel-token").onclick = function () {
    return busy(this, async function () {
      msg("tunnel-msg", "");
      try { showInstall((await api("GET", "/v1/tunnels/token")).installCommand); }
      catch (e) { msg("tunnel-msg", e.message); }
    });
  };

  var hf = $("host-form");
  function hostPreview() {
    var base = me && hf.sub.value ? hf.sub.value + "." + rootDomain() : "";
    var host = base ? fqdnFor(hf.name.value, base) : "";
    $("host-preview").textContent = host && hf.port.value ? "미리보기: " + host + " → VM의 localhost:" + hf.port.value : "";
  }
  hf.name.addEventListener("input", hostPreview);
  hf.port.addEventListener("input", hostPreview);
  hf.sub.addEventListener("change", hostPreview);

  UI.onSubmit(hf, async function () {
    msg("tunnel-msg", "");
    try {
      await api("POST", "/v1/tunnels/hostnames", {
        subdomain: hf.sub.value,
        name: hf.name.value.trim() || "@",
        localPort: Number(hf.port.value)
      });
      hf.port.value = "";
      hf.name.value = "@";
      hostPreview();
      msg("tunnel-msg", "주소를 추가했습니다.", true);
      load();
    } catch (e) { msg("tunnel-msg", e.message); }
  });

  // ── Password ───────────────────────────────────────────────────────
  UI.onSubmit($("pw-form"), async function (pf) {
    msg("pw-msg", "");
    if (pf.newPassword.value !== pf.confirm.value) { msg("pw-msg", "새 비밀번호 확인이 일치하지 않습니다."); return; }
    try {
      await api("POST", "/auth/password", { currentPassword: pf.currentPassword.value, newPassword: pf.newPassword.value });
      pf.reset();
      msg("pw-msg", "비밀번호를 변경했습니다.", true);
    } catch (e) { msg("pw-msg", e.message); }
  });

  show();
})();
