# Vendored assets — provenance

These files are **unmodified** upstream build artifacts. Do not edit them.

| file | sha256 | source |
| --- | --- | --- |
| `cimbar_js.js` | `c18d4c47ffd9ad4bf6c5e6c9fb1e8a8aabf52eadf5dfa70844b904b1c67d5418` | `cimbar.wasm.tar.gz` → `cimbar_js.2026-08-21T2336.js` |
| `cimbar_js.wasm` | `019a0d79419bdee0b918f409cdcfff919c172b75131dac5a36a44385151ca5af` | `cimbar.wasm.tar.gz` → `cimbar_js.2026-08-21T2336.wasm` |

* project: [sz3/libcimbar](https://github.com/sz3/libcimbar)
* release: **v0.6.8**
* license: [Mozilla Public License 2.0](https://github.com/sz3/libcimbar/blob/master/LICENSE) (same as upstream)

This single module contains **both** halves of the codec:

* encoder — `_cimbare_init_window`, `_cimbare_configure`, `_cimbare_init_encode`,
  `_cimbare_encode`, `_cimbare_render`, `_cimbare_next_frame`
* decoder — `_cimbard_configure_decode`, `_cimbard_scan_extract_decode`,
  `_cimbard_fountain_decode`, `_cimbard_get_filename`, `_cimbard_decompress_read`

Because this is the same build that powers <https://cimbar.org>, anything
AirCimbar produces can be read there and vice versa.

## Sourcing

The upstream encoder renders through WebGL (Emscripten GLFW), so it needs a
real browser — the artifacts are loaded at runtime, not compiled here.

The only adaptation is `Module.locateFile`, which maps the build-timestamped
wasm filename baked into the glue onto the stable `cimbar_js.wasm` name.

## Refreshing to a newer release

```sh
cd /tmp && rm -rf cimbar-vend && mkdir cimbar-vend && cd cimbar-vend
curl -L -o c.tar.gz https://github.com/sz3/libcimbar/releases/latest/download/cimbar.wasm.tar.gz
tar xzf c.tar.gz
cp cimbar_js.*.js   <repo>/app/vendor/cimbar_js.js
cp cimbar_js.*.wasm <repo>/app/vendor/cimbar_js.wasm
shasum -a 256 <repo>/app/vendor/cimbar_js.js <repo>/app/vendor/cimbar_js.wasm
```

Then update the hashes above, re-check the mode table in `app/js/cimbar.js`
(the numbers there were read out of the running module — see
`test/roundtrip.mjs`, which prints the per-mode fountain buffer sizes), and
re-run the full test suite.
