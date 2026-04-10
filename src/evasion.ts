import type { DeviceProfile } from './types';

// ── Helper: wrap code in a self-contained IIFE ──

function iife(body: string): string {
  return `(function(){${body}})();`;
}

// ── 1. Navigator overrides ──

function navigatorOverrides(profile: DeviceProfile): string {
  return iife(`
    // Delete navigator.webdriver — make it undefined like a real browser
    try {
      const nd = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
      if (nd) {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: function() { return undefined; },
          configurable: false,
          enumerable: true,
        });
      }
    } catch(e) {}

    // Override navigator properties to match profile
    var overrides = {
      hardwareConcurrency: ${profile.hardwareConcurrency},
      deviceMemory: ${profile.deviceMemory},
      maxTouchPoints: ${profile.maxTouchPoints},
      platform: ${JSON.stringify(profile.platform)},
      vendor: ${JSON.stringify(profile.vendor)},
      languages: Object.freeze(${JSON.stringify(profile.languages)}),
      language: ${JSON.stringify(profile.languages[0] || 'en-US')},
    };

    for (var key in overrides) {
      try {
        Object.defineProperty(Navigator.prototype, key, {
          get: function(val) { return function() { return val; }; }(overrides[key]),
          configurable: false,
          enumerable: true,
        });
      } catch(e) {}
    }

    // Also override userAgent, appVersion on Navigator.prototype
    try {
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: function() { return ${JSON.stringify(profile.userAgent)}; },
        configurable: false,
        enumerable: true,
      });
    } catch(e) {}

    try {
      // appVersion is userAgent minus "Mozilla/"
      var appVer = ${JSON.stringify(profile.userAgent.replace('Mozilla/', ''))};
      Object.defineProperty(Navigator.prototype, 'appVersion', {
        get: function() { return appVer; },
        configurable: false,
        enumerable: true,
      });
    } catch(e) {}
  `);
}

// ── 2. Chrome runtime ──

function chromeRuntime(): string {
  return iife(`
    if (!window.chrome) {
      window.chrome = {};
    }

    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function(extensionId, connectInfo) {
          // Match Chrome's signature: returns a Port-like object
          return {
            name: (connectInfo && connectInfo.name) || '',
            postMessage: function() {},
            disconnect: function() {},
            onMessage: { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } },
            onDisconnect: { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } },
          };
        },
        sendMessage: function(extensionId, message, options, responseCallback) {
          // Chrome throws if no callback and no runtime ID
          if (typeof responseCallback === 'function') {
            setTimeout(function() { responseCallback(undefined); }, 0);
          } else if (typeof options === 'function') {
            setTimeout(function() { options(undefined); }, 0);
          }
        },
        id: undefined,
        getManifest: function() { return {}; },
        getURL: function(path) { return ''; },
        onConnect: { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } },
        onMessage: { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } },
      };
    }

    // chrome.loadTimes
    if (!window.chrome.loadTimes) {
      var startTime = Date.now() / 1000;
      window.chrome.loadTimes = function() {
        return {
          commitLoadTime: startTime,
          connectionInfo: 'h2',
          finishDocumentLoadTime: startTime + 0.3,
          finishLoadTime: startTime + 0.6,
          firstPaintAfterLoadTime: startTime + 0.65,
          firstPaintTime: startTime + 0.35,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: startTime - 0.1,
          startLoadTime: startTime,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      };
    }

    // chrome.csi
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return {
          onloadT: Date.now(),
          pageT: performance.now(),
          startE: Date.now() - performance.now(),
          tran: 15, // Navigation type: normal
        };
      };
    }

    // Make chrome non-writable to prevent overwrite detection
    try {
      Object.defineProperty(window, 'chrome', {
        value: window.chrome,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch(e) {}
  `);
}

// ── 3. Plugins and MimeTypes ──

function pluginsAndMimeTypes(profile: DeviceProfile): string {
  const pluginsJson = JSON.stringify(profile.plugins);

  return iife(`
    var pluginData = ${pluginsJson};

    // Build MimeType and Plugin objects that pass instanceof checks
    var mimeTypes = [];
    var plugins = [];

    // We need to create objects whose prototype chains match the browser's native ones.
    // PluginArray, Plugin, MimeTypeArray, MimeType prototypes already exist in the DOM.

    for (var i = 0; i < pluginData.length; i++) {
      var pd = pluginData[i];
      var plugin = Object.create(Plugin.prototype);

      var pluginMimes = [];
      for (var j = 0; j < pd.mimeTypes.length; j++) {
        var md = pd.mimeTypes[j];
        var mime = Object.create(MimeType.prototype);
        Object.defineProperties(mime, {
          type:        { value: md.type,        enumerable: true },
          suffixes:    { value: md.suffixes,    enumerable: true },
          description: { value: md.description, enumerable: true },
          enabledPlugin: { value: plugin,       enumerable: true },
        });
        pluginMimes.push(mime);
        mimeTypes.push(mime);
      }

      Object.defineProperties(plugin, {
        name:        { value: pd.name,        enumerable: true },
        description: { value: pd.description, enumerable: true },
        filename:    { value: pd.filename,    enumerable: true },
        length:      { value: pluginMimes.length, enumerable: true },
      });

      // Index access and namedItem for plugin's mimeTypes
      for (var k = 0; k < pluginMimes.length; k++) {
        Object.defineProperty(plugin, k, { value: pluginMimes[k], enumerable: false });
      }
      plugin.item = function(idx) { return pluginMimes[idx] || null; };
      plugin.namedItem = function(name) {
        for (var m = 0; m < pluginMimes.length; m++) {
          if (pluginMimes[m].type === name) return pluginMimes[m];
        }
        return null;
      };
      // Symbol.iterator
      plugin[Symbol.iterator] = function() {
        var _i = 0; var _a = pluginMimes;
        return { next: function() { return _i < _a.length ? { value: _a[_i++], done: false } : { done: true }; } };
      };

      plugins.push(plugin);
    }

    // Build PluginArray
    var pluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(pluginArray, 'length', { value: plugins.length, enumerable: true });
    for (var p = 0; p < plugins.length; p++) {
      Object.defineProperty(pluginArray, p, { value: plugins[p], enumerable: false });
      // Name-based access
      Object.defineProperty(pluginArray, plugins[p].name, { value: plugins[p], enumerable: false });
    }
    pluginArray.item = function(idx) { return plugins[idx] || null; };
    pluginArray.namedItem = function(name) {
      for (var n = 0; n < plugins.length; n++) {
        if (plugins[n].name === name) return plugins[n];
      }
      return null;
    };
    pluginArray.refresh = function() {};
    pluginArray[Symbol.iterator] = function() {
      var _i = 0;
      return { next: function() { return _i < plugins.length ? { value: plugins[_i++], done: false } : { done: true }; } };
    };

    // Build MimeTypeArray
    var mimeTypeArray = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(mimeTypeArray, 'length', { value: mimeTypes.length, enumerable: true });
    for (var q = 0; q < mimeTypes.length; q++) {
      Object.defineProperty(mimeTypeArray, q, { value: mimeTypes[q], enumerable: false });
      Object.defineProperty(mimeTypeArray, mimeTypes[q].type, { value: mimeTypes[q], enumerable: false });
    }
    mimeTypeArray.item = function(idx) { return mimeTypes[idx] || null; };
    mimeTypeArray.namedItem = function(name) {
      for (var r = 0; r < mimeTypes.length; r++) {
        if (mimeTypes[r].type === name) return mimeTypes[r];
      }
      return null;
    };
    mimeTypeArray[Symbol.iterator] = function() {
      var _i = 0;
      return { next: function() { return _i < mimeTypes.length ? { value: mimeTypes[_i++], done: false } : { done: true }; } };
    };

    // Override navigator.plugins and navigator.mimeTypes
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: function() { return pluginArray; },
      configurable: false,
      enumerable: true,
    });
    Object.defineProperty(Navigator.prototype, 'mimeTypes', {
      get: function() { return mimeTypeArray; },
      configurable: false,
      enumerable: true,
    });
  `);
}

// ── 4. Permissions override ──

function permissionsOverride(): string {
  return iife(`
    var originalQuery = Permissions.prototype.query;
    Permissions.prototype.query = function(permissionDesc) {
      // Notification permission: headless returns 'denied', real Chrome returns 'prompt'
      if (permissionDesc && permissionDesc.name === 'notifications') {
        return Promise.resolve({
          state: 'prompt',
          name: 'notifications',
          onchange: null,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; },
        });
      }
      // For all other permissions, delegate to the original implementation
      return originalQuery.call(this, permissionDesc);
    };
  `);
}

// ── 5. WebGL override ──

function webglOverride(profile: DeviceProfile): string {
  return iife(`
    var VENDOR = ${JSON.stringify(profile.webglVendor)};
    var RENDERER = ${JSON.stringify(profile.webglRenderer)};

    // Constants for WEBGL_debug_renderer_info
    var UNMASKED_VENDOR_WEBGL = 0x9245;
    var UNMASKED_RENDERER_WEBGL = 0x9246;

    // Hook getParameter on both WebGL contexts
    var contexts = ['WebGLRenderingContext', 'WebGL2RenderingContext'];
    for (var c = 0; c < contexts.length; c++) {
      var ctx = window[contexts[c]];
      if (!ctx || !ctx.prototype) continue;

      var origGetParameter = ctx.prototype.getParameter;
      ctx.prototype.getParameter = (function(orig) {
        return function(param) {
          if (param === UNMASKED_VENDOR_WEBGL) return VENDOR;
          if (param === UNMASKED_RENDERER_WEBGL) return RENDERER;
          // Also override VENDOR and RENDERER base params
          if (param === 0x1F00) return VENDOR; // gl.VENDOR
          if (param === 0x1F01) return RENDERER; // gl.RENDERER
          return orig.call(this, param);
        };
      })(origGetParameter);

      // Hook getExtension to ensure WEBGL_debug_renderer_info is available
      // and returns consistent values
      var origGetExtension = ctx.prototype.getExtension;
      ctx.prototype.getExtension = (function(orig) {
        return function(name) {
          var ext = orig.call(this, name);
          if (name === 'WEBGL_debug_renderer_info') {
            // If extension is null (as in some headless modes), create a shim
            if (!ext) {
              ext = {
                UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR_WEBGL,
                UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER_WEBGL,
              };
            }
            return ext;
          }
          return ext;
        };
      })(origGetExtension);
    }
  `);
}

// ── 6. Canvas noise ──

function canvasNoise(profile: DeviceProfile): string {
  // Generate a deterministic seed from the profile name
  let seed = 0;
  for (let i = 0; i < profile.name.length; i++) {
    seed = ((seed << 5) - seed + profile.name.charCodeAt(i)) | 0;
  }

  return iife(`
    // Simple seeded PRNG (mulberry32)
    var seed = ${seed >>> 0};
    function prng() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    // Inject subtle noise into ImageData
    function addNoise(imageData) {
      var data = imageData.data;
      // Only perturb a small fraction of pixels for subtlety
      for (var i = 0; i < data.length; i += 4) {
        // Perturb ~2% of pixels
        if (prng() < 0.02) {
          // Pick a random channel (R, G, or B — skip alpha)
          var channel = (prng() * 3) | 0;
          var delta = prng() < 0.5 ? -1 : 1;
          var val = data[i + channel] + delta;
          if (val < 0) val = 0;
          if (val > 255) val = 255;
          data[i + channel] = val;
        }
      }
      return imageData;
    }

    // Hook toDataURL
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var imageData = ctx.getImageData(0, 0, this.width, this.height);
          addNoise(imageData);
          ctx.putImageData(imageData, 0, 0);
        } catch(e) {
          // Canvas may be tainted (cross-origin) — silently skip
        }
      }
      return origToDataURL.apply(this, arguments);
    };

    // Hook toBlob
    var origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function() {
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var imageData = ctx.getImageData(0, 0, this.width, this.height);
          addNoise(imageData);
          ctx.putImageData(imageData, 0, 0);
        } catch(e) {}
      }
      return origToBlob.apply(this, arguments);
    };
  `);
}

// ── 7. AudioContext override ──
//
// Adds subtle noise to audio fingerprinting methods (getFloatFrequencyData,
// OfflineAudioContext.startRendering) so the audio fingerprint isn't a
// deterministic device-wide identifier. The noise is seeded by the device
// profile name so it's consistent across sessions for the same profile —
// a real human's audio fingerprint is stable, not random.

function audioContextOverride(profile: DeviceProfile): string {
  // Derive a seed from the profile name. Same seed → same PRNG stream →
  // same audio fingerprint across sessions. Using Math.random() here (the
  // pre-v2 behavior) would have made the fingerprint drift every session,
  // which is itself a detectable "this user looks different every time" signal.
  let seed = 0;
  for (let i = 0; i < profile.name.length; i++) {
    seed = ((seed << 5) - seed + profile.name.charCodeAt(i)) | 0;
  }

  return iife(`
    // Mulberry32 PRNG seeded from profile.name — matches the canvas noise
    // seeding approach so a given profile has a stable audio + canvas pair.
    var audioSeed = ${seed >>> 0};
    function audioPrng() {
      audioSeed |= 0; audioSeed = audioSeed + 0x6D2B79F5 | 0;
      var t = Math.imul(audioSeed ^ audioSeed >>> 15, 1 | audioSeed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    if (typeof AnalyserNode !== 'undefined') {
      var origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        origGetFloat.call(this, array);
        for (var i = 0; i < array.length; i++) {
          // Seeded noise, ~0.0001 magnitude — imperceptible to real audio
          // use but breaks deterministic fingerprinting.
          array[i] = array[i] + (audioPrng() * 0.0002 - 0.0001);
        }
      };
    }

    if (typeof OfflineAudioContext !== 'undefined') {
      var origOfflineRender = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return origOfflineRender.call(this).then(function(buffer) {
          for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
            var data = buffer.getChannelData(ch);
            for (var i = 0; i < data.length; i++) {
              data[i] = data[i] + (audioPrng() * 0.0001 - 0.00005);
            }
          }
          return buffer;
        });
      };
    }
  `);
}

// ── Public API ──

/**
 * Generate all evasion scripts for a given device profile.
 * Each script is a self-contained IIFE ready to be injected via
 * `Page.addScriptToEvaluateOnNewDocument()`.
 */
/**
 * Evasion script generator. With BlackTip v2 running on real Chrome
 * (`channel: 'chrome'`) + patchright's CDP-level stealth patches, most of
 * the original JS-shim evasion is unnecessary and some of it was actively
 * creating signals (see L012 in planning/lessons.md for the chrome.runtime
 * and launch-flag story).
 *
 * What we keep:
 *   - canvasNoise: privacy/anti-tracking, adds plausible noise to canvas
 *     rendering so we don't get a stable device-wide fingerprint.
 *   - audioContextOverride: same story for audio fingerprint.
 *
 * What we removed (and why):
 *   - chromeRuntime: real Chrome doesn't expose `chrome.runtime` on regular
 *     pages — only on extension-accessible contexts. Our shim was adding
 *     it everywhere, which CreepJS catches as `hasBadChromeRuntime: true`.
 *     Let patchright + real Chrome handle `window.chrome` naturally.
 *   - navigatorOverrides: real Chrome's navigator is already correct when
 *     we use `channel: 'chrome'`. Overriding with profile values creates
 *     mismatches (e.g., profile says hardwareConcurrency=8 but the actual
 *     CPU has 16, and other APIs like Performance.now timing can reveal
 *     the truth).
 *   - pluginsAndMimeTypes: real Chrome populates navigator.plugins with
 *     the real PDF viewer plugin. Our shim was adding fake plugins that
 *     didn't match.
 *   - permissionsOverride: real Chrome already returns 'prompt' for
 *     notifications on most states. Shim only needed on headless Chromium.
 *   - webglOverride: real Chrome reports the real GPU through ANGLE. Our
 *     shim was replacing AMD Radeon with a profile string, making the
 *     fingerprint inconsistent with the real DirectX pipeline signals.
 */
export function generateEvasionScripts(profile: DeviceProfile): string[] {
  return [
    canvasNoise(profile),
    audioContextOverride(profile),
  ];
}
