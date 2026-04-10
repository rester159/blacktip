## Working style (always follow these)

- **Ask questions over assuming** — always prefer clarifying questions before making decisions
- **No code until the plan is solid** — currently in architecture/schema design phase (discovery complete)
- **Log everything** — user queries → `planning/input.md`, assistant responses → `planning/output.md`
- **Timestamps on every log entry** — run `date '+%Y-%m-%d %H:%M:%S'` first, format: `YYYY-MM-DD HH:MM:SS`
- **Learn from mistakes** — when a miss or gap is found, log it in `planning/lessons.md` with root cause + fix, then update all affected docs. Read `planning/lessons.md` at the start of every session.
- **Propagate discoveries immediately** — when analysis reveals new facts, update CLAUDE.md and PRD before moving on
- **Close open questions** — when a decision is made, mark the corresponding open question ✅ in the PRD
- **PRD → tasks.md sync** — every new "must implement" requirement in the PRD needs a corresponding task in tasks.md

---

## Workflow principles (always follow these)

### Plan before acting
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions) — write the plan, get sign-off, then execute
- If something goes sideways mid-task: STOP and re-plan. Don't keep pushing.
- Write detailed specs upfront to reduce ambiguity

### Subagent strategy
- Use subagents liberally to keep the main context window clean
- Offload research, exploration, and parallel analysis to subagents
- One focused task per subagent — don't give a subagent multiple unrelated jobs

### Verification before done
- Never mark a task complete without proving it works (tests pass, behaviour confirmed)
- Ask: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness — don't self-certify without evidence

### Demand elegance
- For non-trivial changes: pause and ask "is there a more elegant solution?"
- If a fix feels hacky: implement the proper solution instead
- Skip this for simple, obvious fixes — don't over-engineer

### Autonomous bug fixing
- When given a bug report: diagnose and fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests — then resolve them
- Go fix failing tests without being told how

### Autonomous PRD, tasks and schema updating
- When in the context of a prompt user suggest a new feature, add that feature to the prd.md document, idnetifying the right place in the prd and if necessary, modify other features to connect them to the new feature
- If a new feature impact the schema, also modify the schema.md file
- The objective is to maintain prd.md and schema.md as evergreen, always updated documents

### Core quality principles
- **Simplicity first** — make every change as simple as possible, touch minimal code
- **No laziness** — find root causes, no temporary fixes, senior developer standards
- **Minimal impact** — changes should only touch what's necessary, avoid introducing bugs

---

## LLM usage principle (always follow these)

- **Every LLM call must be logged** — model, input tokens, output tokens, estimated cost, timestamp, action type. No exceptions.

---

## Testing strategy (always follow these)

- **TDD** — write the failing test first, then write the minimum code to make it pass. **Every plan must lead with tests — never list tests only as a verification step at the end.** If TDD proves too slow for a specific area, flag it and agree a change before deviating.
- **Backend**: `xUnit` as the test framework. `Moq` for mocking. `WebApplicationFactory` for integration tests (full request pipeline against a real test DB).
- **Frontend**: `Vitest` + `React Testing Library` for component-level unit tests.
- **E2E**: `Playwright` — planned for v1.1, not MVP.
- Every feature ships with tests. No feature is considered done until its tests pass.

---

## Task tracking & agent coordination

All tasks live in `planning/tasks.md`. This is the single source of truth for what is done, in progress, and upcoming.

**Protocol (all agents must follow):**
1. Before starting any task → claim it: set `status` to `in_progress`, write your identifier to `assigned_to`
2. Do not start a task whose `depends_on` list contains any non-`done` task
3. On completion → set `status` to `done`, clear `assigned_to`
4. Only the orchestrator (main Claude session) creates, removes, or rescopes tasks

Tasks are coarse-grained (feature-level) for now. Break into sub-tasks only if parallelising sub-agents.

---

## README maintenance

`README.md` is the first thing seen when returning to the repo after a long gap. Keep it in sync.

**Update README when:**
- A phase changes status (starts or completes)
- A tech stack decision is locked in or changed
- Deployment target changes
- Major MVP scope changes (features added or removed)

See L008 in `planning/lessons.md`.

---

## Planning artifacts

| File | Purpose |
|---|---|
| `planning/lessons.md` | Mistakes and misses log — read at start of every session |
| `planning/schema.md` | Approved database schema — feeds T004 migrations |
| `planning/tasks.md` | Master task list — canonical backlog and progress tracker |
| `planning/prd.md` | Living PRD with full feature detail |
| `planning/input.md` | All user messages, timestamped |
| `planning/output.md` | All assistant responses, timestamped |
| `planning/competitor_features.md` | Feature comparison from competitors |

# Using BlackTip as an Agent (CRITICAL — read this first)

BlackTip is a stealth browser automation instrument. It is NOT an agent — YOU are the agent. BlackTip provides the hands, you provide the brain.

## How to drive BlackTip

**Start the server:**
```bash
cd C:\Users\edang\myApps_v2\blacktip
node dist/cli.js serve
```

**Send commands one at a time:**
```bash
node dist/cli.js send "await bt.navigate('https://example.com')"
node dist/cli.js send "await bt.click('#login-btn')"
node dist/cli.js send "return await bt.executeJS('document.title')"
```

Every command saves a screenshot to `shot.png`. **Always read the screenshot before deciding the next action.** Do NOT pre-script a sequence of steps — look, decide, act, repeat.

## Rules for agents (ALWAYS FOLLOW)

1. **Read input documents FIRST** — If the user gives you a PDF, image, or file to submit, read it BEFORE starting the browser flow. Extract names, dates, codes, amounts. Never guess.

2. **Screenshot before every decision** — After each command, read `shot.png` to see the page state. The page may have changed, loaded slowly, or shown an error.

3. **Use `clickText()` for visible text** — `bt.clickText("Submit", {nth: 0})` uses Playwright's locator API and handles dynamic frameworks (React, Angular, Okta) correctly.

4. **Use `executeJS()` for inspection** — When you don't know the selectors, inspect the DOM:
   ```
   bt.executeJS("JSON.stringify([...document.querySelectorAll('button')].map(b=>b.textContent.trim()))")
   ```

5. **Use `paste: true` for form filling** — `bt.type('input[name="email"]', 'user@example.com', {paste: true})` is fast and works with React/Angular forms.

6. **Angular/custom dropdowns** — These are NOT `<select>` elements. Pattern:
   - Click the combobox button by ID: `bt.click("#dropdown_button")`
   - Inspect options: `bt.executeJS("...")`
   - Click the option by ID: `bt.click("#dropdown_option-0")`

7. **Okta login pages** — Username field: `input[name="identifier"]`. Password field: `input[name="credentials.passcode"]`. Submit button: `.button-primary`. MFA select buttons use `bt.clickText("Select", {nth: 1})` for phone.

8. **Fail fast** — Use `timeout: 10000` and `retryAttempts: 2`. If an action fails, inspect the page (screenshot + executeJS) rather than retrying blindly for minutes.

9. **Ask the user when uncertain** — Don't guess patient names, account types, or form selections. Ask.

## Available API methods

| Method | Purpose |
|--------|---------|
| `bt.navigate(url)` | Go to URL |
| `bt.click(selector)` | Click element by CSS/XPath |
| `bt.clickText(text, {nth?})` | Click by visible text (Playwright locator) |
| `bt.clickRole(role, {name?})` | Click by ARIA role |
| `bt.type(selector, text, {paste?})` | Type into input |
| `bt.scroll({direction, amount})` | Scroll page |
| `bt.screenshot({path})` | Take screenshot |
| `bt.waitFor(selector)` | Wait for element |
| `bt.extractText(selector)` | Get text content |
| `bt.executeJS(script)` | Run JavaScript in page |
| `bt.uploadFile(selector, path)` | Upload file |
| `bt.frame(selector)` | Get iframe context |
| `bt.getTabs()` / `bt.switchTab(i)` | Tab management |

## Common mistakes agents make (don't repeat these)

- **Pre-scripting the entire flow** — breaks on the first unexpected page state
- **Using `executeJS("el.click()")` for Okta/React buttons** — DOM clicks don't trigger framework event handlers. Use `bt.clickText()` instead.
- **Not reading the screenshot** — you MUST look at `shot.png` between actions
- **Guessing form values** — read the source documents first
- **Long timeouts** — waiting 30s+ per failed action wastes time. Fail fast, inspect, adapt.