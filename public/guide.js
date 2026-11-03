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
