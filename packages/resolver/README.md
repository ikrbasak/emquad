# @emquad/resolver

`@preview` package resolution for [`@emquad/core`](https://www.npmjs.com/package/@emquad/core).

```sh
npm install @emquad/resolver
```

```ts
import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";
import { Resolver } from "@emquad/resolver";

const source = '#import "@preview/cetz:0.4.2": canvas\n#canvas({})';

const resolver = new Resolver({ lockfile: "typst.lock.json" });
const packages = await resolver.resolve(source);   // follows transitive imports

const compiler = new Compiler({ fonts: defaultFonts, packages });
```

**Resolve once, at startup.** The network is contacted once per package version and never per
compile — `resolver.networkFetches` is exposed so you can assert that rather than trust it.

Zero runtime dependencies. Requires **Node ≥ 22**, ESM only.

## Why resolution happens before compiling

Typst's file loader is synchronous, so a package cannot be downloaded during a compile. This
resolver scans your source for import specs, fetches those, then scans *their* sources for
transitive imports until nothing new appears.

Pass every source that might import a package — the document and any templates in your base
layer.

## Caching

Memory → disk → network. The disk cache defaults to the same directory `typst-cli` uses, so a
machine that has compiled with the CLI starts warm and neither tool keeps a second copy.

```ts
new Resolver({ mode: "auto" });      // memory → disk → network (default)
new Resolver({ mode: "offline" });   // memory → disk; a miss is a clean error
new Resolver({ mode: "vendor", vendorDir: "./vendor" });   // a checked-in directory only
```

## Lockfile

```ts
const resolver = new Resolver({ lockfile: "typst.lock.json", updateLockfile: true });
await resolver.resolve(source);
await resolver.save();
```

Integrity is verified on **every disk-cache read**, not only on download — the disk cache is
shared with `typst-cli` and outlives upgrades, so it is the path most likely to have drifted. A
package that fails verification is never written to disk, so a bad download cannot become
tomorrow's cache hit.

`updateLockfile` is off by default. A resolver that silently rewrote the lockfile would turn
every integrity mismatch into a lockfile update, which defeats the point.

## Proxies

Node's global `fetch` ignores `HTTPS_PROXY` before Node 24. On Node 24+, set
`NODE_USE_ENV_PROXY=1`. On Node 22, inject one:

```ts
new Resolver({ fetch: myProxyAwareFetch });
```

## License

MIT.
