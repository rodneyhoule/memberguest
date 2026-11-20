// Light/dark switch: remembers the visitor's choice; otherwise follows the system setting live.
// The setting name is site-specific because other pages share the rodneyhoule.github.io origin.
(function () {
  var root = document.documentElement;
  var btn = document.querySelector(".theme-toggle");
  var mq = matchMedia("(prefers-color-scheme: dark)");
  function label() {
    btn.setAttribute("aria-checked", root.getAttribute("data-theme") === "dark" ? "true" : "false");
  }
  function saved() { try { return localStorage.getItem("mmg-theme"); } catch (e) { return null; } }
  btn.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("mmg-theme", next); } catch (e) { /* ignore */ }
    label();
  });
  mq.addEventListener("change", function (e) {
    if (!saved()) { root.setAttribute("data-theme", e.matches ? "dark" : "light"); label(); }
  });
  label();
})();
