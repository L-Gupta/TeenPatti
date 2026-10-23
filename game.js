'use strict';
// Teen Patti game engine: deck, hand ranking and one table's state machine.
// Server-authoritative: clients only ever receive the view built by viewFor().
// The engine knows nothing about HTTP or storage: callers restore() it from a snapshot,
// apply one action, then save snapshot() again. A player's "token" is their stable account id.

const crypto = require('crypto');

const SEATS = 6;
const START_CHIPS = 10000;
const MAX_STAKE_MULT = 32; // stake (blind unit) can't exceed boot * this
const BOOT_OPTIONS = [50, 100, 200, 500, 1000];
const ONLINE_MS = 20000; // a page that checked in this recently counts as online
const OFFLINE_PACK_MS = 30000;

const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RANK_NAME = { 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const rankLabel = (v) => RANK_LABEL[v] || String(v);
const rankPlural = (v) => RANK_NAME[v] || `${v}s`;

// ---------- deck ----------

function newDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- hand ranking ----------
// Trail > Pure sequence > Sequence > Color > Pair > High card.
// Sequences: A-K-Q is highest, A-2-3 is second highest, 4-3-2 lowest.

function evaluate(cards) {
  const v = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const key = v[0] * 10000 + v[1] * 100 + v[2];

  if (v[0] === v[1] && v[1] === v[2]) {
    return { score: 6e6 + v[0], name: `Trail of ${rankPlural(v[0])}` };
  }

  let seqRank = null;
  if (v[0] - v[1] === 1 && v[1] - v[2] === 1) seqRank = v[0] * 2;
  else if (v[0] === 14 && v[1] === 3 && v[2] === 2) seqRank = 27; // A-2-3: between A-K-Q (28) and K-Q-J (26)
  if (seqRank !== null) {
    return flush
      ? { score: 5e6 + seqRank, name: 'Pure Sequence' }
      : { score: 4e6 + seqRank, name: 'Sequence' };
  }
  if (flush) return { score: 3e6 + key, name: `Color (${rankLabel(v[0])} high)` };

  if (v[0] === v[1] || v[1] === v[2]) {
    const pair = v[1];
    const kicker = v[0] === v[1] ? v[2] : v[0];
    return { score: 2e6 + pair * 100 + kicker, name: `Pair of ${rankPlural(pair)}` };
  }
  return { score: 1e6 + key, name: `High Card ${rankLabel(v[0])}` };
}

// ---------- table ----------

class Table {
  constructor() {
    this.seats = Array(SEATS).fill(null); // persistent per-seat record
    this.boot = 100;
    this.dealer = -1;
    this.roundNo = 0;
    this.round = null; // live hand (null between rounds)
    this.result = null; // outcome of the last finished hand
    this.history = []; // recent finished hands
    // not part of the snapshot: filled in by the caller on every request
    this.seen = {}; // player id -> ms timestamp of their page's last check-in
    this.clock = Date.now;
  }

  // ----- persistence -----

  static restore(raw) {
    const t = new Table();
    if (raw) {
      for (const k of ['seats', 'boot', 'dealer', 'roundNo', 'round', 'result', 'history']) if (raw[k] !== undefined) t[k] = raw[k];
    }
    return t;
  }

  snapshot() {
    const { seats, boot, dealer, roundNo, round, result, history } = this;
    return { seats, boot, dealer, roundNo, round, result, history };
  }

  // ----- helpers -----

  seatOf(token) {
    if (!token) return -1;
    return this.seats.findIndex((s) => s && s.token === token);
  }

  isOnline(i) {
    const s = this.seats[i];
    return !!s && this.clock() - (this.seen[s.token] || 0) < ONLINE_MS;
  }

  activeSeats() {
    if (!this.round) return [];
    return Object.keys(this.round.players).map(Number)
      .filter((i) => !this.round.players[i].folded).sort((a, b) => a - b);
  }

  nextActive(from) {
    for (let k = 1; k <= SEATS; k++) {
      const i = (from + k) % SEATS;
      const p = this.round.players[i];
      if (p && !p.folded) return i;
    }
    return -1;
  }

  setTurn(i) {
    this.round.turn = i;
    this.round.turnAt = this.clock();
  }

  costFor(i) {
    const p = this.round.players[i];
    return p.seen ? this.round.stake * 2 : this.round.stake;
  }

  say(msg) {
    this.round.log.push(msg);
    if (this.round.log.length > 40) this.round.log.shift();
  }

  // Runs on every request instead of a timer (serverless has none): packs whoever holds the
  // turn after they have been silent for OFFLINE_PACK_MS. Returns true if anything changed.
  tick() {
    let changed = false;
    for (let guard = 0; guard < SEATS && this.round; guard++) {
      const r = this.round;
      const s = this.seats[r.turn];
      if (!s) break;
      const lastSign = Math.max(this.seen[s.token] || 0, r.turnAt || 0);
      if (this.clock() - lastSign < OFFLINE_PACK_MS) break;
      this.say(`${s.name} is offline - packed automatically.`);
      this.doPack(r.turn);
      changed = true;
    }
    return changed;
  }

  // ----- actions (each returns an error string or null) -----

  join(token, seat, name) {
    if (this.seatOf(token) >= 0) return 'You already have a seat.';
    if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) return 'Bad seat.';
    if (this.seats[seat]) return 'That seat is taken.';
    this.seats[seat] = { name, token, chips: START_CHIPS, buyIns: 1, wins: 0, hands: 0 };
    return null;
  }

  leave(token) {
    const i = this.seatOf(token);
    if (i < 0) return 'No seat.';
    if (this.round && this.round.players[i] && !this.round.players[i].folded) {
      this.say(`${this.seats[i].name} left the table.`);
      this.doPack(i); // may end the round; chips of a leaver stay in the pot
    }
    this.seats[i] = null;
    return null;
  }

  setBoot(token, boot) {
    if (this.seatOf(token) < 0) return 'Sit down first.';
    if (this.round) return 'Wait for the hand to finish.';
    if (!BOOT_OPTIONS.includes(boot)) return 'Bad boot amount.';
    this.boot = boot;
    return null;
  }

  topup(token) {
    const i = this.seatOf(token);
    if (i < 0) return 'Sit down first.';
    if (this.round && this.round.players[i]) return 'Wait for the hand to finish.';
    const s = this.seats[i];
    if (s.chips >= this.boot) return 'You still have enough chips.';
    s.chips += START_CHIPS;
    s.buyIns += 1;
    return null;
  }

  resetAll(token) {
    if (this.seatOf(token) < 0) return 'Sit down first.';
    if (this.round) return 'Finish the current hand first.';
    for (const s of this.seats) if (s) Object.assign(s, { chips: START_CHIPS, buyIns: 1, wins: 0, hands: 0 });
    this.history = [];
    this.roundNo = 0;
    this.result = null;
    return null;
  }

  deal(token) {
    if (this.seatOf(token) < 0) return 'Sit down first.';
    if (this.round) return 'A hand is already running.';
    const eligible = [];
    for (let i = 0; i < SEATS; i++) if (this.seats[i] && this.seats[i].chips >= this.boot) eligible.push(i);
    if (eligible.length < 2) return 'Need at least 2 players with enough chips for the boot.';

    // dealer moves to the next eligible seat
    let d = this.dealer;
    do { d = (d + 1) % SEATS; } while (!eligible.includes(d));
    this.dealer = d;
    this.roundNo += 1;

    const deck = newDeck();
    const players = {};
    let pot = 0;
    // dealt one card at a time, starting left of the dealer, like a real table
    const order = [];
    for (let k = 1; k <= SEATS; k++) { const i = (d + k) % SEATS; if (eligible.includes(i)) order.push(i); }
    for (const i of order) players[i] = { cards: [], seen: false, folded: false, paid: 0 };
    for (let c = 0; c < 3; c++) for (const i of order) players[i].cards.push(deck.pop());
    for (const i of order) {
      const s = this.seats[i];
      s.chips -= this.boot;
      s.hands += 1;
      players[i].paid = this.boot;
      pot += this.boot;
    }
    this.round = { no: this.roundNo, pot, stake: this.boot, turn: order[0], turnAt: this.clock(), players, log: [], showCards: null };
    this.result = null;
    this.say(`Round ${this.roundNo}: everyone put in the boot of ${fmt(this.boot)}. Cards dealt.`);
    return null;
  }

  see(token) {
    const i = this.seatOf(token);
    const p = this.round && this.round.players[i];
    if (!p || p.folded) return 'You are not in this hand.';
    if (p.seen) return null;
    p.seen = true;
    this.say(`${this.seats[i].name} looked at their cards.`);
    return null;
  }

  act(token, type) {
    const i = this.seatOf(token);
    if (i < 0) return 'Sit down first.';
    if (!this.round) return 'No hand running.';
    const r = this.round;
    if (r.turn !== i) return 'Not your turn.';
    const p = r.players[i];
    const s = this.seats[i];

    if (type === 'pack') {
      this.say(`${s.name} packed.`);
      this.doPack(i);
    } else if (type === 'chaal' || type === 'raise') {
      let stake = r.stake;
      if (type === 'raise') {
        stake = r.stake * 2;
        if (stake > this.boot * MAX_STAKE_MULT) return 'Stake is already at the maximum.';
      }
      const cost = p.seen ? stake * 2 : stake;
      if (cost > s.chips) return 'Not enough chips - pack instead.';
      r.stake = stake;
      this.pay(i, cost);
      this.say(`${s.name} ${type === 'raise' ? 'raised' : 'played'} ${p.seen ? 'seen' : 'blind'} for ${fmt(cost)}.`);
      this.setTurn(this.nextActive(i));
    } else if (type === 'show') {
      const active = this.activeSeats();
      if (active.length !== 2) return 'Show is only possible with 2 players left.';
      const cost = this.costFor(i);
      if (cost > s.chips) return 'Not enough chips to ask for a show - pack instead.';
      this.pay(i, cost);
      this.say(`${s.name} asked for a show (${fmt(cost)}).`);
      this.doShow(i, active.find((x) => x !== i));
    } else {
      return 'Unknown action.';
    }
    return null;
  }

  pay(i, amount) {
    const p = this.round.players[i];
    this.seats[i].chips -= amount;
    p.paid += amount;
    this.round.pot += amount;
  }

  doPack(i) {
    const r = this.round;
    if (!r || !r.players[i] || r.players[i].folded) return;
    r.players[i].folded = true;
    const left = this.activeSeats();
    if (left.length === 1) {
      this.finish(left[0], 'everyone else packed', false);
    } else if (r.turn === i) {
      this.setTurn(this.nextActive(i));
    }
  }

  doShow(requester, other) {
    const r = this.round;
    const a = evaluate(r.players[requester].cards);
    const b = evaluate(r.players[other].cards);
    // on a tie the player who asked for the show loses
    const winner = a.score > b.score ? requester : other;
    r.showCards = [requester, other];
    this.finish(winner, `show: ${a.name} vs ${b.name}`, true);
  }

  finish(winner, reason, revealed) {
    const r = this.round;
    const w = this.seats[winner];
    w.chips += r.pot;
    w.wins += 1;
    const hands = {};
    if (revealed) {
      for (const i of r.showCards) {
        hands[i] = { cards: r.players[i].cards, name: evaluate(r.players[i].cards).name };
      }
    }
    this.result = {
      round: r.no, winner, winnerName: w.name, amount: r.pot, reason, hands,
      net: Object.fromEntries(Object.keys(r.players).map((i) => [i, (i == winner ? r.pot : 0) - r.players[i].paid])),
    };
    this.say(`${w.name} wins ${fmt(r.pot)} (${reason}).`);
    this.history.unshift(`Round ${r.no}: ${w.name} won ${fmt(r.pot)}`);
    this.history = this.history.slice(0, 15);
    this.result.log = r.log.slice(-12);
    this.round = null;
  }

  // ----- per-viewer view -----

  viewFor(token) {
    const me = this.seatOf(token);
    const r = this.round;
    const res = this.result;
    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      const p = r && r.players[i];
      const v = {
        name: s.name, chips: s.chips, net: s.chips + (p ? p.paid : 0) - s.buyIns * START_CHIPS, wins: s.wins, hands: s.hands,
        buyIns: s.buyIns, online: this.isOnline(i),
        state: p ? (p.folded ? 'packed' : 'in') : 'out',
        seen: !!(p && p.seen), bet: p ? p.paid : 0,
      };
      // cards other players may see: only the ones revealed by a show
      if (res && res.hands[i]) v.revealed = res.hands[i];
      return v;
    });

    const view = {
      me, boot: this.boot, bootOptions: BOOT_OPTIONS, dealer: this.dealer, startChips: START_CHIPS,
      round: r ? { no: r.no, pot: r.pot, stake: r.stake, turn: r.turn, maxStake: this.boot * MAX_STAKE_MULT } : null,
      result: res, seats, history: this.history,
      log: r ? r.log.slice(-12) : (res ? res.log : []),
      myCards: null, myHand: null, actions: {},
    };

    if (me >= 0) {
      const p = r && r.players[me];
      const s = this.seats[me];
      if (p && p.seen) { view.myCards = p.cards; view.myHand = evaluate(p.cards).name; }
      else if (res && res.hands[me]) { view.myCards = res.hands[me].cards; view.myHand = res.hands[me].name; }
      const a = view.actions;
      if (p && !p.folded) {
        a.canSee = !p.seen;
        if (r.turn === me) {
          const cost = this.costFor(me);
          a.chaal = cost <= s.chips ? cost : null;
          const rs = r.stake * 2;
          const rcost = p.seen ? rs * 2 : rs;
          a.raise = rs <= this.boot * MAX_STAKE_MULT && rcost <= s.chips ? rcost : null;
          a.show = this.activeSeats().length === 2 && cost <= s.chips ? cost : null;
          a.pack = true;
        }
      }
      a.deal = !r;
      a.topup = !r && s.chips < this.boot;
    }
    return view;
  }
}

const fmt = (n) => n.toLocaleString('en-US');

module.exports = { Table, evaluate, newDeck, SEATS, START_CHIPS };
