# Translation packs

Drop exported packs here (`node tools/tm_export.js` produces them, or someone
else's). `node tools/build_tm.js` merges every `*.json` in this directory into the
shipped memory, so contributions do not need to be re-translated.

Only public build text belongs here: translations produced from deadlock-api
builds or from what the game displayed. Never put anything private in a pack.

- English -> Chinese only (the shipped memory is `zh-Hans`). Other languages need
  their own pak, since the in-game memory is a single language file.
- Duplicate texts are ignored: the pipeline's own cache wins over a pack.
