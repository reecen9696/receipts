// Haptic feedback on phones, from the web. Ported from the clutch pack-rip game.
//
// Android: the Vibration API, a pulse length in ms or an on/off pattern.
// iOS (Safari 17.4+): no vibration API, but toggling a native switch control plays the
// system "selection" tick, so a hidden <input type="checkbox" switch> is clicked through
// its label. One tick strength, so kinds map to a number of ticks. WebKit only plays it
// inside a user gesture. Desktop: a no-op. Never throws.
//
//   tap     — every button, very light and crisp (installButtonHaptics plays it)
//   hold    — long-press starts selecting
//   success — photos added, moved or deleted

const ANDROID = { tap: 10, hold: 25, success: [12, 60, 12] };
const IOS_TICKS = { tap: [1, 0], hold: [2, 35], success: [2, 70] }; // [count, gap ms]

const canVibrate = () => typeof navigator.vibrate === "function";
// iPhone, or an iPad (which reports itself as a Mac with a touch screen)
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function iosTick() {
  const label = document.createElement("label");
  label.setAttribute("aria-hidden", "true");
  label.style.display = "none";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.append(input);
  document.head.append(label);
  label.click();
  label.remove();
}

export function haptic(kind = "tap") {
  try {
    if (canVibrate()) navigator.vibrate(ANDROID[kind]);
    else if (isIOS()) {
      const [count, gap] = IOS_TICKS[kind];
      iosTick();
      for (let i = 1; i < count; i++) setTimeout(iosTick, i * gap);
    }
  } catch { /* haptics are a nicety; never let them break a tap */ }
}

// One capture-phase listener gives every button, link and tab the same light tap, so no
// handler has to remember to. `skip(e)` lets the app silence a click (the release after a
// long-press). Capture phase, inside the click itself: iOS only ticks in a user gesture.
export function installButtonHaptics(skip = () => false) {
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.('button, a[href], [role="button"], input[type="checkbox"]');
    if (!el || skip(e)) return;
    if (el.closest('[aria-hidden="true"]')) return; // the iOS tick is itself a click; don't answer it
    haptic("tap");
  }, { capture: true });
}
