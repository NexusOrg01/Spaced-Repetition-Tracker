# F-Droid metadata handoff

The application repository is not the F-Droid metadata repository. The final app entry must be submitted separately to `fdroiddata/metadata/<FINAL_APPLICATION_ID>.yml`; source-library definitions belong in `fdroiddata/srclibs/`.

The permanent Android application ID, release version/code, signed Git tag and signing strategy have not yet been selected. Do not submit the template as-is and do not use the temporary `org.nexus.tracker.preview` identity for a public F-Droid listing.

## Source-library definitions

Copy the supplied files in `contrib/fdroiddata/srclibs/` into the fdroiddata repository's `srclibs/` directory:

- `contrib/fdroiddata/srclibs/esbuild.yml` → `fdroiddata/srclibs/esbuild.yml`
- `contrib/fdroiddata/srclibs/golang-sys.yml` → `fdroiddata/srclibs/golang-sys.yml`

Both definitions point to public Git repositories; the app metadata pins the exact source commit for each build.

The metadata template pins both revisions by full commit hash:

- esbuild 0.28.2: `609683d892977362a0f99026cb74b96263d728a9`
- golang.org/x/sys: `c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf`

## Metadata validation

Copy `metadata-template.yml` to `fdroiddata/metadata/<FINAL_APPLICATION_ID>.yml`, replace every placeholder, and run `fdroid rewritemeta` and `fdroid lint` in a current fdroidserver checkout. The likely `NonFreeNet` Anti-Feature question is intentionally left for review with F-Droid maintainers because cloud sync is optional but currently targets a fixed hosted Supabase endpoint.

The metadata template is a handoff aid, not a validated submission. It must be updated to the final tagged release commit and version before use.


## Buildserver toolchain blocker

Capacitor 8 requires Node.js 22+. F-Droid's documented minimum buildserver base is Debian Trixie, currently shipping Node.js 20.19.2. Do not submit this template until the build recipe provisions and validates a compliant Node 22+ toolchain using an approach acceptable to F-Droid maintainers. This repository does not currently claim that an F-Droid buildserver run has passed.
