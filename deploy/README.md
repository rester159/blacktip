# Deploying BlackTip on a server

BlackTip runs real Chrome in headful mode — on a server you use **Xvfb** (virtual X framebuffer) to give Chrome a "display" to render to without needing a physical monitor. This is the standard approach used by every serious stealth tool. Running Chrome with `--headless` is NOT supported because headless mode is detectable at many fingerprint levels.

This guide covers:

- [Docker](#docker-quickstart) — one-command deploy, works on any host
- [systemd](#systemd-bare-metal-vps) — traditional Linux service, cheapest at scale
- [Cloud providers](#cloud-providers) — AWS, GCP, DigitalOcean, Hetzner, Fly.io
- [Sizing and cost](#sizing-and-cost)
- [Troubleshooting](#troubleshooting)

---

## Docker quickstart

The repo ships a production-ready `Dockerfile` at the root. It installs Chrome Stable, Xvfb, Node 20, all the runtime dependencies, and builds BlackTip.

```bash
# Clone or check out your BlackTip-consuming app
git clone https://github.com/rester159/blacktip.git
cd blacktip

# Build the image
docker build -t blacktip:latest .

# Run (TCP serve mode on port 9779)
docker run --rm -it \
  --shm-size=2gb \
  --cap-add=SYS_ADMIN \
  -p 9779:9779 \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/downloads:/home/blacktip/Downloads \
  blacktip:latest
```

Or use `docker compose` for a one-liner:

```bash
docker compose up --build
```

Send commands from the host:

```bash
# Install the CLI locally so you can send commands
npm install -g @rester159/blacktip

# Drive the running container's BlackTip instance
blacktip send "await bt.navigate('https://example.com')" --pretty
```

### Critical Docker flags

| Flag | Why |
|---|---|
| `--shm-size=2gb` | Chrome uses `/dev/shm` for IPC. Docker's default 64 MB crashes Chrome under any real load. |
| `--cap-add=SYS_ADMIN` | Chrome's sandbox needs this capability. Without it, Chrome runs with sandboxing disabled (less secure). |
| `-p 9779:9779` | Exposes the BlackTip TCP command server. Change if you're running multiple instances. |
| `-v ./downloads:/home/blacktip/Downloads` | Lets `bt.download()` writes escape the container to the host. |

### Extending the image for your own app

The default `CMD` runs BlackTip's generic serve mode. For your own app, extend the image:

```dockerfile
FROM blacktip:latest

WORKDIR /app
COPY --chown=blacktip:blacktip package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=blacktip:blacktip dist ./dist

# Override the default CMD to run your app instead of BlackTip's CLI
CMD ["/bin/sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & sleep 1 && exec node dist/server.js"]
```

Your app imports BlackTip as a normal npm dependency and launches sessions as needed — see the main README's "Wiring it up in your product" section.

---

## systemd (bare metal / VPS)

For long-running production on a dedicated VPS, systemd gives you lower overhead than Docker, better integration with logging (`journalctl`), and easier resource management via `MemoryMax` / `CPUQuota`. The repo ships two unit files in `deploy/systemd/`:

- `xvfb.service` — runs Xvfb on display `:99`
- `blacktip.service` — runs a BlackTip serve-mode instance depending on Xvfb

### Ubuntu / Debian setup

```bash
# 1. Install system dependencies
sudo apt-get update
sudo apt-get install -y \
  xvfb dbus dbus-x11 \
  ca-certificates curl wget gnupg \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libxss1 libasound2 libxshmfence1 \
  libgtk-3-0 libpango-1.0-0 libcairo2 libcups2 libu2f-udev libvulkan1 \
  fonts-liberation fonts-noto fonts-noto-cjk fonts-dejavu-core fonts-freefont-ttf

# 2. Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Install Chrome Stable (x86_64 only)
wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y /tmp/chrome.deb
rm /tmp/chrome.deb

# 4. Create the blacktip user and app directory
sudo useradd -r -m -d /home/blacktip -s /usr/sbin/nologin blacktip
sudo mkdir -p /opt/blacktip-app /opt/blacktip-app/logs
sudo chown -R blacktip:blacktip /opt/blacktip-app /home/blacktip

# 5. Deploy your app to /opt/blacktip-app
#    (git clone, scp, rsync, whatever your deploy pipeline does)
sudo -u blacktip bash -c 'cd /opt/blacktip-app && npm install @rester159/blacktip'
sudo -u blacktip bash -c 'cd /opt/blacktip-app && npx patchright install chromium'

# 6. Install the systemd units
sudo cp deploy/systemd/xvfb.service /etc/systemd/system/xvfb.service
sudo cp deploy/systemd/blacktip.service /etc/systemd/system/blacktip.service
sudo systemctl daemon-reload
sudo systemctl enable --now xvfb
sudo systemctl enable --now blacktip

# 7. Verify
systemctl status xvfb
systemctl status blacktip
journalctl -u blacktip -f   # tail logs
```

### Customizing `blacktip.service` for your app

The shipped unit file runs BlackTip's generic CLI serve mode. For your own app, edit `/etc/systemd/system/blacktip.service` and change the `ExecStart` line:

```ini
ExecStart=/usr/bin/node /opt/blacktip-app/dist/your-server.js
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart blacktip
```

### Running multiple BlackTip instances on one host

Copy `blacktip.service` to `blacktip@.service` (template unit):

```bash
sudo cp /etc/systemd/system/blacktip.service /etc/systemd/system/blacktip@.service
```

Edit the template to use `%i` as the port number:

```ini
Environment=DISPLAY=:99
ExecStart=/usr/bin/node /opt/blacktip-app/dist/server.js --port %i
```

Start instances per-port:

```bash
sudo systemctl start blacktip@9779
sudo systemctl start blacktip@9780
sudo systemctl start blacktip@9781
```

Each instance shares Xvfb but has its own Chrome process and TCP port.

---

## Cloud providers

### AWS

**Recommended: EC2 with Ubuntu 22.04 LTS, `t3.large` or larger.**

```bash
# Launch a t3.large (2 vCPU, 8 GB) with Ubuntu 22.04
# SSH in and run the systemd setup above.
```

- **Security group:** restrict port 9779 to your application servers' security group, never the public internet
- **Elastic IP:** recommended if you're running a long-lived instance and your proxy provider whitelists the IP
- **EBS:** 20 GB gp3 is enough; Chrome data and logs grow slowly

**Lambda / Fargate: not recommended.** Chrome is too big (>200 MB) and too slow to start for Lambda's execution model. Fargate works but costs ~3–5x more per session-hour than EC2.

**For scale:** spin up multiple `t3.medium` instances behind an ALB rather than one huge box. Chrome stability per-host degrades above ~20 concurrent sessions due to file descriptor and memory fragmentation.

### Google Cloud Platform

**Recommended: Compute Engine `e2-standard-2` or `e2-standard-4`.**

```bash
gcloud compute instances create blacktip-1 \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --zone=us-east1-b
```

Follow the systemd setup above via SSH. Same guidance as AWS for sizing.

**Cloud Run: works for stateless request-response patterns** (like a single-shot scraping job), but doesn't work for long-lived sessions because Cloud Run kills containers after a request completes. Use Cloud Run Jobs for batch work, Compute Engine for interactive sessions.

### DigitalOcean

**Recommended: Droplet with Ubuntu 22.04, `s-2vcpu-4gb` ($24/mo) or `s-4vcpu-8gb` ($48/mo).**

```bash
doctl compute droplet create blacktip-1 \
  --image ubuntu-22-04-x64 \
  --size s-2vcpu-4gb \
  --region nyc3 \
  --ssh-keys $(doctl compute ssh-key list --format ID --no-header)
```

DO's block storage (Spaces) is cheaper than AWS S3 if you're archiving screenshots or session snapshots.

### Hetzner (cheapest for the money)

**Strongly recommended if budget matters.** Hetzner is dramatically cheaper than the big three clouds for the same specs.

```bash
# Via hcloud CLI:
hcloud server create \
  --name blacktip-1 \
  --type cx22 \
  --image ubuntu-22.04 \
  --location nbg1 \
  --ssh-key your-key
```

- **CX22** (2 vCPU, 4 GB): ~€4.50/month, handles ~10 concurrent sessions
- **CX32** (4 vCPU, 8 GB): ~€7.50/month, handles ~20 concurrent sessions
- **CX42** (8 vCPU, 16 GB): ~€14/month, handles ~40 concurrent sessions

For the same money as one AWS `t3.large` ($60/mo) you can run four `CX32` instances. Scaling is strictly horizontal for this workload, so that's usually a better trade.

Hetzner is German (data centers in Nuremberg, Falkenstein, Helsinki) — exit IPs are European. If you need US exit IPs, combine with a residential proxy layer.

### Fly.io

**Works well for this use case.** Fly runs containers at the edge with persistent volumes and built-in Anycast networking.

```bash
# From the repo root after building your image
fly launch --now
```

Fly's `vm.memory` and `vm.cpus` map directly. Recommended starting size: 2 CPU / 4 GB. Scale horizontally with `fly scale count 3`.

One gotcha: Fly's default container has shared `/dev/shm` set low. Set `experimental.shmSize = "2g"` in `fly.toml`.

---

## Sizing and cost

Rough guidance based on actual measurements:

| Component | Per session |
|---|---|
| Chrome process (BlackTip) | 150–300 MB RAM, 0.5–1 vCPU during active actions |
| Xvfb (shared across all sessions on a host) | ~30 MB RAM, negligible CPU |
| Node process running your app | ~100 MB RAM |

Concurrent session capacity by instance size:

| Instance | RAM | vCPU | Concurrent sessions | Notes |
|---|---|---|---|---|
| Hetzner CX22 | 4 GB | 2 | ~10 | Budget starter, €4.50/mo |
| AWS t3.medium | 4 GB | 2 | ~10 | ~$30/mo |
| Hetzner CX32 | 8 GB | 4 | ~20 | Sweet spot, €7.50/mo |
| AWS t3.large | 8 GB | 2 | ~15–20 | ~$60/mo |
| AWS c5.xlarge | 8 GB | 4 | ~25–30 | Better CPU, ~$140/mo |
| Hetzner CX42 | 16 GB | 8 | ~40 | €14/mo |
| AWS m5.2xlarge | 32 GB | 8 | ~60 | ~$280/mo |

**Above ~50 concurrent sessions on a single host, Chrome becomes unstable** (file descriptor leaks, memory fragmentation, occasional crashes). Scale horizontally past that point.

**GPU instances** (AWS g4dn, GCP T4, Hetzner GPU) are ~10x the cost of CPU instances. Only needed if your targets specifically probe WebGL for GPU-level shader precision (rare). For most use cases, BlackTip's WebGL profile spoofing + SwiftShader fallback is indistinguishable enough.

---

## Troubleshooting

### "Chrome failed to launch: connection closed"

Almost always `/dev/shm` size. Docker defaults to 64 MB; Chrome needs at least 1 GB. Add `--shm-size=2gb` to docker run, or set `shm_size: "2gb"` in docker-compose.yml, or mount a larger tmpfs.

### "Could not connect to display :99"

Xvfb isn't running on that display. Check:

```bash
systemctl status xvfb
ps aux | grep Xvfb
DISPLAY=:99 xdpyinfo | head -3
```

If Xvfb crashed, `journalctl -u xvfb -n 50` will show why. Common cause: missing the `-nolisten tcp` flag on a system with AppArmor rules blocking Xvfb from listening on TCP.

### "Failed to initialize a component (v8.flags): --expose_wasm"

Chrome version mismatch. The installed Chrome Stable is newer than what patchright's patches target. Usually self-resolves within a week of Chrome releases. Workaround: pin Chrome to a specific version via:

```bash
sudo apt-mark hold google-chrome-stable
```

And update manually when patchright releases a matching version.

### Chrome uses SwiftShader renderer instead of real GPU

Expected on non-GPU hosts. BlackTip's WebGL profile spoofing replaces the SwiftShader strings with your profile's claimed GPU strings. For most detectors this is fine. If a specific site does deep canvas/WebGL probing, either:

1. Move to a GPU-enabled instance (AWS g4dn, GCP T4)
2. Install Mesa software rendering with LLVMpipe (still software but less distinctive than SwiftShader)
3. Accept the risk — 90%+ of sites don't check this deeply

### "no such file or directory: /dev/snd/seq"

Chrome tries to open the ALSA sequencer even on systems without audio. Harmless warning; can be silenced by installing `libasound2-plugins` and a dummy audio sink:

```bash
sudo apt-get install -y libasound2-plugins alsa-utils
```

### Memory keeps growing over days

Chrome has known memory leaks under long-lived sessions. Best practice: recycle sessions every N hours or M requests via `bt.newContext()` or restarting the whole BlackTip instance. The systemd unit's `MemoryMax=2G` hard-caps per instance; if you hit it, systemd kills and restarts automatically.

### Fonts don't match declared profile (CreepJS font panel flags it)

Install the fonts your device profile declares. For the `desktop-windows` profile, you need Arial, Times New Roman, Calibri, etc. On Ubuntu:

```bash
# Microsoft fonts (accept the license prompt)
sudo apt-get install -y ttf-mscorefonts-installer
sudo fc-cache -fv
```

For `desktop-macos`, you can't legally install Apple fonts on Linux. Either use a different profile or accept the mismatch. Most detectors don't check font fidelity this deeply.

### Timezone reported differently from declared profile

Set the `TZ` env var in the systemd unit / Dockerfile to match your profile's timezone:

```ini
Environment=TZ=America/New_York
```

BlackTip sets the timezone via Playwright's context option at the JS level, but the OS timezone also matters for some deep probes (clock drift analysis). Matching both gives the tightest stealth.

### patchright Chromium install fails with permission denied

Run as the `blacktip` user, not root:

```bash
sudo -u blacktip bash -c 'cd /opt/blacktip-app && npx patchright install chromium'
```

The browser downloads to `$HOME/.cache/ms-playwright/` — if run as root, it lands in `/root/.cache/` and the `blacktip` user can't access it.

### "Browser closed unexpectedly" on first run

Usually Chrome deps missing. Run this to check what's missing:

```bash
ldd /opt/google/chrome/chrome | grep "not found"
```

Install any missing `lib*` packages and retry. The `xvfb-deps` list in the Dockerfile covers the typical set.

---

## Monitoring and observability

BlackTip emits structured events (actions, retries, errors, tab changes) that you can export to any logging backend. The shipped `JsonlFileExporter` writes to a JSON-lines file per session:

```typescript
import { attachObservability, JsonlFileExporter } from '@rester159/blacktip';

attachObservability(bt, [
  new JsonlFileExporter(`/app/logs/session-${userId}.jsonl`),
]);
```

On systemd, tail the logs with:

```bash
journalctl -u blacktip -f              # real-time
journalctl -u blacktip --since "1h ago" # last hour
journalctl -u blacktip -o json         # structured output for log aggregators
```

For production monitoring, write a custom `EventExporter` that ships events to Datadog, CloudWatch, Grafana Loki, or wherever your logs live. The `StructuredEvent` shape is intentionally compatible with OpenTelemetry attribute data model, so bridging to OTel is ~20 lines.

### Key metrics to alert on

- **Action failure rate** — if it climbs above ~5%, either a target site changed or BlackTip is being detected
- **Session start rate vs success rate** — catches Chrome startup failures
- **Per-domain ban rate from ProxyPool** — if one proxy is getting banned everywhere, rotate it out
- **Memory per Chrome process** — > 500 MB sustained indicates a leak; recycle the session
- **MFA pause timeout rate** — users giving up on the OTP flow

---

## Security notes

- **Never expose port 9779 to the public internet.** The TCP protocol has no authentication — anyone who can connect can execute arbitrary JavaScript in your Chrome instance. Keep it on a private network / security group / firewall rule.
- **Don't run BlackTip as root.** The systemd unit and Dockerfile both use a dedicated `blacktip` user. If you write your own deployment, do the same.
- **Credentials via environment variables, not config files.** Use systemd's `EnvironmentFile=` directive pointing at a file with `0600` permissions owned by the service user.
- **Log scrubbing.** BlackTip's structured events include URLs and sometimes form values. Make sure your log aggregator scrubs PII before indexing.
- **TLS to your own services.** If your app talks to a user-facing API, put Caddy or nginx in front with a real certificate. Don't ship a self-signed cert.

---

## Quick reference

| Task | Command |
|---|---|
| Start Docker container | `docker compose up -d` |
| Stop Docker container | `docker compose down` |
| Rebuild image | `docker compose build --no-cache` |
| Shell into container | `docker compose exec blacktip bash` |
| Start systemd service | `sudo systemctl start blacktip` |
| Stop systemd service | `sudo systemctl stop blacktip` |
| Enable at boot | `sudo systemctl enable blacktip` |
| Tail logs | `journalctl -u blacktip -f` |
| Status | `systemctl status blacktip` |
| Verify Xvfb running | `DISPLAY=:99 xdpyinfo` |
| Test BlackTip is listening | `nc -zv localhost 9779` |
| Send a test command | `blacktip send "return await bt.executeJS('navigator.userAgent')"` |

If something breaks and this guide doesn't cover it, open an issue at https://github.com/rester159/blacktip/issues with:

- The OS and version (`lsb_release -a`)
- Node version (`node --version`)
- Chrome version (`google-chrome --version`)
- A minimal reproduction
- Relevant logs from `journalctl -u blacktip -n 100`
