// toast.js — floating bottom-center notifications, per DESIGN.md's Toast /
// Error Messages spec. Distinct from #error-recovery (in index.html/app.js),
// which stays as its own richer, actionable card for the one specific
// stale-voice_id self-heal flow it was built for — toasts are for everything
// else (generate success/failure, other one-off status messages).

const AUTO_DISMISS_MS = 5000;
const EXIT_FALLBACK_MS = 250; // matches the toast-out CSS animation duration

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
}

/**
 * @param {{message: string, type?: "error"|"success"|"info"}} args
 * @returns {() => void} dismiss function, in case a caller wants to dismiss early
 */
export function showToast({ message, type = "info" }) {
  const root = ensureContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const text = document.createElement("p");
  text.className = "toast-text";
  text.textContent = message;

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "toast-dismiss";
  dismissBtn.type = "button";
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.textContent = "×";

  toast.appendChild(text);
  toast.appendChild(dismissBtn);
  root.appendChild(toast);

  let dismissTimer = null;
  let dismissed = false;

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(dismissTimer);
    toast.classList.add("toast-leaving");
    // The exit CSS animation only plays under prefers-reduced-motion: no-preference
    // — this timeout is what actually removes the node either way.
    setTimeout(() => toast.remove(), EXIT_FALLBACK_MS);
  }

  dismissBtn.addEventListener("click", dismiss);

  // Errors persist until the user dismisses them; success/info clear themselves.
  if (type !== "error") {
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  return dismiss;
}
