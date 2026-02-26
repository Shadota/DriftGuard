// DriftGuard -- Character Drift Corrector
// Monitors live roleplay for character personality drift using fixed behavioral dimensions
// and auto-injects targeted Author's Notes to correct deviations from character targets.

import {
    getStringHash,
    debounce,
} from '../../../utils.js';

import {
    saveSettingsDebounced,
    getRequestHeaders,
    extension_prompt_roles,
    extension_prompt_types,
    chat_metadata,
    eventSource,
    event_types,
} from '../../../../script.js';

import {
    getContext,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';

export { MODULE_NAME };

// ==================== CONSTANTS ====================

const MODULE_NAME = 'driftguard';
const MODULE_NAME_FANCY = 'DriftGuard';
const MODULE_VERSION = '0.5.0';
const LOG_PREFIX = `[${MODULE_NAME_FANCY}]`;
const MIN_SCORES_FOR_CORRECTION = 2;
const MIN_SCORES_FOR_VERDICT = 2;
const FLOAT_EPSILON = 0.001; // Tolerance for floating-point comparisons on score thresholds

// ==================== DIMENSION CATALOG ====================

/**
 * Fixed behavioral dimensions for character drift monitoring.
 * Each dimension is a bipolar spectrum scored 0.0-1.0.
 * The LLM calibrates a target value per character during calibration.
 * Cross-session comparison is possible because dimension IDs are stable.
 */
const DIMENSION_CATALOG = [
    {
        id: 'warmth',
        label: 'Warmth',
        low_label: 'Cold / Detached',
        high_label: 'Warm / Affectionate',
        description: 'How warm or cold the character is in interpersonal interactions.',
        scoring_guidance: 'Emotional temperature toward others.',
        ai_default: 0.70,
        rubric: {
            '0.0':  'Completely clinical; treats others as objects with zero emotional engagement.',
            '0.25': 'Mostly detached; polite but distant and impersonal.',
            '0.5':  'Neutral; neither cold nor warm, engages normally.',
            '0.75': 'Noticeably caring; warm language, shows concern, friendly.',
            '1.0':  'Intensely affectionate; openly loving, deeply emotionally invested.',
        },
    },
    {
        id: 'stability',
        label: 'Emotional Stability',
        low_label: 'Volatile / Reactive',
        high_label: 'Calm / Steady',
        description: 'How emotionally reactive or composed the character is under pressure.',
        scoring_guidance: 'Emotional control under pressure.',
        ai_default: 0.65,
        rubric: {
            '0.0':  'Explosive; uncontrolled outbursts, mood swings, emotional chaos.',
            '0.25': 'Reactive; visibly rattled, struggles to maintain composure.',
            '0.5':  'Moderate; occasional emotional responses but generally functional.',
            '0.75': 'Composed; stays calm under most pressure, measured reactions.',
            '1.0':  'Unflappable; total emotional control, stoic under extreme stress.',
        },
    },
    {
        id: 'expressiveness',
        label: 'Emotional Openness',
        low_label: 'Repressed / Stoic',
        high_label: 'Expressive / Transparent',
        description: 'How openly the character shows or hides their emotions.',
        scoring_guidance: 'Emotional visibility and transparency.',
        ai_default: 0.75,
        rubric: {
            '0.0':  'Completely masked; suppresses all emotion, reveals nothing.',
            '0.25': 'Guarded; deflects emotional topics, rare glimpses of feeling.',
            '0.5':  'Moderate; shares some emotions when prompted, not volunteering.',
            '0.75': 'Open; readily shows emotions, transparent about feelings.',
            '1.0':  'Wears heart on sleeve; every emotion visible, nothing hidden.',
        },
    },
    {
        id: 'assertiveness',
        label: 'Assertiveness',
        low_label: 'Submissive / Yielding',
        high_label: 'Dominant / Commanding',
        description: 'How the character positions themselves in social power dynamics.',
        scoring_guidance: 'Social power positioning.',
        ai_default: 0.40,
        rubric: {
            '0.0':  'Completely submissive; defers to everyone, no initiative.',
            '0.25': 'Passive; yields easily, avoids confrontation, follows others.',
            '0.5':  'Balanced; asserts when needed but doesn\'t dominate.',
            '0.75': 'Assertive; takes charge, makes decisions, directs conversations.',
            '1.0':  'Commanding; dominates interactions, controls dynamics, demands compliance.',
        },
    },
    {
        id: 'sociability',
        label: 'Sociability',
        low_label: 'Withdrawn / Reclusive',
        high_label: 'Outgoing / Engaged',
        description: 'How much the character seeks or avoids social interaction.',
        scoring_guidance: 'Social engagement level.',
        ai_default: 0.80,
        rubric: {
            '0.0':  'Total withdrawal; avoids all interaction, minimal responses.',
            '0.25': 'Reluctant; engages only when necessary, prefers solitude.',
            '0.5':  'Moderate; participates normally without seeking or avoiding.',
            '0.75': 'Sociable; actively engages, initiates conversation, shows interest.',
            '1.0':  'Highly outgoing; enthusiastic engagement, draws others in.',
        },
    },
    {
        id: 'trust',
        label: 'Trust',
        low_label: 'Suspicious / Guarded',
        high_label: 'Open / Trusting',
        description: 'How readily the character trusts others and shares vulnerability.',
        scoring_guidance: 'Openness and willingness to trust.',
        ai_default: 0.70,
        rubric: {
            '0.0':  'Paranoid; assumes betrayal, shares nothing, tests constantly.',
            '0.25': 'Suspicious; guards information, questions motives, slow to open up.',
            '0.5':  'Cautious; reasonable wariness, shares selectively.',
            '0.75': 'Trusting; forthcoming, gives benefit of doubt, shares openly.',
            '1.0':  'Completely open; vulnerable, trusts implicitly, no guard.',
        },
    },
    {
        id: 'morality',
        label: 'Morality',
        low_label: 'Amoral / Ruthless',
        high_label: 'Principled / Empathetic',
        description: 'The character\'s ethical stance and capacity for empathy.',
        scoring_guidance: 'Moral behavior and empathy.',
        ai_default: 0.85,
        rubric: {
            '0.0':  'Ruthless; purely self-serving, no empathy, willing to harm.',
            '0.25': 'Selfish; bends rules freely, limited concern for others.',
            '0.5':  'Pragmatic; follows norms when convenient, situational ethics.',
            '0.75': 'Principled; consistent moral code, shows genuine empathy.',
            '1.0':  'Deeply altruistic; self-sacrificing, strong moral convictions.',
        },
    },
    {
        id: 'verbosity',
        label: 'Verbosity',
        low_label: 'Terse / Cryptic',
        high_label: 'Verbose / Elaborate',
        description: 'How much the character talks and how elaborate their communication is.',
        scoring_guidance: 'Communication volume and elaboration.',
        ai_default: 0.80,
        rubric: {
            '0.0':  'Minimal; one-word answers, grunts, silence, clipped phrases.',
            '0.25': 'Terse; short sentences, conveys minimum necessary information.',
            '0.5':  'Normal; standard conversational length, adequate detail.',
            '0.75': 'Elaborate; detailed explanations, full descriptions, articulate.',
            '1.0':  'Highly verbose; lengthy speeches, extensive detail, flowery language.',
        },
    },
    {
        id: 'cooperativeness',
        label: 'Cooperativeness',
        low_label: 'Defiant / Stubborn',
        high_label: 'Agreeable / Flexible',
        description: 'How willing the character is to cooperate, compromise, and go along with others.',
        scoring_guidance: 'Willingness to cooperate and compromise.',
        ai_default: 0.75,
        rubric: {
            '0.0':  'Defiant; refuses all requests, confrontational, oppositional.',
            '0.25': 'Stubborn; resists compromise, insists on own way.',
            '0.5':  'Moderate; willing to negotiate, neither rigid nor pushover.',
            '0.75': 'Cooperative; accommodating, goes along with others\' ideas.',
            '1.0':  'Completely agreeable; always yields, eager to please.',
        },
    },
    {
        id: 'humor',
        label: 'Humor',
        low_label: 'Serious / Grim',
        high_label: 'Playful / Witty',
        description: 'The character\'s use of humor, wit, or levity in interactions.',
        scoring_guidance: 'Humor presence and playfulness.',
        ai_default: 0.50,
        rubric: {
            '0.0':  'Gravely serious; no humor whatsoever, grim tone throughout.',
            '0.25': 'Mostly serious; rare dry or deadpan moments, humorless default.',
            '0.5':  'Moderate; occasional light humor, balanced tone.',
            '0.75': 'Witty; frequent jokes, playful banter, sarcastic quips.',
            '1.0':  'Constantly playful; everything is a joke, relentless wit.',
        },
    },
    {
        id: 'romanticism',
        label: 'Romantic Receptivity',
        low_label: 'Avoidant / Hostile',
        high_label: 'Receptive / Affectionate',
        description: 'How the character handles romantic dynamics and intimacy.',
        scoring_guidance: 'Romantic openness and receptivity.',
        ai_default: 0.60,
        rubric: {
            '0.0':  'Hostile; actively rejects romance, repulsed by intimacy.',
            '0.25': 'Avoidant; deflects romantic signals, uncomfortable with intimacy.',
            '0.5':  'Neutral; neither seeks nor avoids, responds normally.',
            '0.75': 'Receptive; welcomes romantic cues, shows affection openly.',
            '1.0':  'Intensely romantic; initiates intimacy, deeply affectionate.',
        },
    },
];

/** Quick lookup: dimension ID → catalog entry */
const DIMENSION_MAP = Object.fromEntries(DIMENSION_CATALOG.map(d => [d.id, d]));

/** All valid dimension IDs */
const DIMENSION_IDS = DIMENSION_CATALOG.map(d => d.id);

// ==================== PROMPTS ====================

const CALIBRATION_PROMPT = `You are a character analyst. Given this character description, calibrate {{character_name}}'s position on each behavioral dimension.

Each dimension is a spectrum from 0.0 to 1.0. Set a TARGET value representing where {{character_name}} typically sits on each spectrum. Use the full range — 0.0 and 1.0 are valid if the character is at an extreme.

DIMENSIONS:
{{dimensions_list}}

If a dimension is completely irrelevant to this character (e.g., romantic receptivity for a non-romantic character), set it to null.

For each active dimension, also provide a brief "context" sentence describing HOW this specific character expresses that position on the spectrum. This context helps scoring be character-specific.

CHARACTER DESCRIPTION:
{{description}}

Respond with ONLY a JSON object. No other text.
Example format:
{
    "warmth": { "target": 0.15, "context": "Speaks in clinical observations, treats people as data points" },
    "stability": { "target": 0.30, "context": "Prone to sudden outbursts of rage when contradicted" },
    "romanticism": null
}`;

const SCORING_PROMPT = `You are scoring the behavioral dimensions of a specific character in a roleplay response.

CHARACTER TO SCORE: {{character_name}}
You must score ONLY {{character_name}}'s direct actions, dialogue, and expressed behavior. IGNORE:
- Actions, dialogue, or emotions of other characters (NPCs, side characters, bystanders)
- Environmental narration, scene-setting, or atmospheric descriptions
- The user's character's actions or dialogue
- Implied or assumed behavior — only score what {{character_name}} explicitly does or says

SCORING SCALE: Use ONLY these discrete values: 0.0, 0.25, 0.5, 0.75, 1.0, or null
- null = {{character_name}} shows no behavior relevant to this dimension in this response
- Do NOT score low just because the scene doesn't feature it — use null instead
- Score what {{character_name}} DOES in this response, not what you expect from the character description
- Each dimension below shows the character's calibrated target. Use this ONLY to understand what "normal" looks like for this character — score what they DO, but be aware that a score 2+ steps from the target represents significant personality deviation
- IMPORTANT: For dimensions with low targets (below 0.25), be strict about higher scores. A 0.50 means actively demonstrating the high end of this trait — mere absence of the low-end behavior is 0.25, not 0.50. Cooperativeness 0.50 means genuinely accommodating, not just "not fighting right now." Sociability 0.50 means actively seeking engagement, not just responding when addressed.

DIMENSIONS TO SCORE:
{{dimensions_with_rubrics}}

CHARACTER DESCRIPTION (use to interpret dimensions in this character's terms — score what {{character_name}} actually DOES, grounded in the rubric levels):
{{character_description}}

RECENT CONVERSATION (for context):
{{recent_context}}

RESPONSE TO SCORE (focus ONLY on {{character_name}}'s behavior):
{{response_text}}

First provide 1-sentence reasoning per scored dimension explaining which rubric level best matches {{character_name}}'s behavior. Then output the JSON scores. Skip dimensions scored null in reasoning.

REASONING:
- dimension_id: [brief explanation referencing specific behavior from the response]
...

SCORES (use actual dimension IDs as keys, e.g. "warmth", "stability", etc.):
{"warmth": 0.5, "stability": null, "assertiveness": 0.75, ...}`;

const CORRECTION_GENERATION_PROMPT = `You are writing a brief Author's Note to steer {{character_name}} back toward their intended personality. The note will be injected into the conversation context.

{{intensity_block}}

RULES:
- Show how the character acts, not what they should be
- Use present tense, narrative style ("she deflects", "he avoids eye contact")
- Reference specific mannerisms, speech patterns, physical responses
- NEVER use words like "must", "should", "important", "critical", "remember"
- NEVER use negation ("does not soften" -> instead show what she DOES instead)
- Draw behavioral details from the character description below

CHARACTER DESCRIPTION:
{{description}}

CHARACTER'S DIMENSIONAL PROFILE (maintain holistically):
{{all_dimensions}}

DIMENSIONS THAT ARE DRIFTING (focus correction here):
{{drifting_dimensions}}

RECENT CONVERSATION (last 3 exchanges):
{{recent_context}}

DRIFT EVIDENCE:
{{drift_evidence}}

{{escalation_block}}

Write behavioral cues matching the intensity guidance above. No preamble, no explanation, no meta-commentary. Plain text only — no markdown, no asterisks, no quotes.`;

const BASELINE_GENERATION_PROMPT = `You are writing a brief, persistent Author's Note to anchor {{character_name}}'s core personality. This note will be present throughout the conversation to prevent gradual personality drift.

RULES:
- Write 2-3 sentences of BEHAVIORAL cues that capture the character's essence
- Focus on the dimensions where this character deviates most from typical AI defaults (warm, agreeable, verbose, emotionally stable, cooperative)
- Use present tense, narrative style ("she deflects", "he avoids eye contact")
- Reference specific mannerisms, speech patterns, physical responses
- Keep it subtle — this is background anchoring, not correction
- NEVER use words like "must", "should", "important", "critical", "remember"
- NEVER use negation ("does not soften" -> instead show what she DOES instead)

CHARACTER DESCRIPTION:
{{description}}

DIMENSIONAL PROFILE:
{{dimensions_summary}}

Write the Author's Note. No preamble, no explanation -- just the behavioral cues.`;

const REPORT_INSIGHTS_PROMPT = `Analyze this roleplay session report and provide actionable insights.

CHARACTER: {{char_name}}
MODEL: {{model_name}}
CARD RESILIENCE: {{card_score}}/100
SESSION QUALITY: {{session_score}}/100
MODEL COMPATIBILITY: {{model_score}}/100

PER-DIMENSION DATA:
{{dimension_breakdown}}

CORRECTIONS APPLIED:
{{correction_history}}

Provide:
1. Which dimensions the character maintains well vs. drifts on, and why
2. Specific card revision suggestions (reference the character description)
3. What the user could do differently in prompting/direction
4. Model-specific observations (what {{model_name}} struggles with for this character)

Be specific and actionable. Reference dimension names and scores. Keep total output under 400 words.`;

// ==================== DEFAULT SETTINGS ====================

const DEFAULT_SETTINGS = {
    // Master switch
    enabled: true,

    // Analysis backend
    analysis_backend: 'claude_code',  // 'openai' or 'claude_code'
    openai_endpoint: '',
    openai_api_key: '',
    openai_model: '',
    claude_code_model: 'sonnet',

    // Scoring
    score_frequency: 3,
    score_on_first: true,

    // Drift detection
    drift_window: 8,
    drift_threshold: 0.20,         // Max allowed deviation from target (was 0.4 minimum score)
    drift_alert_threshold: 0.35,   // Severe deviation threshold (was 0.25 minimum score)

    // Correction
    correction_enabled: true,
    correction_depth: 4,
    correction_max_dimensions: 3,
    correction_patience: 2,
    correction_max_attempts: 2,
    correction_cooldown: 2,
    recovery_margin: 0.05,         // Adjusted for distance-based detection
    recovery_patience: 2,

    // Baseline Author's Note
    baseline_enabled: true,
    baseline_depth: 6,

    // Display
    show_per_message_badges: true,
    show_toast_on_drift: true,

    // Report index (cross-session)
    report_index: [],

    // Per-character dimension calibrations (persisted globally)
    character_dimensions: {},
};

// ==================== EMPTY CHAT STATE ====================

function create_empty_chat_state() {
    return {
        data_version: MODULE_VERSION,      // Version of the scoring data format
        dimensions: [],                    // Active dimensions with targets and contexts
        calibration_hash: null,            // Hash of character description used for calibration
        score_history: [],                 // Array of { message_id, scores: { dim_id: 0.0-1.0 } }
        drift_state: {},                   // Per-dimension: { moving_avg, deviation, trend, correcting, severe, cusum_value, uncertainty }
        active_correction: { enabled: false },
        ceiling_dimensions: [],            // Dimension IDs that hit correction ceiling
        ceiling_model: null,
        cooldown_remaining: 0,
        recovery_cycles: 0,
        messages_scored: 0,
        corrections_injected: 0,
        ever_corrected_dimensions: [],     // Dimension IDs that were ever corrected
        ever_cusum_triggered: [],          // Dimension IDs where CUSUM ever triggered drift
        ever_ma_triggered: [],             // Dimension IDs where MA fallback triggered drift
        ma_consecutive_above: {},          // Per-dimension: consecutive scoring cycles with deviation > threshold (for MA fallback)
        cusum_reset_after: {},             // Per-dimension: message_id after which CUSUM restarts (prevents false re-triggers)
        last_scored_message_id: null,
        baseline_text: null,
        report: null,
    };
}

// ==================== MODULE STATE ====================

let CURRENT_DIMENSIONS = [];       // Active dimensions for current character
let CURRENT_DRIFT_STATE = {};
let SCORING_IN_PROGRESS = false;
let SCORING_QUEUE = [];
let CALIBRATION_IN_PROGRESS = false;
let PLUGIN_AVAILABLE = null; // null = unknown, true = available, false = unavailable
let PLUGIN_PROBE_TIMESTAMP = 0;
const PLUGIN_PROBE_TTL_MS = 300000; // 5 minutes

// Swipe re-score: message IDs pending re-score after swipe (Set to handle rapid consecutive swipes)
let PENDING_SWIPE_RESCORES = new Set();

// Popout state
let POPOUT_VISIBLE = false;
let POPOUT_LOCKED = false;
let $POPOUT = null;
let $DRAWER_CONTENT = null;

// ==================== UTILITY HELPERS ====================

function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

function error(...args) {
    console.error(LOG_PREFIX, ...args);
}

function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function compute_variance(arr) {
    if (!arr || arr.length < 2) return null;
    const m = mean(arr);
    return arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
}

/**
 * Compute exponential moving average. Recent scores are weighted more heavily.
 * alpha = 2 / (window + 1) — standard EMA smoothing factor.
 */
function ema(arr, window_size) {
    if (!arr || arr.length === 0) return 0;
    if (arr.length === 1) return arr[0];
    const safe_window = Math.max(1, window_size);
    const alpha = 2 / (safe_window + 1);
    let result = arr[0];
    for (let i = 1; i < arr.length; i++) {
        result = alpha * arr[i] + (1 - alpha) * result;
    }
    if (!Number.isFinite(result)) {
        warn(`EMA produced non-finite result (${result}) from ${arr.length} scores, window=${window_size}. Falling back to mean.`);
        return mean(arr);
    }
    return result;
}

/**
 * Scalar Kalman filter for score estimation.
 * Returns { estimate, uncertainty } — a smoothed current-value estimate
 * and a confidence interval width (±uncertainty for ~95% CI).
 *
 * @param {number[]} scores - Array of observed scores (0.0-1.0)
 * @param {number} R - Observation noise variance (~0.04 = 0.2 std dev, matching 0.25 rubric step)
 * @param {number} Q - Process noise variance (~0.005 = 0.07 std dev per step, gradual drift)
 * @returns {{ estimate: number, uncertainty: number }}
 */
function kalman_filter(scores, R = 0.04, Q = 0.005) {
    if (!scores || scores.length === 0) return { estimate: 0, uncertainty: 1 };
    if (scores.length === 1) return { estimate: scores[0], uncertainty: Math.sqrt(R) * 1.96 };

    // Initialize state from first observation
    let x = scores[0];       // State estimate
    let P = R;               // Estimate covariance (start uncertain)

    for (let i = 1; i < scores.length; i++) {
        // Predict
        // x_pred = x (no control input)
        const P_pred = P + Q;

        // Update
        const K = P_pred / (P_pred + R);  // Kalman gain
        x = x + K * (scores[i] - x);
        P = (1 - K) * P_pred;
    }

    // Guard against non-finite results
    if (!Number.isFinite(x) || !Number.isFinite(P)) {
        warn(`Kalman filter produced non-finite result (x=${x}, P=${P}) from ${scores.length} scores. Falling back to mean.`);
        return { estimate: mean(scores), uncertainty: 0.5 };
    }

    return {
        estimate: x,
        uncertainty: Math.sqrt(P) * 1.96,  // 95% CI half-width
    };
}

/** Valid discrete score levels for 5-point rubric scale. */
const DISCRETE_SCALE = [0.0, 0.25, 0.5, 0.75, 1.0];

/**
 * Snap a continuous value to the nearest discrete scale point.
 */
function snap_to_discrete(value) {
    return DISCRETE_SCALE.reduce((best, v) => Math.abs(v - value) < Math.abs(best - value) ? v : best);
}

/**
 * CUSUM (Cumulative Sum) for drift detection.
 * Accumulates deviation from target beyond a noise allowance.
 * Gradual persistent drift accumulates; random noise cancels out.
 *
 * Note: Uses Math.abs(x - target) intentionally to detect BOTH directional drift
 * and oscillation/instability. A character that swings wildly between 0.2 and 0.8
 * around a 0.5 target will accumulate CUSUM, which is desirable — instability in
 * characterization is itself a form of drift that warrants correction.
 */
function cusum(scores, target, allowance, decision_threshold) {
    if (!scores || scores.length === 0) return { cusum: 0, triggered: false };
    const EPSILON = 1e-6;
    let S = 0;
    for (const x of scores) {
        if (!Number.isFinite(x)) continue;
        S = Math.max(0, S + (Math.abs(x - target) - allowance));
    }
    return { cusum: S, triggered: S >= (decision_threshold - EPSILON) };
}

/**
 * Escape HTML entities to prevent XSS when inserting user/LLM content into innerHTML.
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Sanitize user/LLM-sourced text before embedding in analysis prompts.
 * Defangs common prompt injection patterns without destroying content meaning.
 * Applied to character descriptions, contexts, and other card-sourced data
 * before template substitution into calibration/scoring/correction prompts.
 */
function sanitize_for_prompt(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        // Defang system/instruction injection attempts (brackets with underscores, dashes, etc.)
        .replace(/\[SYSTEM[_\-\s]*[^\]]*\]/gi, '[system-note]')
        .replace(/\b(INSTRUCTION|IMPORTANT\s+NOTE|ASSISTANT\s+NOTE)\s*:/gi, 'note:')
        .replace(/\bSYSTEM\s*PROMPT\s*:/gi, 'system note:')
        .replace(/\bIGNORE\s+(ALL\s+)?(PREVIOUS|ABOVE|PRIOR|FOLLOWING)\s+(INSTRUCTIONS?|PROMPTS?|RULES?|CONTEXT)/gi, '[filtered]')
        .replace(/\b(BEGIN|START)\s+(NEW\s+)?(SYSTEM|INSTRUCTION|PROMPT)\b/gi, '[filtered]')
        // Prevent code block injection that could break prompt structure
        .replace(/```/g, "'''")
        // Prevent JSON injection that could break structured output
        .replace(/^\s*\{[\s\S]*"target"\s*:/m, '{ "note":')
        // Limit length to prevent context overflow attacks (15,000 characters)
        .substring(0, 15000);
}

/**
 * Generate a stable slug ID from a label string.
 * "Cold and calculating" -> "cold_and_calculating"
 */
function slugify(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Fisher-Yates shuffle — returns a new shuffled copy (does not mutate input).
 */
function shuffle_array(arr) {
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Split an array into chunks of at most `size` elements.
 */
function chunk_array(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/**
 * Get the current model ID from SillyTavern context.
 */
function get_current_model_id() {
    const context = getContext();
    return context.textgenerationSettings?.model
        || (context.oai_settings?.chat_completion_source && context.oai_settings?.openai_model)
        || 'unknown';
}

/**
 * Get the full character description by concatenating all relevant card fields.
 * Includes description, personality, scenario, mes_example, system_prompt, post_history_instructions.
 */
function get_full_character_description() {
    const context = getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return '';

    const sections = [
        ['Character Name', char.name || ''],
        ['Description', char.description],
        ['Personality', char.personality],
        ['Scenario', char.scenario],
        ['Example Messages', char.mes_example],
        ['System Prompt', char.system_prompt],
        ['Post-History Instructions', char.post_history_instructions],
    ];

    return sections
        .filter(([, text]) => text && text.trim().length > 0)
        .map(([label, text]) => `[${label}]\n${text.trim()}`)
        .join('\n\n');
}

/**
 * Get the current character's name for prompt isolation.
 */
function get_character_name() {
    const context = getContext();
    return context.characters?.[context.characterId]?.name || 'the character';
}

// ==================== SETTINGS HELPERS ====================

function initialize_settings() {
    if (!extension_settings[MODULE_NAME]) {
        log('Initializing settings...');
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    // Backfill any new settings added in updates
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
}

function get_settings(key) {
    return extension_settings[MODULE_NAME]?.[key] ?? DEFAULT_SETTINGS[key];
}

function set_settings(key, value) {
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

// ==================== CHAT STATE HELPERS ====================

function get_chat_state() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = create_empty_chat_state();
    }
    return chat_metadata[MODULE_NAME];
}

function save_chat_state(state) {
    chat_metadata[MODULE_NAME] = state;
    saveMetadataDebounced();
}

function save_drift_state(drift) {
    const state = get_chat_state();
    state.drift_state = drift;
    CURRENT_DRIFT_STATE = drift;
    save_chat_state(state);
}

// ==================== JSON EXTRACTION ====================

/**
 * Robust JSON extraction from LLM output.
 * Ported from Model-CharacterBias-Checker's _extract_json() pattern.
 * Handles: direct JSON, markdown code blocks, embedded JSON with brace matching.
 */
function extract_json(raw_text) {
    if (typeof raw_text !== 'string') {
        if (typeof raw_text === 'object') return raw_text;
        return null;
    }

    const text = raw_text.trim();

    // Try direct parse
    try {
        return JSON.parse(text);
    } catch { /* continue */ }

    // Try extracting from markdown code blocks
    const code_block_match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (code_block_match) {
        try {
            return JSON.parse(code_block_match[1].trim());
        } catch { /* continue */ }
    }

    // Find outermost { ... } or [ ... ] with proper brace matching
    const openers = ['{', '['];
    const closers = ['}', ']'];

    for (let oi = 0; oi < openers.length; oi++) {
        const opener = openers[oi];
        const closer = closers[oi];
        const start = text.indexOf(opener);
        if (start === -1) continue;

        let depth = 0;
        let in_string = false;
        let escape_next = false;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escape_next) {
                escape_next = false;
                continue;
            }
            if (ch === '\\') {
                escape_next = true;
                continue;
            }
            if (ch === '"') {
                in_string = !in_string;
                continue;
            }
            if (in_string) continue;

            if (ch === opener) depth++;
            else if (ch === closer) {
                depth--;
                if (depth === 0) {
                    const candidate = text.substring(start, i + 1);
                    try {
                        return JSON.parse(candidate);
                    } catch { break; }
                }
            }
        }
    }

    warn('Failed to extract JSON from response:', text.substring(0, 200));
    return null;
}

// ==================== ANALYSIS BACKEND ====================

/**
 * Call an OpenAI-compatible analysis endpoint.
 * Follows Context-Truncator's call_summary_endpoint() pattern.
 */
async function call_openai_analysis(messages, max_tokens = 500, expect_json = true) {
    const endpoint = get_settings('openai_endpoint');
    const api_key = get_settings('openai_api_key');
    const model = get_settings('openai_model');

    if (!endpoint) throw new Error('DriftGuard: OpenAI endpoint not configured');

    const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (api_key) headers['Authorization'] = `Bearer ${api_key}`;

    const payload = {
        messages: messages,
        max_tokens: max_tokens,
        temperature: 0.1,
        stream: false,
    };
    if (model) payload.model = model;
    if (expect_json) {
        payload.response_format = { type: 'json_object' };
    }

    // Retry with exponential backoff on 429/503
    const max_retries = 3;
    let last_error = null;

    for (let attempt = 0; attempt <= max_retries; attempt++) {
        if (attempt > 0) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
            await new Promise(r => setTimeout(r, delay));
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
            });

            if (response.status === 400 && expect_json) {
                // Many local servers don't support response_format -- retry without it
                delete payload.response_format;
                expect_json = false;
                continue;
            }

            if ((response.status === 429 || response.status === 503) && attempt < max_retries) {
                last_error = new Error(`Analysis API ${response.status} (retry ${attempt + 1})`);
                continue;
            }

            if (!response.ok) {
                const error_text = await response.text();
                throw new Error(`Analysis API ${response.status}: ${error_text.substring(0, 300)}`);
            }

            const data = await response.json();
            return data.choices?.[0]?.message?.content || '';
        } catch (err) {
            last_error = err;
            if (attempt >= max_retries) throw err;
        }
    }

    throw last_error || new Error('Analysis failed after retries');
}

/**
 * Call the Claude Code analysis backend via the DriftGuard server plugin.
 */
async function call_claude_code_analysis(messages, max_tokens = 500) {
    const model = get_settings('claude_code_model');

    // Expire cached availability after TTL
    if (PLUGIN_AVAILABLE !== null && Date.now() - PLUGIN_PROBE_TIMESTAMP > PLUGIN_PROBE_TTL_MS) {
        PLUGIN_AVAILABLE = null;
    }

    // Check cached availability
    if (PLUGIN_AVAILABLE === false) {
        throw new Error('DriftGuard server plugin not available. Install plugin/ to ST plugins/driftguard/');
    }
    if (PLUGIN_AVAILABLE === null) {
        try {
            const probe = await fetch('/api/plugins/driftguard/probe', { method: 'POST', headers: getRequestHeaders() });
            PLUGIN_AVAILABLE = probe.ok;
        } catch {
            PLUGIN_AVAILABLE = false;
        }
        PLUGIN_PROBE_TIMESTAMP = Date.now();
        if (!PLUGIN_AVAILABLE) throw new Error('DriftGuard server plugin not running.');
    }

    let response;
    const controller = new AbortController();
    const timeout_id = setTimeout(() => controller.abort(), 150000);
    try {
        response = await fetch('/api/plugins/driftguard/analyze', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                messages: messages,
                model: model || 'sonnet',
                max_tokens: max_tokens,
            }),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timeout_id);
        PLUGIN_AVAILABLE = null;
        if (err.name === 'AbortError') {
            throw new Error('Claude Code analysis timed out after 150s');
        }
        throw new Error(`Claude Code plugin unreachable: ${err.message}`);
    }
    clearTimeout(timeout_id);

    if (!response.ok) {
        const error_text = await response.text();
        if (response.status >= 502) PLUGIN_AVAILABLE = null;
        throw new Error(`Claude Code analysis failed (${response.status}): ${error_text.substring(0, 300)}`);
    }

    const data = await response.json();
    return data.content || '';
}

/**
 * Unified analysis interface. Routes to the configured backend.
 */
async function analyze(messages, max_tokens = 500, expect_json = true) {
    const backend = get_settings('analysis_backend');

    let raw_text;
    if (backend === 'claude_code') {
        raw_text = await call_claude_code_analysis(messages, max_tokens);
    } else {
        raw_text = await call_openai_analysis(messages, max_tokens, expect_json);
    }

    // Strip thinking model tags (e.g. <think>...</think>) before processing
    if (typeof raw_text === 'string') {
        raw_text = raw_text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

    return expect_json ? extract_json(raw_text) : raw_text;
}

/**
 * Test connection to the configured analysis backend.
 */
async function test_connection() {
    const backend = get_settings('analysis_backend');

    if (backend === 'claude_code') {
        // Probe the server plugin
        try {
            const response = await fetch('/api/plugins/driftguard/probe', { method: 'POST', headers: getRequestHeaders() });
            PLUGIN_AVAILABLE = response.ok;
            PLUGIN_PROBE_TIMESTAMP = Date.now();
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `HTTP ${response.status}`);
            }
            return { success: true, message: 'Claude Code plugin connected' };
        } catch (err) {
            PLUGIN_AVAILABLE = false;
            PLUGIN_PROBE_TIMESTAMP = Date.now();
            return { success: false, message: `Plugin error: ${err.message}` };
        }
    } else {
        // Probe the OpenAI endpoint with a minimal request
        try {
            const messages = [{ role: 'user', content: 'Respond with: {"status":"ok"}' }];
            const result = await call_openai_analysis(messages, 50, true);
            return { success: true, message: 'OpenAI endpoint connected' };
        } catch (err) {
            return { success: false, message: `Endpoint error: ${err.message}` };
        }
    }
}

// ==================== DIMENSION CALIBRATION ====================

/**
 * Hash a character description for cache invalidation.
 */
function hash_description(description) {
    return getStringHash(description || '');
}

/**
 * Build the dimensions list text for the calibration prompt.
 */
function build_dimensions_list_text() {
    return DIMENSION_CATALOG.map(d =>
        `- ${d.id}: ${d.label} — ${d.low_label} (0.0) to ${d.high_label} (1.0)\n  ${d.description}`
    ).join('\n');
}

/**
 * Get the character key for per-character dimension storage.
 */
function get_character_key() {
    const context = getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return null;
    const name = char.name || 'unknown';
    const desc_hash = hash_description(get_full_character_description());
    return `${name}_${desc_hash}`;
}

/**
 * Load pinned dimension calibration for the current character from global settings.
 * Returns null if no calibration exists or card has changed.
 */
function load_pinned_calibration() {
    const char_key = get_character_key();
    if (!char_key) return null;

    const all_calibrations = get_settings('character_dimensions') || {};
    const pinned = all_calibrations[char_key];
    if (!pinned || !pinned.dimensions) return null;

    const current_hash = hash_description(get_full_character_description());
    if (pinned.card_hash !== current_hash) {
        log('Card changed since last calibration, will recalibrate');
        return null;
    }

    return pinned.dimensions;
}

/**
 * Save dimension calibration for the current character to global settings.
 */
function save_pinned_calibration(dimensions) {
    const char_key = get_character_key();
    if (!char_key) return;

    const all_calibrations = get_settings('character_dimensions') || {};
    all_calibrations[char_key] = {
        dimensions: dimensions,
        calibrated_at: Date.now(),
        card_hash: hash_description(get_full_character_description()),
    };
    set_settings('character_dimensions', all_calibrations);
}

/**
 * Resolve a raw calibration result (dimension ID → {target, context} or null)
 * into an array of active dimension objects with full catalog data.
 */
function resolve_dimensions(raw_calibration) {
    const active = [];

    for (const dim of DIMENSION_CATALOG) {
        const cal = raw_calibration[dim.id];
        if (cal === null || cal === undefined) continue;

        // Validate calibration entry structure
        if (typeof cal !== 'object') {
            warn(`Invalid calibration entry for "${dim.id}": expected object, got ${typeof cal}`);
            continue;
        }

        const raw_target = cal.target;
        if (raw_target === null || raw_target === undefined) continue; // Dimension intentionally skipped

        const target = typeof raw_target === 'number' && Number.isFinite(raw_target)
            ? Math.max(0, Math.min(1, raw_target))
            : 0.5;

        const context = typeof cal.context === 'string' ? cal.context.substring(0, 500) : '';

        active.push({
            ...dim,
            target: target,
            context: context,
        });
    }

    return active;
}

/**
 * Calibrate dimension targets for a character using the analysis backend.
 * Returns array of active dimension objects with targets and contexts.
 */
async function calibrate_dimensions(character_description) {
    if (!character_description || character_description.trim().length === 0) {
        warn('No character description provided for calibration');
        return [];
    }

    const prompt = CALIBRATION_PROMPT
        .replace(/\{\{character_name\}\}/g, sanitize_for_prompt(get_character_name()))
        .replace('{{dimensions_list}}', build_dimensions_list_text())
        .replace('{{description}}', sanitize_for_prompt(character_description));

    const messages = [
        { role: 'system', content: 'You are a character analyst. Respond only in valid JSON.' },
        { role: 'user', content: prompt },
    ];

    let result = await analyze(messages, 4000);

    // Some models wrap the response in an array — unwrap single-element arrays
    if (Array.isArray(result) && result.length === 1 && typeof result[0] === 'object') {
        result = result[0];
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        error('Calibration did not return a valid object:', result);
        return [];
    }

    const active = resolve_dimensions(result);

    if (active.length === 0) {
        warn('Calibration returned no active dimensions');
        return [];
    }

    log(`Calibrated ${active.length} dimensions:`, active.map(d => `${d.id}=${d.target.toFixed(2)}`));
    return active;
}

// ==================== SCORING ====================

/**
 * Count AI messages since the last scored message.
 */
function count_ai_messages_since_last_score() {
    const state = get_chat_state();
    const chat = getContext().chat;
    if (!chat) return 0;

    const last_scored_id = state.last_scored_message_id;
    let count = 0;

    for (let i = chat.length - 1; i >= 0; i--) {
        if (last_scored_id !== null && i <= last_scored_id) break;
        if (!chat[i].is_user && !chat[i].is_system) count++;
    }

    return count;
}

/**
 * Determine if a message should be scored based on frequency settings.
 */
function should_score_message() {
    const freq = get_settings('score_frequency');
    const state = get_chat_state();

    // Always score the first AI response
    if (state.messages_scored === 0 && get_settings('score_on_first')) return true;

    // Score every Nth AI message
    const ai_count = count_ai_messages_since_last_score();
    return ai_count >= freq;
}

/**
 * Detect if a message is the character's greeting (message #0, written by the card author).
 * Greeting messages should not be scored as they reflect the author's writing, not the model's.
 */
function is_greeting_message(message, message_index) {
    // Message #0 is always the greeting
    if (message_index === 0) return true;

    // Cross-reference with the character's first_mes field
    const context = getContext();
    const first_mes = context.characters?.[context.characterId]?.first_mes;
    if (first_mes && message.mes && message.mes.trim() === first_mes.trim()) return true;

    // Fallback: if no messages have been scored yet and this is index 0
    const state = get_chat_state();
    if (state.messages_scored === 0 && message_index === 0) return true;

    return false;
}

/**
 * Detect if a message is out-of-character (OOC).
 * OOC messages should not be scored as they don't reflect character behavior.
 */
function is_ooc_message(message_text) {
    if (!message_text || message_text.trim().length === 0) return false;
    const text = message_text.trim();

    // Full message wrapped in (( ))
    if (/^\(\([\s\S]*\)\)$/.test(text)) return true;

    // [OOC] or OOC: prefix
    if (/^\[OOC\]/i.test(text) || /^OOC:/i.test(text)) return true;

    // // prefix (common OOC convention)
    if (text.startsWith('//')) return true;

    // Partial OOC: >50% of text is inside (( )) markers
    const ooc_matches = text.match(/\(\([\s\S]*?\)\)/g);
    if (ooc_matches) {
        const ooc_length = ooc_matches.reduce((sum, m) => sum + m.length, 0);
        if (ooc_length / text.length > 0.5) return true;
    }

    return false;
}

/**
 * Score an AI response for position on each active dimension.
 */
async function score_response(response_text, dimensions, char_description, message_index) {
    // Truncate long responses to avoid overflowing the analysis model's context
    const MAX_RESPONSE_LENGTH = 1500;
    let scoring_text = response_text || '';
    if (scoring_text.length > MAX_RESPONSE_LENGTH) {
        const HEAD = 800;
        const TAIL = 700;
        scoring_text = scoring_text.substring(0, HEAD) + '\n[...truncated...]\n' + scoring_text.substring(scoring_text.length - TAIL);
        log(`Response truncated for scoring: ${response_text.length} -> ${scoring_text.length} chars`);
    }

    const char_name = get_character_name();
    const char_desc_text = char_description || '';

    // Build recent conversation context (last 6 messages before the scored response)
    const context_chat = getContext().chat || [];
    const ctx_end = message_index !== undefined ? message_index : context_chat.length - 1;
    const recent_messages = context_chat.slice(Math.max(0, ctx_end - 6), ctx_end);
    const recent_context = recent_messages.length > 0
        ? recent_messages.map(m => {
            const text = m.mes || '';
            let truncated;
            if (text.length > 500) {
                truncated = text.substring(0, 300) + '\n[...]\n' + text.substring(text.length - 200);
            } else {
                truncated = text;
            }
            const speaker = m.is_user ? (getContext().name1 || 'User') : char_name;
            return `${speaker}: ${truncated}`;
        }).join('\n')
        : '(No prior messages available)';

    // Split dimensions into shuffled chunks of 4 for scoring isolation.
    // Scoring each chunk independently eliminates halo effects (one dimension's
    // score influencing adjacent dimensions) and positional bias.
    const CHUNK_SIZE = 4;
    const shuffled_dims = shuffle_array(dimensions);
    const chunks = chunk_array(shuffled_dims, CHUNK_SIZE);
    log(`Scoring ${dimensions.length} dimensions in ${chunks.length} chunk(s)`);

    const id_scores = {};
    const na_dims = new Set();
    const all_reasoning = [];

    // Score each chunk sequentially to avoid rate limiting
    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];

        // Build dimension descriptions with rubric anchors for this chunk
        const dimensions_with_rubrics = chunk.map(d => {
            const ctx = d.context ? `\n  Character context: ${d.context}` : '';
            const target_note = d.target !== undefined ? `\n  Calibrated target: ${d.target.toFixed(2)}` : '';
            const rubric_text = Object.entries(d.rubric)
                .map(([level, desc]) => `    ${level}: ${desc}`)
                .join('\n');
            return `- ${d.id}: ${d.low_label} (0.0) <-> ${d.high_label} (1.0)\n  ${d.scoring_guidance}${target_note}${ctx}\n  Rubric:\n${rubric_text}`;
        }).join('\n\n');

        const prompt = SCORING_PROMPT
            .replace(/\{\{character_name\}\}/g, sanitize_for_prompt(char_name))
            .replace('{{character_description}}', sanitize_for_prompt(char_desc_text))
            .replace('{{recent_context}}', recent_context)
            .replace('{{dimensions_with_rubrics}}', dimensions_with_rubrics)
            .replace('{{response_text}}', scoring_text);

        const messages = [
            { role: 'system', content: `You are a character analyst. Score only ${char_name}'s behavior on dimensional rubrics. Provide reasoning then JSON scores.` },
            { role: 'user', content: prompt },
        ];

        try {
            // expect_json=false to allow CoT reasoning before JSON output
            const raw_text = await analyze(messages, 4000, false);

            // Extract JSON scores from the CoT + JSON response
            const raw_scores = extract_json(raw_text);

            if (!raw_scores || typeof raw_scores !== 'object') {
                warn(`Chunk ${ci + 1}/${chunks.length} did not return a valid object — skipping chunk`);
                continue;
            }

            // Collect CoT reasoning for debugging
            if (typeof raw_text === 'string') {
                const json_start = raw_text.indexOf('{');
                if (json_start > 0) {
                    all_reasoning.push(raw_text.substring(0, json_start).trim());
                }
            }

            // Extract scores by dimension ID and snap to discrete scale
            for (const dim of chunk) {
                const score = raw_scores[dim.id];

                // Handle null (N/A) — dimension not observable in this scene
                if (score === null) {
                    na_dims.add(dim.id);
                    continue;
                }

                if (score !== undefined) {
                    const parsed = parseFloat(score);
                    if (Number.isNaN(parsed)) {
                        warn(`Non-numeric score for "${dim.id}": ${JSON.stringify(score)} -- skipping`);
                        continue;
                    }
                    id_scores[dim.id] = snap_to_discrete(Math.max(0, Math.min(1, parsed)));
                }
            }

            log(`Chunk ${ci + 1}/${chunks.length}: scored ${chunk.filter(d => id_scores[d.id] !== undefined).map(d => d.id).join(', ') || '(none)'}`);
        } catch (err) {
            warn(`Chunk ${ci + 1}/${chunks.length} scoring failed: ${err.message} — skipping chunk`);
        }
    }

    const unscored = dimensions.filter(d => id_scores[d.id] === undefined && !na_dims.has(d.id));
    if (unscored.length > 0) {
        warn(`${unscored.length}/${dimensions.length} dimensions unscored: ${unscored.map(d => d.id).join(', ')}`);
    }
    log(`${na_dims.size} dimensions N/A, ${Object.keys(id_scores).length} dimensions scored`);

    // Attach combined reasoning to the return value for storage
    id_scores._reasoning = all_reasoning.length > 0 ? all_reasoning.join('\n---\n') : null;

    return id_scores;
}

/**
 * Store scores in both per-message data and chat-level history.
 */
function store_scores(message, message_index, scores) {
    const state = get_chat_state();

    // Separate reasoning from scores before storing
    const reasoning = scores._reasoning || null;
    const clean_scores = { ...scores };
    delete clean_scores._reasoning;

    // Per-message data
    if (!message.extra) message.extra = {};
    message.extra.driftguard = {
        scored: true,
        scores: clean_scores,
        correction_active: state.active_correction?.enabled || false,
        reasoning: reasoning,
    };

    // Chat-level score history
    state.score_history.push({
        message_id: message_index,
        timestamp: Date.now(),
        scores: clean_scores,
        content_hash: getStringHash((message.mes || '').substring(0, 200)),
    });

    // Cap score history to prevent unbounded growth (immutable to avoid race conditions)
    const MAX_SCORE_HISTORY = 200;
    if (state.score_history.length > MAX_SCORE_HISTORY) {
        state.score_history = state.score_history.slice(-MAX_SCORE_HISTORY);
    }

    state.last_scored_message_id = message_index;
    save_chat_state(state);
}

// ==================== DRIFT DETECTION ====================

/**
 * Compute drift state for each dimension using distance-from-target.
 * Drift is bidirectional: a character can drift in either direction on any dimension.
 */
function update_drift_state(dimensions, score_history, cusum_reset_after = {}) {
    const drift_window = get_settings('drift_window');
    const threshold = get_settings('drift_threshold');        // Max allowed deviation from target
    const alert_threshold = get_settings('drift_alert_threshold');  // Severe deviation
    const drift_state = {};

    // CUSUM parameters derived from existing settings.
    // Allowance (slack): half the threshold, floored at 0.125 (one half-step on the discrete scale).
    //   This means deviations smaller than the allowance are treated as noise and don't accumulate.
    // Decision threshold: proportional to allowance * window. The 0.8 multiplier means ~80% of the
    //   window must show above-allowance deviation to trigger. With defaults (threshold=0.20, window=8):
    //   allowance=0.10, decision=0.64 → requires ~4-5 scores deviating by 0.25 to trigger.
    // Severe uses a lower window multiplier (0.5) to trigger faster for high deviations.
    const allowance = Math.max(threshold * 0.5, 0.125);
    const base_decision_threshold = allowance * drift_window * 0.8;
    const severe_allowance = Math.max(alert_threshold * 0.5, 0.125);
    const base_severe_decision = severe_allowance * drift_window * 0.5;

    // Multiple-comparisons correction (log-sqrt scaling for correlated dimensions).
    // With 11 dimensions: factor ≈ 1.89, requiring ~6-7 above-allowance deviations instead of ~4-5.
    // Uses sqrt(log2(n+1)) instead of sqrt(n) to remain effective in typical session lengths (10-20 scored messages).
    const bonferroni_factor = dimensions.length > 1 ? Math.sqrt(Math.log2(dimensions.length + 1)) : 1;
    const decision_threshold = base_decision_threshold * bonferroni_factor;
    const severe_decision = base_severe_decision * bonferroni_factor;

    for (const dim of dimensions) {
        // Kalman window: last drift_window scores (for smoothed estimate + uncertainty)
        const recent_scores = score_history
            .slice(-drift_window)
            .map(entry => entry.scores[dim.id])
            .filter(s => s !== undefined);

        // CUSUM window: broader context (last drift_window * 2 scores).
        // If a CUSUM reset marker exists for this dimension, filter to only scores after the reset point.
        const reset_after_id = cusum_reset_after[dim.id];
        let cusum_history = score_history.slice(-(drift_window * 2));
        if (reset_after_id !== undefined && reset_after_id !== null) {
            cusum_history = cusum_history.filter(entry => entry.message_id > reset_after_id);
        }
        const cusum_scores = cusum_history
            .map(entry => entry.scores[dim.id])
            .filter(s => s !== undefined);

        if (recent_scores.length === 0) {
            drift_state[dim.id] = { moving_avg: null, deviation: null, trend: 'no_data', correcting: false, severe: false, cusum_value: 0, uncertainty: 1 };
            continue;
        }

        // Kalman filter for smoothed estimate and uncertainty
        const kalman = kalman_filter(recent_scores);
        const moving_avg = kalman.estimate;
        const uncertainty = kalman.uncertainty;

        // Guard against NaN/Infinity propagation from corrupt scores
        if (!Number.isFinite(moving_avg)) {
            warn(`Non-finite moving average for ${dim.id}: ${moving_avg} from ${recent_scores.length} scores`);
            drift_state[dim.id] = { moving_avg: null, deviation: null, trend: 'error', correcting: false, severe: false, cusum_value: 0, uncertainty: 1 };
            continue;
        }

        const deviation = Math.abs(moving_avg - dim.target);

        if (recent_scores.length < MIN_SCORES_FOR_CORRECTION) {
            drift_state[dim.id] = {
                moving_avg,
                deviation,
                trend: 'insufficient_data',
                correcting: false,
                severe: false,
                cusum_value: 0,
                uncertainty,
            };
            continue;
        }

        // Trend: are recent scores moving toward or away from the target?
        // Use ceil to ensure the first half is >= the second half in size, avoiding asymmetric comparison
        const mid = Math.ceil(recent_scores.length / 2);
        const first_half_dev = Math.abs(mean(recent_scores.slice(0, mid)) - dim.target);
        const second_half_dev = Math.abs(mean(recent_scores.slice(mid)) - dim.target);
        const trend = second_half_dev > first_half_dev + 0.03 ? 'drifting'
            : second_half_dev < first_half_dev - 0.03 ? 'correcting'
            : 'stable';

        // CUSUM for drift trigger decisions (uses Bonferroni-adjusted thresholds)
        const cusum_result = cusum(cusum_scores, dim.target, allowance, decision_threshold);
        const severe_result = cusum(cusum_scores, dim.target, severe_allowance, severe_decision);

        drift_state[dim.id] = {
            moving_avg,
            deviation,
            trend,
            correcting: cusum_result.triggered,
            severe: severe_result.triggered,
            cusum_value: cusum_result.cusum,
            uncertainty,
        };
    }

    return drift_state;
}

/**
 * Compute per-dimension averages using only scores recorded AFTER a correction was injected.
 * Used for evaluating correction effectiveness.
 */
function compute_post_correction_averages(dim_ids, score_history, since_message) {
    const averages = {};
    for (const dim_id of dim_ids) {
        const post_scores = score_history
            .filter(entry => entry.message_id > since_message)
            .map(entry => entry.scores[dim_id])
            .filter(s => s !== undefined);

        averages[dim_id] = post_scores.length > 0 ? mean(post_scores) : null;
    }
    return averages;
}

// ==================== CORRECTION GENERATION & INJECTION ====================

/**
 * Generate a behavioral correction using the analysis backend.
 * drifting_dims: array of { dim_id, moving_avg, deviation, trend } for dimensions needing correction
 * all_dimensions: full array of active dimension objects with targets
 */
async function generate_correction(drifting_dims, all_dimensions, char_description, chat, scoring_evidence, escalation_context) {
    const max = get_settings('correction_max_dimensions');
    const threshold = get_settings('drift_threshold');
    const worst = [...drifting_dims]
        .sort((a, b) => b.deviation - a.deviation)  // Sort by worst deviation
        .slice(0, max);

    // Compute graded correction intensity from deviation ratio.
    // Uses the worst dimension's deviation relative to the threshold.
    const worst_deviation = worst.length > 0 ? Math.max(...worst.map(d => d.deviation || 0)) : 0;
    const deviation_ratio = threshold > 0 ? worst_deviation / threshold : 1;

    let intensity;
    if (deviation_ratio < 1.3) {
        intensity = 'SUBTLE';
    } else if (deviation_ratio < 1.8) {
        intensity = 'MODERATE';
    } else {
        intensity = 'STRONG';
    }

    // Escalation context forces at least MODERATE intensity
    if (escalation_context && intensity === 'SUBTLE') {
        intensity = 'MODERATE';
    }

    // Trend-aware downgrade: if most drifting dims show 'correcting' trend, reduce intensity one level
    const correcting_count = worst.filter(d => d.trend === 'correcting').length;
    if (correcting_count > worst.length / 2 && !escalation_context) {
        if (intensity === 'STRONG') intensity = 'MODERATE';
        else if (intensity === 'MODERATE') intensity = 'SUBTLE';
    }

    log(`Correction intensity: ${intensity} (deviation ratio: ${deviation_ratio.toFixed(2)}, correcting: ${correcting_count}/${worst.length})`);

    const intensity_instructions = {
        'SUBTLE': 'INTENSITY: SUBTLE — Write 1-2 sentences. Use gentle, indirect behavioral cues. Light touch only.',
        'MODERATE': 'INTENSITY: MODERATE — Write 2-3 sentences. Use clear behavioral cues with specific mannerisms and speech patterns.',
        'STRONG': 'INTENSITY: STRONG — Write 3-4 sentences. Use vivid, concrete behavioral cues with physical responses, speech patterns, and emotional grounding.',
    };
    const intensity_block = intensity_instructions[intensity];

    // Describe drifting dimensions with direction
    const drifting_descriptions = worst.map(dd => {
        const dim = all_dimensions.find(d => d.id === dd.dim_id);
        if (!dim) return '';
        const direction = dd.moving_avg > dim.target ? `too high (toward ${dim.high_label})` : `too low (toward ${dim.low_label})`;
        const ctx = dim.context ? ` — ${dim.context}` : '';
        return `- ${dim.label}: target=${dim.target.toFixed(2)}, current=${(dd.moving_avg || 0).toFixed(2)} (${direction})${ctx}`;
    }).filter(Boolean).join('\n');

    const char_name = get_character_name();
    const recent_context = (chat || [])
        .slice(-6)
        .map(m => {
            const speaker = m.is_user ? (getContext().name1 || 'User') : char_name;
            return `${speaker}: ${(m.mes || '').substring(0, 300)}`;
        })
        .join('\n');

    const window_size = get_settings('drift_window');
    const state = get_chat_state();
    const evidence = worst.map(dd => {
        const dim = all_dimensions.find(d => d.id === dd.dim_id);
        const window_scores = (state.score_history || [])
            .slice(-window_size)
            .map(s => s.scores?.[dd.dim_id])
            .filter(s => s !== undefined && Number.isFinite(s));
        const first_in_window = window_scores.length > 0 && Number.isFinite(window_scores[0]) ? window_scores[0].toFixed(2) : '?';
        const label = dim?.label || dd.dim_id;
        return `${label}: moved from ~${first_in_window} to ${(dd.moving_avg || 0).toFixed(2)} (target: ${dim?.target?.toFixed(2) || '?'}) over ${window_scores.length} scored messages`;
    }).join('\n');

    let escalation_block = '';
    if (escalation_context) {
        const dev_before = escalation_context.deviation_at_correction !== undefined
            ? escalation_context.deviation_at_correction.toFixed(2) : '?';
        const dev_after = escalation_context.deviation_after !== undefined
            ? escalation_context.deviation_after.toFixed(2) : '?';
        const delta = (escalation_context.deviation_after !== undefined && escalation_context.deviation_at_correction !== undefined)
            ? (escalation_context.deviation_after < escalation_context.deviation_at_correction - 0.02 ? 'slight improvement'
                : escalation_context.deviation_after > escalation_context.deviation_at_correction + 0.02 ? 'worsened'
                : 'no change')
            : 'unknown';
        escalation_block = `IMPORTANT: A previous correction (attempt ${escalation_context.attempt || 1} of ${escalation_context.patience || '?'}) was already attempted but the character continued to drift.
Deviation was ${dev_before} at injection. After ${escalation_context.attempt || 1} scored messages, deviation is now ${dev_after} (${delta}).
The previous correction was:
${escalation_context.previous_text}
Generate a DIFFERENT correction with stronger behavioral anchoring. Use more specific, concrete behavioral cues. Include physical response patterns and speech mannerisms.`;
    }

    // Build full dimensional profile for context
    const all_dims_text = all_dimensions.map(d => {
        const drift_info = drifting_dims.find(dd => dd.dim_id === d.id);
        const status = drift_info ? 'DRIFTING' : 'ON TARGET';
        const ctx = d.context ? ` — ${d.context}` : '';
        return `- ${d.label}: ${d.low_label} (0.0) ↔ ${d.high_label} (1.0), target=${d.target.toFixed(2)}${ctx} [${status}]`;
    }).join('\n');

    const prompt = CORRECTION_GENERATION_PROMPT
        .replace(/\{\{character_name\}\}/g, sanitize_for_prompt(char_name))
        .replace('{{intensity_block}}', intensity_block)
        .replace('{{description}}', sanitize_for_prompt(char_description || ''))
        .replace('{{all_dimensions}}', all_dims_text)
        .replace('{{drifting_dimensions}}', drifting_descriptions)
        .replace('{{recent_context}}', recent_context)
        .replace('{{drift_evidence}}', evidence)
        .replace('{{escalation_block}}', escalation_block);

    const messages = [
        { role: 'system', content: 'You write brief behavioral Author\'s Notes for roleplay character steering. Output ONLY the note text.' },
        { role: 'user', content: prompt },
    ];

    const result = await analyze(messages, 2000, false); // expect_json=false: corrections are prose
    return typeof result === 'string' ? result.trim() : String(result).trim();
}

/**
 * Inject correction text as an Author's Note via SillyTavern's extension prompt system.
 */
function inject_correction(correction_text) {
    const configured_depth = get_settings('correction_depth');
    const context = getContext();
    if (!context.chat || context.characterId === undefined) {
        warn('Cannot inject correction: no active chat context');
        return;
    }
    const chat_length = context.chat?.length || 0;
    const depth = Math.min(configured_depth, Math.max(1, Math.floor(chat_length / 2)));

    context.setExtensionPrompt(
        'driftguard_correction',
        correction_text,
        extension_prompt_types.IN_PROMPT,
        depth,
        false,                           // Not scannable
        extension_prompt_roles.SYSTEM,   // System role
    );

    log('Correction injected at depth', depth, `(configured: ${configured_depth}, chat length: ${chat_length})`);
}

/**
 * Remove the current correction injection.
 * Optionally resets state.active_correction if a state object is provided,
 * ensuring the prompt injection and state are always cleared atomically.
 * @param {object} [state] - If provided, also resets state.active_correction
 */
function clear_correction(state) {
    const context = getContext();
    context.setExtensionPrompt('driftguard_correction', '', extension_prompt_types.IN_PROMPT, 0);
    if (state) {
        state.active_correction = { enabled: false };
    }
    log('Correction cleared');
}

// ==================== BASELINE AUTHOR'S NOTE ====================

/**
 * Generate a lightweight baseline Author's Note from calibrated dimensions.
 * This provides continuous behavioral anchoring to prevent drift before it starts.
 */
async function generate_baseline(dimensions, char_description) {
    if (!dimensions || dimensions.length === 0) return null;

    // Sort dimensions by deviation from AI defaults (largest first) so the baseline
    // prompt naturally focuses on the most atypical dimensions for this character
    const sorted_dims = [...dimensions].sort((a, b) => {
        const dev_a = Math.abs(a.target - (a.ai_default ?? 0.5));
        const dev_b = Math.abs(b.target - (b.ai_default ?? 0.5));
        return dev_b - dev_a;
    });
    const dimensions_summary = sorted_dims.map(d => {
        const pos = d.target <= 0.3 ? d.low_label : d.target >= 0.7 ? d.high_label : `between ${d.low_label} and ${d.high_label}`;
        const ai_def = d.ai_default ?? 0.5;
        const deviation = Math.abs(d.target - ai_def);
        const ctx = d.context ? ` — ${d.context}` : '';
        const deviation_note = deviation >= 0.2 ? ` [DEVIATES from AI default ${ai_def.toFixed(2)}]` : '';
        return `- ${d.label}: ${pos} (target: ${d.target.toFixed(2)})${deviation_note}${ctx}`;
    }).join('\n');

    const prompt = BASELINE_GENERATION_PROMPT
        .replace(/\{\{character_name\}\}/g, sanitize_for_prompt(get_character_name()))
        .replace('{{description}}', sanitize_for_prompt(char_description || ''))
        .replace('{{dimensions_summary}}', dimensions_summary);

    const messages = [
        { role: 'system', content: 'You write brief behavioral Author\'s Notes for roleplay character anchoring. Output ONLY the note text.' },
        { role: 'user', content: prompt },
    ];

    const result = await analyze(messages, 2000, false);
    return typeof result === 'string' ? result.trim() : String(result).trim();
}

/**
 * Inject baseline Author's Note via SillyTavern's extension prompt system.
 * Uses a separate prompt key from corrections so both can coexist.
 */
function inject_baseline(baseline_text) {
    if (!baseline_text) return;
    const depth = get_settings('baseline_depth');
    const context = getContext();

    context.setExtensionPrompt(
        'driftguard_baseline',
        baseline_text,
        extension_prompt_types.IN_PROMPT,
        depth,
        false,
        extension_prompt_roles.SYSTEM,
    );

    log('Baseline Author\'s Note injected at depth', depth);
}

/**
 * Remove the baseline Author's Note injection.
 */
function clear_baseline() {
    const context = getContext();
    context.setExtensionPrompt('driftguard_baseline', '', extension_prompt_types.IN_PROMPT, 0);
    log('Baseline cleared');
}

// ==================== GENERATE INTERCEPTOR ====================

/**
 * SillyTavern generate interceptor -- called before each generation.
 * Deliberately lightweight: only injects pre-computed corrections.
 * All heavy work (scoring, drift detection, correction generation) happens
 * in on_message_received() (Section: MESSAGE RECEIVED HANDLER).
 */
globalThis.driftguard_intercept_generate = async function (chat, contextSize, abort, type) {
    if (!get_settings('enabled')) return;

    const state = get_chat_state();
    if (!state.dimensions || state.dimensions.length === 0) return;

    const has_active_correction = state.active_correction?.enabled && state.active_correction?.injection_text;

    // Inject baseline Author's Note if enabled and available
    if (get_settings('baseline_enabled') && state.baseline_text) {
        inject_baseline(state.baseline_text);
    }

    // Inject pre-computed correction if one is active
    if (has_active_correction) {
        inject_correction(state.active_correction.injection_text);
    }
};

// ==================== MESSAGE RECEIVED HANDLER ====================

/**
 * Main scoring and correction pipeline.
 * Called after each AI response is displayed (non-blocking).
 */
/**
 * Core scoring + post-processing pipeline.
 * Scores a message, stores results, updates drift state, handles corrections.
 * Used by on_message_received, Score Now button, and swipe re-score.
 *
 * @param {number} message_index - Chat message index to score
 * @param {object} options
 * @param {boolean} options.force - If true, bypass should_score_message() check
 */
async function score_and_process_message(message_index, { force = false } = {}) {
    const state = get_chat_state();
    if (!state.dimensions || state.dimensions.length === 0) {
        if (force) toastr.warning('No dimensions calibrated yet.', MODULE_NAME_FANCY);
        return;
    }

    // Clear ceiling if model has changed since ceiling was set
    if (state.ceiling_dimensions?.length > 0 && state.ceiling_model) {
        const current_model = get_current_model_id();
        if (current_model !== state.ceiling_model && current_model !== 'unknown') {
            const cleared_labels = state.ceiling_dimensions.map(id =>
                state.dimensions.find(d => d.id === id)?.label || id);
            const old_model = state.ceiling_model;
            state.ceiling_dimensions = [];
            state.ceiling_model = null;
            save_chat_state(state);
            toastr.info(
                `Model changed (${old_model} → ${current_model}). Ceiling cleared for: ${cleared_labels.join(', ')}`,
                MODULE_NAME_FANCY,
            );
        }
    }

    const chat = getContext().chat;
    const message = chat?.[message_index];
    if (!message || message.is_user || message.is_system) {
        if (force) toastr.warning('No valid AI message to score.', MODULE_NAME_FANCY);
        return;
    }

    if (is_greeting_message(message, message_index)) {
        if (force) toastr.warning('Cannot score the greeting message (card author content).', MODULE_NAME_FANCY);
        else log(`Skipping greeting message #${message_index} (card author content)`);
        return;
    }

    if (is_ooc_message(message.mes)) {
        if (force) toastr.warning('Cannot score an OOC message.', MODULE_NAME_FANCY);
        else log(`Skipping OOC message #${message_index}`);
        return;
    }

    if (!force && !should_score_message()) return;

    SCORING_IN_PROGRESS = true;
    try {
        const char_desc = get_full_character_description();
        const scores = await score_response(message.mes, state.dimensions, char_desc, message_index);

        const score_keys = Object.keys(scores).filter(k => k !== '_reasoning');
        if (score_keys.length === 0) {
            warn('Scoring returned empty results, skipping this cycle');
            if (force) toastr.warning('Scoring returned empty results.', MODULE_NAME_FANCY);
            return;
        }

        store_scores(message, message_index, scores);
        state.messages_scored++;

        // Warn user about persistently unscored dimensions
        const consecutive_threshold = 3;
        for (const dim of state.dimensions) {
            const recent = state.score_history.slice(-consecutive_threshold);
            const all_missing = recent.length >= consecutive_threshold &&
                recent.every(entry => entry.scores[dim.id] === undefined);
            if (all_missing) {
                toastr.warning(
                    `"${dim.label}" has not been scored in the last ${consecutive_threshold} cycles.`,
                    MODULE_NAME_FANCY,
                    { preventDuplicates: true },
                );
            }
        }

        const drift = update_drift_state(state.dimensions, state.score_history, state.cusum_reset_after || {});
        save_drift_state(drift);
        update_dashboard();
        update_message_badges();

        if (!get_settings('correction_enabled')) {
            save_chat_state(state);
            return;
        }

        // Filter out ceiling-reached dimensions; drifting = CUSUM-triggered dimensions
        const threshold = get_settings('drift_threshold');
        const ceiling = state.ceiling_dimensions || [];
        const drifting = Object.entries(drift)
            .filter(([dim_id, d]) => d.correcting && !ceiling.includes(dim_id))
            .map(([dim_id, d]) => ({ dim_id, ...d }));

        // MA fallback trigger: catch obvious drift that CUSUM is too slow to accumulate on.
        // If a dimension's moving-average deviation exceeds the threshold for >= 3 consecutive
        // scoring cycles (and CUSUM hasn't triggered), treat it as drifting.
        const MA_CONSECUTIVE_REQUIRED = 3;
        if (!state.ma_consecutive_above) state.ma_consecutive_above = {};
        const cusum_triggered_ids_set = new Set(drifting.map(d => d.dim_id));
        for (const [dim_id, d] of Object.entries(drift)) {
            if (ceiling.includes(dim_id) || cusum_triggered_ids_set.has(dim_id)) {
                // Already handled by CUSUM or ceiling — reset MA counter
                state.ma_consecutive_above[dim_id] = 0;
                continue;
            }
            if (d.deviation !== null && d.deviation > threshold && d.trend !== 'no_data' && d.trend !== 'insufficient_data') {
                state.ma_consecutive_above[dim_id] = (state.ma_consecutive_above[dim_id] || 0) + 1;
            } else {
                state.ma_consecutive_above[dim_id] = 0;
            }
            if (state.ma_consecutive_above[dim_id] >= MA_CONSECUTIVE_REQUIRED) {
                log(`MA fallback trigger: ${dim_id} deviation ${d.deviation?.toFixed(3)} > ${threshold} for ${state.ma_consecutive_above[dim_id]} consecutive cycles`);
                drifting.push({ dim_id, ...d, ma_triggered: true });
            }
        }

        // Track which dimensions have ever had CUSUM or MA trigger (for accurate report verdicts)
        if (drifting.length > 0) {
            const cusum_triggered_ids = drifting.filter(d => !d.ma_triggered).map(d => d.dim_id);
            const ma_triggered_ids = drifting.filter(d => d.ma_triggered).map(d => d.dim_id);
            state.ever_cusum_triggered = [...new Set([...(state.ever_cusum_triggered || []), ...cusum_triggered_ids])];
            state.ever_ma_triggered = [...new Set([...(state.ever_ma_triggered || []), ...ma_triggered_ids])];
        }

        if (drifting.length > 0) {
            if (state.cooldown_remaining > 0) {
                state.cooldown_remaining--;
                save_chat_state(state);
                return;
            }

            const correction = state.active_correction;

            if (!correction?.enabled) {
                // === NEW DRIFT: Generate first correction ===
                const text = await generate_correction(drifting, state.dimensions, char_desc, chat, null, null);
                inject_correction(text);
                state.active_correction = {
                    enabled: true,
                    dim_ids: drifting.map(d => d.dim_id),
                    injection_text: text,
                    since_message: message_index,
                    attempt: 1,
                    scores_since_correction: 0,
                    deviation_at_correction: Math.max(...drifting.map(d => d.deviation || 0)),
                };
                state.corrections_injected++;
                state.ever_corrected_dimensions = [...new Set([...(state.ever_corrected_dimensions || []), ...drifting.map(d => d.dim_id)])];

                if (get_settings('show_toast_on_drift')) {
                    const dim_labels = drifting.map(d => state.dimensions.find(dim => dim.id === d.dim_id)?.label || d.dim_id);
                    const has_severe = drifting.some(d => d.severe);
                    if (has_severe) {
                        toastr.error(`Severe drift: ${dim_labels.join(', ')}`, MODULE_NAME_FANCY);
                    } else {
                        toastr.warning(`Drift detected: ${dim_labels.join(', ')}`, MODULE_NAME_FANCY);
                    }
                }

            } else {
                // === EXISTING CORRECTION: Check if working ===
                const corrected_dim_scored = correction.dim_ids.some(
                    id => scores[id] !== undefined
                );
                if (corrected_dim_scored) {
                    correction.scores_since_correction++;
                }
                const patience = get_settings('correction_patience');
                const max_attempts = get_settings('correction_max_attempts');

                if (correction.scores_since_correction >= patience) {
                    // Check deviation for corrected dimensions using post-correction averages
                    const recovery_margin = get_settings('recovery_margin');
                    const recovery_threshold = threshold - recovery_margin;  // Lower deviation = better
                    const post_avgs = compute_post_correction_averages(
                        correction.dim_ids, state.score_history, correction.since_message,
                    );
                    const corrected_still_drifting = correction.dim_ids
                        .map(dim_id => {
                            const dim = state.dimensions.find(d => d.id === dim_id);
                            const effective_avg = post_avgs[dim_id] ?? drift[dim_id]?.moving_avg ?? null;
                            const dev = effective_avg !== null && dim ? Math.abs(effective_avg - dim.target) : null;
                            return { dim_id, deviation: dev, moving_avg: effective_avg };
                        })
                        .filter(d => d.deviation === null || d.deviation > recovery_threshold);

                    if (corrected_still_drifting.length === 0) {
                        // All corrected dimensions recovered — set CUSUM reset markers and clear MA counters
                        if (!state.cusum_reset_after) state.cusum_reset_after = {};
                        if (!state.ma_consecutive_above) state.ma_consecutive_above = {};
                        for (const dim_id of correction.dim_ids) {
                            state.cusum_reset_after[dim_id] = state.last_scored_message_id;
                            state.ma_consecutive_above[dim_id] = 0;
                            log(`CUSUM reset marker set for ${dim_id} at message #${state.last_scored_message_id}`);
                        }
                        clear_correction();
                        const still_drifting = drifting.filter(d => !correction.dim_ids.includes(d.dim_id));
                        if (still_drifting.length > 0) {
                            const text = await generate_correction(still_drifting, state.dimensions, char_desc, chat, null, null);
                            inject_correction(text);
                            state.active_correction = {
                                enabled: true, dim_ids: still_drifting.map(d => d.dim_id),
                                injection_text: text, since_message: message_index, attempt: 1,
                                scores_since_correction: 0,
                                deviation_at_correction: Math.max(...still_drifting.map(d => d.deviation || 0)),
                            };
                            state.corrections_injected++;
                            state.ever_corrected_dimensions = [...new Set([...(state.ever_corrected_dimensions || []), ...still_drifting.map(d => d.dim_id)])];
                            toastr.success('Previous correction worked. New correction for remaining dimensions.', MODULE_NAME_FANCY);
                        } else {
                            state.active_correction = { enabled: false };
                            state.cooldown_remaining = get_settings('correction_cooldown');
                            toastr.success('Dimensions stabilized', MODULE_NAME_FANCY);
                        }
                    } else {
                        const current_worst_dev = Math.max(...corrected_still_drifting.map(d => d.deviation || 0));
                        const worsened = current_worst_dev > correction.deviation_at_correction + 0.05;
                        const improved = current_worst_dev < correction.deviation_at_correction - 0.02;

                        // Derivative damping: check trends of corrected dimensions before escalating.
                        // If all corrected dims are recovering (trend = 'correcting'), the correction is
                        // working but slowly — reset patience instead of escalating.
                        const corrected_trends = correction.dim_ids
                            .map(dim_id => drift[dim_id]?.trend)
                            .filter(t => t !== undefined);
                        const all_recovering = corrected_trends.length > 0 && corrected_trends.every(t => t === 'correcting');
                        const any_worsening = corrected_trends.some(t => t === 'drifting');

                        if (all_recovering) {
                            // Correction is working, just slowly — give more time
                            log('Derivative damping: all corrected dimensions recovering — resetting patience instead of escalating');
                            correction.scores_since_correction = 0;
                            correction.deviation_at_correction = current_worst_dev;
                        } else if (worsened && correction.attempt < max_attempts) {
                            // Escalate: target the originally-corrected dimensions that are still drifting,
                            // not whatever CUSUM currently flags (which may be a different set)
                            const escalation_targets = corrected_still_drifting.map(d => {
                                const full = drifting.find(dd => dd.dim_id === d.dim_id);
                                return full || d;
                            });
                            const escalation = {
                                previous_text: correction.injection_text,
                                deviation_at_correction: correction.deviation_at_correction,
                                deviation_after: current_worst_dev,
                                attempt: correction.attempt,
                                patience: patience,
                            };
                            const text = await generate_correction(escalation_targets, state.dimensions, char_desc, chat, null, escalation);
                            inject_correction(text);
                            correction.injection_text = text;
                            correction.attempt++;
                            correction.scores_since_correction = 0;
                            correction.deviation_at_correction = current_worst_dev;
                            state.corrections_injected++;
                            toastr.warning(`Deviation worsening — correction regenerated (attempt ${correction.attempt})`, MODULE_NAME_FANCY);
                        } else if (improved) {
                            correction.scores_since_correction = 0;
                            correction.deviation_at_correction = current_worst_dev;
                        } else if (!any_worsening) {
                            // Stagnant but not worsening — give more time (derivative damping)
                            log('Derivative damping: stagnant but no dimensions worsening — resetting patience');
                            correction.scores_since_correction = 0;
                            correction.deviation_at_correction = current_worst_dev;
                        } else if (correction.attempt < max_attempts) {
                            // Stagnant and worsening: escalate
                            const escalation_targets = corrected_still_drifting.map(d => {
                                const full = drifting.find(dd => dd.dim_id === d.dim_id);
                                return full || d;
                            });
                            const escalation = {
                                previous_text: correction.injection_text,
                                deviation_at_correction: correction.deviation_at_correction,
                                deviation_after: current_worst_dev,
                                attempt: correction.attempt,
                                patience: patience,
                            };
                            const text = await generate_correction(escalation_targets, state.dimensions, char_desc, chat, null, escalation);
                            inject_correction(text);
                            correction.injection_text = text;
                            correction.attempt++;
                            correction.scores_since_correction = 0;
                            correction.deviation_at_correction = current_worst_dev;
                            state.corrections_injected++;
                            toastr.warning(`Correction regenerated (attempt ${correction.attempt})`, MODULE_NAME_FANCY);
                        } else {
                            // === CEILING ===
                            const corrected_ids = correction.dim_ids;
                            state.ceiling_dimensions = [...new Set([...(state.ceiling_dimensions || []), ...corrected_ids])];
                            state.ceiling_model = get_current_model_id();
                            const corrected_labels = corrected_ids.map(id =>
                                state.dimensions.find(d => d.id === id)?.label || id);
                            toastr.error(
                                `${corrected_labels.join(', ')} may be at their ceiling for this model. Consider manual intervention.`,
                                MODULE_NAME_FANCY,
                                { timeOut: 0, extendedTimeOut: 0 },
                            );

                            const remaining = drifting.filter(d => !corrected_ids.includes(d.dim_id));
                            if (remaining.length === 0) {
                                clear_correction();
                                state.active_correction = { enabled: false };
                            } else {
                                const text = await generate_correction(remaining, state.dimensions, char_desc, chat, null, null);
                                inject_correction(text);
                                state.active_correction = {
                                    enabled: true,
                                    dim_ids: remaining.map(d => d.dim_id),
                                    injection_text: text,
                                    since_message: message_index,
                                    attempt: 1,
                                    scores_since_correction: 0,
                                    deviation_at_correction: Math.max(...remaining.map(d => d.deviation || 0)),
                                };
                                state.corrections_injected++;
                                state.ever_corrected_dimensions = [...new Set([...(state.ever_corrected_dimensions || []), ...remaining.map(d => d.dim_id)])];
                            }
                        }
                    }
                }
            }
        } else if (state.active_correction?.enabled) {
            // No dimensions drifting -- check if recovery is confirmed
            const recovery_margin = get_settings('recovery_margin');
            const recovery_dev_threshold = threshold - recovery_margin;
            const corrected_dim_ids = state.active_correction.dim_ids || [];

            const recovery_post_avgs = compute_post_correction_averages(
                corrected_dim_ids, state.score_history, state.active_correction.since_message,
            );
            const all_within_tolerance = corrected_dim_ids.every(dim_id => {
                const dim = state.dimensions.find(d => d.id === dim_id);
                const effective_avg = recovery_post_avgs[dim_id] ?? drift[dim_id]?.moving_avg ?? null;
                if (effective_avg === null || !dim) return false;
                return Math.abs(effective_avg - dim.target) <= recovery_dev_threshold + FLOAT_EPSILON;
            });

            if (all_within_tolerance) {
                state.recovery_cycles = (state.recovery_cycles || 0) + 1;
                const needed = get_settings('recovery_patience');
                if (state.recovery_cycles >= needed) {
                    // Set CUSUM reset markers and clear MA counters for recovered dimensions
                    if (!state.cusum_reset_after) state.cusum_reset_after = {};
                    if (!state.ma_consecutive_above) state.ma_consecutive_above = {};
                    for (const dim_id of corrected_dim_ids) {
                        state.cusum_reset_after[dim_id] = state.last_scored_message_id;
                        state.ma_consecutive_above[dim_id] = 0;
                        log(`CUSUM reset marker set for ${dim_id} at message #${state.last_scored_message_id}`);
                    }
                    clear_correction();
                    state.active_correction = { enabled: false };
                    state.cooldown_remaining = get_settings('correction_cooldown');
                    state.recovery_cycles = 0;
                    toastr.success('Dimensions stabilized', MODULE_NAME_FANCY);
                } else {
                    log(`Recovery cycle ${state.recovery_cycles}/${needed} -- waiting for confirmation`);
                }
            } else {
                state.recovery_cycles = 0;
            }
        }

        // Check if any ceiling dimensions have naturally recovered
        if (state.ceiling_dimensions?.length > 0) {
            const recovered = state.ceiling_dimensions.filter(dim_id => {
                const d = drift[dim_id];
                return d && d.deviation !== null && d.deviation <= threshold + FLOAT_EPSILON;
            });
            if (recovered.length > 0) {
                state.ceiling_dimensions = state.ceiling_dimensions.filter(id => !recovered.includes(id));
                const recovered_labels = recovered.map(id =>
                    state.dimensions.find(d => d.id === id)?.label || id);
                toastr.info(`${recovered_labels.join(', ')} recovered within tolerance. Auto-correction re-enabled.`, MODULE_NAME_FANCY);
            }
        }

        save_chat_state(state);
    } catch (err) {
        error('Scoring/correction error:', err);
        try { save_chat_state(get_chat_state()); } catch { /* ignore save errors in error handler */ }
        toastr.warning(`Analysis error: ${err.message}. Scoring skipped.`, MODULE_NAME_FANCY);
    } finally {
        SCORING_IN_PROGRESS = false;

        // Process queued messages (validate index still exists before processing)
        while (SCORING_QUEUE.length > 0) {
            const next_index = SCORING_QUEUE.shift();
            const chat = getContext().chat;
            const msg = chat?.[next_index];
            if (msg && !msg.is_user && !msg.is_system) {
                log(`Processing queued message #${next_index} (${SCORING_QUEUE.length} remaining)`);
                setTimeout(() => on_message_received(next_index), 100);
                break;
            } else {
                log(`Skipping stale queued message #${next_index} (message no longer valid)`);
            }
        }
    }
}

async function on_message_received(message_index) {
    if (!get_settings('enabled')) return;
    if (SCORING_IN_PROGRESS) {
        if (!SCORING_QUEUE.includes(message_index)) {
            SCORING_QUEUE.push(message_index);
            log(`Scoring in progress, queued message #${message_index} (queue size: ${SCORING_QUEUE.length})`);
        }
        return;
    }

    await score_and_process_message(message_index, { force: false });
}

// ==================== POST-ROLEPLAY REPORT ====================

/**
 * Card Resilience Score (0-100):
 * Measures how well the character card stays near target values without intervention.
 */
function compute_card_resilience(score_history, dimensions, corrections_count) {
    if (score_history.length === 0) return 0;
    const threshold = get_settings('drift_threshold');

    // Initial accuracy: how close first 3 scored messages are to targets
    const initial_deviations = [];
    for (const dim of dimensions) {
        const early_scores = score_history.slice(0, 3)
            .map(s => s.scores[dim.id]).filter(s => s !== undefined);
        if (early_scores.length > 0) {
            initial_deviations.push(mean(early_scores.map(s => Math.abs(s - dim.target))));
        }
    }
    const initial = initial_deviations.length > 0 ? Math.max(0, 1 - mean(initial_deviations)) : 0.5;

    // Drift resistance: for each dimension, proportion of time within tolerance.
    // Uses a fixed reference window (capped at 20) to avoid biasing toward longer chats.
    const RESILIENCE_WINDOW = Math.min(score_history.length, 20);
    const windowed_history = score_history.slice(0, RESILIENCE_WINDOW);
    const scored_dims = dimensions.filter(d =>
        windowed_history.some(s => s.scores[d.id] !== undefined)
    );
    const drift_resistance = scored_dims.length > 0
        ? scored_dims.map(d => {
            const dim_scores = windowed_history.filter(s => s.scores[d.id] !== undefined);
            if (dim_scores.length === 0) return 0.5;
            const within_tolerance = dim_scores.filter(s =>
                Math.abs(s.scores[d.id] - d.target) <= threshold
            ).length;
            return within_tolerance / dim_scores.length;
        })
        : [0.5];

    const correction_penalty = corrections_count > 0 ? 0.85 : 1.0;

    // Deviation penalty: scale drift_resistance down when mean deviation is high.
    // This prevents inflated scores when drift goes undetected (no corrections fired
    // but dimensions are clearly off-target).
    const all_mean_devs = scored_dims.map(d => {
        const scores = windowed_history.map(s => s.scores[d.id]).filter(s => s !== undefined);
        return scores.length > 0 ? Math.abs(mean(scores) - d.target) : 0;
    });
    const overall_mean_dev = all_mean_devs.length > 0 ? mean(all_mean_devs) : 0;
    const deviation_factor = Math.max(0.5, 1 - overall_mean_dev * 1.5);  // 0.20 dev → 0.70 factor, 0.33 dev → 0.50 factor

    return Math.round(initial * 40 + mean(drift_resistance) * deviation_factor * 50 + correction_penalty * 10);
}

/**
 * Session Quality Score (0-100):
 * Overall closeness to target positions across the session.
 */
function compute_session_quality(score_history, dimensions, drift_state) {
    if (score_history.length === 0) return 0;

    // Mean deviation from targets across all scores
    const all_deviations = [];
    for (const entry of score_history) {
        for (const dim of dimensions) {
            if (entry.scores[dim.id] !== undefined) {
                all_deviations.push(Math.abs(entry.scores[dim.id] - dim.target));
            }
        }
    }
    const overall_accuracy = all_deviations.length > 0 ? Math.max(0, 1 - mean(all_deviations)) : 0.5;

    // Consistency: inverse of deviation variance
    const variance = compute_variance(all_deviations);
    const consistency = variance !== null ? Math.max(0, 1 - variance * 2) : 0.5;

    // Worst dimension penalty
    const dev_values = Object.values(drift_state).map(d => d.deviation ?? 0);
    const worst_dev = dev_values.length > 0 ? Math.max(...dev_values) : 0;
    const floor_factor = Math.max(0.5, 1 - worst_dev);

    // Dimension coverage: penalize sessions where many dimensions were never scored
    const dims_with_data = dimensions.filter(d =>
        score_history.some(s => s.scores[d.id] !== undefined)
    ).length;
    const coverage = dimensions.length > 0 ? dims_with_data / dimensions.length : 1;
    const coverage_factor = Math.max(0.6, coverage); // Floor at 0.6 so sparse sessions aren't decimated

    const raw = overall_accuracy * 40 + consistency * 30 + floor_factor * 30;
    return Math.round(raw * coverage_factor);
}

/**
 * Model Compatibility Score (0-100):
 * How well the current model handles this character's dimensional profile.
 */
function compute_model_compatibility(dimensions, ceiling_dimensions, corrections_count, score_history, drift_state) {
    if (score_history.length === 0) return 0;
    const threshold = get_settings('drift_threshold');

    const ceiling_ratio = dimensions.length > 0 ? 1 - (ceiling_dimensions.length / dimensions.length) : 1;

    // Correction load: penalize both corrections that fired AND undetected drift.
    // If no corrections fired but dimensions have significant deviation, apply a penalty
    // so the score doesn't reward inert detection.
    let correction_load = Math.max(0, 1 - (corrections_count / (score_history.length * 0.5 || 1)));
    if (corrections_count === 0 && score_history.length >= 5) {
        const dev_values_all = Object.values(drift_state).map(d => d.deviation ?? 0);
        const dims_above_threshold = dev_values_all.filter(d => d > threshold).length;
        if (dims_above_threshold > 0 && dimensions.length > 0) {
            const undetected_penalty = dims_above_threshold / dimensions.length;
            correction_load = Math.max(0, correction_load - undetected_penalty * 0.5);
        }
    }

    // End health: how close the final drift state is to targets (increased weight)
    const dev_values = Object.values(drift_state).map(d => d.deviation ?? 0);
    const end_health = dev_values.length > 0 ? Math.max(0, 1 - mean(dev_values)) : 0.5;

    return Math.round(ceiling_ratio * 35 + correction_load * 25 + end_health * 40);
}

/**
 * Classify a dimension's verdict based on session behavior.
 * Uses CUSUM and MA trigger history for drift detection consistency, with a
 * deviation-based fallback so dimensions with clear drift aren't labeled 'natural_fit'
 * just because statistical triggers didn't fire in short sessions.
 */
function compute_dimension_verdict(dimension, score_history, drift_state, ceiling_dimensions, ever_corrected_dimensions, ever_cusum_triggered, ever_ma_triggered) {
    const threshold = get_settings('drift_threshold');

    if ((ceiling_dimensions || []).includes(dimension.id)) {
        return 'ceiling';
    }

    const actual_scores = score_history.filter(s => s.scores[dimension.id] !== undefined);
    if (actual_scores.length < MIN_SCORES_FOR_VERDICT) {
        return 'insufficient_data';
    }

    // Check both CUSUM and MA trigger history
    const ever_drifted = (ever_cusum_triggered || []).includes(dimension.id)
        || (ever_ma_triggered || []).includes(dimension.id);

    if (!ever_drifted) {
        // Deviation-based fallback: if mean score deviation exceeds threshold across
        // enough data points, this is not a 'natural_fit' — it's drift the system didn't correct.
        const MIN_SCORES_FOR_DEVIATION_VERDICT = 5;
        if (actual_scores.length >= MIN_SCORES_FOR_DEVIATION_VERDICT) {
            const scores = actual_scores.map(s => s.scores[dimension.id]);
            const mean_deviation = Math.abs(mean(scores) - dimension.target);
            if (mean_deviation > threshold) {
                return 'volatile';  // Drifted but never triggered correction
            }
        }
        return 'natural_fit';
    }

    const was_corrected = (ever_corrected_dimensions || []).includes(dimension.id);
    const d = drift_state[dimension.id];
    if (d && d.deviation !== null && d.deviation <= threshold) {
        return was_corrected ? 'correctable' : 'maintainable';
    }

    return was_corrected ? 'drifting' : 'volatile';
}

/**
 * Generate a post-roleplay report.
 */
async function generate_report() {
    const state = get_chat_state();
    const context = getContext();

    if (state.score_history.length === 0) {
        toastr.warning('No scored messages yet. Score some messages first.', MODULE_NAME_FANCY);
        return null;
    }

    const char_name = context.characters?.[context.characterId]?.name || 'Unknown';
    const char_desc = get_full_character_description();
    const model_name = context.textgenerationSettings?.model
        || context.oai_settings?.chat_completion_source && context.oai_settings?.openai_model
        || 'Unknown model';

    // Compute scores
    const card_resilience = compute_card_resilience(state.score_history, state.dimensions, state.corrections_injected);
    const session_quality = compute_session_quality(state.score_history, state.dimensions, state.drift_state);
    const model_compatibility = compute_model_compatibility(
        state.dimensions, state.ceiling_dimensions || [], state.corrections_injected,
        state.score_history, state.drift_state,
    );

    // Compute per-dimension verdicts
    const dimension_verdicts = {};
    const dimension_curves = {};
    for (const dim of state.dimensions) {
        dimension_verdicts[dim.id] = compute_dimension_verdict(
            dim, state.score_history, state.drift_state,
            state.ceiling_dimensions || [], state.ever_corrected_dimensions || [],
            state.ever_cusum_triggered || [], state.ever_ma_triggered || [],
        );
        dimension_curves[dim.id] = state.score_history.map(s => s.scores[dim.id]).filter(s => s !== undefined);
    }

    // Generate LLM insights
    let insights = '';
    try {
        const dimension_breakdown = state.dimensions.map(d => {
            const verdict = dimension_verdicts[d.id];
            const curve = dimension_curves[d.id];
            const avg = curve.length > 0 ? mean(curve).toFixed(2) : '?';
            const desc = d.description ? ` (${d.description})` : '';
            const ctx = d.context ? ` context="${d.context}"` : '';
            return `- ${d.label}${desc}: target=${d.target.toFixed(2)}, verdict=${verdict}, mean_score=${avg},${ctx} curve=[${curve.map(s => s.toFixed(2)).join(', ')}]`;
        }).join('\n');

        const prompt = REPORT_INSIGHTS_PROMPT
            .replace(/\{\{char_name\}\}/g, sanitize_for_prompt(char_name))
            .replace(/\{\{model_name\}\}/g, sanitize_for_prompt(model_name))
            .replace('{{card_score}}', String(card_resilience))
            .replace('{{session_score}}', String(session_quality))
            .replace('{{model_score}}', String(model_compatibility))
            .replace('{{dimension_breakdown}}', dimension_breakdown)
            .replace('{{correction_history}}', `${state.corrections_injected} corrections applied`);

        const messages = [
            { role: 'system', content: 'You are a character roleplay analyst. Provide actionable insights.' },
            { role: 'user', content: prompt },
        ];

        insights = await analyze(messages, 4000, false);
        if (typeof insights !== 'string') insights = String(insights);
    } catch (err) {
        error('Failed to generate insights:', err);
        insights = `(Insight generation failed: ${err.message})`;
    }

    // Build report
    const report = {
        generated_at: Date.now(),
        card_name: char_name,
        model_id: model_name,
        messages_total: context.chat?.length || 0,
        messages_scored: state.messages_scored,
        card_resilience: card_resilience,
        session_quality: session_quality,
        model_compatibility: model_compatibility,
        dimension_verdicts: dimension_verdicts,
        dimension_curves: dimension_curves,
        corrections_count: state.corrections_injected,
        ceiling_dimensions: state.ceiling_dimensions || [],
        insights: insights,
    };

    // Store in chat metadata
    state.report = report;
    save_chat_state(state);

    // Add to cross-session index (capped at 100 entries, FIFO eviction)
    const MAX_REPORT_INDEX = 100;
    const index = get_settings('report_index') || [];
    index.push({
        chat_id: context.chatId,
        card_name: char_name,
        model: model_name,
        scores: [card_resilience, session_quality, model_compatibility],
        dimension_ids: state.dimensions.map(d => d.id),
        date: new Date().toISOString().split('T')[0],
    });
    if (index.length > MAX_REPORT_INDEX) {
        index.splice(0, index.length - MAX_REPORT_INDEX);
    }
    set_settings('report_index', index);

    log('Report generated:', report);
    return report;
}

/**
 * Export a single report as a self-contained JSON file.
 */
function export_report() {
    const state = get_chat_state();
    const context = getContext();

    if (!state.report) {
        toastr.warning('No report generated yet.', MODULE_NAME_FANCY);
        return;
    }

    const char_desc = get_full_character_description();

    const export_data = {
        export_version: '1.0',
        exported_at: new Date().toISOString(),
        extension: `DriftGuard v${MODULE_VERSION}`,
        card_name: state.report.card_name,
        card_description_hash: hash_description(char_desc),
        model_id: state.report.model_id,
        session_date: new Date(state.report.generated_at).toISOString().split('T')[0],
        messages_total: state.report.messages_total,
        messages_scored: state.report.messages_scored,
        card_resilience: state.report.card_resilience,
        session_quality: state.report.session_quality,
        model_compatibility: state.report.model_compatibility,
        dimensions: state.dimensions.map(d => ({
            id: d.id,
            label: d.label,
            low_label: d.low_label,
            high_label: d.high_label,
            target: d.target,
            context: d.context,
            verdict: state.report.dimension_verdicts[d.id],
            initial_score: state.score_history.length > 0 ? state.score_history[0].scores[d.id] : null,
            final_score: state.score_history.length > 0 ? state.score_history[state.score_history.length - 1].scores[d.id] : null,
            mean_score: mean((state.report.dimension_curves[d.id] || [])),
            score_curve: state.report.dimension_curves[d.id] || [],
        })),
        corrections_count: state.report.corrections_count,
        ceiling_dimensions: state.report.ceiling_dimensions,
        insights: state.report.insights,
        score_history: state.score_history,
        card_description: char_desc,
    };

    const filename = `driftguard_report_${(state.report.card_name || 'unknown').replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.json`;
    download_json(export_data, filename);
    toastr.success(`Report exported as ${filename}`, MODULE_NAME_FANCY);
}

/**
 * Export all reports from the cross-session index.
 */
function export_all_reports() {
    const index = get_settings('report_index') || [];
    if (index.length === 0) {
        toastr.warning('No reports in the index.', MODULE_NAME_FANCY);
        return;
    }

    const filename = `driftguard_reports_all_${new Date().toISOString().split('T')[0]}.json`;
    download_json(index, filename);
    toastr.success(`All reports exported as ${filename}`, MODULE_NAME_FANCY);
}

/**
 * Helper: trigger browser file download for JSON data.
 */
function download_json(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==================== UI UPDATE FUNCTIONS ====================

/**
 * Update the entire dashboard (Overview tab).
 */
function update_dashboard() {
    update_status_display();
    update_trait_bars();
    update_correction_panel();
    update_ceiling_warning();
}

/**
 * Update the status display at the top of the Overview tab.
 */
function update_status_display() {
    const state = get_chat_state();
    const enabled = get_settings('enabled');
    const backend = get_settings('analysis_backend');

    const status_el = document.getElementById('dc_status_text');
    if (status_el) {
        if (!enabled) {
            status_el.textContent = 'Disabled';
            status_el.className = 'dc_text_gray';
        } else if (state.active_correction?.enabled) {
            status_el.textContent = `Active | Correcting`;
            status_el.className = 'dc_text_orange';
        } else if (state.dimensions?.length > 0) {
            status_el.textContent = `Active | Scoring every ${get_settings('score_frequency')} messages`;
            status_el.className = 'dc_text_green';
        } else {
            status_el.textContent = 'Waiting for character';
            status_el.className = 'dc_text_yellow';
        }
    }

    const backend_el = document.getElementById('dc_backend_status');
    if (backend_el) {
        if (backend === 'claude_code') {
            const model = get_settings('claude_code_model') || 'sonnet';
            const connected = PLUGIN_AVAILABLE === true;
            backend_el.textContent = `Claude Code (${model}) | ${connected ? 'Plugin Connected' : 'Plugin Not Connected'}`;
        } else {
            const endpoint = get_settings('openai_endpoint') || 'Not configured';
            const model = get_settings('openai_model') || 'default';
            backend_el.textContent = `OpenAI (${model}) | ${endpoint.substring(0, 30)}`;
        }
    }

    const scored_el = document.getElementById('dc_messages_scored');
    if (scored_el) scored_el.textContent = String(state.messages_scored || 0);

    const corrections_el = document.getElementById('dc_corrections_count');
    if (corrections_el) corrections_el.textContent = String(state.corrections_injected || 0);
}

/**
 * Update the dimension health bars in the Overview tab.
 * Shows spectrum bars with target markers and current position indicators.
 */
function update_trait_bars() {
    const container = document.getElementById('dc_trait_health_container');
    if (!container) return;

    const state = get_chat_state();
    const dimensions = state.dimensions || [];
    const drift = state.drift_state || {};
    const threshold = get_settings('drift_threshold');

    if (dimensions.length === 0) {
        container.innerHTML = `
            <div class="dc_empty_state">
                <i class="fa-solid fa-user-slash"></i>
                <span>No character loaded. Open a chat to begin tracking.</span>
            </div>`;
        return;
    }

    const window_size = get_settings('drift_window');
    let html = '';

    for (const dim of dimensions) {
        const d = drift[dim.id] || { moving_avg: null, deviation: null, trend: 'no_data', correcting: false };
        const avg = d.moving_avg;
        const dev = d.deviation;
        const pct = avg !== null ? Math.round(avg * 100) : 0;
        const target_pct = Math.round(dim.target * 100);
        const score_text = avg !== null ? avg.toFixed(2) : '--';

        // Color based on distance from target (not absolute position)
        let bar_class = 'dc_bar_green';
        if (avg !== null) {
            if (d.correcting) bar_class = 'dc_bar_correcting';
            else if (dev > threshold) bar_class = 'dc_bar_red';
            else if (dev > threshold * 0.6) bar_class = 'dc_bar_yellow';
        }

        // Trend text and class
        let trend_text = d.trend || 'no_data';
        let trend_class = 'dc_trend_no_data';
        if (d.correcting) {
            trend_text = 'CORRECTING';
            trend_class = 'dc_trend_correcting';
        } else if (d.trend === 'drifting') {
            trend_text = 'drifting';
            trend_class = 'dc_trend_declining';
        } else if (d.trend === 'correcting') {
            trend_text = 'recovering';
            trend_class = 'dc_trend_improving';
        } else if (d.trend === 'stable') {
            trend_class = 'dc_trend_stable';
        }

        // Sparkline (last 5 scores)
        const recent = (state.score_history || [])
            .slice(-window_size)
            .map(s => s.scores[dim.id])
            .filter(s => s !== undefined);

        let sparkline_html = '';
        for (const val of recent.slice(-5)) {
            const val_dev = Math.abs(val - dim.target);
            let dot_color = '#4caf50';
            if (val_dev > threshold) dot_color = '#f44336';
            else if (val_dev > threshold * 0.6) dot_color = '#ffcc00';
            sparkline_html += `<div class="dc_spark_dot" style="background: ${dot_color}" title="${val.toFixed(2)} (target: ${dim.target.toFixed(2)})"></div>`;
        }

        html += `
            <div class="dc_trait_row">
                <div class="dc_dim_labels">
                    <span class="dc_dim_low_label">${escapeHtml(dim.low_label)}</span>
                    <span class="dc_trait_label" title="${escapeHtml(dim.description)}${dim.context ? ' | ' + escapeHtml(dim.context) : ''}">${escapeHtml(dim.label)}</span>
                    <span class="dc_dim_high_label">${escapeHtml(dim.high_label)}</span>
                </div>
                <div class="dc_trait_bar_container">
                    <div class="dc_trait_bar_fill ${bar_class}" style="width: ${pct}%"></div>
                    <div class="dc_dim_target_marker" style="left: ${target_pct}%" title="Target: ${dim.target.toFixed(2)}"></div>
                </div>
                <span class="dc_trait_score">${score_text}</span>
                <div class="dc_trait_sparkline">${sparkline_html}</div>
                <span class="dc_trait_trend ${trend_class}">${trend_text}</span>
            </div>`;
    }

    container.innerHTML = html;
}

/**
 * Update the active correction panel in the Overview tab.
 */
function update_correction_panel() {
    const section = document.getElementById('dc_correction_section');
    if (!section) return;

    const state = get_chat_state();
    const correction = state.active_correction;

    if (!correction?.enabled) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';

    const dims_el = document.getElementById('dc_correction_dims');
    if (dims_el) {
        const labels = (correction.dim_ids || []).map(id =>
            state.dimensions.find(d => d.id === id)?.label || id);
        dims_el.textContent = labels.join(', ') || '--';
    }

    const attempt_el = document.getElementById('dc_correction_attempt');
    if (attempt_el) attempt_el.textContent = String(correction.attempt || 1);

    const depth_el = document.getElementById('dc_correction_depth');
    if (depth_el) depth_el.textContent = String(get_settings('correction_depth'));

    const since_el = document.getElementById('dc_correction_since');
    if (since_el) since_el.textContent = correction.since_message !== undefined ? `#${correction.since_message}` : '--';

    const text_el = document.getElementById('dc_correction_text_body');
    if (text_el) text_el.textContent = correction.injection_text || '--';
}

/**
 * Update the ceiling dimensions warning.
 */
function update_ceiling_warning() {
    const section = document.getElementById('dc_ceiling_section');
    if (!section) return;

    const state = get_chat_state();
    const ceiling = state.ceiling_dimensions || [];

    if (ceiling.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    const text_el = document.getElementById('dc_ceiling_text');
    if (text_el) {
        const labels = ceiling.map(id => state.dimensions.find(d => d.id === id)?.label || id);
        text_el.textContent = `${labels.join(', ')} may be at their ceiling for this model. Consider manual intervention.`;
    }
}

/**
 * Update per-message badges on scored messages.
 */
function update_message_badges() {
    if (!get_settings('show_per_message_badges')) return;

    const state = get_chat_state();
    const chat = getContext().chat;
    if (!chat) return;

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        const dg = msg?.extra?.driftguard;
        if (!dg?.scored) continue;

        const msg_el = document.querySelector(`[mesid="${i}"]`);
        if (!msg_el) continue;

        // Don't add duplicate badges
        if (msg_el.querySelector('.dc_message_badge_container')) continue;

        const container = document.createElement('div');
        container.className = 'dc_message_badge_container';

        const threshold = get_settings('drift_threshold');
        const alert_threshold = get_settings('drift_alert_threshold');
        for (const [dim_id, score] of Object.entries(dg.scores)) {
            if (score === null || score === undefined) continue;
            const dim = state.dimensions.find(d => d.id === dim_id);
            if (!dim) continue;
            const label = dim.label || dim_id;
            const deviation = Math.abs(score - dim.target);

            let badge_class = 'dc_badge_green';
            if (deviation > alert_threshold) badge_class = 'dc_badge_red';
            else if (deviation > threshold) badge_class = 'dc_badge_yellow';

            const corrected_class = dg.correction_active ? ' dc_badge_corrected' : '';

            const badge = document.createElement('span');
            badge.className = `dc_message_badge ${badge_class}${corrected_class}`;
            badge.textContent = `${label}: ${score.toFixed(2)}`;
            badge.title = `${label}: ${score.toFixed(2)} (target: ${dim.target.toFixed(2)}, deviation: ${deviation.toFixed(2)})${dg.correction_active ? ' [correction active]' : ''}`;
            container.appendChild(badge);
        }

        // Append to the message element's text container
        const text_container = msg_el.querySelector('.mes_text');
        if (text_container) {
            text_container.appendChild(container);
        }
    }
}

/**
 * Update the Report tab UI with current report data.
 */
function update_report_display() {
    const state = get_chat_state();
    const report = state.report;
    const content_el = document.getElementById('dc_report_content');
    if (!content_el) return;

    if (!report) {
        content_el.style.display = 'none';
        return;
    }

    content_el.style.display = '';

    // Score bars
    update_score_bar('dc_report_card_bar', 'dc_report_card_score', report.card_resilience);
    update_score_bar('dc_report_session_bar', 'dc_report_session_score', report.session_quality);
    update_score_bar('dc_report_model_bar', 'dc_report_model_score', report.model_compatibility);

    // Dimension verdicts
    const verdicts_el = document.getElementById('dc_report_verdicts');
    if (verdicts_el) {
        let html = '';
        for (const dim of state.dimensions) {
            const verdict = report.dimension_verdicts[dim.id] || 'unknown';
            const badge_class = `dc_verdict_${verdict}`;
            const display_verdict = verdict.replace(/_/g, ' ').toUpperCase();
            html += `
                <div class="dc_verdict_row">
                    <span>${escapeHtml(dim.label)}</span>
                    <span class="dc_verdict_badge ${badge_class}">${display_verdict}</span>
                </div>`;
        }
        verdicts_el.innerHTML = html;
    }

    // Insights
    const insights_el = document.getElementById('dc_report_insights');
    if (insights_el) {
        insights_el.textContent = report.insights || 'No insights available.';
    }

    // Report index
    update_report_index();
}

/**
 * Helper: update a score bar element.
 */
function update_score_bar(bar_id, score_id, value) {
    const bar = document.getElementById(bar_id);
    const score = document.getElementById(score_id);
    if (bar) {
        bar.style.width = `${value}%`;
        if (value >= 70) bar.className = 'dc_score_bar_fill dc_score_high';
        else if (value >= 40) bar.className = 'dc_score_bar_fill dc_score_medium';
        else bar.className = 'dc_score_bar_fill dc_score_low';
    }
    if (score) score.textContent = `${value}/100`;
}

/**
 * Update the report index list in the Report tab.
 */
function update_report_index() {
    const list_el = document.getElementById('dc_report_index_list');
    if (!list_el) return;

    const index = get_settings('report_index') || [];

    if (index.length === 0) {
        list_el.innerHTML = '<span class="dc_empty_state">No previous reports found.</span>';
        return;
    }

    let html = '';
    for (let i = 0; i < index.length; i++) {
        const entry = index[i];
        const scores_text = entry.scores ? `[${entry.scores.map(s => escapeHtml(String(s))).join('/')}]` : '';
        html += `
            <div class="dc_report_index_item" data-index="${i}">
                <input type="checkbox" class="dc_report_select" data-index="${i}" />
                <span>${escapeHtml(entry.card_name)} (${escapeHtml(entry.date)})</span>
                <span class="dc_report_index_scores">${scores_text}</span>
            </div>`;
    }
    list_el.innerHTML = html;
}

/**
 * Compare two selected reports and show deltas.
 */
function compare_reports() {
    const checkboxes = document.querySelectorAll('.dc_report_select:checked');
    if (checkboxes.length !== 2) {
        toastr.warning('Select exactly two reports to compare.', MODULE_NAME_FANCY);
        return;
    }

    const index = get_settings('report_index') || [];
    const idx_a = parseInt(checkboxes[0].dataset.index, 10);
    const idx_b = parseInt(checkboxes[1].dataset.index, 10);

    if (isNaN(idx_a) || isNaN(idx_b)) {
        toastr.warning('Invalid report selection.', MODULE_NAME_FANCY);
        return;
    }

    const a = index[idx_a];
    const b = index[idx_b];
    if (!a || !b) return;

    const result_el = document.getElementById('dc_comparison_result');
    if (!result_el) return;

    const score_labels = ['Card Resilience', 'Session Quality', 'Model Compatibility'];
    let html = `<strong>${escapeHtml(b.card_name)} vs ${escapeHtml(a.card_name)}</strong><br/><br/>`;

    for (let i = 0; i < 3; i++) {
        const sa = a.scores?.[i] || 0;
        const sb = b.scores?.[i] || 0;
        const delta = sb - sa;
        const delta_class = delta > 0 ? 'dc_comparison_delta_positive' : delta < 0 ? 'dc_comparison_delta_negative' : 'dc_comparison_delta_neutral';
        const delta_text = delta > 0 ? `+${delta}` : String(delta);
        html += `
            <div class="dc_comparison_row">
                <span>${score_labels[i]}</span>
                <span>${sb} (<span class="${delta_class}">${delta_text}</span>)</span>
            </div>`;
    }

    result_el.innerHTML = html;
    result_el.style.display = '';
}

// ==================== POPOUT FUNCTIONS ====================

function isPopoutVisible() {
    return POPOUT_VISIBLE;
}

function togglePopout() {
    if (POPOUT_VISIBLE) {
        closePopout();
    } else {
        openPopout();
    }
}

function openPopout() {
    if (POPOUT_VISIBLE) return;

    const $drawer = $('#driftguard_settings');
    const $drawerHeader = $drawer.find('.inline-drawer-header');
    const $drawerContentElement = $drawer.find('.inline-drawer-content');
    const isCollapsed = !$drawerContentElement.hasClass('open');

    // If collapsed, trigger click to open first
    if (isCollapsed) {
        $drawerHeader.trigger('click');
    }

    // Create the popout element
    $POPOUT = $(`
        <div id="dc_popout" class="draggable" style="display: none;">
            <div class="panelControlBar flex-container" id="dcPopoutHeader">
                <div class="title">${MODULE_NAME_FANCY}</div>
                <div class="flex1"></div>
                <div class="fa-solid fa-arrows-left-right hoverglow dragReset" title="Reset to default size"></div>
                <div class="fa-solid fa-grip drag-grabber hoverglow" title="Drag to move"></div>
                <div class="fa-solid fa-lock-open hoverglow dragLock" title="Lock position"></div>
            </div>
            <div id="dc_popout_content_container"></div>
        </div>
    `);

    // Append popout to body
    $('body').append($POPOUT);

    // Move drawer content to popout
    $drawerContentElement.detach().appendTo($POPOUT.find('#dc_popout_content_container'));
    $drawerContentElement.addClass('open').show();
    $DRAWER_CONTENT = $drawerContentElement;

    // Set up dragging using SillyTavern's dragElement if available
    try {
        const ctx = getContext();
        if (typeof ctx.dragElement === 'function') {
            ctx.dragElement($POPOUT);
        } else if (typeof window.dragElement === 'function') {
            window.dragElement($POPOUT);
        } else {
            make_popout_draggable($POPOUT);
        }
    } catch (e) {
        make_popout_draggable($POPOUT);
    }

    // Load saved position if available
    load_popout_position();

    // Set up button handlers
    $POPOUT.find('.dragLock').on('click', () => togglePopoutLock());
    $POPOUT.find('.dragReset').on('click', () => resetPopoutSize());

    // Set up ResizeObserver to track when user manually resizes
    try {
        const resizeObserver = new ResizeObserver(debounce((entries) => {
            for (const entry of entries) {
                $POPOUT.data('user-resized', true);
                save_popout_position();
            }
        }, 250));
        resizeObserver.observe($POPOUT[0]);
        $POPOUT.data('resize-observer', resizeObserver);
    } catch (e) {
        // ResizeObserver not available
    }

    // Show the popout with animation
    $POPOUT.fadeIn(250);

    // Update state
    POPOUT_VISIBLE = true;
    update_popout_button_state();

    log('Popout opened');
}

function closePopout() {
    if (!POPOUT_VISIBLE || !$POPOUT) return;

    const $currentPopout = $POPOUT;
    const $currentDrawerContent = $DRAWER_CONTENT;

    // Save position before closing
    save_popout_position();

    // Cleanup ResizeObserver
    const resizeObserver = $currentPopout.data('resize-observer');
    if (resizeObserver) {
        resizeObserver.disconnect();
    }

    $currentPopout.fadeOut(250, () => {
        const $drawer = $('#driftguard_settings');
        const $inlineDrawer = $drawer.find('.inline-drawer');

        if ($currentDrawerContent) {
            // Move content back to drawer
            $currentDrawerContent.detach().appendTo($inlineDrawer);
            $currentDrawerContent.addClass('open').show();
        }

        // Remove popout element
        $currentPopout.remove();

        if ($POPOUT === $currentPopout) {
            $POPOUT = null;
        }
    });

    // Update state
    POPOUT_VISIBLE = false;
    $DRAWER_CONTENT = null;
    update_popout_button_state();

    log('Popout closed');
}

function togglePopoutLock() {
    if (!$POPOUT) return;

    POPOUT_LOCKED = !POPOUT_LOCKED;
    update_lock_button_ui();
    save_popout_position();

    log(`Popout position ${POPOUT_LOCKED ? 'locked' : 'unlocked'}`);
}

function update_lock_button_ui() {
    if (!$POPOUT) return;

    const $button = $POPOUT.find('.dragLock');

    if (POPOUT_LOCKED) {
        $button.removeClass('fa-lock-open').addClass('fa-lock locked');
        $button.attr('title', 'Unlock position');
        $POPOUT.addClass('position-locked');
    } else {
        $button.removeClass('fa-lock locked').addClass('fa-lock-open');
        $button.attr('title', 'Lock position');
        $POPOUT.removeClass('position-locked');
    }
}

function make_popout_draggable($element) {
    const $header = $element.find('#dcPopoutHeader');
    let isDragging = false;
    let startX, startY, initialX, initialY;

    $header.on('mousedown', (e) => {
        if (POPOUT_LOCKED) return;

        // Don't drag if clicking on interactive elements
        if ($(e.target).hasClass('dragClose') || $(e.target).hasClass('dragLock') || $(e.target).hasClass('hoverglow')) {
            return;
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = $element[0].getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        $header.css('cursor', 'grabbing');
        e.preventDefault();
    });

    $(document).on('mousemove.dcPopout', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        let newX = initialX + deltaX;
        let newY = initialY + deltaY;

        // Keep within viewport bounds
        const maxX = window.innerWidth - $element.outerWidth();
        const maxY = window.innerHeight - $element.outerHeight();

        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));

        $element.css({
            left: newX + 'px',
            top: newY + 'px',
            right: 'auto',
            bottom: 'auto',
        });
    });

    $(document).on('mouseup.dcPopout', () => {
        if (isDragging) {
            isDragging = false;
            $header.css('cursor', 'grab');
            save_popout_position();
        }
    });
}

function save_popout_position() {
    if (!$POPOUT) return;

    const position = {
        left: $POPOUT.css('left'),
        top: $POPOUT.css('top'),
        right: $POPOUT.css('right'),
        width: $POPOUT.data('user-resized') ? $POPOUT.css('width') : null,
        locked: POPOUT_LOCKED,
    };

    localStorage.setItem('dc_popout_position', JSON.stringify(position));
}

function load_popout_position() {
    if (!$POPOUT) return;

    const saved = localStorage.getItem('dc_popout_position');

    if (saved) {
        try {
            const position = JSON.parse(saved);
            $POPOUT.css({
                left: position.left || 'auto',
                top: position.top || 'var(--topBarBlockSize, 50px)',
                right: position.right || 'auto',
            });

            if (position.width) {
                $POPOUT.css('width', position.width);
                $POPOUT.data('user-resized', true);
            }

            if (position.locked !== undefined) {
                POPOUT_LOCKED = position.locked;
                update_lock_button_ui();
            }
        } catch (e) {
            warn('Failed to load popout position:', e);
        }
    }
}

function resetPopoutSize() {
    if (!$POPOUT) return;

    $POPOUT.css('width', '');
    $POPOUT.data('user-resized', false);
    save_popout_position();

    log('Popout size reset to default');
}

function update_popout_button_state() {
    const $button = $('#dc_popout_button');
    if ($button.length === 0) return;

    if (POPOUT_VISIBLE) {
        $button.addClass('active');
        $button.attr('title', 'Close floating window');
    } else {
        $button.removeClass('active');
        $button.attr('title', 'Pop out settings to a floating window');
    }
}

function add_popout_button() {
    const $header = $('#driftguard_settings .inline-drawer-header');
    if ($header.length === 0) {
        warn('Popout button: Header not found');
        return;
    }

    // Don't add if already exists
    if ($('#dc_popout_button').length > 0) return;

    // Create the popout button
    const $button = $(`
        <i id="dc_popout_button"
           class="fa-solid fa-window-restore menu_button margin0 interactable"
           tabindex="0"
           title="Pop out settings to a floating window">
        </i>
    `);

    // Style the button
    $button.css({
        'margin-left': 'auto',
        'margin-right': '10px',
        'display': 'inline-flex',
        'vertical-align': 'middle',
        'cursor': 'pointer',
        'font-size': '1em',
    });

    // Click handler with stopPropagation to prevent drawer toggle
    $button.on('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        togglePopout();
    });

    // Insert button before the chevron icon
    const $chevron = $header.find('.inline-drawer-icon');
    if ($chevron.length > 0) {
        $button.insertBefore($chevron);
    } else {
        $header.append($button);
    }

    // Intercept drawer header clicks when popout is visible
    $header.on('click.dcPopout', function (event) {
        if (POPOUT_VISIBLE) {
            event.stopImmediatePropagation();
            event.preventDefault();
            closePopout();
        }
    });
}

// ==================== RETROACTIVE SCORING ====================

/**
 * Walk through chat history and score every Nth unscored AI message.
 * Builds up score history for chats started without DriftGuard.
 */
async function score_chat_retroactively() {
    const state = get_chat_state();
    if (!state.dimensions || state.dimensions.length === 0) {
        toastr.warning('No dimensions calibrated. Calibrate dimensions first.', MODULE_NAME_FANCY);
        return;
    }

    const chat = getContext().chat;
    if (!chat || chat.length === 0) {
        toastr.warning('No messages in chat.', MODULE_NAME_FANCY);
        return;
    }

    if (SCORING_IN_PROGRESS) {
        toastr.info('Scoring already in progress...', MODULE_NAME_FANCY);
        return;
    }

    const freq = get_settings('score_frequency');
    const char_desc = get_full_character_description();

    // Collect every Nth AI message that hasn't been scored yet
    const to_score = [];
    let ai_count = 0;
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];

        // Skip user/system messages
        if (msg.is_user || msg.is_system) continue;

        // Skip greeting messages
        if (is_greeting_message(msg, i)) continue;

        // Skip OOC messages
        if (is_ooc_message(msg.mes)) continue;

        ai_count++;

        // Only score every Nth AI message (matching score_frequency)
        if (ai_count % freq !== 0 && !(ai_count === 1 && get_settings('score_on_first'))) continue;

        // Skip already-scored messages
        if (msg.extra?.driftguard?.scored) continue;

        to_score.push(i);
    }

    if (to_score.length === 0) {
        toastr.info('No unscored messages to process.', MODULE_NAME_FANCY);
        return;
    }

    log(`Retroactive scoring: ${to_score.length} messages to score`);
    toastr.info(`Scoring ${to_score.length} messages...`, MODULE_NAME_FANCY);

    SCORING_IN_PROGRESS = true;
    let scored_count = 0;
    try {
        for (const msg_index of to_score) {
            const msg = chat[msg_index];
            if (!msg || !msg.mes) continue;

            try {
                const scores = await score_response(msg.mes, state.dimensions, char_desc, msg_index);

                if (Object.keys(scores).filter(k => k !== '_reasoning').length === 0) {
                    warn(`Retroactive: empty scores for message #${msg_index}, skipping`);
                    continue;
                }

                store_scores(msg, msg_index, scores);
                state.messages_scored++;
                scored_count++;

                // Progress update every 5 messages
                if (scored_count % 5 === 0) {
                    toastr.info(`Scored ${scored_count}/${to_score.length} messages...`, MODULE_NAME_FANCY);
                }
            } catch (err) {
                warn(`Retroactive: failed to score message #${msg_index}: ${err.message}`);
            }
        }

        // Recompute drift state after all scoring
        const drift = update_drift_state(state.dimensions, state.score_history, state.cusum_reset_after || {});
        save_drift_state(drift);
        save_chat_state(state);
        update_dashboard();
        update_message_badges();

        toastr.success(`Scored ${scored_count} messages`, MODULE_NAME_FANCY);
        log(`Retroactive scoring complete: ${scored_count}/${to_score.length} messages scored`);
    } finally {
        SCORING_IN_PROGRESS = false;
    }
}

// ==================== UI LISTENERS ====================

function initialize_ui_listeners() {
    // Tab switching
    $(document).on('click', '.dc_tab', function () {
        const tab = $(this).data('tab');
        $('.dc_tab').removeClass('dc_tab_active');
        $(this).addClass('dc_tab_active');
        $('.dc_tab_content').removeClass('dc_tab_content_active');
        $(`.dc_tab_content[data-tab="${tab}"]`).addClass('dc_tab_content_active');
    });

    // Settings: checkboxes
    $(document).on('change', '#dc_enabled', function () {
        set_settings('enabled', $(this).is(':checked'));
        update_status_display();
        if (!$(this).is(':checked')) {
            const state = get_chat_state();
            clear_correction(state);
            clear_baseline();
            save_chat_state(state);
        }
    });

    $(document).on('change', '#dc_score_on_first', function () {
        set_settings('score_on_first', $(this).is(':checked'));
    });

    $(document).on('change', '#dc_correction_enabled', function () {
        set_settings('correction_enabled', $(this).is(':checked'));
        if (!$(this).is(':checked')) {
            clear_correction();
            const state = get_chat_state();
            state.active_correction = { enabled: false };
            save_chat_state(state);
            update_correction_panel();
        }
    });

    $(document).on('change', '#dc_baseline_enabled', function () {
        const enabled = $(this).is(':checked');
        set_settings('baseline_enabled', enabled);
        if (!enabled) {
            clear_baseline();
        } else {
            const state = get_chat_state();
            if (state.baseline_text) {
                inject_baseline(state.baseline_text);
            }
        }
    });

    $(document).on('change', '#dc_show_per_message_badges', function () {
        set_settings('show_per_message_badges', $(this).is(':checked'));
    });

    $(document).on('change', '#dc_show_toast_on_drift', function () {
        set_settings('show_toast_on_drift', $(this).is(':checked'));
    });

    // Settings: backend radio
    $(document).on('change', 'input[name="dc_analysis_backend"]', function () {
        const val = $(this).val();
        set_settings('analysis_backend', val);
        PLUGIN_AVAILABLE = null; // Reset probe cache on backend switch
        PLUGIN_PROBE_TIMESTAMP = 0;
        if (val === 'claude_code') {
            $('#dc_claude_settings').show();
            $('#dc_openai_settings').hide();
        } else {
            $('#dc_claude_settings').hide();
            $('#dc_openai_settings').show();
        }
    });

    // Settings: text inputs (direct binding + 'change' event fires on blur, naturally debounced)
    $('#dc_claude_model').on('change', function () {
        set_settings('claude_code_model', $(this).val().trim());
    });
    $('#dc_openai_endpoint').on('change', function () {
        set_settings('openai_endpoint', $(this).val().trim());
    });
    $('#dc_openai_api_key').on('change', function () {
        set_settings('openai_api_key', $(this).val().trim());
    });
    $('#dc_openai_model').on('change', function () {
        set_settings('openai_model', $(this).val().trim());
    });

    // Settings: sliders
    const slider_settings = [
        { id: 'dc_score_frequency', key: 'score_frequency', display: 'dc_score_frequency_value', format: v => v },
        { id: 'dc_drift_window', key: 'drift_window', display: 'dc_drift_window_value', format: v => v },
        { id: 'dc_drift_threshold', key: 'drift_threshold', display: 'dc_drift_threshold_value', format: v => parseFloat(v).toFixed(2) },
        { id: 'dc_drift_alert_threshold', key: 'drift_alert_threshold', display: 'dc_drift_alert_threshold_value', format: v => parseFloat(v).toFixed(2) },
        { id: 'dc_correction_depth', key: 'correction_depth', display: 'dc_correction_depth_value', format: v => v },
        { id: 'dc_correction_max_dimensions', key: 'correction_max_dimensions', display: 'dc_correction_max_dimensions_value', format: v => v },
        { id: 'dc_correction_patience', key: 'correction_patience', display: 'dc_correction_patience_value', format: v => v },
        { id: 'dc_correction_max_attempts', key: 'correction_max_attempts', display: 'dc_correction_max_attempts_value', format: v => v },
        { id: 'dc_correction_cooldown', key: 'correction_cooldown', display: 'dc_correction_cooldown_value', format: v => v },
        { id: 'dc_recovery_margin', key: 'recovery_margin', display: 'dc_recovery_margin_value', format: v => parseFloat(v).toFixed(2) },
        { id: 'dc_recovery_patience', key: 'recovery_patience', display: 'dc_recovery_patience_value', format: v => v },
        { id: 'dc_baseline_depth', key: 'baseline_depth', display: 'dc_baseline_depth_value', format: v => v },
    ];

    for (const slider of slider_settings) {
        $(document).on('input', `#${slider.id}`, function () {
            const val = $(this).val();
            const parsed = (slider.key.includes('threshold') || slider.key.includes('margin')) ? parseFloat(val) : parseInt(val);
            set_settings(slider.key, parsed);
            $(`#${slider.display}`).text(slider.format(val));

            // If threshold changed, cross-validate and recompute drift state
            if (slider.key === 'drift_threshold' || slider.key === 'drift_alert_threshold') {
                // Cross-validate: alert_threshold must be at least 0.05 below drift_threshold
                const drift_val = get_settings('drift_threshold');
                const alert_val = get_settings('drift_alert_threshold');
                const MIN_GAP = 0.05;

                if (alert_val >= drift_val - MIN_GAP) {
                    const clamped_alert = Math.max(0.05, parseFloat((drift_val - MIN_GAP).toFixed(2)));
                    set_settings('drift_alert_threshold', clamped_alert);
                    $('#dc_drift_alert_threshold').val(clamped_alert);
                    $('#dc_drift_alert_threshold_value').text(clamped_alert.toFixed(2));
                    toastr.info(
                        `Alert threshold clamped to ${clamped_alert.toFixed(2)} (must be at least ${MIN_GAP} below drift threshold)`,
                        MODULE_NAME_FANCY,
                    );
                }

                const state = get_chat_state();
                if (state.dimensions?.length > 0 && state.score_history?.length > 0) {
                    const drift = update_drift_state(state.dimensions, state.score_history, state.cusum_reset_after || {});
                    save_drift_state(drift);
                    update_trait_bars();
                }
            }
        });
    }

    // Action buttons
    $(document).on('click', '#dc_btn_test_connection', async function () {
        const btn = $(this);
        btn.addClass('dc_disabled');
        btn.find('i').removeClass('fa-plug').addClass('fa-spinner fa-spin');

        try {
            const result = await test_connection();
            if (result.success) {
                toastr.success(result.message, MODULE_NAME_FANCY);
                update_plugin_status(true);
            } else {
                toastr.error(result.message, MODULE_NAME_FANCY);
                update_plugin_status(false);
            }
        } catch (err) {
            toastr.error(`Connection test failed: ${err.message}`, MODULE_NAME_FANCY);
            update_plugin_status(false);
        }

        btn.removeClass('dc_disabled');
        btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-plug');
    });

    // Score Now: manually score the latest AI message
    $(document).on('click', '#dc_btn_score_now', async function () {
        const btn = $(this);
        if (SCORING_IN_PROGRESS) {
            toastr.info('Scoring already in progress...', MODULE_NAME_FANCY);
            return;
        }

        btn.addClass('dc_disabled');
        btn.find('i').removeClass('fa-bullseye').addClass('fa-spinner fa-spin');

        try {
            // Find the last AI message
            const chat = getContext().chat;
            if (!chat || chat.length === 0) {
                toastr.warning('No messages in chat.', MODULE_NAME_FANCY);
                return;
            }

            let target_index = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) {
                    target_index = i;
                    break;
                }
            }

            if (target_index === -1) {
                toastr.warning('No AI message found to score.', MODULE_NAME_FANCY);
                return;
            }

            toastr.info('Scoring message...', MODULE_NAME_FANCY);
            await score_and_process_message(target_index, { force: true });
            toastr.success('Message scored', MODULE_NAME_FANCY);
        } catch (err) {
            toastr.error(`Scoring failed: ${err.message}`, MODULE_NAME_FANCY);
        } finally {
            btn.removeClass('dc_disabled');
            btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-bullseye');
        }
    });

    // Score Chat: retroactively score all unscored AI messages
    $(document).on('click', '#dc_btn_score_chat', async function () {
        const btn = $(this);
        if (SCORING_IN_PROGRESS) {
            toastr.info('Scoring already in progress...', MODULE_NAME_FANCY);
            return;
        }

        btn.addClass('dc_disabled');
        btn.find('i').removeClass('fa-backward').addClass('fa-spinner fa-spin');

        try {
            await score_chat_retroactively();
        } catch (err) {
            toastr.error(`Retroactive scoring failed: ${err.message}`, MODULE_NAME_FANCY);
        } finally {
            btn.removeClass('dc_disabled');
            btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-backward');
        }
    });

    $(document).on('click', '#dc_btn_reextract', async function () {
        const btn = $(this);
        btn.addClass('dc_disabled');

        try {
            const context = getContext();
            const char_desc = get_full_character_description();
            if (!char_desc) {
                toastr.warning('No character loaded.', MODULE_NAME_FANCY);
                return;
            }

            toastr.info('Calibrating dimensions...', MODULE_NAME_FANCY);
            const dims = await calibrate_dimensions(char_desc);
            if (dims.length > 0) {
                const state = get_chat_state();
                state.dimensions = dims;
                state.calibration_hash = hash_description(char_desc);
                state.dimensions_manually_edited = false;
                CURRENT_DIMENSIONS = dims;

                // Pin calibration for this character
                save_pinned_calibration(dims);

                // Regenerate baseline Author's Note
                if (get_settings('baseline_enabled')) {
                    try {
                        const baseline = await generate_baseline(dims, char_desc);
                        if (baseline) {
                            state.baseline_text = baseline;
                            inject_baseline(baseline);
                        }
                    } catch (err) {
                        warn('Baseline generation failed:', err);
                    }
                }

                save_chat_state(state);
                update_dashboard();
                toastr.success(`Calibrated ${dims.length} dimensions`, MODULE_NAME_FANCY);
            } else {
                toastr.error('Failed to calibrate dimensions.', MODULE_NAME_FANCY);
            }
        } catch (err) {
            toastr.error(`Dimension calibration failed: ${err.message}`, MODULE_NAME_FANCY);
        } finally {
            btn.removeClass('dc_disabled');
        }
    });

    $(document).on('click', '#dc_btn_clear_corrections', function () {
        clear_correction();
        const state = get_chat_state();
        state.active_correction = { enabled: false };
        state.cooldown_remaining = 0;
        save_chat_state(state);
        update_correction_panel();
        toastr.success('Corrections cleared', MODULE_NAME_FANCY);
    });

    $(document).on('click', '#dc_btn_clear_scores', function () {
        if (!confirm('Clear all score history for this chat? This cannot be undone.')) return;

        const state = get_chat_state();
        state.score_history = [];
        state.drift_state = {};
        state.messages_scored = 0;
        state.last_scored_message_id = null;
        state.corrections_injected = 0;
        state.active_correction = { enabled: false };
        state.ceiling_dimensions = [];
        state.ever_cusum_triggered = [];
        state.ever_ma_triggered = [];
        state.ma_consecutive_above = {};
        state.cooldown_remaining = 0;
        state.recovery_cycles = 0;
        state.report = null;
        CURRENT_DRIFT_STATE = {};
        clear_correction();
        save_chat_state(state);

        // Remove per-message badges
        document.querySelectorAll('.dc_message_badge_container').forEach(el => el.remove());

        // Remove per-message driftguard data
        const chat = getContext().chat;
        if (chat) {
            for (const msg of chat) {
                if (msg?.extra?.driftguard) {
                    delete msg.extra.driftguard;
                }
            }
        }

        update_dashboard();
        update_report_display();
        toastr.success('Scores and corrections cleared', MODULE_NAME_FANCY);
    });

    // Report buttons
    $(document).on('click', '#dc_btn_generate_report', async function () {
        const btn = $(this);
        btn.addClass('dc_disabled');
        btn.find('i').removeClass('fa-chart-line').addClass('fa-spinner fa-spin');

        try {
            toastr.info('Generating report...', MODULE_NAME_FANCY);
            const report = await generate_report();
            if (report) {
                update_report_display();
                toastr.success('Report generated', MODULE_NAME_FANCY);
            }
        } catch (err) {
            toastr.error(`Report generation failed: ${err.message}`, MODULE_NAME_FANCY);
        }

        btn.removeClass('dc_disabled');
        btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-chart-line');
    });

    $(document).on('click', '#dc_btn_export_report', function () {
        export_report();
    });

    $(document).on('click', '#dc_btn_export_all', function () {
        export_all_reports();
    });

    $(document).on('click', '#dc_btn_compare', function () {
        compare_reports();
    });

    // Correction text toggle
    $(document).on('click', '#dc_correction_toggle', function () {
        const content = $('#dc_correction_text');
        const toggle = $(this);
        if (content.is(':visible')) {
            content.slideUp(200);
            toggle.removeClass('expanded');
            toggle.find('span').text('Show injected text');
        } else {
            content.slideDown(200);
            toggle.addClass('expanded');
            toggle.find('span').text('Hide injected text');
        }
    });

    // Popout feature
    add_popout_button();
}

/**
 * Update the plugin connection status indicator.
 */
function update_plugin_status(connected) {
    const el = document.getElementById('dc_plugin_status');
    if (!el) return;

    if (connected) {
        el.innerHTML = '<span class="dc_connection_indicator connected"></span> Connected';
    } else {
        el.innerHTML = '<span class="dc_connection_indicator disconnected"></span> Not Connected';
    }
}

/**
 * Restore UI controls from saved settings.
 */
function restore_settings_to_ui() {
    // Checkboxes
    $('#dc_enabled').prop('checked', get_settings('enabled'));
    $('#dc_score_on_first').prop('checked', get_settings('score_on_first'));
    $('#dc_correction_enabled').prop('checked', get_settings('correction_enabled'));
    $('#dc_baseline_enabled').prop('checked', get_settings('baseline_enabled'));
    $('#dc_show_per_message_badges').prop('checked', get_settings('show_per_message_badges'));
    $('#dc_show_toast_on_drift').prop('checked', get_settings('show_toast_on_drift'));

    // Backend radio
    const backend = get_settings('analysis_backend');
    if (backend === 'openai') {
        $('#dc_backend_openai').prop('checked', true);
        $('#dc_claude_settings').hide();
        $('#dc_openai_settings').show();
    } else {
        $('#dc_backend_claude').prop('checked', true);
        $('#dc_claude_settings').show();
        $('#dc_openai_settings').hide();
    }

    // Text inputs
    $('#dc_claude_model').val(get_settings('claude_code_model'));
    $('#dc_openai_endpoint').val(get_settings('openai_endpoint'));
    $('#dc_openai_api_key').val(get_settings('openai_api_key'));
    $('#dc_openai_model').val(get_settings('openai_model'));

    // Sliders
    const sliders = {
        'dc_score_frequency': { key: 'score_frequency', display: 'dc_score_frequency_value', format: v => v },
        'dc_drift_window': { key: 'drift_window', display: 'dc_drift_window_value', format: v => v },
        'dc_drift_threshold': { key: 'drift_threshold', display: 'dc_drift_threshold_value', format: v => parseFloat(v).toFixed(2) },
        'dc_drift_alert_threshold': { key: 'drift_alert_threshold', display: 'dc_drift_alert_threshold_value', format: v => parseFloat(v).toFixed(2) },
        'dc_correction_depth': { key: 'correction_depth', display: 'dc_correction_depth_value', format: v => v },
        'dc_correction_max_dimensions': { key: 'correction_max_dimensions', display: 'dc_correction_max_dimensions_value', format: v => v },
        'dc_correction_patience': { key: 'correction_patience', display: 'dc_correction_patience_value', format: v => v },
        'dc_correction_max_attempts': { key: 'correction_max_attempts', display: 'dc_correction_max_attempts_value', format: v => v },
        'dc_correction_cooldown': { key: 'correction_cooldown', display: 'dc_correction_cooldown_value', format: v => v },
        'dc_recovery_margin': { key: 'recovery_margin', display: 'dc_recovery_margin_value', format: v => parseFloat(v).toFixed(2) },
        'dc_recovery_patience': { key: 'recovery_patience', display: 'dc_recovery_patience_value', format: v => v },
        'dc_baseline_depth': { key: 'baseline_depth', display: 'dc_baseline_depth_value', format: v => v },
    };

    for (const [id, config] of Object.entries(sliders)) {
        const val = get_settings(config.key);
        $(`#${id}`).val(val);
        $(`#${config.display}`).text(config.format(val));
    }
}

// ==================== EVENT LISTENERS ====================

function register_event_listeners() {
    // Chat changed: calibrate dimensions if needed, restore state
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        log('Chat changed, initializing...');

        // Clear stale scoring state from previous chat to prevent blocking
        if (SCORING_IN_PROGRESS) {
            log('Clearing in-progress scoring state due to chat change');
            SCORING_IN_PROGRESS = false;
        }
        SCORING_QUEUE = [];
        PENDING_SWIPE_RESCORES.clear();

        const state = get_chat_state();
        const context = getContext();
        const char_desc = get_full_character_description();

        // Version-gated data wipe: clear incompatible old scoring data
        if (state.data_version !== MODULE_VERSION) {
            log(`Data version mismatch: ${state.data_version || 'none'} -> ${MODULE_VERSION}. Wiping old scoring data.`);
            state.score_history = [];
            state.drift_state = {};
            state.active_correction = { enabled: false };
            state.ceiling_dimensions = [];
            state.ever_corrected_dimensions = [];
            state.ever_cusum_triggered = [];
            state.ever_ma_triggered = [];
            state.ma_consecutive_above = {};
            state.cusum_reset_after = {};
            state.messages_scored = 0;
            state.last_scored_message_id = null;
            state.recovery_cycles = 0;
            state.cooldown_remaining = 0;
            state.corrections_injected = 0;
            state.report = null;
            state.baseline_text = null;
            state.dimensions = [];
            state.calibration_hash = null;
            state.data_version = MODULE_VERSION;

            // Clear per-message driftguard markers from old scores
            const chat = context.chat;
            if (chat) {
                for (const msg of chat) {
                    if (msg?.extra?.driftguard) delete msg.extra.driftguard;
                }
            }

            // Clear pinned calibrations (old calibrations lack rubric context)
            set_settings('character_dimensions', {});

            clear_correction();
            clear_baseline();
            save_chat_state(state);
            CURRENT_DIMENSIONS = [];
            CURRENT_DRIFT_STATE = {};

            // Remove old per-message badges from DOM
            document.querySelectorAll('.dc_message_badge_container').forEach(el => el.remove());

            toastr.info(`DriftGuard upgraded to v${MODULE_VERSION}. Old scoring data cleared — dimensions will recalibrate.`, MODULE_NAME_FANCY);
        }

        // Validate score history integrity (filter corrupt entries)
        if (Array.isArray(state.score_history) && state.score_history.length > 0) {
            const before = state.score_history.length;
            state.score_history = state.score_history.filter(entry =>
                entry && typeof entry === 'object'
                && entry.scores && typeof entry.scores === 'object'
                && entry.message_id !== undefined
            );
            if (state.score_history.length < before) {
                warn(`Filtered ${before - state.score_history.length} corrupt score history entries`);
                save_chat_state(state);
            }
        }

        if (!char_desc) {
            CURRENT_DIMENSIONS = [];
            CURRENT_DRIFT_STATE = {};
            update_dashboard();
            return;
        }

        const desc_hash = hash_description(char_desc);

        // Check if dimensions need calibration
        if (!state.dimensions || state.dimensions.length === 0 || (desc_hash !== state.calibration_hash && !state.dimensions_manually_edited)) {
            // Try to load pinned calibration for this character first
            const pinned = load_pinned_calibration();
            if (pinned && pinned.length > 0) {
                log('Loaded pinned calibration from global settings');
                state.dimensions = pinned;
                state.calibration_hash = desc_hash;
                save_chat_state(state);
            } else if (CALIBRATION_IN_PROGRESS) {
                log('Calibration already in progress, restoring existing state');
            } else {
                CALIBRATION_IN_PROGRESS = true;
                const calibration_chat_id = context.chatId;
                try {
                    log('Calibrating dimensions for character...');
                    const dims = await calibrate_dimensions(char_desc);
                    if (getContext().chatId !== calibration_chat_id) {
                        log('Chat changed during calibration, discarding stale results');
                        return;
                    }
                    if (dims.length > 0) {
                        state.dimensions = dims;
                        state.calibration_hash = desc_hash;
                        save_chat_state(state);
                        save_pinned_calibration(dims);
                        log(`Dimensions calibrated: ${dims.map(d => `${d.id}=${d.target.toFixed(2)}`).join(', ')}`);

                        // Generate baseline Author's Note alongside calibration
                        if (get_settings('baseline_enabled')) {
                            try {
                                const baseline = await generate_baseline(dims, char_desc);
                                if (baseline && getContext().chatId === calibration_chat_id) {
                                    state.baseline_text = baseline;
                                    save_chat_state(state);
                                    log('Baseline Author\'s Note generated');
                                }
                            } catch (err) {
                                warn('Baseline generation failed:', err);
                            }
                        }
                    }
                } catch (err) {
                    error('Dimension calibration failed:', err);
                } finally {
                    CALIBRATION_IN_PROGRESS = false;
                }
            }
        }

        // Restore module state
        CURRENT_DIMENSIONS = state.dimensions || [];
        CURRENT_DRIFT_STATE = state.drift_state || {};

        // Rebuild drift state from score history if needed
        if (CURRENT_DIMENSIONS.length > 0 && state.score_history?.length > 0 && Object.keys(CURRENT_DRIFT_STATE).length === 0) {
            CURRENT_DRIFT_STATE = update_drift_state(CURRENT_DIMENSIONS, state.score_history, state.cusum_reset_after || {});
            state.drift_state = CURRENT_DRIFT_STATE;
            save_chat_state(state);
        }

        // Re-inject baseline Author's Note if enabled and available
        if (get_settings('baseline_enabled') && state.baseline_text) {
            inject_baseline(state.baseline_text);
        }

        // Re-inject active correction if one exists and corrections are globally enabled
        if (get_settings('correction_enabled') && state.active_correction?.enabled && state.active_correction?.injection_text) {
            inject_correction(state.active_correction.injection_text);
        }

        update_dashboard();
        update_report_display();
        update_message_badges();
    });

    // Message received: scoring pipeline + swipe re-score
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        // Check if this is a swipe re-score (previously scored message was swiped)
        if (PENDING_SWIPE_RESCORES.has(id)) {
            PENDING_SWIPE_RESCORES.delete(id);
            log(`Swipe re-score triggered for message #${id}`);
            setTimeout(() => score_and_process_message(id, { force: true }), 500);
            return;
        }

        // Normal auto-scoring pipeline
        setTimeout(() => on_message_received(id), 500);
    });

    // Message swiped: discard old score and flag for re-score
    eventSource.on(event_types.MESSAGE_SWIPED, (data) => {
        const state = get_chat_state();
        if (!state.score_history?.length) return;

        const message_id = typeof data === 'number' ? data : data?.id;
        if (message_id === undefined) return;

        // Remove score for this message from history
        const before = state.score_history.length;
        state.score_history = state.score_history.filter(s => s.message_id !== message_id);
        const was_scored = state.score_history.length < before;

        if (was_scored) {
            log(`Discarded score for swiped message #${message_id}`);

            // Also clear per-message badge data so the old badges don't linger
            const chat = getContext().chat;
            const message = chat?.[message_id];
            if (message?.extra?.driftguard) {
                delete message.extra.driftguard;
            }

            // Recompute drift state
            if (CURRENT_DIMENSIONS.length > 0) {
                CURRENT_DRIFT_STATE = update_drift_state(CURRENT_DIMENSIONS, state.score_history, state.cusum_reset_after || {});
                state.drift_state = CURRENT_DRIFT_STATE;
            }
            save_chat_state(state);
            update_dashboard();

            // Flag this message for re-scoring when the new swipe renders
            PENDING_SWIPE_RESCORES.add(message_id);
            log(`Flagged message #${message_id} for swipe re-score`);
        }
    });
}

// ==================== SETTINGS HTML LOADING ====================

async function load_settings_html() {
    log('Loading settings HTML...');

    const module_dir = new URL(import.meta.url).pathname;
    const settings_path = module_dir.substring(0, module_dir.lastIndexOf('/')) + '/settings.html';

    await $.get(settings_path).then(response => {
        $('#extensions_settings2').append(response);
        log('Settings HTML loaded');
    }).catch(err => {
        error('Failed to load settings HTML:', err);
    });
}

// ==================== ENTRY POINT ====================

jQuery(async function () {
    log('Loading DriftGuard...');

    // Initialize settings
    initialize_settings();

    // Load settings HTML
    await load_settings_html();

    // Setup UI and events
    initialize_ui_listeners();
    register_event_listeners();

    // Restore UI from saved settings
    restore_settings_to_ui();

    // Restore state for current chat
    try {
        const state = get_chat_state();
        if (state.dimensions?.length > 0) {
            CURRENT_DIMENSIONS = state.dimensions;
            CURRENT_DRIFT_STATE = state.drift_state || {};
            update_dashboard();
            update_report_display();
        }
    } catch (e) {
        error('Initialization error:', e);
    }

    // Auto-probe backend on startup
    if (get_settings('analysis_backend') === 'claude_code') {
        try {
            const probe = await fetch('/api/plugins/driftguard/probe', { method: 'POST', headers: getRequestHeaders() });
            PLUGIN_AVAILABLE = probe.ok;
            PLUGIN_PROBE_TIMESTAMP = Date.now();
            update_plugin_status(PLUGIN_AVAILABLE);
        } catch {
            PLUGIN_AVAILABLE = false;
            PLUGIN_PROBE_TIMESTAMP = Date.now();
            update_plugin_status(false);
        }
    }

    log('DriftGuard loaded successfully');
});
