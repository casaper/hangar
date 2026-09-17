import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyServers,
  columnsFor,
  killPlan,
  programName,
  layoutRows,
  paintRows,
  serverCells,
  serversSummary,
  shortCommand,
  startCommandLine,
  startPlan,
  TROUBLE,
  type ClonePidFile,
  type ServerRecord,
} from '../src/commands/servers.ts';
import { cloneAt } from '../src/fleet.ts';
import { visibleWidth } from '../src/ui.ts';
import type { Listener, ProcessRow } from '../src/procs.ts';

import { fixtureVscodeConfigText, syntheticHangar } from './fixture.ts';

/*
 * The classifier, against input no machine here can produce.
 *
 * `crossed` needs a clone whose direnv never loaded, `recycled` needs the kernel to reissue a pid
 * number, and `stale` needs a wrapper killed with a signal it cannot handle. Those are the three
 * states worth the most and the three a golden capture can never reach, which is the whole reason
 * the classification is a pure function taking four facts rather than a scan that goes and looks.
 */

const hangar = syntheticHangar();
const one = cloneAt(hangar, 1);
const two = cloneAt(hangar, 2);

/** `api` is the first role in `dev/fixture.config.yaml`: base 3000, offset 37, step 100. */
const portOf = (clone: typeof one, role: string): number => {
  const entry = clone.ports.find((p) => p.role.id === role);
  if (entry === undefined) throw new Error(`the fixture has no ${role} role`);
  return entry.port;
};

const proc = (pid: number, ppid: number, command: string): [number, ProcessRow] => [
  pid,
  { pid, ppid, command },
];

const classify = (opts: {
  listeners?: Listener[];
  pidFiles?: ClonePidFile[];
  cwds?: [number, string][];
  processes?: [number, ProcessRow][];
}): ServerRecord[] =>
  classifyServers(
    [one, two],
    opts.listeners ?? [],
    opts.pidFiles ?? [],
    new Map(opts.cwds ?? []),
    new Map(opts.processes ?? []),
  );

const pidFile = (clone: typeof one, name: string, pid: number, alive: boolean): ClonePidFile => ({
  clone,
  file: { name, pid, path: `${clone.path}/tmp/${name}.pid`, alive },
});

test('a server on a sibling clone port is crossed, and names the clone whose port it took', () => {
  // The failure the whole classification exists for: every clone falls back to the same base
  // port, so a clone whose environment did not load serves on clone 1's port -- and a port-only
  // scan cannot see it, because the port is right and it is the CLONE that is wrong.
  const [record] = classify({
    listeners: [{ pid: 900, port: portOf(one, 'api') }],
    cwds: [[900, `${two.path}/app`]],
  });
  assert.equal(record?.state, 'crossed');
  assert.equal(record.clone.index, two.index, 'filed under the clone the process is IN');
  assert.equal(record.tookPortOf?.index, one.index, 'and names the clone that was assigned it');
  assert.equal(record.port, portOf(one, 'api'));
});

test('a listener on an assigned port that no pid file names is untracked', () => {
  const [record] = classify({
    listeners: [{ pid: 901, port: portOf(one, 'api') }],
    cwds: [[901, one.path]],
  });
  assert.equal(record?.state, 'untracked');
  assert.equal(record.clone.index, one.index);
  assert.equal(record.name, 'api', 'named for the role whose port it took');
});

test('a listener inside a clone on a port no clone was assigned is a stray, named for itself', () => {
  const [record] = classify({
    listeners: [{ pid: 902, port: 49721 }],
    cwds: [[902, `${one.path}/app`]],
    processes: [
      proc(902, 903, '/opt/node/bin/node test-server.js --host 127.0.0.1'),
      proc(903, 1, '/Applications/Some Editor.app/Contents/MacOS/Helper --type=utility'),
    ],
  });
  assert.equal(record?.state, 'stray');
  assert.equal(record.clone.index, one.index);
  assert.equal(record.parent, '/Applications/Some Editor.app/Contents/MacOS/Helper --type=utility');
  assert.notEqual(record.name, 'stray', 'the state column already says that');
});

test('a listener that is in no clone and on no assigned port is not this fleet’s business', () => {
  assert.deepEqual(classify({ listeners: [{ pid: 904, port: 49722 }], cwds: [[904, '/opt']] }), []);
});

test('a pid file whose process is gone is stale, and carries the file to remove', () => {
  const [record] = classify({ pidFiles: [pidFile(one, 'api_server', 905, false)] });
  assert.equal(record?.state, 'stale');
  assert.equal(record.pidFile, `${one.path}/tmp/api_server.pid`);
  assert.equal(record.port, undefined);
});

test('a pid file whose pid is alive but belongs elsewhere is recycled, never a kill target', () => {
  const [record] = classify({
    pidFiles: [pidFile(one, 'api_server', 906, true)],
    cwds: [[906, '/opt/somebody-else']],
  });
  assert.equal(record?.state, 'recycled');
});

test('an UNKNOWN working directory is not recycled -- absence is not evidence of elsewhere', () => {
  /*
   * `cwdsOf` returns nothing for a pid it could not read. Treating that as "somewhere else" turns
   * one unlucky lsof into "this server cannot be killed, prune it instead", which is the guard
   * failing in the direction that costs the developer the kill they asked for.
   */
  const [record] = classify({ pidFiles: [pidFile(one, 'api_server', 907, true)] });
  assert.notEqual(record?.state, 'recycled');
  assert.equal(record?.cwd, undefined);
});

test('a recorded, live process listening on nothing is silent rather than serving', () => {
  const [record] = classify({
    pidFiles: [pidFile(one, 'api_server', 908, true)],
    cwds: [[908, one.path]],
  });
  assert.equal(record?.state, 'silent');
});

test('a pid file and a listener on that clone’s own port is one record, serving', () => {
  const records = classify({
    pidFiles: [pidFile(one, 'api_server', 909, true)],
    listeners: [{ pid: 909, port: portOf(one, 'api') }],
    cwds: [[909, one.path]],
  });
  assert.equal(records.length, 1, 'the two facts describe one server, not two');
  assert.equal(records[0]?.state, 'serving');
  assert.equal(
    records[0].name,
    'api_server',
    'the pid file names it, because that is what stops it',
  );
});

test('records come back ordered by clone, then by how much they want a human', () => {
  const records = classify({
    pidFiles: [pidFile(two, 'api_server', 910, true), pidFile(one, 'old', 911, false)],
    listeners: [
      { pid: 910, port: portOf(two, 'api') },
      { pid: 912, port: portOf(one, 'api') },
    ],
    cwds: [
      [910, two.path],
      [912, one.path],
    ],
  });
  assert.deepEqual(
    records.map((r) => [r.clone.index, r.state]),
    [
      [one.index, 'untracked'],
      [one.index, 'stale'],
      [two.index, 'serving'],
    ],
  );
});

test('every trouble state is one the report can reach', () => {
  // A state in TROUBLE that the classifier never produces would make `--stale` quietly narrower
  // than it reads.
  const produced = new Set([
    ...classify({
      listeners: [{ pid: 920, port: portOf(one, 'api') }],
      cwds: [[920, one.path]],
    }).map((r) => r.state),
    ...classify({ listeners: [{ pid: 921, port: 49999 }], cwds: [[921, one.path]] }).map(
      (r) => r.state,
    ),
    ...classify({
      listeners: [{ pid: 922, port: portOf(one, 'api') }],
      cwds: [[922, two.path]],
    }).map((r) => r.state),
    ...classify({ pidFiles: [pidFile(one, 'gone', 923, false)] }).map((r) => r.state),
  ]);
  for (const state of TROUBLE) assert.ok(produced.has(state), `${state} is never produced`);
});

test('a scan that could not be taken reports no clone as idle', () => {
  const lines = serversSummary([], false);
  assert.ok(lines.some((l) => l.includes('lsof')));
  assert.ok(
    !lines.some((l) => /nothing is serving/i.test(l)),
    'an empty list from a scan that failed is not an answer about the fleet',
  );
  assert.ok(serversSummary([], true).some((l) => /nothing is serving/i.test(l)));
});

test('a program is named without its path or its flags, even when the path has spaces', () => {
  assert.equal(
    programName('/Applications/Some Editor.app/Contents/MacOS/Code Helper (Plugin) --type=utility'),
    'Code Helper (Plugin)',
  );
  assert.equal(programName('ng serve --port 4300'), 'ng serve');
  assert.equal(programName('/usr/bin/node'), 'node');
});

test('a command keeps its arguments and loses only the interpreter path', () => {
  assert.equal(
    shortCommand('/opt/toolchain/state/fnm/bin/node app/cli.js serve --host 127.0.0.1'),
    'node app/cli.js serve --host 127.0.0.1',
  );
  assert.equal(shortCommand('ng serve --port 4300'), 'ng serve --port 4300');
});

/* ------------------------------------------------------- stopping the right thing */

const plannedFor = (records: ServerRecord[], opts: Parameters<typeof killPlan>[3] = {}) =>
  killPlan(records, hangar.root, new Set<number>(), opts);

const listening = (clone: typeof one, pid: number, port: number, cwd?: string): ServerRecord[] =>
  classify({
    pidFiles: [pidFile(clone, 'api_server', pid, true)],
    listeners: [{ pid, port }],
    cwds: [[pid, cwd ?? clone.path]],
  });

test('a server inside the hangar is stopped; one outside it never is', () => {
  assert.equal(plannedFor(listening(one, 930, portOf(one, 'api'))).kill.length, 1);

  // Containment. `hangar.root` is the fixture's `/wt`, so a cwd elsewhere is another developer's
  // process that happens to hold a port -- a pid is a number the system reuses.
  const outside = classify({
    listeners: [{ pid: 931, port: portOf(one, 'api') }],
    cwds: [[931, '/opt/unrelated']],
  });
  const plan = plannedFor([...outside]);
  assert.equal(plan.kill.length, 0);
  assert.match(plan.refused[0]?.why ?? '', /outside this hangar/);
});

test('an unreadable working directory refuses the kill rather than risking it', () => {
  // The opposite direction to the classifier's rule, and deliberately so: there, absence must not
  // condemn a server to `recycled`; here, absence must not license a signal.
  const records = classify({
    pidFiles: [pidFile(one, 'api_server', 932, true)],
    listeners: [{ pid: 932, port: portOf(one, 'api') }],
  });
  const plan = plannedFor(records);
  assert.equal(plan.kill.length, 0);
  assert.match(plan.refused[0]?.why ?? '', /where pid 932 is running/);
});

test('a recycled pid is never signalled, and its file is offered to prune instead', () => {
  const records = classify({
    pidFiles: [pidFile(one, 'api_server', 933, true)],
    cwds: [[933, '/opt/somebody-else']],
  });
  const plan = plannedFor(records);
  assert.equal(plan.kill.length, 0);
  assert.equal(plan.prunable.length, 1);
  assert.match(plan.refused[0]?.why ?? '', /number was reused/);
});

test('a stray survives a bulk stop and dies only when its pid is named', () => {
  const records = classify({
    listeners: [{ pid: 934, port: 49733 }],
    cwds: [[934, one.path]],
    processes: [
      proc(934, 935, '/opt/node/bin/node test-server.js'),
      proc(935, 1, '/Applications/Some Editor.app/Contents/MacOS/Helper --type=utility'),
    ],
  });
  assert.equal(plannedFor(records).kill.length, 0, 'not swept up by a bulk stop');
  assert.match(plannedFor(records).refused[0]?.why ?? '', /--pid 934/);
  assert.equal(plannedFor(records, { pid: ['934'] }).kill.length, 1, 'stopped when asked for');
});

test('a Claude Code session is never a server, whatever holds the port', () => {
  const records = listening(one, 936, portOf(one, 'api'));
  const plan = killPlan(records, hangar.root, new Set([936]), {});
  assert.equal(plan.kill.length, 0);
  assert.match(plan.refused[0]?.why ?? '', /Claude Code session/);
});

test('a stale pid file is prunable and is never something to signal', () => {
  const plan = plannedFor(classify({ pidFiles: [pidFile(one, 'gone', 937, false)] }));
  assert.deepEqual(plan.kill, []);
  assert.equal(plan.prunable.length, 1);
  assert.equal(plan.refused.length, 0, 'a file to tidy is not a refusal');
});

test('--role and --pid select, and selecting nothing stops nothing', () => {
  const records = [
    ...listening(one, 938, portOf(one, 'api')),
    ...classify({
      pidFiles: [pidFile(two, 'db_server', 939, true)],
      listeners: [{ pid: 939, port: portOf(two, 'db') }],
      cwds: [[939, two.path]],
    }),
  ];
  assert.deepEqual(
    plannedFor(records, { name: ['db_server'] }).kill.map((r) => r.pid),
    [939],
  );
  assert.deepEqual(
    plannedFor(records, { pid: ['938'] }).kill.map((r) => r.pid),
    [938],
  );
  assert.equal(plannedFor(records, { name: ['nothing-by-that-name'] }).kill.length, 0);
});

test('--role matches the PORT role, and --name the pid file stem, on one tracked server', () => {
  /*
   * They are different words for the same server -- `api_server` recorded on the `api` role --
   * and matching both against the pid file's stem made `--role` select nothing for every
   * correctly tracked server. Silently, because selecting nothing is also what a clone with no
   * such server looks like.
   */
  const records = listening(one, 940, portOf(one, 'api'));
  assert.equal(records[0]?.name, 'api_server');
  assert.equal(records[0].role, 'api');
  assert.deepEqual(
    plannedFor(records, { role: ['api'] }).kill.map((r) => r.pid),
    [940],
  );
  assert.deepEqual(
    plannedFor(records, { name: ['api_server'] }).kill.map((r) => r.pid),
    [940],
  );
  assert.equal(
    plannedFor(records, { role: ['api_server'] }).kill.length,
    0,
    'a stem is not a role',
  );
});

test('a record with no port is not reachable by --role', () => {
  const silent = classify({
    pidFiles: [pidFile(one, 'api_server', 941, true)],
    cwds: [[941, one.path]],
  });
  assert.equal(silent[0]?.state, 'silent');
  assert.equal(silent[0].role, undefined);
  assert.equal(plannedFor(silent, { role: ['api'] }).kill.length, 0);
});

/* --------------------------------------------------------------- starting one */

test('the start line fixes the port in front of the command', () => {
  /*
   * The reason this command is safer than typing the same thing by hand. Every clone's fallback
   * when the port variable is missing is the SAME base, so a clone whose environment did not load
   * serves on clone 1's port -- the `crossed` state above, reached by accident. A shell assignment
   * prefix wins over an exported value, so this is right whether or not direnv ran.
   */
  assert.equal(startCommandLine('NG_PORT', 4300, 'npm run start'), 'NG_PORT=4300 npm run start');
});

test('a role with a start command is planned, in the clone’s own directory', () => {
  // `api` is the fixture's only role with a `start`, and it declares no `dir`.
  const plan = startPlan([one], [], () => [], undefined);
  assert.equal(plan.start.length, 1);
  assert.equal(plan.start[0]?.role, 'api');
  assert.equal(plan.start[0].cwd, one.path, 'no dir means the clone root');
  assert.equal(plan.start[0].command, `FIXTURE_API_PORT=${String(portOf(one, 'api'))} make serve`);
});

test('a start dir is resolved under the clone, not under the hangar', () => {
  const vscode = syntheticHangar({ configText: fixtureVscodeConfigText() });
  const clone = cloneAt(vscode, 2);
  const plan = startPlan([clone], [], () => [], undefined);
  const web = plan.start.find((a) => a.role === 'web');
  assert.equal(web?.cwd, `${clone.path}/apps/web`);
  assert.ok(web.command.startsWith('VSFIX_WEB_PORT='), 'the role’s own env key, not another');
});

test('a role already serving is skipped rather than started twice', () => {
  const serving = listening(one, 950, portOf(one, 'api'));
  const plan = startPlan([one], serving, () => [], undefined);
  assert.equal(plan.start.length, 0);
  assert.match(plan.skip[0]?.why ?? '', /already serving/);
});

test('a role whose window already exists is left alone', () => {
  const plan = startPlan([one], [], () => ['api'], undefined);
  assert.equal(plan.start.length, 0);
  assert.match(plan.skip[0]?.why ?? '', /already has a window/);
});

test('a role asked for by name that declares no start command says so', () => {
  const plan = startPlan([one], [], () => [], ['db']);
  assert.equal(plan.start.length, 0);
  assert.match(plan.skip[0]?.why ?? '', /no `start` command/);
  // ...and the same role is silently passed over when nothing asked for it by name.
  assert.equal(startPlan([one], [], () => [], undefined).skip.length, 0);
});
/* ------------------------------------------------------------------ the report */

/**
 * Exactly what `table()` in `src/ui.ts` prints for these rows, `trimEnd` included.
 *
 * Asserting against a line this does not build would be asserting against a line the command
 * never shows -- which passes, or fails, for a reason unconnected to the output.
 */
const render = (rows: readonly string[][], gap = 2): string[] => {
  const columns = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );
  return rows.map((row) =>
    row
      .map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleWidth(cell))))
      .join(' '.repeat(gap))
      .trimEnd(),
  );
};

const longCommand = 'node '.concat('a/very/long/path/segment/'.repeat(20), 'server.js --watch');

const withCommand = (records: ServerRecord[], command: string): ServerRecord[] =>
  records.map((r) => ({ ...r, command }));

const lay = (records: ServerRecord[], width: number | undefined, extras = false) => {
  const columns = columnsFor(extras);
  return {
    columns,
    records,
    rows: layoutRows(
      serverCells(columns, records),
      columns.map((c) => c.align),
      width,
    ),
  };
};

test('the columns are the agreed order, and the role is left out unless asked for', () => {
  assert.deepEqual(
    columnsFor(false).map((c) => c.heading),
    ['CLONE', 'NAME', 'STATE', 'PORT', 'URL', 'PID', 'COMMAND'],
  );
  assert.deepEqual(
    columnsFor(true).map((c) => c.heading),
    ['CLONE', 'NAME', 'STATE', 'PORT', 'URL', 'PID', 'ROLE', 'COMMAND'],
  );
  // The clipped column has to be the last one, or a clip leaves a hole mid-row.
  for (const extras of [false, true]) {
    assert.equal(columnsFor(extras).at(-1)?.heading, 'COMMAND');
  }
});

test('each column sits the way it was asked to sit in its width', () => {
  const records = listening(one, 970, portOf(one, 'api'));
  const { rows } = lay(records, undefined, true);
  const [heading, row] = rows;
  const at = (name: string): string =>
    row?.[columnsFor(true).findIndex((c) => c.heading === name)] ?? '';

  // `CLONE` is five wide and the index is one character, so centring leaves two spaces a side.
  assert.equal(at('CLONE'), '  1  ');
  assert.equal(heading?.[0], 'CLONE');
  // Right-aligned: the value finishes at the column's right edge, whatever the slack is.
  assert.ok(
    at('PORT').endsWith(String(portOf(one, 'api'))),
    `PORT not right-aligned: "${at('PORT')}"`,
  );
  assert.ok(at('PID').endsWith('970'), `PID not right-aligned: "${at('PID')}"`);
  // Left-aligned: the value starts at the column's left edge. `NAME` is four characters wide as a
  // heading and `api_server` is ten, so the slack here is on the heading rather than the value.
  assert.ok(at('NAME').startsWith('api_server'), `NAME not left-aligned: "${at('NAME')}"`);
  assert.ok(at('URL').startsWith('http://'), `URL not left-aligned: "${at('URL')}"`);
  // Centred, with an odd slack going left-light: `ROLE` is four wide and `api` is three.
  assert.equal(at('ROLE'), 'api ');
});

test('every cell of a column comes out the same width, heading included', () => {
  const records = [
    ...listening(one, 971, portOf(one, 'api')),
    ...listening(two, 972, portOf(two, 'api')),
  ];
  const { rows } = lay(records, undefined, true);
  const widths = rows[0]?.map((cell) => cell.length) ?? [];
  for (const row of rows) {
    assert.deepEqual(
      row.map((cell) => cell.length),
      widths,
    );
  }
});

test('no rendered line runs past the window, and painting never changes a width', () => {
  const records = withCommand(listening(one, 973, portOf(one, 'api')), longCommand);
  // The floor below which no clipping can help is the other columns' own rendered width.
  const floor = Math.max(...render(lay(records, 1).rows).map(visibleWidth));
  for (const width of [400, 200, 120, 100, floor + 1, floor]) {
    const { rows, columns } = lay(records, width);
    const painted = paintRows(rows, columns, records);
    // Painting is applied to the PADDED cell, so it may add bytes but never columns.
    assert.deepEqual(
      painted.map((row) => row.map(visibleWidth)),
      rows.map((row) => row.map((cell) => cell.length)),
    );
    for (const line of render(painted)) {
      assert.ok(
        visibleWidth(line) <= width,
        `a line of ${String(visibleWidth(line))} in a window of ${String(width)}: ${line}`,
      );
    }
  }
  assert.ok(
    Math.max(...render(lay(records, undefined).rows).map(visibleWidth)) > 400,
    'the unclipped rows really are too long for any of those windows',
  );
});

test('the heading is clipped with everything else', () => {
  const records = withCommand(listening(one, 974, portOf(one, 'api')), longCommand);
  assert.equal(lay(records, 400).rows[0]?.at(-1)?.trim(), 'COMMAND');
  const narrow = lay(records, 60).rows[0]?.at(-1) ?? '';
  assert.ok(narrow.trim().length < 'COMMAND'.length, `the heading was not clipped: ${narrow}`);
});

test('a budget below one empties the last column rather than all but emptying it', () => {
  /*
   * `truncate(cell, 0)` is `cell.slice(0, -1)` -- the whole string but its last character -- so
   * the narrowest window would otherwise produce the WIDEST output this can produce.
   */
  const records = withCommand(listening(one, 975, portOf(one, 'api')), longCommand);
  const { rows } = lay(records, 20);
  for (const row of rows) assert.equal(row.at(-1), '');
  for (const line of render(rows)) assert.ok(!line.includes('server.js'));
});

test('with no window there is nothing to fit, and nothing is clipped', () => {
  const records = withCommand(listening(one, 976, portOf(one, 'api')), longCommand);
  assert.equal(lay(records, undefined).rows[1]?.at(-1)?.trim(), longCommand);
});

test('the clone badge is the hue BEHIND the whole padded cell', () => {
  // A block of colour the width of the column, not a smear around one digit -- which is why the
  // paint is applied after the padding rather than to the value.
  const records = listening(one, 977, portOf(one, 'api'));
  const { rows, columns } = lay(records, undefined);
  const cell = paintRows(rows, columns, records)[1]?.[0] ?? '';
  assert.ok(cell.includes('48;2;'), 'the hue is a background');
  assert.equal(visibleWidth(cell), rows[1]?.[0]?.length, 'and it changes no width');
  const plain = cell.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  assert.equal(plain, '  1  ', 'the padding is inside the colour, not outside it');
});

test('a serving record carries the URL its role renders, with that clone\u2019s own port', () => {
  const [record] = listening(two, 978, portOf(two, 'api'));
  assert.equal(record?.url, `http://localhost:${String(portOf(two, 'api'))}`);
});

test('a role declaring no URL gives a record with none', () => {
  // The fixture's `db` role is `url: null` -- a database port, which a URL does not describe.
  const [record] = classify({
    listeners: [{ pid: 979, port: portOf(one, 'db') }],
    cwds: [[979, one.path]],
  });
  assert.equal(record?.role, 'db');
  assert.equal(record.url, undefined, 'asserted on the record, never on how an absent cell paints');
});
