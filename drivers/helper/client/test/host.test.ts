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

test('only a real Showdown client counts, and a page that becomes one later is waited for', async () => {
  const { hasShowdownClient, waitForShowdownClient } = await import('../src/host.ts');
  assert.equal(hasShowdownClient({}), false);
  assert.equal(hasShowdownClient({ app: {} } as never), false);
  assert.equal(hasShowdownClient({ app: { rooms: {} } } as never), false); // rooms alone is not enough
  assert.equal(hasShowdownClient({ app: { receive() {}, rooms: {} } } as never), true); // classic
  assert.equal(hasShowdownClient({ PS: { join() {}, rooms: {} } } as never), true); // rewritten
  const late: { app?: unknown } = {};
  setTimeout(() => { late.app = { receive() {}, rooms: {} }; }, 60);
  assert.equal(await waitForShowdownClient(late as never, 1000, 10), true);
  assert.equal(await waitForShowdownClient({} as never, 80, 10), false);
});

test('the battle the user plays is followed ahead of one they only watch', async () => {
  const { findBattleRoom, playerRoomIds, openBattleRoomIds } = await import('../src/host.ts');
  const watched = room(R1, ['|turn|1']);
  const played = room(R2, ['|turn|1'], { side: { id: 'p1' }, active: [{}] });
  // watched is in front, played is behind: the user's own game wins
  const host = classicHost(watched, played);
  assert.deepEqual(playerRoomIds(host), [R2]);
  assert.deepEqual(openBattleRoomIds(host).sort(), [R1, R2]);
  assert.equal(findBattleRoom(host, null), R2);
  assert.equal(findBattleRoom(host, R1), R2); // already following the watched one: still moves to the played one
  // two played games: the one in front, then the one already followed
  const other = room('battle-gen9vgc2026regmc-333', ['|turn|1'], { side: { id: 'p2' } });
  assert.equal(findBattleRoom(classicHost(other, played), null), other.id);
  const lobby = { id: 'lobby', battle: null, request: null } as never;
  const away = classicHost(played, other);
  away.app.curRoom = lobby;
  assert.equal(findBattleRoom(away, other.id), other.id);
  // Preact marks a player with room.side
  const preact = preactHost(room(R1), { ...room(R2), side: { id: 'p2' } } as never);
  assert.equal(findBattleRoom(preact, null), R2);
});

test('a room seen as the user\'s own stays theirs while the client has dropped the request', async () => {
  const { findBattleRoom } = await import('../src/host.ts');
  const watched = room(R1, ['|turn|1']);
  const played = room(R2, ['|turn|1'], null); // between decisions: no request right now
  const host = classicHost(watched, played);
  assert.equal(findBattleRoom(host, null), R1); // nothing says it is theirs...
  assert.equal(findBattleRoom(host, null, new Set([R2])), R2); // ...except what we saw earlier
});
