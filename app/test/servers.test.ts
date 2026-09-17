import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyServers,
  killPlan,
  programName,
  serversSummary,
  shortCommand,
  TROUBLE,
  type ClonePidFile,
  type ServerRecord,
} from '../src/commands/servers.ts';
import { cloneAt } from '../src/fleet.ts';
import type { Listener, ProcessRow } from '../src/procs.ts';

import { syntheticHangar } from './fixture.ts';

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
