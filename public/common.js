var UI = (function () {
  function $(id) { return document.getElementById(id); }

  // Desktop only. Touch-only devices (incl. iPads reporting a desktop UA) are refused.
  function isMobile() {
    var touchOnly = window.matchMedia && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
    return touchOnly || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function blockMobile() {
    if (!isMobile()) return false;
    document.body.textContent = "";
    var h = document.createElement("h1");
    h.textContent = "PC에서 접속해 주세요";
    var p = document.createElement("p");
    p.textContent = "이 페이지는 모바일 기기를 지원하지 않습니다.";
    document.body.append(h, p);
    return true;
  }

  function store(key, value) {
    try {
      if (value == null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch (e) {}
  }
  function read(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }

  // getToken() supplies the bearer; on401() runs when the server rejects it.
  function client(getToken, on401) {
    return async function api(method, path, body) {
      var headers = {};
      var token = getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
      if (body) headers["Content-Type"] = "application/json";
      var res;
      try {
        res = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      } catch (e) {
        throw new Error("서버에 연결할 수 없습니다.");
      }
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 401 && token) on401();
      if (!res.ok) {
        var err = data.error || {};
        var text = err.message || ("오류 " + res.status);
        if (res.status === 429) text = "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
        var fe = err.details && err.details.fieldErrors;
        if (fe) for (var k in fe) text += "\n" + k + ": " + fe[k].join(", ");
        throw new Error(text);
      }
      return data;
    };
  }

  var timers = {};
  function msg(id, text, ok) {
    var el = $(id);
    if (!el) return;
    clearTimeout(timers[id]);
    el.textContent = text || "";
    el.className = ok ? "ok" : "err";
    if (ok && text && text.indexOf("\n") < 0) timers[id] = setTimeout(function () { el.textContent = ""; }, 4000);
  }

  function button(label, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = async function () {
      if (b.disabled) return;
      b.disabled = true;
      try { await fn(); } finally { b.disabled = false; }
    };
    return b;
  }

  // Prevent double submits and keep the form usable if a handler throws.
  function onSubmit(form, fn) {
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var btns = form.querySelectorAll("button");
      if (form.dataset.busy) return;
      form.dataset.busy = "1";
      btns.forEach(function (b) { b.disabled = true; });
      try { await fn(form); } finally {
        delete form.dataset.busy;
        btns.forEach(function (b) { b.disabled = false; });
      }
    });
  }

  function cell(tr, text, cls) {
    var td = tr.insertCell();
    if (text != null) td.textContent = String(text);
    if (cls) td.className = cls;
    return td;
  }

  function emptyRow(tbody, cols, text) {
    var td = tbody.insertRow().insertCell();
    td.colSpan = cols;
    td.className = "small";
    td.textContent = text;
  }

  // Short values (hostnames, IPs) never wrap; only long ones like TXT may.
  function valueClass(text) { return String(text || "").length > 64 ? "wrap" : null; }

  function show(id, visible) { $(id).classList.toggle("hidden", !visible); }

  // Compact local time: 2026-11-02 13:02
  function date(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d)) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // Replace a <select>'s options while keeping the current choice when possible.
  function fillSelect(sel, items) {
    var keep = sel.value;
    sel.textContent = "";
    items.forEach(function (it) { sel.add(new Option(it[1], it[0])); });
    if (items.some(function (it) { return String(it[0]) === keep; })) sel.value = keep;
  }

  return { $: $, blockMobile: blockMobile, store: store, read: read, client: client, msg: msg,
           button: button, onSubmit: onSubmit, cell: cell, emptyRow: emptyRow, show: show,
           date: date, fillSelect: fillSelect, valueClass: valueClass };
})();
