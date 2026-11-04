# Riichi Mahjong Calculator & Live Scoreboard

A free website for Riichi (Japanese) mahjong:

- **Table** – track a game: scores, dealer, honba, riichi sticks, pon markers, draws, undo
- **Record win** – full hand scorer (yaku, dora, fu) with double/triple ron
- **Live games** – tap *Share live game* to get a **QR code**; everyone who scans it joins the same table and can record riichi, wins and draws from their own phone. Updates appear instantly on every phone.
- **Results** – tournaments with uma/oka (default: 25,000 start, 30,000 return, +30/+10/−10/−30, 五捨六入), leaderboard, game history, copy-to-WeChat text, backups. A live room has its own shared scoreboard.
- **Shared tournaments** – on the Results tab, ••• → *Share with players* gives a 6-character code and QR code (needs a player account; you become the organizer). Players join with ••• → *Join a tournament* or by scanning. Everyone sees the same standings and can add games from their own phone — including games finished in a live room started from the shared tournament. Only the organizer can change rules, rename, edit or delete games, or delete the tournament. Games added offline upload automatically when the phone is back online.
- **Me** – player accounts (username + password) and personal stats: win rate, deal-in rate, riichi and call rates, average win, tenpai at draws, chombo, placements, most common yaku. Each player sees only their own stats and can download them as CSV.
- **Yaku** reference and **How to** play guide

It runs on Cloudflare's free plan: a Worker serves the site, one Durable Object per live room keeps the shared game state (WebSockets), and a D1 database stores accounts and finished games for stats.

```
public/          the website (index.html, qrcode.js, favicon, robots.txt)
src/worker.js    live-room server: /api/rooms (create), /api/rooms/:code/ws (sync)
src/api.js       accounts, saved games, stats and CSV exports (D1)
wrangler.jsonc   Cloudflare config
```

## Put it online (about 10 minutes, free)

### 1. Put the code on GitHub
1. Sign in at [github.com](https://github.com) → **New repository** → name it `riichi-mahjong-calc` → **Create repository**.
2. On the empty repo page click **uploading an existing file**, drag in everything from this folder (including the `public` and `src` folders, but *not* `node_modules`), and **Commit changes**.

### 2. Deploy it on Cloudflare
1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages** → **Create** → **Import a repository** and connect your GitHub account.
3. Pick the `riichi-mahjong-calc` repo. Leave the build settings at their defaults (deploy command `npx wrangler deploy`) and click **Deploy**.
4. You'll get an address like `https://riichi-mahjong-calc.<your-name>.workers.dev`. That's the website — open it on your phone and try **Share live game**.

Every time you change a file on GitHub, Cloudflare redeploys automatically.

### 3. Optional: your own domain
In the Worker's **Settings → Domains & Routes** you can attach a domain you buy (e.g. `riichimahjong.app`, ~US$10/yr). A short domain is easier to type and share.

### 4. Make it show up in Google
1. Open [Google Search Console](https://search.google.com/search-console), add your site's address, and verify it (the "HTML tag" method: paste the tag into `<head>` of `public/index.html`).
2. Use **URL inspection → Request indexing**. It can take a few days to appear in search results.
3. Links from other places (a Reddit post, a club page, a WeChat article) help people find it faster.

## Player stats

1. Each player opens the **Me** tab and creates an account (no email needed).
2. At the table, tap **Link players**. Tap **This is me** for your own seat, and type the other players' usernames.
3. Play as usual, then **Finish & save**. The game, with every hand (wins, deal-ins, riichi, calls, draws, chombo), is saved for the linked players.
   - It counts right away for whoever saved it and for anyone who tapped **This is me** on their own phone (in a live QR game).
   - Other linked players see it under **Confirm these games** on their Me tab and tap **Accept**.
   - If a phone is offline when the game finishes, it uploads the next time the site is opened online.

**Organizer (admin) access:** in `wrangler.jsonc` set `"ADMINS": "yourusername"` (comma-separate several). Admins get **Organizer tools** on the Me tab: download all games / all hands / players as CSV, and reset a forgotten password.

The database (`riichi-mahjong-stats`) is created automatically on the first deploy; its tables are created on the first request.

## Run it on your own computer (optional)
```
npm install
npm run dev        # http://localhost:8787
```

## Notes
- Live rooms are deleted automatically after 90 days with no changes.
- Personal results (tournaments, backups) are stored in each phone's browser; live rooms and shared tournaments are stored on Cloudflare. Shared tournaments don't expire.
- In mainland China the `workers.dev` address usually needs a VPN.
