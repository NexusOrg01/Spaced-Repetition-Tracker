# F-Droid metadata handoff

The application repository is not the F-Droid metadata repository. The final app entry must be submitted separately to `fdroiddata/metadata/<FINAL_APPLICATION_ID>.yml`; source-library definitions belong in `fdroiddata/srclibs/`.

The permanent Android application ID, release version/code, signed Git tag and signing strategy have not yet been selected. Do not submit the template as-is and do not use the temporary `org.nexus.tracker.preview` identity for a public F-Droid listing.

## Source-library definitions

Copy the supplied files in `contrib/fdroiddata/srclibs/` into the fdroiddata repository's `srclibs/` directory:

- `contrib/fdroiddata/srclibs/esbuild.yml` → `fdroiddata/srclibs/esbuild.yml`
- `contrib/fdroiddata/srclibs/golang-sys.yml` → `fdroiddata/srclibs/golang-sys.yml`

Both definitions point to public Git repositories; the app metadata pins the exact source commit for each build. The build also uses a third source library, Node.js 22.23.4, pinned to `27f213124280b4db4cd1e3dd42f6f8afd01ceff7`; copy `contrib/fdroiddata/srclibs/nodejs.yml` to `fdroiddata/srclibs/nodejs.yml`.

The metadata template pins both revisions by full commit hash:

- Node.js 22.23.4: `nodejs/node` commit `27f213124280b4db4cd1e3dd42f6f8afd01ceff7` (signed upstream release tag `v22.23.4`; includes npm 10.9.9)
- esbuild 0.28.2: `609683d892977362a0f99026cb74b96263d728a9`
- golang.org/x/sys: `c0bba94af5f85fbad9f6dc2e04ed5b8fac9696cf`

## Metadata validation

Copy `metadata-template.yml` to `fdroiddata/metadata/<FINAL_APPLICATION_ID>.yml`, replace every placeholder, and run `fdroid rewritemeta` and `fdroid lint` in a current fdroidserver checkout. The likely `NonFreeNet` Anti-Feature question is intentionally left for review with F-Droid maintainers because cloud sync is optional but currently targets a fixed hosted Supabase endpoint.

The metadata template is a handoff aid, not a validated submission. It must be updated to the final tagged release commit and version before use.


## Buildserver toolchain blocker

Capacitor 8 requires Node.js 22+. Debian Trixie provides Node.js 20.19.2, so the metadata now compiles Node.js 22.23.4 from its pinned upstream source library and uses its bundled npm 10.9.9. The same source-build script is exercised on the GitHub Actions runner. An actual isolated F-Droid buildserver run is still required before this recipe can be called validated.
