# Teen Patti

A small table for up to 6 friends. No database, no accounts, no dependencies - just Node 18+.

## Run it locally

```
npm start
```

The console prints two links:

- `http://localhost:3000` - for this computer
- `http://192.168.x.x:3000` - for phones/laptops on the same Wi-Fi

Everyone opens a link, types a name and taps an empty seat. Anyone seated can deal.
Locally, state is saved to `data/db.json` (git-ignored). If Windows asks about the firewall
the first time, allow private networks.

## Deploy to Vercel

1. Push this repo to GitHub and import it at <https://vercel.com/new> (no build settings needed;
   `vercel.json` serves `public/` and the functions in `api/`).
2. In the Vercel project, open **Storage** and add an **Upstash Redis** database from the Marketplace.
   This sets `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) automatically.
   Vercel's filesystem is read-only/ephemeral, so without Redis the API returns an error.
3. Redeploy. Share the `*.vercel.app` link with your friends.

Or from the CLI: `npx vercel` (preview) / `npx vercel --prod`.

## How it works

- `game.js` - the engine: deck, hand ranking, betting rounds. The server is the only source of truth;
  each player is sent only the cards they are allowed to see.
- `api/*.js` - thin Vercel serverless functions (`/api/auth`, `/api/state`, `/api/action`) that
  delegate to `lib/router.js`. `server.js` runs the same handlers locally.
- `lib/store.js` - storage: Upstash Redis on Vercel, a JSON file locally.
- `public/` - the page. A player is identified by a token kept in their browser, so refreshing or
  closing the tab returns them to the same seat.

## Rules as implemented

- Everyone with at least the boot in chips is dealt in; the boot goes in the pot first.
- Blind players pay the current stake, players who looked pay double.
- Chaal keeps the stake, Raise doubles it (max 32x the boot), Pack folds.
- Show is only available with two players left. Highest hand wins; a tie goes to the player who did *not* ask.
- Trail > pure sequence > sequence > color > pair > high card. A-K-Q is the top sequence, A-2-3 second, 4-3-2 lowest.
- Everyone starts with 10,000 chips. When you can't cover the boot you can top up another 10,000
  (it's tracked as a buy-in, so the scoreboard's Net stays honest).
- If it's your turn and you're disconnected for 30 seconds you are packed automatically.

## Tests

```
npm test
```
