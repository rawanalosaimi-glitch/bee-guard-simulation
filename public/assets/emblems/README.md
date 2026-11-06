# Bee drone emblem artwork

- `saudi_emblem.svg`: the authentic emblem, an unmodified copy of Wikimedia Commons "Emblem of Saudi Arabia.svg". Its source and checksum are in `SOURCE.txt`.
- `src/viz/models/BeeEmblem.tsx` loads it locally, with no internet access, and applies it to both flanks of BEE-01, BEE-02 and BEE-03: on the middle yellow panel, between the two dark bands.
- Nothing is drawn in code. If the file is removed, the bees show no emblem.
