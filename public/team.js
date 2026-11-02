(function () {
  if (UI.blockMobile()) return;
  var $ = UI.$, msg = UI.msg, cell = UI.cell, button = UI.button;
  var KEY = "dns_session";
  var token = null;
  var me = null;
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
    if (token) load();
    else { me = null; $("records").textContent = ""; $("tunnels").textContent = ""; }
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
  $("reload").onclick = function () { load(); };

  async function load() {
    var seq = ++loadSeq;
    if ($("list-msg").className === "err") msg("list-msg", "");
    if ($("tunnel-msg").className === "err") msg("tunnel-msg", "");
    try {
      var r = await Promise.all([api("GET", "/v1/me"), api("GET", "/v1/records")]);
      if (seq !== loadSeq || !token) return;
      me = r[0].student;
      var records = r[1].records;
      $("domain").textContent = me.subdomain;
      $("usage").textContent = (me.name ? me.name + " · " : "") + "레코드 " + records.length + " / " + me.recordLimit;
      var tbody = $("records");
      tbody.textContent = "";
      records.forEach(function (rec) { tbody.appendChild(viewRow(rec)); });
      if (!records.length) UI.emptyRow(tbody, 6, "레코드가 없습니다.");
      preview();
    } catch (e) { if (seq === loadSeq) msg("list-msg", e.message); }
    loadTunnels(seq);
  }

  async function loadTunnels(seq) {
    var tbody = $("tunnels");
    try {
      var d = await api("GET", "/v1/tunnels");
      if (seq !== loadSeq || !token) return;
      tbody.textContent = "";
      var t = d.tunnel || {};
      $("tunnel-name").textContent = t.exists ? "터널 이름: " + t.name : "";
      var hosts = t.exists ? t.hostnames || [] : [];
      hosts.forEach(function (h) {
        var tr = tbody.insertRow();
        cell(tr, h.fqdn);
        cell(tr, h.localPort);
        cell(tr, h.protocol);
        cell(tr, new Date(h.createdAt).toLocaleString("ko-KR"));
      });
      if (!hosts.length) UI.emptyRow(tbody, 4, t.exists ? "연결된 주소가 없습니다." : "만든 터널이 없습니다.");
    } catch (e) { if (seq === loadSeq) msg("tunnel-msg", e.message); }
  }

  function viewRow(rec) {
    var tr = document.createElement("tr");
    cell(tr, rec.fqdn);
    cell(tr, rec.type);
    cell(tr, rec.content, "wrap");
    cell(tr, rec.ttl === 1 ? "auto" : rec.ttl);
    cell(tr, rec.proxied ? "on" : "off");
    var a = cell(tr, null, "act");
    a.append(
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

    cell(tr).append(name);
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
    var n = f.name.value.trim().toLowerCase();
    $("fqdn-preview").textContent = me && n ? "→ " + (n === "@" ? me.subdomain : n + "." + me.subdomain) : "";
  }
  f.name.addEventListener("input", preview);
  f.type.addEventListener("change", function () {
    var t = f.type.value;
    f.content.placeholder = { CNAME: "cname.vercel-dns.com", A: "203.0.113.10", AAAA: "2001:db8::1", TXT: "verification=..." }[t];
    f.proxied.disabled = t === "TXT";
    if (f.proxied.disabled) f.proxied.checked = false;
  });

  UI.onSubmit(f, async function () {
    msg("add-msg", "");
    try {
      await api("POST", "/v1/records", {
        name: f.name.value.trim(),
        type: f.type.value,
        content: f.content.value.trim(),
        ttl: Number(f.ttl.value),
        proxied: f.proxied.checked
      });
      f.name.value = "";
      f.content.value = "";
      preview();
      msg("add-msg", "추가했습니다. 반영까지 몇 분 걸릴 수 있습니다.", true);
      load();
    } catch (e) { msg("add-msg", e.message); }
  });

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
