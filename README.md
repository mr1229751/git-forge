# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mr1229751/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mr1229751/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: git smart HTTP (protocol v2 and v0), the REST v3 surface, GraphQL v4 and an MCP endpoint, all over one in-memory store. Standard library only, no build step, deterministic by construction — no clocks or randomness in any served value.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry reads `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` from its environment, binds an ephemeral port, registers with the env, serves until the env says done, and exits.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xf80fxjd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
