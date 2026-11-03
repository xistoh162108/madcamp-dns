// Guide page: fold the table of contents on narrow screens so the article
// starts right away, and fold it again after a section is picked.
(function () {
  var toc = document.querySelector("nav.toc details");
  if (!toc) return;
  var narrow = window.matchMedia("(max-width: 960px)");
  if (narrow.matches) toc.open = false;
  toc.addEventListener("click", function (e) {
    if (narrow.matches && e.target.closest("a")) toc.open = false;
  });
})();

// Copy buttons on every terminal / file block. A block with "$ " prompts
// copies only the commands (no prompts, no sample output); a file block
// (Dockerfile, docker-compose.yml, workflow) copies the whole file.
(function () {
  function textOf(pre) {
    var cmds = pre.querySelectorAll(".c");
    if (!cmds.length) return pre.innerText.replace(/\s+$/, "") + "\n";
    return Array.prototype.map.call(cmds, function (c) { return c.textContent; }).join("\n") + "\n";
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
    return Promise.resolve();
  }
  document.querySelectorAll(".term").forEach(function (term) {
    var bar = term.querySelector(".bar");
    var pre = term.querySelector("pre");
    if (!bar || !pre) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "복사";
    btn.addEventListener("click", function () {
      copy(textOf(pre)).then(function () {
        btn.textContent = "복사됨";
        setTimeout(function () { btn.textContent = "복사"; }, 1500);
      }, function () { btn.textContent = "복사 실패"; });
    });
    bar.appendChild(btn);
  });
})();
