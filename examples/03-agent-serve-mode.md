# Example 3 — Agent driving BlackTip in serve mode

This is the pattern used by the BlackTip design: an LLM agent in one process, a BlackTip server in another, and one-command-at-a-time interaction.

## Start the server

```bash
npx blacktip serve --port 9779
```

The server launches a real Chrome window and listens for TCP commands.

## Send commands

```bash
# Single command with pretty output (screenshot path shown, not raw base64)
npx blacktip send "await bt.navigate('https://example.com')" --pretty

# Command from a file — no shell escaping needed
echo 'await bt.type("#email", "you@example.com", { paste: true })' > cmd.js
npx blacktip send --file cmd.js --pretty

# Command from stdin
echo 'return await bt.inspect("#submit-button")' | npx blacktip send --stdin --pretty

# Batch: run many commands sequentially, stop on first failure
cat > flow.json <<'EOF'
[
  "await bt.navigate('https://example.com/login')",
  "await bt.waitForStable()",
  "await bt.type('#email', 'you@example.com', {paste: true})",
  "await bt.type('#password', 'secret', {paste: true})",
  "await bt.click('#submit')",
  "await bt.waitForText('Welcome')"
]
EOF
npx blacktip batch flow.json
```

## Response format

Every `send` returns a JSON bundle:

```json
{
  "ok": true,
  "result": "... whatever the JS command returned, if anything",
  "url": "https://example.com/",
  "title": "Example Domain",
  "screenshotPath": "shot.png",
  "screenshotB64": "iVBORw0KGgoAAAA...",
  "screenshotBytes": 41234,
  "durationMs": 432
}
```

With `--pretty`, the `screenshotB64` field is replaced by a placeholder so the console output is readable. The PNG is still saved to `shot.png` (or whatever `screenshotPath` you configured).

## Handling MFA

When a command calls `bt.pauseForInput()`, the server sends a pause frame:

```json
{"ok": true, "paused": true, "pauseId": "pause-1712345678-12345", "prompt": "Enter the SMS code"}
```

The `send` command that triggered the pause blocks on the client side until you resume. From a second terminal:

```bash
npx blacktip resume pause-1712345678-12345 "116170"
```

The paused command continues executing with the value you provided.

## Listing pending pauses

```bash
npx blacktip pending
```

Useful in long-running flows with multiple potential pause points.

## Agent decision loop (pseudocode)

```
start server
navigate to target
loop:
  send one command
  parse the bundle
  look at the screenshot (base64 or on disk)
  decide the next action based on what you see
  if uncertain, ask the user
  if the action is destructive (submit, pay, delete), summarize and confirm first
  send the next command
```

The crucial rule: **never pre-script a multi-step sequence.** Look, decide, act, repeat. Pages change between steps and pre-scripted flows fail on the first surprise.
