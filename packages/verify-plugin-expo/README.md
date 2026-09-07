# @validity.ai/verify-plugin-expo

Expo config plugin for the **user's** app: guarantees a deep-link scheme
(never a `validity-*` one — that namespace is the companion app), stamps
`expo.extra.validity` so readiness checks can prove it ran, and carries
native mock deps (`msw`, URL polyfill, text encoding).

```json
{ "expo": { "plugins": ["@validity.ai/verify-plugin-expo"] } }
```

This is not the companion. `validity init` wires the plugin; `validity browse --native` builds the companion once onto a **booted** simulator (first install takes a few minutes). Verify then deep-links into that companion. Do not switch to Expo Web to skip the device build.
