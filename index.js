// DriftGuard -- Character Drift Corrector
// Monitors live roleplay for trait drift and auto-injects targeted Author's Notes
// to reinforce decaying personality traits.

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
const MODULE_VERSION = '0.3.0';
const LOG_PREFIX = `[${MODULE_NAME_FANCY}]`;
const MIN_SCORES_FOR_CORRECTION = 2;

// ==================== PROMPTS ====================

const TRAIT_EXTRACTION_PROMPT = `You are a character analyst. Given this character card description, identify the 3-7 most dominant personality traits that an AI model might drift away from during a long conversation.

Focus on traits that:
- Conflict with typical AI helpfulness/agreeableness (cold, hostile, avoidant, manipulative)
- Require sustained negative emotional states (trauma, distrust, fear)
- Go against conversational norms (terse, nonverbal, evasive)
- Are specific and distinctive behaviors that could flatten into generic AI responses
- Give this character a UNIQUE voice that could drift toward bland/generic (distinctive speech patterns, quirky mannerisms, unusual perspectives, specific humor style)
- Could lose their specificity over time (e.g., a cheerful character becoming generically pleasant, an intellectual character becoming generically knowledgeable, a quirky character becoming conventionally normal)
- Are specific behaviors, not generic descriptors

IMPORTANT: Drift is not just about "nice vs. mean." Characters drift toward BLANDNESS. A warm healer drifts toward generic warmth. A wise mentor drifts toward generic advice-giving. A sarcastic friend drifts toward generic humor. Identify the SPECIFIC traits that make this character distinct from a generic version of their archetype.

For each trait provide:
- label: Short name (2-5 words)
- description: One sentence describing the behavioral expectation
- dimension: One of: temperament, sociability, emotional, moral, trust, communication, romance
- polarity: "low" or "high" on that dimension
- keywords: 3-5 words that indicate this trait is being expressed

CHARACTER DESCRIPTION:
{{description}}

Respond with ONLY a JSON array. No other text.`;

const SCORING_PROMPT = `Score this character response for adherence to each personality trait. Rate 0.0-1.0 where:
- 1.0 = Perfectly expresses this trait
- 0.7 = Clearly present
- 0.4 = Weakly present or inconsistent
- 0.1 = Absent or contradicted

Consider the conversation context when scoring. A trait may be situationally suppressed (e.g. a cold character showing brief vulnerability in an extreme situation) -- score based on whether the expression fits the character, not just keyword presence.

CHARACTER CONTEXT (for reference -- this is how the character is supposed to behave):
{{character_description}}

RECENT CONVERSATION (for context):
{{recent_context}}

TRAITS TO SCORE:
{{traits_json}}

RESPONSE TO SCORE:
{{response_text}}

Respond with ONLY a JSON object mapping trait labels to scores. No other text.
Example: {"Cold and calculating": 0.82, "Distrustful": 0.45}`;

const CORRECTION_GENERATION_PROMPT = `You are writing a brief Author's Note to steer a roleplay AI back toward a character's core traits. The note will be injected into the conversation context.

RULES:
- Write 2-4 sentences of BEHAVIORAL cues, not meta-instructions
- Show how the character acts, not what they should be
- Use present tense, narrative style ("she deflects", "he avoids eye contact")
- Reference specific mannerisms, speech patterns, physical responses
- NEVER use words like "must", "should", "important", "critical", "remember"
- NEVER use negation ("does not soften" -> instead show what she DOES instead)
- Draw behavioral details from the character description below
- IMPORTANT: Reinforce the DRIFTING traits below WITHOUT suppressing or contradicting the STABLE traits. The character should express ALL listed traits coherently.

CHARACTER DESCRIPTION:
{{description}}

ALL CHARACTER TRAITS (maintain these holistically):
{{all_traits}}

TRAITS THAT ARE DRIFTING (focus reinforcement here):
{{drifting_traits}}

RECENT CONVERSATION (last 3 exchanges):
{{recent_context}}

WHAT WENT WRONG (scoring evidence):
{{drift_evidence}}

{{escalation_block}}

Write the Author's Note. No preamble, no explanation -- just the behavioral cues.`;

const BASELINE_GENERATION_PROMPT = `You are writing a brief, persistent Author's Note to anchor a roleplay AI character's core personality. This note will be present throughout the conversation to prevent gradual personality drift.

RULES:
- Write 2-3 sentences of BEHAVIORAL cues that capture the character's essence
- Focus on the most distinctive traits that make this character unique
- Use present tense, narrative style ("she deflects", "he avoids eye contact")
- Reference specific mannerisms, speech patterns, physical responses
- Keep it subtle — this is background anchoring, not correction
- NEVER use words like "must", "should", "important", "critical", "remember"
- NEVER use negation ("does not soften" -> instead show what she DOES instead)

CHARACTER DESCRIPTION:
{{description}}

KEY PERSONALITY TRAITS:
{{traits_summary}}

Write the Author's Note. No preamble, no explanation -- just the behavioral cues.`;

const REPORT_INSIGHTS_PROMPT = `Analyze this roleplay session report and provide actionable insights.

CHARACTER: {{char_name}}
MODEL: {{model_name}}
CARD RESILIENCE: {{card_score}}/100
SESSION QUALITY: {{session_score}}/100
MODEL COMPATIBILITY: {{model_score}}/100

PER-TRAIT DATA:
{{trait_breakdown}}

CORRECTIONS APPLIED:
{{correction_history}}

Provide:
1. Which traits the card handles well vs. poorly and why
2. Specific card revision suggestions (reference the character description)
3. What the user could do differently in prompting/direction
4. Model-specific observations (what {{model_name}} struggles with here)

Be specific and actionable. Reference trait names and message numbers.`;

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
    drift_threshold: 0.4,
    drift_alert_threshold: 0.25,

    // Correction
    correction_enabled: true,
    correction_depth: 4,
    correction_max_traits: 3,
    correction_patience: 3,
    correction_max_attempts: 2,
    correction_cooldown: 2,
    recovery_margin: 0.1,
    recovery_patience: 2,

    // Baseline Author's Note
    baseline_enabled: true,
    baseline_depth: 6,

    // Display
    show_per_message_badges: true,
    show_toast_on_drift: true,

    // Report index (cross-session)
    report_index: [],
};

// ==================== EMPTY CHAT STATE ====================

function create_empty_chat_state() {
    return {
        traits: [],
        trait_extraction_hash: null,
        traits_manually_edited: false,
        score_history: [],
        drift_state: {},
        active_correction: { enabled: false },
        ceiling_traits: [],
        ceiling_model: null,
        cooldown_remaining: 0,
        recovery_cycles: 0,
        messages_scored: 0,
        corrections_injected: 0,
        ever_corrected_traits: [],
        last_scored_message_id: null,
        baseline_text: null,
        report: null,
    };
}

// ==================== MODULE STATE ====================

let CURRENT_TRAITS = [];
let CURRENT_DRIFT_STATE = {};
let SCORING_IN_PROGRESS = false;
let SCORING_QUEUE = [];
let EXTRACTION_IN_PROGRESS = false;
let PLUGIN_AVAILABLE = null; // null = unknown, true = available, false = unavailable
let PLUGIN_PROBE_TIMESTAMP = 0;
const PLUGIN_PROBE_TTL_MS = 300000; // 5 minutes

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
    if (!arr || arr.length === 0) return 0;
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
    const alpha = 2 / (window_size + 1);
    let result = arr[0];
    for (let i = 1; i < arr.length; i++) {
        result = alpha * arr[i] + (1 - alpha) * result;
    }
    return result;
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
 * Generate a stable slug ID from a trait label.
 * "Cold and calculating" -> "cold_and_calculating"
 */
function slugify(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Normalize a trait label for fuzzy matching.
 * Strips punctuation, collapses whitespace, lowercases.
 */
function normalize_label(label) {
    return label.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
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

        const controller = new AbortController();
        const timeout_id = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeout_id);

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
            clearTimeout(timeout_id);
            if (err.name === 'AbortError') {
                throw new Error('Analysis API request timed out after 30s');
            }
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

// ==================== TRAIT EXTRACTION ====================

/**
 * Hash a character description for cache invalidation.
 */
function hash_description(description) {
    return getStringHash(description || '');
}

/**
 * Extract personality traits from a character description using the analysis backend.
 */
async function extract_traits(character_description) {
    if (!character_description || character_description.trim().length === 0) {
        warn('No character description provided for trait extraction');
        return [];
    }

    const prompt = TRAIT_EXTRACTION_PROMPT.replace('{{description}}', character_description);

    const messages = [
        { role: 'system', content: 'You are a character analyst. Respond only in valid JSON.' },
        { role: 'user', content: prompt },
    ];

    const result = await analyze(messages, 800);

    if (!Array.isArray(result)) {
        error('Trait extraction did not return an array:', result);
        return [];
    }

    // Validate and post-process traits
    const valid_dimensions = ['temperament', 'sociability', 'emotional', 'moral', 'trust', 'communication', 'romance'];
    const processed = [];

    for (const trait of result) {
        if (!trait.label || !trait.description) {
            warn('Skipping trait with missing label/description:', trait);
            continue;
        }

        const id = slugify(trait.label);
        processed.push({
            id: id,
            label: trait.label,
            description: trait.description,
            dimension: valid_dimensions.includes(trait.dimension) ? trait.dimension : 'temperament',
            polarity: trait.polarity === 'high' ? 'high' : 'low',
            keywords: Array.isArray(trait.keywords) ? trait.keywords.slice(0, 5) : [],
        });
    }

    // Clamp to 3-7 traits
    if (processed.length > 7) {
        warn(`Extracted ${processed.length} traits, clamping to 7`);
        return processed.slice(0, 7);
    }
    if (processed.length < 3 && processed.length > 0) {
        warn(`Only extracted ${processed.length} traits (expected 3-7)`);
    }

    log(`Extracted ${processed.length} traits:`, processed.map(t => t.label));
    return processed;
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
 * Score an AI response against the extracted traits.
 */
async function score_response(response_text, traits, char_description, message_index) {
    // Truncate long responses to avoid overflowing the analysis model's context
    const MAX_RESPONSE_LENGTH = 1500;
    let scoring_text = response_text || '';
    if (scoring_text.length > MAX_RESPONSE_LENGTH) {
        const HEAD = 800;
        const TAIL = 700;
        scoring_text = scoring_text.substring(0, HEAD) + '\n[...truncated...]\n' + scoring_text.substring(scoring_text.length - TAIL);
        log(`Response truncated for scoring: ${response_text.length} -> ${scoring_text.length} chars`);
    }

    const traits_json = traits.map(t => {
        const kw = t.keywords?.length > 0 ? ` (keywords: ${t.keywords.join(', ')})` : '';
        return `- "${t.label}": ${t.description}${kw}`;
    }).join('\n');
    const char_desc_text = char_description || '';

    // Build recent conversation context (last 6 messages before the scored response)
    const context_chat = getContext().chat || [];
    const ctx_end = message_index !== undefined ? message_index : context_chat.length - 1;
    const recent_messages = context_chat.slice(Math.max(0, ctx_end - 6), ctx_end);
    const recent_context = recent_messages.length > 0
        ? recent_messages.map(m => {
            const text = m.mes || '';
            // For long messages, include opening + closing to capture drift that manifests at the end
            let truncated;
            if (text.length > 500) {
                truncated = text.substring(0, 300) + '\n[...]\n' + text.substring(text.length - 200);
            } else {
                truncated = text;
            }
            return `${m.is_user ? 'User' : 'Character'}: ${truncated}`;
        }).join('\n')
        : '(No prior messages available)';

    const prompt = SCORING_PROMPT
        .replace('{{character_description}}', char_desc_text)
        .replace('{{recent_context}}', recent_context)
        .replace('{{traits_json}}', traits_json)
        .replace('{{response_text}}', scoring_text);

    const messages = [
        { role: 'system', content: 'You are a character analyst. Score trait adherence. Respond only in valid JSON.' },
        { role: 'user', content: prompt },
    ];

    const raw_scores = await analyze(messages, 300);

    if (!raw_scores || typeof raw_scores !== 'object') {
        error('Scoring did not return a valid object:', raw_scores);
        return {};
    }

    // Map label-keyed scores from the LLM to stable trait IDs
    const id_scores = {};
    const raw_keys = Object.keys(raw_scores);

    for (const trait of traits) {
        let score = raw_scores[trait.label];
        if (score === undefined) {
            // Fallback 1: case-insensitive match
            const ci_match = raw_keys.find(k => k.toLowerCase() === trait.label.toLowerCase());
            if (ci_match) score = raw_scores[ci_match];
        }
        if (score === undefined) {
            // Fallback 2: normalized (strips punctuation/whitespace)
            const norm = normalize_label(trait.label);
            const norm_match = raw_keys.find(k => normalize_label(k) === norm);
            if (norm_match) score = raw_scores[norm_match];
        }
        if (score === undefined) {
            // Fallback 3: substring (handles truncated/extended labels)
            const norm = normalize_label(trait.label);
            const sub_match = raw_keys.find(k => {
                const nk = normalize_label(k);
                return nk.includes(norm) || norm.includes(nk);
            });
            if (sub_match) score = raw_scores[sub_match];
        }
        if (score !== undefined) {
            const parsed = parseFloat(score);
            if (Number.isNaN(parsed)) {
                warn(`Non-numeric score for "${trait.label}": ${JSON.stringify(score)} -- skipping`);
                continue;
            }
            id_scores[trait.id] = Math.max(0, Math.min(1, parsed));
        }
    }

    const unscored = traits.filter(t => id_scores[t.id] === undefined);
    if (unscored.length > 0) {
        warn(`${unscored.length}/${traits.length} traits unscored: ${unscored.map(t => t.label).join(', ')}`);
    }

    return id_scores;
}

/**
 * Store scores in both per-message data and chat-level history.
 */
function store_scores(message, message_index, scores) {
    const state = get_chat_state();

    // Per-message data
    if (!message.extra) message.extra = {};
    message.extra.driftguard = {
        scored: true,
        scores: scores,
        correction_active: state.active_correction?.enabled || false,
    };

    // Chat-level score history
    state.score_history.push({
        message_id: message_index,
        timestamp: Date.now(),
        scores: scores,
        content_hash: getStringHash((message.mes || '').substring(0, 200)),
    });

    // Cap score history to prevent unbounded growth
    const MAX_SCORE_HISTORY = 200;
    if (state.score_history.length > MAX_SCORE_HISTORY) {
        state.score_history.splice(0, state.score_history.length - MAX_SCORE_HISTORY);
    }

    state.last_scored_message_id = message_index;
    save_chat_state(state);
}

// ==================== DRIFT DETECTION ====================

/**
 * Compute drift state using a simple moving average over recent scored messages.
 */
function update_drift_state(traits, score_history) {
    const drift_window = get_settings('drift_window');
    const threshold = get_settings('drift_threshold');
    const alert_threshold = get_settings('drift_alert_threshold');
    const drift_state = {};

    for (const trait of traits) {
        const recent_scores = score_history
            .slice(-drift_window)
            .map(entry => entry.scores[trait.id])
            .filter(s => s !== undefined);

        if (recent_scores.length === 0) {
            drift_state[trait.id] = { moving_avg: null, trend: 'no_data', correcting: false, severe: false };
            continue;
        }

        const moving_avg = ema(recent_scores, drift_window);

        if (recent_scores.length < MIN_SCORES_FOR_CORRECTION) {
            drift_state[trait.id] = {
                moving_avg,
                trend: 'insufficient_data',
                correcting: false,   // Never trigger correction with insufficient data
                severe: false,
            };
            continue;
        }

        // Simple trend: compare first half avg to second half avg
        const mid = Math.floor(recent_scores.length / 2);
        const first_half = mean(recent_scores.slice(0, mid));
        const second_half = mean(recent_scores.slice(mid));
        const trend = second_half < first_half - 0.05 ? 'declining'
            : second_half > first_half + 0.05 ? 'improving'
            : 'stable';

        const needs_correction = moving_avg < threshold;
        const severe = moving_avg < alert_threshold;

        drift_state[trait.id] = { moving_avg, trend, correcting: needs_correction, severe };
    }

    return drift_state;
}

/**
 * Compute per-trait averages using only scores recorded AFTER a correction was injected.
 * Used for evaluating correction effectiveness without dilution from pre-correction low scores.
 * Falls back to null for traits with no post-correction data.
 */
function compute_post_correction_averages(trait_ids, score_history, since_message) {
    const averages = {};
    for (const trait_id of trait_ids) {
        const post_scores = score_history
            .filter(entry => entry.message_id > since_message)
            .map(entry => entry.scores[trait_id])
            .filter(s => s !== undefined);

        averages[trait_id] = post_scores.length > 0 ? mean(post_scores) : null;
    }
    return averages;
}

// ==================== CORRECTION GENERATION & INJECTION ====================

/**
 * Generate a behavioral correction using the analysis backend.
 */
async function generate_correction(drifting_traits, all_traits, char_description, chat, scoring_evidence, escalation_context) {
    const max = get_settings('correction_max_traits');
    const worst = [...drifting_traits]
        .sort((a, b) => a.moving_avg - b.moving_avg)
        .slice(0, max);

    const trait_descriptions = worst.map(dt => {
        const trait = all_traits.find(t => t.id === dt.trait_id) || all_traits.find(t => t.label === dt.label);
        const label = trait?.label || dt.label || dt.trait_id;
        const desc = trait?.description || 'No description';
        return `- ${label} (${desc}) -- current score: ${(dt.moving_avg || 0).toFixed(2)}, trend: ${dt.trend || 'unknown'}`;
    }).join('\n');

    const recent_context = (chat || [])
        .slice(-6)
        .map(m => `${m.is_user ? 'User' : 'Character'}: ${(m.mes || '').substring(0, 300)}`)
        .join('\n');

    const window_size = get_settings('drift_window');
    const state = get_chat_state();
    const evidence = worst.map(dt => {
        const trait_id = dt.trait_id || all_traits.find(t => t.label === dt.label)?.id;
        const window_scores = (state.score_history || [])
            .slice(-window_size)
            .map(s => s.scores[trait_id])
            .filter(s => s !== undefined);
        const first_in_window = window_scores.length > 0 ? window_scores[0].toFixed(2) : '?';
        const label = dt.label || trait_id;
        return `${label}: dropped from ~${first_in_window} to ${(dt.moving_avg || 0).toFixed(2)} over ${window_scores.length} scored messages`;
    }).join('\n');

    let escalation_block = '';
    if (escalation_context) {
        const score_before = escalation_context.score_at_correction !== undefined
            ? escalation_context.score_at_correction.toFixed(2) : '?';
        const score_after = escalation_context.score_after !== undefined
            ? escalation_context.score_after.toFixed(2) : '?';
        const delta = (escalation_context.score_after !== undefined && escalation_context.score_at_correction !== undefined)
            ? (escalation_context.score_after > escalation_context.score_at_correction + 0.02 ? 'slight improvement'
                : escalation_context.score_after < escalation_context.score_at_correction - 0.02 ? 'worsened'
                : 'no change')
            : 'unknown';
        escalation_block = `IMPORTANT: A previous correction (attempt ${escalation_context.attempt || 1} of ${escalation_context.patience || '?'}) was already attempted but the character continued to drift.
The previous correction scored ${score_before} at injection. After ${escalation_context.attempt || 1} scored messages, the worst drifting trait is now at ${score_after} (${delta}).
The previous correction was:
${escalation_context.previous_text}
Generate a DIFFERENT correction with stronger behavioral anchoring. Use more specific, concrete behavioral cues. Include physical response patterns and speech mannerisms.`;
    }

    // Build full trait list for context (so correction doesn't suppress stable traits)
    const all_traits_text = all_traits.map(t => {
        const drift_info = drifting_traits.find(dt => dt.trait_id === t.id || dt.label === t.label);
        const status = drift_info ? 'DRIFTING' : 'STABLE';
        return `- ${t.label} (${t.description}) [${status}]`;
    }).join('\n');

    const prompt = CORRECTION_GENERATION_PROMPT
        .replace('{{description}}', char_description || '')
        .replace('{{all_traits}}', all_traits_text)
        .replace('{{drifting_traits}}', trait_descriptions)
        .replace('{{recent_context}}', recent_context)
        .replace('{{drift_evidence}}', evidence)
        .replace('{{escalation_block}}', escalation_block);

    const messages = [
        { role: 'system', content: 'You write brief behavioral Author\'s Notes for roleplay character steering. Output ONLY the note text.' },
        { role: 'user', content: prompt },
    ];

    const result = await analyze(messages, 300, false); // expect_json=false: corrections are prose
    return typeof result === 'string' ? result.trim() : String(result).trim();
}

/**
 * Inject correction text as an Author's Note via SillyTavern's extension prompt system.
 */
function inject_correction(correction_text) {
    const configured_depth = get_settings('correction_depth');
    const context = getContext();
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
 */
function clear_correction() {
    const context = getContext();
    context.setExtensionPrompt('driftguard_correction', '', extension_prompt_types.IN_PROMPT, 0);
    log('Correction cleared');
}

// ==================== BASELINE AUTHOR'S NOTE ====================

/**
 * Generate a lightweight baseline Author's Note from extracted traits.
 * This provides continuous behavioral anchoring to prevent drift before it starts.
 */
async function generate_baseline(traits, char_description) {
    if (!traits || traits.length === 0) return null;

    const traits_summary = traits.map(t => `- ${t.label}: ${t.description}`).join('\n');

    const prompt = BASELINE_GENERATION_PROMPT
        .replace('{{description}}', char_description || '')
        .replace('{{traits_summary}}', traits_summary);

    const messages = [
        { role: 'system', content: 'You write brief behavioral Author\'s Notes for roleplay character anchoring. Output ONLY the note text.' },
        { role: 'user', content: prompt },
    ];

    const result = await analyze(messages, 200, false);
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
    if (!state.traits || state.traits.length === 0) return;

    const has_active_correction = state.active_correction?.enabled && state.active_correction?.injection_text;

    // Inject baseline Author's Note if enabled and available
    // Suppress baseline when an active correction is present (correction subsumes baseline)
    if (get_settings('baseline_enabled') && state.baseline_text) {
        if (has_active_correction) {
            clear_baseline();
        } else {
            inject_baseline(state.baseline_text);
        }
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
async function on_message_received(message_index) {
    if (!get_settings('enabled')) return;
    if (SCORING_IN_PROGRESS) {
        // Queue instead of dropping -- process after current scoring completes
        if (!SCORING_QUEUE.includes(message_index)) {
            SCORING_QUEUE.push(message_index);
            log(`Scoring in progress, queued message #${message_index} (queue size: ${SCORING_QUEUE.length})`);
        }
        return;
    }

    const state = get_chat_state();
    if (!state.traits || state.traits.length === 0) return;

    // Clear ceiling if model has changed since ceiling was set
    if (state.ceiling_traits?.length > 0 && state.ceiling_model) {
        const current_model = get_current_model_id();
        if (current_model !== state.ceiling_model && current_model !== 'unknown') {
            const cleared_labels = state.ceiling_traits.map(id =>
                state.traits.find(t => t.id === id)?.label || id);
            const old_model = state.ceiling_model;
            state.ceiling_traits = [];
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
    if (!message || message.is_user || message.is_system) return;

    // Skip greeting messages (card author's writing, not model output)
    if (is_greeting_message(message, message_index)) {
        log(`Skipping greeting message #${message_index} (card author content)`);
        return;
    }

    // Skip OOC messages (not character behavior)
    if (is_ooc_message(message.mes)) {
        log(`Skipping OOC message #${message_index}`);
        return;
    }

    // Check if this message should be scored
    if (!should_score_message()) return;

    SCORING_IN_PROGRESS = true;
    try {
        const char_desc = get_full_character_description();
        const scores = await score_response(message.mes, state.traits, char_desc, message_index);

        if (Object.keys(scores).length === 0) {
            warn('Scoring returned empty results, skipping this cycle');
            return;
        }

        store_scores(message, message_index, scores);
        state.messages_scored++;

        // Warn user about persistently unscored traits
        const consecutive_threshold = 3;
        for (const trait of state.traits) {
            const recent = state.score_history.slice(-consecutive_threshold);
            const all_missing = recent.length >= consecutive_threshold &&
                recent.every(entry => entry.scores[trait.id] === undefined);
            if (all_missing) {
                toastr.warning(
                    `"${trait.label}" has not been scored in the last ${consecutive_threshold} cycles. The scorer may not recognize this trait label.`,
                    MODULE_NAME_FANCY,
                    { preventDuplicates: true },
                );
            }
        }

        const drift = update_drift_state(state.traits, state.score_history);
        save_drift_state(drift);
        update_dashboard();
        update_message_badges();

        if (!get_settings('correction_enabled')) {
            save_chat_state(state);
            return;
        }

        // Filter out ceiling-reached traits
        const drifting = Object.entries(drift)
            .filter(([trait_id, d]) => d.correcting && !(state.ceiling_traits || []).includes(trait_id))
            .map(([trait_id, d]) => ({ trait_id, ...d }));

        if (drifting.length > 0) {
            // Check cooldown
            if (state.cooldown_remaining > 0) {
                state.cooldown_remaining--;
                save_chat_state(state);
                return;
            }

            const correction = state.active_correction;

            if (!correction?.enabled) {
                // === NEW DRIFT: Generate first correction ===
                const drifting_with_labels = drifting.map(d => ({
                    ...d,
                    label: state.traits.find(t => t.id === d.trait_id)?.label || d.trait_id,
                }));
                const text = await generate_correction(drifting_with_labels, state.traits, char_desc, chat, null, null);
                inject_correction(text);
                state.active_correction = {
                    enabled: true,
                    trait_ids: drifting.map(d => d.trait_id),
                    injection_text: text,
                    since_message: message_index,
                    attempt: 1,
                    scores_since_correction: 0,
                    score_at_correction: Math.min(...drifting.map(d => d.moving_avg || 0)),
                };
                state.corrections_injected++;
                state.ever_corrected_traits = [...new Set([...(state.ever_corrected_traits || []), ...drifting.map(d => d.trait_id)])];

                if (get_settings('show_toast_on_drift')) {
                    const trait_labels = drifting_with_labels.map(d => d.label);
                    const has_severe = drifting.some(d => d.severe);
                    if (has_severe) {
                        toastr.error(`Severe drift: ${trait_labels.join(', ')}`, MODULE_NAME_FANCY);
                    } else {
                        toastr.warning(`Drift detected: ${trait_labels.join(', ')}`, MODULE_NAME_FANCY);
                    }
                }

            } else {
                // === EXISTING CORRECTION: Check if working ===
                correction.scores_since_correction++;
                const patience = get_settings('correction_patience');
                const max_attempts = get_settings('correction_max_attempts');

                if (correction.scores_since_correction >= patience) {
                    // Only check improvement for the CORRECTED traits
                    // Use post-correction averages to avoid dilution from pre-correction low scores
                    const recovery_margin = get_settings('recovery_margin');
                    const recovery_threshold = get_settings('drift_threshold') + recovery_margin;
                    const post_avgs = compute_post_correction_averages(
                        correction.trait_ids, state.score_history, correction.since_message,
                    );
                    const corrected_drifting = correction.trait_ids
                        .map(trait_id => {
                            const effective_avg = post_avgs[trait_id] ?? drift[trait_id]?.moving_avg ?? null;
                            return { trait_id, ...(drift[trait_id] || {}), moving_avg: effective_avg };
                        })
                        .filter(d => d.moving_avg === null || d.moving_avg < recovery_threshold);

                    if (corrected_drifting.length === 0) {
                        // All corrected traits recovered above recovery threshold
                        clear_correction();
                        const still_drifting = drifting.filter(d => !correction.trait_ids.includes(d.trait_id));
                        if (still_drifting.length > 0) {
                            // Immediately start correction for remaining traits (no cooldown)
                            const labeled = still_drifting.map(d => ({
                                ...d, label: state.traits.find(t => t.id === d.trait_id)?.label || d.trait_id,
                            }));
                            const text = await generate_correction(labeled, state.traits, char_desc, chat, null, null);
                            inject_correction(text);
                            state.active_correction = {
                                enabled: true, trait_ids: still_drifting.map(d => d.trait_id),
                                injection_text: text, since_message: message_index, attempt: 1,
                                scores_since_correction: 0,
                                score_at_correction: Math.min(...still_drifting.map(d => d.moving_avg || 0)),
                            };
                            state.corrections_injected++;
                            state.ever_corrected_traits = [...new Set([...(state.ever_corrected_traits || []), ...still_drifting.map(d => d.trait_id)])];
                            toastr.success('Previous correction worked. New correction for remaining traits.', MODULE_NAME_FANCY);
                        } else {
                            state.active_correction = { enabled: false };
                            state.cooldown_remaining = get_settings('correction_cooldown');
                            toastr.success('Corrected traits stabilized', MODULE_NAME_FANCY);
                        }
                    } else {
                        const current_worst = Math.min(...corrected_drifting.map(d => d.moving_avg || 0));
                        const worsened = current_worst < correction.score_at_correction - 0.05;
                        const improved = current_worst > correction.score_at_correction + 0.02;

                        if (worsened && correction.attempt < max_attempts) {
                            // === FAST-PATH ESCALATE: Score actively declining ===
                            const escalation = {
                                previous_text: correction.injection_text,
                                score_at_correction: correction.score_at_correction,
                                score_after: current_worst,
                                attempt: correction.attempt,
                                patience: patience,
                            };
                            const drifting_labeled = drifting.map(d => ({
                                ...d,
                                label: state.traits.find(t => t.id === d.trait_id)?.label || d.trait_id,
                            }));
                            const text = await generate_correction(drifting_labeled, state.traits, char_desc, chat, null, escalation);
                            inject_correction(text);
                            correction.injection_text = text;
                            correction.attempt++;
                            correction.scores_since_correction = 0;
                            correction.score_at_correction = current_worst;
                            state.corrections_injected++;
                            toastr.warning(`Score worsening — correction regenerated (attempt ${correction.attempt})`, MODULE_NAME_FANCY);
                        } else if (improved) {
                            // Working -- reset counter, keep current correction
                            correction.scores_since_correction = 0;
                            correction.score_at_correction = current_worst;
                        } else if (correction.attempt < max_attempts) {
                            // === ESCALATE: Regenerate with escalation context ===
                            const escalation = {
                                previous_text: correction.injection_text,
                                score_at_correction: correction.score_at_correction,
                                score_after: current_worst,
                                attempt: correction.attempt,
                                patience: patience,
                            };
                            const drifting_labeled = drifting.map(d => ({
                                ...d,
                                label: state.traits.find(t => t.id === d.trait_id)?.label || d.trait_id,
                            }));
                            const text = await generate_correction(drifting_labeled, state.traits, char_desc, chat, null, escalation);
                            inject_correction(text);
                            correction.injection_text = text;
                            correction.attempt++;
                            correction.scores_since_correction = 0;
                            correction.score_at_correction = current_worst;
                            state.corrections_injected++;
                            toastr.warning(`Correction regenerated (attempt ${correction.attempt})`, MODULE_NAME_FANCY);
                        } else {
                            // === CEILING: Mark corrected traits as ceiling ===
                            const corrected_ids = correction.trait_ids;
                            state.ceiling_traits = [...new Set([...(state.ceiling_traits || []), ...corrected_ids])];
                            state.ceiling_model = get_current_model_id();
                            const corrected_labels = corrected_ids.map(id =>
                                state.traits.find(t => t.id === id)?.label || id);
                            toastr.error(
                                `${corrected_labels.join(', ')} may be at their ceiling for this model. Consider manual intervention.`,
                                MODULE_NAME_FANCY,
                                { timeOut: 0, extendedTimeOut: 0 },
                            );

                            // Check if any non-ceiling traits still need correction
                            const remaining = drifting.filter(d => !corrected_ids.includes(d.trait_id));
                            if (remaining.length === 0) {
                                clear_correction();
                                state.active_correction = { enabled: false };
                            } else {
                                // Restart correction cycle for remaining drifting traits
                                const remaining_with_labels = remaining.map(d => ({
                                    ...d,
                                    label: state.traits.find(t => t.id === d.trait_id)?.label || d.trait_id,
                                }));
                                const text = await generate_correction(remaining_with_labels, state.traits, char_desc, chat, null, null);
                                inject_correction(text);
                                state.active_correction = {
                                    enabled: true,
                                    trait_ids: remaining.map(d => d.trait_id),
                                    injection_text: text,
                                    since_message: message_index,
                                    attempt: 1,
                                    scores_since_correction: 0,
                                    score_at_correction: Math.min(...remaining.map(d => d.moving_avg || 0)),
                                };
                                state.corrections_injected++;
                                state.ever_corrected_traits = [...new Set([...(state.ever_corrected_traits || []), ...remaining.map(d => d.trait_id)])];
                            }
                        }
                    }
                }
            }
        } else if (state.active_correction?.enabled) {
            // All traits above drift threshold -- check if recovery is confirmed
            const recovery_margin = get_settings('recovery_margin');
            const recovery_threshold = get_settings('drift_threshold') + recovery_margin;
            const corrected_trait_ids = state.active_correction.trait_ids || [];

            // Check if all corrected traits are above the recovery threshold (with hysteresis)
            // Use post-correction averages to avoid dilution from pre-correction low scores
            const recovery_post_avgs = compute_post_correction_averages(
                corrected_trait_ids, state.score_history, state.active_correction.since_message,
            );
            const all_above_recovery = corrected_trait_ids.every(trait_id => {
                const effective_avg = recovery_post_avgs[trait_id] ?? drift[trait_id]?.moving_avg ?? null;
                return effective_avg !== null && effective_avg >= recovery_threshold;
            });

            if (all_above_recovery) {
                state.recovery_cycles = (state.recovery_cycles || 0) + 1;
                const needed = get_settings('recovery_patience');
                if (state.recovery_cycles >= needed) {
                    // Confirmed recovery -- remove correction, start cooldown
                    clear_correction();
                    state.active_correction = { enabled: false };
                    state.cooldown_remaining = get_settings('correction_cooldown');
                    state.recovery_cycles = 0;
                    toastr.success('Character traits stabilized', MODULE_NAME_FANCY);
                } else {
                    log(`Recovery cycle ${state.recovery_cycles}/${needed} -- waiting for confirmation`);
                }
            } else {
                // Not all traits above recovery threshold yet, reset counter
                state.recovery_cycles = 0;
            }
        }

        // Check if any ceiling traits have naturally recovered
        if (state.ceiling_traits?.length > 0) {
            const threshold = get_settings('drift_threshold');
            const recovered = state.ceiling_traits.filter(trait_id => {
                const d = drift[trait_id];
                return d && d.moving_avg !== null && d.moving_avg >= threshold;
            });
            if (recovered.length > 0) {
                state.ceiling_traits = state.ceiling_traits.filter(id => !recovered.includes(id));
                const recovered_labels = recovered.map(id =>
                    state.traits.find(t => t.id === id)?.label || id);
                toastr.info(`${recovered_labels.join(', ')} recovered above threshold. Auto-correction re-enabled.`, MODULE_NAME_FANCY);
            }
        }

        save_chat_state(state);
    } catch (err) {
        error('Scoring/correction error:', err);
        try { save_chat_state(state); } catch { /* ignore save errors in error handler */ }
        toastr.warning(`Analysis error: ${err.message}. Scoring skipped.`, MODULE_NAME_FANCY);
    } finally {
        SCORING_IN_PROGRESS = false;

        // Process queued messages
        if (SCORING_QUEUE.length > 0) {
            const next_index = SCORING_QUEUE.shift();
            log(`Processing queued message #${next_index} (${SCORING_QUEUE.length} remaining)`);
            // Use setTimeout to avoid deep recursion
            setTimeout(() => on_message_received(next_index), 100);
        }
    }
}

// ==================== POST-ROLEPLAY REPORT ====================

/**
 * Card Resilience Score (0-100):
 * Measures how well the character card maintains trait adherence without intervention.
 */
function compute_card_resilience(score_history, traits, corrections_count) {
    if (score_history.length === 0) return 0;
    const threshold = get_settings('drift_threshold');

    // Initial adherence: mean of first 3 scored messages across all traits
    const initial = mean(score_history.slice(0, 3).flatMap(s => Object.values(s.scores)));

    // Time-to-drift: for each trait, messages until first drop below threshold
    const total_scored = score_history.length;
    const drift_resistance = traits.map(t => {
        const first_drift = score_history.findIndex(s => (s.scores[t.id] || 1) < threshold);
        return first_drift === -1 ? 1.0 : first_drift / total_scored;
    });

    // Natural vs corrected: penalty if corrections were needed
    const correction_penalty = corrections_count > 0 ? 0.85 : 1.0;

    return Math.round(initial * 40 + mean(drift_resistance) * 50 + correction_penalty * 10);
}

/**
 * Session Quality Score (0-100):
 * Overall quality of the roleplay session in terms of character consistency.
 */
function compute_session_quality(score_history, traits, drift_state) {
    if (score_history.length === 0) return 0;

    const all_scores = score_history.flatMap(s => Object.values(s.scores));
    const overall_mean = mean(all_scores);

    // Consistency: inverse of variance
    const variance = compute_variance(all_scores);
    const consistency = Math.max(0, 1 - variance * 2);

    // Worst-trait penalty
    const avg_values = Object.values(drift_state).map(d => d.moving_avg ?? 0.5);
    const worst_trait_avg = avg_values.length > 0 ? Math.min(...avg_values) : 0.5;
    const floor_factor = Math.max(0.5, worst_trait_avg);

    return Math.round(overall_mean * 40 + consistency * 30 + floor_factor * 30);
}

/**
 * Model Compatibility Score (0-100):
 * How well the current model handles this character's personality traits.
 */
function compute_model_compatibility(traits, ceiling_traits, corrections_count, score_history, drift_state) {
    if (score_history.length === 0) return 0;

    const ceiling_ratio = traits.length > 0 ? 1 - (ceiling_traits.length / traits.length) : 1;

    const correction_load = Math.max(0, 1 - (corrections_count / (score_history.length * 0.5 || 1)));

    const avg_values = Object.values(drift_state).map(d => d.moving_avg ?? 0.5);
    const end_health = mean(avg_values);

    return Math.round(ceiling_ratio * 40 + correction_load * 30 + end_health * 30);
}

/**
 * Classify a trait's verdict based on session behavior.
 */
function compute_trait_verdict(trait, score_history, drift_state, ceiling_traits, ever_corrected_traits) {
    const threshold = get_settings('drift_threshold');

    if ((ceiling_traits || []).includes(trait.id)) {
        return 'ceiling';
    }

    const ever_drifted = score_history.some(s => (s.scores[trait.id] || 1) < threshold);

    if (!ever_drifted) {
        return 'natural_fit';
    }

    // Check if corrections were applied for THIS specific trait
    const was_corrected = (ever_corrected_traits || []).includes(trait.id);
    const d = drift_state[trait.id];
    if (d && d.moving_avg !== null && d.moving_avg >= threshold) {
        return was_corrected ? 'correctable' : 'maintainable';
    }

    // Trait drifted and hasn't recovered
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
    const card_resilience = compute_card_resilience(state.score_history, state.traits, state.corrections_injected);
    const session_quality = compute_session_quality(state.score_history, state.traits, state.drift_state);
    const model_compatibility = compute_model_compatibility(
        state.traits, state.ceiling_traits || [], state.corrections_injected,
        state.score_history, state.drift_state,
    );

    // Compute per-trait verdicts
    const trait_verdicts = {};
    const trait_curves = {};
    for (const trait of state.traits) {
        trait_verdicts[trait.id] = compute_trait_verdict(
            trait, state.score_history, state.drift_state,
            state.ceiling_traits || [], state.ever_corrected_traits || [],
        );
        trait_curves[trait.id] = state.score_history.map(s => s.scores[trait.id]).filter(s => s !== undefined);
    }

    // Generate LLM insights
    let insights = '';
    try {
        const trait_breakdown = state.traits.map(t => {
            const verdict = trait_verdicts[t.id];
            const curve = trait_curves[t.id];
            const avg = curve.length > 0 ? mean(curve).toFixed(2) : '?';
            return `- ${t.label}: verdict=${verdict}, mean_score=${avg}, curve=[${curve.map(s => s.toFixed(2)).join(', ')}]`;
        }).join('\n');

        const prompt = REPORT_INSIGHTS_PROMPT
            .replace(/\{\{char_name\}\}/g, char_name)
            .replace(/\{\{model_name\}\}/g, model_name)
            .replace('{{card_score}}', String(card_resilience))
            .replace('{{session_score}}', String(session_quality))
            .replace('{{model_score}}', String(model_compatibility))
            .replace('{{trait_breakdown}}', trait_breakdown)
            .replace('{{correction_history}}', `${state.corrections_injected} corrections applied`);

        const messages = [
            { role: 'system', content: 'You are a character roleplay analyst. Provide actionable insights.' },
            { role: 'user', content: prompt },
        ];

        insights = await analyze(messages, 800, false);
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
        trait_verdicts: trait_verdicts,
        trait_curves: trait_curves,
        corrections_count: state.corrections_injected,
        ceiling_traits: state.ceiling_traits || [],
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
        traits: state.traits.map(t => ({
            id: t.id,
            label: t.label,
            description: t.description,
            dimension: t.dimension,
            polarity: t.polarity,
            verdict: state.report.trait_verdicts[t.id],
            initial_score: state.score_history.length > 0 ? state.score_history[0].scores[t.id] : null,
            final_score: state.score_history.length > 0 ? state.score_history[state.score_history.length - 1].scores[t.id] : null,
            mean_score: mean((state.report.trait_curves[t.id] || [])),
            score_curve: state.report.trait_curves[t.id] || [],
        })),
        corrections_count: state.report.corrections_count,
        ceiling_traits: state.report.ceiling_traits,
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
        } else if (state.traits?.length > 0) {
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
 * Update the trait health bars in the Overview tab.
 */
function update_trait_bars() {
    const container = document.getElementById('dc_trait_health_container');
    if (!container) return;

    const state = get_chat_state();
    const traits = state.traits || [];
    const drift = state.drift_state || {};
    const threshold = get_settings('drift_threshold');

    if (traits.length === 0) {
        container.innerHTML = `
            <div class="dc_empty_state">
                <i class="fa-solid fa-user-slash"></i>
                <span>No character loaded. Open a chat to begin tracking.</span>
            </div>`;
        return;
    }

    const window_size = get_settings('drift_window');
    let html = '';

    for (const trait of traits) {
        const d = drift[trait.id] || { moving_avg: null, trend: 'no_data', correcting: false };
        const avg = d.moving_avg;
        const pct = avg !== null ? Math.round(avg * 100) : 0;
        const score_text = avg !== null ? avg.toFixed(2) : '--';

        // Color class
        let bar_class = 'dc_bar_green';
        if (avg !== null) {
            if (d.correcting) bar_class = 'dc_bar_correcting';
            else if (avg < threshold) bar_class = 'dc_bar_red';
            else if (avg < 0.6) bar_class = 'dc_bar_yellow';
        }

        // Trend text and class
        let trend_text = d.trend || 'no_data';
        let trend_class = 'dc_trend_no_data';
        if (d.correcting) {
            trend_text = 'CORRECTING';
            trend_class = 'dc_trend_correcting';
        } else if (d.trend === 'declining') {
            trend_class = 'dc_trend_declining';
        } else if (d.trend === 'improving') {
            trend_class = 'dc_trend_improving';
        } else if (d.trend === 'stable') {
            trend_class = 'dc_trend_stable';
        }

        // Sparkline (last 5 scores)
        const recent = (state.score_history || [])
            .slice(-window_size)
            .map(s => s.scores[trait.id])
            .filter(s => s !== undefined);

        let sparkline_html = '';
        for (const val of recent.slice(-5)) {
            let dot_class = 'dc_bar_green';
            if (val < threshold) dot_class = 'dc_bar_red';
            else if (val < 0.6) dot_class = 'dc_bar_yellow';
            sparkline_html += `<div class="dc_spark_dot" style="background: ${dot_class === 'dc_bar_green' ? '#4caf50' : dot_class === 'dc_bar_yellow' ? '#ffcc00' : '#f44336'}" title="${val.toFixed(2)}"></div>`;
        }

        html += `
            <div class="dc_trait_row">
                <span class="dc_trait_label" title="${escapeHtml(trait.description)}">${escapeHtml(trait.label)}</span>
                <div class="dc_trait_bar_container">
                    <div class="dc_trait_bar_fill ${bar_class}" style="width: ${pct}%"></div>
                    <div class="dc_trait_threshold_marker" style="left: ${threshold * 100}%"></div>
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

    const traits_el = document.getElementById('dc_correction_traits');
    if (traits_el) {
        const labels = (correction.trait_ids || []).map(id =>
            state.traits.find(t => t.id === id)?.label || id);
        traits_el.textContent = labels.join(', ') || '--';
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
 * Update the ceiling traits warning.
 */
function update_ceiling_warning() {
    const section = document.getElementById('dc_ceiling_section');
    if (!section) return;

    const state = get_chat_state();
    const ceiling = state.ceiling_traits || [];

    if (ceiling.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    const text_el = document.getElementById('dc_ceiling_text');
    if (text_el) {
        const labels = ceiling.map(id => state.traits.find(t => t.id === id)?.label || id);
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
        for (const [trait_id, score] of Object.entries(dg.scores)) {
            const trait = state.traits.find(t => t.id === trait_id);
            const label = trait?.label || trait_id;

            let badge_class = 'dc_badge_green';
            if (score < threshold) badge_class = 'dc_badge_red';
            else if (score < 0.6) badge_class = 'dc_badge_yellow';

            const corrected_class = dg.correction_active ? ' dc_badge_corrected' : '';

            const badge = document.createElement('span');
            badge.className = `dc_message_badge ${badge_class}${corrected_class}`;
            badge.textContent = `${label}: ${score.toFixed(2)}`;
            badge.title = `${label}: ${score.toFixed(2)}${dg.correction_active ? ' (correction active)' : ''}`;
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

    // Trait verdicts
    const verdicts_el = document.getElementById('dc_report_verdicts');
    if (verdicts_el) {
        let html = '';
        for (const trait of state.traits) {
            const verdict = report.trait_verdicts[trait.id] || 'unknown';
            const badge_class = `dc_verdict_${verdict}`;
            const display_verdict = verdict.replace(/_/g, ' ').toUpperCase();
            html += `
                <div class="dc_verdict_row">
                    <span>${escapeHtml(trait.label)}</span>
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
        const scores_text = entry.scores ? `[${entry.scores.join('/')}]` : '';
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
    const idx_a = parseInt(checkboxes[0].dataset.index);
    const idx_b = parseInt(checkboxes[1].dataset.index);

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
            clear_correction();
            clear_baseline();
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

    // Settings: text inputs
    $(document).on('input', '#dc_claude_model', debounce(function () {
        set_settings('claude_code_model', $(this).val().trim());
    }, 500));

    $(document).on('input', '#dc_openai_endpoint', debounce(function () {
        set_settings('openai_endpoint', $(this).val().trim());
    }, 500));

    $(document).on('input', '#dc_openai_api_key', debounce(function () {
        set_settings('openai_api_key', $(this).val().trim());
    }, 500));

    $(document).on('input', '#dc_openai_model', debounce(function () {
        set_settings('openai_model', $(this).val().trim());
    }, 500));

    // Settings: sliders
    const slider_settings = [
        { id: 'dc_score_frequency', key: 'score_frequency', display: 'dc_score_frequency_value', format: v => v },
        { id: 'dc_drift_window', key: 'drift_window', display: 'dc_drift_window_value', format: v => v },
        { id: 'dc_drift_threshold', key: 'drift_threshold', display: 'dc_drift_threshold_value', format: v => parseFloat(v).toFixed(2) },
        { id: 'dc_drift_alert_threshold', key: 'drift_alert_threshold', display: 'dc_drift_alert_threshold_value', format: v => parseFloat(v).toFixed(2) },
        { id: 'dc_correction_depth', key: 'correction_depth', display: 'dc_correction_depth_value', format: v => v },
        { id: 'dc_correction_max_traits', key: 'correction_max_traits', display: 'dc_correction_max_traits_value', format: v => v },
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
                if (state.traits?.length > 0 && state.score_history?.length > 0) {
                    const drift = update_drift_state(state.traits, state.score_history);
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

            toastr.info('Extracting traits...', MODULE_NAME_FANCY);
            const traits = await extract_traits(char_desc);
            if (traits.length > 0) {
                const state = get_chat_state();
                state.traits = traits;
                state.trait_extraction_hash = hash_description(char_desc);
                state.traits_manually_edited = false;
                CURRENT_TRAITS = traits;

                // Regenerate baseline Author's Note
                if (get_settings('baseline_enabled')) {
                    try {
                        const baseline = await generate_baseline(traits, char_desc);
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
                toastr.success(`Extracted ${traits.length} traits`, MODULE_NAME_FANCY);
            } else {
                toastr.error('Failed to extract traits.', MODULE_NAME_FANCY);
            }
        } catch (err) {
            toastr.error(`Trait extraction failed: ${err.message}`, MODULE_NAME_FANCY);
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
        state.ceiling_traits = [];
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
        'dc_correction_max_traits': { key: 'correction_max_traits', display: 'dc_correction_max_traits_value', format: v => v },
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
    // Chat changed: extract traits if needed, restore state
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        log('Chat changed, initializing...');

        const state = get_chat_state();
        const context = getContext();
        const char_desc = get_full_character_description();

        if (!char_desc) {
            CURRENT_TRAITS = [];
            CURRENT_DRIFT_STATE = {};
            update_dashboard();
            return;
        }

        const desc_hash = hash_description(char_desc);

        // Check if traits need extraction
        if (!state.traits || state.traits.length === 0 || (desc_hash !== state.trait_extraction_hash && !state.traits_manually_edited)) {
            if (EXTRACTION_IN_PROGRESS) {
                log('Extraction already in progress, restoring existing state');
            } else {
                EXTRACTION_IN_PROGRESS = true;
                const extraction_chat_id = context.chatId;
                try {
                    log('Extracting traits for character...');
                    const traits = await extract_traits(char_desc);
                    // Verify we're still on the same chat after async
                    if (getContext().chatId !== extraction_chat_id) {
                        log('Chat changed during extraction, discarding stale traits');
                        return;
                    }
                    if (traits.length > 0) {
                        state.traits = traits;
                        state.trait_extraction_hash = desc_hash;
                        save_chat_state(state);
                        log(`Traits extracted: ${traits.map(t => t.label).join(', ')}`);

                        // Generate baseline Author's Note alongside trait extraction
                        if (get_settings('baseline_enabled')) {
                            try {
                                const baseline = await generate_baseline(traits, char_desc);
                                if (baseline && getContext().chatId === extraction_chat_id) {
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
                    error('Trait extraction failed:', err);
                } finally {
                    EXTRACTION_IN_PROGRESS = false;
                }
            }
        }

        // Restore module state
        CURRENT_TRAITS = state.traits || [];
        CURRENT_DRIFT_STATE = state.drift_state || {};

        // Rebuild drift state from score history if needed
        if (CURRENT_TRAITS.length > 0 && state.score_history?.length > 0 && Object.keys(CURRENT_DRIFT_STATE).length === 0) {
            CURRENT_DRIFT_STATE = update_drift_state(CURRENT_TRAITS, state.score_history);
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

    // Message received: scoring pipeline
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        // Delay to avoid interfering with streaming
        setTimeout(() => on_message_received(id), 500);
    });

    // Message swiped: discard old score for the swiped message
    eventSource.on(event_types.MESSAGE_SWIPED, (data) => {
        const state = get_chat_state();
        if (!state.score_history?.length) return;

        const message_id = typeof data === 'number' ? data : data?.id;
        if (message_id === undefined) return;

        // Remove score for this message from history
        const before = state.score_history.length;
        state.score_history = state.score_history.filter(s => s.message_id !== message_id);
        if (state.score_history.length < before) {
            log(`Discarded score for swiped message #${message_id}`);
            // Recompute drift state
            if (CURRENT_TRAITS.length > 0) {
                CURRENT_DRIFT_STATE = update_drift_state(CURRENT_TRAITS, state.score_history);
                state.drift_state = CURRENT_DRIFT_STATE;
            }
            save_chat_state(state);
            update_dashboard();
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
        if (state.traits?.length > 0) {
            CURRENT_TRAITS = state.traits;
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
