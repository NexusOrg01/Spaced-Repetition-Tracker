# Android dependency inventory (initial)

Direct versions are pinned exactly in `package.json`. This is an initial inventory, not a completed F-Droid software bill of materials.

| Dependency | Purpose | Version | Upstream licence to verify at release |
|---|---|---:|---|
| `@capacitor/core` | Native/web bridge | 8.6.0 | MIT |
| `@capacitor/android` | Android platform runtime | 8.6.0 | MIT |
| `@capacitor/cli` | Android project sync tooling | 8.6.0 | MIT |
| `@capacitor/app` | Lifecycle, app links and Back navigation | 8.1.2 | MIT |
| `@capacitor/browser` | In-app browser for OAuth | 8.0.5 | MIT |
| `@capacitor/filesystem` | Cache-backed export staging | 8.1.5 | MIT |
| `@capacitor/share` | Android share sheet | 8.0.1 | MIT |
| `@capawesome/capacitor-file-picker` | System document picker | 8.1.1 | MIT |
| `@supabase/supabase-js` | Optional cloud auth/sync client | 2.117.3 | MIT |
| `esbuild` | Build-time Android bridge bundling | 0.28.2 | MIT |

AndroidX, Gradle, Android Gradle Plugin, JDK and all transitive npm/Maven dependencies require a generated software bill of materials and licence notice review before F-Droid submission. This list alone does not prove that the complete app is FOSS-compatible.
