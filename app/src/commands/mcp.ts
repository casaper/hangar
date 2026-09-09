import { serveMcp } from '../mcp/server.ts';
import type { Hangar } from '../hangar.ts';
import type { CommandUnknownOpts } from '@commander-js/extra-typings';

/**
 * `hangar mcp` -- serve this hangar's own command surface to a Claude Code session as tools.
 *
 * ## Who runs this
 *
 * Nobody, by hand. `.claude/modes/mcp.json` names it, `hangar claude` passes that file as
 * `--mcp-config`, and Claude Code starts one instance per mode session and speaks JSON-RPC to it
 * over stdin and stdout. Typing it at a prompt gets a process that waits for a protocol nobody is
 * speaking -- which is the right thing for it to do, and is also how the server is probed:
 * pipe it a few request lines and read the replies.
 *
 * ## Why it takes the program
 *
 * Every tool's schema is generated from the commander registry -- the descriptions, the
 * arguments, the `.choices()` -- so there is one place a flag is declared and the tool cannot
 * drift from the command. `cli.ts` cannot be imported to reach that registry, because its last
 * statement is `program.parseAsync()`; so the registry is handed IN, from the one place that
 * already has it.
 *
 * ## It is visible in `--help`, unlike `dev`
 *
 * `dev` is hidden because nothing about it is promised to an operator. This is the opposite: an
 * operator whose tools are missing needs to be able to find the command that serves them, and
 * `hangar mcp` on a terminal is the first thing to try when `/mcp` reports the server as failed.
 */
export const mcp = async (hangar: Hangar, program: CommandUnknownOpts): Promise<void> => {
  await serveMcp(hangar, program);
};
