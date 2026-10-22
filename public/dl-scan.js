/* TradeAutoX — driver's-license scan check on the dealer signup form.
 *
 * The applicant points their phone camera at the PDF417 barcode on the
 * BACK of their driver's license (or picks a photo of it). ZXing decodes
 * the barcode entirely in the browser: the license image is never
 * uploaded or stored. Only the barcode's text payload (base64-wrapped so
 * form submission can't mangle its control characters) is placed in the
 * form's hidden #dl-payload field and sent with the application, where the
 * server parses it (lib/aamva.js) and pre-computes the approval checks
 * (name match, expiration) Louis sees next to the wholesale-license photo.
 * Scanning is optional — a dealer without a camera simply applies unscanned.
 */
(function (global) {
  'use strict';

  if (typeof document === 'undefined') return;

  function init() {
    var scanBtn = document.getElementById('dl-scan-btn');
    var overlay = document.getElementById('dl-scan-overlay');
    var payloadInput = document.getElementById('dl-payload');
    if (!scanBtn || !overlay || !payloadInput) return;

    var video = document.getElementById('dl-scan-video');
    var status = document.getElementById('dl-scan-status');
    var pageStatus = document.getElementById('dl-status');
    var fileInput = document.getElementById('dl-scan-file');
    var photoLabel = document.getElementById('dl-scan-photo-label');
    var closeBtn = document.getElementById('dl-scan-close');
    var cancelBtn = document.getElementById('dl-scan-cancel');
    var skipBox = document.getElementById('dl-skip');

    var reader = null;     // live PDF417 reader
    var controls = null;   // live scanner controls
    var generation = 0;    // invalidates stale async work after close
    var busy = false;

    function setStatus(msg) { status.textContent = msg; }

    function setBusy(on) {
      busy = on;
      if (fileInput) fileInput.disabled = on;
    }

    function makeReader() {
      if (!global.ZXingBrowser) return null;
      if (global.ZXingBrowser.BrowserPDF417Reader) {
        return new global.ZXingBrowser.BrowserPDF417Reader();
      }
      // Fallback: multi-format reader also decodes PDF417.
      if (global.ZXingBrowser.BrowserMultiFormatReader) {
        return new global.ZXingBrowser.BrowserMultiFormatReader();
      }
      return null;
    }

    // The raw barcode text rides to the server base64-encoded: HTML form
    // submission normalizes CR/LF inside plain text field values, which
    // would corrupt the AAMVA payload's byte offsets. Base64 is immune.
    function encodePayload(text) {
      var bin = '';
      for (var i = 0; i < text.length; i++) bin += String.fromCharCode(text.charCodeAt(i) & 0xff);
      return btoa(bin);
    }

    function acceptPayload(text) {
      payloadInput.value = encodePayload(String(text || ''));
      closeScanner();
      if (pageStatus) {
        pageStatus.textContent = '\u2713 License scanned \u2014 the details on the card will be checked against your application at approval.';
        pageStatus.className = 'alert ok small';
      }
      if (skipBox) skipBox.checked = false;
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
    }

    function closeScanner() {
      generation++;
      stopCamera();
      setBusy(false);
      overlay.hidden = true;
      document.body.style.overflow = '';
    }

    function cameraUnavailable() {
      video.style.display = 'none';
      setStatus('Camera isn\u2019t available here (no camera, permission denied, or the scanner library didn\u2019t load). ' +
        'You can still use a photo of the BACK of your license below \u2014 or skip the scan and we\u2019ll verify at approval.');
    }

    async function startCamera() {
      if (!global.ZXingBrowser || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        cameraUnavailable();
        return;
      }
      setStatus('Starting camera\u2026');
      try {
        reader = reader || makeReader();
        if (!reader) { cameraUnavailable(); return; }
        controls = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: 'environment' } },
          video,
          function (result) {
            if (result && !busy) {
              var text = result.getText();
              if (text && text.indexOf('ANSI ') >= 0) acceptPayload(text);
            }
          }
        );
        // Closed while the camera was starting: stop what we just started.
        if (overlay.hidden) { stopCamera(); return; }
        setStatus('Scanning\u2026 hold the barcode on the BACK of your license flat in the frame, in good light. ' +
          'PDF417 is dense \u2014 give it a few seconds. No luck? Use a photo instead.');
      } catch (e) {
        cameraUnavailable();
      }
    }

    function openScanner() {
      generation++;
      video.style.display = '';
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      startCamera();
    }

    /* ----- Still photo: decode the PDF417 out of an image file ----- */

    function blobToImage(blob) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { resolve({ img: img, url: url }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
        img.src = url;
      });
    }

    async function processPhoto(file) {
      var gen = generation;
      setBusy(true);
      setStatus('Reading the photo\u2026 looking for the license barcode.');
      try {
        var loaded = await blobToImage(file);
        var stillReader = makeReader();
        var text = null;
        if (stillReader) {
          try {
            var result = await stillReader.decodeFromImageElement(loaded.img);
            if (result) text = result.getText();
          } catch (e) { /* no readable barcode in the still */ }
        }
        URL.revokeObjectURL(loaded.url);
        if (gen !== generation) return; // closed meanwhile
        if (text && text.indexOf('ANSI ') >= 0) {
          acceptPayload(text);
        } else {
          failToPage('That photo didn\u2019t show a readable license barcode \u2014 try again in good light, ' +
            'or skip the scan and we\u2019ll verify at approval.');
        }
      } catch (e) {
        if (gen === generation) {
          failToPage('Couldn\u2019t read that photo \u2014 you can skip the scan and we\u2019ll verify at approval.');
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

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // allow re-picking the same file later
      if (file) processPhoto(file);
    });
    if (photoLabel) photoLabel.addEventListener('click', function () { /* label natively opens the file input */ });

    if (skipBox) {
      skipBox.addEventListener('change', function () {
        if (skipBox.checked) {
          payloadInput.value = '';
          if (pageStatus) {
            pageStatus.textContent = 'No scan \u2014 your license will be verified at approval instead.';
            pageStatus.className = 'muted small';
          }
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
