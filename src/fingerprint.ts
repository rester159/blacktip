import type { DeviceProfile, PluginData } from './types';

// ── Shared plugin data (Chrome on all platforms) ──

const chromePlugins: PluginData[] = [
  {
    name: 'Chrome PDF Plugin',
    description: 'Portable Document Format',
    filename: 'internal-pdf-viewer',
    mimeTypes: [
      { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ],
  },
  {
    name: 'Chrome PDF Viewer',
    description: '',
    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    mimeTypes: [
      { type: 'application/pdf', suffixes: 'pdf', description: '' },
    ],
  },
  {
    name: 'Native Client',
    description: '',
    filename: 'internal-nacl-plugin',
    mimeTypes: [
      { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
      { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
    ],
  },
];

// ── UA pools per OS ──

const windowsUAs = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

const macosUAs = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

const linuxUAs = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

// ── Pre-configured profiles ──

const desktopWindows: DeviceProfile = {
  name: 'desktop-windows',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  platform: 'Win32',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 1,
  colorDepth: 24,
  vendor: 'Google Inc.',
  renderer: 'Google Inc. (NVIDIA)',
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
  languages: ['en-US', 'en'],
  plugins: chromePlugins,
  fonts: [
    'Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New',
    'Georgia', 'Impact', 'Lucida Console', 'Segoe UI', 'Tahoma',
    'Times New Roman', 'Trebuchet MS', 'Verdana',
  ],
};

const desktopMacos: DeviceProfile = {
  name: 'desktop-macos',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  hardwareConcurrency: 8,
  deviceMemory: 16,
  maxTouchPoints: 0,
  screenWidth: 2560,
  screenHeight: 1440,
  devicePixelRatio: 2,
  colorDepth: 30,
  vendor: 'Google Inc.',
  renderer: 'Google Inc. (Apple)',
  webglVendor: 'Google Inc. (Apple)',
  webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
  languages: ['en-US', 'en'],
  plugins: chromePlugins,
  fonts: [
    'Arial', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue',
    'Lucida Grande', 'Menlo', 'Monaco', 'San Francisco', 'Times New Roman',
    'Verdana',
  ],
};

const desktopLinux: DeviceProfile = {
  name: 'desktop-linux',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  platform: 'Linux x86_64',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  maxTouchPoints: 0,
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 1,
  colorDepth: 24,
  vendor: 'Google Inc.',
  renderer: 'Google Inc. (Intel)',
  webglVendor: 'Google Inc. (Intel)',
  webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)',
  languages: ['en-US', 'en'],
  plugins: chromePlugins,
  fonts: [
    'Arial', 'Courier New', 'DejaVu Sans', 'DejaVu Sans Mono', 'FreeMono',
    'FreeSans', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif',
    'Noto Sans', 'Times New Roman', 'Ubuntu',
  ],
};

// ── UA pool lookup by profile name ──

const uaPoolByProfile: Record<string, string[]> = {
  'desktop-windows': windowsUAs,
  'desktop-macos': macosUAs,
  'desktop-linux': linuxUAs,
};

// ── DeviceProfileManager ──

export class DeviceProfileManager {
  private profiles: Map<string, DeviceProfile>;

  constructor() {
    this.profiles = new Map<string, DeviceProfile>();
    this.profiles.set('desktop-windows', desktopWindows);
    this.profiles.set('desktop-macos', desktopMacos);
    this.profiles.set('desktop-linux', desktopLinux);
  }

  getProfile(name: string): DeviceProfile {
    const profile = this.profiles.get(name);
    if (!profile) {
      throw new Error(`Unknown device profile: "${name}". Available: ${this.listProfiles().join(', ')}`);
    }
    return { ...profile, plugins: profile.plugins.map(p => ({ ...p, mimeTypes: [...p.mimeTypes] })), fonts: [...profile.fonts], languages: [...profile.languages] };
  }

  listProfiles(): string[] {
    return Array.from(this.profiles.keys());
  }

  addProfile(name: string, profile: DeviceProfile): void {
    this.profiles.set(name, profile);
  }

  /**
   * Generate a slightly randomized variant of a named profile.
   *
   * Randomization:
   *  - Picks a random UA string from a small pool for the same OS
   *  - Varies hardwareConcurrency by +/-2 (min 2)
   *  - Picks a random realistic deviceMemory (4, 8, or 16)
   *  - Everything else (GPU, fonts, plugins, platform) stays consistent
   */
  randomizeProfile(name: string): DeviceProfile {
    const base = this.getProfile(name); // already a shallow clone

    // Pick a random UA from the pool (fall back to base UA if no pool)
    const uaPool = uaPoolByProfile[name];
    if (uaPool && uaPool.length > 0) {
      base.userAgent = uaPool[Math.floor(Math.random() * uaPool.length)];
    }

    // Vary hardwareConcurrency by +/-2, min 2
    const delta = Math.floor(Math.random() * 5) - 2; // -2..+2
    base.hardwareConcurrency = Math.max(2, base.hardwareConcurrency + delta);

    // Pick a random realistic deviceMemory
    const memoryOptions = [4, 8, 16];
    base.deviceMemory = memoryOptions[Math.floor(Math.random() * memoryOptions.length)];

    return base;
  }
}
