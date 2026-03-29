// ── Dumb Tube Content Script ──────────────────────────────────────────────────

const HIDE_PREFIX = 'dumbtube-';
const html = document.documentElement;
const LS_KEY = 'dumbtube_banUntil';

function pad(n) { return String(n).padStart(2, '0'); }

// ── Extension context guard ───────────────────────────────────────────────────
// When the extension is reloaded/updated, the context is invalidated.
// All intervals must stop to prevent "Extension context invalidated" errors.

const allIntervals = [];

function safeInterval(fn, ms) {
    const id = setInterval(() => {
        if (!isContextValid()) { allIntervals.forEach(clearInterval); return; }
        try { fn(); } catch (e) { if (isContextInvalidError(e)) allIntervals.forEach(clearInterval); }
    }, ms);
    allIntervals.push(id);
    return id;
}

function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
}

function isContextInvalidError(e) {
    return e?.message?.includes('Extension context invalidated');
}

function safeChromeGet(keys, cb) {
    if (!isContextValid()) return;
    try { chrome.storage.sync.get(keys, cb); } catch {}
}

function safeChromeSet(obj) {
    if (!isContextValid()) return;
    try { chrome.storage.sync.set(obj); } catch {}
}

function safeChromeRemove(key) {
    if (!isContextValid()) return;
    try { chrome.storage.sync.remove(key); } catch {}
}



// ── Inject ban overlay immediately at document_start ─────────────────────────
// Appended to <html> (not <body>) so it exists before the page renders.

(function injectBanEarly() {
    const style = document.createElement('style');
    style.textContent = `
        #dumbtube-ban-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: #000;
            z-index: 2147483647;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        }
        #dumbtube-ban-overlay.active { display: flex !important; }
        .ban-content { display:flex;flex-direction:column;align-items:center;gap:14px;user-select:none; }
        .ban-icon { font-size:60px;animation:ban-pulse 2.5s ease-in-out infinite; }
        @keyframes ban-pulse{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.06);opacity:1}}
        .ban-msg { font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;font-size:26px;font-weight:700;color:#fff; }
        .ban-countdown { font-family:'SF Mono','Roboto Mono',ui-monospace,monospace;font-size:20px;font-weight:600;color:rgba(255,255,255,.5);letter-spacing:1px; }
    `;
    html.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'dumbtube-ban-overlay';
    overlay.innerHTML = `
        <div class="ban-content">
            <div class="ban-icon">🔒</div>
            <div class="ban-msg">YouTube is locked</div>
            <div id="ban-countdown" class="ban-countdown"></div>
        </div>`;
    html.appendChild(overlay);
})();

// ── Ban storage helpers ───────────────────────────────────────────────────────

function getLsBan() {
    try { return parseInt(localStorage.getItem(LS_KEY) || '0', 10) || 0; } catch { return 0; }
}

function persistBan(ts) {
    safeChromeSet({ banUntil: ts });
    try { localStorage.setItem(LS_KEY, String(ts)); } catch {}
}

function clearBan() {
    safeChromeRemove('banUntil');
    try { localStorage.removeItem(LS_KEY); } catch {}
}

// ── Ban activation ────────────────────────────────────────────────────────────

let banTickInterval = null;

function activateBan(banUntil) {
    const overlay = document.getElementById('dumbtube-ban-overlay');
    if (overlay) overlay.classList.add('active');

    if (banTickInterval) clearInterval(banTickInterval);
    banTickInterval = safeInterval(() => {
        const remaining = banUntil - Date.now();
        if (remaining <= 0) {
            clearInterval(banTickInterval);
            banTickInterval = null;
            const ov = document.getElementById('dumbtube-ban-overlay');
            if (ov) ov.classList.remove('active');
            clearBan();
            return;
        }
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        const cd = document.getElementById('ban-countdown');
        if (cd) cd.textContent = h > 0
            ? `${pad(h)}:${pad(m)}:${pad(s)} remaining`
            : `${pad(m)}:${pad(s)} remaining`;
    }, 500);
}

function deactivateBan() {
    if (banTickInterval) { clearInterval(banTickInterval); banTickInterval = null; }
    const overlay = document.getElementById('dumbtube-ban-overlay');
    if (overlay) overlay.classList.remove('active');
}

function checkBan(syncBanUntil) {
    const lsBan = getLsBan();
    const banUntil = Math.max(syncBanUntil || 0, lsBan);

    if (banUntil && Date.now() < banUntil) {
        // Re-sync localStorage → storage if needed (survives reinstall)
        if (lsBan && !syncBanUntil) safeChromeSet({ banUntil: lsBan });
        activateBan(banUntil);
    } else {
        deactivateBan();
        if (lsBan) clearBan();
    }
}

// Check localStorage immediately (covers reinstall case before storage loads)
const earlyBan = getLsBan();
if (earlyBan && Date.now() < earlyBan) activateBan(earlyBan);

// ── Apply CSS feature classes ─────────────────────────────────────────────────

function applySettings(settings) {
    [...html.classList].forEach(c => c.startsWith(HIDE_PREFIX) && html.classList.remove(c));

    for (const [key, val] of Object.entries(settings)) {
        if (['theme', 'showStopwatch', 'banUntil', 'banMinutes'].includes(key)) continue;
        if (val) html.classList.add(`${HIDE_PREFIX}${key}`);
    }

    if (settings.disableAutoplay) {
        const btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
        if (btn) btn.click();
    }

    const sw = document.getElementById('dumbtube-stopwatch');
    if (sw) sw.style.display = settings.showStopwatch !== false ? 'flex' : 'none';

    checkBan(settings.banUntil);
}

// ── Message listener — receives direct pushes from popup ─────────────────────
// This fires IMMEDIATELY when popup calls chrome.tabs.sendMessage, even before
// storage events propagate.

try {
    chrome.runtime.onMessage.addListener((msg) => {
        if (!isContextValid()) return;
        if (msg.type === 'BAN') {
            try { localStorage.setItem(LS_KEY, String(msg.banUntil)); } catch {}
            activateBan(msg.banUntil);
        } else if (msg.type === 'APPLY_SETTINGS') {
            for (const [key, val] of Object.entries(msg.settings)) {
                if (['theme', 'showStopwatch', 'banUntil', 'banMinutes'].includes(key)) continue;
                if (val) {
                    html.classList.add(`${HIDE_PREFIX}${key}`);
                } else {
                    html.classList.remove(`${HIDE_PREFIX}${key}`);
                }
            }
            if ('showStopwatch' in msg.settings) {
                const sw = document.getElementById('dumbtube-stopwatch');
                if (sw) sw.style.display = msg.settings.showStopwatch !== false ? 'flex' : 'none';
            }
        }
    });
} catch {}


// ── Initial load from sync storage ───────────────────────────────────────────
safeChromeGet(null, applySettings);

// Fallback: also react to storage changes (covers edge cases)
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (!isContextValid()) return;
        if (area !== 'sync') return;
        if ('banUntil' in changes) checkBan(changes.banUntil.newValue);
    });
} catch {}

// Re-apply on YouTube SPA navigation (e.g. clicking to a new video)
document.addEventListener('yt-navigate-finish', () => {
    safeChromeGet(null, applySettings);
});

// ── Stopwatch ─────────────────────────────────────────────────────────────────

let activeSeconds = 0;
let lastTick = Date.now();

function getOrCreateStopwatch() {
    let sw = document.getElementById('dumbtube-stopwatch');
    if (!sw && document.body) {
        sw = document.createElement('div');
        sw.id = 'dumbtube-stopwatch';
        sw.title = 'Active watch time this session';
        document.body.appendChild(sw);
    }
    return sw;
}

safeInterval(() => {
    const isVisible = document.visibilityState === 'visible';
    const video = document.querySelector('video.html5-main-video');
    const isPlaying = video && !video.paused && !video.ended;

    if (isVisible && isPlaying) {
        activeSeconds += Math.round((Date.now() - lastTick) / 1000);
    }
    lastTick = Date.now();

    safeChromeGet(['showStopwatch'], ({ showStopwatch }) => {
        const sw = getOrCreateStopwatch();
        if (!sw) return;
        if (showStopwatch === false) { sw.style.display = 'none'; return; }
        const h = Math.floor(activeSeconds / 3600);
        const m = Math.floor((activeSeconds % 3600) / 60);
        const s = activeSeconds % 60;
        sw.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
        sw.style.display = 'flex';
    });
}, 1000);
