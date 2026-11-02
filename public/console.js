(function () {
  if (UI.blockMobile()) return;
  var $ = UI.$, msg = UI.msg, cell = UI.cell, button = UI.button;
  var KEY = "dns_admin";
  var key = UI.read(KEY);
  var teams = [];
  var loadSeq = 0;

  function setKey(k) { key = k; UI.store(KEY, k); }

  var api = UI.client(function () { return key; }, function () {
    setKey(null);
    msg("login-msg", "관리자 키가 거부되었습니다.");
    show();
  });

  function show() {
    UI.show("login-view", !key);
    UI.show("app-view", !!key);
    if (key) load();
    else { teams = []; $("teams").textContent = ""; $("tunnels").textContent = ""; }
  }

  UI.onSubmit($("login-form"), async function (f) {
    msg("login-msg", "");
    setKey(f.key.value.trim());
    try {
      await api("GET", "/admin/teams");
      f.reset();
      show();
    } catch (e) { setKey(null); msg("login-msg", e.message); }
  });
  $("logout").onclick = function () { setKey(null); show(); };
  $("reload").onclick = function () { load(); };
  $("filter").addEventListener("input", render);

  function cred(t, pw) {
    return "ID: " + t.team + "\n비밀번호: " + pw + "\n도메인: " + t.domain + "\n접속: " + location.origin + "/";
  }

  UI.onSubmit($("create-form"), async function (f) {
    msg("create-msg", "");
    var body = { team: f.team.value.trim().toLowerCase(), recordLimit: Number(f.recordLimit.value) || 10 };
    if (f.label.value.trim()) body.name = f.label.value.trim();
    if (f.password.value) body.password = f.password.value;
    try {
      var d = await api("POST", "/admin/teams", body);
      msg("create-msg", "추가했습니다. 비밀번호는 다시 볼 수 없으니 지금 전달하세요.\n\n" + cred(d.team, d.password), true);
      f.team.value = "";
      f.label.value = "";
      f.password.value = "";
      load();
    } catch (e) { msg("create-msg", e.message); }
  });

  async function load() {
    var seq = ++loadSeq;
    if ($("list-msg").className === "err") msg("list-msg", "");
    if ($("tunnel-msg").className === "err") msg("tunnel-msg", "");
    try {
      var d = await api("GET", "/admin/teams");
      if (seq !== loadSeq || !key) return;
      teams = d.teams;
      render();
    } catch (e) { if (seq === loadSeq) msg("list-msg", e.message); }
    loadTunnels(seq);
  }

  function render() {
    var q = $("filter").value.trim().toLowerCase();
    var tbody = $("teams");
    tbody.textContent = "";
    var shown = teams.filter(function (t) {
      return !q || [t.team, t.name, t.email].some(function (v) { return v && v.toLowerCase().indexOf(q) >= 0; });
    });
    shown.forEach(function (t) { tbody.appendChild(row(t)); });
    if (!shown.length) UI.emptyRow(tbody, 6, teams.length ? "검색 결과가 없습니다." : "계정이 없습니다.");
  }

  function row(t) {
    var tr = document.createElement("tr");
    var path = "/admin/teams/" + encodeURIComponent(t.team);
    cell(tr, t.team);
    cell(tr, [t.name, t.email].filter(Boolean).join(" / "), "wrap");
    cell(tr, t.recordCount + " / " + t.recordLimit);
    cell(tr, t.hasPassword ? "사용" : "-");
    cell(tr, t.isActive ? "활성" : "정지");
    var a = cell(tr, null, "act");

    a.append(button(t.hasPassword ? "비번 재발급" : "비번 발급", async function () {
      if (t.hasPassword && !confirm(t.team + " 비밀번호를 새로 만들까요? 로그인된 세션은 모두 끊깁니다.")) return;
      try {
        var r = await api("POST", path + "/password", {});
        msg("list-msg", "새 비밀번호입니다. 다시 볼 수 없으니 지금 전달하세요.\n\n" + cred(t, r.password), true);
        load();
      } catch (e) { msg("list-msg", e.message); }
    }));
    if (t.hasPassword) {
      a.append(" ", button("웹 로그인 끄기", async function () {
        if (!confirm(t.team + " 웹 로그인을 끌까요? API key는 그대로 동작합니다.")) return;
        try { await api("DELETE", path + "/password"); msg("list-msg", "웹 로그인을 껐습니다.", true); load(); }
        catch (e) { msg("list-msg", e.message); }
      }));
    }
    a.append(" ", button("한도", async function () {
      var v = prompt(t.team + " 레코드 한도 (1~100)", String(t.recordLimit));
      if (v === null) return;
      var n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 100) { msg("list-msg", "1~100 사이 정수를 입력하세요."); return; }
      try { await api("PATCH", path, { recordLimit: n }); load(); }
      catch (e) { msg("list-msg", e.message); }
    }));
    a.append(" ", button(t.isActive ? "정지" : "해제", async function () {
      if (t.isActive && !confirm(t.team + " 계정을 정지할까요? 레코드는 유지되고 수정만 막힙니다.")) return;
      try { await api("PATCH", path, { isActive: !t.isActive }); load(); }
      catch (e) { msg("list-msg", e.message); }
    }));
    return tr;
  }

  async function loadTunnels(seq) {
    var tbody = $("tunnels");
    try {
      var all = [];
      for (var page = 1; page <= 20; page++) {
        var d = await api("GET", "/admin/tunnels?limit=100&page=" + page);
        all = all.concat(d.tunnels);
        if (all.length >= d.total || !d.tunnels.length) break;
      }
      if (seq !== loadSeq || !key) return;
      var byId = {};
      teams.forEach(function (t) { byId[t.id] = t.team; });
      tbody.textContent = "";
      var rows = 0;
      all.forEach(function (t) {
        var owner = byId[t.studentId] || t.studentEmail;
        var hosts = t.hostnames.length ? t.hostnames : [null];
        hosts.forEach(function (h) {
          var tr = tbody.insertRow();
          cell(tr, owner);
          cell(tr, t.name);
          cell(tr, h ? h.fqdn : "(주소 없음)");
          cell(tr, h ? h.localPort : "");
          cell(tr, h ? h.protocol : "");
          rows++;
        });
      });
      if (!rows) UI.emptyRow(tbody, 5, "터널이 없습니다.");
      $("tunnel-count").textContent = "터널 " + all.length + "개";
    } catch (e) { if (seq === loadSeq) msg("tunnel-msg", e.message); }
  }

  show();
})();
