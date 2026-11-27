/**
 * Browser half of dsh-mistral-pool.
 *
 * Registers one page in the settings dialog (the same seat "Outlook" and
 * "用量与费用" use). The page groups the pool's keys by face value — every
 * banner amount gets its own card with aggregated balances — and lists each
 * key with its estimated balance plus the actions the host half exposes:
 * enable, disable, delete key.
 *
 * Visual language deliberately matches the native settings sections: cards
 * with the 0.5px settings stroke and xl radius, the dsw alias tokens only
 * (so light/dark follow the host theme), 13px/22px body text, tabular
 * numerals, row actions revealed on hover/focus.
 *
 * Data comes from the host proxy on 127.0.0.1:28401, which returns masked keys
 * only — the full secret never reaches the browser.
 */
(function () {
  function createClientPlugin(require) {
    const React = require("react");
    const h = React.createElement;
    const PACKAGE = "dsh-mistral-pool";
    const SECTION_ID = "mistral-pool";
    const POOL_ORIGIN = "http://127.0.0.1:28401";
    const POLL_MS = 10000;
    const STYLE_ID = "dsh-mistral-pool/styles";

    const money = (value) =>
      value === null || value === undefined
        ? "—"
        : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const compact = (value) => {
      const n = Number(value || 0);
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    };
    const percent = (ratio) => `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    const fmtCap = (n) => {
      const num = Number(n);
      if (!Number.isFinite(num) || num <= 0) return "—";
      if (num >= 1_000_000) {
        const m = num === 1_048_576 ? 1 : num / 1_048_576;
        return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, "")}M`;
      }
      if (num >= 1_000) {
        const k = num % 1024 === 0 ? num / 1024 : Math.round(num / 1000);
        return `${k}K`;
      }
      return String(num);
    };

    /** Health color of a remaining-fraction bar, matching the quota panels. */
    const toneOf = (ratio) =>
      ratio < 0.15
        ? "var(--dsw-alias-state-error-primary)"
        : ratio < 0.35
          ? "var(--dsw-alias-state-warn-primary)"
          : "var(--dsw-alias-state-success-primary)";

    const STATUS = {
      active: { text: "已启用", tone: "on" },
      disabled: { text: "已停用", tone: "idle" },
      exhausted: { text: "额度耗尽", tone: "dead" },
    };
    const statusOf = (key) => STATUS[key.status] ?? STATUS.disabled;

    /**
     * Split the pool into face-value groups, banners first (300 → 30 → …),
     * unpriced keys (face 0) last, each group keeping the store's order so
     * the list mirrors the round-robin rotation.
     */
    function groupKeys(keys) {
      const groups = new Map();
      for (const key of keys ?? []) {
        const face = Number(key.faceUsd) || 0;
        const group = groups.get(face) ?? { face, keys: [] };
        group.keys.push(key);
        groups.set(face, group);
      }
      const sorted = [...groups.values()].sort((a, b) => b.face - a.face);
      for (const group of sorted) {
        group.keys.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
      }
      return sorted;
    }

    /** Aggregates for one face-value group (or the whole pool when keys=all). */
    function statsOf(keys) {
      const list = keys ?? [];
      const face = list.reduce((sum, k) => sum + (Number(k.faceUsd) || 0), 0);
      const used = list.reduce((sum, k) => sum + (Number(k.usedUsd) || 0), 0);
      const remaining = list.reduce(
        (sum, k) => sum + (k.remainingUsd === null ? Math.max(0, (Number(k.faceUsd) || 0) - (Number(k.usedUsd) || 0)) : Number(k.remainingUsd) || 0),
        0,
      );
      const usable = list.filter((k) => k.status === "active").length;
      return {
        face,
        used,
        remaining,
        usable,
        count: list.length,
        ratio: face > 0 ? Math.max(0, Math.min(1, remaining / face)) : null,
      };
    }

    const CSS = `
.mp-root{display:flex;flex-direction:column;gap:14px;min-width:0;padding:6px 0 4px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px}
.mp-root *,.mp-root *::before,.mp-root *::after{box-sizing:border-box}
.mp-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}
.mp-head-copy{min-width:0;flex:1 1 120px}
.mp-title{margin:0;font-size:16px;line-height:24px;font-weight:500}
.mp-head-side{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex:none}
.mp-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mp-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-success-primary);flex:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent)}
.mp-dot.off{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.mp-btn{appearance:none;font:inherit;font-size:12px;line-height:16px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);corner-shape:round;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.mp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.mp-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.mp-btn:disabled{opacity:.45;cursor:default}
.mp-btn.primary{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent);color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary));font-weight:500}
.mp-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent);color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary))}
.mp-card{border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);overflow:hidden}
.mp-account{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:12px 16px 14px}
.mp-stat{min-width:0}
.mp-stat+.mp-stat{border-inline-start:0.5px solid var(--dsw-alias-border-l2);padding-inline-start:20px;margin-inline-start:20px}
@media (max-width:420px){.mp-stat+.mp-stat{border-inline-start:none;padding-inline-start:0;margin-inline-start:0}}
.mp-stat span{display:block;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.mp-stat b{display:block;font-size:14px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.mp-total{display:flex;align-items:center;gap:10px;margin-top:12px}
.mp-total-meter{flex:1;height:4px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);overflow:hidden}
.mp-total-meter i{display:block;height:100%;border-radius:999px;corner-shape:round;background:var(--dsw-alias-state-success-primary);transition:width .3s ease}
.mp-total-pct{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.mp-group+.mp-group{margin-top:2px}
.mp-group-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:10px 16px;background:var(--dsw-alias-bg-module-platform);border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.mp-group-name{font-size:14px;line-height:20px;font-weight:600;white-space:nowrap}
.mp-chip{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-settings-card-fill);font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.mp-group-meta{display:flex;align-items:center;gap:8px;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.mp-group-meta b{font-weight:600;color:var(--dsw-alias-label-primary)}
.mp-group-bar{width:48px;height:4px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);overflow:hidden;flex:none}
.mp-group-bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary);transition:width .25s ease}
.mp-group-add{height:20px;padding:0 7px;font-size:11px;line-height:14px;border-radius:var(--dsw-radius-xs)}
.mp-rows{display:flex;flex-direction:column}
.mp-row{position:relative;display:flex;flex-direction:column;gap:2px;padding:9px 16px 10px;transition:background-color .15s ease}
.mp-row+.mp-row{border-top:0.5px solid var(--dsw-alias-border-l2)}
@media (hover:hover){.mp-row:not(.live):hover{background:var(--dsw-alias-interactive-bg-hover)}}
.mp-row.live{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,transparent)}
.mp-line{display:flex;align-items:center;gap:8px;min-width:0}
.mp-who{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.mp-name{min-width:0;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-row.dead .mp-name{color:var(--dsw-alias-label-secondary)}
.mp-memo{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mp-mask{flex:none;font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-secondary);max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-tag{flex:none;display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;corner-shape:round;font-size:12px;line-height:16px;font-weight:500;white-space:nowrap}
.mp-tag.live{color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);box-shadow:inset 0 0 0 0.5px color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent)}
.mp-tag.on{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);box-shadow:inset 0 0 0 0.5px color-mix(in srgb,var(--dsw-alias-state-success-primary) 28%,transparent)}
.mp-tag.idle{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.mp-tag.dead{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);box-shadow:inset 0 0 0 0.5px color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent)}
.mp-actions{flex:none;display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .15s ease}
.mp-row:hover .mp-actions,.mp-row:focus-within .mp-actions,.mp-actions.pinned{opacity:1}
@media (hover:none){.mp-actions{opacity:1}}
.mp-act{appearance:none;font:inherit;font-size:12px;line-height:16px;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);corner-shape:round;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:background-color .15s ease,color .15s ease}
.mp-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mp-act.danger{color:var(--dsw-alias-state-error-primary)}
.mp-act.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.mp-act.danger-solid{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);font-weight:500}
.mp-act:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.mp-act:disabled{opacity:.45;cursor:default}
.mp-meter{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mp-bar{flex:none;width:56px;height:4px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);overflow:hidden}
.mp-bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary);transition:width .25s ease}
.mp-row.dead .mp-bar i{background:var(--dsw-alias-state-idle-primary)}
.mp-row.dead .mp-meter b{color:var(--dsw-alias-label-secondary)}
.mp-meter b{font-weight:600;color:var(--dsw-alias-label-primary)}
.mp-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:var(--dsw-radius-lg);corner-shape:round;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
.mp-banner .mp-act{color:inherit}
.mp-banner .mp-act:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:inherit}
.mp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:120px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);corner-shape:round;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;padding:20px}
.mp-empty code{font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-primary)}
.mp-skeleton{height:96px;border-radius:var(--dsw-radius-xl);border:0.5px solid var(--dsw-alias-border-l2);background:linear-gradient(100deg,var(--dsw-alias-bg-skeleton) 40%,var(--dsw-alias-settings-card-fill) 50%,var(--dsw-alias-bg-skeleton) 60%);background-size:250% 100%;animation:mp-shimmer 1.6s ease infinite}
.mp-mode-card{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:10px 16px}
.mp-mode-copy{min-width:0;flex:1 1 200px}
.mp-mode-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mp-mode-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.mp-mode-badge{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:999px;corner-shape:round;font-size:11px;line-height:16px;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mp-mode-badge.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.mp-mode-badge.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.mp-seg{display:inline-flex;align-items:center;gap:2px;flex:none;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);border:0.5px solid var(--dsw-alias-border-l2)}
.mp-seg-btn{appearance:none;font:inherit;font-size:12px;line-height:16px;font-weight:500;height:26px;padding:0 11px;border:0;border-radius:calc(var(--dsw-radius-md) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.mp-seg-btn:hover:not(:disabled):not(.on){color:var(--dsw-alias-label-primary)}
.mp-seg-btn.on{background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.06),inset 0 0 0 0.5px var(--dsw-alias-border-l2)}
.mp-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.mp-seg-btn:disabled{opacity:.5;cursor:default}
.mp-chip.active-pool{color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);box-shadow:inset 0 0 0 0.5px color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent);font-weight:500}
.mp-form{display:flex;flex-direction:column;gap:10px;padding:12px 16px 14px}
.mp-form-inline{border-bottom:0.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 3%,transparent)}
.mp-form-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mp-form-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mp-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.mp-field-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mp-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:460px){.mp-form-grid{grid-template-columns:1fr}}
.mp-input-wrap{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);transition:border-color .15s ease,background-color .15s ease}
.mp-input-wrap:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:var(--dsw-alias-settings-card-fill)}
.mp-input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}
.mp-input.mono{font-family:var(--ds-font-family-code)}
.mp-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.mp-form-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.mp-form-foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding-top:2px}
.mp-form-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.mp-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.mp-check input{margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.mp-form-err{padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.mp-form-ok{padding:6px 10px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.mp-sched-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:0 6px;border:0.5px solid transparent;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-variant-numeric:tabular-nums;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.mp-sched-btn:hover:not(:disabled),.mp-sched-btn.on{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.mp-edit-form{display:flex;flex-direction:column;gap:10px;margin-top:8px;padding:10px 12px 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}
.mp-edit-form .mp-input-wrap{background:var(--dsw-alias-settings-card-fill)}
.mp-edit-form .mp-seg{background:var(--dsw-alias-settings-card-fill)}
.mp-model-id{font-family:var(--ds-font-family-code);font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.mp-model-sub{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-discover-list{display:flex;flex-direction:column;max-height:180px;overflow:auto;border-top:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}
.mp-discover-row{display:flex;align-items:center;gap:8px;padding:6px 16px;font-size:12px}
.mp-discover-row+.mp-discover-row{border-top:0.5px solid var(--dsw-alias-border-l2)}
@keyframes mp-shimmer{0%{background-position:120% 0}100%{background-position:-20% 0}}
@media (prefers-reduced-motion:reduce){.mp-skeleton{animation:none}.mp-bar i,.mp-group-bar i,.mp-total-meter i{transition:none}.mp-actions,.mp-seg-btn,.mp-input-wrap{transition:none}}
`;

    function ensureStyles() {
      if (typeof document === "undefined" || !document.head) return () => {};
      if (document.getElementById(STYLE_ID)) return () => {};
      const node = document.createElement("style");
      node.id = STYLE_ID;
      node.textContent = CSS;
      document.head.appendChild(node);
      return () => {
        node.remove();
      };
    }

    async function call(path, body) {
      const res = await fetch(`${POOL_ORIGIN}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "x-dsh-pool": "1", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      return payload;
    }

    function usePool() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const load = React.useCallback(async (quiet) => {
        try {
          setState(await call("/__pool/state"));
          setError("");
        } catch (cause) {
          if (!quiet) setError(cause?.message ?? String(cause));
        }
      }, []);
      React.useEffect(() => {
        load(true);
        const timer = setInterval(() => load(true), POLL_MS);
        return () => clearInterval(timer);
      }, [load]);
      const act = React.useCallback(async (action, id, extra) => {
        setBusy(`${action}:${id ?? ""}`);
        try {
          setState(await call("/__pool/action", { action, id, ...extra }));
          setError("");
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        } finally {
          setBusy("");
        }
      }, []);
      const addKey = React.useCallback(async (payload) => {
        setBusy("add-key:");
        try {
          const next = await call("/__pool/action", { action: "add-key", ...payload });
          setState(next);
          setError("");
          return { ok: true, state: next };
        } catch (cause) {
          return { ok: false, error: cause?.message ?? String(cause) };
        } finally {
          setBusy("");
        }
      }, []);
      const updateKey = React.useCallback(async (id, payload) => {
        setBusy(`update-key:${id ?? ""}`);
        try {
          const next = await call("/__pool/action", { action: "update-key", id, ...payload });
          setState(next);
          setError("");
          return { ok: true, state: next };
        } catch (cause) {
          return { ok: false, error: cause?.message ?? String(cause) };
        } finally {
          setBusy("");
        }
      }, []);
      return { state, error, busy, act, addKey, updateKey, reload: () => load(false) };
    }

    function maskPreviewOf(raw) {
      const s = String(raw || "").trim();
      if (s.length <= 8) return "****";
      return `${s.slice(0, 6)}…${s.slice(-4)}`;
    }

    function AddKeyForm({ initialFace, initialKind, embedded, busy, onSubmit, onCancel }) {
      const initFace = Number.isFinite(Number(initialFace)) ? Number(initialFace) : 300;
      const initPreset = initFace === 300 ? "300" : initFace === 30 ? "30" : "custom";
      const [apiKey, setApiKey] = React.useState("");
      const [showKey, setShowKey] = React.useState(false);
      const [preset, setPreset] = React.useState(initPreset);
      const [faceUsd, setFaceUsd] = React.useState(String(initFace));
      const [kind, setKind] = React.useState(initialKind || (initFace >= 100 ? "vibe" : "studio"));
      const [account, setAccount] = React.useState("");
      const [memo, setMemo] = React.useState("");
      const [priority, setPriority] = React.useState("0");
      const [weight, setWeight] = React.useState("1");
      const [setCurrent, setSetCurrent] = React.useState(false);
      const [formError, setFormError] = React.useState("");
      const [feedback, setFeedback] = React.useState("");

      const saving = busy === "add-key:";

      const selectPreset = (nextPreset) => {
        setPreset(nextPreset);
        if (nextPreset === "300") {
          setFaceUsd("300");
          setKind("vibe");
        } else if (nextPreset === "30") {
          setFaceUsd("30");
          setKind("studio");
        }
      };

      const submitForm = async (keepOpen) => {
        const trimmed = apiKey.trim();
        if (!trimmed) {
          setFormError("请输入 Mistral API Key");
          return;
        }
        if (/\s/.test(trimmed)) {
          setFormError("API Key 不能包含空白字符");
          return;
        }
        const parsedFace = preset === "300" ? 300 : preset === "30" ? 30 : Number(String(faceUsd).trim());
        if (!Number.isFinite(parsedFace) || parsedFace < 0) {
          setFormError("面值必须为非负数字");
          return;
        }
        const parsedPriority = String(priority).trim() === "" ? 0 : Number(String(priority).trim());
        if (!Number.isInteger(parsedPriority) || parsedPriority < -9999 || parsedPriority > 9999) {
          setFormError("优先级必须为整数");
          return;
        }
        const parsedWeight = String(weight).trim() === "" ? 1 : Number(String(weight).trim());
        if (!Number.isFinite(parsedWeight) || parsedWeight <= 0 || parsedWeight > 10000) {
          setFormError("权重必须为大于 0 的数字");
          return;
        }
        const resolvedKind = preset === "300" ? "vibe" : preset === "30" ? "studio" : kind;
        setFormError("");
        setFeedback("");
        const result = await onSubmit({
          key: trimmed,
          faceUsd: parsedFace,
          kind: resolvedKind,
          account: account.trim(),
          memo: memo.trim(),
          priority: parsedPriority,
          weight: parsedWeight,
          setCurrent,
        });
        if (!result?.ok) {
          setFormError(result?.error || "添加失败");
          return;
        }
        if (keepOpen) {
          setApiKey("");
          setAccount("");
          setMemo("");
          setPriority("0");
          setWeight("1");
          setSetCurrent(false);
          setFeedback(`已添加 ${maskPreviewOf(trimmed)}（$${parsedFace}）`);
        } else {
          onCancel();
        }
      };

      const title = embedded ? `新增 $${initFace} 额度 Key` : "新增 Key";

      return h(
        "form",
        {
          className: embedded ? "mp-form mp-form-inline" : "mp-form",
          onSubmit: (e) => {
            e.preventDefault();
            submitForm(false);
          },
          onKeyDown: (e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          },
        },
        h(
          "div",
          { className: "mp-form-head" },
          h("span", { className: "mp-form-title" }, title),
          h(
            "button",
            {
              type: "button",
              className: "mp-act",
              onClick: onCancel,
              disabled: saving,
              "aria-label": "关闭新增表单",
            },
            "×",
          ),
        ),
        h(
          "div",
          { className: "mp-field" },
          h("label", { className: "mp-field-label" }, "API Key"),
          h(
            "div",
            { className: "mp-input-wrap" },
            h("input", {
              type: showKey ? "text" : "password",
              className: "mp-input mono",
              placeholder: "粘贴 Mistral API Key（如 mstrl_...）",
              value: apiKey,
              autoFocus: true,
              spellCheck: false,
              autoComplete: "off",
              disabled: saving,
              onChange: (e) => setApiKey(e.target.value),
            }),
            h(
              "button",
              {
                type: "button",
                className: "mp-act",
                style: { height: "22px", padding: "0 6px" },
                onClick: () => setShowKey(!showKey),
              },
              showKey ? "隐藏" : "显示",
            ),
          ),
        ),
        h(
          "div",
          { className: "mp-field" },
          h("span", { className: "mp-field-label" }, "额度档位"),
          h(
            "div",
            { className: "mp-form-row" },
            h(
              "div",
              { className: "mp-seg", role: "group", "aria-label": "额度档位" },
              [
                ["300", "$300 · Vibe (ACP)"],
                ["30", "$30 · Studio (直连)"],
                ["custom", "自定义"],
              ].map(([id, text]) =>
                h(
                  "button",
                  {
                    key: id,
                    type: "button",
                    className: `mp-seg-btn${preset === id ? " on" : ""}`,
                    "aria-pressed": preset === id,
                    disabled: saving,
                    onClick: () => selectPreset(id),
                  },
                  text,
                ),
              ),
            ),
            preset === "custom"
              ? h(
                  "div",
                  { className: "mp-form-row" },
                  h(
                    "div",
                    { className: "mp-input-wrap", style: { width: "104px" } },
                    h("input", {
                      type: "number",
                      min: "0",
                      step: "any",
                      className: "mp-input",
                      placeholder: "面值 USD",
                      value: faceUsd,
                      disabled: saving,
                      onChange: (e) => {
                        const val = e.target.value;
                        setFaceUsd(val);
                        const num = Number(val);
                        if (Number.isFinite(num)) setKind(num >= 100 ? "vibe" : "studio");
                      },
                    }),
                  ),
                  h(
                    "div",
                    { className: "mp-seg", role: "group", "aria-label": "池类型" },
                    [
                      ["vibe", "Vibe (ACP)"],
                      ["studio", "Studio (直连)"],
                    ].map(([kId, kText]) =>
                      h(
                        "button",
                        {
                          key: kId,
                          type: "button",
                          className: `mp-seg-btn${kind === kId ? " on" : ""}`,
                          "aria-pressed": kind === kId,
                          disabled: saving,
                          onClick: () => setKind(kId),
                        },
                        kText,
                      ),
                    ),
                  ),
                )
              : null,
          ),
        ),
        h(
          "div",
          { className: "mp-form-grid" },
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "账号（选填）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "text",
                className: "mp-input",
                placeholder: "例如 name@gmail.com",
                value: account,
                disabled: saving,
                onChange: (e) => setAccount(e.target.value),
              }),
            ),
          ),
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "备注（选填）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "text",
                className: "mp-input",
                placeholder: "例如 Pro",
                value: memo,
                disabled: saving,
                onChange: (e) => setMemo(e.target.value),
              }),
            ),
          ),
        ),
        h(
          "div",
          { className: "mp-form-grid" },
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "优先级（越大越优先）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "number",
                step: "1",
                className: "mp-input",
                placeholder: "默认 0",
                value: priority,
                disabled: saving,
                onChange: (e) => setPriority(e.target.value),
              }),
            ),
          ),
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "权重（同优先级分流比例）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "number",
                min: "0.1",
                step: "any",
                className: "mp-input",
                placeholder: "默认 1",
                value: weight,
                disabled: saving,
                onChange: (e) => setWeight(e.target.value),
              }),
            ),
          ),
        ),
        formError ? h("div", { className: "mp-form-err" }, formError) : null,
        feedback ? h("div", { className: "mp-form-ok" }, feedback) : null,
        h(
          "div",
          { className: "mp-form-foot" },
          h(
            "label",
            { className: "mp-check" },
            h("input", {
              type: "checkbox",
              checked: setCurrent,
              disabled: saving,
              onChange: (e) => setSetCurrent(e.target.checked),
            }),
            "立即设为当前",
          ),
          h(
            "div",
            { className: "mp-form-actions" },
            h("button", { type: "button", className: "mp-btn", disabled: saving, onClick: onCancel }, "取消"),
            h(
              "button",
              {
                type: "button",
                className: "mp-btn",
                disabled: saving,
                onClick: () => submitForm(true),
              },
              saving ? "保存中…" : "保存并继续",
            ),
            h(
              "button",
              { type: "submit", className: "mp-btn primary", disabled: saving },
              saving ? "添加中…" : "确认添加",
            ),
          ),
        ),
      );
    }

    /** Inline meter element; the fill takes the health tone unless muted. */
    function Bar({ ratio, className, muted }) {
      const known = ratio !== null && ratio !== undefined;
      const tone = known && !muted ? toneOf(ratio) : undefined;
      return h(
        "div",
        { className },
        h("i", {
          style: {
            width: known ? `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%` : "0%",
            background: tone,
          },
        }),
      );
    }

    const DEC_1_2026_MS = Date.parse("2026-12-01T00:00:00Z");

    function isStudioScopedDirect(state) {
      const scope = state?.directKeyScope || "auto";
      return scope === "studio" || (scope === "auto" && Date.now() >= DEC_1_2026_MS);
    }

    function ModeCard({ state, busy, act }) {
      const mode = state?.mode === "direct" ? "direct" : "acp";
      const switching = busy.startsWith("set-mode:");
      const acp = state?.acp || null;
      const acpBadge = mode === "acp"
        ? acp && acp.available === false
          ? { cls: "warn", text: "未检测到 vibe-acp" }
          : { cls: "ok", text: acp ? `vibe-acp 就绪 · ${acp.liveSessions || 0} 会话` : "vibe-acp 就绪" }
        : { cls: "", text: `127.0.0.1:${state?.port ?? 28401}/v1` };
      return h(
        "div",
        { className: "mp-card mp-mode-card" },
        h(
          "div",
          { className: "mp-mode-copy" },
          h(
            "div",
            { className: "mp-mode-title-row" },
            h("span", { className: "mp-mode-title" }, "调用路由"),
            h("span", { className: `mp-mode-badge ${acpBadge.cls}`.trim() }, acpBadge.text),
          ),
        ),
        h(
          "div",
          { className: "mp-seg", role: "group", "aria-label": "Mistral 调用路由" },
          h(
            "button",
            {
              type: "button",
              className: `mp-seg-btn${mode === "acp" ? " on" : ""}`,
              "aria-pressed": mode === "acp",
              disabled: switching,
              onClick: () => {
                if (mode !== "acp") act("set-mode", undefined, { mode: "acp" });
              },
            },
            "ACP (vibe-acp)",
          ),
          h(
            "button",
            {
              type: "button",
              className: `mp-seg-btn${mode === "direct" ? " on" : ""}`,
              "aria-pressed": mode === "direct",
              disabled: switching,
              onClick: () => {
                if (mode !== "direct") act("set-mode", undefined, { mode: "direct" });
              },
            },
            "直连 (HTTP API)",
          ),
        ),
      );
    }

    function SummaryCard({ state }) {
      const stats = statsOf(state?.keys ?? []);
      const items = [
        ["面值合计", money(stats.face)],
        ["已用（估）", money(stats.used)],
        ["剩余（估）", money(stats.remaining)],
        ["可用", `${stats.usable} / ${stats.count}`],
      ];
      const ratio = stats.ratio;
      return h(
        "div",
        { className: "mp-card mp-account" },
        items.map(([label, value]) =>
          h("div", { className: "mp-stat", key: label }, h("span", null, label), h("b", null, value)),
        ),
        h(
          "div",
          { className: "mp-total" },
          h(Bar, {
            ratio,
            className: "mp-total-meter",
          }),
          h(
            "span",
            { className: "mp-total-pct" },
            ratio === null ? "未设面值" : `${percent(ratio)} 剩余`,
          ),
        ),
      );
    }

    function EditKeyForm({ item, busy, onSave, onCancel }) {
      const initFace = Number(item.faceUsd ?? 0);
      const initPreset = initFace === 300 ? "300" : initFace === 30 ? "30" : "custom";
      const [account, setAccount] = React.useState(String(item.account ?? ""));
      const [memo, setMemo] = React.useState(String(item.memo ?? ""));
      const [preset, setPreset] = React.useState(initPreset);
      const [faceUsd, setFaceUsd] = React.useState(String(initFace));
      const [kind, setKind] = React.useState(item.kind === "studio" ? "studio" : "vibe");
      const [priority, setPriority] = React.useState(String(item.priority ?? 0));
      const [weight, setWeight] = React.useState(String(item.weight ?? 1));
      const [newKey, setNewKey] = React.useState("");
      const [showKey, setShowKey] = React.useState(false);
      const [formError, setFormError] = React.useState("");
      const saving = busy === `update-key:${item.id}`;

      const selectPreset = (nextPreset) => {
        setPreset(nextPreset);
        if (nextPreset === "300") {
          setFaceUsd("300");
          setKind("vibe");
        } else if (nextPreset === "30") {
          setFaceUsd("30");
          setKind("studio");
        }
      };

      const handleSubmit = async (e) => {
        e.preventDefault();
        const trimmedKey = newKey.trim();
        if (trimmedKey && /\s/.test(trimmedKey)) {
          setFormError("API Key 不能包含空白字符");
          return;
        }
        const parsedFace = preset === "300" ? 300 : preset === "30" ? 30 : Number(String(faceUsd).trim());
        if (!Number.isFinite(parsedFace) || parsedFace < 0) {
          setFormError("面值必须为非负数字");
          return;
        }
        const parsedPriority = String(priority).trim() === "" ? 0 : Number(String(priority).trim());
        if (!Number.isInteger(parsedPriority) || parsedPriority < -9999 || parsedPriority > 9999) {
          setFormError("优先级必须为整数");
          return;
        }
        const parsedWeight = String(weight).trim() === "" ? 1 : Number(String(weight).trim());
        if (!Number.isFinite(parsedWeight) || parsedWeight <= 0 || parsedWeight > 10000) {
          setFormError("权重必须为大于 0 的数字");
          return;
        }
        const resolvedKind = preset === "300" ? "vibe" : preset === "30" ? "studio" : kind;
        setFormError("");
        const patch = {
          account: account.trim(),
          memo: memo.trim(),
          faceUsd: parsedFace,
          kind: resolvedKind,
          priority: parsedPriority,
          weight: parsedWeight,
        };
        if (trimmedKey) patch.key = trimmedKey;
        const result = await onSave(patch);
        if (!result?.ok) {
          setFormError(result?.error || "保存失败");
          return;
        }
        onCancel();
      };

      return h(
        "form",
        {
          className: "mp-edit-form",
          onSubmit: handleSubmit,
          onKeyDown: (e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          },
        },
        h(
          "div",
          { className: "mp-form-head" },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
            h("span", { className: "mp-form-title" }, "编辑 Key"),
            h("span", { className: "mp-mask" }, item.masked),
          ),
          h(
            "button",
            {
              type: "button",
              className: "mp-act",
              onClick: onCancel,
              disabled: saving,
              "aria-label": "关闭编辑表单",
            },
            "×",
          ),
        ),
        h(
          "div",
          { className: "mp-form-grid" },
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "账号（选填）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "text",
                className: "mp-input",
                placeholder: "例如 name@gmail.com",
                value: account,
                disabled: saving,
                onChange: (e) => setAccount(e.target.value),
              }),
            ),
          ),
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "备注（选填）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "text",
                className: "mp-input",
                placeholder: "例如 Pro",
                value: memo,
                disabled: saving,
                onChange: (e) => setMemo(e.target.value),
              }),
            ),
          ),
        ),
        h(
          "div",
          { className: "mp-form-grid" },
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "优先级（越大越优先）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "number",
                step: "1",
                className: "mp-input",
                value: priority,
                disabled: saving,
                onChange: (e) => setPriority(e.target.value),
              }),
            ),
          ),
          h(
            "div",
            { className: "mp-field" },
            h("label", { className: "mp-field-label" }, "权重（同优先级分流比例）"),
            h(
              "div",
              { className: "mp-input-wrap" },
              h("input", {
                type: "number",
                min: "0.1",
                step: "any",
                className: "mp-input",
                value: weight,
                disabled: saving,
                onChange: (e) => setWeight(e.target.value),
              }),
            ),
          ),
        ),
        h(
          "div",
          { className: "mp-field" },
          h("span", { className: "mp-field-label" }, "额度档位"),
          h(
            "div",
            { className: "mp-form-row" },
            h(
              "div",
              { className: "mp-seg", role: "group", "aria-label": "额度档位" },
              [
                ["300", "$300 · Vibe (ACP)"],
                ["30", "$30 · Studio (直连)"],
                ["custom", "自定义"],
              ].map(([id, text]) =>
                h(
                  "button",
                  {
                    key: id,
                    type: "button",
                    className: `mp-seg-btn${preset === id ? " on" : ""}`,
                    "aria-pressed": preset === id,
                    disabled: saving,
                    onClick: () => selectPreset(id),
                  },
                  text,
                ),
              ),
            ),
            preset === "custom"
              ? h(
                  "div",
                  { className: "mp-form-row" },
                  h(
                    "div",
                    { className: "mp-input-wrap", style: { width: "104px" } },
                    h("input", {
                      type: "number",
                      min: "0",
                      step: "any",
                      className: "mp-input",
                      placeholder: "面值 USD",
                      value: faceUsd,
                      disabled: saving,
                      onChange: (e) => {
                        const val = e.target.value;
                        setFaceUsd(val);
                        const num = Number(val);
                        if (Number.isFinite(num)) setKind(num >= 100 ? "vibe" : "studio");
                      },
                    }),
                  ),
                  h(
                    "div",
                    { className: "mp-seg", role: "group", "aria-label": "池类型" },
                    [
                      ["vibe", "Vibe (ACP)"],
                      ["studio", "Studio (直连)"],
                    ].map(([kId, kText]) =>
                      h(
                        "button",
                        {
                          key: kId,
                          type: "button",
                          className: `mp-seg-btn${kind === kId ? " on" : ""}`,
                          "aria-pressed": kind === kId,
                          disabled: saving,
                          onClick: () => setKind(kId),
                        },
                        kText,
                      ),
                    ),
                  ),
                )
              : null,
          ),
        ),
        h(
          "div",
          { className: "mp-field" },
          h("label", { className: "mp-field-label" }, "替换 API Key（选填，留空保持不变）"),
          h(
            "div",
            { className: "mp-input-wrap" },
            h("input", {
              type: showKey ? "text" : "password",
              className: "mp-input mono",
              placeholder: "如需更换密钥请粘贴新 Key",
              value: newKey,
              spellCheck: false,
              autoComplete: "off",
              disabled: saving,
              onChange: (e) => setNewKey(e.target.value),
            }),
            h(
              "button",
              {
                type: "button",
                className: "mp-act",
                style: { height: "22px", padding: "0 6px" },
                onClick: () => setShowKey(!showKey),
              },
              showKey ? "隐藏" : "显示",
            ),
          ),
        ),
        formError ? h("div", { className: "mp-form-err" }, formError) : null,
        h(
          "div",
          { className: "mp-form-foot" },
          h(
            "div",
            { className: "mp-form-actions" },
            h("button", { type: "button", className: "mp-btn", disabled: saving, onClick: onCancel }, "取消"),
            h(
              "button",
              { type: "submit", className: "mp-btn primary", disabled: saving },
              saving ? "保存中…" : "保存修改",
            ),
          ),
        ),
      );
    }

    function KeyRow({ item, busy, act, confirmingDelete, onRequestDelete, editingKey, onToggleEdit, onUpdateKey }) {
      const [setting, id] = busy.split(":");
      const working = id === item.id;
      const dead = item.status !== "active";
      const cls = ["mp-row", item.current ? "live" : "", dead ? "dead" : ""].filter(Boolean).join(" ");
      const total = Number(item.faceUsd) || 0;
      const left = item.remainingUsd === null ? null : Number(item.remainingUsd) || 0;
      const ratio = total > 0 && left !== null ? Math.max(0, Math.min(1, left / total)) : null;
      const status = statusOf(item);
      const pending = (name) => working && setting === name;
      return h(
        "div",
        { className: cls },
        h(
          "div",
          { className: "mp-line" },
          h(
            "div",
            { className: "mp-who" },
            h("span", { className: "mp-name", title: item.account || "" }, item.account || "未命名账号"),
            item.memo ? h("span", { className: "mp-memo" }, item.memo) : null,
            item.balanceSource === "official"
              ? h(
                  "span",
                  {
                    className: "mp-memo",
                    title: `余额来自官方 billing 接口${item.official?.plan ? `（${item.official.plan}）` : ""}`,
                  },
                  "官方",
                )
              : null,
            h("span", { className: "mp-mask", title: "key 只在宿主侧解密，浏览器里始终是掩码" }, item.masked),
          ),
          h(
            "span",
            {
              className: `mp-tag ${status.tone}`,
              title: dead && item.lastError ? `上次错误：${item.lastError}` : undefined,
            },
            status.text,
          ),
          h(
            "div",
            { className: confirmingDelete || editingKey ? "mp-actions pinned" : "mp-actions" },
            confirmingDelete
              ? [
                  h(
                    "button",
                    {
                      key: "confirm",
                      type: "button",
                      className: "mp-act danger-solid",
                      disabled: working,
                      onClick: async () => {
                        await act("delete-key", item.id);
                        onRequestDelete(null);
                      },
                    },
                    pending("delete-key") ? "删除中…" : "确认删除",
                  ),
                  h(
                    "button",
                    {
                      key: "cancel",
                      type: "button",
                      className: "mp-act",
                      disabled: working,
                      onClick: () => onRequestDelete(null),
                    },
                    "取消",
                  ),
                ]
              : [
                  h(
                    "button",
                    {
                      key: "edit",
                      type: "button",
                      className: "mp-act",
                      disabled: working,
                      title: "编辑账号、备注、优先级、权重与额度",
                      onClick: () => onToggleEdit(editingKey ? null : item.id),
                    },
                    editingKey ? "收起" : "编辑",
                  ),
                  item.status === "active"
                    ? h(
                        "button",
                        {
                          key: "disable",
                          type: "button",
                          className: "mp-act",
                          disabled: working,
                          onClick: () => act("disable", item.id),
                        },
                        pending("disable") ? "停用中…" : "停用",
                      )
                    : h(
                        "button",
                        {
                          key: "enable",
                          type: "button",
                          className: "mp-act",
                          disabled: working,
                          onClick: () => act("enable", item.id),
                        },
                        pending("enable") ? "启用中…" : "启用",
                      ),
                  h(
                    "button",
                    {
                      key: "delete",
                      type: "button",
                      className: "mp-act danger",
                      disabled: working,
                      title: "从 Key 池中删除这把 key",
                      onClick: () => onRequestDelete(item.id),
                    },
                    "删除",
                  ),
                ],
          ),
        ),
        h(
          "div",
          { className: "mp-meter" },
          h(Bar, { ratio, className: "mp-bar", muted: dead }),
          h("span", null, "剩余 ", h("b", null, left === null ? "未定价" : money(left))),
          h("span", { className: "mp-sep" }, "·"),
          h("span", null, left === null ? money(item.usedUsd) : `${money(item.usedUsd)} / ${money(total)}`),
          h("span", { className: "mp-sep" }, "·"),
          h("span", null, `${item.requests} 次`),
          h("span", { className: "mp-sep" }, "·"),
          h("span", null, `${compact(item.tokens?.input ?? 0)} tok`),
          item.sessions > 0 ? h("span", { className: "mp-sep" }, "·") : null,
          item.sessions > 0
            ? h("span", { title: "固定在这把 key 上的会话数（会话粘滞）" }, `${item.sessions} 会话`)
            : null,
          h("span", { className: "mp-sep" }, "·"),
          h(
            "button",
            {
              type: "button",
              className: `mp-sched-btn${editingKey ? " on" : ""}`,
              title: "点击编辑优先级与权重（优先级越大越优先，同优先级按权重比例分配新会话）",
              onClick: () => onToggleEdit(editingKey ? null : item.id),
            },
            `优先级 ${item.priority ?? 0} · 权重 ${item.weight ?? 1}`,
          ),
        ),
        editingKey
          ? h(EditKeyForm, {
              key: `edit:${item.id}:${item.faceUsd}:${item.priority ?? 0}:${item.weight ?? 1}`,
              item,
              busy,
              onSave: (patch) => onUpdateKey(item.id, patch),
              onCancel: () => onToggleEdit(null),
            })
          : null,
      );
    }

    function GroupCard({ face, keys, busy, act, state, confirmDeleteId, onRequestDelete, editKeyId, onToggleEdit, onUpdateKey }) {
      const stats = statsOf(keys);
      const named = face > 0;
      const mode = state?.mode === "direct" ? "direct" : "acp";
      const studioScoped = isStudioScopedDirect(state);
      const isVibeGroup = face >= 100;
      const isStudioGroup = face > 0 && face < 100;
      const groupTag = !named
        ? null
        : mode === "acp"
          ? (isVibeGroup ? { text: "当前路由池", active: true } : { text: "直连池", active: false })
          : studioScoped
            ? (isStudioGroup ? { text: "当前路由池", active: true } : { text: "ACP 专用", active: false })
            : { text: "当前路由池", active: true };
      const syncing = busy === `sync-quota:${face}`;
      return h(
        "section",
        { className: "mp-card mp-group", "aria-label": named ? `$${face} 额度组` : "未设面值组" },
        h(
          "div",
          { className: "mp-group-head" },
          h("span", { className: "mp-group-name" }, named ? `$${face} 额度` : "未设面值"),
          h("span", { className: "mp-chip" }, `${stats.usable}/${stats.count} 可用`),
          groupTag
            ? h("span", { className: groupTag.active ? "mp-chip active-pool" : "mp-chip" }, groupTag.text)
            : null,
          h(
            "div",
            { className: "mp-group-meta" },
            h(Bar, { ratio: stats.ratio, className: "mp-group-bar" }),
            h(
              "span",
              null,
              named ? ["剩余 ", h("b", null, money(stats.remaining)), ` / ${money(stats.face)}`] : "按 token 记账",
            ),
            h(
              "button",
              {
                type: "button",
                className: "mp-btn mp-group-add",
                disabled: Boolean(busy),
                title: named ? `刷新同步 $${face} 额度与状态` : "刷新同步未设面值组额度与状态",
                onClick: () => act("sync-quota", String(face), { faceUsd: face }),
              },
              syncing ? "同步中…" : "刷新",
            ),
          ),
        ),
        h(
          "div",
          { className: "mp-rows" },
          keys.map((item) =>
            h(KeyRow, {
              key: item.id,
              item,
              busy,
              act,
              confirmingDelete: confirmDeleteId === item.id,
              onRequestDelete,
              editingKey: editKeyId === item.id,
              onToggleEdit,
              onUpdateKey,
            }),
          ),
        ),
      );
    }

    function ModelCatalogCard({ state, busy, act, callPool, compact }) {
      const [adding, setAdding] = React.useState(false);
      const [modelId, setModelId] = React.useState("");
      const [modelName, setModelName] = React.useState("");
      const [err, setErr] = React.useState("");
      const [fetching, setFetching] = React.useState(false);
      const [discovered, setDiscovered] = React.useState(null);
      const [fetchErr, setFetchErr] = React.useState("");
      const [editingModelId, setEditingModelId] = React.useState(null);
      const [editName, setEditName] = React.useState("");
      const [editCtx, setEditCtx] = React.useState("");
      const [editMax, setEditMax] = React.useState("");
      const [editText, setEditText] = React.useState(true);
      const [editImage, setEditImage] = React.useState(true);
      const [editErr, setEditErr] = React.useState("");

      const models = Array.isArray(state?.models) ? state.models : [];
      const existingIds = new Set(models.map((m) => m.id));

      const openEditModel = (m) => {
        if (editingModelId === m.id) {
          setEditingModelId(null);
          setEditErr("");
          return;
        }
        setEditingModelId(m.id);
        setEditName(m.name && m.name !== m.id ? m.name : "");
        setEditCtx(String(m.contextWindow ?? 1_048_576));
        setEditMax(String(m.maxTokens ?? 131_072));
        const input = Array.isArray(m.input) ? m.input : ["text", "image"];
        setEditText(input.includes("text"));
        setEditImage(input.includes("image"));
        setEditErr("");
      };

      const submitEditModel = async (e, id) => {
        e.preventDefault();
        const cw = Number(String(editCtx).trim());
        const mt = Number(String(editMax).trim());
        if (!Number.isInteger(cw) || cw <= 0) {
          setEditErr("上下文窗口必须为正整数");
          return;
        }
        if (!Number.isInteger(mt) || mt <= 0) {
          setEditErr("最大输出 token 数必须为正整数");
          return;
        }
        const input = [editText ? "text" : null, editImage ? "image" : null].filter(Boolean);
        if (input.length === 0) {
          setEditErr("至少选择一种输入类型");
          return;
        }
        setEditErr("");
        await act("update-model", id, {
          modelId: id,
          name: editName.trim(),
          contextWindow: cw,
          maxTokens: mt,
          input,
        });
        setEditingModelId(null);
      };

      const submitAdd = async (e) => {
        e.preventDefault();
        const id = modelId.trim();
        if (!id) {
          setErr("请输入模型 ID");
          return;
        }
        if (/\s/.test(id)) {
          setErr("模型 ID 不能包含空白字符");
          return;
        }
        setErr("");
        await act("add-model", undefined, { id, name: modelName.trim() });
        setModelId("");
        setModelName("");
        setAdding(false);
      };

      const fetchUpstream = async () => {
        setFetching(true);
        setFetchErr("");
        try {
          const res = await callPool("/__pool/action", { action: "fetch-models" });
          setDiscovered(Array.isArray(res?.discovered) ? res.discovered : []);
        } catch (cause) {
          setFetchErr(cause?.message ?? String(cause));
        } finally {
          setFetching(false);
        }
      };

      return h(
        "section",
        { className: "mp-card mp-group", "aria-label": "模型目录" },
        h(
          "div",
          { className: "mp-group-head" },
          h("span", { className: "mp-group-name" }, "模型目录"),
          h("span", { className: "mp-chip" }, `${models.length} 个模型`),
          state?.modelsCustomized
            ? h("span", { className: "mp-chip active-pool" }, "已自定义")
            : h("span", { className: "mp-chip" }, "默认目录"),
          h(
            "div",
            { className: "mp-group-meta" },
            state?.modelsCustomized
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "mp-btn mp-group-add",
                    disabled: Boolean(busy),
                    onClick: () => act("reset-models"),
                  },
                  "恢复默认模型",
                )
              : null,
            h(
              "button",
              {
                type: "button",
                className: "mp-btn mp-group-add",
                disabled: Boolean(busy) || fetching,
                onClick: fetchUpstream,
              },
              fetching ? "获取中…" : "获取可用模型",
            ),
            h(
              "button",
              {
                type: "button",
                className: "mp-btn mp-group-add",
                disabled: Boolean(busy),
                onClick: () => {
                  setAdding(!adding);
                  setErr("");
                },
              },
              adding ? "收起" : "+ 添加模型",
            ),
          ),
        ),
        fetchErr ? h("div", { className: "mp-form-err", style: { margin: "8px 16px 0" } }, fetchErr) : null,
        adding
          ? h(
              "form",
              { className: "mp-form mp-form-inline", onSubmit: submitAdd },
              h(
                "div",
                { className: "mp-form-grid" },
                h(
                  "div",
                  { className: "mp-field" },
                  h("label", { className: "mp-field-label" }, "模型 ID"),
                  h(
                    "div",
                    { className: "mp-input-wrap" },
                    h("input", {
                      type: "text",
                      className: "mp-input mono",
                      placeholder: "如 mistral-medium-latest",
                      value: modelId,
                      autoFocus: true,
                      onChange: (e) => setModelId(e.target.value),
                    }),
                  ),
                ),
                h(
                  "div",
                  { className: "mp-field" },
                  h("label", { className: "mp-field-label" }, "显示名称（选填）"),
                  h(
                    "div",
                    { className: "mp-input-wrap" },
                    h("input", {
                      type: "text",
                      className: "mp-input",
                      placeholder: "留空使用模型 ID",
                      value: modelName,
                      onChange: (e) => setModelName(e.target.value),
                    }),
                  ),
                ),
              ),
              err ? h("div", { className: "mp-form-err" }, err) : null,
              h(
                "div",
                { className: "mp-form-foot" },
                h(
                  "div",
                  { className: "mp-form-actions" },
                  h("button", { type: "button", className: "mp-btn", onClick: () => setAdding(false) }, "取消"),
                  h("button", { type: "submit", className: "mp-btn primary", disabled: Boolean(busy) }, "添加"),
                ),
              ),
            )
          : null,
        models.length === 0
          ? h("div", { className: "mp-empty", style: { border: 0, minHeight: "64px" } }, "暂无模型，请点击「+ 添加模型」或「恢复默认模型」。")
          : h(
              "div",
              { className: "mp-rows" },
              models.map((m) => {
                const inputList = Array.isArray(m.input) ? m.input : ["text"];
                const modText = inputList.includes("image") ? "文本 / 图片" : "仅文本";
                const isEditing = editingModelId === m.id;
                return h(
                  "div",
                  { key: m.id, className: "mp-row", style: { padding: compact ? "8px 14px" : "9px 16px", gap: "4px" } },
                  h(
                    "div",
                    { className: "mp-line" },
                    h(
                      "div",
                      { className: "mp-who" },
                      h("span", { className: "mp-model-id" }, m.id),
                      m.name && m.name !== m.id ? h("span", { className: "mp-model-sub" }, m.name) : null,
                    ),
                    h(
                      "div",
                      { className: "mp-actions", style: { opacity: 1 } },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "mp-act",
                          disabled: Boolean(busy),
                          onClick: () => openEditModel(m),
                        },
                        isEditing ? "收起" : "编辑",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "mp-act danger",
                          disabled: Boolean(busy),
                          title: `移除 ${m.id}`,
                          onClick: () => act("remove-model", m.id, { modelId: m.id }),
                        },
                        "移除",
                      ),
                    ),
                  ),
                  h(
                    "div",
                    { className: "mp-meter" },
                    h("span", { className: "mp-memo" }, `${fmtCap(m.contextWindow)} 上下文`),
                    h("span", { className: "mp-memo" }, `${fmtCap(m.maxTokens)} 输出`),
                    h("span", { className: "mp-memo" }, modText),
                    Array.isArray(m.efforts) && m.efforts.length > 0
                      ? h("span", { className: "mp-memo" }, `思考 ${m.efforts[0]}–${m.efforts[m.efforts.length - 1]}`)
                      : null,
                  ),
                  isEditing
                    ? h(
                        "form",
                        { className: "mp-edit-form", onSubmit: (e) => submitEditModel(e, m.id) },
                        h(
                          "div",
                          { className: "mp-field" },
                          h("label", { className: "mp-field-label" }, "显示名称（选填）"),
                          h(
                            "div",
                            { className: "mp-input-wrap" },
                            h("input", {
                              type: "text",
                              className: "mp-input",
                              placeholder: m.id,
                              value: editName,
                              onChange: (e) => setEditName(e.target.value),
                            }),
                          ),
                        ),
                        h(
                          "div",
                          { className: "mp-form-grid" },
                          h(
                            "div",
                            { className: "mp-field" },
                            h("label", { className: "mp-field-label" }, "上下文窗口"),
                            h(
                              "div",
                              { className: "mp-input-wrap" },
                              h("input", {
                                type: "number",
                                min: "1",
                                step: "1",
                                className: "mp-input",
                                value: editCtx,
                                onChange: (e) => setEditCtx(e.target.value),
                              }),
                            ),
                          ),
                          h(
                            "div",
                            { className: "mp-field" },
                            h("label", { className: "mp-field-label" }, "最大输出 token 数"),
                            h(
                              "div",
                              { className: "mp-input-wrap" },
                              h("input", {
                                type: "number",
                                min: "1",
                                step: "1",
                                className: "mp-input",
                                value: editMax,
                                onChange: (e) => setEditMax(e.target.value),
                              }),
                            ),
                          ),
                        ),
                        h(
                          "div",
                          { className: "mp-form-row" },
                          h("span", { className: "mp-field-label" }, "输入类型："),
                          h(
                            "label",
                            { className: "mp-check" },
                            h("input", { type: "checkbox", checked: editText, onChange: (e) => setEditText(e.target.checked) }),
                            "文本",
                          ),
                          h(
                            "label",
                            { className: "mp-check" },
                            h("input", { type: "checkbox", checked: editImage, onChange: (e) => setEditImage(e.target.checked) }),
                            "图片",
                          ),
                        ),
                        editErr ? h("div", { className: "mp-form-err" }, editErr) : null,
                        h(
                          "div",
                          { className: "mp-form-foot" },
                          h(
                            "div",
                            { className: "mp-form-actions" },
                            h("button", { type: "button", className: "mp-btn", onClick: () => setEditingModelId(null) }, "取消"),
                            h("button", { type: "submit", className: "mp-btn primary", disabled: Boolean(busy) }, "保存"),
                          ),
                        ),
                      )
                    : null,
                );
              }),
            ),
        Array.isArray(discovered)
          ? h(
              "div",
              { className: "mp-discover-list" },
              discovered.length === 0
                ? h("div", { className: "mp-discover-row" }, "上游未返回模型列表")
                : [
                    h(
                      "div",
                      { key: "_hdr", className: "mp-discover-row", style: { justifyContent: "space-between", fontWeight: 500 } },
                      h("span", null, `发现 ${discovered.length} 个上游模型`),
                      h("button", { type: "button", className: "mp-act", onClick: () => setDiscovered(null) }, "收起"),
                    ),
                    ...discovered.slice(0, 30).map((d) => {
                      const added = existingIds.has(d.id);
                      return h(
                        "div",
                        { key: d.id, className: "mp-discover-row" },
                        h("span", { className: "mp-model-id" }, d.id),
                        d.name && d.name !== d.id ? h("span", { className: "mp-model-sub" }, d.name) : null,
                        h(
                          "button",
                          {
                            type: "button",
                            className: "mp-btn mp-group-add",
                            style: { marginLeft: "auto" },
                            disabled: added || Boolean(busy),
                            onClick: () => act("add-model", undefined, {
                              id: d.id,
                              name: d.name,
                              contextWindow: d.contextWindow,
                              maxTokens: d.maxTokens,
                              input: d.input,
                              efforts: d.efforts,
                            }),
                          },
                          added ? "已添加" : "+ 添加",
                        ),
                      );
                    }),
                  ],
            )
          : null,
      );
    }

    function PoolSection() {
      const { state, error, busy, act, addKey, updateKey, reload } = usePool();
      const [addTarget, setAddTarget] = React.useState(null);
      const [confirmDeleteId, setConfirmDeleteId] = React.useState(null);
      const [editKeyId, setEditKeyId] = React.useState(null);
      const handleRequestDelete = (id) => {
        setConfirmDeleteId(id);
        if (id) setEditKeyId(null);
      };
      const handleToggleEdit = (id) => {
        setEditKeyId(id);
        if (id) setConfirmDeleteId(null);
      };
      const keys = state?.keys ?? [];
      const groups = groupKeys(keys);
      const mode = state?.mode === "direct" ? "direct" : "acp";
      const pillText = error
        ? "代理未响应"
        : mode === "acp"
          ? `ACP · 活跃 ${state?.acp?.liveSessions ?? 0}`
          : `127.0.0.1:${state?.port ?? 28401}`;
      const defaultTopTarget = {
        where: "top",
        face: mode === "direct" ? 30 : 300,
        kind: mode === "direct" ? "studio" : "vibe",
      };
      const topOpen = addTarget?.where === "top";
      return h(
        "section",
        { className: "mp-root", "aria-label": "Mistral Key 池" },
        h(
          "div",
          { className: "mp-head" },
          h(
            "div",
            { className: "mp-head-copy" },
            h("h2", { className: "mp-title" }, "Mistral Key 池"),
          ),
          h(
            "div",
            { className: "mp-head-side" },
            h(
              "span",
              { className: "mp-pill" },
              h("i", { className: `mp-dot ${error ? "off" : ""}` }),
              pillText,
            ),
            h(
              "button",
              {
                type: "button",
                className: "mp-btn primary",
                disabled: Boolean(busy),
                title: "手动新增一把 Mistral API Key 到配置池",
                onClick: () => setAddTarget(topOpen ? null : defaultTopTarget),
              },
              topOpen ? "收起表单" : "+ 新增 Key",
            ),
            h("button", { type: "button", className: "mp-btn", onClick: reload, disabled: Boolean(busy) }, "刷新"),
          ),
        ),
        error
          ? h(
              "div",
              { className: "mp-banner" },
              h("span", null, "读不到 key 池：", h("span", { style: { opacity: 0.85 } }, error)),
              h(
                "button",
                { type: "button", className: "mp-act", style: { marginLeft: "auto" }, onClick: reload },
                "重试",
              ),
            )
          : null,
        topOpen
          ? h(
              "div",
              { className: "mp-card" },
              h(AddKeyForm, {
                key: `top:${addTarget.face}:${addTarget.kind}`,
                initialFace: addTarget.face,
                initialKind: addTarget.kind,
                embedded: false,
                busy,
                onSubmit: addKey,
                onCancel: () => setAddTarget(null),
              }),
            )
          : null,
        state === null && !error
          ? h("div", { className: "mp-skeleton" })
          : null,
        state === null ? null : keys.length === 0 ? h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "14px" } },
          h(ModeCard, { state, busy, act }),
          h(
            "div",
            { className: "mp-empty" },
            h("span", null, "池里还没有 key。点击上方「+ 新增 Key」直接添加，或编辑 ", h("code", null, "~/.dsh/mistral-pool.json"), "。"),
            h(
              "button",
              {
                type: "button",
                className: "mp-btn primary",
                disabled: Boolean(busy),
                onClick: () => setAddTarget(defaultTopTarget),
              },
              "+ 新增 Key",
            ),
          ),
          h(ModelCatalogCard, { state, busy, act, callPool: call, compact: false }),
        ) : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "14px" } },
          h(ModeCard, { state, busy, act }),
          h(SummaryCard, { state }),
          groups.map((group) =>
            h(GroupCard, {
              key: group.face || "none",
              face: group.face,
              keys: group.keys,
              busy,
              act,
              state,
              confirmDeleteId,
              onRequestDelete: handleRequestDelete,
              editKeyId,
              onToggleEdit: handleToggleEdit,
              onUpdateKey: updateKey,
            }),
          ),
          h(ModelCatalogCard, { state, busy, act, callPool: call, compact: false }),
        ),
      );
    }

    function KeyIcon() {
      return h(
        "svg",
        {
          width: 16,
          height: 16,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        h("circle", { cx: 5.6, cy: 5.6, r: 2.5 }),
        h("path", { d: "M7.5 7.5 12.6 12.6" }),
        h("path", { d: "M10.4 10.4 9.3 11.5" }),
        h("path", { d: "M11.7 11.7 10.6 12.8" }),
      );
    }

    return {
      name: PACKAGE,
      inject: ["slots"],
      apply(ctx) {
        ctx.effect(() => ensureStyles(), "mistral-pool: styles");
        ctx.effect(
          () =>
            ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                { name: "settings.section", id: SECTION_ID, order: 900, label: () => "Mistral Key 池" },
                PoolSection,
              ),
            ),
          "mistral-pool: settings section",
        );
        ctx.effect(
          () =>
            ctx.slots.inject("settings.section.icon", () =>
              ctx.slots.register({ name: "settings.section.icon", id: SECTION_ID }, KeyIcon),
            ),
          "mistral-pool: settings icon",
        );
      },
    };
  }

  if (typeof globalThis !== "undefined" && globalThis.__ModuleLoader__) {
    globalThis.__ModuleLoader__.load({ id: "dsh-mistral-pool", factory: createClientPlugin });
  }
})();
