document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    const powerToggle  = document.getElementById('power-toggle');
    const banSubmit    = document.getElementById('banSubmit');
    const banMinInput  = document.getElementById('banMinutes');
    const banStatus    = document.getElementById('banStatus');
    const extendRow    = document.getElementById('extendRow');
    const extendSubmit = document.getElementById('extendSubmit');
    const extendMin    = document.getElementById('extendMinutes');
    const docEl        = document.documentElement;

    const checkboxes = document.querySelectorAll('.settings-list input[type="checkbox"]');

    // ── Load stored state ───────────────────────────────────────────────────
    chrome.storage.sync.get(null, (items) => {
        const isDark = items.theme !== 'light';
        docEl.setAttribute('data-theme', isDark ? 'dark' : 'light');
        updateThemeIcon(isDark);
        checkboxes.forEach(cb => {
            if (items[cb.id] !== undefined) cb.checked = items[cb.id];
        });
        refreshBanUI(items.banUntil);
    });

    // ── Theme ───────────────────────────────────────────────────────────────
    themeToggle.addEventListener('click', () => {
        const isDark = docEl.getAttribute('data-theme') === 'dark';
        const newTheme = isDark ? 'light' : 'dark';
        docEl.setAttribute('data-theme', newTheme);
        updateThemeIcon(!isDark);
        chrome.storage.sync.set({ theme: newTheme });
    });

    function updateThemeIcon(isDark) {
        document.getElementById('theme-icon-dark').style.display  = isDark ? 'none'  : 'block';
        document.getElementById('theme-icon-light').style.display = isDark ? 'block' : 'none';
    }

    // ── Power toggle ────────────────────────────────────────────────────────
    powerToggle.addEventListener('click', () => {
        const feat = [...checkboxes].filter(cb => cb.id !== 'showStopwatch');
        const enable = feat.some(cb => !cb.checked);
        const updates = {};
        feat.forEach(cb => { cb.checked = enable; updates[cb.id] = enable; });
        chrome.storage.sync.set(updates);
        messageAllYouTubeTabs({ type: 'APPLY_SETTINGS', settings: updates });
    });

    // ── Feature toggles ─────────────────────────────────────────────────────
    checkboxes.forEach(cb => {
        cb.addEventListener('change', e => {
            const update = { [e.target.id]: e.target.checked };
            chrome.storage.sync.set(update);
            messageAllYouTubeTabs({ type: 'APPLY_SETTINGS', settings: update });
        });
    });

    // ── Extend ban ──────────────────────────────────────────────────────────
    extendSubmit.addEventListener('click', () => {
        chrome.storage.sync.get(['banUntil'], ({ banUntil }) => {
            if (!banUntil || Date.now() >= banUntil) return; // no active ban
            const addMs = Math.max(1, parseInt(extendMin.value, 10) || 15) * 60 * 1000;
            const newUntil = banUntil + addMs;
            chrome.storage.sync.set({ banUntil: newUntil });
            messageAllYouTubeTabs({ type: 'BAN', banUntil: newUntil });
            refreshBanUI(newUntil);
        });
    });

    // ── Ban ─────────────────────────────────────────────────────────────────
    banSubmit.addEventListener('click', () => {
        // If already banned, ignore all clicks
        chrome.storage.sync.get(['banUntil'], ({ banUntil }) => {
            if (banUntil && Date.now() < banUntil) return;

            const mins = Math.max(1, parseInt(banMinInput.value, 10) || 15);
            const until = Date.now() + mins * 60 * 1000;

            // Save to sync storage (covers new tabs + persistence)
            chrome.storage.sync.set({ banUntil: until });

            // Push immediately to all currently open YouTube tabs
            messageAllYouTubeTabs({ type: 'BAN', banUntil: until });

            refreshBanUI(until);
        });
    });

    // ── Helper: message every open YouTube tab ──────────────────────────────
    function messageAllYouTubeTabs(msg) {
        chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, msg, () => {
                    // suppress "no receiving end" errors if content script not yet ready
                    void chrome.runtime.lastError;
                });
            });
        });
    }

    // ── Ban UI state ────────────────────────────────────────────────────────
    let banTick = null;

    function refreshBanUI(banUntil) {
        if (banTick) { clearInterval(banTick); banTick = null; }

        if (banUntil && Date.now() < banUntil) {
            banMinInput.disabled = true;
            banSubmit.disabled = true;
            banSubmit.textContent = 'Locked';
            banSubmit.classList.add('locked');
            extendRow.style.display = 'flex';
            updateCountdown(banUntil);
            banStatus.style.display = 'block';

            banTick = setInterval(() => {
                if (Date.now() >= banUntil) {
                    clearInterval(banTick);
                    refreshBanUI(null);
                } else {
                    updateCountdown(banUntil);
                }
            }, 1000);
        } else {
            banMinInput.disabled = false;
            banSubmit.disabled = false;
            banSubmit.textContent = 'Ban';
            banSubmit.classList.remove('locked');
            extendRow.style.display = 'none';
            banStatus.textContent = '';
            banStatus.style.display = 'none';
        }
    }

    function updateCountdown(banUntil) {
        const rem = banUntil - Date.now();
        const h = Math.floor(rem / 3600000);
        const m = Math.floor((rem % 3600000) / 60000);
        const s = Math.floor((rem % 60000) / 1000);
        const pad = n => String(n).padStart(2, '0');
        banStatus.textContent = `Locked — ${h > 0 ? `${pad(h)}:` : ''}${pad(m)}:${pad(s)} remaining`;
    }

    // Update UI if ban expires while popup is open
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !('banUntil' in changes)) return;
        refreshBanUI(changes.banUntil.newValue);
    });
});
