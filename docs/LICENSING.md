# Nexus licensing and release policy

**Status:** proposed for review in this pull request. This document is not legal advice and does not replace a review of copyright ownership, third-party licences, or applicable local law.

## Selected project licence

The proposed licence for original Nexus application source code is **Apache License 2.0** (`Apache-2.0`). The full licence text is in the repository-root `LICENSE` file.

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
- F-Droid inclusion policy: https://f-droid.org/docs/Inclusion_Policy/
- F-Droid licence metadata: https://f-droid.org/docs/Build_Metadata_Reference/
- F-Droid reproducible builds: https://f-droid.org/docs/Reproducible_Builds/
