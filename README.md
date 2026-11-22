# site-generator-speed-20261122

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rapppae/site-generator-speed-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rapppae/site-generator-speed-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own static site generator, makefun-site 1.0.0 — an entry for the [make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly the output tree makefun-site 1.0.0 builds for one case's `{ site, templates, files }`, byte for byte — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file. `main.ts` is the harness driver: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

How it is faster than the reference: front matter is scanned without splitting the whole source into lines, Markdown is rendered in a single pass without building a token list, slugs are cached per case, templates are compiled once per case into plain JavaScript functions (with a small tree-walking interpreter as fallback), and output is gathered in arrays and joined once instead of concatenated string by string.

## Run

```sh
node main.ts
```

Node 22 or later, nothing to install.
