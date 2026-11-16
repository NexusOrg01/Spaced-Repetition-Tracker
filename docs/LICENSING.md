# Nexus licensing and release policy

This document defines the project's licensing and release policy. It is not legal advice and does not replace a review of copyright ownership, third-party licences, or applicable local law.

## Selected project licence

The licence for original Nexus application source code is **Apache License 2.0** (`Apache-2.0`), limited to material that the project is authorised to license under the scope described in this policy. The full licence text is in the repository-root `LICENSE` file.

The licence choice is intended to support public source availability, redistribution, modification, commercial distribution, and future optional paid services. It does not require downstream distributors to publish their modifications under Apache-2.0. A downstream party may sell a compliant fork or offer a modified fork under different terms, subject to the licence and other applicable rights.

The official Nexus project may continue to provide its own core features free of charge as a project policy. That policy is not a restriction imposed on independent forks by Apache-2.0.

## Scope and third-party materials

Do not assume that the root licence automatically relicenses every file or asset in this repository. Before describing a release as wholly Apache-2.0 or submitting an Android build to F-Droid, maintain an inventory of:

- Original application code and documentation, including the identity and authority of every copyright holder and contributor.
- JavaScript libraries and other bundled or remotely loaded dependencies.
- Fonts, icons, illustrations, screenshots, sounds, and other media.
- Curriculum packs, syllabus text, question content, and other educational materials.
- Generated files and copied snippets whose origin may differ from the surrounding code.

Third-party materials retain their own licence terms unless their rights holder has separately granted compatible permission. Keep required notices and attribution. Do not add an Apache header to third-party files merely because they are stored in this repository.

## Ownership and contribution checks before the licence is treated as final

1. Review repository history and identify material contributions made by anyone other than the person or entity authorised to license the project.
2. Confirm that the project has permission to distribute each such contribution under Apache-2.0, or preserve its existing licence and document the resulting multi-licence scope.
3. Review copied, generated, and vendor code separately.
4. Decide how future contributions will be handled. Apache-2.0 section 5 provides a default for intentionally submitted contributions, but it does not retroactively establish ownership of earlier work. If future dual licensing is a goal, obtain an appropriate contributor agreement or other explicit rights grant before accepting contributions on that basis.
5. Add source-file SPDX identifiers or short notices only after the applicable file's copyright holder and licence have been confirmed. Do not invent a copyright owner or year.

## Brand and trademarks

Apache-2.0 does not grant a general right to use the Nexus name, logo, or other project marks. The project should publish a separate, clear name-and-brand use policy before third parties distribute forks under confusingly similar branding. This document does not claim that any Nexus trademark is registered or that registration has been obtained.

## F-Droid and Android distribution

Apache-2.0 is an OSI-approved free-software licence, but that alone does not make an Android release eligible for F-Droid. F-Droid reviews the complete app, including dependencies, assets, build tools, build process, runtime downloads, and privacy-related SDKs. A website wrapper must also provide meaningful native functionality or enhancements under the current inclusion policy.

Before submission, complete a separate F-Droid compliance review and a reproducible-build check. In particular, ensure that the F-Droid build does not depend on proprietary analytics or tracking SDKs, Google Play Services, or unreviewed executable code downloaded at runtime. Optional cloud services and network-loaded JavaScript must be assessed as part of the full app experience, not ignored because the core tracker works offline.

## Commercial features

The project may offer optional paid services or features in official distribution channels, subject to the applicable store rules and consumer law. Keep the open-source core clearly defined and available under the published licence. Do not describe paid features as making the entire project proprietary if the same covered source remains available under Apache-2.0. Any separate proprietary component must be genuinely separable and independently licensed; it must not be bundled into an F-Droid build unless it meets F-Droid's requirements.

## References

- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
- Apache guidance on applying the licence: https://apache.org/legal/apply-license.html
- Vercel AI Product Terms (including v0 output and intellectual-property provisions): https://vercel.com/legal/ai-product-terms
- OpenAI Terms of Use (individual ChatGPT use; content ownership): https://openai.com/policies/terms-of-use/
- GitHub Copilot ownership and code-reference guidance: https://github.com/features/copilot/
- GitHub Copilot personal-account model-training controls: https://docs.github.com/en/copilot/how-tos/manage-your-account/manage-policies
- Google Terms of Service (generated content): https://policies.google.com/terms
- Meta AI consumer-specific terms: https://www.facebook.com/legal/ai-terms
- F-Droid inclusion policy: https://f-droid.org/docs/Inclusion_Policy/
- F-Droid licence metadata: https://f-droid.org/docs/Build_Metadata_Reference/
- F-Droid reproducible builds: https://f-droid.org/docs/Reproducible_Builds/

## Initial repository audit findings (2026-11-03)

The following items were visible in the current `main` source during preparation. They are review findings, not proof that the materials are non-free or infringing.

| Area | Observed in the repository | Required action before F-Droid release |
|---|---|---|
| Supabase JavaScript client | `cloud-sync.js` injects `@supabase/supabase-js@2.117.3` from jsDelivr at runtime. The package is not declared in `package.json`. | Pin and bundle the exact reviewed client in the Android/F-Droid build, preserve its upstream licence and notices, and avoid runtime CDN code loading. Verify the version and package provenance. |
| Analytics | `index.html` loads Vercel Web Analytics from `/_vercel/insights/script.js`. | Exclude analytics from the F-Droid flavour unless its implementation and collection practices are independently shown to meet F-Droid's free-software and privacy requirements. Do not remove or change production analytics as part of this preparation. |
| App icon | The project owner confirms the app icons/artwork were generated using Google Gemini. | Google states it does not claim ownership of generated content, but similar outputs may be generated for others and the user remains responsible for legal compliance. Record the Gemini product and account/service terms applicable when generated; retain prompts/source files if available; check for recognisable third-party logos, characters, or copied artwork. Do not imply the icons are exclusively owned or guaranteed copyrightable. |
| Store screenshots | `manifest.webmanifest` points to two screenshots hosted on a PWAStore CloudFront domain. | Confirm who created the screenshots and that Nexus may redistribute them. Prefer repository-hosted copies for reproducible Android metadata after rights are confirmed. |
| Sinhala Commerce curriculum | The project owner confirms the 46-topic Sinhala Commerce starter pack is based on official Sri Lankan government curriculum material from e-Thaksalawa and considers it freely reusable. | Retain an acknowledgement to e-Thaksalawa in the curriculum catalogue/pack or its accompanying documentation. The project owner has confirmed that the source material is free to reuse; no separate curriculum-rights blocker was raised for this licence-preparation PR. Reassess only if future packs incorporate separately copyrighted third-party material. |
| AI-generated application code | The project owner confirms that AI-assisted development used Vercel v0, ChatGPT, GitHub Copilot, Gemini, and the Meta AI mobile app. Repository history contains three commits authored by the Vercel `v0` account (`5a7bc45`, `e6a0df5`, and `a250806`) that modify app files. | The reviewed provider terms generally do not claim ownership of generated output or assign the provider's own rights to the user (subject to applicable law), but none guarantees copyrightability, exclusivity, or absence of third-party material. OpenAI's individual Terms of Use state that the user owns Output and OpenAI assigns its rights, if any. GitHub says it does not claim ownership of Copilot suggestions and notes that ownership depends on applicable law and the nature of the suggestion. Google's general Terms state it will not claim ownership of generated content; similar outputs may be generated for others. Vercel's AI Product Terms assign the customer's rights, if any, in Output. The consumer Meta AI app is governed by Meta's AI-specific consumer terms, not the Meta Model API terms. Meta's consumer AI Terms page could not be fully retrieved during this review, so no output-ownership conclusion is recorded for Meta AI output pending direct review of the terms applicable to the account and date of use. The project owner states that, to the best of their knowledge, no third-party code, artwork, or other material was knowingly incorporated without permission. This is an owner confirmation, not an independent provenance or legal audit. Retain available prompts/provenance and reassess if any copied or recognisable third-party material is later identified. |
| Android packaging | The current repository is a static PWA project; no Android Gradle project or Capacitor configuration was found in the earlier root-level inspection. | A dedicated Android project and a reproducible, FLOSS-compatible build recipe are still required. A thin website wrapper alone is unlikely to satisfy F-Droid's quality policy; implement meaningful native integration. |

### Release separation

These findings do not require changing the hosted PWA. Keep the existing Vercel production configuration and live Supabase project unchanged. Any F-Droid-specific work should use a separate Android build flavour and staging/test services, with no production credentials or production deployment changes.

### Ownership evidence still needed

A review of all 281 commits returned across the repository history pages available during this audit shows one human GitHub author account (`NexusOrg01`), plus automation accounts (`github-actions` and `vercel[bot]`) and the AI coding account `v0`. Three historical commits are authored by `v0`, as listed in the AI-generated application code row. The project owner has stated that, to the best of their knowledge, no third-party code, artwork, or other material was knowingly used without permission. This confirmation is useful but does not prove the provenance of every imported code fragment, copied snippet, or non-code asset, nor does it replace a legal review. Preserve available provenance and licence records for dependencies and vendor material, and investigate any material later identified as third-party.

## Android/F-Droid technical baseline

This is a proposed implementation baseline, not an Android project already present in the repository.

- **Container:** use an embedded Capacitor Android project with local web assets. Do not configure the F-Droid build to load the hosted production website through a remote `server.url`.
- **Capacitor candidate:** The Android implementation branch pins Capacitor 8.6.0. Recheck the official release notes and compatibility before each release update.
- **Toolchain:** the current repository pins Node 22.x, which meets the official Capacitor 8 Node 22+ requirement. Capacitor 8's current setup guide specifies Android Studio 2025.2.1 or later and Android SDK API 24 or later; Android API 36 is the latest stable SDK level listed in that guide at the time of review. The Android CI build uses JDK 21 because Capacitor 8.6.0's Android module requests Java source release 21.
- **Native value:** add native functionality that improves the existing offline-first tracker, such as Android document-picker/file import-export integration and the system share sheet. Use reviewed FLOSS plugins and avoid Google Play Services-dependent integrations. The exact native feature set must be tested and documented; a thin WebView wrapper is not enough for F-Droid's stated website-wrapper quality requirement.
- **F-Droid flavour:** ship web assets locally; omit Vercel Web Analytics from this flavour unless a later review establishes a clear compliance basis; bundle the pinned Supabase JavaScript client locally with its upstream licence notice; avoid downloading executable code at runtime.
- **Cloud sync:** keep cloud sync optional and offline use fully functional. Review whether the hosted Supabase service requires an F-Droid Anti-Feature declaration or additional user-facing disclosure; do not assume that an open-source client makes every hosted service free software.
- **Application ID:** select a stable, unique ID derived from a domain the project actually controls. The current TWA package identifier is based on a Vercel domain, so do not reuse it automatically as the long-term F-Droid identity. Confirm the ownership and availability of any proposed domain before choosing the reverse-DNS package ID. A different ID will install as a separate Android app; matching IDs across stores also require careful signing-key and migration planning.
- **Reproducibility:** pin Capacitor, plugins, Gradle wrapper, Android Gradle Plugin, and SDK/build-tools versions; commit the Gradle wrapper; build release APKs from the command line with the wrapper; remove build timestamps and network-fetched build inputs; and verify repeated builds with F-Droid's reproducibility workflow.
- **Metadata:** prepare an F-Droid YAML metadata file using SPDX `Apache-2.0`, a public HTTPS Git repository, a fixed full commit hash for each build, version name/code, and verified app description, icon, screenshots, and donation link.

### Official technical references

- Capacitor 8 environment setup: https://capacitorjs.com/docs/getting-started/environment-setup
- Capacitor Android changelog: https://github.com/ionic-team/capacitor/blob/main/android/CHANGELOG.md
- F-Droid inclusion policy: https://f-droid.org/docs/Inclusion_Policy/
- F-Droid build metadata: https://f-droid.org/docs/Build_Metadata_Reference/
- F-Droid reproducible builds: https://f-droid.org/docs/Reproducible_Builds/

