# @markii/runtime

Host-side scripting glue for [Markii](https://github.com/sadigaxund/markii) documents: a null-prototype value store and `runDocumentScripts`, which executes a document's embedded scripts and gates execution by trigger tier (auto/scheduled triggers stay read-only). Framework-agnostic — the actual script executor (e.g. `@markii/lua`) is injected by the host.

See the [repository](https://github.com/sadigaxund/markii) for the format spec and the reference library as a whole.
