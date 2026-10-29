// ══════════════════════════════════════════
// 🧭 ROUTE DETAILS AUTO-POPUP
// ══════════════════════════════════════════
// While navigating, this keeps the Route Details panel in front of you at
// the moments that matter:
//   • 50 m from the destination → the panel reopens (if minimized) so the
//     "✅ Arrived" button is visible.
//   • 25 m from the destination → the panel reopens AGAIN (if you minimized
//     it after the 50 m popup) and shows its own "📍 Almost there" banner
//     with the live distance left.
// Minimizing the panel simply starts a new count.
//
// Uses script.js globals (state, setNavigationMode, evaluateArrival,
// calculateDistance). script.js needs no changes — just load this file
// after it in index.html.

(function () {
    'use strict';

    const POPUP_EVERY_M = Infinity;   // no popups while walking — only at 50 m and 25 m
    const POPUP_NEAR_DESTINATION = true;
    const CLOSE_POPUP_M = 25;         // second popup: "almost there"
    const CLOSE_HIDE_BUFFER_M = 5;    // banner hides again only past 25 + 5 m (stops flicker)
    const CHECK_EVERY_MS = 2000;
    const MIN_STEP_M = 3;             // ignore GPS jitter smaller than this

    const st = {
        wasHidden: false,
        walked: 0,                    // meters walked since the panel was minimized
        lastPos: null,
        nearShownFor: null,           // destination already popped for the 50 m popup
        closeShownFor: null           // destination already popped for the 25 m popup
    };

    const appState = () => (typeof state !== 'undefined' ? state : null);
    const panel = () => document.getElementById('routeInfo');

    function meters(a, b) {
        return calculateDistance([a.lat, a.lng], [b.lat, b.lng]);
    }

    // Don't pop up over something the user is busy with.
    function somethingElseOpen() {
        if (typeof map3dState !== 'undefined' && map3dState.active) return true;
        if (document.getElementById('profilePanel')?.classList.contains('open')) return true;
        if (document.getElementById('locationModal')?.classList.contains('active')) return true;
        const addStop = document.getElementById('msAddStopModal');
        if (addStop && addStop.style.display && addStop.style.display !== 'none') return true;
        return false;
    }

    function destinationKey(dest) {
        return dest ? (dest.id || `${dest.name}@${dest.coords}`) : null;
    }

    function open(reason) {
        if (typeof setNavigationMode === 'function') setNavigationMode('route');
        else panel()?.classList.remove('hidden');
        st.walked = 0;
        st.lastPos = null;
        st.wasHidden = false;
        console.log('🧭 Route Details reopened:', reason);
    }

    // ── "Almost there" banner inside the Route Details panel ────────
    // Lives in the same box as the Arrived button and the 5-second
    // countdown banner, above both. Own element, so the countdown banner
    // in script.js is never touched.
    function getNearBanner(create) {
        let banner = document.getElementById('msNearBanner');
        if (banner || !create) return banner;
        const section = document.getElementById('msArrivedSection');
        if (!section) return null;
        banner = document.createElement('div');
        banner.id = 'msNearBanner';
        banner.style.cssText = [
            'display:none', 'text-align:center', 'padding:8px', 'margin-bottom:6px',
            'background:#e8f0fe', 'color:#2c5aa0', 'border:1.5px solid #2c5aa0',
            'border-radius:8px', 'font-size:13px', 'font-weight:600'
        ].join(';');
        const title = document.createElement('div');
        title.className = 'ms-near-title';
        const sub = document.createElement('div');
        sub.className = 'ms-near-sub';
        sub.style.cssText = 'font-size:11px;font-weight:500;margin-top:2px;opacity:0.85';
        banner.append(title, sub);
        section.insertBefore(banner, section.firstChild);
        return banner;
    }

    function showNearBanner(dest, metersLeft) {
        const banner = getNearBanner(true);
        if (!banner) return;
        banner.querySelector('.ms-near-title').textContent = '📍 Almost there!';
        banner.querySelector('.ms-near-sub').textContent =
            `${dest?.name || 'Your destination'} is about ${Math.max(1, Math.round(metersLeft))} m ahead`;
        banner.style.display = 'block';
        // The banner sits inside the Arrived section, so make sure that shows.
        const section = document.getElementById('msArrivedSection');
        if (section) section.style.display = 'block';
    }

    function hideNearBanner() {
        const banner = getNearBanner(false);
        if (banner) banner.style.display = 'none';
    }

    function tick() {
        const s = appState();
        const p = panel();
        if (!s || !p || !s.currentRoute) {        // not navigating
            st.wasHidden = false;
            st.walked = 0;
            st.lastPos = null;
            if (!s?.currentRoute) { st.nearShownFor = null; st.closeShownFor = null; hideNearBanner(); }
            return;
        }

        const loc = s.userLocation;
        if (!loc) return;

        // ── How close are we? (same rule as the Arrived button in script.js:
        // distance left ALONG the route, or the straight-line rule when off it.)
        const dest = s.currentRoute.destination || s.selectedLocation;
        const key = destinationKey(dest);
        const left = window.RouteProgress?.remainingMeters(loc.lat, loc.lng, s.currentRoute.coordinates);
        const check = (dest && typeof evaluateArrival === 'function')
            ? evaluateArrival(loc.lat, loc.lng, loc.accuracy, dest)
            : null;
        const near = left && !left.offRoute
            ? left.remaining <= ARRIVAL_NEAR_RADIUS_M
            : (check ? check.near : false);
        const metersLeft = left && !left.offRoute
            ? left.remaining
            : (check ? check.distance : Infinity);

        // Keep the Arrived button in step with the panel. script.js only
        // re-checks it every 3 seconds, which made it lag behind the popup.
        const arrived = document.getElementById('msArrivedSection');
        if (arrived && near) arrived.style.display = 'block';

        // ── 25 m popup ──────────────────────────────────────────────
        // The banner stays up (with a live distance) while you're inside
        // 25 m. The panel itself reopens once per destination if you had
        // minimized it. The 5-second countdown banner takes over once you
        // arrive, so this one steps aside while that is showing.
        const countdown = document.getElementById('msCountdownBanner');
        const countdownShowing = !!(countdown && countdown.style.display && countdown.style.display !== 'none');
        const closeEnough = !!key && metersLeft <= CLOSE_POPUP_M;

        if (closeEnough && !countdownShowing) {
            showNearBanner(dest, metersLeft);
        } else if (countdownShowing || metersLeft > CLOSE_POPUP_M + CLOSE_HIDE_BUFFER_M) {
            hideNearBanner();
        }

        const hidden = p.classList.contains('hidden');

        if (closeEnough && key !== st.closeShownFor && !somethingElseOpen()) {
            st.closeShownFor = key;
            st.nearShownFor = key;                // the 50 m popup is covered by this one
            if (hidden) { open('25 m from destination'); return; }
        }

        if (!hidden) {                            // panel is open — the user can already see it
            st.wasHidden = false;
            if (near) st.nearShownFor = key;      // no need to pop up again for this destination
            return;
        }

        // Panel was just minimized → start counting from here.
        if (!st.wasHidden) {
            st.wasHidden = true;
            st.walked = 0;
            st.lastPos = { lat: loc.lat, lng: loc.lng };
        }

        // Count real movement only (small GPS wobble is ignored).
        const step = meters(st.lastPos, loc);
        if (step >= MIN_STEP_M) {
            st.walked += step;
            st.lastPos = { lat: loc.lat, lng: loc.lng };
        }

        if (somethingElseOpen()) return;

        // Close to the destination → pop up once, with the Arrived button showing.
        if (POPUP_NEAR_DESTINATION && near && key !== st.nearShownFor) {
            st.nearShownFor = key;
            open('near destination (50 m)');
            return;
        }

        // Walking popups stop in the last stretch before the destination, so
        // the next popup there is the one WITH the Arrived button.
        const finalStretch = POPUP_NEAR_DESTINATION && left && !left.offRoute
            && left.remaining <= ARRIVAL_NEAR_RADIUS_M + POPUP_EVERY_M;
        if (!finalStretch && st.walked >= POPUP_EVERY_M) open(`walked ${Math.round(st.walked)} m`);
    }

    setInterval(tick, CHECK_EVERY_MS);
})();