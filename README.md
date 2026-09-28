# Replay Harness

**A great demo. Every single time.**

Replay a coding agent session in your terminal, offline and on cue. Press **Enter** or **Space** to type and send a recorded prompt. Watch the response stream in, complete with recorded tool calls and output. The player stops at the end of the turn until you advance it again.

Supports **Codex, Claude Code, Pi, OpenCode, and Gemini CLI**, plus generic chat JSON and editable replay scripts. Each harness has its own colors, heading, prompt, and tool markers.

## Start

Requires **Node.js 20+** and a terminal. No packages, API keys, agent installations, or internet connection are needed.

```sh
npm start
```

Startup discovers saved sessions from your local Codex, Claude Code, Pi, OpenCode, and Gemini CLI folders. Sessions are ordered by last modification time. Select one with Enter, then press Enter again to begin playback. The full transcript loads only when you open it.

Use **/** to search by title, project, model, or harness; **Tab** to filter by harness; and **r** to refresh discovery. **Esc** clears the search and filter. If no sessions are found, **o** opens a file path directly. Five authored examples are available through `--demo`.

```sh
# Go straight to a demo
node bin/replay-harness.js --demo pi
node bin/replay-harness.js --demo codex --speed 2

# Play your own session
node bin/replay-harness.js /path/to/session.jsonl

# Hide replay controls for a presentation
node bin/replay-harness.js /path/to/session.jsonl --present --speed 1.5

# Also discover recordings recursively in a custom folder
node bin/replay-harness.js --session-dir ./recordings
```

Optionally run `npm link` to make the `replay-harness` command available on your machine. Direct `node` invocation works without installation, from any working directory.

## Controls

| Key | Action |
| --- | --- |
| **Enter / Space** | Type and send the next prompt |
| **p** | Pause or resume the active turn |
| **+ / −** | Increase or decrease speed, from 0.1× to 20× |
| **n** | Reveal the rest of the current turn immediately |
| **[ / ]** | Cue the previous or next turn; press Enter to play it |
| **r** | Restart the recording |
| **↑ / ↓**, **PgUp / PgDn** | Scroll the transcript |
| **Home / End** | Jump to the start / follow the latest output |
| **x** | Expand or collapse tool output and recorded thoughts |
| **t** | Cycle visual identity |
| **f** | Toggle presentation mode |
| **? / h** | Show help; automatically pauses active playback |
| **Esc** | Close help or return to session discovery |
| **q / Ctrl+C** | Quit and restore your terminal |

In discovery, **↑ / ↓** selects a session and **PgUp / PgDn** moves through larger lists. **o** opens a local file path. Paste a path or drag a session file into that input. **Ctrl+U** clears the path or search query.

Enter and Space are ignored while a turn is running, including while paused. They never queue future prompts. The final turn stays on screen until you restart, navigate, or quit.

## Session discovery

The app checks these session locations automatically, including nested project and date folders:

| Harness | Discovery location |
| --- | --- |
| Codex | `~/.codex/sessions/` and `~/.codex/archived_sessions/` |
| Claude Code | `~/.claude/projects/` |
| Pi | `~/.pi/agent/sessions/` |
| Gemini CLI | `~/.gemini/tmp/**/chats/session-*.json` |
| OpenCode | `~/.local/share/opencode/opencode.db` and legacy `storage/session/` |

Discovery honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `XDG_DATA_HOME` overrides. `--session-dir` adds a custom folder. Only recognized session locations and explicit custom folders are scanned; subagent directories, symlinks, and unrelated harness files are skipped.

The picker shows the title or first prompt, harness, recency, project directory, and model when available. Preview reads are bounded to 256 KiB at the beginning and 16 KiB at the end of a file. Large sessions may show a filename until opened. Discovery caps traversal at 10,000 session files/directories and reports inaccessible or malformed sources without blocking other sessions.

**OpenCode SQLite discovery requires Node.js 22.13+** with the built-in `node:sqlite` module. Databases are opened read-only. Older Node versions can still discover legacy OpenCode files and import JSON exports. No harness process is started during discovery.

## Importing sessions

Pass the recording file directly; the format is detected from its content. Copy recordings onto your demo machine before going offline. The player never starts the original harness.

| Harness | Accepted input | Usual source |
| --- | --- | --- |
| Codex | Rollout JSONL with `session_meta`, `response_item`, and/or `event_msg` records | A rollout under `~/.codex/sessions/` |
| Claude Code | Transcript JSONL with `user` / `assistant` records and `message.content` | A transcript under `~/.claude/projects/` |
| Pi | Session JSONL, including v1 linear and v2/v3 tree entries | A session under `~/.pi/agent/sessions/` |
| OpenCode | JSON with `info` and `messages`, each containing `info` and `parts` | An OpenCode session JSON export |
| Gemini CLI | Chat JSON with `sessionId` and `messages` containing `user` / `gemini` entries | A saved chat under `~/.gemini/tmp/` |
| Generic | An array of `{ role, content }` messages, or `{ messages: [...] }` | Your own chat export |
| Replay script | Version 1 JSON with `harness` and `turns` | An editable script, as shown below |

Local storage locations can differ when a harness is configured with a custom home directory. Use the saved transcript JSON/JSONL, rather than a plain-text or HTML export.

### Import behavior

- Codex's duplicated UI events and response messages are normalized into one conversation. Tool calls and their outputs stay in the same turn.
- Claude tool results carried in `user` records are treated as output, not new prompts. Sidechain subagent records and duplicate UUIDs are omitted.
- Pi follows the final stored entry's parent chain. Abandoned branches are excluded; old linear sessions are also accepted.
- OpenCode tool states and Gemini tool calls become display events. Generic chat imports support OpenAI-style `tool_calls` and `tool` messages.
- System/developer messages are omitted. Recorded thought summaries may be displayed; missing thoughts are never generated. Images appear as placeholders.
- Imports are read-only. Discovery scans known session folders and any extra folder you supply. The maximum full transcript input size is 64 MiB.

Check a recording before presenting:

```sh
node bin/replay-harness.js /path/to/session.jsonl --inspect
node bin/replay-harness.js --session-dir ./recordings --list
```

`--inspect` reports the detected harness, title, model, turn/event counts, and import warnings without starting the TUI. A malformed JSONL line fails with its line number.

Format references: [Codex protocol](https://github.com/openai/codex/tree/main/codex-rs/protocol), [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Pi session manager](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts), [OpenCode export](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/export.ts), [Gemini chat recording](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts).

## Timing and presentation

```sh
node bin/replay-harness.js session.jsonl \
  --speed 1.5 \
  --typing-speed 60 \
  --timing natural \
  --theme pi \
  --present
```

- **`--speed`** scales prompt typing, output streaming, and waits together. Change it during playback with +/−.
- **`--typing-speed`** sets the nominal prompt typing pace at 1× (default 24 graphemes per second, before pauses). Keystrokes vary in short bursts, with brief hesitations between words and longer pauses at punctuation and newlines. The completed prompt stays in the composer for a moment before it is sent. Each prompt has a repeatable rhythm, so rehearsals and restarts keep the same timing.
- **`--timing natural`** uses short staged waits and streams recorded text at a demo-friendly pace. It does not use the original session's long pauses.
- **`--timing recorded`** uses timestamp gaps between agent events, capped at five seconds before the speed multiplier, plus the text reveal time. It approximates the original rhythm; it is not a frame-accurate terminal capture.
- **`--present`** hides replay controls, progress, and queued-prompt hints. The same keyboard controls still work. Press f to bring them back.
- **`--theme`** selects `codex`, `claude`, `pi`, `opencode`, `gemini`, or `generic`. The default comes from the recording.

Use a true-color terminal, a dark background, and a monospace font with Unicode support. The layout adapts down to 48 columns × 16 rows; 100 × 32 or larger gives tool output more room.

## Write an editable demo

Save this as `demo.json` and pass it to the player:

```json
{
  "version": 1,
  "harness": "pi",
  "title": "My offline demo",
  "model": "My recorded model",
  "cwd": "~/projects/demo",
  "turns": [
    {
      "prompt": "Run the tests and summarize the result.",
      "events": [
        {
          "type": "assistant",
          "text": "I’ll run the test suite."
        },
        {
          "type": "tool",
          "name": "bash",
          "id": "test-1",
          "text": "npm test",
          "durationMs": 1000
        },
        {
          "type": "result",
          "id": "test-1",
          "text": "12 tests passed",
          "delayMs": 300
        },
        {
          "type": "assistant",
          "text": "All **12 tests** pass."
        }
      ]
    }
  ]
}
```

Events can be `assistant`, `thinking`, `tool`, or `result`. Every event needs a string `text`. Use matching `id` values to link tools to results, `name` for the displayed tool name, and `error: true` on a failed result. Optional `delayMs` and `durationMs` override generated timing; both are scaled by the playback speed. An optional `at` timestamp is used in recorded timing mode.

Each turn has exactly one nonempty `prompt` and an `events` array. Add another turn to create the next presenter cue. Nothing inside a script is executed.

## How it works

```text
Session JSON / JSONL
        │
        ▼
Format adapter → prompts + display events
        │
        ▼
Virtual playback clock → typing → output → wait for your cue
        │
        ▼
Harness theme + terminal renderer
```

The runtime uses Node's filesystem, readline, terminal output, and optional SQLite APIs. It contains no agent integration, shell execution, network client, or recording write path. Terminal escape sequences in imported content are stripped before display.

The visual identities are recognizable approximations, not exact replicas of every harness version. Session formats evolve; unsupported event kinds and metadata are omitted. This release does not reproduce interactive approval dialogs, image rendering, or every extension/subagent UI. Bundled conversations are authored demo scripts; their tool results are example content.

## Development

```sh
npm test
npm run check
```

Tests cover session discovery, search/filter/refresh, configured storage roots, SQLite and legacy OpenCode storage, lazy loading, native import formats, Pi branch selection, tool/result grouping, turn gating, pause/resume, speed changes, Unicode, responsive layouts, keyboard controls, CLI errors, and read-only behavior.

```text
bin/replay-harness.js   CLI entry point
src/session.js         Format detection, import adapters, validation
src/discovery.js       Local discovery, previews, search, OpenCode storage
src/playback.js        Deterministic playback state machine
src/typing.js          Repeatable keystroke timing and natural pauses
src/app.js             Keyboard controls and terminal lifecycle
src/render.js          Discovery, transcript, composer, and help views
src/themes.js          Harness palettes and markers
src/text.js            Text sanitization, graphemes, terminal cell widths
examples/              Five offline demo recordings
test/                  Built-in Node test suite
```

MIT licensed.
