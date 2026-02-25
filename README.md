# DriftGuard -- Character Drift Corrector

A SillyTavern extension that monitors live roleplay conversations for character personality drift across 11 behavioral dimensions and auto-injects targeted Author's Notes to correct deviations from calibrated targets.

## The Problem

LLM characters degrade into "slop" over long roleplay conversations. Research identifies five layers of drift:

- **Context rot** (~30%) -- Important character details fall out of the context window
- **RLHF personality bias** (~25%) -- Models revert to helpful/agreeable defaults
- **Lost-in-the-middle** (~15%) -- Attention effects deprioritize mid-context information
- **Safety alignment floors** (~15%) -- Models resist sustained negative emotional states
- **Snowball drift** (~15%) -- Small deviations compound over turns

Character card quality alone addresses ~30% of the problem. DriftGuard handles the remaining ~70% with runtime intervention.

## How It Works

1. **Dimension Calibration** -- On first chat, DriftGuard calibrates the character's position on 11 behavioral dimensions (warmth, stability, expressiveness, assertiveness, sociability, trust, morality, verbosity, cooperativeness, humor, romantic receptivity). Targets are pinned per character and persist across sessions.
2. **Response Scoring** -- Every Nth AI response is scored on a discrete 5-point scale (0.0, 0.25, 0.5, 0.75, 1.0) per dimension. Scoring uses character-isolated prompts with rubric anchors and chain-of-thought reasoning. Only the main character's behavior is scored -- NPCs and narration are excluded.
3. **CUSUM Drift Detection** -- A Cumulative Sum (CUSUM) algorithm detects persistent shifts away from target. Unlike simple moving averages, CUSUM accumulates evidence of drift over time -- random score variation cancels out, but consistent deviation triggers correction.
4. **Auto-Correction** -- Behavioral Author's Notes (not meta-instructions) steer the character back toward targets. Corrections are injected at a configurable depth in the conversation context.
5. **Escalation** -- If corrections aren't working, DriftGuard regenerates with stronger cues. If a dimension still won't hold, it alerts the user.
6. **Post-Session Reports** -- Generate reports with Card Resilience, Session Quality, and Model Compatibility scores, plus per-dimension verdicts and LLM-generated insights. Cross-session comparison with shared dimension IDs.

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

> **Important:** You **must** use a different model for analysis than the one generating your roleplay responses. The analysis model needs to independently evaluate dimensional adherence -- if it shares the same biases causing the drift, scoring results will be unreliable. For example, if you roleplay with Llama 3.3 70B, use Claude or a different model family for analysis.

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
- **Moving average window** -- Number of recent scored messages for drift calculations. Larger windows require more accumulated evidence to trigger (default: 8)
- **Drift threshold** -- Sensitivity for drift detection. Controls noise tolerance and accumulated evidence needed to trigger correction (default: 0.20)
- **Alert threshold** -- Sensitivity for severe drift alerts. Uses more aggressive detection that triggers faster for larger deviations (default: 0.35)

### Correction
- **Injection depth** -- How many messages from the bottom to inject corrections (default: 4)
- **Max dimensions** -- Maximum dimensions to reinforce at once (default: 3)
- **Patience** -- Scored messages before evaluating if correction is working (default: 2)
- **Max attempts** -- Correction regeneration attempts before ceiling (default: 2)
- **Cooldown** -- Scored messages to wait after removing correction before re-injecting (default: 2)
- **Recovery margin** -- Hysteresis band to prevent flapping between corrected/uncorrected states (default: 0.05)

### Baseline Author's Note
- **Enable baseline** -- Continuously inject a subtle personality anchor derived from calibrated dimensions
- **Baseline depth** -- Injection depth for the baseline note (default: 6)

## Reports

DriftGuard generates three session scores:

- **Card Resilience** -- How well the character card maintains dimensions without intervention
- **Session Quality** -- Overall consistency of character portrayal
- **Model Compatibility** -- How well the current model handles this character's dimensional profile

Per-dimension verdicts:
- **Natural Fit** -- Never drifted, no correction needed
- **Maintainable** -- Minor drift, self-corrected or minimal correction
- **Correctable** -- Required correction, correction was effective
- **Drifting** -- Drifted despite correction attempts, dimension has not recovered
- **Volatile** -- Drifted without corrections applied, dimension unstable for this model
- **Ceiling** -- Hit ceiling despite correction attempts (possible model limitation)

Reports can be exported as JSON for external analysis.

## Methodology & References

DriftGuard's approach is informed by several established research areas:

- **Dimensional Model** -- Inspired by the [Big Five / OCEAN personality model](https://en.wikipedia.org/wiki/Big_Five_personality_traits), the most validated framework in personality psychology. Extended with domain-specific dimensions (morality, humor, romanticism) for fictional character coverage.
- **LLM Personality Assessment** -- Approach informed by the [TRAIT benchmark](https://aclanthology.org/2025.findings-naacl.469/) (NAACL 2025) and [A Psychometric Framework for LLM Personality](https://www.nature.com/articles/s42256-025-01115-6) (Nature Machine Intelligence 2025), which demonstrate that scenario-based, rubric-anchored evaluation outperforms raw scale scoring for LLM personality measurement.
- **LLM-as-Judge Scoring** -- Discrete 5-point scale with rubric anchors and chain-of-thought reasoning follows [established best practices](https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method) for LLM evaluation reliability.
- **CUSUM Drift Detection** -- The [Cumulative Sum control chart](https://en.wikipedia.org/wiki/CUSUM) (Page, 1954) is a proven sequential analysis technique for detecting persistent mean shifts in processes, applied here to behavioral dimension scores. More sensitive to gradual drift than simple moving averages. See also [Survey on Concept Drift Detection](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2024.1330257/full) (Frontiers in AI, 2024).

## Requirements

- SillyTavern (latest version recommended)
- For Claude Code backend: Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- For OpenAI backend: Any OpenAI-compatible endpoint

## License

MIT
