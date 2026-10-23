'use strict';
// Run with: node test.js
const assert = require('assert');
const { Table, evaluate } = require('./game');

const c = (r, s) => ({ r, s });
const hand = (...x) => evaluate(x.map(([r, s]) => c(r, s)));

// ---- hand ranking order ----
const order = [
  hand([2, 0], [3, 1], [5, 2]),            // high card 5
  hand([14, 0], [12, 1], [9, 2]),          // high card A
  hand([2, 0], [2, 1], [9, 2]),            // pair 2s, 9 kicker
  hand([14, 0], [14, 1], [3, 2]),          // pair aces
  hand([2, 0], [9, 0], [12, 0]),           // color Q
  hand([14, 0], [9, 0], [4, 0]),           // color A
  hand([4, 0], [3, 1], [2, 2]),            // lowest sequence
  hand([13, 0], [12, 1], [11, 2]),         // KQJ
  hand([14, 0], [2, 1], [3, 2]),           // A23 (second highest)
  hand([14, 0], [13, 1], [12, 2]),         // AKQ
  hand([4, 1], [3, 1], [2, 1]),            // lowest pure sequence
  hand([14, 2], [2, 2], [3, 2]),           // pure A23
  hand([14, 2], [13, 2], [12, 2]),         // pure AKQ
  hand([2, 0], [2, 1], [2, 2]),            // trail 2s
  hand([14, 0], [14, 1], [14, 2]),         // trail aces
];
for (let i = 1; i < order.length; i++) {
  assert(order[i].score > order[i - 1].score, `rank ${i}: ${order[i].name} should beat ${order[i - 1].name}`);
}
assert.strictEqual(hand([14, 0], [2, 1], [3, 2]).name, 'Sequence');
console.log('hand ranking ok');

// ---- a full table ----
let now = 1e12;
const fresh = () => { const x = new Table(); x.clock = () => now; return x; };
const t = fresh();
const tok = (n) => 'tok' + n;
const checkIn = () => { for (let i = 0; i < 6; i++) t.seen[tok(i)] = now; };

for (let i = 0; i < 6; i++) assert.strictEqual(t.join(tok(i), i, 'P' + i), null);
checkIn();
assert.strictEqual(t.join('x', 0, 'Dup'), 'That seat is taken.');
assert.strictEqual(t.join(tok(0), 1, 'P0'), 'You already have a seat.');

assert.strictEqual(t.deal(tok(0)), null);
const r = t.round;
assert.strictEqual(Object.keys(r.players).length, 6);
assert.strictEqual(r.pot, 600);
const all = Object.values(r.players).flatMap((p) => p.cards).map((x) => `${x.r}-${x.s}`);
assert.strictEqual(new Set(all).size, 18, 'no duplicate cards dealt');
assert(t.seats.every((s) => s.chips === 9900));

// views never leak unseen cards
const v = t.viewFor(tok(2));
assert.strictEqual(v.myCards, null);
assert(JSON.stringify(v).indexOf('"cards"') === -1, 'unseen cards not in view');

// turn order enforced
const first = r.turn;
const other = (first + 1) % 6;
assert.strictEqual(t.act(tok(other), 'chaal'), 'Not your turn.');
assert.strictEqual(t.act(tok(first), 'chaal'), null); // blind chaal = 100
assert.strictEqual(r.pot, 700);
t.see(tok(r.turn));
assert(t.viewFor(tok(r.turn)).myCards.length === 3);
const seenP = r.turn;
assert.strictEqual(t.viewFor(tok(seenP)).actions.chaal, 200); // seen pays double
assert.strictEqual(t.act(tok(seenP), 'raise'), null);          // stake -> 200, seen pays 400
assert.strictEqual(r.stake, 200);
assert.strictEqual(r.pot, 1100);

// a hand survives being saved and loaded in the middle (this is what serverless storage relies on)
const mid = Table.restore(JSON.parse(JSON.stringify(t.snapshot())));
mid.clock = () => now;
assert.deepStrictEqual(mid.snapshot(), t.snapshot());
assert.strictEqual(mid.round.pot, 1100);
assert.strictEqual(mid.viewFor(tok(seenP)).myCards.length, 3, 'seen cards survive a round trip');
assert.strictEqual(mid.act(tok(mid.round.turn), 'chaal'), null, 'restored table is playable');

// show not allowed with >2 players
assert.strictEqual(t.act(tok(r.turn), 'show'), 'Show is only possible with 2 players left.');

// everybody packs except two
let guard = 0;
while (t.activeSeats().length > 2 && guard++ < 10) t.act(tok(r.turn), 'pack');
assert.strictEqual(t.activeSeats().length, 2);
const [a, b] = t.activeSeats();
const asker = r.turn;
const pot0 = r.pot;
assert.strictEqual(t.act(tok(asker), 'show'), null);
assert.strictEqual(t.round, null);
const res = t.result;
const total = t.seats.reduce((n, s) => n + s.chips, 0);
assert.strictEqual(total, 6 * 10000, 'chips are conserved');
assert(res.winner === a || res.winner === b);
assert(res.hands[a] && res.hands[b], 'both show hands revealed');
console.log('winner:', res.winnerName, res.reason, 'pot', res.amount, '(was', pot0 + ')');

// last player standing
assert.strictEqual(t.deal(tok(0)), null);
guard = 0;
while (t.round && guard++ < 10) t.act(tok(t.round.turn), 'pack');
assert.strictEqual(t.round, null);
assert.strictEqual(t.seats.reduce((n, s) => n + s.chips, 0), 60000);
assert.strictEqual(t.result.reason, 'everyone else packed');
assert.deepStrictEqual(t.result.hands, {}, 'no cards revealed when all fold');

// a finished game restores too
const t2 = Table.restore(JSON.parse(JSON.stringify(t.snapshot())));
assert.strictEqual(t2.seats[3].name, 'P3');
assert.strictEqual(t2.seats.reduce((n, s) => n + s.chips, 0), 60000);
assert.strictEqual(t2.result.winnerName, t.result.winnerName);

// ---- offline players are packed lazily, one 30s window at a time ----
assert.strictEqual(t.deal(tok(0)), null);
checkIn();
assert.strictEqual(t.tick(), false, 'nobody is overdue yet');
const stuck = t.round.turn;
const next = t.nextActive(stuck);
now += 29000;
assert.strictEqual(t.tick(), false, 'still inside the 30s window');
// everyone except the player on turn and the one after keeps checking in
for (let i = 0; i < 6; i++) if (i !== stuck && i !== next) t.seen[tok(i)] = now;
now += 2000;
assert.strictEqual(t.tick(), true, 'the silent player is packed');
assert(t.round.players[stuck].folded);
assert.strictEqual(t.round.turn, next, 'turn moved on');
assert(!t.round.players[next].folded, 'next player gets their own fresh window');
now += 31000;
for (let i = 0; i < 6; i++) if (i !== stuck && i !== next) t.seen[tok(i)] = now;
assert.strictEqual(t.tick(), true);
assert(t.round.players[next].folded, 'second silent player packed too');
assert(t.viewFor(tok(0)).seats[stuck].online === false, 'silent player shows as offline');
now += 100;
checkIn();
while (t.round) t.act(tok(t.round.turn), 'pack');

// ---- broke players sit out and can top up ----
t.seats[1].chips = 20;
assert.strictEqual(t.deal(tok(0)), null);
assert(!t.round.players[1], 'broke player sits out');
while (t.round) t.act(tok(t.round.turn), 'pack');
assert.strictEqual(t.topup(tok(1)), null);
assert.strictEqual(t.viewFor(tok(1)).seats[1].net, 20 + 10000 - 20000);

// ---- leaving mid-hand ----
const t3 = fresh();
for (let i = 0; i < 3; i++) t3.join(tok(i), i, 'P' + i);
assert.strictEqual(t3.deal(tok(0)), null);
assert.strictEqual(t3.leave(tok(1)), null);
assert.strictEqual(t3.seats[1], null);
assert(t3.round && t3.round.players[1].folded, 'leaver is packed, hand goes on');
assert.strictEqual(t3.leave(tok(2)), null);
assert.strictEqual(t3.round, null, 'last one standing wins');
assert.strictEqual(t3.result.winnerName, 'P0');

console.log('table tests ok');
