// Hearth & Key — site interactions (shared by every page)

// --- Contact form destination ------------------------------------------
// Set FORM_ENDPOINT to a form service URL (e.g. https://formspree.io/f/xxxxxx)
// to receive submissions by email. While empty, the form opens the visitor's
// email app with the details pre-filled, sent to CONTACT_EMAIL.
const FORM_ENDPOINT = "";
const CONTACT_EMAIL = "hello@hearthandkey.com";

// Footer year
const year = document.getElementById("year");
if (year) year.textContent = new Date().getFullYear();

// Sticky header shadow
const header = document.querySelector(".site-header");
const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 10);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Mobile navigation
const toggle = document.querySelector(".nav-toggle");
const nav = document.getElementById("site-nav");
const setNav = (open) => {
  nav.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
};
toggle.addEventListener("click", () => setNav(!nav.classList.contains("open")));
nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setNav(false)));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setNav(false); });

// Reveal-on-scroll
const revealTargets = document.querySelectorAll(
  ".section-head, .service-card, .svc-tile, .who-card, .case, .case-teaser, .steps li, .package, .faq details, .contact-copy, .contact-form"
);
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  revealTargets.forEach((el, i) => {
    // Elements linked to directly (e.g. services.html#seo-geo) show immediately
    if (location.hash && el.matches(location.hash)) { el.classList.add("visible"); return; }
    el.classList.add("reveal");
    el.style.transitionDelay = `${(i % 3) * 80}ms`;
    io.observe(el);
  });
}

// Contact form (only on contact.html)
const form = document.getElementById("contact-form");
if (form) {
  // "Ask about <package>" buttons link here with ?package=Name
  const pkg = new URLSearchParams(location.search).get("package");
  const msg = form.querySelector("#message");
  if (pkg && /^[\w ]{1,30}$/.test(pkg) && !msg.value.trim()) {
    msg.value = `I'm interested in the ${pkg} package.`;
  }

  const status = form.querySelector(".form-status");
  const showStatus = (text, ok) => {
    status.textContent = text;
    status.className = "form-status " + (ok ? "ok" : "err");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const required = ["name", "email", "business"].map((id) => form.querySelector("#" + id));
    let valid = true;
    required.forEach((input) => {
      const ok = input.value.trim() !== "" && (input.type !== "email" || /\S+@\S+\.\S+/.test(input.value));
      input.classList.toggle("invalid", !ok);
      if (!ok) valid = false;
    });
    if (!valid) {
      showStatus("Please fill in your name, a valid email and your business name.", false);
      required.find((i) => i.classList.contains("invalid")).focus();
      return;
    }

    const data = new FormData(form);
    const services = data.getAll("services").join(", ") || "Not specified";

    if (FORM_ENDPOINT) {
      try {
        const res = await fetch(FORM_ENDPOINT, {
          method: "POST",
          body: data,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error();
        form.reset();
        showStatus("Thank you! We'll be in touch within two working days.", true);
      } catch {
        showStatus(`Something went wrong. Please email us at ${CONTACT_EMAIL}.`, false);
      }
      return;
    }

    const body = [
      `Name: ${data.get("name")}`,
      `Email: ${data.get("email")}`,
      `Business: ${data.get("business")}`,
      `Type: ${data.get("type")}`,
      `Interested in: ${services}`,
      "",
      data.get("message") || "",
    ].join("\n");
    const subject = `Free audit request: ${data.get("business")}`;
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    showStatus("Opening your email app. Just press send!", true);
  });
}
