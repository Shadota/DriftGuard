// SillyTavern Server Plugin -- DriftGuard Claude Code Bridge
// Wraps `claude -p` CLI as Express endpoints for character drift analysis.

const { spawn, execSync } = require('child_process');
const bodyParser = require('body-parser');

const PLUGIN_ID = 'driftguard';
const LOG_PREFIX = '[DriftGuard]';
const DEFAULT_TIMEOUT_MS = 120000;

// ==================== EXECUTABLE DISCOVERY ====================

let cached_executable = null;

/**
 * Find the claude CLI executable on the system.
 * Mirrors the discovery logic from Model-CharacterBias-Checker's claude_code_client.py.
 * @returns {string} Path to the claude executable
 * @throws {Error} If claude CLI is not found
 */
function find_claude_executable() {
    if (cached_executable) return cached_executable;

    const candidates = process.platform === 'win32'
        ? ['claude.exe', 'claude']
        : ['claude'];

    for (const candidate of candidates) {
        try {
            // Use `where` on Windows, `which` elsewhere
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const result = execSync(`${cmd} ${candidate}`, {
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (result) {
                // `where` on Windows can return multiple lines; take the first
                const first_line = result.split(/\r?\n/)[0].trim();
                cached_executable = first_line;
                console.log(`${LOG_PREFIX} Found claude CLI at: ${cached_executable}`);
                return cached_executable;
            }
        } catch {
            // Not found via this candidate, try next
        }
    }

    throw new Error(
        'Claude CLI not found. Install Claude Code (npm install -g @anthropic-ai/claude-code) ' +
        'and ensure `claude` is on your PATH.'
    );
}

// ==================== CLI SUBPROCESS ====================

/**
 * Spawn `claude -p` and capture output.
 * Ported from Model-CharacterBias-Checker's claude_code_client.py asyncio pattern
 * to Node.js child_process.
 *
 * @param {string} prompt - The prompt text to send via stdin
 * @param {string} system_prompt - System prompt (optional)
 * @param {string} model - Model name (sonnet, haiku, opus, or full model ID)
 * @param {number} timeout_ms - Runtime timeout in milliseconds
 * @returns {Promise<{content: string, cost_usd: number}>}
 */
async function run_claude_cli(prompt, system_prompt, model, timeout_ms = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const executable = find_claude_executable();

        const args = [
            '-p', '-',
            '--output-format', 'json',
            '--tools', '',
            '--no-session-persistence',
        ];
        if (model) args.push('--model', model);
        if (system_prompt) args.push('--system-prompt', system_prompt);

        const proc = spawn(executable, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let killed = false;
        let settled = false;

        // Helper to only resolve/reject once
        function settle_resolve(value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }
        function settle_reject(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        }

        // Explicit runtime timeout -- kill the process if it exceeds deadline.
        // Note: spawn()'s `timeout` option only applies to spawning, NOT to runtime.
        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
            // Force kill after 5s if SIGTERM doesn't work (Windows compatibility)
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            }, 5000);
            settle_reject(new Error(`claude process timed out after ${timeout_ms}ms`));
        }, timeout_ms);

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        // Send prompt via stdin (avoids shell argument length limits)
        proc.stdin.write(prompt);
        proc.stdin.end();

        proc.on('close', (code) => {
            if (killed) return; // Already rejected by timeout

            if (code !== 0) {
                return settle_reject(new Error(`claude exited with code ${code}: ${stderr.substring(0, 500)}`));
            }

            try {
                const outer = JSON.parse(stdout);
                const content = outer.result || outer.content || stdout;
                settle_resolve({ content, cost_usd: outer.cost_usd || 0 });
            } catch {
                // If JSON parse fails, return raw stdout
                settle_resolve({ content: stdout.trim(), cost_usd: 0 });
            }
        });

        proc.on('error', (err) => {
            if (!killed) {
                settle_reject(new Error(`Failed to spawn claude: ${err.message}`));
            }
        });
    });
}

// ==================== EXPRESS ROUTES ====================

/**
 * Initialize the plugin routes.
 * Called by SillyTavern's plugin loader with the Express router scoped to /api/plugins/driftguard/.
 * @param {import('express').Router} router
 */
async function init(router) {
    const jsonParser = bodyParser.json({ limit: '5mb' });

    // Health check -- verify claude CLI is available
    router.post('/probe', async (_req, res) => {
        try {
            find_claude_executable();
            return res.sendStatus(204);
        } catch (err) {
            console.error(`${LOG_PREFIX} Probe failed:`, err.message);
            return res.status(503).json({ error: err.message });
        }
    });

    // Analysis endpoint -- accepts messages array, runs through claude CLI
    router.post('/analyze', jsonParser, async (req, res) => {
        try {
            const { messages, model, max_tokens } = req.body;

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'messages array is required and must not be empty' });
            }

            // Convert messages array to prompt + system_prompt
            // Same structure as the OpenAI messages format
            let system_prompt = '';
            let prompt_parts = [];
            for (const msg of messages) {
                if (!msg || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
                    continue;
                }
                if (msg.role === 'system') {
                    system_prompt = msg.content;
                } else {
                    prompt_parts.push(msg.content);
                }
            }

            const prompt = prompt_parts.join('\n').trim();
            if (!prompt) {
                return res.status(400).json({ error: 'No user/assistant content found in messages' });
            }

            console.log(`${LOG_PREFIX} Analyzing with model=${model || 'default'}, prompt_length=${prompt.length}`);

            const result = await run_claude_cli(
                prompt,
                system_prompt || undefined,
                model || 'sonnet',
                max_tokens ? Math.max(DEFAULT_TIMEOUT_MS, max_tokens * 200) : DEFAULT_TIMEOUT_MS,
            );

            console.log(`${LOG_PREFIX} Analysis complete, cost=$${(result.cost_usd || 0).toFixed(4)}`);
            return res.json(result);
        } catch (err) {
            console.error(`${LOG_PREFIX} Analysis error:`, err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    console.log(`${LOG_PREFIX} Server plugin loaded -- routes registered at /api/plugins/${PLUGIN_ID}/`);
}

/**
 * Cleanup on plugin unload.
 */
async function exit() {
    cached_executable = null;
    console.log(`${LOG_PREFIX} Server plugin exited`);
}

const info = {
    id: PLUGIN_ID,
    name: 'DriftGuard',
    description: 'Claude Code CLI bridge for DriftGuard character drift analysis',
};

module.exports = { init, exit, info };
