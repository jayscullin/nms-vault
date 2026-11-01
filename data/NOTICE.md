# Third-party data

## mapping.json — MBINCompiler

`mapping.json` translates the obfuscated keys in No Man's Sky save files into
readable names. It is part of **MBINCompiler** by monkeyman192 and contributors,
and is licensed under the **GNU Lesser General Public License v3.0**:

- Project: https://github.com/monkeyman192/MBINCompiler
- File: `mapping.json` from release
  [v7.10.0-pre1](https://github.com/monkeyman192/MBINCompiler/releases/tag/v7.10.0-pre1)
  (libMBIN 7.10.0.1), included **unmodified**
- License: [LICENSE-LGPL-3.0.txt](LICENSE-LGPL-3.0.txt), which supplements
  [LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)

NMS Vault reads this file at startup and does not link to or modify it. You may
replace it with any other MBINCompiler release's `mapping.json` (for example
after a game update) by overwriting `data/mapping.json`.

The rest of NMS Vault is MIT-licensed; see [../LICENSE](../LICENSE).
