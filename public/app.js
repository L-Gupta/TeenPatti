'use strict';
// Thin client: the server owns all game state. We log in, then poll for our own view of the table.

const SEATS = 6;
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SOUND_KEY = 'tp_sound';
const POLL_MS = 2000;
const HEARTBEAT_MS = 8000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n.toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

let view = null;
let username = null;
let pollTimer = null;
let lastBeat = 0;
let wasMyTurn = false;
let hadCards = false;
let soundOn = store.get(SOUND_KEY) !== '0';

// ---------- talking to the server ----------

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function poll() {
  clearTimeout(pollTimer);
  const beat = Date.now() - lastBeat > HEARTBEAT_MS;
  fetch('/api/state' + (beat ? '?hb=1' : ''), { cache: 'no-store' })
    .then(async (res) => {
      if (res.status === 401) { showLogin(); return; }
      if (beat) lastBeat = Date.now();
      view = await res.json();
      setConn(true);
      render();
    })
    .catch(() => setConn(false))
    .finally(() => { if (username) pollTimer = setTimeout(poll, POLL_MS); });
}

async function send(type, extra = {}) {
  try {
    const { status, json } = await post('/api/action', { type, ...extra });
    if (status === 401) { showLogin(); return false; }
    if (json.view) { view = json.view; render(); }
    if (!json.ok) { toast(json.error || 'Something went wrong.'); return false; }
    return true;
  } catch (e) {
    toast('Network problem - try again.');
    return false;
  }
}

// ---------- login ----------

let loginMode = 'login';

function setLoginMode(mode) {
  loginMode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('loginSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('codeRow').hidden = mode !== 'signup' || !codeRequired;
  $('loginError').hidden = true;
}
let codeRequired = false;

function showLogin() {
  username = null;
  view = null;
  clearTimeout(pollTimer);
  document.title = 'Teen Patti';
  $('login').hidden = false;
  setLoginMode(loginMode);
}

function startPlaying(name) {
  username = name;
  $('login').hidden = true;
  $('pass').value = '';
  $('whoami').textContent = `Logged in as ${name}.`;
  lastBeat = 0;
  poll();
}

async function boot() {
  try {
    const res = await fetch('/api/auth', { cache: 'no-store' });
    const j = await res.json();
    codeRequired = !!j.codeRequired;
    if (j.user) return startPlaying(j.user);
  } catch (e) { setConn(false); }
  showLogin();
}

function setConn(live) {
  const el = $('conn');
  el.textContent = live ? 'live' : 'reconnecting…';
  el.classList.toggle('live', live);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- pieces of markup ----------

function cardHtml(c, cls = '') {
  const red = c.s === 1 || c.s === 2;
  return `<div class="pcard ${red ? 'red' : ''} ${cls}"><span>${RANKS[c.r] || c.r}</span><span class="s">${SUITS[c.s]}</span></div>`;
}
const backHtml = (cls = '') => `<div class="pcard back ${cls}"></div>`;
const sortCards = (cards) => [...cards].sort((a, b) => b.r - a.r);

function seatHtml(i) {
  const v = view;
  const s = v.seats[i];
  const pos = (i - Math.max(v.me, 0) + SEATS) % SEATS;

  if (!s) {
    const btn = v.me < 0 ? `<button class="btn small" data-join="${i}">Sit here</button>` : '<span class="muted small">empty</span>';
    return `<div class="seat empty pos${pos}"><span class="muted small">Seat ${i + 1}</span>${btn}</div>`;
  }

  const inRound = !!v.round;
  const turn = inRound && v.round.turn === i;
  const cls = ['seat', 'pos' + pos];
  if (i === v.me) cls.push('mine');
  if (turn) cls.push('turn');
  if (s.state === 'packed') cls.push('packed');

  const tags = [];
  if (s.state === 'in') tags.push(`<span class="tag ${s.seen ? 'seen' : ''}">${s.seen ? 'Seen' : 'Blind'}</span>`);
  else if (s.state === 'packed') tags.push('<span class="tag">Packed</span>');
  else if (inRound) tags.push('<span class="tag">Sitting out</span>');
  else if (s.chips < v.boot) tags.push('<span class="tag neg">Out of chips</span>');
  const net = !inRound && v.result && v.result.net[i];
  if (net) tags.push(`<span class="tag ${net > 0 ? 'pos' : 'neg'}">${signed(net)}</span>`);

  let minis = '';
  let handName = '';
  if (s.revealed) {
    minis = sortCards(s.revealed.cards).map((c) => cardHtml(c, 'mini')).join('');
    handName = `<div class="handname">${esc(s.revealed.name)}</div>`;
  } else if (s.state === 'in') {
    minis = backHtml('mini').repeat(3);
  }

  return `<div class="${cls.join(' ')}">
    ${v.dealer === i ? '<div class="dealer" title="Dealer">D</div>' : ''}
    <div class="name"><span class="dot ${s.online ? '' : 'off'}"></span>${esc(s.name)}</div>
    <div class="chips">${fmt(s.chips)}</div>
    <div class="tags">${tags.join('')}</div>
    <div class="minis">${minis}</div>
    ${handName}
    ${inRound && s.bet ? `<div class="bet">in pot: ${fmt(s.bet)}</div>` : ''}
  </div>`;
}

// ---------- render ----------

function renderCenter() {
  const v = view;
  const el = $('center');
  const r = v.round;
  if (r) {
    const mine = r.turn === v.me;
    const who = v.seats[r.turn];
    el.innerHTML = `
      <div class="roundno">Round ${r.no}</div>
      <div class="pot-label">POT</div>
      <div class="pot">${fmt(r.pot)}</div>
      <div class="stake">Stake <b>${fmt(r.stake)}</b> blind &middot; <b>${fmt(r.stake * 2)}</b> seen</div>
      <div class="turnmsg ${mine ? 'mine' : ''}">${mine ? 'Your turn' : who ? esc(who.name) + "'s turn" : ''}</div>`;
    return;
  }

  const res = v.result;
  const ready = v.seats.filter((s) => s && s.chips >= v.boot).length;
  const dealBtn = v.actions.deal
    ? `<button class="btn primary" data-act="deal" ${ready < 2 ? 'disabled' : ''}>${res ? 'Deal next hand' : 'Deal'}</button>`
    : '';
  const hint = ready < 2 ? `<div class="hint">Need 2 players with at least ${fmt(v.boot)} chips.</div>` : '';

  if (res) {
    const reason = res.reason.charAt(0).toUpperCase() + res.reason.slice(1);
    el.innerHTML = `
      <div class="roundno">Round ${res.round}</div>
      <div class="winner">${esc(res.winnerName)} wins ${fmt(res.amount)}</div>
      <div class="reason">${esc(reason)}</div>${hint}${dealBtn}`;
  } else {
    el.innerHTML = `
      <div class="pot-label">TEEN PATTI</div>
      <div class="hint">${v.me < 0 ? 'Take a seat to play.' : 'Waiting for the first deal.'}</div>${hint}${dealBtn}`;
  }
}

function renderHand() {
  const v = view;
  const el = $('hand');
  if (v.me < 0) { el.hidden = true; hadCards = false; return; }
  el.hidden = false;

  const me = v.seats[v.me];
  const a = v.actions;
  const r = v.round;
  const inHand = !!r && me.state === 'in';
  const myTurn = inHand && r.turn === v.me;

  let cards = '';
  if (v.myCards) {
    const flip = !hadCards ? 'flip' : '';
    cards = sortCards(v.myCards).map((c) => cardHtml(c, 'big ' + flip)).join('');
  } else if (inHand) {
    cards = backHtml('big').repeat(3);
  }
  hadCards = !!v.myCards;

  let status;
  let buttons = '';
  if (inHand) {
    const seen = me.seen;
    const chaal = seen ? r.stake * 2 : r.stake;
    const raise = chaal * 2;
    const twoLeft = v.seats.filter((s) => s && s.state === 'in').length === 2;
    const b = (act, label, cost, on, extra = '') =>
      `<button class="btn ${extra}" data-act="${act}" ${on ? '' : 'disabled'}>${label}<small>${cost}</small></button>`;

    if (a.canSee) buttons += `<button class="btn" data-act="see">See cards<small>free</small></button>`;
    buttons += b('chaal', 'Chaal', fmt(chaal), myTurn && !!a.chaal, myTurn && a.chaal ? 'primary' : '');
    buttons += b('raise', 'Raise', fmt(raise), myTurn && !!a.raise);
    if (twoLeft) buttons += b('show', 'Show', fmt(chaal), myTurn && !!a.show);
    buttons += `<button class="btn danger" data-act="pack" ${myTurn ? '' : 'disabled'}>Pack<small>fold</small></button>`;

    if (myTurn) {
      status = me.seen ? 'Your turn. Playing seen costs double.' : 'Your turn. You can play blind or look first.';
      if (!a.chaal) status += ' You can’t afford to play - pack.';
    } else {
      const who = v.seats[r.turn];
      status = who ? `Waiting for ${esc(who.name)}…` : '';
    }
  } else if (r) {
    status = me.state === 'packed' ? 'You packed this hand.' : 'You’re sitting out this hand.';
  } else {
    status = me.chips < v.boot ? 'You’re out of chips for this boot.' : 'Between hands.';
    if (a.topup) buttons = `<button class="btn primary" data-act="topup">Top up +${fmt(v.startChips)}</button>`;
  }

  el.innerHTML = `
    ${cards ? `<div class="cards" data-act="${a.canSee ? 'see' : ''}">${cards}</div>` : ''}
    <div class="info">
      ${v.myHand ? `<div class="handname">${esc(v.myHand)}</div>` : ''}
      <div class="status ${myTurn ? 'mine' : ''}">${status}</div>
      <div class="actions">${buttons}</div>
    </div>`;
}

function renderSide() {
  const v = view;
  const rows = v.seats.filter(Boolean).sort((a, b) => b.chips - a.chips);
  $('board').innerHTML = `<tr><th>Player</th><th>Chips</th><th>Net</th><th>Wins</th></tr>` + rows.map((s) =>
    `<tr><td><span class="dot ${s.online ? '' : 'off'}"></span>${esc(s.name)}${s.buyIns > 1 ? ` <span class="muted small">(${s.buyIns} buy-ins)</span>` : ''}</td>
      <td>${fmt(s.chips)}</td><td class="${s.net >= 0 ? 'pos' : 'neg'}">${signed(s.net)}</td><td>${s.wins}/${s.hands}</td></tr>`).join('');
  $('log').innerHTML = [...v.log].reverse().map((l) => `<li>${esc(l)}</li>`).join('');
  $('history').innerHTML = v.history.map((h) => `<li>${esc(h)}</li>`).join('');
}

function renderBoot() {
  const v = view;
  const sel = $('boot');
  if (sel.options.length !== v.bootOptions.length) {
    sel.innerHTML = v.bootOptions.map((b) => `<option value="${b}">${fmt(b)}</option>`).join('');
  }
  sel.value = String(v.boot);
  sel.disabled = v.me < 0 || !!v.round;
}

function notifyTurn() {
  const mine = !!view.round && view.round.turn === view.me && view.me >= 0;
  document.title = mine ? '▶ Your turn - Teen Patti' : 'Teen Patti';
  if (mine && !wasMyTurn && soundOn) beep();
  wasMyTurn = mine;
}

let audio;
function beep() {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  } catch (e) { /* audio blocked until the first tap */ }
  if (navigator.vibrate) navigator.vibrate(150);
}

function render() {
  if (!view) return;
  $('seats').innerHTML = Array.from({ length: SEATS }, (_, i) => seatHtml(i)).join('');
  $('join').hidden = view.me >= 0;
  renderCenter();
  renderHand();
  renderSide();
  renderBoot();
  notifyTurn();
}

// ---------- input ----------

document.addEventListener('click', async (e) => {
  const join = e.target.closest('[data-join]');
  if (join) {
    if (await send('join', { seat: Number(join.dataset.join) })) hadCards = false;
    return;
  }

  const tab = e.target.closest('.tab');
  if (tab) { setLoginMode(tab.dataset.mode); return; }

  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act) {
    if (act.disabled) return;
    const type = act.dataset.act;
    if (type === 'pack' && !confirm('Pack and give up this hand?')) return;
    send(type);
    return;
  }

  const menu = e.target.closest('[data-menu]');
  if (menu) {
    const which = menu.dataset.menu;
    if (which === 'logout') { $('menu').close(); await post('/api/auth', { action: 'logout' }); showLogin(); }
    if (which === 'leave' && confirm('Leave the table? You will lose your seat and chips.')) { $('menu').close(); send('leave'); }
    if (which === 'reset' && confirm('Reset chips and scores for EVERYONE?')) { $('menu').close(); send('reset'); }
  }
});

$('boot').addEventListener('change', async (e) => {
  if (!(await send('boot', { boot: Number(e.target.value) }))) renderBoot();
});
$('menuBtn').addEventListener('click', () => $('menu').showModal());
$('rulesBtn').addEventListener('click', () => $('rules').showModal());
$('sound').checked = soundOn;
$('sound').addEventListener('change', (e) => { soundOn = e.target.checked; store.set(SOUND_KEY, soundOn ? '1' : '0'); });

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;
  $('loginSubmit').disabled = true;
  try {
    const { json } = await post('/api/auth', {
      action: loginMode, username: $('user').value, password: $('pass').value, code: $('code').value,
    });
    if (json.ok) startPlaying(json.user);
    else { err.textContent = json.error || 'Something went wrong.'; err.hidden = false; }
  } catch (x) {
    err.textContent = 'Network problem - try again.';
    err.hidden = false;
  }
  $('loginSubmit').disabled = false;
});

// phones freeze timers in background tabs - catch up right away when the player comes back
document.addEventListener('visibilitychange', () => { if (!document.hidden && username) poll(); });

boot();
