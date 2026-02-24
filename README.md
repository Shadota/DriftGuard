# DriftGuard -- Character Drift Corrector

A SillyTavern extension that monitors live roleplay conversations for personality trait drift and auto-injects targeted Author's Notes to reinforce decaying traits.

## The Problem

LLM characters degrade into "slop" over long roleplay conversations. Research identifies five layers of drift:

- **Context rot** (~30%) -- Important character details fall out of the context window
- **RLHF personality bias** (~25%) -- Models revert to helpful/agreeable defaults
- **Lost-in-the-middle** (~15%) -- Attention effects deprioritize mid-context information
- **Safety alignment floors** (~15%) -- Models resist sustained negative emotional states
- **Snowball drift** (~15%) -- Small deviations compound over turns

Character card quality alone addresses ~30% of the problem. DriftGuard handles the remaining ~70% with runtime intervention.

## How It Works

1. **Trait Extraction** -- On chat load, DriftGuard analyzes the character card and extracts 3-7 key personality traits that are most likely to drift
2. **Response Scoring** -- After every Nth AI response, a separate analysis model scores the response for trait adherence (0.0-1.0)
3. **Drift Detection** -- A moving average over recent scores identifies traits that are declining below a configurable threshold
4. **Auto-Correction** -- When drift is detected, DriftGuard generates behavioral Author's Notes (not meta-instructions) and injects them into the conversation context
5. **Escalation** -- If corrections aren't working, DriftGuard regenerates with stronger cues. If a trait still won't hold, it alerts the user
6. **Post-Session Reports** -- Generate reports with Card Resilience, Session Quality, and Model Compatibility scores, plus per-trait verdicts and LLM-generated insights

## Architecture

Two components in one repo:

- **UI Extension** (browser-side) -- Dashboard, settings, generate interceptor, drift detection, Author's Note injection
- **Server Plugin** (Node.js) -- Wraps `claude -p` CLI as an Express endpoint for analysis (only needed for Claude Code backend)

## Installation

### 1. UI Extension

Copy or clone this entire repository into SillyTavern's third-party extensions directory:

```
data/default-user/extensions/third-party/Character-Drift-Corrector/
```

### 2. Server Plugin (for Claude Code backend only)

Copy the `plugin/` directory to SillyTavern's plugins directory:

```
plugins/driftguard/
```

Enable server plugins in SillyTavern's `config.yaml`:

```yaml
enableServerPlugins: true
```

### 3. Restart SillyTavern

The extension will appear in the Extensions panel as "DriftGuard".

## Analysis Backends

DriftGuard uses a **separate model** from your roleplay model to judge character responses. Two backends are supported:

> **Important:** You **must** use a different model for analysis than the one generating your roleplay responses. The analysis model needs to independently evaluate trait adherence — if it shares the same biases causing the drift, scoring results will be unreliable. For example, if you roleplay with Llama 3.3 70B, use Claude or a different model family for analysis.

### Claude Code (via Server Plugin)

- Requires the DriftGuard server plugin installed in `plugins/driftguard/`
- Requires [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on your PATH
- Supports model selection: `sonnet`, `haiku`, `opus`, or full model IDs

### OpenAI-Compatible

- Works with any OpenAI-compatible endpoint: local models (llama.cpp, TabbyAPI, Ollama), OpenAI, OpenRouter, etc.
- Configure endpoint URL, API key (optional), and model name in settings

## Settings

### Scoring
- **Score frequency** -- How often to score AI responses (1 = every, 3 = every 3rd)
- **Score first response** -- Always score the very first AI response

### Drift Detection
- **Moving average window** -- Number of recent scores in the moving average (default: 5)
- **Drift threshold** -- Scores below this trigger correction (default: 0.40)
- **Alert threshold** -- Scores below this trigger severe drift alerts (default: 0.25)

### Correction
- **Injection depth** -- How many messages from the bottom to inject corrections (default: 4)
- **Max traits** -- Maximum traits to reinforce at once (default: 3)
- **Patience** -- Scored messages before evaluating if correction is working (default: 3)
- **Max attempts** -- Correction regeneration attempts before ceiling (default: 2)
- **Cooldown** -- Scored messages to wait after removing correction before re-injecting (default: 2)

## Reports

DriftGuard generates three session scores:

- **Card Resilience** -- How well the character card maintains traits without intervention
- **Session Quality** -- Overall consistency of character portrayal
- **Model Compatibility** -- How well the current model handles this character's traits

Per-trait verdicts:
- **Natural Fit** -- Never drifted, no correction needed
- **Maintainable** -- Minor drift, self-corrected or minimal correction
- **Correctable** -- Required correction, correction was effective
- **Drifting** -- Drifted despite correction attempts, trait has not recovered
- **Volatile** -- Drifted without corrections applied, trait unstable for this model
- **Ceiling** -- Hit ceiling despite correction attempts (possible model limitation)

Reports can be exported as JSON for external analysis.

## Requirements

- SillyTavern (latest version recommended)
- For Claude Code backend: Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- For OpenAI backend: Any OpenAI-compatible endpoint

## License

MIT
