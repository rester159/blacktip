/**
 * Session snapshot/restore.
 *
 * Serializes the cookies, localStorage, sessionStorage, and current URL
 * of a BlackTip session into a JSON blob. `restore` applies the snapshot
 * to a BlackTip instance so you can:
 *
 *   - Migrate a logged-in session from one proxy to another.
 *   - Promote a known-good session to a new BlackTip instance if the
 *     current one crashes.
 *   - Park a session overnight and resume tomorrow without re-logging in.
 *
 * NOT yet serialized: IndexedDB contents, Service Worker state, Cache
 * Storage. Those are non-trivial and worth a future addition once a
 * real target needs them (most auth sessions use cookies + localStorage,
 * which is what we cover here).
 */

import type { BrowserCore } from './browser-core.js';

export interface SessionSnapshot {
  /** Schema version — bump on incompatible changes. */
  version: 1;
  /** Timestamp of when the snapshot was taken. */
  capturedAt: string;
  /** The URL the active page was on at capture time. */
  url: string;
  /** Browser cookies as a flat array of {name, value, domain, path, ...}. */
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Lax' | 'None' | 'Strict';
  }>;
  /** localStorage keyed by origin. */
  localStorageByOrigin: Record<string, Record<string, string>>;
  /** sessionStorage keyed by origin. */
  sessionStorageByOrigin: Record<string, Record<string, string>>;
  /** Optional user label. */
  label?: string;
}

export class SnapshotManager {
  constructor(private core: BrowserCore) {}

  /**
   * Capture the current session state. Reads cookies from the browser
   * context and storage from the active page via evaluate.
   */
  async capture(label?: string): Promise<SessionSnapshot> {
    const page = this.core.getActivePage();
    const url = page.url();

    const cookies = await this.core.cookies();

    // Storage must be read in-page. sessionStorage is per-origin and only
    // reachable when we're on that origin. For multi-origin sessions the
    // caller would need to navigate to each origin and call capture
    // incrementally — this single-shot version covers the active origin.
    const storageRaw = (await this.core.executeJS(`(() => {
      const originKey = location.origin;
      const readStorage = (store) => {
        const out = {};
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k != null) out[k] = store.getItem(k) ?? '';
        }
        return out;
      };
      return {
        origin: originKey,
        local: readStorage(localStorage),
        session: readStorage(sessionStorage),
      };
    })()`)) as { origin: string; local: Record<string, string>; session: Record<string, string> };

    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      url,
      cookies: cookies as SessionSnapshot['cookies'],
      localStorageByOrigin: { [storageRaw.origin]: storageRaw.local },
      sessionStorageByOrigin: { [storageRaw.origin]: storageRaw.session },
      label,
    };
  }

  /**
   * Apply a snapshot to the current BlackTip session. Sets cookies,
   * navigates to the captured URL, then writes localStorage and
   * sessionStorage for the origin.
   */
  async restore(snapshot: SessionSnapshot): Promise<void> {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
    }

    // Cookies first — they need to be in place before navigation so the
    // page request carries them.
    if (snapshot.cookies.length > 0) {
      await this.core.setCookies(snapshot.cookies);
    }

    // Navigate to the captured URL.
    if (snapshot.url) {
      await this.core.navigate(snapshot.url, { waitUntil: 'domcontentloaded' });
    }

    // Write storage for each origin. The active page is now on one
    // origin; we can only write to that origin's storage from here.
    const page = this.core.getActivePage();
    const currentOrigin = new URL(page.url()).origin;
    const local = snapshot.localStorageByOrigin[currentOrigin] ?? {};
    const session = snapshot.sessionStorageByOrigin[currentOrigin] ?? {};

    await this.core.executeJS(`((localKv, sessionKv) => {
      for (const [k, v] of Object.entries(localKv)) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(sessionKv)) sessionStorage.setItem(k, v);
    })(${JSON.stringify(local)}, ${JSON.stringify(session)})`);
  }
}
