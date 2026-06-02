# سباق الكلمات — Word Race

Realtime multiplayer Arabic word-chain game. Players take turns — each new word must start with the last effective letter of the previous accepted word. Wrong letter, repeated word, or timeout → eliminated. Last player standing wins. The host is a referee (not a player) who approves or rejects each submitted word.

---

## Run locally

```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy on Render

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a **New Web Service** → connect your repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** Node
4. Done — Render sets `process.env.PORT` automatically.

---

## Game rules

- The **host** creates a room and gets a 4-character code. Players join with that code + a display name.
- The **first word** is free (any Arabic word). Every word after that must start with the **last effective letter** of the accepted word.
- A leading **ال** is ignored — e.g. "الكتاب" counts as starting with **ك**.
- If a word ends in **ة** (taa marbuta) or **ى** (alif maqsura), use **the letter before it** — e.g. "نخلة" → next word starts with **ل**.
- All hamza forms (**أ إ آ ٱ**) are treated as **ا**.
- Repeated words (after normalization) are rejected automatically.
- Wrong starting letter or timeout → automatic elimination, no host needed.
- Valid words go to the host for real-word approval (**قبول / رفض**).
- Timer: **15 s** for 11+ players, **10 s** for 4–10, **5 s** for 3 or fewer.
- If a player disconnects mid-game, the game **pauses**. The host can wait or drop them.
- If the host disconnects, the game **pauses** for everyone until they reconnect.
- Players who disconnect and reconnect resume their exact seat (token stored in localStorage).

---

## File layout

```
words-racing/
├── server.js        # Express + Socket.IO backend, all game logic
├── package.json
├── README.md
└── public/
    ├── index.html   # Single-page app, all screens
    ├── styles.css   # Dark RTL theme
    └── app.js       # Client logic, socket events, rendering
```
