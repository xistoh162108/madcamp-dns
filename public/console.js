(function () {
  if (UI.blockMobile()) return;
  var $ = UI.$, msg = UI.msg, cell = UI.cell, button = UI.button;
  var KEY = "dns_admin";
  var key = UI.read(KEY);
  var teams = [];
  var byId = {};
  var detail = null;      // team currently open in the detail panel
  var loadSeq = 0;
  var recPage = 1, auditPage = 1;
  var REC_LIMIT = 50, AUDIT_LIMIT = 50;

  var ACTIONS = [
    "STUDENT_CREATED", "STUDENTS_BULK_CREATED", "TEST_KEYS_CREATED", "STUDENT_UPDATED",
    "API_KEY_CREATED", "API_KEY_ROTATED", "API_KEY_REVOKED",
    "DNS_RECORD_CREATED", "DNS_RECORD_UPDATED", "DNS_RECORD_DELETED", "ADMIN_RECORD_DELETED",
    "SUBDOMAIN_CLAIMED", "SUBDOMAIN_RELEASED",
    "TUNNEL_CREATED", "TUNNEL_HOSTNAME_CREATED", "TUNNEL_HOSTNAME_DELETED", "ADMIN_TUNNEL_HOSTNAME_DELETED", "TUNNEL_DELETED",
    "TEAM_CREATED", "TEAM_PASSWORD_SET", "TEAM_PASSWORD_CHANGED", "TEAM_LOGIN", "TEAM_LOGIN_FAILED"
  ];
  ACTIONS.forEach(function (a) { $("audit-form").action.add(new Option(a, a)); });

  function setKey(k) { key = k; UI.store(KEY, k); }

  var api = UI.client(function () { return key; }, function () {
    setKey(null);
    msg("login-msg", "관리자 키가 거부되었습니다.");
    show();
  });

  function show() {
    UI.show("login-view", !key);
    UI.show("app-view", !!key);
    hideSecret();
    if (key) load();
    else {
      teams = []; byId = {}; closeDetail();
      ["teams", "tunnels", "all-records", "audit"].forEach(function (id) { $(id).textContent = ""; });
    }
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
  $("reload").onclick = function () {
    ["list-msg", "tunnel-msg", "rec-msg", "audit-msg", "detail-msg", "create-msg", "student-msg", "bulk-msg", "test-msg"].forEach(function (id) {
      if ($(id).className === "err") msg(id, "");
    });
    load();
  };
  $("filter").addEventListener("input", renderTeams);

  // ── One-time secrets (passwords, API keys) ─────────────────────────
  function showSecret(text) {
    $("secret-text").textContent = text;
    UI.show("secret-box", true);
    $("secret-box").scrollIntoView({ block: "start" });
  }
  function hideSecret() { $("secret-text").textContent = ""; UI.show("secret-box", false); }
  $("secret-hide").onclick = hideSecret;

  function cred(t, pw) {
    return "ID: " + t.team + "\n비밀번호: " + pw + "\n도메인: " + t.domain + "\n접속: " + location.origin + "/";
  }

  // ── Create ─────────────────────────────────────────────────────────
  UI.onSubmit($("create-form"), async function (f) {
    msg("create-msg", "");
    var body = { team: f.team.value.trim().toLowerCase(), recordLimit: Number(f.recordLimit.value) || 10 };
    if (f.label.value.trim()) body.name = f.label.value.trim();
    if (f.password.value) body.password = f.password.value;
    try {
      var d = await api("POST", "/admin/teams", body);
      showSecret(cred(d.team, d.password));
      f.team.value = ""; f.label.value = ""; f.password.value = "";
      msg("create-msg", "만들었습니다.", true);
      load();
    } catch (e) { msg("create-msg", e.message); }
  });

  async function issuePassword(sub) {
    return (await api("POST", "/admin/teams/" + encodeURIComponent(sub) + "/password", {})).password;
  }
  function bare(fqdn) { return fqdn.split(".")[0]; }

  UI.onSubmit($("student-form"), async function (f) {
    msg("student-msg", "");
    var body = {
      email: f.email.value.trim(),
      subdomain: f.sub.value.trim().toLowerCase(),
      recordLimit: Number(f.recordLimit.value) || 10
    };
    if (f.label.value.trim()) body.name = f.label.value.trim();
    try {
      var d = await api("POST", "/admin/students", body);
      var text = "이메일: " + d.student.email + "\n도메인: " + d.student.subdomain + "\nAPI 키: " + d.apiKey;
      if (f.withPw.checked) {
        try { text += "\n웹 비밀번호: " + (await issuePassword(body.subdomain)) + "\n접속: " + location.origin + "/"; }
        catch (e) { text += "\n(웹 비밀번호 발급 실패: " + e.message + ")"; }
      }
      showSecret(text);
      f.email.value = ""; f.label.value = ""; f.sub.value = "";
      msg("student-msg", "만들었습니다.", true);
      load();
    } catch (e) { msg("student-msg", e.message); }
  });

  UI.onSubmit($("bulk-form"), async function (f) {
    msg("bulk-msg", "");
    var rows = f.rows.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var students = [];
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i].split(",").map(function (x) { return x.trim(); });
      if (p.length !== 3 || !p[0] || !p[2]) { msg("bulk-msg", (i + 1) + "번째 줄 형식이 틀렸습니다: " + rows[i]); return; }
      var s = { email: p[0], subdomain: p[2].toLowerCase() };
      if (p[1]) s.name = p[1];
      students.push(s);
    }
    if (!students.length) { msg("bulk-msg", "내용이 없습니다."); return; }
    if (students.length > 100) { msg("bulk-msg", "한 번에 100명까지 가능합니다."); return; }
    try {
      var d = await api("POST", "/admin/students/bulk", { students: students, recordLimit: Number(f.recordLimit.value) || 10 });
      var lines = ["이메일,도메인,API 키" + (f.withPw.checked ? ",웹 비밀번호" : "")];
      for (var j = 0; j < d.students.length; j++) {
        var r = d.students[j];
        var line = r.email + "," + r.subdomain + "," + r.apiKey;
        if (f.withPw.checked) {
          try { line += "," + (await issuePassword(bare(r.subdomain))); }
          catch (e) { line += ",(발급 실패: " + e.message + ")"; }
        }
        lines.push(line);
      }
      showSecret(lines.join("\n"));
      f.rows.value = "";
      msg("bulk-msg", d.students.length + "명을 만들었습니다.", true);
      load();
    } catch (e) { msg("bulk-msg", e.message); }
  });

  UI.onSubmit($("test-form"), async function (f) {
    msg("test-msg", "");
    try {
      var d = await api("POST", "/admin/test-keys", { count: Number(f.count.value) || 2, recordLimit: Number(f.recordLimit.value) || 10 });
      showSecret(["이메일,도메인,API 키"].concat(d.testStudents.map(function (r) {
        return r.email + "," + r.subdomain + "," + r.apiKey;
      })).join("\n"));
      msg("test-msg", d.testStudents.length + "개를 만들었습니다.", true);
      load();
    } catch (e) { msg("test-msg", e.message); }
  });

  // ── Load ───────────────────────────────────────────────────────────
  async function load() {
    var seq = ++loadSeq;
    try {
      var d = await api("GET", "/admin/teams");
      if (seq !== loadSeq || !key) return;
      teams = d.teams;
      byId = {};
      teams.forEach(function (t) { byId[t.id] = t; });
      renderTeams();
      var accountOpts = [["", "전체"]].concat(teams.map(function (t) { return [t.id, t.team]; }));
      UI.fillSelect($("rec-filter"), accountOpts);
      UI.fillSelect($("audit-form").student, accountOpts);
      if (detail) {
        if (byId[detail.id]) openDetail(byId[detail.id], true);
        else closeDetail();
      }
    } catch (e) { if (seq === loadSeq) msg("list-msg", e.message); return; }
    loadRecords(seq);
    loadTunnels(seq);
    loadAudit(seq);
  }

  function owner(studentId, fallback) { return byId[studentId] ? byId[studentId].team : (fallback || studentId || ""); }

  // ── Accounts ───────────────────────────────────────────────────────
  function renderTeams() {
    var q = $("filter").value.trim().toLowerCase();
    var tbody = $("teams");
    tbody.textContent = "";
    var shown = teams.filter(function (t) {
      return !q || [t.team, t.name, t.email].some(function (v) { return v && v.toLowerCase().indexOf(q) >= 0; });
    });
    shown.forEach(function (t) { tbody.appendChild(teamRow(t)); });
    if (!shown.length) UI.emptyRow(tbody, 6, teams.length ? "검색 결과가 없습니다." : "계정이 없습니다.");
    $("account-count").textContent = "계정 " + teams.length + "개";
  }

  function teamRow(t) {
    var tr = document.createElement("tr");
    var path = "/admin/teams/" + encodeURIComponent(t.team);
    cell(tr, t.team);
    cell(tr, [t.name, t.email].filter(Boolean).join(" / "));
    cell(tr, t.recordCount + " / " + t.recordLimit);
    cell(tr, t.hasPassword ? "사용" : "-");
    cell(tr, t.isActive ? "활성" : "정지");
    var a = cell(tr, null, "act");
    a.append(button("상세", function () { openDetail(t); }));
    a.append(" ", button(t.hasPassword ? "비번 재발급" : "비번 발급", async function () {
      if (t.hasPassword && !confirm(t.team + " 비밀번호를 새로 만들까요? 로그인된 세션은 모두 끊깁니다.")) return;
      try { showSecret(cred(t, await issuePassword(t.team))); load(); }
      catch (e) { msg("list-msg", e.message); }
    }));
    if (t.hasPassword) {
      a.append(" ", button("웹 로그인 끄기", async function () {
        if (!confirm(t.team + " 웹 로그인을 끌까요? API 키는 그대로 동작합니다.")) return;
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

  // ── Account detail: name, API keys, records ────────────────────────
  function closeDetail() { detail = null; UI.show("detail", false); }
  $("detail-close").onclick = closeDetail;

  async function openDetail(t, keepScroll) {
    detail = t;
    UI.show("detail", true);
    $("detail-title").textContent = t.team + " (" + t.domain + ")";
    $("rename-form").label.value = t.name || "";
    if (!keepScroll) $("detail").scrollIntoView({ block: "start" });
    var sid = encodeURIComponent(t.id);
    try {
      var r = await Promise.all([
        api("GET", "/admin/students/" + sid + "/api-keys"),
        api("GET", "/admin/records?limit=100&studentId=" + sid)
      ]);
      if (!detail || detail.id !== t.id) return;
      renderKeys(t, r[0].apiKeys);
      renderDetailRecords(r[1].records);
    } catch (e) { msg("detail-msg", e.message); }
  }

  function renderKeys(t, keys) {
    var tbody = $("keys");
    tbody.textContent = "";
    keys.forEach(function (k) {
      var tr = tbody.insertRow();
      cell(tr, k.keyPrefix + "…");
      cell(tr, k.label || "");
      cell(tr, k.isActive ? "사용 중" : "폐기됨");
      cell(tr, UI.date(k.lastUsedAt));
      cell(tr, k.label === "web-session" ? "웹 로그인" : "API 키");
      cell(tr, UI.date(k.createdAt));
      var a = cell(tr, null, "act");
      if (k.isActive) {
        a.append(button("폐기", async function () {
          if (!confirm(k.keyPrefix + "… 키를 폐기할까요?")) return;
          try {
            await api("DELETE", "/admin/students/" + encodeURIComponent(t.id) + "/api-keys/" + encodeURIComponent(k.id));
            msg("detail-msg", "폐기했습니다.", true);
            openDetail(t, true);
          } catch (e) { msg("detail-msg", e.message); }
        }));
      }
    });
    if (!keys.length) UI.emptyRow(tbody, 7, "키가 없습니다.");
  }

  function renderDetailRecords(records) {
    var tbody = $("detail-records");
    tbody.textContent = "";
    records.forEach(function (r) {
      var tr = tbody.insertRow();
      cell(tr, r.fqdn);
      cell(tr, r.type);
      cell(tr, r.content, UI.valueClass(r.content));
      cell(tr, r.proxied ? "on" : "off");
      cell(tr, r.cloudflareRecordId, "small");
      cell(tr, null, "act").append(forceDeleteButton(r, "detail-msg"));
    });
    if (!records.length) UI.emptyRow(tbody, 6, "레코드가 없습니다.");
  }

  function forceDeleteButton(r, msgId) {
    return button("강제 삭제", async function () {
      if (!confirm(r.fqdn + " (" + r.type + ") 레코드를 강제로 삭제할까요?")) return;
      try { await api("DELETE", "/admin/records/" + encodeURIComponent(r.id)); msg(msgId, "삭제했습니다.", true); load(); }
      catch (e) { msg(msgId, e.message); }
    });
  }

  UI.onSubmit($("rename-form"), async function (f) {
    if (!detail) return;
    try {
      await api("PATCH", "/admin/teams/" + encodeURIComponent(detail.team), { name: f.label.value.trim() });
      msg("detail-msg", "이름을 저장했습니다.", true);
      load();
    } catch (e) { msg("detail-msg", e.message); }
  });

  UI.onSubmit($("key-form"), async function (f) {
    if (!detail) return;
    var t = detail;
    try {
      var body = f.label.value.trim() ? { label: f.label.value.trim() } : {};
      var d = await api("POST", "/admin/students/" + encodeURIComponent(t.id) + "/api-keys", body);
      showSecret("계정: " + t.team + "\nAPI 키: " + d.apiKey);
      f.label.value = "";
      openDetail(t, true);
    } catch (e) { msg("detail-msg", e.message); }
  });

  $("rotate").onclick = async function () {
    if (!detail) return;
    var t = detail;
    if (!confirm(t.team + " 의 모든 키(웹 세션 포함)를 폐기하고 새 키 하나를 발급할까요?")) return;
    try {
      var d = await api("POST", "/admin/students/" + encodeURIComponent(t.id) + "/rotate-key");
      showSecret("계정: " + t.team + "\n새 API 키: " + d.apiKey);
      openDetail(t, true);
    } catch (e) { msg("detail-msg", e.message); }
  };

  $("detail-audit").onclick = function () {
    if (!detail) return;
    var f = $("audit-form");
    f.student.value = detail.id;
    f.action.value = "";
    auditPage = 1;
    loadAudit(loadSeq);
    $("sec-audit").scrollIntoView({ block: "start" });
  };

  // ── All records ────────────────────────────────────────────────────
  async function loadRecords(seq) {
    var sid = $("rec-filter").value;
    try {
      var d = await api("GET", "/admin/records?limit=" + REC_LIMIT + "&page=" + recPage + (sid ? "&studentId=" + encodeURIComponent(sid) : ""));
      if (seq !== loadSeq) return;
      var pages = Math.max(1, Math.ceil(d.total / REC_LIMIT));
      if (recPage > pages) { recPage = pages; return loadRecords(seq); }
      var tbody = $("all-records");
      tbody.textContent = "";
      d.records.forEach(function (r) {
        var tr = tbody.insertRow();
        cell(tr, owner(r.studentId, r.subdomain));
        cell(tr, r.fqdn);
        cell(tr, r.type);
        cell(tr, r.content, UI.valueClass(r.content));
        cell(tr, r.ttl === 1 ? "auto" : r.ttl);
        cell(tr, r.proxied ? "on" : "off");
        cell(tr, UI.date(r.updatedAt), null);
        cell(tr, null, "act").append(forceDeleteButton(r, "rec-msg"));
      });
      if (!d.records.length) UI.emptyRow(tbody, 8, "레코드가 없습니다.");
      $("rec-page").textContent = recPage + " / " + pages + " 페이지 (총 " + d.total + "개)";
      $("rec-prev").disabled = recPage <= 1;
      $("rec-next").disabled = recPage >= pages;
    } catch (e) { if (seq === loadSeq) msg("rec-msg", e.message); }
  }
  $("rec-filter").addEventListener("change", function () { recPage = 1; loadRecords(loadSeq); });
  $("rec-prev").onclick = function () { if (recPage > 1) { recPage--; loadRecords(loadSeq); } };
  $("rec-next").onclick = function () { recPage++; loadRecords(loadSeq); };

  // ── Tunnels ────────────────────────────────────────────────────────
  async function loadTunnels(seq) {
    var tbody = $("tunnels");
    try {
      var all = [];
      for (var page = 1; page <= 20; page++) {
        var d = await api("GET", "/admin/tunnels?limit=100&page=" + page);
        all = all.concat(d.tunnels);
        if (all.length >= d.total || !d.tunnels.length) break;
      }
      if (seq !== loadSeq) return;
      tbody.textContent = "";
      all.forEach(function (t) {
        var who = owner(t.studentId, t.studentEmail);
        var delTunnel = button("터널 삭제", async function () {
          if (!confirm(t.name + " 터널과 연결된 주소 " + t.hostnames.length + "개를 모두 삭제할까요?")) return;
          try { await api("DELETE", "/admin/tunnels/" + encodeURIComponent(t.id)); msg("tunnel-msg", "터널을 삭제했습니다.", true); load(); }
          catch (e) { msg("tunnel-msg", e.message); }
        });
        if (!t.hostnames.length) {
          var tr = tbody.insertRow();
          cell(tr, who); cell(tr, t.name); cell(tr, "(주소 없음)"); cell(tr, ""); cell(tr, "");
          cell(tr, null, "act").append(delTunnel);
          return;
        }
        t.hostnames.forEach(function (h, i) {
          var tr = tbody.insertRow();
          cell(tr, who);
          cell(tr, t.name);
          cell(tr, h.fqdn);
          cell(tr, h.localPort);
          cell(tr, h.protocol);
          var a = cell(tr, null, "act");
          a.append(button("주소 삭제", async function () {
            if (!confirm(h.fqdn + " 터널 주소를 삭제할까요?")) return;
            try { await api("DELETE", "/admin/tunnels/hostnames/" + encodeURIComponent(h.id)); msg("tunnel-msg", "주소를 삭제했습니다.", true); load(); }
            catch (e) { msg("tunnel-msg", e.message); }
          }));
          if (i === 0) a.append(" ", delTunnel);
        });
      });
      if (!all.length) UI.emptyRow(tbody, 6, "터널이 없습니다.");
      $("tunnel-count").textContent = "터널 " + all.length + "개";
    } catch (e) { if (seq === loadSeq) msg("tunnel-msg", e.message); }
  }

  // ── Audit log ──────────────────────────────────────────────────────
  function filled(v) { return v && typeof v === "object" && Object.keys(v).length > 0; }
  // "key=value, key=value" breaks cleanly at the spaces instead of inside a value.
  function pairs(o) {
    return Object.keys(o).map(function (k) {
      var v = o[k];
      return k + "=" + (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
    }).join(", ");
  }
  function summary(log) {
    var parts = [];
    if (filled(log.beforeJson)) parts.push("전: " + pairs(log.beforeJson));
    if (filled(log.afterJson)) parts.push("후: " + pairs(log.afterJson));
    return parts.join(" / ");
  }

  async function loadAudit(seq) {
    var f = $("audit-form");
    var q = "limit=" + AUDIT_LIMIT + "&page=" + auditPage;
    if (f.student.value) q += "&studentId=" + encodeURIComponent(f.student.value);
    if (f.action.value) q += "&action=" + encodeURIComponent(f.action.value);
    if (f.after.value) q += "&after=" + encodeURIComponent(new Date(f.after.value).toISOString());
    if (f.before.value) q += "&before=" + encodeURIComponent(new Date(f.before.value).toISOString());
    try {
      var d = await api("GET", "/admin/audit-logs?" + q);
      if (seq !== loadSeq) return;
      var pages = Math.max(1, Math.ceil(d.total / AUDIT_LIMIT));
      var tbody = $("audit");
      tbody.textContent = "";
      d.logs.forEach(function (l) {
        var tr = tbody.insertRow();
        cell(tr, UI.date(l.createdAt), null);
        cell(tr, l.actorType === "ADMIN" ? "관리자" : owner(l.actorId, l.actorType), null);
        cell(tr, l.studentId ? owner(l.studentId) : "", null);
        cell(tr, l.action, null);
        var s = summary(l);
        var td = cell(tr, s.length > 160 ? s.slice(0, 160) + "…" : s, "wrap small");
        td.title = s;
        cell(tr, l.ip || "");
      });
      if (!d.logs.length) UI.emptyRow(tbody, 6, "기록이 없습니다.");
      $("audit-page").textContent = auditPage + " / " + pages + " 페이지 (총 " + d.total + "건)";
      $("audit-prev").disabled = auditPage <= 1;
      $("audit-next").disabled = auditPage >= pages;
    } catch (e) { if (seq === loadSeq) msg("audit-msg", e.message); }
  }
  UI.onSubmit($("audit-form"), async function () { msg("audit-msg", ""); auditPage = 1; await loadAudit(loadSeq); });
  $("audit-prev").onclick = function () { if (auditPage > 1) { auditPage--; loadAudit(loadSeq); } };
  $("audit-next").onclick = function () { auditPage++; loadAudit(loadSeq); };

  show();
})();
