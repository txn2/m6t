# Vendored file-type icons

Source: [material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme)
version **5.37.0**, npm package `material-icon-theme`, files taken verbatim
from its `icons/` directory.

License: **MIT** — see [LICENSE](LICENSE), copied unmodified from the upstream
package. MIT is on the repository allowlist (`GO_LICENSE_ALLOWLIST` /
`npm run licenses`: MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD).

## Why vendored rather than an npm dependency

`material-icon-theme` is a VS Code extension. Depending on it pulls
`chroma-js` into the production npm graph, whose declared license is the
compound expression `(BSD-3-Clause AND Apache-2.0)` — both halves are on the
allowlist, but `license-checker-rseidelsohn --onlyAllow` matches declared
strings, so a compound expression is a gate failure waiting to happen for a
package none of our code ever imports. We use none of the extension's code,
only seventeen static SVG files, so the files are copied in with their
license and provenance and the dependency is not taken.

`vscode-icons` was rejected outright: CC BY-SA, not on the allowlist.

Kustomize has no icon in this set; `kustomization.yaml` uses lucide's
`Layers` instead (see `../../components/Icon.tsx`).

## Updating

Re-copy from a newer `material-icon-theme` tarball and bump the version
above:

```sh
npm pack material-icon-theme@<version>
tar xzf material-icon-theme-<version>.tgz
cp package/icons/{folder,folder-open,...}.svg frontend/src/icons/material/
cp package/LICENSE frontend/src/icons/material/LICENSE
```

The files are unmodified so the copies stay diffable against upstream.
