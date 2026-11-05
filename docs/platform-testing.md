# Testing on other platforms

NMS Vault has only been used for real on macOS with Steam. Support for the rest is a best
guess from the code, the game's file formats and community tools, until someone runs it there.

| Platform | Status |
|---|---|
| macOS, Steam | Used, including edits confirmed in-game |
| Windows, Steam | Automated tests only |
| Linux or Steam Deck, Steam through Proton | Automated tests only |
| Steam Frame | Not tested. Expected to work like Linux, with saves in the Proton folder |
| GOG | Not tested. Saves in a `DefaultUser` folder are recognised |
| Xbox Game Pass, PlayStation, Switch | Not supported |

## On each machine

Needs Node 22.15 or newer. Close the game first.

1. **Check, without changing anything.** Run `npm ci`, then `npm run doctor`, and keep the report.
2. **Look.** Run `npm start`. Check that saves show the right names, items have real names and icons,
   the Starborn Runner or a customised ship opens in 3D, and Save warns while the game is running.
3. **One small edit on a spare save.** Change an amount, save, then load it in-game.
4. **The riskier edits, on spare ships:** install technology from an empty cell, change a ship's type,
   change the freighter's type, then delete a ship. Load the game after each one.

Backups can undo any of these. With Steam Cloud on, check that the game loaded the edited save.

## Without running it on that machine

The doctor can read another machine's files from a mounted folder. This tests the formats, not
the system itself:

```
NMS_SAVE_ROOT="/Volumes/PC/HelloGames/NMS" NMS_GAME_DIR="/Volumes/PC/PCBANKS" npm run doctor
```

## Testing a download

The **Build downloads** workflow makes the private builds. In GitHub, go to Actions > Build downloads > Run workflow, then download from the draft on the Releases page while signed in. Anyone without write access can't see it.

A build needs nothing installed, so it's also the quickest test on a real machine: unzip it, run it, and check that it finds your saves and shows item names and icons. Make an edit on a save you can afford to lose, then load it in-game. The first launch shows a system warning, as the builds aren't signed.

Building releases on Node 26 doesn't change what source users need: running from source still works on Node 22.15 or newer.
