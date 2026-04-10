import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../src/logging.js';
import { DeviceProfileManager } from '../src/fingerprint.js';

// ── Logger tests ──

describe('Logger', () => {
  it('emits log events with correct LogEntry structure', () => {
    const logger = new Logger('debug');
    const handler = vi.fn();
    logger.on('log', handler);

    logger.info('test message', { key: 'value' });

    expect(handler).toHaveBeenCalledOnce();
    const entry = handler.mock.calls[0][0];
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('level', 'info');
    expect(entry).toHaveProperty('message', 'test message');
    expect(entry).toHaveProperty('data');
    expect(entry.data).toEqual({ key: 'value' });
    // timestamp should be a valid ISO string
    expect(() => new Date(entry.timestamp)).not.toThrow();
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it('respects log level (debug messages not emitted when level is info)', () => {
    const logger = new Logger('info');
    const handler = vi.fn();
    logger.on('log', handler);

    logger.debug('should be suppressed');

    expect(handler).not.toHaveBeenCalled();
  });

  it('emits debug level when logger level is debug', () => {
    const logger = new Logger('debug');
    const handler = vi.fn();
    logger.on('log', handler);

    logger.debug('debug message');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].level).toBe('debug');
  });

  it('emits info level', () => {
    const logger = new Logger('info');
    const handler = vi.fn();
    logger.on('log', handler);

    logger.info('info message');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].level).toBe('info');
  });

  it('emits warn level', () => {
    const logger = new Logger('info');
    const handler = vi.fn();
    logger.on('log', handler);

    logger.warn('warn message');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].level).toBe('warn');
  });

  it('emits error level', () => {
    const logger = new Logger('info');
    const handler = vi.fn();
    logger.on('log', handler);

    logger.error('error message');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].level).toBe('error');
  });
});

// ── DeviceProfileManager tests ──

describe('DeviceProfileManager', () => {
  const manager = new DeviceProfileManager();

  it('getProfile("desktop-windows") returns a valid profile with all required fields', () => {
    const profile = manager.getProfile('desktop-windows');

    expect(profile.name).toBe('desktop-windows');
    expect(profile.userAgent).toBeTruthy();
    expect(profile.platform).toBeTruthy();
    expect(profile.hardwareConcurrency).toBeGreaterThan(0);
    expect(profile.deviceMemory).toBeGreaterThan(0);
    expect(profile.maxTouchPoints).toBeDefined();
    expect(profile.screenWidth).toBeGreaterThan(0);
    expect(profile.screenHeight).toBeGreaterThan(0);
    expect(profile.devicePixelRatio).toBeGreaterThan(0);
    expect(profile.colorDepth).toBeGreaterThan(0);
    expect(profile.vendor).toBeTruthy();
    expect(profile.renderer).toBeTruthy();
    expect(profile.webglVendor).toBeTruthy();
    expect(profile.webglRenderer).toBeTruthy();
    expect(profile.languages.length).toBeGreaterThan(0);
    expect(profile.plugins.length).toBeGreaterThan(0);
    expect(profile.fonts.length).toBeGreaterThan(0);
  });

  it('getProfile("desktop-macos") returns a different profile', () => {
    const win = manager.getProfile('desktop-windows');
    const mac = manager.getProfile('desktop-macos');

    expect(mac.name).toBe('desktop-macos');
    expect(mac.platform).not.toBe(win.platform);
    expect(mac.userAgent).not.toBe(win.userAgent);
  });

  it('getProfile("desktop-linux") returns a valid profile', () => {
    const profile = manager.getProfile('desktop-linux');

    expect(profile.name).toBe('desktop-linux');
    expect(profile.userAgent).toBeTruthy();
    expect(profile.platform).toBeTruthy();
    expect(profile.fonts.length).toBeGreaterThan(0);
  });

  it('listProfiles() returns at least 3 profiles', () => {
    const profiles = manager.listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    expect(profiles).toContain('desktop-windows');
    expect(profiles).toContain('desktop-macos');
    expect(profiles).toContain('desktop-linux');
  });

  it('randomizeProfile() returns a profile with same OS but potentially different UA', () => {
    const base = manager.getProfile('desktop-windows');
    const randomized = manager.randomizeProfile('desktop-windows');

    // Same platform (OS identifier stays)
    expect(randomized.platform).toBe(base.platform);
    // UA should still be a Windows UA
    expect(randomized.userAgent).toContain('Windows');
    // Name stays the same
    expect(randomized.name).toBe('desktop-windows');
  });

  it('unknown profile name throws', () => {
    expect(() => manager.getProfile('nonexistent-profile')).toThrow(
      /Unknown device profile/,
    );
  });
});

// ── Fingerprint consistency ──

describe('fingerprint consistency', () => {
  const manager = new DeviceProfileManager();

  it('Windows profile has Windows-matching UA, platform, fonts', () => {
    const profile = manager.getProfile('desktop-windows');

    expect(profile.userAgent).toContain('Windows');
    expect(profile.platform).toBe('Win32');
    // Windows-specific fonts
    expect(profile.fonts).toContain('Segoe UI');
    expect(profile.fonts).toContain('Calibri');
  });

  it('macOS profile has macOS-matching UA, platform, fonts', () => {
    const profile = manager.getProfile('desktop-macos');

    expect(profile.userAgent).toContain('Macintosh');
    expect(profile.platform).toBe('MacIntel');
    // macOS-specific fonts
    expect(profile.fonts).toContain('Helvetica Neue');
    expect(profile.fonts).toContain('San Francisco');
  });

  it('Linux profile has Linux-matching UA, platform, fonts', () => {
    const profile = manager.getProfile('desktop-linux');

    expect(profile.userAgent).toContain('Linux');
    expect(profile.platform).toBe('Linux x86_64');
    // Linux-specific fonts
    expect(profile.fonts).toContain('DejaVu Sans');
    expect(profile.fonts).toContain('Ubuntu');
  });

  it('all profiles have valid WebGL vendor/renderer strings', () => {
    const names = manager.listProfiles();

    for (const name of names) {
      const profile = manager.getProfile(name);
      expect(profile.webglVendor).toBeTruthy();
      expect(profile.webglVendor.length).toBeGreaterThan(0);
      expect(profile.webglRenderer).toBeTruthy();
      expect(profile.webglRenderer.length).toBeGreaterThan(0);
      // WebGL vendor should look realistic (contain a known GPU vendor keyword)
      expect(profile.webglVendor).toMatch(/Google|NVIDIA|AMD|Intel|Apple/i);
    }
  });
});
