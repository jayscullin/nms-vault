# NMS Vault

A local, non-destructive inventory manager for No Man's Sky saves (Steam and GOG).

```bash
npm start          # opens http://localhost:5280
npm test
```

Needs Node 22+ and has no dependencies.

## What it does

- Finds your saves automatically (macOS, Windows, Linux/Proton), or uses `NMS_SAVE_ROOT`.
- Shows every inventory as its in-game grid: exosuit, starships, multi-tools, freighter, storage containers, exocraft, and base storage.
- Real item names, descriptions and icons, read directly from your installed game (see below).
- **All items** view: totals for each item across every inventory, with jump-to-location. Search matches names and IDs.
- Edits: set stack amounts, fill stacks, remove items, drag to rearrange or transfer (onto a cell, or onto a container in the sidebar), rename ships, multi-tools and containers, and set Units, Nanites and Quicksilver.
- **Add items:** select an empty cell and search the game's catalogue of products and substances. New stacks copy the slot format of an existing slot in the same save and get the game's stack limit for that inventory. Procedural items, which need a game-generated seed, can't be added.
- **Technology:** recharge tech the game data marks as chargeable, repair damaged tech, and remove tech that isn't core. Core tech is what the game won't let you dismantle (Life Support, Launch Thruster, Pulse Engine and so on), and it can't be removed. Broken-slot placeholders on salvaged multi-tools and ships can be removed, which frees the slot. Both flags come from the game's technology table, and if they can't be read, those edits are disabled.
- Undo, discard, and a review screen before anything is written.

## How it stays non-destructive

1. **Exact round-trip.** Saves are read as bytes and parsed so that re-serialising reproduces the original file exactly: float literals like `1.0`, uppercase `\u` escapes, raw non-UTF-8 bytes, and key order (keys are translated at the text level, so JS never reorders integer-like keys). **Verify** on the home screen proves this for any save without writing anything.
2. **Every edit is checked as it is made.** Out-of-grid or locked cells, overlapping slots, and amounts above the stack limit are rejected. Technology can only be rearranged within its own grid.
3. **Stack limits are the game's, never ours.** A slot's stack limit (`MaxAmount`) is never edited. When an item moves to another inventory, it takes the limit the game uses there. That is either a limit the game already wrote for the same item in that kind of inventory, or the game's own rule from its data files: base limit for the inventory type and stack difficulty × the item's stack multiplier, capped at 9999. The rule is only used for inventory types where it reproduces every limit already in the save, or where every inventory type shares one base limit (substances on High stack limits are 9999 everywhere). If the limit can't be confirmed, the move is refused, and while dragging, inventories that would refuse the item are dimmed with the reason shown. If a stack is bigger than the target allows, one full stack moves and the rest stays behind.
4. **Review before writing.** A structural diff confirms that only the values your edits touched changed. The output is re-parsed, recompressed and decoded again, and the `mf_*.hg` manifest is updated and re-verified. The write is refused if the save changed on disk since you opened it, or if the game is running.
5. **Backup, atomic write, read-back.** Before every write and every restore, the save and its manifest are copied to `~/.nms-vault/backups` and the copies are verified. Files are written atomically and read back. On any mismatch the backup is restored automatically.

## Item names and icons

At startup the server finds the game install through your Steam libraries (or `NMS_GAME_DIR`, pointing at `GAMEDATA/PCBANKS` or `MACOSBANKS`). It reads the item tables and English text from the game's HGPAK archives, which takes under a second. Nothing is downloaded, and the game files are only read, never written.

- The item database is cached in `~/.nms-vault/cache/itemdb.json` and rebuilt automatically when the game updates.
- Icons are decoded from the game's BC7 textures on first view and cached as PNGs.
- Tables are read without a hard-coded schema: fields are picked by the shape of their values, so most game updates need no code change.
- Procedural items (`PROC_*`) get seed-generated names in game, so only their category is shown.
- Uninstalled upgrade modules and packaged technology take the name of the technology they become, for example `UP_FRHYP` → "Freighter Hyperdrive" and `UP_T_LAUNCHCHAR` → "Launch Auto-Charger".

## Caveats

- Steam Cloud: if Steam is running, it syncs edited saves and can replace them with a newer save from another device. The review screen warns when Steam is running.
- Without the game installed, item names fall back to tidied game IDs (`^LAND1` becomes "Land 1").
- The old separate Cargo inventories (exosuit, ships, freighter) are hidden. Current game versions keep cargo in the general inventory and leave these empty, so items moved there might not show in-game. If one does hold items, it appears as "Cargo (legacy)", and items can only be moved out of it.
- Products can't be moved into inventory types your save has no examples of, such as an empty exocraft, because their stack limit there can't be confirmed.
- Xbox Game Pass, PlayStation and Switch saves use different containers and are not supported.
- Key names come from `data/mapping.json` (MBINCompiler). Update it after major game updates.

## Layout

```
server.js            local HTTP server (127.0.0.1 only, per-launch API token)
src/codec.js         .hg chunk format + LZ4 block codec
src/losslessJson.js  byte-exact JSON parse/stringify
src/keys.js          reversible key (de)obfuscation
src/manifest.js      mf_*.hg XXTEA manifest cipher
src/inventory.js     inventory model and edit operations
src/validate.js      structural diff
src/saves.js         discovery, sessions, review/commit, backups
src/gamedata/        HGPAK archive reader, schema-free MBIN table reader,
                     item database builder, BC7/DDS decoder + PNG encoder
public/              UI (no build step)
```

## License and credits

NMS Vault's code is released under the [MIT License](LICENSE).

`data/mapping.json` comes from [MBINCompiler](https://github.com/monkeyman192/MBINCompiler) by monkeyman192 and contributors, and is used unmodified under the GNU LGPL v3. See [data/NOTICE.md](data/NOTICE.md) for its source, version and license texts.

NMS Vault is an unofficial fan tool and is not affiliated with or endorsed by Hello Games. No Man's Sky is a trademark of Hello Games. Item names, descriptions and icons are read from your own installed copy of the game at runtime and are not included in this repository.
