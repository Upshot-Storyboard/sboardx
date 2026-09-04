# Contributing

## Bugs and questions

Open a GitHub issue. For reader bugs, attach the `.sboardx` that misbehaves
if you can share it.

## Proposing a format change

One pull request that touches everything the change affects:

1. `SPEC.md` — the new key or attribute, its type, default, and who reads it.
2. `CHANGELOG.md` — one entry under the version it lands in.
3. `reader/index.html` — if the change renders.
4. `samples/` — a sample that uses it, or an update to an existing one.
5. `examples/python/validate.py` — if the change adds a required entry or
   reference.

Rules of the road (also in SPEC.md, "Extending the format"):

- Readers ignore unknown keys and attributes, so an **additive optional key
  keeps the version**. Give it a default that means "as before".
- Anything app-specific goes under a vendor key: `x-<vendor>` in JSON,
  `<vendor>:` attributes in SVG. Don't put private state in public keys.
- A change that alters the meaning of existing data bumps the minor version.
  Try hard not to need one.

## Code

The reader is one HTML file with no build step; keep it that way. Toon Boom
scripts run on Qt Script (ES5): no `let`/`const`, arrows, template literals
or `Array.prototype.map`. Python examples are stdlib only.

## License

Contributions are accepted under the Apache-2.0 license (section 5 of the
license: inbound = outbound). No CLA.
