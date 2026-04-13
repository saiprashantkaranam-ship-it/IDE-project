/**
 * pycloud-modules.js
 * Drop this in your project root. Import into login.html and ide.html.
 * Firebase Modular SDK v10 — production-ready
 */

import { initializeApp }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, serverTimestamp }
                                from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, getDownloadURL }
                                from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ─────────────────────────────────────────────
// FIREBASE INIT (singleton)
// ─────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyCOKp_ksThO3E_oc_H7NWMqkPTuLoDrrKI",
  authDomain:        "ideqvr.firebaseapp.com",
  projectId:         "ideqvr",
  storageBucket:     "ideqvr.firebasestorage.app",
  messagingSenderId: "258032258981",
  appId:             "1:258032258981:web:d302dcc896d5ab18c2e24c",
};

const app     = initializeApp(firebaseConfig);
const db      = getFirestore(app);
const storage = getStorage(app);

const GLOBAL_DOC = () => doc(db, "settings", "global");


// ═══════════════════════════════════════════════════════════════
// 1. PASSWORD — realtime sync + validation
// ═══════════════════════════════════════════════════════════════

let _password = "MOON"; // local cache; updated by onSnapshot

/**
 * Call once on page load.
 * Keeps _password in sync with Firestore in real-time.
 * Returns the unsubscribe function.
 *
 * @param {(data: object) => void} [onChange]  optional callback with full doc data
 */
export function initPasswordSync(onChange) {
  return onSnapshot(GLOBAL_DOC(), (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      _password = data.password ?? "MOON";
      onChange?.(data);
    }
  });
}

/** Validate user input against the live Firestore password. */
export function validatePassword(input) {
  return input === _password;
}

/**
 * (Admin helper) Write a new password to Firestore — all devices update instantly.
 * @param {string} newPassword
 */
export async function setPassword(newPassword) {
  await setDoc(GLOBAL_DOC(), { password: newPassword }, { merge: true });
}


// ═══════════════════════════════════════════════════════════════
// 2. GLOBAL THEME / ASSET SYSTEM — realtime sync + upload
// ═══════════════════════════════════════════════════════════════

/**
 * Listen for asset + site-level changes and apply them.
 *
 * handlers = {
 *   onBackground(url)   → set body background image
 *   onLogo(url)         → set logo img src
 *   onSiteName(name)    → update brand text
 *   onSettingsIcon(url) → any extra icon
 * }
 *
 * Returns unsubscribe.
 */
export function initAssetSync(handlers = {}) {
  return onSnapshot(GLOBAL_DOC(), (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();

    const assets = d.assets ?? {};
    const bg     = assets.backgroundUrl;
    const logo   = assets.logoUrl;

    if (bg  && handlers.onBackground)   handlers.onBackground(bg);
    if (logo && handlers.onLogo)        handlers.onLogo(logo);
    if (d.siteName && handlers.onSiteName) handlers.onSiteName(d.siteName);
    if (assets.settingsIconUrl && handlers.onSettingsIcon)
      handlers.onSettingsIcon(assets.settingsIconUrl);
  });
}

/**
 * Upload a file to Firebase Storage, then save its URL under
 * settings/global/assets/<assetKey>.
 *
 * @param {File}   file
 * @param {string} assetKey  e.g. "backgroundUrl" | "logoUrl" | "settingsIconUrl"
 * @param {(pct: number) => void}  [onProgress]
 * @param {(url: string) => void}  [onComplete]
 * @param {(err: Error)  => void}  [onError]
 * @returns {UploadTask}
 */
export function uploadAsset(file, assetKey, onProgress, onComplete, onError) {
  const ext      = file.name.split(".").pop();
  const path     = `assets/${assetKey}_${Date.now()}.${ext}`;
  const storeRef = ref(storage, path);
  const task     = uploadBytesResumable(storeRef, file);

  task.on(
    "state_changed",
    (snap) => {
      const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
      onProgress?.(pct, snap);
    },
    (err) => onError?.(err),
    async () => {
      try {
        const url = await getDownloadURL(task.snapshot.ref);
        await setDoc(GLOBAL_DOC(), { assets: { [assetKey]: url } }, { merge: true });
        onComplete?.(url);
      } catch (err) {
        onError?.(err);
      }
    }
  );

  return task;
}

/**
 * Open a native file picker, upload the chosen file, save URL to Firestore.
 * Returns a Promise<string> (the download URL).
 *
 * Usage: await pickAndUploadAsset("backgroundUrl");
 *
 * @param {string} assetKey
 * @param {string} [accept="image/*"]
 * @param {(pct: number) => void} [onProgress]
 */
export function pickAndUploadAsset(assetKey, accept = "image/*", onProgress) {
  return new Promise((resolve, reject) => {
    const input    = document.createElement("input");
    input.type     = "file";
    input.accept   = accept;
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return reject(new Error("No file selected"));
      uploadAsset(file, assetKey, onProgress, resolve, reject);
    };
    input.click();
  });
}


// ═══════════════════════════════════════════════════════════════
// 3. PYODIDE LOADER — lazy, progress + ETA
// ═══════════════════════════════════════════════════════════════

let _pyodide        = null;
let _pyodideLoading = false;
let _pyodideReady   = false;

export function isPyodideReady() { return _pyodideReady; }
export function getPyodide()     { return _pyodide; }

/**
 * Load Pyodide on demand (call from Run button handler).
 * Shows fake-but-realistic progress since Pyodide exposes no fetch events.
 *
 * callbacks = {
 *   onStatus(msg)   → update status text
 *   onProgress(pct) → update progress bar (0-100)
 *   onETA(secs)     → update ETA display
 *   onReady(pyodide)→ Pyodide is loaded; run code here
 *   onError(err)    → show error
 * }
 */
export function loadPyodideWithProgress(callbacks = {}) {
  if (_pyodideReady)  { callbacks.onReady?.(_pyodide); return; }
  if (_pyodideLoading) return;
  _pyodideLoading = true;

  const { onStatus, onProgress, onETA, onReady, onError } = callbacks;

  // Stage messages keyed by progress threshold
  const stages = [
    { at:  0,  msg: "Starting download..."           },
    { at: 15,  msg: "Downloading Python runtime..."   },
    { at: 45,  msg: "Unpacking core modules..."       },
    { at: 70,  msg: "Installing packages..."          },
    { at: 90,  msg: "Finalizing runtime..."           },
  ];

  const startTime  = Date.now();
  let   stageIdx   = 0;
  let   fakeTimer  = null;

  function calcETA(pct) {
    if (pct <= 0) return null;
    const elapsed = (Date.now() - startTime) / 1000;          // seconds
    const rate    = pct / elapsed;                              // % per second
    return rate > 0 ? Math.max(0, Math.round((100 - pct) / rate)) : null;
  }

  function tick(pct) {
    // Advance stage messages
    while (stageIdx < stages.length && pct >= stages[stageIdx].at) {
      onStatus?.(stages[stageIdx].msg);
      stageIdx++;
    }
    onProgress?.(Math.min(pct, 99)); // hold at 99 until real load done
    const eta = calcETA(pct);
    if (eta !== null) onETA?.(eta);
  }

  // Simulated progress curve (ms delay between steps)
  // Mirrors realistic CDN download timing for ~8 MB Pyodide bundle
  const fakeCurve = [
    [0, 400], [8, 800], [18, 1200], [30, 1500],
    [42, 1800], [55, 1500], [66, 1200], [75, 900],
    [83, 700],  [89, 500],  [93, 400],
  ];
  let curveIdx = 0;

  function advanceCurve() {
    if (curveIdx >= fakeCurve.length) return;
    const [pct, delay] = fakeCurve[curveIdx++];
    tick(pct);
    fakeTimer = setTimeout(advanceCurve, delay);
  }

  advanceCurve();

  // Real load
  (async () => {
    try {
      _pyodide = await globalThis.loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/",
      });

      clearTimeout(fakeTimer);

      onProgress?.(100);
      onStatus?.("✓ Python runtime ready!");
      onETA?.(0);

      _pyodideReady   = true;
      _pyodideLoading = false;

      // Persist ready state for dashboards / admin views
      await setDoc(GLOBAL_DOC(), { pyodideReady: true }, { merge: true });

      onReady?.(_pyodide);

    } catch (err) {
      clearTimeout(fakeTimer);
      _pyodideLoading = false;
      onError?.(err);
    }
  })();
}


// ═══════════════════════════════════════════════════════════════
// 4. RUN BUTTON HANDLER — single entry point for ide.html
// ═══════════════════════════════════════════════════════════════

/**
 * Call this when user clicks Run.
 *
 * @param {string} code  Python code to execute
 * @param {object} loaderCallbacks  same shape as loadPyodideWithProgress callbacks
 * @param {object} runCallbacks
 *   { onOutput(stdout, stderr), onError(msg) }
 */
export function handleRunClick(code, loaderCallbacks = {}, runCallbacks = {}) {
  if (_pyodideReady) {
    runPython(code, runCallbacks);
  } else {
    loaderCallbacks.onStatus?.("Download started...");
    loadPyodideWithProgress({
      ...loaderCallbacks,
      onReady(pyodide) {
        loaderCallbacks.onReady?.(pyodide);
        runPython(code, runCallbacks);
      },
    });
  }
}

/**
 * Execute Python code with captured stdout/stderr.
 * Call only after Pyodide is ready.
 */
export function runPython(code, { onOutput, onError } = {}) {
  if (!_pyodide) { onError?.("Pyodide not ready"); return; }

  try {
    _pyodide.runPython(`
import sys, io as _io
sys.stdout = _io.StringIO()
sys.stderr = _io.StringIO()
    `);
    _pyodide.runPython(code);
    const stdout = _pyodide.runPython("sys.stdout.getvalue()");
    const stderr = _pyodide.runPython("sys.stderr.getvalue()");
    onOutput?.(stdout, stderr);
  } catch (err) {
    onError?.(err.message ?? String(err));
  }
}


// ═══════════════════════════════════════════════════════════════
// 5. SESSION + FILE SYNC
// ═══════════════════════════════════════════════════════════════

/**
 * Save last code/file to users/{userId}/session.
 * @param {string} userId
 * @param {{ lastCode?: string, lastFile?: string }} data
 */
export async function saveSession(userId, data) {
  await setDoc(
    doc(db, `users/${userId}/session`),
    { ...data, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Save a file to users/{userId}/files/{fileId}.
 * @param {string} userId
 * @param {string} fileId  unique ID (e.g. crypto.randomUUID())
 * @param {string} name
 * @param {string} content
 */
export async function saveFile(userId, fileId, name, content) {
  await setDoc(
    doc(db, `users/${userId}/files/${fileId}`),
    { name, content, updatedAt: serverTimestamp() }
  );
}

/**
 * Listen to a user's file in real-time.
 * Returns unsubscribe.
 */
export function watchFile(userId, fileId, onChange) {
  return onSnapshot(
    doc(db, `users/${userId}/files/${fileId}`),
    (snap) => snap.exists() && onChange?.(snap.data())
  );
}

export { db, storage };
