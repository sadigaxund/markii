# @markii/bundle

Bundle (`.mkz`) storage and policy handling for [Markii](https://github.com/sadigaxund/markii): manifest parsing/validation, a bundle-relative path-jail, the zip storage form (via `fflate`), a Node-only directory storage form (`./fs` subpath), and a capability-restricted script view. No React, no markdown parsing.

The legacy `.mkbundle` extension is still recognized for one more release; new bundles are always written as `.mkz`.

See the [repository](https://github.com/sadigaxund/markii) for the format spec and the reference library as a whole.
