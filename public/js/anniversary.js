// anniversary.js — Atomic Search 3rd anniversary (June 1st) banner + confetti.
// Shows once per browser session. Dismissed state is stored in sessionStorage
// so it never persists across visits (no cookies, no localStorage pollution).
// Confetti is pure-CSS/JS — no external library required.

(function () {
  "use strict";

  // ── Anniversary date check ──────────────────────────────────────────────
  // Show on June 1st of any year so the banner stays relevant for the day.
  function isAnniversaryDay() {
    var d = new Date();
    return d.getMonth() === 5 && d.getDate() === 1; // month is 0-indexed
  }

  // ── Easter egg: type "atomic" anywhere on the home page ─────────────────
  var easterBuffer = "";
  document.addEventListener("keydown", function (e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    easterBuffer = (easterBuffer + e.key).slice(-6).toLowerCase();
    if (easterBuffer === "atomic") {
      easterBuffer = "";
      launchConfetti(120);
      showToast("⚛️ You found the Atomic easter egg!");
    }
  });

  // ── Toast helper ─────────────────────────────────────────────────────────
  function showToast(msg) {
    var t = document.createElement("div");
    t.className = "atomic-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("atomic-toast-show"); }, 10);
    setTimeout(function () {
      t.classList.remove("atomic-toast-show");
      setTimeout(function () { t.remove(); }, 400);
    }, 3200);
  }

  // ── Confetti engine (pure JS canvas) ────────────────────────────────────
  var confettiCanvas = null;
  var confettiCtx = null;
  var confettiParticles = [];
  var confettiRaf = null;
  var COLORS = ["#ff4d4d","#ffd166","#06d6a0","#4a90e2","#c084fc","#ff71ce","#01cdfe","#ffb347"];

  function ensureCanvas() {
    if (confettiCanvas) return;
    confettiCanvas = document.createElement("canvas");
    confettiCanvas.id = "confetti-canvas";
    confettiCanvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;";
    document.body.appendChild(confettiCanvas);
    confettiCtx = confettiCanvas.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
  }

  function resizeCanvas() {
    if (!confettiCanvas) return;
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
  }

  function launchConfetti(count) {
    // Respect prefers-reduced-motion
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ensureCanvas();
    count = count || 80;
    for (var i = 0; i < count; i++) {
      confettiParticles.push({
        x: Math.random() * window.innerWidth,
        y: -10 - Math.random() * 40,
        r: 4 + Math.random() * 6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 0.2,
        shape: Math.random() > 0.5 ? "rect" : "circle",
        alpha: 1,
      });
    }
    if (!confettiRaf) animateConfetti();
  }

  function animateConfetti() {
    if (!confettiCtx) return;
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    var alive = [];
    for (var i = 0; i < confettiParticles.length; i++) {
      var p = confettiParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08; // gravity
      p.rot += p.rotV;
      p.alpha -= 0.008;
      if (p.alpha <= 0 || p.y > confettiCanvas.height + 20) continue;
      alive.push(p);
      confettiCtx.save();
      confettiCtx.globalAlpha = Math.max(0, p.alpha);
      confettiCtx.fillStyle = p.color;
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rot);
      if (p.shape === "rect") {
        confettiCtx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      } else {
        confettiCtx.beginPath();
        confettiCtx.arc(0, 0, p.r / 2, 0, Math.PI * 2);
        confettiCtx.fill();
      }
      confettiCtx.restore();
    }
    confettiParticles = alive;
    if (confettiParticles.length > 0) {
      confettiRaf = requestAnimationFrame(animateConfetti);
    } else {
      confettiRaf = null;
      if (confettiCanvas) {
        confettiCanvas.remove();
        confettiCanvas = null;
        confettiCtx = null;
      }
    }
  }

  // ── Index Health Badge ───────────────────────────────────────────────────
  function initHealthBadge() {
    var badge = document.getElementById("index-health-badge");
    var pagesEl = document.getElementById("ihb-pages");
    var updatedEl = document.getElementById("ihb-updated");
    if (!badge || !pagesEl || !updatedEl) return;

    fetch("/api/stats")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var pages = s.pages || 0;
        pagesEl.textContent = pages.toLocaleString() + " pages indexed";
        var sync = s.indexSync;
        if (sync && sync.lastPushAt) {
          var mins = Math.round((Date.now() - sync.lastPushAt) / 60000);
          updatedEl.textContent = mins < 2 ? "synced just now" : "synced " + mins + "m ago";
        } else {
          updatedEl.textContent = "index live";
        }
        badge.hidden = false;
      })
      .catch(function () { /* silently skip if stats unavailable */ });
  }

  // ── Banner logic ─────────────────────────────────────────────────────────
  function initBanner() {
    var banner = document.getElementById("anniversary-banner");
    var closeBtn = document.getElementById("anniversary-close");
    var dismissBtn = document.getElementById("anniversary-dismiss");
    if (!banner) return;

    var SESSION_KEY = "atomic:anniversary:3:dismissed";
    var dismissed = false;
    try { dismissed = !!sessionStorage.getItem(SESSION_KEY); } catch (e) { /* ignore */ }

    if (!isAnniversaryDay() || dismissed) return;

    // Show after a short delay so the page settles first
    setTimeout(function () {
      banner.hidden = false;
      banner.classList.add("anniversary-visible");
      launchConfetti(90);
    }, 800);

    function dismiss() {
      banner.classList.remove("anniversary-visible");
      banner.classList.add("anniversary-hiding");
      setTimeout(function () { banner.hidden = true; }, 400);
      try { sessionStorage.setItem(SESSION_KEY, "1"); } catch (e) { /* ignore */ }
    }

    if (closeBtn) closeBtn.addEventListener("click", dismiss);
    if (dismissBtn) {
      dismissBtn.addEventListener("click", function () {
        launchConfetti(60);
        dismiss();
      });
    }
    // Dismiss on backdrop click
    banner.addEventListener("click", function (e) {
      if (e.target === banner) dismiss();
    });
    // Dismiss on Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !banner.hidden) dismiss();
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initBanner();
      initHealthBadge();
    });
  } else {
    initBanner();
    initHealthBadge();
  }
})();
