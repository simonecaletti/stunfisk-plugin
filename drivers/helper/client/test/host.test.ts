import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBattleRoom, formatFromRoom, readOpenBattle } from '../src/host.ts';
import { classicHost, preactHost, room } from './fakes.ts';

const R1 = 'battle-gen9vgc2026regmc-111';
const R2 = 'battle-gen9vgc2026regmc-222-tok3n';

test('format comes from the room id, with or without a private token', () => {
  assert.equal(formatFromRoom(R1), 'gen9vgc2026regmc');
  assert.equal(formatFromRoom(R2), 'gen9vgc2026regmc');
  assert.equal(formatFromRoom('lobby'), '');
});

test('reads lines and request straight from the classic client', () => {
  const r = room(R1, ['|tier|x', '|turn|1'], { side: { id: 'p2' }, active: [{}] });
  const b = readOpenBattle(classicHost(r), R1)!;
  assert.deepEqual(b.lines, ['|tier|x', '|turn|1']);
  assert.equal(b.side, 'p2');
  assert.equal(b.user, 'Alice');
  assert.equal(b.format, 'gen9vgc2026regmc');
});

test('reads the Preact client the same way', () => {
  const b = readOpenBattle(preactHost(room(R1, ['|turn|1'])), R1)!;
  assert.deepEqual(b.lines, ['|turn|1']);
  assert.equal(b.side, null);
  assert.equal(b.user, 'Alice');
});

test('follows the room in front, then sticks with the followed battle when a non-battle room is in front', () => {
  const a = room(R1), b = room(R2);
  assert.equal(findBattleRoom(classicHost(a, b), null), R1);
  assert.equal(findBattleRoom(classicHost(b, a), R1), R2);
  const lobby = { id: 'lobby', battle: null, request: null } as never;
  const host = classicHost(a, b);
  host.app.curRoom = lobby;
  assert.equal(findBattleRoom(host, R2), R2);
  assert.equal(findBattleRoom(host, null), R1);
  assert.equal(findBattleRoom(classicHost(), null), null);
});

test('rooms without a battle, and unknown hosts, give nothing', () => {
  assert.equal(readOpenBattle(classicHost(room(R1)), 'battle-missing-1'), null);
  assert.equal(findBattleRoom({}, null), null);
});

test('non-string queue entries are skipped', () => {
  const r = room(R1);
  (r.battle.stepQueue as unknown[]).push(null, 5, '|turn|2');
  assert.deepEqual(readOpenBattle(classicHost(r), R1)!.lines, ['|turn|2']);
});
