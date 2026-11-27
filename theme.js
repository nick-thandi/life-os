// Light / dark / auto. Stored per device; "auto" follows the phone or TV setting.
(function () {
  const KEY = "lifeos.theme";
  const get = () => { try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; } };
  const apply = (t) => { if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t); };
  apply(get());
  document.addEventListener("DOMContentLoaded", () => {
    const host = document.querySelector(".top .status");
    if (!host || document.body.classList.contains("tv")) return;
    const b = document.createElement("button");
    b.className = "theme-toggle";
    const label = () => { const t = get(); b.textContent = t === "dark" ? "Dark" : t === "light" ? "Light" : "Auto"; b.setAttribute("aria-label", "Colour theme: " + b.textContent + ". Tap to change."); };
    b.onclick = () => { const n = { auto: "light", light: "dark", dark: "auto" }[get()]; try { localStorage.setItem(KEY, n); } catch (e) {} apply(n); label(); };
    label();
    host.appendChild(b);
  });
})();
