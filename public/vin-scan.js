/* TradeAutoX — VIN camera scanner.
 *
 * Adds camera VIN capture next to the 17-digit VIN field on the listing and
 * auction create forms:
 *   1. Live barcode scan (ZXing browser build, CDN) — door-jamb VIN stickers
 *      carry the VIN as a Code 39 barcode.
 *   2. Photo fallback — snap a frame or pick a photo of the windshield VIN
 *      plate; try a barcode decode on the still, then OCR (Tesseract.js, CDN)
 *      and extract the best 17-char VIN-pattern match.
 * On success the VIN is written into the existing #vin-input and real
 * input/change events are fired, so the page's own debounced auto-decode
 * (NHTSA vPIC autofill) runs exactly as if the dealer had typed it.
 * Manual typing is never touched.
 */
(function (global) {
  'use strict';

  /* ---------- Pure helpers (unit-testable) ---------- */

  // 17 chars, letters except I/O/Q, plus digits.
  var VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

  function cleanVin(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function isValidVin(v) {
    return typeof v === 'string' && VIN_RE.test(v);
  }

  // Find an exact VIN-pattern window inside an already-cleaned string
  // (barcodes sometimes carry extra prefix/suffix characters).
  function findVinInCleaned(cleaned) {
    if (!cleaned || cleaned.length < 17) return null;
    if (cleaned.length === 17) return VIN_RE.test(cleaned) ? cleaned : null;
    for (var i = 0; i + 17 <= cleaned.length; i++) {
      var w = cleaned.substr(i, 17);
      if (VIN_RE.test(w)) return w;
    }
    return null;
  }

  // OCR misreads the three letters a VIN can never contain: O->0, I->1, Q->0.
  function fixOcrChars(win) {
    return win.replace(/O/g, '0').replace(/I/g, '1').replace(/Q/g, '0');
  }

  // North American VIN check digit (position 9): transliterate, weight,
  // mod 11. A random string of VIN-legal characters passes only ~1 time in
  // 11, which makes this the strong filter against OCR false positives.
  var VIN_VALUES = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  var VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  function vinCheckDigitOk(v) {
    if (!isValidVin(v)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) {
      var ch = v.charAt(i);
      var val = (ch >= '0' && ch <= '9') ? ch.charCodeAt(0) - 48 : VIN_VALUES[ch];
      if (val == null) return false;
      sum += val * VIN_WEIGHTS[i];
    }
    var rem = sum % 11;
    return v.charAt(8) === (rem === 10 ? 'X' : String(rem));
  }

  // Best 17-char VIN match in OCR text. Candidates are tiered:
  //   tier 0 — pattern match whose check digit validates (trustworthy even
  //            inside a longer line of text);
  //   tier 1 — the OCR source was exactly one clean 17-char token (a digit
  //            misread as a look-alike legal letter can fail the check digit
  //            yet still be a real VIN worth showing for confirmation);
  //   anything else (e.g. windows spanning merged words) is discarded.
  // Within a tier, fewest O/I/Q corrections wins.
  function extractVinFromText(text) {
    if (!text) return null;
    var raw = String(text).toUpperCase();
    var sources = [];
    raw.split(/\r?\n/).forEach(function (line) {
      var c = cleanVin(line);
      if (c.length >= 17) sources.push(c);
    });
    var whole = cleanVin(raw);
    if (whole.length >= 17) sources.push(whole);

    var best = null;
    function consider(vin, corrections, sourceLen) {
      var checkOk = vinCheckDigitOk(vin);
      var tier = checkOk ? 0 : (sourceLen === 17 && corrections <= 1 ? 1 : -1);
      if (tier < 0) return;
      if (!best || tier < best.tier || (tier === best.tier && corrections < best.corrections)) {
        best = { vin: vin, corrections: corrections, tier: tier, checkDigit: checkOk };
      }
    }

    for (var s = 0; s < sources.length; s++) {
      var str = sources[s];
      for (var i = 0; i + 17 <= str.length; i++) {
        var win = str.substr(i, 17);
        if (VIN_RE.test(win)) {
          consider(win, 0, str.length);
        } else {
          var fixed = fixOcrChars(win);
          if (fixed !== win && VIN_RE.test(fixed)) {
            var corr = 0;
            for (var j = 0; j < 17; j++) if (win.charAt(j) !== fixed.charAt(j)) corr++;
            consider(fixed, corr, str.length);
          }
        }
      }
    }
    if (!best) return null;
    return { vin: best.vin, corrections: best.corrections, checkDigit: best.checkDigit };
  }

  var api = {
    cleanVin: cleanVin,
    isValidVin: isValidVin,
    findVinInCleaned: findVinInCleaned,
    vinCheckDigitOk: vinCheckDigitOk,
    extractVinFromText: extractVinFromText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.VinScan = api;

  /* ---------- Browser wiring ---------- */
  if (typeof document === 'undefined') return;

  function init() {
    var input = document.getElementById('vin-input') || document.querySelector('input[name="vin"]');
    var scanBtn = document.getElementById('vin-scan-btn');
    var overlay = document.getElementById('vin-scan-overlay');
    if (!input || !scanBtn || !overlay) return;

    var video = document.getElementById('vin-scan-video');
    var status = document.getElementById('vin-scan-status');
    var confirmBox = document.getElementById('vin-scan-confirm');
    var foundEl = document.getElementById('vin-scan-found');
    var useBtn = document.getElementById('vin-scan-use');
    var retryBtn = document.getElementById('vin-scan-retry');
    var mainActions = document.getElementById('vin-scan-main-actions');
    var snapBtn = document.getElementById('vin-scan-snap');
    var fileInput = document.getElementById('vin-scan-file');
    var closeBtn = document.getElementById('vin-scan-close');
    var cancelBtn = document.getElementById('vin-scan-cancel');
    var pageStatus = document.getElementById('vin-status');

    var reader = null;        // live barcode reader
    var controls = null;      // live scanner controls
    var cameraLive = false;
    var generation = 0;       // invalidates stale async work after close
    var pendingVin = null;    // OCR result awaiting confirmation
    var busy = false;

    function setStatus(msg) { status.textContent = msg; }

    function setBusy(on) {
      busy = on;
      [snapBtn, useBtn, retryBtn].forEach(function (b) { if (b) b.disabled = on; });
      if (fileInput) fileInput.disabled = on;
    }

    function fillVin(vin) {
      input.value = vin;
      // Fire the same events a typist produces: the page's debounced input
      // handler sees a full 17-char VIN and runs its existing vPIC decode.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }

    function succeed(vin) {
      closeScanner();
      fillVin(vin);
    }

    function failToPage(msg) {
      closeScanner();
      if (pageStatus) {
        pageStatus.textContent = msg;
        pageStatus.className = 'alert error small';
      }
    }

    function stopCamera() {
      if (controls) {
        try { controls.stop(); } catch (e) { /* already stopped */ }
        controls = null;
      }
      if (video.srcObject) {
        try {
          video.srcObject.getTracks().forEach(function (t) { t.stop(); });
        } catch (e) { /* ignore */ }
        video.srcObject = null;
      }
      cameraLive = false;
    }

    function closeScanner() {
      generation++;
      stopCamera();
      setBusy(false);
      pendingVin = null;
      overlay.hidden = true;
      document.body.style.overflow = '';
    }

    function cameraUnavailable() {
      cameraLive = false;
      video.style.display = 'none';
      snapBtn.style.display = 'none';
      setStatus('Camera isn\u2019t available here (no camera, permission denied, or the scanner library didn\u2019t load). ' +
        'You can still use a photo of the VIN plate below \u2014 or cancel and type the VIN in.');
    }

    async function startCamera() {
      if (!global.ZXingBrowser || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        cameraUnavailable();
        return;
      }
      setStatus('Starting camera\u2026 point it at the VIN barcode on the door jamb or the plate at the windshield.');
      try {
        reader = reader || new global.ZXingBrowser.BrowserMultiFormatReader();
        controls = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: 'environment' } },
          video,
          function (result) {
            if (result && !busy) {
              var vin = findVinInCleaned(cleanVin(result.getText()));
              if (vin) succeed(vin);
            }
          }
        );
        // Closed while the camera was starting: stop what we just started.
        if (overlay.hidden) { stopCamera(); return; }
        cameraLive = true;
        setStatus('Scanning\u2026 hold the VIN barcode in the frame. No barcode? Snap a photo of the plate instead.');
      } catch (e) {
        cameraUnavailable();
      }
    }

    function openScanner() {
      generation++;
      pendingVin = null;
      confirmBox.hidden = true;
      mainActions.hidden = false;
      video.style.display = '';
      snapBtn.style.display = '';
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      startCamera();
    }

    /* ----- Still-image pipeline: barcode first, OCR second ----- */

    function blobToImage(blob) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { resolve({ img: img, url: url }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
        img.src = url;
      });
    }

    async function tryBarcodeOnImage(img) {
      if (!global.ZXingBrowser) return null;
      try {
        var stillReader = new global.ZXingBrowser.BrowserMultiFormatReader();
        var result = await stillReader.decodeFromImageElement(img);
        if (result) return findVinInCleaned(cleanVin(result.getText()));
      } catch (e) { /* no barcode in the still — fall through to OCR */ }
      return null;
    }

    async function ocrImage(source) {
      if (!global.Tesseract) return null;
      var worker = await global.Tesseract.createWorker('eng');
      try {
        try {
          await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'
          });
        } catch (e) { /* whitelist is a nicety, not a requirement */ }
        var out = await worker.recognize(source);
        return out && out.data ? out.data.text : '';
      } finally {
        try { await worker.terminate(); } catch (e) { /* ignore */ }
      }
    }

    async function processStill(blob, canvas) {
      var gen = generation;
      setBusy(true);
      confirmBox.hidden = true;
      mainActions.hidden = false;
      setStatus('Reading the photo\u2026 looking for a barcode first.');
      try {
        var loaded = await blobToImage(blob);
        var vin = await tryBarcodeOnImage(loaded.img);
        URL.revokeObjectURL(loaded.url);
        if (gen !== generation) return; // closed meanwhile
        if (vin) { succeed(vin); return; }

        setStatus('No barcode in that photo \u2014 reading the VIN text instead. This can take a few seconds.');
        var text = await ocrImage(canvas || blob);
        if (gen !== generation) return;
        var found = extractVinFromText(text || '');
        if (found) {
          pendingVin = found.vin;
          foundEl.textContent = found.vin;
          confirmBox.hidden = false;
          mainActions.hidden = true;
          setStatus(!found.checkDigit
            ? 'Found a possible VIN, but its built-in check digit doesn\u2019t validate \u2014 compare it character by character with the plate before using it.'
            : found.corrections > 0
              ? 'Found a likely VIN (' + found.corrections + ' character' + (found.corrections === 1 ? '' : 's') + ' auto-corrected) \u2014 check it carefully before using it.'
              : 'Found a VIN in the photo \u2014 check it carefully before using it.');
        } else {
          failToPage('That photo didn\u2019t show a readable VIN \u2014 type the 17 characters in above.');
        }
      } catch (e) {
        if (gen === generation) {
          failToPage('Couldn\u2019t read that photo \u2014 type the 17-character VIN in above.');
        }
      } finally {
        if (gen === generation) setBusy(false);
      }
    }

    /* ----- Events ----- */

    scanBtn.addEventListener('click', openScanner);
    closeBtn.addEventListener('click', closeScanner);
    cancelBtn.addEventListener('click', closeScanner);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeScanner(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hidden) closeScanner();
    });

    snapBtn.addEventListener('click', function () {
      if (!cameraLive || !video.videoWidth) {
        setStatus('The camera isn\u2019t running \u2014 use a photo instead, or cancel and type the VIN.');
        return;
      }
      var canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (blob) processStill(blob, canvas);
      }, 'image/jpeg', 0.92);
    });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // allow re-picking the same file later
      if (file) processStill(file, null);
    });

    useBtn.addEventListener('click', function () {
      if (pendingVin) succeed(pendingVin);
    });

    retryBtn.addEventListener('click', function () {
      pendingVin = null;
      confirmBox.hidden = true;
      mainActions.hidden = false;
      setStatus(cameraLive
        ? 'Scanning\u2026 hold the VIN barcode in the frame, or snap another photo.'
        : 'Pick another photo of the VIN plate, or cancel and type the VIN.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
